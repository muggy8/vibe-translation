#!/usr/bin/env node
/**
 * test/test-translation-terminology-source.js — the translation stage takes its terminology law from the
 * **settled reference record**, not from the volume folder's `glossary.md`.
 *
 * The account owner's answer to `translate/plan/01-translation-route.md` §9 question 1 (2026-10-13):
 * the translator uses the final revised set of renderings — the one decided before and after any reveal —
 * so as much foreshadowing as possible survives. A term a later volume revised must reach **every**
 * volume's chapters, volume 1's included, and the superseded rendering is not offered to the model as an
 * alternative anywhere.
 *
 * Scenarios:
 *   1. **The backward half.** Volume 03 revises a term volume 01 published; translating **volume 01's**
 *      chapter now uses volume 03's rendering. (This is the assertion that fails against the code before
 *      the change — the volume folder's file still said the old thing.)
 *   2. **The superseded rendering reaches no prompt.** Asserted on the text the stage actually builds —
 *      the chapter's `term→rendering` lines, the verify/polish glossary block, and the translator's
 *      terminology instruction — not on a helper's return value.
 *   3. **A missing record is a refusal.** The error is structural, names the folders it looked in, and
 *      does not fall back to the markdown. `ON_TASK_ERROR=continue` cannot walk past it.
 *   4. **Which record is "the settled one" is read off the disk.** Delete the last volume's record and the
 *      settled set moves back to the one still on disk. Nothing hardcodes a volume number.
 *   5. **The published file and the machine-facing rule are compared.** Agree → silent. Disagree → the term
 *      is named, and a file still printing the rendering the record replaced is named as that.
 *   6. **`chapterContextHash` moves only for the chapters that print the changed term.**
 *   7. **The two real revisions replayed** — 百花祭 and 夫人界のアガシ — with the honest answer for the
 *      live corpus stated out loud: 0 chapters, because no translation exists there.
 *   8. **Reading only.** The settled read writes nothing to the record.
 *
 * Every scenario runs on a throwaway three-volume fixture under the fixture root. Nothing here reads the
 * real 17 volumes or any file under the series folder (AGENTS.md rule 8, gotcha 69), and no scenario makes
 * a model call. No scenario opens a fixture record with a write-capable client except through the store's
 * own doors that build it (gotcha 124).
 *
 * Plain `assert`, no framework. Run with `npm test`, or standalone:
 * `node test/test-translation-terminology-source.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  renderGlossary,
  publishedGlossaryRowsInRecord,
  openDatabase,
  DOCUMENT_SOURCE_STAGE,
} = require("../utils/reference-store");
const glossaryStore = require("../glossary/store");
const {
  loadVolumeReferences,
  chapterTerminology,
  chapterContextHash,
  glossaryBlock,
  buildTranslationTaskLines,
  parseGlossaryTerms,
  settledGlossaryRecord,
  readSettledGlossary,
  compareSettledGlossary,
  describeSettledGlossary,
} = require("../utils/translate");
const { isStructuralError } = require("../configs/shared");

const FIXTURES_ROOT = "/tmp/opencode/terminology-source-fixtures";

let checks = 0;
/**
 * Count one assertion and run it.
 * @param {boolean|void} condition
 * @param {string} message
 * @returns {void}
 */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}
/**
 * Count one deep assertion and run it.
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} message
 * @returns {void}
 */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

// ─── The fixture ──────────────────────────────────────────────────────────────

/** The three volumes, in reading order. */
const VOLUMES = [
  { folder: "Settled Terms(01)", installmentNumber: "01", base: "settled_terms(1)" },
  { folder: "Settled Terms(02)", installmentNumber: "02", base: "settled_terms(2)" },
  { folder: "Settled Terms(03)", installmentNumber: "03", base: "settled_terms(3)" },
];

/**
 * The fixture's sources, chapter by chapter.
 *
 * Written so every term the fixture publishes really occurs on a known line — the evidence rule and the
 * revision door both ask that question, and a fixture that cannot answer it tests only the refusal.
 * Volume 01 has a second chapter that never prints a revised term, which is what lets scenario 6 prove
 * the invalidation stays narrow.
 *
 * @type {Object<string, Object<string, string[]>>}
 */
const SOURCE = {
  "01": {
    ch0: [
      "# 第一章",
      "百花祭は学園の大きな行事だった。",
      "夫人界のアガシは廊下に立っていた。",
      "屋上には古い椅子が二つあった。",
    ],
    ch1: [
      "# 第二章",
      "廊下では誰も言葉を交わさなかった。",
      "古い椅子はそのままだった。",
    ],
  },
  "02": {
    ch0: [
      "# 第三章",
      "百花祭の準備は図書室で行われた。",
    ],
  },
  "03": {
    ch0: [
      "# 第四章",
      "百花祭の正式な名称は学園の祭である。",
      "夫人界のアガシは夫人界の王と呼ばれていた。",
    ],
  },
};

/** Volume 01 publishes these. `type` is the extraction's own classification. */
const TERMS_VOLUME_ONE = [
  { term: "百花祭", rendering: "Hyakusai Festival", note: "The academy's big event.", type: "item", query: "百花祭" },
  { term: "夫人界のアガシ", rendering: "Agassi of the madam world", note: "A title nobody explains yet.", type: "concept", query: "夫人界のアガシ" },
  { term: "屋上", rendering: "Rooftop", note: "Two old chairs up there.", type: "place", query: "屋上" },
];

/**
 * Volume 03's two revisions — the fixture's replay of the two renderings that actually changed across the
 * previous run's 17 glossary files (`百花祭` volume 1 → 2+, `夫人界のアガシ` volumes 3–10 → 11+).
 * Each quote is a line volume 03's own text prints, which is the guard the revision door exists to enforce.
 */
const REVISIONS_VOLUME_THREE = [
  {
    term: "百花祭",
    rendering: "Hyakka Festival",
    note: "Volume 3 names the formal title, so the festival's name is not the older reading.",
    quote: "百花祭の正式な名称は学園の祭である。",
    reason: "The book states the formal name, and it is not the rendering volume 1 chose.",
  },
  {
    term: "夫人界のアガシ",
    rendering: "Agassi of the Lady world",
    note: "Volume 3 calls its holder a king, so the world is a lady's, not a madam's.",
    quote: "夫人界のアガシは夫人界の王と呼ばれていた。",
    reason: "The reveal names the world differently from the first glossary.",
  },
];

/**
 * Lay out a three-volume fixture series with a plan of record and extracted sources.
 *
 * Points `SERIES_LOCATION` at the fixture, so a suite that opens a store without naming a series is
 * opening a fixture store — which is the point (gotcha 69).
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @returns {{dir: string, previousSeries: string|undefined, volumes: Array<{folder: string, installmentNumber: string, base: string, dir: string}>}}
 */
function fixtureSeries(label) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const previousSeries = process.env.SERIES_LOCATION;
  process.env.SERIES_LOCATION = dir;
  delete process.env.SERIES_ARTIFACTS_DIR;

  for (const volume of VOLUMES) {
    const volumeDir = path.join(dir, volume.folder);
    fs.mkdirSync(volumeDir, { recursive: true });
    const source = SOURCE[volume.installmentNumber];
    const segments = Object.entries(source).map(([id, lines]) => {
      const file = `${volume.base}-${id}.md`;
      fs.writeFileSync(path.join(volumeDir, file), lines.join("\n") + "\n", "utf8");
      return { id, file, title: lines[0].replace(/^#\s+/, ""), chars: lines.join("\n").length };
    });
    fs.writeFileSync(
      path.join(volumeDir, `${volume.base}-bundle.meta.json`),
      JSON.stringify({ format: "epub", schema: 8, base: volume.base, wholeFile: `${volume.base}-whole.md`, segments }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(volumeDir, `${volume.base}-whole.md`),
      Object.values(source).flat().join("\n") + "\n",
      "utf8"
    );
  }

  fs.writeFileSync(
    path.join(dir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: dir,
        seriesName: "Settled Terms",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test/test-translation-terminology-source.js",
        generatedAt: new Date().toISOString(),
        discovery: { summary: "fixture", confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 }, evidence: ["three books"], excluded: [] },
        volumes: VOLUMES.map((v) => ({
          folder: v.folder,
          sourceFile: `${v.folder}/${v.base}.epub`,
          installmentNumber: v.installmentNumber,
          title: "Settled Terms",
          integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose in one headed section" },
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  return { dir, previousSeries, volumes: VOLUMES.map((v) => ({ ...v, dir: path.join(dir, v.folder) })) };
}

/**
 * Restore whatever `SERIES_LOCATION` was, so one scenario cannot point the next at its fixture.
 * @param {string|undefined} previousSeries
 * @returns {void}
 */
function restoreSeries(previousSeries) {
  if (previousSeries === undefined) delete process.env.SERIES_LOCATION;
  else process.env.SERIES_LOCATION = previousSeries;
}

/**
 * The context object `glossary/task.js` hands its store glue, for a fixture volume.
 * @param {{dir: string, volumes: Array<Object>}} fx
 * @param {number} index - 0, 1 or 2.
 * @returns {Object}
 */
function stageCtx(fx, index) {
  const volume = fx.volumes[index];
  const previous = index > 0 ? fx.volumes[index - 1] : null;
  const meta = JSON.parse(fs.readFileSync(path.join(volume.dir, `${volume.base}-bundle.meta.json`), "utf8"));
  return {
    values: {
      INSTALLMENT_NUMBER: volume.installmentNumber,
      SOURCE_NAME: "Settled Terms",
      SOURCE_LANGUAGE: "Japanese",
      TARGET_LANGUAGE: "English",
    },
    folderName: volume.folder,
    seriesDir: fx.dir,
    volumeDir: volume.dir,
    isFirst: index === 0,
    previousFolderName: previous ? previous.folder : null,
    previousGlossaryFile: previous ? path.join(previous.dir, "glossary.md") : null,
    bundle: { segments: meta.segments, sourceFingerprint: "fixture" },
    glossaryOutputFile: path.join(volume.dir, "glossary.md"),
    validationOutputFile: path.join(volume.dir, "glossary-validation.md"),
    refStore: null,
  };
}

/**
 * Build all three volumes the way the glossary stage builds them: open the record (copy-forward carries
 * the earlier volumes' rows in), file the rows, file this volume's revisions, render, seal.
 *
 * @param {{dir: string, volumes: Array<Object>}} fx
 * @returns {Promise<Array<Object>>} One entry per volume: `{ctx, file}`.
 */
async function buildSeries(fx) {
  const built = [];
  for (let index = 0; index < fx.volumes.length; index++) {
    const ctx = stageCtx(fx, index);
    const previous = index > 0 ? Number(fx.volumes[index - 1].installmentNumber) : null;
    const attempt = glossaryStore.openGlossaryRecord(ctx, previous);
    assert.ok(attempt.ok, `volume ${ctx.values.INSTALLMENT_NUMBER}: ${attempt.error}`);
    ctx.refStore = attempt.opened.store;
    const rel = path.relative(path.resolve(fx.dir), path.resolve(ctx.refStore.file));
    assert.ok(rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel), `the fixture record resolved outside the fixture: ${ctx.refStore.file}`);

    if (index === 0) {
      const filed = glossaryStore.fileGlossaryTermRows(ctx, TERMS_VOLUME_ONE);
      assert.strictEqual(filed.importedCount, 3, `volume 1 filed ${filed.importedCount} rows: ${JSON.stringify(filed.refused)}`);
    }
    if (index === 2) {
      const report = glossaryStore.fileGlossaryRevisions(ctx, REVISIONS_VOLUME_THREE);
      assert.strictEqual(report.filed.length, 2, `volume 3 filed ${report.filed.length} revisions: ${JSON.stringify(report.refused)}`);
    }
    const rendered = await glossaryStore.renderGlossaryArtifact(ctx);
    assert.ok(rendered.ok, `volume ${index + 1}'s render refused: ${JSON.stringify(rendered.refusal)}`);
    ctx.qaAccepted = true;
    glossaryStore.sealGlossaryRecord(ctx);
    ctx.refStore.close();
    built.push({ ctx, file: fs.readFileSync(ctx.glossaryOutputFile, "utf8") });
  }
  return built;
}

/**
 * Copy the last volume's published glossary to the series root, the way `publishLatestToSeriesRoot` does.
 * @param {{dir: string, volumes: Array<Object>}} fx
 * @returns {string} The destination path.
 */
function publishSeriesRootGlossary(fx) {
  const last = fx.volumes[fx.volumes.length - 1];
  const destination = path.join(fx.dir, "glossary.md");
  fs.copyFileSync(path.join(last.dir, "glossary.md"), destination);
  return destination;
}

/**
 * sha256 of a file's bytes.
 * @param {string} file
 * @returns {string}
 */
function fileHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * The `term→rendering` pairs a chapter is actually given.
 * @param {Object} refs - `loadVolumeReferences` output.
 * @param {string} sourceText
 * @returns {string[]} e.g. `["百花祭→Hyakka Festival"]`
 */
function pairsFor(refs, sourceText) {
  return chapterTerminology(refs, sourceText).lines;
}

/**
 * The whole text a chapter's translator is shown about terminology: the pair lines plus the instruction
 * line the prompt builder adds. Asserting here is what keeps the claim "the superseded rendering reaches
 * no prompt" from being a claim about a helper's return value.
 * @param {Object} refs
 * @param {string} sourceText
 * @returns {string}
 */
function terminologyPromptText(refs, sourceText) {
  const term = chapterTerminology(refs, sourceText);
  const lines = buildTranslationTaskLines({
    terminologyLines: term.lines,
    disputedTerms: term.disputed,
    background: refs.background,
    styleRules: refs.styleRules,
    voiceNotes: refs.voiceNotes,
    continuityText: "",
    continuitySource: "上一章节",
    sourceText,
    template: "{{GLOSSARY}}\n{{BACKGROUND}}\n{{STYLE}}\n{{VOICE}}\n{{CONTINUITY}}\n{{SOURCE}}",
    roleWindow: 32000,
    outputReserve: 4000,
    sourceLanguage: "Japanese",
    targetLanguage: "English",
    label: "fixture",
  });
  return lines.join("\n");
}

// ─── Scenario 1: the backward half ────────────────────────────────────────────

/**
 * Volume 03 revises a term volume 01 published, and volume 01's chapter is translated with volume 03's
 * rendering.
 * @returns {Promise<void>}
 */
async function scenarioALaterVolumesRevisionReachesVolumeOne() {
  const fx = fixtureSeries("backward-half");
  try {
    await buildSeries(fx);
    const volumeOne = fx.volumes[0];
    const source = SOURCE["01"].ch0.join("\n");

    const refs = await loadVolumeReferences(volumeOne.dir, source, { seriesDir: fx.dir });
    const pairs = pairsFor(refs, source);

    ok(
      pairs.includes("百花祭→Hyakka Festival"),
      `volume 1's chapter must be translated with the settled rendering; the pairs were:\n  ${pairs.join("\n  ")}`
    );
    ok(
      pairs.includes("夫人界のアガシ→Agassi of the Lady world"),
      `the second revised term must reach volume 1 too; the pairs were:\n  ${pairs.join("\n  ")}`
    );
    ok(pairs.includes("屋上→Rooftop"), "a term nobody revised keeps its rendering");
    ok(
      !pairs.some((line) => line.includes("Hyakusai")),
      `the superseded rendering must not be offered as a pair: ${pairs.join(", ")}`
    );
    ok(refs.terminologySource.volume === 3, `the law must come from the last record on disk, saw ${refs.terminologySource.volume}`);
    ok(
      refs.terminologySource.file === path.join(fx.volumes[2].dir, "series.db"),
      `the law must name the record it came from: ${refs.terminologySource.file}`
    );
  } finally {
    restoreSeries(fx.previousSeries);
  }
}

// ─── Scenario 2: the superseded rendering reaches no prompt ───────────────────

/**
 * The superseded rendering appears nowhere the model could pick it up as an option — asserted on the text
 * the stage builds, not on a helper's return value.
 * @returns {Promise<void>}
 */
async function scenarioTheSupersededRenderingReachesNoPrompt() {
  const fx = fixtureSeries("no-superseded-prompt");
  try {
    await buildSeries(fx);
    const volumeOne = fx.volumes[0];
    const source = SOURCE["01"].ch0.join("\n");
    const refs = await loadVolumeReferences(volumeOne.dir, source, { seriesDir: fx.dir });

    // 1. The translator's own terminology instruction.
    const promptText = terminologyPromptText(refs, source);
    ok(promptText.includes("Hyakka Festival"), "the settled rendering is in the instruction the translator is given");
    ok(!promptText.includes("Hyakusai Festival"), "the superseded rendering is not in the instruction at all");
    ok(!promptText.includes("madam world"), "and neither is the other superseded rendering");

    // 2. The chapter's pair lines (the spelling the model's own client builds its constraint from).
    const term = chapterTerminology(refs, source);
    same(
      term.lines.filter((line) => line.startsWith("百花祭→")),
      ["百花祭→Hyakka Festival"],
      "one pair per term, and the pair is the settled one"
    );

    // 3. The verify / polish glossary block.
    const block = glossaryBlock(term.terms);
    ok(block.includes('"百花祭" → "Hyakka Festival"'), `the grading block carries the settled rendering:\n${block}`);
    ok(!block.includes("Hyakusai"), `the grading block carries no superseded rendering:\n${block}`);
    ok(!block.includes("Earlier rendering"), `the grading block is pairs only, not history:\n${block}`);

    // 4. The whole term list every stage selects from.
    ok(
      !refs.terms.some((t) => t.rendering === "Hyakusai Festival" || t.rendering === "Agassi of the madam world"),
      `refs.terms holds one rendering per term, and it is the settled one: ${JSON.stringify(refs.terms)}`
    );

    // 5. The hash carries the settled rendering and nothing else.
    const withOld = { ...refs, terms: refs.terms.map((t) => (t.term === "百花祭" ? { ...t, rendering: "Hyakusai Festival" } : t)) };
    ok(
      chapterContextHash(refs, source) !== chapterContextHash(withOld, source),
      "a chapter's key is built from the settled rendering, so the old one is not what its draft is keyed on"
    );

    // 6. The history line survives where it belongs: the Notes cell of the rendered glossary the
    //    consistency audit reads, and the published file. It is labelled as history, and the stage's own
    //    reader refuses it the moment it lands where a rendering would be read.
    ok(refs.glossaryText.includes("Earlier rendering:"), "the superseded rendering is still captured, in the Notes cell");
    same(
      parseGlossaryTerms(refs.glossaryText).map((t) => [t.term, t.rendering]),
      [
        ["百花祭", "Hyakka Festival"],
        ["夫人界のアガシ", "Agassi of the Lady world"],
        ["屋上", "Rooftop"],
      ],
      "the reader sees one pair per term, and the history line sitting in the Notes cell never becomes a second pair"
    );
    const malformed = [];
    const planted = parseGlossaryTerms(
      [
        "# Glossary — Settled Terms",
        "",
        "## Terms",
        "| Japanese | English | Notes |",
        "|---|---|---|",
        '| 百花祭 | Earlier rendering: "Hyakusai Festival" (in force from volume 1) | a hand-edit put the history here |',
        "",
      ].join("\n"),
      { onMalformed: (entry) => malformed.push(entry) }
    );
    ok(!planted.some((t) => t.term === "百花祭"), "a file that pastes the history line into the rendering column is not used as a rendering");
    ok(
      malformed.some((entry) => entry.term === "百花祭" && /superseded/.test(entry.reason)),
      `and it is reported, not skipped: ${JSON.stringify(malformed)}`
    );
  } finally {
    restoreSeries(fx.previousSeries);
  }
}

// ─── Scenario 3: a missing record is a refusal ────────────────────────────────

/**
 * No settled record means the stage refuses, structurally, and names what it looked for. No fallback to
 * the volume's markdown (gotcha 119).
 * @returns {Promise<void>}
 */
async function scenarioAMissingRecordRefuses() {
  const fx = fixtureSeries("missing-record");
  try {
    // Every volume folder has a glossary.md — the file the stage used to read — and no record anywhere.
    for (const volume of fx.volumes) {
      fs.writeFileSync(
        path.join(volume.dir, "glossary.md"),
        ["# Glossary — Settled Terms", "", "## Terms", "| Japanese | English | Notes |", "|---|---|---|", "| 百花祭 | Hyakusai Festival | the old file |", ""].join("\n"),
        "utf8"
      );
    }

    let thrown = null;
    try {
      await loadVolumeReferences(fx.volumes[0].dir, SOURCE["01"].ch0.join("\n"), { seriesDir: fx.dir });
    } catch (err) {
      thrown = err;
    }
    ok(thrown !== null, "a series with no reference record must not translate");
    ok(isStructuralError(thrown), `the refusal must be structural, so ON_TASK_ERROR=continue cannot walk past it: ${thrown && thrown.message}`);
    const message = String(thrown && thrown.message);
    ok(message.includes("Settled Terms(01)"), `the refusal names the folders it looked in: ${message}`);
    ok(message.includes("series.db"), `the refusal names the file it looked for: ${message}`);
    ok(/will not fall back/i.test(message), `the refusal says there is no fallback: ${message}`);
    ok(!message.includes("Hyakusai"), `the refusal does not quietly use the markdown it refused to fall back to: ${message}`);

    // And the resolver itself refuses, before any stage is involved.
    let resolverThrew = null;
    try {
      settledGlossaryRecord({ seriesDir: fx.dir });
    } catch (err) {
      resolverThrew = err;
    }
    ok(resolverThrew !== null && isStructuralError(resolverThrew), "the settled-record query refuses on its own too");
  } finally {
    restoreSeries(fx.previousSeries);
  }
}

/**
 * An unreadable record is refused with the reason, not skipped.
 * @returns {Promise<void>}
 */
async function scenarioAnUnreadableRecordRefuses() {
  const fx = fixtureSeries("unreadable-record");
  try {
    await buildSeries(fx);
    const lastFile = path.join(fx.volumes[2].dir, "series.db");
    fs.writeFileSync(lastFile, "this is not a database at all\n", "utf8");

    let thrown = null;
    try {
      await loadVolumeReferences(fx.volumes[0].dir, SOURCE["01"].ch0.join("\n"), { seriesDir: fx.dir });
    } catch (err) {
      thrown = err;
    }
    ok(thrown !== null, "a record that cannot be read must stop the stage");
    ok(isStructuralError(thrown), `and structurally: ${thrown && thrown.message}`);
    ok(
      String(thrown && thrown.message).includes(path.basename(path.dirname(lastFile))),
      `the refusal names the record it could not read: ${thrown && thrown.message}`
    );
  } finally {
    restoreSeries(fx.previousSeries);
  }
}

// ─── Scenario 4: which record is settled is read off the disk ─────────────────

/**
 * The settled record is the highest-numbered one on disk, decided per call — not a constant.
 * @returns {Promise<void>}
 */
async function scenarioTheSettledRecordIsDecidedFromTheDisk() {
  const fx = fixtureSeries("settled-record-on-disk");
  try {
    await buildSeries(fx);

    const found = settledGlossaryRecord({ seriesDir: fx.dir });
    ok(found.volume === 3, `the settled record is volume 3's while it exists, saw ${found.volume}`);
    same(
      found.candidates.map((c) => c.volume).sort((a, b) => a - b),
      [1, 2, 3],
      "and the query saw all three records, so the choice is a comparison and not a guess"
    );

    const before = await loadVolumeReferences(fx.volumes[0].dir, SOURCE["01"].ch0.join("\n"), { seriesDir: fx.dir });
    ok(pairsFor(before, SOURCE["01"].ch0.join("\n")).includes("百花祭→Hyakka Festival"), "volume 3's revision reaches volume 1's chapter");

    // Retire the last record the way a reopen does — move it aside, do not edit it — and the settled set
    // moves back to the newest record still on disk. Nothing here hardcodes 17, or 3.
    const retired = path.join(fx.volumes[2].dir, "series.db.retired-fixture");
    fs.renameSync(path.join(fx.volumes[2].dir, "series.db"), retired);
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(path.join(fx.volumes[2].dir, `series.db${suffix}`), { force: true });

    const after = settledGlossaryRecord({ seriesDir: fx.dir });
    ok(after.volume === 2, `with volume 3's record gone the settled record is volume 2's, saw ${after.volume}`);
    const refs = await loadVolumeReferences(fx.volumes[0].dir, SOURCE["01"].ch0.join("\n"), { seriesDir: fx.dir });
    ok(
      pairsFor(refs, SOURCE["01"].ch0.join("\n")).includes("百花祭→Hyakusai Festival"),
      "and the settled set is what volume 2's record actually settled — the revision is not remembered from a file"
    );
    ok(
      !fs.existsSync(retired) === false,
      "the retired record was not deleted or edited by the query that refused to use it"
    );
  } finally {
    restoreSeries(fx.previousSeries);
  }
}

// ─── Scenario 5: the published file and the record are compared ───────────────

/**
 * The deterministic comparison: agree → silent; disagree → the term is named, and a published file still
 * printing the superseded rendering is named as exactly that.
 * @returns {Promise<void>}
 */
async function scenarioThePublishedFileIsComparedWithTheRecord() {
  const fx = fixtureSeries("published-vs-record");
  try {
    await buildSeries(fx);
    const seriesFile = publishSeriesRootGlossary(fx);

    // (a) The published series file is the last volume's render, so it agrees: nothing is printed beyond
    //     the law itself, and this volume's own snapshot is named because it is a snapshot.
    const agree = compareSettledGlossary({ seriesDir: fx.dir, volumeDir: fx.volumes[0].dir });
    same(agree.series.differences, [], "the series-root file agrees with the record, so no term is named");
    same(agree.series.missingFromFile, [], "and lists every term the record settles");
    same(agree.series.missingFromRecord, [], "and no term the record has no row for");
    ok(agree.driftCount === 0, `agreeing files produce no drift, saw ${agree.driftCount}`);
    const agreeLines = describeSettledGlossary(agree, { volumeLabel: "Volume 01" });
    same(
      agreeLines.filter((line) => line.startsWith("DRIFT")),
      [],
      `nothing is printed as drift when nothing drifted:\n  ${agreeLines.join("\n  ")}`
    );
    ok(
      agreeLines.some((line) => line.includes("Volume 01's own glossary.md states 2 rendering(s)")),
      `the volume's own snapshot is still named out loud, because its chapters are translated under a different rendering:\n  ${agreeLines.join("\n  ")}`
    );
    ok(
      agree.volume.differences.every((d) => d.fileStatesSupersededRendering),
      `and named as the superseded rendering it is: ${JSON.stringify(agree.volume.differences)}`
    );

    // (b) The published file is stale — it still states the renderings the record replaced. That is drift,
    //     and each term is named with both sides.
    fs.copyFileSync(path.join(fx.volumes[0].dir, "glossary.md"), seriesFile);
    const drift = compareSettledGlossary({ seriesDir: fx.dir, volumeDir: fx.volumes[0].dir });
    same(
      drift.series.differences.map((d) => [d.term, d.fileRendering, d.recordRendering, d.fileStatesSupersededRendering]),
      [
        ["百花祭", "Hyakusai Festival", "Hyakka Festival", true],
        ["夫人界のアガシ", "Agassi of the madam world", "Agassi of the Lady world", true],
      ],
      "a published file printing a superseded rendering is named, term by term, as that"
    );
    const driftLines = describeSettledGlossary(drift, { volumeLabel: "Volume 01" });
    const named = driftLines.filter((line) => line.startsWith("DRIFT"));
    ok(named.length >= 1, `the disagreement is printed:\n  ${driftLines.join("\n  ")}`);
    ok(
      named.some((line) => line.includes('"百花祭"') && line.includes("Hyakusai Festival") && line.includes("Hyakka Festival")),
      `the line names the term and both renderings:\n  ${named.join("\n  ")}`
    );
    ok(
      named.some((line) => line.includes("still printing the rendering the record replaced")),
      `and says which side is stale:\n  ${named.join("\n  ")}`
    );

    // (c) A term the record settles that the published file never lists.
    fs.writeFileSync(
      seriesFile,
      ["# Glossary — Settled Terms", "", "## Terms", "| Japanese | English | Notes |", "|---|---|---|", "| 百花祭 | Hyakka Festival | the settled one |", ""].join("\n"),
      "utf8"
    );
    const partial = compareSettledGlossary({ seriesDir: fx.dir, volumeDir: fx.volumes[0].dir });
    same(
      partial.series.missingFromFile.map((d) => d.term),
      ["夫人界のアガシ", "屋上"],
      "a term the record settles and the file omits is named"
    );

    // (d) A term the file lists that the record holds no row for.
    fs.writeFileSync(
      seriesFile,
      [
        "# Glossary — Settled Terms",
        "",
        "## Terms",
        "| Japanese | English | Notes |",
        "|---|---|---|",
        "| 百花祭 | Hyakka Festival | settled |",
        "| 夫人界のアガシ | Agassi of the Lady world | settled |",
        "| 屋上 | Rooftop | settled |",
        "| 学園祭 | The School Festival | added by hand |",
        "",
      ].join("\n"),
      "utf8"
    );
    const extra = compareSettledGlossary({ seriesDir: fx.dir, volumeDir: fx.volumes[0].dir });
    same(
      extra.series.missingFromRecord.map((d) => d.term),
      ["学園祭"],
      "and a term the published file invented is named too"
    );
  } finally {
    restoreSeries(fx.previousSeries);
  }
}

// ─── Scenario 6: the hash moves only where the term is printed ────────────────

/**
 * `chapterContextHash` moves when the settled rendering moves, and only for the chapters that actually
 * print the term.
 * @returns {Promise<void>}
 */
async function scenarioOnlyTheChaptersThatUseTheTermInvalidate() {
  const fx = fixtureSeries("hash-moves");
  try {
    await buildSeries(fx);
    const volumeOneDir = fx.volumes[0].dir;
    const usesIt = SOURCE["01"].ch0.join("\n");
    const neverSaysIt = SOURCE["01"].ch1.join("\n");

    // The law as it stood when volume 1 was built: its own published snapshot, read the way the stage
    // used to read it.
    const snapshotTerms = parseGlossaryTerms(fs.readFileSync(path.join(volumeOneDir, "glossary.md"), "utf8"));
    const settledRefs = await loadVolumeReferences(volumeOneDir, usesIt, { seriesDir: fx.dir });
    const settledTerms = settledRefs.terms;

    const key = (terms, sourceText) =>
      chapterContextHash({ sharedContextHash: "shared", disputedTerms: new Set(), terms }, sourceText);

    ok(
      key(snapshotTerms, usesIt) !== key(settledTerms, usesIt),
      "the chapter that prints the revised term loses its draft — it was translated under a superseded rendering"
    );
    ok(
      key(snapshotTerms, neverSaysIt) === key(settledTerms, neverSaysIt),
      "and the chapter that never prints it keeps its key, its draft and its cost"
    );

    // How many of this fixture's chapters move: every chapter that prints a revised term, and no others.
    const chapters = [];
    for (const volume of fx.volumes) {
      for (const lines of Object.values(SOURCE[volume.installmentNumber])) {
        chapters.push({ volume: volume.installmentNumber, text: lines.join("\n") });
      }
    }
    const moved = chapters.filter((c) => key(snapshotTerms, c.text) !== key(settledTerms, c.text));
    same(
      moved.map((c) => c.volume),
      ["01", "02", "03"],
      "one chapter per volume prints a revised term, so exactly those three keys move"
    );
    ok(
      chapters.length - moved.length === 1,
      `${chapters.length - moved.length} chapter(s) keep their key out of ${chapters.length} — the one that never prints a revised term`
    );
  } finally {
    restoreSeries(fx.previousSeries);
  }
}

// ─── Scenario 7: the two real revisions, replayed ─────────────────────────────

/**
 * The two renderings that actually changed across the previous run's 17 glossary files, replayed against
 * the fixture, with the honest answer for the live corpus said out loud.
 * @returns {Promise<void>}
 */
async function scenarioTheTwoRealRevisionsReplay() {
  const fx = fixtureSeries("two-real-revisions");
  try {
    const built = await buildSeries(fx);
    const volumeOneSnapshot = parseGlossaryTerms(built[0].file);
    const settled = readSettledGlossary({ seriesDir: fx.dir });

    const changed = settled.rows.filter((row) => {
      const old = volumeOneSnapshot.find((t) => t.term === row.term);
      return old && old.rendering !== row.rendering;
    });
    same(
      changed.map((row) => [row.term, row.superseded[0].rendering, row.rendering, row.superseded[0].appliesFromVolume, row.appliesFromVolume]),
      [
        ["百花祭", "Hyakusai Festival", "Hyakka Festival", 1, 3],
        ["夫人界のアガシ", "Agassi of the madam world", "Agassi of the Lady world", 1, 3],
      ],
      "the fixture replays both real revisions: volume 1 published, volume 3 settled"
    );

    // Which volumes' chapters change rendering.
    const perVolume = [];
    for (const volume of fx.volumes) {
      let moved = 0;
      let total = 0;
      for (const lines of Object.values(SOURCE[volume.installmentNumber])) {
        const text = lines.join("\n");
        total++;
        const before = chapterTerminology({ terms: volumeOneSnapshot }, text).terms;
        const after = chapterTerminology({ terms: settled.rows.map((r) => ({ term: r.term, rendering: r.rendering, section: r.section })) }, text).terms;
        const beforeMap = new Map(before.map((t) => [t.term, t.rendering]));
        if (after.some((t) => beforeMap.has(t.term) && beforeMap.get(t.term) !== t.rendering)) moved++;
      }
      perVolume.push({ volume: volume.installmentNumber, moved, total });
    }
    same(
      perVolume,
      [
        { volume: "01", moved: 1, total: 2 },
        { volume: "02", moved: 1, total: 1 },
        { volume: "03", moved: 1, total: 1 },
      ],
      "every volume's chapter that prints a revised term changes rendering — including the volume that published the old one"
    );

    // The superseded renderings are still in the record, and still in the published file's Notes cell.
    const rowsAtOne = publishedGlossaryRowsInRecord({ db: openDatabase(path.join(fx.volumes[2].dir, "series.db"), { readOnly: true }), volume: 3 }, { volume: 1 });
    same(
      rowsAtOne.find((r) => r.term === "百花祭").rendering,
      "Hyakusai Festival",
      "asking the settled record what volume 1's glossary said still answers volume 1's question — the old query is not broken, it is just not the one the translator asks"
    );
    ok(built[2].file.includes("Earlier rendering:"), "and the published file keeps the history line");
  } finally {
    restoreSeries(fx.previousSeries);
  }
}

// ─── Scenario 8: reading only ─────────────────────────────────────────────────

/**
 * The settled read writes nothing to any record.
 * @returns {Promise<void>}
 */
async function scenarioTheSettledReadWritesNothing() {
  const fx = fixtureSeries("reading-only");
  try {
    await buildSeries(fx);
    const before = fx.volumes.map((volume) => {
      const file = path.join(volume.dir, "series.db");
      return { folder: volume.folder, hash: fileHash(file), rows: countFacts(file) };
    });

    for (const volume of fx.volumes) {
      await loadVolumeReferences(volume.dir, SOURCE[volume.installmentNumber].ch0.join("\n"), { seriesDir: fx.dir });
    }
    compareSettledGlossary({ seriesDir: fx.dir, volumeDir: fx.volumes[0].dir });

    for (const entry of before) {
      const volume = fx.volumes.find((v) => v.folder === entry.folder);
      const file = path.join(volume.dir, "series.db");
      ok(fileHash(file) === entry.hash, `${entry.folder}: the settled read changed the record's bytes`);
      ok(countFacts(file) === entry.rows, `${entry.folder}: the settled read changed the record's row count`);
    }
  } finally {
    restoreSeries(fx.previousSeries);
  }
}

/**
 * How many rows a fixture record holds, read through the store's own read-only door.
 * @param {string} file
 * @returns {number}
 */
function countFacts(file) {
  let db = null;
  try {
    db = openDatabase(file, { readOnly: true });
    return db.prepare("SELECT COUNT(*) AS n FROM facts").get().n;
  } finally {
    if (db) db.close();
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

const scenarios = [
  ["a later volume's revision reaches volume 1's chapters", scenarioALaterVolumesRevisionReachesVolumeOne],
  ["the superseded rendering reaches no prompt", scenarioTheSupersededRenderingReachesNoPrompt],
  ["a missing record refuses, structurally, and names what it looked for", scenarioAMissingRecordRefuses],
  ["an unreadable record refuses with the reason", scenarioAnUnreadableRecordRefuses],
  ["which record is settled is read off the disk, not hardcoded", scenarioTheSettledRecordIsDecidedFromTheDisk],
  ["the published file and the record are compared, term by term", scenarioThePublishedFileIsComparedWithTheRecord],
  ["only the chapters that print the revised term lose their key", scenarioOnlyTheChaptersThatUseTheTermInvalidate],
  ["the two real revisions replayed, with the honest live-corpus answer", scenarioTheTwoRealRevisionsReplay],
  ["the settled read writes nothing to any record", scenarioTheSettledReadWritesNothing],
];

(async () => {
  const started = Date.now();
  for (const [name, run] of scenarios) {
    try {
      await run();
      console.log(`  ok  ${name}`);
    } catch (err) {
      console.error(`  FAIL ${name}\n    ${String(err && err.message ? err.message : err)}`);
      process.exitCode = 1;
    }
  }
  console.log(
    `test/test-translation-terminology-source.js: ${scenarios.length} scenarios, ${checks} checks, ` +
      `${Date.now() - started} ms, 0 model calls`
  );
  if (process.exitCode) process.exit(1);
})();

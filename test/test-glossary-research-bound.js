#!/usr/bin/env node
/**
 * test/test-glossary-research-bound.js — glossary route slice 5: research is bounded to the entries that
 * are actually researchable, what it brings back is filed onto the volume's record, and a note learned in
 * one volume reaches the next volume's published glossary WITHOUT editing the row the earlier volume
 * sealed.
 *
 * The five things this suite exists to pin, in the order the dispatch named them:
 *
 *   1. **Only researchable terms pay.** The lookup and the reading call are asked for the rows the
 *      classifier picked, and every row it dropped is named in `glossary-research.md` with the reason.
 *   2. **The per-volume bound is a constant, and a volume that hits it says so.** Twelve research turns,
 *      no environment knob, and the rows the cap threw away are printed and written down.
 *   3. **A note filed in volume N appears in volume N's and volume N+1's rendered `glossary.md`.**
 *   4. **A later volume's note does not edit the earlier sealed row.** The row's bytes are the same
 *      before and after; the note is its own record and the render is where they meet.
 *   5. **The research log is a document the delivery layer's own shape check accepts**, so the
 *      `missing-expected` / `wrong-shape` rules describe it correctly (the acceptance-context rule the
 *      prompt audit runs is exercised by the offline loops `npm test` drives).
 *
 * Plus the edges the rewrite opened up: the stage opens no agent turn at all any more, the filing door
 * refuses a note whose term the record has no row for, the render merge is idempotent, and the bound
 * survives a process that tries to raise it.
 *
 * Every scenario runs in a throwaway fixture under the fixture root, with a stubbed lookup and a stubbed
 * one-shot. Nothing here reads the real 17 volumes or any file under the series folder (AGENTS.md rule 8,
 * gotcha 69), and no scenario makes a model call or a network call.
 *
 * Run with `npm test`, or standalone: `node test/test-glossary-research-bound.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const harness = require("../harness");
const { matchesShape } = require("../utils/postmortem");
const {
  renderGlossary,
  parseGlossaryMarkdown,
  sealVolumeRecord,
  isVolumeSealed,
  fileResearchNote,
  researchNotesInRecord,
  researchNotesForTerm,
  mergeResearchNotes,
  researchNoteFragment,
  publishedGlossaryRowsInRecord,
} = require("../utils/reference-store");
const glossaryStore = require("../glossary/store");
const { researchVolumeTerms } = require("../glossary/research");
const { classifyResearchable, RESEARCH_MAX_TERMS_PER_VOLUME, selectResearchTargets } = require("../glossary/researchable");
const { readModuleLayer } = require("./module-layer");
const { assertInsideFixture } = require("./fixture-reference-store");

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
 * Count one deep-equality assertion and run it.
 * @param {*} a
 * @param {*} b
 * @param {string} message
 * @returns {void}
 */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

// ─── The fixture ──────────────────────────────────────────────────────────────

/** Where this suite's fixtures live. */
const FIXTURES_ROOT = "/tmp/opencode/series-fixtures";

/** The two fixture volumes, in reading order. */
const VOLUMES = [
  { folder: "Research Story(01)", installmentNumber: "01", base: "research_story(1)" },
  { folder: "Research Story(02)", installmentNumber: "02", base: "research_story(2)" },
];

/**
 * Volume 01's source, chapter by chapter.
 *
 * Every term the fixture files occurs verbatim on a line here, because the evidence rule is still the
 * evidence rule: a research note may only attach to a row the record filed, and a row is filed only when
 * this volume's own text prints it.
 *
 * @type {Object<string, string[]>}
 */
const SOURCE_01 = {
  ch0: [
    "# 第一章",
    "黒板に文字を書いた。",
    "廊下で足音がした。",
    "窓を開けた。",
    "出口に人が立っていた。",
    "本を開いた。",
    "机の上は空だった。",
    "地図を机に広げた。",
    "庭で鐘が鳴った。",
    "橋を渡った。",
    "港で風を待った。",
    "山に登った。",
    "風が強かった。",
    "海に出た。",
    "波が高かった。",
    "星を見た。",
    "道が細かった。",
    "犬がいた。",
  ],
  ch1: ["# 第二章", "黒板はそのままだった。"],
};

/** Volume 02's source. */
const SOURCE_02 = {
  ch0: ["# 第一章", "駱駝は廊下を通った。", "黒板を消した。"],
};

/**
 * The rows volume 01's read pass returns.
 *
 * Fifteen are researchable (filed under the world section the classifier knows), three are not: one with
 * no signal at all, one the note calls an in-series coinage, and one whose note says "Standard Japanese" —
 * the loose marker the measurement rejected, so a fixture that expects it to count would be a fixture that
 * pretends the loose markers shipped.
 *
 * @type {Array<{term: string, rendering: string, note: string, type: string, section: string, query: string}>}
 */
const ROWS_01 = [
  ...[
    ["黒板", "blackboard"],
    ["廊下", "hallway"],
    ["窓", "window"],
    ["出口", "exit"],
    ["本", "book"],
    ["机", "desk"],
    ["地図", "map"],
    ["庭", "garden"],
    ["鐘", "bell"],
    ["橋", "bridge"],
    ["港", "harbour"],
    ["山", "mountain"],
    ["風", "wind"],
    ["海", "sea"],
    ["波", "wave"],
  ].map(([term, rendering]) => ({
    term,
    rendering,
    note: `The book uses ${term} for the thing it names.`,
    type: "concept",
    section: "Real-World References",
    query: term,
  })),
  { term: "星", rendering: "star", note: "Something the book mentions once.", type: "concept", section: "Terms & Concepts", query: "星" },
  { term: "道", rendering: "the Route", note: "An in-series coinage for the club's plan.", type: "concept", section: "Terms & Concepts", query: "道" },
  { term: "犬", rendering: "dog", note: "Standard Japanese for an animal.", type: "concept", section: "Terms & Concepts", query: "犬" },
];

/** The rows volume 02's read pass returns: one new, one already published by volume 01. */
const ROWS_02 = [
  { term: "駱駝", rendering: "the camel", note: "Names it in the afterword.", type: "concept", section: "Real-World References", query: "駱駝" },
  { term: "黒板", rendering: "blackboard", note: "Again.", type: "concept", section: "Real-World References", query: "黒板" },
];

/**
 * The same volume-01 rows, cut to a volume the bound does NOT bite on.
 *
 * Scenario 1 asks "did only the researchable rows pay?", and that question cannot be answered on a volume
 * where the cap also cut rows — the two limits would be tangled. Nine researchable rows and three dropped
 * ones keep them apart.
 *
 * @type {Array<Object>}
 */
const ROWS_01_UNDER_CAP = [...ROWS_01.slice(0, 9), ...ROWS_01.slice(15)];

/**
 * Lay out the two-volume fixture series.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @returns {{dir: string, volumes: Array<{folder: string, installmentNumber: string, base: string, dir: string}>}}
 */
function fixtureSeries(label) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  process.env.SERIES_LOCATION = dir;
  process.env.RESEARCH_ENABLED = "true";

  for (const volume of VOLUMES) {
    const volumeDir = path.join(dir, volume.folder);
    fs.mkdirSync(volumeDir, { recursive: true });
    const source = volume.installmentNumber === "01" ? SOURCE_01 : SOURCE_02;
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
        seriesName: "Research Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test/test-glossary-research-bound.js",
        generatedAt: new Date().toISOString(),
        discovery: {
          summary: "fixture",
          confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
          evidence: ["two books"],
          excluded: [],
        },
        volumes: VOLUMES.map((v) => ({
          folder: v.folder,
          sourceFile: `${v.folder}/${v.base}.epub`,
          installmentNumber: v.installmentNumber,
          title: "Research Story",
          integrity: { isNarrative: true, confidence: 0.9, basis: "fixture" },
        })),
      },
      null,
      2
    ) + "\n"
  );

  return { dir, volumes: VOLUMES.map((v) => ({ ...v, dir: path.join(dir, v.folder) })) };
}

/**
 * The context object `glossary/task.js` hands its store glue and its research pass, for a fixture volume.
 *
 * @param {{dir: string, volumes: Array<{folder: string, installmentNumber: string, base: string, dir: string}>}} fx
 * @param {number} index - 0 for volume 01, 1 for volume 02.
 * @returns {Object}
 */
function stageCtx(fx, index) {
  const volume = fx.volumes[index];
  const previous = index > 0 ? fx.volumes[index - 1] : null;
  const meta = JSON.parse(fs.readFileSync(path.join(volume.dir, `${volume.base}-bundle.meta.json`), "utf8"));
  return {
    values: {
      INSTALLMENT_NUMBER: volume.installmentNumber,
      SOURCE_NAME: "Research Story",
      SOURCE_LANGUAGE: "Japanese",
      TARGET_LANGUAGE: "English",
    },
    folderName: volume.folder,
    seriesDir: fx.dir,
    volumeDir: volume.dir,
    isFirst: index === 0,
    previousFolderName: previous ? previous.folder : null,
    previousGlossaryFile: previous ? path.join(previous.dir, "glossary.md") : null,
    bundle: { segments: meta.segments, wholeChars: 1000, sourceFingerprint: "fixture" },
    glossaryOutputFile: path.join(volume.dir, "glossary.md"),
    validationOutputFile: path.join(volume.dir, "glossary-validation.md"),
    researchNotesFile: path.join(volume.dir, "glossary-research.md"),
    refStore: null,
    researchTurnsLeft: RESEARCH_MAX_TERMS_PER_VOLUME,
    researchLog: null,
  };
}

/**
 * Open a fixture volume's record through the stage's own door, and fail loudly when it refuses.
 *
 * @param {{dir: string, volumes: Array<Object>}} fx
 * @param {number} index
 * @returns {{ctx: Object, opened: Object}}
 */
function openThroughTheStage(fx, index) {
  const ctx = stageCtx(fx, index);
  const previous = index > 0 ? Number(fx.volumes[index - 1].installmentNumber) : null;
  const attempt = glossaryStore.openGlossaryRecord(ctx, previous);
  assert.ok(attempt.ok, `volume ${ctx.values.INSTALLMENT_NUMBER}: ${attempt.error}`);
  ctx.refStore = attempt.opened.store;
  assertInsideFixture(ctx.refStore.file, fx.dir);
  return { ctx, opened: attempt.opened };
}

/**
 * A stubbed Wikipedia: it answers for every term it is asked about, and remembers what it was asked.
 *
 * @param {Object<string, {found: boolean, page?: string, extract?: string}>} [known] - Terms with no entry
 *   come back with no page, which is the "nothing matched" shape.
 * @returns {{lookup: Function, asked: string[]}}
 */
function fakeWiki(known = null) {
  const asked = [];
  /**
   * @param {Array<{term: string, query?: string}>} terms
   * @returns {Promise<Array<Object>>}
   */
  async function lookup(terms) {
    asked.push(...terms.map((entry) => entry.term));
    return terms.map((entry) => {
      const knownFor = known && known[entry.term];
      if (knownFor && !knownFor.found) return { term: entry.term, query: entry.term, found: false, results: [{ lang: "ja", title: null, url: null, extract: null, note: "no results" }] };
      return {
        term: entry.term,
        query: entry.term,
        found: true,
        results: [
          { lang: "ja", title: entry.term, url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(entry.term)}`, extract: `${entry.term} は実在する語である。` },
          { lang: "en", title: `${entry.term} (term)`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(entry.term)}`, extract: `${entry.term} is a real thing.` },
        ],
      };
    });
  }
  return { lookup, asked };
}

/**
 * Stand in for the model, count every call, and answer with the shape the research prompt asks for.
 *
 * @param {{calls: string[]}} sink - Filled with one entry per call, in call order.
 * @returns {Function} The replacement for `harness.runOneShot`.
 */
function fakeResearchModel(sink) {
  /**
   * @param {{systemPrompt: string, messages: Array<Object>, label: string}} request
   * @returns {Promise<string>}
   */
  return async function runOneShot(request) {
    sink.calls.push(request.label);
    const term = String(request.messages[request.messages.length - 1].text.match(/^Term: (.+)$/m)?.[1] || "");
    return JSON.stringify({
      found: true,
      page: term,
      lang: "ja",
      url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(term)}`,
      note: `${term} is a real thing; the established English name is "${term}".`,
    });
  };
}

/**
 * Run one function with `harness.runOneShot` replaced, and restore it afterwards.
 *
 * @param {Function} replacement - What the model call becomes.
 * @param {Function} body - The code to run while it is replaced.
 * @returns {Promise<*>} Whatever `body` returned.
 */
async function withStubbedModel(replacement, body) {
  const original = harness.runOneShot;
  harness.runOneShot = replacement;
  try {
    return await body();
  } finally {
    harness.runOneShot = original;
  }
}

/**
 * Capture the console lines a pass prints, so "it says so out loud" is an assertion and not a hope.
 *
 * @param {Function} body - The code to run.
 * @returns {Promise<{result: *, logs: string[], warnings: string[]}>}
 */
async function captureConsole(body) {
  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = await body();
    return { result, logs, warnings };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

/**
 * Read one fixture volume's published glossary.
 * @param {{dir: string, volumes: Array<Object>}} fx
 * @param {number} index
 * @returns {string}
 */
function readPublishedGlossary(fx, index) {
  return fs.readFileSync(fx.volumes[index].dir + "/glossary.md", "utf8");
}

/**
 * The `facts` row the record holds for a term, as data.
 *
 * @param {Object} store
 * @param {string} term
 * @returns {Object|null}
 */
function factRowFor(store, term) {
  return store.db
    .prepare("SELECT id, body, examples, section, established_volume, owner_volume, sealed, status, row_version FROM facts WHERE aspect = 'term_usage' AND source_stage != 'extract'")
    .all()
    .find((row) => String(JSON.parse(row.examples)[0]) === term) || null;
}

// ─── Scenario 1 ───────────────────────────────────────────────────────────────

/**
 * Only the researchable rows pay, and every row the classifier dropped is named in the log.
 *
 * @returns {Promise<void>}
 */
async function scenarioOnlyResearchableTermsPay() {
  const fx = fixtureSeries("slice5-1");
  const { ctx } = openThroughTheStage(fx, 0);
  glossaryStore.fileGlossaryExtraction(ctx, ROWS_01_UNDER_CAP);
  const filed = glossaryStore.fileGlossaryTermRows(ctx, ROWS_01_UNDER_CAP);
  ok(filed.importedCount === ROWS_01_UNDER_CAP.length, `the fixture filed ${filed.importedCount} of ${ROWS_01_UNDER_CAP.length} rows: ${JSON.stringify(filed.refused.map((r) => r.term))}`);

  const wiki = fakeWiki();
  const sink = { calls: [] };
  const { result, logs } = await withStubbedModel(fakeResearchModel(sink), async () =>
    captureConsole(() => researchVolumeTerms(ctx, { lookup: wiki.lookup }))
  );

  const researchable = ROWS_01_UNDER_CAP.filter((row) => classifyResearchable(row).researchable);
  ok(researchable.length < RESEARCH_MAX_TERMS_PER_VOLUME, `the fixture volume must stay under the bound so this scenario measures only the classifier: ${researchable.length}`);
  same(result.asked, researchable.length, `the pass asked ${result.asked} term(s); the classifier picked ${researchable.length}`);
  same(sink.calls.length, researchable.length, `the model was called ${sink.calls.length} time(s) for ${researchable.length} researchable row(s)`);
  same(wiki.asked.length, researchable.length, `the lookup was asked for ${wiki.asked.length} term(s)`);
  same(result.filed, researchable.length, "a researchable row's answer was not filed");
  same(result.notResearchable, ROWS_01_UNDER_CAP.length - researchable.length, "the pass did not count the rows it dropped");
  ok(result.capped === false, "a volume under the bound reported that it hit it");
  ok(logs.every((line) => !line.includes("over the bound")), "a volume under the bound warned about the bound");

  const log = fs.readFileSync(ctx.researchNotesFile, "utf8");
  for (const row of ROWS_01_UNDER_CAP) {
    ok(log.includes(`- ${row.term} (`) || log.includes(`### ${row.term} `), `the log does not name ${row.term}`);
  }
  const dropped = ROWS_01_UNDER_CAP.filter((row) => !classifyResearchable(row).researchable);
  same(dropped.length, 3, "the fixture's dropped-row set moved");
  ok(log.includes("## Not researchable (3)"), `the log does not count the three dropped rows: ${log.slice(0, 400)}`);
  const notResearchableSection = log.split("## Not researchable (")[1] || "";
  for (const row of dropped) {
    ok(notResearchableSection.includes(`- ${row.term} (`), `${row.term} was dropped and the log does not name it under "Not researchable"`);
    ok(notResearchableSection.split(`- ${row.term} (`)[1].includes("—"), `${row.term} is named without a reason`);
  }
  ok(notResearchableSection.includes("in-series"), "the log does not say WHY the coinage row was dropped");
  ok(notResearchableSection.includes("犬"), "the loose marker 'Standard Japanese' made a row researchable");
  ok(log.includes("_None: this volume's researchable rows fit inside the bound._"), "the log does not say the bound cut nothing");
  ok(logs.some((line) => line.includes("researchable row(s) to ask")), "the pass never said how many rows it was going to ask");

  console.log("slice 5 / 1: only researchable rows pay; every dropped row is named in the log with its reason");
}

// ─── Scenario 2 ───────────────────────────────────────────────────────────────

/**
 * The bound is a constant, it bites, and the volume that hits it says so — in the log and on the console.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheBoundBitesAndSaysSo() {
  const fx = fixtureSeries("slice5-2");
  const { ctx } = openThroughTheStage(fx, 0);
  glossaryStore.fileGlossaryTermRows(ctx, ROWS_01);

  const wiki = fakeWiki();
  const sink = { calls: [] };
  const { result, warnings } = await withStubbedModel(fakeResearchModel(sink), async () =>
    captureConsole(() => researchVolumeTerms(ctx, { lookup: wiki.lookup }))
  );

  ok(result.asked === RESEARCH_MAX_TERMS_PER_VOLUME, `the pass asked ${result.asked} terms; the bound is ${RESEARCH_MAX_TERMS_PER_VOLUME}`);
  same(sink.calls.length, RESEARCH_MAX_TERMS_PER_VOLUME, `the model was called ${sink.calls.length} times, not the bound`);
  ok(result.skipped.length === 3, `expected 3 rows over the bound, got ${result.skipped.length}`);
  ok(result.capped === true, "the pass did not report that the volume hit the bound");
  ok(warnings.some((line) => line.includes("research bound") && line.includes("named in glossary-research.md")), "the volume that hit the bound did not say so on the console");

  const log = fs.readFileSync(ctx.researchNotesFile, "utf8");
  ok(log.includes(`## Skipped by the bound (${result.skipped.length})`), "the log does not count what the bound cut");
  for (const row of result.skipped) ok(log.includes(`- ${row.term} (Real-World References)`), `the bound cut ${row.term} and the log does not name it`);
  for (const row of result.skipped) ok(!wiki.asked.includes(row.term), `${row.term} was over the bound and the lookup was asked for it anyway`);
  ok(log.includes(`The bound is ${RESEARCH_MAX_TERMS_PER_VOLUME} research turns per volume`), "the log does not name the bound it applied");

  console.log(`slice 5 / 2: ${RESEARCH_MAX_TERMS_PER_VOLUME} research turns per volume, ${result.skipped.length} named as cut, said out loud twice`);
}

// ─── Scenario 3 ───────────────────────────────────────────────────────────────

/**
 * The bound is not a setting. A process that tries to raise it gets the same number.
 *
 * @returns {void}
 */
function scenarioTheBoundHasNoKnob() {
  const script =
    'const { RESEARCH_MAX_TERMS_PER_VOLUME } = require("./glossary/researchable");' +
    'console.log(RESEARCH_MAX_TERMS_PER_VOLUME);';
  const env = { ...process.env, RESEARCH_MAX_TERMS_PER_VOLUME: "99", RESEARCH_MAX_TERMS: "99", RESEARCH_LIMIT: "99" };
  const run = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, env, encoding: "utf8" });
  const value = Number(String(run.stdout).trim());
  same(value, RESEARCH_MAX_TERMS_PER_VOLUME, `a process that set RESEARCH_MAX_TERMS_PER_VOLUME=99 got ${value}`);
  ok(Number.isInteger(RESEARCH_MAX_TERMS_PER_VOLUME) && RESEARCH_MAX_TERMS_PER_VOLUME > 0, "the bound is not a positive integer");

  const layer = readModuleLayer(ROOT, "glossary.js", "glossary");
  ok(!/process\.env\.RESEARCH_MAX_TERMS/.test(layer), "the stage reads a research cap out of the environment");
  console.log(`slice 5 / 3: RESEARCH_MAX_TERMS_PER_VOLUME = ${RESEARCH_MAX_TERMS_PER_VOLUME} survives an environment that tries to raise it`);
}

// ─── Scenario 4 ───────────────────────────────────────────────────────────────

/**
 * A note filed in volume 1 is printed by volume 1's glossary AND by volume 2's, and a note volume 2
 * learns about volume 1's term does not touch volume 1's row.
 *
 * @returns {Promise<void>}
 */
async function scenarioNotesTravelWithoutEditingARow() {
  const fx = fixtureSeries("slice5-4");

  // Volume 01: file, research, render, seal — the stage's own order.
  const first = openThroughTheStage(fx, 0);
  const ctx1 = first.ctx;
  glossaryStore.fileGlossaryTermRows(ctx1, ROWS_01);
  const sink1 = { calls: [] };
  await withStubbedModel(fakeResearchModel(sink1), () => researchVolumeTerms(ctx1, { lookup: fakeWiki().lookup }));
  const rendered1 = await glossaryStore.renderGlossaryArtifact(ctx1);
  ok(rendered1.ok, `volume 01 refused to render: ${rendered1.refusal && rendered1.refusal.because}`);
  const glossary1 = readPublishedGlossary(fx, 0);
  ok(glossary1.includes("Research (v1):"), "volume 01's own research note is not in volume 01's glossary");

  const blackboardBefore = factRowFor(ctx1.refStore, "黒板");
  ok(blackboardBefore, "volume 01's record does not hold the row the notes are about");
  const bodyBefore = blackboardBefore.body;
  ok(!bodyBefore.includes("Research ("), "the research text was written INTO the row's body instead of merged at render");

  const sealed1 = sealVolumeRecord(ctx1.refStore);
  ok(sealed1.ok && isVolumeSealed(ctx1.refStore, 1), `volume 01 was not sealed: ${JSON.stringify(sealed1)}`);
  ctx1.refStore.close();

  // Volume 02: copy-forward from the sealed record, its own research, its own render.
  const second = openThroughTheStage(fx, 1);
  const ctx2 = second.ctx;
  glossaryStore.fileGlossaryTermRows(ctx2, ROWS_02);
  const sink2 = { calls: [] };
  const pass2 = await withStubbedModel(fakeResearchModel(sink2), () => researchVolumeTerms(ctx2, { lookup: fakeWiki().lookup }));
  same(pass2.asked, 1, `volume 02 researched ${pass2.asked} term(s); only 駱駝 is its own row`);
  ok(!wikiAsked(sink2, "黒板"), "volume 02 paid a research turn for a row volume 1 already published");

  const rendered2 = await glossaryStore.renderGlossaryArtifact(ctx2);
  ok(rendered2.ok, `volume 02 refused to render: ${rendered2.refusal && rendered2.refusal.because}`);
  const glossary2 = readPublishedGlossary(fx, 1);
  ok(glossary2.includes("Research (v1):"), "volume 1's note is not in volume 2's glossary");
  ok(glossary2.includes("Research (v1): blackboard") || glossary2.includes("Research (v1): 黒板"), "volume 1's note arrived mangled");

  // Volume 02 learns something about volume 1's term. The row must not move.
  const rowBefore = factRowFor(ctx2.refStore, "黒板");
  const factsBefore = ctx2.refStore.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n;
  const filed = fileResearchNote(ctx2.refStore, {
    term: "黒板",
    found: true,
    page: "黒板",
    lang: "ja",
    url: "https://ja.wikipedia.org/wiki/黒板",
    note: "Volume 2's lookup adds that the word is a schoolroom fixture.",
  });
  ok(filed.ok, `volume 2's note was refused: ${filed.refusal && filed.refusal.because}`);
  const rowAfter = factRowFor(ctx2.refStore, "黒板");
  same(rowAfter.id, rowBefore.id, "the row volume 1 published is no longer the same row");
  same(rowAfter.body, rowBefore.body, "the row's own text changed");
  same(rowAfter.established_volume, rowBefore.established_volume, "the row's establishing volume changed");
  same(rowAfter.owner_volume, rowBefore.owner_volume, "the row's owner changed — a published row is not re-owned");
  same(rowAfter.sealed, rowBefore.sealed, "a sealed row was unsealed");
  same(rowAfter.status, rowBefore.status, "the row's status changed");
  same(rowAfter.row_version, rowBefore.row_version, "the row was rewritten");
  same(ctx2.refStore.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n, factsBefore, "filing a note added or removed a facts row");
  ok(!rowAfter.body.includes("Research ("), "the note was folded into the row body");

  const renderedAgain = await glossaryStore.renderGlossaryArtifact(ctx2, { moveAside: false });
  ok(renderedAgain.ok, "the re-render refused");
  const glossary3 = readPublishedGlossary(fx, 1);
  ok(glossary3.includes("Research (v1):"), "the re-render lost volume 1's note");
  ok(glossary3.includes("Research (v2):"), "volume 2's own note is not in volume 2's glossary");
  const cell = glossary3.split("\n").find((line) => line.startsWith("| 黒板 |"));
  const occurrences = (cell.match(/Research \(/g) || []).length;
  same(occurrences, 2, `the blackboard cell holds ${occurrences} research fragment(s); exactly one per asking volume`);

  // Idempotence: rendering the same record twice is the same bytes.
  const once = renderGlossary(ctx2.refStore, { volume: 2, title: glossaryStore.glossaryTitleBlock(ctx2.values) });
  const twice = renderGlossary(ctx2.refStore, { volume: 2, title: glossaryStore.glossaryTitleBlock(ctx2.values) });
  same(once, twice, "rendering the same record twice produced different bytes");
  ok(once === glossary3, "the published file is not what renderGlossary produces");

  // The round trip still round-trips: the published file parses back into the same rows.
  const parsed = parseGlossaryMarkdown(once);
  same(parsed.rows.length, ROWS_01.length + 1, `the published file parses to ${parsed.rows.length} rows`);
  const camel = parsed.rows.find((row) => row.term === "駱駝");
  ok(camel && camel.notes.includes("Research (v2)"), "volume 2's own row lost its own note in the parse");

  ctx2.refStore.close();
  console.log("slice 5 / 4: a note is its own record; it travels to the next volume's render and leaves the sealed row byte-identical");
}

/**
 * Whether a research-call sink contains a call about one term.
 * @param {{calls: string[]}} sink
 * @param {string} term
 * @returns {boolean}
 */
function wikiAsked(sink, term) {
  return sink.calls.some((label) => label.endsWith(`-${term}`));
}

// ─── Scenario 5 ───────────────────────────────────────────────────────────────

/**
 * The doors refuse the shapes that would turn a note into an edit, and the log is a document.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheDoorsRefuseTheWrongShapes() {
  const fx = fixtureSeries("slice5-5");
  const { ctx } = openThroughTheStage(fx, 0);
  glossaryStore.fileGlossaryTermRows(ctx, ROWS_01);

  const noRow = fileResearchNote(ctx.refStore, { term: "存在しない語", found: true, note: "A note about a term this record never filed." });
  ok(!noRow.ok, "a note about a term the record does not hold was accepted");
  same(noRow.refusal.rule, "research-note-has-no-row", `the refusal named ${noRow.refusal.rule}`);

  const noText = fileResearchNote(ctx.refStore, { term: "黒板", found: true, note: "   " });
  ok(!noText.ok, "an empty note was accepted");
  same(noText.refusal.rule, "research-note-has-no-text", `the refusal named ${noText.refusal.rule}`);

  const tooLong = fileResearchNote(ctx.refStore, { term: "黒板", found: true, note: "x".repeat(700) });
  ok(!tooLong.ok, "a 700-character note was accepted into a table cell");
  same(tooLong.refusal.rule, "research-note-too-long", `the refusal named ${tooLong.refusal.rule}`);

  // Idempotent per (asking volume, term): the second filing replaces the first, it does not stack.
  const first = fileResearchNote(ctx.refStore, { term: "橋", found: true, page: "橋", lang: "ja", note: "First answer." });
  const second = fileResearchNote(ctx.refStore, { term: "橋", found: true, page: "橋", lang: "ja", note: "Second answer." });
  ok(first.ok && second.ok, "a note filing was refused");
  ok(second.replaced === true, "re-filing the same volume's note did not report that it replaced one");
  same(researchNotesForTerm(ctx.refStore, "橋").length, 1, "the same volume filed the same term's note twice");
  same(researchNotesForTerm(ctx.refStore, "橋")[0].note, "Second answer.", "the replacement did not replace");

  // A note with no pipes survives the cell escape and the parser unchanged.
  const fragment = researchNoteFragment({ found: true, page: "P", lang: "ja", url: "https://example.test/P", note: "a; b", askedByVolume: 3 });
  ok(!fragment.includes("|"), `the fragment carries a column separator: ${fragment}`);
  const merged = mergeResearchNotes("Row's own note.", [
    { found: true, page: "P", lang: "ja", url: "https://example.test/P", note: "first", askedByVolume: 1 },
    { found: false, page: null, lang: null, url: null, note: "nothing matched", askedByVolume: 2 },
  ]);
  ok(merged.startsWith("Row's own note.; Research (v1):"), `the merge did not keep the row's own text first: ${merged}`);
  ok(merged.includes("Research (v2): nothing matched"), `the merge dropped a "nothing matched" answer: ${merged}`);
  same(mergeResearchNotes(merged, [
    { found: true, page: "P", lang: "ja", url: "https://example.test/P", note: "first", askedByVolume: 1 },
  ]), merged, "merging the same note again duplicated it");

  // The log is the shape the delivery layer declares for it.
  const wiki = fakeWiki({ 黒板: { found: false } });
  await withStubbedModel(fakeResearchModel({ calls: [] }), () => researchVolumeTerms(ctx, { lookup: wiki.lookup }));
  const log = fs.readFileSync(ctx.researchNotesFile, "utf8");
  ok(matchesShape(log, "document"), "the research log is not the shape the artifact rules declare for it");
  ok(log.includes("nothing matched"), "a term the lookup could not answer is not in the log");
  ok(!/^- \(pending/m.test(log), "the old skeleton placeholder is still being written");

  // A term the lookup could not answer is still recorded, with no model call spent on it.
  const notes = researchNotesInRecord(ctx.refStore);
  ok(notes.some((note) => note.term === "黒板" && note.found === false), "the 'nothing matched' answer was not filed");

  console.log("slice 5 / 5: the doors refuse a note with no row, no text, or too much text; the log is a document the shape check accepts");
}

// ─── Scenario 6 ───────────────────────────────────────────────────────────────

/**
 * The stage opens no agent turn any more, and the research pass is a query over the record.
 *
 * @returns {void}
 */
function scenarioTheStageHasNoAgentTurn() {
  const layer = readModuleLayer(ROOT, "glossary.js", "glossary");
  const agentHandles = layer.match(/createAgentHandle\(/g) || [];
  same(agentHandles.length, 0, `the glossary stage still opens ${agentHandles.length} agent turn(s)`);
  ok(!layer.includes("RESEARCHER_SYSTEM_PROMPT"), "the deleted researcher agent's prompt is still in the layer");
  ok(!layer.includes("buildPerTermResearchPrompt"), "the deleted per-term research prompt is still in the layer");
  ok(!layer.includes("pendingPlaceholder"), "the research skeleton placeholder is still in the layer");
  ok(!/Promise\.allSettled\(/.test(layer), "the research pass still fans out in parallel");
  ok(!layer.includes("createWikiTools"), "the stage still hands an agent wiki tools");
  ok(layer.includes("researchVolumeTerms("), "no route runs the bounded research pass");
  ok(layer.includes("RESEARCH_MAX_TERMS_PER_VOLUME"), "the stage does not name the bound it applies");

  // The bound is a query over the record, not over the model's answer.
  const fx = fixtureSeries("slice5-6");
  const { ctx } = openThroughTheStage(fx, 0);
  glossaryStore.fileGlossaryTermRows(ctx, ROWS_01);
  const selection = selectResearchTargets(ctx.refStore, ctx.values.INSTALLMENT_NUMBER);
  same(selection.targets.length, RESEARCH_MAX_TERMS_PER_VOLUME, "the record's own query did not apply the cap");
  const rows = publishedGlossaryRowsInRecord(ctx.refStore);
  same(rows.length, ROWS_01.length, "the shared row query disagrees with what was filed");
  ok(rows.every((row) => typeof row.establishedVolume === "number"), "the row query does not carry the establishing volume");
  ctx.refStore.close();

  console.log("slice 5 / 6: the glossary stage opens no agent turn; the bound is a query over the volume's own record");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

/**
 * Run every scenario.
 * @returns {Promise<void>}
 */
async function main() {
  await scenarioOnlyResearchableTermsPay();
  await scenarioTheBoundBitesAndSaysSo();
  scenarioTheBoundHasNoKnob();
  await scenarioNotesTravelWithoutEditingARow();
  await scenarioTheDoorsRefuseTheWrongShapes();
  scenarioTheStageHasNoAgentTurn();
  console.log(`\ntest-glossary-research-bound: ${checks} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * test/test-extract-voice.js — the reading pass on its own: `extract-voice.js`.
 *
 * Why this suite exists. The voice stage has always paid for the reading and the writing together:
 * the extraction pass produces `character-voice-new.json` and the author pass re-types it into
 * `character-voice.md`. `extract-voice.js` unbolts them, which is a route that is only safe if it
 * cannot do anything else — so every scenario here is about a boundary the command is supposed to
 * be unable to cross, and the numbers are read out of what the stubbed harness actually heard, not
 * out of the source text.
 *
 * The boundaries:
 *
 *   - one call per chapter, in reading order, and each chapter shown the **record query** built from
 *     this volume's open reference record — never a `character-voice` markdown file (plan 06 slice 2;
 *     the difference is asserted on the messages, not assumed);
 *   - it writes the notebook and the record and never the artifact: no `character-voice.md`, no
 *     `pov-map.md`, and the record is closed without being sealed;
 *   - it opens the volume's record through the pipeline's own door, so the previous volume's sealed
 *     record is carried in before a single chapter is read;
 *   - a volume whose record is already sealed is refused, and the refusal costs no model call;
 *   - resume is free: a chapter already read for the same chapter text is not paid for twice, and a
 *     chapter whose text changed is re-read on its own;
 *   - the evidence rule is not bypassed: a claim whose quote the volume does not print is refused
 *     and named.
 *
 * Everything happens in a throwaway fixture under `/tmp/opencode`. The real corpus is not reachable
 * from here (AGENTS.md rule 8, gotcha 69), and no scenario can call a real endpoint: the harness is
 * replaced with a counting stub, and the last scenario asserts the stub is what answered.
 *
 * Run with `npm test`, or standalone: `node test/test-extract-voice.js`.
 */

// Read before anything is required: the part-packing target is a load-time constant in
// `utils/source/config.js`, and a fixture whose book is smaller than it never gets a
// chapter-by-chapter path at all. `splitPlainTextSegments` clamps the target to 1000 characters, and
// every chapter block below is written longer than that, so each chapter is exactly one segment.
process.env.SOURCE_TEXT_PART_TARGET_CHARS = "1000";
delete process.env.SOURCE_CHUNK_THRESHOLD_CHARS;
// Neither reference-store stage has a setting in front of its record any more, so there is
// nothing here to blank before the store's values are read.

require("./test-home"); // the run's records get a throwaway home (gotcha 69)

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const harness = require("../harness");
const rs = require("../utils/reference-store");
const { resolveSourceBundle } = require("../utils/source");
const ev = require("../extract-voice");
const { KNOWN_FACTS_HEADING } = require("../character-voice/known-facts");
const { GLOSSARY_01, GLOSSARY_NO_READING_CELL: NO_READING, VOICE_01, FIXTURES_ROOT } = require("./fixture-reference-store");

/**
 * One chapter block, long enough to become its own segment.
 *
 * `splitPlainTextSegments` cuts a plain-text book at blank lines and packs the blocks up to the part
 * target; a block bigger than the target becomes a segment of its own. Making every chapter block
 * bigger than the target is how this fixture gets a chapter-by-chapter path without writing a real
 * novel: the repetition is filler, and every line it repeats is a line the evidence rule can find.
 *
 * @param {string} title
 * @param {string[]} lines
 * @param {number} minChars
 * @returns {string}
 */
function chapterBlock(title, lines, minChars) {
  const one = lines.join("\n");
  let body = `# ${title}\n${one}`;
  while (body.length < minChars) body += `\n${one}`;
  return body;
}

/** Volume 01's book: the fixture store's three chapters, each its own segment. */
const BOOK_01 = [
  chapterBlock("プロローグ", [
    "如月雨露は教室に入った。",
    "「さぁ、今日も俺の熱き血潮を迸らせるぜ！」",
    "大賀太陽は笑った。",
    "担任の教師は黒板を叩いた。",
  ], 1200),
  chapterBlock("第一章", [
    "三色院菫子は本を読んでいた。",
    "如月雨露は「気にすんな！」と言った。",
    "山田は会計の人である。",
    "「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。",
    "担任の教師は出口に立っていた。",
  ], 1200),
  chapterBlock("第二章", [
    "ジョーロは窓を見た。",
    "「気にすんな！」はジョーロの定型である。",
    "秋野あきの桜さくらは廊下で立ち止まった。",
    "担任の教師は何も言わなかった。",
  ], 1200),
].join("\n\n");

/**
 * Volume 02's book: six chapters, every one naming characters the glossary carries, so the reading
 * pass has a multi-chapter volume to read and this volume's own glossary has rows its own text prints.
 */
const BOOK_02 = [
  chapterBlock("第三章", [
    "如月雨露は「気にすんな！」と言った。",
    "大賀太陽は笑った。",
    "ジョーロは窓を見た。",
    "担任の教師は黒板を叩いた。",
  ], 1200),
  chapterBlock("第四章", [
    "三色院菫子は本を読んでいた。",
    "如月雨露は廊下に立った。",
    "山田は会計の人である。",
    "「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。",
  ], 1200),
  chapterBlock("第五章", [
    "秋野あきの桜さくらは廊下で立ち止まった。",
    "如月雨露は「気にすんな！」と言った。",
    "駱駝はあとがきに書いた。",
    "大賀太陽は笑った。",
  ], 1200),
  chapterBlock("第六章", [
    "ジョーロは出口に立っていた。",
    "三色院菫子は本を読んでいた。",
    "担任の教師は出口に立っていた。",
    "如月雨露は窓を見た。",
  ], 1200),
  chapterBlock("第七章", [
    "大賀太陽は「ドンマイだ！ ドンマイ！」と叫んだ。",
    "山田は会計の人である。",
    "秋野あきの桜さくらは廊下で立ち止まった。",
    "ジョーロは廊下で立ち止まった。",
  ], 1200),
  chapterBlock("第八章", [
    "如月雨露は「気にすんな！」と言った。",
    "三色院菫子は出口に立っていた。",
    "担任の教師は何も言わなかった。",
    "大賀太陽は笑った。",
  ], 1200),
].join("\n\n");

/**
 * Volume 02's published glossary: the roster volume 01 carries, plus one character volume 02's own
 * text prints and volume 01's does not. That extra row is what makes "this volume's own glossary was
 * read into its record" an assertion about new rows rather than about the copy.
 */
const GLOSSARY_02 = GLOSSARY_01.replace(
  `| 三色院菫子 | Sanshokuin Sumireko | ${NO_READING} | Library committee |`,
  `| 三色院菫子 | Sanshokuin Sumireko | ${NO_READING} | Library committee |\n| 駱駝 | Rakuda | ${NO_READING} | Named in the afterword |`
);

/**
 * Lay out a two-volume plain-text series with a plan of record, and seal volume 01's record the way
 * a finished volume seals it: its published reference mirrored in, its glossary registered, sealed.
 *
 * @param {string} label
 * @returns {{dir: string, volumes: Array<{folder: string, installmentNumber: string, dir: string}>, calls: Array<Object>}}
 */
function fixtureReadingSeries(label) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  process.env.SERIES_LOCATION = dir;
  process.env.POSTMORTEM_DIR = path.join(dir, ".postmortem");
  process.env.LOGS_DIR = path.join(dir, ".logs");
  process.env.DRY_RUN_DIR = path.join(dir, ".dry-run");

  const volumes = [
    { folder: "Test Story(01)", installmentNumber: "01", sourceFile: "Test Story(01)/book.txt", book: BOOK_01 },
    { folder: "Test Story(02)", installmentNumber: "02", sourceFile: "Test Story(02)/book.txt", book: BOOK_02 },
  ];
  for (const v of volumes) {
    v.dir = path.join(dir, v.folder);
    fs.mkdirSync(v.dir, { recursive: true });
    fs.writeFileSync(path.join(v.dir, "book.txt"), v.book + "\n", "utf8");
  }
  // The previous volume's published reference: what the reading pass is shown as its cumulative base.
  fs.writeFileSync(path.join(volumes[0].dir, "character-voice.md"), VOICE_01, "utf8");

  fs.writeFileSync(
    path.join(dir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: dir,
        seriesName: "Test Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test/test-extract-voice.js",
        generatedAt: new Date().toISOString(),
        discovery: {
          summary: "fixture",
          confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
          evidence: ["two books"],
          excluded: [],
        },
        volumes: volumes.map((v) => ({
          folder: v.folder,
          sourceFile: `${v.folder}/book.txt`,
          installmentNumber: v.installmentNumber,
          title: "Test Story",
          integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose" },
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  /** @type {Array<Object>} Every model call the stubbed harness heard. */
  const calls = [];
  stubHarness(calls);

  return { dir, volumes, calls };
}


/**
 * Replace the harness's one-shot with a counter that answers like the extraction pass.
 *
 * The answer is built from the chapter file the call was actually given, so every quote the claim
 * carries is a line that volume really prints — which is what lets the suite assert the evidence
 * rule's *refusals* separately instead of tripping it by accident.
 *
 * @param {Array<Object>} calls
 * @param {{unverifiable?: boolean}} [opts]
 * @returns {void}
 */
function stubHarness(calls, { unverifiable = false, malformed = false, cutOffChapter = null, alwaysCutOff = false } = {}) {
  /** @type {Map<string, number>} How many times each chapter has been asked, so a retry can answer differently. */
  const seen = new Map();
  harness.runOneShot = async ({ systemPrompt, messages, label, thinkingLevel }) => {
    const fileMessage = messages.find((m) => m && m.file);
    const text = fileMessage ? fs.readFileSync(fileMessage.file, "utf8") : "";
    const line = (text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))[0] || "").trim();
    calls.push({ label, messages, thinkingLevel });
    const chapter = cutOffChapter || (alwaysCutOff ? "*" : null);
    if (chapter) {
      const key = label;
      const times = (seen.get(key) || 0) + 1;
      seen.set(key, times);
      const matches = alwaysCutOff || label.endsWith(`-${cutOffChapter}`);
      const claim = (tag) => ({
        type: "voice",
        character: "如月雨露",
        quirkType: "catchphrase",
        description: `Cut-off chapter claim ${tag} (${label}).`,
        examples: [line],
        formalityLevel: "casual",
      });
      if (matches && (alwaysCutOff || times === 1)) {
        // The real volume 02 failure: the answer stops in the middle of the array, so the closing
        // bracket never arrives and whatever the model had not written yet is simply not there.
        return `[\n${JSON.stringify(claim("a"), null, 2)},\n${JSON.stringify(claim("b"), null, 2).replace(/\n  "formalityLevel": "casual"\n}/, "\n  \"formalityLevel\": \"casual\"\n}")}`;
      }
      if (matches) {
        // The re-read: a whole answer, and a bigger one.
        return JSON.stringify([claim("a"), claim("b"), claim("c"), claim("d")]);
      }
    }
    if (unverifiable) {
      // Neither the name nor the quote is anywhere in this volume's text: the shape
      // `EXTRACTION_01_UNVERIFIABLE` has, which is the fixture's proven refusal case.
      return JSON.stringify([
        {
          type: "voice",
          character: "存在しない人物",
          quirkType: "catchphrase",
          description: "A line the extractor invented, about somebody the book never prints.",
          examples: ["存在しない台詞など無い。"],
        },
      ]);
    }
    if (malformed) {
      // Volume 02's real chapter ch2 failure, reproduced exactly: the model wrote the object with a
      // comma missing between two properties. Everything else in the array is balanced.
      const claim = (tag) => ({
        type: "voice",
        character: "如月雨露",
        quirkType: "catchphrase",
        description: `Claim ${tag} (${label}).`,
        examples: [line],
        formalityLevel: "casual",
      });
      const parts = [JSON.stringify(claim("a"), null, 2), JSON.stringify(claim("b"), null, 2), JSON.stringify(claim("c"), null, 2)];
      parts[1] = parts[1].replace(',\n  "formalityLevel"', '\n  "formalityLevel"');
      return `[\n${parts.join(",\n")}\n]`;
    }
    return JSON.stringify([
      {
        type: "voice",
        character: "如月雨露",
        quirkType: "catchphrase",
        description: `Turns a refusal down in one line (${label}).`,
        examples: [line],
        formalityLevel: "casual",
      },
    ]);
  };
}


/**
 * Resolve one fixture volume's source the way a stage does, so the store's chapter rows and the
 * evidence rule are looking at the same files the reading pass read.
 *
 * @param {{dir: string, volumes: Array<Object>}} series
 * @param {number} index
 * @returns {Promise<Object>}
 */
async function bundleOf(series, index) {
  const volume = series.volumes[index];
  return resolveSourceBundle({ seriesDir: series.dir, volume, volumeDir: volume.dir, force: false });
}


/**
 * Seal volume 01's record: the state a real finished volume leaves behind, and the state volume 02's
 * copy-forward is allowed to build on.
 *
 * @param {{dir: string, volumes: Array<Object>}} series
 * @returns {Promise<void>}
 */
async function sealVolumeOne(series) {
  const bundle = await bundleOf(series, 0);
  const store = rs.openReferenceStore({ volume: 1, folder: series.volumes[0].folder, seriesDir: series.dir, stage: rs.DOCUMENT_SOURCE_STAGE });
  store.registerChaptersFromSource(bundle.segments);
  rs.importVolumeArtifacts(store, { glossaryMarkdown: GLOSSARY_01, voiceMarkdown: VOICE_01 });
  store.recordCastPresence();
  store.sealVolume(1);
  store.close();
}


/**
 * Run the command against a fixture series.
 *
 * @param {{dir: string}} series
 * @param {{volume?: string, force?: boolean, dryRun?: boolean, chapters?: string[]}} [opts]
 * @returns {Promise<Object>}
 */
function readVolume(series, opts = {}) {
  return ev.runExtractPass({
    seriesDir: series.dir,
    volumeArg: opts.volume || "02",
    dryRun: Boolean(opts.dryRun),
    force: Boolean(opts.force),
    chapters: opts.chapters || null,
    log: () => {},
  });
}


/**
 * The volume folder's file names, so "it wrote only what it is allowed to write" is an assertion
 * about the folder and not about the code.
 *
 * @param {string} volumeDir
 * @returns {string[]}
 */
function filesIn(volumeDir) {
  return fs.readdirSync(volumeDir).sort();
}


// ─── The reading pass ─────────────────────────────────────────────────────────

/**
 * One call per chapter, in reading order, and every chapter is shown the **record query** built from
 * this volume's open reference record — never a markdown reference file (plan 06 slice 2, 2026-10-14).
 */
async function scenarioOneCallPerChapterWithTheRecordQuery() {
  const series = fixtureReadingSeries("reading-per-chapter");
  await sealVolumeOne(series);

  const bundle = await bundleOf(series, 1);
  const result = await readVolume(series);

  assert.ok(result.ok, JSON.stringify(result.refusal));
  assert.strictEqual(result.chapters.length, bundle.segments.length, `one entry per chapter (${bundle.segments.length})`);

  const labels = series.calls.map((c) => c.label);
  assert.deepStrictEqual(
    labels,
    bundle.segments.map((s) => `character-voice-extract-02-${s.id}`),
    "one call per chapter, in reading order, named after the chapter it read"
  );

  for (const call of series.calls) {
    const shown = call.messages.filter((m) => m && typeof m.text === "string" && m.text.startsWith("File: ")).map((m) => m.text);
    assert.ok(
      !shown.some((t) => t.startsWith("File: character-voice-")),
      `chapter ${call.label}: no character-voice document is inlined into a chapter call any more`
    );
    assert.ok(
      call.messages.some((m) => m && typeof m.text === "string" && m.text.startsWith(KNOWN_FACTS_HEADING)),
      `chapter ${call.label}: it is shown the record query block, which is where the earlier volumes' claims reach it now`
    );
  }

  // The later chapters are told what the earlier ones already produced — the substitute for the
  // in-progress reference the stage would have shown them.
  const later = series.calls[series.calls.length - 1];
  const note = later.messages.find((m) => m && typeof m.text === "string" && m.text.startsWith("## Already extracted in volume 02"));
  assert.ok(note, "the last chapter is shown the list of what this volume's earlier chapters produced");
  assert.ok(note.text.includes("如月雨露"), "and the list names the characters, not just a count");
  const first = series.calls[0];
  assert.ok(
    !first.messages.some((m) => m && typeof m.text === "string" && m.text.startsWith("## Already extracted in volume 02")),
    "the first chapter has nothing to be told"
  );

  const volDir = series.volumes[1].dir;
  const names = filesIn(volDir);
  assert.ok(names.includes(ev.EXTRACTION_FILE), "the notebook is written");
  for (const segment of bundle.segments) {
    assert.ok(names.includes(`${ev.PARTIAL_PREFIX}${segment.id}.json`), `a partial for ${segment.id}`);
  }
  assert.ok(!names.includes("character-voice.md"), "the reading pass does not write the reference it feeds");
  assert.ok(!names.includes("pov-map.md"), "and it does not write the POV map either");

  const notebook = JSON.parse(fs.readFileSync(path.join(volDir, ev.EXTRACTION_FILE), "utf8"));
  assert.strictEqual(notebook.length, bundle.segments.length, "the notebook is every chapter's claims, in reading order");

  const store = rs.openReferenceStore({ volume: 2, folder: series.volumes[1].folder, seriesDir: series.dir, stage: rs.EXTRACTION_SOURCE_STAGE });
  try {
    assert.strictEqual(rs.isVolumeSealed(store, 2), false, "the record is opened and filed, and it is NOT sealed: nothing was published");
    const carried = store.db.prepare("SELECT COUNT(*) AS n FROM copy_provenance WHERE volume = 2").get().n;
    assert.ok(carried > 0, "volume 01's sealed record was carried in before a single chapter was read");
    const filed = store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE owner_volume = 2 AND source_stage = 'extract'").get().n;
    assert.strictEqual(filed, notebook.length, "every claim that verified is filed as this volume's extraction");
  } finally {
    store.close();
  }

  console.log("extract-voice: one call per chapter, the record's own claims about this chapter's cast shown to all of them, the artifact left unwritten");
}


/**
 * A pass that died halfway is finished, not re-paid for.
 */
async function scenarioResumeCostsNothing() {
  const series = fixtureReadingSeries("reading-resume");
  await sealVolumeOne(series);
  const bundle = await bundleOf(series, 1);

  const first = await readVolume(series);
  assert.ok(first.ok);
  const firstCalls = series.calls.length;
  assert.strictEqual(firstCalls, bundle.segments.length);
  const notebookFirst = fs.readFileSync(path.join(series.volumes[1].dir, ev.EXTRACTION_FILE), "utf8");

  const again = await readVolume(series);
  assert.ok(again.ok);
  assert.strictEqual(series.calls.length, firstCalls, "the second invocation asked the model nothing — every chapter was reused");
  assert.ok(again.chapters.every((c) => c.reused), "and it says so chapter by chapter");
  assert.strictEqual(fs.readFileSync(path.join(series.volumes[1].dir, ev.EXTRACTION_FILE), "utf8"), notebookFirst, "the notebook is byte-identical");

  // --force is the only way to pay for a chapter twice.
  const forced = await readVolume(series, { force: true });
  assert.ok(forced.ok);
  assert.strictEqual(series.calls.length, firstCalls * 2, "--force re-reads them, and only --force");

  console.log("extract-voice: a second invocation reuses every chapter already read, and --force is the only way to re-pay");
}


/**
 * A chapter whose text changed is re-read; the chapters that did not are not.
 */
async function scenarioAChangedChapterIsReReadAlone() {
  const series = fixtureReadingSeries("reading-changed-chapter");
  await sealVolumeOne(series);
  const bundle = await bundleOf(series, 1);

  await readVolume(series);
  const firstCalls = series.calls.length;

  const target = bundle.segments[1];
  const targetPath = path.join(series.volumes[1].dir, target.file);
  fs.appendFileSync(targetPath, "\n如月雨露はもう一度「気にすんな！」と言った。\n", "utf8");

  const result = await readVolume(series);
  assert.ok(result.ok);
  assert.strictEqual(series.calls.length, firstCalls + 1, "exactly one chapter was paid for again");
  const reRead = result.chapters.filter((c) => !c.reused);
  assert.strictEqual(reRead.length, 1);
  assert.strictEqual(reRead[0].id, target.id, "and it is the chapter whose text changed");

  console.log("extract-voice: a partial is only reused for the chapter text it came from");
}


/**
 * A volume whose record is sealed is refused — before any call is made. Volume 01 of the real series
 * is sealed; this is the guard that keeps this command out of it.
 */
async function scenarioASealedVolumeIsRefused() {
  const series = fixtureReadingSeries("reading-sealed");
  await sealVolumeOne(series);

  const first = await readVolume(series);
  assert.ok(first.ok, "an unsealed volume is readable");
  const callsAfterFirst = series.calls.length;

  // Publish volume 02 the way the route publishes it, then try to read it again.
  const store = rs.openReferenceStore({ volume: 2, folder: series.volumes[1].folder, seriesDir: series.dir, stage: rs.EXTRACTION_SOURCE_STAGE });
  store.sealVolume(2);
  store.close();

  const refused = await readVolume(series);
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.refusal.rule, "extract-volume-sealed");
  assert.match(refused.refusal.because, /sealed/, "and the refusal says why");
  assert.strictEqual(series.calls.length, callsAfterFirst, "the refusal cost no model call");
  assert.strictEqual(refused.entries, 0, "and it filed nothing");

  console.log("extract-voice: a volume whose record is sealed is refused before a single chapter is read");
}


/**
 * The evidence rule is not bypassed by a route that has no author agent in it.
 */
async function scenarioClaimsWithoutEvidenceAreRefusedAndNamed() {
  const series = fixtureReadingSeries("reading-evidence");
  await sealVolumeOne(series);
  const bundle = await bundleOf(series, 1);
  stubHarness(series.calls, { unverifiable: true });

  const result = await readVolume(series);
  assert.ok(result.ok, "the notebook is still complete — a refused claim is not a failed read");
  assert.strictEqual(result.chapters.length, bundle.segments.length);
  assert.ok(result.refusedClaims.length >= bundle.segments.length, "every claim was refused, and each one is named");
  assert.ok(result.refusedClaims.every((r) => r.because), "with a reason");

  const store = rs.openReferenceStore({ volume: 2, folder: series.volumes[1].folder, seriesDir: series.dir, stage: rs.EXTRACTION_SOURCE_STAGE });
  try {
    const filed = store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE owner_volume = 2 AND source_stage = 'extract'").get().n;
    assert.strictEqual(filed, 0, "and none of them reached the record");
  } finally {
    store.close();
  }

  console.log("extract-voice: a claim whose quote this volume does not print is refused and named, exactly as in the stage");
}


/**
 * The real volume 02 failure, planted: chapter ch2's answer was valid except for one claim with a
 * comma missing between two properties. A whole chapter lost to one malformed claim is twenty claims
 * paid for and thrown away, so the pass reads the array claim by claim, keeps what parses, and names
 * what it could not read — and keeps the answer itself beside the partial.
 */
async function scenarioAMalformedClaimDoesNotCostTheChapterTheRest() {
  const series = fixtureReadingSeries("reading-malformed");
  await sealVolumeOne(series);
  const bundle = await bundleOf(series, 1);
  stubHarness(series.calls, { malformed: true });

  const result = await readVolume(series);
  assert.ok(result.ok, "the pass is not cancelled by one malformed claim");

  const notebook = JSON.parse(fs.readFileSync(path.join(series.volumes[1].dir, ev.EXTRACTION_FILE), "utf8"));
  assert.strictEqual(notebook.length, bundle.segments.length * 2, "two of the three claims per chapter survived");

  const partial = JSON.parse(fs.readFileSync(ev.partialPath(series.volumes[1].dir, bundle.segments[0].id), "utf8"));
  assert.ok(partial.parseError, "the partial says the answer did not parse as a whole");
  assert.strictEqual(partial.cutOff, false, "and says it was malformed, not cut off");
  assert.strictEqual(partial.lostClaims.length, 1, "one claim was dropped");
  assert.match(partial.lostClaims[0].because, /Expected ',' or '\}' after property value/, "with the parse error that dropped it");
  assert.ok(partial.rawAnswer.includes("formalityLevel"), "and the answer it could not read is kept, so it can be re-read without paying for the chapter again");

  // A named loss is paid for, not just recorded. The chapter closed its array cleanly and still lost a
  // claim, and the reading pass re-read it once more for that claim — the same budget a cut-off answer
  // gets, and no more.
  assert.strictEqual(partial.attempts.length, ev.MAX_ATTEMPTS_PER_CHAPTER, "a closed array that lost a claim is re-read, like a cut-off one");
  assert.strictEqual(partial.attempts[1].claims, partial.attempts[0].claims, "and the re-read losing the same claim does not make the chapter worse");
  const asked = series.calls.filter((c) => c.label.endsWith(`-${bundle.segments[0].id}`)).length;
  assert.strictEqual(asked, ev.MAX_ATTEMPTS_PER_CHAPTER, `the chapter was asked exactly ${ev.MAX_ATTEMPTS_PER_CHAPTER} times, not once: ${asked}`);

  const store = rs.openReferenceStore({ volume: 2, folder: series.volumes[1].folder, seriesDir: series.dir, stage: rs.EXTRACTION_SOURCE_STAGE });
  try {
    const filed = store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE owner_volume = 2 AND source_stage = 'extract'").get().n;
    assert.strictEqual(filed, notebook.length, "a recovered claim still goes through the evidence rule like any other");
  } finally {
    store.close();
  }

  console.log("extract-voice: one malformed claim costs that claim, not the chapter, and the answer it could not read is kept");
}


/**
 * The record door is the pipeline's own: carrying the previous volume in, and reading this volume's
 * published glossary into its record so the roster is whole.
 */
async function scenarioTheRecordDoorIsThePipelineDoor() {
  const series = fixtureReadingSeries("reading-record-door");
  await sealVolumeOne(series);
  // Volume 02 has a published glossary and, before this command, no record of its own.
  fs.writeFileSync(path.join(series.volumes[1].dir, "glossary.md"), GLOSSARY_02, "utf8");

  const result = await readVolume(series);
  assert.ok(result.ok, JSON.stringify(result.refusal));

  const carried = result.record.carried;
  assert.ok(carried, "volume 01's sealed record was carried in");
  assert.ok(carried.provenance.copiedRows.facts > 0, "with its rows, not just its name");
  assert.ok(carried.provenance.copiedRows.cast > 0, "and its roster");

  const backfill = result.record.glossaryBackfill;
  assert.ok(backfill.ran, "this volume's own glossary.md was read into its record");
  assert.ok(backfill.imported > 0, "and the row only this volume's text prints became a new row");
  assert.ok(backfill.carried > 0, "while the rows volume 01 already brought stayed where they were");
  assert.ok(backfill.castRegistered > 0, "and it is what registered the roster the coverage rule asks about");

  console.log("extract-voice: the volume's record is opened through openVolumeRecord — carry-forward, glossary completeness, roster fold");
}


/**
 * `--dry-run` previews and writes nothing into the volume folder, and `--list` is not a run either.
 */
async function scenarioDryRunAndListTouchNothing() {
  const series = fixtureReadingSeries("reading-dry-run");
  await sealVolumeOne(series);

  const preview = await readVolume(series, { dryRun: true });
  assert.ok(preview.ok);
  assert.strictEqual(series.calls.length, 0, "no model call");
  const after = filesIn(series.volumes[1].dir);
  const wrote = after.filter((n) => /^character-voice/.test(n) || /^series\.db/.test(n));
  assert.deepStrictEqual(wrote, [], "and the volume folder gained no notebook, no partial, no record");
  assert.strictEqual(preview.extractionFile, null);

  assert.deepStrictEqual(ev.readArgs(["--volume=02", "--dry-run"]), { volume: "02", series: null, dryRun: true, force: false, chapters: [], list: false, error: null });
  assert.strictEqual(ev.readArgs(["--volume=02", "--wat"]).error, "unrecognised flag: --wat", "an unknown flag is refused, not ignored");
  assert.deepStrictEqual(
    ev.readArgs(["--volume=02", "--chapter=ch4", "--chapter=ch5"]).chapters,
    ["ch4", "ch5"],
    "--chapter is repeatable, and it names chapters rather than a whole volume"
  );
  assert.ok(
    /contradict/.test(ev.readArgs(["--volume=02", "--chapter=ch4", "--force"]).error || ""),
    "--chapter and --force are refused together rather than silently resolved"
  );

  console.log("extract-voice: --dry-run previews the prompts and writes nothing into the volume folder");
}


// ─── A cut-off chapter ────────────────────────────────────────────────────────

/**
 * An answer whose array never closed is half an answer, and the pass does not accept it.
 *
 * The real volume 02 failure, reproduced: a chapter came back cut off with 6 claims for 33,541
 * characters of text, and the pass kept it. Here the same chapter is re-read at the retry level, the
 * re-read's answer is the one the notebook gets, and the partial says which level produced what.
 */
async function scenarioACutOffChapterIsRetriedAndTheBetterAnswerWins() {
  const series = fixtureReadingSeries("reading-cut-off");
  await sealVolumeOne(series);
  const bundle = await bundleOf(series, 1);
  const target = bundle.segments[1].id;
  stubHarness(series.calls, { cutOffChapter: target });

  const result = await readVolume(series);
  assert.ok(result.ok, "a cut-off chapter does not stop the pass — it is re-read");

  const forChapter = series.calls.filter((c) => c.label.endsWith(`-${target}`));
  assert.strictEqual(forChapter.length, 2, "the chapter is paid for twice: the run's level, then the retry level");
  assert.strictEqual(forChapter[0].thinkingLevel, undefined, "the first attempt runs at the run's own level");
  assert.strictEqual(forChapter[1].thinkingLevel, ev.EXTRACTION_RETRY_THINKING_LEVEL, "the retry names the level it ran at, in the call itself");

  const otherChapters = series.calls.filter((c) => !c.label.endsWith(`-${target}`));
  assert.strictEqual(otherChapters.length, bundle.segments.length - 1, "every other chapter is read once");

  const partial = JSON.parse(fs.readFileSync(path.join(series.volumes[1].dir, `${ev.PARTIAL_PREFIX}${target}.json`), "utf8"));
  assert.strictEqual(partial.attempts.length, 2, "the partial records both paid reads");
  assert.strictEqual(partial.attempts[0].cutOff, true, "and it records that the first one was cut off");
  assert.strictEqual(partial.cutOff, false, "the answer the volume kept is the complete one");
  assert.strictEqual(partial.entries.length, 4, "the re-read's answer is the one that won");

  const kept = result.chapters.find((c) => c.id === target);
  assert.strictEqual(kept.incomplete, false, "a chapter that was fixed by its re-read is not reported as incomplete");
  assert.deepStrictEqual(result.incompleteChapters, [], "and nothing is named as incomplete");

  console.log("extract-voice: a cut-off chapter is detected, re-read at the retry level, and the better answer wins");
}


/**
 * A chapter still cut off after both paid reads is kept, named, and said out loud — in the log, in
 * the partial, in the exit code, and in the report the grader reads.
 *
 * Refusing the whole volume for one stubborn chapter would make the volume unfinishable; accepting it
 * quietly is the failure this file exists for. The middle path is a volume that says what it is.
 */
async function scenarioAChapterStillCutOffIsNamedNotHidden() {
  const series = fixtureReadingSeries("reading-still-cut-off");
  await sealVolumeOne(series);
  stubHarness(series.calls, { alwaysCutOff: true });

  const result = await readVolume(series);
  assert.ok(result.ok, "the pass completes — a cut-off chapter is kept, not a reason to abandon the volume");

  const paid = series.calls.length;
  assert.strictEqual(paid, 12, "two paid reads for each of six chapters, and no third attempt");

  assert.strictEqual(result.incompleteChapters.length, 6, "every chapter is named as incomplete");
  for (const chapter of result.chapters) {
    assert.strictEqual(chapter.paidReads, 2, `${chapter.id}: the budget is two reads, not a loop`);
    assert.strictEqual(chapter.incomplete, true);
  }

  const reportFile = path.join(series.volumes[1].dir, "character-voice-reading.md");
  assert.ok(fs.existsSync(reportFile), "and the volume carries a report saying how it was read");
  const report = fs.readFileSync(reportFile, "utf8");
  assert.ok(report.includes("INCOMPLETE"), "the report names the incomplete chapters");
  assert.ok(report.includes("cut off"), "and says what cut off means: the rest was never written");

  console.log("extract-voice: a chapter still cut off after both reads is kept and named, not hidden");
}


/**
 * Re-reading one chapter is a named capability, not a workaround involving deleting a file.
 *
 * The operator's move after a volume is assembled from a thin chapter is to read that chapter again —
 * one chapter, one call, the rest of the volume reused for free.
 */
async function scenarioOneChapterCanBeReReadByName() {
  const series = fixtureReadingSeries("reading-one-chapter");
  await sealVolumeOne(series);
  const bundle = await bundleOf(series, 1);
  stubHarness(series.calls);

  const first = await readVolume(series);
  assert.ok(first.ok);
  const firstCalls = series.calls.length;
  assert.strictEqual(firstCalls, bundle.segments.length, "the first pass pays once per chapter");

  const target = bundle.segments[2].id;
  const again = await readVolume(series, { chapters: [target] });
  assert.ok(again.ok);
  assert.strictEqual(series.calls.length - firstCalls, 1, "one chapter named means exactly one new call");
  const reused = again.chapters.filter((c) => c.reused).length;
  assert.strictEqual(reused, bundle.segments.length - 1, "every other chapter is reused and costs nothing");

  const unknown = await readVolume(series, { chapters: ["chapter-that-does-not-exist"] });
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.refusal.rule, "unknown-chapter", "a name that is not a chapter here is refused, not ignored");
  assert.ok(unknown.refusal.fix.includes(target), "and the refusal names the chapters that do exist");
  assert.strictEqual(series.calls.length - firstCalls, 1, "a refused chapter name costs nothing");

  console.log("extract-voice: --chapter=<id> re-reads exactly one chapter and reuses the rest for free");
}


/**
 * A partial from the older shape cannot say whether its answer was complete, so it is not trusted.
 *
 * Volume 02's first pass wrote schema-1 partials, three of which hold cut-off answers. A resume that
 * accepted them would reuse half an answer forever.
 */
async function scenarioAnOlderPartialIsReReadRatherThanTrusted() {
  const series = fixtureReadingSeries("reading-old-partial");
  await sealVolumeOne(series);
  const bundle = await bundleOf(series, 1);
  const seg = bundle.segments[0];
  const file = path.join(series.volumes[1].dir, `${ev.PARTIAL_PREFIX}${seg.id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ schema: 1, volume: "02", segmentId: seg.id, segmentFile: seg.file, sourceSha: ev.segmentFingerprint(path.join(series.volumes[1].dir, seg.file)), entries: [] }, null, 2),
    "utf8"
  );
  stubHarness(series.calls);

  const partial = ev.readPartial(series.volumes[1].dir, seg, ev.segmentFingerprint(path.join(series.volumes[1].dir, seg.file)));
  assert.strictEqual(partial.usable, false);
  assert.ok(/schema 2/.test(partial.because), "the refusal says what is missing: the shape cannot say whether the answer closed");

  const result = await readVolume(series);
  assert.ok(result.ok);
  assert.strictEqual(series.calls.length, bundle.segments.length, "the old partial is re-read, and every other chapter is still read once");

  console.log("extract-voice: a schema-1 partial is re-read rather than trusted, because it cannot say it was complete");
}


/**
 * A chapter that cost two paid reads is still named in the report on the pass that follows — the pass
 * that paid for nothing.
 *
 * The report is one of the three files the acceptance grader is handed. Its old trigger was "this pass
 * paid for a re-read", so the moment a volume was re-run after its chapters had already been read, every
 * chapter was reused, `paidReads` was 0 for all of them, and the block disappeared. Measured on the real
 * volume 02 on 2026-10-12: after its two cut-off chapters were re-read and the stage ran again, the
 * grader was shown a reference whose most expensive chapters had each taken two reads, with nothing in its
 * materials saying so. The trigger is now the paid reads **recorded on the chapter**, whoever paid for them.
 *
 * @returns {Promise<void>}
 */
async function scenarioAChapterThatTookTwoReadsIsStillNamedOnTheNextPass() {
  const series = fixtureReadingSeries("reading-report-after-resume");
  await sealVolumeOne(series);
  const bundle = await bundleOf(series, 1);
  const target = bundle.segments[1].id;
  stubHarness(series.calls, { cutOffChapter: target });

  const first = await readVolume(series);
  assert.ok(first.ok);
  const paidFirst = series.calls.length;
  assert.strictEqual(paidFirst, bundle.segments.length + 1, `one chapter took two paid reads and the rest one: ${paidFirst}`);

  const reportFile = path.join(series.volumes[1].dir, "character-voice-reading.md");
  const firstReport = fs.readFileSync(reportFile, "utf8");
  assert.ok(firstReport.includes("came back whole"), "the re-read closed the array, so nothing is left incomplete");

  const again = await readVolume(series);
  assert.ok(again.ok);
  assert.strictEqual(series.calls.length, paidFirst, "the second pass makes no call at all");
  assert.strictEqual(again.incompleteChapters.length, 0, JSON.stringify(again.chapters));
  assert.ok(again.chapters.every((c) => c.reused), "every chapter is reused");

  const secondReport = fs.readFileSync(reportFile, "utf8");
  assert.ok(secondReport.includes(target), `the report still names the chapter that cost two reads: ${secondReport}`);
  assert.ok(secondReport.includes("paid for in an earlier pass"), `and it says who paid for them: ${secondReport}`);
  assert.ok(secondReport.includes("(cut off)"), "and the read that never closed is still visible");

  // The other half: a volume whose every chapter closed on its first read has nothing to say.
  const quiet = ev.readingReport(
    [{ id: "ch1", claims: 3, reused: true, paidReads: 0, attempts: [{ thinkingLevel: null, claims: 3, cutOff: false }] }],
    { volume: 2 }
  );
  assert.strictEqual(quiet, "", "a clean reading history produces no block");

  console.log("extract-voice: a chapter that took two reads stays in the report after the volume is re-run for free");
}


/**
 * The command is reachable only by typing it: nothing in the pipeline requires it, and importing it
 * does not start a run.
 */
function scenarioItIsNotPartOfARun() {
  const source = fs.readFileSync(path.join(__dirname, "..", "extract-voice.js"), "utf8");
  assert.ok(!/require\(["']\.\.\/extract-voice["']\)/.test(source), "nothing requires it from inside itself");

  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index", "steps.js"), "utf8");
  assert.ok(!indexSource.includes("extract-voice"), "it is not one of the pipeline's stages");

  const stageSource = fs.readFileSync(path.join(__dirname, "..", "character-voice", "task.js"), "utf8");
  // The stage may NAME the command in the fix it tells an operator to run; what it may not do is
  // reach it. A require is the difference between a suggestion and a step.
  assert.ok(!/require\(["']\.\/extract-voice["']\)|require\(["']\.\.\/extract-voice["']\)/.test(stageSource), "and the voice stage does not call it");

  assert.ok(/require\.main === module/.test(source), "importing it does not start it");

  console.log("extract-voice: no stage, no pipeline entry, no run reaches it — the only way is typing the command");
}


(async () => {
  await scenarioOneCallPerChapterWithTheRecordQuery();
  await scenarioResumeCostsNothing();
  await scenarioAChangedChapterIsReReadAlone();
  await scenarioASealedVolumeIsRefused();
  await scenarioClaimsWithoutEvidenceAreRefusedAndNamed();
  await scenarioAMalformedClaimDoesNotCostTheChapterTheRest();
  await scenarioTheRecordDoorIsThePipelineDoor();
  await scenarioDryRunAndListTouchNothing();
  await scenarioACutOffChapterIsRetriedAndTheBetterAnswerWins();
  await scenarioAChapterStillCutOffIsNamedNotHidden();
  await scenarioOneChapterCanBeReReadByName();
  await scenarioAnOlderPartialIsReReadRatherThanTrusted();
  await scenarioAChapterThatTookTwoReadsIsStillNamedOnTheNextPass();
  scenarioItIsNotPartOfARun();
  console.log("\nextract-voice: all scenarios passed");
})().catch((err) => {
  console.error("extract-voice test FAILED:", err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});

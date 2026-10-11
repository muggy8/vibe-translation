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
 *   - one call per chapter, in reading order, and the previous volume's reference shown to **every**
 *     chapter (the route has no in-progress document to show, and the difference is asserted on the
 *     messages, not assumed);
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
delete process.env.GLOSSARY_STORE_VALIDATORS;
delete process.env.VOICE_STORE_VALIDATORS;

require("./test-home"); // the run's records get a throwaway home (gotcha 69)

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const harness = require("../harness");
const rs = require("../utils/reference-store");
const { resolveSourceBundle } = require("../utils/source");
const ev = require("../extract-voice");
const { GLOSSARY_01, VOICE_01, FIXTURES_ROOT } = require("./fixture-reference-store");

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
  "| 三色院菫子 | Sanshokuin Sumireko | Library committee |",
  "| 三色院菫子 | Sanshokuin Sumireko | Library committee |\n| 駱駝 | Rakuda | Named in the afterword |"
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
function stubHarness(calls, { unverifiable = false, malformed = false } = {}) {
  harness.runOneShot = async ({ systemPrompt, messages, label }) => {
    const fileMessage = messages.find((m) => m && m.file);
    const text = fileMessage ? fs.readFileSync(fileMessage.file, "utf8") : "";
    const line = (text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))[0] || "").trim();
    calls.push({ label, messages });
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
 * @param {{volume?: string, force?: boolean, dryRun?: boolean}} [opts]
 * @returns {Promise<Object>}
 */
function readVolume(series, opts = {}) {
  return ev.runExtractPass({
    seriesDir: series.dir,
    volumeArg: opts.volume || "02",
    dryRun: Boolean(opts.dryRun),
    force: Boolean(opts.force),
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
 * One call per chapter, in reading order, and every chapter is shown the previous volume's
 * reference — because in this route that is the only cumulative reference that exists.
 */
async function scenarioOneCallPerChapterWithThePreviousReference() {
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
      shown.some((t) => t.startsWith("File: character-voice-previous.md")),
      `chapter ${call.label}: the previous volume's reference is the cumulative material it is shown`
    );
    assert.ok(
      !shown.some((t) => t.startsWith("File: character-voice-current.md")),
      `chapter ${call.label}: there is no in-progress document in this route, and none is invented`
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

  console.log("extract-voice: one call per chapter, the previous volume's reference shown to all of them, the artifact left unwritten");
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

  assert.deepStrictEqual(ev.readArgs(["--volume=02", "--dry-run"]), { volume: "02", series: null, dryRun: true, force: false, list: false, error: null });
  assert.strictEqual(ev.readArgs(["--volume=02", "--wat"]).error, "unrecognised flag: --wat", "an unknown flag is refused, not ignored");

  console.log("extract-voice: --dry-run previews the prompts and writes nothing into the volume folder");
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
  assert.ok(!stageSource.includes("extract-voice"), "and the voice stage does not call it");

  assert.ok(/require\.main === module/.test(source), "importing it does not start it");

  console.log("extract-voice: no stage, no pipeline entry, no run reaches it — the only way is typing the command");
}


(async () => {
  await scenarioOneCallPerChapterWithThePreviousReference();
  await scenarioResumeCostsNothing();
  await scenarioAChangedChapterIsReReadAlone();
  await scenarioASealedVolumeIsRefused();
  await scenarioClaimsWithoutEvidenceAreRefusedAndNamed();
  await scenarioAMalformedClaimDoesNotCostTheChapterTheRest();
  await scenarioTheRecordDoorIsThePipelineDoor();
  await scenarioDryRunAndListTouchNothing();
  scenarioItIsNotPartOfARun();
  console.log("\nextract-voice: all scenarios passed");
})().catch((err) => {
  console.error("extract-voice test FAILED:", err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
});

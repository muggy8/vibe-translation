#!/usr/bin/env node
/**
 * test/test-glossary-reading-block.js — the readings the BOOK printed reach the pass that chooses how a
 * term is written, and the four ways there is nothing to show stay four different facts.
 *
 * The defect (plan 08 §2.2, measured 0 model calls): 亜茶花 is guided **あさか 32 times across volumes 3,
 * 7, 9, 13, 14 and 16**. Volume 3 published it as "Atsuka" with the note "the reading was inferred". In
 * volume 3's extracted text the term appears exactly once, in chapter ch7.1 — the chapter that guides it
 * あさか. The extracted chapter files contain 0 `<ruby>` markup, because the converter takes the guides out
 * (gotcha 123, correctly). So the pass that chose the rendering was never shown the answer the book gave,
 * guessed from the spelling, guessed wrong, and volume 14 later paid a revision call to rediscover what had
 * been printed over the word since volume 3.
 *
 * The scenarios:
 *
 *   1. **A word guided two ways shows both readings.** One line, both readings, on the wire.
 *   2. **The guide answers what the pass would otherwise guess.** The form and its reading reach the
 *      messages the stub actually received, beside the chapter they were printed over.
 *   3. **A chapter with no guides gets a floor line** that says the book printed none — and how many the
 *      volume does print.
 *   4. **A volume with no harvest is named, not treated as an empty harvest.** A plain-text book and an
 *      epub whose harvest file is gone are two different sentences, and both reach the wire.
 *   5. **The cap truncates and names what it truncated** — the count, some of the names, and the fact that
 *      the rest still exist. And no environment variable moves the cap.
 *   6. **Never a later volume's harvest.** Volume 01's block is built from volume 01's harvest, and a guide
 *      that only volume 02 printed does not appear in it.
 *   7. **The whole-installment route shows every chapter it is being shown**, each under the same cap, and
 *      names the chapters that print nothing.
 *   8. **The answer shape, the two-paid-read budget and the read report are unmoved.** This slice adds a
 *      block to a call that already runs; it does not add a call, a shape, or a report section.
 *   9. **The block's own prose names no language and no script**, and the prompt file is byte-unchanged —
 *      the block is appended in code (AGENTS.md rule 6).
 *  10. **Nothing else moved**: no schema bump, no new table, no new finding kind, no new freeze door, no new
 *      command, no new setting, and the store still has exactly one door that opens a harvest file.
 *
 * Fixtures only, under the suite's own fixture root. Nothing here reads the real 17 volumes or any file
 * under the series folder (AGENTS.md rule 8, gotcha 69). 0 model calls against any endpoint: every read
 * pass runs behind a stub.
 *
 * Run with `npm test`, or standalone: `node test/test-glossary-reading-block.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const harness = require("../harness");
const { readModuleLayer } = require("./module-layer");
const { fixtureStoreSeries, assertInsideFixture } = require("./fixture-reference-store");
const { extractChapterTerms } = require("../glossary/chunked");
const { extractNewTerms } = require("../glossary/task");
const {
  termsResponseFormat,
  extractionReadReport,
  EXTRACTION_MAX_ATTEMPTS,
  EXTRACTION_RETRY_THINKING_LEVEL,
  READING_BLOCK_MAX_LINES,
  READING_BLOCK_NAMED_OMITTED,
  READING_BLOCK_NOTE_MAX_CHARS,
  READING_BLOCK_HEADING,
  READING_BLOCK_HEADING_VOLUME,
  chapterReadingLines,
  buildReadingBlock,
  readVolumeReadingAids,
  loadReadingAids,
  readingBlockTruncationNote,
} = require("../glossary/extract");
const { SCHEMA_VERSION, COUNTED_TABLES } = require("../utils/reference-store");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { FREEZE_DOORS } = require("../utils/prereqs/freeze");

/** The fixture's two guided words, chosen so the multiplicity case is the interesting one. */
const FORM_TWO_WAYS = "三色院菫子";
const READING_ORDINARY = "さんしよくいんすみれこ";
const READING_NAME = "パンジー";

/** The fixture's stand-in for 亜茶花: a spelling whose reading the pass would otherwise guess. */
const GUESSED_FORM = "亜茶花";
const GUIDED_READING = "あさか";

/** A word only volume 02's book guides, which volume 01 must never be shown. */
const LATER_VOLUME_FORM = "駱駝";

let checks = 0;
/**
 * Count one assertion and run it.
 *
 * @param {boolean|void} condition
 * @param {string} message
 * @returns {void}
 */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}
/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} message
 * @returns {void}
 */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

/**
 * One harvest row, in the shape `utils/source/ruby-guides.js` writes.
 *
 * @param {string} word
 * @param {string} reading
 * @param {number} count
 * @param {string[]} chapters
 * @returns {{word: string, reading: string, count: number, readingScript: string, chapters: string[], annotated: Array<{base:string,reading:string}>}}
 */
function guide(word, reading, count, chapters) {
  return {
    word,
    reading,
    count,
    readingScript: "other",
    chapters,
    annotated: [{ base: word, reading }],
  };
}

/**
 * Write a volume's harvest the way the extraction writes it.
 *
 * @param {string} volumeDir
 * @param {string} base
 * @param {Array<Object>} guides
 * @returns {string} The file name.
 */
function writeHarvest(volumeDir, base, guides) {
  const file = `${base}-ruby-guides.json`;
  fs.writeFileSync(
    path.join(volumeDir, file),
    JSON.stringify(
      {
        schema: 2,
        whatThisIs: "fixture harvest",
        generatedBy: "test/test-glossary-reading-block.js",
        sourceFile: `${base}.epub`,
        totals: { guides: guides.length, rows: guides.length, chapters: 1 },
        guides,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return file;
}

/**
 * The bundle object the two reading routes actually read: `base`, `format`, `segments`.
 *
 * @param {Object} volume - One entry from `fixtureStoreSeries`.
 * @param {{format?: string}} [overrides]
 * @returns {Object}
 */
function bundleFor(volume, overrides = {}) {
  const meta = JSON.parse(fs.readFileSync(path.join(volume.dir, `${volume.base}-bundle.meta.json`), "utf8"));
  return {
    format: overrides.format || meta.format,
    base: overrides.base === undefined ? meta.base : overrides.base,
    volumeDir: volume.dir,
    wholePath: path.join(volume.dir, meta.wholeFile),
    wholeFile: meta.wholeFile,
    segments: meta.segments,
    wholeChars: meta.segments.reduce((sum, s) => sum + s.chars, 0),
    sourceFingerprint: "fixture",
    rubyGuidesPath: null,
    rubyGuides: null,
  };
}

/**
 * The volume context the chapter pass needs, with the fixture's harvest already on disk.
 *
 * @param {Object} fx - What `fixtureStoreSeries` returned.
 * @param {number} index - Which fixture volume (0 or 1).
 * @param {Object} [bundle] - A bundle to hand the pass instead of the fixture's own.
 * @returns {Object}
 */
function glossaryCtx(fx, index, bundle) {
  const volume = fx.volumes[index];
  return {
    values: { INSTALLMENT_NUMBER: volume.installmentNumber, SERIES_NAME: "Test Story" },
    folderName: volume.folder,
    seriesDir: fx.dir,
    volumeDir: volume.dir,
    bundle: bundle || bundleFor(volume),
    sourceFile: path.join(volume.dir, `${volume.base}-whole.md`),
    glossaryOutputFile: path.join(volume.dir, "glossary.md"),
    previousGlossaryFile: null,
    isFirst: true,
    termsPrompt: "Volume being processed: 01",
    termsSystemPrompt: "You are a **Terminology Extraction Specialist**.",
    extractionReads: [],
  };
}

/**
 * Stand in for the model and record every request exactly as the stage built it.
 *
 * @param {Array<Object>} calls - Filled with one entry per paid read.
 * @param {Function} body - The code to run while the model is replaced.
 * @returns {Promise<*>} Whatever `body` returned.
 */
async function withStubbedModel(calls, body) {
  const original = harness.runOneShot;
  harness.runOneShot = async (opts) => {
    calls.push(opts);
    return JSON.stringify({ terms: [], revisions: [] });
  };
  try {
    return await body();
  } finally {
    harness.runOneShot = original;
  }
}

/**
 * The text of every message a recorded request carried, in order.
 *
 * The point of the helper: a block a builder function returns is not a block the model was shown. Only
 * what reaches `messages` counts.
 *
 * @param {Object} call - One recorded `harness.runOneShot` options object.
 * @returns {string}
 */
function wireText(call) {
  return (call.messages || [])
    .map((message) => (message && message.text) || (message && message.name) || "")
    .join("\n");
}

/**
 * The block's own prose: every line that is not a table line, a chapter sub-heading, or blank.
 *
 * Split out because the rule "the block prints no character of any one script in its own prose" is about
 * the sentences this file writes, not about the words of the book it is tabulating — and a fixture whose
 * book is written in one script must not be mistaken for prose in that script.
 *
 * @param {string} text
 * @returns {string[]}
 */
function proseLines(text) {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("  ") && !line.startsWith("### "));
}

/**
 * The fixture series, with volume 01's harvest planted.
 *
 * Volume 01 guides: 三色院菫子 two ways in ch1, 亜茶花 once in ch1, and nothing at all in ch0.
 * Volume 02 guides 駱駝 in its own chapter, and volume 01 must never see it.
 *
 * @param {string} label
 * @returns {Object} The fixture, with the harvest file names recorded on it.
 */
function fixtureWithHarvests(label) {
  const fx = fixtureStoreSeries(label);
  assertInsideFixture(fx.volumes[0].dir, fx.dir);
  assertInsideFixture(fx.volumes[1].dir, fx.dir);
  fx.harvest01 = writeHarvest(fx.volumes[0].dir, fx.volumes[0].base, [
    guide(FORM_TWO_WAYS, READING_ORDINARY, 3, ["ch1"]),
    guide(FORM_TWO_WAYS, READING_NAME, 2, ["ch1"]),
    guide(GUESSED_FORM, GUIDED_READING, 1, ["ch1"]),
  ]);
  fx.harvest02 = writeHarvest(fx.volumes[1].dir, fx.volumes[1].base, [
    guide(LATER_VOLUME_FORM, "らくだ", 4, ["ch0"]),
  ]);
  return fx;
}

// ─── Scenario 1 ───────────────────────────────────────────────────────────────

/**
 * A word the book guides two ways is shown with both readings, on one line, on the wire.
 *
 * Multiplicity is the signal: 虹彩寺菫 guided こうさいじすみれ 95 times and パンジー 406 times is the same
 * written form carrying an ordinary pronunciation and a name, and a block that picked one would be the
 * pipeline deciding what the annotation means.
 *
 * @returns {Promise<void>}
 */
async function scenarioBothReadingsReachTheModel() {
  const fx = fixtureWithHarvests("reading-block-both-readings");
  const ctx = glossaryCtx(fx, 0);
  const segment = ctx.bundle.segments[1]; // ch1, the chapter that guides
  /** @type {Array<Object>} */
  const calls = [];
  await withStubbedModel(calls, () => extractChapterTerms(ctx, segment, 0));

  same(calls.length, 1, `the chapter paid ${calls.length} read(s); the block must not add a call`);
  const wire = wireText(calls[0]);
  const line = `${FORM_TWO_WAYS} → ${READING_ORDINARY} | ${READING_NAME}`;
  ok(wire.includes(line), `both readings are not on one line in what the model was shown:\n${wire.slice(0, 600)}`);
  ok(wire.includes(READING_ORDINARY) && wire.includes(READING_NAME), "one of the two readings never reached the wire");

  // The block is its own message, and it sits beside the chapter it describes.
  const messages = calls[0].messages;
  const blockIndex = messages.findIndex((message) => (message.text || "").includes(READING_BLOCK_HEADING));
  ok(blockIndex > 0, "the reading block is not a message of its own in the request");
  ok(messages[0].file && messages[blockIndex].text, "the reading block is not beside the chapter file it describes");
  // Three harvest rows in this chapter, two distinct written forms: a form guided two ways is ONE line.
  same(messages[blockIndex].text.split("\n").filter((l) => l.startsWith("  ")).length, 2,
    "a word guided two ways printed two lines instead of one line carrying both readings");

  // And the harvest was read once, not once per chapter.
  const again = glossaryCtx(fx, 0);
  same(again.readingAids, undefined, "a fresh volume context arrived with a harvest already loaded");
  await loadReadingAids(again);
  const first = again.readingAids;
  await loadReadingAids(again);
  ok(again.readingAids === first, "the harvest was read again for the second chapter instead of reused");

  console.log("1/10: a word guided two ways reaches the model with both readings, on one line, beside its chapter");
}

// ─── Scenario 2 ───────────────────────────────────────────────────────────────

/**
 * The guide answers the question the pass would otherwise guess at.
 *
 * This is the 亜茶花 shape: a spelling that invites a romanisation, and a reading the book printed over it.
 * The block has to carry BOTH the form and the reading, and has to say what to do with them — the guide is
 * not part of the word, so `term` stays the bare spelling and the reading is what answers the rendering.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheGuideAnswersWhatThePassWouldOtherwiseGuess() {
  const fx = fixtureWithHarvests("reading-block-guessed-reading");
  const ctx = glossaryCtx(fx, 0);
  const segment = ctx.bundle.segments[1];
  /** @type {Array<Object>} */
  const calls = [];
  await withStubbedModel(calls, () => extractChapterTerms(ctx, segment, 0));
  const wire = wireText(calls[0]);

  ok(wire.includes(`${GUESSED_FORM} → ${GUIDED_READING}`),
    `the reading the book printed over "${GUESSED_FORM}" is not on the wire — this is the "Atsuka" defect`);
  ok(wire.includes("A guide is not part of the word"),
    "the block does not say the guide is not part of the word, which is the rule the filing door enforces");
  ok(wire.includes(READING_BLOCK_HEADING), "the block carries no heading, so the model cannot tell it apart from the chapter");

  // The chapter's own text is still what the pass is asked about: the block is beside it, not a substitute.
  ok(calls[0].messages.some((message) => message.file), "the chapter file is no longer in the request");
  same(calls[0].messages.filter((message) => message.text && message.text.includes(READING_BLOCK_HEADING)).length, 1,
    "the reading block appears more than once in one request");

  console.log(`2/10: "${GUESSED_FORM} → ${GUIDED_READING}" is on the wire, with the rule that the guide is not the word`);
}

// ─── Scenario 3 ───────────────────────────────────────────────────────────────

/**
 * A chapter whose book prints no guides still gets a floor line, and it says so.
 *
 * "Nothing to show" must not look like "nothing was read" — the same distinction `readTermList` refuses to
 * collapse between `[]` and `failed: true` (gotcha 138). The floor line names how many guided words the
 * volume DOES print, so a reader can tell an empty chapter from an unharvested volume.
 *
 * @returns {Promise<void>}
 */
async function scenarioAChapterWithNoGuidesGetsTheFloorLine() {
  const fx = fixtureWithHarvests("reading-block-floor");
  const ctx = glossaryCtx(fx, 0);
  const segment = ctx.bundle.segments[0]; // ch0: the fixture harvest guides nothing here
  /** @type {Array<Object>} */
  const calls = [];
  await withStubbedModel(calls, () => extractChapterTerms(ctx, segment, 0));
  const wire = wireText(calls[0]);

  ok(wire.includes(READING_BLOCK_HEADING), "a chapter with nothing to show got no block at all");
  ok(/no pronunciation guides over any word/.test(wire), "the floor line does not say the chapter prints no guides");
  ok(wire.includes("3 guided word(s)"), "the floor line does not name how many guided words the volume does print");
  ok(!/→/.test(wire.split("\n").filter((l) => l.startsWith("  ")).join("\n")),
    "an empty chapter was shown a table it has no rows for");

  // The empty block is smaller than the shape explanation a full table carries: a floor is not a fee.
  const built = buildReadingBlock({ aids: await loadReadingAids(ctx), chapters: [segment] });
  const full = buildReadingBlock({ aids: await loadReadingAids(ctx), chapters: [ctx.bundle.segments[1]] });
  ok(built.chars < full.chars, `the floor line costs more than a table (${built.chars} vs ${full.chars})`);
  ok(built.text.length > 0, "the floor line is empty, which is the thing this scenario exists to refuse");

  console.log(`3/10: a chapter with no guides says so in ${built.chars} characters, and names the 3 the volume does print`);
}

// ─── Scenario 4 ───────────────────────────────────────────────────────────────

/**
 * A volume with no harvest file is NAMED, and a plain-text volume is named differently.
 *
 * `readRubyGuideFile` answers "there is no file here" with null. A door that folds that into `[]` reports a
 * zero it did not measure (the same trap `collectGuideGroupsFromVolumeFolders` names). The two absent cases
 * this repository actually has — a plain-text book, and an epub extracted before the harvest existed — get
 * two different sentences, and both sentences reach the wire.
 *
 * @returns {Promise<void>}
 */
async function scenarioAMissingHarvestIsNamedNotEmpty() {
  const fx = fixtureWithHarvests("reading-block-missing-harvest");
  const volume = fx.volumes[0];

  // (a) An epub whose harvest file is gone.
  fs.rmSync(path.join(volume.dir, fx.harvest01));
  const epubCtx = glossaryCtx(fx, 0);
  const epubAids = await readVolumeReadingAids({ volumeDir: volume.dir, bundle: epubCtx.bundle });
  same(epubAids.state, "harvest-file-missing", "a missing harvest was not named as a missing harvest");
  same(epubAids.guides, [], "a missing harvest was reported as a harvest of zero rows");
  ok(epubAids.because.includes(fx.harvest01), `the refusal does not name the file: ${epubAids.because}`);

  /** @type {Array<Object>} */
  const epubCalls = [];
  await withStubbedModel(epubCalls, () => extractChapterTerms(epubCtx, epubCtx.bundle.segments[1], 0));
  const epubWire = wireText(epubCalls[0]);
  ok(epubWire.includes(fx.harvest01), "the wire does not name the harvest file that is missing");
  ok(/NOT the same as the book printing none/.test(epubWire), "the wire does not say a missing harvest is not an empty book");
  ok(epubWire.includes("npx gulp extract"), "the wire does not name the door that fixes it");

  // (b) A plain-text volume: no markup to harvest, which is a different fact.
  const plainDir = path.join(fx.dir, "plain-volume");
  fs.mkdirSync(plainDir, { recursive: true });
  fs.writeFileSync(path.join(plainDir, "plain_book.txt"), "A plain text book with no markup at all.\n", "utf8");
  assertInsideFixture(plainDir, fx.dir);
  const plainAids = await readVolumeReadingAids({
    volumeDir: plainDir,
    bundle: { format: "text", base: "plain_book", segments: [{ id: "whole", file: "plain_book.txt", title: "plain_book" }] },
  });
  same(plainAids.state, "no-harvest-in-source", "a plain-text volume was reported as a broken epub");
  const plainBlock = buildReadingBlock({ aids: plainAids, chapters: [{ id: "whole" }] });
  ok(/plain text/.test(plainBlock.text), "the plain-text case does not say the source is plain text");
  ok(plainBlock.text !== epubBlockText(epubAids), "a plain-text volume and a volume with a missing harvest get the same sentence");

  // (c) A bundle that names no base at all is a third fact, not a crash.
  const noBase = await readVolumeReadingAids({ volumeDir: plainDir, bundle: { format: "epub", base: "", segments: [] } });
  same(noBase.state, "no-source-base", "a bundle with no base was not named");
  ok(buildReadingBlock({ aids: noBase, chapters: [{ id: "whole" }] }).text.length > 0,
    "a bundle with no base produced an empty block");

  console.log("4/10: a missing harvest, a plain-text source and a bundle with no base are three named facts, not one empty string");
}

/**
 * The floor sentence one set of aids produces — used to prove two different absences say different things.
 *
 * @param {Object} aids
 * @returns {string}
 */
function epubBlockText(aids) {
  return buildReadingBlock({ aids, chapters: [{ id: "ch1" }] }).text;
}

// ─── Scenario 5 ───────────────────────────────────────────────────────────────

/**
 * The cap truncates, and the block names what it truncated.
 *
 * A cap that silently truncates is a cap that hides the case it truncated (plan 06 slice 2). So the block
 * ends with the count it dropped, some of their names, and the sentence that says the rest still exist.
 * And the bound is a constant: nothing in this layer reads an environment variable, and no flag reaches it.
 *
 * @returns {void}
 */
function scenarioTheCapTruncatesAndNamesWhatItDropped() {
  same(READING_BLOCK_MAX_LINES, 400, "the shipped cap is not 400 lines");
  const guides = [];
  const total = READING_BLOCK_MAX_LINES + 21;
  for (let i = 0; i < total; i++) guides.push(guide(`form-${i}`, `reading-${i}`, 1, ["ch1"]));
  const aids = { state: "read", file: "book(1)-ruby-guides.json", guides, totals: null, because: "fixture" };

  const built = buildReadingBlock({ aids, chapters: [{ id: "ch1" }] });
  same(built.linesShown, READING_BLOCK_MAX_LINES, "the block did not stop at the cap");
  same(built.linesOmitted, 21, "the block did not count what it dropped");
  same(built.chaptersEmpty, 0, "a chapter full of guides was counted as empty");

  const note = built.text.split("\n").find((line) => line.startsWith("_Shown:"));
  ok(Boolean(note), "the truncation is not announced in the block the model is shown");
  ok(note.includes(`400 of ${total} lines`), `the announcement does not give the counts: ${note}`);
  ok(note.includes("400-line limit"), `the announcement does not name the bound: ${note}`);
  const named = (note.match(/form-\d+/g) || []).length;
  ok(named >= READING_BLOCK_NAMED_OMITTED, `the announcement names ${named} forms, fewer than ${READING_BLOCK_NAMED_OMITTED}`);
  ok(note.includes(`and ${21 - READING_BLOCK_NAMED_OMITTED} more`), "the remainder of the dropped lines is not counted");
  ok(note.includes("still in this volume's harvest"), "the announcement does not say the dropped lines still exist");
  ok(note.length <= READING_BLOCK_NOTE_MAX_CHARS + 200,
    `the announcement itself is ${note.length} characters, past the ${READING_BLOCK_NOTE_MAX_CHARS}-character ceiling it is supposed to hold`);

  // The order the cap cuts on is the book's own, not a pipeline judgement about which annotations matter.
  const lines = chapterReadingLines(guides, "ch1");
  same(lines[0].form, "form-0", "the block did not keep the harvest's own order, which is the book's");
  same(built.omittedForms[0], `form-${READING_BLOCK_MAX_LINES}`, "the cap cut from the middle rather than from the tail");

  // No knob. The layer reads no environment variable and takes no flag.
  const layer = readModuleLayer(ROOT, "glossary/extract.js", "glossary");
  const readingLayer = fs.readFileSync(path.join(ROOT, "glossary", "extract", "reading-block.js"), "utf8");
  ok(!/process\.env/.test(readingLayer), "the reading block reads an environment variable");
  ok(layer.includes("READING_BLOCK_MAX_LINES"), "the glossary layer scan does not reach the reading block");

  console.log(`5/10: ${total} guided forms → ${READING_BLOCK_MAX_LINES} shown, 21 dropped, ${named} named, and no knob on the bound`);
}

// ─── Scenario 6 ───────────────────────────────────────────────────────────────

/**
 * The block is built from the volume's own harvest, never from a later volume's.
 *
 * The store's filing door refuses a harvest later than the volume being filed (`written-forms-cannot-look-
 * forward`). This door is the read side of the same rule, and it is enforced by construction: the harvest is
 * looked up in the folder of the volume being read, and nothing in this layer walks to another volume.
 *
 * @returns {Promise<void>}
 */
async function scenarioNeverALaterVolumesHarvest() {
  const fx = fixtureWithHarvests("reading-block-look-forward");
  const ctx01 = glossaryCtx(fx, 0);
  const ctx02 = glossaryCtx(fx, 1);

  const block01 = buildReadingBlock({ aids: await loadReadingAids(ctx01), chapters: ctx01.bundle.segments });
  const block02 = buildReadingBlock({ aids: await loadReadingAids(ctx02), chapters: ctx02.bundle.segments });

  ok(!block01.text.includes(LATER_VOLUME_FORM),
    "volume 01's block carries a guide only volume 02's book printed — the block looked forward");
  ok(block02.text.includes(LATER_VOLUME_FORM), "volume 02's own guide is missing from volume 02's block");
  ok(block01.text.includes(GUESSED_FORM), "volume 01's own guide is missing from volume 01's block");
  ok(!block02.text.includes(GUESSED_FORM), "volume 02's block carries volume 01's guide");

  // The door is given this volume's folder, and only this volume's folder.
  const aids = await readVolumeReadingAids({ volumeDir: fx.volumes[0].dir, bundle: bundleFor(fx.volumes[0]) });
  same(aids.file, fx.harvest01, "the harvest read is not this volume's own file");
  const aids02 = await readVolumeReadingAids({ volumeDir: fx.volumes[1].dir, bundle: bundleFor(fx.volumes[1]) });
  same(aids02.file, fx.harvest02, "the second volume's harvest read is not the second volume's own file");

  // And the layer itself has no way to reach another volume: no series walk, no sibling folder.
  const readingLayer = fs.readFileSync(path.join(ROOT, "glossary", "extract", "reading-block.js"), "utf8");
  ok(!/seriesDir/.test(readingLayer), "the reading block reaches a series folder, which is how a later volume gets in");
  ok(!/readdirSync|for .*volumes/.test(readingLayer), "the reading block walks a folder of volumes instead of reading one volume's harvest");
  same((readingLayer.match(/readRubyGuideFile\(/g) || []).length, 1,
    "the reading block opens the harvest through more than one call to the one reader");

  console.log("6/10: each volume's block comes from that volume's own harvest, and a later volume's guide never appears");
}

// ─── Scenario 7 ───────────────────────────────────────────────────────────────

/**
 * The whole-installment route shows the readings of every chapter it is being shown.
 *
 * That route is handed the whole book in one call, so it gets the volume's guides chapter by chapter, each
 * chapter under the same per-chapter cap the chapter-by-chapter route uses, and the chapters that print
 * nothing are named rather than silently absent.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheWholeInstallmentRouteShowsEveryChapter() {
  const fx = fixtureWithHarvests("reading-block-whole-installment");
  const ctx = glossaryCtx(fx, 0);
  /** @type {Array<Object>} */
  const calls = [];
  await withStubbedModel(calls, () => extractNewTerms(ctx));

  same(calls.length, 1, `the whole-installment read paid ${calls.length} read(s); the block must not add one`);
  const wire = wireText(calls[0]);
  ok(wire.includes(READING_BLOCK_HEADING_VOLUME), "the whole-installment block does not say it covers the volume");
  ok(wire.includes(`${GUESSED_FORM} → ${GUIDED_READING}`), "the whole-installment route never showed the book's reading");
  ok(wire.includes("### ch1"), "the chapters are not separated, so a reading is attributed to the whole book");
  ok(/print no pronunciation guides at all/.test(wire), "the chapters that print nothing are not named");
  ok(wire.includes("ch0"), "the named empty chapter is not the one that is empty");

  const built = buildReadingBlock({ aids: ctx.readingAids, chapters: ctx.bundle.segments });
  same(built.chaptersShown, 1, "the number of chapters with lines to show is wrong");
  same(built.chaptersEmpty, 2, "the number of chapters printing nothing is wrong");

  // The cap is per chapter on this route too: 422 forms in one chapter cannot push that chapter's block past
  // 400 lines, and the other chapters keep all of theirs.
  const crowded = guide("crowded", "くらいいでた", 9, ["ch1"]);
  const manyGuides = [crowded];
  for (let i = 0; i < 421; i++) manyGuides.push(guide(`form-${i}`, `reading-${i}`, 1, ["ch1"]));
  manyGuides.push(guide(LATER_VOLUME_FORM, "らくだ", 2, ["ch0"]));
  const crowdedBlock = buildReadingBlock({
    aids: { state: "read", file: "x", guides: manyGuides, totals: null, because: "" },
    chapters: ctx.bundle.segments,
  });
  same(crowdedBlock.linesShown, 401, `the per-chapter cap did not hold on the whole-installment route (${crowdedBlock.linesShown})`);
  same(crowdedBlock.linesOmitted, 22, "the whole-installment route did not count what its cap dropped");

  console.log("7/10: the whole-installment call is shown every chapter's readings, each under the same cap, empties named");
}

// ─── Scenario 8 ───────────────────────────────────────────────────────────────

/**
 * The answer shape, the two-paid-read budget and the read report are unmoved.
 *
 * This slice appends a block to a call that already runs. It does not add a call, does not change the
 * declared shape the endpoint is given, does not touch the retry budget, and does not add a section to the
 * report the acceptance grader reads.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheShapeBudgetAndReportAreUnmoved() {
  const shape = termsResponseFormat();
  same(shape.type, "json_schema", "the term-list call no longer declares a JSON Schema");
  same(shape.json_schema.strict, true, "the declared shape is no longer strict");
  same(shape.json_schema.schema.type, "object", "the declared shape's root is no longer an object (this endpoint refuses an array root before it generates)");
  same(shape.json_schema.schema.required, ["terms", "revisions"], "the declared shape no longer requires both lists");
  same(shape.json_schema.schema.additionalProperties, false, "the declared envelope is no longer closed");
  const termItem = shape.json_schema.schema.properties.terms.items;
  same(termItem.required, ["term", "rendering", "note", "type", "query"], "the declared term shape no longer names the five keys the prompt names");
  same(termItem.additionalProperties, false, "the declared term shape is no longer closed");
  same(termItem.properties.type.enum, ["character", "place", "item", "faction", "concept"], "the declared term types changed");

  same(EXTRACTION_MAX_ATTEMPTS, 2, "the two-paid-read budget moved");
  same(EXTRACTION_RETRY_THINKING_LEVEL, "medium", "the retry reasoning level moved");

  const reads = [
    {
      id: "chapter ch1",
      title: "第一章",
      terms: 0,
      failed: true,
      attempts: [
        { attempt: 1, thinkingLevel: "run default", terms: 0, failure: { kind: "shape-refused", because: "refused" } },
        { attempt: 2, thinkingLevel: EXTRACTION_RETRY_THINKING_LEVEL, terms: 0, failure: { kind: "shape-refused", because: "refused again" } },
      ],
    },
  ];
  const report = extractionReadReport(reads, { volume: "01" });
  ok(report.includes("NOTHING READ"), "the read report no longer names a read that never answered");
  ok(report.includes("chapter ch1"), "the read report no longer names the chapter");
  ok(!/pronunciation guide|Readings the book/i.test(report),
    "the reading block leaked into the report the acceptance grader reads");

  // And the block never reaches the grader's report through the stage either: the stage's own store door
  // builds the report out of the audit plus the read report plus the revision report.
  const storeLayer = fs.readFileSync(path.join(ROOT, "glossary", "store.js"), "utf8");
  ok(!/reading-block|buildReadingBlock|showReadingAidsForCall/.test(storeLayer),
    "the store door started putting the reading block into the validation report");

  console.log("8/10: the declared shape, the two paid reads and the grader's read report are byte-for-byte what they were");
}

// ─── Scenario 9 ───────────────────────────────────────────────────────────────

/**
 * The block's own prose names no language and no script, and the prompt file is untouched.
 *
 * Two proofs, because one is easy to fake. First: the prose lines are ASCII and name no language, whatever
 * the fixture's book is written in. Second: the prose is **byte-identical** for a book written in one script
 * and a book written in another — so the sentences are not written for a script, they are written about a
 * fact (a guide the book printed). Third: `system-prompts/glossary-terms.md` is unchanged, which is what
 * "appended in code, not written into the prompt file" means (AGENTS.md rule 6).
 *
 * @returns {void}
 */
function scenarioTheBlockNamesNoLanguageAndThePromptFileIsUnchanged() {
  const LANGUAGE_NAMES = ["Japanese", "Korean", "Chinese", "Spanish", "French", "German", "English", "日本語", "한국어", "中文"];
  const cjkGuides = [guide("亜茶花", "あさか", 1, ["ch1"]), guide("虹彩寺菫", "パンジー", 2, ["ch1"])];
  const latinGuides = [guide("Aqua", "AKWA", 1, ["ch1"]), guide("Rosa", "ROSA NAME", 2, ["ch1"])];
  const chapters = [{ id: "ch1", title: "Chapter One" }];

  const cjk = buildReadingBlock({ aids: { state: "read", file: "b.json", guides: cjkGuides, totals: null, because: "" }, chapters });
  const latin = buildReadingBlock({ aids: { state: "read", file: "b.json", guides: latinGuides, totals: null, because: "" }, chapters });

  const cjkProse = proseLines(cjk.text);
  const latinProse = proseLines(latin.text);
  same(cjkProse, latinProse, "the block's own sentences changed with the script of the book it is tabulating");
  for (const line of cjkProse) {
    for (const language of LANGUAGE_NAMES) {
      ok(!line.includes(language), `the block's prose names ${language}: ${line}`);
    }
    ok(!/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/u.test(line),
      `the block's own prose prints characters of one script: ${line}`);
  }
  ok(cjkProse[0] === READING_BLOCK_HEADING, "the block carries no heading a reader can point at");

  const promptFile = path.join(ROOT, "system-prompts", "glossary-terms.md");
  const prompt = fs.readFileSync(promptFile, "utf8");
  const digest = crypto.createHash("sha256").update(prompt).digest("hex");
  same(digest, "ebba1c49d3cc7b2129ce74cca4770a271d29f0bf9552387e36679573c4c4728f",
    "system-prompts/glossary-terms.md changed: the reading block belongs in code, not in the shared prompt file");
  for (const sentence of [READING_BLOCK_HEADING, "pronunciation guide", "harvest"]) {
    ok(!prompt.includes(sentence), `the prompt file now carries the reading block's own text ("${sentence}")`);
  }

  console.log(`9/10: ${cjkProse.length} prose lines, no language named, no script printed, and the prompt file byte-identical`);
}

// ─── Scenario 10 ──────────────────────────────────────────────────────────────

/**
 * Nothing else moved, and the harvest still has exactly one door inside the store.
 *
 * No schema bump, no new table, no new finding kind, no new freeze door, no new command, no new setting, no
 * new prompt kind. And the one invariant plan 07 §2.4 named: `written-forms/file.js` is the only door in
 * `utils/reference-store/` that opens a volume's harvest file.
 *
 * @returns {void}
 */
function scenarioNothingElseMoved() {
  same(SCHEMA_VERSION, 13, "the slice bumped the record schema (that is plan 08 slice 1)");
  same(COUNTED_TABLES.length, 21, "the slice added a table copy-forward has to carry");
  same(Object.keys(FINDING_LEVELS).length, 70, "the slice added a finding kind to the level table");
  same(Object.keys(FINDING_LEVELS).filter((kind) => /reading-block|reading-aid/i.test(kind)), [],
    "a reading-block finding kind appeared in the level table");
  // The two guide-shaped kinds that were already there belong to the extraction audit, not to this block.
  same(Object.keys(FINDING_LEVELS).filter((kind) => /guide|ruby/i.test(kind)).sort(),
    ["guide-split-in-text", "ruby-harvest-missing"],
    "the extraction audit's own guide kinds moved, or this slice added one beside them");
  same(Object.keys(FREEZE_DOORS).length, 12, "the slice added a freeze door");

  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  same(Object.keys(scripts).filter((name) => /reading|guide|ruby/i.test(name)), [], "the slice added a manual command");

  // The store's one door onto the harvest file.
  /** @type {string[]} */
  const storeReaders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "plan" || entry.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      if (fs.readFileSync(full, "utf8").includes("readRubyGuideFile")) storeReaders.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, "utils", "reference-store"));
  same(storeReaders, [path.join("utils", "reference-store", "written-forms", "file.js")],
    "a second door inside the reference store started opening the pronunciation-guide harvest");

  // The new layer reaches the harvest through the one reader function, and nothing else.
  const readingLayer = fs.readFileSync(path.join(ROOT, "glossary", "extract", "reading-block.js"), "utf8");
  ok(readingLayer.includes('require("../../utils/source/ruby-guides")'),
    "the reading block did not go through utils/source/ruby-guides.js");
  ok(!/ruby-guides\.json"\)/.test(readingLayer) && !/JSON\.parse\(fs\.readFile/.test(readingLayer),
    "the reading block parses the harvest file itself instead of using readRubyGuideFile");

  // The barrel still carries every name, old and new.
  const barrel = require("../glossary/extract");
  for (const name of [
    "parseTerms", "parseTermAnswer", "revisionFromAnswer", "termsResponseFormat", "readTermList",
    "extractionReadReport", "truncateGlossary", "classifyExtractionFailure",
    "EXTRACTION_MAX_ATTEMPTS", "EXTRACTION_RETRY_THINKING_LEVEL",
    "buildReadingBlock", "showReadingAidsForCall", "loadReadingAids", "readVolumeReadingAids",
    "chapterReadingLines", "readingBlockTruncationNote", "READING_BLOCK_MAX_LINES",
  ]) {
    ok(barrel[name] !== undefined, `glossary/extract.js no longer re-exports ${name}`);
  }

  // No new prompt kind: the block is appended to the call that already runs, and no prompt file was added.
  const promptFiles = fs.readdirSync(path.join(ROOT, "system-prompts")).filter((f) => /reading|ruby/i.test(f));
  same(promptFiles, [], "the slice added a prompt file for the reading block");

  console.log("10/10: schema 13, 21 counted tables, 70 finding kinds, 12 freeze doors, 1 store door onto the harvest, 0 new commands or prompt files");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

/**
 * Run every scenario and print the tally.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const started = Date.now();
  await scenarioBothReadingsReachTheModel();
  await scenarioTheGuideAnswersWhatThePassWouldOtherwiseGuess();
  await scenarioAChapterWithNoGuidesGetsTheFloorLine();
  await scenarioAMissingHarvestIsNamedNotEmpty();
  scenarioTheCapTruncatesAndNamesWhatItDropped();
  await scenarioNeverALaterVolumesHarvest();
  await scenarioTheWholeInstallmentRouteShowsEveryChapter();
  await scenarioTheShapeBudgetAndReportAreUnmoved();
  scenarioTheBlockNamesNoLanguageAndThePromptFileIsUnchanged();
  scenarioNothingElseMoved();
  console.log(`\ntest-glossary-reading-block: 10 scenarios, ${checks} checks, ${Date.now() - started} ms, 0 model calls.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

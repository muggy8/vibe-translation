/**
 * The pronunciation guides the converter set aside, kept as a file the volume can be asked about.
 *
 * WHY THIS FILE EXISTS. utils/source/html.js renders `<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>`
 * as 蒲田, because the guide is not part of the word. But the guide is the AUTHOR SAYING how a
 * word is read, and that is information the pipeline cannot get back from the cleaned text.
 * Sometimes what the author says is not a reading at all but a name: 三色院菫子 is guided
 * パンジー, 秋野桜 is guided コスモス, 玄武 is guided ジヨーロ. Measured across the 17 archives
 * of the live series, 146 distinct words are guided with a foreign word written in katakana —
 * those are the ones a translator would otherwise invent. So the removal is recorded: the word it
 * sat on, the reading the author gave it, how many times, and which chapters it occurred in.
 *
 * IT IS HARVESTED BY THE REMOVAL, NOT REPARSED. Both converters in utils/source/html.js hand
 * every guide they drop to their `onRubyGuide` callback; this module only aggregates what those
 * callbacks received. A second parser walking the archive for <ruby> would be a second rule
 * about what a guide is, and the two would drift the way the two QA loops used to.
 *
 * IT IS NOT IN THE BUNDLE META. `<base>-bundle.meta.json` is the extraction cache: it is keyed
 * on the archive's fingerprint and rewritten whenever the archive changes, and it describes the
 * SHAPE of the bundle (segments, images, packaging). A per-word reading table is a reference
 * about the book, and something a later query has to open on its own. The meta records the file
 * name and the totals, so the bundle can point at it without holding it.
 *
 * NO MODEL, NO PROMPT, NO AGENT. Extraction order, aggregation and file writing only.
 *
 * Part of the source.js layer.
 */

require("../../types"); // JSDoc type definitions

const fs = require("fs").promises;
const path = require("path");

/**
 * The suffix every volume's harvest file is written under: `<source base>` + this.
 *
 * A `.json`, deliberately: the intake's two scans that decide "is this a book?" accept only
 * `.epub` / `.txt` / `.md` (intake/deterministic.js), so a harvest file cannot be mistaken for
 * a volume the way `character-voice.md-audit.md` was (gotcha 119). It is listed in
 * `intake/config.js` VOLUME_ARTIFACT_PATTERNS, which is the vocabulary BOTH the folder scan and the
 * after-run stray-file check ask (utils/postmortem/volume.js asks `isVolumeArtifact` first, then
 * `isKnownVolumeFile`), so it does not need a second entry in `utils/artifacts/rules.js`.
 *
 * @type {string}
 */
const RUBY_GUIDE_FILE_SUFFIX = "-ruby-guides.json";

/**
 * The shape of the harvest file. Bump it when the row shape changes, so a reader can tell an
 * older harvest from a current one instead of guessing from missing fields.
 *
 * @type {number}
 */
const RUBY_GUIDE_SCHEMA = 1;

/**
 * Which writing system the author used for the reading.
 *
 * A mechanical fact about the string, not a guess about the word: katakana is how this series
 * marks a reading that is NOT the Japanese pronunciation — 三色院菫子 → パンジー, 陣営 → ハーレム.
 * Reported so the interesting rows are findable without re-deriving that rule somewhere else.
 *
 * @param {string} reading
 * @returns {"katakana"|"hiragana"|"latin"|"han"|"other"}
 */
function readingScriptOf(reading) {
  const s = String(reading || "");
  if (/[\u30a1-\u30ff\uff66-\uff9f]/u.test(s)) return "katakana";
  if (/[\u3040-\u309f]/u.test(s)) return "hiragana";
  if (/[A-Za-z]/u.test(s)) return "latin";
  if (/[\u4e00-\u9fff]/u.test(s)) return "han";
  return "other";
}

/**
 * Name the harvest file for one volume's source.
 *
 * @param {string} base - The source base name (no extension).
 * @returns {string} The file name, inside the volume folder.
 */
function rubyGuideFileName(base) {
  return `${base}${RUBY_GUIDE_FILE_SUFFIX}`;
}

/**
 * Fold the guides one conversion removed into one row per (word, reading) pair.
 *
 * A pair, not one row per word, because a word guided two ways is two answers and the file has
 * to be able to say both: 嬉 is guided うれ 669 times and うれし twice, and a row that averaged
 * them would answer the question wrongly. `chapters` is in reading order, deduplicated.
 *
 * Rows are sorted by how often the author used that reading (most first), then by the word, then
 * by the reading — so the file is stable across runs and the words that matter are at the top.
 *
 * @param {RubyGuideOccurrence[]} occurrences - Every guide removed, each tagged with the chapter it came from.
 * @returns {{rows: RubyGuideRow[], totals: RubyGuideTotals}}
 */
function aggregateRubyGuides(occurrences) {
  /** @type {Map<string, RubyGuideRow & { _chapters: Set<string> }>} */
  const byPair = new Map();
  /** @type {Map<string, Set<string>>} word -> the readings that word was given */
  const readingsByWord = new Map();
  const chaptersSeen = new Set();
  let annotations = 0;
  let guideChars = 0;
  let guideParts = 0;

  for (const occ of occurrences || []) {
    const word = String(occ.word || "");
    const reading = String(occ.reading || "");
    const chapter = String(occ.chapter || "");
    if (!word && !reading) continue;
    annotations += 1;
    guideChars += reading.replace(/\s+/g, "").length;
    guideParts += Number.isFinite(occ.annotations) ? occ.annotations : 1;
    if (chapter) chaptersSeen.add(chapter);

    const key = `${word}\u0000${reading}`;
    let row = byPair.get(key);
    if (!row) {
      row = { word, reading, count: 0, readingScript: readingScriptOf(reading), chapters: [] };
      byPair.set(key, row);
    }
    row.count += 1;
    if (chapter && !row.chapters.includes(chapter)) row.chapters.push(chapter);

    if (!readingsByWord.has(word)) readingsByWord.set(word, new Set());
    if (reading) readingsByWord.get(word).add(reading);
  }

  const rows = [...byPair.values()].sort(
    (a, b) =>
      b.count - a.count ||
      (a.word < b.word ? -1 : a.word > b.word ? 1 : 0) ||
      (a.reading < b.reading ? -1 : a.reading > b.reading ? 1 : 0)
  );

  let multiReadingWords = 0;
  let katakanaGuidedWords = 0;
  for (const [word, readings] of readingsByWord) {
    if (readings.size > 1) multiReadingWords += 1;
    if ([...readings].some((r) => readingScriptOf(r) === "katakana")) katakanaGuidedWords += 1;
  }

  return {
    rows,
    totals: {
      guides: annotations,
      guideParts,
      guideChars,
      distinctWords: readingsByWord.size,
      rows: rows.length,
      wordsWithMoreThanOneReading: multiReadingWords,
      wordsGuidedInKatakana: katakanaGuidedWords,
      chapters: chaptersSeen.size,
    },
  };
}

/**
 * Write one volume's harvest beside its bundle.
 *
 * @param {{volumeDir: string, base: string, sourceFile: string, bundleSchema: number, occurrences: RubyGuideOccurrence[]}} p
 * @returns {Promise<{file: string, rows: RubyGuideRow[], totals: RubyGuideTotals}>} The file name and what it holds.
 */
async function writeRubyGuideFile({ volumeDir, base, sourceFile, bundleSchema, occurrences }) {
  const { rows, totals } = aggregateRubyGuides(occurrences);
  const file = rubyGuideFileName(base);
  const document = {
    schema: RUBY_GUIDE_SCHEMA,
    whatThisIs:
      "Every pronunciation guide (ruby) this volume's converter set aside while extracting the " +
      "text, in the form: this word, read this way, this many times, in these chapters. The " +
      "extracted text keeps the word alone; the reading lives only here.",
    generatedBy: `utils/source/ruby-guides.js (bundle schema ${bundleSchema})`,
    sourceFile,
    totals,
    guides: rows,
  };
  await fs.writeFile(path.join(volumeDir, file), JSON.stringify(document, null, 2) + "\n", "utf-8");
  return { file, rows, totals };
}

/**
 * Read a volume's harvest back. Returns null when the volume has none (a plain-text source, or
 * an extraction cached before this file existed) — a missing harvest is a fact to report, not a
 * crash, because a bundle cached under an older schema legitimately has no harvest beside it.
 *
 * @param {string} volumeDir - The volume folder.
 * @param {string} base - The source base name.
 * @returns {Promise<{schema: number, sourceFile: string, totals: RubyGuideTotals, guides: RubyGuideRow[]}|null>}
 */
async function readRubyGuideFile(volumeDir, base) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(volumeDir, rubyGuideFileName(base)), "utf8"));
    if (!parsed || !Array.isArray(parsed.guides)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Answer "what did the author say this word is read as?" for one word.
 *
 * Exact match on the word as the book prints it. Empty when the volume never guided that word —
 * which is a different answer from "the volume guided it with no reading", and the rows say which.
 *
 * @param {{guides: RubyGuideRow[]}} harvest - A harvest read by readRubyGuideFile.
 * @param {string} word
 * @returns {RubyGuideRow[]}
 */
function rubyGuideReadingsFor(harvest, word) {
  const needle = String(word || "");
  return ((harvest && harvest.guides) || []).filter((row) => row.word === needle);
}

module.exports = {
  RUBY_GUIDE_FILE_SUFFIX,
  RUBY_GUIDE_SCHEMA,
  readingScriptOf,
  rubyGuideFileName,
  aggregateRubyGuides,
  writeRubyGuideFile,
  readRubyGuideFile,
  rubyGuideReadingsFor,
};

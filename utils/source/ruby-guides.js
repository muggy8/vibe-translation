/**
 * The pronunciation guides the conversion annotated, kept as a file the volume can be asked about.
 *
 * WHY THIS FILE STILL EXISTS. utils/source/html.js now keeps `<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>` in
 * the text it writes, as `<ruby>蒲田<rt>かまた</rt></ruby>` — the guide is over the word, and the word is
 * whole. So the reading is no longer information only this file holds. What the file holds that a chapter
 * cannot answer is the QUERY: which written form was guided which way, how many times, in which chapters,
 * and in what order the annotation was made. "Was this name read differently in a later volume?" is a
 * question over rows, and no chapter text can answer it.
 *
 * It also holds the author's overrides, which are the reason the guide is kept at all: 三色院菫子 is guided
 * パンジー, 秋野桜 is guided コスモス, 玄武 is guided ジヨーロ. Measured across the 17 archives of the live
 * series, 146 distinct words are guided with a foreign word written in katakana — those are the ones a
 * translator would otherwise invent.
 *
 * IT IS HARVESTED BY THE CONVERSION, NOT REPARSED. Both converters in utils/source/html.js hand every
 * annotation they render to their `onRubyGuide` callback; this module only aggregates what those callbacks
 * received. A second parser walking the archive for <ruby> would be a second rule about what a guide is,
 * and the two would drift the way the two QA loops used to. The harvest is built by `splitRuby`, not by the
 * renderer, which is why plan 09 putting the guide back into the text leaves every row, every count and
 * every `annotated` sequence exactly where it was.
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

// The same whitespace rule the converters use, imported rather than re-written: a harvest that trims a
// guide differently from the text it came out of is a harvest that cannot be matched against that text.
const { normalizeSpaces } = require("./html");

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
 * (v1: one row per (word, reading) pair — 蒲田 / かまた. v2: each row also carries the annotation's OWN
 * sequence, the base characters and the reading each one carried, in the order the book annotated them
 * (蒲→かま, 田→た). The joined pair cannot answer which character carried which reading, so nothing
 * could rebuild the string the old converter produced (蒲かま田た) to search for. That is why the
 * guide-split tripwire was deferred (`utils/source/plan/01-extraction-step.md` §3), and schema 2 is what
 * un-defers it. → AGENTS.md gotcha 123.)
 *
 * @type {number}
 */
const RUBY_GUIDE_SCHEMA = 2;

/**
 * How many annotated pieces an annotation must carry before its interleaved form counts as a
 * guide-split string.
 *
 * Measured, not guessed. A single-piece annotation (三色院 → パンジー, 出 → だ) produces 三色院パンジー /
 * 出だ — and those strings are indistinguishable from ordinary Japanese the author wrote themselves: a
 * book that annotates 言 as い contains 言い inside 言いつける whether or not a converter ever regressed.
 * A two-piece annotation (蒲→かま, 田→た) produces 蒲かま田た, which is a base character sitting in the
 * MIDDLE of its own reading — a shape ordinary prose does not produce.
 *
 * Measured over all 17 archives of the live series (a copy, re-extracted with this harvest shape):
 * 45,429 harvested annotations, 21,647 of them carrying two or more annotated pieces, 10,018 distinct
 * interleaved strings at a floor of 1 against 5,612 at a floor of 2 — and the extracted text holds
 * **666** of the first set (出だ, 言い, 回まわ, 聞き, 直す … every one of them ordinary prose) and
 * **0** of the second. The floor is what turns a check that cries wolf 666 times into one that cries
 * never, and it is the difference between a tripwire and a noise machine.
 *
 * Pinned by `test/test-source-ruby.js`.
 *
 * @type {number}
 */
const GUIDE_SPLIT_MIN_PIECES = 2;

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
 * Normalise one annotation sequence into the shape the harvest stores.
 *
 * Strings only, whitespace collapsed, and a piece with neither base nor reading dropped — a piece of
 * markup that carries nothing is not evidence of anything.
 *
 * @param {RubyGuideAnnotation[]|undefined} annotated - The sequence as the conversion recorded it.
 * @returns {RubyGuideAnnotation[]} The normalised sequence (empty when there was none).
 */
function normalizeRubyAnnotation(annotated) {
  return (Array.isArray(annotated) ? annotated : [])
    .map((unit) => ({
      base: normalizeSpaces(unit && unit.base),
      reading: normalizeSpaces(unit && unit.reading),
    }))
    .filter((unit) => unit.base || unit.reading);
}

/**
 * A comparable key for one annotation sequence, so two occurrences of the same word guided the same way
 * but marked up differently can be told apart.
 *
 * @param {RubyGuideAnnotation[]} annotated
 * @returns {string}
 */
function rubyAnnotationShapeKey(annotated) {
  return JSON.stringify(annotated.map((unit) => [unit.base, unit.reading]));
}

/**
 * Rebuild the string the OLD converter would have left in the text for one annotation sequence.
 *
 * The defect kept everything inside a <ruby> in document order, so the broken string is exactly the
 * sequence interleaved: 蒲 かま 田 た → 蒲かま田た. This is the only place that string is built, which is
 * what makes the tripwire exact instead of a pattern match: it searches for a string derived from what
 * this book actually annotated, not for "kanji followed by hiragana", which fires on ordinary Japanese
 * constantly.
 *
 * Returns "" for a sequence that carries no guide at all (its interleaving is just the word) and for one
 * carrying fewer than `GUIDE_SPLIT_MIN_PIECES` annotated pieces — see that constant for why the
 * single-piece shape is not searched for.
 *
 * @param {RubyGuideAnnotation[]|undefined} annotated - One annotation's own sequence.
 * @returns {string} The guide-split string to look for, or "" when this annotation has no split shape.
 */
function rubyGuideSplitFormOf(annotated) {
  const units = normalizeRubyAnnotation(annotated);
  if (units.length < GUIDE_SPLIT_MIN_PIECES) return "";
  const form = units.map((unit) => `${unit.base}${unit.reading}`).join("");
  const word = units.map((unit) => unit.base).join("");
  // A sequence whose guides are all empty interleaves into the word itself: searching for it would
  // report every guided word as its own defect.
  if (!form || form === word) return "";
  return form;
}

/**
 * Fold the guides one conversion removed into one row per (word, reading) pair.
 *
 * A pair, not one row per word, because a word guided two ways is two answers and the file has
 * to be able to say both: 嬉 is guided うれ 669 times and うれし twice, and a row that averaged
 * them would answer the question wrongly. `chapters` is in reading order, deduplicated.
 *
 * Each row also carries `annotated`: the sequence this word was annotated in most often — the base
 * characters and the reading each one carried, in the order the book wrote them. When the same pair was
 * marked up in more than one shape (`<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>` and
 * `<ruby><rb>蒲</rb><rb>田</rb><rt>かま</rt><rt>た</rt></ruby>` are the same pair, interleaved
 * differently) the other shapes go in `annotatedVariants`, so the split-string search sees every shape
 * this volume actually used and not just the commonest one.
 *
 * Rows are sorted by how often the author used that reading (most first), then by the word, then
 * by the reading — so the file is stable across runs and the words that matter are at the top.
 *
 * @param {RubyGuideOccurrence[]} occurrences - Every guide removed, each tagged with the chapter it came from.
 * @returns {{rows: RubyGuideRow[], totals: RubyGuideTotals}}
 */
function aggregateRubyGuides(occurrences) {
  /** @type {Map<string, {word: string, reading: string, count: number, readingScript: string, chapters: string[], chapterSet: Set<string>, shapes: Map<string, {units: RubyGuideAnnotation[], count: number}>}>} */
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
      row = {
        word,
        reading,
        count: 0,
        readingScript: readingScriptOf(reading),
        chapters: [],
        chapterSet: new Set(),
        shapes: new Map(),
      };
      byPair.set(key, row);
    }
    row.count += 1;
    if (chapter && !row.chapterSet.has(chapter)) {
      row.chapterSet.add(chapter);
      row.chapters.push(chapter);
    }

    const units = normalizeRubyAnnotation(occ.annotated);
    const shapeKey = rubyAnnotationShapeKey(units);
    let shape = row.shapes.get(shapeKey);
    if (!shape) {
      shape = { units, count: 0 };
      row.shapes.set(shapeKey, shape);
    }
    shape.count += 1;

    if (!readingsByWord.has(word)) readingsByWord.set(word, new Set());
    if (reading) readingsByWord.get(word).add(reading);
  }

  /** @type {RubyGuideRow[]} */
  const rows = [...byPair.values()]
    .map((row) => {
      const shapes = [...row.shapes.values()].sort(
        (a, b) => b.count - a.count || (rubyAnnotationShapeKey(a.units) < rubyAnnotationShapeKey(b.units) ? -1 : 1)
      );
      const built = {
        word: row.word,
        reading: row.reading,
        count: row.count,
        readingScript: row.readingScript,
        chapters: row.chapters,
        annotated: shapes[0].units,
      };
      if (shapes.length > 1) built.annotatedVariants = shapes.slice(1).map((s) => s.units);
      return built;
    })
    .sort(
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
      rowsWithMoreThanOneAnnotationShape: rows.filter((r) => Array.isArray(r.annotatedVariants)).length,
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
      "Every pronunciation guide (ruby) this volume's conversion annotated while extracting the " +
      "text, in the form: this word, read this way, this many times, in these chapters, annotated in " +
      "this order (which base character carried which reading). The extracted text carries the reading " +
      "over the word as ruby markup; this file is the copy that can be asked about.",
    generatedBy: `utils/source/ruby-guides.js (bundle schema ${bundleSchema}, harvest schema ${RUBY_GUIDE_SCHEMA})`,
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
 * The distinct guide-split strings a set of annotations would produce, and how many times each one
 * appears in a piece of extracted text.
 *
 * This is the tripwire's whole rule, in one place: take the sequences the conversion recorded, rebuild
 * the string the old converter would have left behind for each, and look for THAT string. No pattern
 * matching, no "looks like furigana", no second parser — a plain substring search for a string derived
 * from what this book actually annotated.
 *
 * Accepts anything carrying `annotated`: the `RubyGuide[]` a conversion set aside, or the
 * `RubyGuideRow[]` read back out of a volume's harvest file.
 *
 * @param {string} text - Extracted text to search (a chapter's body, the whole-volume file).
 * @param {Array<{annotated?: RubyGuideAnnotation[]}>} annotatedItems - Annotations to rebuild forms from.
 * @returns {{occurrences: number, forms: string[]}} How many times a split string appears, and which ones.
 */
function findRubyGuideSplitForms(text, annotatedItems) {
  const haystack = String(text || "");
  if (!haystack) return { occurrences: 0, forms: [] };
  /** @type {Set<string>} */
  const forms = new Set();
  for (const item of annotatedItems || []) {
    const form = rubyGuideSplitFormOf(item && item.annotated);
    if (form) forms.add(form);
  }
  if (forms.size === 0) return { occurrences: 0, forms: [] };
  let occurrences = 0;
  /** @type {string[]} */
  const hits = [];
  for (const form of forms) {
    let at = haystack.indexOf(form);
    let count = 0;
    while (at !== -1) {
      count += 1;
      at = haystack.indexOf(form, at + form.length);
    }
    if (count > 0) {
      occurrences += count;
      hits.push(form);
    }
  }
  return { occurrences, forms: hits };
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
  GUIDE_SPLIT_MIN_PIECES,
  readingScriptOf,
  rubyGuideFileName,
  rubyGuideSplitFormOf,
  findRubyGuideSplitForms,
  aggregateRubyGuides,
  writeRubyGuideFile,
  readRubyGuideFile,
  rubyGuideReadingsFor,
};

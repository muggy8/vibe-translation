#!/usr/bin/env node
/**
 * test/test-annotated-view.js — normalise, teach, then show (plan 07 slice 5).
 *
 * The slice has three steps, and this suite walks them in that order.
 *
 *   1. **Normalise.** One module owns HTML ruby in the store: `utils/reference-store/ruby-markup.js`. A quote
 *      copied out of an annotated chapter comes back to the guide-free string the book prints, so every
 *      evidence rule still verifies it (plan 07 §4.6, first bullet). Scenario 1 pins the leaf, including that
 *      its tag vocabulary is **the converter's** — a store that disagrees with the converter about what a
 *      guide is is a store that drops part of a word.
 *   2. **Teach.** The markdown parsers learn the markup before any published file is allowed to contain it:
 *      a heading is the word and not the guide, a guide on its own line is not a continuation of the claim
 *      above it, and a term cell is split **after** the markup comes off, not before. Scenarios 8 and 9.
 *   3. **Show.** The view: which written forms this volume's record may put a guide over, and the markup over
 *      one chapter. Scenarios 2–7.
 *
 * What the suite pins that nothing else in this repository pins:
 *
 *   - **The strip invariant**, `stripRubyMarkup(annotate(text).text) === text`, over three writing systems.
 *     It is the one property that lets a view and the evidence rule coexist, and it is checked on the exact
 *     shape that breaks a naive annotator: two approved forms where one contains the other
 *     (三色院菫子 / 菫子), and a reading that happens to spell an approved form.
 *   - **The selection rule, guard by guard, on two unrelated scripts.** A form guided several ways, a form
 *     guided fewer times than the book prints it, and a form guided too often to be worth showing each fire
 *     on a Japanese fixture **and** on a Cyrillic one (scenario 6), with the same rule names and the same
 *     counts. The rule is an equality over counts, so it holds no vocabulary and names no writing system —
 *     which is what `test/test-no-language-axis-list.js` exists to keep true, and scenario 5 re-checks it
 *     against this layer's own source.
 *   - **The rename half is data the caller supplies.** The same over-bound form is refused with no
 *     `renameForms` and selected with one, and a rename named for a different volume does not license this
 *     volume's spelling.
 *   - **A quote copied out of an annotated chapter verifies** against the guide-free chapter, and says it
 *     stripped markup while doing so; a forged quote that carries markup is still refused.
 *   - **The taught continuation rule, both ways.** A plain wrapped line is glued onto the claim above it
 *     (that is the rule, and it still works); a line carrying a guide is **not**, and is named instead. The
 *     glued shape is printed in the assertion, because the damage plan 07 §4.6 names is a published claim
 *     body with markup welded onto the end of it.
 *   - **Nothing was wired or added**: 0 callers of the three view doors outside their own layer (a tree walk),
 *     70 finding kinds, 12 freeze doors, schema 13, no counted table added, no npm script, no verb on the
 *     store's handle, and every name the written-forms cover exports reaching the store's barrel.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69). The real-corpus
 * numbers this shape is measured against come from `test/measure-annotated-view.js`.
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rs = require("../utils/reference-store");
const { readModuleLayer } = require("./module-layer");
const { openReferenceStore, SCHEMA_VERSION, COUNTED_TABLES, insertWrittenFormRow, writtenFormCounts } = rs;
const { importGlossary } = require("../utils/reference-store/glossary-adapter");
const { parseVoiceMarkdown } = require("../utils/reference-store/voice-adapter");
const { glossaryTermSpans: storeTermSpans, parseGlossaryMarkdown } = require("../utils/reference-store/glossary-adapter/parse");
const { glossaryTermSpans: carryForwardTermSpans } = require("../glossary/carry-forward/table");
const { findQuoteEvidence } = require("../utils/reference-store/glossary-adapter/quote-evidence");
const { verifyEvidenceItem, prepareQuoteForSearch, quoteSkeleton, normalizeQuote } = require("../utils/reference-store/evidence");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { FREEZE_DOORS } = require("../utils/prereqs/freeze");
const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");
const { RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");
const { RUBY_GUIDE_TAGS: CONVERTER_RUBY_GUIDE_TAGS } = require("../utils/source/html");
const { SOURCE_01, GLOSSARY_01, VOICE_01, fixtureStoreSeries, assertInsideFixture } = require("./fixture-reference-store");

const {
  RUBY_GUIDE_TAGS,
  RUBY_BASE_TAGS,
  RUBY_MARKUP_OVERHEAD_CHARS,
  hasRubyMarkup,
  rubyMarkupUnitCount,
  stripRubyMarkup,
  rubyMarkupFor,
  rubyMarkupAddedChars,
} = require("../utils/reference-store/ruby-markup");

const {
  VIEW_MAX_USES_PER_VOLUME,
  printedOccurrences,
  annotatedFormsForVolume,
  annotateChapterText,
  annotatedChapterView,
} = rs;

const ROOT = path.resolve(__dirname, "..");

let checks = 0;
/** Count one assertion and run it. @param {boolean|void} condition @param {string} message */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}
/** @param {any} a @param {any} b @param {string} message */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

// ─── The fixture ──────────────────────────────────────────────────────────────

/**
 * The harvest this suite writes into the fixture volume folder, in the shape
 * `utils/source/ruby-guides.js` writes it.
 *
 * Every row is planted against a **known printed count** in `test/fixture-reference-store.js`'s volume 01, so
 * the equality guard has a number to compare against rather than a guess: 三色院菫子 is printed once,
 * 如月雨露 twice, 教師 three times, 秋野桜 **never as one string** (the fixture prints it only with its
 * reading aids between the characters, which is the real corpus's shape).
 *
 * @type {Object}
 */
const HARVEST = {
  schema: 2,
  whatThisIs: "fixture harvest for the annotated-view suite",
  generatedBy: "test/test-annotated-view.js",
  sourceFile: "test_story(1).epub",
  totals: { guides: 7, rows: 7 },
  guides: [
    // Selected: guided once, printed once.
    { word: "三色院菫子", reading: "すみれこ", count: 1, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "三色院菫子", reading: "すみれこ" }] },
    // Refused by guard 2: guided once, printed twice. The fixture shape of the real 三色院菫子 → パンジー case.
    { word: "如月雨露", reading: "主人公", count: 1, readingScript: "han", chapters: ["ch0"], annotated: [{ base: "如月雨露", reading: "主人公" }] },
    // Refused by guard 1: two readings over one form, so which occurrence took which is not in the record.
    { word: "大賀太陽", reading: "サンちゃん", count: 2, readingScript: "katakana", chapters: ["ch0", "ch1"], annotated: [{ base: "大賀太陽", reading: "サンちゃん" }] },
    { word: "大賀太陽", reading: "タイヨウ", count: 1, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "大賀太陽", reading: "タイヨウ" }] },
    // Always guided, over the use bound: refused unless the caller names it a rename.
    { word: "教師", reading: "きょうし", count: 3, readingScript: "hiragana", chapters: ["ch0", "ch1", "ch2"], annotated: [{ base: "教師", reading: "きょうし" }] },
    // Guided once, printed **zero** times as a contiguous string: the furigana-only name.
    { word: "秋野桜", reading: "コスモス", count: 1, readingScript: "katakana", chapters: ["ch2"], annotated: [{ base: "秋野桜", reading: "コスモス" }] },
    // Selected, and the one the annotator's longest match is tested against (菫子 sits inside 三色院菫子).
    { word: "菫子", reading: "すみれ", count: 1, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "菫子", reading: "すみれ" }] },
  ],
};

/**
 * A fixture volume 01 whose record holds the harvest above, filed through the shipped door.
 *
 * @param {string} label
 * @returns {Promise<{fx: Object, store: Object, seriesDir: string, volumeDir: string, filed: Object}>}
 */
async function openViewFixture(label) {
  const fx = fixtureStoreSeries(`annotated-view-${label}`);
  const seriesDir = fx.dir;
  const volumeDir = fx.volumes[0].dir;
  fs.writeFileSync(path.join(volumeDir, `test_story(1)${RUBY_GUIDE_FILE_SUFFIX}`), JSON.stringify(HARVEST, null, 2) + "\n", "utf8");
  const store = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir, stage: "merge" });
  store.registerChaptersFromSource();
  assertInsideFixture(store.file, seriesDir);
  const imported = importGlossary(store, GLOSSARY_01);
  ok(imported.castRegistered >= 3, `the fixture roster is registered: ${JSON.stringify(imported.refused)}`);
  const filed = await rs.fileVolumeWrittenForms(store, { volume: 1 });
  ok(filed.ok, `the harvest was filed through the shipped door: ${JSON.stringify(filed.refusal || filed.errors)}`);
  return { fx, store, seriesDir, volumeDir, filed };
}

/**
 * Every table this layer could have touched, counted, so "the view wrote nothing" is a comparison.
 * @param {Object} store @returns {Object<string, number>}
 */
function tableCounts(store) {
  /** @type {Object<string, number>} */
  const out = {};
  for (const table of COUNTED_TABLES) out[table] = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return out;
}

/**
 * Volume 01's whole guide-free text, the way the extraction lays it out: one string per chapter.
 * @returns {string[]}
 */
function volumeOneChapters() {
  return Object.values(SOURCE_01).map((lines) => lines.join("\n"));
}

/**
 * Volume 01's chapter list, in the shape the evidence doors want.
 * @param {string} volumeDir @returns {Array<{id: string, file: string}>}
 */
function chapterFiles(volumeDir) {
  const meta = JSON.parse(fs.readFileSync(path.join(volumeDir, "test_story(1)-bundle.meta.json"), "utf8"));
  return meta.segments.map((segment) => ({ id: segment.id, file: segment.file }));
}

// ─── 1. the leaf: one module owns the markup, and its tags are the converter's ──

/** Scenario 1. @returns {void} */
function scenarioLeaf() {
  // The converter's own multi-piece shape, from gotcha 123: the guide is not part of the word.
  same(stripRubyMarkup("<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>"), "蒲田", "the converter's own split shape strips to the word it extracts");
  same(stripRubyMarkup("「<ruby>蒲かま田た</ruby>」"), "「蒲かま田た」", "a ruby with no guide tag inside is the word, and the brackets around it survive");
  same(stripRubyMarkup("<ruby><rb>蒲田</rb><rt>かまた</rt></ruby>"), "蒲田", "a base tag is the word: its text is kept and its tags are dropped");
  same(stripRubyMarkup("<ruby class=\"x\"><rt>よみ</rt></ruby>"), "", "a ruby whose only text is a reading strips to nothing");
  same(stripRubyMarkup("<ruby>蒲田<rt>かまた"), "蒲田", "an unbalanced guide tag drops its own markup and keeps the word — a parser that loses a word over a mismatched bracket is a parser that damages the book");
  same(stripRubyMarkup("<ruby><ruby>菫子<rt>すみれ</rt></ruby><rt>すみれこ</rt></ruby>"), "菫子", "nested ruby is handled by depth, not by matching a whole unit");
  same(stripRubyMarkup("guide-free text with no tags at all"), "guide-free text with no tags at all", "text with no markup is returned untouched");
  same(stripRubyMarkup(null), "", "and a missing string is an empty one, not a crash");

  same(hasRubyMarkup("蒲田"), false, "guide-free text is not recognised as markup");
  same(hasRubyMarkup("<rt>かまた</rt>"), true, "a bare guide tag is still markup the store has to deal with");
  same(rubyMarkupUnitCount("<ruby>三色院菫子<rt>パンジー</rt></ruby>と<ruby>蒲田<rt>かまた</rt></ruby>"), 2, "two ruby units, counted");
  same(rubyMarkupUnitCount("no markup"), 0, "and none where there are none");

  same(RUBY_MARKUP_OVERHEAD_CHARS, 22, "the fixed cost of one annotation is <ruby></ruby> plus <rt></rt>: 22 characters");
  same(rubyMarkupAddedChars({ form: "蒲田", reading: "かまた" }), 22 + 3, "plus the reading itself");
  same(rubyMarkupFor({ form: "蒲田", reading: "かまた" }), "<ruby>蒲田<rt>かまた</rt></ruby>", "the one shape this repository emits");
  same(stripRubyMarkup(rubyMarkupFor({ form: "三色院菫子", reading: "パンジー" })), "三色院菫子", "and it strips back to the form it was built from");

  let threw = 0;
  try {
    rubyMarkupFor({ form: "", reading: "かまた" });
  } catch {
    threw++;
  }
  try {
    rubyMarkupFor({ form: "蒲田" });
  } catch {
    threw++;
  }
  same(threw, 2, "markup with no word in it, or no reading over it, is refused rather than emitted");

  // THE TAG VOCABULARY IS THE CONVERTER'S. The leaf restates it because `utils/source/html.js` loads cheerio
  // at require time; this is the check that makes the restatement safe.
  same([...RUBY_GUIDE_TAGS].sort(), [...CONVERTER_RUBY_GUIDE_TAGS].sort(), "the store's guide tags are the converter's guide tags, exactly — a store that disagrees about what a guide is drops part of a word");
  same([...RUBY_BASE_TAGS].sort(), ["rb", "rbc"], "and the base tags are the ruby base, whose text IS the word");

  const leafLayer = readModuleLayer(ROOT, "utils/reference-store/ruby-markup.js");
  const requires = [...leafLayer.matchAll(/require\((["'])([^"']+)\1\)/g)].map((match) => match[2]);
  same(requires, ["../../types"], "the leaf requires nothing but the types, so the evidence rule, the parser and the view can all reach it without closing a cycle (gotcha 85)");
  ok(!/require\(["'].*source\/html/.test(leafLayer), "and it does not require the converter: cheerio does not ride behind every evidence query");

  console.log("1. the leaf: strip / build / count, the converter's own tag vocabulary, and a leaf that requires nothing");
}

// ─── 2. the annotator: the strip invariant over three writing systems ─────────

/** Scenario 2. @returns {void} */
function scenarioAnnotator() {
  const forms = [
    { form: "三色院菫子", reading: "パンジー" },
    { form: "菫子", reading: "すみれこ" },
    { form: "蒲田", reading: "かまた" },
  ];
  const text = "三色院菫子は蒲田を見る。菫子、蒲田よ。";
  const out = annotateChapterText(text, { forms, label: "ch1" });

  ok(out.ok, "the annotator ran");
  same(out.text, "<ruby>三色院菫子<rt>パンジー</rt></ruby>は<ruby>蒲田<rt>かまた</rt></ruby>を見る。<ruby>菫子<rt>すみれこ</rt></ruby>、<ruby>蒲田<rt>かまた</rt></ruby>よ。", "the guide goes over each printed occurrence, in the one shape the leaf owns");
  same(stripRubyMarkup(out.text), text, "THE INVARIANT: stripping what was added returns the text that was given");
  same(out.totals.markupUnits, 4, "four ruby units, and none of them nested");
  ok(!/<ruby>[^<]*<ruby>/.test(out.text), "no ruby unit is nested inside another: 菫子 inside 三色院菫子 is inside the markup now, and a second pass would cut the outer reading in half");
  same(out.annotated.map((hit) => `${hit.form}x${hit.count}`), ["三色院菫子x1", "菫子x1", "蒲田x2"], "the longest approved form wins at a position, and the shorter one is still annotated where the book printed it alone");
  same(out.totals.addedChars, out.annotated.reduce((sum, hit) => sum + hit.count * rubyMarkupAddedChars(hit), 0), "the character cost is the per-occurrence cost times the occurrences");
  same(out.totals.annotatedChars - out.totals.sourceChars, out.totals.addedChars, "and it is the difference between the two lengths, which is the only honest way to state it");

  // A reading that spells an approved form: the scan never looks at what it emitted.
  const selfReferential = annotateChapterText("蒲田よ。", { forms: [{ form: "蒲田", reading: "蒲田" }] });
  same(selfReferential.text, "<ruby>蒲田<rt>蒲田</rt></ruby>よ。", "a reading that happens to spell an approved form is annotated once, not forever");
  same(stripRubyMarkup(selfReferential.text), "蒲田よ。", "and the invariant still holds on it");

  // Cyrillic and Latin: the annotator holds no script.
  const cyrillic = "Город Москва и Москва река.";
  const cyr = annotateChapterText(cyrillic, { forms: [{ form: "Москва", reading: "столица" }] });
  same(stripRubyMarkup(cyr.text), cyrillic, "the same invariant on a Cyrillic fixture");
  same(cyr.totals.annotatedOccurrences, 2, "and the same counting");
  const latin = "colour and colour and Colour.";
  const lat = annotateChapterText(latin, { forms: [{ form: "colour", reading: "KUL-er" }] });
  same(stripRubyMarkup(lat.text), latin, "and on a Latin one");
  same(lat.totals.annotatedOccurrences, 2, "the match is exact, so a capitalised spelling the record does not hold is not annotated — the record's spelling is the book's spelling");

  same(printedOccurrences(["abcabc"], "abc"), 2, "printed occurrences are counted non-overlapping");
  same(printedOccurrences(["aaa"], "aa"), 1, "and a form that could overlap is counted once per non-overlapping place");
  same(printedOccurrences(["ab", "bc"], "abc"), 0, "a form is not matched across a chapter join: two chapters are not one continuous string");
  same(printedOccurrences("三色院菫子", "三色院菫子"), 1, "and a whole volume passed as one string works the same way");

  console.log("2. the annotator: the strip invariant on three scripts, longest match, no nested ruby, and a reading that spells its own form");
}

// ─── 3. the annotator's refusals ──────────────────────────────────────────────

/** Scenario 3. @returns {void} */
function scenarioAnnotatorRefusals() {
  const forms = [{ form: "蒲田", reading: "かまた" }];

  const first = annotateChapterText("蒲田。", { forms });
  const twice = annotateChapterText(first.text, { forms });
  same(twice.ok, false, "annotating an already-annotated chapter is refused");
  same(twice.refusal.rule, "annotated-view-text-already-annotated", "by name");
  same(twice.text, first.text, "and the text is returned unchanged: no second layer of markup is ever emitted");
  same(stripRubyMarkup(twice.text), "蒲田。", "which is the point — the invariant is false for a doubly-annotated text, and this refusal is what keeps it true");

  same(annotateChapterText(undefined, { forms }).refusal.rule, "annotated-view-needs-the-text", "text that is not text is refused");
  same(annotateChapterText(null, { forms }).refusal.rule, "annotated-view-needs-the-text", "including a missing one");
  same(annotateChapterText("蒲田。", { forms: "蒲田,かまた" }).refusal.rule, "annotated-view-needs-the-form-list", "and a form list that is not a list");

  const skipped = annotateChapterText("蒲田。", {
    forms: [{ form: "蒲田", reading: "ka<rt>ma" }, { form: "", reading: "かまた" }, { form: "蒲田", reading: "かまた" }],
  });
  ok(skipped.ok, "one bad pair does not make a chapter unannotatable");
  same(skipped.totals.formsSkipped, 2, "and the two bad pairs are counted");
  same(skipped.skipped.map((item) => item.rule), ["annotated-view-form-carries-markup", "annotated-view-form-is-incomplete"], "each named with the rule that skipped it");
  same(skipped.text, "<ruby>蒲田<rt>かまた</rt></ruby>。", "the good pair is still annotated");
  same(stripRubyMarkup(skipped.text), "蒲田。", "and the invariant survives the skips");

  const empty = annotateChapterText("", { forms });
  ok(empty.ok, "an empty chapter is annotatable, and uninteresting");
  same(empty.text, "", "it stays empty");
  same(empty.totals.addedChars, 0, "and costs nothing");

  const none = annotateChapterText("蒲田。", { forms: [] });
  ok(none.ok, "no approved forms is not a refusal");
  same(none.text, "蒲田。", "the chapter is returned exactly as it was given");
  same(none.totals.annotatedForms, 0, "with nothing annotated");

  console.log("3. refusals: already-annotated text, missing text, a bad pair skipped and named, and an empty chapter");
}

// ─── 4. the selection: three guards, each firing, nothing written ─────────────

/** Scenario 4. @returns {Promise<void>} */
async function scenarioSelectionGuards() {
  const { store, filed } = await openViewFixture("guards");
  try {
    const countsBefore = tableCounts(store);
    ok(countsBefore.written_forms > 0, `the fixture record holds the filed rows: ${countsBefore.written_forms}`);

    const volumeText = volumeOneChapters();
    const selection = annotatedFormsForVolume(store, { volume: 1, volumeText });
    ok(selection.ok, "the selection ran");

    const selected = selection.forms.map((form) => form.form);
    same(selected, ["三色院菫子", "菫子"], "the two forms guided exactly as often as the book prints them, within the bound");
    same(selection.forms.map((form) => form.reason), ["always-guided-within-the-bound", "always-guided-within-the-bound"], "and each says why it was chosen");

    /** @type {Object<string, {rule: string, guided: number, printed: number, readings: number}>} */
    const refused = {};
    for (const item of selection.refused) refused[item.form] = item;

    same(refused["大賀太陽"].rule, "annotated-view-form-guided-several-ways", "a form guided two ways is refused, and the guard is asked FIRST");
    same(refused["大賀太陽"].readings, 2, "two readings in the record");
    same(refused["大賀太陽"].guided, 3, "three guided occurrences");
    same(refused["大賀太陽"].printed, 2, "two printed occurrences");
    ok(/which printed occurrence carried which reading/.test(refused["大賀太陽"].because), "and the reason says the thing the record cannot answer, rather than guessing by row order (gotcha 117)");

    same(refused["如月雨露"].rule, "annotated-view-form-not-guided-every-time", "a form guided fewer times than the book prints it is refused");
    same([refused["如月雨露"].guided, refused["如月雨露"].printed], [1, 2], "guided once, printed twice");
    ok(/would put a guide there that the book does not carry/.test(refused["如月雨露"].because), "and the reason names the damage: an invented guide");

    same(refused["秋野桜"].rule, "annotated-view-form-not-guided-every-time", "a form the record holds that this volume never prints as one string is refused too");
    same([refused["秋野桜"].guided, refused["秋野桜"].printed], [1, 0], "guided once, printed zero times — the furigana-only name, which the guide-free text writes as two separate words");

    same(refused["教師"].rule, "annotated-view-form-used-more-than-twice", "and the cost bound refuses a form guided every single time but too often to be worth showing");
    same([refused["教師"].guided, refused["教師"].printed], [3, 3], "guided three times, printed three times: the equality holds, and the bound is what refuses it");
    same(refused["教師"].readings, 1, "one reading, so guard 1 let it through");
    ok(/habit/.test(refused["教師"].because), "and the reason says why a guide applied out of habit tells a translator nothing");

    same(selection.totals.refusedByRule, {
      "annotated-view-form-guided-several-ways": 1,
      "annotated-view-form-not-guided-every-time": 2,
      "annotated-view-form-used-more-than-twice": 1,
    }, "every refusal is tallied by rule, so a report can group on it");
    same(selection.totals.maxUsesPerVolume, VIEW_MAX_USES_PER_VOLUME, "and the bound it applied is the constant, printed");
    same(selection.totals.guidedOccurrences, 2, "two annotated occurrences");
    same(selection.totals.printedOccurrences, 2, "which is also the printed count, because the equality guard made the two equal");
    same(selection.totals.addedChars, selection.forms.reduce((sum, form) => sum + form.guided * rubyMarkupAddedChars(form), 0), "and the character cost is stated before anyone pays for a bigger prompt");

    // The selection is a read. It writes nothing.
    same(tableCounts(store), countsBefore, "and the whole record is the same size in every counted table after the selection: a view files nothing");

    console.log("4. selection: guard 1 (several readings), guard 2 (not guided every time, twice), guard 3 (over the bound), each named, 0 rows written");
  } finally {
    store.close();
  }
}

// ─── 5. the rename half is the caller's data, and the door holds no script rule ──

/** Scenario 5. @returns {Promise<void>} */
async function scenarioRenameIsData() {
  const { store } = await openViewFixture("rename");
  try {
    const volumeText = volumeOneChapters();

    const plain = annotatedFormsForVolume(store, { volume: 1, volumeText });
    const without = plain.refused.find((item) => item.form === "教師");
    same(without.rule, "annotated-view-form-used-more-than-twice", "with no rename named, the over-bound form is refused");

    const named = annotatedFormsForVolume(store, { volume: 1, volumeText, renameForms: [{ volume: 1, form: "教師" }] });
    const teacher = named.forms.find((form) => form.form === "教師");
    ok(teacher, "naming it licenses it");
    same(teacher.reason, "named-rename", "and the record of why says who decided: the caller, not this door");
    same(teacher.guided, 3, "the bound is lifted, not the evidence rule: it is still guided every single time");
    same(named.totals.renameFormsNamed, 1, "one rename named");
    same(named.totals.renameFormsMatched, 1, "and one matched a row this volume actually holds");
    same(named.refused.filter((item) => item.form === "教師"), [], "and it is no longer in the refused list");

    const otherVolume = annotatedFormsForVolume(store, { volume: 1, volumeText, renameForms: [{ volume: 2, form: "教師" }] });
    same(otherVolume.totals.renameFormsMatched, 0, "a rename named for volume 2 does not license this spelling in volume 1");
    same(otherVolume.refused.find((item) => item.form === "教師").rule, "annotated-view-form-used-more-than-twice", "so it is refused again, exactly as it was");

    const asStrings = annotatedFormsForVolume(store, { volume: 1, volumeText, renameForms: ["教師"] });
    same(asForms(asStrings), ["三色院菫子", "教師", "菫子"], "a plain form string works for the volume being asked about");

    const malformed = annotatedFormsForVolume(store, { volume: 1, volumeText, renameForms: ["", null, 7, { form: "" }] });
    same(malformed.totals.renameFormsMalformed, 4, "and a malformed entry is counted rather than silently dropped");
    same(asForms(malformed), ["三色院菫子", "菫子"], "with nothing licensed");

    // The door holds no rule about what a rename is, and names no writing system.
    const selectLayer = readModuleLayer(ROOT, "utils/reference-store/written-forms/view/select.js");
    const languageNames = ["Japanese", "Korean", "Chinese", "日本語", "hiragana", "katakana", "kanji"];
    const scriptsNamed = languageNames.filter((name) => new RegExp(`\\b${name}\\b`, "i").test(selectLayer));
    same(scriptsNamed, [], "the selection door names no writing system: the rename classification is data the caller hands over, never a rule this layer holds");
    ok(/rename half is data the caller supplies/i.test(selectLayer), "and its own header says so, so the next reader does not 'fix' it by adding a script test");

    console.log("5. renames: caller-supplied data, per volume, malformed entries counted, and no writing system named anywhere in the door");
  } finally {
    store.close();
  }
}

/**
 * The selected form names, for the rename assertions.
 * @param {Object} selection @returns {string[]}
 */
function asForms(selection) {
  return selection.forms.map((form) => form.form);
}

// ─── 6. the same three guards on a script the fixture was not written in ──────

/** Scenario 6. @returns {Promise<void>} */
async function scenarioScriptNeutral() {
  const { store } = await openViewFixture("cyrillic");
  try {
    // Wipe the Japanese fixture rows so this scenario asks the door about one script only.
    store.db.prepare("DELETE FROM written_forms").run();
    same(writtenFormCounts(store).total, 0, "the record starts empty for this scenario");

    const rows = [
      { form: "Москва", reading: "столица", occurrences: 2 },
      { form: "Нева", reading: "река", occurrences: 1 },
      { form: "Дон", reading: "река", occurrences: 1 },
      { form: "Волга", reading: "река", occurrences: 1 },
      { form: "Волга", reading: "приток", occurrences: 1 },
      { form: "мост", reading: "переправа", occurrences: 3 },
    ];
    for (const row of rows) insertWrittenFormRow(store, { volume: 1, readingScript: "cyrillic", chapters: ["ch0"], ...row });

    const text = "Москва и Москва. Нева течёт. Дон и Дон. Волга. мост мост мост.";
    const selection = annotatedFormsForVolume(store, { volume: 1, volumeText: text });
    ok(selection.ok, "the door ran on a Cyrillic record and a Cyrillic text");
    same(asForms(selection), ["Москва", "Нева"], "the same equality rule selects the same shape of form, with no Japanese anywhere in the fixture");
    same(selection.totals.refusedByRule, {
      "annotated-view-form-guided-several-ways": 1,
      "annotated-view-form-not-guided-every-time": 1,
      "annotated-view-form-used-more-than-twice": 1,
    }, "and all three guards fired, one per rule, on that text");

    const byForm = {};
    for (const item of selection.refused) byForm[item.form] = item;
    same(byForm["Волга"].rule, "annotated-view-form-guided-several-ways", "two readings over one form");
    same(byForm["Дон"].rule, "annotated-view-form-not-guided-every-time", "guided once, printed twice");
    same(byForm["мост"].rule, "annotated-view-form-used-more-than-twice", "guided three times, printed three times");

    const withRename = annotatedFormsForVolume(store, { volume: 1, volumeText: text, renameForms: ["мост"] });
    ok(withRename.forms.some((form) => form.form === "мост"), "and the caller's rename lifts the bound here too");

    const view = annotateChapterText(text, { forms: selection.forms });
    same(stripRubyMarkup(view.text), text, "the annotator's invariant holds on it");
    same(view.totals.annotatedOccurrences, 3, "two over one form and one over another");

    console.log("6. script neutrality: the same three guards, the same rule names, on a Cyrillic record and a Cyrillic chapter");
  } finally {
    store.close();
  }
}

// ─── 7. the door's own refusals, and the chapter door end to end ──────────────

/** Scenario 7. @returns {Promise<void>} */
async function scenarioChapterDoor() {
  const { store, volumeDir } = await openViewFixture("chapter");
  try {
    const volumeText = volumeOneChapters();
    const countsBefore = tableCounts(store);

    same(annotatedFormsForVolume(store, { volume: 0, volumeText }).refusal.rule, "annotated-view-volume-undecided", "a view with no volume number is refused: 'was it guided every time?' is a question about one book");
    same(annotatedFormsForVolume({ db: store.db }, { volumeText }).refusal.rule, "annotated-view-volume-undecided", "and a bare database handle is refused too, because the door would have no volume to ask about and no volume to refuse a forward look against");
    same(annotatedFormsForVolume(store, { volume: 2, volumeText }).refusal.rule, "annotated-view-cannot-look-forward", "and a view of a volume this record has not read is refused, the same no-forward rule the filing door applies (plan 07 §4.4)");
    same(annotatedFormsForVolume(store, { volume: 1 }).refusal.rule, "annotated-view-needs-the-volume-text", "and a view with no text to compare against is refused rather than annotating occurrences it has no evidence were guided");
    same(tableCounts(store), countsBefore, "each refusal wrote nothing");

    const chapterText = SOURCE_01.ch1.join("\n");
    const view = annotatedChapterView(store, { volume: 1, chapterText, volumeText });
    ok(view.ok, `the chapter door ran: ${view.refusal ? view.refusal.because : ""}`);
    same(stripRubyMarkup(view.text), chapterText, "the chapter round-trips through the view");
    same(view.view.totals.annotatedForms, 1, "one form this chapter actually prints is annotated");
    same(view.view.text, chapterText.replace("三色院菫子", rubyMarkupFor({ form: "三色院菫子", reading: "すみれこ" })), "and the guide sits over the one occurrence this chapter prints, with the rest of the chapter byte-identical");
    same(view.view.notInThisText, ["菫子"], "a form the volume selected but this chapter does not print is **named**, not silently missing: the selection is a claim about the whole book");
    same(view.selection.totals.formsSelected, 2, "two forms selected for the volume");
    same(view.view.totals.annotatedOccurrences, 1, "one occurrence in this chapter");

    const noChapter = annotatedChapterView(store, { volume: 1, volumeText });
    same(noChapter.refusal.rule, "annotated-view-needs-the-chapter-text", "and the door refuses when the chapter to show is missing, rather than guessing which chapter was meant");
    same(noChapter.text, "", "with no text invented");

    const emptyRecord = await openViewFixture("empty-record");
    try {
      emptyRecord.store.db.prepare("DELETE FROM written_forms").run();
      const nothing = annotatedFormsForVolume(emptyRecord.store, { volume: 1, volumeText });
      ok(nothing.ok, "a record with no written forms is not an error");
      same(nothing.forms, [], "it selects nothing");
      ok(/holds no written forms/.test(nothing.note), "and it says which fact about the record that is, rather than looking like a volume with nothing to show");
    } finally {
      emptyRecord.store.close();
    }

    ok(fs.readdirSync(volumeDir).some((name) => name === "series.db"), "the fixture wrote its record inside the fixture folder");
    same(tableCounts(store), countsBefore, "and the whole chapter door wrote no row");

    console.log("7. the chapter door: three refusals that store nothing, one annotated chapter, an unprinted form named, and an empty record that says so");
  } finally {
    store.close();
  }
}

// ─── 8. a quote copied out of an annotated chapter still verifies ─────────────

/** Scenario 8. @returns {Promise<void>} */
async function scenarioQuoteNormalisation() {
  const { store, volumeDir } = await openViewFixture("quote");
  try {
    const chapters = chapterFiles(volumeDir);
    const guideFreeLine = SOURCE_01.ch1[1]; // 三色院菫子は本を読んでいた。
    same(guideFreeLine, "三色院菫子は本を読んでいた。", "the fixture's guide-free line");

    const annotated = annotateChapterText(guideFreeLine, { forms: [{ form: "三色院菫子", reading: "すみれこ" }] });
    ok(hasRubyMarkup(annotated.text), "the line a model was shown carries the guide");

    const item = { volume: 1, chapter: "ch1", line: 2, quote: annotated.text };
    const verified = verifyEvidenceItem(item, () => ({ volumeDir, chapters, error: null }));
    ok(verified.ok, `a quote copied out of an annotated chapter verifies against the guide-free book: ${verified.problem}`);
    same(verified.item.matched, "verbatim", "and it matched verbatim, not by the loose skeleton rule — the guides came off and the rest was exact");
    same(verified.markupStripped, true, "and the store reports that it took them off: 'it matched' and 'it matched after the guides came off' stay two facts");

    const found = findQuoteEvidence(volumeDir, chapters, 1, annotated.text);
    ok(found.evidence, "the revision door's own quote rule finds the same line");
    same(found.markupStripped, true, "and says so too");

    const forged = verifyEvidenceItem({ volume: 1, chapter: "ch1", line: 2, quote: "<ruby>存在しない語<rt>にせもの</rt></ruby>は本を読んでいた。" }, () => ({ volumeDir, chapters, error: null }));
    same(forged.ok, false, "a quote that carries markup and is not in the book is still refused — stripping is not a licence");
    same(forged.markupStripped, true, "and the report says the markup was there");

    const wrongLine = verifyEvidenceItem({ volume: 1, chapter: "ch1", line: 3, quote: annotated.text }, () => ({ volumeDir, chapters, error: null }));
    same(wrongLine.ok, false, "and the line number still has to be right");
    ok(/chapter ch1 line 2/.test(wrongLine.problem), "with the place it actually is named in the refusal");

    // The skeleton half of the same rule: a reading written in Han characters is not part of the word.
    same(normalizeQuote("<ruby>達<rt>強制終了</rt></ruby>"), "達", "a guide written in Han characters strips out of the needle");
    same(quoteSkeleton("<ruby>達<rt>強制終了</rt></ruby>"), "達", "and out of the skeleton, which is the claim the book actually makes");
    same(prepareQuoteForSearch("guide-free"), { needle: "guide-free", skeleton: "", usable: true, markupStripped: false }, "a plain quote reports it stripped nothing");

    const evidenceLayer = readModuleLayer(ROOT, "utils/reference-store/evidence.js");
    ok(/stripRubyMarkup/.test(evidenceLayer), "the rule lives in the store's one quote normaliser, so no door can have a stricter opinion than another");

    console.log("8. quotes: an annotated line verifies verbatim against the guide-free book, a forged one is refused, and the strip is reported");
  } finally {
    store.close();
  }
}

// ─── 9. the parsers are taught before any published file may carry the markup ──

/** Scenario 9. @returns {void} */
function scenarioTaughtParsers() {
  // ── the voice reference ──
  const annotatedVoice = [
    "# Character Voice Reference",
    "",
    "## Characters",
    "",
    "### <ruby>蒲田<rt>かまた</rt></ruby>",
    "",
    "- **Catchphrases**: 「<ruby>蒲田<rt>かまた</rt></ruby>、気にすんな！」",
    "<ruby>蒲田<rt>かまた</rt></ruby> is named here with its guide.",
    "- **Notes**: 蒲田は笑った。",
    "This line wrapped from the bullet above it.",
  ].join("\n");

  const parsed = parseVoiceMarkdown(annotatedVoice);
  same(parsed.characters.length, 1, "one character section");
  same(parsed.characters[0].key, "蒲田", "THE HEADING IS THE WORD: an annotated heading keys onto the roster entry the guide-free book measures, not onto the markup");
  same(parsed.characters[0].entries.length, 2, "and the two bullets are still two bullets");
  same(parsed.characters[0].entries[0].body, "「<ruby>蒲田<rt>かまた</rt></ruby>、気にすんな！」", "a bullet whose body carries markup is kept **verbatim** — rewriting a published claim's body is the damage this slice is told not to do");
  same(parsed.characters[0].entries[1].body, "蒲田は笑った。 This line wrapped from the bullet above it.", "and the ordinary continuation rule still works: a wrapped claim body is still glued onto its claim");

  const notGlued = parsed.annotatedLines.filter((line) => line.kind === "line-not-glued");
  same(notGlued.length, 1, "the markup-bearing line between the bullets is NOT glued onto the bullet above it");
  same(notGlued[0].line, "<ruby>蒲田<rt>かまた</rt></ruby> is named here with its guide.", "it is recorded on its own, named");
  ok(!parsed.characters[0].entries[0].body.includes("<ruby>蒲田<rt>かまた</rt></ruby> is named"), "which is the wrong-order proof: glued, the published claim body would read 「…！」 <ruby>蒲田<rt>かまた</rt></ruby> is named here with its guide. — markup welded onto the end of a claim, with no finding and no count that moves");

  const kinds = parsed.annotatedLines.map((line) => line.kind);
  same(kinds, ["heading", "bullet", "line-not-glued"], "heading, bullet and the line that was not glued, each named with what the parser did");
  same(parsed.annotatedLines[0].section, "蒲田", "and the heading is named by its guide-free name");

  const clean = parseVoiceMarkdown(VOICE_01);
  same(clean.annotatedLines, [], "every document this repository has ever published produces an empty annotated-line list — the teaching is behaviour-preserving today");
  same(clean.characters.map((c) => c.key), ["如月雨露", "大賀太陽", "三色院菫子"], "with the same keys it always produced");

  // ── the glossary table ──
  const cell = "<ruby>偽物<rt>にせもの</rt></ruby> / 偽者";
  same(storeTermSpans(cell), ["偽物", "偽者"], "a term cell is stripped BEFORE it is split on '/': splitting first cuts the ruby unit in half and the evidence rule then searches for half a tag pair as if it were a word");
  same(cell.split("/").map((part) => part.trim()), ["<ruby>偽物<rt>にせもの<", "rt><", "ruby>", "偽者"], "which is what the naive split produces — a closing tag carries a '/', so splitting first cuts the unit into three pieces and the evidence rule then searches for `rt><` as if it were a spelling of a word");
  same(carryForwardTermSpans(cell), ["偽物", "偽者"], "and the carry-forward gate's own reader agrees, through the same leaf — two independent readers of the same table cannot hold two definitions of a spelling");
  same(storeTermSpans("三つ編み魔王 / 三つ編み悪魔"), ["三つ編み魔王", "三つ編み悪魔"], "the ordinary multi-spelling cell is unchanged");

  const annotatedGlossary = [
    "# Glossary",
    "",
    "## <ruby>用語<rt>ようご</rt></ruby>",
    "",
    "| Japanese | English | Notes |",
    "|---|---|---|",
    `| ${cell} | The Fake | A row that carries a guide |`,
    "| 本 | Book | A row that does not |",
  ].join("\n");
  const glossary = parseGlossaryMarkdown(annotatedGlossary);
  same(glossary.rows.map((row) => row.section), ["用語", "用語"], "a guide over a section heading is not part of the heading: one markup-bearing heading cannot split one section into two");
  same(glossary.rows[0].term, cell, "the row's cells are kept exactly as the file wrote them");
  same(glossary.annotatedRows, [{ term: cell, section: "用語", columns: ["term"] }], "and the row that carried markup is **named**, with the column that carried it");
  same(glossary.annotatedRows.length, 1, "one annotated row out of two");

  const cleanGlossary = parseGlossaryMarkdown(GLOSSARY_01);
  same(cleanGlossary.annotatedRows, [], "the published fixture glossary produces an empty annotated-row list");

  console.log("9. parsers taught: the heading is the word, a guide is not a claim's continuation, a cell is stripped before it is split, and every published file produces an empty annotated list");
}

// ─── 10. nothing wired, nothing added ─────────────────────────────────────────

/** Folders that are not pipeline code — the same list `test/test-written-forms.js` states. */
const SKIP_DIRS = new Set(["node_modules", "test", "docs", "plan", "epub_source", "hooks", "calibration", "test-series"]);

/**
 * The pipeline's own `.js` files, so "no stage calls the view" is a scan and not a claim.
 * @param {string} [dir] @param {string[]} [out] @returns {string[]}
 */
function pipelineSourceFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      pipelineSourceFiles(full, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Scenario 10. @returns {void} */
function scenarioNothingWired() {
  const viewDir = path.join(ROOT, "utils", "reference-store", "written-forms", "view") + path.sep;
  const coverFile = path.join(ROOT, "utils", "reference-store", "written-forms.js");

  const files = pipelineSourceFiles();
  ok(files.length > 300, `the scan sees the pipeline's own code: ${files.length} files`);

  const doors = ["annotatedFormsForVolume", "annotateChapterText", "annotatedChapterView"];
  /** @type {string[]} */ const callers = [];
  /** @type {string[]} */ const harvestReaders = [];
  /** @type {string[]} */ const outsideRequires = [];
  const allowedRequires = new Set([
    path.join(ROOT, "types.js"),
    path.join(ROOT, "utils", "reference-store", "refusals.js"),
    path.join(ROOT, "utils", "reference-store", "ruby-markup.js"),
    path.join(ROOT, "utils", "reference-store", "written-forms", "rows.js"),
    path.join(viewDir, "select.js"),
    path.join(viewDir, "render.js"),
  ]);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const insideLayer = file.startsWith(viewDir);
    for (const door of doors) {
      if (new RegExp(`${door}\\s*\\(`).test(text) && !insideLayer) callers.push(`${path.relative(ROOT, file)} → ${door}`);
    }
    if (insideLayer) {
      // The view reads the rows the layer already filed. It is not a second reader of the harvest, which is
      // the rule that keeps `written-forms/file.js` the only door in this store that opens a book's markup.
      if (/readWrittenFormHarvest|writtenFormHarvestFiles|RUBY_GUIDE_FILE_SUFFIX|ruby-guides/.test(text)) harvestReaders.push(path.relative(ROOT, file));
      for (const match of text.matchAll(/require\((["'])([^"']+)\1\)/g)) {
        const resolved = require.resolve(match[2], { paths: [path.dirname(file)] });
        if (!allowedRequires.has(resolved)) outsideRequires.push(`${path.relative(ROOT, file)} → ${match[2]}`);
      }
    }
  }
  same(callers, [], "no stage, no step, no command and no door calls the view: the only mentions outside the layer would be a wiring this slice was told not to make");
  same(harvestReaders, [], "and the view reads the record's rows, never the harvest file — `written-forms/file.js` stays the only door in this store that reads a book's markup");
  same(outsideRequires, [], "the view layer requires nothing outside the store's refusals, the ruby leaf, the written-form rows and its own two siblings");

  same(SCHEMA_VERSION, 13, "no schema bump: the view is a read over rows that already exist");
  same(COUNTED_TABLES.filter((table) => /view|annotat/i.test(table)), [], "no new table");
  same(Object.keys(FINDING_LEVELS).length, 70, "the finding level table is still 70 kinds");
  same(Object.keys(FINDING_LEVELS).filter((kind) => /annotat|view-|-view/i.test(kind)), [], "and none of them is a view kind: a chapter with nothing to annotate is a fact about that book, not a defect (`ruby-harvest-missing` is the extraction audit's own kind and predates this slice)");
  same(Object.keys(FREEZE_DOORS).length, 12, "the freeze gate is still 12 doors");
  same(Object.keys(FREEZE_DOORS).filter((door) => /view|annotat/i.test(door)), [], "and no door is named for a view");
  same(Object.keys(STEP_ARTIFACT_SPECS).filter((step) => /view|annotat/i.test(step)), [], "no step declares an annotated-view artifact, because a view is never published");

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  same(Object.keys(packageJson.scripts).filter((name) => /view|annotat/i.test(name)), [], "no new manual command");

  const handleLayer = readModuleLayer(ROOT, "utils/reference-store/open.js");
  same(Object.keys(rs).filter((name) => /annotat/i.test(name)).length, 3, "three functions reach the store's barrel, and no verb was added to its handle");
  ok(!/annotat/i.test(handleLayer), "the store's handle gained no annotated-view verb: a view is a read, not a write scope");

  const coverNames = Object.keys(require(coverFile));
  for (const name of [...doors, "VIEW_MAX_USES_PER_VOLUME", "printedOccurrences"]) {
    ok(coverNames.includes(name), `the written-forms cover re-exports ${name}`);
  }
  const missingFromBarrel = coverNames.filter((name) => rs[name] === undefined);
  same(missingFromBarrel, [], `and every one of the cover's ${coverNames.length} names reaches the store's barrel (gotcha 151: a spread barrel drops a name a submodule forgot without saying so)`);

  const viewFiles = fs.readdirSync(viewDir).sort();
  same(viewFiles, ["chapter.js", "render.js", "select.js"], "the view is three files, one concern each, inside the layer it belongs to");
  for (const file of viewFiles) {
    const text = fs.readFileSync(path.join(viewDir, file), "utf8");
    ok(/@module utils\/reference-store\/written-forms\/view\//.test(text), `${file} declares its module name`);
    ok(!/process\.env/.test(text), `${file} reads no environment variable — the bound has no knob (AGENTS.md §4.3)`);
    ok(!/createAgentHandle|runOneShot|require\(["'].*harness/.test(text), `${file} reaches no model`);
  }
  ok(!fs.existsSync(path.join(ROOT, "annotated-view.js")), "and no command module at the repository root");

  console.log("10. nothing wired: 0 callers outside the layer, 0 harvest readers in it, 70 finding kinds, 12 freeze doors, schema 13, 0 new command, 0 new handle verb");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  scenarioLeaf();
  scenarioAnnotator();
  scenarioAnnotatorRefusals();
  await scenarioSelectionGuards();
  await scenarioRenameIsData();
  await scenarioScriptNeutral();
  await scenarioChapterDoor();
  await scenarioQuoteNormalisation();
  scenarioTaughtParsers();
  scenarioNothingWired();
  console.log(`\nannotated view: ${checks} checks, 0 model calls.`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * test/test-guide-free-search.js — every door that searches chapter text searches the guide-free
 * projection (plan 09 slice 1, 2026-10-16).
 *
 * WHY THIS SUITE EXISTS. Plan 09 decision 2 put the author's pronunciation guides back into the
 * extracted chapter as `<ruby>蒲田<rt>かまた</rt></ruby>`, with the word kept whole. That makes the
 * chapter file a different string from the string the book says, and every door that asks the file a
 * question has to ask it of the guide-free projection or it starts answering about the markup. Plan 07
 * slice 5 already put the strip inside the store's one quote normaliser, so the citation doors, the cast
 * presence measurement and the chapter-facts query were covered before this slice started. What was
 * **not** covered was the translate layer — which had no ruby rule at all — and one probe inside the
 * attribution layer. Measured over the 17 real books (`/tmp/opencode/p09s1-measure-raw-doors.js`,
 * 0 model calls, 0 database opens, 0 corpus writes):
 *
 *   - `selectTermsForChapter` missed **450** glossary terms the book prints (they never reached a
 *     translator) and found **67** that occur only inside a reading — a terminology constraint invented
 *     from a guide;
 *   - `checkTranslationQa` measured the source at ×1.334 median / ×2.358 maximum its real length, and at
 *     that inflation **34 of the 133 chapters** turn a draft sitting on the JA→ZH band's own minimum into
 *     a number under the truncation floor — a HARD failure, a complete translation reported as cut off;
 *   - `locateQuoteRange` could not find **159 of 979** guide-free quotes sampled out of the real chapters,
 *     so those findings became "chapter-wide" and the whole chapter was translated again to fix one
 *     sentence;
 *   - the reading-aid probe was blind to a name whose kanji the markup separates, and found **5 of the
 *     13** Han-script readings in the harvest as if they were words the book prints;
 *   - `lineSpeechKind` diverges on **0** of the 25,790 annotated lines — closed because it is the shape,
 *     not because it was found firing.
 *
 * What the suite pins, scenario by scenario:
 *
 *   1. the fixture chapter, annotated, and the projection it must produce;
 *   2. the citation door: whole-word annotation found, piece-by-piece annotation found, a phrase across
 *      two annotated words found, a quote made by pasting a guide into the word **refused**, and the
 *      furiganed citation the skeleton rung exists for **still accepted**;
 *   3. `locateQuoteRange`, including the forged shape staying unfound;
 *   4. `planTargetedRepair`, including the length-plausibility check measuring the book rather than the
 *      file, and a genuinely wrong alignment still being refused;
 *   5. `selectTermsForChapter`, both directions;
 *   6. `checkTranslationQa`, both directions, and a source that is only markup being an empty source;
 *   7. the reading-aid probe, both directions;
 *   8. `lineSpeechKind`;
 *   9. `cast_presence_match` and the chapter-facts query answering **identically** with and without the
 *      markup, through the store's own doors on two fixture records;
 *  10. the citation door refusing a forged quote at `insertFact`, and naming the fix;
 *  11. that nothing else moved: the level table, the schema, the counted tables, the freeze doors, the
 *      npm scripts, and the translate layer naming the one ruby rule instead of restating it.
 *
 * Fixtures only, under the shared fixture root. Nothing here reads the real 17 volumes or any file under
 * the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69). The real-corpus
 * numbers above come from the measurement scripts named in
 * `utils/source/plan/02-reading-aids-in-the-text.md`.
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rs = require("../utils/reference-store");
const translate = require("../utils/translate");
const { readModuleLayer } = require("./module-layer");
const { fixtureStoreSeries, assertInsideFixture } = require("./fixture-reference-store");

const {
  openReferenceStore,
  upsertCast,
  recordCastPresence,
  castNamedInChapterText,
  chapterKnownFacts,
  matchQuoteOnLine,
  quoteExistsOnlyAsGuideSplice,
  prepareQuoteForSearch,
  SCHEMA_VERSION,
  COUNTED_TABLES,
} = rs;
const { stripRubyMarkup, hasRubyMarkup, rubyMarkupUnitCount, guideSplicedTextOf } = require("../utils/reference-store/ruby-markup");
const { lineSpeechKind } = require("../utils/reference-store/attribution/lines");
const { readingAidSpan, hanCharacters } = require("../utils/reference-store/attribution/reading-aids");
const { countOccurrences } = require("../utils/translate/qa");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { FREEZE_DOORS } = require("../utils/prereqs/freeze");
const { BUNDLE_SCHEMA_VERSION } = require("../utils/source/config");

const { paragraphBlocks, locateQuoteRange, planTargetedRepair, selectTermsForChapter, checkTranslationQa } = translate;

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

// ─── The fixture text ─────────────────────────────────────────────────────────

/**
 * One chapter as the extraction writes it now: every guide kept, as markup, over a word that stays whole.
 *
 * The prose lines are the shapes this slice is about: a whole-word guide, a name guided across **two**
 * elements, a phrase spanning two separately annotated words, a guide written in Han characters (a phrase
 * gloss, whose reading is a string a naive search calls a word), the old piece-by-piece markup shape a
 * hand-edited file can still hold, and a line that opens with an annotated bracket.
 *
 * @type {string[]}
 */
const ANNOTATED_LINES = [
  "# 第一章",
  "<ruby>蒲田<rt>かまた</rt></ruby>は廊下で立ち止まった。",
  "<ruby>三色院<rt>さんしよくいん</rt></ruby><ruby>菫子<rt>すみれこ</rt></ruby>は本を読んでいた。",
  "<ruby>図書室<rt>としょしつ</rt></ruby>の<ruby>三文字<rt>もじ</rt></ruby>を眺めた。",
  "<ruby>達の戦いはこれからだ<rt>強制終了</rt></ruby>と彼は言った。",
  "<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。",
  "<ruby>「<rt>かぎ</rt></ruby>気にすんな！」と<ruby>如月雨露<rt>きさらぎあまつゆ</rt></ruby>が言った。",
];

/** The same chapter with every guide taken off: the string the book says. @type {string[]} */
const GUIDE_FREE_LINES = [
  "# 第一章",
  "蒲田は廊下で立ち止まった。",
  "三色院菫子は本を読んでいた。",
  "図書室の三文字を眺めた。",
  "達の戦いはこれからだと彼は言った。",
  "蒲田を見た。",
  "「気にすんな！」と如月雨露が言った。",
];

// Paragraphs are separated by a blank line, which is what `paragraphBlocks` splits on and what the
// extraction writes between a chapter's paragraphs.
const ANNOTATED_CHAPTER = ANNOTATED_LINES.join("\n\n") + "\n";
const GUIDE_FREE_CHAPTER = GUIDE_FREE_LINES.join("\n\n") + "\n";

/** The 1-based line `readChapterLines` reports for the 蒲田 line of the fixture chapter. */
const KAMADA_LINE = ANNOTATED_CHAPTER.split(/\r?\n/).indexOf(ANNOTATED_LINES[1]) + 1;

/** The roster this fixture measures: three people the book prints and one string that is only ever a reading. */
const CAST_KEYS = ["蒲田", "三色院菫子", "如月雨露", "強制終了"];

/**
 * Lay out a fixture series and replace volume 01's `ch1` with one of the two chapter texts.
 *
 * Two runs of this, one per projection, is the A/B: same folder shape, same chapter ids, same plan of
 * record, only the guides different.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @param {string} chapterText - What `ch1` holds.
 * @returns {{fx: Object, volumeDir: string, chapterFile: string}}
 */
function fixtureWithChapter(label, chapterText) {
  const fx = fixtureStoreSeries(label);
  const volumeDir = path.join(fx.dir, "Test Story(01)");
  const chapterFile = "test_story(1)-ch1.md";
  fs.writeFileSync(path.join(volumeDir, chapterFile), chapterText, "utf8");
  assertInsideFixture(volumeDir, fx.dir);
  return { fx, volumeDir, chapterFile };
}

/**
 * Open volume 01's record over a fixture laid out by `fixtureWithChapter`, with the roster filed.
 *
 * @param {string} label
 * @param {string} chapterText
 * @returns {{fx: Object, store: Object, volumeDir: string}}
 */
function storeOverFixture(label, chapterText) {
  const { fx, volumeDir } = fixtureWithChapter(label, chapterText);
  const store = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: fx.dir });
  store.registerChaptersFromSource();
  for (const key of CAST_KEYS) {
    const filed = upsertCast(store, { key, display: key, firstSeenVolume: 1 });
    assert.ok(filed.ok, `the fixture cast entry ${key} should file: ${filed.refusal && filed.refusal.because}`);
  }
  return { fx, store, volumeDir };
}

// ─── Scenario 1 — the fixture, and the projection ─────────────────────────────

/**
 * The fixture is only worth trusting if the annotated chapter really is the guide-free chapter plus
 * markup and nothing else.
 * @returns {void}
 */
function scenarioTheProjection() {
  same(ANNOTATED_LINES.map(stripRubyMarkup), GUIDE_FREE_LINES, "the guide-free projection of the annotated chapter is the chapter the book says, line for line");
  ok(!hasRubyMarkup(GUIDE_FREE_CHAPTER), "and the projection carries no markup at all");
  same(rubyMarkupUnitCount(ANNOTATED_CHAPTER), 9, "the annotated chapter carries 9 ruby units (the piece-by-piece line is ONE unit carrying two readings)");
  ok(ANNOTATED_CHAPTER.length > GUIDE_FREE_CHAPTER.length, "the annotated file is longer than the book, which is the whole reason this slice exists");
  // The piece-by-piece shape is the one the converter no longer writes and a hand-edited file can still hold.
  same(stripRubyMarkup(ANNOTATED_LINES[5]), "蒲田を見た。", "a word guided piece by piece strips back to the word, not to the interleaving");
  same(guideSplicedTextOf(ANNOTATED_LINES[5]), "蒲かま田たを見た。", "and flattening the same line keeps the interleaving — the shape a forged quote takes");
}

// ─── Scenario 2 — the citation door ───────────────────────────────────────────

/**
 * The store's matching rule, on the annotated line, in both directions.
 * @returns {void}
 */
function scenarioTheCitationDoor() {
  /**
   * Assert one (line, quote) pair matches by one rule.
   * @param {string} line @param {string} quote @param {string|null} expected @param {string} why
   * @returns {void}
   */
  function matchAs(line, quote, expected, why) {
    const matched = matchQuoteOnLine(line, quote);
    checks++;
    assert.strictEqual(matched, expected, `${why} (got ${JSON.stringify(matched)})`);
  }

  matchAs(ANNOTATED_LINES[1], "蒲田", "verbatim", "a name the book annotates as a whole is found");
  matchAs(ANNOTATED_LINES[2], "三色院菫子", "verbatim", "a name the book annotates across TWO elements is found");
  matchAs(ANNOTATED_LINES[3], "図書室の三文字", "verbatim", "a phrase spanning two separately annotated words is found");
  matchAs(ANNOTATED_LINES[3], "<ruby>図書室<rt>としょしつ</rt></ruby>の三文字", "verbatim", "and a quote that copied the markup off the page is found too, because the guides come off the quote");

  // The forgery this slice was written to close: the reading pasted into the word.
  const forgedCanonical = "蒲田かまたは廊下で立ち止まった。";
  matchAs(ANNOTATED_LINES[1], forgedCanonical, null, "a quote that exists only as the flattened markup is refused");
  ok(
    quoteExistsOnlyAsGuideSplice(ANNOTATED_LINES[1], prepareQuoteForSearch(forgedCanonical)),
    "and the refusal names the shape it is: the guide spliced into the word"
  );
  matchAs(ANNOTATED_LINES[5], "蒲かま田たを見た。", null, "the same forgery on a piece-by-piece line is refused");

  // The rung the guard must not break: two furiganed spellings of one term, no markup in the file at all.
  const furiganedLine = "秋野あきの桜さくらは廊下で立ち止まった。";
  matchAs(furiganedLine, "秋野桜", "skeleton", "the skeleton rung still matches a term written out with its reading aids between the characters");
  same(
    quoteExistsOnlyAsGuideSplice(furiganedLine, prepareQuoteForSearch("秋野桜")),
    false,
    "and the guard is inert on a line with no markup: flattening changes nothing there"
  );

  // The named limit, written down rather than hidden. The OLD converter's interleaving is not the
  // flattened shape of canonical markup, so a quote that REORDERS it is not caught by this door; it is
  // caught by `guide-split-in-text` in the extraction audit, which reads the harvest.
  matchAs(
    ANNOTATED_LINES[5],
    "蒲田かまたを見た。",
    "skeleton",
    "LIMIT: a quote that reorders a piece-by-piece interleaving still matches by skeleton — the pairing lives only in the harvest, and this door may not open it"
  );
}

// ─── Scenario 3 — locateQuoteRange ────────────────────────────────────────────

/**
 * The passage-repair door finds a guide-free quote in an annotated chapter.
 * @returns {void}
 */
function scenarioLocateQuoteRange() {
  const annotatedBlocks = paragraphBlocks(ANNOTATED_CHAPTER);
  const guideFreeBlocks = paragraphBlocks(GUIDE_FREE_CHAPTER);
  same(annotatedBlocks.length, guideFreeBlocks.length, "markup does not change how many paragraphs a chapter has");

  same(
    locateQuoteRange(annotatedBlocks, "三色院菫子は本を読んでいた"),
    { start: 2, end: 2 },
    "a guide-free quote copied out of an annotated chapter locates the paragraph it came from"
  );
  same(
    locateQuoteRange(annotatedBlocks, "蒲田かまたは廊下で立ち止まった"),
    null,
    "and the forged shape is still not located: it is not text the chapter holds in either projection"
  );
  same(
    locateQuoteRange(annotatedBlocks, "<ruby>蒲田<rt>かまた</rt></ruby>は廊下で"),
    { start: 1, end: 1 },
    "a quote that kept the markup locates too, because both sides are normalised"
  );
  same(locateQuoteRange(annotatedBlocks, "存在しない文章"), null, "a quote that is not in the source is still not found");
  same(locateQuoteRange(annotatedBlocks, ""), null, "and an empty quote is not a location");

  // A quote that crosses a paragraph boundary still claims BOTH paragraphs, markup notwithstanding.
  const blocks = paragraphBlocks(
    "<ruby>蒲田<rt>かまた</rt></ruby>は立ち止まった。\n\n三色院菫子は本を読んでいた。\n\n如月雨露は窓を見た。"
  );
  same(locateQuoteRange(blocks, "立ち止まった。三色院菫子は本を"), { start: 0, end: 1 }, "a cross-paragraph quote still claims both paragraphs");
}

// ─── Scenario 4 — planTargetedRepair ──────────────────────────────────────────

/**
 * The repair plan is usable on an annotated chapter, and its plausibility check measures the book.
 * @returns {void}
 */
function scenarioPlanTargetedRepair() {
  const guideFreeSource = ["蒲田は廊下で立ち止まった。三色院菫子は本を読んでいた。", "如月雨露は窓を見た。言葉が頭に浮かんだ。"].join("\n\n");
  const annotatedSource = [
    "<ruby>蒲田<rt>かまた</rt></ruby>は<ruby>廊下<rt>ろうか</rt></ruby>で立ち止まった。<ruby>三色院<rt>さんしよくいん</rt></ruby><ruby>菫子<rt>すみれこ</rt></ruby>は本を読んでいた。",
    "<ruby>如月雨露<rt>きさらぎあまつゆ</rt></ruby>は<ruby>窓<rt>まど</rt></ruby>を見た。言葉が頭に浮かんだ。",
  ].join("\n\n");
  same(stripRubyMarkup(annotatedSource), guideFreeSource, "the annotated fixture is the guide-free fixture plus markup");

  const draft = ["Kamada stopped in the corridor.", "Kirisame looked at the window."].join("\n\n");
  const findings = '1. The rendering is stiff.\n   Source: "三色院菫子は本を読んでいた"';

  const onAnnotated = planTargetedRepair({ sourceText: annotatedSource, draftText: draft, findingsText: findings });
  ok(onAnnotated.usable, `the passage repair is usable on the annotated chapter: ${onAnnotated.reason}`);
  same(onAnnotated.blocks.length, 1, "and it names one passage");

  // The same plan measured the way it used to be: the source side of the ratio taken off the raw file.
  const rawBlocks = paragraphBlocks(annotatedSource);
  const guideFreeBlocks = paragraphBlocks(guideFreeSource);
  const draftBlocks = paragraphBlocks(draft);
  const rawRatio = draftBlocks[0].length / rawBlocks[0].length;
  const bookRatio = draftBlocks[0].length / guideFreeBlocks[0].length;
  ok(rawRatio < 0.25, `the raw measurement would have refused this repair (ratio ${rawRatio.toFixed(2)}, under the 0.25 floor) — that is the bug`);
  ok(bookRatio >= 0.25, `and the book's own ratio is comfortably inside the band (${bookRatio.toFixed(2)})`);

  const implausible = planTargetedRepair({
    sourceText: annotatedSource,
    draftText: ["x".repeat(600), "Kirisame looked at the window."].join("\n\n"),
    findingsText: findings,
  });
  ok(!implausible.usable, "a draft paragraph that is not a rendering of its source paragraph is still refused");
  ok(/length ratio/.test(implausible.reason), `and the refusal says why: ${implausible.reason}`);
}

// ─── Scenario 5 — selectTermsForChapter ───────────────────────────────────────

/**
 * The terminology door selects the terms the chapter prints, in both directions.
 * @returns {void}
 */
function scenarioSelectTermsForChapter() {
  const terms = [
    { term: "蒲田", rendering: "Kamada", section: "Characters" },
    { term: "三色院菫子", rendering: "Sumireko", section: "Characters" },
    { term: "図書室の三文字", rendering: "the three characters", section: "Phrases" },
    { term: "強制終了", rendering: "Forced End", section: "Phrases" },
    { term: "存在しない語", rendering: "Nothing", section: "Phrases" },
  ];

  const onAnnotated = selectTermsForChapter(terms, ANNOTATED_CHAPTER, { maxChars: 100000 });
  const onGuideFree = selectTermsForChapter(terms, GUIDE_FREE_CHAPTER, { maxChars: 100000 });
  same(onAnnotated.terms.map((t) => t.term), onGuideFree.terms.map((t) => t.term), "the door selects the same terms from the annotated file and from the book");
  same(
    onAnnotated.terms.map((t) => t.term),
    ["蒲田", "三色院菫子", "図書室の三文字"],
    "the terms the book prints are selected, including the two that only exist across markup boundaries"
  );
  ok(!onAnnotated.terms.some((t) => t.term === "強制終了"), "a term that occurs ONLY inside a reading is not selected — the book never prints it as a word");
  ok(!onAnnotated.terms.some((t) => t.term === "存在しない語"), "and a term the chapter does not print at all is still not selected");

  // Both halves of the real-corpus measurement, reproduced on the fixture.
  ok(countOccurrences(ANNOTATED_CHAPTER, "三色院菫子") === 0, "the RAW search cannot see the term the book prints (the 450 measured misses)");
  ok(countOccurrences(ANNOTATED_CHAPTER, "強制終了") > 0, "and the RAW search can see a term the book does not print (the 67 measured inventions)");
  ok(countOccurrences(GUIDE_FREE_CHAPTER, "三色院菫子") > 0, "the guide-free search sees the term");
  ok(countOccurrences(GUIDE_FREE_CHAPTER, "強制終了") === 0, "and does not see the reading");
}

// ─── Scenario 6 — checkTranslationQa ──────────────────────────────────────────

/**
 * The deterministic QA gate measures the book, not the file.
 * @returns {void}
 */
function scenarioCheckTranslationQa() {
  const guideFreeSource = "蒲田は廊下で立ち止まった。三色院菫子は本を読んでいた。如月雨露は窓を見た。";
  const annotatedSource =
    "<ruby>蒲田<rt>かまた</rt></ruby>は<ruby>廊下<rt>ろうか</rt></ruby>で立ち止まった。" +
    "<ruby>三色院<rt>さんしよくいん</rt></ruby><ruby>菫子<rt>すみれこ</rt></ruby>は本を読んでいた。" +
    "<ruby>如月雨露<rt>きさらぎあまつゆ</rt></ruby>は<ruby>窓<rt>まど</rt></ruby>を見た。";
  same(stripRubyMarkup(annotatedSource), guideFreeSource, "the fixture source is the book plus markup");

  // A JA→ZH draft sitting on the band's own minimum against the guide-free source (min 0.8, truncation 0.5).
  const draft = "他在走廊里停下脚步，翻开书读了一会儿，然后望向窗外，久久没有说话。";
  const terms = [
    { term: "蒲田", rendering: "卡玛达" },
    { term: "三色院菫子", rendering: "紫岭子" },
    { term: "強制終了", rendering: "强制终结" },
  ];
  const JA_ZH = { sourceLanguage: "Japanese", targetLanguage: "Chinese" };

  const qa = checkTranslationQa({ sourceText: annotatedSource, draftText: draft, terms, ...JA_ZH });
  const bookRatio = draft.length / guideFreeSource.length;
  const fileRatio = draft.length / annotatedSource.length;

  ok(Math.abs(qa.lengthRatio - bookRatio) < 1e-9, `the length ratio is measured on the guide-free source (${qa.lengthRatio.toFixed(4)} vs ${bookRatio.toFixed(4)})`);
  ok(fileRatio < 0.5, `the raw measurement would have put this chapter under the JA→ZH truncation floor (${fileRatio.toFixed(4)}) — a HARD failure for a complete translation`);
  ok(bookRatio >= 0.8, `the true ratio sits on the band's own minimum (${bookRatio.toFixed(4)})`);
  ok(qa.ok, `and the chapter passes: ${qa.errors.join(" ")}`);

  ok(!qa.missingTerms.some((t) => t.term === "強制終了"), "a glossary term that occurs only inside a reading is not reported missing from the draft");
  ok(qa.missingTerms.some((t) => t.term === "三色院菫子"), "a term the chapter prints and the draft drops is still reported missing");
  ok(qa.missingTerms.some((t) => t.term === "蒲田"), "and so is the other one");

  const onlyMarkup = checkTranslationQa({ sourceText: "<ruby><rt>よみ</rt></ruby>", draftText: "何かがある。", terms: [], ...JA_ZH });
  ok(!onlyMarkup.ok, "a source that is nothing but markup is an empty source, not a chapter");
  ok(onlyMarkup.errors.some((e) => /source is empty/.test(e)), `and the error says so: ${onlyMarkup.errors.join(" ")}`);

  // The residue check reads the DRAFT, and the draft carries no markup: unchanged by this slice.
  const echoed = checkTranslationQa({ sourceText: annotatedSource, draftText: annotatedSource, terms: [], ...JA_ZH });
  ok(!echoed.ok, "a draft that echoes the source still fails");
  ok(echoed.cjk > 0.05, `and the residue number is the draft's own (${echoed.cjk.toFixed(3)})`);
}

// ─── Scenario 7 — the reading-aid probe ───────────────────────────────────────

/**
 * The probe answers about the book, in both directions.
 * @returns {void}
 */
function scenarioReadingAidProbe() {
  const kamada = hanCharacters("蒲田");
  ok(readingAidSpan(ANNOTATED_LINES[5], kamada) !== null, "a name whose kanji the markup separates is found (the raw search refused it: onlyReadingAids rejects `<rt>かま</rt>`)");
  ok(readingAidSpan(GUIDE_FREE_LINES[5], kamada) !== null, "and the same name in the guide-free line is found, unchanged");
  same(
    readingAidSpan(ANNOTATED_LINES[5], kamada).span,
    readingAidSpan(GUIDE_FREE_LINES[5], kamada).span,
    "the span the probe reports is the same string in both projections"
  );

  // The other direction: a guide written in Han characters is not a word the book prints.
  const gloss = hanCharacters("強制終了");
  ok(readingAidSpan(ANNOTATED_LINES[4], gloss) === null, "a Han-script reading is NOT found as a name — the book prints 達の戦いはこれからだ, not 強制終了 (the 5 measured false hits)");
  ok(readingAidSpan(GUIDE_FREE_LINES[4], gloss) === null, "and it is not found in the guide-free line either");

  // The probe's own bound still holds: a long kana run between two kanji is a sentence, not a name.
  ok(readingAidSpan("蒲" + "か".repeat(5) + "田を見た", kamada) === null, "a gap longer than READING_AID_MAX_GAP is still not a name");
  ok(readingAidSpan("蒲を田を見た", kamada) !== null, "and a short kana gap still is one — that rule is unchanged by this slice");
}

// ─── Scenario 8 — lineSpeechKind ──────────────────────────────────────────────

/**
 * What a line IS is decided from the line, not from its tags.
 * @returns {void}
 */
function scenarioLineSpeechKind() {
  same(lineSpeechKind(ANNOTATED_LINES[6]), "dialogue", "a line that opens with an annotated opening bracket is speech");
  same(lineSpeechKind(GUIDE_FREE_LINES[6]), "dialogue", "and the guide-free line was always speech");
  same(lineSpeechKind(ANNOTATED_LINES[1]), "narration", "a line that opens with an annotated word is still narration");
  same(lineSpeechKind(ANNOTATED_LINES[4]), "narration", "and a phrase-glossed line is narration");
  same(lineSpeechKind(undefined), "narration", "a missing line is not a crash");
}

// ─── Scenario 9 — presence and the chapter-facts query, both projections ──────

/**
 * `cast_presence_match` and the chapter-facts query answer identically with and without the markup.
 *
 * Two fixture records, built the way the store builds them, holding the same roster and the same book —
 * one file with the guides, one without. Every answer compared.
 * @returns {void}
 */
function scenarioPresenceAndChapterFacts() {
  const annotated = storeOverFixture("gfs-presence-annotated", ANNOTATED_CHAPTER);
  const plain = storeOverFixture("gfs-presence-guidefree", GUIDE_FREE_CHAPTER);

  const measuredAnnotated = recordCastPresence(annotated.store);
  const measuredPlain = recordCastPresence(plain.store);
  ok(measuredAnnotated.ok && measuredPlain.ok, "both volumes are measured");
  same(measuredAnnotated.present, measuredPlain.present, "the same characters are present with and without the markup");
  same(measuredAnnotated.absent, measuredPlain.absent, "and the same ones are absent");
  same(measuredAnnotated.matchRows, measuredPlain.matchRows, "and the same number of match rows are filed");

  /**
   * The presence rows, in a comparable shape.
   * @param {Object} store
   * @returns {Array<Object>}
   */
  function presenceRows(store) {
    return store.db
      .prepare("SELECT volume, key, present, matched, chapter, line, chapters, matches FROM cast_presence ORDER BY key")
      .all()
      .map((r) => ({ ...r, present: Boolean(r.present) }));
  }
  /**
   * The per-match rows, in a comparable shape.
   * @param {Object} store
   * @returns {Array<Object>}
   */
  function matchRows(store) {
    return store.db.prepare("SELECT volume, key, chapter, line, name, matched FROM cast_presence_match ORDER BY key, chapter, line, name").all();
  }

  same(presenceRows(annotated.store), presenceRows(plain.store), "every cast_presence row is identical across the two projections");
  same(matchRows(annotated.store), matchRows(plain.store), "every cast_presence_match row is identical, including which rule proved it");

  const present = presenceRows(annotated.store).filter((r) => r.present).map((r) => r.key);
  ok(present.includes("蒲田"), "蒲田 is present — annotated as a whole in one line and piece by piece in another");
  ok(present.includes("三色院菫子"), "三色院菫子 is present — printed only across two annotated elements");
  ok(!present.includes("強制終了"), "強制終了 is absent — it is a reading, and the book never prints it as a word");

  // The chapter-facts query, asked the same question both ways, on the SAME record.
  same(
    castNamedInChapterText(annotated.store, ANNOTATED_CHAPTER),
    castNamedInChapterText(annotated.store, GUIDE_FREE_CHAPTER),
    "the chapter-facts roster query answers identically when handed the annotated file and the book"
  );
  const factsFromAnnotated = chapterKnownFacts(annotated.store, { chapterText: ANNOTATED_CHAPTER, volume: 1 });
  const factsFromGuideFree = chapterKnownFacts(annotated.store, { chapterText: GUIDE_FREE_CHAPTER, volume: 1 });
  same(
    {
      namedCount: factsFromAnnotated.namedCount,
      claimsShown: factsFromAnnotated.claimsShown,
      characters: factsFromAnnotated.characters.map((c) => c.key),
    },
    {
      namedCount: factsFromGuideFree.namedCount,
      claimsShown: factsFromGuideFree.claimsShown,
      characters: factsFromGuideFree.characters.map((c) => c.key),
    },
    "and the block a chapter is shown does not move either"
  );
}

// ─── Scenario 10 — the citation door refuses the forged quote at the door ─────

/**
 * The refusal is not only a matching rule: it is what `insertFact` does to a forged citation.
 * @returns {void}
 */
function scenarioTheDoorRefuses() {
  const { fx, store } = storeOverFixture("gfs-citation", ANNOTATED_CHAPTER);
  assertInsideFixture(path.join(fx.dir, "series.db"), fx.dir);

  const legit = store.insertFact({
    key: "蒲田",
    cast: { display: "蒲田" },
    aspect: "catchphrase",
    label: "Catchphrases",
    body: "Stops in the corridor.",
    evidence: [{ volume: 1, chapter: "ch1", line: KAMADA_LINE, quote: "蒲田は廊下で立ち止まった。" }],
  });
  ok(legit.ok, `a guide-free citation of an annotated line files: ${legit.refusal && legit.refusal.because}`);
  const storedEvidence = typeof legit.fact.evidence === "string" ? JSON.parse(legit.fact.evidence) : legit.fact.evidence;
  same(storedEvidence[0].matched, "verbatim", "and it is stamped with the rule that proved it");

  const forged = store.insertFact({
    key: "蒲田",
    cast: { display: "蒲田" },
    aspect: "catchphrase",
    label: "Catchphrases",
    body: "A citation built out of a pronunciation guide.",
    evidence: [{ volume: 1, chapter: "ch1", line: KAMADA_LINE, quote: "蒲田かまたは廊下で立ち止まった。" }],
  });
  ok(!forged.ok, "a citation built by pasting the reading into the word is refused");
  const refusalText = JSON.stringify(forged.refusal || {});
  ok(/Quote the line, not the reading\./.test(refusalText), `and the refusal says what to do instead: ${refusalText.slice(0, 400)}`);

  const filed = store.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n;
  same(filed, 1, "the legitimate claim is the only one that reached the table");
}

// ─── Scenario 11 — nothing else moved ─────────────────────────────────────────

/**
 * The slice fixed doors. It added no level, no table, no door, no command, and no second ruby rule.
 * @returns {void}
 */
function scenarioNothingElseMoved() {
  const levels = Object.keys(FINDING_LEVELS);
  same(levels.length, 72, "the finding level table is still 72 kinds (the two new ones are plan 09 slice 1's extraction checks)");
  const tally = {};
  for (const kind of levels) tally[FINDING_LEVELS[kind].level] = (tally[FINDING_LEVELS[kind].level] || 0) + 1;
  same(tally, { STOP: 19, MAJOR: 31, MINOR: 16, NOTE: 6 }, "and the level split is the one this slice declared");

  same(SCHEMA_VERSION, 13, "no schema bump");
  same(COUNTED_TABLES.length, 21, "no counted table added");
  same(Object.keys(FREEZE_DOORS).length, 12, "no freeze door added");
  same(BUNDLE_SCHEMA_VERSION, 10, "the bundle schema is the one this slice's measurements justified");

  const scripts = Object.keys(require(path.join(ROOT, "package.json")).scripts);
  same(scripts.length, 20, "no npm script added");

  // The translate layer names the store's one ruby rule and carries no ruby pattern of its own.
  const translateLayer = readModuleLayer(ROOT, "utils/translate.js");
  for (const file of ["qa.js", "terminology.js", "repair.js"]) {
    const source = fs.readFileSync(path.join(ROOT, "utils/translate", file), "utf8");
    ok(/reference-store\/ruby-markup/.test(source), `utils/translate/${file} reaches the store's one ruby rule`);
    ok(!/new RegExp\([^)]*ruby/i.test(source) && !/RUBY_TAG/.test(source), `and utils/translate/${file} builds no ruby pattern of its own`);
  }
  ok(translateLayer.includes("function checkTranslationQa"), "the layer the scan followed is the real one");

  // `utils/source/` still does not reach back into the reference store (the layer-inversion rule).
  const sourceLayer = readModuleLayer(ROOT, "utils/source.js");
  ok(!/require\((["'])\.\.\/reference-store/.test(sourceLayer), "utils/source/ still requires no reference-store module");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const started = Date.now();
scenarioTheProjection();
scenarioTheCitationDoor();
scenarioLocateQuoteRange();
scenarioPlanTargetedRepair();
scenarioSelectTermsForChapter();
scenarioCheckTranslationQa();
scenarioReadingAidProbe();
scenarioLineSpeechKind();
scenarioPresenceAndChapterFacts();
scenarioTheDoorRefuses();
scenarioNothingElseMoved();

console.log(
  `test/test-guide-free-search.js: 11 scenarios, ${checks} checks, ${Date.now() - started} ms, 0 model calls, 0 corpus reads`
);

#!/usr/bin/env node
/**
 * test/test-source-quality-reports.js — the book is allowed to be wrong, and saying so is a query.
 *
 * Plan 07 slice 2b. Two reports, both built from rows the record already holds, both filing nothing:
 *
 *   **variant spellings** — the groups plan 07 §2.10 splits off the 79 the roster cannot see, printed the
 *   way a dictionary prints *color* / *colour*: both spellings, both counts, no verdict.
 *   **inconsistent guidance** — the author's own pronunciation notes disagreeing in one place. The one
 *   shape this report calls a defect is two guided strings made of **the same characters in a different
 *   order**, which is what the plan's real case is: 三色院董子 guided さんしよくいん**すみれ**こ and
 *   さんしよくいん**すれみ**こ in volume 17 chapter 5, **1 row in 10,005**.
 *
 * What the suite has to prove is not only that the right shape fires. It is that the **wrong** shapes stay
 * silent, because plan 07 §2.11(b) is a record of this plan publishing a real name as a source error:
 *
 *   1. **the variant report reproduces the planted split** and names both spellings with their counts.
 *   2. **the 54-class is named and not reported** — 美味 / 上手 and 披露 / 疲労 are sound-alikes, and a rule
 *      that called them defects would cry wolf 54 times over 17 legitimate books.
 *   3. **chapter scope is real, in both directions**: 嫌 guided いや and きら in one chapter is a collision;
 *      頼 guided たの in one chapter and たよ in another is not; 偽物 and 偽者 under one reading in **two
 *      chapters** produce no collision, and 貴女 and 貴方 under one reading in **one chapter** do.
 *   4. **the transposed reading is the anomaly and the legitimate multi-reading word is not.**
 *   5. **董子 and 如雨露 come back silent.** 董子 is guided, concentrated in one chapter, and already on the
 *      roster — the exact shape §2.11(b) withdrew — and 如雨露 is a name written short in every book.
 *      Neither is an anomaly, and neither is in any collision at all in 如雨露's case.
 *   6. **the naive "10× more common" rule is a rejected alternative, and it is measurably rejected**: run
 *      against the same rows the report reads it flags 達 ×48 / 性質 ×2 and 花凛 ×90 / 凛 ×3 and finds
 *      nothing about the real defect, and **no door calls it**. 込 / 子 / 木 all read こ never even reach
 *      the record, because the row guard refuses a one-character reading.
 *   7. **an empty record is named, not answered.** Both doors refuse and write nothing.
 *   8. **the four refusals store nothing**: no record, no volume number, looking forward, and an `out`
 *      folder that is a volume folder or the series root.
 *   9. **zero rows written anywhere**: every counted table's row count is identical before and after both
 *      doors, `written_forms` unchanged, `cast_merges` 0, no identity row, no fact, no cast change.
 *   10. **idempotent, byte for byte**: a second pass over the same record returns the same answer and writes
 *      the same bytes, which is why these files carry no timestamp.
 *   11. **the rule names no language.** The same shapes planted in a non-Japanese fixture — Cyrillic written
 *      forms under Latin readings — fire the anomaly and stay silent on the legitimate contrast, so the
 *      discriminator is a fact about two strings and not a fact about Japanese.
 *   12. **what this slice did not add**: no finding kind, no level, no freeze door, no artifact, no command,
 *      no setting, no stage that calls either door, and no file outside the layer that reads the reports.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69). The real-corpus
 * numbers are measured by `test/measure-source-quality.js`.
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { readModuleLayer } = require("./module-layer");
const rs = require("../utils/reference-store");
const { importGlossary } = require("../utils/reference-store/glossary-adapter");
const { openReferenceStore } = require("../utils/reference-store/open");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { FREEZE_DOORS } = require("../utils/prereqs/freeze");
const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");
const { RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");
const {
  COUNTED_TABLES,
  fileVolumeWrittenForms,
  writtenFormsInRecord,
  writtenFormCounts,
  candidateGroupsInRecord,
  rosterKeysInRecord,
  variantSpellingReport,
  inconsistentGuidanceReport,
  naiveFrequencyCandidates,
  sameCharactersDifferentOrder,
  bucketOfReadingCollision,
  SPELLING_VARIANT_MIN_RATIO,
  VARIANT_REPORT_FILES,
  GUIDANCE_REPORT_FILES,
} = rs;

const { fixtureStoreSeries, assertInsideFixture } = require("./fixture-reference-store");

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
 * The roster. 董子 is on it because the real corpus's volume 17 published it (plan 07 §2.11(b): the
 * Characters table already holds 董子 and 三色院董子 with a note saying the spelling is what the flashback
 * uses). That is what makes the すみれこ group **identity-bearing** in fixture shape, and what lets the
 * suite prove the guidance report leaves it to the identity door instead of calling it a defect.
 */
const GLOSSARY = `# Glossary

_Starter glossary for the source-quality suite._

## Characters

| Japanese | English | Notes |
|---|---|---|
| 如月雨露 | Kisaragi Amatsuyu | Protagonist; the narrator |
| 如雨露 | Amatsuyu (short) | The short spelling the books print 1–2 times each |
| 三色院菫子 | Sanshokuin Sumireko | Library committee |
| 菫子 | Sumireko | The name the cast prints on the page |
| 董子 | Sumireko (flashback) | Name used to address her in the flashback section |
| 大賀太陽 | Oga Taiyo | Best friend since junior high |

## Terms

| Japanese | English | Notes |
|---|---|---|
| 会計担当 | The Accounting Person | The book says it plainly: 「山田は会計の人である。」 |
`;

/**
 * Volume 1's harvest: every shape both reports are built on, planted, one row per shape.
 *
 * The counts are the real corpus's counts where the real corpus has them (美味 ×113 / 上手 ×104,
 * 達 ×48 / 性質 ×2, 董子 ×76 against 菫子 ×57), so "the naive rule flags this and the report does not" is a
 * comparison against the numbers plan 07 §2.11 measured rather than against invented ones.
 *
 * @type {Array<Object>}
 */
const HARVEST_01 = [
  // The defect: one written form, two readings, one chapter, the moras transposed.
  { word: "三色院董子", reading: "さんしよくいんすみれこ", count: 1, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "三色院董子", reading: "さんしよくいんすみれこ" }] },
  { word: "三色院董子", reading: "さんしよくいんすれみこ", count: 1, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "三色院董子", reading: "さんしよくいんすれみこ" }] },

  // Legitimate: one kanji the author reads three ways, in one chapter. Not a defect.
  { word: "嫌", reading: "いや", count: 34, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "嫌", reading: "いや" }] },
  { word: "嫌", reading: "きら", count: 3, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "嫌", reading: "きら" }] },

  // Cross-chapter: the same kanji read two ways in two DIFFERENT chapters. No collision at all.
  { word: "頼", reading: "たの", count: 5, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "頼", reading: "たの" }] },
  { word: "頼", reading: "たよ", count: 4, readingScript: "hiragana", chapters: ["ch2"], annotated: [{ base: "頼", reading: "たよ" }] },

  // The withdrawn diagnosis: 董子 guided 76 times, concentrated, already on the roster. Identity bucket.
  { word: "菫子", reading: "すみれこ", count: 57, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "菫子", reading: "すみれこ" }] },
  { word: "董子", reading: "すみれこ", count: 76, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "董子", reading: "すみれこ" }] },

  // The variant class, printed across two chapters: a group, and no collision.
  { word: "偽物", reading: "にせもの", count: 11, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "偽物", reading: "にせもの" }] },
  { word: "偽者", reading: "にせもの", count: 10, readingScript: "hiragana", chapters: ["ch2"], annotated: [{ base: "偽者", reading: "にせもの" }] },

  // The variant class, printed in one chapter: a group AND a collision, and not a defect.
  { word: "我侭", reading: "まま", count: 6, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "我侭", reading: "まま" }] },
  { word: "我儘", reading: "まま", count: 5, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "我儘", reading: "まま" }] },

  // The sound-alike class §2.10 measured as not errors.
  { word: "美味", reading: "うま", count: 113, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "美味", reading: "うま" }] },
  { word: "上手", reading: "うま", count: 104, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "上手", reading: "うま" }] },
  { word: "披露", reading: "ひろう", count: 5, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "披露", reading: "ひろう" }] },
  { word: "疲労", reading: "ひろう", count: 4, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "疲労", reading: "ひろう" }] },

  // The naive rule's false positive, in the shape the real corpus prints (達 ×48 / 性質 ×2).
  { word: "達", reading: "たち", count: 48, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "達", reading: "たち" }] },
  { word: "性質", reading: "たち", count: 2, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "性質", reading: "たち" }] },

  // And a concentrated pair the naive rule flags at 30×, which is a spelling variant and not a defect.
  { word: "花凛", reading: "かりん", count: 90, readingScript: "hiragana", chapters: ["ch2"], annotated: [{ base: "花凛", reading: "かりん" }] },
  { word: "凛", reading: "かりん", count: 3, readingScript: "hiragana", chapters: ["ch2"], annotated: [{ base: "凛", reading: "かりん" }] },

  // A name written short in every book: one reading, one form, no collision anywhere.
  { word: "如雨露", reading: "じようろ", count: 2, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "如雨露", reading: "じようろ" }] },
  { word: "如月雨露", reading: "きさらぎあまつゆ", count: 281, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "如月雨露", reading: "きさらぎあまつゆ" }] },

  // The single-mora guides the naive rule loves and the row guard refuses: they never reach the record.
  { word: "込", reading: "こ", count: 36, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "込", reading: "こ" }] },
  { word: "子", reading: "こ", count: 2, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "子", reading: "こ" }] },
  { word: "木", reading: "こ", count: 1, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "木", reading: "こ" }] },
];

/**
 * Volume 1's harvest in a fixture volume folder.
 *
 * @param {Object} fx @param {Array<Object>} guides @param {number} volume @returns {void}
 */
function writeHarvest(fx, guides, volume) {
  const index = volume - 1;
  const base = fx.volumes[index].base;
  fs.writeFileSync(
    path.join(fx.volumes[index].dir, `${base}${RUBY_GUIDE_FILE_SUFFIX}`),
    JSON.stringify({ schema: 2, whatThisIs: "fixture harvest for the source-quality suite", guides }, null, 2) + "\n",
    "utf8"
  );
}

/**
 * A fixture volume 1 with the harvest written beside its source, the glossary imported as the roster, and
 * the written forms filed through the shipped door.
 *
 * @param {string} label @param {Array<Object>} [guides] @returns {Promise<{fx: Object, store: Object, seriesDir: string}>}
 */
async function openReportFixture(label, guides = HARVEST_01) {
  const fx = fixtureStoreSeries(`source-quality-${label}`);
  writeHarvest(fx, guides, 1);
  const store = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: fx.dir, stage: "merge" });
  assertInsideFixture(store.file, fx.dir);
  const imported = importGlossary(store, GLOSSARY);
  ok(imported.castRegistered >= 6, `the fixture glossary should register its Characters rows as the roster: ${JSON.stringify(imported.refused)}`);
  const filed = await fileVolumeWrittenForms(store, {});
  ok(filed.ok, `the written-forms door should file the fixture harvest: ${filed.refusal && filed.refusal.because}`);
  return { fx, store, seriesDir: fx.dir };
}

/**
 * Every counted table's row count, so "the reports wrote nothing" is a comparison.
 * @param {Object} store @returns {Object<string, number>}
 */
function tableCounts(store) {
  /** @type {Object<string, number>} */
  const out = {};
  for (const table of COUNTED_TABLES) out[table] = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return out;
}

/**
 * The roster and the claims as one digest, so "no name moved and no fact was written" is a check.
 * @param {Object} store @returns {{cast: string, facts: string, merges: number, identities: number, links: number, writtenForms: string}}
 */
function recordDigest(store) {
  return {
    cast: JSON.stringify(store.db.prepare("SELECT * FROM cast ORDER BY key").all()),
    facts: JSON.stringify(store.db.prepare("SELECT * FROM facts ORDER BY id").all()),
    merges: store.db.prepare("SELECT COUNT(*) n FROM cast_merges").get().n,
    identities: store.db.prepare("SELECT COUNT(*) n FROM cast_identities").get().n,
    links: store.db.prepare("SELECT COUNT(*) n FROM cast_identity_links").get().n,
    writtenForms: JSON.stringify(writtenFormsInRecord(store)),
  };
}

/**
 * The forms one report entry names, sorted, so a planted shape can be asserted by name.
 * @param {Array<{forms: Array<{form: string}>}>} entries @returns {string[]}
 */
function formsOf(entries) {
  return [...new Set(entries.flatMap((entry) => entry.forms.map((form) => form.form)))].sort();
}

/**
 * The strings one guidance result names as defects, across both anomaly classes.
 * @param {Object} result @returns {string[]}
 */
function anomalyNames(result) {
  const names = [];
  for (const collision of result.anomalies.transposedReadings) names.push(collision.form);
  for (const collision of result.anomalies.transposedForms) names.push(collision.reading);
  return names.sort();
}

// ─── 1. the variant report reproduces the split and names both spellings ──────

/** Scenario 1. @returns {Promise<void>} */
async function scenarioVariantReport() {
  const { store } = await openReportFixture("variant");
  try {
    const report = variantSpellingReport(store);
    ok(report.ok, `the variant report should answer: ${report.refusal && report.refusal.because}`);
    same(report.modelCalls, 0, "0 model calls");
    same(report.rows.total, HARVEST_01.length - 3, "the record holds every harvest row except the three the row guard refused");
    same(report.groups.total, 7, "seven candidate groups: すみれこ, にせもの, まま, うま, ひろう, たち, かりん");
    same(report.groups.identityBearing, 1, "and the roster selects exactly one of them (すみれこ, because 董子 is a published entry)");
    same(report.groups.unselected, 6, "the other six are the ones it cannot see");

    same(report.totals.spellingVariants, 3, "three of the six read as one word spelled two ways");
    same(report.totals.soundAlikes, 3, "and three are different words that happen to sound alike");
    same(report.spellingVariants.map((entry) => entry.reading).sort(), ["かりん", "にせもの", "まま"], "the variant class, by reading");
    same(report.soundAlikes.map((entry) => entry.reading).sort(), ["うま", "たち", "ひろう"], "the sound-alike class, by reading");

    // Both spellings, with their counts — the acceptance line's wording.
    const nise = report.spellingVariants.find((entry) => entry.reading === "にせもの");
    same(nise.forms.map((form) => form.form).sort(), ["偽物", "偽者"], "it names both spellings");
    same(nise.forms.map((form) => `${form.form}×${form.count}`).sort(), ["偽物×11", "偽者×10"], "with their counts");
    same(nise.closestPair, { a: "偽物", b: "偽者", shared: 1, shorter: 2, ratio: 0.5 }, "and the pair that decided the class, at the shipped floor");
    same(report.minRatio, SPELLING_VARIANT_MIN_RATIO, "the floor is the shipped constant, not a copy of it");
    same(nise.volumes, ["1"], "and the volume the book printed them in");

    // Chapters travel with the form, and they come from the group's own per-volume rows.
    const chapters = nise.forms.map((form) => `${form.form}:${form.chaptersByVolume.map((entry) => entry.chapters.join("+")).join(",")}`).sort();
    same(chapters, ["偽物:ch1", "偽者:ch2"], "the chapters the harvest recorded each spelling in");

    // The sound-alike class is named, and it is not an error.
    const uma = report.soundAlikes.find((entry) => entry.reading === "うま");
    same(uma.forms.map((form) => form.form).sort(), ["上手", "美味"], "美味 / 上手 is named as a class");
    same(uma.closestPair.ratio, 0, "and nothing of the shorter form survives inside the longer one");
    same(formsOf(report.soundAlikes).includes("披露"), true, "披露 / 疲労 likewise");

    // The half the identity door owns is named as a count and not printed as a variant.
    same(report.identityBearingVariantsNotReported.groups, 1, "one roster-selected group would pass the same spelling test");
    same(report.identityBearingVariantsNotReported.readings, ["すみれこ"], "it is named, with the reason, and not printed here");

    const markdown = renderBoth(report, "variant");
    ok(markdown.includes("偽物") && markdown.includes("偽者"), "the log prints both spellings");
    ok(markdown.includes("Named as a class, and not reported as errors"), "and says out loud that the sound-alikes are not errors");
    same(markdown.includes("defect"), false, "the variant log never calls anything a defect");
  } finally {
    store.close();
  }
}

/**
 * Render a report the way the door would, for a scenario that only needs the text.
 * @param {Object} result @param {"variant"|"guidance"} which @returns {string}
 */
function renderBoth(result, which) {
  const render = which === "variant" ? rs.renderVariantSpellingLog : rs.renderGuidanceLog;
  return render(result);
}

// ─── 2. chapter scope, both shapes, both directions ───────────────────────────

/** Scenario 2. @returns {Promise<void>} */
async function scenarioChapterScope() {
  const { store } = await openReportFixture("chapter-scope");
  try {
    const report = inconsistentGuidanceReport(store);
    ok(report.ok, `the guidance report should answer: ${report.refusal && report.refusal.because}`);

    // Shape (a): 嫌 fires in ch1; 頼 does not fire across ch0 / ch2.
    const formCollisions = report.formCollisions.map((collision) => `${collision.volume}|${collision.chapter}|${collision.form}`).sort();
    same(formCollisions, ["1|ch1|三色院董子", "1|ch1|嫌"], "one written form guided two ways fires **in one chapter** and is silent across two chapters");

    // Shape (b): 我侭 / 我儘 fire in ch1; 偽物 / 偽者 do not fire across ch1 / ch2.
    const readingCollisions = report.readingCollisions.map((collision) => `${collision.volume}|${collision.chapter}|${collision.reading}`).sort();
    same(
      readingCollisions,
      ["1|ch0|うま", "1|ch0|ひろう", "1|ch1|すみれこ", "1|ch1|たち", "1|ch1|まま", "1|ch2|かりん"],
      "one reading printed over two spellings fires in one chapter and is silent across two chapters"
    );

    same(report.widths.formCollisions, { collisions: 2, pairs: 2, keys: 2 }, "the shape-(a) width, counted per volume");
    same(report.widths.readingCollisions, { collisions: 6, pairs: 6, keys: 6 }, "the shape-(b) width, counted per volume");
    same(report.widths.formsWithMoreThanOneReading, { pairs: 3, keys: 3 }, "the loose width, before chapter scope: 三色院董子, 嫌 and 頼");

    const buckets = report.buckets;
    same(buckets.identityBearing.collisions, 1, "すみれこ lands in the identity bucket");
    same(buckets.spellingVariant.collisions, 2, "まま and かりん land in the spelling-variant bucket");
    same(buckets.soundAlike.collisions, 3, "うま, ひろう and たち land in the sound-alike bucket");
    same(buckets.notACandidateGroup.collisions, 0, "and nothing falls outside a candidate group here");
    same(
      buckets.identityBearing.collisions + buckets.spellingVariant.collisions + buckets.soundAlike.collisions + buckets.notACandidateGroup.collisions,
      report.widths.readingCollisions.collisions,
      "the four buckets add up to the total, so nothing is counted twice and nothing is lost"
    );

    // The bucket travels with the collision, so the JSON answers "which bucket owns THIS one" without
    // re-deriving it, and the summary table cannot disagree with the list it summarises.
    const names = ["notACandidateGroup", "identityBearing", "spellingVariant", "soundAlike"];
    same(report.readingCollisions.every((collision) => names.includes(collision.bucket)), true, "every reading collision carries the bucket it was sorted into");
    same(names.map((name) => report.readingCollisions.filter((collision) => collision.bucket === name).length), names.map((name) => buckets[name].collisions), "and recounting the list gives the same four numbers as the table");
    same(report.readingCollisions.find((collision) => collision.reading === "すみれこ").bucket, "identityBearing", "すみれこ says so in its own row");
    same(report.readingCollisions.find((collision) => collision.reading === "うま").bucket, "soundAlike", "美味 / 上手 says so in its own row");
    same(report.formCollisions.every((collision) => collision.bucket === undefined), true, "the shape-(a) list carries no bucket: only shape (b) is sorted into owners");
  } finally {
    store.close();
  }
}

// ─── 3. the anomaly is the transposition, and nothing else ────────────────────

/** Scenario 3. @returns {Promise<void>} */
async function scenarioAnomalyClass() {
  const { store } = await openReportFixture("anomaly");
  try {
    const report = inconsistentGuidanceReport(store);
    same(report.anomalyTotals.total, 1, "exactly one defect in a fixture that plants 2 form collisions and 6 reading collisions");
    same(anomalyNames(report), ["三色院董子"], "and it is the transposed reading");

    const defect = report.anomalies.transposedReadings[0];
    same(defect.chapter, "ch1", "in one chapter");
    same(defect.transposedPair, ["さんしよくいんすみれこ", "さんしよくいんすれみこ"], "the two guided strings, named");
    same(defect.readings.map((reading) => reading.reading).sort(), ["さんしよくいんすみれこ", "さんしよくいんすれみこ"], "both readings the author wrote");
    same(report.anomalies.transposedForms, [], "the mirror class finds nothing, because no two written forms here are the same characters reordered");

    // The legitimate multi-reading word is a width, not a defect.
    ok(!anomalyNames(report).includes("嫌"), "嫌 guided いや / きら is counted and not called anything");
    const collision = report.formCollisions.find((entry) => entry.form === "嫌");
    same(collision.readings.map((reading) => reading.reading).sort(), ["いや", "きら"], "and it really is in the width list");

    // The predicate itself, pinned on the pairs the plan names.
    same(sameCharactersDifferentOrder("さんしよくいんすみれこ", "さんしよくいんすれみこ"), true, "the plan's defect");
    same(sameCharactersDifferentOrder("いや", "きら"), false, "a legitimate multi-reading word");
    same(sameCharactersDifferentOrder("菫子", "董子"), false, "two spellings of one name");
    same(sameCharactersDifferentOrder("美味", "上手"), false, "two words that sound alike");
    same(sameCharactersDifferentOrder("まま", "まま"), false, "the same string is not a different order");
    same(sameCharactersDifferentOrder("", ""), false, "and an empty string is not either");

    const markdown = renderBoth(report, "guidance");
    const anomalySection = markdown.split("\n## 2. The widths")[0];
    ok(anomalySection.includes("三色院董子"), "the log names the defect in its own section");
    same(anomalySection.includes("嫌"), false, "and the legitimate collision is not in that section — it is in the width list below");
    ok(markdown.includes("嫌"), "which is where it belongs");
    ok(markdown.includes("[soundAlike] volume 1 ch0"), "and the width list prints the bucket beside each collision, not only in the summary table");
  } finally {
    store.close();
  }
}

// ─── 4. 董子 and 如雨露 come back silent ──────────────────────────────────────

/** Scenario 4. @returns {Promise<void>} */
async function scenarioWithdrawnDiagnosis() {
  const { store } = await openReportFixture("withdrawn");
  try {
    const guidance = inconsistentGuidanceReport(store);
    const variant = variantSpellingReport(store);

    // 董子: guided 76 times, concentrated in one chapter, already on the roster. §2.11(b) withdrew the
    // diagnosis that called it a bad file, so no door may report it as a source error.
    same(anomalyNames(guidance).includes("董子"), false, "董子 is not a defect");
    same(anomalyNames(guidance).includes("すみれこ"), false, "and neither is the reading it is guided with");
    const sumireko = guidance.readingCollisions.find((collision) => collision.reading === "すみれこ");
    ok(sumireko, "the collision is still counted — the report does not hide a fact, it declines to call it a defect");
    same(bucketOfReadingCollision(sumireko, { groupReadings: new Set(["すみれこ"]), identityReadings: new Set(["すみれこ"]) }), "identityBearing", "and it is sorted into the bucket the identity door owns");
    same(guidance.buckets.identityBearing.collisions, 1, "one collision, in that bucket");

    // The variant report does not print it either: the roster already selects the group.
    same(variant.spellingVariants.map((entry) => entry.reading).includes("すみれこ"), false, "the variant report leaves すみれこ to the identity door");
    same(formsOf(variant.spellingVariants).includes("董子"), false, "and prints no 董子 as a spelling variant");

    // 如雨露: one reading, one form, in one chapter. A name written short, not a corrupted chapter.
    same(guidance.readingCollisions.some((collision) => collision.forms.some((form) => form.form === "如雨露")), false, "如雨露 is in no reading collision at all");
    same(guidance.formCollisions.some((collision) => collision.form === "如雨露"), false, "and in no form collision: it carries one reading");
    same(guidance.anomalies.transposedReadings.some((collision) => collision.form === "如雨露"), false, "so it is silent");
    same(formsOf(variant.spellingVariants).includes("如雨露"), false, "and the variant report says nothing about it either");
  } finally {
    store.close();
  }
}

// ─── 5. the naive 10× rule: implemented, measured, and used by nothing ────────

/** Scenario 5. @returns {Promise<void>} */
async function scenarioRejectedRule() {
  const { store } = await openReportFixture("rejected-rule");
  try {
    const guidance = inconsistentGuidanceReport(store);

    // 込 / 子 / 木 all read こ: the shape §2.11 names as the naive rule's noise. They never reach the
    // record, because the row guard refuses a one-character reading.
    same(writtenFormsInRecord(store).some((row) => row.reading === "こ"), false, "a one-character reading is never filed, so the naive rule's favourite shape is not in the record");
    same(writtenFormCounts(store).total, HARVEST_01.length - 3, "three harvest rows out of " + HARVEST_01.length + " were refused at filing");

    // 達 ×48 / 性質 ×2 and 花凛 ×90 / 凛 ×3 are the pairs the naive rule flags on the rows the record holds.
    const naive = naiveFrequencyCandidates(guidance.readingCollisions);
    const flagged = naive.candidates.map((candidate) => `${candidate.largerForm}/${candidate.smallerForm}`).sort();
    same(flagged, ["花凛/凛", "達/性質"], "the rejected rule, run against the same rows, flags these");
    same(naive.totals.candidates, 2, "two collisions");
    same(naive.totals.smallerCountAtLeastTwo, 2, "both with the rarer side at 2 or more occurrences");

    // And the report calls neither of them a defect.
    same(anomalyNames(guidance).includes("花凛"), false, "花凛 ×90 / 凛 ×3 is not a defect");
    same(anomalyNames(guidance).includes("たち"), false, "達 ×48 / 性質 ×2 is not a defect");
    same(anomalyNames(guidance), ["三色院董子"], "the only defect named is the one the author's own two answers disagree about");

    // The naive rule also MISSES the real defect, which is the other half of why it is rejected: it
    // compares the counts of two forms under one reading, and the defect is one form under two readings.
    same(naive.candidates.some((candidate) => candidate.reading.includes("すみれ") || candidate.largerForm === "三色院董子"), false, "it finds nothing about 三色院董子");

    // The variant report owns the concentrated pair — as a spelling variant, not as an error.
    const variant = variantSpellingReport(store);
    same(variant.spellingVariants.map((entry) => entry.reading).includes("かりん"), true, "the concentrated pair is a spelling variant, which is a note and not a defect");
  } finally {
    store.close();
  }
}

// ─── 6. an empty record is named, not answered ────────────────────────────────

/** Scenario 6. @returns {Promise<void>} */
async function scenarioEmptyRecord() {
  const fx = fixtureStoreSeries("source-quality-empty");
  const store = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: fx.dir, stage: "merge" });
  assertInsideFixture(store.file, fx.dir);
  try {
    same(writtenFormCounts(store).total, 0, "the record holds no written forms");
    const before = tableCounts(store);

    const variant = variantSpellingReport(store);
    const guidance = inconsistentGuidanceReport(store);
    same(variant.ok, false, "the variant report refuses rather than answering with an empty list");
    same(guidance.ok, false, "and so does the guidance report");
    same(variant.refusal.rule, "source-quality-no-written-forms-in-record", "named as an absence");
    same(guidance.refusal.rule, "source-quality-no-written-forms-in-record", "in both doors, with the same rule name");
    ok(/never been shown the pronunciation guides/.test(variant.refusal.because), "and the sentence says what the absence means");
    same(variant.refusal.useInstead, ["fileVolumeWrittenForms"], "it names the door that would fill it");
    same(variant.files.written, false, "nothing was written");
    same(guidance.files.written, false, "in either report");
    same(tableCounts(store), before, "and the record is untouched");
  } finally {
    store.close();
  }
}

// ─── 7. the refusals, and that each one stores nothing ────────────────────────

/** Scenario 7. @returns {Promise<void>} */
async function scenarioRefusals() {
  const { fx, store } = await openReportFixture("refusals");
  try {
    const before = tableCounts(store);
    const digestBefore = recordDigest(store);

    // Looking forward.
    const forward = variantSpellingReport(store, { upToVolume: 2 });
    same(forward.ok, false, "a volume 1 record is refused when asked about volume 2");
    same(forward.refusal.rule, "source-quality-cannot-look-forward", "by name");
    same(inconsistentGuidanceReport(store, { upToVolume: 2 }).refusal.rule, "source-quality-cannot-look-forward", "in both doors");

    // No volume number.
    same(variantSpellingReport(store, { upToVolume: 0 }).refusal.rule, "source-quality-report-volume-undecided", "a volume number is required");
    same(inconsistentGuidanceReport(store, { upToVolume: "x" }).refusal.rule, "source-quality-report-volume-undecided", "in both doors");

    // No record at all.
    same(variantSpellingReport({}).refusal.rule, "source-quality-report-needs-an-open-record", "a handle with no db is refused");
    same(inconsistentGuidanceReport({ volume: 1 }).refusal.rule, "source-quality-report-needs-an-open-record", "in both doors");

    // An out folder that is the volume folder, or the series root.
    const inVolume = variantSpellingReport(store, { out: fx.volumes[0].dir });
    same(inVolume.ok, false, "a source-quality report is not a volume artifact");
    same(inVolume.refusal.rule, "source-quality-report-not-a-volume-artifact", "named");
    same(inconsistentGuidanceReport(store, { out: path.join(fx.volumes[0].dir, "nested") }).refusal.rule, "source-quality-report-not-a-volume-artifact", "nor anything inside it");
    same(variantSpellingReport(store, { out: fx.dir }).refusal.rule, "source-quality-report-not-a-volume-artifact", "and not the series root the published artifacts live in");
    same(inconsistentGuidanceReport(store, { out: fx.dir }).refusal.rule, "source-quality-report-not-a-volume-artifact", "in both doors");

    same(tableCounts(store), before, "none of the refusals wrote a row");
    same(recordDigest(store), digestBefore, "not one column of the roster, the claims, or the written forms");
    ok(!fs.existsSync(path.join(fx.volumes[0].dir, VARIANT_REPORT_FILES.markdown)), "and no report file appeared in the volume folder");
  } finally {
    store.close();
  }
}

// ─── 8. zero rows written anywhere, and the same bytes twice ──────────────────

/** Scenario 8. @returns {Promise<void>} */
async function scenarioWritesNothingAndIsIdempotent() {
  const { fx, store } = await openReportFixture("idempotence");
  const out = path.join(fx.dir, ".run", "postmortem");
  try {
    const before = tableCounts(store);
    const digestBefore = recordDigest(store);

    const firstVariant = variantSpellingReport(store, { out });
    const firstGuidance = inconsistentGuidanceReport(store, { out });
    ok(firstVariant.files.written && firstGuidance.files.written, "both wrote their two files");
    ok(path.resolve(firstVariant.files.json).startsWith(path.resolve(out)), "into the folder the caller passed");
    same(Object.keys(firstVariant.files).sort(), ["error", "json", "markdown", "written"], "the writer reports both paths");

    const variantBytes = fs.readFileSync(firstVariant.files.markdown, "utf8");
    const variantJson = fs.readFileSync(firstVariant.files.json, "utf8");
    const guidanceBytes = fs.readFileSync(firstGuidance.files.markdown, "utf8");
    const guidanceJson = fs.readFileSync(firstGuidance.files.json, "utf8");
    ok(variantBytes.length > 200 && guidanceBytes.length > 200, `both logs are real files: ${variantBytes.length} / ${guidanceBytes.length} characters`);
    ok(!/"writtenAt"|"generatedAt"/.test(variantJson + guidanceJson), "and the machine twins carry no timestamp, so two identical answers are byte-identical");

    same(tableCounts(store), before, "the reports wrote no row into any table");
    same(recordDigest(store), digestBefore, "no cast row moved, no fact was filed, no identity link appeared, no written form changed");
    same(store.db.prepare("SELECT COUNT(*) n FROM cast_merges").get().n, 0, "cast_merges is still 0");
    same(store.db.prepare("SELECT COUNT(*) n FROM cast_identities").get().n, 0, "and so is the identity table");

    const secondVariant = variantSpellingReport(store, { out });
    const secondGuidance = inconsistentGuidanceReport(store, { out });
    same(secondVariant.spellingVariants, firstVariant.spellingVariants, "the same record gives the same variant answer");
    same(secondGuidance.anomalies, firstGuidance.anomalies, "and the same guidance answer");
    same(fs.readFileSync(secondVariant.files.markdown, "utf8"), variantBytes, "the same bytes");
    same(fs.readFileSync(secondVariant.files.json, "utf8"), variantJson, "in both files");
    same(fs.readFileSync(secondGuidance.files.markdown, "utf8"), guidanceBytes, "for both reports");
    same(fs.readFileSync(secondGuidance.files.json, "utf8"), guidanceJson, "and again");

    // No published artifact was touched, and none of these files is a declared artifact.
    const declared = [];
    for (const [step, spec] of Object.entries(STEP_ARTIFACT_SPECS)) {
      for (const entry of [...(spec.volume || []), ...(spec.run || [])]) {
        if (/source-variant|source-inconsistent/.test(entry.name || "")) declared.push(`${step}/${entry.name}`);
      }
    }
    same(declared, [], "no step declares a source-quality artifact, so the post-mortem never looks for one");
    const volumeFiles = fs.readdirSync(fx.volumes[0].dir);
    same(volumeFiles.some((name) => /source-(variant|inconsistent)/.test(name)), false, "and nothing landed in the volume folder");
  } finally {
    store.close();
  }
}

// ─── 9. the rule names no language: the same shapes in another script ─────────

/**
 * The non-Japanese fixture: Cyrillic written forms under Latin readings.
 *
 * The row guard requires the reading to share no character with the written form, which a Latin reading and
 * a Cyrillic form satisfy the same way a kana reading and a Han form do. Nothing in the reports knows which
 * of the two it is looking at.
 *
 * @type {Array<Object>}
 */
const HARVEST_CYRILLIC = [
  // The defect, form side: one reading printed over two spellings that are the same letters reordered.
  { word: "мир", reading: "mir", count: 3, readingScript: "latin", chapters: ["ch0"], annotated: [{ base: "мир", reading: "mir" }] },
  { word: "рим", reading: "mir", count: 2, readingScript: "latin", chapters: ["ch0"], annotated: [{ base: "рим", reading: "mir" }] },

  // The defect, reading side: one written form guided two ways with the letters transposed.
  { word: "город", reading: "gorod", count: 4, readingScript: "latin", chapters: ["ch1"], annotated: [{ base: "город", reading: "gorod" }] },
  { word: "город", reading: "rogod", count: 1, readingScript: "latin", chapters: ["ch1"], annotated: [{ base: "город", reading: "rogod" }] },

  // Legitimate: one word with two spellings of its reading, in one chapter. Not the same letters.
  { word: "вода", reading: "voda", count: 5, readingScript: "latin", chapters: ["ch0"], annotated: [{ base: "вода", reading: "voda" }] },
  { word: "вода", reading: "woda", count: 3, readingScript: "latin", chapters: ["ch0"], annotated: [{ base: "вода", reading: "woda" }] },

  // Legitimate, and cross-chapter: two anagram readings in two different chapters. Silent.
  { word: "лес", reading: "les", count: 2, readingScript: "latin", chapters: ["ch0"], annotated: [{ base: "лес", reading: "les" }] },
  { word: "лес", reading: "sel", count: 1, readingScript: "latin", chapters: ["ch2"], annotated: [{ base: "лес", reading: "sel" }] },
];

/** Scenario 9. @returns {Promise<void>} */
async function scenarioScriptNeutral() {
  const { store } = await openReportFixture("script-neutral", HARVEST_CYRILLIC);
  try {
    const guidance = inconsistentGuidanceReport(store);
    same(guidance.ok, true, "the same doors answer a record written in another script");
    same(guidance.rows.total, HARVEST_CYRILLIC.length, "every row was filed: the row guards name no script either");

    same(anomalyNames(guidance).sort(), ["mir", "город"], "both anomaly classes fire, in another script");
    same(guidance.anomalies.transposedForms.map((collision) => collision.forms.map((form) => form.form).sort()), [["мир", "рим"]], "the form side: мир / рим");
    same(guidance.anomalies.transposedReadings.map((collision) => collision.transposedPair.sort()), [["gorod", "rogod"]], "the reading side: gorod / rogod");

    same(guidance.formCollisions.map((collision) => collision.form).sort(), ["вода", "город"], "вода guided voda / woda is a width");
    same(guidance.anomalies.transposedReadings.some((collision) => collision.form === "вода"), false, "and is not a defect: voda and woda are not the same letters");
    same(guidance.formCollisions.some((collision) => collision.form === "лес"), false, "лес guided les / sel is silent, because the two guides are in different chapters");

    const variant = variantSpellingReport(store);
    same(variant.ok, true, "and the variant report answers the same record");
    same(variant.groups.total, 1, "one candidate group: mir over мир / рим. The two readings of вода are two groups of one form each, which the grouping rule drops");
    same(variant.groups.identityBearing, 0, "and the fixture roster knows none of these names");
    same(variant.spellingVariants.map((entry) => entry.reading).sort(), [], "the variant report does NOT call мир / рим one word spelled two ways");
    same(variant.soundAlikes.map((entry) => entry.reading).sort(), ["mir"], "it classifies it as a sound-alike, because only 1 of 3 characters of the shorter form survives inside the longer");
    // The tension is real and worth pinning: the two reports answer different questions. The guidance
    // report asks whether the author's two answers are the same letters reordered (they are); the variant
    // report asks whether one word is recognisably spelled two ways (it is not, by the shipped ratio).
    same(anomalyNames(guidance).includes("mir"), true, "and the guidance report still calls it the defect, on its own rule");
  } finally {
    store.close();
  }
}

// ─── 10. what this slice did not add ──────────────────────────────────────────

/** Folders that are not pipeline code — the same list `test/test-written-forms.js` states. */
const SKIP_DIRS = new Set(["node_modules", "test", "docs", "plan", "epub_source", "hooks", "calibration", "test-series"]);

/**
 * The pipeline's own `.js` files, so "no stage calls either door" is a scan and not a claim.
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
function scenarioNothingAdded() {
  const kinds = Object.keys(FINDING_LEVELS);
  same(kinds.length, 70, "the finding level table is still 70 kinds — this slice added none");
  same(kinds.filter((kind) => /source-quality|spelling|guidance|transpos/i.test(kind)), [], "and none of them is a source-quality kind: plan 07 §6.5 is asked, not made");
  same(Object.keys(FREEZE_DOORS).length, 12, "the freeze gate is still 12 doors");
  same(Object.keys(FREEZE_DOORS).filter((door) => /source|quality/i.test(door)), [], "and no door is named for a source-quality report");
  same(Object.keys(STEP_ARTIFACT_SPECS).filter((step) => /source-quality/i.test(step)), [], "and no step declares one");

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  same(Object.keys(packageJson.scripts).filter((name) => /source-quality|variant|guidance/i.test(name)), [], "no new manual command, and no npm script");
  ok(!fs.existsSync(path.join(ROOT, "source-quality.js")), "and no command module at the repository root");

  const handleLayer = readModuleLayer(ROOT, "utils/reference-store/open.js");
  ok(!/variantSpellingReport|inconsistentGuidanceReport/.test(handleLayer), "the store's handle gained no verb for either report");

  const files = pipelineSourceFiles();
  ok(files.length > 300, `the scan sees the pipeline's own code: ${files.length} files`);

  const layerPrefix = path.join(ROOT, "utils", "reference-store", "written-forms") + path.sep;
  const coverFile = path.join(ROOT, "utils", "reference-store", "written-forms.js");
  const reportsPrefix = path.join(layerPrefix, "reports") + path.sep;

  /** @type {string[]} */ const doorCallers = [];
  /** @type {string[]} */ const naiveCallers = [];
  /** @type {string[]} */ const reportFileReaders = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const insideLayer = file.startsWith(layerPrefix) || file === coverFile;
    if (/\b(variantSpellingReport|inconsistentGuidanceReport)\s*\(/.test(text) && !insideLayer) doorCallers.push(path.relative(ROOT, file));
    if (/\bnaiveFrequencyCandidates\s*\(/.test(text) && file.startsWith(reportsPrefix) && !file.endsWith("collisions.js")) naiveCallers.push(path.relative(ROOT, file));
    if (/source-variant-spellings|source-inconsistent-guidance/.test(text) && !insideLayer) reportFileReaders.push(path.relative(ROOT, file));
  }

  same(doorCallers, [], "no stage, no step, no command and no door calls either report: the only mentions outside the layer are the barrel's re-export, which never calls them");
  same(naiveCallers, [], "and the rejected frequency rule is called by no file in the reports folder except the one that implements it");
  same(reportFileReaders, [], "nothing outside the layer reads the two file names, so nothing depends on them existing");

  // The reports are reads: none of them opens a transaction, files a row, or touches a published file.
  for (const file of fs.readdirSync(reportsPrefix)) {
    const text = fs.readFileSync(path.join(reportsPrefix, file), "utf8");
    ok(!/BEGIN|INSERT INTO|UPDATE |DELETE FROM/.test(text), `${file} writes no row: it is a query and a file write, not a store write`);
    ok(!/process\.env/.test(text), `${file} reads no environment variable, so no knob switches either report off`);
    const writes = (text.match(/fs\.writeFileSync\(/g) || []).length;
    same(writes, file === "records.js" ? 2 : 0, `${file} performs ${writes} file write(s): only records.js writes, and only the two files of its own report`);
  }

  const coverNames = Object.keys(require(coverFile));
  ok(coverNames.includes("variantSpellingReport") && coverNames.includes("inconsistentGuidanceReport"), "the cover re-exports both doors");
  ok(coverNames.includes("naiveFrequencyCandidates"), "and the rejected rule, so it can be re-measured rather than remembered");
  const missingFromBarrel = coverNames.filter((name) => rs[name] === undefined);
  same(missingFromBarrel, [], `and every one of the cover's ${coverNames.length} names reaches the store's barrel (gotcha 151)`);

  same(Object.keys(rs).filter((name) => /variantSpellingReport|inconsistentGuidanceReport/.test(name)).length, 2, "both doors are reachable through the store's barrel");

  console.log("10. nothing added: 70 finding kinds, 12 freeze doors, 0 new artifact, 0 new command, 0 callers, 0 readers of the two files");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  await scenarioVariantReport();
  await scenarioChapterScope();
  await scenarioAnomalyClass();
  await scenarioWithdrawnDiagnosis();
  await scenarioRejectedRule();
  await scenarioEmptyRecord();
  await scenarioRefusals();
  await scenarioWritesNothingAndIsIdempotent();
  await scenarioScriptNeutral();
  scenarioNothingAdded();
  console.log(`\nsource-quality reports: ${checks} checks, 0 model calls.`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

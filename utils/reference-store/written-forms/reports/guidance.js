/**
 * utils/reference-store/written-forms/reports/guidance.js — the second source-quality report: the author's
 * own pronunciation notes disagreeing with each other **in one place**.
 *
 * Plan 07 slice 2b, and plan 07 §4.9's second bullet. The one real case is already in the harvest: volume 17
 * chapter 5 guides 三色院董子 as さんしよくいん**すみれ**こ and as さんしよくいん**すれみ**こ — a reading whose
 * moras are transposed, **1 row in 10,005**. Nothing in this pipeline reports it today, and nothing today
 * could have.
 *
 * ## The discriminator, and the two widths printed beside it
 *
 * Plan 07 §2.11(b) withdrew the diagnosis this slice was originally written for: 董子, 76 guided occurrences
 * in one flashback chapter, is **a name the author chose**, not a bad file. So neither concentration nor
 * uneven frequency is the signal, and chapter scope alone is not either — measured over the 8,910 rows a
 * record holds, "in the same chapter" still leaves **244** collisions of "one written form, two readings"
 * and **309** of "one reading, two written forms", and almost all of them are legitimate: 嫌 read いや / きら
 * / ぎら, 貴女 and 貴方 printed in one chapter, 美味 and 上手 both guided うま.
 *
 * So this door separates **what it calls a defect** from **what it counts**:
 *
 *   - **defect** — the author's two answers are made of **the same characters in a different order**. One
 *     collision in the real corpus for the reading side, zero for the form side, and zero on every
 *     legitimate shape planted in `test/test-source-quality-reports.js`.
 *   - **widths** — every other collision, printed as a number and sorted into four buckets that add up to
 *     the total, each bucket naming the door or the measurement that already owns it. Every collision in the
 *     machine twin carries the bucket it was sorted into, so the answer the report computed travels with the
 *     row instead of only in the summary table.
 *
 * That split is also what plan 07 §6.5 asks for before it decides whether a source-quality anomaly may stop
 * a run: *"a level for a class of one is a different decision from a level for a class of two hundred."*
 * Both numbers are in the JSON, so the decision can be made against the measurement.
 *
 * ## The rule this door refuses to call anything
 *
 * `naiveFrequencyCandidates` lives in `collisions.js` and is **not called here**. The plan measured it at 132
 * candidate pairs over the raw harvest and named its false positives (込 / 子 / 木 all read こ, 尽 / 着 / 吐
 * all read つ); `test/measure-source-quality.js` runs it against the same rows the report reads and prints
 * the two side by side, and `test/test-source-quality-reports.js` pins that neither door calls it.
 *
 * **0 model calls. Reads no book. Files no row. Writes no published artifact. Adds no finding kind and no
 * level. No stage calls it.**
 *
 * @module utils/reference-store/written-forms/reports/guidance
 */

const { refusal } = require("../../refusals");
const { writtenFormsInRecord, candidateGroupsInRecord } = require("../rows");
const { rosterKeysInRecord } = require("../file");
const { SPELLING_VARIANT_MIN_RATIO, closestFormPairOf, splitGroupsByRoster } = require("../shapes");
const {
  SOURCE_QUALITY_RECORD_SCHEMA,
  GUIDANCE_REPORT_FILES,
  sourceQualityReportScope,
  renderGuidanceLog,
  writeSourceQualityReport,
} = require("./records");
const {
  NAIVE_FREQUENCY_FACTOR,
  TRANSPOSITION_RULE_NOTE,
  collisionsForFormsByChapter,
  collisionsForReadingsByChapter,
  transposedCollisions,
  collisionTotals,
  formsCarryingMoreThanOneReading,
} = require("./collisions");
require("../../../../types"); // JSDoc type definitions

/**
 * The rejected rule, described rather than used.
 *
 * @type {{name: string, factor: number, measuredByPlan: Object, implementedIn: string, calledByNoDoor: boolean, because: string}}
 */
const REJECTED_FREQUENCY_RULE = Object.freeze({
  name: "one written form at least 10× more common than another under the same reading",
  factor: NAIVE_FREQUENCY_FACTOR,
  measuredByPlan: {
    rawHarvestCandidatePairs: 132,
    falsePositivesNamedByPlan07: ["込 / 子 / 木 all read こ", "尽 / 着 / 吐 all read つ", "芝 ×102 / 縛 ×7"],
  },
  implementedIn: "utils/reference-store/written-forms/reports/collisions.js",
  calledByNoDoor: true,
  because:
    "frequency asymmetry alone finds nothing in this corpus and misses the one real defect: 三色院董子 is guided " +
    "twice in one chapter over ONE written form, so a rule that compares the counts of two forms never sees it.",
});

/**
 * Which bucket one "one reading, two written forms, one chapter" collision belongs to.
 *
 * A decision tree, so the four buckets are disjoint and add up to the total: a collision that is both
 * identity-bearing and variant-shaped (the 董子 ones are) lands in the **first** bucket that claims it, and
 * the report says which door owns it. Order matters and is the order of ownership: a group the record's own
 * roster already selects is the record's answer first; a spelling pair is the other report's answer second;
 * everything the grouping rule kept and neither rule claims is the sound-alike class §2.10 measured as
 * **not errors** last.
 *
 * @param {import("./collisions").ReadingChapterCollision} collision
 * @param {{groupReadings: Set<string>, identityReadings: Set<string>}} owned
 * @returns {"notACandidateGroup"|"identityBearing"|"spellingVariant"|"soundAlike"}
 */
function bucketOfReadingCollision(collision, owned) {
  if (!owned.groupReadings.has(collision.reading)) return "notACandidateGroup";
  if (owned.identityReadings.has(collision.reading)) return "identityBearing";
  const closest = closestFormPairOf({ forms: collision.forms.map((form) => ({ form: form.form })) });
  if (closest.ratio >= SPELLING_VARIANT_MIN_RATIO) return "spellingVariant";
  return "soundAlike";
}

/**
 * The refusal a record with no written forms gets.
 *
 * @param {number} recordVolume
 * @param {number} ceiling
 * @returns {ReferenceRefusal}
 */
function noWrittenFormsRefusal(recordVolume, ceiling) {
  return refusal({
    verb: "report_inconsistent_guidance",
    rule: "source-quality-no-written-forms-in-record",
    because:
      `volume ${recordVolume}'s record holds no \`written_forms\` rows up to volume ${ceiling}, so there is ` +
      "nothing to ask. A record with no written forms has never been shown the pronunciation guides the " +
      "extraction writes beside every volume, which is not the same as a record whose guides agree.",
    useInstead: ["fileVolumeWrittenForms"],
    fix:
      "run `npx gulp extract` so each volume's <base>-ruby-guides.json exists, then " +
      "fileVolumeWrittenForms(store, { volume }) for each volume before asking this question.",
    detail: { recordVolume, upToVolume: ceiling },
  });
}

/**
 * The inconsistent-guidance report.
 *
 * @param {{db: Object, volume: number, volumeDir?: string}} store - An opened reference record.
 * @param {{upToVolume?: number, out?: string}} [opts]
 * @param {number} [opts.upToVolume] - Defaults to the record's own volume; refused when later.
 * @param {string} [opts.out] - Folder for the two files; refused when it is the volume folder or the series root.
 * @returns {{ok: boolean, refusal: ReferenceRefusal|null, schema: number, modelCalls: number,
 *   recordVolume: number, upToVolume: number, rows: Object, groups: Object,
 *   widths: Object, formCollisions: Array<Object>,
 *   readingCollisions: Array<import("./collisions").ReadingChapterCollision & {bucket: string}>,
 *   buckets: Object, anomalies: Object, anomalyTotals: Object, ruleNote: string,
 *   rejectedRule: Object, files: Object, log: string|null}}
 */
function inconsistentGuidanceReport(store, { upToVolume, out } = {}) {
  const scope = sourceQualityReportScope({ store, verb: "report_inconsistent_guidance", upToVolume, out });
  const emptyResult = {
    ok: false,
    refusal: scope.refusal,
    schema: SOURCE_QUALITY_RECORD_SCHEMA,
    modelCalls: 0,
    recordVolume: store && Number.isInteger(Number(store.volume)) ? Number(store.volume) : 0,
    upToVolume: scope.ceiling,
    rows: null,
    groups: null,
    widths: null,
    formCollisions: [],
    readingCollisions: [],
    buckets: null,
    anomalies: { transposedReadings: [], transposedForms: [] },
    anomalyTotals: { transposedReadings: 0, transposedForms: 0, total: 0 },
    ruleNote: TRANSPOSITION_RULE_NOTE,
    rejectedRule: REJECTED_FREQUENCY_RULE,
    files: { written: false, markdown: null, json: null, error: null },
    log: null,
  };
  if (!scope.ok) return emptyResult;

  const rows = writtenFormsInRecord(store).filter((row) => Number(row.volume) <= scope.ceiling);
  if (rows.length === 0) return { ...emptyResult, refusal: noWrittenFormsRefusal(Number(store.volume), scope.ceiling) };

  const built = candidateGroupsInRecord(store, { upToVolume: scope.ceiling });
  const split = splitGroupsByRoster(built.groups, rosterKeysInRecord(store));
  const owned = {
    groupReadings: new Set(built.groups.map((group) => group.reading)),
    identityReadings: new Set(split.identityBearing.map((group) => group.reading)),
  };

  const formCollisions = collisionsForFormsByChapter(rows);
  const readingCollisions = collisionsForReadingsByChapter(rows);
  const transposedReadings = transposedCollisions(formCollisions, "readings");
  const transposedForms = transposedCollisions(readingCollisions, "forms");

  /** @type {Object<string, {collisions: number, pairs: number}>} */
  const buckets = {
    notACandidateGroup: { collisions: 0, pairs: 0 },
    identityBearing: { collisions: 0, pairs: 0 },
    spellingVariant: { collisions: 0, pairs: 0 },
    soundAlike: { collisions: 0, pairs: 0 },
  };
  // Asked once per collision, and the answer is kept **on the collision**: a bucket counted by calling the
  // classifier twice is a bucket that can disagree with itself between the two calls, and a JSON list of
  // 309 collisions whose bucket is only in a summary table forces the reader to re-derive the answer the
  // report already computed. The copies keep the pure collision objects from `collisions.js` untouched.
  const assigned = readingCollisions.map((collision) => ({ ...collision, bucket: bucketOfReadingCollision(collision, owned) }));
  for (const { bucket } of assigned) buckets[bucket].collisions++;
  for (const [name, bucket] of Object.entries(buckets)) {
    bucket.pairs = new Set(assigned.filter((entry) => entry.bucket === name).map((entry) => `${entry.volume}|${entry.reading}`)).size;
  }
  const bucketedReadingCollisions = assigned;

  const volumes = new Set(rows.map((row) => Number(row.volume)));
  const result = {
    ok: true,
    refusal: null,
    schema: SOURCE_QUALITY_RECORD_SCHEMA,
    modelCalls: 0,
    recordVolume: Number(store.volume),
    upToVolume: scope.ceiling,
    rows: {
      total: rows.length,
      occurrences: rows.reduce((sum, row) => sum + Number(row.occurrences), 0),
      volumes: volumes.size,
    },
    groups: {
      total: built.totals.candidateGroups,
      identityBearing: split.totals.identityBearing,
      unselected: split.totals.unselected,
    },
    widths: {
      formsWithMoreThanOneReading: formsCarryingMoreThanOneReading(rows),
      formCollisions: collisionTotals(formCollisions, "form"),
      readingCollisions: collisionTotals(readingCollisions, "reading"),
    },
    formCollisions,
    readingCollisions: bucketedReadingCollisions,
    buckets,
    anomalies: { transposedReadings, transposedForms },
    anomalyTotals: {
      transposedReadings: transposedReadings.length,
      transposedForms: transposedForms.length,
      total: transposedReadings.length + transposedForms.length,
    },
    ruleNote: TRANSPOSITION_RULE_NOTE,
    rejectedRule: REJECTED_FREQUENCY_RULE,
    files: { written: false, markdown: null, json: null, error: null },
    log: null,
  };

  if (scope.out) {
    const markdown = renderGuidanceLog(result);
    const written = writeSourceQualityReport({ out: scope.out, names: GUIDANCE_REPORT_FILES, result, markdown });
    result.files = written;
    result.log = markdown;
  }
  return result;
}

module.exports = { inconsistentGuidanceReport, bucketOfReadingCollision, noWrittenFormsRefusal, REJECTED_FREQUENCY_RULE };

/**
 * utils/reference-store/written-forms/reports/variant.js — the first source-quality report: **one word,
 * two spellings**, printed the way a dictionary prints *color* / *colour*.
 *
 * Plan 07 slice 2b, and plan 07 §4.9's first bullet. The account owner's answer on the 79 candidate groups
 * the roster rule cannot see was *"note the same-word-different-spelling ones the way English notes color /
 * colour; the glossary should account for that"*, and plan 07 §2.10 turned that into one deterministic,
 * script-neutral computation that splits the 79 **25 / 54**. This door runs that computation over the rows a
 * record holds and prints the result. It decides nothing beyond the spelling shape and files nothing.
 *
 * ## What it reuses, and why that is the point
 *
 * `candidateGroupsInRecord` (the shipped grouping read), `splitGroupsByRoster` (plan 07 §2.9's
 * roster-or-reading rule), `classifyUnselectedGroups` and `closestFormPairOf` (plan 07 §2.10's
 * longest-common-subsequence ratio and `SPELLING_VARIANT_MIN_RATIO`). **No ratio, no guard and no threshold
 * is restated here.** A second implementation of the classifier is how two doors drift into two definitions
 * of a spelling variant, which is the failure mode this repository's reading passes were built to avoid.
 *
 * ## What it does not print, and who owns it
 *
 * The 18 groups the roster **does** select. 13 of them would pass the same spelling test — すみれこ,
 * パンジー, なでしこ, つきみ — and they are named as a count with their readings, not printed as variants:
 * the record already treats those spellings as one name, and that claim is the identity table's
 * (plan 07 slice 2). Printing them here would put a spelling note beside a published identity claim and let
 * two files disagree about which one a reader should believe.
 *
 * **0 model calls. Reads no book. Files no row. Writes no published artifact. No stage calls it.**
 *
 * @module utils/reference-store/written-forms/reports/variant
 */

const { refusal } = require("../../refusals");
const { writtenFormsInRecord, candidateGroupsInRecord } = require("../rows");
const { rosterKeysInRecord } = require("../file");
const {
  SPELLING_VARIANT_MIN_RATIO,
  isSpellingVariantGroup,
  splitGroupsByRoster,
  classifyUnselectedGroups,
} = require("../shapes");
const {
  SOURCE_QUALITY_RECORD_SCHEMA,
  VARIANT_REPORT_FILES,
  sourceQualityReportScope,
  renderVariantSpellingLog,
  writeSourceQualityReport,
  describeVariantSpellingReport,
} = require("./records");
require("../../../../types"); // JSDoc type definitions

/**
 * Attach the chapters each volume recorded one written form in, straight off the group's own rows.
 *
 * `describeGroupForReport` carries `volumes` but not chapters, and the acceptance line asks for the
 * spellings **with their counts**. `GuideGroupForm.occurrences` is the per-volume half of the same fold —
 * `{volume, count, chapters}` — so the chapters are read from it rather than re-derived from a second pass
 * over the rows. The count stays the **volume-wide** one, and `records.js`'s `formLine` says so in the
 * sentence that prints it.
 *
 * @param {ReturnType<import("../shapes").describeGroupForReport>} entry
 * @param {import("../../source/guide-groups").GuideGroup} group - The group the entry describes.
 * @returns {Object} The entry, with `chaptersByVolume` added to each form.
 */
function withChapters(entry, group) {
  const occurrencesByForm = new Map((group.forms || []).map((form) => [form.form, form.occurrences || []]));
  return {
    ...entry,
    forms: entry.forms.map((form) => ({
      ...form,
      chaptersByVolume: (occurrencesByForm.get(form.form) || []).map((occurrence) => ({
        volume: String(occurrence.volume),
        count: Number(occurrence.count),
        chapters: (occurrence.chapters || []).slice(),
      })),
    })),
  };
}

/**
 * The empty answer this door refuses, so "nobody looked" is never mistaken for "nothing is wrong".
 *
 * @param {number} recordVolume
 * @param {number} ceiling
 * @returns {ReferenceRefusal}
 */
function noWrittenFormsRefusal(recordVolume, ceiling) {
  return refusal({
    verb: "report_variant_spellings",
    rule: "source-quality-no-written-forms-in-record",
    because:
      `volume ${recordVolume}'s record holds no \`written_forms\` rows up to volume ${ceiling}, so there is ` +
      "nothing to ask. This is a named absence, not a clean bill of health: a record with no written forms has " +
      "never been shown the pronunciation guides the extraction writes beside every volume.",
    useInstead: ["fileVolumeWrittenForms"],
    fix:
      "run `npx gulp extract` so each volume's <base>-ruby-guides.json exists, then " +
      "fileVolumeWrittenForms(store, { volume }) for each volume before asking this question.",
    detail: { recordVolume, upToVolume: ceiling },
  });
}

/**
 * The variant-spelling report.
 *
 * @param {{db: Object, volume: number, volumeDir?: string}} store - An opened reference record.
 * @param {{upToVolume?: number, out?: string}} [opts]
 * @param {number} [opts.upToVolume] - How far back to read. Defaults to the record's own volume, and is
 *   refused when it is later than that: a volume's record is what that volume and the ones before it measured.
 * @param {string} [opts.out] - Folder for the two files. Refused when it is the volume folder or the series
 *   root. Omitted, the report is returned and nothing is written.
 * @returns {{ok: boolean, refusal: ReferenceRefusal|null, schema: number, modelCalls: number,
 *   recordVolume: number, upToVolume: number, rows: Object, roster: Object, groups: Object,
 *   minRatio: number, spellingVariants: Array<Object>, soundAlikes: Array<Object>, totals: Object,
 *   identityBearingVariantsNotReported: Object, files: Object, log: string|null}}
 */
function variantSpellingReport(store, { upToVolume, out } = {}) {
  const scope = sourceQualityReportScope({ store, verb: "report_variant_spellings", upToVolume, out });
  const emptyResult = {
    ok: false,
    refusal: scope.refusal,
    schema: SOURCE_QUALITY_RECORD_SCHEMA,
    modelCalls: 0,
    recordVolume: store && Number.isInteger(Number(store.volume)) ? Number(store.volume) : 0,
    upToVolume: scope.ceiling,
    rows: null,
    roster: null,
    groups: null,
    minRatio: SPELLING_VARIANT_MIN_RATIO,
    spellingVariants: [],
    soundAlikes: [],
    totals: null,
    identityBearingVariantsNotReported: { groups: 0, readings: [] },
    files: { written: false, markdown: null, json: null, error: null },
    log: null,
  };
  if (!scope.ok) return emptyResult;

  const rows = writtenFormsInRecord(store).filter((row) => Number(row.volume) <= scope.ceiling);
  if (rows.length === 0) return { ...emptyResult, refusal: noWrittenFormsRefusal(Number(store.volume), scope.ceiling) };

  const built = candidateGroupsInRecord(store, { upToVolume: scope.ceiling });
  const roster = rosterKeysInRecord(store);
  const split = splitGroupsByRoster(built.groups, roster);
  const classified = classifyUnselectedGroups(split.unselected);
  const groupByReading = new Map(built.groups.map((group) => [group.reading, group]));
  const enrich = (entries) => entries.map((entry) => withChapters(entry, groupByReading.get(entry.reading) || { forms: [] }));

  // The half this report deliberately does not print, named so the boundary is on the record.
  const identityVariants = split.identityBearing.filter((group) => isSpellingVariantGroup(group));

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
    roster: { entries: roster.size },
    groups: {
      total: built.totals.candidateGroups,
      identityBearing: split.totals.identityBearing,
      unselected: split.totals.unselected,
    },
    minRatio: SPELLING_VARIANT_MIN_RATIO,
    spellingVariants: enrich(classified.spellingVariants),
    soundAlikes: enrich(classified.soundAlikes),
    totals: classified.totals,
    identityBearingVariantsNotReported: {
      groups: identityVariants.length,
      readings: identityVariants.map((group) => group.reading),
      because:
        "the record's roster already selects these groups, so the claim that their spellings are one name " +
        "belongs to the identity table (plan 07 slice 2), not to a spelling note beside it",
    },
    files: { written: false, markdown: null, json: null, error: null },
    log: null,
  };

  if (scope.out) {
    const markdown = renderVariantSpellingLog(result);
    const written = writeSourceQualityReport({ out: scope.out, names: VARIANT_REPORT_FILES, result, markdown });
    result.files = written;
    result.log = markdown;
  }
  return result;
}

module.exports = { variantSpellingReport, noWrittenFormsRefusal, withChapters, describeVariantSpellingReport };

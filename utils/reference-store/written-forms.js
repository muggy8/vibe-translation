/**
 * utils/reference-store/written-forms.js — the barrel for "this book printed this word, guided with this
 * reading" (plan 07 slice 1), and the two reports that read those rows back (plan 07 slice 2b).
 *
 * Four files and one nested folder, one public surface, in the shape AGENTS.md §3 requires:
 *
 *   - `written-forms/shapes.js` — the **pure half**: which candidate groups a given roster calls
 *     identity-bearing (plan 07 §2.9's rule, measured at 18 of 97 groups with zero false positives), and
 *     which of the groups it cannot see are one word spelled two ways rather than two words that sound
 *     alike (plan 07 §2.10's 25 / 54 split). It reads nothing and writes nothing.
 *   - `written-forms/rows.js` — the **row and its reads**: the one insert statement the table allows
 *     (insert-only, no update, no delete), whether this record already holds it, every row this record
 *     carries, the counts, and the candidate groups the rows describe when handed back to the shipped
 *     grouping rule.
 *   - `written-forms/file.js` — the **door**: read one volume's own pronunciation-guide harvest and file
 *     every harvested row that passes the two **row** guards, whatever group it would or would not have
 *     joined; the same file runs the shipped fold alongside, for the report only.
 *   - `written-forms/reports/` — the two **source-quality reports** (plan 07 slice 2b): `collisions.js`
 *     builds the two chapter-scoped shapes and the one discriminator, `variant.js` and `guidance.js` are
 *     the two doors, and `records.js` is where they may write and where they are refused. A submodule that
 *     outgrew itself splitting the same way, inside its own folder.
 *   - `written-forms/view/` — the **annotated chapter view** (plan 07 slice 5): `select.js` answers which
 *     written forms this volume's record may show a model with the author's own guide over them,
 *     `render.js` puts that guide over one piece of text in the one markup shape
 *     `utils/reference-store/ruby-markup.js` owns, and `chapter.js` bolts the two together into the door a
 *     caller would use. It reads the rows this layer already filed — it is not a second reader of the harvest.
 *
 * ## What the two reports are, in one line each
 *
 * **Variant spellings** — the 25 groups plan 07 §2.10 measures, printed the way a dictionary prints *color*
 * / *colour*: both spellings, both counts, no verdict. **Inconsistent guidance** — the author's own two
 * pronunciation notes disagreeing in one place, of which the report calls exactly one shape a defect: two
 * guided strings made of the same characters in a different order (三色院董子 guided さんしよくいん**すみれ**こ
 * and さんしよくいん**すれみ**こ in volume 17 chapter 5). Everything else it counts and sorts, because plan 07
 * §2.11(b) measured that a name the author guides 76 times in one chapter is a name, not a defect.
 *
 * Neither report is wired, and neither is the view: **no stage, step, command or door calls any of them**, and
 * `test/test-written-forms.js` and `test/test-annotated-view.js` grep the tree to prove it. None files a row,
 * marks anything, adds a finding kind, adds a level, adds a freeze door, declares an artifact, or writes a
 * published file.
 *
 * ## What this layer is, in one line
 *
 * `written_forms` is one row per (volume, written form, guided reading): *volume 9 prints 美味 and guides
 * it with うま, 113 times, in these chapters.* It is the book's own markup transcribed, and it is the
 * floor plan 07 was written because the extraction has been writing that harvest beside every volume
 * since gotcha 123 and **nothing has ever read it back**.
 *
 * ## Filing is judgement-free; grouping is a read (plan 07 §6.7, the owner's answer)
 *
 * The door files **every harvested row that passes the two row guards** — the guided reading is 2+
 * characters long, and the reading shares no character with the written form. The two **group** guards
 * (`GUIDE_GROUP_MIN_FORMS`, `GUIDE_GROUP_MIN_FORM_CHARS`) stay in `utils/source/guide-groups.js` and in
 * `rows.js`'s `candidateGroupsInRecord`, and they decide nothing about what gets filed. That is the
 * account owner's decision of 2026-10-15, and the reason written into `file.js`: the grouping guards are
 * arguable and already carry a measured false negative (しば ← 芝 x416 / 縛 x10 is dropped by the
 * length guard, and 芝 is a name the published record holds), and a door that applies an arguable
 * judgement **when it files** is a door that makes that judgement impossible to widen later. Filing stays
 * per-volume and judgement-free; grouping is a read, and a read can be re-asked against the same rows.
 *
 * **No seal on a written-forms row**, also the owner's answer (§2b): a later volume works in its own copy,
 * so a seal on a row that reaches no published file protects nothing. `identity/file.js` already reasons
 * this way and `file.js` follows it.
 *
 * ## What it never touches
 *
 * **No identity.** The roster-or-reading claim that says two written forms are one person belongs to plan
 * 07 slice 2 and the identity table, which this layer does not require and does not write. It files no
 * claim, no cast entry, no `cast_alias`, no challenge, no confirmation, and it marks nothing. It adds
 * **no verb** to the store, **no finding kind** (the level table stays at 70 kinds), **no setting**, **no
 * command**, **no freeze door** and **no declared artifact**.
 *
 * **Nothing reads it yet, on purpose.** No renderer, audit rule, presence matcher, coverage rule,
 * chapter-facts query, validator query or stage reads `written_forms` in this slice — plan 07 §5's slice-1
 * acceptance line, and `test/test-written-forms.js` greps the tree to prove the count is zero. That is how
 * the account owner's asymmetry (*filing is easy to extend and effectively impossible to undo*) is honoured
 * while the shape is still being argued, and it is why **no stage calls the door**.
 *
 * It is a **guard** layer: it lives inside `utils/reference-store/`, which is already a banned patch path
 * for the dev team, and every file of it — `shapes.js`, `rows.js`, `file.js` and the whole nested
 * `reports/` folder — stays inside that folder.
 *
 * @module utils/reference-store/written-forms
 */

const shapes = require("./written-forms/shapes");
const rows = require("./written-forms/rows");
const file = require("./written-forms/file");
const collisions = require("./written-forms/reports/collisions");
const variantReport = require("./written-forms/reports/variant");
const guidanceReport = require("./written-forms/reports/guidance");
const reportRecords = require("./written-forms/reports/records");
const viewSelect = require("./written-forms/view/select");
const viewRender = require("./written-forms/view/render");
const viewChapter = require("./written-forms/view/chapter");

module.exports = {
  // The pure half: the roster's answer, and the spelling-shape report.
  SPELLING_VARIANT_MIN_RATIO: shapes.SPELLING_VARIANT_MIN_RATIO,
  longestCommonSubsequenceLength: shapes.longestCommonSubsequenceLength,
  closestFormPairOf: shapes.closestFormPairOf,
  isSpellingVariantGroup: shapes.isSpellingVariantGroup,
  describeGroupForReport: shapes.describeGroupForReport,
  classifyUnselectedGroups: shapes.classifyUnselectedGroups,
  asRosterKeySet: shapes.asRosterKeySet,
  identityBearingGroups: shapes.identityBearingGroups,
  splitGroupsByRoster: shapes.splitGroupsByRoster,

  // The read: the row, whether it is already filed, the rows this record carries, and the groups they make.
  WRITTEN_FORM_COLUMNS: rows.WRITTEN_FORM_COLUMNS,
  writtenFormAlreadyFiled: rows.writtenFormAlreadyFiled,
  insertWrittenFormRow: rows.insertWrittenFormRow,
  writtenFormsInRecord: rows.writtenFormsInRecord,
  parseChaptersCell: rows.parseChaptersCell,
  parseChapters: rows.parseChapters,
  writtenFormCounts: rows.writtenFormCounts,
  candidateGroupsInRecord: rows.candidateGroupsInRecord,

  // The door: one volume's harvest, filed once, and the roster it was asked against.
  rosterKeysInRecord: file.rosterKeysInRecord,
  writtenFormHarvestFiles: file.writtenFormHarvestFiles,
  readWrittenFormHarvest: file.readWrittenFormHarvest,
  scriptOfGroup: file.scriptOfGroup,
  eligibleWrittenFormRows: file.eligibleWrittenFormRows,
  fileVolumeWrittenForms: file.fileVolumeWrittenForms,

  // The two chapter shapes, and the one discriminator (plan 07 slice 2b). Pure: no store, no write, no model.
  NAIVE_FREQUENCY_FACTOR: collisions.NAIVE_FREQUENCY_FACTOR,
  TRANSPOSITION_RULE_NOTE: collisions.TRANSPOSITION_RULE_NOTE,
  sameCharactersDifferentOrder: collisions.sameCharactersDifferentOrder,
  findTransposedPair: collisions.findTransposedPair,
  collisionsForFormsByChapter: collisions.collisionsForFormsByChapter,
  collisionsForReadingsByChapter: collisions.collisionsForReadingsByChapter,
  transposedCollisions: collisions.transposedCollisions,
  collisionTotals: collisions.collisionTotals,
  formsCarryingMoreThanOneReading: collisions.formsCarryingMoreThanOneReading,
  // The rule this layer measured and REJECTED, exported so it can be re-measured. No door calls it.
  naiveFrequencyCandidates: collisions.naiveFrequencyCandidates,

  // The two source-quality reports: queries, refusals, and two files each. Nothing is filed.
  variantSpellingReport: variantReport.variantSpellingReport,
  inconsistentGuidanceReport: guidanceReport.inconsistentGuidanceReport,
  bucketOfReadingCollision: guidanceReport.bucketOfReadingCollision,
  REJECTED_FREQUENCY_RULE: guidanceReport.REJECTED_FREQUENCY_RULE,
  SOURCE_QUALITY_RECORD_SCHEMA: reportRecords.SOURCE_QUALITY_RECORD_SCHEMA,
  SOURCE_QUALITY_MAX_LISTED: reportRecords.SOURCE_QUALITY_MAX_LISTED,
  VARIANT_REPORT_FILES: reportRecords.VARIANT_REPORT_FILES,
  GUIDANCE_REPORT_FILES: reportRecords.GUIDANCE_REPORT_FILES,
  sourceQualityReportScope: reportRecords.sourceQualityReportScope,
  renderVariantSpellingLog: reportRecords.renderVariantSpellingLog,
  renderGuidanceLog: reportRecords.renderGuidanceLog,
  describeVariantSpellingReport: reportRecords.describeVariantSpellingReport,
  describeGuidanceReport: reportRecords.describeGuidanceReport,

  // The annotated chapter view (plan 07 slice 5): which forms may be shown, and the markup over one chapter.
  // A view: it files nothing, publishes nothing, reaches no model, and no stage calls it.
  VIEW_MAX_USES_PER_VOLUME: viewSelect.VIEW_MAX_USES_PER_VOLUME,
  printedOccurrences: viewSelect.printedOccurrences,
  annotatedFormsForVolume: viewSelect.annotatedFormsForVolume,
  annotateChapterText: viewRender.annotateChapterText,
  annotatedChapterView: viewChapter.annotatedChapterView,
};

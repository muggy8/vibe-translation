/**
 * utils/reference-store/written-forms.js — the barrel for "this book printed this word, guided with this
 * reading" (plan 07 slice 1).
 *
 * Three files, one public surface, in the shape AGENTS.md §3 requires:
 *
 *   - `written-forms/shapes.js` — the **pure half**: which candidate groups a given roster calls
 *     identity-bearing (plan 07 §2.9's rule, measured at 18 of 97 groups with zero false positives), and
 *     which of the groups it cannot see are one word spelled two ways rather than two words that sound
 *     alike (plan 07 §2.10's 25 / 54 split). It reads nothing and writes nothing.
 *   - `written-forms/rows.js` — the **row and its reads**: the one insert statement the table allows
 *     (insert-only, no update, no delete), whether this record already holds it, every row this record
 *     carries, the counts, and the candidate groups the rows describe when handed back to the shipped
 *     grouping rule.
 *   - `written-forms/file.js` — the **door**: read one volume's own pronunciation-guide harvest, fold it
 *     with `utils/source/guide-groups.js`, and file each candidate group's written forms.
 *
 * ## What this layer is, in one line
 *
 * `written_forms` is one row per (volume, written form, guided reading): *volume 9 prints 美味 and guides
 * it with うま, 113 times, in these chapters.* It is the book's own markup transcribed, and it is the
 * floor plan 07 was written because the extraction has been writing that harvest beside every volume
 * since gotcha 123 and **nothing has ever read it back**.
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
 * for the dev team, and all three files stay inside that folder.
 *
 * @module utils/reference-store/written-forms
 */

const shapes = require("./written-forms/shapes");
const rows = require("./written-forms/rows");
const file = require("./written-forms/file");

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
  fileVolumeWrittenForms: file.fileVolumeWrittenForms,
};

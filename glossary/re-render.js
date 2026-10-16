/**
 * glossary/re-render.js — re-render a volume's published glossary out of the record that published it,
 * with **no model call anywhere**.
 *
 * Why this door exists. The glossary stage publishes `glossary.md` by rendering it out of the volume's
 * reference record (`glossary/store.js`'s `renderGlossaryArtifact`). Once the stage has run, there is no
 * way to republish that file — to change the shape of the document without changing a single row — without
 * re-running the stage, and re-running the stage means paying for the read pass again. This door is the
 * half that costs nothing: read the record, render it, compare it against the file on disk, and say out
 * loud what would change before anything is replaced.
 *
 * What this door guarantees, in code rather than in a flag you can forget:
 *
 *   - **It is not part of a run.** No stage calls it, no prompt mentions it, and `npx gulp`,
 *     `npm run pipeline` and `npm start` never reach it. The only way it happens is somebody types this
 *     command.
 *   - **It never opens the corpus record.** The record is copied with `fs.copyFileSync` and the copy is
 *     what gets opened, because opening a `series.db` with a database client checkpoints its write-ahead
 *     log and deletes the `-wal` / `-shm` sidecars beside it (gotcha 124). A read-only act must not be
 *     the thing that changed the shape of what it read.
 *   - **The comparison runs before anything is replaced, and every row that would disappear is named with
 *     the rule that refused it.** `compareGlossaryRender` answers row by row, and
 *     `explainAbsentGlossaryRow` re-asks the store's own evidence door against this volume's own book.
 *   - **A render that would lose or rewrite a row is refused, with no flag past it.** The comparison is a
 *     gate, not a report.
 *   - **No row is written, edited, moved or re-labelled.** The door opens the copy read-only in every
 *     practical sense: it calls no write verb on the handle, and the measurement suite proves every
 *     glossary-family row's content columns and `row_version` are identical before and after the render.
 *   - **It rehearses by default.** Without `--apply` nothing in the series folder is touched; the render
 *     and the comparison land in a copy under `--out`. `--apply` publishes, and only after the file it
 *     replaces has been moved to `glossary.md.rejected` — the shape `classifyVolumeQuarantine` reads as
 *     the copy a re-render replaced (LOW), not as a gate refusal.
 *   - **The freeze gate is asked, under the door it already covers.** `--apply` asks the `glossary` door —
 *     the one that already owns `glossary.md` — with `cancelledBy: "apply"`. No new door is added to the
 *     table and no flag reaches the gate; a volume whose translation stands on its glossary is refused,
 *     and the refusal names `release-translation` as the only way past.
 *
 * Usage:
 *   node re-render-glossary.js --volume=01 --out=/tmp/opencode/rehearsal      # rehearsal
 *   node re-render-glossary.js --all                                          # compare all 17, write nothing
 *   node re-render-glossary.js --volume=01 --apply --move-aside               # publish, keeping the old file
 *   node re-render-glossary.js --list                                         # what it would do, against which folder
 *
 * Flags:
 *   --volume=NN          one volume (except with --all / --list)
 *   --all                every volume in the plan of record
 *   --series=<dir>       the folder holding the volume folders (default SERIES_LOCATION)
 *   --out=<dir>          rehearsal root: the copy of the record, the render and the report all go here
 *   --apply              write into the volume folder (asks the freeze gate first)
 *   --move-aside         with --apply: move the existing `glossary.md` to `.rejected` first (required when
 *                        the volume already has one — a re-render does not overwrite a glossary silently)
 *   --report=<path>      where the markdown report goes (default: inside the rehearsal root)
 *   --json               also print the machine-readable comparison
 *   --list               print the plan and stop
 *
 * Exit codes: 0 nothing found, 2 findings that do not block (a volume refused, a render that differs),
 * 1 the freeze gate refused or a volume folder could not be read.
 *
 * @module glossary/re-render
 */

const compare = require("./re-render/compare");
const record = require("./re-render/record");
const publish = require("./re-render/publish");

module.exports = {
  // The comparison.
  classifyGlossaryLines: compare.classifyGlossaryLines,
  withoutTableHeaders: compare.withoutTableHeaders,
  glossaryRowsByKey: compare.glossaryRowsByKey,
  tableCellCount: compare.tableCellCount,
  headerDeclaresReadingColumn: compare.headerDeclaresReadingColumn,
  readingSetOf: compare.readingSetOf,
  compareReadingCell: compare.compareReadingCell,
  guideSplitFormsOfHarvest: compare.guideSplitFormsOfHarvest,
  explainAbsentGlossaryRow: compare.explainAbsentGlossaryRow,
  compareGlossaryRender: compare.compareGlossaryRender,
  // The record, read from a copy.
  RECORD_FILE: record.RECORD_FILE,
  copyRecordForReading: record.copyRecordForReading,
  readHarvestRows: record.readHarvestRows,
  renderGlossaryFromRecordCopy: record.renderGlossaryFromRecordCopy,
  // The publish, and its refusals.
  GLOSSARY_ARTIFACT: publish.GLOSSARY_ARTIFACT,
  measureGlossaryRender: publish.measureGlossaryRender,
  publishGlossaryRender: publish.publishGlossaryRender,
};

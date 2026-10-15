/**
 * character-voice/reconcile.js — the character-voice step's closing cast reconciliation, and the public
 * face of the `character-voice/reconcile/` folder (AGENTS.md §3: the barrel is the public surface, the
 * folder is the code).
 *
 * The stage reads a volume chapter by chapter, files what it found, renders the volume's two artifacts,
 * audits, grades, seals — and every one of those acts is done **from one volume's point of view**. The
 * per-book coverage guard (`utils/reference-store/integrity/coverage.js`) asks the same way: is anybody this
 * volume's text puts on a page missing from this volume's reference? Its softer half used to be a MAJOR,
 * which paused a 17-volume run at the volume boundary on names a shop clerk drops once.
 *
 * This pass is where that decision now lives. It runs **once, after the last volume**, and asks the question
 * the whole series makes possible:
 *
 *   1. **Which names does the series actually say something about?** — bucket 1, *named and voiced*. Nothing
 *      to do.
 *   2. **Which names does the roster hold that the book never puts on a page?** — bucket 2, *named and never
 *      seen*. Published as a **named absence**: printed, filed nowhere, and not a failure.
 *   3. **Which names are on a page in a book that said nothing about them?** — bucket 3. Split by the
 *      owner's rule: interchangeable ones are recorded and the run continues; ones the story keeps are
 *      investigated, deterministically, from what the record already measures.
 *
 * It mirrors `glossary/settlement.js` in shape on purpose — once, after the last volume, a query over the
 * settled record, its two files in the run's own records and **not** declared artifacts, refused
 * structurally when handed no record, skipped for `--volume` and `--dry-run` — because that shape already
 * exists in this repository and a second one invented for the same job is a second set of edges to learn.
 *
 * What it does **not** do: it makes no model call (not one, anywhere in this slice — plan 06 §9 forbids a
 * model judging importance), files no finding, opens no ticket, adds no finding kind, adds no declared
 * artifact or run expectation, adds no freeze door, adds no setting or environment knob, adds no command,
 * writes no row into any reference record, edits no published row, and writes nothing into
 * `character-voice.md` or `pov-map.md`. It opens the settled record read-only, which also keeps it clear of
 * gotcha 124.
 *
 * @module character-voice/reconcile
 */

require("dotenv").config();
const fs = require("fs");
require("../types"); // JSDoc type definitions
const { structuralError } = require("../configs/shared");
const { settledGlossaryRecord, withSettledRecord } = require("../utils/translate");

const { castBuckets } = require("./reconcile/buckets");
const { classifyFungibility, rosterVolumesHeld, NOT_FUNGIBLE_MIN_VOLUMES } = require("./reconcile/fungibility");
const {
  reconciliationRecordPaths,
  renderReconciliationLog,
  writeReconciliationRecord,
  describeReconciliation,
} = require("./reconcile/records");

/**
 * Split the whole roster by one recurrence measure.
 *
 * Two measures are reported because the plan quotes one and the shipped rule uses the other, and a reader
 * has to be able to see the difference rather than pick a favourite: how long the roster has carried an
 * entry, versus how many volumes' text the store actually searched and found the name in.
 *
 * @param {Array<Object>} rows - Every roster entry, with its presence already measured.
 * @param {number[]} volumes - Every volume the settled record registers.
 * @returns {{rosterAge: {recurring: number, single: number}, presence: {recurring: number, single: number, neverPresent: number}, disagreement: number}}
 */
function recurrenceSplits(rows, volumes) {
  let ageRecurring = 0;
  let ageSingle = 0;
  let presentRecurring = 0;
  let presentSingle = 0;
  let neverPresent = 0;
  let disagreement = 0;
  for (const row of rows) {
    const held = row.volumesOnRoster;
    const seen = row.volumesPresent.length;
    if (held >= NOT_FUNGIBLE_MIN_VOLUMES) ageRecurring++;
    else ageSingle++;
    if (seen >= NOT_FUNGIBLE_MIN_VOLUMES) presentRecurring++;
    else if (seen === 1) presentSingle++;
    else neverPresent++;
    if (held >= NOT_FUNGIBLE_MIN_VOLUMES && seen < NOT_FUNGIBLE_MIN_VOLUMES) disagreement++;
  }
  return {
    rosterAge: { recurring: ageRecurring, single: ageSingle },
    presence: { recurring: presentRecurring, single: presentSingle, neverPresent },
    disagreement,
    volumes,
  };
}

/**
 * The character-voice step's `afterVolumes`: reconcile the cast the whole series produced.
 *
 * Runs after every volume has been walked, including a run where every volume was skipped — the settled
 * record exists whether or not this run rebuilt anything, and a run that rebuilt nothing is exactly the run
 * that should still find out what its cast looks like. It does **not** run when the volume-halt gate stopped
 * the walk (`utils/series-run/loop.js` does not call `afterVolumes` after a halt), because reconciling a
 * cast over a record the assessment just refused is the thing the halt exists to prevent. It does **not**
 * run when any volume failed either: after a failed volume the highest-numbered record on disk is that
 * volume's half-built one, and reconciling off it would publish an answer about books this run never read.
 * The volume failure is already the report, and this pass adds nothing to it.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir - Absolute series folder.
 * @param {string[]} [opts.folders] - The volume folders, in reading order. Reported, never used to decide which record is the settled one.
 * @param {Map<string, Object>} [opts.volumeByFolder] - Each folder's volume from the plan of record.
 * @param {string|null} [opts.volumeArg] - The `--volume` filter: one volume's roster is not the series' roster.
 * @param {string[]} [opts.unfinishedVolumes] - Volume folders this walk did not finish. A run that left a volume broken has no settled cast, and the broken volume's half-built record is the highest-numbered one on disk.
 * @param {boolean} opts.dryRun
 * @returns {{ran: boolean, skipped: string|null, summary: Object|null, written: Object|null}}
 * @throws {Error} A structural refusal when the series has no readable settled record, or when that record holds no presence measurement.
 */
function reconcileCastRun({ seriesDir, folders = null, volumeByFolder = null, volumeArg = null, unfinishedVolumes = [], dryRun }) {
  if (dryRun) {
    console.log(
      `\n--dry-run: skipping the closing cast reconciliation (dry runs make no writes and read no record). ` +
        `A live run would ask the settled reference record the three-bucket question and write ` +
        `${reconciliationRecordPaths(seriesDir).markdown}.`
    );
    return { ran: false, skipped: "dry-run", summary: null, written: null };
  }
  if (volumeArg) {
    console.log(
      `\n--volume: skipping the closing cast reconciliation (one volume's roster is not the series' roster, ` +
        `and "is this character interchangeable?" is a question about the whole series).`
    );
    return { ran: false, skipped: "volume-arg", summary: null, written: null };
  }
  if (Array.isArray(unfinishedVolumes) && unfinishedVolumes.length > 0) {
    console.log(
      `\ncast reconciliation: skipped — this run did not finish ${unfinishedVolumes.length} volume(s) ` +
        `(${unfinishedVolumes.join(", ")}), so there is no settled cast to reconcile. The record on disk is ` +
        `the newest one, which after a failed volume is that volume's half-built one, and reconciling a cast ` +
        `off it would publish an answer about books this run never read. The volume failures are the report; ` +
        `this pass adds nothing to them.`
    );
    return { ran: false, skipped: "unfinished-volumes", summary: null, written: null };
  }

  const settled = settledGlossaryRecord({ seriesDir });
  const buckets = withSettledRecord({ seriesDir, record: settled }, (handle) => castBuckets(handle, { volume: settled.volume }));

  const allRows = [...buckets.voiced, ...buckets.neverSeen, ...buckets.onPageUnrecorded];
  // Plan 06 §2.10's measure, kept beside the shipped one so the two can be compared in the output rather
  // than argued about: how many volumes of this series the roster has carried the entry for.
  for (const row of allRows) row.volumesOnRoster = rosterVolumesHeld(row, buckets.volumes);
  for (const row of buckets.onPageUnrecorded) row.decision = classifyFungibility(row, buckets.volumes);

  const splits = recurrenceSplits(allRows, buckets.volumes);
  const counts = {
    roster: buckets.roster,
    mergedEntries: buckets.mergedEntries,
    voiced: buckets.voiced.length,
    neverSeen: buckets.neverSeen.length,
    onPageUnrecorded: buckets.onPageUnrecorded.length,
    volumes: buckets.volumes,
    volumesMeasured: buckets.volumesMeasured,
    volumesUnmeasured: buckets.volumesUnmeasured,
  };
  const header = { settled, buckets, counts, splits, folders, volumeByFolder };

  const paths = reconciliationRecordPaths(seriesDir);
  const written = writeReconciliationRecord({
    file: paths.json,
    settled,
    buckets,
    counts,
    splits,
  });
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.markdown, renderReconciliationLog(header), "utf8");
  } catch (err) {
    throw structuralError(
      `[cast-reconciliation] could not write ${paths.markdown}: ${String(err && err.message ? err.message : err)}. ` +
        `The reconciliation's whole output is these two files; a run that cannot write them has no record of ` +
        `what its cast looked like at the end of the series.`
    );
  }
  if (!written.written) {
    throw structuralError(
      `[cast-reconciliation] could not write ${written.file}: ${written.error}. The machine twin is what a ` +
      `later run diffs against, so the pass does not continue having failed to write it.`
    );
  }

  for (const line of describeReconciliation(header)) console.log(line);
  console.log(`cast reconciliation: wrote ${written.file} and ${paths.markdown} (0 model calls, no row written, no artifact rewritten).`);

  return {
    ran: true,
    skipped: null,
    summary: { counts, splits, investigated: buckets.onPageUnrecorded.filter((row) => !row.decision.fungible).length, recorded: buckets.onPageUnrecorded.filter((row) => row.decision.fungible).length, settled },
    written: { json: written.file, markdown: paths.markdown },
  };
}

module.exports = {
  reconcileCastRun,
  recurrenceSplits,
  ...require("./reconcile/buckets"),
  ...require("./reconcile/fungibility"),
  ...require("./reconcile/records"),
};

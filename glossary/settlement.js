/**
 * glossary/settlement.js — the glossary stage's end-of-run settlement, and the public face of the
 * `glossary/settlement/` folder (AGENTS.md §3: the barrel is the public surface, the folder is the code).
 *
 * The glossary stage reads a volume, files what it found, renders the volume's file, grades it, seals
 * it — and stops. Every one of those acts is done **from one volume's point of view**, including the
 * revision door: volume 7 may replace a rendering volume 1 published, but only with a line volume 7's
 * own book prints, and only from volume 7 on. Nothing in the stage ever asks the question the whole
 * series makes possible: **now that every book has been read, is the rendering the series settled on
 * still the right one — for volume 1's chapters too?**
 *
 * That question is this pass. It runs once, after the last volume, and it does four things:
 *
 *   1. **Asks which terms are worth asking about** — a query over the settled record, never a model's
 *      shortlist (`settlement/agenda.js`): the terms the record has already revised, and the terms whose
 *      own note points at something the book had not said yet.
 *   2. **Asks one bounded, tool-less reading call per unanswered term** (`settlement/decide.js`), capped
 *      by `SETTLEMENT_MAX_TERMS_PER_RUN`, and remembers every answer in the run's own records so a
 *      second pass over the same agenda pays 0 calls (`settlement/records.js`).
 *   3. **Files a "change it" answer through the revision door that already exists** — the same door,
 *      the same quote rule, a new row beside the old one rather than an edit of it — and carries it to
 *      the settled record through the store's own top-up door.
 *   4. **Publishes the series-root `glossary.md` as a render of the settled record** instead of a copy
 *      of the last volume's file (`settlement/publish.js`), so the human-facing glossary and the
 *      terminology law the chapters are translated under are the same statement.
 *
 * What it does **not** do: it rewrites no per-volume `glossary.md`, edits no sealed row, opens no
 * dispute, files no `cast_alias`, touches no translation file, and reaches no agent — there is no tool
 * call and no agent turn anywhere in this pass. It runs its calls one at a time, because the model
 * endpoint on this machine answers one request at a time (AGENTS.md §7).
 *
 * The freeze gate covers it as its own door (`glossary-settlement` in `utils/prereqs/freeze.js`): a
 * published translation was built on a terminology law, and rewriting that law is a rewrite. The gate
 * is asked before anything is written, and no flag reaches it.
 *
 * @module glossary/settlement
 */

require("dotenv").config();
const fs = require("fs");
require("../types"); // JSDoc type definitions
const { structuralError } = require("../configs/shared");
const { assertDoorAllowed } = require("../utils/prereqs/freeze");
const { planSettlementPass, executeSettlementPass, runSettlementPass } = require("./settlement/decide");
const {
  publishSettledGlossaryToSeriesRoot,
  renderSettledGlossaryForSeriesRoot,
} = require("./settlement/publish");
const { settlementRecordPaths } = require("./settlement/records");
const { SETTLEMENT_MAX_TERMS_PER_RUN } = require("./settlement/agenda");

/** The name this pass knocks on the freeze gate with. */
const SETTLEMENT_DOOR = "glossary-settlement";

/**
 * The glossary step's `afterVolumes`: settle the terminology, then publish the series glossary from it.
 *
 * Runs after every volume has been walked, including a run where every volume was skipped — a settled
 * record exists whether or not this run rebuilt anything, and a run that skipped every volume is exactly
 * the run that should still find out whether the series' renderings are still right. It does **not** run
 * when the volume-halt gate stopped the walk: publishing a series glossary built on a volume the
 * assessment just refused is the thing the halt exists to prevent (`utils/series-run/loop.js`).
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir - Absolute series folder.
 * @param {string[]} opts.folders - The volume folders, in reading order.
 * @param {Map<string, Object>} opts.volumeByFolder - Each folder's volume from the plan of record.
 * @param {{seriesName: string, sourceLanguage: string, targetLanguage: string}} opts.runSettings
 * @param {string|null} [opts.volumeArg] - The `--volume` filter: one volume's view is not the series' settled view.
 * @param {boolean} opts.dryRun
 * @param {{ask?: Function}} [options] - `ask` stands where the model stands; the stage never passes it.
 * @returns {Promise<{ran: boolean, skipped: string|null, pass: Object|null, published: Object|null}>}
 * @throws {Error} A structural refusal when the series has no readable settled record, or when the render has no rows to publish.
 */
async function settleGlossaryRun({ seriesDir, folders, volumeByFolder, runSettings, volumeArg = null, dryRun }, { ask } = {}) {
  if (dryRun) {
    console.log(
      `\n--dry-run: skipping the glossary settlement and the series-root glossary render (dry runs make no writes and no calls). ` +
        `A live run would ask at most ${SETTLEMENT_MAX_TERMS_PER_RUN} settlement question(s) and write ${settlementRecordPaths(seriesDir).markdown}.`
    );
    return { ran: false, skipped: "dry-run", pass: null, published: null };
  }
  if (volumeArg) {
    console.log(
      `\n--volume: skipping the glossary settlement and the series-root glossary copy (one volume's view is not the series' settled view).`
    );
    return { ran: false, skipped: "volume-arg", pass: null, published: null };
  }

  const volumeRefs = folders.map((folder) => ({ folder, installmentNumber: volumeByFolder.get(folder).installmentNumber }));
  const values = {
    SOURCE_NAME: runSettings.seriesName,
    SOURCE_LANGUAGE: runSettings.sourceLanguage,
    TARGET_LANGUAGE: runSettings.targetLanguage,
  };

  // Read-only first: what would this act actually rewrite? The freeze gate asks exactly that question,
  // and the only honest answer needs the agenda, the decisions already recorded, and the file this act
  // would produce — all of which are computable without asking the model anything or writing anything.
  const plan = planSettlementPass({ seriesDir, volumeRefs });
  const rendered = renderSettledGlossaryForSeriesRoot({ seriesDir, values, settled: plan.settled });
  /** The series glossary as it stands on disk right now, or null when none has been published yet. */
  let alreadyOnDisk = null;
  try {
    alreadyOnDisk = fs.readFileSync(rendered.destination, "utf8");
  } catch {
    alreadyOnDisk = null;
  }
  const republishes = alreadyOnDisk !== rendered.markdown;
  // "Would this act file new rows?" is answered by the questions it can actually file an answer for. A
  // term whose flagging volume is not in this run's plan of record is re-tried every pass at no cost and
  // files nothing, so counting it here would refuse a run that rewrites nothing — a false refusal on a
  // series whose translations are already published, with no door to open but `release-translation`.
  const filesNewRows = plan.pending.some((item) => Boolean(plan.locate(item.flaggingVolume)));

  await assertDoorAllowed({
    door: SETTLEMENT_DOOR,
    seriesDir,
    // A pass with a question never asked before is about to file new rows into reference records, and a
    // pass whose render differs from the file on disk is about to replace the series' glossary. Either
    // one rewrites the terminology law a published translation was built under. A pass that would write
    // the identical file and file nothing does not, and the gate says so in its own verdict.
    cancelledBy: filesNewRows || republishes ? "settle" : "settlement-no-change",
    detail: filesNewRows ? `${plan.pending.length} term(s) have never been settled` : undefined,
    dryRun,
  });

  const pass = await executeSettlementPass(plan, { values, ...(ask ? { ask } : {}) });

  let published;
  if (!republishes) {
    console.log(
      `\nThe series-root glossary.md already matches the render of the settled record ` +
        `(${rendered.bytes} bytes, ${rendered.rows} row(s)) — nothing was rewritten.`
    );
    published = { ok: true, written: false, destination: rendered.destination, rows: rendered.rows, sections: rendered.sections, bytes: rendered.bytes, record: rendered.record, refusal: null };
  } else {
    published = await publishSettledGlossaryToSeriesRoot({ seriesDir, values, settled: pass.settled });
    if (!published.ok) {
      throw structuralError(
        `[glossary] ${published.refusal.rule}: ${published.refusal.because}\n  Fix: ${published.refusal.fix}`
      );
    }
    published.written = true;
  }
  return { ran: true, skipped: null, pass, published };
}

module.exports = {
  SETTLEMENT_DOOR,
  SETTLEMENT_MAX_TERMS_PER_RUN,
  settleGlossaryRun,
  runSettlementPass,
  publishSettledGlossaryToSeriesRoot,
  settlementRecordPaths,
  ...require("./settlement/agenda"),
  ...require("./settlement/decide"),
  ...require("./settlement/records"),
};

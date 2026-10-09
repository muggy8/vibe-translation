/**
 * delivery/stop-run.js — ending a run that is alive but no longer working.
 *
 * The run lock answers "may a second run start?". It was never designed to answer "what do I do
 * about this one?", and for a delivery layer meant to recover on its own that is the gap that
 * matters: a run wedged on a dead connection holds the claim under a LIVE pid, so every later run
 * refuses, and the only way out used to be a human deleting a file.
 *
 * `utils/runlock.js` decision 4 made the two cases distinguishable — a holder that has made no model
 * call or tool call for `RUN_STALL_MINUTES` is reported as *stalled*. This module is the one move
 * that move unlocks, and its whole design is about the direction of the error:
 *
 *   - **A run that is making progress is never stopped.** The threshold is deliberately longer than
 *     the model layer's own idle deadline, because the cost of a false "stalled" is the manager
 *     destroying an hour of translation work, and the cost of a false "still fine" is an hour of
 *     waiting. One of those is recoverable and the other is not.
 *   - **A lock this machine cannot check is never stopped.** "Cannot tell" has meant "no" everywhere
 *     else in this layer (decision 2), and a move that sends a signal to a pid is the least
 *     defensible place to guess.
 *   - **The claim is cleared only after the process is confirmed gone.** Clearing it first is how a
 *     second run starts while the first is still writing.
 *   - **It is recorded.** `kind: "intervention"` with `countsAsIntervention: false` (the menu's own
 *     flag): stopping a wedged process is not an attempt to fix a step, so it must not spend the
 *     per-step repair budget — but it is something this layer did to the machine, and an audit trail
 *     that omits it is not an audit trail.
 *
 * Report mode reports. Act mode acts. That split is the same one every other verb on this CLI uses.
 *
 * @module delivery/stop-run
 */

require("../types"); // JSDoc type definitions

const { appendLedgerEntry } = require("../utils/ledger");
const {
  runInProgress,
  clearRunLock,
  stallMinutes,
  describeRunLock,
  runLockPath,
  pidIsAlive,
} = require("../utils/runlock");
const { shutdownGraceMs } = require("../utils/shutdown");

/**
 * Wait for the grace period.
 *
 * Deliberately NOT an unref'd timer: this process is waiting precisely so that it does not end
 * before it has seen whether the holder stopped. An unref'd timer here lets Node exit the moment the
 * signal is sent, which turns "I stopped it and checked" into "I sent a signal and vanished".
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send one signal to the pid the lock names.
 *
 * `process.kill` on a pid that is not ours to signal throws EPERM, and that is reported rather than
 * swallowed: "I could not stop it" and "I stopped it" have to be distinguishable, because the claim
 * is only cleared in the second case.
 *
 * @param {number} pid
 * @param {string} signal
 * @returns {string|null} The error to report, or null when the signal was delivered.
 */
function signalRun(pid, signal) {
  try {
    process.kill(pid, signal);
    return null;
  } catch (err) {
    if (err && err.code === "ESRCH") return null; // already gone, which is the outcome we wanted
    return `the ${signal} could not be delivered to pid ${pid} (${err.message})`;
  }
}

/**
 * Decide, and act if the decision is allowed.
 *
 * @param {{mode: string, run?: string|null}} opts
 * @returns {Promise<{exitCode: number, action: string, note: string, detail: string[], recorded: boolean}>}
 *   `action` is what happened — `nothing`, `would-stop`, `stopped`, `refused` — and `detail` is the
 *   lines to print, written for a reader who was not there.
 */
async function stopStalledRun({ mode, run = null }) {
  const detail = [];
  const out = (exitCode, action, note) => ({ exitCode, action, note, detail, recorded: false });

  let state;
  try {
    state = runInProgress();
  } catch (err) {
    return out(2, "refused", `the run lock could not be read (${err.message}).`);
  }

  if (state.error) return out(2, "refused", state.error);
  if (!state.lock) return out(0, "nothing", "no run is in progress, so there is nothing to stop.");
  if (state.stale) {
    return out(
      0,
      "nothing",
      `${describeRunLock(state.lock)} — that process is already gone. A stale lock is replaced by the ` +
        `next run that wants it; there is no process to stop.`
    );
  }
  if (state.unverifiable) {
    return out(
      2,
      "refused",
      `${describeRunLock(state.lock)} — this machine cannot check that pid. Sending a signal to a pid ` +
        `this layer cannot confirm is not a recovery move.`
    );
  }
  if (!state.stalled) {
    const idle = state.idleMinutes === null ? "no heartbeat yet" : `last beat ${state.idleMinutes} minute(s) ago`;
    return out(
      2,
      "refused",
      `${describeRunLock(state.lock)} is making progress (${state.beats} beat(s), ${idle}). ` +
        `A run that is working is not stopped — the stall threshold is ${stallMinutes()} minute(s) of ` +
        `no model call and no tool call, and it is that way because ending a healthy run costs the ` +
        `work it had already done.`
    );
  }

  // Stalled, and confirmed stalled: alive, quiet for longer than the threshold, and carrying a
  // heartbeat that proves it was working at some point.
  const pid = state.lock.pid;
  detail.push(
    `run lock: ${runLockPath()}`,
    `holder: ${describeRunLock(state.lock)}`,
    `stall threshold: ${stallMinutes()} minute(s) of no model call and no tool call`
  );

  if (mode !== "act") {
    return out(
      0,
      "would-stop",
      `report mode: pid ${pid} would be asked to stop, and its claim cleared. ` +
        `Run it with --mode=act.`
    );
  }

  console.log(`[delivery] pid ${pid} has been quiet for ${state.idleMinutes} minute(s). Asking it to stop.`);
  const sendError = signalRun(pid, "SIGTERM");
  if (sendError) return out(2, "refused", sendError);

  // The grace period is the same one the shutdown watch gives its own children: a run that is
  // mid-write gets the chance to finish the file it is holding.
  const grace = shutdownGraceMs();
  await wait(grace);
  if (pidIsAlive(pid) === true) {
    console.error(`[delivery] pid ${pid} ignored the request within ${grace}ms. Forcing it.`);
    const killError = signalRun(pid, "SIGKILL");
    if (killError) return out(2, "refused", killError);
    await wait(1000);
  }

  const alive = pidIsAlive(pid);
  if (alive === true) {
    return out(
      2,
      "refused",
      `pid ${pid} is still alive after SIGTERM and SIGKILL. The claim is NOT cleared: a lock whose ` +
        `holder is alive is the one thing this layer must never delete.`
    );
  }

  const cleared = clearRunLock({ pid, reason: `stalled for ${state.idleMinutes} minute(s)` });
  if (!cleared.removed) return out(2, "refused", cleared.note);

  const recorded = appendLedgerEntry({
    kind: "intervention",
    run: run || undefined,
    step: "delivery",
    volume: null,
    finding: "run-lock-stalled",
    action: "stop-stalled-run",
    outcome: "unchanged",
    decidedBy: "manager",
    note:
      `ended a run that had gone quiet for ${state.idleMinutes} minute(s): ${describeRunLock(state.lock)}. ` +
      `No corpus file was touched; the deliverable did not move, which is what "unchanged" means here.`,
  });

  detail.push(`claim: ${cleared.note}`);
  detail.push(
    recorded.error
      ? `ledger: the record could not be written (${recorded.error})`
      : `ledger: recorded as ${recorded.entry ? recorded.entry.id : "an intervention"}`
  );

  return {
    exitCode: 0,
    action: "stopped",
    note: `pid ${pid} was stopped and its claim cleared. The next run can start.`,
    detail,
    recorded: !recorded.error,
  };
}

module.exports = { stopStalledRun };

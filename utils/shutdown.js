/**
 * utils/shutdown.js — stopping the work this process started.
 *
 * Every runner in this layer does its work in a CHILD process: `index.js` spawns one gulp
 * process per step, `delivery.js --mode=act` spawns `index.js`, `autopilot.js` spawns
 * `delivery.js`. That separation is deliberate (a stage that leaks, hangs or dies on a model
 * call cannot take the runner or the next step with it), but it has a consequence nobody
 * handled until now: **Node ends the process that received the signal and leaves its children
 * running.**
 *
 * Measured rather than assumed (`/tmp/opencode/locktest`, 2026-10-09):
 *   - Ctrl-C in a terminal reaches the whole process group, so a terminal Ctrl-C stops the
 *     child too;
 *   - a signal aimed at the parent alone — `docker stop`, `kill <pid>`, a process manager, an
 *     OOM kill of the parent, an uncaught crash — leaves the child working, alone, with nobody
 *     who can tell it to stop.
 *
 * That orphan is the shape the run lock exists to detect, and detecting it is not the same as
 * preventing it: the orphan keeps writing volume files, it keeps the run lock held by a LIVE
 * pid, and every later run therefore refuses to start until a human deletes a file. A delivery
 * layer that needs a human for that is not unattended.
 *
 * Three rules here:
 *   1. **Stop the children first, then hand the lock back.** Releasing the claim while a child
 *      is still writing is how two processes end up in the same volume folder — the exact
 *      failure the lock is for.
 *   2. **Bounded, not polite.** A child that will not stop is forced after the grace period.
 *      A half-written file is recoverable (the step is re-run from a wiped folder); a run that
 *      can never be stopped is not.
 *   3. **A stop is remembered.** `isStopping()` is how the step loops know not to start the
 *      next step. Without it, killing the current child makes the runner cheerfully begin the
 *      one after it.
 *
 * This module is deliberately NOT one of the banned patch paths: it owns no gate, no budget and
 * no record. The guarantee it protects — the run lock — still lives in `utils/runlock.js`, and
 * that file is still off-limits to the dev team.
 *
 * @module utils/shutdown
 */

require("../types"); // JSDoc type definitions

/** Tracked children: the process handle and the label a log line can use. */
const tracked = new Set();

let watchInstalled = false;
let stopping = false;
let stopSignal = null;

/**
 * How long a tracked child gets to stop itself before it is forced.
 *
 * `RUN_SHUTDOWN_GRACE_MS`, default 20 seconds. Long enough for a gulp task to finish the file it
 * is mid-way through writing, short enough that a wedged child cannot hold the run lock
 * indefinitely. 0 means "force immediately".
 *
 * @returns {number} Milliseconds.
 */
function shutdownGraceMs() {
  const raw = parseInt(process.env.RUN_SHUTDOWN_GRACE_MS, 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 20000;
}

/**
 * The exit code a stopped run ends with.
 *
 * 130 for SIGINT and 143 for SIGTERM are the shell's own convention (128 + the signal), so a
 * wrapper, a CI step or a compose file reads the number the same way it would read any other
 * program's.
 *
 * @param {string} signal
 * @returns {number}
 */
function exitCodeForSignal(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

/**
 * Register a child process this run started, so a stop signal reaches it.
 *
 * @param {import("child_process").ChildProcess} child
 * @param {string} label - What to call it in the log line ("gulp glossary", "index.js --stages=…").
 * @returns {import("child_process").ChildProcess} The same child, so callers can keep their own wiring.
 */
function trackChild(child, label) {
  if (!child || !child.pid) return child;
  const entry = { child, label: label || `pid ${child.pid}` };
  tracked.add(entry);
  const forget = () => tracked.delete(entry);
  child.on("close", forget);
  child.on("error", forget);
  return child;
}

/**
 * Is this process on its way out?
 *
 * The step loops ask this before starting the NEXT step. A stopped child is not a failed step,
 * and treating it as one would make the runner continue down the pipeline while the account
 * owner is trying to stop it.
 *
 * @returns {boolean}
 */
function isStopping() {
  return stopping;
}

/**
 * The signal that started the stop, or null when nothing has been asked to stop.
 * @returns {string|null}
 */
function stoppingSignal() {
  return stopSignal;
}

/**
 * Ask every tracked child to stop, and wait for them.
 *
 * SIGTERM first — a gulp task mid-write gets the chance to finish the file it is holding. Then
 * the grace period, then SIGKILL for anything still alive. The promise resolves when every
 * tracked child is gone or the grace has run out, whichever happens first.
 *
 * @param {number} [graceMs] - Defaults to `shutdownGraceMs()`.
 * @returns {Promise<Array<{label: string, forced: boolean}>>} What had to be forced.
 */
function stopTrackedChildren(graceMs = shutdownGraceMs()) {
  const live = [...tracked];
  if (!live.length) return Promise.resolve([]);

  console.log(
    `[shutdown] stopping ${live.length} process(es) this run started: ` +
      live.map((t) => `${t.label} (pid ${t.child.pid})`).join(", ")
  );

  const waits = live.map((t) => {
    const child = t.child;
    if (!child.pid || child.killed) return Promise.resolve({ label: t.label, forced: false });
    let done = false;
    const closed = new Promise((resolve) => {
      child.once("close", () => {
        done = true;
        resolve({ label: t.label, forced: false });
      });
    });
    child.kill("SIGTERM");
    const forced = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (done) return;
        console.error(
          `[shutdown] ${t.label} (pid ${child.pid}) did not stop within ${graceMs}ms — forcing it. ` +
            `A file it was mid-way through writing is left half-written; the step is re-run from a ` +
            `wiped folder, so the recoverable cost is this step, not the volume.`
        );
        child.kill("SIGKILL");
        resolve({ label: t.label, forced: true });
      }, graceMs);
      if (timer.unref) timer.unref();
    });
    return Promise.race([closed, forced]);
  });

  return Promise.all(waits);
}

/**
 * Install the stop-signal watch for this process.
 *
 * Idempotent: the runner, the manager and a gulp task may all call it and only one watch exists.
 *
 * The sequence on SIGINT/SIGTERM is: stop the children → wait for them → run `onStop` (which is
 * where a caller releases the run lock) → exit with the conventional code. A second signal while
 * stopping is honoured immediately rather than queued, because the account owner pressing Ctrl-C
 * twice is telling you the first one did not work.
 *
 * @param {{label: string, onStop?: (signal: string) => void|Promise<void>}} opts
 *   `label` names this process in the log line. `onStop` runs after the children are gone and
 *   before the process exits — the place to hand the run lock back.
 * @returns {void}
 */
function installShutdownWatch({ label, onStop }) {
  if (watchInstalled) return;
  watchInstalled = true;

  const handle = async (signal) => {
    if (stopping) {
      console.error(`[shutdown] second ${signal} — ending now.`);
      process.exit(exitCodeForSignal(signal));
    }
    stopping = true;
    stopSignal = signal;
    console.log(`[shutdown] ${label}: ${signal} received. Stopping this run's work before ending.`);

    const forced = await stopTrackedChildren();
    const stillHere = [...tracked].filter((t) => t.child.pid && !t.child.killed);
    if (stillHere.length) {
      console.error(
        `[shutdown] ${stillHere.length} process(es) are still alive after the grace period: ` +
          stillHere.map((t) => `${t.label} (pid ${t.child.pid})`).join(", ") +
          `. They are NOT being waited for, and they are NOT being forgotten — the next run will ` +
          `find them holding the lock, and it will be right to refuse.`
      );
    }

    try {
      if (onStop) await onStop(signal);
    } catch (err) {
      console.error(`[shutdown] the stop handler failed (${err.message}). Continuing to exit.`);
    }

    if (forced.length) {
      console.log(`[shutdown] ${forced.length} process(es) had to be forced to stop.`);
    }
    process.exit(exitCodeForSignal(signal));
  };

  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
}

/**
 * Forget every tracked child. Test-only: the suites run several scenarios in one process and a
 * child left in the set would be stopped by a later scenario's signal.
 *
 * @returns {void}
 */
function clearTrackedChildren() {
  tracked.clear();
}

module.exports = {
  shutdownGraceMs,
  exitCodeForSignal,
  trackChild,
  isStopping,
  stoppingSignal,
  stopTrackedChildren,
  installShutdownWatch,
  clearTrackedChildren,
};

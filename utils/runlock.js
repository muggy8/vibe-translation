/**
 * utils/runlock.js — who is running the pipeline right now.
 *
 * The delivery manager has the authority to wipe a volume's outputs and start a step
 * (docs/delivery-layer.md). That authority has one failure mode that has nothing to do with the
 * manager's judgment: **it starts a step while a step is already running.** Two processes
 * writing the same volume folder is how a run ends with an artifact half-built by one and
 * half by the other, and the pipeline has no way to notice afterwards.
 *
 * So the runner announces itself. `index.js` and every gulp task take a lock for the
 * duration of the work, and the manager refuses to start anything while the lock is held
 * by a live process. It is a file, not a syscall: the two things that need to see it are
 * different processes started at different times by different people.
 *
 * Three decisions in here:
 *   1. **A lock is only advisory to the pipeline and binding to the manager.** A gulp task
 *      that cannot write the lock file warns and carries on — a broken lock file must not
 *      be the reason a 12-hour run dies. The manager, whose whole job is deciding whether
 *      it is safe to act, treats "I cannot tell" as "no".
 *   2. **Liveness is the pid, and a pid I cannot check is not a green light.** A lock
 *      written on another machine (this repo runs on both Windows and Linux, and a run
 *      started on one is not visible to the other) names a pid that means nothing here.
 *      That is reported as *in progress*, with the file to delete named out loud.
 *      Refusing is recoverable; a half-written volume is not.
 *   3. **A lock held by the same run is not a conflict.** `index.js` holds the lock and
 *      spawns one gulp process per step; each child inherits `INDEX_RUN_ID`, sees its own
 *      run id in the file, and carries on. Nesting inside one process is counted, so only
 *      the outermost holder removes the file.
 *
 * @module utils/runlock
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { postMortemDir } = require("./postmortem");
const { runId } = require("./ledger");

/**
 * `<POSTMORTEM_DIR>/run.lock` — machine state, gitignored like the reports beside it.
 * @returns {string} Absolute path.
 */
function runLockPath() {
  return path.join(postMortemDir(), "run.lock");
}

/**
 * One held lock.
 *
 * @typedef {Object} RunLock
 * @property {string} runId - The run that holds it (`INDEX_RUN_ID`).
 * @property {number} pid - The process that wrote it.
 * @property {string} host - The machine that wrote it, because a pid from another one proves nothing.
 * @property {string} by - Who took it: `index.js`, `gulp <task>`, `delivery.js act`.
 * @property {string} startedAt - ISO timestamp.
 */

/**
 * Read the lock.
 *
 * Never reports a corrupt lock as "no lock": the whole point of the file is to be believed,
 * and a half-written one is exactly the state where believing it is dangerous. (The same
 * honesty rule as `readUsableManifest` and `readLedger` — gotcha 33, gotcha 69.)
 *
 * @param {string} [filePath] - Defaults to `runLockPath()`.
 * @returns {{lock: RunLock|null, error: string|null}}
 */
function readRunLock(filePath = runLockPath()) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { lock: null, error: null };
    return { lock: null, error: `the run lock could not be read (${err.message})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { lock: null, error: `the run lock is not valid JSON (${err.message}) — it is not being treated as absent` };
  }
  if (!parsed || typeof parsed !== "object" || !parsed.runId || !parsed.pid) {
    return { lock: null, error: "the run lock has no `runId`/`pid` — it is not being treated as absent" };
  }
  return {
    lock: {
      runId: String(parsed.runId),
      pid: Number(parsed.pid),
      host: String(parsed.host || "unknown"),
      by: String(parsed.by || "unknown"),
      startedAt: String(parsed.startedAt || "unknown"),
    },
    error: null,
  };
}

/**
 * Is this pid a live process, as far as this machine can tell?
 *
 * `null` means "cannot tell", and the caller must not read that as "dead".
 *
 * @param {number} pid
 * @returns {boolean|null}
 */
function pidIsAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  try {
    process.kill(n, 0); // signal 0: existence check only, sends nothing
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false; // no such process
    if (err.code === "EPERM") return true; // it exists, it is just not ours to signal
    return null;
  }
}

/**
 * One line a human can act on.
 * @param {RunLock} lock
 * @returns {string}
 */
function describeRunLock(lock) {
  if (!lock) return "no run lock";
  return (
    `run ${lock.runId} started ${lock.startedAt} by ${lock.by} ` +
    `(pid ${lock.pid} on ${lock.host})`
  );
}

/**
 * Nesting bookkeeping for THIS process: how many wrapped tasks are inside it, and whether
 * this process is the one that actually wrote the file. Only the writer may delete it —
 * a gulp child that inherited its parent's lock must not remove it when its own task ends.
 */
let held = null;

/**
 * Is this lock the run we are part of?
 *
 * @param {RunLock} lock
 * @param {string} run - Our run id.
 * @returns {boolean}
 */
function lockIsOurs(lock, run) {
  return Boolean(lock) && String(lock.runId) === String(run);
}

/**
 * Is a run in progress?
 *
 * @param {{filePath?: string, run?: string}} [opts]
 * @returns {{inProgress: boolean, ours: boolean, stale: boolean, unverifiable: boolean,
 *   lock: RunLock|null, error: string|null, note: string|null}}
 */
function runInProgress(opts = {}) {
  const filePath = opts.filePath || runLockPath();
  const run = opts.run || runId();
  const { lock, error } = readRunLock(filePath);

  if (error) {
    // Cannot read it, so cannot rule out a run. The manager reads this as "no".
    return { inProgress: true, ours: false, stale: false, unverifiable: true, lock: null, error, note: error };
  }
  if (!lock) {
    return { inProgress: false, ours: false, stale: false, unverifiable: false, lock: null, error: null, note: null };
  }
  if (lockIsOurs(lock, run)) {
    return { inProgress: false, ours: true, stale: false, unverifiable: false, lock, error: null, note: null };
  }

  const alive = pidIsAlive(lock.pid);
  if (alive === false) {
    return {
      inProgress: false,
      ours: false,
      stale: true,
      unverifiable: false,
      lock,
      error: null,
      note: `a lock left behind by ${describeRunLock(lock)} — that process is gone, so the lock is stale and is being replaced`,
    };
  }
  if (alive === null) {
    return {
      inProgress: true,
      ours: false,
      stale: false,
      unverifiable: true,
      lock,
      error: null,
      note:
        `${describeRunLock(lock)} — this machine cannot check that pid, so it is treated as running. ` +
        `If that run is not actually running, delete ${filePath}.`,
    };
  }
  return {
    inProgress: true,
    ours: false,
    stale: false,
    unverifiable: false,
    lock,
    error: null,
    note: `${describeRunLock(lock)} is still running.`,
  };
}

/**
 * Take the lock for the duration of this process's work (or, when this process is already
 * inside a held run, join it).
 *
 * @param {{by: string, run?: string, filePath?: string}} opts - `by` names who is holding it.
 * @returns {{acquired: boolean, ours: boolean, reentrant: boolean, lock: RunLock|null,
 *   error: string|null, note: string|null}} `ours` is true when this process may delete the
 *   file at the end; `reentrant` when it joined a lock it did not write.
 */
function acquireRunLock({ by, run, filePath } = {}) {
  const lockPath = filePath || runLockPath();
  const myRun = run || runId();

  if (held) {
    held.depth += 1;
    return { acquired: true, ours: held.wrote, reentrant: true, lock: held.lock, error: null, note: null };
  }

  const state = runInProgress({ filePath: lockPath, run: myRun });
  if (state.inProgress && !state.ours) {
    return { acquired: false, ours: false, reentrant: false, lock: state.lock, error: state.error || null, note: state.note };
  }
  if (state.ours) {
    held = { depth: 1, wrote: false, lock: state.lock };
    return { acquired: true, ours: false, reentrant: true, lock: state.lock, error: null, note: state.stale ? state.note : null };
  }

  const lock = {
    runId: myRun,
    pid: process.pid,
    host: os.hostname(),
    by: by || "pipeline",
    startedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
  } catch (err) {
    // A pipeline must not die because a bookkeeping file could not be written. The manager
    // decides what to do with `acquired: false`; the task wrappers warn and carry on.
    return {
      acquired: false,
      ours: false,
      reentrant: false,
      lock: null,
      error: `the run lock could not be written (${err.message})`,
      note: "the run lock could not be written, so nothing is preventing a second run",
    };
  }
  held = { depth: 1, wrote: true, lock };
  return { acquired: true, ours: true, reentrant: false, lock, error: null, note: state.stale ? state.note : null };
}

/**
 * Release one level of holding. The file is removed only by the process that wrote it, and
 * only when its outermost wrapper finishes.
 *
 * @param {{filePath?: string}} [opts]
 * @returns {boolean} Whether the lock file was removed.
 */
function releaseRunLock(opts = {}) {
  const filePath = opts.filePath || runLockPath();
  if (!held) return false;
  held.depth -= 1;
  if (held.depth > 0) return false;
  const wrote = held.wrote;
  held = null;
  if (!wrote) return false; // inherited from a parent process — that one will clean up
  try {
    const { lock } = readRunLock(filePath);
    if (lock && lock.pid === process.pid) fs.rmSync(filePath, { force: true });
  } catch {
    // A lock we cannot remove is a lock the next run will find stale and replace.
  }
  return true;
}

module.exports = {
  runLockPath,
  readRunLock,
  pidIsAlive,
  describeRunLock,
  runInProgress,
  acquireRunLock,
  releaseRunLock,
};

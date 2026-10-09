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
 *   3. **A lock held by the same LIVE run is not a conflict.** `index.js` holds the lock and
 *      spawns one gulp process per step; each child inherits `INDEX_RUN_ID`, sees its own
 *      run id in the file, and carries on. Nesting inside one process is counted, so only
 *      the outermost holder removes the file. "Same run" is not enough on its own: act mode
 *      reuses the newest recorded run id, so a lock left by a process that died carries that id
 *      too, and a lock whose holder is gone is stale whoever reads it — replacing it is the
 *      only way the stale lock ever ends.
 *   4. **"A process exists" and "a process is making progress" are different questions, and the
 *      delivery layer has to be able to ask the second one.** A run wedged on one dead request
 *      and a run working through a long chapter both hold the lock under a live pid, and until
 *      now both produced the same refusal forever. So the lock carries a heartbeat: the holder
 *      stamps it whenever it starts or finishes a model request, or makes a tool call. A live
 *      holder that has not stamped it in `RUN_STALL_MINUTES` is reported as *stalled* — still a
 *      run in progress (a second run must still not start), but now a distinguishable one, and
 *      the only kind the manager is allowed to end (`delivery.js --stop-run`).
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
 * @property {string|null} heartbeatAt - ISO timestamp of the last thing this run did that proves it
 *   is working (a model request, a tool call). `null` when the lock predates the heartbeat or has
 *   never stamped one — which is read as "cannot tell", never as "stalled".
 * @property {number} beats - How many times it has been stamped, which is how a report says
 *   "this run did 412 model calls and then went quiet" instead of "a run is in progress".
 */

/**
 * How long a live holder may stay quiet before it counts as stalled.
 *
 * `RUN_STALL_MINUTES`, default 90. The number is deliberately larger than `AI_CALL_DEADLINE_MS`
 * (60 minutes of silence aborts one call): a stage whose single model call legitimately runs for
 * an hour must not be mistaken for a wedged one, because the consequence of that mistake is the
 * manager ending a run that was fine. Being conservative costs an hour of detection latency on a
 * genuinely stuck run; being eager costs a partly-translated volume.
 *
 * @returns {number} Minutes.
 */
function stallMinutes() {
  const raw = parseInt(process.env.RUN_STALL_MINUTES, 10);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return 90;
}

/**
 * Minutes since the last heartbeat, or `null` when the lock does not carry one.
 *
 * @param {RunLock} lock
 * @param {number} [nowMs]
 * @returns {number|null}
 */
function idleMinutesSince(lock, nowMs = Date.now()) {
  if (!lock || !lock.heartbeatAt) return null;
  const at = Date.parse(lock.heartbeatAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((nowMs - at) / 60000));
}

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
      // Absent on a lock written before the heartbeat existed. That is "cannot tell", not a
      // corruption and not a stall — the safe reading, because the consequence of calling a
      // healthy run stalled is ending it.
      heartbeatAt: typeof parsed.heartbeatAt === "string" ? parsed.heartbeatAt : null,
      beats: Number.isInteger(parsed.beats) ? parsed.beats : 0,
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
  const idle = idleMinutesSince(lock);
  const activity =
    idle === null
      ? "no heartbeat recorded"
      : `${lock.beats} beat(s), last ${idle} minute(s) ago`;
  return (
    `run ${lock.runId} started ${lock.startedAt} by ${lock.by} ` +
    `(pid ${lock.pid} on ${lock.host}; ${activity})`
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
 * The run id is half the answer. The other half is whether the process that wrote the file is still
 * there to hand it over.
 *
 * Why the id alone is not enough, and why it is the half that broke: act mode deliberately continues
 * under the newest recorded run id, so the ledger's memory of what that run already tried stays
 * legible to the next attempt (docs/delivery-layer.md). A lock left behind by a process that died
 * mid-run therefore carries OUR run id. Matching on the id alone made that lock "ours": the new
 * process joined a lock whose holder no longer exists, was not the process allowed to delete it, and
 * left it there — and so did every later run, because each one reuses the same id and joins the same
 * ghost. The after-run audit reported the same HIGH finding forever, and the sentence that tells a
 * human which file to delete was never reached, because the code had already decided the lock
 * belonged to it.
 *
 * Liveness is also what makes the nesting case correct rather than merely tolerated: `index.js`
 * holds the lock and spawns one gulp process per step, and each child joins it because the parent is
 * a LIVE process in the same run. When the parent is gone, a child is not holding anything — it is
 * standing in a dead process's shoes.
 *
 * A pid this machine cannot check is not a green light (decision 2 of this module), so it does not
 * make the lock ours either; the caller reads that as "still running".
 *
 * The limit worth naming out loud: a pid can be recycled. If a dead holder's pid is later reused by
 * an unrelated process AND the run id still matches, this reads the lock as live and refuses to
 * start. That is the safe direction — refusing is recoverable by deleting one file, a volume
 * half-written by two processes is not — and it is the same limit decision 2 already accepts for a
 * pid from another machine.
 *
 * @param {RunLock} lock
 * @param {string} run - Our run id.
 * @returns {boolean}
 */
function lockIsOurs(lock, run) {
  if (!lock || String(lock.runId) !== String(run)) return false;
  return pidIsAlive(lock.pid) === true;
}

/**
 * Is a run in progress, and is it actually doing anything?
 *
 * `stalled` is only ever true alongside `inProgress: true`: a stalled run is still a run, and a
 * second run must still not start on top of it. What the flag changes is what the reader can do
 * about it — a live holder that has made no model call or tool call for `RUN_STALL_MINUTES` is the
 * one case the manager is allowed to end.
 *
 * @param {{filePath?: string, run?: string, nowMs?: number}} [opts]
 * @returns {{inProgress: boolean, ours: boolean, stale: boolean, stalled: boolean,
 *   unverifiable: boolean, idleMinutes: number|null, beats: number,
 *   lock: RunLock|null, error: string|null, note: string|null}}
 */
function runInProgress(opts = {}) {
  const filePath = opts.filePath || runLockPath();
  const run = opts.run || runId();
  const { lock, error } = readRunLock(filePath);

  if (error) {
    // Cannot read it, so cannot rule out a run. The manager reads this as "no".
    return {
      inProgress: true, ours: false, stale: false, stalled: false, unverifiable: true,
      idleMinutes: null, beats: 0, lock: null, error, note: error,
    };
  }
  if (!lock) {
    return {
      inProgress: false, ours: false, stale: false, stalled: false, unverifiable: false,
      idleMinutes: null, beats: 0, lock: null, error: null, note: null,
    };
  }
  const idle = idleMinutesSince(lock, opts.nowMs);
  const beats = lock.beats;
  if (lockIsOurs(lock, run)) {
    // Same run AND a live holder: the nesting case (decision 3). `ours` can no longer mean "the id
    // matches", so a lock reaching this branch really was handed to us by something still running.
    return {
      inProgress: false, ours: true, stale: false, stalled: false, unverifiable: false,
      idleMinutes: idle, beats, lock, error: null, note: null,
    };
  }

  const alive = pidIsAlive(lock.pid);
  if (alive === false) {
    return {
      inProgress: false,
      ours: false,
      stale: true,
      stalled: false,
      unverifiable: false,
      idleMinutes: idle,
      beats,
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
      stalled: false,
      unverifiable: true,
      idleMinutes: idle,
      beats,
      lock,
      error: null,
      note:
        `${describeRunLock(lock)} — this machine cannot check that pid, so it is treated as running. ` +
        `If that run is not actually running, delete ${filePath}.`,
    };
  }

  // A live holder that has gone quiet. The heartbeat is the only thing that separates this from a
  // run working through a long chapter, so a lock with no heartbeat is never called stalled.
  const stalled = idle !== null && idle >= stallMinutes();
  if (stalled) {
    return {
      inProgress: true,
      ours: false,
      stale: false,
      stalled: true,
      unverifiable: false,
      idleMinutes: idle,
      beats,
      lock,
      error: null,
      note:
        `${describeRunLock(lock)} is alive but has made no model call or tool call for ${idle} minute(s) ` +
        `(the stall threshold is ${stallMinutes()}). It is still a run in progress, so nothing new starts ` +
        `on top of it; it is the one kind of run this layer can end — see \`delivery.js --stop-run\`.`,
    };
  }
  return {
    inProgress: true,
    ours: false,
    stale: false,
    stalled: false,
    unverifiable: false,
    idleMinutes: idle,
    beats,
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
    return { acquired: true, ours: false, reentrant: true, lock: state.lock, error: null, note: null };
  }

  const startedAt = new Date().toISOString();
  const lock = {
    runId: myRun,
    pid: process.pid,
    host: os.hostname(),
    by: by || "pipeline",
    startedAt,
    // Taking the lock is itself a beat: a run that has just started is not stalled, and a lock
    // whose heartbeat is its start time is how "it never got past the first request" becomes
    // visible instead of invisible.
    heartbeatAt: startedAt,
    beats: 1,
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

/**
 * The shortest gap between two writes of the heartbeat.
 *
 * An agent turn makes a tool call every few seconds, and a file write per call is pure overhead on
 * a run that makes thousands of them. Ten seconds is fine-grained enough to tell "working" from
 * "went quiet an hour ago" and cheap enough to ignore.
 */
const BEAT_WRITE_GAP_MS = 10000;

/** When this process last wrote the heartbeat, so the gap above can be honoured. */
let lastBeatAt = 0;

/**
 * Stamp the lock: this run just did something that proves it is working.
 *
 * Called from the model layer — every one-shot request and every agent tool call — because that is
 * the only place that knows whether the pipeline is actually talking to the model or sitting on a
 * dead connection. It is deliberately the cheapest possible operation and it never throws: a
 * heartbeat that can break a run is worse than no heartbeat.
 *
 * The throttle suppresses *within* a turn, not the turn itself: `force: true` is how the model layer
 * says "a call is starting", and a run that makes one short call every minute must get a beat per
 * call, not one beat per ten minutes. A run whose beats stop is the thing the stall reading is
 * looking for.
 *
 * Only a process that holds the lock (or joined it) may stamp it, and only the lock of its own run.
 * A stray process refreshing somebody else's claim would turn the stall reading into a lie.
 *
 * @param {{filePath?: string, force?: boolean}} [opts]
 * @returns {boolean} Whether the heartbeat was written.
 */
function beatRunLock(opts = {}) {
  if (!held) return false;
  const now = Date.now();
  if (!opts.force && now - lastBeatAt < BEAT_WRITE_GAP_MS) return false;
  const filePath = opts.filePath || runLockPath();

  try {
    const { lock } = readRunLock(filePath);
    if (!lock || String(lock.runId) !== String(held.lock.runId)) return false;
    const updated = { ...lock, heartbeatAt: new Date(now).toISOString(), beats: (lock.beats || 0) + 1 };
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", "utf8");
    held.lock = updated;
    lastBeatAt = now;
    return true;
  } catch {
    // A heartbeat that could not be written is a heartbeat that is missing, and a missing
    // heartbeat is read as "cannot tell", never as "stalled".
    return false;
  }
}

/**
 * Remove a lock whose holder has been confirmed gone.
 *
 * `releaseRunLock` is for the process that wrote the file. This is for the other case: the manager
 * has ended a stalled run (or found a stale lock) and needs the claim cleared by the only party
 * allowed to clear it. The pid check is the whole point — a lock whose pid has changed between the
 * read and the removal belongs to a run that started after the decision was made, and deleting that
 * one is exactly the two-processes-in-one-volume-folder failure this file exists to prevent.
 *
 * @param {{pid?: number, filePath?: string, reason?: string}} [opts] - `pid` is the holder this
 *   decision was made about. Defaults to the pid currently in the file.
 * @returns {{removed: boolean, lock: RunLock|null, note: string}}
 */
function clearRunLock(opts = {}) {
  const filePath = opts.filePath || runLockPath();
  let state;
  try {
    state = readRunLock(filePath);
  } catch (err) {
    return { removed: false, lock: null, note: `the run lock could not be read (${err.message})` };
  }
  if (state.error) return { removed: false, lock: null, note: state.error };
  if (!state.lock) return { removed: false, lock: null, note: "there is no run lock to clear" };

  const lock = state.lock;
  if (opts.pid !== undefined && Number(opts.pid) !== Number(lock.pid)) {
    return {
      removed: false,
      lock,
      note:
        `the lock now names pid ${lock.pid}, not the ${opts.pid} this decision was made about. ` +
        `Something else took it, so it is not being removed.`,
    };
  }
  if (pidIsAlive(lock.pid) === true) {
    return {
      removed: false,
      lock,
      note: `pid ${lock.pid} is still alive. The claim is not cleared until the process holding it is gone.`,
    };
  }
  try {
    fs.rmSync(filePath, { force: true });
    return {
      removed: true,
      lock,
      note: `the claim held by ${describeRunLock(lock)} is cleared${opts.reason ? `: ${opts.reason}` : ""}.`,
    };
  } catch (err) {
    return { removed: false, lock, note: `the run lock could not be removed (${err.message})` };
  }
}

module.exports = {
  runLockPath,
  readRunLock,
  pidIsAlive,
  describeRunLock,
  stallMinutes,
  idleMinutesSince,
  runInProgress,
  acquireRunLock,
  releaseRunLock,
  clearRunLock,
  beatRunLock,
};

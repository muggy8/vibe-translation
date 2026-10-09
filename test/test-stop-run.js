/**
 * test/test-stop-run.js — the one move that ends a run, and everything it refuses.
 *
 * `utils/runlock.js` decision 4 made "a run is working" and "a run is stuck" different facts. This
 * suite checks the fact is read correctly and, more importantly, that the move built on it refuses
 * in every direction that could destroy work. The dangerous failure is not "a stuck run was left
 * running" — that costs time. It is "a healthy run was ended", which costs the hour of translation
 * it had already bought.
 *
 * The scenarios run REAL processes: a holder is a live node process doing nothing, because the thing
 * under test is what a signal does to a pid and no stub can answer that. `delivery.js` is run as the
 * account owner would run it, against a temp `POSTMORTEM_DIR` — never the series `.env` points at
 * (gotcha 69).
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const harness = require("../harness");
const { startFakeBackend } = require("./fake-backend");
const { acquireRunLock, releaseRunLock, beatRunLock, runInProgress, stallMinutes, readRunLock } = require("../utils/runlock");

const ROOT = path.resolve(__dirname, "..");

/**
 * Is a pid still there?
 * @param {number} pid
 * @returns {boolean}
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * A live process that does nothing at all: the shape of a run wedged on a dead request.
 *
 * @param {string} dir
 * @returns {{child: import("child_process").ChildProcess, pid: number}}
 */
function spawnQuietHolder(dir) {
  const script = path.join(dir, "holder.js");
  fs.writeFileSync(
    script,
    `
      const fs = require("fs");
      fs.appendFileSync(process.env.HOLDER_LOG, "started\\n");
      setInterval(() => {}, 1000);
    `,
    "utf8"
  );
  const child = spawn(process.execPath, [script], {
    cwd: dir,
    env: { ...process.env, HOLDER_LOG: path.join(dir, "holder.log") },
  });
  return { child, pid: child.pid };
}

/**
 * Write a run lock by hand, so its heartbeat can be back-dated.
 *
 * @param {string} lockDir
 * @param {{pid: number, runId: string, heartbeatAt: string|null, beats: number}} spec
 * @returns {void}
 */
function writeLock(lockDir, spec) {
  fs.mkdirSync(lockDir, { recursive: true });
  const startedAt = new Date(Date.now() - 4 * 3600000).toISOString();
  const lock = {
    runId: spec.runId,
    pid: spec.pid,
    host: os.hostname(),
    by: "test holder",
    startedAt,
    ...(spec.heartbeatAt ? { heartbeatAt: spec.heartbeatAt, beats: spec.beats } : {}),
  };
  fs.writeFileSync(path.join(lockDir, "run.lock"), JSON.stringify(lock, null, 2) + "\n", "utf8");
}

/**
 * Run `delivery.js` the way the account owner would.
 *
 * @param {string[]} args
 * @param {Object} env
 * @returns {Promise<{code: number, out: string}>}
 */
function runDelivery(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "delivery.js"), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env, RUN_SHUTDOWN_GRACE_MS: "300" },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/**
 * Read the ledger the fixture wrote.
 * @param {string} lockDir
 * @returns {Object[]}
 */
function readFixtureLedger(lockDir) {
  const file = path.join(lockDir, "ledger.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).entries || [];
  } catch {
    return [];
  }
}

/**
 * A fresh fixture: a temp post-mortem folder and a live, quiet holder.
 *
 * @param {string} tag
 * @param {{heartbeatMinutesAgo: number|null, beats?: number}} spec
 * @returns {Promise<Object>}
 */
async function fixtureWithHolder(tag, spec) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `stop-run-${tag}-`));
  const lockDir = path.join(dir, ".postmortem");
  const holder = spawnQuietHolder(dir);
  // The holder's run id and the manager's are DIFFERENT, which is how it happens in a real run: a
  // standalone `delivery.js` gets a fresh id from `runId()`, and the wedged pipeline it is being
  // asked about carries the id it started under. Sharing the id would put this fixture in the
  // nesting case — a live holder in the same run — which `utils/runlock.js` decision 3 answers by
  // joining the lock, not by stopping it.
  const runId = `held-by-${tag}`;
  const heartbeatAt =
    spec.heartbeatMinutesAgo === null
      ? null
      : new Date(Date.now() - spec.heartbeatMinutesAgo * 60000).toISOString();
  writeLock(lockDir, { pid: holder.pid, runId, heartbeatAt, beats: spec.beats ?? 7 });
  return {
    dir,
    lockDir,
    holder,
    runId,
    env: { POSTMORTEM_DIR: lockDir, INDEX_RUN_ID: `manager-of-${tag}` },
    /** @returns {Promise<void>} */
    async cleanup() {
      try {
        holder.child.kill("SIGKILL");
      } catch {}
      await fs.promises.rm(dir, { recursive: true, force: true });
    },
  };
}

// ─── 1: a run that is working is never stopped ────────────────────────────────

async function testAWorkingRunIsNotStopped() {
  const f = await fixtureWithHolder("working", { heartbeatMinutesAgo: 2, beats: 412 });
  try {
    const res = await runDelivery(["--mode=act", "--stop-run"], f.env);

    assert.strictEqual(res.code, 2, `a run that is making progress is refused, not stopped:\n${res.out}`);
    assert.ok(/making progress/.test(res.out), res.out);
    assert.ok(/412 beat/.test(res.out), `the evidence is quoted, not asserted: ${res.out}`);
    assert.ok(alive(f.holder.pid), "the process is still running — nothing was signalled");
    assert.ok(fs.existsSync(path.join(f.lockDir, "run.lock")), "and its claim is untouched");
    assert.deepStrictEqual(
      readFixtureLedger(f.lockDir).filter((e) => e.action === "stop-stalled-run"),
      [],
      "a refusal is not an intervention — the audit records the command, not a move that happened"
    );
  } finally {
    await f.cleanup();
  }
  console.log("  stop-run: a run that is working is refused, out loud, with its own evidence");
}

// ─── 2: a stalled run is stopped, and only in act mode ────────────────────────

async function testAStalledRunIsStoppedInActMode() {
  const f = await fixtureWithHolder("stalled", { heartbeatMinutesAgo: 180, beats: 41 });
  try {
    const rehearsal = await runDelivery(["--mode=report", "--stop-run"], f.env);
    assert.strictEqual(rehearsal.code, 0, `report mode answers without acting:\n${rehearsal.out}`);
    assert.ok(/would be asked to stop/.test(rehearsal.out), rehearsal.out);
    assert.ok(alive(f.holder.pid), "report mode signalled nothing");
    assert.ok(fs.existsSync(path.join(f.lockDir, "run.lock")), "report mode cleared nothing");

    const act = await runDelivery(["--mode=act", "--stop-run"], f.env);
    assert.strictEqual(act.code, 0, `the stalled run was ended:\n${act.out}`);
    assert.ok(/was stopped and its claim cleared/.test(act.out), act.out);
    assert.ok(/180 minute/.test(act.out), `the stall is named with its number: ${act.out}`);

    for (let i = 0; i < 40 && alive(f.holder.pid); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.ok(!alive(f.holder.pid), "the process is gone");
    assert.ok(!fs.existsSync(path.join(f.lockDir, "run.lock")), "and the claim is gone with it, so the next run can start");

    const entries = readFixtureLedger(f.lockDir);
    const stop = entries.filter((e) => e.action === "stop-stalled-run");
    assert.strictEqual(stop.length, 1, `the move is on the audit trail: ${JSON.stringify(entries)}`);
    assert.strictEqual(stop[0].kind, "intervention");
    assert.strictEqual(stop[0].finding, "run-lock-stalled");
    assert.strictEqual(stop[0].outcome, "unchanged", "no corpus file moved, and the record says so");
  } finally {
    await f.cleanup();
  }
  console.log("  stop-run: report mode rehearses, act mode ends it and records it");
}

// ─── 3: a lock with no heartbeat is never called stalled ──────────────────────

async function testNoHeartbeatIsNotAStall() {
  const f = await fixtureWithHolder("noheartbeat", { heartbeatMinutesAgo: null });
  try {
    const res = await runDelivery(["--mode=act", "--stop-run"], f.env);
    assert.strictEqual(res.code, 2, `a lock that predates the heartbeat is not a stalled one:\n${res.out}`);
    assert.ok(/no heartbeat yet/.test(res.out), res.out);
    assert.ok(alive(f.holder.pid), "nothing was signalled to a process this layer cannot date");
  } finally {
    await f.cleanup();
  }
  console.log("  stop-run: 'no heartbeat recorded' is read as cannot-tell, never as stalled");
}

// ─── 4: a stale lock has no process to stop ───────────────────────────────────

async function testALockWhoseHolderIsGoneHasNothingToStop() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stop-run-stale-"));
  const lockDir = path.join(dir, ".postmortem");
  try {
    // A pid that is certainly not a run: a child that has already exited.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { cwd: dir });
    await new Promise((r) => dead.on("close", r));
    assert.ok(!alive(dead.pid), "the fixture's pid is really gone");

    writeLock(lockDir, {
      pid: dead.pid,
      runId: "stop-run-test-stale",
      heartbeatAt: new Date(Date.now() - 180 * 60000).toISOString(),
      beats: 3,
    });

    const res = await runDelivery(["--mode=act", "--stop-run"], {
      POSTMORTEM_DIR: lockDir,
      INDEX_RUN_ID: "stop-run-test-stale",
    });
    assert.strictEqual(res.code, 0, `a dead holder is not a stalled one:\n${res.out}`);
    assert.ok(/already gone/.test(res.out), res.out);
    assert.ok(!/was stopped and its claim cleared/.test(res.out), res.out);
    assert.deepStrictEqual(
      readFixtureLedger(lockDir).filter((e) => e.action === "stop-stalled-run"),
      [],
      "nothing was done to a process, so no intervention was recorded"
    );
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  console.log("  stop-run: a lock whose process is gone is 'nothing to stop', not a kill order");
}

// ─── 5: the heartbeat itself ───────────────────────────────────────────────────

async function testOnlyTheHolderCanStampTheLock() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stop-run-beat-"));
  const lockDir = path.join(dir, ".postmortem");
  const previous = process.env.POSTMORTEM_DIR;
  process.env.POSTMORTEM_DIR = lockDir;
  try {
    assert.strictEqual(beatRunLock(), false, "a process that holds nothing cannot stamp it");

    const taken = acquireRunLock({ by: "test beat" });
    assert.ok(taken.acquired && taken.ours, JSON.stringify(taken));
    const fresh = readRunLock().lock;
    assert.ok(fresh.heartbeatAt, "taking the lock is itself a beat: a run that just started is not stalled");
    assert.strictEqual(fresh.beats, 1);

    const state = runInProgress();
    assert.strictEqual(state.stalled, false, "and it is read that way");
    assert.strictEqual(state.idleMinutes, 0, JSON.stringify(state));

    await new Promise((r) => setTimeout(r, 1100));
    assert.strictEqual(beatRunLock(), true, "the holder can stamp it");
    assert.strictEqual(readRunLock().lock.beats, 2);

    releaseRunLock();
    assert.strictEqual(beatRunLock(), false, "and stops being able to once it has handed the claim back");
  } finally {
    if (previous === undefined) delete process.env.POSTMORTEM_DIR;
    else process.env.POSTMORTEM_DIR = previous;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  console.log("  heartbeat: only the holder stamps it, and the stamp is what 'working' means");
}

// ─── 6: the threshold is longer than the model layer's own patience ────────────

/**
 * Why the stall threshold must sit above the idle deadline.
 *
 * A single model call is allowed to stream for `AI_CALL_DEADLINE_MS` worth of silence before the
 * harness aborts it — 60 minutes by default. If the stall threshold were shorter, a legitimately
 * slow call would be reported as a stuck run, and the move built on that reading ends the run. The
 * ordering is the safety of the whole feature, so it is pinned rather than explained in a comment.
 */
function testTheStallThresholdOutranksTheIdleDeadline() {
  const idleDeadlineMs = (() => {
    const raw = process.env.AI_CALL_DEADLINE_MS;
    if (raw === undefined || raw === "") return 3600000;
    const n = parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : 0;
  })();
  assert.ok(
    stallMinutes() * 60000 > idleDeadlineMs,
    `RUN_STALL_MINUTES (${stallMinutes()}) must exceed the model layer's own idle deadline (${idleDeadlineMs}ms), ` +
      `or a slow-but-healthy call becomes a kill order`
  );
  console.log(`  stall threshold: ${stallMinutes()} min, longer than the ${idleDeadlineMs / 60000} min idle deadline`);
}

// ─── 7: it is one act at a time, like every other verb ────────────────────────

async function testItIsNotCombinableWithAnotherVerb() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stop-run-verb-"));
  const lockDir = path.join(dir, ".postmortem");
  try {
    const res = await runDelivery(["--mode=act", "--stop-run", "--open-ticket"], {
      POSTMORTEM_DIR: lockDir,
      SERIES_LOCATION: dir,
    });
    assert.strictEqual(res.code, 2, `two acts in one command are refused:\n${res.out}`);
    assert.ok(/one act at a time/.test(res.out), res.out);
    assert.ok(/--stop-run/.test(res.out), "and the new flag is named in the list of known flags");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  console.log("  stop-run: one act at a time, and the flag is on the known list");
}

// ─── 8: a real model call is what stamps the lock ─────────────────────────────

/**
 * The load-bearing link in the whole feature.
 *
 * The stall reading, the menu move, the CLI verb and the audit finding all hang off one fact: the
 * model layer stamps the claim while the endpoint is answering. If that stamp is moved or dropped,
 * every lock reads as "no heartbeat recorded", which is deliberately never stalled — so the stop
 * move becomes unreachable and the delivery layer is back to needing a human, with nothing failing to
 * say so. This is the check that makes it fail loudly instead.
 */
async function testARealModelCallIsWhatStampsTheLock() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stop-run-rebeat-"));
  const lockDir = path.join(dir, ".postmortem");
  const previous = process.env.POSTMORTEM_DIR;
  process.env.POSTMORTEM_DIR = lockDir;
  const backend = await startFakeBackend({ model: "stub", reply: () => ({ text: "the scripted answer" }) });
  try {
    const taken = acquireRunLock({ by: "test heartbeat" });
    assert.ok(taken.acquired && taken.ours, JSON.stringify(taken));
    assert.strictEqual(readRunLock().lock.beats, 1, "the lock begins with one beat: the moment it was taken");

    const text = await harness.runOneShot({
      systemPrompt: "You translate.",
      messages: [{ text: "translate this" }],
      endpoint: { baseUrl: backend.baseUrl, apiKey: "k", model: "stub" },
      label: "heartbeat-check",
    });
    assert.strictEqual(text, "the scripted answer", "the call really ran");

    const beats = readRunLock().lock.beats;
    assert.ok(
      beats > 1,
      `a real streamed call stamped the claim (beats: ${beats}). If it does not, nothing can ever be ` +
        `called stalled, the stop-run move is unreachable, and the delivery layer needs a human again.`
    );
  } finally {
    releaseRunLock();
    await backend.close().catch(() => {});
    if (previous === undefined) delete process.env.POSTMORTEM_DIR;
    else process.env.POSTMORTEM_DIR = previous;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  console.log("  heartbeat: a real model call is what stamps the claim — the whole feature hangs on it");
}

async function main() {
  await testAWorkingRunIsNotStopped();
  await testAStalledRunIsStoppedInActMode();
  await testNoHeartbeatIsNotAStall();
  await testALockWhoseHolderIsGoneHasNothingToStop();
  await testOnlyTheHolderCanStampTheLock();
  testTheStallThresholdOutranksTheIdleDeadline();
  await testItIsNotCombinableWithAnotherVerb();
  await testARealModelCallIsWhatStampsTheLock();
}

main().catch((err) => {
  console.error("stop-run test failed:", err.message);
  process.exitCode = 1;
});

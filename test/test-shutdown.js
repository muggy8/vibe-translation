/**
 * test/test-shutdown.js — stopping a run stops the work it started.
 *
 * Every runner in this layer does its work in a child process, and Node ends the process that
 * received a signal while leaving its children running. Measured before this suite existed: a
 * signal aimed at a parent (a container stop, `kill <pid>`, an OOM kill of the parent) left the
 * child working alone — still writing files, still holding the run lock under a LIVE pid, which
 * makes every later run refuse until a human deletes a file.
 *
 * These scenarios run REAL processes and real signals, because the thing under test is what a
 * signal does to a process tree and no in-process stub can answer that. `utils/shutdown.js` is
 * the real module; the workers are throwaway scripts in a temp folder.
 *
 * The scenarios:
 *   1. a stopped runner stops its worker, and its stop handler runs — which is where the run lock
 *      is handed back;
 *   2. a worker that will not stop is forced after the grace period, and the runner says so;
 *   3. a stopped runner does not start the NEXT step — the reason `isStopping()` exists;
 *   4. the wiring is still in place at every spawn site, so the guarantee cannot be quietly
 *      dropped by a later edit.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const shutdown = require("../utils/shutdown");

const ROOT = path.resolve(__dirname, "..");
const MODULE_PATH = path.join(ROOT, "utils", "shutdown.js");

/**
 * Wait for a marker to appear in a log file, or fail loudly.
 *
 * @param {string} file
 * @param {string} marker
 * @param {number} timeoutMs
 * @returns {Promise<string>} The file contents at the moment the marker appeared.
 */
function waitForMarker(file, marker, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {}
      if (text.includes(marker)) return resolve(text);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for "${marker}" in ${path.basename(file)}:\n${text}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * Write the throwaway worker scripts.
 *
 * @param {string} dir
 * @returns {Promise<Object>} name -> absolute path.
 */
async function writeWorkers(dir) {
  const polite = `
    const fs = require("fs");
    const log = process.env.WORKER_LOG;
    fs.appendFileSync(log, "started\\n");
    process.on("SIGTERM", () => {
      fs.appendFileSync(log, "got SIGTERM\\n");
      process.exit(0);
    });
    setInterval(() => fs.appendFileSync(log, "alive\\n"), 100);
  `;
  // Ignores SIGTERM on purpose: this is the wedged child, and the runner must still end.
  const stubborn = `
    const fs = require("fs");
    const log = process.env.WORKER_LOG;
    fs.appendFileSync(log, "started\\n");
    process.on("SIGTERM", () => fs.appendFileSync(log, "ignored SIGTERM\\n"));
    setInterval(() => fs.appendFileSync(log, "alive\\n"), 100);
  `;
  const runner = `
    const path = require("path");
    const { spawn } = require("child_process");
    const fs = require("fs");
    const shutdown = require(process.env.SHUTDOWN_MODULE);

    const log = process.env.RUNNER_LOG;
    const write = (line) => fs.appendFileSync(log, line + "\\n");

    shutdown.installShutdownWatch({
      label: "test runner",
      onStop: () => write("stop handler ran"),
    });

    function startStep(name) {
      const worker = path.join(process.env.FIXTURE_DIR, name + ".js");
      write("starting " + name);
      const child = spawn(process.execPath, [worker], {
        cwd: process.env.FIXTURE_DIR,
        env: { ...process.env, WORKER_LOG: path.join(process.env.FIXTURE_DIR, name + ".log") },
      });
      shutdown.trackChild(child, name);
      return new Promise((resolve) => child.on("close", (code) => resolve(code)));
    }

    (async () => {
      await startStep(process.env.STEP_1 || "polite");
      // The rule the step loops have to honour: a stopped child is not a failed step, and a runner
      // that treats it as one starts the next step while the account owner is trying to stop it.
      if (shutdown.isStopping()) {
        write("skipped the next step (" + shutdown.stoppingSignal() + ")");
        return;
      }
      await startStep(process.env.STEP_2 || "polite");
    })();
  `;

  const files = {};
  for (const [name, body] of Object.entries({ polite, stubborn, runner })) {
    const file = path.join(dir, `${name}.js`);
    await fs.promises.writeFile(file, body, "utf8");
    files[name] = file;
  }
  return files;
}

/**
 * Run the fixture runner and send it one signal.
 *
 * @param {Object} opts
 * @param {string} opts.dir
 * @param {string} opts.signal - SIGINT or SIGTERM.
 * @param {Object} [opts.extraEnv]
 * @returns {Promise<{code: number|null, runnerLog: string, workerLog: string}>}
 */
async function runAndSignal({ dir, signal, extraEnv = {} }) {
  const runnerLog = path.join(dir, "runner.log");
  fs.rmSync(runnerLog, { force: true });
  for (const name of ["polite", "stubborn"]) fs.rmSync(path.join(dir, `${name}.log`), { force: true });

  const child = spawn(process.execPath, [path.join(dir, "runner.js")], {
    cwd: dir,
    env: { ...process.env, ...extraEnv, FIXTURE_DIR: dir, RUNNER_LOG: runnerLog, SHUTDOWN_MODULE: MODULE_PATH },
  });
  // The shutdown watch reports on both streams: what it is about to stop is a status line, what it
  // had to force is a problem. The assertions read the two together.
  let output = "";
  const capture = (chunk) => {
    output += chunk.toString();
  };
  child.stderr.on("data", capture);
  child.stdout.on("data", capture);

  const workerName = (extraEnv.STEP_1 || "polite").replace(/\.js$/, "");
  await waitForMarker(path.join(dir, `${workerName}.log`), "started");
  // Give the worker a moment to be genuinely mid-work before it is interrupted.
  await new Promise((r) => setTimeout(r, 250));
  child.kill(signal);

  const code = await new Promise((resolve) => child.on("close", resolve));
  const read = (f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  return {
    code,
    output,
    runnerLog: read(runnerLog),
    workerLog: read(path.join(dir, `${workerName}.log`)),
  };
}

// ─── 1: a stopped runner stops its worker and hands the lock back ──────────────

async function testStoppingTheRunnerStopsTheStep() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "shutdown-polite-"));
  try {
    await writeWorkers(dir);
    const res = await runAndSignal({ dir, signal: "SIGTERM" });

    assert.ok(res.workerLog.includes("got SIGTERM"), `the step was stopped, not orphaned:\n${res.workerLog}`);
    assert.ok(res.runnerLog.includes("stop handler ran"), `the stop handler ran — this is where the run lock is released:\n${res.runnerLog}`);
    assert.strictEqual(res.code, 143, "143 is 128+SIGTERM, so a wrapper reads the number the usual way");
    assert.ok(/stopping 1 process/.test(res.output), `it says what it stopped: ${res.output}`);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  console.log("  stop signal: the step stops with the runner, and the stop handler runs");
}

// ─── 2: a worker that will not stop is forced ─────────────────────────────────

async function testAWedgedStepIsForced() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "shutdown-stubborn-"));
  try {
    await writeWorkers(dir);
    const res = await runAndSignal({
      dir,
      signal: "SIGTERM",
      extraEnv: { STEP_1: "stubborn", STEP_2: "stubborn", RUN_SHUTDOWN_GRACE_MS: "400" },
    });

    assert.ok(res.workerLog.includes("ignored SIGTERM"), `the fixture really did ignore it:\n${res.workerLog}`);
    assert.ok(/did not stop within 400ms — forcing it/.test(res.output), `and it was forced, out loud: ${res.output}`);
    assert.ok(/had to be forced to stop/.test(res.output), res.output);
    const saved = process.env.RUN_SHUTDOWN_GRACE_MS;
    delete process.env.RUN_SHUTDOWN_GRACE_MS;
    assert.strictEqual(shutdown.shutdownGraceMs(), 20000, "the default grace is 20s: long enough to finish a file, short enough that a wedged child cannot hold the lock forever");
    process.env.RUN_SHUTDOWN_GRACE_MS = "400";
    assert.strictEqual(shutdown.shutdownGraceMs(), 400, "and it is a setting, not a guess");
    if (saved === undefined) delete process.env.RUN_SHUTDOWN_GRACE_MS;
    else process.env.RUN_SHUTDOWN_GRACE_MS = saved;
    assert.strictEqual(res.code, 143, "a runner that cannot stop its child still ends");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  console.log("  wedged step: forced after the grace period, and the runner says which one");
}

// ─── 3: a stopped runner does not start the next step ─────────────────────────

async function testStoppedRunnerDoesNotStartTheNextStep() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "shutdown-nextstep-"));
  try {
    await writeWorkers(dir);
    const res = await runAndSignal({ dir, signal: "SIGINT" });

    assert.ok(res.runnerLog.includes("skipped the next step (SIGINT)"), `isStopping() is what keeps the walk from continuing:\n${res.runnerLog}`);
    assert.ok(!res.runnerLog.includes("starting polite\nstarting polite"), `the second step was never started:\n${res.runnerLog}`);
    assert.strictEqual(res.code, 130, "130 is 128+SIGINT");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  console.log("  interrupted walk: the next step is not started, and the signal is named");
}

// ─── 4: the wiring is still at every spawn site ────────────────────────────────

/**
 * Every process this layer starts is registered with the shutdown watch.
 *
 * A guarantee that lives in four call sites is four chances to drop one by accident, and dropping
 * one re-creates exactly the orphan this module exists to prevent. The spawn sites are read from
 * source because the alternative — running a real gulp step to prove it is wired — costs a model
 * container and a volume folder.
 */
function testEverySpawnSiteRegistersItsChild() {
  const sites = [
    ["index/run-step.js", "gulp step"],
    ["delivery/act.js", "the manager's step"],
    ["autopilot/commands.js", "the loop's move"],
  ];
  for (const [file, why] of sites) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.ok(/trackChild\(/.test(text), `${file} must register ${why} with the shutdown watch (utils/shutdown.js)`);
  }

  const watchers = ["index/main.js", "delivery/act.js", "autopilot/cli.js", "gulpfile.js"];
  for (const file of watchers) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.ok(/installShutdownWatch\(/.test(text), `${file} must watch for a stop signal (utils/shutdown.js)`);
  }

  console.log("  wiring: every spawn site registers its child, every runner watches for a stop");
}

async function main() {
  await testStoppingTheRunnerStopsTheStep();
  await testAWedgedStepIsForced();
  await testStoppedRunnerDoesNotStartTheNextStep();
  testEverySpawnSiteRegistersItsChild();
}

main().catch((err) => {
  console.error("shutdown test failed:", err.message);
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * test/test-suite-runner.js — the gate that gates the gate.
 *
 * `test/runner.js` decides whether `npm test` is green. Until now nothing pinned that decision, which is
 * the same hole gotcha 169 describes one level up: a checker that never runs looks exactly like a checker
 * that passes. Every failure shape the runner is supposed to catch is planted here, and the runner's own
 * exit code and its own report are asserted in each one:
 *
 *   1. a suite that exits non-zero,
 *   2. a suite that prints nothing and exits 0,
 *   3. a suite that runs past its per-suite limit,
 *   4. a manifest that names a file that does not exist,
 *   5. a `test/test-*.js` on disk the manifest does not cover (gotcha 169 itself),
 *   6. a manifest entry that never ran, because a suite deleted it mid-run,
 *   7. a green run, which has to report the exact count it ran,
 *   8. `--only`, which must say out loud that it is not the gate,
 *   9. `--serial`, which must genuinely run one at a time,
 *  10. `package.json` pointing `npm test` somewhere other than the runner,
 *  11. a scratch folder that would land inside the corpus,
 *  12. the manifest's own rules: a serial entry with no reason, a duplicate id, a helper with no reason,
 *  13. the helper allow-list doing its job for a file that matches the pattern and is not a suite,
 *  14. the REAL manifest: every `test/test-*.js` in this repository is covered, and the constants are the
 *      ones the code says they are, with no environment variable reaching them.
 *
 * Every fixture is built under /tmp/opencode and every planted suite is a script this file writes. No
 * scenario can reach the corpus: the runner is pointed at a fixture root with `--root=`, and the one
 * scenario that names the corpus is a scenario that proves the runner REFUSES it. 0 model calls, 0
 * network, no reads of the real 17 volumes (AGENTS.md rule 8, gotcha 69).
 *
 * @module test/test-suite-runner
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const runner = require("./runner");
const realManifest = require("./suites");

const ROOT = path.resolve(__dirname, "..");
const RUNNER_FILE = path.join(__dirname, "runner.js");
const FIXTURES = "/tmp/opencode/suite-runner-tests";

/** @type {number} */
let checks = 0;
/** @type {string[]} */
const failures = [];

/**
 * One assertion.
 *
 * @param {boolean} condition
 * @param {string} message
 * @returns {void}
 */
function ok(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}

/**
 * One equality assertion.
 *
 * @param {any} actual
 * @param {any} expected
 * @param {string} message
 * @returns {void}
 */
function same(actual, expected, message) {
  checks++;
  try {
    assert.deepStrictEqual(actual, expected);
  } catch {
    failures.push(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

/**
 * A scenario folder, wiped on entry.
 *
 * @param {string} label
 * @returns {string} The fixture repository root.
 */
function fixtureRoot(label) {
  const dir = path.join(FIXTURES, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  return dir;
}

/**
 * Write a planted suite.
 *
 * @param {string} dir - The fixture root.
 * @param {string} name - File name, e.g. `test-passes.js`.
 * @param {string} source - The whole file.
 * @returns {string} Absolute path to the planted file.
 */
function plant(dir, name, source) {
  const file = path.join(dir, "test", name);
  fs.writeFileSync(file, source, "utf8");
  return file;
}

/**
 * Write the fixture's manifest.
 *
 * @param {string} dir
 * @param {Array<{id: string, file: string, args?: string[], phase?: string, reason?: string}>} entries
 * @param {Object<string,string>} [helpers]
 * @returns {void}
 */
function writeManifest(dir, entries, helpers = {}) {
  const body =
    "module.exports = {\n" +
    `  SUITES: ${JSON.stringify(entries.map((e) => ({ id: e.id, file: e.file, args: e.args || [], phase: e.phase || "concurrent", reason: e.reason || null })), null, 2)},\n` +
    `  SUITE_HELPERS: ${JSON.stringify(helpers, null, 2)},\n` +
    '  renderTestChain: (list) => (list || module.exports.SUITES).map((e) => ["node", e.file, ...e.args].join(" ")).join(" && "),\n' +
    "};\n";
  fs.writeFileSync(path.join(dir, "test", "suites.js"), body, "utf8");
}

/**
 * Write the fixture's package.json.
 *
 * @param {string} dir
 * @param {string} testScript
 * @returns {void}
 */
function writePackage(dir, testScript) {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "runner-fixture", version: "1.0.0", private: true, scripts: { test: testScript } }, null, 2) + "\n",
    "utf8"
  );
}

/**
 * Run the real runner against a fixture repository.
 *
 * @param {string} dir - The fixture root.
 * @param {string[]} [extraArgs]
 * @param {Record<string,string>} [env]
 * @returns {{code: number|null, out: string}} The exit code and the merged report.
 */
function runRunner(dir, extraArgs = [], env = {}) {
  const res = spawnSync(
    process.execPath,
    [
      RUNNER_FILE,
      `--root=${dir}`,
      `--output-dir=${path.join(dir, "out")}`,
      `--fixture-root=${path.join(dir, "fixtures")}`,
      ...extraArgs,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 120000, env: { ...process.env, ...env } }
  );
  if (res.error) throw res.error;
  return { code: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

/**
 * Run the runner through its exported door with the test-only seam set.
 *
 * `suiteTimeoutMs` and `maxParallel` are parameters of `runManifest`, and the CLI path always passes the
 * shipped constants: no flag and no `process.env` name reaches them (scenario 15 pins that). This is the
 * same shape as `setLookupClockForTests` in the lookup layer — a seam the roles under test cannot walk
 * through, used only by the suite that has to prove the guard fires.
 *
 * @param {string} dir - The fixture root.
 * @param {number} suiteTimeoutMs
 * @returns {{code: number|null, out: string}}
 */
function runRunnerWithTimeout(dir, suiteTimeoutMs) {
  const script =
    `const r = require(${JSON.stringify(RUNNER_FILE)});\n` +
    `const opts = r.parseArgs([${JSON.stringify(`--root=${dir}`)}, ${JSON.stringify(`--output-dir=${path.join(dir, "out")}`)}, ${JSON.stringify(`--fixture-root=${path.join(dir, "fixtures")}`)}]);\n` +
    `opts.suiteTimeoutMs = ${suiteTimeoutMs};\n` +
    "r.runManifest(opts).then((code) => { process.exitCode = code; });\n";
  const res = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  if (res.error) throw res.error;
  return { code: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

/**
 * Read the lines the planted suites wrote into a shared bookkeeping file.
 *
 * @param {string} file
 * @returns {string[]}
 */
function logLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Scenario 1 — a suite that exits non-zero ─────────────────────────────────

/**
 * @returns {void}
 */
function scenarioFailingSuite() {
  const dir = fixtureRoot("failing-suite");
  writePackage(dir, "node test/runner.js");
  plant(dir, "test-good.js", 'console.log("good suite ran");\n');
  plant(dir, "test-bad.js", 'console.log("the suite got this far");\nconsole.error("PLANTED FAILURE: the check did not hold");\nprocess.exit(3);\n');
  writeManifest(dir, [
    { id: "test-good", file: "test/test-good.js" },
    { id: "test-bad", file: "test/test-bad.js" },
  ]);

  const run = runRunner(dir);
  same(run.code, 1, "a suite that exits 3 must make the gate fail");
  ok(/FAIL\s+\d+ms\s+test\/test-bad\.js/.test(run.out), `the report names the failing suite:\n${run.out}`);
  ok(run.out.includes("PLANTED FAILURE: the check did not hold"), "the runner prints the failing suite's own stderr");
  ok(run.out.includes("the suite got this far"), "the runner prints the failing suite's own stdout too");
  ok(/FAIL\s+\d+ms\s+test\/test-bad\.js\s+→ the suite got this far/.test(run.out), "and the failing suite's status line carries its own last line");
  ok(run.out.includes("1 passed, 1 failed"), `the totals add up: ${run.out}`);
  ok(!/^GREEN: /m.test(run.out), "a red run never says GREEN");
  ok(fs.existsSync(path.join(dir, "out", "test-bad.stdout.log")), "the failing suite's stdout was captured to a file");
  ok(fs.readFileSync(path.join(dir, "out", "test-bad.stderr.log"), "utf8").includes("PLANTED FAILURE"), "the captured stderr file holds it");
  console.log("scenario 1: a suite that exits non-zero fails the gate, and its captured output is printed");
}

// ─── Scenario 2 — a suite that prints nothing and exits 0 ─────────────────────

/**
 * @returns {void}
 */
function scenarioSilentSuite() {
  const dir = fixtureRoot("silent-suite");
  writePackage(dir, "node test/runner.js");
  plant(dir, "test-silent.js", "process.exit(0);\n");
  writeManifest(dir, [{ id: "test-silent", file: "test/test-silent.js" }]);

  const run = runRunner(dir);
  same(run.code, 1, "a suite that exits 0 and prints nothing is a failure, not a pass");
  ok(run.out.includes("printed nothing"), `the reason says why: ${run.out}`);
  ok(run.out.includes("0 passed, 1 failed"), `the totals count it as failed: ${run.out}`);
  console.log("scenario 2: a suite that prints nothing is refused — it is as invisible as a suite that never ran");
}

// ─── Scenario 3 — a suite that runs past its limit ────────────────────────────

/**
 * @returns {void}
 */
function scenarioHangingSuite() {
  const dir = fixtureRoot("hanging-suite");
  writePackage(dir, "node test/runner.js");
  plant(dir, "test-hangs.js", 'console.log("started");\nsetTimeout(() => console.log("should never print"), 30000);\n');
  writeManifest(dir, [{ id: "test-hangs", file: "test/test-hangs.js" }]);

  const started = Date.now();
  const run = runRunnerWithTimeout(dir, 1500);
  const elapsed = Date.now() - started;
  same(run.code, 1, "a suite that outlives its limit fails the gate");
  ok(run.out.includes("TIME"), `the report tags it as a timeout: ${run.out}`);
  ok(run.out.includes("per-suite limit and was killed"), `the reason names the limit: ${run.out}`);
  ok(!run.out.includes("should never print"), "the killed suite was really killed, not left running");
  ok(elapsed < 30000, `the runner stopped instead of waiting for the planted 30 s timer (${elapsed} ms)`);
  console.log(`scenario 3: a suite past its limit is killed and named (${elapsed} ms against a 1500 ms limit)`);
}

// ─── Scenario 4 — a manifest naming a file that does not exist ────────────────

/**
 * @returns {void}
 */
function scenarioManifestNamesNothing() {
  const dir = fixtureRoot("manifest-names-nothing");
  writePackage(dir, "node test/runner.js");
  plant(dir, "test-real.js", 'console.log("real");\n');
  writeManifest(dir, [
    { id: "test-real", file: "test/test-real.js" },
    { id: "test-ghost", file: "test/test-ghost.js" },
  ]);

  const run = runRunner(dir);
  same(run.code, 1, "a manifest entry with no file behind it fails the gate");
  ok(run.out.includes("test/test-ghost.js"), `the problem names the file: ${run.out}`);
  ok(run.out.includes("nothing ran"), `nothing was paid for: ${run.out}`);
  ok(!run.out.includes("ok  "), "no suite ran, so no suite is reported ok");
  console.log("scenario 4: a manifest entry naming a missing file stops the run before any suite is started");
}

// ─── Scenario 5 — a test-*.js on disk the manifest does not cover ─────────────

/**
 * @returns {void}
 */
function scenarioOrphanSuiteFile() {
  const dir = fixtureRoot("orphan-suite-file");
  writePackage(dir, "node test/runner.js");
  plant(dir, "test-covered.js", 'console.log("covered");\n');
  plant(dir, "test-orphan.js", 'console.log("nobody runs me");\n');
  writeManifest(dir, [{ id: "test-covered", file: "test/test-covered.js" }]);

  const run = runRunner(dir);
  same(run.code, 1, "a test/test-*.js file nothing runs fails the gate (gotcha 169)");
  ok(run.out.includes("test/test-orphan.js"), `the failure names the file: ${run.out}`);
  ok(run.out.includes("gotcha 169"), "the message points at the gotcha it exists for");
  console.log("scenario 5: an uninvoked suite is a hard failure, not a file that sits there");
}

// ─── Scenario 6 — an entry that never ran ─────────────────────────────────────

/**
 * @returns {void}
 */
function scenarioEntrySkipped() {
  // (a) A suite trashes the shared scratch folder so the next entry cannot even be started.
  const dir = fixtureRoot("entry-skipped");
  writePackage(dir, "node test/runner.js");
  plant(
    dir,
    "test-trashes.js",
    'const path = require("path");\n' +
      'const fs = require("fs");\n' +
      'const blocked = path.join(path.dirname(process.env.AI_CLIENT_TEST_FIXTURES_ROOT), "test-blocked");\n' +
      'fs.mkdirSync(path.dirname(blocked), { recursive: true });\n' +
      'fs.writeFileSync(blocked, "not a folder");\n' +
      'console.log("replaced the next suite fixture root with a file");\n'
  );
  plant(dir, "test-blocked.js", 'console.log("should never run");\n');
  writeManifest(dir, [
    { id: "test-trashes", file: "test/test-trashes.js", phase: "serial", reason: "Replaces the next entry's fixture root with a file, so the order has to be fixed." },
    { id: "test-blocked", file: "test/test-blocked.js", phase: "serial", reason: "Its fixture root is made unusable by the entry before it, so it must be attempted in order." },
  ]);

  const run = runRunner(dir);
  same(run.code, 1, "an entry that could not be started fails the gate");
  ok(run.out.includes("test/test-blocked.js"), `the report names the entry that never ran: ${run.out}`);
  ok(run.out.includes("could not be spawned"), `it says why: ${run.out}`);
  ok(run.out.includes("1 ran of 2 in the manifest"), `the count line still reports the manifest's own number: ${run.out}`);
  ok(run.out.includes("1 passed, 1 failed"), `the skipped entry is counted as failed, not as absent: ${run.out}`);
  ok(run.out.includes("1 could not be started at all"), `and named as a suite that never started: ${run.out}`);
  ok(run.out.includes("never started: test/test-blocked.js"), "the report prints the entry that never started");
  ok(/^NOT GREEN: /m.test(run.out), "a run with a gap in it is not green");

  // (b) A suite deletes the file the next entry names. The child starts and Node itself cannot find the
  // file, which is a failure the runner has to name rather than a suite that quietly disappears.
  const dir2 = fixtureRoot("entry-erased");
  writePackage(dir2, "node test/runner.js");
  const victim = path.join(dir2, "test", "test-victim.js");
  plant(dir2, "test-erases.js", `require("fs").rmSync(${JSON.stringify(victim)}, { force: true });\nconsole.log("erased the next suite's file");\n`);
  plant(dir2, "test-victim.js", 'console.log("should never run");\n');
  writeManifest(dir2, [
    { id: "test-erases", file: "test/test-erases.js", phase: "serial", reason: "Deletes the file the next entry names, so the order has to be fixed." },
    { id: "test-victim", file: "test/test-victim.js", phase: "serial", reason: "Its file is deleted by the entry before it, so it must be attempted in order." },
  ]);

  const run2 = runRunner(dir2);
  same(run2.code, 1, "a suite whose file vanished mid-run fails the gate");
  ok(run2.out.includes("test/test-victim.js"), `and names it: ${run2.out}`);
  ok(run2.out.includes("1 passed, 1 failed"), `the vanished suite is a failure, not a gap: ${run2.out}`);
  ok(/^NOT GREEN: /m.test(run2.out), "and the run is not green");
  console.log("scenario 6: an entry that never ran, or could not run, is a named failure and the count line says so");
}

// ─── Scenario 7 — a green run reports the exact count ─────────────────────────

/**
 * @returns {void}
 */
function scenarioGreenRunCounts() {
  const dir = fixtureRoot("green-run");
  writePackage(dir, "node test/runner.js");
  for (let i = 1; i <= 5; i++) plant(dir, `test-pass${i}.js`, `console.log("pass ${i}");\n`);
  writeManifest(dir, Array.from({ length: 5 }, (_, i) => ({ id: `test-pass${i + 1}`, file: `test/test-pass${i + 1}.js` })));

  const run = runRunner(dir);
  same(run.code, 0, "a run where every suite passes is green");
  ok(run.out.includes("5 ran of 5 in the manifest"), `the runner prints the count it ran: ${run.out}`);
  ok(run.out.includes("GREEN: 5 suites ran, which is every entry in the manifest"), "the green line names the count and the manifest");
  ok(run.out.includes("=== suite timings (slowest first) ==="), "the timing table is printed");
  const timed = run.out.split("\n").filter((l) => /^\s+\d+ms\s+ok/.test(l));
  same(timed.length, 5, "every suite appears in the timing table");
  // Each status line carries the suite's own last line, which is what makes the transcript name what a
  // suite said it did rather than only that it exited 0 (gotcha 169).
  const withSummary = run.out.split("\n").filter((l) => /^ok\s+\d+ms\s+test\/test-pass\d+\.js\s+→ pass \d+$/.test(l));
  same(withSummary.length, 5, "every passing suite's status line carries its own last line");
  same(runner.lastLine("first\n\n  the suite's verdict: 12 checks  \n\n"), "the suite's verdict: 12 checks", "the summary is the last non-empty line, trimmed");
  same(runner.lastLine(""), null, "and a suite that printed nothing has no summary");
  console.log("scenario 7: a green run prints the exact number of suites it ran and asserts it against the manifest");
}

// ─── Scenario 8 — --only is not the gate ──────────────────────────────────────

/**
 * @returns {void}
 */
function scenarioOnlyIsNotTheGate() {
  const dir = fixtureRoot("only-filter");
  writePackage(dir, "node test/runner.js");
  plant(dir, "test-keep.js", 'console.log("kept");\n');
  plant(dir, "test-drop.js", 'console.log("dropped");\n');
  writeManifest(dir, [
    { id: "test-keep", file: "test/test-keep.js" },
    { id: "test-drop", file: "test/test-drop.js" },
  ]);

  const run = runRunner(dir, ["--only=test-keep"]);
  same(run.code, 0, "a filtered run that passes is still a pass");
  ok(run.out.includes("1 ran of 2 in the manifest"), `the filtered run says how few it ran: ${run.out}`);
  ok(run.out.includes("NOT THE GATE"), "it says out loud that a filtered run is not npm test");
  ok(!/^GREEN: /m.test(run.out), "a filtered run never claims GREEN");
  ok(!run.out.includes("test/test-drop.js"), "the filtered-out suite did not run");

  const full = runRunner(dir);
  same(full.code, 0, "the same manifest without --only runs both suites");
  ok(full.out.includes("2 ran of 2 in the manifest"), "and the unfiltered run asserts the full count");
  console.log("scenario 8: --only runs a subset and refuses to be read as the gate");
}

// ─── Scenario 9 — --serial really runs one at a time ──────────────────────────

/**
 * @returns {void}
 */
function scenarioSerialIsSerial() {
  const dir = fixtureRoot("serial-mode");
  writePackage(dir, "node test/runner.js");
  const bookkeeping = path.join(dir, "order.txt");
  for (let i = 1; i <= 4; i++) {
    plant(
      dir,
      `test-order${i}.js`,
      `const fs = require("fs");\n` +
        `fs.appendFileSync(${JSON.stringify(bookkeeping)}, "start ${i}\\n");\n` +
        `const until = Date.now() + 250;\n` +
        "while (Date.now() < until) { /* hold the slot */ }\n" +
        `fs.appendFileSync(${JSON.stringify(bookkeeping)}, "end ${i}\\n");\n` +
        `console.log("order ${i}");\n`
    );
  }
  writeManifest(dir, Array.from({ length: 4 }, (_, i) => ({ id: `test-order${i + 1}`, file: `test/test-order${i + 1}.js` })));

  const run = runRunner(dir, ["--serial"]);
  same(run.code, 0, "--serial runs the fixture green");
  const lines = logLines(bookkeeping);
  same(
    lines,
    ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3", "start 4", "end 4"],
    "--serial runs one suite at a time, in manifest order, with no overlap"
  );
  ok(run.out.includes("--serial"), "the run announces that it is in serial mode");
  console.log("scenario 9: --serial reproduces the old one-at-a-time behaviour, proven by the recorded order");
}

// ─── Scenario 10 — package.json pointing away from the runner ─────────────────

/**
 * @returns {void}
 */
function scenarioPackagePointsElsewhere() {
  const dir = fixtureRoot("package-points-away");
  writePackage(dir, "node test/test-passes.js");
  plant(dir, "test-passes.js", 'console.log("passes");\n');
  writeManifest(dir, [{ id: "test-passes", file: "test/test-passes.js" }]);

  const run = runRunner(dir);
  same(run.code, 1, "a test script that does not run the runner fails the gate");
  ok(run.out.includes("does not run test/runner.js"), `the message names what is wrong: ${run.out}`);
  console.log("scenario 10: pointing npm test at something smaller than the manifest is refused");
}

// ─── Scenario 11 — a scratch folder inside the corpus ─────────────────────────

/**
 * @returns {void}
 */
function scenarioScratchInsideCorpusRefused() {
  const dir = fixtureRoot("scratch-inside-corpus");
  writePackage(dir, "node test/runner.js");
  plant(dir, "test-passes.js", 'console.log("passes");\n');
  writeManifest(dir, [{ id: "test-passes", file: "test/test-passes.js" }]);

  // The corpus, stood up as a folder. The runner must refuse a scratch root inside it.
  const corpus = path.join(dir, "the-series");
  fs.mkdirSync(corpus, { recursive: true });
  const res = spawnSync(
    process.execPath,
    [RUNNER_FILE, `--root=${dir}`, `--output-dir=${path.join(corpus, "out")}`, `--fixture-root=${path.join(corpus, "fixtures")}`],
    { cwd: ROOT, encoding: "utf8", timeout: 60000, env: { ...process.env, SERIES_LOCATION: corpus } }
  );
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  same(res.status, 1, "a scratch folder inside SERIES_LOCATION is refused");
  ok(out.includes("inside SERIES_LOCATION"), `the refusal names the rule: ${out}`);
  ok(!fs.existsSync(path.join(corpus, "out")), "nothing was created in the corpus");
  ok(!out.includes("ok  "), "and no suite ran");

  // The same rule through the fixture helper's own door, in this process.
  const guard = require("./fixture-guard");
  const savedSeries = process.env.SERIES_LOCATION;
  process.env.SERIES_LOCATION = corpus;
  let thrown = null;
  try {
    guard.assertSafeFixturesRoot(path.join(corpus, "fixtures"));
  } catch (err) {
    thrown = err.message;
  }
  // Read the default root with the runner's own override taken away, which is the state a person
  // running this suite by hand is in.
  const savedOverride = process.env.AI_CLIENT_TEST_FIXTURES_ROOT;
  delete process.env.AI_CLIENT_TEST_FIXTURES_ROOT;
  let defaultRoot = null;
  try {
    defaultRoot = guard.resolveFixturesRoot();
  } catch (err) {
    defaultRoot = `threw: ${err.message}`;
  }
  if (savedOverride === undefined) delete process.env.AI_CLIENT_TEST_FIXTURES_ROOT;
  else process.env.AI_CLIENT_TEST_FIXTURES_ROOT = savedOverride;
  if (savedSeries === undefined) delete process.env.SERIES_LOCATION;
  else process.env.SERIES_LOCATION = savedSeries;
  ok(thrown && thrown.includes("inside SERIES_LOCATION"), `the fixture helper refuses the same root: ${thrown}`);
  ok(defaultRoot === "/tmp/opencode/series-fixtures", `and the ordinary default root, which is nowhere near that corpus, still resolves unchanged: ${defaultRoot}`);
  console.log("scenario 11: a scratch root that lands on the corpus is refused by the runner and by the fixture helper");
}

// ─── Scenario 12 — the manifest's own rules ───────────────────────────────────

/**
 * @returns {void}
 */
function scenarioManifestRules() {
  const noReason = fixtureRoot("serial-without-reason");
  writePackage(noReason, "node test/runner.js");
  plant(noReason, "test-one.js", 'console.log("one");\n');
  writeManifest(noReason, [{ id: "test-one", file: "test/test-one.js", phase: "serial" }]);
  const runA = runRunner(noReason);
  same(runA.code, 1, "a serial entry with no reason is refused");
  ok(runA.out.includes("serial phase without a reason"), `and says what is missing: ${runA.out}`);

  const thinReason = fixtureRoot("serial-thin-reason");
  writePackage(thinReason, "node test/runner.js");
  plant(thinReason, "test-one.js", 'console.log("one");\n');
  writeManifest(thinReason, [{ id: "test-one", file: "test/test-one.js", phase: "serial", reason: "slow" }]);
  const runB = runRunner(thinReason);
  same(runB.code, 1, "a one-word reason does not put a suite in the serial phase");

  const dupe = fixtureRoot("duplicate-ids");
  writePackage(dupe, "node test/runner.js");
  plant(dupe, "test-one.js", 'console.log("one");\n');
  writeManifest(dupe, [
    { id: "same", file: "test/test-one.js" },
    { id: "same", file: "test/test-one.js" },
  ]);
  const runC = runRunner(dupe);
  same(runC.code, 1, "two entries with the same id are refused — they would share one output file and one fixture root");
  ok(runC.out.includes("ids must be unique"), `and the message says why: ${runC.out}`);

  const badPhase = fixtureRoot("unknown-phase");
  writePackage(badPhase, "node test/runner.js");
  plant(badPhase, "test-one.js", 'console.log("one");\n');
  writeManifest(badPhase, [{ id: "test-one", file: "test/test-one.js", phase: "whenever" }]);
  const runD = runRunner(badPhase);
  same(runD.code, 1, "a phase the runner does not know is refused rather than quietly skipped");
  ok(runD.out.includes('phase "whenever"'), `the message names the value: ${runD.out}`);

  const thinHelper = fixtureRoot("helper-without-reason");
  writePackage(thinHelper, "node test/runner.js");
  plant(thinHelper, "test-helper.js", 'module.exports = 1;\n');
  plant(thinHelper, "test-one.js", 'console.log("one");\n');
  writeManifest(thinHelper, [{ id: "test-one", file: "test/test-one.js" }], { "test/test-helper.js": "helper" });
  const runE = runRunner(thinHelper);
  same(runE.code, 1, "a helper allow-list entry with no real reason is refused");
  ok(runE.out.includes("without a reason long enough"), `the message says what it wants: ${runE.out}`);
  console.log("scenario 12: a serial entry needs a reason, ids must be unique, an unknown phase is refused, a helper needs a reason");
}

// ─── Scenario 13 — the allow-list lets a real helper through ──────────────────

/**
 * @returns {void}
 */
function scenarioHelperAllowList() {
  const dir = fixtureRoot("helper-allow-list");
  writePackage(dir, "node test/runner.js");
  plant(dir, "test-helper.js", 'module.exports = { helperHome: require("fs").mkdtempSync(require("os").tmpdir() + "/helper-") };\n');
  plant(dir, "test-one.js", 'console.log("one");\n');
  writeManifest(
    dir,
    [{ id: "test-one", file: "test/test-one.js" }],
    {
      "test/test-helper.js":
        "Not a suite: a shared helper every planted suite requires first. It asserts nothing and prints nothing.",
    }
  );

  const run = runRunner(dir);
  same(run.code, 0, `a file that matches test/test-*.js and is named as a helper does not fail the gate:\n${run.out}`);
  ok(run.out.includes("1 ran of 1 in the manifest"), "the helper is not counted as a suite that did not run");
  console.log("scenario 13: the allow-list is the only way a test-*.js file can sit unused, and it has to be explained");
}

// ─── Scenario 14 — the real manifest covers this repository ───────────────────

/**
 * @returns {void}
 */
function scenarioRealManifestIsComplete() {
  const entries = realManifest.SUITES;
  ok(entries.length >= 86, `the real manifest names ${entries.length} invocations (the chain it replaced named 86, plus this suite)`);

  const files = fs.readdirSync(path.join(ROOT, "test")).filter((f) => /^test-.*\.js$/.test(f));
  const covered = new Set(entries.map((e) => e.file));
  const uncovered = files.map((f) => `test/${f}`).filter((f) => !covered.has(f));
  same(uncovered, Object.keys(realManifest.SUITE_HELPERS), "every test/test-*.js in this repository is either in the manifest or named as a helper");
  same(runner.uncoveredSuiteFiles(ROOT, entries, realManifest.SUITE_HELPERS), [], "the runner's own scan finds nothing uncovered in the real repository");

  same(runner.missingManifestFiles(entries, ROOT), [], "every entry of the real manifest names a file that exists");

  const ids = entries.map((e) => e.id);
  same(ids.length, new Set(ids).size, "the real manifest's ids are unique");

  const serial = entries.filter((e) => e.phase === "serial");
  same(serial.length, 3, "exactly three invocations are in the serial phase");
  same(
    entries.slice(-serial.length).map((e) => e.phase),
    serial.map(() => "serial"),
    "the serial entries are the LAST entries in the manifest, which is what keeps the pipeline loop the last act of npm test (rule 11)"
  );
  ok(serial.every((e) => e.file === "test/test-pipeline-loop.js"), "the serial phase is the offline pipeline loop's three invocations");
  ok(serial.every((e) => String(e.reason || "").length >= 20), "each one states what it shares");
  same(
    serial.map((e) => e.args.join(" ")),
    ["--audit-selftest", "", "--stages=discover,extract,glossary,character-voice --chunked=glossary --dir=/tmp/opencode/pipeline-loop-chunked-glossary"],
    "the loop's three invocations keep the arguments and the order the && chain gave them"
  );

  const pkg = require("../package.json");
  same(pkg.scripts.test, "node test/runner.js", "package.json's test script is the runner and nothing else");
  same(runner.packagePointsAtTheRunner({ root: ROOT }), [], "the runner agrees that package.json points at it");

  const rendered = realManifest.renderTestChain();
  const named = rendered.split(" && ").map((p) => (p.trim().split(/\s+/)[1] || "").replace(/\\/g, "/"));
  same(named.length, entries.length, "the rendered chain names one command per manifest entry");
  ok(named.every((f) => f.startsWith("test/test-")), "every command in the rendered chain names a suite file");
  console.log(`scenario 14: the real manifest covers all ${files.length} test/test-*.js files on disk and ends with the pipeline loop`);
}

// ─── Scenario 15 — the constants have no knob ─────────────────────────────────

/**
 * @returns {void}
 */
function scenarioConstantsHaveNoKnob() {
  same(runner.MAX_PARALLEL_SUITES, 6, "MAX_PARALLEL_SUITES is 6");
  same(runner.SUITE_TIMEOUT_MS, 180000, "SUITE_TIMEOUT_MS is 180000 ms");

  const source = fs.readFileSync(path.join(__dirname, "runner.js"), "utf8");
  const envReads = source.match(/process\.env\.[A-Za-z0-9_]+|process\.env\[[^\]]+\]/g) || [];
  const reachesConstants = envReads.filter((read) => /PARALLEL|TIMEOUT|MAX_|_MS\b/i.test(read));
  same(reachesConstants, [], `no environment variable reaches the parallelism cap or the per-suite limit; the runner reads ${JSON.stringify(envReads)}`);

  const cliFlags = source.match(/--[a-z-]+=/g) || [];
  ok(!cliFlags.some((f) => /parallel|timeout/i.test(f)), `no command-line flag reaches them either: ${JSON.stringify(cliFlags)}`);

  const opts = runner.parseArgs([]);
  same(opts.maxParallel, runner.MAX_PARALLEL_SUITES, "a plain run uses the shipped cap");
  same(opts.suiteTimeoutMs, runner.SUITE_TIMEOUT_MS, "and the shipped per-suite limit");
  console.log("scenario 15: the cap and the limit are constants; no env name and no flag reaches them");
}

// ─── Scenario 16 — an unknown flag is refused, and the corpus is unreachable ──

/**
 * @returns {void}
 */
function scenarioUnknownFlagAndCorpusDistance() {
  const dir = fixtureRoot("unknown-flag");
  writePackage(dir, "node test/runner.js");
  plant(dir, "test-one.js", 'console.log("one");\n');
  writeManifest(dir, [{ id: "test-one", file: "test/test-one.js" }]);

  const run = runRunner(dir, ["--max-parallel=99"]);
  same(run.code, 2, "an unknown flag is refused with exit 2, not quietly ignored");
  ok(run.out.includes("unknown argument"), `and named: ${run.out}`);

  // The runner never opens a corpus file: its only filesystem reads are the manifest, package.json and
  // test/. Pinned by asking it to run against a root that IS the corpus and refusing on the guard.
  const corpusStandIn = path.join(dir, "corpus");
  fs.mkdirSync(path.join(corpusStandIn, "Test Story(01)"), { recursive: true });
  fs.writeFileSync(path.join(corpusStandIn, "Test Story(01)", "series.db"), "not a database");
  const res = spawnSync(
    process.execPath,
    [RUNNER_FILE, `--root=${corpusStandIn}`, `--output-dir=${path.join(corpusStandIn, "out")}`, `--fixture-root=${path.join(corpusStandIn, "fixtures")}`],
    { cwd: ROOT, encoding: "utf8", timeout: 60000, env: { ...process.env, SERIES_LOCATION: corpusStandIn } }
  );
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  same(res.status, 1, "pointed at the corpus, the runner refuses rather than runs");
  ok(out.includes("inside SERIES_LOCATION"), `and says which rule it refused on: ${out}`);
  ok(!out.includes("ok  "), "no suite ran against the corpus root");
  console.log("scenario 16: an unknown flag is refused, and a corpus root is refused before a suite starts");
}

// ─── Scenario 17 — each suite gets its own fixture root ───────────────────────

/**
 * @returns {void}
 */
function scenarioPerSuiteFixtureRoot() {
  const dir = fixtureRoot("fixture-roots");
  writePackage(dir, "node test/runner.js");
  const record = path.join(dir, "roots.jsonl");
  for (const name of ["test-root-a.js", "test-root-b.js"]) {
    plant(
      dir,
      name,
      `const fs = require("fs");\n` +
        `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ name: ${JSON.stringify(name)}, root: process.env.AI_CLIENT_TEST_FIXTURES_ROOT || null }) + "\\n");\n` +
        `console.log("${name} ran");\n`
    );
  }
  writeManifest(dir, [
    { id: "test-root-a", file: "test/test-root-a.js" },
    { id: "test-root-b", file: "test/test-root-b.js" },
  ]);

  const run = runRunner(dir);
  same(run.code, 0, `the fixture-root fixture runs green:\n${run.out}`);
  const rows = logLines(record).map((l) => JSON.parse(l));
  same(rows.length, 2, "both suites reported the root they were given");
  ok(rows.every((r) => typeof r.root === "string" && r.root.length > 0), `every suite was handed a root of its own: ${JSON.stringify(rows)}`);
  same(new Set(rows.map((r) => r.root)).size, 2, "the two roots are different folders — that is the collision the runner removes");
  ok(rows.every((r) => r.root.startsWith(path.join(dir, "fixtures"))), "both roots live under the fixture root the runner was given, not the corpus");

  // And the guard the runner relies on refuses a root inside the corpus.
  const guard = require("./fixture-guard");
  let thrown = null;
  try {
    guard.resolveFixturesRoot("/tmp/opencode/series-fixtures");
  } catch (err) {
    thrown = err.message;
  }
  ok(thrown === null, `with no SERIES_LOCATION in play the shared default still resolves: ${thrown}`);
  console.log("scenario 17: every suite the runner starts gets its own fixture root, so a reused label cannot delete another suite's fixture");
}

// ─── Scenario 18 — the default fixture root is unchanged for a hand-run suite ─

/**
 * @returns {void}
 */
function scenarioHandRunDefaultUnchanged() {
  const guard = require("./fixture-guard");
  const saved = process.env.AI_CLIENT_TEST_FIXTURES_ROOT;
  const savedSeries = process.env.SERIES_LOCATION;
  delete process.env.AI_CLIENT_TEST_FIXTURES_ROOT;
  delete process.env.SERIES_LOCATION;
  try {
    same(guard.resolveFixturesRoot(), "/tmp/opencode/series-fixtures", "with the override unset, the shared default is exactly what it always was");
    same(guard.resolveFixturesRoot("/tmp/opencode/series-fixtures"), "/tmp/opencode/series-fixtures", "and a caller that spells it out still gets it");
    same(guard.resolveFixturesRoot("/tmp/opencode/somewhere-else"), "/tmp/opencode/somewhere-else", "a caller that names its own root keeps it");
    process.env.AI_CLIENT_TEST_FIXTURES_ROOT = "/tmp/opencode/per-suite";
    same(guard.resolveFixturesRoot(), "/tmp/opencode/per-suite", "with the override set, the helper uses it");
    same(guard.resolveFixturesRoot("/tmp/opencode/series-fixtures"), "/tmp/opencode/per-suite", "and a caller that passed the shared default is redirected to it");
    same(guard.resolveFixturesRoot("/tmp/opencode/somewhere-else"), "/tmp/opencode/somewhere-else", "while a caller that named its own root is not redirected");
  } finally {
    if (saved === undefined) delete process.env.AI_CLIENT_TEST_FIXTURES_ROOT;
    else process.env.AI_CLIENT_TEST_FIXTURES_ROOT = saved;
    if (savedSeries === undefined) delete process.env.SERIES_LOCATION;
    else process.env.SERIES_LOCATION = savedSeries;
  }
  console.log("scenario 18: running a suite by hand behaves exactly as it did before the runner existed");
}

// ─── main ─────────────────────────────────────────────────────────────────────

/**
 * @returns {void}
 */
function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const scenarios = [
    scenarioFailingSuite,
    scenarioSilentSuite,
    scenarioHangingSuite,
    scenarioManifestNamesNothing,
    scenarioOrphanSuiteFile,
    scenarioEntrySkipped,
    scenarioGreenRunCounts,
    scenarioOnlyIsNotTheGate,
    scenarioSerialIsSerial,
    scenarioPackagePointsElsewhere,
    scenarioScratchInsideCorpusRefused,
    scenarioManifestRules,
    scenarioHelperAllowList,
    scenarioRealManifestIsComplete,
    scenarioConstantsHaveNoKnob,
    scenarioUnknownFlagAndCorpusDistance,
    scenarioPerSuiteFixtureRoot,
    scenarioHandRunDefaultUnchanged,
  ];
  for (const scenario of scenarios) scenario();

  console.log("");
  if (failures.length) {
    console.error(`FAILED: ${failures.length} of ${checks} checks`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`suite runner: ${scenarios.length} scenarios, ${checks} checks, 0 model calls, 0 reads of the real volumes.`);
}

main();

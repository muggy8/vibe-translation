#!/usr/bin/env node
/**
 * test/runner.js — the scheduler for `npm test`.
 *
 * `package.json`'s `test` script used to be a serial `&&` chain of 86 `node test/test-x.js` commands.
 * That chain was the manifest, the order, the scheduler and the guard, all in one 6,000-character
 * string. This module is the scheduler; `test/suites.js` is the manifest. What the chain guaranteed,
 * this guarantees, and it adds the one thing the chain could not: a file matching `test/test-*.js`
 * that no manifest entry names is a FAILURE (gotcha 169 — a suite nobody invoked was a file, not a
 * gate, and the gate stayed green around it).
 *
 * What it does, in order:
 *
 *   1. Reads the manifest and checks it before anything runs: unique ids, a written reason on every
 *      serial entry, every named file present, `package.json`'s `test` script still pointing here, and
 *      every `test/test-*.js` on disk either named by the manifest or named by the helper allow-list.
 *      A problem here stops the run before a suite is paid for.
 *   2. Runs the `concurrent` suites as separate `node` processes, up to MAX_PARALLEL_SUITES at once.
 *   3. Runs the `serial` suites one at a time, in manifest order, AFTER every concurrent suite has
 *      finished. The offline pipeline loop is in that phase and is last, which is what keeps AGENTS.md
 *      rule 11 literally true.
 *   4. Captures each suite's stdout and stderr to a file, so nothing interleaves, and prints one status
 *      line per suite as it finishes — with that suite's own last line beside it, so the transcript names
 *      what each suite said it did and not only that it exited 0.
 *   5. Prints the full captured output of every suite that failed, a timing table sorted slowest-first,
 *      and the total wall clock, so the next measurement costs nothing.
 *   6. Exits non-zero if any suite failed, timed out, could not be spawned, printed nothing, or never
 *      ran at all — and prints how many suites ran against how many the manifest names.
 *
 * Two flags, neither of which changes what a plain `npm test` does:
 *
 *   --only=<substring>   run a subset while developing. It prints a loud line saying the filtered run
 *                        is NOT the gate, because a green subset is exactly the mistake gotcha 169 is.
 *   --serial             run everything one at a time in manifest order, which is what the `&&` chain
 *                        did, for when a suspected flake needs the old behaviour.
 *
 * There is no environment knob on the parallelism cap or the per-suite timeout, and no flag reaches
 * them either (AGENTS.md rule 3). The only way to run them at a different value is to edit the
 * constants, which is the point.
 *
 * Plain `assert`-free by design: this is a scheduler, not a suite. `test/test-suite-runner.js` is the
 * suite that pins it.
 *
 * @module test/runner
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/** The repository root. */
const ROOT = path.resolve(__dirname, "..");

/** Where the manifest lives, relative to the root. */
const MANIFEST_REL = "test/suites.js";

/** This file, relative to the root — the thing `package.json`'s `test` script has to name. */
const RUNNER_REL = "test/runner.js";

/**
 * How many suites may run at once.
 *
 * Measured on this machine (12 cores, 60 GB with ~8 GB free) on 2026-10-16: the six slowest suites
 * alone take 116,602 ms in sequence and 26,756 ms when started at the same instant, and each one took
 * about the time it takes alone — nothing queued. Six is that measurement, not a guess, and it is the
 * number that keeps ~8 GB of headroom for the heaviest suites (the pipeline loop and the translate
 * stage each build a whole fixture series in a child process).
 *
 * It is a constant with no environment variable and no flag in front of it: a cap the role under test
 * can raise is not a cap (AGENTS.md rule 3). Raising it is an edit to this line, by a reader who has
 * measured it.
 */
const MAX_PARALLEL_SUITES = 6;

/**
 * How long one suite may run before it is killed and reported as a failure.
 *
 * 180,000 ms against a measured worst case of 26,670 ms (`test/test-fake-backend.js`, run alone) and
 * 26,756 ms for the six heaviest running together: about seven times the slowest suite this repository
 * has, and far below "forever", which is the state where a hung suite stops being a hung suite and
 * becomes a build nobody can end. Same rule as the cap: a constant, no knob.
 */
const SUITE_TIMEOUT_MS = 180000;

/** Where each suite's captured stdout / stderr lands. */
const SUITE_OUTPUT_DIR = "/tmp/opencode/suite-output";

/** Where each suite's own throwaway fixture root is made. */
const SUITE_FIXTURE_ROOT = "/tmp/opencode/suite-fixtures";

/** The variable the fixture helpers read to find the root this runner gave them. */
const FIXTURE_ROOT_ENV = "AI_CLIENT_TEST_FIXTURES_ROOT";

/** The pattern that makes a file in `test/` look like a suite. */
const SUITE_FILE_PATTERN = /^test-.*\.js$/;

/**
 * @typedef {Object} SuiteEntry
 * One invocation the manifest names.
 * @property {string} id     - Unique name: keys the captured output files and the suite's fixture root.
 * @property {string} file   - Suite path, relative to the root.
 * @property {string[]} args - Arguments passed verbatim.
 * @property {string} phase  - "concurrent" or "serial".
 * @property {string|null} reason - For a serial entry: what it shares.
 */

/**
 * @typedef {Object} SuiteResult
 * What happened to one entry.
 * @property {SuiteEntry} entry
 * @property {"ok"|"failed"|"timeout"|"not-run"} status
 * @property {number|null} exitCode
 * @property {string|null} signal
 * @property {number} ms
 * @property {string} stdoutFile
 * @property {string} stderrFile
 * @property {number} bytes
 * @property {string|null} note - Why it failed when the exit code does not say (timeout, empty output, spawn error).
 * @property {string|null} summary - The suite's own last line, carried onto its status line so the run's
 *   transcript names what each suite said it did (gotcha 169).
 */

/**
 * @typedef {Object} RunnerOptions
 * @property {string} root          - The repository (or fixture) whose `test/` folder is scheduled.
 * @property {string} manifest      - Absolute path to the manifest module.
 * @property {string} outputDir     - Where captured output is written.
 * @property {string} fixtureRoot   - Parent of the per-suite fixture roots.
 * @property {string|null} only     - Substring filter, or null.
 * @property {boolean} serial       - Run everything one at a time, in manifest order.
 * @property {number} maxParallel   - Test seam only; the CLI path always passes MAX_PARALLEL_SUITES.
 * @property {number} suiteTimeoutMs- Test seam only; the CLI path always passes SUITE_TIMEOUT_MS.
 */

// ─── Guards ───────────────────────────────────────────────────────────────────

/**
 * Is `child` the same folder as `parent` or inside it?
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Refuse a scratch folder the corpus could be.
 *
 * The same rule `test/test-home.js` enforces for a suite's records folder, applied to the folders this
 * runner makes for it: a scratch root that lands inside `SERIES_LOCATION` is a scratch root that can
 * delete a book (gotcha 69, and gotcha 172, where a "copy for reading" was written into the series
 * folder and checkpointed every write-ahead log in it).
 *
 * @param {string} dir - The folder this runner is about to use as scratch.
 * @param {string} what - Which folder it is, for the message.
 * @param {string} root - The repository root, whose default source folder is refused too.
 * @returns {string|null} The refusal, or null when the folder is safe.
 */
function refuseScratchInsideCorpus(dir, what, root) {
  const absolute = path.resolve(dir);
  const series = (process.env.SERIES_LOCATION || "").trim();
  if (series && isInside(series, absolute)) {
    return (
      `test/runner.js: the ${what} (${absolute}) is inside SERIES_LOCATION (${series}). ` +
      `A test scratch folder must not be able to reach the corpus it is testing.`
    );
  }
  const defaultSource = path.join(root, "epub_source");
  if (isInside(defaultSource, absolute)) {
    return (
      `test/runner.js: the ${what} (${absolute}) is inside this repository's default source folder ` +
      `(${defaultSource}). That folder holds books, not scratch.`
    );
  }
  return null;
}

// ─── Reading the manifest ─────────────────────────────────────────────────────

/**
 * Load the manifest and check it as data, before any suite is started.
 *
 * @param {RunnerOptions} opts
 * @returns {{entries: SuiteEntry[], helpers: Object<string,string>, problems: string[]}}
 */
function loadManifest(opts) {
  const problems = [];
  if (!fs.existsSync(opts.manifest)) {
    return { entries: [], helpers: {}, problems: [`no manifest at ${opts.manifest}`] };
  }
  /** @type {{SUITES?: SuiteEntry[], SUITE_HELPERS?: Object<string,string>}} */
  let loaded;
  try {
    loaded = require(opts.manifest);
  } catch (err) {
    return { entries: [], helpers: {}, problems: [`the manifest at ${opts.manifest} cannot be required: ${err.message}`] };
  }
  const entries = Array.isArray(loaded.SUITES) ? loaded.SUITES : [];
  const helpers = loaded.SUITE_HELPERS && typeof loaded.SUITE_HELPERS === "object" ? loaded.SUITE_HELPERS : {};
  if (!Array.isArray(loaded.SUITES)) problems.push(`the manifest at ${opts.manifest} exports no SUITES array`);

  const seen = new Map();
  entries.forEach((entry, index) => {
    const where = `manifest entry ${index}`;
    if (!entry || typeof entry !== "object") {
      problems.push(`${where} is not an object`);
      return;
    }
    if (!entry.id || typeof entry.id !== "string") problems.push(`${where} has no id`);
    if (!entry.file || typeof entry.file !== "string") problems.push(`${where} has no file`);
    if (!Array.isArray(entry.args)) problems.push(`${where} (${entry.id || "?"}) has no args array`);
    if (entry.phase !== "concurrent" && entry.phase !== "serial") {
      problems.push(`${where} (${entry.id || "?"}) has phase "${entry.phase}", which is neither "concurrent" nor "serial"`);
    }
    if (entry.phase === "serial" && (!entry.reason || String(entry.reason).trim().length < 20)) {
      problems.push(
        `${where} (${entry.id || "?"}) is in the serial phase without a reason of its own. ` +
        `A suite leaves the concurrent group only by naming what it shares with another suite.`
      );
    }
    if (entry.id) {
      if (seen.has(entry.id)) problems.push(`manifest ids must be unique: "${entry.id}" is used by two entries`);
      seen.set(entry.id, true);
    }
  });

  for (const [file, reason] of Object.entries(helpers)) {
    if (!reason || String(reason).trim().length < 20) {
      problems.push(`the helper allow-list names ${file} without a reason long enough to be a reason`);
    }
  }
  return { entries, helpers, problems };
}

/**
 * Every manifest entry whose file is not a file on disk.
 *
 * @param {SuiteEntry[]} entries
 * @param {string} root
 * @returns {string[]} Human-readable problems.
 */
function missingManifestFiles(entries, root) {
  const out = [];
  for (const entry of entries) {
    if (!entry.file) continue;
    const abs = path.join(root, entry.file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      out.push(`the manifest names ${entry.file} (id "${entry.id}") and there is no file there`);
    }
  }
  return out;
}

/**
 * Every `test/test-*.js` on disk that the manifest does not name and the helper allow-list does not
 * explain. This is the guard gotcha 169 was written for.
 *
 * @param {string} root
 * @param {SuiteEntry[]} entries
 * @param {Object<string,string>} helpers
 * @returns {string[]} Human-readable problems.
 */
function uncoveredSuiteFiles(root, entries, helpers) {
  const testDir = path.join(root, "test");
  if (!fs.existsSync(testDir)) return [`there is no test/ folder at ${root}`];
  const covered = new Set(entries.map((e) => e.file));
  const problems = [];
  for (const name of fs.readdirSync(testDir).sort()) {
    if (!SUITE_FILE_PATTERN.test(name)) continue;
    const rel = `test/${name}`;
    if (covered.has(rel)) continue;
    if (Object.prototype.hasOwnProperty.call(helpers, rel)) continue;
    problems.push(
      `${rel} matches test/test-*.js and nothing runs it. It is not in the manifest and not in the ` +
      `helper allow-list. Add it to test/suites.js, or name it in SUITE_HELPERS with the reason it is ` +
      `not a suite (gotcha 169).`
    );
  }
  return problems;
}

/**
 * `package.json`'s `test` script still has to point at this runner.
 *
 * The manifest moved out of `package.json`, and `utils/patches/checks.js` compares the manifest from
 * then on — so the half that used to be automatic ("the chain IS what npm runs") needs its own check,
 * or a patch could repoint `npm test` at something smaller while the manifest stays complete.
 *
 * @param {RunnerOptions} opts
 * @returns {string[]} Human-readable problems.
 */
function packagePointsAtTheRunner(opts) {
  const pkgPath = path.join(opts.root, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return [`${opts.root}/package.json is missing, so nothing here proves that \`npm test\` runs ${RUNNER_REL}.`];
  }
  /** @type {string|null} */
  let script = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    script = (pkg.scripts && pkg.scripts.test) || null;
  } catch (err) {
    return [`cannot read ${opts.root}/package.json: ${err.message}`];
  }
  if (!script) return [`${opts.root}/package.json has no "test" script, so \`npm test\` runs nothing.`];
  const named = String(script)
    .split("&&")
    .map((part) => part.trim().split(/\s+/)[1] || "")
    .map((p) => p.replace(/\\/g, "/"));
  if (!named.some((p) => p === RUNNER_REL || p.endsWith(`/${RUNNER_REL}`))) {
    return [
      `${opts.root}/package.json's "test" script is "${script}", which does not run ${RUNNER_REL}. ` +
      `The manifest is the list and this runner is the thing that runs it; pointing npm test somewhere ` +
      `else is how a gate gets shortened without anything noticing (gotcha 169).`,
    ];
  }
  return [];
}

// ─── Running one suite ────────────────────────────────────────────────────────

/**
 * Kill a suite and everything it spawned.
 *
 * Suites spawn children of their own (`index.js`, `delivery.js`, a `--child=` mode of themselves), and
 * SIGKILL on the parent alone leaves them holding the fixture and the port. Each suite is started as its
 * own process group so the whole group can go.
 *
 * @param {import("child_process").ChildProcess} child
 * @returns {void}
 */
function killSuiteTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* the group is already gone */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* the process is already gone */
  }
}

/**
 * The last non-empty line of a suite's output, shortened to something a status line can carry.
 *
 * Every suite in this repository ends by printing what it checked (`255 checks on the three read passes'
 * answer envelopes`, `OK: the whole pipeline ran against the stub, the audit is clean…`). Carrying that
 * line onto the suite's status line is what makes `npm test`'s own transcript name each suite and what it
 * said it did, which is the thing gotcha 169 says to grep for.
 *
 * @param {string} text
 * @returns {string|null}
 */
function lastLine(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const line = lines[lines.length - 1];
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/**
 * Run one manifest entry as its own `node` process, exactly as the `&&` chain did.
 *
 * @param {SuiteEntry} entry
 * @param {RunnerOptions} opts
 * @returns {Promise<SuiteResult>}
 */
function runSuite(entry, opts) {
  const stdoutFile = path.join(opts.outputDir, `${entry.id}.stdout.log`);
  const stderrFile = path.join(opts.outputDir, `${entry.id}.stderr.log`);
  fs.writeFileSync(stdoutFile, "");
  fs.writeFileSync(stderrFile, "");

  const started = Date.now();
  /** @param {Partial<SuiteResult>} rest */
  const finish = (rest) => ({
    entry,
    status: "ok",
    exitCode: null,
    signal: null,
    ms: Date.now() - started,
    stdoutFile,
    stderrFile,
    bytes: 0,
    note: null,
    summary: null,
    ...rest,
  });

  const fixtureDir = path.join(opts.fixtureRoot, entry.id);
  const env = { ...process.env, [FIXTURE_ROOT_ENV]: fixtureDir };

  return new Promise((resolve) => {
    let settled = false;
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    /** @param {SuiteResult} result */
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    /** @type {import("child_process").ChildProcess} */
    let child;
    try {
      fs.mkdirSync(fixtureDir, { recursive: true });
      child = spawn(process.execPath, [path.join(opts.root, entry.file), ...entry.args], {
        cwd: opts.root,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      settle(finish({ status: "not-run", note: `could not be spawned: ${err.message}` }));
      return;
    }

    /**
     * The suite's own output, held in memory and written to the captured files here rather than through
     * a write stream: the child's `close` event fires before a piped stream has finished flushing, and
     * both the byte count (which decides "printed nothing") and the summary line are read off this copy.
     */
    const outChunks = [];
    const errChunks = [];
    if (child.stdout) child.stdout.on("data", (chunk) => outChunks.push(chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => errChunks.push(chunk));

    /**
     * @returns {{bytes: number, summary: string|null}} The captured size and the suite's last line.
     */
    const capture = () => {
      const stdoutText = Buffer.concat(outChunks).toString("utf8");
      const stderrText = Buffer.concat(errChunks).toString("utf8");
      fs.writeFileSync(stdoutFile, stdoutText);
      fs.writeFileSync(stderrFile, stderrText);
      return {
        bytes: Buffer.byteLength(stdoutText) + Buffer.byteLength(stderrText),
        summary: lastLine(stdoutText) || lastLine(stderrText),
      };
    };

    timer = setTimeout(() => {
      killSuiteTree(child);
      const captured = capture();
      settle(
        finish({
          status: "timeout",
          bytes: captured.bytes,
          summary: captured.summary,
          note: `ran past the ${opts.suiteTimeoutMs} ms per-suite limit and was killed`,
        })
      );
    }, opts.suiteTimeoutMs);

    child.on("error", (err) => {
      const captured = capture();
      settle(
        finish({
          status: "not-run",
          bytes: captured.bytes,
          summary: captured.summary,
          note: `could not be spawned: ${err.message}`,
        })
      );
    });

    child.on("close", (code, signal) => {
      const captured = capture();
      if (code === 0) {
        // A suite that prints nothing is invisible in the transcript exactly the way a suite that never
        // ran is, and "grep the output for the suite's own summary line" is the advice gotcha 169 gives.
        settle(
          finish({
            status: captured.bytes === 0 ? "failed" : "ok",
            exitCode: 0,
            bytes: captured.bytes,
            summary: captured.summary,
            note:
              captured.bytes === 0
                ? "exited 0 and printed nothing: a suite with no output cannot be told apart from a suite that never ran"
                : null,
          })
        );
        return;
      }
      settle(
        finish({
          status: "failed",
          exitCode: code,
          signal,
          bytes: captured.bytes,
          summary: captured.summary,
          note: code === null ? `killed by ${signal || "an unknown signal"}` : `exited ${code}`,
        })
      );
    });
  });
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

/**
 * Print one suite's result the moment it lands, so a long run says something while it is running.
 *
 * @param {SuiteResult} result
 * @returns {void}
 */
function printResult(result) {
  const tag = result.status === "ok" ? "ok  " : result.status === "timeout" ? "TIME" : result.status === "not-run" ? "NONE" : "FAIL";
  const said = result.summary ? `  → ${result.summary}` : "";
  const extra = result.note ? `  (${result.note})` : "";
  console.log(`${tag} ${String(result.ms).padStart(7)}ms  ${result.entry.file}${result.entry.args.length ? ` ${result.entry.args.join(" ")}` : ""}${said}${extra}`);
}

/**
 * Run a list of suites with at most `maxParallel` of them alive at once.
 *
 * @param {SuiteEntry[]} entries
 * @param {RunnerOptions} opts
 * @returns {Promise<SuiteResult[]>}
 */
async function runPool(entries, opts) {
  const results = [];
  let next = 0;
  /**
   * @returns {Promise<void>}
   */
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= entries.length) return;
      const result = await runSuite(entries[index], opts);
      results.push(result);
      printResult(result);
    }
  }
  const width = Math.max(1, Math.min(opts.maxParallel, entries.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/**
 * Run a list of suites one at a time, in the order given.
 *
 * @param {SuiteEntry[]} entries
 * @param {RunnerOptions} opts
 * @returns {Promise<SuiteResult[]>}
 */
async function runSerially(entries, opts) {
  const results = [];
  for (const entry of entries) {
    const result = await runSuite(entry, opts);
    results.push(result);
    printResult(result);
  }
  return results;
}

// ─── The report ───────────────────────────────────────────────────────────────

/**
 * Print everything a failed suite said.
 *
 * @param {SuiteResult[]} results
 * @returns {void}
 */
function printFailedOutput(results) {
  const failed = results.filter((r) => r.status !== "ok");
  if (!failed.length) return;
  console.log("");
  console.log("=== output of every suite that did not pass ===");
  for (const r of failed) {
    console.log("");
    console.log(`--- ${r.entry.file}${r.entry.args.length ? ` ${r.entry.args.join(" ")}` : ""} — ${r.status}${r.note ? `: ${r.note}` : ""} ---`);
    console.log(`    stdout: ${r.stdoutFile}`);
    console.log(`    stderr: ${r.stderrFile}`);
    for (const [label, file] of [["stdout", r.stdoutFile], ["stderr", r.stderrFile]]) {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        text = "(no captured output)";
      }
      if (!text.trim()) continue;
      console.log(`    --- ${label} ---`);
      for (const line of text.replace(/\n+$/, "").split("\n")) console.log(`    ${line}`);
    }
  }
}

/**
 * Print the timing table, slowest first, and the totals.
 *
 * @param {SuiteResult[]} results
 * @param {number} totalMs
 * @param {number} manifestCount - Every entry the manifest names.
 * @param {number} selectedCount - The subset this run was asked for.
 * @param {boolean} filtered - Whether --only narrowed the run.
 * @returns {boolean} Whether the run is green.
 */
function printSummary(results, totalMs, manifestCount, selectedCount, filtered) {
  const sorted = [...results].sort((a, b) => b.ms - a.ms);
  console.log("");
  console.log("=== suite timings (slowest first) ===");
  for (const r of sorted) {
    const tag = r.status === "ok" ? "ok  " : r.status === "timeout" ? "TIME" : r.status === "not-run" ? "NONE" : "FAIL";
    console.log(`  ${String(r.ms).padStart(7)}ms  ${tag} ${r.entry.file}${r.entry.args.length ? ` ${r.entry.args.join(" ")}` : ""}`);
  }

  const attempted = results.length;
  const neverStarted = results.filter((r) => r.status === "not-run");
  const timedOut = results.filter((r) => r.status === "timeout");
  const ran = attempted - neverStarted.length;
  const passed = results.filter((r) => r.status === "ok").length;
  const failed = attempted - passed;

  console.log("");
  console.log(
    `suites: ${ran} ran of ${manifestCount} in the manifest${filtered ? ` (${selectedCount} selected by --only)` : ""}, ` +
    `${passed} passed, ${failed} failed` +
    `${neverStarted.length ? `, ${neverStarted.length} could not be started at all` : ""}` +
    `${timedOut.length ? `, ${timedOut.length} killed for running past the limit` : ""}.  wall clock ${totalMs} ms.`
  );
  for (const r of neverStarted) console.log(`  never started: ${r.entry.file} (${r.note})`);
  for (const r of timedOut) console.log(`  killed: ${r.entry.file} (${r.note})`);

  // A filtered run is judged against the subset it was asked for — a developer running one suite should
  // get exit 0 when that suite passes — but it is never allowed to read as the gate, and the line below
  // says so. An unfiltered run is judged against the whole manifest.
  const green = failed === 0 && ran === (filtered ? selectedCount : manifestCount);
  if (filtered) {
    console.log(
      `NOT THE GATE: --only ran ${ran} of ${manifestCount} manifest entries. This is a development run, ` +
      `not npm test; a green subset says nothing about the ${manifestCount - ran} suites that did not run.`
    );
  } else if (!green) {
    console.log(
      `NOT GREEN: ${failed} suite(s) failed and ${ran} of ${manifestCount} manifest entries ran. ` +
      `A suite that was skipped, could not be spawned, or was killed is a failure, not a gap in the output.`
    );
  } else {
    console.log(`GREEN: ${ran} suites ran, which is every entry in the manifest.`);
  }
  return green;
}

// ─── main ─────────────────────────────────────────────────────────────────────

/**
 * Read the command line.
 *
 * @param {string[]} argv
 * @returns {RunnerOptions}
 */
function parseArgs(argv) {
  /** @type {RunnerOptions} */
  const opts = {
    root: ROOT,
    manifest: "",
    outputDir: SUITE_OUTPUT_DIR,
    fixtureRoot: SUITE_FIXTURE_ROOT,
    only: null,
    serial: false,
    maxParallel: MAX_PARALLEL_SUITES,
    suiteTimeoutMs: SUITE_TIMEOUT_MS,
  };
  for (const arg of argv) {
    if (arg.startsWith("--only=")) opts.only = arg.slice("--only=".length);
    else if (arg === "--serial") opts.serial = true;
    else if (arg.startsWith("--root=")) opts.root = path.resolve(arg.slice("--root=".length));
    else if (arg.startsWith("--manifest=")) opts.manifest = path.resolve(arg.slice("--manifest=".length));
    else if (arg.startsWith("--output-dir=")) opts.outputDir = path.resolve(arg.slice("--output-dir=".length));
    else if (arg.startsWith("--fixture-root=")) opts.fixtureRoot = path.resolve(arg.slice("--fixture-root=".length));
    else throw new Error(`test/runner.js: unknown argument "${arg}". Known: --only=<substring>, --serial.`);
  }
  if (!opts.manifest) opts.manifest = path.join(opts.root, MANIFEST_REL);
  return opts;
}

/**
 * Run the gate.
 *
 * @param {RunnerOptions} opts
 * @returns {Promise<number>} The process exit code.
 */
async function runManifest(opts) {
  const started = Date.now();
  const problems = [];

  for (const [dir, what] of [[opts.outputDir, "captured-output folder"], [opts.fixtureRoot, "fixture-root folder"]]) {
    const refusal = refuseScratchInsideCorpus(dir, what, opts.root);
    if (refusal) problems.push(refusal);
  }

  const { entries, helpers, problems: manifestProblems } = loadManifest(opts);
  problems.push(...manifestProblems);
  if (!problems.length) {
    problems.push(...missingManifestFiles(entries, opts.root));
    problems.push(...uncoveredSuiteFiles(opts.root, entries, helpers));
    problems.push(...packagePointsAtTheRunner(opts));
  }

  if (problems.length) {
    console.log("=== the manifest is not runnable ===");
    for (const problem of problems) console.log(`  ${problem}`);
    console.log("");
    console.log(`NOT GREEN: nothing ran. ${problems.length} problem(s) above.`);
    return 1;
  }

  fs.rmSync(opts.outputDir, { recursive: true, force: true });
  fs.mkdirSync(opts.outputDir, { recursive: true });
  fs.rmSync(opts.fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(opts.fixtureRoot, { recursive: true });

  const selected = opts.only
    ? entries.filter((e) => e.file.includes(opts.only) || e.id.includes(opts.only))
    : entries;

  console.log(
    `npm test — ${entries.length} manifest entries, ${selected.length} selected, ` +
    `up to ${opts.maxParallel} at a time, ${opts.suiteTimeoutMs} ms per suite.`
  );
  console.log(`captured output: ${opts.outputDir}`);
  console.log(`per-suite fixtures: ${opts.fixtureRoot}  (each suite gets its own)`);
  if (opts.only) {
    console.log(`--only=${opts.only} — this is NOT the gate. The full gate is a plain \`npm test\`.`);
  }
  if (opts.serial) console.log("--serial — every suite one at a time, in manifest order.");
  console.log("");

  /** @type {SuiteResult[]} */
  let results = [];
  if (opts.serial) {
    results = await runSerially(selected, opts);
  } else {
    const concurrent = selected.filter((e) => e.phase === "concurrent");
    const serial = selected.filter((e) => e.phase === "serial");
    results = await runPool(concurrent, opts);
    results = results.concat(await runSerially(serial, opts));
  }

  printFailedOutput(results);
  const green = printSummary(results, Date.now() - started, entries.length, selected.length, Boolean(opts.only));
  return green ? 0 : 1;
}

/**
 * The CLI entry point.
 *
 * @returns {Promise<void>}
 */
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = await runManifest(opts);
  } catch (err) {
    console.error(`test/runner.js failed: ${err && err.message}`);
    if (err && err.stack) console.error(String(err.stack).split("\n").slice(0, 8).join("\n"));
    process.exitCode = 1;
  }
}

module.exports = {
  ROOT,
  MANIFEST_REL,
  RUNNER_REL,
  MAX_PARALLEL_SUITES,
  SUITE_TIMEOUT_MS,
  SUITE_OUTPUT_DIR,
  SUITE_FIXTURE_ROOT,
  FIXTURE_ROOT_ENV,
  SUITE_FILE_PATTERN,
  parseArgs,
  loadManifest,
  missingManifestFiles,
  uncoveredSuiteFiles,
  packagePointsAtTheRunner,
  refuseScratchInsideCorpus,
  lastLine,
  runSuite,
  runPool,
  runSerially,
  runManifest,
  main,
};

if (require.main === module) main();

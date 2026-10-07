/**
 * index.js — Run the pipeline one step at a time, and check what each step left.
 *
 * Why this entry point exists. `npx gulp` (the default task) runs all nine steps
 * inside ONE Node process. That has two consequences this project feels:
 *
 *   1. Node caches every module the first time it is required, and gulpfile.js
 *      requires all ten task modules at the top of the file. A fix written to
 *      disk mid-run is not the code the rest of the run executes.
 *   2. `ON_TASK_ERROR=continue` runs the remaining steps on a foundation the
 *      previous step failed to build (gotcha 21 records what that looked like:
 *      every step re-running a rejected intake, three attempts apiece).
 *
 * This file changes both by running each step as its own process:
 *
 *   - a fresh process means a fresh module cache, so a fix applied between steps
 *     IS the code the next step runs — no module-cache surgery, and no volume
 *     half-built by old code and half by new;
 *   - the post-mortem runs BEFORE the next step, so a broken glossary is found
 *     before the character-voice stage builds on it, not after the translation
 *     stage has already paid for it.
 *
 * The step itself is still gulp: `node node_modules/gulp/bin/gulp.js <step>`, so
 * every per-machine hook (hooks/pre-<task>, hooks/post-<task>) fires exactly as it
 * does today, including the model-container switches the translation stage needs
 * (gotcha 22). Nothing about how a step RUNS changes here; only who runs it, and
 * what happens after it.
 *
 * Scope, honestly stated. This file ORCHESTRATES and ASSESSES. It does not fix
 * anything: there is no diagnosis agent here, no patching, no retry loop. The
 * findings it writes to `.postmortem/<step>.json` are the input a later diagnosis
 * stage consumes. Keeping the two separate is deliberate — assessment is
 * deterministic, free, and safe to run on every step of every run; deciding to
 * rewrite code is neither.
 *
 * Usage:
 *   node index.js                      # every step, in gulp order
 *   node index.js --stages=glossary,jump-in-wiki
 *   node index.js --force              # passed through to every step
 *   node index.js --volume 07          # passed through to every step
 *   node index.js --dry-run            # no model calls, no post-mortem (nothing is written)
 *   node index.js --post-mortem=off    # orchestration only
 *   node index.js --fail-on=never      # report findings, do not fail the run on them
 *   node index.js --ledger=off         # record nothing about what this run assessed
 *   node index.js --list               # print the step list and exit
 *
 * It also REMEMBERS. Every assessed step appends one entry to
 * `.postmortem/ledger.json` (see `utils/ledger.js`): what the step left behind, and
 * later what was decided about it. Nothing else in the pipeline records a DECISION —
 * the state files record artifacts — and without that record the delivery stage cannot
 * tell a repair from a repeat of a repair that already failed.
 *
 * @module index
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("./types"); // JSDoc type definitions
const GULPFILE = require("./gulpfile");
const { PIPELINE_STEPS } = GULPFILE;
const { TASKS } = require("./utils/hooks");
const { isStructuralError } = require("./configs/shared");
const { runPostMortem, writePostMortemReport, postMortemDir } = require("./utils/postmortem");
const {
  ledgerEnabled,
  ledgerPath,
  runId,
  readLedger,
  appendLedgerEntry,
  recurringFindings,
  renderLedgerMarkdown,
} = require("./utils/ledger");
const { acquireRunLock, releaseRunLock, runLockPath } = require("./utils/runlock");

const ROOT = __dirname;

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Flags this runner passes straight through to gulp. They mean the same thing to
 * the task modules as they always have — the task modules read `process.argv`,
 * and the child process gets these appended to it.
 * @type {string[]}
 */
const PASS_THROUGH_FLAGS = ["--dry-run", "--force", "--chunked"];

/**
 * The gulp CLI entry point. Resolved by path rather than `require.resolve`,
 * because gulp's package `exports` map does not expose `./bin/gulp.js` — the file
 * is there, it is just not importable. Falling back to `npx gulp` keeps a
 * non-standard install working.
 * @returns {{command: string, prefixArgs: string[]}}
 */
function gulpCommand() {
  const local = path.join(ROOT, "node_modules", "gulp", "bin", "gulp.js");
  if (fs.existsSync(local)) return { command: process.execPath, prefixArgs: [local] };
  return { command: "npx", prefixArgs: ["gulp"] };
}

/**
 * How long one step may run before this runner kills it (INDEX_STEP_TIMEOUT_MS;
 * 0 = no bound, the default).
 *
 * The default is deliberately unbounded: a 17-volume overnight run legitimately
 * takes days, and the pipeline already bounds a single model call with
 * `AI_CALL_DEADLINE_MS` (an idle timeout — gotcha 26). A step-level wall clock
 * here would false-positive on a healthy long stage. Set it when you want a
 * hard ceiling on an unattended run.
 *
 * @returns {number} Milliseconds (0 = none).
 */
function stepTimeoutMs() {
  const n = parseInt(process.env.INDEX_STEP_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Which findings make this runner exit non-zero.
 *
 * `high` (default): a step that did not finish what it claims to have finished
 * fails the run. MEDIUM and LOW are reported. `medium` also fails on gaps;
 * `never` reports everything and exits 0 (useful while this is new and you are
 * learning which findings are real).
 *
 * @returns {"high"|"medium"|"never"}
 */
function failOnLevel() {
  const raw = String(process.env.POSTMORTEM_FAIL_ON || "high").trim().toLowerCase();
  return raw === "medium" || raw === "never" ? raw : "high";
}

/**
 * The file a step writes when it dies from a structural failure.
 *
 * `isStructuralError` is an in-process flag (`err.structural === true`), and a
 * child process cannot hand its error object back to this one. The gulpfile's
 * marker wrapper writes this file before rethrowing, so the "a structural failure
 * is never continued past" rule (gotcha 21) survives the process boundary instead
 * of being guessed at from exit codes or error text.
 *
 * @returns {string} Absolute path.
 */
function structuralMarkerPath() {
  return path.join(postMortemDir(), "last-structural-failure.json");
}

// ─── argv ─────────────────────────────────────────────────────────────────────

/**
 * Parse this runner's own argv, and separate it from the flags handed to gulp.
 *
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {{steps: Array<{name: string, run: Function}>, gulpArgs: string[], postMortem: boolean, ledger: boolean, failOn: string, list: boolean}}
 */
function parseArgs(argv) {
  const gulpArgs = [];
  let only = null;
  let postMortem = process.env.POSTMORTEM_ENABLED !== "false";
  let ledger = ledgerEnabled();
  let failOn = failOnLevel();
  let list = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--list") {
      list = true;
      continue;
    }
    if (arg === "--post-mortem=off" || arg === "--no-post-mortem") {
      postMortem = false;
      continue;
    }
    if (arg === "--post-mortem=on") {
      postMortem = true;
      continue;
    }
    if (arg.startsWith("--post-mortem=")) {
      postMortem = arg.endsWith("off") ? false : true;
      continue;
    }
    if (arg === "--ledger=off" || arg === "--no-ledger") {
      ledger = false;
      continue;
    }
    if (arg === "--ledger=on") {
      ledger = true;
      continue;
    }
    if (arg.startsWith("--fail-on=")) {
      const v = arg.replace("--fail-on=", "");
      if (v === "high" || v === "medium" || v === "never") failOn = v;
      continue;
    }
    if (arg.startsWith("--stages=") || arg.startsWith("--steps=")) {
      only = arg.replace(/^--(stages|steps)=/, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (PASS_THROUGH_FLAGS.includes(arg)) {
      gulpArgs.push(arg);
      continue;
    }
    if (arg === "--volume" || arg.startsWith("--volume=")) {
      if (arg.startsWith("--volume=")) {
        gulpArgs.push("--volume", arg.replace("--volume=", ""));
      } else {
        gulpArgs.push("--volume", argv[i + 1] || "");
        i++;
      }
      continue;
    }
    // Anything else goes to gulp untouched. Unknown flags are its problem to
    // report, not this runner's to guess about.
    gulpArgs.push(arg);
  }

  let steps = PIPELINE_STEPS;
  if (only) {
    // The default run order is PIPELINE_STEPS, but any gulp task can be run
    // individually — verify-translate, retranslate and translation-report are real
    // steps that are not part of the default sequence. The universe of valid names
    // is utils/hooks.js TASKS, which test-postmortem.js pins against the artifact
    // manifest so a name cannot exist in one list and not the others.
    const byName = new Map(PIPELINE_STEPS.map((s) => [s.name, s]));
    for (const name of TASKS) {
      if (byName.has(name)) continue;
      const task = GULPFILE[name];
      if (typeof task === "function") byName.set(name, { name, run: task });
    }
    const chosen = only.map((name) => {
      const step = byName.get(name);
      if (!step) {
        throw new Error(
          `--stages: "${name}" is not a pipeline step. Known steps: ` +
            `${[...byName.keys()].join(", ")}.`
        );
      }
      return step;
    });
    steps = chosen;
  }

  return { steps, gulpArgs, postMortem, ledger, failOn, list };
}

// ─── Running one step ─────────────────────────────────────────────────────────

/**
 * Run one pipeline step in its own process.
 *
 * Awaited, never `spawnSync`. A synchronous spawn parks this process's event
 * loop for the child's whole life (gotcha 63 — where every stage hung until the
 * call deadline fired and the log blamed an endpoint that was actually blocked by
 * its own runner).
 *
 * Output is streamed live (an un-monitored run must be watchable) and buffered
 * (the digest and the report need it).
 *
 * @param {string} stepName - The gulp task name.
 * @param {string[]} gulpArgs - Flags to pass through.
 * @returns {Promise<{code: number|null, killed: boolean, output: string, structural: Object|null}>}
 */
function runStep(stepName, gulpArgs) {
  return new Promise((resolve) => {
    const marker = structuralMarkerPath();
    try {
      fs.rmSync(marker); // this step's outcome, not the previous step's
    } catch {}

    const { command, prefixArgs } = gulpCommand();
    const child = spawn(command, [...prefixArgs, stepName, ...gulpArgs], {
      cwd: ROOT,
      env: process.env,
    });

    let output = "";
    let killed = false;
    const capture = (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const timeoutMs = stepTimeoutMs();
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -2, killed: false, output: `${output}\nspawn error: ${err.message}`, structural: null });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      let structural = null;
      try {
        structural = JSON.parse(fs.readFileSync(marker, "utf8"));
      } catch {}
      resolve({ code: killed ? -1 : code, killed, output, structural });
    });
  });
}

/**
 * The last few lines of a step's output that actually explain something.
 *
 * A gulp failure prints a stack trace; what a human scanning an overnight run
 * needs is the error line. Same idea as the pipeline-loop test's digest.
 *
 * @param {string} output
 * @returns {string[]}
 */
function digestOf(output) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const interesting = lines.filter(
    (l) =>
      /\[error\]|Error:|FAILED|failed:|WARNING|structural|errored/i.test(l)
  );
  const picked = interesting.length ? interesting.slice(-6) : lines.slice(-3);
  return picked.map((l) => (l.length > 220 ? `${l.slice(0, 220)}…` : l));
}

// ─── Recording what this run did ──────────────────────────────────────────────

/**
 * Append this step's assessment to the run ledger.
 *
 * Deliberately non-fatal: the ledger is memory, not a gate. A run must not die because
 * its memory could not be written — but the failure is printed, because a run that
 * silently loses its memory is a run that cannot tell a repeat from a repair.
 *
 * @param {string} step
 * @param {Object} report - The `PostMortemReport` for this step, or null when the
 *   assessment itself could not run.
 * @param {{volume: string|null, structural: Object|null, stepOk: boolean}} ctx
 * @returns {{written: boolean, error: string|null}}
 */
function recordAssessment(step, report, ctx) {
  const counts = report && report.counts
    ? { HIGH: report.counts.HIGH, MEDIUM: report.counts.MEDIUM, LOW: report.counts.LOW }
    : { HIGH: 0, MEDIUM: 0, LOW: 0 };
  const findingKinds = report && Array.isArray(report.findings)
    ? [...new Set(report.findings.map((f) => f.kind))]
    : [];

  const note = ctx.structural
    ? `structural failure: ${ctx.structural.message}`
    : report && report.error
      ? `assessment could not run: ${report.error}`
      : ctx.stepOk === false
        ? "step exited non-zero"
        : undefined;

  const result = appendLedgerEntry({
    kind: "assessment",
    step,
    volume: ctx.volume || null,
    findings: counts,
    findingKinds,
    decidedBy: "runner",
    note,
  });

  if (result.error) console.error(`[index] ledger: ${result.error}`);
  return { written: result.written, error: result.error };
}

// ─── Running the steps ────────────────────────────────────────────────────────

/**
 * Say what an EARLIER run already saw, before this one starts.
 *
 * Free to know, and it changes what is worth doing: a finding class that a re-run never clears is
 * structural, and spending another intervention on it is the spinning the ledger exists to prevent.
 *
 * @param {boolean} runLedger
 * @param {string} thisRun
 * @returns {void}
 */
function reportPriorRuns(runLedger, thisRun) {
  if (!runLedger) return;
  const prior = readLedger();
  if (prior.error) console.log(`[index] ledger: ${prior.error}`);
  for (const r of recurringFindings(prior.entries, thisRun)) {
    console.log(
      `[index] ledger: ${r.finding} has appeared in ${r.runs} recorded run(s) ` +
        `(${r.steps.join(", ")}) — a re-run is not clearing it`
    );
  }
}

/**
 * Which finding severities treat a step as failed, even when the step exited 0.
 *
 * @param {{counts: {HIGH: number, MEDIUM: number, LOW: number}}} report
 * @param {string} failOn - "high" (default) / "medium" / "never".
 * @returns {boolean}
 */
function failOnFindings(report, failOn) {
  if (failOn === "never") return false;
  if (failOn === "medium") return report.counts.HIGH + report.counts.MEDIUM > 0;
  return report.counts.HIGH > 0;
}

/**
 * Assess one finished step (the post-mortem), and never let the assessment itself be the failure:
 * a check that cannot run is reported as such, with an empty report behind it.
 *
 * @param {string} stepName
 * @param {{seriesDir: string, volumeArg: string|null, outDir: string}} ctx
 * @returns {Promise<Object>} The post-mortem report (possibly carrying `error`).
 */
async function assessStep(stepName, { seriesDir, volumeArg, outDir }) {
  try {
    const report = await runPostMortem({ step: stepName, seriesDir, volumeArg });
    await writePostMortemReport(report, outDir);
    return report;
  } catch (err) {
    return {
      step: stepName,
      ok: false,
      findings: [],
      counts: { HIGH: 0, MEDIUM: 0, LOW: 0, volumes: 0, checked: 0 },
      markdown: "",
      error: `the assessment itself failed: ${err.message}`,
    };
  }
}

/**
 * Print one assessment: the counts, the report's location, and the findings a reader can act on
 * (capped, because a step that broke everywhere produces hundreds).
 *
 * @param {string} stepName
 * @param {Object} report
 * @param {string} outDir
 * @returns {void}
 */
function reportAssessment(stepName, report, outDir) {
  const { HIGH, MEDIUM, LOW } = report.counts;
  console.log(
    `[index] ${stepName} post-mortem — ${report.ok ? "CLEAN" : "FINDINGS"} ` +
      `(${HIGH} HIGH, ${MEDIUM} MEDIUM, ${LOW} LOW) — ${path.relative(ROOT, path.join(outDir, `${stepName}.md`))}`
  );
  if (report.error) console.log(`[index]   assessment could not run: ${report.error}`);
  for (const f of report.findings.slice(0, 12)) {
    console.log(`[index]   [${f.severity}] ${f.volume ? `v${f.volume} ` : ""}${f.file} — ${f.kind}`);
  }
  if (report.findings.length > 12) {
    console.log(`[index]   … ${report.findings.length - 12} more (see the report)`);
  }
}

/**
 * Record what this step left behind, then ask the free question: did a PREVIOUS run leave the same
 * thing? A finding class that survives a re-run is structural, and the answer changes what the
 * delivery stage should spend on it.
 *
 * @param {string} stepName
 * @param {Object|null} report
 * @param {{volumeArg: string|null, structural: Object|null, stepOk: boolean, runLedger: boolean, thisRun: string}} ctx
 * @returns {void}
 */
function recordStepAssessment(stepName, report, ctx) {
  if (!ctx.runLedger) return;
  const recorded = recordAssessment(stepName, report, {
    volume: ctx.volumeArg,
    structural: ctx.structural,
    stepOk: ctx.stepOk,
  });
  if (!recorded.written) return;
  for (const r of recurringFindings(readLedger().entries, ctx.thisRun)) {
    if (!r.steps.includes(stepName)) continue;
    console.log(
      `[index]   ledger: ${r.finding} also appeared in ${r.runs - 1} earlier recorded ` +
        `run(s) on ${stepName} — re-running this step is not clearing it`
    );
  }
}

/**
 * Run one step, assess it, and decide whether the run continues.
 *
 * @param {{name: string, run: Function}} step
 * @param {{gulpArgs: string[], failOn: string, runAssessment: boolean, runLedger: boolean, seriesDir: string, volumeArg: string|null, outDir: string, thisRun: string}} ctx
 * @returns {Promise<{entry: Object, stop: boolean}>} `stop` is why the loop breaks: a structural
 *   failure (never continued past, whatever ON_TASK_ERROR says — the remaining steps are guaranteed
 *   to fail on the same missing foundation, and each attempt costs a model container switch, gotcha
 *   21) or a failed step under ON_TASK_ERROR=abort.
 */
async function runOneStep(step, ctx) {
  const started = Date.now();
  console.log(`\n[index] === ${step.name} ===`);

  const run = await runStep(step.name, ctx.gulpArgs);
  const stepOk = run.code === 0;
  const entry = { name: step.name, ok: stepOk, code: run.code, structural: run.structural };

  for (const line of digestOf(run.output)) console.log(`[index]   ${line}`);
  console.log(
    `[index] ${step.name} — ${stepOk ? "ok" : `FAILED (exit ${run.code}${run.killed ? ", killed on timeout" : ""})`}` +
      ` — ${((Date.now() - started) / 1000).toFixed(1)}s`
  );

  if (!stepOk && run.structural) {
    entry.ok = false;
    entry.structural = run.structural;
    console.error(
      `[index] ${step.name} failed STRUCTURALLY (${run.structural.message}) — ` +
        `stopping. The remaining steps depend on what this step did not build.`
    );
    recordStepAssessment(step.name, null, {
      volumeArg: ctx.volumeArg,
      structural: run.structural,
      stepOk,
      runLedger: ctx.runLedger,
      thisRun: ctx.thisRun,
    });
    return { entry, stop: true };
  }

  // Assess BEFORE the next step starts. That is the whole point of running the pipeline a step at a
  // time: a broken glossary is found here, not after the translation stage has already paid for it.
  if (ctx.runAssessment) {
    const report = await assessStep(step.name, ctx);
    entry.findings = report;
    reportAssessment(step.name, report, ctx.outDir);

    if (failOnFindings(report, ctx.failOn)) {
      entry.ok = false;
      console.error(
        `[index] ${step.name} left findings at or above the fail-on level ` +
          `(${ctx.failOn}) — treating the step as failed.`
      );
    }

    recordStepAssessment(step.name, report, {
      volumeArg: ctx.volumeArg,
      structural: null,
      stepOk,
      runLedger: ctx.runLedger,
      thisRun: ctx.thisRun,
    });
  }

  if (!entry.ok) {
    const onTaskError = String(process.env.ON_TASK_ERROR || "abort").trim().toLowerCase();
    if (onTaskError !== "continue") {
      console.error(
        `[index] stopping (ON_TASK_ERROR=abort). Later steps build on what this step ` +
          `did not produce.`
      );
      return { entry, stop: true };
    }
    console.error(
      `[index] ${step.name} failed — continuing with the remaining steps ` +
        `(ON_TASK_ERROR=continue).`
    );
  }

  return { entry, stop: false };
}

/**
 * The run's summary: one line per step, the reports' location, and the ledger's account of this run.
 *
 * @param {Object[]} results
 * @param {{stopped: boolean, outDir: string, runLedger: boolean, thisRun: string}} ctx
 * @returns {void}
 */
function printSummary(results, { stopped, outDir, runLedger, thisRun }) {
  const totalFindings = results.reduce((n, r) => n + (r.findings ? r.findings.findings.length : 0), 0);

  console.log(`\n[index] === summary ===`);
  for (const r of results) {
    const f = r.findings
      ? ` — post-mortem ${r.findings.counts.HIGH}H/${r.findings.counts.MEDIUM}M/${r.findings.counts.LOW}L`
      : "";
    const why = r.structural ? " (structural)" : "";
    console.log(`[index]   ${r.name}: ${r.ok ? "ok" : "FAILED"}${f}${why}`);
  }
  if (stopped) console.log(`[index]   (stopped early — later steps did not run)`);
  if (totalFindings > 0) console.log(`[index]   reports: ${path.relative(ROOT, outDir)}/`);

  if (!runLedger) return;
  const ledger = readLedger();
  if (ledger.error) console.log(`[index]   ledger: ${ledger.error}`);
  console.log(`[index]   ${renderLedgerMarkdown(ledger.entries, thisRun).trimEnd()}`);
}

/**
 * The last act of a failed run: name the steps that failed, and say what to do about them — which
 * depends on whether the ledger has seen these findings before.
 *
 * The advice used to be unconditional: "re-run, it is cheap". When the ledger shows this run's
 * findings also survived an earlier run, that advice IS the spinning this file exists to stop.
 *
 * @param {Object[]} results
 * @param {{runLedger: boolean, thisRun: string}} ctx
 * @returns {number} The process exit code.
 */
function exitForFailures(results, { runLedger, thisRun }) {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return 0;
  const recurring = runLedger ? recurringFindings(readLedger().entries, thisRun) : [];
  console.error(
    `[index] ${failed.length} of ${results.length} step(s) failed: ` +
      `${failed.map((f) => f.name).join(", ")}. ` +
      (recurring.length
        ? `Re-running has NOT cleared: ${recurring.map((r) => r.finding).join(", ")} ` +
          `(seen in ${recurring[0].runs} recorded runs). A repeat of an action that already ` +
          `failed is not a repair — read the reports before running again.`
        : `Re-run (the idempotent skip-checks make a re-run cheap) — the steps that ` +
          `finished are not repeated.`)
  );
  return 1;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Run the pipeline step by step, assessing each step before starting the next.
 *
 * The run lock is taken by `main`, not here: this function is the work, and the question
 * "is somebody else already doing it" has to be answered before any of it starts.
 *
 * @param {{steps: Array<{name: string, run: Function}>, gulpArgs: string[], postMortem: boolean,
 *   ledger: boolean, failOn: string}} parsed
 * @returns {Promise<number>} The process exit code.
 */
async function runPipelineSteps(parsed) {
  const dryRun = parsed.gulpArgs.includes("--dry-run");
  const volumeArg = (() => {
    const i = parsed.gulpArgs.indexOf("--volume");
    return i !== -1 ? parsed.gulpArgs[i + 1] || null : null;
  })();
  const seriesDir = process.env.SERIES_LOCATION || "";
  const runAssessment = parsed.postMortem && !dryRun;
  const runLedger = parsed.ledger && !dryRun;
  const outDir = postMortemDir();
  const thisRun = runId();

  console.log(
    `[index] ${parsed.steps.length} step(s): ${parsed.steps.map((s) => s.name).join(" -> ")}`
  );
  console.log(
    `[index] post-mortem: ${runAssessment ? "on" : dryRun ? "off (dry-run)" : "off"} | ` +
      `ledger: ${runLedger ? `on (${path.relative(ROOT, ledgerPath())})` : dryRun ? "off (dry-run)" : "off"} | ` +
      `fail-on: ${parsed.failOn} | flags: ${parsed.gulpArgs.join(" ") || "(none)"}`
  );

  // What an EARLIER run already saw, printed before this one spends anything.
  reportPriorRuns(runLedger, thisRun);

  /** @type {Array<{name: string, ok: boolean, code: number|null, findings?: Object, structural?: Object|null}>} */
  const results = [];
  let stopped = false;

  const ctx = {
    gulpArgs: parsed.gulpArgs,
    failOn: parsed.failOn,
    runAssessment,
    runLedger,
    seriesDir,
    volumeArg,
    outDir,
    thisRun,
  };

  for (const step of parsed.steps) {
    const { entry, stop } = await runOneStep(step, ctx);
    results.push(entry);
    if (stop) {
      stopped = true;
      break;
    }
  }

  printSummary(results, { stopped, outDir, runLedger, thisRun });
  return exitForFailures(results, { runLedger, thisRun });
}

/**
 * The process entry point: answer "is a run already going?" before starting one.
 *
 * Two processes writing the same volume folder is how an artifact ends half-built by one and
 * half by the other, and nothing downstream can tell afterwards. The lock is the only way
 * either process can know (gotcha 66 — the whole design of this runner is that a step is a
 * process, so the thing that must not overlap is also a process).
 *
 * @returns {Promise<number>} The process exit code.
 */
async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.list) {
    console.log("Pipeline steps (gulp order):");
    for (const step of PIPELINE_STEPS) console.log(`  ${step.name}`);
    return 0;
  }

  // One run, one id, one lock. Each step runs in its own gulp process, and inheriting this
  // id is what lets those children see the lock as theirs rather than a rival's — and what
  // groups their ledger entries under the run that actually caused them.
  process.env.INDEX_RUN_ID = runId();

  const lock = acquireRunLock({ by: "index.js" });
  if (!lock.acquired && lock.lock) {
    console.error(
      `[index] refusing to start: ${lock.note || "a pipeline run is already in progress"}. ` +
        `If that run is not actually running, remove ${runLockPath()}. To run two series at ` +
        `once, give each its own POSTMORTEM_DIR — the reports and the lock live there, so ` +
        `they describe one run at a time.`
    );
    return 1;
  }
  if (!lock.acquired) {
    // The file could not be written. A bookkeeping file must not be the reason a 12-hour run
    // dies — but "nothing is preventing a second run" has to be said out loud, not swallowed.
    console.error(`[index] warning: ${lock.note}`);
  } else if (lock.note) {
    console.log(`[index] ${lock.note}`);
  }

  try {
    return await runPipelineSteps(parsed);
  } finally {
    releaseRunLock();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[index] ${err.message}`);
    process.exit(1);
  });

/**
 * index/steps.js — the walk: run a step, assess it, decide whether the run continues.
 *
 * Two rules the loop must not forget: a structural failure is never continued past (the
 * remaining steps are guaranteed to fail on the same missing foundation, and each attempt
 * costs a model container switch), and a step that failed is reported under its own name —
 * with different advice when the ledger says this run is repeating an earlier one.
 */

const path = require("path");

const { readLedger, recurringFindings, renderLedgerMarkdown, runId, ledgerPath } = require("../utils/ledger");
const { postMortemDir } = require("../utils/postmortem");
const { isStopping, stoppingSignal } = require("../utils/shutdown");
const { runStep, digestOf } = require("./run-step");
const {
  reportPriorRuns,
  failOnFindings,
  assessStep,
  reportAssessment,
  recordStepAssessment,
} = require("./assess");

const projectRoot = path.join(__dirname, ".."); // the runner's ROOT

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
  if (totalFindings > 0) console.log(`[index]   reports: ${path.relative(projectRoot, outDir)}/`);

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
      `ledger: ${runLedger ? `on (${path.relative(projectRoot, ledgerPath())})` : dryRun ? "off (dry-run)" : "off"} | ` +
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
    // A stopped child is not a failed step. Without this the runner treats the interruption as one
    // step going badly and cheerfully starts the next one while the account owner is trying to stop
    // the run (utils/shutdown.js).
    if (isStopping()) {
      console.log(
        `[index] this run was asked to stop (${stoppingSignal()}). ` +
          `${parsed.steps.length - results.length} step(s) were not started.`
      );
      stopped = true;
      break;
    }
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

module.exports = { runOneStep, printSummary, exitForFailures, runPipelineSteps };

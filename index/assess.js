/**
 * index/assess.js — what a finished step left behind, and what the ledger makes of it.
 *
 * The post-mortem runs here, between steps: a broken glossary is found before the translation
 * stage has already paid for it. Then the free question — did an EARLIER run leave the same
 * thing? — is asked, because a finding class that survives a re-run is structural, and that
 * changes what the delivery stage should spend on it.
 */

const path = require("path");

const { runPostMortem, writePostMortemReport } = require("../utils/postmortem");
const { appendLedgerEntry, readLedger, recurringFindings } = require("../utils/ledger");

const projectRoot = path.join(__dirname, ".."); // the runner's ROOT

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
      `(${HIGH} HIGH, ${MEDIUM} MEDIUM, ${LOW} LOW) — ${path.relative(projectRoot, path.join(outDir, `${stepName}.md`))}`
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

module.exports = {
  recordAssessment,
  reportPriorRuns,
  failOnFindings,
  assessStep,
  reportAssessment,
  recordStepAssessment,
};

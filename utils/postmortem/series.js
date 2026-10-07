/**
 * utils/postmortem/series.js — the series-root copies, and the audit's own verdict.
 *
 * The four cumulative artifacts are published at the series root for the translation stage to
 * read; a step that produced every volume copy but no root copy has not finished. The
 * consistency audit's PASS/FAIL is read from its report here, because the audit's verdict is
 * a fact about the deliverable the runner has to be able to see.
 */

const fs = require("fs");
const path = require("path");

const { finding, seriesArtifactPath } = require("./rules");
const { assessFile } = require("./file");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */

// ─── Series level ─────────────────────────────────────────────────────────────

/**
 * Read the consistency audit's own verdict out of its report.
 *
 * A FAIL verdict does not fail the audit task — the report IS the deliverable,
 * and `translate` is what refuses to start on it. That is exactly why it needs
 * to reach the finding list: an un-monitored run that continued past a FAIL is
 * a run that translated a book its own audit said not to translate.
 *
 * @param {string} reportFile - Absolute path to consistency-report.md.
 * @returns {Promise<string|null>} "PASS", "FAIL", or null when no verdict is printed.
 */
async function readConsistencyVerdict(reportFile) {
  const content = await fs.promises.readFile(reportFile, "utf8").catch(() => null);
  if (content === null) return null;
  const match = content.match(/\*\*(PASS|FAIL)\*\*/);
  return match ? match[1] : null;
}

/**
 * Assess the series-level expectations for a step.
 *
 * @param {Object} opts
 * @param {import("./artifacts").StepArtifactSpec} opts.spec
 * @param {string} opts.step
 * @param {string} opts.seriesDir
 * @returns {Promise<PostMortemFinding[]>}
 */
async function assessSeries({ spec, step, seriesDir }) {
  const findings = [];
  for (const expectation of spec.series) {
    const abs = seriesArtifactPath(expectation.name, seriesDir);
    const display = path.relative(seriesDir, abs) || expectation.name;
    const res = await assessFile(abs, expectation, step, null, display);
    if (res) findings.push(res);
  }

  if (step === "consistency-audit") {
    const verdict = await readConsistencyVerdict(seriesArtifactPath("consistency-report.md", seriesDir));
    if (verdict === "FAIL") {
      findings.push(
        finding(
          "HIGH",
          "audit-verdict-fail",
          step,
          null,
          "consistency-report.md",
          `the audit's own verdict is FAIL. The task succeeds (the report is the ` +
            `deliverable), but the translate task refuses to start on this — a run ` +
            `that continued past it translated a book its own audit said not to.`
        )
      );
    } else if (verdict === null) {
      findings.push(
        finding(
          "MEDIUM",
          "audit-verdict-missing",
          step,
          null,
          "consistency-report.md",
          `consistency-report.md prints no **PASS**/**FAIL** verdict, so nothing downstream ` +
            `can read the sign-off.`
        )
      );
    }
  }

  return findings;
}

module.exports = { readConsistencyVerdict, assessSeries };

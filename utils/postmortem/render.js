/**
 * utils/postmortem/render.js — the report a human reads, and where it goes.
 *
 * The Markdown is the deliverable of an assessment: findings grouped by severity, each naming
 * the volume and the file, so the reader can act without opening the JSON.
 */

const fs = require("fs");
const path = require("path");

const { postMortemDir: resolvePostMortemDir, ensureRunStateGitignore } = require("../../configs/run-state");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render a report as Markdown. Written for a human reading it at 7am after an
 * un-monitored run: the verdict first, then findings grouped by severity.
 *
 * @param {PostMortemReport} report
 * @returns {string}
 */
function renderPostMortemMarkdown(report) {
  const lines = [];
  lines.push(`# Post-mortem — ${report.step}`);
  lines.push("");
  lines.push(
    `**${report.ok ? "CLEAN" : "FINDINGS"}** — ${report.counts.HIGH} HIGH, ` +
      `${report.counts.MEDIUM} MEDIUM, ${report.counts.LOW} LOW ` +
      `(${report.counts.volumes} volume(s), ${report.counts.checked} expectation(s) checked)`
  );
  lines.push("");

  if (report.error) {
    lines.push(`> Assessment could not run: ${report.error}`);
    lines.push("");
  }

  if (report.findings.length === 0) {
    lines.push("Every file this step is expected to leave is present and has the shape it should.");
    lines.push("");
    return lines.join("\n");
  }

  for (const severity of ["HIGH", "MEDIUM", "LOW"]) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`## ${severity} (${group.length})`);
    lines.push("");
    for (const f of group) {
      const where = f.volume ? `volume ${f.volume} — ${f.file}` : f.file || "(series level)";
      lines.push(`- **${f.kind}** — ${where}`);
      lines.push(`  ${f.message}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Write a report to the post-mortem directory (Markdown + JSON sidecar).
 *
 * The JSON is the half a future diagnosis agent reads; the Markdown is the half a
 * human reads. Both are written because a finding nobody can read is a finding
 * that did not happen.
 *
 * @param {PostMortemReport} report
 * @param {string} outDir - Absolute directory (postMortemDir() — `<SERIES_LOCATION>/.run/postmortem`).
 * @returns {Promise<{markdown: string, json: string}>} The paths written.
 */
async function writePostMortemReport(report, outDir) {
  await fs.promises.mkdir(outDir, { recursive: true });
  ensureRunStateGitignore();
  const mdPath = path.join(outDir, `${report.step}.md`);
  const jsonPath = path.join(outDir, `${report.step}.json`);
  await fs.promises.writeFile(mdPath, report.markdown, "utf8");
  await fs.promises.writeFile(
    jsonPath,
    JSON.stringify(
      {
        step: report.step,
        ok: report.ok,
        error: report.error,
        counts: report.counts,
        findings: report.findings,
        writtenAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return { markdown: mdPath, json: jsonPath };
}

/**
 * The run's records directory: `POSTMORTEM_DIR`, else `<series>/.run/postmortem`.
 *
 * The step reports, the ledger, the ticket channel, the patch channel, the delivery plan and
 * the run lock all resolve their home through this one function, which is why moving the
 * run's memory next to the series is one change and not four. The resolution itself lives in
 * configs/run-state.js — this file is a split module, and a machine-state path built from its
 * own `__dirname` is how gotcha 80 happened.
 *
 * @returns {string} Absolute path.
 */
function postMortemDir() {
  return resolvePostMortemDir();
}

module.exports = { renderPostMortemMarkdown, writePostMortemReport, postMortemDir };

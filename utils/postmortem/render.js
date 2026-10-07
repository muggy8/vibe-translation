/**
 * utils/postmortem/render.js — the report a human reads, and where it goes.
 *
 * The Markdown is the deliverable of an assessment: findings grouped by severity, each naming
 * the volume and the file, so the reader can act without opening the JSON.
 */

const fs = require("fs");
const path = require("path");

// __dirname here is utils/postmortem, so the repo root is two levels up (AGENTS.md §3).
// postMortemDir() used to sit in utils/postmortem.js, where one ".." was enough; when the
// file moved into the folder the same expression started naming utils/.postmortem, and the
// whole run's machine state — reports, ledger, tickets, run lock — silently moved folder.
const projectRoot = path.resolve(__dirname, "..", "..");

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
 * @param {string} outDir - Absolute directory (`.postmortem/` by default).
 * @returns {Promise<{markdown: string, json: string}>} The paths written.
 */
async function writePostMortemReport(report, outDir) {
  await fs.promises.mkdir(outDir, { recursive: true });
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
 * The post-mortem output directory (`POSTMORTEM_DIR`, default `<repo>/.postmortem`).
 * Machine state, gitignored — like `.logs/` and `.dry-run/`.
 * @returns {string}
 */
function postMortemDir() {
  const dir = (process.env.POSTMORTEM_DIR || "").trim();
  return dir ? path.resolve(dir) : path.join(projectRoot, ".postmortem");
}

module.exports = { renderPostMortemMarkdown, writePostMortemReport, postMortemDir };

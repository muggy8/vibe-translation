/**
 * extract/reports.js — the extraction step's own records, written into the run's memory.
 *
 * Two files per run, both under `postMortemDir()` (`<SERIES_LOCATION>/.run/postmortem/`), because the
 * volume folders are the deliverable and the run's memory is not (`configs/run-state.js`):
 *
 *   `extraction-<NN>.md` / `.json`   — one volume: what was extracted or verified, the chapter list
 *                                      with titles and sizes, the pages the book declares as packaging
 *                                      and why they were left out, the image count, the pronunciation
 *                                      guide totals, and the audit's findings.
 *   `extraction-summary.md` / `.json` — the whole series in one table, so a change that hit one book
 *                                      is visible as a difference instead of as a rumour
 *                                      (`utils/source/plan/01-extraction-step.md` §5).
 *
 * WHY THE JSON SIDECAR. The Markdown is the half a human reads at 7am; the JSON is the half a later
 * slice queries — the glossary plan is waiting on these numbers, and a plan that has to re-parse a
 * Markdown table to get them is a plan that re-derives them by hand, which is exactly what §3 had to
 * do with a throwaway script.
 *
 * NO NEW VOLUME-FOLDER NAME. Nothing here is written into a volume folder, so the artifact vocabulary
 * (`utils/artifacts.js`, `intake/config.js` VOLUME_ARTIFACT_PATTERNS) does not grow and the intake's
 * "is this folder a book?" scan is never handed another Markdown file to mistake for one (gotcha 119).
 *
 * Part of the extract step (extract.js).
 */

const fs = require("fs").promises;
const path = require("path");

require("../types"); // JSDoc type definitions

const { assertWrote } = require("../utils/fs");
const { BUNDLE_SCHEMA_VERSION } = require("../utils/source/config");

/** @typedef {import("./bundle-state").BundleState} BundleState */
/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */

/**
 * @typedef {Object} ExtractionVolumeRecord
 * Everything the step learned about one volume, in the shape both reports render from.
 * @property {string} step - Always "extract": the step these records belong to.
 * @property {string} installment - The volume's installment number (or its folder name when it has none).
 * @property {string} folder - The volume folder.
 * @property {BundleState|null} action - What happened to its bundle, or null when the volume could not be read.
 * @property {string} sourceFile - The plan of record's source path, relative to the series folder.
 * @property {"text"|"epub"|null} sourceFormat - What the bundle layer actually opened.
 * @property {string|null} sourceFingerprint - sha256 of the source file.
 * @property {number|null} bundleSchema - The bundle cache's schema version (null for a plain-text source).
 * @property {{chapters: number, packaging: number, characters: number, guides: number, guideChars: number, images: number, HIGH: number, MEDIUM: number, findings: number}} counts
 *   The measurement the plan calls "info", plus the finding totals.
 * @property {Array<{id: string, title: string, file: string, chars: number|null, bodyChars: number|null, empty: boolean|null, syntheticTitle: boolean}>} chapters
 * @property {Array<{title: string, reason: string, pages: number, bodyChars: number, textChars: number}>} packaging
 * @property {PostMortemFinding[]} findings
 * @property {string|null} error - The volume's own failure, when resolving or auditing it threw.
 */

/**
 * A file-name-safe form of an installment number.
 *
 * Folder names are chosen by the intake agent and may hold anything a filesystem accepts; a report
 * name must not. Non-alphanumeric runs collapse to "-", which keeps `01` and `Test Story(01)` usable.
 *
 * @param {string} value - An installment number or a folder name.
 * @returns {string} The safe form.
 */
function safeReportKey(value) {
  const s = String(value || "").trim();
  if (!s) return "unknown";
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 64) || "unknown";
}

/**
 * The base name of one volume's extraction report.
 *
 * @param {string} installment - The volume's installment number (or folder name).
 * @returns {string} e.g. `extraction-01`
 */
function extractionReportBase(installment) {
  return `extraction-${safeReportKey(installment)}`;
}

/**
 * The Markdown a human reads for one volume.
 *
 * @param {ExtractionVolumeRecord} record
 * @returns {string}
 */
function renderVolumeReport(record) {
  const lines = [];
  lines.push(`# Extraction — volume ${record.installment} (${record.folder})`);
  lines.push("");

  if (record.error) {
    lines.push(`**FAILED** — the volume could not be extracted or audited.`);
    lines.push("");
    lines.push(`> ${record.error}`);
    lines.push("");
    lines.push(`Nothing downstream can be trusted about this volume until the archive opens.`);
    lines.push("");
    return lines.join("\n");
  }

  const c = record.counts;
  lines.push(
    `**${c.HIGH > 0 ? "HIGH FINDINGS" : c.MEDIUM > 0 ? "MEDIUM FINDINGS" : "CLEAN"}** — ` +
      `${c.HIGH} HIGH, ${c.MEDIUM} MEDIUM · ${c.chapters} chapter(s), ${c.packaging} packaging group(s), ` +
      `${c.characters.toLocaleString("en-US")} characters, ${c.guides.toLocaleString("en-US")} pronunciation ` +
      `guide(s) kept in the text, ` +
      `${c.images} image(s)`
  );
  lines.push("");
  lines.push(`- **What the step did:** ${record.action.label} — ${record.action.reason}`);
  lines.push(
    `- **Source:** \`${record.sourceFile}\` (${record.sourceFormat}, sha256 ` +
      `${String(record.sourceFingerprint || "unknown").slice(0, 12)}…, bundle schema ` +
      `${record.bundleSchema === null ? "n/a — plain text" : record.bundleSchema})`
  );
  lines.push(`- **Converter schema in force:** ${BUNDLE_SCHEMA_VERSION}`);
  lines.push("");

  lines.push(`## Chapters (${c.chapters})`);
  lines.push("");
  if (record.chapters.length === 0) {
    lines.push("None. The extraction produced no chapter at all.");
    lines.push("");
  } else {
    lines.push("| id | title | file | characters | body characters | empty |");
    lines.push("|---|---|---|---|---|---|");
    for (const s of record.chapters) {
      lines.push(
        `| ${s.id} | ${s.title || ""} | \`${s.file}\` | ${s.chars === null ? "—" : s.chars} | ` +
          `${s.bodyChars === null ? "—" : s.bodyChars} | ${s.empty === null ? "—" : s.empty ? "YES" : "no"} |`
      );
    }
    lines.push("");
  }

  lines.push(`## Pages the book declares as packaging (${c.packaging})`);
  lines.push("");
  if (record.packaging.length === 0) {
    lines.push("None recorded.");
    lines.push("");
  } else {
    lines.push("| title | pages | story characters | why it was left out |");
    lines.push("|---|---|---|---|");
    for (const p of record.packaging) {
      lines.push(`| ${p.title} | ${p.pages} | ${p.textChars} | ${p.reason} |`);
    }
    lines.push("");
  }

  lines.push(`## Findings (${c.findings})`);
  lines.push("");
  if (record.findings.length === 0) {
    lines.push("None. Every check the extraction layer can answer about this volume answered clean.");
    lines.push("");
    return lines.join("\n");
  }
  for (const severity of ["HIGH", "MEDIUM"]) {
    const group = record.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`### ${severity} (${group.length})`);
    lines.push("");
    for (const f of group) {
      lines.push(`- **${f.kind}** — \`${f.file}\``);
      lines.push(`  ${f.message}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * The JSON half of one volume's record — the half a later slice queries.
 *
 * @param {ExtractionVolumeRecord} record
 * @returns {string}
 */
function renderVolumeJson(record) {
  return (
    JSON.stringify(
      {
        step: record.step,
        volume: record.installment,
        folder: record.folder,
        action: record.action ? record.action.state : null,
        actionReason: record.action ? record.action.reason : null,
        sourceFile: record.sourceFile,
        sourceFormat: record.sourceFormat,
        sourceFingerprint: record.sourceFingerprint,
        bundleSchema: record.bundleSchema,
        converterSchema: BUNDLE_SCHEMA_VERSION,
        counts: record.counts,
        chapters: record.chapters,
        packaging: record.packaging,
        findings: record.findings,
        error: record.error,
        writtenAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Write one volume's report pair into the run's records.
 *
 * @param {Object} p
 * @param {ExtractionVolumeRecord} p.record
 * @param {string} p.outDir - `postMortemDir()`.
 * @returns {Promise<{markdown: string, json: string}>} The absolute paths written.
 */
async function writeVolumeReport({ record, outDir }) {
  const base = extractionReportBase(record.installment);
  const mdPath = path.join(outDir, `${base}.md`);
  const jsonPath = path.join(outDir, `${base}.json`);
  await fs.writeFile(mdPath, renderVolumeReport(record), "utf8");
  await fs.writeFile(jsonPath, renderVolumeJson(record), "utf8");
  await assertWrote([mdPath, jsonPath], "extract");
  return { markdown: mdPath, json: jsonPath };
}

/**
 * The one table across the volumes: the line that makes "this change hit one book" visible.
 *
 * @param {Object} p
 * @param {ExtractionVolumeRecord[]} p.records - Every volume the step attempted, in reading order.
 * @param {string} p.seriesName - The series name, for the heading.
 * @returns {string}
 */
function renderSeriesSummary({ records, seriesName }) {
  const totals = records.reduce(
    (acc, r) => {
      acc.chapters += r.counts.chapters;
      acc.packaging += r.counts.packaging;
      acc.characters += r.counts.characters;
      acc.guides += r.counts.guides;
      acc.images += r.counts.images;
      acc.HIGH += r.counts.HIGH;
      acc.MEDIUM += r.counts.MEDIUM;
      if (r.error) acc.failed += 1;
      return acc;
    },
    { chapters: 0, packaging: 0, characters: 0, guides: 0, images: 0, HIGH: 0, MEDIUM: 0, failed: 0 }
  );

  const lines = [];
  lines.push(`# Extraction — series summary (${seriesName})`);
  lines.push("");
  lines.push(
    `**${totals.HIGH > 0 ? "HIGH FINDINGS — THE RUN STOPS" : totals.MEDIUM > 0 ? "MEDIUM FINDINGS" : "CLEAN"}** — ` +
      `${records.length} volume(s), ${totals.chapters} chapter(s), ${totals.packaging} packaging group(s), ` +
      `${totals.characters.toLocaleString("en-US")} characters, ${totals.guides.toLocaleString("en-US")} ` +
      `pronunciation guide(s) ` +
      `kept in the text, ${totals.images} image(s) · ${totals.HIGH} HIGH, ${totals.MEDIUM} MEDIUM` +
      (totals.failed ? `, ${totals.failed} volume(s) could not be read` : "")
  );
  lines.push("");
  lines.push("| volume | folder | action | chapters | packaging | characters | guides | images | HIGH | MEDIUM |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of records) {
    lines.push(
      `| ${r.installment} | ${r.folder} | ${r.error ? "FAILED" : r.action.label} | ${r.counts.chapters} | ` +
        `${r.counts.packaging} | ${r.counts.characters} | ${r.counts.guides} | ${r.counts.images} | ` +
        `${r.counts.HIGH} | ${r.counts.MEDIUM} |`
    );
  }
  lines.push("");
  lines.push(
    "Per volume: the chapter list, the pages the book declares as packaging, the guide totals and the " +
      "findings are in `extraction-<volume>.md` beside this file."
  );
  lines.push("");

  const findings = records.flatMap((r) => r.findings);
  lines.push(`## Findings (${findings.length})`);
  lines.push("");
  if (findings.length === 0) {
    lines.push("None across the series.");
    lines.push("");
  }
  for (const severity of ["HIGH", "MEDIUM"]) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`### ${severity} (${group.length})`);
    lines.push("");
    for (const f of group) {
      lines.push(`- **volume ${f.volume === null ? "?" : f.volume}** · \`${f.file}\` · **${f.kind}** — ${f.message}`);
    }
    lines.push("");
  }

  const failed = records.filter((r) => r.error);
  if (failed.length > 0) {
    lines.push(`## Volumes that could not be read (${failed.length})`);
    lines.push("");
    for (const r of failed) lines.push(`- volume ${r.installment} (${r.folder}): ${r.error}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * The JSON half of the series summary.
 *
 * @param {Object} p
 * @param {ExtractionVolumeRecord[]} p.records
 * @param {string} p.seriesName
 * @returns {string}
 */
function renderSeriesJson({ records, seriesName }) {
  return (
    JSON.stringify(
      {
        step: "extract",
        seriesName,
        converterSchema: BUNDLE_SCHEMA_VERSION,
        volumes: records.map((r) => ({
          volume: r.installment,
          folder: r.folder,
          action: r.action ? r.action.state : null,
          sourceFile: r.sourceFile,
          sourceFormat: r.sourceFormat,
          sourceFingerprint: r.sourceFingerprint,
          bundleSchema: r.bundleSchema,
          counts: r.counts,
          findings: r.findings,
          error: r.error,
        })),
        totals: {
          volumes: records.length,
          HIGH: records.reduce((n, r) => n + r.counts.HIGH, 0),
          MEDIUM: records.reduce((n, r) => n + r.counts.MEDIUM, 0),
          chapters: records.reduce((n, r) => n + r.counts.chapters, 0),
          packaging: records.reduce((n, r) => n + r.counts.packaging, 0),
          characters: records.reduce((n, r) => n + r.counts.characters, 0),
          guides: records.reduce((n, r) => n + r.counts.guides, 0),
          images: records.reduce((n, r) => n + r.counts.images, 0),
        },
        writtenAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Write the series summary pair into the run's records.
 *
 * @param {Object} p
 * @param {ExtractionVolumeRecord[]} p.records
 * @param {string} p.seriesName
 * @param {string} p.outDir - `postMortemDir()`.
 * @returns {Promise<{markdown: string, json: string}>} The absolute paths written.
 */
async function writeSeriesSummary({ records, seriesName, outDir }) {
  const mdPath = path.join(outDir, "extraction-summary.md");
  const jsonPath = path.join(outDir, "extraction-summary.json");
  await fs.writeFile(mdPath, renderSeriesSummary({ records, seriesName }), "utf8");
  await fs.writeFile(jsonPath, renderSeriesJson({ records, seriesName }), "utf8");
  await assertWrote([mdPath, jsonPath], "extract");
  return { markdown: mdPath, json: jsonPath };
}

module.exports = {
  extractionReportBase,
  renderVolumeReport,
  renderVolumeJson,
  writeVolumeReport,
  renderSeriesSummary,
  renderSeriesJson,
  writeSeriesSummary,
};

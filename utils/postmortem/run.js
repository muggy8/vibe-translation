/**
 * utils/postmortem/run.js — the assessment itself: what one step was supposed to leave behind, and what it left.
 *
 * Deterministic, no model call, no writes. It reads the plan of record, the step's declared
 * outputs from utils/artifacts.js, and the volumes, and compares them with the disk. The
 * counts it returns are what the runner's fail-on rule and the ledger's recurring-finding
 * question are built on.
 */

const fs = require("fs");
const path = require("path");

const { finding } = require("./rules");
const { assessVolume } = require("./volume");
const { assessSeries } = require("./series");
const { renderPostMortemMarkdown } = require("./render");
const { specForStep } = require("../artifacts");
const { filterVolumesByInstallment } = require("../manifest");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */

// ─── The assessment ───────────────────────────────────────────────────────────

/**
 * Resolve the `when` predicates' inputs once per assessment.
 * @returns {import("./artifacts").ArtifactContext}
 */
function artifactContext() {
  return {
    researchEnabled: process.env.RESEARCH_ENABLED !== "false",
    verifyEnabled: process.env.VERIFY_TRANSLATE_ENABLED !== "false",
    volumeConsistencyEnabled: process.env.VOLUME_CONSISTENCY_ENABLED !== "false",
    polishVerifyEnabled: process.env.POLISH_VERIFY_ENABLED !== "false",
    installment: "",
  };
}

/**
 * Assess one finished pipeline step against the disk.
 *
 * Never throws for a reason the caller could act on: a missing plan of record or
 * an unreadable series folder comes back as a report with `error` set and
 * `ok: false`, because an assessment that could not run must never be mistaken
 * for an assessment that found nothing.
 *
 * @param {Object} opts
 * @param {string} opts.step - The gulp task name that just ran.
 * @param {string} opts.seriesDir - The live series folder (`SERIES_LOCATION`).
 * @param {import("../types").TranslationTargetManifest|null} [opts.manifest] - The plan of
 *   record. Omit it and the post-mortem reads it from disk.
 * @param {string|null} [opts.volumeArg] - The `--volume` filter, when the step ran on one volume.
 *   Series-root expectations are skipped for a single-volume run, because the tasks
 *   deliberately do not publish a stale series copy for one volume.
 * @returns {Promise<PostMortemReport>}
 */
async function runPostMortem({ step, seriesDir, manifest, volumeArg }) {
  /** @type {PostMortemFinding[]} */
  const findings = [];
  const spec = specForStep(step);

  if (!spec) {
    const report = {
      step,
      ok: false,
      findings: [
        finding(
          "HIGH",
          "step-undeclared",
          step,
          null,
          "",
          `step "${step}" has no entry in utils/artifacts.js, so nothing checks what it ` +
            `leaves behind. Declare it (or remove it from the pipeline).`
        ),
      ],
      counts: { HIGH: 1, MEDIUM: 0, LOW: 0, volumes: 0, checked: 0 },
      markdown: "",
    };
    report.markdown = renderPostMortemMarkdown(report);
    return report;
  }

  let plan = manifest;
  if (plan === undefined) {
    try {
      const raw = await fs.promises.readFile(path.join(seriesDir, "translation-target.json"), "utf8");
      plan = JSON.parse(raw);
    } catch (err) {
      const report = {
        step,
        ok: false,
        findings: [],
        counts: { HIGH: 0, MEDIUM: 0, LOW: 0, volumes: 0, checked: 0 },
        markdown: "",
        error: `no readable plan of record (${err.message}) — the post-mortem cannot ` +
          `assess a step whose volumes are not known`,
      };
      report.markdown = renderPostMortemMarkdown(report);
      return report;
    }
  }

  const ctx = artifactContext();
  let volumeEntries = plan.volumes || [];
  if (volumeArg) {
    const wanted = new Set(filterVolumesByInstallment(plan, volumeArg));
    volumeEntries = volumeEntries.filter((v) => wanted.has(v.folder));
  }

  let checked = 0;
  if (spec.perVolume) {
    for (const volumeEntry of volumeEntries) {
      const volumeFindings = await assessVolume({ spec, step, seriesDir, volumeEntry, ctx });
      findings.push(...volumeFindings);
      checked += spec.volume.length;
    }
  }
  if (!volumeArg) {
    const seriesFindings = await assessSeries({ spec, step, seriesDir });
    findings.push(...seriesFindings);
    checked += spec.series.length;
  }

  const counts = {
    HIGH: findings.filter((f) => f.severity === "HIGH").length,
    MEDIUM: findings.filter((f) => f.severity === "MEDIUM").length,
    LOW: findings.filter((f) => f.severity === "LOW").length,
    volumes: spec.perVolume ? volumeEntries.length : 0,
    checked,
  };

  const report = {
    step,
    ok: counts.HIGH === 0 && !findings.some((f) => f.kind === "step-undeclared"),
    findings,
    counts,
    markdown: "",
  };
  report.markdown = renderPostMortemMarkdown(report);
  return report;
}

module.exports = { artifactContext, runPostMortem };

/**
 * utils/postmortem.js — Deterministic assessment of what a pipeline step left behind.
 *
 * This is the question utils/artifacts.js writes down, asked against the disk:
 * "did this step produce the files this step always produces, in the shape those
 * files always have?" It is deliberately **deterministic** — no model call, no
 * network, no judgement about quality. It is the tier that can run on every
 * volume of every step for free, and it is the tier that would have caught
 * volume 04's `glossary.md` with nothing beside it (gotcha 64), the 457 vanished
 * terms, and the 164-character sentence that became a published artifact
 * (gotcha 58) — all of which passed every check the pipeline had.
 *
 * What it checks, per step:
 *   1. every expected file exists, at the right level of requiredness;
 *   2. a file that exists is not empty and not a scaffold stub;
 *   3. a `.json` file parses;
 *   4. a document has the shape its prompt specifies (a heading, or a table);
 *   5. quarantine files a gate left behind are reported, not silently accumulated;
 *   6. a volume folder holds no file the pipeline's own vocabulary does not
 *      recognise (the stale-stray class: gotcha 3);
 *   7. an acceptance state that was never actually accepted is named (the
 *      `ON_QA_LIMIT=accept` path publishes output no grader signed off);
 *   8. a chapter the handoff listed has no draft;
 *   9. the consistency audit's own verdict is carried into the finding list.
 *
 * What it deliberately does NOT do: decide whether an artifact is GOOD. That is
 * the scored gates' job, and moving it here would put a second, weaker version
 * of the grader next to the real one. This module only asks whether the step
 * finished, and whether the evidence it left is the evidence it always leaves.
 *
 * Findings are data, not thrown errors. The caller (index.js) decides what to do
 * with them; the post-mortem's job is to be honest and cheap.
 *
 * @module utils/postmortem
 */

const fs = require("fs");
const path = require("path");
require("../types"); // JSDoc type definitions
const { specForStep, isKnownVolumeFile } = require("./artifacts");
const { fileExists, isPlaceholderContent, hasDocumentShape } = require("./fs");
const { loadRollingState, isAcceptedState, seriesArtifactFile } = require("../configs/shared");
const { filterVolumesByInstallment } = require("./manifest");
const { isVolumeArtifact } = require("../get-translation-target");

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One thing the post-mortem found.
 *
 * @typedef {Object} PostMortemFinding
 * @property {"HIGH"|"MEDIUM"|"LOW"} severity - HIGH: the step did not finish what it
 *   claims to have finished. MEDIUM: a gap worth reading about. LOW: worth knowing,
 *   normally fine.
 * @property {string} kind - The stable machine-readable class (`missing-required`,
 *   `wrong-shape`, `unexpected-file`, …). A future diagnosis agent selects on this.
 * @property {string} step - The step being assessed.
 * @property {string|null} volume - The installment number, or null for a series-level finding.
 * @property {string} file - Path relative to the series folder (or the volume folder name
 *   for a folder-level finding).
 * @property {string} message - What is wrong, and what it probably means.
 */

/**
 * The assessment of one step.
 *
 * @typedef {Object} PostMortemReport
 * @property {string} step
 * @property {boolean} ok - True when no HIGH finding was raised.
 * @property {PostMortemFinding[]} findings
 * @property {{HIGH: number, MEDIUM: number, LOW: number, volumes: number, checked: number}} counts
 * @property {string} markdown - The human-readable report.
 * @property {string} [error] - Set when the assessment itself could not run (a missing
 *   plan of record). An assessment that could not run is never reported as clean.
 */

// ─── Shape rules ──────────────────────────────────────────────────────────────

/**
 * Whether text holds a Markdown table — a pipe row followed by a `|---|` separator.
 *
 * Kept separate from {@link hasDocumentShape} (heading OR table) because the
 * glossary is the one artifact whose whole contract IS a table: a glossary written
 * as prose has lost the structure every downstream reader parses.
 *
 * @param {string} content
 * @returns {boolean}
 */
function hasTableShape(content) {
  const lines = String(content || "").split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const row = lines[i].trim();
    const sep = lines[i + 1].trim();
    if (row.startsWith("|") && /^\|[\s|:-]+\|/.test(sep) && /-/.test(sep)) return true;
  }
  return false;
}

/**
 * Whether text satisfies one expectation's declared shape.
 *
 * @param {string} content - The file's contents.
 * @param {"document"|"table"|"json"|"any"} [shape]
 * @returns {boolean}
 */
function matchesShape(content, shape) {
  if (!shape || shape === "any") return true;
  if (shape === "table") return hasTableShape(content);
  if (shape === "document") return hasDocumentShape(content);
  if (shape === "json") {
    try {
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

// ─── Finding helpers ──────────────────────────────────────────────────────────

/**
 * Build one finding.
 *
 * @param {"HIGH"|"MEDIUM"|"LOW"} severity
 * @param {string} kind
 * @param {string} step
 * @param {string|null} volume
 * @param {string} file
 * @param {string} message
 * @returns {PostMortemFinding}
 */
function finding(severity, kind, step, volume, file, message) {
  return { severity, kind, step, volume, file, message };
}

/**
 * Where a series-root artifact actually lives. The four cumulative copies honour
 * `SERIES_ARTIFACTS_DIR` and their legacy per-file overrides, so looking for them
 * at the series root unconditionally would report a false "missing" on a machine
 * that moved them.
 *
 * @param {string} fileName
 * @param {string} seriesDir
 * @returns {string} Absolute path.
 */
function seriesArtifactPath(fileName, seriesDir) {
  const legacyKeys = {
    "glossary.md": "GLOSSARY_OUTPUT_FILE",
    "character-voice.md": "VOICE_OUTPUT_FILE",
    "style-guide.md": "STYLE_OUTPUT_FILE",
    "shared-wiki.md": "SHARED_WIKI_OUTPUT_FILE",
  };
  return seriesArtifactFile(fileName, legacyKeys[fileName] || "", seriesDir);
}

// ─── One file ─────────────────────────────────────────────────────────────────

/**
 * Assess one expected file. Returns a finding, or null when the file is what it
 * should be.
 *
 * @param {string} filePath - Absolute path.
 * @param {import("./artifacts").ArtifactExpectation} expectation
 * @param {string} step
 * @param {string|null} volume
 * @param {string} displayPath - The path to name in the finding.
 * @returns {Promise<PostMortemFinding|null>}
 */
async function assessFile(filePath, expectation, step, volume, displayPath) {
  let content;
  try {
    content = await fs.promises.readFile(filePath, "utf8");
  } catch {
    const severity = expectation.level === "required" ? "HIGH" : "MEDIUM";
    return finding(
      severity,
      expectation.level === "required" ? "missing-required" : "missing-expected",
      step,
      volume,
      displayPath,
      `${expectation.name} was never written${expectation.why ? ` — ${expectation.why}` : ""}`
    );
  }

  if (isPlaceholderContent(content)) {
    return finding(
      "HIGH",
      "empty-or-stub",
      step,
      volume,
      displayPath,
      `${expectation.name} exists but is empty or still holds a scaffold stub ` +
        `(${content.trim().length} chars). A stage wrote its scaffolding and never ` +
        `its output.`
    );
  }

  const shape = expectation.shape || "any";
  if (shape === "json") {
    try {
      JSON.parse(content);
    } catch (err) {
      return finding(
        "HIGH",
        "bad-json",
        step,
        volume,
        displayPath,
        `${expectation.name} is not parseable JSON (${err.message}). Every reader of ` +
          `this file parses it, so a half-written file is worse than a missing one.`
      );
    }
    return null;
  }

  if (!matchesShape(content, shape)) {
    return finding(
      "MEDIUM",
      "wrong-shape",
      step,
      volume,
      displayPath,
      `${expectation.name} is ${content.trim().length} chars but has no ` +
        `${shape === "table" ? "Markdown table" : "Markdown heading or table"}. ` +
        `The prompt that writes it specifies that shape, so this is not that document.`
    );
  }
  return null;
}

// ─── One volume ───────────────────────────────────────────────────────────────

/**
 * List the regular files in a folder (directories excluded — `images/` and the
 * epub extraction cache's image manifest are legitimate).
 *
 * A SHORTCUT counts as a file when it resolves to one, and does not when it
 * resolves to a folder or to nothing. `Dirent.isFile()` answers no for a shortcut,
 * and a staged book is now usually a shortcut: without this, a stray shortcut in a
 * volume folder would be invisible to the check that exists to report stale
 * leftovers, and "the folder holds exactly what the pipeline writes" would stop
 * being a question anyone could answer.
 *
 * @param {string} dir
 * @returns {Promise<string[]>} Sorted file names, or null when the folder is absent.
 */
async function listFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = [];
  for (const e of entries) {
    if (e.isFile()) {
      names.push(e.name);
      continue;
    }
    if (!e.isSymbolicLink()) continue;
    try {
      if ((await fs.promises.stat(path.join(dir, e.name))).isFile()) names.push(e.name);
    } catch {
      /* a broken shortcut is not a file — reported by the source-existence check, not here */
    }
  }
  return names.sort();
}

/**
 * Assess every expectation for one volume folder.
 *
 * @param {Object} opts
 * @param {import("./artifacts").StepArtifactSpec} opts.spec
 * @param {string} opts.step
 * @param {string} opts.seriesDir
 * @param {import("../types").TranslationTargetVolume} opts.volumeEntry
 * @param {import("./artifacts").ArtifactContext} opts.ctx
 * @returns {Promise<PostMortemFinding[]>}
 */
async function assessVolume({ spec, step, seriesDir, volumeEntry, ctx }) {
  const findings = [];
  const installment = volumeEntry.installmentNumber;
  const volumeDir = path.join(seriesDir, volumeEntry.folder);
  const names = await listFiles(volumeDir);

  if (names === null) {
    findings.push(
      finding(
        "HIGH",
        "missing-volume-folder",
        step,
        installment,
        volumeEntry.folder,
        `the volume folder ${volumeEntry.folder} does not exist — the plan of record ` +
          `lists a volume the pipeline has nowhere to write`
      )
    );
    return findings;
  }

  // 1–4: the declared expectations.
  const volumeCtx = { ...ctx, installment };
  for (const expectation of spec.volume) {
    if (expectation.when && !expectation.when(volumeCtx)) continue;
    const name = expectation.name.replace("{installment}", installment);
    const res = await assessFile(
      path.join(volumeDir, name),
      { ...expectation, name },
      step,
      installment,
      `${volumeEntry.folder}/${name}`
    );
    if (res) findings.push(res);
  }

  // 5: quarantine files a gate left behind.
  for (const q of spec.quarantines) {
    for (const name of names) {
      if (q.pattern.test(name)) {
        findings.push(
          finding(
            q.severity,
            "quarantine-present",
            step,
            installment,
            `${volumeEntry.folder}/${name}`,
            `${name} is present: ${q.meaning}`
          )
        );
      }
    }
  }

  // 6: files the pipeline's own vocabulary does not recognise.
  const sourceName = path.basename(String(volumeEntry.sourceFile || ""));
  for (const name of names) {
    if (name === sourceName) continue; // the staged book itself
    if (isVolumeArtifact(name)) continue; // known pipeline output
    if (isKnownVolumeFile(name)) continue; // source parts, cache, kept evidence
    findings.push(
      finding(
        "LOW",
        "unexpected-file",
        step,
        installment,
        `${volumeEntry.folder}/${name}`,
        `${name} is in the volume folder but is not a file this pipeline writes and ` +
          `is not this volume's source. Stale output gets audited as if it were current.`
      )
    );
  }

  // 7: an acceptance state that was never accepted.
  for (const expectation of spec.volume) {
    if (expectation.shape !== "json" || !expectation.name.endsWith("-rolling-state.json")) continue;
    const name = expectation.name.replace("{installment}", installment);
    const state = await loadRollingState(path.join(volumeDir, name));
    if (state && !isAcceptedState(state)) {
      const scores = (state.results || []).join(", ");
      findings.push(
        finding(
          "MEDIUM",
          "accepted-without-acceptance",
          step,
          installment,
          `${volumeEntry.folder}/${name}`,
          `the rolling window [${scores}] never met the acceptance criterion, and the ` +
            `volume was published anyway (ON_QA_LIMIT=accept). No grader signed this off.`
        )
      );
    }
  }

  // 8: a chapter the handoff listed has no draft.
  if (spec.volume.some((e) => e.name === "translation-state.json")) {
    findings.push(...(await assessChapterCoverage(volumeDir, volumeEntry.folder, installment, step)));
  }

  return findings;
}

/**
 * Cross-check the handoff's chapter list against what the translation stage produced.
 *
 * A chapter the book has and the pipeline skipped is the difference between "a
 * hole in the book" (EMPTY IN SOURCE — fine) and "a hole in the run" (MISSING —
 * not fine). The reports already label both; nothing checked them against each
 * other at the volume level.
 *
 * @param {string} volumeDir
 * @param {string} folder
 * @param {string} installment
 * @param {string} step
 * @returns {Promise<PostMortemFinding[]>}
 */
async function assessChapterCoverage(volumeDir, folder, installment, step) {
  const findings = [];
  let chapters;
  try {
    chapters = JSON.parse(await fs.promises.readFile(path.join(volumeDir, "chapters.json"), "utf8"));
  } catch {
    return findings; // no handoff list — already reported by the expectation that wants it
  }
  if (!Array.isArray(chapters) || chapters.length === 0) return findings;

  let state = {};
  try {
    state = JSON.parse(await fs.promises.readFile(path.join(volumeDir, "translation-state.json"), "utf8")) || {};
  } catch {
    return findings; // already reported as missing-required / bad-json
  }

  for (const chapter of chapters) {
    if (!chapter || !chapter.id) continue;
    if (chapter.empty === true) continue; // a hole in the BOOK, reported as EMPTY IN SOURCE
    const draft = `translation-${chapter.id}.md`;
    if (await fileExists(path.join(volumeDir, draft))) continue;
    const entry = state[chapter.id];
    if (entry && (entry.draftHash || entry.qaFailed)) continue; // repaired, or kept as a repair target
    findings.push(
      finding(
        "MEDIUM",
        "chapter-without-draft",
        step,
        installment,
        `${folder}/translation-${chapter.id}.md`,
        `the handoff lists chapter ${chapter.id}${chapter.title ? ` ("${chapter.title}")` : ""} ` +
          `with ${chapter.bodyChars ?? chapter.chars ?? "?"} characters of source, and the ` +
          `translation stage produced no draft and recorded no state for it.`
      )
    );
  }
  return findings;
}

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
  return dir ? path.resolve(dir) : path.resolve(__dirname, "..", ".postmortem");
}

module.exports = {
  runPostMortem,
  writePostMortemReport,
  renderPostMortemMarkdown,
  postMortemDir,
  hasTableShape,
  matchesShape,
  readConsistencyVerdict,
};

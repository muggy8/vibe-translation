/**
 * consistency-audit.js — Logic for the "consistency-audit" gulp task: the
 * final cross-artifact consistency check before a series goes to translation.
 *
 * Task: consistency-audit
 *   After the four pre-production tasks (glossary, character-voice,
 *   style-guide, jump-in-wiki) have published their series-root artifacts,
 *   an audit agent (gated fs tools, cwd = the series root) reads:
 *     - <SERIES_LOCATION>/glossary.md
 *     - <SERIES_LOCATION>/character-voice.md
 *     - <SERIES_LOCATION>/style-guide.md
 *     - <SERIES_LOCATION>/shared-wiki.md
 *   and writes <SERIES_LOCATION>/consistency-report.md — the pre-translation
 *   sign-off (PASS/FAIL verdict + severity-banded findings with quoted
 *   snippets). The four artifacts are read-only to the agent; only the
 *   report is written.
 *
 * No QA loop: this is a one-shot audit over the final state, not an
 * iteratively-built artifact. If the verdict is FAIL the task logs it loudly
 * and still keeps the report (the report IS the deliverable — a fixer re-runs
 * the offending task(s), then `--force` re-audits).
 *
 * Idempotent: after each audit a provenance sidecar
 * (consistency-report.md.provenance.json) records the sha256 of all four
 * artifacts. The report is skipped while all four fingerprints still match —
 * a fingerprint check, not a timestamp check, so a restored/touched artifact
 * (old mtime, backup copy) can never trick a stale report into passing.
 * Reports from before the sidecar existed fall back to the legacy
 * "report newer than all artifacts" mtime check (unless --force).
 * If an artifact is missing the task fails loudly
 * (name the task to run) — an audit over fewer than four artifacts is not a
 * sign-off.
 *
 * Usage:
 *   npx gulp consistency-audit             # run the audit
 *   npx gulp consistency-audit --dry-run   # transform the prompts only, no API call
 *   npx gulp consistency-audit --force     # re-audit even if the report is fresh
 */

// .env, then the one setting that has a default — both before any task module is
// required, because several of them read these values at require time (gotcha 79).
require("./configs/env-defaults").bootstrapEnv();
const fs = require("fs").promises;
const path = require("path");
require("./types");
const harness = require("./harness");
const { transformUserPrompt, writePromptDump } = require("./utils/prompt");
const { AGENT_TOOLS_NOTE, validateRequiredEnv, resolveRunSettings, structuralError } = require("./configs/shared");
const { fileExists, assertWrote } = require("./utils/fs");
const { emittedToolCallAsText, assertRealToolCalls } = require("./utils/agents");
const { getTranslationTarget } = require("./get-translation-target");
const { readRunArgs } = require("./utils/series-run");
const { sha256OfFile } = require("./utils/source");

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const systemPromptFile = path.join(clientDir, "system-prompts", "consistency-audit.md");
const userPromptTemplateFile = path.join(clientDir, "user-prompts", "consistency-audit.md");

// The four series-level artifacts under audit (file, human name). All four
// must exist — the audit is a sign-off, not a partial check.
const AUDIT_ARTIFACTS = [
  ["glossary.md", "the glossary"],
  ["character-voice.md", "the character voice reference"],
  ["style-guide.md", "the style guide"],
  ["shared-wiki.md", "the shared wiki"],
];
const REPORT_FILE = "consistency-report.md";
/** The audit provenance sidecar, next to the report (fingerprint of the four audited artifacts). */
const PROVENANCE_FILE = `${REPORT_FILE}.provenance.json`;
const MAX_STEPS = 40;

// The malformed-tool-call guard (emittedToolCallAsText + assertRealToolCalls)
// is shared by every file-writing task — see utils/agents.js (AGENTS.md
// gotcha 18). This module calls assertRealToolCalls(result, who) without a
// volume label (the audit is series-root, not per-volume).

/**
 * Build the audit turn prompt (pure — testable without the filesystem).
 *
 * @param {{userPrompt: string, values: Object}} p - The raw user template and
 *   its placeholder values.
 * @returns {string} The filled-in turn prompt.
 */
function buildAuditTurnPrompt(p) {
  return transformUserPrompt(p.userPrompt, p.values);
}

/**
 * Hash the four audited artifacts (deterministic, no AI). Called AFTER the
 * audit agent runs, so the fingerprints describe the state the report signs
 * off (the artifacts are read-only to the agent; if it violated that, the
 * post-audit hash still matches what is on disk when the skip-check runs).
 *
 * @param {string} seriesDir - The SERIES_LOCATION directory.
 * @returns {Promise<Object<string, string>>} Artifact file name → sha256.
 */
async function hashAuditArtifacts(seriesDir) {
  const hashes = {};
  for (const [file] of AUDIT_ARTIFACTS) {
    hashes[file] = await sha256OfFile(path.join(seriesDir, file));
  }
  return hashes;
}

/**
 * Write the audit provenance sidecar next to the report (best-effort — a
 * failure warns but never fails the task, same contract as
 * writeProvenanceSidecar in utils/fs.js: the report is the deliverable).
 *
 * @param {string} reportFile - Absolute path of consistency-report.md.
 * @param {Object<string, string>} artifactHashes - Artifact name → sha256.
 * @returns {Promise<void>}
 */
async function writeAuditProvenance(reportFile, artifactHashes) {
  try {
    const sidecar = {
      report: path.basename(reportFile),
      auditedAt: new Date().toISOString(),
      artifactHashes,
    };
    await fs.writeFile(
      `${reportFile}.provenance.json`,
      JSON.stringify(sidecar, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    console.warn(
      `[provenance] could not write the audit sidecar for ${reportFile} (${err.message}) — continuing.`
    );
  }
}

/**
 * Load the audit provenance sidecar. Returns null when it is missing or
 * corrupt (fail-open: the caller falls back to the legacy mtime check, so a
 * broken sidecar never blocks a run — worst case it re-audits).
 *
 * @param {string} reportFile - Absolute path of consistency-report.md.
 * @returns {Promise<Object|null>} The sidecar ({artifactHashes, ...}) or null.
 */
async function loadAuditProvenance(reportFile) {
  try {
    const raw = await fs.readFile(`${reportFile}.provenance.json`, "utf8");
    const sidecar = JSON.parse(raw);
    if (!sidecar || typeof sidecar.artifactHashes !== "object" || sidecar.artifactHashes === null) {
      return null;
    }
    return sidecar;
  } catch {
    return null;
  }
}

/**
 * Pure: does the sidecar's fingerprint match the current artifacts EXACTLY?
 * (Every one of the four artifacts must be present in the sidecar with an
 * identical hash — a missing entry counts as a mismatch.)
 *
 * @param {Object|null} sidecar - The provenance sidecar (or null).
 * @param {Object<string, string>} currentHashes - Current artifact name → sha256.
 * @returns {boolean} True when all four fingerprints match.
 */
function provenanceMatches(sidecar, currentHashes) {
  if (!sidecar) return false;
  for (const [file] of AUDIT_ARTIFACTS) {
    if (sidecar.artifactHashes[file] !== currentHashes[file]) return false;
  }
  return true;
}

/**
 * All four series-root artifacts must exist: the audit is a sign-off over the full set, not a
 * partial check. The error names the task to run for each one, because "run the pipeline" is not an
 * instruction an operator can act on at 3am.
 *
 * @param {string} seriesDir
 * @returns {Promise<void>}
 * @throws {Error} Naming every missing artifact and the task that produces it.
 */
async function requireAuditArtifacts(seriesDir) {
  const missing = (
    await Promise.all(
      AUDIT_ARTIFACTS.map(async ([file, name]) =>
        (await fileExists(path.join(seriesDir, file))) ? null : [file, name]
      )
    )
  ).filter(Boolean);
  if (missing.length === 0) return;
  throw new Error(
    `Cannot run the consistency audit — missing series-root artifact(s): ` +
      `${missing.map(([file, name]) => `${file} (${name})`).join(", ")}. ` +
      `Run the corresponding pre-production task(s) first (glossary / ` +
      `character-voice / style-guide / jump-in-wiki) and re-run the pipeline.`
  );
}

/**
 * Whether the existing report still signs off the state on disk — a content check, not a timestamp
 * check, so a restored or touched artifact (old mtime, backup copy) can never trick a stale report
 * into passing. Reports from before the provenance sidecar existed (or with a corrupt one) fall back
 * to the legacy "report newer than all artifacts" mtime check. No AI call.
 *
 * @param {string} reportFile
 * @param {string} seriesDir
 * @returns {Promise<boolean>} True when the audit can be skipped.
 */
async function auditIsFresh(reportFile, seriesDir) {
  const currentHashes = await hashAuditArtifacts(seriesDir);
  const sidecar = await loadAuditProvenance(reportFile);

  if (sidecar) {
    if (provenanceMatches(sidecar, currentHashes)) {
      console.log(
        `consistency-report.md fingerprints all four artifacts — skipping ` +
          `(use --force to re-audit).`
      );
      return true;
    }
    const stale = AUDIT_ARTIFACTS.filter(
      ([file]) => sidecar.artifactHashes[file] !== currentHashes[file]
    ).map(([file]) => file);
    console.log(
      `consistency-report.md is stale (changed artifact(s): ${stale.join(", ")}) — re-auditing.`
    );
    return false;
  }

  const reportMtime = (await fs.stat(reportFile)).mtimeMs;
  const staleInputs = (
    await Promise.all(
      AUDIT_ARTIFACTS.map(async ([file]) => {
        const st = await fs.stat(path.join(seriesDir, file));
        return st.mtimeMs > reportMtime ? file : null;
      })
    )
  ).filter(Boolean);
  if (staleInputs.length === 0) {
    console.log(
      `consistency-report.md is newer than all four artifacts (no provenance sidecar — legacy check) — skipping ` +
        `(use --force to re-audit).`
    );
    return true;
  }
  console.log(
    `consistency-report.md is stale (newer artifact(s): ${staleInputs.join(", ")}) — re-auditing.`
  );
  return false;
}

/**
 * The auditor's write gate: it must be able to READ anywhere (it consults the volume folders for
 * context) but may WRITE only the report. The base gate confines writes to the series root; this
 * ANDs it with a single-file check so the four artifacts under audit are genuinely read-only — a
 * wider gate would let the agent "fix" an artifact by overwriting it, corrupting the very thing it
 * is judging.
 *
 * @param {string} seriesDir
 * @param {Object} fsGate - The harness's gated file tools.
 * @returns {(call: Object) => boolean}
 */
function auditorApprove(seriesDir, fsGate) {
  const reportResolved = path.resolve(seriesDir, REPORT_FILE);
  return (call) => {
    if (!fsGate.approve(call)) return false;
    if (call.toolName === "writeFile" || call.toolName === "editFile") {
      const resolved = path.resolve(seriesDir, typeof call.input?.filePath === "string" ? call.input.filePath : "");
      return resolved === reportResolved;
    }
    return true; // reads pass; deleteFile is already denied by the base gate
  };
}

/**
 * Run the audit agent and check that it actually produced the report.
 *
 * @param {{seriesDir: string, systemPrompt: string, turnPrompt: string, fsGate: Object, reportFile: string}} args
 * @returns {Promise<void>}
 */
async function runAuditAgent({ seriesDir, systemPrompt, turnPrompt, fsGate, reportFile }) {
  const auditor = await harness.createAgentHandle({
    name: "consistency-auditor",
    systemPrompt: systemPrompt + AGENT_TOOLS_NOTE,
    tools: fsGate.tools,
    approve: auditorApprove(seriesDir, fsGate),
    cwd: seriesDir,
    maxSteps: MAX_STEPS,
  });
  try {
    const result = await auditor.sendTurn(turnPrompt, { label: "consistency-audit" });
    assertRealToolCalls(result, "the audit agent");
    await assertWrote(reportFile, "the audit agent");
  } finally {
    await auditor.close();
  }
}

/**
 * The audited state must be exactly what was hashed before the agent ran. A report signs off a
 * specific state; if that state moved while the audit was in flight, the report describes a world
 * that no longer exists — and the next skip-check would treat it as current.
 *
 * (The write gate makes agent tampering impossible; this is the belt to the braces, and it also
 * catches an external writer.)
 *
 * @param {string} seriesDir
 * @param {Object<string, string>} hashesBefore
 * @returns {Promise<Object<string, string>>} The hashes after the run, for the provenance sidecar.
 * @throws {Error} A structural one: the audit is void.
 */
async function assertAuditedStateUnchanged(seriesDir, hashesBefore) {
  const hashesAfter = await hashAuditArtifacts(seriesDir);
  const tampered = AUDIT_ARTIFACTS.filter(([file]) => hashesAfter[file] !== hashesBefore[file]).map(
    ([f, name]) => name
  );
  if (tampered.length === 0) return hashesAfter;
  throw structuralError(
    `The audit is void: ${tampered.join(", ")} changed while the audit agent was running ` +
      `(its hash before the run differs from the hash after). The report signs off a ` +
      `state that no longer exists on disk. Re-run "npx gulp consistency-audit --force" ` +
      `once the artifacts are stable.`
  );
}

/**
 * Log the verdict. The report is the deliverable: a FAIL is logged loudly but does not fail the
 * task, because the artifacts stay on disk and a fixer re-runs the offending task(s) and re-audits
 * with --force.
 *
 * @param {string} reportFile
 * @returns {Promise<void>}
 */
async function logAuditVerdict(reportFile) {
  const report = await fs.readFile(reportFile, "utf8");
  const verdictMatch = report.match(/\*\*(PASS|FAIL)\*\*/);
  const verdict = verdictMatch ? verdictMatch[1] : "UNPARSED";
  console.log(
    `Consistency audit complete — verdict: ${verdict} → ${reportFile}` +
      (verdict === "FAIL"
        ? "\n  The audit found blocking inconsistencies. Fix the flagged artifacts " +
          "(re-run the offending task), then re-audit with --force before " +
          "translation."
        : verdict === "PASS"
          ? "\n  The four artifacts are consistent — the series is signed off for translation."
          : "\n  Could not parse the verdict from the report — review it manually.")
  );
}

/**
 * The gulp task entry point for the consistency-audit workflow.
 */
async function consistencyAudit() {
  const { dryRun, force } = readRunArgs();
  console.log("consistency-audit task starting...");
  validateRequiredEnv({ dryRun });
  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
  // Series name + languages: .env override > the intake manifest's decision > the default (see
  // resolveRunSettings in configs/shared.js).
  const runSettings = resolveRunSettings(manifest);
  // Use the module-level seriesDir (SERIES_LOCATION) — NOT manifest.seriesLocation. That field is
  // provenance metadata (see the identical note in glossary.js / character-voice.js): a
  // Windows-generated "C:\..." path is not absolute on Linux and would make every file op resolve
  // relative to the CWD.
  const values = {
    SOURCE_NAME: runSettings.seriesName,
    VOLUME_COUNT: String(manifest.volumes.length),
    SOURCE_LANGUAGE: runSettings.sourceLanguage,
    TARGET_LANGUAGE: runSettings.targetLanguage,
  };
  const reportFile = path.join(seriesDir, REPORT_FILE);

  const systemPrompt = await fs.readFile(systemPromptFile, "utf8");
  const userPromptTemplate = await fs.readFile(userPromptTemplateFile, "utf8");
  const turnPrompt = buildAuditTurnPrompt({ userPrompt: userPromptTemplate, values });

  if (dryRun) {
    const sections = [
      { title: "AGENT — audit system prompt", prompt: systemPrompt + AGENT_TOOLS_NOTE },
      { title: "AGENT — audit turn", prompt: turnPrompt },
    ];
    const dumpFile = await writePromptDump("consistency-audit", "series", "agent", sections);
    console.log(`--dry-run: prompts dumped to ${dumpFile}`);
    return;
  }

  // The audit is a sign-off over the full set.
  await requireAuditArtifacts(seriesDir);

  // Idempotency: skip while the report still fingerprints the four artifacts exactly.
  if (!force && (await fileExists(reportFile)) && (await auditIsFresh(reportFile, seriesDir))) return;

  const fsGate = await harness.createGatedFsTools({ cwd: seriesDir, allowedDirs: [seriesDir] });

  // Hash the four artifacts BEFORE the agent runs, so the report can be proved to describe the state
  // it was written against.
  const hashesBefore = await hashAuditArtifacts(seriesDir);

  await runAuditAgent({ seriesDir, systemPrompt, turnPrompt, fsGate, reportFile });

  const hashesAfter = await assertAuditedStateUnchanged(seriesDir, hashesBefore);

  // Record the fingerprints of the state this report signs off, so the next run can skip
  // deterministically (best-effort — a failure only means the next run falls back to the legacy mtime
  // check).
  await writeAuditProvenance(reportFile, hashesAfter);

  await logAuditVerdict(reportFile);
}


// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  consistencyAudit,
  emittedToolCallAsText,
  assertRealToolCalls,
  buildAuditTurnPrompt,
  hashAuditArtifacts,
  writeAuditProvenance,
  loadAuditProvenance,
  provenanceMatches,
  AUDIT_ARTIFACTS,
  REPORT_FILE,
  PROVENANCE_FILE,
};

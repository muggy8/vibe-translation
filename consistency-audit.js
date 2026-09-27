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
 * Idempotent: if consistency-report.md is newer than all four artifacts it is
 * skipped (unless --force). If an artifact is missing the task fails loudly
 * (name the task to run) — an audit over fewer than four artifacts is not a
 * sign-off.
 *
 * Usage:
 *   npx gulp consistency-audit             # run the audit
 *   npx gulp consistency-audit --dry-run   # transform the prompts only, no API call
 *   npx gulp consistency-audit --force     # re-audit even if the report is fresh
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types");
const harness = require("./harness");
const { transformUserPrompt, writePromptDump } = require("./utils/prompt");
const { AGENT_TOOLS_NOTE, validateRequiredEnv } = require("./configs/shared");
const { fileExists, assertWrote } = require("./utils/fs");
const { getTranslationTarget } = require("./get-translation-target");

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
const MAX_STEPS = 40;

/**
 * Detect a small malformed tool call emitted as plain text (see the identical
 * guard in character-voice.js / style-guide.js / glossary.js / jump-in-wiki.js).
 *
 * @param {Object|null} result - The result object returned by an agent sendTurn.
 * @returns {boolean} True when the turn made zero real tool calls but its text
 *   contains tool-call syntax.
 */
function emittedToolCallAsText(result) {
  if (!result) return false;
  if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) return false;
  const text = typeof result.text === "string" ? result.text : "";
  return text.includes("tool_call") || text.includes("<function=");
}

/**
 * Throw a diagnostic error when an agent turn emitted tool-call syntax as
 * plain text instead of using the tool-calling API (so no file tools ran and
 * nothing was read or written).
 *
 * @param {Object|null} result - The result object returned by an agent sendTurn.
 * @param {string} who - Human name of the agent (for the error message).
 * @returns {void}
 */
function assertRealToolCalls(result, who) {
  if (!emittedToolCallAsText(result)) return;
  throw new Error(
    `${who} emitted tool-call syntax as plain text ` +
      `("tool_call" / <function=…>) instead of using the tool-calling API, so no ` +
      `file tools ran — nothing was read or written. See the agent transcript in ` +
      `.logs/ for the exact turn. This is an intermittent model/endpoint issue ` +
      `with OpenAI tool_calls (the smoke test 'npm run smoke fs' can pass even ` +
      `when it happens). Re-run the task; if it persists, check the endpoint.`
  );
}

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
 * The gulp task entry point for the consistency-audit workflow.
 */
async function consistencyAudit() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  console.log("consistency-audit task starting...");
  validateRequiredEnv({ dryRun });
  const manifest = await getTranslationTarget({ force, dryRun });
  // Use the module-level seriesDir (SERIES_LOCATION) — NOT manifest.seriesLocation.
  // That field is provenance metadata (see the identical note in glossary.js /
  // character-voice.js): a Windows-generated "C:\..." path is not absolute on
  // Linux and would make every file op resolve relative to the CWD.
  const values = {
    SOURCE_NAME: manifest.seriesName,
    VOLUME_COUNT: String(manifest.volumes.length),
    SOURCE_LANGUAGE: process.env.TRANSLATION_SOURCE_LANGUAGE || "Japanese",
    TARGET_LANGUAGE: process.env.TRANSLATION_TARGET_LANGUAGE || "English",
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

  // All four artifacts must exist — the audit is a sign-off over the full set.
  const missing = (
    await Promise.all(
      AUDIT_ARTIFACTS.map(async ([file, name]) =>
        (await fileExists(path.join(seriesDir, file))) ? null : [file, name]
      )
    )
  ).filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Cannot run the consistency audit — missing series-root artifact(s): ` +
        `${missing.map(([file, name]) => `${file} (${name})`).join(", ")}. ` +
        `Run the corresponding pre-production task(s) first (glossary / ` +
        `character-voice / style-guide / jump-in-wiki) and re-run the pipeline.`
    );
  }

  // Idempotency: the report is valid as long as it is not older than any
  // artifact it audited (an artifact regenerated after the audit invalidates
  // it). Deterministic mtime check — no AI call.
  if (!force && (await fileExists(reportFile))) {
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
        `consistency-report.md is newer than all four artifacts — skipping ` +
          `(use --force to re-audit).`
      );
      return;
    }
    console.log(
      `consistency-report.md is stale (newer artifact(s): ${staleInputs.join(", ")}) — re-auditing.`
    );
  }

  // Gated fs tools: cwd + writes confined to the series root (where the
  // report lives). Reads are allowed anywhere (the agent may consult volume
  // folders for context); deleteFile is always denied by the gate.
  const fsGate = await harness.createGatedFsTools({ cwd: seriesDir, allowedDirs: [seriesDir] });
  const auditor = await harness.createAgentHandle({
    name: "consistency-auditor",
    systemPrompt: systemPrompt + AGENT_TOOLS_NOTE,
    tools: fsGate.tools,
    approve: fsGate.approve,
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

  // Log the verdict (the report is the deliverable — a FAIL is logged loudly
  // but does not fail the task: the artifacts stay on disk and a fixer re-runs
  // the offending task(s), then `npx gulp consistency-audit --force`).
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

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  consistencyAudit,
  emittedToolCallAsText,
  assertRealToolCalls,
  buildAuditTurnPrompt,
  AUDIT_ARTIFACTS,
  REPORT_FILE,
};
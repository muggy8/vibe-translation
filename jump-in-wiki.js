/**
 * jump-in-wiki.js — Logic for the "jump-in-wiki" gulp task: generating the
 * jump-in wiki for each volume of the series.
 *
 * Task: jump-in-wiki
 *   For each volume (in natural order):
 *     1. Generate the two output files:
 *        - <volume folder>/wiki.md        (the volume wiki)
 *        - <volume folder>/shared-wiki.md (the updated "living" shared wiki)
 *        using the generation prompts (system-prompts/jump-in-wiki.md and
 *        user-prompts/jump-in-wiki.md):
 *        - agent: an author agent (per-volume session) reads the source and
 *          previous wikis with file tools and writes both files directly
 *          (no marker-based output parsing). When the glossary task has
 *          already written <volume folder>/glossary.md, it is offered as a
 *          read-only reference so the shared wiki's "Glossary" section uses
 *          canonical renderings.
 *     2. Repeats the following until the score-based acceptance criterion
 *        is met or the iteration cap (QA_MAX_ITERATIONS, default 10)
 *        is reached:
 *        a. Validates the wiki with the validator prompts
 *           (system-prompts/jump-in-wiki-validator.md and
 *           user-prompts/jump-in-wiki-validator.md), saving the report to
 *           <volume folder>/jump-in-wiki-validation-NN.md (a validator agent
 *           writes the report).
 *        b. Asks the acceptance prompts (system-prompts/jump-in-wiki-acceptance.md
 *           and user-prompts/jump-in-wiki-acceptance.md) to score the wiki
 *           0–100. Always a tool-less single-shot call. Each score is
 *           tracked in a rolling window (default: last 5 checks). When the
 *           window meets the acceptance criterion (rolling average of scores
 *           >= ACCEPTANCE_PASSING_SCORE, default 70 — see configs/shared.js)
 *           and we have at least MIN_SAMPLES (default: 3) checks, accept
 *           and stop.
 *        c. Otherwise, apply the feedback prompts
 *           (system-prompts/jump-in-wiki-feedback.md and
 *           user-prompts/jump-in-wiki-feedback.md) to correct the wiki
 *           (the same author session), then repeat from (a).
 *     3. Write the deterministic per-volume translation handoff
 *        (chapters.json + translation-brief.md, utils/handoff.js).
 *   After all volumes: the last existing <volume folder>/shared-wiki.md is
 *   copied to SHARED_WIKI_OUTPUT_FILE (default
 *   <SERIES_LOCATION>/shared-wiki.md), mirroring the glossary / character-voice
 *   / style-guide root copies. Skipped for --volume runs.
 *
 * Idempotent: a volume whose wiki + shared wiki already exist and pass the
 * acceptance check (from a previous run's validation report) is skipped
 * (unless --force). A volume whose files exist is still validated, so a
 * passing wiki is re-checked rather than regenerated.
 *
 * Usage:
 *   npx gulp jump-in-wiki             # run the full task
 *   npx gulp jump-in-wiki --dry-run   # transform the prompt only, no API call
 *   npx gulp jump-in-wiki --force     # regenerate even if already processed
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types"); // JSDoc type definitions
const harness = require("./harness");
const { getTranslationTarget } = require("./get-translation-target");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings } = require("./configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback, writeProvenanceSidecar } = require("./utils/fs");
const { runSharedQaLoop } = require("./utils/qa-loop");
const { writeVolumeHandoff } = require("./utils/handoff");
const { transformUserPrompt, isPassingVerdict, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, writePromptDump } = require("./utils/prompt");
const { installmentNumberFromDir, filterVolumesByInstallment } = require("./utils/manifest");
const {
  resolveSourceBundle,
  shouldProcessChunked,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("./utils/source");

// ─── Paths ──────────────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;
const systemPromptFile = path.join(clientDir, "system-prompts", "jump-in-wiki.md");
const userPromptTemplateFile = path.join(clientDir, "user-prompts", "jump-in-wiki.md");
const validatorSystemPromptFile = path.join(clientDir, "system-prompts", "jump-in-wiki-validator.md");
const validatorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "jump-in-wiki-validator.md");
const feedbackSystemPromptFile = path.join(clientDir, "system-prompts", "jump-in-wiki-feedback.md");
const feedbackUserPromptTemplateFile = path.join(clientDir, "user-prompts", "jump-in-wiki-feedback.md");
const acceptanceSystemPromptFile = path.join(clientDir, "system-prompts", "jump-in-wiki-acceptance.md");
const acceptanceUserPromptTemplateFile = path.join(clientDir, "user-prompts", "jump-in-wiki-acceptance.md");

// Maximum number of validation -> acceptance -> feedback iterations per volume
// before the wiki is left as-is. Read from .env, defaulting to 3.
const maxValidationIterations = Math.max(
  1,
  parseInt(process.env.QA_MAX_ITERATIONS, 10) || 3
);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Safety net for agent runs: if the expected output file is missing but the
 * agent wrote a different .md file in the volume folder (e.g. a classic
 * marker name), rename the best candidate to the expected name.
 *
 * REMOVED: This function was removed after the prompts were updated to use
 * agent-mode file names directly. The agent now consistently writes to the
 * correct file names, making this safety net unnecessary. Kept here as a
 * reference in case it needs to be re-enabled for a future model regression.
 *
 * @param {string} volumeDir - The volume folder the expected file belongs to.
 * @param {string} expectedBase - The expected file name (e.g. "wiki.md").
 * @param {Set<string>} knownFiles - File names that must never be adopted.
 * @returns {Promise<boolean>} True when a stray file was adopted.
 */
/*
async function adoptStrayOutput(volumeDir, expectedBase, knownFiles) {
  const expectedPath = path.join(volumeDir, expectedBase);
  if (await fileExists(expectedPath)) return false;
  const wantShared = expectedBase.includes("shared");
  const candidates = [];
  for (const name of await fs.readdir(volumeDir)) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    if (name === expectedBase || knownFiles.has(name)) continue;
    const lower = name.toLowerCase();
    if (lower.includes("validation")) continue;
    if (wantShared !== lower.includes("shared")) continue;
    const st = await fs.stat(path.join(volumeDir, name)).catch(() => null);
    if (!st || st.size === 0) continue;
    let score = 0;
    if (lower.includes("wiki")) score += 2;
    if (!wantShared && /\d/.test(lower)) score += 1;
    candidates.push({ name, st, score });
  }
  if (candidates.length === 0) return false;
  candidates.sort((a, b) => b.score - a.score || b.st.mtimeMs - a.st.mtimeMs);
  const pick = candidates[0];
  await fs.rename(path.join(volumeDir, pick.name), expectedPath);
  console.log(
    `Adopted "${pick.name}" as "${expectedBase}" (the agent used a different file name).`
  );
  return true;
}
*/

/**
 * The file names that may legitimately live in a volume folder and must
 * never be mistaken for (or renamed into) the wiki outputs.
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
 * @returns {Set<string>} The protected file names.
 */
function knownVolumeFileNames(ctx) {
  return new Set([
    `${ctx.folderName}.md`,
    "glossary.md",
    "glossary-research.md",
    "glossary-validation.md",
    `jump-in-wiki-validation-${ctx.values.INSTALLMENT_NUMBER}.md`,
  ]);
}

// ─── Malformed-tool-call guard ──────────────────────────────────────────────

/**
 * Detect the "model emitted tool-call syntax as plain text" failure mode.
 *
 * Observed live (Qwen via an OpenAI-compatible endpoint): the model sometimes
 * emits its tool calls as Qwen-native text — a `tool_call` wrapper around the
 * tool name, e.g. `tool_call <function=readFile>…` or `tool_call <listFiles>…`
 * — in the content field instead of using the API-level tool_calls protocol.
 * The harness only executes real tool calls, so such a turn performs no work
 * at all, yet it looks like an ordinary (short) chat reply, so the stale-file
 * write check and the acceptance loop would silently mask it and burn every
 * validation iteration. (Same detector as character-voice.js / style-guide.js
 * — AGENTS.md gotcha 18.)
 *
 * @param {Object|null} result - The result object returned by an agent sendTurn.
 * @returns {boolean} True when the turn made no real tool calls and its text
 *   contains tool-call markers (the malformed-tool-call signature).
 */
function emittedToolCallAsText(result) {
  if (!result) return false;
  if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) return false;
  const text = typeof result.text === "string" ? result.text : "";
  return text.includes("tool_call") || text.includes("<function=");
}

/**
 * Fail loudly when an agent turn made no real tool calls because the model
 * emitted tool-call syntax as plain text (see emittedToolCallAsText). Throws a
 * diagnostic error instead of letting the stale-file write check mask the
 * no-op turn.
 *
 * @param {Object|null} result - The result object returned by an agent sendTurn.
 * @param {string} who - Who the agent was (for the error message).
 * @param {string} volumeLabel - The volume label (for the error message).
 * @returns {void}
 */
function assertRealToolCalls(result, who, volumeLabel) {
  if (!emittedToolCallAsText(result)) return;
  throw new Error(
    `Volume ${volumeLabel}: ${who} emitted tool-call syntax as plain text ` +
      `("tool_call" / <function=…>) instead of using the tool-calling API, so no ` +
      `file tools ran — nothing was read or written. See the agent transcript in ` +
      `.logs/ for the exact turn. This is an intermittent model/endpoint issue ` +
      `with OpenAI tool_calls (the smoke test 'npm run smoke fs' can pass even ` +
      `when it happens). Re-run the task; if it persists, check the endpoint.`
  );
}

// ─── Agent-mode prompt builders ─────────────────────────────────────────────
// The exact prompts the agent-mode stages send are built here (not inline in
// the run loops) so --dry-run can dump them and the tests can assert on them
// without any AI call.

/**
 * The author agent's system prompt: the mode-agnostic generation prompt with
 * the file tools note appended.
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
 * @returns {string}
 */
function buildWikiAuthorSystemPrompt(ctx) {
  return ctx.systemPrompt + AGENT_TOOLS_NOTE;
}

/**
 * The validator agent's system prompt: the mode-agnostic validator prompt
 * with the file tools note appended.
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
 * @returns {string}
 */
function buildWikiValidatorSystemPrompt(ctx) {
  return ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE;
}

/**
 * The author agent's generation turn prompt (agent mode).
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include userPrompt).
 * @returns {string}
 */
function buildWikiAuthorTurnPrompt(ctx) {
  const { isFirst, previousFolderName } = ctx;
  const previousWikiLines = isFirst
    ? `- The previous volume wiki and shared wiki: (absent — this is the first volume)`
    : `- The previous volume wiki: "../${previousFolderName}/wiki.md"\n` +
      `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"`;
  const sourceLine = ctx.bundle
    ? sourceMaterialLine(ctx.bundle)
    : `- The volume source: "${ctx.folderName}.md" (same folder)`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    previousWikiLines +
    (ctx.glossaryFile
      ? `\n- The canonical glossary: "glossary.md" (same folder) — for the shared wiki's "Glossary" section, use these canonical target-language renderings (read-only reference)`
      : "") +
    `\n\n` +
    `Write the two output files in your working folder:\n` +
    `- "wiki.md" — the volume wiki (complete contents, writeFile)\n` +
    `- "shared-wiki.md" — the updated shared wiki (complete contents, writeFile)\n` +
    `Use EXACTLY these two file names — do not invent other names.\n\n` +
    ctx.userPrompt +
    `\n\nRemember: the complete results go to exactly "wiki.md" and ` +
    `"shared-wiki.md" in your working folder (writeFile, complete contents).`
  );
}

/**
 * The validator agent's turn prompt (agent mode, one fresh agent per QA
 * iteration).
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include validatorUserPrompt).
 * @returns {string}
 */
function buildWikiValidatorTurnPrompt(ctx) {
  const { values, isFirst, previousFolderName } = ctx;
  const validationFileName = `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`;
  const previousSharedLine = isFirst
    ? ""
    : `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"\n`;
  const sourceLine = ctx.bundle
    ? sourceMaterialLine(ctx.bundle)
    : `- The volume source: "${ctx.folderName}.md" (same folder)`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    `- The volume wiki under audit: "wiki.md" (same folder)\n` +
    `- The shared wiki under audit: "shared-wiki.md" (same folder)\n` +
    previousSharedLine +
    `\n` +
    `Write the complete validation report to the file "${validationFileName}" in ` +
    `your working folder (writeFile, exact format from the system prompt).\n\n` +
    ctx.validatorUserPrompt
  );
}

/**
 * The author agent's feedback turn prompt (agent mode).
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include feedbackUserPrompt).
 * @returns {string}
 */
function buildWikiFeedbackTurnPrompt(ctx) {
  const { values, isFirst, previousFolderName } = ctx;
  const validationFileName = `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`;
  const previousSharedLine = isFirst
    ? ""
    : `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"\n`;
  const sourceLine = ctx.bundle
    ? sourceMaterialLine(ctx.bundle)
    : `- The volume source: "${ctx.folderName}.md" (same folder)`;
  const feedbackPrompt = ctx.feedbackUserPrompt;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `The validation report "${validationFileName}" in your working folder is your ` +
    `work order.\n` +
    `Materials (read with readFile before changing anything):\n` +
    `${sourceLine}\n` +
    `- The current volume wiki to correct: "wiki.md" (same folder)\n` +
    `- The current shared wiki to correct: "shared-wiki.md" (same folder)\n` +
    previousSharedLine +
    (ctx.glossaryFile
      ? `- The canonical glossary: "glossary.md" (same folder) — if the shared wiki's "Glossary" section drifts from it, correct the shared wiki to match (read-only reference)\n`
      : "") +
    `\n` +
    `Apply the report's findings and write the corrected files back: "wiki.md" and ` +
    `"shared-wiki.md" using writeFile (complete contents, overwrite). Use editFile only for ` +
    `targeted fixes. Make the smallest changes that resolve each valid finding.\n\n` +
    feedbackPrompt
  );
}

/**
 * The per-chapter section author turn prompt (chunked fallback): writes the
 * wiki section for ONE chapter to wiki-<id>.md. Sections are merged into the
 * final wiki.md by the merge pass.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include bundle).
 * @param {SourceSegment} segment - The chapter being written.
 * @param {number} si - Zero-based position in reading order.
 * @returns {string}
 */
function buildWikiSectionTurnPrompt(ctx, segment, si) {
  const { values, isFirst, previousFolderName } = ctx;
  const sectionFile = `wiki-${segment.id}.md`;
  const previousWikiLines = isFirst
    ? `- The previous volume wiki and shared wiki: (absent — this is the first volume)`
    : `- The previous volume wiki: "../${previousFolderName}/wiki.md"\n` +
      `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"`;
  const sectionList = ctx.bundle.segments.map((s) => `"wiki-${s.id}.md"`).join(", ");
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterContextBlock(values, ctx.bundle, segment, si) +
    `Materials (read with readFile before writing anything):\n` +
    `- The chapter source: "${segment.file}" (same folder)\n` +
    `- The current shared wiki: "shared-wiki.md" (same folder) — read-only for this pass\n` +
    previousWikiLines +
    (si > 0 ? `\n- The previous chapter's section: "wiki-${ctx.bundle.segments[si - 1].id}.md" (same folder) — for continuity\n` : "") +
    `\n\n` +
    `Write the wiki section for THIS CHAPTER ONLY to the file "${sectionFile}" in your ` +
    `working folder (writeFile, complete contents): a top-level heading with the chapter ` +
    `title, then the chapter's plot, characters, locations and events. Do not summarize ` +
    `other chapters and do not modify "shared-wiki.md". ` +
    `The per-chapter sections that will be merged are: ${sectionList}.\n\n` +
    ctx.userPrompt
  );
}

/**
 * The wiki merge turn prompt (chunked fallback): merges the per-chapter
 * sections into the final wiki.md and updates the shared wiki.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include bundle).
 * @returns {string}
 */
function buildWikiMergeTurnPrompt(ctx) {
  const { values, isFirst, previousFolderName } = ctx;
  const sectionList = ctx.bundle.segments
    .map((s) => `- "wiki-${s.id}.md" (chapter ${s.id} — ${s.title})`)
    .join("\n");
  const previousWikiLines = isFirst
    ? `- The previous volume wiki and shared wiki: (absent — this is the first volume)`
    : `- The previous volume wiki: "../${previousFolderName}/wiki.md"\n` +
      `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `You are merging the per-chapter wiki sections of volume ${values.INSTALLMENT_NUMBER} ` +
    `(the volume is processed chapter by chapter because the whole installment is too ` +
    `large for a single pass) into the final volume wiki.\n` +
    `Materials (read with readFile before writing anything):\n` +
    sectionList +
    `\n- The current shared wiki: "shared-wiki.md" (same folder)\n` +
    previousWikiLines +
    (ctx.glossaryFile
      ? `\n- The canonical glossary: "glossary.md" (same folder) — for the shared wiki's "Glossary" section, use these canonical target-language renderings (read-only reference)\n`
      : "") +
    `\n\n` +
    `Write the two output files in your working folder:\n` +
    `- "wiki.md" — the complete volume wiki, assembled from the chapter sections in ` +
    `reading order (writeFile, complete contents)\n` +
    `- "shared-wiki.md" — the updated shared wiki, carrying forward all previous ` +
    `entries and adding what this volume contributes (writeFile, complete contents)\n` +
    `Keep every fact from the sections (do not drop or invent plot details); a short ` +
    `volume summary may be added on top of the chapter sections.\n\n` +
    ctx.userPrompt
  );
}

/**
 * The per-chapter validator turn prompt (chunked fallback): audits the wiki
 * against ONE chapter and writes a partial report.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include bundle).
 * @param {SourceSegment} segment - The chapter being audited.
 * @param {number} si - Zero-based position in reading order.
 * @returns {string}
 */
function buildWikiSegmentValidatorPrompt(ctx, segment, si) {
  const { values, isFirst, previousFolderName } = ctx;
  const partialFile = `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}-${segment.id}.md`;
  const previousSharedLine = isFirst
    ? ""
    : `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"\n`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterContextBlock(values, ctx.bundle, segment, si) +
    `This is a per-chapter validation pass: audit the wiki against ONE chapter only.\n` +
    `Materials (read with readFile before writing anything):\n` +
    `- The chapter source: "${segment.file}" (same folder)\n` +
    `- The volume wiki under audit: "wiki.md" (same folder)\n` +
    `- The shared wiki under audit: "shared-wiki.md" (same folder)\n` +
    previousSharedLine +
    `\n` +
    `Tag every finding with the chapter id "${segment.id}" (e.g. a prefix "[${segment.id}] ").\n` +
    `Write the partial validation report to the file "${partialFile}" in your working ` +
    `folder (writeFile, the report format from the system prompt).\n\n` +
    ctx.validatorUserPrompt
  );
}

/**
 * The findings-merge turn prompt (chunked fallback): consolidates the
 * per-chapter partial reports into the standard validation report so the
 * unchanged acceptance one-shot can score it.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include bundle).
 * @returns {string}
 */
function buildWikiFindingsMergePrompt(ctx) {
  const { values } = ctx;
  const list = ctx.bundle.segments
    .map((s) => `- "jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}-${s.id}.md" (chapter ${s.id})`)
    .join("\n");
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `You are consolidating the per-chapter validation partials of volume ` +
    `${values.INSTALLMENT_NUMBER} into the single standard validation report.\n` +
    `Materials (read with readFile before writing anything):\n` +
    list +
    `\n\n` +
    `Write the consolidated report to the file ` +
    `"jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md" in your working folder ` +
    `(writeFile, complete contents) using EXACTLY the report format from your system ` +
    `prompt. Preserve the chapter tags on the findings, keep every valid finding ` +
    `(deduplicate repeats), and produce the summary/verdict sections the format ` +
    `requires, as if you had audited the whole volume in one pass.`
  );
}

/**
 * The per-chapter feedback turn prompt (chunked fallback): applies the
 * chapter-tagged findings of the consolidated report to wiki.md and
 * shared-wiki.md.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include bundle).
 * @param {SourceSegment} segment - The chapter whose findings are applied.
 * @param {number} si - Zero-based position in reading order.
 * @returns {string}
 */
function buildWikiSegmentFeedbackPrompt(ctx, segment, si) {
  const { values, isFirst, previousFolderName } = ctx;
  const validationFileName = `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`;
  const previousSharedLine = isFirst
    ? ""
    : `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"\n`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterContextBlock(values, ctx.bundle, segment, si) +
    `The validation report "${validationFileName}" in your working folder is your work ` +
    `order — apply ONLY the findings tagged with chapter "${segment.id}".\n` +
    `Materials (read with readFile before changing anything):\n` +
    `- The chapter source: "${segment.file}" (same folder)\n` +
    `- The current volume wiki to correct: "wiki.md" (same folder)\n` +
    `- The current shared wiki to correct: "shared-wiki.md" (same folder)\n` +
    previousSharedLine +
    `\n` +
    `Apply the chapter's findings and write the corrected files back: "wiki.md" and ` +
    `"shared-wiki.md" using writeFile (complete contents, overwrite). Use editFile only ` +
    `for targeted fixes. Make the smallest changes that resolve each valid finding; do ` +
    `not touch content this chapter's findings do not concern.\n\n` +
    ctx.feedbackUserPrompt
  );
}

// Re-export shared utilities from utils/prompt.js and utils/manifest.js
// for backwards compatibility (tests and glossary.js import these from here).
module.exports.transformUserPrompt = require("./utils/prompt").transformUserPrompt;
module.exports.isPassingVerdict = require("./utils/prompt").isPassingVerdict;
module.exports.parseAcceptanceScore = require("./utils/prompt").parseAcceptanceScore;
module.exports.validatorMaxStepsFor = require("./utils/prompt").validatorMaxStepsFor;
module.exports.writePromptDump = require("./utils/prompt").writePromptDump;
module.exports.installmentNumberFromDir = require("./utils/manifest").installmentNumberFromDir;

// ─── Task ───────────────────────────────────────────────────────────────────

async function jumpInWiki() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  // Force the chapter-by-chapter fallback for every multi-chapter epub volume
  // (the default is whole-installment processing; the fallback also triggers
  // automatically when the whole text exceeds SOURCE_CHUNK_THRESHOLD_CHARS).
  const chunkedArg = process.argv.includes("--chunked");

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  // Fail fast (before any AI call) if required env vars are missing — the
  // aggregated message names every missing variable (SERIES_NAME, and
  // AI_API_KEY when not --dry-run).
  validateRequiredEnv({ dryRun });

  // Discover the volumes with the AI-driven translation-target manifest (see
  // get-translation-target.js). It yields, in reading order, each volume's
  // folder and its exact source file, so nothing below has to guess names.
  const manifest = await getTranslationTarget({ force, dryRun });
  // Series name + languages: .env override > the intake manifest's decision >
  // the default (see resolveRunSettings in configs/shared.js).
  const runSettings = resolveRunSettings(manifest);
  const sortedFolderWithSourceMaterial = manifest.volumes.map((v) => v.folder);
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));

  if (sortedFolderWithSourceMaterial.length === 0) {
    throw new Error(`No volume folders found in ${seriesDir}.`);
  }

  // Optional: process a single volume only ("--volume 01" or "--volume=01"),
  // e.g. for a live test before a full-series run. The previous volume is
  // still looked up in the full series (so --volume 05 needs volume 04).
  const volumeArg =
    (process.argv.find((a) => a.startsWith("--volume=")) || "").replace("--volume=", "") ||
    (process.argv.includes("--volume")
      ? process.argv[process.argv.indexOf("--volume") + 1]
      : null);
  // "--volume NN" is resolved through the manifest's installment numbers, not by
  // parsing folder names — the intake agent chooses the folder names.
  let volumes = sortedFolderWithSourceMaterial;
  if (volumeArg) {
    volumes = filterVolumesByInstallment(manifest, volumeArg);
    if (volumes.length === 0) {
      throw new Error(
        `No volume matching --volume ${volumeArg} (manifest volumes: ` +
          `${manifest.volumes.map((v) => `${v.installmentNumber} = ${v.folder}`).join(", ")}).`
      );
    }
    console.log(`--volume: processing only ${volumes.join(", ")}`);
  }

  const systemPrompt = await fs.readFile(systemPromptFile, "utf-8");
  const template = await fs.readFile(userPromptTemplateFile, "utf-8");
  const validatorSystemPrompt = await fs.readFile(validatorSystemPromptFile, "utf-8");
  const validatorTemplate = await fs.readFile(validatorUserPromptTemplateFile, "utf-8");
  const feedbackSystemPrompt = await fs.readFile(feedbackSystemPromptFile, "utf-8");
  const feedbackTemplate = await fs.readFile(feedbackUserPromptTemplateFile, "utf-8");
  const acceptanceSystemPrompt = await fs.readFile(acceptanceSystemPromptFile, "utf-8");
  const acceptanceTemplate = await fs.readFile(acceptanceUserPromptTemplateFile, "utf-8");

  let limitReachedCount = 0;
  const failedVolumes = [];

  for (const folderName of volumes) {
    try {
    const i = sortedFolderWithSourceMaterial.indexOf(folderName);
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    // Resolve the source into a bundle (utils/source.js): plain-text sources
    // pass through as-is (the default whole-installment path); .epub sources
    // are normalized once (cached) into per-chapter + whole Markdown files.
    const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
    const sourceFile = bundle.wholePath;
    const processChunked = shouldProcessChunked(bundle, { forceChunked: chunkedArg });
    console.log(
      `Volume ${volume.installmentNumber}: source "${path.basename(bundle.originalPath)}" → ${bundle.format} ` +
        `(${bundle.wholeChars} chars, ${bundle.segments.length} segment(s)) — processing ` +
        (processChunked
          ? "chapter by chapter (fallback: whole installment too large for one pass)"
          : "as the whole installment (default)") +
        "."
    );
    const wikiOutputFile = path.join(volumeDir, "wiki.md");
    const sharedWikiOutputFile = path.join(volumeDir, "shared-wiki.md");

    if (!(await fileExists(bundle.originalPath))) {
      throw new Error(`Required file not found: ${bundle.originalPath}`);
    }

    const values = {
      INSTALLMENT_NUMBER: volume.installmentNumber,
      SOURCE_NAME: runSettings.seriesName,
      SOURCE_LANGUAGE: runSettings.sourceLanguage,
    };

    const userPrompt = transformUserPrompt(template, values);

    const validationOutputFile = path.join(
      volumeDir,
      `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`
    );

    const validatorValues = {
      INSTALLMENT_NUMBER: values.INSTALLMENT_NUMBER,
      SOURCE_NAME: values.SOURCE_NAME,
      SOURCE_LANGUAGE: values.SOURCE_LANGUAGE,
      INSTALLMENT_NUMBER_MINUS_ONE: String(
        parseInt(values.INSTALLMENT_NUMBER, 10) - 1
      ).padStart(2, "0"),
    };
    const validatorUserPrompt = transformUserPrompt(validatorTemplate, validatorValues);

    const feedbackValues = {
      INSTALLMENT_NUMBER: values.INSTALLMENT_NUMBER,
      SOURCE_NAME: values.SOURCE_NAME,
      SOURCE_LANGUAGE: values.SOURCE_LANGUAGE,
    };
    const feedbackUserPrompt = transformUserPrompt(feedbackTemplate, feedbackValues);

    const acceptanceValues = {
      INSTALLMENT_NUMBER: values.INSTALLMENT_NUMBER,
      SOURCE_NAME: values.SOURCE_NAME,
    };
    const acceptanceUserPrompt = transformUserPrompt(acceptanceTemplate, acceptanceValues);

    console.log(`Installment number:      ${values.INSTALLMENT_NUMBER}`);
    console.log(`Source name:             ${values.SOURCE_NAME}`);
    console.log(`Source language:         ${values.SOURCE_LANGUAGE}`);
    console.log(`Source file:             ${sourceFile}`);
    console.log(`Wiki Output file:        ${wikiOutputFile}`);
    console.log(`Shared Wiki Output file: ${sharedWikiOutputFile}`);
    console.log(`Validation Output file:  ${validationOutputFile}`);

    /**
     * set some variables (the ctx is built here, before the dry-run check, so
     * --dry-run can dump the exact agent-mode prompts too)
     */
    const isFirst = i === 0;
    let previousFolderName = null;
    let previousWikiOutputFile = null;
    let previousSharedWikiOutputFile = null;

    if (!isFirst) {
      previousFolderName = sortedFolderWithSourceMaterial[i - 1];
      const previousVolumeDir = path.join(seriesDir, previousFolderName);
      previousWikiOutputFile = path.join(previousVolumeDir, "wiki.md");
      previousSharedWikiOutputFile = path.join(previousVolumeDir, "shared-wiki.md");
    }

    // generating the initial wiki is expensive, so we gotta check if it's already
    // been generated and if so, we can skip the initial generation step.
    const wikiAndSharedWikiExists =
      !force &&
      (await fileExists(wikiOutputFile)) &&
      (await fileExists(sharedWikiOutputFile));

    const ctx = {
      values,
      folderName,
      volumeDir,
      sourceFile,
      bundle,
      chunked: processChunked,
      wikiOutputFile,
      sharedWikiOutputFile,
      validationOutputFile,
      isFirst,
      previousFolderName,
      previousWikiOutputFile,
      previousSharedWikiOutputFile,
      userPrompt,
      validatorUserPrompt,
      feedbackUserPrompt,
      acceptanceUserPrompt,
      systemPrompt,
      validatorSystemPrompt,
      feedbackSystemPrompt,
      acceptanceSystemPrompt,
      wikiAndSharedWikiExists,
    };

    // The canonical glossary snapshot (written by the glossary task into the
    // same volume folder) is offered to the wiki agents as a read-only
    // reference so the shared wiki's "Glossary" section uses canonical
    // renderings instead of model memory. Absent before the first run.
    const glossarySnapshotFile = path.join(volumeDir, "glossary.md");
    ctx.glossaryFile = (await fileExists(glossarySnapshotFile)) ? glossarySnapshotFile : null;

    if (dryRun) {
      const sections = [
        { title: "AGENT — author system prompt", prompt: buildWikiAuthorSystemPrompt(ctx) },
        { title: "AGENT — author turn (generation)", prompt: buildWikiAuthorTurnPrompt(ctx) },
        { title: "AGENT — validator system prompt", prompt: buildWikiValidatorSystemPrompt(ctx) },
        { title: "AGENT — validator turn", prompt: buildWikiValidatorTurnPrompt(ctx) },
        { title: "AGENT — feedback turn (applied by the author session)", prompt: buildWikiFeedbackTurnPrompt(ctx) },
        { title: "One-shot — acceptance user prompt (always tool-less)", prompt: acceptanceUserPrompt },
      ];
      // Chunked (fallback) volumes: dump the chapter-scoped variants too.
      if (ctx.chunked && bundle.segments.length > 1) {
        const seg = bundle.segments[0];
        sections.push(
          { title: "CHUNKED — per-chapter section author turn (first chapter)", prompt: buildWikiSectionTurnPrompt(ctx, seg, 0) },
          { title: "CHUNKED — wiki merge turn", prompt: buildWikiMergeTurnPrompt(ctx) },
          { title: "CHUNKED — segment validator turn (first chapter)", prompt: buildWikiSegmentValidatorPrompt(ctx, seg, 0) },
          { title: "CHUNKED — findings merge turn", prompt: buildWikiFindingsMergePrompt(ctx) },
          { title: "CHUNKED — segment feedback turn (first chapter)", prompt: buildWikiSegmentFeedbackPrompt(ctx, seg, 0) }
        );
      }
      const dumpFile = await writePromptDump(
        "jump-in-wiki",
        values.INSTALLMENT_NUMBER,
        "agent",
        sections
      );
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: no AI calls. ` +
          `The exact prompts (agent-mode turns + tool-less acceptance) ` +
          `are written to ${dumpFile}`
      );
      continue;
    }

    /**
     * the logic for checking whether the current volume has already been
     * processed: read the persisted rolling-window state and recompute the
     * acceptance decision deterministically (no AI call).
     *
     * If the state file is missing or corrupt we fall back to regenerating
     * (fail-open).
     */
    let currentVolumeHasAlreadyBeenProcessed = false;
    if (!force && (await fileExists(validationOutputFile))) {
      const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
      const { loadRollingState } = require("./configs/shared");
      const state = await loadRollingState(stateFilePath);
      if (state) {
        const avg = computeRollingAverage(state.results);
        currentVolumeHasAlreadyBeenProcessed = isAcceptedState(state);
        if (currentVolumeHasAlreadyBeenProcessed && isSourceStale(state, bundle)) {
          currentVolumeHasAlreadyBeenProcessed = false;
          // A changed source invalidates the tier-1 skip as well: the wiki
          // on disk was written from the old source, so it must be
          // regenerated, not re-validated in place.
          ctx.wikiAndSharedWikiExists = false;
          console.log(
            `volume ${values.INSTALLMENT_NUMBER}: the source file changed since ` +
              `the last run (fingerprint mismatch) — regenerating instead of skipping.`
          );
        }
        if (currentVolumeHasAlreadyBeenProcessed) {
          console.log(
            `volume ${values.INSTALLMENT_NUMBER}: rolling-state ` +
            `(${state.results.length} checks, avg ${avg.toFixed(1)}) ` +
            `meets the criterion. skipping.`
          );
        }
      }
      // state === null → skip stays false (fail-open)
    }

    if (currentVolumeHasAlreadyBeenProcessed) {
      console.log('the current volume has already been processed by a previous run. skipping the current volume.')
      // Keep the deterministic handoff artifacts fresh (no AI call).
      await writeVolumeHandoff({
        seriesDir,
        seriesName: runSettings.seriesName,
        volume,
        volumeDir,
        bundle,
        installmentNumber: values.INSTALLMENT_NUMBER,
        sourceLanguage: runSettings.sourceLanguage,
        targetLanguage: runSettings.targetLanguage,
      });
      continue;
    }

    await runVolumeAgent(ctx);

    // Deterministic per-volume handoff for the translation stage: chapters.json
    // + translation-brief.md (no AI call; best-effort — a failure here must not
    // fail an already-accepted wiki).
    await writeVolumeHandoff({
      seriesDir,
      seriesName: runSettings.seriesName,
      volume,
      volumeDir,
      bundle,
      installmentNumber: values.INSTALLMENT_NUMBER,
      sourceLanguage: runSettings.sourceLanguage,
      targetLanguage: runSettings.targetLanguage,
    });

    if (ctx.limitReached) {
      limitReachedCount++;
    }
    } catch (err) {
      // Volume-level error isolation (ON_VOLUME_ERROR): "skip" records the
      // failure and continues with the next volume (an un-monitored run must
      // not die on one broken volume); "abort" (default) rethrows and fails
      // the task as before.
      if (ON_VOLUME_ERROR !== "skip") throw err;
      failedVolumes.push({ folder: folderName, error: err });
      const entry = volumeByFolder.get(folderName);
      console.error(
        `[skip] Volume ${entry ? entry.installmentNumber : folderName} ` +
          `(${folderName}) failed: ${err.message} — continuing with the next ` +
          `volume (ON_VOLUME_ERROR=skip).`
      );
    }
  }

  if (failedVolumes.length > 0) {
    console.error(
      `\n${failedVolumes.length} of ${volumes.length} volume(s) failed: ` +
        `${failedVolumes.map((v) => `${v.folder} (${v.error.message})`).join("; ")}. ` +
        `Re-run the task (idempotent) to pick them up.`
    );
  }
  if (limitReachedCount > 0) {
    console.log(
      `\n${limitReachedCount} of ${sortedFolderWithSourceMaterial.length} volume(s) reached the ` +
      `validation iteration limit (${maxValidationIterations}). Consider increasing ` +
      `QA_MAX_ITERATIONS if this is unexpected.`
    );
  }

  // Copy the last existing shared wiki to the series root (symmetry with the
  // glossary / character-voice / style-guide root copies): a translator or
  // downstream tool starting the next volume reads ONE file instead of having
  // to find the newest volume folder. Skipped for --volume runs (a
  // single volume's snapshot would not be the series-current state).
  if (volumeArg || dryRun) {
    console.log(
      volumeArg
        ? "\n--volume: skipping the series-root shared-wiki copy."
        : "\n--dry-run: skipping the series-root shared-wiki copy (dry runs make no file writes)."
    );
  } else {
    const finalSharedWikiFile =
      process.env.SHARED_WIKI_OUTPUT_FILE || path.join(seriesDir, "shared-wiki.md");
    let lastSharedWiki = null;
    for (let i = sortedFolderWithSourceMaterial.length - 1; i >= 0; i--) {
      const candidate = path.join(seriesDir, sortedFolderWithSourceMaterial[i], "shared-wiki.md");
      if (await fileExists(candidate)) {
        lastSharedWiki = candidate;
        break;
      }
    }
    if (lastSharedWiki) {
      await fs.copyFile(lastSharedWiki, finalSharedWikiFile);
      await writeProvenanceSidecar(finalSharedWikiFile, lastSharedWiki);
      console.log(`\nCopied the final shared wiki to: ${finalSharedWikiFile}`);
    } else {
      console.log("\nNo shared wiki snapshots found; nothing to copy to the series root.");
    }
  }
}

/**
 * Process a single volume chapter by chapter (the FALLBACK path, used when
 * the whole installment is too large for one pass): a per-chapter section
 * author writes wiki-<id>.md for each chapter (each with the previous
 * chapter's section for continuity and the shared wiki read-only), then a
 * merge pass assembles wiki.md + shared-wiki.md from the sections. The QA
 * loop then validates the finished volume chapter by chapter (per-chapter
 * partial reports → findings merge → acceptance) with per-chapter feedback.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include bundle).
 */
async function runChunkedVolumeAgent(ctx) {
  const { values, bundle, volumeDir, wikiOutputFile, sharedWikiOutputFile } = ctx;
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: chapter-by-chapter fallback ` +
      `(${bundle.segments.length} segments, ${bundle.wholeChars} chars whole)...`
  );
  const fsGate = await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] });
  ctx.fsGate = fsGate;

  // Remove stale strays from earlier runs (agent name drift).
  for (const stray of [
    `jump-in-wiki-${values.INSTALLMENT_NUMBER}.md`,
    "jump-in-wiki-shared.md",
  ]) {
    const strayPath = path.join(volumeDir, stray);
    if (await fileExists(strayPath)) {
      await fs.rm(strayPath);
      console.log(`Removed the stale file "${stray}" (leftover from a previous run).`);
    }
  }

  // Per-chapter section generation (fresh author agent per chapter).
  for (let si = 0; si < bundle.segments.length; si++) {
    const segment = bundle.segments[si];
    const sectionFile = path.join(volumeDir, `wiki-${segment.id}.md`);
    if (!(await fileExists(sectionFile))) {
      await fs.writeFile(
        sectionFile,
        `(stub — the agent replaces this with the complete wiki section for chapter ${segment.id} of volume ${values.INSTALLMENT_NUMBER})\n`,
        "utf8"
      );
    }
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: chapter ${segment.id} (${segment.title}), ` +
        `${si + 1}/${bundle.segments.length} — writing the wiki section (author agent)...`
    );
    const sectionAuthor = await harness.createAgentHandle({
      name: `wiki-section-${values.INSTALLMENT_NUMBER}-${segment.id}`,
      systemPrompt: buildWikiAuthorSystemPrompt(ctx),
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      maxSteps: 40,
    });
    try {
      const sectionResult = await sectionAuthor.sendTurn(
        buildWikiSectionTurnPrompt(ctx, segment, si),
        { label: `jump-in-wiki-section-${values.INSTALLMENT_NUMBER}-${segment.id}` }
      );
      assertRealToolCalls(sectionResult, `the section author agent (chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(sectionFile, "the section author agent", sectionResult?.text);
    } finally {
      await sectionAuthor.close();
    }
  }

  // Merge pass: assemble wiki.md + shared-wiki.md from the sections.
  if (!(await fileExists(wikiOutputFile))) {
    await fs.writeFile(
      wikiOutputFile,
      `(stub — the merge pass replaces this with the complete volume wiki for volume ${values.INSTALLMENT_NUMBER})\n`,
      "utf8"
    );
  }
  if (!(await fileExists(sharedWikiOutputFile))) {
    await fs.writeFile(
      sharedWikiOutputFile,
      `(stub — the merge pass replaces this with the complete shared wiki)\n`,
      "utf8"
    );
  }
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: merging the chapter sections into the wiki (merge agent)...`);
  const merger = await harness.createAgentHandle({
    name: `wiki-merge-${values.INSTALLMENT_NUMBER}`,
    systemPrompt: buildWikiAuthorSystemPrompt(ctx),
    tools: fsGate.tools,
    approve: fsGate.approve,
    cwd: volumeDir,
    maxSteps: 40,
  });
  try {
    const mergeResult = await merger.sendTurn(buildWikiMergeTurnPrompt(ctx), {
      label: `jump-in-wiki-merge-${values.INSTALLMENT_NUMBER}`,
    });
    assertRealToolCalls(mergeResult, "the merge agent", values.INSTALLMENT_NUMBER);
    const mergeFallbackUsed = await assertWroteWithFallback(
      [wikiOutputFile, sharedWikiOutputFile],
      "the merge agent",
      mergeResult?.text
    );
    if (mergeFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
      const hasContent = mergeResult?.text && mergeResult.text.trim().length > 0;
      const recoveryPrompt = hasContent
        ? `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you replied with the content in your chat message instead. Please rewrite both files using writeFile now with the exact same content.`
        : `You produced no output. Please read the chapter sections and write "wiki.md" and "shared-wiki.md" using writeFile now.`;
      const recoveryResult = await merger.sendTurn(recoveryPrompt, {
        label: `jump-in-wiki-merge-recovery-${values.INSTALLMENT_NUMBER}`,
      });
      assertRealToolCalls(recoveryResult, "the merge agent (recovery)", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(
        [wikiOutputFile, sharedWikiOutputFile],
        "the merge agent (recovery)",
        recoveryResult?.text
      );
    }
  } finally {
    await merger.close();
  }

  // QA loop: per-chapter validation partials → findings merge → acceptance.
  await runChunkedQaLoop(ctx);
}

/**
 * Chunked (fallback) QA loop: per-chapter validator passes (fresh agent per
 * chapter) write jump-in-wiki-validation-NN-<id>.md partials; a findings-merge
 * agent consolidates them into the standard jump-in-wiki-validation-NN.md; the
 * unchanged acceptance one-shot scores it; on a failed window, per-chapter
 * feedback agents apply the chapter-tagged findings to wiki.md + shared-wiki.md.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runChunkedQaLoop(ctx) {
  const { values, bundle, volumeDir, wikiOutputFile, sharedWikiOutputFile, validationOutputFile } = ctx;
  const fsGate = ctx.fsGate;
  const recentRollingScores = [];

  for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: validation iteration ` +
        `${iteration}/${maxValidationIterations} (chapter by chapter)...`
    );

    // Per-chapter validation partials (fresh agent per chapter).
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const partialFile = path.join(
        volumeDir,
        `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}-${segment.id}.md`
      );
      const validator = await harness.createAgentHandle({
        name: `wiki-validator-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
        systemPrompt: buildWikiValidatorSystemPrompt(ctx),
        tools: fsGate.tools,
        approve: fsGate.approve,
        cwd: volumeDir,
        maxSteps: validatorMaxStepsFor((await fs.stat(path.join(volumeDir, segment.file))).size),
      });
      try {
        const validateResult = await validator.sendTurn(
          buildWikiSegmentValidatorPrompt(ctx, segment, si),
          { label: `jump-in-wiki-validate-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` }
        );
        assertRealToolCalls(validateResult, `the validator agent (chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        await assertWroteWithFallback(
          partialFile,
          `the validator agent (chapter ${segment.id})`,
          validateResult?.text
        );
      } finally {
        await validator.close();
      }
    }

    // Findings merge: consolidate the partials into the standard report.
    const merger = await harness.createAgentHandle({
      name: `wiki-validator-merge-${values.INSTALLMENT_NUMBER}-${iteration}`,
      systemPrompt: buildWikiValidatorSystemPrompt(ctx),
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      maxSteps: 20,
    });
    try {
      const mergeResult = await merger.sendTurn(
        buildWikiFindingsMergePrompt(ctx),
        { label: `jump-in-wiki-validate-merge-${values.INSTALLMENT_NUMBER}-${iteration}` }
      );
      assertRealToolCalls(mergeResult, "the findings-merge agent", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(validationOutputFile, "the findings-merge agent", mergeResult?.text);
    } finally {
      await merger.close();
    }

    // Acceptance: tool-less one-shot over the wiki artifacts + standard report.
    const acceptanceOutput = await harness.runOneShot({
      systemPrompt: ctx.acceptanceSystemPrompt,
      messages: [
        { file: ctx.wikiOutputFile, name: "wiki.md" },
        { file: ctx.sharedWikiOutputFile, name: "shared-wiki.md" },
        { file: validationOutputFile, name: path.basename(validationOutputFile) },
        { text: ctx.acceptanceUserPrompt },
      ],
      label: `jump-in-wiki-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}`,
    });
    const reply = parseAcceptanceReply(acceptanceOutput);
    if (reply === null) {
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: acceptance check: no valid score in response ` +
          `(got: ${JSON.stringify(acceptanceOutput.trim().slice(0, 120))}). Counting this check as a failure.`
      );
    } else {
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: acceptance check: score ${reply.score}/100` +
          (reply.band ? ` (band: ${reply.band})` : "") +
          (reply.note ? ` — ${reply.note}` : "") +
          ` (passing score: ${ACCEPTANCE_PASSING_SCORE})`
      );
    }
    if (reply) {
      recentRollingScores.push(reply.score);
      if (recentRollingScores.length > ACCEPTANCE_WINDOW_SIZE) recentRollingScores.shift();
    }
    await saveRollingState(validationOutputFile.replace(".md", "-rolling-state.json"), recentRollingScores, {
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });

    if (meetsAcceptanceCriteria(recentRollingScores)) {
      const avg = computeRollingAverage(recentRollingScores);
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: rolling average ${avg.toFixed(1)}/100 ` +
          `(${recentRollingScores.length} checks) meets the passing score ` +
          `${ACCEPTANCE_PASSING_SCORE}. Accepted.`
      );
      break;
    }

    // Per-chapter feedback (fresh author agent per chapter, chapter-tagged findings).
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const feedbackAuthor = await harness.createAgentHandle({
        name: `wiki-feedback-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
        systemPrompt: buildWikiAuthorSystemPrompt(ctx),
        tools: fsGate.tools,
        approve: fsGate.approve,
        cwd: volumeDir,
        maxSteps: 40,
      });
      try {
        const feedbackResult = await feedbackAuthor.sendTurn(
          buildWikiSegmentFeedbackPrompt(ctx, segment, si),
          { label: `jump-in-wiki-feedback-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` }
        );
        assertRealToolCalls(feedbackResult, `the author agent (feedback pass, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        await assertWroteWithFallback(
          [wikiOutputFile, sharedWikiOutputFile],
          `the author agent (feedback pass, chapter ${segment.id})`,
          feedbackResult?.text
        );
      } finally {
        await feedbackAuthor.close();
      }
    }

    if (iteration === maxValidationIterations) {
      ctx.limitReached = true;
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit ` +
          `without a passing grade. The last feedback pass is unvalidated; re-run the task to validate it.`
      );
      if (ON_QA_LIMIT === "fail") {
        throw new Error(
          `Volume ${values.INSTALLMENT_NUMBER}: hit the validation iteration limit ` +
            `without a passing grade (ON_QA_LIMIT=fail).`
        );
      }
      break;
    }
  }
}

/**
 * Process a single volume: generate the wiki (author agent) -> QA loop
 * (independent validator agent + one-shot acceptance + same author session
 * for feedback). Chunked (fallback) volumes take runChunkedVolumeAgent instead.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (see jumpInWiki()).
 */
async function runVolumeAgent(ctx) {
  const {
    values,
    volumeDir,
    wikiOutputFile,
    sharedWikiOutputFile,
    wikiAndSharedWikiExists,
  } = ctx;

  // Chunked (fallback) volumes take the per-chapter flow instead.
  if (ctx.chunked) {
    await runChunkedVolumeAgent(ctx);
    return;
  }

  // File tools gated to this volume's folder (reads are allowed anywhere,
  // so the agents can also read the volume source and the previous volume).
  const fsGate = await harness.createGatedFsTools({
    cwd: volumeDir,
    allowedDirs: [volumeDir],
  });
  ctx.fsGate = fsGate;

  // Remove stale strays from earlier runs (agent name drift): the workflow
  // itself never writes files with the classic marker names, so anything
  // named like that in the volume folder is garbage that only wastes agent
  // steps (observed live: a validator audited a stale stray wiki).
  for (const stray of [
    `jump-in-wiki-${values.INSTALLMENT_NUMBER}.md`,
    "jump-in-wiki-shared.md",
  ]) {
    const strayPath = path.join(volumeDir, stray);
    if (await fileExists(strayPath)) {
      await fs.rm(strayPath);
      console.log(`Removed the stale file "${stray}" (leftover from a previous run).`);
    }
  }

  // The author agent keeps its session across the generation and feedback
  // turns of this volume.
  const author = await harness.createAgentHandle({
    name: `wiki-author-${values.INSTALLMENT_NUMBER}`,
    systemPrompt: buildWikiAuthorSystemPrompt(ctx),
    tools: fsGate.tools,
    approve: fsGate.approve,
    cwd: volumeDir,
    maxSteps: 40,
  });
  try {
    // the logic for generating the wiki
    if (wikiAndSharedWikiExists) {
      console.log("Wiki for the current volume exists. skipping initial generation and proceeding to validation");
    } else {
      console.log("Calling the AI for initial wiki generation (author agent)...");
      // Scaffold stubs: pre-create both output files so the agent overwrites
      // existing files (a stronger name anchor than "create a new file") and
      // a crashed run leaves identifiable stubs instead of nothing.
      if (!(await fileExists(wikiOutputFile))) {
        await fs.writeFile(
          wikiOutputFile,
          `(stub — the agent replaces this with the complete volume wiki for volume ${values.INSTALLMENT_NUMBER})\n`,
          "utf8"
        );
      }
      if (!(await fileExists(sharedWikiOutputFile))) {
        await fs.writeFile(
          sharedWikiOutputFile,
          `(stub — the agent replaces this with the complete shared wiki)\n`,
          "utf8"
        );
      }
      const wikiGenResult = await author.sendTurn(buildWikiAuthorTurnPrompt(ctx), {
        label: `jump-in-wiki-generate-${values.INSTALLMENT_NUMBER}`,
      });
      assertRealToolCalls(wikiGenResult, "the author agent", values.INSTALLMENT_NUMBER);
      const wikiFallbackUsed = await assertWroteWithFallback(
        [wikiOutputFile, sharedWikiOutputFile],
        "the author agent",
        wikiGenResult?.text
      );

      // Recovery turn: if the model replied in chat instead of writeFile,
      // send a second turn asking it to write both files using the content
      // it already generated (the model's session still has that context).
      if (wikiFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
        console.log(
          `Volume ${values.INSTALLMENT_NUMBER}: sending recovery turn ` +
            `(model replied in chat instead of writeFile)...`
        );
        const wikiHasContent = wikiGenResult?.text && wikiGenResult.text.trim().length > 0;
        const wikiRecoveryPrompt = wikiHasContent
          ? `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
            `Both files have been temporarily written from your chat reply, but they must be written properly using writeFile. ` +
            `Please rewrite both files using writeFile now. Use the exact same content you generated in your previous message: ` +
            `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`
          : `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you produced no output.\n\n` +
            `Please read the source materials and write both files using writeFile now: ` +
            `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`;
        const wikiRecoveryResult = await author.sendTurn(
          wikiRecoveryPrompt,
          { label: `jump-in-wiki-recovery-${values.INSTALLMENT_NUMBER}` }
        );
        assertRealToolCalls(wikiRecoveryResult, "the author agent (recovery)", values.INSTALLMENT_NUMBER);
        // Overwrite with the recovery output (may be the same content, now via writeFile).
        await assertWroteWithFallback(
          [wikiOutputFile, sharedWikiOutputFile],
          "the author agent (recovery)",
          wikiRecoveryResult?.text
        );
      }
    }

    await runQaLoop(ctx, author);
  } finally {
    await author.close();
  }
}

/**
 * QA loop: independent validator agent (fresh per iteration) ->
 * score-based acceptance check (0–100, see configs/shared.js) -> feedback
 * applied by the same author session that generated the wiki. Runs the
 * shared loop from utils/qa-loop.js with the wiki-specific pieces supplied
 * here (the wiki keeps its author session for the feedback pass, unlike the
 * other tasks' fresh-agent-per-iteration feedback).
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 * @param {AgentHandle} author - The author agent handle (keeps its session).
 */
async function runQaLoop(ctx, author) {
  const { values, volumeDir, sourceFile, validationOutputFile, fsGate } = ctx;
  const result = await runSharedQaLoop({
    volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
    iterationLogLine: (iteration) => `Validation iteration ${iteration}/${maxValidationIterations}...`,
    validatorLogLine: () => "Calling the AI for validation (validator agent)...",
    acceptanceLogLine: () => "Calling the AI for the acceptance check...",
    maxIterations: maxValidationIterations,
    onQaLimit: ON_QA_LIMIT,
    validationOutputFile,
    stateFile: validationOutputFile.replace(".md", "-rolling-state.json"),
    sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    createValidatorAgent: async (iteration) => harness.createAgentHandle({
      name: `wiki-validator-${values.INSTALLMENT_NUMBER}-${iteration}`,
      systemPrompt: buildWikiValidatorSystemPrompt(ctx),
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      // scaled to the source size (see validatorMaxStepsFor)
      maxSteps: validatorMaxStepsFor((await fs.stat(sourceFile)).size),
    }),
    buildValidatorTurn: (iteration) => buildWikiValidatorTurnPrompt(ctx),
    validatorLabel: (iteration) => `jump-in-wiki-validate-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryLabel: (iteration) => `jump-in-wiki-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryPrompt: (hasContent) => hasContent
      ? `You were asked to write the validation report to "jump-in-wiki-validation-NN.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
        `The file has been temporarily written from your chat reply, but it must be written properly using writeFile. ` +
        `Please rewrite the complete validation report using writeFile now. Use the exact same content you generated in your previous message.`
      : `You were asked to write the validation report using writeFile, but you produced no output.\n\n` +
        `Please read the source materials and write the complete validation report using writeFile now.`,
    assertRealToolCalls: (result, who) => assertRealToolCalls(result, who, values.INSTALLMENT_NUMBER),
    acceptanceCheck: (iteration) => wikiAcceptanceCheck(ctx, iteration),
    feedbackLogLine: () => "Calling the AI to apply the validation feedback (author agent)...",
    runFeedback: (iteration) => runWikiFeedback(ctx, author, iteration),
    limitReachedLogLine: () => `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit (${maxValidationIterations}) without a passing grade. The last feedback pass is unvalidated; re-run the task to validate it.`,
  });
  ctx.limitReached = result.limitReached;
  return result;
}

/**
 * The wiki acceptance check (called by the shared QA loop in
 * utils/qa-loop.js): a tool-less one-shot over the wiki artifacts + the
 * standard validation report; the model scores 0–100 as a JSON reply.
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
 * @param {number} iteration - The current QA iteration (for the log label).
 * @returns {Promise<number|null>} The parsed score, or `null` when no valid
 *   score could be extracted (treated as a failed check).
 */
async function wikiAcceptanceCheck(ctx, iteration) {
  const { values, validationOutputFile } = ctx;
  const acceptanceOutput = await harness.runOneShot({
    systemPrompt: ctx.acceptanceSystemPrompt,
    messages: [
      { file: ctx.wikiOutputFile, name: "wiki.md" },
      { file: ctx.sharedWikiOutputFile, name: "shared-wiki.md" },
      { file: validationOutputFile, name: path.basename(validationOutputFile) },
      { text: ctx.acceptanceUserPrompt },
    ],
    label: `jump-in-wiki-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}`,
  });
  const reply = parseAcceptanceReply(acceptanceOutput);
  if (reply === null) {
    console.log(
      `Acceptance check: no valid score in response ` +
        `(got: ${JSON.stringify(acceptanceOutput.trim().slice(0, 120))}). ` +
        `Counting this check as a failure.`
    );
  } else {
    console.log(
      `Acceptance check: score ${reply.score}/100` +
        (reply.band ? ` (band: ${reply.band})` : "") +
        (reply.note ? ` — ${reply.note}` : "") +
        ` (passing score: ${ACCEPTANCE_PASSING_SCORE})`
    );
  }
  return reply ? reply.score : null;
}

/**
 * The wiki feedback stage (called by the shared QA loop in
 * utils/qa-loop.js): the SAME author session that generated the wiki applies
 * the validation report (the wiki task reuses its session; the other tasks
 * use a fresh author agent per feedback pass).
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
 * @param {AgentHandle} author - The author agent handle (keeps its session).
 * @param {number} iteration - The current QA iteration (for the labels).
 */
async function runWikiFeedback(ctx, author, iteration) {
  const { values, wikiOutputFile, sharedWikiOutputFile } = ctx;
  const wikiFeedbackResult = await author.sendTurn(
    buildWikiFeedbackTurnPrompt(ctx),
    { label: `jump-in-wiki-feedback-${values.INSTALLMENT_NUMBER}-${iteration}` }
  );
  assertRealToolCalls(wikiFeedbackResult, "the author agent (feedback pass)", values.INSTALLMENT_NUMBER);
  const wikiFeedbackFallbackUsed = await assertWroteWithFallback(
    [wikiOutputFile, sharedWikiOutputFile],
    "the author agent (feedback pass)",
    wikiFeedbackResult?.text
  );

  // Recovery turn for feedback pass: if the model produced no output,
  // re-send the full feedback task.
  if (wikiFeedbackFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
    const wikiFeedbackHasContent = wikiFeedbackResult?.text && wikiFeedbackResult.text.trim().length > 0;
    const wikiFeedbackRecoveryPrompt = wikiFeedbackHasContent
      ? `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
        `Both files have been temporarily written from your chat reply, but they must be written properly using writeFile. ` +
        `Please rewrite both files using writeFile now. Use the exact same content you generated in your previous message: ` +
        `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`
      : `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you produced no output.\n\n` +
        `Please read the source materials and the validation report and write both files using writeFile now: ` +
        `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`;
    const wikiFeedbackRecoveryResult = await author.sendTurn(
      wikiFeedbackRecoveryPrompt,
      { label: `jump-in-wiki-feedback-recovery-${values.INSTALLMENT_NUMBER}-${iteration}` }
    );
    assertRealToolCalls(wikiFeedbackRecoveryResult, "the author agent (feedback recovery)", values.INSTALLMENT_NUMBER);
    await assertWroteWithFallback(
      [wikiOutputFile, sharedWikiOutputFile],
      "the author agent (feedback recovery)",
      wikiFeedbackRecoveryResult?.text
    );
  }
}

// ─── Export for use as a module ─────────────────────────────────────────────

module.exports = {
  jumpInWiki,
  installmentNumberFromDir,
  transformUserPrompt,
  isPassingVerdict,
  parseAcceptanceScore,
  validatorMaxStepsFor,
  writePromptDump,
  emittedToolCallAsText,
  assertRealToolCalls,
  buildWikiAuthorSystemPrompt,
  buildWikiValidatorSystemPrompt,
  buildWikiAuthorTurnPrompt,
  buildWikiValidatorTurnPrompt,
  buildWikiFeedbackTurnPrompt,
  buildWikiSectionTurnPrompt,
  buildWikiMergeTurnPrompt,
  buildWikiSegmentValidatorPrompt,
  buildWikiFindingsMergePrompt,
  buildWikiSegmentFeedbackPrompt,
  runVolumeAgent,
  runChunkedVolumeAgent,
  runChunkedQaLoop,
};

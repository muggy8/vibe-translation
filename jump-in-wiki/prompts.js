/**
 * Every prompt this task sends: the author system prompt, the validator's, the whole-
 * volume turn prompts (author / validator / feedback), and the chapter-by-chapter ones
 * (section author, merge, per-segment validator, findings merge, per-segment feedback).
 *
 * The prompt files themselves stay mode-agnostic; the agent tool note is appended in
 * code. When the glossary task has already written this volume's glossary.md, the
 * author / validator / feedback prompts offer it as a READ-ONLY canonical reference, so
 * the shared wiki's Glossary section uses canonical renderings instead of model memory.
 *
 * Part of the jump-in-wiki.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError } = require("../configs/shared");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

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

// The shared utilities from utils/prompt.js and utils/manifest.js that tests and
// glossary.js import from this module are re-exported by the module.exports object
// at the bottom of this file, from the same require() bindings this file already holds.

// ─── Task ───────────────────────────────────────────────────────────────────


module.exports = {
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
};

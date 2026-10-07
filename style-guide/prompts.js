/**
 * Every prompt this task sends: the extraction and compile system prompts, the whole-volume turn prompts, and the chapter-by-chapter findings-merge prompt.
 *
 * Part of the style-guide.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types");
const { transformUserPrompt } = require("../utils/prompt");
const { AGENT_TOOLS_NOTE } = require("../configs/shared");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { styleIndexBlock } = require("./reference-index");
const { styleWriteInstruction } = require("./amend");

/**
 * Build the extraction turn prompt for a single volume.
 * @param {StyleGuideVolumeCtx} ctx
 * @returns {string}
 */
function buildExtractTurnPrompt(ctx) {
  return transformUserPrompt(ctx.extractUserPrompt, ctx.values);
}


/**
 * Build the author (compile) turn prompt for a single volume.
 *
 * The preamble names every material at its real path: the previous volume's
 * guide lives in the previous volume's folder
 * (`../<previous folder>/style-guide.md`) — the same convention as
 * character-voice.js — so the agent never has to guess where to read.
 * With `seg` set (chunked fallback) the pass is scoped to one chapter.
 *
 * @param {StyleGuideVolumeCtx} ctx
 * @param {string} extractionResults
 * @param {SourceSegment|null} [seg] - The chapter being processed (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {string}
 */
function buildAuthorTurnPrompt(ctx, extractionResults, seg = null, si = null) {
  const { isFirst, previousFolderName } = ctx;
  const amendPrompt = transformUserPrompt(ctx.authorUserPrompt, {
    ...ctx.values,
    EXTRACTION_RESULTS: extractionResults || "(none — this is the first volume)",
  });
  let sourceLine;
  let previousGuideLine;
  let chapterBlock = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    previousGuideLine =
      si === 0
        ? isFirst
          ? "- The previous style guide: (absent — this is the first volume)"
          : `- The previous style guide: "../${previousFolderName}/style-guide.md"`
        : `- The current style guide (state after the earlier chapters of this volume): "style-guide.md" (same folder)`;
    chapterBlock = chapterContextBlock(ctx.values, ctx.bundle, seg, si);
  } else {
    sourceLine = ctx.bundle
      ? sourceMaterialLine(ctx.bundle)
      : `- The volume source: "${path.basename(ctx.sourceFile)}" (same folder)`;
    previousGuideLine = isFirst
      ? "- The previous style guide: (absent — this is the first volume)"
      : `- The previous style guide: "../${previousFolderName}/style-guide.md"`;
  }
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterBlock +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    previousGuideLine +
    `\nOptional cross-reference material (read if present in your working folder):\n` +
    `- "glossary.md" — the current glossary snapshot (canonical names)\n` +
    `- "character-voice.md" — the current character voice reference (formality and voice data)\n` +
    `\n` +
    styleIndexBlock(ctx) +
    styleWriteInstruction(Boolean(ctx.styleSeeded), "amend") +
    amendPrompt
  );
}


/**
 * Build the validator turn prompt for a single volume. With `seg` set
 * (chunked fallback) the pass audits ONE chapter and writes a partial report.
 *
 * @param {StyleGuideVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter being audited (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {string}
 */
function buildValidatorTurnPrompt(ctx, seg = null, si = null) {
  const { isFirst, previousFolderName } = ctx;
  const previousGuideLine = isFirst
    ? ""
    : `- The previous style guide: "../${previousFolderName}/style-guide.md"\n`;
  const reportFile = seg ? `style-guide-validation-${seg.id}.md` : "style-guide-validation.md";
  let sourceLine;
  let chapterBlock = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    chapterBlock =
      chapterContextBlock(ctx.values, ctx.bundle, seg, si) +
      `This is a per-chapter validation pass: audit the style guide against ONE chapter only. ` +
      `Tag every finding with the chapter id "${seg.id}" (e.g. a prefix "[${seg.id}] ").\n`;
  } else {
    sourceLine = ctx.bundle
      ? sourceMaterialLine(ctx.bundle)
      : `- The volume source: "${path.basename(ctx.sourceFile)}" (same folder)`;
  }
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterBlock +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    `- The amended style guide under audit: "style-guide.md" (same folder)\n` +
    previousGuideLine +
    `\n` +
    `Write the complete validation report to the file "${reportFile}" in your working folder (writeFile, exact format from the system prompt).\n\n` +
    transformUserPrompt(ctx.validatorUserPrompt, ctx.values)
  );
}


/**
 * Build the feedback turn prompt for a single volume. With `seg` set
 * (chunked fallback) the pass applies the chapter-tagged findings only.
 *
 * @param {StyleGuideVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter whose findings are applied (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {string}
 */
function buildFeedbackTurnPrompt(ctx, seg = null, si = null) {
  const { isFirst, previousFolderName } = ctx;
  const previousGuideLine = isFirst
    ? ""
    : `- The previous style guide: "../${previousFolderName}/style-guide.md"\n`;
  let sourceLine;
  let chapterBlock = "";
  let scopeLine = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    chapterBlock = chapterContextBlock(ctx.values, ctx.bundle, seg, si);
    scopeLine = ` — apply ONLY the findings tagged with chapter "${seg.id}"`;
  } else {
    sourceLine = ctx.bundle
      ? sourceMaterialLine(ctx.bundle)
      : `- The volume source: "${path.basename(ctx.sourceFile)}" (same folder)`;
  }
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterBlock +
    `The validation report "style-guide-validation.md" in your working folder is your work order${scopeLine}.\n` +
    `Materials (read with readFile before changing anything):\n` +
    `${sourceLine}\n` +
    `- The current style guide to correct: "style-guide.md" (same folder)\n` +
    previousGuideLine +
    `\n` +
    styleIndexBlock(ctx) +
    styleWriteInstruction(true, "correct") +
    `Verifying the report's findings against the source is part of the job, but it is not the ` +
    `job. The report already quotes the source lines it is complaining about, so:\n` +
    `- Check a batch of findings with ONE grep (its pattern may be several phrases separated by ` +
    `|) instead of one search per finding, and read the quoted line ranges in as few readFile ` +
    `calls as the layout allows.\n` +
    `- Apply each fix with editFile as soon as it is confirmed. Do not verify everything first ` +
    `and then start editing: if you run out of steps, the fixes you already applied still stand.\n` +
    `- If a finding cannot be confirmed from the source, say so in your final summary and leave ` +
    `that rule alone rather than spending more steps on it.\n\n` +
    transformUserPrompt(ctx.feedbackUserPrompt, ctx.values)
  );
}


/**
 * The findings-merge turn prompt (chunked fallback): consolidates the
 * per-chapter partial reports into the standard style-guide-validation.md so
 * the unchanged acceptance one-shot can score it.
 *
 * @param {StyleGuideVolumeCtx} ctx
 * @returns {string}
 */
function buildStyleFindingsMergePrompt(ctx) {
  const list = ctx.bundle.segments
    .map((s) => `- "style-guide-validation-${s.id}.md" (chapter ${s.id})`)
    .join("\n");
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `You are consolidating the per-chapter validation partials of volume ` +
    `${ctx.values.INSTALLMENT_NUMBER} into the single standard validation report.\n` +
    `Materials (read with readFile before writing anything):\n` +
    list +
    `\n\n` +
    `Write the consolidated report to the file "style-guide-validation.md" in your ` +
    `working folder (writeFile, complete contents) using EXACTLY the report format ` +
    `from your system prompt. Preserve the chapter tags on the findings, keep every ` +
    `valid finding (deduplicate repeats), and produce the summary/verdict sections ` +
    `the format requires, as if you had audited the whole volume in one pass.`
  );
}


function buildExtractSystemPrompt(base) { return base + AGENT_TOOLS_NOTE; }

function buildAuthorSystemPrompt(base) { return base + AGENT_TOOLS_NOTE; }

function buildValidatorSystemPrompt(base) { return base + AGENT_TOOLS_NOTE; }



module.exports = {
  buildExtractTurnPrompt,
  buildAuthorTurnPrompt,
  buildValidatorTurnPrompt,
  buildFeedbackTurnPrompt,
  buildStyleFindingsMergePrompt,
  buildExtractSystemPrompt,
  buildAuthorSystemPrompt,
  buildValidatorSystemPrompt,
};

/**
 * The turn prompts: what each agent in this stage is asked to do, at its real file
 * paths (the previous volume's glossary at ../<previous folder>/glossary.md), so an
 * agent never has to guess where to read.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions
const { transformUserPrompt } = require("../utils/prompt");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  sourceSegmentListLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { glossaryIndexBlock, glossaryWriteInstruction } = require("./authoring");

/**
 * The author agent's turn prompt (agent mode): the amended-glossary request
 * with the term list and research-notes references filled in.
 *
 * With `seg` set (chunked fallback) the prompt is scoped to one chapter: the
 * source line names the chapter file, and the "previous glossary" line points
 * at the previous volume (first chapter) or at the current in-volume state
 * (later chapters).
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include glossaryTemplate).
 * @param {Array<{term: string, type: string, query: string}>} terms - The new terms.
 * @param {boolean} researchNotesAvailable - Whether glossary-research.md exists.
 * @param {SourceSegment|null} [seg] - The chapter being processed (fallback).
 * @param {number} [si] - Zero-based position of the chapter in reading order.
 * @returns {string}
 */
function buildGlossaryAuthorTurnPrompt(ctx, terms, researchNotesAvailable, seg = null, si = null) {
  const { values, isFirst, previousFolderName } = ctx;
  // True when the workflow already copied the previous glossary into this
  // volume's folder (seedGlossaryFromPrevious) — the agent amends, not recreates.
  const seeded = Boolean(ctx.glossarySeeded);
  const termsListText =
    terms.length > 0
      ? terms.map((t) => `- ${t.term} (${t.type})`).join("\n")
      : "(no new terms found in this volume)";
  const researchNotesPlaceholder = researchNotesAvailable
    ? `The research notes for the new terms are in the file "glossary-research.md" in your working folder (read it with readFile).`
    : "(research disabled or no new terms to research)";
  const amendPrompt = transformUserPrompt(ctx.glossaryTemplate, {
    ...values,
    TERMS_LIST: termsListText,
    RESEARCH_NOTES: researchNotesPlaceholder,
    // The disputes queue is a first-class input: the amend pass is the only
    // stage that can settle a challenged rendering, so it has to see it.
    DISPUTES: (ctx.disputesText || "").trim() || "(no open glossary disputes)",
  });
  let sourceLine;
  let previousGlossaryLine;
  let chapterBlock = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    previousGlossaryLine =
      si === 0
        ? isFirst
          ? "- The previous glossary: (absent — this is the first volume)"
          : seeded
            ? `- The glossary to amend: "glossary.md" (same folder — already a verbatim ` +
              `copy of "../${previousFolderName}/glossary.md")`
            : `- The previous glossary: "../${previousFolderName}/glossary.md"`
        : `- The current glossary (state after the earlier chapters of this volume): "glossary.md" (same folder)`;
    chapterBlock = chapterContextBlock(values, ctx.bundle, seg, si);
  } else {
    sourceLine =
      ctx.bundle
        ? sourceMaterialLine(ctx.bundle)
        : `- The volume source: "${ctx.folderName}.md" (same folder)`;
    previousGlossaryLine = isFirst
      ? "- The previous glossary: (absent — this is the first volume)"
      : seeded
        ? `- The glossary to amend: "glossary.md" (same folder — already a verbatim ` +
          `copy of "../${previousFolderName}/glossary.md")`
        : `- The previous glossary: "../${previousFolderName}/glossary.md"`;
  }
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterBlock +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    previousGlossaryLine +
    `\n` +
    glossaryIndexBlock(ctx) +
    glossaryWriteInstruction(Boolean(ctx.glossarySeeded), "amend") +
    amendPrompt
  );
}


/**
 * The validator agent's turn prompt (agent mode, one fresh agent per QA
 * iteration).
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include validatorPrompt).
 * @returns {string}
 */
function buildGlossaryValidatorTurnPrompt(ctx) {
  const { isFirst, previousFolderName } = ctx;
  const previousGlossaryLine = isFirst
    ? ""
    : `- The previous glossary: "../${previousFolderName}/glossary.md"\n`;
  const sourceLine = ctx.bundle
    ? sourceMaterialLine(ctx.bundle)
    : `- The volume source: "${ctx.folderName}.md" (same folder)`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    `- The amended glossary under audit: "glossary.md" (same folder)\n` +
    previousGlossaryLine +
    `\n` +
    `Write the complete validation report to the file "glossary-validation.md" in ` +
    `your working folder (writeFile, exact format from the system prompt).\n\n` +
    ctx.validatorPrompt
  );
}


/**
 * The author agent's feedback turn prompt (agent mode).
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include feedbackPrompt).
 * @returns {string}
 */
function buildGlossaryFeedbackTurnPrompt(ctx) {
  const { isFirst, previousFolderName } = ctx;
  const previousGlossaryLine = isFirst
    ? ""
    : `- The previous glossary: "../${previousFolderName}/glossary.md"\n`;
  const sourceLine = ctx.bundle
    ? sourceMaterialLine(ctx.bundle)
    : `- The volume source: "${ctx.folderName}.md" (same folder)`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `The validation report "glossary-validation.md" in your working folder is your ` +
    `work order.\n` +
    `Materials (read with readFile before changing anything):\n` +
    `${sourceLine}\n` +
    `- The current glossary to correct: "glossary.md" (same folder)\n` +
    previousGlossaryLine +
    `\n` +
    glossaryIndexBlock(ctx) +
    glossaryWriteInstruction(true, "correct") +
    ctx.feedbackPrompt
  );
}


/**
 * The per-chapter validator turn prompt (chunked fallback). Each pass audits
 * the glossary against ONE chapter and writes a partial report named
 * glossary-validation-<id>.md; the findings-merge pass consolidates the
 * partials into the standard glossary-validation.md.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {SourceSegment} segment - The chapter being audited.
 * @param {number} si - Zero-based position in reading order.
 * @returns {string}
 */
function buildGlossarySegmentValidatorPrompt(ctx, segment, si) {
  const { values, isFirst, previousFolderName } = ctx;
  const partialFile = `glossary-validation-${segment.id}.md`;
  const previousGlossaryLine = isFirst
    ? ""
    : `- The previous glossary: "../${previousFolderName}/glossary.md"\n`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterContextBlock(values, ctx.bundle, segment, si) +
    `This is a per-chapter validation pass: audit the glossary against ONE chapter only.\n` +
    `Materials (read with readFile before writing anything):\n` +
    `- The chapter source: "${segment.file}" (same folder)\n` +
    `- The glossary under audit: "glossary.md" (same folder)\n` +
    previousGlossaryLine +
    `\n` +
    `Check that everything this chapter introduces (terms, names, concepts) is ` +
    `covered correctly in the glossary, and that nothing contradicts the chapter. ` +
    `Tag every finding with the chapter id "${segment.id}" (e.g. a prefix "[${segment.id}] ").\n` +
    `Write the partial validation report to the file "${partialFile}" in your working ` +
    `folder (writeFile, the report format from the system prompt).\n\n` +
    ctx.validatorPrompt
  );
}


/**
 * The findings-merge turn prompt (chunked fallback): consolidates the
 * per-chapter partial reports into the standard glossary-validation.md so the
 * unchanged acceptance one-shot can score it.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @returns {string}
 */
function buildGlossaryFindingsMergePrompt(ctx) {
  const { values } = ctx;
  const list = ctx.bundle.segments
    .map((s) => `- "glossary-validation-${s.id}.md" (chapter ${s.id})`)
    .join("\n");
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `You are consolidating the per-chapter validation partials of volume ` +
    `${values.INSTALLMENT_NUMBER} into the single standard validation report.\n` +
    `Materials (read with readFile before writing anything):\n` +
    list +
    `\n\n` +
    `Write the consolidated report to the file "glossary-validation.md" in your ` +
    `working folder (writeFile, complete contents) using EXACTLY the report format ` +
    `from your system prompt. Preserve the chapter tags on the findings, keep every ` +
    `valid finding (deduplicate repeats), and produce the summary/verdict sections ` +
    `the format requires, as if you had audited the whole volume in one pass.`
  );
}


/**
 * The per-chapter feedback turn prompt (chunked fallback): applies the
 * chapter-tagged findings of the consolidated report to the glossary.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {SourceSegment} segment - The chapter whose findings are applied.
 * @param {number} si - Zero-based position in reading order.
 * @returns {string}
 */
function buildGlossarySegmentFeedbackPrompt(ctx, segment, si) {
  const { values } = ctx;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterContextBlock(values, ctx.bundle, segment, si) +
    `The validation report "glossary-validation.md" in your working folder is your ` +
    `work order — apply ONLY the findings tagged with chapter "${segment.id}".\n` +
    `Materials (read with readFile before changing anything):\n` +
    `- The chapter source: "${segment.file}" (same folder)\n` +
    `- The current glossary to correct: "glossary.md" (same folder)\n` +
    `\n` +
    glossaryIndexBlock(ctx) +
    glossaryWriteInstruction(true, "correct") +
    `Do not touch entries this chapter's findings do not concern.\n\n` +
    ctx.feedbackPrompt
  );
}


module.exports = {
  buildGlossaryAuthorTurnPrompt,
  buildGlossaryValidatorTurnPrompt,
  buildGlossaryFeedbackTurnPrompt,
  buildGlossarySegmentValidatorPrompt,
  buildGlossaryFindingsMergePrompt,
  buildGlossarySegmentFeedbackPrompt,
};

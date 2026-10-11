/**
 * Every prompt this task sends: the extraction and compile system prompts, the whole-volume turn prompts, and the chapter-by-chapter findings-merge prompt. The prompt files stay mode-agnostic; the agent tool note is appended in code.
 *
 * Part of the character-voice.js layer (split out of the original single file).
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

const { voiceIndexBlock } = require("./reference-index");
const { voiceWriteInstruction } = require("./amend");

/**
 * Build the extraction turn prompt for a single volume.
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {string}
 */
function buildExtractTurnPrompt(ctx) {
  return transformUserPrompt(ctx.extractUserPrompt, ctx.values);
}


/**
 * Build the author (compile) turn prompt for a single volume.
 *
 * The preamble names every material at its real path: the previous volume's
 * reference lives in the previous volume's folder
 * (`../<previous folder>/character-voice.md`), not in the working folder —
 * the same convention as glossary.js, so the agent never has to guess where
 * to read. With `seg` set (chunked fallback) the pass is scoped to one
 * chapter.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
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
  let previousRefLine;
  let chapterBlock = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    previousRefLine =
      si === 0
        ? isFirst
          ? "- The previous character voice reference: (absent — this is the first volume)"
          : `- The previous character voice reference: "../${previousFolderName}/character-voice.md"`
        : `- The current character voice reference (state after the earlier chapters of this volume): "character-voice.md" (same folder)`;
    chapterBlock = chapterContextBlock(ctx.values, ctx.bundle, seg, si);
  } else {
    sourceLine = ctx.bundle
      ? sourceMaterialLine(ctx.bundle)
      : `- The volume source: "${path.basename(ctx.sourceFile)}" (same folder)`;
    previousRefLine = isFirst
      ? "- The previous character voice reference: (absent — this is the first volume)"
      : `- The previous character voice reference: "../${previousFolderName}/character-voice.md"`;
  }
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterBlock +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    previousRefLine +
    `\n\n` +
    voiceIndexBlock(ctx) +
    voiceWriteInstruction(Boolean(ctx.voiceSeeded), "amend") +
    amendPrompt
  );
}


/**
 * Build the validator turn prompt for a single volume. With `seg` set
 * (chunked fallback) the pass audits ONE chapter and writes a partial report.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter being audited (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {string}
 */
function buildValidatorTurnPrompt(ctx, seg = null, si = null) {
  const { isFirst, previousFolderName } = ctx;
  const previousRefLine = isFirst
    ? ""
    : `- The previous character voice reference: "../${previousFolderName}/character-voice.md"\n`;
  const reportFile = seg ? `character-voice-validation-${seg.id}.md` : "character-voice-validation.md";
  let sourceLine;
  let chapterBlock = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    chapterBlock =
      chapterContextBlock(ctx.values, ctx.bundle, seg, si) +
      `This is a per-chapter validation pass: audit the reference and POV map against ONE chapter only. ` +
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
    `- The amended character voice reference under audit: "character-voice.md" (same folder)\n` +
    `- The POV map under audit: "pov-map.md" (same folder)\n` +
    previousRefLine +
    `\n` +
    `Write the complete validation report to the file "${reportFile}" in your working folder (writeFile, exact format from the system prompt).\n\n` +
    transformUserPrompt(ctx.validatorUserPrompt, ctx.values)
  );
}


/**
 * Build the feedback turn prompt for a single volume. With `seg` set
 * (chunked fallback) the pass applies the chapter-tagged findings only.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter whose findings are applied (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {string}
 */
function buildFeedbackTurnPrompt(ctx, seg = null, si = null) {
  const { isFirst, previousFolderName } = ctx;
  const previousRefLine = isFirst
    ? ""
    : `- The previous character voice reference: "../${previousFolderName}/character-voice.md"\n`;
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
    `The validation report "character-voice-validation.md" in your working folder is your work order${scopeLine}.\n` +
    `Materials (read with readFile before changing anything):\n` +
    `${sourceLine}\n` +
    `- The current character voice reference to correct: "character-voice.md" (same folder)\n` +
    `- The current POV map to correct: "pov-map.md" (same folder)\n` +
    previousRefLine +
    `\n` +
    voiceIndexBlock(ctx) +
    voiceWriteInstruction(true, "correct") +
    `Verifying the report's findings against the source is part of the job, but it is not the ` +
    `job. The report already quotes the source lines it is complaining about, so:\n` +
    `- Check a batch of findings with ONE grep (its pattern may be several phrases separated by ` +
    `|) instead of one search per finding, and read the quoted line ranges in as few readFile ` +
    `calls as the layout allows.\n` +
    `- Apply each fix with editFile as soon as it is confirmed. Do not verify everything first ` +
    `and then start editing: if you run out of steps, the fixes you already applied still stand.\n` +
    `- If a finding cannot be confirmed from the source, say so in your final summary and leave ` +
    `that entry alone rather than spending more steps on it.\n\n` +
    transformUserPrompt(ctx.feedbackUserPrompt, ctx.values)
  );
}


/**
 * The findings-merge turn prompt (chunked fallback): consolidates the
 * per-chapter partial reports into the standard character-voice-validation.md
 * so the unchanged acceptance one-shot can score it.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {string}
 */
function buildVoiceFindingsMergePrompt(ctx) {
  const list = ctx.bundle.segments
    .map((s) => `- "character-voice-validation-${s.id}.md" (chapter ${s.id})`)
    .join("\n");
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `You are consolidating the per-chapter validation partials of volume ` +
    `${ctx.values.INSTALLMENT_NUMBER} into the single standard validation report.\n` +
    `Materials (read with readFile before writing anything):\n` +
    list +
    `\n\n` +
    `Write the consolidated report to the file "character-voice-validation.md" in your ` +
    `working folder (writeFile, complete contents) using EXACTLY the report format ` +
    `from your system prompt. Preserve the chapter tags on the findings, keep every ` +
    `valid finding (deduplicate repeats), and produce the summary/verdict sections ` +
    `the format requires, as if you had audited the whole volume in one pass.`
  );
}


/**
 * The block that tells a chapter's extraction pass what this volume's own earlier chapters have
 * already produced.
 *
 * Why it exists. `chapterSegmentNote` tells every chapter of a chunked volume that "the cumulative
 * reference material already covers the chapters before it". In the stage that is true: chapter 4 is
 * shown the reference chapter 3's author pass just wrote. In the reading-only route
 * (`extract-voice.js` → `rebuild-voice.js`) there is no such file, so the same sentence would be a
 * lie and the extractor would re-claim what chapter 2 already found. This block is the honest
 * substitute: it names the chapters already read and the claims they produced, in a shape smaller
 * than the duplicate output it prevents.
 *
 * It lists **who and what kind**, not the claim text: the extractor needs to know a claim exists,
 * not to read it, and the claim text is already in the record.
 *
 * @param {{installmentNumber: string|number, segmentsTotal: number, doneSegments: string[], entries: Array<Object>}} opts
 * @returns {string|null} The block, or null when this is the first chapter (there is nothing yet).
 */
function buildAlreadyExtractedNote({ installmentNumber, segmentsTotal, doneSegments, entries }) {
  if (!Array.isArray(doneSegments) || doneSegments.length === 0) return null;

  /** @type {Map<string, Map<string, number>>} character → quirk label → how many claims */
  const byCharacter = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    // A POV claim names its character in `assignedCharacter`, not `character`. Reading only
    // `character` puts every POV claim under a heading that says nobody was named, which is noise
    // shown to the model.
    const named = entry.type === "pov" && typeof entry.assignedCharacter === "string" && entry.assignedCharacter.trim()
      ? entry.assignedCharacter.trim()
      : (typeof entry.character === "string" ? entry.character.trim() : "");
    const name = named || (entry.type === "pov" ? "(POV, unassigned)" : "(no character named)");
    const kind = entry.type === "pov"
      ? (typeof entry.marker === "string" && entry.marker.trim() ? `POV ${entry.marker.trim()}` : "POV")
      : (typeof entry.quirkType === "string" && entry.quirkType.trim() ? entry.quirkType.trim() : "voice");
    const kinds = byCharacter.get(name) || new Map();
    kinds.set(kind, (kinds.get(kind) || 0) + 1);
    byCharacter.set(name, kinds);
  }

  const lines = [...byCharacter.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, kinds]) => {
      const total = [...kinds.values()].reduce((sum, n) => sum + n, 0);
      return `- ${name}: ${[...kinds.entries()].map(([kind, n]) => `${kind} x${n}`).join(", ")} (${total} claim(s))`;
    });

  return (
    `## Already extracted in volume ${installmentNumber}\n\n` +
    `The chapters already read in this pass, in reading order: ${doneSegments.join(", ")} ` +
    `(${doneSegments.length} of ${segmentsTotal}). What they have already recorded:\n\n` +
    (lines.length ? lines.join("\n") : "- nothing yet") +
    `\n\nThe reference above covers the volumes BEFORE volume ${installmentNumber}; the list above is ` +
    `what this volume's own earlier chapters produced. Do not repeat a claim that is already recorded — ` +
    `extract only what this chapter adds or changes.`
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
  buildVoiceFindingsMergePrompt,
  buildAlreadyExtractedNote,
  buildExtractSystemPrompt,
  buildAuthorSystemPrompt,
  buildValidatorSystemPrompt,
};

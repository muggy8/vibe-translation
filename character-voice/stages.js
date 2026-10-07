/**
 * The two generation stages: one extraction one-shot (source → the quirk/POV JSON array), and the compile turn that reads the source, the reference it is amending, and the extraction results.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const harness = require("../harness");
const { inlineReferenceMessage } = require("../utils/fs");
const { assertRealToolCalls } = require("../utils/agents");
const { runWriteTurn } = require("../utils/qa-loop");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { parseVoiceQuirks, truncateVoiceRef, voiceAuthorMaxSteps, voiceRecoveryPrompt } = require("./amend");
const { buildAuthorSystemPrompt, buildAuthorTurnPrompt } = require("./prompts");

/**
 * Run the extraction stage: one-shot call to extract voice quirks and POV info.
 * With `seg` set (chunked fallback) the extraction is scoped to one chapter:
 * the source message is the chapter file and the cumulative reference is the
 * previous volume's reference (first chapter) or the current in-volume state.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter being extracted (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {Promise<string>}
 */
async function runExtract(ctx, seg = null, si = null) {
  const { values } = ctx;
  const labelSuffix = seg ? `-${seg.id}` : "";
  if (seg) {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: running voice/POV extraction for chapter ${seg.id}...`);
    const messages = [{ file: path.join(ctx.volumeDir, seg.file), name: seg.file }];
    const stateFile = si === 0 ? ctx.previousVoiceRefFile : ctx.voiceOutputFile;
    if (stateFile) {
      // Inlined (not readFile) — so the cumulative reference is bounded here.
      // Relevance-ordered: the characters this chapter actually contains are
      // shown even when they were introduced in volume 1 (see truncateVoiceRef).
      const chapterSource = await fs.readFile(path.join(ctx.volumeDir, seg.file), "utf8");
      messages.push(
        await inlineReferenceMessage(
          stateFile,
          si === 0 ? "character-voice-previous.md" : "character-voice-current.md",
          { truncate: (raw) => truncateVoiceRef(raw, chapterSource) }
        )
      );
    }
    messages.push({ text: ctx.extractPrompt }, { text: chapterSegmentNote(ctx.bundle, seg, si) });
    return harness.runOneShot({ systemPrompt: ctx.extractSystemPrompt, messages, label: `character-voice-extract-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
  }
  const { sourceFile } = ctx;
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running voice/POV extraction...`);
  const messages = [{ file: sourceFile, name: path.basename(sourceFile) }, { text: ctx.extractPrompt }];
  if (ctx.previousVoiceRefFile) {
    const volumeSourceText = await fs.readFile(sourceFile, "utf8");
    messages.push(
      await inlineReferenceMessage(ctx.previousVoiceRefFile, "character-voice-previous.md", {
        truncate: (raw) => truncateVoiceRef(raw, volumeSourceText),
      })
    );
  }
  return harness.runOneShot({ systemPrompt: ctx.extractSystemPrompt, messages, label: `character-voice-extract-${values.INSTALLMENT_NUMBER}` });
}


/**
 * Run the compile stage: author agent writes character-voice.md and pov-map.md.
 * With `seg` set (chunked fallback) the pass is scoped to one chapter.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {string} extractionOutput
 * @param {SourceSegment|null} [seg] - The chapter being processed (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 */
async function runCompile(ctx, extractionOutput, seg = null, si = null) {
  const { values, authorSystemPrompt } = ctx;
  const labelSuffix = seg ? `-${seg.id}` : "";
  let parsed = [];
  let extractionResults = "";
  try {
    parsed = parseVoiceQuirks(extractionOutput);
    extractionResults = JSON.stringify(parsed, null, 2);
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: extraction parse failed: ${err.message}. Using raw output.`);
    extractionResults = extractionOutput;
  }
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running voice/POV compilation${seg ? ` for chapter ${seg.id}` : ""}...`);
  const author = await harness.createAgentHandle({ name: `author-voice-${values.INSTALLMENT_NUMBER}${labelSuffix}`, systemPrompt: buildAuthorSystemPrompt(authorSystemPrompt), tools: ctx.fsGate.tools, approve: ctx.fsGate.approve, cwd: ctx.volumeDir, maxSteps: await voiceAuthorMaxSteps(ctx, seg) });
  try {
    const who = `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`;
    await runWriteTurn(author, {
      prompt: buildAuthorTurnPrompt(ctx, extractionResults, seg, si),
      label: `character-voice-compile-${values.INSTALLMENT_NUMBER}${labelSuffix}`,
      who,
      writesTo: [ctx.voiceOutputFile, ctx.povOutputFile],
      recoveryPrompt: (hasContent) => voiceRecoveryPrompt(hasContent, Boolean(ctx.voiceSeeded)),
      recoveryLabel: `character-voice-compile-recovery-${values.INSTALLMENT_NUMBER}${labelSuffix}`,
      recoveryWho: `the author agent (compile recovery${seg ? `, chapter ${seg.id}` : ""})`,
      // Hard stop: the recovery turn is the last chance — a still-missing, empty or stubbed
      // artifact is a failure, not an output.
      verifyOutput: true,
      assertToolCalls: (result, whoLabel) => assertRealToolCalls(result, whoLabel, values.INSTALLMENT_NUMBER),
    });
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: saved voice reference to ${ctx.voiceOutputFile} and POV map to ${ctx.povOutputFile}${seg ? ` (after chapter ${seg.id})` : ""}`);
  } finally { await author.close(); }
}


module.exports = {
  runExtract,
  runCompile,
};

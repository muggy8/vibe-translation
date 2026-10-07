/**
 * The extraction one-shot (source → the style-observation JSON array) and the compile turn that folds it into the cumulative guide.
 *
 * Part of the style-guide.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const harness = require("../harness");
const { fileExists, assertWroteWithFallback, assertRealOutput, writeProvenanceSidecar, inlineReferenceMessage, isPublishableArtifact, fingerprintFiles } = require("../utils/fs");
const { emittedToolCallAsText, assertRealToolCalls } = require("../utils/agents");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { truncateStyleGuide } = require("./config");
const { parseStyleObservations, styleAuthorMaxSteps, styleRecoveryPrompt } = require("./amend");
const { buildAuthorSystemPrompt, buildAuthorTurnPrompt } = require("./prompts");

/**
 * Run the extraction stage: one-shot call to extract style-relevant constructs.
 * With `seg` set (chunked fallback) the extraction is scoped to one chapter:
 * the source message is the chapter file and the cumulative reference is the
 * previous volume's guide (first chapter) or the current in-volume state.
 *
 * @param {StyleGuideVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter being extracted (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {Promise<string>}
 */
async function runExtract(ctx, seg = null, si = null) {
  const { values } = ctx;
  const labelSuffix = seg ? `-${seg.id}` : "";
  if (seg) {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: running style-convention extraction for chapter ${seg.id}...`);
    const messages = [{ file: path.join(ctx.volumeDir, seg.file), name: seg.file }];
    const stateFile = si === 0 ? ctx.previousStyleGuideFile : ctx.styleOutputFile;
    if (stateFile) {
      // Inlined (not readFile) — so the cumulative guide is bounded here, and
      // bounded by RELEVANCE: a policy whose quoted pattern occurs in this
      // chapter is shown whatever section order it happens to sit in.
      const chapterSource = await fs.readFile(path.join(ctx.volumeDir, seg.file), "utf8");
      messages.push(
        await inlineReferenceMessage(
          stateFile,
          si === 0 ? "style-guide-previous.md" : "style-guide-current.md",
          { truncate: (raw) => truncateStyleGuide(raw, chapterSource) }
        )
      );
    }
    messages.push({ text: ctx.extractPrompt }, { text: chapterSegmentNote(ctx.bundle, seg, si) });
    return harness.runOneShot({ systemPrompt: ctx.extractSystemPrompt, messages, label: `style-guide-extract-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
  }
  const { sourceFile } = ctx;
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running style-convention extraction...`);
  const messages = [{ file: sourceFile, name: path.basename(sourceFile) }, { text: ctx.extractPrompt }];
  if (ctx.previousStyleGuideFile) {
    const volumeSourceText = await fs.readFile(sourceFile, "utf8");
    messages.push(
      await inlineReferenceMessage(ctx.previousStyleGuideFile, "style-guide-previous.md", {
        truncate: (raw) => truncateStyleGuide(raw, volumeSourceText),
      })
    );
  }
  return harness.runOneShot({ systemPrompt: ctx.extractSystemPrompt, messages, label: `style-guide-extract-${values.INSTALLMENT_NUMBER}` });
}



/**
 * Run the compile stage: author agent writes style-guide.md. With `seg` set
 * (chunked fallback) the pass is scoped to one chapter.
 * @param {StyleGuideVolumeCtx} ctx
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
    parsed = parseStyleObservations(extractionOutput);
    extractionResults = JSON.stringify(parsed, null, 2);
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: extraction parse failed: ${err.message}. Using raw output.`);
    extractionResults = extractionOutput;
  }
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running style-guide compilation${seg ? ` for chapter ${seg.id}` : ""}...`);
  const author = await harness.createAgentHandle({ name: `author-style-${values.INSTALLMENT_NUMBER}${labelSuffix}`, systemPrompt: buildAuthorSystemPrompt(authorSystemPrompt), tools: ctx.fsGate.tools, approve: ctx.fsGate.approve, cwd: ctx.volumeDir, maxSteps: await styleAuthorMaxSteps(ctx, seg) });
  try {
    const compileResult = await author.sendTurn(buildAuthorTurnPrompt(ctx, extractionResults, seg, si), { label: `style-guide-compile-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
    assertRealToolCalls(compileResult, `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
    const compileFallbackUsed = await assertWroteWithFallback(ctx.styleOutputFile, `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`, compileResult?.text);
    // Recovery turn: ONLY when the file was actually missing after the
    // fallback — never over a file the agent already wrote correctly.
    if (compileFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
      const hasContent = compileResult?.text && compileResult.text.trim().length > 0;
      const recoveryResult = await author.sendTurn(styleRecoveryPrompt(hasContent, Boolean(ctx.styleSeeded)), { label: `style-guide-compile-recovery-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
      assertRealToolCalls(recoveryResult, `the author agent (compile recovery${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(ctx.styleOutputFile, `the author agent (compile recovery${seg ? `, chapter ${seg.id}` : ""})`, recoveryResult?.text);
    }
    // Hard stop: the recovery turn is the last chance — a still-missing,
    // empty or stubbed guide is a failure, not an output.
    await assertRealOutput(ctx.styleOutputFile, `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`);
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: saved style guide to ${ctx.styleOutputFile}${seg ? ` (after chapter ${seg.id})` : ""}`);
  } finally { await author.close(); }
}



module.exports = {
  runExtract,
  runCompile,
};

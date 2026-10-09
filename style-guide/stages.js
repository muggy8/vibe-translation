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
const { inlineReferenceMessage, readArtifactToAmend } = require("../utils/fs");
const { assertRealToolCalls } = require("../utils/agents");
const { runAuthorStage } = require("../utils/qa-loop");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { truncateStyleGuide } = require("./config");
const { parseStyleObservations, styleAuthorMaxSteps, styleRecoveryPrompt } = require("./amend");
const { buildStyleIndex } = require("./reference-index");
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
  // The write instruction and the category map follow the FILE, not the cross-volume seed: from
  // chapter 2 of the first volume onward the guide is here, and it is what this pass amends.
  // See utils/fs/current-artifact.js and the character-voice case that showed what the alternative
  // costs.
  const current = await readArtifactToAmend(ctx.styleOutputFile);
  ctx.styleSeeded = current.present;
  ctx.styleIndex = current.present ? buildStyleIndex(current.text) : "";
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
  await runAuthorStage(
    {
      name: `author-style-${values.INSTALLMENT_NUMBER}${labelSuffix}`,
      systemPrompt: buildAuthorSystemPrompt(authorSystemPrompt),
      tools: ctx.fsGate.tools,
      approve: ctx.fsGate.approve,
      cwd: ctx.volumeDir,
      maxSteps: await styleAuthorMaxSteps(ctx, seg),
    },
    {
      prompt: buildAuthorTurnPrompt(ctx, extractionResults, seg, si),
      label: `style-guide-compile-${values.INSTALLMENT_NUMBER}${labelSuffix}`,
      who: `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`,
      writesTo: ctx.styleOutputFile,
      recoveryPrompt: (hasContent) => styleRecoveryPrompt(hasContent, Boolean(ctx.styleSeeded)),
      recoveryLabel: `style-guide-compile-recovery-${values.INSTALLMENT_NUMBER}${labelSuffix}`,
      recoveryWho: `the author agent (compile recovery${seg ? `, chapter ${seg.id}` : ""})`,
      // Hard stop: the recovery turn is the last chance — a still-missing, empty or stubbed guide
      // is a failure, not an output.
      verifyOutput: true,
      assertToolCalls: (result, whoLabel) => assertRealToolCalls(result, whoLabel, values.INSTALLMENT_NUMBER),
    }
  );
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: saved style guide to ${ctx.styleOutputFile}${seg ? ` (after chapter ${seg.id})` : ""}`);
}



module.exports = {
  runExtract,
  runCompile,
};

/**
 * One volume chapter by chapter, with the carry-forward gate run between chapters.
 *
 * Part of the style-guide.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const harness = require("../harness");
const { validatorMaxStepsFor, findingsMergeMaxStepsFor } = require("../utils/prompt");
const { AGENT_TOOLS_NOTE, ON_QA_LIMIT } = require("../configs/shared");
const { runPerChapterQaLoop, validationReportRecoveryPrompt } = require("../utils/qa-loop");

const { guardStyleCarryForwardAgainst, seedStyleGuideFromPrevious } = require("./carry-forward");
const { runCompile, runExtract } = require("./stages");
const { parseStyleObservations } = require("./amend");
const { maxValidationIterations } = require("./config");
const { buildStyleFindingsMergePrompt, buildValidatorTurnPrompt } = require("./prompts");
const { acceptanceCheck, runFeedback } = require("./qa");

/**
 * Process a single volume chapter by chapter (the FALLBACK path, used when
 * the whole installment is too large for one pass): each chapter segment goes
 * through the same stage sequence a whole volume does — extract → compile —
 * chained so each chapter builds on the previous one's guide state. The QA
 * loop then validates the finished volume chapter by chapter (per-chapter
 * partial reports → findings merge → acceptance) with per-chapter feedback.
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context (must include bundle).
 */
async function runChunkedVolume(ctx) {
  const { values, bundle } = ctx;
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: chapter-by-chapter fallback ` +
      `(${bundle.segments.length} segments, ${bundle.wholeChars} chars whole)...`
  );
  // Create fsGate BEFORE any compile so the author agent has file tools.
  const fsGate = await harness.createGatedFsTools({ cwd: ctx.volumeDir, allowedDirs: [ctx.volumeDir] });
  ctx.fsGate = fsGate;
  // Same rule as whole mode: the previous volume's guide is copied in first, so
  // each chapter's compile pass amends the current state instead of reproducing it.
  await seedStyleGuideFromPrevious(ctx);
  const chunkedExtractions = [];
  for (let si = 0; si < bundle.segments.length; si++) {
    const segment = bundle.segments[si];
    let extractionOutput = "";
    try {
      extractionOutput = await runExtract(ctx, segment, si);
    } catch (err) {
      console.error(`Volume ${values.INSTALLMENT_NUMBER}: extraction failed for chapter ${segment.id}: ${err.message}. Check .logs/ for details.`);
      throw err;
    }
    // Accumulate the parsed entries so the whole volume's "new" results are
    // persisted once (see the write after the loop).
    try {
      chunkedExtractions.push(...parseStyleObservations(extractionOutput));
    } catch {
      // Unparseable chapter output — runCompile falls back to the raw text;
      // nothing structured to persist for this chapter.
    }
    // The baseline this chapter must not shrink below: the guide as of the
    // previous chapter (or the previous volume's, for chapter 0).
    const chapterBaseline = await fs.readFile(ctx.styleOutputFile, "utf8").catch(() => null);
    try {
      await runCompile(ctx, extractionOutput, segment, si);
    } catch (err) {
      console.error(`Volume ${values.INSTALLMENT_NUMBER}: compilation failed for chapter ${segment.id}: ${err.message}. Check .logs/ for details.`);
      throw err;
    }
    if (chapterBaseline !== null) {
      await guardStyleCarryForwardAgainst(ctx, chapterBaseline, `the compile pass (chapter ${segment.id})`, "the guide as of the previous chapter");
    }
  }
  // Persist the volume's extraction results (the new style constructs) so
  // the translation handoff (utils/handoff.js) can render a "what's new in
  // this volume" section without re-calling the AI.
  try {
    await fs.writeFile(path.join(ctx.volumeDir, "style-guide-new.json"), JSON.stringify(chunkedExtractions, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: could not persist style-guide-new.json (${err.message}) — continuing.`);
  }
  await runChunkedQaLoop(ctx);
}


/**
 * Chunked (fallback) QA loop: per-chapter validator passes (fresh agent per
 * chapter) write style-guide-validation-<id>.md partials; a findings-merge
 * agent consolidates them into the standard style-guide-validation.md; the
 * unchanged acceptance one-shot scores it; on a failed window, per-chapter
 * feedback applies the chapter-tagged findings.
 *
 * The loop itself — the iterations, the rolling window, the consensus gates, the
 * stalled-round check, the ON_QA_LIMIT policy — is the shared one in
 * utils/qa-loop/chunked.js. The feedback round is the one stage this task shares
 * with its whole-installment loop (runFeedback in ./qa.js, which carries the
 * carry-forward guard), so it hands the loop a runner instead of a stage.
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runChunkedQaLoop(ctx) {
  const { values, bundle, volumeDir, validationOutputFile, fsGate } = ctx;
  const n = values.INSTALLMENT_NUMBER;

  /** The validation partial one chapter's validator owes. @param {import("../types").SourceSegment} segment */
  const partialFile = (segment) => path.join(volumeDir, `style-guide-validation-${segment.id}.md`);

  const result = await runPerChapterQaLoop({
    volumeLabel: `Volume ${n}`,
    installment: n,
    cwd: volumeDir,
    tools: fsGate.tools,
    approve: fsGate.approve,
    chapters: bundle.segments,
    maxIterations: maxValidationIterations,
    onQaLimit: ON_QA_LIMIT,
    validationOutputFile,
    sourceFingerprint: bundle ? bundle.sourceFingerprint : undefined,
    feedbackArtifactFiles: [ctx.styleOutputFile],
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    stalledLogLine: () =>
      `Volume ${n}: the per-chapter feedback round changed NOTHING — ` +
      `style-guide.md is byte-identical to what it was before it. Stopping the QA loop here rather ` +
      `than paying for another round of per-chapter validators over an unchanged document. Check the ` +
      `feedback agents' turn logs in .logs/ for turns that only read (the usual shape: step cap ` +
      `reached before anything was written).`,
    limitReachedLogLine: () =>
      `Volume ${n}: reached the validation iteration limit (${maxValidationIterations}) without a ` +
      `passing grade. The last feedback pass is unvalidated; re-run to validate it.`,

    validate: {
      name: ({ iteration, segment }) => `validator-style-${n}-${iteration}-${segment.id}`,
      systemPrompt: () => ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
      maxSteps: async ({ segment }) => validatorMaxStepsFor((await fs.stat(path.join(volumeDir, segment.file))).size),
      prompt: ({ segment, si }) => buildValidatorTurnPrompt(ctx, segment, si),
      label: ({ iteration, segment }) => `style-guide-validate-${n}-${iteration}-${segment.id}`,
      recoveryLabel: ({ iteration, segment }) => `style-guide-validate-recovery-${n}-${iteration}-${segment.id}`,
      recoveryWho: ({ segment }) => `the validator agent (recovery, chapter ${segment.id})`,
      recoveryPrompt: (hasContent, { segment }) => validationReportRecoveryPrompt(hasContent, partialFile(segment)),
      writesTo: ({ segment }) => partialFile(segment),
      who: ({ segment }) => `the validator agent (chapter ${segment.id})`,
    },

    merge: {
      name: ({ iteration }) => `validator-merge-${n}-${iteration}`,
      systemPrompt: () => ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
      maxSteps: async () =>
        findingsMergeMaxStepsFor(
          bundle.segments.length,
          (await fs.stat(ctx.styleOutputFile).catch(() => ({ size: 0 }))).size
        ),
      prompt: () => buildStyleFindingsMergePrompt(ctx),
      label: ({ iteration }) => `style-guide-validate-merge-${n}-${iteration}`,
      writesTo: () => validationOutputFile,
      who: () => "the findings-merge agent",
    },

    // The same feedback pass the whole-installment loop runs, one chapter at a
    // time: it opens its own author agent and re-checks the cumulative invariant.
    feedbackRun: ({ segment, si }) => runFeedback(ctx, segment, si),
  });

  ctx.acceptedBy = result.acceptedBy;
  ctx.limitReached = result.limitReached;
}


module.exports = {
  runChunkedVolume,
  runChunkedQaLoop,
};

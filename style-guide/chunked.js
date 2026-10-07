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
const { transformUserPrompt, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, authorMaxStepsFor, findingsMergeMaxStepsFor, writePromptDump, selectSectionsByRelevance } = require("../utils/prompt");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError, readBoolEnv } = require("../configs/shared");
const { fileExists, assertWroteWithFallback, assertRealOutput, writeProvenanceSidecar, inlineReferenceMessage, isPublishableArtifact, fingerprintFiles } = require("../utils/fs");
const { emittedToolCallAsText, assertRealToolCalls } = require("../utils/agents");
const { runSharedQaLoop, confirmExceptionalScore, confirmPassingScore, runVolumeWithModeFallback } = require("../utils/qa-loop");

const { guardStyleCarryForwardAgainst, seedStyleGuideFromPrevious } = require("./carry-forward");
const { runCompile, runExtract } = require("./stages");
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
 * @param {StyleGuideVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runChunkedQaLoop(ctx) {
  const { values, bundle, volumeDir, validationOutputFile, fsGate } = ctx;
  const recentRollingScores = [];
  for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: validation iteration ${iteration}/${maxValidationIterations} (chapter by chapter)...`);
    // Per-chapter validation partials (fresh agent per chapter).
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const partialFile = path.join(volumeDir, `style-guide-validation-${segment.id}.md`);
      const validator = await harness.createAgentHandle({ name: `validator-style-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: validatorMaxStepsFor((await fs.stat(path.join(volumeDir, segment.file))).size) });
      try {
        const validateResult = await validator.sendTurn(buildValidatorTurnPrompt(ctx, segment, si), { label: `style-guide-validate-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` });
        assertRealToolCalls(validateResult, `the validator agent (chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        const validateFallbackUsed = await assertWroteWithFallback(partialFile, `the validator agent (chapter ${segment.id})`, validateResult?.text);
        // Recovery turn: ONLY when the partial was actually missing after the
        // fallback — never over a file the agent already wrote correctly.
        if (validateFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
          const hasContent = validateResult?.text && validateResult.text.trim().length > 0;
          const recoveryPrompt = hasContent ? `You were asked to write the validation report to "${path.basename(partialFile)}" using writeFile, but you replied with the content in your chat message instead. Please rewrite the complete report using writeFile now.` : `You produced no output. Please read the materials and write the complete validation report to "${path.basename(partialFile)}" using writeFile now.`;
          const recoveryResult = await validator.sendTurn(recoveryPrompt, { label: `style-guide-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` });
          assertRealToolCalls(recoveryResult, `the validator agent (recovery, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
          await assertWroteWithFallback(partialFile, `the validator agent (recovery, chapter ${segment.id})`, recoveryResult?.text);
        }
        await assertRealOutput(partialFile, `the validator agent (chapter ${segment.id})`);
      } finally { await validator.close(); }
    }
    // Findings merge: consolidate the partials into the standard report.
    const merger = await harness.createAgentHandle({ name: `validator-merge-${values.INSTALLMENT_NUMBER}-${iteration}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: findingsMergeMaxStepsFor(bundle.segments.length, (await fs.stat(ctx.styleOutputFile).catch(() => ({ size: 0 }))).size) });
    try {
      const mergeResult = await merger.sendTurn(buildStyleFindingsMergePrompt(ctx), { label: `style-guide-validate-merge-${values.INSTALLMENT_NUMBER}-${iteration}` });
      assertRealToolCalls(mergeResult, "the findings-merge agent", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(validationOutputFile, "the findings-merge agent", mergeResult?.text);
      await assertRealOutput(validationOutputFile, "the findings-merge agent");
    } finally { await merger.close(); }
    // Acceptance (unchanged: tool-less one-shot over the standard report).
    const score = await acceptanceCheck(ctx, iteration);
    if (score !== null) {
      recentRollingScores.push(score);
      if (recentRollingScores.length > ACCEPTANCE_WINDOW_SIZE) recentRollingScores.shift();
    }
    const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
    await saveRollingState(stateFilePath, recentRollingScores, {
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });
    // The same exceptional-score confirmation the whole-installment loop runs
    // (utils/qa-loop.js) — a consensus accepts the volume without the per-chapter
    // feedback round below.
    const exceptional = await confirmExceptionalScore({
      score,
      recentRollingScores,
      confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
      volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
      stateFile: stateFilePath,
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });
    if (exceptional.accepted) {
      // The chunked loop's contract: the only other way out of the loop is the
      // iteration limit (which sets ctx.limitReached). Reaching here means the
      // consensus accepted the volume, so record HOW it was accepted for the
      // run summary and stop before the per-chapter feedback round.
      ctx.acceptedBy = "exceptional-consensus";
      break;
    }
    if (meetsAcceptanceCriteria(recentRollingScores)) {
      const avg = computeRollingAverage(recentRollingScores);
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: rolling average ${avg.toFixed(1)}/100 (${recentRollingScores.length} checks) meets the passing score ${ACCEPTANCE_PASSING_SCORE}. Accepted.`);
      break;
    }
    // A grade that already passes earns the window's remaining samples by
    // re-grading this guide, not by paying for a per-chapter feedback round plus
    // a second full round of per-chapter validators (see confirmPassingScore).
    const passing = await confirmPassingScore({
      score,
      recentRollingScores,
      confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
      volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
      stateFile: stateFilePath,
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });
    if (passing.accepted) {
      ctx.acceptedBy = "passing-consensus";
      break;
    }
    // Per-chapter feedback (chapter-tagged findings only). Fingerprinted first: a
    // feedback round that changed nothing is not progress, and another iteration
    // would re-audit an unchanged document.
    const beforeFeedback = await fingerprintFiles(ctx.styleOutputFile);
    for (let si = 0; si < bundle.segments.length; si++) {
      await runFeedback(ctx, bundle.segments[si], si);
    }
    if ((await fingerprintFiles(ctx.styleOutputFile)) === beforeFeedback) {
      console.error(
        `Volume ${values.INSTALLMENT_NUMBER}: the per-chapter feedback round changed NOTHING — ` +
          `style-guide.md is byte-identical to what it was before it. Stopping the QA loop here rather ` +
          `than paying for another round of per-chapter validators over an unchanged document. Check the ` +
          `feedback agents' turn logs in .logs/ for turns that only read (the usual shape: step cap ` +
          `reached before anything was written).`
      );
      ctx.limitReached = true;
      await saveRollingState(stateFilePath, recentRollingScores, {
        sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
        stalled: true,
      });
      if (ON_QA_LIMIT === "fail") {
        throw new Error(
          `Volume ${values.INSTALLMENT_NUMBER}: the feedback round applied nothing (ON_QA_LIMIT=fail).`
        );
      }
      break;
    }
    if (iteration === maxValidationIterations) {
      ctx.limitReached = true;
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit (${maxValidationIterations}) without a passing grade. The last feedback pass is unvalidated; re-run to validate it.`);
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


module.exports = {
  runChunkedVolume,
  runChunkedQaLoop,
};

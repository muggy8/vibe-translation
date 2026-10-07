/**
 * One volume chapter by chapter: per-chapter validators, a findings-merge agent, the unchanged acceptance check, per-chapter feedback — and the carry-forward gate run BETWEEN chapters, because that is where the damage actually happened.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const harness = require("../harness");
const { validatorMaxStepsFor, findingsMergeMaxStepsFor } = require("../utils/prompt");
const { AGENT_TOOLS_NOTE, ON_QA_LIMIT } = require("../configs/shared");
const { runPerChapterQaLoop, validationReportRecoveryPrompt } = require("../utils/qa-loop");

const { assertVoiceCarryForward, guardVoiceCarryForwardAgainst, seedVoiceReferenceFromPrevious } = require("./carry-forward");
const { runCompile, runExtract } = require("./stages");
const { maxValidationIterations } = require("./config");
const { parseVoiceQuirks, voiceAuthorMaxSteps, voiceRecoveryPrompt } = require("./amend");
const { buildAuthorSystemPrompt, buildFeedbackTurnPrompt, buildValidatorTurnPrompt, buildVoiceFindingsMergePrompt } = require("./prompts");
const { acceptanceCheck } = require("./qa");

/**
 * Process a single volume chapter by chapter (the FALLBACK path, used when
 * the whole installment is too large for one pass): each chapter segment goes
 * through the same stage sequence a whole volume does — extract → compile —
 * chained so each chapter builds on the previous one's reference state. The
 * QA loop then validates the finished volume chapter by chapter (per-chapter
 * partial reports → findings merge → acceptance) with per-chapter feedback.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context (must include bundle).
 */
async function runChunkedVolume(ctx) {
  const { values, bundle } = ctx;
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: chapter-by-chapter fallback ` +
      `(${bundle.segments.length} segments, ${bundle.wholeChars} chars whole)...`
  );
  // Create fsGate BEFORE any compile so the author agent has file tools
  // (createGatedFsTools is async and must be awaited — see runVolume).
  const fsGate = await harness.createGatedFsTools({ cwd: ctx.volumeDir, allowedDirs: [ctx.volumeDir] });
  ctx.fsGate = fsGate;
  // Same rule as whole mode: the previous volume's reference is copied in first,
  // so each chapter's compile pass amends the current state instead of
  // reproducing it (see seedVoiceReferenceFromPrevious).
  await seedVoiceReferenceFromPrevious(ctx);
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
      chunkedExtractions.push(...parseVoiceQuirks(extractionOutput));
    } catch {
      // Unparseable chapter output — runCompile falls back to the raw text;
      // nothing structured to persist for this chapter.
    }
    // The baseline this chapter must not shrink below: the reference as of the
    // previous chapter (or the previous volume's, for chapter 0).
    const chapterBaseline = await fs.readFile(ctx.voiceOutputFile, "utf8").catch(() => null);
    try {
      await runCompile(ctx, extractionOutput, segment, si);
    } catch (err) {
      console.error(`Volume ${values.INSTALLMENT_NUMBER}: compilation failed for chapter ${segment.id}: ${err.message}. Check .logs/ for details.`);
      throw err;
    }
    // The carry-forward gate BETWEEN chapters, not just at the volume boundary:
    // catching a lost character at chapter 3 saves seven chapters of work built
    // on a reference that is already missing someone.
    if (chapterBaseline !== null) {
      await guardVoiceCarryForwardAgainst(ctx, chapterBaseline, `the compile pass (chapter ${segment.id})`, "the reference as of the previous chapter");
    }
  }
  // Persist the volume's extraction results (the new quirks/POV entries) so
  // the translation handoff (utils/handoff.js) can render a "what's new in
  // this volume" section without re-calling the AI.
  try {
    await fs.writeFile(path.join(ctx.volumeDir, "character-voice-new.json"), JSON.stringify(chunkedExtractions, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: could not persist character-voice-new.json (${err.message}) — continuing.`);
  }
  await runChunkedQaLoop(ctx);
}


/**
 * Chunked (fallback) QA loop: per-chapter validator passes (fresh agent per
 * chapter) write character-voice-validation-<id>.md partials; a findings-merge
 * agent consolidates them into the standard character-voice-validation.md; the
 * unchanged acceptance one-shot scores it; on a failed window, per-chapter
 * feedback agents apply the chapter-tagged findings.
 *
 * The loop itself — the iterations, the rolling window, the consensus gates, the
 * stalled-round check, the ON_QA_LIMIT policy — is the shared one in
 * utils/qa-loop/chunked.js. What is written here is only what the voice
 * reference says to its agents, plus the carry-forward gate this task re-runs
 * after every feedback round.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runChunkedQaLoop(ctx) {
  const { values, bundle, volumeDir, validationOutputFile, fsGate } = ctx;
  const n = values.INSTALLMENT_NUMBER;

  /** The validation partial one chapter's validator owes. @param {import("../types").SourceSegment} segment */
  const partialFile = (segment) => path.join(volumeDir, `character-voice-validation-${segment.id}.md`);
  /** The two documents this task's author agents owe. */
  const voiceArtifacts = () => [ctx.voiceOutputFile, ctx.povOutputFile];

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
    feedbackArtifactFiles: voiceArtifacts(),
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    stalledLogLine: () =>
      `Volume ${n}: the per-chapter feedback round changed NOTHING — ` +
      `both artifacts are byte-identical to what they were before it. Stopping the QA loop here ` +
      `rather than paying for another round of per-chapter validators over an unchanged document. ` +
      `Check the feedback agents' turn logs in .logs/ for turns that only read (the usual shape: ` +
      `step cap reached before anything was written).`,
    limitReachedLogLine: () =>
      `Volume ${n}: reached the validation iteration limit without a passing grade. ` +
      `The last feedback pass is unvalidated; re-run to validate it.`,

    validate: {
      name: ({ iteration, segment }) => `validator-voice-${n}-${iteration}-${segment.id}`,
      systemPrompt: () => ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
      maxSteps: async ({ segment }) => validatorMaxStepsFor((await fs.stat(path.join(volumeDir, segment.file))).size),
      prompt: ({ segment, si }) => buildValidatorTurnPrompt(ctx, segment, si),
      label: ({ iteration, segment }) => `character-voice-validate-${n}-${iteration}-${segment.id}`,
      recoveryLabel: ({ iteration, segment }) => `character-voice-validate-recovery-${n}-${iteration}-${segment.id}`,
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
          (await fs.stat(ctx.voiceOutputFile).catch(() => ({ size: 0 }))).size
        ),
      prompt: () => buildVoiceFindingsMergePrompt(ctx),
      label: ({ iteration }) => `character-voice-validate-merge-${n}-${iteration}`,
      writesTo: () => validationOutputFile,
      who: () => "the findings-merge agent",
    },

    feedback: {
      name: ({ iteration, segment }) => `feedback-author-${n}-${iteration}-${segment.id}`,
      systemPrompt: () => buildAuthorSystemPrompt(ctx.authorSystemPrompt),
      maxSteps: ({ segment }) => voiceAuthorMaxSteps(ctx, segment),
      prompt: ({ segment, si }) => buildFeedbackTurnPrompt(ctx, segment, si),
      label: ({ iteration, segment }) => `character-voice-feedback-${n}-${iteration}-${segment.id}`,
      recoveryLabel: ({ iteration, segment }) => `character-voice-feedback-recovery-${n}-${iteration}-${segment.id}`,
      recoveryWho: ({ segment }) => `the author agent (feedback recovery, chapter ${segment.id})`,
      recoveryPrompt: (hasContent) => voiceRecoveryPrompt(hasContent, true),
      writesTo: voiceArtifacts,
      who: ({ segment }) => `the author agent (feedback pass, chapter ${segment.id})`,
    },

    // The cumulative invariant, re-checked after every feedback round.
    afterFeedbackRound: () => assertVoiceCarryForward(ctx, "the feedback pass"),
  });

  ctx.acceptedBy = result.acceptedBy;
  ctx.limitReached = result.limitReached;
}


module.exports = {
  runChunkedVolume,
  runChunkedQaLoop,
};

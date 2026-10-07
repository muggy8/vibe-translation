/**
 * The QA loop's parts: validator agent, acceptance score, feedback pass patching HIGH → MEDIUM → LOW.
 *
 * Part of the style-guide.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
require("../types");
const harness = require("../harness");
const { transformUserPrompt, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, authorMaxStepsFor, findingsMergeMaxStepsFor, writePromptDump, selectSectionsByRelevance } = require("../utils/prompt");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError, readBoolEnv } = require("../configs/shared");
const { fileExists, assertWroteWithFallback, assertRealOutput, writeProvenanceSidecar, inlineReferenceMessage, isPublishableArtifact, fingerprintFiles } = require("../utils/fs");
const { emittedToolCallAsText, assertRealToolCalls } = require("../utils/agents");
const { runSharedQaLoop, confirmExceptionalScore, confirmPassingScore, runVolumeWithModeFallback } = require("../utils/qa-loop");

const { maxValidationIterations } = require("./config");
const { buildFeedbackTurnPrompt, buildValidatorTurnPrompt } = require("./prompts");
const { assertStyleCarryForward } = require("./carry-forward");
const { styleAuthorMaxSteps, styleRecoveryPrompt } = require("./amend");

/**
 * QA loop: validator -> acceptance -> feedback (the shared loop in
 * utils/qa-loop.js — this wrapper supplies the style-guide-specific
 * pieces: validator naming/prompts, the acceptance check, the feedback
 * stage, and the log lines).
 * @param {StyleGuideVolumeCtx} ctx
 */
async function runQaLoop(ctx) {
  const { values, volumeDir, sourceFile, validationOutputFile, fsGate } = ctx;
  const result = await runSharedQaLoop({
    volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
    maxIterations: maxValidationIterations,
    onQaLimit: ON_QA_LIMIT,
    validationOutputFile,
    stateFile: validationOutputFile.replace(".md", "-rolling-state.json"),
    sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    createValidatorAgent: async (iteration) => harness.createAgentHandle({ name: `validator-style-${values.INSTALLMENT_NUMBER}-${iteration}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: validatorMaxStepsFor((await fs.stat(sourceFile)).size) }),
    buildValidatorTurn: (iteration) => buildValidatorTurnPrompt(ctx),
    validatorLabel: (iteration) => `style-guide-validate-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryLabel: (iteration) => `style-guide-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryPrompt: (hasContent) => hasContent ? `You were asked to write "style-guide-validation.md" using writeFile, but you replied in chat. Please rewrite the report using writeFile now with the same content.` : `You produced no output. Please write the validation report to "style-guide-validation.md" using writeFile now.`,
    assertRealToolCalls: (result, who) => assertRealToolCalls(result, who, values.INSTALLMENT_NUMBER),
    acceptanceLogLine: () => "Calling the AI for the acceptance check...",
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    // Exceptional-score confirmation re-grades (see utils/qa-loop.js).
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    feedbackLogLine: () => "Calling the AI to apply the validation feedback (author agent)...",
    runFeedback: (iteration) => runFeedback(ctx),
    // The loop stops when a feedback pass leaves this byte-identical: a turn
    // that only read is not an iteration (see fingerprintFiles in utils/fs.js).
    feedbackArtifactFiles: [ctx.styleOutputFile],
    limitReachedLogLine: () => `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit (${maxValidationIterations}) without a passing grade.`,
  });
  ctx.limitReached = result.limitReached;
  return result;
}



/**
 * Run the feedback stage: fresh author agent applies validation feedback.
 * With `seg` set (chunked fallback) the pass applies the chapter-tagged
 * findings only.
 * @param {StyleGuideVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter whose findings are applied (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 */
async function runFeedback(ctx, seg = null, si = null) {
  const { values, volumeDir, fsGate } = ctx;
  const labelSuffix = seg ? `-${seg.id}` : "";
  const author = await harness.createAgentHandle({ name: `author-style-feedback-${values.INSTALLMENT_NUMBER}${labelSuffix}`, systemPrompt: ctx.feedbackSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: await styleAuthorMaxSteps(ctx, seg) });
  try {
    const feedbackResult = await author.sendTurn(buildFeedbackTurnPrompt(ctx, seg, si), { label: `style-guide-feedback-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
    assertRealToolCalls(feedbackResult, `the author agent (feedback pass${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
    const feedbackFallbackUsed = await assertWroteWithFallback(ctx.styleOutputFile, `the author agent (feedback pass${seg ? `, chapter ${seg.id}` : ""})`, feedbackResult?.text);
    // Recovery turn: ONLY when the file was actually missing after the
    // fallback — never over a file the agent already wrote correctly.
    if (feedbackFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
      const hasContent = feedbackResult?.text && feedbackResult.text.trim().length > 0;
      const recoveryResult = await author.sendTurn(styleRecoveryPrompt(hasContent, true), { label: `style-guide-feedback-recovery-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
      assertRealToolCalls(recoveryResult, `the author agent (feedback recovery${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(ctx.styleOutputFile, `the author agent (feedback recovery${seg ? `, chapter ${seg.id}` : ""})`, recoveryResult?.text);
    }
    await assertRealOutput(ctx.styleOutputFile, `the author agent (feedback pass${seg ? `, chapter ${seg.id}` : ""})`);
    // The cumulative invariant, re-checked after every rewrite: a feedback pass
    // that rewrote the guide from memory is how sections disappear from it.
    await assertStyleCarryForward(ctx, "the feedback pass");
  } finally { await author.close(); }
}


/**
 * Shared acceptance check: always a tool-less single-shot call.
 * The model sees the style guide ITSELF plus its validation report (the
 * report is a guide, not the source of truth) and scores it 0–100
 * (100 = perfect, 0 = atrocious) as a JSON reply {score, band, note};
 * the score — not a binary verdict — is what the rolling window tracks.
 * @param {StyleGuideVolumeCtx} ctx
 * @param {number} iteration
 * @returns {Promise<number | null>} The parsed score (0–100), or `null`
 *   when no valid score could be extracted (treated as a failed check).
 */
async function acceptanceCheck(ctx, iteration, temperature) {
  const { values, validationOutputFile, acceptancePrompt, acceptanceSystemPrompt, styleOutputFile } = ctx;
  const acceptanceOutput = await harness.runOneShot({ systemPrompt: acceptanceSystemPrompt, messages: [{ file: styleOutputFile, name: "style-guide.md" }, { file: validationOutputFile, name: "style-guide-validation.md" }, { text: acceptancePrompt }], temperature: temperature ?? judgeTemperature(), ...judgeThinking("ACCEPTANCE"), label: `style-guide-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}` });
  const reply = parseAcceptanceReply(acceptanceOutput);
  if (reply === null) {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: acceptance check: no valid score in response (got: ${JSON.stringify(acceptanceOutput.trim().slice(0, 120))}). Counting this check as a failure.`);
  } else {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: acceptance check: score ${reply.score}/100` + (reply.band ? ` (band: ${reply.band})` : "") + (reply.note ? ` — ${reply.note}` : "") + ` (passing score: ${ACCEPTANCE_PASSING_SCORE})`);
  }
  return reply ? reply.score : null;
}


module.exports = {
  runQaLoop,
  runFeedback,
  acceptanceCheck,
};

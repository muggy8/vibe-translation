/**
 * The QA loop's parts: a fresh validator agent per iteration writes the validation report, the acceptance one-shot scores the reference 0-100, and a fresh author agent applies feedback in HIGH → MEDIUM → LOW order. The state file is saved on every iteration INCLUDING the accepting one, so accepted volumes are skipped on re-run.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
require("../types");
const harness = require("../harness");
const { parseAcceptanceReply, validatorMaxStepsFor } = require("../utils/prompt");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_PASSING_SCORE, ON_QA_LIMIT, judgeTemperature, judgeThinking, acceptanceResponseFormat } = require("../configs/shared");
const { assertRealToolCalls } = require("../utils/agents");
const { runSharedQaLoop, runAuthorStage } = require("../utils/qa-loop");

const { maxValidationIterations } = require("./config");
const { buildFeedbackTurnPrompt, buildValidatorTurnPrompt } = require("./prompts");
const { assertVoiceCarryForward } = require("./carry-forward");
const { voiceAuthorMaxSteps, voiceRecoveryPrompt } = require("./amend");

/**
 * QA loop: validator -> acceptance -> feedback (the shared loop in
 * utils/qa-loop.js — this wrapper supplies the character-voice-specific
 * pieces: validator naming/prompts, the acceptance check, the feedback
 * stage, and the log lines).
 * @param {CharacterVoiceVolumeCtx} ctx
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
    createValidatorAgent: async (iteration) => harness.createAgentHandle({ name: `validator-voice-${values.INSTALLMENT_NUMBER}-${iteration}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: validatorMaxStepsFor((await fs.stat(sourceFile)).size) }),
    buildValidatorTurn: (iteration) => buildValidatorTurnPrompt(ctx),
    validatorLabel: (iteration) => `character-voice-validate-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryLabel: (iteration) => `character-voice-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryPrompt: (hasContent) => hasContent ? `You were asked to write "character-voice-validation.md" using writeFile, but you replied in chat. Please rewrite the report using writeFile now with the same content.` : `You produced no output. Please write the validation report to "character-voice-validation.md" using writeFile now.`,
    assertRealToolCalls: (result, who) => assertRealToolCalls(result, who, values.INSTALLMENT_NUMBER),
    acceptanceLogLine: () => "Calling the AI for the acceptance check...",
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    // Exceptional-score confirmation re-grades (see utils/qa-loop.js).
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    feedbackLogLine: () => "Calling the AI to apply the validation feedback (author agent)...",
    runFeedback: (iteration) => runFeedback(ctx),
    // The loop stops when a feedback pass leaves these byte-identical: a turn
    // that only read is not an iteration (see fingerprintFiles in utils/fs.js).
    feedbackArtifactFiles: [ctx.voiceOutputFile, ctx.povOutputFile],
    limitReachedLogLine: () => `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit (${maxValidationIterations}) without a passing grade.`,
  });
  ctx.limitReached = result.limitReached;
  return result;
}


/**
 * Run the feedback stage: fresh author agent applies validation feedback.
 * @param {CharacterVoiceVolumeCtx} ctx
 */
async function runFeedback(ctx) {
  const { values, volumeDir, fsGate } = ctx;
  // The shared turn protocol (utils/qa-loop/turn.js).
  await runAuthorStage(
    {
      name: `author-voice-feedback-${values.INSTALLMENT_NUMBER}`,
      systemPrompt: ctx.feedbackSystemPrompt + AGENT_TOOLS_NOTE,
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      maxSteps: await voiceAuthorMaxSteps(ctx),
    },
    {
      prompt: buildFeedbackTurnPrompt(ctx),
      label: `character-voice-feedback-${values.INSTALLMENT_NUMBER}`,
      who: "the author agent (feedback pass)",
      writesTo: [ctx.voiceOutputFile, ctx.povOutputFile],
      recoveryLabel: `character-voice-feedback-recovery-${values.INSTALLMENT_NUMBER}`,
      recoveryWho: "the author agent (feedback recovery)",
      recoveryPrompt: (hasContent) => voiceRecoveryPrompt(hasContent, true),
      verifyOutput: true,
      assertToolCalls: (result, who) => assertRealToolCalls(result, who, values.INSTALLMENT_NUMBER),
    }
  );
  // The cumulative invariant, re-checked after every rewrite: a feedback pass
  // that rewrote the reference from memory is how characters disappear from it
  // (see assertVoiceCarryForward).
  await assertVoiceCarryForward(ctx, "the feedback pass");
}


/**
 * Shared acceptance check: always a tool-less single-shot call.
 * The model scores the audited output 0–100 (100 = perfect, 0 = atrocious);
 * the score — not a binary verdict — is what the rolling window tracks.
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {number} iteration
 * @returns {Promise<number | null>} The parsed score (0–100), or `null`
 *   when no valid score could be extracted (treated as a failed check).
 */
async function acceptanceCheck(ctx, iteration, temperature) {
  const { values, validationOutputFile, acceptancePrompt, acceptanceSystemPrompt, voiceOutputFile, povOutputFile } = ctx;
  const acceptanceOutput = await harness.runOneShot({ systemPrompt: acceptanceSystemPrompt, messages: [{ file: voiceOutputFile, name: "character-voice.md" }, { file: povOutputFile, name: "pov-map.md" }, { file: validationOutputFile, name: "character-voice-validation.md" }, { text: acceptancePrompt }], temperature: temperature ?? judgeTemperature(), ...judgeThinking("ACCEPTANCE"), responseFormat: acceptanceResponseFormat(), label: `character-voice-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}` });
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

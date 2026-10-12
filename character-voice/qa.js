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
const { AGENT_TOOLS_NOTE, ACCEPTANCE_PASSING_SCORE, ON_QA_LIMIT, judgeTemperature, judgeThinking, acceptanceResponseFormat, SAMPLED_GRADE_NOTE } = require("../configs/shared");
const { assertRealToolCalls } = require("../utils/agents");
const { runSharedQaLoop, runAuthorStage } = require("../utils/qa-loop");

const { maxValidationIterations } = require("./config");
const { auditVoiceArtifact, mirrorVoiceArtifact, auditAssembledArtifacts, voiceGradeSample, VOICE_ARTIFACT_NAME } = require("./store");
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
  /**
   * The assembled route runs the same loop with one difference and one absence.
   *
   * The difference: the validator half audits the record against the artifacts this route just
   * rendered, and does **not** mirror them back — on this route the file *is* the record's render, and
   * mirroring it would file the same claims twice under two provenances.
   *
   * The absence: the feedback pass. There is no author to ask, so a failing grade cannot be answered
   * by re-typing the same claims. One iteration, and the loop stops — which is also the cheap direction:
   * five grades over a document nothing can change is sampling noise, not QA.
   *
   * One iteration is NOT one grade, and this is worth knowing before reading the loop's log: acceptance
   * needs `ACCEPTANCE_MIN_SAMPLES` scores in its rolling window, and `ACCEPTANCE_CONFIRM_ON_PASSING`
   * (default on) collects the missing ones by re-grading the same artifact rather than paying for a
   * feedback round that would change nothing. Measured on the real volume 01 on 2026-10-12: a first grade
   * of 81 printed "the window needs 2 sample(s) and has 1 — collecting 2 more grade(s) from the same
   * artifact", took two more grades (82, and 82 at temperature 0), and accepted at a rolling average of
   * 82.0 for 102k tokens. A grade below the passing score is the case with no answer on this route, and
   * it quarantines.
   */
  const assembled = ctx.voiceRoute === "assemble";
  const result = await runSharedQaLoop({
    volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
    maxIterations: assembled ? 1 : maxValidationIterations,
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
    // Slice 6: with a record open, the validator agent turn is replaced by the store's queries. The
    // report file keeps its name and its reader; the loop's grade, feedback and stall checks are
    // untouched, and the loop makes no model call for validation.
    deterministicValidator: ctx.refStore
      ? async () => {
          if (assembled) {
            await auditAssembledArtifacts(ctx, { refused: (ctx.storeImport && ctx.storeImport.refused) || [] });
            return;
          }
          await mirrorVoiceArtifact(ctx);
          const audit = await auditVoiceArtifact(ctx);
          await fs.writeFile(validationOutputFile, audit.markdown, "utf8");
        }
      : undefined,
    validatorLogLine: ctx.refStore
      ? () =>
          assembled
            ? "Auditing the assembled reference against the volume's record (no model call)..."
            : "Auditing the reference against the volume's record (no model call)..."
      : undefined,
    acceptanceLogLine: () => "Calling the AI for the acceptance check...",
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    // Exceptional-score confirmation re-grades (see utils/qa-loop.js).
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    feedbackLogLine: () =>
      assembled
        ? "No feedback pass: this route has no author agent, so the grade is the decision."
        : "Calling the AI to apply the validation feedback (author agent)...",
    runFeedback: (iteration) => (assembled ? Promise.resolve(runAssembledFeedbackNote(ctx)) : runFeedback(ctx)),
    // The loop stops when a feedback pass leaves these byte-identical: a turn
    // that only read is not an iteration (see fingerprintFiles in utils/fs.js).
    // The assembled route writes nothing in its feedback turn by design, so it does not claim to be
    // watching for a change that could never happen — the loop ends at its one iteration instead.
    feedbackArtifactFiles: assembled ? [] : [ctx.voiceOutputFile, ctx.povOutputFile],
    limitReachedLogLine: () =>
      assembled
        ? `Volume ${values.INSTALLMENT_NUMBER}: the acceptance gate did not accept the assembled reference. This route has no rewrite pass, so the volume stops here.`
        : `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit (${maxValidationIterations}) without a passing grade.`,
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
 * The assembled route's feedback turn: a sentence, not an agent.
 *
 * The shared loop always runs a feedback pass between grades. On this route there is nothing to run —
 * the reference is a render of claims the record already holds, and the only way to change it is to
 * read the book again or contest a row. Saying that out loud is what keeps the loop's shape identical
 * between the two routes instead of forking a second loop that could drift from the first.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {void}
 */
function runAssembledFeedbackNote(ctx) {
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: nothing was rewritten — ${VOICE_ARTIFACT_NAME} and pov-map.md are ` +
      "rendered from the volume's record, so the claims they hold are the claims the record holds."
  );
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
  // Slice 6: with a record open the grader is shown a sample chosen by code instead of the whole
  // cumulative reference, and the deterministic audit that replaces the validator agent is already in
  // the message as the validation file. The rubric, the score contract, the judging temperature and
  // the response format are the same ones the whole-document grade used.
  const sample = await voiceGradeSample(ctx);
  const acceptanceOutput = await harness.runOneShot({ systemPrompt: acceptanceSystemPrompt, messages: [
    sample !== null ? { text: sample, name: "character-voice.md (sample)" } : { file: voiceOutputFile, name: "character-voice.md" },
    { file: povOutputFile, name: "pov-map.md" },
    { file: validationOutputFile, name: "character-voice-validation.md" },
    { text: sample !== null ? acceptancePrompt + SAMPLED_GRADE_NOTE : acceptancePrompt },
  ], temperature: temperature ?? judgeTemperature(), ...judgeThinking("ACCEPTANCE"), responseFormat: acceptanceResponseFormat(), label: `character-voice-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}` });
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

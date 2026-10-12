/**
 * The gate: the deterministic audit writes the validation report, the acceptance one-shot scores the
 * rendered reference 0–100, and the grade decides. The state file is saved on every iteration INCLUDING
 * the accepting one, so accepted volumes are skipped on re-run.
 *
 * There is no validator agent turn and no feedback pass here. The validator half is queries against the
 * volume's reference record (`auditVoiceArtifact`), which make no model call; the rewrite half is gone
 * because the reference is a render of claims the record already holds, and the only way to change it is
 * to read the book again or contest a row — not to pay a model to re-type the same claims. That is also
 * the cheap direction: five grades over a document nothing can change is sampling noise, not QA.
 *
 * One iteration is NOT one grade, and this is worth knowing before reading the loop's log: acceptance
 * needs `ACCEPTANCE_MIN_SAMPLES` scores in its rolling window, and `ACCEPTANCE_CONFIRM_ON_PASSING`
 * (default on) collects the missing ones by re-grading the same artifact rather than paying for a round
 * that would change nothing. Measured on the real volume 01 on 2026-10-12: a first grade of 81 printed
 * "the window needs 2 sample(s) and has 1 — collecting 2 more grade(s) from the same artifact", took two
 * more grades (82, and 82 at temperature 0), and accepted at a rolling average of 82.0 for 102k tokens.
 * A grade below the passing score is the case with no answer on this route, and it quarantines.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types");
const harness = require("../harness");
const { parseAcceptanceReply } = require("../utils/prompt");
const { ON_QA_LIMIT, ACCEPTANCE_PASSING_SCORE, judgeTemperature, judgeThinking, acceptanceResponseFormat, SAMPLED_GRADE_NOTE } = require("../configs/shared");
const { runSharedQaLoop } = require("../utils/qa-loop");

const { auditVoiceArtifact, voiceGradeSample, VOICE_ARTIFACT_NAME } = require("./store");

/**
 * The gate, run through the shared loop so its rolling window, its consensus gates, its grade tally and
 * its ON_QA_LIMIT policy are the same ones every other stage's gate uses.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {Promise<{accepted: boolean, acceptedBy: string|null, limitReached: boolean, scores: number[]}>}
 */
async function runQaLoop(ctx) {
  const { values, validationOutputFile } = ctx;
  const result = await runSharedQaLoop({
    volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
    // One iteration, in code, not from a setting: there is no rewrite pass between grades, so a second
    // iteration would re-audit and re-grade a document that cannot have changed.
    maxIterations: 1,
    onQaLimit: ON_QA_LIMIT,
    validationOutputFile,
    stateFile: validationOutputFile.replace(".md", "-rolling-state.json"),
    sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    deterministicValidator: async () => {
      await auditVoiceArtifact(ctx, { refused: (ctx.storeImport && ctx.storeImport.refused) || [] });
    },
    validatorLogLine: () => "Auditing the reference against the volume's record (no model call)...",
    acceptanceLogLine: () => "Calling the AI for the acceptance check...",
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    // Exceptional-score confirmation re-grades (see utils/qa-loop.js).
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    feedbackLogLine: () => "No rewrite pass: the artifacts are rendered from the record, so the grade is the decision.",
    runFeedback: () => runFeedbackNote(ctx),
    // The loop fingerprints these around a feedback pass and stops when they are byte-identical. This
    // route writes nothing in its feedback step by design, so it does not claim to be watching for a
    // change that could never happen — the loop ends at its one iteration instead.
    feedbackArtifactFiles: [],
    limitReachedLogLine: () =>
      `Volume ${values.INSTALLMENT_NUMBER}: the acceptance gate did not accept the reference. This stage has no rewrite pass, so the volume stops here.`,
  });
  ctx.limitReached = result.limitReached;
  return result;
}


/**
 * The feedback step the shared loop always runs between grades: a sentence, not an agent.
 *
 * Saying out loud that nothing was rewritten is what keeps the loop's shape identical to every other
 * stage's instead of forking a second loop that could drift from the first.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {void}
 */
function runFeedbackNote(ctx) {
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
  // With a record open the grader is shown a sample chosen by code instead of the whole cumulative
  // reference, and the deterministic audit that replaces the validator agent is already in the message as
  // the validation file. The rubric, the score contract, the judging temperature and the response format
  // are the same ones the whole-document grade used.
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
  acceptanceCheck,
};

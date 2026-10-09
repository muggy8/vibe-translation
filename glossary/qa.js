/**
 * The per-volume QA loop: a fresh validator agent per iteration writes the
 * validation report, the acceptance one-shot scores the artifact 0-100, and on a
 * failing window a fresh author agent applies the feedback. Chunked mode runs
 * per-chapter validator partials, a findings-merge agent, the unchanged acceptance
 * check, and per-chapter feedback.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { parseAcceptanceReply, validatorMaxStepsFor } = require("../utils/prompt");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_PASSING_SCORE, ON_QA_LIMIT, judgeTemperature, judgeThinking, acceptanceResponseFormat } = require("../configs/shared");
const { assertRealToolCalls } = require("../utils/agents");
const { runSharedQaLoop, runAuthorStage } = require("../utils/qa-loop");

const { maxValidationIterations } = require("./config");
const { buildGlossaryFeedbackTurnPrompt, buildGlossaryValidatorTurnPrompt } = require("./prompts");
const { assertGlossaryCarryForward, buildGlossaryIndex } = require("./carry-forward");
const { glossaryAuthorMaxSteps, glossaryRecoveryPrompt } = require("./authoring");

/**
 * Shared acceptance check: always a tool-less single-shot call.
 * The model sees the glossary ITSELF plus its validation report (the
 * report is a guide, not the source of truth) and scores it 0–100
 * (100 = perfect, 0 = atrocious) as a JSON reply {score, band, note};
 * the score — not a binary verdict — is what the rolling window tracks.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (see glossary()).
 * @param {number} iteration - The current QA iteration (for the log label).
 * @returns {Promise<number | null>} The parsed score (0–100), or `null` when
 *   no valid score could be extracted (treated as a failed check).
 */
async function acceptanceCheck(ctx, iteration, temperature) {
  const { values, validationOutputFile, acceptancePrompt, acceptanceSystemPrompt, glossaryOutputFile } = ctx;
  const acceptanceOutput = await harness.runOneShot({
    systemPrompt: acceptanceSystemPrompt,
    messages: [
      { file: glossaryOutputFile, name: "glossary.md" },
      { file: validationOutputFile, name: "glossary-validation.md" },
      { text: acceptancePrompt },
    ],
    // A grader, not a writer: JUDGE_TEMPERATURE (the house writing temperature
    // used to apply here, which made the acceptance score needlessly noisy) and
    // STAGE_THINKING_LEVEL (the authoring level spent whole reply budgets
    // thinking on these calls and answered with nothing — gotcha 59).
    temperature: temperature ?? judgeTemperature(),
    ...judgeThinking("ACCEPTANCE"),
    // The rubric's answer shape, asked for on the wire and not only in the prompt.
    // The parser below is still what decides; this only makes a wrong-shaped answer
    // a named refusal instead of something to guess at.
    responseFormat: acceptanceResponseFormat(),
    label: `glossary-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}`,
  });
  const reply = parseAcceptanceReply(acceptanceOutput);
  if (reply === null) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: acceptance check: no valid score in ` +
        `response (got: ${JSON.stringify(acceptanceOutput.trim().slice(0, 120))}). ` +
        `Counting this check as a failure.`
    );
  } else {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: acceptance check: score ${reply.score}/100` +
        (reply.band ? ` (band: ${reply.band})` : "") +
        (reply.note ? ` — ${reply.note}` : "") +
        ` (passing score: ${ACCEPTANCE_PASSING_SCORE})`
    );
  }
  return reply ? reply.score : null;
}


/**
 * QA loop: independent validator agent (fresh per iteration) ->
 * score-based acceptance check (0–100, see configs/shared.js) ->
 * feedback applied by a fresh author agent (no persistent session — each
 * feedback pass starts with a clean context that includes the validation
 * report and current glossary). Runs the shared loop from utils/qa-loop.js
 * with the glossary-specific pieces supplied here.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include ctx.fsGate).
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
    createValidatorAgent: async (iteration) => harness.createAgentHandle({
      name: `validator-${values.INSTALLMENT_NUMBER}-${iteration}`,
      systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      // scaled to the source size (see validatorMaxStepsFor)
      maxSteps: validatorMaxStepsFor((await fs.stat(sourceFile)).size),
    }),
    buildValidatorTurn: (iteration) => buildGlossaryValidatorTurnPrompt(ctx),
    validatorLabel: (iteration) => `glossary-validate-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryLabel: (iteration) => `glossary-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryPrompt: (hasContent) => hasContent
      ? `You were asked to write the validation report to "glossary-validation.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
        `The file has been temporarily written from your chat reply, but it must be written properly using writeFile. ` +
        `Please rewrite the complete validation report to "glossary-validation.md" using writeFile now. Use the exact same content you generated in your previous message.`
      : `You were asked to write the validation report to "glossary-validation.md" using writeFile, but you produced no output.\n\n` +
        `Please read the source materials and write the complete validation report to "glossary-validation.md" using writeFile now.`,
    assertRealToolCalls: (result, who) => assertRealToolCalls(result, who, values.INSTALLMENT_NUMBER),
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    // Exceptional-score confirmation re-grades (see utils/qa-loop.js): the same
    // artifact, graded again — the loop asks for temperature 0 on the first one.
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    feedbackLogLine: () => `Volume ${values.INSTALLMENT_NUMBER}: applying validation feedback (fresh author agent)...`,
    runFeedback: (iteration) => runGlossaryFeedback(ctx, iteration),
    // The loop stops when a feedback pass leaves this byte-identical: a turn that
    // only read is not an iteration (see fingerprintFiles in utils/fs.js).
    feedbackArtifactFiles: [ctx.glossaryOutputFile],
    limitReachedLogLine: () => `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit without a passing grade. The last feedback pass is unvalidated; re-run to validate it.`,
  });
  ctx.limitReached = result.limitReached;
  return result;
}


/**
 * The glossary feedback stage (called by the shared QA loop in
 * utils/qa-loop.js): a fresh author agent applies the validation report to
 * the glossary. The feedback prompt is self-contained: it includes the
 * validation report and the current glossary so the agent has all context
 * it needs.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 * @param {number} iteration - The current QA iteration (agent name + labels).
 */
async function runGlossaryFeedback(ctx, iteration) {
  const { values, volumeDir, glossaryOutputFile } = ctx;

  // The index must describe the glossary as it is NOW — the amend pass and the
  // earlier QA iterations have added rows since it was seeded.
  ctx.glossaryIndex = buildGlossaryIndex(
    await fs.readFile(glossaryOutputFile, "utf8").catch(() => "")
  );

  await runAuthorStage(
    {
      name: `feedback-author-${values.INSTALLMENT_NUMBER}-${iteration}`,
      systemPrompt: ctx.glossarySystemPrompt + AGENT_TOOLS_NOTE,
      tools: ctx.fsGate.tools,
      approve: ctx.fsGate.approve,
      cwd: volumeDir,
      maxSteps: await glossaryAuthorMaxSteps(ctx),
    },
    {
      // The shared turn protocol (utils/qa-loop/turn.js) — the same six steps every
      // file-writing stage in this pipeline owes, in one place.
      prompt: buildGlossaryFeedbackTurnPrompt(ctx),
      label: `glossary-feedback-${values.INSTALLMENT_NUMBER}-${iteration}`,
      who: "the author agent (feedback pass)",
      writesTo: glossaryOutputFile,
      recoveryLabel: `glossary-feedback-recovery-${values.INSTALLMENT_NUMBER}-${iteration}`,
      recoveryWho: "the author agent (feedback recovery)",
      recoveryPrompt: (hasContent) =>
        glossaryRecoveryPrompt(
          hasContent,
          '"glossary.md"',
          "the volume source, the validation report and the current glossary"
        ),
      verifyOutput: true,
      assertToolCalls: (result, who) => assertRealToolCalls(result, who, values.INSTALLMENT_NUMBER),
    }
  );
  await assertGlossaryCarryForward(ctx, "the feedback pass");
}

// ─── Deterministic term-coverage audit ──────────────────────────────────────
// The glossary validator checks completeness with judgment (an LLM); this
// audit adds the deterministic half — exact occurrence counts of every
// glossary term in this volume's source text — and doubles as the
// per-volume "terms used here" index the translation stage needs (the
// cumulative glossary grows; a translator of volume N only needs the terms
// volume N actually uses).


module.exports = {
  acceptanceCheck,
  runQaLoop,
  runGlossaryFeedback,
};

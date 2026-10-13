/**
 * glossary/qa.js — the gate: the deterministic audit writes the validation report, the acceptance
 * one-shot scores the rendered glossary 0–100, and the grade decides.
 *
 * There is no validator agent turn and no feedback pass here. The validator half is queries against the
 * volume's reference record (`auditGlossaryArtifact`), which make no model call; the rewrite half is
 * gone because the published file is a **render of the rows the record holds**, and the only way to
 * change what it says is to read the volume again or contest a row — not to pay a model to re-type the
 * same rows. That is also the cheap direction: several grades over a document nothing can change are
 * sampling noise, not QA. The character-voice stage made the same move first
 * (`character-voice/qa.js`), and this file is deliberately its shape.
 *
 * One iteration is NOT one grade, and this is worth knowing before reading the loop's log: acceptance
 * needs `ACCEPTANCE_MIN_SAMPLES` scores in its rolling window, and the loop collects the missing ones by
 * re-grading the same artifact rather than paying for a round that would change nothing. A grade below
 * the passing score is the case with no answer on this route: `glossary/task.js` quarantines the rendered
 * file and throws, and the record is left a draft so the next volume's copy-forward refuses it.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { parseAcceptanceReply } = require("../utils/prompt");
const { ON_QA_LIMIT, ACCEPTANCE_PASSING_SCORE, judgeTemperature, judgeThinking, acceptanceResponseFormat, SAMPLED_GRADE_NOTE } = require("../configs/shared");
const { runSharedQaLoop } = require("../utils/qa-loop");

const { auditGlossaryArtifact, glossaryGradeSample, GLOSSARY_ARTIFACT_NAME } = require("./store");

/**
 * The gate, run through the shared loop so its rolling window, its consensus gates, its grade tally and
 * its ON_QA_LIMIT policy are the same ones every other stage's gate uses.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (see glossary/task.js).
 * @returns {Promise<{accepted: boolean, acceptedBy: string|null, limitReached: boolean, scores: number[]}>}
 */
async function runQaLoop(ctx) {
  const { values, validationOutputFile } = ctx;
  const result = await runSharedQaLoop({
    volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
    // One iteration, in code, not from a setting: there is no rewrite pass between grades, so a second
    // iteration would re-audit and re-grade a document that cannot have changed. `QA_MAX_ITERATIONS`
    // still belongs to the stages that DO rewrite (style guide, wiki); reading it here would only make
    // the log claim rounds that do not exist.
    maxIterations: 1,
    onQaLimit: ON_QA_LIMIT,
    validationOutputFile,
    stateFile: validationOutputFile.replace(".md", "-rolling-state.json"),
    sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    // The validator half is the record's own queries. The report file keeps its name, its shape and its
    // reader — the grader, the delivery layer and `test/prompt-audit.js`'s `acceptance-context` rule all
    // read `glossary-validation.md` and its `**Recommendation:**` line.
    deterministicValidator: async () => {
      await auditGlossaryArtifact(ctx, { refused: (ctx.storeTermRows && ctx.storeTermRows.refused) || [] });
      const audit = ctx.storeAudit;
      if (audit) await fs.writeFile(validationOutputFile, audit.markdown, "utf8");
    },
    validatorLogLine: () => "Auditing the glossary against the volume's record (no model call)...",
    acceptanceLogLine: () => "Calling the AI for the acceptance check...",
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    // Exceptional-score confirmation re-grades (see utils/qa-loop.js): the same artifact, graded again —
    // the loop asks for temperature 0 on the first one.
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    feedbackLogLine: () => "No rewrite pass: the glossary is rendered from the record, so the grade is the decision.",
    runFeedback: () => runFeedbackNote(ctx),
    // The loop fingerprints these around a feedback pass and stops when they are byte-identical. This
    // route writes nothing in its feedback step by design, so it does not claim to be watching for a
    // change that could never happen — the loop ends at its one iteration instead.
    feedbackArtifactFiles: [],
    limitReachedLogLine: () =>
      `Volume ${values.INSTALLMENT_NUMBER}: the acceptance gate did not accept the rendered glossary. ` +
      "This stage has no rewrite pass, so the volume stops here.",
  });
  ctx.limitReached = result.limitReached;
  // The seal is the end of the volume's pre-production, and this is the only place that knows whether the
  // volume reached it. `glossary/store.js` refuses to seal without it.
  ctx.qaAccepted = result.accepted === true;
  return result;
}


/**
 * The feedback step the shared loop always runs between grades: a sentence, not an agent.
 *
 * Saying out loud that nothing was rewritten is what keeps the loop's shape identical to every other
 * stage's instead of forking a second loop that could drift from the first.
 *
 * @param {GlossaryVolumeCtx} ctx
 * @returns {void}
 */
function runFeedbackNote(ctx) {
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: nothing was rewritten — ${GLOSSARY_ARTIFACT_NAME} is rendered from the ` +
      "volume's record, so the rows it holds are the rows the record holds."
  );
}


/**
 * Shared acceptance check: always a tool-less single-shot call.
 * The model sees the glossary ITSELF plus its validation report (the report is a guide, not the source of
 * truth) and scores it 0–100 (100 = perfect, 0 = atrocious) as a JSON reply {score, band, note}; the
 * score — not a binary verdict — is what the rolling window tracks.
 *
 * With a record open the grader is shown a sample chosen by code instead of the whole cumulative
 * glossary, and the deterministic audit that replaced the validator agent is already in the message as
 * the validation file. The rubric, the score contract, the judging temperature and the response format
 * are the ones the whole-document grade used.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (see glossary/task.js).
 * @param {number|string} iteration - The current QA iteration (for the log label).
 * @param {number} [temperature] - Override the judging temperature (the confirmation re-grades).
 * @returns {Promise<number | null>} The parsed score (0–100), or `null` when no valid score could be
 *   extracted (treated as a failed check).
 */
async function acceptanceCheck(ctx, iteration, temperature) {
  const { values, validationOutputFile, acceptancePrompt, acceptanceSystemPrompt, glossaryOutputFile } = ctx;
  const sample = await glossaryGradeSample(ctx);
  const acceptanceOutput = await harness.runOneShot({
    systemPrompt: acceptanceSystemPrompt,
    messages: [
      sample !== null ? { text: sample, name: "glossary.md (sample)" } : { file: glossaryOutputFile, name: "glossary.md" },
      { file: validationOutputFile, name: "glossary-validation.md" },
      { text: sample !== null ? acceptancePrompt + SAMPLED_GRADE_NOTE : acceptancePrompt },
    ],
    // A grader, not a writer: JUDGE_TEMPERATURE (the house writing temperature used to apply here, which
    // made the acceptance score needlessly noisy) and STAGE_THINKING_LEVEL (the authoring level spent
    // whole reply budgets thinking on these calls and answered with nothing — gotcha 59).
    temperature: temperature ?? judgeTemperature(),
    ...judgeThinking("ACCEPTANCE"),
    // The rubric's answer shape, asked for on the wire and not only in the prompt. The parser below is
    // still what decides; this only makes a wrong-shaped answer a named refusal instead of something to
    // guess at.
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

// ─── Deterministic term-coverage audit ──────────────────────────────────────
// The record's audit checks the rows against the book (a query); `glossary/coverage.js` adds the other
// deterministic half — exact occurrence counts of every glossary term in this volume's source text — and
// doubles as the per-volume "terms used here" index the translation stage needs (the cumulative glossary
// grows; a translator of volume N only needs the terms volume N actually uses).


module.exports = {
  acceptanceCheck,
  runQaLoop,
  runFeedbackNote,
};

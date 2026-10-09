/**
 * Scoring the wiki 0-100. One acceptance one-shot sees the two artifacts and the validation report (the report is a guide; the artifact is what gets judged), samples like a grader rather than like a writer, and replies as one JSON object. Shared by the whole-installment loop and the chapter-by-chapter loop, which is why it is its own module: the two loops must grade a wiki the same way.
 *
 * Part of the jump-in-wiki.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { ACCEPTANCE_PASSING_SCORE, judgeTemperature, judgeThinking, acceptanceResponseFormat } = require("../configs/shared");
const { parseAcceptanceReply } = require("../utils/prompt");

/**
 * The wiki acceptance check (called by the shared QA loop in
 * utils/qa-loop.js): a tool-less one-shot over the wiki artifacts + the
 * standard validation report; the model scores 0–100 as a JSON reply.
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
 * @param {number} iteration - The current QA iteration (for the log label).
 * @returns {Promise<number|null>} The parsed score, or `null` when no valid
 *   score could be extracted (treated as a failed check).
 */
async function wikiAcceptanceCheck(ctx, iteration, temperature) {
  const { values, validationOutputFile } = ctx;
  const acceptanceOutput = await harness.runOneShot({
    systemPrompt: ctx.acceptanceSystemPrompt,
    messages: [
      { file: ctx.wikiOutputFile, name: "wiki.md" },
      { file: ctx.sharedWikiOutputFile, name: "shared-wiki.md" },
      { file: validationOutputFile, name: path.basename(validationOutputFile) },
      { text: ctx.acceptanceUserPrompt },
    ],
    temperature: temperature ?? judgeTemperature(),
    ...judgeThinking("ACCEPTANCE"),
    responseFormat: acceptanceResponseFormat(),
    label: `jump-in-wiki-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}`,
  });
  const reply = parseAcceptanceReply(acceptanceOutput);
  if (reply === null) {
    console.log(
      `Acceptance check: no valid score in response ` +
        `(got: ${JSON.stringify(acceptanceOutput.trim().slice(0, 120))}). ` +
        `Counting this check as a failure.`
    );
  } else {
    console.log(
      `Acceptance check: score ${reply.score}/100` +
        (reply.band ? ` (band: ${reply.band})` : "") +
        (reply.note ? ` — ${reply.note}` : "") +
        ` (passing score: ${ACCEPTANCE_PASSING_SCORE})`
    );
  }
  return reply ? reply.score : null;
}


module.exports = {
  wikiAcceptanceCheck,
};

/**
 * Measuring the conversation against AI_CONTEXT_WINDOW. The number in the pressure line is the honest half available: tools run before the model reports its usage, so a tool answer's line is built from the PREVIOUS request's count plus this project's own calibrated estimate, whichever is larger. The library's own estimate (JSON.stringify().length / 4) is not a measurement — this project measures Japanese at 1.6-1.7 characters per token.
 *
 * Part of the context.js layer (split out of the original single file).
 */

const { scriptMixOf, estimateMix, activeCoefficients, tokenEstimateMargin } = require("../tokens");

const { contextHardLimit, contextSoftLimit } = require("./limits");

/**
 * The text a message actually contributes to the prompt.
 *
 * A ModelMessage's content is a string or an array of parts (text, reasoning,
 * tool-call with its input JSON, tool-result with its output JSON). Serialising
 * the content is what the server effectively bills, including the JSON
 * punctuation — which matters, because a tool result is a JSON object and its
 * braces and quotes are billed too.
 *
 * @param {Object} message - One AI SDK ModelMessage.
 * @returns {string}
 */
function messageText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return JSON.stringify(content);
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}


/**
 * Estimate what a conversation costs the model, using THIS project's calibrated
 * coefficients instead of the library's `characters / 4`.
 *
 * The library's rule is a fair guess for English and a bad one here: Japanese
 * measures 1.6–1.7 characters per token, so dividing by four under-counts a
 * Japanese-heavy transcript by roughly 2.5×. Under-counting is the direction that
 * makes a trim happen too late, which is what defect A looked like in the logs.
 *
 * Same guarantee as `tokenBudgetFor` (gotcha 54): an OVER-estimate, with
 * TOKEN_ESTIMATE_MARGIN applied.
 *
 * @param {Array<Object>} messages - The conversation (AI SDK ModelMessages).
 * @returns {number} Estimated tokens (rounded up).
 */
function estimateMessagesTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let cjk = 0;
  let other = 0;
  for (const msg of list) {
    const mix = scriptMixOf(messageText(msg));
    cjk += mix.cjk;
    other += mix.other;
  }
  return estimateMix({ cjk, other, total: cjk + other }, { includeOverhead: false });
}


/**
 * The library's yardstick, exported so a test can name the number this module
 * exists to replace. Not used by any decision.
 * @param {Array<Object>} messages
 * @returns {number}
 */
function naiveLibraryEstimate(messages) {
  return Math.ceil(JSON.stringify(messages ?? []).length / 4);
}

// ─── Pressure ───────────────────────────────────────────────────────────────


/**
 * How full the working window is.
 *
 * Two measurements, and the larger one wins:
 *   - the server's own count for the last step (`session.lastInputTokens`) —
 *     authoritative when the server reports usage;
 *   - this module's estimate of the whole conversation — what catches a session
 *     that grew during a chunk on a server that reports no usage at all
 *     (`test/fake-backend.js` can script exactly that).
 *
 * @param {Object} input
 * @param {number} [input.lastInputTokens] - The server's count for the last step.
 * @param {Array<Object>} input.messages - The conversation.
 * @param {number} input.contextWindow - The window this handle is working against.
 * @returns {{tokens: number, window: number, fraction: number, level: "ok"|"soft"|"hard", estimated: number, reported: number}}
 */
function windowPressure({ lastInputTokens = 0, messages, contextWindow }) {
  const estimated = estimateMessagesTokens(messages);
  const reported = Number.isFinite(lastInputTokens) ? lastInputTokens : 0;
  const tokens = Math.max(estimated, reported);
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
  const fraction = window > 0 ? tokens / window : 0;
  let level = "ok";
  if (window > 0) {
    if (fraction >= contextHardLimit()) level = "hard";
    else if (fraction >= contextSoftLimit()) level = "soft";
  }
  return { tokens, window, fraction, level, estimated, reported };
}


module.exports = {
  messageText,
  estimateMessagesTokens,
  naiveLibraryEstimate,
  windowPressure,
};

/**
 * utils/tokens/budget.js — the arithmetic every size decision is made from.
 *
 * How much room a prompt has after the reply, the references, the instructions and the chat
 * template are paid for; how much of the window a chunk may use; how much a cumulative
 * artifact is expected to grow; how much room a chat reply has left. Pure numbers over the
 * active coefficients — no model call, no file read.
 */

const {
  tokenEstimateMargin,
  activeCoefficients,
  DEFAULT_CJK_WEIGHT,
  DEFAULT_OTHER_WEIGHT,
  DEFAULT_TEMPLATE_OVERHEAD,
} = require("./estimate");

// ─── Budget arithmetic (pure) ────────────────────────────────────────────────

/**
 * How much source text a single pass may carry.
 *
 * The window is not the budget. What a pass actually has to fit is the source
 * PLUS the reference material it injects PLUS its instructions, and it has to
 * leave room for the answer it is going to write — a whole-volume glossary pass
 * must WRITE a whole glossary, and the pipeline has measured replies of 21,816
 * tokens. The safety fraction exists because a window that is exactly full is a
 * window with no room for the tail of a long generation.
 *
 * Pure — unit-tested.
 *
 * @param {{roleWindow: number, outputReserve: number, referenceTokens?: number, promptTokens?: number, templateOverhead?: number, safetyFraction?: number}} p
 * @returns {{budget: number, roleWindow: number, outputReserve: number, referenceTokens: number, promptTokens: number, templateOverhead: number, safetyFraction: number}}
 */
function tokenBudgetFor({
  roleWindow,
  outputReserve,
  referenceTokens = 0,
  promptTokens = 0,
  templateOverhead = null,
  safetyFraction = 0.75,
}) {
  const window = Math.max(0, roleWindow || 0);
  const fraction = Math.min(1, Math.max(0.1, safetyFraction));
  const room = Math.floor(window * fraction);
  // The chat template is billed ONCE, here, because it is a property of the
  // request rather than of any one block inside it.
  const overhead = Number.isFinite(templateOverhead)
    ? templateOverhead
    : activeCoefficients().templateOverhead;
  const budget = Math.max(
    0,
    room - (outputReserve || 0) - (referenceTokens || 0) - (promptTokens || 0) - overhead
  );
  return {
    budget,
    roleWindow: window,
    outputReserve: outputReserve || 0,
    referenceTokens: referenceTokens || 0,
    promptTokens: promptTokens || 0,
    templateOverhead: overhead,
    safetyFraction: fraction,
  };
}

/**
 * One greppable line describing the coefficients a stage is estimating with, so
 * a run log can explain a size decision after the fact.
 *
 * @param {string} label
 * @returns {string}
 */
function describeCoefficients(label) {
  const c = activeCoefficients();
  return (
    `[tokens] ${label}: ${c.cjkWeight} tok/CJK char, ${c.otherWeight} tok/other char, ` +
    `+${c.templateOverhead} template overhead, ×${tokenEstimateMargin()} safety margin (${c.source})`
  );
}

/**
 * The endpoint a pre-production task runs on: the global AI_* settings (those
 * four tasks have no role prefix of their own — the hooks still decide which
 * container answers).
 *
 * @returns {{baseUrl: string, apiKey: string|undefined, model: string}}
 */
function globalEndpoint() {
  return {
    baseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL || "local",
  };
}

/**
 * The context window and reply reserve a stage should budget against: the role's
 * own when it has one, else the global AI_* values the harness derives.
 *
 * @param {{contextWindow?: number|null, maxTokens?: number|null}} [role] - The role endpoint's own overrides.
 * @returns {{roleWindow: number, outputReserve: number}}
 */
/**
 * How much of a model's context window a single pass may consider itself
 * entitled to. One knob for both size decisions in the pipeline (the whole-
 * installment decision and the chapter-part decision), because they are the
 * same question: a window that is exactly full is a window with no room for
 * the tail of a long generation.
 *
 * @returns {number} SOURCE_CHUNK_SAFETY_FRACTION (default 0.75).
 */
function chunkSafetyFraction() {
  const n = parseFloat(process.env.SOURCE_CHUNK_SAFETY_FRACTION);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.75;
}

/**
 * How much a cumulative reference is expected to grow from one volume to the
 * next (ARTIFACT_GROWTH_FACTOR, default 1.25).
 *
 * The glossary / voice reference / style guide / shared wiki carry everything
 * the previous volume's copy contained and add this volume's findings, so the
 * previous volume's artifact is the honest floor for what the next one must
 * write. The factor is the additions. Measured on the fixture's two volumes the
 * style guide grew 3,590 → 6,127 tokens (1.71×), but that is a tiny base; 1.25
 * is the conservative default for a long series.
 *
 * @returns {number}
 */
function artifactGrowthFactor() {
  const n = parseFloat(process.env.ARTIFACT_GROWTH_FACTOR);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 1.25;
}

/**
 * The room a stage's ANSWER needs, measured from what that stage has already
 * had to write, checked against the output cap the server actually enforces.
 *
 * Why this is a separate question from the request budget: the server admits a
 * request by `prompt + max_tokens ≤ window`, so the budget arithmetic must keep
 * subtracting the CONFIGURED cap whatever the answer is expected to be. What the
 * measurement answers is the other question — can the answer the stage needs
 * actually be GENERATED inside that cap? A cumulative reference that outgrows
 * the cap is a stage that starts cutting its own document off mid-write, and it
 * is worth knowing before the run, in numbers, rather than afterwards from a
 * worse artifact.
 *
 * @param {{expectedTokens: number, outputReserve: number, margin?: number|null}} p
 * @returns {{expectedTokens: number, guardedTokens: number, outputCap: number, headroom: number, fits: boolean}}
 */
function answerRoom({ expectedTokens, outputReserve, margin = null }) {
  const m = Number.isFinite(margin) ? margin : tokenEstimateMargin();
  const expected = Math.max(0, Math.round(expectedTokens || 0));
  const guarded = Math.ceil(expected * m);
  const cap = Math.max(0, outputReserve || 0);
  return {
    expectedTokens: expected,
    guardedTokens: guarded,
    outputCap: cap,
    headroom: cap - guarded,
    // No cap configured → nothing to compare against; report it as fitting
    // rather than inventing a limit the server does not have.
    fits: cap <= 0 ? true : guarded <= cap,
  };
}

function budgetFor(role = {}) {
  const harness = require("../../harness");
  const roleWindow =
    Number.isFinite(role.contextWindow) && role.contextWindow > 0
      ? role.contextWindow
      : harness.envContextWindow();
  const outputReserve =
    Number.isFinite(role.maxTokens) && role.maxTokens > 0
      ? role.maxTokens
      : harness.envMaxTokens();
  return { roleWindow, outputReserve };
}

module.exports = {
  tokenBudgetFor,
  describeCoefficients,
  globalEndpoint,
  chunkSafetyFraction,
  artifactGrowthFactor,
  answerRoom,
  budgetFor,
};

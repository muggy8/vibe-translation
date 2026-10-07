/**
 * utils/tokens/estimate.js — the estimate itself: per-character, with per-model coefficients.
 *
 * A token count belongs to a (text, MODEL) pair, not to the text alone: the pipeline runs up to
 * four different models, each with its own tokenizer, so a number stamped once at intake is a
 * lie the moment a role runs on a different container. The mix of scripts is a property of the
 * text; the coefficients are a property of the endpoint, and the active pair is module state
 * because every budget question in the process has to be answered with the SAME coefficients.
 * 
 * The estimate must stay an OVER-estimate: over-estimating trims a little more than strictly
 * needed, which is the safe direction; under-estimating is how a request gets rejected mid-run
 * by the server.
 */

// ─── Coefficients (the built-in, un-calibrated estimate) ─────────────────────

/**
 * Tokens per CJK character (kana + hangul + Han, including the extension and
 * compatibility blocks). Fitted against the server's own counts: a whole
 * Japanese light novel measures 0.588–0.622 tokens per character overall, and
 * the non-CJK part of that text measures ~0.25, which puts the CJK characters
 * at ~0.69. A kanji is often more than one token and a kana usually less; 0.69
 * is the middle of that, not a claim about either.
 */
const DEFAULT_CJK_WEIGHT = 0.69;

/** Tokens per non-CJK character (Latin, punctuation, digits, whitespace). */
const DEFAULT_OTHER_WEIGHT = 0.25;

/**
 * Tokens the model server's chat template adds around the message content,
 * measured directly: an empty user message costs 52 tokens. It is a per-request
 * constant, so a prompt built from ten blocks pays it once, not ten times.
 */
const DEFAULT_TEMPLATE_OVERHEAD = 52;

/**
 * The safety margin applied on top of the estimate (TOKEN_ESTIMATE_MARGIN,
 * default 1.15). This is the guarantee that the estimate is an over-estimate:
 * the calibration is fitted to the measured MEAN, and the mean of a real
 * distribution is below its top — a chapter that lands on the unlucky tail is
 * the one that gets rejected.
 *
 * The size of it is measured, not guessed. Calibrated against the live server,
 * the base estimate (no margin) lands up to ~5% UNDER a specific volume's own
 * count (the script mix varies volume to volume), so a 10% margin left only 5%
 * of headroom on the worst volume of the series. 15% keeps every volume of the
 * series above its real count with room to spare, and still leaves the largest
 * volume inside the allowance.
 *
 * Before this existed the margin was accidental: the coefficients were 1.45×
 * too high, which "guaranteed" over-estimation by wasting 45% of the budget.
 *
 * @returns {number}
 */
function tokenEstimateMargin() {
  const n = parseFloat(process.env.TOKEN_ESTIMATE_MARGIN);
  return Number.isFinite(n) && n >= 1 ? n : 1.15;
}

// ─── Script mix (a property of the text) ─────────────────────────────────────

/**
 * Count a text's characters by script, the half that belongs to the TEXT.
 *
 * Deliberately not a language table: French and Spanish are both Latin script
 * and share a ratio, and a "Japanese" light novel is 17–20% Latin, punctuation
 * and whitespace. The mix is measured from the text itself, so a series with an
 * unusual mix (heavy loanwords, heavy Latinized names) gets its own number
 * instead of the one its language name implies.
 *
 * @param {string} text
 * @returns {{cjk: number, other: number, total: number}}
 */
function scriptMixOf(text) {
  const t = typeof text === "string" ? text : String(text ?? "");
  let cjk = 0;
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    const isCjk =
      (cp >= 0x3040 && cp <= 0x30ff) || // hiragana + katakana
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
      (cp >= 0x1100 && cp <= 0x11ff) || // Hangul jamo
      (cp >= 0xf900 && cp <= 0xfaff); // CJK compatibility
    if (isCjk) cjk++;
  }
  return { cjk, other: t.length - cjk, total: t.length };
}

// ─── The active calibration (a property of the model endpoint) ───────────────

/**
 * The coefficients in force for this process. null = the built-in defaults.
 * Set by ensureTokenCalibration() at stage start; read by every estimateTokens()
 * call, which is synchronous.
 *
 * @type {{cjkWeight: number, otherWeight: number, templateOverhead: number, source: string}|null}
 */
let activeCalibration = null;

/**
 * The coefficients currently in force (for logging and tests).
 * @returns {{cjkWeight: number, otherWeight: number, templateOverhead: number, source: string}}
 */
function activeCoefficients() {
  if (activeCalibration) return activeCalibration;
  return {
    cjkWeight: DEFAULT_CJK_WEIGHT,
    otherWeight: DEFAULT_OTHER_WEIGHT,
    templateOverhead: DEFAULT_TEMPLATE_OVERHEAD,
    source: "built-in defaults",
  };
}

/**
 * Replace the coefficients in force for this process.
 * @param {{cjkWeight?: number, otherWeight?: number, templateOverhead?: number, source?: string}|null} cal
 */
function setCalibration(cal) {
  activeCalibration = cal
    ? {
        cjkWeight: Number.isFinite(cal.cjkWeight) ? cal.cjkWeight : DEFAULT_CJK_WEIGHT,
        otherWeight: Number.isFinite(cal.otherWeight) ? cal.otherWeight : DEFAULT_OTHER_WEIGHT,
        templateOverhead: Number.isFinite(cal.templateOverhead) ? cal.templateOverhead : DEFAULT_TEMPLATE_OVERHEAD,
        source: cal.source || "calibration",
      }
    : null;
}

/**
 * Estimate the tokens a piece of text costs, using the coefficients in force,
 * with the safety margin applied.
 *
 * The chat-template overhead is NOT included: it is a per-REQUEST constant, and
 * this function is called once per prompt BLOCK (glossary, background, style
 * rules, …). Charging 52 tokens to each of five blocks would bill the same
 * overhead five times. It is subtracted once, in tokenBudgetFor.
 *
 * @param {string} text
 * @returns {number} Estimated token count (rounded up, always an over-estimate).
 */
function estimateTokens(text) {
  return estimateMix(scriptMixOf(text), { includeOverhead: false });
}

/**
 * Estimate from a script mix (the form the source bundle persists, so a cached
 * extraction does not have to be re-read to re-estimate under a new model).
 *
 * @param {{cjk: number, other: number, total: number}} mix
 * @param {{includeOverhead?: boolean, margin?: boolean}} [opts] - overhead (the chat template) defaults to false: it belongs to a request, not to a block. margin defaults to true.
 * @returns {number}
 */
function estimateMix(mix, { includeOverhead = false, margin = true } = {}) {
  const c = activeCoefficients();
  const raw = (mix.cjk || 0) * c.cjkWeight + (mix.other || 0) * c.otherWeight;
  const withOverhead = includeOverhead ? raw + c.templateOverhead : raw;
  return Math.ceil(withOverhead * (margin ? tokenEstimateMargin() : 1));
}

module.exports = {
  DEFAULT_CJK_WEIGHT,
  DEFAULT_OTHER_WEIGHT,
  DEFAULT_TEMPLATE_OVERHEAD,
  tokenEstimateMargin,
  scriptMixOf,
  activeCoefficients,
  setCalibration,
  estimateTokens,
  estimateMix,
};

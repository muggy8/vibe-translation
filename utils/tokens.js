/**
 * utils/tokens.js — token accounting for the pipeline.
 *
 * The pipeline has no tokenizer (the model server owns one), so every size
 * decision it makes — how much reference material a prompt may carry, whether a
 * volume is processed whole or chapter by chapter — rests on an ESTIMATE. This
 * module is the one place that estimate lives.
 *
 * Two facts the design rests on, both measured against the live server rather
 * than assumed (see the provenance notes below):
 *
 *   1. A token count belongs to a (text, MODEL) pair, not to the text alone.
 *      The pipeline runs up to four different models (translate / verify / edit
 *      / audit), each with its own tokenizer. A number stamped once at intake is
 *      a lie the moment a role runs on a different container. So the estimate is
 *      per-character (a property of the text) and the COEFFICIENTS are per model
 *      endpoint (a property of the tokenizer).
 *
 *   2. The estimate must stay an OVER-estimate. Over-estimating trims a little
 *      more than strictly needed, which is the safe direction; under-estimating
 *      is how a request gets rejected mid-run by the server. The margin that
 *      guarantees it used to be accidental (the coefficients were ~1.45× too
 *      high); it is now explicit and tunable.
 *
 * Provenance (measured live on the 17-volume series, whole-installment text):
 *   - the server's own count for a whole volume: 75,757 / 91,464 / 109,628
 *     tokens for 128,744 / 151,549 / 176,201 characters — 0.588–0.622 tokens
 *     per character, stable across every volume of the series;
 *   - the previous coefficients (1.0 per CJK char, 0.35 per other) over-counted
 *     by 1.42–1.47× on both Japanese and Latin text, which made the prompt
 *     budget throw away roughly a fifth of the window's worth of reference
 *     material it could have kept;
 *   - the server's chat template costs 52 tokens for an empty user message.
 */

const fs = require("fs");
const path = require("path");
require("../types"); // JSDoc type definitions

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

// ─── Calibration cache ───────────────────────────────────────────────────────

/**
 * Where the per-endpoint calibrations are persisted. One small JSON file; it is
 * machine state, not pipeline output, and it is gitignored.
 * @returns {string}
 */
function calibrationFile() {
  const custom = (process.env.TOKEN_CALIBRATION_FILE || "").trim();
  if (custom) return path.resolve(custom);
  return path.join(__dirname, "..", ".token-calibration.json");
}

/** Whether calibration is enabled (TOKEN_CALIBRATION_ENABLED, default on). */
function calibrationEnabled() {
  const v = (process.env.TOKEN_CALIBRATION_ENABLED || "").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(v);
}

/** How many characters of real source text a calibration probe sends. */
function calibrationSampleChars() {
  const n = parseInt(process.env.TOKEN_CALIBRATION_SAMPLE_CHARS, 10);
  return Number.isInteger(n) && n >= 500 ? Math.min(n, 40000) : 8000;
}

/**
 * How long a stored calibration stays trusted (hours). A container switch that
 * puts a DIFFERENT model behind the same base URL and the same alias is the
 * failure this guards: the key cannot see the model change, so the age is what
 * eventually re-measures it. 0 = never expire (calibrate once per machine).
 * @returns {number}
 */
function calibrationMaxAgeHours() {
  const n = parseFloat(process.env.TOKEN_CALIBRATION_MAX_AGE_HOURS);
  return Number.isFinite(n) && n >= 0 ? n : 24;
}

/**
 * Which container the machine's hooks last started, or "" when the machine has
 * no switch hook (the common case, and the safe default).
 *
 * `hooks/.model-switch-state` is the ONLY authority this project has for "which
 * model is actually behind the shared port right now": every container on such a
 * machine advertises the same alias on the same URL, so `GET /v1/models` cannot
 * tell them apart (gotcha 22). The file is a documented hook convention rather
 * than something the code owns, so this reads it fail-open and treats a missing
 * or unreadable marker as "no information" — which leaves the key exactly what it
 * used to be.
 *
 * Read fresh on every call, never cached: a container switch mid-process (the
 * `translate-qa` loop switches up to twice per round; the autopilot switches
 * before every support-role turn) is precisely the event that must invalidate a
 * measurement taken minutes earlier.
 *
 * Lazy require: utils/hooks.js pulls in harness.js, and this module is required
 * by harness-adjacent code, so the edge is only created when a marker is
 * actually asked for.
 *
 * @returns {string} The marker's contents, trimmed; "" when there is none.
 */
function modelSwitchMarker() {
  try {
    const { getHooksDir } = require("./hooks");
    const file = path.join(getHooksDir(), ".model-switch-state");
    if (!fs.existsSync(file)) return "";
    return (fs.readFileSync(file, "utf8") || "").trim();
  } catch {
    return ""; // no hooks, no permission, no file: no information, not an error
  }
}

/**
 * The cache key for an endpoint.
 *
 * It is the base URL, the model id, and — when the machine has a model-switch
 * hook — the container that hook last started.
 *
 * The first two are NOT enough on a shared-port local setup: every container
 * advertises the alias "local" at the same URL (gotcha 22), so two different
 * models collide on one entry, and the only thing that ever re-measured the
 * swapped one was the age guard. That is too slow for a loop that alternates
 * containers every iteration: a manager turn measured against the translator
 * container would then be reused for the manager's own model for the rest of the
 * day. The marker makes the identity as good as the machine's own knowledge of
 * what is serving, and it also fixes the case the age guard could not: a
 * container that comes BACK reuses the measurement taken for it earlier in the
 * same run (polish's re-polish on the EDIT endpoint after the audit batch),
 * instead of paying for a third probe.
 *
 * The age guard stays: a container started by hand leaves the marker naming a
 * dir that is not serving (gotcha 22e), and the age is what eventually catches
 * that.
 *
 * @param {{baseUrl?: string, model?: string}} endpoint
 * @returns {string}
 */
function calibrationKey(endpoint = {}) {
  const base = String(endpoint.baseUrl || process.env.AI_BASE_URL || "").replace(/\/+$/, "");
  const model = String(endpoint.model || process.env.AI_MODEL || "");
  const serving = modelSwitchMarker();
  return serving ? `${base}|${model}|${serving}` : `${base}|${model}`;
}

/**
 * Read the calibration cache. Never throws: an unreadable or corrupt cache
 * means "no calibrations", which falls back to the built-in coefficients
 * (fail-open, the same rule the other persisted state files use).
 *
 * @returns {Object<string, Object>}
 */
function readCalibrationCache() {
  try {
    const raw = fs.readFileSync(calibrationFile(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.entries ? parsed.entries : {};
  } catch {
    return {};
  }
}

/**
 * Write one entry into the calibration cache. Best-effort: a cache that cannot
 * be written only costs a re-probe on the next run.
 *
 * @param {string} key
 * @param {Object} entry
 * @returns {boolean} true when the entry was persisted.
 */
function writeCalibrationEntry(key, entry) {
  try {
    const file = calibrationFile();
    const entries = readCalibrationCache();
    entries[key] = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: 1, entries }, null, 2) + "\n", "utf8");
    return true;
  } catch (err) {
    console.warn(`[tokens] could not write the calibration cache (${err.message}) — continuing.`);
    return false;
  }
}

/**
 * Derive the coefficients for a model from ONE measurement.
 *
 * One probe cannot solve two unknowns, so it solves the one that matters for
 * this pipeline's sources and keeps the fitted value for the other:
 *
 *   - a CJK-heavy sample (the normal case here) → solve the CJK weight, keep the
 *     fitted Latin weight;
 *   - a sample with too little CJK to solve for it (a French or Spanish series)
 *     → scale BOTH weights so the sample matches, which is the honest thing to
 *     do with one measurement.
 *
 * The template overhead is subtracted first: it is a per-request constant, and
 * leaving it in the numerator would charge it to the characters.
 *
 * Pure — no I/O, no model call. Unit-tested.
 *
 * @param {{cjk: number, other: number, total: number}} mix - The sample's script mix.
 * @param {number} actualTokens - The server's own count for the sample request.
 * @returns {{cjkWeight: number, otherWeight: number, templateOverhead: number}|null} null when the measurement is unusable.
 */
function deriveCoefficients(mix, actualTokens) {
  const total = (mix && mix.total) || 0;
  const cjk = (mix && mix.cjk) || 0;
  const other = (mix && mix.other) || 0;
  if (!Number.isFinite(actualTokens) || actualTokens <= 0 || total <= 0) return null;
  const measured = actualTokens - DEFAULT_TEMPLATE_OVERHEAD;
  if (measured <= 0) return null;

  if (cjk >= 200 && cjk / total >= 0.2) {
    const otherWeight = DEFAULT_OTHER_WEIGHT;
    const cjkWeight = (measured - other * otherWeight) / cjk;
    if (!Number.isFinite(cjkWeight) || cjkWeight <= 0) return null;
    return {
      cjkWeight: Math.min(1.5, Math.max(0.3, cjkWeight)),
      otherWeight,
      templateOverhead: DEFAULT_TEMPLATE_OVERHEAD,
    };
  }

  const base = cjk * DEFAULT_CJK_WEIGHT + other * DEFAULT_OTHER_WEIGHT;
  if (base <= 0) return null;
  const factor = measured / base;
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return {
    cjkWeight: Math.min(1.5, Math.max(0.3, DEFAULT_CJK_WEIGHT * factor)),
    otherWeight: Math.min(1.0, Math.max(0.05, DEFAULT_OTHER_WEIGHT * factor)),
    templateOverhead: DEFAULT_TEMPLATE_OVERHEAD,
  };
}

/**
 * The slice of a text a calibration probe sends.
 *
 * The MIDDLE, not the head. The head of a whole-installment file is the title
 * page, the contents list and the first chapter's opening — a denser, more
 * title-heavy slice than the book's running prose, which measures high (the
 * first 8,000 characters of a real volume measure ~0.63 tokens/char against the
 * whole book's ~0.60). A sample that is not representative is a coefficient that
 * is quietly too high for every later estimate.
 *
 * @param {string} text
 * @param {number} chars
 * @returns {string}
 */
function calibrationSample(text, chars = calibrationSampleChars()) {
  const t = typeof text === "string" ? text : String(text ?? "");
  if (t.length <= chars) return t;
  const start = Math.max(0, Math.floor((t.length - chars) / 2));
  return t.slice(start, start + chars);
}

// ─── Stage-start calibration ─────────────────────────────────────────────────

/**
 * Endpoints already calibrated (or already failed) in this process, so a
 * 17-volume run probes once, not once per volume.
 * @type {Map<string, Object|null>}
 */
const processCalibrated = new Map();

/**
 * Re-point the coefficients at an endpoint this process has ALREADY measured —
 * no probe, no I/O, synchronous.
 *
 * Needed because the active calibration is process-global, and a task that runs
 * two models in one volume (polish: the EDIT polisher, then the AUDIT auditor,
 * then a RE-polish back on EDIT) would otherwise budget the third phase with the
 * second phase's tokenizer. Cheap to call: it only applies a cached entry, and a
 * miss leaves the current coefficients alone.
 *
 * @param {{baseUrl?: string, model?: string}} endpoint
 * @returns {{cjkWeight: number, otherWeight: number, templateOverhead: number, source: string}}
 */
function useCalibrationFor(endpoint = {}) {
  const key = calibrationKey(endpoint);
  const cached = processCalibrated.get(key);
  if (cached) setCalibration({ ...cached, source: `this run (${key})` });
  return activeCoefficients();
}

/**
 * Make sure the coefficients in force describe the model this stage is about to
 * use. Called at stage start, next to the /v1/models sanity check, where the
 * hooks have already switched the right container in — which is what makes the
 * measurement describe the model that will actually do the work (measuring at
 * intake would describe whatever container happened to be up instead).
 *
 * Fail-soft by design: a probe that cannot run logs a warning and leaves the
 * built-in coefficients in force. Token accounting is a size decision, not a
 * correctness gate; it must never be the reason a run dies.
 *
 * @param {{baseUrl?: string, apiKey?: string, model?: string}} endpoint - The role's endpoint.
 * @param {{sampleText?: string, label?: string, dryRun?: boolean, log?: (line: string) => void}} [opts]
 * @returns {Promise<{source: string, cjkWeight: number, otherWeight: number, templateOverhead: number}|null>} The coefficients now in force, or null when calibration is off.
 */
async function ensureTokenCalibration(endpoint = {}, { sampleText = "", label = "", dryRun = false, log = null } = {}) {
  const say = log || ((line) => console.log(line));
  const key = calibrationKey(endpoint);

  if (processCalibrated.has(key)) {
    const cached = processCalibrated.get(key);
    if (cached) setCalibration({ ...cached, source: `this run (${key})` });
    return activeCoefficients();
  }

  const entries = readCalibrationCache();
  const stored = entries[key];
  const maxAge = calibrationMaxAgeHours();
  const storedAgeHours = stored && stored.calibratedAt
    ? (Date.now() - Date.parse(stored.calibratedAt)) / 3600000
    : Infinity;
  const storedUsable =
    stored &&
    Number.isFinite(stored.cjkWeight) &&
    Number.isFinite(stored.otherWeight) &&
    (maxAge === 0 || storedAgeHours <= maxAge);

  if (storedUsable) {
    processCalibrated.set(key, stored);
    setCalibration({
      cjkWeight: stored.cjkWeight,
      otherWeight: stored.otherWeight,
      templateOverhead: stored.templateOverhead,
      source: `calibrated ${storedAgeHours.toFixed(1)}h ago for ${key}`,
    });
    say(
      `[tokens] ${label || key}: reusing the calibration measured ${storedAgeHours.toFixed(1)}h ago ` +
        `(${stored.cjkWeight} tok/CJK char, ${stored.otherWeight} tok/other char).`
    );
    return activeCoefficients();
  }

  if (!calibrationEnabled() || dryRun) {
    processCalibrated.set(key, null);
    setCalibration(null);
    say(
      `[tokens] ${label || key}: no calibration (${dryRun ? "--dry-run" : "TOKEN_CALIBRATION_ENABLED=false"}) ` +
        `— using the built-in coefficients (${DEFAULT_CJK_WEIGHT} tok/CJK char, ${DEFAULT_OTHER_WEIGHT} tok/other char, ` +
        `+${DEFAULT_TEMPLATE_OVERHEAD} template, ×${tokenEstimateMargin()} margin).`
    );
    return activeCoefficients();
  }

  const sample = calibrationSample(sampleText);
  const mix = scriptMixOf(sample);
  if (mix.total < 500) {
    processCalibrated.set(key, null);
    setCalibration(null);
    say(
      `[tokens] ${label || key}: no source sample to calibrate against — using the built-in coefficients.`
    );
    return activeCoefficients();
  }

  let measured;
  try {
    const harness = require("../harness");
    measured = await harness.measurePromptTokens({
      ...endpoint,
      text: sample,
      label: label || "token calibration",
    });
  } catch (err) {
    // Fail-soft: the built-in coefficients are the conservative ones (they
    // over-count), so a failed probe degrades to trimming a little more, never
    // to a rejected request.
    processCalibrated.set(key, null);
    setCalibration(null);
    console.warn(
      `[tokens] ${label || key}: could not measure the endpoint (${err.message}) — ` +
        `using the built-in coefficients, which over-count (the safe direction).`
    );
    return activeCoefficients();
  }

  const derived = deriveCoefficients(mix, measured);
  if (!derived) {
    processCalibrated.set(key, null);
    setCalibration(null);
    console.warn(
      `[tokens] ${label || key}: the measurement (${measured} tokens for ${mix.total} chars) is not usable — ` +
        `using the built-in coefficients.`
    );
    return activeCoefficients();
  }

  const entry = {
    ...derived,
    calibratedAt: new Date().toISOString(),
    sample: { chars: mix.total, cjkChars: mix.cjk, actualTokens: measured },
  };
  writeCalibrationEntry(key, entry);
  processCalibrated.set(key, entry);
  setCalibration({ ...derived, source: `measured now for ${key}` });

  const builtIn = estimateMix(mix, { margin: false });
  say(
    `[tokens] ${label || key}: measured ${measured} tokens for a ${mix.total}-character sample of this ` +
      `volume (${(measured / mix.total).toFixed(3)} tok/char) → ${derived.cjkWeight} tok/CJK char, ` +
      `${derived.otherWeight} tok/other char. The built-in coefficients would have said ${builtIn}.`
  );
  return activeCoefficients();
}

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
  const harness = require("../harness");
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
  DEFAULT_CJK_WEIGHT,
  DEFAULT_OTHER_WEIGHT,
  DEFAULT_TEMPLATE_OVERHEAD,
  tokenEstimateMargin,
  scriptMixOf,
  estimateTokens,
  estimateMix,
  activeCoefficients,
  setCalibration,
  deriveCoefficients,
  ensureTokenCalibration,
  useCalibrationFor,
  calibrationFile,
  calibrationKey,
  calibrationEnabled,
  calibrationSampleChars,
  calibrationSample,
  calibrationMaxAgeHours,
  readCalibrationCache,
  writeCalibrationEntry,
  tokenBudgetFor,
  chunkSafetyFraction,
  artifactGrowthFactor,
  answerRoom,
  describeCoefficients,
  globalEndpoint,
  budgetFor,
};

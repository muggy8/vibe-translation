/**
 * utils/tokens/calibration.js — the measured coefficients, and where they are kept.
 *
 * One probe per (endpoint, model) per process, then a file: a 17-volume run measures the
 * tokenizer once, not seventeen times. The cache is keyed by endpoint AND model, and a model
 * switch leaves a marker so a stale entry cannot quietly follow the run onto a different
 * tokenizer.
 * 
 * deriveCoefficients is the arithmetic that turns one measured prompt into the two weights,
 * and calibrationSample is the slice of real text the probe is measured on — a sample of the
 * actual volume, not a synthetic string.
 */

const fs = require("fs");
const path = require("path");

const {
  DEFAULT_CJK_WEIGHT,
  DEFAULT_OTHER_WEIGHT,
  DEFAULT_TEMPLATE_OVERHEAD,
} = require("./estimate");

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
    const { getHooksDir } = require("../hooks");
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

module.exports = {
  calibrationFile,
  calibrationEnabled,
  calibrationSampleChars,
  calibrationMaxAgeHours,
  modelSwitchMarker,
  calibrationKey,
  readCalibrationCache,
  writeCalibrationEntry,
  deriveCoefficients,
  calibrationSample,
};

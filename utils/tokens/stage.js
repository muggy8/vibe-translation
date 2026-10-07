/**
 * utils/tokens/stage.js — calibrate once, at the start of a stage.
 *
 * ensureTokenCalibration is what a task calls before it builds its first prompt: it asks the
 * server to count one real prompt, derives the coefficients, stores them, and remembers for
 * the rest of the process that this endpoint has been measured. A probe that cannot run is
 * NOT a failure — it degrades to the built-in coefficients, which over-count (the safe
 * direction) — and --dry-run makes no model call at all.
 * 
 * harness is required lazily: utils/hooks.js pulls in harness.js and this module is required
 * by harness-adjacent code, so the edge is only created when the probe actually runs.
 */

const {
  tokenEstimateMargin,
  scriptMixOf,
  activeCoefficients,
  setCalibration,
  estimateMix,
  DEFAULT_CJK_WEIGHT,
  DEFAULT_OTHER_WEIGHT,
  DEFAULT_TEMPLATE_OVERHEAD,
} = require("./estimate");
const {
  calibrationEnabled,
  calibrationMaxAgeHours,
  calibrationKey,
  readCalibrationCache,
  writeCalibrationEntry,
  deriveCoefficients,
  calibrationSample,
} = require("./calibration");

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
    const harness = require("../../harness");
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

module.exports = { useCalibrationFor, ensureTokenCalibration };

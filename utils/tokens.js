/**
 * utils/tokens.js — token accounting for the pipeline.
 *
 * The pipeline has no tokenizer (the model server owns one), so every size
 * decision it makes — how much reference material a prompt may carry, whether a
 * volume is processed whole or chapter by chapter — rests on an ESTIMATE. This
 * module is the one place that estimate lives.
 *
 * The code lives in utils/tokens/: estimate.js (the per-character estimate and the
 * coefficients that are active right now), calibration.js (the measured coefficients and
 * where they are kept), stage.js (calibrate once, at the start of a stage), budget.js (the
 * arithmetic every size decision is made from). This file is the public surface.
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

const estimate = require("./tokens/estimate");
const calibration = require("./tokens/calibration");
const stage = require("./tokens/stage");
const budget = require("./tokens/budget");

// The public surface, unchanged from the single file.
module.exports = {
  DEFAULT_CJK_WEIGHT: estimate.DEFAULT_CJK_WEIGHT,
  DEFAULT_OTHER_WEIGHT: estimate.DEFAULT_OTHER_WEIGHT,
  DEFAULT_TEMPLATE_OVERHEAD: estimate.DEFAULT_TEMPLATE_OVERHEAD,
  tokenEstimateMargin: estimate.tokenEstimateMargin,
  scriptMixOf: estimate.scriptMixOf,
  estimateTokens: estimate.estimateTokens,
  estimateMix: estimate.estimateMix,
  activeCoefficients: estimate.activeCoefficients,
  setCalibration: estimate.setCalibration,
  deriveCoefficients: calibration.deriveCoefficients,
  ensureTokenCalibration: stage.ensureTokenCalibration,
  useCalibrationFor: stage.useCalibrationFor,
  calibrationFile: calibration.calibrationFile,
  calibrationKey: calibration.calibrationKey,
  calibrationEnabled: calibration.calibrationEnabled,
  calibrationSampleChars: calibration.calibrationSampleChars,
  calibrationSample: calibration.calibrationSample,
  calibrationMaxAgeHours: calibration.calibrationMaxAgeHours,
  readCalibrationCache: calibration.readCalibrationCache,
  writeCalibrationEntry: calibration.writeCalibrationEntry,
  tokenBudgetFor: budget.tokenBudgetFor,
  chunkSafetyFraction: budget.chunkSafetyFraction,
  artifactGrowthFactor: budget.artifactGrowthFactor,
  answerRoom: budget.answerRoom,
  describeCoefficients: budget.describeCoefficients,
  globalEndpoint: budget.globalEndpoint,
  budgetFor: budget.budgetFor,
};

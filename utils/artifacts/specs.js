/**
 * utils/artifacts/specs.js — the one table, and the two questions asked of it.
 *
 * The three halves joined, so a step is declared exactly once and the post-mortem looks one place
 * up. `specForStep` returning null rather than an empty spec is deliberate: an undeclared step
 * must be visible as a gap, not silently pass.
 *
 * The third half is the delivery layer. It is in the same table for the same reason: the point of
 * one table is that "is anything unchecked?" has one answer. Its expectations resolve against the
 * run folder instead of the corpus, so `run` is a scope only those four steps declare.
 */

const { PREPRODUCTION_SPECS } = require("./preproduction");
const { TRANSLATION_SPECS } = require("./translation");
const { DELIVERY_SPECS } = require("./delivery");

/** @typedef {import("../artifacts").StepArtifactSpec} StepArtifactSpec */

const STEP_ARTIFACT_SPECS = { ...PREPRODUCTION_SPECS, ...TRANSLATION_SPECS, ...DELIVERY_SPECS };

// ─── Lookups ──────────────────────────────────────────────────────────────────

/**
 * The expectations for one step, or null when the step is not declared here.
 *
 * Returning null (rather than an empty spec) is deliberate: an undeclared step
 * must be visible as a gap in the post-mortem, not silently pass.
 *
 * @param {string} step - A gulp task name.
 * @returns {StepArtifactSpec|null}
 */
function specForStep(step) {
  return STEP_ARTIFACT_SPECS[step] || null;
}

/**
 * Every declared step name.
 * @returns {string[]}
 */
function declaredSteps() {
  return Object.keys(STEP_ARTIFACT_SPECS);
}

module.exports = { STEP_ARTIFACT_SPECS, specForStep, declaredSteps };

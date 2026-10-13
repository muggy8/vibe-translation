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
const { QUARANTINED_COPY_SEVERITY, QUARANTINED_COPY_MEANING, quarantineStem } = require("./rules");

/** @typedef {import("../artifacts").StepArtifactSpec} StepArtifactSpec */
/** @typedef {import("../artifacts").QuarantineExpectation} QuarantineExpectation */

/**
 * One volume folder's file names, as a Set.
 * @typedef {Set<string>} PresentFileNames
 */

/**
 * What one quarantine file means in one volume folder.
 *
 * @typedef {Object} QuarantineReading
 * @property {string|null} stem - The artifact the file NAMES, or null when it names none.
 * @property {string|null} owner - The step that declares THAT artifact, or null when no step declares it
 *   (`translation-<id>.rejected.md` names nothing declared, which is what makes a kept draft different).
 * @property {boolean} owned - Whether the step asking the question is the step that owns the artifact.
 * @property {boolean} damage - The named artifact is absent: a gate refused this volume's output and
 *   nothing stands in its place.
 * @property {boolean} blocksCompletion - `damage`, and this step is the one that owes that artifact.
 * @property {"HIGH"|"MEDIUM"|"LOW"} severity - The declared severity for damage, LOW for a kept copy.
 * @property {string} meaning - The sentence a report carries.
 */

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

// ─── What a quarantine file means ─────────────────────────────────────────────

/**
 * Resolve a declared expectation name against one volume.
 *
 * A declared name is a template (`translation-{installment}.md`), a folder holds a file name, and the
 * two only meet here. `utils/resume/state.js` does the same resolution for the same reason.
 *
 * @param {string} name
 * @param {string} installment
 * @returns {string}
 */
function resolveDeclaredName(name, installment) {
  return String(name || "").replace(/\{installment\}/g, String(installment || ""));
}

/**
 * Which step declares the artifact a quarantine file NAMES.
 *
 * `QUARANTINED_CUMULATIVE` is one pattern declared by three steps, so matching the pattern says only
 * that *a* gate fired. `character-voice.md.rejected` is the character-voice gate's evidence and nothing
 * to the glossary or the style guide — and reporting it as theirs is how one refused book reads as
 * three unfinished steps. `utils/resume/state.js` learned this in the resume triage (gotchas-70-80 #15);
 * this is the same rule where the patterns live, so every door can use it.
 *
 * @param {string} name - A file name in a volume folder.
 * @param {string} installment - The volume's installment number.
 * @returns {string|null} The owning step, or null when no step declares the artifact it names.
 */
function quarantineOwner(name, installment) {
  const stem = quarantineStem(name);
  if (!stem) return null;
  for (const step of Object.keys(STEP_ARTIFACT_SPECS)) {
    const spec = STEP_ARTIFACT_SPECS[step];
    if (!spec.perVolume) continue;
    if ((spec.volume || []).some((e) => resolveDeclaredName(e.name, installment) === stem)) return step;
  }
  return null;
}

/**
 * Read one quarantine file in one volume folder, beside the files that folder actually holds.
 *
 * The file name cannot say which act wrote it — a carry-forward refusal, a failing grade and a routine
 * re-render all go through `moveArtifactAside` and all write the same name. The folder can: if the
 * artifact the quarantine NAMES is present, the refusal was replaced; if it is absent, nothing stands in
 * its place. That is decided from the disk, for free, with no model call and no new setting.
 *
 * @param {Object} opts
 * @param {QuarantineExpectation} opts.quarantine - The expectation that matched the file.
 * @param {string} opts.name - The file name.
 * @param {StepArtifactSpec} opts.spec - The step asking.
 * @param {string} opts.installment - The volume's installment number.
 * @param {PresentFileNames} opts.presentNames - Every regular file in that volume folder.
 * @returns {QuarantineReading}
 */
function classifyVolumeQuarantine({ quarantine, name, spec, installment, presentNames }) {
  const stem = quarantineStem(name);
  const owner = quarantineOwner(name, installment);
  const owned = Boolean(owner) && owner === spec.step;
  const namesArtifact = Boolean(stem) && Boolean(owner);
  const present = Boolean(stem) && presentNames.has(stem);
  const damage = namesArtifact && !present;
  const keptCopy = namesArtifact && present;
  return {
    stem,
    owner,
    owned,
    damage,
    blocksCompletion: damage && owned,
    // A kept copy of a refused artifact is LOW; everything else keeps the severity its own expectation
    // declares — which is what keeps a kept translation draft MEDIUM (gotcha 39) rather than folding it
    // into the same bucket as a superseded reference.
    severity: keptCopy ? QUARANTINED_COPY_SEVERITY : quarantine.severity,
    meaning: keptCopy
      ? `${QUARANTINED_COPY_MEANING} (${name} beside ${stem})`
      : damage
        ? quarantine.meaning
        : `${quarantine.meaning} (kept on purpose, and it names no artifact this pipeline declares)`,
  };
}

module.exports = {
  STEP_ARTIFACT_SPECS,
  specForStep,
  declaredSteps,
  resolveDeclaredName,
  quarantineOwner,
  classifyVolumeQuarantine,
};

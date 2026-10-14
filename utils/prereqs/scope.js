/**
 * utils/prereqs/scope.js — the two things every completion check needs before it can read a folder.
 *
 * Which volumes this run is about to process, and the settings the artifact declarations' `when`
 * predicates are read against. Both are resolved the way the post-mortem resolves them (its
 * `artifactContext` in utils/postmortem/run.js), because a gate and an assessment that disagree about
 * which files a step was even expected to write disagree about whether the step finished. `--volume NN`
 * narrows the volumes here and nowhere else, so the freeze gate asks this same function — one rule,
 * not two.
 *
 * @module utils/prereqs/scope
 */

const fs = require("fs");
const path = require("path");

const { filterVolumesByInstallment } = require("../manifest");

/** @typedef {import("../types").TranslationTargetVolume} TranslationTargetVolume */

/**
 * Resolve the `when` predicates' inputs for one gate evaluation.
 *
 * The same four settings the post-mortem resolves (`artifactContext` in utils/postmortem/run.js),
 * read the same way. Kept here rather than reached for because that function is not on the
 * postmortem barrel, and a gate that cannot run is not a gate.
 *
 * @returns {ArtifactContext}
 */
function gateContext() {
  return {
    researchEnabled: process.env.RESEARCH_ENABLED !== "false",
    verifyEnabled: process.env.VERIFY_TRANSLATE_ENABLED !== "false",
    volumeConsistencyEnabled: process.env.VOLUME_CONSISTENCY_ENABLED !== "false",
    polishVerifyEnabled: process.env.POLISH_VERIFY_ENABLED !== "false",
    installment: "",
  };
}

/**
 * The volumes this run is about to process.
 *
 * `--volume NN` narrows the check to that volume, and a single-volume run must not be blocked by an
 * untouched volume 14: the prerequisite that matters is the one for the book being started. A
 * `--volume` that matches nothing is reported as a gap rather than silently narrowing to nothing.
 *
 * @param {string} seriesDir
 * @param {string|null} volumeArg
 * @returns {{volumes: TranslationTargetVolume[], error: string|null}}
 */
function readVolumesInScope(seriesDir, volumeArg) {
  const planFile = path.join(seriesDir, "translation-target.json");
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  } catch {
    return { volumes: [], error: planFile };
  }
  const volumes = Array.isArray(plan.volumes) ? plan.volumes : [];
  if (!volumeArg) return { volumes, error: null };
  const picked = new Set(filterVolumesByInstallment(plan, volumeArg));
  if (picked.size === 0) {
    return {
      volumes: [],
      error:
        `--volume ${volumeArg} matches none of this series' volumes ` +
        `(${volumes.map((v) => `${v.installmentNumber} = ${v.folder}`).join(", ") || "none listed"})`,
    };
  }
  return { volumes: volumes.filter((v) => picked.has(v.folder)), error: null };
}

module.exports = {
  gateContext,
  readVolumesInScope,
};

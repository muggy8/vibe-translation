/**
 * utils/devteam/checks.js — the machine's verdict on a patch, and the line a human reads.
 *
 * The CLI runs the pinned checks; the team does not get to report its own result. `describePatch` is the
 * "what just happened" line — the manager reads `patches.md` for the detail.
 */

const path = require("path");

const patches = require("../patches");

const projectRoot = path.join(__dirname, "../.."); // devteam.js's ROOT

/**
 * Run the pinned checks against a patch. The CLI runs them; the team does not get to say it ran them.
 *
 * @param {string} patchId
 * @param {{root?: string, patchPaths?: {json: string, markdown: string}}} [opts]
 * @returns {{patch: Object|null, verdict: Object, error: string|null}}
 */
function verifyPatch(patchId, { root = projectRoot, patchPaths = patches.patchPaths() } = {}) {
  const ran = patches.runChecks({ root });
  return patches.recordChecks(patchId, ran, patchPaths);
}

/**
 * The patch as a human-readable line for the CLI's summary. The manager reads `patches.md` for the
 * detail; this is the "what just happened" line.
 *
 * @param {Object} patch
 * @returns {string}
 */
function describePatch(patch) {
  const parts = [`${patch.id} (${patch.status})`, `ticket ${patch.ticketId}`, `${patch.step}${patch.volume ? ` volume ${patch.volume}` : ""}`];
  if ((patch.files || []).length) parts.push(`${patch.files.length} file(s): ${patch.files.join(", ")}`);
  if (patch.checkVerdict) {
    parts.push(
      patch.checkVerdict.accepted
        ? "checks green"
        : `checks not green${patch.checkVerdict.missing.length ? ` (not run: ${patch.checkVerdict.missing.join(", ")})` : ""}${patch.checkVerdict.failed.length ? ` (failed: ${patch.checkVerdict.failed.join(", ")})` : ""}`
    );
  }
  return parts.join(" | ");
}

module.exports = { verifyPatch, describePatch };

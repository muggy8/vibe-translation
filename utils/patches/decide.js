/**
 * The manager's two verbs, and the reason both need a reason about the change rather than about the complaint.
 *
 * Part of the patches.js layer (split out of the original single file).
 */

const { patchPaths, readPatches, writePatches } = require("./record");
const { judgmentReasonIsSound } = require("./proposal");
const { judgeChecks } = require("./checks");

/**
 * The manager accepts or rejects a patch. It never applies one.
 *
 * Accepting runs nothing, deliberately. A code change takes effect through act mode's wipe-and-cascade
 * (gotcha 66): a running process cannot pick up a changed module, and the skip-checks do not know the
 * code changed, so "accept" that also re-ran a step would be two decisions in one command and the
 * expensive one would happen before the manager had read the proposal properly.
 *
 * @param {string} patchId
 * @param {{reason: string, decidedBy?: string}} judgment
 * @param {{json: string, markdown: string}} [paths]
 * @returns {{patch: Patch|null, error: string|null}}
 */
function acceptPatch(patchId, judgment, paths = patchPaths()) {
  return decidePatch(patchId, "accepted", judgment, paths);
}


/**
 * @param {string} patchId
 * @param {{reason: string, decidedBy?: string}} judgment
 * @param {{json: string, markdown: string}} [paths]
 * @returns {{patch: Patch|null, error: string|null}}
 */
function rejectPatch(patchId, judgment, paths = patchPaths()) {
  return decidePatch(patchId, "rejected", judgment, paths);
}


function decidePatch(patchId, outcome, judgment, paths) {
  const all = readPatches(paths.json).patches;
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return { patch: null, error: `no patch ${patchId}` };
  if (patch.status === "committed") {
    return { patch: null, error: `patch ${patchId} is committed. A commit is not undone by a judgment; it is undone by a revert, by the account owner.` };
  }
  if (patch.status === "accepted" || patch.status === "rejected") {
    return { patch: null, error: `patch ${patchId} is already ${patch.status}. A decision is recorded once.` };
  }
  if (!patch.summary) {
    return { patch: null, error: `patch ${patchId} has no proposal attached yet. There is nothing to judge.` };
  }
  const reason = String((judgment && judgment.reason) || "").trim();
  if (!reason) {
    return { patch: null, error: "a judgment must carry the reason it was made for — the same rule as a ticket choice (utils/tickets.js)." };
  }
  const sound = judgmentReasonIsSound(reason);
  if (!sound.ok) {
    return {
      patch: null,
      error:
        `the reason states only that the finding is gone. That is answerable by removing the thing that ` +
        `reported the finding, which is the failure this whole channel exists to refuse (gotcha 70). Say ` +
        `what about the DELIVERABLE made this acceptable or not.`,
    };
  }
  const verdict = patch.checkVerdict || judgeChecks(patch.checks || []);
  if (outcome === "accepted" && !verdict.accepted) {
    const parts = [];
    if (verdict.missing.length) parts.push(`not run: ${verdict.missing.join(", ")}`);
    if (verdict.failed.length) parts.push(`failed: ${verdict.failed.join(", ")}`);
    return {
      patch: null,
      error:
        `patch ${patchId} cannot be accepted while its checks are not green (${parts.join("; ")}). Run ` +
        `npm run fix -- --verify=${patchId}. The checks are run by the machine, not claimed by the team.`,
    };
  }

  patch.decision = { outcome, reason, decidedBy: (judgment && judgment.decidedBy) || "manager", at: new Date().toISOString() };
  patch.status = outcome;
  patch.updatedAt = new Date().toISOString();
  const written = writePatches(all, paths);
  return { patch: written.error ? null : patch, error: written.error || null };
}

// ─── The commit and the revert ────────────────────────────────────────────────


module.exports = {
  acceptPatch,
  rejectPatch,
  decidePatch,
};

/**
 * safeToAcceptAutomatically: ordinary project code, the pinned checks green, no warning on the proposal, nothing the team escalated in prose, and no measured regression on the deliverable. Anything else stops and names the account owner. Rejecting needs no gate — it is the direction that undoes work.
 *
 * Part of the manager.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions
const { patchTouchesBanned, isProjectSourcePath } = require("../patches");

const { NOT_ORDINARY_CODE } = require("./rules");

/**
 * @param {string} file - A declared patch path (project-relative).
 * @returns {{id: string, because: string}|null}
 */
function notOrdinaryCode(file) {
  const text = String(file || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
  for (const rule of NOT_ORDINARY_CODE) {
    if (rule.pattern.test(text)) return rule;
  }
  return null;
}


/**
 * @param {import("./patches").Patch} patch
 * @param {{outcome: string, regressions: Array<{name: string, from: number|null, to: number|null}>}|null} [comparison]
 *   The before/after measurement of the deliverable, when one exists (the cascade that ran after the
 *   patch landed, or a re-verify). Produced by `compareDeliverable` in `utils/delivery-verify.js`.
 * @returns {AutoAcceptVerdict}
 */
function safeToAcceptAutomatically(patch, comparison = null) {
  const reasons = [];
  const notes = [];
  if (!patch) return { safe: false, reasons: ["there is no patch to judge"], notes };

  // 1. The pinned checks ran, and passed. "The team says it ran them" is not this — the harness
  //    gives an agent no shell, so the machine ran them or they did not happen (gotcha 75).
  const verdict = patch.checkVerdict;
  if (!verdict || !verdict.accepted) {
    if (verdict && verdict.missing.length) reasons.push(`the pinned checks never ran: ${verdict.missing.join(", ")}`);
    if (verdict && verdict.failed.length) reasons.push(`a pinned check failed: ${verdict.failed.join(", ")}`);
    if (!verdict) reasons.push("the pinned checks have never been run on this patch");
  } else {
    notes.push(`pinned checks green: ${(patch.checks || []).map((c) => `${c.id} exit ${c.exitCode}`).join(", ")}`);
  }

  // 2. Ordinary project code: inside the project whitelist, outside the banned table, and not one of
  //    the things that judge the patch.
  const files = patch.files || [];
  if (!files.length) reasons.push("the patch declares no files, so there is nothing to attribute it to");
  const banned = patchTouchesBanned(files);
  for (const b of banned) reasons.push(`it touches a banned path (${b.file}): ${b.because}`);
  for (const f of files) {
    if (!isProjectSourcePath(f)) reasons.push(`${f} is not project source`);
    const notOrdinary = notOrdinaryCode(f);
    if (notOrdinary) reasons.push(`${f} is not ordinary code (${notOrdinary.id}): ${notOrdinary.because}`);
  }
  if (!reasons.length && files.length) notes.push(`${files.length} ordinary project file(s): ${files.join(", ")}`);

  // 3. The team's own claims are complete enough for a role that cannot read the diff to judge them.
  //    A warning on a patch is this module saying "the evidence here is thinner than it looks" —
  //    which is exactly the situation that should not be decided unattended.
  if (patch.warnings && patch.warnings.length) {
    for (const w of patch.warnings) reasons.push(`the patch carries a warning: ${w.message || w.kind}`);
  }
  if (String(patch.summary || "").trim().length < 60) {
    reasons.push("the summary is too short for a role that cannot read the diff to judge on");
  }
  if (!patch.expected || !patch.expected.length) {
    reasons.push("the patch names no deliverable signal it expects to move, so nothing measurable was claimed");
  }

  // 4. The team escalated in prose. `ownerNote` is where "I believe the guard is wrong" belongs, and a
  //    team that wrote one has already said this is the account owner's decision (gotcha 70/74).
  if (String(patch.ownerNote || "").trim()) {
    reasons.push("the team wrote an ownerNote, which is a route to the account owner, not to an auto-accept");
  }
  if (patch.questions && patch.questions.length) {
    reasons.push(`the team asked ${patch.questions.length} question(s) back, so the change is not settled`);
  }

  // 5. No deliverable regression — when a measurement exists. At judgment time it usually does not:
  //    the real before/after comes from the cascade that runs AFTER the patch is accepted, and the
  //    loop must report that outcome rather than assume it (see autopilot.js).
  if (comparison && comparison.outcome === "worse") {
    reasons.push(
      `the deliverable measured WORSE against this patch: ${(comparison.regressions || [])
        .map((m) => `${m.name} ${m.from} → ${m.to}`)
        .join("; ")}`
    );
  } else if (comparison) {
    notes.push(`deliverable measured ${comparison.outcome}`);
  }

  return { safe: reasons.length === 0, reasons, notes };
}

// ─── The call ─────────────────────────────────────────────────────────────────


module.exports = {
  notOrdinaryCode,
  safeToAcceptAutomatically,
};

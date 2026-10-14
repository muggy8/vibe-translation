/**
 * utils/prereqs/freeze/declared-artifacts.js — the artifact names this gate reasons about, read out
 * of `utils/artifacts.js` rather than written a second time here.
 *
 * Two queries over the same declaration. `requiredTranslationArtifacts` asks the `translate` step
 * which files make a volume a translated one — that is what "frozen" is built from. `doorArtifacts`
 * asks the door's own step which file it is about to write, which is what decides whether an act is
 * filling a hole or overwriting. Both resolve the `{installment}` placeholder and both keep only the
 * `required` level, because a second list of expected files is a second opinion about whether a
 * volume is finished (gotcha 141).
 *
 * @module utils/prereqs/freeze/declared-artifacts
 */

const { specForStep } = require("../../artifacts");
const { DOOR_OWNER } = require("./doors");

/** @typedef {import("../../artifacts").ArtifactExpectation} ArtifactExpectation */

/** @typedef {import("./doors").FreezeDoorRow} FreezeDoorRow */

/**
 * The `translate` step's own declared `required` per-volume artifact names, with the volume's
 * `{installment}` placeholder resolved.
 *
 * Written as a query over the declaration rather than as a list, on purpose: `translation.md` and
 * `translation-state.json` are what they are because `utils/artifacts/translation.js` says so, and a
 * second list here is a second opinion about whether a volume is translated (gotcha 141).
 *
 * @param {string} installment - The volume's two-digit installment number.
 * @returns {string[]} Declared names, resolved. Empty when `translate` declares no per-volume output.
 */
function requiredTranslationArtifacts(installment) {
  const spec = specForStep("translate");
  if (!spec || !spec.perVolume) return [];
  return spec.volume
    .filter((expect) => expect.level === "required")
    .map((expect) => expect.name.replace(/\{installment\}/g, String(installment || "")));
}

/**
 * The artifacts this door is about to overwrite in this volume, resolved from the door's own
 * declaration.
 *
 * A volume door is excused when the file it would write is NOT there — filling a hole is not
 * overwriting. A series door is judged by its series-root copy (`consistency-report.md`), which is
 * the only thing it writes. `extract` and `discover` declare nothing per volume and are not excused:
 * what they rewrite is the extracted text and the plan of record, and neither is a declared
 * per-volume file.
 *
 * **The acceptance records are not part of the answer.** `*-validation.md` and
 * `*-validation-*-rolling-state.json` are this pipeline's own gate records, not a thing a translation
 * read — `utils/prereqs.js` and `utils/postmortem/volume.js` both single them out the same way, and
 * `utils/series-run/skip.js` keys its skip on the rolling-state file. If they counted here, deleting
 * one would open the freeze on a volume whose published artifact is untouched: the manager's own
 * `wipe-and-cascade` deletes exactly that set, so counting them would make the gate a door the run
 * opens by removing its own paperwork.
 *
 * @param {FreezeDoorRow} row
 * @param {string} door
 * @param {string} installment
 * @returns {string[]} Empty when this door has no declared artifact to stand in for the act.
 */
function doorArtifacts(row, door, installment) {
  const owner = DOOR_OWNER[door] || door;
  const spec = specForStep(owner);
  if (!spec) return [];
  const list = row.scope === "series" ? spec.series || [] : spec.volume || [];
  return list
    .filter((expect) => expect.level === "required" && !isAcceptanceRecord(expect))
    .map((expect) => expect.name.replace(/\{installment\}/g, installment));
}

/**
 * Is one declared expectation this pipeline's own gate paperwork rather than an artifact a translation
 * consumed?
 *
 * The same two shapes `utils/prereqs.js` (its acceptance half) and `utils/postmortem/volume.js` (its
 * `accepted-without-acceptance` check) already single out, so the three of them agree on what a
 * validation report and an acceptance window ARE.
 *
 * @param {{name: string, shape?: string}} expect - A declared expectation.
 * @returns {boolean}
 */
function isAcceptanceRecord(expect) {
  const name = String((expect && expect.name) || "");
  return /-validation(?:-\{installment\})?\.md$/.test(name) ||
    (expect.shape === "json" && name.endsWith("-rolling-state.json"));
}

module.exports = {
  requiredTranslationArtifacts,
  doorArtifacts,
};

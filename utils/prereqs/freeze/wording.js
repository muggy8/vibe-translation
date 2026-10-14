/**
 * utils/prereqs/freeze/wording.js — the sentence a refusal is made of.
 *
 * "Frozen" is a refusal nobody can act on, so each reason a skip would be cancelled gets the words
 * for the ACT behind it (`--force` was given / the source book changed / this volume's grade would not
 * hold), and the four manual doors — which have no skip decision to cancel — get the act they were
 * typed for. Keeping the wording here means every refusal the gate prints has the same shape, and
 * `gate.js` never composes a sentence of its own.
 *
 * @module utils/prereqs/freeze/wording
 */

/** @typedef {import("./doors").FreezeDoorRow} FreezeDoorRow */

/**
 * One frozen volume, phrased as something a person can act on.
 *
 * @typedef {Object} FreezeGap
 * @property {string} installment
 * @property {string} folder
 * @property {string[]} artifacts - The translation files that make this volume frozen.
 * @property {string} cancelledBy - Why the skip would have been cancelled (`force`, `cascade`,
 *   `source-changed`, `failed-grade`, `no-acceptance-state`, `audit-stale`, `plan-stale`).
 * @property {string} line - The rendered bullet.
 */

/**
 * The words a refusal uses for each reason a skip would be cancelled.
 *
 * They are the same reasons `utils/series-run/skip.js` computes, spelled out here so the refusal
 * names the act rather than the word: "frozen" is a refusal nobody can act on.
 *
 * @type {Record<string, string>}
 */
const CANCEL_WORDS = Object.freeze({
  force: "`--force` was given",
  cascade: (/** @type {string} */ from) => `volume ${from} is being rebuilt in this same run, and this volume's copy is built on it`,
  "source-changed": "the source book changed since this volume was accepted (fingerprint mismatch)",
  "failed-grade": "this volume's acceptance window never met the criterion, so its grade would not hold",
  "no-acceptance-state": "this volume has no readable acceptance window, so nothing says it was signed off",
  "audit-stale": "the four audited artifacts no longer match the fingerprints the report carries",
  "plan-stale": "`--force` re-runs the intake and re-decides the plan of record",
  // The four manual doors are not gulp tasks and have no skip check to cancel. Their cancellation is
  // the act itself: the command was typed, and it is about to write. Naming it keeps every refusal
  // the same shape — "X would be rewritten because <the act>" — instead of printing a bare word.
  act: "this command was asked to re-read and re-file this volume's reference record",
  apply: "`--apply` publishes into the volume folder and seals the record beside it",
  // The glossary settlement is the glossary step's own end-of-run act: it has no skip decision to
  // cancel, so its cancellation is the act the step just performed.
  settle: "the glossary step finished reading every volume and is about to settle the terminology the whole series produced",
});

/**
 * The sentence for one frozen volume.
 *
 * @param {Object} opts
 * @param {FreezeDoorRow} opts.row
 * @param {{installment: string, folder: string, artifacts: Array<{name: string, bytes: number}>}} opts.volume
 * @param {string} opts.cancelledBy
 * @param {string} [opts.detail]
 * @returns {FreezeGap}
 */
function freezeGap({ row, volume, cancelledBy, detail }) {
  const cancel = CANCEL_WORDS[cancelledBy] || cancelledBy;
  const why = typeof cancel === "function" ? cancel(detail || "") : cancel;
  const built = volume.artifacts.map((a) => `\`${a.name}\` (${a.bytes} bytes)`).join(" and ");
  return {
    installment: volume.installment,
    folder: volume.folder,
    artifacts: volume.artifacts.map((a) => a.name),
    cancelledBy,
    line:
      `volume ${volume.installment} (${volume.folder}): ${row.writes} would be rewritten because ${why}, ` +
      `and this volume's translation was built on it — ${built} is in that folder.`,
  };
}

module.exports = {
  CANCEL_WORDS,
  freezeGap,
};

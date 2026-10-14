/**
 * utils/reference-store/rebuild/earlier-volumes.js — the guard that refuses to rebuild a volume whose
 * record has forgotten the volumes before it.
 *
 * A rebuild files **this volume's** claims; carrying the previous volume's record forward is
 * `openVolumeRecord`'s job. `planHasEarlierVolumes` is split out because the answer is needed before a
 * store is opened — opening creates the file, and a refusal that left an empty record behind would
 * block the very copy-forward the refusal tells the operator to run.
 *
 * @module utils/reference-store/rebuild/earlier-volumes
 */

const { readPlanOfRecord, installmentKey } = require("../paths");
require("../../../types"); // JSDoc type definitions

/**
 * Whether this volume's record is missing the volumes that came before it.
 *
 * A rebuild files **this volume's** claims. It does not carry the previous volume's record forward —
 * that is `openVolumeRecord`'s job, and it belongs to the pipeline's ordering, not to a command a
 * person runs once. For volume 1 there is nothing to carry. For volume 5, rebuilding into a record
 * that holds only volume 5's rows would produce a reference that has silently forgotten volumes 1–4,
 * and the coverage query would answer a question about five volumes as if it were a question about
 * one. So the rebuild refuses, and names the step to run first.
 *
 * @param {ReferenceStore} store
 * @param {number} vol
 * @param {string} seriesDir
 * @returns {boolean} True when an earlier volume exists in the plan of record and nothing from it is in this record.
 */
function rebuildRecordIsMissingItsEarlierVolumes(store, vol, seriesDir) {
  if (!planHasEarlierVolumes(seriesDir, vol)) return false;
  const carriedFacts = store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE owner_volume < ?").get(vol).n;
  const provenance = store.db.prepare("SELECT COUNT(*) AS n FROM copy_provenance WHERE volume < ?").get(vol).n;
  return carriedFacts === 0 && provenance === 0;
}

/**
 * Whether the plan of record has a volume before this one.
 *
 * Split out because the answer is needed **before a store is opened**: opening creates the file, and a
 * refusal that leaves an empty record behind would then block the very copy-forward the refusal is
 * telling the operator to run.
 *
 * @param {string} seriesDir
 * @param {number} vol
 * @returns {boolean}
 */
function planHasEarlierVolumes(seriesDir, vol) {
  const plan = readPlanOfRecord(seriesDir) || [];
  const mine = Number(installmentKey(vol));
  return plan.some((entry) => {
    const key = Number(installmentKey(entry && entry.installmentNumber));
    return Number.isFinite(key) && key < mine;
  });
}

module.exports = {
  rebuildRecordIsMissingItsEarlierVolumes,
  planHasEarlierVolumes,
};

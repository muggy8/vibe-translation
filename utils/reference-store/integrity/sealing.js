/**
 * utils/reference-store/integrity/sealing.js — which volumes this store represents that have
 * never been sealed.
 *
 * The rule that makes copy-forward refuse: a store may not be copied forward unless every
 * volume up to N that it represents is sealed. "Represented" is answered from the data, not
 * from a caller's promise.
 *
 * @module utils/reference-store/integrity/sealing
 */

// `isVolumeSealed` lives with the sealing verb itself, so the "is this volume published?"
// question has exactly one answer in this layer. facts.js does not require this file, so the
// edge does not close a cycle (gotcha 85).
const { isVolumeSealed } = require("../facts");

require("../../../types"); // JSDoc type definitions

/**
 * Volumes this store represents that have not been sealed (review 05 §3.2).
 *
 * The rule: **a store may not be copied forward unless every volume up to N that it represents
 * is sealed.** Sealing is what makes a volume's record published-and-frozen; copying an
 * unsealed volume forward means the next volume starts from a draft that its own volume can
 * still be edited into, and the copy's provenance would claim a stability that does not exist.
 *
 * "Represented" is answered from the data rather than from a caller's promise: a volume counts
 * if it is registered in `volumes` or if any fact in this file is owned by it.
 *
 * @param {{db: Object}} ctx
 * @param {number} upTo - The store's own volume: volumes above it are not this file's business.
 * @returns {number[]} Unsealed volume numbers, ascending.
 */
function unsealedVolumes(ctx, upTo) {
  const limit = Number(upTo);
  const rows = ctx.db
    .prepare(
      "SELECT volume AS volume FROM volumes WHERE volume <= ? " +
        "UNION SELECT owner_volume AS volume FROM facts WHERE owner_volume <= ? " +
        "ORDER BY volume"
    )
    .all(limit, limit);
  return rows.map((row) => row.volume).filter((volume) => !isVolumeSealed(ctx, volume));
}

module.exports = {
  unsealedVolumes,
};

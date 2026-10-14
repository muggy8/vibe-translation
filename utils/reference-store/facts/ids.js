/**
 * utils/reference-store/facts/ids.js — a row's id and its render slot.
 *
 * Both are allocated by the store rather than supplied by the caller, so two runs over the same
 * data produce the same ids in the same order — which is what makes "rendering the same data
 * twice is byte-identical" testable rather than a hope.
 *
 * @module utils/reference-store/facts/ids
 */

const { getFact } = require("./read");
require("../../../types"); // JSDoc type definitions

/**
 * A fact id: `v01-ch3-017` (doc 03 §2).
 *
 * Generated here rather than supplied by the caller so two runs over the same data produce
 * the same ids — which is what makes "rendering the same data twice is byte-identical"
 * (slice 4) testable rather than a hope.
 *
 * @param {{db: Object}} ctx
 * @param {{volume: number, chapter: string|null, aspect: string}} parts
 * @returns {string}
 */
function makeFactId(ctx, { volume, chapter, aspect }) {
  const vol = String(volume).padStart(2, "0");
  const ch = String(chapter || "x").replace(/[^A-Za-z0-9.]/g, "") || "x";
  const stem = `v${vol}-${ch}`;
  const exists = ctx.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE id LIKE ?").get(`${stem}-%`).n;
  for (let n = exists + 1; n < exists + 10000; n += 1) {
    const candidate = `${stem}-${String(n).padStart(3, "0")}`;
    if (!getFact(ctx, candidate)) return candidate;
  }
  throw new Error(`[reference-store] could not allocate a fact id under "${stem}" for aspect ${aspect}`);
}

/**
 * The next render slot. `ord` is stored so rendering does not depend on SQLite's internal
 * row order.
 *
 * @param {{db: Object}} ctx
 * @returns {number}
 */
function nextOrd(ctx) {
  const row = ctx.db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM facts").get();
  return (row && row.m) + 1;
}

module.exports = {
  makeFactId,
  nextOrd,
};

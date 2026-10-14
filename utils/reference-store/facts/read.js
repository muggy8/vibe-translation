/**
 * utils/reference-store/facts/read.js — reading a facts row back.
 *
 * The two reads every other file in this folder is built on: one row by id, and every row in
 * render order. getFact is also what the write guards re-read after a statement refused to
 * match, so the refusal can name the row's real owner rather than guess at it.
 *
 * @module utils/reference-store/facts/read
 */

require("../../../types"); // JSDoc type definitions

/**
 * One fact by id.
 *
 * @param {{db: Object}} ctx
 * @param {string} id
 * @returns {Object|null}
 */
function getFact(ctx, id) {
  return ctx.db.prepare("SELECT * FROM facts WHERE id = ?").get(String(id)) || null;
}

/**
 * Every fact in the store, in render order.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<Object>}
 */
function allFacts(ctx) {
  return ctx.db.prepare("SELECT * FROM facts ORDER BY ord, id").all();
}

module.exports = {
  getFact,
  allFacts,
};

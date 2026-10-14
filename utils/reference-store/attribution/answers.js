/**
 * utils/reference-store/attribution/answers.js — reading the answers this record already holds.
 *
 * `attribution_answers` exists so a later run can tell "nobody asked" from "somebody asked and agreed",
 * which is what makes a second pass over the same volume cost nothing. Both readers here parse the two
 * JSON columns once, into the same shape, so a caller that reads one answer and a caller that reads all of
 * them do not each have to know how the row is stored. Filing an answer is a different job and lives in
 * `record-answer.js`.
 *
 * @module utils/reference-store/attribution/answers
 */

require("../../../types"); // JSDoc type definitions

/**
 * The answer this record holds for one doubted entry, if anybody asked.
 *
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @param {string} key
 * @returns {Object|null}
 */
function attributionAnswer(ctx, volume, key) {
  const row = ctx.db.prepare("SELECT * FROM attribution_answers WHERE volume = ? AND key = ?").get(Number(volume), key);
  if (!row) return null;
  let claimIds = [];
  let evidence = [];
  try {
    claimIds = JSON.parse(row.claim_ids || "[]");
  } catch {
    claimIds = [];
  }
  try {
    evidence = JSON.parse(row.evidence || "[]");
  } catch {
    evidence = [];
  }
  return { ...row, claimIds, evidence };
}

/**
 * Every answer in this record, oldest volume first.
 *
 * @param {{db: Object}} ctx
 * @param {number} [upTo] - Ask about this volume and every volume at or below it.
 * @returns {Array<Object>}
 */
function attributionAnswers(ctx, upTo) {
  const limit = Number(upTo === undefined ? ctx.volume : upTo);
  return ctx.db
    .prepare("SELECT * FROM attribution_answers WHERE volume <= ? ORDER BY volume, key")
    .all(limit)
    .map((row) => {
      let claimIds = [];
      let evidence = [];
      try {
        claimIds = JSON.parse(row.claim_ids || "[]");
      } catch {
        claimIds = [];
      }
      try {
        evidence = JSON.parse(row.evidence || "[]");
      } catch {
        evidence = [];
      }
      // The same shape `attributionAnswer` returns: a caller that reads one answer and a caller that
      // reads all of them must not have to parse the JSON columns twice, in two places.
      return { ...row, claimIds, evidence };
    });
}

module.exports = {
  attributionAnswer,
  attributionAnswers,
};

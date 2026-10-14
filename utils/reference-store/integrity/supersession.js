/**
 * utils/reference-store/integrity/supersession.js — the supersede chain, and the retraction
 * that replaced nothing.
 *
 * One question over `facts.supersedes`: does the chain ever come back around to itself, and
 * is there a fact marked retracted with no live successor — "silent deletion dressed as a
 * correction" (doc 03 §5). The answer is rows; `audit.js` gives them a severity.
 *
 * @module utils/reference-store/integrity/supersession
 */

require("../../../types"); // JSDoc type definitions

/**
 * `supersedes` chains that are circular, and retractions with nothing replacing them.
 *
 * The second one is "silent deletion dressed as a correction" (doc 03 §5): a fact marked
 * retracted with no live successor is a fact that has been removed while the record claims
 * it was corrected.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<{id: string, problem: string}>}
 */
function brokenSupersession(ctx) {
  const out = [];
  const byId = new Map();
  for (const row of ctx.db.prepare("SELECT id, status, supersedes FROM facts").all()) {
    byId.set(row.id, row);
  }

  for (const row of byId.values()) {
    if (!row.supersedes) continue;
    const seen = new Set([row.id]);
    let cursor = byId.get(row.supersedes);
    while (cursor) {
      if (seen.has(cursor.id)) {
        out.push({ id: row.id, problem: `the supersedes chain from "${row.id}" is circular` });
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.supersedes ? byId.get(cursor.supersedes) : null;
    }
  }

  for (const row of byId.values()) {
    if (row.status !== "retracted") continue;
    // A retracted CHALLENGER is not a deleted claim: it is a challenge that was judged and
    // lost (resolve_challenge uphold). The failure this query looks for is a fact taken out of
    // the guidance with nothing replacing it, which is a claim the book said and nobody kept.
    const withdrawn = ctx.db.prepare("SELECT 1 AS one FROM challenges WHERE challenger_id = ?").get(row.id);
    if (withdrawn) continue;
    const replacement = ctx.db
      .prepare("SELECT id FROM facts WHERE supersedes = ? AND status <> 'retracted'")
      .get(row.id);
    if (!replacement) {
      out.push({
        id: row.id,
        problem:
          `fact "${row.id}" is retracted and nothing supersedes it — a deletion recorded as a ` +
          "correction. The verb that is available is challenge_fact, which keeps the trajectory.",
      });
    }
  }
  return out;
}

module.exports = {
  brokenSupersession,
};

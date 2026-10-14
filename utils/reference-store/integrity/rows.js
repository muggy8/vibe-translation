/**
 * utils/reference-store/integrity/rows.js — the rows that cannot be true, and the rows
 * that landed in the catch-all.
 *
 * Three questions asked straight of the `facts` table, each one a query and nothing else:
 * a fact whose evidence column is empty or not a list, a fact whose own citations come
 * from a volume later than the volume that produced it, and how many facts per volume
 * landed in the `unclassified` aspect. None of them decides a severity — `audit.js` turns
 * the answers into findings.
 *
 * @module utils/reference-store/integrity/rows
 */

require("../../../types"); // JSDoc type definitions

/**
 * Every fact whose evidence column is empty or not a JSON array of at least one item.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<{id: string, problem: string}>}
 */
function factsWithoutEvidence(ctx) {
  const out = [];
  for (const row of ctx.db.prepare("SELECT id, evidence FROM facts ORDER BY ord").all()) {
    let items;
    try {
      items = JSON.parse(row.evidence);
    } catch {
      out.push({ id: row.id, problem: "the evidence column is not valid JSON" });
      continue;
    }
    if (!Array.isArray(items) || items.length === 0) {
      out.push({ id: row.id, problem: "the fact has no evidence item" });
    }
  }
  return out;
}

/**
 * Facts whose own evidence cites a volume later than the volume that produced them.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<{id: string, establishedVolume: number, ceilingVolume: number}>}
 */
function impossibleProvenance(ctx) {
  return ctx.db
    .prepare(
      "SELECT f.id AS id, f.established_volume AS establishedVolume, c.ceiling_volume AS ceilingVolume " +
        "FROM facts f JOIN fact_evidence_ceiling c ON c.fact_id = f.id " +
        "WHERE c.ceiling_volume > f.established_volume ORDER BY f.ord"
    )
    .all();
}

/**
 * How many facts landed in the catch-all aspect, per volume (review 05 §2.3).
 *
 * Doc 03 risk 5 is a catch-all quietly becoming where everything lands. The counter is the
 * guard: the number is reported on every audit, so a store that has drifted into `unclassified`
 * shows up as a number in the post-mortem instead of being comfortable.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<{volume: number, n: number}>}
 */
function unclassifiedFacts(ctx) {
  return ctx.db
    .prepare(
      "SELECT owner_volume AS volume, COUNT(*) AS n FROM facts WHERE aspect = 'unclassified' " +
        "GROUP BY owner_volume ORDER BY owner_volume"
    )
    .all();
}

module.exports = {
  factsWithoutEvidence,
  impossibleProvenance,
  unclassifiedFacts,
};

/**
 * utils/reference-store/queries.js — the read side of the repository.
 *
 * These are the queries doc 03 §3.1 will hand to agents in slice 7, written here as plain
 * repository functions so the store can be tested before any agent is given a tool
 * (slice 2's "no agent tools"). The row caps are already here for the same reason they are
 * in the tool contract: the failure this design exists to fix was an agent making 24 reads
 * of a document it could not read, and a query tool without a cap recreates that thrash in
 * a tidier shape (doc 03 §9.2). `limit` is a ceiling, and every result says how many rows
 * it did NOT return.
 *
 * The spoiler rule (doc 03 §2.1) is applied here rather than left to the caller: a read
 * that takes a volume gets only facts whose evidence ceiling is at or below it.
 *
 * @module utils/reference-store/queries
 */

require("../../types"); // JSDoc type definitions

/** Default row caps, same numbers doc 03 §3.1's tool table proposes. */
const QUERY_LIMITS = {
  facts_for: 40,
  facts_for_chapter: 60,
  search_facts: 30,
  showable_facts: 500,
};

/**
 * Parse a requested limit against the default, and never above the default unless the
 * caller raises it explicitly. (The escalation path that raises it is slice 7's, and it is
 * a recorded grant, not a parameter an agent picks.)
 *
 * @param {number|undefined} requested
 * @param {number} fallback
 * @returns {number}
 */
function resolveLimit(requested, fallback) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), Math.max(fallback, QUERY_LIMITS.showable_facts));
}

/**
 * Facts about one character, showable at a volume.
 *
 * @param {{db: Object}} ctx
 * @param {{key: string, volume?: number, aspect?: string, limit?: number}} query
 * @returns {{rows: Array<Object>, limit: number, truncated: boolean}}
 */
function factsFor(ctx, { key, volume, aspect, limit } = {}) {
  const cap = resolveLimit(limit, QUERY_LIMITS.facts_for);
  const clauses = ["f.key = ?"];
  const params = [String(key)];
  if (aspect) {
    clauses.push("f.aspect = ?");
    params.push(String(aspect));
  }
  if (volume !== undefined && volume !== null) {
    clauses.push("f.ceiling_volume <= ?");
    clauses.push("f.applies_from_volume <= ?");
    clauses.push("(f.applies_to_volume IS NULL OR f.applies_to_volume >= ?)");
    params.push(Number(volume), Number(volume), Number(volume));
  }
  const sql =
    `SELECT * FROM showable_facts f WHERE ${clauses.join(" AND ")} ` +
    "ORDER BY f.established_volume, f.established_chapter, f.ord LIMIT ?";
  const rows = ctx.db.prepare(sql).all(...params, cap + 1);
  const truncated = rows.length > cap;
  return { rows: rows.slice(0, cap), limit: cap, truncated };
}

/**
 * Facts whose evidence cites this chapter — the query that replaces
 * `pickRelevantSections`'s heading matching (doc 03 §0).
 *
 * @param {{db: Object}} ctx
 * @param {{volume: number, chapterId: string, limit?: number}} query
 * @returns {{rows: Array<Object>, limit: number, truncated: boolean}}
 */
function factsForChapter(ctx, { volume, chapterId, limit } = {}) {
  const cap = resolveLimit(limit, QUERY_LIMITS.facts_for_chapter);
  const rows = ctx.db
    .prepare(
      "SELECT * FROM showable_facts f " +
        "WHERE f.ceiling_volume <= ? AND EXISTS (SELECT 1 FROM json_each(f.evidence) e " +
        "  WHERE CAST(json_extract(e.value,'$.volume') AS INTEGER) = ? " +
        "    AND json_extract(e.value,'$.chapter') = ?) " +
        "ORDER BY f.ord LIMIT ?"
    )
    .all(Number(volume), Number(volume), String(chapterId), cap + 1);
  const truncated = rows.length > cap;
  return { rows: rows.slice(0, cap), limit: cap, truncated };
}

/**
 * Every version of a claim about one character, in the order it changed.
 *
 * The trajectory is information, not litter (doc 03 §3.3), so this includes superseded and
 * disputed rows — which is the whole point of asking for a history.
 *
 * @param {{db: Object}} ctx
 * @param {{key: string, aspect?: string}} query
 * @returns {{rows: Array<Object>, limit: number, truncated: boolean}}
 */
function factHistory(ctx, { key, aspect } = {}) {
  const clauses = ["key = ?"];
  const params = [String(key)];
  if (aspect) {
    clauses.push("aspect = ?");
    params.push(String(aspect));
  }
  const rows = ctx.db
    .prepare(
      `SELECT * FROM facts WHERE ${clauses.join(" AND ")} ` +
        "ORDER BY established_volume, established_chapter, ord"
    )
    .all(...params);
  return { rows, limit: rows.length, truncated: false };
}

/**
 * Text search over bodies and examples, volume-scoped by the same rule as every other read.
 *
 * @param {{db: Object}} ctx
 * @param {{pattern: string, volume?: number, limit?: number}} query
 * @returns {{rows: Array<Object>, limit: number, truncated: boolean}}
 */
function searchFacts(ctx, { pattern, volume, limit } = {}) {
  const cap = resolveLimit(limit, QUERY_LIMITS.search_facts);
  const needle = String(pattern === undefined ? "" : pattern);
  const clauses = ["(f.body LIKE ? OR f.examples LIKE ?)"];
  const params = [`%${needle}%`, `%${needle}%`];
  if (volume !== undefined && volume !== null) {
    clauses.push("f.ceiling_volume <= ?");
    params.push(Number(volume));
  }
  const rows = ctx.db
    .prepare(
      `SELECT * FROM showable_facts f ` +
        `WHERE ${clauses.join(" AND ")} ORDER BY f.ord LIMIT ?`
    )
    .all(...params, cap + 1);
  const truncated = rows.length > cap;
  return { rows: rows.slice(0, cap), limit: cap, truncated };
}

/**
 * Every fact showable at a volume — the spoiler rule applied in full.
 *
 * A fact established while reading volume 10 cannot appear at volume 3, because its
 * evidence ceiling is 10. A fact established at volume 10 whose evidence is a line in
 * volume 2 CAN appear at volume 3: it is a late discovery of something volume 3's reader
 * could have found itself (doc 03 §2.1).
 *
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @param {{limit?: number}} [opts]
 * @returns {{rows: Array<Object>, limit: number, truncated: boolean}}
 */
function showableFacts(ctx, volume, { limit } = {}) {
  const cap = resolveLimit(limit, QUERY_LIMITS.showable_facts);
  const rows = ctx.db
    .prepare(
      "SELECT * FROM showable_facts f " +
        "WHERE f.ceiling_volume <= ? AND f.applies_from_volume <= ? " +
        "AND (f.applies_to_volume IS NULL OR f.applies_to_volume >= ?) ORDER BY f.ord LIMIT ?"
    )
    .all(Number(volume), Number(volume), Number(volume), cap + 1);
  const truncated = rows.length > cap;
  return { rows: rows.slice(0, cap), limit: cap, truncated };
}

/**
 * Row counts over the tables copy-forward compares (slice 3).
 *
 * @param {{db: Object}} ctx
 * @param {string[]} tables
 * @returns {Object<string, number>}
 */
function tableCounts(ctx, tables) {
  const out = {};
  for (const table of tables) {
    out[table] = ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }
  return out;
}

module.exports = {
  QUERY_LIMITS,
  resolveLimit,
  factsFor,
  factsForChapter,
  factHistory,
  searchFacts,
  showableFacts,
  tableCounts,
};

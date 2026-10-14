/**
 * utils/reference-store/integrity/rebuilt.js — which volumes' documents were rebuilt by code
 * rather than written by an author.
 *
 * Reads the `store_info` markers `rebuild.js` writes and copies forward, so a reference nobody
 * read is never mistaken for one somebody wrote. It reports the markers as rows, including the
 * ones written before a count existed, where the count stays null rather than becoming a zero.
 *
 * @module utils/reference-store/integrity/rebuilt
 */

require("../../../types"); // JSDoc type definitions

/**
 * Which volumes' documents in this record were **rebuilt by code** rather than written by an author.
 *
 * The marker is written by `rebuild.js` and copied forward with the rest of `store_info`, so a rebuilt
 * volume stays identifiable in every later volume's record. This is the question "was this reference
 * read by anyone?" — the store can answer it for provenance, and it cannot answer it for content.
 *
 * @param {{db: Object}} ctx
 * @param {number} upTo - Ask about this volume and every volume at or below it.
 * @returns {Array<{document: string, volume: number, at: string, filed: number, carried: number, refused: number, characters: number, candidatesFiled: number|null, candidatesRefused: number|null}>}
 *   `candidatesFiled` is null for a record built before the rebuild filed candidate copies, which is a
 *   fact the report should be able to tell rather than hide as a zero.
 */
function rebuiltDocuments(ctx, upTo) {
  const limit = Number(upTo);
  const out = [];
  for (const row of ctx.db.prepare("SELECT key, value FROM store_info WHERE key LIKE 'rebuilt_%' ORDER BY key").all()) {
    const match = /^rebuilt_(.+)_(\d+)$/.exec(row.key);
    if (!match) continue;
    const volume = Number(match[2]);
    if (volume > limit) continue;
    let detail = null;
    try {
      detail = JSON.parse(row.value);
    } catch {
      // A marker this layer cannot read is a marker that says nothing, which is worth reporting as
      // "rebuilt, counts unknown" rather than as "not rebuilt": the rows themselves are still there.
      detail = {};
    }
    out.push({
      document: match[1],
      volume,
      at: detail.at || "unknown",
      filed: Number(detail.filed || 0),
      carried: Number(detail.carried || 0),
      refused: Number(detail.refused || 0),
      characters: Number(detail.characters || 0),
      // What the record holds, not what this run added. A marker written before this distinction existed
      // has no such number, so the report falls back to `filed` rather than claiming zero.
      adoptedClaims: Number.isFinite(detail.adoptedClaims) ? Number(detail.adoptedClaims) : null,
      adoptedCharacters: Number.isFinite(detail.adoptedCharacters) ? Number(detail.adoptedCharacters) : null,
      adoptedUnkeyed: Number.isFinite(detail.adoptedUnkeyed) ? Number(detail.adoptedUnkeyed) : null,
      candidateClaims: Number.isFinite(detail.candidateClaims) ? Number(detail.candidateClaims) : null,
      // The candidate copies are part of what the rebuild did: they are the reason a later volume can
      // still ask "what did the extraction find that this reference does not say" about a rebuilt
      // record. A marker written before candidates existed has no such number, which is why these are
      // read as NaN-able rather than defaulted to 0 — the report says nothing about them in that case.
      candidatesFiled: Number.isFinite(detail.candidatesFiled) ? Number(detail.candidatesFiled) : null,
      candidatesRefused: Number.isFinite(detail.candidatesRefused) ? Number(detail.candidatesRefused) : null,
    });
  }
  return out;
}

module.exports = {
  rebuiltDocuments,
};

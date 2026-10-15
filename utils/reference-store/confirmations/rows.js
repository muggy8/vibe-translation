/**
 * utils/reference-store/confirmations/rows.js — asking the record which of its own claims a volume said
 * it saw again.
 *
 * Plan 06 slice 7. `claim_confirmations` is one row per (claim, volume that saw it), and it carries **no
 * body**: the claim it re-confirms is the body. So every read here is a join back onto `facts`, and the
 * two questions the table exists to answer are both here:
 *
 *   - **which claims this volume re-confirmed** — the stage's log line, and the render's per-character
 *     line;
 *   - **which volumes have re-confirmed this claim** — the render's "seen again in volumes 2, 3" half, and
 *     the audit's count.
 *
 * ## What these reads deliberately do NOT do
 *
 * They never filter on `axis`. The plan's §5 sketch keyed a confirmation on the register question it
 * re-confirms; measured against this corpus that key points at nothing (**0 of the 22,469 `facts` rows in
 * the 17 published records carries an `axis`**, plan 06 §2.11), and a read that filtered on it would
 * answer "no confirmations" for every record this series has. The claim row is the key, so a confirmation
 * works for a series that declares ten questions and for one that declares none.
 *
 * They are read-only, and they are the only reads the render and the audit ask, so there is one answer to
 * "has this volume seen this claim".
 *
 * @module utils/reference-store/confirmations/rows
 */

const { currentClaimSql } = require("../facts");
const { EXTRACTION_SOURCE_STAGE } = require("../schema");
require("../../../types"); // JSDoc type definitions

/**
 * The joined columns both reads select: the observation, and the claim it is about.
 */
const CONFIRMATION_COLUMNS =
  "c.fact_id AS factId, c.seen_volume AS seenVolume, c.seen_chapter AS seenChapter, c.quote, " +
  "c.seen_by_stage AS seenByStage, c.seen_at AS seenAt, c.note, " +
  "f.key, f.aspect, f.label, f.body, f.axis, f.axis_value AS axisValue, " +
  "f.established_volume AS establishedVolume, f.established_chapter AS establishedChapter, " +
  "f.owner_volume AS ownerVolume, f.applies_from_volume AS appliesFromVolume, f.status";

/**
 * Every confirmation this volume filed, each one carrying the claim it re-confirmed.
 *
 * Ordered by the claim's own position in the record, so a caller that prints them prints them in the order
 * the book introduced the characters.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{volume?: number}} [opts] - Defaults to the record's own volume.
 * @returns {Array<{factId: string, seenVolume: number, seenChapter: string|null, quote: string|null, seenByStage: string, seenAt: string, note: string|null, key: string|null, aspect: string, label: string|null, body: string, axis: string|null, axisValue: string|null, establishedVolume: number, establishedChapter: string|null, ownerVolume: number, appliesFromVolume: number, status: string}>}
 */
function claimConfirmationsForVolume(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  return store.db
    .prepare(
      `SELECT ${CONFIRMATION_COLUMNS} FROM claim_confirmations c JOIN facts f ON f.id = c.fact_id ` +
        "WHERE c.seen_volume = ? ORDER BY f.established_volume, f.ord, f.id, c.seen_chapter"
    )
    .all(vol);
}

/**
 * Every volume that has re-confirmed one claim, oldest first.
 *
 * This is the read that turns "still holds" from an assumption into a list: the volumes that said so, and
 * the chapters they said it in.
 *
 * @param {{db: Object}} store
 * @param {string} factId
 * @returns {Array<{seenVolume: number, seenChapter: string|null, quote: string|null, seenByStage: string, seenAt: string}>}
 */
function confirmationsForClaim(store, factId) {
  const id = String(factId === undefined || factId === null ? "" : factId).trim();
  if (!id) return [];
  return store.db
    .prepare(
      "SELECT seen_volume AS seenVolume, seen_chapter AS seenChapter, quote, seen_by_stage AS seenByStage, seen_at AS seenAt " +
        "FROM claim_confirmations WHERE fact_id = ? ORDER BY seen_volume, seen_chapter"
    )
    .all(id);
}

/**
 * The confirmations one character's section may print, grouped by the claim they re-confirmed.
 *
 * Only claims the record **currently stands behind at the volume being rendered** are included — the same
 * `currentClaimSql` the bullets use, the same span bound, and the same exclusion of the extraction's own
 * candidate copies. A confirmation of a claim this record has since replaced is a true fact about the
 * past and not part of this volume's answer, so it is not printed.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{key: string, volume?: number}} query
 * @returns {Array<{factId: string, label: string|null, aspect: string, body: string, establishedVolume: number, volumes: Array<number>, chapters: Array<string|null>}>}
 */
function confirmationsForCharacter(store, { key, volume } = {}) {
  const asked = String(key === undefined || key === null ? "" : key).trim();
  if (!asked) return [];
  const vol = Number(volume === undefined ? store.volume : volume);
  const current = currentClaimSql("f");
  const rows = store.db
    .prepare(
      `SELECT ${CONFIRMATION_COLUMNS} FROM claim_confirmations c JOIN facts f ON f.id = c.fact_id ` +
        `WHERE f.key = ? AND c.seen_volume <= ? AND f.source_stage != ? AND f.aspect != 'term_usage' AND ${current} ` +
        "AND f.applies_from_volume <= ? AND (f.applies_to_volume IS NULL OR f.applies_to_volume >= ?) " +
        "ORDER BY f.established_volume, f.ord, f.id, c.seen_volume"
    )
    .all(asked, vol, EXTRACTION_SOURCE_STAGE, vol, vol);

  /** @type {Map<string, {factId: string, label: string|null, aspect: string, body: string, establishedVolume: number, volumes: Array<number>, chapters: Array<string|null>}>} */
  const byClaim = new Map();
  for (const row of rows) {
    if (!byClaim.has(row.factId)) {
      byClaim.set(row.factId, {
        factId: row.factId,
        label: row.label === null || row.label === undefined ? null : String(row.label),
        aspect: row.aspect,
        body: row.body,
        establishedVolume: Number(row.establishedVolume),
        volumes: [],
        chapters: [],
      });
    }
    const entry = byClaim.get(row.factId);
    entry.volumes.push(Number(row.seenVolume));
    entry.chapters.push(row.seenChapter === null || row.seenChapter === undefined ? null : String(row.seenChapter));
  }
  return [...byClaim.values()];
}

/**
 * How many confirmations this record holds, and how many this volume filed.
 *
 * Reported as data, not as a finding: a volume that confirmed nothing is a volume whose characters did
 * not reappear, which is a fact about the book rather than a defect in the record.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{volume?: number}} [opts]
 * @returns {{total: number, thisVolume: number, claimsConfirmed: number, volumes: Object<string, number>}}
 */
function confirmationCounts(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const total = store.db.prepare("SELECT COUNT(*) AS n FROM claim_confirmations").get().n;
  const thisVolume = store.db
    .prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT fact_id) AS claims FROM claim_confirmations WHERE seen_volume = ?")
    .get(vol);
  /** @type {Object<string, number>} */
  const volumes = {};
  for (const row of store.db.prepare("SELECT seen_volume, COUNT(*) AS n FROM claim_confirmations GROUP BY seen_volume ORDER BY seen_volume").all()) {
    volumes[String(row.seen_volume)] = row.n;
  }
  return { total, thisVolume: thisVolume.n, claimsConfirmed: thisVolume.claims, volumes };
}

/**
 * Whether this volume has already filed a confirmation of this exact claim.
 *
 * The idempotence question. `UNIQUE (fact_id, seen_volume)` is the rule; this is the read that lets the
 * door report "already filed" instead of failing on the constraint.
 *
 * @param {{db: Object}} store
 * @param {string} factId
 * @param {number} volume
 * @returns {Object|null} The row, or null.
 */
function confirmationAlreadyFiled(store, factId, volume) {
  const id = String(factId === undefined || factId === null ? "" : factId).trim();
  if (!id) return null;
  return (
    store.db
      .prepare("SELECT fact_id, seen_volume, seen_chapter, quote, seen_by_stage, seen_at FROM claim_confirmations WHERE fact_id = ? AND seen_volume = ?")
      .get(id, Number(volume)) || null
  );
}

module.exports = {
  CONFIRMATION_COLUMNS,
  claimConfirmationsForVolume,
  confirmationsForClaim,
  confirmationsForCharacter,
  confirmationCounts,
  confirmationAlreadyFiled,
};

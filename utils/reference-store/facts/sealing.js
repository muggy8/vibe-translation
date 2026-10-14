/**
 * utils/reference-store/facts/sealing.js — publishing a volume's record.
 *
 * Seal one volume's rows, ask whether a volume is sealed, and read the frozen snapshot of which
 * facts were showable at that moment. Sealing is what makes "delete is a draft-phase verb" a
 * fact rather than a policy, and what makes a volume's file the answer to "what guidance did
 * this volume actually get?" (doc 03 §2.2, §3.3).
 *
 * @module utils/reference-store/facts/sealing
 */

require("../../../types"); // JSDoc type definitions

/**
 * Seal one volume's record: its rows stop being editable, and the facts that were showable
 * at that moment are frozen into `facts_at_volume` (doc 03 §2.2, §3.3).
 *
 * Sealing is what makes "delete is a draft-phase verb" a fact rather than a policy, and it
 * is what makes a volume's file the answer to "what guidance did this volume actually get?"
 *
 * @param {{db: Object}} ctx
 * @param {number} volume - The volume whose rows are being published.
 * @param {{showable?: Array<Object>}} [opts]
 * @returns {{ok: boolean, volume: number, sealedRows: number, snapshot: number, alreadySealed: boolean}}
 */
function sealVolume(ctx, volume, { showable } = {}) {
  const vol = Number(volume);
  const marker = ctx.db.prepare("SELECT value FROM store_info WHERE key = ?").get(`sealed_volume_${vol}`);
  const alreadySealed = Boolean(marker);

  const rows = ctx.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE owner_volume = ? AND sealed = 0").get(vol).n;
  ctx.db.prepare("UPDATE facts SET sealed = 1 WHERE owner_volume = ?").run(vol);

  const rowsToShowable = showable || ctx.db.prepare("SELECT * FROM showable_facts").all();
  const insert = ctx.db.prepare(
    "INSERT INTO facts_at_volume (volume, fact_id) VALUES (?,?) ON CONFLICT(volume, fact_id) DO NOTHING"
  );
  let snapshot = 0;
  for (const fact of rowsToShowable) {
    insert.run(vol, fact.id);
    snapshot += 1;
  }

  ctx.db
    .prepare("INSERT INTO store_info (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`sealed_volume_${vol}`, new Date().toISOString());

  return { ok: true, volume: vol, sealedRows: rows, snapshot, alreadySealed };
}

/**
 * Whether a volume's rows are sealed in this file.
 *
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @returns {boolean}
 */
function isVolumeSealed(ctx, volume) {
  const row = ctx.db.prepare("SELECT value FROM store_info WHERE key = ?").get(`sealed_volume_${Number(volume)}`);
  return Boolean(row);
}

/**
 * The frozen snapshot: which facts were showable when a volume was sealed.
 *
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @returns {Array<string>}
 */
function factsAtVolume(ctx, volume) {
  return ctx.db
    .prepare("SELECT fact_id FROM facts_at_volume WHERE volume = ? ORDER BY fact_id")
    .all(Number(volume))
    .map((r) => r.fact_id);
}

module.exports = {
  sealVolume,
  isVolumeSealed,
  factsAtVolume,
};

/**
 * utils/reference-store/voice-revision/rows.js — asking the record which voice claim it stands behind
 * for one character and one declared question, and what that claim replaced.
 *
 * Plan 06 slice 6. The glossary adapter has `glossaryRowInForceForTerm` for the same job: a term can
 * have several published rows once a later volume files a replacement rather than editing one, so
 * "the row for this term" is a **chain collapsed to the row in force at the volume being asked about**,
 * not "the newest row". This is that rule on the voice side, keyed on the pair the plan's §6 renders
 * per character — **(roster entry, declared register axis)** — because a character's answer to a
 * question is what changes when the character changes, and the axis is the only identity a voice claim
 * has that survives being reworded. (`(key, aspect, body)` is the *dedupe* identity, and it cannot be
 * the identity of a replacement: rewording the body is the whole content of a revision.)
 *
 * Two rules this file keeps from the glossary's version, and one it adds:
 *
 *   - **"in force at volume V" is bounded by V, not "the newest row".** The in-force row is the newest
 *     row in the chain whose `applies_from_volume` is still ≤ V. Taking the newest row would let a
 *     record that has reached volume 5 answer volume 3's question with a decision volume 3 never made —
 *     the silent rewrite of the past `glossary-adapter/rows.js` exists to prevent, and the voice record
 *     has the same hazard because a per-volume record is exactly a snapshot ending at its own volume.
 *   - **a chain is only collapsed when its rows are actually linked by `supersedes`.** Two rows that
 *     happen to answer the same question and are linked to nothing are two rows.
 *   - **and here, two unlinked live answers to one question are a refusal, not a pick.** `resolveExtractionName`
 *     refuses to settle a name by table order (gotcha 117) for the same reason: which of two current
 *     claims a volume should replace is not something a query decides by `ord`.
 *
 * The arc read is the other half of the same question — "what did this record used to stand behind, and
 * from which volume?" — and it is answered through `supersededBy`, the read `facts/supersede.js` exists
 * to provide. Nothing here walks `supersedes` links itself.
 *
 * Read-only: this file issues no write statement, and it is the read the revision door and the render
 * both ask, so there is one answer to "which claim is current" and one answer to "what came before it".
 *
 * @module utils/reference-store/voice-revision/rows
 */

const { normalizeQuote } = require("../evidence");
const { EXTRACTION_SOURCE_STAGE } = require("../schema");
const { supersededBy } = require("../facts");
require("../../../types"); // JSDoc type definitions

/**
 * The columns both reads select, with the camel-case aliases the callers read.
 */
const CHAIN_COLUMNS =
  "f.id, f.key, f.aspect, f.label, f.section, f.body, f.examples, f.axis, f.axis_value AS axisValue, " +
  "f.status, f.supersedes, f.established_volume AS establishedVolume, f.owner_volume AS ownerVolume, " +
  "f.owner_stage AS ownerStage, f.applies_from_volume AS appliesFromVolume, f.applies_to_volume AS appliesToVolume, " +
  "f.source_stage AS sourceStage, f.sealed, f.ord";

/**
 * The `WHERE` half every read here shares: character-voice **record content** (the extraction's own
 * candidate copies excluded, exactly as the three renderers and the coverage rule exclude them), never a
 * glossary row (`term_usage` is a term's translation, not a character's speech), and never a retracted
 * row. The span bound is added by each caller, because "in force at V" and "anywhere in the record" are
 * different questions.
 *
 * @param {string} alias
 * @returns {{clause: string, params: Array<string>}}
 */
function voiceContentScope(alias) {
  return {
    clause: `${alias}.source_stage != ? AND ${alias}.aspect != 'term_usage' AND ${alias}.status <> 'retracted'`,
    params: [EXTRACTION_SOURCE_STAGE],
  };
}

/**
 * The rows one character's answer to one declared question has gone through, oldest first.
 *
 * Every row of the chain that is **in range at the volume being asked about**, so a caller can see both
 * the answer that holds now and the ones that held before it, and can check whether a given answer is
 * one this volume already filed.
 *
 * @param {{db: Object, volume: number}} store - The volume's open record.
 * @param {{key: string, axis: string, volume?: number}} query - The roster entry, the declared question,
 *   and the volume the answer is about. Defaults to the record's own volume.
 * @returns {Array<Object>} Rows with `appliesFromVolume` / `appliesToVolume` / `ownerVolume` aliased.
 */
function voiceClaimChainForAxis(store, { key, axis, volume } = {}) {
  const asked = String(key === undefined || key === null ? "" : key).trim();
  const axisId = String(axis === undefined || axis === null ? "" : axis).trim();
  if (!asked || !axisId) return [];
  const vol = Number(volume === undefined ? store.volume : volume);
  const scope = voiceContentScope("f");
  return store.db
    .prepare(
      `SELECT ${CHAIN_COLUMNS} FROM facts f ` +
        `WHERE ${scope.clause} AND f.key = ? AND f.axis = ? ` +
        "AND f.applies_from_volume <= ? AND (f.applies_to_volume IS NULL OR f.applies_to_volume >= ?) " +
        "ORDER BY f.applies_from_volume, f.ord, f.id"
    )
    .all(...scope.params, asked, axisId, vol, vol);
}

/**
 * The row in force for one (character, axis) pair at one volume, and whether the record can answer at all.
 *
 * `inForce` is the row no other in-range row supersedes. `ambiguous` is the honest answer when the
 * record holds **two live answers to one question that are linked to nothing**: the door that replaces
 * an answer has to know which answer it replaces, and `ord` is not a reason.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{key: string, axis: string, volume?: number}} query
 * @returns {{rows: Array<Object>, inForce: Object|null, ambiguous: boolean, candidates: Array<Object>}}
 */
function voiceClaimInForceForAxis(store, { key, axis, volume } = {}) {
  const rows = voiceClaimChainForAxis(store, { key, axis, volume });
  const replaced = new Set(rows.map((row) => row.supersedes).filter((id) => id !== null && id !== undefined));
  const inForceRows = rows.filter((row) => !replaced.has(row.id));
  return {
    rows,
    inForce: inForceRows.length === 1 ? inForceRows[0] : null,
    ambiguous: inForceRows.length > 1,
    candidates: inForceRows,
  };
}

/**
 * Whether this volume already filed this answer for this character and this question.
 *
 * Asked over the **whole chain**, not only the row in force — the same rule `glossary-adapter/revision.js`
 * learned the hard way (its step 4): a rendering this volume filed and a later chapter of the same volume
 * replaced is still a decision this volume made, and re-filing it would flip the character back to the
 * superseded answer and grow the record by one row on every re-run.
 *
 * Matched on the claim's own words, normalized the way every other dedupe in this layer matches them.
 *
 * @param {Array<Object>} chain - The rows {@link voiceClaimChainForAxis} returned.
 * @param {number} volume - The volume doing the filing.
 * @param {string} body - The answer being proposed.
 * @returns {Object|null} The row this volume already filed, or null.
 */
function voiceRevisionAlreadyFiled(chain, volume, body) {
  const vol = Number(volume);
  const needle = normalizeQuote(body);
  if (!needle) return null;
  for (const row of chain) {
    if (Number(row.ownerVolume) !== vol) continue;
    if (normalizeQuote(row.body) === needle) return row;
  }
  return null;
}

/**
 * The arc: the voice claims this record replaced, each one carrying the row that replaced it.
 *
 * This is the half a superseded row exists for. `currentClaimSql` already keeps a replaced claim out of
 * every *current* answer — the render's bullets, the chapter's known-facts block, the axis queries — and
 * a record that only ever answered "now" would make a character's development read as a contradiction
 * rather than as a change. So the arc is asked separately, and it is bounded by the same volume the
 * current answer is bounded by: a replacement that has not happened yet at V is not part of V's arc.
 *
 * `replacedBy` comes from `supersededBy`, the read `facts/supersede.js` provides for exactly this
 * question. Nothing here walks `supersedes` links itself.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{key?: string|null, volume?: number}} [opts] - `key` narrows the arc to one roster entry;
 *   omit it for the whole record.
 * @returns {Array<{id: string, key: string|null, aspect: string, label: string|null, body: string,
 *   axis: string|null, axisValue: string|null, appliesFromVolume: number, establishedVolume: number,
 *   ownerVolume: number, replacedBy: Array<{id: string, body: string, label: string|null,
 *   appliesFromVolume: number, establishedVolume: number, ownerVolume: number}>}>}
 *   Oldest replaced claim first, per character.
 */
function supersededVoiceClaims(store, { key = null, volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const scope = voiceContentScope("f");
  const keyClause = key === null || key === undefined ? "" : " AND f.key = ?";
  const keyParams = key === null || key === undefined ? [] : [String(key)];

  const rows = store.db
    .prepare(
      `SELECT ${CHAIN_COLUMNS} FROM facts f ` +
        `WHERE ${scope.clause} AND f.status = 'superseded' AND f.applies_from_volume <= ?${keyClause} ` +
        "AND EXISTS (SELECT 1 FROM facts g WHERE g.supersedes = f.id AND g.status <> 'retracted' " +
        "AND g.applies_from_volume <= ?) " +
        "ORDER BY f.key, f.applies_from_volume, f.ord, f.id"
    )
    .all(...scope.params, vol, ...keyParams, vol);

  const out = [];
  for (const row of rows) {
    const successors = supersededBy(store, row.id)
      .filter((successor) => Number(successor.applies_from_volume) <= vol)
      .map((successor) => ({
        id: successor.id,
        body: successor.body,
        label: successor.label === null || successor.label === undefined ? null : String(successor.label),
        appliesFromVolume: Number(successor.applies_from_volume),
        establishedVolume: Number(successor.established_volume),
        ownerVolume: Number(successor.owner_volume),
      }));
    if (!successors.length) continue; // the replacement postdates this volume: not part of this volume's arc
    out.push({
      id: row.id,
      key: row.key,
      aspect: row.aspect,
      label: row.label === null || row.label === undefined ? null : String(row.label),
      body: row.body,
      axis: row.axis === null || row.axis === undefined ? null : String(row.axis),
      axisValue: row.axisValue === null || row.axisValue === undefined ? null : String(row.axisValue),
      appliesFromVolume: Number(row.appliesFromVolume),
      establishedVolume: Number(row.establishedVolume),
      ownerVolume: Number(row.ownerVolume),
      replacedBy: successors,
    });
  }
  return out;
}

module.exports = {
  CHAIN_COLUMNS,
  voiceContentScope,
  voiceClaimChainForAxis,
  voiceClaimInForceForAxis,
  voiceRevisionAlreadyFiled,
  supersededVoiceClaims,
};

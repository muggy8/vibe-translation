/**
 * utils/reference-store/relations/rows.js — the row, its reads, the one insert, and the one update.
 *
 * Plan 07 slice 3. Two rules decide the whole shape of this file.
 *
 * **1. There is exactly one `UPDATE` statement here, and it is built from `RELATION_CLOSE_COLUMNS`.**
 * Plan 07 §4.3's first non-negotiable rule is "a row is never edited after the volume that filed it
 * published". A rule like that is only checkable if somebody can name the columns it allows, so the
 * statement is generated from the pinned list rather than hand-written beside it: widening the statement
 * without widening the list is a failing test, and widening the list without the statement changes nothing
 * in the store. Everything else on the row is insert-only. `relations` is deliberately **not** in
 * `facts/contract.js`'s `UPDATABLE_FIELDS` — that contract belongs to `facts` and is the only update
 * contract in this store, and a second table borrowing it would be a second door into the same rows.
 *
 * **2. Every read is bounded by a volume, and the bound is the no-forward rule.** Plan 07 §0 decision 7:
 * a volume's translation reads *that volume's* record, and nothing written in volume 9 may reach volume
 * 1's reference. `relationsInRecord` answers "what did this record know as of volume N" with the same two
 * clauses `facts` uses for a validity span — `established_volume <= N` and
 * `valid_to_volume IS NULL OR valid_to_volume >= N` — so a row a later volume filed is invisible to an
 * earlier volume's question, and a span a later volume closed is still standing at every volume before the
 * one that closed it. The bound defaults to the record's own volume, which is the furthest any volume is
 * allowed to look.
 *
 * ## Why the span bound is `>= N` and not `> N`
 *
 * A span closed *by* volume 5's evidence stopped holding **at** volume 5, and volume 5's own translator is
 * the reader who most needs to know that. `facts` already draws the line the same way
 * (`applies_to_volume >= ?`), and a rule that made the two tables disagree about which volume a span ends
 * on would be two answers to one question.
 *
 * @module utils/reference-store/relations/rows
 */

const { refusal } = require("../refusals");
const { RELATION_CLOSE_COLUMNS, RELATION_KEY_COLUMNS, relationKeyOf } = require("./shapes");
require("../../../types"); // JSDoc type definitions

/**
 * The columns every read selects, with the camelCase aliases the layer hands back.
 *
 * Written once here so no read in this file — and no caller — has its own idea of what a relation row
 * contains.
 *
 * @type {string}
 */
const RELATION_COLUMNS =
  "relation_id AS relationId, addresser, addressee, addresser_kind AS addresserKind, " +
  "addressee_kind AS addresseeKind, channel, certainty, form_used AS formUsed, " +
  "form_reading AS formReading, statement, evidence, established_volume AS establishedVolume, " +
  "valid_from_volume AS validFromVolume, valid_from_chapter AS validFromChapter, " +
  "valid_to_volume AS validToVolume, valid_to_chapter AS validToChapter, " +
  "closed_by_volume AS closedByVolume, closed_by_chapter AS closedByChapter, " +
  "closed_by_quote AS closedByQuote, closed_by_line AS closedByLine, closed_at AS closedAt, " +
  "filed_by_volume AS filedByVolume, filed_by_stage AS filedByStage, filed_at AS filedAt, note";

/**
 * One relation row, in the shape this layer hands back.
 *
 * `evidence` is stored as JSON and returned parsed, the same way `facts.evidence` is: a caller that has to
 * `JSON.parse` a citation cell in three places is a caller that will eventually stop parsing it.
 *
 * @param {Object} row - A raw row.
 * @returns {Object} The same row with camelCase keys and `evidence` parsed.
 */
function mapRelationRow(row) {
  if (!row) return null;
  /** @type {Array<Object>} */
  let evidence = [];
  try {
    const parsed = JSON.parse(String(row.evidence ?? "[]"));
    if (Array.isArray(parsed)) evidence = parsed;
  } catch {
    // A cell that does not parse is reported as unreadable rather than repaired into `[]`: an empty
    // citation list and a damaged one are different facts, and `[]` is also the honest answer for a
    // relation nobody offered a line for.
    evidence = [];
  }
  const numberOrNull = (value) => (value === null || value === undefined ? null : Number(value));
  return {
    relationId: Number(row.relationId ?? row.relation_id),
    addresser: numberOrNull(row.addresser),
    addressee: numberOrNull(row.addressee),
    addresserKind: row.addresserKind,
    addresseeKind: row.addresseeKind,
    channel: row.channel,
    certainty: row.certainty,
    formUsed: row.formUsed,
    formReading: row.formReading ?? null,
    statement: row.statement,
    evidence,
    evidenceUnreadable: !Array.isArray(evidence) || String(row.evidence ?? "").trim() !== JSON.stringify(evidence),
    establishedVolume: Number(row.establishedVolume),
    validFromVolume: Number(row.validFromVolume),
    validFromChapter: row.validFromChapter ?? null,
    validToVolume: numberOrNull(row.validToVolume),
    validToChapter: row.validToChapter ?? null,
    closedByVolume: numberOrNull(row.closedByVolume),
    closedByChapter: row.closedByChapter ?? null,
    closedByQuote: row.closedByQuote ?? null,
    closedByLine: numberOrNull(row.closedByLine),
    closedAt: row.closedAt ?? null,
    filedByVolume: Number(row.filedByVolume),
    filedByStage: row.filedByStage,
    filedAt: row.filedAt,
    note: row.note ?? null,
  };
}

/**
 * The one `INSERT` this table allows.
 *
 * Insert-only, no `ON CONFLICT`, no update, no delete — the same rule the written-form rows and the
 * confirmation rows follow. A collision throws rather than overwriting the citation list, the
 * statement or the certainty a previous volume filed, and `file.js` checks idempotence *before* it gets
 * here so a re-run reports "already filed" instead of throwing.
 *
 * @param {{db: Object}} store
 * @param {Object} row - The fully resolved row, every field already validated by `file.js`.
 * @returns {number} The new `relation_id`.
 */
function insertRelationRow(store, row) {
  const required = (name, value) => {
    if (value === null || value === undefined || value === "") {
      // A row door is below the filing door, and a half row reaching it is a caller that skipped
      // `file.js` — the same case `written-forms/rows.js` throws for, and it throws the same way:
      // `refusal()` is a value a caller reads, and a row door has no caller to hand it to.
      throw new Error(`[reference-store] insertRelationRow: relation-row-incomplete — a relation row is missing its ${name}, so it would be filed half.`);
    }
  };
  required("addresser_kind", row.addresserKind);
  required("addressee_kind", row.addresseeKind);
  required("channel", row.channel);
  required("certainty", row.certainty);
  required("form_used", row.formUsed);
  required("statement", row.statement);
  required("established_volume", row.establishedVolume);
  required("filed_by_volume", row.filedByVolume);
  required("filed_by_stage", row.filedByStage);
  required("filed_at", row.filedAt);

  const info = store.db
    .prepare(
      "INSERT INTO relations (addresser, addressee, addresser_kind, addressee_kind, channel, certainty, " +
        "form_used, form_reading, statement, evidence, established_volume, valid_from_volume, valid_from_chapter, " +
        "filed_by_volume, filed_by_stage, filed_at, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .run(
      row.addresser === null || row.addresser === undefined ? null : Number(row.addresser),
      row.addressee === null || row.addressee === undefined ? null : Number(row.addressee),
      String(row.addresserKind),
      String(row.addresseeKind),
      String(row.channel),
      String(row.certainty),
      String(row.formUsed),
      row.formReading === null || row.formReading === undefined || row.formReading === "" ? null : String(row.formReading),
      String(row.statement),
      JSON.stringify(Array.isArray(row.evidence) ? row.evidence : []),
      Number(row.establishedVolume),
      Number(row.validFromVolume === undefined ? row.establishedVolume : row.validFromVolume),
      row.validFromChapter === null || row.validFromChapter === undefined || row.validFromChapter === "" ? null : String(row.validFromChapter),
      Number(row.filedByVolume),
      String(row.filedByStage),
      String(row.filedAt),
      row.note === null || row.note === undefined || row.note === "" ? null : String(row.note)
    );
  return Number(info.lastInsertRowid);
}

/**
 * The `WHERE` clause that names one relation row by its key.
 *
 * `IS` rather than `=` for the two identity columns, because SQLite treats `NULL = NULL` as unknown while
 * `NULL IS NULL` is true — and a narrator or withheld relation has a null addresser, so a matcher built on
 * `=` would never find the very rows the no-invented-person rule produces and would file a second copy of
 * each one.
 *
 * @returns {string}
 */
function relationKeyWhere() {
  return "established_volume = ? AND channel = ? AND form_used = ? AND addresser IS ? AND addressee IS ?";
}

/**
 * Whether this record already holds this relation.
 *
 * The idempotence question. The unique index `idx_relations_key` is the rule; this is the read that lets
 * the door report "already filed" instead of failing on the constraint.
 *
 * @param {{db: Object}} store
 * @param {Object} key - `{establishedVolume, channel, formUsed, addresser, addressee}`.
 * @returns {Object|null} The row, or null.
 */
function relationAlreadyFiled(store, key) {
  const k = relationKeyOf(key);
  if (!Number.isInteger(k.establishedVolume) || !k.channel || !k.formUsed) return null;
  const row = store.db
    .prepare(`SELECT ${RELATION_COLUMNS} FROM relations WHERE ${relationKeyWhere()}`)
    .get(k.establishedVolume, k.channel, k.formUsed, k.addresser, k.addressee);
  return mapRelationRow(row);
}

/**
 * One relation by id.
 *
 * @param {{db: Object}} store
 * @param {number} relationId
 * @returns {Object|null}
 */
function relationById(store, relationId) {
  const id = Number(relationId);
  if (!Number.isInteger(id)) return null;
  return mapRelationRow(store.db.prepare(`SELECT ${RELATION_COLUMNS} FROM relations WHERE relation_id = ?`).get(id));
}

/**
 * Every relation this record holds, bounded by a volume.
 *
 * The default bound is the record's own volume, which is the furthest any volume may look. Passing a
 * volume **later** than the record's own is refused rather than clamped: a read that quietly answered
 * "as of volume 20" about a volume-9 record would be a read that answered about a book that does not exist
 * yet, and the caller would never be told.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{asOfVolume?: number, establishedVolume?: number, channel?: string, certainty?: string, addresser?: number, addressee?: number, includeClosed?: boolean}} [opts]
 *   `includeClosed` defaults to true, because "what does this record know about who addresses whom" has to
 *   include the spans that have ended — a closed span is a fact about the book, not a hole.
 * @returns {{ok: boolean, rows: Array<Object>, asOfVolume: number, refusal: ReferenceRefusal|null}}
 */
function relationsInRecord(store, { asOfVolume, establishedVolume, channel, certainty, addresser, addressee, includeClosed = true } = {}) {
  const asked = Number(asOfVolume === undefined ? store.volume : asOfVolume);
  if (!Number.isInteger(asked) || asked < 1) {
    return { ok: false, rows: [], asOfVolume: 0, refusal: refusal({ verb: "relations_in_record", rule: "relation-read-volume-undecided", because: `"${asOfVolume}" is not a volume number this record can be asked about`, fix: "name the volume the read is bounded to" }) };
  }
  if (asked > Number(store.volume)) {
    return {
      ok: false,
      rows: [],
      asOfVolume: asked,
      refusal: refusal({
        verb: "relations_in_record",
        rule: "relations-cannot-look-forward",
        because:
          `this record is volume ${store.volume}'s and was asked about volume ${asked}. A volume's record ` +
          "holds what that volume and the volumes before it saw, and a read allowed past its own volume is " +
          "the forward leak plan 07 §0 decision 7 exists to prevent.",
        useInstead: [`ask this record as of volume ${store.volume} or earlier`, "open the later volume's own record"],
        detail: { recordVolume: Number(store.volume), asked },
      }),
    };
  }

  /**
   * The span clause takes the same volume **twice** — once for "had this act already begun" and once for
   * "had the span already ended" — so both placeholders get the number. A missing parameter in SQLite is
   * NULL, and `valid_to_volume >= NULL` is NULL, which is how a closed span would silently vanish from
   * every read while still being counted by `relationCounts` (which passes the number twice). Pinned by
   * `test/test-relations-table.js` scenario 6, which closes a span and then asks for it.
   */
  /** @type {Array<string|number>} */
  const args = [asked, asked];
  const where = ["established_volume <= ?", "(valid_to_volume IS NULL OR valid_to_volume >= ?)"];
  if (establishedVolume !== undefined && establishedVolume !== null) {
    where.push("established_volume = ?");
    args.push(Number(establishedVolume));
  }
  if (channel) {
    where.push("channel = ?");
    args.push(String(channel));
  }
  if (certainty) {
    where.push("certainty = ?");
    args.push(String(certainty));
  }
  if (addresser !== undefined && addresser !== null && addresser !== "") {
    where.push("addresser = ?");
    args.push(Number(addresser));
  }
  if (addressee !== undefined && addressee !== null && addressee !== "") {
    where.push("addressee = ?");
    args.push(Number(addressee));
  }
  if (!includeClosed) where.push("valid_to_volume IS NULL");

  const rows = store.db
    .prepare(`SELECT ${RELATION_COLUMNS} FROM relations WHERE ${where.join(" AND ")} ORDER BY established_volume, relation_id`)
    .all(...args);
  return { ok: true, rows: rows.map(mapRelationRow), asOfVolume: asked, refusal: null };
}

/**
 * The relations one character's identity is on, as of a volume.
 *
 * Either side, because "who addresses this person" and "whom does this person address" are the two
 * questions a voice reference would actually ask, and neither is answered by a one-column filter.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{identity: number, asOfVolume?: number}} query
 * @returns {{ok: boolean, rows: Array<Object>, asOfVolume: number, refusal: ReferenceRefusal|null}}
 */
function relationsForIdentity(store, { identity, asOfVolume } = {}) {
  const id = Number(identity);
  if (!Number.isInteger(id)) {
    return { ok: false, rows: [], asOfVolume: 0, refusal: refusal({ verb: "relations_for_identity", rule: "relation-identity-undecided", because: `"${identity}" is not an identity number`, fix: "name an identity this record holds" }) };
  }
  const base = relationsInRecord(store, { asOfVolume });
  if (!base.ok) return { ok: false, rows: [], asOfVolume: base.asOfVolume, refusal: base.refusal };
  return {
    ok: true,
    rows: base.rows.filter((row) => row.addresser === id || row.addressee === id),
    asOfVolume: base.asOfVolume,
    refusal: null,
  };
}

/**
 * How many relations this record holds, and how they are shaped.
 *
 * Reported as **data, not a finding**: a volume that filed no relation is a volume whose cast did not
 * address anybody in a form the record could place, which is a fact about the book. There is no finding
 * kind for it and this slice adds none.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{asOfVolume?: number}} [opts]
 * @returns {{total: number, open: number, closed: number, thisVolumeFiled: number, byChannel: Object<string, number>, byCertainty: Object<string, number>, byEstablishedVolume: Object<string, number>, partiesWithoutIdentity: number}}
 */
function relationCounts(store, { asOfVolume } = {}) {
  const asked = Number(asOfVolume === undefined ? store.volume : asOfVolume);
  const span = "established_volume <= ? AND (valid_to_volume IS NULL OR valid_to_volume >= ?)";
  const total = store.db.prepare(`SELECT COUNT(*) AS n FROM relations WHERE ${span}`).get(asked, asked).n;
  const closed = store.db
    .prepare(`SELECT COUNT(*) AS n FROM relations WHERE ${span} AND valid_to_volume IS NOT NULL`)
    .get(asked, asked).n;
  const filed = store.db.prepare("SELECT COUNT(*) AS n FROM relations WHERE filed_by_volume = ?").get(asked).n;
  const withoutIdentity = store.db
    .prepare(`SELECT COUNT(*) AS n FROM relations WHERE ${span} AND addresser IS NULL`)
    .get(asked, asked).n;

  /** @type {Object<string, number>} */
  const byChannel = {};
  for (const row of store.db.prepare(`SELECT channel, COUNT(*) AS n FROM relations WHERE ${span} GROUP BY channel ORDER BY channel`).all(asked, asked)) {
    byChannel[row.channel] = row.n;
  }
  /** @type {Object<string, number>} */
  const byCertainty = {};
  for (const row of store.db.prepare(`SELECT certainty, COUNT(*) AS n FROM relations WHERE ${span} GROUP BY certainty ORDER BY certainty`).all(asked, asked)) {
    byCertainty[row.certainty] = row.n;
  }
  /** @type {Object<string, number>} */
  const byEstablishedVolume = {};
  for (const row of store.db.prepare("SELECT established_volume, COUNT(*) AS n FROM relations GROUP BY established_volume ORDER BY established_volume").all()) {
    byEstablishedVolume[String(row.established_volume)] = row.n;
  }
  return {
    total,
    open: total - closed,
    closed,
    thisVolumeFiled: filed,
    byChannel,
    byCertainty,
    byEstablishedVolume,
    partiesWithoutIdentity: withoutIdentity,
  };
}

/**
 * The one `UPDATE` in this layer, generated from `RELATION_CLOSE_COLUMNS`.
 *
 * It writes the span-closing columns and nothing else, and it refuses a row that already has a span
 * closed rather than moving the close earlier or later: a span's end is an observation a volume made, and
 * rewriting which volume made it is the quiet rewrite plan 07 §0 decision 8 names.
 *
 * **It is asked only through `file.js`'s `closeRelationSpan`,** which is where the reason (volume,
 * chapter, and a line that volume's own book prints) is checked. Nothing in this file decides whether a
 * close is justified.
 *
 * @param {{db: Object}} store
 * @param {number} relationId
 * @param {{validToVolume: number, validToChapter: string|null, closedByVolume: number, closedByChapter: string, closedByQuote: string, closedByLine: number|null, closedAt: string}} close
 * @returns {{ok: boolean, changed: number, columns: string[], refusal: ReferenceRefusal|null}}
 */
function closeRelationSpanRow(store, relationId, close) {
  const id = Number(relationId);
  const existing = relationById(store, id);
  if (!existing) {
    return { ok: false, changed: 0, columns: [], refusal: refusal({ verb: "close_relation_span", rule: "relation-row-not-found", because: `there is no relation row ${relationId} in this record`, fix: "file the relation first, or name the row the development closes" }) };
  }
  if (existing.validToVolume !== null) {
    return {
      ok: false,
      changed: 0,
      columns: [],
      refusal: refusal({
        verb: "close_relation_span",
        rule: "relation-span-already-closed",
        because:
          `this span is already closed at volume ${existing.validToVolume} (chapter ${existing.validToChapter ?? "unnamed"}, ` +
          `closed by volume ${existing.closedByVolume}). A span's end is an observation, and a second close ` +
          "would move which volume made it.",
        useInstead: ["leave the close where it is", "if the close is wrong, name it in the record rather than overwriting it"],
        detail: { relationId: id, validToVolume: existing.validToVolume, closedByVolume: existing.closedByVolume },
      }),
    };
  }

  const values = [
    Number(close.validToVolume),
    close.validToChapter === null || close.validToChapter === undefined || close.validToChapter === "" ? null : String(close.validToChapter),
    Number(close.closedByVolume),
    String(close.closedByChapter),
    String(close.closedByQuote),
    close.closedByLine === null || close.closedByLine === undefined ? null : Number(close.closedByLine),
    String(close.closedAt),
  ];
  const sql = `UPDATE relations SET ${RELATION_CLOSE_COLUMNS.map((column) => `${column} = ?`).join(", ")} WHERE relation_id = ? AND valid_to_volume IS NULL`;
  const info = store.db.prepare(sql).run(...values, id);
  return { ok: true, changed: Number(info.changes || 0), columns: [...RELATION_CLOSE_COLUMNS], refusal: null };
}

module.exports = {
  RELATION_COLUMNS,
  RELATION_KEY_WHERE: relationKeyWhere(),
  mapRelationRow,
  insertRelationRow,
  relationAlreadyFiled,
  relationById,
  relationsInRecord,
  relationsForIdentity,
  relationCounts,
  closeRelationSpanRow,
  RELATION_CLOSE_COLUMNS,
  RELATION_KEY_COLUMNS,
};

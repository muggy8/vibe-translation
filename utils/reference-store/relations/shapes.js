/**
 * utils/reference-store/relations/shapes.js — the closed vocabularies of an act of address, and the
 * column lists that decide what may be written to a relation row and when.
 *
 * Plan 07 slice 3. This is a **pure leaf**: it requires nothing but the type definitions, the same shape
 * `confirmations/shapes.js` has and for the same reason (gotcha 85). The door that files a relation
 * (`file.js`) and the door that reads one back (`rows.js`) both need these vocabularies, and the door
 * that closes a span needs the column lists; putting them in either door would make one require the other
 * and hand a half-built module to whichever required first.
 *
 * ## Why the vocabularies are closed here and checked again in the schema
 *
 * Migration 13 puts a `CHECK (… IN (…))` on `channel`, `certainty`, `addresser_kind` and `addressee_kind`,
 * so a row written by hand, by an older build, or by a door this layer has not seen yet still cannot carry
 * a word outside the ladder. The lists here are the same words, and `test/test-relations-table.js`
 * compares the two rather than trusting them to agree — a vocabulary enforced in only one place is a
 * vocabulary that drifts the first time someone adds a value to the other place.
 *
 * ## Why `addresser_kind` exists at all, and is not derived from `channel`
 *
 * Plan 07 §4.3 describes `addresser` as "the identity doing the addressing, or `narrator`, or null when
 * withheld". The obvious reading is that the channel already says it: `narration` means the narrator,
 * `withheld` means nobody. **It does not, and the gap is plan 07 §0 decision 9.** A book can point at a
 * line and *pointedly not say* who spoke it — that is a fact with translator value ("keep this
 * unresolved") — and a book can also point at a line whose speaker this record simply failed to place,
 * which is a gap. Both have no addresser. Both are acts of address. If the only place the difference
 * lived were `channel`, the two would be the same row shape, and the record would report "the author
 * withheld it" and "we do not know" with one word. Decision 9 says they must not look the same, so the
 * kind is stored.
 *
 * It is also the shape this store already uses for a subject it refuses to invent: `facts.key IS NULL`
 * with `facts.extracted_as` naming what the claim was called (migration 6), and
 * `attribution_answers.speaker = null` with `answer = 'narrator'` (migration 7). A null party plus a
 * named kind is the precedent, and this table follows it.
 *
 * ## Why the narrator is not a person, and why no identity is created for it
 *
 * `narrator` is a **kind**, never a value in `addresser`. There is no column that stores the word, because
 * a row whose `addresser` is null and whose `addresser_kind` is `narrator` says everything the word would
 * say, and a roster entry or an identity keyed by the word for the narration is refused elsewhere in this
 * store (gotcha 121: the coverage rule counts rows in `cast`, so a character called `narrator` becomes a
 * character the reference is required to cover and the presence measurement is required to find in the
 * text — two questions with no answer, reported on every volume). `file.js` refuses a *name* that means
 * the narration before it resolves anything, through `narrator.js`, so the door cannot be talked into
 * keying a relation on it.
 *
 * ## Why the column lists are data
 *
 * The two rules plan 07 §4.3 calls non-negotiable are "a row is never edited after the volume that filed
 * it published" and "a volume's translation reads that volume's record". The first one is only real if
 * somebody can name **which columns a close is allowed to write**, and the door's single `UPDATE`
 * statement is built from `RELATION_CLOSE_COLUMNS` rather than hand-written beside it — so the list the
 * test asserts and the statement the store runs are the same list, and adding a column to one without the
 * other is a failing test rather than a quiet widening.
 *
 * @module utils/reference-store/relations/shapes
 */

require("../../../types"); // JSDoc type definitions

// ─── The closed vocabularies ──────────────────────────────────────────────────

/**
 * The five channels plan 07 §4.3 names: the kind of act the record observed.
 *
 * `spoken` — somebody said something to somebody. `self-address` — a character addressed themselves (the
 * same identity on both sides, which is why the door requires it). `inner-monologue` — words written as
 * thought rather than said. `narration` — the line is the narration's. `withheld` — the book pointedly
 * does not say whose line it was.
 *
 * @type {string[]}
 */
const RELATION_CHANNELS = Object.freeze(["spoken", "self-address", "inner-monologue", "narration", "withheld"]);

/**
 * The six certainty levels of plan 07 §4.4, in the order the ladder reads strongest-to-weakest.
 *
 * **Never a number a model reported about itself** (plan 07 §0 decision 10). The door validates
 * membership and each level's own precondition; it does **not** compute the level, and computing it is
 * plan 07 slice 4's job — the extraction contract that decides, from a line, which level the line
 * supports. A door that computed the ladder would be a door that guessed who speaks.
 *
 * @type {string[]}
 */
const RELATION_CERTAINTY_LEVELS = Object.freeze([
  "measured",
  "addressee-risk",
  "reading-resolved",
  "narration",
  "withheld",
  "unknown",
]);

/**
 * What the record can say about **who did the addressing**.
 *
 * `identity` — an identity this record holds, named in `addresser`. `narrator` — the narration's line,
 * which has no identity and no roster entry. `withheld` — the book pointedly did not say. `unknown` —
 * nothing matched, and the book did not withhold. The last two are different facts and the whole point of
 * storing the kind rather than deriving it from `channel` (see this file's header).
 *
 * @type {string[]}
 */
const ADDRESSER_KINDS = Object.freeze(["identity", "narrator", "withheld", "unknown"]);

/**
 * What the record can say about **who was addressed**.
 *
 * Narrower than the addresser's on purpose. There is no "the narration was addressed" and no "withheld
 * addressee": an addressee is either an identity this record holds or nobody, and a third value would be
 * a place to put a guess.
 *
 * @type {string[]}
 */
const ADDRESSEE_KINDS = Object.freeze(["identity", "none"]);

/**
 * The guide source whose statement `reading-resolved` is allowed to lean on.
 *
 * `reading-resolved` means "this identity is known only because the author's guided reading says so", and
 * the only thing in this record that can show that is a live `cast_identity_links` row stated by the
 * book's own pronunciation markup. The name is a constant here rather than a literal in a query so
 * `test/test-relations-table.js` can pin that it is still one of `IDENTITY_LINK_SOURCES` — if the identity
 * layer's source vocabulary ever drops it, this precondition must fail loudly rather than silently stop
 * firing.
 *
 * @type {string}
 */
const GUIDE_LINK_SOURCE = "ruby-guide";

// ─── The pairings ─────────────────────────────────────────────────────────────

/**
 * Which party kinds each channel allows.
 *
 * `narration` is the narration and nothing else; `withheld` is withheld and nothing else; the three
 * person-channels take a named identity or an admitted `unknown`. `self-address` is the strictest of the
 * three: a self-address whose speaker is unknown is not a self-address, because the whole content of the
 * channel is that the speaker and the addressee are the same person.
 *
 * This is a **rule table, not a schema constraint**: adding a channel is a migration, and a channel with
 * no row here is refused by `file.js` rather than defaulted to the loosest kind.
 *
 * @type {Object<string, string[]>}
 */
const RELATION_CHANNEL_PARTY_KINDS = Object.freeze({
  spoken: Object.freeze(["identity", "unknown"]),
  "self-address": Object.freeze(["identity"]),
  "inner-monologue": Object.freeze(["identity", "unknown"]),
  narration: Object.freeze(["narrator"]),
  withheld: Object.freeze(["withheld"]),
});

/**
 * Which party kinds each certainty level allows.
 *
 * `measured`, `addressee-risk` and `reading-resolved` are all claims about **a person**, so they require a
 * named identity. `narration`, `withheld` and `unknown` each name their own kind, and the agreement is
 * one-directional on purpose: a `narration`-certainty row with a roster entry in it is the exact shape
 * plan 07 §4.4 says this level must not have ("the 'speaker' is the narrator, which has no roster entry").
 *
 * @type {Object<string, string[]>}
 */
const RELATION_CERTAINTY_PARTY_KINDS = Object.freeze({
  measured: Object.freeze(["identity"]),
  "addressee-risk": Object.freeze(["identity"]),
  "reading-resolved": Object.freeze(["identity"]),
  narration: Object.freeze(["narrator"]),
  withheld: Object.freeze(["withheld"]),
  unknown: Object.freeze(["unknown"]),
});

/**
 * The extra preconditions the ladder's own definitions put on a level, beyond the party kind.
 *
 * These are the parts of §4.4's conditions **the record can show**, and only those. The door does not
 * decide whether a line names exactly one cast form — that is a reading of a scene, and slice 4's. What
 * it can check is that a level which promises a line has one, that a level about the addressee has an
 * addressee, and that a level resting on the author's markup has a link the author's markup stated.
 *
 * @type {Object<string, {requiresQuote: boolean, requiresAddressee: boolean, requiresGuideStatedIdentity: boolean, because: string}>}
 */
const RELATION_CERTAINTY_PRECONDITIONS = Object.freeze({
  measured: Object.freeze({
    requiresQuote: true,
    requiresAddressee: true,
    requiresGuideStatedIdentity: false,
    because:
      "§4.4's `measured` is \"the line names exactly one cast form, it is not the person being spoken to, " +
      "and the guided reading resolves it to one identity\" — so the row must carry the line it names, and " +
      "an addressee to be distinct from",
  }),
  "addressee-risk": Object.freeze({
    requiresQuote: false,
    requiresAddressee: true,
    requiresGuideStatedIdentity: false,
    because:
      "§4.4's `addressee-risk` is the measured failure mode — the name in the line is the person being " +
      "spoken to (10 of 10 in volume 2, plan 07 §2.9) — and a risk about the addressee with no addressee " +
      "named is a risk about nothing",
  }),
  "reading-resolved": Object.freeze({
    requiresQuote: false,
    requiresAddressee: false,
    requiresGuideStatedIdentity: true,
    because:
      "§4.4's `reading-resolved` is \"the identity is known only because the author's guided reading says " +
      "so\", and the only thing in this record that can show that is a live identity link stated by the " +
      "book's own pronunciation markup",
  }),
  narration: Object.freeze({
    requiresQuote: false,
    requiresAddressee: false,
    requiresGuideStatedIdentity: false,
    because: "§4.4's `narration` is carried entirely by the party kind, which the pairing table already requires",
  }),
  withheld: Object.freeze({
    requiresQuote: false,
    requiresAddressee: false,
    requiresGuideStatedIdentity: false,
    because:
      "§4.4's `withheld` is a fact with instruction attached (plan 07 §0 decision 9): the book pointedly " +
      "did not say. It files normally and is never treated as missing data",
  }),
  unknown: Object.freeze({
    requiresQuote: false,
    requiresAddressee: false,
    requiresGuideStatedIdentity: false,
    because: "§4.4's `unknown` is \"nothing matched, and the book did not withhold\" — the honest gap, and a gap the record is required to name",
  }),
});

// ─── The columns, and who may write them ──────────────────────────────────────

/**
 * Every column of `relations`, in table order, as the layer declares it.
 *
 * `test/test-relations-table.js` compares this list against `PRAGMA table_info(relations)`, so the schema
 * and the layer's own account of the schema cannot drift apart.
 *
 * @type {string[]}
 */
const RELATION_TABLE_COLUMNS = Object.freeze([
  "relation_id",
  "addresser",
  "addressee",
  "addresser_kind",
  "addressee_kind",
  "channel",
  "certainty",
  "form_used",
  "form_reading",
  "statement",
  "evidence",
  "established_volume",
  "valid_from_volume",
  "valid_from_chapter",
  "valid_to_volume",
  "valid_to_chapter",
  "closed_by_volume",
  "closed_by_chapter",
  "closed_by_quote",
  "closed_by_line",
  "closed_at",
  "filed_by_volume",
  "filed_by_stage",
  "filed_at",
  "note",
]);

/**
 * The **only** columns a span-closing act may write.
 *
 * `rows.js` builds its single `UPDATE` statement from this list, so the guard is the list rather than a
 * sentence in a comment. Everything else on the row is insert-only: `relations` is not in
 * `facts/contract.js`'s `UPDATABLE_FIELDS` (that contract belongs to `facts` and is the only update
 * contract in this store), and this table has no `status`, no `row_version` and no content column an
 * update could reach.
 *
 * `closed_at` is the moment the record wrote the close, the same role `cast_identity_links.withdrawn_at`
 * plays: a close is an act with a date, and the row says when.
 *
 * @type {string[]}
 */
const RELATION_CLOSE_COLUMNS = Object.freeze([
  "valid_to_volume",
  "valid_to_chapter",
  "closed_by_volume",
  "closed_by_chapter",
  "closed_by_quote",
  "closed_by_line",
  "closed_at",
]);

/**
 * The columns that are written once, by the volume that filed the row, and never written again.
 *
 * Derived from `RELATION_TABLE_COLUMNS` minus `RELATION_CLOSE_COLUMNS` rather than written out a second
 * time, so the two lists cannot disagree. `test/test-relations-table.js` asserts the split is exact and
 * then asserts, column by column, that a close moved nothing in this list.
 *
 * @type {string[]}
 */
const RELATION_INSERT_ONLY_COLUMNS = Object.freeze(
  RELATION_TABLE_COLUMNS.filter((column) => !RELATION_CLOSE_COLUMNS.includes(column))
);

/**
 * The columns that identify which row a close is about.
 *
 * The same five the unique index is built on, because "which row does this development close?" has to be
 * answerable with the same key that decides whether a relation has already been filed — otherwise the
 * door would be matching rows by one rule and filing them by another.
 *
 * @type {string[]}
 */
const RELATION_KEY_COLUMNS = Object.freeze([
  "established_volume",
  "channel",
  "form_used",
  "addresser",
  "addressee",
]);

// ─── The pure helpers ─────────────────────────────────────────────────────────

/**
 * Whether a value is in one of the closed vocabularies.
 *
 * @param {string[]} list - The vocabulary.
 * @param {unknown} value
 * @returns {boolean}
 */
function isRelationValue(list, value) {
  return typeof value === "string" && list.includes(value.trim());
}

/**
 * Whether a channel allows a party kind.
 *
 * An unknown channel answers `false` rather than defaulting: a channel with no row in
 * `RELATION_CHANNEL_PARTY_KINDS` is a channel nobody has decided anything about.
 *
 * @param {string} channel
 * @param {string} kind
 * @returns {boolean}
 */
function channelAcceptsPartyKind(channel, kind) {
  const allowed = RELATION_CHANNEL_PARTY_KINDS[String(channel || "").trim()];
  return Array.isArray(allowed) && allowed.includes(kind);
}

/**
 * Whether a certainty level allows a party kind.
 *
 * @param {string} certainty
 * @param {string} kind
 * @returns {boolean}
 */
function certaintyAcceptsPartyKind(certainty, kind) {
  const allowed = RELATION_CERTAINTY_PARTY_KINDS[String(certainty || "").trim()];
  return Array.isArray(allowed) && allowed.includes(kind);
}

/**
 * The party kinds a channel allows, for a refusal that has to name them.
 *
 * @param {string} channel
 * @returns {string[]} Empty when the channel is not in the table.
 */
function partyKindsAllowedByChannel(channel) {
  const allowed = RELATION_CHANNEL_PARTY_KINDS[String(channel || "").trim()];
  return Array.isArray(allowed) ? [...allowed] : [];
}

/**
 * The party kinds a certainty level allows, for a refusal that has to name them.
 *
 * @param {string} certainty
 * @returns {string[]} Empty when the level is not in the table.
 */
function partyKindsAllowedByCertainty(certainty) {
  const allowed = RELATION_CERTAINTY_PARTY_KINDS[String(certainty || "").trim()];
  return Array.isArray(allowed) ? [...allowed] : [];
}

/**
 * The five values that identify one relation row, normalised.
 *
 * `addresser` / `addressee` are identity numbers or null. Null is kept as null here and made comparable
 * by `ifnull(addresser, -1)` in the index, so this function stays a plain description of the row rather
 * than a mirror of an SQL expression.
 *
 * @param {Object} input - `{establishedVolume, channel, formUsed, addresser, addressee}`.
 * @returns {{establishedVolume: number, channel: string, formUsed: string, addresser: number|null, addressee: number|null}}
 */
function relationKeyOf({ establishedVolume, channel, formUsed, addresser, addressee } = {}) {
  const identityNumber = (value) => {
    const n = Number(value);
    return value === null || value === undefined || value === "" || !Number.isInteger(n) ? null : n;
  };
  return {
    establishedVolume: Number(establishedVolume),
    channel: String(channel || "").trim(),
    formUsed: String(formUsed || "").trim(),
    addresser: identityNumber(addresser),
    addressee: identityNumber(addressee),
  };
}

module.exports = {
  RELATION_CHANNELS,
  RELATION_CERTAINTY_LEVELS,
  ADDRESSER_KINDS,
  ADDRESSEE_KINDS,
  GUIDE_LINK_SOURCE,
  RELATION_CHANNEL_PARTY_KINDS,
  RELATION_CERTAINTY_PARTY_KINDS,
  RELATION_CERTAINTY_PRECONDITIONS,
  RELATION_TABLE_COLUMNS,
  RELATION_CLOSE_COLUMNS,
  RELATION_INSERT_ONLY_COLUMNS,
  RELATION_KEY_COLUMNS,
  isRelationValue,
  channelAcceptsPartyKind,
  certaintyAcceptsPartyKind,
  partyKindsAllowedByChannel,
  partyKindsAllowedByCertainty,
  relationKeyOf,
};

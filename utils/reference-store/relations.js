/**
 * relations.js — the cover for the `relations/` submodule (plan 07 slice 3).
 *
 * A **relation** is one act of address the record observed: who is speaking, whom
 * they are addressing, through which channel, in which form, how sure the record is,
 * and the span of volumes that answer covers.
 *
 * Two rules hold the whole layer:
 *
 *   1. **A row is never edited after the volume that filed it published.** The content
 *      columns are insert-only; the only writable columns are the ones that close the
 *      span, and a span closes only with a reason — a volume, a chapter and a line of
 *      that volume's own text that `findQuoteEvidence` can find.
 *   2. **A volume's translation reads that volume's record.** Nothing in this layer
 *      looks forward: a query refuses a volume later than the one the handle was opened
 *      for, and a span closes only in the copy of the volume whose text showed it.
 *
 * The door keys its parties on **identities** (`cast_identities`), never on a roster
 * key, and it never creates one: a party the record has no identity for is named as a
 * limit and files nothing. `narrator` and `withheld` are recorded as a null party with
 * a named kind, so neither invents a person and neither reaches the roster.
 *
 * The certainty ladder itself is **not** computed here — that is slice 4. This layer
 * holds the closed vocabulary and each level's record-checkable precondition, and
 * refuses a level whose precondition the record cannot show.
 *
 * Submodules: `relations/shapes.js` (the closed vocabularies and the pairing tables),
 * `relations/rows.js` (the mapping, the insert, the only update, the queries),
 * `relations/file.js` (the door: file a relation, close a span).
 */

const {
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
} = require("./relations/shapes");

const {
  RELATION_COLUMNS,
  mapRelationRow,
  insertRelationRow,
  RELATION_KEY_WHERE,
  relationAlreadyFiled,
  relationById,
  relationsInRecord,
  relationsForIdentity,
  relationCounts,
  closeRelationSpanRow,
} = require("./relations/rows");

const {
  identitiesOfParty,
  identityStatedByGuide,
  registeredChapterIds,
  citationForQuote,
  fileRelation,
  closeRelationSpan,
  fileRelations,
} = require("./relations/file");

module.exports = {
  // shapes
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

  // rows
  RELATION_COLUMNS,
  mapRelationRow,
  insertRelationRow,
  RELATION_KEY_WHERE,
  relationAlreadyFiled,
  relationById,
  relationsInRecord,
  relationsForIdentity,
  relationCounts,
  closeRelationSpanRow,

  // the door
  identitiesOfParty,
  identityStatedByGuide,
  registeredChapterIds,
  citationForQuote,
  fileRelation,
  closeRelationSpan,
  fileRelations,
};

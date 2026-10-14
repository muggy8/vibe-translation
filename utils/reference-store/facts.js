/**
 * utils/reference-store/facts.js — writing a fact, and the guards that decide whether a
 * write is allowed at all.
 *
 * Three rules live in this layer, and all three are enforced in the statement rather than in a
 * prompt (doc 03 §3.2: "Enforcement is in the statement, not the prompt"):
 *
 * 1. **Evidence is mandatory and verified.** A fact with no evidence, or with a quote that
 *    is not at the chapter and line it cites, is refused. See `evidence.js`.
 * 2. **Ownership is stamped by the harness, never by the caller.** The write scope comes
 *    from the context the store was opened with (`ctx.scope`), which is the same shape the
 *    file sandbox uses (`createGatedFsTools`'s one `approve(call)` predicate). A proposal
 *    that carries `owner_volume` is **refused by name** — not ignored, not overwritten —
 *    because a field the model writes that the guard then quietly discards is a field the
 *    model will keep writing, and a refusal is the only thing that stops it.
 * 3. **Drafts are yours; published history is not.** Update and delete are scoped to rows
 *    this store's volume and stage owns that are not sealed. A mismatched id changes
 *    **zero** rows — the guard is in the `WHERE` clause, so there is no path that writes
 *    first and checks afterwards — and the refusal names the row's real owner and the verb
 *    that IS available (`challenge_fact`).
 *
 * The code lives in `utils/reference-store/facts/`, one documented section per file:
 * `contract.js` (the zod contracts and the field lists the harness owns), `read.js` (one row
 * by id, every row in render order), `ids.js` (the row's id and its render slot, allocated by
 * the store), `validate.js` (the checks an insert and an update share), `insert.js` (the one
 * door that creates a row), `amend.js` (update and delete, guarded in the `WHERE` clause),
 * `challenge.js` (a dispute from opening it to closing it, plus `currentClaimSql` — the
 * predicate the three renderers share), `supersede.js` (replacing a published row by status
 * alone), `sealing.js` (publishing a volume's record and its frozen snapshot). This file is
 * the public surface of the fact layer and the only thing another module should require; the
 * tables that decide what a write may name stay inside this folder, which is a banned patch
 * path for the dev team (AGENTS.md §3).
 *
 * @module utils/reference-store/facts
 */

const contract = require("./facts/contract");
const read = require("./facts/read");
const ids = require("./facts/ids");
const validate = require("./facts/validate");
const insert = require("./facts/insert");
const amend = require("./facts/amend");
const challenge = require("./facts/challenge");
const supersede = require("./facts/supersede");
const sealing = require("./facts/sealing");

// The public surface, unchanged from the single file.
module.exports = {
  EVIDENCE_SCHEMA: contract.EVIDENCE_SCHEMA,
  FACT_PROPOSAL_SCHEMA: contract.FACT_PROPOSAL_SCHEMA,
  UPDATE_SCHEMA: contract.UPDATE_SCHEMA,
  HARNESS_OWNED_FIELDS: contract.HARNESS_OWNED_FIELDS,
  UPDATABLE_FIELDS: contract.UPDATABLE_FIELDS,
  KNOWN_STATUSES: contract.KNOWN_STATUSES,
  KNOWN_STAGES: contract.KNOWN_STAGES,
  getFact: read.getFact,
  allFacts: read.allFacts,
  makeFactId: ids.makeFactId,
  harnessOwnedFieldRefusal: validate.harnessOwnedFieldRefusal,
  insertFact: insert.insertFact,
  updateOwnFact: amend.updateOwnFact,
  deleteOwnFact: amend.deleteOwnFact,
  challengeFact: challenge.challengeFact,
  listChallenges: challenge.listChallenges,
  currentClaimSql: challenge.currentClaimSql,
  resolveChallenge: challenge.resolveChallenge,
  markSuperseded: supersede.markSuperseded,
  supersededBy: supersede.supersededBy,
  sealVolume: sealing.sealVolume,
  isVolumeSealed: sealing.isVolumeSealed,
  factsAtVolume: sealing.factsAtVolume,
};

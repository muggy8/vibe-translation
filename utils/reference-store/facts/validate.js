/**
 * utils/reference-store/facts/validate.js — the checks an insert and an update share.
 *
 * Everything about a proposal that is not its evidence: the closed aspect vocabulary, the
 * applies-span and impossible-provenance rules, the fields the harness owns, which roster
 * entry the row's key belongs to, and the register gate — whether an axis a claim names is one
 * this series declared and its value one this series declared for it. Asked the same way from
 * both doors, so a fact cannot pass a shape test at insert that it would fail at update.
 *
 * The register gate lives here rather than in `insert.js` for the same reason the rest of these
 * checks do: it is the check every door that files a fact already passes through, so a door cannot
 * skip it. It reads the declaration off the store handle (`ctx.registerDeclaration`, frozen in
 * `open.js`), never off an argument, and `updateOwnFact` reaches it with a merged row that carries
 * no axis at all — `UPDATE_SCHEMA` is strict, so a patch cannot change which question a published
 * claim answers.
 *
 * @module utils/reference-store/facts/validate
 */

const { refusal } = require("../refusals");
const { getCast, upsertCast } = require("../cast");
const { FACT_ASPECTS, isInVocabulary } = require("../schema");
const { HARNESS_OWNED_FIELDS } = require("./contract");
const { registerFilingRefusal } = require("../register/filing");
require("../../../types"); // JSDoc type definitions

/**
 * Check the parts of a proposal that are not evidence: the closed vocabularies, the provenance
 * rule, the fields the harness owns, and the series' own register declaration.
 *
 * @param {{db: Object, scope: {volume: number, stage: string}, registerDeclaration?: Object}} ctx
 * @param {Object} proposal - Already zod-parsed.
 * @param {{existing: Object|null}} state - The row an update is amending, when it is one.
 * @returns {ReferenceRefusal|null}
 */
function validateFactProposal(ctx, proposal, { existing = null } = {}) {
  const aspect = proposal.aspect === undefined ? existing && existing.aspect : proposal.aspect;
  if (!isInVocabulary(FACT_ASPECTS, aspect)) {
    return refusal({
      verb: existing ? "update_own_fact" : "insert_fact",
      rule: "aspect-not-in-vocabulary",
      because: `aspect must be one of the closed vocabulary; "${aspect}" is not in it.`,
      fix: `use one of: ${FACT_ASPECTS.join(", ")}.`,
      detail: { allowed: FACT_ASPECTS },
    });
  }

  const established = proposal.establishedVolume === undefined ? (existing ? existing.established_volume : ctx.scope.volume) : proposal.establishedVolume;
  const appliesFrom = proposal.appliesFromVolume === undefined ? (existing ? existing.applies_from_volume : established) : proposal.appliesFromVolume;
  const appliesTo =
    proposal.appliesToVolume === undefined ? (existing ? existing.applies_to_volume : null) : proposal.appliesToVolume;
  if (appliesTo !== null && appliesTo < appliesFrom) {
    return refusal({
      verb: existing ? "update_own_fact" : "insert_fact",
      rule: "applies-span-inverted",
      because: `applies_to_volume (${appliesTo}) is before applies_from_volume (${appliesFrom}).`,
      fix: "leave applies_to_volume null while the fact still holds.",
    });
  }

  // doc 03 §5: "facts whose established_volume is less than the volume of their own
  // evidence" is impossible provenance — a volume-3 reading cannot cite volume 9, because
  // its own source reads stop at volume 3 (doc 03 §3.4).
  const ceiling = Math.max(...proposal.evidence.map((e) => e.volume));
  if (established < ceiling) {
    return refusal({
      verb: existing ? "update_own_fact" : "insert_fact",
      rule: "impossible-provenance",
      because:
        `the fact is established at volume ${established} but its evidence cites volume ${ceiling}. ` +
        `A volume's reading can only cite text it has itself read.`,
      fix: `cite only volumes up to ${established}, or establish the fact at volume ${ceiling}.`,
      detail: { establishedVolume: established, evidenceCeiling: ceiling },
    });
  }

  // Plan 06 §4.3 guard 2: a value outside the series' declared set is refused here and named, so a
  // model that invents a speech level this book does not print produces a refusal in the report rather
  // than a row in the record. A proposal that names no axis is not this gate's business — which is the
  // branch every door in this repository takes today, because the extraction prompt does not name axes
  // yet (plan 06 slice 4).
  const registerProblem = registerFilingRefusal(ctx, proposal, existing ? "update_own_fact" : "insert_fact");
  if (registerProblem) return registerProblem;

  return null;
}

/**
 * Refuse a raw proposal that names a field the harness owns.
 *
 * Checked on the RAW object, before the shape check: a schema complaint about an
 * "unrecognized key" reads like a typo, and the point of this refusal is that the caller
 * learns the field is not theirs to write (doc 03 §3.2).
 *
 * @param {{scope: {volume: number, stage: string}}} ctx
 * @param {Object} raw
 * @param {string} verb
 * @returns {ReferenceRefusal|null}
 */
function harnessOwnedFieldRefusal(ctx, raw, verb) {
  const named = HARNESS_OWNED_FIELDS.filter((field) => raw && Object.prototype.hasOwnProperty.call(raw, field));
  if (!named.length) return null;
  return refusal({
    verb,
    rule: "harness-owned-field",
    because:
      `${named.join(", ")} are written by the store, not by the caller. Ownership comes from the ` +
      `context this store was opened with (volume ${ctx.scope.volume}, stage "${ctx.scope.stage}"), so a ` +
      "label a caller writes cannot claim someone else's row.",
    fix: "leave those fields out; the store fills them in.",
  });
}

/**
 * Resolve a fact's `key` against the cast, creating a cast entry only when the proposal
 * genuinely introduces someone (doc 03 §3.2).
 *
 * @param {{db: Object, scope: {volume: number, stage: string}}} ctx
 * @param {Object} proposal
 * @returns {{key: string|null, refusal: ReferenceRefusal|null}}
 */
function resolveFactKey(ctx, proposal) {
  const key = proposal.key === undefined || proposal.key === null ? null : String(proposal.key).trim();
  if (!key) return { key: null, refusal: null };
  if (getCast(ctx, key)) return { key, refusal: null };
  if (!proposal.cast) {
    return {
      key: null,
      refusal: refusal({
        verb: "insert_fact",
        rule: "unknown-cast-key",
        because: `there is no cast entry keyed "${key}", and the proposal does not introduce one.`,
        fix:
          `add cast: {display: "…"} to introduce this character, or use cast_alias(key, alias) if they are ` +
          `already here under another spelling.`,
      }),
    };
  }
  const created = upsertCast(ctx, {
    key,
    display: proposal.cast.display,
    persona: proposal.cast.persona || null,
    aliases: proposal.cast.aliases || [],
    notes: proposal.cast.notes || null,
    firstSeenVolume: proposal.establishedVolume === undefined ? ctx.scope.volume : proposal.establishedVolume,
  });
  if (!created.ok) return { key: null, refusal: created.refusal };
  return { key, refusal: null };
}

module.exports = {
  validateFactProposal,
  harnessOwnedFieldRefusal,
  resolveFactKey,
};

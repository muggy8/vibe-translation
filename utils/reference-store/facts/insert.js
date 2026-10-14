/**
 * utils/reference-store/facts/insert.js — writing a new facts row.
 *
 * The one door that creates a row. Ownership is stamped from the scope the store was opened
 * with and never from what the proposal claims; the evidence is verified against the book
 * before anything is written; and the row is deleted again if its characters cannot be
 * attached. Every refusal names the rule it hit.
 *
 * @module utils/reference-store/facts/insert
 */

const { refusal } = require("../refusals");
const { verifyEvidence } = require("../evidence");
const { linkFactCharacters } = require("../cast");
const { FACT_PROPOSAL_SCHEMA } = require("./contract");
const { getFact } = require("./read");
const { makeFactId, nextOrd } = require("./ids");
const { harnessOwnedFieldRefusal, validateFactProposal, resolveFactKey } = require("./validate");
require("../../../types"); // JSDoc type definitions

/**
 * Propose a fact.
 *
 * @param {{db: Object, scope: {volume: number, stage: string}, resolveVolume: Function}} ctx
 * @param {Object} proposal
 * @returns {{ok: boolean, fact: Object|null, refusal: ReferenceRefusal|null}}
 */
function insertFact(ctx, proposal) {
  const claimed = harnessOwnedFieldRefusal(ctx, proposal, "insert_fact");
  if (claimed) return { ok: false, fact: null, refusal: claimed };

  // Checked before the shape, because "no evidence at all" is the headline refusal of this
  // layer and it should read like one rather than like a schema complaint.
  if (!proposal || !Array.isArray(proposal.evidence) || proposal.evidence.length === 0) {
    return {
      ok: false,
      fact: null,
      refusal: refusal({
        verb: "insert_fact",
        rule: "missing-evidence",
        because:
          "a fact requires at least one evidence item: {volume, chapter, line, quote}, with the quote copied " +
          "verbatim from that chapter's source text. A fact with no evidence is not stored.",
        fix: "cite the line the claim comes from, then insert it.",
      }),
    };
  }

  const parsed = FACT_PROPOSAL_SCHEMA.safeParse(proposal);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return {
      ok: false,
      fact: null,
      refusal: refusal({
        verb: "insert_fact",
        rule: "invalid-proposal",
        because: `the proposal does not match the fact contract: ${issues.join("; ")}`,
        fix:
          "a fact is {aspect, body, evidence:[{volume,chapter,line,quote}], key?, appliesFromVolume?, …} — " +
          "see utils/reference-store/facts.js.",
      }),
    };
  }
  const value = parsed.data;

  const shapeProblem = validateFactProposal(ctx, value, {});
  if (shapeProblem) return { ok: false, fact: null, refusal: shapeProblem };

  const { key, refusal: keyRefusal } = resolveFactKey(ctx, value);
  if (keyRefusal) return { ok: false, fact: null, refusal: keyRefusal };

  const checked = verifyEvidence(value.evidence, ctx.resolveVolume);
  if (!checked.ok) {
    return {
      ok: false,
      fact: null,
      refusal: refusal({
        verb: "insert_fact",
        rule: "evidence-does-not-verify",
        because:
          `every evidence item must be a quote that actually occurs at the volume, chapter and line it cites. ` +
          `${checked.problems.length} of ${value.evidence.length} did not:\n` +
          checked.problems.map((p) => `  - ${p.problem}`).join("\n"),
        fix:
          "cite the chapter and line the quote is really at, or quote the line you really cited. " +
          "A fact you cannot check against the book is not stored.",
        detail: { problems: checked.problems.map((p) => ({ index: p.index, problem: p.problem, found: p.found })) },
      }),
    };
  }

  const established = value.establishedVolume === undefined ? ctx.scope.volume : value.establishedVolume;
  const appliesFrom = value.appliesFromVolume === undefined ? established : value.appliesFromVolume;
  const establishedChapter = value.establishedChapter || (checked.items[0] && checked.items[0].chapter) || null;
  const id = value.id || makeFactId(ctx, { volume: established, chapter: establishedChapter, aspect: value.aspect });
  if (getFact(ctx, id)) {
    return {
      ok: false,
      fact: null,
      refusal: refusal({
        verb: "insert_fact",
        rule: "fact-id-taken",
        because: `a fact with id "${id}" is already in this store.`,
        useInstead: ["update_own_fact", "challenge_fact"],
        fix: "omit `id` and the store will allocate one, or update the row you mean.",
      }),
    };
  }

  const supersedes = value.supersedes || null;
  if (supersedes && !getFact(ctx, supersedes)) {
    return {
      ok: false,
      fact: null,
      refusal: refusal({
        verb: "insert_fact",
        rule: "supersedes-unknown-fact",
        because: `there is no fact "${supersedes}" to supersede.`,
        useInstead: ["challenge_fact"],
      }),
    };
  }

  const now = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO facts (
         id, key, aspect, label, section, body, examples, formality, evidence,
         established_volume, established_chapter, applies_from_volume, applies_to_volume,
         status, supersedes, confidence, source_stage, owner_volume, owner_stage, sealed,
         created_at, updated_at, row_version, ord, extracted_as
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id,
      key,
      value.aspect,
      value.label || null,
      value.section || null,
      value.body,
      JSON.stringify(value.examples || []),
      value.formality || null,
      JSON.stringify(checked.items),
      established,
      establishedChapter,
      appliesFrom,
      value.appliesToVolume === undefined ? null : value.appliesToVolume,
      "active",
      supersedes,
      value.confidence === undefined ? null : value.confidence,
      // The stage is the one the store was opened with, never the one the proposal claims.
      ctx.scope.stage,
      ctx.scope.volume,
      ctx.scope.stage,
      0,
      now,
      null,
      1,
      nextOrd(ctx),
      value.extractedAs || null
    );

  if (Array.isArray(value.characters) && value.characters.length) {
    const linked = linkFactCharacters(ctx, id, value.characters);
    if (!linked.ok) {
      ctx.db.prepare("DELETE FROM facts WHERE id = ?").run(id);
      return {
        ok: false,
        fact: null,
        refusal: refusal({
          verb: "insert_fact",
          rule: "fact-character-unknown",
          because: `the fact's characters could not be attached: ${linked.problems.join("; ")}`,
        }),
      };
    }
  }

  return { ok: true, fact: getFact(ctx, id), refusal: null };
}

module.exports = {
  insertFact,
};

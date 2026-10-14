/**
 * utils/reference-store/facts/amend.js — changing or removing a row this scope owns.
 *
 * Update and delete, guarded IN the statement: the ownership clause lives in the WHERE clause,
 * so a row this store's volume and stage does not own changes ZERO rows and there is no path
 * that writes first and checks afterwards. The refusal is built afterwards from the row's real
 * owner. ownableRefusal is the question both doors ask — is this row yours to change, right
 * now? — and it is the reason a sealed row is contested rather than edited (doc 03 §3.3).
 *
 * @module utils/reference-store/facts/amend
 */

const { refusal, ownershipRefusal } = require("../refusals");
const { verifyEvidence } = require("../evidence");
const { linkFactCharacters } = require("../cast");
const { UPDATE_SCHEMA, UPDATABLE_FIELDS } = require("./contract");
const { getFact } = require("./read");
const { harnessOwnedFieldRefusal, validateFactProposal } = require("./validate");
require("../../../types"); // JSDoc type definitions

/**
 * Amend a fact this store's volume and stage owns, while its volume is unsealed.
 *
 * The guard is the `WHERE` clause (doc 03 §3.2). A row this scope does not own is not
 * updated and then reported — it is never matched, so **zero rows change**, and the refusal
 * is built from the row's real owner afterwards.
 *
 * @param {{db: Object, scope: {volume: number, stage: string}, resolveVolume: Function}} ctx
 * @param {string} id
 * @param {Object} patch
 * @returns {{ok: boolean, changed: number, fact: Object|null, refusal: ReferenceRefusal|null}}
 */
function updateOwnFact(ctx, id, patch) {
  const existing = getFact(ctx, id);
  if (!existing) {
    return {
      ok: false,
      changed: 0,
      fact: null,
      refusal: refusal({
        verb: "update_own_fact",
        rule: "unknown-fact",
        because: `there is no fact "${id}" in this store.`,
        fix: "insert it, or name the id of the row you mean.",
      }),
    };
  }

  const claimed = harnessOwnedFieldRefusal(ctx, patch, "update_own_fact");
  if (claimed) return { ok: false, changed: 0, fact: null, refusal: claimed };

  const parsed = UPDATE_SCHEMA.safeParse(patch);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return {
      ok: false,
      changed: 0,
      fact: null,
      refusal: refusal({
        verb: "update_own_fact",
        rule: "invalid-patch",
        because: `the patch does not match the update contract: ${issues.join("; ")}`,
        fix: `the fields an update may change are: ${UPDATABLE_FIELDS.join(", ")}.`,
      }),
    };
  }
  const value = parsed.data;

  const ownership = ownableRefusal(ctx, existing, "update_own_fact");
  if (ownership) return { ok: false, changed: 0, fact: null, refusal: ownership };

  const merged = {
    aspect: value.aspect === undefined ? existing.aspect : value.aspect,
    key: value.key === undefined ? existing.key : value.key,
    label: value.label === undefined ? existing.label : value.label,
    section: value.section === undefined ? existing.section : value.section,
    body: value.body === undefined ? existing.body : value.body,
    examples: value.examples === undefined ? JSON.parse(existing.examples) : value.examples,
    formality: value.formality === undefined ? existing.formality : value.formality,
    evidence: value.evidence === undefined ? JSON.parse(existing.evidence) : value.evidence,
    establishedVolume: value.establishedVolume === undefined ? existing.established_volume : value.establishedVolume,
    establishedChapter: value.establishedChapter === undefined ? existing.established_chapter : value.establishedChapter,
    appliesFromVolume: value.appliesFromVolume === undefined ? existing.applies_from_volume : value.appliesFromVolume,
    appliesToVolume: value.appliesToVolume === undefined ? existing.applies_to_volume : value.appliesToVolume,
    confidence: value.confidence === undefined ? existing.confidence : value.confidence,
    characters: value.characters,
  };

  const shapeProblem = validateFactProposal(ctx, merged, { existing });
  if (shapeProblem) return { ok: false, changed: 0, fact: null, refusal: shapeProblem };

  const checked = verifyEvidence(merged.evidence, ctx.resolveVolume);
  if (!checked.ok) {
    return {
      ok: false,
      changed: 0,
      fact: null,
      refusal: refusal({
        verb: "update_own_fact",
        rule: "evidence-does-not-verify",
        because:
          `the updated evidence does not verify:\n` +
          checked.problems.map((p) => `  - ${p.problem}`).join("\n"),
        detail: { problems: checked.problems.map((p) => ({ index: p.index, problem: p.problem, found: p.found })) },
      }),
    };
  }

  const result = ctx.db
    .prepare(
      `UPDATE facts SET
         key = ?, aspect = ?, label = ?, section = ?, body = ?, examples = ?, formality = ?, evidence = ?,
         established_volume = ?, established_chapter = ?, applies_from_volume = ?, applies_to_volume = ?,
         confidence = ?, updated_at = ?, row_version = row_version + 1
       WHERE id = ? AND owner_volume = ? AND owner_stage = ? AND sealed = 0`
    )
    .run(
      merged.key,
      merged.aspect,
      merged.label,
      merged.section,
      merged.body,
      JSON.stringify(merged.examples),
      merged.formality,
      JSON.stringify(checked.items),
      merged.establishedVolume,
      merged.establishedChapter,
      merged.appliesFromVolume,
      merged.appliesToVolume,
      merged.confidence,
      new Date().toISOString(),
      id,
      ctx.scope.volume,
      ctx.scope.stage
    );

  if (result.changes === 0) {
    // The statement refused it. Re-read the row and say why, by name.
    const after = getFact(ctx, id);
    return { ok: false, changed: 0, fact: null, refusal: ownableRefusal(ctx, after || existing, "update_own_fact") };
  }

  if (Array.isArray(merged.characters)) {
    ctx.db.prepare("DELETE FROM fact_characters WHERE fact_id = ?").run(id);
    const linked = linkFactCharacters(ctx, id, merged.characters);
    if (!linked.ok) {
      return {
        ok: false,
        changed: result.changes,
        fact: getFact(ctx, id),
        refusal: refusal({
          verb: "update_own_fact",
          rule: "fact-character-unknown",
          because: `the fact's characters could not be attached: ${linked.problems.join("; ")}`,
        }),
      };
    }
  }

  return { ok: true, changed: result.changes, fact: getFact(ctx, id), refusal: null };
}

/**
 * Delete a fact this store's volume and stage owns, while its volume is unsealed.
 *
 * After sealing, deletion is refused outright (doc 03 §3.3): a fact a translation was
 * already built from cannot be removed without making that translation unexplainable, and
 * "a character vanished between volumes" stops being a detectable event if vanishing is a
 * legal operation. Being wrong after sealing is recorded as `disputed` or `superseded`.
 *
 * @param {{db: Object, scope: {volume: number, stage: string}}} ctx
 * @param {string} id
 * @param {string} reason
 * @returns {{ok: boolean, changed: number, refusal: ReferenceRefusal|null}}
 */
function deleteOwnFact(ctx, id, reason) {
  const existing = getFact(ctx, id);
  if (!existing) {
    return {
      ok: false,
      changed: 0,
      refusal: refusal({
        verb: "delete_own_fact",
        rule: "unknown-fact",
        because: `there is no fact "${id}" in this store.`,
      }),
    };
  }
  const ownership = ownableRefusal(ctx, existing, "delete_own_fact");
  if (ownership) return { ok: false, changed: 0, refusal: ownership };

  const result = ctx.db
    .prepare("DELETE FROM facts WHERE id = ? AND owner_volume = ? AND owner_stage = ? AND sealed = 0")
    .run(id, ctx.scope.volume, ctx.scope.stage);

  if (result.changes === 0) {
    return { ok: false, changed: 0, refusal: ownableRefusal(ctx, getFact(ctx, id) || existing, "delete_own_fact") };
  }
  ctx.db.prepare("DELETE FROM fact_characters WHERE fact_id = ?").run(id);
  return { ok: true, changed: result.changes, refusal: null };
}

/**
 * The refusal shared by update and delete: is this row yours to change, right now?
 *
 * @param {{scope: {volume: number, stage: string}}} ctx
 * @param {Object} row
 * @param {string} verb
 * @returns {ReferenceRefusal|null}
 */
function ownableRefusal(ctx, row, verb) {
  if (!row) return null;
  if (row.sealed === 1) {
    return ownershipRefusal({
      verb,
      row,
      scope: ctx.scope,
      rule: "fact-is-sealed",
      because:
        `fact "${row.id}" belongs to volume ${row.owner_volume}'s published record, which is sealed. ` +
        "A sealed fact is contested or superseded, never edited or removed (doc 03 §3.3).",
    });
  }
  if (row.owner_volume !== ctx.scope.volume) {
    return ownershipRefusal({
      verb,
      row,
      scope: ctx.scope,
      rule: "fact-owned-by-another-volume",
      because:
        `fact "${row.id}" was written by volume ${row.owner_volume} (stage "${row.owner_stage}"), and this ` +
        `store is writing as volume ${ctx.scope.volume}. You may read it; you may not change it.`,
    });
  }
  if (row.owner_stage !== ctx.scope.stage) {
    return ownershipRefusal({
      verb,
      row,
      scope: ctx.scope,
      rule: "fact-owned-by-another-stage",
      because:
        `fact "${row.id}" was written by stage "${row.owner_stage}" of volume ${row.owner_volume}, and this ` +
        `store is writing as stage "${ctx.scope.stage}". Each stage edits only what it inserted.`,
    });
  }
  return null;
}

module.exports = {
  updateOwnFact,
  deleteOwnFact,
};

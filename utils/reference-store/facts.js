/**
 * utils/reference-store/facts.js — writing a fact, and the guards that decide whether a
 * write is allowed at all.
 *
 * Three rules live here, and all three are enforced in the statement rather than in a
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
 * @module utils/reference-store/facts
 */

const { z } = require("zod");

const { refusal, ownershipRefusal } = require("./refusals");
const { verifyEvidence } = require("./evidence");
const { getCast, upsertCast, linkFactCharacters } = require("./cast");
const { FACT_ASPECTS, FACT_STATUSES, SOURCE_STAGES, EVIDENCE_KINDS, EVIDENCE_MATCHES, isInVocabulary } = require("./schema");
require("../../types"); // JSDoc type definitions

// ─── The proposal contract ────────────────────────────────────────────────────

/** One citation: this quote, at this line of this chapter of this volume. */
const EVIDENCE_SCHEMA = z.object({
  volume: z.number().int().min(1),
  chapter: z.string().min(1),
  line: z.number().int().min(1),
  quote: z.string().min(1),
  // Both fields are optional here and **stamped by verification** afterwards, so a caller may
  // suggest them but cannot assert them: `kind` says what the citation claims (review 05 §3.6)
  // and `matched` says which rule proved it (review 05 §3.1). A zod object strips unknown keys,
  // so leaving either out here would silently drop it before the store ever saw it.
  kind: z.enum(EVIDENCE_KINDS).optional(),
  matched: z.enum(EVIDENCE_MATCHES).optional(),
});

/**
 * What a caller may propose. `strict` is the guard: the harness-owned fields are not in
 * the list, so proposing one is a refusal that names it (rule 2 above).
 */
const FACT_PROPOSAL_SCHEMA = z.strictObject({
  id: z.string().min(1).optional(),
  key: z.string().min(1).nullable().optional(),
  aspect: z.string().min(1),
  label: z.string().min(1).nullable().optional(),
  section: z.string().min(1).nullable().optional(),
  body: z.string().min(1),
  examples: z.array(z.string()).optional(),
  formality: z.string().nullable().optional(),
  evidence: z.array(EVIDENCE_SCHEMA).min(1),
  establishedVolume: z.number().int().min(1).optional(),
  establishedChapter: z.string().nullable().optional(),
  appliesFromVolume: z.number().int().min(1).optional(),
  appliesToVolume: z.number().int().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  supersedes: z.string().min(1).nullable().optional(),
  /**
   * The name the extraction wrote for this claim, kept when the store files the claim somewhere else —
   * onto a different roster entry, or under none at all. See migration 6.
   */
  extractedAs: z.string().min(1).nullable().optional(),
  characters: z.array(z.strictObject({ key: z.string().min(1), role: z.string().optional() })).optional(),
  cast: z
    .strictObject({
      display: z.string().min(1),
      persona: z.string().nullable().optional(),
      aliases: z.array(z.string()).optional(),
      notes: z.string().nullable().optional(),
    })
    .optional(),
});

/** The fields the harness owns. Naming them in a proposal is refused, not discarded. */
const HARNESS_OWNED_FIELDS = ["owner_volume", "ownerVolume", "owner_stage", "ownerStage", "sealed", "row_version", "rowVersion", "created_at", "createdAt", "ord"];

/** The fields `updateOwnFact` may change. Anything else is a different fact. */
const UPDATABLE_FIELDS = [
  "key",
  "aspect",
  "label",
  "section",
  "body",
  "examples",
  "formality",
  "evidence",
  "establishedVolume",
  "establishedChapter",
  "appliesFromVolume",
  "appliesToVolume",
  "confidence",
  "characters",
];

const UPDATE_SCHEMA = z.strictObject({
  key: z.string().min(1).nullable().optional(),
  aspect: z.string().min(1).optional(),
  label: z.string().min(1).nullable().optional(),
  section: z.string().min(1).nullable().optional(),
  body: z.string().min(1).optional(),
  examples: z.array(z.string()).optional(),
  formality: z.string().nullable().optional(),
  evidence: z.array(EVIDENCE_SCHEMA).min(1).optional(),
  establishedVolume: z.number().int().min(1).optional(),
  establishedChapter: z.string().nullable().optional(),
  appliesFromVolume: z.number().int().min(1).optional(),
  appliesToVolume: z.number().int().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  characters: z.array(z.strictObject({ key: z.string().min(1), role: z.string().optional() })).optional(),
});

// ─── Reading ──────────────────────────────────────────────────────────────────

/**
 * One fact by id.
 *
 * @param {{db: Object}} ctx
 * @param {string} id
 * @returns {Object|null}
 */
function getFact(ctx, id) {
  return ctx.db.prepare("SELECT * FROM facts WHERE id = ?").get(String(id)) || null;
}

/**
 * Every fact in the store, in render order.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<Object>}
 */
function allFacts(ctx) {
  return ctx.db.prepare("SELECT * FROM facts ORDER BY ord, id").all();
}

// ─── ids ──────────────────────────────────────────────────────────────────────

/**
 * A fact id: `v01-ch3-017` (doc 03 §2).
 *
 * Generated here rather than supplied by the caller so two runs over the same data produce
 * the same ids — which is what makes "rendering the same data twice is byte-identical"
 * (slice 4) testable rather than a hope.
 *
 * @param {{db: Object}} ctx
 * @param {{volume: number, chapter: string|null, aspect: string}} parts
 * @returns {string}
 */
function makeFactId(ctx, { volume, chapter, aspect }) {
  const vol = String(volume).padStart(2, "0");
  const ch = String(chapter || "x").replace(/[^A-Za-z0-9.]/g, "") || "x";
  const stem = `v${vol}-${ch}`;
  const exists = ctx.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE id LIKE ?").get(`${stem}-%`).n;
  for (let n = exists + 1; n < exists + 10000; n += 1) {
    const candidate = `${stem}-${String(n).padStart(3, "0")}`;
    if (!getFact(ctx, candidate)) return candidate;
  }
  throw new Error(`[reference-store] could not allocate a fact id under "${stem}" for aspect ${aspect}`);
}

/**
 * The next render slot. `ord` is stored so rendering does not depend on SQLite's internal
 * row order.
 *
 * @param {{db: Object}} ctx
 * @returns {number}
 */
function nextOrd(ctx) {
  const row = ctx.db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM facts").get();
  return (row && row.m) + 1;
}

// ─── Validation shared by insert and update ───────────────────────────────────

/**
 * Check the parts of a proposal that are not evidence: the closed vocabularies, the
 * provenance rule, and the fields the harness owns.
 *
 * @param {{db: Object, scope: {volume: number, stage: string}}} ctx
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

// ─── insert ───────────────────────────────────────────────────────────────────

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

// ─── update / delete, guarded in the statement ────────────────────────────────

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

// ─── challenge ────────────────────────────────────────────────────────────────

/**
 * Contradict a fact you do not own, without editing it.
 *
 * The verb ownership alone is missing (doc 03 §3.2): a later book that corrects an earlier
 * one has nowhere to go otherwise. It writes a row of its own — owned by this scope, with
 * its own verified evidence — marks the target `disputed`, and records the claim in
 * `challenges` so "who said this was wrong, and when" is answerable afterwards.
 *
 * **Supersession is a choice, not a side effect** (review 05 §3.5). `supersede: true` says
 * "this book replaces that one", and the challenger is filed against the target so the target
 * drops out of the guidance. The default is `false`: the challenger is filed with
 * `supersedes = null`, the target stays showable and marked `disputed`, and the translator sees
 * a **contested** claim rather than a silently replaced one. A challenge that automatically
 * replaced its target would make every disagreement a decision nobody made.
 *
 * Either way the challenge is open until someone closes it — see `resolveChallenge`.
 *
 * @param {{db: Object, scope: {volume: number, stage: string}, resolveVolume: Function}} ctx
 * @param {string} id - The fact being challenged.
 * @param {{reason: string, evidence: Array<Object>, body?: string, aspect?: string, label?: string, supersede?: boolean}} proposal
 * @returns {{ok: boolean, fact: Object|null, target: Object|null, challengeId: number|null, supersede: boolean, refusal: ReferenceRefusal|null}}
 */
function challengeFact(ctx, id, proposal) {
  const target = getFact(ctx, id);
  if (!target) {
    return {
      ok: false,
      fact: null,
      target: null,
      challengeId: null,
      supersede: false,
      refusal: refusal({
        verb: "challenge_fact",
        rule: "unknown-fact",
        because: `there is no fact "${id}" to challenge.`,
      }),
    };
  }
  const reason = proposal && typeof proposal.reason === "string" ? proposal.reason.trim() : "";
  if (!reason) {
    return {
      ok: false,
      fact: null,
      target,
      challengeId: null,
      supersede: false,
      refusal: refusal({
        verb: "challenge_fact",
        rule: "challenge-needs-reason",
        because: "a challenge has to say what is wrong with the fact it answers.",
        fix: "challenge_fact(id, {reason, evidence}) — the evidence is the argument.",
      }),
    };
  }
  // `supersede` is read as a boolean and defaults to false. Anything that is not exactly
  // `true` means "contest it, do not replace it", so a caller that passes a truthy string
  // cannot accidentally make the stronger claim.
  const supersede = proposal.supersedes === true || proposal.supersede === true;

  const inserted = insertFact(ctx, {
    key: target.key,
    aspect: proposal.aspect || target.aspect,
    label: proposal.label === undefined ? target.label : proposal.label,
    section: proposal.section === undefined ? target.section : proposal.section,
    body: proposal.body || `Challenges ${target.id}: ${reason}`,
    evidence: proposal.evidence,
    establishedVolume: ctx.scope.volume,
    appliesFromVolume: target.applies_from_volume,
    supersedes: supersede ? target.id : null,
  });
  if (!inserted.ok) {
    return { ok: false, fact: null, target, challengeId: null, supersede, refusal: inserted.refusal };
  }

  // **This UPDATE is deliberately unguarded, and that is the only place in this layer where
  // one is.** Everywhere else the rule lives in the WHERE clause — `owner_volume = ? AND
  // owner_stage = ? AND sealed = 0` — because a stage may only touch its own rows. Here the
  // whole point of the verb is to affect a row the caller does NOT own: flagging an earlier
  // volume's claim as disputed is the sanctioned consequence of a challenge (doc 03 §3.2).
  // What keeps it safe is the column list: it sets `status` and nothing else. Body, evidence,
  // key, aspect and owner are untouched, so the target's claim survives being disputed — which
  // is exactly what "contested, not replaced" has to mean. Do not add an ownership predicate
  // to this statement: it would make challenging another volume's fact impossible, which is
  // the reason this verb exists.
  ctx.db
    .prepare("UPDATE facts SET status = 'disputed', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), target.id);

  const challenge = ctx.db
    .prepare(
      "INSERT INTO challenges (fact_id, challenger_id, reason, evidence, created_at) VALUES (?,?,?,?,?)"
    )
    .run(target.id, inserted.fact.id, reason, JSON.stringify(proposal.evidence || []), new Date().toISOString());

  return {
    ok: true,
    fact: inserted.fact,
    target: getFact(ctx, target.id),
    challengeId: Number(challenge.lastInsertRowid),
    supersede,
    refusal: null,
  };
}

/**
 * The challenges in this store, open ones first.
 *
 * The read that makes the open-disputes signal reachable: a count of rows with
 * `outcome IS NULL` is the number the pipeline wants to drive to zero, and without this verb
 * a challenge is something only the database knows about.
 *
 * @param {{db: Object}} ctx
 * @param {{openOnly?: boolean}} [opts] - Defaults to open only; pass `openOnly: false` for the whole history.
 * @returns {Array<Object>} `{id, fact_id, challenger_id, reason, created_at, outcome, resolved_at, resolved_by_volume, target_body, challenger_body}`
 */
function listChallenges(ctx, { openOnly = true } = {}) {
  const where = openOnly ? "WHERE c.outcome IS NULL" : "";
  return ctx.db
    .prepare(
      "SELECT c.*, t.body AS target_body, k.body AS challenger_body, t.status AS target_status, " +
        "k.status AS challenger_status, t.owner_volume AS target_owner_volume " +
        `FROM challenges c JOIN facts t ON t.id = c.fact_id JOIN facts k ON k.id = c.challenger_id ${where} ` +
        "ORDER BY c.outcome IS NOT NULL, c.id"
    )
    .all();
}

/**
 * Close a challenge (review 05 §3.5).
 *
 * A challenge that cannot be closed is a permanent warning nobody can clear, and the pipeline
 * already counts open disputes as a signal that has to be able to reach zero.
 *
 *   - `uphold` — the target stands. The challenger is retracted and the target's `disputed`
 *     mark is cleared, so the guidance goes back to what it was.
 *   - `accept` — the challenger stands. Its `supersedes` is set to the target (which is what
 *     removes the target from the guidance) and the target is marked `superseded`.
 *
 * Like `challenge_fact`, this changes **status and `supersedes` only**. It may act on a
 * challenge an earlier volume opened — judging a dispute is the current volume's job — but it
 * never edits the body or evidence of a row it does not own, and the resolution is attributed
 * to the volume and stage that made it.
 *
 * @param {{db: Object, scope: {volume: number, stage: string}}} ctx
 * @param {number|string} id - The `challenges.id`, or the challenger fact's id.
 * @param {"uphold"|"accept"} outcome
 * @returns {{ok: boolean, challenge: Object|null, outcome: string|null, refusal: ReferenceRefusal|null}}
 */
function resolveChallenge(ctx, id, outcome) {
  const wanted = String(id === undefined || id === null ? "" : id).trim();
  // Either identifier is accepted, because the one a caller has in hand depends on which verb
  // produced the dispute. The numeric lookup is only tried for something that IS a number, so a
  // fact id like `v02-…` cannot be coerced into NaN and matched against nothing.
  const asNumber = Number(wanted);
  const challenge =
    (Number.isSafeInteger(asNumber) ? ctx.db.prepare("SELECT * FROM challenges WHERE id = ?").get(asNumber) : null) ||
    ctx.db.prepare("SELECT * FROM challenges WHERE challenger_id = ?").get(wanted) ||
    null;
  if (!challenge) {
    return {
      ok: false,
      challenge: null,
      outcome: null,
      refusal: refusal({
        verb: "resolve_challenge",
        rule: "unknown-challenge",
        because: `there is no challenge "${wanted}" — pass the challenge id, or the challenger fact's id.`,
        fix: "list_challenges() answers both.",
      }),
    };
  }
  // The argument is checked before the state, because a malformed call should read as a
  // malformed call even when the challenge it names happens to be closed already.
  const outcomeValue = String(outcome || "").trim();
  if (outcomeValue !== "uphold" && outcomeValue !== "accept") {
    return {
      ok: false,
      challenge,
      outcome: null,
      refusal: refusal({
        verb: "resolve_challenge",
        rule: "challenge-outcome-unknown",
        because: `resolve_challenge(id, outcome) takes "uphold" or "accept"; got ${JSON.stringify(outcome)}.`,
      }),
    };
  }
  if (challenge.outcome !== null) {
    return {
      ok: false,
      challenge,
      outcome: challenge.outcome,
      refusal: refusal({
        verb: "resolve_challenge",
        rule: "challenge-already-resolved",
        because:
          `challenge ${challenge.id} was already resolved as "${challenge.outcome}" at ${challenge.resolved_at} ` +
          `(by volume ${challenge.resolved_by_volume}). A resolution is not re-decided; open a new challenge instead.`,
        useInstead: ["challenge_fact"],
      }),
    };
  }

  const target = getFact(ctx, challenge.fact_id);
  const challenger = getFact(ctx, challenge.challenger_id);
  if (!target || !challenger) {
    return {
      ok: false,
      challenge,
      outcome: null,
      refusal: refusal({
        verb: "resolve_challenge",
        rule: "challenge-row-missing",
        because:
          `challenge ${challenge.id} names a fact that is no longer in this store ` +
          `("${challenge.fact_id}" / "${challenge.challenger_id}"). A dispute is closed against a record, not a memory.`,
      }),
    };
  }

  const now = new Date().toISOString();
  ctx.db.exec("BEGIN");
  try {
    if (outcomeValue === "uphold") {
      // The challenger was wrong: it is retracted, so it stops being showable, and the target
      // is un-flagged. A retracted row is never deleted — the wrong claim stays auditable.
      ctx.db
        .prepare("UPDATE facts SET status = 'retracted', updated_at = ? WHERE id = ?")
        .run(now, challenger.id);
      if (target.status === "disputed") {
        ctx.db.prepare("UPDATE facts SET status = 'active', updated_at = ? WHERE id = ?").run(now, target.id);
      }
    } else {
      // The challenger was right: it now supersedes the target, which is the mechanism that
      // takes the target out of the guidance (the showable_facts view excludes a fact another
      // live fact supersedes).
      ctx.db
        .prepare("UPDATE facts SET supersedes = ?, status = 'active', updated_at = ? WHERE id = ?")
        .run(target.id, now, challenger.id);
      ctx.db.prepare("UPDATE facts SET status = 'superseded', updated_at = ? WHERE id = ?").run(now, target.id);
    }
    ctx.db
      .prepare("UPDATE challenges SET outcome = ?, resolved_at = ?, resolved_by_volume = ?, resolved_by_stage = ? WHERE id = ?")
      .run(outcomeValue, now, ctx.scope.volume, ctx.scope.stage, challenge.id);
    ctx.db.exec("COMMIT");
  } catch (err) {
    ctx.db.exec("ROLLBACK");
    throw err;
  }

  return {
    ok: true,
    challenge: ctx.db.prepare("SELECT * FROM challenges WHERE id = ?").get(challenge.id),
    outcome: outcomeValue,
    refusal: null,
  };
}

// ─── sealing ──────────────────────────────────────────────────────────────────

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

/**
 * The statuses the store will accept, for a caller that reports them.
 * @type {string[]}
 */
const KNOWN_STATUSES = FACT_STATUSES;
const KNOWN_STAGES = SOURCE_STAGES;

module.exports = {
  EVIDENCE_SCHEMA,
  FACT_PROPOSAL_SCHEMA,
  UPDATE_SCHEMA,
  HARNESS_OWNED_FIELDS,
  UPDATABLE_FIELDS,
  KNOWN_STATUSES,
  KNOWN_STAGES,
  getFact,
  allFacts,
  makeFactId,
  harnessOwnedFieldRefusal,
  insertFact,
  updateOwnFact,
  deleteOwnFact,
  challengeFact,
  listChallenges,
  resolveChallenge,
  sealVolume,
  isVolumeSealed,
  factsAtVolume,
};

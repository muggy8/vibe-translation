/**
 * utils/reference-store/facts/contract.js — what a caller may propose, and which fields it
 * may not.
 *
 * The zod contracts for one facts row, plus the two field lists that decide what a write is
 * allowed to name. HARNESS_OWNED_FIELDS is refused on the RAW proposal before zod runs, so
 * the answer reads harness-owned-field rather than zod's unrecognized-key complaint (doc 03
 * §3.2): a field the model writes that the guard then quietly discards is a field the model
 * will keep writing. UPDATABLE_FIELDS is the same boundary from the other side — the fields an
 * update may change, because anything else is a different fact. KNOWN_STATUSES and KNOWN_STAGES
 * are the store's closed vocabularies, re-exported for a caller that reports them.
 *
 * Holds no logic. The tables live in this folder because this layer is where the store's
 * guards live (AGENTS.md §3: utils/reference-store/ is a banned patch path).
 *
 * @module utils/reference-store/facts/contract
 */

const { z } = require("zod");

const { FACT_STATUSES, SOURCE_STAGES, EVIDENCE_KINDS, EVIDENCE_MATCHES } = require("../schema");
require("../../../types"); // JSDoc type definitions

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
  /**
   * The register axis this claim answers, and the answer it gives, as declared by the series. See
   * migration 10 and `register/filing.js`.
   *
   * The contract only says "a non-empty string". The **check** — that the id is one this series declared
   * and the value is one of that axis's declared values — runs at filing, in `facts/validate.js`, against
   * the declaration frozen into the store handle. It is deliberately not a zod enumeration: the values
   * come from the series' plan of record, not from this file, and a closed schema here would be the axis
   * list in code that plan 06 §4 forbids.
   */
  axis: z.string().min(1).optional(),
  axisValue: z.string().min(1).optional(),
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
};

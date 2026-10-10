/**
 * utils/reference-store/integrity.js — the deterministic audit as queries (doc 03 §5).
 *
 * Every query here corresponds to something that actually went wrong in the run that
 * stopped, and every one of them is free. They are the checks copy-forward runs before a
 * volume's file is allowed to become the next volume's starting point (doc 03 §7.3):
 * **a corrupt volume does not get to infect the next one.**
 *
 * The findings are `PostMortemFinding` objects built by `utils/postmortem`'s own
 * constructor, so a copy that fails is a HIGH finding in the same report the step runner
 * already writes — not a warning in a log file nobody reads.
 *
 * Fail-closed rule, stated because it is the interesting one: when the source text a fact
 * cites is not on disk, that is reported as a HIGH finding rather than skipped. "Could not
 * check" and "checked and clean" must not mean the same thing here (the same rule
 * `utils/delivery-verify` states about unreadable artifacts, gotcha 73). There is no
 * switch that turns the evidence check off.
 *
 * @module utils/reference-store/integrity
 */

const { finding } = require("../postmortem");
const { verifyStoredEvidence } = require("./evidence");
const { COUNTED_TABLES, EXTRACTION_SOURCE_STAGE } = require("./schema");
const { tableCounts } = require("./queries");
const { presenceMeasured } = require("./presence");
const { documentMirrored, DOCUMENT_VOICE } = require("./document-prose");
// `isVolumeSealed` lives with the sealing verb itself, so the "is this volume published?"
// question has exactly one answer in this layer. facts.js does not require this file, so the
// edge does not close a cycle (gotcha 85).
const { isVolumeSealed } = require("./facts");
require("../../types"); // JSDoc type definitions

/** The step name the findings are filed under. */
const INTEGRITY_STEP = "reference-store";

/**
 * Every fact whose evidence column is empty or not a JSON array of at least one item.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<{id: string, problem: string}>}
 */
function factsWithoutEvidence(ctx) {
  const out = [];
  for (const row of ctx.db.prepare("SELECT id, evidence FROM facts ORDER BY ord").all()) {
    let items;
    try {
      items = JSON.parse(row.evidence);
    } catch {
      out.push({ id: row.id, problem: "the evidence column is not valid JSON" });
      continue;
    }
    if (!Array.isArray(items) || items.length === 0) {
      out.push({ id: row.id, problem: "the fact has no evidence item" });
    }
  }
  return out;
}

/**
 * Facts whose own evidence cites a volume later than the volume that produced them.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<{id: string, establishedVolume: number, ceilingVolume: number}>}
 */
function impossibleProvenance(ctx) {
  return ctx.db
    .prepare(
      "SELECT f.id AS id, f.established_volume AS establishedVolume, c.ceiling_volume AS ceilingVolume " +
        "FROM facts f JOIN fact_evidence_ceiling c ON c.fact_id = f.id " +
        "WHERE c.ceiling_volume > f.established_volume ORDER BY f.ord"
    )
    .all();
}

/**
 * Cast rows that are the same character twice.
 *
 * Two shapes, both observed as the risk doc 03 §5 names: two rows with the same display,
 * and a row whose key is listed as another row's alias — which means the alias was merged
 * in one direction and never the other.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<{keys: string[], problem: string}>}
 */
function splitCharacters(ctx) {
  const rows = ctx.db.prepare("SELECT key, display, aliases FROM cast ORDER BY key").all();
  const out = [];

  const byDisplay = new Map();
  for (const row of rows) {
    const display = String(row.display || "").trim().toLowerCase();
    if (!display) continue;
    if (!byDisplay.has(display)) byDisplay.set(display, []);
    byDisplay.get(display).push(row.key);
  }
  for (const [display, keys] of byDisplay) {
    if (keys.length > 1) {
      out.push({ keys, problem: `two cast entries render as the same character "${display}"` });
    }
  }

  for (const row of rows) {
    let aliases = [];
    try {
      aliases = JSON.parse(row.aliases || "[]");
    } catch {
      continue;
    }
    for (const alias of aliases) {
      if (alias === row.key) continue;
      const other = ctx.db.prepare("SELECT key FROM cast WHERE key = ?").get(alias);
      if (other) {
        out.push({
          keys: [row.key, alias],
          problem:
            `"${alias}" is listed as an alias of "${row.key}" and is ALSO its own cast entry — ` +
            "the identity was never merged (cast_alias is the verb that merges it).",
        });
      }
    }
  }
  return out;
}

/**
 * `supersedes` chains that are circular, and retractions with nothing replacing them.
 *
 * The second one is "silent deletion dressed as a correction" (doc 03 §5): a fact marked
 * retracted with no live successor is a fact that has been removed while the record claims
 * it was corrected.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<{id: string, problem: string}>}
 */
function brokenSupersession(ctx) {
  const out = [];
  const byId = new Map();
  for (const row of ctx.db.prepare("SELECT id, status, supersedes FROM facts").all()) {
    byId.set(row.id, row);
  }

  for (const row of byId.values()) {
    if (!row.supersedes) continue;
    const seen = new Set([row.id]);
    let cursor = byId.get(row.supersedes);
    while (cursor) {
      if (seen.has(cursor.id)) {
        out.push({ id: row.id, problem: `the supersedes chain from "${row.id}" is circular` });
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.supersedes ? byId.get(cursor.supersedes) : null;
    }
  }

  for (const row of byId.values()) {
    if (row.status !== "retracted") continue;
    // A retracted CHALLENGER is not a deleted claim: it is a challenge that was judged and
    // lost (resolve_challenge uphold). The failure this query looks for is a fact taken out of
    // the guidance with nothing replacing it, which is a claim the book said and nobody kept.
    const withdrawn = ctx.db.prepare("SELECT 1 AS one FROM challenges WHERE challenger_id = ?").get(row.id);
    if (withdrawn) continue;
    const replacement = ctx.db
      .prepare("SELECT id FROM facts WHERE supersedes = ? AND status <> 'retracted'")
      .get(row.id);
    if (!replacement) {
      out.push({
        id: row.id,
        problem:
          `fact "${row.id}" is retracted and nothing supersedes it — a deletion recorded as a ` +
          "correction. The verb that is available is challenge_fact, which keeps the trajectory.",
      });
    }
  }
  return out;
}

/**
 * Volumes this store represents that have not been sealed (review 05 §3.2).
 *
 * The rule: **a store may not be copied forward unless every volume up to N that it represents
 * is sealed.** Sealing is what makes a volume's record published-and-frozen; copying an
 * unsealed volume forward means the next volume starts from a draft that its own volume can
 * still be edited into, and the copy's provenance would claim a stability that does not exist.
 *
 * "Represented" is answered from the data rather than from a caller's promise: a volume counts
 * if it is registered in `volumes` or if any fact in this file is owned by it.
 *
 * @param {{db: Object}} ctx
 * @param {number} upTo - The store's own volume: volumes above it are not this file's business.
 * @returns {number[]} Unsealed volume numbers, ascending.
 */
function unsealedVolumes(ctx, upTo) {
  const limit = Number(upTo);
  const rows = ctx.db
    .prepare(
      "SELECT volume AS volume FROM volumes WHERE volume <= ? " +
        "UNION SELECT owner_volume AS volume FROM facts WHERE owner_volume <= ? " +
        "ORDER BY volume"
    )
    .all(limit, limit);
  return rows.map((row) => row.volume).filter((volume) => !isVolumeSealed(ctx, volume));
}

/**
 * How many facts landed in the catch-all aspect, per volume (review 05 §2.3).
 *
 * Doc 03 risk 5 is a catch-all quietly becoming where everything lands. The counter is the
 * guard: the number is reported on every audit, so a store that has drifted into `unclassified`
 * shows up as a number in the post-mortem instead of being comfortable.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<{volume: number, n: number}>}
 */
function unclassifiedFacts(ctx) {
  return ctx.db
    .prepare(
      "SELECT owner_volume AS volume, COUNT(*) AS n FROM facts WHERE aspect = 'unclassified' " +
        "GROUP BY owner_volume ORDER BY owner_volume"
    )
    .all();
}

/**
 * Characters the cast holds that no character-voice claim covers (review 05 §4 item D,
 * refined by the account owner's rule that a character who is not in the volume is not damage).
 *
 * The roster is the cast; the coverage is the character-voice claims attached to it. A cast
 * entry counts as a failure only when **this volume's own text contains them** and nothing in
 * the reference says anything about them — because a character who has no lines in this volume
 * is supposed to be left alone, and reporting them would train everyone to ignore the finding.
 *
 * "Contains them" is answered by `presence.js`, which searches the volume's extracted chapter
 * files with the store's own matching rule (verbatim, then the Han-character skeleton). When
 * that measurement has not been taken for this volume the query falls back to the stricter
 * rule — every cast entry with no voice claim is reported — because an unmeasured volume must
 * never read as a volume where nobody appears. The measurement can narrow the finding; it can
 * never switch it off.
 *
 * Merged cast entries do not count: their facts were re-pointed to the entry they joined, so
 * the character is covered under the surviving key.
 *
 * The question is only asked once this volume's record holds a mirror of its character-voice
 * document (`document-prose.js`'s marker). A glossary stage that has registered the roster but not
 * yet run the voice stage would otherwise report every character who appears in the volume as
 * uncovered, on every volume, forever — and a HIGH finding that fires when nothing is wrong is a
 * finding people learn to skip. A volume whose voice stage never ran is caught by the sealing check.
 *
 * Only rows that are **record content** count as coverage, and an extraction candidate is not one
 * (`schema.js`'s `EXTRACTION_SOURCE_STAGE`). The extraction pass files its own claims about the same
 * characters, and if those counted, a reference that had lost a character would read as fully covered
 * as long as the extractor had noticed them — the false pass this whole layer exists to prevent. A
 * glossary row does not count either: it says how a name is translated, not what the character sounds
 * like, and the glossary registers the roster without attaching its rows to it.
 *
 * @param {{db: Object}} ctx
 * @param {number} upTo - The store's own volume.
 * @returns {Array<{key: string, display: string}>}
 */
function uncoveredCharacters(ctx, upTo) {
  const limit = Number(upTo);
  // The question presupposes an answer: it asks what the character-voice reference says about each
  // name on the roster, and a volume whose reference has not been read into the record yet has
  // nothing to ask about. That case is caught by the sealing check, not here.
  if (!documentMirrored(ctx, DOCUMENT_VOICE, limit)) return [];
  const measured = presenceMeasured(ctx, limit);
  const presenceClause = measured
    ? "AND EXISTS (SELECT 1 FROM cast_presence p WHERE p.volume = ? AND p.key = c.key AND p.present = 1) "
    : "";
  const params = measured ? [limit, limit] : [limit];
  return ctx.db
    .prepare(
      "SELECT c.key AS key, c.display AS display FROM cast c " +
        "WHERE (c.first_seen_volume IS NULL OR c.first_seen_volume <= ?) AND c.merged_into IS NULL " +
        presenceClause +
        "AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.key = c.key AND f.aspect != 'term_usage' " +
        "AND f.source_stage != ?) " +
        "ORDER BY c.first_seen_volume IS NULL, c.first_seen_volume, c.key"
    )
    .all(...params, EXTRACTION_SOURCE_STAGE);
}

/**
 * The whole integrity account for one store.
 *
 * @param {Object} ctx - The store context (needs `db`, `resolveVolume`, `volume`).
 * @param {{volume?: number|string, step?: string, upTo?: number, publishedVolume?: number|null}} [opts]
 *   - `volume` is the label findings are filed under; `upTo` is the volume the roster questions are
 *   asked about, and defaults to the volume this store is open for. `publishedVolume` is the volume
 *   the caller is treating as **finished**: the sealing question is asked up to that volume, and not
 *   beyond it. A stage auditing the volume it is still writing leaves it unset, because "is this
 *   published yet?" has one honest answer mid-build — no — and reporting the ordinary state of being
 *   built as HIGH damage is how a check gets ignored. Copy-forward sets it to the volume it is about
 *   to copy, which is where the question has teeth. It is not a switch: no value turns the sealing
 *   check off for a volume the caller calls finished.
 * @returns {{ok: boolean, findings: PostMortemFinding[], counts: Object<string, number>, checked: number}}
 */
function integrityFindings(ctx, { volume = null, step = INTEGRITY_STEP, upTo, publishedVolume = null } = {}) {
  const findings = [];
  const counts = tableCounts(ctx, COUNTED_TABLES);
  const limit = Number(upTo === undefined ? ctx.volume : upTo);

  const noEvidence = factsWithoutEvidence(ctx);
  for (const item of noEvidence) {
    findings.push(
      finding("HIGH", "reference-fact-without-evidence", step, volume, "series.db", `${item.id}: ${item.problem}`)
    );
  }

  const evidenceCheck = verifyStoredEvidence(
    ctx.db.prepare("SELECT id, evidence FROM facts ORDER BY ord").all(),
    ctx.resolveVolume
  );
  for (const failure of evidenceCheck.failures) {
    findings.push(
      finding("HIGH", "reference-evidence-does-not-verify", step, volume, "series.db", `${failure.id}: ${failure.problem}`)
    );
  }

  for (const item of impossibleProvenance(ctx)) {
    findings.push(
      finding(
        "HIGH",
        "reference-impossible-provenance",
        step,
        volume,
        "series.db",
        `${item.id}: established at volume ${item.establishedVolume} but its evidence cites volume ${item.ceilingVolume}`
      )
    );
  }

  for (const item of splitCharacters(ctx)) {
    findings.push(
      finding("MEDIUM", "reference-character-split-in-two", step, volume, "series.db", `${item.keys.join(" / ")}: ${item.problem}`)
    );
  }

  for (const item of brokenSupersession(ctx)) {
    findings.push(
      finding("MEDIUM", "reference-broken-supersession", step, volume, "series.db", `${item.id}: ${item.problem}`)
    );
  }

  // §3.2 — an unsealed volume is a draft, and a draft is not something the next volume may
  // start from. HIGH, because copy-forward refuses on HIGH and this is the check that keeps
  // "published" meaning published. Asked up to `publishedVolume` only: a store open for volume N
  // is in the middle of writing volume N, and calling that HIGH damage every time a stage audits
  // its own work is a false positive that teaches everyone to ignore the finding.
  const published = publishedVolume === null || publishedVolume === undefined ? null : Number(publishedVolume);
  const sealedLimit = published === null ? Math.min(limit, ctx.volume - 1) : Math.min(limit, published);
  for (const unsealed of unsealedVolumes(ctx, sealedLimit)) {
    findings.push(
      finding(
        "HIGH",
        "reference-volume-unsealed",
        step,
        volume,
        "series.db",
        `volume ${unsealed} is represented in this store but has not been sealed: seal_volume(${unsealed}) ` +
          "publishes a volume's record, and a copy may not carry a record that is still editable."
      )
    );
  }

  // §2.3 — the catch-all is counted, not hidden. MEDIUM: a store where everything lands in
  // `unclassified` is not corrupt, it is unqueryable, which is a slower and quieter failure.
  for (const item of unclassifiedFacts(ctx)) {
    findings.push(
      finding(
        "MEDIUM",
        "reference-facts-unclassified",
        step,
        volume,
        "series.db",
        `${item.n} fact(s) from volume ${item.volume} are aspect "unclassified" — the fallback is where ` +
          "they all landed, which is doc 03 risk 5. Give them an aspect, or say why they have none."
      )
    );
  }

  // §4 item D — the artifact that killed the last run, caught by a query instead of by someone
  // noticing. HIGH: this is the check that turns "the voice reference got smaller" from an
  // observation into a refusal. A character the volume's own text does not contain is not on
  // this list: a character with no lines in the volume is supposed to be left alone.
  const uncovered = uncoveredCharacters(ctx, limit);
  if (uncovered.length) {
    const roster = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM cast WHERE (first_seen_volume IS NULL OR first_seen_volume <= ?) AND merged_into IS NULL")
      .get(limit).n;
    const basis = presenceMeasured(ctx, limit)
      ? `the volume's own text contains them`
      : `presence has not been measured for this volume, so every uncovered cast entry is reported`;
    findings.push(
      finding(
        "HIGH",
        "reference-voice-covers-fewer-characters",
        step,
        volume,
        "series.db",
        `the cast holds ${roster} character(s) but ${uncovered.length} of them have no character-voice claim ` +
          `at all, and ${basis}: ${uncovered.map((c) => c.key).join(", ")}. A character-voice reference ` +
          "that covers fewer characters than the roster is a damaged reference, and importing it " +
          "faithfully reproduces the damage."
      )
    );
  }

  return {
    ok: !findings.some((f) => f.severity === "HIGH"),
    findings,
    counts,
    checked: evidenceCheck.checked,
    coverageAsked: documentMirrored(ctx, DOCUMENT_VOICE, limit),
  };
}

module.exports = {
  INTEGRITY_STEP,
  factsWithoutEvidence,
  impossibleProvenance,
  splitCharacters,
  brokenSupersession,
  unsealedVolumes,
  unclassifiedFacts,
  uncoveredCharacters,
  integrityFindings,
};

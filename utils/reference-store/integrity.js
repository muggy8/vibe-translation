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
const { presenceMeasured, presenceChapterCount } = require("./presence");
const { isBareFirstPersonPronoun, spanTokens } = require("./name-resolution");
const { documentMirrored, DOCUMENT_VOICE, rebuildProvenanceCounts } = require("./document-prose");
// `isVolumeSealed` lives with the sealing verb itself, so the "is this volume published?"
// question has exactly one answer in this layer. facts.js does not require this file, so the
// edge does not close a cycle (gotcha 85).
const { isVolumeSealed } = require("./facts");
require("../../types"); // JSDoc type definitions

/** The step name the findings are filed under. */
const INTEGRITY_STEP = "reference-store";

/**
 * How much of a volume a character has to be in before "the reference says nothing about them"
 * counts as a **loss** rather than a **mention**.
 *
 * This is the coverage rule's line, and it is a constant rather than a setting for the reason
 * AGENTS.md rule 3 states: a guard the role can switch off is not a guard. It is pinned in
 * `test/test-reference-store-pipeline.js` so moving it is a deliberate edit to this file, not a
 * value somebody's shell happens to have set.
 *
 * **How the number was picked — measured on volume 01, with this layer's own matching rule**
 * (verbatim, then the Han-character skeleton), counting DISTINCT chapters of the volume's ten
 * chapter files in which the name occurs:
 *
 * | name | chapters | lines | voice claims | what the rule must say |
 * |---|---|---|---|---|
 * | 俺 | 10 | 789 | yes | covered — not asked |
 * | 女 | 9 | 146 | yes | covered — not asked |
 * | 三色院菫子 | 4 | 8 | yes, 30 | a main character |
 * | 如月雨露 | 3 | 3 | yes | a main character |
 * | ジョージョエン・スカイウォーカー | 2 | 6 | no | **a mention** |
 * | 大賀太陽 | 2 | 2 | yes | covered — not asked |
 * | 山田 | 1 | 2 | no | **a mention** |
 * | 日向葵 | 1 | 1 | yes | covered — not asked |
 * | 秋野桜 | 1 | 1 | yes | covered — not asked |
 *
 * That fixes the value from both ends: a fictional film actor spoken about in 2 chapters must land
 * at MEDIUM, so the line is above 2; 如月雨露, whom the destroyed reference lost, is named in 3
 * chapters and must land at HIGH, so the line is at or below 3. **3 is the only number that
 * satisfies both**, and it is not tuned to anything else.
 *
 * What the line cannot do, stated here because it is the interesting part: 日向葵 and 秋野桜 are
 * major characters named in **one** chapter each. Chapter count alone would call them mentions.
 * That is why the rule has a second, independent signal — the extraction pass finding voice
 * material for them — and why a character below this line is reported by name rather than
 * silently forgiven. On a **rebuilt** reference that second signal exists only because the rebuild
 * files each adopted claim's candidate copy beside it (`rebuild.js`, gotcha 100); a record with one
 * reading of the book has one signal, and 日向葵 at 1 chapter would be called a mention.
 *
 * @type {number}
 */
const COVERAGE_SIGNIFICANCE_CHAPTERS = 3;

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
  const rows = ctx.db.prepare("SELECT key, display, aliases, merged_into AS mergedInto FROM cast ORDER BY key").all();
  const out = [];
  // A merged entry is not a character of its own: it is a marked trail saying these two names are one
  // person. Judging it as a second entry would report every merge this store has ever made as the defect
  // the merge was performed to fix.
  const live = rows.filter((row) => !row.mergedInto);

  const byDisplay = new Map();
  for (const row of live) {
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

  for (const row of live) {
    let aliases = [];
    try {
      aliases = JSON.parse(row.aliases || "[]");
    } catch {
      continue;
    }
    for (const alias of aliases) {
      if (alias === row.key) continue;
      const other = ctx.db.prepare("SELECT key, merged_into AS mergedInto FROM cast WHERE key = ?").get(alias);
      if (!other) continue;
      // The alias being its own entry is the defect only while it is an entry in its own right. Once it
      // is marked as merged into this one, that IS the merged state this check asks for.
      if (other.mergedInto === row.key) continue;
      out.push({
        keys: [row.key, alias],
        problem:
          `"${alias}" is listed as an alias of "${row.key}" and is ALSO its own cast entry — ` +
          "the identity was never merged (cast_alias is the verb that merges it).",
      });
    }
  }
  return out;
}

/**
 * Roster entries that are keyed by a bare first-person pronoun and carry claims.
 *
 * Why this is a question the store has to ask. The extraction names a character however the book names
 * them in the passage it is reading, and in a first-person novel that is often just the pronoun: the real
 * volume 01 reading pass wrote `俺（主人公）` for ten claims and `如月雨露（ジョーロ／俺）` for sixteen, and
 * the name door kept the base of each label — so the roster ended up with `俺` (15 claims) beside
 * `如月雨露` (215), and volume 02's copy carries the split forward with 262 claims on the pronoun side.
 *
 * The fold that is supposed to close this cannot see it. `rosterIdentityConflicts` asks whether an entry's
 * **own heading** names another entry's key, and that heading used to come from an authored artifact whose
 * author wrote `### 俺（如月雨露・第二章終盤）` — a heading that names 如月雨露 outright. On the
 * read-then-assemble route the heading is the key, verbatim, so the signal the fold reads no longer exists
 * anywhere in the record. The guard is intact; the fact it was written to notice stopped being written.
 *
 * This is therefore a **report, not a merge**. Deciding that `俺` is 如月雨露 is a decision about a person,
 * and the door for a decision in this layer is `castAlias`, asked by somebody who has read the book. What
 * this adds is that the split is named — with the claim counts on each side — in the report a human reads,
 * instead of surfacing only as a reference whose protagonist is in two places at once.
 *
 * @param {{db: Object, volume: number}} ctx
 * @returns {Array<{key: string, claims: number, establishedVolumes: number[], candidates: string[]}>}
 */
function pronounKeyedRosterEntries(ctx) {
  const out = [];
  for (const row of ctx.db.prepare("SELECT key, display, merged_into AS mergedInto FROM cast ORDER BY key").all()) {
    if (row.mergedInto) continue;
    if (!isBareFirstPersonPronoun(row.key)) continue;
    const claims = ctx.db
      .prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT established_volume) AS vols FROM facts WHERE key = ? AND aspect != 'term_usage' AND status != 'retracted'")
      .get(row.key);
    if (!claims || claims.n === 0) continue;
    // Who else on this roster could be the same person: an entry whose key or alias contains the pronoun
    // as a whole token. Reported as candidates, never acted on.
    /** @type {string[]} */
    const candidates = [];
    for (const other of ctx.db.prepare("SELECT key, display, aliases, merged_into AS mergedInto FROM cast WHERE key != ? ORDER BY key").all(row.key)) {
      if (other.mergedInto) continue;
      let aliases = [];
      try {
        aliases = JSON.parse(other.aliases || "[]");
      } catch {
        aliases = [];
      }
      const tokens = [other.key, other.display, ...aliases].flatMap((label) => spanTokens(String(label || "")));
      if (tokens.includes(row.key)) candidates.push(other.key);
    }
    const vols = ctx.db
      .prepare("SELECT DISTINCT established_volume AS v FROM facts WHERE key = ? AND aspect != 'term_usage' AND status != 'retracted' ORDER BY v")
      .all(row.key)
      .map((r) => r.v);
    out.push({ key: row.key, claims: claims.n, establishedVolumes: vols, candidates });
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
 * The denominator of "named in N of M chapters": how many of this volume's chapter files the
 * presence measurement actually read.
 *
 * Taken from the measurement rather than from the `chapters` table, because the two can differ — a
 * store can hold a chapter list it never searched — and a ratio whose denominator is not the one
 * that was searched is a number that means something else.
 *
 * @param {{db: Object}} ctx
 * @param {number} upTo
 * @returns {number|null} Null when nobody has measured this volume.
 */
function coverageChapterTotal(ctx, upTo) {
  const measured = presenceChapterCount(ctx, Number(upTo));
  if (measured !== null) return measured;
  const row = ctx.db.prepare("SELECT COUNT(*) AS n FROM chapters WHERE volume = ?").get(Number(upTo));
  return row && row.n > 0 ? Number(row.n) : null;
}

/**
 * Characters the cast holds that no character-voice claim covers, each one measured against the
 * volume's own text and against the extraction pass.
 *
 * The roster is the cast; the coverage is the character-voice claims attached to it. A cast entry
 * counts as a failure only when **this volume's own text contains them** and nothing in the
 * reference says anything about them — because a character who has no lines in this volume is
 * supposed to be left alone, and reporting them would train everyone to ignore the finding.
 *
 * "Contains them", and how much, is answered by `presence.js`, which searches the volume's
 * extracted chapter files with the store's own matching rule (verbatim, then the Han-character
 * skeleton) and keeps every place a name occurred. When that measurement has not been taken for
 * this volume the query falls back to the stricter rule — every cast entry with no voice claim is
 * reported, at HIGH — because an unmeasured volume must never read as a volume where nobody
 * appears. The measurement can soften a finding; it can never switch it off.
 *
 * **Severity comes from two independent readings of the source, not from counting one string.**
 * A character with no voice claim is a real loss (HIGH) when at least one holds:
 *
 *   - **the extraction found voice material for them.** The per-chapter extraction and the
 *     reference document are two separate passes over the same book, so "the extractor noticed
 *     them and the reference does not mention them" is a disagreement between two readings — not
 *     the reference being graded against itself. This is volume 01's actual failure, and it stays
 *     HIGH with no exemption.
 *   - **they are named in `COVERAGE_SIGNIFICANCE_CHAPTERS` or more distinct chapters** of this
 *     volume's text. Somebody in three chapters of a ten-chapter book is in the book.
 *
 * Neither signal, and they are a **mention** (MEDIUM): reported, named, with the reason stated, and
 * not something that stops the next volume from being built. A throwaway background character and a
 * pun about a fictional film actor are not damage, and calling them damage is how a check gets
 * ignored.
 *
 * Merged cast entries do not count as characters of their own: their facts were re-pointed to the entry
 * they joined, so the character is covered under the surviving key, and asking about both halves of one
 * person is how a check reports the same character twice. But the *question* is asked about the person,
 * not the spelling: an entry merged into this one is part of this character's presence, both for "are
 * they in this volume at all" and for the chapter count below. A protagonist referred to by a pronoun
 * that the record has folded into his own entry is in every chapter of the book, and a rule that only
 * looked at his surname would report him as barely present.
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
 * like, and the glossary registers the roster without attaching its rows to it. The extraction rows
 * are used on the other side of the rule — as the second signal that decides how serious the gap is
 * — which is not the same as letting them fill the gap.
 *
 * @param {{db: Object}} ctx
 * @param {number} upTo - The store's own volume.
 * @returns {Array<{key: string, display: string, measured: boolean, chapters: number, chapterIds: string[], identityKeys: string[], presenceNames: Array<{name: string, chapters: number, matches: number}>, lines: number, rules: string[], extractionClaims: number, severity: "HIGH"|"MEDIUM", why: string}>}
 */
function uncoveredCharacters(ctx, upTo) {
  const limit = Number(upTo);
  // The question presupposes an answer: it asks what the character-voice reference says about each
  // name on the roster, and a volume whose reference has not been read into the record yet has
  // nothing to ask about. That case is caught by the sealing check, not here.
  if (!documentMirrored(ctx, DOCUMENT_VOICE, limit)) return [];
  const measured = presenceMeasured(ctx, limit);
  // Presence is asked at the level of the *person*, not the spelling. A character whose own key the
  // book never prints, but whose merged-in name it prints constantly, is in the volume; excluding them
  // because the survivor's own row says "not found" is exactly the way this check switches itself off
  // on a first-person book.
  const presenceClause = measured
    ? "AND EXISTS (SELECT 1 FROM cast_presence p WHERE p.volume = ? AND (p.key = c.key OR p.key IN (SELECT key FROM cast WHERE merged_into = c.key)) AND p.present = 1) "
    : "";
  const params = measured ? [limit, limit] : [limit];
  const rows = ctx.db
    .prepare(
      "SELECT c.key AS key, c.display AS display FROM cast c " +
        "WHERE (c.first_seen_volume IS NULL OR c.first_seen_volume <= ?) AND c.merged_into IS NULL " +
        presenceClause +
        "AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.key = c.key AND f.aspect != 'term_usage' " +
        "AND f.source_stage != ?) " +
        "ORDER BY c.first_seen_volume IS NULL, c.first_seen_volume, c.key"
    )
    .all(...params, EXTRACTION_SOURCE_STAGE);

  const chaptersTotal = coverageChapterTotal(ctx, limit);
  const totalLabel = chaptersTotal === null ? "the chapters this volume's extraction names" : String(chaptersTotal);
  const presenceRow = ctx.db.prepare("SELECT chapters, matches FROM cast_presence WHERE volume = ? AND key = ?");
  const rulesRow = ctx.db.prepare("SELECT DISTINCT matched AS matched FROM cast_presence_match WHERE volume = ? AND key = ? ORDER BY matched");
  const chaptersRow = ctx.db.prepare("SELECT DISTINCT chapter AS chapter FROM cast_presence_match WHERE volume = ? AND key = ? ORDER BY chapter");
  const extractionRow = ctx.db.prepare(
    "SELECT COUNT(*) AS n FROM facts WHERE key = ? AND aspect != 'term_usage' AND source_stage = ? AND status <> 'retracted'"
  );
  const mergedIntoRow = ctx.db.prepare("SELECT key FROM cast WHERE merged_into = ? ORDER BY key");

  return rows.map((row) => {
    if (!measured) {
      return {
        key: row.key,
        display: row.display,
        measured: false,
        chapters: 0,
        chapterIds: [],
        lines: 0,
        rules: [],
        extractionClaims: 0,
        severity: "HIGH",
        why: "presence has not been measured for this volume, so the stricter rule applies",
      };
    }
    // The significance question is about the person, so it is answered over every name that person is
    // filed under: the survivor's own key and every entry merged into it. Volume 01 is the case this
    // exists for — 如月雨露's own name is printed 4 times in 10 chapters, while the entry that was his
    // phantom twin, 俺, is printed 789 times across all 10. Counting only the survivor's row would have
    // made the protagonist look like a bit part on the strength of a merge; counting only the pronoun
    // would have made the chapter line measure the narration. So the *count* is the union, and the
    // *evidence* stays attributed to the name that produced it, which is what the report prints.
    const identityKeys = [row.key, ...mergedIntoRow.all(row.key).map((r) => r.key)];
    const presenceNames = identityKeys
      .map((key) => {
        const row2 = presenceRow.get(limit, key) || { chapters: 0, matches: 0 };
        return { name: key, chapters: Number(row2.chapters || 0), matches: Number(row2.matches || 0) };
      })
      .filter((entry) => entry.matches > 0);
    const extractionClaims = Number(extractionRow.get(row.key, EXTRACTION_SOURCE_STAGE).n);
    const chapterIds = [...new Set(identityKeys.flatMap((key) => chaptersRow.all(limit, key).map((r) => r.chapter)))];
    const rules = [...new Set(identityKeys.flatMap((key) => rulesRow.all(limit, key).map((r) => r.matched)))];
    const inChapters = chapterIds.length;
    const lines = identityKeys.reduce((sum, key) => sum + Number((presenceRow.get(limit, key) || { matches: 0 }).matches), 0);
    const significantByChapters = inChapters >= COVERAGE_SIGNIFICANCE_CHAPTERS;
    const significantByExtraction = extractionClaims > 0;

    /**
     * Which spellings produced the chapter count, spelled out whenever there is more than one. A number
     * in a query is not auditable; "10 of 10 chapters — 4 through 如月雨露, 10 through 俺" is, and it is
     * the line that tells a reader whether the character is in the book or the book is in the character.
     */
    const nameBreakdown =
      presenceNames.length > 1
        ? ` (${presenceNames.map((entry) => `${entry.chapters} through ${entry.name}`).join(", ")})`
        : "";

    /** @type {string[]} The signals that hold, in the order the rule states them. */
    const holds = [];
    if (significantByExtraction) holds.push(`the extraction filed ${extractionClaims} claim(s) about them and the reference took none`);
    if (significantByChapters) holds.push(`their name occurs in ${inChapters} of this volume's ${totalLabel} chapters${nameBreakdown}`);
    /** @type {string[]} The signals that do not, which is what a softened finding has to name. */
    const missing = [];
    if (!significantByExtraction) missing.push("the extraction found nothing about them");
    if (!significantByChapters) missing.push(`they occur in ${inChapters} of ${totalLabel} chapters, below the ${COVERAGE_SIGNIFICANCE_CHAPTERS}-chapter line`);

    return {
      key: row.key,
      display: row.display,
      measured: true,
      chapters: inChapters,
      chapterIds,
      identityKeys,
      presenceNames,
      lines,
      rules,
      extractionClaims,
      severity: holds.length > 0 ? "HIGH" : "MEDIUM",
      why: holds.length > 0 ? holds.join("; and ") : `both signals are missing: ${missing.join(", and ")}`,
    };
  });
}

/**
 * The two findings the coverage question produces, one per severity group.
 *
 * Split rather than merged, because the two groups need different things from the reader: the HIGH
 * group is the stop — a reference that lost characters the volume and the extraction both say are
 * there, which is the defect that killed the last run. The MEDIUM group is the price of softening
 * that stop, and it is printed in full: every name, and for each one the signal that was missing.
 * A main character wrongly softened has to be visible to a human reading the report, because a
 * number in a query is not.
 *
 * @param {Object} ctx - The store context, for the roster count.
 * @param {Array<Object>} uncovered - The rows from `uncoveredCharacters`.
 * @param {number} upTo - The volume the roster is counted over.
 * @param {string} step - Finding step name.
 * @param {string|null} volume - Finding volume label.
 * @returns {PostMortemFinding[]}
 */
function coverageFindings(ctx, uncovered, upTo, step, volume) {
  if (uncovered.length === 0) return [];
  const roster = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM cast WHERE (first_seen_volume IS NULL OR first_seen_volume <= ?) AND merged_into IS NULL")
    .get(Number(upTo)).n;
  const significant = uncovered.filter((row) => row.severity === "HIGH");
  const mentions = uncovered.filter((row) => row.severity === "MEDIUM");
  const out = [];

  if (significant.length) {
    const basis = significant[0].measured
      ? `the volume's own text contains them, and they are in the book rather than barely in it`
      : `presence has not been measured for this volume, so every uncovered cast entry is reported`;
    out.push(
      finding(
        "HIGH",
        "reference-voice-covers-fewer-characters",
        step,
        volume,
        "series.db",
        `the cast holds ${roster} character(s) but ${significant.length} of them have no character-voice claim ` +
          `at all, and ${basis}: ${significant.map((row) => `${row.key} — ${row.why}`).join("; ")}. A ` +
          "character-voice reference that covers fewer characters than the roster is a damaged reference, " +
          "and importing it faithfully reproduces the damage."
      )
    );
  }

  if (mentions.length) {
    out.push(
      finding(
        "MEDIUM",
        "reference-voice-mention-not-covered",
        step,
        volume,
        "series.db",
        `${mentions.length} character(s) on the roster have no character-voice claim and are only mentioned in ` +
          `this volume's text, so this is reported and not blocked: ${mentions.map((row) => `${row.key} — ${row.why}`).join("; ")}. ` +
          `The line is ${COVERAGE_SIGNIFICANCE_CHAPTERS} chapters or one claim from the extraction. If either ` +
          "signal is wrong for one of these names — a main character the book happens to name once — the fix is " +
          "to give them an entry, not to move the line."
      )
    );
  }

  return out;
}


/**
 * Which volumes' documents in this record were **rebuilt by code** rather than written by an author.
 *
 * The marker is written by `rebuild.js` and copied forward with the rest of `store_info`, so a rebuilt
 * volume stays identifiable in every later volume's record. This is the question "was this reference
 * read by anyone?" — the store can answer it for provenance, and it cannot answer it for content.
 *
 * @param {{db: Object}} ctx
 * @param {number} upTo - Ask about this volume and every volume at or below it.
 * @returns {Array<{document: string, volume: number, at: string, filed: number, carried: number, refused: number, characters: number, candidatesFiled: number|null, candidatesRefused: number|null}>}
 *   `candidatesFiled` is null for a record built before the rebuild filed candidate copies, which is a
 *   fact the report should be able to tell rather than hide as a zero.
 */
function rebuiltDocuments(ctx, upTo) {
  const limit = Number(upTo);
  const out = [];
  for (const row of ctx.db.prepare("SELECT key, value FROM store_info WHERE key LIKE 'rebuilt_%' ORDER BY key").all()) {
    const match = /^rebuilt_(.+)_(\d+)$/.exec(row.key);
    if (!match) continue;
    const volume = Number(match[2]);
    if (volume > limit) continue;
    let detail = null;
    try {
      detail = JSON.parse(row.value);
    } catch {
      // A marker this layer cannot read is a marker that says nothing, which is worth reporting as
      // "rebuilt, counts unknown" rather than as "not rebuilt": the rows themselves are still there.
      detail = {};
    }
    out.push({
      document: match[1],
      volume,
      at: detail.at || "unknown",
      filed: Number(detail.filed || 0),
      carried: Number(detail.carried || 0),
      refused: Number(detail.refused || 0),
      characters: Number(detail.characters || 0),
      // What the record holds, not what this run added. A marker written before this distinction existed
      // has no such number, so the report falls back to `filed` rather than claiming zero.
      adoptedClaims: Number.isFinite(detail.adoptedClaims) ? Number(detail.adoptedClaims) : null,
      adoptedCharacters: Number.isFinite(detail.adoptedCharacters) ? Number(detail.adoptedCharacters) : null,
      adoptedUnkeyed: Number.isFinite(detail.adoptedUnkeyed) ? Number(detail.adoptedUnkeyed) : null,
      candidateClaims: Number.isFinite(detail.candidateClaims) ? Number(detail.candidateClaims) : null,
      // The candidate copies are part of what the rebuild did: they are the reason a later volume can
      // still ask "what did the extraction find that this reference does not say" about a rebuilt
      // record. A marker written before candidates existed has no such number, which is why these are
      // read as NaN-able rather than defaulted to 0 — the report says nothing about them in that case.
      candidatesFiled: Number.isFinite(detail.candidatesFiled) ? Number(detail.candidatesFiled) : null,
      candidatesRefused: Number.isFinite(detail.candidatesRefused) ? Number(detail.candidatesRefused) : null,
    });
  }
  return out;
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

  // A roster entry keyed by a bare first-person pronoun, reported rather than merged. MEDIUM, and
  // deliberately not HIGH: the claims in it are real and cited, and what is wrong is the name over them.
  // It is also deliberately not a fold — see `pronounKeyedRosterEntries` for why the fold's own signal is
  // gone on the assembled route, and why closing the split by guessing is worse than naming it.
  for (const item of pronounKeyedRosterEntries(ctx)) {
    findings.push(
      finding(
        "MEDIUM",
        "reference-character-keyed-by-a-pronoun",
        step,
        volume,
        "series.db",
        `"${item.key}" is a roster entry with ${item.claims} character-voice claim(s) of its own, established in volume(s) ${item.establishedVolumes.join(", ")}. ` +
          `A pronoun is not a name: the reference's section for this character is headed 「${item.key}」, which tells a translator who is speaking only if they already know. ` +
          (item.candidates.length
            ? `The roster does carry ${item.candidates.join(", ")} — the entry that names the same pronoun in its own label — and the fold that closes a split like this refused to merge them because neither entry's heading names the other as a whole token. `
            : "No other roster entry names this pronoun, so nothing here can say who this is. ") +
          `The door that decides it is cast_alias (or a merge recorded by somebody who read the book), not a rule that picks a person for you.`
      )
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
  // noticing. HIGH for a character the volume's own text and the extraction both say is there:
  // this is the check that turns "the voice reference got smaller" from an observation into a
  // refusal. A character the volume's own text does not contain is not on this list at all: a
  // character with no lines in the volume is supposed to be left alone. A character who IS in the
  // text but only barely, and about whom the extraction says nothing either, is reported by name at
  // MEDIUM — see `COVERAGE_SIGNIFICANCE_CHAPTERS` for how that line was drawn and what it cannot
  // see.
  const uncovered = uncoveredCharacters(ctx, limit);
  findings.push(...coverageFindings(ctx, uncovered, limit, step, volume));

  const rebuiltDocs = rebuiltDocuments(ctx, limit);
  // How the reference got here. MEDIUM, deliberately: a reference rebuilt from a volume's extraction
  // output is not damage — every bullet in it cites a line of the volume's text, which is more than
  // volume 01's destroyed file could say — and a HIGH finding would stop the next volume's copy-forward
  // over a provenance fact rather than a defect. It is also not silence: it fires on every audit of a
  // record that carries rebuild rows, it names the counts, and it says what would replace it (an author
  // pass over the rebuilt file). The damage check above still runs against a rebuilt reference, at HIGH,
  // unchanged: rebuilding does not buy a reference out of covering the cast.
  for (const rebuilt of rebuiltDocs) {
    const counts = rebuildProvenanceCounts(rebuilt);
    findings.push(
      finding(
        "MEDIUM",
        "reference-document-rebuilt-from-extraction",
        step,
        volume,
        `${rebuilt.document}.md`,
        `volume ${rebuilt.volume}'s ${rebuilt.document} reference was rebuilt by code from that volume's ` +
          `extraction output on ${rebuilt.at}: ${counts.claims} claim(s) adopted about ${counts.characters} ` +
          `character(s), ${counts.refused} refused` +
          (counts.unkeyed ? `, ${counts.unkeyed} claim(s) with no character to file them under` : "") +
          ". No author agent wrote it and nobody has " +
          "reviewed it. Every bullet cites a line of that volume's text, and the coverage question is asked of " +
          "it like any other reference — but a reference nobody read is a reference nobody checked." +
          (counts.candidates !== null
            ? ` The record also keeps ${counts.candidates} candidate copy(ies) of those claims — the ` +
              "extraction's own reading beside the document's — so \"what did the extraction find that this " +
              "reference does not say\" is a query here, not an assumption."
            : "")
      )
    );
  }

  return {
    ok: !findings.some((f) => f.severity === "HIGH"),
    findings,
    counts,
    checked: evidenceCheck.checked,
    coverageAsked: documentMirrored(ctx, DOCUMENT_VOICE, limit),
    coverage: {
      asked: documentMirrored(ctx, DOCUMENT_VOICE, limit),
      chapters: coverageChapterTotal(ctx, limit),
      measured: presenceMeasured(ctx, limit),
      significanceChapters: COVERAGE_SIGNIFICANCE_CHAPTERS,
      rows: uncovered,
    },
    rebuilt: rebuiltDocs,
  };
}

module.exports = {
  INTEGRITY_STEP,
  COVERAGE_SIGNIFICANCE_CHAPTERS,
  factsWithoutEvidence,
  impossibleProvenance,
  splitCharacters,
  brokenSupersession,
  unsealedVolumes,
  unclassifiedFacts,
  uncoveredCharacters,
  coverageFindings,
  pronounKeyedRosterEntries,
  rebuiltDocuments,
  integrityFindings,
};

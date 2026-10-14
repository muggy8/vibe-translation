/**
 * utils/reference-store/integrity/coverage.js — the coverage measurement: which characters
 * the roster holds that no character-voice claim covers, and how much of the volume they are in.
 *
 * This is the guard with the pinned constant. `COVERAGE_SIGNIFICANCE_CHAPTERS` is the line
 * between a **loss** and a **mention**, and the measurement returns every uncovered cast entry
 * with both of its signals already computed so the report can name which one was missing.
 * Turning the rows into findings is a different job and lives in `coverage-report.js`.
 *
 * @module utils/reference-store/integrity/coverage
 */

const { EXTRACTION_SOURCE_STAGE } = require("../schema");
const { presenceMeasured, presenceChapterCount } = require("../presence");
const { documentMirrored, DOCUMENT_VOICE } = require("../document-prose");

require("../../../types"); // JSDoc type definitions

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

module.exports = {
  COVERAGE_SIGNIFICANCE_CHAPTERS,
  coverageChapterTotal,
  uncoveredCharacters,
};

/**
 * utils/reference-store/chapter-facts.js — which of the record's current claims belong to the
 * characters **one chapter's text actually names**.
 *
 * This is the read side the character-voice stage's chapter calls needed. Until this module existed
 * the voice reading pass was handed the previous volume's published `character-voice.md` and shown it
 * to every chapter of every later volume. That document is a **render**: it is the record as it looked
 * when the earlier volume was published, it grows with everything ever learned about the cast, and the
 * only bound on it was a section-count cap the roster never reaches (plan 06 §2.6 / §7 — measured: a
 * 196-section reference came back at 196 sections, 351,771 bytes in and 351,771 bytes out). The
 * glossary's read pass stopped doing this years ago: its record carries the accumulation, so the model
 * sees the chapter and nothing else. This module is the same door on the voice side — **a query, not a
 * document**.
 *
 * Three rules decide its shape:
 *
 *   - **The record is the source, not the render.** A claim the record has replaced
 *     (`currentClaimSql` — superseded by a live row, retracted, or the challenger side of an open
 *     dispute) does not reach the chapter, whatever the published file on disk still prints. The plan
 *     states the defect outright: a chapter cannot be asked "does this confirm or contradict what we
 *     already know?" while being shown a file that may still assert what the record has replaced.
 *   - **"Which characters" is measured, not guessed.** The chapter's own text is searched with the
 *     store's one name rule — `presence.js`'s search names and `evidence.js`'s verbatim-then-Han-skeleton
 *     match — which is the same rule the coverage audit runs. A character the matcher cannot see is a
 *     character whose claims are not shown, and that is reported as a count rather than hidden.
 *   - **Everything is capped, and every cap says it fired.** A section count that never bites is how
 *     the old bound failed; these caps are a character count, a per-character claim count, and a
 *     volume-span rule, and each one returns the number it dropped.
 *
 * What it deliberately does **not** do: it does not group roster entries by identity. The identity
 * tables are not read here, in this module or through any door that reaches it — plan 06 §10.8, pinned
 * by `test/test-identity-table-isolation.js`. Rendering per identity is slice 8.
 *
 * @module utils/reference-store/chapter-facts
 */

const { namesForEntry } = require("./presence");
const { prepareLineForQuoteSearch, prepareQuoteForSearch, matchPreparedLine } = require("./evidence");
const { currentClaimSql } = require("./facts");
const { EXTRACTION_SOURCE_STAGE } = require("./schema");
const { refusal } = require("./refusals");
require("../../types"); // JSDoc type definitions

/**
 * The bounds on one chapter's answer.
 *
 * Constants, with no environment knob (AGENTS.md rule 3): the defect this module replaces was a bound
 * that could not bite, and a bound an operator can raise is the same defect with a settings file.
 *
 *   - `maxCharacters` — how many roster entries one chapter is asked about at all. Ranked by how much
 *     of the chapter's text names them, so the cap drops the least-present characters first.
 *   - `maxClaimsPerCharacter` — how many of one character's current claims one chapter is shown. The
 *     **most recent** ones survive, printed in the order they were established, because the question the
 *     chapter is being asked is "does this still hold?" and the answer it needs is the one the record
 *     stands behind now.
 *
 * Measured against the fixture this slice builds (`test/test-voice-readpass-query.js`): a 196-entry
 * roster, a chapter naming 12 of them, 3 claims each — the caps fire on **0** of them. They exist for
 * the volume where they would.
 *
 * @type {{maxCharacters: number, maxClaimsPerCharacter: number}}
 */
const CHAPTER_FACT_LIMITS = {
  maxCharacters: 80,
  maxClaimsPerCharacter: 8,
};

/**
 * The cast rows this query works over, and who is folded into whom.
 *
 * `cast_merges` / `cast.merged_into` is the record's own statement that two roster entries are one
 * person. It is used here for exactly one thing: **which claims to show**. A merged entry's occurrences
 * are still recorded under its own key by `presence.js` (so a pronoun's 951 matches never become the
 * protagonist's evidence), and no row is moved, re-keyed or merged by anything in this module.
 *
 * @param {{db: Object}} ctx
 * @returns {{entries: Array<{key: string, display: string, aliases: string, mergedInto: string|null}>, mergedBy: Map<string, Array<Object>>, mergedKeys: Set<string>}}
 */
function rosterForChapterQuery(ctx) {
  const rows = ctx.db
    .prepare("SELECT key, display, aliases, merged_into AS mergedInto FROM cast ORDER BY key")
    .all();
  /** @type {Map<string, Array<Object>}} */
  const mergedBy = new Map();
  /** @type {Set<string>} */
  const mergedKeys = new Set();
  for (const row of rows) {
    if (!row.mergedInto) continue;
    mergedKeys.add(row.mergedInto === row.key ? "" : row.mergedInto);
    if (!mergedBy.has(row.mergedInto)) mergedBy.set(row.mergedInto, []);
    mergedBy.get(row.mergedInto).push(row);
  }
  mergedKeys.delete("");
  return {
    entries: rows.filter((row) => !row.mergedInto),
    mergedBy,
    mergedKeys,
  };
}

/**
 * The names one person is searched for: their own roster entry's key and declared aliases, plus the
 * names of every roster entry the record says is the same person.
 *
 * The union is the same one the coverage rule uses ("7 through 如月雨露, 7 through 俺"), and for the
 * same reason: a chapter that prints only the folded spelling is a chapter that contains the person, and
 * a query that showed them nothing would ask it to rediscover them.
 *
 * @param {Object} entry - One unmerged cast row.
 * @param {Array<Object>} [merged] - The roster entries merged into this one.
 * @param {Set<string>} [mergedKeys] - Keys that are themselves merged entries; not search names for their survivor.
 * @returns {Array<{name: string, prepared: Object}>}
 */
function searchNamesForPerson(entry, merged = [], mergedKeys = new Set()) {
  const names = namesForEntry(entry, mergedKeys);
  for (const other of merged) names.push(...namesForEntry(other, mergedKeys));
  const seen = new Set();
  const out = [];
  for (const name of names) {
    if (seen.has(name.name)) continue;
    seen.add(name.name);
    out.push(name);
  }
  return out;
}

/**
 * Which roster entries one chapter's text names, measured with the store's own matching rule.
 *
 * Verbatim first, then the Han-character skeleton with its minimum-length guard — the rule
 * `evidence.js` runs for a citation and `presence.js` runs for a volume, reused rather than copied so
 * this query and the audit cannot disagree about who is on the page.
 *
 * @param {{db: Object}} ctx
 * @param {string} chapterText - The chapter's own source text.
 * @param {{roster?: ReturnType<typeof rosterForChapterQuery>}} [opts] - A roster already read, so a caller walking a whole volume reads it once.
 * @returns {{rosterTotal: number, named: Array<{key: string, display: string, matches: number, through: Array<{name: string, matches: number, matched: string}>}>}}
 */
function castNamedInChapterText(ctx, chapterText, { roster } = {}) {
  const cast = roster || rosterForChapterQuery(ctx);
  const lines = String(chapterText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line)
    .map(prepareLineForQuoteSearch);

  /** @type {Array<{key: string, display: string, matches: number, through: Array<{name: string, matches: number, matched: string}>}>} */
  const named = [];
  for (const entry of cast.entries) {
    const names = searchNamesForPerson(entry, cast.mergedBy.get(entry.key) || [], cast.mergedKeys);
    /** @type {Array<{name: string, matches: number, matched: string}>} */
    const through = [];
    let total = 0;
    for (const { name, prepared } of names) {
      let hits = 0;
      let matched = null;
      for (const preparedLine of lines) {
        const rule = matchPreparedLine(preparedLine, prepared);
        if (!rule) continue;
        hits += 1;
        if (!matched) matched = rule;
      }
      if (!hits) continue;
      through.push({ name, matches: hits, matched });
      total += hits;
    }
    if (!total) continue;
    through.sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name, "en"));
    named.push({ key: entry.key, display: entry.display || entry.key, matches: total, through });
  }
  named.sort((a, b) => b.matches - a.matches || a.key.localeCompare(b.key, "en"));
  return { rosterTotal: cast.entries.length, named };
}

/**
 * Every row the record holds about the named characters, current and not, in filing order.
 *
 * Split out so the answer can say **why** a claim is missing: replaced, out of span, or cut by the cap
 * are three different facts, and "not shown" without a number behind it is the silence this slice
 * exists to remove.
 *
 * @param {{db: Object}} ctx
 * @param {string[]} keys - The roster entries this chapter names.
 * @param {number} volume - The volume being read: the span is judged **as of this volume** (plan 06 §6).
 * @returns {Array<Object>} Rows with `isCurrent` and `inSpan` stamped on them.
 */
function rowsForNamedCharacters(ctx, keys, volume) {
  if (!keys.length) return [];
  const placeholders = keys.map(() => "?").join(", ");
  const current = currentClaimSql("f");
  const vol = Number(volume);
  return ctx.db
    .prepare(
      "SELECT f.id, f.key, f.aspect, f.label, f.body, f.examples, f.axis, f.axis_value, f.status, " +
        "f.established_volume, f.established_chapter, f.owner_volume, f.source_stage, " +
        `f.applies_from_volume AS appliesFrom, f.applies_to_volume AS appliesTo, ` +
        `(${current}) AS isCurrent, ` +
        "(f.applies_from_volume <= ? AND (f.applies_to_volume IS NULL OR f.applies_to_volume >= ?)) AS inSpan " +
        `FROM facts f WHERE f.key IN (${placeholders}) AND f.source_stage != ? ` +
        "ORDER BY f.established_volume, f.ord, f.id"
    )
    .all(vol, vol, ...keys, EXTRACTION_SOURCE_STAGE);
}

/**
 * The record's current claims for the characters one chapter's text names.
 *
 * The whole answer, with every count that explains what it left out:
 *
 *   - `claimsHeld` — every row the record holds about those characters (the extraction candidates
 *     excluded: those are the reading pass's own copies, not published content, and the renderers
 *     exclude them for the same reason — `voice-adapter.js`'s guard, untouched here);
 *   - `claimsReplaced` — rows `currentClaimSql` refused: superseded, retracted, or the open-dispute
 *     challenger;
 *   - `claimsOutOfSpan` — current claims whose validity span does not include this volume;
 *   - `claimsCapped` — current, in-span claims dropped by `maxClaimsPerCharacter`;
 *   - `charactersNotShown` — named entries dropped by `maxCharacters`.
 *
 * @param {{db: Object, volume: number}} ctx
 * @param {{chapterText: string, volume?: number, limits?: {maxCharacters?: number, maxClaimsPerCharacter?: number}}} opts
 * @returns {{ok: boolean, refusal: ReferenceRefusal|null, volume: number, rosterTotal: number, namedCount: number, characters: Array<Object>, claimsHeld: number, claimsCurrent: number, claimsReplaced: number, claimsOutOfSpan: number, claimsCapped: number, claimsShown: number, charactersNotShown: number, limits: Object}}
 */
function chapterKnownFacts(ctx, { chapterText, volume, limits } = {}) {
  if (!ctx || !ctx.db) {
    return {
      ok: false,
      refusal: refusal({
        verb: "chapter_known_facts",
        rule: "no-reference-record",
        because:
          "this chapter has no reference record to ask. The record is where the earlier volumes' claims " +
          "are carried forward, so a chapter read without one is being asked what is new with nothing to " +
          "compare it against.",
        fix: "open the volume's record first (openVolumeRecord / openReferenceStore) — the same door the stage and extract-voice.js already open.",
      }),
      volume: 0, rosterTotal: 0, namedCount: 0, characters: [], claimsHeld: 0, claimsCurrent: 0,
      claimsReplaced: 0, claimsOutOfSpan: 0, claimsCapped: 0, claimsShown: 0, charactersNotShown: 0,
      limits: { ...CHAPTER_FACT_LIMITS, ...(limits || {}) },
    };
  }
  if (typeof chapterText !== "string" || !chapterText.trim()) {
    return {
      ok: false,
      refusal: refusal({
        verb: "chapter_known_facts",
        rule: "chapter-source-missing",
        because: "this chapter's own text could not be read, and the question 'which characters are in this chapter' is answered from that text and nothing else.",
        fix: "resolve the volume's source bundle first (the same source the evidence rule reads).",
      }),
      volume: 0, rosterTotal: 0, namedCount: 0, characters: [], claimsHeld: 0, claimsCurrent: 0,
      claimsReplaced: 0, claimsOutOfSpan: 0, claimsCapped: 0, claimsShown: 0, charactersNotShown: 0,
      limits: { ...CHAPTER_FACT_LIMITS, ...(limits || {}) },
    };
  }

  const cap = { ...CHAPTER_FACT_LIMITS, ...(limits || {}) };
  const vol = Number(volume === undefined ? ctx.volume : volume);
  const roster = rosterForChapterQuery(ctx);
  const measured = castNamedInChapterText(ctx, chapterText, { roster });

  const shown = measured.named.slice(0, cap.maxCharacters);
  const rows = rowsForNamedCharacters(ctx, shown.map((entry) => entry.key), vol);

  /** @type {Map<string, Array<Object>>} */
  const byKey = new Map();
  let claimsHeld = 0;
  let claimsCurrent = 0;
  let claimsReplaced = 0;
  let claimsOutOfSpan = 0;
  for (const row of rows) {
    claimsHeld += 1;
    if (!row.isCurrent) {
      claimsReplaced += 1;
      continue;
    }
    if (!row.inSpan) {
      claimsOutOfSpan += 1;
      continue;
    }
    claimsCurrent += 1;
    if (!byKey.has(row.key)) byKey.set(row.key, []);
    byKey.get(row.key).push(row);
  }

  let claimsCapped = 0;
  let claimsShown = 0;
  /** @type {Array<Object>} */
  const characters = [];
  for (const entry of shown) {
    const held = byKey.get(entry.key) || [];
    // The most recent claims survive the cap, printed in the order they were established.
    const dropped = Math.max(0, held.length - cap.maxClaimsPerCharacter);
    const kept = held.slice(dropped);
    claimsCapped += dropped;
    claimsShown += kept.length;
    characters.push({
      key: entry.key,
      display: entry.display,
      matches: entry.matches,
      through: entry.through,
      claimsHeld: held.length,
      claimsShown: kept.length,
      claimsCapped: dropped,
      claims: kept,
    });
  }

  return {
    ok: true,
    refusal: null,
    volume: vol,
    rosterTotal: measured.rosterTotal,
    namedCount: measured.named.length,
    characters,
    claimsHeld,
    claimsCurrent,
    claimsReplaced,
    claimsOutOfSpan,
    claimsCapped,
    claimsShown,
    charactersNotShown: Math.max(0, measured.named.length - shown.length),
    limits: cap,
  };
}

module.exports = {
  CHAPTER_FACT_LIMITS,
  rosterForChapterQuery,
  searchNamesForPerson,
  castNamedInChapterText,
  rowsForNamedCharacters,
  chapterKnownFacts,
};

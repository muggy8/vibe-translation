/**
 * utils/reference-store/evidence.js — the rule the whole design rests on.
 *
 * Doc 04 §7.1 states it plainly: because the store keeps **no interpretation** about a
 * character, only what changed and when, **the dates are the only thing carrying the
 * meaning** — which makes "a fact is refused unless its quoted evidence really occurs at
 * the cited chapter and line" the most important rule in the design rather than a nice
 * guard. Doc 03 §3.4 names the failure it prevents: *systematic mis-dating of quirks
 * across chapters*, where a claim about chapter 3 quotes a line from chapter 7.
 *
 * It is a **hard refusal at insert**, not a warning, and it has no env knob (AGENTS.md
 * rule 3). A fact that cannot be checked against the book does not enter the store.
 *
 * What "occurs at the cited line" means here, and why it is written this way:
 *   - comparison ignores whitespace (`\s+` removed from both sides). Japanese prose puts
 *     no spaces inside a quoted phrase, and a Markdown-rendered quote may gain one;
 *   - the quote must be found **on the cited line**, not merely somewhere in the chapter.
 *     "It is in chapter 3 somewhere" is exactly the claim that lets a quirk be attached to
 *     the wrong chapter;
 *   - when it is not on that line, the refusal says where it actually is — the chapter and
 *     line number, or "not in this chapter at all, but it is in chapter 7 line 214", which
 *     is the sentence that turns a refusal into a corrected insert.
 *   - **a quote that does not match verbatim is tried a second way, and the store records
 *     which way matched.** The book prints 如月きさらぎ雨あま露つゆ and a glossary row says
 *     如月雨露: neither string contains the other, because the reading aids are written
 *     BETWEEN the characters. The answer is the Han-character skeleton comparison
 *     `glossary/carry-forward/table.js` already uses for the carry-forward gate (gotcha 59) —
 *     reused rather than reimplemented, with its minimum-length guard, because a two-kanji
 *     skeleton is two common kanji sitting next to each other and coincidence is not evidence.
 *     Each evidence item then carries `matched: "verbatim" | "skeleton"` so an auditor can
 *     tell "the book prints this string" from "the book prints these characters in this
 *     order" (review 05 §3.1).
 *
 * Symmetry is a requirement, not a nicety (review 05 §2.5): `verifyStoredEvidence` — the
 * re-check copy-forward runs before a volume's file may become the next volume's starting
 * point — goes through this same function. A rule adopted at import but not at re-verification
 * reports every furiganed row as a HIGH finding the second time the store is looked at.
 *
 * @module utils/reference-store/evidence
 */

const { listVolumeChapters, readChapterLines } = require("./source-chapters");
// The skeleton rule is the one the carry-forward gate already uses (gotcha 59), reused so this
// repository has exactly one rule that decides whether two furiganed spellings are the same
// term. `glossary/carry-forward/table.js` is a pure leaf — it requires nothing — so reaching it
// from `utils/` closes no require cycle (gotcha 85).
const { glossaryTermSkeleton, GLOSSARY_SKELETON_MIN_CHARS } = require("../../glossary/carry-forward/table");
const { EVIDENCE_KINDS, EVIDENCE_MATCHES } = require("./schema");
require("../../types"); // JSDoc type definitions

/** How many places a search will report before it says "and more". */
const LOCATIONS_TO_REPORT = 3;

/**
 * A quote compared without whitespace, so a line that wraps a phrase differently is still
 * the same phrase.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeQuote(text) {
  return String(text === undefined || text === null ? "" : text).replace(/\s+/g, "");
}

/**
 * The Han characters of a string, in order — the form in which two furiganed spellings of one
 * term are the same string. A thin alias over the carry-forward gate's own helper, so the two
 * layers cannot drift into two different definitions of "the same term".
 *
 * @param {string} text
 * @returns {string} "" for a string with no Han characters (a pure-kana term has no skeleton).
 */
function quoteSkeleton(text) {
  return glossaryTermSkeleton(text);
}

/**
 * Whether one quote matches one source line, and BY WHICH RULE.
 *
 * Verbatim first, always: it is the stronger claim and the cheaper test. The skeleton rule
 * only runs on a skeleton long enough to mean something — `GLOSSARY_SKELETON_MIN_CHARS`, the
 * carry-forward gate's guard, carried over deliberately (review 05 §3.1 condition 1).
 *
 * @param {string} line - One physical line of the chapter's source text.
 * @param {string} quote - The quoted evidence.
 * @returns {"verbatim"|"skeleton"|null} How it matched, or null when it did not.
 */
function matchQuoteOnLine(line, quote) {
  const needle = normalizeQuote(quote);
  if (!needle) return null;
  if (normalizeQuote(line).includes(needle)) return "verbatim";
  const skeleton = quoteSkeleton(quote);
  if (skeleton.length < GLOSSARY_SKELETON_MIN_CHARS) return null;
  if (quoteSkeleton(line).includes(skeleton)) return "skeleton";
  return null;
}

/**
 * Whether an evidence item is shaped like one.
 *
 * @param {Object} item
 * @returns {{ok: boolean, problem: string|null}}
 */
function evidenceShape(item) {
  if (!item || typeof item !== "object") return { ok: false, problem: "an evidence item must be an object" };
  if (!Number.isInteger(item.volume) || item.volume < 1) {
    return { ok: false, problem: `evidence volume must be a positive integer, got ${JSON.stringify(item.volume)}` };
  }
  if (typeof item.chapter !== "string" || !item.chapter.trim()) {
    return { ok: false, problem: `evidence chapter must be a chapter id, got ${JSON.stringify(item.chapter)}` };
  }
  if (!Number.isInteger(item.line) || item.line < 1) {
    return { ok: false, problem: `evidence line must be a 1-based line number, got ${JSON.stringify(item.line)}` };
  }
  if (typeof item.quote !== "string" || normalizeQuote(item.quote) === "") {
    return { ok: false, problem: "evidence quote must be a non-empty string copied from the source" };
  }
  // `kind` is optional and defaults to `quote`, because most citations are quotes. When it is
  // present it must be one of the two kinds — and BOTH kinds cite a real line (review 05 §3.6):
  // this store has no citation shape that asks to be taken on trust.
  if (item.kind !== undefined && !EVIDENCE_KINDS.includes(item.kind)) {
    return {
      ok: false,
      problem: `evidence kind must be one of: ${EVIDENCE_KINDS.join(", ")} (got ${JSON.stringify(item.kind)})`,
    };
  }
  if (item.matched !== undefined && !EVIDENCE_MATCHES.includes(item.matched)) {
    return {
      ok: false,
      problem: `evidence matched must be one of: ${EVIDENCE_MATCHES.join(", ")} (got ${JSON.stringify(item.matched)})`,
    };
  }
  return { ok: true, problem: null };
}

/**
 * Find every place a quote occurs in a volume, chapter by chapter.
 *
 * Used for the useful half of the refusal: not just "no", but "it is over HERE".
 *
 * @param {string} volumeDir - Absolute volume folder.
 * @param {Array<{id: string, file: string}>} chapters - The volume's chapter list.
 * @param {string} quote - The quoted text.
 * @param {{limit?: number}} [opts]
 * @returns {Array<{chapter: string, line: number, matched: "verbatim"|"skeleton"}>} Occurrences, capped.
 */
function locateQuote(volumeDir, chapters, quote, { limit = LOCATIONS_TO_REPORT } = {}) {
  if (!normalizeQuote(quote)) return [];
  const found = [];
  for (const chapter of chapters) {
    if (!chapter.file) continue;
    const lines = readChapterLines(volumeDir, chapter.file);
    if (!lines) continue;
    for (let i = 0; i < lines.length; i += 1) {
      const matched = matchQuoteOnLine(lines[i], quote);
      if (!matched) continue;
      found.push({ chapter: chapter.id, line: i + 1, matched });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/**
 * Verify one evidence item against the source.
 *
 * @param {Object} item - `{volume, chapter, line, quote}`.
 * @param {(volume: number) => {volumeDir: string|null, chapters: Array<{id: string, file: string}>, error: string|null}} resolveVolume
 *   Turns a volume number into that volume's folder and chapter list. Supplied by the
 *   store, which knows which volumes this file is allowed to look at.
 * @returns {{ok: boolean, item: Object, problem: string|null, found: Array<{chapter: string, line: number}>}}
 */
function verifyEvidenceItem(item, resolveVolume) {
  const shape = evidenceShape(item);
  if (!shape.ok) {
    return { ok: false, item, problem: shape.problem, found: [] };
  }

  const resolved = resolveVolume(item.volume);
  if (!resolved || resolved.error || !resolved.volumeDir) {
    return {
      ok: false,
      item,
      problem:
        `volume ${item.volume}'s source text is not available to this store` +
        (resolved && resolved.error ? `: ${resolved.error}` : ""),
      found: [],
    };
  }

  const chapter = resolved.chapters.find((c) => c.id === item.chapter);
  if (!chapter) {
    const known = resolved.chapters.map((c) => c.id).join(", ") || "(none)";
    return {
      ok: false,
      item,
      problem:
        `volume ${item.volume} has no chapter "${item.chapter}". ` +
        `The chapters this volume's extraction names are: ${known}.`,
      found: [],
    };
  }

  const lines = readChapterLines(resolved.volumeDir, chapter.file);
  if (!lines) {
    return {
      ok: false,
      item,
      problem: `volume ${item.volume} chapter ${item.chapter}: the chapter file "${chapter.file}" could not be read.`,
      found: [],
    };
  }

  if (item.line > lines.length) {
    return {
      ok: false,
      item,
      problem:
        `volume ${item.volume} chapter ${item.chapter} has ${lines.length} lines; the evidence cites line ${item.line}.`,
      found: locateQuote(resolved.volumeDir, resolved.chapters, item.quote),
    };
  }

  const matched = matchQuoteOnLine(lines[item.line - 1], item.quote);
  if (matched) {
    // The item is returned stamped with what the store actually checked. `insertFact` stores
    // these items verbatim, and `verifyStoredEvidence` re-reads them through this same
    // function — so the rule that let a row in is the rule that keeps it in (review 05 §2.5).
    const stamped = { ...item, kind: item.kind || "quote", matched };
    return { ok: true, item: stamped, problem: null, found: [{ chapter: item.chapter, line: item.line, matched }] };
  }

  // Not on the cited line. Say where it is, because "wrong line" and "wrong chapter"
  // need different fixes and both are answered by the number.
  const found = locateQuote(resolved.volumeDir, resolved.chapters, item.quote);
  const where = found.length
    ? found.map((f) => `volume ${item.volume} chapter ${f.chapter} line ${f.line} (${f.matched})`).join(", ")
    : "it does not occur anywhere in this volume's source text, verbatim or by Han-character skeleton";
  return {
    ok: false,
    item,
    problem:
      `volume ${item.volume} chapter ${item.chapter} line ${item.line} does not contain the quoted evidence. ` +
      `That line reads: ${JSON.stringify(String(lines[item.line - 1]).slice(0, 120))}. ` +
      `The quote is at: ${where}.`,
    found,
  };
}

/**
 * Verify a whole evidence list.
 *
 * At least one item is required (doc 03 §2: `evidence … at least one, required`), and
 * every item must verify — a fact with one true quote and one invented one is a fact with
 * an invented quote.
 *
 * @param {Array<Object>} items
 * @param {Function} resolveVolume - see `verifyEvidenceItem`.
 * @returns {{ok: boolean, items: Array<Object>, problems: Array<{index: number, item: Object, problem: string, found: Array}>}}
 */
function verifyEvidence(items, resolveVolume) {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      ok: false,
      items: [],
      problems: [
        {
          index: -1,
          item: null,
          problem:
            "a fact requires at least one evidence item: {volume, chapter, line, quote, kind?}, where the quote is " +
            "text copied from that chapter's source and kind is \"quote\" (the book prints this string) or \"governs\" " +
            "(this row is the decision made about this passage). A fact with no evidence is not stored.",
          found: [],
        },
      ],
    };
  }
  const problems = [];
  const checked = [];
  items.forEach((item, index) => {
    const result = verifyEvidenceItem(item, resolveVolume);
    checked.push(result.item);
    if (!result.ok) {
      problems.push({ index, item: result.item, problem: result.problem, found: result.found });
    }
  });
  return { ok: problems.length === 0, items: checked, problems };
}

/**
 * Re-verify every fact already in a store against the source it cites.
 *
 * This is the copy-forward half of the rule (doc 03 §5, first row): a volume whose facts
 * no longer match their citations does not get to infect the next volume.
 *
 * @param {Array<{id: string, evidence: string}>} facts - Rows with their JSON evidence column.
 * @param {Function} resolveVolume
 * @returns {{ok: boolean, checked: number, failures: Array<{id: string, problem: string}>}}
 */
function verifyStoredEvidence(facts, resolveVolume) {
  const failures = [];
  let checked = 0;
  for (const fact of facts) {
    let items;
    try {
      items = JSON.parse(fact.evidence);
    } catch {
      failures.push({ id: fact.id, problem: "the evidence column is not valid JSON" });
      continue;
    }
    const result = verifyEvidence(items, resolveVolume);
    checked += 1;
    if (!result.ok) {
      failures.push({ id: fact.id, problem: result.problems.map((p) => p.problem).join(" ") });
    }
  }
  return { ok: failures.length === 0, checked, failures };
}

module.exports = {
  normalizeQuote,
  quoteSkeleton,
  matchQuoteOnLine,
  evidenceShape,
  locateQuote,
  verifyEvidenceItem,
  verifyEvidence,
  verifyStoredEvidence,
};

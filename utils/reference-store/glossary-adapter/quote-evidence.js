/**
 * utils/reference-store/glossary-adapter/quote-evidence.js — finding a row's evidence in the
 * volume's own book, and citing the line it was found on.
 *
 * Two stages, in this order: **`quote`** — one of the row's own spellings, or its rendering, occurs
 * in the volume's source text; **`governs`** — the row's notes quote a passage that IS in the source
 * text. A row that can support neither is refused and reported: the store has no path for a claim
 * nobody can check. The line number is DISCOVERED, not claimed, which is what makes an imported
 * row's evidence verify by construction. `findQuoteEvidence` is the narrower, stricter half the
 * revision door asks — the line the answer quoted, in THIS volume's text.
 *
 * Named for what it does, so it is never confused with `utils/reference-store/evidence.js`, the
 * store's own citation verifier this layer calls rather than replaces.
 *
 * @module utils/reference-store/glossary-adapter/quote-evidence
 */

const { normalizeQuote, matchQuoteOnLine } = require("../evidence");
const { hasRubyMarkup } = require("../ruby-markup");
const { readChapterLines } = require("../source-chapters");
const { glossaryTermSpans } = require("./parse");
require("../../../types"); // JSDoc type definitions

/** How many quoted spans the importer will try before it gives up on a row. */
const QUOTE_CANDIDATES_PER_ROW = 4;

/** A span this short is not a passage, it is a word; `governs` cites passages. */
const GOVERNS_MIN_SPAN_CHARS = 4;

/**
 * The passages a row's own notes quote — the candidates for `governs` evidence (review 05 §3.6).
 *
 * A glossary row's notes quote the book constantly (`三つ編み魔王のパンジー 3559`,
 * `"もう、『僕』の出番はおしまいだ"`), and those quotations name the passage the row is the
 * decision about. They are not the row's term, so they cannot support a `quote` claim — the
 * book does not print the term — but they do support the weaker, honest one: this row is about
 * a passage that is really there, at this line.
 *
 * Only spans that look like prose survive: something in quotes or brackets, at least
 * `GOVERNS_MIN_SPAN_CHARS` once whitespace is removed, and containing at least one CJK
 * character. A four-letter English fragment in a note is a translation choice, not a passage.
 *
 * @param {string} notes - One row's notes cell.
 * @returns {string[]} Candidate spans, longest first.
 */
function noteQuotedSpans(notes) {
  const text = String(notes || "");
  const spans = new Set();
  const patterns = [/「([^」]+)」/g, /『([^』]+)』/g, /[“"]([^“"]{4,})[”"]/g, /[（(]([^（）()]{4,})[）)]/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const span = String(match[1] || "").trim();
      if (normalizeQuote(span).length < GOVERNS_MIN_SPAN_CHARS) continue;
      if (!/[぀-ヿ一-鿿가-힯]/.test(span)) continue;
      spans.add(span);
    }
  }
  return [...spans].sort((a, b) => b.length - a.length);
}

/**
 * Search the volume's chapters for the first of several spans, and cite the line it was found on.
 *
 * @param {string} volumeDir
 * @param {Array<{id: string, file: string}>} chapters
 * @param {number} volume
 * @param {string[]} spans
 * @param {"quote"|"governs"} kind
 * @returns {{evidence: Array<Object>, matched: "verbatim"|"skeleton", span: string}|null}
 */
function searchSpans(volumeDir, chapters, volume, spans, kind) {
  for (const span of spans) {
    if (!normalizeQuote(span)) continue;
    for (const chapter of chapters) {
      if (!chapter.file) continue;
      const lines = readChapterLines(volumeDir, chapter.file);
      if (!lines) continue;
      for (let i = 0; i < lines.length; i += 1) {
        const matched = matchQuoteOnLine(lines[i], span);
        if (!matched) continue;
        return {
          evidence: [{ volume, chapter: chapter.id, line: i + 1, quote: span, kind, matched }],
          matched,
          span,
          markupStripped: hasRubyMarkup(span),
        };
      }
    }
  }
  return null;
}

/**
 * Find a row's evidence, and say which kind of claim it supports.
 *
 * Two stages, in the order review 05 §3.6 sets:
 *
 *   1. **`quote`** — one of the row's own spellings (or its rendering) occurs in the volume's
 *      source text. The line number is **discovered**, not claimed, which is what makes an
 *      imported row's evidence verify by construction rather than by assertion.
 *   2. **`governs`** — the row's notes quote a passage that IS in the source text. The row's
 *      term is not printed anywhere; the row is the decision made about that passage. This is
 *      a second kind of evidence, not an exemption: it still has to name a real line, and the
 *      line still has to contain what is cited.
 *
 * A row that can support neither is refused and reported. That is the rule working, not a gap
 * in it (review 05 §3.6): the store has no path for a claim nobody can check.
 *
 * @param {string} volumeDir
 * @param {Array<{id: string, file: string}>} chapters
 * @param {number} volume
 * @param {{term: string, rendering: string, notes: string}} row
 * @returns {{evidence: Array<Object>|null, kind: "quote"|"governs"|null, matched: string|null, tried: string[], governsTried: string[]}}
 */
function findRowEvidence(volumeDir, chapters, volume, row) {
  const quoteCandidates = [...glossaryTermSpans(row.term)];
  if (row.rendering) quoteCandidates.push(row.rendering.replace(/^[*_]+|[*_]+$/g, "").trim());
  const tried = quoteCandidates.filter((candidate) => normalizeQuote(candidate)).slice(0, QUOTE_CANDIDATES_PER_ROW);
  const quoteHit = searchSpans(volumeDir, chapters, volume, tried, "quote");
  if (quoteHit) {
    return { evidence: quoteHit.evidence, kind: "quote", matched: quoteHit.matched, tried, governsTried: [] };
  }

  const governsTried = noteQuotedSpans(row.notes).slice(0, QUOTE_CANDIDATES_PER_ROW);
  const governsHit = searchSpans(volumeDir, chapters, volume, governsTried, "governs");
  if (governsHit) {
    return { evidence: governsHit.evidence, kind: "governs", matched: governsHit.matched, tried, governsTried };
  }

  return { evidence: null, kind: null, matched: null, tried, governsTried };
}

/**
 * Find a quoted line in this volume's own chapter files, and cite where it is.
 *
 * The revision door's half of the evidence rule. `findRowEvidence` asks "does this row's term, its
 * rendering, or a passage its notes quote appear in this volume's text?" — a question about a NEW row.
 * A revision is asked a narrower and stricter one: **the line the answer quoted is really in this
 * volume**. A revision justified by the previous glossary's own row is a rendering changed because a
 * model said so, which is the one thing this store does not accept.
 *
 * @param {string} volumeDir
 * @param {Array<{id: string, file: string}>} chapters
 * @param {number} volume
 * @param {string} quote - The line the answer quoted.
 * @returns {{evidence: Array<Object>|null, matched: string|null, span: string, markupStripped: boolean}}
 *   `markupStripped` is true when the line the answer quoted carried pronunciation markup that the evidence
 *   rule removed before comparing it (plan 07 §4.6). The stored quote keeps what the answer quoted; the
 *   comparison is what the book prints.
 */
function findQuoteEvidence(volumeDir, chapters, volume, quote) {
  const span = String(quote || "").trim();
  if (!normalizeQuote(span)) return { evidence: null, matched: null, span, markupStripped: hasRubyMarkup(span) };
  const hit = searchSpans(volumeDir, chapters, volume, [span], "quote");
  if (!hit) return { evidence: null, matched: null, span, markupStripped: hasRubyMarkup(span) };
  return { evidence: hit.evidence, matched: hit.matched, span, markupStripped: hit.markupStripped };
}

module.exports = {
  noteQuotedSpans,
  findRowEvidence,
  findQuoteEvidence,
};

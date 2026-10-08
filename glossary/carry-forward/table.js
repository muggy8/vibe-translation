/**
 * glossary/carry-forward/table.js — the glossary read as a table, not as prose.
 *
 * The rows, the spellings a term column names, the whole text of a row, the rendering worth
 * comparing, and the compact index an amend agent is handed instead of being told to page
 * through a 473 KB file it cannot read whole.
 * 
 * Everything here is pure: no file reads, no model call.
 */

/**
 * Parse the source-language terms out of a glossary Markdown file.
 *
 * Walks the table rows and keeps the FIRST column, tracking the `## `
 * section each row belongs to. For each maximal run of consecutive table
 * rows, the first row (header) and the second row (separator, e.g.
 * `|---|---|---|`) are skipped. Emphasis-wrapped cells are normalized.
 *
 * @param {string} markdown - The glossary file content.
 * @returns {Array<{term: string, rendering: string, section: string}>} One entry
 *   per term row, in file order. `rendering` is the target-language column
 *   (empty when the row has none).
 */
function parseGlossaryTableTerms(markdown) {
  if (!markdown || typeof markdown !== "string") return [];
  const entries = [];
  let section = "";
  let tableRows = [];
  const flushTable = () => {
    // Row 0 = header, row 1 = separator — data starts at row 2.
    for (let ri = 2; ri < tableRows.length; ri++) {
      const cells = tableRows[ri]
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c !== "");
      if (cells.length === 0) continue;
      let term = cells[0].trim();
      term = term.replace(/^`+|`+$/g, "").trim();
      term = term.replace(/^\*+|\*+$/g, "").trim();
      term = term.replace(/^_+|_+$/g, "").trim();
      if (!term) continue;
      if (/^:?-{3,}:?$/.test(term)) continue; // stray separator
      if (/^\[.*\]$/.test(term)) continue; // unrendered template placeholder
      // The rendering (column 1) rides along: the compact term index built from
      // these entries lets the amend pass see what an existing term is ALREADY
      // called, which is what a conflict check needs.
      const rendering = (cells[1] || "")
        .replace(/^`+|`+$/g, "")
        .replace(/^\*+|\*+$/g, "")
        .replace(/^_+|_+$/g, "")
        .trim();
      // The Notes column rides along (everything past the rendering). The
      // carry-forward gate needs it to tell a RENAMED entry from a deleted one:
      // "also written <the old spelling>" recorded in the Notes is the evidence
      // that the entry survived having its term column rewritten.
      const notes = cells.slice(2).join(" | ").trim();
      entries.push({ term, rendering, notes, section });
    }
    tableRows = [];
  };
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flushTable();
      section = heading[1].replace(/\*/g, "").trim();
      continue;
    }
    if (line.startsWith("|")) {
      tableRows.push(line);
      continue;
    }
    flushTable();
  }
  flushTable();
  return entries;
}


/**
 * The separate spellings named inside ONE glossary row's term column.
 *
 * A row's first column is often several source-language spellings of one entry
 * written as a slash-separated list: `三つ編み魔王 / 三つ編み悪魔 / 呪われし姫君`.
 * The carry-forward gate has to compare entries at THAT resolution, because an
 * agent that widens an existing row with a new alias changes the cell without
 * losing the entry. Observed live: volume 02's glossary was quarantined for
 * "dropping" two terms that were both still in the file, each one widened —
 * `三つ編み魔王 / 三つ編み悪魔 / 呪われし姫君` became
 * `三つ編み魔王 / 三つ編み悪魔 / 魔王 / 呪われし姫君`, and
 * `鈍感系巻き込まれ型主人公` became
 * `鈍感系巻き込まれ型主人公 / 鈍感純情ＢＯＹ / やれやれ巻き込まれＢＯＹ`. The guard
 * compared whole cells as exact strings, called an improvement a loss, and threw
 * away a glossary that had grown from 88 terms to 140.
 *
 * @param {string} term - One row's term column.
 * @returns {string[]} The trimmed spellings it names (empty for an empty cell).
 */
function glossaryTermSpans(term) {
  if (!term || typeof term !== "string") return [];
  return term
    .split("/")
    .map((span) =>
      span
        .replace(/^`+|`+$/g, "")
        .replace(/^\*+|\*+$/g, "")
        .replace(/^_+|_+$/g, "")
        .trim()
    )
    .filter((span) => span.length > 0);
}


/**
 * The whole text of one glossary row — every column — for the "is this entry
 * still documented here?" test.
 *
 * The carry-forward gate used to read only the term column, which is what made
 * a legitimate rename look like a deletion (see compareGlossaryCarryForward).
 *
 * @param {{term: string, rendering: string, notes: string}} entry - One parsed row.
 * @returns {string} The row's columns joined by " | ".
 */
function glossaryRowText(entry) {
  return [entry.term, entry.rendering, entry.notes].filter(Boolean).join(" | ");
}


/**
 * The Han (kanji) characters of one spelling, in order, with every kana dropped.
 *
 * This is what a source-language term looks like once you stop writing its furigana, and it is the
 * only form in which two furiganed spellings of ONE term are the same string. Observed live: volume
 * 14's glossary row is `双ふた花ばの恋物語`; volume 15's chapter 6 prints
 * `双ふた花ばの恋こい物もの語がたり` — furigana inserted INSIDE the word, so neither string contains
 * the other as a substring, and any test that compares whole spellings says "this term is not in the
 * text" about a term the text prints twice. Both spellings have the skeleton `双花恋物語`.
 *
 * It is a comparison key, not a claim about reading: it cannot tell 恋 in 恋する from 恋 written with
 * its furigana, and it is deliberately paired with a minimum length so a one- or two-character
 * skeleton (which occurs everywhere in real Japanese prose) is never trusted to mean anything.
 *
 * @param {string} text - One spelling, or a whole term column.
 * @returns {string} Its Han characters in order ("" when it has none — a pure-kana term has no skeleton).
 */
function glossaryTermSkeleton(text) {
  if (!text || typeof text !== "string") return "";
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3400 && code <= 0x4dbf) out += ch; // CJK Extension A
    else if (code >= 0x4e00 && code <= 0x9fff) out += ch; // CJK Unified Ideographs
  }
  return out;
}

// A skeleton this short is two common kanji sitting next to each other, which happens all over a
// real page, so the skeleton test only runs on something long enough to be a term.
const GLOSSARY_SKELETON_MIN_CHARS = 3;


/**
 * A rendering compared without Markdown emphasis or spacing, so `*The Twin
 * Flowers' Love Story*` and `The Twin Flowers' Love Story` are the same name.
 *
 * @param {string} rendering - One row's target-language column.
 * @returns {string} The comparison key ("" for an empty rendering).
 */
function normalizeGlossaryRendering(rendering) {
  return String(rendering || "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// A one-character term is too ambiguous to prove anything by substring matching
// ("A" occurs in half the Notes cells of a real glossary), so the rename test
// only trusts a spelling long enough to be a term.
const CARRY_FORWARD_MIN_ALIAS_SPAN_CHARS = 2;


/**
 * A compact map of the glossary an agent is about to amend: each section, and
 * under it every source-language term with the rendering it already has.
 *
 * Why the agent needs it: the cumulative glossary is far too big to read whole
 * (volume 05's is 473 KB, and a `readFile` answer is capped at
 * `AGENT_MAX_READ_BYTES` = 64 KB), yet the amend pass must know which section a
 * term belongs in and whether the term is ALREADY there under a different
 * spelling. Without a map the agent finds that out by paging — 8–17 `readFile`
 * calls on the live run, each re-billing the whole transcript so far, and the
 * step budget gone before the first row was inserted.
 *
 * The index is the whole document at the resolution a decision needs: term and
 * rendering, no Notes. Deterministic, and small enough to inline.
 *
 * It is capped (`GLOSSARY_INDEX_MAX_CHARS`, default 30000) and says so when it
 * truncates — a prompt that silently truncates is a prompt that silently
 * ignores part of the rules (gotcha 43).
 *
 * @param {string} markdown - The glossary the agent will amend.
 * @returns {string} The index, or "" when the glossary has no term rows.
 */
function buildGlossaryIndex(markdown) {
  const entries = parseGlossaryTableTerms(markdown);
  if (entries.length === 0) return "";

  const bySection = new Map();
  for (const entry of entries) {
    const key = entry.section || "(no section heading)";
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(entry);
  }

  const cap = Number.parseInt(process.env.GLOSSARY_INDEX_MAX_CHARS || "30000", 10);
  const lines = [];
  let shown = 0;
  let used = 0;
  for (const [section, items] of bySection) {
    const head = `\n### ${section} (${items.length})\n`;
    const body = items
      .map((e) => (e.rendering ? `${e.term} → ${e.rendering}` : e.term))
      .join(", ");
    if (Number.isFinite(cap) && cap > 0 && used + head.length + body.length > cap) {
      const remaining = entries.length - shown;
      lines.push(
        head +
          `(${remaining} term(s) of this and later sections are not listed here — ` +
          `the index is capped at ${cap} chars, so a term missing from this list is not a term ` +
          `missing from the glossary.)`
      );
      used += head.length;
      break;
    }
    lines.push(head + body);
    used += head.length + body.length;
    shown += items.length;
  }
  return lines.join("\n").trim();
}

module.exports = {
  parseGlossaryTableTerms,
  glossaryTermSpans,
  glossaryTermSkeleton,
  GLOSSARY_SKELETON_MIN_CHARS,
  glossaryRowText,
  normalizeGlossaryRendering,
  CARRY_FORWARD_MIN_ALIAS_SPAN_CHARS,
  buildGlossaryIndex,
};

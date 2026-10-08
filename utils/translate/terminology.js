/**
 * Reading the reference artifacts: the glossary table (rows, alias spellings,
 * renderings) and the style guide's rules, plus the compact glossary block a
 * prompt is given.
 *
 * The glossary is the stage's terminology law, so the block that carries it into a
 * prompt has its own budget and says out loud when it truncates (gotcha 43).
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const { countOccurrences } = require("./qa");

/**
 * Parse source-language terms AND their canonical target renderings out of
 * a glossary Markdown file (column 1 = the source term, column 2 = the
 * canonical rendering; see {@link parseGlossaryRows} for the row handling).
 *
 * Rows whose term is an unrendered template placeholder, or whose rendering
 * column is empty or a "—", are NOT returned — they cannot drive a terminology
 * constraint — but they are reported through `onMalformed`, so a caller can warn
 * that the glossary is incomplete instead of quietly translating without the
 * term.
 *
 * @param {string} markdown - The glossary file content.
 * @param {{onMalformed?: (entry: {term: string, section: string, reason: string}) => void}} [opts]
 * @returns {Array<{term: string, rendering: string, section: string}>}
 *   One entry per usable term row, in file order.
 */
function parseGlossaryTerms(markdown, { onMalformed } = {}) {
  const entries = [];
  for (const { cells, section } of parseGlossaryRows(markdown)) {
    const term = cells[0] || "";
    const rendering = cells.length > 1 ? cells[1] : "";
    if (!term) continue;
    if (/^\[.*\]$/.test(term)) continue; // unrendered template placeholder
    if (!rendering || /^:?-{3,}:?$/.test(rendering) || rendering === "—") {
      if (typeof onMalformed === "function") {
        onMalformed({
          term,
          section,
          reason: rendering
            ? "rendering column is a placeholder"
            : "rendering column is empty",
        });
      }
      continue;
    }
    entries.push({ term, rendering, section });
  }
  return entries;
}


/**
 * Normalize one glossary table cell: strip the backtick/emphasis wrappers a
 * Markdown-writing model likes to add.
 *
 * @param {string} cell
 * @returns {string}
 */
function cleanTableCell(cell) {
  return String(cell ?? "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim()
    .replace(/^\*+|\*+$/g, "")
    .trim()
    .replace(/^_+|_+$/g, "")
    .trim();
}


/**
 * Split one Markdown table row into its cells, POSITIONALLY.
 *
 * A table row is wrapped in pipes ("| a | b | c |"), so the first and last
 * pieces produced by split("|") are the shells outside the table and are
 * dropped. EMPTY CELLS IN THE MIDDLE ARE KEPT.
 *
 * (Observed: the previous version filtered out every empty cell, so a row with
 * an empty Target column shifted the remaining columns one place left —
 * `| ソラ |  | AI agent of the institute |` came back with the canonical
 * rendering "AI agent of the institute". That string then went into every
 * translate / retranslate / verify / polish prompt as a terminology law, and
 * into the deterministic "missing glossary rendering" check.)
 *
 * @param {string} row - A line starting with "|".
 * @returns {string[]} The cells in column order (empty cells preserved).
 */
function splitTableRow(row) {
  const cells = String(row ?? "").split("|");
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map(cleanTableCell);
}


/**
 * Walk a glossary-style Markdown file and return every DATA row of every
 * table, positionally, tracking the `## ` section each row belongs to.
 *
 * For each maximal run of consecutive table rows, row 0 (the header) and row 1
 * (the `|---|---|` separator) are skipped. This is the single table reader for
 * the project: the glossary coverage audit and the translation stage's
 * terminology constraint both read through it so they cannot drift apart.
 *
 * @param {string} markdown - The glossary file content.
 * @returns {Array<{cells: string[], section: string}>} One entry per data row.
 */
function parseGlossaryRows(markdown) {
  if (!markdown || typeof markdown !== "string") return [];
  const rows = [];
  let section = "";
  let tableRows = [];
  const flushTable = () => {
    // Row 0 = header, row 1 = separator — data starts at row 2.
    for (let ri = 2; ri < tableRows.length; ri++) {
      const cells = splitTableRow(tableRows[ri]);
      if (cells.length === 0) continue;
      if (/^:?-{3,}:?$/.test(cells[0])) continue; // stray separator row
      rows.push({ cells, section });
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
  return rows;
}


/**
 * The character budget for the glossary block injected into one chapter's
 * prompts (TRANSLATION_GLOSSARY_MAX_CHARS, default 12000).
 *
 * @returns {number}
 */
function glossaryBlockMaxChars() {
  const n = parseInt(process.env.TRANSLATION_GLOSSARY_MAX_CHARS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 12000;
}


/**
 * Pick the glossary terms this chapter can actually use, bounded by a
 * character budget.
 *
 * The glossary is cumulative: by the last volume of a long series it holds
 * every term the series has ever introduced. Injecting ALL of them into every
 * chapter prompt (what the translation stage used to do) makes the prompt grow
 * with the size of the SERIES rather than of the chapter, until it crowds out
 * the source text. A term whose source form does not appear in this chapter
 * cannot be rendered in this chapter, so it is dead weight.
 *
 * Substring matching is the right test for Japanese / Chinese / Korean (no
 * word boundaries): "黒鋼さん" contains the glossary term "黒鋼".
 *
 * @param {Array<{term: string, rendering: string, section: string}>} terms - The cumulative glossary terms.
 * @param {string} sourceText - The chapter's source text.
 * @param {{maxChars?: number}} [opts] - Character budget for the block (default: glossaryBlockMaxChars()).
 * @returns {{terms: Array<{term: string, rendering: string, section: string}>, usedChars: number, present: number, dropped: number}}
 *   `terms` in glossary order, capped by the budget. `present` counts the terms
 *   that occur in this chapter; `dropped` counts everything in the glossary
 *   that is not in the returned block (absent terms + over-budget terms).
 */
function selectTermsForChapter(terms, sourceText, { maxChars } = {}) {
  const all = Array.isArray(terms) ? terms : [];
  const budget = Math.max(0, maxChars ?? glossaryBlockMaxChars());
  const present = all.filter(
    (t) => t && t.term && countOccurrences(sourceText || "", t.term) > 0
  );
  const kept = [];
  let usedChars = 0;
  for (const t of present) {
    const lineChars = `"${t.term}" → "${t.rendering}"`.length + 1;
    if (usedChars + lineChars > budget) break;
    kept.push(t);
    usedChars += lineChars;
  }
  return { terms: kept, usedChars, present: present.length, dropped: all.length - kept.length };
}


/**
 * Extract the compact style constraints from a style-guide Markdown file.
 *
 * Prefers the `## Policy Summary` section (the distilled house rules the
 * style-guide task writes first); falls back to the whole guide truncated
 * to `fallbackMaxChars` when the section is absent (older formats).
 *
 * @param {string} markdown - The style-guide file content.
 * @param {{fallbackMaxChars?: number}} [opts]
 * @returns {string} The style rule text ("" when the guide is empty/missing).
 */
function extractStyleRules(markdown, { fallbackMaxChars = 8000 } = {}) {
  if (!markdown || typeof markdown !== "string" || !markdown.trim()) return "";
  // Capture from the Policy Summary heading to the end of the string, then
  // cut at the next "## " section (a lookahead for "end of line" would match
  // at the end of ANY line in the section, so cut manually).
  const m = markdown.match(/^##\s+Policy Summary[ \t]*\r?\n([\s\S]*)/m);
  if (m) {
    let body = m[1];
    const cut = body.search(/\r?\n##\s/);
    if (cut !== -1) body = body.slice(0, cut);
    if (body.trim()) return body.trim();
  }
  const t = markdown.trim();
  return t.length > fallbackMaxChars ? t.slice(0, fallbackMaxChars) + "\n…(truncated)" : t;
}

// ─── instTrans prompt construction (glossary block for the grading stages) ───


/**
 * Build the glossary block for the verify/polish prompts.
 *
 * The block is capped (TRANSLATION_GLOSSARY_MAX_CHARS): a cumulative glossary
 * handed whole to every chapter's grader eventually out-shouts the text being
 * graded. Callers should pass the chapter-scoped selection (chapterTerminology)
 * — this cap is the backstop for anything that doesn't.
 *
 * @param {Array<{term: string, rendering: string}>} terms
 * @returns {string} One line per term, or the "none provided" marker.
 */
function glossaryBlock(terms) {
  if (!terms || terms.length === 0) return "(none provided — run the glossary task)";
  const budget = glossaryBlockMaxChars();
  const lines = [];
  let used = 0;
  for (const t of terms) {
    const line = `"${t.term}" → "${t.rendering}"`;
    if (used + line.length + 1 > budget) {
      lines.push(`… (${terms.length - lines.length} further glossary term(s) omitted by the ${budget}-char budget)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}


module.exports = {
  parseGlossaryTerms,
  cleanTableCell,
  splitTableRow,
  parseGlossaryRows,
  glossaryBlockMaxChars,
  selectTermsForChapter,
  extractStyleRules,
  glossaryBlock,
};

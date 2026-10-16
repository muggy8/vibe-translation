/**
 * utils/reference-store/glossary-adapter/parse.js — reading a glossary document back into rows.
 *
 * The document half of the adapter: the term cell split into the spellings it names, the table row
 * split into cells, and the whole file read into rows plus the prose that is not rows — the title
 * line, the preamble, and the paragraph a section carries before its table, all kept verbatim
 * because a renderer that drops them cannot claim to reproduce the document.
 *
 * This parser is deliberately NOT `glossary/carry-forward/table.js`'s: two independent readers of
 * the same file is what makes the round-trip test a cross-check rather than a tautology.
 *
 * @module utils/reference-store/glossary-adapter/parse
 */

require("../../../types"); // JSDoc type definitions

const { stripRubyMarkup, hasRubyMarkup } = require("../ruby-markup");

/**
 * Split a term cell into the spellings it names.
 *
 * A glossary row's first column is often several spellings of one entry
 * (`三つ編み魔王 / 三つ編み悪魔 / 呪われし姫君`), which is the shape the carry-forward gate
 * had to learn to compare at this resolution (gotcha 64). The importer keeps the cell as
 * written and searches each spelling for the evidence.
 *
 * **Ruby markup is taken off before the cell is split** (plan 07 §4.6). A closing tag carries a `/` of its
 * own, so splitting first cuts the unit to pieces:
 * `<ruby>偽物<rt>にせもの</rt></ruby> / 偽者` becomes `<ruby>偽物<rt>にせもの<`, `rt><`, `ruby>` and `偽者`,
 * and three of those are not spellings of anything — they are fragments of a tag pair, which the evidence
 * rule would then search for as if they were words. Stripping first gives the two spellings the cell actually
 * names.
 *
 * @param {string} cell
 * @returns {string[]}
 */
function glossaryTermSpans(cell) {
  return stripRubyMarkup(cell)
    .split("/")
    .map((span) => span.replace(/^`+|`+$/g, "").replace(/^\*+|\*+$/g, "").replace(/^_+|_+$/g, "").trim())
    .filter((span) => span.length > 0);
}

/**
 * One Markdown table row, as cells, **positionally**.
 *
 * The shells outside the row (the pieces before the first pipe and after the last) are dropped; every cell
 * inside it is kept, **including an empty one in the middle**. The filter this function used to carry is the
 * column-shift bug `utils/translate/terminology.js` documents in its own copy of this rule:
 * `| ソラ |  | AI agent of the institute |` came back with the canonical rendering
 * "AI agent of the institute", because the empty cell had been deleted and everything after it slid left.
 * A four-column table makes that damage worse rather than better — a missing `Readings` cell would drag the
 * Notes into the reading column and the reading into the notes — so all three readers of a glossary now
 * split the same way.
 *
 * @param {string} line
 * @returns {string[]} The cells in column order (empty cells preserved).
 */
function splitTableRow(line) {
  const cells = String(line).split("|");
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((cell) => cell.trim());
}

/**
 * Whether a line is a table separator (`|---|---|`).
 * @param {string[]} cells
 * @returns {boolean}
 */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * Read a glossary file into rows, and into the prose that is not rows.
 *
 * Sections are tracked so each row knows which `## ` heading it sits under — that is what the
 * renderer needs to put it back. The prose is tracked the same way: the file's opening (title
 * line and preamble paragraphs) and any paragraph a section carries before its table, both kept
 * verbatim including their blank lines, because a renderer that drops them cannot claim to
 * reproduce the document (review 05 §3.4).
 *
 * ## How many columns a table has is read from the table
 *
 * The header row is the declaration. A three-column table (every glossary this repository published before
 * plan 09 slice 3b, and every fixture written since) reads exactly as it always did — term, rendering, and
 * everything past them rejoined as the Notes. A four-column table reads the `Readings` cell at its own
 * position and the Notes from the column after it, so **a reading can never come back as a term, part of a
 * term, or part of the notes** — which is the leak plan 09 §5 names as the acceptance line for this change.
 * The reader is never told which shape it is looking at, because a constant naming the column count in two
 * readers is two constants that can disagree.
 *
 * @param {string} markdown
 * @returns {{rows: Array<{term: string, rendering: string, reading: string, notes: string, section: string}>, title: string|null, preamble: string[], proseBlocks: Array<{section: string|null, kind?: "title", lines: string[]}>, unplacedProse: Array<{section: string, text: string}>, annotatedRows: Array<{term: string, section: string, columns: string[]}>, shortRows: Array<{term: string, section: string, cells: number, declared: number}>}}
 *   `unplacedProse` is prose the file carries AFTER a section's table: this renderer has nowhere
 *   to put it, so it is reported instead of quietly dropped.
 *   `annotatedRows` names every row that carries pronunciation markup and which of its columns carry it
 *   (plan 07 §4.6): the cells are kept verbatim because a renderer that rewrites a published row is doing
 *   the thing this parser exists to notice, and a row that carried markup without being named is the
 *   "no finding and no count that moves" failure the plan warns about. The `Readings` column is one of the
 *   columns it checks (plan 09 slice 3b) — a guide written as markup inside the reading column is named,
 *   not stripped, for the same reason.
 *   `shortRows` names every data row carrying fewer cells than its own table's header declares. The row is
 *   still read (its missing cells are taken to be at the END, which is what a short Markdown row means), so
 *   this is a report, not a refusal.
 */
function parseGlossaryMarkdown(markdown) {
  const rows = [];
  const proseBlocks = [];
  const unplacedProse = [];
  /** @type {Array<{term: string, section: string, columns: string[]}>} */
  const annotatedRows = [];
  /** @type {Array<{term: string, section: string, cells: number, declared: number}>} */
  const shortRows = [];
  let currentBlock = { section: null, lines: [], closed: false };
  let tablePhase = false;
  let title = null;
  let section = "";
  let tableRows = [];

  const closeBlock = () => {
    // A section's block is recorded once. The placeholder that stands in for the rest of the
    // section (after its table started) is marked closed so the next heading does not record a
    // second, empty paragraph for the section it just left.
    if (currentBlock.closed) return;
    const blankOnly = currentBlock.lines.length === 0 || currentBlock.lines.every((line) => line.trim() === "");
    if (currentBlock.section !== null) {
      // EVERY section gets a block, even one that is only the blank line between its heading and
      // its table. That row is what records where the section sits in the document, which is the
      // only reliable way to put the sections back in the order the file had them.
      if (blankOnly) currentBlock.lines = [""];
      proseBlocks.push(currentBlock);
    } else if (!blankOnly) {
      // The opening block's first line is the file's title; everything else is preamble. The
      // distinction is stored so a reader of the table can tell the two apart.
      currentBlock.kind = "title";
      proseBlocks.push(currentBlock);
    }
    currentBlock = { section, lines: [], closed: false };
  };

  const flush = () => {
    // Row 0 is the column header, row 1 the separator; data starts after them. The header is also the
    // table's own declaration of how many columns it has, which is the only way this reader can tell a
    // three-column glossary (every file this repository published before plan 09 slice 3b) from a
    // four-column one without being told, and without a second constant it could disagree with.
    const table = tableRows.filter((cells) => !isSeparatorRow(cells));
    const declared = table.length ? table[0].length : 0;
    const data = table.slice(1);
    for (const cells of data) {
      const term = cells[0] || "";
      if (!term || isSeparatorRow([term])) continue;
      const rendering = cells[1] || "";
      // A row with FEWER cells than its table declares has empty cells at the END of it — that is what a
      // short Markdown row means, and it is what every Markdown renderer assumes. Filling from the left is
      // therefore the reading that cannot move a guide into the Notes; guessing that a short row in a
      // four-column table is really an old three-column row would put the reading in the notes cell, which
      // is the one leak this rule exists to close. The shortness is still named.
      if (declared > 0 && cells.length < declared) shortRows.push({ term, section, cells: cells.length, declared });
      const reading = declared >= 4 ? cells[2] || "" : "";
      // Everything past the last named column belongs to the Notes cell, rejoined the way the file wrote
      // it. A notes cell holding an unescaped pipe is a hand-edit, not a rendered row, and this is the shape
      // that has always absorbed it rather than inventing a column.
      const notes = cells.slice(declared >= 4 ? 3 : 2).join(" | ").trim();
      // The cells are kept exactly as the file wrote them. What is reported is which of them carry
      // pronunciation markup, so a row that reaches a published glossary with a guide inside it is named
      // in the import result instead of being silently rewritten or silently dropped.
      const markupColumns = [
        ["term", term],
        ["rendering", rendering],
        ["reading", reading],
        ["notes", notes],
      ]
        .filter(([, value]) => value && hasRubyMarkup(value))
        .map(([name]) => name);
      if (markupColumns.length) annotatedRows.push({ term, section, columns: markupColumns });
      rows.push({ term, rendering, reading, notes, section });
    }
    tableRows = [];
  };

  for (const rawLine of String(markdown || "").split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      closeBlock();
      // A section heading is a label, and a guide over a label is not part of the label: the section name
      // the rows are filed under is the guide-free one, so a markup-bearing heading cannot split one
      // section into two.
      section = stripRubyMarkup(heading[1]).replace(/\*\*/g, "").trim();
      currentBlock = { section, lines: [], closed: false };
      tablePhase = false;
      continue;
    }
    if (line.startsWith("|")) {
      // The first table line of a section ends the prose that introduced it. Everything after
      // the table is a different thing, and `tablePhase` is what keeps the two apart: without it
      // the blank line that TRAILS one section's table would be stored as a second paragraph of
      // that section and rendered as an extra blank line before it.
      if (tableRows.length === 0 && !tablePhase) {
        closeBlock();
        currentBlock.closed = true;
        tablePhase = true;
      }
      tableRows.push(splitTableRow(line));
      continue;
    }
    flush();
    const kept = rawLine.trimEnd();
    if (tablePhase) {
      // Prose AFTER a section's table. This renderer writes prose before a table and nothing
      // else, so it cannot put such a line back where it was; the honest move is to report it in
      // the import result rather than drop it on the way in.
      if (line) unplacedProse.push({ section, text: kept });
      continue;
    }
    if (title === null && currentBlock.section === null && /^#\s/.test(line)) title = kept;
    currentBlock.lines.push(kept);
  }
  flush();
  closeBlock();

  const opening = proseBlocks.find((block) => block.section === null) || { section: null, lines: [] };
  const preamble = title === null ? opening.lines : opening.lines.slice(1);

  return { rows, title, preamble, proseBlocks, unplacedProse, annotatedRows, shortRows };
}

module.exports = {
  glossaryTermSpans,
  parseGlossaryMarkdown,
};

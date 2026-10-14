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

/**
 * Split a term cell into the spellings it names.
 *
 * A glossary row's first column is often several spellings of one entry
 * (`三つ編み魔王 / 三つ編み悪魔 / 呪われし姫君`), which is the shape the carry-forward gate
 * had to learn to compare at this resolution (gotcha 64). The importer keeps the cell as
 * written and searches each spelling for the evidence.
 *
 * @param {string} cell
 * @returns {string[]}
 */
function glossaryTermSpans(cell) {
  return String(cell || "")
    .split("/")
    .map((span) => span.replace(/^`+|`+$/g, "").replace(/^\*+|\*+$/g, "").replace(/^_+|_+$/g, "").trim())
    .filter((span) => span.length > 0);
}

/**
 * One Markdown table row, as cells.
 * @param {string} line
 * @returns {string[]}
 */
function splitTableRow(line) {
  return String(line)
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
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
 * @param {string} markdown
 * @returns {{rows: Array<{term: string, rendering: string, notes: string, section: string}>, title: string|null, preamble: string[], proseBlocks: Array<{section: string|null, kind?: "title", lines: string[]}>, unplacedProse: Array<{section: string, text: string}>}}
 *   `unplacedProse` is prose the file carries AFTER a section's table: this renderer has nowhere
 *   to put it, so it is reported instead of quietly dropped.
 */
function parseGlossaryMarkdown(markdown) {
  const rows = [];
  const proseBlocks = [];
  const unplacedProse = [];
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
    // Row 0 is the column header, row 1 the separator; data starts after them.
    const data = tableRows.filter((cells) => !isSeparatorRow(cells)).slice(1);
    for (const cells of data) {
      const term = cells[0] || "";
      if (!term || isSeparatorRow([term])) continue;
      rows.push({
        term,
        rendering: cells[1] || "",
        notes: cells.slice(2).join(" | ").trim(),
        section,
      });
    }
    tableRows = [];
  };

  for (const rawLine of String(markdown || "").split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      closeBlock();
      section = heading[1].replace(/\*\*/g, "").trim();
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

  return { rows, title, preamble, proseBlocks, unplacedProse };
}

module.exports = {
  glossaryTermSpans,
  parseGlossaryMarkdown,
};

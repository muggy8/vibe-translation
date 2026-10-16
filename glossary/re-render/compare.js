/**
 * glossary/re-render/compare.js — what replacing a published glossary with a render of its own
 * record would actually change.
 *
 * Two questions, answered from the two texts alone, with no model call and no row written:
 *
 *   1. **Line by line.** Is every line that is not a table header line byte-identical? That is the
 *      lossless proof the plan's acceptance line asks for: a re-render that changes only the column
 *      headers is a rename, and a rename can be checked by diffing rather than argued.
 *   2. **Row by row.** Which rows on disk are not in the render, and **which rule refused each one**?
 *      A row that disappears from a published glossary is not a formatting accident — it is a row the
 *      record refused to hold, and the refusal has a name. `explainAbsentGlossaryRow` re-asks the
 *      store's own evidence rule against this volume's own book and reports which of the two measured
 *      shapes fired: the row's spellings are nowhere in the volume's text, or the row spells a word the
 *      way the OLD converter printed it (gotcha 123), which the guide-free text no longer contains.
 *   3. **Cell by cell, for the `Readings` column** (plan 09 slice 3b). Three texts are compared, not two:
 *      what the published file prints, what the render prints, and what the **record** says the cell should
 *      be — asked through the same helper the renderer used, against the same store. A render that prints a
 *      guide the record does not hold is `invented`; one that drops a guide the file or the record holds is
 *      `lost`; a guide the record holds and the file does not yet print is `added`, and that is the only
 *      allowed answer, because it is the entire content of the change this column exists to make.
 *
 * The comparison is deliberately **not** a similarity score. It answers "what would disappear?" and
 * "what would appear?", and it says 0 when nothing would.
 *
 * @module glossary/re-render/compare
 */

const { normalizeQuote } = require("../../utils/reference-store/evidence");
const { listVolumeChapters } = require("../../utils/reference-store/source-chapters");
const {
  parseGlossaryMarkdown,
  glossaryTermSpans,
  findRowEvidence,
  readingsFromCell,
} = require("../../utils/reference-store/glossary-adapter");
const { rubyGuideSplitFormOf } = require("../../utils/source/ruby-guides");
require("../../types"); // JSDoc type definitions

/**
 * One line of a published glossary, classified by what it IS rather than by what it is called.
 *
 * @typedef {"header"|"separator"|"row"|"section"|"prose"} GlossaryLineKind
 */

/**
 * Whether a line is a Markdown table separator (`|---|---|---|`).
 * @param {string} line
 * @returns {boolean}
 */
function isSeparatorLine(line) {
  const cells = String(line).split("|").map((cell) => cell.trim()).filter((cell) => cell !== "");
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * Classify every line of a glossary document.
 *
 * A **header** line is a table line that a separator line FOLLOWS. That is decided from the shape of
 * the pair, not from the words in the cells, which is what lets the same classifier read the old
 * labels and the new ones without being told which is which — and what stops a data row that happens
 * to mention a column name from being mistaken for a header.
 *
 * @param {string} markdown
 * @returns {{lines: Array<{index: number, line: string, kind: GlossaryLineKind}>, headers: string[], rows: string[], sections: string[], prose: string[]}}
 */
function classifyGlossaryLines(markdown) {
  const lines = String(markdown || "").split("\n");
  /** @type {Array<{index: number, line: string, kind: GlossaryLineKind}>} */
  const classified = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let kind = "prose";
    if (line.startsWith("|")) kind = isSeparatorLine(line) ? "separator" : "row";
    else if (/^##\s/.test(line)) kind = "section";
    classified.push({ index: i, line, kind });
  }
  // A table line is a header when the line after it is a separator. Everything else that starts with a
  // pipe is a data row, including the first row of a table whose header was hand-edited away.
  for (let i = 0; i < classified.length; i += 1) {
    if (classified[i].kind === "row" && i + 1 < classified.length && classified[i + 1].kind === "separator") {
      classified[i].kind = "header";
    }
  }
  return {
    lines: classified,
    headers: classified.filter((entry) => entry.kind === "header").map((entry) => entry.line),
    rows: classified.filter((entry) => entry.kind === "row").map((entry) => entry.line),
    sections: classified.filter((entry) => entry.kind === "section").map((entry) => entry.line),
    prose: classified.filter((entry) => entry.kind === "prose").map((entry) => entry.line),
  };
}

/**
 * The document with every table header line removed — the text the lossless proof compares.
 *
 * @param {string} markdown
 * @returns {string}
 */
function withoutTableHeaders(markdown) {
  return classifyGlossaryLines(markdown)
    .lines.filter((entry) => entry.kind !== "header")
    .map((entry) => entry.line)
    .join("\n");
}

/**
 * The rows of one glossary document, keyed the way every door in the store keys a term.
 *
 * Read through the store's own reader (`parseGlossaryMarkdown`), so the comparison uses the same row
 * boundaries the store uses when it files a row — not a second opinion about where a table ends.
 *
 * @param {string} markdown
 * @returns {Map<string, {term: string, rendering: string, reading: string, notes: string, section: string}>}
 */
function glossaryRowsByKey(markdown) {
  /** @type {Map<string, {term: string, rendering: string, reading: string, notes: string, section: string}>} */
  const out = new Map();
  for (const row of parseGlossaryMarkdown(markdown).rows) {
    const key = normalizeQuote(row.term);
    if (!key) continue;
    if (!out.has(key)) out.set(key, row);
  }
  return out;
}

/**
 * The guide-split strings this volume's own harvest says its author annotated (gotcha 123).
 *
 * Built once per volume and passed to {@link explainAbsentGlossaryRow}, because asking per row would
 * re-read a 300 KB harvest file for every candidate.
 *
 * @param {Array<{annotated?: Array<{base: string, reading: string}>}>|null|undefined} harvestRows
 * @returns {Set<string>} The strings the OLD converter would have left in the text.
 */
function guideSplitFormsOfHarvest(harvestRows) {
  /** @type {Set<string>} */
  const forms = new Set();
  for (const row of harvestRows || []) {
    const form = rubyGuideSplitFormOf(row && row.annotated);
    if (form) forms.add(form);
  }
  return forms;
}

/**
 * How many cells one Markdown table line declares, positionally (the shells off the ends).
 *
 * @param {string} line
 * @returns {number}
 */
function tableCellCount(line) {
  const parts = String(line || "").split("|");
  if (parts.length > 0 && parts[0].trim() === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === "") parts.pop();
  return parts.length;
}

/**
 * Whether a document's tables declare a fourth column.
 *
 * @param {string[]} headerLines - The header lines {@link classifyGlossaryLines} found.
 * @returns {boolean}
 */
function headerDeclaresReadingColumn(headerLines) {
  return (headerLines || []).some((line) => tableCellCount(line) >= 4);
}

/**
 * The readings one cell names, as a set.
 *
 * @param {string} cell
 * @returns {Set<string>}
 */
function readingSetOf(cell) {
  return new Set(readingsFromCell(cell).map((entry) => entry.reading));
}

/**
 * What the `Readings` column would do to one row, and which of the four answers it is.
 *
 * Three texts are compared, not two, and that is the whole point of this function:
 *
 *   - **what the published file prints** (`onDisk`),
 *   - **what the render prints** (`rendered`),
 *   - **what the record says the cell should be** (`expected`, from the same store the render was made
 *     from, through the same helper the renderer used).
 *
 * Comparing only the first two would let a renderer that mis-queries the record publish a reading the
 * record does not hold, and the file would look self-consistent. Comparing only the last two would let a
 * render silently drop a guide the published file already prints. Both are refused, and each has its own
 * name:
 *
 *   - `invented` — the render prints a reading the record does not hold.
 *   - `lost` — a reading the published file prints, or the record holds, is not in the render.
 *   - `added` — the render prints a guide the published file does not yet print, and the record holds it.
 *     **This is the only allowed answer**, and it is the whole content of the change: plan 09 slice 3b is a
 *     door that puts guides the book printed into a file that does not print them. `hadGuidesOnDisk` says
 *     which flavour it is — a row getting its first guide (the answer every three-column file gets), or an
 *     extra guide arriving beside ones the file already prints.
 *
 * There is deliberately **no fourth refusal**. Once `invented` and `lost` are out of the way, the only
 * difference left is a guide the record holds and the file lacks, and refusing that would mean a published
 * glossary could never gain a guide without re-deriving the volume from its book — a door that costs a
 * stage run to fix a fact the record already has.
 *
 * @param {Object} opts
 * @param {string} opts.onDiskCell - The published file's reading cell ("" when its table has no such column).
 * @param {string} opts.renderedCell - The render's reading cell.
 * @param {string|null} [opts.expectedCell] - The cell the record says this row's readings are, or null when
 *   the caller did not ask the record (then `invented` cannot be answered and says so).
 * @returns {{kind: string, onDisk: string[], rendered: string[], expected: string[]|null, invented: string[], lost: string[], added: string[], hadGuidesOnDisk: boolean, expectedAsked: boolean}}
 */
function compareReadingCell({ onDiskCell, renderedCell, expectedCell }) {
  const disk = [...readingSetOf(onDiskCell)];
  const rendered = [...readingSetOf(renderedCell)];
  const expectedAsked = typeof expectedCell === "string";
  const expected = expectedAsked ? [...readingSetOf(expectedCell)] : null;

  const renderedSet = new Set(rendered);
  const diskSet = new Set(disk);
  const expectedSet = expected ? new Set(expected) : null;

  const invented = expected ? rendered.filter((reading) => !expectedSet.has(reading)) : [];
  const lost = [
    ...disk.filter((reading) => !renderedSet.has(reading)),
    ...(expected ? expected.filter((reading) => !renderedSet.has(reading)) : []),
  ].filter((reading, index, all) => all.indexOf(reading) === index);
  const added = rendered.filter((reading) => !diskSet.has(reading));

  let kind = "same";
  if (invented.length) kind = "invented";
  else if (lost.length) kind = "lost";
  else if (added.length) kind = "added";
  return {
    kind,
    onDisk: disk,
    rendered,
    expected,
    invented,
    lost,
    added,
    hadGuidesOnDisk: disk.length > 0,
    expectedAsked,
  };
}

/**
 * Name the rule that refused a row the record does not hold.
 *
 * Re-asks the store's own evidence door against this volume's own book — the same call
 * `importGlossary` made when the row was offered to the record — and reports which shape fired:
 *
 *   - `reference-evidence-does-not-verify` — none of the row's spellings, its rendering, or a passage
 *     its notes quote occurs in this volume's text. The store has no path for a claim nobody can check.
 *   - `reference-row-spells-a-guide-split-string` — the row spells a word the way the converter used to
 *     paste pronunciation guides into it (貞さだ○状態 for 貞○状態), so the guide-free text this volume now
 *     holds no longer contains it. The claim is true; the string the book prints changed (gotcha 123).
 *   - `reference-row-not-in-the-record` — neither fired, so the row is absent for a reason this door
 *     cannot name. It is reported as that, rather than folded into the evidence rule it does not match.
 *
 * @param {Object} opts
 * @param {string} opts.volumeDir - The volume folder whose book the row has to be found in.
 * @param {number} opts.volume - The volume the render is for.
 * @param {{term: string, rendering: string, notes: string, section: string}} opts.row
 * @param {Set<string>} [opts.guideSplitForms] - This volume's harvest's split forms, from {@link guideSplitFormsOfHarvest}.
 * @returns {{rule: string, because: string}}
 */
function explainAbsentGlossaryRow({ volumeDir, volume, row, guideSplitForms }) {
  const listed = listVolumeChapters(volumeDir);
  const { evidence, tried, governsTried } = findRowEvidence(volumeDir, listed.chapters, volume, row);
  if (evidence) {
    return {
      rule: "reference-row-not-in-the-record",
      because:
        `this row's evidence DOES verify against volume ${volume}'s text (${JSON.stringify(evidence[0].quote)} at ` +
        `chapter ${evidence[0].chapter} line ${evidence[0].line}), so the record does not hold it for a reason ` +
        `this door cannot name — it was never offered to this record, or it was filed under a different term.`,
    };
  }
  const spans = glossaryTermSpans(row.term);
  const splitHit = [...(guideSplitForms || [])].filter(
    (form) => spans.some((span) => span.includes(form)) || String(row.term || "").includes(form)
  );
  if (splitHit.length) {
    return {
      rule: "reference-row-spells-a-guide-split-string",
      because:
        `this row spells a word the way the converter used to paste pronunciation guides into it — ` +
        `${JSON.stringify(splitHit[0])} — and the guide-free text volume ${volume} now holds prints the word ` +
        `without the reading inside it. The claim is true; the string the book prints changed (gotcha 123).`,
    };
  }
  return {
    rule: "reference-evidence-does-not-verify",
    because:
      `none of this row's spellings (${tried.join(", ") || row.term}) occurs in volume ${volume}'s source text, ` +
      (governsTried.length
        ? `and none of the passages its notes quote (${governsTried.join(", ")}) occurs there either, `
        : "and its notes quote no passage to govern, ") +
      "so the row supports neither kind of evidence this store accepts.",
  };
}

/**
 * Compare a published glossary against the render of the record that published it.
 *
 * @param {Object} opts
 * @param {string} opts.onDisk - The file the volume folder holds.
 * @param {string} opts.rendered - The file the record renders.
 * @param {string} [opts.volumeDir] - The volume folder, when the lost rows have to be explained.
 * @param {number} [opts.volume]
 * @param {Set<string>} [opts.guideSplitForms]
 * @param {boolean} [opts.explain] - Ask {@link explainAbsentGlossaryRow} for every lost row.
 * @param {Map<string, string>} [opts.expectedReadingCells] - The cell the record says each row's `Readings`
 *   column holds, keyed on `normalizeQuote(term)` — the same call {@link renderGlossary} used, asked of the
 *   same store. Without it the `invented` answer cannot be given, and the result says so.
 * @returns {{
 *   identical: boolean,
 *   onlyHeaderLinesDiffer: boolean,
 *   headerLinesOnDisk: number, headerLinesRendered: number,
 *   linesOnDisk: number, linesRendered: number,
 *   rowsOnDisk: number, rowsRendered: number,
 *   sectionsOnDisk: number, sectionsRendered: number, sectionsLost: string[],
 *   proseLinesOnDisk: number, proseLinesRendered: number, proseLinesLost: string[], proseLinesGained: string[],
 *   lostRows: Array<{term: string, rendering: string, section: string, rule: string|null, because: string|null}>,
 *   gainedRows: Array<{term: string, rendering: string, section: string}>,
 *   changedRows: Array<{term: string, field: string, onDisk: string, rendered: string}>,
 *   readingColumnOnDisk: boolean, readingColumnRendered: boolean,
 *   readingChanges: Array<{term: string, section: string, kind: string, onDisk: string[], rendered: string[], expected: string[]|null, invented: string[], lost: string[], added: string[], expectedAsked: boolean}>,
 *   readingChangesByKind: Record<string, number>,
 *   readingsAsked: boolean,
 *   nonHeaderTextIdentical: boolean,
 * }}
 */
function compareGlossaryRender({
  onDisk,
  rendered,
  volumeDir,
  volume,
  guideSplitForms,
  explain = false,
  expectedReadingCells = null,
}) {
  const a = classifyGlossaryLines(onDisk);
  const b = classifyGlossaryLines(rendered);
  const rowsA = glossaryRowsByKey(onDisk);
  const rowsB = glossaryRowsByKey(rendered);

  const lostRows = [];
  for (const [key, row] of rowsA) {
    if (rowsB.has(key)) continue;
    const explanation =
      explain && volumeDir ? explainAbsentGlossaryRow({ volumeDir, volume, row, guideSplitForms }) : null;
    lostRows.push({
      term: row.term,
      rendering: row.rendering,
      section: row.section,
      rule: explanation ? explanation.rule : null,
      because: explanation ? explanation.because : null,
    });
  }
  const gainedRows = [];
  for (const [key, row] of rowsB) {
    if (rowsA.has(key)) continue;
    gainedRows.push({ term: row.term, rendering: row.rendering, section: row.section });
  }
  const changedRows = [];
  for (const [key, rowA] of rowsA) {
    const rowB = rowsB.get(key);
    if (!rowB) continue;
    for (const field of ["rendering", "notes", "section"]) {
      if (String(rowA[field] || "") !== String(rowB[field] || "")) {
        changedRows.push({ term: rowA.term, field, onDisk: String(rowA[field] || ""), rendered: String(rowB[field] || "") });
      }
    }
  }

  // The reading column, row by row, against the record as well as against the file. A row the two documents
  // do not both hold is already named by lostRows / gainedRows, so this loop answers only the column.
  const readingChanges = [];
  for (const [key, rowA] of rowsA) {
    const rowB = rowsB.get(key);
    if (!rowB) continue;
    // When the caller asked the record, a row the record's own reading query did not answer is a row the
    // record says has NO readings — an empty answer, not an unknown one. Treating it as unknown would make
    // the `invented` refusal quietly switch off for exactly the rows a broken renderer would get wrong.
    const expectedCell = expectedReadingCells ? String(expectedReadingCells.get(key) ?? "") : null;
    const answer = compareReadingCell({
      onDiskCell: rowA.reading,
      renderedCell: rowB.reading,
      expectedCell,
    });
    if (answer.kind === "same") continue;
    readingChanges.push({ term: rowA.term, section: rowA.section, ...answer });
  }
  const readingChangesByKind = {};
  for (const change of readingChanges) {
    readingChangesByKind[change.kind] = (readingChangesByKind[change.kind] || 0) + 1;
  }
  // "This file prints a reading column" is a fact about the table's own header, not about whether any cell
  // is filled: a four-column glossary whose every row says "no reading recorded" HAS the column, and a
  // three-column one does not. Deciding it from the cells would call the first file the second.
  const readingColumnOnDisk = headerDeclaresReadingColumn(a.headers);
  const readingColumnRendered = headerDeclaresReadingColumn(b.headers);

  const sectionsA = a.sections;
  const sectionsB = new Set(b.sections);
  const sectionsLost = sectionsA.filter((line) => !sectionsB.has(line));
  const proseA = a.prose;
  const proseB = b.prose;
  const proseLost = proseA.filter((line) => !proseB.includes(line));
  const proseGained = proseB.filter((line) => !proseA.includes(line));

  const nonHeaderTextIdentical = withoutTableHeaders(onDisk) === withoutTableHeaders(rendered);
  const headerCountMatches = a.headers.length === b.headers.length;
  const rowLinesIdentical = JSON.stringify(a.rows) === JSON.stringify(b.rows);

  return {
    identical: onDisk === rendered,
    // The lossless proof: strip the header lines out of both documents and the rest is the same bytes,
    // and the same number of tables were touched. A rename that also dropped a row fails this.
    onlyHeaderLinesDiffer: onDisk !== rendered && nonHeaderTextIdentical && headerCountMatches,
    headerLinesOnDisk: a.headers.length,
    headerLinesRendered: b.headers.length,
    linesOnDisk: a.lines.length,
    linesRendered: b.lines.length,
    rowsOnDisk: a.rows.length,
    rowsRendered: b.rows.length,
    sectionsOnDisk: sectionsA.length,
    sectionsRendered: b.sections.length,
    sectionsLost,
    proseLinesOnDisk: proseA.length,
    proseLinesRendered: proseB.length,
    proseLinesLost: proseLost,
    proseLinesGained: proseGained,
    lostRows,
    gainedRows,
    changedRows,
    readingColumnOnDisk,
    readingColumnRendered,
    readingChanges,
    readingChangesByKind,
    readingsAsked: expectedReadingCells !== null && expectedReadingCells !== undefined,
    nonHeaderTextIdentical,
    rowLinesIdentical,
  };
}

module.exports = {
  isSeparatorLine,
  classifyGlossaryLines,
  withoutTableHeaders,
  glossaryRowsByKey,
  tableCellCount,
  headerDeclaresReadingColumn,
  readingSetOf,
  compareReadingCell,
  guideSplitFormsOfHarvest,
  explainAbsentGlossaryRow,
  compareGlossaryRender,
};

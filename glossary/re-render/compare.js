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
 * @returns {Map<string, {term: string, rendering: string, notes: string, section: string}>}
 */
function glossaryRowsByKey(markdown) {
  /** @type {Map<string, {term: string, rendering: string, notes: string, section: string}>} */
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
 *   nonHeaderTextIdentical: boolean,
 * }}
 */
function compareGlossaryRender({ onDisk, rendered, volumeDir, volume, guideSplitForms, explain = false }) {
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
    nonHeaderTextIdentical,
    rowLinesIdentical,
  };
}

module.exports = {
  isSeparatorLine,
  classifyGlossaryLines,
  withoutTableHeaders,
  glossaryRowsByKey,
  guideSplitFormsOfHarvest,
  explainAbsentGlossaryRow,
  compareGlossaryRender,
};

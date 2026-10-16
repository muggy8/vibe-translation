/**
 * utils/reference-store/glossary-adapter/render.js — writing the record back out as the published file.
 *
 * The renderer and its cell escaping. Deterministic by construction: the document's own prose first,
 * exactly as it was stored; sections in the order their prose sits in the document; rows in insertion
 * order; one row per term — the one in force at this volume — with the renderings it replaced folded
 * into the Notes cell, what research returned folded in beside them, and the pronunciation guides this
 * record holds folded into the `Readings` cell. Two runs over the same rows are byte-identical.
 *
 * @module utils/reference-store/glossary-adapter/render
 */

const { normalizeQuote } = require("../evidence");
const { DOCUMENT_GLOSSARY, readDocumentProse } = require("../document-prose");
const { researchNotesInRecord, mergeResearchNotes } = require("../research-notes");
const { GLOSSARY_TITLE, GLOSSARY_HEADER, GLOSSARY_NO_READING_CELL } = require("./labels");
const { mergeRevisionHistory } = require("./history");
const { glossaryReadingCellsForRows } = require("./readings");
const { publishedGlossaryRowsInRecord } = require("./rows");
require("../../../types"); // JSDoc type definitions

/**
 * Render a volume's glossary rows back into the file shape.
 *
 * Deterministic by construction: the document's own prose first, exactly as it was stored;
 * then sections in the order their first row was inserted, rows in insertion order, cells
 * escaped the same way every time. Two runs over the same rows are byte-identical (slice 4's
 * second criterion) — including the history line, because it is built from stored columns
 * (`applies_from_volume`, `rendering`) in stored order, not from anything remembered at render time.
 *
 * One row per term, and the row that is **in force at this volume** (see
 * {@link publishedGlossaryRowsInRecord}). What a superseded rendering does is move into the term's Notes
 * cell as `Earlier rendering: "…" (in force from volume N)` — the file keeps the decision this volume
 * made and says out loud what it replaced and from which volume, and the term's own row in the table
 * stays one row, which is what keeps the cumulative gate matching it as carried and keeps the
 * translation stage's terminology law free of two answers to one term.
 *
 * ## The fourth column (plan 09 slice 3b)
 *
 * `Readings` is filled by {@link glossaryReadingCellsForRows} — a query over the record's own
 * `written_forms` rows, asked once for the whole table. It is a query and not a column on the row because
 * a pronunciation guide is a fact about one book's harvest while the row it is printed beside was published
 * by a different volume, and a published row is never edited. The bound is the same one the rows use:
 * `upToVolume` is the volume being rendered, so volume 1's file cannot print a guide volume 1's book never
 * printed. A term the record holds no guide for prints {@link GLOSSARY_NO_READING_CELL} rather than a blank.
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number, title?: string}} [opts] - `title` is only used when the store holds
 *   no prose of its own; a store that imported a titled file renders that title.
 * @returns {string} The file content, ending in a newline.
 * @throws {Error} when the reading column cannot be asked — a render volume later than the record is
 *   refused rather than published with a silently missing column.
 */
function renderGlossary(store, { volume, title = GLOSSARY_TITLE } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const rows = publishedGlossaryRowsInRecord(store, { volume: vol });
  // The reading column, asked once for the whole table rather than once per row. The re-render gate asks
  // the same call against the same store, so the door that writes the cell and the door that checks it
  // cannot hold two opinions about what a row's readings are.
  const readings = glossaryReadingCellsForRows(store, { volume: vol });
  if (!readings.ok) {
    throw new Error(
      `renderGlossary could not fill the ${GLOSSARY_HEADER[2]} column for volume ${vol}: ` +
        `${readings.refusal.rule} — ${readings.refusal.because}`
    );
  }
  const readingCells = readings.cells;
  // The one case where an empty reading column is not a fact about the books. A record written before
  // schema 12 has no `written_forms` table at all, and a file that printed "no reading recorded" on every
  // row of it — with nothing saying so — reads exactly like a series whose author never guided a word.
  // Named here because this is the only door that turns a record into a published glossary, and the doors
  // that render an unmigrated record (the translation stage's terminology law, the settlement pass's render
  // of the series-root file) do not print anything about the column themselves.
  if (readings.totals && readings.totals.tablePresent === false) {
    console.warn(
      `[glossary] volume ${vol}: this record has no \`written_forms\` table, so its ${GLOSSARY_HEADER[2]} column ` +
        `prints "${GLOSSARY_NO_READING_CELL}" on all ${readings.totals.rows} row(s). That is a fact about the record ` +
        `(it predates the table), not about the books. Open it through the store's own door — ` +
        `npx gulp glossary, npm run extract-voice, or npm run re-render-glossary after a stage run — and the ` +
        `guides the extraction harvested reach it.`
    );
  }
  // What research returned for a term, looked up once per term rather than once per row. The merge is a
  // render-time join only: the row's own `body` in the record is never rewritten, because a published row
  // is not edited (AGENTS.md rule 5) and because a note folded into the body would come back through the
  // door that reads a published file into a record and be appended a second time on the next render.
  const notesByTerm = new Map();
  const researchNotes = researchNotesInRecord(store);
  for (const note of researchNotes) {
    const key = normalizeQuote(note.term);
    if (!key) continue;
    if (!notesByTerm.has(key)) notesByTerm.set(key, []);
    notesByTerm.get(key).push(note);
  }

  const proseRows = readDocumentProse(store, DOCUMENT_GLOSSARY);
  const opening = proseRows.filter((row) => row.section === null).map((row) => row.text);
  const sectionProse = new Map();
  for (const row of proseRows) {
    if (row.section === null) continue;
    if (!sectionProse.has(row.section)) sectionProse.set(row.section, { ord: row.ord, lines: [] });
    sectionProse.get(row.section).lines.push(row.text);
  }

  const sections = new Map();
  for (const row of rows) {
    const section = row.section === null || row.section === "" ? "(no section)" : row.section;
    if (!sections.has(section)) sections.set(section, { ord: row.ord, items: [] });
    const term = row.term;
    const rendering = row.rendering;
    // The row's own notes, then the renderings this term used to carry, then what research returned.
    // Both extra halves are render-time joins for the same reason: a published row is never edited, so
    // the history of a term and the notes filed against its term live in their own rows and meet here.
    const withHistory = mergeRevisionHistory(row.notes, row.superseded, { rendering });
    const notes = mergeResearchNotes(withHistory, notesByTerm.get(normalizeQuote(term)) || []);
    const cell = readingCells.get(normalizeQuote(term));
    sections.get(section).items.push({
      term,
      rendering,
      reading: cell ? cell : GLOSSARY_NO_READING_CELL,
      notes,
    });
  }

  // Sections are ordered by where their prose sits in the document, because every section the
  // importer saw has a prose block — even one that is only the blank line before its table — and
  // that is the only record of the document's own order. A section with no prose at all (a store
  // built by insert_fact rather than by import) follows, in the order its first row was inserted.
  const names = new Set([...sections.keys(), ...sectionProse.keys()]);
  const rankOf = (name) => (sectionProse.has(name) ? 0 : 1);
  const ordOf = (name) =>
    sectionProse.has(name)
      ? sectionProse.get(name).ord
      : sections.has(name)
        ? sections.get(name).ord
        : Number.MAX_SAFE_INTEGER;
  const ordered = [...names].sort((a, b) => rankOf(a) - rankOf(b) || ordOf(a) - ordOf(b) || a.localeCompare(b));

  const out = opening.length ? [...opening] : [title, ""];
  for (const name of ordered) {
    out.push(`## ${name}`);
    const prose = sectionProse.get(name);
    if (prose && prose.lines.length) out.push(...prose.lines);
    else out.push("");
    const items = sections.has(name) ? sections.get(name).items : null;
    if (items && items.length) {
      out.push(`| ${GLOSSARY_HEADER.join(" | ")} |`);
      out.push(`|${GLOSSARY_HEADER.map(() => "---").join("|")}|`);
      for (const item of items) {
        // The cells are written in the order the header names them, and the order is one list rather than
        // four hand-written interpolations, so a header line and a data row cannot drift apart by one column.
        out.push(`| ${[item.term, item.rendering, item.reading, item.notes].map(escapeCell).join(" | ")} |`);
      }
    }
    out.push("");
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * Make a value safe for one Markdown table cell: no pipes, no line breaks.
 * @param {string} value
 * @returns {string}
 */
function escapeCell(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

module.exports = {
  renderGlossary,
  escapeCell,
};

/**
 * utils/reference-store/glossary-adapter/readings.js — the glossary's fourth column, built from the
 * record's own written-form rows.
 *
 * Plan 09 slice 3b. `renderGlossary` prints one row per term, and the new column answers one question
 * about that term: **what guides did this book print over this word?** The answer is not on the glossary
 * row and cannot be — a reading is a fact about one volume's harvest, and the row was published by a
 * different volume — so it is a query over `written_forms`, asked through
 * `utils/reference-store/written-forms/readings.js`, the one door that question is asked through.
 *
 * ## Why this file exists instead of doing it inside `render.js`
 *
 * Because two doors have to agree about what the cell says. The renderer writes it, and
 * `glossary/re-render/compare.js` has to know what the cell **should** be in order to refuse a render
 * that loses a reading or invents one. If the renderer formats the cell and the gate re-derives it
 * separately, the gate is a second opinion about the same fact — the failure mode this store keeps paying
 * to avoid (gotcha 117: two doors that read one set differently settle it by table order). So the cell's
 * shape lives here: {@link renderReadingCell} writes it, {@link readingsFromCell} reads it back, and both
 * are the same file.
 *
 * ## What the cell holds
 *
 * Every reading this record holds for **any spelling the row's own term cell names** — a glossary row's
 * first column is often several spellings of one entry (`三つ編み魔王 / 三つ編み悪魔`), and a guide printed
 * over either of them is a guide over this entry. Readings are merged by the reading string, guided
 * occurrences summed, and ordered by {@link foldReadingsByForm}'s rule: most-guided first, then earliest
 * volume, then the reading itself.
 *
 * A reading is never invented here: a term the record holds no written-form row for gets
 * `GLOSSARY_NO_READING_CELL`, which says the record holds nothing rather than that the author guided
 * nothing (plan 09 §5's slice-3b line, and the 1,095 rows the filing door's two row guards refused).
 *
 * **And an empty column is reported with its reason.** `totals.tablePresent` says whether the record has
 * the table at all. A record written before schema 12 — every one of this corpus's 17, until something
 * opens them through the store's own door — has no `written_forms` table, so its render prints the marker
 * on every row while its books printed 45,429 guides. `renderGlossary` prints that fact out loud rather
 * than letting the file stand as if the books had guided nothing.
 *
 * ## The count, and when it is printed
 *
 * When a form carries **more than one** reading, each one carries its guided-occurrence count
 * (`さんしよくいんすみれこ ×289; パンジー ×18; おつぱい ×1`). The count exists to tell the author's habitual
 * guide from a one-off, and that question only exists when there is more than one guide; a single-reading
 * cell stays the bare reading, which is 1,899 of the 2,058 filled cells in the real corpus.
 *
 * **What the cell does not say**: which volume printed a guide. The record says that
 * (`written_forms.volume`), and the re-render report prints it; a glossary cell that listed volumes would
 * be a second copy of a fact the table already owns, in a column a translator scans in one glance.
 *
 * @module utils/reference-store/glossary-adapter/readings
 */

const { normalizeQuote } = require("../evidence");
const { GLOSSARY_NO_READING_CELL } = require("./labels");
const { glossaryTermSpans } = require("./parse");
const { publishedGlossaryRowsInRecord } = require("./rows");
const { readingsForFormsInRecord } = require("../written-forms/readings");
require("../../../types"); // JSDoc type definitions

/** What separates two readings inside one cell. Never a pipe, so the cell cannot split a table row. */
const READING_CELL_SEPARATOR = ";";

/** What marks a reading's guided-occurrence count. Never appears in a guided reading. */
const READING_COUNT_MARK = "×";

/**
 * One guided reading of one glossary entry, as the column publishes it.
 *
 * @typedef {Object} GlossaryReading
 * @property {string} reading - The guide the book printed.
 * @property {number} occurrences - Guided occurrences summed over the volumes this record carries.
 * @property {number} firstVolume - Earliest volume whose harvest recorded it.
 * @property {number} lastVolume - Latest one.
 */

/**
 * Write the reading cell for a list of readings, in the order they were given.
 *
 * One reading → the bare reading. Several → each one carries its count, because the count is what tells
 * the habitual guide from the one-off. No readings → {@link GLOSSARY_NO_READING_CELL}.
 *
 * @param {Array<GlossaryReading>} readings - Already ordered by {@link foldReadingsByForm}'s rule.
 * @returns {string} The cell content (never empty, never containing a pipe).
 */
function renderReadingCell(readings) {
  const list = Array.isArray(readings) ? readings.filter((entry) => entry && entry.reading) : [];
  if (list.length === 0) return GLOSSARY_NO_READING_CELL;
  if (list.length === 1) return list[0].reading;
  // `reading ×7; reading ×2`. The separator hugs the guide it follows, because the cell is a list of guides
  // and a space before the semicolon reads like part of the last one.
  return list
    .map((entry) => `${entry.reading} ${READING_COUNT_MARK}${Number(entry.occurrences) || 0}`)
    .join(`${READING_CELL_SEPARATOR} `);
}

/**
 * Read a reading cell back into the readings it names.
 *
 * The inverse of {@link renderReadingCell}, in the same file so the two cannot drift. The empty marker
 * reads back as no readings — which is what makes "the published file records nothing for this term" and
 * "this term has no column at all" the same answer, and both are honest.
 *
 * @param {string} cell - One row's reading cell ("" for a table that has no such column).
 * @returns {Array<{reading: string, occurrences: number}>}
 */
function readingsFromCell(cell) {
  const text = String(cell || "").trim();
  if (!text || text === GLOSSARY_NO_READING_CELL) return [];
  return text
    .split(READING_CELL_SEPARATOR)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map((piece) => {
      const hit = piece.match(/^(.*?)\s*\u00d7(\d+)$/);
      if (hit) return { reading: hit[1].trim(), occurrences: Number(hit[2]) };
      return { reading: piece, occurrences: 0 };
    })
    .filter((entry) => entry.reading.length > 0);
}

/**
 * The reading cell for every glossary row this record publishes at one volume.
 *
 * One query for the whole table, not one per row: the record's written-form rows are read once, and the
 * renderer and the comparison gate both take their answer from this call, so a render and the gate that
 * checks it cannot disagree about what a row's cell should say.
 *
 * @param {{db: Object, volume: number}} store - The record being rendered.
 * @param {{volume?: number}} [opts] - The volume the render is for. Defaults to the record's own, and is
 *   never allowed past it — {@link readingsForFormsInRecord} refuses that rather than answering with a
 *   fold that reached forward.
 * @returns {{ok: true, volume: number, upToVolume: number, cells: Map<string, string>, rows: Array<{term: string, key: string, cell: string, readings: Array<GlossaryReading>, forms: string[]}>, totals: Object, refusal: null}|{ok: false, volume: number, upToVolume: number, cells: Map<string, string>, rows: [], totals: null, refusal: ReferenceRefusal}}
 *   `cells` maps `normalizeQuote(row.term)` — the same term identity every other door in this folder
 *   matches on — to the **cell text**, which is the one shape both the renderer and the re-render gate
 *   consume; a second shape for the same fact is how a gate ends up comparing an object to a string.
 *   `rows` carries the detail (the readings behind the cell, and the spellings they were looked up under)
 *   for a report that wants to name them. `totals` counts what the column would print, including the rows
 *   it would leave empty and whether the table it read is even present — and `tablePresent` is the query
 *   door's own answer carried through, not a second probe this file runs, because two doors asking
 *   `sqlite_master` about one table is how a store ends up holding two opinions about whether it exists.
 */
function glossaryReadingCellsForRows(store, { volume } = {}) {
  const recordVolume = Number(store && store.volume);
  const vol = Number(volume === undefined ? recordVolume : volume);
  const rows = publishedGlossaryRowsInRecord(store, { volume: vol });

  /** @type {Map<string, {term: string, forms: string[]}>} */
  const rowForms = new Map();
  /** @type {Set<string>} */
  const allForms = new Set();
  for (const row of rows) {
    const key = normalizeQuote(row.term);
    if (!key) continue;
    const forms = glossaryTermSpans(row.term);
    if (!rowForms.has(key)) rowForms.set(key, { term: row.term, forms });
    for (const form of forms) allForms.add(form);
  }

  const asked = readingsForFormsInRecord(store, { upToVolume: vol, forms: [...allForms] });
  if (!asked.ok) {
    return { ok: false, volume: recordVolume, upToVolume: asked.upToVolume, cells: new Map(), rows: [], totals: null, refusal: asked.refusal };
  }

  /** @type {Map<string, Array<{form: string, readings: Array<GlossaryReading>}>} */
  const byForm = new Map();
  for (const entry of asked.forms) byForm.set(entry.form, entry.readings);

  /** @type {Map<string, string>} The cell text, keyed the way every door keys a term. */
  const cells = new Map();
  /** @type {Array<{term: string, key: string, cell: string, readings: Array<GlossaryReading>, forms: string[]}>} */
  const detail = [];
  for (const [key, row] of rowForms) {
    /** @type {Map<string, GlossaryReading>} */
    const merged = new Map();
    for (const form of row.forms) {
      for (const reading of byForm.get(form) || []) {
        const held = merged.get(reading.reading);
        if (held) {
          held.occurrences += reading.occurrences;
          if (reading.firstVolume < held.firstVolume) held.firstVolume = reading.firstVolume;
          if (reading.lastVolume > held.lastVolume) held.lastVolume = reading.lastVolume;
        } else {
          merged.set(reading.reading, {
            reading: reading.reading,
            occurrences: reading.occurrences,
            firstVolume: reading.firstVolume,
            lastVolume: reading.lastVolume,
          });
        }
      }
    }
    const readings = [...merged.values()].sort(
      (a, b) =>
        b.occurrences - a.occurrences ||
        a.firstVolume - b.firstVolume ||
        (a.reading < b.reading ? -1 : a.reading > b.reading ? 1 : 0)
    );
    const cell = renderReadingCell(readings);
    cells.set(key, cell);
    detail.push({ term: row.term, key, cell, readings, forms: row.forms });
  }

  let filled = 0;
  let empty = 0;
  let multi = 0;
  let occurrences = 0;
  for (const entry of detail) {
    if (entry.readings.length > 0) filled += 1;
    else empty += 1;
    if (entry.readings.length > 1) multi += 1;
    for (const reading of entry.readings) occurrences += reading.occurrences;
  }
  return {
    ok: true,
    volume: recordVolume,
    upToVolume: asked.upToVolume,
    cells,
    rows: detail,
    totals: {
      rows: rowForms.size,
      formsAsked: allForms.size,
      formsWithReadings: asked.forms.filter((entry) => entry.readings.length > 0).length,
      rowsFilled: filled,
      rowsEmpty: empty,
      rowsWithSeveralReadings: multi,
      distinctReadings: detail.reduce((sum, entry) => sum + entry.readings.length, 0),
      guidedOccurrences: occurrences,
      tablePresent: asked.totals.tablePresent,
    },
    refusal: null,
  };
}

module.exports = {
  READING_CELL_SEPARATOR,
  READING_COUNT_MARK,
  renderReadingCell,
  readingsFromCell,
  glossaryReadingCellsForRows,
};

/**
 * utils/reference-store/research-notes.js — what research came back, kept as its own record.
 *
 * The question this table exists to answer is slice 5's real question: **a glossary row says what a term
 * means, and a lookup against Wikipedia can add to that — so how does the added part arrive without
 * editing the row it adds to?**
 *
 * The answer is the same shape `attribution_answers` (schema v7) already uses, and for the same reason.
 * A published row is never edited, moved or deleted. What volume 5 learned about 芥川賞 is therefore
 * **its own row**, owned by volume 5, keyed to the term — not a change to the row volume 1 published and
 * sealed. The render is where the two meet: `renderGlossary` prints the row's own notes cell and then the
 * research notes filed against that term, oldest volume first.
 *
 * Three rules this door will not bend:
 *
 *   1. **A note has to attach to a row the record actually holds.** `fileResearchNote` refuses a term the
 *      record has no glossary row for. Research cannot invent an entry; it can only annotate one the
 *      read pass already filed and the evidence rule already checked against the book.
 *   2. **The note is never folded into the row's own body.** It lives in this table and is merged at
 *      render time only. A merge that wrote into `facts.body` would be an edit to a sealed row, and worse
 *      it would be an edit that duplicates: re-importing the rendered file would carry the merged text
 *      back in, and the next render would append the same note again.
 *   3. **Asking is recorded even when nothing was found.** `found = 0` is a row, not a hole. "Nobody
 *      looked" and "somebody looked and Wikipedia has nothing" have to be distinguishable, which is the
 *      same reason `attribution_answers` keeps `unknown`.
 *
 * One row per (asking volume, term), because that is the unit the bound spends: one research turn per
 * term per volume. Re-running the same volume over the same text replaces its own answer rather than
 * stacking a second copy of it.
 *
 * @module utils/reference-store/research-notes
 */

const { normalizeQuote } = require("./evidence");
const { refusal } = require("./refusals");
require("../../types"); // JSDoc type definitions

/** The table, named once so every reader of it uses the same spelling. */
const RESEARCH_NOTES_TABLE = "research_notes";

/**
 * How long one research note may be, in characters.
 *
 * The note lands in a Markdown table cell of the published glossary. A lookup that returns a paragraph
 * would turn a three-column table into a wall of text the acceptance grader has to wade through, so the
 * note is bounded at filing rather than truncated at render — the model is asked for 1–3 sentences and
 * this is where that ask is enforced.
 */
const RESEARCH_NOTE_MAX_CHARS = 600;

/**
 * Find the glossary row this record holds for a term, by the term's own identity.
 *
 * The same identity `documentTermAlreadyStored` uses — the first spelling in the row's `examples`,
 * whitespace-normalised — because "the row this note belongs to" has to mean the same thing the filing
 * doors mean by "the record already has this term".
 *
 * @param {Object} db - An open store handle.
 * @param {string} term - The term the note is about.
 * @returns {{id: string, section: string|null, establishedVolume: number}|null} The row, or null.
 */
function findGlossaryRowForTerm(db, term) {
  const needle = normalizeQuote(term);
  if (!needle) return null;
  const rows = db
    .prepare("SELECT id, section, examples, established_volume FROM facts WHERE aspect = 'term_usage' AND source_stage != 'extract'")
    .all();
  for (const row of rows) {
    let spans = [];
    try {
      spans = JSON.parse(row.examples || "[]");
    } catch {
      continue;
    }
    if (!Array.isArray(spans)) continue;
    if (normalizeQuote(String(spans[0] || "")) === needle) {
      return { id: row.id, section: row.section || null, establishedVolume: Number(row.established_volume) };
    }
  }
  return null;
}

/**
 * File what one research turn brought back, as a row of its own.
 *
 * @param {{db: Object, volume: number|string, scope?: {volume: number, stage: string}}} store - The asking volume's open record.
 * @param {{term: string, found: boolean, page?: string|null, lang?: string|null, url?: string|null, note: string}} answer
 *   What the lookup and the reading call returned. `found` false with a note saying so is a real answer.
 * @param {{volume?: number}} [opts] - The asking volume, when it is not the record's own.
 * @returns {{ok: boolean, filed: Object|null, replaced: boolean, refusal: ReferenceRefusal|null}}
 */
function fileResearchNote(store, answer, { volume } = {}) {
  const askedBy = Number(volume === undefined ? store.volume : volume);
  const term = String((answer && answer.term) || "").trim();
  const note = String((answer && answer.note) || "").trim();
  const found = !!(answer && answer.found);

  if (!term) {
    return {
      ok: false,
      filed: null,
      replaced: false,
      refusal: refusal({
        verb: "file_research_note",
        rule: "research-note-has-no-term",
        because: "a research note arrived with no term, so there is nothing to attach it to.",
        fix: "the research pass files one note per term it asked about; name the term.",
      }),
    };
  }
  if (!note) {
    return {
      ok: false,
      filed: null,
      replaced: false,
      refusal: refusal({
        verb: "file_research_note",
        rule: "research-note-has-no-text",
        because:
          `"${term}": the lookup returned no note at all. A row that says nothing is indistinguishable from ` +
          "a row nobody wrote, which is the difference this table exists to record.",
        fix: "the reading call has to return a `note` — even when it is \"no page matched this term\".",
      }),
    };
  }
  if (note.length > RESEARCH_NOTE_MAX_CHARS) {
    return {
      ok: false,
      filed: null,
      replaced: false,
      refusal: refusal({
        verb: "file_research_note",
        rule: "research-note-too-long",
        because:
          `"${term}": the note is ${note.length} characters, and the cap is ${RESEARCH_NOTE_MAX_CHARS}. ` +
          "This text lands in a cell of the published glossary; a paragraph per row makes the table unreadable " +
          "to the grader that has to judge it.",
        fix: "ask the reading call for 1–3 sentences, as its prompt already says.",
      }),
    };
  }

  const row = findGlossaryRowForTerm(store.db, term);
  if (!row) {
    return {
      ok: false,
      filed: null,
      replaced: false,
      refusal: refusal({
        verb: "file_research_note",
        rule: "research-note-has-no-row",
        because:
          `volume ${askedBy}'s record holds no glossary row for "${term}", so there is nothing this note ` +
          "belongs to. Research annotates an entry the read pass filed and the evidence rule checked; it does " +
          "not create one.",
        fix: "file the term as a glossary row first (`fileGlossaryTermRows`), or drop it from the research list.",
      }),
    };
  }

  const stage = (store.scope && store.scope.stage) || "import";
  const existing = store.db
    .prepare(`SELECT term FROM ${RESEARCH_NOTES_TABLE} WHERE asked_by_volume = ? AND term = ?`)
    .get(askedBy, term);

  store.db
    .prepare(
      `INSERT INTO ${RESEARCH_NOTES_TABLE} (term, term_fact_id, section, found, page, lang, url, note, asked_by_volume, asked_by_stage, asked_at) ` +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(asked_by_volume, term) DO UPDATE SET term_fact_id = excluded.term_fact_id, " +
        "section = excluded.section, found = excluded.found, page = excluded.page, lang = excluded.lang, " +
        "url = excluded.url, note = excluded.note, asked_by_stage = excluded.asked_by_stage, asked_at = excluded.asked_at"
    )
    .run(
      term,
      row.id,
      row.section,
      found ? 1 : 0,
      String((answer && answer.page) || "").trim() || null,
      String((answer && answer.lang) || "").trim() || null,
      String((answer && answer.url) || "").trim() || null,
      note,
      askedBy,
      stage,
      new Date().toISOString()
    );

  return {
    ok: true,
    filed: {
      term,
      termFactId: row.id,
      section: row.section,
      found,
      page: String((answer && answer.page) || "").trim() || null,
      lang: String((answer && answer.lang) || "").trim() || null,
      url: String((answer && answer.url) || "").trim() || null,
      note,
      askedByVolume: askedBy,
    },
    replaced: !!existing,
    refusal: null,
  };
}

/**
 * Every research note this record holds for one term, oldest asking volume first.
 *
 * @param {{db: Object}} store
 * @param {string} term
 * @returns {Array<{term: string, found: boolean, page: string|null, lang: string|null, url: string|null, note: string, askedByVolume: number, section: string|null}>}
 */
function researchNotesForTerm(store, term) {
  const rows = store.db
    .prepare(`SELECT * FROM ${RESEARCH_NOTES_TABLE} WHERE term = ? ORDER BY asked_by_volume, term`)
    .all(String(term || ""));
  return rows.map(researchNoteFromRow);
}

/**
 * Every research note filed by one volume (or every note in the record, when no volume is given).
 *
 * @param {{db: Object}} store
 * @param {{volume?: number|string}} [opts]
 * @returns {Array<Object>} The notes, ordered by asking volume then term.
 */
function researchNotesInRecord(store, { volume } = {}) {
  const rows =
    volume === undefined
      ? store.db.prepare(`SELECT * FROM ${RESEARCH_NOTES_TABLE} ORDER BY asked_by_volume, term`).all()
      : store.db.prepare(`SELECT * FROM ${RESEARCH_NOTES_TABLE} WHERE asked_by_volume = ? ORDER BY term`).all(Number(volume));
  return rows.map(researchNoteFromRow);
}

/**
 * One `research_notes` row, in the shape the rest of the layer uses.
 *
 * @param {Object} row - A raw SQLite row.
 * @returns {{term: string, found: boolean, page: string|null, lang: string|null, url: string|null, note: string, askedByVolume: number, section: string|null, termFactId: string}}
 */
function researchNoteFromRow(row) {
  return {
    term: row.term,
    found: Number(row.found) === 1,
    page: row.page || null,
    lang: row.lang || null,
    url: row.url || null,
    note: row.note,
    askedByVolume: Number(row.asked_by_volume),
    section: row.section || null,
    termFactId: row.term_fact_id,
  };
}

/**
 * The text one research note becomes inside a glossary row's Notes cell.
 *
 * No pipes: `|` is the column separator, and an escaped `\|` round-trips through the parser as a stray
 * backslash, so a note that used one would change the file on the next import.
 *
 * @param {{found: boolean, page: string|null, lang: string|null, url: string|null, note: string, askedByVolume: number}} note
 * @returns {string} e.g. `Research (v3): 芥川賞 (ja, https://…) — Japan's premier literary prize.`
 */
function researchNoteFragment(note) {
  const head = `Research (v${note.askedByVolume})`;
  if (!note.found) return `${head}: ${note.note}`;
  const where = [note.lang, note.url].filter(Boolean).join(", ");
  const label = [note.page, where].filter(Boolean).join(", ");
  return label ? `${head}: ${label} — ${note.note}` : `${head}: ${note.note}`;
}

/**
 * Merge a term's research notes into its row's Notes cell.
 *
 * Render-time only, and idempotent: a fragment already present in the cell is not appended again. That
 * matters because a published file can be read back into a record (`ensureVolumeGlossaryInRecord`), and a
 * renderer that appended blindly would stack a second copy of the same note on the next render.
 *
 * @param {string} body - The row's own notes cell, as the record holds it.
 * @param {Array<Object>} notes - The term's research notes, oldest first.
 * @returns {string} The cell to print.
 */
function mergeResearchNotes(body, notes) {
  let cell = String(body || "").trim();
  for (const note of Array.isArray(notes) ? notes : []) {
    const fragment = researchNoteFragment(note);
    if (cell.includes(fragment)) continue;
    cell = cell ? `${cell}; ${fragment}` : fragment;
  }
  return cell;
}

module.exports = {
  RESEARCH_NOTES_TABLE,
  RESEARCH_NOTE_MAX_CHARS,
  findGlossaryRowForTerm,
  fileResearchNote,
  researchNotesForTerm,
  researchNotesInRecord,
  researchNoteFragment,
  mergeResearchNotes,
};

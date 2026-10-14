/**
 * utils/reference-store/glossary-adapter/import-extraction.js — filing what this volume's read pass
 * found as published glossary rows.
 *
 * The row one `glossary-new-terms.json` entry becomes, and the door that files it. This is not
 * `importNewTerms`: that door files `source_stage = 'extract'` candidates which are deliberately NOT
 * rendered, and this one files the published half under the handle's own document stage. The evidence
 * rule is the same `findRowEvidence` `importGlossary` runs, and a row whose rendering column would be
 * empty is refused rather than published as a word on a list.
 *
 * @module utils/reference-store/glossary-adapter/import-extraction
 */

const { EXTRACTION_TYPE_TO_SECTION, EXTRACTION_FALLBACK_SECTION, GLOSSARY_CHARACTER_SECTION } = require("./labels");
const { glossaryTermSpans } = require("./parse");
const { findRowEvidence } = require("./quote-evidence");
const { documentTermAlreadyStored } = require("./rows");
require("../../../types"); // JSDoc type definitions

/**
 * The glossary row one term-extraction entry becomes.
 *
 * `term` is the source-language spelling, `rendering` the canonical target-language one, `notes` the
 * remark the read pass wrote about it. All three are the columns the published file has; a row that
 * cannot fill the middle one is not a glossary entry, it is a word on a list, and
 * `importGlossaryExtraction` refuses it rather than publishing an empty cell.
 *
 * @param {Object} entry - One `glossary-new-terms.json` element.
 * @returns {{term: string, rendering: string, notes: string, section: string, type: string}|null}
 *   Null when the entry names no term at all.
 */
function glossaryRowFromExtraction(entry) {
  if (!entry || typeof entry !== "object") return null;
  const term = typeof entry.term === "string" ? entry.term.trim() : "";
  if (!term) return null;
  const type = typeof entry.type === "string" && entry.type.trim() ? entry.type.trim().toLowerCase() : "concept";
  const declared = typeof entry.section === "string" && entry.section.trim() ? entry.section.trim() : null;
  return {
    term,
    rendering: typeof entry.rendering === "string" ? entry.rendering.trim() : "",
    notes: typeof entry.note === "string" ? entry.note.trim() : "",
    section: declared || EXTRACTION_TYPE_TO_SECTION[type] || EXTRACTION_FALLBACK_SECTION,
    type,
  };
}

/**
 * File this volume's extracted terms into its record **as glossary rows** — the rows `renderGlossary`
 * publishes.
 *
 * This is not `importNewTerms`, and it is not a replacement for it. `importNewTerms` files the same
 * terms as `source_stage: "extract"` candidates, which are deliberately NOT rendered and NOT counted as
 * document content: that is the line that keeps "the glossary covers this term" a question about the
 * published document rather than about whether an extractor happened to notice the word. This door
 * files the published half, under the handle's own document stage, exactly as `rebuild.js` files the
 * adopted voice claims beside the extraction candidates it copied (gotcha 98). A record that holds both
 * is a record that can answer "what did the read pass find, and what did the glossary publish?" — and
 * the difference between the two numbers is the audit's, not a validator agent's.
 *
 * Three rules it will not bend:
 *
 *   - **The same evidence rule.** A row is filed only when one of its spellings, its rendering, or a
 *     passage its note quotes is a line this volume's own chapter files print. `findRowEvidence` is the
 *     one implementation, shared with `importGlossary`.
 *   - **A row with no target-language rendering is refused, not filed empty.** The published file's
 *     middle column is the artifact's whole point — the canonical rendering a translator must use. A
 *     row that cannot fill it is a term on a list, and publishing it as a glossary entry would let the
 *     stage report success while shipping a table with an empty column. The refusal names the read pass
 *     as the thing that owes the rendering, because that is who has to fix it.
 *   - **A term the record already holds is carried, not amended.** Same door as `importGlossary`
 *     (`documentTermAlreadyStored`), same reason: a row belongs to the volume that wrote it, and after
 *     that volume is sealed it is contested or superseded, never edited.
 *
 * @param {ReferenceStore} store - Opened with a document-scoped handle, which is what a rendered row needs.
 * @param {Array<Object>} entries - The parsed `glossary-new-terms.json` array.
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, imported: Array<Object>, importedCount: number, carried: Array<string>, refused: Array<{row: Object|null, term: string, because: string}>, castRegistered: number, missingRendering: Array<string>}}
 */
function importGlossaryExtraction(store, entries, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const listed = store.listChapters();
  const chapters = listed.chapters;

  const imported = [];
  const refused = [];
  const carried = [];
  const missingRendering = [];
  let castRegistered = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const row = glossaryRowFromExtraction(entry);
    if (!row) {
      refused.push({ row: null, term: "", because: "the new-terms file contained an entry with no term." });
      continue;
    }
    if (documentTermAlreadyStored(store, row.term)) {
      carried.push(row.term);
      continue;
    }
    if (!row.rendering) {
      missingRendering.push(row.term);
      refused.push({
        row,
        term: row.term,
        because:
          `"${row.term}" came back from this volume's read pass with no target-language rendering, and a ` +
          `glossary row whose rendering column is empty is a word on a list, not a decision a translator ` +
          `can use. The read call owes the rendering; the render cannot invent one.`,
      });
      continue;
    }

    const { evidence, kind, tried, governsTried } = findRowEvidence(store.volumeDir, chapters, vol, row);
    if (!evidence) {
      refused.push({
        row,
        term: row.term,
        because:
          `none of this row's spellings (${tried.join(", ") || row.term}) occurs in volume ${vol}'s source text, ` +
          (governsTried.length
            ? `and none of the passages its notes quote (${governsTried.join(", ")}) occurs there either, `
            : "and its notes quote no passage to govern, ") +
          "so the row supports neither kind of evidence this store accepts.",
      });
      continue;
    }

    // A row under the Characters section IS this volume's roster, same as an authored glossary's
    // Characters row: the coverage guard counts rows in `cast`, and a character the glossary names but
    // the cast does not hold is a character the coverage question cannot ask about.
    if ((row.section || "").trim().toLowerCase() === GLOSSARY_CHARACTER_SECTION.toLowerCase()) {
      const spans = glossaryTermSpans(row.term);
      const registered = store.upsertCast({ key: spans[0] || row.term, aliases: spans.slice(1), firstSeenVolume: vol });
      if (registered.ok) castRegistered += 1;
    }

    const result = store.insertFact({
      key: null,
      aspect: "term_usage",
      label: row.type,
      section: row.section,
      body: row.notes || row.rendering,
      examples: [row.term, row.rendering],
      evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
    });
    if (!result.ok) {
      refused.push({ row, term: row.term, because: result.refusal ? result.refusal.because : "insert refused" });
      continue;
    }
    imported.push(result.fact);
    void kind;
  }

  return {
    ok: refused.length === 0,
    imported,
    importedCount: imported.length,
    carried,
    refused,
    castRegistered,
    missingRendering,
  };
}

module.exports = {
  glossaryRowFromExtraction,
  importGlossaryExtraction,
};

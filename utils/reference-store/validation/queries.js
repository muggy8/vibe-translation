/**
 * utils/reference-store/validation/queries.js — asking the record what it is missing.
 *
 * Seven questions, each one a query over this volume's `series.db` and nothing else: which extraction
 * claims the published document says nothing about, which extraction terms the glossary has no row for,
 * which cast entries this volume's own text does not contain, how this volume's reference came to exist,
 * and which sections this volume's record added to each of the two artifacts. None of them decides a
 * severity — they return rows, `integrity.js` turns the ones that mean damage into findings, and
 * `report.js` prints the rest.
 *
 * @module utils/reference-store/validation/queries
 */

const { EXTRACTION_SOURCE_STAGE } = require("../schema");
const { DOCUMENT_VOICE, documentRebuilt } = require("../document-prose");
const { normalizeQuote } = require("../evidence");
require("../../../types"); // JSDoc type definitions

/**
 * Claims this volume's extraction filed that the published document says nothing about.
 *
 * The comparison is by character and kind of claim, not by wording: the extractor's sentence and
 * the author agent's sentence are not the same sentence, and matching them literally would report
 * every rewording as a loss. What is asked is the question that matters — **does the reference say
 * anything of this kind about this character at all** — and only rows that came from the document
 * count as an answer (see `schema.js`'s `EXTRACTION_SOURCE_STAGE`).
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number}} [opts]
 * @returns {Array<{key: string, aspect: string, label: string|null, body: string, id: string}>}
 */
function unadoptedVoiceClaims(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  return store.db
    .prepare(
      "SELECT e.id AS id, e.key AS key, e.aspect AS aspect, e.label AS label, e.body AS body FROM facts e " +
        "WHERE e.owner_volume = ? AND e.source_stage = ? AND e.key IS NOT NULL " +
        "AND NOT EXISTS (SELECT 1 FROM facts d WHERE d.source_stage != ? AND d.key = e.key AND d.aspect = e.aspect) " +
        "ORDER BY e.key, e.aspect, e.ord"
    )
    .all(vol, EXTRACTION_SOURCE_STAGE, EXTRACTION_SOURCE_STAGE);
}

/**
 * Terms this volume's extraction found that the glossary has no row for.
 *
 * Matched on the term itself, normalized the way the store matches quotes. A term the glossary
 * already carries under a different section is not a loss.
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number}} [opts]
 * @returns {Array<{id: string, term: string, label: string|null}>}
 */
function unadoptedTerms(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const extracted = store.db
    .prepare(
      "SELECT id, examples, label FROM facts WHERE owner_volume = ? AND source_stage = ? AND aspect = 'term_usage' ORDER BY ord"
    )
    .all(vol, EXTRACTION_SOURCE_STAGE);
  const carried = new Set();
  for (const row of store.db
    .prepare("SELECT examples FROM facts WHERE source_stage != ? AND aspect = 'term_usage'")
    .all(EXTRACTION_SOURCE_STAGE)) {
    const term = firstSpan(row.examples);
    if (term) carried.add(normalizeQuote(term));
  }
  const out = [];
  for (const row of extracted) {
    const term = firstSpan(row.examples);
    if (!term) continue;
    if (carried.has(normalizeQuote(term))) continue;
    out.push({ id: row.id, term, label: row.label });
  }
  return out;
}

/**
 * The first quoted span of a row's `examples` column, which is where both adapters put the term.
 * @param {string} examples
 * @returns {string|null}
 */
function firstSpan(examples) {
  try {
    const parsed = JSON.parse(examples || "[]");
    const first = Array.isArray(parsed) ? parsed[0] : null;
    return typeof first === "string" && first.trim() ? first.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The cast entries this volume's own text does not contain.
 *
 * Not damage — the account owner's rule is that a character with no lines in a volume is left
 * alone, and their existing claims are not touched. The report says so out loud, because the
 * difference between "the reference lost this character" and "this character is not in the book"
 * is the whole content of the coverage question, and a reader of the report should not have to
 * work it out.
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number}} [opts]
 * @returns {Array<{key: string, display: string}>}
 */
function absentCharacters(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  if (!store.presenceMeasured(vol)) return [];
  const displayFor = store.db.prepare("SELECT display FROM cast WHERE key = ?");
  return store
    .castPresence(vol)
    .filter((row) => row.present === 0)
    .map((row) => {
      const found = displayFor.get(row.key);
      return { key: row.key, display: (found && found.display) || row.key };
    });
}

/**
 * How this volume's character-voice reference came to exist.
 *
 * Returns null when nothing rebuilt it — which is the normal case, and the case the report should not
 * mention. When it returns something, the reference in this record was adopted from the volume's
 * extraction output by code, and nobody reviewed it. The finding that says so lives in `integrity.js`,
 * with the other questions about how a row got into the record; this is the read half, for the report.
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number, document?: string}} [opts]
 * @returns {{at: string, filed: number, carried: number, refused: number, characters: number}|null}
 */
function rebuildProvenance(store, { volume, document = DOCUMENT_VOICE } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  return documentRebuilt(store, document, vol);
}

/**
 * The section headings this volume's own record added, for the voice reference.
 *
 * `owner_volume` is the volume that wrote the row, and copy-forward leaves it on the earlier
 * volume, so this is "what this volume added" rather than "what this volume's file contains".
 *
 * @param {ReferenceStore} store
 * @returns {string[]}
 */
function voiceNewestSections(store) {
  return store.db
    .prepare(
      "SELECT DISTINCT c.display AS display FROM facts f JOIN cast c ON c.key = f.key " +
        "WHERE f.owner_volume = ? AND f.source_stage != ? AND c.merged_into IS NULL"
    )
    .all(store.volume, EXTRACTION_SOURCE_STAGE)
    .map((row) => row.display);
}

/**
 * The section headings this volume's own record added, for the glossary.
 * @param {ReferenceStore} store
 * @returns {string[]}
 */
function glossaryNewestSections(store) {
  return store.db
    .prepare(
      "SELECT DISTINCT section FROM facts WHERE aspect = 'term_usage' AND owner_volume = ? AND source_stage != ? AND section IS NOT NULL"
    )
    .all(store.volume, EXTRACTION_SOURCE_STAGE)
    .map((row) => row.section);
}

module.exports = {
  unadoptedVoiceClaims,
  unadoptedTerms,
  firstSpan,
  absentCharacters,
  rebuildProvenance,
  voiceNewestSections,
  glossaryNewestSections,
};

/**
 * utils/reference-store/document-prose.js — the words a document has that are not rows.
 *
 * Both cumulative artifacts open with prose — the glossary with a title line and two
 * style-policy paragraphs, the character-voice reference with a preamble — and the glossary has
 * prose **inside a section** too (volume 01's `## Real-World References` explains how its rows
 * are indexed before its table starts). Slice 4 parsed the opening and threw it away, and that
 * is half of why the rendered glossary did not diff clean against the real file (review 05 §3.4).
 *
 * The rule this module enforces is small and worth stating: **the prose is stored verbatim and
 * rendered back verbatim.** It is not parsed into meaning, not summarised, not re-flowed, and
 * blank lines are kept because they are part of the document. The store holds claims with
 * evidence; a preamble is not a claim, so it is kept as the ordered text it is and nothing more.
 * That is also what makes the round trip byte-identical: the only transformation applied on the
 * way out is the one applied on the way in.
 *
 * Prose is therefore addressed by (document, section, order): `section` is null for the
 * document's own opening and the heading's text for a paragraph that belongs to one section.
 *
 * @module utils/reference-store/document-prose
 */

require("../../types"); // JSDoc type definitions

/** The document key for a volume's glossary. */
const DOCUMENT_GLOSSARY = "glossary";

/** The document key for a volume's character-voice reference. */
const DOCUMENT_VOICE = "character-voice";

/** The two kinds of document prose the store distinguishes. */
const PROSE_KINDS = ["title", "preamble"];

/**
 * Replace one document's prose with the blocks just parsed.
 *
 * Replace, not append: the prose is a rendering of the document as it stands, and a second
 * import of a re-written file must not leave the previous file's paragraphs behind.
 *
 * @param {{db: Object}} ctx
 * @param {string} document - `DOCUMENT_GLOSSARY` or `DOCUMENT_VOICE`.
 * @param {Array<{section: string|null, kind?: "title"|"preamble", lines: string[]}>} blocks
 *   In document order. The first block is normally the opening (title + preamble, `section: null`);
 *   later blocks are the prose a section carries before its table or its bullets.
 * @returns {{stored: number}} How many rows the document now has.
 */
function storeDocumentProse(ctx, document, blocks) {
  const db = ctx.db;
  db.prepare("DELETE FROM document_prose WHERE document = ?").run(document);
  const insert = db.prepare(
    "INSERT INTO document_prose (document, ord, kind, section, text) VALUES (?,?,?,?,?)"
  );
  let ord = 0;
  let stored = 0;
  for (const block of blocks || []) {
    const section = block.section === null || block.section === undefined ? null : String(block.section);
    for (const line of block.lines || []) {
      if (line === null || line === undefined) continue;
      const kind = ord === 0 && block.kind === "title" ? "title" : "preamble";
      insert.run(document, ord, kind, section, String(line));
      ord += 1;
      stored += 1;
    }
  }
  return { stored };
}

/**
 * One document's prose, in the order it was written.
 *
 * @param {{db: Object}} ctx
 * @param {string} document
 * @returns {Array<{document: string, ord: number, kind: "title"|"preamble", section: string|null, text: string}>}
 */
function readDocumentProse(ctx, document) {
  return ctx.db
    .prepare("SELECT document, ord, kind, section, text FROM document_prose WHERE document = ? ORDER BY ord")
    .all(document);
}

/**
 * The prose grouped back into blocks: the document's opening, then one entry per section.
 *
 * @param {{db: Object}} ctx
 * @param {string} document
 * @returns {{opening: string[], sections: Map<string, string[]>}}
 */
function documentProseBlocks(ctx, document) {
  const opening = [];
  const sections = new Map();
  for (const row of readDocumentProse(ctx, document)) {
    if (row.section === null) {
      opening.push(row.text);
      continue;
    }
    if (!sections.has(row.section)) sections.set(row.section, []);
    sections.get(row.section).push(row.text);
  }
  return { opening, sections };
}

/**
 * The prose as the lines of the file, verbatim.
 *
 * @param {{db: Object}} ctx
 * @param {string} document
 * @returns {string[]} Empty when the store holds none — the caller then falls back to its
 *   default title, so a store built by hand still renders something.
 */
function renderDocumentProse(ctx, document) {
  return readDocumentProse(ctx, document).map((row) => row.text);
}

/**
 * Record that one volume's record now holds a mirror of a published document.
 *
 * This is a marker, not a claim: it says the import ran, not that anything in the document is true.
 * The integrity queries need it because two of their questions are only meaningful afterwards —
 * "does the character-voice reference cover the roster?" cannot be asked of a volume whose reference
 * has not been read into the record yet, and a HIGH finding that fires on every volume before its
 * voice stage runs is a finding people learn to ignore. A volume whose voice stage never ran is
 * caught by the sealing check instead, which is the check that has teeth.
 *
 * @param {{db: Object}} ctx
 * @param {string} document - `DOCUMENT_GLOSSARY` or `DOCUMENT_VOICE`.
 * @param {number} volume
 * @returns {void}
 */
function markDocumentMirrored(ctx, document, volume) {
  ctx.db
    .prepare("INSERT INTO store_info (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(mirrorMarkerKey(document, volume), new Date().toISOString());
}

/**
 * Whether a volume's record holds a mirror of a document.
 *
 * @param {{db: Object}} ctx
 * @param {string} document
 * @param {number} volume
 * @returns {boolean}
 */
function documentMirrored(ctx, document, volume) {
  return Boolean(ctx.db.prepare("SELECT value FROM store_info WHERE key = ?").get(mirrorMarkerKey(document, volume)));
}

/**
 * The marker's key. One place so a typo cannot make a mirrored volume look unmirrored.
 * @param {string} document
 * @param {number} volume
 * @returns {string}
 */
function mirrorMarkerKey(document, volume) {
  return `mirrored_${document}_${Number(volume)}`;
}

/**
 * Record that one volume's document was **rebuilt by code** rather than written by an author agent.
 *
 * A marker, like the mirror marker, and for the same reason: the audit has to be able to answer "how
 * did this volume's reference come to exist?" without guessing. A reference rebuilt from a volume's
 * extraction output is a legitimate artifact and a legitimate record, and it is also a reference nobody
 * reviewed — so the difference has to be in the file, where every later audit reads it, rather than in
 * a log line nobody keeps. The detail is stored as JSON so the report can quote the counts.
 *
 * @param {{db: Object}} ctx
 * @param {string} document - `DOCUMENT_GLOSSARY` or `DOCUMENT_VOICE`.
 * @param {number} volume
 * @param {Object} detail - What the rebuild did, for the report.
 * @returns {void}
 */
function markDocumentRebuilt(ctx, document, volume, detail = {}) {
  ctx.db
    .prepare("INSERT INTO store_info (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(rebuildMarkerKey(document, volume), JSON.stringify({ at: new Date().toISOString(), ...detail }));
}

/**
 * Whether a volume's document was rebuilt, and what the rebuild recorded.
 *
 * @param {{db: Object}} ctx
 * @param {string} document
 * @param {number} volume
 * @returns {{at: string, filed: number, carried: number, refused: number, characters: number, povUnattached?: number, mirrorRowsRemoved?: number, candidatesFiled?: number, candidatesRefused?: number}|null}
 *   Null when the document was not rebuilt.
 */
function documentRebuilt(ctx, document, volume) {
  const row = ctx.db.prepare("SELECT value FROM store_info WHERE key = ?").get(rebuildMarkerKey(document, volume));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // A marker this layer cannot read is reported as no marker rather than as a crash; the audit's
    // own rebuild question then says nothing, which is the failure mode worth noticing.
    return null;
  }
}

/**
 * The rebuild marker's key. One place, for the same reason the mirror marker is one place.
 * @param {string} document
 * @param {number} volume
 * @returns {string}
 */
function rebuildMarkerKey(document, volume) {
  return `rebuilt_${document}_${Number(volume)}`;
}

/**
 * Record that this volume's glossary rows were put into its record by the completeness rule rather
 * than by the glossary stage working on that volume.
 *
 * The rows themselves are stamped `import` either way — they are read out of the published document —
 * so the stamp cannot carry this distinction. The marker does: it says *why* the record has them, and
 * the audit report prints it. Without it, a record whose glossary arrived because the stage skipped
 * looks identical to one whose glossary the stage just built, and "this volume contributed nothing"
 * is the silence this rule exists to end.
 *
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @param {{imported: number, carried: number, refused: number, artifact: string}} detail
 * @returns {void}
 */
function markGlossaryBackfilled(ctx, volume, detail) {
  ctx.db
    .prepare("INSERT INTO store_info (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`glossary_backfilled_${Number(volume)}`, JSON.stringify({ at: new Date().toISOString(), ...detail }));
}

/**
 * Read that marker.
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @returns {{at: string, imported: number, carried: number, refused: number, artifact: string}|null}
 */
function glossaryBackfilled(ctx, volume) {
  const row = ctx.db.prepare("SELECT value FROM store_info WHERE key = ?").get(`glossary_backfilled_${Number(volume)}`);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The numbers half of "how this reference was written", read out of a rebuild marker.
 *
 * Two pairs of numbers live in a marker and they are not the same question. `filed` is what **this run**
 * added; `adoptedClaims` is what the **record** holds when the run is finished. A rebuild run a second
 * time over its own output files nothing, so quoting `filed` about a record that holds 214 claims across
 * 8 characters reports an empty reference. The record's number wins, and the run's number is the fallback
 * for a marker written before the distinction existed.
 *
 * One function because the audit finding and the audit report both say this sentence, and two places that
 * compute the same sentence drift into two answers.
 *
 * @param {Object} marker - A rebuild marker: `documentRebuilt`'s or `rebuiltDocuments`' row.
 * @returns {{claims: number, characters: number, unkeyed: number, refused: number, candidates: number|null, candidatesRefused: number, fromRecord: boolean}}
 *   `candidates: null` when the marker predates candidate copies, which is the case the report stays
 *   silent about rather than reporting zero.
 */
function rebuildProvenanceCounts(marker) {
  const adoptedClaims = Number(marker && marker.adoptedClaims);
  const adoptedCharacters = Number(marker && marker.adoptedCharacters);
  const candidateClaims = Number(marker && marker.candidateClaims);
  const candidatesFiled = Number(marker && marker.candidatesFiled);
  const fromRecord = Number.isFinite(adoptedClaims);
  return {
    claims: fromRecord ? adoptedClaims : Number((marker && marker.filed) || 0),
    characters: Number.isFinite(adoptedCharacters) ? adoptedCharacters : Number((marker && marker.characters) || 0),
    unkeyed: Number((marker && marker.adoptedUnkeyed) || 0),
    refused: Number((marker && marker.refused) || 0),
    candidates: Number.isFinite(candidateClaims)
      ? candidateClaims
      : Number.isFinite(candidatesFiled)
        ? candidatesFiled
        : null,
    candidatesRefused: Number((marker && marker.candidatesRefused) || 0),
    fromRecord,
  };
}

module.exports = {
  DOCUMENT_GLOSSARY,
  DOCUMENT_VOICE,
  PROSE_KINDS,
  storeDocumentProse,
  readDocumentProse,
  documentProseBlocks,
  renderDocumentProse,
  markDocumentMirrored,
  documentMirrored,
  markDocumentRebuilt,
  documentRebuilt,
  rebuildProvenanceCounts,
  markGlossaryBackfilled,
  glossaryBackfilled,
};

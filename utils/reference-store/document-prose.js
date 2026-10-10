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
};

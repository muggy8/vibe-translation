/**
 * utils/reference-store/glossary-adapter/import-document.js — importing a published glossary file
 * into a volume's record.
 *
 * The document door, in its fixed order: store the file's own prose so the renderer can put it back
 * verbatim, register each Characters row in the cast, file each row with evidence discovered from
 * this volume's source text or refuse and report it, and apply the alias declarations the Characters
 * rows carry. A row the record already holds is counted as carried, and that test is asked BEFORE
 * the evidence test on purpose.
 *
 * @module utils/reference-store/glossary-adapter/import-document
 */

const { DOCUMENT_GLOSSARY, storeDocumentProse, markDocumentMirrored } = require("../document-prose");
const { GLOSSARY_CHARACTER_SECTION } = require("./labels");
const { parseGlossaryMarkdown, glossaryTermSpans } = require("./parse");
const { findRowEvidence } = require("./quote-evidence");
const { documentTermAlreadyStored } = require("./rows");
const { firstPersonAliasDeclarations } = require("./aliases");
require("../../../types"); // JSDoc type definitions

/**
 * Import a glossary file into a volume's store.
 *
 * Three things happen, in this order:
 *
 *   1. the document's own prose (title line, preamble paragraphs) is stored so the renderer can
 *      put it back verbatim (review 05 §3.4);
 *   2. a row under the `Characters` section registers its term in the cast. The glossary's
 *      Characters section IS the volume's roster, and the roster is what the integrity check
 *      "the character-voice reference covers fewer characters than the cast holds" compares
 *      against — without it, a voice reference that lost most of the cast would match its own
 *      reduced cast perfectly and look clean (review 05 §4, D).
 *   3. each row is inserted with evidence discovered from the volume's own source text, or
 *      refused and reported.
 *
 * @param {ReferenceStore} store - Opened for the volume the glossary belongs to.
 * @param {string} markdown - The glossary file's content.
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, imported: Array<Object>, importedCount: number, refused: Array<{row: Object, because: string}>, facts: Array<Object>, castRegistered: number, proseStored: number, unplacedProse: Array<{section: string, text: string}>}}
 */
function importGlossary(store, markdown, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const parsed = parseGlossaryMarkdown(markdown);
  const listed = store.listChapters();
  const chapters = listed.chapters;

  const proseStored = storeDocumentProse(store, DOCUMENT_GLOSSARY, parsed.proseBlocks).stored;
  markDocumentMirrored(store, DOCUMENT_GLOSSARY, vol);

  const imported = [];
  const refused = [];
  const carried = [];
  let castRegistered = 0;

  for (const row of parsed.rows) {
    const isCharacterRow = (row.section || "").trim().toLowerCase() === GLOSSARY_CHARACTER_SECTION.toLowerCase();
    if (isCharacterRow) {
      const spans = glossaryTermSpans(row.term);
      const registered = store.upsertCast({
        key: spans[0] || row.term,
        aliases: spans.slice(1),
        firstSeenVolume: vol,
      });
      if (registered.ok) castRegistered += 1;
    }

    // The glossary is cumulative: this file contains every row the earlier volumes published, and
    // this store already holds those rows, because copy-forward carried them with their own
    // provenance. Re-importing them would stamp a volume-01 term as established in volume 05 and put
    // the same term in the store twice, so a row the record already has is counted as carried, not
    // imported.
    //
    // Asked BEFORE the evidence rule, on purpose. The evidence rule decides what this store may
    // *adopt*; a row the record already owns was adopted by the volume that owns it, and it cites
    // that volume's text. Asking it to also appear in volume 05's text is not a check — it is the
    // same row refused 40 times over, once per volume it is merely carried through, and it makes the
    // report read as damage. (Measured on the real volume 02: 42 of its 46 refusals were rows the
    // record already held from volume 1.)
    if (documentTermAlreadyStored(store, row.term)) {
      carried.push(row.term);
      continue;
    }

    const { evidence, kind, tried, governsTried } = findRowEvidence(store.volumeDir, chapters, vol, row);
    if (!evidence) {
      refused.push({
        row,
        because:
          `none of this row's spellings (${tried.join(", ") || row.term}) occurs in volume ${vol}'s source text, ` +
          (governsTried.length
            ? `and none of the passages its notes quote (${governsTried.join(", ")}) occurs there either, `
            : "and its notes quote no passage to govern, ") +
          "so the row supports neither kind of evidence this store accepts.",
      });
      continue;
    }
    const result = store.insertFact({
      key: null,
      aspect: "term_usage",
      label: null,
      section: row.section || null,
      body: row.notes || row.rendering || row.term,
      examples: [row.term, row.rendering].filter(Boolean),
      evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
    });
    if (!result.ok) {
      refused.push({ row, because: result.refusal ? result.refusal.because : "insert refused" });
      continue;
    }
    imported.push(result.fact);
  }

  // The glossary's Characters rows declare which first-person forms belong to which character, and the
  // declaration is applied here — after the Characters rows have become cast entries, and before any
  // extraction name is resolved. Asked in this order, `俺（ジョーロ）` has somebody to land on; asked any
  // other way, the store invents a character out of the word for "I". See
  // `firstPersonAliasDeclarations` for what this rule was measured against before it was pinned.
  const aliasDeclarations = firstPersonAliasDeclarations(parsed);
  const aliasesDeclared = [];
  const aliasRefused = [];
  for (const entry of aliasDeclarations.declarations) {
    const result = store.castAlias(entry.key, entry.alias, entry.reason);
    if (result.ok) aliasesDeclared.push({ key: entry.key, alias: entry.alias });
    else aliasRefused.push({ key: entry.key, alias: entry.alias, because: result.refusal.because });
  }

  return {
    ok: refused.length === 0 && parsed.unplacedProse.length === 0,
    imported,
    importedCount: imported.length,
    carried,
    refused,
    facts: imported,
    castRegistered,
    proseStored,
    unplacedProse: parsed.unplacedProse,
    aliasesDeclared,
    aliasRefused,
    ambiguousAliases: aliasDeclarations.ambiguous,
  };
}

module.exports = {
  importGlossary,
};

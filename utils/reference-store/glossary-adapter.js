/**
 * utils/reference-store/glossary-adapter.js — the glossary, in and out of the store.
 *
 * Doc 03 §0's observation is that the glossary is already a table pretending to be a
 * document: term / rendering / section / notes, stored as Markdown and parsed back out of
 * Markdown at every use. This adapter is the two halves of turning that around:
 *
 *   `importGlossary` — read the file, find each row's evidence in the volume's own source
 *   text, and insert the row. A row whose term cannot be found in the book is **refused**,
 *   and reported: the import never quietly drops a row it could not check.
 *
 *   `renderGlossary` — write the file back out of the rows.
 *
 * **The parser here is deliberately NOT `glossary/carry-forward/table.js`'s.** Reusing it
 * would make slice 4's round-trip test a tautology — the same parser reading the file twice
 * proves the parser agrees with itself, not that the store can reproduce the artifact. The
 * carry-forward gate and the delivery signals keep their parser; this one is the store's,
 * and the two disagreeing is information. (Doc 03 §9.4: the database is authoritative and a
 * test asserts the round trip.)
 *
 * The canonical shape this renderer writes — and the shape `importGlossary` round-trips
 * byte-for-byte — is:
 *
 *     # Glossary — <series>
 *
 *     <preamble paragraphs, verbatim>
 *
 *     ## <Section>
 *
 *     | Original | Translated | Readings | Notes |
 *     |---|---|---|---|
 *     | <term> | <rendering> | <readings> | <notes> |
 *
 * The title line and the preamble are stored in `document_prose` and rendered back verbatim
 * (review 05 §3.4): the real glossary opens with a title and two style-policy paragraphs, and
 * a renderer that drops them cannot diff clean against the file it claims to reproduce. The
 * column headers come from `GLOSSARY_HEADER` in `glossary-adapter/labels.js` — the one place
 * they are written — and are named for what each column holds rather than for one language,
 * because the pipeline works from a source language the intake works out per series. Every
 * reader of the file takes the columns **by position** and learns how many there are from the table's own
 * header row, so a glossary published before the rename **and** a glossary published with three columns
 * both still import and still count: `utils/delivery-verify` counts the file's sections and terms and
 * `parseGlossaryTerms` reads it back.
 *
 * The `Readings` cell is the one column not stored on the row. It is a query over the record's
 * `written_forms` rows (`utils/reference-store/written-forms/readings.js`), asked once per render by
 * `glossary-adapter/readings.js`, because a pronunciation guide is a fact about one volume's harvest while
 * the row it is printed beside may have been published by another volume — and a published row is never
 * edited.
 *
 * ## Where the code lives
 *
 * The code is in `utils/reference-store/glossary-adapter/`, one responsibility per file: `labels.js`
 * (the fallback heading, the column headers, the section that is the roster, and the table that maps
 * the extraction prompt's term types onto those sections), `parse.js` (reading the Markdown table back
 * into rows, plus the prose that is not rows), `quote-evidence.js` (the evidence rule — a row's term,
 * its rendering, or a passage its notes quote has to be a line this volume's own text prints, or the
 * row is refused and named), `aliases.js` (the first-person pronouns the glossary's Characters rows
 * declare, and the ambiguity report when two rows declare the same one), `rows.js` (what the record
 * already holds, and which row of a `supersedes` chain is in force at one volume), `import-document.js`
 * (importing a published glossary file into the record), `revision.js` (the door that replaces a
 * published rendering by filing a new row beside it), `history.js` (the `Earlier rendering:` line and
 * its idempotent merge), `render.js` (the published file and its cell escaping), `readings.js` (the
 * `Readings` column: the query over the record's own written-form rows, plus the cell's shape — written and
 * read back in the same file, so the renderer and the re-render gate cannot hold two opinions about one
 * row's readings) and
 * `import-extraction.js` (filing what the read pass found as published rows). This file is the public
 * surface of the glossary layer and the only thing another module should require; the evidence rule and
 * the term identity every door matches on stay inside this folder, which is a banned patch path for the
 * dev team (AGENTS.md §3).
 *
 * @module utils/reference-store/glossary-adapter
 */

const labels = require("./glossary-adapter/labels");
const parse = require("./glossary-adapter/parse");
const quoteEvidence = require("./glossary-adapter/quote-evidence");
const aliases = require("./glossary-adapter/aliases");
const rows = require("./glossary-adapter/rows");
const importDocument = require("./glossary-adapter/import-document");
const revision = require("./glossary-adapter/revision");
const history = require("./glossary-adapter/history");
const render = require("./glossary-adapter/render");
const readings = require("./glossary-adapter/readings");
const importExtraction = require("./glossary-adapter/import-extraction");

// The public surface, unchanged from the single file.
module.exports = {
  GLOSSARY_TITLE: labels.GLOSSARY_TITLE,
  GLOSSARY_HEADER: labels.GLOSSARY_HEADER,
  GLOSSARY_CHARACTER_SECTION: labels.GLOSSARY_CHARACTER_SECTION,
  EXTRACTION_TYPE_TO_SECTION: labels.EXTRACTION_TYPE_TO_SECTION,
  EXTRACTION_FALLBACK_SECTION: labels.EXTRACTION_FALLBACK_SECTION,
  glossaryTermSpans: parse.glossaryTermSpans,
  parseGlossaryMarkdown: parse.parseGlossaryMarkdown,
  noteQuotedSpans: quoteEvidence.noteQuotedSpans,
  findRowEvidence: quoteEvidence.findRowEvidence,
  findQuoteEvidence: quoteEvidence.findQuoteEvidence,
  barePronounTokensIn: aliases.barePronounTokensIn,
  firstPersonAliasDeclarations: aliases.firstPersonAliasDeclarations,
  importGlossary: importDocument.importGlossary,
  glossaryRowFromExtraction: importExtraction.glossaryRowFromExtraction,
  importGlossaryExtraction: importExtraction.importGlossaryExtraction,
  glossaryRowInForceForTerm: rows.glossaryRowInForceForTerm,
  publishedGlossaryRowsInRecord: rows.publishedGlossaryRowsInRecord,
  fileGlossaryRevision: revision.fileGlossaryRevision,
  importGlossaryRevisions: revision.importGlossaryRevisions,
  revisionHistoryFragment: history.revisionHistoryFragment,
  mergeRevisionHistory: history.mergeRevisionHistory,
  renderGlossary: render.renderGlossary,
  escapeCell: render.escapeCell,
  // The reading column: the query that fills it, and the cell's own shape (written and read back in one
  // file, so the renderer and the re-render gate cannot hold two opinions about one row's readings).
  GLOSSARY_READING_COLUMN: labels.GLOSSARY_READING_COLUMN,
  GLOSSARY_NO_READING_CELL: labels.GLOSSARY_NO_READING_CELL,
  READING_CELL_SEPARATOR: readings.READING_CELL_SEPARATOR,
  READING_COUNT_MARK: readings.READING_COUNT_MARK,
  renderReadingCell: readings.renderReadingCell,
  readingsFromCell: readings.readingsFromCell,
  glossaryReadingCellsForRows: readings.glossaryReadingCellsForRows,
};

/**
 * glossary/extract.js — the glossary read pass's ANSWER layer: what shape the term-list call asks for,
 * how the reply is read, how many times a failed read is paid for again, and what the volume's report says
 * about the reads that never answered.
 *
 * The truncation window of the previous glossary lives here too, and it is RELEVANCE-ranked against the
 * text being processed, never by document position (gotcha 41) — the glossary is cumulative, so "the first
 * N entries" shows the earliest volumes' terms and throws away exactly what a later volume needs.
 * Truncating here means "some existing terms may be re-proposed as new", which is harmless: the amend pass
 * reconciles duplicates to one canonical rendering. It no longer means "the agent cannot see entries it
 * must preserve", which is what it used to mean and what the 457-term loss came out of.
 *
 * **The rule this layer exists to keep** (AGENTS.md gotcha 138): a term list that never arrived comes back
 * `failed: true` and named, and NEVER as `[]` — because `[]` is also the honest answer for a volume with
 * nothing new, and a volume nobody managed to ask about must not look like a volume with nothing to find.
 * `readTermList` is the only place that decision is made, and it is made in `glossary/extract/reads.js`.
 *
 * The implementation lives in ./glossary/extract/ — open the module that owns the behaviour you are
 * changing instead of reading all of them:
 *   - `extract/answer-shape.js` — `termsResponseFormat()`: the declared answer shape, an object root
 *     holding `{"terms": […], "revisions": […]}`, because this endpoint refuses a schema rooted on an
 *     array before it generates (gotcha 138);
 *   - `extract/answer.js` — `parseTermAnswer` / `parseTerms` / `revisionFromAnswer`: the reply read into
 *     the rows the record files, in the envelope form OR the bare array a server that ignores
 *     `response_format` still answers in;
 *   - `extract/reads.js` — `readTermList`, the two-paid-read budget (`EXTRACTION_MAX_ATTEMPTS`,
 *     `EXTRACTION_RETRY_THINKING_LEVEL`), `classifyExtractionFailure` naming WHICH failure happened, and
 *     the `failed: true` rule above;
 *   - `extract/read-report.js` — `extractionReadReport`, the markdown block `glossary/store.js` appends to
 *     the validation report the acceptance grader reads;
 *   - `extract/window.js` + `extract/window-rows.js` — `truncateGlossary`: which rows of the previous
 *     glossary a chapter is shown as full rows, ranked by whether the text in front of the extractor
 *     mentions them under ANY spelling the row names (gotcha 82), and the complete name-and-rendering
 *     index appended underneath so the window hides Notes and never an entry.
 *
 * Not to be confused with `extract.js` at the repository root (the extraction PIPELINE STEP) or
 * `utils/source/extract.js` (the converter that writes the chapter files). This one is the glossary
 * stage's answer layer, and its folder is `glossary/extract/`.
 *
 * This file is the public face of the layer: it holds no logic, only re-exports.
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config(); // before anything that turns a knob into a value at require time
require("../types"); // JSDoc type definitions

const answerShape = require("./extract/answer-shape");
const answer = require("./extract/answer");
const reads = require("./extract/reads");
const readReport = require("./extract/read-report");
const windowLayer = require("./extract/window");

// The public surface, unchanged from the single file.
module.exports = {
  parseTerms: answer.parseTerms,
  parseTermAnswer: answer.parseTermAnswer,
  revisionFromAnswer: answer.revisionFromAnswer,
  termsResponseFormat: answerShape.termsResponseFormat,
  EXTRACTION_MAX_ATTEMPTS: reads.EXTRACTION_MAX_ATTEMPTS,
  EXTRACTION_RETRY_THINKING_LEVEL: reads.EXTRACTION_RETRY_THINKING_LEVEL,
  classifyExtractionFailure: reads.classifyExtractionFailure,
  readTermList: reads.readTermList,
  extractionReadReport: readReport.extractionReadReport,
  truncateGlossary: windowLayer.truncateGlossary,
};

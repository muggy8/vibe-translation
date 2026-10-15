/**
 * character-voice/reading.js — the voice stage's reading pass: read one volume chapter by chapter and
 * produce its extraction notebook, with each chapter's answer kept beside the volume so a chapter is not
 * paid for twice.
 *
 * Why this lives here rather than inside `extract-voice.js`. The reading pass is now the voice stage's
 * normal route, and two doors open it: the standalone command and the stage itself. A second implementation
 * of resume, fingerprints and cut-off detection is a second set of rules, and the two would drift exactly
 * the way the two QA loops used to. So the loop lives here once and both doors call it.
 *
 * ## The failure this layer exists for
 *
 * Measured on the real volume 02, at the run's normal reasoning level: **three of seven chapters came back
 * cut off** — the answer never reached its closing bracket. Two of them yielded 6 and 1 claims for chapters
 * of 33,541 and 35,553 characters, and the pass accepted them. Re-read at a lower reasoning level the same
 * two chapters yielded 21 and 8. The route this one replaced was worse: its chapter-by-chapter flow
 * swallowed an unparseable chapter in a `catch {}` and carried on, so the hole never surfaced (that flow is
 * gone; it is in git history at commit 75e59a7).
 *
 * A cut-off answer is not a short answer, it is a **half an answer**: the model stopped in the middle of the
 * list, and what it was about to write is not in the file. Nothing about the volume says which claims are
 * missing, so the only honest response is to name the chapter and read it again. That is what this layer
 * does, and it is not behind a flag: `scanTopLevelObjects` reports whether the array closed, and an answer
 * that did not close is retried.
 *
 * ## The two chapter outcomes, and why they must never be confused
 *
 * A chapter **kept although its array never closed** has claims in the notebook, is named INCOMPLETE in the
 * log and in the report the grader reads, and the pass carries on. A chapter that **never answered at all**
 * makes the pass refuse, and is therefore not in the chapter list at all. Those are two different facts
 * about a volume, they reach `character-voice/findings.js` as two different finding kinds
 * (`voice-chapter-kept-cut-off` MINOR, `voice-chapter-never-answered` MAJOR), and the delivery layer routes
 * them differently. `reading/volume.js` is the one place that decides between them.
 *
 * ## What each chapter is shown as already known (plan 06 slice 2, 2026-10-14)
 *
 * A chapter's call is shown the **query result** `character-voice/known-facts.js` builds from this volume's
 * open record — the record's current claims for the characters this chapter's own text names — and not the
 * previous volume's published `character-voice.md`. Two things changed with that, and both are guards rather
 * than tidy-ups: this pass **refuses** when no record is open (`no-reference-record`, no fallback to a
 * markdown file), and a chapter the record names nobody in is **named** — in the log, on the chapter record,
 * and in `readingReport`, which the acceptance grader reads. Before this, a missing previous reference meant
 * every chapter of the volume was read with no accumulated knowledge and nothing anywhere said so.
 *
 * ## What is bounded
 *
 * `MAX_ATTEMPTS_PER_CHAPTER` is the whole budget: two paid attempts per chapter, per pass. A chapter that is
 * still cut off after that is kept (the better of its two answers), named as incomplete in the log, in the
 * partial, and in the report the grader reads. A route that refused a volume for one stubborn chapter would
 * make the volume unfinishable; a route that said nothing would be the failure this layer exists to fix.
 * `EXTRACTION_RETRY_THINKING_LEVEL` is a constant, not an environment knob, and the measurement that chose
 * it is written beside it in `reading/reads.js`.
 *
 * The implementation lives in ./character-voice/reading/ — open the module that owns the behaviour you are
 * changing instead of reading all of them:
 *   - `reading/partials.js` — `partialPath` / `segmentFingerprint` / `readPartial` / `writePartial`, and the
 *     partial's own format version: where one chapter's answer lives, which text it belongs to, and whether
 *     the copy on disk may be reused and whether it is a whole answer;
 *   - `reading/notebook.js` — `EXTRACTION_FILE` and `consolidateExtraction`: the volume's notebook, and the
 *     chapter stamp that keeps every claim traceable to the chapter that printed it;
 *   - `reading/answer.js` — `scanTopLevelObjects` / `parseExtractionAnswer`: the raw reply read into claims,
 *     object by object when the whole array will not parse, and the `closed` verdict that says whether the
 *     claim array reached its bracket. **The mirror of `glossary/extract/answer.js`.**
 *   - `reading/reads.js` — `readOneChapter`, `attemptLog`, `MAX_ATTEMPTS_PER_CHAPTER`,
 *     `EXTRACTION_RETRY_THINKING_LEVEL`: one paid read of one chapter, the three names of the ways it can
 *     fail without answering, and the budget. **The mirror of `glossary/extract/reads.js`.**
 *   - `reading/volume.js` — `readVolumeChapters`: the walk, the reuse rules, the retry decision, "the better
 *     answer wins", and the refusals that stop a pass.
 *   - `reading/read-report.js` — `readingReport`, the block `character-voice/store.js` appends to the
 *     validation report the acceptance grader reads. **The mirror of `glossary/extract/read-report.js`.**
 *
 * This file is the public face of the layer: it holds no logic, only re-exports.
 * Part of the character-voice.js layer.
 *
 * @module character-voice/reading
 */

require("../types"); // JSDoc type definitions

const partials = require("./reading/partials");
const notebook = require("./reading/notebook");
const answer = require("./reading/answer");
const reads = require("./reading/reads");
const volume = require("./reading/volume");
const readReport = require("./reading/read-report");

// The public surface, unchanged from the single file.
module.exports = {
  EXTRACTION_FILE: notebook.EXTRACTION_FILE,
  PARTIAL_PREFIX: partials.PARTIAL_PREFIX,
  PARTIAL_SCHEMA: partials.PARTIAL_SCHEMA,
  MAX_ATTEMPTS_PER_CHAPTER: reads.MAX_ATTEMPTS_PER_CHAPTER,
  EXTRACTION_RETRY_THINKING_LEVEL: reads.EXTRACTION_RETRY_THINKING_LEVEL,
  partialPath: partials.partialPath,
  segmentFingerprint: partials.segmentFingerprint,
  readPartial: partials.readPartial,
  writePartial: partials.writePartial,
  consolidateExtraction: notebook.consolidateExtraction,
  scanTopLevelObjects: answer.scanTopLevelObjects,
  parseExtractionAnswer: answer.parseExtractionAnswer,
  readOneChapter: reads.readOneChapter,
  readVolumeChapters: volume.readVolumeChapters,
  readingReport: readReport.readingReport,
};

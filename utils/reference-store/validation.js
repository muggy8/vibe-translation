/**
 * utils/reference-store/validation.js — the checks a validator agent used to do, done by code.
 *
 * The pre-production QA loop has always had a validator agent: a fresh agent per iteration that
 * reads the whole artifact and writes a report saying whether it is complete, consistent, correct
 * and well-formed. That is the most expensive kind of model call this pipeline makes — it re-reads
 * a document the pipeline already has in structured form — and its answer is a paragraph, so
 * nothing downstream can act on it except another model.
 *
 * This module is the replacement slice 6 installs. Three groups, because the old validator was
 * doing three different jobs:
 *
 *   - **The store's own questions** (`integrity.js`): evidence that does not verify, provenance
 *     that cannot be true, a character split across two entries, a reference that covers fewer
 *     characters than the roster. Deterministic, and each one has a severity.
 *   - **The artifact's shape** (`artifactShapeFindings`): the file an agent wrote, measured. A line
 *     longer than an agent can read is the exact damage that destroyed volume 01's reference, and it
 *     is measurable in one pass over the file.
 *   - **What the pipeline threw away** (`unadoptedVoiceClaims`, `unadoptedTerms`): the extraction
 *     pass already paid for structured claims; this compares them against what the published
 *     document actually says, and names the ones the document never took.
 *
 * The output is the same file the validator agent used to write, with the same name, so the
 * feedback stage and every existing reader of it keep working. What changed is who wrote it: code,
 * from rows, with numbers.
 *
 * ## Where the code lives
 *
 * The code is in `utils/reference-store/validation/`, one kind of job per file: `queries.js` (the seven
 * questions asked of the record — what the extraction found that the published document never took, who
 * this volume's text does not contain, how this volume's reference came to exist, which sections this
 * volume added), `artifact-shape.js` (measuring the file an agent wrote: a line no agent can read, a
 * document with no addressable sections, prose the writer never finished), `headings.js` (the one heading
 * rule the shape check and the sampler have to agree on), `report.js` (the report itself: its header, the
 * `**Recommendation:**` rule, the findings grouped by severity and the "What was checked" table),
 * `report-record.js` / `report-gaps.js` / `report-attribution.js` (the report's narrative sections, each
 * printing the lines it printed before this file was split), `report-lines.js` (the formatting rules every
 * section shares and the two bounds that keep the report a size the run pays for) and `sample.js` (the
 * slice of the artifact the acceptance grader is shown, and what it does when a section is bigger than the
 * budget). This file is the public surface of the audit layer and the only thing another module should
 * require; the recommendation rule and the two bounds stay inside this folder, which is a banned patch
 * path for the dev team (AGENTS.md §3).
 *
 * @module utils/reference-store/validation
 */

const queries = require("./validation/queries");
const artifactShape = require("./validation/artifact-shape");
const report = require("./validation/report");
const reportLines = require("./validation/report-lines");
const sample = require("./validation/sample");

// The public surface, unchanged from the single file.
module.exports = {
  VALIDATION_STEP: artifactShape.VALIDATION_STEP,
  GRADE_SAMPLE_MAX_CHARS: sample.GRADE_SAMPLE_MAX_CHARS,
  REPORT_LIST_LIMIT: reportLines.REPORT_LIST_LIMIT,
  artifactShapeFindings: artifactShape.artifactShapeFindings,
  unadoptedVoiceClaims: queries.unadoptedVoiceClaims,
  unadoptedTerms: queries.unadoptedTerms,
  absentCharacters: queries.absentCharacters,
  rebuildProvenance: queries.rebuildProvenance,
  renderAuditReport: report.renderAuditReport,
  buildGradeSample: sample.buildGradeSample,
  voiceNewestSections: queries.voiceNewestSections,
  glossaryNewestSections: queries.glossaryNewestSections,
};

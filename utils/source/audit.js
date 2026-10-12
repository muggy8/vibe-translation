/**
 * utils/source/audit.js — the extraction audit's public surface.
 *
 * The thin barrel over `utils/source/audit/`: `audit/audit.js` (the entry point and its result type),
 * `audit/checks.js` (the six checks), `audit/rules.js` (the vocabulary they share — the kinds, the
 * step name, and the small questions every check asks). Node resolves this file before the folder of
 * the same name, so `require("./source/audit")` and the `utils/source.js` re-export keep working
 * unchanged (AGENTS.md §3).
 *
 * What is deliberately NOT on this surface: the predicates in `audit/rules.js` (`nameKey`,
 * `segmentHasNoBody`, `segmentDeclaresPackaging`, `findingFile`). They are the audit's own reading of
 * what the extraction already recorded, and a generic name exported into the source layer's barrel is
 * a name some later module reaches for and turns into a second rule about emptiness or about packaging
 * — the exact drift gotcha 40 and gotcha 52 are about. Ask the audit; do not re-ask its questions.
 */

require("../../types"); // JSDoc type definitions

const rules = require("./audit/rules");
const checks = require("./audit/checks");
const audit = require("./audit/audit");

module.exports = {
  EXTRACTION_STEP: rules.EXTRACTION_STEP,
  EXTRACTION_AUDIT_KINDS: rules.EXTRACTION_AUDIT_KINDS,
  auditSourceIsArchive: checks.auditSourceIsArchive,
  auditHasUsableChapter: checks.auditHasUsableChapter,
  auditEmptyChapters: checks.auditEmptyChapters,
  auditGuideSplitSurvives: checks.auditGuideSplitSurvives,
  auditTitlesAreTitles: checks.auditTitlesAreTitles,
  auditGuideHarvest: checks.auditGuideHarvest,
  auditExtractedVolume: audit.auditExtractedVolume,
};

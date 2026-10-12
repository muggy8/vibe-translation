/**
 * utils/source/audit/audit.js — the audit entry point: one extracted volume in, findings out.
 *
 * Pure: no file reads, no model, no agent, no writes. Give it the plan of record's volume entry, the
 * bundle `resolveSourceBundle` returned for it, and the volume folder's file listing, and it answers the
 * six questions the extraction layer is able to answer about itself.
 *
 * WHY IT IS A FUNCTION AND NOT A STEP (yet). `utils/source/plan/01-extraction-step.md` slice 1 is the
 * audit; slice 2 is the `extract` step that runs it over every volume and writes the reports. Building
 * the step first would put a runner around a check nobody has verified against a real bundle, and
 * building the check as a step would make it untestable without a pipeline. This file is the part both
 * of them need, finished first.
 *
 * Part of the source.js layer's audit half.
 */

require("../../../types"); // JSDoc type definitions

const { structuralError } = require("../../../configs/shared");

const { EXTRACTION_STEP, fileNamesOf, nameKey } = require("./rules");
const {
  auditSourceIsArchive,
  auditHasUsableChapter,
  auditEmptyChapters,
  auditGuideSplitSurvives,
  auditTitlesAreTitles,
  auditGuideHarvest,
} = require("./checks");

/** @typedef {import("../../postmortem").PostMortemFinding} PostMortemFinding */

/**
 * @typedef {Object} ExtractionAudit
 * The result of auditing one extracted volume.
 * @property {string} step                  — Always "extract": the step these findings belong to.
 * @property {string} volume                — The installment number, straight from the plan of record.
 * @property {PostMortemFinding[]} findings — Every finding, in check order, in the post-mortem's own shape.
 * @property {{HIGH: number, MEDIUM: number, findings: number, chapters: number, packaging: number}} counts
 *   Findings at each level, plus what the bundle holds. The counts are here so slice 2's per-volume
 *   report can print the measurement the plan calls "info" without re-reading the bundle.
 */

/**
 * Audit one extracted volume.
 *
 * @param {Object} p
 * @param {TranslationTargetVolume} p.volume - The plan of record's volume entry (`folder`, `sourceFile`, `installmentNumber`).
 * @param {SourceBundle} p.bundle - The resolved bundle for that volume.
 * @param {Array<string|{name: string}>} p.volumeFiles - The volume folder's file listing (`fs.readdir` output, either form).
 * @returns {ExtractionAudit} The findings and their counts.
 * @throws {Error} A STRUCTURAL error when the audit was handed something it cannot audit. An audit that
 *   could not run is never reported as a clean one.
 */
function auditExtractedVolume({ volume, bundle, volumeFiles }) {
  if (!volume || typeof volume !== "object" || !volume.folder) {
    throw structuralError(
      "auditExtractedVolume: no volume entry given. The audit needs the plan of record's volume (folder, " +
        "sourceFile, installmentNumber) — every finding is reported against it."
    );
  }
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.segments)) {
    throw structuralError(
      `auditExtractedVolume: the bundle for volume ${volume.installmentNumber || volume.folder} has no ` +
        `segment list. Resolve the volume through resolveSourceBundle before auditing it; an audit that ` +
        `could not run must not be reported as a clean one.`
    );
  }

  const names = fileNamesOf(volumeFiles);
  const segments = bundle.segments;
  const packagingTitles = new Set(
    (Array.isArray(bundle.packaging) ? bundle.packaging : [])
      .map((group) => nameKey(group && group.title))
      .filter(Boolean)
  );

  const findings = [
    ...auditSourceIsArchive({ volume, bundle, names }),
    ...auditHasUsableChapter({ volume, segments }),
    ...auditEmptyChapters({ volume, segments, packagingTitles }),
    ...auditGuideSplitSurvives({ volume, segments }),
    ...auditTitlesAreTitles({ volume, bundle, segments }),
    ...auditGuideHarvest({ volume, bundle, names }),
  ];

  return {
    step: EXTRACTION_STEP,
    volume: volume.installmentNumber || volume.folder,
    findings,
    counts: {
      HIGH: findings.filter((f) => f.severity === "HIGH").length,
      MEDIUM: findings.filter((f) => f.severity === "MEDIUM").length,
      findings: findings.length,
      chapters: segments.length,
      packaging: Array.isArray(bundle.packaging) ? bundle.packaging.length : 0,
    },
  };
}

module.exports = { auditExtractedVolume };

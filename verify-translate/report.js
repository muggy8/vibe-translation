/**
 * The two reports a volume leaves behind, and the published-text resolver the merge, the variant scan and the cross-chapter audit all share.
 *
 * Part of the verify-translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types"); // JSDoc type definitions
const {
  sha256,
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  glossaryBlockMaxChars,
  runWithConcurrency,
  stageConcurrency,
  judgeTemperature,
  stageThinking,
  chapterArtifactNames,
  loadVerificationSidecar,
  readFileOrEmpty,
  saveVerificationSidecar,
  findingsOf,
  glossaryBlock,
  medianScore,
  recordBestDraft,
  verdictCoversCurrentDraft,
  estimateTokens,
  fitPromptBudget,
  describeDroppedBlocks,
  findRenderingVariants,
  renderVariantFindings,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  previousVolumeTail,
  tailOf,
  resolvePublishedChapterTexts,
  planConsistencyWindows,
  parseVolumeFindings,
  buildVolumeConsistencyMarkdown,
  loadVolumeConsistency,
  saveVolumeConsistency,
  VOLUME_CONSISTENCY_FILE,
  VOLUME_CONSISTENCY_REPORT,
  loadTranslationState,
  STATE_FILE,
  MERGED_FILE,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
} = require("../utils/translate");

const { passingScore } = require("./config");

/**
 * The text a reader of this volume actually gets: the merged `translation.md`
 * when it exists (that is what the pipeline publishes), otherwise the drafts
 * concatenated in reading order.
 *
 * @param {string} volumeDir
 * @param {{segments: Array<{id: string, file: string}>}} bundle
 * @returns {Promise<string>}
 */
async function readPublishedVolumeText(volumeDir, bundle) {
  const merged = await readFileOrEmpty(path.join(volumeDir, MERGED_FILE));
  if (merged.trim()) return merged;
  const parts = [];
  for (const seg of bundle.segments) {
    const { draftFile, polishedFile } = chapterArtifactNames(seg.id);
    const polished = await readFileOrEmpty(path.join(volumeDir, polishedFile));
    const draft = await readFileOrEmpty(path.join(volumeDir, draftFile));
    const text = polished.trim() ? polished : draft;
    if (text.trim()) parts.push(text.trim());
  }
  return parts.join("\n\n");
}


/**
 * Persist the variant scan in the verification sidecar (volume-level, separate
 * from the per-chapter verdicts) so a later run can see it without re-scanning,
 * and the translation report can count it.
 *
 * @param {string} volumeDir
 * @param {Array<Object>} findings
 * @returns {Promise<void>}
 */
async function saveVolumeFindings(volumeDir, findings) {
  const sidecarPath = path.join(volumeDir, VERIFICATION_FILE);
  const sidecar = await loadVerificationSidecar(sidecarPath);
  sidecar.volume = {
    ...(sidecar.volume || {}),
    scannedAt: new Date().toISOString(),
    renderingVariants: findings,
  };
  await saveVerificationSidecar(sidecarPath, sidecar);
}


/**
 * Build the per-volume verification report (translation-verification.md):
 * the score table plus each failing chapter's findings (the input the
 * retranslate task consumes).
 *
 * @param {{installmentNumber: string, folder: string}} volume
 * @param {Array<{id: string, title: string, status: string, score: number|null, pass: boolean|null, findings?: string}>} rows
 * @returns {string} The Markdown report.
 */
function buildVerificationReportMarkdown(volume, rows, variantFindings = []) {
  const lines = [];
  lines.push(`# Translation Verification — Volume ${volume.installmentNumber} (${volume.folder})`);
  lines.push("");
  lines.push(
    `_Source-anchored verification by the verify model (score 0–100, banded rubric; PASS at or above ` +
      `${passingScore}). An unparseable score is a FAIL (fail-closed). Failing chapters are ` +
      `retranslated by the "retranslate" task using the findings below, then re-verified._`
  );
  lines.push("");
  lines.push("| Chapter | Title | Status | Score | Verdict |");
  lines.push("|---|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${row.title || "—"} | ${row.status} | ` +
        `${row.score === null ? "n/a" : row.score + "/100"} | ${row.pass === null ? "—" : row.pass ? "PASS" : "FAIL"} |`
    );
  }
  lines.push("");
  for (const row of rows.filter((r) => r.pass === false && r.findings)) {
    lines.push(`## Findings — ${row.id} (${row.title || "untitled"})`);
    lines.push("");
    lines.push(row.findings);
    lines.push("");
  }
  // The deterministic half of the audit: the cross-chapter rendering-variant
  // scan over the published volume (no model call produced it).
  const variantSection = renderVariantFindings(variantFindings);
  if (variantSection) {
    lines.push(variantSection);
    lines.push(
      "_Fix: correct the rendering in the offending chapters (the retranslate task is given the " +
        "glossary as terminology law), or fix the glossary itself if the second form is the better " +
        "one and re-run the pipeline._"
    );
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Task entry ─────────────────────────────────────────────────────────────


module.exports = {
  readPublishedVolumeText,
  saveVolumeFindings,
  buildVerificationReportMarkdown,
};

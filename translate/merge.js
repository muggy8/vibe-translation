/**
 * The publish gate: what translation.md is allowed to contain. A chapter that did not pass verification is published WITH a visible warning, not quietly included and not quietly quarantined out; a chapter with no text at all is MISSING, and a chapter empty in the BOOK is EMPTY IN SOURCE — two different rows on purpose.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types"); // JSDoc type definitions
const {
  sha256,
  splitChapter,
  buildTranslationTaskLines,
  buildTranslationPrompt,
  checkTranslationQa,
  mergeVolumeTranslation,
  resolvePublishedChapterTexts,
  findMissingSegments,
  stripMarkdownFence,
  tailOf,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  glossaryBlockMaxChars,
  stripContinuityOverlap,
  chapterArtifactNames,
  readFileOrEmpty,
  previousVolumeTail,
  buildBudgetedTaskLines,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  EMPTY_SOURCE_CHARS,
  loadVerificationSidecar,
  verdictCoversCurrentDraft,
  chapterContextHash,
  unverifiedMarker,
  recordBestDraft,
  STATE_FILE,
  QA_REPORT_FILE,
  MERGED_FILE,
  VERIFICATION_FILE,
  buildPolishGuardFindings,
  planChapterSplit,
  translateChunkCap,
  outputRatioFor,
  thinkingOutputFactor,
  measureOutputRatio,
  estimateTokens,
} = require("../utils/translate");

/**
 * Merge a volume's chapter files into the translation.md content: the
 * polished file is used when the state shows it was produced from the
 * CURRENT draft (polishedDraftHash === draftHash), otherwise the draft.
 *
 * Two guarantees the merge used to lack:
 *   - **The published file carries its own verdict.** A chapter whose
 *     verification FAILED (or that was never verified) gets a visible
 *     UNVERIFIED marker in the book itself. (Observed: a chapter that failed
 *     verification at 57/100 was published as accepted polished text with
 *     nothing on the page saying so.)
 *   - **Incompleteness is reported, not thrown from the middle of a run.** The
 *     missing list is returned so the task can finish every volume and fail at
 *     the END — one untranslatable chapter in volume 2 must not prevent
 *     volumes 3–17 from being translated.
 *
 * @param {string} volumeDir
 * @param {{segments: Array<{id: string, title: string}>}} bundle
 * @param {{chapters: Object}} state
 * @returns {Promise<{text: string, missing: Array<{id: string, title: string}>, unverified: Array<{id: string, title: string, score: number|null, reason: string}>}>}
 *   The merged text ("" when no chapter has text), the chapters with no text,
 *   and the chapters published without a passing verdict.
 */
async function mergeVolumeTranslationFiles(volumeDir, bundle, state, languages = {}) {
  // Resolve the per-chapter texts first (the pure merge helper takes a sync
  // getter). ONE rule for "what this volume publishes" — the same resolver the
  // cross-chapter audit and the variant scan read (resolvePublishedChapterTexts),
  // so the reports and the book cannot end up describing different texts.
  const sidecar = await loadVerificationSidecar(path.join(volumeDir, VERIFICATION_FILE));
  const published = await resolvePublishedChapterTexts(volumeDir, bundle, state);
  const resolved = new Map();
  const verdicts = new Map();
  for (const { id: segId, text } of published) {
    const seg = bundle.segments.find((s) => s.id === segId);
    const entry = (state.chapters && state.chapters[segId]) || {};
    resolved.set(segId, text || null);

    // The verdict that applies to the draft this text came from.
    const verdict = sidecar.chapters[segId];
    if (text) {
      if (entry.qaFailed === true) {
        verdicts.set(seg.id, {
          score: verdictCoversCurrentDraft(verdict, entry) ? verdict.score : null,
          pass: false,
          reason: `it failed the deterministic QA checks (${(entry.qaFindings || "residue / length / coverage").slice(0, 200)})`,
        });
      } else if (verdictCoversCurrentDraft(verdict, entry)) {
        if (verdict.pass !== true) {
          verdicts.set(segId, {
            score: typeof verdict.score === "number" ? verdict.score : null,
            pass: false,
            // The verifier's own reason when it recorded one — the reader of the
            // published volume sees WHY this chapter is flagged, not just that it
            // is. The generic phrase is the fallback (an older sidecar, or a
            // verdict written before reasons were stored).
            reason:
              typeof verdict.reason === "string" && verdict.reason.trim()
                ? verdict.reason.trim()
                : verdict.score === null
                  ? "the verifier's score could not be read"
                  : "the verifier scored it below the passing threshold",
          });
        }
      } else {
        verdicts.set(seg.id, {
          score: null,
          pass: false,
          reason: "verification has not run for this draft (run verify-translate / translate-qa)",
        });
      }
    }
  }
  const missing = findMissingSegments(bundle.segments, (seg) => resolved.get(seg.id) || null);
  const unverified = [];
  const text = mergeVolumeTranslation({
    segments: bundle.segments,
    languages,
    sourceLanguage: languages.sourceLanguage,
    targetLanguage: languages.targetLanguage,
    getText: (seg) => resolved.get(seg.id) || null,
    getNote: (seg) => {
      const verdict = verdicts.get(seg.id);
      if (!verdict) return "";
      unverified.push({ id: seg.id, title: seg.title || seg.id, score: verdict.score, reason: verdict.reason });
      return unverifiedMarker(verdict);
    },
  });
  return { text, missing, unverified };
}


module.exports = {
  mergeVolumeTranslationFiles,
};

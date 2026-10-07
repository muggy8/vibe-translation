/**
 * finishPolishVolume: drop the candidates that never passed the audit, re-merge the volume, and SAVE the state (the cleared polish hashes plus the kept findings). The promise that the next run re-audits with them is this save, not some earlier phase's — a live-only phase a dry run cannot reach (gotcha 49).
 *
 * Part of the polish.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const {
  sha256,
  checkTranslationQa,
  buildPolishGuardFindings,
  stripMarkdownFence,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  runWithConcurrency,
  stageConcurrency,
  judgeTemperature,
  stageThinking,
  writerTemperature,
  estimateTokens,
  fitPromptBudget,
  describeDroppedBlocks,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  glossaryBlock,
  loadVerificationSidecar,
  readFileOrEmpty,
  saveVerificationSidecar,
  findingsOf,
  chapterArtifactNames,
  MERGED_FILE,
  STATE_FILE,
  POLISH_QA_REPORT,
  POLISH_VERIFICATION_FILE,
} = require("../utils/translate");
const { mergeVolumeTranslationFiles } = require("../translate");

const { polishVerifyEnabled, polishVerifyPassingScore } = require("./config");

/**
 * Finish one volume: drop the polished text that never passed the audit (so the
 * merge publishes the draft), re-merge translation.md, and write the polish
 * report.
 *
 * `vc` is the object {@link polishVolumePhaseA} returns — the merge at the end
 * needs the language pair out of it, so it is named here rather than left as an
 * untyped bag (the missing pair was a run-killing ReferenceError).
 *
 * @param {{
 *   volume: {installmentNumber: string, folder: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string}>},
 *   state: Object,
 *   rows: Array<Object>,
 *   auditPending: Array<{id: string, draftHash: string}>,
 *   sourceLanguage: string,
 *   targetLanguage: string,
 * }} vc - The volume context from Phase A.
 * @param {number} auditRounds - How many audit rounds ran (for the report wording).
 * @returns {Promise<{polished: number, skipped: number, rejected: number, noDraft: number, missing: Array}>}
 */
async function finishPolishVolume(vc, auditRounds) {
  const { volume, volumeDir, bundle, state, rows, sourceLanguage, targetLanguage } = vc;
  // Any still-pending candidate failed every round — keep the DRAFT (drop the
  // polished file so the merge publishes the draft) and persist the findings
  // (the next run re-audits/re-polishes with them).
  for (const c of vc.auditPending) {
    const { polishedFile } = chapterArtifactNames(c.id);
    await fs.rm(path.join(volumeDir, polishedFile), { force: true });
    const s = state.chapters[c.id] || {};
    state.chapters[c.id] = {
      ...s,
      polishedDraftHash: null,
      polishVerifiedDraftHash: null,
      polishFindings: s.polishFindings,
      polishFindingsHash: s.polishFindingsHash,
    };
    vc.rejected += 1;
    const row = rows.find((r) => r.id === c.id);
    if (row) row.status = `polish rejected after ${auditRounds} audit round(s) — draft kept`;
    console.warn(
      `  Volume ${volume.installmentNumber} ${c.id}: polish REJECTED after ${auditRounds} cross-model audit ` +
        `round(s) — keeping the draft (findings saved; the next run re-audits with them, or use --force for ` +
        `a fresh attempt).`
    );
  }
  // Re-merge the volume (the polished text wins now).
  const merged = await mergeVolumeTranslationFiles(volumeDir, bundle, state, {
    sourceLanguage,
    targetLanguage,
  });
  if (merged.text) {
    await fs.writeFile(path.join(volumeDir, MERGED_FILE), merged.text, "utf8");
  }
  if (merged.missing.length > 0) {
    console.error(
      `  Volume ${volume.installmentNumber}: INCOMPLETE — ${merged.missing.length} chapter(s) have no ` +
        `text after the polish pass: ${merged.missing.map((m) => m.id).join(", ")}.`
    );
  }
  // Persist the rejection bookkeeping (the cleared polish hashes + the kept
  // findings). The audit rounds saved the state before this phase, but the
  // decision to DROP a candidate is made here — without this save the state file
  // would still describe the polished text as the volume's latest word, and the
  // promise that "the findings persist for the next run" would depend on some
  // other phase having happened to save.
  await saveTranslationState(path.join(volumeDir, STATE_FILE), state);
  const lines = [
    `# Polish QA — Volume ${volume.installmentNumber} (${volume.folder})`,
    "",
    "_Polish pass (the polisher sees NO source text) gated by the deterministic regression guard" +
      (polishVerifyEnabled
        ? ` and the source-aware drift inspector (score 0–100; PASS at or above ${polishVerifyPassingScore}; ` +
          `an unparseable score is a FAIL).`
        : " only (POLISH_VERIFY_ENABLED=false).") +
      " A failed attempt re-polishes with the findings injected; a rejected chapter keeps its draft.",
    "",
    "| Chapter | Title | Status | Drift Score | Warnings |",
    "|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.title || "—"} | ${r.status} | ${r.score === null ? "—" : r.score + "/100"} | ${
          r.warnings.length > 0 ? r.warnings.join("; ") : "—"
        } |`
    ),
    "",
  ];
  await fs.writeFile(path.join(volumeDir, POLISH_QA_REPORT), lines.join("\n"), "utf8");
  return { polished: vc.polished, skipped: vc.skipped, rejected: vc.rejected, noDraft: vc.noDraft, missing: merged.missing };
}

// ─── Task entry ─────────────────────────────────────────────────────────────


module.exports = {
  finishPolishVolume,
};

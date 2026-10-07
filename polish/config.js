/**
 * Prompt-file locations and the per-role request sizes: the polisher's thinking and temperature, the audit's, the round cap, and the concurrency of each batch.
 *
 * Part of the polish.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types"); // JSDoc type definitions
const { ON_VOLUME_ERROR, PASSING_SCORE, validateRequiredEnv, resolveRunSettings, isStructuralError, structuralError, volumeFailureError } = require("../configs/shared");
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
const projectRoot = path.resolve(__dirname, "..");

const clientDir = projectRoot;

const seriesDir = process.env.SERIES_LOCATION;


const polishSystemPromptFile = path.join(clientDir, "system-prompts", "polish.md");

const polishTemplateFile = path.join(clientDir, "user-prompts", "polish.md");

const polishVerifySystemPromptFile = path.join(clientDir, "system-prompts", "polish-verify.md");

const polishVerifyTemplateFile = path.join(clientDir, "user-prompts", "polish-verify.md");

// (POLISH_QA_REPORT / POLISH_VERIFICATION_FILE come from utils/translate.js —
// the shared translation-stage layer, so no task module imports another.)


const polishThinking = stageThinking("EDIT");

const polishTemperature = writerTemperature("EDIT", 0.6);


/** The source-aware drift inspector — default-ON (the semantic backstop for
 *  the source-free polish pass). POLISH_VERIFY_ENABLED=false gates the pass
 *  on the deterministic regression guard only. */
const polishVerifyEnabled = process.env.POLISH_VERIFY_ENABLED !== "false";

/** Score (0–100) at or above which a polished text passes the drift check —
 *  the shared PASSING_SCORE. */
const polishVerifyPassingScore = PASSING_SCORE;

/** Max [polish + drift check] attempts per chapter (a FAIL re-polishes with
 *  the findings injected as correction tasks). */
const polishMaxRounds = (() => {
  const parsed = parseInt(process.env.POLISH_QA_MAX_ROUNDS, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 3;
})();

/** Findings injected into the re-polish prompt — keep them bounded (a
 *  numbered correction task, not a document to re-read). */
const POLISH_FINDINGS_MAX_CHARS = 3000;

/** Chapter concurrency within a volume (opt-in; default 1 = serial — the
 *  local hardware runs one inference at a time). */
const polishConcurrency = stageConcurrency("POLISH");


/** (#3/#4) The audit role — a SECOND endpoint (AUDIT_* env) that runs the
 *  final cross-check. The task logic is identical whatever model serves it;
 *  the pre-polish-audit hook decides which container answers on shared-port
 *  local setups. Configure it to a DIFFERENT model than the polisher's, or the
 *  cross-check grades the work with the same model twice. The final semantic
 *  check (drift + source) runs as a BATCHED pass, never interleaved per
 *  chapter. */
const auditThinking = stageThinking("AUDIT");

const auditTemperature = judgeTemperature();

/** (#3/#4) Audit batch concurrency (opt-in; default 1). */
const auditConcurrency = stageConcurrency("AUDIT");


module.exports = {
  clientDir,
  seriesDir,
  polishSystemPromptFile,
  polishTemplateFile,
  polishVerifySystemPromptFile,
  polishVerifyTemplateFile,
  polishThinking,
  polishTemperature,
  polishVerifyEnabled,
  polishVerifyPassingScore,
  polishMaxRounds,
  POLISH_FINDINGS_MAX_CHARS,
  polishConcurrency,
  auditThinking,
  auditTemperature,
  auditConcurrency,
};

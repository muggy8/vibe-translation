/**
 * The role's own settings: the VERIFY_* and AUDIT_* endpoints, the sampling a call that grades text must use (gotcha 59), the borderline bands, the repeat sampling that protects the coin-flip cases, and the switches for the two cross-checks.
 *
 * Part of the verify-translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types"); // JSDoc type definitions
const { ON_VOLUME_ERROR, PASSING_SCORE, ACCEPTANCE_SCORE_TOLERANCE, validateRequiredEnv, isStructuralError, volumeFailureError, readBoolEnv, resolveRunSettings } = require("../configs/shared");
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
const projectRoot = path.resolve(__dirname, "..");

const clientDir = projectRoot;

const seriesDir = process.env.SERIES_LOCATION;


const verifySystemPromptFile = path.join(clientDir, "system-prompts", "verify-translate.md");

const verifyTemplateFile = path.join(clientDir, "user-prompts", "verify-translate.md");

const consistencySystemPromptFile = path.join(clientDir, "system-prompts", "volume-consistency.md");

const consistencyTemplateFile = path.join(clientDir, "user-prompts", "volume-consistency.md");

// The sidecar I/O (loadVerificationSidecar / saveVerificationSidecar), the
// findings extractor and the glossary block now live in utils/translate.js —
// every translation task uses them, and task modules must not import from each
// other. They are re-exported at the bottom of this file for compatibility.


/** Verification is default-ON (it is the QA chain with retranslate). */
const verifyEnabled = process.env.VERIFY_TRANSLATE_ENABLED !== "false";

/** Chapter concurrency within a volume (opt-in; default 1 = serial — the
 *  local hardware runs one inference at a time). */
const verifyConcurrency = stageConcurrency("VERIFY");

/** Score (0–100) at or above which a chapter passes verification — the shared
 *  PASSING_SCORE (the same threshold the acceptance checks use). */
const passingScore = PASSING_SCORE;

/** The verify endpoint's thinking dialect (AI_THINKING + STAGE_THINKING_LEVEL). */
const verifyThinking = stageThinking("VERIFY");

/** Grading temperature (JUDGE_TEMPERATURE). */
const verifyTemperature = judgeTemperature();

/** Findings injected into the retranslate prompt — keep them bounded. */
const FINDINGS_MAX_CHARS = 6000;


/** (#5) The audit role — a SECOND endpoint (AUDIT_* env) used as the
 *  cross-check. The task logic is identical whatever model serves it; on
 *  shared-port local setups the pre-verify-audit hook decides which container
 *  answers. Configure it to a DIFFERENT model than the verifier, or the
 *  cross-check grades the work with the same model twice. */
const auditThinking = stageThinking("AUDIT");

const auditTemperature = judgeTemperature();

/** (#5) Borderline tiebreak: a chapter whose verifier score lands within
 *  ±VERIFY_TIEBREAK_BAND of the passing score is re-scored by the audit
 *  endpoint and the two scores are AVERAGED (a batched cross-check pass).
 *  DEFAULT-ON. */
const tiebreakEnabled = process.env.VERIFY_TIEBREAK_ENABLED !== "false";

const tiebreakBand = Math.max(0, parseInt(process.env.VERIFY_TIEBREAK_BAND, 10) || 5);

/** (#5) Audit batch concurrency (opt-in; default 1). */
const auditConcurrency = stageConcurrency("AUDIT");

/**
 * The cross-chapter consistency pass (DEFAULT-ON): one audit call per volume
 * window that reads the volume's PUBLISHED chapters together — the one thing a
 * per-chapter verifier structurally cannot see. Runs on the AUDIT_* role inside
 * the same batch as the tiebreak, so it costs no extra container switch.
 * Set VOLUME_CONSISTENCY_ENABLED=false to skip it (the deterministic variant
 * scan still runs).
 */
const volumeConsistencyEnabled = readBoolEnv("VOLUME_CONSISTENCY_ENABLED", true);


/**
 * How many times a borderline chapter is graded by the verifier. One stochastic
 * score decides a chapter's fate while the pre-production artifacts require a
 * rolling window of samples — the same grader, the same flakiness, a stricter
 * gate for the deliverable. Default 2.
 */
const verifySamples = Math.max(1, Math.min(5, parseInt(process.env.VERIFY_SAMPLES, 10) || 2));

/**
 * Only chapters within ±this many points of the passing score get the extra
 * samples: a chapter at 92 or at 30 is not a close call, and paying to re-grade
 * every chapter of 17 volumes is not what the sampling is for.
 */
const sampleBand = Math.max(0, parseInt(process.env.VERIFY_SAMPLE_BAND, 10) || 8);

/** Two samples further apart than this are settled by a third at temperature 0. */
const sampleTolerance = ACCEPTANCE_SCORE_TOLERANCE;

// ─── Cross-chapter consistency pass (the per-chapter blind spot) ────────────


/** How much of the previous audit window (or the previous volume) is carried
 *  into the next one as continuity context. */
const CONSISTENCY_TAIL_CHARS = 2000;


module.exports = {
  clientDir,
  seriesDir,
  verifySystemPromptFile,
  verifyTemplateFile,
  consistencySystemPromptFile,
  consistencyTemplateFile,
  verifyEnabled,
  verifyConcurrency,
  passingScore,
  verifyThinking,
  verifyTemperature,
  FINDINGS_MAX_CHARS,
  auditThinking,
  auditTemperature,
  tiebreakEnabled,
  tiebreakBand,
  auditConcurrency,
  volumeConsistencyEnabled,
  verifySamples,
  sampleBand,
  sampleTolerance,
  CONSISTENCY_TAIL_CHARS,
};

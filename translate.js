/**
 *
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./translate/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

require("dotenv").config();
require("./types"); // JSDoc type definitions
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
} = require("./utils/translate");

const __config = require("./translate/config");
const __volume = require("./translate/volume");
const __merge = require("./translate/merge");
const __report = require("./translate/report");
const __task = require("./translate/task");

module.exports = {
  ...__config,
  ...__volume,
  ...__merge,
  ...__report,
  ...__task,
  chapterArtifactNames,
  STATE_FILE,
  QA_REPORT_FILE,
  MERGED_FILE,
};

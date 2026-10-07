/**
 *
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./verify-translate/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

// .env, then the one setting that has a default — both before any task module is
// required, because several of them read these values at require time (gotcha 79).
require("./configs/env-defaults").bootstrapEnv();
require("./types"); // JSDoc type definitions
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
} = require("./utils/translate");

const __config = require("./verify-translate/config");
const __consistency = require("./verify-translate/consistency");
const __grade = require("./verify-translate/grade");
const __volume = require("./verify-translate/volume");
const __report = require("./verify-translate/report");
const __task = require("./verify-translate/task");

module.exports = {
  ...__config,
  ...__consistency,
  ...__grade,
  ...__volume,
  ...__report,
  ...__task,
  loadVerificationSidecar,
  findingsOf,
  glossaryBlock,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
};

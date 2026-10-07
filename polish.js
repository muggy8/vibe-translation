/**
 * polish.js — the last pass, two-phase and cross-model.
 *
 * Phase A (per chapter, the EDIT_* endpoint): a proofreading pass that sees NO SOURCE TEXT
 * — a source-seeing polisher re-opens unverified re-translation by a model that is not the
 * designated translator, which is exactly the gap the verify loop exists to close (gotcha
 * 24) — gated by the deterministic regression guard. Phase B (batched, on the SECOND
 * AUDIT_* endpoint): the final audit scores each candidate on the source-aware drift rubric;
 * a FAIL re-polishes with the findings injected and is re-audited next round.
 *
 * On exhaustion the polished text is REJECTED and the draft is kept — any polished file is
 * dropped so the merge publishes the draft — and the last findings persist, so the next run
 * re-audits with them. A polished chapter is up to date only when polishVerifiedDraftHash
 * === draftHash, which Phase B sets and Phase A does not.
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./polish/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

require("dotenv").config();
require("./types"); // JSDoc type definitions
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
} = require("./utils/translate");

const __config = require("./polish/config");
const __references = require("./polish/references");
const __audit = require("./polish/audit");
const __repair = require("./polish/repair");
const __phase_a = require("./polish/phase-a");
const __commit = require("./polish/commit");
const __task = require("./polish/task");

module.exports = {
  ...__config,
  ...__references,
  ...__audit,
  ...__repair,
  ...__phase_a,
  ...__commit,
  ...__task,
  POLISH_QA_REPORT,
  POLISH_VERIFICATION_FILE,
  processPolishVolume: __phase_a.polishVolumePhaseA,
};

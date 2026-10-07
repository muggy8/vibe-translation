/**
 * The reference blocks the polisher is allowed to see (glossary renderings and style rules — never the source) and the budget that trims them to the role's window, logging what was dropped.
 *
 * Part of the polish.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions
const harness = require("../harness");
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

/**
 * Fit a polish/audit prompt's reference blocks into the role's context window.
 *
 * The text being judged or polished (source / draft / polished) is never
 * trimmed — a grader that cannot see the whole chapter, or a polisher given a
 * sliced chapter, produces a meaningless verdict. The reference blocks give way,
 * in the order least-useful-first, and every drop is logged.
 *
 * @param {{blocks: Array<{name: string, text: string, priority: number}>, fixedTokens: number, endpoint: {contextWindow: number|null, maxTokens: number|null}, label: string}} p
 * @returns {{pick: (name: string, fallback: string) => string, dropped: Array<{name: string, chars: number}>}}
 */
function fitReferenceBlocks({ blocks, fixedTokens, endpoint, label }) {
  const roleWindow = endpoint.contextWindow || harness.envContextWindow();
  const outputReserve = endpoint.maxTokens || harness.envMaxTokens();
  const fitted = fitPromptBudget({ blocks, fixedTokens, roleWindow, outputReserve });
  if (fitted.dropped.length > 0) describeDroppedBlocks(fitted.dropped, label);
  const pick = (name, fallback) => {
    const b = fitted.blocks.find((x) => x.name === name);
    return b && b.text.trim() ? b.text : fallback;
  };
  return { pick, dropped: fitted.dropped };
}


/** The reference blocks a polish pass injects (never the source text). */
function polishReferenceBlocks({ refs, sourceText }) {
  return [
    { name: "GLOSSARY", text: glossaryBlock(chapterTerminology(refs, sourceText).terms), priority: 5 },
    { name: "STYLE_RULES", text: refs.styleRules || "", priority: 3 },
    { name: "VOICE_NOTES", text: refs.voiceNotes || "", priority: 1 },
  ];
}

// ─── Per-volume processing ──────────────────────────────────────────────────


module.exports = {
  fitReferenceBlocks,
  polishReferenceBlocks,
};

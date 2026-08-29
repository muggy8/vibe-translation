/**
 * types.js — JSDoc type definitions shared across the ai-client modules.
 *
 * These are pure annotation types (typedef) used only in JSDoc @param /
 * @returns tags. They are exported so IDE type-checking follows references
 * across files.
 *
 * @example
 * const { runOneShot } = require("./harness");
 */

// ─── Translation target manifest ─────────────────────────────────────────────

/**
 * @typedef {Object} TranslationTargetVolume
 * A single volume entry in the translation-target manifest.
 * @property {string} folder            — Volume folder name.
 * @property {string} sourceFile        — Path to source text file relative to series dir.
 * @property {string} installmentNumber — Zero-padded installment number (e.g. "01").
 * @property {string} [seriesName]      — Deprecated; series name recorded by agent.
 * @property {string} [installment]     — Deprecated; human-readable installment label.
 */

/**
 * @typedef {Object} TranslationTargetManifest
 * The translation-target manifest produced by get-translation-target.js.
 * @property {string}                       seriesLocation   — The SERIES_LOCATION path.
 * @property {string}                       seriesName       — The series name.
 * @property {string}                       sourceLanguage   — Source language code.
 * @property {string}                       targetLanguage   — Target language code.
 * @property {string}                       generator        — Module that produced this manifest.
 * @property {string}                       generatedAt      — ISO timestamp of generation.
 * @property {TranslationTargetVolume[]}    volumes          — Array of volume entries.
 */

// ─── Workflow volume contexts ────────────────────────────────────────────────

/**
 * @typedef {Object} ResearchConcurrency
 * Configuration for parallel research agent execution.
 * @property {number} value - Number of parallel research agents (1 = sequential).
 */

/**
 * @typedef {Object} GlossaryVolumeCtx
 * The volume context passed to glossary task functions.
 * @property {{INSTALLMENT_NUMBER: string}} values
 * @property {string} volumeDir
 * @property {string} sourceFile
 * @property {string} glossaryOutputFile
 * @property {string} validationOutputFile
 * @property {string} glossarySystemPrompt
 * @property {string} glossaryUserPrompt
 * @property {string} validatorSystemPrompt
 * @property {string} validatorUserPrompt
 * @property {string} feedbackUserPrompt
 * @property {string} acceptanceSystemPrompt
 * @property {string} acceptanceUserPrompt
 * @property {Object} fsGate — Gated filesystem tools (from createGatedFsTools).
 * @property {string} [seriesDir]
 * @property {string} [previousGlossary]
 * @property {boolean} [limitReached]
 */

/**
 * @typedef {Object} WikiVolumeCtx
 * The volume context passed to jump-in-wiki task functions.
 * @property {{INSTALLMENT_NUMBER: string}} values
 * @property {string} volumeDir
 * @property {string} sourceFile
 * @property {string} wikiOutputFile
 * @property {string} sharedWikiOutputFile
 * @property {string} validationOutputFile
 * @property {string} validationFileName
 * @property {string} authorSystemPrompt
 * @property {string} authorUserPrompt
 * @property {string} validatorSystemPrompt
 * @property {string} validatorUserPrompt
 * @property {string} feedbackUserPrompt
 * @property {string} acceptanceSystemPrompt
 * @property {string} acceptanceUserPrompt
 * @property {Object} fsGate — Gated filesystem tools (from createGatedFsTools).
 * @property {string} [seriesDir]
 * @property {string} [previousWiki]
 * @property {string} [previousSharedWiki]
 * @property {boolean} [limitReached]
* @property {boolean} [limitReached]
 */

// ─── Harness primitives ──────────────────────────────────────────────────────

/**
 * @typedef {Object} IMessage
 * A single message input for runOneShot.
 * @property {string} [text] — Text content.
 * @property {string} [file] — File path (mutually exclusive with text).
 * @property {string} [name] — File name (required when file is set).
 */

/**
 * @typedef {Object} RunOneShotCfg
 * Configuration for harness.runOneShot().
 * @property {string} systemPrompt
 * @property {Array<IMessage>} messages
 * @property {number} [retry]
 * @property {boolean} [thinking]
 * @property {string} [thinkingLevel]
 * @property {string} [label]
 */

/**
 * @typedef {Object} CreateAgentHandleCfg
 * Configuration for harness.createAgentHandle().
 * @property {string} name
 * @property {string} systemPrompt
 * @property {Object} [tools] — Tool set (omitted/empty = no tools).
 * @property {Function} [approve] — open-harness ApproveFn (the write gate).
 * @property {string} [cwd] — Base dir for fs tools.
 * @property {number} [maxSteps] — Step cap.
 * @property {number} [retry] — Error retries.
 * @property {boolean} [thinking] — Thinking mode.
 * @property {string} [thinkingLevel] — reasoning_effort level.
 * @property {number} [contextWindow] — Compaction window.
 */

/**
 * @typedef {Object} AgentHandle
 * The handle returned by createAgentHandle().
 * @property {string} name
 * @property {Object} session
 * @property {Function} sendTurn
 * @property {Function} close
 */

/**
 * @typedef {Object} Taps
 * Accumulated SSE event diagnostics.
 * @property {number} startTime
 * @property {number} [firstTokenTime]
 * @property {string} [finishReason]
 * @property {string} text
 * @property {string} reasoning
 * @property {Object} [usage]
 */

/**
 * @typedef {Object} FetchResult
 * The accumulated result returned by consumeEvents / sendTurn.
 * @property {string} result        — e.g. "stop", "max_steps".
 * @property {string} text
 * @property {string} reasoning
 * @property {Object} [usage]
 * @property {number} [firstTokenTime]
 * @property {string} [finishReason]
 */

/**
 * @typedef {Object} WikiTools
 * Tool set returned by createWikiTools().
 * @property {Function} wiki_search
 * @property {Function} wiki_extract
 */

// ─── Research ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ResearchNote
 * A single research note entry.
 * @property {string} term
 * @property {string} query
 * @property {Array<Object>} results
 * @property {boolean} found
 */

// ─── Exports (for IDE reference resolution) ─────────────────────────────────

module.exports = {
  TranslationTargetManifest: true,
  TranslationTargetVolume: true,
  ResearchConcurrency: true,
  GlossaryVolumeCtx: true,
  WikiVolumeCtx: true,
  IMessage: true,
  RunOneShotCfg: true,
  CreateAgentHandleCfg: true,
  AgentHandle: true,
  Taps: true,
  FetchResult: true,
  WikiTools: true,
  ResearchNote: true,
};


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

// ─── Source bundles (utils/source.js) ───────────────────────────────────────

/**
 * @typedef {Object} SourceSegment
 * One readable segment of a volume's source, in reading order.
 * @property {string} id    — "whole" | "ch0" | "chN" | "chN.K" (interlude/epilogue K after chapter N).
 * @property {string} file  — File name inside the volume folder.
 * @property {string} title — The chapter title (or the file name for text sources).
 * @property {number} chars — Character count of the segment file.
 * @property {string} [path] — Absolute path (set by materializeBundle).
 */

/**
 * @typedef {Object} SourceBundle
 * The resolved, normalized source of a volume.
 * @property {"text"|"epub"} format     — "text" = plain file as-is, "epub" = extracted bundle.
 * @property {string} originalPath      — The real source file on disk (.md/.txt/.epub).
 * @property {string} base              — The source base name (no extension).
 * @property {string} volumeDir         — The volume folder.
 * @property {string} wholePath         — The text file covering the whole volume.
 * @property {SourceSegment[]} segments — In reading order (authoritative — chN.K interlude files do not sort by name).
 * @property {string|null} imagesDir    — The images/ folder (epub bundles with images).
 * @property {number} wholeChars        — Character count of the whole-volume text.
 * @property {boolean} cacheHit         — True when a cached epub bundle was reused.
 * @property {string|null} sourceFingerprint — sha256 of the source file (set by
 *   resolveSourceBundle); the skip-checks compare it against the fingerprint
 *   persisted in the last run's rolling state (isSourceStale).
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
 * @property {SourceBundle} bundle — The resolved source bundle (utils/source.js).
 * @property {boolean} chunked — True when the volume uses the chapter-by-chapter fallback.
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
 * @property {WikiTools} wikiTools — Wikipedia research tools (from createWikiTools), set by runVolumeAgent.
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
 * @property {SourceBundle} bundle — The resolved source bundle (utils/source.js).
 * @property {boolean} chunked — True when the volume uses the chapter-by-chapter fallback.
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
 */

/**
 * @typedef {Object} CharacterVoiceVolumeCtx
 * The volume context passed to character-voice task functions.
 * @property {{INSTALLMENT_NUMBER: string}} values
 * @property {string} volumeDir
 * @property {string} sourceFile
 * @property {SourceBundle} bundle — The resolved source bundle (utils/source.js).
 * @property {boolean} chunked — True when the volume uses the chapter-by-chapter fallback.
 * @property {string} voiceOutputFile
 * @property {string} povOutputFile
 * @property {string} validationOutputFile
 * @property {string} validationFileName
 * @property {string} extractSystemPrompt
 * @property {string} extractUserPrompt
 * @property {string} authorSystemPrompt
 * @property {string} authorUserPrompt
 * @property {string} validatorSystemPrompt
 * @property {string} validatorUserPrompt
 * @property {string} feedbackUserPrompt
 * @property {string} acceptanceSystemPrompt
 * @property {string} acceptanceUserPrompt
 * @property {Object} fsGate — Gated filesystem tools (from createGatedFsTools).
 * @property {string} [seriesDir]
 * @property {boolean} isFirst — True for the first volume (no previous reference).
 * @property {string|null} previousFolderName — Previous volume folder (null for the first volume).
 * @property {string|null} previousVoiceRefFile — Path to the previous volume's character-voice.md.
 * @property {boolean} [limitReached]
 */

/**
 * @typedef {Object} StyleGuideVolumeCtx
 * The volume context passed to style-guide task functions.
 * @property {{INSTALLMENT_NUMBER: string}} values
 * @property {string} volumeDir
 * @property {string} sourceFile
 * @property {SourceBundle} bundle — The resolved source bundle (utils/source.js).
 * @property {boolean} chunked — True when the volume uses the chapter-by-chapter fallback.
 * @property {string} styleOutputFile
 * @property {string} validationOutputFile
 * @property {string} authorSystemPrompt
 * @property {string} authorUserPrompt
 * @property {string} validatorSystemPrompt
 * @property {string} validatorUserPrompt
 * @property {string} feedbackUserPrompt
 * @property {string} acceptanceSystemPrompt
 * @property {string} acceptanceUserPrompt
 * @property {Object} fsGate — Gated filesystem tools (from createGatedFsTools).
 * @property {boolean} isFirst — True for the first volume (no previous guide).
 * @property {string|null} previousFolderName — Previous volume folder (null for the first volume).
 * @property {string|null} previousStyleGuideFile — Path to the previous volume's style-guide.md.
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
 * @typedef {Object} EndpointOverride
 * A role-specific endpoint for runOneShot (the translation stage's roles —
 * the TRANSLATE_, VERIFY_, and EDIT_ env prefixes — each resolve to one of
 * these).
 * @property {string} [baseUrl] — OpenAI-compatible base URL (default: AI_BASE_URL).
 * @property {string} [apiKey] — Auth key (default: AI_API_KEY).
 * @property {string} [model] — Model id (default: AI_MODEL).
 */

/**
 * @typedef {Object} RunOneShotCfg
 * Configuration for harness.runOneShot().
 * @property {string|null} [systemPrompt] — The system prompt. null/undefined
 *   sends NO system message (required by the Hy-MT2 translation role, whose
 *   official contract is a single user message).
 * @property {Array<IMessage>} messages
 * @property {number} [retry]
 * @property {boolean|string} [thinking] — Thinking mode; for the hy-mt
 *   template dialect also "no_think" | "low" | "high".
 * @property {string} [thinkingLevel] — reasoning_effort level.
 * @property {"qwen"|"hy-mt"} [thinkingTemplate] — Chat-template dialect for
 *   the thinking parameters (default: "qwen").
 * @property {EndpointOverride} [endpoint] — Per-call endpoint override
 *   (defaults to the global AI_* settings).
 * @property {number} [temperature] — Per-call temperature (default: AI_TEMPERATURE).
 * @property {{topP?: number, topK?: number, minP?: number, repetitionPenalty?: number, presencePenalty?: number}} [sampling]
 *   Per-call sampling parameters merged into the request body.
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

// ─── Translation stage (translate / verify-translate / retranslate / polish) ─

/**
 * @typedef {Object} TranslationStateEntry
 * One chapter's entry in a volume's translation-state.json (per-chapter
 * idempotency + source/reference/draft staleness invalidation).
 * @property {string} sourceHash — sha256 of the chapter source content.
 * @property {string} contextHash — sha256 of the injected references (glossary + style rules + background).
 * @property {string} draftHash — sha256 of the current draft file content.
 * @property {boolean} retranslated — A retranslate pass has run for the findings.
 * @property {string|null} findingsHash — sha256 of the findings the last retranslate used.
 * @property {string|null} polishedDraftHash — sha256 of the draft the last polish pass polished (null = unpolished).
 */

/**
 * @typedef {Object} VerificationEntry
 * One chapter's entry in a volume's translation-verification.json sidecar.
 * @property {string} sourceHash — sha256 of the chapter source at verification time.
 * @property {string} draftHash — sha256 of the draft that was verified.
 * @property {number|null} score — 0–100 (null = unparseable verdict = FAIL, fail-closed).
 * @property {boolean} pass — score !== null && score >= VERIFY_PASSING_SCORE.
 * @property {string} findings — The verifier's findings text (retranslate's input).
 * @property {string} verifiedAt — ISO timestamp.
 */

/**
 * @typedef {Object} VolumeReferences
 * The reference artifacts the translation stage injects into its prompts
 * (loadVolumeReferences in utils/translate.js).
 * @property {string} glossaryText — Raw glossary.md content ("" when absent).
 * @property {Array<{term: string, rendering: string, section: string}>} terms — Parsed glossary terms.
 * @property {string[]} terminologyLines — `"term" translates to "rendering"` lines for the Hy-MT2 prompt.
 * @property {string} styleRules — The style guide's Policy Summary (or truncated fallback).
 * @property {string} background — Volume wiki + POV map (truncated) — plot context.
 * @property {string} voiceNotes — Character voice reference (truncated) — for the polish pass.
 * @property {string} contextHash — sha256 of (glossary + styleRules + background); the idempotency key.
 */

// ─── Pipeline hooks (utils/hooks.js) ─────────────────────────────────────────

/**
 * @typedef {Object} HookContext
 * The context describing a pipeline hook invocation (also the source of the
 * AI_CLIENT_* env vars injected into shell hooks). See utils/hooks.js.
 * @property {string} task - The step name (glossary / character-voice / style-guide / jump-in-wiki / consistency-audit / translate / verify-translate / retranslate / polish / pipeline).
 * @property {"before"|"after"} phase - Which side of the step.
 * @property {string} seriesDir - Absolute SERIES_LOCATION ("" when unset).
 * @property {string} seriesName - The SERIES_NAME.
 * @property {boolean} dryRun - True when run with --dry-run.
 * @property {boolean} force - True when run with --force.
 * @property {boolean} chunked - True when run with --chunked.
 * @property {string|null} volume - The --volume argument, or null.
 * @property {boolean|undefined} succeeded - After hooks only: whether the task resolved.
 * @property {Error|null} error - After hooks only: the task error (when it threw).
 * @property {string[]} argv - The process argv.
 * @property {Object<string,string>} env - The process env.
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
  SourceSegment: true,
  SourceBundle: true,
  ResearchConcurrency: true,
  GlossaryVolumeCtx: true,
  WikiVolumeCtx: true,
  CharacterVoiceVolumeCtx: true,
  StyleGuideVolumeCtx: true,
  IMessage: true,
  EndpointOverride: true,
  RunOneShotCfg: true,
  CreateAgentHandleCfg: true,
  AgentHandle: true,
  Taps: true,
  FetchResult: true,
  WikiTools: true,
  ResearchNote: true,
  TranslationStateEntry: true,
  VerificationEntry: true,
  VolumeReferences: true,
  HookContext: true,
};


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
 * A single volume entry in the translation-target manifest (schema 2).
 * @property {string} folder            — Volume folder name (chosen by the intake agent).
 * @property {string} sourceFile        — Path to the staged source file, relative to the series folder.
 * @property {string} installmentNumber — Zero-padded reading-order position (e.g. "01").
 * @property {string} [title]           — This volume's own title, as the book states it.
 * @property {string} [notes]           — Anything the intake agent had to decide for this volume.
 */

/**
 * @typedef {Object} TranslationTargetDiscovery
 * The intake agent's own account of its decisions — the audit trail a human
 * reads when a plan turns out wrong.
 * @property {string}          [summary]    — What was found and how it was decided.
 * @property {Object<string, number>} [confidence] — Per-decision confidence, 0 to 1.
 * @property {string[]}        [evidence]   — Each decision and the evidence for it.
 * @property {Array<{file: string, reason: string}>} [excluded] — Files judged not to be volumes.
 */

/**
 * @typedef {Object} TranslationTargetManifest
 * The translation-target manifest (schema 2) produced by get-translation-target.js:
 * the plan of record every pipeline step reads.
 * @property {number}                         schema           — Manifest schema version (2).
 * @property {string}                         seriesLocation   — The SERIES_LOCATION path.
 * @property {string}                         seriesName       — The series name, in its own language.
 * @property {string}                         [seriesNameAlt]  — Romanized/ASCII form of the name.
 * @property {string}                         sourceLanguage   — Source language name.
 * @property {string}                         targetLanguage   — Target language name.
 * @property {string}                         generator        — Module that produced this manifest.
 * @property {string}                         generatedAt      — ISO timestamp of generation.
 * @property {TranslationTargetDiscovery}     [discovery]      — The intake agent's decisions and evidence.
 * @property {TranslationTargetVolume[]}      volumes          — Volume entries, in reading order.
 */


// ─── Source bundles (utils/source.js) ───────────────────────────────────────

/**
 * @typedef {Object} SourceSegment
 * One readable segment of a volume's source, in reading order.
 * @property {string} id    — "whole" | "ch0" | "chN" | "chN.K" (interlude/epilogue K after chapter N).
 * @property {string} file  — File name inside the volume folder.
 * @property {string} title — The title the BOOK gave this section; a placeholder ("Untitled section N", the file name for text sources) when the book gave it none.
 * @property {number} chars — Character count of the segment file.
 * @property {number} [bodyChars] — Characters of text the section converted to (undefined when the extraction did not measure it).
 * @property {boolean} [empty] — True when the section converted to (almost) nothing: a blank page, an image-only page, text in a structure the converter does not map.
 * @property {boolean} [syntheticTitle] — True when `title` is the pipeline's placeholder, not a title the book prints.
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
 * @property {Array<{title: string, reason: string, pages: number, bodyChars: number, textChars: number}>|null} packaging — epub bundles only: the page groups that are the book's packaging rather than a chapter (cover, inserted illustrations, notices, contents page, colophon), and why each was skipped. null for plain-text sources.
 * @property {string|null} imagesDir    — The images/ folder (epub bundles with images).
 * @property {number} wholeChars        — Character count of the whole-volume text.
 * @property {boolean} cacheHit         — True when a cached epub bundle was reused.
 * @property {string|null} sourceFingerprint — sha256 of the source file (set by
 *   resolveSourceBundle); the skip-checks compare it against the fingerprint
 *   persisted in the last run's rolling state (isSourceStale).
 */

// ─── Epub container (utils/source.js openEpub) ──────────────────────────────

/**
 * @typedef {Object} EpubMetadata
 * The catalog card read from an epub's OPF.
 * @property {string}   title        — dc:title (first).
 * @property {string[]} titles       — every dc:title.
 * @property {string}   creator      — dc:creator (first).
 * @property {string[]} creators     — every dc:creator.
 * @property {string}   language     — dc:language (first) — a claim to check, not a fact.
 * @property {string[]} languages    — every dc:language.
 * @property {string}   publisher    — dc:publisher.
 * @property {string}   identifier   — dc:identifier.
 * @property {string}   date         — dc:date.
 * @property {string}   series       — the series marker the reading app embedded (Calibre or an EPUB3 collection).
 * @property {string}   seriesIndex  — the book number inside that series.
 * @property {Array<{name: string, kinds: string[]}>} collections — every belongs-to-collection entry.
 */

/**
 * @typedef {Object} OpenedEpub
 * An open epub container: everything a reader needs to decide what the book is.
 * @property {string} epubPath        — The file it was opened from.
 * @property {Object} zip             — The JSZip archive.
 * @property {string} opfPath         — The OPF's zip entry path.
 * @property {string} opfDir          — The OPF's zip directory (hrefs resolve against it).
 * @property {EpubMetadata} metadata  — The catalog card.
 * @property {Array<{id: string, href: string, mediaType: string, properties: string}>} manifestItems
 * @property {Array<{id: string, href: string, mediaType: string}>} spine — Items in reading order.
 * @property {Array<{index: number, zipPath: string, href: string, mediaType: string}>} textItems — Readable sections, 1-based.
 * @property {Map<string, string>} titles — zip path → section title (from the nav/NCX).
 * @property {Array<{zipPath: string, title: string, order: number, inToc: boolean, types: string[]}>} navEntries — the same nav links IN DOCUMENT ORDER: the book's own declaration of where its sections begin. `inToc` is false for a landmarks-only pointer ("this is where the main text starts"); `types` collects any `epub:type` the book declared on that link.
 * @property {{textBytes: number, otherBytes: number}} payload — Uncompressed archive bytes, split by the zip central directory: XHTML pages vs everything else (images, fonts, css). 0 when the archive does not report sizes.
 * @property {number} imageCount      — Images declared in the OPF manifest.
 * @property {number} entryCount      — Entries in the archive.
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
 * @property {number} [contextWindow] — Context window the turn's working-window pressure is measured against.
 * @property {boolean} [contextManagement] — Opt in to the delivery-layer context management (uncapped
 *   turn run in chunks, `manage_context` / `recall_memory` tools, offload-to-disk instead of lossy
 *   compaction). Only the roles named in `utils/context.js`'s `CONTEXT_MANAGED_ROLES` can opt in; a
 *   pipeline stage agent asking for it is ignored, because keeping everything in context IS its job.
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
 * @property {number} retranslateAttempts — How many times this chapter has been retranslated against the CURRENT findings set (the stall guard's retry budget; resets when the findings change).
 * @property {boolean} qaFailed — The current draft failed the deterministic QA checks. It is kept on disk (marked) so the QA loop has something to correct; verify seeds its verdict from qaFindings without a model call, and retranslate treats it as a FAIL.
 * @property {string|null} qaFindings — The deterministic QA failure as numbered correction tasks (the retranslate prompt's "fix these" list).
 * @property {number|null} bestScore — The highest verification score this chapter has ever earned (the draft ratchet's baseline).
 * @property {string|null} bestDraftHash — sha256 of that best draft (translation-<id>.best.md).
 * @property {{score: number|null, pass: boolean, findings: string, verifiedAt: string}|null} bestVerdict — The verdict the best draft earned (re-pointed into the sidecar when the ratchet restores it).
 * @property {boolean} noImprovement — The last rewrite scored worse than bestScore, so the ratchet rolled the chapter back.
 * @property {string|null} findingsHash — sha256 of the findings the last retranslate used.
 * @property {string|null} polishedDraftHash — sha256 of the draft the last polish pass polished (null = unpolished).
 * @property {string|null} polishVerifiedDraftHash — sha256 of the draft the source-aware drift inspector approved (null = unverified).
 * @property {number|null} polishScore — Last drift-inspector score (0–100; null = unparseable, or inspector disabled).
 * @property {string|null} polishFindings — The last rejected attempt's findings (seeds the next run's re-polish).
 * @property {string|null} polishFindingsHash — sha256 of polishFindings (null when none).
 */

/**
 * @typedef {Object} PolishVerificationEntry
 * One chapter's entry in a volume's polish-verification.json sidecar (the
 * source-aware drift inspector's verdict — the polish pass's semantic QA;
 * the polisher itself sees no source text).
 * @property {string} sourceHash — sha256 of the chapter source at check time.
 * @property {string} draftHash — sha256 of the draft the polished text was produced from.
 * @property {number|null} score — 0–100 (null = unparseable verdict = FAIL, fail-closed; or inspector disabled).
 * @property {boolean} pass — score !== null && score >= PASSING_SCORE (true when the inspector is disabled and the deterministic guard passed).
 * @property {string} findings — The inspector's findings text (the re-polish's input).
 * @property {string} verifiedAt — ISO timestamp.
 */

/**
 * @typedef {Object} VerificationEntry
 * One chapter's entry in a volume's translation-verification.json sidecar.
 * @property {string} sourceHash — sha256 of the chapter source at verification time.
 * @property {string} draftHash — sha256 of the draft that was verified.
 * @property {number|null} score — 0–100 (null = unparseable verdict = FAIL, fail-closed). The MEDIAN of `samples` when more than one sample was taken.
 * @property {number[]} samples — The grades this draft received (1 for a confident chapter; 2–3 for a borderline one, the last possibly at temperature 0).
 * @property {boolean} deterministic — True when the verdict came from the deterministic QA findings instead of a model call (the draft was flagged qaFailed).
 * @property {boolean} pass — score !== null && score >= PASSING_SCORE.
 * @property {string} findings — The verifier's findings text (retranslate's input).
 * @property {{verifier: number, auditor: number|null, final: number, rescue: boolean}} tiebreak — The cross-model audit's scores for this chapter (present after a tiebreak).
 * @property {boolean} tiebreakRescue — The chapter passes ONLY because the tiebreak raised it above the line.
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
 * @property {string} task - The step name (discover / glossary / character-voice / style-guide / jump-in-wiki / consistency-audit / translate / verify-translate / retranslate / translate-qa / polish / translation-report / pipeline).
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
  TranslationTargetDiscovery: true,
  EpubMetadata: true,
  OpenedEpub: true,
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


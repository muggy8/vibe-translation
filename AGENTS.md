# AGENTS.md — ai-client

**Read this first.** This is the entry point for AI agents working in this project. The codebase is small (~18k lines across 11 task modules + harness.js + utils/) and the JSDoc in each file is excellent — this doc is the map plus the hard-won gotchas; open the referenced file when you need depth.

## 1. What this is

An agentic AI client (v2.0.0, CommonJS, Node ≥ 22.19) that processes a light-novel series **volume by volume** and produces translation-support artifacts:

- `discover` task (step 0) → **series intake**: an agent is handed `SERIES_LOCATION` and works out the rest for itself — which files are volumes (and which are art books / previews / duplicates), the reading order, the series name, the source language — then names and creates each volume folder, stages the book inside, and writes the plan of record (`translation-target.json`) plus a human-readable `translation-plan.md`. See §3.5
- `glossary` task → a canonical target-language glossary (per-volume snapshots + a final copy at the series root)
- `character-voice` task → a cumulative character voice reference (speech quirks, POV markers, narration types) and per-volume POV maps
- `style-guide` task → a cumulative style guide (house-style policies for rendering source-language constructs in the target language)
- `jump-in-wiki` task → a per-volume `wiki.md` plus a "living" `shared-wiki.md` (newest copy at the series root)
- `consistency-audit` task → a final cross-artifact audit (`consistency-report.md`, PASS/FAIL sign-off before translation)
- **translation stage** (`translate` → `translate-qa` → `polish`) → the actual translation of every volume, per chapter, by a **multi-model chain** (Hy-MT2 translates; the `translate-qa` loop then runs verify (Qwen) → retranslate (Hy-MT2) rounds until every chapter passes verification — or the round cap / stall guard stops it — and Qwen polishes last) — see §8.5
- plus deterministic translation-handoff artifacts per volume: `chapters.json` + `translation-brief.md` (and the persisted extraction JSONs / glossary coverage report)

It talks to any **OpenAI-compatible endpoint** through the Vercel AI SDK + `@openharness/core`. Tool-calling agents read the sources and write the outputs themselves through sandboxed file tools.

### Quickstart

| Command | What it does |
|---|---|
| `npx gulp discover` | Series intake only: explore `SERIES_LOCATION`, decide the series name / source language / volume order / exclusions, lay out the volume folders, write `translation-target.json` + `translation-plan.md` |
| `npx gulp glossary` | Run the glossary task (all volumes) |
| `npx gulp character-voice` | Run the character voice reference task (all volumes) |
| `npx gulp style-guide` | Run the style guide task (all volumes) |
| `npx gulp jump-in-wiki` | Run the wiki task |
| `npx gulp consistency-audit` | Run the final cross-artifact consistency audit (writes `consistency-report.md`) |
| `npx gulp translate` | Translate all volumes, per chapter (Hy-MT2 endpoint; `TRANSLATE_*` env) |
| `npx gulp verify-translate` | Source-anchored verification of the drafts, per chapter (Qwen endpoint; `VERIFY_*` env). FAILs are fixed by `retranslate`. Default-ON — `VERIFY_TRANSLATE_ENABLED=false` makes it (and `retranslate`) a no-op |
| `npx gulp retranslate` | Retranslate the chapters that FAILED verification (Hy-MT2, findings injected as correction tasks; the bad draft is not fed back) |
| `npx gulp translate-qa` | The translation QA loop: verify batch (Qwen) → retranslate batch (Hy-MT2), repeated until every chapter passes, a round retranslates nothing (stalled), or `TRANSLATE_QA_MAX_ROUNDS` (default 3) rounds run |
| `npx gulp polish` | Final Qwen polish pass per chapter (with a deterministic regression guard that rejects a polish worse than the draft) |
| `npx gulp` (default) | All nine in order: discover → glossary → character-voice → style-guide → jump-in-wiki → consistency-audit → translate → translate-qa → polish (translate-qa loops verify → retranslate internally) |
| `... --dry-run` | No AI calls; dump the exact prompts to `.dry-run/<task>-NN.md` (`discover` previews the deterministic layout instead) |
| `... --force` | Regenerate even if outputs already exist |
| `... --volume NN` | Process a single volume (e.g. `--volume 01`) — resolved through the manifest's installment numbers, not by parsing folder names |
| `... --chunked` | Force the chapter-by-chapter fallback for multi-chapter epub volumes (the default is whole-installment processing; the fallback also triggers automatically when the whole text exceeds `SOURCE_CHUNK_THRESHOLD_CHARS`) |
| `npm test` | Pure-function tests (no AI, no network) |
| `npm run smoke` | Live smoke test against the `.env` endpoint (`one-shot` / `research` / `fs` arg selects one check) |
| `npm start` | Ad-hoc harness CLI: `node harness.js --system "..." --text "..." [--file f --name n]` |

## 2. File map

| Path | Role |
|---|---|
| `configs/shared.js` | Shared constants extracted from task modules (`AGENT_TOOLS_NOTE`) and score-based acceptance config (`ACCEPTANCE_WINDOW_SIZE`, `PASSING_SCORE` — the one threshold every scored gate uses, `ACCEPTANCE_STRATEGY`, `ACCEPTANCE_BEST_MIN_PASSES`, `computeRollingAverage`, `meetsAcceptanceCriteria`, `isAcceptedState`). All nine task modules import from here. Also provides `saveRollingState` / `loadRollingState` for persisting the rolling window of scores to disk (the state file also carries the run's `sourceFingerprint` — see §3 "Source-staleness detection") and `isSourceStale(state, bundle)` (fail-open when either side lacks a fingerprint). Also provides `STAGE_CONCURRENCY` — the one worker-count knob for every stage (research agents per glossary term, chapters per verify / retranslate / polish pass, chapters per audit batch) — and `seriesArtifactFile(name, legacyEnvKey, seriesDir)`, which resolves the four series-level copies from `SERIES_ARTIFACTS_DIR`. Also provides the un-monitored run policies (`normalizePolicy`, `ON_VOLUME_ERROR`, `ON_MISSING_PREVIOUS`, `ON_QA_LIMIT`) and `validateRequiredEnv({ dryRun })` — the fail-fast check for missing required env vars (see §3 "Un-monitored run policies"). |
| `utils/fs.js` | Filesystem helpers: `fileExists`, `assertWrote`, `assertWroteWithFallback` (chat-reply fallback — returns true ONLY when a file was actually missing, and callers MUST gate their recovery turn on that value), `writeProvenanceSidecar` (writes the `<copy>.provenance.json` sidecar next to a series-root artifact copy). |
| `utils/prompt.js` | Prompt/verdict helpers: `transformUserPrompt`, `isPassingVerdict` (legacy binary verdict — kept for compatibility, no longer used in the acceptance path), `parseAcceptanceReply` (parses the acceptance one-shot reply — the JSON `{"score", "band", "note"}` contract first, then the legacy `parseAcceptanceScore` integer forms as a fallback; `null` = unparseable = failed check), `parseAcceptanceScore` (legacy 0–100 integer parser — the fallback half of `parseAcceptanceReply`), `validatorMaxStepsFor`, `writePromptDump`. |
| `utils/manifest.js` | JSON/manifest helpers: `extractJsonObject`, `installmentNumberFromDir` (legacy), `normalizeInstallmentNumber` ("1"/1/"007" → "01"), `sanitizeFolderName` (an agent-chosen folder name is validated, never rewritten: no separators, no `..`, no absolute paths, no Windows-illegal characters, source-language text kept), `filterVolumesByInstallment` (the `--volume NN` lookup — by the manifest's installment number, or an exact folder name). |
| `utils/source.js` | Source-bundle helpers: `resolveSourceBundle` (normalizes a volume's source into a `SourceBundle`; plain-text passes through as-is, `.epub` is extracted once and cached; every bundle carries a `sourceFingerprint` — `sha256OfFile(originalPath)` for plain text, the cache `sha256` for epub — used by the source-staleness detection, see §3), `shouldProcessChunked` (decides whole-installment vs chapter-by-chapter fallback), **`openEpub` (the single shared epub container reader: catalog card — title/creator/language/publisher/identifier plus the Calibre or EPUB3 series marker — the manifest, the spine, the readable sections and their nav titles; parses the OPF as XML)**, `readEpubSection` (bounded plain-text slice of one section), `htmlToPlainText`, `scriptCounts` (kana/hangul/Han/latin counts — evidence for the intake agent, not a decision), `extractEpubToBundle` (built on `openEpub`; XHTML → Markdown, per-chapter files, interludes, epilogue, images), `assignSegmentIds`, `classifyTitle`, `xhtmlToMarkdown`, `sourceMaterialLine`, `sourceSegmentListLine`, `chapterSegmentNote`, `chapterContextBlock`, `isEpubPath`, `normalizeZipPath`, `sha256OfFile`. All nine task modules resolve their source through `resolveSourceBundle` at the choke point; the intake agent's epub tools go through `openEpub`. |
| `utils/handoff.js` | Deterministic per-volume translation handoff (no AI): `buildChaptersJson` (chapter list from the bundle segments), `renderNewEntry`, `buildTranslationBriefMarkdown` (pure — the one-page brief: new terms/voices/style rules from the persisted extraction JSONs, chapter table, pointers to every per-volume + series-level reference artifact), `writeVolumeHandoff` (best-effort writer of `chapters.json` + `translation-brief.md`; called from jump-in-wiki.js on both the processed and skipped paths — a failure warns, never fails a volume). |
| `utils/hooks.js` | Per-machine pipeline-hook runner (git-style, entirely optional). Discovers `hooks/pre-<task>` / `post-<task>` (and `pre-/post-pipeline`) and `exec`s each as an executable with `AI_CLIENT_*` env vars; skips when the file is absent, under `--dry-run`, or not executable. Applied via `withHooks()` in gulpfile.js. See §3 "Pipeline hooks" and `hooks/README.md`. |
| `utils/qa-loop.js` | Shared QA-loop orchestration: `runSharedQaLoop(cfg)` runs the whole-installment validator → grader → feedback loop for all four volume tasks (glossary, character-voice, style-guide, jump-in-wiki). It centralizes the rolling window, the fail-closed unparseable-score handling, the per-iteration state persistence (with the source fingerprint), the acceptance-criterion check, the validator recovery-turn gating, and the `ON_QA_LIMIT` policy — each task injects only its validator creation, turn prompt + labels, recovery prompt, acceptance check, feedback stage, and log lines. Covers the whole-installment loops only — the chunked fallback keeps its own inline loop (its per-segment validators + findings-merge stage do not fit the single-validator interface). |
| `harness.js` | The AI layer: one-shot calls, agent handles, wiki tools, gated fs tools, **epub tools (`createEpubTools`: `epubInfo` / `readEpubText` / `stageVolume` + its own approve gate — the intake agent's senses, so it can open a book instead of guessing from its name; text comes back in bounded windows, staging is confined to the allowed dirs and never clobbers a different file)**, provider plumbing, run logging, the runaway-generation guard (aborts agent turns that produce excessive text without tool calls), and the idle call deadline (`AI_CALL_DEADLINE_MS`, default 60 min — aborts a model call that makes no progress for that long; all fetch timeouts are disabled, so this is the only wall-clock bound on a call). Never bypass it to talk to the model. Multi-model support: per-call `endpoint` override (baseUrl/apiKey/model, falling back to `AI_*`), per-call `temperature` + sampling params (`topP/topK/minP/repetitionPenalty/presencePenalty`), the `hy-mt` thinking dialect (`no_think|low|high` → `reasoning_effort`), nullable `systemPrompt` (Hy-MT2's single-user-message contract), and `assertModelServing()` — a `GET /v1/models` control-plane check that fails loudly before a stage's first call (and logs the raw model list it got). Logs every AI call to `.logs/<timestamp>/` — per-agent chat histories (system prompt, messages, assistant response, reasoning, tool calls) and one-shot call dumps — plus the summary log (greppable `CALL`/`RESULT`/`WARNING` lines). |
| `research.js` | Client-side web research (Wikipedia Action API + optional Brave/Tavily/Serper). No LLM involved. |
| `glossary.js` | Glossary task logic. |
| `character-voice.js` | Character voice reference task logic — extracts speech quirks, POV markers, narration types, and produces a cumulative character voice reference and per-volume POV maps. |
| `style-guide.js` | Style guide task logic — extracts style-relevant constructs (honorifics, pronouns, particles, internal-monologue markers, onomatopoeia, POV/scene markers, tense, punctuation, wordplay) and produces a cumulative style guide of rendering policies for the target language. |
| `jump-in-wiki.js` | Wiki task logic **plus the shared helpers**. After all volumes: the last existing `shared-wiki.md` is copied to the series artifacts directory (`SERIES_ARTIFACTS_DIR`, default `<SERIES_LOCATION>/shared-wiki.md`); writes the per-volume translation handoff (`utils/handoff.js`) on both paths. |
| `consistency-audit.js` | Final cross-artifact consistency audit (the pre-translation sign-off). An audit agent (gated fs tools, cwd = series root, writes confined to the root) reads the four series-root artifacts (`glossary.md`, `character-voice.md`, `style-guide.md`, `shared-wiki.md`) and writes `consistency-report.md` (PASS/FAIL verdict + severity-banded findings with quoted snippets). No QA loop. Idempotent: content-based — the report also writes a `consistency-report.md.provenance.json` sidecar carrying the sha256 fingerprint of each of the four audited artifacts; the report is skipped while all four fingerprints still match the current files (regenerating any artifact invalidates it). A missing or corrupt sidecar falls back to the legacy mtime check (report newer than all four artifacts). `--force` re-audits. A FAIL verdict is logged loudly but does not fail the task — the report is the deliverable. |
| `translate.js` | Translation task (first stage of the multi-model chain; §8.5). Per volume, per chapter (in `bundle.segments` order): skip when the draft + `translation-state.json` cover the current source/reference hashes, split oversized chapters (`TRANSLATE_CHUNK_CHARS`), translate each part via `runOneShot` on the `TRANSLATE_*` endpoint — **no system prompt** (Hy-MT2's single-user-message contract), official sampling, `no_think` by default — with the previous part's ending as continuity context, deterministic QA (`checkTranslationQa`), per-chapter state persistence, and the merged `translation.md` + `translation-qa.md`. Also exports `chapterArtifactNames` / `mergeVolumeTranslationFiles` shared by the other three tasks. |
| `verify-translate.js` | Verification task (§8.5). Per chapter with a draft: one-shot source-anchored check on the `VERIFY_*` endpoint → 0–100 score (fail-closed: unparseable = FAIL) + severity-banded findings → `translation-verification.json` sidecar + `translation-verification.md` report. PASS = score ≥ `PASSING_SCORE` (default 70). **Borderline tiebreak (batched, cross-model):** after the verify pass, every chapter whose score lands within `±VERIFY_TIEBREAK_BAND` (default 5) of the passing score is re-scored on the `AUDIT_*` endpoint (a SECOND endpoint — the `verify-audit` hook switches its container in) and the two scores are **averaged** (one endpoint switch for the whole batch, never interleaved with the verify loop; an unparseable audit score keeps the verifier's score — fail-open). `VERIFY_TRANSLATE_ENABLED=false` makes it a no-op. Exports `loadVerificationSidecar` (read by retranslate), `glossaryBlock` + `findingsOf` (read by polish); returns the aggregated run summary (`failed` — read by the `translate-qa` loop). |
| `retranslate.js` | Correction task (§8.5). Per chapter that FAILED verification (and whose sidecar entry still covers the current source + draft): a fresh pass on the `TRANSLATE_*` endpoint with the verification findings injected as a numbered "fix these" task in the official prompt — the bad draft is **deliberately not** fed back (re-reading a bad translation anchors the model to its errors). Same part-by-part splitting as `translate` (the findings are injected into every part). Overwrites the draft, updates the state (invalidating any earlier polish), re-merges `translation.md`. Runs only when verification is enabled; returns the aggregated run summary (`retranslated` — the `translate-qa` loop's stall guard). |
| `translate-qa.js` | The batched translation QA loop (§8.5) — one gulp task that mirrors the pre-production "translate → validate → apply → re-validate …" loop: up to `TRANSLATE_QA_MAX_ROUNDS` rounds of [verify batch (`VERIFY_*`) → retranslate batch (`TRANSLATE_*`)], stopping when every chapter passes, a round retranslates nothing (stalled), or the round cap is hit. Batched because the local model containers share one port: each half-round is a whole single-endpoint task run invoked through `withHooks()` (the per-batch model-switch hooks fire at every boundary). Owns no prompt/model logic — the stop-decision is the pure `qaLoopDecision` in `utils/translate.js`. |
| `polish.js` | Final pass (§8.5). **Two-phase, batched, cross-model.** Phase A (per chapter, the `EDIT_*` endpoint, thinking on): one-shot polish — **the polisher sees NO source text** (surface cleanup of already-verified text) → deterministic regression guard; a guard-gated candidate is written and queued. Phase B (batched, cross-model): the **final audit** on the `AUDIT_*` endpoint (a SECOND endpoint, distinct from the polisher's — the `polish-audit` hook switches its container in; the whole batch runs under one endpoint, never interleaved with the polisher) scores each candidate on the source-aware drift rubric (0–100, PASS ≥ `PASSING_SCORE`, fail-closed). A FAIL re-polishes on the `EDIT_*` endpoint (the `polish` hook switches back) with the findings injected as a numbered "fix these" task (the retranslate pattern) and is re-audited next round; up to `POLISH_QA_MAX_ROUNDS` (default 3) rounds, on exhaustion the draft is kept (any polished file is dropped so the merge publishes it) and the findings persist (the next run re-audits with them; `--force` = a fresh attempt). Runs on whatever drafts exist (including round-cap FAILs). Writes `polished-<id>.md` + `polish-verification.json`, records `polishedDraftHash` + `polishVerifiedDraftHash` (set only when Phase B accepts) in the state, re-merges `translation.md` (polished text wins). |
| `utils/translate.js` | Pure translation-stage helpers shared by the four tasks: `splitChapter`, `parseGlossaryTerms`, `extractStyleRules`, `buildTranslationTaskLines` / `buildTranslationPrompt` (the official Hy-MT2 single-user-message shape), `cjkRatio`, `countOccurrences` (substring for CJK, `wordBoundary` for space-separated sources), `residueRatio` (per-pair source-script residue: the source script minus the target script — JA→EN counts kana+Han, JA→ZH only kana, KO→EN Hangul, ZH→EN Han), `isSpaceSeparated`, `lengthBands` (per-pair length band, `TRANSLATION_LENGTH_RATIO` override), `scriptsOf`, `checkTranslationQa` (hard fails: empty draft, source-script residue > 5%, length under the pair's truncation floor; warnings: residue > 0.5%, length outside the pair's band, missing glossary renderings), `buildPolishGuardFindings` (the polish loop's correction tasks synthesized from a failed guard check), `mergeVolumeTranslation`, `stripMarkdownFence`, `tailOf`, `stripContinuityOverlap` (strips the previous part's ending if the model repeats it at the start of its reply — the deterministic dedup backstop for the continuity tail), `runWithConcurrency` (bounded worker pool for the per-chapter loops), `stageConcurrency` (the shared `STAGE_CONCURRENCY` knob, default 1; legacy `<PREFIX>_CONCURRENCY` per-stage overrides still honored), `judgeTemperature` (`JUDGE_TEMPERATURE`, the grading temperature), `stageThinking` (`AI_THINKING` + `STAGE_THINKING_LEVEL`, the stage calls' thinking dialect), `writerTemperature` (a writing stage follows `AI_TEMPERATURE`), `loadTranslationState` / `saveTranslationState` (fail-open), `roleEndpoint` (`<PREFIX>_BASE_URL`/`_API_KEY`/`_MODEL` with `AI_*` fallback; also reports `modelSource`/`baseUrlSource` for logging), `loadVolumeReferences` (glossary terms, style rules, wiki + POV-map background, voice notes, and the `contextHash` idempotency key), `qaLoopDecision` (the translate-qa loop's pure stop-decision: all-pass / round-limit / stalled) and `qaMaxRounds` (the `TRANSLATE_QA_MAX_ROUNDS` cap). |
| `get-translation-target.js` | **Series intake (step 0)** — an agent-driven discovery that replaces the old folder-name guessing. `getTranslationTarget()` reuses a valid schema-2 manifest (or runs the intake agent), which explores `SERIES_LOCATION` with the epub tools, decides which files are volumes / the reading order / the series name / the source language, stages each volume's source into the folder it named, and writes `<SERIES_LOCATION>/translation-target.json` (schema 2: `seriesName`, `seriesNameAlt`, `sourceLanguage`, `targetLanguage`, `discovery.{summary,confidence,evidence,excluded}`, `volumes[]`) plus the human-readable `translation-plan.md`. Guards: `validateManifest` (schema, folder-name sanitizing, installment numbers, relative source paths, and **each volume's source must live inside its own folder**), `readUsableManifest` (a cached manifest that fails validation is never reused), `readCommittedLayout` + `applyCommittedLayout` (a re-run never renames a folder that already holds pipeline output), `manifestSourcesExist`, `findDuplicateSources` (the same book listed twice is rejected), `validateVolumeIntegrity` (every volume's `integrity` block — the agent's "is this a real narrative?" judgment — must exist and be stated, fail-closed), `checkVolumeSourceShape` + `volumeIntegrityProblems` (the objective "is this a book?" cross-check: no readable text, under the `DISCOVER_MIN_VOLUME_TEXT_CHARS` floor, a binary file renamed, or an image-dominated art book), `confidenceGate` (`DISCOVER_MIN_CONFIDENCE`, fail-closed when the agent reports no confidence), `createIntakeApprove` (the plain file tools are shut at `.epub` paths). `discoverSeries()` is the `discover` gulp task. `buildDeterministicManifest` is the no-AI `--dry-run` backend, used only when there is no committed plan (existing volume folders holding a book, or a flat pile of source files staged into folders; `deriveSeriesName` names the series from the books when `.env` does not). All ten tasks read this manifest. |
| `translation-target.json` | Generated manifest (see `get-translation-target.js`); lists each volume's folder, source file, installment number, and metadata. All ten tasks read it to resolve folders and source files. The live series dir always comes from `SERIES_LOCATION` (env), not from the manifest's `seriesLocation` field (provenance metadata — see gotcha 11). |
| `types.js` | JSDoc type definitions shared across modules. Defines named typedefs (`TranslationTargetManifest`, `TranslationTargetVolume`, `TranslationTargetDiscovery`, `SourceSegment`, `SourceBundle`, `EpubMetadata`, `OpenedEpub`, `GlossaryVolumeCtx`, `WikiVolumeCtx`, `CharacterVoiceVolumeCtx`, `StyleGuideVolumeCtx`, `IMessage`, `EndpointOverride`, `RunOneShotCfg`, `CreateAgentHandleCfg`, `AgentHandle`, `Taps`, `FetchResult`, `WikiTools`, `ResearchNote`, `TranslationStateEntry`, `VerificationEntry`, `PolishVerificationEntry`, `VolumeReferences`, `HookContext`) that replace generic `{Object}` annotations in `@param`/`@returns` tags. Imported via `require("./types")` in every core module for IDE cross-reference resolution. Pure JSDoc — zero runtime side effects. |
| `gulpfile.js` | Task wiring (eleven tasks + the `discover` step 0) plus the `ON_TASK_ERROR`-aware `runPipeline()` runner for the default run (see §3 "Un-monitored run policies"). |
| `hooks/` | Per-machine hook scripts (git-style; gitignored — only `README.md` + `*.sample` are tracked). Executable before/after hooks for each step and the whole run. See §3 "Pipeline hooks". |
| `system-prompts/`, `user-prompts/` | Per-stage prompt pairs. Intake: `translation-target` (system + user — the folder-intake brief: what to look at, how to decide, the exact manifest JSON shape to write). Glossary: `glossary-terms`, `glossary` (amend), `glossary-validator`, `glossary-acceptance`, `glossary-feedback`. Character voice: `character-voice-extract`, `character-voice` (compile), `character-voice-validator`, `character-voice-acceptance`, `character-voice-feedback`. Style guide: `style-guide-extract`, `style-guide` (compile), `style-guide-validator`, `style-guide-acceptance`, `style-guide-feedback`. Wiki: `jump-in-wiki`, `-validator`, `-acceptance`, `-feedback`. Consistency audit: `consistency-audit`. Translation stage: `translate` (user only — the official Hy-MT2 single-user-message prompt, **no system prompt file**), `verify-translate` (system + user — source-anchored 0–100 scoring rubric), `polish` (system + user — final proofreading pass, **no source text**), `polish-verify` (system + user — source-aware drift check of the polish pass: does the polished text preserve the verified draft's meaning?). |
| `test/test-glossary-load.js` | Pure tests (`npm test`): glossary helpers + the acceptance reply parsing contract (`parseAcceptanceReply` — JSON first, legacy integer fallback, garbage → `null`). |
| `test/test-translate.js` | Pure tests for the translation-stage helpers (`utils/translate.js`): `splitChapter`, `parseGlossaryTerms`, `extractStyleRules`, `checkTranslationQa` (incl. the per-pair residue / length-band / word-boundary matching), `residueRatio`, `isSpaceSeparated`, `lengthBands`, `buildPolishGuardFindings`, `mergeVolumeTranslation`, `stripMarkdownFence`, `tailOf`, `stripContinuityOverlap`, `runWithConcurrency`, `stageConcurrency`, `roleEndpoint`, `qaLoopDecision`, `qaMaxRounds`, plus the `assertWroteWithFallback` return-value contract (utils/fs.js). |
| `test/test-hooks.js` | Pure tests for the hook runner (`utils/hooks.js`), including the `TASKS` list (all eleven tasks + pipeline). |
| `test/test-intake.js` | Pure tests for the series intake (no AI, no network): epub fixtures built with jszip → `openEpub` (catalog card, series marker, spine sections, nav titles, **case-insensitive OPF tags**), `readEpubSection` bounded sampling, `htmlToPlainText` paragraph structure, `scriptCounts`, the epub tools (`epubInfo` / `readEpubText` cap / `stageVolume` idempotency + clobber refusal + path safety) and their approve gates (including the intake gate that shuts readFile/writeFile at `.epub` paths), `sanitizeFolderName`, `normalizeInstallmentNumber`, `filterVolumesByInstallment`, `validateManifest` (source-inside-its-folder, backslash normalization, per-volume `integrity` block required), `findDuplicateSources`, `validateVolumeIntegrity` (a missing block / non-boolean / out-of-range confidence / thin basis is rejected), `checkVolumeSourceShape` (too-thin epub, no-text archive, image-dominated art book, empty/short/binary text file) and `volumeIntegrityProblems` (a non-narrative volume is told to be excluded; a low-confidence one is flagged), `resolveRunSettings` precedence, `readCommittedLayout` + `applyCommittedLayout` (plan-of-record stability), `confidenceGate` (fail-closed), the deterministic `--dry-run` layout builder (committed folders recognised, no rival layout), and the whole `getTranslationTarget()` run driven by a stubbed agent (plan validation/stamping/persisting, `.env` overrides, committed-folder protection, the confidence gate, the correction turn, manifest reuse, **an invalid/half-written cached manifest falling back to a fresh intake**, `--dry-run` previewing the committed plan, and the loud no-plan failure). |
| `test/test-qa-orchestration.js` | Offline orchestration tests (`npm test`) for the shared QA loop (`utils/qa-loop.js`, exercised through `character-voice.runVolume`): monkey-patches the harness (`runOneShot`, `createAgentHandle`, `createGatedFsTools`) and uses real temp files so the deterministic gates run unmodified. Covers fresh-pass acceptance, feedback-then-accept, `ON_QA_LIMIT=accept` / `=fail` (the fail case in a child process), recovery gating (on and off), unparseable-acceptance fail-closed, and the skip/idempotency decisions. |
| `test/harness-smoke.js` | Live smoke test (`npm run smoke`). |
| `test-series/` | Fixture series (`test_story(1)`, `test_story(2)`); generated outputs are gitignored. |
| `.env` / `.env.example` | Configuration (see §8). |
| `.logs/` | One run log per process: `call-ai-<timestamp>.log`. |
| `.dry-run/` | Prompt dumps from `--dry-run`. |

Prompt files are agent-mode: the system prompt is appended with `AGENT_TOOLS_NOTE` to instruct the agent about file tools.

## 3. Architecture

### harness.js primitives (the only way to talk to the model)

- **`runOneShot({ systemPrompt, messages, ... })`** — one tool-less call. `messages` are `{ text }` or `{ file, name }` (images/wav/mp3 become binary parts; undetectable types are inlined as text). Streaming with a non-streaming fallback; retries empty/error responses up to `AI_RETRY`; an idle deadline (`AI_CALL_DEADLINE_MS`, default 60 min, `0` = off) aborts an attempt that makes no progress (an IDLE timeout reset on every event, so healthy long calls are never aborted — all fetch timeouts are disabled, so this is the only wall-clock bound); **throws on empty — it never returns `""`** (workflows persist the returned string verbatim, so an empty result must fail the run instead of corrupting an artifact).
- **`createAgentHandle({ name, systemPrompt, tools, approve, cwd, maxSteps, ... })`** — a tool-using agent backed by an OpenHarness `Session`: context auto-compaction at `AI_CONTEXT_WINDOW` tokens and retry-with-backoff. `sendTurn()` keeps message history across turns (author sessions reuse one session for generation + all feedback passes). For writing agents an empty final chat reply is *success* (the output went to disk) — no empty-retry there.
- **`createWikiTools()`** — `wiki_search(query, lang?)` / `wiki_extract(title, lang)` backed by research.js.
- **`createGatedFsTools({ cwd, allowedDirs })`** — OpenHarness fs tools (readFile/listFiles/grep/writeFile/editFile/deleteFile) with an **approve gate**: reads always allowed, `writeFile`/`editFile` confined to `allowedDirs` (the volume folder), `deleteFile` always denied. This is the sandbox — do not weaken it.
- **`createEpubTools({ cwd, allowedDirs, sampleChars })`** — the intake agent's senses: `epubInfo(filePath)` (the book's catalog card + section list), `readEpubText(filePath, section, offset, limit)` (a bounded plain-text slice, capped per call so 17 books cannot blow the context window), `stageVolume({sourceFile, folder, as})` (create the volume folder and copy the source in — a copy; the original is never touched, identical re-staging is a no-op, a different file is never clobbered, one folder level only). Its approve gate confines staging to `allowedDirs` and denies `deleteFile`. The intake composes it with the fs gate through `createIntakeApprove` (AND of both gates, **plus a refusal of readFile/grep/writeFile/editFile on `.epub`/`.zip` paths** — the plain file tools are text tools, so a book is read through the epub tools or not at all, and a book file can never be overwritten).

### Provider plumbing (local-LLM friendly)

- ESM bridge: `@openharness/core` + `@ai-sdk/openai` ship ESM-only builds; loaded lazily via `loadEsm()` (this project is CommonJS).
- Custom fetch built on **undici's own `fetch` + a no-timeout `Agent` from the same undici build** (all timeouts disabled — local servers can prefill for minutes); never mix the Agent with Node's *global* fetch — that crosses undici versions and throws `invalid onRequestStart method` on some Node builds (gotcha 19); merges thinking params into the request body (`chat_template_kwargs` for Qwen3-style models, `reasoning_effort` for levels); taps SSE/JSON responses for `reasoning_content` + first-token timing diagnostics.
- Every call logs to stderr **and** `.logs/call-ai-<timestamp>.log` (CALL/RESULT lines: finish reason, content/reasoning sizes, token usage, TTFT, tok/s). Workflow logging goes through `harness.logLine`.

### Shared workflow shape (all four volume tasks)

1. Read the plan of record — the translation-target manifest (`getTranslationTarget()`, produced by the intake step; see §3.5). It gives, in reading order, each volume's folder, its staged source file, the series name, and the source language. Series name / source language / target language are then resolved per run by `resolveRunSettings(manifest)` (.env override > manifest > default). With `--dry-run` a deterministic fallback builds the manifest instead, so prompt previews stay fully offline.
2. Fill `{{PLACEHOLDER}}`s in the user-prompt templates (`transformUserPrompt` — **strict**: throws on a missing value or any leftover placeholder).
3. **QA loop** per volume, up to `QA_MAX_ITERATIONS`: score-based
   acceptance — the acceptance one-shot check (tool-less) sees the audited
   artifact(s) **and** the validation report (the report is a guide; the
   artifact is what gets judged) and scores the artifact **0–100**
   (100 = perfect, 0 = atrocious) using a banded rubric in the
   `*-acceptance.md` system prompts (Pass → 85–100, Pass with minor
   edits → 70–84, Requires revision → 40–69, Reject → 0–39), replying as
   a single JSON object (`{"score", "band", "note"}`). Each score is
   tracked in a rolling window (`ACCEPTANCE_WINDOW_SIZE`, default 2). When the
   window meets the criterion from `meetsAcceptanceCriteria()` (default
   strategy `average`: rolling average of scores ≥ `PASSING_SCORE`,
   default 70; alternative `best`: at least `ACCEPTANCE_BEST_MIN_PASSES` of the
   scores ≥ the passing score) and the window is full (it needs
   `min(2, ACCEPTANCE_WINDOW_SIZE)` checks — derived, not a separate knob), the
   output is accepted. An unparseable acceptance
   reply counts as a failed check (fail-closed) and is not stored. Otherwise,
   feedback is applied and the loop continues. A passing output
   is never touched by a feedback pass. The loop mechanics (rolling window,
   state persistence, criterion check, recovery gating, `ON_QA_LIMIT` policy)
   run through the shared loop in `utils/qa-loop.js`; each task injects only
   its validator, acceptance check, feedback stage, and log lines.
   **Fresh agent per feedback iteration** for glossary / character-voice /
   style-guide (no persistent session — each feedback turn starts with a
   clean context that includes the validation report and the current
   artifact); the wiki keeps its author session for feedback.
4. **Idempotency**: a volume whose outputs already exist and pass acceptance is skipped (unless `--force`). The skip-check reads a persisted rolling-window state file (`*-rolling-state.json`) written alongside the validation report during the last run, recomputing the acceptance decision deterministically — no AI call needed. If the state file is missing or corrupt, the check falls back to regenerating (fail-open). A failed skip-check degrades to "not skipped" (fail-open, by design). **Source-staleness detection**: the state file also persists the `sourceFingerprint` of the source file the accepted output was built from (sha256 of the original plain-text file, or the epub extraction cache hash — `bundle.sourceFingerprint` from `utils/source.js`). On re-run, `isSourceStale(state, bundle)` compares the two: a changed source invalidates the skip and the volume regenerates (then the cumulative `regeneratedAny` cascade rebuilds all later volumes). Fail-open: a legacy state file without a fingerprint, or a bundle without one, keeps the current skip behavior — old runs are safe to re-run.

**Un-monitored run policies** (front-loaded in `.env`, see §8): the pipeline is built to run un-monitored overnight / for multiple days, so the decisions that would otherwise need a human are env-driven (code defaults keep the safe "fail loudly" behavior):

- `validateRequiredEnv({ dryRun })` (configs/shared.js) runs at the top of every task and fails fast with a single message naming every missing required variable (`SERIES_LOCATION`, and `AI_API_KEY` for live runs — `SERIES_NAME` is never required, the intake step decides it, see §3.5) — a misconfigured `.env` is caught at run start, not hours in.
- `ON_VOLUME_ERROR` (`abort` default / `skip`): when a volume's processing throws, the per-volume body of each task is wrapped in a try/catch — `skip` records the volume and continues with the next one (in the cumulative tasks the next volume then misses its previous artifact and is skipped in turn by `ON_MISSING_PREVIOUS=skip`, cascading to the end of the task).
- `ON_MISSING_PREVIOUS` (`abort` default / `skip`): replaces the "process the earlier volume first" throw in the three cumulative tasks with an optional warn-and-skip.
- `ON_QA_LIMIT` (`accept` default / `fail`): when the QA loop hits `QA_MAX_ITERATIONS` without a passing grade — accept the output as-is (legacy) or fail the volume.
- `ON_TASK_ERROR` (`abort` default / `continue`): in the default run, a failing step either stops the run (gulp `series` behavior) or the remaining steps still run and the run fails at the end with a summary of all failed steps (`runPipeline()` in gulpfile.js).
- `DISCOVER_MAX_ATTEMPTS` (default 2; legacy name `DISCOVERY_MAX_ATTEMPTS` still honored): the intake agent is retried with a fresh agent (10 s apart) when it produces an invalid manifest or references missing source files.

### 3.5 Series intake (`get-translation-target.js`, the `discover` task)

Step 0 of the pipeline. The old behavior — "every volume is a folder named `<Series Name>(NN)` containing one text file" — is replaced by an agent that is handed only `SERIES_LOCATION` and works the rest out by looking at the files.

Flow (`getTranslationTarget()` → `discoverSeries()`):

1. **Reuse or run.** `readUsableManifest()` returns the committed manifest only when it is schema 2, VALIDATES, its `seriesLocation` matches `SERIES_LOCATION`, and every listed source file still exists; anything else — including a half-written file — falls through to a fresh intake run (`--force` always re-runs it). An invalid manifest is never handed downstream (see gotcha 33).
2. **Look.** The agent gets `createGatedFsTools` (reads anywhere under the series dir, writes confined to it) **AND** `createEpubTools` — `epubInfo` (catalog card: title, creator, language, publisher, identifier, the Calibre/EPUB3 series marker, section list), `readEpubText` (a bounded slice, `DISCOVER_SAMPLE_CHARS`, default 1500, max 6000 per call), `stageVolume`. Step cap scales with the number of entries to look at. The composed gate (`createIntakeApprove`) shuts the plain file tools at `.epub` paths: a book is read with the epub tools, never as text, and never written over.
3. **Decide.** Which files are volumes, in what reading order, which are excluded (art books, previews, duplicates, side stories), the series name (plus an alternate/romanized form), the source language, and the folder name for each volume. For every volume it accepts it also records an `integrity` block — `{ isNarrative, confidence, basis }` — its own judgment of whether the text it read is a **real narrative** (a story, or a legitimate short story), what it read, and how sure it is. A file it does not believe is a story belongs in `discovery.excluded` with a reason, never in `volumes`. It writes `translation-target.json` with `writeFile` and reports `discovery.confidence` + `discovery.evidence` + `discovery.excluded`.
4. **Validate.** `validateManifest` checks the schema, sanitizes each folder name (`sanitizeFolderName` — validated, never rewritten), normalizes installment numbers to `NN`, requires unique folders/installments, requires each volume's `sourceFile` to be the staged copy **inside its own folder** (forward slashes are the stored form), and — via `validateVolumeIntegrity` — requires every volume's `integrity` block to exist, to say `isNarrative` as a real boolean, to carry a `0..1` confidence, and to name a `basis` (a gate the model can pass by saying nothing is not a gate). `findDuplicateSources` then rejects the same book listed as two volumes — the one mistake folder-name freedom makes possible. After validation, `volumeIntegrityProblems` adds the objective half (below). A malformed reply is salvaged from the chat text (`extractJsonObject`); a still-invalid plan triggers a correction turn (the agent is shown its own error, including the duplicate) and then a fresh-agent retry.

   **Objective "is this a book?" cross-check** (`checkVolumeSourceShape`): the agent's judgment is necessary but not sufficient — a model can be wrong about what it read. So each staged file is also checked without any guessing about what a story is: an archive with no readable text section is rejected; a file that yields under `DISCOVER_MIN_VOLUME_TEXT_CHARS` (default 1000) characters is binary junk / an empty archive / a stub; a text file that is mostly undecodable bytes is a binary file renamed; and an archive that is overwhelmingly non-text (file bytes ≫ text, above a 50 KB floor so a tiny overhead-dominated text book is not misread) is an art book by construction. Any failure is a structural problem that fails the intake attempt and feeds the correction turn.
5. **Protect what already exists.** `readCommittedLayout` records every existing folder under the series dir and whether it already holds pipeline output; `applyCommittedLayout` forces the agent to keep such a folder's name (and its staged source) instead of renaming it — renaming would orphan every artifact built under the old name. A disagreement warns and the corrected plan is kept (or the step fails immediately when `DISCOVER_STRICT=true` — a retry cannot make an agent respect a policy).
6. **Gate.** `confidenceGate` refuses to start the pipeline below `DISCOVER_MIN_CONFIDENCE` (default 0.6; 0 disables) — and is **fail-closed**: a plan that reports no `discovery.confidence` at all is rejected, because a gate the model can pass by saying nothing is not a gate. A wrong reading order poisons every cumulative artifact, so an unsure plan stops the run rather than quietly producing 17 wrong glossaries.
7. **Publish.** `translation-target.json` (schema 2) + `translation-plan.md` (the human-readable version: the chosen order, the exclusions with reasons, the evidence). Both live at the series root.

`--dry-run` never calls the model and never writes the plan of record. When a committed plan exists it is **previewed as-is** (nothing is built, nothing is written) — the preview must match what the real run will do. Only when there is no committed plan does `buildDeterministicManifest` lay one out: existing volume folders that hold a book (the legacy `<Series>(NN)` naming and the agent's own folder names/file names), or, if there are none, each loose source file staged into its own numbered folder (staging is the one side effect a dry run has). With no committed plan and no `SERIES_NAME` it names the series itself from the books it found (`deriveSeriesName` — the name the volume titles share), because a preview must not depend on a variable the real run does not need.

Settings precedence is centralized in `resolveRunSettings(manifest)` (configs/shared.js): **`.env` override > manifest > default** for series name, source language and target language. `SERIES_NAME` is never required — unset, the manifest (what the intake agent actually read) decides it.


### Source bundle & chapter-by-chapter fallback (`utils/source.js`)

Every task resolves its volume source through `resolveSourceBundle()` at the choke point (right after manifest discovery). A plain-text source passes through as a single-segment bundle; an `.epub` is extracted once (jszip + cheerio, cached in `<base>-bundle.meta.json` + per-chapter files) into a `SourceBundle`. **The default processing mode is whole-installment** (the `-whole.md` file); the **chapter-by-chapter fallback** activates only when the whole text exceeds `SOURCE_CHUNK_THRESHOLD_CHARS` (default 120000) or `--chunked` is passed. Bundle layout in the volume folder:

- `<base>-whole.md` — the full normalized text (what whole-mode stages read)
- `<base>-ch0.md` — prologue; `<base>-ch1..N.md` — chapters; `<base>-chN.1..K.md` — interludes (and epilogues) after chapter N (the counter K restarts at 1 for each chapter; a segment before any chapter is `ch0.K`)
- `images/` — extracted images + `manifest.json`
- `<base>-bundle.meta.json` — extraction cache (epub mtime/hash → skip re-extraction; `--force` re-extracts)

Chunked mode shape (all four pipelines): generation stages run per chapter in reading order — each chapter sees the previous chapter's output (chained, so no client-side merge for the cumulative artifacts: glossary / voice reference / style guide simply carry forward into the next chapter's state). The wiki is the exception: per-chapter section files (`wiki-<id>.md`) are assembled into `wiki.md` + `shared-wiki.md` by a merge agent. QA runs per-chapter validator partials → a findings-merge agent writes the standard `*-validation.md` → the unchanged acceptance one-shot scores it → per-chapter feedback applies the chapter-tagged findings. **Never iterate `bundle.segments` by filename** — `chN.K` interludes do not sort into reading order; always iterate the `segments` array (gotcha 20).

### Pipeline hooks (per-machine, git-style)

Optional, git-style hooks let each machine attach its own side-effects (git
sync, notifications, backups, …) before and after each step and around the
whole default run, **without changing the committed source or `package.json`**.
See `hooks/README.md` for the full contract and examples.

- **Runner** — `utils/hooks.js` is a dumb "exec an executable file" loop: it
  discovers the hook, checks it's executable, and runs it with `AI_CLIENT_*`
  env vars. It never interprets hook content or loads npm packages, so a hook
  can shell out to whatever the local machine already has (git, curl, mail,
  `node` with built-ins, …).
- **Location** — `<root>/hooks/` (gitignored; only `README.md` + `*.sample`
  are tracked). Override with `AI_CLIENT_HOOKS_DIR` (the git `core.hooksPath`
  analogue).
- **Hook files** (first existing name wins) — `pre-<task>` / `post-<task>`
  (or `.sh` / `.js`) for `discover`, `glossary`, `character-voice`,
  `style-guide`, `jump-in-wiki`, `consistency-audit`, `translate`,
  `verify-translate`, `retranslate`, `translate-qa`, `polish`, plus **sub-phase hooks**
  `pre-verify-audit` (the verify borderline tiebreak batch) and
  `pre-polish-audit` (the polish cross-model final-audit batch) — fired by the
  tasks around their audit sub-phases (each is a single endpoint switch,
  never interleaved with the main stage) — and `pre-pipeline` /
  `post-pipeline` around the whole default run. Any executable with a
  shebang works. `pre-/post-translate-qa` wrap the WHOLE QA loop (a logical
  wrapper — they must not switch models).
- **Hook names are role labels, never model names** — the code asks for
  `pre-verify-audit` / `pre-polish-audit` and nothing else; which container
  answers that role is entirely this machine's hook business.
- **Model switching for the translation stage** — the translation stage talks
  to several endpoints, but on local setups the containers share one port, so
  only one can serve at a time. The per-machine pre-hooks for the translation
  tasks are what start the right container (`model-switch.sh`,
  `hooks/README.md` Example 4 — idempotent, `/health`-polled), including the
  sub-phase hooks that switch in the **audit** container for the cross-model
  checks (`pre-verify-audit.sh` for the verify tiebreak, `pre-polish-audit.sh`
  for the polish final audit) before each audit batch. The task code
  contains no Docker logic; it only runs a `GET /v1/models` sanity check
  (`harness.assertModelServing`) before its first call. The `translate-qa`
  loop fires these batch hooks on every round (up to two switches per round;
  a repeat is a no-op when the right container already serves).
- **Entirely optional** — no file → the step runs exactly as before (the
  common case); present-but-not-executable → warn + skip. **`--dry-run` runs
  no hooks** (side-effect-free).
- **Failure** — a before-hook non-zero exit **aborts the step**; an after-hook
  runs even when the task failed (so a cleanup / "task failed" notification can
  fire), and a failed after-hook only masks the task error when the task had
  already failed (the task error always propagates).
- **Wiring** — each task is wrapped with `withHooks(task, taskFn)` in
  `gulpfile.js` (the task modules are untouched); `translate-qa` wraps its
  two half-round tasks the same way inside the loop (the per-batch hooks
  fire on every round); the default run is wrapped as the `pipeline`
  pseudo-step.


## 4. Pipeline A: glossary (`glossary.js`)

Per volume, in order — each volume's glossary is built on the previous one's:

1. **Extract new terms** — one-shot in both modes: source + previous `glossary.md` → JSON array of `{ term, type, query }`; parsed by `parseTerms` (tolerates markdown fences and surrounding prose).
2. **Research** the new terms:
   - **Parallel agents**: one agent per term, batched to `STAGE_CONCURRENCY` (env var, default 1 = sequential). Each agent targets exactly one unique line in `glossary-research.md` via `editFile`, so there are no conflicts.
   - Skeleton-first: the workflow pre-writes `glossary-research.md` with a `- (pending)` line under every term; each agent replaces its own placeholder. A crashed run still leaves a usable skeleton.
   - `maxSteps = 15` per agent (2 wiki_search + 1 wiki_extract + 1 editFile + overhead).
   - Set `STAGE_CONCURRENCY` above 1 to research terms in parallel (the default 1 is sequential).
3. **Amend** the glossary (carry forward every existing term, add the new ones, reconcile conflicts):
   - an **author agent** (standalone — creates and closes its own session) reads the materials with `readFile` and writes `glossary.md` with `writeFile`/`editFile`.
4. **QA loop**: a fresh validator agent per iteration (step cap **scaled to source size**: `max(40, 2·ceil(bytes/32KB) + 24)` — `validatorMaxStepsFor`) writes `glossary-validation.md` → acceptance one-shot → on FAIL a **fresh author agent** per iteration applies the feedback (no persistent session).
5. After all volumes: the **last** volume's `glossary.md` is copied to the series artifacts directory (`SERIES_ARTIFACTS_DIR`, default `<SERIES_LOCATION>/glossary.md`). Skipped for `--volume` runs (a single volume's snapshot would be stale).

The extraction step also persists `glossary-new-terms.json` (the new-terms snapshot for the translation handoff), and after the QA loop a **deterministic coverage audit** (no AI) parses the glossary table and writes `glossary-coverage.md` + `glossary-coverage.json` (machine-readable sidecar) — per-term occurrence counts in the volume source (substring matching, the correct semantics for Japanese) plus the zero-occurrence terms (hallucinated-entry candidates; the AI validator's completeness check is the complementary judgment-based half).

Artifacts per volume folder: `glossary.md` (snapshot), `glossary-new-terms.json` (extraction snapshot), `glossary-research.md`, `glossary-validation.md`, `glossary-coverage.md` + `glossary-coverage.json` (deterministic coverage audit).

**Cumulative invariant:** regenerating any volume sets `regeneratedAny` → **all later volumes are regenerated too** (their glossaries would otherwise build on a stale base). Do not "fix" this by making per-volume idempotency independent.

## 5. Pipeline B: jump-in-wiki (`jump-in-wiki.js`)

Per volume:

1. **Generate** `wiki.md` + `shared-wiki.md` (context: the previous volume's `wiki.md` + `shared-wiki.md`):
    - an author agent (per-volume session, `maxSteps 40`). Stubs are pre-created for both files (a stronger name anchor than "create a new file", and a crashed run leaves identifiable stubs).
      Stale classic-named files (`jump-in-wiki-NN.md`, `jump-in-wiki-shared.md`) are deleted up front so agents can't audit garbage.
      When the glossary task has already written the volume's `glossary.md`, the author/validator/feedback prompts offer it as a **read-only canonical reference** so the shared wiki's "Glossary" section uses canonical renderings instead of model memory (drift guard).
2. **QA loop**: a validator agent writes `jump-in-wiki-validation-NN.md` (size-scaled step cap) → acceptance one-shot scores the wiki 0–100 → unless the rolling window of scores meets the criterion, the same author session applies the feedback.
3. **Two-tier idempotency**: if `wiki.md` + `shared-wiki.md` exist → skip generation, go straight to validation; if a validation report exists and passes acceptance → skip the whole volume.
4. **Handoff**: after the volume is settled (processed *or* skipped), the deterministic per-volume translation handoff is written (`chapters.json` + `translation-brief.md`, `utils/handoff.js` — best-effort, never fails the volume).
5. After all volumes: the **last existing** `<volume folder>/shared-wiki.md` is copied to the series artifacts directory (`SERIES_ARTIFACTS_DIR`, default `<SERIES_LOCATION>/shared-wiki.md`), mirroring the other root copies. Skipped for `--volume` runs (a single volume's snapshot would not be the series state). End-of-run summary counts the volumes that hit the iteration limit.

## 6. Pipeline C: character-voice (`character-voice.js`)

Per volume, in order — each volume's reference builds on the previous one's:

1. **Extract** — one-shot call: source text → JSON array of `{ type, character, quirkType, description, examples, ... }` entries for both voice quirks and POV analysis. Parsed by `parseVoiceQuirks` (tolerates markdown fences and prose).
2. **Compile** — an author agent (per-volume session, `maxSteps 30`) reads the source, previous reference, and extraction results, then writes two files:
   - `character-voice.md` — the cumulative character voice reference (carries forward all previous entries, adds new characters/quirks)
   - `pov-map.md` — the per-volume POV map (marker identification, narration type classification, POV assignments, free indirect discourse detection)
   The agent-mode turn prompts (author/validator/feedback) name every material at its real path — the previous volume's reference at `../<previous folder>/character-voice.md` (same convention as glossary.js) — so agents never have to guess where to read. A missing previous reference fails loudly (dry-run: warn).

3. **QA loop**: a fresh validator agent per iteration writes `character-voice-validation.md` → acceptance one-shot scores the reference 0–100 → unless the rolling window of scores meets the criterion, a fresh author agent applies feedback (`character-voice-feedback.md`). Same score-based acceptance criterion as the other pipelines (the state file is saved on every iteration, including the accepting one, so accepted volumes are skipped on re-run).
4. After all volumes: the last volume's `character-voice.md` is copied to the series artifacts directory (`SERIES_ARTIFACTS_DIR`, default `<SERIES_LOCATION>/character-voice.md`). Skipped for `--volume` runs.

Artifacts per volume folder: `character-voice.md` (cumulative snapshot), `pov-map.md` (per-volume), `character-voice-new.json` (extraction snapshot for the handoff), `character-voice-validation.md` (validation report).

**Cumulative invariant:** same as glossary — regenerating any volume sets `regeneratedAny` → all later volumes are regenerated too.

**Key differences from glossary:** no research stage (quirks are text-intrinsic); produces two files instead of one; extraction and compilation are separate stages.

## 7. Pipeline D: style-guide (`style-guide.js`)

The 4th pipeline step — the "how do I write it" policy layer. The glossary says *what to call things*, character-voice says *how characters sound*, the wiki says *what is happening*; the style guide says *how source-language constructs are rendered in the target language* (honorifics, pronouns, sentence-ending particles, internal-monologue markers, onomatopoeia, interjections, POV/scene markers, tense, punctuation, wordplay, translator notes).

Per volume, in order — each volume's guide builds on the previous one's:

1. **Extract** — one-shot call: source text + previous `style-guide.md` → JSON array of `{ category, pattern, description, examples, frequency, notes }` entries (categories: `honorific`, `pronoun`, `particle`, `internalMonologue`, `onomatopoeia`, `interjection`, `povMarker`, `sceneBreak`, `tense`, `punctuation`, `wordplay`, `note`, `other`). Parsed by `parseStyleObservations` (tolerates markdown fences and prose).
2. **Compile** — an author agent (per-volume session, `maxSteps 30`) reads the source, the previous guide (at `../<previous folder>/style-guide.md` — same convention as the other tasks), and the extraction results, plus optional cross-references (the same volume's `glossary.md` / `character-voice.md` snapshots, read if present), then writes the cumulative `style-guide.md`. The guide is written in the **target language** (it is instructions for writing the translation), quoting source-language patterns inline.
3. **QA loop**: a fresh validator agent per iteration writes `style-guide-validation.md` (size-scaled step cap) → acceptance one-shot scores the guide 0–100 → unless the rolling window of scores meets the criterion, a fresh author agent applies the feedback (`style-guide-feedback.md`). Same score-based acceptance as the other pipelines (the state file is saved on every iteration, including the accepting one, so accepted volumes are skipped on re-run).
4. After all volumes: the last volume's `style-guide.md` is copied to the series artifacts directory (`SERIES_ARTIFACTS_DIR`, default `<SERIES_LOCATION>/style-guide.md`). Skipped for `--volume` runs.

Artifacts per volume folder: `style-guide.md` (cumulative snapshot), `style-guide-new.json` (extraction snapshot for the handoff), `style-guide-validation.md` (validation report).

**Cumulative invariant:** same as glossary/character-voice — regenerating any volume sets `regeneratedAny` → all later volumes are regenerated too.

**Key differences:** single output file (no second per-volume file); no research stage; rules must be *actionable* (a concrete rendering decision — keep / drop / translate / adapt — with context and exceptions; vague guidance is a validation finding); undecidable constructs go to an "Open Questions" section with their context rather than being guessed.

## 8. Pipeline E: consistency-audit + translation handoff (`consistency-audit.js`, `utils/handoff.js`)

The final gate before translation. Runs after the four volume tasks in the
default pipeline (and is also available standalone).

**Consistency audit** — an audit agent (gated fs tools, `cwd` = the series
root, writes confined to the root; the four artifacts are read-only) reads
`glossary.md`, `character-voice.md`, `style-guide.md` and `shared-wiki.md`
at the series root and writes `consistency-report.md`:

- **PASS/FAIL verdict** — FAIL when any HIGH finding exists (or when fewer
  than four artifacts were audited — a partial audit is not a sign-off).
- **Severity-banded findings** (HIGH blocks translation / MEDIUM should fix /
  LOW cosmetic) with verbatim quoted snippets from both sides of each
  conflict, across: glossary ↔ shared-wiki Glossary section, glossary ↔ style
  guide, character-voice ↔ wiki, style guide ↔ voice reference, plus
  intra-artifact contradictions.

No QA loop (it is a one-shot audit over the final state, not an
iteratively-built artifact). **Idempotency**: content-based — the report
also writes a `consistency-report.md.provenance.json` sidecar carrying the
sha256 fingerprint of each of the four audited artifacts; the report is
skipped while all four fingerprints still match the current files (any
artifact regeneration invalidates it). A missing or corrupt sidecar falls
back to the legacy mtime check (report newer than all four artifacts).
`--force` re-audits. A missing artifact fails loudly
(naming the task to run first). A **FAIL verdict is logged loudly but does
not fail the task** — the report is the deliverable; a fixer re-runs the
offending task and re-audits with `--force` before translation.

**Translation handoff** (deterministic, no AI) — per volume, written by the
jump-in-wiki task on both the processed and skipped paths:

- `chapters.json` — the machine-readable chapter list (segment id, file,
  title, char count, reading order) that the translation stage names its
  outputs by.
- `translation-brief.md` — a one-page brief: what is **new** in this volume
  (the persisted `glossary-new-terms.json` / `character-voice-new.json` /
  `style-guide-new.json` extraction snapshots), the chapter table, and
  pointers to every per-volume + series-level reference artifact (missing
  ones struck through, so the brief doubles as a completeness check).

## 8.5. Pipeline F: the translation stage (multi-model)

The final stage turns the reference artifacts into the actual translation.
It runs **per chapter** (segment ids from `chapters.json` / the source
bundle — plain-text volumes are one `whole` segment, epub volumes their
chapters + interludes) and runs each step against its own **role endpoint**
(`TRANSLATE_*` / `VERIFY_*` / `EDIT_*` / `AUDIT_*` — a name for "who does this
job", never a model name; on a shared-port local setup the hooks decide which
container answers, §3):

| Step | Task | Endpoint (env) | What it does |
|---|---|---|---|
| 1 | `translate` | Hy-MT2-30B-A3B (`TRANSLATE_*`) | Fresh translation per chapter, official single-user-message prompt (no system prompt), official sampling (temp 0.7 / top_p 1.0 / top_k -1 / rep-pen 1.0), `no_think` by default |
| 2 | `translate-qa` (round N) | verify: `VERIFY_*` · retranslate: `TRANSLATE_*` | The batched QA loop (see the design notes below). Each round: a **verify batch** — source-anchored 0–100 score + severity-banded findings per chapter (against source + glossary + style rules + **story background** — shared wiki / volume wiki / POV map; the source outranks the wiki, wiki-only findings cap at MEDIUM); PASS ≥ `PASSING_SCORE`; unparseable = FAIL (fail-closed) — then a **batched audit tiebreak** re-scores every borderline chapter (within `±VERIFY_TIEBREAK_BAND` of the passing score) on the `AUDIT_*` endpoint and averages the two scores (one endpoint switch, never interleaved with the verify loop) — then a **retranslate batch** — a fresh pass over every FAIL chapter, the findings injected as a numbered "fix these" task; the bad draft is **not** fed back. Rounds repeat until every chapter passes (round N+1's verify only re-scores the chapters round N retranslated — idempotent skips for the rest) |
| 3 | `polish` | polish: `EDIT_*` · final audit: `AUDIT_*` | **Two-phase, batched, cross-model.** Phase A (per chapter, the `EDIT_*` endpoint): proofreading pass (thinking on) — **the polisher sees NO source text** — gated by the deterministic regression guard. Phase B (batched, on the second `AUDIT_*` endpoint): the cross-model final audit scores each candidate on the source-aware drift rubric; a FAIL re-polishes on the `EDIT_*` endpoint (findings injected) and is re-audited next round. Up to `POLISH_QA_MAX_ROUNDS` (default 3) rounds; on exhaustion the draft is kept (runs on whatever drafts exist — including round-cap FAILs) |

**Design notes:**

- **The QA loop is batched, not per-chapter** (`translate-qa.js`). The
  pre-production pipeline loops "translate → validate → apply validation →
  re-validate …" until the validator is happy with the accuracy; the
  translation stage mirrors it as `translate` → **N rounds of
  [verify batch → retranslate batch]** → `polish` (N =
  `TRANSLATE_QA_MAX_ROUNDS`, default 3). Batching is forced by the local
  setup: the Hy-MT2 and Qwen containers share one port (only one serves at
  a time; switching is expensive), so the loop never interleaves models per
  chapter — each half-round is a whole single-model task run, invoked
  through `withHooks()` so the per-batch model-switch hooks fire at every
  boundary. The hash-keyed idempotency (verification sidecar +
  `translation-state.json`) makes round N+1 re-do only what round N
  changed: unchanged drafts are verify skips, PASS chapters are retranslate
  skips. **Stop conditions** (checked in order, pure `qaLoopDecision` in
  `utils/translate.js`): **all-pass** (the validator is happy),
  **stalled** (a retranslate batch applied nothing — every FAIL chapter
  already carries exactly those findings, per the `findingsHash` skip —
  nothing new can be applied; a plain re-run is then a cheap no-op and
  `--force` retries), **round-limit** (N rounds ran; still-FAIL chapters
  keep their latest draft — polish still runs on them).
- **No per-chapter QA loop inside a batch.** Each half-round is still
  one-shot calls per chapter with deterministic (no-AI) gates — the
  multi-model chain *is* the quality control (a different model grades the
  work). `verify-translate` is default-ON;
  `VERIFY_TRANSLATE_ENABLED=false` disables it **and** `retranslate`
  **and** the `translate-qa` loop (they are one QA chain) — the pipeline
  degrades to translate → polish.
- **Per-chapter idempotency via `translation-state.json`** (per volume
  folder, fail-open like the rolling-state files): each chapter entry carries
  `sourceHash` (the chapter's source text), `contextHash` (sha256 of glossary
  + style rules + shared-wiki/volume-wiki/POV background + voice notes —
  regenerating any reference invalidates every draft), `draftHash`,
  `retranslated`,
  `findingsHash`, `polishedDraftHash`, plus `polishVerifiedDraftHash` /
  `polishScore` / `polishFindings` / `polishFindingsHash` (the drift
  inspector's verdict + retry feedback — a chapter is polish-up-to-date only
  when `polishVerifiedDraftHash === draftHash`). A changed source, a re-run of
  the glossary/style/wiki
  tasks, or a retranslate (which bumps `draftHash` and clears
  `polishedDraftHash`) makes the dependent steps re-run on the next pass.
- **Story background injection** — `loadVolumeReferences` (utils/translate.js)
  builds `background` from the volume folder's `shared-wiki.md` (the
  cumulative "series state through this volume" — the per-volume copy, NOT
  the series-root one, which would leak later-volume spoilers), `wiki.md`
  (this volume's own plot beats), and `pov-map.md` (all truncated). It feeds
  the translate/retranslate prompts' background task line AND the
  verify-translate prompt's [Story Background] section (a 5th audit
  dimension: consistency with established facts, with the source text as
  ground truth — a wiki-only finding is capped at MEDIUM so a stale wiki
  cannot fail a correct translation). `polish` deliberately gets no source
  text and no background (its role is surface cleanup of already-verified
  text — the source-free prompt keeps the polisher from re-translating; the
  source-aware drift inspector is the semantic backstop, see below).
- **Chapter splitting** — a chapter longer than `TRANSLATE_CHUNK_CHARS`
  (default 24000) is split by `splitChapter` (paragraph-aware) and the parts
  are translated in order — both in `translate` and in `retranslate`; each
  part after the first receives the previous part's ending
  (`TRANSLATE_CONTINUITY_CHARS`, default 400, `0` = off) as continuity
  context. The parts are concatenated back into the single draft — with a
  deterministic dedup backstop: when the model repeats the previous part's
  ending at the start of its reply (continuation behaviour),
  `stripContinuityOverlap` strips the duplicated prefix (exact match only,
  ≥50 chars — a legitimate re-phrase can never be mangled).
- **Per-chapter concurrency (opt-in)** — the chapter loops of the three
  INDEPENDENT tasks (`verify-translate`, `retranslate`, `polish`) run through
  `runWithConcurrency` with the shared `STAGE_CONCURRENCY` limit (default 1 =
  serial — the local hardware runs one inference at a time; the legacy per-stage
  names `VERIFY_CONCURRENCY` / `RETRANSLATE_CONCURRENCY` / `POLISH_CONCURRENCY`
  / `AUDIT_CONCURRENCY` still override their own stage). Reports keep reading
  order (rows stored by index). `translate` stays serial by design: each chapter's
  prompt carries
  the previous chapter's ending as continuity context, so its chapters are
  chained. State/sidecar writes are concurrency-safe: each volume holds one
  shared in-memory object and every save serializes it whole (last write
  wins with the most complete data).
- **Deterministic QA** (`checkTranslationQa`, per draft, **multi-language**): the
  residue check is per PAIR (`residueRatio` — source script minus target script,
  so JA→EN counts kana+Han, JA→ZH only kana since Han is shared, KO→EN Hangul,
  ZH→EN Han), the length band is per PAIR (`lengthBands` — JA→EN 0.6–2.5, ZH→EN
  0.7–3.2, KO→EN 0.5–2.6; `TRANSLATION_LENGTH_RATIO` overrides), and term
  matching is word-boundary for space-separated sources (Korean) and substring
  for CJK. Hard fails — empty draft, source-script residue > 5% (the model echoed
  the source), length under the pair's truncation floor; warnings — residue > 0.5%,
  length outside the pair's band, glossary terms present in the source whose
  canonical rendering is absent from the draft. Per-volume reports:
  `translation-qa.md` (translate), `translation-verification.md`
  (+ `translation-verification.json` sidecar), `polish-qa.md` (polish).
- **Polish regression guard** — the polished text is only accepted when it
  passes the QA the draft passed **and** keeps the draft's glossary coverage;
  a guard failure becomes a numbered correction task for the next attempt
  (the deterministic half of the polish QA).
- **Polish final audit (batched, cross-model)** — the deterministic guard is
  lexical (it cannot catch a meaning shift), so a source-aware, **cross-model**
  final audit closes the semantic gap. It is **two-phase and batched** (the
  local containers share one port, so models are never interleaved per
  chapter): Phase A polishes every chapter on the `EDIT_*` endpoint (NO source
  text) and keeps only the candidates that pass the deterministic guard; Phase
  B runs the audit on the `AUDIT_*` endpoint — a SECOND endpoint, distinct from
  the polisher's — over the whole candidate batch (one endpoint switch, the
  `polish-audit` hook), scoring each on the drift rubric (diff-focused:
  the draft's own problems and surface improvements are not findings; the
  source is ground truth). PASS ≥ `PASSING_SCORE`;
  unparseable = FAIL (fail-closed). A FAIL is re-polished on the `EDIT_*`
  endpoint (the `polish` hook switches back) with the findings injected as a
  numbered
  "fix these" task (the retranslate pattern) and re-audited next round; up to
  `POLISH_QA_MAX_ROUNDS` (default 3) rounds. On exhaustion the polished text
  is rejected, the draft is kept (any polished file is dropped so the merge
  publishes the draft), and the last findings persist in the state — the next
  run re-audits with them, and `--force` gives a fresh stochastic attempt. A
  polished chapter is "up to date" only when
  `polishVerifiedDraftHash === draftHash` (set by Phase B, not Phase A);
  legacy polish state (no verified hash, pre-audit runs) gets its existing
  polished text audited on the first run after the upgrade instead of
  re-polished. `POLISH_VERIFY_ENABLED=false` gates the pass on the
  deterministic guard only (Phase A candidates are accepted without the
  cross-model audit).
- **Merge** — after every step, `mergeVolumeTranslationFiles` rewrites the
  volume's `translation.md` from the per-chapter files: the
  `polished-<id>.md` text wins when the state shows it was produced from the
  CURRENT draft (`polishedDraftHash === draftHash`), otherwise the draft.
- **Endpoint sanity check** — every task calls `harness.assertModelServing`
  (`GET /v1/models`) before its first call and fails loudly when nothing is
  serving or the model id is missing — the loop re-checks before every
  batch. The task code contains **zero Docker
  logic** — on local multi-model setups the per-machine pre-hooks switch the
  containers (see §3 "Pipeline hooks" and `hooks/README.md` Example 4).

**Artifacts per volume folder:** `translation-<id>.md` (draft per chapter),
`polished-<id>.md` (when the polish pass was accepted), `translation.md`
(the merged volume), `translation-qa.md`, `translation-verification.json` +
`translation-verification.md`, `polish-qa.md` + `polish-verification.json`
(the drift inspector's verdicts), `translation-state.json`.
All gitignored (generated output).

## 9. Environment reference (`.env`)

**One variable per decision.** The catalogue was consolidated: `PASSING_SCORE`
(one threshold for every scored gate), `STAGE_CONCURRENCY` (one worker-count
knob for every stage), `JUDGE_TEMPERATURE` + `STAGE_THINKING_LEVEL` (the calls
that grade rather than write), `AI_CONTEXT_WINDOW` (the server's context, which
also sizes the default output cap) and `SERIES_ARTIFACTS_DIR` (where the four
series-level copies go). The older per-gate names (`ACCEPTANCE_PASSING_SCORE`,
`VERIFY_PASSING_SCORE`, `POLISH_VERIFY_PASSING_SCORE`, `VERIFY_TEMPERATURE`,
`AUDIT_TEMPERATURE`, `EDIT_TEMPERATURE`, `<STAGE>_THINKING[_LEVEL]`,
`<STAGE>_CONCURRENCY`, `RESEARCH_CONCURRENCY`, `AGENT_CONTEXT_WINDOW`,
`*_OUTPUT_FILE`, `DISCOVERY_MAX_ATTEMPTS`) are still read as fallbacks, so an
existing `.env` keeps working unchanged — they are simply no longer the
documented knobs. `POLISH_VERIFY_TEMPERATURE` was removed outright: it was read
into a variable nothing ever used.

### AI provider (`AI_*`)

| Var | Default | Meaning |
|---|---|---|
| `AI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `AI_API_KEY` | — (required) | Auth |
| `AI_MODEL` | `gpt-4o-mini` | Model id |
| `AI_CONTEXT_WINDOW` | `128000` | The model server's context window (tokens). One number for one fact: it drives agent session auto-compaction AND the default output cap, so the two cannot contradict each other. Legacy name `AGENT_CONTEXT_WINDOW` still honored |
| `AI_MAX_TOKENS` | a quarter of `AI_CONTEXT_WINDOW` | Max OUTPUT tokens per call. Derived so it can never equal the context (several servers reject that before the call starts — gotcha 36); set it only to override |
| `AI_TEMPERATURE` | `0.7` | Sampling temperature — the house temperature (it also applies to the polish pass) |
| `AI_RETRY` | `0` | Retries per AI call (API errors + empty responses) |
| `AI_CALL_DEADLINE_MS` | `3600000` | Idle deadline per model call (ms): aborts a call that makes no progress (no streamed events) for this long — the ONLY wall-clock bound (all fetch timeouts are disabled). An IDLE timeout reset on every event, so healthy long calls are never aborted; `0` = off. |
| `AI_THINKING` | on | Qwen3 thinking phase — **enabled by default**, for agent turns and stage calls alike. See §9. |
| `AI_THINKING_LEVEL` | xhigh | reasoning_effort for the **authoring agents**: "low" / "medium" / "xhigh" (model-dependent). The judging/proofreading stages use `STAGE_THINKING_LEVEL` (calmer by default). |

### Series (`SERIES_*`)

| Var | Default | Meaning |
|---|---|---|
| `SERIES_LOCATION` | — (required) | Folder holding the series — the intake agent explores it (volume folders, loose `.epub`/text files, art books, …) |
| `SERIES_NAME` | — (optional) | Series name. Unset, the intake agent decides it from what the books say; set it and it **overrides** that decision (the agent is told to use it verbatim) |

### Series intake (`DISCOVER_*`)

Knobs for the `discover` step (§3.5). All optional — the defaults are the tuned values.

| Var | Default | Meaning |
|---|---|---|
| `DISCOVER_SAMPLE_CHARS` | `1500` (max 6000) | How many characters of a book's text the intake agent may read per sample call. Raise it for a series whose books look alike |
| `DISCOVER_MIN_CONFIDENCE` | `0.6` | Lowest agent-reported confidence that lets the pipeline start; fail-closed (a plan reporting no `discovery.confidence` at all is rejected); `0` disables the gate |
| `DISCOVER_MIN_VOLUME_TEXT_CHARS` | `1000` | The "is there a readable text at all" floor for a staged volume (the objective half of the integrity check). Not a story-length rule — narrative-ness is the agent's call (each volume's `integrity` block). Catches binary junk / empty archives / stubs; an art book is rejected separately by its image-dominated archive size |
| `DISCOVER_STRICT` | `false` | `true` turns a disagreement with the existing folder layout into an error instead of a warn-and-keep |
| `DISCOVER_MAX_ATTEMPTS` | `2` | Intake attempts before the step fails (fresh agent each attempt, 10 s apart). Legacy `DISCOVERY_MAX_ATTEMPTS` is still read as a fallback |

### Translation (`TRANSLATION_*`)

| Var | Default | Meaning |
|---|---|---|
| `TRANSLATION_SOURCE_LANGUAGE` | Japanese | **Override** for the source language — fills `{{SOURCE_LANGUAGE}}` in the prompts. Unset, the intake agent's `sourceLanguage` decides it |
| `TRANSLATION_TARGET_LANGUAGE` | English | Target language — fills `{{TARGET_LANGUAGE}}` in the prompts |
| `TRANSLATION_LENGTH_RATIO` | per-pair | The deterministic-QA length-ratio band (`"min-max"` or `"min-max-truncation"`). Unset, the per-pair default is used (JA→EN 0.6–2.5, ZH→EN 0.7–3.2, KO→EN 0.5–2.6). The source-script residue check is automatic per pair (JA→EN kana+Han, JA→ZH kana, KO→EN Hangul, ZH→EN Han) — no setting needed |

### Translation stage (`TRANSLATE_*`, `VERIFY_*`, `EDIT_*`)

Multi-model chain of the translation stage (§8.5). Every role prefix
resolves `BASE_URL` / `API_KEY` / `MODEL` with fallback to the global `AI_*`
settings, so a single-model setup needs none of these. On local multi-model
setups the per-machine pre-hooks switch the model container per stage
(`hooks/README.md` Example 4) — the tasks only run the `/v1/models` check.

| Var | Default | Meaning |
|---|---|---|
| `TRANSLATE_BASE_URL` / `TRANSLATE_API_KEY` / `TRANSLATE_MODEL` | `AI_*` | Endpoint for `translate` + `retranslate` (Hy-MT2) |
| `TRANSLATE_TEMPERATURE` | `0.7` | Hy-MT2 official sampling temperature (top_p 1.0 / top_k -1 / rep-pen 1.0 are fixed by the official recipe) |
| `TRANSLATE_THINKING` | `no_think` | Hy-MT2 thinking dialect: `no_think` / `low` / `high` (also accepts `true` → `low`, `false` → `no_think`) — mapped to `reasoning_effort` |
| `TRANSLATE_CHUNK_CHARS` | `24000` | Max chars per translation call; longer chapters are split (paragraph-aware) and translated in order |
| `TRANSLATE_CONTINUITY_CHARS` | `400` | Chars of the previous chapter-part's ending fed to the next part as continuity context (`0` = off) |
| `TRANSLATE_QA_MAX_ROUNDS` | `3` | Max `translate-qa` rounds (round = verify batch + retranslate batch); the loop stops earlier when all chapters pass or a round retranslates nothing (stalled) |
| `TRANSLATE_QA_RETRY_BUDGET` | `2` | How many times a chapter may be retranslated against an IDENTICAL set of verification findings before the loop calls it stalled (the stall guard's escape hatch: the translator runs at temp 0.7, so a second shot at the same findings can succeed; a different findings set resets the budget) |
| `VERIFY_TRANSLATE_ENABLED` | `true` | `false` disables `verify-translate` **and** `retranslate` **and** the `translate-qa` loop (one QA chain) — the pipeline degrades to translate → polish |
| `VERIFY_BASE_URL` / `VERIFY_API_KEY` / `VERIFY_MODEL` | `AI_*` | Endpoint for `verify-translate` |
| `EDIT_BASE_URL` / `EDIT_API_KEY` / `EDIT_MODEL` | `AI_*` | Endpoint for `polish` (its temperature is `AI_TEMPERATURE`, its thinking follows `AI_THINKING` + `STAGE_THINKING_LEVEL`) |
| `POLISH_VERIFY_ENABLED` | `true` | `false` gates the polish pass on the deterministic regression guard only (no AI drift audit) |
| `POLISH_QA_MAX_ROUNDS` | `3` | Max polish rounds per chapter (a round = Phase A guard-gated candidate + Phase B cross-model audit; a FAIL re-polishes on the `EDIT_*` endpoint and is re-audited next round) |
| `VERIFY_TIEBREAK_ENABLED` | `true` | `false` skips the verify borderline tiebreak (always trust the verifier's single score) |
| `VERIFY_TIEBREAK_BAND` | `5` | Chapters whose verify score lands within ±N of the passing score are re-scored on the `AUDIT_*` endpoint (cross-model) and the two scores averaged |
| `AUDIT_BASE_URL` / `AUDIT_API_KEY` / `AUDIT_MODEL` | `AI_*` | Endpoint for the cross-model audits (verify tiebreak + polish final audit) — configure it to a DIFFERENT model than the stage being graded, or the audit is the same model grading its own work; on local setups the `verify-audit` / `polish-audit` hooks switch its container in (the model alias is usually `local`) |

### Thresholds, judging and concurrency

The knobs that used to be repeated per stage, now one each. Every scored gate
uses the same 0–100 rubric, so it has one threshold; every stage runs on the
same machine, so it has one worker count.

| Var | Default | Meaning |
|---|---|---|
| `PASSING_SCORE` | `70` | The one passing threshold (0–100) for **all three** scored gates: artifact acceptance (§4–§7), chapter verification (§8.5) and the polish drift audit. 70 is the rubric boundary between "Pass with minor edits" (70–84) and "Requires revision" (40–69). Legacy names `ACCEPTANCE_PASSING_SCORE` / `VERIFY_PASSING_SCORE` / `POLISH_VERIFY_PASSING_SCORE` still override it, in that order |
| `JUDGE_TEMPERATURE` | `0.2` | Sampling temperature for every call that grades text (verification, the verify tiebreak, the polish drift audit). Legacy `VERIFY_TEMPERATURE` / `AUDIT_TEMPERATURE` still override |
| `STAGE_THINKING_LEVEL` | `medium` | How hard the stage calls deliberate (verify / audit / polish) — deliberately calmer than the authoring agents' `AI_THINKING_LEVEL`; `AI_THINKING=false` turns their thinking off too. Legacy `<STAGE>_THINKING[_LEVEL]` still override |
| `STAGE_CONCURRENCY` | `1` | Independent units a stage runs at once: chapters per verify / retranslate / polish pass, chapters per audit batch, research agents per glossary term. `translate` stays serial by design (its chapters are chained by the continuity tail). Legacy per-stage names `RESEARCH_CONCURRENCY` / `VERIFY_CONCURRENCY` / `RETRANSLATE_CONCURRENCY` / `POLISH_CONCURRENCY` / `AUDIT_CONCURRENCY` still override per stage |

### Source bundle (`SOURCE_*`)

| Var | Default | Meaning |
|---|---|---|
| `SOURCE_CHUNK_THRESHOLD_CHARS` | `120000` | Whole-installment char count above which the chapter-by-chapter fallback activates automatically (see §3 "Source bundle & chapter-by-chapter fallback"). `--chunked` forces it for any multi-chapter epub. |

### Agents (`AGENT_*`)

| Var | Default | Meaning |
|---|---|---|
| `AGENT_MAX_STEPS` | `20` | Default step cap for tool agents (workflows pass higher caps where needed) |
| `AGENT_TEXT_GUARD_CHARS` | `30000` | Runaway-generation guard: abort an agent turn when it produces more than this many chars of text with fewer than 3 tool calls. Catches models that emit malformed tool-call text instead of using the tool-calling API. |
| `AGENT_RECOVERY_ENABLED` | `true` | Recovery turn when an author agent replies in chat instead of `writeFile` — asks it to write the file with the content it already generated |

### QA loop & acceptance (`QA_*`, `ACCEPTANCE_*`)

| Var | Default | Meaning |
|---|---|---|
| `QA_MAX_ITERATIONS` | `10` | QA-loop cap per volume (increased to allow rolling average to converge) |
| `ACCEPTANCE_WINDOW_SIZE` | `2` | Number of recent acceptance checks in the rolling window. How many checks it needs before it can fire is derived from it (`min(2, window)`) — not a separate knob, because a window can never hold more samples than its own size |
| `ACCEPTANCE_STRATEGY` | `average` | How the window is evaluated: `average` (mean of scores ≥ `PASSING_SCORE`) or `best` (≥ `ACCEPTANCE_BEST_MIN_PASSES` scores ≥ `PASSING_SCORE`) |
| `ACCEPTANCE_BEST_MIN_PASSES` | `3` | For `ACCEPTANCE_STRATEGY=best`: minimum scores ≥ `PASSING_SCORE` needed |

### Un-monitored run policies (`ON_*`, `DISCOVER_*`)

Front-loaded decisions so a long run never halts waiting for a human (code
defaults are the safe "fail loudly" behavior; the committed `.env` sets the
un-monitored values). Skipped work is picked up on a cheap idempotent re-run.

| Var | Default | Meaning |
|---|---|---|
| `ON_VOLUME_ERROR` | `abort` | When a volume's processing fails: `abort` stops the task; `skip` logs the error and continues with the next volume |
| `ON_MISSING_PREVIOUS` | `abort` | When a cumulative task finds the previous volume's artifact missing: `abort` fails loudly; `skip` warns and skips the volume (later volumes cascade the same way) |
| `ON_QA_LIMIT` | `accept` | When the QA loop hits `QA_MAX_ITERATIONS` without a passing grade: `accept` keeps the output as-is; `fail` treats the volume as failed (then subject to `ON_VOLUME_ERROR`) |
| `ON_TASK_ERROR` | `abort` | Default run: `abort` stops at the first failing step; `continue` runs the remaining steps, then fails the run with a summary |
| `DISCOVER_MAX_ATTEMPTS` | `2` | Intake-agent attempts before failing the step (fresh agent each attempt, 10 s apart; per-attempt endpoint retries still apply via `AI_RETRY`). See §3.5 |

### Output locations

| Var | Default | Meaning |
|---|---|---|
| `SERIES_ARTIFACTS_DIR` | `<SERIES_LOCATION>` | Where the four series-level copies are published: `glossary.md`, `character-voice.md`, `style-guide.md`, `shared-wiki.md` (the newest per-volume `shared-wiki.md` is copied here after the jump-in-wiki task — the series-level living wiki). Legacy per-file names `GLOSSARY_OUTPUT_FILE` / `VOICE_OUTPUT_FILE` / `STYLE_OUTPUT_FILE` / `SHARED_WIKI_OUTPUT_FILE` still override individually |

**Provenance sidecars:** every root copy (glossary / character-voice /
style-guide / shared-wiki) also gets a `<file>.provenance.json` next to it
(source volume, copy timestamp, content hash — `writeProvenanceSidecar` in
`utils/fs.js`), so it is always visible WHICH volume snapshot a root artifact
was copied from.

### Research (`RESEARCH_*`, `WIKI_*`, `SEARCH_*`)

| Var | Default | Meaning |
|---|---|---|
| `RESEARCH_ENABLED` | `true` | Research new glossary terms |
| `RESEARCH_MAX_RESULTS` / `RESEARCH_EXTRACT_CHARS` | `3` / `800` | Research result size |
| `RESEARCH_DELAY_MS` / `RESEARCH_TIMEOUT_MS` | `300` / `30000` | Politeness delay / per-request timeout |
| `WIKI_LANGS` | `ja,en` | Wikipedia languages to query |
| `WIKI_USER_AGENT` | built-in | Descriptive UA (Wikipedia requires one) |
| `SEARCH_API` / `SEARCH_API_KEY` | off | Optional brave / tavily / serper backend |

**Current local setup** (the committed `.env`): local Qwen at `AI_BASE_URL=http://localhost:9200/v1` with `AI_MODEL=local`, `AI_CONTEXT_WINDOW=262144` (so the output cap derives to 65536), `AI_TEMPERATURE=0.6`, `AI_RETRY=2`, `QA_MAX_ITERATIONS=5`, `PASSING_SCORE=69`, `TRANSLATE_QA_MAX_ROUNDS=5`, `DISCOVER_MAX_ATTEMPTS=3`, the un-monitored policies (`ON_VOLUME_ERROR=skip`, `ON_MISSING_PREVIOUS=skip`, `ON_TASK_ERROR=continue`), thinking on at `xhigh` (default), series = `test-series` (the `test_story` fixture), target language English. It sets **nothing else**: no `SERIES_NAME` and no `TRANSLATION_SOURCE_LANGUAGE`, so the intake agent actually has to work out the series name and the source language, and no role endpoints, so every role resolves through the `AI_*` fallback. The per-machine hooks still map each role to a container — `hooks/pre-translate.sh` / `pre-retranslate.sh` → Hy-MT2, `hooks/pre-verify-translate.sh` / `pre-polish.sh` → **Qwen3.8-flash-next** (also pre-warmed by `post-translate.sh` / `post-retranslate.sh`), `hooks/pre-verify-audit.sh` / `pre-polish-audit.sh` → **Qwen3.8-27b-beellama** (the cross-checks), `hooks/post-polish.sh` → back to **Qwen3.8-flash-next** once the run ends (the default resting model). The `translate-qa` loop re-fires the batch hooks on every round boundary; the state file makes a repeat switch a no-op. This mapping is pure hook policy — nothing in the task code knows these model names. **It points at the test fixture, not the real 17 volumes** — check this before any "production" run.

## 10. Gotchas (hard-won — read before changing behavior)

1. **`AI_THINKING_LEVEL` tuning is per-series.** Reasoning token burn varies dramatically across series — a series with heavy technical jargon may need "xhigh" while a simpler narrative may run fine on "medium". Start with "xhigh" (the default), monitor `.logs/call-ai-*.log` for reasoning content sizes, and tune down to "medium" or "low" if the reasoning spend is excessive relative to content output. Set `AI_THINKING=false` to disable entirely.
2. **Never let a stage persist empty output.** `runOneShot` throws on empty by design; agent stages are guarded by `assertWrote` (missing/empty file → hard error pointing at `.logs/`). If you add a stage, add both guarantees.
3. **Do not touch the agent-mode prompt safety nets** (the stray-file cleanups): each was added after a live failure (wrong file names, stale strays being audited, marker-format conflicts). The pure tests pin their behavior — run `npm test` after touching any prompt or file name.
4. **Validator step caps scale with source size** (`validatorMaxStepsFor`): a fixed cap of 40 ran out on the 521KB volume-01 source before the validator wrote its report.
5. **The glossary is cumulative** — see the §4 invariant (`regeneratedAny`).
6. **Skip-checks are deterministic** (reads a persisted `*-rolling-state.json` file storing the rolling window of scores, and the run's `sourceFingerprint`). If the state file is missing or uses the legacy boolean format (pre-score-based era), `loadRollingState` returns `null` and the check falls back to regenerating/re-validating the volume once (fail-open) — so pre-existing runs are safe to re-run. State files from before source-staleness detection have no `sourceFingerprint`; `isSourceStale` is fail-open on that (the volume keeps skipping) — the first run after the upgrade re-fingerprints on the next regeneration.
7. **Acceptance parsing is intentionally strict**: the acceptance prompts require a single JSON object (`{"score", "band", "note"}`); `parseAcceptanceReply` parses that JSON first and falls back to the legacy `parseAcceptanceScore` integer forms (bare, `N/100`, `N out of 100`) — anything else (prose verdicts, >100, no number) is `null` and the check counts as a **failure** (fail-closed — the feedback loop gets another shot). The legacy `isPassingVerdict` is kept exported for compatibility but no longer used in the acceptance path.
8. **The fs write gate confines writes to the volume folder**; reads are allowed anywhere (agents need the previous volume). `deleteFile` is always denied — the *workflow* deletes stale strays, never the agent.
9. **Logging is per-run with full chat histories and real-time streaming:** Each process run creates a directory under `.logs/<ISO-timestamp>/` containing:
   - `summary.log` — greppable `CALL`/`RESULT`/`WARNING` lines (same format as before)
   - `one-shot/<label>.md` — full system prompt, messages, and response for each `runOneShot` call (written after completion)
   - `one-shot/<label>.stream.md` — partial output streamed in real-time as the AI generates text (written during the call)
   - `agent-<name>/turn-<N>.md` — full chat history for each agent turn (system prompt, user input, assistant response, reasoning, tool calls + results) (written after completion)
   - `agent-<name>/turn-<N>.stream.md` — partial output streamed in real-time as the AI generates text (written during the call)
   
   The `.stream.md` files are the key diagnostic tool when AI calls stall or hang — they show what was produced so far even if the call never completes. Log lines still go to stderr and `summary.log`; chat files are written asynchronously after each call completes.
10. This directory is **inside a git repository** (the root is the parent `oresuki/` folder — git paths here appear as `ai-client/…`); `.gitignore` documents the ignored generated outputs (`.logs/`, `.dry-run/`, generated `test-series` files).
11. **The discovery agent's manifest is cached and auto-stale:** `getTranslationTarget()` reuses an existing `translation-target.json` unless `--force` is passed, a listed source file has been deleted, or the cached `seriesLocation` no longer matches `SERIES_LOCATION` (stale → auto-regenerate). The location check matters across machines: a Windows-generated `C:\...` path is *not* absolute on Linux, so every file op silently resolves relative to the CWD (observed live: a migrated Windows manifest was reused on Linux and the character-voice task crashed with ENOENT on `<CWD>/C:\...\test_story(1)/...`). Related: `seriesLocation` is provenance metadata — tasks derive the live series dir from `SERIES_LOCATION` (env), never from the manifest field. With `--dry-run` the AI is never called and the legacy convention is used instead.
12. **Research concurrency (`STAGE_CONCURRENCY`):** default 1 (sequential); raise it to research terms in parallel (it is the same knob the verify / retranslate / polish / audit batches use — the legacy `RESEARCH_CONCURRENCY` still overrides just this stage). Each agent has a fixed `maxSteps=15` — the old global cap (`max(30, 5·terms + 10)`) was replaced by per-agent caps. The skeleton-first approach ensures crash safety: failed terms leave `- (pending)` in place.
13. **Fresh agents per QA feedback iteration:** the author session is no longer persistent across the QA loop. Each feedback pass creates a new agent with a self-contained prompt (validation report + current glossary). This prevents context window bloat but increases per-iteration token cost.
14. **Glossary truncation:** if the previous glossary exceeds 64KB, it is truncated to the last 200 entries before being passed to the author/validator agents. Earlier entries are carried forward unchanged (only conflicts with new terms need checking).
15. **Character voice reference is cumulative:** same `regeneratedAny` invariant as the glossary — if any volume is regenerated, all later volumes are regenerated too. The `character-voice.md` carries forward all previous character entries unchanged.
16. **POV marker conventions:** Japanese LNs use `※`, `☆`, `◇`, `◆`, `【】`, `（）` as POV markers. The extract prompt recognizes these and classifies narration types (first-person-internal, free-indirect, third-person-omniscient, dialogue-only). Free indirect discourse — 3rd-person narration that adopts a character's voice — is the hardest pattern to detect reliably and is the most common validation finding.
17. **Runaway-generation guard (`AGENT_TEXT_GUARD_CHARS`):** the harness aborts an agent turn when it produces more than `AGENT_TEXT_GUARD_CHARS` (default 30,000) characters of text with fewer than 3 tool calls. This catches models that emit malformed tool-call text (e.g. Qwen-native `<tool_call>` tags in the content field) instead of using the API-level `tool_calls` protocol. Observed live: a local Qwen3 model generated 962 KB of repeated `listFiles(path='.'); readFile(...)` text without a single valid tool call, burning tokens for over an hour. The guard aborts the underlying fetch via an `AbortController` signal and throws a descriptive error. The threshold is tunable via the env var; lower it if you see false positives with large legitimate outputs, raise it if you see the guard not triggering fast enough.
18. **Fail-loudly guard for small malformed tool calls (`assertRealToolCalls` in `character-voice.js`):** the 30K runaway guard above only fires on *large* text output. A local Qwen endpoint also intermittently emits *small* malformed tool calls — a few dozen chars of `tool_call` / `<function=…>` text with zero real `tool_calls` — so `npm run smoke fs` can pass while a workflow turn does nothing (no reads, no writes). `character-voice.js` now calls `assertRealToolCalls(result, who, volume)` after every agent `sendTurn` in the compile/validate/feedback stages: when a turn made zero real tool calls but its text contains `tool_call` / `<function=`, it throws a diagnostic error (pointing at `.logs/` and the smoke test) instead of letting `assertWroteWithFallback` pass on a stale file and the acceptance loop burn all iterations. The pure detector `emittedToolCallAsText` is exported and unit-tested. `style-guide.js` ships the identical guard (every agent `sendTurn` in compile/validate/feedback is checked), and `glossary.js` (research/author/validator/feedback/merge turns), `jump-in-wiki.js` (section author, merge, validator, findings-merge, feedback turns) and `consistency-audit.js` (the audit turn) carry the same guard — all five task modules are covered.
19. **Never hand the npm undici Agent to Node's global fetch (`makeProviderFetch` in `harness.js`).** The project's `undici` dependency (v8) is a *different build* from Node's bundled undici (which powers the global `fetch`). Passing `noTimeoutAgent` to the global `fetch` mixes request-handler protocols: on Node builds whose bundled undici is older, the dispatch throws `InvalidArgumentError: invalid onRequestStart method` (`UND_ERR_INVALID_ARG`) before any bytes are sent. This is Node-version-dependent, so identical code + `node_modules` can work on one machine (e.g. Windows Node) and fail on another (Linux Node 22) — observed live right after a Windows→Linux migration. The fix pattern: dispatch through undici's *own* `fetch` (same build as the Agent), and normalize `Headers` instances to plain objects first (undici's webidl converter would silently convert a foreign Headers instance to an empty record, dropping auth/content-type).
20. **Never sort epub bundle segments by filename — iterate `bundle.segments`.** Interlude (and epilogue) files are named `<base>-chN.K.md` where N is the chapter that existed immediately before the segment and K restarts at 1 for each chapter (`ch1.md`, `ch1.1.md`, `ch2.md`, `ch2.1.md`, `ch2.2.md`, `ch3.md`…). A filename sort misorders `chN.md` vs `chN.K.md` (a plain string sort puts `chN.1.md` *before* `chN.md` because `1` < `m`). The `SourceBundle.segments` array is the single source of truth for reading order (set by `assignSegmentIds` during extraction). Related: the epub extraction is cached in `<base>-bundle.meta.json` (keyed on the epub's mtime/size plus a `schema` version — renaming the id scheme bumps `BUNDLE_SCHEMA_VERSION` and forces re-extraction, removing the stale old-named segment files); `--force` re-extracts, and a deleted/stale cache file just triggers re-extraction (fail-open).
21. **Un-monitored run policies change where failures surface — read the summary, not just the last log line.** With the un-monitored values in `.env` (`ON_VOLUME_ERROR=skip`, `ON_MISSING_PREVIOUS=skip`, `ON_TASK_ERROR=continue`), a broken volume no longer aborts its task or the pipeline: the task logs `[skip] Volume NN (…) failed: …`, keeps going (in the cumulative tasks the skip cascades through the remaining volumes via the missing-previous check), and the pipeline finishes with a `N of M volume(s) failed` / `Pipeline finished with N failed step(s)` summary that still fails the run (non-zero exit). The final series-root copy uses the **last existing** snapshot, so a partially failed run publishes the last good volume's artifact rather than nothing. Recovery is a plain re-run: idempotent skip-checks make it cheap, and the failed/skipped volumes are picked up. Code defaults are the opposite (fail loudly at the first problem) — keep them that way so interactive runs stay safe, and don't "fix" the cascade by making per-volume idempotency independent of the previous volume's artifact.
22. **The translation stage's model switching lives in the hooks — not in the task code.** Every local model container (Hy-MT2, Qwen3.8-flash-next, Qwen3.8-27b-beellama, …) advertises the **same model alias** (`local`) and shares **one host port** (9200), so the ai-client cannot tell the models apart by name — `TRANSLATE_MODEL` / `VERIFY_MODEL` / `EDIT_MODEL` / `AUDIT_MODEL` are all `local`. Which container answers which role is therefore hook policy alone, and a role may be remapped to any model without touching the code. The per-machine pre-hooks (`hooks/pre-<task>.sh` → `model-switch.sh <compose dir>`) stop the current port owner, start the stage's container, and poll `/health` until the model is loaded. Consequences: (a) never add Docker/container logic to the task modules — the `/v1/models` check (`assertModelServing`) is the only endpoint contact; (b) running a translation task standalone on the wrong model fails loudly at the sanity check only if the model id differs — with identical aliases it translates with whatever happens to be up, so on local setups always run the tasks via the hooked pipeline (or the per-task gulp tasks, which fire the hooks); (c) `model-switch.sh` is idempotent via `hooks/.model-switch-state` (the compose dir it last started — the compose PROJECT label is *not* usable: compose sanitizes project names, so `Qwen3.8-27b-beellama` becomes `qwen38-27b-beellama` and never matches a dir-name comparison); a container started manually (no state file) is treated as "unknown" and swapped; (d) the `translate-qa` loop re-fires these batch hooks on every round (up to two switches per round) — a repeat switch is a no-op via the state file, so a round that ends on the model the next round needs costs nothing; (e) **the state file must match reality** — a container started by hand (or a hook run from a different checkout) leaves `.model-switch-state` naming a dir that is not actually serving, and the next hook for that dir skips the switch as a no-op, running the stage on the wrong model. Re-sync it by hand (write the compose dir of the container that owns the port) or delete the file, which forces the next hook to swap.
23. **The translate-qa loop stops on "stalled" — a stuck chapter is not retried on a plain re-run.** The retranslate task skips a chapter when it was already retranslated for byte-identical findings (`findingsHash` match — cross-run idempotency). In the loop, when a retranslate batch therefore applies nothing (`retranslated === 0`), the loop stops ("stalled") instead of burning identical model calls round after round. Consequence: a chapter whose verification keeps failing with identical findings keeps its latest draft; a plain re-run is cheap (one verify batch of skips + stall) and `npx gulp translate-qa --force` (bypasses the skip) gives it a fresh stochastic attempt (Hy-MT2 runs at temp 0.7, so a retry can succeed). The round cap (`TRANSLATE_QA_MAX_ROUNDS`) is the backstop for oscillating findings (different text each round) — it bounds the worst case at N verify batches + N−1 retranslate batches per pipeline run, and still-FAIL chapters keep their latest draft (polish still runs on them; the verification report records the FAIL).
24. **The polisher sees no source text — the drift inspector is the semantic backstop.** The polish prompt is deliberately source-free: a source-seeing polisher re-opens unverified re-translation by a non-translation model (the polisher runs on `EDIT_*`, not on the designated `TRANSLATE_*` endpoint) — exactly the gap the verify loop exists to close. So the source-aware drift inspector (which DOES see the source, auditing the polished text against the verified draft) is the only thing standing between a polish pass and a silent meaning change. Don't hand the source back to the polisher prompt to "improve" accuracy — fix fidelity upstream (translate / verify-translate / retranslate); polish is surface cleanup, and its QA (guard + inspector) is what may see the source.
25. **Recovery turns are gated on `assertWroteWithFallback`'s real return value.** It returns true ONLY when an expected output file was actually missing (fallback written from the chat reply, or no content to recover with). It used to always return true, and several call sites (validator/compile/feedback passes) ignored the value entirely — so EVERY stage ran a redundant "recovery" turn over an already-correct file: a second stochastic rewrite of the output plus a false claim in the recovery prompt ("you replied in chat" when the agent had written the file fine). The contract is unit-tested (test-translate.js) — if you add a recovery turn, gate it on the return value AND the `AGENT_RECOVERY_ENABLED` env check, like every other site.
26. **`AI_CALL_DEADLINE_MS` is an IDLE timeout — don't convert it to a total-time limit.** Agent turns are multi-step (each step is a model call); a healthy validator turn over a 500KB source legitimately runs for a long time, but it emits events (text deltas, tool calls) continuously. The deadline resets on every streamed event, so only a HUNG connection (no events for the whole window) is aborted. Converting it to a per-turn total limit would false-positive on legitimately long turns; removing it would let a dead container hang an un-monitored overnight run forever (all fetch timeouts are disabled for local servers).
27. **`contextHash` includes `voiceNotes` — changing the formula invalidates every draft.** The idempotency key is the sha256 of (glossary + style rules + background + voice notes) because any of those four is injected into the translate/retranslate prompts. If you add or drop a component of the prompt's reference bundle, add it to the hash too — and remember a one-time full re-translation is the cost of the change (state files carry the old hash until then).
28. **The manifest is the plan of record and folder names are sticky.** `readCommittedLayout` + `applyCommittedLayout` force the intake agent to keep the name of any existing folder that already holds pipeline output — even when the agent proposes a nicer name, and even under `--force`. Renaming such a folder orphans every artifact built under the old name (and the cumulative tasks would rebuild the whole series). The default is warn-and-keep; `DISCOVER_STRICT=true` turns the disagreement into an error. Empty folders may be renamed.
29. **`openEpub` parses the OPF as XML, never as HTML.** EPUB3 series markers are text-valued (`<meta property="belongs-to-collection">Name</meta>`), Calibre's are attribute-valued (`<meta name="calibre:series" content="Name"/>`), and the collection's `id`/`group-type` pairing uses `refines="#id"`, which must be normalized to plain `id` to match. HTML/regex parsing mangles self-closing tags and drops the text-valued properties, so the series marker silently disappears and the intake agent loses its strongest evidence.
30. **`--volume NN` is resolved through the manifest, not by parsing folder names.** `filterVolumesByInstallment` matches the manifest's `installmentNumber` (or an exact folder name). Agent-chosen folder names may not contain `(NN)` at all, so the legacy `installmentNumberFromDir` regex cannot be used for the CLI filter anymore.
31. **`--dry-run` previews the plan of record; it only builds one when there is none.** With a committed `translation-target.json` the dry run reads it and changes nothing on disk. Only when no usable plan exists does `buildDeterministicManifest` lay one out — existing volume folders that hold a book, or a flat pile of loose sources it stages into numbered folders (the one side effect a dry run has; it never modifies or deletes anything). Building a layout unconditionally used to preview a DIFFERENT order and re-stage every book into a second set of folders beside the committed ones — including the art book and preview the intake agent had deliberately excluded — and that litter then showed up as "existing folders" on the next intake.
32. **An agent-chosen folder name is validated, never rewritten.** `sanitizeFolderName` throws on a name with separators, `..`, an absolute path, or Windows-illegal characters — so a bad plan fails the validation/correction/retry path instead of quietly mangling a source-language title. Source-language text is kept as-is.
33. **A cached manifest that fails validation is never reused.** `readUsableManifest()` is the single door to the committed plan and it returns `null` — never a half-valid object — on any parse or validation failure. The bug this replaced logged "cached manifest is invalid … re-running intake" and then returned that same manifest on the next line, so an old-schema plan (no `schema` field, an unsanitized `Bad:Name` folder, an un-normalized `"1"` installment) went to every downstream task, and a half-written file crashed the task with `TypeError: manifest.volumes is not iterable`. Consequence worth remembering: the documented "an older manifest upgrades itself" path only works because of this — a manifest that is merely *old* must still be rejected before anything reads it.
34. **`openEpub` parses the OPF as XML but must stay case-insensitive.** Pass `{ xml: true, lowerCaseTags: true, lowerCaseAttributeNames: true }`. XML mode keeps tag names exactly as written, while the HTML mode this reader used before lowercased them — so an epub whose contents file says `<Package>/<Manifest>/<Spine>` (real files do) fails with "the spine contains no readable items", and not just for the intake agent: `extractEpubToBundle` shares this one reader. Dropping `xml: true` breaks the other direction (EPUB3's text-valued `<meta property="belongs-to-collection">`, see gotcha 29).
35. **`htmlToPlainText` is paragraph-preserving — the intake agent judges books by its output.** A real chapter is ONE wrapping `<div>` around many `<p>`, so walking only the top-level children glued every paragraph into a single run-on line (`<p>a</p><p>b</p>` came back as "ab"). It now walks block elements, folds inline markup into the sentence it belongs to, and turns `<br>` into a break. Keep that behavior if you touch it: the samples the agent reads to decide language, order, and what is an art book come from here (the pipeline's own converter is `xhtmlToMarkdown`, which already preserved paragraphs).
36. **The output-token cap is derived from the context window — do not set them equal.** Observed live with `AI_MAX_TOKENS=262144` against a model whose `n_ctx` is also 262144: every agent call was rejected before it started — `prompt (4337 tokens) + max tokens (262144) exceeds the context; requests are never truncated` — so no agent stage (intake included) could run at all, and the failure looks like a model problem, not a settings problem. `AI_CONTEXT_WINDOW` is now the single number and the output cap defaults to a quarter of it, which makes that combination unreachable by construction. Set `AI_MAX_TOKENS` only when you genuinely need a different cap, and keep a margin between it and the context.

## 11. Conventions

- **JSDoc on every function** (params + returns), with provenance comments where a behavior exists because of a live incident ("observed live: …"). New code without JSDoc is a review blocker. Use named types from `types.js` (e.g. `{GlossaryVolumeCtx}` instead of `{Object}`) — the type annotations enable IDE cross-references across files.
- **Update AGENTS.md after changes.** If your work adds, removes, or significantly modifies files, functions, or conventions, update this document to reflect the new state. Agents reading AGENTS.md should be able to rely on it as a current map of the codebase — not a stale one.
- Errors **fail loudly** with actionable messages (pointing at files, `.env` keys, or `.logs/`).
- Prompt files stay mode-agnostic; mode-specific text is appended in code (`AGENT_TOOLS_NOTE`), never forked into separate prompt files.
- Tests: pure logic in `test/test-glossary-load.js` (incl. the acceptance reply parsing), `test/test-config.js` (the consolidated env knobs — `PASSING_SCORE`, `STAGE_CONCURRENCY`, `JUDGE_TEMPERATURE`, `STAGE_THINKING_LEVEL`, `SERIES_ARTIFACTS_DIR`, `AI_CONTEXT_WINDOW` + the derived output cap — each checked under BOTH its new name and its legacy name), `test/test-translate.js` (translation-stage helpers, incl. the polish guard-findings builder), `test/test-hooks.js` (hook runner), `test/test-intake.js` (epub reading layer, epub tools + staging safety + the intake file-tool gate at `.epub`, manifest helpers incl. the source-inside-its-folder rule and duplicate-book detection, settings precedence, committed-layout protection, confidence gate, dry-run preview + deterministic layout — epub fixtures are built with `jszip`), and `test/test-qa-orchestration.js` (offline QA-loop orchestration with a stubbed harness) — all plain `assert`, no framework (keep it that way); live behavior in `test/harness-smoke.js`.
- Dependencies: AI SDK v6 + `@openharness/core` v0.7 + `jszip`/`cheerio` (epub extraction in `utils/source.js`); keep CommonJS, no new frameworks.

## 12. Communication

When communicating with the user, you should assume that the user is intelegent but not knowledgeable. Keep the following points in mind as you produce your final answer.
- Avoid using advanced jargon and specialized terminolgy where possible.
- Just because a term or jargon is used in the code doesn't mean the user udnerstands the meaning of those words.
- Ask yourself "Would a general audiance software engineering influencer/educator use these terms?" If not, then you should probably avoid the use of the jargon in question.
- Ask yourself "How likely would a term appear in a PhD research paper?" If the odds are high, it's probably best to avoid using the jargon in question.
- When you are producing your final answer, instead of using specialized jargon, you can use analogies or metaphors instead.
- When analogies or metaphors fail, psuedo code can be used as a last resort.

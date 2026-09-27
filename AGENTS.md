# AGENTS.md — ai-client

**Read this first.** This is the entry point for AI agents working in this project. The codebase is small (~12k lines across 9 task modules + harness.js + utils/) and the JSDoc in each file is excellent — this doc is the map plus the hard-won gotchas; open the referenced file when you need depth.

## 1. What this is

An agentic AI client (v2.0.0, CommonJS, Node ≥ 22.19) that processes a light-novel series **volume by volume** and produces translation-support artifacts:

- `glossary` task → a canonical target-language glossary (per-volume snapshots + a final copy at the series root)
- `character-voice` task → a cumulative character voice reference (speech quirks, POV markers, narration types) and per-volume POV maps
- `style-guide` task → a cumulative style guide (house-style policies for rendering source-language constructs in the target language)
- `jump-in-wiki` task → a per-volume `wiki.md` plus a "living" `shared-wiki.md` (newest copy at the series root)
- `consistency-audit` task → a final cross-artifact audit (`consistency-report.md`, PASS/FAIL sign-off before translation)
- **translation stage** (`translate` → `verify-translate` → `retranslate` → `verify-translate` → `polish`) → the actual translation of every volume, per chapter, by a **multi-model chain** (Hy-MT2 translates, Qwen verifies, Hy-MT2 retranslates the failures, Qwen re-verifies, Qwen polishes) — see §8.5
- plus deterministic translation-handoff artifacts per volume: `chapters.json` + `translation-brief.md` (and the persisted extraction JSONs / glossary coverage report)

It talks to any **OpenAI-compatible endpoint** through the Vercel AI SDK + `@openharness/core`. Tool-calling agents read the sources and write the outputs themselves through sandboxed file tools.

### Quickstart

| Command | What it does |
|---|---|
| `npx gulp glossary` | Run the glossary task (all volumes) |
| `npx gulp character-voice` | Run the character voice reference task (all volumes) |
| `npx gulp style-guide` | Run the style guide task (all volumes) |
| `npx gulp jump-in-wiki` | Run the wiki task |
| `npx gulp consistency-audit` | Run the final cross-artifact consistency audit (writes `consistency-report.md`) |
| `npx gulp translate` | Translate all volumes, per chapter (Hy-MT2 endpoint; `TRANSLATE_*` env) |
| `npx gulp verify-translate` | Source-anchored verification of the drafts, per chapter (Qwen endpoint; `VERIFY_*` env). FAILs are fixed by `retranslate`. Default-ON — `VERIFY_TRANSLATE_ENABLED=false` makes it (and `retranslate`) a no-op |
| `npx gulp retranslate` | Retranslate the chapters that FAILED verification (Hy-MT2, findings injected as correction tasks; the bad draft is not fed back) |
| `npx gulp polish` | Final Qwen polish pass per chapter (with a deterministic regression guard that rejects a polish worse than the draft) |
| `npx gulp` (default) | All ten in order: glossary → character-voice → style-guide → jump-in-wiki → consistency-audit → translate → verify-translate → retranslate → verify-translate → polish |
| `... --dry-run` | No AI calls; dump the exact prompts to `.dry-run/<task>-NN.md` |
| `... --force` | Regenerate even if outputs already exist |
| `... --volume NN` | Process a single volume (e.g. `--volume 01`) |
| `... --chunked` | Force the chapter-by-chapter fallback for multi-chapter epub volumes (the default is whole-installment processing; the fallback also triggers automatically when the whole text exceeds `SOURCE_CHUNK_THRESHOLD_CHARS`) |
| `npm test` | Pure-function tests (no AI, no network) |
| `npm run smoke` | Live smoke test against the `.env` endpoint (`one-shot` / `research` / `fs` arg selects one check) |
| `npm start` | Ad-hoc harness CLI: `node harness.js --system "..." --text "..." [--file f --name n]` |

## 2. File map

| Path | Role |
|---|---|
| `configs/shared.js` | Shared constants extracted from task modules (`AGENT_TOOLS_NOTE`) and score-based acceptance config (`ACCEPTANCE_WINDOW_SIZE`, `ACCEPTANCE_MIN_SAMPLES`, `ACCEPTANCE_PASSING_SCORE`, `ACCEPTANCE_STRATEGY`, `ACCEPTANCE_BEST_MIN_PASSES`, `computeRollingAverage`, `meetsAcceptanceCriteria`, `isAcceptedState`). All nine task modules import from here. Also provides `saveRollingState` / `loadRollingState` for persisting the rolling window of scores to disk (the state file also carries the run's `sourceFingerprint` — see §3 "Source-staleness detection") and `isSourceStale(state, bundle)` (fail-open when either side lacks a fingerprint). Also provides `RESEARCH_CONCURRENCY` — the number of parallel research agents (one per glossary term, batched). Also provides the un-monitored run policies (`normalizePolicy`, `ON_VOLUME_ERROR`, `ON_MISSING_PREVIOUS`, `ON_QA_LIMIT`) and `validateRequiredEnv({ dryRun })` — the fail-fast check for missing required env vars (see §3 "Un-monitored run policies"). |
| `utils/fs.js` | Filesystem helpers: `fileExists`, `assertWrote`. |
| `utils/prompt.js` | Prompt/verdict helpers: `transformUserPrompt`, `isPassingVerdict` (legacy binary verdict — kept for compatibility, no longer used in the acceptance path), `parseAcceptanceScore` (parses the 0–100 score from the acceptance one-shot reply; `null` = unparseable = failed check), `validatorMaxStepsFor`, `writePromptDump`. |
| `utils/manifest.js` | JSON/manifest helpers: `extractJsonObject`, `installmentNumberFromDir`. |
| `utils/source.js` | Source-bundle helpers: `resolveSourceBundle` (normalizes a volume's source into a `SourceBundle`; plain-text passes through as-is, `.epub` is extracted once and cached; every bundle carries a `sourceFingerprint` — `sha256OfFile(originalPath)` for plain text, the cache `sha256` for epub — used by the source-staleness detection, see §3), `shouldProcessChunked` (decides whole-installment vs chapter-by-chapter fallback), `extractEpubToBundle` (jszip + cheerio; XHTML → Markdown, per-chapter files, interludes, epilogue, images), `assignSegmentIds`, `classifyTitle`, `xhtmlToMarkdown`, `sourceMaterialLine`, `sourceSegmentListLine`, `chapterSegmentNote`, `chapterContextBlock`, `isEpubPath`, `normalizeZipPath`, `sha256OfFile`. All nine task modules resolve their source through `resolveSourceBundle` at the choke point. |
| `utils/handoff.js` | Deterministic per-volume translation handoff (no AI): `buildChaptersJson` (chapter list from the bundle segments), `renderNewEntry`, `buildTranslationBriefMarkdown` (pure — the one-page brief: new terms/voices/style rules from the persisted extraction JSONs, chapter table, pointers to every per-volume + series-level reference artifact), `writeVolumeHandoff` (best-effort writer of `chapters.json` + `translation-brief.md`; called from jump-in-wiki.js on both the processed and skipped paths — a failure warns, never fails a volume). |
| `utils/hooks.js` | Per-machine pipeline-hook runner (git-style, entirely optional). Discovers `hooks/pre-<task>` / `post-<task>` (and `pre-/post-pipeline`) and `exec`s each as an executable with `AI_CLIENT_*` env vars; skips when the file is absent, under `--dry-run`, or not executable. Applied via `withHooks()` in gulpfile.js. See §3 "Pipeline hooks" and `hooks/README.md`. |
| `harness.js` | The AI layer: one-shot calls, agent handles, wiki tools, gated fs tools, provider plumbing, run logging, and the runaway-generation guard (aborts agent turns that produce excessive text without tool calls). Never bypass it to talk to the model. Multi-model support: per-call `endpoint` override (baseUrl/apiKey/model, falling back to `AI_*`), per-call `temperature` + sampling params (`topP/topK/minP/repetitionPenalty/presencePenalty`), the `hy-mt` thinking dialect (`no_think|low|high` → `reasoning_effort`), nullable `systemPrompt` (Hy-MT2's single-user-message contract), and `assertModelServing()` — a `GET /v1/models` control-plane check that fails loudly before a stage's first call. Logs every AI call to `.logs/<timestamp>/` — per-agent chat histories (system prompt, messages, assistant response, reasoning, tool calls) and one-shot call dumps — plus the summary log (greppable `CALL`/`RESULT`/`WARNING` lines). |
| `research.js` | Client-side web research (Wikipedia Action API + optional Brave/Tavily/Serper). No LLM involved. |
| `glossary.js` | Glossary task logic. |
| `character-voice.js` | Character voice reference task logic — extracts speech quirks, POV markers, narration types, and produces a cumulative character voice reference and per-volume POV maps. |
| `style-guide.js` | Style guide task logic — extracts style-relevant constructs (honorifics, pronouns, particles, internal-monologue markers, onomatopoeia, POV/scene markers, tense, punctuation, wordplay) and produces a cumulative style guide of rendering policies for the target language. |
| `jump-in-wiki.js` | Wiki task logic **plus the shared helpers**. After all volumes: the last existing `shared-wiki.md` is copied to `SHARED_WIKI_OUTPUT_FILE` (default `<SERIES_LOCATION>/shared-wiki.md`); writes the per-volume translation handoff (`utils/handoff.js`) on both paths. |
| `consistency-audit.js` | Final cross-artifact consistency audit (the pre-translation sign-off). An audit agent (gated fs tools, cwd = series root, writes confined to the root) reads the four series-root artifacts (`glossary.md`, `character-voice.md`, `style-guide.md`, `shared-wiki.md`) and writes `consistency-report.md` (PASS/FAIL verdict + severity-banded findings with quoted snippets). No QA loop. Idempotent: the report is skipped while it is newer than all four artifacts (`--force` re-audits). A FAIL verdict is logged loudly but does not fail the task — the report is the deliverable. |
| `translate.js` | Translation task (first stage of the multi-model chain; §8.5). Per volume, per chapter (in `bundle.segments` order): skip when the draft + `translation-state.json` cover the current source/reference hashes, split oversized chapters (`TRANSLATE_CHUNK_CHARS`), translate each part via `runOneShot` on the `TRANSLATE_*` endpoint — **no system prompt** (Hy-MT2's single-user-message contract), official sampling, `no_think` by default — with the previous part's ending as continuity context, deterministic QA (`checkTranslationQa`), per-chapter state persistence, and the merged `translation.md` + `translation-qa.md`. Also exports `chapterArtifactNames` / `mergeVolumeTranslationFiles` shared by the other three tasks. |
| `verify-translate.js` | Verification task (§8.5). Per chapter with a draft: one-shot source-anchored check on the `VERIFY_*` endpoint (Qwen) → 0–100 score (fail-closed: unparseable = FAIL) + severity-banded findings → `translation-verification.json` sidecar + `translation-verification.md` report. PASS = score ≥ `VERIFY_PASSING_SCORE` (default 70). `VERIFY_TRANSLATE_ENABLED=false` makes it a no-op. Exports `loadVerificationSidecar` (read by retranslate) and `glossaryBlock` (read by polish). |
| `retranslate.js` | Correction task (§8.5). Per chapter that FAILED verification (and whose sidecar entry still covers the current source + draft): a fresh Hy-MT2 pass with the verification findings injected as a numbered "fix these" task in the official prompt — the bad draft is **deliberately not** fed back (re-reading a bad translation anchors the model to its errors). Same part-by-part splitting as `translate` (the findings are injected into every part). Overwrites the draft, updates the state (invalidating any earlier polish), re-merges `translation.md`. Runs only when verification is enabled. |
| `polish.js` | Final pass (§8.5). Per chapter: one-shot polish on the `EDIT_*` endpoint (Qwen, thinking on) → **deterministic regression guard**: if the polished text fails the QA the draft passed, or loses glossary coverage the draft had, the polish is rejected and the draft kept (chapter left unpolished, retried next run). Writes `polished-<id>.md`, records `polishedDraftHash` in the state, re-merges `translation.md` (polished text wins). |
| `utils/translate.js` | Pure translation-stage helpers shared by the four tasks: `splitChapter`, `parseGlossaryTerms`, `extractStyleRules`, `buildTranslationTaskLines` / `buildTranslationPrompt` (the official Hy-MT2 single-user-message shape), `cjkRatio`, `countOccurrences`, `checkTranslationQa` (hard fails: empty draft, CJK ratio > 5%; warnings: CJK > 0.5%, length ratio outside 0.6–2.5, missing glossary renderings), `mergeVolumeTranslation`, `stripMarkdownFence`, `tailOf`, `loadTranslationState` / `saveTranslationState` (fail-open), `roleEndpoint` (`<PREFIX>_BASE_URL`/`_API_KEY`/`_MODEL` with `AI_*` fallback), `loadVolumeReferences` (glossary terms, style rules, wiki + POV-map background, voice notes, and the `contextHash` idempotency key). |
| `get-translation-target.js` | AI-driven translation-target discovery: a tool-calling agent lists the series directory, identifies which entries are volume folders, opens candidate files to confirm the actual source text (ignoring generated artifacts and images), and writes `<SERIES_LOCATION>/translation-target.json`. All nine tasks read this manifest instead of guessing folder names. |
| `translation-target.json` | Generated manifest (see `get-translation-target.js`); lists each volume's folder, source file, installment number, and metadata. All nine tasks read it to resolve folders and source files. The live series dir always comes from `SERIES_LOCATION` (env), not from the manifest's `seriesLocation` field (provenance metadata — see gotcha 11). |
| `types.js` | JSDoc type definitions shared across modules. Defines named typedefs (`TranslationTargetManifest`, `GlossaryVolumeCtx`, `WikiVolumeCtx`, `CharacterVoiceVolumeCtx`, `StyleGuideVolumeCtx`, `IMessage`, `RunOneShotCfg`, `CreateAgentHandleCfg`, `AgentHandle`, `Taps`, `FetchResult`, `WikiTools`, `ResearchNote`, `HookContext`) that replace generic `{Object}` annotations in `@param`/`@returns` tags. Imported via `require("./types")` in every core module for IDE cross-reference resolution. Pure JSDoc — zero runtime side effects. |
| `gulpfile.js` | Task wiring plus the `ON_TASK_ERROR`-aware `runPipeline()` runner for the default all-ten run (see §3 "Un-monitored run policies"). |
| `hooks/` | Per-machine hook scripts (git-style; gitignored — only `README.md` + `*.sample` are tracked). Executable before/after hooks for each step and the whole run. See §3 "Pipeline hooks". |
| `system-prompts/`, `user-prompts/` | Per-stage prompt pairs. Glossary: `glossary-terms`, `glossary` (amend), `glossary-validator`, `glossary-acceptance`, `glossary-feedback`. Character voice: `character-voice-extract`, `character-voice` (compile), `character-voice-validator`, `character-voice-acceptance`, `character-voice-feedback`. Style guide: `style-guide-extract`, `style-guide` (compile), `style-guide-validator`, `style-guide-acceptance`, `style-guide-feedback`. Wiki: `jump-in-wiki`, `-validator`, `-acceptance`, `-feedback`. Consistency audit: `consistency-audit`. Translation stage: `translate` (user only — the official Hy-MT2 single-user-message prompt, **no system prompt file**), `verify-translate` (system + user — source-anchored 0–100 scoring rubric), `polish` (system + user — final proofreading pass). |
| `test/test-glossary-load.js` | Pure tests (`npm test`). |
| `test/test-translate.js` | Pure tests for the translation-stage helpers (`utils/translate.js`): `splitChapter`, `parseGlossaryTerms`, `extractStyleRules`, `checkTranslationQa`, `mergeVolumeTranslation`, `stripMarkdownFence`, `tailOf`, `roleEndpoint`. |
| `test/test-hooks.js` | Pure tests for the hook runner (`utils/hooks.js`), including the `TASKS` list (all nine tasks + pipeline). |
| `test/harness-smoke.js` | Live smoke test (`npm run smoke`). |
| `test-series/` | Fixture series (`test_story(1)`, `test_story(2)`); generated outputs are gitignored. |
| `.env` / `.env.example` | Configuration (see §8). |
| `.logs/` | One run log per process: `call-ai-<timestamp>.log`. |
| `.dry-run/` | Prompt dumps from `--dry-run`. |

Prompt files are agent-mode: the system prompt is appended with `AGENT_TOOLS_NOTE` to instruct the agent about file tools.

## 3. Architecture

### harness.js primitives (the only way to talk to the model)

- **`runOneShot({ systemPrompt, messages, ... })`** — one tool-less call. `messages` are `{ text }` or `{ file, name }` (images/wav/mp3 become binary parts; undetectable types are inlined as text). Streaming with a non-streaming fallback; retries empty/error responses up to `AI_RETRY`; **throws on empty — it never returns `""`** (workflows persist the returned string verbatim, so an empty result must fail the run instead of corrupting an artifact).
- **`createAgentHandle({ name, systemPrompt, tools, approve, cwd, maxSteps, ... })`** — a tool-using agent backed by an OpenHarness `Session`: context auto-compaction at `AGENT_CONTEXT_WINDOW` tokens and retry-with-backoff. `sendTurn()` keeps message history across turns (author sessions reuse one session for generation + all feedback passes). For writing agents an empty final chat reply is *success* (the output went to disk) — no empty-retry there.
- **`createWikiTools()`** — `wiki_search(query, lang?)` / `wiki_extract(title, lang)` backed by research.js.
- **`createGatedFsTools({ cwd, allowedDirs })`** — OpenHarness fs tools (readFile/listFiles/grep/writeFile/editFile/deleteFile) with an **approve gate**: reads always allowed, `writeFile`/`editFile` confined to `allowedDirs` (the volume folder), `deleteFile` always denied. This is the sandbox — do not weaken it.

### Provider plumbing (local-LLM friendly)

- ESM bridge: `@openharness/core` + `@ai-sdk/openai` ship ESM-only builds; loaded lazily via `loadEsm()` (this project is CommonJS).
- Custom fetch built on **undici's own `fetch` + a no-timeout `Agent` from the same undici build** (all timeouts disabled — local servers can prefill for minutes); never mix the Agent with Node's *global* fetch — that crosses undici versions and throws `invalid onRequestStart method` on some Node builds (gotcha 19); merges thinking params into the request body (`chat_template_kwargs` for Qwen3-style models, `reasoning_effort` for levels); taps SSE/JSON responses for `reasoning_content` + first-token timing diagnostics.
- Every call logs to stderr **and** `.logs/call-ai-<timestamp>.log` (CALL/RESULT lines: finish reason, content/reasoning sizes, token usage, TTFT, tok/s). Workflow logging goes through `harness.logLine`.

### Shared workflow shape (all four volume tasks)

1. Discover volume folders and source files via the translation-target manifest (`getTranslationTarget()`). An AI agent lists the series directory, identifies which entries are volume folders, opens candidate files to confirm the actual source text (ignoring generated artifacts and images), and writes the result to `<SERIES_LOCATION>/translation-target.json`. With `--dry-run` a deterministic fallback (the legacy convention) builds the manifest instead, so prompt previews stay fully offline.
2. Fill `{{PLACEHOLDER}}`s in the user-prompt templates (`transformUserPrompt` — **strict**: throws on a missing value or any leftover placeholder).
3. **QA loop** per volume, up to `QA_MAX_ITERATIONS`: score-based
   acceptance — the acceptance one-shot check (tool-less) scores the audited
   output **0–100** (100 = perfect, 0 = atrocious) using a banded rubric in
   the `*-acceptance.md` system prompts (Pass → 85–100, Pass with minor
   edits → 70–84, Requires revision → 40–69, Reject → 0–39). Each score is
   tracked in a rolling window (`ACCEPTANCE_WINDOW_SIZE`, default 5). When the
   window meets the criterion from `meetsAcceptanceCriteria()` (default
   strategy `average`: rolling average of scores ≥ `ACCEPTANCE_PASSING_SCORE`,
   default 70; alternative `best`: at least `ACCEPTANCE_BEST_MIN_PASSES` of the
   scores ≥ the passing score) and we have at least `ACCEPTANCE_MIN_SAMPLES`
   checks (default 3), the output is accepted. An unparseable acceptance
   reply counts as a failed check (fail-closed) and is not stored. Otherwise,
   feedback is applied and the loop continues. A passing output
   is never touched by a feedback pass. **Fresh agent per feedback iteration**
   (no persistent session — each feedback turn starts with a clean context
   that includes the validation report and current glossary).
4. **Idempotency**: a volume whose outputs already exist and pass acceptance is skipped (unless `--force`). The skip-check reads a persisted rolling-window state file (`*-rolling-state.json`) written alongside the validation report during the last run, recomputing the acceptance decision deterministically — no AI call needed. If the state file is missing or corrupt, the check falls back to regenerating (fail-open). A failed skip-check degrades to "not skipped" (fail-open, by design). **Source-staleness detection**: the state file also persists the `sourceFingerprint` of the source file the accepted output was built from (sha256 of the original plain-text file, or the epub extraction cache hash — `bundle.sourceFingerprint` from `utils/source.js`). On re-run, `isSourceStale(state, bundle)` compares the two: a changed source invalidates the skip and the volume regenerates (then the cumulative `regeneratedAny` cascade rebuilds all later volumes). Fail-open: a legacy state file without a fingerprint, or a bundle without one, keeps the current skip behavior — old runs are safe to re-run.

**Un-monitored run policies** (front-loaded in `.env`, see §8): the pipeline is built to run un-monitored overnight / for multiple days, so the decisions that would otherwise need a human are env-driven (code defaults keep the safe "fail loudly" behavior):

- `validateRequiredEnv({ dryRun })` (configs/shared.js) runs at the top of every task and fails fast with a single message naming every missing required variable (`SERIES_LOCATION`, `SERIES_NAME`, and `AI_API_KEY` for live runs) — a misconfigured `.env` is caught at run start, not hours in.
- `ON_VOLUME_ERROR` (`abort` default / `skip`): when a volume's processing throws, the per-volume body of each task is wrapped in a try/catch — `skip` records the volume and continues with the next one (in the cumulative tasks the next volume then misses its previous artifact and is skipped in turn by `ON_MISSING_PREVIOUS=skip`, cascading to the end of the task).
- `ON_MISSING_PREVIOUS` (`abort` default / `skip`): replaces the "process the earlier volume first" throw in the three cumulative tasks with an optional warn-and-skip.
- `ON_QA_LIMIT` (`accept` default / `fail`): when the QA loop hits `QA_MAX_ITERATIONS` without a passing grade — accept the output as-is (legacy) or fail the volume.
- `ON_TASK_ERROR` (`abort` default / `continue`): in the default all-ten run, a failing step either stops the run (gulp `series` behavior) or the remaining steps still run and the run fails at the end with a summary of all failed steps (`runPipeline()` in gulpfile.js).
- `DISCOVERY_MAX_ATTEMPTS` (default 1): the discovery agent is retried with a fresh agent (10 s apart) when it produces an invalid manifest or references missing source files.

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
  (or `.sh` / `.js`) for `glossary`, `character-voice`, `style-guide`,
  `jump-in-wiki`, `consistency-audit`, `translate`, `verify-translate`,
  `retranslate`, `polish`, plus `pre-pipeline` / `post-pipeline` around the
  whole default run. Any executable with a shebang works.
- **Model switching for the translation stage** — the translation stage uses
  two different models, but on local setups the containers share one port, so
  only one can serve at a time. The per-machine pre-hooks for the four
  translation tasks are what start the right container (`model-switch.sh`,
  `hooks/README.md` Example 4 — idempotent, `/health`-polled). The task code
  contains no Docker logic; it only runs a `GET /v1/models` sanity check
  (`harness.assertModelServing`) before its first call.
- **Entirely optional** — no file → the step runs exactly as before (the
  common case); present-but-not-executable → warn + skip. **`--dry-run` runs
  no hooks** (side-effect-free).
- **Failure** — a before-hook non-zero exit **aborts the step**; an after-hook
  runs even when the task failed (so a cleanup / "task failed" notification can
  fire), and a failed after-hook only masks the task error when the task had
  already failed (the task error always propagates).
- **Wiring** — each task is wrapped with `withHooks(task, taskFn)` in
  `gulpfile.js` (the nine task modules are untouched); the default run is
  wrapped as the `pipeline` pseudo-step.


## 4. Pipeline A: glossary (`glossary.js`)

Per volume, in order — each volume's glossary is built on the previous one's:

1. **Extract new terms** — one-shot in both modes: source + previous `glossary.md` → JSON array of `{ term, type, query }`; parsed by `parseTerms` (tolerates markdown fences and surrounding prose).
2. **Research** the new terms:
   - **Parallel agents**: one agent per term, batched to `RESEARCH_CONCURRENCY` (env var, default 3). Each agent targets exactly one unique line in `glossary-research.md` via `editFile`, so there are no conflicts.
   - Skeleton-first: the workflow pre-writes `glossary-research.md` with a `- (pending)` line under every term; each agent replaces its own placeholder. A crashed run still leaves a usable skeleton.
   - `maxSteps = 15` per agent (2 wiki_search + 1 wiki_extract + 1 editFile + overhead).
   - `RESEARCH_CONCURRENCY=1` restores the old sequential behavior.
3. **Amend** the glossary (carry forward every existing term, add the new ones, reconcile conflicts):
   - an **author agent** (standalone — creates and closes its own session) reads the materials with `readFile` and writes `glossary.md` with `writeFile`/`editFile`.
4. **QA loop**: a fresh validator agent per iteration (step cap **scaled to source size**: `max(40, 2·ceil(bytes/32KB) + 24)` — `validatorMaxStepsFor`) writes `glossary-validation.md` → acceptance one-shot → on FAIL a **fresh author agent** per iteration applies the feedback (no persistent session).
5. After all volumes: the **last** volume's `glossary.md` is copied to `GLOSSARY_OUTPUT_FILE` (default `<SERIES_LOCATION>/glossary.md`). Skipped for `--volume` runs (a single volume's snapshot would be stale).

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
5. After all volumes: the **last existing** `<volume folder>/shared-wiki.md` is copied to `SHARED_WIKI_OUTPUT_FILE` (default `<SERIES_LOCATION>/shared-wiki.md`), mirroring the other root copies. Skipped for `--volume` runs (a single volume's snapshot would not be the series state). End-of-run summary counts the volumes that hit the iteration limit.

## 6. Pipeline C: character-voice (`character-voice.js`)

Per volume, in order — each volume's reference builds on the previous one's:

1. **Extract** — one-shot call: source text → JSON array of `{ type, character, quirkType, description, examples, ... }` entries for both voice quirks and POV analysis. Parsed by `parseVoiceQuirks` (tolerates markdown fences and prose).
2. **Compile** — an author agent (per-volume session, `maxSteps 30`) reads the source, previous reference, and extraction results, then writes two files:
   - `character-voice.md` — the cumulative character voice reference (carries forward all previous entries, adds new characters/quirks)
   - `pov-map.md` — the per-volume POV map (marker identification, narration type classification, POV assignments, free indirect discourse detection)
   The agent-mode turn prompts (author/validator/feedback) name every material at its real path — the previous volume's reference at `../<previous folder>/character-voice.md` (same convention as glossary.js) — so agents never have to guess where to read. A missing previous reference fails loudly (dry-run: warn).

3. **QA loop**: a fresh validator agent per iteration writes `character-voice-validation.md` → acceptance one-shot scores the reference 0–100 → unless the rolling window of scores meets the criterion, a fresh author agent applies feedback (`character-voice-feedback.md`). Same score-based acceptance criterion as the other pipelines (the state file is saved on every iteration, including the accepting one, so accepted volumes are skipped on re-run).
4. After all volumes: the last volume's `character-voice.md` is copied to `VOICE_OUTPUT_FILE` (default `<SERIES_LOCATION>/character-voice.md`). Skipped for `--volume` runs.

Artifacts per volume folder: `character-voice.md` (cumulative snapshot), `pov-map.md` (per-volume), `character-voice-new.json` (extraction snapshot for the handoff), `character-voice-validation.md` (validation report).

**Cumulative invariant:** same as glossary — regenerating any volume sets `regeneratedAny` → all later volumes are regenerated too.

**Key differences from glossary:** no research stage (quirks are text-intrinsic); produces two files instead of one; extraction and compilation are separate stages.

## 7. Pipeline D: style-guide (`style-guide.js`)

The 4th pipeline step — the "how do I write it" policy layer. The glossary says *what to call things*, character-voice says *how characters sound*, the wiki says *what is happening*; the style guide says *how source-language constructs are rendered in the target language* (honorifics, pronouns, sentence-ending particles, internal-monologue markers, onomatopoeia, interjections, POV/scene markers, tense, punctuation, wordplay, translator notes).

Per volume, in order — each volume's guide builds on the previous one's:

1. **Extract** — one-shot call: source text + previous `style-guide.md` → JSON array of `{ category, pattern, description, examples, frequency, notes }` entries (categories: `honorific`, `pronoun`, `particle`, `internalMonologue`, `onomatopoeia`, `interjection`, `povMarker`, `sceneBreak`, `tense`, `punctuation`, `wordplay`, `note`, `other`). Parsed by `parseStyleObservations` (tolerates markdown fences and prose).
2. **Compile** — an author agent (per-volume session, `maxSteps 30`) reads the source, the previous guide (at `../<previous folder>/style-guide.md` — same convention as the other tasks), and the extraction results, plus optional cross-references (the same volume's `glossary.md` / `character-voice.md` snapshots, read if present), then writes the cumulative `style-guide.md`. The guide is written in the **target language** (it is instructions for writing the translation), quoting source-language patterns inline.
3. **QA loop**: a fresh validator agent per iteration writes `style-guide-validation.md` (size-scaled step cap) → acceptance one-shot scores the guide 0–100 → unless the rolling window of scores meets the criterion, a fresh author agent applies the feedback (`style-guide-feedback.md`). Same score-based acceptance as the other pipelines (the state file is saved on every iteration, including the accepting one, so accepted volumes are skipped on re-run).
4. After all volumes: the last volume's `style-guide.md` is copied to `STYLE_OUTPUT_FILE` (default `<SERIES_LOCATION>/style-guide.md`). Skipped for `--volume` runs.

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
iteratively-built artifact). **Idempotency**: the report is skipped while it
is newer than all four artifacts (mtime check, no AI); regenerating any
artifact invalidates it. `--force` re-audits. A missing artifact fails loudly
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
chapters + interludes) and uses **two different models** through role
endpoints:

| Step | Task | Model (env) | What it does |
|---|---|---|---|
| 1 | `translate` | Hy-MT2-30B-A3B (`TRANSLATE_*`) | Fresh translation per chapter, official single-user-message prompt (no system prompt), official sampling (temp 0.7 / top_p 1.0 / top_k -1 / rep-pen 1.0), `no_think` by default |
| 2 | `verify-translate` | Qwen3.8-27B (`VERIFY_*`) | Source-anchored 0–100 score + severity-banded findings per chapter (against source + glossary + style rules + **story background** — shared wiki / volume wiki / POV map; the source outranks the wiki, wiki-only findings cap at MEDIUM); PASS ≥ `VERIFY_PASSING_SCORE` (70); unparseable = FAIL (fail-closed) |
| 3 | `retranslate` | Hy-MT2 (`TRANSLATE_*`) | Fresh pass over every FAIL chapter — the findings are injected as a numbered "fix these" task; the bad draft is **not** fed back |
| 4 | `verify-translate` | Qwen (`VERIFY_*`) | Re-runs automatically; only re-checks chapters whose draft changed (idempotent skips for the rest) |
| 5 | `polish` | Qwen (`EDIT_*`) | Final proofreading pass (thinking on) with a deterministic regression guard |

**Design notes:**

- **No QA loop in the translation stage.** Each step is a one-shot call per
  chapter with deterministic (no-AI) gates — the multi-model chain *is* the
  quality control (a different model grades the work). `verify-translate` is
  default-ON; `VERIFY_TRANSLATE_ENABLED=false` disables it **and**
  `retranslate` (they are one QA chain) — the pipeline degrades to
  translate → polish.
- **Per-chapter idempotency via `translation-state.json`** (per volume
  folder, fail-open like the rolling-state files): each chapter entry carries
  `sourceHash` (the chapter's source text), `contextHash` (sha256 of glossary
  + style rules + shared-wiki/volume-wiki/POV background — regenerating any
  reference invalidates every draft), `draftHash`, `retranslated`,
  `findingsHash`, and
  `polishedDraftHash`. A changed source, a re-run of the glossary/style/wiki
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
  cannot fail a correct translation). `polish` deliberately gets no
  background (its role is surface cleanup of already-verified text).
- **Chapter splitting** — a chapter longer than `TRANSLATE_CHUNK_CHARS`
  (default 24000) is split by `splitChapter` (paragraph-aware) and the parts
  are translated in order — both in `translate` and in `retranslate`; each
  part after the first receives the previous part's ending
  (`TRANSLATE_CONTINUITY_CHARS`, default 400, `0` = off) as continuity
  context. The parts are concatenated back into the single draft.
- **Deterministic QA** (`checkTranslationQa`, per draft): hard fails —
  empty draft, CJK ratio > 5% (the model echoed the source); warnings —
  CJK > 0.5%, length ratio outside 0.6–2.5, glossary terms present in the
  source whose canonical rendering is absent from the draft. Per-volume
  reports: `translation-qa.md` (translate), `translation-verification.md`
  (+ `translation-verification.json` sidecar), `polish-qa.md` (polish).
- **Polish regression guard** — the polished text is only accepted when it
  passes the QA the draft passed **and** keeps the draft's glossary coverage;
  otherwise it is rejected, the draft is kept, and the chapter is left
  unpolished (retried on the next run).
- **Merge** — after every step, `mergeVolumeTranslationFiles` rewrites the
  volume's `translation.md` from the per-chapter files: the
  `polished-<id>.md` text wins when the state shows it was produced from the
  CURRENT draft (`polishedDraftHash === draftHash`), otherwise the draft.
- **Endpoint sanity check** — every task calls `harness.assertModelServing`
  (`GET /v1/models`) before its first call and fails loudly when nothing is
  serving or the model id is missing. The task code contains **zero Docker
  logic** — on local multi-model setups the per-machine pre-hooks switch the
  containers (see §3 "Pipeline hooks" and `hooks/README.md` Example 4).

**Artifacts per volume folder:** `translation-<id>.md` (draft per chapter),
`polished-<id>.md` (when the polish pass was accepted), `translation.md`
(the merged volume), `translation-qa.md`, `translation-verification.json` +
`translation-verification.md`, `polish-qa.md`, `translation-state.json`.
All gitignored (generated output).

## 9. Environment reference (`.env`)

### AI provider (`AI_*`)

| Var | Default | Meaning |
|---|---|---|
| `AI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `AI_API_KEY` | — (required) | Auth |
| `AI_MODEL` | `gpt-4o-mini` | Model id |
| `AI_MAX_TOKENS` | `1024` | Max output tokens per call |
| `AI_TEMPERATURE` | `0.7` | Sampling temperature |
| `AI_RETRY` | `0` | Retries per AI call (API errors + empty responses) |
| `AI_THINKING` | on | Qwen3 thinking phase — **enabled by default**. See §9. |
| `AI_THINKING_LEVEL` | xhigh | reasoning_effort: "low" / "medium" / "xhigh" (model-dependent). |

### Series (`SERIES_*`)

| Var | Default | Meaning |
|---|---|---|
| `SERIES_NAME` | — (required) | Series name; volume folders must contain it |
| `SERIES_LOCATION` | — (required) | Folder containing the volume folders |

### Translation (`TRANSLATION_*`)

| Var | Default | Meaning |
|---|---|---|
| `TRANSLATION_SOURCE_LANGUAGE` | Japanese | Source language — fills `{{SOURCE_LANGUAGE}}` in the prompts |
| `TRANSLATION_TARGET_LANGUAGE` | English | Target language — fills `{{TARGET_LANGUAGE}}` in the prompts |

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
| `VERIFY_TRANSLATE_ENABLED` | `true` | `false` disables `verify-translate` **and** `retranslate` (one QA chain) — the pipeline degrades to translate → polish |
| `VERIFY_PASSING_SCORE` | `70` | Score (0–100) at or above which a chapter passes verification |
| `VERIFY_BASE_URL` / `VERIFY_API_KEY` / `VERIFY_MODEL` | `AI_*` | Endpoint for `verify-translate` (Qwen) |
| `VERIFY_TEMPERATURE` | `0.2` | Verification sampling temperature |
| `VERIFY_THINKING` / `VERIFY_THINKING_LEVEL` | `true` / `medium` | Qwen3-style thinking for the verification pass |
| `EDIT_BASE_URL` / `EDIT_API_KEY` / `EDIT_MODEL` | `AI_*` | Endpoint for `polish` (Qwen) |
| `EDIT_TEMPERATURE` | `0.6` | Polish sampling temperature |
| `EDIT_THINKING` / `EDIT_THINKING_LEVEL` | `true` / `medium` | Qwen3-style thinking for the polish pass (it runs last — it benefits from deliberation) |

### Source bundle (`SOURCE_*`)

| Var | Default | Meaning |
|---|---|---|
| `SOURCE_CHUNK_THRESHOLD_CHARS` | `120000` | Whole-installment char count above which the chapter-by-chapter fallback activates automatically (see §3 "Source bundle & chapter-by-chapter fallback"). `--chunked` forces it for any multi-chapter epub. |

### Agents (`AGENT_*`)

| Var | Default | Meaning |
|---|---|---|
| `AGENT_CONTEXT_WINDOW` | `128000` | Tokens at which agent sessions auto-compact |
| `AGENT_MAX_STEPS` | `20` | Default step cap for tool agents (workflows pass higher caps where needed) |
| `AGENT_TEXT_GUARD_CHARS` | `30000` | Runaway-generation guard: abort an agent turn when it produces more than this many chars of text with fewer than 3 tool calls. Catches models that emit malformed tool-call text instead of using the tool-calling API. |
| `AGENT_RECOVERY_ENABLED` | `true` | Recovery turn when an author agent replies in chat instead of `writeFile` — asks it to write the file with the content it already generated |

### QA loop & acceptance (`QA_*`, `ACCEPTANCE_*`)

| Var | Default | Meaning |
|---|---|---|
| `QA_MAX_ITERATIONS` | `10` | QA-loop cap per volume (increased to allow rolling average to converge) |
| `ACCEPTANCE_WINDOW_SIZE` | `5` | Number of recent acceptance checks in the rolling window |
| `ACCEPTANCE_MIN_SAMPLES` | `3` | Minimum checks before the criterion can trigger acceptance |
| `ACCEPTANCE_PASSING_SCORE` | `70` | Passing score (0–100) for the score-based acceptance criterion — the rubric boundary between "Pass with minor edits" (70–84) and "Requires revision" (40–69) |
| `ACCEPTANCE_STRATEGY` | `average` | How the window is evaluated: `average` (mean of scores ≥ passing score) or `best` (≥ `ACCEPTANCE_BEST_MIN_PASSES` scores ≥ passing score) |
| `ACCEPTANCE_BEST_MIN_PASSES` | `3` | For `ACCEPTANCE_STRATEGY=best`: minimum scores ≥ passing score needed ("best 3 of 5" with the default window) |

### Un-monitored run policies (`ON_*`, `DISCOVERY_*`)

Front-loaded decisions so a long run never halts waiting for a human (code
defaults are the safe "fail loudly" behavior; the committed `.env` sets the
un-monitored values). Skipped work is picked up on a cheap idempotent re-run.

| Var | Default | Meaning |
|---|---|---|
| `ON_VOLUME_ERROR` | `abort` | When a volume's processing fails: `abort` stops the task; `skip` logs the error and continues with the next volume |
| `ON_MISSING_PREVIOUS` | `abort` | When a cumulative task finds the previous volume's artifact missing: `abort` fails loudly; `skip` warns and skips the volume (later volumes cascade the same way) |
| `ON_QA_LIMIT` | `accept` | When the QA loop hits `QA_MAX_ITERATIONS` without a passing grade: `accept` keeps the output as-is; `fail` treats the volume as failed (then subject to `ON_VOLUME_ERROR`) |
| `ON_TASK_ERROR` | `abort` | Default all-ten run: `abort` stops at the first failing step; `continue` runs the remaining steps, then fails the run with a summary |
| `DISCOVERY_MAX_ATTEMPTS` | `1` | Discovery-agent attempts before failing the task (fresh agent each attempt, 10 s apart; per-attempt endpoint retries still apply via `AI_RETRY`) |

### Output locations (`*_OUTPUT_FILE`)

| Var | Default | Meaning |
|---|---|---|
| `GLOSSARY_OUTPUT_FILE` | `<SERIES_LOCATION>/glossary.md` | Final glossary location |
| `VOICE_OUTPUT_FILE` | `<SERIES_LOCATION>/character-voice.md` | Final character voice reference location |
| `STYLE_OUTPUT_FILE` | `<SERIES_LOCATION>/style-guide.md` | Final style guide location |
| `SHARED_WIKI_OUTPUT_FILE` | `<SERIES_LOCATION>/shared-wiki.md` | Where the newest per-volume `shared-wiki.md` is copied after the jump-in-wiki task (the series-level living wiki) |

### Research (`RESEARCH_*`, `WIKI_*`, `SEARCH_*`)

| Var | Default | Meaning |
|---|---|---|
| `RESEARCH_ENABLED` | `true` | Research new glossary terms |
| `RESEARCH_CONCURRENCY` | `3` | Number of parallel research agents (one per term, batched). Set to `1` for sequential processing. |
| `RESEARCH_MAX_RESULTS` / `RESEARCH_EXTRACT_CHARS` | `3` / `800` | Research result size |
| `RESEARCH_DELAY_MS` / `RESEARCH_TIMEOUT_MS` | `300` / `30000` | Politeness delay / per-request timeout |
| `WIKI_LANGS` | `ja,en` | Wikipedia languages to query |
| `WIKI_USER_AGENT` | built-in | Descriptive UA (Wikipedia requires one) |
| `SEARCH_API` / `SEARCH_API_KEY` | off | Optional brave / tavily / serper backend |

**Current local setup** (the committed `.env`): local Qwen at `AI_BASE_URL=http://localhost:9200/v1` with `AI_MODEL=local`, `AI_MAX_TOKENS=262144`, `AI_TEMPERATURE=0.6`, `AI_RETRY=2`, `AGENT_CONTEXT_WINDOW=262144`, `QA_MAX_ITERATIONS=5`, `ACCEPTANCE_WINDOW_SIZE=5`, `ACCEPTANCE_MIN_SAMPLES=3`, `ACCEPTANCE_PASSING_SCORE=69`, `ACCEPTANCE_STRATEGY=average`, `AGENT_TEXT_GUARD_CHARS=30000`, thinking on at `xhigh` (defaults), series = `test-series` (the `test_story` fixture), JP→EN. The translation stage is configured for the local two-model setup: all three role endpoints (`TRANSLATE_*` / `VERIFY_*` / `EDIT_*`) point at the same `http://localhost:9200/v1` with `MODEL=local` — the per-machine hooks (`hooks/pre-translate.sh` → Hy-MT2, `hooks/pre-verify-translate.sh` / `pre-polish.sh` → Qwen, `hooks/pre-retranslate.sh` → Hy-MT2) switch the container per stage, because every local container advertises the same `local` alias and shares the one port. **It points at the test fixture, not the real 17 volumes** — check this before any "production" run.

## 10. Gotchas (hard-won — read before changing behavior)

1. **`AI_THINKING_LEVEL` tuning is per-series.** Reasoning token burn varies dramatically across series — a series with heavy technical jargon may need "xhigh" while a simpler narrative may run fine on "medium". Start with "xhigh" (the default), monitor `.logs/call-ai-*.log` for reasoning content sizes, and tune down to "medium" or "low" if the reasoning spend is excessive relative to content output. Set `AI_THINKING=false` to disable entirely.
2. **Never let a stage persist empty output.** `runOneShot` throws on empty by design; agent stages are guarded by `assertWrote` (missing/empty file → hard error pointing at `.logs/`). If you add a stage, add both guarantees.
3. **Do not touch the agent-mode prompt safety nets** (the stray-file cleanups): each was added after a live failure (wrong file names, stale strays being audited, marker-format conflicts). The pure tests pin their behavior — run `npm test` after touching any prompt or file name.
4. **Validator step caps scale with source size** (`validatorMaxStepsFor`): a fixed cap of 40 ran out on the 521KB volume-01 source before the validator wrote its report.
5. **The glossary is cumulative** — see the §4 invariant (`regeneratedAny`).
6. **Skip-checks are deterministic** (reads a persisted `*-rolling-state.json` file storing the rolling window of scores, and the run's `sourceFingerprint`). If the state file is missing or uses the legacy boolean format (pre-score-based era), `loadRollingState` returns `null` and the check falls back to regenerating/re-validating the volume once (fail-open) — so pre-existing runs are safe to re-run. State files from before source-staleness detection have no `sourceFingerprint`; `isSourceStale` is fail-open on that (the volume keeps skipping) — the first run after the upgrade re-fingerprints on the next regeneration.
7. **Acceptance parsing is intentionally strict**: `parseAcceptanceScore` only accepts a 0–100 integer (bare, `N/100`, or `N out of 100`); anything else (prose verdicts, >100, no number) is `null` and the check counts as a **failure** (fail-closed — the feedback loop gets another shot). The legacy `isPassingVerdict` is kept exported for compatibility but no longer used in the acceptance path.
8. **The fs write gate confines writes to the volume folder**; reads are allowed anywhere (agents need the previous volume). `deleteFile` is always denied — the *workflow* deletes stale strays, never the agent.
9. **Logging is per-run with full chat histories and real-time streaming:** Each process run creates a directory under `.logs/<ISO-timestamp>/` containing:
   - `summary.log` — greppable `CALL`/`RESULT`/`WARNING` lines (same format as before)
   - `one-shot/<label>.md` — full system prompt, messages, and response for each `runOneShot` call (written after completion)
   - `one-shot/<label>.stream.md` — partial output streamed in real-time as the AI generates text (written during the call)
   - `agent-<name>/turn-<N>.md` — full chat history for each agent turn (system prompt, user input, assistant response, reasoning, tool calls + results) (written after completion)
   - `agent-<name>/turn-<N>.stream.md` — partial output streamed in real-time as the AI generates text (written during the call)
   
   The `.stream.md` files are the key diagnostic tool when AI calls stall or hang — they show what was produced so far even if the call never completes. Log lines still go to stderr and `summary.log`; chat files are written asynchronously after each call completes.
10. This directory is **not a git repository**; `.gitignore` exists for when it becomes one (and documents the ignored outputs: `.logs/`, `.dry-run/`, generated `test-series` files).
11. **The discovery agent's manifest is cached and auto-stale:** `getTranslationTarget()` reuses an existing `translation-target.json` unless `--force` is passed, a listed source file has been deleted, or the cached `seriesLocation` no longer matches `SERIES_LOCATION` (stale → auto-regenerate). The location check matters across machines: a Windows-generated `C:\...` path is *not* absolute on Linux, so every file op silently resolves relative to the CWD (observed live: a migrated Windows manifest was reused on Linux and the character-voice task crashed with ENOENT on `<CWD>/C:\...\test_story(1)/...`). Related: `seriesLocation` is provenance metadata — tasks derive the live series dir from `SERIES_LOCATION` (env), never from the manifest field. With `--dry-run` the AI is never called and the legacy convention is used instead.
12. **Research concurrency (`RESEARCH_CONCURRENCY`):** default 3 parallel agents. Set to 1 to restore the old sequential behavior. Each agent has a fixed `maxSteps=15` — the old global cap (`max(30, 5·terms + 10)`) was replaced by per-agent caps. The skeleton-first approach ensures crash safety: failed terms leave `- (pending)` in place.
13. **Fresh agents per QA feedback iteration:** the author session is no longer persistent across the QA loop. Each feedback pass creates a new agent with a self-contained prompt (validation report + current glossary). This prevents context window bloat but increases per-iteration token cost.
14. **Glossary truncation:** if the previous glossary exceeds 64KB, it is truncated to the last 200 entries before being passed to the author/validator agents. Earlier entries are carried forward unchanged (only conflicts with new terms need checking).
15. **Character voice reference is cumulative:** same `regeneratedAny` invariant as the glossary — if any volume is regenerated, all later volumes are regenerated too. The `character-voice.md` carries forward all previous character entries unchanged.
16. **POV marker conventions:** Japanese LNs use `※`, `☆`, `◇`, `◆`, `【】`, `（）` as POV markers. The extract prompt recognizes these and classifies narration types (first-person-internal, free-indirect, third-person-omniscient, dialogue-only). Free indirect discourse — 3rd-person narration that adopts a character's voice — is the hardest pattern to detect reliably and is the most common validation finding.
17. **Runaway-generation guard (`AGENT_TEXT_GUARD_CHARS`):** the harness aborts an agent turn when it produces more than `AGENT_TEXT_GUARD_CHARS` (default 30,000) characters of text with fewer than 3 tool calls. This catches models that emit malformed tool-call text (e.g. Qwen-native `<tool_call>` tags in the content field) instead of using the API-level `tool_calls` protocol. Observed live: a local Qwen3 model generated 962 KB of repeated `listFiles(path='.'); readFile(...)` text without a single valid tool call, burning tokens for over an hour. The guard aborts the underlying fetch via an `AbortController` signal and throws a descriptive error. The threshold is tunable via the env var; lower it if you see false positives with large legitimate outputs, raise it if you see the guard not triggering fast enough.
18. **Fail-loudly guard for small malformed tool calls (`assertRealToolCalls` in `character-voice.js`):** the 30K runaway guard above only fires on *large* text output. A local Qwen endpoint also intermittently emits *small* malformed tool calls — a few dozen chars of `tool_call` / `<function=…>` text with zero real `tool_calls` — so `npm run smoke fs` can pass while a workflow turn does nothing (no reads, no writes). `character-voice.js` now calls `assertRealToolCalls(result, who, volume)` after every agent `sendTurn` in the compile/validate/feedback stages: when a turn made zero real tool calls but its text contains `tool_call` / `<function=`, it throws a diagnostic error (pointing at `.logs/` and the smoke test) instead of letting `assertWroteWithFallback` pass on a stale file and the acceptance loop burn all iterations. The pure detector `emittedToolCallAsText` is exported and unit-tested. `style-guide.js` ships the identical guard (every agent `sendTurn` in compile/validate/feedback is checked), and `glossary.js` (research/author/validator/feedback/merge turns), `jump-in-wiki.js` (section author, merge, validator, findings-merge, feedback turns) and `consistency-audit.js` (the audit turn) carry the same guard — all five task modules are covered.
19. **Never hand the npm undici Agent to Node's global fetch (`makeProviderFetch` in `harness.js`).** The project's `undici` dependency (v8) is a *different build* from Node's bundled undici (which powers the global `fetch`). Passing `noTimeoutAgent` to the global `fetch` mixes request-handler protocols: on Node builds whose bundled undici is older, the dispatch throws `InvalidArgumentError: invalid onRequestStart method` (`UND_ERR_INVALID_ARG`) before any bytes are sent. This is Node-version-dependent, so identical code + `node_modules` can work on one machine (e.g. Windows Node) and fail on another (Linux Node 22) — observed live right after a Windows→Linux migration. The fix pattern: dispatch through undici's *own* `fetch` (same build as the Agent), and normalize `Headers` instances to plain objects first (undici's webidl converter would silently convert a foreign Headers instance to an empty record, dropping auth/content-type).
20. **Never sort epub bundle segments by filename — iterate `bundle.segments`.** Interlude (and epilogue) files are named `<base>-chN.K.md` where N is the chapter that existed immediately before the segment and K restarts at 1 for each chapter (`ch1.md`, `ch1.1.md`, `ch2.md`, `ch2.1.md`, `ch2.2.md`, `ch3.md`…). A filename sort misorders `chN.md` vs `chN.K.md` (a plain string sort puts `chN.1.md` *before* `chN.md` because `1` < `m`). The `SourceBundle.segments` array is the single source of truth for reading order (set by `assignSegmentIds` during extraction). Related: the epub extraction is cached in `<base>-bundle.meta.json` (keyed on the epub's mtime/size plus a `schema` version — renaming the id scheme bumps `BUNDLE_SCHEMA_VERSION` and forces re-extraction, removing the stale old-named segment files); `--force` re-extracts, and a deleted/stale cache file just triggers re-extraction (fail-open).
21. **Un-monitored run policies change where failures surface — read the summary, not just the last log line.** With the un-monitored values in `.env` (`ON_VOLUME_ERROR=skip`, `ON_MISSING_PREVIOUS=skip`, `ON_TASK_ERROR=continue`), a broken volume no longer aborts its task or the pipeline: the task logs `[skip] Volume NN (…) failed: …`, keeps going (in the cumulative tasks the skip cascades through the remaining volumes via the missing-previous check), and the pipeline finishes with a `N of M volume(s) failed` / `Pipeline finished with N failed step(s)` summary that still fails the run (non-zero exit). The final series-root copy uses the **last existing** snapshot, so a partially failed run publishes the last good volume's artifact rather than nothing. Recovery is a plain re-run: idempotent skip-checks make it cheap, and the failed/skipped volumes are picked up. Code defaults are the opposite (fail loudly at the first problem) — keep them that way so interactive runs stay safe, and don't "fix" the cascade by making per-volume idempotency independent of the previous volume's artifact.
22. **The translation stage's model switching lives in the hooks — not in the task code.** Every local model container (Hy-MT2, Qwen3.8-27B, …) advertises the **same model alias** (`local`) and shares **one host port** (9200), so the ai-client cannot tell the models apart by name — `TRANSLATE_MODEL` / `VERIFY_MODEL` / `EDIT_MODEL` are all `local`. The per-machine pre-hooks (`hooks/pre-<task>.sh` → `model-switch.sh <compose dir>`) stop the current port owner, start the stage's container, and poll `/health` until the model is loaded. Consequences: (a) never add Docker/container logic to the task modules — the `/v1/models` check (`assertModelServing`) is the only endpoint contact; (b) running a translation task standalone on the wrong model fails loudly at the sanity check only if the model id differs — with identical aliases it translates with whatever happens to be up, so on local setups always run the tasks via the hooked pipeline (or the per-task gulp tasks, which fire the hooks); (c) `model-switch.sh` is idempotent via `hooks/.model-switch-state` (the compose dir it last started — the compose PROJECT label is *not* usable: compose sanitizes project names, so `Qwen3.8-27b-beellama` becomes `qwen38-27b-beellama` and never matches a dir-name comparison); a container started manually (no state file) is treated as "unknown" and swapped.

## 11. Conventions

- **JSDoc on every function** (params + returns), with provenance comments where a behavior exists because of a live incident ("observed live: …"). New code without JSDoc is a review blocker. Use named types from `types.js` (e.g. `{GlossaryVolumeCtx}` instead of `{Object}`) — the type annotations enable IDE cross-references across files.
- **Update AGENTS.md after changes.** If your work adds, removes, or significantly modifies files, functions, or conventions, update this document to reflect the new state. Agents reading AGENTS.md should be able to rely on it as a current map of the codebase — not a stale one.
- Errors **fail loudly** with actionable messages (pointing at files, `.env` keys, or `.logs/`).
- Prompt files stay mode-agnostic; mode-specific text is appended in code (`AGENT_TOOLS_NOTE`), never forked into separate prompt files.
- Tests: pure logic in `test/test-glossary-load.js`, `test/test-translate.js` (translation-stage helpers), and `test/test-hooks.js` (hook runner) — all plain `assert`, no framework (keep it that way); live behavior in `test/harness-smoke.js`.
- Dependencies: AI SDK v6 + `@openharness/core` v0.7 + `jszip`/`cheerio` (epub extraction in `utils/source.js`); keep CommonJS, no new frameworks.
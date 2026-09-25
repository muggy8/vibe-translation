# AGENTS.md — ai-client

**Read this first.** This is the entry point for AI agents working in this project. The codebase is small (~5k lines across 6 core files + types.js) and the JSDoc in each file is excellent — this doc is the map plus the hard-won gotchas; open the referenced file when you need depth.

## 1. What this is

An agentic AI client (v2.0.0, CommonJS, Node ≥ 22.19) that processes a light-novel series **volume by volume** and produces translation-support artifacts:

- `glossary` task → a canonical target-language glossary (per-volume snapshots + a final copy at the series root)
- `character-voice` task → a cumulative character voice reference (speech quirks, POV markers, narration types) and per-volume POV maps
- `jump-in-wiki` task → a per-volume `wiki.md` plus a "living" `shared-wiki.md`

It talks to any **OpenAI-compatible endpoint** through the Vercel AI SDK + `@openharness/core`. Tool-calling agents read the sources and write the outputs themselves through sandboxed file tools.

### Quickstart

| Command | What it does |
|---|---|
| `npx gulp glossary` | Run the glossary task (all volumes) |
| `npx gulp character-voice` | Run the character voice reference task (all volumes) |
| `npx gulp jump-in-wiki` | Run the wiki task (also the default gulp task) |
| `... --dry-run` | No AI calls; dump the exact prompts to `.dry-run/<task>-NN.md` |
| `... --force` | Regenerate even if outputs already exist |
| `... --volume NN` | Process a single volume (e.g. `--volume 01`) |
| `npm test` | Pure-function tests (no AI, no network) |
| `npm run smoke` | Live smoke test against the `.env` endpoint (`one-shot` / `research` / `fs` arg selects one check) |
| `npm start` | Ad-hoc harness CLI: `node harness.js --system "..." --text "..." [--file f --name n]` |

## 2. File map

| Path | Role |
|---|---|
| `configs/shared.js` | Shared constants extracted from task modules (`AGENT_TOOLS_NOTE`) and score-based acceptance config (`ROLLING_WINDOW_SIZE`, `ROLLING_MIN_SAMPLES`, `ACCEPTANCE_PASSING_SCORE`, `ACCEPTANCE_STRATEGY`, `BEST_OF_MIN_PASSES`, `computeRollingAverage`, `meetsAcceptanceCriteria`, `isAcceptedState`). All three task modules import from here. Also provides `saveRollingState` / `loadRollingState` for persisting the rolling window of scores to disk (see §3). Also provides `RESEARCH_CONCURRENCY` — the number of parallel research agents (one per glossary term, batched). |
| `utils/fs.js` | Filesystem helpers: `fileExists`, `assertWrote`. |
| `utils/prompt.js` | Prompt/verdict helpers: `transformUserPrompt`, `isPassingVerdict` (legacy binary verdict — kept for compatibility, no longer used in the acceptance path), `parseAcceptanceScore` (parses the 0–100 score from the acceptance one-shot reply; `null` = unparseable = failed check), `validatorMaxStepsFor`, `writePromptDump`. |
| `utils/manifest.js` | JSON/manifest helpers: `extractJsonObject`, `installmentNumberFromDir`. |
| `harness.js` | The AI layer: one-shot calls, agent handles, wiki tools, gated fs tools, provider plumbing, run logging, and the runaway-generation guard (aborts agent turns that produce excessive text without tool calls). Never bypass it to talk to the model. Logs every AI call to `.logs/<timestamp>/` — per-agent chat histories (system prompt, messages, assistant response, reasoning, tool calls) and one-shot call dumps — plus the summary log (greppable `CALL`/`RESULT`/`WARNING` lines). |
| `research.js` | Client-side web research (Wikipedia Action API + optional Brave/Tavily/Serper). No LLM involved. |
| `glossary.js` | Glossary task logic. |
| `character-voice.js` | Character voice reference task logic — extracts speech quirks, POV markers, narration types, and produces a cumulative character voice reference and per-volume POV maps. |
| `jump-in-wiki.js` | Wiki task logic **plus the shared helpers** |
| `get-translation-target.js` | AI-driven translation-target discovery: a tool-calling agent lists the series directory, identifies which entries are volume folders, opens candidate files to confirm the actual source text (ignoring generated artifacts and images), and writes `<SERIES_LOCATION>/translation-target.json`. Both tasks read this manifest instead of guessing folder names. |
| `translation-target.json` | Generated manifest (see `get-translation-target.js`); lists each volume's folder, source file, installment number, and metadata. All three tasks read it to resolve folders and source files. The live series dir always comes from `SERIES_LOCATION` (env), not from the manifest's `seriesLocation` field (provenance metadata — see gotcha 11). |
| `types.js` | JSDoc type definitions shared across modules. Defines named typedefs (`TranslationTargetManifest`, `GlossaryVolumeCtx`, `WikiVolumeCtx`, `CharacterVoiceVolumeCtx`, `IMessage`, `RunOneShotCfg`, `CreateAgentHandleCfg`, `AgentHandle`, `Taps`, `FetchResult`, `WikiTools`, `ResearchNote`) that replace generic `{Object}` annotations in `@param`/`@returns` tags. Imported via `require("./types")` in every core module for IDE cross-reference resolution. Pure JSDoc — zero runtime side effects. |
| `gulpfile.js` | Task wiring only (no logic). |
| `system-prompts/`, `user-prompts/` | Per-stage prompt pairs. Glossary: `glossary-terms`, `glossary` (amend), `glossary-validator`, `glossary-acceptance`, `glossary-feedback`. Character voice: `character-voice-extract`, `character-voice` (compile), `character-voice-validator`, `character-voice-acceptance`, `character-voice-feedback`. Wiki: `jump-in-wiki`, `-validator`, `-acceptance`, `-feedback`. |
| `test/test-glossary-load.js` | Pure tests (`npm test`). |
| `test/harness-smoke.js` | Live smoke test (`npm run smoke`). |
| `test-series/` | Fixture series (`test_story(1)`, `test_story(2)`); generated outputs are gitignored. |
| `.env` / `.env.example` | Configuration (see §6). |
| `.logs/` | One run log per process: `call-ai-<timestamp>.log`. |
| `.dry-run/` | Prompt dumps from `--dry-run`. |

Prompt files are agent-mode: the system prompt is appended with `AGENT_TOOLS_NOTE` to instruct the agent about file tools.

## 3. Architecture

### harness.js primitives (the only way to talk to the model)

- **`runOneShot({ systemPrompt, messages, ... })`** — one tool-less call. `messages` are `{ text }` or `{ file, name }` (images/wav/mp3 become binary parts; undetectable types are inlined as text). Streaming with a non-streaming fallback; retries empty/error responses up to `AI_RETRY`; **throws on empty — it never returns `""`** (workflows persist the returned string verbatim, so an empty result must fail the run instead of corrupting an artifact).
- **`createAgentHandle({ name, systemPrompt, tools, approve, cwd, maxSteps, ... })`** — a tool-using agent backed by an OpenHarness `Session`: context auto-compaction at `CONTEXT_WINDOW` tokens and retry-with-backoff. `sendTurn()` keeps message history across turns (author sessions reuse one session for generation + all feedback passes). For writing agents an empty final chat reply is *success* (the output went to disk) — no empty-retry there.
- **`createWikiTools()`** — `wiki_search(query, lang?)` / `wiki_extract(title, lang)` backed by research.js.
- **`createGatedFsTools({ cwd, allowedDirs })`** — OpenHarness fs tools (readFile/listFiles/grep/writeFile/editFile/deleteFile) with an **approve gate**: reads always allowed, `writeFile`/`editFile` confined to `allowedDirs` (the volume folder), `deleteFile` always denied. This is the sandbox — do not weaken it.

### Provider plumbing (local-LLM friendly)

- ESM bridge: `@openharness/core` + `@ai-sdk/openai` ship ESM-only builds; loaded lazily via `loadEsm()` (this project is CommonJS).
- Custom fetch built on **undici's own `fetch` + a no-timeout `Agent` from the same undici build** (all timeouts disabled — local servers can prefill for minutes); never mix the Agent with Node's *global* fetch — that crosses undici versions and throws `invalid onRequestStart method` on some Node builds (gotcha 19); merges thinking params into the request body (`chat_template_kwargs` for Qwen3-style models, `reasoning_effort` for levels); taps SSE/JSON responses for `reasoning_content` + first-token timing diagnostics.
- Every call logs to stderr **and** `.logs/call-ai-<timestamp>.log` (CALL/RESULT lines: finish reason, content/reasoning sizes, token usage, TTFT, tok/s). Workflow logging goes through `harness.logLine`.

### Shared workflow shape (both tasks)

1. Discover volume folders and source files via the translation-target manifest (`getTranslationTarget()`). An AI agent lists the series directory, identifies which entries are volume folders, opens candidate files to confirm the actual source text (ignoring generated artifacts and images), and writes the result to `<SERIES_LOCATION>/translation-target.json`. With `--dry-run` a deterministic fallback (the legacy convention) builds the manifest instead, so prompt previews stay fully offline.
2. Fill `{{PLACEHOLDER}}`s in the user-prompt templates (`transformUserPrompt` — **strict**: throws on a missing value or any leftover placeholder).
3. **QA loop** per volume, up to `MAX_VALIDATION_ITERATIONS`: score-based
   acceptance — the acceptance one-shot check (tool-less) scores the audited
   output **0–100** (100 = perfect, 0 = atrocious) using a banded rubric in
   the `*-acceptance.md` system prompts (Pass → 85–100, Pass with minor
   edits → 70–84, Requires revision → 40–69, Reject → 0–39). Each score is
   tracked in a rolling window (`ROLLING_WINDOW_SIZE`, default 5). When the
   window meets the criterion from `meetsAcceptanceCriteria()` (default
   strategy `average`: rolling average of scores ≥ `ACCEPTANCE_PASSING_SCORE`,
   default 70; alternative `best`: at least `BEST_OF_MIN_PASSES` of the
   scores ≥ the passing score) and we have at least `ROLLING_MIN_SAMPLES`
   checks (default 3), the output is accepted. An unparseable acceptance
   reply counts as a failed check (fail-closed) and is not stored. Otherwise,
   feedback is applied and the loop continues. A passing output
   is never touched by a feedback pass. **Fresh agent per feedback iteration**
   (no persistent session — each feedback turn starts with a clean context
   that includes the validation report and current glossary).
4. **Idempotency**: a volume whose outputs already exist and pass acceptance is skipped (unless `--force`). The skip-check reads a persisted rolling-window state file (`*-rolling-state.json`) written alongside the validation report during the last run, recomputing the acceptance decision deterministically — no AI call needed. If the state file is missing or corrupt, the check falls back to regenerating (fail-open). A failed skip-check degrades to "not skipped" (fail-open, by design).

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

Artifacts per volume folder: `glossary.md` (snapshot), `glossary-research.md`, `glossary-validation.md`.

**Cumulative invariant:** regenerating any volume sets `regeneratedAny` → **all later volumes are regenerated too** (their glossaries would otherwise build on a stale base). Do not "fix" this by making per-volume idempotency independent.

## 5. Pipeline B: jump-in-wiki (`jump-in-wiki.js`)

Per volume:

1. **Generate** `wiki.md` + `shared-wiki.md` (context: the previous volume's `wiki.md` + `shared-wiki.md`):
    - an author agent (per-volume session, `maxSteps 40`). Stubs are pre-created for both files (a stronger name anchor than "create a new file", and a crashed run leaves identifiable stubs).
      Stale classic-named files (`jump-in-wiki-NN.md`, `jump-in-wiki-shared.md`) are deleted up front so agents can't audit garbage.
2. **QA loop**: a validator agent writes `jump-in-wiki-validation-NN.md` (size-scaled step cap) → acceptance one-shot scores the wiki 0–100 → unless the rolling window of scores meets the criterion, the same author session applies the feedback.
3. **Two-tier idempotency**: if `wiki.md` + `shared-wiki.md` exist → skip generation, go straight to validation; if a validation report exists and passes acceptance → skip the whole volume.
4. End-of-run summary counts the volumes that hit the iteration limit.

## 5. Pipeline C: character-voice (`character-voice.js`)

Per volume, in order — each volume's reference builds on the previous one's:

1. **Extract** — one-shot call: source text → JSON array of `{ type, character, quirkType, description, examples, ... }` entries for both voice quirks and POV analysis. Parsed by `parseVoiceQuirks` (tolerates markdown fences and prose).
2. **Compile** — an author agent (per-volume session, `maxSteps 30`) reads the source, previous reference, and extraction results, then writes two files:
   - `character-voice.md` — the cumulative character voice reference (carries forward all previous entries, adds new characters/quirks)
   - `pov-map.md` — the per-volume POV map (marker identification, narration type classification, POV assignments, free indirect discourse detection)
   The agent-mode turn prompts (author/validator/feedback) name every material at its real path — the previous volume's reference at `../<previous folder>/character-voice.md` (same convention as glossary.js) — so agents never have to guess where to read. A missing previous reference fails loudly (dry-run: warn).

3. **QA loop**: a fresh validator agent per iteration writes `character-voice-validation.md` → acceptance one-shot scores the reference 0–100 → unless the rolling window of scores meets the criterion, a fresh author agent applies feedback (`character-voice-feedback.md`). Same score-based acceptance criterion as the other pipelines (the state file is saved on every iteration, including the accepting one, so accepted volumes are skipped on re-run).
4. After all volumes: the last volume's `character-voice.md` is copied to `VOICE_OUTPUT_FILE` (default `<SERIES_LOCATION>/character-voice.md`). Skipped for `--volume` runs.

Artifacts per volume folder: `character-voice.md` (cumulative snapshot), `pov-map.md` (per-volume), `character-voice-validation.md` (validation report).

**Cumulative invariant:** same as glossary — regenerating any volume sets `regeneratedAny` → all later volumes are regenerated too.

**Key differences from glossary:** no research stage (quirks are text-intrinsic); produces two files instead of one; extraction and compilation are separate stages.

## 6. Environment reference (`.env`)

| Var | Default | Meaning |
|---|---|---|
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `OPENAI_API_KEY` | — (required) | Auth |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model id |
| `MAX_TOKENS` | `1024` | Max output tokens per call |
| `TEMPERATURE` | `0.7` | Sampling temperature |
| `AI_RETRY` | `0` | Retries per AI call (API errors + empty responses) |
| `SERIES_NAME_SOURCE` | — (required) | Series name; volume folders must contain it |
| `SERIES_LOCATION` | — (required) | Folder containing the volume folders |
| `SOURCE_LANGUAGE` / `TARGET_LANGUAGE` | Japanese / English | Filled into the prompts |
| `MAX_VALIDATION_ITERATIONS` | `10` | QA-loop cap per volume (increased to allow rolling average to converge) |
| `ROLLING_WINDOW_SIZE` | `5` | Number of recent acceptance checks in the rolling window |
| `ROLLING_MIN_SAMPLES` | `3` | Minimum checks before the criterion can trigger acceptance |
| `ACCEPTANCE_PASSING_SCORE` | `70` | Passing score (0–100) for the score-based acceptance criterion — the rubric boundary between "Pass with minor edits" (70–84) and "Requires revision" (40–69) |
| `ACCEPTANCE_STRATEGY` | `average` | How the window is evaluated: `average` (mean of scores ≥ passing score) or `best` (≥ `BEST_OF_MIN_PASSES` scores ≥ passing score) |
| `BEST_OF_MIN_PASSES` | `3` | For `ACCEPTANCE_STRATEGY=best`: minimum scores ≥ passing score needed ("best 3 of 5" with the default window) |
| `CONTEXT_WINDOW` | `128000` | Tokens at which agent sessions auto-compact |
| `AGENT_MAX_STEPS` | `20` | Default step cap for tool agents (workflows pass higher caps where needed) |
| `AGENT_TEXT_GUARD_CHARS` | `30000` | Runaway-generation guard: abort an agent turn when it produces more than this many chars of text with fewer than 3 tool calls. Catches models that emit malformed tool-call text instead of using the tool-calling API. |
| `GLOSSARY_OUTPUT_FILE` | `<SERIES_LOCATION>/glossary.md` | Final glossary location |
| `VOICE_OUTPUT_FILE` | `<SERIES_LOCATION>/character-voice.md` | Final character voice reference location |
| `RESEARCH_ENABLED` | `true` | Research new glossary terms |
| `RESEARCH_CONCURRENCY` | `3` | Number of parallel research agents (one per term, batched). Set to `1` for sequential processing. |
| `WIKI_LANGS` | `ja,en` | Wikipedia languages to query |
| `RESEARCH_MAX_RESULTS` / `RESEARCH_EXTRACT_CHARS` | `3` / `800` | Research result size |
| `RESEARCH_DELAY_MS` / `RESEARCH_TIMEOUT_MS` | `300` / `30000` | Politeness delay / per-request timeout |
| `WIKI_USER_AGENT` | built-in | Descriptive UA (Wikipedia requires one) |
| `SEARCH_API` / `SEARCH_API_KEY` | off | Optional brave / tavily / serper backend |
| `THINKING` | on | Qwen3 thinking phase — **enabled by default**. See §7. |
| `THINKING_LEVEL` | xhigh | reasoning_effort: "low" / "medium" / "xhigh" (model-dependent). |

**Current local setup** (the committed `.env`): local Qwen at `http://localhost:9200/v1`, `MAX_TOKENS=262144`, `TEMPERATURE=0.6`, `AI_RETRY=2`, `MAX_VALIDATION_ITERATIONS=10`, `ROLLING_WINDOW_SIZE=5`, `ROLLING_MIN_SAMPLES=3`, `ACCEPTANCE_PASSING_SCORE=70`, `ACCEPTANCE_STRATEGY=average`, `AGENT_TEXT_GUARD_CHARS=30000`, THINKING=on, THINKING_LEVEL=xhigh, series = `test-series` (the `test_story` fixture), JP→EN. **It points at the test fixture, not the real 17 volumes** — check this before any "production" run.

## 7. Gotchas (hard-won — read before changing behavior)

1. **`THINKING_LEVEL` tuning is per-series.** Reasoning token burn varies dramatically across series — a series with heavy technical jargon may need "xhigh" while a simpler narrative may run fine on "medium". Start with "xhigh" (the default), monitor `.logs/call-ai-*.log` for reasoning content sizes, and tune down to "medium" or "low" if the reasoning spend is excessive relative to content output. Set `THINKING=false` to disable entirely.
2. **Never let a stage persist empty output.** `runOneShot` throws on empty by design; agent stages are guarded by `assertWrote` (missing/empty file → hard error pointing at `.logs/`). If you add a stage, add both guarantees.
3. **Do not touch the agent-mode prompt safety nets** (the stray-file cleanups): each was added after a live failure (wrong file names, stale strays being audited, marker-format conflicts). The pure tests pin their behavior — run `npm test` after touching any prompt or file name.
4. **Validator step caps scale with source size** (`validatorMaxStepsFor`): a fixed cap of 40 ran out on the 521KB volume-01 source before the validator wrote its report.
5. **The glossary is cumulative** — see the §4 invariant (`regeneratedAny`).
6. **Skip-checks are deterministic** (reads a persisted `*-rolling-state.json` file storing the rolling window of scores). If the state file is missing or uses the legacy boolean format (pre-score-based era), `loadRollingState` returns `null` and the check falls back to regenerating/re-validating the volume once (fail-open) — so pre-existing runs are safe to re-run.
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
18. **Fail-loudly guard for small malformed tool calls (`assertRealToolCalls` in `character-voice.js`):** the 30K runaway guard above only fires on *large* text output. A local Qwen endpoint also intermittently emits *small* malformed tool calls — a few dozen chars of `tool_call` / `<function=…>` text with zero real `tool_calls` — so `npm run smoke fs` can pass while a workflow turn does nothing (no reads, no writes). `character-voice.js` now calls `assertRealToolCalls(result, who, volume)` after every agent `sendTurn` in the compile/validate/feedback stages: when a turn made zero real tool calls but its text contains `tool_call` / `<function=`, it throws a diagnostic error (pointing at `.logs/` and the smoke test) instead of letting `assertWroteWithFallback` pass on a stale file and the acceptance loop burn all iterations. The pure detector `emittedToolCallAsText` is exported and unit-tested. **`glossary.js` and `jump-in-wiki.js` have the same latent exposure and should get the identical guard.**
19. **Never hand the npm undici Agent to Node's global fetch (`makeProviderFetch` in `harness.js`).** The project's `undici` dependency (v8) is a *different build* from Node's bundled undici (which powers the global `fetch`). Passing `noTimeoutAgent` to the global `fetch` mixes request-handler protocols: on Node builds whose bundled undici is older, the dispatch throws `InvalidArgumentError: invalid onRequestStart method` (`UND_ERR_INVALID_ARG`) before any bytes are sent. This is Node-version-dependent, so identical code + `node_modules` can work on one machine (e.g. Windows Node) and fail on another (Linux Node 22) — observed live right after a Windows→Linux migration. The fix pattern: dispatch through undici's *own* `fetch` (same build as the Agent), and normalize `Headers` instances to plain objects first (undici's webidl converter would silently convert a foreign Headers instance to an empty record, dropping auth/content-type).

## 8. Conventions

- **JSDoc on every function** (params + returns), with provenance comments where a behavior exists because of a live incident ("observed live: …"). New code without JSDoc is a review blocker. Use named types from `types.js` (e.g. `{GlossaryVolumeCtx}` instead of `{Object}`) — the type annotations enable IDE cross-references across files.
- **Update AGENTS.md after changes.** If your work adds, removes, or significantly modifies files, functions, or conventions, update this document to reflect the new state. Agents reading AGENTS.md should be able to rely on it as a current map of the codebase — not a stale one.
- Errors **fail loudly** with actionable messages (pointing at files, `.env` keys, or `.logs/`).
- Prompt files stay mode-agnostic; mode-specific text is appended in code (`AGENT_TOOLS_NOTE`), never forked into separate prompt files.
- Tests: pure logic in `test/test-glossary-load.js` (plain `assert`, no framework — keep it that way); live behavior in `test/harness-smoke.js`.
- Dependencies: AI SDK v6 + `@openharness/core` v0.7; keep CommonJS, no new frameworks.
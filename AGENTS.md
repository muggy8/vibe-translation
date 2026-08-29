# AGENTS.md — ai-client

**Read this first.** This is the entry point for AI agents working in this project. The codebase is small (~5k lines across 6 core files + types.js) and the JSDoc in each file is excellent — this doc is the map plus the hard-won gotchas; open the referenced file when you need depth.

## 1. What this is

An agentic AI client (v2.0.0, CommonJS, Node ≥ 22.19) that processes a light-novel series **volume by volume** and produces translation-support artifacts:

- `glossary` task → a canonical target-language glossary (per-volume snapshots + a final copy at the series root)
- `jump-in-wiki` task → a per-volume `wiki.md` plus a "living" `shared-wiki.md`

It talks to any **OpenAI-compatible endpoint** through the Vercel AI SDK + `@openharness/core`. Tool-calling agents read the sources and write the outputs themselves through sandboxed file tools.

### Quickstart

| Command | What it does |
|---|---|
| `npx gulp glossary` | Run the glossary task (all volumes) |
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
| `configs/shared.js` | Shared constants extracted from task modules (`AGENT_TOOLS_NOTE`) and rolling-average validation config (`ROLLING_WINDOW_SIZE`, `ROLLING_ACCEPTANCE_THRESHOLD`, `ROLLING_MIN_SAMPLES`, `computeRollingAverage`). Both `glossary.js` and `jump-in-wiki.js` import from here. Also provides `saveRollingState` / `loadRollingState` for persisting the rolling window to disk (see §3). |
| `utils/fs.js` | Filesystem helpers: `fileExists`, `assertWrote`. |
| `utils/prompt.js` | Prompt/verdict helpers: `transformUserPrompt`, `isPassingVerdict`, `validatorMaxStepsFor`, `writePromptDump`. |
| `utils/manifest.js` | JSON/manifest helpers: `extractJsonObject`, `installmentNumberFromDir`. |
| `harness.js` | The AI layer: one-shot calls, agent handles, wiki tools, gated fs tools, provider plumbing, run logging. Never bypass it to talk to the model. |
| `research.js` | Client-side web research (Wikipedia Action API + optional Brave/Tavily/Serper). No LLM involved. |
| `glossary.js` | Glossary task logic. |
| `jump-in-wiki.js` | Wiki task logic **plus the shared helpers** (`transformUserPrompt`, `isPassingVerdict`, `installmentNumberFromDir`, `validatorMaxStepsFor`, `writePromptDump`) — the glossary task reuses these from here. |
| `get-translation-target.js` | AI-driven translation-target discovery: a tool-calling agent lists the series directory, identifies which entries are volume folders, opens candidate files to confirm the actual source text (ignoring generated artifacts and images), and writes `<SERIES_LOCATION>/translation-target.json`. Both tasks read this manifest instead of guessing folder names. |
| `translation-target.json` | Generated manifest (see `get-translation-target.js`); lists each volume's folder, source file, installment number, and metadata. Both `glossary.js` and `jump-in-wiki.js` consume it. |
| `types.js` | JSDoc type definitions shared across modules. Defines named typedefs (`TranslationTargetManifest`, `GlossaryVolumeCtx`, `WikiVolumeCtx`, `IMessage`, `RunOneShotCfg`, `CreateAgentHandleCfg`, `AgentHandle`, `Taps`, `FetchResult`, `WikiTools`, `ResearchNote`) that replace generic `{Object}` annotations in `@param`/`@returns` tags. Imported via `require("./types")` in every core module for IDE cross-reference resolution. Pure JSDoc — zero runtime side effects. |
| `gulpfile.js` | Task wiring only (no logic). |
| `system-prompts/`, `user-prompts/` | Per-stage prompt pairs. Glossary: `glossary-terms`, `glossary` (amend), `glossary-validator`, `glossary-acceptance`, `glossary-feedback`. Wiki: `jump-in-wiki`, `-validator`, `-acceptance`, `-feedback`. |
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
- Custom undici fetch with all timeouts disabled (local servers can prefill for minutes); merges thinking params into the request body (`chat_template_kwargs` for Qwen3-style models, `reasoning_effort` for levels); taps SSE/JSON responses for `reasoning_content` + first-token timing diagnostics.
- Every call logs to stderr **and** `.logs/call-ai-<timestamp>.log` (CALL/RESULT lines: finish reason, content/reasoning sizes, token usage, TTFT, tok/s). Workflow logging goes through `harness.logLine`.

### Shared workflow shape (both tasks)

1. Discover volume folders and source files via the translation-target manifest (`getTranslationTarget()`). An AI agent lists the series directory, identifies which entries are volume folders, opens candidate files to confirm the actual source text (ignoring generated artifacts and images), and writes the result to `<SERIES_LOCATION>/translation-target.json`. With `--dry-run` a deterministic fallback (the legacy convention) builds the manifest instead, so prompt previews stay fully offline.
2. Fill `{{PLACEHOLDER}}`s in the user-prompt templates (`transformUserPrompt` — **strict**: throws on a missing value or any leftover placeholder).
3. **QA loop** per volume, up to `MAX_VALIDATION_ITERATIONS`: rolling-average
   acceptance — each acceptance result is tracked in a rolling window
   (`ROLLING_WINDOW_SIZE`, default 5). When the rolling pass rate meets the
   threshold (`ROLLING_ACCEPTANCE_THRESHOLD`, default 0.60) and we have at
   least `ROLLING_MIN_SAMPLES` checks (default 3), the output is accepted.
   Otherwise, feedback is applied and the loop continues. A passing output
   is never touched by a feedback pass.
4. **Idempotency**: a volume whose outputs already exist and pass acceptance is skipped (unless `--force`). The skip-check reads a persisted rolling-window state file (`*-rolling-state.json`) written alongside the validation report during the last run, recomputing the acceptance decision deterministically — no AI call needed. If the state file is missing or corrupt, the check falls back to regenerating (fail-open). A failed skip-check degrades to "not skipped" (fail-open, by design).

## 4. Pipeline A: glossary (`glossary.js`)

Per volume, in order — each volume's glossary is built on the previous one's:

1. **Extract new terms** — one-shot in both modes: source + previous `glossary.md` → JSON array of `{ term, type, query }`; parsed by `parseTerms` (tolerates markdown fences and surrounding prose).
2. **Research** the new terms:
   - a researcher agent (wiki tools + gated fs). **Skeleton-first**: the code pre-writes `glossary-research.md` with a `- (pending)` line under every term, and the agent must replace each via `editFile` immediately — a crashed run still leaves a usable file. `maxSteps = max(30, 5·terms + 10)`.
3. **Amend** the glossary (carry forward every existing term, add the new ones, reconcile conflicts):
   - an **author agent** (per-volume session, `maxSteps 40`) reads the materials with `readFile` and writes `glossary.md` with `writeFile`/`editFile`. The same session later applies the feedback passes.
4. **QA loop**: a fresh validator agent per iteration (step cap **scaled to source size**: `max(40, 2·ceil(bytes/32KB) + 24)` — `validatorMaxStepsFor`) writes `glossary-validation.md` → acceptance one-shot → on FAIL the author session applies the feedback.
5. After all volumes: the **last** volume's `glossary.md` is copied to `GLOSSARY_OUTPUT_FILE` (default `<SERIES_LOCATION>/glossary.md`). Skipped for `--volume` runs (a single volume's snapshot would be stale).

Artifacts per volume folder: `glossary.md` (snapshot), `glossary-research.md`, `glossary-validation.md`.

**Cumulative invariant:** regenerating any volume sets `regeneratedAny` → **all later volumes are regenerated too** (their glossaries would otherwise build on a stale base). Do not "fix" this by making per-volume idempotency independent.

## 5. Pipeline B: jump-in-wiki (`jump-in-wiki.js`)

Per volume:

1. **Generate** `wiki.md` + `shared-wiki.md` (context: the previous volume's `wiki.md` + `shared-wiki.md`):
    - an author agent (per-volume session, `maxSteps 40`). Stubs are pre-created for both files (a stronger name anchor than "create a new file", and a crashed run leaves identifiable stubs).
      Stale classic-named files (`jump-in-wiki-NN.md`, `jump-in-wiki-shared.md`) are deleted up front so agents can't audit garbage.
2. **QA loop**: a validator agent writes `jump-in-wiki-validation-NN.md` (size-scaled step cap) → acceptance one-shot -> on FAIL the same author session applies the feedback.
3. **Two-tier idempotency**: if `wiki.md` + `shared-wiki.md` exist → skip generation, go straight to validation; if a validation report exists and passes acceptance → skip the whole volume.
4. End-of-run summary counts the volumes that hit the iteration limit.

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
| `ROLLING_MIN_SAMPLES` | `3` | Minimum checks before rolling average can trigger acceptance |
| `ROLLING_ACCEPTANCE_THRESHOLD` | `0.60` | Pass rate (0–1) needed to accept via rolling average |
| `CONTEXT_WINDOW` | `128000` | Tokens at which agent sessions auto-compact |
| `AGENT_MAX_STEPS` | `20` | Default step cap for tool agents (workflows pass higher caps where needed) |
| `GLOSSARY_OUTPUT_FILE` | `<SERIES_LOCATION>/glossary.md` | Final glossary location |
| `RESEARCH_ENABLED` | `true` | Research new glossary terms |
| `WIKI_LANGS` | `ja,en` | Wikipedia languages to query |
| `RESEARCH_MAX_RESULTS` / `RESEARCH_EXTRACT_CHARS` | `3` / `800` | Research result size |
| `RESEARCH_DELAY_MS` / `RESEARCH_TIMEOUT_MS` | `300` / `30000` | Politeness delay / per-request timeout |
| `WIKI_USER_AGENT` | built-in | Descriptive UA (Wikipedia requires one) |
| `SEARCH_API` / `SEARCH_API_KEY` | off | Optional brave / tavily / serper backend |
| `THINKING` | on | Qwen3 thinking phase — **enabled by default**. See §7. |
| `THINKING_LEVEL` | xhigh | reasoning_effort: "low" / "medium" / "xhigh" (model-dependent). |

**Current local setup** (the committed `.env`): local Qwen at `http://localhost:9200/v1`, `MAX_TOKENS=262144`, `TEMPERATURE=0.6`, `AI_RETRY=2`, `MAX_VALIDATION_ITERATIONS=10`, `ROLLING_WINDOW_SIZE=5`, `ROLLING_MIN_SAMPLES=3`, `ROLLING_ACCEPTANCE_THRESHOLD=0.60`, THINKING=on, THINKING_LEVEL=xhigh, series = `test-series` (the `test_story` fixture), JP→EN. **It points at the test fixture, not the real 17 volumes** — check this before any "production" run.

## 7. Gotchas (hard-won — read before changing behavior)

1. **`THINKING_LEVEL` tuning is per-series.** Reasoning token burn varies dramatically across series — a series with heavy technical jargon may need "xhigh" while a simpler narrative may run fine on "medium". Start with "xhigh" (the default), monitor `.logs/call-ai-*.log` for reasoning content sizes, and tune down to "medium" or "low" if the reasoning spend is excessive relative to content output. Set `THINKING=false` to disable entirely.
2. **Never let a stage persist empty output.** `runOneShot` throws on empty by design; agent stages are guarded by `assertWrote` (missing/empty file → hard error pointing at `.logs/`). If you add a stage, add both guarantees.
3. **Do not touch the agent-mode prompt safety nets** (the stray-file cleanups): each was added after a live failure (wrong file names, stale strays being audited, marker-format conflicts). The pure tests pin their behavior — run `npm test` after touching any prompt or file name.
4. **Validator step caps scale with source size** (`validatorMaxStepsFor`): a fixed cap of 40 ran out on the 521KB volume-01 source before the validator wrote its report.
5. **The glossary is cumulative** — see the §4 invariant (`regeneratedAny`).
6. **Skip-checks are deterministic** (reads a persisted `*-rolling-state.json` file). If the state file is missing (e.g. a run from before this change), the check falls back to regenerating the volume — so pre-existing runs are safe to re-run.
7. **`isPassingVerdict` is intentionally strict**: any mention of FAIL/FAILED/FAILURES or "NOT PASS" fails the verdict. Do not loosen it to "contains PASS".
8. **The fs write gate confines writes to the volume folder**; reads are allowed anywhere (agents need the previous volume). `deleteFile` is always denied — the *workflow* deletes stale strays, never the agent.
9. **Logging goes through `harness.logLine`** so run logs stay greppable (prefix `[call-ai]`, file `.logs/call-ai-*.log`). The ad-hoc `harness.js` CLI prints model output to stdout — keep stdout clean for that.
10. This directory is **not a git repository**; `.gitignore` exists for when it becomes one (and documents the ignored outputs: `.logs/`, `.dry-run/`, generated `test-series` files).
11. **The discovery agent's manifest is cached and auto-stale:** `getTranslationTarget()` reuses an existing `translation-target.json` unless `--force` is passed or a listed source file has been deleted (stale → auto-regenerate). With `--dry-run` the AI is never called and the legacy convention is used instead.

## 8. Conventions

- **JSDoc on every function** (params + returns), with provenance comments where a behavior exists because of a live incident ("observed live: …"). New code without JSDoc is a review blocker. Use named types from `types.js` (e.g. `{GlossaryVolumeCtx}` instead of `{Object}`) — the type annotations enable IDE cross-references across files.
- **Update AGENTS.md after changes.** If your work adds, removes, or significantly modifies files, functions, or conventions, update this document to reflect the new state. Agents reading AGENTS.md should be able to rely on it as a current map of the codebase — not a stale one.
- Errors **fail loudly** with actionable messages (pointing at files, `.env` keys, or `.logs/`).
- Prompt files stay mode-agnostic; mode-specific text is appended in code (`AGENT_TOOLS_NOTE`), never forked into separate prompt files.
- Tests: pure logic in `test/test-glossary-load.js` (plain `assert`, no framework — keep it that way); live behavior in `test/harness-smoke.js`.
- Dependencies: AI SDK v6 + `@openharness/core` v0.7; keep CommonJS, no new frameworks.
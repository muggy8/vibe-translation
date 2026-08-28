# AGENTS.md — ai-client

**Read this first.** This is the entry point for AI agents working in this project. The codebase is small (~4k lines across 5 core files) and the JSDoc in each file is excellent — this doc is the map plus the hard-won gotchas; open the referenced file when you need depth.

## 1. What this is

An agentic AI client (v2.0.0, CommonJS, Node ≥ 22.19) that processes a light-novel series **volume by volume** and produces translation-support artifacts:

- `glossary` task → a canonical target-language glossary (per-volume snapshots + a final copy at the series root)
- `jump-in-wiki` task → a per-volume `wiki.md` plus a "living" `shared-wiki.md`

It talks to any **OpenAI-compatible endpoint** through the Vercel AI SDK + `@openharness/core`. Two workflow modes: **agent** (default — tool-calling agents read the sources and write the outputs themselves through sandboxed file tools) and **classic** (single-shot calls; the code parses and saves the model output).

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
| `configs/shared.js` | Shared constants extracted from task modules (`AGENT_TOOLS_NOTE`). Both `glossary.js` and `jump-in-wiki.js` import from here. |
| `utils/fs.js` | Generalized utilities: `fileExists`, `assertWrote`, `extractJsonObject`, `installmentNumberFromDir`, `transformUserPrompt`, `isPassingVerdict`, `validatorMaxStepsFor`, `writePromptDump`, `splitJumpInWikiGenerationOutput`. |
| `harness.js` | The AI layer: one-shot calls, agent handles, wiki tools, gated fs tools, provider plumbing, run logging. Never bypass it to talk to the model. |
| `research.js` | Client-side web research (Wikipedia Action API + optional Brave/Tavily/Serper). No LLM involved. |
| `glossary.js` | Glossary task logic. |
| `jump-in-wiki.js` | Wiki task logic **plus the shared helpers** (`transformUserPrompt`, `isPassingVerdict`, `installmentNumberFromDir`, `validatorMaxStepsFor`, `writePromptDump`) — the glossary task reuses these from here. |
| `get-translation-target.js` | AI-driven translation-target discovery: a tool-calling agent lists the series directory, identifies which entries are volume folders, opens candidate files to confirm the actual source text (ignoring generated artifacts and images), and writes `<SERIES_LOCATION>/translation-target.json`. Both tasks read this manifest instead of guessing folder names. |
| `translation-target.json` | Generated manifest (see `get-translation-target.js`); lists each volume's folder, source file, installment number, and metadata. Both `glossary.js` and `jump-in-wiki.js` consume it. |
| `gulpfile.js` | Task wiring only (no logic). |
| `system-prompts/`, `user-prompts/` | Per-stage prompt pairs. Glossary: `glossary-terms`, `glossary` (amend), `glossary-validator`, `glossary-acceptance`, `glossary-feedback`. Wiki: `jump-in-wiki`, `-validator`, `-acceptance`, `-feedback`. |
| `test/test-glossary-load.js` | Pure tests (`npm test`). |
| `test/harness-smoke.js` | Live smoke test (`npm run smoke`). |
| `test-series/` | Fixture series (`test_story(1)`, `test_story(2)`); generated outputs are gitignored. |
| `.env` / `.env.example` | Configuration (see §6). |
| `.logs/` | One run log per process: `call-ai-<timestamp>.log`. |
| `.dry-run/` | Prompt dumps from `--dry-run`. |

Prompt files are **mode-agnostic**: agent mode appends a static `AGENT_TOOLS_NOTE` and rewrites file names in code (see §5), it does not fork the prompt files.

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
3. **QA loop** per volume, up to `MAX_VALIDATION_ITERATIONS`: validate (independent validator) → **acceptance check (always a tool-less one-shot answering PASS/FAIL, parsed by `isPassingVerdict`)** → on FAIL, feedback applied by the *author's own session* → repeat. A passing output is never touched by a feedback pass.
4. **Idempotency**: a volume whose outputs already exist and pass acceptance is skipped (unless `--force`). Note the skip-check itself is a *live one-shot API call*; a failed skip-check degrades to "not skipped" (fail-open, by design).

## 4. Pipeline A: glossary (`glossary.js`)

Per volume, in order — each volume's glossary is built on the previous one's:

1. **Extract new terms** — one-shot in both modes: source + previous `glossary.md` → JSON array of `{ term, type, query }`; parsed by `parseTerms` (tolerates markdown fences and surrounding prose).
2. **Research** the new terms:
   - *agent*: a researcher agent (wiki tools + gated fs). **Skeleton-first**: the code pre-writes `glossary-research.md` with a `- (pending)` line under every term, and the agent must replace each via `editFile` immediately — a crashed run still leaves a usable file. `maxSteps = max(30, 5·terms + 10)`.
   - *classic*: the fixed `researchTerms` batch → `formatResearchNotes` inlined into the prompt.
3. **Amend** the glossary (carry forward every existing term, add the new ones, reconcile conflicts):
   - *agent*: an **author agent** (per-volume session, `maxSteps 40`) reads the materials with `readFile` and writes `glossary.md` with `writeFile`/`editFile`. The same session later applies the feedback passes.
   - *classic*: one-shot, output saved to `glossary.md`.
4. **QA loop**: a fresh validator agent per iteration (step cap **scaled to source size**: `max(40, 2·ceil(bytes/32KB) + 24)` — `validatorMaxStepsFor`) writes `glossary-validation.md` → acceptance one-shot → on FAIL the author session applies the feedback.
5. After all volumes: the **last** volume's `glossary.md` is copied to `GLOSSARY_OUTPUT_FILE` (default `<SERIES_LOCATION>/glossary.md`). Skipped for `--volume` runs (a single volume's snapshot would be stale).

Artifacts per volume folder: `glossary.md` (snapshot), `glossary-research.md`, `glossary-validation.md`.

**Cumulative invariant:** regenerating any volume sets `regeneratedAny` → **all later volumes are regenerated too** (their glossaries would otherwise build on a stale base). Do not "fix" this by making per-volume idempotency independent.

## 5. Pipeline B: jump-in-wiki (`jump-in-wiki.js`)

Per volume:

1. **Generate** `wiki.md` + `shared-wiki.md` (context: the previous volume's `wiki.md` + `shared-wiki.md`):
   - *agent*: an author agent (per-volume session, `maxSteps 40`). Stubs are pre-created for both files (a stronger name anchor than "create a new file", and a crashed run leaves identifiable stubs). Safety nets, each added after a live failure:
     - `agentOutputNames()` — rewrites the classic marker file names inside the prompts to `wiki.md`/`shared-wiki.md` (the prompts were originally written for classic mode; the model used to write files under the wrong names);
     - `stripMarkerOutputFormat()` — removes the `## Output Format` marker section in agent mode (it conflicts with file tools);
     - `adoptStrayOutput()` — if the expected file is missing, renames the best stray non-empty `.md` (protecting known files, scoring by "wiki"/digits/mtime).
     Stale classic-named files (`jump-in-wiki-NN.md`, `jump-in-wiki-shared.md`) are deleted up front so agents can't audit garbage.
   - *classic*: one-shot with the marker format (`---- jump-in-wiki-NN.md ----` … `---- jump-in-wiki-shared.md ----` … `---- end ----`), split by `splitJumpInWikiGenerationOutput` (degrades leniently when markers are missing).
2. **QA loop**: a validator agent writes `jump-in-wiki-validation-NN.md` (size-scaled step cap) → acceptance one-shot → on FAIL the same author session applies the feedback (stray adoption re-checked afterwards).
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
| `MAX_VALIDATION_ITERATIONS` | `3` | QA-loop cap per volume |
| `RESEARCH_MODE` | `agent` | `agent` (tool-calling agents) or `classic` (single-shot) |
| `CONTEXT_WINDOW` | `128000` | Tokens at which agent sessions auto-compact |
| `AGENT_MAX_STEPS` | `20` | Default step cap for tool agents (workflows pass higher caps where needed) |
| `GLOSSARY_OUTPUT_FILE` | `<SERIES_LOCATION>/glossary.md` | Final glossary location |
| `RESEARCH_ENABLED` | `true` | Research new glossary terms |
| `WIKI_LANGS` | `ja,en` | Wikipedia languages to query |
| `RESEARCH_MAX_RESULTS` / `RESEARCH_EXTRACT_CHARS` | `3` / `800` | Research result size |
| `RESEARCH_DELAY_MS` / `RESEARCH_TIMEOUT_MS` | `300` / `30000` | Politeness delay / per-request timeout |
| `WIKI_USER_AGENT` | built-in | Descriptive UA (Wikipedia requires one) |
| `SEARCH_API` / `SEARCH_API_KEY` | off | Optional brave / tavily / serper backend |
| `THINKING` | off | Qwen3 thinking phase — **leave off, see §7** |

**Current local setup** (the committed `.env`): local Qwen at `http://localhost:9200/v1`, `MAX_TOKENS=262144`, `TEMPERATURE=0.2`, `AI_RETRY=1`, `MAX_VALIDATION_ITERATIONS=5`, series = `test-series` (the `test_story` fixture), JP→EN. **It points at the test fixture, not the real 17 volumes** — check this before any "production" run.

## 7. Gotchas (hard-won — read before changing behavior)

1. **`THINKING` must stay off** for real work. Observed live on this Qwen setup: thinking ON burned 3.5 hours and 235k characters of reasoning on the volume-01 extraction with *zero content*, and agent runs took 17 minutes instead of ~30 seconds. Only enable it for short prompts (e.g. the acceptance check) and expect `MAX_TOKENS` to cover the reasoning spend.
2. **Never let a stage persist empty output.** `runOneShot` throws on empty by design; agent stages are guarded by `assertWrote` (missing/empty file → hard error pointing at `.logs/`). If you add a stage, add both guarantees.
3. **Do not touch the agent-mode prompt safety nets** (`agentOutputNames`, `stripMarkerOutputFormat`, `adoptStrayOutput`, the stray-file cleanups): each was added after a live failure (wrong file names, stale strays being audited, marker-format conflicts). The pure tests pin their behavior — run `npm test` after touching any prompt or file name.
4. **Validator step caps scale with source size** (`validatorMaxStepsFor`): a fixed cap of 40 ran out on the 521KB volume-01 source before the validator wrote its report.
5. **The glossary is cumulative** — see the §4 invariant (`regeneratedAny`).
6. **Skip-checks cost a live model call** even when the volume is skipped.
7. **`isPassingVerdict` is intentionally strict**: any mention of FAIL/FAILED/FAILURES or "NOT PASS" fails the verdict. Do not loosen it to "contains PASS".
8. **The fs write gate confines writes to the volume folder**; reads are allowed anywhere (agents need the previous volume). `deleteFile` is always denied — the *workflow* deletes stale strays, never the agent.
9. **Logging goes through `harness.logLine`** so run logs stay greppable (prefix `[call-ai]`, file `.logs/call-ai-*.log`). The ad-hoc `harness.js` CLI prints model output to stdout — keep stdout clean for that.
10. This directory is **not a git repository**; `.gitignore` exists for when it becomes one (and documents the ignored outputs: `.logs/`, `.dry-run/`, generated `test-series` files).
11. **The discovery agent's manifest is cached and auto-stale:** `getTranslationTarget()` reuses an existing `translation-target.json` unless `--force` is passed or a listed source file has been deleted (stale → auto-regenerate). With `--dry-run` the AI is never called and the legacy convention is used instead.

## 8. Conventions

- **JSDoc on every function** (params + returns), with provenance comments where a behavior exists because of a live incident ("observed live: …"). New code without JSDoc is a review blocker.
- Errors **fail loudly** with actionable messages (pointing at files, `.env` keys, or `.logs/`).
- Prompt files stay mode-agnostic; mode-specific text is appended/rewritten in code (`AGENT_TOOLS_NOTE`, `agentOutputNames`), never forked into separate prompt files.
- Tests: pure logic in `test/test-glossary-load.js` (plain `assert`, no framework — keep it that way); live behavior in `test/harness-smoke.js`.
- Dependencies: AI SDK v6 + `@openharness/core` v0.7; keep CommonJS, no new frameworks.
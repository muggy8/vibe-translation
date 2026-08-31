# 04 — Implementation plan

## 0. Instructions to implementing agents

- Read order: root `AGENTS.md` → `01-goals.md` → `02-architecture.md` →
  `03-spec.md` → this file.
- Conventions are binding: JSDoc on every function (params + returns, named
  types from `types.js`), CommonJS, **no new npm dependencies**, fail loudly
  with actionable errors, plain-`assert` tests (no framework).
- The JSON path must keep working: after **every** phase run `npm test`, and
  (when the `.env` endpoint is up) `npm run smoke`, with `REPL_MODE` unset.
- Do **not** touch: `runOneShot` internals, QA/acceptance logic,
  rolling-average acceptance, idempotency/skip-checks, cumulative invariants,
  prompt files (`system-prompts/`, `user-prompts/`), `research.js`.
- Update root `AGENTS.md` when a phase lands (file map, env table, gotchas).
- Tick the phase checkboxes below as you complete them.

## Phase 0 — Spike (de-risk before building)

**Goal:** prove the local Qwen can drive a JS REPL reliably, and capture
baseline metrics. **This phase gates everything else.**

- [ ] **Task 0.1** — Write `harness/spike.js` (self-contained, ~150–250
  lines, **no edits to existing files**):
  - an inline minimal worker: `fork` a child that hosts a fresh vm context
    with `print` + proxies for the tools (per `03-spec.md` §4, minus limits
    beyond a 60s per-run timeout);
  - an inline minimal `repl` tool (no gate; tools =
    `harness.createWikiTools()` + gated fs tools pointed at a
    `.harness-smoke/` temp dir via `harness.createGatedFsTools`);
  - one live task, researcher-shaped: *"Research the term `<X>` (at most 2
    `wikiSearch` calls, 1 `wikiExtract`). Write your notes to
    `research-spike.md` via `writeFile`. Reply with a one-line summary."* —
    pick `<X>` from the test fixture (a series-specific term from
    `test-series/test_story(1)/…md`);
  - system prompt: a 5-line researcher prompt + a hand-written version of
    the REPL note (final template comes in Phase 1);
  - print every repl call (code + report) and the final usage/tokens/wall time.
- [ ] **Task 0.2** — Run it (requires the `.env` endpoint to be up —
  `npm run smoke` passing is the precondition).
- [ ] **Task 0.3** — Create `harness/RESULTS.md` and record: total tokens,
  wall time, repl-call count, transcript highlights.

**Exit criteria:** task completes in ≤ 8 repl calls; `research-spike.md`
exists with a plausible note; any errors are self-corrected (visible in the
transcript); no runaway (no >30k-char text turn without repl calls).

**Decision gate:** if after 2–3 prompt tweaks the model still cannot drive
the REPL (writes non-JS, cannot `await`, loops on the same error), **STOP
and report** — do not proceed to Phase 1.

## Phase 1 — Core (`utils/repl.js` + `utils/repl-worker.js` + tests)

- [ ] **Task 1.1** — `utils/repl-worker.js` per `03-spec.md` §4. Only
  `node:vm` + the message channel; no other built-ins, no project imports.
- [ ] **Task 1.2** — `utils/repl.js` per `03-spec.md` §2: `replMode`,
  `createReplTool`, `replToolsNote`, plus internals `mapArgs(tool, args)` and
  `serializeReturn(value)` (export both for tests):
  - `mapArgs`: single plain-object arg → pass through as named args;
    otherwise map positionally onto `Object.keys(tool.inputSchema.shape)` in
    order; extra args → `Error("too many arguments for <name>")`.
  - **Build-time check:** verify with a quick `node -e` that the tool objects
    from `core.createFsTools` / `createWikiTools` expose
    `{ description, inputSchema, execute }` directly; if `execute` is
    wrapped (e.g. under a `~experimental` key), adapt the accessor in
    `utils/repl.js` in exactly one place.
- [ ] **Task 1.3** — `test/test-repl.js` (plain `assert`; no AI, no network —
  a locally forked worker is acceptable):
  - `mapArgs`: positional, single-object passthrough, too-many-args,
    missing-optional;
  - `serializeReturn`: every case in `03-spec.md` §5 incl. truncation;
  - `replToolsNote`: contains every tool name + parameter names; deterministic;
  - live worker (real `fork`, dummy in-process tools): persistence
    (`x = 41` then `x + 1` → 42), `print` capture, top-level `return`,
    runtime error → `ok:false` with name + message, gate denial
    (`approve` → false ⇒ "denied by policy"), unknown function, zod arg
    error, tool timeout (`limits.toolMs = 150` on a hanging tool ⇒ error +
    sandbox reset), `maxErrors` (`limits.maxErrors = 2`, two failing runs ⇒
    stop message).
- [ ] **Task 1.4** — `package.json`: `"test": "node test/test-glossary-load.js && node test/test-repl.js"`.

**Exit:** `npm test` green (both files).

## Phase 2 — Integration (`harness.js` + workflows + smoke)

- [ ] **Task 2.1** — `harness.js` per `03-spec.md` §8: `repl` / `replContext`
  options on `createAgentHandle`, the `summarizeInput` carve-out for `repl`,
  new exports, JSDoc, `types.js` typedefs.
- [ ] **Task 2.2** — Workflow call sites. Pattern for each site:
  ```js
  const tools = { ...fsGate.tools };  // researcher: also add the wiki tools
  const note = harness.replMode() ? harness.replToolsNote(tools) : AGENT_TOOLS_NOTE;
  // createAgentHandle({ systemPrompt: <base> + note, tools, approve: fsGate.approve, repl: harness.replMode(), … })
  ```
  Sites:
  - `glossary.js` — researcher (233), author (824), validator (905),
    feedback (983); dry-run dumps (570, 575) use the same conditional note.
  - `jump-in-wiki.js` — author (533), validator (640); builders
    `buildWikiAuthorSystemPrompt` (153) / `buildWikiValidatorSystemPrompt`
    (164) append `AGENT_TOOLS_NOTE` today — give them an optional `toolsNote`
    parameter (default `AGENT_TOOLS_NOTE`) and pass
    `harness.replToolsNote(ctx.fsGate.tools)` when `harness.replMode()`.
  - `character-voice.js` — author (329), validator (352), feedback (396);
    builders at 180–182 (`buildExtractSystemPrompt` /
    `buildAuthorSystemPrompt` / `buildValidatorSystemPrompt`) get the same
    optional `toolsNote` parameter; dry-run dumps (258–261) pass the
    conditional note.
  - `get-translation-target.js` — discovery (278).
  - The researcher per-term prompt mentions `readFile`/`grep`/`editFile` by
    name — keep the names (identical in the REPL); no change unless the
    Phase 0 spike says otherwise.
- [ ] **Task 2.3** — `test/harness-smoke.js`: new `"repl"` check
  (`node test/harness-smoke.js repl`):
  - gated fs tools into a temp dir (same pattern as check 3);
  - repl agent (system prompt = short writer prompt +
    `harness.replToolsNote(tools)`): *"Write the text 'repl ok' to
    volume/repl-test.md using writeFile in your code, read it back with
    readFile, then reply with exactly: DONE"*;
  - assert the file contents; then have it attempt
    `writeFile('../escape.md', …)` → assert the denial is reported and no
    escape file exists;
  - add to the `ALL` list + update the header comment.

**Exit:** `npm test` green; `npm run smoke` (all checks incl. `repl`) green;
`npx gulp jump-in-wiki --dry-run` with `REPL_MODE=true` dumps the REPL note
(and the JSON note when unset).

## Phase 3 — Validation on the fixture

- [ ] **Task 3.1** — Baseline (if not already present): run the glossary
  task on `test-series` with `REPL_MODE` unset → keep the `.logs/` dir + a
  copy of the artifacts under `harness/baseline-json/`.
- [ ] **Task 3.2** — REPL run: `REPL_MODE=true npx gulp glossary`, then
  `jump-in-wiki` (and `character-voice` if time permits) →
  `harness/run-repl/`.
- [ ] **Task 3.3** — Compare and write to `harness/RESULTS.md` (metrics list
  in `01-goals.md` §6): tool-definition tokens per agent request; input
  tokens per volume (per agent, from `RESULT` usage lines); validator step
  count on the largest fixture source; failure/malformed incidents (grep
  `WARNING`); wall time per volume; acceptance pass rate per volume; human
  spot-check of `glossary.md` / `wiki.md` / `shared-wiki.md` from both runs.

**Exit:** artifacts hold quality (acceptance passes at comparable iteration
counts); no runaway incidents; at least the token metrics improve
measurably. If quality regresses: fix prompts (REPL note / stage prompts)
and re-run — do **not** change acceptance logic.

## Phase 4 — Decision & docs

- [ ] **Task 4.1** — Decide the default: keep `REPL_MODE` opt-in (documented)
  or flip the default to `true` in `.env.example`, based on Phase 3.
- [ ] **Task 4.2** — `.env.example`: document `REPL_MODE` + the `REPL_*`
  vars (defaults per `03-spec.md` §7).
- [ ] **Task 4.3** — Root `AGENTS.md`: file map (`utils/repl.js`,
  `utils/repl-worker.js`, `test/test-repl.js`, `harness/`), env table,
  gotchas (gate parity in repl mode; sandbox reset loses variables;
  runaway-guard semantics in repl mode; step accounting).
- [ ] **Task 4.4** — Finalize `harness/RESULTS.md`; tick all phase checkboxes
  in this file.

**Exit:** docs current; `npm test` + `npm run smoke` green in both modes.

## Risks & mitigations

| risk | mitigation |
|---|---|
| Qwen JS reliability | Phase 0 gate; note keeps the function surface small; tracebacks returned verbatim; `maxErrors` stop |
| namespace loss on timeout/crash | told to the model with "re-read anything you need"; tool reads are idempotent |
| vm escape surface | fresh context (no process/require/fetch/Buffer); worker has no capability to abuse anyway (no fs/net handles) |
| structured-clone limits | canonical stringify rule (`03-spec.md` §5) both directions |
| Windows specifics | `fork` + `kill` (terminate) only; no signals, no `/tmp` sockets; paths via `path.resolve` as today |
| model confusion (writes JSON-style tool calls inside code) | note + spike; if it happens, add one few-shot example to the note |
| runaway-guard false positives in repl mode | documented; revisit only with evidence |
| step-count semantics shift | keep `maxSteps` unchanged in v1; tune in Phase 4 if wasteful |

## Out of scope (v1)

- speculation (sPTC) — extension point only (`03-spec.md` §10)
- multi-language REPL; Docker/cloud sandbox backends
- publishing as an OSS package (the API is deliberately extractable —
  `createReplTool` is self-contained — but no npm work now)
- changes to `runOneShot` stages, QA/acceptance, idempotency, artifacts,
  `research.js`



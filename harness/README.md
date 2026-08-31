# harness/ — REPL (Programmatic Tool Calling) mode for ai-client

Plan + spec for adding a **programmatic tool calling (PTC) mode** to the
ai-client: the model's action space becomes a persistent JavaScript REPL
(one `repl({ code })` tool) instead of N JSON tools. The existing harness
(OpenHarness + AI SDK v6) keeps doing the agent loop, session, compaction,
retry, and logging; a small translation layer + sandbox executes the model's
code and routes its function calls to the **same tool `execute()` functions
the harness already uses** — through the **same `approve()` write gate**.

Status: **PLANNED — not implemented.** Phase checkboxes live in
`04-implementation-plan.md`; tick them as phases land.

## Document map (read in order)

| File | Contents |
|---|---|
| `01-goals.md` | Why, goals, non-goals, success criteria, metrics |
| `02-architecture.md` | Components, sandbox design, security model, data flow, error handling, design decisions |
| `03-spec.md` | Exact API, IPC protocol, arg mapping, serialization, prompt-note template, env vars, error formats |
| `04-implementation-plan.md` | Phases, file-by-file tasks, test plan, validation, risks, agent instructions |

## Ground rules for implementing agents

1. Read the project `AGENTS.md` (repo root) **first** — its conventions are
   binding: JSDoc on every function (params + returns, named types from
   `types.js`), CommonJS, no new npm dependencies, fail loudly with
   actionable errors, plain-`assert` tests (no framework).
2. Never bypass `harness.js` to talk to the model.
3. The write gate is a sandbox — do not weaken it (reads allowed, writes
   confined to the volume folder, deletes denied). In REPL mode the same
   `approve()` function must gate **every mediated tool call** (gate parity).
4. `REPL_MODE=false` (the default) must keep the existing JSON-tool path
   fully working — this is an additive feature behind a flag.
5. Validate after every phase: `npm test`, and (when the `.env` endpoint is
   up) `npm run smoke`.

## Quick orientation (existing code this plan touches)

- `harness.js` — `createAgentHandle` (~line 1187), `createWikiTools` (~657),
  `createGatedFsTools` (~733), runaway guard (~891), `writeAgentTurnLog`
  (~214), `summarizeInput` (~781).
- `configs/shared.js` — `AGENT_TOOLS_NOTE` (the JSON-mode prompt note).
- Agent call sites: `glossary.js` (233, 824, 905, 983 + dry-run dumps 570/575),
  `jump-in-wiki.js` (533, 640 + builders 153/164), `character-voice.js`
  (329, 352, 396 + builders 180–182 + dry-run 258–261),
  `get-translation-target.js` (278), `test/harness-smoke.js` (29, 73).
- `test/test-glossary-load.js` — the pure-test file (`npm test`);
  `test/harness-smoke.js` — the live smoke test (`npm run smoke`).

## Why "harness/" (naming)

The folder holds the plan, the spike, and the results for this work. The
*code* itself lands in `utils/repl.js` + `utils/repl-worker.js` (see
`03-spec.md` §1) — next to the other utils — not in this folder.

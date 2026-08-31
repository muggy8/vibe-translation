# 01 — Goals

## 1. Background

This project's agent stages (glossary researcher/author/validator, wiki
author/validator, character-voice author/validator, discovery) use standard
JSON tool calling: the harness registers N tools (6 fs + 2 wiki), their full
definitions (name + description + JSON schema) are injected into **every**
request, and the model must emit schema-conformant JSON arguments for each
call.

Programmatic tool calling (PTC) — the pattern behind CodeAct
(arXiv 2402.01030), Anthropic's "programmatic tool calling", and Recursive
Language Models (arXiv 2512.24601) — replaces the N-tool action space with a
single code REPL: tools become functions inside the model's code, and the
model writes a script instead of forming JSON tool calls.

There is no off-the-shelf JS PTC harness (the established ones are Python:
RLM, smolagents, OpenHands; Anthropic's PTC requires their paid server-side
container). This plan therefore builds the **minimal** PTC layer inside this
project: a small sandbox + translation layer on top of the existing
OpenHarness/AI-SDK harness. The API is kept deliberately extractable in case
it is later published as a library, but publishing is explicitly out of
scope.

## 2. Goals

- **G1 — Tool-definition overhead.** Agent requests carry one tiny
  `{ code: string }` tool schema instead of ~7 full schemas (~1.5–2.5k
  tokens per request today). The function list moves into the (stable,
  prefix-cacheable) system prompt as names + signatures.
- **G2 — Context economy.** Intermediate results (source reads, wiki
  extracts) are filtered **in code** before reaching the model's context —
  the model `print`s / `return`s only what it needs, so it "doesn't have to
  remember things". This is the largest expected saving: the 521KB
  volume-01 source currently round-trips through context via `readFile`
  JSON results.
- **G3 — Reliability.** The model writes free-form JS (a skill open models
  have) instead of multi-field schema-conformant JSON; failures come back as
  readable tracebacks the model can self-correct. This project's worst
  incident — 962KB of malformed tool-call text (AGENTS.md gotcha #17, which
  forced `AGENT_TEXT_GUARD_CHARS`) — is a protocol-conformance failure mode
  that PTC eliminates by construction: there is no multi-tool protocol to
  malform.
- **G4 — Additive & reversible.** Behind `REPL_MODE` (default off). The JSON
  path is untouched and remains the fallback; a run can A/B either mode.
- **G5 — Gate parity.** The write gate (reads allowed anywhere, writes
  confined to the volume folder, deletes denied) applies identically in REPL
  mode — the same `approve()` function gates every mediated call.

## 3. Non-goals (v1)

- Speculative execution (sPTC) — an extension point only (see `03-spec.md`
  §10); not implemented.
- Multi-language REPL (Python/bash); Docker/cloud sandbox backends.
- Publishing an OSS package (the API is extractable, but no npm work now).
- Changing `runOneShot` stages, QA/acceptance logic, rolling-average
  acceptance, idempotency/skip-checks, cumulative invariants, artifact
  formats, or `research.js`.
- Replacing OpenHarness — it keeps the loop, session, compaction, retry, and
  event logging. REPL mode just swaps the tool *set*, not the harness.

## 4. Honest scope: what a REPL inside a JSON harness removes vs. keeps

| Removed | Kept |
|---|---|
| ~7 tool definitions per request → 1 tiny `{code:string}` schema | The outer call is still **one** JSON tool call (a single string field — the easiest possible shape; unavoidable, it is the harness protocol) |
| Multi-field JSON argument conformance per tool | The model still emits tool-call JSON for the `repl` wrapper |
| Intermediate results round-tripping (filtered in code first) | Tool implementations, the write gate, QA loops, acceptance, idempotency, artifacts, one-shot stages |

## 5. Success criteria

- **S1.** All three pipelines (glossary, jump-in-wiki, character-voice) plus
  discovery complete on the `test-series` fixture in REPL mode with artifacts
  that hold quality (acceptance passes at comparable iteration counts to a
  JSON-mode baseline).
- **S2.** Measurable improvement in at least: tool-definition tokens per
  agent request (expected ≥80% reduction) and input tokens per volume
  (validator stage especially).
- **S3.** Zero malformed-protocol incidents across the validation runs.
- **S4.** `npm test` + `npm run smoke` green in **both** modes;
  `--dry-run` dumps correct prompts in both modes.
- **S5.** Gate parity proven: the smoke `repl` check blocks an
  out-of-folder write.

## 6. Metrics to capture (written to `harness/RESULTS.md`)

- tool-definition tokens per agent request (JSON vs REPL — estimate from
  schema sizes or a request dump in `.logs/`)
- input/output tokens per volume, per agent (sum of `RESULT` usage lines)
- validator step count on the largest fixture source
- tool-call failure rate (`WARNING` lines / malformed incidents)
- wall time per volume
- acceptance pass rate per volume (quality proxy)

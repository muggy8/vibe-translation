# 02 — Architecture

## 1. One-paragraph design

In REPL mode an agent's tool set is a **single tool**, `repl({ code })`. Its
`execute()` (parent process) sends `code` to a forked **worker** (child
process) that evaluates it in a persistent `node:vm` context. The vm context
contains only JS intrinsics, a `print` function, and one **async proxy
function per project tool** (`readFile`, `wikiSearch`, …). When the model's
code calls a proxy, the worker sends a `toolCall` message to the parent; the
parent runs the **same tool `execute()` function the harness would have run
for a direct JSON tool call** — through the **same `approve()` gate** — and
returns the result. The code continues; when it finishes, the captured
stdout + the top-level `return` value go back to the model as the `repl`
tool's result. The existing OpenHarness Agent/Session (loop, `maxSteps`,
compaction, retry, event logging) is unchanged — it simply sees one tool
instead of seven.

## 2. Component diagram

```
┌─ OpenHarness Agent/Session (UNCHANGED: loop, maxSteps, compaction, retry, logs) ─┐
│                                                                                  │
│   model ──(only tool: repl{code})──▶ Agent executes repl.execute(code)           │
│                                                  │                               │
└──────────────────────────────────────────────────┼───────────────────────────────┘
                                                   ▼
                                     ┌─ utils/repl-worker.js (forked child) ─┐
                                     │  persistent vm context:               │
                                     │   JS intrinsics + print + proxies     │
                                     │  model code runs here:                │
                                     │   var c = await readFile(p)           │
                                     │   return c.match(/re/i)               │
                                     └───────────────────┬───────────────────┘
                                                        │ IPC (fork channel,
                                                        │ structured clone)
                                                        ▼
                                     parent (utils/repl.js, inside harness.js process):
                                       1. approve({toolName, input})   ← same gate as JSON mode
                                       2. zod validate args against tool.inputSchema
                                       3. await tool.execute(input)     ← same fn the harness uses
                                       4. reply with result / error
                                                        │
                                                        ▼
                                     {stdout, return, error} ──▶ back to the model
                                                                as the repl tool result
```

## 3. Components

### 3.1 `utils/repl-worker.js` (NEW, ~120–150 lines)

The child-process bootstrap. Plain CommonJS, the **only** built-in it
requires is `node:vm` (plus `process` for the message channel). It:

- builds the vm context on `init` (see `03-spec.md` §4),
- evaluates each `run` as an async wrapper in the **same** context (persistence),
- forwards proxy invocations as `toolCall` messages and awaits replies,
- reports `runResult` (stdout, serialized return value, error, duration),
- exits cleanly on `close`.

It must never `require` anything else, and must never touch `fs`/`net`
directly — its only effect on the world is through tool-call messages.

### 3.2 `utils/repl.js` (NEW, ~200 lines)

Parent side. Exports (per `03-spec.md` §2):

- `replMode()` — env switch (`REPL_MODE === "true"`).
- `createReplTool(cfg)` — builds the single `repl` AI-SDK tool + owns the
  worker lifecycle (lazy fork, message routing, per-run timeout →
  kill/respawn, `maxErrors` counter, stats, `close()`).
- `replToolsNote(tools)` — generates the system-prompt note (template in
  `03-spec.md` §6) from the tools map.
- Internals exported for tests: `mapArgs(tool, args)`, `serializeReturn(v)`.

### 3.3 `harness.js` (EDIT, small)

- `createAgentHandle` gains `repl` (bool) + `replContext` (object) options.
  When `repl` is true it wraps `cfg.tools` via `createReplTool` and gives the
  Agent `tools: { repl: replTool }`; `handle.close()` also closes the
  sandbox. When false, the code path is byte-for-byte today's behavior.
- `summarizeInput` (used by `writeAgentTurnLog`) gets a carve-out: for
  `toolName === "repl"` the code is truncated at 4000 chars instead of 120,
  so the per-turn logs stay useful.
- New exports: `replMode`, `replToolsNote`, `createReplTool`.
- `types.js` gains `ReplToolCfg` / `ReplHandle` typedefs; `CreateAgentHandleCfg`
  gains `repl` / `replContext`.

### 3.4 Workflow files (EDIT, mechanical)

Every agent call site picks the note and passes the flag (pattern in
`04-implementation-plan.md` Phase 2). No workflow logic changes: QA loops,
acceptance, idempotency, and artifact handling are untouched.

## 4. Sandbox design (two layers, both load-bearing)

### 4.1 Capability isolation — a fresh `vm` context

The model's code runs in a context created with `vm.createContext` containing
**only**: JS intrinsics (present automatically: `Object`, `Array`, `String`,
`RegExp`, `JSON`, `Math`, `Date`, `Promise`, `Map`, `Set`, `Error`, …), the
injected `print`, a `console` alias (`log`/`warn`/`error` → `print`), the
tool proxies, and any `context` values.

**Not present:** `process`, `require`, `module`, `fetch`, `Buffer`, host
globals. A *fresh* context is realm-isolated: the classic constructor-walk
escapes stay inside the realm and cannot reach host globals.

Threat model: a **buggy local LLM**, not a malicious actor. The realistic
failure modes are hangs and memory blowups — handled by 4.2.

### 4.2 Time/resource isolation — a child process

`node:vm` **cannot be preempted**: a model-generated `while (true) {}` in an
in-process vm would freeze the parent forever. The worker makes timeouts
enforceable: the parent kills the child and respawns. `execArgv:
["--max-old-space-size=<REPL_MAX_HEAP_MB>"]` caps the heap. On Windows
`child.kill()` = terminate (no signals needed).

### 4.3 Why not the alternatives

| option | rejected because |
|---|---|
| in-process `node:vm` | no preemption (hang = dead server) |
| `worker_threads` | same no-preemption problem + shared heap |
| Docker / cloud sandbox | overkill for v1; the tools are already gated parent-side, so the container would add isolation the design doesn't need |
| Python/Bun REPL | out of scope (JS-only v1); JS keeps the tools as-is (no porting) and matches the project + maintainer language |

## 5. Security model / gate parity

- The worker has **no direct capability**: no `fs`/`net`/`child_process`
  handles. Its only effect on the world is `toolCall` messages.
- The parent applies the **existing `approve()`** to every mediated call with
  the exact shape the gate already handles: `approve({ toolName, input })`
  (the same calls `test/harness-smoke.js` check 3 makes). Reads allowed
  anywhere, writes confined to the volume folder, `deleteFile` denied —
  unchanged.
- Args are zod-validated against `tool.inputSchema` **before** `execute`
  (the schema is the contract; failures become model-readable errors).
- Consequence: even a full "sandbox escape" cannot reach the filesystem —
  there is nothing inside the worker to reach it with.

## 6. Data flow (one `repl` call, end to end)

1. Model emits a `repl` tool call `{ code }` (the only tool it has).
2. OpenHarness Agent executes it → `replTool.execute({ code })`.
3. Parent ensures the worker is alive (lazy fork + `init` on first use),
   sends `{ t: "run", id, code }`, starts the `callMs` timer.
4. Worker wraps the code as `(async () => { … })()`, resets the per-run
   stdout buffer, evaluates in the persistent context.
5. Model code calls e.g. `await readFile("wiki.md")` → proxy sends
   `{ t: "toolCall", id, name: "readFile", args: ["wiki.md"] }`.
6. Parent: `approve({ toolName: "readFile", input: { filePath: "wiki.md" } })`
   → zod-validate → `await tool.execute({ filePath: "wiki.md" })` →
   `{ t: "toolResult", id, ok, value }`.
7. Proxy resolves; code continues (loops, filters, more calls…).
8. Code finishes → worker sends `runResult` (stdout, serialized return,
   error if thrown, duration).
9. Parent formats the report string (§2.2), logs a `[repl]` line, returns it
   as the tool result → OpenHarness feeds it to the model as the next turn.

## 7. State & lifecycle

- **One sandbox per agent handle** (per `createAgentHandle` call). The
  namespace persists across that handle's turns — the wiki author's
  generate + feedback turns share variables (e.g. `src` loaded in turn 1 is
  still there in the feedback turn).
- **Lazy fork** on first `repl` call; **lazy respawn** after kill/crash —
  the namespace is lost on respawn and the model is told so (see §8).
- `handle.close()` closes the sandbox (send `close`, 2s grace, kill).
- Limits: `REPL_CALL_TIMEOUT_MS`, `REPL_TOOL_TIMEOUT_MS`, `REPL_MAX_STDOUT`,
  `REPL_MAX_ERRORS`, `REPL_MAX_HEAP_MB` (defaults in `03-spec.md` §7).

## 8. Error handling & guards

| failure | detection | behavior | model sees |
|---|---|---|---|
| syntax/runtime error in code | worker `runResult ok:false` | none (normal flow) | `error: <Name>: <message>` + truncated stack — self-correct |
| N consecutive errors | parent counter (`REPL_MAX_ERRORS`) | return stop message; counter resets on success | "stop calling repl and give your final answer in plain text" |
| run exceeds `callMs` | parent timer | kill worker, lazy respawn on next call | "timed out … sandbox reset; all variables lost, re-read anything you need" |
| tool exceeds `toolMs` | parent timer per call | reject the pending call | `<tool> timed out after <ms>ms` |
| worker crash / OOM | `exit` event | in-flight run fails; lazy respawn | "sandbox crashed … reset; all variables lost" |
| tool denied by gate | `approve` false | no execution | `denied by policy: <tool>` |
| unknown function | name not in tools map | no execution | `unknown function: <n> — available: …` |
| bad args | zod `safeParse` fail | no execution | `invalid arguments for <n>: <first issue>` |
| runaway text (unchanged) | `AGENT_TEXT_GUARD_CHARS` guard in `consumeEvents` | abort turn | same as today |

**Runaway guard in REPL mode:** the guard trips on "> N chars of text with
< 3 tool calls". In REPL mode a turn is typically 1 `repl` call + brief
text, so the guard still catches text-only runaways; writer agents reply
briefly (content goes through `writeFile` in code), so false positives are
not expected. Keep the guard as-is; revisit only with evidence.

## 9. Logging (zero new machinery)

- Each `repl` call flows through OpenHarness `tool.start`/`tool.done`
  events, so the existing per-turn agent logs
  (`.logs/<run>/agent-<name>/turn-NNN.md`) capture code + report
  automatically.
- **One change:** `summarizeInput` truncates `repl` inputs at 4000 chars
  (not 120) so the turn log is actually useful.
- `logLine` per run: `[repl] run #<n> code=<chars> tools=<count>
  stdout=<chars> err=<…> <ms>ms` (greppable, like existing `CALL`/`RESULT`).
- `.stream.md` real-time streaming logs are untouched (model text streams as
  before).

## 10. What this removes vs. keeps (honest scope)

| Removed | Kept |
|---|---|
| ~7 tool definitions per request (~1.5–2.5k tokens) → 1 tiny `{code:string}` schema | The outer call is still **one** JSON tool call (single string field — the easiest possible shape; unavoidable: it is the harness protocol) |
| Multi-field JSON argument conformance per tool | The model still emits tool-call JSON for the `repl` wrapper |
| Intermediate results round-tripping (filtered in code before `print`/`return`) | Tool implementations, the gate, QA loops, acceptance, idempotency, artifacts, one-shot stages, OpenHarness session machinery |

## 11. Design decisions log

| # | decision | alternatives | rationale |
|---|---|---|---|
| 1 | JS-only REPL | Python/bash/multi-language | project + maintainer language; tools are already JS (zero porting); no new runtime dependency |
| 2 | `fork` + fresh vm context | in-process vm, worker_threads, Docker | preemption (4.2) + capability isolation (4.1); Docker overkill (4.3) |
| 3 | positional args mapped via `inputSchema.shape` key order; single object arg passes through as named | named-only | models write positional calls naturally; object passthrough keeps flexibility; zod still validates |
| 4 | gate applied parent-side per mediated call | "trust the worker" | gate parity with JSON mode; the worker has nothing to abuse anyway |
| 5 | `REPL_MODE` flag, default off | replace JSON mode | additive, A/B-able, zero-risk fallback (goal G4) |
| 6 | no speculation (sPTC) in v1 | implement now | early single-author tech; extension point reserved instead (`03-spec.md` §10) |
| 7 | keep `maxSteps` unchanged in v1 | halve it | 1 repl call = 1 step but does more work per step; headroom is safer; tune in Phase 4 if wasteful |
| 8 | plain JS + JSDoc (no TS) | TypeScript | project convention; zero build; IDE cross-refs via `types.js` |



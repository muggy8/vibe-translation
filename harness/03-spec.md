# 03 — API & protocol spec

Normative. Where this file and the architecture doc disagree, this file wins.

## 1. New files

- `utils/repl.js` — parent side (lifecycle, routing, note generator).
- `utils/repl-worker.js` — child bootstrap (`node:vm` only).

Both CommonJS, zero npm dependencies. Both fully JSDoc'd; named types go in
`types.js`.

## 2. `utils/repl.js` exports

### 2.1 `replMode()`

```js
/** @returns {boolean} true only when process.env.REPL_MODE === "true". */
function replMode()
```

Default (unset/anything else) is `false`.

### 2.2 `createReplTool(cfg)`

```js
/**
 * @typedef {Object} ReplToolCfg
 * @property {Object<string, Object>} tools - AI-SDK tool objects (exactly what
 *   createGatedFsTools()/createWikiTools() return). Each must expose
 *   `.description` (string, may be ""), `.inputSchema` (zod schema), and
 *   `.execute(input, options)`.
 * @property {(call: {toolName: string, input: Object}) => boolean|Promise<boolean>} [approve]
 *   Same shape as the existing gate (see test/harness-smoke.js check 3).
 *   Omitted = all calls allowed (unit tests only — production always passes it).
 * @property {Object<string, unknown>} [context] - Values injected into the REPL
 *   namespace at init (must be structured-cloneable). v1: workflows do not use this.
 * @property {string} [cwd] - Informational (tools already close over their cwd).
 * @property {string} [label] - Log label (default "repl").
 * @property {{callMs?: number, toolMs?: number, maxStdoutChars?: number, maxErrors?: number, maxHeapMb?: number}} [limits]
 *   Defaults from env (see §7).
 * @returns {{replTool: Object, close: Function, stats: Object}} ReplHandle
 *   - replTool: the single AI-SDK tool (see below).
 *   - close(): Promise<void> — idempotent; sends close, waits 2s for exit, kills.
 *   - stats: live object {runs, toolCalls, denied, errors, timeouts, respawns}.
 */
function createReplTool(cfg)
```

The `replTool` itself:

```js
tool({
  description: "Run JavaScript in the persistent REPL sandbox. The available " +
               "functions are listed in your instructions; they are async — always await them. " +
               "Top-level return produces a final value; print() writes to stdout.",
  inputSchema: z.object({
    code: z.string().describe("JavaScript to run in the persistent REPL."),
  }),
  execute: async ({ code }) => string,   // the model-facing report, see below
})
```

**Report format** (the string returned to the model):

- success: sections joined by `\n\n`, only non-empty ones included:
  - `stdout:\n<captured stdout>` (when stdout non-empty)
  - `return: <serialized return value>` (when the code returned something other than `undefined`)
  - if both empty → `(no output)`
- failure: `error: <error text>` — preceded by the `stdout:` section when
  stdout was captured before the error.

### 2.3 `replToolsNote(tools)`

```js
/**
 * Generate the REPL system-prompt note for a tools map.
 * @param {Object<string, Object>} tools - Same shape as ReplToolCfg.tools.
 * @returns {string} The note (template in §6).
 */
function replToolsNote(tools)
```

For each tool: name + parameter names (in `inputSchema.shape` key order,
optionals marked `?`) + a one-line description (first sentence of
`tool.description`, truncated at 100 chars, omitted when empty).

## 3. Worker protocol

Transport: `child_process.fork` message channel (structured clone — no
manual JSON). Message shapes:

### 3.1 parent → worker

| message | fields | meaning |
|---|---|---|
| `{ t: "init" }` | `tools: string[]`, `context: Object`, `maxStdoutChars: number` | build the vm context; reply `{ t: "ready" }` |
| `{ t: "run" }` | `id: number`, `code: string` | evaluate `code` in the persistent context |
| `{ t: "close" }` | — | clean `process.exit(0)` |

### 3.2 worker → parent

| message | fields | meaning |
|---|---|---|
| `{ t: "ready" }` | — | init complete |
| `{ t: "toolCall" }` | `id: number`, `name: string`, `args: unknown[]` | a proxy was invoked; parent **must** reply with `toolResult` for the same `id` |
| `{ t: "runResult" }` | `id: number`, `ok: boolean`, `stdout: string`, `truncated: boolean`, `returnValue: string`, `error: string \| null`, `durationMs: number` | the run finished (`ok: false` when the code threw) |

### 3.3 parent → worker (tool replies)

| message | fields | meaning |
|---|---|---|
| `{ t: "toolResult" }` | `id: number`, `ok: boolean`, `value: unknown`, `error: string \| null` | result of the mediated call; `value` must be structured-cloneable (parent stringifies non-cloneable results first, §5) |

The worker never initiates anything else. Unknown messages → ignore +
`console.error` to stderr. The worker must never die silently: any unhandled
rejection in its plumbing sends `runResult { ok: false }` for the in-flight
run.

## 4. Worker internals (`utils/repl-worker.js`)

State: `ctx` (vm context), `pending` (Map id → resolver), `stdoutBuf`,
`stdoutTruncated`, `runCounter`, `nextId`.

**On `init`:**
1. `print = (...vals) => …` — append `vals.map(String).join(" ") + "\n"` to
   `stdoutBuf`; when the buffer would exceed `maxStdoutChars`, slice to the
   cap and append `\n…[stdout truncated]` once (`stdoutTruncated = true`).
2. `console = { log: print, warn: print, error: print }`.
3. For each tool name, an async proxy:
   `(...args) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); send({ t: "toolCall", id, name, args }); })`.
   If the channel cannot clone `args`, send `args.map(String)` instead.
4. Spread the `context` values into the sandbox object.
5. `ctx = vm.createContext(sandbox, { name: "repl" })`; send `{ t: "ready" }`.

**On `run`:**
1. Reset `stdoutBuf` / `stdoutTruncated`; `t0 = Date.now()`.
2. `wrapped = "(async () => {\n" + code + "\n})()"`.
3. `p = vm.runInContext(wrapped, ctx, { filename: "repl-" + (++runCounter) + ".js" })`.
4. `ret = await p` → send `runResult { id, ok: true, stdout, truncated, returnValue: serializeReturn(ret), error: null, durationMs }`.
5. On throw `e` → send `runResult { id, ok: false, …, error: formatError(e) }`
   where `formatError(e) = e.name + ": " + e.message + "\n" + (e.stack || "").slice(0, 500)`.

**On `toolResult`:** resolve the pending promise with `{ ok, value, error }`;
the proxy returns `value` when `ok`, otherwise throws `new Error(error)`.

**On `close`:** `process.exit(0)`.

Any unhandled rejection in the worker plumbing must send `runResult
{ ok: false }` for the in-flight run — the worker never dies silently.

## 5. Return-value serialization (canonical rule)

Used by the worker for `returnValue`, and by the parent for non-cloneable
tool results:

- `undefined` → `"(none)"`
- `null` → `"null"`
- `string` / `number` / `boolean` / `bigint` → `String(v)`
- object / array → `JSON.stringify(v)` truncated at 20000 chars + `"…[truncated]"`
- `function` / `symbol` / anything else → `String(v)`

## 6. `replToolsNote` template

Generated text (exact shape; `<…>` filled from the tools map):

```
## REPL (agent mode)

Your only tool is `repl({ code })`. It runs your JavaScript in a persistent
sandbox and returns { stdout, return, error }. The functions below are all
async — always `await` them.

Available functions:
- <name>(<param1>, <param2>?, …) — <one-line description>
- …
- print(...values) — write to stdout (console.log also works).

Rules:
- Variables persist between repl calls. Use a top-level `return` to produce a final value.
- Your working folder is the volume folder; use paths relative to it (e.g. "wiki.md").
- Write output files with writeFile (complete contents) or editFile (targeted fixes). When writing a complete file, always OVERWRITE it entirely with writeFile; never append.
- Never print full file contents unless you must — compute what you need in code and print only the result.
- If a call errors, read the error, fix the code, and try again.
- When you are done, reply with a short summary as plain text (no repl call).
```

The stage base prompts already name the output files (wiki.md /
shared-wiki.md / glossary.md / …), so the note stays generic.

## 7. Env vars

Read at `createReplTool` time; defaults in parentheses. Documented in
`.env.example` in Phase 4.

| var | default | meaning |
|---|---|---|
| `REPL_MODE` | `false` | master switch for agent stages (`"true"` enables) |
| `REPL_CALL_TIMEOUT_MS` | `120000` | per-run wall-clock cap (kill + respawn on exceed) |
| `REPL_TOOL_TIMEOUT_MS` | `60000` | per mediated tool call backstop |
| `REPL_MAX_STDOUT` | `200000` | per-run stdout cap (chars) |
| `REPL_MAX_ERRORS` | `5` | consecutive run errors before the stop message |
| `REPL_MAX_HEAP_MB` | `1024` | worker `--max-old-space-size` |

## 8. `harness.js` integration spec

- `createAgentHandle` gains two options:
  - `repl` (boolean, default `false`)
  - `replContext` (object, default `{}`) — passed through to `createReplTool`.
- When `repl` is true:
  1. `const { replTool, close: closeRepl } = createReplTool({ tools, approve, context: replContext, cwd, label: name });`
  2. The Agent is created with `tools: { repl: replTool }` — the raw tools
     map is **not** registered (that is the point).
  3. `handle.close()` awaits `closeRepl()` in addition to `agent.close()`.
- When `repl` is false: exactly today's code path (no behavior change).
- `summarizeInput`: for `toolName === "repl"`, truncate at 4000 chars (keep
  the `…` marker); other tools unchanged (120).
- New exports: `replMode`, `replToolsNote`, `createReplTool`.
- `types.js`: add `ReplToolCfg`, `ReplHandle`; extend `CreateAgentHandleCfg`
  with `repl` / `replContext`.

## 9. Error message formats (exact — tests may assert on these)

| case | message |
|---|---|
| unknown function | `unknown function: foo — available: readFile, writeFile, …` |
| denied by gate | `denied by policy: writeFile` |
| bad args | `invalid arguments for wikiSearch: <first zod issue message>` |
| tool threw | `wikiSearch failed: <err.message>` |
| tool timeout | `wikiSearch timed out after 60000ms` |
| run error | `<ErrorName>: <message>` + truncated stack |
| run timeout | `timed out after 120000ms — sandbox reset; all variables lost, re-read anything you need` |
| worker crash | `sandbox crashed (<exit info>) — reset; all variables lost` |
| max errors | `stopped after 5 consecutive repl errors — stop calling repl and give your final answer in plain text` |

## 10. Speculation extension point (v1: interface only)

**Do not implement speculation (sPTC).** Reserve the shape: a future
`createReplTool` option `onCodeDelta(delta)` plus a `resolve(name, args) →
hit|miss` pair would mirror the sPTC daemon's `feed`/`resolve` protocol.
v1 must not design against it — keep the run boundary clean (one code
string in, one report string out) so the hook can be added later without
breaking changes.



# Context Management Design — delivery-layer agents

**Status:** design only. No code written. Review before implementation.
**Written:** 2026-10-06, from the live failure recorded in `.logs/2026-10-06T18-27-47-227Z/`.
**Scope decision (account owner, 2026-10-06):** the delivery layer is uncapped and self-compacting. **The pipeline stage agents are not allowed to compact their own context.** That boundary is a role rule, not a knob.

---

## 1. Why this document exists

### 1.1 The measured failure

The diagnostics turn on ticket `TCK-delivery-2026-10-06T18-27-38-632Z-1`:

| Fact | Value | Source |
|---|---|---|
| Duration | 702 s | `.logs/2026-10-06T18-27-47-227Z/agent-diagnostics/turn-001.md` header |
| Input tokens, whole turn | 7,217,748 | same header |
| Output tokens | 113,374 (189,433 chars of it reasoning) | same |
| Tool calls | 73 (44 grep, 18 readFile, 11 listFiles) | same |
| Step limit it hit | 39 | `diagnosticsMaxStepsFor(154317 bytes)` |
| Final answer | **0 characters** | `summary.log`: `content=0 chars … NO CONTENT` |
| Ticket outcome | still `open`, no diagnosis, no options | `.postmortem/tickets.json` |

The downstream consequence: the dev team is summoned **only** by an answered ticket whose chosen option says `requiresCodeChange`. An unanswered ticket means the fix role never runs. There is no `.postmortem/patches.json` on this machine at all.

### 1.2 The transcript was over the window

The turn reported 7,217,748 input tokens across 39 steps. Average 185,070 per step. Assuming roughly linear growth from a ~10,000-token opening, the **last step carried about 360,000 tokens** against a configured window of 262,144 (`AI_CONTEXT_WINDOW`).

### 1.3 Three defects, each independent

**Defect A — compaction only runs between conversations, never inside one.**
`core.Session.send()` checks whether it should compact exactly once, before the agent starts. `core.Agent.run()` then runs the entire multi-step loop inside a single `streamText` call and exposes no per-step hook. A single long investigation therefore grows in one direction.

**Defect B — the yardstick is wrong for Japanese text.**
`@openharness/core` estimates conversation size as `JSON.stringify(messages).length / 4` (`dist/utils.js:37`). This project's own measurement of a whole Japanese light novel is **1.6–1.7 characters per token** (128,744–176,201 chars → 75,757–109,628 tokens, AGENTS.md gotcha 54). A transcript that really holds 360,000 tokens is estimated at ~148,500 — **39% below** the compaction trigger of `262,144 − 20,000 = 242,144`. The machinery looks at a full room and reports empty space.

**Defect C — pipeline stage agents have compaction switched on right now, silently.**
`dist/session.js:135`: `autoCompact = options.autoCompact ?? options.contextWindow !== undefined`. `harness.js:2170` always passes a `contextWindow`. Therefore **every agent handle in the pipeline currently has automatic lossy compaction enabled between turns**, and AGENTS.md gotcha 56 already names what that looks like in practice: *"it is how 'the agent quietly stopped honoring the honorific rules' first shows up — as a worse artifact, not as a failure."*

This design closes A and B for the delivery layer, and **turns C off** for the pipeline.

---

## 2. What we are adopting, and from what

Source: **ACM: Agentic Context Management for Long Horizon Tasks**, Li, Ming, Chu, Shao, Jin, Xiong — Carnegie Mellon + Meta, arXiv:2607.23809, July 2026.

ACM adds two tools to the agent's own tool belt:

- `manage_context` — compresses earlier turns into a short summary **and writes the raw turns to a file on disk**. Each summary gets an id pointing at the raw text it replaced.
- `query_memory` — asks the stored raw text a question and returns only the relevant part.

Its two claims: compression is **lossless** (nothing is discarded, everything is retrievable) and **agent-initiated** (the agent decides when, not a timer). Reported effect: ~20% lower peak token use, more tool calls, longer exploration. One documented case traversed a 222K-token raw history while keeping its working window under 100K.

### What we take

| ACM idea | Adopted? | How it changes here |
|---|---|---|
| Offload raw turns to disk, keep an id | ✅ | Our agents already work on a filesystem and everything they read is already on disk. An offload is mostly a *reference*, not a copy. Genuinely lossless, near-zero cost. |
| Agent-initiated compression | ✅ with a backstop | See below. |
| A "querier LLM" answers memory queries | ❌ replaced | Deterministic substring search of the offloaded text. Cheaper, cannot hallucinate, and consistent with AGENTS.md gotcha 67 ("the deterministic tier is the one that runs for free"). |
| Post-training the model to time compression | ❌ impossible here | We run a local model we do not train. Substitute: the harness reports the agent's own pressure in every tool result, and a hard threshold forces offload if the agent never acts. |
| Summarise-and-replace as the compression primitive | ⚠️ demoted | Offloading payloads is the first move. A model-written summary is the last resort, not the default. |

### The finding that shapes the whole design

ACM's own behaviour study (their Figure 4): **GPT-5.5 called `manage_context` and `query_memory` almost zero times.** Their entire post-training pipeline exists because models do not voluntarily manage their own context. Their case study shows what makes it work — the model narrating its own token count: *"context is at 40,982 tokens, approaching half of 81,920 — I need to manage context soon."*

So the load-bearing part of this design is not the tools. It is **making the agent see its own pressure**. Tools alone will sit unused.

---

## 3. Hard rules

These are boundaries, not preferences. Each gets a test.

**R1 — Only delivery-layer roles compact.** `utils/diagnostics.js`, `utils/devteam.js`. The pipeline stage agents (glossary, character-voice, style-guide, jump-in-wiki, consistency-audit, series intake) get `autoCompact: false` and no context-management tools. Their whole value is holding the book and the cumulative reference in mind at once.

**R2 — No environment knob for R1.** A constraint the role can switch off is not a constraint (AGENTS.md gotcha 70). Whether a role may compact is decided in code, per role.

**R3 — Write-side history is never offloaded.** For the dev team, every `writeFile` / `editFile` call **and its result** stays in the conversation verbatim for the whole turn. Losing them would break the "a patch shows its changes" contract (gotcha 75): the agent would re-edit a place it already edited, or declare a file list that does not match the tree.

**R4 — Gate refusals are never offloaded.** A banned-path refusal or a denied `deleteFile` is evidence that lands on the ticket and in `tickets.md`.

**R5 — The ticket, the system prompt, and the tool notes are never offloaded.**

**R6 — Offloading a payload never removes the call.** The conversation keeps *what was looked up* (tool name, arguments, source file, size). Only the bulky result moves to disk. This is what keeps `crossCheckReads` honest (gotcha 74): a diagnosis is judged on the calls it really made.

**R7 — Offload files are a convenience copy. `.logs/` remains the record.** The full turn transcript is still written by `writeAgentTurnLog`, unchanged.

**R8 — An offload must be retrievable or it is a deletion.** If the offload write fails, the offload is abandoned and the payloads stay in the conversation. Silent loss is the one outcome this design exists to prevent.

---

## 4. Architecture

### 4.1 The chunked turn

`createAgentHandle().sendTurn()` stops being one call to `session.send()` and becomes a loop:

```
turn:
  loop:
    run one CHUNK  =  session.send(chunkInput)      # chunkInput is [] after the first chunk
    read the REAL input-token count the server reported for the last step
    if the turn is finished            -> break
    if a stop condition fired          -> break, report honestly
    if the working window is under pressure:
        offload the oldest read payloads to disk, replace them with a landmark
        (fall back to a model-written summary only if offloading cannot free enough)
    continue
```

Why this works with the library as it is: `Session` re-checks its compaction condition at the start of every `send()`, and it records the server-reported input-token count on every `step.done`. Chunking gives that machinery a moment to act **inside** the turn. No fork of the agent library, no bypass of the approve gate, no reimplementation of the tool loop.

`agent.maxSteps` becomes the **chunk** size, not the turn size. The turn has no step count.

### 4.2 The pressure signal

Every tool result handed to a context-managed agent gets one appended line in its `status` field:

```
| working window: 148,000 / 262,144 tokens (56%)
```

and, past the soft threshold:

```
| working window: 231,000 / 262,144 tokens (88%) — offload with manage_context(...) before the next read
```

This is the mechanism ACM's case study shows actually produces compression behaviour. Without it the tools go unused.

### 4.3 The offload store

Location: `<run log dir>/agent-<name>/memory-<turn>-<chunk>.json` — inside `.logs/`, already gitignored machine state, already the place a diagnosis is allowed to read.

```jsonc
{
  "schema": 1,
  "id": "ctx-2026-10-06T18-27-47-227Z-diagnostics-1-2-a3f",
  "run": "2026-10-06T18-27-47-227Z",
  "agent": "diagnostics",
  "turn": 1,
  "chunk": 2,
  "at": "2026-10-06T18:33:04.117Z",
  "tokensBefore": 244110,
  "tokensAfter": 61204,
  "reason": "soft-limit",              // soft-limit | hard-limit | agent-request | summary-fallback
  "offloaded": [
    {
      "seq": 12,
      "tool": "readFile",
      "input": { "filePath": "/mnt/windows/weeb/oresuki/ai-client/glossary.js", "offset": 1930, "limit": 180 },
      "result": "<verbatim tool output>",
      "sourceFiles": ["/mnt/windows/weeb/oresuki/ai-client/glossary.js"],
      "bytes": 11840
    }
  ],
  "kept": { "writeCalls": 0, "refusals": 0, "recentTokens": 41200 }
}
```

`sourceFiles` is what makes recall cheap and honest: the offload knows which real file each payload came from, so a recall can say *"this text came from glossary.js lines 1930–2110, which is still on disk."*

### 4.4 The landmark — exact wording

Inserted into the conversation in place of the offloaded payloads. One block, capped at 12 lines.

```
[context offload ctx-2026-10-06T18-27-47-227Z-diagnostics-1-2-a3f]
12 earlier lookups moved to disk so this turn can keep working. Nothing was discarded.
  readFile  glossary.js  offset 1930 +180
  readFile  glossary.js  offset 2110 +120
  grep      "rejected|carryForward|CARRY_FORWARD|quarantine"  in ai-client/glossary.js  -> 80 matches
  listFiles ai-client/.postmortem
  +9 more
Retrieve any of it verbatim: recall_memory("<what you are looking for>", "ctx-2026-10-06T18-27-47-227Z-diagnostics-1-2-a3f")
```

The landmark is deliberately a *map of what was looked at*, because that is the half the agent needs in order to decide what to re-fetch. The failed run re-opened `glossary.js` twelve times precisely because it had no such map.

### 4.5 `recall_memory`

```js
recall_memory({ query: string, id?: string, limit?: number })
```

Returns:

```jsonc
{
  "matched": [
    { "id": "ctx-…-a3f", "seq": 12, "tool": "readFile",
      "input": { "filePath": "…/glossary.js", "offset": 1930, "limit": 180 },
      "sourceFile": "…/glossary.js",
      "excerpt": "<verbatim matching lines, bounded by RECALL_MAX_BYTES>" }
  ],
  "matchedCount": 3,
  "truncated": false,
  "note": "recall_memory searches only what THIS turn already read. The original file is still on disk: readFile(\"…/glossary.js\", offset=1930, limit=180) returns it whole."
}
```

Rules:

- **Plain substring matching, case-insensitive.** Not regular expressions — this codebase already learned that a regex dialect from another language trips the agents and answers "no matches" for a search that should have hit (gotcha 60).
- **Serves only content this same turn already legitimately read.** That is the safety argument: `recall_memory` cannot become a side door to a file the role's own sandbox would have refused. The store is keyed by run + agent + turn.
- Bounded by `RECALL_MAX_BYTES` (default 16,384) per call.
- For `crossCheckReads`: a `recall_memory` hit counts as reading the **original `sourceFile`**, not the offload file. A diagnosis should cite `glossary.js`, and the cross-check should agree.

### 4.6 `manage_context` (agent-initiated)

```js
manage_context({ note?: string })
```

The agent may call it whenever it judges its own reading is no longer needed in raw form. It does **not** rewrite the message list mid-step — that is fragile inside the streaming loop. It sets a flag; the harness performs the offload at the next chunk boundary (at most one step away) and the tool result says so:

```
{"scheduled": true, "appliesAt": "next chunk boundary", "note": "…", "workingWindowTokens": 231004}
```

### 4.7 The estimator adapter

`utils/context.js` exports an estimator built on `utils/tokens.js` — the project's calibrated, script-aware coefficients — and hands it to the compaction machinery in place of `characters / 4`.

```js
function estimateMessagesTokens(messages) -> number
// Serialises each message's text content, measures its CJK-vs-everything-else character
// counts (scriptMixOf), applies the calibrated coefficients, applies TOKEN_ESTIMATE_MARGIN.
// Never under-estimates: the same rule tokenBudgetFor already follows (gotcha 54).
```

The trigger uses `max(serverReportedInputTokens, estimateMessagesTokens(messages))`. The server's number is authoritative when present; the estimate is what catches a session that grew during a chunk before the server ever reported it.

### 4.8 The repetition detector

With no step limit, this is the primary stop.

```js
function repeatDetector() -> { observe(toolCall) -> null | { repeated: true, call, count } }
```

A call counts as a repeat when **both**:
1. the tool name and the normalised argument JSON are identical to an earlier call in the same turn, **and**
2. its result is byte-identical to that earlier call's result.

Condition 2 is what keeps this honest: re-reading a file after editing it, or re-running a grep after a different file changed, is legitimate work and is not counted. Re-running the identical search against an unchanged answer three times is a loop.

At `AGENT_REPEAT_LIMIT` (default 3) identical-and-identical calls, the turn stops with a distinct, greppable finish:

```
[call-ai] WARNING: diagnose-… stopped: the same lookup ran 3 times with an identical result
          (grep "carryForward" in ai-client/glossary.js). This is a loop, not a long task.
          Its reading so far is in .logs/<run>/agent-diagnostics/turn-001.md
          and in the offload files listed in that log.
```

A second signal: compaction firing `AGENT_COMPACT_EXHAUSTION` (default 3) times in a row with no new distinct tool call between them. That means the *kept* material alone (system prompt + ticket + write history + recent work) no longer fits, which is a different problem and must be reported as such rather than compressed harder.

This is a **repetition detector, not a spending limit.** It is consistent with the standing decision that these roles get no token budget (AGENTS.md §9, "a spending limit would hide the spin behind a cost error, and the spin is the thing this layer exists to catch").

### 4.9 The turn ceiling

```
AGENT_TURN_MAX_MS   default 7,200,000  (2 hours)   total wall-clock for ONE turn
```

This is deliberately a *total* bound, and it is deliberately distinct from `AI_CALL_DEADLINE_MS`, which is an **idle** bound and must stay idle (gotcha 26). A 2-hour ceiling on a single decision turn is not the same claim as a ceiling on a 17-volume stage, which is why `INDEX_STEP_TIMEOUT_MS` stays at 0 and untouched.

When it fires, the turn is reported as **unfinished work**, never as a clean failure. For the dev team that means reusing the rule that already exists (gotcha 75): print the patch id, the files it already changed, and `npm run fix -- --revert=<id>`, because the code it wrote is already in the tree.

### 4.10 Logging

`consumeEvents` currently discards the compaction lifecycle (`harness.js:1723`, `default: // turn.* / compaction.* lifecycle events: nothing to accumulate`). It becomes a first-class log line:

```
[context] diagnose-… offloaded 12 lookups (244,110 -> 61,204 tokens) -> .logs/<run>/agent-diagnostics/memory-1-2-a3f.json
[context] diagnose-… recall_memory("carryForward") -> 3 matches from ctx-…-a3f
[context] diagnose-… working window 231,004 / 262,144 (88%)
```

Plus one line in `summary.log` at the end of every context-managed turn: peak working window, number of offloads, number of recalls. Without this, the next incident is again invisible in the logs.

---

## 5. New module: `utils/context.js`

```js
/** Whether context management is on for this handle (delivery-layer roles only). */
function contextManagementEnabled(role) -> boolean

/** The calibrated message estimator handed to the compaction machinery. */
function estimateMessagesTokens(messages) -> number

/** Working-window pressure, from the server's own count and the estimate. */
function windowPressure({ lastInputTokens, messages, contextWindow }) ->
  { tokens, window, fraction, level: "ok" | "soft" | "hard" }

/** Append the pressure line to a tool result's status string. */
function annotateToolResult(result, pressure) -> result

/** Move the oldest READ payloads to disk and return the landmark that replaces them. */
function offload({ runId, agentName, turn, chunk, messages, targetTokens }) ->
  { id, file, offloadedCount, tokensBefore, tokensAfter, landmark, ok }
  // ok:false when the offload file could not be written — the caller then keeps
  // everything in the conversation (R8). Never a partial offload.

/** Search the offloaded text for this turn. */
function recall({ runId, agentName, turn, query, id, limitBytes }) ->
  { matched, matchedCount, truncated }

/** The landmark text. */
function renderLandmark(offload) -> string

/** Loop detection. */
function repeatDetector() -> { observe(toolCall) -> null | { repeated, call, count } }

/** Turn-wide wall clock. */
function turnClock(maxMs) -> { startedAt, elapsedMs, exceeded() }
```

---

## 6. Changes to `harness.js`

`createAgentHandle` gains three options, all defaulting to the current behaviour:

```js
createAgentHandle({
  …,
  contextManagement = false,   // R1: only the delivery layer passes true
  chunkSteps,                  // steps per chunk when contextManagement is on
  turnMaxMs,                   // total ceiling for one turn when contextManagement is on
})
```

Inside:

1. `new core.Session({ …, autoCompact: contextManagement, compactionStrategy: contextManagement ? acmStrategy : null, shouldCompact: … })`
   — **`autoCompact` becomes explicit instead of accidentally-true.** This is the fix for Defect C.
2. `sendTurn` becomes the chunked loop of §4.1.
3. `consumeEvents` handles `compaction.start` / `compaction.pruned` / `compaction.summary` / `compaction.done`.
4. The tool set is wrapped so each result carries the pressure line (§4.2).
5. **Turn-wide state stays turn-wide.** The runaway-text guard, the tool-call list, the repetition detector and the turn clock must not reset per chunk, or chunking silently weakens the guard.
6. `writeAgentTurnLog` writes **one log per turn**, assembled from all chunks, so existing log-reading habits and `crossCheckReads` keep working.
7. The step-cap WARNING (`harness.js:2227`) is replaced by the new stop-condition warnings.

---

## 7. Changes per role

### 7.1 Diagnostics (`utils/diagnostics.js`)

- Delete `diagnosticsMaxStepsFor` and `DIAGNOSIS_STEP_CAP_CEILING`. Uncapped.
- `createAgentHandle({ …, contextManagement: true })`.
- Add `manage_context` and `recall_memory` to the read-only tool set. They are reads, so the read-only guarantee is unchanged — and the composed approve gate still denies every mutating call.
- `DIAGNOSIS_TOOLS_NOTE` gains: the two new tools, the pressure line's meaning, and one instruction that follows ACM's finding — *"when the working window line says it is getting full, offload before you read again rather than after."*
- `crossCheckReads` learns the `recall_memory` → original-file rule from §4.5.

### 7.2 Dev team (`utils/devteam.js`)

- Delete `devteamMaxStepsFor` and its 160 ceiling. Uncapped.
- `createAgentHandle({ …, contextManagement: true })`.
- Add the two tools. **R3 enforced here**: `offload()` is told which calls are mutating and never touches them.
- `DEVTEAM_TOOLS_NOTE` gains the same paragraph, plus: *"your own edits are never removed from your context."*
- The tree fingerprint and the declared-files cross-check stay **turn-wide**, not per chunk.
- The turn-ceiling path reuses the existing unfinished-patch reporting.

### 7.3 Delivery manager (`utils/manager.js`)

There is no step limit to remove: it is one tool-less call (`harness.runOneShot`, `maxSteps: 1` at `harness.js:1970`), and today its two real calls cost 4,054 and 3,390 input tokens. It has no session, so there is nothing to compact.

What it *would* need if its brief ever grows is the same fit-to-window budget the translation stage already uses (`fitPromptBudget`), with the drop logged rather than silent (gotcha 43). **Proposed as a separate, optional change** — not part of this patch, because nothing today suggests the brief is near any limit.

### 7.4 Pipeline stage agents — the change is a *reduction*

`glossary.js`, `character-voice.js`, `style-guide.js`, `jump-in-wiki.js`, `consistency-audit.js`, `get-translation-target.js`:

- Their `createAgentHandle` calls pass `autoCompact: false` explicitly.
- Their reading-scaled step caps (`validatorMaxStepsFor`, `authorMaxStepsFor`, `findingsMergeMaxStepsFor`) **stay exactly as they are.**
- They get no context-management tools and no pressure line.

**What this changes in practice, and why it is the right direction.** Today, when a stage agent's session outgrows the window, the library silently rewrites its memory and the run continues with a degraded agent — the failure AGENTS.md gotcha 56 describes as *"a worse artifact, not a failure."* With compaction off, the same situation becomes the server refusing the request, which `tagSizeOverflowError` already recognises and tags as `tooBigForOnePassError`, which is **the one failure `runVolumeWithModeFallback` exists to repair** — wipe the attempt and re-run that volume chapter by chapter (gotcha 55).

In other words: turning off silent compaction makes the pipeline's existing, deliberate fallback actually fire instead of being pre-empted by a silent lossy shortcut. That is the strongest argument for R1 and it should be stated in AGENTS.md.

---

## 8. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_CONTEXT_CHUNK_STEPS` | `12` | Steps per chunk inside a context-managed turn. Not a turn limit. |
| `CONTEXT_SOFT_LIMIT` | `0.70` | Fraction of the window at which the pressure line starts urging offload. |
| `CONTEXT_HARD_LIMIT` | `0.90` | Fraction at which the harness offloads whether the agent asked or not. |
| `CONTEXT_KEEP_RECENT_TOKENS` | `40000` | The most recent work is never offloaded. |
| `RECALL_MAX_BYTES` | `16384` | Largest single `recall_memory` answer. |
| `AGENT_REPEAT_LIMIT` | `3` | Identical call + identical result, how many times, before the loop stop. |
| `AGENT_COMPACT_EXHAUSTION` | `3` | Consecutive compactions with no new distinct work before reporting "the kept material no longer fits". |
| `AGENT_TURN_MAX_MS` | `7200000` | Total wall clock for one delivery-layer turn. |

**Deliberately absent:** any variable that decides *whether a pipeline stage may compact*. R2. A role boundary the role can un-check is not a boundary.

---

## 9. Test plan

New `test/test-context.js` (pure + real temp files, no model call):

1. **The ruler.** `estimateMessagesTokens` on a Japanese-heavy transcript lands within the calibrated band and is **not** the `chars/4` number. Asserts the specific failure: a 360K-token Japanese transcript is *not* estimated at 148K.
2. **Offload → recall round-trip.** Payload leaves the conversation, the landmark names the file and offset, `recall_memory` returns it verbatim.
3. **R3.** A turn containing `editFile` calls: after offloading, every mutating call and its result is still present, byte-for-byte.
4. **R4.** A gate refusal survives offloading.
5. **R6.** The call survives, only the payload moves.
6. **R8.** Offload file write fails (read-only directory) → nothing is removed from the conversation, and the failure is reported.
7. **Recall is scoped.** A query cannot reach another turn's or another agent's offload.
8. **Repetition detector.** Fires on three identical calls with identical results; does **not** fire on three identical calls whose results differ (a file changed between them); does not fire on 30 distinct calls.
9. **Exhaustion.** Kept material alone over the window → reported as "does not fit", not compressed harder.
10. **R1 pinned both ways.** A diagnostics handle has context management on; a glossary/voice/style/wiki/audit/intake handle has it **off**, and `autoCompact` is explicitly `false` for them.

New scenario in `test/test-fake-backend.js` (drives the real harness):

11. **`longTurn`** — a scripted endpoint that keeps answering with tool calls for 60 steps. Asserts: the turn is chunked, compaction fires **inside** the turn, the turn still reaches an answer, and `summary.log` contains the `[context]` lines.
12. **`loopStuck`** — the scripted endpoint repeats one identical call. Asserts the turn stops at the repeat limit and the log names the repeated call.
13. **`tooBigNoCompaction`** — a pipeline stage handle with compaction off, scripted to refuse as too large. Asserts the error is tagged `tooBigForOnePass` and `runVolumeWithModeFallback` actually re-runs the volume chapter by chapter. This is the consumer-side proof of §7.4.

Updates to existing suites:

14. `test/test-diagnostics.js` — an uncapped turn that compacts mid-way still records its real tool calls, and its answer's citations still validate under `crossCheckReads` (including a `recall_memory` hit counting as the original file).
15. `test/test-devteam.js` — an uncapped turn still lands exactly one edit, its declared files still match the tree fingerprint, and a turn cut off by the ceiling is reported as an **unfinished patch** with the revert command.
16. `test/test-prompt-audit.js` — a rule that a delivery-layer request advertises `manage_context` / `recall_memory` and a pipeline-stage request does **not**.

---

## 10. Risks, and what is still open

1. **Disk growth.** Offload files live under `.logs/`, already gitignored machine state, one per chunk of a delivery-layer turn. A 39-step turn produces roughly 3–4 files. Bounded, but retention should be stated.
2. **Cost.** Uncapped + a 2-hour ceiling means a lost agent can run far longer than today's 12 minutes. The repetition detector is the main protection and its thresholds are the tuning knob. This is the price of the uncapping decision and it should be visible in the log line, not hidden.
3. **The agent may still not use the tools.** ACM's own evidence says frontier models mostly don't. The pressure line plus the hard threshold is the mitigation; if the hard threshold is doing all the work, that is a finding worth reading in the logs rather than a reason to remove the agent-initiated path.
4. **`crossCheckReads` semantics.** Getting §4.5 wrong would make an honest diagnosis look like it fabricated its reading — the exact failure gotcha 74 warns about ("a check that accuses an honest diagnosis is a check the next incident routes around"). Test 14 is the guard.
5. **Turning off pipeline compaction changes failure modes.** Some volumes that today limp through on a silently-compacted session will instead fail and fall back to chapter-by-chapter. That is the honest behaviour, but it may make a run *look* worse before it makes the artifacts better. Worth watching on the first live run and worth saying out loud in AGENTS.md.
6. **Chunk boundaries and streaming.** A chunk ends at a step boundary. If a chunk boundary lands mid-way through a batch of parallel tool calls, the pairing of call to result must survive — pairing is by `toolCallId` (gotcha 61) and must not be reset per chunk.
7. **The manager.** Genuinely has nothing to compact. If the account owner wants the manager's brief budgeted to the window, that is a separate small change and should be judged separately.

---

## 11. Build order

1. `utils/context.js` + `test/test-context.js` — the estimator, offload, landmark, recall, repeat detector. Pure, no model, testable alone.
2. `harness.js` — the chunked turn, explicit `autoCompact`, compaction event logging, turn-wide guard state. `test/test-fake-backend.js` scenarios 11–13.
3. `utils/diagnostics.js` + `utils/devteam.js` — uncap, the two tools, the tool-note text. Their suite updates.
4. Pipeline stage handles — `autoCompact: false`, caps untouched. Test 1's R1 half.
5. AGENTS.md — new file-map row for `utils/context.js`, the new env table, and **gotcha 78** recording the whole argument: the three defects, the delivery-layer-only boundary, why the pipeline must not self-compact, and the fact that turning off silent compaction is what makes the existing chapter-by-chapter fallback fire.

Each step ends with `npm test` and `npm run pipeline-loop` green.

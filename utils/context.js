/**
 * utils/context.js — context management for the delivery layer's long turns.
 *
 * WHY THIS EXISTS
 * ---------------
 * The delivery layer's two agent roles (the diagnostics team, the dev team) do a
 * kind of work the pipeline's stage agents do not: they investigate. One live
 * turn — `.logs/2026-10-06T18-27-47-227Z/` — ran 73 lookups over 702 seconds,
 * billed 7,217,748 input tokens, and answered with **zero characters** because
 * it ran out of turn budget while it was still reading. Its last step was
 * carrying roughly 360,000 tokens against a 262,144-token window.
 *
 * Three separate defects produced that, and this module is the answer to all
 * three (CONTEXT-MANAGEMENT-DESIGN.md §1.3):
 *
 *   A. **Compaction only ran between conversations, never inside one.** The agent
 *      library checks "am I too full?" once, before a conversation starts, and
 *      then runs the whole multi-step investigation without asking again. A long
 *      turn therefore only ever grows.
 *
 *   B. **The yardstick was wrong for this project's text.** The library estimates
 *      a conversation as `JSON.stringify(messages).length / 4`. That is a fair
 *      rule for English. This project measured a whole Japanese light novel at
 *      **1.6–1.7 characters per token** (AGENTS.md gotcha 54), so a transcript
 *      really holding 360,000 tokens is estimated at ~148,000 — 39% below the
 *      point where the library would trim. It looks at a full room and reports
 *      empty space. `estimateMessagesTokens` below replaces that yardstick with
 *      the project's own calibrated, script-aware one.
 *
 *      (Worth recording: the library's own trimming step writes its "[pruned]"
 *      marker to a message field the current AI SDK does not read, so its
 *      cheap-first phase saves nothing and it falls through to replacing the
 *      whole conversation with a model-written summary. That is the lossy path,
 *      and it is the one AGENTS.md gotcha 56 describes as "a worse artifact, not
 *      a failure".)
 *
 *   C. **Every agent handle had silent lossy compaction switched on**, because
 *      the library turns it on whenever a context window is passed and the
 *      harness always passes one. Fixed in harness.js by passing
 *      `autoCompact: false` explicitly.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * It implements the ACM idea (Agentic Context Management, Li et al., CMU + Meta,
 * arXiv:2607.23809, July 2026): **offload instead of delete**. When a turn's
 * working window gets full, the oldest bulky *read* payloads move to a file on
 * disk and stay in the conversation as a short map of what was looked at. The
 * agent can then ask that file a question and get the matching text back.
 * Nothing is thrown away, so compression is reversible.
 *
 * The paper's own behaviour study is the reason the pressure line matters more
 * than the tools: GPT-5.5 called their context-management tools almost zero
 * times unaided. Their whole post-training pipeline exists because models do not
 * voluntarily manage their own context. We cannot train a model, so the harness
 * reports the agent's own pressure in every tool result and offloads on the
 * harness's own trigger when the agent does not ask.
 *
 * SCOPE — this is the delivery layer only, and that boundary is a rule, not a
 * knob (design R1/R2). The pipeline's stage agents exist to hold the whole book
 * and the whole cumulative reference in mind at once; compacting them trades
 * artifact quality for token savings, which is the trade AGENTS.md gotcha 56 says
 * this project has already paid for once.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const { tool } = require("ai");
const { z } = require("zod");

const { scriptMixOf, estimateMix, activeCoefficients, tokenEstimateMargin } = require("./tokens");

// ─── Which roles may compact ────────────────────────────────────────────────

/**
 * The delivery-layer roles that manage their own context.
 *
 * Deliberately not an environment variable (design R2): a constraint a role can
 * switch off is not a constraint (AGENTS.md gotcha 70). Whether a role may
 * compact is decided here, in code, and `test/test-context.js` pins that no other
 * module opts in.
 */
const CONTEXT_MANAGED_ROLES = ["diagnostics", "devteam"];

/**
 * @param {string} name - An agent handle name.
 * @returns {boolean} Whether this name is a delivery-layer role.
 */
function contextManagementEnabled(name) {
  return CONTEXT_MANAGED_ROLES.includes(name);
}

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Steps one chunk of a context-managed turn is allowed to run.
 *
 * This is NOT a turn limit. The turn has no step count (the account owner's
 * decision, 2026-10-06); it is a chunk of one, and the harness keeps starting
 * chunks until the agent answers or a stop condition fires. Its only job is to
 * create the boundary where the working window gets measured and, if needed,
 * trimmed.
 *
 * @returns {number} AGENT_CONTEXT_CHUNK_STEPS, default 12, minimum 1.
 */
function contextChunkSteps() {
  const n = parseInt(process.env.AGENT_CONTEXT_CHUNK_STEPS, 10);
  return Number.isFinite(n) && n >= 1 ? n : 12;
}

/**
 * The fraction of the window at which the pressure line starts urging the agent
 * to offload, and at which the harness offloads on its own.
 * @returns {number} CONTEXT_SOFT_LIMIT, default 0.70, clamped to (0, 1).
 */
function contextSoftLimit() {
  const n = parseFloat(process.env.CONTEXT_SOFT_LIMIT);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return 0.7;
  return n;
}

/**
 * @returns {number} CONTEXT_HARD_LIMIT, default 0.90, clamped to (soft, 1).
 */
function contextHardLimit() {
  const n = parseFloat(process.env.CONTEXT_HARD_LIMIT);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return 0.9;
  return Math.max(n, contextSoftLimit());
}

/**
 * How much of the most recent work is never offloaded. The agent needs its
 * immediate surroundings intact: the finding it is in the middle of acting on is
 * the one thing it must not have to re-fetch.
 * @returns {number} CONTEXT_KEEP_RECENT_TOKENS, default 40000, minimum 1000.
 */
function contextKeepRecentTokens() {
  const n = parseInt(process.env.CONTEXT_KEEP_RECENT_TOKENS, 10);
  return Number.isFinite(n) && n >= 1000 ? n : 40000;
}

/**
 * The smallest a recall answer may be allowed to be, whether it comes from the
 * env knob or from the agent's own `limit` argument. A 1-byte answer reads as
 * "the text is not there", which is gotcha 60's silent-nothing failure reappearing
 * as a size setting instead of a wildcard.
 */
const RECALL_MIN_BYTES = 512;

/**
 * The largest single `recall_memory` answer. A recall that returns everything is
 * an offload that never happened.
 * @returns {number} RECALL_MAX_BYTES, default 16384, minimum 512.
 */
function recallMaxBytes() {
  const n = parseInt(process.env.RECALL_MAX_BYTES, 10);
  return Number.isFinite(n) && n >= RECALL_MIN_BYTES ? n : 16384;
}

/**
 * How many times the same lookup may run with the same answer before the turn is
 * called a loop.
 *
 * This is a repetition detector, not a spending limit (design §4.8). It is
 * consistent with the standing decision that these roles get no token budget
 * (AGENTS.md §9): "a spending limit would hide the spin behind a cost error, and
 * the spin is the thing this layer exists to catch."
 *
 * @returns {number} AGENT_REPEAT_LIMIT, default 3, minimum 2.
 */
function agentRepeatLimit() {
  const n = parseInt(process.env.AGENT_REPEAT_LIMIT, 10);
  return Number.isFinite(n) && n >= 2 ? n : 3;
}

/**
 * How many consecutive trims with no new distinct work mean the kept material
 * itself no longer fits — a different problem from "needs trimming", and one that
 * must be reported rather than compressed harder.
 * @returns {number} AGENT_COMPACT_EXHAUSTION, default 3, minimum 2.
 */
function agentCompactExhaustion() {
  const n = parseInt(process.env.AGENT_COMPACT_EXHAUSTION, 10);
  return Number.isFinite(n) && n >= 2 ? n : 3;
}

/**
 * Total wall clock one delivery-layer turn may take.
 *
 * Deliberately distinct from `AI_CALL_DEADLINE_MS`, which is an IDLE bound and
 * must stay idle (AGENTS.md gotcha 26). This is the loose ceiling the account
 * owner asked for so an unattended overnight turn cannot loop forever; it is not
 * a per-step cap and it says nothing about a pipeline stage, which is why
 * `INDEX_STEP_TIMEOUT_MS` stays 0 and untouched.
 *
 * @returns {number} AGENT_TURN_MAX_MS, default 7200000 (2 h). 0 = no ceiling.
 */
function agentTurnMaxMs() {
  const n = parseInt(process.env.AGENT_TURN_MAX_MS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 7200000;
}

// ─── The ruler (defect B) ───────────────────────────────────────────────────

/**
 * The text a message actually contributes to the prompt.
 *
 * A ModelMessage's content is a string or an array of parts (text, reasoning,
 * tool-call with its input JSON, tool-result with its output JSON). Serialising
 * the content is what the server effectively bills, including the JSON
 * punctuation — which matters, because a tool result is a JSON object and its
 * braces and quotes are billed too.
 *
 * @param {Object} message - One AI SDK ModelMessage.
 * @returns {string}
 */
function messageText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return JSON.stringify(content);
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

/**
 * Estimate what a conversation costs the model, using THIS project's calibrated
 * coefficients instead of the library's `characters / 4`.
 *
 * The library's rule is a fair guess for English and a bad one here: Japanese
 * measures 1.6–1.7 characters per token, so dividing by four under-counts a
 * Japanese-heavy transcript by roughly 2.5×. Under-counting is the direction that
 * makes a trim happen too late, which is what defect A looked like in the logs.
 *
 * Same guarantee as `tokenBudgetFor` (gotcha 54): an OVER-estimate, with
 * TOKEN_ESTIMATE_MARGIN applied.
 *
 * @param {Array<Object>} messages - The conversation (AI SDK ModelMessages).
 * @returns {number} Estimated tokens (rounded up).
 */
function estimateMessagesTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let cjk = 0;
  let other = 0;
  for (const msg of list) {
    const mix = scriptMixOf(messageText(msg));
    cjk += mix.cjk;
    other += mix.other;
  }
  return estimateMix({ cjk, other, total: cjk + other }, { includeOverhead: false });
}

/**
 * The library's yardstick, exported so a test can name the number this module
 * exists to replace. Not used by any decision.
 * @param {Array<Object>} messages
 * @returns {number}
 */
function naiveLibraryEstimate(messages) {
  return Math.ceil(JSON.stringify(messages ?? []).length / 4);
}

// ─── Pressure ───────────────────────────────────────────────────────────────

/**
 * How full the working window is.
 *
 * Two measurements, and the larger one wins:
 *   - the server's own count for the last step (`session.lastInputTokens`) —
 *     authoritative when the server reports usage;
 *   - this module's estimate of the whole conversation — what catches a session
 *     that grew during a chunk on a server that reports no usage at all
 *     (`test/fake-backend.js` can script exactly that).
 *
 * @param {Object} input
 * @param {number} [input.lastInputTokens] - The server's count for the last step.
 * @param {Array<Object>} input.messages - The conversation.
 * @param {number} input.contextWindow - The window this handle is working against.
 * @returns {{tokens: number, window: number, fraction: number, level: "ok"|"soft"|"hard", estimated: number, reported: number}}
 */
function windowPressure({ lastInputTokens = 0, messages, contextWindow }) {
  const estimated = estimateMessagesTokens(messages);
  const reported = Number.isFinite(lastInputTokens) ? lastInputTokens : 0;
  const tokens = Math.max(estimated, reported);
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
  const fraction = window > 0 ? tokens / window : 0;
  let level = "ok";
  if (window > 0) {
    if (fraction >= contextHardLimit()) level = "hard";
    else if (fraction >= contextSoftLimit()) level = "soft";
  }
  return { tokens, window, fraction, level, estimated, reported };
}

/**
 * The line the agent sees in every tool result — the mechanism ACM's case study
 * shows actually produces context-management behaviour.
 *
 * Without it the two tools sit unused, which is what the paper measured on
 * frontier models. It is deliberately a plain number with a plain instruction.
 *
 * @param {{tokens: number, window: number, fraction: number, level: string}} pressure
 * @returns {string} e.g. `| working window: 231,000 / 262,144 tokens (88%) — offload with manage_context(...) before your next read`
 */
function pressureLine(pressure) {
  if (!pressure || !pressure.window) return "";
  const pct = Math.round(pressure.fraction * 100);
  const head = `| working window: ${pressure.tokens.toLocaleString("en-US")} / ${pressure.window.toLocaleString("en-US")} tokens (${pct}%)`;
  if (pressure.level === "hard") {
    return `${head} — FULL. Offload with manage_context(...) now; further reads will be trimmed automatically.`;
  }
  if (pressure.level === "soft") {
    return `${head} — getting full. Offload what you no longer need with manage_context(...) BEFORE your next read.`;
  }
  return head;
}

/**
 * Attach the pressure line to a tool result, so the agent sees its own pressure
 * at the moment it is deciding what to look at next.
 *
 * Handles the shapes the fs tools actually return (an object with a `status`
 * line, or a plain string) and leaves anything else alone rather than corrupting
 * it.
 *
 * @param {*} result - The tool's return value.
 * @param {Object} pressure - From windowPressure.
 * @returns {*} The same result, annotated.
 */
function annotateToolResult(result, pressure) {
  const line = pressureLine(pressure);
  if (!line) return result;
  if (typeof result === "string") return `${result}\n${line}`;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const out = { ...result };
    out.status = [out.status, line].filter(Boolean).join(" ");
    return out;
  }
  return result;
}

// ─── What may never be offloaded (design R3/R4/R5/R6) ───────────────────────

/**
 * The tools whose RESULT is load-bearing and must stay in the conversation
 * verbatim for the whole turn.
 *
 * For the dev team this is the difference between a patch the manager can judge
 * and one it cannot: if the agent loses the record of what it already edited, it
 * edits the same place twice or declares a file list that does not match the
 * tree (AGENTS.md gotcha 75, "a patch shows its changes").
 */
const NEVER_OFFLOADED_TOOLS = ["writeFile", "editFile", "deleteFile"];

/**
 * Is this tool result protected?
 *
 * Protected: a mutating call's result (R3), a call that errored or was refused
 * (R4 — a gate refusal is evidence that lands on the ticket and in tickets.md),
 * and anything the agent is still working with (the recent tail, applied by the
 * caller).
 *
 * Not protected: the *payload* of a read. The call itself always stays (R6), so
 * the record of what the turn actually looked at survives — which is what
 * `crossCheckReads` judges a diagnosis on (gotcha 74).
 *
 * @param {Object} part - A tool-result part from a ModelMessage.
 * @returns {boolean}
 */
function toolResultIsProtected(part) {
  if (!part || part.type !== "tool-result") return true;
  if (NEVER_OFFLOADED_TOOLS.includes(part.toolName)) return true;
  const output = part.output;
  if (!output) return true;
  const type = output.type || "";
  if (type === "error-json" || type === "error-text") return true;
  const value = output.value;
  // The harness's own refusals come back as a plain { error: ... } answer rather
  // than a provider-level tool error, and they are evidence just the same.
  if (value && typeof value === "object" && (value.error || value.refused)) return true;
  return false;
}

// ─── The landmark ───────────────────────────────────────────────────────────

/**
 * One short line describing an offloaded lookup: the tool, what it pointed at,
 * and how much it held. This is the half the agent needs in order to decide what
 * to re-fetch.
 *
 * The failed live turn re-opened `glossary.js` twelve times precisely because it
 * had no such map — re-reading was its only way back, and every page re-billed
 * the whole growing transcript.
 *
 * @param {Object} entry - One `offloaded` record.
 * @returns {string}
 */
function describeOffloadedLookup(entry) {
  const input = entry.input || {};
  const target =
    input.filePath || input.dirPath || input.pattern || input.query ||
    (entry.sourceFiles && entry.sourceFiles[0]) || "";
  const where =
    input.offset != null
      ? ` offset ${input.offset}${input.limit != null ? ` +${input.limit}` : ""}`
      : input.glob
        ? ` glob "${input.glob}"`
        : "";
  const size = ` (${Math.round((entry.bytes || 0) / 1024)} KB)`;
  return `${entry.tool}  ${target}${where}${size}`;
}

/**
 * The block that replaces the offloaded payloads. Capped at 12 lines: a map that
 * is longer than what it replaced has not saved anything.
 *
 * @param {Object} offload - The offload record (with `offloaded` and `id`).
 * @returns {string}
 */
function renderLandmark(offload) {
  const entries = offload.offloaded || [];
  const lines = [
    `[context offload ${offload.id}]`,
    `${entries.length} earlier lookup(s) moved to disk so this turn can keep working. Nothing was discarded.`,
  ];
  for (const entry of entries.slice(0, 11)) lines.push(`  ${describeOffloadedLookup(entry)}`);
  if (entries.length > 11) lines.push(`  +${entries.length - 11} more`);
  lines.push(
    `Retrieve any of it verbatim: recall_memory("<what you are looking for>", "${offload.id}")`
  );
  return lines.join("\n");
}

// ─── The offload store ──────────────────────────────────────────────────────

/**
 * Where one turn's offload files live: inside the run log directory, which is
 * already gitignored machine state and already the place the diagnostics role is
 * allowed to read.
 *
 * @param {string} runDir - The harness's current run directory.
 * @param {string} agentName
 * @param {number} turn
 * @returns {string}
 */
function offloadDirFor(runDir, agentName, turn) {
  return path.join(runDir, `agent-${agentName}`, `turn-${String(turn).padStart(3, "0")}-memory`);
}

/**
 * A short, stable description of a tool call, used as the repetition key.
 *
 * Keyed on the tool name plus its arguments serialised with sorted keys, so two
 * calls that passed the same arguments in a different order are the same lookup.
 *
 * @param {string} name
 * @param {Object} input
 * @returns {string}
 */
function callKey(name, input) {
  const seen = new WeakSet();
  const normalize = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === "object") {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]);
      return out;
    }
    return String(value);
  };
  return `${name}\u0000${JSON.stringify(normalize(input ?? {}))}`;
}

/**
 * Move the oldest read payloads out of the conversation and onto disk.
 *
 * Walks the conversation from the oldest message forward, protects the most
 * recent `CONTEXT_KEEP_RECENT_TOKENS` of work, and moves every other read
 * payload that is not protected by R3/R4. The FIRST moved payload is replaced by
 * the landmark block; the rest are replaced by a one-line pointer, because the
 * tool-result part has to stay in place — the AI SDK pairs each result with the
 * assistant message that called it, and removing one would leave a tool call with
 * no answer.
 *
 * R8: if the file cannot be written, nothing is removed. An offload you cannot
 * retrieve is a deletion wearing a different hat, and silent loss is the one
 * outcome this whole module exists to prevent.
 *
 * @param {Object} input
 * @param {string} input.runDir - The harness's run directory.
 * @param {string} input.agentName
 * @param {number} input.turn
 * @param {number} input.chunk
 * @param {Array<Object>} input.messages - The conversation (not mutated).
 * @param {number} input.targetTokens - What the conversation should come down to.
 * @param {string} [input.reason] - "soft-limit" | "hard-limit" | "agent-request".
 * @returns {{ok: boolean, reason: string, id: string|null, file: string|null, dir: string,
 *   offloadedCount: number, tokensBefore: number, tokensAfter: number, landmark: string,
 *   messages: Array<Object>, error: string|null, kept: Object}}
 */
function offload({ runDir, agentName, turn, chunk, messages, targetTokens, reason = "soft-limit" }) {
  const list = Array.isArray(messages) ? messages : [];
  const tokensBefore = estimateMessagesTokens(list);
  const dir = offloadDirFor(runDir, agentName, turn);
  const keepRecent = contextKeepRecentTokens();

  // Walk backwards to find the protection boundary: `boundary` is the index of the
  // FIRST protected message, so everything from there to the end of the list is the
  // agent's immediate working set and everything older than it is eligible.
  // Starting it at 0 is what makes "the whole conversation is already the working
  // set" mean NOTHING IS ELIGIBLE: the eligibility test skips every message at or
  // after the boundary, so a boundary of 0 protects the whole list. (Starting it at
  // `list.length` protects nothing instead, which trims a conversation that was
  // small enough to keep whole — pinned by test/test-context.js group 8.)
  let accumulated = 0;
  let boundary = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    accumulated += estimateMessagesTokens([list[i]]);
    if (accumulated >= keepRecent) {
      boundary = i + 1;
      break;
    }
  }

  const offloaded = [];
  const moved = []; // [{ messageIndex, partIndex, entry }]
  let keptWriteCalls = 0;
  let keptRefusals = 0;

  list.forEach((message, messageIndex) => {
    // The recent tail is the agent's working set: skip it, and work through
    // everything OLDER than the boundary. (The comparison used to be flipped,
    // which would have moved the newest reads and kept the oldest ones.)
    if (messageIndex >= boundary) return;
    if (message.role !== "tool" || !Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      if (part.type !== "tool-result") return;
      if (toolResultIsProtected(part)) {
        if (NEVER_OFFLOADED_TOOLS.includes(part.toolName)) keptWriteCalls += 1;
        else keptRefusals += 1;
        return;
      }
      const output = part.output || {};
      const value = output.value;
      const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
      if (text.length < 512) return; // a payload this small is not worth a file entry
      offloaded.push({
        seq: offloaded.length + 1,
        tool: part.toolName,
        input: part.input ?? null,
        result: value ?? null,
        sourceFiles: sourceFilesOf(part),
        bytes: Buffer.byteLength(text, "utf8"),
      });
      moved.push({ messageIndex, partIndex, entry: offloaded[offloaded.length - 1] });
    });
  });

  const base = {
    ok: false,
    reason,
    id: null,
    file: null,
    dir,
    offloadedCount: 0,
    tokensBefore,
    tokensAfter: tokensBefore,
    landmark: "",
    messages: list,
    error: null,
    // WHICH kind of failure this is, as a field rather than something the caller
    // has to read out of the sentence: "nothing-eligible" means the conversation
    // is already only protected material (a size problem the harness cannot fix),
    // "write-failed" means the disk refused the copy (a bug or a permissions
    // problem, and the conversation is untouched either way).
    failure: null,
    kept: { writeCalls: keptWriteCalls, refusals: keptRefusals, recentTokens: accumulated },
  };
  if (!moved.length) {
    return { ...base, failure: "nothing-eligible", error: "nothing was eligible to offload: the conversation is already only protected material (the ticket, the system prompt, your own edits, refusals, and the most recent work)." };
  }

  const id = `ctx-${new Date().toISOString().replace(/[:.]/g, "-")}-${agentName}-${turn}-${chunk}-${offloaded.length.toString(16).padStart(3, "0")}`;
  const file = path.join(dir, `memory-${turn}-${chunk}.json`);
  const record = {
    schema: 1,
    id,
    agent: agentName,
    turn,
    chunk,
    at: new Date().toISOString(),
    tokensBefore,
    tokensAfter: 0, // filled below, after the rewrite
    reason,
    offloaded,
    kept: base.kept,
  };

  // R8 first, then the rewrite: write the file, and only touch the conversation
  // once the copy is provably on disk.
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
  } catch (err) {
    return { ...base, failure: "write-failed", error: `the offload file could not be written (${err.code || err.message}), so nothing was removed from the conversation.` };
  }

  const landmark = renderLandmark({ id, offloaded });
  // ONE map for the whole conversation, not one per message. `moved` is built in
  // conversation order, so moved[0] is the first payload that left. Scoping this
  // to "the first payload of THIS message" duplicated the entire map once per
  // message whenever a step fired one tool call at a time — which is the common
  // shape — and an N-copy map can cost more than the payloads it replaced.
  const next = list.map((message, messageIndex) => {
    const touched = moved.filter((m) => m.messageIndex === messageIndex);
    if (!touched.length) return message;
    const content = message.content.map((part, partIndex) => {
      const hit = touched.find((m) => m.partIndex === partIndex);
      if (!hit) return part;
      const pointer =
        hit === moved[0]
          ? landmark
          : `[offloaded ${id} seq ${hit.entry.seq}: ${describeOffloadedLookup(hit.entry)} — recall_memory("<what you need>", "${id}")]`;
      return { ...part, output: { type: "text", value: pointer } };
    });
    return { ...message, content };
  });

  record.tokensAfter = estimateMessagesTokens(next);
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
  } catch {
    /* the copy is already on disk; a stale tokensAfter is not worth abandoning the offload */
  }

  return {
    ok: true,
    reason,
    id,
    file,
    dir,
    offloadedCount: offloaded.length,
    tokensBefore,
    tokensAfter: record.tokensAfter,
    landmark,
    messages: next,
    error: null,
    failure: null,
    kept: record.kept,
  };
}

/**
 * Which real file(s) a read payload came from — the half that makes a recall
 * honest, because it lets the answer say "this text came from glossary.js lines
 * 1930–2110, which is still on disk".
 *
 * @param {Object} part - A tool-result part.
 * @returns {string[]}
 */
function sourceFilesOf(part) {
  const input = part.input || {};
  const output = part.output || {};
  const value = output.value;
  const out = new Set();
  if (typeof input.filePath === "string") out.add(input.filePath);
  // `dirPath` is deliberately NOT collected: it is the folder the tool SEARCHED,
  // not a file the text came from, and it is already on the record as `input`
  // (which is what the map line reads). Putting it here would make recall tell the
  // agent to `readFile` a folder — gotcha 60's mistake, manufactured by our own map.
  if (value && typeof value === "object") {
    if (typeof value.filePath === "string") out.add(value.filePath);
    if (Array.isArray(value.matches)) {
      for (const m of value.matches) {
        if (m && typeof m.filePath === "string") out.add(m.filePath);
      }
    }
    if (Array.isArray(value.entries)) {
      for (const e of value.entries) {
        if (typeof e === "string") out.add(e);
        else if (e && typeof e.path === "string") out.add(e.path);
      }
    }
  }
  return [...out];
}

// ─── Recall ─────────────────────────────────────────────────────────────────

/**
 * The longest prefix of `text` that fits `maxBytes` when encoded as UTF-8.
 *
 * Slicing by CHARACTER count is not a byte budget: a Japanese light novel is three
 * bytes per character, so `text.slice(0, 600)` answers 1,800 bytes for a 600-byte
 * promise — the recall budget would be three times larger than it claims on exactly
 * the corpus this pipeline processes. Walking character by character keeps the
 * budget honest and never cuts a character in half.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateToBytes(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let used = 0;
  let out = "";
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    out += ch;
  }
  return out;
}

/**
 * Search one turn's own offloaded text.
 *
 * Plain substring matching, case-insensitive — NOT regular expressions. This
 * codebase already learned that a regex dialect from another language trips the
 * agents and answers "no matches" for a search that should have hit (gotcha 60).
 *
 * Scoped by agent and turn (the safety argument): `recall_memory` cannot become a
 * side door to a file the role's own sandbox would have refused, because the
 * store only ever holds what this same turn already legitimately read.
 *
 * @param {Object} input
 * @param {string} input.dir - The turn's offload directory.
 * @param {string} input.query - Plain substring.
 * @param {string} [input.id] - Restrict to one offload record.
 * @param {number} [input.limitBytes] - RECALL_MAX_BYTES by default.
 * @returns {{matched: Array<Object>, matchedCount: number, truncated: boolean, filesRead: number, error: string|null, note: string}}
 */
function recall({ dir, query, id = null, limitBytes = recallMaxBytes() }) {
  const needle = String(query ?? "").toLowerCase();
  const empty = { matched: [], matchedCount: 0, truncated: false, filesRead: 0, note: "" };
  if (!needle) {
    return { ...empty, error: "recall_memory needs a query: the text you are looking for.", note: "" };
  }
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch (err) {
    return { ...empty, error: `no offloaded text for this turn (${err.code || err.message}).` };
  }
  const matched = [];
  let truncated = false;
  let budget = limitBytes;
  let filesRead = 0;

  for (const name of names.sort()) {
    // The id is matched on the RECORD, never on the file name: the file is named
    // `memory-<turn>-<chunk>.json`, which does not contain the id. Filtering by
    // name here would make a scoped recall skip every file and report "nothing
    // matches" for text that is plainly in the store.
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue; // a half-written offload file is not evidence
    }
    if (id && record.id !== id) continue;
    filesRead += 1;
    for (const entry of record.offloaded || []) {
      const text = typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result ?? "");
      const lower = text.toLowerCase();
      const at = lower.indexOf(needle);
      if (at === -1) continue;
      // Return the matching span with a little of each side, verbatim.
      const start = Math.max(0, at - 400);
      const end = Math.min(text.length, at + Math.max(1200, needle.length + 800));
      let excerpt = text.slice(start, end);
      if (Buffer.byteLength(excerpt, "utf8") > budget) {
        excerpt = truncateToBytes(excerpt, budget);
        truncated = true;
      }
      budget -= Buffer.byteLength(excerpt, "utf8");
      matched.push({
        id: record.id,
        seq: entry.seq,
        tool: entry.tool,
        input: entry.input ?? null,
        sourceFile: (entry.sourceFiles || [])[0] || null,
        sourceFiles: entry.sourceFiles || [],
        excerpt,
      });
      if (budget <= 0) {
        truncated = true;
        break;
      }
    }
    if (budget <= 0) break;
  }

  const sources = [...new Set(matched.flatMap((m) => m.sourceFiles || []).filter(Boolean))];
  return {
    matched,
    matchedCount: matched.length,
    truncated,
    filesRead,
    error: matched.length ? null : `no offloaded text from this turn matches "${query}".`,
    note: matched.length
      ? `recall_memory searches only what THIS turn already read. ${sources.length ? `The original file(s) are still on disk (${sources.join(", ")}) — readFile returns them whole.` : "The original file is still on disk."}`
      : "Nothing this turn offloaded matches that query. The original files are still on disk: read them directly.",
  };
}

// ─── The two tools (ACM's manage_context / query_memory) ────────────────────

/**
 * Build the two context tools for one agent handle.
 *
 * They are built here rather than in each role module so the harness owns them:
 * a role cannot hand itself a wider recall window or a different store, and the
 * store is keyed to the turn that produced it.
 *
 * @param {Object} input
 * @param {Object} input.state - The live turn state (`{ turn, dir, pressure, requested }`).
 * @param {Function} input.requestOffload - Marks the turn for offloading at the next chunk boundary.
 * @returns {{manage_context: Object, recall_memory: Object}}
 */
function createContextTools({ state, requestOffload }) {
  // Checked here rather than discovered at the moment the agent asks for help:
  // `manage_context` is the tool a turn reaches for precisely when it is running
  // out of room, and a tool that answers that call with "X is not a function"
  // teaches the agent that asking for help does not work. A misspelled option at
  // the call site is a wiring bug, and it should fail the handle, not the turn.
  if (!state || typeof state !== "object") {
    throw new Error("createContextTools needs the live turn state.");
  }
  if (typeof requestOffload !== "function") {
    throw new Error(
      "createContextTools needs a requestOffload function (the harness records why the agent asked)."
    );
  }
  const manage_context = tool({
    description:
      "Move the bulky results of your earlier lookups to disk, keeping a map of what " +
      "you looked at. Nothing is discarded: every moved result stays retrievable with " +
      "recall_memory. Use it when the working-window line says the window is getting " +
      "full — BEFORE another read, not after. Your own writes and edits are never moved.",
    inputSchema: z.object({
      note: z
        .string()
        .optional()
        .describe("Optional: what you are done reading, so the record says why."),
    }),
    execute: async ({ note }) => {
      // The turn's own record of "the agent asked for a trim" is stamped here, the
      // same way `recall_memory` stamps its own recall count: the harness logs both,
      // and ACM's measurement is that a model calls tools like these almost never
      // unless it is told to. A counter the tool does not write is a counter that
      // silently reports zero for a turn that used them.
      state.requested = true;
      requestOffload(String(note || "").trim());
      return {
        scheduled: true,
        appliesAt: "next chunk boundary",
        note: String(note || ""),
        workingWindowTokens: state.pressure ? state.pressure.tokens : null,
      };
    },
  });

  const recall_memory = tool({
    description:
      "Search what THIS turn already moved to disk with manage_context, and get the " +
      "matching text back verbatim. Plain text search (no regular expressions). It " +
      "cannot reach anything this turn did not already read.",
    inputSchema: z.object({
      query: z.string().describe("The text you are looking for, as a plain phrase."),
      id: z
        .string()
        .optional()
        .describe("Optional: restrict to one offload record, from its [context offload …] marker."),
      limit: z
        .number()
        .optional()
        .describe(`Optional: largest answer in bytes (default ${recallMaxBytes()}).`),
    }),
    execute: async ({ query, id, limit }) => {
      // A `limit` the agent writes is clamped to the same floor the env knob has:
      // a 10-byte answer is indistinguishable from "nothing matched", and an agent
      // that cannot tell the two reports a wrong answer instead of a wrong setting.
      const asked = Number.isFinite(limit) && limit > 0 ? limit : null;
      const out = recall({
        dir: state.dir,
        query,
        id: id || null,
        limitBytes: asked === null ? recallMaxBytes() : Math.max(asked, RECALL_MIN_BYTES),
      });
      state.recalls += 1;
      return out;
    },
  });

  return { manage_context, recall_memory };
}

// ─── Loop detection (design §4.8) ───────────────────────────────────────────

/**
 * The repetition detector that stands in place of a step cap.
 *
 * A call counts as a repeat only when BOTH:
 *   1. the tool name and the normalised arguments are identical to an earlier
 *      call in the same turn, AND
 *   2. its result is byte-identical to that earlier call's result.
 *
 * Condition 2 is what keeps this honest. Re-reading a file after editing it, or
 * re-running a search after a different file changed, is legitimate work and is
 * not counted. Re-running the identical search against an unchanged answer three
 * times is a loop, and it is the shape the other guards cannot see: the idle
 * deadline needs silence (this agent produced something every few seconds) and
 * the runaway-text guard needs lots of prose with few tool calls (this agent made
 * dozens of small lookups).
 *
 * @param {{limit?: number}} [opts]
 * @returns {{observe: (call: {name: string, input: Object, output: *, error: string|null}) => null | {repeated: true, call: Object, count: number, key: string}, counts: () => Object}}
 */
function repeatDetector({ limit = agentRepeatLimit() } = {}) {
  /** @type {Map<string, {count: number, lastResult: string, call: Object}>} */
  const seen = new Map();

  const observe = (call) => {
    if (!call || !call.name) return null;
    const key = callKey(call.name, call.input);
    // A call that errored is not the same lookup as one that answered: the agent
    // is allowed to retry a failure, and a refusal it is trying to work around is
    // information rather than a spin.
    const resultText = call.error
      ? `error:${String(call.error)}`
      : JSON.stringify(call.output ?? null);
    const prior = seen.get(key);
    if (prior && prior.lastResult === resultText) {
      prior.count += 1;
      prior.call = call;
      if (prior.count >= limit) {
        return { repeated: true, call, count: prior.count, key };
      }
      return null;
    }
    seen.set(key, { count: 1, lastResult: resultText, call });
    return null;
  };

  return { observe, counts: () => ({ distinct: seen.size }) };
}

/**
 * The second stop signal: trimming repeatedly while producing no new distinct
 * work. That means the material this turn is NOT allowed to lose — the system
 * prompt, the ticket, its own edits, the refusals, the recent tail — is what no
 * longer fits. That is a different problem from "needs trimming", and compressing
 * harder is the wrong answer to it.
 *
 * @param {{limit?: number}} [opts]
 * @returns {{observe: (o: {trimmed: boolean, newDistinctCalls: number}) => boolean, consecutive: () => number}}
 */
function exhaustionDetector({ limit = agentCompactExhaustion() } = {}) {
  let consecutive = 0;
  const observe = ({ trimmed, newDistinctCalls }) => {
    if (!trimmed) {
      consecutive = 0;
      return false;
    }
    if (newDistinctCalls > 0) {
      consecutive = 0;
      return false;
    }
    consecutive += 1;
    return consecutive >= limit;
  };
  return { observe, consecutive: () => consecutive };
}

/**
 * The turn's wall clock. Distinct from the idle deadline, and deliberately so
 * (gotcha 26 keeps that one idle).
 *
 * @param {number} maxMs - 0 disables the ceiling.
 * @returns {{maxMs: number, startedAt: number, elapsedMs: () => number, exceeded: () => boolean}}
 */
function turnClock(maxMs = agentTurnMaxMs()) {
  const startedAt = Date.now();
  return {
    maxMs,
    startedAt,
    elapsedMs: () => Date.now() - startedAt,
    exceeded: () => maxMs > 0 && Date.now() - startedAt > maxMs,
  };
}

// ─── Reading the store back (for the turn log and the cross-check) ──────────

/**
 * List this turn's offload records — the lines a turn log should name, so a
 * reader can find the text the agent gave up.
 *
 * @param {string} dir
 * @returns {Array<{id: string, file: string, offloadedCount: number, tokensBefore: number, tokensAfter: number, reason: string}>}
 */
function listOffloads(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      out.push({
        id: record.id,
        file: path.join(dir, name),
        offloadedCount: (record.offloaded || []).length,
        tokensBefore: record.tokensBefore,
        tokensAfter: record.tokensAfter,
        reason: record.reason,
      });
    } catch {
      /* unreadable record: report nothing rather than guess */
    }
  }
  return out;
}

module.exports = {
  CONTEXT_MANAGED_ROLES,
  NEVER_OFFLOADED_TOOLS,
  contextManagementEnabled,
  contextChunkSteps,
  contextSoftLimit,
  contextHardLimit,
  contextKeepRecentTokens,
  recallMaxBytes,
  agentRepeatLimit,
  agentCompactExhaustion,
  agentTurnMaxMs,
  estimateMessagesTokens,
  naiveLibraryEstimate,
  messageText,
  windowPressure,
  pressureLine,
  annotateToolResult,
  toolResultIsProtected,
  describeOffloadedLookup,
  renderLandmark,
  offloadDirFor,
  offload,
  sourceFilesOf,
  recall,
  createContextTools,
  repeatDetector,
  exhaustionDetector,
  turnClock,
  listOffloads,
  callKey,
};

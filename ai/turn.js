/**
 * Reading one model turn off the stream: the event consumer, the usage merge, and
 * the RESULT line written to the run log.
 *
 * An event loop that records an error must also SURFACE it (gotcha 62): when the
 * endpoint fails, the AI SDK does not throw into the for-await, it emits an error
 * part and closes the turn without ever emitting done. Discarding it made the
 * pipeline report "the model returned no content" for a container that was simply
 * not running — and the size refusal the whole->chaptered fallback exists to repair
 * was never tagged.
 *
 * Part of the harness.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
require("../types"); // JSDoc type definitions
const { tooBigForOnePassError } = require("../configs/shared");

const { logFilePath, logLine, runDir, numberedLogFile } = require("./log");
const { agentTextGuardChars } = require("./env");

/**
 * Add two AI SDK usage objects together.
 * @param {Object|null} a - First usage (may be null).
 * @param {Object|null} b - Second usage (may be null).
 * @returns {Object|null} The summed usage (or null if both are null).
 */
function mergeUsage(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
  };
}


/**
 * Compact single-line JSON for tool-call logging (long inputs, e.g. a
 * writeFile payload, are truncated).
 * @param {unknown} input - The tool call input.
 * @returns {string} The truncated JSON string.
 */
function summarizeInput(input) {
  let s;
  try {
    s = JSON.stringify(input ?? {});
  } catch {
    s = String(input);
  }
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}


/**
 * Find the collected tool call an event belongs to.
 * @param {Array<Object>} toolCalls - The calls collected so far in a turn.
 * @param {string} toolCallId - The id carried by tool.done / tool.error.
 * @returns {Object|null} The matching call, or null.
 */
function findToolCall(toolCalls, toolCallId) {
  if (!toolCallId) return null;
  return toolCalls.find((tc) => tc.toolCallId === toolCallId) ?? null;
}


/**
 * Consume an open-harness event stream (Session.send / Conversation.send /
 * Agent.run) to completion, logging progress the way the old call-ai.js did
 * (periodic character counts, retry notices, one RESULT line at the end).
 *
 * @param {AsyncIterable<Object>} events - The event stream.
 * @param {{label: string, tapsRef: {current: Object}, logContext?: Object, signal?: AbortSignal, idleDeadlineMs?: number, onIdleExpire?: Function, carryOver?: {textChars: number, toolCallCount: number}}} opts - The log label
 *   (agent/stage name), the taps ref (the per-attempt taps object), optional
 *   log context for streaming logs, an optional AbortSignal used by the
 *   runaway-generation guard to cancel the underlying fetch, and an optional
 *   `carryOver` seed: what this SAME turn has already produced in earlier
 *   chunks. Without it the runaway-text guard measures one chunk, and a
 *   context-managed turn is deliberately split into chunks, so a model that
 *   rambles across six of them would trip nothing (gotcha 17).
 * @returns {Promise<Object>} The accumulated result:
 *   { text, reasoning, finishReason, usage, result, error, messages,
 *     startTime, firstTokenTime }. Throws the run's error when the stream
 *     ends with result "error", or a descriptive error when the runaway
 *     generation guard trips.
 */
async function consumeEvents(
  events,
  {
    label,
    tapsRef,
    logContext,
    signal,
    idleDeadlineMs = 0,
    onIdleExpire = null,
    carryOver = null,
  }
) {
  const result = {
    text: "",
    reasoning: "",
    finishReason: null,
    usage: null,
    result: null,
    error: null,
    messages: [],
    startTime: Date.now(),
    firstTokenTime: tapsRef.current?.firstToken ?? null,
    toolCalls: [],
    compactions: 0,
    lastInputTokens: 0,
  };
  // What the turn produced BEFORE this chunk, for the guard's arithmetic only.
  const priorTextChars = carryOver?.textChars ?? 0;
  const priorToolCalls = carryOver?.toolCallCount ?? 0;
  let lastReported = 0;

  // Streaming log writer: writes partial output as it arrives.
  let logFd = null;
  let logFilePath = null;
  let logBuffer = "";
  let logFlushedBytes = 0;
  const STREAM_LOG_FLUSH_THRESHOLD = 2048; // flush every 2KB of new content

  if (logContext && runDir) {
    try {
      const isAgent = logContext.type === "agent";
      const baseName = isAgent ? `agent-${logContext.agentName}` : "one-shot";
      const logDir = isAgent ? path.join(runDir, baseName) : path.join(runDir, "one-shot");
      // A context-managed turn is deliberately split into chunks, and each chunk
      // needs its own partial-output file or the second chunk overwrites the
      // first one's evidence (design §4.10). Non-managed turns keep the old name.
      const chunkSuffix =
        logContext.chunk && logContext.chunk > 1 ? `-c${String(logContext.chunk).padStart(2, "0")}` : "";
      const safeLabel = logContext.label.replace(/[^a-zA-Z0-9_-]/g, "_");
      logFilePath = isAgent
        ? path.join(logDir, `turn-${String(logContext.turnNumber).padStart(3, "0")}${chunkSuffix}.stream.md`)
        : // A role called twice in one process (the manager, every iteration) gets its own partial
          // file too, so the streamed text lines up with the numbered answer written next to it.
          numberedLogFile(logDir, safeLabel, ".stream.md");
      fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
      logFd = fs.openSync(logFilePath, "a");
    } catch (err) {
      // If streaming log creation fails, fall back to no streaming (non-blocking).
      logFd = null;
      console.error(`[harness] failed to create streaming log: ${err.message}`);
    }
  }

  // Flush buffered log content to disk.
  function flushLogBuffer() {
    if (logFd !== null && logBuffer.length > 0) {
      try {
        const bytesWritten = fs.writeSync(logFd, logBuffer);
        logBuffer = "";
        logFlushedBytes += bytesWritten;
      } catch (err) {
        // Never let logging break the actual AI call.
        console.error(`[harness] failed to flush streaming log: ${err.message}`);
      }
    }
  }

  // Write a partial log line (to stream or console).
  function streamWrite(chunk) {
    if (logFd !== null) {
      logBuffer += chunk;
      // Flush when buffer exceeds threshold.
      if (logBuffer.length >= STREAM_LOG_FLUSH_THRESHOLD) {
        flushLogBuffer();
      }
    }
  }

  let guardTripped = false;

  // Idle deadline (AI_CALL_DEADLINE_MS): when no event arrives for this long,
  // call onIdleExpire() — the caller aborts the underlying signal, which
  // errors the stream and unblocks the for-await below. The timer is reset
  // on every event (an IDLE timeout, not a total-time limit), so a healthy
  // long call (huge prefill, long multi-step agent turn) is never aborted
  // while a hung connection (no events at all) is aborted after the
  // deadline — without this, a dead local container would hang the run
  // forever (all fetch timeouts are disabled).
  let idleTimer = null;
  const armIdleDeadline = () => {
    if (!idleDeadlineMs || idleDeadlineMs <= 0 || !onIdleExpire) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      onIdleExpire();
    }, idleDeadlineMs);
  };
  armIdleDeadline();

  try {
    for await (const event of events) {
      if (guardTripped) break;
      armIdleDeadline();
      switch (event.type) {
        case "text.delta":
          result.text += event.text;
          if (result.firstTokenTime === null) result.firstTokenTime = Date.now();
          // Stream partial text to log as it arrives.
          streamWrite(event.text);
          if (result.text.length - lastReported >= 1000) {
            lastReported = result.text.length;
            logLine(`  …generated ${lastReported} chars so far`);
          }
          // Runaway-generation guard: abort if the model is producing a
          // large amount of text without making any tool calls. This
          // catches models that emit malformed tool-call text (e.g.
          // Qwen-native <tool_call> tags in the content field) instead of
          // using the API-level tool_calls protocol.
          // The counts are TURN-wide, not chunk-wide: a context-managed turn is
          // split into chunks on purpose, and a model that rambles across six of
          // them is the same failure gotcha 17 describes (observed live: 962 KB of
          // repeated tool-call text with zero real calls).
          const turnTextChars = priorTextChars + result.text.length;
          const turnToolCalls = priorToolCalls + result.toolCalls.length;
          if (
            signal &&
            turnTextChars > agentTextGuardChars() &&
            turnToolCalls < 3
          ) {
            guardTripped = true;
            logLine(
              `  [call-ai] WARNING: ${label} generated ${turnTextChars} chars ` +
              `with only ${turnToolCalls} tool call(s); aborting runaway generation.`
            );
            try { signal.abort(); } catch {}
          }
          break;
        case "reasoning.delta":
          result.reasoning += event.text;
          if (result.firstTokenTime === null) result.firstTokenTime = Date.now();
          // Stream partial reasoning to log as it arrives.
          streamWrite(event.text);
          break;
        case "step.done":
          result.finishReason = event.finishReason;
          result.usage = mergeUsage(result.usage, event.usage);
          // The size of the request the server JUST accepted, kept separately from
          // `usage` (which mergeUsage sums across every step of the turn). The
          // context-management pressure line needs the last request's prompt count,
          // not the turn total — a 12-step turn's sum is many times the window.
          if (event.usage?.inputTokens) result.lastInputTokens = event.usage.inputTokens;
          break;
        case "tool.start":
          // Per-step visibility for tool-using agents: what is being called.
          logLine(
            `  …[agent] ${event.toolName} ${summarizeInput(event.input)}`
          );
          // Collect tool call for chat log. toolCallId is what pairs the result
          // with its call — a step may fire several calls at once, so "the last
          // one" misattributes an error to a call that succeeded.
          result.toolCalls.push({
            toolCallId: event.toolCallId,
            name: event.toolName,
            input: event.input,
            output: null,
            error: null,
          });
          break;
        case "tool.done": {
          // The library's answer for a call. Without this case the agent chat
          // logs recorded every tool CALL and none of their results — 0 output
          // lines across 526 logged turns, while AGENTS.md promised "tool calls +
          // results". The result is what tells a reader (or a debugging agent)
          // whether a search found nothing or found nothing it could see.
          const done = findToolCall(result.toolCalls, event.toolCallId);
          if (done && done.output === null) done.output = event.output;
          break;
        }
        case "tool.error": {
          logLine(
            `  …[agent] ${event.toolName} errored: ${String(event.error).slice(0, 160)}`
          );
          // Mark the call that actually failed.
          const failed =
            findToolCall(result.toolCalls, event.toolCallId) ??
            result.toolCalls[result.toolCalls.length - 1];
          if (failed && failed.output === null && failed.error === null) {
            failed.error = String(event.error).slice(0, 500);
          }
          break;
        }
        case "retry":
          logLine(
            `  [call-ai] attempt failed (${event.error.message}); ` +
              `retrying in ${event.delayMs} ms ` +
              `(${event.maxRetries - event.attempt - 1} left)...`
          );
          break;
        case "error":
          result.error = event.error;
          break;
        case "done":
          result.result = event.result;
          result.messages = event.messages;
          result.usage = mergeUsage(result.usage, event.totalUsage);
          break;
        case "compaction.start":
        case "compaction.pruned":
        case "compaction.summary":
        case "compaction.done": {
          // The library's own lossy summariser. Every handle this harness builds
          // sets `autoCompact: false`, so a line here means something reached the
          // model with the library's compaction still on — and lossy compaction is
          // the failure that shows up as a worse artifact rather than an error
          // (gotcha 56). Log it so it is greppable in summary.log instead of only
          // visible in the chat dump.
          const detail =
            event.type === "compaction.start"
              ? `reason=${event.reason} tokens_before=${event.tokensBefore}`
              : event.type === "compaction.pruned"
                ? `removed ${event.messagesRemoved} message(s) / ${event.tokensRemoved} tokens`
                : event.type === "compaction.summary"
                  ? `model-written summary replaces the history (${String(event.summary || "").length} chars)`
                  : `tokens ${event.tokensBefore} -> ${event.tokensAfter}`;
          result.compactions = (result.compactions || 0) + 1;
          logLine(
            `  [call-ai] WARNING: ${label} session.compaction.${event.type.split(".")[1]}: ${detail}`
          );
          break;
        }
        default:
          // turn.* lifecycle events: nothing to accumulate.
          break;
      }
    }
  } catch (err) {
    // A guard-triggered abort surfaces as an AbortError from the stream;
    // swallow it and fall through to the descriptive guard error below.
    if (!guardTripped) throw err;
  } finally {
    // Clear the idle-deadline timer on every exit path (success, guard
    // trip, stream error) so it can never fire after the call finished.
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  // Flush any remaining buffered log content and close the file descriptor.
  flushLogBuffer();
  if (logFd !== null) {
    try { fs.closeSync(logFd); } catch {}
    logFd = null;
  }

  if (guardTripped) {
    throw new Error(
      `${label}: runaway generation aborted — the model produced ` +
      `${priorTextChars + result.text.length} chars of text with only ` +
      `${priorToolCalls + result.toolCalls.length} tool call(s). ` +
      `This usually means the model is emitting malformed tool-call text ` +
      `instead of using the tool-calling API. Check the model's tool-calling ` +
      `support or try a different model. Run log: ${logFilePath}`
    );
  }

  // Truncation guard: a turn that ended with finishReason "length" hit the
  // output-token cap. For an agent turn whose last step was a file write, the
  // writeFile/editFile payload was almost certainly cut off mid-content — a
  // truncated file that would otherwise pass assertWrote (it exists, it is
  // non-empty) and slip through. Fail the turn so the workflow's error
  // handling (recovery / re-run) deals with it instead of accepting a stub.
  if (result.finishReason === "length") {
    const isAgent = logContext && logContext.type === "agent";
    const lastTool = result.toolCalls[result.toolCalls.length - 1];
    const wroteAtEnd = isAgent && lastTool && /^(write|edit)File$/i.test(lastTool.name);
    // logLine, not console.warn: the summary log is the file a run is read
    // from afterwards, and a truncated turn that never reached it made the
    // cause of a dead volume invisible in the log (observed live: volume 04
    // died with a writeFile whose JSON argument was cut off mid-string, and
    // summary.log had no WARNING line for it — only the per-turn chat dump).
    logLine(
      `  [call-ai] WARNING: ${label} ended with finish_reason=length (hit the output-token ` +
        `cap) — the response was truncated. Log: ${logFilePath}`
    );
    if (wroteAtEnd) {
      throw tooBigForOnePassError(
        `${label}: the turn was truncated (finish_reason=length) while writing ` +
        `${lastTool.name} — the file is incomplete. Raise AI_MAX_TOKENS (or ` +
        `AI_CONTEXT_WINDOW, which it derives from) or split the work into smaller ` +
        `writes, then re-run. Log: ${logFilePath}`
      );
    }
  }

  // Merge the HTTP-layer-tapped reasoning (llama.cpp-style
  // `reasoning_content`): it is the same thinking the provider-native
  // reasoning events would carry, captured at the fetch layer instead.
  const tapped = (tapsRef.current?.reasoning ?? []).join("");
  if (tapped && !result.reasoning) result.reasoning = tapped;

  if (result.result === "error") {
    throw result.error ?? new Error(`The ${label} run ended in an error.`);
  }
  // A failed model call reaches this loop as an `error` EVENT, and openharness
  // closes the turn WITHOUT ever emitting `done` when the stream dies (it forwards
  // `turn.start` … `error` … `turn.done`). So `result.result` stays null, nothing
  // above looked at `result.error`, and the server's own message was thrown away:
  // every one-shot failure — a dead container, a refused request, a provider
  // error — surfaced as "The model returned no content". Two consequences, both
  // observed against the scripted endpoint in test/test-fake-backend.js:
  //   - `tagSizeOverflowError` never saw the server's "prompt + max tokens exceeds
  //     the context" wording, so the whole-installment → chapter-by-chapter
  //     fallback (gotcha 55) never fired for the one failure it exists to repair;
  //   - an overnight run's log blamed the model for what was a container that was
  //     not running.
  // A run that reached a normal completion (`complete`, or `max_steps`) is left
  // alone: this is for streams that ended without one.
  if (result.error && result.result !== "complete" && result.result !== "max_steps") {
    throw result.error;
  }
  return result;
}


/**
 * Write the RESULT line for a completed run (same fields as the old
 * call-ai.js: finish_reason, content/reasoning sizes, token usage, and
 * first-token/prefill/generation rates when measurable).
 *
 * @param {FetchResult} r - The accumulated result (see consumeEvents).
 * @param {string} label - The agent/stage label.
 */
function logResultLine(r, label) {
  const usage = r.usage;
  const usageText =
    usage && (usage.inputTokens != null || usage.outputTokens != null)
      ? `usage: prompt=${usage.inputTokens ?? 0} completion=${usage.outputTokens ?? 0} total=${usage.totalTokens ?? "?"}`
      : "usage: n/a";
  const perf = [];
  if (r.firstTokenTime) {
    const prefillMs = r.firstTokenTime - r.startTime;
    const genMs = Date.now() - r.firstTokenTime;
    perf.push(`ttft=${(prefillMs / 1000).toFixed(1)}s`);
    if (prefillMs > 0 && usage?.inputTokens) {
      perf.push(`prefill=${(usage.inputTokens / (prefillMs / 1000)).toFixed(1)} tok/s`);
    }
    if (genMs > 0 && usage?.outputTokens) {
      perf.push(`gen=${(usage.outputTokens / (genMs / 1000)).toFixed(1)} tok/s`);
    }
  }
  logLine(
    `[call-ai] RESULT (${label}) finish_reason=${r.finishReason ?? "n/a"} ` +
      `content=${r.text.length} chars reasoning=${r.reasoning.length} chars ` +
      `${usageText} ${perf.join(" ")}` +
      (r.text.length === 0 ? "  <-- NO CONTENT (empty response)" : "")
  );
}

// ─── One-shot calls (no tools) ──────────────────────────────────────────────


module.exports = {
  mergeUsage,
  summarizeInput,
  findToolCall,
  consumeEvents,
  logResultLine,
};

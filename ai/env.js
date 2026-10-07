/**
 * The harness's own settings, read from the environment. Kept as functions rather
 * than constants so a test can pin one variable for one scenario.
 *
 * AI_CALL_DEADLINE_MS is an IDLE timeout, not a total-time limit: agent turns are
 * multi-step and a healthy turn over a 500 KB source legitimately runs for a long
 * time, but it emits events continuously. Only a hung connection (no events for the
 * whole window) is aborted (gotcha 26).
 *
 * Part of the harness.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions
const { readBoolEnv, tooBigForOnePassError, isTooBigForOnePassError } = require("../configs/shared");

/** Default retry count from AI_RETRY (.env), matching the old callAi(). */
function envRetry() {
  const n = parseInt(process.env.AI_RETRY, 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}


/**
 * Idle deadline for a single model call, in ms, from AI_CALL_DEADLINE_MS.
 *
 * All fetch timeouts are disabled (local servers can prefill for minutes), so
 * without this a dead endpoint (OOM-killed container, dropped connection)
 * hangs the run FOREVER — fatal for the un-monitored overnight runs this
 * pipeline is built for. This is an IDLE timeout, not a total-time limit:
 * it resets on every streamed event, so a healthy long call (huge prefill,
 * long multi-step agent turn) is never aborted, while a hung connection
 * (no events at all) is aborted after this many milliseconds of silence.
 *
 * 0 / invalid = disabled. Unset = the 60 min default above.
 *
 * @returns {number} The idle deadline in ms (0 = disabled).
 */
function envCallDeadlineMs() {
  const raw = process.env.AI_CALL_DEADLINE_MS;
  if (raw === undefined || raw === "") return 3600000;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}


/**
 * Thinking mode (AI_THINKING env, default ON). Uses the shared readBoolEnv so
 * this and the translation-stage reader agree on every value (the two used to
 * disagree — see readBoolEnv).
 */
function envThinking() {
  return readBoolEnv("AI_THINKING", true);
}


/**
 * Thinking effort level (AI_THINKING_LEVEL env, default "xhigh").
 * Sets the `reasoning_effort` parameter on the request body.
 * Valid values: "low", "medium", "xhigh" (model-dependent).
 */
function envThinkingLevel() {
  const level = process.env.AI_THINKING_LEVEL;
  if (typeof level === "string" && level.trim() !== "") {
    return level.trim();
  }
  return "xhigh";
}


/**
 * The model server's context window (AI_CONTEXT_WINDOW env, default 128000):
 * one number for one fact. It drives agent session auto-compaction AND the
 * default output-token cap, so the two can no longer disagree.
 * (AGENT_CONTEXT_WINDOW is still read as the legacy name.)
 */
function envContextWindow() {
  const n = parseInt(
    process.env.AI_CONTEXT_WINDOW ?? process.env.AGENT_CONTEXT_WINDOW,
    10
  );
  return Number.isInteger(n) && n >= 4096 ? n : 128000;
}


/**
 * Maximum output tokens per call. AI_MAX_TOKENS overrides; otherwise it is
 * derived as a quarter of the context window.
 *
 * Deriving it is the fix for a failure that looked like a model problem: with
 * AI_MAX_TOKENS equal to the server's context (262144 on both sides), every
 * agent call was rejected before it started — "prompt (4337 tokens) + max tokens
 * (262144) exceeds the context; requests are never truncated" — because the
 * server reserves nothing for the prompt. Keeping one context number and
 * deriving the output cap makes that combination unreachable by construction.
 */
function envMaxTokens() {
  const explicit = parseInt(process.env.AI_MAX_TOKENS, 10);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return Math.max(1024, Math.floor(envContextWindow() / 4));
}


/** Sampling temperature (AI_TEMPERATURE env, default 0.7). */
function envTemperature() {
  const t = parseFloat(process.env.AI_TEMPERATURE);
  return Number.isNaN(t) ? 0.7 : t;
}


/** Default step cap for tool-using agents (AGENT_MAX_STEPS env, default 20). */
function agentMaxSteps() {
  const n = parseInt(process.env.AGENT_MAX_STEPS, 10);
  return Number.isInteger(n) && n >= 1 ? n : 20;
}


/**
 * Longest line an agent's readFile/grep may see (AGENT_MAX_LINE_LENGTH env,
 * default 8000). The open-harness file tools default to 2000.
 *
 * The default was a lie for this pipeline's cumulative artifacts. A compiled
 * character-voice reference holds one long line per character (2,344 chars at
 * volume 02, 2,863 at volume 03), so an agent asked to preserve it could not read
 * it: every read answered with a `[… truncated …]` marker. Observed consequence —
 * an author agent split the artifact's long lines to get at them, never restored
 * them, and its final chat reply about that plan became the artifact itself.
 *
 * 8000 is comfortably above the longest line any artifact has produced, and the
 * source bundles top out at 326 chars, so this changes nothing about reading the
 * books.
 */
function envMaxLineLength() {
  const n = parseInt(process.env.AGENT_MAX_LINE_LENGTH, 10);
  return Number.isInteger(n) && n >= 200 ? n : 8000;
}


/**
 * Largest readFile/listFiles/grep answer in bytes (AGENT_MAX_READ_BYTES env,
 * default 65536). The open-harness file tools default to 32 KB.
 *
 * Doubling it is about token cost, not convenience: reading a 150 KB artifact in
 * five paged calls means the accumulated transcript is re-sent five times, and
 * each re-send is billed. Fewer, larger reads is fewer billed turns — which is
 * what made the character-voice stage cost 173M tokens for five volumes.
 */
function envMaxReadBytes() {
  const n = parseInt(process.env.AGENT_MAX_READ_BYTES, 10);
  return Number.isInteger(n) && n >= 4096 ? n : 65536;
}


/**
 * Runaway-generation guard threshold (AGENT_TEXT_GUARD_CHARS env, default 30000).
 * When an agent produces more than this many characters of text with fewer
 * than 3 tool calls, the stream is aborted. This catches models that emit
 * malformed tool-call text (e.g. Qwen-native <tool_call> tags in the content field)
 * instead of using the API-level tool_calls protocol.
 *
 * Provenance: observed live — a local Qwen3 model generated 962 KB of
 * repeated `listFiles(path='.'); readFile(...)` text without a single valid
 * tool call, burning tokens for over an hour before the run log was checked.
 */
function agentTextGuardChars() {
  const n = parseInt(process.env.AGENT_TEXT_GUARD_CHARS, 10);
  return Number.isInteger(n) && n >= 1000 ? n : 30000;
}

// ─── Message conversion (one-shot calls) ────────────────────────────────────
// A "message" is either { text } or { file, name } (the same IMessage shape
// the old call-ai.js accepted).


module.exports = {
  envRetry,
  envCallDeadlineMs,
  envThinking,
  envThinkingLevel,
  envContextWindow,
  envMaxTokens,
  envTemperature,
  agentMaxSteps,
  envMaxLineLength,
  envMaxReadBytes,
  agentTextGuardChars,
};

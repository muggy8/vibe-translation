/**
 * harness.js — OpenHarness (@openharness/core) wiring for the ai-client.
 *
 * This is the AI layer of the project. It builds the OpenAI-compatible
 * provider for the endpoint configured in .env and exposes the primitives
 * the glossary and jump-in-wiki workflows drive:
 *
 *   - runOneShot(...)        a single tool-less model call (acceptance
 *                            checks, classic-mode pipeline stages, and the
 *                            translation stage's per-chapter one-shot calls
 *                            — role-specific endpoints, sampling, and a
 *                            no-system-prompt mode for the Hy-MT2
 *                            translation model, which takes a single user
 *                            message by design) — replaces the old callAi()
 *   - createAgentHandle(...) a tool-using agent backed by an open-harness
 *                            Session (retry with backoff + context
 *                            compaction) for the agentic stages
 *   - createWikiTools()      Wikipedia research tools backed by research.js
 *   - createGatedFsTools()   filesystem tools whose writes are confined to
 *                            the volume folder (reads allowed, deletes denied)
 *   - createEpubTools()      epub-aware tools (epubInfo / readEpubText /
 *                            stageVolume) — the intake agent's senses, so it
 *                            can open a book instead of guessing from its name
 *
 * Local LLM support: the provider uses a custom fetch with undici's
 * header/body timeouts disabled (local servers can prefill for minutes),
 * merges the Qwen3-style thinking parameters into the request body, and
 * taps the SSE/JSON responses for `reasoning_content` so thinking-model
 * diagnostics survive the move to the AI SDK.
 *
 * Usage (module):
 *   const harness = require("./harness");
 *   const text = await harness.runOneShot({
 *     systemPrompt: "You are a helpful assistant.",
 *     messages: [{ text: "Hello" }],
 *   });
 *
 * Usage (CLI):
 *   node harness.js --system "You are helpful" --text "Hello"
 *   node harness.js --system "You are helpful" --file ./img.png --name "img.png" --text "Describe this"
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
require("./types"); // JSDoc type definitions
const { fileTypeFromBuffer } = require("file-type");
const { Agent: UndiciAgent, fetch: undiciFetch } = require("undici");
const { tool, generateText } = require("ai");
const { z } = require("zod");

// Local LLM servers (e.g. llama.cpp) can take many minutes to prefill a huge
// prompt and to generate a long answer. undici's default fetch timeouts
// (300 s for response headers and between body chunks) would abort such
// requests with an opaque "TypeError: fetch failed", so disable them for
// every model request.
const noTimeoutAgent = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 });

// ─── ESM bridge ─────────────────────────────────────────────────────────────
// @openharness/core and @ai-sdk/openai ship ESM-only builds while this
// project is CommonJS; load them lazily and memoize the result.

let esm = null;

/**
 * Load (and memoize) the ESM-only OpenHarness and OpenAI provider modules.
 * @returns {Promise<{core: Object, openaiProvider: Object}>}
 */
async function loadEsm() {
  if (!esm) {
    const [core, openaiProvider] = await Promise.all([
      import("@openharness/core"),
      import("@ai-sdk/openai"),
    ]);
    esm = { core, openaiProvider };
  }
  return esm;
}

// ─── Run logging ────────────────────────────────────────────────────────────
// Every call's diagnostic output is also written to a per-run log directory
// under .logs/ (one directory per process) so runs can be inspected after
// the fact. The directory contains:
//   - summary.log        (CALL / RESULT / WARNING lines — greppable)
//   - one-shot/<label>.md  (full system prompt + messages + response for
//                          each tool-less runOneShot call)
//   - agent-<name>/turn-<N>.md  (full chat history for each agent turn:
//                          system prompt, user input, assistant response,
//                          reasoning, tool calls + results)
// The log line prefix ("[call-ai]") is kept from the previous implementation
// so old and new run logs stay greppable side by side.
const logsDir = path.join(__dirname, ".logs");
let logStream = null;
let logFilePath = null;
let runDir = null;

/**
 * Get (and lazily create) the writable stream for the current run's summary
 * log.  Also creates the per-run directory structure.
 * @returns {import("fs").WriteStream} The log file stream.
 */
function getLogStream() {
  if (!logStream) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    runDir = path.join(logsDir, stamp);
    fs.mkdirSync(runDir, { recursive: true });
    logFilePath = path.join(runDir, "summary.log");
    logStream = fs.createWriteStream(logFilePath, { flags: "a" });
    logStream.on("error", (err) => {
      console.error(`[harness] log file error: ${err.message}`);
    });
    logStream.write(`=== call-ai run log started: ${new Date().toISOString()} ===\n`);
    logStream.write(
      `model=${process.env.AI_MODEL || "gpt-4o-mini"} ` +
        `base_url=${process.env.AI_BASE_URL || "https://api.openai.com/v1"} ` +
        `max_tokens=${process.env.AI_MAX_TOKENS || "1024"}\n`
    );
    console.error(`[call-ai] logging to ${runDir}`);
  }
  return logStream;
}

/**
 * Log a line to both stderr and the current run's summary log file.
 * @param {string} message - The line to log.
 */
function logLine(message) {
  console.error(message);
  try { getLogStream().write(message + "\n"); } catch {}
}

/**
 * Escape text for inclusion in a Markdown code block (prevents triple backticks
 * from prematurely closing the block).
 * @param {string} text - The text to escape.
 * @returns {string} The escaped text.
 */
function escapeCodeBlock(text) {
  if (!text) return "";
  return text.replace(/```/g, "`-`-`-");
}

/**
 * Escape text for inline code (prevents backtick issues).
 * @param {string} text - The text to escape.
 * @returns {string} The escaped text.
 */
function escapeInline(text) {
  if (!text) return "";
  return String(text).replace(/`/g, "\u200B`").slice(0, 500);
}

// Triple-backtick delimiter for Markdown code blocks (avoiding template literal syntax issues).
const CODE_BLOCK = "\x60\x60\x60";

/**
 * Write a one-shot call log file: full system prompt, messages, and response.
 * Called after runOneShot completes.
 *
 * @param {string} label - The label for this call (used in filename).
 * @param {string|null} systemPrompt - The full system prompt (null/empty when
 *   the call intentionally sends none — e.g. the Hy-MT2 translation role).
 * @param {Array} messages - The messages sent.
 * @param {string} response - The model's response text.
 * @param {Object} result - The consumeEvents result (usage, timing, etc.).
 * @param {string} [modelName] - The model actually called (role endpoints can
 *   differ from the global AI_MODEL; defaults to the env value).
 */
function writeOneShotLog(label, systemPrompt, messages, response, result, modelName = null) {
  try {
    const oneShotDir = path.join(runDir, "one-shot");
    fs.mkdirSync(oneShotDir, { recursive: true });

    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
    const logFile = path.join(oneShotDir, `${safeLabel}.md`);

    const durationMs = result.startTime ? Date.now() - result.startTime : null;
    const ttftMs = result.firstTokenTime ? result.firstTokenTime - result.startTime : null;

    let content = `# One-shot call: ${label}\n`;
    content += `# Model: ${modelName || process.env.AI_MODEL || "gpt-4o-mini"}\n`;

    if (result.usage) {
      content += `# Tokens: prompt=${result.usage.inputTokens ?? "?"} completion=${result.usage.outputTokens ?? "?"} total=${result.usage.totalTokens ?? "?"}\n`;
    }

    if (ttftMs != null) content += `# TTFT: ${(ttftMs / 1000).toFixed(2)}s\n`;
    if (durationMs != null) content += `# Duration: ${(durationMs / 1000).toFixed(2)}s\n`;
    content += `# Finish: ${result.finishReason ?? "n/a"}\n`;
    content += `\n`;

    content += `## System Prompt\n`;
    content += systemPrompt
      ? `${CODE_BLOCK}\n${escapeCodeBlock(systemPrompt)}\n${CODE_BLOCK}\n\n`
      : "(none — this call sends no system message by design)\n\n";

    content += `## Messages\n`;
    for (const msg of messages) {
      if (msg.text) {
        content += `${CODE_BLOCK}\n${escapeCodeBlock(msg.text)}\n${CODE_BLOCK}\n\n`;
      }
    }

    content += `## Response\n`;
    content += `${CODE_BLOCK}\n${escapeCodeBlock(response)}\n${CODE_BLOCK}\n\n`;

    fs.writeFileSync(logFile, content, "utf-8");
  } catch (err) {
    console.error(`[harness] failed to write one-shot log: ${err.message}`);
  }
}

/**
 * Write a per-agent chat log file for one turn.
 * Called from agent.sendTurn() after each turn completes.
 *
 * @param {string} agentName - The agent name (used in directory name).
 * @param {number} turnNumber - The turn number (for file naming).
 * @param {Object} opts - Options.
 * @param {string} opts.systemPrompt - The full system prompt.
 * @param {string|Array} opts.input - The user input.
 * @param {Object} opts.result - The consumeEvents result.
 * @param {Array} opts.toolCalls - Array of {name, input, output, error}.
 * @param {string} opts.label - The log label.
 */
function writeAgentTurnLog(agentName, turnNumber, opts) {
  const { systemPrompt, input, result, toolCalls = [], label } = opts;
  try {
    const agentDir = path.join(runDir, `agent-${agentName}`);
    fs.mkdirSync(agentDir, { recursive: true });

    const turnFile = path.join(agentDir, `turn-${String(turnNumber).padStart(3, "0")}.md`);

    const durationMs = result.startTime ? Date.now() - result.startTime : null;
    const ttftMs = result.firstTokenTime ? result.firstTokenTime - result.startTime : null;

    let content = `# Agent: ${agentName}\n`;
    content += `# Turn: ${String(turnNumber).padStart(3, "0")}\n`;
    content += `# Label: ${label}\n`;
    content += `# Model: ${process.env.AI_MODEL || "gpt-4o-mini"}\n`;

    if (result.usage) {
      content += `# Tokens: prompt=${result.usage.inputTokens ?? "?"} completion=${result.usage.outputTokens ?? "?"} total=${result.usage.totalTokens ?? "?"}\n`;
    }

    if (ttftMs != null) content += `# TTFT: ${(ttftMs / 1000).toFixed(2)}s\n`;
    if (durationMs != null) content += `# Duration: ${(durationMs / 1000).toFixed(2)}s\n`;
    content += `# Finish: ${result.finishReason ?? "n/a"}\n`;
    content += `\n`;

    content += `## System Prompt\n`;
    content += `${CODE_BLOCK}\n${escapeCodeBlock(systemPrompt)}\n${CODE_BLOCK}\n\n`;

    content += `## User Message\n`;
    if (typeof input === "string") {
      content += `${CODE_BLOCK}\n${escapeCodeBlock(input)}\n${CODE_BLOCK}\n\n`;
    } else if (Array.isArray(input)) {
      for (const msg of input) {
        if (msg.text) {
          content += `${CODE_BLOCK}\n${escapeCodeBlock(msg.text)}\n${CODE_BLOCK}\n\n`;
        }
      }
    }

    content += `## Assistant Response\n`;
    if (result.text) {
      content += `${CODE_BLOCK}\n${escapeCodeBlock(result.text)}\n${CODE_BLOCK}\n\n`;
    } else {
      content += `(no text output)\n\n`;
    }

    if (result.reasoning) {
      content += `## Reasoning\n`;
      content += `${CODE_BLOCK}\n${escapeCodeBlock(result.reasoning)}\n${CODE_BLOCK}\n\n`;
    }

    if (toolCalls.length > 0) {
      content += `## Tool Calls\n`;
      for (const tc of toolCalls) {
        content += `- **${tc.name}**\n`;
        content += `  - Input: \`${escapeInline(tc.input)}\`\n`;
        if (tc.output) content += `  - Output: \`${escapeInline(tc.output)}\`\n`;
        if (tc.error) content += `  - Error: \`${escapeInline(tc.error)}\`\n`;
      }
      content += `\n`;
    }

    fs.writeFileSync(turnFile, content, "utf-8");
  } catch (err) {
    console.error(`[harness] failed to write agent turn log: ${err.message}`);
  }
}

// ─── Provider / fetch layer ─────────────────────────────────────────────────

/**
 * Create the per-attempt diagnostics "taps" holder shared between the fetch
 * layer (SSE/JSON taps) and the event consumer (reasoning text + first-token
 * time). Taps are passed to the provider fetch through this ref object so
 * multi-turn handles can swap in a fresh taps object per turn.
 *
 * @returns {{current: (Object|null)}} The taps ref (null initially).
 */
function createTapsRef() {
  return { current: null };
}

/**
 * Build the per-attempt taps object (see createTapsRef).
 * @returns {{reasoning: string[], firstToken: (number|null), markFirstToken: Function, jsonReasoningReady: (Promise|null)}}
 */
function createTaps() {
  return {
    reasoning: [],
    firstToken: null,
    markFirstToken() {
      if (this.firstToken === null) this.firstToken = Date.now();
    },
    jsonReasoningReady: null,
  };
}

/**
 * Tap an SSE response body: every chunk passes through unchanged while
 * `data:` lines are inspected for `choices[0].delta.reasoning_content` /
 * `delta.reasoning` (llama.cpp, vLLM and friends emit thinking this way) and
 * for the first non-empty token (TTFT diagnostics).
 *
 * @param {ReadableStream} body - The SSE body stream.
 * @param {Taps} taps - The taps object to record into.
 * @returns {ReadableStream} The pass-through stream.
 */
function tapSseStream(body, taps) {
  const decoder = new TextDecoder();
  let buffer = "";
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let data;
          try {
            data = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = data?.choices?.[0]?.delta;
          if (!delta) continue;
          const reasoning =
            typeof delta.reasoning_content === "string"
              ? delta.reasoning_content
              : typeof delta.reasoning === "string"
                ? delta.reasoning
                : "";
          if (reasoning) {
            taps.reasoning.push(reasoning);
            taps.markFirstToken();
          } else if (typeof delta.content === "string" && delta.content !== "") {
            taps.markFirstToken();
          }
        }
      },
    })
  );
}

/**
 * Build the fetch implementation handed to the AI SDK provider.
 *
 * - dispatches through undici's own fetch with a no-timeout Agent from the
 *   SAME undici build (global fetch + foreign Agent mixes undici versions —
 *   see the comment at the fetch call below)
 * - merges `extraBody` (thinking parameters) into chat-completion bodies
 * - taps SSE streams for reasoning_content / first-token diagnostics, and
 *   non-streaming JSON responses for `message.reasoning_content`
 *
 * @param {{extraBody?: Object|null, tapsRef?: {current: Object}|null}} [options]
 * @returns {Function} A fetch-compatible function for createOpenAI({ fetch }).
 */
function makeProviderFetch({ extraBody = null, tapsRef = null } = {}) {
  return async function providerFetch(input, init = {}) {
    let { body, headers } = init;
    if (extraBody && typeof body === "string" && body.length > 0) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
          body = JSON.stringify({ ...parsed, ...extraBody });
          // The body length changed — drop any stale content-length header.
          if (headers) {
            if (typeof headers.delete === "function") headers.delete("content-length");
            else delete headers["content-length"];
          }
        }
      } catch {
        // Not a JSON body — pass through untouched.
      }
    }
    // Dispatch through undici's OWN fetch (same build as noTimeoutAgent) —
    // NOT the global fetch. Node's bundled undici is a different version:
    // handing the npm v8 Agent to the global fetch mixes handler protocols
    // and throws "invalid onRequestStart method" (UND_ERR_INVALID_ARG) on
    // Node builds whose bundled undici is older. (Observed live after a
    // Windows→Linux migration: identical code + node_modules worked on the
    // Windows machine's Node but failed on Linux Node 22.)
    // Headers are normalized to a plain object: undici's webidl converters
    // would silently convert a foreign (global) Headers instance to an empty
    // record, dropping auth/content-type headers.
    let headersPlain = headers;
    if (headers && typeof headers.forEach === "function") {
      headersPlain = {};
      headers.forEach((value, key) => {
        headersPlain[key] = value;
      });
    }
    const response = await undiciFetch(input, {
      ...init,
      body,
      headers: headersPlain,
      dispatcher: noTimeoutAgent,
    });
    const taps = tapsRef?.current;
    if (!taps) return response;
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (contentType.includes("text/event-stream") && response.body) {
      return new Response(tapSseStream(response.body, taps), response);
    }
    if (contentType.includes("application/json") && response.ok) {
      // Non-streaming response: read a clone for message.reasoning_content
      // without disturbing the body the provider consumes.
      taps.jsonReasoningReady = response
        .clone()
        .text()
        .then((raw) => {
          try {
            const message = JSON.parse(raw)?.message;
            const reasoning =
              typeof message?.reasoning_content === "string"
                ? message.reasoning_content
                : typeof message?.reasoning === "string"
                  ? message.reasoning
                  : "";
            if (reasoning) taps.reasoning.push(reasoning);
          } catch {
            // Not the shape we expected — nothing to capture.
          }
        })
        .catch(() => {});
    }
    return response;
  };
}

/**
 * Create the OpenAI-compatible chat model for the endpoint in .env (or an
 * explicit per-call endpoint override — the translation stage's roles each
 * point at their own model: TRANSLATE_* / VERIFY_* / EDIT_* in .env, which
 * all fall back to the global AI_* settings).
 *
 * @param {{extraBody?: Object|null, tapsRef?: {current: Object}|null, endpoint?: {baseUrl?: string, apiKey?: string, model?: string}|null}} [options]
 * @returns {Promise<{model: Object, baseUrl: string, modelId: string}>}
 *   The chat model (AI SDK LanguageModel) plus the resolved endpoint info.
 */
async function createChatModel({ extraBody = null, tapsRef = null, endpoint = null } = {}) {
  const baseUrl =
    endpoint?.baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1";
  const apiKey = endpoint?.apiKey || process.env.AI_API_KEY;
  const modelId = endpoint?.model || process.env.AI_MODEL || "gpt-4o-mini";
  if (!apiKey) {
    throw new Error(
      "AI_API_KEY is not set. Set it in a .env file or as an environment variable."
    );
  }
  const { openaiProvider } = await loadEsm();
  const provider = openaiProvider.createOpenAI({
    name: "ai-client",
    baseURL: baseUrl,
    apiKey,
    fetch: makeProviderFetch({ extraBody, tapsRef }),
  });
  // .chat() pins the chat-completions endpoint (not the OpenAI Responses
  // API), which is what OpenAI-compatible local servers implement.
  return { model: provider.chat(modelId), baseUrl, modelId };
}

/**
 * The extra request-body parameters for thinking models (the same wire
 * parameters the old call-ai.js sent): `thinking: false` disables the
 * Qwen3-style thinking phase via chat_template_kwargs; `thinkingLevel` sets
 * the OpenAI-standard reasoning_effort parameter (also supported by
 * llama.cpp and Ollama).
 *
 * Two chat-template dialects:
 *   - "qwen" (default): Qwen3-style models. thinking=false sends
 *     chat_template_kwargs {thinking:false, enable_thinking:false}; thinking
 *     on sends reasoning_effort (the explicit level or the env default).
 *   - "hy-mt": the Hy-MT2 (hy_v3) translation model. Its Jinja template
 *     toggles thinking via the reasoning_effort variable ONLY — "low"/"high"
 *     open the think tag (slow thinking) and "no_think" forces the fast
 *     (non-thinking) translation mode, which is the mode the model is
 *     benchmarked in. Booleans map: false -> "no_think", true -> the level
 *     or "low". The Qwen-style chat_template_kwargs keys do not exist in
 *     that template, so they are never sent for this dialect.
 *
 * @param {{thinking?: boolean|string, thinkingLevel?: string, template?: "qwen"|"hy-mt"}} [cfg]
 * @returns {Object|null} The parameters to merge into the request body, or null.
 */
function thinkingExtraBody({ thinking = true, thinkingLevel, template = "qwen" } = {}) {
  if (template === "hy-mt") {
    const value =
      thinking === false
        ? "no_think"
        : typeof thinking === "string"
          ? thinking
          : thinkingLevel || "low";
    if (!["no_think", "low", "high"].includes(value)) {
      throw new Error(
        `Invalid thinking value "${value}" for the hy-mt template ` +
          `(expected "no_think", "low", or "high").`
      );
    }
    return { reasoning_effort: value };
  }
  const extra = {};
  if (thinking === false) {
    // llama.cpp / Ollama honor a top-level `chat_template_kwargs` to disable
    // Qwen3-style thinking; unknown keys pass through to the server as-is.
    extra.chat_template_kwargs = { thinking: false, enable_thinking: false };
  }
  if (thinking !== false) {
    // When thinking is on and no explicit level, use the env default.
    extra.reasoning_effort = thinkingLevel ?? envThinkingLevel();
  }
  return Object.keys(extra).length > 0 ? extra : null;
}

// ─── Env-derived call settings ──────────────────────────────────────────────

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
 * Thinking mode (AI_THINKING env, default ON).
 */
function envThinking() {
  let performThinking = true;

  if (typeof process.env.AI_THINKING === 'undefined' || process.env.AI_THINKING === "") {
    return performThinking;
  }

  return process.env.AI_THINKING === "true" || process.env.AI_THINKING === "1";
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

/** Maximum output tokens per call (AI_MAX_TOKENS env, default 1024). */
function envMaxTokens() {
  return parseInt(process.env.AI_MAX_TOKENS, 10) || 1024;
}

/** Sampling temperature (AI_TEMPERATURE env, default 0.7). */
function envTemperature() {
  const t = parseFloat(process.env.AI_TEMPERATURE);
  return Number.isNaN(t) ? 0.7 : t;
}

/**
 * Context window (tokens) at which session auto-compaction engages
 * (AGENT_CONTEXT_WINDOW env, default 128000). Set it to your server's context
 * size so compaction kicks in before the server runs out of context.
 */
function envContextWindow() {
  const n = parseInt(process.env.AGENT_CONTEXT_WINDOW, 10);
  return Number.isInteger(n) && n >= 4096 ? n : 128000;
}

/** Default step cap for tool-using agents (AGENT_MAX_STEPS env, default 20). */
function agentMaxSteps() {
  const n = parseInt(process.env.AGENT_MAX_STEPS, 10);
  return Number.isInteger(n) && n >= 1 ? n : 20;
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

/**
 * Convert a single IMessage into an AI SDK ModelMessage (user role).
 *
 * Text messages become plain text parts. File messages are detected with
 * `file-type`: images and wav/mp3 audio become binary file parts; files whose
 * type cannot be determined (plain text, e.g. the .md sources) are read and
 * embedded in the message exactly as the old call-ai.js did.
 *
 * @param {IMessage} message - The message ({ text } or { file, name }).
 * @returns {Promise<{role: string, content: Array<Object>}>}
 */
async function toModelMessage(message) {
  if (message.text !== undefined) {
    return { role: "user", content: [{ type: "text", text: message.text }] };
  }

  if (message.file === undefined) {
    throw new Error(
      "Each message must have either a `text` or a `file` property."
    );
  }

  if (typeof message.name !== "string" || !message.name) {
    throw new Error("File messages require a `name` property.");
  }

  const filePath = path.resolve(message.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const buffer = fs.readFileSync(filePath);
  const fileType = await fileTypeFromBuffer(buffer);
  const base64 = buffer.toString("base64");

  if (!fileType) {
    // Unrecognized type (plain text) — inline the content, as before.
    const content = buffer.toString("utf-8").trim();
    return {
      role: "user",
      content: [
        { type: "text", text: `File: ${message.name}\nContent:\n\n${content}` },
      ],
    };
  }

  const mime = fileType.mime;
  if (mime.startsWith("image/")) {
    return {
      role: "user",
      content: [
        { type: "file", mediaType: mime, data: base64 },
        { type: "text", text: `File: ${message.name}` },
      ],
    };
  }
  if (mime === "audio/wav" || mime === "audio/mp3" || mime === "audio/mpeg") {
    return {
      role: "user",
      content: [
        { type: "file", mediaType: mime, data: base64 },
        { type: "text", text: `File: ${message.name}` },
      ],
    };
  }
  // Other binary types (video, other audio, ...) are not representable as
  // OpenAI-compatible chat-completion content parts on this provider.
  throw new Error(
    `Unsupported attachment type for "${message.name}" (${mime}). ` +
      "Supported attachments: images, wav/mp3 audio, and files whose type " +
      "cannot be detected (they are inlined as text)."
  );
}

/**
 * Convert an array of IMessages to AI SDK ModelMessages, in order.
 *
 * @param {Array<IMessage>} messages - The messages.
 * @returns {Promise<Array<Object>>} The ModelMessages.
 */
async function toModelMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array of IMessage objects.");
  }
  return Promise.all(messages.map(toModelMessage));
}

// ─── Tools ──────────────────────────────────────────────────────────────────

/**
 * Build the Wikipedia research tools for the researcher agent.
 *
 * Backed by research.js (keyless Wikipedia Action API, politeness delays,
 * per-request timeouts): the model decides what to search for and which
 * pages to pull, instead of the old fixed batch over every extracted term.
 * Result sizes honor the same RESEARCH_MAX_RESULTS / RESEARCH_EXTRACT_CHARS
 * environment settings as the classic research pass.
 *
 * @returns {WikiTools} Tool set: { wiki_search, wiki_extract }.
 */
function createWikiTools() {
  const {
    wikiSearch,
    wikiExtract,
    wikiLangs,
    maxResults,
    maxExtractChars,
  } = require("./research");
  const langs = wikiLangs();
  return {
    wiki_search: tool({
      description:
        `Search Wikipedia for a term. Returns matching page titles ` +
        `(up to ${maxResults()} per language). Languages: ${langs.join(", ")}. ` +
        `Pass lang to restrict to one language; omit it to search all. ` +
        `Use the term's original-language spelling when known.`,
      inputSchema: z.object({
        query: z.string().describe("The term to search for."),
        lang: z
          .string()
          .optional()
          .describe(
            `Optional single language subdomain (one of: ${langs.join(", ")}).`
          ),
      }),
      execute: async ({ query, lang }) => {
        const targets = lang ? [lang] : langs;
        const out = {};
        for (const l of targets) {
          try {
            const hits = await wikiSearch(l, query);
            out[l] = hits.slice(0, maxResults()).map((h) => h.title);
          } catch (err) {
            out[l] = `search error: ${err.message}`;
          }
        }
        return JSON.stringify(out);
      },
    }),
    wiki_extract: tool({
      description:
        `Fetch the plain-text intro of a Wikipedia page (up to ` +
        `${maxExtractChars()} characters). title must be exactly as returned ` +
        `by wiki_search, and lang the language it came from.`,
      inputSchema: z.object({
        title: z.string().describe("Exact page title from wiki_search results."),
        lang: z
          .string()
          .describe(
            `Language subdomain the title came from (one of: ${langs.join(", ")}).`
          ),
      }),
      execute: async ({ title, lang }) => {
        try {
          const text = (await wikiExtract(lang, title)).slice(0, maxExtractChars());
          return text ? text : "(page has no intro extract)";
        } catch (err) {
          return `extract error: ${err.message}`;
        }
      },
    }),
  };
}

// ─── Epub tools (the intake agent's senses) ─────────────────────────────────

/**
 * Build the epub-aware tools the series-intake agent needs to actually look
 * inside a book. The plain filesystem tools cannot do this: readFile rejects
 * binary files and an epub is a zip, so without these the agent could only
 * guess from file names.
 *
 * These tools are deliberately senses, not decisions — they unzip, read, and
 * report. Which files are volumes, what order they go in, what language they
 * are in, and where each volume's artifacts will live are the agent's calls.
 *
 *   - epubInfo(filePath)                 the book's catalog card + section list
 *   - readEpubText(filePath, ...)        a bounded slice of one section's text
 *   - stageVolume({sourceFile, folder, as})
 *                                        create the volume folder and copy the
 *                                        source into it (the agent's "put the
 *                                        book where it belongs" action)
 *
 * Text comes back in bounded windows (sampleChars per call) on purpose: an
 * agent sampling 17 books must not blow its own context window, and it only
 * needs enough of each opening to tell the books apart.
 *
 * @param {{cwd?: string, allowedDirs: string[], sampleChars?: number}} cfg
 * @returns {Promise<{tools: Object, approve: Function}>} The tool set plus its
 *   approve gate (compose it with createGatedFsTools' gate using AND).
 */
async function createEpubTools({ cwd = process.cwd(), allowedDirs, sampleChars = 1500 }) {
  if (!Array.isArray(allowedDirs) || allowedDirs.length === 0) {
    throw new Error("createEpubTools requires a non-empty allowedDirs array.");
  }
  const fsp = require("fs").promises;
  const crypto = require("crypto");
  const { openEpub, readEpubSection, scriptCounts, isEpubPath } = require("./utils/source");
  const allowed = allowedDirs.map((dir) => path.resolve(dir));
  const inside = (p) => {
    const resolved = path.resolve(cwd, p);
    return allowed.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep));
  };
  /** Raw (uncompressed) size of a zip entry, when the archive reports one. */
  const entryBytes = (entry) =>
    entry && entry._data && typeof entry._data.uncompressedSize === "number"
      ? entry._data.uncompressedSize
      : null;
  const sha256Of = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

  const tools = {
    epubInfo: tool({
      description:
        "Open an .epub file and report what it is: its catalog card (title, " +
        "author, language tag, publisher, identifier, and the series name and " +
        "book number the reading app embedded), how many readable sections it " +
        "has with their titles, its text size and its image count.",
      inputSchema: z.object({
        filePath: z
          .string()
          .describe("Path to the .epub file (relative to the working folder)."),
      }),
      execute: async ({ filePath }) => {
        const abs = path.resolve(cwd, filePath);
        try {
          const opened = await openEpub(abs);
          const st = await fsp.stat(abs);
          const sections = opened.textItems.map((it) => ({
            index: it.index,
            title: opened.titles.get(it.zipPath) || it.href,
            bytes: entryBytes(opened.zip.file(it.zipPath)),
          }));
          const textBytes = sections.reduce((n, s) => n + (s.bytes || 0), 0);
          return JSON.stringify(
            {
              file: filePath,
              sizeBytes: st.size,
              entries: opened.entryCount,
              images: opened.imageCount,
              readableSections: sections.length,
              textBytes,
              metadata: opened.metadata,
              sections,
            },
            null,
            1
          );
        } catch (err) {
          return `epubInfo error for ${filePath}: ${err.message}`;
        }
      },
    }),

    readEpubText: tool({
      description:
        `Read the plain text of one readable section of an .epub file as a ` +
        `bounded slice (up to ${sampleChars} characters per call; use offset ` +
        `to move further in). Use it to sample a book's opening: the writing ` +
        `system, any volume/series markers inside the text, and whether the ` +
        `file is prose at all. Returns the text plus a raw count of the ` +
        `scripts seen (kana / hangul / Han / latin) as evidence.`,
      inputSchema: z.object({
        filePath: z.string().describe("Path to the .epub file."),
        section: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based section index (from epubInfo). Default: 1."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset into the section. Default: 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(6000)
          .optional()
          .describe(`Characters to return (default ${sampleChars}, max 6000).`),
      }),
      execute: async ({ filePath, section, offset, limit }) => {
        const abs = path.resolve(cwd, filePath);
        try {
          const opened = await openEpub(abs);
          const slice = await readEpubSection(opened, section || 1, {
            offset: offset || 0,
            limit: Math.min(limit || sampleChars, 6000),
          });
          return JSON.stringify(
            {
              file: filePath,
              section: slice.index,
              title: slice.title,
              totalChars: slice.totalChars,
              from: slice.from,
              scripts: scriptCounts(slice.text),
              text: slice.text,
            },
            null,
            1
          );
        } catch (err) {
          return `readEpubText error for ${filePath}: ${err.message}`;
        }
      },
    }),

    stageVolume: tool({
      description:
        "Create a volume folder inside the series location and copy a source " +
        "file into it — the action that lays the series out for the rest of " +
        "the pipeline. The original file is never moved or modified. Re-staging " +
        "the same content is a no-op; staging a DIFFERENT file over an existing " +
        "one is refused.",
      inputSchema: z.object({
        sourceFile: z
          .string()
          .describe("Path of the source file to stage (relative to the working folder)."),
        folder: z
          .string()
          .describe(
            "The volume folder to create, relative to the working folder. A plain folder name — no absolute path, no '..'."
          ),
        as: z
          .string()
          .optional()
          .describe(
            "File name to store the source under inside the folder (default: its original name)."
          ),
      }),
      execute: async ({ sourceFile, folder, as }) => {
        const src = path.resolve(cwd, sourceFile);
        const dir = path.resolve(cwd, folder);
        const name = as || path.basename(src);
        if (path.isAbsolute(folder)) {
          return `stageVolume refused: folder "${folder}" must be relative to the series location.`;
        }
        if (folder.split(/[\\/]/).includes("..")) {
          return `stageVolume refused: folder "${folder}" escapes the series location.`;
        }
        if (folder.includes("/") || folder.includes("\\")) {
          return `stageVolume refused: folder "${folder}" must be a single folder name directly inside the series location.`;
        }
        if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
          return `stageVolume refused: "${as}" is not a plain file name.`;
        }
        if (!inside(dir) || !inside(path.join(dir, name))) {
          return `stageVolume refused: "${folder}" is outside the allowed write area.`;
        }
        let st;
        try {
          st = await fsp.stat(src);
        } catch {
          return `stageVolume refused: source file not found: ${sourceFile}`;
        }
        if (!st.isFile()) return `stageVolume refused: "${sourceFile}" is not a file.`;
        const target = path.join(dir, name);
        const srcHash = sha256Of(await fsp.readFile(src));
        let existing = null;
        try {
          existing = await fsp.readFile(target);
        } catch {
          /* nothing staged there yet */
        }
        if (existing) {
          if (sha256Of(existing) === srcHash) {
            return JSON.stringify({ staged: true, unchanged: true, file: target, sha256: srcHash });
          }
          return `stageVolume refused: ${target} already holds different content. Pick a different folder or file name.`;
        }
        await fsp.mkdir(dir, { recursive: true });
        await fsp.copyFile(src, target);
        return JSON.stringify({
          staged: true,
          unchanged: false,
          file: target,
          bytes: st.size,
          sha256: srcHash,
          isEpub: isEpubPath(target),
        });
      },
    }),
  };

  const approve = (call) => {
    // Looking inside a book is always allowed — the agent must be able to read
    // before it decides. Staging writes, so it goes through the same
    // confinement as writeFile, and deleteFile stays denied outright.
    if (call.toolName === "deleteFile") return false;
    if (call.toolName !== "stageVolume") return true;
    const input = call.input || {};
    if (typeof input.folder !== "string" || input.folder.trim() === "") return false;
    if (typeof input.sourceFile !== "string" || input.sourceFile.trim() === "") return false;
    // One folder level, no escaping, no absolute paths — the same rule the tool
    // itself enforces and the manifest validator (sanitizeFolderName) requires.
    const folder = input.folder.trim();
    if (path.isAbsolute(folder) || folder.includes("/") || folder.includes("\\")) return false;
    if (folder.split(/[\\/]/).includes("..")) return false;
    const dir = path.resolve(cwd, folder);
    const name = input.as || path.basename(String(input.sourceFile));
    return inside(dir) && inside(path.join(dir, name));
  };

  return { tools, approve };
}

/**
 * Build the filesystem tools (readFile/listFiles/grep/writeFile/editFile/
 * deleteFile) with an open-harness approve() gate:
 *
 * - reads (readFile, listFiles, grep) are always allowed;
 * - writes/edits are confined to `allowedDirs` (paths resolved relative to
 *   `cwd`), so a wandering agent cannot clobber the rest of the series;
 * - deleteFile is denied outright (no workflow needs it).
 *
 * @param {{cwd?: string, allowedDirs: string[]}} cfg
 * @returns {Promise<{tools: Object, approve: Function}>}
 */
async function createGatedFsTools({ cwd = process.cwd(), allowedDirs }) {
  if (!Array.isArray(allowedDirs) || allowedDirs.length === 0) {
    throw new Error("createGatedFsTools requires a non-empty allowedDirs array.");
  }
  const { core } = await loadEsm();
  const fsTools = core.createFsTools(new core.NodeFsProvider({ cwd }));
  const allowed = allowedDirs.map((dir) => path.resolve(dir));
  const approve = (call) => {
    const mutating =
      call.toolName === "writeFile" ||
      call.toolName === "editFile" ||
      call.toolName === "deleteFile";
    if (!mutating) return true;
    if (call.toolName === "deleteFile") return false;
    const raw = call.input?.filePath;
    if (typeof raw !== "string" || raw.length === 0) return false;
    const resolved = path.resolve(cwd, raw);
    return allowed.some(
      (dir) => resolved === dir || resolved.startsWith(dir + path.sep)
    );
  };
  return { tools: fsTools, approve };
}

// ─── Event consumption ──────────────────────────────────────────────────────

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
 * Consume an open-harness event stream (Session.send / Conversation.send /
 * Agent.run) to completion, logging progress the way the old call-ai.js did
 * (periodic character counts, retry notices, one RESULT line at the end).
 *
 * @param {AsyncIterable<Object>} events - The event stream.
 * @param {{label: string, tapsRef: {current: Object}, logContext?: Object, signal?: AbortSignal}} opts - The log label
 *   (agent/stage name), the taps ref (the per-attempt taps object), optional
 *   log context for streaming logs, and an optional AbortSignal used by the
 *   runaway-generation guard to cancel the underlying fetch.
 * @returns {Promise<Object>} The accumulated result:
 *   { text, reasoning, finishReason, usage, result, error, messages,
 *     startTime, firstTokenTime }. Throws the run's error when the stream
 *     ends with result "error", or a descriptive error when the runaway
 *     generation guard trips.
 */
async function consumeEvents(
  events,
  { label, tapsRef, logContext, signal, idleDeadlineMs = 0, onIdleExpire = null }
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
  };
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
      const fileName = isAgent
        ? `turn-${String(logContext.turnNumber).padStart(3, "0")}.stream.md`
        : `${logContext.label.replace(/[^a-zA-Z0-9_-]/g, "_")}.stream.md`;
      logFilePath = path.join(logDir, fileName);
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
          if (signal && result.text.length > agentTextGuardChars() && result.toolCalls.length < 3) {
            guardTripped = true;
            logLine(
              `  [call-ai] WARNING: ${label} generated ${result.text.length} chars ` +
              `with only ${result.toolCalls.length} tool call(s); aborting runaway generation.`
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
          break;
        case "tool.start":
          // Per-step visibility for tool-using agents: what is being called.
          logLine(
            `  …[agent] ${event.toolName} ${summarizeInput(event.input)}`
          );
          // Collect tool call for chat log.
          result.toolCalls.push({
            name: event.toolName,
            input: event.input,
            output: null,
            error: null,
          });
          break;
        case "tool.error":
          logLine(
            `  …[agent] ${event.toolName} errored: ${String(event.error).slice(0, 160)}`
          );
          // Mark the last unfinished tool call with the error.
          const lastTool = result.toolCalls[result.toolCalls.length - 1];
          if (lastTool && lastTool.output === null && lastTool.error === null) {
            lastTool.error = String(event.error).slice(0, 500);
          }
          break;
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
        default:
          // turn.* / compaction.* lifecycle events: nothing to accumulate.
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
      `${result.text.length} chars of text with only ${result.toolCalls.length} tool call(s). ` +
      `This usually means the model is emitting malformed tool-call text ` +
      `instead of using the tool-calling API. Check the model's tool-calling ` +
      `support or try a different model. Run log: ${logFilePath}`
    );
  }

  // Merge the HTTP-layer-tapped reasoning (llama.cpp-style
  // `reasoning_content`): it is the same thinking the provider-native
  // reasoning events would carry, captured at the fetch layer instead.
  const tapped = (tapsRef.current?.reasoning ?? []).join("");
  if (tapped && !result.reasoning) result.reasoning = tapped;

  if (result.result === "error") {
    throw result.error ?? new Error(`The ${label} run ended in an error.`);
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

/**
 * A single tool-less model call — the drop-in replacement for the old
 * callAi(). Used by acceptance checks, classic-mode pipeline stages, and
 * the CLI below.
 *
 * Mirrors the old behaviour: retries on API errors (via the open-harness
 * retry middleware), falls back to one non-streaming call if the streaming
 * path fails, retries empty responses up to `retry` times, and throws (never
 * returning empty) so callers never persist an empty result.
 *
 * @param {RunOneShotCfg} cfg
 * @param {string|null} [cfg.systemPrompt] - The system prompt. `null`/
 *   `undefined` sends NO system message at all (required by the Hy-MT2
 *   translation role — its official prompt contract is a single user
 *   message; the model has no system prompt).
 * @param {Array<IMessage>} cfg.messages - IMessages ({ text } | { file, name }).
 * @param {number} [cfg.retry] - Extra attempts on empty/error (default: AI_RETRY).
 * @param {boolean|string} [cfg.thinking] - Thinking mode (default: AI_THINKING env, on).
 *   For the hy-mt template dialect also accepts "no_think" | "low" | "high".
 * @param {string} [cfg.thinkingLevel] - reasoning_effort level (default: AI_THINKING_LEVEL env / "xhigh").
 * @param {"qwen"|"hy-mt"} [cfg.thinkingTemplate] - Chat-template dialect for the
 *   thinking parameters (default: "qwen"; "hy-mt" for the Hy-MT2 translation
 *   model — see thinkingExtraBody).
 * @param {{baseUrl?: string, apiKey?: string, model?: string}} [cfg.endpoint] -
 *   Per-call endpoint override (a role's own model; defaults to the global
 *   AI_* settings). The translation stage's roles each use their own.
 * @param {number} [cfg.temperature] - Per-call temperature (default: AI_TEMPERATURE env).
 * @param {{topP?: number, topK?: number, minP?: number, repetitionPenalty?: number, presencePenalty?: number}} [cfg.sampling] -
 *   Per-call sampling parameters merged into the request body (llama.cpp's
 *   OpenAI-compatible API accepts all of these; the server's own defaults
 *   apply to any omitted key).
 * @param {string} [cfg.label] - Log label (default: "one-shot").
 * @returns {Promise<string>} The model's content.
 */
async function runOneShot({
  systemPrompt = null,
  messages,
  retry,
  thinking = envThinking(),
  thinkingLevel,
  thinkingTemplate = "qwen",
  endpoint = null,
  temperature = null,
  sampling = null,
  label = "one-shot",
}) {
  if (systemPrompt != null && (typeof systemPrompt !== "string" || !systemPrompt.trim())) {
    throw new Error(
      "systemPrompt must be a non-empty string (or null/undefined to send no system message)."
    );
  }
  const retryCount =
    Number.isInteger(retry) && retry >= 0 ? retry : envRetry();
  const apiMessages = await toModelMessages(messages);
  let extraBody = thinkingExtraBody({ thinking, thinkingLevel, template: thinkingTemplate });
  if (sampling && typeof sampling === "object") {
    const wireNames = {
      topP: "top_p",
      topK: "top_k",
      minP: "min_p",
      repetitionPenalty: "repetition_penalty",
      presencePenalty: "presence_penalty",
    };
    for (const [key, wire] of Object.entries(wireNames)) {
      if (typeof sampling[key] === "number" && Number.isFinite(sampling[key])) {
        extraBody = { ...(extraBody || {}), [wire]: sampling[key] };
      }
    }
  }
  const temperatureValue =
    typeof temperature === "number" && Number.isFinite(temperature)
      ? temperature
      : envTemperature();
  const maxTokens = envMaxTokens();

  // Resolve the endpoint this call targets (role override or global AI_*).
  const baseUrl =
    endpoint?.baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1";
  const modelId = endpoint?.model || process.env.AI_MODEL || "gpt-4o-mini";

  const systemPreview = systemPrompt
    ? systemPrompt.trim().split("\n")[0].slice(0, 80)
    : "(no system prompt)";
  logLine(
    `[call-ai] CALL system="${systemPreview}" messages=${messages.length} retry=${retryCount} ` +
      `model=${modelId} endpoint=${baseUrl}`
  );

  const { core } = await loadEsm();
  let remaining = retryCount;
  for (;;) {
    const tapsRef = createTapsRef();
    tapsRef.current = createTaps();
    const { model } = await createChatModel({ extraBody, tapsRef, endpoint });
    const agent = new core.Agent({
      name: label,
      model,
      // OpenHarness filters falsy system parts, so "" = no system message.
      systemPrompt: systemPrompt || "",
      temperature: temperatureValue,
      maxTokens,
      instructions: false,
      maxSteps: 1,
    });
    const runner = core.apply(
      core.toRunner(agent),
      core.withRetry({ maxRetries: remaining, isRetryable: () => true }),
      core.withTurnTracking()
    );
    const chat = new core.Conversation({ runner });

    let result;
    // Idle deadline (AI_CALL_DEADLINE_MS): aborts this attempt when the
    // endpoint makes no progress for this long — the only wall-clock bound
    // on a model call (all fetch timeouts are disabled for local servers).
    const idleMs = envCallDeadlineMs();
    const idleCtrl = new AbortController();
    try {
      // Build logContext for streaming logs.
      const logContext = { type: "one-shot", label };
      result = await consumeEvents(
        chat.send(apiMessages, { signal: idleCtrl.signal }),
        {
          label,
          tapsRef,
          logContext,
          idleDeadlineMs: idleMs,
          onIdleExpire: () => idleCtrl.abort(),
        }
      );
    } catch (streamError) {
      if (idleCtrl.signal.aborted) {
        throw new Error(
          `${label}: the call made no progress for ${Math.round(idleMs / 60000)} min ` +
            `and was aborted (AI_CALL_DEADLINE_MS=${idleMs}). The endpoint is likely ` +
            `hung or the model container died — check .logs/ and re-run.`
        );
      }
      // The streaming path failed (API error, parse error, a server that
      // does not actually stream, ...). Fall back to one non-streaming
      // call, mirroring the old call-ai.js behaviour. If the fallback also
      // fails, re-throw the original streaming error.
      logLine(
        `  [call-ai] streaming failed (${streamError.message}); retrying without streaming...`
      );
      const fallbackTapsRef = createTapsRef();
      fallbackTapsRef.current = createTaps();
      const { model: fallbackModel } = await createChatModel({
        extraBody,
        tapsRef: fallbackTapsRef,
        endpoint,
      });
      // The non-streaming fallback has no events to reset the idle timer,
      // so the same deadline applies as a plain (total) timeout.
      const fbCtrl = new AbortController();
      const fbTimer = idleMs > 0 ? setTimeout(() => fbCtrl.abort(), idleMs) : null;
      try {
        const completion = await generateText({
          model: fallbackModel,
          system: systemPrompt || undefined,
          messages: apiMessages,
          temperature: temperatureValue,
          maxOutputTokens: maxTokens,
          abortSignal: fbCtrl.signal,
        });
        await fallbackTapsRef.current.jsonReasoningReady?.catch(() => {});
        result = {
          text: completion.text ?? "",
          reasoning: (fallbackTapsRef.current.reasoning ?? []).join(""),
          finishReason: completion.finishReason,
          usage: {
            inputTokens: completion.usage?.inputTokens,
            outputTokens: completion.usage?.outputTokens,
            totalTokens: completion.usage?.totalTokens,
          },
          result: "complete",
          error: null,
          messages: [],
          startTime: Date.now(),
          firstTokenTime: null,
        };
      } catch {
        if (fbCtrl.signal.aborted) {
          throw new Error(
            `${label}: the call made no progress for ${Math.round(idleMs / 60000)} min ` +
              `and was aborted (AI_CALL_DEADLINE_MS=${idleMs}). The endpoint is likely ` +
              `hung or the model container died — check .logs/ and re-run.`
          );
        }
        throw streamError;
      } finally {
        if (fbTimer) clearTimeout(fbTimer);
      }
    }

    logResultLine(result, label);

    // Log full call details (system prompt, messages, response).
    writeOneShotLog(label, systemPrompt, messages, result.text, result, modelId);

    // Truncation guard: a response cut off at the output token limit
    // (finish_reason="length") is a TRUNCATED answer, never a complete one —
    // persisting it would corrupt the artifact (a half-chapter, a broken JSON
    // extraction, …). Retrying is pointless (the limit is deterministic), so
    // fail loudly instead. The deterministic QA length floor in
    // utils/translate.js is the backstop for the rare case where the finish
    // reason is unavailable.
    if (result.text && result.finishReason === "length") {
      throw new Error(
        `${label}: the model hit its output token limit (finish_reason=length) after ` +
          `${result.text.length} chars — the response is TRUNCATED and was discarded. ` +
          `Increase AI_MAX_TOKENS (currently ${maxTokens}) or shrink the input ` +
          `(e.g. TRANSLATE_CHUNK_CHARS for translation) and re-run.`
      );
    }
    if (result.text) return result.text;
    if (remaining > 0) {
      remaining -= 1;
      continue;
    }
    // Never hand an empty result back to callers: the workflows persist the
    // returned string verbatim, so an empty model response must fail the run
    // instead of corrupting the generated artifacts.
    throw new Error(
      `The model returned no content (finish_reason=${result.finishReason ?? "n/a"}). ` +
        (result.reasoning
          ? "The token budget appears to have been spent on reasoning; try increasing AI_MAX_TOKENS or the model's context limit. "
          : "") +
        `Check the run log: ${logFilePath}`
    );
  }
}

// ─── Tool-using agents ──────────────────────────────────────────────────────

/**
 * Create a tool-using agent handle backed by an open-harness Session
 * (retry with backoff + context auto-compaction).
 *
 * The handle's sendTurn() consumes one turn's event stream with the standard
 * logging and returns the accumulated result; the session keeps its message
 * history between turns, so multi-turn flows (generate -> feedback ->
 * revise) stay in one context. Note: for writing agents an empty final
 * text is a *success* (the output went to disk), so — unlike runOneShot —
 * no empty-content retry is applied here.
 *
 * @param {CreateAgentHandleCfg} cfg
 * @param {string} cfg.name - Agent name (used in logs).
 * @param {string} cfg.systemPrompt - The system prompt.
 * @param {Object} [cfg.tools] - Tool set (omitted/empty = no tools).
 * @param {Function} [cfg.approve] - open-harness ApproveFn (the write gate).
 * @param {string} [cfg.cwd] - Base dir for fs tools (default: process.cwd()).
 * @param {number} [cfg.maxSteps] - Step cap (default: AGENT_MAX_STEPS env / 20).
 * @param {number} [cfg.retry] - Error retries (default: AI_RETRY env).
 * @param {boolean} [cfg.thinking] - Thinking mode (default: AI_THINKING env, on —
 *   agents use full thinking for higher-quality output; tune AI_THINKING_LEVEL
 *   to control reasoning spend).
 * @param {string} [cfg.thinkingLevel] - reasoning_effort level (default: AI_THINKING_LEVEL env / "xhigh").
 * @param {number} [cfg.contextWindow] - Compaction window (default: AGENT_CONTEXT_WINDOW env).
 * @returns {Promise<Object>} { name, session, sendTurn, close }
 */
async function createAgentHandle({
  name,
  systemPrompt,
  tools,
  approve,
  cwd = process.cwd(),
  maxSteps,
  retry,
  thinking = envThinking(),
  thinkingLevel,
  contextWindow,
}) {
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    throw new Error("systemPrompt must be a non-empty string.");
  }
  const { core } = await loadEsm();
  const extraBody = thinkingExtraBody({ thinking, thinkingLevel });
  const tapsRef = createTapsRef();
  const { model } = await createChatModel({ extraBody, tapsRef });
  const agent = new core.Agent({
    name,
    model,
    systemPrompt,
    tools: tools && Object.keys(tools).length > 0 ? tools : undefined,
    maxSteps: maxSteps ?? agentMaxSteps(),
    temperature: envTemperature(),
    maxTokens: envMaxTokens(),
    instructions: false,
    ...(approve ? { approve } : {}),
  });
  const session = new core.Session({
    agent,
    contextWindow: contextWindow ?? envContextWindow(),
    retry: { maxRetries: retry ?? envRetry(), isRetryable: () => true },
  });
  const systemPreview = systemPrompt.trim().split("\n")[0].slice(0, 80);
  let turnNumber = 0;
  return {
    name,
    session,
    /**
     * Run one turn (user input string or ModelMessage array) and return the
     * accumulated result. Throws when the run ends in an error.
     * @param {string|Array<Object>} input - The turn's user input.
     * @param {{label?: string}} [opts] - Log label override.
     * @returns {Promise<Object>} The accumulated result (see consumeEvents).
     */
    async sendTurn(input, { label = name } = {}) {
      tapsRef.current = createTaps();
      turnNumber += 1;
      logLine(`[call-ai] CALL system="${systemPreview}" agent=${label} (turn)`);
      // Build logContext for streaming logs.
      const logContext = { type: "agent", agentName: name, turnNumber, label };
      // AbortController for the runaway-generation guard AND the idle
      // deadline: consumeEvents calls signal.abort() when the model produces
      // excessive text without tool calls, and after AI_CALL_DEADLINE_MS of
      // silence — both cancel the underlying fetch via session.send.
      const abortCtrl = new AbortController();
      let idleFired = false;
      const idleMs = envCallDeadlineMs();
      let result;
      try {
        result = await consumeEvents(
          session.send(input, { signal: abortCtrl.signal }),
          {
            label,
            tapsRef,
            logContext,
            signal: abortCtrl.signal,
            idleDeadlineMs: idleMs,
            onIdleExpire: () => {
              idleFired = true;
              abortCtrl.abort();
            },
          }
        );
      } catch (err) {
        if (idleFired) {
          throw new Error(
            `${label}: the agent turn made no progress for ${Math.round(idleMs / 60000)} min ` +
              `and was aborted (AI_CALL_DEADLINE_MS=${idleMs}). The endpoint is likely ` +
              `hung or the model container died — check .logs/ and re-run.`
          );
        }
        throw err;
      }
      logResultLine(result, label);
      if (result.result === "max_steps") {
        logLine(
          `  [call-ai] WARNING: ${label} hit its step cap without a final ` +
            `answer; the turn may be incomplete (raise maxSteps or narrow the ` +
            `task).`
        );
      }
      // Write full chat log for this turn.
      writeAgentTurnLog(name, turnNumber, {
        systemPrompt,
        input,
        result,
        toolCalls: result.toolCalls ?? [],
        label,
      });
      return result;
    },
    /** Release agent resources (MCP servers, background subagents). */
    async close() {
      await agent.close();
    },
  };
}

// ─── Endpoint sanity check ──────────────────────────────────────────────────

/**
 * Control-plane check that a (role) endpoint is up and serving the expected
 * model — the translation stage's tasks call this at startup instead of
 * failing mid-chapter on a dead/wrong endpoint.
 *
 * The task code deliberately does NOT start or stop containers: that is the
 * per-machine hooks' job (hooks/, gitignored). This check only verifies
 * reachability and — when the endpoint lists its models — that the expected
 * model id is among them, and fails fast with an actionable message when not.
 *
 * Note: local containers may all advertise the same alias (e.g. every local
 * container here reports model id "local"), in which case this check
 * validates that SOMETHING is serving that alias at the expected base URL;
 * which model is actually loaded is guaranteed by the hooks, not by this.
 *
 * @param {{baseUrl?: string, apiKey?: string, model?: string, label?: string, timeoutMs?: number}} cfg
 * @returns {Promise<void>}
 * @throws {Error} When the endpoint is unreachable, errors, or lists no
 *   model matching the expected id.
 */
async function assertModelServing({
  baseUrl,
  apiKey,
  model,
  label = "AI endpoint",
  timeoutMs = 30000,
} = {}) {
  const base = (baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const expected = model || process.env.AI_MODEL || "";
  const url = `${base}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let response;
  try {
    response = await undiciFetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
      dispatcher: noTimeoutAgent,
    });
  } catch (err) {
    throw new Error(
      `${label}: cannot reach the model endpoint at ${base} (${err.message}). ` +
        `Is the model server/container for this stage running? On local setups the ` +
        `per-machine pre-<task> hook (hooks/, see hooks/README.md) is responsible for ` +
        `starting it before the task runs.`
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(
      `${label}: model endpoint ${url} responded with HTTP ${response.status}.`
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label}: model endpoint ${url} returned a non-JSON body.`);
  }
  const ids = (payload?.data || []).map((m) => m?.id).filter(Boolean);
  // Audit the raw /v1/models answer in the run log: on local multi-model
  // setups every container advertises the same alias ("local"), so this is
  // the only trace of WHICH models the endpoint actually lists when a stage
  // runs (and of a hook that forgot to switch the container).
  logLine(
    `[endpoint] ${label}: ${base} /v1/models lists [${ids.join(", ") || "(none)"}] ` +
      `(expected model: "${expected || "(any)"}")`
  );
  if (!expected) return; // no expected model configured — reachability only
  if (!ids.includes(expected)) {
    throw new Error(
      `${label}: endpoint ${base} lists model(s) [${ids.join(", ") || "(none)"}] ` +
        `but this stage expects "${expected}". If several local containers share the ` +
        `same alias, the pre-<task> hook must start the container that serves ` +
        `"${expected}" (check hooks/ and hooks/README.md).`
    );
  }
  console.log(`[endpoint] ${label}: ${base} is up and lists model "${expected}".`);
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // The two workflow entry points.
  runOneShot,
  createAgentHandle,
  // Tool factories.
  createWikiTools,
  createGatedFsTools,
  createEpubTools,
  // Lower-level pieces (used by workflows/CLI/tests).
  createChatModel,
  thinkingExtraBody,
  toModelMessages,
  assertModelServing,
  // Env helpers (workflows read the same settings through these).
  envRetry,
  envMaxTokens,
  envTemperature,
  envContextWindow,
  envThinkingLevel,
  agentMaxSteps,
  // Run logging (workflows log alongside the harness run log).
  logLine,
};

// ─── Ad-hoc CLI ─────────────────────────────────────────────────────────────
// node harness.js --system "You are helpful" --text "Hello"
// node harness.js --system "You are helpful" --file ./img.png --name "img.png" --text "Describe this"

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const system = getArg("system");
  const text = getArg("text");
  const file = getArg("file");
  const name = getArg("name");

  const messages = [];
  if (file) {
    if (!name) {
      console.error("Error: --file requires --name");
      process.exit(1);
    }
    messages.push({ file, name });
  }
  if (text) messages.push({ text });
  if (messages.length === 0) {
    console.error(
      'Usage: node harness.js --system "system prompt" --text "text"\n' +
        '       node harness.js --system "system prompt" --file path --name "filename" --text "text"'
    );
    process.exit(1);
  }
  if (!system) {
    console.error("Error: --system is required");
    process.exit(1);
  }

  runOneShot({ systemPrompt: system, messages })
    .then((result) => {
      console.log(result);
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

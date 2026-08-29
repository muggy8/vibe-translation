/**
 * harness.js — OpenHarness (@openharness/core) wiring for the ai-client.
 *
 * This is the AI layer of the project. It builds the OpenAI-compatible
 * provider for the endpoint configured in .env and exposes the primitives
 * the glossary and jump-in-wiki workflows drive:
 *
 *   - runOneShot(...)        a single tool-less model call (acceptance
 *                            checks, classic-mode pipeline stages, the
 *                            ad-hoc CLI below) — replaces the old callAi()
 *   - createAgentHandle(...) a tool-using agent backed by an open-harness
 *                            Session (retry with backoff + context
 *                            compaction) for the agentic stages
 *   - createWikiTools()      Wikipedia research tools backed by research.js
 *   - createGatedFsTools()   filesystem tools whose writes are confined to
 *                            the volume folder (reads allowed, deletes denied)
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
const { Agent: UndiciAgent } = require("undici");
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
// Every call's diagnostic output is also written to a per-run log file under
// .logs/ (one file per process) so runs can be inspected after the fact.
// The log line prefix ("[call-ai]") is kept from the previous implementation
// so old and new run logs stay greppable side by side.
const logsDir = path.join(__dirname, ".logs");
let logStream = null;
let logFilePath = null;

/**
 * Get (and lazily create) the writable stream for the current run's log file.
 * @returns {import("fs").WriteStream} The log file stream.
 */
function getLogStream() {
  if (!logStream) {
    fs.mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    logFilePath = path.join(logsDir, `call-ai-${stamp}.log`);
    logStream = fs.createWriteStream(logFilePath, { flags: "a" });
    // An unhandled "error" event on the stream (e.g. disk full) would crash
    // the process; swallow it so logging can never break the actual AI call.
    logStream.on("error", (err) => {
      console.error(`[harness] log file error: ${err.message}`);
    });
    // Header is written directly (not via logLine) to avoid recursion.
    logStream.write(`=== call-ai run log started: ${new Date().toISOString()} ===\n`);
    logStream.write(
      `model=${process.env.OPENAI_MODEL || "gpt-4o-mini"} ` +
        `base_url=${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"} ` +
        `max_tokens=${process.env.MAX_TOKENS || "1024"}\n`
    );
    // Tell the user where this run's log is (console only, to avoid recursion).
    console.error(`[call-ai] logging to ${logFilePath}`);
  }
  return logStream;
}

/**
 * Log a line to both stderr and the current run's log file.
 * @param {string} message - The line to log.
 */
function logLine(message) {
  console.error(message);
  try {
    getLogStream().write(message + "\n");
  } catch {
    // Never let logging break the actual AI call.
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
 * - disables undici's request timeouts (local LLM prefills)
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
    const response = await fetch(input, { ...init, body, dispatcher: noTimeoutAgent });
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
 * Create the OpenAI-compatible chat model for the endpoint in .env.
 *
 * @param {{extraBody?: Object|null, tapsRef?: {current: Object}|null}} [options]
 * @returns {Promise<{model: Object, baseUrl: string, modelId: string}>}
 *   The chat model (AI SDK LanguageModel) plus the resolved endpoint info.
 */
async function createChatModel({ extraBody = null, tapsRef = null } = {}) {
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const apiKey = process.env.OPENAI_API_KEY;
  const modelId = process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set.\n  Set it in a .env file or as an environment variable."
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
 * @param {{thinking?: boolean, thinkingLevel?: string}} [cfg]
 * @returns {Object|null} The parameters to merge into the request body, or null.
 */
function thinkingExtraBody({ thinking = true, thinkingLevel } = {}) {
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
 * Thinking mode (THINKING env, default ON).
 */
function envThinking() {
  let performThinking = true;

  if (typeof process.env.THINKING === 'undefined' || process.env.THINKING === "") {
    return performThinking;
  }

  return process.env.THINKING === "true" || process.env.THINKING === "1";
}

/**
 * Thinking effort level (THINKING_LEVEL env, default "xhigh").
 * Sets the `reasoning_effort` parameter on the request body.
 * Valid values: "low", "medium", "xhigh" (model-dependent).
 */
function envThinkingLevel() {
  const level = process.env.THINKING_LEVEL;
  if (typeof level === "string" && level.trim() !== "") {
    return level.trim();
  }
  return "xhigh";
}

/** Maximum output tokens per call (MAX_TOKENS env, default 1024). */
function envMaxTokens() {
  return parseInt(process.env.MAX_TOKENS, 10) || 1024;
}

/** Sampling temperature (TEMPERATURE env, default 0.7). */
function envTemperature() {
  const t = parseFloat(process.env.TEMPERATURE);
  return Number.isNaN(t) ? 0.7 : t;
}

/**
 * Context window (tokens) at which session auto-compaction engages
 * (CONTEXT_WINDOW env, default 128000). Set it to your server's context
 * size so compaction kicks in before the server runs out of context.
 */
function envContextWindow() {
  const n = parseInt(process.env.CONTEXT_WINDOW, 10);
  return Number.isInteger(n) && n >= 4096 ? n : 128000;
}

/** Default step cap for tool-using agents (AGENT_MAX_STEPS env, default 20). */
function agentMaxSteps() {
  const n = parseInt(process.env.AGENT_MAX_STEPS, 10);
  return Number.isInteger(n) && n >= 1 ? n : 20;
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
 * @param {{label: string, tapsRef: {current: Object}}} opts - The log label
 *   (agent/stage name) and the taps ref (the per-attempt taps object).
 * @returns {Promise<Object>} The accumulated result:
 *   { text, reasoning, finishReason, usage, result, error, messages,
 *     startTime, firstTokenTime }. Throws the run's error when the stream
 *   ends with result "error".
 */
async function consumeEvents(events, { label, tapsRef }) {
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
  };
  let lastReported = 0;
  for await (const event of events) {
    switch (event.type) {
      case "text.delta":
        result.text += event.text;
        if (result.firstTokenTime === null) result.firstTokenTime = Date.now();
        if (result.text.length - lastReported >= 1000) {
          lastReported = result.text.length;
          logLine(`  …generated ${lastReported} chars so far`);
        }
        break;
      case "reasoning.delta":
        result.reasoning += event.text;
        if (result.firstTokenTime === null) result.firstTokenTime = Date.now();
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
        break;
      case "tool.error":
        logLine(
          `  …[agent] ${event.toolName} errored: ${String(event.error).slice(0, 160)}`
        );
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
 * @param {string} cfg.systemPrompt - The system prompt.
 * @param {Array<IMessage>} cfg.messages - IMessages ({ text } | { file, name }).
 * @param {number} [cfg.retry] - Extra attempts on empty/error (default: AI_RETRY).
 * @param {boolean} [cfg.thinking] - Thinking mode (default: THINKING env, on).
 * @param {string} [cfg.thinkingLevel] - reasoning_effort level (default: THINKING_LEVEL env / "xhigh").
 * @param {string} [cfg.label] - Log label (default: "one-shot").
 * @returns {Promise<string>} The model's content.
 */
async function runOneShot({
  systemPrompt,
  messages,
  retry,
  thinking = envThinking(),
  thinkingLevel,
  label = "one-shot",
}) {
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    throw new Error("systemPrompt must be a non-empty string.");
  }
  const retryCount =
    Number.isInteger(retry) && retry >= 0 ? retry : envRetry();
  const apiMessages = await toModelMessages(messages);
  const extraBody = thinkingExtraBody({ thinking, thinkingLevel });
  const temperature = envTemperature();
  const maxTokens = envMaxTokens();

  const systemPreview = systemPrompt.trim().split("\n")[0].slice(0, 80);
  logLine(
    `[call-ai] CALL system="${systemPreview}" messages=${messages.length} retry=${retryCount}`
  );

  const { core } = await loadEsm();
  let remaining = retryCount;
  for (;;) {
    const tapsRef = createTapsRef();
    tapsRef.current = createTaps();
    const { model } = await createChatModel({ extraBody, tapsRef });
    const agent = new core.Agent({
      name: label,
      model,
      systemPrompt,
      temperature,
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
    try {
      result = await consumeEvents(chat.send(apiMessages), { label, tapsRef });
    } catch (streamError) {
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
      });
      try {
        const completion = await generateText({
          model: fallbackModel,
          system: systemPrompt,
          messages: apiMessages,
          temperature,
          maxOutputTokens: maxTokens,
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
        throw streamError;
      }
    }

    logResultLine(result, label);

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
          ? "The token budget appears to have been spent on reasoning; try increasing MAX_TOKENS or the model's context limit. "
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
 * @param {boolean} [cfg.thinking] - Thinking mode (default: THINKING env, on —
 *   agents use full thinking for higher-quality output; tune THINKING_LEVEL
 *   to control reasoning spend).
 * @param {string} [cfg.thinkingLevel] - reasoning_effort level (default: THINKING_LEVEL env / "xhigh").
 * @param {number} [cfg.contextWindow] - Compaction window (default: CONTEXT_WINDOW env).
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
      logLine(`[call-ai] CALL system="${systemPreview}" agent=${label} (turn)`);
      const result = await consumeEvents(session.send(input), { label, tapsRef });
      logResultLine(result, label);
      if (result.result === "max_steps") {
        logLine(
          `  [call-ai] WARNING: ${label} hit its step cap without a final ` +
            `answer; the turn may be incomplete (raise maxSteps or narrow the ` +
            `task).`
        );
      }
      return result;
    },
    /** Release agent resources (MCP servers, background subagents). */
    async close() {
      await agent.close();
    },
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // The two workflow entry points.
  runOneShot,
  createAgentHandle,
  // Tool factories.
  createWikiTools,
  createGatedFsTools,
  // Lower-level pieces (used by workflows/CLI/tests).
  createChatModel,
  thinkingExtraBody,
  toModelMessages,
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

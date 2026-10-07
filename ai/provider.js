/**
 * The wire to an OpenAI-compatible server.
 *
 * Two local-LLM realities live here. (1) @openharness/core and @ai-sdk/openai ship
 * ESM-only builds while this project is CommonJS, so they are loaded lazily and
 * memoized. (2) All fetch timeouts are DISABLED, because a local server can prefill
 * a huge prompt for minutes — and the undici Agent must be handed to undici's OWN
 * fetch, never to Node's global one, which crosses undici builds and throws on some
 * Node versions (gotcha 19).
 *
 * Also here: the thinking-dialect mapping (chat_template_kwargs for Qwen-style
 * models, reasoning_effort for levels) and the message converter that turns
 * {file}/{name} parts into binary model parts.
 *
 * Part of the harness.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
require("../types"); // JSDoc type definitions
const { fileTypeFromBuffer } = require("file-type");
const { Agent: UndiciAgent, fetch: undiciFetch } = require("undici");

const { envThinkingLevel } = require("./env");

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


module.exports = {
  noTimeoutAgent,
  esm,
  loadEsm,
  thinkingExtraBody,
  createTapsRef,
  createTaps,
  tapSseStream,
  makeProviderFetch,
  createChatModel,
  toModelMessage,
  toModelMessages,
};

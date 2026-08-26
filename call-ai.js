/**
 * call-ai.js — Call an OpenAI-compatible endpoint with a system prompt
 * and a sequence of text / file messages.
 *
 * @example
 * const { callAi } = require("./call-ai");
 *
 * const result = await callAi(
 *   "You are a helpful assistant.",
 *   [
 *     { text: "What is in this file?" },
 *     { file: "./document.pdf", name: "document.pdf" },
 *   ],
 *   // optional
 *   {
 *     retry: 2,
 *     thinkingLevel: 'medium'
 *   }
 * );
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { fileTypeFromBuffer } = require("file-type");
const { Agent } = require("undici");
const OpenAI = require("openai");

// Local LLM servers (e.g. llama.cpp) can take many minutes to prefill a huge
// prompt and to generate a long answer. undici's default fetch timeouts
// (300 s for response headers and between body chunks) would abort such
// requests with an opaque "TypeError: fetch failed", so disable them.
const noTimeoutAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/**
 * A text message to send to the AI.
 * @typedef {Object} TextMessage
 * @property {string} text The message text to be sent.
 */

/**
 * A file message to send to the AI.
 * @typedef {Object} FileMessage
 * @property {string} file Path to the file on disk.
 * @property {string} name The file name to present to the AI.
 */

/**
 * A message that is either text or a file.
 * @typedef {TextMessage|FileMessage} IMessage
 */

/**
 * Convert a file to a base64 data URI.
 * Uses `file-type` to detect the MIME type from magic bytes.
 *
 * @param {string} filePath - Path to the file.
 * @returns {Promise<{uri: string, mimeType: string, ext: string}|null>}
 *   The data URI, MIME type and file extension, or null if the file type
 *   cannot be determined (e.g. plain text files).
 */
async function fileToDataURI(filePath) {
  const buffer = fs.readFileSync(filePath);
  const fileType = await fileTypeFromBuffer(buffer);
  if (!fileType) return null;
  return {
    uri: `data:${fileType.mime};base64,${buffer.toString("base64")}`,
    mimeType: fileType.mime,
    ext: fileType.ext,
  };
}

/**
 * Read a file as UTF-8 text.
 *
 * @param {string} filePath - Path to the file.
 * @returns {Promise<string>} The trimmed file contents.
 */
async function readTextFile(filePath) {
  const contents = await fs.promises.readFile(filePath, { encoding: "utf-8" });
  return contents.trim();
}

/**
 * Convert a single IMessage into an OpenAI chat-completion message.
 *
 * Text messages become plain user messages. File messages are detected
 * with `file-type` and sent as a base64 data URI (image / video / audio /
 * other binary). Files whose type cannot be determined are read as plain
 * text and embedded in the message.
 *
 * @param {IMessage} message - The message to convert.
 * @returns {Promise<{role: string, content: (string|Array<Object>)}>}
 *   The formatted API message.
 */
async function toApiMessage(message) {
  if (message.text !== undefined) {
    return { role: "user", content: message.text };
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

  const fileData = await fileToDataURI(filePath);

  if (fileData) {
    let filePart;
    if (fileData.mimeType.startsWith("image/")) {
      filePart = { type: "image_url", image_url: { url: fileData.uri } };
    } else if (fileData.mimeType.startsWith("video/")) {
      filePart = { type: "video_url", video_url: { url: fileData.uri } };
    } else if (fileData.mimeType.startsWith("audio/")) {
      filePart = {
        type: "input_audio",
        input_audio: { data: fileData.uri.split(",")[1], format: fileData.ext },
      };
    } else {
      filePart = { type: "file_url", file_url: { url: fileData.uri } };
    }

    return {
      role: "user",
      content: [filePart, { type: "text", text: `File: ${message.name}` }],
    };
  }

  // Unrecognized binary — treat as plain text
  const content = await readTextFile(filePath);
  return {
    role: "user",
    content: `File: ${message.name}\nContent:\n\n${content}`,
  };
}

/**
 * Create an OpenAI client configured for the endpoint in the environment.
 *
 * Local LLM servers (e.g. llama.cpp, Ollama, LM Studio) can take many minutes
 * to prefill a huge prompt and to generate a long answer. We disable the
 * client's request timeout and undici's header/body timeouts so such requests
 * are not aborted with an opaque error.
 *
 * @param {string} apiKey - The API key for authentication.
 * @param {string} baseUrl - The base URL of the OpenAI-compatible endpoint.
 * @returns {OpenAI} The configured client.
 */
function createClient(apiKey, baseUrl) {
  return new OpenAI({
    apiKey,
    baseURL: baseUrl,
    // Effectively no timeout: local LLMs can take a long time to prefill.
    timeout: 24 * 60 * 60 * 1000,
    // Disable undici's header/body timeouts for the underlying fetch calls.
    fetchOptions: { dispatcher: noTimeoutAgent },
  });
}

// Diagnostics: log the response shape (field names) once per process so a
// first run reveals whether the server separates reasoning from content.
let loggedStreamShape = false;
let loggedMessageShape = false;

// ─── Run logging ────────────────────────────────────────────────────────────
// Every call's diagnostic output is also written to a per-run log file under
// .logs/ (one file per process) so runs can be inspected after the fact.
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

/**
 * Call an OpenAI-compatible endpoint.
 *
 * @param {string} systemPrompt - The system prompt.
 * @param {IMessage[]} messages - The messages to send, in order.
 * @param {Object} [configs] - the configs for this call.
 * @param {number} [configs.retry] - the number of times to retry if the AI API fails to respond for some reason (default 0).
 * @param {boolean} [configs.thinking] - weather the model should think or not. (default: true)
 * @param {string} [configs.thinkingLevel] - how much the AI model should think (no default)
 * @returns {Promise<string>} Resolves to the entire output of the AI's API response.
 */
async function callAi(systemPrompt, messages, configs = {}) {
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const maxTokens = parseInt(process.env.MAX_TOKENS, 10) || 1024;
  const temperature = parseFloat(process.env.TEMPERATURE) || 0.7;

  const { retry = 0, thinking = true, thinkingLevel } = configs;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set.\n  Set it in a .env file or as an environment variable."
    );
  }

  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    throw new Error("systemPrompt must be a non-empty string.");
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array of IMessage objects.");
  }

  if (!Number.isInteger(retry) || retry < 0) {
    throw new Error("configs.retry must be a non-negative integer.");
  }

  const apiMessages = [{ role: "system", content: systemPrompt }];
  for (const message of messages) {
    apiMessages.push(await toApiMessage(message));
  }

  const client = createClient(apiKey, baseUrl);
  const params = {
    model,
    messages: apiMessages,
    max_tokens: maxTokens,
    temperature,
  };

  // Thinking mode: `thinking: false` asks the model to skip its reasoning
  // phase (Qwen3-style chat templates honor `thinking` / `enable_thinking`);
  // `thinkingLevel` sets how much it should think via the OpenAI-standard
  // `reasoning_effort` parameter (also supported by llama.cpp and Ollama).
  if (thinking === false) {
    params.extra_body = params.extra_body || {};
    params.extra_body.chat_template_kwargs = params.chat_template_kwargs = { thinking: false, enable_thinking: false };
  }
  if (thinkingLevel) {
    // for qwen 3.8 27b, the options are "xhigh", "medium", and "low" with the default being "xhigh"
    params.reasoning_effort = thinkingLevel;
  }

  // Log which call this is (identified by the system prompt's first line).
  const systemFirstLine = systemPrompt.trim().split("\n")[0].slice(0, 80);
  logLine(`[call-ai] CALL system="${systemFirstLine}" messages=${messages.length} retry=${retry}`);

  return performAiCall(client, params, configs);
}

/**
 * Perform the AI request, retrying recursively up to `configs.retry` extra
 * times if it fails. The expensive setup (message conversion, client
 * creation) is done once by the caller, so retries only re-issue the request.
 *
 * @param {OpenAI} client - The configured OpenAI client.
 * @param {Object} params - The chat-completion parameters (without `stream`).
 * @param {Object} configs - The call configs (only `retry` is used here).
 * @param {number} [configs.retry] - the number of times to retry if the AI API fails to respond for some reason (default 0).
 * @returns {Promise<string>} The model's content.
 */
async function performAiCall(client, params, configs) {
  try {
    // Prefer streaming: it avoids a total-request timeout on slow local LLMs
    // (the timeout only covers the prefill / response headers) and lets us
    // report progress. If the endpoint doesn't actually stream (some servers
    // return a single JSON body even when `stream: true` is requested) or the
    // stream fails, fall back to a non-streaming call.
    let startTime = Date.now();
    let firstTokenTime = null;
    let content = "";
    let reasoningContent = "";
    let finishReason = null;
    let usage = null;
    let lastReported = 0;
    let streamFailed = false;

    try {
      const stream = await client.chat.completions.create({
        ...params,
        stream: true,
        // Ask the server to include token usage in the final stream chunk
        // (OpenAI-standard option; honored by llama.cpp, vLLM, Ollama, ...).
        stream_options: { include_usage: true },
      });
      for await (const chunk of stream) {
        // Some servers report token usage on a final chunk that has no choices.
        if (chunk.usage) {
          usage = chunk.usage;
        }
        const choice = chunk.choices?.[0];
        if (choice && !loggedStreamShape) {
          loggedStreamShape = true;
          logLine(
            `  [call-ai] stream chunk keys: ${Object.keys(chunk).join(", ")}` +
              ` | choice keys: ${Object.keys(choice).join(", ")}` +
              (choice.delta ? ` | delta keys: ${Object.keys(choice.delta).join(", ")}` : "")
          );
        }
        if (!choice) continue;
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.content === "string") {
          if (delta.content !== "" && firstTokenTime === null) {
            firstTokenTime = Date.now();
          }
          content += delta.content;
          if (content.length - lastReported >= 1000) {
            lastReported = content.length;
            logLine(`  …generated ${lastReported} chars so far`);
          }
        }
        // Thinking models may emit reasoning in `reasoning_content` (Qwen/DeepSeek)
        // or `reasoning`; capture whichever the server uses so we can see it.
        const reasoningDelta =
          typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta.reasoning === "string"
              ? delta.reasoning
              : "";
        if (reasoningDelta) {
          if (firstTokenTime === null) {
            firstTokenTime = Date.now();
          }
          reasoningContent += reasoningDelta;
        }
      }
    } catch (err) {
      streamFailed = true;
      logLine(`  streaming failed (${err.message}); retrying without streaming...`);
    }

    if (!content || streamFailed) {
      // The stats below describe the attempt that produced the final content.
      startTime = Date.now();
      firstTokenTime = null;
      const completion = await client.chat.completions.create(params);
      const choice = completion.choices?.[0];
      const message = choice?.message;
      content = message?.content ?? "";
      if (message && !loggedMessageShape) {
        loggedMessageShape = true;
        logLine(`  [call-ai] non-stream message keys: ${Object.keys(message).join(", ")}`);
      }
      const reasoningField =
        typeof message?.reasoning_content === "string"
          ? message.reasoning_content
          : typeof message?.reasoning === "string"
            ? message.reasoning
            : "";
      if (reasoningField) {
        reasoningContent = reasoningField;
      }
      finishReason = choice?.finish_reason ?? finishReason;
      usage = completion.usage ?? usage;
    }

    // Diagnostic summary: pinpoints empty/truncated responses, e.g. a thinking
    // model that spends its budget on reasoning and is cut off (finish_reason
    // "length") before emitting any content.
    const usageText = usage
      ? `usage: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`
      : "usage: n/a";
    // Performance statistics: total wall time plus, when the first token was
    // observed (streaming), the time to first token (TTFT) and derived
    // throughputs. TTFT approximates the server's prompt prefill time, so
    // prompt_tokens / TTFT ≈ prefill speed; the remaining wall time is
    // generation, so completion_tokens / genTime ≈ generation speed. Rates are
    // only meaningful when the server reports usage.
    const totalMs = Date.now() - startTime;
    const perf = [`time=${(totalMs / 1000).toFixed(1)}s`];
    if (firstTokenTime !== null) {
      const prefillMs = firstTokenTime - startTime;
      const genMs = totalMs - prefillMs;
      perf.push(`ttft=${(prefillMs / 1000).toFixed(1)}s`);
      if (prefillMs > 0 && usage?.prompt_tokens) {
        perf.push(`prefill=${(usage.prompt_tokens / (prefillMs / 1000)).toFixed(1)} tok/s`);
      }
      if (genMs > 0 && usage?.completion_tokens) {
        perf.push(`gen=${(usage.completion_tokens / (genMs / 1000)).toFixed(1)} tok/s`);
      }
    }
    logLine(
      `  [call-ai] RESULT finish_reason=${finishReason ?? "n/a"} ` +
        `content=${content.length} chars reasoning=${reasoningContent.length} chars ${usageText} ` +
        perf.join(" ") +
        (content.length === 0 ? "  <-- NO CONTENT (empty response)" : "")
    );

    if (!content && configs.retry > 0) {
      return performAiCall(client, params, { ...configs, retry: configs.retry - 1 });
    }

    return content || "(no content in response)";
  } catch (err) {
    if (configs.retry > 0) {
      logLine(
        `  [call-ai] attempt failed (${err.message}); retrying (${configs.retry - 1} left)...`
      );
      return performAiCall(client, params, { ...configs, retry: configs.retry - 1 });
    }
    throw err;
  }
}

// ─── Export for use as a module ─────────────────────────────────────────────

module.exports = { callAi };

// ─── CLI fallback (run directly for quick testing) ──────────────────────────
//
// Usage:
//   node call-ai.js --system "You are helpful" --text "Hello"
//   node call-ai.js --system "You are helpful" --file ./img.png --name "img.png" --text "Describe this"

if (require.main === module) {
  const args = process.argv.slice(2);
  let systemPrompt = null;
  let pendingFile = null;
  const messages = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--system":
        systemPrompt = args[++i];
        break;
      case "--text":
        messages.push({ text: args[++i] });
        break;
      case "--file":
        pendingFile = args[++i];
        break;
      case "--name":
        if (pendingFile === null) {
          console.error("--name must follow a --file argument.");
          process.exit(1);
        }
        messages.push({ file: pendingFile, name: args[++i] });
        pendingFile = null;
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  if (systemPrompt === null || messages.length === 0) {
    console.error(
      "Usage: node call-ai.js --system <prompt> (--text <message> | --file <path> --name <name>) ..."
    );
    process.exit(1);
  }

  callAi(systemPrompt, messages)
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}
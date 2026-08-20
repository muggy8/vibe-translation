/**
 * call-ai.js — Call an OpenAI-compatible endpoint with a system prompt
 * and a sequence of text / file messages.
 *
 * @example
 * const { callAi } = require("./call-ai");
 *
 * const result = await callAi(
 *   "You are a helpful assistant.",
 *   { text: "What is in this file?" },
 *   { file: "./document.pdf", name: "document.pdf" }
 * );
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { fileTypeFromBuffer } = require("file-type");
const { Agent } = require("undici");

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
 * Call an OpenAI-compatible endpoint.
 *
 * @param {string} systemPrompt - The system prompt.
 * @param {...IMessage} messages - The messages to send, in order.
 * @returns {Promise<string>} Resolves to the entire output of the AI's API response.
 */
async function callAi(systemPrompt, ...messages) {
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const maxTokens = parseInt(process.env.MAX_TOKENS, 10) || 1024;
  const temperature = parseFloat(process.env.TEMPERATURE) || 0.7;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set.\n  Set it in a .env file or as an environment variable."
    );
  }

  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    throw new Error("systemPrompt must be a non-empty string.");
  }

  const apiMessages = [{ role: "system", content: systemPrompt }];
  for (const message of messages) {
    apiMessages.push(await toApiMessage(message));
  }

  const body = {
    model,
    messages: apiMessages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    dispatcher: noTimeoutAgent,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `API request failed with status ${response.status}:\n  ${errorBody}`
    );
  }

  // Parse the SSE stream and accumulate the generated content. Streaming
  // also means the response headers arrive immediately, so long prefills
  // and generations no longer trip fetch's header/body timeouts.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let lastReported = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep the (possibly incomplete) last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === "string") {
          content += delta;
          if (content.length - lastReported >= 1000) {
            lastReported = content.length;
            console.error(`  …generated ${lastReported} tokens so far`);
          }
        }
      } catch {
        // Ignore malformed or keep-alive lines.
      }
    }
  }

  return content || "(no content in response)";
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

  callAi(systemPrompt, ...messages)
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}
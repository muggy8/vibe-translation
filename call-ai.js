/**
 * call-ai.js — A single function that calls an OpenAI-compatible endpoint.
 *
 * Uses the official `openai` SDK, which works with any OpenAI-compatible
 * endpoint (OpenAI, Ollama, LM Studio, vLLM, etc.) via the `baseURL` option.
 * The endpoint streams its response one token at a time (SSE); this module
 * consumes the stream and concatenates the fragments into a single coherent
 * string before resolving.
 *
 * @param {string} systemPrompt - The system prompt to send.
 * @param {string} filePath     - Path to a file (text, image, video, PDF, etc.).
 * @param {string} userInput    - The user's message/input.
 * @returns {Promise<string>}   - Resolves with the full API response text.
 *
 * @example
 * const result = await callAI(
 *   "You are a helpful assistant.",
 *   "./document.pdf",
 *   "Summarize this document."
 * );
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { fileTypeFromBuffer } = require("file-type");
const OpenAI = require("openai");

/**
 * Convert a file to a base64 data URI.
 * Uses `file-type` to detect the MIME type from magic bytes.
 * Returns null if the file type cannot be determined.
 */
async function fileToDataURI(filePath) {
  const buffer = fs.readFileSync(path.resolve(filePath));
  const fileType = await fileTypeFromBuffer(buffer);
  if (!fileType) return null;
  return {
    uri: `data:${fileType.mime};base64,${buffer.toString("base64")}`,
    mimeType: fileType.mime,
  };
}

/**
 * Read a text file and return its content as a string.
 */
async function readTextFile(filePath) {
  const contents = await fs.promises.readFile(path.resolve(filePath), { encoding: "utf-8" });
  return contents.trim();
}

/**
 * Build the OpenAI client from environment variables.
 */
function createClient() {
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set.\n" +
        "  Set it in a .env file or as an environment variable."
    );
  }

  return new OpenAI({ baseURL: baseUrl, apiKey });
}

/**
 * Main function: call an OpenAI-compatible endpoint.
 *
 * For text files, the content is sent as text.
 * For binary files (images, video, audio, PDF, etc.), the file is
 * base64-encoded and sent as a data URI in a multimodal message part.
 *
 * The request is made with `stream: true`; the streamed chunks are
 * concatenated into a single coherent string before resolving.
 */
async function callAI(systemPrompt, filePath, userInput) {
  const openai = createClient();
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const maxTokens = parseInt(process.env.MAX_TOKENS, 10) || 1024;
  const temperature = parseFloat(process.env.TEMPERATURE) || 0.7;

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  const messages = [{ role: "system", content: systemPrompt }];

  const fileData = await fileToDataURI(resolvedPath);

  if (fileData) {
    // Binary / recognized file — send as base64 data URI
    let contentParts;
    if (fileData.mimeType.startsWith("image/")) {
      contentParts = [
        { type: "image_url", image_url: { url: fileData.uri } },
        { type: "text", text: userInput },
      ];
    } else if (fileData.mimeType.startsWith("video/")) {
      contentParts = [
        { type: "video_url", video_url: { url: fileData.uri } },
        { type: "text", text: userInput },
      ];
    } else if (fileData.mimeType.startsWith("audio/")) {
      contentParts = [
        { type: "input_audio", input_audio: { data: fileData.uri.split(",")[1], format: "wav" } },
        { type: "text", text: userInput },
      ];
    } else {
      // Unrecognized binary (PDF, etc.) — send as base64 attachment
      contentParts = [
        { type: "file_url", file_url: { url: fileData.uri } },
        { type: "text", text: userInput },
      ];
    }
    messages.push({ role: "user", content: contentParts });
  } else {
    // Unrecognized / text file — read as plain text
    const content = await readTextFile(resolvedPath);
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `File: \`${path.basename(filePath)}\`\nContent:\n\n${content}`},
        { type: "text", text: userInput },
      ],
    });
  }

  messages.push({
    role: "system",
    content: `Reminder:\n\n${systemPrompt}`
  })

  const stream = await openai.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
  });

  // Consume the SSE stream and concatenate the token fragments.
  let content = "";
  for await (const chunk of stream) {
    content += chunk.choices?.[0]?.delta?.content ?? "";
  }

  return content || "(no content in response)";
}

// ─── Export for use as a module ─────────────────────────────────────────────

module.exports = { callAI };

// ─── CLI fallback (run directly for quick testing) ──────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error("Usage: node call-ai.js <system-prompt> <file-path> <user-input>");
    process.exit(1);
  }
  callAI(args[0], args[1], args.slice(2).join(" "))
    .then((result) => console.log(result))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

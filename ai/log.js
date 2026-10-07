/**
 * Per-run logging: one directory per process under .logs/, holding the greppable
 * summary log and the full chat histories (one-shot prompts and responses, agent
 * turns with their tool calls AND their results).
 *
 * The .stream.md files written while the model is still generating are the key
 * diagnostic when a call stalls or hangs — they show what was produced even if the
 * call never completes. A tool result that is not recorded makes "the search found
 * nothing" and "the search never ran" look identical in the log (gotcha 61).
 *
 * Part of the harness.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
require("../types"); // JSDoc type definitions
const projectRoot = path.resolve(__dirname, "..");

const { envMaxTokens } = require("./env");

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
const logsDir = path.join(projectRoot, ".logs");

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
        `max_tokens=${envMaxTokens()}\n`
    );
    console.error(`[call-ai] logging to ${runDir}`);
  }
  return logStream;
}


/**
 * The directory holding the CURRENT process's run logs (`<.logs>/<timestamp>/`).
 * Created on first use, because the context-offload store is written inside it
 * (design §4.3): the text a turn moved out of its own window belongs next to the
 * transcript of the turn that moved it, so one failed turn can be read as one
 * folder.
 * @returns {string} The run directory, or null when logging could not be set up.
 */
function currentRunDir() {
  try {
    getLogStream();
  } catch (err) {
    console.error(`[harness] could not open the run log directory: ${err.message}`);
  }
  return runDir;
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
 * Escape text for inline code (prevents backtick issues). Non-strings are
 * serialized: a tool input or a tool result is an object, and String() on one
 * answers "[object Object]" — which made every logged tool call unreadable.
 * @param {unknown} text - The text (or value) to escape.
 * @returns {string} The escaped text.
 */
function escapeInline(text) {
  if (text === null || text === undefined) return "";
  let s;
  if (typeof text === "string") {
    s = text;
  } else {
    try {
      s = JSON.stringify(text);
    } catch {
      s = String(text);
    }
    if (s === undefined) s = String(text);
  }
  return s.replace(/`/g, "\u200B`").slice(0, 500);
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
 * @param {number} [opts.chunks] - How many chunks this turn ran as (a context-managed
 *   turn is one turn of several chunks). Falls back to `result.chunks`.
 * @param {Array<Object>} [opts.offloads] - The offloads this turn wrote to disk, each
 *   `{id, offloadedCount, tokensBefore, tokensAfter, reason, file}`. Falls back to
 *   `result.offloads`.
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

    // A context-managed turn is ONE turn made of several chunks, and the chunks are
    // where the offloads happened. Without these lines the log describes a turn that
    // quietly moved most of what it read onto disk (design §4.10).
    const chunks = opts.chunks ?? result.chunks ?? 1;
    if (chunks > 1) content += `# Chunks: ${chunks}\n`;
    const offloads = opts.offloads ?? result.offloads ?? [];
    if (offloads.length > 0) {
      content += `# Offloads: ${offloads.length}\n`;
      for (const off of offloads) {
        content += `#   ${off.id}: ${off.offloadedCount} read result(s) `
          + `${off.tokensBefore} -> ${off.tokensAfter} tokens (${off.reason}) -> ${off.file}\n`;
      }
    }
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


module.exports = {
  logsDir,
  logStream,
  logFilePath,
  runDir,
  getLogStream,
  currentRunDir,
  logLine,
  escapeCodeBlock,
  escapeInline,
  CODE_BLOCK,
  writeOneShotLog,
  writeAgentTurnLog,
};

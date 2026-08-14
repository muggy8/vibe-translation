#!/usr/bin/env node

/**
 * call-ai.js — Call an OpenAI-compatible endpoint with a system prompt + user input.
 *
 * Usage:
 *   node call-ai.js "Your question or instruction here"
 *   node call-ai.js --prompt custom-system.txt "Your question"
 *   node call-ai.js --file input.txt              # reads input from a file
 *   echo "Your question" | node call-ai.js        # reads input from stdin
 *
 * Environment variables (via .env file or shell):
 *   OPENAI_BASE_URL   — Base URL of the API (default: https://api.openai.com/v1)
 *   OPENAI_API_KEY    — Your API key
 *   OPENAI_MODEL      — Model name (default: gpt-4o-mini)
 *   MAX_TOKENS        — Max response tokens (default: 1024)
 *   TEMPERATURE       — Sampling temperature (default: 0.7)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");

// ─── Helpers ────────────────────────────────────────────────────────────────

function exitWithError(message) {
  console.error(`\x1b[31mError:\x1b[0m ${message}`);
  process.exit(1);
}

function printUsage() {
  console.log(`
\x1b[36mUsage:\x1b[0m
  node call-ai.js "Your question or instruction here"
  node call-ai.js --prompt <system-prompt-file> "Your question"
  node call-ai.js --file <input-file>
  echo "Your question" | node call-ai.js

\x1b[36mOptions:\x1b[0m
  --prompt <file>   Path to a file containing the system prompt (default: system-prompt.txt)
  --file <file>     Read user input from a file instead of CLI argument
  --help            Show this help message

\x1b[36mEnvironment:\x1b[0m
  OPENAI_BASE_URL   Base URL of the OpenAI-compatible endpoint
  OPENAI_API_KEY    Your API key
  OPENAI_MODEL      Model to use (default: gpt-4o-mini)
  MAX_TOKENS        Max tokens in response (default: 1024)
  TEMPERATURE       Temperature 0.0–2.0 (default: 0.7)
`.trim());
}

// ─── Parse arguments ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    userInput: null,
    systemPromptFile: path.join(__dirname, "system-prompt.txt"),
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    switch (argv[i]) {
      case "--help":
        args.help = true;
        i++;
        break;
      case "--prompt":
        i++;
        args.systemPromptFile = argv[i];
        i++;
        break;
      case "--file":
        i++;
        args.userInput = fs.readFileSync(argv[i], "utf-8").trim();
        i++;
        break;
      default:
        if (!args.userInput) {
          args.userInput = argv[i];
        }
        i++;
        break;
    }
  }

  return args;
}

// ─── Read system prompt ─────────────────────────────────────────────────────

function readSystemPrompt(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch (err) {
    exitWithError(`Could not read system prompt file: ${filePath}\n  ${err.message}`);
  }
}

// ─── Read stdin ─────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", () => resolve(""));
  });
}

// ─── API call ───────────────────────────────────────────────────────────────

async function callAI(systemPrompt, userInput) {
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const maxTokens = parseInt(process.env.MAX_TOKENS, 10) || 1024;
  const temperature = parseFloat(process.env.TEMPERATURE) || 0.7;

  if (!apiKey) {
    exitWithError(
      "OPENAI_API_KEY is not set.\n" +
        "  Set it in a .env file or as an environment variable.\n" +
        "  See .env.example for reference."
    );
  }

  const url = `${baseUrl}/chat/completions`;

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInput },
    ],
    max_tokens: maxTokens,
    temperature,
  };

  console.log(`\x1b[33m→\x1b[0m Calling ${model} at ${baseUrl} ...`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    exitWithError(
      `API request failed with status ${response.status}:\n  ${errorBody}`
    );
  }

  const data = await response.json();

  // Extract and print the assistant's reply
  const content =
    data.choices?.[0]?.message?.content || "(no content in response)";
  console.log(`\n\x1b[32m←\x1b[0m ${content}\n`);

  // Optionally print usage stats
  const usage = data.usage;
  if (usage) {
    console.log(
      `\x1b[90m[Tokens — prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}]\x1b[0m`
    );
  }

  return content;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv.slice(2);

  // If no CLI arguments, try reading from stdin
  if (rawArgs.length === 0) {
    const stdinInput = await readStdin();
    if (!stdinInput) {
      printUsage();
      process.exit(0);
    }
    rawArgs.push(stdinInput);
  }

  const args = parseArgs(rawArgs);

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!args.userInput) {
    exitWithError("No user input provided. Pass a message or use --file <path>.");
  }

  const systemPrompt = readSystemPrompt(args.systemPromptFile);
  await callAI(systemPrompt, args.userInput);
}

main().catch((err) => {
  exitWithError(err.message);
});

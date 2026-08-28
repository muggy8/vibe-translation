/**
 * utils/prompt.js - Prompt and verdict utility functions.
 *
 * @example
 * const { transformUserPrompt, isPassingVerdict } = require("../utils/prompt");
 */

const fs = require("fs");
const path = require("path");

function transformUserPrompt(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string" || !value)
      throw new Error("Missing value for placeholder: {{" + key + "}}");
    result = result.split("{{" + key + "}}").join(value);
  }
  const leftover = result.match(/\{\{[A-Z0-9_]+\}\}/);
  if (leftover)
    throw new Error("Unfilled placeholder left in user prompt: " + leftover[0]);
  return result;
}

function isPassingVerdict(output) {
  if (typeof output !== "string") return false;
  const text = output.trim().toUpperCase();
  if (text === "PASS") return true;
  if (text === "FAIL") return false;
  const hasPass = /\bPASS\b/.test(text);
  const hasFail = /\bFAIL(?:ED|URES?)?\b/.test(text);
  const negated = /\bNOT\s+PASS\b/.test(text);
  return hasPass && !hasFail && !negated;
}

function validatorMaxStepsFor(sourceSizeBytes) {
  const chunks = Math.max(1, Math.ceil((sourceSizeBytes || 0) / 32768));
  return Math.max(40, chunks * 2 + 24);
}

async function writePromptDump(task, installmentNumber, mode, sections) {
  const clientDir = path.resolve(__dirname, "..");
  const dir = path.join(clientDir, ".dry-run");
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${task}-${installmentNumber}.md`);
  const body = `# ${task} - volume ${installmentNumber} prompt dump (--dry-run)\n\nMode: ${mode}\n\n` + sections.map((s) => `## ${s.title}\n\n${s.prompt}\n`).join("");
  await fs.promises.writeFile(file, body, "utf-8");
  return file;
}

module.exports = { transformUserPrompt, isPassingVerdict, validatorMaxStepsFor, writePromptDump };

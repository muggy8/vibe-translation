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

function splitJumpInWikiGenerationOutput(output) {
  if (!output) return ["", ""];
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  const wikiMarkerRe = /^----\s+jump-in-wiki-?\d*\.md\s+----$/;
  const sharedMarkerRe = /^----\s+jump-in-wiki-shared\.md\s+----$/;
  const endMarkerRe = /^----\s+end\s+----$/;
  let wikiMarkerIdx = -1, sharedMarkerIdx = -1, endIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (wikiMarkerIdx === -1 && wikiMarkerRe.test(trimmed)) wikiMarkerIdx = i;
    else if (sharedMarkerIdx === -1 && sharedMarkerRe.test(trimmed)) sharedMarkerIdx = i;
    if (endMarkerRe.test(trimmed)) endIdx = i;
  }
  const wikiStart = wikiMarkerIdx !== -1 ? wikiMarkerIdx + 1 : 0;
  const sharedStart = sharedMarkerIdx !== -1 ? sharedMarkerIdx + 1 : lines.length;
  const sharedEnd = endIdx !== -1 ? endIdx : lines.length;
  const wikiEnd = sharedMarkerIdx !== -1 ? sharedMarkerIdx : sharedEnd;
  const wikiRaw = lines.slice(wikiStart, wikiEnd).join("\n");
  const sharedRaw = lines.slice(sharedStart, sharedEnd).join("\n");
  const trimBlank = (s) => s.replace(/^\n+|\n+$/g, "");
  return [trimBlank(wikiRaw), trimBlank(sharedRaw)];
}

module.exports = { transformUserPrompt, isPassingVerdict, validatorMaxStepsFor, writePromptDump, splitJumpInWikiGenerationOutput };

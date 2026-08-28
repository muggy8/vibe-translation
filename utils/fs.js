/**
 * utils/fs.js — Generalized utility functions shared across the ai-client modules.
 *
 * This module centralizes three categories of helpers:
 *
 * 1. **Filesystem** — `fileExists`, `assertWrote` (generalized to accept
 *    `string | string[]`).
 * 2. **JSON / manifest** — `extractJsonObject`, `installmentNumberFromDir`.
 * 3. **Prompt / verdict helpers** — `transformUserPrompt`, `isPassingVerdict`,
 *    `validatorMaxStepsFor`, `writePromptDump`, `splitJumpInWikiGenerationOutput`.
 *
 * Task-specific prompt builders (e.g. `buildGlossaryAuthorTurnPrompt`) stay
 * in their respective task modules because they are tightly coupled to the
 * prompt structure of that task.
 *
 * @example
 * const { fileExists, assertWrote, transformUserPrompt } = require("../utils/fs");
 */

const fs = require("fs");
const path = require("path");

// ─── Filesystem helpers ───────────────────────────────────────────────────────

/**
 * Check whether a file exists.
 *
 * @param {string} filePath - The path to check.
 * @returns {Promise<boolean>} True if the file exists, false otherwise.
 */
async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail loudly if an agent-mode stage left its output file(s) missing or empty.
 *
 * @param {string | string[]} filePaths - Expected output file path or array of paths.
 * @param {string} who - Who was supposed to write it (for the error message).
 * @returns {Promise<void>}
 */
async function assertWrote(filePaths, who) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  for (const filePath of paths) {
    const content = await fs.promises.readFile(filePath, "utf-8").catch(() => null);
    if (!content || !content.trim()) {
      throw new Error(
        `${who} did not produce ${filePath}. Check the run log in .logs/ for the agent transcript.`
      );
    }
  }
}

// ─── JSON / manifest helpers ──────────────────────────────────────────────────

/**
 * Extract a JSON object from a string that may wrap it in markdown code fences
 * or surrounding prose. This is the salvage path used when an AI model returns
 * JSON in its chat reply instead of writing it to disk.
 *
 * @param {string} text - The raw text to extract from.
 * @returns {object} The parsed outermost JSON object.
 * @throws {Error} When no parseable JSON object can be found.
 */
function extractJsonObject(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("No text to extract a JSON object from.");
  }
  let t = text.trim();
  // Strip a markdown code fence if the model wrapped the JSON in one.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // Take the span from the first '{' to the last '}'.
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in the text.");
  }
  const candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(`Could not parse a JSON object from the text: ${err.message}`);
  }
}

/**
 * Derive a zero-padded installment number from the trailing "(N)" of a folder
 * name. E.g. "俺を好きなのはお前だけかよ(1)" → "01".
 *
 * @param {string} dir - A folder path (only its base name is used).
 * @returns {string} The zero-padded installment number.
 */
function installmentNumberFromDir(dir) {
  const match = path.basename(dir).match(/\((\d+)\)\s*$/);
  if (!match) {
    throw new Error(
      `Cannot derive the installment number from folder name: ${path.basename(dir)}`
    );
  }
  return match[1].padStart(2, "0");
}

// ─── Prompt helpers ───────────────────────────────────────────────────────────

/**
 * Fill in the {{PLACEHOLDER}} values in a user prompt template.
 *
 * Strict: throws on a missing value or any leftover placeholder.
 *
 * @param {string} template - The raw template text.
 * @param {Record<string, string>} values - The placeholder values.
 * @returns {string} The transformed prompt.
 */
function transformUserPrompt(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string" || !value) {
      throw new Error(`Missing value for placeholder: {{${key}}}`);
    }
    result = result.split(`{{${key}}}`).join(value);
  }
  const leftover = result.match(/\{\{[A-Z0-9_]+\}\}/);
  if (leftover) {
    throw new Error(`Unfilled placeholder left in user prompt: ${leftover[0]}`);
  }
  return result;
}

/**
 * Decide whether an acceptance-check response is a passing verdict.
 *
 * The acceptance prompts ask the model to answer exactly "PASS" or "FAIL",
 * but model output is non-deterministic, so a plain `.includes("PASS")`
 * check would false-positive on prose such as "does not pass". We accept
 * only an unambiguous pass: the word PASS must appear, and the response
 * must contain neither an explicit FAIL nor a negated verdict.
 *
 * @param {string} output - The raw acceptance-check response.
 * @returns {boolean} True only for an unambiguous passing verdict.
 */
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

/**
 * Step cap for validator agents, scaled to the volume source size: every
 * ~32KB of source costs at least one read step, and validators also spend
 * steps on grep passes and the report write. The fixed cap of 40 ran out on
 * the 521KB volume-01 source (observed live: the validator hit the cap
 * before writing its report).
 *
 * @param {number} sourceSizeBytes - The volume source file size in bytes.
 * @returns {number} The validator agent's maxSteps (at least 40).
 */
function validatorMaxStepsFor(sourceSizeBytes) {
  const chunks = Math.max(1, Math.ceil((sourceSizeBytes || 0) / 32768));
  return Math.max(40, chunks * 2 + 24);
}

/**
 * --dry-run support: write the prompts a task would send for a volume to a
 * .dry-run/ file so they can be inspected without any AI call (terminal
 * output is unreliable while long jobs hold the shell; the file is not).
 *
 * @param {string} task - The task name ("glossary" | "jump-in-wiki").
 * @param {string} installmentNumber - The zero-padded volume number.
 * @param {string} mode - The workflow mode ("agent" | "classic").
 * @param {Array<{title: string, prompt: string}>} sections - The prompts.
 * @returns {Promise<string>} The dump file path.
 */
async function writePromptDump(task, installmentNumber, mode, sections) {
  const clientDir = path.resolve(__dirname, "..");
  const dir = path.join(clientDir, ".dry-run");
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${task}-${installmentNumber}.md`);
  const body =
    `# ${task} — volume ${installmentNumber} prompt dump (--dry-run)\n\n` +
    `Mode: ${mode}\n\n` +
    sections.map((s) => `## ${s.title}\n\n${s.prompt}\n`).join("\n");
  await fs.promises.writeFile(file, body, "utf-8");
  return file;
}

/**
 * Split a classic-mode generation output (marker-formatted) into the two
 * expected file contents: [wiki.md, shared-wiki.md].
 *
 * Degrades leniently: if the "---- end ----" marker is missing the function
 * returns whatever it parsed; if the shared marker is missing the second
 * element is an empty string (the wiki content is still preserved).
 *
 * @param {string} output - The raw model output with classic-mode markers.
 * @returns {[string, string]} [wiki content, shared wiki content].
 */
function splitJumpInWikiGenerationOutput(output) {
  if (!output) return ["", ""];
  // Normalise line endings and split into lines
  const lines = output.replace(/\r\n/g, "\n").split("\n");

  // Find the two content sections by their marker lines.
  // Markers look like: "---- jump-in-wiki-NN.md ----" or "---- jump-in-wiki-shared.md ----"
  const wikiMarkerRe   = /^----\s+jump-in-wiki-?\d*\.md\s+----$/;
  const sharedMarkerRe = /^----\s+jump-in-wiki-shared\.md\s+----$/;
  const endMarkerRe    = /^----\s+end\s+----$/;

  let wikiMarkerIdx   = -1;
  let sharedMarkerIdx = -1;
  let endIdx          = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (wikiMarkerIdx === -1 && wikiMarkerRe.test(trimmed)) {
      wikiMarkerIdx = i;
    } else if (sharedMarkerIdx === -1 && sharedMarkerRe.test(trimmed)) {
      sharedMarkerIdx = i;
    }
    if (endMarkerRe.test(trimmed)) {
      endIdx = i;
    }
  }

  // Content starts one line after each marker
  const wikiStart   = wikiMarkerIdx   !== -1 ? wikiMarkerIdx   + 1 : 0;
  const sharedStart = sharedMarkerIdx !== -1 ? sharedMarkerIdx + 1 : lines.length;
  // Shared content ends at the end marker or at the end of the file
  const sharedEnd   = endIdx !== -1 ? endIdx : lines.length;
  // Wiki content ends where the shared section begins (or where the shared
  // section would end if its marker is missing, so nothing is dropped).
  const wikiEnd     = sharedMarkerIdx !== -1 ? sharedMarkerIdx : sharedEnd;

  // Extract raw sections (a missing marker degrades leniently instead of
  // silently discarding content)
  const wikiRaw   = lines.slice(wikiStart, wikiEnd).join("\n");
  const sharedRaw = lines.slice(sharedStart, sharedEnd).join("\n");

  // Trim leading/trailing blank lines from each section
  const trimBlank = (s) => s.replace(/^\n+|\n+$/g, "");

  return [trimBlank(wikiRaw), trimBlank(sharedRaw)];
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Filesystem
  fileExists,
  assertWrote,
  // JSON / manifest
  extractJsonObject,
  installmentNumberFromDir,
  // Prompt / verdict
  transformUserPrompt,
  isPassingVerdict,
  validatorMaxStepsFor,
  writePromptDump,
  splitJumpInWikiGenerationOutput,
};

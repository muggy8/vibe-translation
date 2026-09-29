/**
 * utils/prompt.js - Prompt and verdict utility functions.
 *
 * @example
 * const { transformUserPrompt, isPassingVerdict, parseAcceptanceScore } = require("../utils/prompt");
 */

const fs = require("fs");
const path = require("path");
const { extractJsonObject } = require("./manifest");

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

/**
 * Parse an acceptance score (0–100) from the raw output of the acceptance
 * one-shot check.
 *
 * The acceptance prompts ask the model to respond with exactly one integer
 * from 0 to 100 (100 = perfect, 0 = atrocious). In practice models sometimes
 * wrap the number in text ("Score: 72", "72/100", "72 out of 100"), so this
 * extracts it with two strict patterns:
 *
 *   1. Explicit denominator — "72/100", "72 out of 100", "72 of 100".
 *   2. First standalone integer — "72", "Score: 72", "The score is 72."
 *
 * The first number in the reply wins, so a leading "Score: 72" is found even
 * if the model appends extra prose afterwards.
 *
 * @param {string} output - Raw output of the acceptance one-shot call.
 * @returns {number | null} An integer 0–100, or `null` when no valid score
 *   could be extracted (no number, or a number > 100). Callers treat `null`
 *   as a failed check (fail-closed) — see the acceptance loops in the task
 *   modules.
 */
function parseAcceptanceScore(output) {
  if (typeof output !== "string") return null;
  const text = output.trim();
  // 1. Explicit "/100" or "out of 100" / "of 100" denominator.
  const denom = text.match(/(\d{1,3})\s*(?:\/|out\s+of|of)\s*100\b/i);
  if (denom) {
    const n = parseInt(denom[1], 10);
    return n <= 100 ? n : null;
  }
  // 2. First standalone integer (not immediately preceded by "/" or a digit).
  const bare = text.match(/(^|[^/\d])(\d{1,3})(?!\d)/);
  if (bare) {
    const n = parseInt(bare[2], 10);
    return n <= 100 ? n : null;
  }
  return null;
}

function validatorMaxStepsFor(sourceSizeBytes) {
  const chunks = Math.max(1, Math.ceil((sourceSizeBytes || 0) / 32768));
  return Math.max(40, chunks * 2 + 24);
}

/**
 * Parse the acceptance one-shot reply under the JSON contract: the prompts
 * ask for a single JSON object {"score": 0-100, "band": "...", "note": "..."}.
 *
 * Tries the JSON object first (markdown fences and surrounding prose are
 * tolerated by extractJsonObject); when no valid JSON score is present it
 * falls back to the legacy integer extraction (parseAcceptanceScore), so an
 * old-style "85" reply still counts instead of failing the run.
 *
 * @param {string} output - Raw output of the acceptance one-shot call.
 * @returns {{score: number, band: string|null, note: string|null} | null}
 *   The parsed reply, or `null` when no valid score could be extracted at
 *   all (callers treat `null` as a failed check — fail-closed).
 */
function parseAcceptanceReply(output) {
  if (typeof output === "string" && output.trim() !== "") {
    try {
      const obj = extractJsonObject(output);
      if (obj && typeof obj === "object" && Number.isInteger(obj.score) && obj.score >= 0 && obj.score <= 100) {
        return {
          score: obj.score,
          band: typeof obj.band === "string" ? obj.band : null,
          note: typeof obj.note === "string" ? obj.note : null,
        };
      }
    } catch {
      // No parseable JSON object — fall through to the legacy integer parse.
    }
  }
  const score = parseAcceptanceScore(output);
  if (score === null) return null;
  return { score, band: null, note: null };
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

module.exports = { transformUserPrompt, isPassingVerdict, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, writePromptDump };

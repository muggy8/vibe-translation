/**
 * configs/shared.js — Shared configuration constants used across the ai-client
 * modules.
 *
 * This file exists to break circular dependencies and eliminate duplication.
 * Both `glossary.js` and `jump-in-wiki.js` import `AGENT_TOOLS_NOTE` from
 * here so the prompt-injection text lives in exactly one place.
 */

/**
 * Appended to the system prompts of agent-mode stages so the mode-agnostic
 * prompt files keep working.
 *
 * @type {string}
 */
const AGENT_TOOLS_NOTE = `

## File Tools (agent mode)

You have file tools: readFile, listFiles, grep, writeFile, and editFile.
- Your working folder is the volume folder; use paths relative to it (e.g. "wiki.md").
- Read every material listed in the request with readFile before doing anything. Large files may need several reads (use offset/limit to page through).
- Write your output files with writeFile (complete contents) or editFile (targeted fixes).
- When writing a complete output file (not a targeted fix), always use writeFile to **overwrite** the file entirely. Never append to an existing file.
- For the wiki task: write to wiki.md and shared-wiki.md. For the glossary task: write to glossary.md.
- **CRITICAL: You MUST write your output using writeFile or editFile. Do NOT output the file contents in your chat reply — the chat reply is NOT saved to disk. If you output the full content in your chat message instead of calling writeFile, the file will not exist and the run will fail.**
- When you are done writing files, reply with a short summary: what you read, what you wrote, and any problems you hit.
`;

// ── Rolling average validation config ────────────────────────────────────────

/**
 * Number of recent acceptance checks to keep in the rolling window.
 * Read from .env, defaulting to 5.
 *
 * @type {number}
 */
const ROLLING_WINDOW_SIZE = Math.max(
  2,
  parseInt(process.env.ROLLING_WINDOW_SIZE, 10) || 5
);

/**
 * Minimum number of acceptance checks before the rolling average can
 * trigger acceptance. Must be less than ROLLING_WINDOW_SIZE.
 * Read from .env, defaulting to 3.
 *
 * @type {number}
 */
const ROLLING_MIN_SAMPLES = Math.max(
  1,
  parseInt(process.env.ROLLING_MIN_SAMPLES, 10) || 3
);

/**
 * Pass rate threshold (0–1) for the rolling average.
 * When the rolling average of recent acceptance results meets or exceeds
 * this value, the output is accepted.
 * Read from .env, defaulting to 0.60 (i.e. 3 of 5 must pass).
 *
 * @type {number}
 */
const ROLLING_ACCEPTANCE_THRESHOLD = Math.min(
  1,
  Math.max(0, parseFloat(process.env.ROLLING_ACCEPTANCE_THRESHOLD) || 0.6)
);

/**
 * Compute the rolling average (pass rate) from an array of boolean results.
 * Returns 0 if the array is empty.
 *
 * @param {boolean[]} results - Array of acceptance results (true = pass).
 * @returns {number} The pass rate (0–1).
 */
function computeRollingAverage(results) {
  if (!results || results.length === 0) return 0;
  return results.reduce((sum, v) => sum + (v ? 1 : 0), 0) / results.length;
}

/**
 * Persist the current rolling window of acceptance results to disk.
 * The file is a small JSON document that survives process restarts,
 * enabling the skip-check to recover the exact acceptance state
 * without re-calling the AI.
 *
 * Format:
 *   { "results": [true, false, true, ...], "lastCheckedAt": "2026-08-28T..." }
 *
 * @param {string} filePath - Absolute path to write the state file to.
 * @param {boolean[]} results - The current rolling window results.
 */
async function saveRollingState(filePath, results) {
  const fs = require("fs").promises;
  const data = {
    results,
    lastCheckedAt: new Date().toISOString(),
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Load the persisted rolling window state from disk.
 * Returns `null` if the file does not exist, is empty, or is corrupt.
 *
 * @param {string} filePath - Absolute path to read the state file from.
 * @returns {{ results: boolean[] } | null} The loaded state, or `null` on any error.
 */
async function loadRollingState(filePath) {
  const fs = require("fs").promises;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.results)) return null;
    return { results: data.results };
  } catch {
    // File missing, unreadable, or JSON parse error — degrade safely.
    return null;
  }
}

module.exports = {
  AGENT_TOOLS_NOTE,
  ROLLING_WINDOW_SIZE,
  ROLLING_MIN_SAMPLES,
  ROLLING_ACCEPTANCE_THRESHOLD,
  computeRollingAverage,
  saveRollingState,
  loadRollingState,
};

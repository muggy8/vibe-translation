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

// ── Research concurrency ─────────────────────────────────────────────────────

/**
 * Number of parallel research agents to run simultaneously (one per term).
 * Set to 1 for sequential processing (old behavior). Useful to tune to your
 * local server's capacity. Read from .env, defaulting to 3.
 *
 * @type {number}
 */
const RESEARCH_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.RESEARCH_CONCURRENCY, 10) || 3
);

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
 * Passing score (0–100) for the score-based acceptance criterion.
 * The acceptance one-shot check returns an integer 0–100 (100 = perfect,
 * 0 = atrocious). Under the "average" strategy the rolling average of the
 * recent scores must be >= this value; under the "best" strategy each
 * score is compared against it individually.
 * Read from .env, defaulting to 70.
 *
 * 70 is deliberately the boundary of the acceptance rubric's bands
 * ("Pass with minor edits" = 70–84, "Requires revision" = 40–69), so the
 * default reproduces exactly the accept/reject set of the legacy binary
 * PASS/FAIL prompts while still adding granularity in the gray zone.
 *
 * @type {number}
 */
const ACCEPTANCE_PASSING_SCORE = Math.min(
  100,
  Math.max(0, parseInt(process.env.ACCEPTANCE_PASSING_SCORE, 10) || 70)
);

/**
 * Acceptance strategy: how the rolling window of scores is evaluated.
 * - "average" (default): the mean of the recent scores must be >=
 *   ACCEPTANCE_PASSING_SCORE.
 * - "best": at least BEST_OF_MIN_PASSES of the last ROLLING_WINDOW_SIZE
 *   scores must each be >= ACCEPTANCE_PASSING_SCORE (best-X-out-of-Y).
 * Read from .env, defaulting to "average".
 *
 * @type {"average"|"best"}
 */
const ACCEPTANCE_STRATEGY =
  String(process.env.ACCEPTANCE_STRATEGY || "average")
    .trim()
    .toLowerCase() === "best"
    ? "best"
    : "average";

/**
 * For the "best" strategy (best-X-out-of-Y): the minimum number of recent
 * scores that must individually meet ACCEPTANCE_PASSING_SCORE. The window
 * size Y is ROLLING_WINDOW_SIZE.
 * Read from .env, defaulting to 3 (i.e. "best 3 out of 5" with the default
 * window).
 *
 * @type {number}
 */
const BEST_OF_MIN_PASSES = Math.max(
  1,
  parseInt(process.env.BEST_OF_MIN_PASSES, 10) || 3
);

/**
 * Compute the rolling average score from an array of numeric acceptance
 * scores (0–100). Returns 0 if the array is empty.
 *
 * @param {number[]} scores - Array of acceptance scores (0–100).
 * @returns {number} The average score (0–100).
 */
function computeRollingAverage(scores) {
  if (!scores || scores.length === 0) return 0;
  return scores.reduce((sum, v) => sum + v, 0) / scores.length;
}

/**
 * Decide whether a rolling window of acceptance scores (0–100) meets the
 * configured acceptance criterion.
 *
 * - "average" strategy: the mean of `scores` is >= ACCEPTANCE_PASSING_SCORE.
 * - "best" strategy: at least BEST_OF_MIN_PASSES of `scores` are >=
 *   ACCEPTANCE_PASSING_SCORE.
 *
 * Requires at least ROLLING_MIN_SAMPLES scores; returns false for fewer
 * (and for empty / non-array input).
 *
 * @param {number[]} scores - The rolling window of acceptance scores.
 * @returns {boolean} True when the window satisfies the criterion.
 */
function meetsAcceptanceCriteria(scores) {
  if (!Array.isArray(scores) || scores.length < ROLLING_MIN_SAMPLES) return false;
  if (ACCEPTANCE_STRATEGY === "best") {
    const passes = scores.filter((s) => s >= ACCEPTANCE_PASSING_SCORE).length;
    return passes >= BEST_OF_MIN_PASSES;
  }
  return computeRollingAverage(scores) >= ACCEPTANCE_PASSING_SCORE;
}

/**
 * Decide whether a loaded rolling state object (from loadRollingState)
 * satisfies the acceptance criterion — the deterministic, no-AI-call
 * decision used by the idempotency skip-checks in all task modules.
 *
 * @param {{ results: number[] } | null} state - The state returned by
 *   loadRollingState.
 * @returns {boolean} True when the persisted window satisfies the criterion.
 */
function isAcceptedState(state) {
  if (!state) return false;
  return meetsAcceptanceCriteria(state.results);
}

/**
 * Persist the current rolling window of acceptance scores to disk.
 * The file is a small JSON document that survives process restarts,
 * enabling the skip-check to recover the exact acceptance state
 * without re-calling the AI.
 *
 * Format:
 *   { "results": [72, 85, 61, ...], "lastCheckedAt": "2026-08-28T..." }
 *
 * @param {string} filePath - Absolute path to write the state file to.
 * @param {number[]} scores - The current rolling window scores (0–100).
 */
async function saveRollingState(filePath, scores) {
  const fs = require("fs").promises;
  const data = {
    results: scores,
    lastCheckedAt: new Date().toISOString(),
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Load the persisted rolling window state from disk.
 * Returns `null` if the file does not exist, is empty, is corrupt, or
 * stores the legacy binary-verdict format (booleans) — the legacy format
 * is treated as missing so the volume is re-validated once under the
 * score-based criterion (fail-open).
 *
 * @param {string} filePath - Absolute path to read the state file from.
 * @returns {{ results: number[] } | null} The loaded state, or `null` on any error.
 */
async function loadRollingState(filePath) {
  const fs = require("fs").promises;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.results)) return null;
    // Scores are numbers 0–100. Legacy files stored booleans (true = pass)
    // — reject them so the volume is re-validated once (fail-open).
    const valid = data.results.every(
      (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100
    );
    if (!valid) return null;
    return { results: data.results };
  } catch {
    // File missing, unreadable, or JSON parse error — degrade safely.
    return null;
  }
}

module.exports = {
  AGENT_TOOLS_NOTE,
  RESEARCH_CONCURRENCY,
  ROLLING_WINDOW_SIZE,
  ROLLING_MIN_SAMPLES,
  ACCEPTANCE_PASSING_SCORE,
  ACCEPTANCE_STRATEGY,
  BEST_OF_MIN_PASSES,
  computeRollingAverage,
  meetsAcceptanceCriteria,
  isAcceptedState,
  saveRollingState,
  loadRollingState,
};

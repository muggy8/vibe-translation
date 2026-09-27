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
const ACCEPTANCE_WINDOW_SIZE = Math.max(
  2,
  parseInt(process.env.ACCEPTANCE_WINDOW_SIZE, 10) || 5
);

/**
 * Minimum number of acceptance checks before the rolling average can
 * trigger acceptance. Must be less than ACCEPTANCE_WINDOW_SIZE.
 * Read from .env, defaulting to 3.
 *
 * @type {number}
 */
const ACCEPTANCE_MIN_SAMPLES = Math.max(
  1,
  parseInt(process.env.ACCEPTANCE_MIN_SAMPLES, 10) || 3
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
 * - "best": at least ACCEPTANCE_BEST_MIN_PASSES of the last ACCEPTANCE_WINDOW_SIZE
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
 * size Y is ACCEPTANCE_WINDOW_SIZE.
 * Read from .env, defaulting to 3 (i.e. "best 3 out of 5" with the default
 * window).
 *
 * @type {number}
 */
const ACCEPTANCE_BEST_MIN_PASSES = Math.max(
  1,
  parseInt(process.env.ACCEPTANCE_BEST_MIN_PASSES, 10) || 3
);

// ── Un-monitored run policies ────────────────────────────────────────────────
// These knobs front-load the decisions that would otherwise require a human
// during a long (un-monitored) run: when a volume fails, when the previous
// volume's artifact is missing, and when the QA loop hits its iteration limit.
// Every default reproduces the pre-knob behavior (fail loudly) so the pipeline
// stays safe for interactive use; set the "un-monitored" values in .env to let
// a run keep going overnight and pick up the skipped work on a cheap re-run
// (idempotent skip-checks make re-runs cheap).

/**
 * Normalize a policy-style env var value to one of the allowed values.
 * Unknown/empty values fall back to the default (never throws, so a typo in
 * .env degrades to the safe default instead of crashing the run).
 *
 * @param {string | undefined} raw - The raw env value.
 * @param {string[]} allowed - The accepted values (compared case-insensitively).
 * @param {string} defaultValue - The value used when `raw` is absent/unknown.
 * @returns {string} One of `allowed` (or `defaultValue` when it is not).
 */
function normalizePolicy(raw, allowed, defaultValue) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "") return defaultValue;
  return allowed.includes(v) ? v : defaultValue;
}

/**
 * What to do when a volume's processing throws (glossary / character-voice /
 * style-guide / jump-in-wiki).
 * - "abort" (default): the task fails on the first broken volume (legacy).
 * - "skip": log the error, record the volume, and continue with the next one.
 *   In the cumulative tasks the next volume then misses its previous
 *   artifact and is skipped in turn (ON_MISSING_PREVIOUS=skip), so a broken
 *   volume ends that task at that point while the rest of the pipeline
 *   (other tasks, ON_TASK_ERROR) can still run.
 *
 * @type {"abort"|"skip"}
 */
const ON_VOLUME_ERROR = normalizePolicy(
  process.env.ON_VOLUME_ERROR,
  ["abort", "skip"],
  "abort"
);

/**
 * What to do when a cumulative task finds the previous volume's artifact
 * (glossary.md / character-voice.md / style-guide.md) missing — e.g. because
 * the previous volume failed or was skipped (ON_VOLUME_ERROR=skip) or was
 * never processed.
 * - "abort" (default): throw with a "process the earlier volume first"
 *   message (legacy behavior).
 * - "skip": warn and skip this volume (the rest of the task then cascades
 *   the same way until a volume whose previous artifact exists).
 *
 * @type {"abort"|"skip"}
 */
const ON_MISSING_PREVIOUS = normalizePolicy(
  process.env.ON_MISSING_PREVIOUS,
  ["abort", "skip"],
  "abort"
);

/**
 * What to do when a volume's QA loop hits QA_MAX_ITERATIONS without the
 * rolling window meeting the acceptance criterion.
 * - "accept" (default): keep the output as-is and continue (legacy — the
 *   "re-run to validate it" hint stays in the log line).
 * - "fail": throw, so the volume is treated as failed (then subject to
 *   ON_VOLUME_ERROR).
 *
 * @type {"accept"|"fail"}
 */
const ON_QA_LIMIT = normalizePolicy(
  process.env.ON_QA_LIMIT,
  ["accept", "fail"],
  "accept"
);

/**
 * Fail fast (before any AI call) when a required environment variable is
 * missing, with a single message naming every missing variable. Called at the
 * top of each gulp task so a misconfigured .env is caught at run start, not
 * hours in. `dryRun` skips the AI_API_KEY check because --dry-run makes no
 * AI calls.
 *
 * @param {{dryRun?: boolean}} [opts]
 * @param {boolean} [opts.dryRun] - True when running with --dry-run.
 * @throws {Error} Naming every missing required variable.
 */
function validateRequiredEnv({ dryRun = false } = {}) {
  const missing = [];
  if (!process.env.SERIES_LOCATION) missing.push("SERIES_LOCATION");
  if (!process.env.SERIES_NAME) missing.push("SERIES_NAME");
  if (!dryRun && !process.env.AI_API_KEY) missing.push("AI_API_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them in .env before running the pipeline.`
    );
  }
}

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
 * - "best" strategy: at least ACCEPTANCE_BEST_MIN_PASSES of `scores` are >=
 *   ACCEPTANCE_PASSING_SCORE.
 *
 * Requires at least ACCEPTANCE_MIN_SAMPLES scores; returns false for fewer
 * (and for empty / non-array input).
 *
 * @param {number[]} scores - The rolling window of acceptance scores.
 * @returns {boolean} True when the window satisfies the criterion.
 */
function meetsAcceptanceCriteria(scores) {
  if (!Array.isArray(scores) || scores.length < ACCEPTANCE_MIN_SAMPLES) return false;
  if (ACCEPTANCE_STRATEGY === "best") {
    const passes = scores.filter((s) => s >= ACCEPTANCE_PASSING_SCORE).length;
    return passes >= ACCEPTANCE_BEST_MIN_PASSES;
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
 *   { "results": [72, 85, 61, ...], "lastCheckedAt": "2026-08-28T...",
 *     "sourceFingerprint": "<sha256 of the source file at last run>" }
 *
 * The optional sourceFingerprint (passed via `extra`) lets the skip-check
 * detect a changed source file: when it no longer matches the source's
 * current hash, the persisted acceptance state no longer applies to the
 * artifacts on disk (they were built from the old source) and the volume
 * must be regenerated (see isSourceStale).
 *
 * @param {string} filePath - Absolute path to write the state file to.
 * @param {number[]} scores - The current rolling window scores (0–100).
 * @param {{sourceFingerprint?: string}} [extra] - Extra persisted fields
 *   (currently: the source file's sha256).
 */
async function saveRollingState(filePath, scores, extra = {}) {
  const fs = require("fs").promises;
  const data = {
    results: scores,
    lastCheckedAt: new Date().toISOString(),
  };
  if (typeof extra.sourceFingerprint === "string" && extra.sourceFingerprint) {
    data.sourceFingerprint = extra.sourceFingerprint;
  }
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
    return {
      results: data.results,
      // Persisted by saveRollingState (absent in pre-fingerprint state
      // files — undefined keeps the skip-check behaving exactly as before).
      sourceFingerprint:
        typeof data.sourceFingerprint === "string" && data.sourceFingerprint
          ? data.sourceFingerprint
          : undefined,
    };
  } catch {
    // File missing, unreadable, or JSON parse error — degrade safely.
    return null;
  }
}

/**
 * Decide whether a volume's source file has changed since its artifacts were
 * last accepted — the staleness guard for the idempotency skip-checks.
 *
 * When true, the persisted rolling state (and the artifacts it covers) were
 * produced from a DIFFERENT source file: a re-release, errata fix, or
 * corrected edition would otherwise be silently skipped and every later
 * volume would carry the stale snapshot forward. The skip-checks must then
 * treat the volume as "not skipped" (regenerating it also sets the
 * cumulative tasks' regeneratedAny cascade, so downstream volumes are
 * rebuilt on the fresh artifact).
 *
 * Fail-open: a missing fingerprint on either side (pre-fingerprint state
 * files, or a bundle without one) means "unknown" — the check reports
 * false so pre-existing runs keep their current behavior.
 *
 * @param {{ results: number[], sourceFingerprint?: string } | null} state -
 *   The state returned by loadRollingState.
 * @param {{ sourceFingerprint?: string } | null} bundle - The resolved
 *   SourceBundle (utils/source.js sets sourceFingerprint to the source
 *   file's sha256).
 * @returns {boolean} True when both fingerprints are present and differ.
 */
function isSourceStale(state, bundle) {
  if (!state || typeof state.sourceFingerprint !== "string" || !state.sourceFingerprint) {
    return false;
  }
  if (!bundle || typeof bundle.sourceFingerprint !== "string" || !bundle.sourceFingerprint) {
    return false;
  }
  return state.sourceFingerprint !== bundle.sourceFingerprint;
}

module.exports = {
  AGENT_TOOLS_NOTE,
  RESEARCH_CONCURRENCY,
  ACCEPTANCE_WINDOW_SIZE,
  ACCEPTANCE_MIN_SAMPLES,
  ACCEPTANCE_PASSING_SCORE,
  ACCEPTANCE_STRATEGY,
  ACCEPTANCE_BEST_MIN_PASSES,
  // Un-monitored run policies (see the section above).
  normalizePolicy,
  ON_VOLUME_ERROR,
  ON_MISSING_PREVIOUS,
  ON_QA_LIMIT,
  validateRequiredEnv,
  computeRollingAverage,
  meetsAcceptanceCriteria,
  isAcceptedState,
  isSourceStale,
  saveRollingState,
  loadRollingState,
};

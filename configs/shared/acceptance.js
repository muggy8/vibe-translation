/**
 * configs/shared/acceptance.js — the grading contract the four artifacts share.
 *
 * The knobs (how many grades, how high, how much disagreement is allowed) and
 * the arithmetic over a rolling window of grades, plus the small JSON file
 * that lets a re-run remember what a previous process already accepted.
 *
 * The knobs and the arithmetic are one file because a knob is only
 * meaningful next to the rule that reads it: ACCEPTANCE_SAMPLE_FLOOR means
 * nothing until you see the criterion it floors.
 */

const { readBoolEnv } = require("./env");

// ── Rolling average validation config ────────────────────────────────────────

/**
 * Number of recent acceptance checks to keep in the rolling window.
 * Default 2: the writer rewrites the artifact every iteration, so older
 * scores describe artifact states that no longer exist — the window's only
 * real job is smoothing the grader's score-to-score variance, and two fresh
 * passes are enough for that while avoiding wasted validator runs.
 * Read from .env.
 *
 * @type {number}
 */
const ACCEPTANCE_WINDOW_SIZE = Math.max(
  2,
  parseInt(process.env.ACCEPTANCE_WINDOW_SIZE, 10) || 2
);

/**
 * Minimum number of acceptance checks before the criterion can trigger
 * acceptance. Not a knob: it is derived from the window, because the rolling
 * window is capped at ACCEPTANCE_WINDOW_SIZE — asking for more samples than the
 * window can hold makes acceptance impossible (a footgun the old separate
 * variable allowed). ACCEPTANCE_MIN_SAMPLES is still honored for an existing
 * .env.
 *
 * @type {number}
 */
const ACCEPTANCE_MIN_SAMPLES = Math.max(
  1,
  parseInt(process.env.ACCEPTANCE_MIN_SAMPLES, 10) ||
    Math.min(2, ACCEPTANCE_WINDOW_SIZE)
);

/**
 * The single passing threshold (0–100) for every scored gate in the pipeline:
 * the acceptance check on the four volume artifacts, chapter verification, and
 * the polish final audit. They all use the same 0–100 rubric, so they share one
 * number — "at or above this, the work is good enough to keep".
 *
 * PASSING_SCORE is the knob. The older per-gate names (ACCEPTANCE_PASSING_SCORE
 * / VERIFY_PASSING_SCORE / POLISH_VERIFY_PASSING_SCORE) are still read as
 * fallbacks, in that order, so an existing .env keeps working unchanged.
 *
 * 70 is deliberately the boundary of the acceptance rubric's bands
 * ("Pass with minor edits" = 70–84, "Requires revision" = 40–69), so the
 * default reproduces exactly the accept/reject set of the legacy binary
 * PASS/FAIL prompts while still adding granularity in the gray zone.
 *
 * @type {number}
 */
const PASSING_SCORE = (() => {
  for (const key of [
    "PASSING_SCORE",
    "ACCEPTANCE_PASSING_SCORE",
    "VERIFY_PASSING_SCORE",
    "POLISH_VERIFY_PASSING_SCORE",
  ]) {
    const n = parseInt(process.env[key], 10);
    if (Number.isFinite(n)) return Math.min(100, Math.max(0, n));
  }
  return 70;
})();
const ACCEPTANCE_PASSING_SCORE = PASSING_SCORE;

/**
 * The exceptional-score floor: a first acceptance grade at or above this is
 * strong enough to be worth CONFIRMING instead of running another full
 * validator + acceptance round to be sure.
 *
 * 85 is the boundary of the acceptance rubric's top band ("Pass" = 85–100).
 * Read from .env (ACCEPTANCE_EXCEPTIONAL_SCORE).
 *
 * @type {number}
 */
const ACCEPTANCE_EXCEPTIONAL_SCORE = (() => {
  const n = parseInt(process.env.ACCEPTANCE_EXCEPTIONAL_SCORE, 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 85;
})();

/**
 * How much the confirmation grades may disagree with an exceptional score
 * before the score is treated as a fluke. A grade that lands more than this
 * many points below the exceptional floor means the first great score was
 * luck, not quality.
 *
 * Read from .env (ACCEPTANCE_SCORE_TOLERANCE, default 3).
 *
 * @type {number}
 */
const ACCEPTANCE_SCORE_TOLERANCE = (() => {
  const n = parseInt(process.env.ACCEPTANCE_SCORE_TOLERANCE, 10);
  return Number.isFinite(n) ? Math.max(0, n) : 3;
})();

/**
 * The floor NO single acceptance grade may fall below (ACCEPTANCE_SAMPLE_FLOOR).
 *
 * The acceptance criterion is a rolling average, and an average lets a
 * near-perfect grade cancel a terrible one: with the default window of 2 and a
 * passing score of 69, scores of [100, 38] accepted the artifact — 38 is the
 * rubric's "Reject" band, so the pipeline signed off a document one grader
 * called atrocious because another grader loved it.
 *
 * A bad sample is information, not noise to be averaged away. Default: the
 * passing score minus 15 (the bottom of the "Pass with minor edits" band), so a
 * sample in "Requires revision" or "Reject" blocks acceptance whatever the mean
 * says. Set it to 0 to restore pure averaging.
 *
 * @type {number}
 */
const ACCEPTANCE_SAMPLE_FLOOR = (() => {
  const n = parseInt(process.env.ACCEPTANCE_SAMPLE_FLOOR, 10);
  if (Number.isFinite(n)) return Math.min(100, Math.max(0, n));
  return Math.max(0, PASSING_SCORE - 15);
})();

/**
 * How many EXTRA grades an exceptional score is re-checked with before it can
 * be accepted on the spot (ACCEPTANCE_CONFIRMATION_CHECKS, default 2).
 *
 * One of them is ALWAYS run at temperature 0 — the deterministic anchor. A
 * local llama.cpp server is near-deterministic rather than perfectly so
 * (batching and 16-bit arithmetic drift a little), but it is the one grade
 * whose agreement means something: if the calm, repeatable grader says
 * "exceptional" while the stochastic ones wobble, the artifact is exceptional.
 *
 * @type {number}
 */
const ACCEPTANCE_CONFIRMATION_CHECKS = (() => {
  const n = parseInt(process.env.ACCEPTANCE_CONFIRMATION_CHECKS, 10);
  return Number.isFinite(n) ? Math.max(1, n) : 2;
})();

/**
 * The floor every confirmation grade must clear: the exceptional score minus
 * the tolerance (85 - 3 = 82 by default). Below that, the consensus broke down
 * and the volume falls back to the normal rolling-window loop.
 *
 * @type {number}
 */
const ACCEPTANCE_CONFIRMATION_MIN_SCORE = Math.max(
  0,
  ACCEPTANCE_EXCEPTIONAL_SCORE - ACCEPTANCE_SCORE_TOLERANCE
);

/**
 * Whether a grade that ALREADY passes can earn the window's remaining samples by
 * re-grading the same artifact, instead of running a full feedback round and a
 * second full validator turn (ACCEPTANCE_CONFIRM_ON_PASSING, default true).
 *
 * Why this exists: acceptance needs `ACCEPTANCE_MIN_SAMPLES` scores, so a first
 * grade of 76 against a passing score of 69 cannot accept yet — and the only way
 * the loop had to obtain the second sample was to rewrite the artifact and
 * re-audit it. Measured on the live 17-volume run, that cost 2.63M tokens for a
 * feedback pass that changed NOTHING (46 tool calls, all reads, zero writes) plus
 * an 8.4M-token validator turn over the unchanged document. Re-grading is the
 * same evidence for ~55k tokens per sample.
 *
 * It is deliberately NOT a lower copy of the exceptional path. The exceptional
 * path asks "is this great grade real?" and keeps its confirmations OUT of the
 * window. This one is collecting the samples the window is missing, so its
 * grades go IN — including one that fails, which is the signal that the artifact
 * really does need the feedback round.
 *
 * Set it to `false` to restore the old behavior exactly.
 *
 * @type {boolean}
 */
const ACCEPTANCE_CONFIRM_ON_PASSING = readBoolEnv("ACCEPTANCE_CONFIRM_ON_PASSING", true);

// ── The arithmetic over a window of grades ───────────────────────────────────

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
 * acceptance criterion: every score is at or above ACCEPTANCE_SAMPLE_FLOOR and
 * the mean of `scores` is >= ACCEPTANCE_PASSING_SCORE.
 *
 * Requires at least ACCEPTANCE_MIN_SAMPLES scores; returns false for fewer
 * (and for empty / non-array input).
 *
 * The floor is the important half: an average alone accepted [100, 38] at a
 * passing score of 69, i.e. a document one grader put in the rubric's "Reject"
 * band was signed off because a second grader loved it.
 *
 * (The "best" strategy — "at least ACCEPTANCE_BEST_MIN_PASSES scores in the
 * window individually pass" — was removed. With the default window of 2 it
 * asked for 3 passing scores in a window that can only ever hold 2, so
 * `ACCEPTANCE_STRATEGY=best` could NEVER accept: every volume burned all
 * QA_MAX_ITERATIONS validator turns and then fell through to ON_QA_LIMIT.)
 *
 * @param {number[]} scores - The rolling window of acceptance scores.
 * @returns {boolean} True when the window satisfies the criterion.
 */
function meetsAcceptanceCriteria(scores) {
  if (!Array.isArray(scores) || scores.length < ACCEPTANCE_MIN_SAMPLES) return false;
  // A sample below the floor is a signal, not noise to average away.
  if (ACCEPTANCE_SAMPLE_FLOOR > 0 && scores.some((s) => s < ACCEPTANCE_SAMPLE_FLOOR)) return false;
  return computeRollingAverage(scores) >= ACCEPTANCE_PASSING_SCORE;
}

/**
 * Decide whether an exceptional first grade is confirmed by its re-grades — the
 * "is this a fluke?" test.
 *
 * A score at or above ACCEPTANCE_EXCEPTIONAL_SCORE (85, the rubric's top band)
 * is re-graded ACCEPTANCE_CONFIRMATION_CHECKS more times. The artifact is
 * accepted on the spot when:
 *
 *   - every confirmation score stays within ACCEPTANCE_SCORE_TOLERANCE of the
 *     exceptional floor (nothing collapsed back into the gray zone), AND
 *   - the temperature-0 confirmation — the deterministic one, the only grade
 *     that is not noise — is itself exceptional.
 *
 * If either fails, the scores stay in the rolling window and the volume
 * continues through the normal loop: the great first grade was luck.
 *
 * @param {number} firstScore - The original acceptance score.
 * @param {Array<{score: number|null, temperature: number}>} confirmations - The re-grades (one must be the temperature-0 anchor).
 * @returns {{accepted: boolean, reason: string}} `reason` explains the decision for the run log.
 */
function meetsExceptionalCriteria(firstScore, confirmations) {
  if (!Number.isFinite(firstScore) || firstScore < ACCEPTANCE_EXCEPTIONAL_SCORE) {
    return { accepted: false, reason: `the first score ${firstScore} is not exceptional (< ${ACCEPTANCE_EXCEPTIONAL_SCORE})` };
  }
  const list = Array.isArray(confirmations) ? confirmations : [];
  if (list.length === 0) {
    return { accepted: false, reason: "no confirmation grades were run" };
  }
  const scores = list.map((c) => (c && Number.isFinite(c.score) ? c.score : null));
  const missing = scores.filter((s) => s === null).length;
  if (missing > 0) {
    // Fail closed: an unparseable confirmation grade is a failed check, exactly
    // like an unparseable first grade.
    return { accepted: false, reason: `${missing} confirmation grade(s) returned no score` };
  }
  const lowest = Math.min(...scores);
  if (lowest < ACCEPTANCE_CONFIRMATION_MIN_SCORE) {
    return {
      accepted: false,
      reason: `a confirmation grade fell to ${lowest} (floor ${ACCEPTANCE_CONFIRMATION_MIN_SCORE} = ${ACCEPTANCE_EXCEPTIONAL_SCORE} − ${ACCEPTANCE_SCORE_TOLERANCE})`,
    };
  }
  const anchor = list.find((c) => c && c.temperature === 0);
  if (!anchor) {
    return { accepted: false, reason: "no temperature-0 confirmation grade was run" };
  }
  if (anchor.score < ACCEPTANCE_EXCEPTIONAL_SCORE) {
    return {
      accepted: false,
      reason: `the deterministic (temperature 0) grade scored ${anchor.score}, below the exceptional floor ${ACCEPTANCE_EXCEPTIONAL_SCORE}`,
    };
  }
  return {
    accepted: true,
    reason: `every grade stayed within ${ACCEPTANCE_SCORE_TOLERANCE} of ${ACCEPTANCE_EXCEPTIONAL_SCORE} and the deterministic grade agrees`,
  };
}

/**
 * Whether a first acceptance grade is exceptional enough to be worth confirming
 * (see {@link meetsExceptionalCriteria}).
 *
 * @param {number} score - The acceptance score.
 * @returns {boolean}
 */
function isExceptionalScore(score) {
  return Number.isFinite(score) && score >= ACCEPTANCE_EXCEPTIONAL_SCORE;
}

/**
 * Decide whether a loaded rolling state object (from loadRollingState)
 * satisfies the acceptance criterion — the deterministic, no-AI-call
 * decision used by the idempotency skip-checks in all task modules.
 *
 * An exceptional-consensus acceptance is reproduced from its own record: the
 * window may hold a single score (the fast path never runs a second grader
 * iteration), so the ordinary "enough samples, average high enough" rule would
 * refuse it and the volume would be rebuilt on every re-run. Instead the state
 * is trusted when it says the consensus accepted AND the deterministic
 * (temperature 0) grade it recorded is itself exceptional — a claim that is
 * checkable from the file, not just a label.
 *
 * @param {{ results: number[], acceptedBy?: string, deterministicScore?: number } | null} state - The state returned by loadRollingState.
 * @returns {boolean} True when the persisted window satisfies the criterion.
 */
function isAcceptedState(state) {
  if (!state) return false;
  if (state.acceptedBy === "exceptional-consensus") {
    return (
      Number.isFinite(state.deterministicScore) &&
      state.deterministicScore >= ACCEPTANCE_EXCEPTIONAL_SCORE
    );
  }
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
 *     "sourceFingerprint": "<sha256 of the source file at last run>",
 *     "acceptedBy": "rolling-window" | "exceptional-consensus" }
 *
 * The optional sourceFingerprint (passed via `extra`) lets the skip-check
 * detect a changed source file: when it no longer matches the source's
 * current hash, the persisted acceptance state no longer applies to the
 * artifacts on disk (they were built from the old source) and the volume
 * must be regenerated (see isSourceStale).
 *
 * acceptedBy / deterministicScore record HOW the volume was accepted, so a
 * re-run reproduces the decision without re-grading (an exceptional-consensus
 * acceptance has a different score history than a rolling-window one).
 *
 * @param {string} filePath - Absolute path to write the state file to.
 * @param {number[]} scores - The current rolling window scores (0–100).
 * @param {{sourceFingerprint?: string, acceptedBy?: string, deterministicScore?: number}} [extra] - Extra persisted fields.
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
  if (typeof extra.acceptedBy === "string" && extra.acceptedBy) {
    data.acceptedBy = extra.acceptedBy;
  }
  if (Number.isFinite(extra.deterministicScore)) {
    data.deterministicScore = extra.deterministicScore;
  }
  if (Array.isArray(extra.confirmations) && extra.confirmations.length > 0) {
    data.confirmations = extra.confirmations;
  }
  if (Array.isArray(extra.rejectedConfirmations) && extra.rejectedConfirmations.length > 0) {
    data.rejectedConfirmations = extra.rejectedConfirmations;
  }
  // A QA loop that stopped because a feedback pass applied nothing (see
  // fingerprintFiles in utils/fs.js). Recorded so a re-run and the run summary can
  // tell \"ran out of iterations\" apart from \"the rewrite produced nothing\", which
  // are different problems with different fixes.
  if (extra.stalled === true) data.stalled = true;
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
      // Persisted by saveRollingState: HOW the volume was accepted
      // ("rolling-window", "exceptional-consensus" or "passing-consensus").
      // Diagnostic only — isAcceptedState re-derives the decision from the
      // scores, so an old state file without it still skips correctly.
      acceptedBy:
        typeof data.acceptedBy === "string" && data.acceptedBy
          ? data.acceptedBy
          : undefined,
      deterministicScore: Number.isFinite(data.deterministicScore)
        ? data.deterministicScore
        : undefined,
      // The confirmation grades of a consensus that FAILED (diagnostic only —
      // they are deliberately not part of `results`).
      rejectedConfirmations: Array.isArray(data.rejectedConfirmations)
        ? data.rejectedConfirmations
        : undefined,
      // The loop stopped because a feedback pass applied nothing rather than
      // because it ran out of iterations (diagnostic only — it does not change
      // the accept/skip decision, but it is the difference between \"the grades
      // never agreed\" and \"the rewrite produced nothing\", which need different
      // fixes).
      stalled: data.stalled === true ? true : undefined,
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
  ACCEPTANCE_WINDOW_SIZE,
  ACCEPTANCE_MIN_SAMPLES,
  PASSING_SCORE,
  ACCEPTANCE_PASSING_SCORE,
  ACCEPTANCE_EXCEPTIONAL_SCORE,
  ACCEPTANCE_SCORE_TOLERANCE,
  ACCEPTANCE_SAMPLE_FLOOR,
  ACCEPTANCE_CONFIRMATION_CHECKS,
  ACCEPTANCE_CONFIRMATION_MIN_SCORE,
  ACCEPTANCE_CONFIRM_ON_PASSING,
  computeRollingAverage,
  meetsAcceptanceCriteria,
  meetsExceptionalCriteria,
  isExceptionalScore,
  isAcceptedState,
  saveRollingState,
  loadRollingState,
  isSourceStale,
};

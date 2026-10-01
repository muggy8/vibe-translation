/**
 * configs/shared.js — Shared configuration constants used across the ai-client
 * modules.
 *
 * This file exists to break circular dependencies and eliminate duplication.
 * Both `glossary.js` and `jump-in-wiki.js` import `AGENT_TOOLS_NOTE` from
 * here so the prompt-injection text lives in exactly one place.
 */

const path = require("path");

/**
 * Where a series-level artifact copy is published: SERIES_ARTIFACTS_DIR,
 * defaulting to the series root. One knob for the four final copies (glossary /
 * character voice / style guide / shared wiki), which all defaulted to the same
 * folder anyway. The old per-file names (GLOSSARY_OUTPUT_FILE /
 * VOICE_OUTPUT_FILE / STYLE_OUTPUT_FILE / SHARED_WIKI_OUTPUT_FILE) still win
 * when set, so an existing .env keeps its exact paths.
 *
 * @param {string} fileName - Artifact name inside the directory (e.g. "glossary.md").
 * @param {string} legacyEnvKey - The old per-file env var, honored as an override.
 * @param {string} seriesDir - SERIES_LOCATION (the fallback directory).
 * @returns {string} Absolute path for the series-level copy.
 */
function seriesArtifactFile(fileName, legacyEnvKey, seriesDir) {
  const legacy = process.env[legacyEnvKey];
  if (legacy) return legacy;
  const dir = (process.env.SERIES_ARTIFACTS_DIR || "").trim() || seriesDir;
  return path.join(dir, fileName);
}

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

// ── Stage concurrency ────────────────────────────────────────────────────────

/**
 * How many independent units a stage may run at once: research agents per
 * glossary term, chapters per verify / retranslate / polish pass, chapters per
 * cross-model audit batch. One knob for all of them, because on a local
 * endpoint they all mean the same thing — "how many inferences can this machine
 * serve at once" — and they were five variables saying default 1.
 *
 * Default 1 (serial): a local inference server answers one request at a time,
 * and parallel research agents would also issue concurrent editFile calls on the
 * shared glossary-research.md (a non-atomic read-modify-write). Raise it only
 * when the endpoint genuinely serves parallel requests.
 *
 * The old per-stage names (RESEARCH_CONCURRENCY / VERIFY_CONCURRENCY /
 * RETRANSLATE_CONCURRENCY / POLISH_CONCURRENCY / AUDIT_CONCURRENCY) still work
 * as per-stage overrides for an existing .env.
 *
 * @type {number}
 */
const STAGE_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.STAGE_CONCURRENCY, 10) || 1
);

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
 * Sampling temperature for every call that GRADES text rather than writes it:
 * the acceptance graders of the four volume artifacts, chapter verification, the
 * verify tiebreak audit and the polish final audit. A judgment call wants a
 * stable one — the three separate 0.2 knobs were one setting.
 *
 * (Used to live in utils/translate.js, which meant the four pre-production
 * acceptance graders — the calls that decide whether an artifact is accepted —
 * could not reach it and ran at the house WRITING temperature instead, making
 * the acceptance score needlessly noisy.)
 *
 * JUDGE_TEMPERATURE is the knob; the legacy names (VERIFY_TEMPERATURE /
 * AUDIT_TEMPERATURE) are still honored, in that order, for an existing .env.
 *
 * @returns {number} The grading temperature (default 0.2).
 */
function judgeTemperature() {
  for (const key of ["JUDGE_TEMPERATURE", "VERIFY_TEMPERATURE", "AUDIT_TEMPERATURE"]) {
    const n = parseFloat(process.env[key]);
    if (Number.isFinite(n)) return n;
  }
  return 0.2;
}

/**
 * Build a STRUCTURAL error: the pipeline's inputs or outputs are broken, as
 * opposed to a model that had a bad run.
 *
 * The distinction decides whether a failure may be skipped. `ON_VOLUME_ERROR=skip`
 * and `ON_TASK_ERROR=continue` exist so an un-monitored overnight run survives a
 * flaky model call — but they must NOT paper over a source file that has gone
 * missing, an archive that will not open, or a volume published with chapters
 * missing from the middle. Those are not transient: re-running cannot fix them,
 * and continuing means a whole series of artifacts built on a broken book.
 *
 * Mark one with `structuralError(...)` at the point that knows the difference;
 * every volume-skip site honours it.
 *
 * @param {string} message - The error message.
 * @param {Error} [cause] - The underlying error, if any.
 * @returns {Error} The marked error.
 */
function structuralError(message, cause) {
  const err = new Error(message);
  err.structural = true;
  if (cause) err.cause = cause;
  return err;
}

/**
 * Whether an error is structural (see {@link structuralError}) — the check that
 * overrides ON_VOLUME_ERROR=skip / ON_TASK_ERROR=continue.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isStructuralError(err) {
  return !!(err && typeof err === "object" && err.structural === true);
}

/**
 * Build the error a task must throw when one or more of its volumes failed.
 *
 * Every per-volume loop is wrapped in a try/catch so an un-monitored run can keep
 * going (`ON_VOLUME_ERROR=skip`) — but "keep going" must not mean "report success".
 * A task that skipped or failed volumes has to fail the run, exactly like the
 * translation-stage tasks already do; otherwise a whole series of artifacts is
 * silently missing and the exit code says everything worked. (Observed: the four
 * pre-production tasks printed the failure summary and exited 0.)
 *
 * Returns `null` when there is nothing to fail on, so callers can do their
 * end-of-run publishing first and throw last.
 *
 * @param {string} taskName - The task name, for the message.
 * @param {Array<{folder?: string, installmentNumber?: string, error?: Error}>} failedVolumes - The recorded failures.
 * @param {number} totalVolumes - How many volumes the task attempted.
 * @returns {Error|null} The error to throw, or null when every volume succeeded.
 */
function volumeFailureError(taskName, failedVolumes, totalVolumes) {
  if (!Array.isArray(failedVolumes) || failedVolumes.length === 0) return null;
  const names = failedVolumes
    .map((v) => {
      if (typeof v === "string") return `${v} (volume failed)`;
      const label = v && (v.installmentNumber || v.folder) ? (v.installmentNumber || v.folder) : "unknown";
      const reason = v && v.error && v.error.message ? v.error.message : "failed";
      return `${label} (${reason})`;
    })
    .join("; ");
  return new Error(
    `${taskName}: ${failedVolumes.length} of ${totalVolumes} volume(s) failed: ${names}. ` +
      `Re-run the task (idempotent) to pick them up.`
  );
}

/**
 * Read a boolean env var with one consistent semantics: ON by default, OFF only
 * for an explicit falsy value. The two historical readers disagreed (the
 * harness treated any non-true/1 value as OFF, the stage helper treated only
 * "false" as OFF — so AI_THINKING=0 meant "off" in one place and "on" in the
 * other). This is the single reader both use now.
 *
 * @param {string} name - The env var name.
 * @param {boolean} [defaultValue=true] - The value when the var is absent/empty/unrecognized.
 * @returns {boolean}
 */
function readBoolEnv(name, defaultValue = true) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return defaultValue;
}

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
 * SERIES_NAME is never required: the series name is a decision the intake step
 * makes (step 0 of the default run) and every task reads it from the manifest.
 * Set SERIES_NAME only to override what the intake agent concluded.
 *
 * @param {{dryRun?: boolean}} [opts]
 * @param {boolean} [opts.dryRun] - True when running with --dry-run.
 * @throws {Error} Naming every missing required variable.
 */
function validateRequiredEnv({ dryRun = false } = {}) {
  const missing = [];
  if (!process.env.SERIES_LOCATION) missing.push("SERIES_LOCATION");
  if (!dryRun && !process.env.AI_API_KEY) missing.push("AI_API_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them in .env before running the pipeline.`
    );
  }
}

/** Fallback source language when neither .env nor the manifest says. */
const DEFAULT_SOURCE_LANGUAGE = "Japanese";
/** Fallback target language when neither .env nor the manifest says. */
const DEFAULT_TARGET_LANGUAGE = "English";

/**
 * Resolve the settings every stage fills its prompts with, from the two places
 * they can come from, in precedence order:
 *
 *   explicit .env value  >  the intake manifest's decision  >  the default
 *
 * .env stays the override it always was (set TRANSLATION_SOURCE_LANGUAGE and it
 * wins, whatever the intake agent concluded); unset it and the manifest — what
 * the intake agent actually read — is what the run uses. Every task module reads
 * its languages and series name through this so there is exactly one rule.
 *
 * @param {TranslationTargetManifest|null} [manifest] - The manifest from getTranslationTarget().
 * @returns {{seriesName: string|null, seriesNameAlt: string|null, sourceLanguage: string, targetLanguage: string}}
 */
function resolveRunSettings(manifest) {
  const fromEnv = (key) => {
    const value = process.env[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const fromManifest = (key) => {
    const value = manifest && manifest[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const seriesName = fromEnv("SERIES_NAME") || fromManifest("seriesName");
  return {
    seriesName,
    seriesNameAlt: fromManifest("seriesNameAlt") || seriesName,
    sourceLanguage:
      fromEnv("TRANSLATION_SOURCE_LANGUAGE") ||
      fromManifest("sourceLanguage") ||
      DEFAULT_SOURCE_LANGUAGE,
    targetLanguage:
      fromEnv("TRANSLATION_TARGET_LANGUAGE") ||
      fromManifest("targetLanguage") ||
      DEFAULT_TARGET_LANGUAGE,
  };
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
      // ("rolling-window" or "exceptional-consensus"). Diagnostic only —
      // isAcceptedState re-derives the decision from the scores, so an old
      // state file without it still skips correctly.
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
  STAGE_CONCURRENCY,
  ACCEPTANCE_WINDOW_SIZE,
  ACCEPTANCE_MIN_SAMPLES,
  ACCEPTANCE_PASSING_SCORE,
  ACCEPTANCE_EXCEPTIONAL_SCORE,
  ACCEPTANCE_SCORE_TOLERANCE,
  ACCEPTANCE_SAMPLE_FLOOR,
  ACCEPTANCE_CONFIRMATION_CHECKS,
  ACCEPTANCE_CONFIRMATION_MIN_SCORE,
  // Un-monitored run policies (see the section above).
  normalizePolicy,
  readBoolEnv,
  structuralError,
  isStructuralError,
  volumeFailureError,
  ON_VOLUME_ERROR,
  ON_MISSING_PREVIOUS,
  ON_QA_LIMIT,
  validateRequiredEnv,
  resolveRunSettings,
  seriesArtifactFile,
  PASSING_SCORE,
  STAGE_CONCURRENCY,
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
  computeRollingAverage,
  meetsAcceptanceCriteria,
  meetsExceptionalCriteria,
  isExceptionalScore,
  judgeTemperature,
  isAcceptedState,
  isSourceStale,
  saveRollingState,
  loadRollingState,
};

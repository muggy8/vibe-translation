/**
 * configs/shared/settings.js — the run's shape: what a stage may do at once, what to do when
a volume fails, which languages, and where a finished artifact is published.
 *
 * Everything here is a decision the operator makes through .env or the
 * manifest, plus the two notes that get injected into every agent prompt.
 * It is the file to read when asking "why did the run behave this way?".
 */

const path = require("path");
const { readBoolEnv, normalizePolicy } = require("./env");

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
- **grep and listFiles take a FOLDER, never a file.** To search one specific file, search its folder ("." is your working folder) and narrow with grep's "glob" — which is a filename ENDING (".md", "whole.md"), NOT a wildcard: "*.md" and "*whole.md" match NOTHING and will look like an empty source. To search one named file, pass its exact name as glob.
- grep cannot see inside a .epub (it is an archive, not text).
- Write your output files with writeFile (complete contents) or editFile (targeted fixes). editFile takes "oldString" (the exact text to find) and "newString".
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
 * The THINKING dialect for a call that grades text — the other half of the same
 * decision as `judgeTemperature()`.
 *
 * A reasoning phase is billed out of the same reply budget as the answer, so a
 * grader that thinks too hard does not produce a worse score, it produces NO
 * score (observed live: one call spent 131,072 reasoning tokens and answered
 * with 0 characters — gotcha 59). The translation stage's judging calls already
 * pair the calm temperature with the calm thinking level via `stageThinking()`;
 * this is the same rule for the calls that live OUTSIDE the translation stage,
 * which had no way to reach it and inherited the AUTHORING level
 * (`AI_THINKING_LEVEL`, default xhigh) instead.
 *
 * `<PREFIX>_THINKING` / `<PREFIX>_THINKING_LEVEL` override for one kind of call
 * (e.g. `ACCEPTANCE_THINKING_LEVEL`); otherwise `AI_THINKING` decides whether it
 * thinks at all and `STAGE_THINKING_LEVEL` (default `medium`) how hard.
 *
 * @param {string} [prefix] - The call's own knob prefix (default "JUDGE").
 * @returns {{thinking: boolean, thinkingLevel: string}} The thinking dialect to pass to the call.
 */
function judgeThinking(prefix = "JUDGE") {
  const thinking = readBoolEnv(`${prefix}_THINKING`, readBoolEnv("AI_THINKING", true));
  const level = process.env[`${prefix}_THINKING_LEVEL`] ?? process.env.STAGE_THINKING_LEVEL;
  return {
    thinking,
    thinkingLevel: typeof level === "string" && level.trim() !== "" ? level.trim() : "medium",
  };
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

module.exports = {
  seriesArtifactFile,
  AGENT_TOOLS_NOTE,
  STAGE_CONCURRENCY,
  judgeTemperature,
  judgeThinking,
  ON_VOLUME_ERROR,
  ON_MISSING_PREVIOUS,
  ON_QA_LIMIT,
  validateRequiredEnv,
  DEFAULT_SOURCE_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
  resolveRunSettings,
};

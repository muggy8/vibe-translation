/**
 * configs/env-defaults.js — the one setting a fresh clone does not have to set.
 *
 * `SERIES_LOCATION` is the folder the pipeline reads its books from and writes its
 * artifacts into. It used to have no default at all: a clone with no `.env` failed
 * before any step ran, and every "how do I start" answer had to explain a path
 * before it could explain the pipeline. The default is now the repo's own
 * `epub_source/` folder — put the books in it and run.
 *
 * Why the default is APPLIED HERE, at the top of every entry point, instead of at
 * the place that reads the value: several task modules turn SERIES_LOCATION into a
 * module constant when they are required (`const seriesDir = process.env
 * .SERIES_LOCATION` in translate/config.js, character-voice/config.js,
 * verify-translate/config.js, polish/config.js and consistency-audit.js). A default
 * applied later — inside `validateRequiredEnv`, which runs when a task STARTS — is
 * invisible to them, because their constant was already decided at require time. So
 * every entry point calls `applySeriesLocationDefault()` immediately after dotenv
 * has loaded and before it requires a task module. → AGENTS.md gotcha 79.
 *
 * It is a default, not a silent override: an explicit SERIES_LOCATION (in `.env` or
 * in the real environment) always wins and is left exactly as written, and when the
 * default is what got used the run says so on its first line. A run quietly pointed
 * at a folder the operator never chose is the kind of surprise this project does not
 * allow — the intake step then fails loudly if that folder holds no books.
 */

const path = require("path");
const dotenv = require("dotenv");

/** The repository root (this file lives in `configs/`). */
const projectRoot = path.resolve(__dirname, "..");

/** The folder a fresh clone drops its books in, relative to the repository root. */
const DEFAULT_SERIES_DIR_NAME = "epub_source";

/**
 * The folder the pipeline uses when SERIES_LOCATION is not set: `<repo>/epub_source`.
 * Absolute on purpose — a relative default would mean a different folder for every
 * working directory the pipeline can be started from.
 *
 * @returns {string} Absolute path to the default series folder.
 */
function defaultSeriesLocation() {
  return path.join(projectRoot, DEFAULT_SERIES_DIR_NAME);
}

/** One announcement per process, so a nine-step run does not repeat itself nine times. */
let announced = false;

/** True in this process once the default — rather than an operator — decided the folder. */
let defaultApplied = false;

/**
 * Fill in SERIES_LOCATION when nothing else decided it. Idempotent, and it never
 * touches a value someone actually set (including an empty-ish one that is only
 * whitespace, which counts as unset).
 *
 * @returns {{applied: boolean, dir: string}} `applied` is true when the default was
 *          used; `dir` is the folder the run will use either way (absolute).
 */
function applySeriesLocationDefault() {
  const raw = process.env.SERIES_LOCATION;
  if (typeof raw === "string" && raw.trim() !== "") {
    return { applied: false, dir: path.resolve(raw) };
  }
  const dir = defaultSeriesLocation();
  process.env.SERIES_LOCATION = dir;
  defaultApplied = true;
  if (!announced) {
    announced = true;
    console.error(
      `[env] SERIES_LOCATION is not set — using the default source folder: ${dir}\n` +
        `      Put your books (.epub files, or one folder per volume) there, or set\n` +
        `      SERIES_LOCATION in .env to point somewhere else.`
    );
  }
  return { applied: true, dir };
}

/**
 * The series folder this process was TOLD to use, or null when nobody told it.
 *
 * The pipeline takes the default; the delivery layer does not. A manager's decision, a
 * diagnosis and a patch are answers about ONE run, and a folder inherited from a default
 * is not a statement about which run — so those roles ask for `--series=<dir>` or an
 * explicit `SERIES_LOCATION` and refuse without one (AGENTS.md gotcha 79). They have to
 * ask this question explicitly: by the time their own code runs, a transitive require of
 * a task module has already filled the default into the environment.
 *
 * @returns {string|null} The value an operator chose, exactly as they wrote it.
 */
function chosenSeriesLocation() {
  if (defaultApplied) return null;
  const raw = process.env.SERIES_LOCATION;
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

/**
 * Load `.env` the way every entry point does — quietly.
 *
 * dotenv v17 prints a banner line on stdout every single time it loads, and this project
 * calls `dotenv.config()` in some sixty modules, so a pipeline run spent its first screen
 * on dotenv's own advertising (one line per require, before the pipeline has said a word).
 * The quiet flag is process-wide and read per call, so setting it here — before the first
 * load, and therefore before every later call in the same process — is the one place it can
 * be switched off. It changes what dotenv PRINTS, not what it loads: values already in the
 * real environment still win over the file, exactly as before.
 *
 * @returns {import("dotenv").DotenvResult} What dotenv did.
 */
function loadEnv() {
  process.env.DOTENV_CONFIG_QUIET = "true";
  return dotenv.config();
}

/**
 * The entry point's env bootstrap: read `.env`, then fill in the setting that has a
 * default. One call, at the very top of every entry point, before any task module is
 * required (AGENTS.md gotcha 79).
 *
 * @returns {{applied: boolean, dir: string}} The result of applySeriesLocationDefault().
 */
function bootstrapEnv() {
  loadEnv();
  return applySeriesLocationDefault();
}

module.exports = {
  projectRoot,
  DEFAULT_SERIES_DIR_NAME,
  defaultSeriesLocation,
  loadEnv,
  applySeriesLocationDefault,
  bootstrapEnv,
  chosenSeriesLocation,
};

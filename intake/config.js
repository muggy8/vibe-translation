/**
 * The names the plan of record is written under, the discovery step's budgets, and
 * the floors the objective checks use.
 *
 * MANIFEST_SCHEMA is bumped when the shape changes so an old plan is never reused as a
 * new one. VOLUME_ARTIFACT_FILES / VOLUME_ARTIFACT_PATTERNS are how the intake tells
 * 'this folder already holds pipeline output' — renaming such a folder would orphan
 * everything built under the old name (gotcha 28). The DISCOVER_* / minVolumeTextChars
 * / artbookMaxTextChars readers are the .env knobs, read per call so a test can pin one
 * without re-loading the module.
 *
 * Part of the get-translation-target.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions

/** File name of the manifest (the plan of record), relative to SERIES_LOCATION. */
const MANIFEST_FILE_NAME = "translation-target.json";

// The intake agent writes its plan under this name; it becomes the plan of
// record only after the code has validated it and promoted it. Writing straight
// to MANIFEST_FILE_NAME meant an intake run deleted a perfectly good plan of
// record up front — and if the agent then failed, the series was left with NO
// plan at all.
const DRAFT_MANIFEST_FILE_NAME = "translation-target.draft.json";


/** File name of the human-readable plan written next to it. */
const PLAN_FILE_NAME = "translation-plan.md";


/**
 * The manifest schema this code requires. A cached manifest with any other (or
 * missing) schema is stale and regenerated — how a series produced by the
 * older folder-name-only discovery upgrades itself.
 */
const MANIFEST_SCHEMA = 2;


/**
 * Step budget for the intake agent, scaled to how much there is to look at:
 * each candidate costs at least an epubInfo call and usually a text sample,
 * plus the staging calls and the two writes at the end. (Same lesson as
 * validatorMaxStepsFor — a fixed cap runs out on a big series.)
 */
const DISCOVERY_BASE_STEPS = 60;

const DISCOVERY_STEPS_PER_CANDIDATE = 6;


/** Delay between intake attempts (a fresh agent per attempt). */
const DISCOVERY_RETRY_DELAY_MS = 10000;


/**
 * Exact file names that mark a volume folder as already worked on. Used to
 * protect a folder name from being renamed by a re-run (renaming it would
 * orphan everything already written inside it).
 */
const VOLUME_ARTIFACT_FILES = [
  "glossary.md",
  "character-voice.md",
  "style-guide.md",
  "wiki.md",
  "shared-wiki.md",
  "pov-map.md",
  "chapters.json",
  "translation.md",
  "translation-state.json",
  "translation-brief.md",
  "consistency-report.md",
];


/** Name patterns for the same idea (per-chapter and per-stage outputs). */
const VOLUME_ARTIFACT_PATTERNS = [
  /^translation(-.+)?\.(md|json)$/,
  /^polished-.+\.md$/,
  /^polish-qa\.md$/,
  /^polish-verification\.json$/,
  /^glossary-(research|coverage|new-terms)\.(md|json)$/,
  /^.*-rolling-state\.json$/,
  /^character-voice-(new|validation)\.(md|json)$/,
  /^style-guide-(new|validation)\.(md|json)$/,
  /^wiki-.*\.md$/,
  /^.*-validation.*\.md$/,
  /^.*-coverage\.(md|json)$/,
  /^.*-bundle\.meta\.json$/,
  /^.*-whole\.md$/,
  /^.*-ch\d+(\.\d+)?\.md$/,
];


/**
 * True when a file name is pipeline output rather than a source file.
 * @param {string} name - A file name.
 * @returns {boolean}
 */
function isVolumeArtifact(name) {
  if (VOLUME_ARTIFACT_FILES.includes(name)) return true;
  return VOLUME_ARTIFACT_PATTERNS.some((re) => re.test(name));
}

// ─── .env knobs ─────────────────────────────────────────────────────────────


/** How many text characters the intake agent may read per sample call. */
function discoverSampleChars() {
  const n = parseInt(process.env.DISCOVER_SAMPLE_CHARS, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 6000) : 1500;
}


/**
 * The lowest confidence the intake agent may report before the run refuses to
 * start (0 disables the gate). A wrong reading order poisons every cumulative
 * artifact, so an unsure plan is worth stopping for.
 * @returns {number}
 */
function discoverMinConfidence() {
  const n = parseFloat(process.env.DISCOVER_MIN_CONFIDENCE);
  return Number.isFinite(n) ? Math.max(0, Math.min(n, 1)) : 0.6;
}


/** DISCOVER_STRICT=true turns a disagreement with the existing folder layout
 * into an error instead of a warn-and-keep (it fails the step immediately — a
 * retry cannot make the agent respect a policy). */
function discoverStrict() {
  return String(process.env.DISCOVER_STRICT || "").trim().toLowerCase() === "true";
}


/** Intake attempts before the task fails (a fresh agent per attempt). */
function discoverMaxAttempts() {
  const n = parseInt(
    process.env.DISCOVER_MAX_ATTEMPTS ?? process.env.DISCOVERY_MAX_ATTEMPTS,
    10
  );
  return Number.isFinite(n) && n > 0 ? n : 2;
}

// ─── The committed layout (what the pipeline already built) ─────────────────

/**
 * @typedef {Object} CommittedVolumeDir
 * An existing folder under the series location.
 * @property {string} folder                — The folder name.
 * @property {boolean} hasPipelineOutput    — True when it already holds generated artifacts.
 * @property {Array<{file: string, sha256: string}>} sources — Source-like files staged inside it.
 */


/**
 * The absolute floor for "this file contains a readable text at all".
 *
 * NOT a story-length rule — "is this a real narrative?" is answered by the
 * intake agent reading it (see validateVolumeIntegrity). This number only
 * catches the objective case: a few hundred characters means binary junk, an
 * empty archive, or a stub, whatever the agent believed.
 *
 * Read from .env (DISCOVER_MIN_VOLUME_TEXT_CHARS, default 1000).
 *
 * @returns {number}
 */
function minVolumeTextChars() {
  const n = parseInt(process.env.DISCOVER_MIN_VOLUME_TEXT_CHARS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}


/**
 * How thin a book's prose has to be before the archive's composition is allowed
 * to override the intake agent's judgment with "this is an art book".
 *
 * NOT a length rule for volumes — a real volume sits far above it (observed: a
 * 17-volume series whose books run 128k–176k characters each). It is only the
 * ceiling under which an image-dominated archive may be rejected.
 *
 * Read from .env (DISCOVER_ARTBOOK_MAX_TEXT_CHARS, default 20000).
 *
 * @returns {number}
 */
function artbookMaxTextChars() {
  const n = parseInt(process.env.DISCOVER_ARTBOOK_MAX_TEXT_CHARS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 20000;
}


module.exports = {
  MANIFEST_FILE_NAME,
  DRAFT_MANIFEST_FILE_NAME,
  PLAN_FILE_NAME,
  MANIFEST_SCHEMA,
  DISCOVERY_BASE_STEPS,
  DISCOVERY_STEPS_PER_CANDIDATE,
  DISCOVERY_RETRY_DELAY_MS,
  VOLUME_ARTIFACT_FILES,
  VOLUME_ARTIFACT_PATTERNS,
  isVolumeArtifact,
  discoverSampleChars,
  discoverMinConfidence,
  discoverStrict,
  discoverMaxAttempts,
  minVolumeTextChars,
  artbookMaxTextChars,
};

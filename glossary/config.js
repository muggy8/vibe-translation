/**
 * The task's settings and prompt-file paths, read once at module load.
 *
 * Task modules read SERIES_LOCATION at load time, which is why every test that
 * exercises a whole task spawns a child process per task.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types"); // JSDoc type definitions
const projectRoot = path.resolve(__dirname, "..");

const clientDir = projectRoot;

const seriesDir = process.env.SERIES_LOCATION;


const termsSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-terms.md");

const termsUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-terms.md");

const acceptanceSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-acceptance.md");

const acceptanceUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-acceptance.md");

// The glossary stage grades once. `QA_MAX_ITERATIONS` belongs to the stages that rewrite an artifact
// between grades (the style guide, the wiki); this stage renders its artifact out of the volume's record,
// so a second iteration would re-audit and re-grade a document that cannot have changed. The iteration
// count is a constant in `glossary/qa.js`, not a setting, for the same reason AGENTS.md rule 3 gives for
// every other guard: a number a run can raise is a number a run will raise to make a bad grade go away.


// Whether to run web research for the new terms (default: enabled).
const researchEnabled = process.env.RESEARCH_ENABLED !== "false";

// ── Context window protection ────────────────────────────────────────────────


/**
 * When the previous glossary exceeds this size (bytes), truncate it to the
 * most recent entries so the author/validator agents don't overflow the
 * context window. The glossary is cumulative, so earlier entries are
 * carried forward unchanged — only conflicts with new terms need checking.
 *
 * @type {number}
 */
const GLOSSARY_TRUNCATION_THRESHOLD = 64 * 1024; // 64KB


/**
 * Maximum number of glossary entries to include when truncating.
 *
 * @type {number}
 */
const GLOSSARY_TRUNCATION_MAX_ENTRIES = 200;

// ─── Helpers ────────────────────────────────────────────────────────────────


module.exports = {
  clientDir,
  seriesDir,
  termsSystemPromptFile,
  termsUserPromptTemplateFile,
  acceptanceSystemPromptFile,
  acceptanceUserPromptTemplateFile,
  researchEnabled,
  GLOSSARY_TRUNCATION_THRESHOLD,
  GLOSSARY_TRUNCATION_MAX_ENTRIES,
};

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

const glossarySystemPromptFile = path.join(clientDir, "system-prompts", "glossary.md");

const glossaryUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary.md");

const validatorSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-validator.md");

const validatorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-validator.md");

const acceptanceSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-acceptance.md");

const acceptanceUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-acceptance.md");

const feedbackSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-feedback.md");

const feedbackUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-feedback.md");


// Maximum number of validation -> acceptance -> feedback iterations per volume
// before the glossary is left as-is. Read from .env, defaulting to 3.
const maxValidationIterations = Math.max(
  1,
  parseInt(process.env.QA_MAX_ITERATIONS, 10) || 3
);


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
  glossarySystemPromptFile,
  glossaryUserPromptTemplateFile,
  validatorSystemPromptFile,
  validatorUserPromptTemplateFile,
  acceptanceSystemPromptFile,
  acceptanceUserPromptTemplateFile,
  feedbackSystemPromptFile,
  feedbackUserPromptTemplateFile,
  maxValidationIterations,
  researchEnabled,
  GLOSSARY_TRUNCATION_THRESHOLD,
  GLOSSARY_TRUNCATION_MAX_ENTRIES,
};

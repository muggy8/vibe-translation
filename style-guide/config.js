/**
 * Prompt-file locations, the QA iteration cap, and the truncation window for the injected guide. clientDir is the project root.
 *
 * Part of the style-guide.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types");
const { selectSectionsByRelevance } = require("../utils/prompt");
const projectRoot = path.resolve(__dirname, "..");

const clientDir = projectRoot;

const seriesDir = process.env.SERIES_LOCATION;


// Context-window protection for the cumulative guide: same threshold as the
// glossary / voice reference (the guide is cumulative in exactly the same way).
const STYLE_GUIDE_TRUNCATION_THRESHOLD = 64 * 1024;

const STYLE_GUIDE_TRUNCATION_MAX_SECTIONS = 40;


/**
 * Truncate a style guide to its most recent `## ` sections when it exceeds the
 * threshold. The guide is cumulative, so older policies are carried forward
 * unchanged in the file itself — the newest sections are where a new construct
 * would conflict.
 *
 * (The glossary and voice reference have had truncators since their inception;
 * the style guide is cumulative in exactly the same way and had none.)
 *
 * @param {string} content - The full style-guide content.
 * @returns {string} The (possibly truncated) content.
 */
function truncateStyleGuide(content, sourceText) {
  if (!content || content.length <= STYLE_GUIDE_TRUNCATION_THRESHOLD) return content;
  // Relevance-ordered (see selectSectionsByRelevance in utils/prompt.js): a
  // section whose quoted source-language pattern occurs in the volume being
  // processed is kept whatever its position, so the honorific rules decided in
  // volume 1 are not dropped just because they were written first.
  const picked = selectSectionsByRelevance({
    content,
    headingRe: /^##[ \t]+/m,
    sourceText,
    maxUnits: STYLE_GUIDE_TRUNCATION_MAX_SECTIONS,
    unitLabel: "section(s)",
  });
  return picked.content;
}


const extractSystemPromptFile = path.join(clientDir, "system-prompts", "style-guide-extract.md");

const extractUserPromptTemplateFile = path.join(clientDir, "user-prompts", "style-guide-extract.md");

const authorSystemPromptFile = path.join(clientDir, "system-prompts", "style-guide.md");

const authorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "style-guide.md");

const validatorSystemPromptFile = path.join(clientDir, "system-prompts", "style-guide-validator.md");

const validatorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "style-guide-validator.md");

const acceptanceSystemPromptFile = path.join(clientDir, "system-prompts", "style-guide-acceptance.md");

const acceptanceUserPromptTemplateFile = path.join(clientDir, "user-prompts", "style-guide-acceptance.md");

const feedbackSystemPromptFile = path.join(clientDir, "system-prompts", "style-guide-feedback.md");

const feedbackUserPromptTemplateFile = path.join(clientDir, "user-prompts", "style-guide-feedback.md");


const maxValidationIterations = Math.max(1, parseInt(process.env.QA_MAX_ITERATIONS, 10) || 10);

// ─── Cumulative-document rules (the same shape glossary.js established) ───────
//
// The style guide is cumulative and grows volume by volume, so it hits the same
// wall the glossary did (AGENTS.md gotcha 64) and the character-voice reference
// was about to hit: "writeFile, complete contents" becomes impossible, the agent
// pages the file, runs out of steps, and rebuilds the document from memory. The
// stage carried a flat `maxSteps: 30` for its author and feedback agents — the
// same flat cap that stopped volume 01's character-voice feedback turn at 46 tool
// calls with zero writes.


module.exports = {
  clientDir,
  seriesDir,
  STYLE_GUIDE_TRUNCATION_THRESHOLD,
  STYLE_GUIDE_TRUNCATION_MAX_SECTIONS,
  truncateStyleGuide,
  extractSystemPromptFile,
  extractUserPromptTemplateFile,
  authorSystemPromptFile,
  authorUserPromptTemplateFile,
  validatorSystemPromptFile,
  validatorUserPromptTemplateFile,
  acceptanceSystemPromptFile,
  acceptanceUserPromptTemplateFile,
  feedbackSystemPromptFile,
  feedbackUserPromptTemplateFile,
  maxValidationIterations,
};

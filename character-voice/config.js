/**
 * Prompt-file locations, the QA iteration cap, and the truncation window for the injected voice reference. clientDir is the project root — a module in this folder reaches it through projectRoot, not through its own __dirname.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types");
const projectRoot = path.resolve(__dirname, "..");

const clientDir = projectRoot;

const seriesDir = process.env.SERIES_LOCATION;


const extractSystemPromptFile = path.join(clientDir, "system-prompts", "character-voice-extract.md");

const extractUserPromptTemplateFile = path.join(clientDir, "user-prompts", "character-voice-extract.md");

const authorSystemPromptFile = path.join(clientDir, "system-prompts", "character-voice.md");

const authorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "character-voice.md");

const validatorSystemPromptFile = path.join(clientDir, "system-prompts", "character-voice-validator.md");

const validatorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "character-voice-validator.md");

const acceptanceSystemPromptFile = path.join(clientDir, "system-prompts", "character-voice-acceptance.md");

const acceptanceUserPromptTemplateFile = path.join(clientDir, "user-prompts", "character-voice-acceptance.md");

const feedbackSystemPromptFile = path.join(clientDir, "system-prompts", "character-voice-feedback.md");

const feedbackUserPromptTemplateFile = path.join(clientDir, "user-prompts", "character-voice-feedback.md");


const maxValidationIterations = Math.max(1, parseInt(process.env.QA_MAX_ITERATIONS, 10) || 10);

const VOICE_REF_TRUNCATION_THRESHOLD = 64 * 1024;

const VOICE_REF_TRUNCATION_MAX_ENTRIES = 200;


module.exports = {
  clientDir,
  seriesDir,
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
  VOICE_REF_TRUNCATION_THRESHOLD,
  VOICE_REF_TRUNCATION_MAX_ENTRIES,
};

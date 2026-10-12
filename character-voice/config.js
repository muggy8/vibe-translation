/**
 * Prompt-file locations and the truncation window for the injected voice reference.
 * clientDir is the project root — a module in this folder reaches it through projectRoot, not through
 * its own __dirname.
 *
 * Two prompt pairs, because the stage asks the model two things: read one chapter, and grade the
 * rendered reference. The author, validator and feedback prompt files went with the route that used
 * them; the validator half of the gate is now queries against the volume's record, which make no call
 * and need no prompt. There is no QA iteration cap here either: the gate grades once, and a cap an
 * operator could raise on a stage with no rewrite pass is a knob on nothing.
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

const acceptanceSystemPromptFile = path.join(clientDir, "system-prompts", "character-voice-acceptance.md");

const acceptanceUserPromptTemplateFile = path.join(clientDir, "user-prompts", "character-voice-acceptance.md");


const VOICE_REF_TRUNCATION_THRESHOLD = 64 * 1024;

const VOICE_REF_TRUNCATION_MAX_ENTRIES = 200;


module.exports = {
  clientDir,
  seriesDir,
  extractSystemPromptFile,
  extractUserPromptTemplateFile,
  acceptanceSystemPromptFile,
  acceptanceUserPromptTemplateFile,
  VOICE_REF_TRUNCATION_THRESHOLD,
  VOICE_REF_TRUNCATION_MAX_ENTRIES,
};

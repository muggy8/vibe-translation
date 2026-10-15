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

/**
 * How much of a voice reference one call may be shown, in **characters**.
 *
 * Added by plan 06 slice 2 (2026-10-14) because the two limits above could not bound anything: the
 * picker's cap is a section count, a cumulative voice reference renders one `### ` section per roster
 * entry, and this series' roster is 196 entries — so a 351,771-byte reference came back from
 * `truncateVoiceRef` at 351,771 bytes with `dropped: 0` and `truncated: false`. A character budget is
 * the shape `utils/translate/references.js` has always used for exactly this reason.
 *
 * It is the same order as `character-voice/known-facts.js`'s block ceiling, so the layer has one answer
 * to "how much of a voice reference reaches a prompt". No environment knob (AGENTS.md rule 3).
 */
const VOICE_REF_TRUNCATION_MAX_CHARS = 24 * 1024;


module.exports = {
  clientDir,
  seriesDir,
  extractSystemPromptFile,
  extractUserPromptTemplateFile,
  acceptanceSystemPromptFile,
  acceptanceUserPromptTemplateFile,
  VOICE_REF_TRUNCATION_THRESHOLD,
  VOICE_REF_TRUNCATION_MAX_ENTRIES,
  VOICE_REF_TRUNCATION_MAX_CHARS,
};

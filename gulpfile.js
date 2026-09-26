/**
 * gulpfile.js — Gulp task registration for the ai-client.
 *
 * The "jump-in-wiki", "glossary", "character-voice" and "style-guide" task
 * logic lives in jump-in-wiki.js, glossary.js, character-voice.js and
 * style-guide.js respectively; this file only wires the tasks up to Gulp.
 *
 * Usage:
 *   npx gulp jump-in-wiki             # run the full task
 *   npx gulp jump-in-wiki --dry-run   # transform the prompt only, no API call
 *   npx gulp jump-in-wiki --force     # regenerate even if already processed
 *   npx gulp glossary                 # build the canonical glossary
 *   npx gulp glossary --dry-run       # transform the prompts only, no API/research
 *   npx gulp glossary --force         # regenerate even if the glossary exists
 *   npx gulp character-voice          # build the character voice reference
 *   npx gulp style-guide              # build the style guide
 *   npx gulp <task> --chunked         # force the chapter-by-chapter fallback for
 *                                     # multi-chapter epub volumes (the default is
 *                                     # whole-installment processing; the fallback
 *                                     # also triggers automatically when the whole
 *                                     # text exceeds SOURCE_CHUNK_THRESHOLD_CHARS)
 *   (default task)                     # all four in order:
 *                                     # glossary -> character-voice -> style-guide -> jump-in-wiki
 */

const { series } = require("gulp");
const { jumpInWiki } = require("./jump-in-wiki");
const { glossary } = require("./glossary");
const { characterVoice } = require("./character-voice");
const { styleGuide } = require("./style-guide");

exports["jump-in-wiki"] = jumpInWiki;
exports.glossary = glossary;
exports["character-voice"] = characterVoice;
exports["style-guide"] = styleGuide;
exports.default = series(glossary, characterVoice, styleGuide, jumpInWiki);

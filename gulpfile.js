/**
 * gulpfile.js — Gulp task registration for the ai-client.
 *
 * The "jump-in-wiki" task logic lives in jump-in-wiki.js and the "glossary"
 * task logic lives in glossary.js; this file only wires the tasks up to Gulp.
 *
 * Usage:
 *   npx gulp jump-in-wiki             # run the full task
 *   npx gulp jump-in-wiki --dry-run   # transform the prompt only, no API call
 *   npx gulp jump-in-wiki --force     # regenerate even if already processed
 *   npx gulp glossary                 # build the canonical glossary
 *   npx gulp glossary --dry-run       # transform the prompts only, no API/research
 *   npx gulp glossary --force         # regenerate even if the glossary exists
 */

const { series } = require("gulp");
const { jumpInWiki } = require("./jump-in-wiki");
const { glossary } = require("./glossary");

exports["jump-in-wiki"] = jumpInWiki;
exports.glossary = glossary;
exports.default = series(glossary, jumpInWiki);

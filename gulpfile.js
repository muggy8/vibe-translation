/**
 * gulpfile.js — Gulp task registration for the ai-client.
 *
 * The "jump-in-wiki" task logic lives in jump-in-wiki.js; this file only
 * wires the task up to Gulp.
 *
 * Usage:
 *   npx gulp jump-in-wiki             # run the full task
 *   npx gulp jump-in-wiki --dry-run   # transform the prompt only, no API call
 */

const { jumpInWiki } = require("./jump-in-wiki");

exports["jump-in-wiki"] = jumpInWiki;
exports.default = jumpInWiki;
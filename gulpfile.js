/**
 * gulpfile.js — Gulp task registration for the ai-client.
 *
 * The "jump-in-wiki", "glossary", "character-voice" and "style-guide" task
 * logic lives in jump-in-wiki.js, glossary.js, character-voice.js and
 * style-guide.js respectively; this file only wires the tasks up to Gulp.
 *
 * Each step is wrapped with withHooks() so an optional per-machine hook
 * (hooks/pre-<task> / hooks/post-<task>, git-style — see hooks/README.md)
 * can run before and after it. With no hooks/ directory the pipeline runs
 * exactly as before (hooks are a no-op). The default (all-four) run is
 * additionally wrapped as the "pipeline" pseudo-step (pre-/post-pipeline).
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
const { withHooks, PIPELINE_TASK } = require("./utils/hooks");

// Wrap each step so its optional per-machine hooks fire around it. The task
// functions themselves are unchanged — the hook runner (utils/hooks.js) does
// all the discovery/execution.
const glossaryTask = withHooks("glossary", glossary);
const characterVoiceTask = withHooks("character-voice", characterVoice);
const styleGuideTask = withHooks("style-guide", styleGuide);
const jumpInWikiTask = withHooks("jump-in-wiki", jumpInWiki);

exports["jump-in-wiki"] = jumpInWikiTask;
exports.glossary = glossaryTask;
exports["character-voice"] = characterVoiceTask;
exports["style-guide"] = styleGuideTask;
// The whole default run also fires pre-pipeline / post-pipeline around all four.
exports.default = withHooks(
  PIPELINE_TASK,
  series(glossaryTask, characterVoiceTask, styleGuideTask, jumpInWikiTask)
);

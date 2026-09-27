/**
 * gulpfile.js — Gulp task registration for the ai-client.
 *
 * The "jump-in-wiki", "glossary", "character-voice", "style-guide" and
 * "consistency-audit" task logic lives in jump-in-wiki.js, glossary.js,
 * character-voice.js, style-guide.js and consistency-audit.js respectively;
 * this file only wires the tasks up to Gulp.
 *
 * Each step is wrapped with withHooks() so an optional per-machine hook
 * (hooks/pre-<task> / hooks/post-<task>, git-style — see hooks/README.md)
 * can run before and after it. With no hooks/ directory the pipeline runs
 * exactly as before (hooks are a no-op). The default (all-five) run is
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
 *   npx gulp consistency-audit        # final cross-artifact consistency audit
 *   npx gulp consistency-audit --force  # re-audit even if the report is fresh
 *   npx gulp <task> --chunked         # force the chapter-by-chapter fallback for
 *                                     # multi-chapter epub volumes (the default is
 *                                     # whole-installment processing; the fallback
 *                                     # also triggers automatically when the whole
 *                                     # text exceeds SOURCE_CHUNK_THRESHOLD_CHARS)
 *   (default task)                     # all five in order:
 *                                     # glossary -> character-voice -> style-guide ->
 *                                     # jump-in-wiki -> consistency-audit
 *                                     # (a failing step aborts the run by default;
 *                                     # ON_TASK_ERROR=continue in .env lets the
 *                                     # remaining steps run for un-monitored runs)
 */

require("dotenv").config();
const { jumpInWiki } = require("./jump-in-wiki");
const { glossary } = require("./glossary");
const { characterVoice } = require("./character-voice");
const { styleGuide } = require("./style-guide");
const { consistencyAudit } = require("./consistency-audit");
const { withHooks, PIPELINE_TASK } = require("./utils/hooks");

// Wrap each step so its optional per-machine hooks fire around it. The task
// functions themselves are unchanged — the hook runner (utils/hooks.js) does
// all the discovery/execution.
const glossaryTask = withHooks("glossary", glossary);
const characterVoiceTask = withHooks("character-voice", characterVoice);
const styleGuideTask = withHooks("style-guide", styleGuide);
const jumpInWikiTask = withHooks("jump-in-wiki", jumpInWiki);
const consistencyAuditTask = withHooks("consistency-audit", consistencyAudit);

/**
 * The five pipeline steps in run order (step name + hooked task function).
 * @type {Array<{name: string, run: Function}>}
 */
const PIPELINE_STEPS = [
  { name: "glossary", run: glossaryTask },
  { name: "character-voice", run: characterVoiceTask },
  { name: "style-guide", run: styleGuideTask },
  { name: "jump-in-wiki", run: jumpInWikiTask },
  { name: "consistency-audit", run: consistencyAuditTask },
];

/**
 * Run the default pipeline with the ON_TASK_ERROR policy (front-loaded in
 * .env for un-monitored runs):
 *   - "abort" (default): legacy gulp series() behavior — the first failing
 *     step stops the run.
 *   - "continue": a failing step is logged and the remaining steps still run
 *     (a glossary hiccup must not prevent the wiki for a 17-volume overnight
 *     run); once every step has been attempted, the run fails with a summary
 *     of all failed steps so `npx gulp` exits non-zero.
 * Each step's own before/after hooks still fire (they are part of the wrapped
 * task functions).
 *
 * @returns {Promise<void>}
 */
async function runPipeline() {
  const onTaskError = String(process.env.ON_TASK_ERROR || "abort")
    .trim()
    .toLowerCase();
  const failures = [];
  for (const step of PIPELINE_STEPS) {
    try {
      await step.run();
    } catch (err) {
      failures.push({ name: step.name, error: err });
      if (onTaskError !== "continue") throw err;
      console.error(
        `[pipeline] ${step.name} failed: ${err.message} — continuing with ` +
          `the remaining steps (ON_TASK_ERROR=continue).`
      );
    }
  }
  if (failures.length > 0) {
    const summary = failures
      .map((f) => `${f.name} (${f.error.message})`)
      .join("; ");
    throw new Error(
      `Pipeline finished with ${failures.length} failed step(s): ${summary}. ` +
        `See .logs/ for details; re-run the pipeline (idempotent) to pick up ` +
        `the failed steps.`
    );
  }
}

exports["jump-in-wiki"] = jumpInWikiTask;
exports.glossary = glossaryTask;
exports["character-voice"] = characterVoiceTask;
exports["style-guide"] = styleGuideTask;
exports["consistency-audit"] = consistencyAuditTask;
// The whole default run also fires pre-pipeline / post-pipeline around all five.
exports.default = withHooks(PIPELINE_TASK, runPipeline);

/**
 * gulpfile.js — Gulp task registration for the ai-client.
 *
 * The "jump-in-wiki", "glossary", "character-voice", "style-guide",
 * "consistency-audit" task logic lives in jump-in-wiki.js, glossary.js,
 * character-voice.js, style-guide.js and consistency-audit.js; the
 * translation stage ("translate", "verify-translate", "retranslate",
 * "polish") lives in translate.js, verify-translate.js, retranslate.js and
 * polish.js. This file only wires the tasks up to Gulp.
 *
 * Each step is wrapped with withHooks() so an optional per-machine hook
 * (hooks/pre-<task> / hooks/post-<task>, git-style — see hooks/README.md)
 * can run before and after it. With no hooks/ directory the pipeline runs
 * exactly as before (hooks are a no-op). On local multi-model setups the
 * translation steps' hooks are what start/stop the model containers (the
 * tasks only check the endpoint via a /v1/models sanity call). The default
 * run is additionally wrapped as the "pipeline" pseudo-step
 * (pre-/post-pipeline).
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
 *   npx gulp translate                # translate all volumes (Hy-MT2, per chapter)
 *   npx gulp verify-translate         # source-anchored verification (Qwen, per chapter)
 *   npx gulp retranslate              # retranslate the FAILED chapters (Hy-MT2)
 *   npx gulp translate-qa             # the QA loop: verify batch -> retranslate
 *                                     # batch, repeated until every chapter passes
 *                                     # (or a round retranslates nothing / the
 *                                     # TRANSLATE_QA_MAX_ROUNDS limit is hit)
 *   npx gulp polish                   # final polish pass (Qwen, per chapter)
 *   npx gulp <task> --chunked         # force the chapter-by-chapter fallback for
 *                                     # multi-chapter epub volumes (the default is
 *                                     # whole-installment processing; the fallback
 *                                     # also triggers automatically when the whole
 *                                     # text exceeds SOURCE_CHUNK_THRESHOLD_CHARS)
 *   npx gulp discover               # series intake only: explore SERIES_LOCATION,
 *                                     decide the series name / source language /
 *                                     volume order, lay out the volume folders,
 *                                     and write translation-target.json +
 *                                     translation-plan.md (the plan of record)
 *   npx gulp <task> --chunked         # force the chapter-by-chapter fallback for
 *                                     multi-chapter epub volumes (the default is
 *                                     whole-installment processing; the fallback
 *                                     also triggers automatically when the whole
 *                                     text exceeds SOURCE_CHUNK_THRESHOLD_CHARS)
 *   (default task)                     # all nine in order:
 *                                     # discover -> glossary -> character-voice ->
 *                                     # style-guide -> jump-in-wiki ->
 *                                     # consistency-audit -> translate ->
 *                                     # translate-qa -> polish
 *                                     # (translate-qa loops verify -> retranslate
 *                                     # until every chapter passes — see
 *                                     # translate-qa.js)
 *                                     # (a failing step aborts the run by default;
 *                                     # ON_TASK_ERROR=continue in .env lets the
 *                                     # remaining steps run for un-monitored runs)
 */

require("dotenv").config();
const { discoverSeries } = require("./get-translation-target");
const { jumpInWiki } = require("./jump-in-wiki");
const { glossary } = require("./glossary");
const { characterVoice } = require("./character-voice");
const { styleGuide } = require("./style-guide");
const { consistencyAudit } = require("./consistency-audit");
const { translate } = require("./translate");
const { verifyTranslate } = require("./verify-translate");
const { retranslate } = require("./retranslate");
const { translateQa } = require("./translate-qa");
const { polish } = require("./polish");
const { withHooks, PIPELINE_TASK } = require("./utils/hooks");

// Wrap each step so its optional per-machine hooks fire around it. The task
// functions themselves are unchanged — the hook runner (utils/hooks.js) does
// all the discovery/execution.

/**
 * The "discover" step (step 0): the series intake agent explores
 * SERIES_LOCATION, decides the series name, the source language, which files
 * are volumes and in what order, lays out the volume folders, and writes the
 * plan of record (translation-target.json) plus translation-plan.md that every
 * other step reads. Run it on its own to review a plan before an overnight run.
 */
async function discover() {
  await discoverSeries({
    force: process.argv.includes("--force"),
    dryRun: process.argv.includes("--dry-run"),
  });
}

const discoverTask = withHooks("discover", discover);
const glossaryTask = withHooks("glossary", glossary);
const characterVoiceTask = withHooks("character-voice", characterVoice);
const styleGuideTask = withHooks("style-guide", styleGuide);
const jumpInWikiTask = withHooks("jump-in-wiki", jumpInWiki);
const consistencyAuditTask = withHooks("consistency-audit", consistencyAudit);
const translateTask = withHooks("translate", translate);
const verifyTranslateTask = withHooks("verify-translate", verifyTranslate);
const retranslateTask = withHooks("retranslate", retranslate);
const translateQaTask = withHooks("translate-qa", translateQa);
const polishTask = withHooks("polish", polish);

/**
 * The pipeline steps in run order (step name + hooked task function).
 * "discover" is step 0: it produces the plan of record every other step reads,
 * so a plain `npx gulp` needs nothing but SERIES_LOCATION in .env.
 * The translation QA stage (translate-qa) loops verify-translate →
 * retranslate until every chapter passes verification, until a round
 * retranslates nothing (stalled), or until TRANSLATE_QA_MAX_ROUNDS is
 * reached — each round is two single-model batches, so the local model
 * containers only switch at batch boundaries (the idempotent skips make
 * round N+1 re-check only the chapters round N retranslated).
 * @type {Array<{name: string, run: Function}>}
 */
const PIPELINE_STEPS = [
  { name: "discover", run: discoverTask },
  { name: "glossary", run: glossaryTask },
  { name: "character-voice", run: characterVoiceTask },
  { name: "style-guide", run: styleGuideTask },
  { name: "jump-in-wiki", run: jumpInWikiTask },
  { name: "consistency-audit", run: consistencyAuditTask },
  // Translation stage (multi-model: translate/retranslate on the Hy-MT2
  // endpoint, verify/polish on the Qwen endpoint — see the TRANSLATE_,
  // VERIFY_, and EDIT_ env prefixes).
  { name: "translate", run: translateTask },
  { name: "translate-qa", run: translateQaTask },
  { name: "polish", run: polishTask },
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

exports.discover = discoverTask;
exports["jump-in-wiki"] = jumpInWikiTask;
exports.glossary = glossaryTask;
exports["character-voice"] = characterVoiceTask;
exports["style-guide"] = styleGuideTask;
exports["consistency-audit"] = consistencyAuditTask;
exports.translate = translateTask;
exports["verify-translate"] = verifyTranslateTask;
exports.retranslate = retranslateTask;
exports["translate-qa"] = translateQaTask;
exports.polish = polishTask;
// The whole default run also fires pre-pipeline / post-pipeline around all eight.
exports.default = withHooks(PIPELINE_TASK, runPipeline);

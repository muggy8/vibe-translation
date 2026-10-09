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
 *   npx gulp translate                # translate all volumes (Index-Translate, per chapter)
 *   npx gulp verify-translate         # source-anchored verification (Qwen, per chapter)
 *   npx gulp retranslate              # retranslate the FAILED chapters (Index-Translate)
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

// .env, then the one setting that has a default — both before any task module is
// required, because several of them read these values at require time (AGENTS.md gotcha 79).
require("./configs/env-defaults").bootstrapEnv();
const fs = require("fs");
const path = require("path");
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
const { writeTranslationReport } = require("./utils/translation-report");
const { getTranslationTarget } = require("./get-translation-target");
const { withHooks, PIPELINE_TASK } = require("./utils/hooks");
const { isStructuralError } = require("./configs/shared");
const { postMortemDir } = require("./utils/postmortem");
const { acquireRunLock, releaseRunLock, runLockPath } = require("./utils/runlock");
const { installShutdownWatch } = require("./utils/shutdown");

/**
 * Record a structural failure where a separate process can read it.
 *
 * `isStructuralError` is an in-process flag (`err.structural === true`). When a
 * step runs in its own process — which is how index.js runs the pipeline — the
 * error object cannot cross the boundary, and the "a structural failure is never
 * continued past" rule (gotcha 21) would have to be guessed from an exit code or
 * from error text. Guessing from text is the pattern gotcha 55 exists to prevent.
 *
 * So the wrapper writes the marker before rethrowing, and index.js reads it. The
 * marker is one of the run's own records, under its records folder next to the series
 * (`<SERIES_LOCATION>/.run/postmortem/` — configs/run-state.js), and index.js deletes it
 * before each step so a step can only report its own outcome.
 *
 * @param {string} name - The step name.
 * @param {Function} taskFn - The original (async) gulp task function.
 * @returns {Function} A drop-in async gulp task that records structural failures.
 */
function withStructuralMarker(name, taskFn) {
  return async function marked(...args) {
    try {
      return await taskFn(...args);
    } catch (err) {
      if (isStructuralError(err)) {
        try {
          const dir = postMortemDir();
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            path.join(dir, "last-structural-failure.json"),
            JSON.stringify(
              { step: name, message: err.message, at: new Date().toISOString() },
              null,
              2
            ),
            "utf8"
          );
        } catch (writeErr) {
          console.error(
            `[gulp] could not record the structural failure from ${name}: ${writeErr.message}`
          );
        }
      }
      throw err;
    }
  };
}


// ─── The run lock ─────────────────────────────────────────────────────────────

/**
 * Refuse to start a step while another run is already writing the same series.
 *
 * Every task is wrapped, because "a run is in progress" is not a property of the runner —
 * `npx gulp glossary` typed at a terminal while an overnight run is working is exactly the
 * collision, and it is invisible afterwards: the artifact ends half-built by one process and
 * half by the other, and every check that asks "is the file there?" says yes.
 *
 * The lock sits OUTSIDE the hooks on purpose: a refusal should happen before a pre-hook has
 * switched a model container in (gotcha 22 — a container switch is the most expensive thing
 * in this pipeline, and a step that never runs should not have paid for one).
 *
 * Two directions:
 *   - A lock held by a live process elsewhere is a refusal. That is the point of the file.
 *   - A lock file that cannot be written is a warning, not a failure. A bookkeeping file must
 *     not be the reason a 12-hour run dies; the manager (delivery.js) is the one that treats
 *     "I cannot tell" as "no", because deciding whether it is safe to act is its whole job.
 *
 * Nesting is counted, so the default run holds one lock across its nine in-process steps, and
 * a gulp child spawned by index.js inherits its parent's run id through `INDEX_RUN_ID` and
 * joins that lock instead of competing with it.
 *
 * @param {string} name - The step name, for the message.
 * @param {Function} taskFn - The wrapped task.
 * @returns {Function} A drop-in async gulp task.
 */
function withRunLock(name, taskFn) {
  return async function locked(...args) {
    const lock = acquireRunLock({ by: `gulp ${name}` });
    if (!lock.acquired && lock.lock) {
      throw new Error(
        `refusing to run ${name}: ${lock.note || "a pipeline run is already in progress"}. ` +
          `Two processes writing the same volume folder is how an artifact ends half-built by ` +
          `one and half by the other. If that run is not actually running, remove ` +
          `${runLockPath()}. Two DIFFERENT series no longer collide — the lock lives in each ` +
          `series' own records folder — so this refusal means two runs of the SAME series.`
      );
    }
    if (!lock.acquired) console.error(`[gulp] warning: ${lock.note}`);
    else if (lock.note) console.log(`[gulp] ${lock.note}`);
    // A gulp task run on its own holds the lock, and Node does not run a `finally` when a signal
    // ends the process. Without this, `kill <pid>` / a container stop leaves the claim held by a
    // pid that no longer exists only after the task's own writes stop mid-file (utils/shutdown.js).
    installShutdownWatch({ label: `gulp ${name}`, onStop: () => releaseRunLock() });
    try {
      return await taskFn(...args);
    } finally {
      releaseRunLock();
    }
  };
}


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

// Each step is wrapped three times: the run lock on the outside (so a collision is refused
// before a hook switches a model container in), the hook runner next, and the structural
// marker on the inside (closest to the error, so it records the failure the task module
// actually threw).
const discoverTask = withRunLock("discover", withHooks("discover", withStructuralMarker("discover", discover)));
const glossaryTask = withRunLock("glossary", withHooks("glossary", withStructuralMarker("glossary", glossary)));
const characterVoiceTask = withRunLock(
  "character-voice",
  withHooks("character-voice", withStructuralMarker("character-voice", characterVoice))
);
const styleGuideTask = withRunLock("style-guide", withHooks("style-guide", withStructuralMarker("style-guide", styleGuide)));
const jumpInWikiTask = withRunLock("jump-in-wiki", withHooks("jump-in-wiki", withStructuralMarker("jump-in-wiki", jumpInWiki)));
const consistencyAuditTask = withRunLock(
  "consistency-audit",
  withHooks("consistency-audit", withStructuralMarker("consistency-audit", consistencyAudit))
);
const translateTask = withRunLock("translate", withHooks("translate", withStructuralMarker("translate", translate)));
const verifyTranslateTask = withRunLock(
  "verify-translate",
  withHooks("verify-translate", withStructuralMarker("verify-translate", verifyTranslate))
);
const retranslateTask = withRunLock("retranslate", withHooks("retranslate", withStructuralMarker("retranslate", retranslate)));
const translateQaTask = withRunLock("translate-qa", withHooks("translate-qa", withStructuralMarker("translate-qa", translateQa)));
const polishTask = withRunLock("polish", withHooks("polish", withStructuralMarker("polish", polish)));

/**
 * The "translation-report" step: rebuild the series-level translation report
 * (translation-report.md + .json) from the verdict files the translation tasks
 * already wrote. Deterministic, no AI, no model calls — run it any time to see
 * what is verified, what is published unverified, and what is missing.
 */
async function translationReportStep() {
  const dryRun = process.argv.includes("--dry-run");
  const seriesDir = process.env.SERIES_LOCATION;
  if (!seriesDir) throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  const manifest = await getTranslationTarget({ dryRun });
  await writeTranslationReport({ seriesDir, manifest, volumes: null, dryRun });
}

const translationReportTask = withRunLock(
  "translation-report",
  withHooks("translation-report", withStructuralMarker("translation-report", translationReportStep))
);

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
  // Translation stage (multi-model: translate/retranslate on the Index-Translate
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
 * A STRUCTURAL failure is never continued past, whatever ON_TASK_ERROR says:
 * the remaining steps are guaranteed to fail on the same missing foundation
 * (no plan of record, no source file), and attempting them costs a model
 * container switch each. (Observed live: a rejected intake plan made all nine
 * steps re-run the intake — three attempts apiece — the last ones against the
 * translator container the translate hook had just switched in, which cannot
 * act as an agent and answered with nothing.)
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
      if (onTaskError !== "continue" || isStructuralError(err)) throw err;
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
        `See the run's log folder for details; re-run the pipeline (idempotent) to pick up ` +
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
exports["translation-report"] = translationReportTask;
// The whole default run also fires pre-pipeline / post-pipeline around all eight.
// The lock is the outermost layer: the default run holds it across all nine in-process
// steps, and the inner per-step wrappers join it rather than competing with it.
exports.default = withRunLock(PIPELINE_TASK, withHooks(PIPELINE_TASK, runPipeline));

/**
 * The steps in run order, exported for a runner that wants to drive them one at a
 * time instead of as one gulp series (index.js). `name` is the gulp task name, so
 * a runner can invoke the step as its own process and every per-machine hook still
 * fires. `exports.default` is the single-process runner — reading it does NOT give
 * a step list, which is the mistake this export exists to prevent.
 *
 * @type {Array<{name: string, run: Function}>}
 */
exports.PIPELINE_STEPS = PIPELINE_STEPS;

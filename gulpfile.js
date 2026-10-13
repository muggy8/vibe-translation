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
 *   npx gulp extract                # resolve every volume's source bundle, audit the
 *                                     # extraction (five deterministic checks), and write the
 *                                     # per-volume report + series summary into the run's
 *                                     # records. No model call. Re-verifies a warm cache
 *                                     # instead of re-extracting, and says which it did.
 *   (default task)                     # all ten in order:
 *                                     # discover -> extract -> glossary -> character-voice ->
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
const { extractVolumes } = require("./extract");
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
const { readRunArgs } = require("./utils/series-run");
const { evaluatePrerequisites, prerequisiteRefusal } = require("./utils/prereqs");
const { freezeDoorRow, evaluateFreeze, freezeRefusal } = require("./utils/prereqs/freeze");
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


// ─── The prerequisite gate ────────────────────────────────────────────────────

/**
 * Refuse to start a step whose foundation is not finished.
 *
 * The account owner's rule: pre-production → translation → polish, the reference artifacts are
 * frozen once the run is translating, and a step may not start before the steps it needs have run
 * and completed — including when a run is resumed days later. The order itself is declared data in
 * `utils/prereqs.js`; this is only the door.
 *
 * Where it sits in the wrapping, and why:
 *   - INSIDE `withRunLock`, because a collision is the more urgent refusal and a refusal should not
 *     be the reason a run's lock was taken and released for nothing.
 *   - OUTSIDE `withHooks`, because a step that never runs must not cost a model container switch
 *     (gotcha 22) and must not leave a post-hook describing work that never happened.
 *   - INSIDE `withStructuralMarker`, so the refusal reaches the parent process. A gulp child cannot
 *     hand an error object across the process boundary, and `index.js` decides "never continued
 *     past, whatever ON_TASK_ERROR says" from the marker the wrapper writes (gotcha 21). The gate
 *     itself writes nothing into the corpus and makes no model call; the marker is the run's own
 *     record, and `index.js` deletes it before every step.
 *
 * There is no flag that turns this off, and that is the owner's decision, not an omission:
 * `--force`, `--allow-fail`, `ON_TASK_ERROR=continue`, the ledger and the resume menu are not read
 * here at all. `--dry-run` is the one case that does not throw — a dry run exists to show you what
 * you are missing, so the verdict is printed and the step continues into its own offline path.
 *
 * @param {string} name - The gulp task name, which is the key in `utils/prereqs.js`.
 * @param {Function} taskFn - The wrapped task.
 * @returns {Function} A drop-in async gulp task.
 */
function withPrerequisiteGate(name, taskFn) {
  return async function gated(...args) {
    const { dryRun, volumeArg } = readRunArgs();
    const verdict = await evaluatePrerequisites({
      step: name,
      seriesDir: process.env.SERIES_LOCATION,
      volumeArg,
    });
    if (verdict.ok) return taskFn(...args);
    if (dryRun) {
      console.error(
        `[gate] ${name} — DRY RUN, so the prerequisite gate reports and does NOT refuse: ` +
          `${verdict.gaps.length} prerequisite(s) would not be complete.`
      );
      for (const bullet of verdict.bullets) console.error(`[gate]   - ${bullet}`);
      return taskFn(...args);
    }
    throw prerequisiteRefusal(verdict.message);
  };
}


// ─── The freeze gate ──────────────────────────────────────────────────────────

/**
 * Refuse to rewrite what a finished translation already consumed.
 *
 * The other half of the rule `withPrerequisiteGate` enforces. That gate asks whether a step may
 * START; this one asks whether a step may REBUILD something a published translation was built from.
 * The account owner's rule is one sentence — once the run is translating, the pre-production
 * artifacts are frozen, and a resumed run is no exception — and the start-gate cannot enforce the
 * second half of it: a resumed run happily prints "already accepted, skipping" for eight
 * translations built from a glossary that was rewritten underneath them.
 *
 * **This is the pre-flight half, and it is deliberately only the flag-shaped half.** It refuses what
 * is knowable before the step touches anything: `--force`, which cancels every volume's skip and so
 * rewrites every frozen volume in scope. Refusing here rather than inside the volume loop is what
 * stops a run from rebuilding volumes 01–04 and only then noticing that 05 was frozen. The
 * state-shaped cancellations — the cumulative cascade, a changed source fingerprint, a failed
 * acceptance grade — are only knowable once the volume's own acceptance window has been read, so
 * they are refused by the same gate inside `utils/series-run/skip.js`, which reuses the skip
 * decision itself rather than re-deriving it.
 *
 * **A frozen volume whose skip stands is not a refusal.** `extract` on a warm cache verifies each
 * volume's bundle and writes nothing; `discover` reuses the plan of record. Both must keep running
 * on a frozen series, because the prerequisite gate runs them before every step — a freeze that
 * blocked them outright would make a resumed run unable to run anything at all. The offline
 * pipeline loop's zero-call second pass is the test that pins this (gotcha 130).
 *
 * Same wrapping position as the prerequisite gate: inside `withRunLock`, outside `withHooks`, inside
 * `withStructuralMarker` so the refusal reaches the parent process. `--dry-run` reports and does not
 * refuse, which is the prerequisite gate's rule and the two gates keep it identical. There is no
 * flag and no environment variable that turns this off; the way past is
 * `release-translation.js`, a recorded act with a typed reason.
 *
 * @param {string} name - The gulp task name, which is the key in `utils/prereqs/freeze.js`.
 * @param {Function} taskFn - The wrapped task.
 * @returns {Function} A drop-in async gulp task.
 */
function withFreezeGate(name, taskFn) {
  return async function gated(...args) {
    const { dryRun, force, volumeArg } = readRunArgs();
    if (!freezeDoorRow(name)) return taskFn(...args);
    // Pre-flight knows one thing for certain: --force cancels every skip. Everything else the skip
    // check would cancel is a fact about a volume's own acceptance window, and the loop asks it there.
    if (!force) return taskFn(...args);
    const verdict = await evaluateFreeze({
      door: name,
      seriesDir: process.env.SERIES_LOCATION,
      cancelledBy: name === "discover" ? "plan-stale" : "force",
      volumeArg,
    });
    if (verdict.ok) return taskFn(...args);
    if (dryRun) {
      console.error(
        `[freeze] ${name} — DRY RUN, so the freeze gate reports and does NOT refuse: ` +
          `${verdict.frozen.length} volume(s) would be rewritten.`
      );
      for (const bullet of verdict.bullets) console.error(`[freeze]   - ${bullet}`);
      return taskFn(...args);
    }
    throw freezeRefusal(verdict.message);
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

/**
 * The "extract" step (step 1): resolve every volume's source bundle, run the extraction audit over it,
 * and record what was found. Deterministic - no model call, no prompt, no agent - and the only step
 * that owns whether the text every later artifact is built on is the text the book actually prints.
 *
 * It sits after `discover` because it needs the plan of record to know which file is which volume, and
 * before everything else because everything else is downstream of its output. On a warm cache it
 * verifies each volume's bundle against the current archive and the current converter schema instead of
 * re-extracting, and says which of the two it did, per volume. A HIGH finding fails the step
 * structurally, so the stages after it do not run. See `utils/source/plan/01-extraction-step.md`.
 */
async function extractStep() {
  await extractVolumes();
}

// Each step is wrapped four times: the run lock on the outside (so a collision is refused before
// anything else is paid for), the structural marker next (closest to the refusal, so the parent
// process can tell a deliberate stop from a crash — see `withPrerequisiteGate`), the prerequisite
// gate next (before the hooks, so a step that never runs never switches a model container), and the
// hook runner innermost around the task itself.
const discoverTask = withRunLock(
  "discover",
  withStructuralMarker("discover", withPrerequisiteGate("discover", withFreezeGate("discover", withHooks("discover", discover))))
);
const extractTask = withRunLock(
  "extract",
  withStructuralMarker("extract", withPrerequisiteGate("extract", withFreezeGate("extract", withHooks("extract", extractStep))))
);
const glossaryTask = withRunLock(
  "glossary",
  withStructuralMarker("glossary", withPrerequisiteGate("glossary", withFreezeGate("glossary", withHooks("glossary", glossary))))
);
const characterVoiceTask = withRunLock(
  "character-voice",
  withStructuralMarker(
    "character-voice",
    withPrerequisiteGate("character-voice", withFreezeGate("character-voice", withHooks("character-voice", characterVoice)))
  )
);
const styleGuideTask = withRunLock(
  "style-guide",
  withStructuralMarker("style-guide", withPrerequisiteGate("style-guide", withFreezeGate("style-guide", withHooks("style-guide", styleGuide))))
);
const jumpInWikiTask = withRunLock(
  "jump-in-wiki",
  withStructuralMarker("jump-in-wiki", withPrerequisiteGate("jump-in-wiki", withFreezeGate("jump-in-wiki", withHooks("jump-in-wiki", jumpInWiki))))
);
const consistencyAuditTask = withRunLock(
  "consistency-audit",
  withStructuralMarker(
    "consistency-audit",
    withPrerequisiteGate("consistency-audit", withHooks("consistency-audit", consistencyAudit))
  )
);
const translateTask = withRunLock(
  "translate",
  withStructuralMarker("translate", withPrerequisiteGate("translate", withHooks("translate", translate)))
);
const verifyTranslateTask = withRunLock(
  "verify-translate",
  withHooks("verify-translate", withStructuralMarker("verify-translate", verifyTranslate))
);
const retranslateTask = withRunLock("retranslate", withHooks("retranslate", withStructuralMarker("retranslate", retranslate)));
const translateQaTask = withRunLock(
  "translate-qa",
  withStructuralMarker("translate-qa", withPrerequisiteGate("translate-qa", withHooks("translate-qa", translateQa)))
);
const polishTask = withRunLock(
  "polish",
  withStructuralMarker("polish", withPrerequisiteGate("polish", withHooks("polish", polish)))
);

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
  // Extraction is its own step so that the text every later artifact is built on is checked and
  // reported before anything is built on it (utils/source/plan/01-extraction-step.md).
  { name: "extract", run: extractTask },
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
exports.extract = extractTask;
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
// The whole default run also fires pre-pipeline / post-pipeline around the whole run.
// The lock is the outermost layer: the default run holds it across all ten in-process
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

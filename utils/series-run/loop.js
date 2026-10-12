/**
 * Walk the volumes of a run, with the three guarantees every task owes the un-monitored one.
 *
 *   1. **One broken volume must not end an overnight run** (`ON_VOLUME_ERROR=skip`), but a
 *      **structural** failure is never skippable — the skip policy exists for flaky model calls,
 *      not for a broken book, and every later volume would fail on the same missing foundation.
 *   2. **Skipping is not succeeding.** A task that skipped volumes fails the run with a named
 *      summary. The summary used to be printed while the task exited 0, which is how a task that
 *      failed on every single volume looked like a success and the pipeline marched on into the
 *      audit and the translation stage.
 *   3. **A fault every later volume inherits is caught before the next volume is built on it.**
 *      After a volume's own work finishes, that volume is assessed against what the step owes it,
 *      and a `STOP` or a `MAJOR` finding ends the walk. This is the volume boundary the finding-level
 *      plan is built around (`utils/postmortem/plan/01-finding-levels.md` §3.1: the loop used to have
 *      `afterVolumes` — after ALL volumes — and no hook after ONE, so a MAJOR at volume 3 was found
 *      after volumes 4–17 had already inherited it).
 *
 * All three rules live here so no task has to remember them, and so the task name is passed in by the
 * caller — the summary has to name the stage that failed, or the run log cannot tell which one.
 *
 * **Which steps the third rule applies to is not decided here.** It is a declared table in
 * `utils/postmortem/halt.js`, in the same closed path as the finding level table, because a stage that
 * can declare itself exempt is not gated (AGENTS.md rule 3, gotcha 70). A stage names itself with
 * `step`; the table decides whether that name is gated. The stages that never reach this loop —
 * `extract`, `discover`, `retranslate`, `translate-qa`, `consistency-audit`, `translation-report` —
 * are named in that table with their reasons rather than left as an absence.
 *
 * Part of the series-run layer (utils/series-run.js).
 */

const { ON_VOLUME_ERROR, isStructuralError, volumeFailureError } = require("../../configs/shared");
const { runStateSeriesDir } = require("../../configs/run-state");
const { runPostMortem } = require("../postmortem");
const {
  haltsForStep,
  haltTriggerFor,
  MISSING_OUTPUT_KINDS,
  VolumeHaltError,
  writeVolumeHalt,
  clearVolumeHalt,
} = require("../postmortem/halt");
const { readRunArgs } = require("./args");

/** @typedef {import("../postmortem").PostMortemReport} PostMortemReport */
/** @typedef {import("../postmortem/halt").VolumeHaltRecord} VolumeHaltRecord */

/**
 * What the volume-boundary gate needs to assess one volume, and whether it runs at all.
 *
 * Built once per walk, from what the caller already has. `seriesDir` falls back to the series this
 * process was pointed at (`SERIES_LOCATION`, resolved at CALL time — a machine-state path frozen at
 * require time is gotcha 79) and `manifest` falls back to the plan of record the post-mortem reads
 * from disk, so a stage that already has both can hand them over and a stage that does not still gets
 * a working gate. `dryRun` falls back to the flags this process was started with.
 *
 * @param {{
 *   step?: string,
 *   seriesDir?: string,
 *   manifest?: import("../../types").TranslationTargetManifest|null,
 *   claims?: Object,
 *   dryRun?: boolean,
 * }} opts
 * @returns {{
 *   step: string,
 *   seriesDir: string,
 *   manifest: import("../../types").TranslationTargetManifest|null,
 *   claims: Object|undefined,
 * }|null} The gate, or null when it does not run for this walk.
 */
function resolveVolumeGate({ step, seriesDir, manifest, claims, dryRun }) {
  if (!step || !haltsForStep(step)) return null;
  if (dryRun === undefined ? readRunArgs().dryRun : dryRun) return null;
  const dir = seriesDir || runStateSeriesDir();
  if (!dir) return null;
  return { step, seriesDir: dir, manifest, claims };
}

/**
 * Assess the volume that just finished, against what this step owes it.
 *
 * Assess only: `writePostMortemReport` belongs to the after-step assessment in `index/assess.js`, and
 * a mid-step write would clobber the report that step is about to produce. The volume is passed as
 * `volumeArg`, which is also what skips the series-root expectations — the series copy does not exist
 * yet mid-run.
 *
 * @param {{ step: string, seriesDir: string, manifest: Object|null, claims: Object|undefined }} gate
 * @param {{ installmentNumber: string }} volumeEntry
 * @returns {Promise<PostMortemReport>}
 */
async function assessFinishedVolume(gate, volumeEntry) {
  return runPostMortem({
    step: gate.step,
    seriesDir: gate.seriesDir,
    manifest: gate.manifest,
    volumeArg: volumeEntry.installmentNumber,
    claims: gate.claims,
  });
}

/**
 * Walk the volumes, applying the skip policy to each one and the volume-boundary gate after each one
 * that finished.
 *
 * This is the loop on its own, for the stages whose run does not END at the volume walk:
 * verify-translate walks the volumes, then re-grades the borderline chapters, then runs one
 * cross-model audit batch over everything it prepared, and only then reports. Those stages call
 * `walkVolumes` and throw their own summary where their run actually ends — the skip policy is
 * shared, the timing of the report stays with the stage that knows what it still has to do. A stage
 * that walks this way is still gated, and it is gated by the same table as every other one: it passes
 * `step`, and `utils/postmortem/halt.js` decides whether that name halts.
 *
 * @param {{
 *   volumes: string[],
 *   folders?: string[],
 *   volumeByFolder: Map<string, Object>,
 *   processVolume: (folderName: string, index: number) => Promise<void>,
 *   onVolumeSkipped?: (folderName: string, error: Error) => void,
 *   step?: string,
 *   seriesDir?: string,
 *   manifest?: import("../../types").TranslationTargetManifest|null,
 *   claims?: Object,
 *   dryRun?: boolean,
 *   onVolumeAssessed?: (folderName: string, report: PostMortemReport) => void,
 * }} opts - `folders` is the FULL reading-order list. The index handed to `processVolume` is the
 *   index in THAT list, not in the filtered one, so a `--volume 07` run still resolves volume 06.
 *   `step` is the gulp task name the assessment is done against; without it the gate does not run,
 *   which is why every gated stage has to name itself (pinned in `test/test-volume-halt-gate.js`).
 * @returns {Promise<Array<{ folder: string, error: Error }>>} The volumes that were skipped.
 * @throws {Error} The volume's own error when it is not skippable.
 * @throws {import("../postmortem/halt").VolumeHaltError} When a volume's own assessment found a STOP
 *   or a MAJOR: the walk stops after that volume and the halt is recorded for the after-step
 *   assessment to read.
 */
async function walkVolumes({
  volumes,
  folders,
  volumeByFolder,
  processVolume,
  onVolumeSkipped,
  step,
  seriesDir,
  manifest,
  claims,
  dryRun,
  onVolumeAssessed,
}) {
  /** @type {Array<{ folder: string, error: Error }>} */
  const failedVolumes = [];
  const order = folders || volumes;

  const gate = resolveVolumeGate({ step, seriesDir, manifest, claims, dryRun });
  if (gate) {
    // This walk's outcome, not an earlier run's: a halt record left behind would otherwise silence
    // the missing output of the volumes this walk never reaches. Same rule index/run-step.js applies
    // to the structural marker.
    clearVolumeHalt(gate.step);
  }
  let assessedCount = 0;
  let assessmentErrorNamed = false;
  /** Wall time spent INSIDE the assessments, summed per call — not the walk's own work. */
  let gateMs = 0;

  for (const folderName of volumes) {
    try {
      await processVolume(folderName, order.indexOf(folderName));
    } catch (err) {
      if (ON_VOLUME_ERROR !== "skip" || isStructuralError(err)) throw err;
      failedVolumes.push({ folder: folderName, error: err });
      const entry = volumeByFolder.get(folderName);
      console.error(
        `[skip] Volume ${entry ? entry.installmentNumber : folderName} (${folderName}) failed: ` +
          `${err.message} — continuing with the next volume (ON_VOLUME_ERROR=skip).`
      );
      if (onVolumeSkipped) onVolumeSkipped(folderName, err);
      continue;
    }

    if (!gate) continue;
    const entry = volumeByFolder.get(folderName);
    if (!entry) continue;

    // Nothing is assessed mid-chapter: this runs once, after the volume's own work returned.
    const assessStartedAt = Date.now();
    const report = await assessFinishedVolume(gate, entry);
    gateMs += Date.now() - assessStartedAt;
    assessedCount++;
    if (onVolumeAssessed) onVolumeAssessed(folderName, report);

    if (report.error) {
      // An assessment that could not run is not a clean volume and not a fault either. It is named
      // once per walk, and the after-step assessment reports it; halting on it would stop a run over
      // a plan of record the step never needed to read.
      if (!assessmentErrorNamed) {
        assessmentErrorNamed = true;
        console.warn(
          `[gate] ${gate.step}: could not assess the finished volumes (${report.error}) — ` +
            `continuing; the after-step assessment will report it.`
        );
      }
      continue;
    }

    let trigger = haltTriggerFor(report.findings);
    if (trigger.length && failedVolumes.length > 0) {
      // A cascade is not a new fault. An earlier volume in THIS walk already failed and is already
      // recorded, and the summary at the end of the run names it; the later volume's missing output is
      // that failure's symptom. Halting here would blame the symptom and bury the cause. Every other
      // kind — a file that is there and wrong, a chapter nobody translated — still halts.
      const explained = trigger.filter((f) => MISSING_OUTPUT_KINDS.has(f.kind));
      trigger = trigger.filter((f) => !MISSING_OUTPUT_KINDS.has(f.kind));
      if (explained.length) {
        console.warn(
          `[gate] ${gate.step} volume ${entry.installmentNumber}: ${explained.length} missing-output ` +
            `finding(s) not treated as a halt — volume ${failedVolumes[0].folder} already failed in ` +
            `this run, and that is what left this volume with nothing to build on.`
        );
      }
    }
    if (!trigger.length) continue;

    const at = order.indexOf(folderName);
    const unattempted = volumes
      .slice(at + 1)
      .map((folder) => volumeByFolder.get(folder)?.installmentNumber)
      .filter(Boolean);
    const record = {
      step: gate.step,
      haltedAfterVolume: entry.installmentNumber,
      haltedAfterFolder: folderName,
      attemptedVolumes: volumes
        .slice(0, at + 1)
        .map((folder) => volumeByFolder.get(folder)?.installmentNumber)
        .filter(Boolean),
      unattemptedVolumes: unattempted,
      trigger: trigger.map((f) => ({
        kind: f.kind,
        level: f.level,
        severity: f.severity,
        file: f.file,
        message: f.message,
      })),
    };
    const written = writeVolumeHalt(record);
    if (!written.written) {
      console.error(`[gate] could not record the halt (${written.error}) — the step still stops.`);
    }
    console.error(
      `[gate] ${gate.step}: halted after volume ${entry.installmentNumber} (${folderName}) on ` +
        `${trigger.map((f) => `${f.level} ${f.kind}`).join(", ")}. ` +
        `${unattempted.length} volume(s) not attempted.`
    );
    throw new VolumeHaltError({
      step: gate.step,
      volume: entry.installmentNumber,
      folder: folderName,
      trigger,
      unattemptedVolumes: unattempted,
    });
  }

  if (gate && assessedCount > 0) {
    // The cost of the assessments ALONE, timed per call. The first version of this line timed the
    // whole walk — `Date.now()` taken before the loop and printed after it — so it reported the
    // stage's own model calls as if they were the gate's cost (199 ms per volume in the offline
    // loop, against 0.19–0.98 ms measured around the assessment itself). A cost claim that includes
    // the work the gate is meant to protect is a cost claim that proves nothing.
    console.log(
      `[gate] ${gate.step}: assessed ${assessedCount} volume(s) inside the step — ${gateMs} ms total, ` +
        `${(gateMs / assessedCount).toFixed(2)} ms per volume, no model call.`
    );
  }
  return failedVolumes;
}

/**
 * Run `processVolume` over each folder in reading order, then close the run.
 *
 * @param {string} taskName - The stage's own name, used in the failure summary.
 * @param {{
 *   volumes: string[],
 *   folders?: string[],
 *   volumeByFolder: Map<string, Object>,
 *   processVolume: (folderName: string, index: number) => Promise<void>,
 *   afterVolumes?: () => Promise<void>,
 *   onVolumeSkipped?: (folderName: string, error: Error) => void,
 *   step?: string,
 *   seriesDir?: string,
 *   manifest?: import("../../types").TranslationTargetManifest|null,
 *   claims?: Object,
 *   dryRun?: boolean,
 *   onVolumeAssessed?: (folderName: string, report: PostMortemReport) => void,
 * }} opts - See {@link walkVolumes}. `afterVolumes` is the stage's own end-of-run work that must
 *   happen BEFORE the failure summary is thrown: its series-root publish (a run that broke on the
 *   last volume still has earlier volumes worth publishing), or its completeness gate (one
 *   untranslatable chapter in volume 2 must not prevent volumes 3–17 from being attempted).
 *   A halt is not a skipped volume: when the gate stops the walk, `afterVolumes` does not run, because
 *   publishing a series-root copy built on a volume the assessment just refused is the thing the halt
 *   exists to prevent.
 * @returns {Promise<Array<{ folder: string, error: Error }>>} The volumes that were skipped.
 * @throws {Error} The volume's own error when it is not skippable, or the run summary at the end.
 * @throws {import("../postmortem/halt").VolumeHaltError} When a finished volume's own assessment found
 *   a STOP or a MAJOR.
 */
async function runVolumeSeries(taskName, { volumes, folders, volumeByFolder, processVolume, afterVolumes, onVolumeSkipped, step, seriesDir, manifest, claims, dryRun, onVolumeAssessed }) {
  const failedVolumes = await walkVolumes({
    volumes,
    folders,
    volumeByFolder,
    processVolume,
    onVolumeSkipped,
    step: step || taskName,
    seriesDir,
    manifest,
    claims,
    dryRun,
    onVolumeAssessed,
  });

  if (afterVolumes) await afterVolumes();

  const volumeError = volumeFailureError(taskName, failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
  return failedVolumes;
}

module.exports = { walkVolumes, runVolumeSeries, resolveVolumeGate, assessFinishedVolume };

/**
 * Walk the volumes of a run, with the two guarantees every task owes the un-monitored one.
 *
 *   1. **One broken volume must not end an overnight run** (`ON_VOLUME_ERROR=skip`), but a
 *      **structural** failure is never skippable — the skip policy exists for flaky model calls,
 *      not for a broken book, and every later volume would fail on the same missing foundation.
 *   2. **Skipping is not succeeding.** A task that skipped volumes fails the run with a named
 *      summary. The summary used to be printed while the task exited 0, which is how a task that
 *      failed on every single volume looked like a success and the pipeline marched on into the
 *      audit and the translation stage.
 *
 * Both rules live here so no task has to remember them, and so the task name is passed in by the
 * caller — the summary has to name the stage that failed, or the run log cannot tell which one.
 *
 * Part of the series-run layer (utils/series-run.js).
 */

const { ON_VOLUME_ERROR, isStructuralError, volumeFailureError } = require("../../configs/shared");

/**
 * Run `processVolume` over each folder in reading order.
 *
 * @param {string} taskName - The stage's own name, used in the failure summary.
 * @param {{
 *   volumes: string[],
 *   folders: string[],
 *   volumeByFolder: Map<string, Object>,
 *   processVolume: (folderName: string, index: number) => Promise<void>,
 *   afterVolumes?: () => Promise<void>,
 *   onVolumeSkipped?: (folderName: string, error: Error) => void,
 * }} opts - `folders` is the FULL reading-order list. The index handed to `processVolume` is the
 *   index in THAT list, not in the filtered one, so a `--volume 07` run still resolves volume 06.
 *   `afterVolumes` runs the stage's series-root publish BEFORE the summary is thrown: a run that
 *   broke on the last volume still has earlier volumes worth publishing, and the failure report is
 *   the run's last act, not one a publish can be crowded out by.
 * @returns {Promise<Array<{ folder: string, error: Error }>>} The volumes that were skipped.
 * @throws {Error} The volume's own error when it is not skippable, or the run summary at the end.
 */
async function runVolumeSeries(taskName, { volumes, folders, volumeByFolder, processVolume, afterVolumes, onVolumeSkipped }) {
  /** @type {Array<{ folder: string, error: Error }>} */
  const failedVolumes = [];
  const order = folders || volumes;

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
    }
  }

  if (afterVolumes) await afterVolumes();

  const volumeError = volumeFailureError(taskName, failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
  return failedVolumes;
}

module.exports = { runVolumeSeries };

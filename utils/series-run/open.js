/**
 * Open the series a task is about to walk: the plan of record, the run's language settings, and
 * the exact folder list this invocation will process.
 *
 * Every stage asks the same four questions in the same order — load the manifest, resolve the
 * settings, list the volumes in reading order, narrow them for `--volume`. This is that sequence
 * once, with the two failure messages that must never be swallowed by an un-monitored run
 * (an empty plan of record, and a `--volume` that matches nothing).
 *
 * Part of the series-run layer (utils/series-run.js).
 */

const { getTranslationTarget } = require("../../get-translation-target");
const { resolveRunSettings } = require("../../configs/shared");
const { filterVolumesByInstallment } = require("../manifest");

/**
 * Narrow a manifest's volumes to the ones this invocation should process.
 *
 * `--volume NN` is resolved through the manifest's installment numbers, not by parsing folder names —
 * the intake agent chooses the folder names. A no-match fails loudly: a silent exit would masquerade
 * as a successful no-op in an un-monitored run.
 *
 * Exported on its own for the one task that does not walk the volumes itself (translate-qa runs
 * verify and retranslate, which each resolve the volume list from their own arguments) but still has
 * to act on the same `--volume` for its own deterministic half.
 *
 * @param {{manifest: Object, volumeArg?: string|null, log?: (line: string) => void}} opts
 * @returns {string[]} The folders to process, in the manifest's reading order.
 * @throws {Error} When `--volume` matches none of them.
 */
function selectVolumesFromManifest({ manifest, volumeArg = null, log = console.log }) {
  const folders = manifest.volumes.map((v) => v.folder);
  if (!volumeArg) return folders;
  const picked = filterVolumesByInstallment(manifest, volumeArg);
  if (picked.length === 0) {
    throw new Error(
      `No volume matching --volume ${volumeArg} (manifest volumes: ` +
        `${manifest.volumes.map((v) => `${v.installmentNumber} = ${v.folder}`).join(", ")}).`
    );
  }
  log(`--volume: processing only ${picked.join(", ")}`);
  return picked;
}

/**
 * Load the plan of record and resolve what this run will process.
 *
 * `--force` here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
 *
 * The folder list is the manifest's order, used as-is: it IS the reading order the intake agent
 * decided, and re-sorting it by parsing folder names would reorder a cumulative series.
 *
 * @param {{
 *   seriesDir: string,
 *   dryRun: boolean,
 *   volumeArg?: string|null,
 *   log?: (line: string) => void,
 * }} opts
 * @returns {Promise<{
 *   manifest: Object,
 *   runSettings: {seriesName: string, sourceLanguage: string, targetLanguage: string},
 *   folders: string[],
 *   volumes: string[],
 *   volumeByFolder: Map<string, Object>,
 * }>}
 * @throws {Error} When the series has no volumes, or `--volume` matches none of them.
 */
async function openSeriesRun({ seriesDir, dryRun, volumeArg = null, log = console.log }) {
  const manifest = await getTranslationTarget({ dryRun });
  // Series name + languages: .env override > the intake manifest's decision > the default.
  const runSettings = resolveRunSettings(manifest);
  // Use SERIES_LOCATION, NOT manifest.seriesLocation: that field is provenance metadata from the
  // machine that generated the manifest, and after a Windows→Linux migration the cached "C:\…" path
  // is not absolute, so every file op would silently resolve relative to the CWD (observed live:
  // ENOENT on <CWD>/C:\...\test_story(1)/…).
  const folders = manifest.volumes.map((v) => v.folder);
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));

  if (folders.length === 0) {
    throw new Error(`No volume folders found in ${seriesDir}.`);
  }

  const volumes = selectVolumesFromManifest({ manifest, volumeArg, log });
  return { manifest, runSettings, folders, volumes, volumeByFolder };
}

module.exports = { openSeriesRun, selectVolumesFromManifest };

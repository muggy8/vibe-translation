/**
 * The cumulative tasks' shared precondition: a volume built on the previous volume's artifact
 * cannot start when that artifact is not there.
 *
 * Four tasks (glossary, character-voice, style-guide, jump-in-wiki) each carried their own copy of
 * this decision, and each copy had to get three things right at once: `--dry-run` previews must
 * continue past a missing base, `ON_MISSING_PREVIOUS=skip` must skip rather than die, and a real
 * run must fail loudly. Four copies is four chances to get one of them wrong.
 *
 * "Not there" is decided by the caller's check, because the wiki needs "there AND holds real
 * content" (a crashed run leaves scaffold stubs, which are not a usable base) while the glossary
 * only needs the file.
 *
 * Part of the series-run layer (utils/series-run.js).
 */

const path = require("path");
const { fileExists } = require("../fs");
const { ON_MISSING_PREVIOUS } = require("../../configs/shared");

/**
 * Resolve the previous volume in the manifest's reading order.
 *
 * @param {{
 *   folders: string[],
 *   index: number,
 *   volumeByFolder: Map<string, Object>,
 * }} opts - The full reading-order list, this volume's index IN THAT LIST, and the manifest lookup.
 * @returns {{ isFirst: boolean, previousFolderName: string|null, previousInstallmentNumber: string|null }}
 */
function locatePreviousVolume({ folders, index, volumeByFolder }) {
  const isFirst = index === 0;
  const previousFolderName = isFirst ? null : folders[index - 1];
  // The previous volume's ACTUAL installment number from the plan of record (not current-1 —
  // agent-chosen installment numbers are not guaranteed contiguous, so N-1 would misname the prior
  // volume in a prompt's prose).
  const previousInstallmentNumber = isFirst
    ? null
    : volumeByFolder.get(previousFolderName)?.installmentNumber ?? null;
  return { isFirst, previousFolderName, previousInstallmentNumber };
}

/**
 * Check that the previous volume's artifact(s) exist, and apply the run policy when they do not.
 *
 * @param {{
 *   seriesDir: string,
 *   previousFolderName: string|null,
 *   fileNames: string[],
 *   label: string,
 *   installmentNumber: string,
 *   dryRun: boolean,
 *   isUsable?: (filePath: string) => Promise<boolean>,
 * }} opts - `isUsable` defaults to "the file exists"; pass `hasRealOutput` when a stub must not count.
 * @returns {Promise<{ ok: boolean, skipVolume: boolean, missing: string[], files: string[] }>}
 *   `ok` false with `skipVolume` true means the caller must move on to the next volume. A `--dry-run`
 *   warns and keeps going: the preview must show what a live run WOULD send, and a preview that stops
 *   at volume 02 because volume 01 has not been built yet previews nothing.
 * @throws {Error} When a live run is missing its base and ON_MISSING_PREVIOUS is not "skip".
 */
async function requirePreviousArtifacts({
  seriesDir,
  previousFolderName,
  fileNames,
  label,
  installmentNumber,
  dryRun,
  isUsable = fileExists,
}) {
  if (!previousFolderName) return { ok: true, skipVolume: false, missing: [], files: [] };

  const previousDir = path.join(seriesDir, previousFolderName);
  const files = fileNames.map((name) => path.join(previousDir, name));
  const missing = [];
  for (const file of files) {
    if (!(await isUsable(file))) missing.push(file);
  }
  if (missing.length === 0) return { ok: true, skipVolume: false, missing: [], files };

  const missingText = missing.join(" and ");
  if (dryRun) {
    console.warn(
      `Volume ${installmentNumber}: --dry-run: the previous ${label} ` +
        `(${missingText}) does not exist yet — a live run would stop here. ` +
        `Continuing the prompt preview.`
    );
    return { ok: false, skipVolume: false, missing, files };
  }
  if (ON_MISSING_PREVIOUS === "skip") {
    console.log(
      `Volume ${installmentNumber}: previous ${label} not found (${missingText}) — ` +
        `skipping this volume (ON_MISSING_PREVIOUS=skip).`
    );
    return { ok: false, skipVolume: true, missing, files };
  }
  throw new Error(
    `Previous ${label} not found: ${missingText}. Process the earlier volume first ` +
      `(or re-run without --force), or set ON_MISSING_PREVIOUS=skip to skip this volume.`
  );
}

module.exports = { locatePreviousVolume, requirePreviousArtifacts };

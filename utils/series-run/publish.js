/**
 * Publish the series-current copy of a cumulative artifact.
 *
 * A translator or a downstream tool starting at volume 12 should read ONE file at the series root,
 * not go looking for the newest volume folder. So each cumulative task copies the last volume's
 * artifact up to the root — and "last" has to mean the last one that is an actual document: a
 * crashed run leaves a scaffold stub in the final volume's folder, and publishing
 * "(stub — the agent replaces this…)" as the series' living glossary is worse than publishing
 * nothing (gotcha 58).
 *
 * A `--volume` run does not publish: one volume's snapshot is not the series state, and publishing
 * it would overwrite the correct root copy with a stale one.
 *
 * Part of the series-run layer (utils/series-run.js).
 */

const fs = require("fs").promises;
const path = require("path");
const { isPublishableArtifact, writeProvenanceSidecar } = require("../fs");
const { seriesArtifactFile } = require("../../configs/shared");

/**
 * Copy the newest publishable artifact to the series root.
 *
 * @param {{
 *   seriesDir: string,
 *   folders: string[],
 *   fileName: string,
 *   envKey: string,
 *   label: string,
 *   volumeArg?: string|null,
 *   dryRun: boolean,
 * }} opts - `label` is what the artifact is called in the log and in the publishability warning.
 * @returns {Promise<{ copied: string|null, destination: string }>}
 */
async function publishLatestToSeriesRoot({ seriesDir, folders, fileName, envKey, label, volumeArg = null, dryRun }) {
  const destination = seriesArtifactFile(fileName, envKey, seriesDir);
  if (volumeArg || dryRun) {
    console.log(
      volumeArg
        ? `\n--volume: skipping the series-root ${label} copy (single-volume run).`
        : `\n--dry-run: skipping the series-root ${label} copy (dry runs make no file writes).`
    );
    return { copied: null, destination };
  }

  for (let i = folders.length - 1; i >= 0; i -= 1) {
    const candidate = path.join(seriesDir, folders[i], fileName);
    if (!(await isPublishableArtifact(candidate, label))) continue;
    await fs.copyFile(candidate, destination);
    await writeProvenanceSidecar(destination, candidate);
    console.log(`\nCopied the final ${label} to: ${destination}`);
    return { copied: candidate, destination };
  }

  console.log(`\nNo ${label} snapshots found; nothing to copy to the series root.`);
  return { copied: null, destination };
}

module.exports = { publishLatestToSeriesRoot };

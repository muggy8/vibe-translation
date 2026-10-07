/**
 * utils/fs/wipe.js — remove what a failed attempt left, and only that.
 *
 * A retry starts from a clean volume folder, but the folder also holds the accepted work of
 * earlier volumes and the quarantine evidence a gate produced. The list of names is the
 * boundary: everything else stays.
 */

const fs = require("fs");
const path = require("path");

/**
 * Delete the files one processing attempt wrote, so a different attempt starts
 * from a clean folder.
 *
 * This exists because the whole-installment → chapter-by-chapter fallback swaps
 * the SHAPE of the work mid-volume, and the two modes leave different files
 * behind. A half-finished whole attempt leaves a partial (or scaffold-stub)
 * artifact, a research skeleton full of `- (pending)` lines, and a rolling-state
 * file recording scores for documents that no longer exist. The chunked path
 * would then read those as its starting point — and this codebase has been
 * burned by exactly that class of bug before (AGENTS.md gotcha 3: every stray
 * cleanup in the repo was added after a live failure; gotcha 50: "the file is
 * there" is never evidence the work was done).
 *
 * Deletes ONLY the names it is given. It never walks the folder and never
 * touches the source bundle: the extraction is keyed on the source fingerprint
 * and is valid regardless of which mode processes it.
 *
 * @param {string} volumeDir - The volume folder.
 * @param {string[]} fileNames - File names (relative to the folder) the attempt wrote.
 * @param {{glob?: RegExp}} [opts] - Optional pattern matched against file names, for a mode's per-chapter strays (e.g. /^wiki-.+\.md$/).
 * @returns {Promise<string[]>} The names actually removed.
 */
async function wipeAttemptOutputs(volumeDir, fileNames, { glob } = {}) {
  const removed = [];
  for (const name of fileNames || []) {
    const target = path.join(volumeDir, name);
    try {
      await fs.promises.rm(target);
      removed.push(name);
    } catch {
      // Not there — the attempt never got that far. Not an error.
    }
  }
  if (glob) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(volumeDir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!glob.test(name)) continue;
      try {
        await fs.promises.rm(path.join(volumeDir, name));
        removed.push(name);
      } catch {}
    }
  }
  return removed;
}

module.exports = { wipeAttemptOutputs };

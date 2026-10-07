/**
 * utils/fs/exists.js — what a path is, and whether anything is behind it.
 *
 * fileExists answers "is there a file here" for a pipeline that treats "absent" as a fact
 * about the deliverable rather than an error. shortcutTarget answers "what would a link
 * here point at", which is what a staged source file needs before anything is written.
 */

const fs = require("fs");
const path = require("path");

// ─── Filesystem helpers ───────────────────────────────────────────────────────

/**
 * Check whether a file exists.
 *
 * @param {string} filePath - The path to check.
 * @returns {Promise<boolean>} True if the file exists, false otherwise.
 */
async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a shortcut actually points, when the path IS a shortcut.
 *
 * A staged book is now usually a shortcut, so "the source file is missing" has a
 * second meaning it never used to have: the name is there and the book behind it
 * is not. A reader of the error needs both halves — the name the plan of record
 * lists, and the file that name was reaching.
 *
 * @param {string} filePath
 * @returns {Promise<{pointsTo: string, resolves: string|null}|null>}
 *   `pointsTo` is the file the shortcut NAMES (absolute); `resolves` is the real
 *   file it reaches, or null when that file is gone. Null when `filePath` is not
 *   a shortcut at all.
 */
async function shortcutTarget(filePath) {
  let st = null;
  try {
    st = await fs.promises.lstat(filePath);
  } catch {
    return null;
  }
  if (!st.isSymbolicLink()) return null;
  const pointsTo = path.resolve(path.dirname(filePath), await fs.promises.readlink(filePath));
  try {
    return { pointsTo, resolves: await fs.promises.realpath(filePath) };
  } catch {
    return { pointsTo, resolves: null };
  }
}

module.exports = { fileExists, shortcutTarget };

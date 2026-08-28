/**
 * utils/fs.js — Filesystem utility functions shared across the ai-client
 * modules.
 *
 * @example
 * const { fileExists, assertWrote } = require("../utils/fs");
 */

const fs = require("fs");

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
 * Fail loudly if an agent-mode stage left its output file(s) missing or empty.
 *
 * @param {string | string[]} filePaths - Expected output file path or array of paths.
 * @param {string} who - Who was supposed to write it (for the error message).
 * @returns {Promise<void>}
 */
async function assertWrote(filePaths, who) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  for (const filePath of paths) {
    const content = await fs.promises.readFile(filePath, "utf-8").catch(() => null);
    if (!content || !content.trim()) {
      throw new Error(
        `${who} did not produce ${filePath}. Check the run log in .logs/ for the agent transcript.`
      );
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  fileExists,
  assertWrote,
};

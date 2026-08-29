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

/**
 * Fail loudly if an agent-mode stage left its output file(s) missing or empty,
 * or recover by writing provided chat-reply content to disk as a fallback.
 *
 * This is a recovery wrapper for the author agent: when the model produces
 * the output in its chat reply instead of calling writeFile, the content is
 * still available in the agent handle's returned result and can be written
 * directly.
 *
 * @param {string | string[]} filePaths - Expected output file path or array of paths.
 * @param {string} who - Who was supposed to write it (for the error message).
 * @param {string} [content] - Optional content to write if the file is missing.
 * @returns {Promise<boolean>} True if the fallback was triggered (file was missing and
 *   content was written), false if the file already existed or the fallback was not used.
 */
async function assertWroteWithFallback(filePaths, who, content) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  let fallbackUsed = false;
  for (const filePath of paths) {
    if (await fileExists(filePath)) continue;

    if (content && content.trim().length > 0) {
      // Fallback: write the chat-reply content to disk.
      await fs.promises.writeFile(filePath, content, "utf8");
      console.log(
        `[fallback] ${who} replied in chat instead of using writeFile; ` +
          `wrote ${filePath} from the chat reply (${content.length} chars).`
      );
      fallbackUsed = true;
    } else {
      // Hard fail — no content to recover with.
      throw new Error(
        `${who} did not produce ${filePath}. ` +
          `Check the run log in .logs/ for the agent transcript.`
      );
    }
  }
  return fallbackUsed;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  fileExists,
  assertWrote,
  assertWroteWithFallback,
};

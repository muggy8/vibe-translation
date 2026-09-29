/**
 * utils/fs.js — Filesystem utility functions shared across the ai-client
 * modules.
 *
 * @example
 * const { fileExists, assertWrote } = require("../utils/fs");
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
 * The return value gates the CALLER's recovery turn: callers must only send
 * a recovery turn when this returns true (a file was actually missing).
 * Always returning true here made every stage run a redundant "recovery" turn
 * over an already-correct file — a second stochastic rewrite of the output
 * plus a false claim in the prompt that the model had replied in chat.
 *
 * @param {string | string[]} filePaths - Expected output file path or array of paths.
 * @param {string} who - Who was supposed to write it (for the error message).
 * @param {string} [content] - Optional content to write if the file is missing.
 * @returns {Promise<boolean>} True if at least one file was missing (the
 *   fallback was used, or recovery is still needed because there was no
 *   content), false if every file already existed.
 */
async function assertWroteWithFallback(filePaths, who, content) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  let anyMissing = false;
  for (const filePath of paths) {
    if (await fileExists(filePath)) continue;

    anyMissing = true;
    if (content && content.trim().length > 0) {
      // Fallback: write the chat-reply content to disk.
      await fs.promises.writeFile(filePath, content, "utf8");
      console.log(
        `[fallback] ${who} replied in chat instead of using writeFile; ` +
          `wrote ${filePath} from the chat reply (${content.length} chars).`
      );
    } else {
      // No content to recover with — the caller will send a recovery turn
      // that re-sends the full task.
      console.warn(
        `[warning] ${who} produced no output — recovery turn will re-send the task.`
      );
    }
  }
  return anyMissing;
}

/**
 * Write a provenance sidecar next to a series-root artifact copy.
 *
 * The root copies (glossary.md, character-voice.md, style-guide.md,
 * shared-wiki.md) are byte-identical copies of a per-volume snapshot, and
 * nothing in the file itself records which volume they came from — this
 * sidecar (`<copy>.provenance.json`) does: the source path, the volume, the
 * copy timestamp, and the content hash (so a later manual refresh of the
 * copy without re-running the task is detectable).
 *
 * Best-effort: a failure only warns — the copy itself is the deliverable.
 *
 * @param {string} targetFile - The root copy that was just written.
 * @param {string} sourceFile - The per-volume snapshot it was copied from.
 * @returns {Promise<void>}
 */
async function writeProvenanceSidecar(targetFile, sourceFile) {
  try {
    const crypto = require("crypto");
    const content = await fs.promises.readFile(targetFile);
    const sidecar = {
      file: path.basename(targetFile),
      copiedFrom: sourceFile,
      volume: path.basename(path.dirname(sourceFile)),
      copiedAt: new Date().toISOString(),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    };
    await fs.promises.writeFile(
      `${targetFile}.provenance.json`,
      JSON.stringify(sidecar, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    console.warn(
      `[provenance] could not write the sidecar for ${targetFile} (${err.message}) — continuing.`
    );
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  fileExists,
  assertWrote,
  assertWroteWithFallback,
  writeProvenanceSidecar,
};

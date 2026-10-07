/**
 * Small primitives shared across the translation stage: the content hash the
 * idempotency skip-checks are built from, and the one file read that must never
 * throw.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const crypto = require("crypto");
const fs = require("fs").promises;

/**
 * sha256 of a string (content hash for the idempotency skip-checks).
 *
 * @param {string} text - The content to hash.
 * @returns {string} The hex digest.
 */
function sha256(text) {
  return crypto.createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

// ─── Chapter splitting ──────────────────────────────────────────────────────


/**
 * Read a file's content or "" when it does not exist.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readFileOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}


module.exports = {
  sha256,
  readFileOrEmpty,
};

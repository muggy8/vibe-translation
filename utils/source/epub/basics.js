/**
 * utils/source/epub/basics.js — the small facts about an archive that everything else assumes.
 *
 * A zip entry path, a file's hash, a JSON file that may not be there, and the byte size an
 * archive reports without decompressing anything. The last one is the reason the intake can
 * tell an illustrated novel from an art book at all.
 */

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

/**
 * True when the path looks like an epub file (by extension). The container
 * is validated for real (META-INF/container.xml) during extraction.
 *
 * @param {string} absPath - A file path.
 * @returns {boolean}
 */
function isEpubPath(absPath) {
  return /\.epub$/i.test(absPath);
}

/**
 * Decode a percent-encoded OPF href, then normalize it to a zip entry path
 * (no leading slash, `../` resolved).
 *
 * @param {string} p - A zip-relative path, possibly percent-encoded.
 * @returns {string}
 */
function normalizeZipPath(p) {
  let s = p || "";
  try {
    s = decodeURIComponent(s);
  } catch {
    // leave as-is when the encoding is invalid
  }
  s = s.replace(/^\/+/, "");
  s = path.posix.normalize(s);
  return s.replace(/^\/+/, "");
}

/**
 * Read the sha256 of a file.
 *
 * @param {string} filePath - Absolute file path.
 * @returns {Promise<string>} Hex digest.
 */
async function sha256OfFile(filePath) {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Read a JSON file, returning null when missing or unparseable.
 *
 * @param {string} filePath
 * @returns {Promise<Object|null>}
 */
async function readJsonOrNull(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * The uncompressed size of one zip entry, as recorded in the archive's central
 * directory. JSZip parses the central directory when the archive is loaded, so
 * this is available for every entry WITHOUT decompressing it — which is the
 * whole point: weighing a book's images against its prose must not read the
 * images.
 *
 * @param {Object} entry - A JSZip zip object.
 * @returns {number} Its uncompressed byte size, or 0 when the archive does not say.
 */
function zipEntryUncompressedSize(entry) {
  const size = entry && entry._data ? entry._data.uncompressedSize : 0;
  return Number.isFinite(size) && size > 0 ? size : 0;
}

module.exports = {
  isEpubPath,
  normalizeZipPath,
  sha256OfFile,
  readJsonOrNull,
  zipEntryUncompressedSize,
};

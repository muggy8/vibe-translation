/**
 * utils/manifest.js — JSON and manifest utility functions shared across the
 * ai-client modules.
 *
 * @example
 * const { extractJsonObject, installmentNumberFromDir } = require("../utils/manifest");
 */

const path = require("path");

// ─── JSON / manifest helpers ──────────────────────────────────────────────────

/**
 * Extract a JSON object from a string that may wrap it in markdown code fences
 * or surrounding prose. This is the salvage path used when an AI model returns
 * JSON in its chat reply instead of writing it to disk.
 *
 * @param {string} text - The raw text to extract from.
 * @returns {*} The parsed outermost JSON object.
 * @throws {Error} When no parseable JSON object can be found.
 */
function extractJsonObject(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("No text to extract a JSON object from.");
  }
  let t = text.trim();
  // Strip a markdown code fence if the model wrapped the JSON in one.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // Take the span from the first '{' to the last '}'.
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in the text.");
  }
  const candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(`Could not parse a JSON object from the text: ${err.message}`);
  }
}

/**
 * Derive a zero-padded installment number from the trailing "(N)" of a folder
 * name. E.g. "俺を好きなのはお前だけかよ(1)" → "01".
 *
 * @param {string} dir - A folder path (only its base name is used).
 * @returns {string} The zero-padded installment number.
 */
function installmentNumberFromDir(dir) {
  const match = path.basename(dir).match(/\((\d+)\)\s*$/);
  if (!match) {
    throw new Error(
      `Cannot derive the installment number from folder name: ${path.basename(dir)}`
    );
  }
  return match[1].padStart(2, "0");
}

/**
 * Normalize a volume's installment number to the two-digit form the whole
 * pipeline uses ("1", "01", 1, "001" → "01"). The intake agent writes these,
 * so the accepted shapes are deliberately generous — but a number that is not
 * a positive integer is rejected loudly (a bad number silently reorders a
 * cumulative series).
 *
 * @param {string|number} value - The installment number as written.
 * @param {string} [where] - Label used in the error message.
 * @returns {string} The zero-padded two-digit number.
 * @throws {Error} When the value is not a positive integer.
 */
function normalizeInstallmentNumber(value, where = "installment number") {
  const raw = String(value ?? "").trim();
  if (!/^\d{1,4}$/.test(raw)) {
    throw new Error(`${where} is not a positive integer: ${JSON.stringify(value)}`);
  }
  const n = parseInt(raw, 10);
  if (n <= 0) throw new Error(`${where} must be greater than zero: ${raw}`);
  return String(n).padStart(2, "0");
}

/**
 * Validate (and tidy) a volume folder name the intake agent chose. The agent
 * decides what the folders are called, so the only thing the code enforces is
 * that the name cannot escape the series folder or break a file system:
 * no path separators, no "..", no absolute paths, no characters Windows
 * forbids, no leading/trailing dots or spaces. Source-language characters
 * (Japanese, Cyrillic, accents, …) are kept exactly as written.
 *
 * @param {string} name - The folder name as written by the agent.
 * @param {string} [where] - Label used in the error message.
 * @returns {string} The sanitized folder name.
 * @throws {Error} When the name is unusable.
 */
function sanitizeFolderName(name, where = "volume folder") {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`${where} name is empty.`);
  }
  const trimmed = name.trim();
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error(`${where} name must be relative, not absolute: "${trimmed}".`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(
      `${where} name must be a single folder name (no path separators): "${trimmed}".`
    );
  }
  const parts = trimmed.split(/[\\/]/);
  if (parts.includes("..") || parts.includes(".")) {
    throw new Error(`${where} name cannot contain "." or "..": "${trimmed}".`);
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(trimmed)) {
    throw new Error(
      `${where} name contains characters a file system forbids (one of < > : " | ? * or a control character): "${trimmed}".`
    );
  }
  if (/^[.\s]/.test(trimmed) || /[.\s]$/.test(trimmed)) {
    throw new Error(`${where} name cannot start or end with a dot or a space: "${trimmed}".`);
  }
  return trimmed.replace(/\s+/g, " ");
}

/**
 * Pick the volume folders a "--volume NN" run should process, looked up by
 * installment number IN THE MANIFEST (not by parsing the folder name — the
 * intake agent chooses folder names, so the "(NN)" convention is no longer a
 * contract). An exact folder name also matches.
 *
 * @param {TranslationTargetManifest} manifest - The validated manifest.
 * @param {string} volumeArg - The "--volume" argument ("1", "01", or a folder name).
 * @returns {string[]} The matching folder names, in manifest order.
 */
function filterVolumesByInstallment(manifest, volumeArg) {
  const raw = String(volumeArg ?? "").trim();
  const volumes = manifest.volumes || [];
  // A number means "the volume at this reading-order position"; anything else
  // is matched as an exact folder name (a folder name can legitimately be a
  // word, a title, or a source-language string).
  if (/^\d{1,4}$/.test(raw)) {
    const wanted = normalizeInstallmentNumber(raw, "--volume value");
    return volumes.filter((v) => v.installmentNumber === wanted || v.folder === raw).map((v) => v.folder);
  }
  return volumes.filter((v) => v.folder === raw).map((v) => v.folder);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  extractJsonObject,
  installmentNumberFromDir,
  normalizeInstallmentNumber,
  sanitizeFolderName,
  filterVolumesByInstallment,
};

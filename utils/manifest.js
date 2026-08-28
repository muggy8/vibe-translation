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
 * @returns {object} The parsed outermost JSON object.
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

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  extractJsonObject,
  installmentNumberFromDir,
};

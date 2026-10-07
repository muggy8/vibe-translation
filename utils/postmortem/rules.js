/**
 * utils/postmortem/rules.js — what a finding is, and what a shape means.
 *
 * The one constructor for a finding (severity, kind, step, volume, file, message) and the
 * shape vocabulary the checks compare artifacts against. Nothing here reads a file: it is
 * the vocabulary the file checks speak in.
 */

const path = require("path");

const { hasDocumentShape } = require("../fs");
const { seriesArtifactFile } = require("../../configs/shared");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */

// ─── Shape rules ──────────────────────────────────────────────────────────────

/**
 * Whether text holds a Markdown table — a pipe row followed by a `|---|` separator.
 *
 * Kept separate from {@link hasDocumentShape} (heading OR table) because the
 * glossary is the one artifact whose whole contract IS a table: a glossary written
 * as prose has lost the structure every downstream reader parses.
 *
 * @param {string} content
 * @returns {boolean}
 */
function hasTableShape(content) {
  const lines = String(content || "").split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const row = lines[i].trim();
    const sep = lines[i + 1].trim();
    if (row.startsWith("|") && /^\|[\s|:-]+\|/.test(sep) && /-/.test(sep)) return true;
  }
  return false;
}

/**
 * Whether text satisfies one expectation's declared shape.
 *
 * @param {string} content - The file's contents.
 * @param {"document"|"table"|"json"|"any"} [shape]
 * @returns {boolean}
 */
function matchesShape(content, shape) {
  if (!shape || shape === "any") return true;
  if (shape === "table") return hasTableShape(content);
  if (shape === "document") return hasDocumentShape(content);
  if (shape === "json") {
    try {
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

// ─── Finding helpers ──────────────────────────────────────────────────────────

/**
 * Build one finding.
 *
 * @param {"HIGH"|"MEDIUM"|"LOW"} severity
 * @param {string} kind
 * @param {string} step
 * @param {string|null} volume
 * @param {string} file
 * @param {string} message
 * @returns {PostMortemFinding}
 */
function finding(severity, kind, step, volume, file, message) {
  return { severity, kind, step, volume, file, message };
}

/**
 * Where a series-root artifact actually lives. The four cumulative copies honour
 * `SERIES_ARTIFACTS_DIR` and their legacy per-file overrides, so looking for them
 * at the series root unconditionally would report a false "missing" on a machine
 * that moved them.
 *
 * @param {string} fileName
 * @param {string} seriesDir
 * @returns {string} Absolute path.
 */
function seriesArtifactPath(fileName, seriesDir) {
  const legacyKeys = {
    "glossary.md": "GLOSSARY_OUTPUT_FILE",
    "character-voice.md": "VOICE_OUTPUT_FILE",
    "style-guide.md": "STYLE_OUTPUT_FILE",
    "shared-wiki.md": "SHARED_WIKI_OUTPUT_FILE",
  };
  return seriesArtifactFile(fileName, legacyKeys[fileName] || "", seriesDir);
}

module.exports = { hasTableShape, matchesShape, finding, seriesArtifactPath };

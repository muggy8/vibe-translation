/**
 * utils/postmortem/rules.js — what a finding is, and what a shape means.
 *
 * The one constructor for a finding (severity, kind, level, step, volume, file, message) and the shape
 * vocabulary the checks compare artifacts against. Nothing here reads a file: it is the vocabulary the
 * file checks speak in. The level comes from ./levels.js, which is data in a closed path so the role
 * being investigated cannot re-grade the finding it is investigated for.
 */

const path = require("path");

const { hasDocumentShape } = require("../fs");
const { seriesArtifactFile } = require("../../configs/shared");
const { FINDING_LEVELS, levelFor } = require("./levels");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */
/** @typedef {import("./levels").FindingLevel} FindingLevel */

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
 * The level is looked up here, at the moment the finding is built, so it travels with the finding into
 * the report, the JSON sidecar and the triage instead of being re-derived by whoever reads them
 * (`utils/postmortem/plan/01-finding-levels.md` §6). A kind with no row in the table gets `"MINOR"` —
 * investigated, never a halt — **and its message says so**, because a default that is invisible is how
 * an unclassified kind ends up reported as a small one.
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
  const declared = Boolean(FINDING_LEVELS[kind]);
  const level = levelFor(kind);
  return {
    severity,
    kind,
    level,
    step,
    volume,
    file,
    message: declared
      ? message
      : `${message} [level undeclared for kind "${kind}" — reported at MINOR, which is the safe default and not a judgement about this finding]`,
  };
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

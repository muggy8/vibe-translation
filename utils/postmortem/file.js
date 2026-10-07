/**
 * utils/postmortem/file.js — one file, one verdict.
 *
 * The smallest unit of the assessment: does this file exist, is it real content rather than a
 * scaffold stub, and does it have the shape the step's declared output promises? A file that
 * cannot be read is reported as unreadable, never as empty — the direction of error that gets
 * accepted work deleted.
 */

const fs = require("fs");

const { isPlaceholderContent } = require("../fs");
const { matchesShape, finding } = require("./rules");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */

// ─── One file ─────────────────────────────────────────────────────────────────

/**
 * Assess one expected file. Returns a finding, or null when the file is what it
 * should be.
 *
 * @param {string} filePath - Absolute path.
 * @param {import("./artifacts").ArtifactExpectation} expectation
 * @param {string} step
 * @param {string|null} volume
 * @param {string} displayPath - The path to name in the finding.
 * @returns {Promise<PostMortemFinding|null>}
 */
async function assessFile(filePath, expectation, step, volume, displayPath) {
  let content;
  try {
    content = await fs.promises.readFile(filePath, "utf8");
  } catch {
    const severity = expectation.level === "required" ? "HIGH" : "MEDIUM";
    return finding(
      severity,
      expectation.level === "required" ? "missing-required" : "missing-expected",
      step,
      volume,
      displayPath,
      `${expectation.name} was never written${expectation.why ? ` — ${expectation.why}` : ""}`
    );
  }

  if (isPlaceholderContent(content)) {
    return finding(
      "HIGH",
      "empty-or-stub",
      step,
      volume,
      displayPath,
      `${expectation.name} exists but is empty or still holds a scaffold stub ` +
        `(${content.trim().length} chars). A stage wrote its scaffolding and never ` +
        `its output.`
    );
  }

  const shape = expectation.shape || "any";
  if (shape === "json") {
    try {
      JSON.parse(content);
    } catch (err) {
      return finding(
        "HIGH",
        "bad-json",
        step,
        volume,
        displayPath,
        `${expectation.name} is not parseable JSON (${err.message}). Every reader of ` +
          `this file parses it, so a half-written file is worse than a missing one.`
      );
    }
    return null;
  }

  if (!matchesShape(content, shape)) {
    return finding(
      "MEDIUM",
      "wrong-shape",
      step,
      volume,
      displayPath,
      `${expectation.name} is ${content.trim().length} chars but has no ` +
        `${shape === "table" ? "Markdown table" : "Markdown heading or table"}. ` +
        `The prompt that writes it specifies that shape, so this is not that document.`
    );
  }
  return null;
}

module.exports = { assessFile };

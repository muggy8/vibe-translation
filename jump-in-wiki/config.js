/**
 * Where this task's prompt files live and how many QA iterations it allows.
 *
 * clientDir is the project root: a module in this folder reaches it through projectRoot,
 * not through its own __dirname, which points at the folder.
 *
 * Part of the jump-in-wiki.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types"); // JSDoc type definitions
const projectRoot = path.resolve(__dirname, "..");

const clientDir = projectRoot;

const seriesDir = process.env.SERIES_LOCATION;

const systemPromptFile = path.join(clientDir, "system-prompts", "jump-in-wiki.md");

const userPromptTemplateFile = path.join(clientDir, "user-prompts", "jump-in-wiki.md");

const validatorSystemPromptFile = path.join(clientDir, "system-prompts", "jump-in-wiki-validator.md");

const validatorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "jump-in-wiki-validator.md");

const feedbackSystemPromptFile = path.join(clientDir, "system-prompts", "jump-in-wiki-feedback.md");

const feedbackUserPromptTemplateFile = path.join(clientDir, "user-prompts", "jump-in-wiki-feedback.md");

const acceptanceSystemPromptFile = path.join(clientDir, "system-prompts", "jump-in-wiki-acceptance.md");

const acceptanceUserPromptTemplateFile = path.join(clientDir, "user-prompts", "jump-in-wiki-acceptance.md");


// Maximum number of validation -> acceptance -> feedback iterations per volume
// before the wiki is left as-is. Read from .env, defaulting to 3.
const maxValidationIterations = Math.max(
  1,
  parseInt(process.env.QA_MAX_ITERATIONS, 10) || 3
);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Safety net for agent runs: if the expected output file is missing but the
 * agent wrote a different .md file in the volume folder (e.g. a classic
 * marker name), rename the best candidate to the expected name.
 *
 * REMOVED: This function was removed after the prompts were updated to use
 * agent-mode file names directly. The agent now consistently writes to the
 * correct file names, making this safety net unnecessary. Kept here as a
 * reference in case it needs to be re-enabled for a future model regression.
 *
 * @param {string} volumeDir - The volume folder the expected file belongs to.
 * @param {string} expectedBase - The expected file name (e.g. "wiki.md").
 * @param {Set<string>} knownFiles - File names that must never be adopted.
 * @returns {Promise<boolean>} True when a stray file was adopted.
 */
/*
async function adoptStrayOutput(volumeDir, expectedBase, knownFiles) {
  const expectedPath = path.join(volumeDir, expectedBase);
  if (await fileExists(expectedPath)) return false;
  const wantShared = expectedBase.includes("shared");
  const candidates = [];
  for (const name of await fs.readdir(volumeDir)) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    if (name === expectedBase || knownFiles.has(name)) continue;
    const lower = name.toLowerCase();
    if (lower.includes("validation")) continue;
    if (wantShared !== lower.includes("shared")) continue;
    const st = await fs.stat(path.join(volumeDir, name)).catch(() => null);
    if (!st || st.size === 0) continue;
    let score = 0;
    if (lower.includes("wiki")) score += 2;
    if (!wantShared && /\d/.test(lower)) score += 1;
    candidates.push({ name, st, score });
  }
  if (candidates.length === 0) return false;
  candidates.sort((a, b) => b.score - a.score || b.st.mtimeMs - a.st.mtimeMs);
  const pick = candidates[0];
  await fs.rename(path.join(volumeDir, pick.name), expectedPath);
  console.log(
    `Adopted "${pick.name}" as "${expectedBase}" (the agent used a different file name).`
  );
  return true;
}
*/


module.exports = {
  clientDir,
  seriesDir,
  systemPromptFile,
  userPromptTemplateFile,
  validatorSystemPromptFile,
  validatorUserPromptTemplateFile,
  feedbackSystemPromptFile,
  feedbackUserPromptTemplateFile,
  acceptanceSystemPromptFile,
  acceptanceUserPromptTemplateFile,
  maxValidationIterations,
};

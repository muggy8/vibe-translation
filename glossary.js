/**
 * glossary.js — Logic for the "glossary" gulp task: building the canonical
 * target-language glossary for the series, driven from the source text, one
 * volume at a time.
 *
 * Task: glossary
 *   For each volume (in natural order):
 *     1. Read the volume's source text and the previous volume's glossary
 *        snapshot (the in-progress glossary; absent for the first volume).
 *     2. Extract only the NEW terms found in this volume's source (not already
 *        in the previous glossary) using the extraction prompts
 *        (system-prompts/glossary-terms.md and user-prompts/glossary-terms.md).
 *     3. Research those new terms (client-side, via research.js).
 *     4. Amend the glossary — carry forward every existing term and add the new
 *        ones, informed by the research — using the amend prompts
 *        (system-prompts/glossary.md and user-prompts/glossary.md).
 *     5. Save a per-volume snapshot to <volume folder>/glossary.md.
 *     6. Run the QA loop until the glossary passes the acceptance check or the
 *        iteration cap (MAX_VALIDATION_ITERATIONS, default 3) is reached:
 *          a. Validate the glossary against the source (glossary-validator.md),
 *             saving the report to <volume folder>/glossary-validation.md.
 *          b. Acceptance check (glossary-acceptance.md): PASS or FAIL.
 *          c. On PASS, stop. Otherwise, apply the feedback (glossary-feedback.md)
 *             and repeat from (a).
 *   After all volumes, the last volume's glossary.md is copied to the series
 *   root (GLOSSARY_OUTPUT_FILE, default <SERIES_LOCATION>/glossary.md).
 *
 * Idempotent: a volume whose glossary already exists and passes the acceptance
 * check is skipped (unless --force). If any volume is regenerated, all later
 * volumes are regenerated too (each volume's glossary is built on the previous
 * one's, so a change propagates forward).
 *
 * Usage:
 *   npx gulp glossary             # run the full task
 *   npx gulp glossary --dry-run   # transform the prompts only, no API/research
 *   npx gulp glossary --force     # regenerate even if the glossary exists
 */

require("dotenv").config();
const { orderBy } = require("natural-orderby");
const fs = require("fs").promises;
const path = require("path");
const { callAi } = require("./call-ai");
const { researchTerms, formatResearchNotes } = require("./research");
const { transformUserPrompt, installmentNumberFromDir } = require("./jump-in-wiki");

// ─── Paths ──────────────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const termsSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-terms.md");
const termsUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-terms.md");
const glossarySystemPromptFile = path.join(clientDir, "system-prompts", "glossary.md");
const glossaryUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary.md");
const validatorSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-validator.md");
const validatorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-validator.md");
const acceptanceSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-acceptance.md");
const acceptanceUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-acceptance.md");
const feedbackSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-feedback.md");
const feedbackUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-feedback.md");

// Maximum number of validation -> acceptance -> feedback iterations per volume
// before the glossary is left as-is. Read from .env, defaulting to 3.
const maxValidationIterations = Math.max(
  1,
  parseInt(process.env.MAX_VALIDATION_ITERATIONS, 10) || 3
);

// Whether to run client-side web research for the new terms (default: enabled).
const researchEnabled = process.env.RESEARCH_ENABLED !== "false";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse the AI's term-list output into an array of { term, type, query }.
 * Tolerates markdown fences and surrounding prose.
 *
 * @param {string} output - The raw AI output.
 * @returns {Array<{term: string, type: string, query: string}>}
 */
function parseTerms(output) {
  if (!output || typeof output !== "string") {
    return [];
  }
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new Error("No JSON array found in the term-list output.");
  }
  const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("The term-list output was not a JSON array.");
  }
  return parsed
    .filter((entry) => entry && typeof entry.term === "string" && entry.term.trim() !== "")
    .map((entry) => ({
      term: entry.term.trim(),
      type: typeof entry.type === "string" && entry.type.trim() !== "" ? entry.type.trim() : "concept",
      query: typeof entry.query === "string" && entry.query.trim() !== "" ? entry.query.trim() : entry.term.trim(),
    }));
}

/**
 * Check whether a file exists.
 *
 * @param {string} filePath - The path to check.
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the glossary task.
 */
async function glossary() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  
  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }

  // Load the system prompts.
  const termsSystemPrompt = await fs.readFile(termsSystemPromptFile, "utf-8");
  const glossarySystemPrompt = await fs.readFile(glossarySystemPromptFile, "utf-8");
  const validatorSystemPrompt = await fs.readFile(validatorSystemPromptFile, "utf-8");
  const acceptanceSystemPrompt = await fs.readFile(acceptanceSystemPromptFile, "utf-8");
  const feedbackSystemPrompt = await fs.readFile(feedbackSystemPromptFile, "utf-8");

  // Load the prompt templates.
  const termsTemplate = await fs.readFile(termsUserPromptTemplateFile, "utf-8");
  const glossaryTemplate = await fs.readFile(glossaryUserPromptTemplateFile, "utf-8");
  const validatorTemplate = await fs.readFile(validatorUserPromptTemplateFile, "utf-8");
  const acceptanceTemplate = await fs.readFile(acceptanceUserPromptTemplateFile, "utf-8");
  const feedbackTemplate = await fs.readFile(feedbackUserPromptTemplateFile, "utf-8");

  // Find all volume folders (sorted in natural order).
  const entries = await fs.readdir(seriesDir, { withFileTypes: true });
  const folderNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.includes(process.env.SERIES_NAME_SOURCE));
  const sorted = orderBy(folderNames);

  if (sorted.length === 0) {
    throw new Error(`No volume folders found in ${seriesDir}.`);
  }

  console.log(`Found ${sorted.length} volume folder(s). Processing in order...`);

  // Once any volume is regenerated, all later volumes must be regenerated too
  // (each volume's glossary is built on the previous one's).
  let regeneratedAny = false;

  for (let i = 0; i < sorted.length; i++) {
    const folderName = sorted[i];
    const volumeDir = path.join(seriesDir, folderName);
    const sourceFile = path.join(volumeDir, `${folderName}.md`);
    const glossaryOutputFile = path.join(volumeDir, "glossary.md");
    const validationOutputFile = path.join(volumeDir, "glossary-validation.md");

    if (!(await fileExists(sourceFile))) {
      throw new Error(`Required source file not found: ${sourceFile}`);
    }

    const values = {
      INSTALLMENT_NUMBER: installmentNumberFromDir(volumeDir),
      SOURCE_NAME: process.env.SERIES_NAME_SOURCE,
      SOURCE_LANGUAGE: process.env.SOURCE_LANGUAGE || "Japanese",
      TARGET_LANGUAGE: process.env.TARGET_LANGUAGE || "English",
    };

    console.log("\n--dry-run: skipping the AI calls and research. Transformed prompts (volume 1) follow.");
    console.log("\n--- new-term extraction user prompt ---\n" + transformUserPrompt(termsTemplate, values));
    console.log("\n--- validator user prompt ---\n" + transformUserPrompt(validatorTemplate, values));
    console.log("\n--- feedback user prompt ---\n" + transformUserPrompt(feedbackTemplate, values));
    console.log("\n--- acceptance user prompt ---\n" + transformUserPrompt(acceptanceTemplate, values));
    console.log("\n--- amend user prompt (template; {{TERMS_LIST}} and {{RESEARCH_NOTES}} are filled at runtime) ---\n" + glossaryTemplate);

    if (dryRun) {
      continue;
    }

    // The previous volume's glossary (the in-progress glossary). Absent for the first volume.
    const isFirst = i === 0;
    let previousGlossaryFile = null;
    if (!isFirst) {
      previousGlossaryFile = path.join(seriesDir, sorted[i - 1], "glossary.md");
      if (!(await fileExists(previousGlossaryFile))) {
        throw new Error(
          `Previous glossary not found: ${previousGlossaryFile}. ` +
          `Process the earlier volume first (or re-run without --force).`
        );
      }
    }

    // Transform the prompts that use only the standard placeholders.
    const termsPrompt = transformUserPrompt(termsTemplate, values);
    const validatorPrompt = transformUserPrompt(validatorTemplate, values);
    const feedbackPrompt = transformUserPrompt(feedbackTemplate, values);
    const acceptancePrompt = transformUserPrompt(acceptanceTemplate, values);

    // Idempotency: skip a volume whose glossary already exists and passes,
    // unless a previous volume was regenerated (which would make it stale).
    let skip = false;
    if (!force && !regeneratedAny && (await fileExists(glossaryOutputFile))) {
      try {
        const acceptanceOutput = await callAi(
          acceptanceSystemPrompt,
          [
            { file: validationOutputFile, name: "glossary-validation.md" },
            { text: acceptancePrompt },
          ],
        );
        skip = acceptanceOutput.toUpperCase().includes("PASS");
      } catch {
        skip = false;
      }
    }
    if (skip) {
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: glossary already exists and passed. Skipping.`);
      continue;
    }

    // A volume is being (re)generated; later volumes depend on it.
    regeneratedAny = true;

    // The base messages: the source text + the previous glossary (if any).
    const baseMessages = [{ file: sourceFile, name: path.basename(sourceFile) }];
    if (!isFirst) {
      baseMessages.push({ file: previousGlossaryFile, name: "glossary-previous.md" });
    }

    // Pass 1: extract the new terms from this volume's source.
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: extracting new terms...`);
    const termsOutput = await callAi(termsSystemPrompt, [...baseMessages, { text: termsPrompt }]);
    let terms = [];
    try {
      terms = parseTerms(termsOutput);
    } catch (err) {
      console.warn(`Volume ${values.INSTALLMENT_NUMBER}: could not parse the term list (${err.message}). Continuing without research.`);
    }
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: extracted ${terms.length} new term(s).`);

    // Research the new terms.
    let researchNotesText = "(research disabled or no new terms to research)";
    if (researchEnabled && terms.length > 0) {
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: researching ${terms.length} new term(s)...`);
      const notes = await researchTerms(terms);
      researchNotesText = formatResearchNotes(notes);
    }

    // Pass 2: amend the glossary (carry forward + add new terms).
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: amending the glossary...`);
    const termsListText = terms.length > 0
      ? terms.map((t) => `- ${t.term} (${t.type})`).join("\n")
      : "(no new terms found in this volume)";
    const amendPrompt = transformUserPrompt(glossaryTemplate, {
      ...values,
      TERMS_LIST: termsListText,
      RESEARCH_NOTES: researchNotesText,
    });
    const amendOutput = await callAi(glossarySystemPrompt, [...baseMessages, { text: amendPrompt }]);
    await fs.writeFile(glossaryOutputFile, amendOutput.trim(), "utf-8");
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: saved the glossary to ${glossaryOutputFile}`);

    // QA loop: validate -> acceptance -> feedback.
    for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: validation iteration ${iteration}/${maxValidationIterations}...`);

      // Validate the amended glossary against the source.
      const validationReport = await callAi(
        validatorSystemPrompt,
        [
          ...baseMessages,
          { file: glossaryOutputFile, name: "glossary.md" },
          { text: validatorPrompt },
        ],
      );
      await fs.writeFile(validationOutputFile, validationReport, "utf-8");

      // Acceptance check.
      const acceptanceOutput = await callAi(
        acceptanceSystemPrompt,
        [
          { file: validationOutputFile, name: "glossary-validation.md" },
          { text: acceptancePrompt },
        ],
      );
      const accepted = acceptanceOutput.toUpperCase().includes("PASS");
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: acceptance check: ${accepted ? "PASS" : "FAIL"}`);

      // Apply the feedback.
      const feedbackOutput = await callAi(
        feedbackSystemPrompt,
        [
          ...baseMessages,
          { file: validationOutputFile, name: "glossary-validation.md" },
          { file: glossaryOutputFile, name: "glossary.md" },
          { text: feedbackPrompt },
        ],
      );
      await fs.writeFile(glossaryOutputFile, feedbackOutput.trim(), "utf-8");
      
      if (accepted) {
        break;
      }

      if (iteration === maxValidationIterations) {
        console.log(`Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit. Leaving the glossary as-is.`);
        break;
      }
    }
  }

  // Copy the last volume's glossary to the series root for easy access.
  const finalGlossaryFile = process.env.GLOSSARY_OUTPUT_FILE || path.join(seriesDir, "glossary.md");
  let lastGlossary = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const candidate = path.join(seriesDir, sorted[i], "glossary.md");
    if (await fileExists(candidate)) {
      lastGlossary = candidate;
      break;
    }
  }
  if (lastGlossary) {
    await fs.copyFile(lastGlossary, finalGlossaryFile);
    console.log(`\nCopied the final glossary to: ${finalGlossaryFile}`);
  } else {
    console.log("\nNo glossary snapshots found; nothing to copy to the series root.");
  }
}

// ─── Export for use as a module ─────────────────────────────────────────────

module.exports = { glossary, parseTerms };

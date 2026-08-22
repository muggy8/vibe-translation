/**
 * jump-in-wiki.js — Logic for the "jump-in-wiki" gulp task: generating the
 * jump-in wiki for each volume of the series.
 *
 * Task: jump-in-wiki
 *   1. Loads the system prompt from system-prompts/jump-in-wiki.md.
 *   2. Loads the user prompt template from user-prompts/jump-in-wiki.md.
 *   3. Transforms the template by filling in its placeholders:
 *        {{INSTALLMENT_NUMBER}} — derived from the volume folder name,
 *                                 zero-padded (e.g. "(1)" -> "01") to match
 *                                 the jump-in-wiki-NN.md naming convention.
 *        {{SOURCE_NAME}}        — SERIES_NAME_SOURCE from .env
 *        {{SOURCE_LANGUAGE}}    — SOURCE_LANGUAGE from .env (default: Japanese)
 *   4. Calls the AI (call-ai.js) with the system prompt, the transformed
 *      user prompt, and the volume source file.
 *   5. Saves the generated volume wiki to <volume folder>/wiki.md and the
 *      updated shared wiki to <volume folder>/shared-wiki.md.
 *   6. Repeats the following until the wiki passes the acceptance check or the
 *      iteration cap (MAX_VALIDATION_ITERATIONS, default 3) is reached:
 *        a. Validates the wiki with the validator prompts
 *           (system-prompts/jump-in-wiki-validator.md and
 *           user-prompts/jump-in-wiki-validator.md), saving the report to
 *           <volume folder>/jump-in-wiki-validation-NN.md.
 *        b. Asks the acceptance prompts (system-prompts/jump-in-wiki-acceptance.md
 *           and user-prompts/jump-in-wiki-acceptance.md) whether the wiki is a
 *           passing grade (PASS) or not (FAIL).
 *        c. On PASS, stops. Otherwise, applies the feedback prompts
 *           (system-prompts/jump-in-wiki-feedback.md and
 *           user-prompts/jump-in-wiki-feedback.md) to correct the wiki, saving
 *           back to <volume folder>/wiki.md and <volume folder>/shared-wiki.md,
 *           then repeats from (a).
 *
 * Usage:
 *   npx gulp jump-in-wiki             # run the full task
 *   npx gulp jump-in-wiki --dry-run   # transform the prompt only, no API call
 */

require("dotenv").config();
const { orderBy } = require("natural-orderby");
const fs = require("fs").promises;
const path = require("path");
const { callAi } = require("./call-ai");

// ─── Paths ──────────────────────────────────────────────────────────────────

const clientDir = __dirname;
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
  parseInt(process.env.MAX_VALIDATION_ITERATIONS, 10) || 3
);


// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Derive the zero-padded installment number from the volume folder name.
 * e.g. "俺を好きなのはお前だけかよ(1)" -> "01"
 *
 * @param {string} dir - The volume folder path.
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
 * Fill in the {{PLACEHOLDER}} values in the user prompt template.
 *
 * @param {string} template - The raw template text.
 * @param {Record<string, string>} values - The placeholder values.
 * @returns {string} The transformed prompt.
 */
function transformUserPrompt(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string" || !value) {
      throw new Error(`Missing value for placeholder: {{${key}}}`);
    }
    result = result.split(`{{${key}}}`).join(value);
  }
  const leftover = result.match(/\{\{[A-Z0-9_]+\}\}/);
  if (leftover) {
    throw new Error(`Unfilled placeholder left in user prompt: ${leftover[0]}`);
  }
  return result;
}

/**
 * the output of the AI should be in the following format: 
 * 
 * `---- jump-in-wiki-{{INSTALLMENT_NUMBER}}.md ----
 * 
 * Contents of the jump in wiki
 * 
 * ---- jump-in-wiki-shared.md ----
 * 
 * Updated contents of the shared jump in wiki.
 * 
 * ---- end ----`
 * 
 * the goal of this function is to split this string up up and return 
 * ['Contents of the jump in wiki', 'Updated contents of the shared jump in wiki.']. 
 * sometimes the text `---- end ----` isn't included as the output comes from an AI 
 * and is non deterministic. this function basically handles all those pesky edge cases
 * trimming the empty spaces and returns 2 clean strings to be saved into a file.
 * @param {String} outputFromAi - the string that's outputted form the ai. 
 * @returns {[String, String]} - the 2 sections of the output to be saved.
 */
function splitJumpInWikiGenerationOutput (outputFromAi) {
  // Normalise line endings and split into lines
  const lines = outputFromAi.replace(/\r\n/g, "\n").split("\n");

  // Find the two content sections by their marker lines.
  // Markers look like: "---- jump-in-wiki-NN.md ----" or "---- jump-in-wiki-shared.md ----"
  const wikiMarkerRe   = /^----\s+jump-in-wiki-?\d*\.md\s+----$/;
  const sharedMarkerRe = /^----\s+jump-in-wiki-shared\.md\s+----$/;
  const endMarkerRe    = /^----\s+end\s+----$/;

  let wikiMarkerIdx   = -1;
  let sharedMarkerIdx = -1;
  let endIdx          = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (wikiMarkerIdx === -1 && wikiMarkerRe.test(trimmed)) {
      wikiMarkerIdx = i;
    } else if (sharedMarkerIdx === -1 && sharedMarkerRe.test(trimmed)) {
      sharedMarkerIdx = i;
    }
    if (endMarkerRe.test(trimmed)) {
      endIdx = i;
    }
  }

  // Content starts one line after each marker
  const wikiStart   = wikiMarkerIdx   !== -1 ? wikiMarkerIdx   + 1 : 0;
  const sharedStart = sharedMarkerIdx !== -1 ? sharedMarkerIdx + 1 : lines.length;
  // Shared content ends at the end marker or at the end of the file
  const sharedEnd   = endIdx !== -1 ? endIdx : lines.length;

  // Extract raw sections
  const wikiRaw   = wikiMarkerIdx   !== -1 ? lines.slice(wikiStart,   sharedMarkerIdx).join("\n") : "";
  const sharedRaw = sharedMarkerIdx !== -1 ? lines.slice(sharedStart, sharedEnd).join("\n")       : "";

  // Trim leading/trailing blank lines from each section
  const trimBlank = (s) => s.replace(/^\n+|\n+$/g, "");

  return [trimBlank(wikiRaw), trimBlank(sharedRaw)];
}

// ─── Task ───────────────────────────────────────────────────────────────────

async function jumpInWiki() {
  const dryRun = process.argv.includes("--dry-run");
  
  const seriesLocationContents = await fs.readdir(process.env.SERIES_LOCATION,  { withFileTypes: true });
  const folderWithSourceMaterial = seriesLocationContents
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(path => path.includes(process.env.SERIES_NAME_SOURCE));

  const sortedFolderWithSourceMaterial = orderBy(folderWithSourceMaterial);

  const systemPrompt = await fs.readFile(systemPromptFile, "utf-8");
  const template = await fs.readFile(userPromptTemplateFile, "utf-8");
  const validatorSystemPrompt = await fs.readFile(validatorSystemPromptFile, "utf-8");
  const validatorTemplate = await fs.readFile(validatorUserPromptTemplateFile, "utf-8");
  const feedbackSystemPrompt = await fs.readFile(feedbackSystemPromptFile, "utf-8");
  const feedbackTemplate = await fs.readFile(feedbackUserPromptTemplateFile, "utf-8");
  const acceptanceSystemPrompt = await fs.readFile(acceptanceSystemPromptFile, "utf-8");
  const acceptanceTemplate = await fs.readFile(acceptanceUserPromptTemplateFile, "utf-8");

  let limitReachedCount = 0;

  for (let i = 0; i < sortedFolderWithSourceMaterial.length; i++) {
    const folderName = sortedFolderWithSourceMaterial[i];
    const volumeDir = path.join(seriesDir, folderName);
    const sourceFile = path.join(volumeDir, `${folderName}.md`);
    const wikiOutputFile = path.join(volumeDir, "wiki.md");
    const sharedWikiOutputFile = path.join(volumeDir, "shared-wiki.md");

    try {
      await fs.access(sourceFile);
    } catch (err) {
      throw new Error(`Required file not found: ${sourceFile}`);
    }

    const values = {
      INSTALLMENT_NUMBER: installmentNumberFromDir(volumeDir),
      SOURCE_NAME: process.env.SERIES_NAME_SOURCE,
      SOURCE_LANGUAGE: process.env.SOURCE_LANGUAGE || "Japanese",
    };

    const userPrompt = transformUserPrompt(template, values);

    const validationOutputFile = path.join(
      volumeDir,
      `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`
    );

    const validatorValues = {
      INSTALLMENT_NUMBER: values.INSTALLMENT_NUMBER,
      SOURCE_NAME: values.SOURCE_NAME,
      SOURCE_LANGUAGE: values.SOURCE_LANGUAGE,
      INSTALLMENT_NUMBER_MINUS_ONE: String(
        parseInt(values.INSTALLMENT_NUMBER, 10) - 1
      ).padStart(2, "0"),
    };
    const validatorUserPrompt = transformUserPrompt(validatorTemplate, validatorValues);

    const feedbackValues = {
      INSTALLMENT_NUMBER: values.INSTALLMENT_NUMBER,
      SOURCE_NAME: values.SOURCE_NAME,
      SOURCE_LANGUAGE: values.SOURCE_LANGUAGE,
    };
    const feedbackUserPrompt = transformUserPrompt(feedbackTemplate, feedbackValues);

    const acceptanceValues = {
      INSTALLMENT_NUMBER: values.INSTALLMENT_NUMBER,
      SOURCE_NAME: values.SOURCE_NAME,
    };
    const acceptanceUserPrompt = transformUserPrompt(acceptanceTemplate, acceptanceValues);

    console.log(`Installment number:      ${values.INSTALLMENT_NUMBER}`);
    console.log(`Source name:             ${values.SOURCE_NAME}`);
    console.log(`Source language:         ${values.SOURCE_LANGUAGE}`);
    console.log(`Source file:             ${sourceFile}`);
    console.log(`Wiki Output file:        ${wikiOutputFile}`);
    console.log(`Shared Wiki Output file: ${sharedWikiOutputFile}`);
    console.log(`Validation Output file:  ${validationOutputFile}`);

    if (dryRun) {
      console.log("--dry-run: skipping the AI call. Transformed user prompt follows:");
      console.log(userPrompt);
      console.log("\n--dry-run: transformed validator user prompt follows:");
      console.log(validatorUserPrompt);
      console.log("\n--dry-run: transformed feedback user prompt follows:");
      console.log(feedbackUserPrompt);
      console.log("\n--dry-run: transformed acceptance user prompt follows:");
      console.log(acceptanceUserPrompt);
      continue;
    }

    /**
     * Logic to make sure we don't redo any work that has already been done.
     */
    let currentVolumeHasAlreadyBeenProcessed = true;
    try {
      await fs.access(validationOutputFile)

      console.log("checking if the current version is already deemed acceptable in a previous run.");

      const acceptanceOutput = await callAi(
        acceptanceSystemPrompt,
        { file: validationOutputFile, name: `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md` },
        { text: acceptanceUserPrompt },
      );
      const accepted = acceptanceOutput.toUpperCase().includes("PASS");
    } catch (err) {
      currentVolumeHasAlreadyBeenProcessed = false;
    }
    
    if (currentVolumeHasAlreadyBeenProcessed) {
      console.log('the current volume has already been processed by a previous run. skipping the current volume.')
      continue;
    }

    /**
     * generating the initial wiki is expensive, so we gotta check if it's already been
     * generated and if so, we can skip the initial generation step.
     */

    let wikiAndSharedWikiExists = true;
    try {
      await fs.access(wikiOutputFile);
      await fs.access(sharedWikiOutputFile);
    } catch (err) {
      wikiAndSharedWikiExists = false;
    }

    /**
     * set some variables
     */
    const isFirst = i === 0;
    let previousFolderName = null;
    let previousWikiOutputFile = null;
    let previousSharedWikiOutputFile = null;
    
    if (!isFirst) {
      previousFolderName = sortedFolderWithSourceMaterial[i-1];
      const previousVolumeDir = path.join(seriesDir, previousFolderName);
      previousWikiOutputFile = path.join(previousVolumeDir, "wiki.md");
      previousSharedWikiOutputFile = path.join(previousVolumeDir, "shared-wiki.md");
    }

    /**
     * the logic for generating the wiki
     */      

    if (wikiAndSharedWikiExists) {
      console.log("Wiki for the current volume exists. skipping initial generation and proceeding to validation");
    } else {
      console.log("Calling the AI for initial wiki generation...");
      let output;
      if (isFirst) {
        output = await callAi(
          systemPrompt,
          { file: sourceFile, name: path.basename(sourceFile) },
          { text: userPrompt },
        );
      } else {
        output = await callAi(
          systemPrompt,
          { file: sourceFile, name: path.basename(sourceFile) },
          { file: previousWikiOutputFile, name: "previous-jump-in-wiki.md" },
          { file: previousSharedWikiOutputFile, name: "jump-in-wiki-shared.md" },
          { text: userPrompt },
        )
      }

      const [wiki, sharedWiki] = splitJumpInWikiGenerationOutput(output);
      
      await fs.writeFile(wikiOutputFile, wiki, "utf-8");
      await fs.writeFile(sharedWikiOutputFile, sharedWiki, "utf-8");
    }


    /**
     * the logic for validating the generated wiki, checking acceptance, and
     * applying the validation feedback — repeated until the wiki passes the
     * acceptance check or the iteration cap is reached.
     */
    for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
      console.log(`Validation iteration ${iteration}/${maxValidationIterations}...`);

      /**
       * the logic for validating the generated wiki
       */
      console.log("Calling the AI for validation...");

      const validationMessages = [
        { file: sourceFile, name: path.basename(sourceFile) },
        { file: wikiOutputFile, name: `jump-in-wiki-${values.INSTALLMENT_NUMBER}.md` },
        { file: sharedWikiOutputFile, name: "jump-in-wiki-shared.md" },
      ];
      if (!isFirst) {
        validationMessages.push({
          file: previousSharedWikiOutputFile,
          name: "jump-in-wiki-shared.old.md",
        });
      }
      validationMessages.push({ text: validatorUserPrompt });

      const validationReport = await callAi(validatorSystemPrompt, ...validationMessages);

      await fs.writeFile(validationOutputFile, validationReport, "utf-8");

      /**
       * the logic for checking whether the validated wiki is acceptable
       */
      console.log("Calling the AI for the acceptance check...");

      const acceptanceOutput = await callAi(
        acceptanceSystemPrompt,
        { file: validationOutputFile, name: `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md` },
        { text: acceptanceUserPrompt },
      );
      const accepted = acceptanceOutput.toUpperCase().includes("PASS");
      console.log(`Acceptance check: ${accepted ? "PASS" : "FAIL"}`);

      /**
       * the logic for applying the validation feedback to the generated wiki
       */
      console.log("Calling the AI to apply the validation feedback...");

      const feedbackMessages = [
        { file: sourceFile, name: path.basename(sourceFile) },
        { file: validationOutputFile, name: `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md` },
        { file: wikiOutputFile, name: `jump-in-wiki-${values.INSTALLMENT_NUMBER}.md` },
        { file: sharedWikiOutputFile, name: "jump-in-wiki-shared.md" },
      ];
      if (!isFirst) {
        feedbackMessages.push({
          file: previousWikiOutputFile,
          name: `jump-in-wiki-${validatorValues.INSTALLMENT_NUMBER_MINUS_ONE}.md`,
        });
        feedbackMessages.push({
          file: previousSharedWikiOutputFile,
          name: "jump-in-wiki-shared.old.md",
        });
      }
      feedbackMessages.push({ text: feedbackUserPrompt });

      const feedbackOutput = await callAi(feedbackSystemPrompt, ...feedbackMessages);

      const [correctedWiki, correctedSharedWiki] = splitJumpInWikiGenerationOutput(feedbackOutput);

      await fs.writeFile(wikiOutputFile, correctedWiki, "utf-8");
      await fs.writeFile(sharedWikiOutputFile, correctedSharedWiki, "utf-8");

      // prevent next loop after adding in feedback.
      if (accepted) {
        break;
      }

      if (iteration === maxValidationIterations) {
        limitReachedCount++;
        console.log(
          `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit ` +
          `(${maxValidationIterations}) without a passing grade. Leaving the wiki as-is.`
        );
        break;
      }
    }
  }

  if (limitReachedCount > 0) {
    console.log(
      `\n${limitReachedCount} of ${sortedFolderWithSourceMaterial.length} volume(s) reached the ` +
      `validation iteration limit (${maxValidationIterations}). Consider increasing ` +
      `MAX_VALIDATION_ITERATIONS if this is unexpected.`
    );
  }
}

// ─── Export for use as a module ─────────────────────────────────────────────

module.exports = {
  jumpInWiki,
  installmentNumberFromDir,
  transformUserPrompt,
  splitJumpInWikiGenerationOutput,
};

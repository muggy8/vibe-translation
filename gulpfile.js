/**
 * gulpfile.js — Gulp tasks for generating the jump-in wiki.
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
 *   5. Saves the raw AI output to <volume folder>/wiki.md.
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

    console.log(`Installment number:      ${values.INSTALLMENT_NUMBER}`);
    console.log(`Source name:             ${values.SOURCE_NAME}`);
    console.log(`Source language:         ${values.SOURCE_LANGUAGE}`);
    console.log(`Source file:             ${sourceFile}`);
    console.log(`Wiki Output file:        ${wikiOutputFile}`);
    console.log(`Shared Wiki Output file: ${sharedWikiOutputFile}`);

    if (dryRun) {
      console.log("--dry-run: skipping the AI call. Transformed user prompt follows:");
      console.log(userPrompt);
      continue;
    }

    console.log("Calling the AI...");

    const isFirst = i === 0;
    let output
    if (isFirst) {
      output = await callAi(
        systemPrompt,
        { file: sourceFile, name: path.basename(sourceFile) },
        { text: userPrompt },
      );
    } else {
      const previousFolderName = sortedFolderWithSourceMaterial[i-1];
      const previousVolumeDir = path.join(seriesDir, previousFolderName);
      const previousWikiOutputFile = path.join(previousVolumeDir, "wiki.md");
      const previousSharedWikiOutputFile = path.join(previousVolumeDir, "shared-wiki.md");

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
}

exports["jump-in-wiki"] = jumpInWiki;
exports.default = jumpInWiki;

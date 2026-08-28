/**
 * jump-in-wiki.js — Logic for the "jump-in-wiki" gulp task: generating the
 * jump-in wiki for each volume of the series.
 *
 * Task: jump-in-wiki
 *   For each volume (in natural order):
 *     1. Generate the two output files:
 *        - <volume folder>/wiki.md        (the volume wiki)
 *        - <volume folder>/shared-wiki.md (the updated "living" shared wiki)
 *        using the generation prompts (system-prompts/jump-in-wiki.md and
 *        user-prompts/jump-in-wiki.md):
 *        - RESEARCH_MODE=agent (default): an author agent (per-volume session)
 *          reads the source and previous wikis with file tools and writes both
 *          files directly (no marker-based output parsing).
 *        - RESEARCH_MODE=classic: a single-shot call whose marker-formatted
 *          output is split and saved (splitJumpInWikiGenerationOutput).
 *     2. Repeats the following until the wiki passes the acceptance check or
 *        the iteration cap (MAX_VALIDATION_ITERATIONS, default 3) is reached:
 *        a. Validates the wiki with the validator prompts
 *           (system-prompts/jump-in-wiki-validator.md and
 *           user-prompts/jump-in-wiki-validator.md), saving the report to
 *           <volume folder>/jump-in-wiki-validation-NN.md (agent mode: a
 *           validator agent writes the report; classic: single-shot output).
 *        b. Asks the acceptance prompts (system-prompts/jump-in-wiki-acceptance.md
 *           and user-prompts/jump-in-wiki-acceptance.md) whether the wiki is a
 *           passing grade (PASS) or not (FAIL). Always a tool-less single-shot
 *           call.
 *        c. On PASS, stops. Otherwise, applies the feedback prompts
 *           (system-prompts/jump-in-wiki-feedback.md and
 *           user-prompts/jump-in-wiki-feedback.md) to correct the wiki
 *           (agent mode: the same author session; classic: single-shot +
 *           marker split), then repeats from (a).
 *
 * Idempotent: a volume whose wiki + shared wiki already exist and pass the
 * acceptance check (from a previous run's validation report) is skipped
 * (unless --force). A volume whose files exist is still validated, so a
 * passing wiki is re-checked rather than regenerated.
 *
 * Usage:
 *   npx gulp jump-in-wiki             # run the full task
 *   npx gulp jump-in-wiki --dry-run   # transform the prompt only, no API call
 *   npx gulp jump-in-wiki --force     # regenerate even if already processed
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
const harness = require("./harness");
const { getTranslationTarget } = require("./get-translation-target");
const { AGENT_TOOLS_NOTE } = require("./shared");
const {
  fileExists,
  installmentNumberFromDir,
  transformUserPrompt,
  isPassingVerdict,
  validatorMaxStepsFor,
  writePromptDump,
  splitJumpInWikiGenerationOutput,
} = require("./utils/fs");

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

// The workflow mode: "agent" (default) drives generation/validation/feedback
// with OpenHarness tool-calling agents (harness.js); "classic" uses the
// original single-shot pipeline (same prompts, same outputs, no tools).
const agentMode = (process.env.RESEARCH_MODE || "agent").toLowerCase() !== "classic";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Remove the marker-based "## Output Format" section from a transformed
 * prompt (agent mode only: the agent writes the files with its file tools,
 * so the marker format is not needed and would conflict with it).
 *
 * @param {string} prompt - The transformed prompt.
 * @returns {string} The prompt without the "## Output Format" section.
 */
function stripMarkerOutputFormat(prompt) {
  const lines = prompt.split("\n");
  const start = lines.findIndex((l) =>
    l.trim().toLowerCase().startsWith("## output format")
  );
  if (start === -1) return prompt;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("## ")) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Agent mode: rewrite the classic output file names inside a transformed
 * prompt ("jump-in-wiki-NN.md" / "jump-in-wiki-shared.md") to the real
 * workflow file names ("wiki.md" / "shared-wiki.md"). The prompts' "## Output"
 * section still lists the classic names, and a model following it writes the
 * files under the wrong names (observed live). Classic mode is unaffected —
 * it saves the parsed markers itself and never passes its prompts through
 * this helper.
 *
 * @param {string} prompt - The transformed (variables filled) prompt.
 * @returns {string} The prompt with the agent-mode file names.
 */
function agentOutputNames(prompt) {
  return prompt
    .replace(/jump-in-wiki-\{\{INSTALLMENT_NUMBER\}\}\.md/g, "wiki.md")
    .replace(/previous-jump-in-wiki\.md/g, "../(previous volume folder)/wiki.md")
    .replace(/jump-in-wiki-\(NN-1\)\.md/g, "../(previous volume folder)/wiki.md")
    .replace(/jump-in-wiki-\(N[−-]1\)\.md/g, "../(previous volume folder)/wiki.md")
    .replace(/jump-in-wiki-shared\.old\.md/g, "the previous shared wiki (path in the materials list)")
    .replace(/jump-in-wiki-NN\.md/g, "wiki.md")
    .replace(/jump-in-wiki-\d+\.md/g, "wiki.md")
    .replace(/jump-in-wiki-shared\.md/g, "shared-wiki.md");
}

/**
 * Safety net for agent runs: if the expected output file is missing but the
 * agent wrote a different .md file in the volume folder (e.g. a classic
 * marker name), rename the best candidate to the expected name.
 *
 * @param {string} volumeDir - The volume folder the expected file belongs to.
 * @param {string} expectedBase - The expected file name (e.g. "wiki.md").
 * @param {Set<string>} knownFiles - File names that must never be adopted.
 * @returns {Promise<boolean>} True when a stray file was adopted.
 */
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

/**
 * The file names that may legitimately live in a volume folder and must
 * never be mistaken for (or renamed into) the wiki outputs.
 *
 * @param {Object} ctx - The volume context.
 * @returns {Set<string>} The protected file names.
 */
function knownVolumeFileNames(ctx) {
  return new Set([
    `${ctx.folderName}.md`,
    "glossary.md",
    "glossary-research.md",
    "glossary-validation.md",
    `jump-in-wiki-validation-${ctx.values.INSTALLMENT_NUMBER}.md`,
  ]);
}

// ─── Agent-mode prompt builders ─────────────────────────────────────────────
// The exact prompts the agent-mode stages send are built here (not inline in
// the run loops) so --dry-run can dump them and the tests can assert on them
// without any AI call.

/**
 * The author agent's system prompt (agent mode): classic file names
 * rewritten to the agent-mode names (the system prompt still describes the
 * classic file layout), plus the file-tools note.
 *
 * @param {Object} ctx - The volume context.
 * @returns {string}
 */
function buildWikiAuthorSystemPrompt(ctx) {
  return agentOutputNames(ctx.systemPrompt) + AGENT_TOOLS_NOTE;
}

/**
 * The validator agent's system prompt (agent mode): classic file names
 * rewritten to the agent-mode names, plus the file-tools note.
 *
 * @param {Object} ctx - The volume context.
 * @returns {string}
 */
function buildWikiValidatorSystemPrompt(ctx) {
  return agentOutputNames(ctx.validatorSystemPrompt) + AGENT_TOOLS_NOTE;
}

/**
 * The author agent's generation turn prompt (agent mode).
 *
 * @param {Object} ctx - The volume context (must include userPrompt).
 * @returns {string}
 */
function buildWikiAuthorTurnPrompt(ctx) {
  const { folderName, isFirst, previousFolderName } = ctx;
  const previousWikiLines = isFirst
    ? `- The previous volume wiki and shared wiki: (absent — this is the first volume)`
    : `- The previous volume wiki: "../${previousFolderName}/wiki.md"\n` +
      `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"`;
  const generatePrompt = agentOutputNames(stripMarkerOutputFormat(ctx.userPrompt));
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Materials (read with readFile before writing anything):\n` +
    `- The volume source: "${folderName}.md" (same folder)\n` +
    previousWikiLines +
    `\n\n` +
    `Write the two output files in your working folder:\n` +
    `- "wiki.md" — the volume wiki (complete contents, writeFile)\n` +
    `- "shared-wiki.md" — the updated shared wiki (complete contents, writeFile)\n` +
    `Use EXACTLY these two file names — do not invent other names.\n\n` +
    generatePrompt +
    `\n\nRemember: the complete results go to exactly "wiki.md" and ` +
    `"shared-wiki.md" in your working folder (writeFile, complete contents).`
  );
}

/**
 * The validator agent's turn prompt (agent mode, one fresh agent per QA
 * iteration).
 *
 * @param {Object} ctx - The volume context (must include validatorUserPrompt).
 * @returns {string}
 */
function buildWikiValidatorTurnPrompt(ctx) {
  const { values, folderName, isFirst, previousFolderName } = ctx;
  const validationFileName = `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`;
  const previousSharedLine = isFirst
    ? ""
    : `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"\n`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Materials (read with readFile before writing anything):\n` +
    `- The volume source: "${folderName}.md" (same folder)\n` +
    `- The volume wiki under audit: "wiki.md" (same folder)\n` +
    `- The shared wiki under audit: "shared-wiki.md" (same folder)\n` +
    previousSharedLine +
    `\n` +
    `Write the complete validation report to the file "${validationFileName}" in ` +
    `your working folder (writeFile, exact format from the system prompt).\n\n` +
    agentOutputNames(ctx.validatorUserPrompt)
  );
}

/**
 * The author agent's feedback turn prompt (agent mode).
 *
 * @param {Object} ctx - The volume context (must include feedbackUserPrompt).
 * @returns {string}
 */
function buildWikiFeedbackTurnPrompt(ctx) {
  const { values, folderName, isFirst, previousFolderName } = ctx;
  const validationFileName = `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`;
  const previousSharedLine = isFirst
    ? ""
    : `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"\n`;
  const feedbackPrompt = agentOutputNames(stripMarkerOutputFormat(ctx.feedbackUserPrompt));
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `The validation report "${validationFileName}" in your working folder is your ` +
    `work order.\n` +
    `Materials (read with readFile before changing anything):\n` +
    `- The volume source: "${folderName}.md" (same folder)\n` +
    `- The current volume wiki to correct: "wiki.md" (same folder)\n` +
    `- The current shared wiki to correct: "shared-wiki.md" (same folder)\n` +
    previousSharedLine +
    `\n` +
    `Apply the report's findings and write the corrected files back: "wiki.md" and ` +
    `"shared-wiki.md" (writeFile or editFile; smallest changes that resolve each ` +
    `valid finding).\n\n` +
    feedbackPrompt
  );
}

/**
 * Fail loudly if an agent-mode stage left its output files missing or empty
 * (agent runs can finish without having written the files).
 *
 * @param {string[]} filePaths - The expected output files.
 * @param {string} who - Who was supposed to write them (for the error message).
 */
async function assertWrote(filePaths, who) {
  for (const filePath of filePaths) {
    const content = await fs.readFile(filePath, "utf-8").catch(() => null);
    if (!content || !content.trim()) {
      throw new Error(
        `${who} did not produce ${filePath}. Check the run log in .logs/ for the agent transcript.`
      );
    }
  }
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
// Re-export shared utilities from utils/fs.js for backwards compatibility
// (tests and glossary.js import these from here).
module.exports.splitJumpInWikiGenerationOutput = require("./utils/fs").splitJumpInWikiGenerationOutput;
module.exports.transformUserPrompt = require("./utils/fs").transformUserPrompt;
module.exports.isPassingVerdict = require("./utils/fs").isPassingVerdict;
module.exports.validatorMaxStepsFor = require("./utils/fs").validatorMaxStepsFor;
module.exports.writePromptDump = require("./utils/fs").writePromptDump;
module.exports.installmentNumberFromDir = require("./utils/fs").installmentNumberFromDir;

// ─── Task ───────────────────────────────────────────────────────────────────

async function jumpInWiki() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  if (!process.env.SERIES_NAME_SOURCE) {
    throw new Error("SERIES_NAME_SOURCE is not set. Please set it in .env.");
  }

  // Discover the volumes with the AI-driven translation-target manifest (see
  // get-translation-target.js). It yields, in reading order, each volume's
  // folder and its exact source file, so nothing below has to guess names.
  const manifest = await getTranslationTarget({ force, dryRun });
  const sortedFolderWithSourceMaterial = manifest.volumes.map((v) => v.folder);
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));

  if (sortedFolderWithSourceMaterial.length === 0) {
    throw new Error(`No volume folders found in ${seriesDir}.`);
  }

  // Optional: process a single volume only ("--volume 01" or "--volume=01"),
  // e.g. for a live test before a full-series run. The previous volume is
  // still looked up in the full series (so --volume 05 needs volume 04).
  const volumeArg =
    (process.argv.find((a) => a.startsWith("--volume=")) || "").replace("--volume=", "") ||
    (process.argv.includes("--volume")
      ? process.argv[process.argv.indexOf("--volume") + 1]
      : null);
  let volumes = sortedFolderWithSourceMaterial;
  if (volumeArg) {
    const wanted = String(parseInt(volumeArg, 10)).padStart(2, "0");
    volumes = sortedFolderWithSourceMaterial.filter((name) => {
      const m = name.match(/\((\d+)\)\s*$/);
      return m && m[1].padStart(2, "0") === wanted;
    });
    if (volumes.length === 0) {
      throw new Error(`No volume folder matching --volume ${volumeArg}.`);
    }
    console.log(`--volume: processing only volume ${wanted}`);
  }

  const systemPrompt = await fs.readFile(systemPromptFile, "utf-8");
  const template = await fs.readFile(userPromptTemplateFile, "utf-8");
  const validatorSystemPrompt = await fs.readFile(validatorSystemPromptFile, "utf-8");
  const validatorTemplate = await fs.readFile(validatorUserPromptTemplateFile, "utf-8");
  const feedbackSystemPrompt = await fs.readFile(feedbackSystemPromptFile, "utf-8");
  const feedbackTemplate = await fs.readFile(feedbackUserPromptTemplateFile, "utf-8");
  const acceptanceSystemPrompt = await fs.readFile(acceptanceSystemPromptFile, "utf-8");
  const acceptanceTemplate = await fs.readFile(acceptanceUserPromptTemplateFile, "utf-8");

  console.log(
    `Workflow mode: ${agentMode
      ? "agent (OpenHarness tool-calling agents)"
      : "classic (single-shot pipeline)"}`
  );

  let limitReachedCount = 0;

  for (const folderName of volumes) {
    const i = sortedFolderWithSourceMaterial.indexOf(folderName);
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    const sourceFile = path.resolve(seriesDir, volume.sourceFile);
    const wikiOutputFile = path.join(volumeDir, "wiki.md");
    const sharedWikiOutputFile = path.join(volumeDir, "shared-wiki.md");

    if (!(await fileExists(sourceFile))) {
      throw new Error(`Required file not found: ${sourceFile}`);
    }

    const values = {
      INSTALLMENT_NUMBER: volume.installmentNumber,
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

    /**
     * set some variables (the ctx is built here, before the dry-run check, so
     * --dry-run can dump the exact agent-mode prompts too)
     */
    const isFirst = i === 0;
    let previousFolderName = null;
    let previousWikiOutputFile = null;
    let previousSharedWikiOutputFile = null;

    if (!isFirst) {
      previousFolderName = sortedFolderWithSourceMaterial[i - 1];
      const previousVolumeDir = path.join(seriesDir, previousFolderName);
      previousWikiOutputFile = path.join(previousVolumeDir, "wiki.md");
      previousSharedWikiOutputFile = path.join(previousVolumeDir, "shared-wiki.md");
    }

    // generating the initial wiki is expensive, so we gotta check if it's already
    // been generated and if so, we can skip the initial generation step.
    const wikiAndSharedWikiExists =
      !force &&
      (await fileExists(wikiOutputFile)) &&
      (await fileExists(sharedWikiOutputFile));

    const ctx = {
      values,
      folderName,
      volumeDir,
      sourceFile,
      wikiOutputFile,
      sharedWikiOutputFile,
      validationOutputFile,
      isFirst,
      previousFolderName,
      previousWikiOutputFile,
      previousSharedWikiOutputFile,
      userPrompt,
      validatorUserPrompt,
      feedbackUserPrompt,
      acceptanceUserPrompt,
      systemPrompt,
      validatorSystemPrompt,
      feedbackSystemPrompt,
      acceptanceSystemPrompt,
      wikiAndSharedWikiExists,
    };

    if (dryRun) {
      const sections = agentMode
        ? [
            { title: "AGENT — author system prompt", prompt: buildWikiAuthorSystemPrompt(ctx) },
            { title: "AGENT — author turn (generation)", prompt: buildWikiAuthorTurnPrompt(ctx) },
            { title: "AGENT — validator system prompt", prompt: buildWikiValidatorSystemPrompt(ctx) },
            { title: "AGENT — validator turn", prompt: buildWikiValidatorTurnPrompt(ctx) },
            { title: "AGENT — feedback turn (applied by the author session)", prompt: buildWikiFeedbackTurnPrompt(ctx) },
            { title: "One-shot — acceptance user prompt (always tool-less)", prompt: acceptanceUserPrompt },
          ]
        : [
            { title: "CLASSIC — generation system prompt", prompt: systemPrompt },
            { title: "CLASSIC — generation user prompt", prompt: userPrompt },
            { title: "CLASSIC — validator system prompt", prompt: validatorSystemPrompt },
            { title: "CLASSIC — validator user prompt", prompt: validatorUserPrompt },
            { title: "CLASSIC — feedback system prompt", prompt: feedbackSystemPrompt },
            { title: "CLASSIC — feedback user prompt", prompt: feedbackUserPrompt },
            { title: "CLASSIC — acceptance system prompt", prompt: acceptanceSystemPrompt },
            { title: "CLASSIC — acceptance user prompt", prompt: acceptanceUserPrompt },
          ];
      const dumpFile = await writePromptDump(
        "jump-in-wiki",
        values.INSTALLMENT_NUMBER,
        agentMode ? "agent" : "classic",
        sections
      );
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: no AI calls. ` +
          `The exact prompts (${agentMode ? "agent-mode turns + tool-less acceptance" : "classic one-shot pipeline"}) ` +
          `are written to ${dumpFile}`
      );
      continue;
    }

    /**
     * the logic for checking whether the current volume has already been
     * processed: the validation report from a previous run must exist and the
     * acceptance check (one-shot, tool-less) must pass.
     */
    let currentVolumeHasAlreadyBeenProcessed = false;
    if (!force && (await fileExists(validationOutputFile))) {
      try {
        const acceptanceOutput = await harness.runOneShot({
          systemPrompt: acceptanceSystemPrompt,
          messages: [
            { file: validationOutputFile, name: `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md` },
            { text: acceptanceUserPrompt },
          ],
          label: `jump-in-wiki-acceptance-${values.INSTALLMENT_NUMBER}-skip-check`,
        });
        currentVolumeHasAlreadyBeenProcessed = isPassingVerdict(acceptanceOutput);
      } catch (err) {
        currentVolumeHasAlreadyBeenProcessed = false;
      }
    }

    if (currentVolumeHasAlreadyBeenProcessed) {
      console.log('the current volume has already been processed by a previous run. skipping the current volume.')
      continue;
    }

    if (agentMode) {
      await runVolumeAgent(ctx);
    } else {
      await runVolumeClassic(ctx);
    }

    if (ctx.limitReached) {
      limitReachedCount++;
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

/**
 * Classic mode: the original single-shot pipeline (inlined materials,
 * marker-formatted model output split into the two output files).
 *
 * @param {Object} ctx - The volume context (see jumpInWiki()).
 */
async function runVolumeClassic(ctx) {
  const {
    values,
    sourceFile,
    wikiOutputFile,
    sharedWikiOutputFile,
    validationOutputFile,
    isFirst,
    previousWikiOutputFile,
    previousSharedWikiOutputFile,
    userPrompt,
    validatorUserPrompt,
    acceptanceUserPrompt,
    systemPrompt,
    validatorSystemPrompt,
    acceptanceSystemPrompt,
    wikiAndSharedWikiExists,
  } = ctx;

  /**
   * the logic for generating the wiki
   */
  if (wikiAndSharedWikiExists) {
    console.log("Wiki for the current volume exists. skipping initial generation and proceeding to validation");
  } else {
    console.log("Calling the AI for initial wiki generation...");
    let output;
    if (isFirst) {
      output = await harness.runOneShot({
        systemPrompt,
        messages: [
          { file: sourceFile, name: path.basename(sourceFile) },
          { text: userPrompt },
        ],
        label: `jump-in-wiki-generate-${values.INSTALLMENT_NUMBER}`,
      });
    } else {
      output = await harness.runOneShot({
        systemPrompt,
        messages: [
          { file: sourceFile, name: path.basename(sourceFile) },
          { file: previousWikiOutputFile, name: "previous-jump-in-wiki.md" },
          { file: previousSharedWikiOutputFile, name: "jump-in-wiki-shared.md" },
          { text: userPrompt },
        ],
        label: `jump-in-wiki-generate-${values.INSTALLMENT_NUMBER}`,
      });
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

    const validationReport = await harness.runOneShot({
      systemPrompt: validatorSystemPrompt,
      messages: validationMessages,
      label: `jump-in-wiki-validate-${values.INSTALLMENT_NUMBER}-${iteration}`,
    });

    await fs.writeFile(validationOutputFile, validationReport, "utf-8");

    /**
     * the logic for checking whether the validated wiki is acceptable
     */
    console.log("Calling the AI for the acceptance check...");

    const acceptanceOutput = await harness.runOneShot({
      systemPrompt: acceptanceSystemPrompt,
      messages: [
        { file: validationOutputFile, name: `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md` },
        { text: acceptanceUserPrompt },
      ],
      label: `jump-in-wiki-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}`,
    });
    const accepted = isPassingVerdict(acceptanceOutput);
    console.log(`Acceptance check: ${accepted ? "PASS" : "FAIL"}`);

    if (accepted) {
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: accepted on iteration ${iteration}. ` +
        `Skipping the feedback pass so the passing wiki is left untouched.`
      );
      break;
    }

    /**
     * the logic for applying the validation feedback to the failing wiki
     */
    console.log("Calling the AI to apply the validation feedback...");

    const previousInstallment = String(
      parseInt(values.INSTALLMENT_NUMBER, 10) - 1
    ).padStart(2, "0");

    const feedbackMessages = [
      { file: sourceFile, name: path.basename(sourceFile) },
      { file: validationOutputFile, name: `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md` },
      { file: wikiOutputFile, name: `jump-in-wiki-${values.INSTALLMENT_NUMBER}.md` },
      { file: sharedWikiOutputFile, name: "jump-in-wiki-shared.md" },
    ];
    if (!isFirst) {
      feedbackMessages.push({
        file: previousWikiOutputFile,
        name: `jump-in-wiki-${previousInstallment}.md`,
      });
      feedbackMessages.push({
        file: previousSharedWikiOutputFile,
        name: "jump-in-wiki-shared.old.md",
      });
    }
    feedbackMessages.push({ text: ctx.feedbackUserPrompt });

    const feedbackOutput = await harness.runOneShot({
      systemPrompt: ctx.feedbackSystemPrompt,
      messages: feedbackMessages,
      label: `jump-in-wiki-feedback-${values.INSTALLMENT_NUMBER}-${iteration}`,
    });

    const [correctedWiki, correctedSharedWiki] = splitJumpInWikiGenerationOutput(feedbackOutput);

    await fs.writeFile(wikiOutputFile, correctedWiki, "utf-8");
    await fs.writeFile(sharedWikiOutputFile, correctedSharedWiki, "utf-8");

    if (iteration === maxValidationIterations) {
      ctx.limitReached = true;
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit ` +
        `(${maxValidationIterations}) without a passing grade. The last feedback pass is ` +
        `unvalidated; re-run the task to validate it.`
      );
      break;
    }
  }
}

/**
 * Agent mode: an author agent (per-volume session, file tools) writes
 * wiki.md and shared-wiki.md directly; an independent validator agent (fresh
 * per iteration) writes the validation report; the acceptance check is a
 * tool-less single-shot call; feedback is applied by the same author session.
 *
 * @param {Object} ctx - The volume context (see jumpInWiki()).
 */
async function runVolumeAgent(ctx) {
  const {
    values,
    volumeDir,
    wikiOutputFile,
    sharedWikiOutputFile,
    wikiAndSharedWikiExists,
  } = ctx;

  // File tools gated to this volume's folder (reads are allowed anywhere,
  // so the agents can also read the volume source and the previous volume).
  const fsGate = await harness.createGatedFsTools({
    cwd: volumeDir,
    allowedDirs: [volumeDir],
  });
  ctx.fsGate = fsGate;

  // Remove stale strays from earlier runs (agent name drift): the workflow
  // itself never writes files with the classic marker names, so anything
  // named like that in the volume folder is garbage that only wastes agent
  // steps (observed live: a validator audited a stale stray wiki).
  for (const stray of [
    `jump-in-wiki-${values.INSTALLMENT_NUMBER}.md`,
    "jump-in-wiki-shared.md",
  ]) {
    const strayPath = path.join(volumeDir, stray);
    if (await fileExists(strayPath)) {
      await fs.rm(strayPath);
      console.log(`Removed the stale file "${stray}" (leftover from a previous run).`);
    }
  }

  // The author agent keeps its session across the generation and feedback
  // turns of this volume.
  const author = await harness.createAgentHandle({
    name: `wiki-author-${values.INSTALLMENT_NUMBER}`,
    systemPrompt: buildWikiAuthorSystemPrompt(ctx),
    tools: fsGate.tools,
    approve: fsGate.approve,
    cwd: volumeDir,
    maxSteps: 40,
  });
  try {
    // the logic for generating the wiki
    if (wikiAndSharedWikiExists) {
      console.log("Wiki for the current volume exists. skipping initial generation and proceeding to validation");
    } else {
      console.log("Calling the AI for initial wiki generation (author agent)...");
      // Scaffold stubs: pre-create both output files so the agent overwrites
      // existing files (a stronger name anchor than "create a new file") and
      // a crashed run leaves identifiable stubs instead of nothing.
      if (!(await fileExists(wikiOutputFile))) {
        await fs.writeFile(
          wikiOutputFile,
          `(stub — the agent replaces this with the complete volume wiki for volume ${values.INSTALLMENT_NUMBER})\n`,
          "utf8"
        );
      }
      if (!(await fileExists(sharedWikiOutputFile))) {
        await fs.writeFile(
          sharedWikiOutputFile,
          `(stub — the agent replaces this with the complete shared wiki)\n`,
          "utf8"
        );
      }
      await author.sendTurn(buildWikiAuthorTurnPrompt(ctx), {
        label: `jump-in-wiki-generate-${values.INSTALLMENT_NUMBER}`,
      });
      // Safety net: adopt the output if the agent picked different names.
      const knownFiles = knownVolumeFileNames(ctx);
      await adoptStrayOutput(volumeDir, "wiki.md", knownFiles);
      await adoptStrayOutput(volumeDir, "shared-wiki.md", knownFiles);
      await assertWrote(
        [wikiOutputFile, sharedWikiOutputFile],
        "the author agent"
      );
    }

    await runQaLoopAgent(ctx, author);
  } finally {
    await author.close();
  }
}

/**
 * Agent-mode QA loop: independent validator agent (fresh per iteration) ->
 * one-shot acceptance -> feedback applied by the same author session that
 * generated the wiki.
 *
 * @param {Object} ctx - The volume context (must include ctx.fsGate).
 * @param {Object} author - The author agent handle (keeps its session).
 */
async function runQaLoopAgent(ctx, author) {
  const {
    values,
    volumeDir,
    sourceFile,
    wikiOutputFile,
    sharedWikiOutputFile,
    validationOutputFile,
  } = ctx;
  const fsGate = ctx.fsGate;

  const validationFileName = `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`;

  for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
    console.log(`Validation iteration ${iteration}/${maxValidationIterations}...`);

    /**
     * the logic for validating the generated wiki (independent agent)
     */
    console.log("Calling the AI for validation (validator agent)...");

    const validator = await harness.createAgentHandle({
      name: `wiki-validator-${values.INSTALLMENT_NUMBER}-${iteration}`,
      // The validator prompts name the files with the classic marker names;
      // buildWikiValidatorSystemPrompt maps them to the real agent-mode names.
      systemPrompt: buildWikiValidatorSystemPrompt(ctx),
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      // scaled to the source size (see validatorMaxStepsFor)
      maxSteps: validatorMaxStepsFor((await fs.stat(sourceFile)).size),
    });
    try {
      await validator.sendTurn(
        buildWikiValidatorTurnPrompt(ctx),
        { label: `jump-in-wiki-validate-${values.INSTALLMENT_NUMBER}-${iteration}` }
      );
    } finally {
      await validator.close();
    }
    await assertWrote(validationOutputFile, "the validator agent");

    // the logic for checking whether the validated wiki is acceptable
    // (always one-shot, tool-less)
    console.log("Calling the AI for the acceptance check...");

    const acceptanceOutput = await harness.runOneShot({
      systemPrompt: ctx.acceptanceSystemPrompt,
      messages: [
        { file: validationOutputFile, name: validationFileName },
        { text: ctx.acceptanceUserPrompt },
      ],
      label: `jump-in-wiki-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}`,
    });
    const accepted = isPassingVerdict(acceptanceOutput);
    console.log(`Acceptance check: ${accepted ? "PASS" : "FAIL"}`);

    if (accepted) {
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: accepted on iteration ${iteration}. ` +
        `Skipping the feedback pass so the passing wiki is left untouched.`
      );
      break;
    }

    // the logic for applying the validation feedback (same author session)
    console.log("Calling the AI to apply the validation feedback (author agent)...");

    await author.sendTurn(
      buildWikiFeedbackTurnPrompt(ctx),
      { label: `jump-in-wiki-feedback-${values.INSTALLMENT_NUMBER}-${iteration}` }
    );
    // Safety net: adopt the output if the agent picked different names.
    const feedbackKnownFiles = knownVolumeFileNames(ctx);
    await adoptStrayOutput(volumeDir, "wiki.md", feedbackKnownFiles);
    await adoptStrayOutput(volumeDir, "shared-wiki.md", feedbackKnownFiles);
    await assertWrote(
      [wikiOutputFile, sharedWikiOutputFile],
      "the author agent (feedback pass)"
    );

    if (iteration === maxValidationIterations) {
      ctx.limitReached = true;
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit ` +
        `(${maxValidationIterations}) without a passing grade. The last feedback pass is ` +
        `unvalidated; re-run the task to validate it.`
      );
      break;
    }
  }
}

// ─── Export for use as a module ─────────────────────────────────────────────

module.exports = {
  jumpInWiki,
  installmentNumberFromDir,
  transformUserPrompt,
  splitJumpInWikiGenerationOutput,
  isPassingVerdict,
  stripMarkerOutputFormat,
  agentOutputNames,
  adoptStrayOutput,
  validatorMaxStepsFor,
  writePromptDump,
  buildWikiAuthorSystemPrompt,
  buildWikiValidatorSystemPrompt,
  buildWikiAuthorTurnPrompt,
  buildWikiValidatorTurnPrompt,
  buildWikiFeedbackTurnPrompt,
};

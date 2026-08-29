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
 *        - agent: an author agent (per-volume session) reads the source and
 *          previous wikis with file tools and writes both files directly
 *          (no marker-based output parsing).
 *     2. Repeats the following until the rolling-average acceptance criterion
 *        is met or the iteration cap (MAX_VALIDATION_ITERATIONS, default 10)
 *        is reached:
 *        a. Validates the wiki with the validator prompts
 *           (system-prompts/jump-in-wiki-validator.md and
 *           user-prompts/jump-in-wiki-validator.md), saving the report to
 *           <volume folder>/jump-in-wiki-validation-NN.md (a validator agent
 *           writes the report).
 *        b. Asks the acceptance prompts (system-prompts/jump-in-wiki-acceptance.md
 *           and user-prompts/jump-in-wiki-acceptance.md) whether the wiki is a
 *           passing grade (PASS) or not (FAIL). Always a tool-less single-shot
 *           call. Each result is tracked in a rolling window (default: last 5
 *           checks). When the rolling pass rate meets the threshold (default:
 *           0.60 = 3 of 5) and we have at least MIN_SAMPLES (default: 3)
 *           checks, accept and stop.
 *        c. Otherwise, apply the feedback prompts
 *           (system-prompts/jump-in-wiki-feedback.md and
 *           user-prompts/jump-in-wiki-feedback.md) to correct the wiki
 *           (the same author session), then repeat from (a).
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
require("./types"); // JSDoc type definitions
const harness = require("./harness");
const { getTranslationTarget } = require("./get-translation-target");
const { AGENT_TOOLS_NOTE, ROLLING_WINDOW_SIZE, ROLLING_ACCEPTANCE_THRESHOLD, ROLLING_MIN_SAMPLES, computeRollingAverage, saveRollingState } = require("./configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback } = require("./utils/fs");
const { transformUserPrompt, isPassingVerdict, validatorMaxStepsFor, writePromptDump } = require("./utils/prompt");
const { installmentNumberFromDir } = require("./utils/manifest");

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

/**
 * The file names that may legitimately live in a volume folder and must
 * never be mistaken for (or renamed into) the wiki outputs.
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
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
 * The author agent's system prompt: the mode-agnostic generation prompt with
 * the file tools note appended.
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
 * @returns {string}
 */
function buildWikiAuthorSystemPrompt(ctx) {
  return ctx.systemPrompt + AGENT_TOOLS_NOTE;
}

/**
 * The validator agent's system prompt: the mode-agnostic validator prompt
 * with the file tools note appended.
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
 * @returns {string}
 */
function buildWikiValidatorSystemPrompt(ctx) {
  return ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE;
}

/**
 * The author agent's generation turn prompt (agent mode).
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include userPrompt).
 * @returns {string}
 */
function buildWikiAuthorTurnPrompt(ctx) {
  const { folderName, isFirst, previousFolderName } = ctx;
  const previousWikiLines = isFirst
    ? `- The previous volume wiki and shared wiki: (absent — this is the first volume)`
    : `- The previous volume wiki: "../${previousFolderName}/wiki.md"\n` +
      `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"`;
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
    ctx.userPrompt +
    `\n\nRemember: the complete results go to exactly "wiki.md" and ` +
    `"shared-wiki.md" in your working folder (writeFile, complete contents).`
  );
}

/**
 * The validator agent's turn prompt (agent mode, one fresh agent per QA
 * iteration).
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include validatorUserPrompt).
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
    ctx.validatorUserPrompt
  );
}

/**
 * The author agent's feedback turn prompt (agent mode).
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include feedbackUserPrompt).
 * @returns {string}
 */
function buildWikiFeedbackTurnPrompt(ctx) {
  const { values, folderName, isFirst, previousFolderName } = ctx;
  const validationFileName = `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`;
  const previousSharedLine = isFirst
    ? ""
    : `- The previous shared wiki: "../${previousFolderName}/shared-wiki.md"\n`;
  const feedbackPrompt = ctx.feedbackUserPrompt;
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
    `"shared-wiki.md" using writeFile (complete contents, overwrite). Use editFile only for ` +
    `targeted fixes. Make the smallest changes that resolve each valid finding.\n\n` +
    feedbackPrompt
  );
}

// Re-export shared utilities from utils/prompt.js and utils/manifest.js
// for backwards compatibility (tests and glossary.js import these from here).
module.exports.transformUserPrompt = require("./utils/prompt").transformUserPrompt;
module.exports.isPassingVerdict = require("./utils/prompt").isPassingVerdict;
module.exports.validatorMaxStepsFor = require("./utils/prompt").validatorMaxStepsFor;
module.exports.writePromptDump = require("./utils/prompt").writePromptDump;
module.exports.installmentNumberFromDir = require("./utils/manifest").installmentNumberFromDir;

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
      const sections = [
        { title: "AGENT — author system prompt", prompt: buildWikiAuthorSystemPrompt(ctx) },
        { title: "AGENT — author turn (generation)", prompt: buildWikiAuthorTurnPrompt(ctx) },
        { title: "AGENT — validator system prompt", prompt: buildWikiValidatorSystemPrompt(ctx) },
        { title: "AGENT — validator turn", prompt: buildWikiValidatorTurnPrompt(ctx) },
        { title: "AGENT — feedback turn (applied by the author session)", prompt: buildWikiFeedbackTurnPrompt(ctx) },
        { title: "One-shot — acceptance user prompt (always tool-less)", prompt: acceptanceUserPrompt },
      ];
      const dumpFile = await writePromptDump(
        "jump-in-wiki",
        values.INSTALLMENT_NUMBER,
        "agent",
        sections
      );
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: no AI calls. ` +
          `The exact prompts (agent-mode turns + tool-less acceptance) ` +
          `are written to ${dumpFile}`
      );
      continue;
    }

    /**
     * the logic for checking whether the current volume has already been
     * processed: read the persisted rolling-window state and recompute the
     * acceptance decision deterministically (no AI call).
     *
     * If the state file is missing or corrupt we fall back to regenerating
     * (fail-open).
     */
    let currentVolumeHasAlreadyBeenProcessed = false;
    if (!force && (await fileExists(validationOutputFile))) {
      const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
      const { loadRollingState } = require("./configs/shared");
      const state = await loadRollingState(stateFilePath);
      if (state) {
        const avg = computeRollingAverage(state.results);
        currentVolumeHasAlreadyBeenProcessed =
          state.results.length >= ROLLING_MIN_SAMPLES &&
          avg >= ROLLING_ACCEPTANCE_THRESHOLD;
        if (currentVolumeHasAlreadyBeenProcessed) {
          console.log(
            `volume ${values.INSTALLMENT_NUMBER}: rolling-state ` +
            `(${state.results.length} checks, avg ${avg.toFixed(2)}) ` +
            `meets threshold. skipping.`
          );
        }
      }
      // state === null → skip stays false (fail-open)
    }

    if (currentVolumeHasAlreadyBeenProcessed) {
      console.log('the current volume has already been processed by a previous run. skipping the current volume.')
      continue;
    }

    await runVolumeAgent(ctx);

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
 * Process a single volume: generate the wiki (author agent) -> QA loop
 * (independent validator agent + one-shot acceptance + same author session
 * for feedback).
 *
 * @param {WikiVolumeCtx} ctx - The volume context (see jumpInWiki()).
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
      const wikiGenResult = await author.sendTurn(buildWikiAuthorTurnPrompt(ctx), {
        label: `jump-in-wiki-generate-${values.INSTALLMENT_NUMBER}`,
      });
      // Safety net: adopt the output if the agent picked different names.
      const knownFiles = knownVolumeFileNames(ctx);
      await adoptStrayOutput(volumeDir, "wiki.md", knownFiles);
      await adoptStrayOutput(volumeDir, "shared-wiki.md", knownFiles);
      const wikiFallbackUsed = await assertWroteWithFallback(
        [wikiOutputFile, sharedWikiOutputFile],
        "the author agent",
        wikiGenResult?.text
      );

      // Recovery turn: if the model replied in chat instead of writeFile,
      // send a second turn asking it to write both files using the content
      // it already generated (the model's session still has that context).
      if (wikiFallbackUsed && process.env.RECOVERY_ENABLED !== "false") {
        console.log(
          `Volume ${values.INSTALLMENT_NUMBER}: sending recovery turn ` +
            `(model replied in chat instead of writeFile)...`
        );
        const wikiHasContent = wikiGenResult?.text && wikiGenResult.text.trim().length > 0;
        const wikiRecoveryPrompt = wikiHasContent
          ? `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
            `Both files have been temporarily written from your chat reply, but they must be written properly using writeFile. ` +
            `Please rewrite both files using writeFile now. Use the exact same content you generated in your previous message: ` +
            `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`
          : `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you produced no output.\n\n` +
            `Please read the source materials and write both files using writeFile now: ` +
            `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`;
        const wikiRecoveryResult = await author.sendTurn(
          wikiRecoveryPrompt,
          { label: `jump-in-wiki-recovery-${values.INSTALLMENT_NUMBER}` }
        );
        // Overwrite with the recovery output (may be the same content, now via writeFile).
        await assertWroteWithFallback(
          [wikiOutputFile, sharedWikiOutputFile],
          "the author agent (recovery)",
          wikiRecoveryResult?.text
        );
      }
    }

    await runQaLoop(ctx, author);
  } finally {
    await author.close();
  }
}

/**
 * QA loop: independent validator agent (fresh per iteration) ->
 * rolling-average acceptance check -> feedback applied by the same author
 * session that generated the wiki.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 * @param {AgentHandle} author - The author agent handle (keeps its session).
 */
async function runQaLoop(ctx, author) {
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
  // Rolling window of recent acceptance results (true = pass, false = fail).
  const recentRollingResults = [];

  for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
    console.log(`Validation iteration ${iteration}/${maxValidationIterations}...`);

    /**
     * the logic for validating the generated wiki (independent agent)
     */
    console.log("Calling the AI for validation (validator agent)...");

    const validator = await harness.createAgentHandle({
      name: `wiki-validator-${values.INSTALLMENT_NUMBER}-${iteration}`,
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

    // Record result in rolling window.
    recentRollingResults.push(accepted);
    if (recentRollingResults.length > ROLLING_WINDOW_SIZE) {
      recentRollingResults.shift();
    }

    // Persist the rolling window to disk so that a re-run can recover the
    // exact acceptance state without re-calling the AI.
    const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
    await saveRollingState(stateFilePath, recentRollingResults);

    // Check rolling average: if we have enough samples and the pass rate
    // meets the threshold, accept and stop (skip feedback).
    if (recentRollingResults.length >= ROLLING_MIN_SAMPLES) {
      const avg = computeRollingAverage(recentRollingResults);
      if (avg >= ROLLING_ACCEPTANCE_THRESHOLD) {
        const passCount = recentRollingResults.filter(Boolean).length;
        console.log(
          `Volume ${values.INSTALLMENT_NUMBER}: rolling average ${avg.toFixed(2)} ` +
            `(${passCount}/${recentRollingResults.length} passes) meets threshold ` +
            `${ROLLING_ACCEPTANCE_THRESHOLD}. Accepted.`
        );
        break;
      }
    }

    // the logic for applying the validation feedback (same author session)
    console.log("Calling the AI to apply the validation feedback (author agent)...");

    const wikiFeedbackResult = await author.sendTurn(
      buildWikiFeedbackTurnPrompt(ctx),
      { label: `jump-in-wiki-feedback-${values.INSTALLMENT_NUMBER}-${iteration}` }
    );
    const wikiFeedbackFallbackUsed = await assertWroteWithFallback(
      [wikiOutputFile, sharedWikiOutputFile],
      "the author agent (feedback pass)",
      wikiFeedbackResult?.text
    );

    // Recovery turn for feedback pass: if the model produced no output,
    // re-send the full feedback task.
    if (wikiFeedbackFallbackUsed && process.env.RECOVERY_ENABLED !== "false") {
      const wikiFeedbackHasContent = wikiFeedbackResult?.text && wikiFeedbackResult.text.trim().length > 0;
      const wikiFeedbackRecoveryPrompt = wikiFeedbackHasContent
        ? `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
          `Both files have been temporarily written from your chat reply, but they must be written properly using writeFile. ` +
          `Please rewrite both files using writeFile now. Use the exact same content you generated in your previous message: ` +
          `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`
        : `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you produced no output.\n\n` +
          `Please read the source materials and the validation report and write both files using writeFile now: ` +
          `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`;
      const wikiFeedbackRecoveryResult = await author.sendTurn(
        wikiFeedbackRecoveryPrompt,
        { label: `jump-in-wiki-feedback-recovery-${values.INSTALLMENT_NUMBER}-${iteration}` }
      );
      await assertWroteWithFallback(
        [wikiOutputFile, sharedWikiOutputFile],
        "the author agent (feedback recovery)",
        wikiFeedbackRecoveryResult?.text
      );
    }

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
  isPassingVerdict,
  validatorMaxStepsFor,
  writePromptDump,
  buildWikiAuthorSystemPrompt,
  buildWikiValidatorSystemPrompt,
  buildWikiAuthorTurnPrompt,
  buildWikiValidatorTurnPrompt,
  buildWikiFeedbackTurnPrompt,
};

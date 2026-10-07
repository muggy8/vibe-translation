/**
 * Running the intake agent and reading back what it produced.
 *
 * The agent writes translation-target.json with writeFile; the chat reply is a salvage
 * path, not the source (extractJsonObject digs the JSON out of prose). firstPlanProblem
 * runs the validation and the objective checks so the correction turn can name the
 * actual problem. An intake that fails every attempt is a STRUCTURAL failure: no plan of
 * record means no step can run, so ON_TASK_ERROR=continue does not walk past it.
 *
 * Part of the get-translation-target.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const {
  extractJsonObject,
  installmentNumberFromDir,
  normalizeInstallmentNumber,
  sanitizeFolderName,
  filterVolumesByInstallment,
} = require("../utils/manifest");
const { fileExists, stageSourceFile } = require("../utils/fs");
const { emittedToolCallAsText, assertRealToolCalls } = require("../utils/agents");

const { validateManifest } = require("./validate");
const { DISCOVERY_BASE_STEPS, DISCOVERY_STEPS_PER_CANDIDATE, DRAFT_MANIFEST_FILE_NAME, MANIFEST_FILE_NAME, PLAN_FILE_NAME, discoverSampleChars } = require("./config");
const { isSourceEntry } = require("./deterministic");
const { buildCorrectionTurnPrompt, buildDiscoveryTurnPrompt, loadIntakeSystemPrompt } = require("./prompts");

/**
 * Read and parse the manifest file the agent wrote.
 * @param {string} manifestPath - Absolute path.
 * @returns {Promise<Object|null>} The parsed manifest, or null when missing/unparseable.
 */
async function readManifestFile(manifestPath) {
  if (!(await fileExists(manifestPath))) return null;
  try {
    return extractJsonObject(await fs.readFile(manifestPath, "utf-8"));
  } catch (err) {
    harness.logLine(
      `[get-translation-target] WARN: could not parse ${path.basename(manifestPath)}: ${err.message}`
    );
    return null;
  }
}


/**
 * Salvage the manifest from the agent's chat reply and persist it (the fallback
 * for a model that answered in chat instead of calling writeFile).
 *
 * @param {string} text - The agent's reply.
 * @param {string} manifestPath - Where to write it.
 * @returns {Promise<Object|null>} The parsed manifest, or null.
 */
async function salvageManifest(text, manifestPath) {
  try {
    const manifest = extractJsonObject(text);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    harness.logLine(
      `[get-translation-target] salvaged the manifest from the agent's reply and wrote ${manifestPath}`
    );
    return manifest;
  } catch (err) {
    harness.logLine(
      `[get-translation-target] WARN: could not salvage the manifest from the reply: ${err.message}`
    );
    return null;
  }
}


/**
 * Validate a manifest and return the problem instead of throwing, so the agent
 * can be shown its own error.
 *
 * @param {Object|null} manifest - The parsed manifest.
 * @returns {{message: string}|null} null when the manifest is valid.
 */
function firstManifestProblem(manifest) {
  try {
    validateManifest(manifest);
    return null;
  } catch (err) {
    return { message: err.message };
  }
}


/**
 * The same check plus the checks that need the disk (a book listed twice).
 * Whatever it returns is shown to the agent as its correction task, so a
 * mistake the agent can fix is fixed by the agent instead of failing the step.
 *
 * @param {Object|null} manifest - The parsed manifest.
 * @param {Function} [extraChecks] - async (manifest) => problem string | null.
 * @returns {Promise<{message: string}|null>} null when the plan is usable.
 */
async function firstPlanProblem(manifest, extraChecks) {
  const sync = firstManifestProblem(manifest);
  if (sync) return sync;
  if (!extraChecks) return null;
  const message = await extraChecks(manifest);
  return message ? { message } : null;
}


/**
 * The file tools the intake agent is given are text tools: readFile on an epub
 * returns zip bytes, and writeFile over a book would destroy the source the
 * whole pipeline exists to translate. The epub tools are the door to a book,
 * so the plain file tools are shut at book files.
 *
 * @param {Object} fsGate - createGatedFsTools' gate.
 * @param {Object} epubGate - createEpubTools' gate.
 * @returns {(call: Object) => boolean} The composed approve gate.
 */
function createIntakeApprove(fsGate, epubGate) {
  const FILE_TOOLS = new Set(["readFile", "grep", "writeFile", "editFile", "deleteFile"]);
  return (call) => {
    const input = (call && call.input) || {};
    // grep and listFiles name their path `dirPath`; readFile/writeFile/editFile
    // name it `filePath`. Checking only filePath left `grep(dirPath: "book.epub")`
    // — the exact call an agent makes when a prompt says "grep this book" —
    // outside the refusal this gate exists to make.
    const target =
      typeof input.filePath === "string"
        ? input.filePath
        : typeof input.dirPath === "string"
          ? input.dirPath
          : typeof input.path === "string"
            ? input.path
            : "";
    if (FILE_TOOLS.has(call && call.toolName) && /\.(epub|zip)$/i.test(target)) {
      return false;
    }
    return fsGate.approve(call) && epubGate.approve(call);
  };
}


/**
 * Run the intake agent over the series location and return the plan it wrote.
 *
 * One turn to explore, decide, stage, and write; then, if the plan fails
 * validation, one correction turn in the same session showing the agent its own
 * error, before the attempt is thrown away for a fresh agent. The manifest file
 * is the primary output; a chat reply is only a salvage path. A previous
 * attempt's outputs are deleted first so a failed attempt can never be mistaken
 * for a finished one.
 *
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @param {{overrides: {seriesName?: string, sourceLanguage?: string, targetLanguage: string}, committed: CommittedVolumeDir[], maxSteps?: number, extraChecks?: Function}} p
 * @returns {Promise<Object>} The parsed manifest (validated against extraChecks).
 */
async function runDiscoveryAgent(seriesDir, { overrides, committed, maxSteps, extraChecks }) {
  const manifestPath = path.join(seriesDir, DRAFT_MANIFEST_FILE_NAME);
  const planPath = path.join(seriesDir, PLAN_FILE_NAME);
  harness.logLine(`[get-translation-target] running the intake agent over ${seriesDir}`);

  // Only the DRAFT is cleared — the plan of record stays on disk until a new
  // one has validated, so a failed intake can never leave a series with no plan.
  for (const stale of [manifestPath, planPath]) {
    try {
      await fs.unlink(stale);
    } catch {
      /* nothing to clear */
    }
  }

  // Scale the step cap to how much there is to look at (folders plus candidate
  // source files) — the same lesson as validatorMaxStepsFor.
  const entries = await fs.readdir(seriesDir, { withFileTypes: true });
  const candidates = entries.filter(
    (e) => e.isDirectory() || isSourceEntry(e)
  ).length;
  const stepCap =
    maxSteps ?? Math.max(DISCOVERY_BASE_STEPS, DISCOVERY_STEPS_PER_CANDIDATE * candidates + 20);

  const fsGate = await harness.createGatedFsTools({
    cwd: seriesDir,
    allowedDirs: [seriesDir], // writes stay inside the series location
  });
  const epubGate = await harness.createEpubTools({
    cwd: seriesDir,
    allowedDirs: [seriesDir],
    sampleChars: discoverSampleChars(),
  });
  const agent = await harness.createAgentHandle({
    name: "intake",
    systemPrompt: await loadIntakeSystemPrompt(),
    tools: { ...fsGate.tools, ...epubGate.tools },
    approve: createIntakeApprove(fsGate, epubGate),
    cwd: seriesDir,
    maxSteps: stepCap,
  });
  harness.logLine(
    `[get-translation-target] intake step cap ${stepCap} (${candidates} entries to look at).`
  );

  let manifest = null;
  try {
    let result = await agent.sendTurn(
      await buildDiscoveryTurnPrompt({ seriesDir, overrides, committed }),
      { label: "series-intake" }
    );
    assertRealToolCalls(result, "the intake agent");
    manifest = await readManifestFile(manifestPath);
    if (!manifest && result && result.text) {
      manifest = await salvageManifest(result.text, manifestPath);
    }

    let problem = await firstPlanProblem(manifest, extraChecks);
    if (problem) {
      harness.logLine(
        `[get-translation-target] the intake plan is invalid (${problem.message}); ` +
          `giving the agent one correction turn.`
      );
      result = await agent.sendTurn(buildCorrectionTurnPrompt(problem.message), {
        label: "series-intake-correction",
      });
      assertRealToolCalls(result, "the intake agent's correction turn");
      const again =
        (await readManifestFile(manifestPath)) ||
        (result && result.text ? await salvageManifest(result.text, manifestPath) : null);
      if (again) manifest = again;
      problem = await firstPlanProblem(manifest, extraChecks);
      if (problem) {
        throw new Error(
          `the intake agent's plan is still invalid after a correction turn: ${problem.message}`
        );
      }
    }

    if (!manifest) {
      throw new Error(
        `The intake agent did not produce a usable ${MANIFEST_FILE_NAME}. Check the ` +
          `run log under .logs/ to see what it did, then re-run with --force.`
      );
    }
    if (!(await fileExists(planPath))) {
      harness.logLine(
        `[get-translation-target] WARN: the agent wrote the manifest but not ` +
          `${PLAN_FILE_NAME} — the human-readable plan is missing for this run.`
      );
    }
    return manifest;
  } finally {
    await agent.close();
  }
}

// ─── Public entry point ─────────────────────────────────────────────────────


module.exports = {
  readManifestFile,
  salvageManifest,
  firstManifestProblem,
  firstPlanProblem,
  createIntakeApprove,
  runDiscoveryAgent,
};

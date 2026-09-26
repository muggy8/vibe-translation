/**
 * get-translation-target.js — AI-driven discovery of the translation target.
 *
 * The glossary and jump-in-wiki tasks used to discover the volume folders and
 * their source files with hard-coded logic: "a directory under SERIES_LOCATION
 * whose name contains SERIES_NAME", the source being
 * "<folder>/<folder>.md", the number being the trailing "(N)". That breaks the
 * moment a source file is named differently, nested, or a volume folder does
 * not carry the series name.
 *
 * This module replaces that guesswork with a tool-calling AI agent
 * (harness.js). The agent lists SERIES_LOCATION, decides which entries are the
 * series' volume folders, opens candidate files to confirm which one is the
 * actual source text (ignoring the generated wiki/glossary artifacts and the
 * images), and writes the result to <SERIES_LOCATION>/translation-target.json.
 * The tasks read that manifest, so they never have to guess file names.
 *
 * The manifest is cached: getTranslationTarget() reuses an existing, valid
 * manifest unless { force } is set. If a listed source file no longer exists
 * the manifest is considered stale and is regenerated. With --dry-run no AI
 * call is made — a deterministic fallback (the legacy convention) builds the
 * manifest instead, so prompt previews stay fully offline.
 *
 * Manifest schema (paths are relative to seriesLocation):
 *   {
 *     generatedAt: string (ISO 8601),
 *     generator: string,
 *     seriesLocation: string,
 *     seriesName: string,
 *     sourceLanguage: string,
 *     targetLanguage: string,
 *     volumes: [
 *       { installmentNumber: "01",
 *         folder: "Series(1)",
 *         sourceFile: "Series(1)/Series(1).md",
 *         notes: string },
 *       ...
 *     ]
 *   }
 *
 * Usage (module):
 *   const { getTranslationTarget } = require("./get-translation-target");
 *   const manifest = await getTranslationTarget({ force, dryRun });
 *
 * Usage (CLI):
 *   node get-translation-target.js          # reuse a valid manifest, else scan
 *   node get-translation-target.js --force  # always re-scan with the agent
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types"); // JSDoc type definitions
const { orderBy } = require("natural-orderby");
const harness = require("./harness");
const { extractJsonObject, installmentNumberFromDir } = require("./utils/manifest");
const { fileExists } = require("./utils/fs");

// ─── Constants ──────────────────────────────────────────────────────────────

/** File name of the manifest, relative to SERIES_LOCATION. */
const MANIFEST_FILE_NAME = "translation-target.json";

/**
 * Default step cap for the discovery agent. Each tool call (listFiles /
 * readFile / writeFile) counts as a step; the effective cap is scaled up in
 * runDiscoveryAgent() to the number of top-level directories so a large series
 * does not run out of steps before it writes the manifest (the same lesson as
 * validatorMaxStepsFor in jump-in-wiki.js).
 */
const DISCOVERY_BASE_STEPS = 40;

/**
 * System prompt for the discovery agent. It is mode-agnostic and states only
 * the invariants: find the volumes, find each volume's source text, number and
 * order them, and emit exact JSON. The concrete series details and the output
 * schema are supplied by buildDiscoveryTurnPrompt().
 */
const DISCOVERY_SYSTEM_PROMPT = [
  "You are a meticulous cataloguer for a light-novel translation pipeline.",
  "You are given one folder (the \"series location\") that holds the volumes of",
  "a single light-novel series plus some unrelated clutter. Your job is to",
  "produce an exact machine-readable inventory of the volumes so that the",
  "downstream translation tasks never have to guess where anything is.",
  "",
  "How to work:",
  "- Use the listFiles tool to enumerate folders, and the readFile tool to open",
  "  a file only when you must confirm what a file is. A short read is enough",
  "  to identify a file's role; do not read large files in full.",
  "- A \"volume\" is a top-level subfolder of the series location that holds one",
  "  installment of the series. Ignore anything that is not a volume folder",
  "  (version-control dirs like \".git\", nested tool or client folders, and",
  "  loose files outside volume folders).",
  "- Inside each volume folder, identify the single file that is the actual",
  '  source text of the novel. The source is either a Markdown file (the',
  '  convention is \"<folder>.md\" matching the folder name) or an EPUB file',
  '  (\"<folder>.epub\"). Ignore generated artifacts, bundle outputs and assets:',
  "  wiki.md, shared-wiki.md, glossary.md, glossary-research.md,",
  "  glossary-validation.md, jump-in-wiki-validation-*.md, character-voice.md,",
  "  character-voice-validation*.md, pov-map.md, style-guide.md,",
  "  style-guide-validation*.md, *-bundle.meta.json, *-whole.md, *-ch*.md",
  "  (chapters, chN.K interlude/epilogue files), images/ folders, and the",
  "  manifest file (translation-target.json).",
  "- Determine each volume's installment number (a zero-padded string, e.g.",
  "  \"01\") and list the volumes in correct reading order (first volume first).",
  "- Be exact. The JSON you write is parsed by code and must be valid JSON.",
].join("\n");

// ─── Pure helpers ───────────────────────────────────────────────────────────
// The JSON extraction and installment-number helpers are in utils/fs.js.

/**
 * Validate the shape of a translation-target manifest. This is a pure check
 * (it does not touch the filesystem); existence of the listed source files is
 * checked separately by the caller, which needs async fs access.
 *
 * @param {TranslationTargetManifest} manifest - The parsed manifest.
 * @returns {TranslationTargetManifest} The same manifest, when valid.
 * @throws {Error} When the manifest is missing required fields or is
 *   internally inconsistent (duplicate folders or installment numbers).
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("The manifest is not a JSON object.");
  }
  if (!Array.isArray(manifest.volumes) || manifest.volumes.length === 0) {
    throw new Error(
      'The manifest has no volumes ("volumes" must be a non-empty array).'
    );
  }
  const folders = new Set();
  const numbers = new Set();
  manifest.volumes.forEach((vol, idx) => {
    const where = `volumes[${idx}]`;
    if (!vol || typeof vol !== "object" || Array.isArray(vol)) {
      throw new Error(`${where} is not an object.`);
    }
    for (const key of ["installmentNumber", "folder", "sourceFile"]) {
      if (typeof vol[key] !== "string" || vol[key].trim() === "") {
        throw new Error(`${where} is missing a non-empty string "${key}".`);
      }
    }
    if (folders.has(vol.folder)) {
      throw new Error(`${where} duplicates folder "${vol.folder}".`);
    }
    folders.add(vol.folder);
    if (numbers.has(vol.installmentNumber)) {
      throw new Error(
        `${where} duplicates installment number "${vol.installmentNumber}".`
      );
    }
    numbers.add(vol.installmentNumber);
  });
  return manifest;
}

// ─── Discovery backends ─────────────────────────────────────────────────────
// The installment-number and file-exists helpers are in utils/fs.js.

/**
 * Build a manifest with the legacy hard-coded convention (no AI call). This is
 * the --dry-run backend and a resilience fallback: volume folders are the
 * directories under SERIES_LOCATION whose name contains SERIES_NAME,
 * sorted in natural order, with the source assumed to be "<folder>/<folder>.md"
 * (or "<folder>/<folder>.epub" when the Markdown file is absent). Folders whose
 * expected source file is missing are skipped.
 *
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @param {{sourceLanguage: string, targetLanguage: string}} langs - The
 *   source/target languages to record in the manifest.
 * @returns {Promise<Object>} A manifest (may have zero volumes if nothing
 *   matches the convention).
 */
async function buildDeterministicManifest(seriesDir, { sourceLanguage, targetLanguage }) {
  const seriesName = process.env.SERIES_NAME;
  const entries = await fs.readdir(seriesDir, { withFileTypes: true });
  const folderNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.includes(seriesName));
  const sorted = orderBy(folderNames);

  const volumes = [];
  for (const folderName of sorted) {
    const volumeDir = path.join(seriesDir, folderName);
    // Convention: "<folder>/<folder>.md"; epub sources fall back to
    // "<folder>/<folder>.epub" (the bundle layout normalizes either).
    const candidates = [`${folderName}.md`, `${folderName}.epub`];
    let sourceFile = null;
    for (const candidate of candidates) {
      if (await fileExists(path.join(volumeDir, candidate))) {
        sourceFile = path.join(folderName, candidate); // relative to seriesDir
        break;
      }
    }
    if (!sourceFile) continue;
    volumes.push({
      installmentNumber: installmentNumberFromDir(volumeDir),
      folder: folderName,
      sourceFile,
      notes: "deterministic fallback (no AI)",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    generator: "get-translation-target.js (deterministic fallback)",
    seriesLocation: seriesDir,
    seriesName,
    sourceLanguage,
    targetLanguage,
    volumes,
  };
}

/**
 * Build the user turn for the discovery agent, interpolating the series
 * details and the exact output schema the agent must write.
 *
 * @param {{seriesDir: string, seriesName: string, sourceLanguage: string, targetLanguage: string}} p
 * @returns {string} The turn prompt.
 */
function buildDiscoveryTurnPrompt({ seriesDir, seriesName, sourceLanguage, targetLanguage }) {
  return [
    `Series location (the folder to scan): ${seriesDir}`,
    `Series name (source language): ${seriesName}`,
    `Source language: ${sourceLanguage}`,
    `Target language: ${targetLanguage}`,
    "",
    `Scan the series location and write a manifest file named "${MANIFEST_FILE_NAME}"`,
    "inside the series location using the writeFile tool. The file must contain",
    "ONLY this JSON object (no prose, no markdown fences):",
    "",
    "{",
    `  "generatedAt": "<ISO 8601 timestamp, e.g. ${new Date().toISOString()}>",`,
    '  "generator": "get-translation-target.js",',
    `  "seriesLocation": "${seriesDir}",`,
    `  "seriesName": "${seriesName}",`,
    `  "sourceLanguage": "${sourceLanguage}",`,
    `  "targetLanguage": "${targetLanguage}",`,
    '  "volumes": [',
    "    {",
    '      "installmentNumber": "01",',
    '      "folder": "<volume folder name, relative to the series location>",',
    "      \"sourceFile\": \"<path to the volume's source text file, relative to the series location>\",",
    '      "notes": "<a short note only if you had to disambiguate; otherwise an empty string>"',
    "    }",
    "  ]",
    "}",
    "",
    "Requirements:",
    '- "volumes" must be in reading order (first volume first), one entry per volume.',
    "- \"folder\" is the volume folder's name relative to the series location.",
    "- \"sourceFile\" is the source text file's path relative to the series",
    "  location (it usually lives inside the volume folder).",
    "- Do not include entries for non-volume folders or generated artifacts.",
    "- After writing the file, reply with a one-line summary (how many volumes,",
    "  and any folder whose source you were unsure about). Do not paste the",
    "  JSON back into your reply.",
  ].join("\n");
}

/**
 * Run the discovery agent over SERIES_LOCATION and return the manifest it
 * produces. The agent writes the manifest to disk (the primary path); if the
 * file is missing or unparseable the manifest is salvaged from the agent's
 * chat reply and persisted. Throws a loud, actionable error when no usable
 * manifest can be produced.
 *
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @param {{seriesName: string, sourceLanguage: string, targetLanguage: string, maxSteps?: number}} p
 * @returns {Promise<Object>} The parsed manifest (not yet validated).
 */
async function runDiscoveryAgent(
  seriesDir,
  { seriesName, sourceLanguage, targetLanguage, maxSteps }
) {
  const manifestPath = path.join(seriesDir, MANIFEST_FILE_NAME);
  harness.logLine(
    `[get-translation-target] running the discovery agent over ${seriesDir}`
  );

  // Scale the step cap to the number of top-level directories (each volume
  // folder costs a listing plus possibly a confirming read).
  const topEntries = await fs.readdir(seriesDir, { withFileTypes: true });
  const dirCount = topEntries.filter((e) => e.isDirectory()).length;
  const stepCap = maxSteps ?? Math.max(DISCOVERY_BASE_STEPS, 4 * dirCount + 20);

  const fsGate = await harness.createGatedFsTools({
    cwd: seriesDir,
    allowedDirs: [seriesDir], // the agent may write the manifest at the series root, nothing outside it
  });
  const agent = await harness.createAgentHandle({
    name: "discovery",
    systemPrompt: DISCOVERY_SYSTEM_PROMPT,
    tools: fsGate.tools,
    approve: fsGate.approve,
    cwd: seriesDir,
    maxSteps: stepCap,
  });

  let result;
  try {
    result = await agent.sendTurn(
      buildDiscoveryTurnPrompt({ seriesDir, seriesName, sourceLanguage, targetLanguage }),
      { label: "translation-target-discovery" }
    );
  } finally {
    await agent.close();
  }

  // Primary: the agent wrote the manifest file.
  let manifest = null;
  if (await fileExists(manifestPath)) {
    try {
      manifest = extractJsonObject(await fs.readFile(manifestPath, "utf-8"));
    } catch (err) {
      harness.logLine(
        `[get-translation-target] WARN: could not parse the manifest file: ${err.message}`
      );
    }
  }

  // Fallback: salvage the JSON from the agent's reply and persist it.
  if (!manifest && result && result.text) {
    try {
      manifest = extractJsonObject(result.text);
      await fs.writeFile(
        manifestPath,
        JSON.stringify(manifest, null, 2) + "\n",
        "utf-8"
      );
      harness.logLine(
        `[get-translation-target] salvaged the manifest from the agent's reply and wrote ${manifestPath}`
      );
    } catch (err) {
      harness.logLine(
        `[get-translation-target] WARN: could not salvage the manifest from the reply: ${err.message}`
      );
    }
  }

  if (!manifest) {
    throw new Error(
      `The discovery agent did not produce a usable ${MANIFEST_FILE_NAME}. ` +
        `Check the run log under .logs/ to see what it did, then re-run with --force to retry.`
    );
  }
  return manifest;
}

/**
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @param {TranslationTargetManifest} manifest - A parsed manifest.
 * @returns {Promise<boolean>} True when every listed source file exists on disk.
 */
async function manifestSourcesExist(seriesDir, manifest) {
  for (const vol of manifest.volumes) {
    const abs = path.resolve(seriesDir, vol.sourceFile);
    if (!(await fileExists(abs))) {
      return false;
    }
  }
  return true;
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Get (or produce) the translation-target manifest for SERIES_LOCATION.
 *
 *   - With dryRun, no AI call is made: a deterministic manifest is built from
 *     the legacy convention (keeps --dry-run fully offline).
 *   - Otherwise, an existing valid manifest is reused unless force is set. A
 *     manifest is "valid" when it parses, passes validateManifest, its
 *     seriesLocation (when present) still matches SERIES_LOCATION, and every
 *     listed source file still exists; a stale one is regenerated.
 *   - When a manifest must be (re)generated, the discovery agent runs and the
 *     validated manifest is written to <SERIES_LOCATION>/translation-target.json.
 *
 * @param {{force?: boolean, dryRun?: boolean}} [opts]
 * @returns {Promise<Object>} The validated manifest object.
 */
async function getTranslationTarget({ force = false, dryRun = false } = {}) {
  const seriesDir = process.env.SERIES_LOCATION;
  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  if (!process.env.SERIES_NAME) {
    throw new Error("SERIES_NAME is not set. Please set it in .env.");
  }

  let stat;
  try {
    stat = await fs.stat(seriesDir);
  } catch {
    throw new Error(
      `SERIES_LOCATION does not exist or is not accessible: ${seriesDir}`
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`SERIES_LOCATION is not a directory: ${seriesDir}`);
  }

  const seriesName = process.env.SERIES_NAME;
  const sourceLanguage = process.env.TRANSLATION_SOURCE_LANGUAGE || "Japanese";
  const targetLanguage = process.env.TRANSLATION_TARGET_LANGUAGE || "English";

  // --dry-run: no AI calls. Build the manifest from the legacy convention.
  if (dryRun) {
    const manifest = await buildDeterministicManifest(seriesDir, {
      sourceLanguage,
      targetLanguage,
    });
    if (manifest.volumes.length === 0) {
      throw new Error(`No volume folders found in ${seriesDir}.`);
    }
    return manifest;
  }

  const manifestPath = path.join(seriesDir, MANIFEST_FILE_NAME);

  // Reuse a cached manifest unless forced or stale.
  if (!force && (await fileExists(manifestPath))) {
    let cached = null;
    try {
      cached = extractJsonObject(await fs.readFile(manifestPath, "utf-8"));
      validateManifest(cached);
    } catch (err) {
      harness.logLine(
        `[get-translation-target] cached manifest is invalid (${err.message}); regenerating.`
      );
    }
    // A manifest generated for a different series location is stale even when
    // every listed (relative) source file still exists — e.g. after migrating
    // machines: a Windows "C:\..." seriesLocation is not absolute on Linux, so
    // any consumer trusting it would resolve every file op relative to the CWD.
    // (Observed live: a Windows-generated manifest was reused on Linux and the
    // character-voice task crashed with ENOENT on <CWD>/C:\.../test_story(1).)
    const sameLocation =
      !cached ||
      !cached.seriesLocation ||
      path.resolve(cached.seriesLocation) === path.resolve(seriesDir);
    if (cached && sameLocation && (await manifestSourcesExist(seriesDir, cached))) {
      harness.logLine(
        `[get-translation-target] reusing the existing manifest (${manifestPath}).`
      );
      return cached;
    }
    if (cached && !sameLocation) {
      harness.logLine(
        `[get-translation-target] cached manifest was generated for ${cached.seriesLocation}, ` +
          `not ${seriesDir}; regenerating.`
      );
    } else if (cached) {
      harness.logLine(
        `[get-translation-target] cached manifest is stale (a listed source file is missing); regenerating.`
      );
    }
  }

  // Generate (or regenerate) with the agent.
  const manifest = await runDiscoveryAgent(seriesDir, {
    seriesName,
    sourceLanguage,
    targetLanguage,
  });
  validateManifest(manifest);
  if (!(await manifestSourcesExist(seriesDir, manifest))) {
    throw new Error(
      `The discovery agent produced a manifest that references source files that ` +
        `do not exist. Inspect ${manifestPath} and re-run with --force.`
    );
  }

  // Record the authoritative metadata (the agent's values are not trusted for
  // these) and persist the validated manifest so the cache is consistent.
  manifest.seriesLocation = seriesDir;
  manifest.seriesName = seriesName;
  manifest.sourceLanguage = sourceLanguage;
  manifest.targetLanguage = targetLanguage;
  manifest.generator = "get-translation-target.js";
  manifest.generatedAt = new Date().toISOString();
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  harness.logLine(
    `[get-translation-target] wrote the manifest to ${manifestPath} (${manifest.volumes.length} volumes).`
  );
  return manifest;
}

// ─── Export for use as a module ─────────────────────────────────────────────

module.exports = {
  getTranslationTarget,
  buildDeterministicManifest,
  // Re-exported from utils/manifest.js for backwards compatibility.
  extractJsonObject: require("./utils/manifest").extractJsonObject,
  validateManifest,
  manifestSourcesExist,
  buildDiscoveryTurnPrompt,
  DISCOVERY_SYSTEM_PROMPT,
  MANIFEST_FILE_NAME,
};

// ─── Ad-hoc CLI ─────────────────────────────────────────────────────────────
// node get-translation-target.js          # reuse a valid manifest, else scan
// node get-translation-target.js --force  # always re-scan with the agent
// The manifest is printed to stdout (progress logs go to stderr via the harness
// run log, so stdout stays clean).

if (require.main === module) {
  const force = process.argv.includes("--force");
  getTranslationTarget({ force })
    .then((manifest) => {
      console.log(JSON.stringify(manifest, null, 2));
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}
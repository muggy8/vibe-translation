/**
 * get-translation-target.js — AI-driven series intake (the pipeline's step 0).
 *
 * The pipeline used to need its series described by hand: SERIES_NAME in .env,
 * volume folders already laid out as "<Series Name>(NN)/<Series Name>.epub",
 * and the source/target languages typed into .env. This module replaces that
 * with an intake AGENT that is handed one folder (SERIES_LOCATION) and works
 * out the rest for itself:
 *
 *   - which files are actually volumes of one series (and which are art books,
 *     previews, duplicates, or another series entirely),
 *   - the reading order, weighing the series marker stored INSIDE each book
 *     against the file names against what the text itself says,
 *   - the series name (in its own language) and the source language (from the
 *     writing it actually read, not from a file name),
 *   - where each volume's artifacts will live: it names the volume folder,
 *     creates it, and stages the source file inside (stageVolume — a copy; the
 *     original is never touched),
 *   - and it writes the plan every later stage acts on.
 *
 * The agent decides; the code only gives it senses (the epub tools in
 * harness.js) and checks that what it wrote is usable. Everything downstream
 * reads the manifest instead of guessing: volume order, folder names, the
 * series name, and the source language (see resolveRunSettings in
 * configs/shared.js).
 *
 * Manifest schema v2 (paths are relative to seriesLocation):
 *   {
 *     schema: 2,
 *     generatedAt: string (ISO 8601), generator: string, seriesLocation: string,
 *     seriesName: string, seriesNameAlt: string,
 *     sourceLanguage: string, targetLanguage: string,
 *     discovery: {
 *       summary: string,
 *       confidence: { seriesName: 0-1, sourceLanguage: 0-1, order: 0-1, ... },
 *       evidence: string[],
 *       excluded: [ { file: string, reason: string } ]
 *     },
 *     volumes: [
 *       { installmentNumber: "01", folder: "Series(01)",
 *         sourceFile: "Series(01)/Series(01).epub", title: string, notes: string }
 *     ]
 *   }
 *
 * The agent also writes a human-readable "translation-plan.md" next to the
 * manifest: the same decisions in prose, for the person starting an overnight
 * run.
 *
 * Caching: getTranslationTarget() reuses an existing, valid, schema-2 manifest
 * unless { force } is set, a listed source file has gone, or the cached
 * seriesLocation no longer matches SERIES_LOCATION. A manifest with an older
 * schema is stale (regenerated) — how a series produced by the older
 * folder-name-only discovery upgrades itself. The plan of record is stable on
 * purpose: re-discovery does not rename a volume folder that already holds
 * pipeline output (applyCommittedLayout).
 *
 * With --dry-run no AI call is made: a deterministic layout is built instead
 * (the legacy "<Series Name>(NN)" convention, extended to a flat pile of source
 * files, which it stages into volume folders so the preview matches the real
 * layout).
 *
 * Usage (module):
 *   const { getTranslationTarget } = require("./get-translation-target");
 *   const manifest = await getTranslationTarget({ force, dryRun });
 *
 * Usage (CLI):
 *   node get-translation-target.js          # reuse a valid manifest, else intake
 *   node get-translation-target.js --force  # always re-run the intake agent
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types"); // JSDoc type definitions
const { orderBy } = require("natural-orderby");
const harness = require("./harness");
const {
  extractJsonObject,
  installmentNumberFromDir,
  normalizeInstallmentNumber,
  sanitizeFolderName,
  filterVolumesByInstallment,
} = require("./utils/manifest");
const { fileExists } = require("./utils/fs");
const { transformUserPrompt } = require("./utils/prompt");
const { sha256OfFile } = require("./utils/source");

// ─── Constants ──────────────────────────────────────────────────────────────

/** File name of the manifest (the plan of record), relative to SERIES_LOCATION. */
const MANIFEST_FILE_NAME = "translation-target.json";

/** File name of the human-readable plan written next to it. */
const PLAN_FILE_NAME = "translation-plan.md";

/**
 * The manifest schema this code requires. A cached manifest with any other (or
 * missing) schema is stale and regenerated — how a series produced by the
 * older folder-name-only discovery upgrades itself.
 */
const MANIFEST_SCHEMA = 2;

/**
 * Step budget for the intake agent, scaled to how much there is to look at:
 * each candidate costs at least an epubInfo call and usually a text sample,
 * plus the staging calls and the two writes at the end. (Same lesson as
 * validatorMaxStepsFor — a fixed cap runs out on a big series.)
 */
const DISCOVERY_BASE_STEPS = 60;
const DISCOVERY_STEPS_PER_CANDIDATE = 6;

/** Delay between intake attempts (a fresh agent per attempt). */
const DISCOVERY_RETRY_DELAY_MS = 10000;

/**
 * Exact file names that mark a volume folder as already worked on. Used to
 * protect a folder name from being renamed by a re-run (renaming it would
 * orphan everything already written inside it).
 */
const VOLUME_ARTIFACT_FILES = [
  "glossary.md",
  "character-voice.md",
  "style-guide.md",
  "wiki.md",
  "shared-wiki.md",
  "pov-map.md",
  "chapters.json",
  "translation.md",
  "translation-state.json",
  "translation-brief.md",
  "consistency-report.md",
];

/** Name patterns for the same idea (per-chapter and per-stage outputs). */
const VOLUME_ARTIFACT_PATTERNS = [
  /^translation(-.+)?\.(md|json)$/,
  /^polished-.+\.md$/,
  /^polish-qa\.md$/,
  /^polish-verification\.json$/,
  /^glossary-(research|coverage|new-terms)\.(md|json)$/,
  /^.*-rolling-state\.json$/,
  /^character-voice-(new|validation)\.(md|json)$/,
  /^style-guide-(new|validation)\.(md|json)$/,
  /^wiki-.*\.md$/,
  /^.*-validation.*\.md$/,
  /^.*-coverage\.(md|json)$/,
  /^.*-bundle\.meta\.json$/,
  /^.*-whole\.md$/,
  /^.*-ch\d+(\.\d+)?\.md$/,
];

/**
 * True when a file name is pipeline output rather than a source file.
 * @param {string} name - A file name.
 * @returns {boolean}
 */
function isVolumeArtifact(name) {
  if (VOLUME_ARTIFACT_FILES.includes(name)) return true;
  return VOLUME_ARTIFACT_PATTERNS.some((re) => re.test(name));
}

// ─── .env knobs ─────────────────────────────────────────────────────────────

/**
 * Whether the intake agent may decide the series name and the source language
 * (default true). With SERIES_AUTO_DISCOVER=false the old strict behavior
 * applies: SERIES_NAME must be in .env.
 * @returns {boolean}
 */
function autoDiscoverEnabled() {
  return String(process.env.SERIES_AUTO_DISCOVER ?? "true").trim().toLowerCase() !== "false";
}

/** How many text characters the intake agent may read per sample call. */
function discoverSampleChars() {
  const n = parseInt(process.env.DISCOVER_SAMPLE_CHARS, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 6000) : 1500;
}

/**
 * The lowest confidence the intake agent may report before the run refuses to
 * start (0 disables the gate). A wrong reading order poisons every cumulative
 * artifact, so an unsure plan is worth stopping for.
 * @returns {number}
 */
function discoverMinConfidence() {
  const n = parseFloat(process.env.DISCOVER_MIN_CONFIDENCE);
  return Number.isFinite(n) ? Math.max(0, Math.min(n, 1)) : 0.6;
}

/** DISCOVER_STRICT=true turns layout disagreements and thin evidence into errors. */
function discoverStrict() {
  return String(process.env.DISCOVER_STRICT || "").trim().toLowerCase() === "true";
}

/** Intake attempts before the task fails (a fresh agent per attempt). */
function discoverMaxAttempts() {
  const n = parseInt(
    process.env.DISCOVER_MAX_ATTEMPTS ?? process.env.DISCOVERY_MAX_ATTEMPTS,
    10
  );
  return Number.isFinite(n) && n > 0 ? n : 2;
}

// ─── The committed layout (what the pipeline already built) ─────────────────

/**
 * @typedef {Object} CommittedVolumeDir
 * An existing folder under the series location.
 * @property {string} folder                — The folder name.
 * @property {boolean} hasPipelineOutput    — True when it already holds generated artifacts.
 * @property {Array<{file: string, sha256: string}>} sources — Source-like files staged inside it.
 */

/**
 * Snapshot the folders that already exist under the series location: which of
 * them already hold pipeline output, and the content hash of every source file
 * staged inside them.
 *
 * This is what makes the plan of record stable. An agent that named folders
 * afresh on every run would otherwise rename "Series(03)" to something prettier
 * and orphan the glossary, wiki, and translation already written inside it.
 *
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @returns {Promise<CommittedVolumeDir[]>} One entry per existing folder.
 */
async function readCommittedLayout(seriesDir) {
  const out = [];
  const entries = await fs.readdir(seriesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "images") continue;
    const dir = path.join(seriesDir, entry.name);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    const sources = [];
    let hasPipelineOutput = false;
    for (const name of names) {
      if (isVolumeArtifact(name)) {
        hasPipelineOutput = true;
        continue;
      }
      if (!/\.(epub|txt|md)$/i.test(name)) continue;
      const abs = path.join(dir, name);
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) continue;
        sources.push({ file: name, sha256: await sha256OfFile(abs) });
      } catch {
        /* unreadable — ignore it in the snapshot */
      }
    }
    out.push({ folder: entry.name, hasPipelineOutput, sources });
  }
  return out;
}

/**
 * Keep the plan of record stable: when the intake agent planned a NEW folder
 * name for a book that is already staged in a folder holding pipeline output,
 * keep the old name (and point the manifest at the copy already there) instead
 * of orphaning that work.
 *
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @param {TranslationTargetManifest} manifest - The agent's plan.
 * @param {CommittedVolumeDir[]} committed - The snapshot from readCommittedLayout.
 * @returns {Promise<string[]>} The warnings it produced (empty when the plan matched).
 */
async function applyCommittedLayout(seriesDir, manifest, committed) {
  const warnings = [];
  const byHash = new Map();
  for (const dir of committed) {
    if (!dir.hasPipelineOutput) continue;
    for (const src of dir.sources) {
      if (!byHash.has(src.sha256)) byHash.set(src.sha256, { folder: dir.folder, src });
    }
  }
  for (const vol of manifest.volumes) {
    const planned = committed.find((c) => c.folder === vol.folder);
    if (planned && planned.hasPipelineOutput) continue; // reusing a committed name — good
    let hash;
    try {
      hash = await sha256OfFile(path.resolve(seriesDir, vol.sourceFile));
    } catch {
      continue; // the source is missing; manifestSourcesExist fails loudly
    }
    const owner = byHash.get(hash);
    if (!owner || owner.folder === vol.folder) continue;
    warnings.push(
      `volume ${vol.installmentNumber}: "${owner.folder}" already holds this book's ` +
        `pipeline output — keeping that folder name instead of the planned ` +
        `"${vol.folder}". The newly staged copy stays behind as a duplicate; ` +
        `remove it by hand if you want it gone.`
    );
    vol.folder = owner.folder;
    vol.sourceFile = path.join(owner.folder, owner.src.file);
    vol.notes = [vol.notes, `folder kept for existing pipeline output: ${owner.folder}`]
      .filter(Boolean)
      .join("; ");
  }
  return warnings;
}
// ─── Manifest validation ────────────────────────────────────────────────────

/**
 * Validate (and tidy) a manifest the intake agent wrote. Everything the rest of
 * the pipeline will act on is checked here, once, before any volume is
 * processed: the schema, the series-level decisions, the installment numbers
 * that define the reading order, and — because the AGENT chooses them — the
 * folder names (sanitized so no chosen name can escape the series folder or
 * break a file system) and the source paths (relative, never escaping "..").
 *
 * @param {TranslationTargetManifest} manifest - The parsed manifest.
 * @returns {TranslationTargetManifest} The same manifest, with normalized fields.
 * @throws {Error} On the first problem, naming it precisely.
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("The manifest is not a JSON object.");
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new Error(
      `manifest schema ${JSON.stringify(manifest.schema)} is not ${MANIFEST_SCHEMA} ` +
        `(an older manifest is regenerated).`
    );
  }
  for (const key of ["seriesName", "sourceLanguage", "targetLanguage"]) {
    if (typeof manifest[key] !== "string" || manifest[key].trim() === "") {
      throw new Error(`manifest is missing a non-empty string "${key}".`);
    }
  }
  if (manifest.seriesNameAlt !== undefined && typeof manifest.seriesNameAlt !== "string") {
    throw new Error(`manifest "seriesNameAlt" must be a string when present.`);
  }
  if (manifest.discovery !== undefined) validateDiscoveryBlock(manifest.discovery);
  if (!Array.isArray(manifest.volumes) || manifest.volumes.length === 0) {
    throw new Error(
      `manifest has no volumes — the intake agent found nothing to translate ` +
        `(check the folder contents and the run log under .logs/).`
    );
  }

  const folders = new Set();
  const numbers = new Set();
  manifest.volumes.forEach((vol, idx) => {
    const where = `volumes[${idx}]`;
    if (!vol || typeof vol !== "object" || Array.isArray(vol)) {
      throw new Error(`${where} is not an object.`);
    }
    vol.installmentNumber = normalizeInstallmentNumber(
      vol.installmentNumber,
      `${where} installmentNumber`
    );
    vol.folder = sanitizeFolderName(vol.folder, `${where} folder`);
    if (typeof vol.sourceFile !== "string" || vol.sourceFile.trim() === "") {
      throw new Error(`${where} is missing a non-empty string "sourceFile".`);
    }
    const src = vol.sourceFile.trim();
    if (path.isAbsolute(src) || /^[A-Za-z]:[\\/]/.test(src)) {
      throw new Error(`${where} sourceFile must be relative to the series location: "${src}".`);
    }
    if (src.split(/[\\/]/).includes("..")) {
      throw new Error(`${where} sourceFile cannot contain "..": "${src}".`);
    }
    vol.sourceFile = src;
    for (const key of ["title", "notes"]) {
      if (vol[key] === undefined) vol[key] = "";
      if (typeof vol[key] !== "string") throw new Error(`${where} "${key}" must be a string.`);
    }
    if (folders.has(vol.folder)) throw new Error(`${where} duplicates folder "${vol.folder}".`);
    folders.add(vol.folder);
    if (numbers.has(vol.installmentNumber)) {
      throw new Error(`${where} duplicates installment number "${vol.installmentNumber}".`);
    }
    numbers.add(vol.installmentNumber);
  });
  return manifest;
}


/**
 * Validate the optional "discovery" block — the agent's own account of what it
 * decided and how sure it was. Malformed evidence is a validation failure: this
 * block is the audit trail a human reads when a plan turns out to be wrong.
 *
 * @param {*} discovery - The block as written.
 * @throws {Error} On any malformed part of it.
 */
function validateDiscoveryBlock(discovery) {
  if (!discovery || typeof discovery !== "object" || Array.isArray(discovery)) {
    throw new Error(`manifest "discovery" must be an object.`);
  }
  if (discovery.summary !== undefined && typeof discovery.summary !== "string") {
    throw new Error(`manifest "discovery.summary" must be a string.`);
  }
  if (discovery.confidence !== undefined) {
    if (!discovery.confidence || typeof discovery.confidence !== "object") {
      throw new Error(`manifest "discovery.confidence" must be an object of 0-1 numbers.`);
    }
    for (const [key, value] of Object.entries(discovery.confidence)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(
          `manifest "discovery.confidence.${key}" must be a number from 0 to 1 ` +
            `(got ${JSON.stringify(value)}).`
        );
      }
    }
  }
  if (discovery.evidence !== undefined) {
    if (
      !Array.isArray(discovery.evidence) ||
      discovery.evidence.some((e) => typeof e !== "string")
    ) {
      throw new Error(`manifest "discovery.evidence" must be an array of strings.`);
    }
  }
  if (discovery.excluded !== undefined) {
    if (!Array.isArray(discovery.excluded)) {
      throw new Error(`manifest "discovery.excluded" must be an array.`);
    }
    discovery.excluded.forEach((item, i) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.file !== "string" ||
        !item.file.trim()
      ) {
        throw new Error(`manifest "discovery.excluded[${i}]" needs a non-empty "file" string.`);
      }
      if (typeof item.reason !== "string" || !item.reason.trim()) {
        throw new Error(`manifest "discovery.excluded[${i}]" needs a non-empty "reason" string.`);
      }
    });
  }
}

/**
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @param {TranslationTargetManifest} manifest - A parsed manifest.
 * @returns {Promise<boolean>} True when every listed source file exists on disk.
 */
async function manifestSourcesExist(seriesDir, manifest) {
  for (const vol of manifest.volumes) {
    if (!(await fileExists(path.resolve(seriesDir, vol.sourceFile)))) return false;
  }
  return true;
}

/**
 * The confidence gate: the lowest number the intake agent reported for any of
 * its decisions. Below DISCOVER_MIN_CONFIDENCE the run stops before it can
 * build a whole series on a guessed order.
 *
 * @param {TranslationTargetManifest} manifest - A validated manifest.
 * @returns {{ok: boolean, worst: number|null, worstKey: string|null, min: number}}
 */
function confidenceGate(manifest) {
  const min = discoverMinConfidence();
  const conf = manifest.discovery && manifest.discovery.confidence;
  if (min <= 0 || !conf || typeof conf !== "object") {
    return { ok: true, worst: null, worstKey: null, min };
  }
  const entries = Object.entries(conf).filter(([, v]) => typeof v === "number");
  if (entries.length === 0) return { ok: true, worst: null, worstKey: null, min };
  const [worstKey, worst] = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { ok: worst >= min, worst, worstKey, min };
}

// ─── Discovery backends ─────────────────────────────────────────────────────

/**
 * Build the manifest with NO AI call — the --dry-run backend, so prompt
 * previews stay fully offline.
 *
 * Two layouts are recognized:
 *   1. the legacy one: directories under SERIES_LOCATION whose name contains
 *      SERIES_NAME, naturally sorted, source "<folder>/<folder>.md" (or .epub /
 *      .txt when the Markdown file is absent);
 *   2. a flat pile: loose .epub / .txt / .md files sitting directly in
 *      SERIES_LOCATION. Those are staged into "<base>(NN)/" folders — the same
 *      layout the intake agent produces — so a dry run previews the layout the
 *      real run will use. (This is the one file-writing side effect --dry-run
 *      has: it creates folders and copies sources, and never modifies or
 *      deletes anything.)
 *
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @param {{sourceLanguage: string, targetLanguage: string, seriesName?: string}} opts
 * @returns {Promise<TranslationTargetManifest>} A manifest (may have zero volumes).
 */
async function buildDeterministicManifest(seriesDir, { sourceLanguage, targetLanguage, seriesName }) {
  const name = seriesName || process.env.SERIES_NAME || "";
  const entries = await fs.readdir(seriesDir, { withFileTypes: true });
  const volumes = [];

  // 1. The legacy volume-folder layout.
  const folderNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((folderName) => name && folderName.includes(name));
  for (const folderName of orderBy(folderNames)) {
    const volumeDir = path.join(seriesDir, folderName);
    let sourceFile = null;
    for (const candidate of [`${folderName}.md`, `${folderName}.epub`, `${folderName}.txt`]) {
      if (await fileExists(path.join(volumeDir, candidate))) {
        sourceFile = path.join(folderName, candidate); // relative to seriesDir
        break;
      }
    }
    if (!sourceFile) continue;
    let number;
    try {
      number = installmentNumberFromDir(volumeDir);
    } catch {
      // No "(NN)" in the name: fall back to the position in the natural sort.
      number = String(volumes.length + 1);
    }
    volumes.push({
      installmentNumber: normalizeInstallmentNumber(number),
      folder: folderName,
      sourceFile,
      title: folderName,
      notes: "deterministic fallback (no AI)",
    });
  }

  // 2. A flat pile of source files: stage each into its own volume folder.
  if (volumes.length === 0) {
    const loose = entries
      .filter((e) => e.isFile() && /\.(epub|txt|md)$/i.test(e.name) && !isVolumeArtifact(e.name))
      .map((e) => e.name);
    for (const file of orderBy(loose)) {
      const number = String(volumes.length + 1).padStart(2, "0");
      const base = file.replace(/\.[^.]+$/, "");
      const folder = sanitizeFolderName(`${base}(${number})`);
      const target = path.join(seriesDir, folder, file);
      if (!(await fileExists(target))) {
        await fs.mkdir(path.join(seriesDir, folder), { recursive: true });
        await fs.copyFile(path.join(seriesDir, file), target);
        harness.logLine(
          `[get-translation-target] staged ${file} into ${folder}/ (deterministic layout).`
        );
      }
      volumes.push({
        installmentNumber: number,
        folder,
        sourceFile: path.join(folder, file),
        title: base,
        notes: "deterministic fallback (no AI): staged from the series root",
      });
    }
  }

  return {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    generator: "get-translation-target.js (deterministic fallback)",
    seriesLocation: seriesDir,
    seriesName: name,
    seriesNameAlt: name,
    sourceLanguage,
    targetLanguage,
    discovery: {
      summary: "Deterministic layout built without an AI call (--dry-run).",
      confidence: {},
      evidence: [],
      excluded: [],
    },
    volumes,
  };
}

// ─── The intake agent's prompts ─────────────────────────────────────────────

/** Prompt pair for the intake agent (mode-agnostic files; the tool note is appended in code). */
const SYSTEM_PROMPT_FILE = path.join(__dirname, "system-prompts", "translation-target.md");
const USER_PROMPT_FILE = path.join(__dirname, "user-prompts", "translation-target.md");

/**
 * Appended to the intake system prompt so the prompt file stays mode-agnostic
 * (the AGENT_TOOLS_NOTE pattern) and the agent is told about the epub tools,
 * which are not part of the usual file-tool set.
 *
 * @type {string}
 */
const INTAKE_TOOLS_NOTE = `

## Tools (agent mode)

Your working folder is the series location; always use paths relative to it.
- listFiles / grep / readFile — inspect the folder and any plain-text file. readFile CANNOT read .epub files.
- epubInfo(filePath) — open a book: its catalog card (title, author, language tag, the series name and book number stored inside it) and its section list.
- readEpubText(filePath, section, offset, limit) — sample a bounded slice of one section's text.
- stageVolume({ sourceFile, folder, as }) — create a volume folder and copy a source into it. It never touches the original.
- writeFile — write the manifest and the plan document. Always write the WHOLE file with writeFile; never append.
- You cannot delete files.
- **CRITICAL: both output files must be written with writeFile. A chat reply is not saved to disk — if you put the JSON in your reply instead of calling writeFile, the manifest will not exist and the run will fail.**
`;

/**
 * Load the intake system prompt and append the tool note.
 * @returns {Promise<string>}
 */
async function loadIntakeSystemPrompt() {
  return (await fs.readFile(SYSTEM_PROMPT_FILE, "utf-8")) + INTAKE_TOOLS_NOTE;
}

/**
 * Render the "fixed values" block: what .env pins down (if anything) and what
 * is left to the agent. The target language is always fixed — the agent cannot
 * know which language the user wants to read the books in.
 *
 * @param {{seriesName?: string, sourceLanguage?: string, targetLanguage: string}} overrides
 * @returns {string} A non-empty Markdown block.
 */
function fixedValuesBlock({ seriesName, sourceLanguage, targetLanguage }) {
  const lines = [];
  if (seriesName) lines.push(`- Series name — use exactly this: ${seriesName}`);
  if (sourceLanguage) lines.push(`- Source language — use exactly this: ${sourceLanguage}`);
  lines.push(`- Target language — fixed by configuration, use exactly this: ${targetLanguage}`);
  if (seriesName && sourceLanguage) {
    lines.push(
      "- The series name and source language are fixed above. Still check them against what you read, and report any conflict in discovery.evidence."
    );
  } else {
    lines.push("- Everything not listed above is yours to decide from what you actually read.");
  }
  return `## Fixed values\n\n${lines.join("\n")}`;
}

/**
 * Render the "existing folders" block — the committed layout, so the agent
 * reuses a folder name that already holds pipeline output instead of orphaning
 * it.
 *
 * @param {CommittedVolumeDir[]} committed - From readCommittedLayout().
 * @returns {string} A non-empty Markdown block.
 */
function committedLayoutBlock(committed) {
  const worked = committed.filter((c) => c.hasPipelineOutput);
  const plain = committed.filter((c) => !c.hasPipelineOutput && c.sources.length > 0);
  if (worked.length === 0 && plain.length === 0) {
    return "## Existing folders\n\nNone — this folder holds no pipeline output yet.";
  }
  const lines = [];
  if (worked.length > 0) {
    lines.push(
      "These folders already hold pipeline output. **Reuse their names** for the book staged inside them — renaming one would orphan the work already done there:"
    );
    for (const c of worked) {
      lines.push(`- ${c.folder}/ (${c.sources.map((s) => s.file).join(", ") || "no source staged yet"})`);
    }
  }
  if (plain.length > 0) {
    lines.push("These folders exist but hold no pipeline output yet (you may rename or replace them):");
    for (const c of plain) lines.push(`- ${c.folder}/ (${c.sources.map((s) => s.file).join(", ")})`);
  }
  return `## Existing folders\n\n${lines.join("\n")}`;
}

/**
 * Build the intake agent's user turn from the user-prompt template.
 *
 * @param {{seriesDir: string, overrides: {seriesName?: string, sourceLanguage?: string, targetLanguage: string}, committed: CommittedVolumeDir[]}} p
 * @returns {Promise<string>} The turn prompt.
 */
async function buildDiscoveryTurnPrompt({ seriesDir, overrides, committed }) {
  const template = await fs.readFile(USER_PROMPT_FILE, "utf-8");
  return transformUserPrompt(template, {
    SERIES_LOCATION: seriesDir,
    MANIFEST_FILE: MANIFEST_FILE_NAME,
    PLAN_FILE: PLAN_FILE_NAME,
    SAMPLE_CHARS: String(discoverSampleChars()),
    FIXED_VALUES_BLOCK: fixedValuesBlock(overrides),
    COMMITTED_LAYOUT_BLOCK: committedLayoutBlock(committed),
  });
}

/**
 * The correction turn: the same agent gets its own validation error and fixes
 * its plan (the QA-loop feedback pattern, applied to the plan of record) before
 * the attempt is thrown away for a fresh agent.
 *
 * @param {string} problem - The validation error message.
 * @returns {string} The turn prompt.
 */
function buildCorrectionTurnPrompt(problem) {
  return [
    `Your plan failed validation. Fix it and write ${MANIFEST_FILE_NAME} again`,
    "with writeFile — the whole file, same schema, nothing but the JSON object.",
    "",
    "Validation error:",
    problem,
    "",
    "Keep everything that was already correct. If you change a volume's folder,",
    "stage that source into the new folder with stageVolume first, and make",
    '"sourceFile" point at the file that is really on disk.',
  ].join("\n");
}

// ─── Running the intake agent ───────────────────────────────────────────────

/**
 * True when an agent turn produced tool-call syntax as plain text instead of
 * real tool calls (the intermittent local-endpoint failure described in
 * AGENTS.md gotcha 18 — a turn that looks fine but read and wrote nothing).
 *
 * @param {Object|null} result - An agent sendTurn result.
 * @returns {boolean}
 */
function emittedToolCallAsText(result) {
  if (!result) return false;
  if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) return false;
  const text = typeof result.text === "string" ? result.text : "";
  return text.includes("tool_call") || text.includes("<function=");
}

/**
 * Fail loudly when the intake agent made no real tool calls at all. Without
 * this, a no-op turn just ends as "no manifest found" and the retry loop burns
 * attempts on the same broken endpoint.
 *
 * @param {Object|null} result - The sendTurn result.
 * @param {string} who - Who the agent was (for the message).
 * @returns {void}
 */
function assertRealToolCalls(result, who) {
  if (!emittedToolCallAsText(result)) return;
  throw new Error(
    `${who} emitted tool-call syntax as plain text ("tool_call" / <function=…>) ` +
      `instead of using the tool-calling API, so no tools ran — nothing was read, ` +
      `staged, or written. See the agent transcript in .logs/. This is an ` +
      `intermittent model/endpoint issue with OpenAI tool_calls; re-run, and if ` +
      `it persists check the endpoint.`
  );
}

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
 * @param {{overrides: {seriesName?: string, sourceLanguage?: string, targetLanguage: string}, committed: CommittedVolumeDir[], maxSteps?: number}} p
 * @returns {Promise<Object>} The parsed manifest (not yet validated).
 */
async function runDiscoveryAgent(seriesDir, { overrides, committed, maxSteps }) {
  const manifestPath = path.join(seriesDir, MANIFEST_FILE_NAME);
  const planPath = path.join(seriesDir, PLAN_FILE_NAME);
  harness.logLine(`[get-translation-target] running the intake agent over ${seriesDir}`);

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
    (e) =>
      e.isDirectory() ||
      (e.isFile() && /\.(epub|txt|md)$/i.test(e.name) && !isVolumeArtifact(e.name))
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
    approve: (call) => fsGate.approve(call) && epubGate.approve(call),
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

    let problem = firstManifestProblem(manifest);
    if (problem) {
      harness.logLine(
        `[get-translation-target] the intake plan is invalid (${problem.message}); ` +
          `giving the agent one correction turn.`
      );
      result = await agent.sendTurn(buildCorrectionTurnPrompt(problem.message), {
        label: "series-intake-correction",
      });
      const again =
        (await readManifestFile(manifestPath)) ||
        (result && result.text ? await salvageManifest(result.text, manifestPath) : null);
      if (again) manifest = again;
      problem = firstManifestProblem(manifest);
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

/**
 * Log what the pipeline is about to act on — the intake agent's decisions are
 * configuration now, so every run states them up front.
 *
 * @param {TranslationTargetManifest} manifest - The validated manifest.
 * @returns {void}
 */
function logManifestSummary(manifest) {
  const d = manifest.discovery || {};
  harness.logLine(
    `[get-translation-target] ${manifest.volumes.length} volume(s); series ` +
      `"${manifest.seriesName}"; ${manifest.sourceLanguage} -> ${manifest.targetLanguage}.`
  );
  if (d.summary) harness.logLine(`[get-translation-target] intake: ${d.summary}`);
  if (d.confidence && typeof d.confidence === "object") {
    const parts = Object.entries(d.confidence).map(([k, v]) => `${k}=${v}`);
    if (parts.length) harness.logLine(`[get-translation-target] confidence: ${parts.join(", ")}`);
  }
  if (Array.isArray(d.excluded) && d.excluded.length > 0) {
    harness.logLine(
      `[get-translation-target] excluded ${d.excluded.length} file(s): ` +
        d.excluded.map((e) => `${e.file} (${e.reason})`).join("; ")
    );
  }
}

/**
 * Get (or produce) the translation-target manifest for SERIES_LOCATION.
 *
 *   - dryRun: no AI call — a deterministic layout is built (keeps --dry-run offline).
 *   - Otherwise an existing valid schema-2 manifest is reused unless force is
 *     set, a listed source file has gone, or its seriesLocation no longer
 *     matches SERIES_LOCATION.
 *   - When the intake must run: snapshot the committed layout, run the intake
 *     agent (up to DISCOVER_MAX_ATTEMPTS fresh agents), validate its plan, keep
 *     committed folder names stable, check every source file exists, and apply
 *     the confidence gate. Then stamp the authoritative fields and persist.
 *
 * @param {{force?: boolean, dryRun?: boolean}} [opts]
 * @returns {Promise<TranslationTargetManifest>} The validated manifest.
 */
async function getTranslationTarget({ force = false, dryRun = false } = {}) {
  const seriesDir = process.env.SERIES_LOCATION;
  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  if (!autoDiscoverEnabled() && !process.env.SERIES_NAME) {
    throw new Error(
      `SERIES_NAME is not set and SERIES_AUTO_DISCOVER=false, so the intake ` +
        `agent is not allowed to decide it. Set SERIES_NAME in .env, or remove ` +
        `SERIES_AUTO_DISCOVER to let the intake agent work the series out.`
    );
  }

  let stat;
  try {
    stat = await fs.stat(seriesDir);
  } catch {
    throw new Error(`SERIES_LOCATION does not exist or is not accessible: ${seriesDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`SERIES_LOCATION is not a directory: ${seriesDir}`);
  }

  // .env wins over the manifest; an unset value is left to the intake agent.
  const overrides = {
    seriesName: process.env.SERIES_NAME || undefined,
    sourceLanguage: process.env.TRANSLATION_SOURCE_LANGUAGE || undefined,
    targetLanguage: process.env.TRANSLATION_TARGET_LANGUAGE || "English",
  };

  // --dry-run: no AI calls. Build the layout deterministically.
  if (dryRun) {
    const manifest = await buildDeterministicManifest(seriesDir, {
      sourceLanguage: overrides.sourceLanguage || "Japanese",
      targetLanguage: overrides.targetLanguage,
      seriesName: overrides.seriesName,
    });
    if (manifest.volumes.length === 0) {
      throw new Error(
        `No volumes found in ${seriesDir}: no "<SERIES_NAME>(NN)" folders and no ` +
          `source files (.epub/.txt/.md) at the series root.`
      );
    }
    validateManifest(manifest);
    logManifestSummary(manifest);
    return manifest;
  }

  const manifestPath = path.join(seriesDir, MANIFEST_FILE_NAME);
  const planPath = path.join(seriesDir, PLAN_FILE_NAME);

  // Reuse a cached manifest unless forced or stale.
  if (!force && (await fileExists(manifestPath))) {
    let cached = null;
    try {
      cached = extractJsonObject(await fs.readFile(manifestPath, "utf-8"));
      validateManifest(cached);
    } catch (err) {
      harness.logLine(
        `[get-translation-target] cached manifest is invalid (${err.message}); re-running intake.`
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
      harness.logLine(`[get-translation-target] reusing the existing manifest (${manifestPath}).`);
      logManifestSummary(cached);
      return cached;
    }
    if (cached && !sameLocation) {
      harness.logLine(
        `[get-translation-target] cached manifest was generated for ${cached.seriesLocation}, ` +
          `not ${seriesDir}; re-running intake.`
      );
    } else if (cached) {
      harness.logLine(
        `[get-translation-target] cached manifest is stale (a listed source file is missing); ` +
          `re-running intake.`
      );
    }
  }

  // The committed layout is read BEFORE the agent runs (it is told about it) and
  // applied again after, so a plan that ignores it cannot orphan finished work.
  const committed = await readCommittedLayout(seriesDir);
  const attempts = discoverMaxAttempts();
  let manifest = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const candidate = await runDiscoveryAgent(seriesDir, { overrides, committed });
      validateManifest(candidate);
      const warnings = await applyCommittedLayout(seriesDir, candidate, committed);
      for (const warning of warnings) harness.logLine(`[get-translation-target] ${warning}`);
      if (discoverStrict() && warnings.length > 0) {
        throw new Error(
          `the intake agent renamed ${warnings.length} volume folder(s) that already ` +
            `hold pipeline output (DISCOVER_STRICT=true): ${warnings[0]}`
        );
      }
      if (!(await manifestSourcesExist(seriesDir, candidate))) {
        throw new Error(
          `the intake agent produced a manifest that references source files that ` +
            `do not exist (inspect ${manifestPath}).`
        );
      }
      const gate = confidenceGate(candidate);
      if (!gate.ok) {
        throw new Error(
          `the intake agent reported low confidence (${gate.worstKey} = ${gate.worst}, ` +
            `DISCOVER_MIN_CONFIDENCE=${gate.min}). Read ${planPath} and the evidence ` +
            `in ${manifestPath}: a wrong reading order corrupts every cumulative ` +
            `artifact, so the run stops here. Set DISCOVER_MIN_CONFIDENCE=0 to accept ` +
            `the plan anyway, or fix the folder and re-run with --force.`
        );
      }
      manifest = candidate;
      break;
    } catch (err) {
      lastError = err;
      harness.logLine(
        `[get-translation-target] intake attempt ${attempt}/${attempts} failed: ${err.message}`
      );
      if (attempt < attempts) {
        harness.logLine(
          `[get-translation-target] retrying intake in ${DISCOVERY_RETRY_DELAY_MS / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, DISCOVERY_RETRY_DELAY_MS));
      }
    }
  }
  if (!manifest) {
    throw new Error(
      `Series intake failed after ${attempts} attempt(s): ` +
        `${lastError ? lastError.message : "unknown error"} Inspect ${manifestPath}, ` +
        `${planPath}, and the run log under .logs/, then re-run with --force.`
    );
  }

  // Stamp the authoritative fields: the live SERIES_LOCATION always wins over
  // the agent's copy, and a .env override always wins over the agent's decision.
  manifest.schema = MANIFEST_SCHEMA;
  manifest.seriesLocation = seriesDir;
  manifest.seriesName = overrides.seriesName || manifest.seriesName;
  manifest.seriesNameAlt = manifest.seriesNameAlt || manifest.seriesName;
  manifest.sourceLanguage = overrides.sourceLanguage || manifest.sourceLanguage;
  manifest.targetLanguage = overrides.targetLanguage;
  manifest.generator = "get-translation-target.js";
  manifest.generatedAt = new Date().toISOString();
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  harness.logLine(
    `[get-translation-target] wrote the manifest to ${manifestPath} ` +
      `(${manifest.volumes.length} volumes).`
  );
  logManifestSummary(manifest);
  return manifest;
}

/**
 * Run the intake on its own (the "discover" gulp task): produce or refresh the
 * plan of record and say where it landed, without running any other stage.
 * With dryRun it previews the deterministic layout instead (no AI call).
 *
 * @param {{force?: boolean, dryRun?: boolean}} [opts]
 * @returns {Promise<TranslationTargetManifest>}
 */
async function discoverSeries({ force = false, dryRun = false } = {}) {
  require("./configs/shared").validateRequiredEnv({ dryRun });
  const manifest = await getTranslationTarget({ force, dryRun });
  const dir = process.env.SERIES_LOCATION;
  if (dryRun) {
    // A dry run never writes the plan of record — say so, or the log reads as
    // if the manifest existed on disk.
    harness.logLine(
      `[discover] dry-run preview only: ${manifest.volumes.length} volume(s) laid out ` +
        `without an AI call. Nothing was written to ${path.join(dir, MANIFEST_FILE_NAME)}; ` +
        `run "npx gulp discover" (no --dry-run) to commit the plan of record.`
    );
    return manifest;
  }
  harness.logLine(
    `[discover] plan of record: ${path.join(dir, MANIFEST_FILE_NAME)}; ` +
      `human-readable plan: ${path.join(dir, PLAN_FILE_NAME)}.`
  );
  return manifest;
}

// ─── Export for use as a module ─────────────────────────────────────────────

module.exports = {
  getTranslationTarget,
  discoverSeries,
  buildDeterministicManifest,
  // Re-exported from utils/manifest.js for backwards compatibility.
  extractJsonObject: require("./utils/manifest").extractJsonObject,
  validateManifest,
  manifestSourcesExist,
  readCommittedLayout,
  applyCommittedLayout,
  confidenceGate,
  buildDiscoveryTurnPrompt,
  buildCorrectionTurnPrompt,
  fixedValuesBlock,
  committedLayoutBlock,
  emittedToolCallAsText,
  isVolumeArtifact,
  MANIFEST_FILE_NAME,
  PLAN_FILE_NAME,
  MANIFEST_SCHEMA,
  INTAKE_TOOLS_NOTE,
};

// ─── Ad-hoc CLI ─────────────────────────────────────────────────────────────
// node get-translation-target.js          # reuse a valid manifest, else intake
// node get-translation-target.js --force  # always re-run the intake agent
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

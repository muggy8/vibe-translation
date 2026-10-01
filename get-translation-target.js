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
 * With --dry-run no AI call is made: the committed plan of record is previewed
 * when one exists, and only when there is none is a deterministic layout built
 * instead (the legacy "<Series Name>(NN)" convention, extended to any folder
 * holding a book and to a flat pile of source files, which it stages into
 * volume folders so the preview matches the real layout).
 *
 * Usage (module):
 *   const { getTranslationTarget } = require("./get-translation-target");
 *   const manifest = await getTranslationTarget({ dryRun });          // --force does NOT re-run intake
 *   const manifest2 = await getTranslationTarget({ forceIntake: true });    // this does
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
const { sha256OfFile, openEpub, isEpubPath, readEpubSection } = require("./utils/source");

// ─── Constants ──────────────────────────────────────────────────────────────

/** File name of the manifest (the plan of record), relative to SERIES_LOCATION. */
const MANIFEST_FILE_NAME = "translation-target.json";
// The intake agent writes its plan under this name; it becomes the plan of
// record only after the code has validated it and promoted it. Writing straight
// to MANIFEST_FILE_NAME meant an intake run deleted a perfectly good plan of
// record up front — and if the agent then failed, the series was left with NO
// plan at all.
const DRAFT_MANIFEST_FILE_NAME = "translation-target.draft.json";

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

/** DISCOVER_STRICT=true turns a disagreement with the existing folder layout
 * into an error instead of a warn-and-keep (it fails the step immediately — a
 * retry cannot make the agent respect a policy). */
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
    vol.sourceFile = `${owner.folder}/${owner.src.file}`;
    vol.notes = [vol.notes, `folder kept for existing pipeline output: ${owner.folder}`]
      .filter(Boolean)
      .join("; ");
  }
  return warnings;
}
/**
 * The absolute floor for "this file contains a readable text at all".
 *
 * NOT a story-length rule — "is this a real narrative?" is answered by the
 * intake agent reading it (see validateVolumeIntegrity). This number only
 * catches the objective case: a few hundred characters means binary junk, an
 * empty archive, or a stub, whatever the agent believed.
 *
 * Read from .env (DISCOVER_MIN_VOLUME_TEXT_CHARS, default 1000).
 *
 * @returns {number}
 */
function minVolumeTextChars() {
  const n = parseInt(process.env.DISCOVER_MIN_VOLUME_TEXT_CHARS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1000;
}

/**
 * Validate one volume's "is this actually a book?" judgment.
 *
 * The intake used to report only which files looked like volumes and in what
 * order. Nothing asked whether the text it read was a real narrative — so an
 * art book, a preview sample, or a corrupted archive that happened to open
 * could be listed as volume 03, and the pipeline would build a glossary, a
 * wiki and a translation for it.
 *
 * The judgment is the agent's: "does this read like a story?" is not a question
 * a character-count threshold answers honestly. What the code enforces is that
 * the judgment EXISTS, is stated per volume, and says what it was based on — a
 * gate the model can pass by saying nothing is not a gate (the same rule as the
 * confidence gate).
 *
 * @param {unknown} integrity - The agent's `integrity` block for this volume.
 * @param {string} where - Position label for the error message.
 * @returns {{isNarrative: boolean, confidence: number, basis: string}} The normalized block.
 */
function validateVolumeIntegrity(integrity, where) {
  if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) {
    throw new Error(
      `${where} is missing an "integrity" block. For every volume you accept, report ` +
        `{"integrity": {"isNarrative": true, "confidence": 0.9, "basis": "what you read and why it ` +
        `reads like a story"}}. A file you are not sure is a real narrative belongs in ` +
        `discovery.excluded with a reason, not in volumes.`
    );
  }
  if (typeof integrity.isNarrative !== "boolean") {
    throw new Error(
      `${where} integrity.isNarrative must be true or false: you must say whether the text you ` +
        `read is a real narrative (a story, or a legitimate short story), not leave it blank.`
    );
  }
  if (!Number.isFinite(integrity.confidence) || integrity.confidence < 0 || integrity.confidence > 1) {
    throw new Error(
      `${where} integrity.confidence must be a number from 0 to 1 — how sure you are that this ` +
        `is a real narrative.`
    );
  }
  if (typeof integrity.basis !== "string" || integrity.basis.trim().length < 20) {
    throw new Error(
      `${where} integrity.basis must say WHAT you read and WHAT made it look like a narrative ` +
        `(at least 20 characters — e.g. "opening 1500 chars are continuous prose with chapter ` +
        `structure; 41 text sections, 2 images").`
    );
  }
  return {
    isNarrative: integrity.isNarrative,
    confidence: integrity.confidence,
    basis: integrity.basis.trim(),
  };
}

/**
 * The objective half of "is this a book?" placeholder-removed

/**
 * The objective half of "is this a book?" — the checks that need no guessing
 * about what a story is.
 *
 * Runs against the STAGED file, after the agent's own judgment has been
 * recorded, and can override the agent when the file is objectively not a book:
 *
 *   - an archive with no readable text section is not a book;
 *   - a file that yields essentially no text is binary junk or a stub;
 *   - a text file that is mostly undecodable bytes is a binary file renamed;
 *   - an archive dominated by images is an art book by construction, whatever
 *     the agent called it.
 *
 * @param {string} seriesDir - The series location.
 * @param {TranslationTargetVolume} volume - The volume (sourceFile resolved against seriesDir).
 * @returns {Promise<{ok: boolean, problem?: string, stats: {textChars: number, imageBytes: number, sections: number}}>}  
 *   `ok` false = a hard structural problem; `problem` explains it.
 */
async function checkVolumeSourceShape(seriesDir, volume) {
  const sourcePath = path.resolve(seriesDir, volume.sourceFile);
  const stats = { textChars: 0, imageBytes: 0, sections: 0 };

  if (isEpubPath(sourcePath)) {
    let book = null;
    try {
      book = await openEpub(sourcePath);
    } catch (err) {
      return { ok: false, stats, problem: `"${volume.sourceFile}" will not open as an archive: ${err.message}` };
    }
    const sections = book.textItems || [];
    stats.sections = sections.length;
    if (sections.length === 0) {
      return {
        ok: false,
        stats,
        problem: `"${volume.sourceFile}" has no readable text sections at all — an archive with nothing to read is not a volume.`,
      };
    }
    // Bounded sampling: a 17-book intake must not read every book whole.
    let textChars = 0;
    for (const section of sections.slice(0, 12)) {
      try {
        const slice = await readEpubSection(book, section.index, { offset: 0, limit: 4000 });
        textChars += (slice && slice.text ? slice.text.length : 0);
      } catch {
        /* an unreadable section just contributes nothing; the floors below catch it */
      }
    }
    stats.textChars = textChars;
    const floor = minVolumeTextChars();
    if (textChars < floor) {
      return {
        ok: false,
        stats,
        problem:
          `"${volume.sourceFile}" yields only ${textChars} characters of text across ` +
          `${sections.length} section(s) — under the ${floor}-character floor for ` +
          `"this file contains a readable text at all".`,
      };
    }
    // Art-book signal: the whole file's bytes against its text. A text book
    // compresses to roughly its text size; an art book is almost all image
    // bytes, so its file is many times larger than its prose. (JSZip does not
    // expose per-entry uncompressed sizes until each file is read, and reading
    // every image of a 17-book intake to weigh them is exactly the cost this
    // check exists to avoid.)
    let fileSize = 0;
    try {
      fileSize = (await fs.stat(sourcePath)).size;
    } catch {
      fileSize = 0;
    }
    stats.imageBytes = fileSize; // the archive-byte total
    // A real art book is a LARGE file with proportionally little prose. A tiny
    // text book (one short chapter) is dominated by the archive's fixed
    // overhead — container, OPF, XHTML wrapper — not by images, so the ratio
    // is only trusted once the file is big enough to actually hold images.
    const MIN_ARTBOOK_FILE_BYTES = 50 * 1024;
    if (fileSize > MIN_ARTBOOK_FILE_BYTES && fileSize > textChars * 30) {
      return {
        ok: false,
        stats,
        problem:
          `"${volume.sourceFile}" is ${(fileSize / 1024).toFixed(0)} KB of archive for only ` +
          `${textChars} characters of text — overwhelmingly non-text, i.e. an art book, ` +
          `whatever the intake agent reported. Exclude it, or lower DISCOVER_MIN_VOLUME_TEXT_CHARS ` +
          `if this book really is thin.`,
      };
    }
    return { ok: true, stats };
  }

  // Plain text / Markdown source.
  let raw = "";
  try {
    raw = await fs.readFile(sourcePath, "utf8");
  } catch (err) {
    return { ok: false, stats, problem: `"${volume.sourceFile}" could not be read: ${err.message}` };
  }
  const text = raw.trim();
  stats.textChars = text.length;
  stats.sections = 1;
  if (!text) {
    return { ok: false, stats, problem: `"${volume.sourceFile}" is empty.` };
  }
  const floor = minVolumeTextChars();
  if (text.length < floor) {
    return {
      ok: false,
      stats,
      problem:
        `"${volume.sourceFile}" holds only ${text.length} characters — under the ` +
        `${floor}-character floor for "this file contains a readable text at all".`,
    };
  }
  // A binary file renamed to .txt/.md shows up as replacement characters.
  const junkRatio = (text.match(/\uFFFD/g) || []).length / text.length;
  if (junkRatio > 0.02) {
    return {
      ok: false,
      stats,
      problem:
        `"${volume.sourceFile}" is ${(junkRatio * 100).toFixed(1)}% undecodable bytes — it looks ` +
        `like a binary file, not a text source.`,
    };
  }
  return { ok: true, stats };
}

/**
 * Gate every listed volume on both halves of the integrity story: the agent's
 * stated judgment, and the objective shape of the staged file.
 *
 * @param {string} seriesDir - The series location.
 * @param {TranslationTargetManifest} manifest - The validated manifest.
 * @returns {Promise<string[]>} The problems (empty when the plan passes). A
 *   non-empty list fails the intake attempt so the agent gets a correction turn.
 */
async function volumeIntegrityProblems(seriesDir, manifest) {
  const problems = [];
  for (const vol of manifest.volumes || []) {
    if (!vol.integrity.isNarrative) {
      problems.push(
        `volumes[] "${vol.folder}": the intake agent itself reported this is NOT a narrative ` +
          `("${vol.integrity.basis}"). A volume you do not believe is a story must be listed in ` +
          `discovery.excluded with that reason, not in volumes.`
      );
      continue;
    }
    if (vol.integrity.confidence < 0.5) {
      problems.push(
        `volumes[] "${vol.folder}": the agent's own narrative confidence is ${vol.integrity.confidence} ` +
        `(below 0.5). Read more of it and decide, or exclude it with a reason.`
      );
      continue;
    }
    const shape = await checkVolumeSourceShape(seriesDir, vol);
    if (!shape.ok) problems.push(`volumes[] "${vol.folder}": ${shape.problem}`);
  }
  return problems;
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
    const src = vol.sourceFile.trim().replace(/\\/g, "/");
    if (path.isAbsolute(src) || /^[A-Za-z]:[\\/]/.test(src)) {
      throw new Error(`${where} sourceFile must be relative to the series location: "${src}".`);
    }
    if (src.split("/").includes("..")) {
      throw new Error(`${where} sourceFile cannot contain "..": "${src}".`);
    }
    // The source must live inside the volume's own folder. Without this an agent
    // could point a volume at a loose file at the series root (or at another
    // volume's book): the artifacts would be written into one folder while the
    // book sits in another, and the loose copy would look like a new book to
    // the next intake. Forward slashes are the stored form, so a manifest
    // written on Windows still resolves on Linux.
    const parent = src.split("/").slice(0, -1).join("/");
    if (parent !== vol.folder) {
      throw new Error(
        `${where} sourceFile must be the staged file inside its own volume folder ` +
          `"${vol.folder}/" (got "${src}"). Stage it with stageVolume first, then point ` +
          `sourceFile at the staged copy.`
      );
    }
    vol.sourceFile = src;
    // "Is this actually a book?" is the agent's call to make (see
    // validateVolumeIntegrity) — but it must be MADE, per volume, with a stated
    // basis. An art book or a preview listed as volume 03 otherwise gets a full
    // glossary, wiki and translation built for it.
    vol.integrity = validateVolumeIntegrity(vol.integrity, `${where} integrity`);
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
 * Fail-closed: a plan that reports NO confidence is refused, the same way an
 * unparseable acceptance score is. A gate the model can pass by saying nothing
 * is not a gate, and reading order is the one mistake every later artifact
 * would inherit.
 *
 * @param {TranslationTargetManifest} manifest - A validated manifest.
 * @returns {{ok: boolean, worst: number|null, worstKey: string|null, min: number, reason: string|null}}
 */
function confidenceGate(manifest) {
  const min = discoverMinConfidence();
  const conf = manifest.discovery && manifest.discovery.confidence;
  if (min <= 0) return { ok: true, worst: null, worstKey: null, min, reason: null };
  if (!conf || typeof conf !== "object" || Array.isArray(conf)) {
    return {
      ok: false,
      worst: null,
      worstKey: null,
      min,
      reason: 'the plan reports no "discovery.confidence" object at all',
    };
  }
  const entries = Object.entries(conf).filter(([, v]) => typeof v === "number" && Number.isFinite(v));
  if (entries.length === 0) {
    return {
      ok: false,
      worst: null,
      worstKey: null,
      min,
      reason: '"discovery.confidence" is empty — no confidence was reported for the order, the name, or the language',
    };
  }
  const [worstKey, worst] = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { ok: worst >= min, worst, worstKey, min, reason: null };
}

/**
 * Find a book listed twice. The agent chooses folder names and stages copies, so
 * the same book can end up as two volumes under two names — which silently
 * doubles every cumulative artifact built on it. Content hashes are the only
 * reliable detector, because the file names differ on purpose.
 *
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @param {TranslationTargetManifest} manifest - A validated manifest.
 * @param {Map<string,string>} [hashCache] - Reused path -> sha256 map (the check runs twice per attempt; a 17-book series should not be hashed twice).
 * @returns {Promise<string|null>} The problem as a sentence, or null when every source is distinct.
 */
async function findDuplicateSources(seriesDir, manifest, hashCache = new Map()) {
  const seen = new Map();
  for (const vol of manifest.volumes) {
    const abs = path.resolve(seriesDir, vol.sourceFile);
    let hash = hashCache.get(abs);
    if (hash === undefined) {
      try {
        hash = await sha256OfFile(abs);
      } catch {
        continue; // a missing source is reported by manifestSourcesExist
      }
      hashCache.set(abs, hash);
    }
    const other = seen.get(hash);
    if (other) {
      return (
        `volumes ${other.installmentNumber} ("${other.folder}") and ${vol.installmentNumber} ` +
        `("${vol.folder}") are the SAME book — identical content (sha256 ${hash.slice(0, 12)}…). ` +
        `Keep one volume and list the other file in discovery.excluded as a duplicate.`
      );
    }
    seen.set(hash, vol);
  }
  return null;
}

// ─── Discovery backends ─────────────────────────────────────────────────────

/**
 * Find the book staged inside a volume folder.
 *
 * Two shapes are accepted: the legacy convention ("<folder>.md" / ".epub" /
 * ".txt" — the file named after its own folder) and the shape the intake agent
 * produces (the original file name kept, staged into the folder it chose).
 * Recognising only the first one made --dry-run re-stage every book into a
 * SECOND set of folders next to the committed ones.
 *
 * @param {string} volumeDir - The volume folder.
 * @param {string} folderName - Its name (used for the legacy convention).
 * @returns {Promise<string|null>} The file name inside the folder, or null.
 */
async function firstSourceInVolumeDir(volumeDir, folderName) {
  for (const candidate of [`${folderName}.md`, `${folderName}.epub`, `${folderName}.txt`]) {
    if (await fileExists(path.join(volumeDir, candidate))) return candidate;
  }
  let names;
  try {
    names = await fs.readdir(volumeDir);
  } catch {
    return null;
  }
  const sources = names.filter(
    (name) => /\.(epub|txt|md)$/i.test(name) && !isVolumeArtifact(name)
  );
  if (sources.length === 0) return null;
  return orderBy(sources)[0];
}

/**
 * Build the manifest with NO AI call — the --dry-run backend, so prompt
 * previews stay fully offline. Only used when there is no committed plan of
 * record: getTranslationTarget() previews the committed manifest instead, so a
 * preview always matches what the real run will do.
 *
 * Two layouts are recognized:
 *   1. volume folders that already exist — the legacy "<SERIES_NAME>(NN)" ones
 *      and the folders the intake agent named — each holding its staged book
 *      (under any file name), naturally sorted;
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

  // 1. Volume folders that already exist.
  const folderNames = entries
    .filter((entry) => entry.isDirectory() && entry.name !== "images")
    .map((entry) => entry.name);
  // Prefer the folders that carry the series name (the legacy convention); when
  // the name is unknown or the agent chose other names, take every folder that
  // actually holds a book.
  const named = name ? folderNames.filter((folderName) => folderName.includes(name)) : folderNames;
  for (const folderName of orderBy(named.length > 0 ? named : folderNames)) {
    let folder;
    try {
      folder = sanitizeFolderName(folderName);
    } catch {
      harness.logLine(
        `[get-translation-target] skipping folder "${folderName}" in the deterministic layout: its name is not usable as a volume folder.`
      );
      continue;
    }
    if (folder !== folderName) {
      // Sanitizing only trims and collapses spaces, and a preview cannot rename
      // a folder that already holds work — so a folder whose real name differs
      // from its usable form is reported and skipped rather than mis-pointed.
      harness.logLine(
        `[get-translation-target] skipping folder "${folderName}" in the deterministic layout: ` +
          `its name needs cleaning ("${folder}"); rename it by hand or let the intake agent lay the series out.`
      );
      continue;
    }
    const sourceFile = await firstSourceInVolumeDir(path.join(seriesDir, folderName), folderName);
    if (!sourceFile) continue;
    let number;
    try {
      // No "(NN)" in the name: fall back to the position in the natural sort.
      number = installmentNumberFromDir(path.join(seriesDir, folderName));
    } catch {
      number = String(volumes.length + 1);
    }
    let installmentNumber = normalizeInstallmentNumber(number);
    if (volumes.some((v) => v.installmentNumber === installmentNumber)) {
      // Two folders claiming the same number ("Series(1)" and "Series(01)"):
      // fall back to the sort position instead of failing the whole preview.
      installmentNumber = normalizeInstallmentNumber(volumes.length + 1);
    }
    volumes.push({
      installmentNumber,
      folder,
      sourceFile: `${folder}/${sourceFile}`, // relative to seriesDir, forward slashes
      title: folderName,
      notes: "deterministic fallback (no AI)",
      // The deterministic layout cannot JUDGE whether a book is a real narrative
      // — no model read it. It says so instead of pretending, and the dry-run
      // preview path is the only place this manifest is produced (a live run
      // always goes through the intake agent, whose judgment is gated).
      integrity: {
        isNarrative: true,
        confidence: 0,
        basis:
          "deterministic layout (no AI): the file was recognised as a volume by folder and file " +
          "name only — nobody read it, so nothing is asserted about its content.",
      },
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
        sourceFile: `${folder}/${file}`,
        title: base,
        notes: "deterministic fallback (no AI): staged from the series root",
        integrity: {
          isNarrative: true,
          confidence: 0,
          basis:
            "deterministic layout (no AI): staged from the series root by file name — nobody read " +
            "it, so nothing is asserted about its content.",
        },
      });
    }
  }

  return {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    generator: "get-translation-target.js (deterministic fallback)",
    seriesLocation: seriesDir,
    seriesName: name || deriveSeriesName(volumes, seriesDir),
    seriesNameAlt: name || deriveSeriesName(volumes, seriesDir),
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

/**
 * Work out a series name for the deterministic preview from what is on disk.
 *
 * --dry-run never calls the model, and SERIES_NAME is no longer something every
 * .env carries (the intake agent normally decides it), so the preview names
 * itself from the books it found: the name the volume titles share, falling
 * back to the first title, then to the series folder's own name.
 *
 * @param {TranslationTargetVolume[]} volumes - The volumes the deterministic layout produced.
 * @param {string} seriesDir - SERIES_LOCATION.
 * @returns {string} A usable series name (never empty).
 */
function deriveSeriesName(volumes, seriesDir) {
  const titles = volumes
    .map((v) => String(v.title || v.folder || "").replace(/\s*\(\d+\)\s*$/, "").trim())
    .filter(Boolean);
  if (titles.length === 0) return path.basename(seriesDir);
  if (titles.length === 1) return titles[0];
  let prefix = titles[0];
  for (const title of titles.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < title.length && prefix[i] === title[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  prefix = prefix.replace(/[\s\u2013\u2014:;,()\-]+$/, "").trim();
  return prefix.length >= 3 ? prefix : titles[0];
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
- listFiles(dirPath, recursive: true) — inspect the folder. Pass recursive: true, or you only see the top level and miss books inside subfolders.
- readFile / grep — plain-text files only. The file tools REFUSE .epub paths: an epub is a zip, and reading one as text returns binary junk, so readFile on a book is blocked rather than wasted.
- epubInfo(filePath) — open a book: its catalog card (title, author, language tag, the series name and book number stored inside it) and its section list.
- readEpubText(filePath, section, offset, limit) — sample a bounded slice of one section's text.
- stageVolume({ sourceFile, folder, as }) — create a volume folder and copy a source into it. It never touches the original.
- writeFile — write the manifest and the plan document. Always write the WHOLE file with writeFile; never append.
- You cannot delete files, and you cannot write over a book file.
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
    MANIFEST_FILE: DRAFT_MANIFEST_FILE_NAME,
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
    `Your plan failed validation. Fix it and write ${DRAFT_MANIFEST_FILE_NAME} again`,
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
    const target =
      typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : "";
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
 * Read the committed plan of record and decide whether it is still usable.
 *
 * Returns null — never a half-valid manifest — when the file is missing,
 * unparseable, fails validation, was generated for a different series location,
 * or lists a source file that has gone. Every caller then produces a fresh plan.
 *
 * (The bug this helper exists to prevent: the old code logged "cached manifest
 * is invalid … re-running intake" and then returned the invalid manifest on the
 * next line, because the parse/validate failure left the object in hand. An
 * unsanitized folder name, an un-normalized installment number, or a half-written
 * file then went to every downstream task.)
 *
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @param {string} manifestPath - The manifest file.
 * @param {{why?: string}} [opts] - How to phrase the follow-up in the log.
 * @returns {Promise<TranslationTargetManifest|null>} The usable manifest, or null.
 */
async function readUsableManifest(seriesDir, manifestPath, { why = "re-running intake" } = {}) {
  if (!(await fileExists(manifestPath))) return null;
  let cached;
  try {
    cached = extractJsonObject(await fs.readFile(manifestPath, "utf-8"));
  } catch (err) {
    harness.logLine(
      `[get-translation-target] cached manifest could not be parsed (${err.message}); ${why}.`
    );
    return null;
  }
  const problem = firstManifestProblem(cached);
  if (problem) {
    harness.logLine(`[get-translation-target] cached manifest is invalid (${problem.message}); ${why}.`);
    return null;
  }
  // A manifest generated for a different series location is stale even when
  // every listed (relative) source file still exists — e.g. after migrating
  // machines: a Windows "C:\..." seriesLocation is not absolute on Linux, so
  // any consumer trusting it would resolve every file op relative to the CWD.
  // (Observed live: a Windows-generated manifest was reused on Linux and the
  // character-voice task crashed with ENOENT on <CWD>/C:\.../test_story(1).)
  if (cached.seriesLocation && path.resolve(cached.seriesLocation) !== path.resolve(seriesDir)) {
    harness.logLine(
      `[get-translation-target] cached manifest was generated for ${cached.seriesLocation}, ` +
        `not ${seriesDir}; ${why}.`
    );
    return null;
  }
  if (!(await manifestSourcesExist(seriesDir, cached))) {
    harness.logLine(
      `[get-translation-target] cached manifest is stale (a listed source file is missing); ${why}.`
    );
    return null;
  }
  return cached;
}

/**
 * Get (or produce) the translation-target manifest for SERIES_LOCATION.
 *
 *   - dryRun: no AI call. The committed plan of record is previewed when one
 *     exists (so the preview always matches the real run); otherwise a
 *     deterministic layout is built (keeps --dry-run offline).
 *   - Otherwise an existing valid schema-2 manifest is reused unless intake is
 *     forced, a listed source file has gone, or its seriesLocation no longer
 *     matches SERIES_LOCATION. An INVALID cached manifest is never reused.
 *   - When the intake must run: snapshot the committed layout, run the intake
 *     agent (up to DISCOVER_MAX_ATTEMPTS fresh agents), validate its plan, keep
 *     committed folder names stable, check every source file exists, reject the
 *     same book listed twice, and apply the confidence gate. Then stamp the
 *     authoritative fields and persist.
 *
 * `forceIntake` is the ONLY way to re-run the intake on a valid plan. The
 * tasks' `--force` deliberately does NOT set it: --force means "redo THIS
 * stage", and re-running the intake nine times in one pipeline run (once per
 * task) burned model calls and risked re-deciding a plan that was already fine.
 * Re-decide the plan on purpose with `npx gulp discover --force`.
 *
 * Intake still runs automatically when it must — no usable plan exists, the
 * plan is invalid, or a listed source file has gone missing.
 *
 * @param {{forceIntake?: boolean, dryRun?: boolean}} [opts]
 * @returns {Promise<TranslationTargetManifest>} The validated manifest.
 */
async function getTranslationTarget({ forceIntake = false, dryRun = false } = {}) {
  const seriesDir = process.env.SERIES_LOCATION;
  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
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

  const manifestPath = path.join(seriesDir, MANIFEST_FILE_NAME);
  const planPath = path.join(seriesDir, PLAN_FILE_NAME);

  // --dry-run: no AI calls. Preview the committed plan when there is one.
  // Building a layout from scratch instead used to preview a DIFFERENT order
  // and re-stage every book into a second set of folders next to the committed
  // ones — including the files the intake agent had deliberately excluded
  // (observed: an art book and a preview sample came back as volumes 01 and 03,
  // and the litter then showed up as "existing folders" on the next intake).
  if (dryRun) {
    const committedPlan = await readUsableManifest(seriesDir, manifestPath, {
      why: "previewing the committed plan instead",
    });
    if (committedPlan) {
      harness.logLine(
        `[get-translation-target] dry-run: previewing the committed plan of record ` +
          `(${manifestPath}); no layout was built and nothing was written.`
      );
      logManifestSummary(committedPlan);
      return committedPlan;
    }
    const manifest = await buildDeterministicManifest(seriesDir, {
      sourceLanguage: overrides.sourceLanguage || "Japanese",
      targetLanguage: overrides.targetLanguage,
      seriesName: overrides.seriesName,
    });
    if (manifest.volumes.length === 0) {
      throw new Error(
        `No volumes found in ${seriesDir}: no volume folder holding a book and no ` +
          `source files (.epub/.txt/.md) at the series root.`
      );
    }
    validateManifest(manifest);
    logManifestSummary(manifest);
    return manifest;
  }

  // Reuse a cached manifest unless intake is forced or the plan is stale — and
  // only a manifest that still validates (see readUsableManifest).
  if (!forceIntake) {
    const cached = await readUsableManifest(seriesDir, manifestPath);
    if (cached) {
      harness.logLine(`[get-translation-target] reusing the existing manifest (${manifestPath}).`);
      logManifestSummary(cached);
      return cached;
    }
  }

  // The committed layout is read BEFORE the agent runs (it is told about it) and
  // applied again after, so a plan that ignores it cannot orphan finished work.
  const committed = await readCommittedLayout(seriesDir);
  const attempts = discoverMaxAttempts();
  const sourceHashes = new Map(); // shared across attempts: the same books are re-checked every attempt
  let manifest = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const candidate = await runDiscoveryAgent(seriesDir, {
        overrides,
        committed,
        // A book listed twice is shown to the agent as its own correction task
        // (it can fix that); the same check runs again here as the final gate.
        extraChecks: (m) => findDuplicateSources(seriesDir, m, sourceHashes),
      });
      validateManifest(candidate);
      const warnings = await applyCommittedLayout(seriesDir, candidate, committed);
      for (const warning of warnings) harness.logLine(`[get-translation-target] ${warning}`);
      if (discoverStrict() && warnings.length > 0) {
        // A deliberate policy choice, not a model mistake: retrying cannot make
        // the agent respect it, so fail now instead of burning the attempts.
        const fatal = new Error(
          `the intake agent renamed ${warnings.length} volume folder(s) that already ` +
            `hold pipeline output (DISCOVER_STRICT=true): ${warnings[0]}`
        );
        fatal.fatal = true;
        throw fatal;
      }
      const duplicate = await findDuplicateSources(seriesDir, candidate, sourceHashes);
      if (duplicate) {
        throw new Error(`${duplicate} (inspect ${manifestPath}).`);
      }
      // Both halves of "is this a real volume": the agent's own narrative
      // judgment, and the objective shape of the staged file. A failure here
      // gives the agent a correction turn on the next attempt.
      const integrityProblems = await volumeIntegrityProblems(seriesDir, candidate);
      if (integrityProblems.length > 0) {
        throw new Error(
          `the intake plan lists ${integrityProblems.length} volume(s) that are not sound ` +
            `books:\n  ${integrityProblems.join("\n  ")}`
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
          gate.reason
            ? `the intake plan was rejected: ${gate.reason}, and DISCOVER_MIN_CONFIDENCE=${gate.min} ` +
              `requires the agent to report one for every decision. Read ${planPath} and ` +
              `${manifestPath}, or set DISCOVER_MIN_CONFIDENCE=0 to accept an unmeasured plan.`
            : `the intake agent reported low confidence (${gate.worstKey} = ${gate.worst}, ` +
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
      if (err && err.fatal) throw err;
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
  // Publish atomically: write beside the plan of record, then rename over it.
  // A crash mid-write used to leave a half-written manifest, which the next run
  // rejected (readUsableManifest) and had to rebuild from scratch.
  const tempPath = `${manifestPath}.writing`;
  await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  await fs.rename(tempPath, manifestPath);
  // The agent's draft has served its purpose; keep the series folder clean.
  await fs.unlink(path.join(seriesDir, DRAFT_MANIFEST_FILE_NAME)).catch(() => {});
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
 * With dryRun it previews the committed plan (or a deterministic layout when
 * there is none) — no AI call, and no plan of record written.
 *
 * @param {{force?: boolean, dryRun?: boolean}} [opts]
 * @returns {Promise<TranslationTargetManifest>}
 */
async function discoverSeries({ force = false, dryRun = false } = {}) {
  require("./configs/shared").validateRequiredEnv({ dryRun });
  // The discover task is the ONE place --force means "re-run the intake".
  const manifest = await getTranslationTarget({ forceIntake: force, dryRun });
  const dir = process.env.SERIES_LOCATION;
  if (dryRun) {
    // A dry run never writes the plan of record — say so, or the log reads as
    // if the manifest existed on disk.
    harness.logLine(
      `[discover] dry-run preview only: ${manifest.volumes.length} volume(s), no AI call. ` +
        `Nothing was written to ${path.join(dir, MANIFEST_FILE_NAME)}; ` +
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
  findDuplicateSources,
  readUsableManifest,
  readCommittedLayout,
  applyCommittedLayout,
  validateVolumeIntegrity,
  checkVolumeSourceShape,
  volumeIntegrityProblems,
  minVolumeTextChars,
  confidenceGate,
  createIntakeApprove,
  buildDiscoveryTurnPrompt,
  buildCorrectionTurnPrompt,
  fixedValuesBlock,
  committedLayoutBlock,
  emittedToolCallAsText,
  isVolumeArtifact,
  MANIFEST_FILE_NAME,
  DRAFT_MANIFEST_FILE_NAME,
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
  getTranslationTarget({ forceIntake: force })
    .then((manifest) => {
      console.log(JSON.stringify(manifest, null, 2));
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

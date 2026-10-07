/**
 * The no-AI layout used by --dry-run, and only when there is no committed plan.
 *
 * With a committed plan the dry run previews it as-is and changes nothing; building a
 * layout unconditionally used to preview a DIFFERENT order and re-stage every book into
 * a second set of folders beside the committed ones — including the art book and
 * previews the intake agent had deliberately excluded — and that litter then showed up
 * as 'existing folders' on the next intake (gotcha 31). When there is no plan and no
 * SERIES_NAME, deriveSeriesName names the series from the titles the books share,
 * because a preview must not depend on a variable the real run does not need.
 *
 * Part of the get-translation-target.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const { orderBy } = require("natural-orderby");
const harness = require("../harness");
const {
  extractJsonObject,
  installmentNumberFromDir,
  normalizeInstallmentNumber,
  sanitizeFolderName,
  filterVolumesByInstallment,
} = require("../utils/manifest");
const { fileExists, stageSourceFile } = require("../utils/fs");

const { MANIFEST_SCHEMA, isVolumeArtifact } = require("./config");

/**
 * Is this name documentation about the folder rather than a book inside it?
 *
 * The default source folder (`epub_source/`) carries a README so a fresh clone knows
 * what to drop there, and a series folder may carry one too. A README ends in `.md`,
 * which is otherwise the shape of a staged book, so the two scans that decide "is this
 * a source file?" have to say no to it explicitly — otherwise the file that explains
 * the folder becomes volume 01.
 *
 * @param {string} name - A file name.
 * @returns {boolean} true for README / readme.md / README.txt and nothing else.
 */
function isDocumentationFile(name) {
  return /^readme(\.(md|txt|markdown))?$/i.test(name);
}


/**
 * Is this directory entry a book the intake could stage?
 *
 * `Dirent.isFile()` answers NO for a shortcut, and a staged book is now usually
 * a shortcut — so a scan that asks the cheap directory question would walk past
 * every book the previous intake laid out, and a dry run would re-stage the whole
 * series into a rival set of folders beside the committed ones (the exact failure
 * gotcha 31 is about). Ask for a file OR a shortcut with a source-looking name.
 *
 * @param {import("fs").Dirent} entry
 * @returns {boolean}
 */
function isSourceEntry(entry) {
  return (
    (entry.isFile() || entry.isSymbolicLink()) &&
    /\.(epub|txt|md)$/i.test(entry.name) &&
    !isDocumentationFile(entry.name) &&
    !isVolumeArtifact(entry.name)
  );
}


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
    (name) =>
      /\.(epub|txt|md)$/i.test(name) &&
      !isDocumentationFile(name) &&
      !isVolumeArtifact(name)
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
 *      has: it creates folders and links each source into one — a copy only
 *      where this filesystem cannot link — and never modifies or deletes
 *      anything.)
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
      .filter((e) => isSourceEntry(e))
      .map((e) => e.name);
    for (const file of orderBy(loose)) {
      const number = String(volumes.length + 1).padStart(2, "0");
      const base = file.replace(/\.[^.]+$/, "");
      const folder = sanitizeFolderName(`${base}(${number})`);
      const target = path.join(seriesDir, folder, file);
      if (!(await fileExists(target))) {
        await fs.mkdir(path.join(seriesDir, folder), { recursive: true });
        const staged = await stageSourceFile({ src: path.join(seriesDir, file), target });
        harness.logLine(
          `[get-translation-target] staged ${file} into ${folder}/ (${
            staged.ok ? (staged.mode === "link" ? "linked" : "copied") : `staging refused: ${staged.reason}`
          }) — deterministic layout.`
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


module.exports = {
  isDocumentationFile,
  isSourceEntry,
  firstSourceInVolumeDir,
  buildDeterministicManifest,
  deriveSeriesName,
};

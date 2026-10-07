/**
 * The gates a plan must pass before anything downstream may read it.
 *
 * validateManifest checks the schema, sanitizes each folder name (validated, never
 * rewritten — a bad plan fails the correction path instead of quietly mangling a
 * source-language title), normalizes installment numbers, requires unique folders and
 * installments, and requires each volume's sourceFile to be the staged book INSIDE its
 * own folder. findDuplicateSources rejects the one mistake folder-name freedom makes
 * possible: the same book listed twice. confidenceGate refuses to start the pipeline
 * below DISCOVER_MIN_CONFIDENCE and is fail-closed on a plan that reports none.
 *
 * Part of the get-translation-target.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const {
  extractJsonObject,
  installmentNumberFromDir,
  normalizeInstallmentNumber,
  sanitizeFolderName,
  filterVolumesByInstallment,
} = require("../utils/manifest");
const { fileExists, stageSourceFile } = require("../utils/fs");
const { sha256OfFile, openEpub, isEpubPath, htmlToPlainText } = require("../utils/source");

const { MANIFEST_SCHEMA, discoverMinConfidence } = require("./config");
const { validateVolumeIntegrity } = require("./integrity");

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
 * Find a book listed twice. The agent chooses folder names and stages each book
 * into one of them, so the same book can end up as two volumes under two names —
 * which silently doubles every cumulative artifact built on it. Content hashes are
 * the only reliable detector, because the file names differ on purpose (and a
 * staged book is usually a shortcut to the same stored bytes, which is exactly
 * what makes two entries the same book).
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


module.exports = {
  validateManifest,
  validateDiscoveryBlock,
  manifestSourcesExist,
  confidenceGate,
  findDuplicateSources,
};

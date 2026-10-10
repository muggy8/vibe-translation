/**
 * utils/reference-store/source-chapters.js — a volume's source text, chapter by chapter,
 * read the cheap way.
 *
 * Evidence verification (the most important rule in this design, doc 04 §7.1) needs to
 * know what line 787 of chapter 3 actually says. This module is the only thing in the
 * store that reads source text, and it deliberately does **not** go through
 * `utils/source.js`'s `resolveSourceBundle`:
 *
 *   - `resolveSourceBundle` re-extracts the epub when its cache is stale. A check that
 *     rewrites the volume folder as a side effect of being asked what a line says is not
 *     a check — the same rule `configs/run-state.js` states about scanning for legacy
 *     records;
 *   - it needs the plan of record's volume object, and evidence verification is asked
 *     about a *chapter id*, not a plan entry;
 *   - the store must stay a leaf (gotcha 85): pulling the epub pipeline into
 *     `utils/reference-store/` would put `jszip` and the token estimator behind every
 *     integrity query.
 *
 * So it reads what the extraction already wrote: `<base>-bundle.meta.json` for the chapter
 * list, falling back to `chapters.json`, falling back to the whole-volume file. If none of
 * those exist, the honest answer is "this volume has no extracted source yet", and the
 * caller refuses the fact rather than guessing at a line.
 *
 * @module utils/reference-store/source-chapters
 */

const fs = require("fs");
const path = require("path");

require("../../types"); // JSDoc type definitions

/**
 * The chapters of one volume, as the extraction named them.
 *
 * @param {string} volumeDir - Absolute path to the volume folder.
 * @returns {{chapters: Array<{id: string, file: string, title: string|null, chars: number|null}>, source: string, error: string|null}}
 *   `source` says which file the list came from, so a refusal can name it.
 */
function listVolumeChapters(volumeDir) {
  const bundle = readBundleMeta(volumeDir);
  if (bundle) {
    const chapters = (bundle.segments || []).map((s) => ({
      id: String(s.id),
      file: String(s.file),
      title: s.title ? String(s.title) : null,
      chars: Number.isFinite(s.chars) ? s.chars : null,
    }));
    if (chapters.length > 0) {
      return { chapters, source: `${bundle.base}-bundle.meta.json`, error: null };
    }
  }

  const plan = readChaptersJson(volumeDir);
  if (plan && plan.length > 0) {
    return { chapters: plan, source: "chapters.json", error: null };
  }

  // No chapter list: the whole-volume file is one chapter, if it is there.
  const whole = findWholeFile(volumeDir);
  if (whole) {
    return {
      chapters: [{ id: "whole", file: whole, title: null, chars: null }],
      source: whole,
      error: null,
    };
  }

  return {
    chapters: [],
    source: null,
    error:
      `no extracted source found in ${volumeDir} (looked for *-bundle.meta.json, ` +
      "chapters.json, and *-whole.md). Extract the volume before importing facts into it.",
  };
}

/**
 * Read one chapter's lines.
 *
 * @param {string} volumeDir - Absolute volume folder.
 * @param {string} file - The chapter file name, as the chapter list named it.
 * @returns {string[]|null} The lines, or null when the file cannot be read.
 */
function readChapterLines(volumeDir, file) {
  try {
    return fs.readFileSync(path.join(volumeDir, file), "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * `<base>-bundle.meta.json`, if the volume folder has exactly one readable one.
 *
 * @param {string} volumeDir
 * @returns {Object|null}
 */
function readBundleMeta(volumeDir) {
  let names;
  try {
    names = fs.readdirSync(volumeDir);
  } catch {
    return null;
  }
  const metas = names.filter((n) => n.endsWith("-bundle.meta.json")).sort();
  for (const name of metas) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(volumeDir, name), "utf8"));
      if (meta && Array.isArray(meta.segments) && meta.segments.length > 0) return meta;
    } catch {
      /* a corrupt cache is not a chapter list; try the next one */
    }
  }
  return null;
}

/**
 * `chapters.json`, normalised to `{id, file}` entries.
 *
 * Two shapes have been written by this pipeline: a bare array of chapter entries, and an
 * object with a `chapters` array. Both are accepted; a file that is neither is reported as
 * absent rather than guessed at.
 *
 * @param {string} volumeDir
 * @returns {Array<{id: string, file: string, title: string|null, chars: number|null}>|null}
 */
function readChaptersJson(volumeDir) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(volumeDir, "chapters.json"), "utf8"));
  } catch {
    return null;
  }
  const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.chapters) ? parsed.chapters : null;
  if (!raw) return null;
  const chapters = raw
    .filter((c) => c && (c.id !== undefined && c.id !== null))
    .map((c) => ({
      id: String(c.id),
      file: c.file ? String(c.file) : null,
      title: c.title ? String(c.title) : null,
      chars: Number.isFinite(c.chars) ? c.chars : null,
    }));
  // A chapters.json entry names an id; the file is derived from the volume's own base when
  // the entry does not carry one, which is what the translation stage writes.
  const base = deriveBase(volumeDir);
  return chapters.map((c) => ({
    ...c,
    file: c.file || (base ? `${base}-${c.id}.md` : null),
  }));
}

/**
 * The `*-whole.md` file in the volume folder, if there is one.
 * @param {string} volumeDir
 * @returns {string|null} The file name.
 */
function findWholeFile(volumeDir) {
  let names;
  try {
    names = fs.readdirSync(volumeDir);
  } catch {
    return null;
  }
  const whole = names.filter((n) => n.endsWith("-whole.md")).sort();
  return whole.length > 0 ? whole[0] : null;
}

/**
 * The source base name this volume's files are built from (`<base>-ch1.md`, `<base>-whole.md`).
 * @param {string} volumeDir
 * @returns {string|null}
 */
function deriveBase(volumeDir) {
  const whole = findWholeFile(volumeDir);
  if (whole) return whole.replace(/-whole\.md$/, "");
  const meta = readBundleMeta(volumeDir);
  if (meta && meta.base) return String(meta.base);
  return null;
}

module.exports = {
  listVolumeChapters,
  readChapterLines,
  readBundleMeta,
  readChaptersJson,
  findWholeFile,
  deriveBase,
};

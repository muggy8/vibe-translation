/**
 * utils/source/audit/rules.js — the vocabulary the extraction audit speaks in.
 *
 * The kinds, the step name, and the four small questions every check asks: is this file an archive,
 * is this segment empty, does this segment declare itself packaging, is this title a file name. Each
 * one is deliberately a READ of what the extraction already recorded rather than a second rule about
 * the same fact — `segmentHasNoBody` asks the bundle's own `empty` flag, `segmentDeclaresPackaging`
 * asks the same `PACKAGING_TITLE_RE` the grouping pass used, and a second floor or a second packaging
 * word list is how one module calls a chapter empty while another calls it short (gotcha 40) or a
 * page packaging while another translates it (gotcha 52).
 *
 * Part of the source.js layer's audit half.
 */

const path = require("path");

require("../../../types"); // JSDoc type definitions

const { EMPTY_SEGMENT_CHARS } = require("../config");
const { PACKAGING_TITLE_RE } = require("../chapters");
const { isEpubPath } = require("../epub");

/** @typedef {import("../../postmortem").PostMortemFinding} PostMortemFinding */

/**
 * The step these findings belong to in the run's records.
 *
 * @type {string}
 */
const EXTRACTION_STEP = "extract";

/**
 * The stable `kind` strings this audit emits, and the level each one is declared at.
 *
 * Named in one place because a diagnosis agent selects on them, and a kind that only exists inside a
 * message string is a kind nobody can query. The levels are data, not a judgement: the plan of record
 * (`utils/source/plan/01-extraction-step.md` §3) decided them, and `utils/postmortem/plan/01-finding-levels.md`
 * maps them onto what the delivery layer does about each.
 *
 * @type {Object<string, "HIGH"|"MEDIUM">}
 */
const EXTRACTION_AUDIT_KINDS = {
  "source-not-archive": "HIGH",
  "no-usable-chapter": "HIGH",
  "chapter-extracted-empty": "HIGH",
  "title-is-filename": "MEDIUM",
  "ruby-harvest-missing": "MEDIUM",
};

/**
 * File extensions that make a string a FILE NAME rather than a title. A chapter heading that ends in
 * one of these is a path the pipeline printed, never a name the book prints.
 *
 * @type {RegExp}
 */
const FILE_NAME_EXT_RE = /\.(x?html?|md|markdown|txt|epub|json|xml)$/i;

/**
 * Whether a path names a book archive.
 *
 * @param {string} absPath - A file path.
 * @returns {boolean}
 */
function isArchivePath(absPath) {
  return isEpubPath(absPath);
}

/**
 * Normalise a title or a file name so the two can be compared.
 *
 * Markdown heading markers, a document extension and surrounding whitespace are all decoration: the
 * question is whether the STRINGS name the same thing, not whether they are spelled the same way.
 *
 * @param {string} value - A chapter title or a file name.
 * @returns {string} The comparison key ("" for nothing usable).
 */
function nameKey(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  return s.replace(/^#{1,6}\s+/, "").replace(FILE_NAME_EXT_RE, "").trim().toLowerCase();
}

/**
 * Turn a folder listing into plain file names.
 *
 * A caller naturally has `fs.readdir(dir, { withFileTypes: true })` (it needs the directory entries to
 * find the book in the first place), and a caller building a fixture naturally has strings. Accepting
 * both keeps the audit pure — it never reads a folder itself — without making every caller map first.
 *
 * @param {Array<string|{name: string}>|null|undefined} listing - The volume folder's entries.
 * @returns {string[]} File names, in the order given.
 */
function fileNamesOf(listing) {
  if (!Array.isArray(listing)) return [];
  return listing
    .map((entry) => (typeof entry === "string" ? entry : entry && typeof entry.name === "string" ? entry.name : ""))
    .filter(Boolean);
}

/**
 * The book archive names inside a volume folder's listing.
 *
 * @param {string[]} names - File names.
 * @returns {string[]} The ones that are archives.
 */
function archiveNamesOf(names) {
  return names.filter((name) => /\.epub$/i.test(name));
}

/**
 * Whether a segment holds no text.
 *
 * The extraction already answers this and writes the answer into the bundle: `empty` is its
 * "this section converted to nothing" flag and `bodyChars` is the measurement behind it. The audit
 * reads that answer instead of inventing its own floor.
 *
 * `bodyChars` is consulted only when the flag is absent, which is the shape of a cache written before
 * bundle schema 4. When NEITHER is present (a plain-text part file, which the extraction never
 * measures) the answer is "not empty": the audit does not guess at a chapter's contents from the size
 * of a slice somebody else cut.
 *
 * @param {SourceSegment|null} segment - One bundle segment.
 * @returns {boolean} True when the extraction recorded this segment as holding no text.
 */
function segmentHasNoBody(segment) {
  if (!segment) return false;
  if (typeof segment.empty === "boolean") return segment.empty;
  if (Number.isFinite(segment.bodyChars)) return segment.bodyChars < EMPTY_SEGMENT_CHARS;
  return false;
}

/**
 * Whether the book itself declares this segment to be its packaging — a cover, the contents page,
 * the legal notice, the colophon.
 *
 * This is the exemption that keeps the empty-chapter check honest. Under the normal path a packaging
 * page never becomes a segment at all (it is recorded in `bundle.packaging` instead), so the check
 * never sees one. Under the two fallbacks in `extract.js` — the book's contents list names none of its
 * pages, or names only packaging — every page stands alone as a chapter, cover plates and all, and a
 * cover plate that converted to nothing is not a missing chapter. The evidence available per segment is
 * the title the book's own navigation gave it, so that is what is asked, using the same
 * `PACKAGING_TITLE_RE` the extraction used to decide in the first place rather than a second list of
 * packaging words that would drift from it. The exemption is narrow, not complete: a fallback-path page
 * whose title is not a packaging word is indistinguishable from a chapter that converted to nothing, and
 * closing that needs a per-segment packaging mark in the bundle meta. → AGENTS.md gotcha 126.
 *
 * @param {SourceSegment|null} segment - One bundle segment.
 * @param {Set<string>} packagingTitles - Normalised titles of the groups the bundle recorded as packaging.
 * @returns {boolean} True when this segment is the book's packaging rather than a chapter of its story.
 */
function segmentDeclaresPackaging(segment, packagingTitles) {
  const title = String((segment && segment.title) || "").trim();
  if (!title) return false;
  if (PACKAGING_TITLE_RE.test(title)) return true;
  return packagingTitles.has(nameKey(title));
}

/**
 * Where a finding points inside the series folder.
 *
 * The post-mortem's `file` field is a path relative to the series folder, or the volume folder name for
 * a volume-level finding. The audit does not know the series folder, and the plan of record's
 * `sourceFile` is already relative to it — so `<folder>/<file>` is the shape that needs no guessing.
 *
 * @param {TranslationTargetVolume} volume - The plan of record's volume entry.
 * @param {string} [fileName] - A file inside the volume folder, or nothing for a volume-level finding.
 * @returns {string} The path to report.
 */
function findingFile(volume, fileName) {
  if (!fileName) return volume.folder;
  return `${volume.folder}/${fileName}`;
}

/**
 * The names a chapter title would have to equal for it to be "only the file's name".
 *
 * @param {SourceBundle} bundle - The resolved bundle.
 * @param {TranslationTargetVolume} volume - The plan of record's volume entry.
 * @returns {Set<string>} Normalised source names: the bundle's base, the archive it opened, the planned source file.
 */
function sourceNameKeys(bundle, volume) {
  return new Set(
    [bundle.base, path.basename(bundle.originalPath || ""), path.basename((volume && volume.sourceFile) || "")]
      .map(nameKey)
      .filter(Boolean)
  );
}

module.exports = {
  EXTRACTION_STEP,
  EXTRACTION_AUDIT_KINDS,
  FILE_NAME_EXT_RE,
  isArchivePath,
  nameKey,
  fileNamesOf,
  archiveNamesOf,
  segmentHasNoBody,
  segmentDeclaresPackaging,
  findingFile,
  sourceNameKeys,
};

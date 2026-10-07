/**
 * Reading the archive: the catalog card (title, creator, language, publisher,
 * identifier, and the Calibre or EPUB3 series marker — the intake agent's strongest
 * evidence), the manifest, the spine, the readable sections and their nav titles.
 *
 * The OPF is parsed as XML, never as HTML, and case-insensitively: EPUB3 series
 * markers are text-valued, Calibre's are attribute-valued, and the collection's
 * id/group-type pairing uses refines="#id". HTML parsing mangles self-closing tags
 * and drops the text-valued properties, so the series marker silently disappears;
 * dropping XML mode breaks EPUB3, keeping it without lowercasing breaks a real file
 * that spells its tags <Package>/<Manifest>/<Spine> (gotchas 29 and 34).
 *
 * The archive's text payload and its non-text payload are read off the zip central
 * directory in BYTES, without decompressing a single image.
 *
 * The code lives in utils/source/epub/: basics.js (paths, hashes, and the byte size
 * an archive reports without unpacking), opf.js (the five readers of the package
 * document), open.js (open one book), nav.js (its own table of contents),
 * section.js (sample a page, count its scripts). This file is the public surface of
 * the source.js layer's epub half.
 *
 * Part of the source.js layer (split out of the original single file).
 */

const basics = require("./epub/basics");
const open = require("./epub/open");
const nav = require("./epub/nav");
const section = require("./epub/section");

// The public surface, unchanged from the single file.
module.exports = {
  isEpubPath: basics.isEpubPath,
  normalizeZipPath: basics.normalizeZipPath,
  sha256OfFile: basics.sha256OfFile,
  readJsonOrNull: basics.readJsonOrNull,
  zipEntryUncompressedSize: basics.zipEntryUncompressedSize,
  openEpub: open.openEpub,
  readEpubSection: section.readEpubSection,
  scriptCounts: section.scriptCounts,
  loadNavStructure: nav.loadNavStructure,
  stripHrefFragment: nav.stripHrefFragment,
};

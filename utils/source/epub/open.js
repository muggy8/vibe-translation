/**
 * utils/source/epub/open.js — open one book and report what a reader needs before deciding anything.
 *
 * This is the single place that knows what a valid epub is. It backs both extractEpubToBundle()
 * (the pipeline's extractor) and the intake agent's epub tools (createEpubTools in harness.js),
 * which let an agent open a book without unzipping it by hand.
 */

require("../../../types"); // JSDoc type definitions

const fs = require("fs").promises;
const path = require("path");
const JSZip = require("jszip");

const { loadNavStructure } = require("./nav");
const {
  locateOpf,
  loadOpf,
  readCatalogCard,
  readManifestAndSpine,
  readTextSections,
  readPayloadAccounting,
} = require("./opf");

/**
 * Open an epub container once and read what a reader needs to know about it
 * before deciding anything: the catalog card (title, author, language tag,
 * publisher, identifier, and the "series X, book #N" marker reading apps
 * embed) plus the spine (the book's own declared reading order).
 *
 * @param {string} epubPath - Absolute path to the .epub file.
 * @returns {Promise<OpenedEpub>} The open container: zip handle, OPF location,
 *   metadata, manifest items, spine, text sections, section titles, counts.
 * @throws {Error} When the file is not a valid epub, has no OPF rootfile, or
 *   its spine contains no items.
 */
async function openEpub(epubPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(epubPath));

  const { opfPath, opfXml } = await locateOpf(zip, epubPath);
  const $opf = loadOpf(opfXml);

  const metadata = readCatalogCard($opf);
  const { manifestItems, spine } = readManifestAndSpine($opf, epubPath);
  const opfDir = path.posix.dirname(opfPath);

  const textItems = readTextSections(zip, spine, opfDir);
  const payload = readPayloadAccounting(zip);
  const nav = await loadNavStructure(zip, opfDir, manifestItems);

  return {
    epubPath,
    zip,
    opfPath,
    opfDir,
    metadata,
    manifestItems,
    spine,
    textItems,
    titles: nav.titles,
    navEntries: nav.entries,
    payload,
    imageCount: manifestItems.filter((it) => (it.mediaType || "").startsWith("image/")).length,
    entryCount: Object.keys(zip.files).length,
  };
}

module.exports = { openEpub };

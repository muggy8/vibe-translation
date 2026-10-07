/**
 * utils/source/epub/opf.js — what the package document says, and what the archive holds.
 *
 * The OPF is parsed as XML, never as HTML, and case-insensitively: EPUB3 series markers are
 * text-valued, Calibre's are attribute-valued, and the collection's id/group-type pairing uses
 * refines="#id". HTML parsing mangles self-closing tags and drops the text-valued properties, so
 * the series marker silently disappears; dropping XML mode breaks EPUB3, keeping it without
 * lowercasing breaks a real file that spells its tags <Package>/<Manifest>/<Spine>
 * (gotchas 29 and 34).
 *
 * The five readers here are the whole of what openEpub() knows: where the package document is,
 * the catalog card, the manifest and spine, the readable sections, and the payload split read
 * off the central directory in BYTES without decompressing a single image.
 */

const path = require("path");
const cheerio = require("cheerio");

require("../../../types"); // JSDoc type definitions

const { normalizeSpaces } = require("../html");
const { normalizeZipPath, zipEntryUncompressedSize } = require("./basics");

/**
 * Find the OPF (the package document) by following META-INF/container.xml.
 *
 * @param {Object} zip - The loaded archive.
 * @param {string} epubPath - The archive's own path, for the error messages.
 * @returns {Promise<{opfPath: string, opfXml: string}>} The OPF's zip path and its text.
 * @throws {Error} When the archive is not an epub, or the container does not name a rootfile.
 */
async function locateOpf(zip, epubPath) {
  const containerEntry = zip.file("META-INF/container.xml");
  if (!containerEntry) {
    throw new Error(`Not a valid epub (missing META-INF/container.xml): ${epubPath}`);
  }
  const containerXml = await containerEntry.async("string");
  const opfRel = (containerXml.match(/<rootfile[^>]*full-path="([^"]+)"/i) || [])[1];
  if (!opfRel) {
    throw new Error(`Could not find the OPF rootfile in META-INF/container.xml of ${epubPath}`);
  }
  const opfPath = normalizeZipPath(opfRel);
  const opfEntry = zip.file(opfPath);
  if (!opfEntry) {
    throw new Error(`OPF file "${opfPath}" not found inside ${epubPath}`);
  }
  return { opfPath, opfXml: await opfEntry.async("string") };
}

/**
 * Load the OPF as XML.
 *
 * lowerCaseTags + lowerCaseAttributeNames are NOT optional: xml mode keeps tag names
 * exactly as written, and the HTML mode this reader used before was case-insensitive.
 * Real files do use <Package>/<Manifest>/<Spine> (observed: such a book failed with
 * "the spine contains no readable items" once the parser went strict).
 *
 * @param {string} opfXml - The package document's text.
 * @returns {import("cheerio").CheerioAPI} The parsed document.
 */
function loadOpf(opfXml) {
  return cheerio.load(opfXml, {
    xml: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
  });
}

/**
 * The catalog card: the book's own description.
 *
 * Dublin Core elements carry it; `<meta>` entries carry the app-specific extras (Calibre writes
 * calibre:series / calibre:series_index; EPUB3 writes a belongs-to-collection entry whose
 * group-type refine says "series"). Both shapes are read so the agent sees the series marker
 * whichever tool produced the file.
 *
 * @param {import("cheerio").CheerioAPI} $opf - The parsed package document.
 * @returns {EpubMetadata} Title(s), creator(s), language(s), publisher, identifier, date, the
 *   series marker and index, and every collection the book claims to belong to.
 */
function readCatalogCard($opf) {
  const dc = {};
  const metaEntries = [];
  $opf("metadata")
    .children()
    .each((i, el) => {
      if (!el || el.type !== "tag") return;
      const name = (el.name || "").toLowerCase();
      const attribs = el.attribs || {};
      if (name === "meta") {
        // EPUB3 writes the value as the element's text
        // (<meta property="belongs-to-collection">Name</meta>); Calibre-style
        // writers use a content attribute (<meta name="…" content="…"/>). Read
        // either so both shapes are understood.
        metaEntries.push({
          id: attribs.id || "",
          // "refines" points back at an id with a leading "#" (#coll1 -> coll1);
          // normalize it so the two sides can be matched.
          refines: (attribs.refines || "").replace(/^#/, ""),
          property: (attribs.property || attribs.name || "").toLowerCase(),
          scheme: attribs.scheme || "",
          content: attribs.content || normalizeSpaces($opf(el).text()),
        });
        return;
      }
      const text = normalizeSpaces($opf(el).text());
      if (!text) return;
      (dc[name] = dc[name] || []).push(text);
    });
  const metaValue = (property) =>
    (metaEntries.find((m) => m.property === property) || {}).content || "";
  const collections = [];
  for (const m of metaEntries) {
    if (m.property !== "belongs-to-collection" || !m.content) continue;
    const kinds = metaEntries
      .filter((r) => r.refines && m.id && r.refines === m.id)
      .filter((r) => r.property === "group-type" || r.property === "collection-type")
      .map((r) => r.content.toLowerCase())
      .filter(Boolean);
    collections.push({ name: m.content, kinds });
  }
  const seriesCollection = collections.find((c) => c.kinds.includes("series")) || null;
  const first = (list) => (list && list.length > 0 ? list[0] : "");
  return {
    title: first(dc["dc:title"]),
    titles: dc["dc:title"] || [],
    creator: first(dc["dc:creator"]),
    creators: dc["dc:creator"] || [],
    language: first(dc["dc:language"]),
    languages: dc["dc:language"] || [],
    publisher: first(dc["dc:publisher"]),
    identifier: first(dc["dc:identifier"]),
    date: first(dc["dc:date"]),
    series: metaValue("calibre:series") || (seriesCollection ? seriesCollection.name : ""),
    seriesIndex: metaValue("calibre:series_index"),
    collections,
  };
}

/**
 * The manifest and the spine — the book's own declared reading order.
 *
 * @param {import("cheerio").CheerioAPI} $opf - The parsed package document.
 * @param {string} epubPath - For the error message.
 * @returns {{manifestItems: Array<{id: string, href: string, mediaType: string, properties: string}>, spine: Array<{id: string, href: string, mediaType: string, properties: string}>}}
 * @throws {Error} When the spine resolves to no items at all.
 */
function readManifestAndSpine($opf, epubPath) {
  const manifestItems = [];
  const manifestById = new Map();
  $opf("manifest item").each((i, el) => {
    const id = $opf(el).attr("id");
    if (!id) return;
    const item = {
      id,
      href: $opf(el).attr("href") || "",
      mediaType: ($opf(el).attr("media-type") || "").toLowerCase(),
      properties: $opf(el).attr("properties") || "",
    };
    manifestById.set(id, item);
    manifestItems.push(item);
  });
  const spine = [];
  $opf("spine itemref").each((i, el) => {
    const idref = $opf(el).attr("idref");
    if (idref && manifestById.has(idref)) spine.push(manifestById.get(idref));
  });
  if (spine.length === 0) {
    throw new Error(`The spine of ${epubPath} contains no readable items.`);
  }
  return { manifestItems, spine };
}

/**
 * The readable sections, in spine order, each with its resolved zip path.
 *
 * @param {Object} zip - The loaded archive.
 * @param {Array<{href: string, mediaType: string}>} spine
 * @param {string} opfDir - The OPF file's zip directory (hrefs are relative to it).
 * @returns {Array<{index: number, zipPath: string, href: string, mediaType: string}>} 1-based index.
 */
function readTextSections(zip, spine, opfDir) {
  const textItems = [];
  for (const item of spine) {
    const zipPath = normalizeZipPath(path.posix.join(opfDir, item.href));
    const isText =
      (item.mediaType || "").includes("html") || /\.(x?html?)$/i.test(item.href || "");
    if (!zip.file(zipPath) || !isText) continue;
    textItems.push({
      index: textItems.length + 1,
      zipPath,
      href: item.href,
      mediaType: item.mediaType,
    });
  }
  return textItems;
}

/**
 * Payload accounting, read straight off the zip central directory: JSZip
 * records every entry's uncompressed size when it parses the archive, so the
 * text-vs-images split costs nothing (no image is ever decompressed). The
 * intake's "is this an art book?" check needs these two numbers IN BYTES —
 * comparing an archive's byte size against a character count is a category
 * error that calls every illustrated book an art book (observed live: 17 real
 * novels, 9–20 MB each with 19–31 plates, all rejected).
 *
 * @param {Object} zip - The loaded archive.
 * @returns {{textBytes: number, otherBytes: number}}
 */
function readPayloadAccounting(zip) {
  const payload = { textBytes: 0, otherBytes: 0 };
  for (const entry of Object.values(zip.files)) {
    if (!entry || entry.dir) continue;
    const size = zipEntryUncompressedSize(entry);
    if (/\.(x?html?)$/i.test(entry.name || "")) payload.textBytes += size;
    else payload.otherBytes += size;
  }
  return payload;
}

module.exports = {
  locateOpf,
  loadOpf,
  readCatalogCard,
  readManifestAndSpine,
  readTextSections,
  readPayloadAccounting,
};

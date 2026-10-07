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
 * Part of the source.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const JSZip = require("jszip");
const cheerio = require("cheerio");
require("../../types"); // JSDoc type definitions

const { htmlToPlainText, normalizeSpaces } = require("./html");

/**
 * True when the path looks like an epub file (by extension). The container
 * is validated for real (META-INF/container.xml) during extraction.
 *
 * @param {string} absPath - A file path.
 * @returns {boolean}
 */
function isEpubPath(absPath) {
  return /\.epub$/i.test(absPath);
}


/**
 * Decode a percent-encoded OPF href, then normalize it to a zip entry path
 * (no leading slash, `../` resolved).
 *
 * @param {string} p - A zip-relative path, possibly percent-encoded.
 * @returns {string}
 */
function normalizeZipPath(p) {
  let s = p || "";
  try {
    s = decodeURIComponent(s);
  } catch {
    // leave as-is when the encoding is invalid
  }
  s = s.replace(/^\/+/, "");
  s = path.posix.normalize(s);
  return s.replace(/^\/+/, "");
}


/**
 * Read the sha256 of a file.
 *
 * @param {string} filePath - Absolute file path.
 * @returns {Promise<string>} Hex digest.
 */
async function sha256OfFile(filePath) {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}


/**
 * Read a JSON file, returning null when missing or unparseable.
 *
 * @param {string} filePath
 * @returns {Promise<Object|null>}
 */
async function readJsonOrNull(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}


/**
 * The uncompressed size of one zip entry, as recorded in the archive's central
 * directory. JSZip parses the central directory when the archive is loaded, so
 * this is available for every entry WITHOUT decompressing it — which is the
 * whole point: weighing a book's images against its prose must not read the
 * images.
 *
 * @param {Object} entry - A JSZip zip object.
 * @returns {number} Its uncompressed byte size, or 0 when the archive does not say.
 */
function zipEntryUncompressedSize(entry) {
  const size = entry && entry._data ? entry._data.uncompressedSize : 0;
  return Number.isFinite(size) && size > 0 ? size : 0;
}


/**
 * Open an epub container once and read what a reader needs to know about it
 * before deciding anything: the catalog card (title, author, language tag,
 * publisher, identifier, and the "series X, book #N" marker reading apps
 * embed) plus the spine (the book's own declared reading order).
 *
 * This is the single place that knows what a valid epub is: it backs both
 * extractEpubToBundle() (the pipeline's extractor) and the intake agent's
 * epub tools (createEpubTools in harness.js), which let an agent open a book
 * without unzipping it by hand.
 *
 * @param {string} epubPath - Absolute path to the .epub file.
 * @returns {Promise<OpenedEpub>} The open container: zip handle, OPF location,
 *   metadata, manifest items, spine, text sections, section titles, counts.
 * @throws {Error} When the file is not a valid epub, has no OPF rootfile, or
 *   its spine contains no items.
 */
async function openEpub(epubPath) {
  const buffer = await fs.readFile(epubPath);
  const zip = await JSZip.loadAsync(buffer);
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
  const opfXml = await opfEntry.async("string");
  // Parse the OPF as XML, not HTML: in HTML mode <meta> is a void element, so
  // EPUB3's text-valued <meta property="belongs-to-collection">Name</meta>
  // would lose its value (observed: the series marker came back empty).
  // Parse the OPF as XML, not HTML: in HTML mode <meta> is a void element, so
  // EPUB3's text-valued <meta property="belongs-to-collection">Name</meta>
  // would lose its value (observed: the series marker came back empty).
  // lowerCaseTags + lowerCaseAttributeNames are NOT optional: xml mode keeps tag
  // names exactly as written, and the HTML mode this reader used before was
  // case-insensitive. Real files do use <Package>/<Manifest>/<Spine> (observed:
  // such a book failed with "the spine contains no readable items" once the
  // parser went strict).
  const $opf = cheerio.load(opfXml, {
    xml: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
  });

  // ── The catalog card ──────────────────────────────────────────────────────
  // Dublin Core elements carry the book's own description; <meta> entries
  // carry the app-specific extras (Calibre writes calibre:series /
  // calibre:series_index; EPUB3 writes a belongs-to-collection entry whose
  // group-type refine says "series"). Both shapes are read so the agent sees
  // the series marker whichever tool produced the file.
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
  const metadata = {
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

  // ── The manifest + spine (the book's own reading order) ───────────────────
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
  const opfDir = path.posix.dirname(opfPath);

  // The readable sections, in spine order, each with its resolved zip path.
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

  // Payload accounting, read straight off the zip central directory: JSZip
  // records every entry's uncompressed size when it parses the archive, so the
  // text-vs-images split costs nothing (no image is ever decompressed). The
  // intake's "is this an art book?" check needs these two numbers IN BYTES —
  // comparing an archive's byte size against a character count is a category
  // error that calls every illustrated book an art book (observed live: 17 real
  // novels, 9–20 MB each with 19–31 plates, all rejected).
  const payload = { textBytes: 0, otherBytes: 0 };
  for (const entry of Object.values(zip.files)) {
    if (!entry || entry.dir) continue;
    const size = zipEntryUncompressedSize(entry);
    if (/\.(x?html?)$/i.test(entry.name || "")) payload.textBytes += size;
    else payload.otherBytes += size;
  }

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

/**
 * Read one readable section of an opened epub as plain text (no Markdown
 * markup — this is for sampling a book's opening, not for producing the
 * pipeline's normalized source files).
 *
 * @param {OpenedEpub} opened - The opened container from openEpub().
 * @param {number} index - 1-based section index in spine order.
 * @param {{offset?: number, limit?: number}} [opts] - Character window into
 *   the section (default: from the start, 4000 chars).
 * @returns {Promise<{index: number, title: string, zipPath: string, totalChars: number, from: number, text: string}>}
 * @throws {Error} When the section index does not exist.
 */
async function readEpubSection(opened, index, { offset = 0, limit = 4000 } = {}) {
  const item = opened.textItems[(index || 1) - 1];
  if (!item) {
    throw new Error(
      `Section ${index} does not exist in ${opened.epubPath} ` +
        `(${opened.textItems.length} readable section(s)).`
    );
  }
  const html = await opened.zip.file(item.zipPath).async("string");
  const text = htmlToPlainText(html);
  const from = Math.max(0, Math.floor(offset || 0));
  const take = Math.max(0, Math.floor(limit || 4000));
  return {
    index: item.index,
    title: opened.titles.get(item.zipPath) || item.href,
    zipPath: item.zipPath,
    totalChars: text.length,
    from,
    text: text.slice(from, from + take),
  };
}


/**
 * Count the writing systems present in a text sample. Returned to the intake
 * agent as raw evidence next to the sample it read — the agent still decides
 * what language a book is in; this only saves it from having to eyeball a
 * script it may not be confident about (kana means Japanese, hangul means
 * Korean, Han characters alone mean Chinese).
 *
 * @param {string} text - The text sample.
 * @returns {{kana: number, hangul: number, han: number, latin: number, cyrillic: number, total: number}}
 */
function scriptCounts(text) {
  const s = String(text || "");
  const count = (re) => (s.match(re) || []).length;
  return {
    kana: count(/[\u3040-\u30ff]/g),
    hangul: count(/[\uac00-\ud7af\u1100-\u11ff]/g),
    han: count(/[\u4e00-\u9fff]/g),
    latin: count(/[A-Za-z]/g),
    cyrillic: count(/[\u0400-\u04ff]/g),
    total: s.length,
  };
}




/**
 * Read the book's own table of contents (EPUB3 nav, then EPUB2 NCX).
 *
 * Two views of the same document come back, because two different jobs need it:
 *   `titles`  — zip path → the title the book gives that page. A lookup table,
 *               used when one section is being sampled on its own.
 *   `entries` — the same pairs IN DOCUMENT ORDER, tagged with whether the link
 *               came from the contents list or the landmarks list and with any
 *               `epub:type` the book declared. That ordered list is the book's
 *               own statement of where its sections begin, which is what
 *               groupSpineIntoChapters() needs to tell a chapter apart from an
 *               inserted illustration page.
 *
 * @param {JSZip} zip
 * @param {string} opfDir - The OPF file's zip directory.
 * @param {Array<{href: string, mediaType: string, properties: string}>} manifestItems
 * @returns {Promise<{titles: Map<string, string>, entries: Array<{zipPath: string, title: string, order: number, inToc: boolean, types: string[]}>}>}
 */
async function loadNavStructure(zip, opfDir, manifestItems) {
  const titles = new Map();
  const entries = [];
  const byPath = new Map();

  /**
   * Record one navigation link. The same file is usually named twice (the
   * contents list and the landmarks list), so links are merged per path: the
   * first title wins, and the `epub:type` values and the "named in the contents
   * list" flag accumulate across every link that names it.
   */
  const record = (zipPath, title, { inToc, type }) => {
    if (!zipPath || !title) return;
    let entry = byPath.get(zipPath);
    if (!entry) {
      entry = { zipPath, title, order: entries.length, inToc: Boolean(inToc), types: [] };
      byPath.set(zipPath, entry);
      entries.push(entry);
    } else if (inToc) {
      entry.inToc = true;
    }
    const t = String(type || "").toLowerCase();
    if (t && !entry.types.includes(t)) entry.types.push(t);
    if (!titles.has(zipPath)) titles.set(zipPath, title);
  };

  // EPUB3 nav document.
  const navItem = manifestItems.find((it) => (it.properties || "").includes("nav"));
  if (navItem) {
    const p = normalizeZipPath(path.posix.join(opfDir, navItem.href));
    const entry = zip.file(p);
    if (entry) {
      try {
        const $ = cheerio.load(await entry.async("string"));
        const scope = $("nav").length ? $("nav") : $.root();
        scope.find("a[href]").each((i, a) => {
          const href = $(a).attr("href");
          const t = normalizeSpaces($(a).text());
          if (!href || !t) return;
          const key = normalizeZipPath(
            path.posix.join(path.posix.dirname(p), stripHrefFragment(href))
          );
          // A link inside <nav epub:type="landmarks"> is a pointer to a structural
          // role ("this is where the main text starts"), not a chapter in the
          // contents list. A nav document with no typed <nav> sections is treated
          // as one contents list.
          const navType = String($(a).parents("nav").first().attr("epub:type") || "").toLowerCase();
          record(key, t, {
            inToc: !navType || navType === "toc",
            type: $(a).attr("epub:type"),
          });
        });
      } catch {
        // unreadable nav — fall through to NCX / headings
      }
    }
  }
  // EPUB2 NCX. Every navPoint is a contents entry.
  const ncxItem = manifestItems.find(
    (it) => (it.mediaType || "").includes("dtbncx") || /\.ncx$/i.test(it.href || "")
  );
  if (ncxItem) {
    const p = normalizeZipPath(path.posix.join(opfDir, ncxItem.href));
    const entry = zip.file(p);
    if (entry) {
      try {
        const $ = cheerio.load(await entry.async("string"));
        $("navPoint").each((i, el) => {
          const src = $(el).find("content").attr("src");
          const t = normalizeSpaces($(el).find("text").text());
          if (!src || !t) return;
          const key = normalizeZipPath(path.posix.join(opfDir, stripHrefFragment(src)));
          record(key, t, { inToc: true, type: "" });
        });
      } catch {
        // unreadable NCX — fall back to in-chapter headings
      }
    }
  }
  return { titles, entries };
}


/**
 * Drop the fragment/query from an internal epub href.
 *
 * A real table of contents points at an ANCHOR inside a page
 * (`xhtml/p-003.xhtml#toc-002`), while the page's own zip path has no fragment
 * (`item/xhtml/p-003.xhtml`). Keying one side with the fragment still attached
 * means the two sides never match (observed live: every chapter of a 17-volume
 * series lost its real title, because the extractor's nav lookup missed all 10
 * fragment-carrying entries of volume 1 and fell back to each page's `<title>`,
 * which in the Kadokawa/BOOK☆WALKER template is the SERIES TITLE on every page
 * — so a 10-chapter book came back as 35 sections all named after the series).
 *
 * @param {string} href - An internal href, possibly with `#anchor` or `?query`.
 * @returns {string} The href with any fragment/query suffix removed.
 */
function stripHrefFragment(href) {
  return (href || "").replace(/[#?].*$/, "");
}


module.exports = {
  isEpubPath,
  normalizeZipPath,
  sha256OfFile,
  readJsonOrNull,
  zipEntryUncompressedSize,
  openEpub,
  readEpubSection,
  scriptCounts,
  loadNavStructure,
  stripHrefFragment,
};

/**
 * utils/source.js — Source-bundle normalization for the task pipelines.
 *
 * The pipelines consume each volume's source as plain-text file(s) that live
 * in the volume folder: the one-shot stages inline the file content into the
 * message, and the agent stages read it with the sandboxed readFile tool.
 * `.md` / `.txt` sources are used as-is (the default path processes the whole
 * installment in one go). `.epub` volumes are normalized ONCE (and cached)
 * into a set of Markdown files in the volume folder:
 *
 *   <base>-whole.md          the entire volume, in spine (reading) order
 *   <base>-ch0.md            prologue (when detected)
 *   <base>-ch1.md … -chN.md  regular chapters
 *   <base>-chN.1.md …        interludes and epilogues: "chN.K" = segment K
 *                             after chapter N (the counter K restarts at 1 for
 *                             each chapter; a segment before any chapter is
 *                             anchored to ch0). Epilogues are named like
 *                             interludes — no special id.
 *   images/                  every embedded image + manifest.json
 *   <base>-bundle.meta.json  cache key (mtime/size/sha256) + segment order
 *
 * The chapter split exists for the FALLBACK path: when a volume's whole text
 * is too large for a single AI pass (see shouldProcessChunked /
 * SOURCE_CHUNK_THRESHOLD_CHARS), the pipelines process the volume chapter by
 * chapter instead of installment by installment. The DEFAULT path — and the
 * only path for `.md` sources and small epubs — is the whole installment.
 *
 * IMPORTANT: the interlude chapter files (chN.K) do NOT sort into reading
 * order by file name (chN.md vs chN.K.md, …) — always iterate
 * `bundle.segments` (the meta order), never a directory listing.
 */

const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const JSZip = require("jszip");
const cheerio = require("cheerio");
const { fileExists } = require("./fs");
require("../types"); // JSDoc type definitions

// ─── Chunking decision ──────────────────────────────────────────────────────

/**
 * Default whole-installment size (chars) above which the chapter-by-chapter
 * fallback kicks in. Sized for a ~262K-token context with headroom for the
 * prompts and the cumulative reference; set SOURCE_CHUNK_THRESHOLD_CHARS=0
 * to always fall back for multi-chapter epubs.
 *
 * @type {number}
 */
const DEFAULT_CHUNK_THRESHOLD_CHARS = 120000;

/**
 * Bundle-meta schema version. Bump this whenever the segment id/file naming
 * scheme changes, so caches written under an older scheme are re-extracted
 * (v1: interludes were globally numbered "int.K" and the epilogue "chN.5";
 * v2: interludes are "chN.K" anchored to the preceding chapter and the
 * epilogue is "chN.epilogue"; v3: epilogues are named like interludes,
 * continuing the chN.K counter after their anchor chapter).
 *
 * @type {number}
 */
const BUNDLE_SCHEMA_VERSION = 3;

/**
 * Read the chapter-fallback size threshold from the environment.
 *
 * @returns {number} The threshold in characters (0 = always chunk).
 */
function chunkThresholdChars() {
  const n = parseInt(process.env.SOURCE_CHUNK_THRESHOLD_CHARS, 10);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_CHUNK_THRESHOLD_CHARS;
}

/**
 * Decide whether a volume must be processed chapter by chapter (the fallback)
 * instead of as one whole installment (the default).
 *
 * The fallback only applies to epub bundles with more than one chapter, and
 * only when the whole text exceeds the threshold or chunking is forced with
 * --chunked. Everything else — every .md source and every small epub — is
 * processed whole, exactly as before epub support existed.
 *
 * @param {SourceBundle} bundle - The resolved source bundle.
 * @param {{forceChunked?: boolean, thresholdChars?: number}} [opts]
 * @returns {boolean} True when the chapter-by-chapter fallback applies.
 */
function shouldProcessChunked(bundle, opts = {}) {
  const forceChunked = !!opts.forceChunked;
  const threshold =
    opts.thresholdChars !== undefined ? opts.thresholdChars : chunkThresholdChars();
  if (!bundle || bundle.format !== "epub" || !Array.isArray(bundle.segments) || bundle.segments.length < 2) {
    return false;
  }
  if (forceChunked) return true;
  return (bundle.wholeChars || 0) > threshold;
}

// ─── Chapter identification (pure) ──────────────────────────────────────────

/**
 * Classify a chapter title into a structural role. The patterns cover the
 * usual English and Japanese light-novel conventions; anything unrecognized
 * is a regular chapter.
 *
 * @param {string} title - The chapter title (any language).
 * @returns {"prologue"|"interlude"|"epilogue"|"chapter"} The role.
 */
function classifyTitle(title) {
  if (typeof title !== "string") return "chapter";
  const t = title.trim().toLowerCase();
  if (!t) return "chapter";
  if (/(prologue|prelude)/i.test(t) || /序章|序文|^序$/.test(t)) return "prologue";
  if (/(interlude|intermezzo|intermission)/i.test(t) || /間奏|間の物語|間の話/.test(t)) return "interlude";
  if (/(epilogue|coda|postscript|afterword|colophon)/i.test(t) || /終章|エピローグ|結語/.test(t)) return "epilogue";
  return "chapter";
}

/**
 * Assign segment ids to chapters, in reading order.
 *
 *   - prologue (before the first chapter)  → "ch0"
 *   - regular chapters                     → "ch1", "ch2", …
 *   - interludes and epilogues             → "chN.K": anchored to the chapter
 *     that existed immediately before the segment (N = that chapter's
 *     number, "ch0" when the segment sits before any chapter), with the
 *     counter K restarting at 1 for each chapter — two interludes after
 *     chapter 2 are "ch2.1" and "ch2.2", an interlude and an epilogue after
 *     chapter 3 are "ch3.1" and "ch3.2". Epilogues get no special id: they
 *     are just the next chN.K after their anchor chapter.
 *
 * A "prologue" title appearing after regular chapters, or a second prologue,
 * is treated as a regular chapter (the id space stays gap-free).
 *
 * @param {string[]} titles - Chapter titles in reading order.
 * @returns {string[]} The segment ids, one per title, in the same order.
 */
function assignSegmentIds(titles) {
  const ids = [];
  let nextChapter = 1;
  // The id of the most recent chapter-type segment (the prologue "ch0" or a
  // regular "chN") — the anchor for interludes and epilogues.
  let lastChapterId = null;
  const segmentsAfter = new Map(); // anchor id → interlude/epilogue count
  let prologueUsed = false;
  for (const title of titles) {
    const kind = classifyTitle(title);
    if (kind === "prologue" && !prologueUsed && lastChapterId === null) {
      ids.push("ch0");
      prologueUsed = true;
      lastChapterId = "ch0";
    } else if (kind === "interlude" || kind === "epilogue") {
      // Epilogues are named exactly like interludes (simplification): the
      // next chN.K counter after their anchor chapter.
      const anchor = lastChapterId || "ch0";
      const count = (segmentsAfter.get(anchor) || 0) + 1;
      segmentsAfter.set(anchor, count);
      ids.push(`${anchor}.${count}`);
    } else {
      const id = `ch${nextChapter}`;
      ids.push(id);
      nextChapter += 1;
      lastChapterId = id;
    }
  }
  return ids;
}
// ─── XHTML → Markdown (pure) ────────────────────────────────────────────────

/**
 * Convert an XHTML document (one epub chapter) to Markdown.
 *
 * Block mapping: h1–h6 → `#`…, p → paragraph, blockquote → `> `, ul/ol →
 * lists, pre → fenced code, table → ` | `-separated rows, hr → `---`.
 * Inline mapping: em → `*…*`, b/strong → `**…**`, del/s → `~~…~~`, a → its
 * text, br → line break, img → `imageRef(src)`. All other tags render as
 * their text. Whitespace runs collapse to single spaces (safe for Japanese
 * text, which carries no spaces).
 *
 * @param {string} html - The XHTML content of one chapter.
 * @param {(src: string) => string} imageRef - Maps a raw <img src> to a
 *   Markdown image reference (the caller registers the image).
 * @returns {string} The Markdown text (trimmed).
 */
function xhtmlToMarkdown(html, imageRef) {
  const $ = cheerio.load(typeof html === "string" ? html : "");
  $("script, style, head, title").remove();
  const root = $("body").length ? $("body") : $.root();
  const out = [];
  root.contents().each((i, node) => {
    const piece = node.type === "text" ? normalizeSpaces(node.data) : renderBlock($, $(node), imageRef);
    if (piece) out.push(piece);
  });
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Collapse whitespace runs (including newlines) to single spaces. */
function normalizeSpaces(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

/**
 * Render one block-level element to Markdown.
 *
 * @param {import("cheerio").CheerioAPI} $ - The cheerio API for this document.
 * @param {import("cheerio").Cheerio<Element>} el
 * @param {(src: string) => string} imageRef
 * @returns {string}
 */
function renderBlock($, el, imageRef) {
  const node = el.get(0);
  if (!node || node.type === "text") return normalizeSpaces(el.text());
  const tag = (node.tagName || "").toLowerCase();
  const heading = tag.match(/^h([1-6])$/);
  if (heading) {
    const text = inlineText($, el, imageRef);
    return text ? `${"#".repeat(parseInt(heading[1], 10))} ${text}` : "";
  }
  switch (tag) {
    case "p":
    case "figure":
      return inlineText($, el, imageRef);
    case "br":
      return "";
    case "hr":
      return "---";
    case "blockquote": {
      const inner = renderContainer($, el, imageRef);
      return inner ? inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n") : "";
    }
    case "pre": {
      const t = el.text().replace(/\n+$/, "");
      return t ? "```\n" + t + "\n```" : "";
    }
    case "ul":
    case "ol": {
      const items = [];
      el.find("> li").each((i, li) => {
        const t = inlineText($, $(li), imageRef);
        if (t) items.push(`${tag === "ol" ? `${i + 1}. ` : "- "}${t}`);
      });
      return items.join("\n");
    }
    case "table": {
      const rows = [];
      el.find("tr").each((i, tr) => {
        const cells = [];
        $(tr).find("> td, > th").each((j, c) => {
          const t = inlineText($, $(c), imageRef);
          if (t) cells.push(t);
        });
        if (cells.length) rows.push(cells.join(" | "));
      });
      return rows.join("\n");
    }
    case "img": {
      const src = el.attr("src");
      return src ? imageRef(src) : "";
    }
    case "div":
    case "section":
    case "article":
    case "main":
    case "header":
    case "footer":
    case "center":
    case "span":
    case "font":
    case "ruby":
      return renderContainer($, el, imageRef);
    default:
      return el.children().length > 0 ? renderContainer($, el, imageRef) : inlineText($, el, imageRef);
  }
}

/**
 * Render the children of a container element (recursing into blocks).
 *
 * @param {import("cheerio").CheerioAPI} $ - The cheerio API for this document.
 * @param {import("cheerio").Cheerio<Element>} el
 * @param {(src: string) => string} imageRef
 * @returns {string}
 */
function renderContainer($, el, imageRef) {
  const out = [];
  el.contents().each((i, node) => {
    const piece = node.type === "text" ? normalizeSpaces(node.data) : renderBlock($, $(node), imageRef);
    if (piece) out.push(piece);
  });
  return out.join("\n\n");
}

/**
 * Render inline content of an element to Markdown text. <br> becomes a real
 * line break; all other whitespace collapses to single spaces.
 *
 * @param {import("cheerio").CheerioAPI} $ - The cheerio API for this document.
 * @param {import("cheerio").Cheerio<Element>} el
 * @param {(src: string) => string} imageRef
 * @returns {string}
 */
function inlineText($, el, imageRef) {
  const BR = "\u0000br\u0000";
  let out = "";
  el.contents().each((i, node) => {
    if (node.type === "text") {
      out += node.data;
      return;
    }
    const n = $(node);
    const tag = (node.tagName || "").toLowerCase();
    switch (tag) {
      case "br":
        out += BR;
        break;
      case "img": {
        const src = n.attr("src");
        if (src) out += imageRef(src);
        break;
      }
      case "em": {
        const t = inlineText($, n, imageRef);
        out += t.trim() ? `*${t}*` : t;
        break;
      }
      case "strong":
      case "b": {
        const t = inlineText($, n, imageRef);
        out += t.trim() ? `**${t}**` : t;
        break;
      }
      case "del":
      case "s": {
        const t = inlineText($, n, imageRef);
        out += t.trim() ? `~~${t}~~` : t;
        break;
      }
      default:
        out += inlineText($, n, imageRef);
        break;
    }
  });
  return out.replace(/\s+/g, " ").replace(new RegExp(BR, "g"), "\n").trim();
}

/**
 * The text of the first heading (h1–h6) in the document, if any.
 *
 * @param {import("cheerio").CheerioAPI} $
 * @returns {string}
 */
function firstHeadingText($) {
  for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
    const h = $(tag).first();
    if (h.length) {
      const t = normalizeSpaces(h.text());
      if (t) return t;
    }
  }
  return "";
}

// ─── Epub extraction ────────────────────────────────────────────────────────

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

  return {
    epubPath,
    zip,
    opfPath,
    opfDir,
    metadata,
    manifestItems,
    spine,
    textItems,
    titles: await loadNavTitles(zip, opfDir, manifestItems),
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
 * Block-level tags: each one starts a new piece of text. Everything else is
 * inline and stays glued to the sentence it belongs to.
 *
 * @type {Set<string>}
 */
const PLAIN_TEXT_BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "div",
  "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "ol", "p", "pre",
  "section", "table", "tbody", "td", "th", "tr", "ul",
]);

/**
 * Text of a node WITHOUT crossing into a nested block element (a nested block
 * is handled by htmlToPlainText's own recursion, so it is not swallowed here).
 * <br> becomes a newline so a hard line break inside a paragraph survives.
 *
 * @param {Object|null} node - A cheerio/domhandler node.
 * @returns {string} The inline text.
 */
function inlineTextOf(node) {
  if (!node) return "";
  if (node.type === "text") return node.data || "";
  if (node.type !== "tag") return "";
  const name = (node.name || "").toLowerCase();
  if (PLAIN_TEXT_BLOCK_TAGS.has(name)) return "";
  if (name === "br") return "\n";
  return (node.children || []).map(inlineTextOf).join("");
}

/**
 * Collect the paragraph-shaped pieces of a document into `out`.
 *
 * @param {Object|null} node - A cheerio/domhandler node.
 * @param {string[]} out - The pieces collected so far (mutated).
 * @returns {void}
 */
function collectTextPieces(node, out) {
  if (!node) return;
  if (node.type === "text") {
    const piece = normalizeSpaces(node.data);
    if (piece) out.push(piece);
    return;
  }
  if (node.type !== "tag") return;
  const name = (node.name || "").toLowerCase();
  if (name === "br") return;
  if (PLAIN_TEXT_BLOCK_TAGS.has(name)) {
    // This block's own text (its direct text + inline children), split on any
    // hard <br> breaks...
    const own = (node.children || [])
      .map(inlineTextOf)
      .join("")
      .split("\n")
      .map(normalizeSpaces)
      .filter(Boolean);
    out.push(...own);
    // ...then its nested blocks, each of which becomes its own piece. Only
    // blocks: the inline and text children were already folded into `own`.
    for (const child of node.children || []) {
      if (child && child.type === "tag" && PLAIN_TEXT_BLOCK_TAGS.has((child.name || "").toLowerCase())) {
        collectTextPieces(child, out);
      }
    }
    return;
  }
  const piece = normalizeSpaces(inlineTextOf(node));
  if (piece) out.push(piece);
}

/**
 * Convert XHTML to plain text (paragraph breaks kept, no markup). Lighter
 * than xhtmlToMarkdown(): no image references, no heading/list syntax — used
 * when the text only needs to be looked at.
 *
 * Paragraph structure is the whole point of this function: an epub chapter is
 * normally ONE block element wrapping many <p> tags, so walking only the
 * top-level children glued every paragraph together into a single run-on line
 * (observed: "<p>a</p><p>b</p><p>c</p>" came back as "abc"), which is the text
 * the intake agent judges a book by.
 *
 * @param {string} html - The XHTML document.
 * @returns {string} The plain text.
 */
function htmlToPlainText(html) {
  const $ = cheerio.load(typeof html === "string" ? html : "");
  $("script, style, head, title").remove();
  const root = $("body").length ? $("body").get(0) : $.root().get(0);
  const out = [];
  collectTextPieces(root, out);
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
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
 * Collect chapter titles from the epub's navigation documents (EPUB3 nav,
 * then NCX). Keys are zip entry paths.
 *
 * @param {JSZip} zip
 * @param {string} opfDir - The OPF file's zip directory.
 * @param {Array<{href: string, mediaType: string, properties: string}>} manifestItems
 * @returns {Promise<Map<string, string>>}
 */
async function loadNavTitles(zip, opfDir, manifestItems) {
  const titles = new Map();
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
          if (href && t) {
            const key = normalizeZipPath(path.posix.join(path.posix.dirname(p), href));
            if (!titles.has(key)) titles.set(key, t);
          }
        });
      } catch {
        // unreadable nav — fall through to NCX / headings
      }
    }
  }
  // EPUB2 NCX.
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
          if (src && t) {
            const key = normalizeZipPath(path.posix.join(opfDir, src));
            if (!titles.has(key)) titles.set(key, t);
          }
        });
      } catch {
        // unreadable NCX — fall back to in-chapter headings
      }
    }
  }
  return titles;
}

/**
 * Image registry: records every image referenced (or declared in the
 * manifest) while chapters are converted, and writes the deduplicated files
 * into `<volumeDir>/images/` with a manifest.json on flush.
 */
class ImageRegistry {
  /**
   * @param {JSZip} zip - The open epub zip.
   * @param {string} volumeDir - The volume folder (images land in images/ under it).
   */
  constructor(zip, volumeDir) {
    this.zip = zip;
    this.volumeDir = volumeDir;
    this.byZipPath = new Map(); // zipPath -> { file }
    this.order = []; // zipPaths in first-appearance order
  }

  /**
   * Register an image by zip path and return its Markdown reference (relative
   * to the volume folder, where the chapter files live).
   *
   * @param {string} zipPath - The image's zip entry path.
   * @returns {string} A Markdown image reference, or "" for a bad src.
   */
  reference(zipPath) {
    if (!zipPath) return "";
    if (this.byZipPath.has(zipPath)) return `![](images/${this.byZipPath.get(zipPath).file})`;
    const orig = path.posix.basename(zipPath);
    const safe = orig.replace(/[^a-zA-Z0-9._-]/g, "_") || "image";
    const file = `img-${String(this.order.length + 1).padStart(4, "0")}-${safe}`;
    this.byZipPath.set(zipPath, { file });
    this.order.push(zipPath);
    return `![](images/${file})`;
  }

  /**
   * Write the registered images to `<volumeDir>/images/` plus manifest.json.
   *
   * @returns {Promise<Array<{file: string, epubPath: string, sha256: string, bytes: number}>|null>}
   *   The manifest entries, or null when no images were registered.
   */
  async flush() {
    if (this.order.length === 0) return null;
    const imagesDir = path.join(this.volumeDir, "images");
    await fs.mkdir(imagesDir, { recursive: true });
    const entries = [];
    for (const zipPath of this.order) {
      const entry = this.zip.file(zipPath);
      if (!entry) {
        console.warn(`[source] image entry "${zipPath}" not found in the epub; skipping.`);
        continue;
      }
      const buf = await entry.async("nodebuffer");
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      const file = this.byZipPath.get(zipPath).file;
      await fs.writeFile(path.join(imagesDir, file), buf);
      entries.push({ file, epubPath: zipPath, sha256: sha, bytes: buf.length });
    }
    const manifest = { generatedAt: new Date().toISOString(), images: entries };
    await fs.writeFile(
      path.join(imagesDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf-8"
    );
    return entries;
  }
}

/**
 * Extract an epub into the volume folder: per-chapter Markdown files, the
 * whole-volume file, the images/ directory and the returned meta object (the
 * caller persists it as `<base>-bundle.meta.json`).
 *
 * @param {string} epubPath - Absolute path to the .epub file.
 * @param {string} volumeDir - The volume folder to write into.
 * @param {string} base - The source base name (no extension), for file names.
 * @returns {Promise<Object>} The bundle meta (format, base, wholeFile,
 *   segments, images, wholeChars).
 * @throws {Error} When the file is not a valid epub or has no readable text.
 */
async function extractEpubToBundle(epubPath, volumeDir, base) {
  // One shared container read (openEpub) — the same helper the intake agent's
  // epub tools use, so "what a valid epub is" lives in exactly one place.
  const opened = await openEpub(epubPath);
  const { zip, opfDir, manifestItems, textItems, titles: navTitles } = opened;
  const registry = new ImageRegistry(zip, volumeDir);
  const chapterImageRef = (chapterZipPath) => (src) =>
    registry.reference(normalizeZipPath(path.posix.join(path.posix.dirname(chapterZipPath), src)));

  // Convert each readable section (in spine/reading order — openEpub resolved
  // every section's zip path and already dropped the non-text items).
  const chapters = [];
  for (const item of textItems) {
    const zipPath = item.zipPath;
    const html = await zip.file(zipPath).async("string");
    const $ = cheerio.load(html);
    const title =
      navTitles.get(zipPath) ||
      firstHeadingText($) ||
      normalizeSpaces($.root().find("title").first().text()) ||
      `Chapter ${chapters.length + 1}`;
    const md = xhtmlToMarkdown(html, chapterImageRef(zipPath));
    chapters.push({ title, md });
  }
  if (chapters.length === 0) {
    throw new Error(`No readable text chapters found in the spine of ${epubPath}.`);
  }

  // Assign ids, then write the per-chapter files (each starts with its title
  // as an H1; a duplicate leading heading in the chapter body is dropped).
  const ids = assignSegmentIds(chapters.map((c) => c.title));
  const segments = [];
  const contents = [];
  for (let i = 0; i < chapters.length; i++) {
    let body = chapters[i].md;
    const title = chapters[i].title;
    const firstLine = body.split("\n", 1)[0] || "";
    if (
      /^#{1,6}\s+/.test(firstLine) &&
      firstLine.replace(/^#{1,6}\s+/, "").trim().toLowerCase() === title.trim().toLowerCase()
    ) {
      body = body.slice(firstLine.length).trim();
    }
    const content = `# ${title}\n\n${body}`.trim() + "\n";
    const file = `${base}-${ids[i]}.md`;
    await fs.writeFile(path.join(volumeDir, file), content, "utf-8");
    segments.push({ id: ids[i], file, title, chars: content.length });
    contents.push(content.trim());
  }

  // Whole-volume file (the chapters, in order — each already carries its H1).
  const whole = contents.join("\n\n");
  const wholeFile = `${base}-whole.md`;
  await fs.writeFile(path.join(volumeDir, wholeFile), whole + "\n", "utf-8");

  // Images: everything referenced from the chapters plus every image declared
  // in the OPF manifest (covers, plates, …) so the folder holds ALL embedded
  // images.
  for (const item of manifestItems) {
    if ((item.mediaType || "").startsWith("image/")) {
      registry.reference(normalizeZipPath(path.posix.join(opfDir, item.href)));
    }
  }
  const images = (await registry.flush()) || [];

  return {
    format: "epub",
    schema: BUNDLE_SCHEMA_VERSION,
    base,
    wholeFile,
    segments,
    images,
    wholeChars: whole.length,
  };
}

// ─── Bundle resolution (the pipeline entry point) ───────────────────────────

/**
 * Resolve a volume's source into a SourceBundle.
 *
 * For `.md`/`.txt` sources the bundle is a single "whole" segment pointing at
 * the original file — nothing is written and nothing changes for existing
 * series. For `.epub` sources the bundle is materialized in the volume
 * folder (cached in `<base>-bundle.meta.json`, keyed on the epub's
 * mtime+size+sha256; re-extracted when the file changes or { force } is set).
 *
 * @param {{seriesDir: string, volume: TranslationTargetVolume, volumeDir: string, force?: boolean}} p
 * @returns {Promise<SourceBundle>}
 * @throws {Error} When the source file is missing or the epub is unreadable.
 */
async function resolveSourceBundle({ seriesDir, volume, volumeDir, force = false }) {
  const originalPath = path.resolve(seriesDir, volume.sourceFile);
  if (!(await fileExists(originalPath))) {
    throw new Error(`Required source file not found: ${originalPath}`);
  }
  const base = path.basename(originalPath).replace(/\.[^.]+$/, "");

  if (!isEpubPath(originalPath)) {
    const st = await fs.stat(originalPath);
    return {
      format: "text",
      originalPath,
      base,
      volumeDir,
      wholePath: originalPath,
      segments: [
        {
          id: "whole",
          file: path.basename(originalPath),
          title: path.basename(originalPath),
          chars: st.size,
        },
      ],
      imagesDir: null,
      wholeChars: st.size,
      cacheHit: false,
      // Content hash of the source file — the artifact skip-checks compare it
      // against the fingerprint persisted in the last run's rolling state so
      // a re-released / errata-fixed source invalidates the stale artifacts
      // (see isSourceStale in configs/shared.js).
      sourceFingerprint: await sha256OfFile(originalPath),
    };
  }

  const metaPath = path.join(volumeDir, `${base}-bundle.meta.json`);
  const st = await fs.stat(originalPath);
  const sha = await sha256OfFile(originalPath);
  const relSource = path.relative(volumeDir, originalPath) || path.basename(originalPath);

  let cached = null;
  if (!force) {
    cached = await readJsonOrNull(metaPath);
    const fresh =
      cached &&
      cached.sourceFile === relSource &&
      cached.mtimeMs === st.mtimeMs &&
      cached.size === st.size &&
      cached.sha256 === sha &&
      // Caches written under an older segment-id naming scheme (see
      // BUNDLE_SCHEMA_VERSION) are re-extracted so the files on disk match
      // the current scheme.
      cached.schema === BUNDLE_SCHEMA_VERSION;
    if (fresh) {
      const missing = [];
      for (const seg of cached.segments || []) {
        if (!(await fileExists(path.join(volumeDir, seg.file)))) missing.push(seg.file);
      }
      if (!(await fileExists(path.join(volumeDir, cached.wholeFile)))) missing.push(cached.wholeFile);
      if (missing.length === 0) {
        console.log(
          `[source] bundle for "${path.basename(originalPath)}" is up to date (cache hit) — ` +
            `reusing ${cached.segments.length} segment(s).`
        );
        return materializeBundle(cached, { originalPath, volumeDir, cacheHit: true });
      }
      console.log(
        `[source] bundle for "${path.basename(originalPath)}" is missing file(s) ` +
          `(${missing.join(", ")}) — re-extracting.`
      );
    } else if (cached) {
      const reason =
        cached.schema === BUNDLE_SCHEMA_VERSION
          ? "source changed"
          : `schema ${cached.schema === undefined ? "1 (pre-versioning)" : cached.schema} → ${BUNDLE_SCHEMA_VERSION} (segment id scheme changed)`;
      console.log(
        `[source] bundle for "${path.basename(originalPath)}" is stale (${reason}) — re-extracting.`
      );
    }
  }

  const meta = await extractEpubToBundle(originalPath, volumeDir, base);
  meta.sourceFile = relSource;
  meta.mtimeMs = st.mtimeMs;
  meta.size = st.size;
  meta.sha256 = sha;
  meta.generatedAt = new Date().toISOString();
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  // Remove segment files from a previous cache whose names changed under the
  // current id scheme — otherwise stale strays (e.g. old "int.K" interludes)
  // would linger in the volume folder and could be read by agents.
  if (cached) {
    const currentFiles = new Set((meta.segments || []).map((s) => s.file));
    for (const oldSeg of cached.segments || []) {
      if (currentFiles.has(oldSeg.file)) continue;
      const oldPath = path.join(volumeDir, oldSeg.file);
      if (await fileExists(oldPath)) {
        await fs.rm(oldPath);
        console.log(`[source] removed stale segment file "${oldSeg.file}" (renamed by the current id scheme).`);
      }
    }
  }
  console.log(
    `[source] extracted "${path.basename(originalPath)}" into ${meta.segments.length} segment(s) ` +
      `+ ${meta.images.length} image(s) in ${volumeDir}.`
  );
  return materializeBundle(meta, { originalPath, volumeDir, cacheHit: false });
}

/**
 * Build the in-memory SourceBundle from a persisted meta object.
 *
 * @param {Object} meta - The persisted bundle meta.
 * @param {{originalPath: string, volumeDir: string, cacheHit: boolean}} p
 * @returns {SourceBundle}
 */
function materializeBundle(meta, { originalPath, volumeDir, cacheHit }) {
  return {
    format: meta.format === "epub" ? "epub" : "text",
    originalPath,
    base: meta.base,
    volumeDir,
    wholePath: path.join(volumeDir, meta.wholeFile),
    segments: (meta.segments || []).map((s) => ({
      id: s.id,
      file: s.file,
      title: s.title,
      chars: s.chars,
      path: path.join(volumeDir, s.file),
    })),
    imagesDir: (meta.images || []).length > 0 ? path.join(volumeDir, "images") : null,
    wholeChars: meta.wholeChars || 0,
    cacheHit,
    // The cache meta records the epub's sha256 (see resolveSourceBundle) —
    // the same value the artifact skip-checks compare against.
    sourceFingerprint: meta.sha256 || null,
  };
}

// ─── Prompt helpers (chapter-aware materials lines) ─────────────────────────
// The task modules build their agent/one-shot prompts in code; these helpers
// keep the bundle-aware wording in exactly one place.

/**
 * The "volume source" materials line for a whole-installment prompt.
 *
 * @param {SourceBundle|null} bundle - The resolved bundle (null → null, so
 *   callers can fall back to the legacy folder-name convention in tests).
 * @returns {string|null}
 */
function sourceMaterialLine(bundle) {
  if (!bundle) return null;
  if (bundle.format === "epub") {
    return (
      `- The volume source: "${path.basename(bundle.wholePath)}" ` +
        `(same folder, normalized from "${path.basename(bundle.originalPath)}")`
    );
  }
  return `- The volume source: "${path.basename(bundle.wholePath)}" (same folder)`;
}

/**
 * The materials line listing the chapter files of a chunked (fallback)
 * volume, in reading order.
 *
 * @param {SourceBundle} bundle
 * @returns {string}
 */
function sourceSegmentListLine(bundle) {
  const list = bundle.segments.map((s) => `"${s.file}"`).join(", ");
  return (
    `- The volume source is split into chapters (read them in this order): ${list} (same folder); ` +
      `"${path.basename(bundle.wholePath)}" is their concatenation.`
  );
}

/**
 * The note appended to the one-shot extraction prompts when a volume is
 * processed chapter by chapter (the fallback path).
 *
 * @param {SourceBundle} bundle
 * @param {SourceSegment} segment - The chapter being extracted.
 * @param {number} index - Zero-based position in reading order.
 * @returns {string}
 */
function chapterSegmentNote(bundle, segment, index) {
  return (
    `## Chapter segment note\n` +
      `This volume is processed chapter by chapter (the whole installment is too large for a single pass). ` +
      `The source text you were given is chapter "${segment.id}" (${segment.title}), ` +
      `${index + 1} of ${bundle.segments.length}, in reading order. ` +
      `The cumulative reference material already covers the chapters before it — ` +
      `extract only what this chapter adds or changes.`
  );
}

/**
 * The chapter-context block prepended to the agent turn prompts of a chunked
 * (fallback) volume: names the current chapter and the ordered chapter list.
 *
 * @param {{INSTALLMENT_NUMBER: string}} values - The volume values.
 * @param {SourceBundle} bundle
 * @param {SourceSegment} segment - The chapter the agent is processing.
 * @param {number} index - Zero-based position in reading order.
 * @returns {string}
 */
function chapterContextBlock(values, bundle, segment, index) {
  const list = bundle.segments.map((s) => `"${s.file}"`).join(", ");
  return (
    `Chapter context: you are processing chapter "${segment.id}" (${segment.title}), ` +
      `${index + 1} of ${bundle.segments.length}, of volume ${values.INSTALLMENT_NUMBER}, in reading order. ` +
      `The volume source is split into these chapter files (same folder): ${list}. ` +
      `The cumulative output currently reflects the chapters before this one — ` +
      `carry everything forward unchanged and add only what this chapter contributes.\n\n`
  );
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_CHUNK_THRESHOLD_CHARS,
  BUNDLE_SCHEMA_VERSION,
  chunkThresholdChars,
  shouldProcessChunked,
  classifyTitle,
  assignSegmentIds,
  xhtmlToMarkdown,
  isEpubPath,
  normalizeZipPath,
  openEpub,
  readEpubSection,
  htmlToPlainText,
  scriptCounts,
  extractEpubToBundle,
  resolveSourceBundle,
  sha256OfFile,
  sourceMaterialLine,
  sourceSegmentListLine,
  chapterSegmentNote,
  chapterContextBlock,
};


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
  const $opf = cheerio.load(opfXml);
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
  const navTitles = await loadNavTitles(zip, opfDir, manifestItems);
  const registry = new ImageRegistry(zip, volumeDir);
  const chapterImageRef = (chapterZipPath) => (src) =>
    registry.reference(normalizeZipPath(path.posix.join(path.posix.dirname(chapterZipPath), src)));

  // Convert each spine item (in reading order).
  const chapters = [];
  for (const item of spine) {
    const zipPath = normalizeZipPath(path.posix.join(opfDir, item.href));
    const entry = zip.file(zipPath);
    const isText =
      (item.mediaType || "").includes("html") || /\.(x?html?)$/i.test(item.href || "");
    if (!entry || !isText) continue;
    const html = await entry.async("string");
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
  extractEpubToBundle,
  resolveSourceBundle,
  sha256OfFile,
  sourceMaterialLine,
  sourceSegmentListLine,
  chapterSegmentNote,
  chapterContextBlock,
};


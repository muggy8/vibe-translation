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
 *                            + the packaging pages that were NOT made into
 *                            chapters (see groupSpineIntoChapters)
 *
 * A chapter is what the BOOK says is a chapter: the spine is grouped by the
 * book's own table of contents, so an inserted illustration that the packager
 * gave its own spine item is folded into the chapter it illustrates instead of
 * becoming a phantom chapter (see groupSpineIntoChapters).
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
const { structuralError } = require("../configs/shared");
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
 * continuing the chN.K counter after their anchor chapter; v4: segments carry
 * `bodyChars` and an `empty` flag, so a section that converted to nothing is
 * recorded as an empty chapter instead of a silent zero-length one; v5: the
 * spine is grouped by the book's own table of contents, so an inserted
 * illustration page or a chapter the packager split across two files is ONE
 * chapter, and cover / contents / notice / colophon pages are recorded as
 * packaging instead of being handed downstream as chapters).
 *
 * @type {number}
 */
const BUNDLE_SCHEMA_VERSION = 5;

/**
 * A converted section with fewer than this many characters of text is recorded
 * as an EMPTY chapter (SOURCE_EMPTY_SEGMENT_CHARS). This is not a story-length
 * rule — a real chapter is longer than this — it is the "the conversion produced
 * nothing" floor: an image-only page, a page whose text lives in a structure the
 * converter does not map, or a stub. Flagging it is what makes a missing chapter
 * visible in the reports instead of becoming a chapter nobody translated.
 *
 * @type {number}
 */
const EMPTY_SEGMENT_CHARS = (() => {
  const n = parseInt(process.env.SOURCE_EMPTY_SEGMENT_CHARS, 10);
  return Number.isFinite(n) ? Math.max(0, n) : 200;
})();

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
 * Split a plain-text source into chapter-sized segments (the chunked fallback
 * for a plain-text volume that is too big to process whole).
 *
 * Paragraph-aware: the text is split on blank lines, and whole paragraphs are
 * greedily packed into segments of at most `targetChars`. A single paragraph
 * longer than the target becomes a segment of its own (splitting mid-paragraph
 * would break a sentence). Every paragraph lands in exactly one segment, so
 * the content is preserved — only blank-line runs are normalised to one.
 *
 * @param {string} text - The full source text.
 * @param {number} targetChars - The approximate size of each segment.
 * @returns {string[]} The segments in reading order (empty array for empty input).
 */
function splitPlainTextSegments(text, targetChars) {
  const target = Math.max(1000, targetChars || 0);
  const paragraphs = (text || "").split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  const segments = [];
  let current = [];
  let currentLen = 0;
  for (const para of paragraphs) {
    if (para.length > target) {
      if (current.length) {
        segments.push(current.join("\n\n"));
        current = [];
        currentLen = 0;
      }
      segments.push(para);
      continue;
    }
    if (currentLen + para.length + 2 > target && current.length) {
      segments.push(current.join("\n\n"));
      current = [];
      currentLen = 0;
    }
    current.push(para);
    currentLen += para.length + 2;
  }
  if (current.length) segments.push(current.join("\n\n"));
  return segments;
}

/**
 * Decide whether a volume must be processed chapter by chapter (the fallback)
 * instead of as one whole installment (the default).
 *
 * The fallback applies to epub bundles with more than one chapter, and to
 * plain-text sources that were split into parts because they exceed the
 * threshold — in both cases only when the whole text exceeds the threshold or
 * chunking is forced with --chunked. Everything else — every small plain-text
 * source and every small epub — is processed whole.
 *
 * @param {SourceBundle} bundle - The resolved source bundle.
 * @param {{forceChunked?: boolean, thresholdChars?: number}} [opts]
 * @returns {boolean} True when the chapter-by-chapter fallback applies.
 */
function shouldProcessChunked(bundle, opts = {}) {
  const forceChunked = !!opts.forceChunked;
  const threshold =
    opts.thresholdChars !== undefined ? opts.thresholdChars : chunkThresholdChars();
  // Both epubs and split plain-text volumes can have multiple segments; a
  // single-segment bundle (a small plain-text file, or an epub with one
  // section) is always processed whole.
  if (
    !bundle ||
    (bundle.format !== "epub" && bundle.format !== "text") ||
    !Array.isArray(bundle.segments) ||
    bundle.segments.length < 2
  ) {
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
  if (/(prologue|prelude)/i.test(t) || /序章|序文|^序$|プロローグ/.test(t)) return "prologue";
  if (/(interlude|intermezzo|intermission)/i.test(t) || /間奏|間の物語|間の話/.test(t)) return "interlude";
  // あとがき (the author's afterword) is a real section of the book and is
  // translated; it is not packaging. It sits after the last chapter, so it
  // belongs in the chN.K space alongside the epilogue.
  if (/(epilogue|coda|postscript|afterword|colophon)/i.test(t) || /終章|エピローグ|結語|あとがき|後書き|後記/.test(t)) return "epilogue";
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

/**
 * How much STORY text an unnamed page group must hold before it is treated as a
 * section of the book rather than as packaging.
 *
 * This is the same question EMPTY_SEGMENT_CHARS asks ("did this convert to
 * nothing?"), asked of a group instead of a page — and it is measured only on
 * pages that did NOT declare themselves packaging, so a legal notice or a
 * colophon never has to be out-sized. A genuine opening scene the contents list
 * forgot can be under 600 characters (volumes 11 and 12 of the observed series
 * both have one); publisher boilerplate is excluded by its own declaration
 * rather than by length. SOURCE_UNDECLARED_SECTION_MIN_CHARS overrides it.
 *
 * @type {number}
 */
const UNDECLARED_SECTION_MIN_CHARS = (() => {
  const n = parseInt(process.env.SOURCE_UNDECLARED_SECTION_MIN_CHARS, 10);
  return Number.isFinite(n) ? Math.max(0, n) : EMPTY_SEGMENT_CHARS;
})();

/**
 * Body-class names that declare what a PAGE is: a piece of the book's packaging,
 * not a page of its story. Matched against the class the file itself carries.
 *
 * `p-text` (a page of the story) does not match. The list is the Kadokawa /
 * BOOK☆WALKER "文章型" vocabulary (p-cover, p-image, p-toc, p-caution,
 * p-colophon, p-colophon2, p-fmatter, p-bmatter, p-titlepage, p-allcover) plus
 * the equivalent words other packagers use.
 *
 * @type {RegExp}
 */
const PACKAGING_CLASS_RE =
  /(cover|title-?page|half-?title|frontispiece|image|illustration|plate|toc|contents|caution|notice|disclaimer|copyright|colophon|imprint|advert|frontmatter|backmatter|fmatter|bmatter|series-?page|survey|profile)/i;

/**
 * Characters of actual TEXT in a converted page — headings and Markdown image
 * references removed, whitespace removed.
 *
 * Counting the raw Markdown instead counts `![](images/img-0002-k001.jpg)` as
 * 33 characters of prose, and five illustration pages then look like a 165-char
 * section worth translating (observed: a run of cover plates plus a legal notice
 * became a phantom chapter that way).
 *
 * @param {string} md - Converted Markdown.
 * @returns {number}
 */
function textCharsOf(md) {
  return (md || "")
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\s+/g, "")
    .length;
}

/**
 * `epub:type` values that name the book's PACKAGING — a page the reader is not
 * meant to read as part of the story. Standard EPUB3 landmark types.
 *
 * @type {Set<string>}
 */
const PACKAGING_EPUB_TYPES = new Set([
  "cover", "frontmatter", "backmatter", "toc", "landmarks", "list", "index",
  "colophon", "imprint", "copyright-page", "preamble", "notice", "acknowledgments",
]);

/**
 * Navigation titles that name packaging. Matched against the WHOLE title,
 * because a chapter is never named merely "目次" — a real chapter title is
 * longer and specific.
 *
 * The list is deliberately short and errs in ONE direction: an unrecognized
 * label stays a chapter and gets translated. Translating a colophon is a
 * blemish in the output; mistaking a chapter for packaging deletes it from the
 * book. Add to this list only for a label you have actually seen in a real file.
 *
 * @type {RegExp}
 */
const PACKAGING_TITLE_RE = new RegExp(
  "^(?:" +
    "表紙|カバー|前扉|扉|扉ページ|タイトルページ|本編|目次|もくじ|次頁|奥付|書誌情報|" +
    "著作権|ご注意|ご利用上の注意|注意|広告|宣伝|書籍紹介|特設サイト|刊行詞|" +
    "cover|title[ -]?page|half[ -]?title|frontispiece|table of contents|contents|" +
    "copyright|colophon|imprint|notice|advertisement|index|series page" +
  ")$",
  "i"
);

/**
 * Decide, from the navigation entry alone, whether the book is naming a CHAPTER
 * or naming a piece of its own PACKAGING.
 *
 * @param {{title: string, inToc: boolean, types: string[]}} entry - One navigation entry.
 * @returns {{chapter: boolean, reason: string}}
 */
function classifyNavEntry(entry) {
  const typed = (entry.types || []).map((t) => String(t).toLowerCase());
  const packagingType = typed.find((t) => PACKAGING_EPUB_TYPES.has(t));
  if (packagingType) return { chapter: false, reason: `declared as epub:type="${packagingType}"` };
  const title = (entry.title || "").trim();
  if (PACKAGING_TITLE_RE.test(title)) return { chapter: false, reason: `"${title}" names packaging, not a chapter` };
  // Named only by the landmarks list ("this is where the main text starts") —
  // a structural pointer, not a section of the book.
  if (entry.inToc === false) return { chapter: false, reason: "a navigation landmark, not a contents entry" };
  return { chapter: true, reason: "" };
}

/**
 * Group an epub's readable spine sections into the sections the BOOK says it
 * has, using its own table of contents as the boundary marker.
 *
 * Why the table of contents and not the spine: a reflowable Japanese light
 * novel (the Kadokawa / BOOK☆WALKER "文章型" spec) gives EVERY page its own
 * spine item — the cover, five half-title illustrations, a full-colour insert
 * in front of every chapter, the chapter's text, the legal notice, the table of
 * contents, the author's profile, a reader-survey page, an advertisement, the
 * colophon. Volume 1 of a real 17-volume series has 35 spine items and 10
 * chapters. Taking the spine literally therefore produced 35 "chapters": the
 * pipeline translated the copyright notice and the table of contents, spent
 * research-agent turns on blank illustration pages, and reported 25 phantom
 * "empty in source" holes in a book that has none.
 *
 * The book's own contents list is the honest boundary: it names 表紙, 目次, the
 * ten real sections and 奥付, and it does NOT name the illustration pages. So a
 * named page OPENS a section and every unnamed page after it belongs to that
 * section. That also repairs the other half of the same packing quirk — a long
 * chapter whose text the packager split across two files (第四章 is p-010 +
 * p-011, the epilogue is p-019 + p-020) becomes ONE chapter again, instead of
 * one chapter plus a mystery fragment that starts mid-scene.
 *
 * One rule keeps that from eating real text: an unnamed page only ever joins an
 * OPEN CHAPTER. A page that follows packaging (a short story sitting between the
 * contents page and the first chapter's title page — volumes 5 and 13 of this
 * series both have one) starts its own group, so "the contents list forgot it"
 * can never turn a section into the cover's fine print.
 *
 * @param {Array<{zipPath: string}>} sections - Readable sections in spine (reading) order.
 * @param {Array<{zipPath: string, title: string, inToc: boolean, types: string[]}>} navEntries - The book's navigation entries, in document order.
 * @returns {Array<{title: string, declared: boolean, inToc: boolean, types: string[], kind: "chapter"|"packaging"|"undeclared", reason: string, zipPath: string, indices: number[]}>|null} The groups, in reading order, or null when the book's navigation names none of its pages. `indices` are positions in `sections`.
 */
function groupSpineIntoChapters(sections, navEntries) {
  const declared = new Map();
  for (const e of navEntries || []) {
    if (!e || !e.zipPath) continue;
    if (!declared.has(e.zipPath)) declared.set(e.zipPath, e);
  }
  // Grouping is only as good as the evidence for it. A book whose nav names none
  // of its readable pages (no nav file, an empty nav, a nav that only lists
  // cover/contents/colophon) gives us no boundary to group BY — merging every
  // page into one "section" would turn a whole book into a single chapter. The
  // caller then falls back to one chapter per page and says so loudly.
  if (![...(sections || [])].some((s) => s && declared.has(s.zipPath))) return null;
  const groups = [];
  for (let i = 0; i < (sections || []).length; i++) {
    const section = sections[i];
    const entry = declared.get(section.zipPath);
    const open = groups[groups.length - 1];
    if (entry) {
      const verdict = classifyNavEntry(entry);
      groups.push({
        title: entry.title || "",
        declared: true,
        inToc: entry.inToc !== false,
        types: entry.types || [],
        kind: verdict.chapter ? "chapter" : "packaging",
        reason: verdict.reason,
        zipPath: entry.zipPath,
        indices: [i],
      });
    } else if (open && (open.kind === "chapter" || open.kind === "undeclared")) {
      // Not named in the contents: it continues whatever chapter is open (a
      // chapter body page, a split chapter, an inserted illustration).
      open.indices.push(i);
    } else {
      // After packaging, or before anything was named: an undeclared section.
      // classifySectionGroup() decides it by what it actually holds.
      groups.push({
        title: "",
        declared: false,
        inToc: false,
        types: [],
        kind: "undeclared",
        reason: "not named in the book's contents",
        zipPath: section.zipPath,
        indices: [i],
      });
    }
  }
  return groups;
}

/**
 * Decide whether a grouped section is a chapter the pipeline should translate,
 * or packaging it should record and skip.
 *
 * A section the contents list names is decided by the naming. A section it does
 * NOT name is decided by what it holds: text means it is kept (losing a real
 * chapter is the worse mistake), an illustration or an empty page means it is
 * packaging.
 *
 * @param {{title: string, declared: boolean, inToc: boolean, types: string[], kind: string, reason: string}} group - One group from groupSpineIntoChapters().
 * @param {number} textChars - Characters of real text the group's pages hold (illustrations and markup not counted).
 * @returns {{chapter: boolean, reason: string}} The verdict and why, so the reason can be printed and persisted.
 */
function classifySectionGroup(group, textChars = 0) {
  if (!group) return { chapter: false, reason: "no group" };
  if (group.declared) {
    const typed = (group.types || []).map((t) => String(t).toLowerCase());
    const packagingType = typed.find((t) => PACKAGING_EPUB_TYPES.has(t));
    if (packagingType) return { chapter: false, reason: `declared as epub:type="${packagingType}"` };
    const title = (group.title || "").trim();
    if (PACKAGING_TITLE_RE.test(title)) return { chapter: false, reason: `"${title}" names packaging, not a chapter` };
    if (group.inToc === false) return { chapter: false, reason: "a navigation landmark, not a contents entry" };
    return { chapter: true, reason: "" };
  }
  if (textChars >= UNDECLARED_SECTION_MIN_CHARS) {
    return { chapter: true, reason: "not named in the book's contents, but it holds real text" };
  }
  return { chapter: false, reason: "not named in the book's contents and holds no section of text" };
}

/**
 * The title an unnamed section prints for itself, if it prints one.
 *
 * These books set a sub-section heading as a short centred line — 【俺とあいつが
 * 出会うまで】 — not as an <h1>, so the heading scan finds nothing and the only
 * honest source left is the line the page actually prints first. A long first
 * line is prose, not a title, and the section is then left untitled (the merge
 * prints no heading for a synthetic title) rather than given its opening
 * sentence as a name.
 *
 * @param {Array<string>} pageHeadings - Headings found in the group's pages, in order.
 * @param {string} body - The group's converted text.
 * @returns {{title: string, synthetic: boolean}}
 */
function titleOfUnnamedSection(pageHeadings, body) {
  const heading = (pageHeadings || []).find((h) => h && h.trim());
  if (heading) return { title: heading.trim(), synthetic: false };
  for (const line of (body || "").split("\n")) {
    const t = line.trim();
    if (!t || /^!?\[.*\]\(/.test(t)) continue;
    if (t.length <= 60 && /[【［「『]/.test(t)) return { title: t, synthetic: false };
    break;
  }
  return { title: "", synthetic: true };
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

/**
 * Drop a page's leading heading when it merely repeats the title the book's
 * contents already gave the section.
 *
 * Some packagers repeat the chapter title as an `<h1>` on every page of the
 * chapter; when several pages are merged into one chapter that repeats the same
 * line two or three times inside one file, and the merge then prints it again as
 * the chapter heading. Only an exact (case-insensitive) repeat is removed — a
 * heading that says something else is a real sub-heading and stays.
 *
 * @param {string} md - The converted page.
 * @param {string} title - The title the section already carries.
 * @returns {string} The page without its duplicated leading heading.
 */
function stripRepeatedHeading(md, title) {
  const body = (md || "").trim();
  if (!body || !title) return body;
  const firstLine = body.split("\n", 1)[0] || "";
  if (!/^#{1,6}\s+/.test(firstLine)) return body;
  if (firstLine.replace(/^#{1,6}\s+/, "").trim().toLowerCase() !== title.trim().toLowerCase()) return body;
  return body.slice(firstLine.length).trim();
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
  const { zip, opfDir, manifestItems, textItems, titles: navTitles, navEntries } = opened;
  const registry = new ImageRegistry(zip, volumeDir);
  const chapterImageRef = (chapterZipPath) => (src) =>
    registry.reference(normalizeZipPath(path.posix.join(path.posix.dirname(chapterZipPath), src)));

  // Convert every readable section (in spine/reading order — openEpub resolved
  // every section's zip path and already dropped the non-text items). Sections
  // are NOT chapters yet: the grouping pass below decides that.
  const sections = [];
  for (const item of textItems) {
    const zipPath = item.zipPath;
    const html = await zip.file(zipPath).async("string");
    const $ = cheerio.load(html);
    // The page's OWN heading, kept separate from the fallback chain: a group the
    // contents list did not name is titled from this, not from the page's
    // <title>, which in this template is the series title on every single page.
    const heading = firstHeadingText($);
    const pageTitle = normalizeSpaces($.root().find("title").first().text());
    const bodyClass = normalizeSpaces($("body").attr("class") || "");
    // The page declaring what it IS — a cover plate, the contents page, the
    // legal notice, the colophon. This is the book's own wording, not a guess
    // about length: it is what separates a 568-character copyright notice from
    // the 586-character opening scene the contents list forgot to mention.
    const declaresPackaging =
      PACKAGING_CLASS_RE.test(bodyClass) || PACKAGING_TITLE_RE.test(pageTitle);
    const title =
      navTitles.get(zipPath) ||
      heading ||
      pageTitle ||
      `Section ${sections.length + 1}`;
    const md = xhtmlToMarkdown(html, chapterImageRef(zipPath));
    sections.push({
      zipPath,
      title,
      heading,
      bodyClass,
      declaresPackaging,
      textChars: textCharsOf(md),
      declaredInNav: navTitles.has(zipPath),
      md,
    });
  }
  if (sections.length === 0) {
    throw new Error(`No readable text chapters found in the spine of ${epubPath}.`);
  }

  // Spine accounting. A book whose declared reading order has 42 items but only
  // 38 readable sections had 4 items dropped (a cover, a CSS file, a nav page,
  // an image-only page). That is usually correct — but it is the number that
  // tells you a chapter went missing, so it must be printed, not assumed.
  const skippedFromSpine = opened.spine.length - textItems.length;
  console.log(
    `[source] ${base}: spine lists ${opened.spine.length} item(s), ${textItems.length} readable ` +
      `section(s), ${opened.entryCount} file(s) in the archive` +
      (skippedFromSpine > 0 ? ` — ${skippedFromSpine} non-text item(s) skipped.` : ".")
  );
  if (skippedFromSpine > 0) {
    const skipped = opened.spine
      .filter((it) => !/\.x?html?$/i.test(it.href || ""))
      .map((it) => `${it.id || "?"} (${it.mediaType || "unknown"})`);
    if (skipped.length > 0) console.log(`[source]   skipped: ${skipped.join(", ")}`);
  }

  // ── Sections → chapters, using the book's own contents list ───────────────
  // A spine item is a PAGE, not a chapter. Treating one as the other is what
  // turned a 10-chapter book into 35 "chapters" (see groupSpineIntoChapters).
  // When the book's nav names none of its pages there is nothing to group by, so
  // each page stands alone — the pre-grouping behaviour, and it is reported
  // loudly below because the chapter count the rest of the pipeline uses is then
  // a guess.
  const grouped = groupSpineIntoChapters(sections, navEntries);
  const groups =
    grouped ||
    sections.map((s, i) => ({
      title: s.title,
      declared: false,
      inToc: false,
      types: [],
      kind: "single",
      reason: "the book's contents list names none of its pages",
      zipPath: s.zipPath,
      indices: [i],
    }));
  const chapterGroups = [];
  const packaging = [];
  for (const group of groups) {
    const pages = group.indices.map((i) => sections[i]);
    const body = pages
      .map((s) => stripRepeatedHeading(s.md, group.title || s.title))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    // The decision is made on characters of STORY text: Markdown image markup is
    // not text (five illustration pages carry 33 characters of markup each, and
    // counting them turns a run of plates into a "section worth translating"),
    // and a page that declares itself a notice / colophon / cover plate does not
    // count towards "this group is a section of the book".
    const storyTextChars = pages.reduce(
      (n, s) => n + (s.declaresPackaging ? 0 : s.textChars),
      0
    );
    const verdict = classifySectionGroup(group, storyTextChars);
    if (verdict.chapter) {
      // A chapter the contents list named carries that name. One it did not
      // name is titled from the heading the page itself prints, and left
      // untitled (synthetic) when it prints none.
      const unnamed = !group.declared;
      const own = unnamed
        ? group.kind === "single"
          ? { title: pages[0].title, synthetic: !pages[0].heading }
          : titleOfUnnamedSection(pages.map((s) => s.heading).filter(Boolean), body)
        : { title: group.title, synthetic: false };
      // A section with no name of its own gets a readable placeholder, NOT its
      // file name: this title ends up in chapters.json and every report, and
      // "p-001.xhtml" there reads like a chapter the book actually has (observed
      // on volumes 8 and 11 of the real series).
      const title = own.title || `Untitled section ${chapterGroups.length + 1}`;
      if (unnamed && group.kind !== "single") {
        console.warn(
          `[source] ${base}: "${title}" is NOT named in the book's contents but holds ${storyTextChars} ` +
            `character(s) of story text on ${pages.length} page(s) — kept as a chapter. ` +
            `The book's contents list is incomplete; check it against the packaging list below.`
        );
      }
      chapterGroups.push({ title, body, syntheticTitle: own.synthetic });
    } else {
      packaging.push({
        title: group.title || path.posix.basename(group.zipPath || ""),
        reason: verdict.reason,
        pages: group.indices.length,
        bodyChars: body.length,
        textChars: storyTextChars,
      });
    }
  }

  // Fail-open, two cases, both reported loudly because the chapter count the
  // rest of the pipeline uses is then a guess:
  //   (a) the nav names none of the readable pages → nothing to group BY, so
  //       every page stands alone (the pre-grouping behaviour);
  //   (b) the nav names pages but every one of them is packaging → the book
  //       cannot be zero chapters, so the same fallback runs.
  if (!grouped) {
    console.warn(
      `[source] ${base}: the book's own contents list names NONE of its ${sections.length} readable ` +
        `page(s) (no nav file, an empty nav, or a nav that points only at pages outside the text). ` +
        `Falling back to one chapter per spine page — ${chapterGroups.length} chapter(s), which may ` +
        `include cover / notice / illustration pages.`
    );
  }
  if (chapterGroups.length === 0) {
    console.warn(
      `[source] ${base}: the book's own contents list names NO chapters ` +
        `(${groups.length} group(s) from ${sections.length} readable section(s)). ` +
        `Falling back to one chapter per spine page — ${sections.length} chapter(s), ` +
        `which may include cover / notice / illustration pages.`
    );
    chapterGroups.push(
      ...sections.map((s) => ({
        title: s.title,
        body: stripRepeatedHeading(s.md, s.title),
        syntheticTitle: !s.heading,
      }))
    );
    packaging.length = 0;
  } else {
    const chapterChars = chapterGroups.reduce((n, c) => n + c.body.length, 0);
    const packagingChars = packaging.reduce((n, p) => n + p.bodyChars, 0);
    console.log(
      `[source] ${base}: ${sections.length} spine page(s) group into ${chapterGroups.length} ` +
        `chapter(s)${grouped ? " using the book's own contents list" : " (one per page)"}; ` +
        `${packaging.length} page group(s) are packaging and are NOT translated ` +
        `(${packagingChars} character(s) of front/back matter).`
    );
    for (const p of packaging) {
      console.log(
        `[source]   packaging: "${p.title}" — ${p.pages} page(s), ${p.bodyChars} char(s) — ${p.reason}`
      );
    }
    // The one case where this rule could cut a real chapter out of the book: a
    // contents list that simply does not mention it. Packaging holding a lot of
    // prose is the tell, so it is reported instead of trusted.
    if (chapterChars > 0 && packagingChars > chapterChars * 0.1) {
      console.warn(
        `[source] ${base}: ${packagingChars} character(s) were classified as packaging — that is ` +
          `${Math.round((packagingChars / chapterChars) * 100)}% of the chapters' text. If any of it ` +
          `is a real chapter the book's contents list is incomplete; check the list above.`
      );
    }
  }

  // Assign ids, then write the per-chapter files (each starts with its title
  // as an H1; a duplicate leading heading in the chapter body is dropped).
  const ids = assignSegmentIds(chapterGroups.map((c) => c.title));
  const segments = [];
  const contents = [];
  for (let i = 0; i < chapterGroups.length; i++) {
    let body = chapterGroups[i].body;
    const title = chapterGroups[i].title;
    const firstLine = body.split("\n", 1)[0] || "";
    if (
      /^#{1,6}\s+/.test(firstLine) &&
      firstLine.replace(/^#{1,6}\s+/, "").trim().toLowerCase() === title.trim().toLowerCase()
    ) {
      body = body.slice(firstLine.length).trim();
    }
    // A section that converted to nothing (an image-only page, a page whose text
    // lives in a structure this converter does not map) is recorded as EMPTY
    // rather than silently becoming a zero-length "chapter" that the translation
    // stage then dutifully skips.
    const empty = body.trim().length < EMPTY_SEGMENT_CHARS;
    if (empty) {
      console.warn(
        `[source] ${base} ${ids[i]} ("${title}"): only ${body.trim().length} character(s) of text ` +
          `after conversion — recorded as an EMPTY chapter (${EMPTY_SEGMENT_CHARS}-char floor).`
      );
    }
    const content = `# ${title}\n\n${body}`.trim() + "\n";
    const file = `${base}-${ids[i]}.md`;
    await fs.writeFile(path.join(volumeDir, file), content, "utf-8");
    segments.push({
      id: ids[i],
      file,
      title,
      chars: content.length,
      bodyChars: body.trim().length,
      empty,
      syntheticTitle: chapterGroups[i].syntheticTitle === true,
    });
    contents.push(content.trim());
  }

  // Whole-volume file (the chapters, in order — each already carries its H1).
  const whole = contents.join("\n\n");
  const wholeFile = `${base}-whole.md`;
  await fs.writeFile(path.join(volumeDir, wholeFile), whole + "\n", "utf-8");

  // Lossless check: the whole-volume file must be the chapters, not a subset of
  // them. A mismatch means the extraction dropped text somewhere. Both sides are
  // measured the same way — headings removed and whitespace removed — because
  // comparing a whitespace-stripped file against whitespace-counting character
  // counts reports a loss that is only the paragraph breaks (observed: every
  // volume of a real series tripped this on a perfectly intact extraction).
  const bodyCharsOf = (text) => text.replace(/^#{1,6}\s+.*$/gm, "").replace(/\s+/g, "").length;
  const wholeBodyChars = bodyCharsOf(whole);
  const chapterBodyChars = contents.reduce((n, c) => n + bodyCharsOf(c), 0);
  if (chapterBodyChars > 0 && wholeBodyChars < chapterBodyChars * 0.98) {
    console.warn(
      `[source] ${base}: LOSSLESS CHECK — the chapters hold ${chapterBodyChars} character(s) but ` +
        `${wholeFile} holds ${wholeBodyChars}: the whole-volume file is missing text.`
    );
  }

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
    // The pages the book's own contents list did not name as chapters (cover,
    // inserted illustrations, the legal notice, the contents page itself, the
    // colophon). Recorded so a re-run and the reports can see exactly what was
    // left out and why — a chapter silently dropped and a cover page silently
    // skipped look identical in the output if nobody writes down the difference.
    packaging,
    images,
    wholeChars: whole.length,
  };
}

/**
 * The chapter title a plain-text source actually declares, if it declares one.
 *
 * The merge used to head every plain-text volume with `path.basename(sourceFile)`
 * — so the published book literally began `# test_story(1).md`: a file name
 * presented to a reader as a chapter title. A title is only printed when the
 * source itself carries one (a leading Markdown heading); otherwise the segment
 * is marked `syntheticTitle` and the merge adds no heading at all.
 *
 * @param {string} originalPath - The plain-text source file.
 * @returns {Promise<{title: string, synthetic: boolean}>} The declared title, or the base name marked synthetic.
 */
async function plainTextTitle(originalPath) {
  const base = path.basename(originalPath).replace(/\.[^.]+$/, "");
  let head = "";
  try {
    const handle = await fs.open(originalPath, "r");
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, 4096, 0);
      head = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return { title: base, synthetic: true };
  }
  for (const line of head.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (m && m[1].trim()) return { title: m[1].trim(), synthetic: false };
    // The first real line is not a heading: the source declares no title.
    break;
  }
  return { title: base, synthetic: true };
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
// Target size for a plain-text part (a "synthetic chapter"). A little above
// TRANSLATE_CHUNK_CHARS so the translation stage rarely re-splits a part, while
// keeping each cumulative-task segment comfortably inside the context window.
const TEXT_PART_TARGET_CHARS = 30000;

/**
 * Split an oversized plain-text source into part files inside the volume folder
 * (the plain-text analogue of an epub's per-chapter files), cached so a re-run
 * does not re-split an unchanged source.
 *
 * The cache is keyed on the source fingerprint and the target size: a re-released
 * / errata-fixed source (or a changed SOURCE_CHUNK target) re-splits. A missing
 * part file forces a re-split too (fail-open).
 *
 * @param {string} originalPath - The staged source file.
 * @param {string} volumeDir - The volume folder (where the parts are written).
 * @param {string} base - The source base name (no extension).
 * @param {number} size - The source file size (bytes).
 * @param {string} fingerprint - sha256 of the source file.
 * @param {boolean} force - Re-split even when a valid cache exists.
 * @returns {Promise<Array<{file: string, chars: number, cacheHit: boolean}>>}
 */
async function materializeTextParts(originalPath, volumeDir, base, size, fingerprint, force) {
  const metaPath = path.join(volumeDir, `${base}-parts.meta.json`);
  let meta = null;
  if (!force) {
    try {
      meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    } catch {
      meta = null;
    }
  }
  // Every part file must still be on disk. `fileExists` is async, so a bare
  // `.every(p => fileExists(...))` is always truthy (a pending promise is
  // truthy) — a deleted part file used to be accepted as a cache hit and the
  // bundle then pointed at files that were not there.
  const partsOnDisk =
    Array.isArray(meta?.parts) &&
    meta.parts.length > 0 &&
    meta.parts.every((p) => typeof p.file === "string");
  const allPartsExist =
    partsOnDisk &&
    (await Promise.all(meta.parts.map((p) => fileExists(path.join(volumeDir, p.file))))).every(Boolean);
  const validCache =
    meta &&
    meta.fingerprint === fingerprint &&
    meta.targetChars === TEXT_PART_TARGET_CHARS &&
    partsOnDisk &&
    allPartsExist;
  if (validCache) {
    return meta.parts.map((p) => ({ file: p.file, chars: p.chars || 0, cacheHit: true }));
  }
  const text = await fs.readFile(originalPath, "utf8");
  const segments = splitPlainTextSegments(text, TEXT_PART_TARGET_CHARS);
  const parts = [];
  for (let i = 0; i < segments.length; i += 1) {
    const file = `${base}-part-${String(i + 1).padStart(2, "0")}.md`;
    await fs.writeFile(path.join(volumeDir, file), segments[i], "utf8");
    parts.push({ file, chars: segments[i].length });
  }
  // Remove stale part files from a previous (different) split so they are not
  // mistaken for the current ones on a later run.
  const escBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = await fs.readdir(volumeDir);
  for (const name of existing) {
    if (new RegExp(`^${escBase}-part-\\d+\\.md$`).test(name) && !parts.some((p) => p.file === name)) {
      await fs.rm(path.join(volumeDir, name), { force: true });
    }
  }
  await fs.writeFile(metaPath, JSON.stringify({ schema: 1, fingerprint, targetChars: TEXT_PART_TARGET_CHARS, parts }, null, 2), "utf8");
  return parts.map((p) => ({ ...p, cacheHit: false }));
}

async function resolveSourceBundle({ seriesDir, volume, volumeDir, force = false }) {
  const originalPath = path.resolve(seriesDir, volume.sourceFile);
  if (!(await fileExists(originalPath))) {
    // STRUCTURAL: the manifest's plan of record points at a book that is no
    // there (a deleted file, a moved folder, a disk failure). No run policy may
    // skip past it — every artifact built after this point would be built on a
    // missing book.
    throw structuralError(
      `Required source file not found: ${originalPath} (volume ${volume.installmentNumber}, ` +
        `listed in the plan of record as "${volume.sourceFile}"). ` +
        `The file is gone or the folder moved — restore it, or re-run "npx gulp discover --force" ` +
        `to re-plan the series.`
    );
  }
  const base = path.basename(originalPath).replace(/\.[^.]+$/, "");

  if (!isEpubPath(originalPath)) {
    const st = await fs.stat(originalPath);
    const fingerprint = await sha256OfFile(originalPath);
    // An oversized plain-text source (bigger than the whole-installment
    // threshold) is split into part files in the volume folder so the
    // chapter-by-chapter fallback can process it, exactly like a big epub.
    // A small source stays a single "whole" segment, as before.
    if (st.size > 0 && st.size > chunkThresholdChars()) {
      const parts = await materializeTextParts(originalPath, volumeDir, base, st.size, fingerprint, force);
      return {
        format: "text",
        originalPath,
        base,
        volumeDir,
        wholePath: originalPath,
        segments: parts.map((p, i) => ({
          id: `part-${String(i + 1).padStart(2, "0")}`,
          file: p.file,
          // A pipeline-made slice of an oversized text file is not a chapter of
          // the book: the label exists so the stage can name its outputs, and
          // `syntheticTitle` stops the merge from printing it as a heading.
          title: `Part ${i + 1} of ${parts.length}`,
          syntheticTitle: true,
          chars: p.chars,
        })),
        imagesDir: null,
        wholeChars: st.size,
        cacheHit: parts.every((p) => p.cacheHit),
        sourceFingerprint: fingerprint,
      };
    }
    const declared = await plainTextTitle(originalPath);
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
          title: declared.title,
          // True when the "title" is only the file name — the merge must not
          // print it as a chapter heading in the published book.
          syntheticTitle: declared.synthetic,
          chars: st.size,
          bodyChars: st.size,
          empty: st.size < EMPTY_SEGMENT_CHARS,
        },
      ],
      imagesDir: null,
      wholeChars: st.size,
      cacheHit: false,
      // Content hash of the source file — the artifact skip-checks compare it
      // against the fingerprint persisted in the last run's rolling state so
      // a re-released / errata-fixed source invalidates the stale artifacts
      // (see isSourceStale in configs/shared.js).
      sourceFingerprint: fingerprint,
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
      // Caches written under an older extraction schema (see
      // BUNDLE_SCHEMA_VERSION) are re-extracted so the files on disk match
      // the current one.
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
          : `schema ${cached.schema === undefined ? "1 (pre-versioning)" : cached.schema} → ${BUNDLE_SCHEMA_VERSION} ` +
            `(chapters now come from the book's own contents list, not one per spine page)`;
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
      // Carried through so "this chapter is empty IN THE SOURCE" is visible in
      // the translation stage and the handoff, not only in the cache file.
      bodyChars: s.bodyChars,
      empty: s.empty,
      // True when the extraction could not give this chapter a real title (the
      // book's contents did not name it and it prints no heading of its own) —
      // the merge then prints no heading rather than inventing one.
      syntheticTitle: s.syntheticTitle === true,
      path: path.join(volumeDir, s.file),
    })),
    packaging: meta.packaging || null,
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
  plainTextTitle,
  EMPTY_SEGMENT_CHARS,

  DEFAULT_CHUNK_THRESHOLD_CHARS,
  BUNDLE_SCHEMA_VERSION,
  chunkThresholdChars,
  shouldProcessChunked,
  splitPlainTextSegments,
  materializeTextParts,
  classifyTitle,
  assignSegmentIds,
  stripHrefFragment,
  groupSpineIntoChapters,
  classifyNavEntry,
  classifySectionGroup,
  titleOfUnnamedSection,
  textCharsOf,
  stripRepeatedHeading,
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


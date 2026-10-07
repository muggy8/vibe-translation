/**
 * Turning a book's packaging into chapters, and naming them honestly.
 *
 * A page the book's own contents list NAMES opens a section; every unnamed page after
 * it joins it (which also re-joins a long chapter the packager split across two
 * files). A named page is packaging when the book says so — an epub:type of
 * cover/toc/colophon, a title that names packaging, or a landmarks-only pointer
 * ("the main text starts here", which is not a chapter). An unnamed page never joins
 * PACKAGING, because a real story sitting between the contents page and the first
 * chapter's title page must not become the cover's fine print.
 *
 * Length is only the tie-breaker for a page that declares nothing: a 568-character
 * copyright notice and a 586-character opening scene are the same size, so the
 * discriminator is what the page DECLARES itself to be. A file name is never used as
 * a chapter title — it ends up in chapters.json and every report, and reads like a
 * chapter the book has.
 *
 * Part of the source.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions

const { UNDECLARED_SECTION_MIN_CHARS } = require("./config");

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


module.exports = {
  classifyTitle,
  assignSegmentIds,
  PACKAGING_CLASS_RE,
  textCharsOf,
  PACKAGING_EPUB_TYPES,
  PACKAGING_TITLE_RE,
  classifyNavEntry,
  groupSpineIntoChapters,
  classifySectionGroup,
  titleOfUnnamedSection,
  stripRepeatedHeading,
};

/**
 * The extraction itself: open the book, group its spine into the chapters the book
 * claims, convert them, and write the bundle (whole-installment file, per-chapter
 * files, images, cache).
 *
 * Extraction HONESTY is the point of this module. It logs the spine accounting (how
 * many items it was offered, how many it could read, and WHICH it skipped), logs the
 * packaging it skipped and why, warns when the contents list omitted a section that
 * holds real text, warns when the packaging it skipped is more than 10% of the
 * chapters' text (the tell that a real chapter was cut), flags every segment with its
 * body length and an `empty` mark, and warns when the per-chapter files and the
 * whole-installment file disagree in length. A chapter that is empty IN THE SOURCE is
 * a hole in the BOOK, and it is reported here instead of surfacing later as a
 * mysterious translation failure.
 *
 * The function below is the order those steps happen in. Each step is one function,
 * because each one has its own honesty rule and its own reason to be believed.
 *
 * Part of the source.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");
const cheerio = require("cheerio");
const tokens = require("../tokens");
const { scriptMixOf } = tokens;
require("../../types"); // JSDoc type definitions

const { BUNDLE_SCHEMA_VERSION, EMPTY_SEGMENT_CHARS } = require("./config");
const { PACKAGING_CLASS_RE, PACKAGING_TITLE_RE, assignSegmentIds, classifySectionGroup, groupSpineIntoChapters, stripRepeatedHeading, textCharsOf, titleOfUnnamedSection } = require("./chapters");
const { firstHeadingText, normalizeSpaces, xhtmlToMarkdown } = require("./html");
const { normalizeZipPath, openEpub } = require("./epub");
const { ImageRegistry } = require("./images");

/**
 * @typedef {Object} ReadSection - One readable page of the archive, converted to Markdown.
 * @property {string} zipPath
 * @property {string} title - The nav name, else the page's own heading, else its <title>, else a placeholder.
 * @property {string} heading - The page's OWN heading, kept separate from the fallback chain.
 * @property {string} bodyClass
 * @property {boolean} declaresPackaging - The page declaring what it IS (cover plate, contents, notice, colophon).
 * @property {number} textChars - Characters of story text (Markdown markup excluded).
 * @property {boolean} declaredInNav - Whether the book's contents list named this page.
 * @property {string} md
 */

/**
 * @typedef {Object} ChapterGroup - A group the classifier accepted as a section of the book.
 * @property {string} title
 * @property {string} body
 * @property {boolean} syntheticTitle - True when the title is ours rather than the book's.
 */

/**
 * @typedef {Object} PackagingGroup - A page group the classifier kept out of the translation.
 * @property {string} title
 * @property {string} reason
 * @property {number} pages
 * @property {number} bodyChars
 * @property {number} textChars
 */

/**
 * Convert every readable section, in spine/reading order.
 *
 * Sections are NOT chapters yet: the grouping pass decides that.
 *
 * @param {Object} opened - What openEpub returned.
 * @param {import("./images").ImageRegistry} registry
 * @returns {Promise<ReadSection[]>}
 * @throws {Error} When the spine holds no readable text at all.
 */
async function readSections(opened, registry) {
  const { zip, manifestItems, textItems, titles: navTitles } = opened;
  /** Resolve an <img src> against the page that holds it, and register the image. */
  const chapterImageRef = (chapterZipPath) => (src) =>
    registry.reference(normalizeZipPath(path.posix.join(path.posix.dirname(chapterZipPath), src)));

  const sections = [];
  for (const item of textItems) {
    const zipPath = item.zipPath;
    const html = await zip.file(zipPath).async("string");
    const $ = cheerio.load(html);
    // The page's OWN heading, kept separate from the fallback chain: a group the contents list did
    // not name is titled from this, not from the page's <title>, which in this template is the
    // series title on every single page.
    const heading = firstHeadingText($);
    const pageTitle = normalizeSpaces($.root().find("title").first().text());
    const bodyClass = normalizeSpaces($("body").attr("class") || "");
    // The page declaring what it IS — a cover plate, the contents page, the legal notice, the
    // colophon. This is the book's own wording, not a guess about length: it is what separates a
    // 568-character copyright notice from the 586-character opening scene the contents list forgot
    // to mention.
    const declaresPackaging = PACKAGING_CLASS_RE.test(bodyClass) || PACKAGING_TITLE_RE.test(pageTitle);
    const title = navTitles.get(zipPath) || heading || pageTitle || `Section ${sections.length + 1}`;
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
  return sections;
}

/**
 * Spine accounting: a book whose declared reading order has 42 items but only 38 readable sections
 * had 4 items dropped (a cover, a CSS file, a nav page, an image-only page). That is usually
 * correct — but it is the number that tells you a chapter went missing, so it is printed, not
 * assumed.
 *
 * @param {string} base - The source base name, for the log line.
 * @param {Object} opened - What openEpub returned.
 * @param {ReadSection[]} sections
 * @returns {void}
 */
function reportSpineAccounting(base, opened, sections) {
  const skippedFromSpine = opened.spine.length - sections.length;
  console.log(
    `[source] ${base}: spine lists ${opened.spine.length} item(s), ${sections.length} readable ` +
      `section(s), ${opened.entryCount} file(s) in the archive` +
      (skippedFromSpine > 0 ? ` — ${skippedFromSpine} non-text item(s) skipped.` : ".")
  );
  if (skippedFromSpine <= 0) return;
  const skipped = opened.spine
    .filter((it) => !/\.x?html?$/i.test(it.href || ""))
    .map((it) => `${it.id || "?"} (${it.mediaType || "unknown"})`);
  if (skipped.length > 0) console.log(`[source]   skipped: ${skipped.join(", ")}`);
}

/**
 * Sections → chapters, using the book's own contents list.
 *
 * A spine item is a PAGE, not a chapter. Treating one as the other is what turned a 10-chapter book
 * into 35 "chapters" (see groupSpineIntoChapters). When the book's nav names none of its pages there
 * is nothing to group by, so each page stands alone — the pre-grouping behaviour, and it is reported
 * loudly by the caller because the chapter count the rest of the pipeline uses is then a guess.
 *
 * @param {string} base - The source base name, for the warnings.
 * @param {ReadSection[]} sections
 * @param {Object[]} navEntries - The book's contents list.
 * @returns {{grouped: Object[]|null, groups: Object[], chapterGroups: ChapterGroup[], packaging: PackagingGroup[]}}
 */
function groupSectionsIntoChapters(base, sections, navEntries) {
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

  /** @type {ChapterGroup[]} */
  const chapterGroups = [];
  /** @type {PackagingGroup[]} */
  const packaging = [];

  for (const group of groups) {
    const pages = group.indices.map((i) => sections[i]);
    const body = pages
      .map((s) => stripRepeatedHeading(s.md, group.title || s.title))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    // The decision is made on characters of STORY text: Markdown image markup is not text (five
    // illustration pages carry 33 characters of markup each, and counting them turns a run of plates
    // into a "section worth translating"), and a page that declares itself a notice / colophon /
    // cover plate does not count towards "this group is a section of the book".
    const storyTextChars = pages.reduce((n, s) => n + (s.declaresPackaging ? 0 : s.textChars), 0);
    const verdict = classifySectionGroup(group, storyTextChars);

    if (!verdict.chapter) {
      packaging.push({
        title: group.title || path.posix.basename(group.zipPath || ""),
        reason: verdict.reason,
        pages: group.indices.length,
        bodyChars: body.length,
        textChars: storyTextChars,
      });
      continue;
    }

    // A chapter the contents list named carries that name. One it did not name is titled from the
    // heading the page itself prints, and left untitled (synthetic) when it prints none.
    const unnamed = !group.declared;
    const own = unnamed
      ? group.kind === "single"
        ? { title: pages[0].title, synthetic: !pages[0].heading }
        : titleOfUnnamedSection(pages.map((s) => s.heading).filter(Boolean), body)
      : { title: group.title, synthetic: false };
    // A section with no name of its own gets a readable placeholder, NOT its file name: this title
    // ends up in chapters.json and every report, and "p-001.xhtml" there reads like a chapter the
    // book actually has (observed on volumes 8 and 11 of the real series).
    const title = own.title || `Untitled section ${chapterGroups.length + 1}`;
    if (unnamed && group.kind !== "single") {
      console.warn(
        `[source] ${base}: "${title}" is NOT named in the book's contents but holds ${storyTextChars} ` +
          `character(s) of story text on ${pages.length} page(s) — kept as a chapter. ` +
          `The book's contents list is incomplete; check it against the packaging list below.`
      );
    }
    chapterGroups.push({ title, body, syntheticTitle: own.synthetic });
  }

  return { grouped, groups, chapterGroups, packaging };
}

/**
 * Report what the grouping decided, and run the two fail-open cases — both reported loudly because
 * the chapter count the rest of the pipeline uses is then a guess:
 *   (a) the nav names none of the readable pages → nothing to group BY, so every page stands alone
 *       (the pre-grouping behaviour);
 *   (b) the nav names pages but every one of them is packaging → the book cannot be zero chapters,
 *       so the same fallback runs.
 *
 * @param {string} base
 * @param {{grouped: Object[]|null, groups: Object[], sections: ReadSection[], chapterGroups: ChapterGroup[], packaging: PackagingGroup[]}} state
 * @returns {void}
 */
function reportGrouping(base, { grouped, groups, sections, chapterGroups, packaging }) {
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
    return;
  }

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
  // The one case where this rule could cut a real chapter out of the book: a contents list that
  // simply does not mention it. Packaging holding a lot of prose is the tell, so it is reported
  // instead of trusted.
  if (chapterChars > 0 && packagingChars > chapterChars * 0.1) {
    console.warn(
      `[source] ${base}: ${packagingChars} character(s) were classified as packaging — that is ` +
        `${Math.round((packagingChars / chapterChars) * 100)}% of the chapters' text. If any of it ` +
        `is a real chapter the book's contents list is incomplete; check the list above.`
    );
  }
}

/**
 * Assign ids and write the per-chapter files (each starts with its title as an H1; a duplicate
 * leading heading in the chapter body is dropped).
 *
 * @param {string} base
 * @param {string} volumeDir
 * @param {ChapterGroup[]} chapterGroups
 * @returns {Promise<{segments: Object[], contents: string[]}>}
 */
async function writeChapterFiles(base, volumeDir, chapterGroups) {
  const ids = assignSegmentIds(chapterGroups.map((c) => c.title));
  /** @type {Object[]} */
  const segments = [];
  /** @type {string[]} */
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
    // A section that converted to nothing (an image-only page, a page whose text lives in a
    // structure this converter does not map) is recorded as EMPTY rather than silently becoming a
    // zero-length "chapter" that the translation stage then dutifully skips.
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
      // The chapter's script mix — the text's own half of the token estimate. Stored instead of the
      // token count itself so the same cached extraction can be re-estimated against a different
      // model (see utils/tokens.js).
      scriptMix: scriptMixOf(content),
      bodyChars: body.trim().length,
      empty,
      syntheticTitle: chapterGroups[i].syntheticTitle === true,
    });
    contents.push(content.trim());
  }

  return { segments, contents };
}

/**
 * Write the whole-installment file (the chapters, in order — each already carries its H1) and run the
 * lossless check.
 *
 * The check compares the two sides the same way — headings removed and whitespace removed — because
 * comparing a whitespace-stripped file against whitespace-counting character counts reports a loss
 * that is only the paragraph breaks (observed: every volume of a real series tripped this on a
 * perfectly intact extraction).
 *
 * @param {string} base
 * @param {string} volumeDir
 * @param {string[]} contents
 * @returns {Promise<{whole: string, wholeFile: string}>}
 */
async function writeWholeInstallment(base, volumeDir, contents) {
  const whole = contents.join("\n\n");
  const wholeFile = `${base}-whole.md`;
  await fs.writeFile(path.join(volumeDir, wholeFile), whole + "\n", "utf-8");

  const bodyCharsOf = (text) => text.replace(/^#{1,6}\s+.*$/gm, "").replace(/\s+/g, "").length;
  const wholeBodyChars = bodyCharsOf(whole);
  const chapterBodyChars = contents.reduce((n, c) => n + bodyCharsOf(c), 0);
  if (chapterBodyChars > 0 && wholeBodyChars < chapterBodyChars * 0.98) {
    console.warn(
      `[source] ${base}: LOSSLESS CHECK — the chapters hold ${chapterBodyChars} character(s) but ` +
        `${wholeFile} holds ${wholeBodyChars}: the whole-volume file is missing text.`
    );
  }
  return { whole, wholeFile };
}

/**
 * Collect the images: everything referenced from the chapters (already registered while converting)
 * plus every image declared in the OPF manifest (covers, plates, …), so the folder holds ALL
 * embedded images.
 *
 * @param {{opfDir: string, manifestItems: Object[]}} opened
 * @param {import("./images").ImageRegistry} registry
 * @returns {Promise<string[]>}
 */
async function collectImages({ opfDir, manifestItems }, registry) {
  for (const item of manifestItems) {
    if ((item.mediaType || "").startsWith("image/")) {
      registry.reference(normalizeZipPath(path.posix.join(opfDir, item.href)));
    }
  }
  return (await registry.flush()) || [];
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
  // One shared container read (openEpub) — the same helper the intake agent's epub tools use, so
  // "what a valid epub is" lives in exactly one place.
  const opened = await openEpub(epubPath);
  const registry = new ImageRegistry(opened.zip, volumeDir);

  const sections = await readSections(opened, registry);
  if (sections.length === 0) {
    throw new Error(`No readable text chapters found in the spine of ${epubPath}.`);
  }
  reportSpineAccounting(base, opened, sections);

  const { grouped, groups, chapterGroups, packaging } = groupSectionsIntoChapters(
    base,
    sections,
    opened.navEntries
  );
  reportGrouping(base, { grouped, groups, sections, chapterGroups, packaging });

  const { segments, contents } = await writeChapterFiles(base, volumeDir, chapterGroups);
  const { whole, wholeFile } = await writeWholeInstallment(base, volumeDir, contents);
  const images = await collectImages(opened, registry);

  return {
    format: "epub",
    schema: BUNDLE_SCHEMA_VERSION,
    base,
    wholeFile,
    segments,
    // The pages the book's own contents list did not name as chapters (cover, inserted
    // illustrations, the legal notice, the contents page itself, the colophon). Recorded so a re-run
    // and the reports can see exactly what was left out and why — a chapter silently dropped and a
    // cover page silently skipped look identical in the output if nobody writes down the difference.
    packaging,
    images,
    wholeChars: whole.length,
    // The whole-installment script mix (see the per-segment note above).
    scriptMix: scriptMixOf(whole),
  };
}

module.exports = {
  extractEpubToBundle,
};

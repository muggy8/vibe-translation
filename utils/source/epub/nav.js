/**
 * utils/source/epub/nav.js — the book's own table of contents.
 *
 * Two views of the same document come back, because two different jobs need it: `titles` is a
 * lookup table for sampling one section on its own, and `entries` is the same pairs IN DOCUMENT
 * ORDER, which is what groupSpineIntoChapters() uses to tell a chapter apart from an inserted
 * illustration page.
 */

const path = require("path");
const cheerio = require("cheerio");

const { normalizeSpaces } = require("../html");
const { normalizeZipPath } = require("./basics");

/**
 * Read the book's own table of contents (EPUB3 nav, then EPUB2 NCX).
 *
 * @param {Object} zip - The loaded archive.
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

module.exports = { loadNavStructure, stripHrefFragment };

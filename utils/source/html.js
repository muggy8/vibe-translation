/**
 * Converting the book's XHTML into text.
 *
 * xhtmlToMarkdown is the pipeline's converter; htmlToPlainText is the one the intake
 * agent judges books by, and it must be paragraph-preserving: a real chapter is ONE
 * wrapping div around many <p>, so walking only the top-level children glued every
 * paragraph into a single run-on line (gotcha 35).
 *
 * Part of the source.js layer (split out of the original single file).
 */

const cheerio = require("cheerio");
require("../../types"); // JSDoc type definitions

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


module.exports = {
  xhtmlToMarkdown,
  normalizeSpaces,
  renderBlock,
  renderContainer,
  inlineText,
  firstHeadingText,
  PLAIN_TEXT_BLOCK_TAGS,
  inlineTextOf,
  collectTextPieces,
  htmlToPlainText,
};

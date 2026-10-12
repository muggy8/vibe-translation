/**
 * Converting the book's XHTML into text.
 *
 * xhtmlToMarkdown is the pipeline's converter; htmlToPlainText is the one the intake
 * agent judges books by, and it must be paragraph-preserving: a real chapter is ONE
 * wrapping div around many <p>, so walking only the top-level children glued every
 * paragraph into a single run-on line (gotcha 35).
 *
 * THE PRONUNCIATION GUIDE IS NOT PART OF THE WORD. A Japanese book marks how a word is
 * read with a guide nested inside the word's own markup:
 *
 *     <ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>                    the book says 蒲田, read Kamata
 *     <ruby>上<rt>じよう</rt>機<rt>き</rt>嫌<rt>げん</rt></ruby>   the book says 上機嫌
 *
 * Treating <ruby> as an ordinary container kept everything inside it in order, so the
 * extracted text read 蒲かま田た and 上じよう機き嫌げん: the word and its own pronunciation
 * guide became one string. Measured across the 17 archives of the live series that is
 * 45,497 annotations and 146,352 characters pasted into the running text — 5.6% of the
 * series' text, 11.25% of volume 8 — and 74 of the 561 rows the series' final cumulative
 * glossary publishes hold a split string of exactly this shape (虹パ彩ン寺ジ菫ー for
 * 虹彩寺菫, 大ガ千ー本ベ槍ラ for 大千本槍).
 * So a <ruby> renders as its BASE TEXT ONLY, in place: 蒲田, 上機嫌, 三色院菫子. Not
 * dropped, not marked inline, not footnoted — the word alone.
 *
 * The guide is not dropped silently: both converters hand every guide they set aside to
 * their `onRubyGuide` callback, and `utils/source/ruby-guides.js` harvests what those
 * callbacks receive. The harvest is produced BY the removal, so it cannot drift from it.
 *
 * AND IT IS HARVESTED AS IT WAS ANNOTATED. Each guide also carries its own sequence — 蒲 carrying かま,
 * then 田 carrying た — because the joined pair alone cannot answer which character carried which
 * reading, and without that answer nothing can rebuild the string the old converter produced
 * (蒲かま田た) in order to look for it. `pushRubyUnit` is the one pairing rule both converters use.
 *
 * BOTH CONVERTERS, OR NOTHING. `xhtmlToMarkdown` builds the text the stages read and
 * `htmlToPlainText` builds the size the intake reports a book by; if they disagree, the
 * intake is measuring one book and the pipeline is reading another — the class of bug
 * gotcha 119 records. The ruby rule is therefore stated once (RUBY_GUIDE_TAGS, and one
 * base/guide split each side applies) and `test/test-source-ruby.js` pins that the two
 * converters set aside the same guides from the same document.
 *
 * Part of the source.js layer (split out of the original single file).
 */

const cheerio = require("cheerio");
require("../../types"); // JSDoc type definitions

/**
 * The tags that hold a pronunciation guide INSIDE a <ruby>: <rt> is the guide itself,
 * <rtc> groups guides, <rp> is the bracket punctuation a browser shows when it cannot
 * render ruby at all. None of them is part of the word.
 *
 * The base side (<rb>, <rbc>) and the ruby's own text nodes ARE the word.
 *
 * @type {Set<string>}
 */
const RUBY_GUIDE_TAGS = new Set(["rt", "rtc", "rp"]);

/**
 * Collapse whitespace runs (including newlines) to single spaces.
 *
 * @param {string|null} text
 * @returns {string}
 */
function normalizeSpaces(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

/**
 * Open one annotation unit in the sequence: the base the book printed, and the guide that sat on it.
 *
 * THE SEQUENCE IS THE POINT. `<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>` annotates 蒲 with かま and 田
 * with た, and the defect this layer fixed interleaved them exactly that way (蒲かま田た). A row that
 * only says 蒲田 / かまた cannot answer "which character carried which guide", so nothing downstream
 * can rebuild the broken string to look for. `utils/source/plan/01-extraction-step.md` §3 names that
 * as the reason the guide-split tripwire was deferred, and this pairing is what un-defers it.
 *
 * Pairing is by DOCUMENT ORDER, which is the order the old converter kept: a guide belongs to the base
 * text that precedes it. A guide with no base of its own (<ruby>蒲<rt>かま</rt><rt>た</rt></ruby>) is a
 * second reading on the base already open, so it joins that unit rather than opening an empty one.
 * Base left over after the last guide (<ruby>蒲<rt>かま</rt>田</ruby>) is a unit with no reading — the
 * book annotated part of the word and left the rest alone.
 *
 * MUTATED by design: both converters build the same units through this one function, so the pairing
 * rule cannot drift between them (the same reason RUBY_GUIDE_TAGS is one constant).
 *
 * @param {RubyGuideAnnotation[]} units - The units found so far, in document order.
 * @param {string} pendingBase - Base text accumulated since the previous guide.
 * @param {string} guideText - The guide that follows it.
 * @returns {void}
 */
function pushRubyUnit(units, pendingBase, guideText) {
  const base = normalizeSpaces(pendingBase);
  const reading = normalizeSpaces(guideText);
  if (!base && units.length > 0) {
    units[units.length - 1].reading = normalizeSpaces(units[units.length - 1].reading + reading);
    return;
  }
  units.push({ base, reading });
}

/**
 * Close the sequence: base text the ruby printed after its last guide, which carries no guide of its own.
 *
 * @param {RubyGuideAnnotation[]} units - The units found so far, in document order.
 * @param {string} pendingBase - Base text left over after the last guide.
 * @returns {void}
 */
function closeRubyUnits(units, pendingBase) {
  const base = normalizeSpaces(pendingBase);
  if (base) units.push({ base, reading: "" });
}

/**
 * Split one <ruby> element into the word the book prints, the reading the author wrote, and the
 * sequence the annotation was made in.
 *
 * Base text is the ruby's own text nodes plus every non-guide child (a <rb>/<rbc> ruby base,
 * or a <span> the packager wrapped around part of the word). Guide text is every <rt>/<rtc>/<rp>
 * subtree, concatenated in document order — which is how the book intends it: 蒲 + かま,
 * 田 + た is the word 蒲田 read かまた, not two unrelated annotations sitting beside each other.
 *
 * @param {import("cheerio").CheerioAPI} $ - The cheerio API for this document.
 * @param {import("cheerio").Cheerio<Element>} rubyEl - One <ruby> element.
 * @returns {RubyGuide} The word, the reading, how many guide parts carried it, and the annotation sequence.
 */
function splitRuby($, rubyEl) {
  let base = "";
  let reading = "";
  let annotations = 0;
  let pending = "";
  /** @type {RubyGuideAnnotation[]} */
  const annotated = [];
  rubyEl.contents().each((i, node) => {
    if (node.type === "text") {
      base += node.data || "";
      pending += node.data || "";
      return;
    }
    if (node.type !== "tag") return;
    const tag = (node.name || "").toLowerCase();
    if (RUBY_GUIDE_TAGS.has(tag)) {
      const guideText = $(node).text() || "";
      reading += guideText;
      annotations += 1;
      pushRubyUnit(annotated, pending, guideText);
      pending = "";
      return;
    }
    const own = $(node).text() || "";
    base += own;
    pending += own;
  });
  closeRubyUnits(annotated, pending);
  return { base: normalizeSpaces(base), reading: normalizeSpaces(reading), annotations, annotated };
}

/**
 * Render one <ruby> as the word alone, and report the guide that was set aside.
 *
 * This is the whole ruby rule for the Markdown side. It recurses through the ruby's own
 * children rather than the generic container path precisely so a guide can never be
 * reached as an ordinary inline element.
 *
 * @param {import("cheerio").CheerioAPI} $ - The cheerio API for this document.
 * @param {import("cheerio").Cheerio<Element>} rubyEl - One <ruby> element.
 * @param {(src: string) => string} imageRef
 * @param {(guide: RubyGuide) => void} [onRubyGuide] - Receives every guide this render removes.
 * @returns {string} The base text (possibly empty for a malformed ruby).
 */
function renderRuby($, rubyEl, imageRef, onRubyGuide) {
  const guide = splitRuby($, rubyEl);
  if (onRubyGuide && (guide.base || guide.reading)) onRubyGuide(guide);
  // A ruby whose base is empty is malformed markup; its guide is then the only text the
  // page carries, and dropping it silently would lose a word. Keep it in the text.
  return guide.base || guide.reading;
}

/**
 * Text of an element with every pronunciation guide taken out, WITHOUT harvesting it.
 *
 * Used for the page's own heading: the heading is compared against the chapter title the
 * contents list gave it (stripRepeatedHeading), and a title that kept its guides while the
 * body dropped them would never match, so the chapter file would print its heading twice.
 * The harvest comes from the conversion itself, so this must not report a second copy.
 *
 * @param {import("cheerio").CheerioAPI} $ - The cheerio API for this document.
 * @param {import("cheerio").Cheerio<Element>} el
 * @returns {string}
 */
function textWithoutGuides($, el) {
  let out = "";
  el.contents().each((i, node) => {
    if (node.type === "text") {
      out += node.data || "";
      return;
    }
    if (node.type !== "tag") return;
    if (RUBY_GUIDE_TAGS.has((node.name || "").toLowerCase())) return;
    out += textWithoutGuides($, $(node));
  });
  return out;
}

/**
 * Convert an XHTML document (one epub chapter) to Markdown.
 *
 * Block mapping: h1–h6 → `#`…, p → paragraph, blockquote → `> `, ul/ol →
 * lists, pre → fenced code, table → ` | `-separated rows, hr → `---`.
 * Inline mapping: em → `*…*`, b/strong → `**…**`, del/s → `~~…~~`, a → its
 * text, br → line break, img → `imageRef(src)`, ruby → its word alone.
 * All other tags render as their text. Whitespace runs collapse to single
 * spaces (safe for Japanese text, which carries no spaces).
 *
 * @param {string} html - The XHTML content of one chapter.
 * @param {(src: string) => string} imageRef - Maps a raw <img src> to a
 *   Markdown image reference (the caller registers the image).
 * @param {(guide: RubyGuide) => void} [onRubyGuide] - Called once for every pronunciation
 *   guide this conversion sets aside (the harvest: utils/source/ruby-guides.js).
 * @returns {string} The Markdown text (trimmed).
 */
function xhtmlToMarkdown(html, imageRef, onRubyGuide) {
  const $ = cheerio.load(typeof html === "string" ? html : "");
  $("script, style, head, title").remove();
  const root = $("body").length ? $("body") : $.root();
  const out = [];
  root.contents().each((i, node) => {
    const piece =
      node.type === "text" ? normalizeSpaces(node.data) : renderBlock($, $(node), imageRef, onRubyGuide);
    if (piece) out.push(piece);
  });
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Render one block-level element to Markdown.
 *
 * @param {import("cheerio").CheerioAPI} $ - The cheerio API for this document.
 * @param {import("cheerio").Cheerio<Element>} el
 * @param {(src: string) => string} imageRef
 * @param {(guide: RubyGuide) => void} [onRubyGuide]
 * @returns {string}
 */
function renderBlock($, el, imageRef, onRubyGuide) {
  const node = el.get(0);
  if (!node || node.type === "text") return normalizeSpaces(el.text());
  const tag = (node.tagName || "").toLowerCase();
  const heading = tag.match(/^h([1-6])$/);
  if (heading) {
    const text = inlineText($, el, imageRef, onRubyGuide);
    return text ? `${"#".repeat(parseInt(heading[1], 10))} ${text}` : "";
  }
  switch (tag) {
    case "p":
    case "figure":
      return inlineText($, el, imageRef, onRubyGuide);
    case "br":
      return "";
    case "hr":
      return "---";
    case "blockquote": {
      const inner = renderContainer($, el, imageRef, onRubyGuide);
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
        const t = inlineText($, $(li), imageRef, onRubyGuide);
        if (t) items.push(`${tag === "ol" ? `${i + 1}. ` : "- "}${t}`);
      });
      return items.join("\n");
    }
    case "table": {
      const rows = [];
      el.find("tr").each((i, tr) => {
        const cells = [];
        $(tr).find("> td, > th").each((j, c) => {
          const t = inlineText($, $(c), imageRef, onRubyGuide);
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
    // ruby is NOT a container: its guides are the one thing inside it that is not the text.
    case "ruby":
      return renderRuby($, el, imageRef, onRubyGuide);
    case "div":
    case "section":
    case "article":
    case "main":
    case "header":
    case "footer":
    case "center":
    case "span":
    case "font":
      return renderContainer($, el, imageRef, onRubyGuide);
    default:
      return el.children().length > 0
        ? renderContainer($, el, imageRef, onRubyGuide)
        : inlineText($, el, imageRef, onRubyGuide);
  }
}

/**
 * Render the children of a container element (recursing into blocks).
 *
 * @param {import("cheerio").CheerioAPI} $ - The cheerio API for this document.
 * @param {import("cheerio").Cheerio<Element>} el
 * @param {(src: string) => string} imageRef
 * @param {(guide: RubyGuide) => void} [onRubyGuide]
 * @returns {string}
 */
function renderContainer($, el, imageRef, onRubyGuide) {
  const out = [];
  el.contents().each((i, node) => {
    const piece =
      node.type === "text" ? normalizeSpaces(node.data) : renderBlock($, $(node), imageRef, onRubyGuide);
    if (piece) out.push(piece);
  });
  return out.join("\n\n");
}

/**
 * Render inline content of an element to Markdown text. <br> becomes a real
 * line break; ruby contributes its word only; all other whitespace collapses
 * to single spaces.
 *
 * @param {import("cheerio").CheerioAPI} $ - The cheerio API for this document.
 * @param {import("cheerio").Cheerio<Element>} el
 * @param {(src: string) => string} imageRef
 * @param {(guide: RubyGuide) => void} [onRubyGuide]
 * @returns {string}
 */
function inlineText($, el, imageRef, onRubyGuide) {
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
        const t = inlineText($, n, imageRef, onRubyGuide);
        out += t.trim() ? `*${t}*` : t;
        break;
      }
      case "strong":
      case "b": {
        const t = inlineText($, n, imageRef, onRubyGuide);
        out += t.trim() ? `**${t}**` : t;
        break;
      }
      case "del":
      case "s": {
        const t = inlineText($, n, imageRef, onRubyGuide);
        out += t.trim() ? `~~${t}~~` : t;
        break;
      }
      case "ruby":
        out += renderRuby($, n, imageRef, onRubyGuide);
        break;
      default:
        out += inlineText($, n, imageRef, onRubyGuide);
        break;
    }
  });
  return out.replace(/\s+/g, " ").replace(new RegExp(BR, "g"), "\n").trim();
}

/**
 * The text of the first heading (h1–h6) in the document, if any — with every
 * pronunciation guide taken out, so a heading matches the body the converter produced.
 *
 * @param {import("cheerio").CheerioAPI} $
 * @returns {string}
 */
function firstHeadingText($) {
  for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
    const h = $(tag).first();
    if (h.length) {
      const t = normalizeSpaces(textWithoutGuides($, h));
      if (t) return t;
    }
  }
  return "";
}

/**
 * Block-level tags: each one starts a new piece of text. Everything else is
 * inline and stays glued to the sentence it belongs to.
 *
 * ruby is deliberately NOT here: a word with a guide stays inside its sentence.
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
 * A <ruby> contributes its word only, and hands its guide to `onRubyGuide` —
 * the same rule xhtmlToMarkdown applies, so the two converters cannot disagree.
 *
 * @param {Object|null} node - A cheerio/domhandler node.
 * @param {(guide: RubyGuide) => void} [onRubyGuide] - Receives every guide this render removes.
 * @returns {string} The inline text.
 */
function inlineTextOf(node, onRubyGuide) {
  if (!node) return "";
  if (node.type === "text") return node.data || "";
  if (node.type !== "tag") return "";
  const name = (node.name || "").toLowerCase();
  if (PLAIN_TEXT_BLOCK_TAGS.has(name)) return "";
  if (name === "br") return "\n";
  if (name === "ruby") {
    let base = "";
    let reading = "";
    let annotations = 0;
    let pending = "";
    /** @type {RubyGuideAnnotation[]} */
    const annotated = [];
    for (const child of node.children || []) {
      if (child && child.type === "tag" && RUBY_GUIDE_TAGS.has((child.name || "").toLowerCase())) {
        const guideText = inlineTextOf(child) || "";
        reading += guideText;
        annotations += 1;
        pushRubyUnit(annotated, pending, guideText);
        pending = "";
        continue;
      }
      const own = inlineTextOf(child, onRubyGuide);
      base += own;
      pending += own;
    }
    closeRubyUnits(annotated, pending);
    const entry = {
      base: normalizeSpaces(base),
      reading: normalizeSpaces(reading),
      annotations,
      annotated,
    };
    if (onRubyGuide && (entry.base || entry.reading)) onRubyGuide(entry);
    return entry.base || entry.reading;
  }
  return (node.children || []).map((child) => inlineTextOf(child, onRubyGuide)).join("");
}

/**
 * Collect the paragraph-shaped pieces of a document into `out`.
 *
 * @param {Object|null} node - A cheerio/domhandler node.
 * @param {string[]} out - The pieces collected so far (mutated).
 * @param {(guide: RubyGuide) => void} [onRubyGuide] - Receives every guide this render removes.
 * @returns {void}
 */
function collectTextPieces(node, out, onRubyGuide) {
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
      .map((child) => inlineTextOf(child, onRubyGuide))
      .join("")
      .split("\n")
      .map(normalizeSpaces)
      .filter(Boolean);
    out.push(...own);
    // ...then its nested blocks, each of which becomes its own piece. Only
    // blocks: the inline and text children were already folded into `own`.
    for (const child of node.children || []) {
      if (child && child.type === "tag" && PLAIN_TEXT_BLOCK_TAGS.has((child.name || "").toLowerCase())) {
        collectTextPieces(child, out, onRubyGuide);
      }
    }
    return;
  }
  const piece = normalizeSpaces(inlineTextOf(node, onRubyGuide));
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
 * @param {(guide: RubyGuide) => void} [onRubyGuide] - Called once for every pronunciation
 *   guide this conversion sets aside — the same rule and the same harvest as xhtmlToMarkdown.
 * @returns {string} The plain text.
 */
function htmlToPlainText(html, onRubyGuide) {
  const $ = cheerio.load(typeof html === "string" ? html : "");
  $("script, style, head, title").remove();
  const root = $("body").length ? $("body").get(0) : $.root().get(0);
  const out = [];
  collectTextPieces(root, out, onRubyGuide);
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = {
  RUBY_GUIDE_TAGS,
  normalizeSpaces,
  pushRubyUnit,
  closeRubyUnits,
  splitRuby,
  renderRuby,
  textWithoutGuides,
  xhtmlToMarkdown,
  renderBlock,
  renderContainer,
  inlineText,
  firstHeadingText,
  PLAIN_TEXT_BLOCK_TAGS,
  inlineTextOf,
  collectTextPieces,
  htmlToPlainText,
};

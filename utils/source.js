/**
 * utils/source.js — the source bundle: what a volume's text actually is, in how
 * many chapters, and whether one pass can hold it.
 *
 * Every task resolves its volume source through resolveSourceBundle at the same
 * choke point. A plain-text source passes through as a single-segment bundle (an
 * oversized one is split into part files so the chapter-by-chapter fallback can
 * process it like a big epub); an .epub is extracted once and cached.
 *
 * The rule that took the most work to get right (AGENTS.md gotcha 52): A CHAPTER IS
 * WHAT THE BOOK SAYS IS A CHAPTER, not what the spine says. The Kadokawa /
 * BOOK-WALKER reflowable spec gives every PAGE its own spine item — cover,
 * half-title plates, a colour insert before each chapter, the chapter text, the
 * legal notice, the contents page, the author profile, a reader survey, an
 * advertisement, the colophon. Reading the spine literally turned a 10-chapter book
 * into 35 "chapters": the pipeline translated the copyright notice, research agents
 * spent their turns on blank illustration plates, and the report claimed 25 "empty
 * in source" holes in a book that has none. Across the live series: 554 spine pages
 * -> 133 real chapters.
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./source/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

require("../types"); // JSDoc type definitions

const __config = require("./source/config");
const __mode = require("./source/mode");
const __chapters = require("./source/chapters");
const __html = require("./source/html");
const __epub = require("./source/epub");
const __images = require("./source/images");
const __extract = require("./source/extract");
const __bundle = require("./source/bundle");
const __prompt_lines = require("./source/prompt-lines");

module.exports = {
  ...__config,
  ...__mode,
  ...__chapters,
  ...__html,
  ...__epub,
  ...__images,
  ...__extract,
  ...__bundle,
  ...__prompt_lines,
};

/**
 * utils/source/epub/section.js — sampling one page of an opened book, and naming the scripts in it.
 *
 * These are the two things the intake agent does with a book it has opened: read a window of it,
 * and get the writing systems counted for it so the agent does not have to eyeball a script it
 * may not be confident about.
 */

require("../../../types"); // JSDoc type definitions

const { htmlToPlainText } = require("../html");

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

module.exports = { readEpubSection, scriptCounts };

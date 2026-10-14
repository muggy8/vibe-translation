/**
 * utils/reference-store/validation/headings.js — the heading level a document's sections actually use.
 *
 * One rule, asked by two doors: the artifact shape check counts sections to decide whether a document is
 * addressable at all, and the grade sampler cuts a document into sections to decide what the acceptance
 * grader is shown. If the two disagreed about what a heading is, a file could be reported as having no
 * sections and still be sampled as though it had them.
 *
 * @module utils/reference-store/validation/headings
 */

require("../../../types"); // JSDoc type definitions

/**
 * The heading level the document's sections actually use.
 *
 * The voice reference's canonical shape puts each character under `### ` and the glossary puts its
 * rows under `## `, but the shape an agent left behind is not always the shape the prompt asked for,
 * and both a sampler and a shape check that silently found no sections would be measuring a document
 * consisting of its own first paragraph.
 *
 * @param {string[]} lines
 * @param {string} preferred
 * @returns {string}
 */
function sectionHeading(lines, preferred) {
  if (lines.some((line) => line.startsWith(preferred))) return preferred;
  return ["## ", "### ", "#### "].find((h) => lines.some((line) => line.startsWith(h))) || preferred;
}

module.exports = {
  sectionHeading,
};

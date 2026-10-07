/**
 * The category map inlined into the turn (buildStyleIndex) and the block that renders it, so the author can find the section a rule belongs to without paging the whole guide.
 *
 * Part of the style-guide.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types");

/**
 * The compact "what the guide already holds" map for an agent turn: each section
 * and how many rules it has. Enough to place a new rule without paging a document
 * too big to read whole, and small enough to inline.
 *
 * @param {string} markdown - The guide content.
 * @returns {string} The index, or "" for an empty document.
 */
function buildStyleIndex(markdown) {
  const sections = parseStyleSections(markdown);
  if (sections.length === 0) return "";
  const body = sections.map((s) => `- ${s.name}`).join("\n");
  const rules = countStyleRules(markdown);
  return `${body}\n(${rules} bullet rule(s) across ${sections.length} section(s).)`.trim();
}


/**
 * The "what the guide already holds" block for a style-guide agent turn.
 * @param {StyleGuideVolumeCtx} ctx - The volume context; `styleIndex` is set by
 *   seedStyleGuideFromPrevious.
 * @returns {string} The block, or "" when there is no index. Ends with a blank line.
 */
function styleIndexBlock(ctx) {
  if (!ctx.styleIndex) return "";
  return (
    `What "style-guide.md" already holds, by section:\n` +
    `${ctx.styleIndex}\n\n` +
    `Use this to choose the section a new rule belongs in. It is an index, not the document: ` +
    `read the rules you are about to change before changing them.\n\n`
  );
}


/**
 * The `##` sections of a style guide, in file order.
 *
 * The guide's category set is fixed by `system-prompts/style-guide.md` (Address &
 * Honorifics, Pronouns, …, Open Questions), which makes the category headings the
 * one cumulative unit this document can be compared on. Individual rules are free
 * prose bullets, and comparing prose is how a guard starts calling an improvement
 * a loss (the mistake that cost the glossary a good volume 02).
 *
 * @param {string} markdown - The guide file content.
 * @returns {Array<{name: string}>} The section names, in file order.
 */
function parseStyleSections(markdown) {
  if (!markdown || typeof markdown !== "string") return [];
  const sections = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (!heading) continue;
    const name = heading[1].replace(/\*\*?/g, "").replace(/`/g, "").trim();
    if (!name) continue;
    sections.push({ name });
  }
  return sections;
}


/**
 * Count the rule bullets in a style guide (a size signal, reported, never a
 * threshold — a guide that says the same thing in fewer words is not damaged).
 *
 * @param {string} markdown - The guide file content.
 * @returns {number} The number of top-level bullet lines.
 */
function countStyleRules(markdown) {
  if (!markdown || typeof markdown !== "string") return 0;
  return markdown.split("\n").filter((line) => /^\s*[-*] \S/.test(line)).length;
}


module.exports = {
  buildStyleIndex,
  styleIndexBlock,
  parseStyleSections,
  countStyleRules,
};

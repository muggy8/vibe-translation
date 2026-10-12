/**
 * The character sections of a voice reference, and the name each one is about.
 *
 * This is the unit the cumulative invariant is stated in: the carry-forward gate counts sections by
 * primary name, because a cumulative reference legitimately reworded a heading but may not quietly drop
 * a character. The `### [Character Name]` shape is what `utils/reference-store/` renders, and what every
 * published reference from volumes 1–2 on disk holds.
 *
 * The inlined "who is already in the reference" index used to live here too. It was a prompt block for
 * the author agent, and that route is gone (git history at commit 75e59a7), so the cap setting
 * `VOICE_INDEX_MAX_CHARS` went with it.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types");

/**
 * The character sections of a voice reference, in file order.
 *
 * @param {string} markdown - The reference file content.
 * @returns {Array<{name: string, heading: string, primary: string}>} `primary` is
 *   the heading with its bracketed aliases and persona tags removed — the part
 *   that identifies WHO the section is about.
 */
function parseVoiceSections(markdown) {
  if (!markdown || typeof markdown !== "string") return [];
  const sections = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^###\s+(.+)$/);
    if (!heading) continue;
    const text = heading[1].replace(/\*\*?/g, "").replace(/`/g, "").trim();
    if (!text || /^:?-{3,}:?$/.test(text)) continue;
    sections.push({ name: text, heading: line, primary: voicePrimaryName(text) });
  }
  return sections;
}


/**
 * The part of a character section heading that identifies the CHARACTER, with the
 * bracketed aliases and persona tags removed.
 *
 * `如月雨露（ジョーロ）【俺人格】` → `如月雨露`. The persona tag is what a pass that
 * rewrites prose is most likely to reword (「俺人格」 → 「俺」) while leaving the entry
 * intact, so the carry-forward gate must not read a reworded tag as a deleted character — that is the
 * false positive that cost the glossary a good volume 02 (see glossaryTermSpans in glossary.js).
 *
 * @param {string} heading - One `### ` heading's text.
 * @returns {string} The primary name (the heading itself when it has no brackets).
 */
function voicePrimaryName(heading) {
  const primary = String(heading || "")
    .split(/[（(【\[\/]/)[0]
    .trim();
  return primary || String(heading || "").trim();
}


module.exports = {
  parseVoiceSections,
  voicePrimaryName,
};

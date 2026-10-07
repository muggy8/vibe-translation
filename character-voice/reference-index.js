/**
 * The compact section map inlined into the turn, so placement and conflict checks need no paging. Capped, and it SAYS when it truncates — a prompt that silently truncates is a prompt that silently ignores the rules.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types");

/**
 * The "who is already in the reference" block for a character-voice agent turn.
 *
 * Same reason as the glossary's index: the cumulative reference is too big to
 * read whole from the middle volumes on, and a `grep` hunt for "is ひまわり
 * already here?" is what eats a capped step budget.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context; `voiceIndex` is set by
 *   seedVoiceReferenceFromPrevious.
 * @returns {string} The block, or "" when there is no index. Ends with a blank line.
 */
function voiceIndexBlock(ctx) {
  if (!ctx.voiceIndex) return "";
  return (
    `What "character-voice.md" already holds (one line per character section):\n` +
    `${ctx.voiceIndex}\n\n` +
    `Use this to find the section you are about to change and to avoid starting a second ` +
    `section for a character who is already here under another name. It is an index, not the ` +
    `document: read the section you are about to change before changing it.\n\n`
  );
}


/**
 * The compact section map built from a voice reference (see voiceIndexBlock).
 * Capped, and it says when it truncates — a prompt that silently truncates is a
 * prompt that silently ignores part of the rules (AGENTS.md gotcha 43).
 *
 * @param {string} markdown - The reference content.
 * @returns {string} The index, or "" for an empty document.
 */
function buildVoiceIndex(markdown) {
  const sections = parseVoiceSections(markdown);
  if (sections.length === 0) return "";
  const cap = Number.parseInt(process.env.VOICE_INDEX_MAX_CHARS || "12000", 10);
  const lines = sections.map((s) => s.name);
  const body = lines.join("\n");
  if (Number.isFinite(cap) && cap > 0 && body.length > cap) {
    const kept = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > cap) break;
      kept.push(line);
      used += line.length + 1;
    }
    return (
      kept.join("\n") +
      `\n(${sections.length - kept.length} later section(s) are not listed here — the index is ` +
      `capped at ${cap} chars. Search "character-voice.md" with grep before assuming a character ` +
      `is absent.)`
    );
  }
  return body;
}


/**
 * The character sections of a voice reference, in file order.
 *
 * The unit the cumulative invariant is stated in — `system-prompts/character-voice.md`
 * specifies `### [Character Name]` under `## Characters`, one section per
 * character (and one per persona of a character whose narration changes).
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
 * `如月雨露（ジョーロ）【俺人格】` → `如月雨露`. The persona tag is what a
 * feedback pass is most likely to reword (「俺人格」 → 「俺」) while leaving the
 * entry intact, so the carry-forward gate must not read a reworded tag as a
 * deleted character — that is the false positive that cost the glossary a good
 * volume 02 (see glossaryTermSpans in glossary.js).
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
  voiceIndexBlock,
  buildVoiceIndex,
  parseVoiceSections,
  voicePrimaryName,
};

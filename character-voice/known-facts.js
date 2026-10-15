/**
 * character-voice/known-facts.js — what a chapter's extraction call is shown as "already known":
 * a **query result over this volume's reference record**, not the previous volume's published file.
 *
 * Why this file exists. Until it did, `character-voice/reading.js` handed `ctx.previousVoiceRefFile` —
 * the previous volume's published `character-voice.md` — to **every chapter's** call, and
 * `truncateVoiceRef` was supposed to bound it. It could not: the picker's cap is a **section count**
 * (200) and this series' roster is 196 entries, one section each, so the guard ran and returned the
 * document whole (measured 2026-10-14 against the real function on a 196-section / 351,771-byte
 * reference: `kept=196 dropped=0 truncated=false`, 351,771 bytes in → 351,771 bytes out). The voice
 * stage's problem was never a lossy view of the reference; it was **the whole reference, every chapter,
 * forever**, bounded by nothing in the code (plan 06 §2.6, §7).
 *
 * The glossary stopped doing this years ago — its record carries the accumulation, so its read pass is
 * shown the chapter and nothing else. This is the same door on the voice side, and it is the shape the
 * translation stage already walks through (`utils/translate/settled-glossary.js` reads the record and
 * **refuses structurally** rather than falling back to the markdown).
 *
 * Three rules this file is built on:
 *
 *   - **The record is the source.** The query is `utils/reference-store/chapter-facts.js`: the record's
 *     *current* claims (`currentClaimSql`), for the characters this chapter's own text names, judged as
 *     of this volume. A claim the record replaced does not reach the prompt, whatever the published file
 *     on disk still prints.
 *   - **No record is a refusal, and nothing-known is a named fact.** A reading pass with no record open
 *     refuses (`no-reference-record`). A chapter the record names nobody in is still read — and says so,
 *     in the block, in the log, and in the report the grader reads. "Shown nothing" and "shown an empty
 *     reference" used to be the same invisible event.
 *   - **The block is bounded by a character budget, and says when the bound bit.** Not a section count:
 *     a section count is the bound that failed.
 *
 * Part of the character-voice.js layer.
 *
 * @module character-voice/known-facts
 */

const fs = require("fs");
const path = require("path");
require("../types"); // JSDoc type definitions

/** The heading the block carries, so the model can tell it apart from the chapter and from the tally. */
const KNOWN_FACTS_HEADING = "## What this record already knows about the characters in this chapter";

/**
 * How long one claim's own text may run inside the block.
 *
 * The published artifact lets a bullet reach `MAX_REBUILD_BULLET_CHARS` (2,000) because the file is read
 * by a person. This block is re-sent 133 times, and the question it supports is "does this still hold
 * in the chapter you are reading?" — which needs the claim and its quote, not the full note. A claim cut
 * here is **marked as cut**; the whole claim stays in the record.
 */
const KNOWN_FACTS_BULLET_CHARS = 400;

/**
 * The ceiling on the whole block. Constant, with no environment knob (AGENTS.md rule 3).
 *
 * The bound this slice exists to install. Measured on the synthesized 196-section reference this slice
 * builds (`test/test-voice-readpass-query.js`), the document the stage used to show was 351,771 bytes
 * per chapter; the block is under this number whatever the roster holds, and when it bites the block
 * names how many characters it left out.
 */
const KNOWN_FACTS_MAX_BLOCK_CHARS = 24000;

/** How many of a claim's own verified quotes go in its line — enough to check, not the whole set. */
const KNOWN_FACTS_EXAMPLES_PER_CLAIM = 1;

/**
 * The room held back for the line that names what the block left out.
 *
 * The ceiling is on the **whole block**, trailer included. Packing sections into the ceiling and then
 * appending the note on top is how a bound gets walked past, and a bound that can be walked past is the
 * bound this slice exists to replace. The reserve is comfortably bigger than the longest note this file
 * can produce (six clauses and their explanation).
 */
const KNOWN_FACTS_NOTE_RESERVE = 900;

/**
 * One claim's line, inside the bullet budget, with its quote and the volume that established it.
 *
 * @param {Object} claim - One row from `chapterKnownFacts`.
 * @returns {{line: string, truncated: boolean}}
 */
function claimLine(claim) {
  const label = claim.label || claim.aspect || "Notes";
  const where = `v${claim.established_volume}${claim.established_chapter ? ` ${claim.established_chapter}` : ""}`;
  const axis = claim.axis ? ` (${claim.axis}${claim.axis_value ? `=${claim.axis_value}` : ""})` : "";
  const prefix = `- **${label}** [${where}]${axis}: `;

  let body = String(claim.body || "").replace(/\s*\n\s*/g, " ").trim();
  let examples = [];
  try {
    examples = JSON.parse(claim.examples || "[]");
  } catch {
    examples = [];
  }
  const quoted = examples
    .filter((example) => typeof example === "string" && example.trim())
    .slice(0, KNOWN_FACTS_EXAMPLES_PER_CLAIM)
    .map((example) => `「${example.replace(/\s+/g, " ").trim()}」`);
  const tail = quoted.length ? ` — e.g. ${quoted.join(" / ")}` : "";

  const budget = Math.max(0, KNOWN_FACTS_BULLET_CHARS - prefix.length - tail.length);
  const truncated = body.length > budget;
  if (truncated) body = `${body.slice(0, Math.max(0, budget - 1))}…`;
  return { line: `${prefix}${body}${tail}`, truncated };
}

/**
 * One character's section: the heading, who they are, where the chapter shows them, and their claims.
 *
 * The "appears through" part is not decoration. A person filed under 如月雨露 can be printed in a
 * chapter only as 俺, and a block that said "named 951 times" about a string the chapter never prints
 * would be a block making a claim the chapter does not back up. The names that produced the match are
 * printed, the way the coverage report prints them.
 *
 * @param {Object} character - One entry from `chapterKnownFacts.characters`.
 * @returns {{lines: string[], truncated: number}} The section's lines, and how many of its claims were shortened.
 */
function characterSectionLines(character) {
  const through = character.through
    .map((name) => `${name.name} (${name.matches}${name.matched === "skeleton" ? ", by Han skeleton" : ""})`)
    .join(", ");
  const lines = [`### ${character.display} — appears here through: ${through}`, ""];
  let truncated = 0;
  for (const claim of character.claims) {
    const rendered = claimLine(claim);
    if (rendered.truncated) truncated += 1;
    lines.push(rendered.line);
  }
  if (character.claimsCapped) {
    lines.push(`- (${character.claimsCapped} earlier claim(s) about this character are in the record and not shown here.)`);
  }
  lines.push("");
  return { lines, truncated };
}

/**
 * The block a chapter's call is shown.
 *
 * Empty-roster and no-match are both **said**, not left blank: a chapter shown nothing must know it was
 * shown nothing, or it will read the absence as "nobody in this chapter has ever been seen".
 *
 * @param {Object} result - What `chapterKnownFacts` returned.
 * @returns {{text: string, sectionsShown: number, sectionsOmitted: number, claimsShown: number, truncatedClaims: number}}
 */
function buildKnownFactsBlock(result) {
  const named = result.namedCount;
  const roster = result.rosterTotal;

  /** @type {string[]} */
  const head = [KNOWN_FACTS_HEADING, ""];
  if (roster === 0) {
    head.push(
      `This volume's reference record carries no earlier claims about anybody — it is the first volume ` +
      `this record has read. Nothing is being shown to you as already known, so everything you find here ` +
      `is new to the record.`
    );
  } else if (named === 0) {
    head.push(
      `This volume's reference record carries ${roster} roster entr(ies). **None of them is named in this ` +
      `chapter's text** by the same rule the record's own audit matches names with, so nothing about any ` +
      `character is being shown for this chapter. That is not the same as the record being empty: it is ` +
      `this chapter containing nobody the record can see.`
    );
  } else {
    head.push(
      `Measured from this chapter's own text, ${named} of the ${roster} roster entries this record carries ` +
      `appear in it. Below are the claims this record **currently** stands behind about them, as of volume ` +
      `${result.volume} — what the volumes before this one established. A claim a later volume replaced is ` +
      `not shown. If a claim below still holds in this chapter, do not restate it; if this chapter ` +
      `contradicts it, say what this chapter prints.`
    );
  }
  head.push("");

  /** @type {Array<{lines: string[], truncated: number}>} */
  const sections = result.characters.map(characterSectionLines);

  let used = head.join("\n").length;
  let sectionsShown = 0;
  let sectionsOmitted = 0;
  let claimsShown = 0;
  let truncatedClaims = 0;
  /** @type {number[]} Indices of the sections that fit. */
  const chosen = [];
  for (let i = 0; i < sections.length; i++) {
    // +1 for the newline `join` puts between blocks. The reserve is the note at the bottom spending its
    // share of the ceiling, so the ceiling is a ceiling on the whole block and not on its middle.
    const size = sections[i].lines.join("\n").length + 1;
    if (used + size + KNOWN_FACTS_NOTE_RESERVE > KNOWN_FACTS_MAX_BLOCK_CHARS) {
      sectionsOmitted += 1;
      continue;
    }
    chosen.push(i);
    used += size;
    sectionsShown += 1;
    claimsShown += result.characters[i].claimsShown;
    truncatedClaims += sections[i].truncated;
  }

  /** @type {string[]} */
  const notShown = [];
  if (result.charactersNotShown) notShown.push(`${result.charactersNotShown} roster entr(ies) this chapter names but the block's limit does not reach`);
  if (sectionsOmitted) notShown.push(`${sectionsOmitted} character section(s) left out to keep this block inside its ${KNOWN_FACTS_MAX_BLOCK_CHARS}-character limit`);
  if (result.claimsReplaced) notShown.push(`${result.claimsReplaced} claim(s) this record has replaced or withdrawn`);
  if (result.claimsOutOfSpan) notShown.push(`${result.claimsOutOfSpan} claim(s) whose validity span does not reach volume ${result.volume}`);
  if (result.claimsCapped) notShown.push(`${result.claimsCapped} older claim(s) beyond the ${result.limits.maxClaimsPerCharacter}-per-character limit`);
  if (truncatedClaims) notShown.push(`${truncatedClaims} claim(s) shortened to ${KNOWN_FACTS_BULLET_CHARS} characters`);

  const out = [...head];
  for (const index of chosen) out.push(...sections[index].lines);

  if (notShown.length) {
    out.push(
      `_Not shown: ${notShown.join("; ")}. Everything left out is still in this volume's reference record — ` +
      `do not treat something as new merely because it is absent from what you can see here._`
    );
  }

  return {
    text: out.join("\n"),
    sectionsShown,
    sectionsOmitted,
    claimsShown,
    truncatedClaims,
  };
}

/**
 * The known-facts block for one chapter, built from the volume's open record.
 *
 * The refusal half is the point of the door: a reading pass with no record is not a pass that shows a
 * smaller reference, it is a pass that knows nothing and used to be able to pretend otherwise.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - Needs `refStore` (the volume's open record), `volumeDir`, `values`.
 * @param {{id: string, file: string}} segment - The chapter being read.
 * @returns {{ok: boolean, refusal: Object|null, block: string, bytes: number, rosterTotal: number, namedCount: number, claimsShown: number, sectionsOmitted: number, truncatedClaims: number}}
 */
function knownFactsForChapter(ctx, segment) {
  const fail = (refusal) => ({
    ok: false,
    refusal,
    block: "",
    bytes: 0,
    rosterTotal: 0,
    namedCount: 0,
    claimsShown: 0,
    sectionsOmitted: 0,
    truncatedClaims: 0,
  });

  if (!ctx || !ctx.refStore) {
    return fail({
      rule: "no-reference-record",
      because:
        `chapter ${segment.id}: the reading pass has no reference record open for volume ${ctx && ctx.values ? ctx.values.INSTALLMENT_NUMBER : "?"}. ` +
        "The record is where the earlier volumes' claims are carried forward, so a chapter read without one is asked what is new with nothing to compare it against.",
      fix: "open the volume's record before reading it — `openVoiceRecord` (the stage and extract-voice.js both do this). There is no fallback to a markdown file.",
    });
  }

  let chapterText = null;
  try {
    chapterText = fs.readFileSync(path.join(ctx.volumeDir, segment.file), "utf8");
  } catch {
    return fail({
      rule: "chapter-source-missing",
      because: `chapter ${segment.id}: its own text could not be read from ${path.join(ctx.volumeDir, segment.file)}.`,
      fix: "resolve the volume's source bundle first (the same source the evidence rule reads).",
    });
  }

  const result = ctx.refStore.chapterKnownFacts({
    chapterText,
    volume: Number(ctx.values.INSTALLMENT_NUMBER),
  });
  if (!result.ok) return fail(result.refusal);

  const built = buildKnownFactsBlock(result);
  return {
    ok: true,
    refusal: null,
    block: built.text,
    bytes: built.text.length,
    rosterTotal: result.rosterTotal,
    namedCount: result.namedCount,
    claimsShown: built.claimsShown,
    sectionsOmitted: built.sectionsOmitted + result.charactersNotShown,
    truncatedClaims: built.truncatedClaims,
  };
}

module.exports = {
  KNOWN_FACTS_HEADING,
  KNOWN_FACTS_BULLET_CHARS,
  KNOWN_FACTS_MAX_BLOCK_CHARS,
  KNOWN_FACTS_NOTE_RESERVE,
  KNOWN_FACTS_EXAMPLES_PER_CLAIM,
  claimLine,
  characterSectionLines,
  buildKnownFactsBlock,
  knownFactsForChapter,
};

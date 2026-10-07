/**
 * How the cumulative reference is written. From volume 02 on the whole-file writeFile is FORBIDDEN and the file is amended in place with editFile (voiceWriteInstruction); the recovery prompt must not demand the whole-file rewrite that broke the glossary. voiceAuthorMaxSteps is the scaled cap — a flat 30 is where this stage's zero-write 46-tool-call feedback turn came from. A character count cannot see the answer: the cumulative reference outgrows one reply from volume 03 onward.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const { authorMaxStepsFor, selectSectionsByRelevance } = require("../utils/prompt");

const { VOICE_REF_TRUNCATION_MAX_ENTRIES, VOICE_REF_TRUNCATION_THRESHOLD } = require("./config");

/**
 * The write instruction for a character-voice pass — ONE implementation shared by
 * the compile and feedback passes, whole and per-chapter.
 *
 * `character-voice.md` is cumulative and is seeded from the previous volume, so
 * from volume 02 on it is amended IN PLACE. `pov-map.md` is this volume's own
 * document and is always written whole. Getting these two the same way is what
 * broke the stage: the whole-file demand put the only write at the END of the
 * turn, so a pass that ran out of steps produced nothing at all.
 *
 * @param {boolean} hasExistingFile - Whether "character-voice.md" already holds the
 *   document to change (see seedVoiceReferenceFromPrevious).
 * @param {"amend"|"correct"} [mode] - "amend" adds entries; "correct" applies a
 *   validation report. Only the wording differs.
 * @returns {string} The instruction block, ending with a blank line.
 */
function voiceWriteInstruction(hasExistingFile, mode = "amend") {
  const doVerb = mode === "correct" ? "Correct" : "Amend";
  if (!hasExistingFile) {
    return (
      `How to write it — neither file exists yet in your working folder, so write both ` +
      `whole with writeFile (complete contents), in the exact section format from the system ` +
      `prompt:\n\n` +
      `- "character-voice.md" — the character voice reference.\n` +
      `- "pov-map.md" — this volume's POV map.\n\n`
    );
  }
  return (
    `How to write it — the two files are NOT the same kind of document, and they are not ` +
    `written the same way:\n\n` +
    `1. "character-voice.md" ALREADY holds the reference as of the step before this one (the ` +
    `workflow put the current version of it there). ${doVerb} it IN PLACE with editFile:\n` +
    `   - Add a new character as ONE new \`### Name\` section at the end of the Characters part.\n` +
    `   - Edit an existing character's section in place when the source shows a quirk is wrong ` +
    `or missing, and keep the rest of that section.\n` +
    `   - Update the "current through volume" header line.\n` +
    `   Do NOT rewrite "character-voice.md" with writeFile. This reference is larger than one ` +
    `reply can produce, and a write cut off part-way destroys every character it did not reach. ` +
    `Never delete a section, and never retype a section you have not just read — characters ` +
    `that fall out of this file are lost from every later volume.\n\n` +
    `2. "pov-map.md" describes ONLY this volume, so it is written whole with writeFile ` +
    `(complete contents, overwrite).\n\n` +
    `Work in priority order, and write as you go: apply the HIGH-severity findings first with ` +
    `editFile, then MEDIUM, then LOW. Do not spend the whole turn reading and verifying and ` +
    `leave the editing for the end — a turn that runs out of steps having changed nothing has ` +
    `produced nothing, while one that applied the important fixes first produced a better ` +
    `document even if it did not reach the minor ones.\n\n`
  );
}


/**
 * The recovery turn for a character-voice pass that answered in chat instead of
 * using the file tools.
 *
 * It deliberately does NOT demand a whole-file rewrite of the cumulative
 * reference — that is the instruction that broke the stage (see
 * voiceWriteInstruction), and `assertWroteWithFallback` has already put the reply
 * on disk, so there is a file to edit.
 *
 * @param {boolean} hasContent - Whether the agent produced content in its chat reply.
 * @param {boolean} hasExistingFile - Whether "character-voice.md" is the seeded,
 *   cumulative document (true) or one the agent must create (false).
 * @returns {string} The recovery prompt.
 */
function voiceRecoveryPrompt(hasContent, hasExistingFile) {
  const voicePart = hasExistingFile
    ? `Apply your changes to "character-voice.md" with editFile — add each new character as a ` +
      `new "### Name" section and edit existing sections in place. Do NOT rewrite ` +
      `"character-voice.md" from scratch with writeFile: every section that is in it now must ` +
      `still be there when you finish.`
    : `Write the complete character voice reference to "character-voice.md" with writeFile.`;
  const povPart = `Write this volume's POV map to "pov-map.md" with writeFile (complete contents).`;
  if (hasContent) {
    return (
      `You produced your answer as a chat message instead of changing the files.\n\n` +
      `${voicePart}\n\n${povPart}\n\n` +
      `Read "character-voice.md" before editing it.`
    );
  }
  return (
    `You produced no output. Read the materials, then:\n\n` +
    `${voicePart}\n\n${povPart}`
  );
}


/**
 * The step cap for this stage's author / feedback agent on this volume or chapter.
 *
 * Scaled rather than flat 30: the agent reads the cumulative reference (which no
 * longer fits in one `readFile` answer), the text it is compiling from, and (for
 * feedback) the validation report. A flat 30 is what stopped volume 01's feedback
 * turn at 46 tool calls with zero writes.
 *
 * Fail-soft: an unreadable size counts as 0, which yields the flat floor rather
 * than failing the volume over a stat call.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context.
 * @param {SourceSegment|null} [seg] - The chapter being processed (chunked mode).
 * @returns {Promise<number>} The step cap.
 */
async function voiceAuthorMaxSteps(ctx, seg = null) {
  const sizeOf = async (p) => {
    try {
      return (await fs.stat(p)).size;
    } catch {
      return 0;
    }
  };
  const artifactBytes = await sizeOf(ctx.voiceOutputFile);
  const sourceBytes = seg
    ? await sizeOf(path.join(ctx.volumeDir, seg.file))
    : await sizeOf(ctx.sourceFile);
  return authorMaxStepsFor(artifactBytes, sourceBytes);
}


/**
 * Truncate a character voice reference if it exceeds the threshold.
 *
 * "Show the last N sections" was wrong for the same reason it is wrong for the
 * glossary: the sections are one per CHARACTER, and the volume-1 cast sits at the
 * top of the document forever. At volume 17 the extractor was shown a reference
 * with the protagonists missing and rediscovered them as new characters. The
 * selection is now relevance-ordered — every character whose name occurs in the
 * volume being processed is kept, whatever position they hold in the file (see
 * selectSectionsByRelevance in utils/prompt.js).
 *
 * @param {string} content - The full character voice reference content.
 * @param {string} [sourceText] - The volume/chapter source text, used to rank sections.
 * @returns {string}
 */
function truncateVoiceRef(content, sourceText) {
  if (!content || content.length <= VOICE_REF_TRUNCATION_THRESHOLD) return content;
  const picked = selectSectionsByRelevance({
    content,
    headingRe: /^### /m,
    sourceText,
    maxUnits: VOICE_REF_TRUNCATION_MAX_ENTRIES,
    unitLabel: "character section(s)",
  });
  return picked.content;
}

// ─── Cumulative-document rules (the same shape glossary.js established) ───────
//
// The character voice reference is cumulative, and it grows the way the glossary
// did. Asking a model to reproduce it with "writeFile, complete contents" is the
// mistake that broke the glossary (AGENTS.md gotcha 64), and this stage was
// never given the fix. Observed on the live 17-volume run: the volume-01
// character-voice feedback turn made 46 tool calls — 29 reads, 15 searches, ZERO
// writes — spent 2.63M tokens, and hit its step cap while still verifying
// findings, because the one write it had been told to do was the last thing in
// its instructions.


/**
 * Parse the AI's extraction output into an array of voice quirk / POV entries.
 * @param {string} output - The raw AI output.
 * @returns {Array<Object>}
 */
function parseVoiceQuirks(output) {
  if (!output || typeof output !== "string") return [];
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new Error("No JSON array found in the character-voice extraction output.");
  }
  const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("The character-voice extraction output was not a JSON array.");
  }
  return parsed.filter((entry) => entry && typeof entry.type === "string");
}


module.exports = {
  voiceWriteInstruction,
  voiceRecoveryPrompt,
  voiceAuthorMaxSteps,
  truncateVoiceRef,
  parseVoiceQuirks,
};

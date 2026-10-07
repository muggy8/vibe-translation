/**
 * How the cumulative guide is written: amended in place with editFile from the first volume onward (styleWriteInstruction), the recovery prompt refusing to demand the whole-file rewrite, and the scaled step cap. truncateStyleGuide is the relevance-ranked window used when the previous guide is INLINED into a one-shot prompt — never what the author agents see, which read the real file.
 *
 * Part of the style-guide.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const { authorMaxStepsFor } = require("../utils/prompt");

/**
 * The write instruction for a style-guide pass — shared by the compile and
 * feedback passes, whole and per-chapter. See voiceWriteInstruction /
 * glossaryWriteInstruction: the cumulative document is edited IN PLACE, and the
 * whole-file write is only for a file that does not exist yet.
 *
 * @param {boolean} hasExistingFile - Whether "style-guide.md" already holds the
 *   document to change.
 * @param {"amend"|"correct"} [mode] - "amend" adds rules; "correct" applies a report.
 * @returns {string} The instruction block, ending with a blank line.
 */
function styleWriteInstruction(hasExistingFile, mode = "amend") {
  const doVerb = mode === "correct" ? "Correct" : "Amend";
  if (!hasExistingFile) {
    return (
      `How to write it: the file "style-guide.md" in your working folder does not exist yet, ` +
      `so write the complete guide to it with writeFile (complete contents), in the exact ` +
      `section format from the system prompt.\n\n`
    );
  }
  return (
    `How to write it — "style-guide.md" in your working folder ALREADY holds the guide as of ` +
    `the step before this one (the workflow put the current version of it there). ` +
    `${doVerb} it IN PLACE with editFile:\n\n` +
    `- Add each new rule as ONE new bullet inside the right existing section.\n` +
    `- Replace an existing rule only when the source text shows it is wrong, and keep the rest ` +
    `of its section.\n` +
    `- Add to the "Open Questions" section rather than guessing an undecidable construct.\n` +
    `- Update the "current through volume" header line.\n\n` +
    `Do NOT rewrite the whole file with writeFile. This guide is larger than one reply can ` +
    `produce, and a write cut off part-way destroys every rule it did not reach. Never delete a ` +
    `section, and never retype a rule you have not just read — rules that fall out of this file ` +
    `are lost from every later volume.\n\n` +
    `Work in priority order, and write as you go: apply the HIGH-severity findings first with ` +
    `editFile, then MEDIUM, then LOW. A turn that runs out of steps having changed nothing ` +
    `produced nothing; one that applied the important fixes first produced a better guide even ` +
    `if it never reached the minor ones.\n\n`
  );
}


/**
 * The recovery turn for a style-guide pass that answered in chat instead of using
 * the file tools. It edits, because demanding a whole-file rewrite of a document
 * larger than one reply is how a recovery turn destroys what it was sent to fix.
 *
 * @param {boolean} hasContent - Whether the agent produced content in its chat reply.
 * @param {boolean} hasExistingFile - Whether "style-guide.md" is the seeded guide.
 * @returns {string} The recovery prompt.
 */
function styleRecoveryPrompt(hasContent, hasExistingFile) {
  const guidePart = hasExistingFile
    ? `Apply your changes to "style-guide.md" with editFile — add each new rule as a bullet in ` +
      `the right section and edit existing rules in place. Do NOT rewrite "style-guide.md" from ` +
      `scratch with writeFile: every section and rule that is in it now must still be there when ` +
      `you finish.`
    : `Write the complete style guide to "style-guide.md" with writeFile.`;
  if (hasContent) {
    return `You produced your answer as a chat message instead of changing the file.\n\n${guidePart}\n\nRead "style-guide.md" before editing it.`;
  }
  return `You produced no output. Read the materials, then: ${guidePart}`;
}


/**
 * The step cap for this stage's author / feedback agent on this volume or chapter
 * (see authorMaxStepsFor — a flat 30 is what stopped the sibling stage's feedback
 * turn at 46 tool calls with zero writes).
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context.
 * @param {SourceSegment|null} [seg] - The chapter being processed (chunked mode).
 * @returns {Promise<number>} The step cap.
 */
async function styleAuthorMaxSteps(ctx, seg = null) {
  const sizeOf = async (p) => {
    try {
      return (await fs.stat(p)).size;
    } catch {
      return 0;
    }
  };
  const artifactBytes = await sizeOf(ctx.styleOutputFile);
  const sourceBytes = seg
    ? await sizeOf(path.join(ctx.volumeDir, seg.file))
    : await sizeOf(ctx.sourceFile);
  return authorMaxStepsFor(artifactBytes, sourceBytes);
}


/**
 * Parse the AI's extraction output into an array of style-construct entries.
 * @param {string} output - The raw AI output.
 * @returns {Array<Object>}
 */
function parseStyleObservations(output) {
  if (!output || typeof output !== "string") return [];
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new Error("No JSON array found in the style-guide extraction output.");
  }
  const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("The style-guide extraction output was not a JSON array.");
  }
  return parsed.filter((entry) => entry && typeof entry.category === "string");
}


module.exports = {
  styleWriteInstruction,
  styleRecoveryPrompt,
  styleAuthorMaxSteps,
  parseStyleObservations,
};

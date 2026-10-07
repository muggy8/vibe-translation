/**
 * The amend pass itself: the map the agent is given instead of a hunt, the
 * instruction that follows the file (amend in place with editFile; whole-file
 * writeFile only when the file does not exist yet), the recovery prompt that must
 * NOT demand the whole-file rewrite, and the reading-scaled step cap.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const { authorMaxStepsFor } = require("../utils/prompt");

/**
 * The "what the glossary already holds" block for a glossary agent turn.
 *
 * One implementation shared by the amend and both feedback passes: every one of
 * them has to find the row it is looking for inside a document too big to read
 * whole, and a `grep` hunt is what eats a capped step budget (see
 * buildGlossaryIndex).
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context; `glossaryIndex` is set by
 *   seedGlossaryFromPrevious.
 * @returns {string} The block, or "" when there is no index. Ends with a blank line.
 */
function glossaryIndexBlock(ctx) {
  if (!ctx.glossaryIndex) return "";
  return (
    `What "glossary.md" already holds, by section (term → rendering):\n` +
    `${ctx.glossaryIndex}\n\n` +
    `Use this to choose the section a term belongs in, and to catch a term that is ` +
    `already here under a different spelling. It is an index, not the document: read ` +
    `the rows you are about to change before changing them.\n\n`
  );
}


/**
 * The write instruction for a glossary pass — ONE implementation shared by the
 * amend, feedback, and per-chapter variants, because the two cases differ only
 * in what the file already contains.
 *
 * Why this exists: every glossary pass used to be told "writeFile, complete
 * contents, overwrite". That is right for volume 01 and wrong from volume 03
 * onward, because the cumulative glossary outgrows a single reply (the output
 * cap is a quarter of the context window — `envMaxTokens` in harness.js — and
 * volume 05's glossary needs ~154k tokens against a 65,536-token cap). Observed
 * on the live 17-volume run: the agent tried to obey, its `writeFile` JSON
 * argument was cut off mid-string, the tool call failed and the volume died;
 * other passes gave up on `writeFile`, rebuilt the document from paged reads
 * and memory, ran out of their step budget, and shipped a glossary missing 457
 * of the 769 terms it was supposed to carry.
 *
 * With the baseline copied in by `seedGlossaryFromPrevious`, the agent's job is
 * the part a model is actually good at: insert a few rows into a file it can
 * see.
 *
 * @param {boolean} hasExistingFile - Whether `glossary.md` already holds the
 *   document to change (see seedGlossaryFromPrevious). False means the agent
 *   must create it, which is the only case a whole-file write is correct.
 * @param {"amend"|"correct"} [mode] - "amend" adds terms; "correct" applies a
 *   validation report. Only the wording differs.
 * @returns {string} The instruction block, ending with a blank line.
 */
function glossaryWriteInstruction(hasExistingFile, mode = "amend") {
  if (!hasExistingFile) {
    return (
      `How to write it: the file "glossary.md" in your working folder does not ` +
      `exist yet, so write the complete document to it with writeFile (complete ` +
      `contents), in the exact section/table format from the system prompt.\n\n`
    );
  }
  const verb = mode === "correct" ? "correct" : "amend";
  return (
    `How to write it — "glossary.md" in your working folder ALREADY holds the ` +
    `glossary as of the step before this one (the workflow put the current version ` +
    `of it there). ${verb[0].toUpperCase()}${verb.slice(1)} it ` +
    `IN PLACE with editFile:\n\n` +
    `- Insert each new term as ONE new table row at the end of the right section's table.\n` +
    `- Replace an existing row only when the source text or a listed dispute shows that ` +
    `rendering is wrong, and keep its Notes column.\n` +
    `- Update the "_… Current through volume …_" header line.\n\n` +
    `Do NOT rewrite the whole file with writeFile. This glossary is larger than one ` +
    `reply can produce, and a write cut off part-way destroys every entry it did not ` +
    `reach. Never delete a row, and never retype an entry you have not just read — ` +
    `entries that fall out of this file are lost from every later volume.\n\n`
  );
}


/**
 * The recovery turn for a glossary pass that answered in chat instead of using
 * the file tools.
 *
 * It deliberately does NOT ask for a whole-file rewrite. That is the instruction
 * that broke the cumulative glossary (see glossaryWriteInstruction), and
 * `assertWroteWithFallback` has already put the reply on disk, so there is a
 * file to edit. Asking again for "writeFile, complete contents" over a document
 * larger than one reply is how a recovery turn destroys the thing it was sent
 * to repair.
 *
 * @param {boolean} hasContent - Whether the agent produced the content in its
 *   chat reply (true) or produced nothing at all (false).
 * @param {string} [fileLabel] - The file to fix, as the agent knows it.
 * @param {string} [materialsLine] - What to read before fixing it.
 * @returns {string} The recovery prompt.
 */
function glossaryRecoveryPrompt(hasContent, fileLabel = '"glossary.md"', materialsLine = "the materials") {
  if (hasContent) {
    return (
      `You produced your answer as a chat message instead of changing the file. ` +
      `Your additions are correct — now apply them to ${fileLabel} in your working ` +
      `folder with editFile: insert each new row into the right section's table and ` +
      `update the "Current through volume" header.\n\n` +
      `Do NOT rewrite ${fileLabel} from scratch with writeFile. Read it first, then ` +
      `edit it in place. Every existing row must still be there when you finish.\n\n` +
      `Read ${materialsLine} before editing.`
    );
  }
  return (
    `You produced no output. Read ${materialsLine}, then apply your changes to ` +
    `${fileLabel} in your working folder with editFile — insert each new row into ` +
    `the right section's table and update the "Current through volume" header.\n\n` +
    `Do NOT rewrite ${fileLabel} from scratch with writeFile. Every existing row ` +
    `must still be there when you finish.`
  );
}


/**
 * The step cap for a glossary author or feedback agent on this volume/chapter.
 *
 * Scaled rather than fixed because both things it must read grow with the
 * series: the cumulative glossary (which no longer fits in one `readFile`
 * answer from volume 03 on) and the text it is amending from. A flat 40 is
 * where 17 of the 25 step-cap warnings on the live 17-volume run came from.
 *
 * Fail-soft: an unreadable size counts as 0, which yields the old flat floor
 * rather than failing the volume over a stat call.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {SourceSegment|null} [seg] - The chapter being processed (chunked mode).
 * @returns {Promise<number>} The step cap.
 */
async function glossaryAuthorMaxSteps(ctx, seg = null) {
  const sizeOf = async (p) => {
    try {
      return (await fs.stat(p)).size;
    } catch {
      return 0;
    }
  };
  const glossaryBytes = await sizeOf(ctx.glossaryOutputFile);
  const sourceBytes = seg
    ? await sizeOf(path.join(ctx.volumeDir, seg.file))
    : await sizeOf(ctx.sourceFile);
  return authorMaxStepsFor(glossaryBytes, sourceBytes);
}


module.exports = {
  glossaryIndexBlock,
  glossaryWriteInstruction,
  glossaryRecoveryPrompt,
  glossaryAuthorMaxSteps,
};

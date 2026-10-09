/**
 * The one question the write instruction turns on: is the cumulative artifact already sitting in this
 * folder?
 *
 * Why this is a module and not a `readFile` at each call site. Every cumulative stage asks the same
 * question and gets it wrong in the same way: it answers it from **how the file got there** — "did the
 * workflow copy the previous volume's in?" — instead of from **whether it is there**. Those are not the
 * same question, and the gap is the chapter-by-chapter path of the first volume: there is no previous
 * volume to copy from, so the flag stays false for chapter 8 as well, while the artifact the agent is
 * told to create has been in the folder since chapter 1 and is several hundred kilobytes long. The
 * instruction that produces is `writeFile (complete contents)` on a document larger than one reply,
 * which is the failure gotcha 64 is about, and the carry-forward gate is the only thing that can see
 * the characters or terms the rewrite did not reach.
 *
 * The same gap opens whenever a seed fails: the previous volume's file could not be read, the copy did
 * not happen, and a half-built artifact from an earlier attempt is still in the folder.
 *
 * So the answer is read off the disk, at the moment the pass is built, and it is the same answer for
 * the whole-installment path and the per-chapter one.
 */

const fs = require("fs").promises;
require("../../types"); // JSDoc type definitions

/**
 * Read the artifact this pass is about to amend.
 *
 * An empty or whitespace-only file counts as absent: an agent told to "amend it in place" and handed
 * nothing is the failure `assertRealOutput` exists to stop, and the honest instruction for an empty
 * file is the one for a missing file.
 *
 * @param {string} filePath - The volume's own cumulative artifact (`character-voice.md`, `glossary.md`,
 *   `style-guide.md`).
 * @returns {Promise<{present: boolean, text: string|null}>} `text` is null exactly when `present` is
 *   false, so a caller can use it as the carry-forward baseline and the write instruction from one read.
 */
async function readArtifactToAmend(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return { present: false, text: null };
  }
  if (!text || text.trim().length === 0) return { present: false, text: null };
  return { present: true, text };
}


module.exports = { readArtifactToAmend };

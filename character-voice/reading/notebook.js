/**
 * character-voice/reading/notebook.js — the one job: the volume's extraction notebook — the name it is
 * written under, and how its chapters are flattened into it without losing which chapter said what.
 *
 * The notebook used to flatten the chapters away, which meant that once a claim was in
 * `character-voice-new.json` nothing in it said which chapter printed it — and a confirmation ("volume 5 saw
 * this claim again") is worth nothing unless it can be traced to a chapter of volume 5. The stamp is code's,
 * not the model's: it is not in the answer shape the request declares, and an entry that arrives without one
 * is filed with its chapter left null and named, not guessed.
 *
 * Part of the character-voice/reading.js layer.
 *
 * @module character-voice/reading/notebook
 */

require("../../types"); // JSDoc type definitions

/** The notebook the voice stage writes under this name; the reading pass writes the same one. */
const EXTRACTION_FILE = "character-voice-new.json";

/**
 * Assemble the volume's notebook from its chapter partials, in reading order.
 *
 * Each entry is stamped with the chapter its answer came from. The notebook used to flatten the chapters
 * away, which meant that once a claim was in `character-voice-new.json` nothing in it said which chapter
 * printed it — and a confirmation ("volume 5 saw this claim again") is worth nothing unless it can be
 * traced to a chapter of volume 5. The stamp is code's, not the model's: it is not in the answer shape the
 * request declares, and an entry that arrives without one (a notebook written before this existed) is
 * filed with its chapter left null and named, not guessed.
 *
 * @param {Array<{segment: {id: string}, entries: Array<Object>}>} chapters - Already in reading order.
 * @returns {Array<Object>}
 */
function consolidateExtraction(chapters) {
  const all = [];
  for (const chapter of chapters) {
    const chapterId = chapter && chapter.segment ? chapter.segment.id : null;
    for (const entry of chapter.entries) {
      if (entry && chapterId && entry.chapter === undefined) all.push({ ...entry, chapter: chapterId });
      else all.push(entry);
    }
  }
  return all;
}

module.exports = {
  EXTRACTION_FILE,
  consolidateExtraction,
};

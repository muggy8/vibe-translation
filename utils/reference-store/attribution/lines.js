/**
 * utils/reference-store/attribution/lines.js — reading the volume's own lines, and what a line is.
 *
 * Every attribution question in this layer is asked against a **line** of the book, not against a row:
 * a claim's `evidence` column only holds the quote, and a quote starts with a bracket whether or not the
 * line it came from does. So the line has to be read rather than inferred. This file is the only place
 * that reads it — the volume's chapters into lines through the store's own volume resolver, the
 * dialogue/narration verdict for one line, the window of lines around a cited one that the reading pass
 * is shown, and the folder those chapter files live in.
 *
 * @module utils/reference-store/attribution/lines
 */

const path = require("path");

const { readChapterLines } = require("../source-chapters");
require("../../../types"); // JSDoc type definitions

/**
 * The opening marks this book uses for a line of dialogue.
 *
 * Kept here rather than inferred from the evidence matcher: the store's quote rules have to match a
 * quote anywhere in a line, while this question is about what the **line itself** is — a line someone
 * is saying, or a line about what is happening.
 *
 * @type {string[]}
 */
const DIALOGUE_OPENERS = ["「", "『", "“", "‘"];

/**
 * Whether a source line is somebody speaking, or narration.
 *
 * The whole rule is the first non-space character. It is coarse on purpose: a line that opens with a
 * bracket is a line the book is presenting as speech, and a line that does not is the narrator's,
 * even when it contains a quoted phrase inside it. Measured against the two real records this
 * classifies 268/574 of volume 01's claims and 488/1030 of volume 02's as quoting a spoken line.
 * That split is printed in the audit report as a fact about the record, and it is **not** a doubt
 * trigger: a claim about how a character speaks routinely cites the narration that describes them,
 * and calling that a misattribution would report half the reference as damaged.
 *
 * @param {string} line
 * @returns {"dialogue"|"narration"}
 */
function lineSpeechKind(line) {
  const text = String(line === undefined || line === null ? "" : line).trimStart();
  return DIALOGUE_OPENERS.some((mark) => text.startsWith(mark)) ? "dialogue" : "narration";
}

/**
 * Read one volume's chapters into lines, through the store's own volume resolver.
 *
 * @param {{resolveVolume: Function}} ctx
 * @param {number} volume
 * @returns {{chapters: Array<{id: string, lines: string[]}>, error: string|null}}
 */
function volumeChapterLines(ctx, volume) {
  const resolved = ctx.resolveVolume(Number(volume));
  if (resolved.error) return { chapters: [], error: resolved.error };
  const out = [];
  for (const chapter of resolved.chapters) {
    const dir = resolved.volumeDir;
    const lines = readChapterLines(dir, chapter.file);
    if (!lines) continue;
    out.push({ id: chapter.id, file: chapter.file, lines });
  }
  return { chapters: out, error: out.length ? null : "no chapter file of this volume could be read" };
}

/**
 * The lines around a cited line, in the order they appear in the book.
 *
 * This is what the detective is shown, and it is bounded for the same reason the graded sample is
 * bounded: an agent that is handed a whole chapter reads a whole chapter, and the question "who is
 * speaking this line" is answered by the lines around it. `radius` is in lines, and the cited line is
 * marked so the answer can quote the passage it actually read.
 *
 * @param {{resolveVolume: Function}} ctx
 * @param {{volume: number, chapter: string, line: number, radius?: number}} opts
 * @returns {{chapter: string, line: number, speechKind: string, window: Array<{line: number, text: string, cited: boolean}>, error: string|null}}
 */
function speakerPassage(ctx, { volume, chapter, line, radius = 12 }) {
  const resolved = ctx.resolveVolume(Number(volume));
  if (resolved.error) return { chapter, line, speechKind: "unknown", window: [], error: resolved.error };
  const chapterRow = resolved.chapters.find((c) => c.id === chapter);
  if (!chapterRow) return { chapter, line, speechKind: "unknown", window: [], error: `chapter "${chapter}" is not in volume ${volume}` };
  const lines = readChapterLines(resolved.volumeDir, chapterRow.file) || [];
  const from = Math.max(0, Number(line) - 1 - radius);
  const to = Math.min(lines.length, Number(line) + radius);
  const window = [];
  for (let i = from; i < to; i += 1) {
    const text = lines[i];
    if (String(text || "").trim() === "") continue;
    window.push({ line: i + 1, text, cited: i + 1 === Number(line) });
  }
  const cited = lines[Number(line) - 1];
  return {
    chapter,
    line: Number(line),
    speechKind: lineSpeechKind(cited),
    window,
    error: null,
  };
}

/**
 * A chapter id → source lines index for one volume, built once per call.
 *
 * The attribution questions are about the cited **line** — is this a line somebody is saying, or a line
 * about what is happening — and a claim's evidence column only holds the quote, which starts with a
 * bracket whether or not the line it came from does. So the line has to be read, not inferred.
 *
 * @param {{resolveVolume: Function}} ctx
 * @param {number} volume
 * @returns {Map<string, string[]>}
 */
function lineIndex(ctx, volume) {
  const read = volumeChapterLines(ctx, volume);
  /** @type {Map<string, string[]>} */
  const index = new Map();
  for (const chapter of read.chapters) index.set(chapter.id, chapter.lines);
  return index;
}

/**
 * The folder a volume's chapters live in, for the detective's file tools.
 *
 * Kept here so the agent's working folder is decided by the same resolver the evidence rule uses,
 * rather than by a caller guessing at a path.
 *
 * @param {{resolveVolume: Function}} ctx
 * @param {number} volume
 * @returns {string|null}
 */
function attributionVolumeDir(ctx, volume) {
  const resolved = ctx.resolveVolume(Number(volume));
  if (resolved.error || !resolved.volumeDir) return null;
  return path.normalize(resolved.volumeDir);
}

module.exports = {
  DIALOGUE_OPENERS,
  lineSpeechKind,
  volumeChapterLines,
  lineIndex,
  speakerPassage,
  attributionVolumeDir,
};

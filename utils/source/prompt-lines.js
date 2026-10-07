/**
 * The lines a task puts in its prompt to tell the agent what it is looking at: the
 * material line (which file, how big, how many chapters), the chapter list, the note
 * about one segment, and the shared context block that describes the bundle and the
 * rules that produced it.
 *
 * Part of the source.js layer (split out of the original single file).
 */

const path = require("path");
require("../../types"); // JSDoc type definitions

/**
 * The "volume source" materials line for a whole-installment prompt.
 *
 * @param {SourceBundle|null} bundle - The resolved bundle (null → null, so
 *   callers can fall back to the legacy folder-name convention in tests).
 * @returns {string|null}
 */
function sourceMaterialLine(bundle) {
  if (!bundle) return null;
  if (bundle.format === "epub") {
    return (
      `- The volume source: "${path.basename(bundle.wholePath)}" ` +
        `(same folder, normalized from "${path.basename(bundle.originalPath)}")`
    );
  }
  return `- The volume source: "${path.basename(bundle.wholePath)}" (same folder)`;
}


/**
 * The materials line listing the chapter files of a chunked (fallback)
 * volume, in reading order.
 *
 * @param {SourceBundle} bundle
 * @returns {string}
 */
function sourceSegmentListLine(bundle) {
  const list = bundle.segments.map((s) => `"${s.file}"`).join(", ");
  return (
    `- The volume source is split into chapters (read them in this order): ${list} (same folder); ` +
      `"${path.basename(bundle.wholePath)}" is their concatenation.`
  );
}


/**
 * The note appended to the one-shot extraction prompts when a volume is
 * processed chapter by chapter (the fallback path).
 *
 * @param {SourceBundle} bundle
 * @param {SourceSegment} segment - The chapter being extracted.
 * @param {number} index - Zero-based position in reading order.
 * @returns {string}
 */
function chapterSegmentNote(bundle, segment, index) {
  return (
    `## Chapter segment note\n` +
      `This volume is processed chapter by chapter (the whole installment is too large for a single pass). ` +
      `The source text you were given is chapter "${segment.id}" (${segment.title}), ` +
      `${index + 1} of ${bundle.segments.length}, in reading order. ` +
      `The cumulative reference material already covers the chapters before it — ` +
      `extract only what this chapter adds or changes.`
  );
}


/**
 * The chapter-context block prepended to the agent turn prompts of a chunked
 * (fallback) volume: names the current chapter and the ordered chapter list.
 *
 * @param {{INSTALLMENT_NUMBER: string}} values - The volume values.
 * @param {SourceBundle} bundle
 * @param {SourceSegment} segment - The chapter the agent is processing.
 * @param {number} index - Zero-based position in reading order.
 * @returns {string}
 */
function chapterContextBlock(values, bundle, segment, index) {
  const list = bundle.segments.map((s) => `"${s.file}"`).join(", ");
  return (
    `Chapter context: you are processing chapter "${segment.id}" (${segment.title}), ` +
      `${index + 1} of ${bundle.segments.length}, of volume ${values.INSTALLMENT_NUMBER}, in reading order. ` +
      `The volume source is split into these chapter files (same folder): ${list}. ` +
      `The cumulative output currently reflects the chapters before this one — ` +
      `carry everything forward unchanged and add only what this chapter contributes.\n\n`
  );
}

// ─── Exports ────────────────────────────────────────────────────────────────


module.exports = {
  sourceMaterialLine,
  sourceSegmentListLine,
  chapterSegmentNote,
  chapterContextBlock,
};

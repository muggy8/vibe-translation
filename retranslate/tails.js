/**
 * The continuity cues a retranslate batch reads.
 *
 * Snapshot every chapter's continuity tail BEFORE the (possibly concurrent) retranslate batch starts.
 * The tail is the previous chapter's ending, used as a flow cue. Reading it lazily inside the batch
 * means a chapter can read a neighbour's draft while that neighbour is mid-rewrite — the cue then
 * depends on worker scheduling (with STAGE_CONCURRENCY > 1 it is a genuine race, and with concurrency
 * 1 it only works by accident). Snapshotting once makes the whole batch see the same book, and the
 * batch's own output is deliberately not fed back into it.
 *
 * Part of the retranslate.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");
const { tailOf } = require("../utils/translate");
const { chapterArtifactNames } = require("../translate");

/**
 * @param {{segments: Array<{id: string}>}} bundle
 * @param {string} volumeDir
 * @param {number} chars - How many chars of each ending to keep.
 * @param {{text: string, fromLabel: string}} [incomingTail] - The previous VOLUME's published ending (for the first chapter).
 * @returns {Promise<Map<string, {text: string, source: string}>>} segment id → the cue text and an honest label of where it came from.
 */
async function snapshotContinuityTails(bundle, volumeDir, chars, incomingTail) {
  const tails = new Map();
  if (chars <= 0) return tails;
  for (let idx = 0; idx < bundle.segments.length; idx++) {
    if (idx === 0) {
      // The volume's first chapter continues from the previous VOLUME's ending (when one is
      // available) — not from nothing.
      tails.set(bundle.segments[idx].id, {
        text: incomingTail && incomingTail.text ? incomingTail.text : "",
        source: incomingTail && incomingTail.text
          ? `the end of the previous volume (${incomingTail.fromLabel || "the previous volume"})`
          : "",
      });
      continue;
    }
    const { draftFile } = chapterArtifactNames(bundle.segments[idx - 1].id);
    let prevDraft = "";
    try {
      prevDraft = await fs.readFile(path.join(volumeDir, draftFile), "utf8");
    } catch {
      prevDraft = "";
    }
    tails.set(bundle.segments[idx].id, {
      text: prevDraft.trim() ? tailOf(prevDraft, chars) : "",
      source: prevDraft.trim() ? `the previous chapter (${bundle.segments[idx - 1].id})` : "",
    });
  }
  return tails;
}

module.exports = { snapshotContinuityTails };

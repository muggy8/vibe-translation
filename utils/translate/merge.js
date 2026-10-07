/**
 * Assembling a volume from its per-chapter files, and the text-level helpers the
 * assembly and the continuity tail depend on.
 *
 * resolvePublishedChapterTexts is ONE rule for "what this volume publishes", shared
 * by the merge, the rendering-variant scan and the cross-chapter audit, so the
 * reports and the book cannot describe different texts (gotcha 46). A polished file
 * is published only when it was produced from the CURRENT draft.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const path = require("path");

const { residueRatio } = require("./qa");
const { chapterArtifactNames } = require("./state");
const { readFileOrEmpty } = require("./internal");

/**
 * Which segments have no text to merge — the completeness check behind the
 * merged volume.
 *
 * mergeVolumeTranslation skips a chapter with no text (it cannot invent one),
 * which is exactly how a volume used to end up published as `translation.md`
 * with chapters silently missing from the middle: the file looked complete,
 * the merge reported success, and nothing said that chapter 7 never got
 * translated.
 *
 * @param {Array<{id: string, title?: string}>} segments - The volume's chapters in reading order.
 * @param {(seg: {id: string}) => string|null} getText
 * @returns {Array<{id: string, title: string}>} The segments with no text.
 */
function findMissingSegments(segments, getText) {
  const missing = [];
  for (const seg of segments || []) {
    const text = (getText(seg) || "").trim();
    if (!text) missing.push({ id: seg.id, title: seg.title || seg.id });
  }
  return missing;
}


/**
 * Merge a volume's per-chapter texts into the single `translation.md` file
 * (chapter heading + text, in segment reading order).
 *
 * @param {{segments: Array<{id: string, title: string}>, getText: (seg: {id: string}) => string|null}} p
 *   `getText(seg)` returns the chapter text to merge (the polished text when
 *   present, otherwise the draft) or null to skip the segment.
 * @returns {string} The merged volume text ("" when nothing to merge).
 */
function mergeVolumeTranslation({ segments, getText, getNote, sourceLanguage, targetLanguage, languages }) {
  const parts = [];
  for (const seg of segments) {
    const text = (getText(seg) || "").trim();
    if (!text) continue;
    const heading = headingForSegment(seg, text, {
      sourceLanguage: sourceLanguage || (languages && languages.sourceLanguage),
      targetLanguage: targetLanguage || (languages && languages.targetLanguage),
    });
    const note = ((getNote && getNote(seg)) || "").trim();
    parts.push([heading, note || null, text].filter(Boolean).join("\n\n"));
  }
  return parts.length > 0 ? parts.join("\n\n") + "\n" : "";
}


/**
 * The heading the merged book puts above one chapter — or none.
 *
 * Three cases the old rule got wrong:
 *   - The chapter text already begins with a heading (the translator rendered the
 *     title that was in the source). Prepending the source-language title on top
 *     produced TWO headings, one of them untranslated.
 *   - The segment's "title" is only a file name (a plain-text volume) or a
 *     pipeline label ("Part 3 of 12"). Printing it makes the published book open
 *     with `# test_story(1).md`.
 *   - A real declared title with no heading in the text: print it. That is the
 *     one case a heading is correct.
 *
 *   - A title written in the SOURCE language. When the translator rendered the
 *     title in its own way (a bold line, or nothing at all), printing the source
 *     title above it puts an untranslated Japanese line at the top of an English
 *     book. With the pair supplied, a title that still carries source-script
 *     characters is not printed.
 *
 * @param {{title?: string, syntheticTitle?: boolean}} seg
 * @param {string} text - The chapter's published text.
 * @param {{sourceLanguage?: string, targetLanguage?: string}} [languages] - The pair, used to reject a source-language title.
 * @returns {string|null} The heading line, or null when the chapter gets none.
 */
function headingForSegment(seg, text, languages = {}) {
  const firstLine = (text || "").trim().split("\n", 1)[0] || "";
  if (/^#{1,6}\s+\S/.test(firstLine)) return null;
  if (!seg || !seg.title || !seg.title.trim() || seg.syntheticTitle) return null;
  const title = seg.title.trim();
  if (languages.sourceLanguage && languages.targetLanguage) {
    const residue = residueRatio(title, languages.sourceLanguage, languages.targetLanguage);
    if (residue > 0) return null;
  }
  return `# ${title}`;
}

// ─── Output cleanup ─────────────────────────────────────────────────────────


/**
 * Defensively strip a full-text markdown code fence some models add around
 * their output (Hy-MT2 is prompted not to, but a stray fence would corrupt
 * the merged volume). Only strips when the WHOLE output is fenced.
 *
 * @param {string} text
 * @returns {string} The cleaned text.
 */
function stripMarkdownFence(text) {
  if (typeof text !== "string") return "";
  const t = text.trim();
  const m = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}


/**
 * The tail of a text for the continuity context passed to the next chapter
 * (the previous chapter's ending, quoted in the translate prompt).
 *
 * @param {string} text
 * @param {number} [maxChars] - Maximum tail length (default: 400; 0 = off,
 *   returns "" — TRANSLATE_CONTINUITY_CHARS=0 disables the continuity tail).
 * @returns {string} The trimmed tail ("" for empty input or maxChars = 0).
 */
function tailOf(text, maxChars = 400) {
  const t = (text || "").trim();
  if (!t) return "";
  const parsed = parseInt(maxChars, 10);
  const max = Number.isFinite(parsed) ? Math.max(0, parsed) : 400;
  if (max === 0) return ""; // explicit "off"
  return t.length > max ? "…" + t.slice(-max) : t;
}

// ─── Translation state (per-volume idempotency) ────────────────────────────


/**
 * Strip the prefix of `nextPart` that duplicates the tail of `prevPart`.
 *
 * When a chapter part is translated with the previous part's ending as
 * continuity context, the model sometimes REPEATS that ending at the start
 * of its reply (continuation behaviour), which would leave a duplicated
 * passage in the merged draft. This is the deterministic backstop: if the
 * new part starts with at least minOverlap characters that exactly match
 * the end of the previous part, that overlap is cut from the new part.
 * Only exact matches are stripped (never fuzzy) — anything else is left to
 * the QA checks, so a legitimate re-phrase can never be mangled.
 *
 * @param {string} prevPart - The previous part's (cleaned) text.
 * @param {string} nextPart - The new part's (cleaned) text.
 * @param {number} [minOverlap=50] - Minimum duplicated characters for a
 *   strip to happen (shorter coincidental matches are kept).
 * @returns {string} The new part with the duplicated prefix removed.
 */
function stripContinuityOverlap(prevPart, nextPart, minOverlap = 50) {
  if (!prevPart || !nextPart) return nextPart || "";
  const prev = prevPart.replace(/\s+$/, "");
  const next = nextPart;
  const maxLen = Math.min(prev.length, next.length, 4000);
  for (let len = maxLen; len >= minOverlap; len--) {
    if (next.startsWith(prev.slice(-len))) {
      return next.slice(len).replace(/^\s+/, "");
    }
  }
  return next;
}


/**
 * Resolve the text each chapter of a volume ACTUALLY publishes — the same rule
 * `mergeVolumeTranslation` uses (accepted polish wins when it was produced from
 * the current draft, otherwise the draft), exposed as a list so the volume-level
 * checks read exactly what the reader reads.
 *
 * Without this, the cross-chapter audit and the variant scan would judge one
 * text while `translation.md` published another.
 *
 * @param {string} volumeDir
 * @param {{segments: Array<Object>}} bundle
 * @param {{chapters?: Object}} state - The translation state (may be empty).
 * @returns {Promise<Array<{id: string, title: string, syntheticTitle?: boolean, file: string, text: string, from: "draft"|"polished"|"none"}>>}
 */
async function resolvePublishedChapterTexts(volumeDir, bundle, state) {
  const chapters = (state && state.chapters) || {};
  const out = [];
  for (const seg of bundle.segments) {
    const { draftFile, polishedFile } = chapterArtifactNames(seg.id);
    const entry = chapters[seg.id] || {};
    let text = "";
    let from = "none";
    if (entry.draftHash && entry.polishedDraftHash === entry.draftHash) {
      const polished = await readFileOrEmpty(path.join(volumeDir, polishedFile));
      if (polished.trim()) {
        text = polished.trim();
        from = "polished";
      }
    }
    if (!text) {
      const draft = await readFileOrEmpty(path.join(volumeDir, draftFile));
      if (draft.trim()) {
        text = draft.trim();
        from = "draft";
      }
    }
    out.push({
      id: seg.id,
      title: seg.title,
      syntheticTitle: seg.syntheticTitle === true,
      file: seg.file,
      text,
      from,
    });
  }
  return out;
}

// ─── Targeted correction (fix the passage, not the chapter) ─────────────────


module.exports = {
  findMissingSegments,
  mergeVolumeTranslation,
  headingForSegment,
  stripMarkdownFence,
  tailOf,
  stripContinuityOverlap,
  resolvePublishedChapterTexts,
};

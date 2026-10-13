/**
 * The extraction stage: one one-shot call per chapter (source → the quirk/POV JSON array), plus the
 * two pure helpers that call needs — the parser for the answer, and the relevance-ordered truncation
 * of the cumulative reference the extractor is shown.
 *
 * The compile turn that used to sit here (an author agent writing `character-voice.md` and
 * `pov-map.md`) went with the author route. The stage's one route renders both artifacts from the
 * volume's reference record, so nothing in this file hands a document to a model.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const harness = require("../harness");
const { inlineReferenceMessage } = require("../utils/fs");
const { selectSectionsByRelevance } = require("../utils/prompt");
const { chapterSegmentNote } = require("../utils/source");

const { VOICE_REF_TRUNCATION_MAX_ENTRIES, VOICE_REF_TRUNCATION_THRESHOLD } = require("./config");

/**
 * Run the extraction stage: one-shot call to extract voice quirks and POV info from one chapter.
 *
 * The stage reads every volume chapter by chapter, so `seg` is not a fallback mode — it is the normal
 * shape of the call. `si` is the chapter's zero-based position in reading order.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {SourceSegment} seg - The chapter being extracted.
 * @param {number} si - Zero-based position in reading order.
 * @param {{stateFile?: string|null, extraNote?: string|null, thinkingLevel?: string|null}} [opts]
 *   What this pass is shown as the cumulative reference, what else it is told, and at what reasoning
 *   level it runs.
 *
 *   `stateFile`, when the key is present (a path, or `null` for "show nothing"), replaces the stage's
 *   chain. The stage shows every chapter the **previous volume's** published reference: nothing in this
 *   route writes `character-voice.md` until the record is rendered, and handing chapter 4 a file the
 *   previous chapter did not write would be handing it a file that does not exist. `extract-voice.js`
 *   passes the same thing for the same reason. The name the reference is given follows the file, not
 *   the chapter number, so a pass is not labelled as a document it is not.
 *
 *   `extraNote` is appended after the chapter segment note. It exists because that note asserts "the
 *   cumulative reference material already covers the chapters before it", which is only true of a pass
 *   that has been compiling as it went; a reading-only pass has to say what its own earlier chapters
 *   produced instead, or the instruction it gives the extractor is false.
 *
 *   `thinkingLevel`, when given, is the reasoning level THIS call runs at. It exists for the reading
 *   pass's retry of a cut-off chapter (`character-voice/reading.js`): the level is chosen by code and
 *   recorded beside the attempt it produced, not left to the operator to remember to set. Omitted, the
 *   call runs at the run's own `AI_THINKING_LEVEL`, exactly as before.
 * @returns {Promise<string>}
 */
async function runExtract(ctx, seg, si, opts = {}) {
  const { values } = ctx;
  const thinking = opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {};
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running voice/POV extraction for chapter ${seg.id}...`);
  const messages = [{ file: path.join(ctx.volumeDir, seg.file), name: seg.file }];
  const stateFile = Object.prototype.hasOwnProperty.call(opts, "stateFile") ? opts.stateFile : ctx.previousVoiceRefFile;
  if (stateFile) {
    // Inlined (not readFile) — so the cumulative reference is bounded here.
    // Relevance-ordered: the characters this chapter actually contains are
    // shown even when they were introduced in volume 1 (see truncateVoiceRef).
    const chapterSource = await fs.readFile(path.join(ctx.volumeDir, seg.file), "utf8");
    messages.push(
      await inlineReferenceMessage(
        stateFile,
        stateFile === ctx.previousVoiceRefFile ? "character-voice-previous.md" : "character-voice-current.md",
        { truncate: (raw) => truncateVoiceRef(raw, chapterSource) }
      )
    );
  }
  messages.push({ text: ctx.extractPrompt }, { text: chapterSegmentNote(ctx.bundle, seg, si) });
  if (opts.extraNote) messages.push({ text: opts.extraNote });
  return harness.runOneShot({
    systemPrompt: ctx.extractSystemPrompt,
    messages,
    label: `character-voice-extract-${values.INSTALLMENT_NUMBER}-${seg.id}`,
    ...thinking,
  });
}


// ─── Why this read pass asks for no answer shape ─────────────────────────────
//
// It used to declare one beside `parseVoiceQuirks`, and it was measured against the endpoint this
// pipeline is configured against on 2026-10-13: the request was refused before the model was asked —
// HTTP 400 in 161 ms, 0 tokens, "response_format schema must accept only JSON objects at its root
// (type object, or anyOf/oneOf of object schemas)". The schema that produced it was
// `{ type: "array", items: { type: "object", … } }`, which is the shape this call answers in, so a
// chapter's extraction cannot be shaped as itself. `ai/one-shot.js` now refuses an array-rooted schema
// before it is sent, because shipping one means every chapter of every volume fails at the HTTP layer.
//
// What the shape was for is still here, and it is the part the measurement says matters:
// `character-voice/reading.js` re-asks a chapter whose answer never reached its closing bracket, and a
// chapter that never answers is named in `character-voice-reading.md` and in the report the grader reads.
//
// The envelope that WOULD be expressible — the same item list under an object root — is written up as a
// decision rather than taken: `/tmp/opencode/json-schema-questions.md`. Adopting it means changing what
// `system-prompts/character-voice-extract.md` tells the model to write, and the key inventory this file
// could not measure (no real voice extraction answer is on disk anywhere in the series folder).


/**
 * Truncate a character voice reference if it exceeds the threshold.
 *
 * "Show the last N sections" was wrong for the same reason it is wrong for the glossary: the sections
 * are one per CHARACTER, and the volume-1 cast sits at the top of the document forever. At volume 17
 * the extractor was shown a reference with the protagonists missing and rediscovered them as new
 * characters. The selection is now relevance-ordered — every character whose name occurs in the volume
 * being processed is kept, whatever position they hold in the file (see selectSectionsByRelevance in
 * utils/prompt.js).
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


/**
 * Parse the AI's extraction output into an array of voice quirk / POV entries.
 *
 * Deliberately strict about the array: `character-voice/reading.js` decides from this whether an
 * answer arrived whole, and a parser that invented an empty array out of a half-written one would hide
 * the cut-off. The tolerant, object-by-object reader lives there, on top of this one.
 *
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
  runExtract,
  truncateVoiceRef,
  parseVoiceQuirks,
};

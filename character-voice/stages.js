/**
 * The extraction stage: one one-shot call per chapter (source → the quirk/POV JSON array), plus the
 * parser for that answer and the truncation helper the cumulative stages share.
 *
 * The compile turn that used to sit here (an author agent writing `character-voice.md` and
 * `pov-map.md`) went with the author route. The stage's one route renders both artifacts from the
 * volume's reference record, so nothing in this file hands a document to a model — and since plan 06
 * slice 2 neither does the chapter call: what it is shown as "already known" is the `knownBlock`
 * `character-voice/known-facts.js` built out of the volume's record, not the previous volume's
 * `character-voice.md`.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types");
const harness = require("../harness");
const { selectSectionsByRelevance } = require("../utils/prompt");
const { chapterSegmentNote } = require("../utils/source");

const {
  VOICE_REF_TRUNCATION_MAX_ENTRIES,
  VOICE_REF_TRUNCATION_MAX_CHARS,
  VOICE_REF_TRUNCATION_THRESHOLD,
} = require("./config");

/**
 * Run the extraction stage: one-shot call to extract voice quirks and POV info from one chapter.
 *
 * The stage reads every volume chapter by chapter, so `seg` is not a fallback mode — it is the normal
 * shape of the call. `si` is the chapter's zero-based position in reading order.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {SourceSegment} seg - The chapter being extracted.
 * @param {number} si - Zero-based position in reading order.
 * @param {{knownBlock?: string|null, extraNote?: string|null, thinkingLevel?: string|null}} [opts]
 *   What this pass is shown as already known, what else it is told, and at what reasoning level it runs.
 *
 *   `knownBlock` is the **query result** `character-voice/known-facts.js` built from this volume's open
 *   reference record: the record's current claims for the characters this chapter's own text names. It
 *   replaced the inlined previous volume's `character-voice.md`. The reason is a measurement, not a
 *   preference — the document path could not be bounded (a 196-section / 351,771-byte reference came back
 *   from `truncateVoiceRef` unchanged, because the picker's cap is a section count and 196 ≤ 200), and a
 *   render is not the truth: the file on disk still asserts what the record has since replaced. A pass
 *   with no record is refused by `character-voice/reading.js` before it reaches this function, so there
 *   is no "no reference" branch here that pretends the call is the same call.
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
  if (opts.knownBlock) messages.push({ text: opts.knownBlock });
  messages.push({ text: ctx.extractPrompt }, { text: chapterSegmentNote(ctx.bundle, seg, si) });
  if (opts.extraNote) messages.push({ text: opts.extraNote });
  return harness.runOneShot({
    systemPrompt: ctx.extractSystemPrompt,
    messages,
    label: `character-voice-extract-${values.INSTALLMENT_NUMBER}-${seg.id}`,
    responseFormat: voiceResponseFormat(),
    ...thinking,
  });
}


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
 * **It is no longer on the voice read path** (plan 06 slice 2, 2026-10-14): a chapter's call is shown
 * the query result `character-voice/known-facts.js` builds from the volume's record, not this document.
 * It stays exported and tested because it is still the window a cumulative voice reference would be
 * shown through, and because deleting a guard because nothing calls it today is not this slice's call.
 * What was fixed here is the bound itself: the cap was a **section count** (200) and this series' roster
 * is 196 entries, one section each, so the picker ran and returned the document whole — measured
 * 2026-10-14 at 351,771 bytes in → 351,771 bytes out, `kept=196 dropped=0 truncated=false`. It now packs
 * whole sections into a character budget as well, which is the shape `utils/translate/references.js` has
 * always used.
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
    maxChars: VOICE_REF_TRUNCATION_MAX_CHARS,
    unitLabel: "character section(s)",
  });
  return picked.content;
}


// ─── The answer shape this read pass asks for ────────────────────────────────
//
// Declared beside {@link parseVoiceQuirks}, in the module that owns the parser, so the request the endpoint
// is given and the answer the stage accepts cannot drift apart (`test/prompt-audit.js`'s `data-answer-shape`
// rule compares the wire against this function, imported, not copied).
//
// The root is an OBJECT holding the list, because the array-rooted version of this schema was measured
// against this endpoint on 2026-10-13 and the request was refused before the model was asked — HTTP 400 in
// 161 ms, 0 tokens, "response_format schema must accept only JSON objects at its root (type object, or
// anyOf/oneOf of object schemas)". `ai/one-shot.js`'s `assertShapeIsExpressible` refuses such a schema
// before it is sent (AGENTS.md gotcha 138).
//
// ## Why this shape is NOT closed, when the glossary's and the style guide's are
//
// `additionalProperties` is deliberately left unset here, and `strict` is deliberately absent. The other
// two prompts name their element's keys and their own examples produce exactly those keys, so their closed
// schemas describe a contract that has been read off the prompt. This one has not:
//
//   - **No real voice extraction answer exists on disk anywhere in the series folder**, so the key
//     inventory cannot be measured from a real artifact — it can only be read off the prompt.
//   - **The prompt contradicted itself.** Its `pov` element block named eight keys and its own final example
//     produced a `pov` object carrying `description`, which that block does not name (and omitting `examples`
//     and `notes`). That contradiction is fixed in the prompt — `description` is now declared — but it is the
//     evidence for the rule: a prompt this repository has been shipping has been showing its model a key its
//     own key list did not name.
//   - **A closed schema is the one shape that can cost a chapter.** `additionalProperties: false` says: an
//     element carrying a key this inventory does not hold is not an answer. On a grammar-constrained endpoint
//     that key is then never written; on one that checks after generating, the whole reply is refused and
//     `character-voice/reading.js` loses every claim in it. The envelope exists to stop a chapter's worth of
//     claims being thrown away; a schema that trades that risk back is the wrong envelope for this stage.
//
// So this shape guarantees the one thing the measurement says matters — the answer is an object holding an
// array of objects that each name a `type`, and it closes — and leaves every other key to the parser and to
// the reference store's own filing doors, which is where those rules already live and are already reported.
// `test/test-answer-envelopes.js` pins that the closed glossary/style shapes and this open one are different
// on purpose, so neither drifts into the other.

/**
 * The keys `system-prompts/character-voice-extract.md` names for its two element kinds, plus the ones its
 * own example answer produces. Read off the prompt, because no real extraction answer is on disk to read
 * them off of.
 *
 * Declared voice keys: `type`, `character`, `quirkType`, `description`, `examples`, `axis`, `value`,
 * `notes`. Declared POV keys: `type`, `povCategory`, `marker`, `description`, `assignedCharacter`,
 * `narrationType`, `sectionDescription`, `examples`, `notes`. The example voice object produces exactly
 * the eight declared voice keys; the example POV object produces `type`, `povCategory`, `marker`,
 * `description` — and `description` is the one that was missing from the declared POV list until the
 * envelope slice.
 *
 * ## What moved when the prompt stopped naming a language (plan 06 slice 4)
 *
 * `formalityLevel` is **out**. It was one of five words, four of them the name of one language's
 * politeness categories, and a book that is not that book's had no value to put in it. The pair that
 * replaced it is `axis` / `value`: the question the claim answers and the answer this series declared
 * for it, both read from the series' own plan of record and appended to the prompt by
 * `character-voice/prompts.js`. The pair is what `utils/reference-store/extraction-adapter.js` carries
 * into `facts.axis` / `facts.axis_value`, and the filing gate is what refuses a value the series never
 * declared — which is why the pair is declared on the wire but **not** closed into an enumeration here:
 * the value set belongs to the series, and a set in this file would be the axis list the owner forbade.
 *
 * @type {string[]}
 */
const VOICE_ENTRY_KEYS = [
  "type",
  "character",
  "quirkType",
  "description",
  "examples",
  "axis",
  "value",
  "notes",
  "povCategory",
  "marker",
  "assignedCharacter",
  "narrationType",
  "sectionDescription",
];

/**
 * The `response_format` the voice/POV extraction asks this endpoint for.
 *
 * An object root holding one array, `entries`, whose elements each carry a `type`. Open on purpose — see
 * the block comment above this function for the three reasons, of which the load-bearing one is that a
 * closed schema here is the one shape that can lose a chapter's worth of claims.
 *
 * @returns {{type: "json_schema", json_schema: {name: string, schema: Object}}}
 */
function voiceResponseFormat() {
  const properties = {};
  for (const key of VOICE_ENTRY_KEYS) {
    properties[key] = key === "examples" ? { type: "array", items: { type: "string" } } : { type: "string" };
  }
  return {
    type: "json_schema",
    json_schema: {
      name: "voice_pov_extraction",
      schema: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties,
              required: ["type"],
            },
          },
        },
        required: ["entries"],
      },
    },
  };
}

/**
 * Pull the claim array out of the answer, in whichever of the forms it arrived.
 *
 * The envelope the request asks for is `{"entries": […]}`. Also read, because a server that ignores
 * `response_format` answers in whatever form its prompt used to ask for:
 *   - the bare JSON array the prompt asked for until this slice;
 *   - `{"voice": […], "pov": […]}`, which is the shape a model reaches for when a prompt opens by telling
 *     it to "produce two outputs" — concatenated in that order, because the reading pass and the record do
 *     not care which array a claim came out of, only which `type` it carries.
 *
 * @param {string} text - The answer, already fence-stripped.
 * @returns {Array<Object>|null} The entries, or null when this answer holds no claim array at all.
 */
function claimArrayFromAnswer(text) {
  /**
   * Parse one candidate span, or return undefined when it is not JSON.
   * @param {string} span
   * @returns {Object|undefined}
   */
  const tryJson = (span) => {
    try {
      return JSON.parse(span);
    } catch {
      return undefined;
    }
  };
  /**
   * Is this value an answer — a bare array, an object holding an `entries` array, or an object holding the
   * two arrays a model writes when it reads the prompt's "two outputs" literally?
   * @param {Object} value
   * @returns {Array<Object>|null}
   */
  const asList = (value) => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value.entries)) return value.entries;
    if (Array.isArray(value.voice) || Array.isArray(value.pov)) {
      return [...(Array.isArray(value.voice) ? value.voice : []), ...(Array.isArray(value.pov) ? value.pov : [])];
    }
    return null;
  };

  const whole = tryJson(text);
  if (whole !== undefined) {
    const list = asList(whole);
    if (list) return list;
  }
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    const list = asList(tryJson(text.slice(objStart, objEnd + 1)));
    if (list) return list;
  }
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    const list = asList(tryJson(text.slice(arrStart, arrEnd + 1)));
    if (list) return list;
  }
  return null;
}

/**
 * Parse the AI's extraction output into an array of voice quirk / POV entries.
 *
 * Deliberately strict about the array: `character-voice/reading.js` decides from this whether an
 * answer arrived whole, and a parser that invented an empty array out of a half-written one would hide
 * the cut-off. The tolerant, object-by-object reader lives there, on top of this one.
 *
 * Reads the `{"entries": […]}` envelope the request asks for, the bare array the prompt asked for until
 * this slice, and `{"voice": […], "pov": […]}`.
 *
 * @param {string} output - The raw AI output.
 * @returns {Array<Object>}
 * @throws {Error} When the answer holds no array of entries in any of those forms.
 */
function parseVoiceQuirks(output) {
  if (!output || typeof output !== "string") return [];
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  const parsed = claimArrayFromAnswer(text);
  if (parsed === null) {
    throw new Error(
      "No JSON array found in the character-voice extraction output: the answer is neither a JSON array " +
        'nor an object holding an "entries" array.'
    );
  }
  return parsed.filter((entry) => entry && typeof entry.type === "string");
}



module.exports = {
  runExtract,
  truncateVoiceRef,
  parseVoiceQuirks,
  voiceResponseFormat,
  VOICE_ENTRY_KEYS,
};

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
 * feedback passes, whole and per-chapter. (The glossary and voice stages used to have
 * the same instruction; both went with their author routes, which are gone —
 * `75e59a7` and `294351c`): the cumulative
 * document is edited IN PLACE, and the
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


// ─── The answer shape this extraction call asks for ──────────────────────────
//
// Declared beside {@link parseStyleObservations}, in the module that owns the parser, so the request the
// endpoint is given and the answer the stage accepts cannot drift apart (`test/prompt-audit.js`'s
// `data-answer-shape` rule compares the wire against this function, imported, not copied).
//
// The root is an OBJECT holding the list. The array-rooted version of this same schema was measured against
// this endpoint on 2026-10-13 and the request was refused before the model was asked — HTTP 400 in 161 ms,
// 0 tokens, "response_format schema must accept only JSON objects at its root (type object, or anyOf/oneOf
// of object schemas)" — and `ai/one-shot.js`'s `assertShapeIsExpressible` refuses such a schema before it is
// sent (AGENTS.md gotcha 138).
//
// `strict: true` + `additionalProperties: false` is the combination the four acceptance graders already send
// to this endpoint successfully, and it is safe here for a reason specific to this prompt:
// `system-prompts/style-guide-extract.md` names exactly six keys for an element and its own example produces
// exactly those six, so the closed shape describes the contract the prompt already states rather than
// guessing at one. (The voice stage's shape is deliberately NOT closed, for the reasons in
// `character-voice/stages.js`; the two are separate contracts and neither borrows the other's looseness.)

/**
 * The `response_format` the style-construct extraction asks this endpoint for.
 *
 * An object root holding the construct array. The six properties are the six keys
 * `system-prompts/style-guide-extract.md` names, with `category` and `frequency` enumerated to the values
 * that prompt lists — which is what makes the closed shape a description rather than a constraint the
 * prompt never asked for.
 *
 * @returns {{type: "json_schema", json_schema: {name: string, strict: boolean, schema: Object}}}
 */
function styleResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "style_constructs",
      strict: true,
      schema: {
        type: "object",
        properties: {
          constructs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                category: {
                  type: "string",
                  enum: [
                    "honorific", "pronoun", "particle", "internalMonologue", "onomatopoeia", "interjection",
                    "povMarker", "sceneBreak", "tense", "punctuation", "wordplay", "note", "other",
                  ],
                },
                pattern: { type: "string" },
                description: { type: "string" },
                examples: { type: "array", items: { type: "string" } },
                frequency: { type: "string", enum: ["high", "medium", "low"] },
                notes: { type: "string" },
              },
              required: ["category", "pattern", "description", "examples", "frequency", "notes"],
              additionalProperties: false,
            },
          },
        },
        required: ["constructs"],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Pull the construct array out of the answer, in whichever of the two forms it arrived.
 *
 * The envelope (`{"constructs": […]}`) is what the request asks for. The bare array is still read, because
 * a server that ignores `response_format` answers in the form its prompt used to ask for.
 *
 * @param {string} text - The answer, already fence-stripped.
 * @returns {Array<Object>|null} The entries, or null when this answer holds no construct array at all.
 */
function constructArrayFromAnswer(text) {
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
   * Is this value an answer — a bare array, or an object holding a `constructs` array?
   * @param {Object} value
   * @returns {Array<Object>|null}
   */
  const asList = (value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray(value.constructs)) return value.constructs;
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
 * Parse the AI's extraction output into an array of style-construct entries.
 *
 * Reads the `{"constructs": […]}` envelope the request asks for and the bare JSON array the prompt asked
 * for until this slice, and tolerates markdown fences and surrounding prose either way.
 *
 * @param {string} output - The raw AI output.
 * @returns {Array<Object>}
 * @throws {Error} When the answer holds no array of constructs in either form.
 */
function parseStyleObservations(output) {
  if (!output || typeof output !== "string") return [];
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  const parsed = constructArrayFromAnswer(text);
  if (parsed === null) {
    throw new Error(
      "No JSON array found in the style-guide extraction output: the answer is neither a JSON array nor " +
        'an object holding a "constructs" array.'
    );
  }
  return parsed.filter((entry) => entry && typeof entry.category === "string");
}


module.exports = {
  styleWriteInstruction,
  styleRecoveryPrompt,
  styleAuthorMaxSteps,
  parseStyleObservations,
  styleResponseFormat,
};

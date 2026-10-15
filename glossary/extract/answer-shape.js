/**
 * glossary/extract/answer-shape.js — the one job: declare the answer shape the term-list call asks for.
 *
 * Declared beside {@link parseTerms} (`glossary/extract/answer.js`), in the same layer, so the request the
 * endpoint is given and the answer the stage accepts cannot drift apart (`test/prompt-audit.js`'s
 * `data-answer-shape` rule compares the wire against this function, imported, not copied).
 *
 * The root is an OBJECT holding the list, not the list itself. That is a measurement, not a style choice:
 * the array-rooted version of this same schema was replayed against the endpoint this pipeline is
 * configured against on 2026-10-13 (`glossary-terms-01-ch5`, run log `2026-10-13T12-45-22-158Z`) and the
 * request was refused before the model was asked — HTTP 400 in 161 ms, 0 tokens, `code:
 * structured_output_failed`, "response_format schema must accept only JSON objects at its root (type
 * object, or anyOf/oneOf of object schemas)". `ai/one-shot.js`'s `assertShapeIsExpressible` refuses such a
 * schema before it is ever sent. OpenAI's structured outputs require the same root, so this is not a quirk
 * of one server (AGENTS.md gotcha 138).
 *
 * The envelope is what makes the answer CLOSE. Measured on the very chapter that lost its terms: the same
 * item list under an object root came back `finish_reason=stop` with the whole reply parseable, 36,538
 * tokens in 42.9 s, against the unshaped call's 73,330 tokens in 170.8 s of prose. It is not a promise of
 * a *richer* answer — that probe found 2 terms where the rambling answer had listed 5, and extraction
 * yield is model variance (gotcha 122).
 *
 * `strict: true` + `additionalProperties: false` is the combination the four acceptance graders already
 * send to this endpoint successfully, and this prompt names exactly five keys per term and five per
 * revision and its own examples produce exactly those — so the closed shape is describing the contract
 * rather than guessing at one. Strict mode is also why BOTH lists sit in the root `required` array: a
 * property declared outside `required` is a schema a strict server may refuse, so the request asks for
 * both lists and {@link parseTermAnswer} is what tolerates an answer that carries only one. The voice
 * stage's shape is deliberately NOT closed, for the reason recorded in `character-voice/stages.js`.
 *
 * What this read pass ALSO has, and what actually fixed the defect before the envelope existed:
 * `readTermList` re-asks a failed read once, and a read that never produced a list comes back as
 * `failed: true` and named, instead of arriving as `[]`.
 */

require("dotenv").config();
require("../../types"); // JSDoc type definitions

/**
 * The `response_format` the term-list call asks this endpoint for.
 *
 * An object root holding TWO arrays: `terms` (the new rows) and `revisions` (this volume's answer to a
 * row an earlier volume already published). An object root because this endpoint refuses a JSON Schema
 * whose root is an array before it generates. Every property of every item is in its `required` list
 * because `strict: true` is a promise the schema is closed — a property declared outside `required`
 * under strict mode is a schema the server may refuse, and this endpoint already refuses one bad root
 * with HTTP 400 and 0 tokens (gotcha 138). That is why `revisions` is required on the WIRE while
 * {@link parseTermAnswer} still reads an answer that omits it: asking for both lists and tolerating one
 * is the reader's job, not the request's.
 *
 * The five `terms` properties are the five keys `system-prompts/glossary-terms.md` names, and the
 * prompt's own example produces exactly those five — which is what makes `additionalProperties: false`
 * a description of the contract rather than a guess at one. `rendering` is required because the read
 * pass is the only place on this route that can supply one, and the filing door refuses a row without
 * it. The five `revisions` properties are the five the prompt's revision block names, and `quote` is
 * among them because a revision without a line this volume's own text prints is refused at the filing
 * door (`utils/reference-store/glossary-adapter.js`), so asking for it is what makes the refusal rare
 * rather than automatic.
 *
 * @returns {{type: "json_schema", json_schema: {name: string, strict: boolean, schema: Object}}}
 */
function termsResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "glossary_new_terms",
      strict: true,
      schema: {
        type: "object",
        properties: {
          terms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                term: { type: "string" },
                rendering: { type: "string" },
                note: { type: "string" },
                type: { type: "string", enum: ["character", "place", "item", "faction", "concept"] },
                query: { type: "string" },
              },
              required: ["term", "rendering", "note", "type", "query"],
              additionalProperties: false,
            },
          },
          revisions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                term: { type: "string" },
                rendering: { type: "string" },
                note: { type: "string" },
                quote: { type: "string" },
                reason: { type: "string" },
              },
              required: ["term", "rendering", "note", "quote", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["terms", "revisions"],
        additionalProperties: false,
      },
    },
  };
}

module.exports = { termsResponseFormat };

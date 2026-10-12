/**
 * utils/reference-store/narrator.js — the answer that is not a character.
 *
 * "The narrator said this" is a real answer to "who is speaking", and in a novel written in the first
 * person it is the answer more often than not. A record that cannot hold it forces every quoted claim
 * to belong to a person, and a record that holds it as a *roster entry* is worse: the coverage rule
 * counts rows in `cast`, so a character called `narrator` becomes a character the reference is required
 * to cover and the presence measurement is required to find in the text — two questions with no answer,
 * reported on every volume until somebody deletes the row.
 *
 * So the narrator is a **claim with no roster entry**, which is the shape this store already uses for a
 * claim whose subject it refuses to invent (migration 6), and it is refused as a key. That is the whole
 * content of this file, which is why it is a leaf: `cast.js` needs the refusal and `attribution.js`
 * needs the vocabulary, and `attribution.js` requires `facts.js`, which requires `cast.js` — so putting
 * these names in either of them would close a require cycle and hand one of them a half-built module
 * (gotcha 85).
 *
 * @module utils/reference-store/narrator
 */

const { refusal } = require("./refusals");
require("../../types"); // JSDoc type definitions

/**
 * The answer that is not a character, as the record stores it.
 *
 * It goes in `facts.extracted_as` on a row whose `key` is null, and in `attribution_answers.speaker` on
 * an answer. Nothing writes it into `cast`.
 *
 * @type {string}
 */
const NARRATOR = "narrator";

/**
 * The words that mean "the narrator", as an answer.
 *
 * Short and exact on purpose. A longer list becomes a rule that guesses which of a book's many ways of
 * naming narration is the reserved answer, and a reserved answer that fires on the wrong string silently
 * files a real character's claim under nobody.
 *
 * The two `first-person` spellings are in the list because a detective wrote that phrase in its answer and
 * the record should hold the answer it was given rather than refuse it as an unknown word.
 *
 * @type {string[]}
 */
const NARRATOR_WORDS = ["narrator", "narration", "地の文", "語り手", "narrator-voice", "first-person narrator", "first person narrator"];

/**
 * Whether a value is the narrator answer.
 *
 * A leading article is stripped before the comparison, because a roster entry keyed `the narrator` is the
 * same defect as one keyed `narrator` and the coverage rule cannot tell them apart. Measured against every
 * cast key and display in both real records (32 names) before it was written: **0 collisions**, so the
 * article-stripping does not swallow a name this series actually uses.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isNarratorAnswer(value) {
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase().replace(/^(the|a|an)\s+/, "");
  if (!text) return false;
  return NARRATOR_WORDS.some((word) => text === word.toLowerCase());
}

/**
 * Refuse a roster entry keyed by the word for "narrator".
 *
 * @param {string} key
 * @param {string} [verb] - The verb that asked, for the refusal.
 * @returns {ReferenceRefusal|null} Null when the key is a name.
 */
function narratorRosterKeyRefusal(key, verb = "cast_upsert") {
  if (!isNarratorAnswer(key)) return null;
  return refusal({
    verb,
    rule: "narrator-is-not-a-character",
    because:
      `"${key}" is the word for the narration, not a name this book gives anybody. A cast entry with ` +
      "this key is counted as a character by the coverage rule, which then asks the reference to cover " +
      "the narration itself — a question with no answer.",
    fix:
      `file the claim with no roster entry and extracted_as set to "${NARRATOR}", which is where an ` +
      "unattributed claim already lives, and which the coverage rule cannot mistake for a person.",
  });
}

module.exports = { NARRATOR, NARRATOR_WORDS, isNarratorAnswer, narratorRosterKeyRefusal };

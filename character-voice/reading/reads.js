/**
 * character-voice/reading/reads.js — the one job: one chapter's paid read, and the two constants that bound
 * how many paid reads a chapter gets in one pass.
 *
 * The mirror of `glossary/extract/reads.js`, which holds the same pair of constants for one term list
 * (`EXTRACTION_MAX_ATTEMPTS` / `EXTRACTION_RETRY_THINKING_LEVEL`) and names the failure that ended the budget.
 * The difference is deliberate and is written in `glossary/extract/reads.js`: the glossary has no "keep the
 * better of two half answers" rule because it has no half answers to compare; this pass does, because
 * `./answer` can rescue claims from a malformed array, and `volume.js` is where the comparison happens.
 *
 * `MAX_ATTEMPTS_PER_CHAPTER` is the whole budget and `EXTRACTION_RETRY_THINKING_LEVEL` is a constant with no
 * environment knob (AGENTS.md rule 3): a level the operator can set is a level that quietly stops being the
 * fix. Both carry the measurement that chose them.
 *
 * Part of the character-voice/reading.js layer.
 *
 * @module character-voice/reading/reads
 */

require("../../types"); // JSDoc type definitions

const { runExtract } = require("../stages");
// The endpoint's own tags on the two ways a call can fail without answering (AGENTS.md gotcha 55: never
// string-match a server's error text — these are the classes `configs/shared/failures.js` puts on them).
const { isStructuredOutputError, isTooBigForOnePassError } = require("../../configs/shared");

const { parseExtractionAnswer } = require("./answer");

/**
 * How many paid reads one chapter gets in one pass.
 *
 * Two: the run's normal level, then the retry level. After that the chapter is named as incomplete
 * and the pass carries on with the better of the two answers.
 */
const MAX_ATTEMPTS_PER_CHAPTER = 2;

/**
 * The reasoning level a cut-off chapter is re-read at.
 *
 * Measured on volume 02 at `AI_THINKING_LEVEL=xhigh`: chapter ch4 yielded 6 claims and ch5 yielded 1,
 * both cut off; re-read at `medium` the same chapters yielded 21 and 8, both complete. A constant,
 * on purpose — a level the operator can set is a level that quietly stops being the fix.
 */
const EXTRACTION_RETRY_THINKING_LEVEL = "medium";

/**
 * One chapter's paid read: ask for it, parse what comes back, and say whether the answer closed.
 *
 * A call that throws is not all one failure. A chapter can come back with **no answer because the endpoint
 * refused the shape it was asked for** (`shape-refused`), and that is the failure a re-ask can plausibly
 * fix, which makes it an incomplete answer rather than a reason to abandon the pass. It is rarer than it
 * sounds on this machine today: `character-voice/stages.js` asks for the `{"entries": […]}` envelope — the
 * object root this endpoint accepts — because the array-rooted schema it used to declare was refused before
 * the model was asked (HTTP 400 in 161 ms, 0 tokens, measured 2026-10-13; see `ai/one-shot.js`'s
 * `assertShapeIsExpressible` and AGENTS.md gotcha 138). The class is kept because the reading pass must
 * classify whatever it is given, and because a shape refusal is still a different failure from a dead
 * endpoint: one is worth a second paid read and the other is not.
 *
 * A size failure (`finish_reason=length`) is not re-askable: the same request at the same cap is cut off
 * the same way, so it keeps this file's existing behaviour and stops the pass. Anything else (an endpoint
 * that is down, an idle deadline) also stops it, because a second ask is not a fix for a dead server.
 *
 * @param {Object} params
 * @param {Object} params.ctx - The ctx `character-voice/stages.js`'s extraction pass reads.
 * @param {{id: string, file: string}} params.segment
 * @param {number} params.si - Zero-based position in reading order.
 * @param {string} params.extraNote - What this chapter is told about what has already been extracted.
 * @param {string} [params.knownBlock] - The already-known block this chapter is shown: the query result
 *   `character-voice/known-facts.js` built from the volume's open record. Built once per chapter by
 *   `readVolumeChapters` and handed to both paid reads, because the record does not change during a pass.
 * @param {string|null} [params.thinkingLevel] - The reasoning level for this attempt, or null for the run's own.
 * @param {(line: string) => void} params.log
 * @returns {Promise<{ok: boolean, entries: Array<Object>, lost: Array<Object>, cutOff: boolean, recovered: boolean, error: string|null, failure: {kind: string, because: string}|null, raw: string, thinkingLevel: string|null}>}
 */
async function readOneChapter({ ctx, segment, si, extraNote, knownBlock = "", thinkingLevel = null, log }) {
  let output = "";
  try {
    output = await runExtract(ctx, segment, si, {
      knownBlock,
      extraNote,
      thinkingLevel,
    });
  } catch (err) {
    const kind = isStructuredOutputError(err)
      ? "shape-refused"
      : isTooBigForOnePassError(err)
        ? "ran-out-mid-shape"
        : "call-failed";
    log(`  chapter ${segment.id}: extraction FAILED${thinkingLevel ? ` at ${thinkingLevel}` : ""} (${kind}): ${err.message}`);
    return {
      ok: false,
      entries: [],
      lost: [],
      cutOff: false,
      recovered: false,
      error: err.message,
      failure: { kind, because: err.message },
      raw: "",
      thinkingLevel,
    };
  }
  const parsed = parseExtractionAnswer(output);
  return {
    ok: true,
    entries: parsed.entries,
    lost: parsed.lost,
    cutOff: parsed.cutOff,
    recovered: parsed.recovered,
    error: parsed.error,
    failure: null,
    raw: output,
    thinkingLevel,
  };
}

/**
 * The line one paid read contributes to the chapter's attempt log.
 *
 * Written as a function because the same record is taken from a read that answered and from one that
 * threw, and the two used to be built by two different expressions that had to be kept in step by hand.
 *
 * @param {{thinkingLevel: string|null, entries?: Array<Object>, cutOff?: boolean, lost?: Array<Object>, recovered?: boolean, error?: string|null, failure?: {kind: string}|null}} read
 * @returns {{at: string, thinkingLevel: string|null, claims: number, cutOff: boolean, lostClaims: number, parseError: string|null, failure: string|null}}
 */
function attemptLog(read) {
  return {
    at: new Date().toISOString(),
    thinkingLevel: read.thinkingLevel,
    claims: read.entries ? read.entries.length : 0,
    cutOff: Boolean(read.cutOff || read.failure),
    lostClaims: read.lost ? read.lost.length : 0,
    parseError: read.recovered ? read.error : null,
    failure: read.failure ? read.failure.kind : null,
  };
}

module.exports = {
  MAX_ATTEMPTS_PER_CHAPTER,
  EXTRACTION_RETRY_THINKING_LEVEL,
  readOneChapter,
  attemptLog,
};

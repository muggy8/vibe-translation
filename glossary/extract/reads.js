/**
 * glossary/extract/reads.js — the one job: the paid-read budget around one term list, and the name of the
 * failure that ended it.
 *
 * Two paid reads, then the failure is reported rather than paid for again. The load-bearing rule lives
 * here: **a list that never arrived comes back `failed: true` and never `[]`**, because `[]` is also the
 * honest answer for a volume with nothing new and the two must not look alike (AGENTS.md gotcha 138).
 *
 * The shape of this file mirrors `character-voice/reading.js` on purpose, so the two reading passes do not
 * drift into two different sets of rules.
 */

require("dotenv").config();
require("../../types"); // JSDoc type definitions

const { isStructuredOutputError, isTooBigForOnePassError } = require("../../configs/shared");

const { parseTermAnswer } = require("./answer");

/**
 * How many paid reads one term list gets in one pass.
 *
 * Two, mirroring `character-voice/reading.js`'s `MAX_ATTEMPTS_PER_CHAPTER`: the run's own reasoning
 * level, then the retry level. After that the failure is reported rather than paid for again. The
 * number is a constant with no environment knob (AGENTS.md rule 3): a budget an operator can raise
 * is a budget that quietly stops being a bound.
 *
 * @type {number}
 */
const EXTRACTION_MAX_ATTEMPTS = 2;

/**
 * The reasoning level the SECOND read runs at.
 *
 * `character-voice/reading.js` chose "medium" by measurement (volume 02: two chapters cut off at
 * `xhigh` came back whole at `medium`). Measured 2026-10-13 from the offline loop's own wire log: the
 * glossary, character-voice and style-guide **extraction** calls all run at `reasoning_effort: xhigh`
 * there (2 + 2 + 2 of them, against `medium` for every grading call) — they are not judging calls, so they
 * inherit `AI_THINKING_LEVEL` and never see `STAGE_THINKING_LEVEL`. On this machine's `.env`
 * `AI_THINKING_LEVEL=medium`, and the extraction calls pass no per-call level, so the real volume 01 run
 * that lost chapter 5 asked at `medium` too — which makes this retry a **same-level re-sample** for that
 * run, and that is exactly what gotcha 122 measured fixed the voice stage's cut-off chapters ("what fixed
 * them was a second roll rather than the lower level"). The real run's own summary log does not print
 * `reasoning_effort`, so that last half is the code path plus `.env`, not a line read off the log.
 *
 * @type {string}
 */
const EXTRACTION_RETRY_THINKING_LEVEL = "medium";

/**
 * Which of the three ways a term-list read can fail actually happened.
 *
 * The endpoint's two refusals are different problems with different fixes, and the log line has to
 * say which one it saw (AGENTS.md gotcha 55: a task must not string-match a server's error text —
 * these are the tags `configs/shared/failures.js` puts on them):
 *
 *   - `shape-refused` — the endpoint could not produce an answer in the shape it was asked for
 *     (`structured_output_failed`). The request was well-formed; the model answered in prose, or in a
 *     bare array where the envelope was asked for on a server that constrains its output loosely.
 *   - `ran-out-mid-shape` — the answer hit the output cap before it closed (`finish_reason=length`).
 *     That is a size problem: the fix is a smaller request or a bigger cap, not a re-ask.
 *   - `unparseable-answer` — an answer arrived and {@link parseTerms} could not read it. On a server that
 *     honours `response_format` this should be rare; it is the shape a server that ignores the field
 *     still produces, and {@link parseTerms} reads both the envelope and the bare array.
 *
 * @param {Error} err - What the call or the parse threw.
 * @returns {"shape-refused"|"ran-out-mid-shape"|"unparseable-answer"}
 */
function classifyExtractionFailure(err) {
  if (isStructuredOutputError(err)) return "shape-refused";
  if (isTooBigForOnePassError(err)) return "ran-out-mid-shape";
  return "unparseable-answer";
}

/**
 * Ask for one term list, retry it once when the answer fails its shape, and report what happened.
 *
 * The rule, in the order it bites — the same shape `character-voice/reading.js` uses, so the two
 * reading passes do not drift into two different sets of rules:
 *
 *   1. the first read runs at the run's own reasoning level (no `thinkingLevel` is passed);
 *   2. a read that throws, or whose answer {@link parseTerms} cannot parse, is re-asked once at
 *      {@link EXTRACTION_RETRY_THINKING_LEVEL};
 *   3. **a size failure is not re-asked** — `finish_reason=length` is deterministic, the same request
 *      at the same cap is cut off the same way, and the harness already throws on it (its own message
 *      says raise `AI_MAX_TOKENS` or shrink the input). Re-asking would pay for a doomed call and turn
 *      a loud failure into a quiet one, so it is re-thrown unchanged;
 *   4. every paid read is recorded in `attempts` — its level, its term count, and what it failed with;
 *   5. a list that never arrived is returned as `failed: true` with a named `failure`, and the caller
 *      reports it. It is never returned as `[]`, because `[]` is also the honest answer for a volume
 *      with nothing new, and the two must not look alike.
 *
 * There is no "keep the better of two half answers" rule here, and that is a real difference from
 * `character-voice/reading.js`: that file reads a chapter's array object by object and can rescue the
 * claims a malformed one lost, so two partial answers can be compared. {@link parseTerms} is
 * all-or-nothing — it either returns the list or throws — so a failed read has no partial to keep, and
 * the first read that parses IS the answer. Adding the tolerant reader here would be a second filing
 * rule, and the glossary's evidence rule is what a rescued term would have to pass.
 *
 * @param {Object} params
 * @param {(attempt: {attempt: number, thinkingLevel: string|null}) => Promise<string>} params.ask - Runs the one-shot for one paid read.
 * @param {string} params.label - What the log lines call this read.
 * @param {(line: string) => void} [params.warn] - Where the retry is announced.
 * @returns {Promise<{terms: Array<Object>, revisions: Array<Object>, attempts: Array<Object>, failed: boolean, failure: {kind: string, because: string}|null}>}
 * @throws {Error} Re-throws a size failure (`ran-out-mid-shape`) unchanged, which is what the stage did before this file existed.
 */
async function readTermList({ ask, label, warn = console.warn }) {
  /** @type {Array<Object>} */
  const attempts = [];
  /** @type {{terms: Array<Object>, revisions: Array<Object>, failure: {kind: string, because: string}}|null} */
  let lastFailure = null;

  for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS; attempt++) {
    const thinkingLevel = attempt === 1 ? null : EXTRACTION_RETRY_THINKING_LEVEL;
    /** @type {Array<Object>} */
    let terms = [];
    /** @type {Array<Object>} */
    let revisions = [];
    /** @type {{kind: string, because: string}|null} */
    let failure = null;
    try {
      const answer = parseTermAnswer(await ask({ attempt, thinkingLevel }));
      terms = answer.terms;
      revisions = answer.revisions;
    } catch (err) {
      const kind = classifyExtractionFailure(err);
      if (kind === "ran-out-mid-shape") {
        warn(`${label}: the answer hit the output cap before it closed. Not re-asked — the same request at the same cap is cut off the same way.`);
        throw err;
      }
      failure = { kind, because: err.message };
    }
    attempts.push({
      attempt,
      thinkingLevel: thinkingLevel || "run default",
      terms: terms.length,
      revisions: revisions.length,
      failure,
    });
    if (!failure) return { terms, revisions, attempts, failed: false, failure: null };
    lastFailure = { terms, revisions, failure };
    if (attempt < EXTRACTION_MAX_ATTEMPTS) {
      warn(
        `${label}: the term list ${failure.kind === "shape-refused" ? "was refused by the endpoint (it could not answer in the shape it was asked for)" : "arrived in a shape this stage cannot parse"} — re-asking once at ${EXTRACTION_RETRY_THINKING_LEVEL}.`
      );
    }
  }

  warn(
    `${label}: NO term list after ${EXTRACTION_MAX_ATTEMPTS} paid read(s) (${attempts.map((a) => `${a.thinkingLevel}: ${a.failure.kind}`).join("; ")}). ` +
      `Whatever this read was supposed to find is missing, and that is not the same as finding nothing.`
  );
  return {
    terms: [],
    revisions: lastFailure ? lastFailure.revisions : [],
    attempts,
    failed: true,
    failure: lastFailure ? lastFailure.failure : null,
  };
}

module.exports = {
  EXTRACTION_MAX_ATTEMPTS,
  EXTRACTION_RETRY_THINKING_LEVEL,
  classifyExtractionFailure,
  readTermList,
};

/**
 * glossary/extract/answer.js — the one job: read the term-list reply into the rows the record files.
 *
 * Tolerates markdown fences, surrounding prose, the `{"terms": […], "revisions": […]}` envelope the request
 * asks for, and the bare JSON array a server that ignores `response_format` still answers in. Tolerance is
 * the reader's job; the request (`glossary/extract/answer-shape.js`) always asks for the envelope.
 *
 * The answer carries the target-language rendering and the one-line note, because on this route the read
 * pass is the ONLY place a rendering is chosen — the file is rendered from the record afterwards and
 * nothing else can supply one (glossary/plan/01-glossary-route.md §3 step 2).
 *
 * Everything here is pure: no file reads, no model call, no setting read.
 */

require("dotenv").config();
require("../../types"); // JSDoc type definitions

/**
 * Pull the answer value out of the reply, in whichever of the forms it arrived.
 *
 * The envelope (`{"terms": […], "revisions": […]}`) is what the request asks for and what the prompt now
 * asks the model to write. The bare array is still read, because a server that ignores `response_format`
 * answers in the form its prompt used to ask for, and a stage that can read both is a stage that does not
 * break when the endpoint changes. Tolerance is the reader's job; the request always asks for the envelope.
 *
 * @param {string} text - The answer, already fence-stripped.
 * @returns {Array<Object>|Object|null} The parsed value — the envelope object or the bare array — or null
 *   when this answer holds no term list in either form.
 */
function answerValueFromText(text) {
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
   * Is this value an answer — a bare array, or an object holding a `terms` array?
   * @param {Object} value
   * @returns {Array<Object>|Object|null}
   */
  const asAnswer = (value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray(value.terms)) return value;
    return null;
  };

  const whole = tryJson(text);
  if (whole !== undefined) {
    const answer = asAnswer(whole);
    if (answer) return answer;
  }
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    const answer = asAnswer(tryJson(text.slice(objStart, objEnd + 1)));
    if (answer) return answer;
  }
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    const answer = asAnswer(tryJson(text.slice(arrStart, arrEnd + 1)));
    if (answer) return answer;
  }
  return null;
}

/**
 * Pull the term array out of the answer, in whichever of the two forms it arrived.
 *
 * Kept as its own name because it is what {@link parseTerms} and the prompt audit both reach for, and
 * because "the terms this volume found" is a question a caller asks without wanting the revisions.
 *
 * @param {string} text - The answer, already fence-stripped.
 * @returns {Array<Object>|null} The entries, or null when this answer holds no term array at all.
 */
function termArrayFromAnswer(text) {
  const answer = answerValueFromText(text);
  if (!answer) return null;
  return Array.isArray(answer) ? answer : answer.terms;
}

/**
 * One `revisions` element, in the shape the filing door takes.
 *
 * `quote` and `reason` are kept as separate fields rather than folded into `note`, because they answer
 * two different questions the record asks separately: **where in this volume's text** the revision comes
 * from (the evidence rule checks that against the book), and **why** the earlier rendering is being
 * replaced (the note is what the published glossary prints). A door that read the reason as the quote
 * would file a justification as evidence, which is the shape of claim this store refuses.
 *
 * @param {Object} entry - One element of the answer's `revisions` array.
 * @returns {{term: string, rendering: string, note: string, quote: string, reason: string}|null}
 *   Null when the entry names no term at all.
 */
function revisionFromAnswer(entry) {
  if (!entry || typeof entry !== "object") return null;
  const term = typeof entry.term === "string" ? entry.term.trim() : "";
  if (!term) return null;
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  return {
    term,
    rendering: text(entry.rendering),
    note: text(entry.note),
    quote: text(entry.quote),
    reason: text(entry.reason),
  };
}

/**
 * Parse the AI's term-list output into the two lists it carries.
 *
 * Tolerates markdown fences, surrounding prose, the `{"terms": […], "revisions": […]}` envelope the
 * request asks for, and the bare JSON array a server that ignores `response_format` still answers in.
 * A bare array carries no revisions, and an envelope missing the `revisions` key carries none — both are
 * read, because the request asking for a list and the answer omitting it are different facts and the
 * stage must not lose the terms over the difference.
 *
 * The answer carries the target‑language rendering and the one‑line note, because on this route the
 * read pass is the ONLY place a rendering is chosen — the file is rendered from the record afterwards
 * and nothing else can supply one (glossary/plan/01-glossary-route.md §3 step 2). `type` and `query`
 * are still read: `section` is the preferred bucket and `type` is the fallback the older answers and
 * the offline fixture still use.
 *
 * `revisions` is this volume's answer about a row an EARLIER volume published. It is parsed here and
 * filed by a different door (`importGlossaryRevisions`), because it is a different act: it replaces a
 * published row rather than adding one, and the guard that makes that legal — a quote this volume's own
 * text prints — is not the guard that admits a new term.
 *
 * @param {string} output - The raw AI output.
 * @returns {{terms: Array<{term: string, rendering: string, note: string, section: string, type: string, query: string}>, revisions: Array<{term: string, rendering: string, note: string, quote: string, reason: string}>}}
 * @throws {Error} When the answer holds no array of terms in either form.
 */
function parseTermAnswer(output) {
  if (!output || typeof output !== "string") {
    return { terms: [], revisions: [] };
  }
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  const answer = answerValueFromText(text);
  if (answer === null) {
    throw new Error(
      "No JSON array found in the term-list output: the answer is neither a JSON array nor an object " +
        'holding a "terms" array.'
    );
  }
  const rawTerms = Array.isArray(answer) ? answer : answer.terms;
  // An envelope that omits `revisions` is an answer with no revisions, not a malformed answer. The
  // request asks for both lists; a server that answers one is answered.
  const rawRevisions = Array.isArray(answer) ? [] : answer.revisions;
  const terms = rawTerms
    .filter((entry) => entry && typeof entry.term === "string" && entry.term.trim() !== "")
    .map((entry) => ({
      term: entry.term.trim(),
      rendering: typeof entry.rendering === "string" ? entry.rendering.trim() : "",
      note: typeof entry.note === "string" ? entry.note.trim() : "",
      section: typeof entry.section === "string" && entry.section.trim() ? entry.section.trim() : "",
      type: typeof entry.type === "string" && entry.type.trim() !== "" ? entry.type.trim() : "concept",
      query: typeof entry.query === "string" && entry.query.trim() !== "" ? entry.query.trim() : entry.term.trim(),
    }));
  const revisions = [];
  for (const entry of Array.isArray(rawRevisions) ? rawRevisions : []) {
    const revision = revisionFromAnswer(entry);
    if (revision) revisions.push(revision);
  }
  return { terms, revisions };
}

/**
 * Parse the AI's term-list output into the rows the record files.
 *
 * The terms half of {@link parseTermAnswer}, kept as its own name because it is what every existing
 * caller and the offline tests reach for, and because "what terms did this volume find" is a question
 * that does not want the revisions with it.
 *
 * @param {string} output - The raw AI output.
 * @returns {Array<{term: string, rendering: string, note: string, section: string, type: string, query: string}>}
 * @throws {Error} When the answer holds no array of terms in either form.
 */
function parseTerms(output) {
  return parseTermAnswer(output).terms;
}

module.exports = {
  answerValueFromText,
  termArrayFromAnswer,
  revisionFromAnswer,
  parseTermAnswer,
  parseTerms,
};

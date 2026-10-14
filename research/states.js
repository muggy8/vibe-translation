/**
 * research/states.js — the three things a lookup can end as, and the two rules that read a refusal.
 *
 * The `The three lookup states` seam of `research.js` (AGENTS.md §3), and the whole point of the
 * reliability pass (2026-10-13, gotcha 147): a term Wikipedia has nothing about and a term Wikipedia
 * refused to answer used to produce the same `found: false`, and the glossary pass filed "no reference
 * page matched this term" for a question nobody managed to ask — a rate limit became a published claim
 * about the reference, and the next volume inherited it. So every result carries a `status`, and these
 * three names are the only vocabulary for it, shared with `glossary/research.js` by import rather than
 * restatement so the two layers cannot drift.
 *
 * The other two rules here belong to the same question — *is this refusal worth asking again, and how
 * long do we wait before we do?* — and are pure functions over a status and a header, which is what
 * lets `test/test-lookup-reliability.js` scenario 3 pin the backoff and the cap without a server.
 *
 * Part of the lookup layer (research.js).
 */

const { LOOKUP_BACKOFF_BASE_MS, LOOKUP_RETRY_AFTER_MAX_MS } = require("./bounds");

/** Something to read: the reference answered and returned a page. */
const LOOKUP_OK = "ok";
/** The reference answered, and it has nothing for this query. */
const LOOKUP_NO_RESULTS = "no-results";
/** The reference could not be reached, or rejected the request. */
const LOOKUP_FAILED = "failed";

/**
 * A lookup result: what one request to one reference did.
 *
 * @typedef {Object} LookupOutcome
 * @property {"ok"|"no-results"|"failed"} status - Which of the three things happened.
 * @property {number|null} [httpStatus] - The status the reference answered with, when it answered.
 * @property {number} [attempts] - How many HTTP requests this outcome cost.
 * @property {string} [error] - Why it failed, when it failed.
 * @property {boolean} [circuitOpen] - Set when the failure is "the lookup layer has stopped asking", not "this request was rejected".
 */

/**
 * Whether a rejected status is worth asking again.
 *
 * 429 (rate limited) and any 5xx are the reference saying "not right now" — retryable. Every other
 * 4xx is the reference saying "that request is wrong" — re-sending the identical URL is not a fix,
 * and it is how a run spends 800 requests on a malformed one.
 *
 * @param {number} status - The HTTP status.
 * @returns {boolean}
 */
function isRetryableStatus(status) {
  const code = Number(status);
  return code === 429 || (code >= 500 && code <= 599);
}

/**
 * Read a `Retry-After` header into milliseconds.
 *
 * The header is either a number of seconds or an HTTP-date. Both are honoured; a value that is
 * neither is treated as absent (so the exponential backoff applies), and a value larger than
 * {@link LOOKUP_RETRY_AFTER_MAX_MS} is clamped to it — a header must not be able to stall a run.
 *
 * @param {string|null|undefined} headerValue - The raw header.
 * @param {number} [nowMs] - "Now", for the date form. Defaults to the wall clock.
 * @returns {number|null} The wait in ms, or null when the header says nothing usable.
 */
function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
  const raw = String(headerValue ?? "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    return Math.min(Math.max(0, parseInt(raw, 10) * 1000), LOOKUP_RETRY_AFTER_MAX_MS);
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.min(Math.max(0, when - nowMs), LOOKUP_RETRY_AFTER_MAX_MS);
}

/**
 * How long to sit before retry number `attempt`.
 *
 * The server's `Retry-After` wins when it sent one — it is the only answer that knows how loaded
 * the server is. Otherwise the wait doubles from {@link LOOKUP_BACKOFF_BASE_MS}.
 *
 * @param {number} attempt - The 1-based attempt that just failed (1 → the first retry).
 * @param {string|null|undefined} [retryAfter] - The raw `Retry-After` header, if any.
 * @param {number} [nowMs] - "Now", for the date form.
 * @returns {number} Milliseconds to wait.
 */
function retryDelayMs(attempt, retryAfter = null, nowMs = Date.now()) {
  const fromServer = parseRetryAfterMs(retryAfter, nowMs);
  if (fromServer !== null) return fromServer;
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(LOOKUP_BACKOFF_BASE_MS * 2 ** (n - 1), LOOKUP_RETRY_AFTER_MAX_MS);
}

module.exports = {
  LOOKUP_OK,
  LOOKUP_NO_RESULTS,
  LOOKUP_FAILED,
  isRetryableStatus,
  parseRetryAfterMs,
  retryDelayMs,
};

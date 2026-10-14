/**
 * research/bounds.js — the reliability policy, as seven literals.
 *
 * The `Reliability bounds` seam of `research.js` (AGENTS.md §3). These are the numbers that decide
 * what happens when a reference **refuses** rather than answers: how many times one request is re-sent,
 * how long a `Retry-After` header is allowed to make this process sit, how many gave-up requests in a
 * row stop the layer asking, how long it stays shut, how many times it is allowed to ask once more, and
 * the `maxlag` the API is asked to enforce on our own behalf.
 *
 * **No environment knob on any of them** (AGENTS.md §4.3, gotcha 70). They are exported so a test can
 * name them rather than restate them, and `test/test-lookup-reliability.js` scenario 8 runs a child
 * process that sets every one of them (plus plausible alternative names) in the environment and fails
 * if the numbers move, and scans this whole layer for a `process.env` read of any of them.
 *
 * Part of the lookup layer (research.js).
 */

/**
 * How many times ONE lookup request is re-sent after it fails.
 *
 * Two retries means at most three requests per logical lookup. Wikipedia's own guidance for the
 * Action API is to back off and retry a handful of times on a 429 or a 5xx; a fourth attempt on
 * a public API is not politeness, it is pressure.
 *
 * @type {number}
 */
const LOOKUP_MAX_RETRIES = 2;

/**
 * The first backoff, in milliseconds. Each further retry doubles it (1 s, then 2 s).
 *
 * @type {number}
 */
const LOOKUP_BACKOFF_BASE_MS = 1000;

/**
 * The longest wait a `Retry-After` header is allowed to make this process sit still.
 *
 * The cap is the guard: a server (or anything between us and it) that answers `Retry-After: 3600`
 * would otherwise stall a run for an hour on a header nobody checked. A wait above this cap is
 * clamped to it, and the request is then retried or given up on like any other.
 *
 * @type {number}
 */
const LOOKUP_RETRY_AFTER_MAX_MS = 30000;

/**
 * How many lookup requests in a row may give up before the layer stops asking for the rest of the run.
 *
 * Counted per **request that gave up**, not per retry attempt: one lookup that exhausted its two
 * retries is one failure. That is what makes the number mean "the reference is persistently
 * refusing" rather than "one page had a bad second". A success resets it to zero.
 *
 * Measured against the one real run this repository has: volume 01's lookup was rejected 3 times
 * (three searches, 429) and answered everything else, so 3 gave-up requests — under 5, and the
 * breaker would correctly NOT have fired on that pattern. The breaker exists for the case where
 * every remaining request of a 17-volume run would be rejected.
 *
 * @type {number}
 */
const LOOKUP_CIRCUIT_OPEN_AFTER = 5;

/**
 * How long the breaker stays shut before it is allowed to ask once again.
 *
 * The breaker is half-open, not permanent. While it is open, a request that arrives before this
 * window has elapsed is refused cheaply (no network call, no wait); a request that arrives after it
 * has elapsed is sent as a **probe**. The window is measured, never slept through — the layer
 * compares elapsed time and decides, so a cooldown cannot turn a rate limit into a stall.
 *
 * 60 s against the two measured facts this bound sits between: the real volume 01 run's 429 blip
 * cleared on its own (3 rejected lookups out of the volume's lookups, and everything else answered),
 * while a run that never recovers is bounded by {@link LOOKUP_CIRCUIT_MAX_PROBES} below, so the
 * worst case these two constants can cost together is ten requests, not one request per minute for
 * five hours.
 *
 * @type {number}
 */
const LOOKUP_CIRCUIT_PROBE_AFTER_MS = 60000;

/**
 * How many probes the breaker is allowed to pay for before it gives up for the rest of the run.
 *
 * Without this the half-open window is a leak: an unreachable reference would cost one request every
 * minute for the whole run. Ten is the number that makes the half-open window safe to have, and it is
 * chosen against the outage shape it is meant to outlast: at 60 s per probe, ten probes cover a
 * reference that is down for **ten minutes**, and cost ten requests out of the ≈615 a 17-volume run
 * makes. Three covered three minutes, which is shorter than the window a Wikipedia overload rejection
 * can plausibly last — and the notes a book loses in that window are not re-asked until the next pass.
 *
 * @type {number}
 */
const LOOKUP_CIRCUIT_MAX_PROBES = 10;

/**
 * The `maxlag` the Wikipedia API is asked to enforce on our own behalf.
 *
 * Wikipedia's documented politeness parameter: the server refuses the request (with a 429 and a
 * `Retry-After`) when its replicas are further behind than this many seconds, instead of letting a
 * client keep adding load to an overloaded database. Sending it is what makes the 429 a *useful*
 * answer rather than an accident.
 *
 * @type {number}
 */
const WIKI_MAXLAG = 5;

module.exports = {
  LOOKUP_MAX_RETRIES,
  LOOKUP_BACKOFF_BASE_MS,
  LOOKUP_RETRY_AFTER_MAX_MS,
  LOOKUP_CIRCUIT_OPEN_AFTER,
  LOOKUP_CIRCUIT_PROBE_AFTER_MS,
  LOOKUP_CIRCUIT_MAX_PROBES,
  WIKI_MAXLAG,
};

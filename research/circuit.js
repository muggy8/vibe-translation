/**
 * research/circuit.js — the run-level breaker, and the one lookup request it governs.
 *
 * The `The run-level circuit breaker (half-open)` seam of `research.js` (AGENTS.md §3): the breaker's
 * state, the policy over it, the clock its cooldown is measured against, and `requestLookup` — the door
 * every Wikipedia call goes through, which is where the breaker is actually consulted. They live in one
 * file for the reason at the end of this header.
 *
 * **Why it is half-open** (gotcha 147). As first shipped the breaker was permanent: once five gave-up
 * requests tripped it, nothing in the process could ask the reference again, so a 20-second blip during
 * volume 1 cost a 4–5 hour, 17-volume run every research note it would have written — while the 429 this
 * layer deliberately invites by sending `maxlag` is Wikipedia's own overload answer and typically clears
 * in seconds. "The reference is unreachable" is a claim about a *moment*, not about a run. So: while the
 * circuit is open a request that arrives before `LOOKUP_CIRCUIT_PROBE_AFTER_MS` has elapsed is refused
 * with **no network call and no wait**, and the first request that arrives after it is sent as a
 * **probe** — one request, no retries, and always a lookup the stage was already going to make, never a
 * request the layer invented to feel the reference out. A probe that reaches the reference closes the
 * circuit; a probe that fails re-arms the window; `LOOKUP_CIRCUIT_MAX_PROBES` failed probes give up for
 * the rest of the run, out loud.
 *
 * **The cooldown is compared, never slept through.** A layer that *waits* for its own cooldown turns a
 * rate limit into a stall, and a stall is what trips the harness's idle deadline. `admitProbe()` reads the
 * clock and either refuses instantly or lets the request through; the only `sleep` in this file is the
 * retry backoff inside `requestLookup`, and a probe never reaches it because a probe is one request.
 *
 * `requestLookup` lives here rather than in a file of its own because it reads and writes the breaker's
 * counters mid-request (`refusedRequests`, `probing`). That keeps `lookupCircuit` private to this file:
 * it is not exported at all, and the only doors onto the breaker are `circuitState()` (a copy),
 * `noteLookupFailure` / `noteLookupSuccess` / `noteTermUnansweredByCircuit`, `resetLookupCircuit`, and the
 * clock seam. A breaker whose counters any module in the layer can write is not a guard (AGENTS.md §4.3).
 *
 * Part of the lookup layer (research.js).
 */

const {
  LOOKUP_CIRCUIT_MAX_PROBES,
  LOOKUP_CIRCUIT_OPEN_AFTER,
  LOOKUP_MAX_RETRIES,
  LOOKUP_CIRCUIT_PROBE_AFTER_MS,
} = require("./bounds");
const { isRetryableStatus, parseRetryAfterMs, retryDelayMs } = require("./states");
const { requestTimeoutMs, sleep, userAgent } = require("./config");

/**
 * The breaker's state. Module-level on purpose: `research.js` is required once per process, and a
 * glossary step walks all 17 volumes inside one process, so "the rest of the run" is exactly the
 * lifetime of this object.
 *
 * @typedef {Object} LookupCircuitState
 * @property {number} failures - Consecutive lookup requests that gave up. A success resets it.
 * @property {boolean} open - Whether the breaker is refusing requests.
 * @property {boolean} gaveUp - Set when the probes ran out: open for the rest of the run, with no window.
 * @property {number} openedAfter - How many consecutive failures opened it.
 * @property {string|null} openedAt - When it opened (or last re-armed), as an ISO string.
 * @property {number} openedAtMs - The same instant on the clock the window is measured against.
 * @property {number} probes - Probe requests already paid for since it opened.
 * @property {boolean} probing - Whether a probe is in flight right now (only one ever is).
 * @property {number} refusedRequests - Lookup requests refused while it was open.
 * @property {number} unansweredTerms - Terms left unanswered because their every lookup was refused.
 * @property {string|null} lastError - The last reason a request gave up.
 */

/** @type {LookupCircuitState} */
const lookupCircuit = {
  failures: 0,
  open: false,
  gaveUp: false,
  openedAfter: 0,
  openedAt: null,
  openedAtMs: 0,
  probes: 0,
  probing: false,
  refusedRequests: 0,
  unansweredTerms: 0,
  lastError: null,
};

/**
 * The clock the breaker measures its cooldown against.
 *
 * **A test seam, and nothing else.** It exists because a suite cannot sit for 60 s to prove a
 * cooldown works, and a cooldown that cannot be tested is a cooldown that is only described. It is
 * `null` in every real run: no stage, no stage module, and no command in this repository sets it —
 * the same standing `resetLookupCircuit` has, and pinned by `test/test-lookup-reliability.js`
 * scenario 11. It is not read out of the environment either: there is no knob that changes how long
 * the breaker stays shut (AGENTS.md §4.3, gotcha 70).
 *
 * @type {(() => number)|null}
 */
let lookupClockForTests = null;

/**
 * "Now", in milliseconds, on the clock the breaker uses.
 * @returns {number}
 */
function lookupNowMs() {
  return lookupClockForTests === null ? Date.now() : lookupClockForTests();
}

/**
 * Install a stand-in clock for the breaker's cooldown.
 *
 * **A test seam. No stage calls this** — the only callers in this repository are the offline suites.
 * It changes no bound: the window and the probe budget stay the constants they are.
 *
 * @param {() => number} clock - A function returning "now" in milliseconds.
 * @returns {void}
 * @throws {Error} When the argument is not a function — a seam that accepts anything is a seam that
 *   can be handed a value that quietly disables the cooldown.
 */
function setLookupClockForTests(clock) {
  if (typeof clock !== "function") {
    throw new Error("setLookupClockForTests expects a function returning milliseconds (it is a test seam, not a setting).");
  }
  lookupClockForTests = clock;
}

/**
 * Put the clock back to the wall clock. **A test seam; no stage calls this.**
 * @returns {void}
 */
function resetLookupClockForTests() {
  lookupClockForTests = null;
}

/**
 * The breaker, read.
 * @returns {LookupCircuitState} A copy, so a caller cannot write it.
 */
function circuitState() {
  return { ...lookupCircuit };
}

/**
 * Decide whether the request about to be sent is the breaker's probe.
 *
 * The whole half-open decision, and it never waits: the window has elapsed or it has not. A probe is
 * **a lookup the stage was already going to make** — this function does not invent a request, it
 * decides whether to let through one that is already here. At most one probe is in flight at a time.
 *
 * @returns {boolean} True when the caller's request is the probe; false when it must be refused.
 */
function admitProbe() {
  if (lookupCircuit.gaveUp || lookupCircuit.probing) return false;
  if (lookupCircuit.probes >= LOOKUP_CIRCUIT_MAX_PROBES) return false;
  const elapsed = lookupNowMs() - lookupCircuit.openedAtMs;
  if (elapsed < LOOKUP_CIRCUIT_PROBE_AFTER_MS) return false;
  lookupCircuit.probing = true;
  lookupCircuit.probes += 1;
  console.warn(
    `[research] Lookup circuit half-open: ${elapsed} ms have passed since it opened, so the next lookup ` +
      `this run was already going to make is sent as probe ${lookupCircuit.probes} of ` +
      `${LOOKUP_CIRCUIT_MAX_PROBES} — one request, no retries. No request was waited for.`
  );
  return true;
}

/**
 * Open the breaker, and say so out loud exactly once.
 *
 * @param {number} nowMs - The instant it opens, on the clock the window is measured against.
 * @returns {void}
 */
function openCircuit(nowMs) {
  lookupCircuit.open = true;
  lookupCircuit.gaveUp = false;
  lookupCircuit.openedAfter = lookupCircuit.failures;
  lookupCircuit.openedAt = new Date(nowMs).toISOString();
  lookupCircuit.openedAtMs = nowMs;
  lookupCircuit.probes = 0;
  lookupCircuit.probing = false;
  lookupCircuit.refusedRequests = 0;
  lookupCircuit.unansweredTerms = 0;
  console.error(
    `[research] Lookup circuit OPEN after ${lookupCircuit.openedAfter} consecutive failed lookup ` +
      `request(s): ${lookupCircuit.lastError}. No further lookups will be attempted while it is open — ` +
      `every term behind it is reported as "the reference could not be reached", not as "nothing ` +
      `matched", and nothing is filed for it. One probe request is allowed after ` +
      `${LOOKUP_CIRCUIT_PROBE_AFTER_MS} ms, at most ${LOOKUP_CIRCUIT_MAX_PROBES} probes in total.`
  );
}

/**
 * Record one lookup request that gave up.
 *
 * Three cases, and the one that matters is the middle one: a **failed probe** leaves the circuit open
 * and re-arms the window, and the last one in the budget closes the probe budget for the run.
 *
 * @param {string} reason - The last error message, for the record and the log.
 * @returns {void}
 */
function noteLookupFailure(reason) {
  lookupCircuit.failures += 1;
  lookupCircuit.lastError = String(reason || lookupCircuit.lastError || "");
  if (lookupCircuit.open) {
    // The only request that can reach here while the circuit is open is the probe. A refused request
    // never sends anything and never calls this.
    if (!lookupCircuit.probing) return;
    lookupCircuit.probing = false;
    if (lookupCircuit.probes >= LOOKUP_CIRCUIT_MAX_PROBES) {
      lookupCircuit.gaveUp = true;
      console.error(
        `[research] Lookup circuit GAVE UP for the rest of this run: ${lookupCircuit.probes} probe ` +
          `request(s) in a row were rejected (${lookupCircuit.lastError}). No further lookups will be ` +
          `attempted. While it was open ${lookupCircuit.refusedRequests} lookup request(s) were refused ` +
          `and ${lookupCircuit.unansweredTerms} term(s) went unanswered — each is reported as unanswered, ` +
          `nothing is filed for it, and the next pass asks it again.`
      );
      return;
    }
    const nowMs = lookupNowMs();
    lookupCircuit.openedAt = new Date(nowMs).toISOString();
    lookupCircuit.openedAtMs = nowMs;
    console.warn(
      `[research] Lookup circuit probe ${lookupCircuit.probes} of ${LOOKUP_CIRCUIT_MAX_PROBES} was ` +
        `rejected (${lookupCircuit.lastError}). The circuit stays open and the window starts again: the ` +
        `next probe is allowed after ${LOOKUP_CIRCUIT_PROBE_AFTER_MS} ms.`
    );
    return;
  }
  if (lookupCircuit.failures < LOOKUP_CIRCUIT_OPEN_AFTER) return;
  openCircuit(lookupNowMs());
}

/**
 * Record one lookup request that got an answer, which is what closes the breaker's count.
 * @returns {void}
 */
function noteLookupSuccess() {
  lookupCircuit.failures = 0;
}

/**
 * A probe reached the reference: close the breaker, and print what the open window cost.
 *
 * The terms that went unanswered while it was open are **not** undone by the close — they filed
 * nothing and stay unanswered, which is what makes the next pass ask them again. The number is
 * printed so a run that lost notes says how many it lost.
 *
 * @returns {void}
 */
function closeCircuitAfterProbe() {
  const openForMs = Math.max(0, lookupNowMs() - lookupCircuit.openedAtMs);
  console.log(
    `[research] Lookup circuit CLOSED: probe ${lookupCircuit.probes} of ${LOOKUP_CIRCUIT_MAX_PROBES} ` +
      `reached the reference. It had been open ${openForMs} ms; ${lookupCircuit.refusedRequests} lookup ` +
      `request(s) were refused and ${lookupCircuit.unansweredTerms} term(s) went unanswered while it was ` +
      `— nothing was filed for any of them, and the next pass asks them again. The failure count is ` +
      `reset and lookups continue.`
  );
  lookupCircuit.open = false;
  lookupCircuit.gaveUp = false;
  lookupCircuit.failures = 0;
  lookupCircuit.openedAfter = 0;
  lookupCircuit.openedAt = null;
  lookupCircuit.openedAtMs = 0;
  lookupCircuit.probes = 0;
  lookupCircuit.probing = false;
  lookupCircuit.refusedRequests = 0;
  lookupCircuit.unansweredTerms = 0;
}

/**
 * Count one term whose every lookup was refused by the open breaker.
 *
 * Counted at the term level rather than the request level, because "how many notes did this run lose
 * while the circuit was open" is a question about terms, and one term costs several refused requests.
 *
 * @returns {void}
 */
function noteTermUnansweredByCircuit() {
  lookupCircuit.unansweredTerms += 1;
}

/**
 * Put the breaker back to zero.
 *
 * **No stage calls this.** It exists for the offline suites, which run many scenarios in one process
 * and must not inherit the previous scenario's breaker — the same reason every fixture gets its own
 * series folder (gotcha 143). Nothing in the pipeline reaches it, and there is no way to raise or
 * lower the bound it counts against.
 *
 * @returns {void}
 */
function resetLookupCircuit() {
  lookupCircuit.failures = 0;
  lookupCircuit.open = false;
  lookupCircuit.gaveUp = false;
  lookupCircuit.openedAfter = 0;
  lookupCircuit.openedAt = null;
  lookupCircuit.openedAtMs = 0;
  lookupCircuit.probes = 0;
  lookupCircuit.probing = false;
  lookupCircuit.refusedRequests = 0;
  lookupCircuit.unansweredTerms = 0;
  lookupCircuit.lastError = null;
}

/**
 * The error the layer throws when the breaker is open — a distinct one, so a caller can tell
 * "the reference rejected this" from "we stopped asking the reference".
 *
 * @returns {Error} An error carrying `circuitOpen: true` and `httpStatus: null`.
 */
function circuitOpenError() {
  const err = new Error(
    `Lookup circuit is open (${lookupCircuit.openedAfter} consecutive failed lookup request(s), ` +
      `${lookupCircuit.probes} probe(s) tried${lookupCircuit.gaveUp ? ", the probes ran out" : ""}); ` +
      `no request was sent.`
  );
  err.circuitOpen = true;
  err.httpStatus = null;
  err.attempts = 0;
  return err;
}

/**
 * fetch with a timeout, so a hung endpoint cannot stall the run forever.
 *
 * @param {string} url - The URL to request.
 * @param {RequestInit} [options] - The fetch options (any `signal` is replaced).
 * @returns {Promise<Response>} The fetch response.
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs());
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${requestTimeoutMs()} ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One lookup request, with its bounded retries and its breaker, in one place.
 *
 * Both Wikipedia calls and nothing else go through here, so the retry policy cannot be half-applied.
 * Throws when the request gives up; the thrown error carries `httpStatus` and `attempts`.
 *
 * When the breaker is open the request is refused **immediately** — no network call, no wait for the
 * cooldown. The one exception is the probe: the request already in hand is let through, once, with
 * its retries switched off (one request, no retries), because the probe is a lookup the stage was
 * already going to make and the layer does not invent a request to test the reference with.
 *
 * @param {string} url - The URL to request.
 * @param {string} label - What to call this request in the retry warning (e.g. "Wikipedia search (ja)").
 * @param {Object<string,string>} [headers] - Extra headers.
 * @returns {Promise<{response: Response, attempts: number}>} The successful response and how many requests it cost.
 * @throws {Error} When the breaker is open and this is not its probe, or when the request gave up after its retries.
 */
async function requestLookup(url, label, headers = {}) {
  let probe = false;
  if (lookupCircuit.open) {
    probe = admitProbe();
    if (!probe) {
      lookupCircuit.refusedRequests += 1;
      throw circuitOpenError();
    }
  }
  // A probe is one request. Retrying a probe is how a cooldown becomes a burst.
  const maxAttempts = probe ? 1 : 1 + LOOKUP_MAX_RETRIES;

  const sent = { "User-Agent": userAgent(), ...headers };
  let attempt = 0;
  try {
    for (;;) {
      attempt += 1;
      let response = null;
      let transportError = null;
      try {
        response = await fetchWithTimeout(url, { headers: sent });
      } catch (err) {
        transportError = err;
      }

      if (!transportError && response.ok) {
        if (probe) closeCircuitAfterProbe();
        noteLookupSuccess();
        return { response, attempts: attempt };
      }

      const status = transportError ? null : response.status;
      const reason = transportError
        ? transportError.message
        : `${label} failed with status ${status}`;
      // A rejected body still has to be released, or the connection it arrived on is never given back.
      if (!transportError) {
        try {
          await response.body?.cancel();
        } catch {
          /* the body is already gone */
        }
      }
      // A transport failure is worth another try; a rejected status is only worth another try when the
      // server said "not right now".
      const retryable = transportError ? true : isRetryableStatus(status);

      if (retryable && attempt < maxAttempts) {
        const retryAfter = transportError ? null : response.headers.get("retry-after");
        const wait = retryDelayMs(attempt, retryAfter);
        console.warn(
          `[research] ${reason} — retrying in ${wait} ms (retry ${attempt} of ${LOOKUP_MAX_RETRIES}` +
            `${parseRetryAfterMs(retryAfter) !== null ? ", honouring the server's Retry-After" : ""}).`
        );
        await sleep(wait);
        continue;
      }

      noteLookupFailure(reason);
      const err = new Error(`${reason} after ${attempt} request(s)`);
      err.httpStatus = status;
      err.attempts = attempt;
      err.circuitOpen = false;
      err.probe = probe;
      throw err;
    }
  } finally {
    // A probe is in flight for exactly one request, whatever way that request ended.
    if (probe) lookupCircuit.probing = false;
  }
}

module.exports = {
  // The doors the rest of the layer and the barrel actually use. The breaker's own state object,
  // `admitProbe`, `openCircuit`, `closeCircuitAfterProbe`, `circuitOpenError` and `lookupNowMs` stay
  // private to this file: `requestLookup` is the only code that consults the breaker mid-request, and
  // a breaker whose counters any module can write is not a guard (AGENTS.md §4.3).
  circuitState,
  noteLookupFailure,
  noteLookupSuccess,
  noteTermUnansweredByCircuit,
  resetLookupCircuit,
  // **Test seams.** No stage, no stage module and no command in this repository calls these two.
  setLookupClockForTests,
  resetLookupClockForTests,
  // The HTTP door the Wikipedia calls go through, and the bare timeout door the optional general
  // search API uses (it is not behind the breaker — that is the behaviour as shipped).
  requestLookup,
  fetchWithTimeout,
};

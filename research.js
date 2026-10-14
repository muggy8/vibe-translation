/**
 * research.js — Client-side web research for glossary terms.
 *
 * The primary backend is the Wikipedia Action API (keyless), queried in one or
 * more languages (default: Japanese + English). An optional secondary backend
 * is a general web-search API (Brave / Tavily / Serper), enabled via the
 * SEARCH_API and SEARCH_API_KEY environment variables.
 *
 * This module performs the research itself (no LLM involved), so it works
 * regardless of whether the configured model/endpoint supports tool calling.
 *
 * **Every lookup says which of three things happened.** That is the whole point of the
 * reliability pass (2026-10-13): a term Wikipedia has nothing about and a term Wikipedia
 * refused to answer were both reported as `found: false`, and the glossary pass then filed
 * "no reference page matched this term" for a question nobody managed to ask — a rate limit
 * became a published claim about the reference, and the next volume inherited it. So every
 * result now carries a `status`:
 *
 *   - `ok`          — the reference answered and there is something to read;
 *   - `no-results`  — the reference answered and it has nothing;
 *   - `failed`      — the reference could not be reached, or rejected the request (the HTTP
 *                     status rides along in `httpStatus`).
 *
 * A request that is rejected is retried, politely and a bounded number of times, and a lookup
 * layer that keeps being rejected stops asking for the rest of the run rather than spending
 * the remaining requests getting rejected again. Both bounds are constants with no environment
 * knob (AGENTS.md §4.3), and the retry waits honour `Retry-After` when the server sends one.
 *
 * @example
 * const { researchTerms, formatResearchNotes } = require("./research");
 * const notes = await researchTerms([
 *   { term: "如月雨露", type: "character", query: "如月雨露" },
 * ]);
 * const text = formatResearchNotes(notes);
 */

require("dotenv").config();

// ─── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_USER_AGENT =
  "ai-client-glossary/1.0 (light-novel translation glossary research; local)";

/** The Wikipedia languages to query, from WIKI_LANGS (default "ja,en"). */
function wikiLangs() {
  return (process.env.WIKI_LANGS || "ja,en")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Maximum number of search results to keep per language. */
function maxResults() {
  return Math.max(1, parseInt(process.env.RESEARCH_MAX_RESULTS, 10) || 3);
}

/** Maximum characters to keep from each extract. */
function maxExtractChars() {
  return Math.max(200, parseInt(process.env.RESEARCH_EXTRACT_CHARS, 10) || 800);
}

/** Delay between HTTP requests, in milliseconds (politeness). */
function delayMs() {
  return Math.max(0, parseInt(process.env.RESEARCH_DELAY_MS, 10) || 300);
}

/** The User-Agent sent to Wikipedia (it requires a descriptive one). */
function userAgent() {
  return process.env.WIKI_USER_AGENT || DEFAULT_USER_AGENT;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Per-request timeout for research HTTP requests, in ms (default: 30000). */
function requestTimeoutMs() {
  return Math.max(1000, parseInt(process.env.RESEARCH_TIMEOUT_MS, 10) || 30000);
}

// ─── Reliability bounds (constants, no environment knob) ─────────────────────
//
// AGENTS.md §4.3: a guard a run can switch off is not a guard. These four numbers are the
// whole reliability policy, they are exported so a test can name them, and nothing in the
// environment or on a command line reaches any of them.

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

// ─── The three lookup states ─────────────────────────────────────────────────

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

// ─── The run-level circuit breaker ───────────────────────────────────────────

/**
 * The breaker's state. Module-level on purpose: `research.js` is required once per process, and a
 * glossary step walks all 17 volumes inside one process, so "the rest of the run" is exactly the
 * lifetime of this object.
 *
 * @type {{failures: number, open: boolean, openedAfter: number, openedAt: string|null, lastError: string|null}}
 */
const lookupCircuit = {
  failures: 0,
  open: false,
  openedAfter: 0,
  openedAt: null,
  lastError: null,
};

/**
 * The breaker, read.
 *
 * @returns {{failures: number, open: boolean, openedAfter: number, openedAt: string|null, lastError: string|null}} A copy, so a caller cannot write it.
 */
function circuitState() {
  return { ...lookupCircuit };
}

/**
 * Record one lookup request that gave up, and open the breaker when that is the fifth in a row.
 *
 * Says so out loud exactly once: the point of the breaker is that a run stops spending requests,
 * and a run that stops silently is a run that looks like it found nothing.
 *
 * @param {string} reason - The last error message, for the record and the log.
 * @returns {void}
 */
function noteLookupFailure(reason) {
  lookupCircuit.failures += 1;
  lookupCircuit.lastError = String(reason || lookupCircuit.lastError || "");
  if (lookupCircuit.open || lookupCircuit.failures < LOOKUP_CIRCUIT_OPEN_AFTER) return;
  lookupCircuit.open = true;
  lookupCircuit.openedAfter = lookupCircuit.failures;
  lookupCircuit.openedAt = new Date().toISOString();
  console.error(
    `[research] Lookup circuit OPEN after ${lookupCircuit.openedAfter} consecutive failed lookup ` +
      `request(s): ${lookupCircuit.lastError}. No further lookups will be attempted for the rest of ` +
      `this run — every remaining term is reported as "the reference could not be reached", not as ` +
      `"nothing matched", and nothing is filed for it.`
  );
}

/**
 * Record one lookup request that got an answer, which is what closes the breaker's count.
 *
 * @returns {void}
 */
function noteLookupSuccess() {
  lookupCircuit.failures = 0;
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
  lookupCircuit.openedAfter = 0;
  lookupCircuit.openedAt = null;
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
    `Lookup circuit is open (${lookupCircuit.openedAfter} consecutive failed lookup request(s)); ` +
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
 * @param {string} url - The URL to request.
 * @param {string} label - What to call this request in the retry warning (e.g. "Wikipedia search (ja)").
 * @param {Object<string,string>} [headers] - Extra headers.
 * @returns {Promise<{response: Response, attempts: number}>} The successful response and how many requests it cost.
 * @throws {Error} When the breaker is open, or when the request gave up after its retries.
 */
async function requestLookup(url, label, headers = {}) {
  if (lookupCircuit.open) throw circuitOpenError();

  const sent = { "User-Agent": userAgent(), ...headers };
  let attempt = 0;
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

    if (retryable && attempt <= LOOKUP_MAX_RETRIES) {
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
    throw err;
  }
}

// ─── Wikipedia ───────────────────────────────────────────────────────────────

/**
 * Search Wikipedia for a query in a given language, and say which of the three things happened.
 *
 * The internal shape every caller in this module uses. It does not throw: a rejected search is an
 * outcome with `status: "failed"`, because the caller has to be able to tell the three cases apart.
 *
 * @param {string} lang - Wikipedia language subdomain (e.g. "ja", "en").
 * @param {string} query - The search query.
 * @returns {Promise<LookupOutcome & {hits: Array<{title: string}>}>} `hits` is empty unless `status` is "ok".
 */
async function wikiSearchOutcome(lang, query) {
  const label = `Wikipedia search (${lang})`;
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${maxResults()}&maxlag=${WIKI_MAXLAG}&format=json`;
  let attempt;
  try {
    attempt = await requestLookup(url, label);
  } catch (err) {
    return {
      status: LOOKUP_FAILED,
      hits: [],
      httpStatus: err.httpStatus ?? null,
      attempts: err.attempts ?? 0,
      error: err.message,
      circuitOpen: !!err.circuitOpen,
    };
  }
  let data;
  try {
    data = await attempt.response.json();
  } catch (err) {
    noteLookupFailure(`${label} answered with a body that is not JSON`);
    return {
      status: LOOKUP_FAILED,
      hits: [],
      httpStatus: attempt.response.status,
      attempts: attempt.attempts,
      error: `${label} answered with a body that is not JSON (${err.message})`,
      circuitOpen: false,
    };
  }
  const hits = data?.query?.search || [];
  if (hits.length === 0) {
    return { status: LOOKUP_NO_RESULTS, hits: [], httpStatus: 200, attempts: attempt.attempts };
  }
  return { status: LOOKUP_OK, hits, httpStatus: 200, attempts: attempt.attempts };
}

/**
 * Fetch the plain-text intro extract for a Wikipedia page title, and say which of the three things
 * happened.
 *
 * @param {string} lang - Wikipedia language subdomain.
 * @param {string} title - The page title.
 * @returns {Promise<LookupOutcome & {extract: string}>} `extract` is "" unless `status` is "ok".
 */
async function wikiExtractOutcome(lang, title) {
  const label = `Wikipedia extract (${lang})`;
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts` +
    `&exintro=1&explaintext=1&maxlag=${WIKI_MAXLAG}&titles=${encodeURIComponent(title)}&format=json`;
  let attempt;
  try {
    attempt = await requestLookup(url, label);
  } catch (err) {
    return {
      status: LOOKUP_FAILED,
      extract: "",
      httpStatus: err.httpStatus ?? null,
      attempts: err.attempts ?? 0,
      error: err.message,
      circuitOpen: !!err.circuitOpen,
    };
  }
  let data;
  try {
    data = await attempt.response.json();
  } catch (err) {
    noteLookupFailure(`${label} answered with a body that is not JSON`);
    return {
      status: LOOKUP_FAILED,
      extract: "",
      httpStatus: attempt.response.status,
      attempts: attempt.attempts,
      error: `${label} answered with a body that is not JSON (${err.message})`,
      circuitOpen: false,
    };
  }
  const pages = data?.query?.pages;
  if (!pages) return { status: LOOKUP_NO_RESULTS, extract: "", httpStatus: 200, attempts: attempt.attempts };
  const page = Object.values(pages)[0];
  return { status: LOOKUP_OK, extract: page?.extract || "", httpStatus: 200, attempts: attempt.attempts };
}

/**
 * Search Wikipedia for a query in a given language.
 *
 * The primitive the agent-mode wiki tools (`ai/tools-wiki.js`, re-exported through `harness.js`)
 * call, and its contract is unchanged: the search hits, or a thrown error. What it gained is the
 * retry and the breaker underneath it — a tool call that used to fail on the first 429 now gets
 * three polite attempts before it reports an error to the model.
 *
 * @param {string} lang - Wikipedia language subdomain (e.g. "ja", "en").
 * @param {string} query - The search query.
 * @returns {Promise<Array<{title: string}>>} The search hits.
 * @throws {Error} When the search gave up after its retries, or the lookup circuit is open.
 */
async function wikiSearch(lang, query) {
  const outcome = await wikiSearchOutcome(lang, query);
  if (outcome.status === LOOKUP_FAILED) {
    const err = new Error(outcome.error);
    err.httpStatus = outcome.httpStatus;
    err.attempts = outcome.attempts;
    err.circuitOpen = outcome.circuitOpen;
    throw err;
  }
  return outcome.hits;
}

/**
 * Fetch the plain-text intro extract for a Wikipedia page title.
 *
 * @param {string} lang - Wikipedia language subdomain.
 * @param {string} title - The page title.
 * @returns {Promise<string>} The intro extract (may be empty).
 * @throws {Error} When the extract gave up after its retries, or the lookup circuit is open.
 */
async function wikiExtract(lang, title) {
  const outcome = await wikiExtractOutcome(lang, title);
  if (outcome.status === LOOKUP_FAILED) {
    const err = new Error(outcome.error);
    err.httpStatus = outcome.httpStatus;
    err.attempts = outcome.attempts;
    err.circuitOpen = outcome.circuitOpen;
    throw err;
  }
  return outcome.extract;
}

/**
 * Research a single query against Wikipedia in all configured languages.
 *
 * One entry per result, and one entry per language that produced none — each carrying its `status`.
 * A language that was rejected is named as rejected; it is never folded into "no page matched".
 *
 * @param {string} query - The search query.
 * @returns {Promise<Array<object>>} One entry per result (or per language that answered nothing, or per language that failed).
 */
async function researchWiki(query) {
  const results = [];
  for (const lang of wikiLangs()) {
    const search = await wikiSearchOutcome(lang, query);
    if (search.status === LOOKUP_FAILED) {
      results.push({
        lang,
        status: LOOKUP_FAILED,
        title: null,
        url: null,
        extract: null,
        httpStatus: search.httpStatus,
        attempts: search.attempts,
        circuitOpen: search.circuitOpen,
        error: search.error,
      });
      continue;
    }
    if (search.status === LOOKUP_NO_RESULTS) {
      results.push({ lang, status: LOOKUP_NO_RESULTS, title: null, url: null, extract: null, note: "no results" });
      continue;
    }
    for (const hit of search.hits.slice(0, maxResults())) {
      const extract = await wikiExtractOutcome(lang, hit.title);
      const entry = {
        lang,
        status: LOOKUP_OK,
        title: hit.title,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`,
        // A page whose body could not be read is still a page the reference has; the missing body is
        // recorded beside it rather than quietly becoming an empty string.
        extract: extract.status === LOOKUP_OK ? extract.extract.slice(0, maxExtractChars()) : "",
      };
      if (extract.status !== LOOKUP_OK) {
        entry.extractStatus = extract.status;
        entry.extractError = extract.error || "the page has no intro extract";
        entry.extractHttpStatus = extract.httpStatus ?? null;
      }
      results.push(entry);
      await sleep(delayMs());
    }
  }
  return results;
}

// ─── Optional general search API ────────────────────────────────────────────

/**
 * Research a query via the configured general search API (if any).
 *
 * @param {string} query - The search query.
 * @returns {Promise<Array<object>>} Results, or an empty array if not configured.
 */
async function researchSearchApi(query) {
  const api = (process.env.SEARCH_API || "").trim().toLowerCase();
  const key = process.env.SEARCH_API_KEY;
  if (!api || !key) return [];

  try {
    if (api === "brave") {
      const url =
        `https://api.search.brave.com/res/v1/web/search` +
        `?q=${encodeURIComponent(query)}&count=${maxResults()}`;
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": key,
          "User-Agent": userAgent(),
        },
      });
      if (!response.ok) throw new Error(`Brave search failed with status ${response.status}`);
      const data = await response.json();
      return (data?.web?.results || []).map((r) => ({
        provider: "brave",
        status: LOOKUP_OK,
        title: r.title,
        url: r.url,
        extract: (r.description || "").slice(0, maxExtractChars()),
      }));
    }

    if (api === "tavily") {
      const response = await fetchWithTimeout("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, query, max_results: maxResults() }),
      });
      if (!response.ok) throw new Error(`Tavily search failed with status ${response.status}`);
      const data = await response.json();
      return (data?.results || []).map((r) => ({
        provider: "tavily",
        status: LOOKUP_OK,
        title: r.title,
        url: r.url,
        extract: (r.content || "").slice(0, maxExtractChars()),
      }));
    }

    if (api === "serper") {
      const response = await fetchWithTimeout("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": key },
        body: JSON.stringify({ q: query }),
      });
      if (!response.ok) throw new Error(`Serper search failed with status ${response.status}`);
      const data = await response.json();
      return (data?.organic || []).slice(0, maxResults()).map((r) => ({
        provider: "serper",
        status: LOOKUP_OK,
        title: r.title,
        url: r.link,
        extract: (r.snippet || "").slice(0, maxExtractChars()),
      }));
    }

    throw new Error(`Unknown SEARCH_API "${api}" (expected brave, tavily, or serper).`);
  } catch (err) {
    return [{ provider: api, status: LOOKUP_FAILED, title: null, url: null, extract: null, error: err.message }];
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Which of the three states one result entry describes.
 *
 * Reads the `status` this module now writes, and falls back to the older shape for a caller that
 * hands back entries without one (the offline fixtures, and the general search API before this
 * pass) so the three states are decided the same way for every source.
 *
 * @param {object} result - One entry from `researchWiki` or `researchSearchApi`.
 * @returns {"ok"|"no-results"|"failed"}
 */
function classifyLookupResult(result) {
  if (!result) return LOOKUP_FAILED;
  if (result.status === LOOKUP_OK || result.status === LOOKUP_NO_RESULTS || result.status === LOOKUP_FAILED) {
    return result.status;
  }
  if (result.error) return LOOKUP_FAILED;
  if (result.title || result.extract) return LOOKUP_OK;
  return LOOKUP_NO_RESULTS;
}

/**
 * The state of a whole term's lookup, and which languages produced it.
 *
 * The rule that fixes the defect this pass exists for: **a term whose every lookup was rejected is
 * `failed`, not `no-results`.** A term one language answered and another rejected is answered —
 * but the rejected language is named, so a log can say the answer is partial.
 *
 * @param {Array<object>} results - Every entry this term's lookups produced.
 * @returns {{status: "ok"|"no-results"|"failed", answeredLanguages: string[], noResultLanguages: string[], failedLanguages: Array<{lang: string, httpStatus: number|null, attempts: number}>}}
 */
function lookupStatusOf(results) {
  const entries = Array.isArray(results) ? results : [];
  const answeredLanguages = [];
  const noResultLanguages = [];
  const failedLanguages = [];
  for (const entry of entries) {
    const name = String(entry?.lang || entry?.provider || "source");
    const status = classifyLookupResult(entry);
    if (status === LOOKUP_OK) answeredLanguages.push(name);
    else if (status === LOOKUP_NO_RESULTS) {
      answeredLanguages.push(name);
      noResultLanguages.push(name);
    } else {
      failedLanguages.push({
        lang: name,
        httpStatus: entry?.httpStatus ?? null,
        attempts: entry?.attempts ?? 0,
      });
    }
  }
  let status;
  if (answeredLanguages.some((lang) => !noResultLanguages.includes(lang))) status = LOOKUP_OK;
  else if (answeredLanguages.length > 0) status = LOOKUP_NO_RESULTS;
  else status = LOOKUP_FAILED;
  return { status, answeredLanguages, noResultLanguages, failedLanguages };
}

/**
 * Research a list of terms.
 *
 * Sequential on purpose: `researchTerms` walks its terms (and each term's languages) one at a time
 * with a politeness delay, which is the shape a public API asks for and the same reason nothing in
 * this repository runs in parallel (AGENTS.md §7).
 *
 * @param {Array<{term: string, type?: string, query?: string}>} terms
 * @returns {Promise<Array<{term: string, query: string, results: Array, found: boolean, status: "ok"|"no-results"|"failed", answeredLanguages: string[], noResultLanguages: string[], failedLanguages: Array<Object>}>>}
 *   `found` is kept for the callers that already read it, and it is now exactly `status === "ok"`.
 */
async function researchTerms(terms) {
  const notes = [];
  for (const { term, query } of terms) {
    const q = (query && query.trim()) || term;
    const results = [
      ...(await researchWiki(q)),
      ...(await researchSearchApi(q)),
    ];
    const state = lookupStatusOf(results);
    notes.push({
      term,
      query: q,
      results,
      found: state.status === LOOKUP_OK,
      status: state.status,
      answeredLanguages: state.answeredLanguages,
      noResultLanguages: state.noResultLanguages,
      failedLanguages: state.failedLanguages,
    });
    await sleep(delayMs());
  }
  return notes;
}

/**
 * Format research notes into a compact text block suitable for a prompt.
 *
 * @param {Array<{term: string, query: string, results: Array, found: boolean, status?: string}>} notes
 * @returns {string}
 */
function formatResearchNotes(notes) {
  const lines = [];
  for (const note of notes) {
    lines.push(`### ${note.term}`);
    if (note.status === LOOKUP_FAILED) {
      const why = (note.failedLanguages || [])
        .map((f) => `${f.lang}${f.httpStatus ? ` (status ${f.httpStatus})` : ""}`)
        .join(", ");
      lines.push(`- (the reference could not be reached for every lookup${why ? `: ${why}` : ""} — nothing was read)`);
      lines.push("");
      continue;
    }
    if (!note.found) {
      lines.push("- (the reference answered and had nothing for this term)");
      lines.push("");
      continue;
    }
    for (const r of note.results) {
      const source = r.lang || r.provider || "source";
      if (r.error) {
        lines.push(`- [${source}] lookup error: ${r.error}`);
      } else if (r.note) {
        lines.push(`- [${source}] ${r.note}`);
      } else if (r.title) {
        lines.push(`- [${source}] ${r.title}${r.url ? ` — ${r.url}` : ""}`);
        if (r.extract) {
          lines.push(`  ${r.extract.replace(/\s*\n\s*/g, " ").trim()}`);
        } else if (r.extractError) {
          lines.push(`  (the page's intro could not be read: ${r.extractError})`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

module.exports = {
  researchTerms,
  researchWiki,
  formatResearchNotes,
  // The three states, and the term-level rule that decides them.
  LOOKUP_OK,
  LOOKUP_NO_RESULTS,
  LOOKUP_FAILED,
  classifyLookupResult,
  lookupStatusOf,
  // The reliability bounds, exported so a test can name them rather than restate them.
  LOOKUP_MAX_RETRIES,
  LOOKUP_BACKOFF_BASE_MS,
  LOOKUP_RETRY_AFTER_MAX_MS,
  LOOKUP_CIRCUIT_OPEN_AFTER,
  WIKI_MAXLAG,
  isRetryableStatus,
  parseRetryAfterMs,
  retryDelayMs,
  // The breaker. `resetLookupCircuit` is for the offline suites; no stage calls it.
  circuitState,
  noteLookupFailure,
  noteLookupSuccess,
  resetLookupCircuit,
  // Fine-grained primitives used by the agent-mode wiki tools (harness.js).
  wikiSearch,
  wikiExtract,
  wikiSearchOutcome,
  wikiExtractOutcome,
  wikiLangs,
  maxResults,
  maxExtractChars,
};

/**
 * research.js — Client-side web research for glossary terms.
 *
 * Thin barrel over `research/` (AGENTS.md §3). The public surface is this file: every
 * `require("./research")`, every test, and every stub that stands where Wikipedia stands keeps
 * working unchanged, while the logic lives in the folder — `research/config.js` (the knobs that shape
 * one request), `research/bounds.js` (the seven reliability constants), `research/states.js` (the three
 * lookup states and the retry rules), `research/circuit.js` (the run-level breaker and the one request
 * it governs), `research/wiki.js` (the Wikipedia Action API), `research/search-api.js` (the optional
 * general search backend), `research/terms.js` (the term-level rule, the sequential loop, the formatter).
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
 * layer that keeps being rejected stops asking rather than spending the remaining requests getting
 * rejected again. The breaker is **half-open, not permanent**: after `LOOKUP_CIRCUIT_PROBE_AFTER_MS`
 * the next lookup the stage was already going to make is sent as a probe, and if it reaches the
 * reference the circuit closes and the run carries on. Wikipedia's own overload rejection — which
 * this layer deliberately invites by sending `maxlag` — typically clears in seconds, so a permanent
 * breaker would let a 20-second blip cost a 17-volume run every note it would have written. The
 * probe is bounded too: one request, no retries, at most `LOOKUP_CIRCUIT_MAX_PROBES` of them, after
 * which the circuit stays open for the rest of the run. All bounds are constants with no environment
 * knob (AGENTS.md §4.3), and the retry waits honour `Retry-After` when the server sends one.
 *
 * **The cooldown never sleeps.** The layer compares elapsed time and either refuses a request
 * instantly (no network call, no wait) or lets it through; nothing waits for the window to elapse.
 * The politeness sleep (`delayMs()`) and the retry backoff are the only waits in this module.
 *
 * @example
 * const { researchTerms, formatResearchNotes } = require("./research");
 * const notes = await researchTerms([
 *   { term: "如月雨露", type: "character", query: "如月雨露" },
 * ]);
 * const text = formatResearchNotes(notes);
 */

require("dotenv").config();

const bounds = require("./research/bounds");
const circuit = require("./research/circuit");
const config = require("./research/config");
const searchApi = require("./research/search-api");
const states = require("./research/states");
const terms = require("./research/terms");
const wiki = require("./research/wiki");

module.exports = {
  researchTerms: terms.researchTerms,
  researchWiki: wiki.researchWiki,
  formatResearchNotes: terms.formatResearchNotes,
  // The three states, and the term-level rule that decides them.
  LOOKUP_OK: states.LOOKUP_OK,
  LOOKUP_NO_RESULTS: states.LOOKUP_NO_RESULTS,
  LOOKUP_FAILED: states.LOOKUP_FAILED,
  classifyLookupResult: terms.classifyLookupResult,
  lookupStatusOf: terms.lookupStatusOf,
  // The reliability bounds, exported so a test can name them rather than restate them.
  LOOKUP_MAX_RETRIES: bounds.LOOKUP_MAX_RETRIES,
  LOOKUP_BACKOFF_BASE_MS: bounds.LOOKUP_BACKOFF_BASE_MS,
  LOOKUP_RETRY_AFTER_MAX_MS: bounds.LOOKUP_RETRY_AFTER_MAX_MS,
  LOOKUP_CIRCUIT_OPEN_AFTER: bounds.LOOKUP_CIRCUIT_OPEN_AFTER,
  LOOKUP_CIRCUIT_PROBE_AFTER_MS: bounds.LOOKUP_CIRCUIT_PROBE_AFTER_MS,
  LOOKUP_CIRCUIT_MAX_PROBES: bounds.LOOKUP_CIRCUIT_MAX_PROBES,
  WIKI_MAXLAG: bounds.WIKI_MAXLAG,
  isRetryableStatus: states.isRetryableStatus,
  parseRetryAfterMs: states.parseRetryAfterMs,
  retryDelayMs: states.retryDelayMs,
  // The breaker. `resetLookupCircuit` is for the offline suites; no stage calls it.
  circuitState: circuit.circuitState,
  noteLookupFailure: circuit.noteLookupFailure,
  noteLookupSuccess: circuit.noteLookupSuccess,
  resetLookupCircuit: circuit.resetLookupCircuit,
  // **Test seams.** No stage, no stage module and no command in this repository calls these two;
  // scenario 11 of `test/test-lookup-reliability.js` pins that, and pins that no environment variable
  // reaches them or the two probe bounds.
  setLookupClockForTests: circuit.setLookupClockForTests,
  resetLookupClockForTests: circuit.resetLookupClockForTests,
  // Fine-grained primitives used by the agent-mode wiki tools (harness.js).
  wikiSearch: wiki.wikiSearch,
  wikiExtract: wiki.wikiExtract,
  wikiSearchOutcome: wiki.wikiSearchOutcome,
  wikiExtractOutcome: wiki.wikiExtractOutcome,
  wikiLangs: config.wikiLangs,
  maxResults: config.maxResults,
  maxExtractChars: config.maxExtractChars,
};

/**
 * research/config.js — the knobs that shape ONE lookup request.
 *
 * The `Configuration` seam of `research.js` (AGENTS.md §3): the Wikipedia languages, how many results
 * and how many characters to keep, the politeness delay, the per-request timeout, and the User-Agent
 * Wikipedia insists on. Every one of these is a **setting** — read out of `process.env` at call time —
 * and every one of them is the opposite of the reliability bounds in `research/bounds.js`, which are
 * constants a run cannot switch off (AGENTS.md §4.3, gotcha 70). The settings decide how big and how
 * far apart the requests are; they decide nothing about whether a rejected request is retried or when
 * the layer stops asking.
 *
 * **Read at call time, never at require time.** Each of these is a function, so a suite can pin one
 * variable for one scenario after the module has already been required — which is exactly what
 * `test/test-lookup-reliability.js` does. Nothing here resolves a path, so nothing here can move when
 * the module moves into a folder (gotcha 79, gotcha 80). `dotenv` is loaded by the barrel
 * (`research.js`), not here, so one `require("./research")` still configures it exactly once.
 *
 * Part of the lookup layer (research.js).
 */

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

/**
 * Wait, in milliseconds. The only sleep either read path or the retry loop ever takes: the politeness
 * delay and the retry backoff. The circuit breaker's cooldown is **never** slept through (gotcha 147).
 *
 * @param {number} ms - How long to wait.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Per-request timeout for research HTTP requests, in ms (default: 30000). */
function requestTimeoutMs() {
  return Math.max(1000, parseInt(process.env.RESEARCH_TIMEOUT_MS, 10) || 30000);
}

module.exports = {
  DEFAULT_USER_AGENT,
  wikiLangs,
  maxResults,
  maxExtractChars,
  delayMs,
  userAgent,
  sleep,
  requestTimeoutMs,
};

/**
 * research/wiki.js — the Wikipedia Action API half of the lookup layer.
 *
 * The `Wikipedia` seam of `research.js` (AGENTS.md §3): the two calls (search, intro extract), each in
 * the shape every caller in this layer uses, and the two throwing primitives the agent wiki tools are
 * built on.
 *
 * **Two shapes, on purpose.** `wikiSearchOutcome` / `wikiExtractOutcome` never throw: a rejected lookup
 * comes back as an outcome with `status: "failed"`, because the caller has to be able to tell the three
 * states apart — that is the whole point of the reliability pass (gotcha 147). `wikiSearch` /
 * `wikiExtract` are the older contract `ai/tools-wiki.js` (re-exported through `harness.js`) already
 * depends on: the hits, or a thrown error. They are thin wrappers over the outcome functions, so the
 * retry and the breaker underneath them are shared rather than duplicated, and `createWikiTools` needed
 * no edit when the retry landed.
 *
 * Part of the lookup layer (research.js).
 */

const { delayMs, maxExtractChars, maxResults, sleep, wikiLangs } = require("./config");
const { WIKI_MAXLAG } = require("./bounds");
const { LOOKUP_FAILED, LOOKUP_NO_RESULTS, LOOKUP_OK } = require("./states");
const { noteLookupFailure, requestLookup } = require("./circuit");

/** @typedef {import("./states").LookupOutcome} LookupOutcome */

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

module.exports = {
  wikiSearchOutcome,
  wikiExtractOutcome,
  wikiSearch,
  wikiExtract,
  researchWiki,
};

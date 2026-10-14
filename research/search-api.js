/**
 * research/search-api.js — the optional general web-search backend.
 *
 * The `Optional general search API` seam of `research.js` (AGENTS.md §3): Brave / Tavily / Serper,
 * enabled only when both `SEARCH_API` and `SEARCH_API_KEY` are set, and returning `[]` when they are
 * not — which is why every offline suite pins `SEARCH_API=""` rather than mocking this file.
 *
 * **It is not behind the breaker or the retry**, and that is the behaviour as shipped: it goes through
 * `fetchWithTimeout` alone, so a refusal here is one request and a `status: "failed"` entry, not three
 * polite attempts. The three states still apply, because `research/notes.js` decides a term's state
 * from every entry it got, whatever produced them.
 *
 * Part of the lookup layer (research.js).
 */

const { maxExtractChars, maxResults, userAgent } = require("./config");
const { LOOKUP_FAILED, LOOKUP_OK } = require("./states");
const { fetchWithTimeout } = require("./circuit");

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

module.exports = { researchSearchApi };

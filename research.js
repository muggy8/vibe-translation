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

// ─── Wikipedia ──────────────────────────────────────────────────────────────

/**
 * Search Wikipedia for a query in a given language.
 *
 * @param {string} lang - Wikipedia language subdomain (e.g. "ja", "en").
 * @param {string} query - The search query.
 * @returns {Promise<Array<{title: string}>>} The search hits.
 */
async function wikiSearch(lang, query) {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${maxResults()}&format=json`;
  const response = await fetch(url, { headers: { "User-Agent": userAgent() } });
  if (!response.ok) {
    throw new Error(`Wikipedia search (${lang}) failed with status ${response.status}`);
  }
  const data = await response.json();
  return data?.query?.search || [];
}

/**
 * Fetch the plain-text intro extract for a Wikipedia page title.
 *
 * @param {string} lang - Wikipedia language subdomain.
 * @param {string} title - The page title.
 * @returns {Promise<string>} The intro extract (may be empty).
 */
async function wikiExtract(lang, title) {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts` +
    `&exintro=1&explaintext=1&titles=${encodeURIComponent(title)}&format=json`;
  const response = await fetch(url, { headers: { "User-Agent": userAgent() } });
  if (!response.ok) {
    throw new Error(`Wikipedia extract (${lang}) failed with status ${response.status}`);
  }
  const data = await response.json();
  const pages = data?.query?.pages;
  if (!pages) return "";
  const page = Object.values(pages)[0];
  return page?.extract || "";
}

/**
 * Research a single query against Wikipedia in all configured languages.
 *
 * @param {string} query - The search query.
 * @returns {Promise<Array<object>>} One entry per result (or per failed language).
 */
async function researchWiki(query) {
  const results = [];
  for (const lang of wikiLangs()) {
    try {
      const hits = await wikiSearch(lang, query);
      if (hits.length === 0) {
        results.push({ lang, title: null, url: null, extract: null, note: "no results" });
        continue;
      }
      for (const hit of hits.slice(0, maxResults())) {
        let extract = "";
        try {
          extract = (await wikiExtract(lang, hit.title)).slice(0, maxExtractChars());
        } catch {
          // Keep the result even if the extract fails.
        }
        results.push({
          lang,
          title: hit.title,
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`,
          extract,
        });
        await sleep(delayMs());
      }
    } catch (err) {
      results.push({ lang, title: null, url: null, extract: null, error: err.message });
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
      const response = await fetch(url, {
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
        title: r.title,
        url: r.url,
        extract: (r.description || "").slice(0, maxExtractChars()),
      }));
    }

    if (api === "tavily") {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: key, query, max_results: maxResults() }),
      });
      if (!response.ok) throw new Error(`Tavily search failed with status ${response.status}`);
      const data = await response.json();
      return (data?.results || []).map((r) => ({
        provider: "tavily",
        title: r.title,
        url: r.url,
        extract: (r.content || "").slice(0, maxExtractChars()),
      }));
    }

    if (api === "serper") {
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": key },
        body: JSON.stringify({ q: query }),
      });
      if (!response.ok) throw new Error(`Serper search failed with status ${response.status}`);
      const data = await response.json();
      return (data?.organic || []).slice(0, maxResults()).map((r) => ({
        provider: "serper",
        title: r.title,
        url: r.link,
        extract: (r.snippet || "").slice(0, maxExtractChars()),
      }));
    }

    throw new Error(`Unknown SEARCH_API "${api}" (expected brave, tavily, or serper).`);
  } catch (err) {
    return [{ provider: api, title: null, url: null, extract: null, error: err.message }];
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Research a list of terms.
 *
 * @param {Array<{term: string, type?: string, query?: string}>} terms
 * @returns {Promise<Array<{term: string, query: string, results: Array, found: boolean}>>}
 */
async function researchTerms(terms) {
  const notes = [];
  for (const { term, query } of terms) {
    const q = (query && query.trim()) || term;
    const results = [
      ...(await researchWiki(q)),
      ...(await researchSearchApi(q)),
    ];
    const found = results.some((r) => r.extract || r.title);
    notes.push({ term, query: q, results, found });
    await sleep(delayMs());
  }
  return notes;
}

/**
 * Format research notes into a compact text block suitable for a prompt.
 *
 * @param {Array<{term: string, query: string, results: Array, found: boolean}>} notes
 * @returns {string}
 */
function formatResearchNotes(notes) {
  const lines = [];
  for (const note of notes) {
    lines.push(`### ${note.term}`);
    if (!note.found) {
      lines.push("- (no research results found)");
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
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

module.exports = { researchTerms, researchWiki, formatResearchNotes };

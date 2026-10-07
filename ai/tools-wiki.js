/**
 * wiki_search / wiki_extract: the research tools an agent may be handed. They are
 * HTTP calls to Wikipedia made by the harness, not model calls, which is why the
 * offline pipeline run sets RESEARCH_ENABLED=false.
 *
 * Part of the harness.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions
const { tool, generateText } = require("ai");
const { z } = require("zod");

/**
 * Build the Wikipedia research tools for the researcher agent.
 *
 * Backed by research.js (keyless Wikipedia Action API, politeness delays,
 * per-request timeouts): the model decides what to search for and which
 * pages to pull, instead of the old fixed batch over every extracted term.
 * Result sizes honor the same RESEARCH_MAX_RESULTS / RESEARCH_EXTRACT_CHARS
 * environment settings as the classic research pass.
 *
 * @returns {WikiTools} Tool set: { wiki_search, wiki_extract }.
 */
function createWikiTools() {
  const {
    wikiSearch,
    wikiExtract,
    wikiLangs,
    maxResults,
    maxExtractChars,
  } = require("../research");
  const langs = wikiLangs();
  return {
    wiki_search: tool({
      description:
        `Search Wikipedia for a term. Returns matching page titles ` +
        `(up to ${maxResults()} per language). Languages: ${langs.join(", ")}. ` +
        `Pass lang to restrict to one language; omit it to search all. ` +
        `Use the term's original-language spelling when known.`,
      inputSchema: z.object({
        query: z.string().describe("The term to search for."),
        lang: z
          .string()
          .optional()
          .describe(
            `Optional single language subdomain (one of: ${langs.join(", ")}).`
          ),
      }),
      execute: async ({ query, lang }) => {
        const targets = lang ? [lang] : langs;
        const out = {};
        for (const l of targets) {
          try {
            const hits = await wikiSearch(l, query);
            out[l] = hits.slice(0, maxResults()).map((h) => h.title);
          } catch (err) {
            out[l] = `search error: ${err.message}`;
          }
        }
        return JSON.stringify(out);
      },
    }),
    wiki_extract: tool({
      description:
        `Fetch the plain-text intro of a Wikipedia page (up to ` +
        `${maxExtractChars()} characters). title must be exactly as returned ` +
        `by wiki_search, and lang the language it came from.`,
      inputSchema: z.object({
        title: z.string().describe("Exact page title from wiki_search results."),
        lang: z
          .string()
          .describe(
            `Language subdomain the title came from (one of: ${langs.join(", ")}).`
          ),
      }),
      execute: async ({ title, lang }) => {
        try {
          const text = (await wikiExtract(lang, title)).slice(0, maxExtractChars());
          return text ? text : "(page has no intro extract)";
        } catch (err) {
          return `extract error: ${err.message}`;
        }
      },
    }),
  };
}

// ─── Epub tools (the intake agent's senses) ─────────────────────────────────


module.exports = {
  createWikiTools,
};

/**
 * research/terms.js — what one term's whole set of lookups means, and the notes they become.
 *
 * The `Public API` seam of `research.js` (AGENTS.md §3): the term-level rule that turns a pile of
 * per-language entries into one state, the sequential loop that asks for them, and the formatter that
 * hands the answer to a prompt.
 *
 * **The rule that fixes the defect this layer exists for** (gotcha 147): a term whose every lookup was
 * rejected is `failed`, **not** `no-results`. A term one language answered and another rejected is
 * answered — but the rejected language is named, so a log can say the answer rests on half the
 * reference. `glossary/research.js` imports these two functions rather than restating them, because
 * "did the reference answer, or did it refuse?" has to mean the same thing in the layer that made the
 * request and the pass that files what it brought back.
 *
 * **Sequential on purpose.** `researchTerms` walks its terms (and each term's languages) one at a time
 * with a politeness delay — the shape a public API asks for, and the same reason nothing in this
 * repository runs in parallel (AGENTS.md §7).
 *
 * Part of the lookup layer (research.js).
 */

const { delayMs, sleep } = require("./config");
const { LOOKUP_FAILED, LOOKUP_NO_RESULTS, LOOKUP_OK } = require("./states");
const { noteTermUnansweredByCircuit } = require("./circuit");
const { researchWiki } = require("./wiki");
const { researchSearchApi } = require("./search-api");

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
    // A term the breaker refused every lookup for is a note this run did not write. Counted here, at
    // the term level, so the moment the circuit closes can say how many notes the open window cost —
    // and nothing else about these terms changes: they file nothing, are named under "Could not ask",
    // and are asked again next pass.
    if (state.status === LOOKUP_FAILED && results.some((entry) => entry.circuitOpen === true)) {
      noteTermUnansweredByCircuit();
    }
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
  classifyLookupResult,
  lookupStatusOf,
  researchTerms,
  formatResearchNotes,
};

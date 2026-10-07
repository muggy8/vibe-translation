/**
 * The two notes handed to the amend pass as first-class inputs: the open GLOSSARY
 * DISPUTES the translation stage raised (each one must be settled — correct the
 * entry, or record in its Notes the evidence that makes the canonical rendering
 * stand), and the coverage audit's zero-occurrence entries (hallucinated-entry
 * candidates).
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions

/**
 * Turn the previous volume's coverage audit into a note for THIS volume's
 * extraction pass (report → input).
 *
 * `glossary-coverage.json` already knows which entries were never used: the terms
 * carried in the cumulative glossary that do not occur once in the volume they
 * were built for. Without this note the glossary only ever grows — a term
 * hallucinated in volume 3 is carried forward by every later volume's amend pass
 * and nobody is ever told it has never been seen. With it, the extractor is
 * handed the list and asked to reconsider it.
 *
 * Bounded on purpose: a 200-term list pasted into a prompt is noise, and the
 * point is to raise the worst offenders, not to restate the whole glossary.
 *
 * @param {Object|null} coverage - The parsed `glossary-coverage.json` of the previous volume.
 * @param {number} [limit] - How many zero-occurrence terms to name.
 * @returns {string} "" when there is nothing to say.
 */
/**
 * Turn the open glossary disputes into a first-class input for the amend pass.
 *
 * The dispute came from a model reading the SOURCE and concluding that the
 * glossary entry is wrong. The amend pass is the only place that can settle it,
 * and it must settle it EXPLICITLY: either correct the entry, or record why the
 * canonical rendering stands. Silence is not an answer — an unresolved dispute
 * reappears in every later volume's verification.
 *
 * @param {Array<Object>} disputes - The parsed series dispute queue.
 * @param {string} installmentNumber - The volume being amended (for the header).
 * @param {number} [limit] - How many disputes to name (bounded: a 200-row list is noise).
 * @returns {string} "" when there is nothing open.
 */
function buildDisputesNote(disputes, installmentNumber, limit = 40) {
  const list = Array.isArray(disputes) ? disputes : [];
  if (list.length === 0) return "";
  const shown = list.slice(0, limit);
  const lines = [
    "",
    "",
    `## Open glossary disputes (challenged during translation of earlier volumes)`,
    "",
    `These renderings were challenged by the translation verifier while working on ` +
      `another volume: the verifier read the source text and found the canonical ` +
      `rendering contradicts it. For EACH one below, volume ${installmentNumber}'s ` +
      `amendment must either (a) correct the entry to the rendering the source supports, ` +
      `or (b) keep the canonical rendering and record, in the entry's Notes column, ` +
      `the evidence that makes it stand. Do not leave a dispute unaddressed and do ` +
      `not silently drop the entry.`,
    "",
  ];
  for (const d of shown) {
    lines.push(`- **${d.term}** — glossary says "${d.canonical || "?"}"; ` +
      `challenged as "${d.proposed || "(no alternative proposed)"}"`);
    if (d.sourceQuote) lines.push(`  - Evidence from the source: "${d.sourceQuote}"`);
    else lines.push(`  - **No source quote recorded** — check it against this volume's source before changing anything.`);
    const raised = Array.isArray(d.raised) ? d.raised : [];
    if (raised.length > 0) {
      lines.push(`  - Raised in: ${raised.map((r) => `volume ${r.volume}${r.chapter ? ` ${r.chapter}` : ""}`).join(", ")}`);
    }
  }
  if (list.length > shown.length) {
    lines.push(`- …and ${list.length - shown.length} more (see glossary-disputes.md at the series root).`);
  }
  return lines.join("\n");
}


function buildUnusedEntriesNote(coverage, limit = 40) {
  const terms = coverage && Array.isArray(coverage.terms) ? coverage.terms : [];
  if (terms.length === 0) return "";
  const zero = terms.filter((t) => t && typeof t.occurrences === "number" && t.occurrences === 0);
  if (zero.length === 0) return "";
  const named = zero.slice(0, limit).map((t) => `- ${t.term}${t.section ? ` (${t.section})` : ""}`);
  const rest = zero.length - named.length;
  return (
    `\n\n## Entries the previous volume never used\n` +
    `The coverage audit of volume ${coverage.volume} found ${zero.length} glossary entr(ies) that do not ` +
    `occur ONCE in that volume's text:\n${named.join("\n")}` +
    (rest > 0 ? `\n- … and ${rest} more.` : "") +
    `\n\nFor each one you can see in the current glossary: if it is a real term that simply does not ` +
    `appear in these chapters, keep it unchanged. If it has no support in the text at all, treat it as a ` +
    `candidate for removal (or for a corrected source form) and say so in the glossary's notes rather ` +
    `than carrying it forward silently.\n`
  );
}

// ─── Malformed-tool-call guard ──────────────────────────────────────────────

// The "model emitted tool-call syntax as plain text" guard (emittedToolCallAsText
// + assertRealToolCalls) is shared by every file-writing task — see
// utils/agents.js (AGENTS.md gotcha 18).

// ─── Parallel research helpers ──────────────────────────────────────────────


module.exports = {
  buildDisputesNote,
  buildUnusedEntriesNote,
};

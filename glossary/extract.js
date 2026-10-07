/**
 * The new-terms extraction call and the window of the previous glossary it is
 * shown.
 *
 * The truncation window is RELEVANCE-ranked against the text being processed, never
 * by document position (gotcha 41) — the glossary is cumulative, so "the first N
 * entries" shows the earliest volumes' terms and throws away exactly what a later
 * volume needs. Truncating here means "some existing terms may be re-proposed as
 * new", which is harmless: the amend pass reconciles duplicates to one canonical
 * rendering. It no longer means "the agent cannot see entries it must preserve",
 * which is what it used to mean and what the 457-term loss came out of.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions

const { GLOSSARY_TRUNCATION_MAX_ENTRIES, GLOSSARY_TRUNCATION_THRESHOLD } = require("./config");

/**
 * Parse the AI's term-list output into an array of { term, type, query }.
 * Tolerates markdown fences and surrounding prose.
 *
 * @param {string} output - The raw AI output.
 * @returns {Array<{term: string, type: string, query: string}>}
 */
function parseTerms(output) {
  if (!output || typeof output !== "string") {
    return [];
  }
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new Error("No JSON array found in the term-list output.");
  }
  const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("The term-list output was not a JSON array.");
  }
  return parsed
    .filter((entry) => entry && typeof entry.term === "string" && entry.term.trim() !== "")
    .map((entry) => ({
      term: entry.term.trim(),
      type: typeof entry.type === "string" && entry.type.trim() !== "" ? entry.type.trim() : "concept",
      query: typeof entry.query === "string" && entry.query.trim() !== "" ? entry.query.trim() : entry.term.trim(),
    }));
}

// ─── Context truncation helpers ──────────────────────────────────────────────


/**
 * Truncate a glossary file to the entries that MATTER for the volume being
 * processed, when it exceeds the configured threshold. Returns the full content
 * when under the threshold, or the truncated content (with a header note) when
 * over it.
 *
 * The old rule was "drop the oldest rows in document order". A glossary is
 * organised by SECTION (Characters, Places, Items…), not by when entries were
 * added — so the head of the Characters table is the volume-1 main cast, and
 * dropping "the oldest rows" threw away exactly the entries a later volume is
 * most likely to contain. The extractor was then shown 200 rows that excluded
 * the protagonists and duly rediscovered them as brand-new terms, volume after
 * volume.
 *
 * The selection is now deterministic and relevance-ordered: rows whose source
 * term actually occurs in THIS volume's text are kept first (in document order),
 * then the remaining rows. Section structure and table headers are preserved; a
 * section whose rows are all omitted loses its heading, so the model is never
 * told about a section it cannot see.
 *
 * @param {string} content - The full glossary file content.
 * @param {string} [sourceText] - The volume/chapter source text, used to rank rows by whether the term occurs in it.
 * @returns {string} The (possibly truncated) content.
 */
function truncateGlossary(content, sourceText) {
  if (!content || content.length <= GLOSSARY_TRUNCATION_THRESHOLD) return content;

  // Group the file into runs: a table (consecutive "|…" lines) or a single
  // other line. Inside a table, line 0 is the column header and line 1 the
  // |---| separator; everything after that is one term entry.
  //
  // (Rewritten: this helper used to split on "- Term:" list items, but the
  // glossary the workflow prompts for is a set of Markdown TABLES
  // (`| source | rendering | notes |`), so the split found zero entries and the
  // helper returned the file unchanged no matter how big it got — the
  // truncation AGENTS.md describes had never actually happened.)
  const lines = content.split("\n");
  const runs = [];
  let currentSection = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i].trim())) {
      currentSection = runs.length;
      runs.push({ kind: "line", block: [lines[i]] });
      continue;
    }
    if (lines[i].trim().startsWith("|")) {
      const start = i;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) i++;
      const block = lines.slice(start, i + 1);
      runs.push({
        kind: "table",
        block,
        dataFrom: block.length > 1 ? 2 : block.length,
        section: currentSection,
      });
      continue;
    }
    runs.push({ kind: "line", block: [lines[i]] });
  }

  // Every data row, tagged with the section heading it belongs to and whether
  // its source term occurs in the text being translated.
  const src = (sourceText || "").trim();
  const rows = [];
  runs.forEach((run, runIdx) => {
    if (run.kind !== "table") return;
    for (let k = run.dataFrom; k < run.block.length; k++) {
      const cells = run.block[k].split("|").map((c) => c.trim()).filter((c) => c !== "");
      rows.push({
        runIdx,
        lineIdx: k,
        term: cells[0] || "",
        occurs: src ? cells[0] && src.includes(cells[0]) : null,
      });
    }
  });
  const totalData = rows.length;
  if (totalData <= GLOSSARY_TRUNCATION_MAX_ENTRIES) return content;

  // Relevance first, document order within each group. Without a source text the
  // old behavior is kept (the newest window, and the note says so).
  const hasSource = Boolean(src);
  const ordered = hasSource
    ? [...rows].sort((a, b) => {
        const d = (a.occurs ? 0 : 1) - (b.occurs ? 0 : 1);
        if (d !== 0) return d;
        if (a.runIdx !== b.runIdx) return a.runIdx - b.runIdx;
        return a.lineIdx - b.lineIdx;
      })
    : [...rows].reverse();
  const keep = new Set(ordered.slice(0, GLOSSARY_TRUNCATION_MAX_ENTRIES).map((r) => `${r.runIdx}:${r.lineIdx}`));
  const keptOccurs = ordered.slice(0, GLOSSARY_TRUNCATION_MAX_ENTRIES).filter((r) => r.occurs === true).length;
  const dropped = totalData - keep.size;

  // Re-render the runs, keeping only the rows that survived, and dropping a
  // heading whose tables lost every row.
  const out = [];
  const droppedSections = new Set();
  for (const [runIdx, run] of runs.entries()) {
    if (run.kind !== "table") continue;
    const kept = [];
    for (let k = run.dataFrom; k < run.block.length; k++) {
      if (keep.has(`${runIdx}:${k}`)) kept.push(run.block[k]);
    }
    if (kept.length === 0) {
      droppedSections.add(run.section);
      continue;
    }
    out.push({ runIdx, lines: [...run.block.slice(0, run.dataFrom), ...kept] });
  }
  const keptRunIdx = new Set(out.map((o) => o.runIdx));
  const final = [];
  for (const [runIdx, run] of runs.entries()) {
    if (run.kind === "table") {
      const rendered = out.find((o) => o.runIdx === runIdx);
      if (rendered) final.push(...rendered.lines);
      continue;
    }
    // A heading whose tables were truncated away entirely is dropped, so the
    // model is not told about a section it cannot see.
    if (/^#{1,6}\s+/.test(run.block[0].trim()) && droppedSections.has(runIdx)) continue;
    final.push(...run.block);
  }

  const keptCount = totalData - dropped;
  final.splice(
    1,
    0,
    "",
    src
      ? `[TRUNCATED: this glossary has ${totalData} term rows. Showing ${keptCount} of them — every row ` +
        `whose source term occurs in the text being translated (${keptOccurs} such row(s) are included), ` +
        `then the rest in document order. ${dropped} row(s)${droppedSections.size ? ` and ${droppedSections.size} fully omitted section(s)` : ""} ` +
        `are not shown; they are carried forward UNCHANGED in the file itself, so do not re-add a term ` +
        `as new merely because it is absent from what you can see here.]`
      : `[TRUNCATED: this glossary has ${totalData} term rows. Showing the ${keptCount} in document order; ` +
        `${dropped} row(s)${droppedSections.size ? ` and ${droppedSections.size} fully omitted section(s)` : ""} are omitted. ` +
        `Earlier entries are carried forward unchanged in the file itself — reconcile NEW terms against what is shown here.]`
  );
  return final.join("\n");
}


module.exports = {
  parseTerms,
  truncateGlossary,
};

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

  const runs = splitIntoRuns(content.split("\n"));
  const src = (sourceText || "").trim();
  const rows = collectDataRows(runs, src);
  if (rows.length <= GLOSSARY_TRUNCATION_MAX_ENTRIES) return content;

  const keep = chooseRowsToKeep(rows, src);
  const { lines, droppedSections } = renderKeptRuns(runs, keep);
  const keptOccurs = rows.filter((r) => r.occurs === true && keep.has(`${r.runIdx}:${r.lineIdx}`)).length;

  lines.splice(
    1,
    0,
    "",
    truncationNote({
      total: rows.length,
      kept: keep.size,
      keptOccurs,
      dropped: rows.length - keep.size,
      droppedSections: droppedSections.size,
      hasSource: Boolean(src),
    })
  );
  return lines.join("\n");
}

/**
 * Group the file into runs: a table (consecutive "|…" lines) or a single other line. Inside a table,
 * line 0 is the column header and line 1 the |---| separator; everything after that is one term entry.
 *
 * (Rewritten: this helper used to split on "- Term:" list items, but the glossary the workflow prompts
 * for is a set of Markdown TABLES (`| source | rendering | notes |`), so the split found zero entries
 * and the helper returned the file unchanged no matter how big it got — the truncation AGENTS.md
 * describes had never actually happened.)
 *
 * @param {string[]} lines - The glossary file, split on newlines.
 * @returns {Array<{kind: "table"|"line", block: string[], dataFrom?: number, section: number|null}>}
 *   The runs, in document order. `section` on a table is the run index of the heading it sits under.
 */
function splitIntoRuns(lines) {
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
  return runs;
}

/**
 * Every data row in the file, tagged with the run it belongs to and whether its source term actually
 * occurs in the text being processed.
 *
 * That last tag is the whole relevance rule: a row is worth showing the extractor when the volume in
 * front of it contains the term, whatever position the row holds in the glossary.
 *
 * @param {Array<{kind: string, block: string[], dataFrom?: number}>} runs
 * @param {string} src - The trimmed source text, or "" when none was given.
 * @returns {Array<{runIdx: number, lineIdx: number, term: string, occurs: boolean|null}>}
 */
function collectDataRows(runs, src) {
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
  return rows;
}

/**
 * Which rows survive the window.
 *
 * Relevance first, document order within each group. Without a source text the old behavior is kept
 * (the newest window, and the note says so).
 *
 * @param {Array<{runIdx: number, lineIdx: number, occurs: boolean|null}>} rows
 * @param {string} src - The trimmed source text, or "".
 * @returns {Set<string>} The `runIdx:lineIdx` keys of the rows to keep.
 */
function chooseRowsToKeep(rows, src) {
  const hasSource = Boolean(src);
  const ordered = hasSource
    ? [...rows].sort((a, b) => {
        const d = (a.occurs ? 0 : 1) - (b.occurs ? 0 : 1);
        if (d !== 0) return d;
        if (a.runIdx !== b.runIdx) return a.runIdx - b.runIdx;
        return a.lineIdx - b.lineIdx;
      })
    : [...rows].reverse();
  return new Set(ordered.slice(0, GLOSSARY_TRUNCATION_MAX_ENTRIES).map((r) => `${r.runIdx}:${r.lineIdx}`));
}

/**
 * Re-render the runs keeping only the rows that survived, and dropping a heading whose tables lost
 * every row — so the model is never told about a section it cannot see.
 *
 * @param {Array<{kind: string, block: string[], dataFrom?: number, section: number|null}>} runs
 * @param {Set<string>} keep - The `runIdx:lineIdx` keys chosen by {@link chooseRowsToKeep}.
 * @returns {{lines: string[], droppedSections: Set<number|null>}} The rendered file body, and the
 *   headings that were dropped with it.
 */
function renderKeptRuns(runs, keep) {
  const rendered = new Map();
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
    rendered.set(runIdx, [...run.block.slice(0, run.dataFrom), ...kept]);
  }

  const lines = [];
  for (const [runIdx, run] of runs.entries()) {
    if (run.kind === "table") {
      const block = rendered.get(runIdx);
      if (block) lines.push(...block);
      continue;
    }
    if (/^#{1,6}\s+/.test(run.block[0].trim()) && droppedSections.has(runIdx)) continue;
    lines.push(...run.block);
  }
  return { lines, droppedSections };
}

/**
 * The line the truncated copy announces itself with.
 *
 * It has to say what is missing AND that the missing rows still exist in the file: without the second
 * half, an extractor seeing 200 of 445 rows reports the other 245 as brand-new terms, which is how
 * volume after volume re-rediscovered its own protagonists.
 *
 * @param {{total: number, kept: number, keptOccurs: number, dropped: number, droppedSections: number, hasSource: boolean}} stats
 * @returns {string} The note.
 */
function truncationNote({ total, kept, keptOccurs, dropped, droppedSections, hasSource }) {
  const omitted = `${dropped} row(s)${droppedSections ? ` and ${droppedSections} fully omitted section(s)` : ""}`;
  return hasSource
    ? `[TRUNCATED: this glossary has ${total} term rows. Showing ${kept} of them — every row ` +
      `whose source term occurs in the text being translated (${keptOccurs} such row(s) are included), ` +
      `then the rest in document order. ${omitted} ` +
      `are not shown; they are carried forward UNCHANGED in the file itself, so do not re-add a term ` +
      `as new merely because it is absent from what you can see here.]`
    : `[TRUNCATED: this glossary has ${total} term rows. Showing the ${kept} in document order; ` +
      `${omitted} are omitted. ` +
      `Earlier entries are carried forward unchanged in the file itself — reconcile NEW terms against what is shown here.]`;
}


module.exports = {
  parseTerms,
  truncateGlossary,
};

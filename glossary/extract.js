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
// The same reading of a glossary row the cumulative gate uses: `glossaryTermSpans` is how this layer
// spells "the spellings one row names", and a second definition of it is how the extractor and the
// gate end up disagreeing about the same row. `buildGlossaryIndex` is the same layer's compact
// name-and-rendering view of a whole glossary, which is what lets the window hide Notes without
// hiding entries.
const {
  glossaryTermSpans,
  glossaryTermSkeleton,
  GLOSSARY_SKELETON_MIN_CHARS,
  buildGlossaryIndex,
} = require("./carry-forward/table");

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
 * The selection is deterministic and relevance-ordered: rows whose source term actually occurs in THIS
 * volume's text are kept first (in document order), then the remaining rows up to
 * `GLOSSARY_TRUNCATION_MAX_ENTRIES`. And every term the file holds is handed over as a name in the
 * complete index appended below the tables, so the window hides a row's Notes, never the existence of
 * an entry. That guarantee is the point of the function: a row the text mentions that the extractor
 * cannot see is re-proposed as a new term, the amend pass reconciles it into the row that already held
 * it, and the cumulative gate then has to tell that rename from a deletion. That is the chain that
 * ended the 12-hour run on volume 15 (gotcha 68), and the relevance test below is where it starts.
 *
 * Section structure and table headers are preserved; a section whose rows are all
 * omitted loses its heading, so the model is never told about a section it cannot
 * see.
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
  const relevantTotal = rows.filter((r) => r.occurs === true).length;
  const relevantShown = rows.filter((r) => r.occurs === true && keep.has(`${r.runIdx}:${r.lineIdx}`)).length;

  lines.splice(
    1,
    0,
    "",
    truncationNote({
      total: rows.length,
      kept: keep.size,
      relevantTotal,
      relevantShown,
      dropped: rows.length - keep.size,
      droppedSections: droppedSections.size,
      hasSource: Boolean(src),
    })
  );

  // The part a window cannot fit as a full row is still handed over as a NAME. Rows carry Notes, and
  // Notes are what makes a glossary big; a term plus its rendering is a line, and every term in the
  // file fits in it. This is what makes the note above a rule instead of a wish: the extractor cannot
  // open the glossary file (it is a one-shot call with no tools), so "do not re-propose what you cannot
  // see" only means something when it can see all of them. On the live series: 445 terms, 14.7 KB.
  const index = buildGlossaryIndex(content);
  if (index) {
    lines.push(
      "",
      `[EVERY TERM THIS GLOSSARY ALREADY HOLDS — all ${rows.length} of them, name and rendering only, ` +
        `no definitions. A term named here is NOT new, whatever spelling the text above uses for it. ` +
        `The tables above are the full rows (with Notes) for the terms that text actually mentions.]`,
      index
    );
  }
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
 * Does this row's term occur in the text being processed — under ANY spelling the row names?
 *
 * The rule this replaces was `sourceText.includes(wholeFirstCell)`: the row counted as relevant only
 * when the glossary's term column appeared in the chapter **verbatim, whole**. A glossary writes a
 * term the way the glossary writes it and the book prints it the way the book prints it, and those are
 * not the same string when furigana is involved. Volume 14's row is `双ふた花ばの恋物語`; volume 15
 * chapter 6 prints `双ふた花ばの恋こい物もの語がたり` — furigana inserted INSIDE the word — so neither
 * contains the other, the row was invisible to the extractor, and the term was re-proposed as brand
 * new. The amend pass then reconciled the two spellings into one row exactly as its prompt instructs,
 * and the carry-forward gate — which at the time read only the term column — called the result a
 * deletion, quarantined a glossary that had GROWN from 445 rows to 460, and a 12-hour run died there
 * (gotcha 68). Measured on those two volumes: the whole-cell rule found 45 of the 445 carried rows
 * relevant to volume 15; reading the spellings inside each row finds 70.
 *
 * Two tests, both deterministic and both cheap:
 *   1. any spelling the cell names (the `/`-separated list `glossaryTermSpans` reads) occurs verbatim;
 *   2. …or the row's Han characters in order — every kana dropped, which is what a term looks like
 *      once you stop writing its furigana — occurs in the same projection of the source. A skeleton
 *      shorter than `GLOSSARY_SKELETON_MIN_CHARS` is not trusted, because two common kanji sitting
 *      next to each other happen all over a real page.
 *
 * Deliberately loose on the false-positive side, and the asymmetry is the reason: a row shown to the
 * extractor that the chapter happens not to mention costs a few hundred characters of prompt, while a
 * row hidden from it costs a re-proposed term, an amend reconcile, and a gate that has to tell a
 * rename from a loss.
 *
 * @param {string} term - One row's term column.
 * @param {string} src - The trimmed source text ("" when there is none).
 * @param {string} srcSkeleton - {@link glossaryTermSkeleton} of `src`, computed once per call.
 * @returns {boolean}
 */
function rowTermOccursIn(term, src, srcSkeleton) {
  for (const span of glossaryTermSpans(term)) {
    if (src.includes(span)) return true;
    if (srcSkeleton) {
      const skeleton = glossaryTermSkeleton(span);
      if (skeleton.length >= GLOSSARY_SKELETON_MIN_CHARS && srcSkeleton.includes(skeleton)) return true;
    }
  }
  return false;
}


/**
 * Every data row in the file, tagged with the run it belongs to and whether its source term actually
 * occurs in the text being processed.
 *
 * That last tag is the whole relevance rule: a row is worth showing the extractor when the volume in
 * front of it contains the term, whatever position the row holds in the glossary and whatever spelling
 * either side uses.
 *
 * @param {Array<{kind: string, block: string[], dataFrom?: number}>} runs
 * @param {string} src - The trimmed source text, or "" when none was given.
 * @returns {Array<{runIdx: number, lineIdx: number, term: string, occurs: boolean|null}>}
 */
function collectDataRows(runs, src) {
  const srcSkeleton = src ? glossaryTermSkeleton(src) : "";
  const rows = [];
  runs.forEach((run, runIdx) => {
    if (run.kind !== "table") return;
    for (let k = run.dataFrom; k < run.block.length; k++) {
      const cells = run.block[k].split("|").map((c) => c.trim()).filter((c) => c !== "");
      const term = cells[0] || "";
      // A line with nothing in its first column is not an entry (a stray "|" survives in real
      // glossaries). Counting it would put a phantom in the row count the note prints and give a junk
      // line one of the window's slots.
      if (!term) continue;
      rows.push({
        runIdx,
        lineIdx: k,
        term,
        occurs: src ? rowTermOccursIn(term, src, srcSkeleton) : null,
      });
    }
  });
  return rows;
}

/**
 * Which rows survive the window.
 *
 * Relevance first, document order within each group, capped at `GLOSSARY_TRUNCATION_MAX_ENTRIES`. The
 * cap bounds how many rows are shown WITH their Notes; it does not hide anything, because
 * {@link truncateGlossary} appends the complete name-and-rendering index of the file underneath, so a
 * row the cap cut is still named. Without a source text the old behavior is kept (the newest window,
 * and the note says so).
 *
 * @param {Array<{runIdx: number, lineIdx: number, occurs: boolean|null}>} rows
 * @param {string} src - The trimmed source text, or "".
 * @returns {Set<string>} The `runIdx:lineIdx` keys of the rows to keep.
 */
function chooseRowsToKeep(rows, src) {
  const key = (r) => `${r.runIdx}:${r.lineIdx}`;
  const hasSource = Boolean(src);
  if (!hasSource) {
    return new Set([...rows].reverse().slice(0, GLOSSARY_TRUNCATION_MAX_ENTRIES).map(key));
  }
  const ordered = [...rows].sort((a, b) => {
    const d = (a.occurs === true ? 0 : 1) - (b.occurs === true ? 0 : 1);
    if (d !== 0) return d;
    if (a.runIdx !== b.runIdx) return a.runIdx - b.runIdx;
    return a.lineIdx - b.lineIdx;
  });
  return new Set(ordered.slice(0, GLOSSARY_TRUNCATION_MAX_ENTRIES).map(key));
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
 * It has to say what is missing AND that nothing is missing at the level of names: without the second
 * half, an extractor seeing 200 of 445 rows reports the other 245 as brand-new terms, which is how
 * volume after volume re-rediscovered its own protagonists. It also has to count the rows the text
 * actually mentions, because that is the half the window puts first — a note that counts only what it
 * kept cannot be checked against anything.
 *
 * @param {{total: number, kept: number, relevantTotal: number, relevantShown: number, dropped: number, droppedSections: number, hasSource: boolean}} stats
 * @returns {string} The note.
 */
function truncationNote({ total, kept, relevantTotal, relevantShown, dropped, droppedSections, hasSource }) {
  const omitted = `${dropped} row(s)${droppedSections ? ` and ${droppedSections} fully omitted section(s)` : ""}`;
  if (!hasSource) {
    return `[TRUNCATED: this glossary has ${total} term rows. Showing the ${kept} in document order; ` +
      `${omitted} are omitted. ` +
      `Earlier entries are carried forward unchanged in the file itself — reconcile NEW terms against ` +
      `the complete term list at the end of this excerpt.]`;
  }
  return `[TRUNCATED: this glossary has ${total} term rows, and ${kept} of them are shown here as full ` +
    `rows. ${relevantTotal} row(s) name a term that occurs in the text being translated — matched under ` +
    `any spelling the row names, including the furiganed spelling the text itself prints — and the ` +
    `${relevantShown} most relevant of them are among the rows shown, with ${Math.max(0, kept - relevantShown)} ` +
    `background rows in document order. ${omitted} are not shown as rows, but every term they hold IS ` +
    `named in the complete list at the end of this excerpt. A term named there is NOT new: check that ` +
    `list before calling anything new.]`;
}


module.exports = {
  parseTerms,
  truncateGlossary,
};

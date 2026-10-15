/**
 * glossary/extract/window-rows.js — the one job: read a glossary file as runs of table rows, and decide
 * which of those rows the text in front of the extractor actually mentions.
 *
 * The relevance rule is the whole point of this file: a row is worth showing the extractor when the volume
 * in front of it contains the term, whatever position the row holds in the glossary and whatever spelling
 * either side uses (gotcha 41, gotcha 82). The spellings are read through `glossary/carry-forward/table.js`
 * rather than re-spelled here, because two definitions of "what a row names" is how the extractor and the
 * cumulative gate end up disagreeing about the same row (gotcha 68).
 *
 * Everything here is pure: no file reads, no model call.
 */

require("dotenv").config();
require("../../types"); // JSDoc type definitions

const { GLOSSARY_TRUNCATION_MAX_ENTRIES } = require("../config");
const {
  glossaryTermSpans,
  glossaryTermSkeleton,
  GLOSSARY_SKELETON_MIN_CHARS,
} = require("../carry-forward/table");

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

module.exports = {
  splitIntoRuns,
  rowTermOccursIn,
  collectDataRows,
  chooseRowsToKeep,
  renderKeptRuns,
};

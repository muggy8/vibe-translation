/**
 * glossary/carry-forward/diff.js — what the newer glossary lost, and what it merely changed.
 *
 * The glossary is cumulative: volume N's file must hold every term volume N-1's held, plus this
 * volume's additions. Nothing else in the pipeline can see a loss — the validator reads the
 * current glossary and this volume's source, so a term that belonged to volume 2 is invisible to
 * it (the validator's own prompt says so: "you do not have the earlier volumes' sources").
 * Observed live on the 17-volume series: volume 06's glossary carried 411 of the 769 terms
 * volume 05 had, and every later volume would have been translated against a terminology law
 * missing 59% of its entries.
 *
 * An entry counts as carried when every spelling its term column named is still present in some
 * current row (see glossaryTermSpans) — the same entry may now be one widened row or several
 * separate rows, and both are legitimate edits. The gate is deliberately about SPELLINGS, not cell
 * text: what must survive is the terminology, not the formatting of the row that held it.
 *
 * A third legitimate form exists, and the gate used to mistake it for a loss: the entry is still
 * in the file, but its term column now names a DIFFERENT source-language spelling of the same
 * thing. That is what the amend prompt tells the agent to do when a new term is an existing term
 * under another spelling ("reconcile them to a single canonical form and note the change"). It
 * counts as carried — reported separately as `renamed` — when the row still documents the old
 * spelling (the Notes column is where "also written …" belongs) or the row carries the same
 * target-language rendering and that rendering is unique on both sides. Observed live on volume
 * 15: the extraction pass re-proposed 双ふた花ばの恋物語 under the fully furiganed spelling the
 * chapter actually prints, the amend pass reconciled the two spellings into one row exactly as
 * instructed, and the gate read the rewritten term column as a deletion — quarantining a glossary
 * that had GROWN from 445 terms to 460 and aborting a 12-hour run.
 *
 * The comparison is five named questions rather than one long function: index both sides, ask
 * whether an old spelling survived, ask whether a new row is really this volume's work, index the
 * renderings, and ask whether a row that moved is a rename or a deletion.
 *
 * Pure and deterministic — no model call, so it can run after every amend pass for the price of
 * two file reads.
 */

const {
  glossaryTermSpans,
  glossaryRowText,
  normalizeGlossaryRendering,
  parseGlossaryTableTerms,
  CARRY_FORWARD_MIN_ALIAS_SPAN_CHARS,
} = require("./table");

/**
 * One side of the comparison, indexed once so every later question is a lookup.
 *
 * @param {Array<{term: string, rendering: string, notes: string, section: string}>} entries - The rows, in file order.
 * @returns {{entries: Array<{term: string, rendering: string, notes: string, section: string}>, cells: string[], exact: Set<string>, spans: Set<string>, cellSpans: string[][], haystack: string}}
 *   `cells` keeps duplicates (the haystack is the file as written), `exact` and `spans` do not,
 *   and `cellSpans` is each distinct cell's spellings — the shape the widened/split tests walk.
 */
function indexGlossarySide(entries) {
  const cells = entries.map((e) => e.term);
  const exact = new Set(cells);
  const spans = new Set();
  for (const cell of exact) {
    for (const span of glossaryTermSpans(cell)) spans.add(span);
  }
  return {
    entries,
    cells,
    exact,
    spans,
    cellSpans: [...exact].map((cell) => glossaryTermSpans(cell)),
    // One haystack for the substring half of the test: a widened row keeps the old
    // spelling inside a longer cell, and a split row keeps it inside a shorter one.
    haystack: `\n${cells.join("\n")}\n`,
  };
}

/**
 * Did every spelling this old row named survive into the new file's term columns?
 *
 * @param {string} cell - One previous row's term column.
 * @param {ReturnType<typeof indexGlossarySide>} current - The new side, indexed.
 * @returns {boolean}
 */
function isCarried(cell, current) {
  if (current.exact.has(cell)) return true;
  return glossaryTermSpans(cell).every(
    (span) => current.spans.has(span) || current.haystack.includes(span)
  );
}

/**
 * Is this NEW row doing the job of a row the previous glossary already had?
 *
 * The other direction, which the rename test needs as much as the `added` list does: a row whose
 * every spelling the previous glossary already named is doing its job as a carried-forward row,
 * so it is NOT this volume's new work.
 *
 * @param {string} cell - One current row's term column.
 * @param {ReturnType<typeof indexGlossarySide>} previous - The old side, indexed.
 * @returns {boolean}
 */
function isCarriedForm(cell, previous) {
  if (previous.exact.has(cell)) return true;
  const spans = glossaryTermSpans(cell);
  if (spans.length === 0) return false;
  const spanSet = new Set(spans);
  // This row is the widened form of some previous entry.
  if (previous.cellSpans.some((old) => old.length > 0 && old.every((s) => spanSet.has(s)))) return true;
  // …or every spelling in it was already named somewhere (a split row).
  return spans.every((s) => previous.spans.has(s));
}

/**
 * The renderings of both sides, keyed for the rename test.
 *
 * A rendering shared by several rows proves nothing, so both sides must be unique before it
 * counts as evidence.
 *
 * @param {ReturnType<typeof indexGlossarySide>} previous
 * @param {ReturnType<typeof indexGlossarySide>} current
 * @returns {{previousCount: Map<string, number>, rowsByRendering: Map<string, Array<{term: string, rendering: string, notes: string, section: string}>>}}
 */
function indexRenderings(previous, current) {
  const previousCount = new Map();
  for (const e of previous.entries) {
    const key = normalizeGlossaryRendering(e.rendering);
    if (!key) continue;
    previousCount.set(key, (previousCount.get(key) || 0) + 1);
  }
  const rowsByRendering = new Map();
  for (const e of current.entries) {
    const key = normalizeGlossaryRendering(e.rendering);
    if (!key) continue;
    if (!rowsByRendering.has(key)) rowsByRendering.set(key, []);
    rowsByRendering.get(key).push(e);
  }
  return { previousCount, rowsByRendering };
}

/**
 * The entry is gone from the term columns. Is it still IN the file?
 *
 * @param {{term: string, rendering: string}} entry - One previous row.
 * @param {{previous: ReturnType<typeof indexGlossarySide>, current: ReturnType<typeof indexGlossarySide>, renderings: ReturnType<typeof indexRenderings>}} ctx
 * @returns {?{term: string}} The current row it moved into, or null when the entry is genuinely gone.
 */
function findRename(entry, ctx) {
  const { previous, current, renderings } = ctx;
  const spans = glossaryTermSpans(entry.term).filter(
    (span) => span.length >= CARRY_FORWARD_MIN_ALIAS_SPAN_CHARS
  );
  if (spans.length === 0) return null;

  // (a) A row this volume produced records every old spelling somewhere in the
  //     row — the Notes column's "also written …". Restricting the search to
  //     rows that are NOT already carrying a previous term is what keeps an
  //     incidental mention from hiding a real deletion: a row doing its job as
  //     a carried-forward entry is not the row this entry moved into.
  const recorded = current.entries.filter(
    (e) => !isCarriedForm(e.term, previous) && spans.every((span) => glossaryRowText(e).includes(span))
  );
  if (recorded.length === 1) return recorded[0];
  if (recorded.length > 1) {
    // Several rows mention it: the one carrying the same rendering is the entry.
    const key = normalizeGlossaryRendering(entry.rendering);
    const sameRendering = recorded.filter((e) => normalizeGlossaryRendering(e.rendering) === key);
    return sameRendering[0] || recorded[0];
  }

  // (b) A row carries the SAME rendering, and that rendering is unique on both
  //     sides — the only thing that changed is the source-language spelling.
  //     An entry deleted outright has no row left for this to match.
  const key = normalizeGlossaryRendering(entry.rendering);
  if (!key) return null;
  if ((renderings.previousCount.get(key) || 0) !== 1) return null;
  const rows = renderings.rowsByRendering.get(key) || [];
  if (rows.length !== 1) return null;
  if (isCarriedForm(rows[0].term, previous)) return null; // that row is carrying something else
  return rows[0];
}

/**
 * Compare two glossary snapshots and report what the newer one LOST.
 *
 * @param {string} previousMarkdown - The previous volume's glossary content.
 * @param {string} currentMarkdown - The glossary just produced for this volume.
 * @returns {{previousCount: number, currentCount: number, missing: Array<{term: string, rendering: string, section: string}>, added: string[], restructured: number, renamed: Array<{term: string, now: string, rendering: string, section: string}>}}
 *   `missing` is every term the previous glossary held that the new one does
 *   not (in previous-file order, with the section it came from); `added` is
 *   this volume's new rows; `restructured` counts the carried entries whose term
 *   column was widened or split; `renamed` counts the carried entries whose term
 *   column was replaced by another spelling of the same thing (`now` is the row
 *   it lives in now). Neither `restructured` nor `renamed` is a loss.
 */
function compareGlossaryCarryForward(previousMarkdown, currentMarkdown) {
  const ctx = {
    previous: indexGlossarySide(parseGlossaryTableTerms(previousMarkdown)),
    current: indexGlossarySide(parseGlossaryTableTerms(currentMarkdown)),
  };
  ctx.renderings = indexRenderings(ctx.previous, ctx.current);

  const seen = new Set();
  const missing = [];
  const renamed = [];
  const renamedCells = new Set();
  let restructured = 0;
  for (const entry of ctx.previous.entries) {
    if (seen.has(entry.term)) continue;
    seen.add(entry.term);
    if (ctx.current.exact.has(entry.term)) continue;
    if (isCarried(entry.term, ctx.current)) {
      restructured++;
      continue;
    }
    const row = findRename(entry, ctx);
    if (row) {
      renamed.push({
        term: entry.term,
        now: row.term,
        rendering: entry.rendering,
        section: entry.section,
      });
      renamedCells.add(row.term);
      continue;
    }
    missing.push(entry);
  }

  // The other direction: the rows that are NOT a carried-forward entry in any of
  // the legitimate forms — unchanged, widened into one longer row, split into
  // several, or renamed to another spelling of the same thing. Those are this
  // volume's new work. Counting a carried row as both carried and added would
  // make the two numbers mean different things depending on how the agent
  // happened to format the row.
  const added = ctx.current.entries
    .filter((e) => !isCarriedForm(e.term, ctx.previous) && !renamedCells.has(e.term))
    .map((e) => e.term);

  return {
    previousCount: ctx.previous.exact.size,
    currentCount: ctx.current.exact.size,
    missing,
    added,
    restructured,
    renamed,
  };
}

module.exports = {
  indexGlossarySide,
  isCarried,
  isCarriedForm,
  indexRenderings,
  findRename,
  compareGlossaryCarryForward,
};

/**
 * glossary/carry-forward/table.js — the glossary read as a table, not as prose.
 *
 * The rows, the spellings a term column names, the whole text of a row, the rendering worth
 * comparing, and the compact index an amend agent is handed instead of being told to page
 * through a 473 KB file it cannot read whole.
 * 
 * Everything here is pure: no file reads, no model call.
 */

/**
 * Parse the source-language terms out of a glossary Markdown file.
 *
 * Walks the table rows and keeps the FIRST column, tracking the `## `
 * section each row belongs to. For each maximal run of consecutive table
 * rows, the first row (header) and the second row (separator, e.g.
 * `|---|---|---|`) are skipped. Emphasis-wrapped cells are normalized.
 *
 * @param {string} markdown - The glossary file content.
 * @returns {Array<{term: string, rendering: string, section: string}>} One entry
 *   per term row, in file order. `rendering` is the target-language column
 *   (empty when the row has none).
 */
function parseGlossaryTableTerms(markdown) {
  if (!markdown || typeof markdown !== "string") return [];
  const entries = [];
  let section = "";
  let tableRows = [];
  const flushTable = () => {
    // Row 0 = header, row 1 = separator — data starts at row 2.
    for (let ri = 2; ri < tableRows.length; ri++) {
      const cells = tableRows[ri]
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c !== "");
      if (cells.length === 0) continue;
      let term = cells[0].trim();
      term = term.replace(/^`+|`+$/g, "").trim();
      term = term.replace(/^\*+|\*+$/g, "").trim();
      term = term.replace(/^_+|_+$/g, "").trim();
      if (!term) continue;
      if (/^:?-{3,}:?$/.test(term)) continue; // stray separator
      if (/^\[.*\]$/.test(term)) continue; // unrendered template placeholder
      // The rendering (column 1) rides along: the compact term index built from
      // these entries lets the amend pass see what an existing term is ALREADY
      // called, which is what a conflict check needs.
      const rendering = (cells[1] || "")
        .replace(/^`+|`+$/g, "")
        .replace(/^\*+|\*+$/g, "")
        .replace(/^_+|_+$/g, "")
        .trim();
      // The Notes column rides along (everything past the rendering). The
      // carry-forward gate needs it to tell a RENAMED entry from a deleted one:
      // "also written <the old spelling>" recorded in the Notes is the evidence
      // that the entry survived having its term column rewritten.
      const notes = cells.slice(2).join(" | ").trim();
      entries.push({ term, rendering, notes, section });
    }
    tableRows = [];
  };
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flushTable();
      section = heading[1].replace(/\*/g, "").trim();
      continue;
    }
    if (line.startsWith("|")) {
      tableRows.push(line);
      continue;
    }
    flushTable();
  }
  flushTable();
  return entries;
}


/**
 * The separate spellings named inside ONE glossary row's term column.
 *
 * A row's first column is often several source-language spellings of one entry
 * written as a slash-separated list: `三つ編み魔王 / 三つ編み悪魔 / 呪われし姫君`.
 * The carry-forward gate has to compare entries at THAT resolution, because an
 * agent that widens an existing row with a new alias changes the cell without
 * losing the entry. Observed live: volume 02's glossary was quarantined for
 * "dropping" two terms that were both still in the file, each one widened —
 * `三つ編み魔王 / 三つ編み悪魔 / 呪われし姫君` became
 * `三つ編み魔王 / 三つ編み悪魔 / 魔王 / 呪われし姫君`, and
 * `鈍感系巻き込まれ型主人公` became
 * `鈍感系巻き込まれ型主人公 / 鈍感純情ＢＯＹ / やれやれ巻き込まれＢＯＹ`. The guard
 * compared whole cells as exact strings, called an improvement a loss, and threw
 * away a glossary that had grown from 88 terms to 140.
 *
 * @param {string} term - One row's term column.
 * @returns {string[]} The trimmed spellings it names (empty for an empty cell).
 */
function glossaryTermSpans(term) {
  if (!term || typeof term !== "string") return [];
  return term
    .split("/")
    .map((span) =>
      span
        .replace(/^`+|`+$/g, "")
        .replace(/^\*+|\*+$/g, "")
        .replace(/^_+|_+$/g, "")
        .trim()
    )
    .filter((span) => span.length > 0);
}


/**
 * The whole text of one glossary row — every column — for the "is this entry
 * still documented here?" test.
 *
 * The carry-forward gate used to read only the term column, which is what made
 * a legitimate rename look like a deletion (see compareGlossaryCarryForward).
 *
 * @param {{term: string, rendering: string, notes: string}} entry - One parsed row.
 * @returns {string} The row's columns joined by " | ".
 */
function glossaryRowText(entry) {
  return [entry.term, entry.rendering, entry.notes].filter(Boolean).join(" | ");
}


/**
 * A rendering compared without Markdown emphasis or spacing, so `*The Twin
 * Flowers' Love Story*` and `The Twin Flowers' Love Story` are the same name.
 *
 * @param {string} rendering - One row's target-language column.
 * @returns {string} The comparison key ("" for an empty rendering).
 */
function normalizeGlossaryRendering(rendering) {
  return String(rendering || "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// A one-character term is too ambiguous to prove anything by substring matching
// ("A" occurs in half the Notes cells of a real glossary), so the rename test
// only trusts a spelling long enough to be a term.
const CARRY_FORWARD_MIN_ALIAS_SPAN_CHARS = 2;


/**
 * Compare two glossary snapshots and report what the newer one LOST.
 *
 * The glossary is cumulative: volume N's file must hold every term volume
 * N-1's held, plus this volume's additions. Nothing else in the pipeline can
 * see a loss — the validator reads the current glossary and this volume's
 * source, so a term that belonged to volume 2 is invisible to it (the
 * validator's own prompt says so: "you do not have the earlier volumes'
 * sources"). Observed live on the 17-volume series: volume 06's glossary
 * carried 411 of the 769 terms volume 05 had, and every later volume would
 * have been translated against a terminology law missing 59% of its entries.
 *
 * An entry counts as carried when every spelling its term column named is still
 * present in some current row (see glossaryTermSpans) — the same entry may now
 * be one widened row or several separate rows, and both are legitimate edits.
 * The gate is deliberately about SPELLINGS, not cell text: what must survive is
 * the terminology, not the formatting of the row that held it.
 *
 * A third legitimate form exists, and the gate used to mistake it for a loss:
 * the entry is still in the file, but its term column now names a DIFFERENT
 * source-language spelling of the same thing. That is what the amend prompt
 * tells the agent to do when a new term is an existing term under another
 * spelling ("reconcile them to a single canonical form and note the change").
 * It counts as carried — reported separately as `renamed` — when the row still
 * documents the old spelling (the Notes column is where "also written …"
 * belongs) or the row carries the same target-language rendering and that
 * rendering is unique on both sides. Observed live on volume 15: the extraction
 * pass re-proposed 双ふた花ばの恋物語 under the fully furiganed spelling the
 * chapter actually prints, the amend pass reconciled the two spellings into one
 * row exactly as instructed, and the gate read the rewritten term column as a
 * deletion — quarantining a glossary that had GROWN from 445 terms to 460 and
 * aborting a 12-hour run.
 *
 * Pure and deterministic — no model call, so it can run after every amend pass
 * for the price of two file reads.
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
  const previous = parseGlossaryTableTerms(previousMarkdown);
  const current = parseGlossaryTableTerms(currentMarkdown);

  const currentCells = current.map((e) => e.term);
  const currentExact = new Set(currentCells);
  const currentSpans = new Set();
  for (const cell of currentCells) {
    for (const span of glossaryTermSpans(cell)) currentSpans.add(span);
  }
  // One haystack for the substring half of the test: a widened row keeps the old
  // spelling inside a longer cell, and a split row keeps it inside a shorter one.
  const currentHaystack = `\n${currentCells.join("\n")}\n`;

  const previousCells = new Set(previous.map((e) => e.term));
  const previousSpans = new Set();
  for (const cell of previousCells) {
    for (const span of glossaryTermSpans(cell)) previousSpans.add(span);
  }

  // Carried when every spelling the old row named still appears somewhere in the
  // new file's term columns — as its own row, or inside a longer one.
  const isCarried = (cell) =>
    currentExact.has(cell) ||
    glossaryTermSpans(cell).every((span) => currentSpans.has(span) || currentHaystack.includes(span));

  // The other direction, which the rename test needs as much as the `added` list
  // does: a row whose every spelling the previous glossary already named is doing
  // its job as a carried-forward row, so it is NOT this volume's new work.
  const previousCellSpans = [...previousCells].map((cell) => glossaryTermSpans(cell));
  const isCarriedForm = (cell) => {
    if (previousCells.has(cell)) return true;
    const spans = glossaryTermSpans(cell);
    if (spans.length === 0) return false;
    const spanSet = new Set(spans);
    // This row is the widened form of some previous entry.
    if (previousCellSpans.some((old) => old.length > 0 && old.every((s) => spanSet.has(s)))) return true;
    // …or every spelling in it was already named somewhere (a split row).
    return spans.every((s) => previousSpans.has(s));
  };

  // Renderings keyed for the rename test. A rendering shared by several rows
  // proves nothing, so both sides must be unique before it counts as evidence.
  const previousRenderingCount = new Map();
  for (const e of previous) {
    const key = normalizeGlossaryRendering(e.rendering);
    if (!key) continue;
    previousRenderingCount.set(key, (previousRenderingCount.get(key) || 0) + 1);
  }
  const currentRowsByRendering = new Map();
  for (const e of current) {
    const key = normalizeGlossaryRendering(e.rendering);
    if (!key) continue;
    if (!currentRowsByRendering.has(key)) currentRowsByRendering.set(key, []);
    currentRowsByRendering.get(key).push(e);
  }

  /**
   * The entry is gone from the term columns. Is it still IN the file?
   *
   * @param {{term: string, rendering: string}} entry - One previous row.
   * @returns {?{term: string}} The current row it moved into, or null when the
   *   entry is genuinely gone.
   */
  const findRename = (entry) => {
    const spans = glossaryTermSpans(entry.term).filter(
      (span) => span.length >= CARRY_FORWARD_MIN_ALIAS_SPAN_CHARS
    );
    if (spans.length === 0) return null;

    // (a) A row this volume produced records every old spelling somewhere in the
    //     row — the Notes column's "also written …". Restricting the search to
    //     rows that are NOT already carrying a previous term is what keeps an
    //     incidental mention from hiding a real deletion: a row doing its job as
    //     a carried-forward entry is not the row this entry moved into.
    const recorded = current.filter(
      (e) => !isCarriedForm(e.term) && spans.every((span) => glossaryRowText(e).includes(span))
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
    if ((previousRenderingCount.get(key) || 0) !== 1) return null;
    const rows = currentRowsByRendering.get(key) || [];
    if (rows.length !== 1) return null;
    if (isCarriedForm(rows[0].term)) return null; // that row is carrying something else
    return rows[0];
  };

  const seen = new Set();
  const missing = [];
  const renamed = [];
  const renamedCells = new Set();
  let restructured = 0;
  for (const entry of previous) {
    if (seen.has(entry.term)) continue;
    seen.add(entry.term);
    if (currentExact.has(entry.term)) continue;
    if (isCarried(entry.term)) {
      restructured++;
      continue;
    }
    const row = findRename(entry);
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
  const added = current.filter((e) => !isCarriedForm(e.term) && !renamedCells.has(e.term)).map((e) => e.term);

  return {
    previousCount: previousCells.size,
    currentCount: currentExact.size,
    missing,
    added,
    restructured,
    renamed,
  };
}

/**
 * A compact map of the glossary an agent is about to amend: each section, and
 * under it every source-language term with the rendering it already has.
 *
 * Why the agent needs it: the cumulative glossary is far too big to read whole
 * (volume 05's is 473 KB, and a `readFile` answer is capped at
 * `AGENT_MAX_READ_BYTES` = 64 KB), yet the amend pass must know which section a
 * term belongs in and whether the term is ALREADY there under a different
 * spelling. Without a map the agent finds that out by paging — 8–17 `readFile`
 * calls on the live run, each re-billing the whole transcript so far, and the
 * step budget gone before the first row was inserted.
 *
 * The index is the whole document at the resolution a decision needs: term and
 * rendering, no Notes. Deterministic, and small enough to inline.
 *
 * It is capped (`GLOSSARY_INDEX_MAX_CHARS`, default 30000) and says so when it
 * truncates — a prompt that silently truncates is a prompt that silently
 * ignores part of the rules (gotcha 43).
 *
 * @param {string} markdown - The glossary the agent will amend.
 * @returns {string} The index, or "" when the glossary has no term rows.
 */
function buildGlossaryIndex(markdown) {
  const entries = parseGlossaryTableTerms(markdown);
  if (entries.length === 0) return "";

  const bySection = new Map();
  for (const entry of entries) {
    const key = entry.section || "(no section heading)";
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(entry);
  }

  const cap = Number.parseInt(process.env.GLOSSARY_INDEX_MAX_CHARS || "30000", 10);
  const lines = [];
  let shown = 0;
  let used = 0;
  for (const [section, items] of bySection) {
    const head = `\n### ${section} (${items.length})\n`;
    const body = items
      .map((e) => (e.rendering ? `${e.term} → ${e.rendering}` : e.term))
      .join(", ");
    if (Number.isFinite(cap) && cap > 0 && used + head.length + body.length > cap) {
      const remaining = entries.length - shown;
      lines.push(
        head +
          `(${remaining} term(s) of this and later sections are not listed here — ` +
          `the index is capped at ${cap} chars. Search "glossary.md" with grep ` +
          `before assuming a term is absent.)`
      );
      used += head.length;
      break;
    }
    lines.push(head + body);
    used += head.length + body.length;
    shown += items.length;
  }
  return lines.join("\n").trim();
}

module.exports = {
  parseGlossaryTableTerms,
  glossaryTermSpans,
  glossaryRowText,
  normalizeGlossaryRendering,
  CARRY_FORWARD_MIN_ALIAS_SPAN_CHARS,
  buildGlossaryIndex,
};

/**
 * glossary/extract/window.js — the one job: the window of the previous glossary a read pass is shown, and
 * the note the truncated copy announces itself with.
 *
 * The window is RELEVANCE-ranked against the text being processed, never by document position (gotcha 41) —
 * the glossary is cumulative, so "the first N entries" shows the earliest volumes' terms and throws away
 * exactly what a later volume needs. Truncating here means "some existing terms may be re-proposed as new",
 * which is harmless: the amend pass reconciles duplicates to one canonical rendering. It no longer means
 * "the agent cannot see entries it must preserve", which is what it used to mean and what the 457-term loss
 * came out of.
 *
 * The row mechanics — which rows exist, which ones the text mentions, how the kept ones are re-rendered —
 * live in `glossary/extract/window-rows.js`; this file is the window itself and its announcement.
 */

require("dotenv").config();
require("../../types"); // JSDoc type definitions

const { GLOSSARY_TRUNCATION_MAX_ENTRIES, GLOSSARY_TRUNCATION_THRESHOLD } = require("../config");
// `buildGlossaryIndex` is the carry-forward layer's compact name-and-rendering view of a whole glossary,
// which is what lets the window hide Notes without hiding entries.
const { buildGlossaryIndex } = require("../carry-forward/table");

const {
  splitIntoRuns,
  collectDataRows,
  chooseRowsToKeep,
  renderKeptRuns,
} = require("./window-rows");

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

module.exports = { truncateGlossary, truncationNote };

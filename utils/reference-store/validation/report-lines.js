/**
 * utils/reference-store/validation/report-lines.js — the small formatting rules every report section shares.
 *
 * How a count prints when the caller passed no counts, how long a claim's body may be on one line, how
 * many chapter ids a coverage verdict names before it stops, and how many rows a section lists before it
 * switches to a count. The two bounds are load-bearing and pinned by tests: the report is handed to the
 * acceptance grader and the feedback stage on every volume, so its size is a cost the run pays, and every
 * section prints its own count in its own sentence, so a bound never hides the size of the problem.
 *
 * @module utils/reference-store/validation/report-lines
 */

require("../../../types"); // JSDoc type definitions

/**
 * A count from the store's table counts, or a dash when the caller passed no counts.
 * @param {Object<string, number>|null} counts
 * @param {string} table
 * @returns {string}
 */
function numberOr(counts, table) {
  if (!counts || counts[table] === undefined) return "—";
  return String(counts[table]);
}

/**
 * One line of the report per claim: a body is a sentence, and a report is not the place for a
 * paragraph the artifact already holds.
 * @param {string} body
 * @returns {string}
 */
function clip(body) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  return text.length <= 160 ? text : `${text.slice(0, 157)}…`;
}

/**
 * Which chapters a name was found in, spelled out — the part of a coverage verdict a reader can
 * check by opening the book.
 *
 * Bounded, because 俺 is in all ten of volume 01's chapters and a list of every chapter id is not
 * more useful than the count; the count is what the rule acts on and the ids are what makes it
 * checkable. Beyond the bound the list says so rather than stopping silently.
 *
 * @param {string[]} chapterIds
 * @returns {string} ` — ch1, ch4, ch6, ch7.1`, or "" when there is nothing to name.
 */
function chapterList(chapterIds) {
  const ids = Array.isArray(chapterIds) ? chapterIds.filter(Boolean) : [];
  if (ids.length === 0) return "";
  const shown = ids.slice(0, 6);
  const rest = ids.length - shown.length;
  return ` — ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
}

/**
 * How many named rows one section of the audit report lists before it switches to a count.
 *
 * The report is handed to the acceptance grader and to the feedback stage, so its size is a cost the
 * run pays on every volume. A section that names every row is worth having — a name is what makes a
 * finding actionable — but a volume whose extraction produced 60 unadopted claims does not need 60
 * lines to tell the reader the number is 60. The count is printed in the section's own sentence, so
 * the truncation never hides the size of the problem.
 */
const REPORT_LIST_LIMIT = 20;

/**
 * Turn a section's rows into report lines, naming up to the limit and then saying how many are not
 * shown.
 *
 * @param {Array<Object>} items
 * @param {(item: Object) => string} lineFor
 * @returns {string[]}
 */
function listLines(items, lineFor) {
  const lines = items.slice(0, REPORT_LIST_LIMIT).map(lineFor);
  const rest = items.length - REPORT_LIST_LIMIT;
  if (rest > 0) lines.push(`- …and ${rest} more, not listed here (${items.length} in total).`);
  return lines;
}

module.exports = {
  numberOr,
  clip,
  chapterList,
  REPORT_LIST_LIMIT,
  listLines,
};

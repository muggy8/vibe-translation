/**
 * utils/reference-store/glossary-adapter/history.js — the line a superseded rendering becomes
 * inside its term's Notes cell.
 *
 * Render-time text only, and nothing here writes or edits a row: the wording one replaced row takes
 * (`Earlier rendering: "…" (in force from volume N)`), and the idempotent merge that folds a term's
 * replaced rows into its notes cell without stacking a second copy when a published file is read
 * back into a record.
 *
 * @module utils/reference-store/glossary-adapter/history
 */

const { normalizeQuote } = require("../evidence");
require("../../../types"); // JSDoc type definitions

/**
 * The text one superseded rendering becomes inside its term's Notes cell.
 *
 * No pipes, and the volume the old rendering was in force from is part of the sentence rather than a
 * footnote: "the glossary used to say X" without "…from volume 3 to volume 10" is the kind of history a
 * reader cannot act on, and a translator who is re-reading volume 4 needs to know the older rendering was
 * the law *for their volume*.
 *
 * @param {{rendering: string, appliesFromVolume: number}} superseded - One replaced row.
 * @returns {string} e.g. `Earlier rendering: "Agassi of the madam world" (in force from volume 3)`
 */
function revisionHistoryFragment(superseded) {
  return `Earlier rendering: "${String(superseded.rendering || "").trim()}" (in force from volume ${superseded.appliesFromVolume})`;
}

/**
 * Merge a term's superseded renderings into its row's Notes cell.
 *
 * Render-time only, and idempotent — the same rule `mergeResearchNotes` runs, for the same reason: a
 * published file can be read back into a record (`ensureVolumeGlossaryInRecord`), and a renderer that
 * appended blindly would stack a second copy of the same history on the next render.
 *
 * A superseded row whose rendering is the SAME string the term is rendered with now is skipped. That
 * happens when a revision changed the note and not the rendering, and printing "Earlier rendering: the
 * same words" would be the file claiming a change it did not make.
 *
 * @param {string} body - The row's own notes cell, as the record holds it.
 * @param {Array<Object>} superseded - The term's replaced rows, oldest first.
 * @param {{rendering?: string}} [opts] - The rendering the term is printed with, for the same-string test.
 * @returns {string} The cell to print.
 */
function mergeRevisionHistory(body, superseded, { rendering } = {}) {
  const live = normalizeQuote(rendering);
  let cell = String(body || "").trim();
  for (const row of Array.isArray(superseded) ? superseded : []) {
    if (live && normalizeQuote(row.rendering) === live) continue;
    const fragment = revisionHistoryFragment(row);
    if (cell.includes(fragment)) continue;
    cell = cell ? `${cell}; ${fragment}` : fragment;
  }
  return cell;
}

module.exports = {
  revisionHistoryFragment,
  mergeRevisionHistory,
};

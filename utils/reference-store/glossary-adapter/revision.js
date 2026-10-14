/**
 * utils/reference-store/glossary-adapter/revision.js — the door a later volume uses to replace a
 * rendering an earlier volume published.
 *
 * `fileGlossaryRevision` is the only door that touches a term the record already holds, and it files
 * a NEW row that supersedes the published one: the old row is never edited and never deleted. Every
 * step refuses rather than reports-and-accepts, and the load-bearing guard is the quote — it has to
 * be a line this volume's own text prints. Both writes happen in one transaction. `importGlossaryRevisions`
 * is the batch half, and it never throws on a refusal: the refusals come back with the rule that
 * produced each one, because the stage prints them in the report the acceptance grader reads.
 *
 * @module utils/reference-store/glossary-adapter/revision
 */

const { normalizeQuote } = require("../evidence");
const { markSuperseded } = require("../facts");
const { refusal } = require("../refusals");
const { findQuoteEvidence } = require("./quote-evidence");
const { glossaryRowInForceForTerm } = require("./rows");
require("../../../types"); // JSDoc type definitions

/**
 * File one revision: this volume's replacement of a rendering an earlier volume published.
 *
 * The order is the door, and every step refuses rather than reports-and-accepts:
 *
 *   1. **The term must already be a published row of this record.** A revision is not a way to add a
 *      term: the `terms` list is that, with its own evidence rule. A revision naming a term the record
 *      has no row for is refused (`revision-of-unknown-term`).
 *   2. **The quote must be a line this volume's own text prints.** `findQuoteEvidence` searches this
 *      volume's chapter files with the store's one matching rule. This is the load-bearing guard: it is
 *      the only thing standing between "a later volume found evidence in its own book" and "a later
 *      volume changed a decision because it felt like it". A revision whose quote is not there is
 *      refused (`revision-quote-not-in-source`), not filed with a warning.
 *   3. **The replacement is a new row, and the replaced row is never edited or deleted.** The new row
 *      carries `established_volume = this volume`, `applies_from_volume = this volume` and
 *      `supersedes = the replaced row`. The replaced row's `status` becomes `superseded` through
 *      `markSuperseded`, which changes **status only** and refuses unless the replacement row it is
 *      attributed to already exists. Body, evidence, examples, key and owner of the published row are
 *      untouched, so the earlier decision survives being replaced — which is what the render's history
 *      line and the carry-forward guard both need.
 *   4. **Idempotent per volume, and per rendering this volume already filed.** Re-running the same volume
 *      over the same text — which the chapter-by-chapter route does once per chapter — files one revision,
 *      not one per chapter. The test is asked of the whole chain, not only of the row in force: a rendering
 *      this volume filed and a later chapter of the same volume replaced is still a decision this volume
 *      made, and re-filing it would flip the term back to a superseded rendering and grow the record by one
 *      row on every re-run. Measured before this was pinned: the first version compared only the in-force
 *      row, and re-running one volume over the same five proposals grew the chain from 2 rows to 3 and
 *      rewrote the term's rendering back to the one the second chapter had replaced.
 *   5. **The note is the row's own notes cell, and the row seals with its volume.** Nothing here writes
 *      into the row it replaces.
 *
 * Both writes happen in one transaction: a replacement row whose predecessor is still `active` would be
 * a term with two live renderings, and a `superseded` mark with no replacement row behind it is an
 * unattributed edit to a published row. Either half alone is a broken record.
 *
 * @param {ReferenceStore} store - Opened with a document-scoped handle, which is what a rendered row needs.
 * @param {Object} entry - One `revisions` element: `{term, rendering, note, quote, reason}`.
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, filed: Object|null, replaced: Object|null, alreadyFiled: boolean, evidence: Array<Object>|null, refusal: ReferenceRefusal|null}}
 */
function fileGlossaryRevision(store, entry, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const term = text(entry && entry.term);
  const rendering = text(entry && entry.rendering);
  const note = text(entry && entry.note);
  const quote = text(entry && entry.quote);
  const reason = text(entry && entry.reason);

  const refuse = (rule, because, fix) => ({
    ok: false,
    filed: null,
    replaced: null,
    alreadyFiled: false,
    evidence: null,
    refusal: refusal({ verb: "file_glossary_revision", rule, because, fix }),
  });

  if (!term) return refuse("revision-has-no-term", "a revision arrived with no term, so there is no row it replaces.", "name the term exactly as the previous glossary spells it.");
  if (!rendering) {
    return refuse(
      "revision-has-no-rendering",
      `"${term}": a revision with no rendering is a complaint, not a replacement. The published file's middle column is the decision a translator uses, and this read pass is the only place on this route that can supply one.`,
      "the `revisions` element owes a `rendering`."
    );
  }

  // 1 — the term must already be published content of this record.
  const current = glossaryRowInForceForTerm(store, term, vol);
  if (!current) {
    return refuse(
      "revision-of-unknown-term",
      `"${term}" is not a term this record's glossary holds, so there is nothing for this revision to replace. A term this volume found belongs in \`terms\`.` +
        (normalizeQuote(term) === normalizeQuote(rendering) ? " (the term and its rendering are the same string, which is usually the sign of a term the answer invented.)" : ""),
      "file it as a new term, or spell it the way the previous glossary spells it."
    );
  }

  // 4 — asked before the quote search, so a volume that already settled this term does not pay for the
  // search again per chapter. The whole chain is asked, not only the row in force: a rendering this volume
  // filed and a later chapter of the same volume replaced is still a decision this volume made, and
  // re-filing it would flip the term back and grow the chain on every re-run.
  const settled = [current, ...(Array.isArray(current.superseded) ? current.superseded : [])].find(
    (row) => Number(row.ownerVolume) === vol && normalizeQuote(row.rendering) === normalizeQuote(rendering)
  );
  if (settled) {
    return { ok: true, filed: settled, replaced: null, alreadyFiled: true, evidence: null, refusal: null };
  }

  // 2 — the quote has to be in THIS volume's book.
  const listed = store.listChapters();
  const found = findQuoteEvidence(store.volumeDir, listed.chapters, vol, quote);
  if (!found.evidence) {
    return refuse(
      "revision-quote-not-in-source",
      `"${term}": the revision quotes ${quote ? `"${quote}"` : "nothing"}, and no line of volume ${vol}'s source text contains it. ` +
        "A later volume may replace an earlier volume's rendering when its own book shows the earlier one is wrong; it may not replace one on the " +
        "strength of the previous glossary's own row.",
      "quote the line you actually read in this volume, character for character."
    );
  }

  // 3 — file the replacement, then mark the replaced row superseded. One transaction, because either
  // half alone is a record with a term in two states at once.
  let inserted = null;
  store.db.exec("BEGIN");
  try {
    inserted = store.insertFact({
      key: null,
      aspect: "term_usage",
      label: current.label,
      section: current.section,
      body: note || reason || rendering,
      examples: [current.term, rendering],
      evidence: found.evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
      supersedes: current.id,
    });
    if (!inserted.ok) {
      store.db.exec("ROLLBACK");
      return refuse(
        inserted.refusal ? inserted.refusal.rule : "insert refused",
        inserted.refusal ? inserted.refusal.because : `the replacement row for "${term}" could not be filed.`,
        "the record's own insert contract is the fix."
      );
    }
    const marked = markSuperseded(store, current.id, { byVolume: vol, byStage: store.scope.stage });
    if (!marked.ok) {
      store.db.exec("ROLLBACK");
      return refuse(
        marked.refusal.rule,
        marked.refusal.because,
        marked.refusal.fix
      );
    }
    store.db.exec("COMMIT");
  } catch (err) {
    store.db.exec("ROLLBACK");
    throw err;
  }

  return {
    ok: true,
    filed: inserted.fact,
    replaced: { id: current.id, term: current.term, rendering: current.rendering, appliesFromVolume: current.appliesFromVolume },
    alreadyFiled: false,
    evidence: found.evidence,
    refusal: null,
  };
}

/**
 * File this volume's revisions into its record, and report every one — filed and refused.
 *
 * The batch half of {@link fileGlossaryRevision}, and the door the glossary stage calls. It never
 * throws on a refusal: a read pass that proposed three revisions and got one refused has still made
 * two correct decisions, and a door that threw would throw all three away and leave the volume with
 * none. What it does instead is hand back the refusals with the rule that produced each one, because
 * `glossary/store.js` prints them in the report the acceptance grader reads.
 *
 * @param {ReferenceStore} store - Opened with a document-scoped handle.
 * @param {Array<Object>} entries - The answer's `revisions` array.
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, filed: Array<Object>, replaced: Array<Object>, alreadyFiled: Array<string>, refused: Array<{term: string, rendering: string, quote: string, reason: string, rule: string, because: string}>}}
 */
function importGlossaryRevisions(store, entries, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const filed = [];
  const replaced = [];
  const alreadyFiled = [];
  const refused = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const result = fileGlossaryRevision(store, entry, { volume: vol });
    if (result.ok) {
      if (result.alreadyFiled) {
        alreadyFiled.push(String((entry && entry.term) || "").trim());
        continue;
      }
      filed.push(result.filed);
      replaced.push(result.replaced);
      continue;
    }
    refused.push({
      term: String((entry && entry.term) || "").trim(),
      rendering: String((entry && entry.rendering) || "").trim(),
      quote: String((entry && entry.quote) || "").trim(),
      reason: String((entry && entry.reason) || "").trim(),
      rule: result.refusal.rule,
      because: result.refusal.because,
    });
  }

  return { ok: refused.length === 0, filed, replaced, alreadyFiled, refused };
}

module.exports = {
  fileGlossaryRevision,
  importGlossaryRevisions,
};

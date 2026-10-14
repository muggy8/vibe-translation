/**
 * utils/reference-store/glossary-adapter/rows.js — asking the record which glossary rows it holds.
 *
 * The three queries the rest of this folder is built on: whether the record already holds a term as
 * a document row (which is what makes an import carry it instead of duplicating it), the published
 * rows **in force at one volume** in render order — one row per term, a `supersedes` chain collapsed
 * to the row in force, every row bounded by the volume being asked about — and the in-force row for
 * one term, matched by the same term identity every other door uses.
 *
 * `source_stage != 'extract'` is the line that makes these the **published** rows rather than the
 * extraction's candidates, and it is not widened or parameterised here.
 *
 * @module utils/reference-store/glossary-adapter/rows
 */

const { normalizeQuote } = require("../evidence");
const { EXTRACTION_SOURCE_STAGE } = require("../schema");
require("../../../types"); // JSDoc type definitions

/**
 * Whether the store already holds this term as a row of the document.
 *
 * Matched on the term the way the glossary's own carry-forward gate matches it — the term is the
 * row's identity, and a term that moved sections is still the same term.
 *
 * **What the skip is, and what it is not.** A term the record already holds is not amended by the read
 * pass: `importGlossary` and `importGlossaryExtraction` count it as carried and move on. That is still
 * true, and it is still the rule for the `terms` list. What it does NOT mean is that a term already in
 * the record can never be touched again — it means the only door that touches it is
 * {@link fileGlossaryRevision}, which files a **replacement row** rather than editing the one it
 * replaces, and refuses unless the replacement is justified by a line this volume's own text prints.
 * A blanket skip on one side and a guarded replacement door on the other is the same rule read twice:
 * a published row is never edited.
 *
 * @param {ReferenceStore} store
 * @param {string} term
 * @returns {boolean}
 */
function documentTermAlreadyStored(store, term) {
  const needle = normalizeQuote(term);
  if (!needle) return false;
  const rows = store.db
    .prepare("SELECT examples FROM facts WHERE aspect = 'term_usage' AND source_stage != ?")
    .all(EXTRACTION_SOURCE_STAGE);
  for (const row of rows) {
    try {
      const spans = JSON.parse(row.examples || "[]");
      if (Array.isArray(spans) && normalizeQuote(String(spans[0] || "")) === needle) return true;
    } catch {
      /* an unparsable examples column is not a match */
    }
  }
  return false;
}

/**
 * The glossary rows this record holds **in force at one volume**, in the order the render prints them.
 *
 * One query, one order, shared by everything that has to ask "what does this volume's glossary contain":
 * `renderGlossary` prints these rows, `glossary/researchable.js` classifies them to decide what to look
 * up, and the research door checks that a note has a row to attach to. Reading the table somewhere else
 * and getting the order slightly wrong is how a renderer and a bound disagree about what the glossary is.
 *
 * `source_stage != 'extract'` is the line that makes this the **published** rows rather than the
 * extraction's candidates (schema.js's `EXTRACTION_SOURCE_STAGE`).
 *
 * ## One row per term, and the row that is in force
 *
 * A term can now have more than one published row: a later volume files a replacement rather than
 * editing the row an earlier volume published (a sealed row is never edited), and the replacement
 * `supersedes` the row it replaces. Printing both would print the argument instead of its outcome, and
 * it would hand the translation stage two renderings for one term. So a chain of rows linked by
 * `supersedes` collapses to **one row** — the one in force — with the replaced rows carried beside it as
 * `superseded`, which is what the render turns into the Notes cell's history line.
 *
 * ## "In force at volume V" is bounded by V, and that is not the same as "the newest row"
 *
 * The in-force row is the one with the greatest `applies_from_volume` that is **still ≤ V**, not simply
 * the greatest. The difference is what makes a re-run reproduce the past: a record that has reached
 * volume 8 and is asked to render volume 3's glossary must print what volume 3 printed, not volume 8's
 * correction of it. Taking the newest row would silently rewrite volume 3's published decision with a
 * decision volume 3 never made, and the file would no longer be the answer to "what guidance did this
 * volume actually get?" — which is the question a per-volume record exists to answer (doc 03 §2.2).
 *
 * Rows whose replacement has not happened yet at V are simply not shown at V; they are still in the
 * record, and they become the in-force row at the volume that filed them. **The same bound applies to a
 * term's first row**: a term volume 5 introduced is not a term volume 3's glossary contained, so it is not
 * printed at 3 either. Measured before this was pinned — the first version bounded only the chains, and
 * rendering volume 1 from a record that had reached volume 2 printed volume 2's brand-new term, which is
 * the same silent rewrite of the past this bound exists to prevent, arriving through the door written to
 * stop it.
 *
 * A chain is only collapsed when its rows are actually linked by `supersedes`. Two rows that happen to
 * name the same term and are linked to nothing are two rows, exactly as they were before this rule
 * existed — the render route refuses to file a second row for a term it already holds, so an unlinked
 * pair is a record somebody built by hand, and collapsing it would be this query inventing a
 * supersession nobody filed.
 *
 * @param {{db: Object, volume: number}} store - The volume's open record.
 * @param {{volume?: number}} [opts] - The volume the answer is about. Defaults to the record's own.
 * @returns {Array<{id: string, term: string, rendering: string, notes: string, section: string|null, establishedVolume: number, appliesFromVolume: number, ownerVolume: number, ord: number, superseded: Array<Object>}>}
 *   One entry per term. `ord` is where the term sits in the document — the position of its FIRST row,
 *   so a revised term stays exactly where it was first published. `superseded` is the term's earlier
 *   rows, oldest first, each carrying the volume its rendering was in force from.
 */
function publishedGlossaryRowsInRecord(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const rows = store.db
    .prepare(
      "SELECT id, section, examples, body, label, established_volume, applies_from_volume, supersedes, ord, owner_volume FROM facts " +
        "WHERE aspect = 'term_usage' AND source_stage != ? ORDER BY ord, id"
    )
    .all(EXTRACTION_SOURCE_STAGE);

  /** @type {Map<string, Object>} */
  const byId = new Map();
  for (const row of rows) {
    let term = "";
    let rendering = "";
    try {
      const examples = JSON.parse(row.examples || "[]");
      term = String(examples[0] || "");
      rendering = String(examples[1] || "");
    } catch {
      /* an unparsable examples column renders as an empty term cell, which the diff will show */
    }
    byId.set(row.id, {
      id: row.id,
      term,
      rendering,
      notes: row.body,
      label: row.label === null || row.label === undefined ? null : String(row.label),
      section: row.section === null || row.section === "" ? null : row.section,
      establishedVolume: Number(row.established_volume),
      appliesFromVolume: Number(row.applies_from_volume),
      ownerVolume: Number(row.owner_volume),
      supersedes: row.supersedes === null || row.supersedes === "" ? null : String(row.supersedes),
      ownOrd: Number(row.ord),
      ord: Number(row.ord),
      superseded: [],
    });
  }

  // Chains, keyed on the row at the bottom of each `supersedes` link — the row that replaces nothing.
  /** @type {Map<string, Object[]>} */
  const chains = new Map();
  for (const entry of byId.values()) {
    const visited = new Set([entry.id]);
    let root = entry;
    while (root.supersedes && byId.has(root.supersedes) && !visited.has(root.supersedes)) {
      visited.add(root.supersedes);
      root = byId.get(root.supersedes);
    }
    if (!chains.has(root.id)) chains.set(root.id, []);
    chains.get(root.id).push(entry);
  }

  const out = [];
  for (const chain of chains.values()) {
    const firstOrd = Math.min(...chain.map((entry) => entry.ownOrd));
    // The bound is asked of EVERY row, a term's first row included: a chain of one row that this volume
    // has not reached yet is a term that does not exist at V, and printing it would rewrite V's glossary
    // with a term V never saw.
    const inRange = chain.filter((entry) => entry.appliesFromVolume <= vol);
    if (inRange.length === 0) continue; // every row of this term's chain postdates this volume
    const ordered = [...inRange].sort(
      (a, b) => a.appliesFromVolume - b.appliesFromVolume || a.ownOrd - b.ownOrd || a.id.localeCompare(b.id)
    );
    const inForce = ordered[ordered.length - 1];
    out.push({
      ...inForce,
      ord: firstOrd,
      superseded: ordered.slice(0, -1).map((entry) => ({
        id: entry.id,
        term: entry.term,
        rendering: entry.rendering,
        appliesFromVolume: entry.appliesFromVolume,
        establishedVolume: entry.establishedVolume,
        ownerVolume: entry.ownerVolume,
      })),
    });
  }
  return out.sort((a, b) => a.ord - b.ord || a.id.localeCompare(b.id));
}

/**
 * The row this record holds for one term, at one volume — the same identity every other door uses.
 *
 * Matched the way `documentTermAlreadyStored` matches it: the first spelling in the row's `examples`,
 * whitespace-normalised. Two doors that spell "the row for this term" differently is how a revision
 * lands on the wrong row.
 *
 * @param {{db: Object, volume: number}} store - The volume's open record.
 * @param {string} term - The term, spelled the way the glossary spells it.
 * @param {number} volume - The volume the answer is about.
 * @returns {Object|null} The in-force row, or null when the record holds no row for this term.
 */
function glossaryRowInForceForTerm(store, term, volume) {
  const needle = normalizeQuote(term);
  if (!needle) return null;
  const rows = publishedGlossaryRowsInRecord(store, { volume });
  for (const row of rows) {
    if (normalizeQuote(row.term) === needle) return row;
  }
  return null;
}

module.exports = {
  documentTermAlreadyStored,
  publishedGlossaryRowsInRecord,
  glossaryRowInForceForTerm,
};

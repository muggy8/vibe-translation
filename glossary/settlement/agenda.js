/**
 * glossary/settlement/agenda.js — which terms the settlement pass is allowed to ask about, and how
 * many of them one run may pay for.
 *
 * The settlement pass is the one place the pipeline asks, AFTER the whole series has been read,
 * whether the rendering the series settled on is still the right one. The question is worth paying
 * for in exactly two situations, and both are facts the record already holds:
 *
 *   1. **The record has already changed this term's rendering once.** A term whose supersede chain
 *      has more than one row is a term somebody has already decided twice. It is the cheapest
 *      possible signal, and it needs no judgement at all: `row.superseded.length > 0`.
 *   2. **The row's own note points at something the book has not said yet.** "revealed later",
 *      "will be explained", "in later chapters", "turns out to be". A note like that is the record
 *      admitting its own rendering was chosen before the reveal, and the reveal has now happened —
 *      the whole series has been read, and this pass runs after it.
 *
 * ## Why the agenda is a query and never a model's shortlist
 *
 * The alternative is "give the model the glossary and ask which terms look suspicious". That is a
 * model deciding what the pipeline is allowed to spend money on, and it is not reproducible: two
 * runs would ask about different terms and no audit could tell whether the difference was a real
 * difference in the books or a different roll of the dice. Every input to this module is a row of
 * the settled record, so the same record always produces the same agenda — which is also what makes
 * the bound provable offline and what makes "a second pass over the same agenda costs 0 calls"
 * testable rather than aspirational.
 *
 * ## What the shape list was measured against, and what it gets wrong
 *
 * The 15 shipped shapes were run over the **5,392 data rows** of the previous run's 17 published
 * glossary files (read-only copies from the tag `pre-extraction-fix-2026-10-12`). They fire on
 * **59 rows / 8 distinct terms**; the chain half adds 2, and the two halves do not overlap, so the
 * agenda for that whole series is **10 terms**. Against the corpus as it stands today (only volume
 * 01 built, 137 rows) they fire on **3 rows / 3 terms** and the chain half fires on 0.
 *
 * Two shapes were measured and **dropped**, because they fired on legitimate rows:
 *   - `true-or-hidden-nature` — 僕／俺（一人称）, 如月茉莉花, 純情可憐ＧＩＲＬ. Those notes state the
 *     hidden thing; they do not point at a later reveal.
 *   - `deliberately-withheld` — スタバ, 超有名遊園地, 一人目の図書委員, 後輩マネージャー. A note that
 *     says the book keeps a detail vague is a fact about the book, not a promise about volume 9.
 * Together they fired on 46 rows / 7 distinct terms, none of them a term a later reveal re-renders.
 * They are kept here as a named list rather than deleted, because a shape list nobody can see is a
 * shape list somebody adds the dropped one back to.
 *
 * The known **false negatives** are named too, because they are the honest half of the measurement:
 * a note that says a reveal happened without using any of these words ("its name is given in the
 * third volume's final chapter" would match, "the third volume names her" would not). The list is
 * deliberately narrow for the same reason `researchable.js`'s is: the loose version of every one of
 * these patterns fires on ordinary rows, and a rule that cries on correct behaviour gets switched
 * off.
 *
 * @module glossary/settlement/agenda
 */

require("../../types"); // JSDoc type definitions
const { structuralError } = require("../../configs/shared");
const {
  publishedGlossaryRowsInRecord,
  researchNotesInRecord,
  mergeResearchNotes,
} = require("../../utils/reference-store");

// ─── The bound ────────────────────────────────────────────────────────────────

/**
 * How many terms one settlement pass may pay a reading call for, at most.
 *
 * A constant with no environment knob, for the reason AGENTS.md rule 3 gives for every guard in this
 * repository: a number a run can raise is a number a run will raise.
 *
 * Chosen from the measurement in this module's header: the previous run's 17-volume series produces
 * an agenda of **10** terms, and the corpus as it stands today produces **3**. 24 is 2.4× the
 * largest agenda this series has ever produced, and at the 3,962 mean prompt tokens a bounded
 * tool-less call measured at, the whole bound is ≈ 95,000 prompt tokens for a series — against one
 * volume's 1,141,844-token reading pass. Pinned by `test/test-glossary-settlement.js`, which also
 * pins that a run cut by the bound NAMES what it cut.
 *
 * @type {number}
 */
const SETTLEMENT_MAX_TERMS_PER_RUN = 24;

// ─── The shapes ───────────────────────────────────────────────────────────────

/**
 * The closed set of note shapes that say "this row's meaning is not settled yet — a later part of
 * the series says more".
 *
 * Each one is named so the decision log can say WHICH shape fired. Narrow on purpose: the loose
 * versions were measured against the real corpus and rejected (see this module's header).
 *
 * @type {Array<{name: string, re: RegExp, why: string}>}
 */
const FORWARD_REVEAL_SHAPES = [
  {
    name: "reveal-then-later",
    re: /\b(?:revealed|reveals|explained|clarified|identified|settled|named|given)\b[^.;]{0,40}\b(?:later|eventually|finally|afterwards)\b/i,
    why: 'a note that says the thing is revealed later ("its identity is revealed in a later volume")',
  },
  {
    name: "later-then-reveal",
    re: /\b(?:later|eventually|finally|afterwards|subsequently)\b[^.;]{0,40}\b(?:revealed|reveals|explained|named|identified|given|declared|introduced)\b/i,
    why: 'the same promise with the two halves swapped ("later revealed to be")',
  },
  {
    name: "will-be-explained",
    re: /\bwill be (?:explained|revealed|clarified|made clear|answered)\b/i,
    why: "a note that puts the explanation in the future tense",
  },
  {
    name: "to-be-revealed",
    re: /\b(?:to be|yet to be) (?:revealed|explained|named|identified|settled)\b/i,
    why: 'the infinitive form of the same promise ("yet to be named")',
  },
  {
    name: "in-later-chapters",
    re: /\bin later (?:chapters?|volumes?|instalments?|arc)/i,
    why: "the note names a later part of the series as where the answer is",
  },
  {
    name: "future-volume",
    re: /\bfuture (?:volume|chapters?|instalment)/i,
    why: 'the same pointer in the other direction ("a future volume clarifies")',
  },
  {
    name: "unless-a-later-volume",
    re: /\bunless a later volume\b/i,
    why: "the note makes its own rendering conditional on a volume that has now been read",
  },
  {
    name: "track-for-consistency",
    re: /\btrack(?:s|ing|ed)?[^.;]{0,30}for consistency/i,
    why: "the note is watching for a later statement, which is the shape a pre-reveal rendering takes",
  },
  {
    name: "foreshadow",
    re: /\bforeshadow/i,
    why: "the note calls the row foreshadowing, which means the payoff is elsewhere",
  },
  {
    name: "real-name-given",
    re: /\breal name is (?:finally |now |at last )?(?:given|revealed|supplied|provided)\b/i,
    why: "the note says a real name is now supplied, which is exactly when a rendering changes",
  },
  {
    name: "turns-out-to-be",
    re: /\bturn(?:s|ed)? out to be\b/i,
    why: 'the reveal idiom itself ("turns out to be the same person")',
  },
  {
    name: "until-that-reveal",
    re: /\buntil (?:that|the|its) reveal\b/i,
    why: "the note marks its own row as standing only until the reveal",
  },
  {
    name: "confirm-later",
    re: /\bconfirm(?:s|ed|ing)?[^.;]{0,45}\blater\b/i,
    why: "the note is waiting for a later confirmation",
  },
  {
    name: "not-named-later",
    re: /\bnot (?:yet )?(?:named|stated|explained|revealed|identified|settled|confirmed)\b[^.;]{0,45}\b(?:later|yet|to be|until|finally|confirm)\b/i,
    why: 'the negative form ("not yet named; later volumes may supply it")',
  },
  {
    name: "recontextualise",
    re: /\brecontextual/i,
    why: "the note says the row's meaning is recontextualised, which is what a reveal does to a rendering",
  },
];

/**
 * The shapes that were measured against the real corpus and **rejected**, kept with the note that
 * made each one wrong so nobody re-adds them.
 *
 * @type {Array<{name: string, re: RegExp, firedOn: string[], because: string}>}
 */
const DROPPED_SHAPES = [
  {
    name: "true-or-hidden-nature",
    re: /\b(?:true|hidden) (?:nature|identity|self|meaning|name)\b/i,
    firedOn: ["僕／俺（一人称）", "如月茉莉花", "純情可憐ＧＩＲＬ"],
    because:
      "these notes STATE the hidden thing. \"Her true name is 如月茉莉花\" is a settled fact in the row, " +
      "not a pointer at a volume that has not been read yet, and the rendering is already correct.",
  },
  {
    name: "deliberately-withheld",
    re: /\bdeliberately (?:withheld|unexplained|unnamed|ambiguous|vague)\b/i,
    firedOn: ["スタバ", "超有名遊園地", "一人目の図書委員", "後輩マネージャー"],
    because:
      "a note saying the book keeps a detail vague is a description of the book. None of these four is " +
      "a term a later volume names, and three of them are joke renderings the series never resolves.",
  },
];

// ─── The classifier ───────────────────────────────────────────────────────────

/**
 * The names of the forward shapes that fire on one notes cell.
 *
 * @param {string} notes - A glossary row's notes cell, as the published file prints it.
 * @returns {string[]} The shape names that matched, in list order.
 */
function firedForwardShapes(notes) {
  const text = String(notes || "");
  const hits = [];
  for (const shape of FORWARD_REVEAL_SHAPES) {
    if (shape.re.test(text)) hits.push(shape.name);
  }
  return hits;
}

/**
 * The notes cell the published file actually prints for a row.
 *
 * The agenda has to be asked of the same text a reader sees. `publishedGlossaryRowsInRecord` returns
 * the row's own `body`, and the render adds the research notes filed against the term on top of it —
 * so a forward pointer that arrived through a research note would be invisible to an agenda that read
 * only the body. This is the render's own merge, reused rather than a second version of it.
 *
 * @param {{notes?: string, term: string}} row
 * @param {Map<string, Array<Object>>} notesByTerm - Research notes in the record, keyed by term.
 * @returns {string}
 */
function printedNotesCell(row, notesByTerm) {
  const key = String(row.term || "").trim();
  return mergeResearchNotes(String(row.notes || ""), notesByTerm.get(key) || []);
}

/**
 * The research notes of a record, keyed by term — the same join `renderGlossary` makes.
 *
 * @param {{db: Object, volume: number}} store - The settled record, opened read-only.
 * @returns {Map<string, Array<Object>>}
 */
function researchNotesByTerm(store) {
  /** @type {Map<string, Array<Object>>} */
  const byTerm = new Map();
  for (const note of researchNotesInRecord(store)) {
    const key = String(note.term || "").trim();
    if (!key) continue;
    if (!byTerm.has(key)) byTerm.set(key, []);
    byTerm.get(key).push(note);
  }
  return byTerm;
}

/**
 * One settled row, read as a settlement candidate.
 *
 * `flaggingVolume` is the volume the decision has to be filed into, and it is not a free choice: the
 * revision door only accepts a quote from the record of the volume whose scope the handle carries, so
 * the flagging volume is the volume that OWNS the row in force — the one whose book the rendering was
 * last chosen from.
 *
 * @param {Object} row - One {@link publishedGlossaryRowsInRecord} entry.
 * @param {Map<string, Array<Object>>} notesByTerm
 * @returns {{term: string, rendering: string, notes: string, section: string|null, flaggingVolume: number, chain: boolean, supersededFromVolumes: number[], shapes: string[], because: string, ord: number}}
 */
function classifyRow(row, notesByTerm) {
  const notes = printedNotesCell(row, notesByTerm);
  const shapes = firedForwardShapes(notes);
  const chain = Array.isArray(row.superseded) && row.superseded.length > 0;
  const because =
    chain && shapes.length
      ? `its rendering has already been replaced ${row.superseded.length} time(s), and its own note points forward (${shapes.join(", ")})`
      : chain
        ? `its rendering has already been replaced ${row.superseded.length} time(s) — the series has already decided this term more than once`
        : shapes.length
          ? `its own note points at something the book had not said yet (${shapes.join(", ")})`
          : "neither its chain nor its note points past the volume that wrote it";
  return {
    term: String(row.term || "").trim(),
    rendering: String(row.rendering || "").trim(),
    notes,
    section: row.section || null,
    flaggingVolume: Number(row.ownerVolume),
    chain,
    supersededFromVolumes: (Array.isArray(row.superseded) ? row.superseded : []).map((r) => Number(r.appliesFromVolume)),
    shapes,
    because,
    ord: Number(row.ord),
  };
}

// ─── The agenda ───────────────────────────────────────────────────────────────

/**
 * The settlement agenda for one series: the terms the settled record itself says are worth asking
 * about, cut to the bound.
 *
 * Deterministic by construction. The rows come from one query over the settled record, the order is
 * that query's own render order (`ord`, then `id`), a term appears once, and the cut is a prefix — so
 * the same record always produces the same agenda and always names the same terms it threw away.
 *
 * @param {{db: Object, volume: number}} settled - The settled record, opened read-only.
 * @param {{limit?: number}} [opts] - `limit` overrides the bound for a measurement; a run never passes it.
 * @returns {{agenda: Array<Object>, skipped: Array<Object>, candidateCount: number, chainCount: number, forwardCount: number, limit: number, capped: boolean}}
 *   `agenda` is what the pass may pay for; `skipped` is what the bound cut, named, with the reason it
 *   was a candidate in the first place.
 * @throws {Error} A structural refusal (`settlement-agenda-has-no-record`) when the caller hands this
 *   query no record to query. An agenda that cannot be read is NOT an empty agenda: an empty agenda means
 *   "this series has nothing to settle", and that is the one answer that lets the pass publish a settled
 *   glossary it never settled and let the freeze gate report `settlement-no-change` for an act that read
 *   nothing. The refusal is structural so `ON_TASK_ERROR=continue` cannot walk past it.
 */
function settlementAgenda(settled, { limit = SETTLEMENT_MAX_TERMS_PER_RUN } = {}) {
  if (!settled || !settled.db || typeof settled.db.prepare !== "function") {
    throw structuralError(
      "[glossary-settlement] settlement-agenda-has-no-record: the settlement agenda is a query over the " +
        "settled reference record, and it was handed no record to query. An agenda that cannot be read is " +
        "not an empty agenda — reporting \"nothing to settle\" for a record nobody opened is how this pass " +
        "would publish a settled glossary it never settled."
    );
  }
  const volume = Number(settled.volume);
  const rows = publishedGlossaryRowsInRecord(settled, { volume });
  const notesByTerm = researchNotesByTerm(settled);

  /** @type {Map<string, Object>} */
  const candidates = new Map();
  for (const row of rows) {
    const item = classifyRow(row, notesByTerm);
    if (!item.term) continue;
    if (!item.chain && item.shapes.length === 0) continue;
    if (!Number.isInteger(item.flaggingVolume)) continue;
    if (!candidates.has(item.term)) candidates.set(item.term, item);
  }

  const ordered = [...candidates.values()];
  const chainCount = ordered.filter((item) => item.chain).length;
  const forwardCount = ordered.filter((item) => item.shapes.length > 0).length;
  return {
    agenda: ordered.slice(0, limit),
    skipped: ordered.slice(limit),
    candidateCount: ordered.length,
    chainCount,
    forwardCount,
    limit,
    capped: ordered.length > limit,
  };
}

module.exports = {
  SETTLEMENT_MAX_TERMS_PER_RUN,
  FORWARD_REVEAL_SHAPES,
  DROPPED_SHAPES,
  firedForwardShapes,
  printedNotesCell,
  researchNotesByTerm,
  classifyRow,
  settlementAgenda,
};

/**
 * glossary/researchable.js — which of this volume's glossary rows the stage is allowed to pay a
 * research turn for, and how many turns that is.
 *
 * Two questions, and only one of them is a judgement:
 *
 *   1. **Is this row worth looking up?** A research turn is worth paying for when the row's meaning
 *      lives OUTSIDE the book — a real prize, a real place, a real product, a real idiom the author
 *      borrowed. It is not worth paying for when the row is this series' own coinage, because Wikipedia
 *      has nothing about a word one novel invented.
 *   2. **How many turns may one volume spend?** A constant, `RESEARCH_MAX_TERMS_PER_VOLUME`, with no
 *      environment knob on it (AGENTS.md rule 3: a check you can switch off is not a check).
 *
 * ## Why the rule is a query over the record, not over the model's answer
 *
 * The rows this classifies come out of the volume's own reference record — `publishedGlossaryRowsInRecord`
 * — so
 * a term the record refused to file (no line of the book prints it, no rendering) never costs a call,
 * and the same term asked twice in one volume is one row. That is also what makes the bound provable
 * offline: the input is a table query, not a model reply.
 *
 * ## Why the section half alone is not enough, and why it is still in the rule
 *
 * The plan of record (`glossary/plan/01-glossary-route.md` §5) proposed "the row sits under
 * `Real-World References`". Measured, that selects **0 rows on a series built from scratch**:
 * `EXTRACTION_TYPE_TO_SECTION` maps only `character | place | item | faction | concept`, and the
 * extraction prompt has no `real_world` type, so the render route never writes that heading. The
 * section half is kept because an authored glossary (and a record topped up from one) does have it, and
 * it is the cheap, honest signal when it exists. The note half is what makes the rule work on a record
 * the render built.
 *
 * ## What the rule was measured against, and what it gets wrong
 *
 * The 554 rows of the tagged real cumulative glossary (`git show
 * 'pre-extraction-fix-2026-10-12:…/glossary.md'`, read-only copies). Selected 126, skipped 428.
 * The false positives are named in `glossary/plan/01-glossary-route.md` §5: 31 of the 49 `Places` rows
 * are this series' own rooms and schools (図書室, 屋上, 購買, 部室, 七竈かまど高校 …), because the
 * section half cannot tell a school from a station. The false negatives are named too (芥川賞, 埴輪,
 * ミロのヴィーナス, **仁王像** — the plan's own example — 初詣, 偏差値 …), because their notes never
 * declare an outside referent. A narrowing that skipped a `Places` row whose note names one of the
 * book's own cast entries was measured and **rejected**: it removes 22 of the 49 Places rows, and among
 * them 追浜駅, 札さつ幌ぽろ, 青森 and 目黒寄生虫館 — four real places whose notes mention a character
 * who went there.
 *
 * This module is a **bound on what the pipeline pays for**. It is not a claim that code can tell a
 * real-world reference from an invented one, and both error lists are printed in the plan rather than
 * hidden.
 *
 * @module glossary/researchable
 */

require("../types"); // JSDoc type definitions
const { publishedGlossaryRowsInRecord } = require("../utils/reference-store");

// ─── The bound ────────────────────────────────────────────────────────────────

/**
 * How many research turns one volume may spend, at most.
 *
 * A constant with no environment knob, for the reason AGENTS.md rule 3 gives for every guard in this
 * repository: a number a run can raise is a number a run will raise. Pinned by
 * `test/test-glossary-research-bound.js`, which also pins that the volume that hits the cap says so.
 *
 * Chosen from the real corpus: the widest volume the tagged 17-volume run produced was 25 researchable
 * rows (volume 1) and 17 (volume 17); every other volume was 11 or fewer. A cap of 12 leaves 15 of the
 * 17 volumes untouched and cuts the series total from 125 to 107 research turns — against the 494
 * research conversations the last live run paid for.
 *
 * @type {number}
 */
const RESEARCH_MAX_TERMS_PER_VOLUME = 12;

/**
 * The glossary sections whose rows are about the world rather than about the book.
 *
 * Only an authored glossary (or a record topped up from one) writes `Real-World References`; the render
 * route's own section vocabulary is the five in `EXTRACTION_TYPE_TO_SECTION`. `Places` is in both, and
 * it is the section that carries the rule's known false positives.
 *
 * @type {string[]}
 */
const RESEARCH_WORLD_SECTIONS = ["Real-World References", "Places"];

/**
 * The closed set of note shapes that say "this row's referent is outside this book".
 *
 * Each one is named so the log and the test can say WHICH shape fired, and each is deliberately narrow.
 * The loose versions were measured and rejected: bare `the real` fires on "her real name is withheld",
 * `established English` and `Standard Japanese` and `loanword` and `wasei-eigo` fire on rows that are
 * simply ordinary Japanese words, and bare `allusion` fires on a character's own running gag. What is
 * left are the shapes the real glossary actually uses to point outside itself.
 *
 * @type {Array<{name: string, re: RegExp, why: string}>}
 */
const OUTSIDE_REFERENT_SHAPES = [
  {
    name: "clause-real",
    re: /(?:^|[;:(|])\s*Real\b/,
    why: 'a clause that opens by calling the thing Real ("Real Dengeki Bunko light novel", "Real brand")',
  },
  {
    name: "parody-of",
    re: /\b[Pp]arody of\b/,
    why: "the row names the real work it parodies, which is the thing a translator has to recognise",
  },
  {
    name: "allusion-to",
    re: /\b[Aa]llusion to\b/,
    why: "the row says it alludes to something outside the book",
  },
  {
    name: "the-real-proper-noun",
    re: /\bthe real [A-ZÀ-ſ]/,
    why: 'a capitalised proper noun after "the real" ("the real Sapporo confection", "the real Arnott\'s biscuit")',
  },
  {
    name: "cf-real",
    re: /\bcf\. real\b/i,
    why: 'the compare-with form the glossary uses to point at the real thing ("cf. real …")',
  },
];

/**
 * The closed set of note shapes that say "this series made this up".
 *
 * A disqualifier, and it beats the section half: a row under `Places` that the note calls a
 * school-internal club room is not a place worth a lookup, and a row the note calls a coinage is not a
 * real-world reference however it got filed.
 *
 * @type {Array<{name: string, re: RegExp, why: string}>}
 */
const INVENTED_BY_SERIES_SHAPES = [
  { name: "coined", re: /\bcoined\b/i, why: "the note says somebody in the book coined the term" },
  { name: "in-series", re: /\bin-series\b/i, why: "the note calls it an in-series thing" },
  { name: "series-coinage", re: /\bseries coinage\b/i, why: "the note calls it the series' own coinage" },
  { name: "this-series", re: /\bthis series\b/i, why: "the note attributes it to this series" },
  { name: "in-world", re: /\bin-world\b/i, why: "the note calls it in-world" },
  { name: "school-internal", re: /\bschool-internal\b/i, why: "the note says it exists only inside the school" },
];

// ─── The classifier ───────────────────────────────────────────────────────────

/**
 * The names of the shapes that fire on one notes cell.
 *
 * @param {string} notes - A glossary row's notes cell.
 * @param {Array<{name: string, re: RegExp}>} shapes - One of the two closed shape lists.
 * @returns {string[]} The names that matched, in list order.
 */
function firedShapes(notes, shapes) {
  const text = String(notes || "");
  const hits = [];
  for (const shape of shapes) {
    if (shape.re.test(text)) hits.push(shape.name);
  }
  return hits;
}

/**
 * Whether one glossary row is worth a research turn.
 *
 * `researchable` when the row sits in a world section OR its own note declares an outside referent,
 * AND its note does not declare that this series invented it.
 *
 * @param {{term: string, rendering?: string, notes?: string, section?: string}} row - One glossary row.
 * @returns {{term: string, section: string, researchable: boolean, worldSection: boolean, outside: string[], invented: string[], because: string}}
 *   `outside` / `invented` name the shapes that fired, so a log can say WHY a row was picked or dropped
 *   instead of leaving it to be inferred.
 */
function classifyResearchable(row) {
  const section = String((row && row.section) || "");
  const notes = String((row && row.notes) || "");
  const worldSection = RESEARCH_WORLD_SECTIONS.includes(section);
  const outside = firedShapes(notes, OUTSIDE_REFERENT_SHAPES);
  const invented = firedShapes(notes, INVENTED_BY_SERIES_SHAPES);
  const researchable = (worldSection || outside.length > 0) && invented.length === 0;
  const because = invented.length
    ? `its own note says this series made it up (${invented.join(", ")})`
    : worldSection
      ? `it is filed under ${section}`
      : outside.length
        ? `its note declares an outside referent (${outside.join(", ")})`
        : "neither its section nor its note points outside this book";
  return {
    term: String((row && row.term) || ""),
    section,
    researchable,
    worldSection,
    outside,
    invented,
    because,
  };
}

/**
 * This volume's glossary rows, read out of its reference record.
 *
 * "This volume's own rows" means the rows this volume established — a row carried forward from an
 * earlier volume belongs to the volume that wrote it, and researching it again is the double payment
 * this bound exists to stop.
 *
 * @param {ReferenceStore} store - The volume's open record.
 * @param {number|string} volume - This volume's installment number.
 * @returns {Array<{id: string, term: string, rendering: string, notes: string, section: string, establishedVolume: number}>}
 */
function volumeGlossaryRows(store, volume) {
  const vol = Number(volume);
  return publishedGlossaryRowsInRecord(store).filter((row) => row.establishedVolume === vol);
}

/**
 * The research targets for one volume: what the record says is worth asking, cut to the cap.
 *
 * The order is the record's own render order (`ord`, then `id`), so the cut is reproducible: the same
 * record always asks the same questions and always names the same skipped rows.
 *
 * @param {ReferenceStore} store - The volume's open record.
 * @param {number|string} volume - This volume's installment number.
 * @param {{limit?: number}} [opts] - `limit` overrides the cap for a measurement; a run never passes it.
 * @returns {{targets: Array<Object>, skipped: Array<Object>, researchableCount: number, limit: number, capped: boolean, notResearchable: Array<Object>}}
 *   `targets` each carry the `researchable` verdict beside them (`outside` / `invented` / `because`), so
 *   the caller can print why a row was picked; `skipped` is what the cap threw away, named.
 */
function selectResearchTargets(store, volume, { limit = RESEARCH_MAX_TERMS_PER_VOLUME } = {}) {
  const rows = volumeGlossaryRows(store, volume);
  const verdicts = rows.map((row) => ({ row, verdict: classifyResearchable(row) }));
  const researchable = verdicts.filter((item) => item.verdict.researchable);
  const targets = researchable.slice(0, limit).map((item) => ({ ...item.row, ...item.verdict }));
  const skipped = researchable.slice(limit).map((item) => ({ ...item.row, ...item.verdict }));
  return {
    targets,
    skipped,
    researchableCount: researchable.length,
    limit,
    capped: researchable.length > limit,
    notResearchable: verdicts.filter((item) => !item.verdict.researchable).map((item) => ({ ...item.row, ...item.verdict })),
  };
}

module.exports = {
  RESEARCH_MAX_TERMS_PER_VOLUME,
  RESEARCH_WORLD_SECTIONS,
  OUTSIDE_REFERENT_SHAPES,
  INVENTED_BY_SERIES_SHAPES,
  firedShapes,
  classifyResearchable,
  volumeGlossaryRows,
  selectResearchTargets,
};

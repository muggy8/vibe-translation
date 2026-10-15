/**
 * utils/reference-store/register/answers.js — the read side of the register layer: which claims answer
 * which declared question, and which answer none at all.
 *
 * Plan 06 slice 5. The acceptance line it has to meet is one sentence: **a query answers "how formal is
 * this character" without also returning their vocabulary.** The measurement in §2.3 is why that is hard:
 * `QUIRK_TYPE_TO_ASPECT` maps four of the extraction's seven kinds onto the one aspect `register`, so a
 * query run on the aspect returns the sentence endings, the formality, the vocabulary and the dialect as
 * one undifferentiated pile.
 *
 * ## Why the distinction rides on the axis and not on new aspect names
 *
 * The two obvious designs are both closed, and they are closed by rules this repository does not bend:
 *
 *   - **Renaming the aspects** would mean re-labelling rows that are already sealed. A sealed row is never
 *     edited, moved or re-labelled — that is the rule the whole store is built on, and a volume's record is
 *     committed with the books. So `register` stays `register`, and the four-into-one mapping stays exactly
 *     where it is.
 *   - **Leaving the values and hoping a query sorts them out** is what the collapse already is.
 *
 * What is left is the pair schema 10 added: `facts.axis` / `facts.axis_value`, nullable, insert-only, and
 * refused before they are written unless the series declared them (`register/filing.js`). A claim that
 * names a question is answerable **by that question**. A claim that names none is answerable only by its
 * aspect, and its aspect is the collapsed one. This module is the door that reads the difference, and it
 * reports both populations, because a query that silently returns only the answerable half is the same
 * silence the collapse already is.
 *
 * ## What this module cannot do, stated where it would otherwise be assumed
 *
 * **The record cannot invent a distinction the extraction never answered.** For every claim filed today in
 * this corpus, and for every claim the two manual doors file, `axis` is null: the extraction was never
 * asked which question it was answering, and no door may guess one (there is no axis list in code, in any
 * language — `test/test-no-language-axis-list.js`). So the honest answer to "how formal is this character"
 * on such a record is *"this record cannot answer that question, and here are the N claims that sit on the
 * aspect the four kinds collapse into"*. That is what `registerAxisInventory` prints, and it is what the
 * audit report prints, so the gap is a number in a report rather than a comment in a file.
 *
 * **A claim's axis never travels backwards.** `extractionClaimAlreadyStored` recognises a claim the record
 * already holds by `(key, aspect, body)` — not by its axis — and it has to stay that way, or a volume built
 * twice files its 223 claims a second time. The consequence is stated here because it is a consequence: a
 * claim filed without an axis keeps no axis when the same volume is re-read with a declaration in place.
 * The new answer is a **new row beside the old one**, never an edit of the old one.
 *
 * @module utils/reference-store/register/answers
 */

const { currentClaimSql } = require("../facts");
const { EXTRACTION_SOURCE_STAGE } = require("../schema");
const { refusal } = require("../refusals");
const { QUIRK_TYPE_TO_ASPECT, UNMAPPED_ASPECT } = require("../extraction-adapter");
require("../../../types"); // JSDoc type definitions

/**
 * The bounds on one read.
 *
 * Constants with no environment knob (AGENTS.md rule 3). They are row caps on what one call returns, and
 * every one of them reports the number it dropped — a cap that fires silently is the defect slice 2 was
 * written to remove.
 *
 *   - `maxClaims` — how many claims one axis question returns.
 *   - `maxAxesReported` — how many questions one inventory prints.
 *   - `maxAspectsReported` — how many aspect buckets the axis-less half of an inventory prints.
 *   - `maxValuesPerAxis` — how many distinct answers one question's row prints.
 *
 * @type {{maxClaims: number, maxAxesReported: number, maxAspectsReported: number, maxValuesPerAxis: number}}
 */
const AXIS_ANSWER_LIMITS = {
  maxClaims: 60,
  maxAxesReported: 40,
  maxAspectsReported: 12,
  maxValuesPerAxis: 12,
};

/**
 * The aspect the extraction's quirk kinds collapse into, derived from the mapping table rather than
 * written here as a number.
 *
 * `QUIRK_TYPE_TO_ASPECT` is the collapse plan 06 §2.3 measured: four of the seven kinds land on `register`.
 * Reading the count out of the table means this module's own report follows the table if it ever changes,
 * and a hardcoded 4 would be a claim about a mapping this file does not own.
 *
 * @returns {{aspect: string, kindsCollapsed: number, kinds: string[]}}
 */
function collapsedAspectAccount() {
  const aspect = QUIRK_TYPE_TO_ASPECT.formality;
  const kinds = Object.entries(QUIRK_TYPE_TO_ASPECT)
    .filter(([, mapped]) => mapped === aspect)
    .map(([kind]) => kind)
    .sort();
  return { aspect, kindsCollapsed: kinds.length, kinds };
}

/**
 * The declaration this read is answering under.
 *
 * Read off the store handle, where `open.js` froze it from the series' own plan of record — never off an
 * argument a caller could pass, and never off a list this file holds. A handle that was given no
 * declaration is read as a series that declared none, which is the branch that says so out loud.
 *
 * @param {Object} ctx - The store handle.
 * @returns {{state: string, axes: Array<Object>, note: string|null}}
 */
function declarationOf(ctx) {
  const declaration = ctx && ctx.registerDeclaration;
  if (!declaration || !declaration.state) {
    return { state: "absent", axes: [], note: "this store handle carries no register declaration" };
  }
  return {
    state: declaration.state,
    axes: Array.isArray(declaration.axes) ? declaration.axes : [],
    note: declaration.note || null,
  };
}

/**
 * The refusal every read here shares when there is nothing to read.
 *
 * @param {string} verb
 * @param {string} because
 * @returns {ReferenceRefusal}
 */
function readRefusal(verb, because) {
  return refusal({
    verb,
    rule: "no-reference-record",
    because,
    useInstead: ["openReferenceStore({ volume, stage }) — the same door the stages and the manual doors open"],
    fix: "open the volume's record first; every answer here is a query over its rows.",
  });
}

/**
 * The `WHERE` half every answer here shares: record content (not the extraction's own candidate copies),
 * the record's current claim (`currentClaimSql` — not retracted, not replaced by a live row, not the
 * challenger side of an open dispute), character-voice claims only (`term_usage` is a glossary row), and
 * the validity span **as of the volume being asked about** (plan 06 §5/§6).
 *
 * @param {string} alias
 * @param {number|null} volume - Null leaves the span unbounded, which is what a whole-record inventory asks.
 * @returns {{clause: string, params: Array<number|string>}}
 */
function answerScope(alias, volume) {
  const clause =
    `${alias}.source_stage != ? AND ` +
    `${alias}.aspect != 'term_usage' AND ${currentClaimSql(alias)}`;
  const params = [EXTRACTION_SOURCE_STAGE];
  if (volume !== null && volume !== undefined) {
    const vol = Number(volume);
    return {
      clause: `${clause} AND ${alias}.applies_from_volume <= ? AND (${alias}.applies_to_volume IS NULL OR ${alias}.applies_to_volume >= ?)`,
      params: [...params, vol, vol],
    };
  }
  return { clause, params };
}

/**
 * One row of an answer, in the shape a caller (or a report) reads.
 *
 * @param {Object} row - A `facts` row with the aliases this module asks for.
 * @returns {Object}
 */
function answerRow(row) {
  return {
    id: row.id,
    key: row.key,
    extractedAs: row.extractedAs,
    aspect: row.aspect,
    label: row.label,
    body: row.body,
    axis: row.axis,
    axisValue: row.axisValue,
    status: row.status,
    establishedVolume: row.establishedVolume,
    ownerVolume: row.ownerVolume,
    sourceStage: row.sourceStage,
  };
}

/** The columns one answer selects, with the aliases `answerRow` reads. */
const ANSWER_COLUMNS =
  "f.id, f.key, f.extracted_as AS extractedAs, f.aspect, f.label, f.body, f.axis, f.axis_value AS axisValue, " +
  "f.status, f.established_volume AS establishedVolume, f.owner_volume AS ownerVolume, f.source_stage AS sourceStage";

/**
 * **The axis query.** Every claim the record stands behind that answers ONE declared question — and the
 * counts of everything it did not return, which is the half that proves the question was actually separated.
 *
 * Asked for one character (`key`) or for the whole record. The aspect is never a filter here: the whole
 * point is that the aspect is the wrong key for this question.
 *
 * @param {Object} ctx - The store handle.
 * @param {{axis: string, key?: string|null, volume?: number|null, limit?: number}} query
 * @returns {{ok: boolean, refusal: ReferenceRefusal|null, axis: string, asks: string|null, values: string[]|null,
 *   scope: string|null, declared: boolean, declarationState: string, volume: number|null, key: string|null,
 *   rows: Array<Object>, claimCount: number, characters: number, valuesAnswered: Array<{value: string, claims: number}>,
 *   limit: number, truncated: boolean, claimsInScope: number, answeringAnotherAxis: number, answeringNoAxis: number,
 *   aspectClaimsInScope: Object<string, number>, collapsedRegisterClaimsHeldBack: number, candidateRowsHeldBack: number}}
 */
function claimsAnsweringAxis(ctx, { axis, key = null, volume = null, limit } = {}) {
  if (!ctx || !ctx.db) {
    return {
      ok: false, refusal: readRefusal("claims_answering_axis", "there is no reference record to ask."),
      axis: String(axis === undefined ? "" : axis), asks: null, values: null, scope: null, declared: false,
      declarationState: "absent", volume: null, key: null, rows: [], claimCount: 0, characters: 0,
      valuesAnswered: [], limit: AXIS_ANSWER_LIMITS.maxClaims, truncated: false, claimsInScope: 0,
      answeringAnotherAxis: 0, answeringNoAxis: 0, aspectClaimsInScope: {}, collapsedRegisterClaimsHeldBack: 0,
      candidateRowsHeldBack: 0,
    };
  }
  const asked = typeof axis === "string" ? axis.trim() : "";
  if (!asked) {
    return {
      ok: false,
      refusal: refusal({
        verb: "claims_answering_axis",
        rule: "register-axis-not-named",
        because:
          "this query answers one register question, and no question was named. The pipeline holds no list of " +
          "questions to pick one from — they are declared per series, by the intake, in its own plan of record.",
        fix: `name the axis id: claimsAnsweringAxis({axis: "<declared id>", key, volume}). The series declares: ${
          declarationOf(ctx).axes.map((entry) => entry.id).join(", ") || "none"
        }.`,
        detail: { declaredAxes: declarationOf(ctx).axes.map((entry) => entry.id) },
      }),
      axis: "", asks: null, values: null, scope: null, declared: false, declarationState: declarationOf(ctx).state,
      volume: null, key: null, rows: [], claimCount: 0, characters: 0, valuesAnswered: [],
      limit: AXIS_ANSWER_LIMITS.maxClaims, truncated: false, claimsInScope: 0, answeringAnotherAxis: 0,
      answeringNoAxis: 0, aspectClaimsInScope: {}, collapsedRegisterClaimsHeldBack: 0, candidateRowsHeldBack: 0,
    };
  }

  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : AXIS_ANSWER_LIMITS.maxClaims;
  const declaration = declarationOf(ctx);
  const declared = declaration.axes.find((entry) => entry.id === asked) || null;
  const scope = answerScope("f", volume);
  const keyClause = key === null || key === undefined ? "" : " AND f.key = ?";
  const keyParams = key === null || key === undefined ? [] : [String(key)];

  const rows = ctx.db
    .prepare(`SELECT ${ANSWER_COLUMNS} FROM facts f WHERE ${scope.clause} AND f.axis = ?${keyClause} ORDER BY f.established_volume, f.ord, f.id`)
    .all(...scope.params, asked, ...keyParams);
  const truncated = rows.length > cap;

  // The other half of the same population: what a caller WOULD have got from the aspect, and what this
  // question withheld. Without these numbers the answer looks like a query that simply found one claim.
  const grouped = ctx.db
    .prepare(
      `SELECT f.aspect AS aspect, CASE WHEN f.axis IS NULL THEN '' ELSE f.axis END AS axis, COUNT(*) AS n ` +
      `FROM facts f WHERE ${scope.clause}${keyClause} GROUP BY aspect, axis`
    )
    .all(...scope.params, ...keyParams);
  const candidateRowsHeldBack = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM facts f WHERE f.source_stage = ? AND f.aspect != 'term_usage' AND f.axis = ?${
        key === null || key === undefined ? "" : " AND f.key = ?"
      }`
    )
    .get(EXTRACTION_SOURCE_STAGE, asked, ...(key === null || key === undefined ? [] : [String(key)])).n;

  let claimsInScope = 0;
  let answeringAnotherAxis = 0;
  let answeringNoAxis = 0;
  /** @type {Object<string, number>} */
  const aspectClaimsInScope = {};
  for (const row of grouped) {
    claimsInScope += row.n;
    aspectClaimsInScope[row.aspect] = (aspectClaimsInScope[row.aspect] || 0) + row.n;
    if (row.axis === "") answeringNoAxis += row.n;
    else if (row.axis !== asked) answeringAnotherAxis += row.n;
  }
  const collapse = collapsedAspectAccount();
  const collapsedRegisterClaimsHeldBack = grouped
    .filter((row) => row.aspect === collapse.aspect && row.axis !== asked)
    .reduce((sum, row) => sum + row.n, 0);

  /** @type {Map<string, number>} */
  const valueCounts = new Map();
  for (const row of rows) {
    const value = row.axisValue === null || row.axisValue === undefined ? "(no value)" : row.axisValue;
    valueCounts.set(value, (valueCounts.get(value) || 0) + 1);
  }
  const valuesAnswered = [...valueCounts.entries()]
    .map(([value, claims]) => ({ value, claims }))
    .sort((a, b) => b.claims - a.claims || a.value.localeCompare(b.value, "en"));

  return {
    ok: true,
    refusal: null,
    axis: asked,
    asks: declared ? declared.asks : null,
    values: declared ? declared.values : null,
    scope: declared ? declared.scope : null,
    declared: !!declared,
    declarationState: declaration.state,
    volume: volume === null || volume === undefined ? null : Number(volume),
    key: key === null || key === undefined ? null : String(key),
    rows: rows.slice(0, cap).map(answerRow),
    claimCount: rows.length,
    characters: new Set(rows.map((row) => row.key).filter((entry) => entry !== null)).size,
    valuesAnswered: valuesAnswered.slice(0, AXIS_ANSWER_LIMITS.maxValuesPerAxis),
    valuesAnsweredTotal: valuesAnswered.length,
    limit: cap,
    truncated,
    claimsInScope,
    answeringAnotherAxis,
    answeringNoAxis,
    aspectClaimsInScope,
    collapsedRegisterClaimsHeldBack,
    candidateRowsHeldBack,
  };
}

/**
 * One character's answers, grouped by the question each claim answers.
 *
 * This is the door the plan's acceptance line is about: "how formal is this character" and "which words
 * does this character use" are two rows of one answer, not one bullet list. The claims that name no
 * question are kept **out** of `answers` and reported beside it — a claim cannot be made to answer a
 * question it never named, and folding them in is how a query starts looking like an answer.
 *
 * @param {Object} ctx - The store handle.
 * @param {{key: string, volume?: number|null}} query
 * @returns {{ok: boolean, refusal: ReferenceRefusal|null, key: string, display: string|null, volume: number|null,
 *   declarationState: string, declaredAxes: string[], answers: Array<{axis: string, asks: string|null, declared: boolean,
 *   claims: number, valuesAnswered: Array<{value: string, claims: number}>}>, axislessClaims: number,
 *   axislessByAspect: Array<{aspect: string, claims: number}>, claimsTotal: number, questionsAnswered: number}}
 */
function axisAnswersForCharacter(ctx, { key, volume = null } = {}) {
  if (!ctx || !ctx.db) {
    return {
      ok: false, refusal: readRefusal("axis_answers_for_character", "there is no reference record to ask."),
      key: String(key === undefined ? "" : key), display: null, volume: null, declarationState: "absent",
      declaredAxes: [], answers: [], axislessClaims: 0, axislessByAspect: [], claimsTotal: 0,
      questionsAnswered: 0,
    };
  }
  const asked = typeof key === "string" ? key.trim() : "";
  if (!asked) {
    return {
      ok: false,
      refusal: refusal({
        verb: "axis_answers_for_character",
        rule: "no-roster-entry-named",
        because: "this query answers the declared questions about one roster entry, and no entry was named.",
        fix: "name the cast key: axisAnswersForCharacter({key, volume}).",
      }),
      key: "", display: null, volume: null, declarationState: declarationOf(ctx).state, declaredAxes: [],
      answers: [], axislessClaims: 0, axislessByAspect: [], claimsTotal: 0, questionsAnswered: 0,
    };
  }

  const declaration = declarationOf(ctx);
  /** Declared order first — see `registerAxisInventory`: the series chose the order of its questions. */
  const declaredOrder = new Map(declaration.axes.map((entry, index) => [entry.id, index]));
  const scope = answerScope("f", Number(volume === null || volume === undefined ? ctx.volume : volume));
  const grouped = ctx.db
    .prepare(
      `SELECT f.aspect AS aspect, COALESCE(f.axis, '') AS axis, COUNT(*) AS n FROM facts f ` +
      `WHERE ${scope.clause} AND f.key = ? GROUP BY aspect, axis`
    )
    .all(...scope.params, asked);
  const castRow = ctx.db.prepare("SELECT key, display FROM cast WHERE key = ?").get(asked);

  /** @type {Map<string, {claims: number, values: Map<string, number>}>} */
  const byAxis = new Map();
  /** @type {Map<string, number>} */
  const axisless = new Map();
  let claimsTotal = 0;
  for (const row of grouped) {
    claimsTotal += row.n;
    if (row.axis === "") {
      axisless.set(row.aspect, (axisless.get(row.aspect) || 0) + row.n);
      continue;
    }
    if (!byAxis.has(row.axis)) byAxis.set(row.axis, { claims: 0, values: new Map() });
    const bucket = byAxis.get(row.axis);
    bucket.claims += row.n;
    const values = ctx.db
      .prepare(`SELECT COALESCE(f.axis_value, '(no value)') AS value, COUNT(*) AS n FROM facts f WHERE ${scope.clause} AND f.key = ? AND f.axis = ? GROUP BY value`)
      .all(...scope.params, asked, row.axis);
    for (const value of values) bucket.values.set(value.value, (bucket.values.get(value.value) || 0) + value.n);
  }

  const answers = [...byAxis.entries()]
    .map(([axis, bucket]) => {
      const declared = declaration.axes.find((entry) => entry.id === axis) || null;
      return {
        axis,
        asks: declared ? declared.asks : null,
        declared: !!declared,
        claims: bucket.claims,
        valuesAnswered: [...bucket.values.entries()]
          .map(([value, claims]) => ({ value, claims }))
          .sort((a, b) => b.claims - a.claims || a.value.localeCompare(b.value, "en"))
          .slice(0, AXIS_ANSWER_LIMITS.maxValuesPerAxis),
      };
    })
    .sort((a, b) => {
      const orderA = declaredOrder.has(a.axis) ? declaredOrder.get(a.axis) : Number.MAX_SAFE_INTEGER;
      const orderB = declaredOrder.has(b.axis) ? declaredOrder.get(b.axis) : Number.MAX_SAFE_INTEGER;
      return orderA - orderB || b.claims - a.claims || a.axis.localeCompare(b.axis, "en");
    });

  return {
    ok: true,
    refusal: null,
    key: asked,
    display: castRow ? castRow.display || castRow.key : null,
    volume: Number(volume === null || volume === undefined ? ctx.volume : volume),
    declarationState: declaration.state,
    declaredAxes: declaration.axes.map((entry) => entry.id),
    answers,
    axislessClaims: [...axisless.values()].reduce((sum, n) => sum + n, 0),
    axislessByAspect: [...axisless.entries()]
      .map(([aspect, claims]) => ({ aspect, claims }))
      .sort((a, b) => b.claims - a.claims || a.aspect.localeCompare(b.aspect, "en")),
    claimsTotal,
    questionsAnswered: answers.length,
  };
}

/**
 * The record's own account of what it can answer — the number the audit report prints.
 *
 * Three facts, all of them required by plan 06 slice 5, and none of them a comment:
 *
 *   1. **which declared questions this record can answer**, with the claims and the answers it gives for each;
 *   2. **how many claims answer no declared question at all**, and which aspect they are sitting on;
 *   3. **the collapse, named**: how many of those claims sit on the one aspect the extraction's kinds
 *      collapse into, with the bullet labels that are the only place the extractor's own distinction still
 *      survives.
 *
 * @param {Object} ctx - The store handle.
 * @param {{volume?: number|null}} [opts] - The volume the span is judged at. Defaults to the store's own volume.
 * @returns {{ok: boolean, refusal: ReferenceRefusal|null, volume: number|null, declarationState: string,
 *   declarationNote: string|null, declaredAxes: Array<{id: string, asks: string, values: number}>,
 *   claimsTotal: number, claimsAnswering: number, claimsAnsweringNone: number, unkeyedClaims: number,
 *   candidateRows: number, byAxis: Array<Object>, undeclaredAxes: Array<{axis: string, claims: number}>,
 *   axislessByAspect: Array<{aspect: string, claims: number}>, collapse: Object,
 *   axesAnswered: number, axesDeclared: number, truncatedAxes: number, truncatedAspects: number,
 *   limits: Object, summary: Object}}
 */
function registerAxisInventory(ctx, { volume } = {}) {
  if (!ctx || !ctx.db) {
    return {
      ok: false, refusal: readRefusal("register_axis_inventory", "there is no reference record to ask."),
      volume: null, declarationState: "absent", declarationNote: null, declaredAxes: [], claimsTotal: 0,
      claimsAnswering: 0, claimsAnsweringNone: 0, unkeyedClaims: 0, candidateRows: 0, byAxis: [],
      undeclaredAxes: [], axislessByAspect: [], collapse: collapsedAspectAccount(), axesAnswered: 0,
      axesDeclared: 0, truncatedAxes: 0, truncatedAspects: 0, limits: { ...AXIS_ANSWER_LIMITS },
      summary: { claimsTotal: 0, answering: 0, answeringNone: 0, axesAnswered: 0, axesDeclared: 0 },
    };
  }

  const vol = volume === null || volume === undefined ? Number(ctx.volume) : Number(volume);
  const declaration = declarationOf(ctx);
  const scope = answerScope("f", vol);

  const grouped = ctx.db
    .prepare(
      `SELECT f.aspect AS aspect, COALESCE(f.axis, '') AS axis, COUNT(*) AS n, ` +
      `COUNT(DISTINCT CASE WHEN f.key IS NOT NULL THEN f.key ELSE NULL END) AS characters ` +
      `FROM facts f WHERE ${scope.clause} GROUP BY aspect, axis`
    )
    .all(...scope.params);

  /** @type {Map<string, {claims: number, characters: number}>} */
  const axisTotals = new Map();
  /** @type {Map<string, number>} */
  const axisless = new Map();
  let claimsTotal = 0;
  let unkeyedClaims = 0;
  for (const row of grouped) {
    claimsTotal += row.n;
    if (row.axis === "") {
      axisless.set(row.aspect, (axisless.get(row.aspect) || 0) + row.n);
      continue;
    }
    if (!axisTotals.has(row.axis)) axisTotals.set(row.axis, { claims: 0, characters: 0 });
    const bucket = axisTotals.get(row.axis);
    bucket.claims += row.n;
    bucket.characters = Math.max(bucket.characters, row.characters);
  }
  unkeyedClaims = ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM facts f WHERE ${scope.clause} AND f.key IS NULL`)
    .get(...scope.params).n;
  const candidateRows = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM facts WHERE source_stage = ? AND aspect != 'term_usage' ` +
      `AND applies_from_volume <= ? AND (applies_to_volume IS NULL OR applies_to_volume >= ?)`
    )
    .get(EXTRACTION_SOURCE_STAGE, vol, vol).n;

  /** Declared order first: the series chose the order of its own questions, and a report that re-sorted
   *  itself as the claim counts grew would read like the record changed when only the ordering did. */
  const declaredOrder = new Map(declaration.axes.map((entry, index) => [entry.id, index]));
  const byAxis = [...axisTotals.entries()]
    .map(([axis, bucket]) => {
      const declared = declaration.axes.find((entry) => entry.id === axis) || null;
      const values = ctx.db
        .prepare(`SELECT COALESCE(f.axis_value, '(no value)') AS value, COUNT(*) AS n FROM facts f WHERE ${scope.clause} AND f.axis = ? GROUP BY value`)
        .all(...scope.params, axis);
      return {
        axis,
        declared: !!declared,
        asks: declared ? declared.asks : null,
        claims: bucket.claims,
        characters: bucket.characters,
        valuesAnswered: values
          .map((value) => ({ value: value.value, claims: value.n }))
          .sort((a, b) => b.claims - a.claims || a.value.localeCompare(b.value, "en"))
          .slice(0, AXIS_ANSWER_LIMITS.maxValuesPerAxis),
      };
    })
    .sort((a, b) => {
      const orderA = declaredOrder.has(a.axis) ? declaredOrder.get(a.axis) : Number.MAX_SAFE_INTEGER;
      const orderB = declaredOrder.has(b.axis) ? declaredOrder.get(b.axis) : Number.MAX_SAFE_INTEGER;
      return orderA - orderB || b.claims - a.claims || a.axis.localeCompare(b.axis, "en");
    });

  // The collapse, measured on THIS record: the claims sitting on the aspect the mapping puts four kinds
  // onto, split by whether they answer a declared question. The labels are the only place the extractor's
  // own distinction still exists for the ones that do not.
  const collapse = collapsedAspectAccount();
  const collapseRows = ctx.db
    .prepare(
      `SELECT COALESCE(f.axis, '') AS axis, COALESCE(f.label, '(no label)') AS label, COUNT(*) AS n FROM facts f ` +
      `WHERE ${scope.clause} AND f.aspect = ? GROUP BY axis, label`
    )
    .all(...scope.params, collapse.aspect);
  const collapseAnswering = collapseRows.filter((row) => row.axis !== "").reduce((sum, row) => sum + row.n, 0);
  const collapseLabels = collapseRows
    .filter((row) => row.axis === "")
    .map((row) => ({ label: row.label, claims: row.n }))
    .sort((a, b) => b.claims - a.claims || a.label.localeCompare(b.label, "en"));

  const axislessByAspect = [...axisless.entries()]
    .map(([aspect, claims]) => ({ aspect, claims }))
    .sort((a, b) => b.claims - a.claims || a.aspect.localeCompare(b.aspect, "en"));

  const axesShown = byAxis.slice(0, AXIS_ANSWER_LIMITS.maxAxesReported);
  const aspectsShown = axislessByAspect.slice(0, AXIS_ANSWER_LIMITS.maxAspectsReported);
  const claimsAnswering = byAxis.reduce((sum, entry) => sum + entry.claims, 0);
  const claimsAnsweringNone = [...axisless.values()].reduce((sum, n) => sum + n, 0);

  const summary = {
    claimsTotal,
    answering: claimsAnswering,
    answeringNone: claimsAnsweringNone,
    axesAnswered: byAxis.length,
    axesDeclared: declaration.axes.length,
    collapsedAspect: collapse.aspect,
    collapsedAspectClaimsAnswering: collapseAnswering,
    collapsedAspectClaimsAnsweringNone: collapseRows.filter((row) => row.axis === "").reduce((sum, row) => sum + row.n, 0),
    kindsCollapsedIntoIt: collapse.kindsCollapsed,
    candidateRows,
    unkeyedClaims,
  };

  return {
    ok: true,
    refusal: null,
    volume: vol,
    declarationState: declaration.state,
    declarationNote: declaration.note,
    declaredAxes: declaration.axes.map((entry) => ({ id: entry.id, asks: entry.asks, values: entry.values.length })),
    claimsTotal,
    claimsAnswering,
    claimsAnsweringNone,
    unkeyedClaims,
    candidateRows,
    byAxis: axesShown,
    undeclaredAxes: byAxis.filter((entry) => !entry.declared).map((entry) => ({ axis: entry.axis, claims: entry.claims })),
    axislessByAspect: aspectsShown,
    collapse: { ...collapse, claimsAnswering: collapseAnswering, claimsAnsweringNone: summary.collapsedAspectClaimsAnsweringNone, labels: collapseLabels },
    axesAnswered: byAxis.length,
    axesDeclared: declaration.axes.length,
    truncatedAxes: Math.max(0, byAxis.length - axesShown.length),
    truncatedAspects: Math.max(0, axislessByAspect.length - aspectsShown.length),
    limits: { ...AXIS_ANSWER_LIMITS },
    summary,
  };
}

/**
 * The aspect a claim of a given quirk kind would be filed under, and whether that aspect can answer a
 * declared question on its own.
 *
 * Kept here because it is the sentence the collapse needs said out loud in code: the aspect is the
 * **fallback** for a claim that names no question, and it is not the key any question is asked on.
 *
 * @param {string} quirkType - The extraction's own `quirkType`, any casing.
 * @returns {{aspect: string, mapped: boolean, answersADeclaredQuestion: boolean, collapsedInto: string|null}}
 */
function aspectOfQuirkType(quirkType) {
  const kind = typeof quirkType === "string" ? quirkType.trim().toLowerCase() : "";
  const aspect = QUIRK_TYPE_TO_ASPECT[kind] || UNMAPPED_ASPECT;
  const collapse = collapsedAspectAccount();
  return {
    aspect,
    mapped: Object.prototype.hasOwnProperty.call(QUIRK_TYPE_TO_ASPECT, kind),
    answersADeclaredQuestion: false,
    collapsedInto: aspect === collapse.aspect ? collapse.aspect : null,
  };
}

module.exports = {
  AXIS_ANSWER_LIMITS,
  collapsedAspectAccount,
  aspectOfQuirkType,
  claimsAnsweringAxis,
  axisAnswersForCharacter,
  registerAxisInventory,
};

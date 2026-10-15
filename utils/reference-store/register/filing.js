/**
 * utils/reference-store/register/filing.js — the gate a claim passes when it names a register axis.
 *
 * Plan 06 §4.3 guard 2, in one sentence: **a value outside the declared set is refused at filing and
 * named.** Not bucketed into the nearest declared value, not lower-cased into it, not stored as
 * `unclassified` with a note. A model that invents a politeness level this book never uses produces a
 * refusal the report prints, because a claim filed under a category the series never declared is a
 * claim the series cannot answer a question about later.
 *
 * ## What the gate looks at, and what it ignores
 *
 * The gate fires on a **proposal that names an axis**. A claim that names none is filed exactly as it
 * was before this module existed — which is the whole reason the slice can land before the prompt
 * changes (slice 4 is what asks the extraction to name axes at all). The gate is therefore not "every
 * voice claim must answer a declared question"; it is "a claim that says which question it answers must
 * answer one this series asked, in one of the answers this series declared".
 *
 * The same rule runs whether the series has a declaration or not, and the two cases differ only in the
 * sentence:
 *
 *   - **no declaration** (absent or malformed) + a claim naming an axis → refused. There is no list in
 *     code to check it against, and inventing one is the defect this design exists to remove.
 *   - **no declaration** + a claim naming no axis → filed, as today. This is what keeps `rebuild-voice`
 *     and `extract-voice` working on a corpus whose intake has not re-run yet.
 *   - **a declaration** + an axis nobody declared → refused, naming the ids that ARE declared.
 *   - **a declaration** + an axis + a value outside its value set → refused, naming the values that ARE
 *     declared.
 *
 * ## Why the gate is not a caller's choice
 *
 * It is applied inside `facts/validate.js`, which is the check every insert and every update already
 * shares, and the declaration it reads is `ctx.registerDeclaration` — frozen in `open.js` from the
 * series' own plan of record at the moment the store opened, the same way the write scope is frozen.
 * A door cannot pass its own declaration, cannot pass a narrower one, and cannot pass none: a handle
 * that was never given one is treated as a series with no declaration, which is the branch that refuses
 * an axis-bearing claim rather than the branch that waves it through.
 *
 * @module utils/reference-store/register/filing
 */

const { refusal } = require("../refusals");
const { REGISTER_MANIFEST_KEY } = require("./declaration");
require("../../../types"); // JSDoc type definitions

/**
 * The rules this gate can refuse on, pinned by `test/test-register-declaration.js` so a new one cannot
 * appear without being named and tested.
 *
 * @type {string[]}
 */
const REGISTER_GATE_RULES = [
  "register-declaration-absent",
  "register-declaration-malformed",
  "register-axis-not-declared",
  "register-axis-answer-has-no-value",
  "register-value-outside-declared-set",
  "register-value-without-an-axis",
];

/**
 * The axis a proposal names, as one shape: `{axis, value}`, either null.
 *
 * Read defensively rather than strictly: the zod contract already refuses a non-string, and this
 * function's job is only to decide *which* rule to report when something axis-shaped is present. A
 * blank string counts as not naming it, because `axis: ""` is a caller that did not answer.
 *
 * @param {Object} proposal
 * @returns {{axis: string|null, value: string|null, namedValue: boolean}}
 */
function namedAxisOfProposal(proposal) {
  const rawAxis = proposal && proposal.axis;
  const rawValue = proposal && (proposal.axisValue === undefined ? proposal.value : proposal.axisValue);
  const axis = typeof rawAxis === "string" ? rawAxis.trim() : "";
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  return {
    axis: axis === "" ? null : axis,
    value: value === "" ? null : value,
    // A caller that wrote `axisValue: ""` did name the field and did not answer it — worth telling apart
    // from a caller that never wrote it, because the fix is different.
    namedValue: rawValue !== undefined && rawValue !== null,
  };
}

/**
 * The gate.
 *
 * @param {{registerDeclaration?: Object, volume: number, scope: {volume: number, stage: string}}} ctx
 *   The store handle. `registerDeclaration` is stamped by `open.js`; a handle without one is read as a
 *   series with no declaration.
 * @param {Object} proposal - The zod-parsed fact proposal.
 * @param {string} [verb] - The verb to name in the refusal.
 * @returns {ReferenceRefusal|null} Null when the claim may be filed.
 */
function registerFilingRefusal(ctx, proposal, verb = "insert_fact") {
  const declaration = ctx && ctx.registerDeclaration;
  const state = declaration && declaration.state ? declaration.state : "absent";
  const { axis, value, namedValue } = namedAxisOfProposal(proposal);

  // A claim that names no axis is not this gate's business. Stated out loud because it is the branch
  // every existing door takes today, and the day it stops being the branch is slice 4's decision.
  if (!axis && !value) return null;

  if (!axis) {
    return refusal({
      verb,
      rule: "register-value-without-an-axis",
      because:
        `the claim answers ${JSON.stringify(value)} without saying which register question it answers. ` +
        `A value belongs to an axis: this series declares ${declaration && declaration.axes && declaration.axes.length ? declaration.axes.map((a) => a.id).join(", ") : "none"}.`,
      fix: 'name the axis the claim answers: {axis: "<declared id>", axisValue: "…"}.',
      detail: { axisValue: value, declaredAxes: (declaration && declaration.axes ? declaration.axes : []).map((a) => a.id) },
    });
  }

  if (state === "absent") {
    return refusal({
      verb,
      rule: "register-declaration-absent",
      because:
        `the claim answers the register axis "${axis}", but this series has no register declaration to ` +
        `check it against. There is no axis list in the pipeline to fall back on, in any language.`,
      fix:
        `run the intake (npx gulp discover) so the series declares its own axes, or file the claim without ` +
        `naming an axis. (${REGISTER_MANIFEST_KEY} in ${declaration && declaration.file ? declaration.file : "translation-target.json"})`,
      detail: { axis, axisValue: value, file: declaration && declaration.file },
    });
  }

  if (state === "malformed") {
    return refusal({
      verb,
      rule: "register-declaration-malformed",
      because:
        `the claim answers the register axis "${axis}", but this series' register declaration is present and ` +
        `malformed, so nothing can be checked against it:\n  ${(declaration.problems || []).join("\n  ")}`,
      fix: `fix ${declaration.file || "translation-target.json"}, or re-run the intake.`,
      detail: { axis, axisValue: value, problems: declaration.problems || [] },
    });
  }

  const axes = declaration.axes || [];
  const declared = axes.find((entry) => entry.id === axis);
  if (!declared) {
    return refusal({
      verb,
      rule: "register-axis-not-declared",
      because:
        `the claim answers the register axis "${axis}", which this series does not declare. ` +
        (axes.length
          ? `It declares: ${axes.map((entry) => entry.id).join(", ")}.`
          : `It declares none, and said so: "${declaration.note || "no note"}".`),
      fix:
        `file the claim under a declared axis, or add "${axis}" to ${declaration.file || "translation-target.json"} ` +
        `with the forms this book prints for it.`,
      detail: {
        axis,
        axisValue: value,
        declaredAxes: axes.map((entry) => entry.id),
        declaredAsks: axes.map((entry) => `${entry.id}: ${entry.asks}`),
      },
    });
  }

  if (!value) {
    return refusal({
      verb,
      rule: "register-axis-answer-has-no-value",
      because:
        `the claim names the declared axis "${axis}" (${declared.asks}) and brings no answer for it. ` +
        `An axis named without a value is a question recorded without an answer, which is not a claim.`,
      fix: `answer it with one of: ${declared.values.join(", ")}.`,
      detail: { axis, declaredValues: declared.values, namedValueField: namedValue },
    });
  }

  if (!declared.values.includes(value)) {
    return refusal({
      verb,
      rule: "register-value-outside-declared-set",
      because:
        `the claim answers "${axis}" with ${JSON.stringify(value)}, which is not one of the forms this series ` +
        `declares for it (${declared.values.map((v) => JSON.stringify(v)).join(", ")}). ` +
        `The value is not bucketed, not re-cased and not filed under a nearby value: a form this book does ` +
        `not print is not a form this record may claim.`,
      fix:
        `use one of the declared values, or file the claim with no axis, or — if this book really does print ` +
        `${JSON.stringify(value)} — add it to "${axis}" in ${declaration.file || "translation-target.json"}.`,
      detail: {
        axis,
        axisValue: value,
        declaredValues: declared.values,
        asks: declared.asks,
      },
    });
  }

  return null;
}

module.exports = {
  REGISTER_GATE_RULES,
  namedAxisOfProposal,
  registerFilingRefusal,
};

/**
 * utils/reference-store/register/declaration.js — the SHAPE of a register declaration, and the
 * guards that decide whether a series wrote one.
 *
 * The account owner's rule (character-voice/plan/06-register-declarations.md §4, §10.1) is the whole
 * reason this file exists and the whole reason it holds no lists: **the register questions a
 * character-voice stage asks are declared per series, by the intake, from the book.** There is no
 * axis list in code — none for a single language, none claimed as "universal", none as a fallback.
 * What code knows is the shape of a question: an id, what it asks, the set of answers it accepts, and
 * optional guidance the intake wrote because this book needs the question asked. A series in any
 * language needs no line of this file to change, because nothing here — not even this comment — names
 * a language or a language's forms.
 *
 * ## Why the guards are the review
 *
 * The intake writes the declaration and **nobody confirms it** (§10.1). So the computable checks in
 * `registerDeclarationProblems` are the only review a declaration will ever get. They refuse
 * precisely and they name where: an axis id that is not a slug, an id used twice in one series, a
 * value set that is empty or holds the same value twice or holds a blank, an axis that names a field
 * this shape does not have, a render decision for a value nobody declared, an empty declaration with
 * no stated reason. A declaration that passes these is not necessarily a *good* declaration — no
 * computable check can say that, and §9 forbids asking a model to. It is a well-formed one, and every
 * value in it is checked against the book again at filing (`filing.js`).
 *
 * ## Absent and empty are different facts, and the difference is the point
 *
 * - **absent** — the plan of record has no `register` block at all. That is a series nobody asked.
 *   The voice stage refuses, and names the door.
 * - **present and empty** — `"register": { "axes": [], "note": "…" }`. A book genuinely may need no
 *   register questions, and forcing a fake declaration is worse than recording none. That is accepted
 *   and announced, and the `note` is required precisely so the emptiness is a decision somebody wrote
 *   down rather than a field that got left out.
 * - **present and malformed** — refused, naming what is wrong and where.
 *
 * The block is **optional for the manifest's own validation** (an older plan of record stays valid for
 * every other stage, and `discover` is not forced to re-run for a series that is not running the voice
 * stage) and **required by the voice stage**. That asymmetry is deliberate and is the reason the
 * manifest schema did not move.
 *
 * @module utils/reference-store/register/declaration
 */

const fs = require("fs");
const path = require("path");
require("../../../types"); // JSDoc type definitions

/** The plan-of-record file name. Same file `paths.js` reads its volume list out of. */
const PLAN_OF_RECORD_FILE_NAME = "translation-target.json";

/** The manifest key the declaration lives under, beside seriesName / sourceLanguage / volumes. */
const REGISTER_MANIFEST_KEY = "register";

/**
 * An axis id is a slug: lowercase, digits, single hyphens between word pieces, no leading or trailing
 * hyphen. A slug is what makes "is this axis already declared?" a string comparison instead of a
 * fuzzy match, and what stops `Formality`, `formality ` and `FORMALITY` being three axes.
 */
const AXIS_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const AXIS_ID_MIN_CHARS = 2;
const AXIS_ID_MAX_CHARS = 40;

/** The fields one axis may name. Anything else is a malformed block, named as such. */
const AXIS_FIELDS = ["id", "asks", "values", "guidance", "scope", "renders", "evidence"];

/** The fields an axis must name. */
const AXIS_REQUIRED_FIELDS = ["id", "asks", "values"];

/** The fields the declaration block itself may name. */
const DECLARATION_FIELDS = ["axes", "note"];

/**
 * The two answers `scope` accepts, and they are SHAPE answers, not language answers: either a register
 * fact belongs to a character, or it belongs to a (character, addressee) pair — the difference between
 * "how she speaks" and "how she speaks to her superior". Plan §4.2 and §10.6.
 */
const AXIS_SCOPES = ["character", "character-addressee"];

/**
 * The four states a declaration can be in. `absent` and `empty` are the pair the plan insists on;
 * `malformed` is a block that is present but cannot be trusted, and `declared` is the normal one.
 *
 * @type {string[]}
 */
const DECLARATION_STATES = ["declared", "empty", "absent", "malformed"];

/**
 * One trimmed string, or null when the value is not a usable string.
 *
 * @param {*} value
 * @returns {string|null}
 */
function trimmedString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The guards over one axis.
 *
 * @param {Object} axis - The axis as written.
 * @param {string} where - Where it came from, for the message ("register.axes[2]").
 * @param {Array<string>} ids - The ids already declared by earlier axes in the same series.
 * @returns {string[]} One problem per thing that is wrong, each naming `where`.
 */
function registerAxisProblems(axis, where, ids) {
  const problems = [];
  if (!axis || typeof axis !== "object" || Array.isArray(axis)) {
    problems.push(`${where} is not an object — an axis is {id, asks, values, …}.`);
    return problems;
  }

  const unknown = Object.keys(axis).filter((key) => !AXIS_FIELDS.includes(key));
  if (unknown.length > 0) {
    problems.push(
      `${where} names ${unknown.map((k) => `"${k}"`).join(", ")}, which this shape does not have. ` +
        `An axis is: ${AXIS_FIELDS.join(", ")} (only ${AXIS_REQUIRED_FIELDS.join(", ")} are required).`
    );
  }

  const id = trimmedString(axis.id);
  if (id === null) {
    problems.push(`${where} is missing a non-empty string "id".`);
  } else {
    if (id.length < AXIS_ID_MIN_CHARS || id.length > AXIS_ID_MAX_CHARS) {
      problems.push(
        `${where} "id" ${JSON.stringify(id)} is ${id.length} character(s); an axis id is ` +
          `${AXIS_ID_MIN_CHARS}-${AXIS_ID_MAX_CHARS}.`
      );
    }
    if (!AXIS_ID_PATTERN.test(id)) {
      problems.push(
        `${where} "id" ${JSON.stringify(id)} is not a slug: lowercase letters and digits, with single ` +
        `hyphens between word pieces (e.g. "address-form"). No spaces, no capitals, no punctuation.`
      );
    }
    if (ids.includes(id)) {
      problems.push(
        `${where} declares the axis id "${id}" again — an axis id is unique within a series, because a ` +
        `claim answers an axis by its id and two axes with one name is a question with two answers.`
      );
    }
  }

  if (trimmedString(axis.asks) === null) {
    problems.push(
      `${where} is missing a non-empty string "asks" — the question this axis asks, in plain language, ` +
      `answerable from the book.`
    );
  }

  if (!Array.isArray(axis.values)) {
    problems.push(`${where} "values" must be an array of the forms this book prints.`);
  } else if (axis.values.length === 0) {
    problems.push(
      `${where} "values" is empty. An axis with no accepted answers asks a question nothing can answer; ` +
      `declare the forms the book shows, or do not declare the axis.`
    );
  } else {
    const seen = new Set();
    axis.values.forEach((value, i) => {
      const trimmed = trimmedString(value);
      if (trimmed === null) {
        problems.push(`${where} "values"[${i}] is ${JSON.stringify(value)} — every value is a non-empty string.`);
        return;
      }
      if (seen.has(trimmed)) {
        problems.push(`${where} "values" lists ${JSON.stringify(trimmed)} twice — a value set is a set.`);
        return;
      }
      seen.add(trimmed);
    });
  }

  if (axis.guidance !== undefined && trimmedString(axis.guidance) === null) {
    problems.push(`${where} "guidance" must be a non-empty string when it is present.`);
  }

  if (axis.scope !== undefined) {
    const scope = trimmedString(axis.scope);
    if (scope === null || !AXIS_SCOPES.includes(scope)) {
      problems.push(
        `${where} "scope" is ${JSON.stringify(axis.scope)} — it is one of: ${AXIS_SCOPES.join(", ")}.`
      );
    }
  }

  if (axis.renders !== undefined) {
    if (!axis.renders || typeof axis.renders !== "object" || Array.isArray(axis.renders)) {
      problems.push(`${where} "renders" must be an object mapping each declared value to how the translation renders it.`);
    } else {
      const declared = new Set(
        Array.isArray(axis.values) ? axis.values.map((v) => (typeof v === "string" ? v.trim() : v)) : []
      );
      for (const [value, rendering] of Object.entries(axis.renders)) {
        if (!declared.has(value)) {
          problems.push(
            `${where} "renders" decides ${JSON.stringify(value)}, which its own "values" does not declare — ` +
            `a decision about an undeclared answer is a decision about nothing.`
          );
        }
        if (trimmedString(rendering) === null) {
          problems.push(`${where} "renders"${JSON.stringify(value)} must be a non-empty string.`);
        }
      }
    }
  }

  if (axis.evidence !== undefined) {
    if (!Array.isArray(axis.evidence) || axis.evidence.length === 0) {
      problems.push(`${where} "evidence" must be a non-empty array of the places in the book the intake saw this axis.`);
    } else {
      axis.evidence.forEach((item, i) => {
        if (trimmedString(item) === null) {
          problems.push(`${where} "evidence"[${i}] is ${JSON.stringify(item)} — each entry is a non-empty string.`);
        }
      });
    }
  }

  return problems;
}

/**
 * The guards over a whole declaration block.
 *
 * @param {*} block - The value of `manifest.register`, as written.
 * @param {string} [where] - The prefix every problem names.
 * @returns {string[]} One problem per thing that is wrong; empty when the block is well formed.
 */
function registerDeclarationProblems(block, where = `manifest "${REGISTER_MANIFEST_KEY}"`) {
  if (block === undefined) return [];
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return [
      `${where} is ${Array.isArray(block) ? "an array" : JSON.stringify(block)} — it is an object: ` +
      `{ axes: [ … ], note: "…" }.`,
    ];
  }

  const problems = [];
  const unknown = Object.keys(block).filter((key) => !DECLARATION_FIELDS.includes(key));
  if (unknown.length > 0) {
    problems.push(`${where} names ${unknown.map((k) => `"${k}"`).join(", ")}, which this shape does not have.`);
  }

  if (!Array.isArray(block.axes)) {
    problems.push(
      `${where}.axes is ${block.axes === undefined ? "absent" : "not an array"} — a declaration states its ` +
      `axes, and a series that needs none writes an empty list with a "note" saying why.`
    );
    return problems;
  }

  const ids = [];
  block.axes.forEach((axis, i) => {
    const axisProblems = registerAxisProblems(axis, `${where}.axes[${i}]`, ids);
    problems.push(...axisProblems);
    const id = axis && typeof axis.id === "string" ? axis.id.trim() : null;
    if (id) ids.push(id);
  });

  if (block.axes.length === 0 && trimmedString(block.note) === null) {
    problems.push(
      `${where}.axes is empty and ${where}.note is missing. Declaring no register questions is a decision ` +
      `a book can legitimately make — so say why in "note" (what this series does not turn on), or ` +
      `declare the axis it does.`
    );
  }
  if (block.note !== undefined && trimmedString(block.note) === null && block.axes.length > 0) {
    problems.push(`${where}.note must be a non-empty string when it is present.`);
  }

  return problems;
}

/**
 * Refuse a malformed declaration, naming the first thing that is wrong.
 *
 * This is the door `intake/validate.js` calls: the plan of record is refused before any volume is
 * processed, and the intake agent gets the sentence back as its correction turn.
 *
 * @param {*} block - The value of `manifest.register`.
 * @param {string} [where]
 * @returns {void}
 * @throws {Error} On the first problem.
 */
function validateRegisterDeclaration(block, where = `manifest "${REGISTER_MANIFEST_KEY}"`) {
  const problems = registerDeclarationProblems(block, where);
  if (problems.length > 0) {
    throw new Error(
      `${problems.length} problem(s) in the series' register declaration:\n  ${problems.join("\n  ")}`
    );
  }
}

/**
 * What a declaration block *is*, as one of the four states — the distinction the plan insists on.
 *
 * @param {*} block - The value of `manifest.register` (absent allowed).
 * @returns {{state: string, axes: Array<Object>, note: string|null, problems: string[]}}
 */
function describeRegisterDeclaration(block) {
  if (block === undefined) {
    return { state: "absent", axes: [], note: null, problems: [] };
  }
  const problems = registerDeclarationProblems(block);
  if (problems.length > 0) {
    return { state: "malformed", axes: [], note: null, problems };
  }
  const axes = block.axes.map((axis) => ({
    id: axis.id.trim(),
    asks: axis.asks.trim(),
    values: axis.values.map((value) => value.trim()),
    guidance: trimmedString(axis.guidance),
    scope: trimmedString(axis.scope) || "character",
    renders: axis.renders && typeof axis.renders === "object" ? axis.renders : null,
    evidence: Array.isArray(axis.evidence) ? axis.evidence.map((e) => e.trim()) : null,
  }));
  const note = trimmedString(block.note);
  if (axes.length === 0) return { state: "empty", axes, note, problems: [] };
  return { state: "declared", axes, note, problems: [] };
}

/**
 * Read the declaration out of a series' plan of record.
 *
 * Read fresh at call time, like every other path in this layer (gotchas 79 and 94): the plan is
 * rewritten by `discover`, and a declaration remembered from an earlier read is a declaration that may
 * no longer be the one the series has.
 *
 * Never throws. A series with no readable plan is `absent`, with the reason in `note` — the caller
 * that has to refuse says so, and says what it could not read.
 *
 * @param {string} seriesDir - Absolute series folder.
 * @returns {{state: string, axes: Array<Object>, note: string|null, problems: string[], file: string}}
 */
function readRegisterDeclaration(seriesDir) {
  const file = path.join(String(seriesDir || ""), PLAN_OF_RECORD_FILE_NAME);
  let raw = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "absent", axes: [], note: `no plan of record at ${file}`, problems: [], file };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { state: "absent", axes: [], note: `the plan of record at ${file} does not parse`, problems: [], file };
  }
  const described = describeRegisterDeclaration(
    manifest && typeof manifest === "object" ? manifest[REGISTER_MANIFEST_KEY] : undefined
  );
  if (described.state === "absent") described.note = `the plan of record at ${file} has no "${REGISTER_MANIFEST_KEY}" block`;
  return { ...described, file };
}

/**
 * The ids a declaration asks about — used by the filing gate's refusal text and by anything that
 * reports which questions a series asked.
 *
 * @param {{state: string, axes: Array<Object>}} declaration
 * @returns {string[]}
 */
function declaredAxisIds(declaration) {
  return (declaration && declaration.axes ? declaration.axes : []).map((axis) => axis.id);
}

/**
 * The sentence the character-voice stage refuses with when the series it was pointed at has no
 * declaration. It names the door, because the door is the only way to fix it and the account owner has
 * not authorised re-running the intake.
 *
 * @param {{state: string, problems: string[], note: string|null, file?: string}} declaration
 * @param {string} [stageName]
 * @returns {string}
 */
function registerDeclarationRefusalText(declaration, stageName = "character-voice") {
  const file = declaration.file || PLAN_OF_RECORD_FILE_NAME;
  if (declaration.state === "malformed") {
    return (
      `the ${stageName} stage cannot run: this series' register declaration is present but malformed ` +
      `(${file}):\n  ${declaration.problems.join("\n  ")}\n` +
      `Fix the block, or run the intake again (npx gulp discover --force) so the declaration is written ` +
      `from the book.`
    );
  }
  return (
    `the ${stageName} stage cannot run: this series has no register declaration (${file} has no ` +
    `"${REGISTER_MANIFEST_KEY}" block). The register questions this stage asks are declared per series, ` +
    `by the intake, from the book — there is no default list in the pipeline to fall back on, in any ` +
    `language, and inventing one is the defect this design exists to remove.\n` +
    `Fix: run the intake (npx gulp discover --force). A book that genuinely needs no register questions ` +
    `declares it: { "${REGISTER_MANIFEST_KEY}": { "axes": [], "note": "why this series needs none" } }.`
  );
}

module.exports = {
  PLAN_OF_RECORD_FILE_NAME,
  REGISTER_MANIFEST_KEY,
  AXIS_ID_PATTERN,
  AXIS_ID_MIN_CHARS,
  AXIS_ID_MAX_CHARS,
  AXIS_FIELDS,
  AXIS_REQUIRED_FIELDS,
  AXIS_SCOPES,
  DECLARATION_FIELDS,
  DECLARATION_STATES,
  registerAxisProblems,
  registerDeclarationProblems,
  validateRegisterDeclaration,
  describeRegisterDeclaration,
  readRegisterDeclaration,
  declaredAxisIds,
  registerDeclarationRefusalText,
};

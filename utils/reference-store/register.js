/**
 * utils/reference-store/register.js — the barrel for the register layer (plan 06 slice 3).
 *
 * Two concerns, two files, one public surface, in the shape AGENTS.md §3 requires:
 *
 *   - `register/declaration.js` — the **shape** of a per-series register declaration and the guards that
 *     decide whether a series wrote one. It holds no axis list and no language list, in any language;
 *     that absence is the owner's rule and `test/test-no-language-axis-list.js` is the guard that keeps
 *     it true.
 *   - `register/filing.js` — the gate a claim passes when it names an axis: the axis must be one this
 *     series declared, and the value must be one of the values this series declared for it.
 *
 * The layer is a **guard** layer: it lives inside `utils/reference-store/`, which is already a banned
 * patch path for the dev team, and the two files it is cut into stay inside that folder.
 *
 * @module utils/reference-store/register
 */

const declaration = require("./register/declaration");
const filing = require("./register/filing");

module.exports = {
  // The declaration: its shape, its guards, and how it is read off the plan of record.
  PLAN_OF_RECORD_FILE_NAME: declaration.PLAN_OF_RECORD_FILE_NAME,
  REGISTER_MANIFEST_KEY: declaration.REGISTER_MANIFEST_KEY,
  AXIS_ID_PATTERN: declaration.AXIS_ID_PATTERN,
  AXIS_ID_MIN_CHARS: declaration.AXIS_ID_MIN_CHARS,
  AXIS_ID_MAX_CHARS: declaration.AXIS_ID_MAX_CHARS,
  AXIS_FIELDS: declaration.AXIS_FIELDS,
  AXIS_REQUIRED_FIELDS: declaration.AXIS_REQUIRED_FIELDS,
  AXIS_SCOPES: declaration.AXIS_SCOPES,
  DECLARATION_FIELDS: declaration.DECLARATION_FIELDS,
  DECLARATION_STATES: declaration.DECLARATION_STATES,
  registerAxisProblems: declaration.registerAxisProblems,
  registerDeclarationProblems: declaration.registerDeclarationProblems,
  validateRegisterDeclaration: declaration.validateRegisterDeclaration,
  describeRegisterDeclaration: declaration.describeRegisterDeclaration,
  readRegisterDeclaration: declaration.readRegisterDeclaration,
  declaredAxisIds: declaration.declaredAxisIds,
  registerDeclarationRefusalText: declaration.registerDeclarationRefusalText,

  // The filing gate: the rules it can refuse on, and the refusal itself.
  REGISTER_GATE_RULES: filing.REGISTER_GATE_RULES,
  namedAxisOfProposal: filing.namedAxisOfProposal,
  registerFilingRefusal: filing.registerFilingRefusal,
};

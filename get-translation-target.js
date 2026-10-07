/**
 * get-translation-target.js — series intake (step 0 of the pipeline).
 *
 * The old behaviour was 'every volume is a folder named <Series Name>(NN) containing
 * one text file'. That is replaced by an agent handed only SERIES_LOCATION, which
 * works the rest out by looking at the files: which files are volumes, in what reading
 * order, which are excluded (art books, previews, duplicates, side stories), the
 * series name, the source language, and the folder name for each volume. It stages
 * each book into the folder it named and writes the plan of record
 * (translation-target.json) plus the human-readable translation-plan.md.
 *
 * A wrong reading order poisons every cumulative artifact, so an unsure plan STOPS the
 * run rather than quietly producing 17 wrong glossaries: the confidence gate is
 * fail-closed (a plan that reports no confidence at all is rejected, because a gate a
 * model can pass by saying nothing is not a gate), every volume must state its own
 * integrity judgment, and the objective 'is this a book?' cross-check does not trust
 * that judgment.
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./intake/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

require("dotenv").config();
require("./types"); // JSDoc type definitions
const {
  extractJsonObject,
  installmentNumberFromDir,
  normalizeInstallmentNumber,
  sanitizeFolderName,
  filterVolumesByInstallment,
} = require("./utils/manifest");
const { emittedToolCallAsText, assertRealToolCalls } = require("./utils/agents");

const __config = require("./intake/config");
const __committed = require("./intake/committed");
const __integrity = require("./intake/integrity");
const __validate = require("./intake/validate");
const __deterministic = require("./intake/deterministic");
const __prompts = require("./intake/prompts");
const __agent = require("./intake/agent");
const __task = require("./intake/task");

module.exports = {
  ...__config,
  ...__committed,
  ...__integrity,
  ...__validate,
  ...__deterministic,
  ...__prompts,
  ...__agent,
  ...__task,
  extractJsonObject,
  emittedToolCallAsText,
  extractJsonObject: require("./utils/manifest").extractJsonObject,
};

const { getTranslationTarget } = __task;

// ─── Ad-hoc CLI ─────────────────────────────────────────────────────────────
// node get-translation-target.js          # reuse a valid manifest, else intake
// node get-translation-target.js --force  # always re-run the intake agent
// The manifest is printed to stdout (progress logs go to stderr via the harness
// run log, so stdout stays clean).

if (require.main === module) {
  const force = process.argv.includes("--force");
  getTranslationTarget({ forceIntake: force })
    .then((manifest) => {
      console.log(JSON.stringify(manifest, null, 2));
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

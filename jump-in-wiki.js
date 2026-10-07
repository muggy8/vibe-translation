/**
 * jump-in-wiki.js — the wiki task, plus the shared helpers the other volume tasks
 * borrow.
 *
 * Per volume it builds `wiki.md` (this volume's plot beats) and `shared-wiki.md` (the
 * cumulative "series state through this volume"), each on top of the PREVIOUS volume's
 * copies — looked up in the manifest's reading order, never by N-1 folder arithmetic. A
 * missing or stub previous wiki is governed by ON_MISSING_PREVIOUS like the other
 * cumulative tasks.
 *
 * Two things here are easy to get wrong. The series-root copy walks the volume list
 * backwards and publishes the last REAL, PUBLISHABLE snapshot: a plain fileExists() check
 * accepts the scaffold stub the workflow pre-creates before the author turn, which is how
 * a run whose last volume failed at generation published "(stub — the merge pass replaces
 * this…)" as the series' living shared-wiki.md, and the consistency audit then audited it
 * (gotcha 50). And the translation stage reads the PER-VOLUME shared-wiki.md, not the
 * series-root one, which would leak later-volume spoilers.
 *
 * After the volume is settled — processed OR skipped — the deterministic translation
 * handoff (chapters.json + translation-brief.md) is written best-effort: a handoff failure
 * warns, it never fails a volume.
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./jump-in-wiki/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

// .env, then the one setting that has a default — both before any task module is
// required, because several of them read these values at require time (gotcha 79).
require("./configs/env-defaults").bootstrapEnv();
require("./types"); // JSDoc type definitions
const { emittedToolCallAsText, assertRealToolCalls } = require("./utils/agents");
const {
  transformUserPrompt,
  isPassingVerdict,
  parseAcceptanceScore,
  validatorMaxStepsFor,
  writePromptDump,
} = require("./utils/prompt");
const { installmentNumberFromDir } = require("./utils/manifest");

const __config = require("./jump-in-wiki/config");
const __prompts = require("./jump-in-wiki/prompts");
const __whole = require("./jump-in-wiki/whole");
const __chunked = require("./jump-in-wiki/chunked");
const __task = require("./jump-in-wiki/task");
const __acceptance = require("./jump-in-wiki/acceptance");

module.exports = {
  ...__config,
  ...__prompts,
  ...__whole,
  ...__chunked,
  ...__task,
  ...__acceptance,
  emittedToolCallAsText,
  assertRealToolCalls,
  transformUserPrompt,
  isPassingVerdict,
  parseAcceptanceScore,
  validatorMaxStepsFor,
  writePromptDump,
  installmentNumberFromDir,
};

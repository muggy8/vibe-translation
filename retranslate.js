/**
 * retranslate.js — the "retranslate" gulp task: the correction pass of the translation pipeline.
 *
 * Task: retranslate
 *   For each volume, for each chapter whose verification (the translation-verification.json sidecar
 *   written by verify-translate) says FAIL (or the score was unparseable) AND the entry still covers
 *   the current source + draft:
 *     1. Skip it when the state file already shows a retranslate run for the SAME findings
 *        (retranslated=true + matching findingsHash) — idempotency; --force re-runs.
 *     2. Re-translate the chapter with Index-Translate (translate endpoint, no system prompt, the
 *        model's own greedy decoding, fast non-thinking mode) — the verification FINDINGS are injected
 *        as a numbered 【硬性要求】 "fix these problems" constraint in the instTrans prompt. The bad
 *        draft is deliberately NOT fed back (re-reading
 *        a bad translation anchors the model to its errors). Like the translate stage, oversized
 *        chapters are split and retranslated part by part, each part continuing the previous one.
 *     3. Deterministic QA (hard failures fail the chapter before writing).
 *     4. Overwrite the draft, update the state (draftHash, retranslated, findingsHash; the polish pass
 *        is invalidated), and re-merge the volume's translation.md.
 *
 * The pipeline then re-runs verify-translate: the retranslated draft gets a fresh score (the sidecar
 * entry was keyed to the old draft, so it is re-verified automatically).
 *
 * Usage:
 *   npx gulp retranslate              # run the full task
 *   npx gulp retranslate --dry-run    # dump the prompts only, no AI calls
 *   npx gulp retranslate --force      # re-run even if already retranslated
 *   npx gulp retranslate --volume 01  # single volume
 *
 * This file is the public face of the layer: apart from the declarations noted below it holds no
 * logic, only re-exports. The implementation lives in ./retranslate/ — open the module that owns the
 * behaviour you are changing instead of reading all of them.
 */

// .env, then the one setting that has a default — both before any task module is
// required, because several of them read these values at require time (gotcha 79).
require("./configs/env-defaults").bootstrapEnv();
require("./types"); // JSDoc type definitions

const __config = require("./retranslate/config");
const __tails = require("./retranslate/tails");
const __targeted = require("./retranslate/targeted");
const __chapter = require("./retranslate/chapter");
const __volume = require("./retranslate/volume");
const __task = require("./retranslate/task");

module.exports = {
  ...__config,
  ...__tails,
  ...__targeted,
  ...__chapter,
  ...__volume,
  ...__task,
};

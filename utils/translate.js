/**
 * utils/translate.js — Pure helpers for the translation stage
 * (the translate / verify-translate / retranslate / polish tasks).
 *
 * The translation stage is deliberately NOT agent-based: every stage is a
 * one-shot model call over a single chapter, plus deterministic QA and
 * state-file idempotency. This layer holds the pure logic (chapter splitting,
 * prompt construction, deterministic QA, state load/save, merging, QA-loop
 * stop-decision) so the task modules stay thin and the logic stays unit-testable
 * without the filesystem or the AI (test/test-translate.js).
 *
 * Endpoint roles (see the TRANSLATE_* / VERIFY_* / EDIT_* / AUDIT_* env vars —
 * each names an ENDPOINT, never a model: the stage logic is identical whatever
 * answers, and on local setups the per-machine hooks decide which container
 * serves the port):
 *   - translate / retranslate: the TRANSLATE_* endpoint. The prompt in
 *     translate/prompt.js is the one genuinely model-specific contract in this
 *     stage (the official translation-model single-user-message shape + its
 *     sampling recipe), so swapping this endpoint means swapping that prompt too.
 *   - verify-translate / polish: the VERIFY_* / EDIT_* endpoints
 *     (source-anchored checking and final polish — they read the source).
 *   - the cross-checks (verify tiebreak + polish final audit): the AUDIT_*
 *     endpoint, deliberately a DIFFERENT endpoint from the one that produced
 *     the text being graded.
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./translate/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

const __internal = require("./translate/internal");
const __split = require("./translate/split");
const __terminology = require("./translate/terminology");
const __prompt = require("./translate/prompt");
const __qa = require("./translate/qa");
const __merge = require("./translate/merge");
const __variants = require("./translate/variants");
const __state = require("./translate/state");
const __loop = require("./translate/loop");
const __stage = require("./translate/stage");
const __progress = require("./translate/progress");
const __consistency = require("./translate/consistency");
const __repair = require("./translate/repair");
const __references = require("./translate/references");

module.exports = {
  ...__internal,
  ...__split,
  ...__terminology,
  ...__prompt,
  ...__qa,
  ...__merge,
  ...__variants,
  ...__state,
  ...__loop,
  ...__stage,
  ...__progress,
  ...__consistency,
  ...__repair,
  ...__references,
};

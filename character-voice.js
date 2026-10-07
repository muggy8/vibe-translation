/**
 * character-voice.js — the character voice reference task.
 *
 * Per volume it extracts speech quirks and POV analysis, then compiles two files: the
 * CUMULATIVE character-voice.md (every character entry from every previous volume,
 * amended in place with editFile) and the PER-VOLUME pov-map.md (written whole, because
 * it describes only this volume — which is also why the seed deliberately does not copy
 * it).
 *
 * This is the stage where both QA-loop rules were measured (AGENTS.md gotcha 65): volume
 * 01's feedback turn made 46 tool calls — 29 reads, 15 searches, ZERO writes — spent
 * 2.63M tokens, and ended at a flat maxSteps: 30 while it was still verifying findings,
 * because the one write it had been told to do was the LAST thing in its instructions.
 * Nothing detected it: both files existed and were real, so the loop recorded the turn as
 * a normal iteration and paid 8.4M tokens to re-audit an unchanged document. The caps are
 * now scaled, the feedback prompt batches its checks and patches HIGH to LOW, and the
 * shared loop fingerprints the artifacts around a feedback pass.
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./character-voice/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

require("dotenv").config();
require("./types");
const { emittedToolCallAsText, assertRealToolCalls } = require("./utils/agents");

const __config = require("./character-voice/config");
const __carry_forward = require("./character-voice/carry-forward");
const __reference_index = require("./character-voice/reference-index");
const __prompts = require("./character-voice/prompts");
const __amend = require("./character-voice/amend");
const __stages = require("./character-voice/stages");
const __qa = require("./character-voice/qa");
const __chunked = require("./character-voice/chunked");
const __task = require("./character-voice/task");

module.exports = {
  ...__config,
  ...__carry_forward,
  ...__reference_index,
  ...__prompts,
  ...__amend,
  ...__stages,
  ...__qa,
  ...__chunked,
  ...__task,
  emittedToolCallAsText,
};

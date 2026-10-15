/**
 * character-voice.js — the character voice reference task.
 *
 * One route, no selector. The stage reads the volume chapter by chapter
 * (`character-voice/reading.js`), files what it found in the volume's reference record, and **renders**
 * both artifacts from that record: the CUMULATIVE `character-voice.md` and the CUMULATIVE `pov-map.md`,
 * organised by chapter and carrying every earlier volume's sealed point-of-view claims. No author agent,
 * no feedback pass, one acceptance grade. `--route=` is refused, not ignored — the route it selected is
 * gone, and it is in git history at commit 75e59a7 if it is ever needed again.
 *
 * The acceptance gate is unchanged from the two-route era: the same rubric, the same three files handed
 * to the grader, the same quarantine-on-failure, the same draft-record consequence. A route was a
 * choice; the gate never was.
 *
 * This is the stage where both QA-loop rules were measured (AGENTS.md gotcha 65): volume 01's feedback
 * turn made 46 tool calls — 29 reads, 15 searches, ZERO writes — spent 2.63M tokens, and ended at a flat
 * maxSteps: 30 while it was still verifying findings, because the one write it had been told to do was
 * the LAST thing in its instructions. Nothing detected it: both files existed and were real, so the loop
 * recorded the turn as a normal iteration and paid 8.4M tokens to re-audit an unchanged document. The
 * fingerprint-the-artifacts-around-a-feedback-pass check that failure produced is still in the shared
 * loop, and it is what the other three stages' gates run.
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./character-voice/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

// .env, then the one setting that has a default — both before any task module is
// required, because several of them read these values at require time (gotcha 79).
require("./configs/env-defaults").bootstrapEnv();
require("./types");
const { emittedToolCallAsText } = require("./utils/agents");

const __config = require("./character-voice/config");
const __carry_forward = require("./character-voice/carry-forward");
const __reference_index = require("./character-voice/reference-index");
const __prompts = require("./character-voice/prompts");
const __known_facts = require("./character-voice/known-facts");
const __stages = require("./character-voice/stages");
const __qa = require("./character-voice/qa");
const __task = require("./character-voice/task");

module.exports = {
  ...__config,
  ...__carry_forward,
  ...__reference_index,
  ...__prompts,
  ...__known_facts,
  ...__stages,
  ...__qa,
  ...__task,
  emittedToolCallAsText,
};

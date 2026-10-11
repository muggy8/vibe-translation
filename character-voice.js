/**
 * character-voice.js — the character voice reference task.
 *
 * A volume is built on one of two routes, chosen by `--route=` and defaulting to `assemble`.
 *
 * `--route=assemble` (the default) reads the volume chapter by chapter, files what it found in the
 * volume's reference record, and **renders** both artifacts from that record: the CUMULATIVE
 * `character-voice.md` and `pov-map.md`, organised by chapter and carrying every earlier volume's
 * sealed point-of-view claims. No author agent, no feedback pass, one acceptance grade.
 *
 * `--route=author` is the older flow: extract, then an author agent compiles the CUMULATIVE
 * `character-voice.md` (amended in place with `editFile`) and writes the PER-VOLUME `pov-map.md`
 * whole — which is why the seed deliberately does not copy that one file. The whole-installment /
 * chapter-by-chapter mode decision belongs to this route.
 *
 * The acceptance gate runs on both routes; a route is a choice, the gate is not. The two routes now
 * produce a file with the same name and a different contract, and that divergence is unresolved —
 * see `character-voice/amend.js`, `character-voice/carry-forward.js` and gotcha 109.
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

// .env, then the one setting that has a default — both before any task module is
// required, because several of them read these values at require time (gotcha 79).
require("./configs/env-defaults").bootstrapEnv();
require("./types");
const { emittedToolCallAsText } = require("./utils/agents");

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

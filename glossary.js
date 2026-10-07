/**
 * glossary.js — the glossary task (Pipeline A): the cumulative target-language
 * glossary every later volume and every translator reads as terminology law.
 *
 * Per volume, in order — each volume's glossary is built on the previous one's:
 * extract new terms -> research them -> AMEND the carried-forward file -> QA loop ->
 * deterministic coverage audit. After all volumes the last real snapshot is copied
 * to the series artifacts directory.
 *
 * The cumulative-document rules (AGENTS.md gotcha 64 / 65 / 68) live here and are
 * the reason the stage is shaped the way it is:
 *   - the workflow COPIES the previous volume's glossary in before any agent runs
 *     ("carry forward every existing term" was never a job for a model; it is a
 *     file copy, and a re-run resets a half-written file to the clean baseline);
 *   - the agent is given a term -> rendering MAP and amends the file in place with
 *     editFile; the whole-file writeFile is forbidden from volume 02 on, because a
 *     cumulative glossary outgrows one reply and a model asked to reproduce it
 *     destroys the part it could not reach (457 terms vanished that way);
 *   - a deterministic no-AI gate checks the invariant, and it compares entries at
 *     SPELLING resolution so a widened row, a split row and a rename all count as
 *     carried forward — a guard that calls an improvement a loss quietly destroys
 *     the work the pipeline paid for.
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./glossary/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

// .env, then the one setting that has a default — both before any task module is
// required, because several of them read these values at require time (gotcha 79).
require("./configs/env-defaults").bootstrapEnv();
require("./types"); // JSDoc type definitions
const { emittedToolCallAsText, assertRealToolCalls } = require("./utils/agents");

const __config = require("./glossary/config");
const __extract = require("./glossary/extract");
const __notes = require("./glossary/notes");
const __research = require("./glossary/research");
const __prompts = require("./glossary/prompts");
const __carry_forward = require("./glossary/carry-forward");
const __authoring = require("./glossary/authoring");
const __qa = require("./glossary/qa");
const __chunked = require("./glossary/chunked");
const __coverage = require("./glossary/coverage");
const __task = require("./glossary/task");
const __amend = require("./glossary/amend");

module.exports = {
  ...__config,
  ...__extract,
  ...__notes,
  ...__research,
  ...__prompts,
  ...__carry_forward,
  ...__authoring,
  ...__qa,
  ...__chunked,
  ...__coverage,
  ...__task,
  ...__amend,
  emittedToolCallAsText,
  assertRealToolCalls,
};

/**
 * glossary.js — the glossary task (Pipeline A): the cumulative target-language
 * glossary every later volume and every translator reads as terminology law.
 *
 * Per volume, in order — each volume's glossary is built on the previous one's:
 * **read** the volume (one call per chapter-group) and ask for each new term's canonical
 * rendering -> **file** what was found in the volume's reference record -> research the
 * terms -> **render `glossary.md` out of the record** -> the no-AI cumulative gate ->
 * the deterministic audit -> one grade -> seal. After all volumes the last real snapshot
 * is copied to the series artifacts directory.
 *
 * There is no author agent in this stage, and there never was a good reason to pay one:
 * the read pass is the only thing that can decide a rendering, and a model that re-types
 * a document it was handed is the thing that destroyed it. The author route and its
 * feedback pass were removed, not deprecated — the code is in git history at commit
 * `294351c`, and `glossary/plan/01-glossary-route.md` §6 row 2 records what they cost and
 * what the render replaced.
 *
 * The cumulative-document rules (AGENTS.md gotcha 64 / 65 / 68) still live here, in a new
 * shape:
 *   - the carry forward is the **record's**, not a file copy: this volume's record was
 *     copied forward from the previous volume's sealed record, so `renderGlossary` prints
 *     every earlier volume's rows without anything re-typing them;
 *   - the no-AI gate is unchanged, and it still compares entries at SPELLING resolution so
 *     a widened row, a split row and a rename all count as carried forward — a guard that
 *     calls an improvement a loss quietly destroys the work the pipeline paid for;
 *   - what replaced "never rewrite the whole file" is "nothing writes the file at all":
 *     a render is deterministic, so the failure mode a cumulative document used to have
 *     (a reply cut off part-way, and every entry it did not reach is gone from the series)
 *     cannot happen. A render that loses a row is a bug in the record, and the gate says so.
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
const __carry_forward = require("./glossary/carry-forward");
const __qa = require("./glossary/qa");
const __chunked = require("./glossary/chunked");
const __coverage = require("./glossary/coverage");
const __task = require("./glossary/task");
const __store = require("./glossary/store");

module.exports = {
  ...__config,
  ...__extract,
  ...__notes,
  ...__research,
  ...__carry_forward,
  ...__qa,
  ...__chunked,
  ...__coverage,
  ...__task,
  ...__store,
  emittedToolCallAsText,
  assertRealToolCalls,
};

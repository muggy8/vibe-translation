/**
 * utils/prereqs.js — the one table of what must already be finished before a step may start.
 *
 * Why this exists. The account owner's rule is that a run goes **pre-production → translation →
 * polish**, and once it is in translation the reference artifacts are frozen. Until 2026-10-13 the
 * only thing enforcing any of that was a hand-written pair of checks inside `translate`
 * (`checkTranslationPreconditions`): a PASS/FAIL `consistency-report.md` and a per-volume
 * `glossary.md`, both waveable past with a flag. Nothing gated `polish` on `translate`, nothing
 * gated `consistency-audit` on the four artifacts it audits, nothing gated `glossary` on `extract`,
 * and nothing gated anything on `discover`. Measured before this module existed: a fixture series
 * with a PASS audit and a glossary in every volume but **no character-voice, no style-guide and no
 * wiki** was allowed to start `translate`, and with `--allow-fail --allow-no-glossary` it was
 * allowed to start with **no glossary at all**.
 *
 * Three rules this gate keeps.
 *
 *   1. **The order is declared data, in a closed path.** It is not a stage's judgement and there is
 *      no knob on it. `utils/patches/rules.js` bans this module for the dev team for the same reason
 *      it bans the finding level table (AGENTS.md §4 rule 3, gotcha 70): a role that can edit the
 *      rule that stops it is not being stopped.
 *   2. **"Completed" is read off the disk, not remembered by this process.** A prerequisite is
 *      complete when the files that step's own declaration in `utils/artifacts.js` promises are on
 *      disk in the shape that declaration says, and — where the step has an acceptance grade — when
 *      the volume's persisted acceptance state passes. There is no second list of expected files
 *      here on purpose: a second list is a second opinion, and two opinions about one artifact is
 *      how a run ends up calling a volume finished that the post-mortem calls unfinished.
 *   3. **The table does not order the pre-production steps among themselves.** `glossary`,
 *      `character-voice`, `style-guide` and `jump-in-wiki` each require `discover` and `extract` and
 *      nothing else, so any order of those four is legal. Only `consistency-audit` depends on all
 *      four, and only the translation stage depends on the audit. That is the owner's rule, and
 *      `test/test-prerequisite-gate.js` pins it by running three different orders.
 *
 * What a refusal looks like. It names the nearest missing thing and the chain that led there,
 * because a refusal that only says "prerequisite missing" is a refusal nobody can act on:
 *
 *     translate refuses to start: 1 prerequisite is not complete.
 *       - `translate` needs `consistency-audit`, which needs `character-voice`; volume 03 has no
 *         `character-voice.md` (the cumulative character voice reference). Run
 *         `npx gulp character-voice --volume 03` first.
 *
 * The chain is built through the **nearest consumer** of the missing step — the last step in run
 * order that declares it — because that is also the step you have to re-run after you fix it.
 *
 * ## Where the code lives
 *
 * The code is in `utils/prereqs/`, one kind of job per file: `table.js` (the declared table and the
 * questions asked of it — what a step declares, what is reachable below it, which steps consume a step,
 * and the chain a refusal is built through), `scope.js` (which volumes this run is about to judge, and
 * the settings the artifact declarations' `when` predicates are read against), `completion.js` (the
 * folder reads: a volume's `required` artifacts, its acceptance grade, its quarantines, the series root,
 * the run's own records), `gap-wording.js` (the short phrase a file verdict becomes in a refusal) and
 * `verdict.js` (the decision, its bullets, and the structural refusal). This file is the public surface
 * and the only thing another module should require; `STEP_PREREQUISITES` stays inside this folder, so
 * splitting the file moves no table out of the ban (AGENTS.md §3).
 *
 * @module utils/prereqs
 */

// The other half of this gate lives beside it, in the same closed folder: `utils/prereqs/freeze.js`
// answers "may this step REWRITE what a finished translation already consumed?", which is the
// question a start-gate cannot ask. `readVolumesInScope` is exported for it so the `--volume`
// narrowing is one rule and not two.

const table = require("./prereqs/table");
const scope = require("./prereqs/scope");
const gapWording = require("./prereqs/gap-wording");
const completion = require("./prereqs/completion");
const verdict = require("./prereqs/verdict");

// The public surface, unchanged from the single file.
module.exports = {
  STEP_PREREQUISITES: table.STEP_PREREQUISITES,
  declaredPrerequisiteSteps: table.declaredPrerequisiteSteps,
  prerequisitesFor: table.prerequisitesFor,
  transitivePrerequisites: table.transitivePrerequisites,
  consumersOf: table.consumersOf,
  prerequisiteChain: table.prerequisiteChain,
  gateContext: scope.gateContext,
  readVolumesInScope: scope.readVolumesInScope,
  quarantineBlocksCompletion: completion.quarantineBlocksCompletion,
  stepGaps: completion.stepGaps,
  evaluatePrerequisites: verdict.evaluatePrerequisites,
  prerequisiteRefusal: verdict.prerequisiteRefusal,
};

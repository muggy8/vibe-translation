/**
 * utils/devteam.js — the dev team: the role that may change the code, and the reason it is the last
 * role in this pipeline rather than the first.
 *
 * The delivery manager (delivery.js, utils/resume.js) runs the pipeline and may re-run steps, but it
 * never sees the code. The diagnostics team (utils/diagnostics.js) may read everything and change
 * nothing. This is the third role: the one that writes. It exists only because the manager chose an
 * option the diagnostics team offered and that option said `requiresCodeChange` — so a code change is
 * never requested by describing a fix, only by choosing an offered option (plan §9).
 *
 * The analogy the account owner chose (2026-10-05): the manager is a SaaS **client** with a support
 * contract; diagnostics and this team are the **provider**. A provider fixes its own software, tells
 * the client what it changed and what it might break, and asks clarifying questions back — and the
 * client's whole authority is to accept or refuse.
 *
 * Four rules make that survivable, and all four are enforced in code:
 *
 *   1. **A patch may not edit the rules that judge it.** `BANNED_PATCH_PATHS` (utils/patches.js) is
 *      enforced twice: the file tools refuse the write during the turn, and `recordProposal` refuses
 *      the proposal afterwards. The cheapest way to make a finding disappear is now a line of code
 *      rather than a setting, so the constraint-table modules, their tests, `hooks/`, `.env`, the
 *      machine state and the corpus are off the menu — each refusal naming the account owner.
 *   2. **A patch shows its changes.** The working tree inside `ai-client/` is fingerprinted before the
 *      turn and again after it. A file that changed without being named in the proposal is a
 *      **refusal**, not a note: an unreviewed edit is the thing the manager cannot judge. A file named
 *      that did not change is a warning (gotcha 74's two-directional honesty).
 *   3. **The tests are run by the CLI, not claimed by the team.** The harness gives an agent no shell
 *      tool, so a prompt that said "run the tests" would be a prompt asking for the impossible — and
 *      a proposal that said "I ran them" would be unverifiable. `REQUIRED_CHECKS` is executed by
 *      `fix.js` through `patches.runChecks`, and a proposal cannot be accepted while one is missing
 *      or failed.
 *   4. **The team proposes; it does not deliver.** The turn ends as a proposal the manager reads
 *      without a diff. The commit to `main` is the acceptance act, it happens only after the manager
 *      accepts, and it stages exactly the files the proposal declared (`git add -A` is never used in
 *      this repository: the tree outside `ai-client/` is the account owner's in-progress translation).
 *
 * Where the work happens: the working tree of `main`, uncommitted, while the manager judges it. That
 * is the dangerous part of this design and it is worth saying out loud — the working tree IS what
 * `npm run pipeline` executes (gotcha 66), which is why `pendingPatches()` gates act mode, why only
 * one team works at a time, and why a patch may not land while a run is in progress.
 *
 * Cost (plan §9): one model call per patch, and the turn is UNCAPPED — it keeps its own working window
 * by setting its old read answers aside on disk (see the note below `DELETION_REFUSAL`, and
 * `utils/context.js`). What bounds it is the repetition detector and the turn clock, not a step count:
 * this role reads code before it writes it, and a step count is exactly what threw away a paid-for
 * dev turn mid-edit (gotcha 64/65).
 *
 * The code lives in utils/devteam/: brief.js (what the role is told, and the file that tells
 * it), tools.js (the gated file tools and the record of every write the gate stopped),
 * proposal.js (the one shape the reply must have), briefing.js (the ticket as the team reads
 * it, and the footprint of evidence), work.js (the whole exchange), checks.js (the machine's
 * verdict on a patch). This file is the public surface.
 */
"use strict";

const path = require("path");

const brief = require("./devteam/brief");
const tools = require("./devteam/tools");
const proposal = require("./devteam/proposal");
const briefing = require("./devteam/briefing");
const work = require("./devteam/work");
const checks = require("./devteam/checks");

const ROOT = path.join(__dirname, "..");

// The public surface, unchanged from the single file.
module.exports = {
  ROOT,
  DEVTEAM_TOOLS_NOTE: brief.DEVTEAM_TOOLS_NOTE,
  DELETION_REFUSAL: brief.DELETION_REFUSAL,
  loadSystemPrompt: brief.loadSystemPrompt,
  patchFsTools: tools.patchFsTools,
  collectPatchWriteAttempts: tools.collectPatchWriteAttempts,
  PROPOSAL_ANSWER_TOOL: tools.PROPOSAL_ANSWER_TOOL,
  proposalAnswerTool: tools.proposalAnswerTool,
  parseProposalReply: proposal.parseProposalReply,
  renderTicketForDev: briefing.renderTicketForDev,
  evidenceFootprint: briefing.evidenceFootprint,
  workTicket: work.workTicket,
  verifyPatch: checks.verifyPatch,
  describePatch: checks.describePatch,
};

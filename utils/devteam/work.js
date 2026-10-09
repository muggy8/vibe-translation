/**
 * utils/devteam/work.js — the whole exchange with the dev team, start to finish.
 *
 * Open the gated tools, brief the agent, run the turn inside the hooks, parse the proposal, record what
 * the gate stopped, diff what actually changed against what was claimed, and write the patch record.
 * The role fires its own hooks around its own model turn: `fix.js` cannot know it is about to reach
 * the model without repeating every refusal `workTicket` makes, and a switch means loading a container
 * the guarantee has to belong to the caller that uses it.
 * 
 * A claim that the tests were run is not believed: the machine runs the pinned checks afterwards
 * (`checks.js`), which is why the brief says the team has no shell (gotcha 78).
 */

const path = require("path");

const harness = require("../../harness");
const { assertRealToolCalls, turnShapeOf } = require("../agents");
const patches = require("../patches");
const tickets = require("../tickets");
const { runTurnWithHooks, MANAGER_TASK } = require("../hooks");
const { DEVTEAM_TOOLS_NOTE, loadSystemPrompt } = require("./brief");
const { patchFsTools, collectPatchWriteAttempts, proposalAnswerTool } = require("./tools");
const { parseProposalReply } = require("./proposal");
const { renderTicketForDev, evidenceFootprint } = require("./briefing");

const projectRoot = path.join(__dirname, "../.."); // devteam.js's ROOT

/**
 * Run one dev-team turn for one ticket.
 *
 * The order is the safety property: open the patch (which enforces "one team at a time"), fingerprint
 * the tree, run the turn, fingerprint again, and hand the result to `recordProposal` — the only door
 * from a dev turn to a patch record. `recordProposal` re-runs the banned-path list, the proposal
 * contract, the declared-vs-actual cross-check and the test-chain comparison, so no path through this
 * module produces a patch that skipped them.
 *
 * @param {Object} input
 * @param {string} input.ticketId
 * @param {string} input.seriesDir
 * @param {string} [input.root]
 * @param {{json: string, markdown: string}} [input.patchPaths]
 * @param {string} [input.ticketsFile]
 * @returns {Promise<{ok: boolean, patch: Object|null, problems: Object[], warnings: Object[], writeAttempts: Object[], actualChanges: string[], usage: Object|null, turnShape: Object|null, error: string|null}>}
 */
async function workTicket({ ticketId, seriesDir, root = projectRoot, patchPaths = patches.patchPaths(), ticketsFile = tickets.ticketPaths().json }) {
  const fail = (error, extra = {}) => ({
    ok: false,
    patch: null,
    problems: [],
    warnings: [],
    writeAttempts: [],
    actualChanges: [],
    usage: null,
    turnShape: null,
    error,
    ...extra,
  });

  const store = tickets.readTickets(ticketsFile);
  const ticket = store.tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    return fail(
      `no ticket ${ticketId} in ${ticketsFile}. Run "node diagnose.js --open" to list the tickets that ` +
        `have been answered, and "npm run delivery" to see which ones needed asking.`
    );
  }

  // Before anything else: what the tree already looks like, and what the test chain already runs. Read
  // here rather than compared later, because "what did this patch change?" has to be answered against
  // the state the turn started from — and because a turn that starts from a tree somebody else already
  // edited cannot be described afterwards, which is the whole basis on which the manager judges it.
  const treeBefore = patches.workingTreeChanges(root);
  if (treeBefore.error) return fail(treeBefore.error);
  const chainBefore = patches.readTestChain(root);
  if (chainBefore.error) return fail(chainBefore.error);
  if (treeBefore.files.length) {
    return fail(
      `the working tree inside ${root} already holds ${treeBefore.files.length} change(s) no patch ` +
        `declares: ` +
        `${treeBefore.files.slice(0, 12).map((f) => `${f.status} ${f.path}`).join(", ")}. A dev turn has ` +
        `to start from a tree it can describe, or every file the turn touches arrives mixed with edits ` +
        `nobody named and the manager cannot tell which is which. Put them back, or commit them, first.`
    );
  }

  // The door. Every refusal `createPatch` makes — no diagnosis, no choice, an option that does not
  // need code, a ticket whose every option was refused, a second team — is a refusal of THIS command,
  // and it happens before a model is reached.
  const opened = patches.createPatch({ ticketId, paths: patchPaths, ticketsFile });
  if (!opened.patch) return fail(opened.error);
  const patch = opened.patch;
  const option = (ticket.options || []).find((o) => o.id === patch.optionId);
  if (!option) return fail(`option ${patch.optionId} is no longer on ticket ${ticketId}.`);

  const footprint = await evidenceFootprint(ticket, [], seriesDir, root);
  // The evidence size is PRINTED, not spent on a cap. This turn is uncapped, so the number that
  // explains a long dev turn afterwards is "how much it was pointed at", and the run log is where the
  // account owner reads it.
  harness.logLine(
    `[devteam] ${ticket.id}: evidence is ${footprint.files.length} file(s), ` +
      `${footprint.bytes} bytes — uncapped turn, old read answers offloaded to disk as it fills`
  );

  const gate = await patchFsTools({ cwd: root, allowedDirs: [root] });

  // The proposal button, alongside the five file tools. It writes nothing, so the write boundary is
  // still exactly the five tools the banned-path table is written against; what it changes is how the
  // team's answer reaches the patch record — as arguments the provider checked, instead of a JSON
  // block to find in prose after the files have already been edited.
  const answer = proposalAnswerTool();
  const toolSet = { ...gate.tools, [answer.name]: answer.tool };

  // `pre-manager` / `post-manager` fire HERE, around the turn, not in the CLI that typed the command.
  // Every refusal this module makes (unknown ticket, a tree somebody else already edited, a ticket
  // with no chosen option, a second team on one ticket) happens first, so a request that never reaches
  // the model never pays for a container switch (gotcha 22). And this turn is a tool-calling agent
  // that EDITS files, which a container that cannot call tools answers with nothing at all (gotcha
  // 51) — so the guarantee "the support model is the one serving" belongs to the role that makes the
  // call. Which container that is stays entirely the hook's business (docs/architecture.md).
  let result = null;
  let turnError = null;
  try {
    result = await runTurnWithHooks(MANAGER_TASK, async () => {
      const agent = await harness.createAgentHandle({
        name: "devteam",
        systemPrompt: loadSystemPrompt() + DEVTEAM_TOOLS_NOTE,
        tools: toolSet,
        approve: gate.approve,
        cwd: root,
        // The delivery-layer context management: no step cap, the working window is reported on every
        // tool answer, and old read answers are set aside on disk where they stay recallable
        // (`utils/context.js`). The harness adds `manage_context` / `recall_memory` to the tool set for
        // a managed role — this module does not add them itself, so the write gate still judges exactly
        // the five file tools the banned-path table is written against (gotcha 75), the two memory
        // tools come in through the harness rather than as paths the sandbox was asked to approve, and
        // the one extra tool in the set writes nothing.
        contextManagement: true,
      });
      try {
        const reply = await agent.sendTurn(renderTicketForDev({ ticket, patch, option, seriesDir, root }), {
          label: `devteam-${ticket.id}`,
        });
        assertRealToolCalls(reply, "the dev team", ticket.volume || ticket.step);
        return reply;
      } finally {
        await agent.close();
      }
    });
  } catch (err) {
    // A turn that died part-way is not a clean refusal: the patch is already open and the tree may
    // already be edited. Report it as an unfinished patch, because that is what the next command has
    // to deal with, and name the way back. A `pre-manager` hook that failed lands here too — the
    // patch is open and unjudged either way, and the tree is what it is.
    turnError = err;
  }

  const treeAfter = patches.workingTreeChanges(root);
  if (treeAfter.error) return fail(treeAfter.error, { patch });
  const chainAfter = patches.readTestChain(root);

  const actualChanges = treeAfter.files.map((f) => f.path);
  const attempts = collectPatchWriteAttempts(gate.refusals, result?.toolCalls || [], gate.advertised);
  const unfinished = (what) =>
    `${what} ${actualChanges.length} file(s) inside ${root} are changed in the working tree ` +
    `(${actualChanges.join(", ") || "none"}). Patch ${patch.id} is still unjudged, so act mode will ` +
    `refuse to run a step. Run "npm run fix -- --revert=${patch.id}" to put the tree back.`;

  if (turnError) {
    return {
      ok: false,
      patch,
      problems: [{ kind: "turn-failed", message: turnError.message }],
      warnings: [],
      writeAttempts: attempts,
      actualChanges,
      usage: null,
      // No turn record: the turn threw before the harness handed one back, so the honest value is
      // "unknown", not a row of zeroes that reads like the turn made no tool calls.
      turnShape: null,
      error: unfinished(`the dev turn did not finish (${turnError.message}).`) +
        " The turn's own record is in the run's log folder — read it before re-running, because a turn stopped for " +
        "repeating itself or for running past the turn clock is a different problem from a turn that " +
        "answered nothing, and this turn has no step limit to blame.",
    };
  }

  // The proposal arrives one of two ways, and the record says which one. The button is the door; the
  // prose parser is the backstop that used to be the only door, and it stays fail-closed.
  const submitted = answer.state.answer;
  const parsed = submitted ? { proposal: submitted, problems: [] } : parseProposalReply(result.text);
  const answeredBy = submitted ? "tool" : parsed.proposal ? "prose" : null;
  if (!parsed.proposal) {
    // No proposal, but the tree may already be changed. Say so, and say what is sitting in it.
    return {
      ok: false,
      patch,
      problems: parsed.problems,
      warnings: [],
      writeAttempts: attempts,
      actualChanges,
      usage: result.usage || null,
      turnShape: turnShapeOf(result),
      error: unfinished("the dev team produced no proposal."),
    };
  }

  // The only door from a dev turn to a patch record.
  const written = patches.recordProposal(
    patch.id,
    {
      files: parsed.proposal.files,
      summary: parsed.proposal.summary,
      why: parsed.proposal.why,
      couldBreak: parsed.proposal.couldBreak,
      expected: parsed.proposal.expected,
      verify: parsed.proposal.verify,
      questions: parsed.proposal.questions,
      ownerNote: parsed.proposal.ownerNote,
      actualChanges,
      refusedWrites: attempts,
      chain: { before: chainBefore.script, after: chainAfter.script },
      usage: result.usage || null,
      turnShape: turnShapeOf(result),
      // "tool" or "prose": which half of the channel carried the answer. A patch record that keeps
      // saying "prose" is a team not using the button it was given, and the prose scrape is the half
      // that can lose a proposal after the files have already been changed.
      answeredBy,
      answerToolRefusals: answer.state.refusals,
    },
    patchPaths
  );

  const stored = written.patch || patch;
  return {
    ok: !written.error,
    patch: stored,
    problems: written.problems,
    warnings: written.warnings,
    writeAttempts: attempts,
    actualChanges,
    usage: result.usage || null,
    turnShape: turnShapeOf(result),
    error: written.error || null,
  };
}

module.exports = { workTicket };

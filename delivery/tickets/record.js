/**
 * Recording what the manager decided: the option it chose from a diagnosis, the move it refused and
 * why, and its verdict on a code proposal — accept or reject, never apply.
 *
 * Part of the delivery/tickets.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions
const { appendLedgerEntry } = require("../../utils/ledger");
const { recordChoice } = require("../../utils/tickets");
const patches = require("../../utils/patches");

/**
 * Record the manager's choice among the options the diagnostics team offered.
 *
 * The choice is the manager's own act, and until now it was reachable only from code: the closed
 * menu had no entry for it, so a ticket that had been answered could be read but not acted on, and
 * the next role in the ladder (the dev team, which only ever moves on an option marked
 * `requiresCodeChange`) could never be summoned by a command the manager runs.
 *
 * `recordChoice` requires a reason, and `utils/tickets.js` refuses a banned option by name here —
 * the filter is on the option generator, but the door is here too, so a refusal is a refusal
 * whatever route it was reached by (gotcha 70).
 *
 * @param {{ticketId: string, optionId: string, reason: string|null}} opts
 * @returns {{exitCode: number, ticket: Object|null, error: string|null}}
 */
function chooseOption({ ticketId, optionId, reason }) {
  if (!optionId) {
    return {
      exitCode: 2,
      ticket: null,
      error:
        "--choose needs the option id: --choose=<optionId> --ticket=<id> --reason=\"<why>\". " +
        "Run `npm run diagnose -- --open` to read the tickets and the options each one offers.",
    };
  }
  if (!ticketId) {
    return { exitCode: 2, ticket: null, error: `--choose needs --ticket=<id> as well.` };
  }
  if (!reason || !reason.trim()) {
    return {
      exitCode: 2,
      ticket: null,
      error:
        "a choice must carry a reason: --reason=\"<what made this option the one>\". " +
        "The reason is what the account owner reads afterwards, and what the acceptance test is judged against.",
    };
  }

  const result = recordChoice(ticketId, { optionId, reason: reason.trim(), decidedBy: "delivery-manager" });
  if (result.error) return { exitCode: 2, ticket: null, error: result.error };
  const option = (result.ticket.options || []).find((o) => o.id === optionId) || {};
  return { exitCode: 0, ticket: result.ticket, error: null, option };
}

/**
 * Write the refusal down. A gate that refuses silently is a gate that gets worked around, and
 * "I considered this and stopped" is the half of the ledger a human needs in order to agree or
 * disagree with it.
 *
 * @param {{step: import("../../utils/resume").ResumeStepPlan, run: string, reason: string, ticket: Object|null}} opts
 */
function recordRefusal({ step, run, reason, ticket }) {
  const entry = appendLedgerEntry({
    kind: "intervention",
    run,
    step: step.step,
    volume: step.fromVolume,
    finding: step.finding,
    action: step.actionName,
    outcome: "refused",
    decidedBy: "manager",
    ticket: ticket ? ticket.id : null,
    note: reason,
  });
  if (entry.error) console.log(`[delivery] ledger: ${entry.error}`);
}

/**
 * The manager's whole authority over a code proposal: accept it, or reject it. Never apply it.
 *
 * Three things are deliberate here.
 *
 * **It needs act mode.** Accepting a proposal is a decision with consequences, and `report` mode is
 * the mode that has none. A manager that records decisions while claiming to be rehearsing is the
 * contradiction `--no-write` with `--mode=act` already refuses.
 *
 * **It is not a ledger entry.** The patch record is the record of the judgment. What goes into the
 * ledger is the *consequence* — the wipe-and-cascade that makes the accepted code actually run — and
 * that is already a menu action with a budget and an anti-spin gate. Recording the judgment as an
 * intervention too would spend the step's budget on reading a proposal.
 *
 * **The reason is checked, not just required.** "I accepted it because volume 15 passes now" is the
 * same demand `validateTicketShape` refuses on the manager's question, arriving from the other end of
 * the conversation (gotcha 70). The reason has to say something about the deliverable.
 *
 * @param {{patchId: string, outcome: "accepted"|"rejected", reason: string|null, mode: string}} opts
 * @returns {{exitCode: number, patch: Object|null, error: string|null}}
 */
function judgePatch({ patchId, outcome, reason, mode }) {
  const log = (line) => console.log(`[delivery] ${line}`);
  if (mode !== "act") {
    log(
      `REFUSED: accepting or rejecting a patch is an act, and this run is in report mode. ` +
        `Report mode proposes and decides nothing. Pass --mode=act.`
    );
    return { exitCode: 2, patch: null, error: "report mode does not judge patches" };
  }
  if (!patchId) {
    log("REFUSED: no patch named.");
    return { exitCode: 2, patch: null, error: "no patch named" };
  }

  const paths = patches.patchPaths();
  const stored = patches.findPatch(patchId, patches.readPatches(paths.json).patches);
  if (!stored) {
    log(`REFUSED: no patch ${patchId}. \`node fix.js --status\` lists what exists.`);
    return { exitCode: 2, patch: null, error: `no patch ${patchId}` };
  }

  const result =
    outcome === "accepted"
      ? patches.acceptPatch(patchId, { reason, decidedBy: "manager" }, paths)
      : patches.rejectPatch(patchId, { reason, decidedBy: "manager" }, paths);

  if (result.error) {
    log(`REFUSED: ${result.error}`);
    return { exitCode: 2, patch: result.patch || null, error: result.error };
  }

  const patch = result.patch;
  log(`${patch.id} ${outcome}: ${patch.decision.reason}`);
  log(`  ${patch.step}${patch.volume ? ` volume ${patch.volume}` : ""} — ${patch.summary}`);
  log(`  files it names: ${patch.files ? patch.files.join(", ") : "(none)"}`);
  if (outcome === "accepted") {
    log(
      `  Next: the commit is the dev team's act, not yours — node fix.js --commit=${patch.id}. ` +
        `Then the accepted code has to be made to run: the skip checks do not know the code changed, ` +
        `so the step it fixes has to be wiped and cascaded (gotcha 66). Run npm run delivery --mode=act ` +
        `and the plan will propose that.`
    );
  } else {
    log(
      `  Next: this code is still in the working tree, and the tree is what the next run executes. ` +
        `Put it back — node fix.js --revert=${patch.id}. Act mode refuses to run a step until that is done.`
    );
  }
  return { exitCode: 0, patch, error: null };
}

module.exports = {
  chooseOption,
  recordRefusal,
  judgePatch,
};

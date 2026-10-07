/**
 * The call itself: runOneShot with no tools, wrapped in runTurnWithHooks so the role's own model switch fires around its OWN turn, and it is the reader of DELIVERY_MAX_TOKENS. A dead call names the wrong-container suspicion out loud — on this machine every container advertises the same model id, so the only record of which one the pre-manager hook started is hooks/.model-switch-state.
 *
 * Part of the manager.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions
const harness = require("../../harness");
const { runTurnWithHooks, MANAGER_TASK } = require("../hooks");
const { judgeTemperature, judgeThinking } = require("../../configs/shared");

const { managerMaxTokens } = require("./rules");
const { renderManagerBrief } = require("./brief");
const { parseManagerAction } = require("./parse");
const { validateManagerAction, repairTicketReference } = require("./gate");

/**
 * Ask the manager for the next move.
 *
 * One tool-less `runOneShot`, wrapped in `runTurnWithHooks(MANAGER_TASK, …)` so `pre-manager` fires
 * before it and `post-manager` after: the guarantee that the manager's model is the one serving is
 * the role's, not the caller's (docs/architecture.md "Pipeline hooks"). It samples like a grader —
 * `JUDGE_TEMPERATURE` + `STAGE_THINKING_LEVEL` — because a decision is a judgment over records that
 * are already on disk, not a document being written (gotcha 59).
 *
 * @param {Object} args
 * @param {import("./resume").ResumePlan} args.plan
 * @param {ManagerMove[]} args.moves
 * @param {import("./tickets").Ticket[]} [args.tickets]
 * @param {import("./patches").Patch[]} [args.patches]
 * @param {string} [args.correction] - Set on a second attempt: the refusal the last answer got, put
 *   in front of the model so the retry is a correction and not the same roll of the dice.
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<{ok: boolean, action: ManagerAction|null, problems: Object[], warnings: Object[], reply: string, refusal: string|null, kind: string|null, maxTokens: number}>}
 */
async function managerDecision({ plan, moves, tickets = [], patches = [], correction = null, log = (line) => console.log(line) }) {
  const brief = renderManagerBrief({ plan, moves, tickets, patches, correction });
  const maxTokens = managerMaxTokens();
  log(
    `asking the delivery manager (${brief.length} characters of state, ${moves.length} offered move(s), ` +
      `reply cap ${maxTokens})…`
  );

  const dialect = judgeThinking("MANAGER");
  let reply;
  try {
    reply = await runTurnWithHooks(MANAGER_TASK, () =>
      harness.runOneShot({
        systemPrompt: null,
        messages: [{ text: brief }],
        temperature: judgeTemperature(),
        thinking: dialect.thinking,
        thinkingLevel: dialect.thinkingLevel,
        maxTokens,
        label: "delivery-manager",
      })
    );
  } catch (err) {
    // A manager call that died is not a decision. The most likely cause on this machine is the wrong
    // container serving (every container advertises the same model id — gotcha 22), and the tell for
    // it is an empty or absent answer, so the refusal has to name that suspicion out loud.
    return {
      ok: false,
      action: null,
      problems: [],
      warnings: [],
      reply: "",
      refusal:
        `the manager call failed: ${err.message}. If the answer was empty, suspect the wrong model ` +
        `container serving: every container on this machine advertises the same model id, and the only ` +
        `record of which one the \`pre-manager\` hook started is hooks/.model-switch-state.`,
      kind: "call-failed",
      maxTokens,
    };
  }

  const parsed = parseManagerAction(reply);
  if (!parsed.action) {
    return {
      ok: false,
      action: null,
      problems: parsed.problems,
      warnings: parsed.warnings,
      reply,
      refusal: parsed.problems.map((p) => p.message).join(" | "),
      kind: parsed.problems[0] ? parsed.problems[0].kind : "unparseable",
      maxTokens,
    };
  }

  // A mistyped ticket id, when the answer's own option id names the ticket exactly, is a
  // transcription slip and not an illegal move. Repair it, say so out loud, and let the gate judge
  // the decision the manager actually made rather than the characters it typed.
  const fixed = repairTicketReference(parsed.action, tickets);
  if (fixed.repaired) {
    const note =
      `the answer named ticket ${JSON.stringify(fixed.repaired.from)}, which is not open. Its option id names ` +
      `${fixed.repaired.to}, so the decision was read against that ticket.`;
    parsed.warnings.push({ kind: "repaired-ticket-id", message: note });
    log(`  note: ${note}`);
  }

  const gate = validateManagerAction(fixed.action, { moves, tickets, patches, plan });
  if (!gate.allowed) {
    return {
      ok: false,
      action: fixed.action,
      problems: [{ kind: gate.kind, message: gate.why }],
      warnings: parsed.warnings,
      reply,
      refusal: gate.why,
      kind: gate.kind,
      maxTokens,
    };
  }

  return {
    ok: true,
    action: fixed.action,
    problems: [],
    warnings: parsed.warnings,
    reply,
    refusal: null,
    kind: null,
    maxTokens,
  };
}


module.exports = {
  managerDecision,
};

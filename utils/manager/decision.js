/**
 * The call itself: one agent turn whose tools ARE the offered menu, wrapped in runTurnWithHooks so the role's own model switch fires around its OWN turn, and it is the reader of DELIVERY_MAX_TOKENS. A dead call names the wrong-container suspicion out loud — on this machine every container advertises the same model id, so the only record of which one the pre-manager hook started is hooks/.model-switch-state.
 *
 * **Why this is an agent handle and not a tool-less one-shot.** It used to be a tool-less one-shot, and
 * the reason given was that an agent handle would hand the manager file-reading tools and turn "never
 * sees the code" from a capability into a sentence (gotcha 71). That reasoning still holds, and it is
 * why the handle is built with ONE tool set: the moves the triage offered. No file tool, no shell, no
 * wiki, no context tools — `CONTEXT_MANAGED_ROLES` does not name this role, so the handle is
 * unmanaged and the harness adds nothing to what it is handed. What the manager can reach is exactly
 * the menu, and a move that is not on the menu is a tool that does not exist.
 *
 * **What that buys.** The manager never types an id, a step name, a volume or an outcome: the tool it
 * called carries them, and `actionFromMove` reads them off the menu entry. The two failures this layer
 * has actually bled on — a 43-character ticket id copied with a chunk missing (gotcha 81) and a step
 * name copied as the whole sentence around it (gotcha 84) — are not discouraged here; they are not
 * expressible.
 *
 * **The text path is kept, not deleted.** A local endpoint on this machine sometimes writes its tool
 * call as prose instead of using the API's tool protocol (gotcha 18). So when the turn calls no tool,
 * the reply is read with `parseManagerAction` exactly as before, repaired by `repairTicketReference` /
 * `repairStepReference` where the state already holds the name, and put through the same gate. The
 * gate is the authority on both paths.
 *
 * Part of the manager.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions
const harness = require("../../harness");
const { runTurnWithHooks, MANAGER_TASK } = require("../hooks");
const { judgeTemperature, judgeThinking } = require("../../configs/shared");

const { managerMaxTokens, MANAGER_RULES, MANAGER_TOOLS_NOTE, MANAGER_MAX_STEPS } = require("./rules");
const { renderManagerBrief } = require("./brief");
const { buildMoveTools } = require("./move-tools");
const { parseManagerAction } = require("./parse");
const { validateManagerAction, repairTicketReference, repairStepReference } = require("./gate");

/** The handle's name: the log folder, the turn transcript, and the role the hooks fire around. */
const MANAGER_AGENT = "delivery-manager";

/**
 * Run the decision turn and hand back what the model produced.
 *
 * The handle is created and closed inside the hook window, so `pre-manager` guarantees the container
 * serving is the one this role expects before the first token, and `post-manager` runs after it.
 *
 * @param {Object} args
 * @param {string} args.brief - The state report, as the user message.
 * @param {Object} args.tools - The menu, as tools (`buildMoveTools`).
 * @param {number} args.maxTokens - The manager's own reply budget.
 * @returns {Promise<Object>} The accumulated turn result (see `consumeEvents`).
 */
async function managerTurn({ brief, tools, maxTokens }) {
  const dialect = judgeThinking("MANAGER");
  const handle = await harness.createAgentHandle({
    name: MANAGER_AGENT,
    systemPrompt: MANAGER_RULES + MANAGER_TOOLS_NOTE,
    tools,
    maxSteps: MANAGER_MAX_STEPS,
    // A decision is a judgment over records that are already on disk, not a document being written:
    // it samples like a grader (gotcha 59). An agent handle could not choose its own temperature
    // until this override existed.
    temperature: judgeTemperature(),
    maxTokens,
    thinking: dialect.thinking,
    thinkingLevel: dialect.thinkingLevel,
  });
  try {
    return await handle.sendTurn(brief, { label: MANAGER_AGENT });
  } finally {
    await handle.close();
  }
}

/**
 * Put one candidate decision through the repairs and the gate, and report the result in the shape the
 * loop reads — whichever path produced it, a tool call or a block of text.
 *
 * @param {Object} args
 * @param {import("./rules").ManagerAction} args.action - The candidate.
 * @param {Object} args.ctx - `{ moves, tickets, patches, plan }`.
 * @param {Object[]} args.warnings - Warnings already collected this call.
 * @param {string} args.reply - What the model said, for the record.
 * @param {string} args.via - `"tool"` or `"text"`: which path produced the action.
 * @param {number} args.maxTokens
 * @param {(line: string) => void} args.log
 * @returns {{ok: boolean, action: Object|null, problems: Object[], warnings: Object[], reply: string, refusal: string|null, kind: string|null, via: string, maxTokens: number}}
 */
function gateCandidate({ action, ctx, warnings, reply, via, maxTokens, log }) {
  // A name the state already holds is a transcription slip, not an illegal move. Both repairs are
  // exact string logic and both are announced rather than applied silently.
  const fixedTicket = repairTicketReference(action, ctx.tickets);
  if (fixedTicket.repaired) {
    const note =
      `the answer named ticket ${JSON.stringify(fixedTicket.repaired.from)}, which is not open. Its option id names ` +
      `${fixedTicket.repaired.to}, so the decision was read against that ticket.`;
    warnings.push({ kind: "repaired-ticket-id", message: note });
    log(`  note: ${note}`);
  }
  const fixedStep = repairStepReference(fixedTicket.action, ctx.moves);
  if (fixedStep.repaired) {
    const note =
      `the answer named the step ${JSON.stringify(fixedStep.repaired.from)} — the menu's whole sentence rather ` +
      `than its name. The menu offers one run move, "${fixedStep.repaired.to}", so the decision was read against it.`;
    warnings.push({ kind: "repaired-step-name", message: note });
    log(`  note: ${note}`);
  }

  const gate = validateManagerAction(fixedStep.action, ctx);
  if (!gate.allowed) {
    return {
      ok: false,
      action: fixedStep.action,
      problems: [{ kind: gate.kind, message: gate.why }],
      warnings,
      reply,
      refusal: gate.why,
      kind: gate.kind,
      via,
      maxTokens,
    };
  }

  return {
    ok: true,
    action: fixedStep.action,
    problems: [],
    warnings,
    reply,
    refusal: null,
    kind: null,
    via,
    maxTokens,
  };
}

/**
 * Ask the manager for the next move.
 *
 * One agent turn, no file tools, the offered menu as its only tools, sampled like a grader
 * (`JUDGE_TEMPERATURE` + `STAGE_THINKING_LEVEL`), wrapped in `runTurnWithHooks(MANAGER_TASK, …)` so
 * `pre-manager` fires before it and `post-manager` after it: the guarantee that the manager's model is
 * the one serving is the role's, not the caller's (docs/architecture.md "Pipeline hooks").
 *
 * @param {Object} args
 * @param {import("../resume").ResumePlan} args.plan
 * @param {import("./rules").ManagerMove[]} args.moves
 * @param {import("../tickets").Ticket[]} [args.tickets]
 * @param {import("../patches").Patch[]} [args.patches]
 * @param {string} [args.correction] - Set on a second attempt: the refusal the last answer got, put
 *   in front of the model so the retry is a correction and not the same roll of the dice.
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<{ok: boolean, action: Object|null, problems: Object[], warnings: Object[], reply: string, refusal: string|null, kind: string|null, via: string, maxTokens: number}>}
 */
async function managerDecision({ plan, moves = [], tickets = [], patches = [], correction = null, log = (line) => console.log(line) }) {
  const built = buildMoveTools(moves);
  const brief = renderManagerBrief({ plan, moves, tickets, patches, correction });
  const maxTokens = managerMaxTokens();
  log(
    `asking the delivery manager (${brief.length} characters of state, ${built.names.length} offered ` +
      `move(s) as tools, reply cap ${maxTokens})…`
  );

  let turn;
  try {
    turn = await runTurnWithHooks(MANAGER_TASK, () => managerTurn({ brief, tools: built.tools, maxTokens }));
  } catch (err) {
    // A manager call that died is not a decision. The most likely cause on this machine is the wrong
    // container serving (every container advertises the same model id — gotcha 22), and the tell for
    // it is an empty or absent answer, so the refusal has to name that suspicion out loud.
    const reached = /unavailable tool|not a valid tool|unknown tool/i.exec(String(err.message || ""));
    if (reached) {
      return {
        ok: false,
        action: null,
        problems: [{ kind: "unknown-move", message: `the manager reached for a move that is not on its menu: ${err.message}` }],
        warnings: [],
        reply: "",
        refusal:
          `the manager called a tool that is not on the menu for this state. The moves it was offered are: ` +
          `${moves.map((m) => m.label).join(" | ") || "none"}.`,
        kind: "unknown-move",
        via: "tool",
        maxTokens,
      };
    }
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
      via: "tool",
      maxTokens,
    };
  }

  const warnings = [];
  const reply = String((turn && turn.text) || "");
  const ctx = { moves, tickets, patches, plan };

  if (built.state.secondAttempts) {
    warnings.push({
      kind: "second-move-refused",
      message:
        `the manager called ${built.state.secondAttempts + 1} move(s) in one decision. The first was read ` +
        `as the decision; the rest were refused by the tool, because the loop re-reads the run after one ` +
        `move and a second move in the same turn is a move no gate has assessed.`,
    });
  }
  if (built.state.missingFields.length) {
    warnings.push({
      kind: "move-without-reason",
      message:
        `${built.state.missingFields.length} tool call(s) named a real move and left ` +
        `${built.state.missingFields.map((m) => m.missing.join(", ")).join(", ")} empty. Nothing was ` +
        `recorded from those calls.`,
    });
  }

  // The tool path: the decision is the move the tool was built from, with the model's prose attached.
  if (built.state.chosen) {
    return gateCandidate({
      action: built.state.chosen.action,
      ctx,
      warnings,
      reply,
      via: "tool",
      maxTokens,
      log,
    });
  }

  // The text path, kept for the failure this machine actually produces: a model that answers in prose
  // (or writes its tool call as text) instead of calling one of the tools in front of it.
  if (!reply.trim()) {
    return {
      ok: false,
      action: null,
      problems: [{ kind: "no-move", message: "the manager called no tool and wrote nothing." }],
      warnings,
      reply,
      refusal:
        `the manager made no move: it called none of the ${built.names.length} tool(s) it was offered and ` +
        `wrote nothing. The moves it was offered are: ${moves.map((m) => m.label).join(" | ") || "none"}.`,
      kind: "no-move",
      via: "none",
      maxTokens,
    };
  }

  const parsed = parseManagerAction(reply);
  if (!parsed.action) {
    return {
      ok: false,
      action: null,
      problems: parsed.problems,
      warnings,
      reply,
      refusal: parsed.problems.map((p) => p.message).join(" | "),
      kind: parsed.problems[0] ? parsed.problems[0].kind : "unparseable",
      via: "text",
      maxTokens,
    };
  }

  return gateCandidate({ action: parsed.action, ctx, warnings: parsed.warnings, reply, via: "text", maxTokens, log });
}

module.exports = {
  MANAGER_AGENT,
  managerTurn,
  gateCandidate,
  managerDecision,
};

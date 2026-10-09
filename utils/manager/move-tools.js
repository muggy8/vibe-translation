/**
 * utils/manager/move-tools.js — the offered menu, rendered as TOOLS instead of as a list to copy from.
 *
 * The manager's menu was always a closed set: `offerMoves` builds it from what the run actually says,
 * and `validateManagerAction` refused anything outside it. This module makes the same fact structural.
 * Every legal move becomes a tool that already exists, and every move the state does not support
 * becomes a tool that is simply not there — so the manager cannot name it, mis-name it, or invent it.
 *
 * **The ids are the machine's, never the model's.** A move carries its ticket id, option id, patch id,
 * step name and outcome inside itself. The model calls a tool; the tool hands back the move that tool
 * was built from, with its real ids attached. That removes the whole class of failure gotcha 81
 * describes: a 43-character ticket id copied from a prompt, a chunk dropped, a run stopped over a
 * typo. It also removes the newer one (gotcha 84): a `run` move whose `step` was filled with the whole
 * menu line because the menu line is the only place that step was ever written.
 *
 * **What the model still supplies is the judgment.** `reason` (the line the ledger keeps), `answer`
 * (its reply to the diagnostics team), `note` (the sentence the account owner acts on). Those are the
 * only arguments any of these tools take, and they are the only parts a model is actually for.
 *
 * **One move per decision, enforced by the tool.** The first call records the decision; a second call
 * in the same turn is refused by the tool itself, because the loop re-reads the run after every move
 * and the menu it is offered next is a fact about the state the first move just changed. A manager
 * that could dispatch twice in one turn would be a manager the intervention budget and the anti-spin
 * ledger cannot count.
 *
 * Nothing here executes anything. These tools are how a decision is *recorded*; `autopilot/commands.js`
 * is what carries it out, in its own process, with the same gates a human typing the command meets.
 *
 * Part of the manager.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions
const { tool } = require("ai");
const { z } = require("zod");

// ─── What each move asks the model to write ───────────────────────────────────

/**
 * The arguments a move's tool takes: `reason` for all of them, plus the one field that is the move.
 *
 * `reason` is required everywhere on purpose. It is the only record of why this run did what it did,
 * and `parseManagerAction` already refused a decision without one.
 *
 * @type {Object<string, {fields: Object<string, string>, what: string}>}
 */
const MOVE_ARGUMENTS = {
  run: {
    fields: { reason: "why this move, now, in one or two sentences" },
    what: "Run the pipeline's own command for this step, exactly as the triage scoped it.",
  },
  diagnose: {
    fields: { reason: "why this question needs the team that may open the code" },
    what: "Ask the diagnostics team to answer this open ticket. They may open the code, the prompts and the transcripts; you may not.",
  },
  answer: {
    fields: {
      reason: "why you are answering this one, now",
      answer: "your reply, in language a customer is allowed to give: the folders, the reports, the plan of record",
    },
    what: "Answer this question the diagnostics team asked you.",
  },
  choose: {
    fields: { reason: "why this option, over the others on this ticket" },
    what: "Choose this option. If it needs a code change, choosing it is what calls in the dev team.",
  },
  fix: {
    fields: { reason: "what needs changing, in terms of the deliverable — not a fix in the code" },
    what: "Call in the dev team for the option you chose on this ticket. They work inside a boundary they may not widen.",
  },
  judge: {
    fields: { reason: "what the change does: which mechanism it fixes, which deliverable signal it expects to move, what it could break" },
    what: "Judge this patch. Say what the change does, not that the complaint stopped.",
  },
  escalate: {
    fields: { note: "the decision the account owner has to make, in one sentence they can act on" },
    what: "Stop, and name the move that belongs to the account owner. This is not a failure state.",
  },
  "stop-run": {
    fields: { reason: "which run you are ending, and what it has been doing for how long" },
    what:
      "End the run that is holding the pipeline and has stopped making progress. It is offered only when " +
      "the records say the holder is stalled, and it is refused again by the machine if that run is " +
      "actually working.",
  },
  end: {
    fields: { reason: "which records prove the run is finished" },
    what: "The run is finished. The machine checks this against the records before it accepts it: nothing missing, no ticket open, no patch unjudged, the deliverable clean.",
  },
};

/**
 * A tool-name-safe rendering of a name. Tool names travel through the provider, which only accepts a
 * short identifier — so the human-readable text lives in the description, where the model reads it.
 *
 * @param {string} text
 * @returns {string}
 */
function slug(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * The tool name for one offered move: its position, its kind, and enough of its own name to read.
 *
 * The position is what makes the names unique without asking the model to transcribe a 43-character
 * ticket id; the kind and the step are what make the list readable in a transcript. A kind that appears
 * more than once (three open questions on one ticket, two tickets to diagnose) gets an ordinal, so two
 * legal moves never collide and neither one's name is a guess.
 *
 * @param {import("./rules").ManagerMove} move
 * @param {number} index
 * @param {import("./rules").ManagerMove[]} moves - The whole menu, for the ordinal.
 * @returns {string}
 */
function moveToolName(move, index, moves = []) {
  const bits = [`move${index + 1}`, move.kind];
  if (move.kind === "run" && move.step) bits.push(slug(move.step));
  else if (move.kind === "judge" && move.outcome) bits.push(move.outcome);
  else {
    const same = (moves || []).filter((m) => m && m.kind === move.kind);
    if (same.length > 1) bits.push(String(same.indexOf(move) + 1));
  }
  return bits.join("_");
}

/**
 * The action a recorded tool call means: the move's own ids, plus the model's prose.
 *
 * Every identifier comes from the move the tool was built from, never from what the model typed. This
 * is the whole point of the module, and it is why `unknown-ticket`, `unknown-option`, `unknown-patch`
 * and `not-offered` cannot be produced by this path — the tool the model called IS a menu entry.
 *
 * @param {import("./rules").ManagerMove} move
 * @param {Object} input - The tool arguments the model supplied.
 * @returns {import("./rules").ManagerAction}
 */
function actionFromMove(move, input = {}) {
  const action = { action: move.kind, reason: String(input.reason || "").trim() };
  if (move.step) action.step = move.step;
  if (move.ticket) action.ticket = move.ticket;
  if (move.option) action.option = move.option;
  if (move.patch) action.patch = move.patch;
  if (move.outcome) action.outcome = move.outcome;
  if (move.question) action.question = move.question;
  if (typeof input.answer === "string" && input.answer.trim()) action.answer = input.answer.trim();
  if (typeof input.note === "string" && input.note.trim()) action.note = input.note.trim();
  return action;
}

// ─── The tool set ─────────────────────────────────────────────────────────────

/**
 * Build the tool set for one decision, and the record it writes into.
 *
 * @param {import("./rules").ManagerMove[]} moves - The offered menu.
 * @returns {{moves: import("./rules").ManagerMove[], tools: Object, names: string[], state: Object}}
 */
function buildMoveTools(moves) {
  /**
   * The turn's own record. One object, read after the turn ends:
   * `chosen` is the decision; `secondAttempts` counts calls the one-move rule refused;
   * `missingFields` counts calls that named a real move and forgot the prose the move needs.
   */
  const state = { chosen: null, secondAttempts: 0, missingFields: [] };
  const tools = {};
  const list = moves || [];

  list.forEach((move, index) => {
    if (!move || !MOVE_ARGUMENTS[move.kind]) return;
    const spec = MOVE_ARGUMENTS[move.kind];
    const name = moveToolName(move, index, list);
    const shape = {};
    for (const [field, description] of Object.entries(spec.fields)) {
      shape[field] = z.string().min(1).describe(description);
    }

    tools[name] = tool({
      description:
        `${spec.what}\n${move.label}\n` +
        `Call this only if it is the move you choose. The step, the volume and the cascade are already ` +
        `decided by the triage — you are not filling them in, you are choosing this one.`,
      inputSchema: z.object(shape),
      execute: async (input) => {
        if (state.chosen) {
          state.secondAttempts += 1;
          return (
            `REFUSED: the decision for this state is already recorded (${state.chosen.move.label}). ` +
            `One move per decision: the loop re-reads the run after it and offers the menu again, so a ` +
            `second move here would be a move nobody assessed. Write your closing sentence and stop.`
          );
        }

        const missing = Object.keys(spec.fields).filter(
          (field) => !String((input && input[field]) || "").trim()
        );
        if (missing.length) {
          state.missingFields.push({ toolName: name, missing });
          return (
            `REFUSED: this move needs ${missing.map((f) => `"${f}"`).join(" and ")} written out, and ` +
            `${missing.map((f) => `"${f}"`).join(" and ")} came back empty. ` +
            `${spec.fields[missing[0]]}. Nothing was recorded — answer again with it filled in, or call ` +
            `the move you actually mean.`
          );
        }

        state.chosen = { move, action: actionFromMove(move, input), toolName: name };
        return (
          `RECORDED: ${move.label}\n` +
          `The loop carries this out, then re-reads the run and offers the menu again. Call nothing else.`
        );
      },
    });
  });

  return { moves: list, tools, names: Object.keys(tools), state };
}

/**
 * The menu as the model sees it in its tool list, spelled out for the brief.
 *
 * The tool descriptions carry the same text, but the brief is where the manager reads the state and
 * the menu together, and a move it has to match to a tool name it can see is a move it can call.
 *
 * @param {import("./rules").ManagerMove[]} moves - The offered menu.
 * @returns {string[]} - One line per tool: `name — label`.
 */
function describeMoveTools(moves) {
  const list = moves || [];
  const lines = [];
  for (const [index, move] of list.entries()) {
    if (!MOVE_ARGUMENTS[move.kind]) continue;
    lines.push(`${moveToolName(move, index, list)} — ${move.label}`);
  }
  return lines;
}

// ─── The turn's shape ─────────────────────────────────────────────────────────

module.exports = {
  MOVE_ARGUMENTS,
  slug,
  moveToolName,
  actionFromMove,
  buildMoveTools,
  describeMoveTools,
};

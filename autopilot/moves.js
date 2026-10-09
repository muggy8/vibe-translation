/**
 * autopilot/moves.js — the menu the manager is offered, built from what the run actually says.
 *
 * The closed action menu is the guard: the manager chooses among the moves this plan and these
 * tickets make possible, and nothing else (gotcha 75). Exactly one `run` move per plan, the
 * patches still waiting for a judgment, and a rehearsal of the ticket the plan proposes — the
 * same table `delivery.js --open-ticket` would write, so the rehearsal means what it says.
 * 
 * This half writes nothing: it is the question, not the answer.
 */

const delivery = require("../delivery");
const patches = require("../utils/patches");

// ─── The menu the manager is offered ──────────────────────────────────────────

/**
 * The moves the current state actually supports, as data.
 *
 * Two rules decide this list, and both are about what the manager is NOT allowed to do:
 *
 * - **Exactly one `run` move per plan.** `delivery.executableSteps(plan)` returns the plan's whole
 *   executable sequence, and executing it runs the whole sequence: `runActPlan` stops at the first
 *   refusal or failed step, and the sequence IS the triage's answer. Offering the later steps
 *   separately would let the manager skip the cascade, and a skipped cascade is worse than a re-run —
 *   the later volumes would stay built on the artifact that was just repaired (gotcha 66). The label
 *   names the steps the same sequence will run, so the manager is choosing a sequence, not a step.
 * - **A banned option is never on the menu.** The options come from the ticket, and
 *   `utils/tickets.js` already refused the banned ones on the way in (gotcha 70). This list reads
 *   `ticket.options`, not `ticket.refusedOptions`, so the cheap item is not merely discouraged — it
 *   is not offered. The refused ones stay visible on the ticket itself, where the account owner reads
 *   them.
 *
 * @param {Object} args
 * @param {import("./utils/resume").ResumePlan} args.plan
 * @param {Object[]} args.tickets - The tickets still open with the teams.
 * @param {Object[]} args.patches - The patches waiting for a judgment.
 * @returns {import("./utils/manager").ManagerMove[]}
 */
function offerMoves({ plan, tickets, patches: pending }) {
  const moves = [];

  const sequence = delivery.executableSteps(plan);
  if (sequence.length) {
    const entry = sequence[0];
    const after = sequence.slice(1);
    const bits = [entry.actionName];
    if (entry.fromVolume) bits.push(`from volume ${entry.fromVolume}`);
    if (entry.cascade) bits.push("cascade");
    bits.push(entry.countsAsIntervention ? "counts against this step's allowance" : "free");
    moves.push({
      kind: "run",
      step: entry.step,
      actionName: entry.actionName,
      countsAsIntervention: !!entry.countsAsIntervention,
      label:
        `run ${entry.step} — ${bits.join(", ")}` +
        (after.length ? `; the same sequence then continues with ${after.map((s) => s.step).join(", ")}` : ""),
    });
  }

  for (const t of tickets) {
    if (!t.diagnosis) {
      moves.push({
        kind: "diagnose",
        ticket: t.id,
        label: `diagnose ${t.id} — the read-only team opens the code, the prompts and the transcripts. You do not.`,
      });
      continue;
    }
    const answered = new Set((t.answers || []).map((a) => String(a.question).trim()));
    for (const q of (t.diagnosis.questions || []).filter((q) => !answered.has(String(q).trim()))) {
      moves.push({
        kind: "answer",
        ticket: t.id,
        // The question travels on the move, so the manager never has to quote one back: `recordAnswer`
        // matches a question exactly and `diagnose.js` refuses to guess when a ticket holds several, and
        // a role that can only pick a button cannot mis-quote a sentence it was never asked to copy.
        question: q,
        label: `answer ${t.id}: "${q}" — say only what a customer is allowed to see (the folders, the reports, the plan).`,
      });
    }
    for (const o of t.options || []) {
      moves.push({
        kind: "choose",
        ticket: t.id,
        option: o.id,
        label:
          `choose ${o.id} on ${t.id} — ${o.label} [touches ${o.touches}; cost ${o.cost}; risk ${o.risk}]` +
          (o.requiresCodeChange ? " · needs the dev team" : ""),
      });
    }
    const chosen = (t.options || []).find((o) => o.id === (t.choice && t.choice.optionId));
    if (chosen && chosen.requiresCodeChange && !pending.some((p) => p.ticketId === t.id)) {
      moves.push({
        kind: "fix",
        ticket: t.id,
        label: `fix ${t.id} — call in the dev team for ${t.choice.optionId}. They work inside a boundary they may not widen.`,
      });
    }
  }

  // Defensive on purpose: `waitingPatches` already filtered this list, but a menu that offered the
  // re-judging of a decided patch would be a menu the gate then refuses, and a manager shown a move it
  // is about to be refused for is a manager that has to guess which of its options are real.
  for (const p of waitingPatches(pending)) {
    for (const outcome of ["accept", "reject"]) {
      moves.push({
        kind: "judge",
        patch: p.id,
        outcome,
        label: `judge ${p.id} ${outcome} — ${outcome === "accept" ? "the change lands in main and the cascade applies it" : "the change is put back"}. Say what the change does, not that the complaint stopped.`,
      });
    }
  }

  moves.push({
    kind: "escalate",
    label: "escalate — stop, and name in one sentence the decision that belongs to the account owner.",
  });

  // `end` is on the menu because the menu is now the tool list, and a manager with no way to say
  // "the run is finished" is a manager that escalates instead. It is the one move here that is not
  // offered *because it is legal* — it is offered so it can be refused: `endIsProvable` checks it
  // against the triage's verdict, the open tickets, the unjudged patches and the deliverable's
  // counts, and a "finish" primitive would be a command that claims a result instead of checking one
  // (gotcha 70).
  moves.push({
    kind: "end",
    label: "end — the run is finished. The machine checks this against the records before it accepts it.",
  });
  return moves;
}

/**
 * The tickets still unfinished: open, answered, or chosen. A closed ticket is a finished piece of
 * work — its closure says what the deliverable did — and re-opening it is the triage's job, not a
 * move here.
 *
 * @param {Object[]} all
 * @returns {Object[]}
 */
function unfinishedTickets(all) {
  return (all || []).filter((t) => t && t.status !== "closed");
}

/**
 * The patches waiting for a judgment. `utils/patches.js` has the list; this only keeps the ones the
 * manager has not decided, because a decided patch is not a question.
 *
 * @param {Object[]} all
 * @returns {Object[]}
 */
function waitingPatches(all) {
  return (all || []).filter((p) => p && patches.UNJUDGED_STATUSES.includes(p.status));
}

/**
 * In watch mode, the question this plan would put in writing, shown as a record that is clearly not
 * one.
 *
 * Watch mode writes nothing, so no ticket exists, so `diagnose` would be an illegal move and the
 * manager would be left with `escalate` as its only answer — which is a correct but useless reading
 * of a state whose honest answer is a question. Showing the question the triage would ask (the exact
 * text `delivery.js --open-ticket` would write, from the same table) makes the rehearsal mean what it
 * claims to mean, and the status line says out loud that it was not written.
 *
 * @param {Object} args
 * @param {import("./utils/resume").ResumePlan} args.plan
 * @param {string} args.run
 * @returns {Object|null}
 */
function previewTicketFor({ plan, run }) {
  const step = (plan.steps || []).find((s) => s.action === "ticket");
  if (!step || step.existingTicket) return null;
  const question = delivery.questionForEscalation(step);
  if (!question) return null;
  return {
    id: `PREVIEW-${step.step}-${step.fromVolume || "whole-step"}`,
    run,
    step: step.step,
    volume: step.fromVolume || null,
    finding: step.finding || "unspecified",
    status: "PREVIEW — not written. Watch mode writes nothing.",
    question,
    evidence: [],
    tried: [],
    ruledOut: [],
  };
}

/**
 * The record a decision names, when it names one.
 *
 * @param {import("./utils/manager").ManagerAction} action
 * @param {Object[]} tickets
 * @returns {Object|null}
 */
function ticketNamed(action, tickets = []) {
  if (!action.ticket) return null;
  return (tickets || []).find((t) => t && t.id === action.ticket) || null;
}

module.exports = {
  offerMoves,
  unfinishedTickets,
  waitingPatches,
  previewTicketFor,
  ticketNamed,
};

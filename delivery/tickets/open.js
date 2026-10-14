/**
 * The three doors that write a ticket: the gate refusal, the question the plan itself proposes, and
 * one ticket per bounded investigation. Each is idempotent through the ticket channel rather than
 * through a counter it keeps, and each names everything it declined to open, with the reason.
 *
 * Part of the delivery/tickets.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions
const { createTicket, readTickets, investigationsAlreadyAsked } = require("../../utils/tickets");
const { evidenceForStep, triedForStep, evidenceForInvestigation } = require("./evidence");
const { questionForEscalation } = require("./question");

/**
 * The question the manager asks when a GATE stops it. Findings-shaped, never outcome-shaped
 * (`utils/tickets.js` refuses the other shape), and it names what was already tried out of the
 * ledger rather than out of the manager's memory.
 *
 * @param {import("../../utils/resume").ResumeStepPlan} step
 * @param {import("../../utils/resume").ResumePlan} plan
 * @param {Object} state - The working state the plan was built from.
 * @param {string} reason - The gate's refusal.
 * @param {string} run
 * @returns {{ticket: Object|null, problems: Object[]}}
 */
function openTicketFor({ step, plan, state, reason, run }) {
  const result = createTicket({
    run,
    step: step.step,
    volume: step.fromVolume,
    finding: step.finding || "unspecified",
    evidence: evidenceForStep(step, state, reason),
    tried: triedForStep(step.step, run),
    ruledOut: [
      `re-running ${step.step} as it stands — the plan already proposes it and the ledger says what it produced`,
      "deleting the gate evidence — Tier C, and not mine to do",
    ],
    question:
      `"${step.actionName}" on ${step.step}${step.fromVolume ? ` volume ${step.fromVolume}` : ""} has been tried and ` +
      `the deliverable did not move. What is producing ${step.finding || "this finding"} that removing ` +
      `${step.step}'s output and running it again does not remove?`,
  });

  return { ticket: result.ticket, problems: result.problems || [] };
}

/**
 * Open the ticket the plan itself proposes — the verb the `open-ticket` menu entry was missing.
 *
 * Without it the closed menu had an entry with no command behind it: `executableSteps` returns
 * nothing for a `ticket` line, so act mode executed nothing and only a GATE refusal ever reached
 * `openTicketFor`. A plan whose honest answer is a question could therefore only report that it
 * had a question, which is the shape of a manager that escalates by giving up.
 *
 * It is IDEMPOTENT on purpose: the autopilot may call it on every iteration, and the plan's triage
 * already names the live ticket for this exact (step, volume, finding) rather than proposing a
 * duplicate (gotcha 71's correspondence half). Re-opening the same complaint would put two tickets
 * in front of the diagnostics team and make the ledger's "already tried" list describe neither.
 *
 * @param {{plan: import("../../utils/resume").ResumePlan, state: Object, run: string}} opts
 * @returns {{exitCode: number, ticket: Object|null, problems: Object[], note: string}}
 */
function openTicketFromPlan({ plan, state, run }) {
  const step = (plan.steps || []).find((s) => s.action === "ticket");
  if (!step) {
    return {
      exitCode: 2,
      ticket: null,
      problems: [],
      note:
        `the plan does not name a ticket to open — its resume point is "${plan.verdict}". ` +
        "Run `npm run delivery` and read the report: a ticket is opened when the plan says the answer " +
        "is a question, and this plan does not.",
    };
  }

  if (step.existingTicket) {
    // The full record, not just the id the triage carried: the manager needs the question and the
    // next command printed, or "already open" is a dead end.
    const full = (readTickets().tickets || []).find((t) => t && t.id === step.existingTicket.id) || step.existingTicket;
    return {
      exitCode: 0,
      ticket: full,
      problems: [],
      alreadyOpen: true,
      note:
        `ticket ${step.existingTicket.id} is already ${step.existingTicket.status} for this exact ` +
        `${step.step} / ${step.fromVolume || "whole step"} / ${step.finding || "finding"}. Nothing new was opened.`,
    };
  }

  const question = questionForEscalation(step);
  if (!question) {
    return {
      exitCode: 2,
      ticket: null,
      problems: [],
      note:
        `the plan escalates ${step.step} to a question for a reason this command does not know how to ask ` +
        `(${String(step.escalation)}). Read the plan's own reasons and write the ticket by hand, or report ` +
        `this to the account owner — a question written from the wrong premise gets answered by removing ` +
        `the complaint.`,
    };
  }

  const reason = (step.reasons || []).join(" ") || `the plan's answer for ${step.step} is a question`;
  const result = createTicket({
    run,
    step: step.step,
    volume: step.fromVolume,
    finding: step.finding || "unspecified",
    evidence: evidenceForStep(step, state, reason),
    tried: triedForStep(step.step, run),
    ruledOut: [
      `re-running ${step.step} as the plan would run it — the plan refuses that itself, and its reasons say why`,
      "deleting the gate evidence — Tier C, and not mine to do",
      "turning off the guard that produced the evidence — Tier C, and the account owner's decision alone",
    ],
    question,
  });

  if (!result.ticket) {
    return {
      exitCode: 1,
      ticket: null,
      problems: result.problems || [],
      note: "the ticket was refused by the shape rules in utils/tickets.js. Nothing was written.",
    };
  }
  return {
    exitCode: 0,
    ticket: result.ticket,
    problems: result.problems || [],
    note: `opened ticket ${result.ticket.id} for ${step.step}${step.fromVolume ? ` volume ${step.fromVolume}` : ""}.`,
  };
}

/**
 * Open one ticket per investigation this run is allowed to pay for — and never a second one for a
 * question the channel already holds.
 *
 * This is the door slice 3's bound needs to mean anything: the plan says which questions are
 * `actionable`, and a ticket is what makes an answer **reusable**. Without a ticket the answer would
 * live only in a diagnostics transcript, and the next volume with the same finding would pay for the
 * same 702-second reading pass again. With one, the next pass reads `answered` and spends nothing.
 *
 * It is idempotent through the ticket channel itself (`investigationsAlreadyAsked`), not through a
 * counter it keeps: a run that calls it twice opens nothing the second time. It opens tickets for
 * `actionable` entries ONLY — a `deferred` question is reported in `deferred`, because paying for it is
 * exactly what the bound refuses, and a `pending` or `answered` one already has its ticket.
 *
 * What it does NOT do is open tickets on its own initiative. Nothing in the run calls it
 * automatically: `endIsProvable` refuses `end` while any ticket is open, and an investigation
 * question is deliberately NOT closed by running the step it names — running a step is not an
 * answer to "why does this finding keep happening", and closing the ticket would also make the
 * bound forget the question was ever asked and pay for it twice. It is a verb a person runs on
 * purpose, and the answer that closes the loop is a diagnosis on the ticket, not a step run.
 *
 * @param {Object} opts
 * @param {import("../../utils/resume").ResumePlan} opts.plan - The triage, with its bounded investigations.
 * @param {Object} opts.state - The working state the plan was read from.
 * @param {string} opts.run - The run the tickets belong to.
 * @returns {{opened: Object[], tickets: Object[], skipped: Object[], deferred: Object[], problems: Object[], note: string}}
 */
function openInvestigationTickets({ plan, state, run }) {
  const inv = (plan && plan.investigations) || [];
  const actionable = inv.filter((i) => i.status === "actionable");
  const deferred = inv.filter((i) => i.status === "deferred");
  /** @type {Object[]} */ const opened = [];
  /** @type {Object[]} */ const skipped = [];
  /** @type {Object[]} */ const problems = [];

  // Everything the door declines to open is named with the reason, including the questions the bound
  // refused to pay for. A door that opens two tickets and says nothing about the other two is the
  // silent drop this slice exists to remove.
  for (const i of inv) {
    if (i.status === "deferred") {
      skipped.push({ step: i.step, kind: i.kind, status: i.status, ticketId: null, because: i.deferredBecause });
      continue;
    }
    if (i.status === "pending" || i.status === "answered") {
      skipped.push({
        step: i.step,
        kind: i.kind,
        status: i.status,
        ticketId: i.ticketId || null,
        because: i.status === "answered" ? "already answered — the answer is on that ticket" : "already open and unanswered",
      });
      continue;
    }
  }

  for (const i of actionable) {
    const asked = investigationsAlreadyAsked({ run, step: i.step, kind: i.kind });
    if (asked.error) {
      problems.push({
        kind: "tickets-unreadable",
        message:
          `the ticket channel could not be read (${asked.error}), so nothing can be known about what is ` +
          `already asked. Nothing was opened for ${i.step} / ${i.kind}: opening a question blind is how ` +
          `the same one gets asked twice and reported as progress.`,
      });
      continue;
    }
    if (asked.asked && asked.ticket) {
      // The plan said this one was fresh and the channel says otherwise — the plan was read before
      // something else wrote the ticket. The channel wins, because the channel is the record.
      skipped.push({
        step: i.step,
        kind: i.kind,
        status: asked.answered ? "answered" : "pending",
        ticketId: asked.ticket.id,
        because: asked.answered ? "answered after the plan was read" : "opened after the plan was read",
      });
      continue;
    }
    const result = createTicket({
      run,
      step: i.step,
      volume: null,
      finding: i.kind,
      askedAs: "investigation",
      evidence: evidenceForInvestigation(i, state),
      tried: triedForStep(i.step, run),
      ruledOut: [
        `paying for this question again in a later volume — the bound is one investigation per (kind, step) per run`,
        `running ${i.step} again — the plan does not propose it for a ${i.level} finding`,
      ],
      question: i.question,
    });
    if (!result.ticket) {
      problems.push({
        kind: "ticket-refused",
        message:
          `the ticket for ${i.step} / ${i.kind} was refused by the shape rules in utils/tickets.js: ` +
          `${(result.problems || []).map((p) => p.message).join(" ") || "no reason given"}`,
      });
      continue;
    }
    opened.push(result.ticket);
  }

  const ceiling = (plan && plan.investigationCeiling) || {};
  const note =
    `opened ${opened.length} investigation ticket(s) of ${actionable.length} actionable question(s) ` +
    `(ceiling ${ceiling.maxPerRun ?? "?"} per run; ${skipped.length} question(s) not opened, ` +
    `${deferred.length} of them not paid for).`;
  return { opened, tickets: opened, skipped, deferred, problems, note };
}

module.exports = {
  openTicketFor,
  openTicketFromPlan,
  openInvestigationTickets,
};

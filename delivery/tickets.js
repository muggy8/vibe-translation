/**
 * The questions the manager is allowed to ask: the evidence it actually looked at, what it already tried (read out of the ledger, not from memory), and the wording keyed on the triage's own escalation — the triage REFUSED to try, so a ticket claiming an attempt that never happened gets answered by switching the guard off.
 *
 * Part of the delivery.js layer (split out of the original single file).
 */

require("../types"); // JSDoc type definitions
const {
  measureDeliverable,
  compareDeliverable,
  describeComparison,
  accountOf,
  summarizeSnapshot,
  closureFromComparison,
} = require("../utils/delivery-verify");
const { readLedger, appendLedgerEntry } = require("../utils/ledger");
const { createTicket, closeTicket, recordChoice, readTickets, investigationsAlreadyAsked } = require("../utils/tickets");
const patches = require("../utils/patches");

/**
 * What the manager is allowed to cite as evidence for one step of the plan: the assessment's own
 * findings for that step and volume, and nothing else. It has not read the code, the prompts or the
 * run transcripts, so a ticket that cited them would be the manager reaching into the container it
 * is not allowed to open (gotcha 74 checks the same boundary on the ANSWER side).
 *
 * When the assessment named nothing citable — it could not run, or the plan was not built from a
 * triage — the fallback names the report the diagnostics team should read rather than inventing
 * evidence the manager did not look at.
 *
 * @param {import("./utils/resume").ResumeStepPlan} step
 * @param {Object} state - The working state the plan was built from.
 * @param {string} reason - The sentence that explains why a question is being asked at all.
 * @returns {Array<{file: string, note: string}>}
 */
function evidenceForStep(step, state, reason) {
  const stepState = (state.stepStates || []).find((s) => s.step === step.step) || {};
  const evidence = [];
  const cite = (f, label) => {
    if (!f) return;
    if (step.fromVolume && f.volume && String(f.volume) !== String(step.fromVolume)) return;
    evidence.push({ file: f.file, note: `${label} ${f.kind}: ${f.message}` });
  };
  /**
   * The label a ticket cites beside a finding.
   *
   * It used to be the literal `[HIGH]`, which was true by construction only while "damage" meant
   * "severity HIGH". Damage is now decided by the finding's LEVEL, so a MAJOR finding emitted at MEDIUM
   * was being stamped `[HIGH]` on the ticket — a claim about the finding that the routing no longer
   * makes. Cite the level, with the severity beside it, and say so out loud when the level was defaulted
   * because the kind is not in the table.
   *
   * @param {Object} f - A post-mortem finding.
   * @returns {string}
   */
  const citeLabel = (f) => {
    const level = f.levelDeclared === false ? "UNDECLARED" : f.level;
    return level && f.severity ? `[${level}/${f.severity}]` : `[${level || f.severity || "unknown"}]`;
  };
  for (const f of stepState.damageFindings || []) cite(f, citeLabel(f));
  for (const f of stepState.evidenceFindings || []) cite(f, citeLabel(f));
  if (!evidence.length) {
    evidence.push({
      file: `${step.step}.md (post-mortem report)`,
      note: `the assessment for ${step.step}: ${step.finding || "no finding named"} — ${reason}`,
    });
  }
  return evidence;
}


/**
 * What has already been tried on this step, read out of the ledger rather than out of the
 * manager's memory, so "this is the third time" is a query with citable ids and a spin cannot be
 * laundered into a fresh request (gotcha 70).
 *
 * @param {string} stepName
 * @param {string} run
 * @returns {Array<{action: string, outcome: string, ledgerId: string}>}
 */
function triedForStep(stepName, run) {
  return (readLedger().entries || [])
    .filter((e) => e.kind === "intervention" && e.step === stepName && e.run === run)
    .map((e) => ({ action: e.action, outcome: e.outcome, ledgerId: e.id }));
}


/**
 * The question the manager asks when a GATE stops it. Findings-shaped, never outcome-shaped
 * (`utils/tickets.js` refuses the other shape), and it names what was already tried out of the
 * ledger rather than out of the manager's memory.
 *
 * @param {import("./utils/resume").ResumeStepPlan} step
 * @param {import("./utils/resume").ResumePlan} plan
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
 * The questions the triage asks when it is the PLAN that says "this is a question, not a re-run".
 *
 * `openTicketFor` above is written for a gate refusal: something was tried and the deliverable did
 * not move. The triage's own escalation has not tried anything yet — it refused to try, because
 * re-running a deterministic gate reproduces the identical quarantine (gotcha 68). Asking the gate
 * shape here would state something that did not happen, and a ticket whose "already tried" list is
 * a fiction is the kind of ticket that gets answered by switching the guard off. So each escalation
 * kind asks the question that is actually true of it.
 *
 * Every one of them is interrogative and names a mechanism, never a wanted result: `utils/tickets.js`
 * refuses "make volume 15 pass" precisely because the cheapest way to satisfy a demand is to remove
 * the thing that reported the complaint (gotcha 70).
 *
 * @param {import("./utils/resume").ResumeStepPlan} step
 * @returns {string|null} - null when the plan names no escalation this table knows.
 */
function questionForEscalation(step) {
  const vol = step.fromVolume ? ` volume ${step.fromVolume}` : "";
  const finding = step.finding || "this finding";
  switch (step.escalation) {
    case "gate-removed":
      return (
        `Why is ${step.step}'s output missing for${vol} while that same step's own gate evidence sits in the ` +
        `same folder? Re-running the step writes the file and the same deterministic check then refuses it ` +
        `again, so the shape on disk is reproduced rather than repaired. What does the evidence say about ` +
        `what the check was refusing?`
      );
    case "audit-verdict":
      return (
        `Why does the consistency audit report a FAIL against the four artifacts it read, when nothing in the ` +
        `series has changed since the report was written? Re-auditing the same artifacts reproduces the same ` +
        `verdict, so which artifact disagrees with which one is the thing I cannot read.`
      );
    case "recurring-finding":
      return (
        `Why does ${finding} appear again on ${step.step}${vol} when the ledger records that the same finding ` +
        `survived an earlier recorded run? What is different this time, if anything?`
      );
    case "attempt-did-not-help":
      return (
        `${step.step}${vol} was run as the plan proposed, and the ledger records that the deliverable did not ` +
        `move afterwards. What is making ${step.step} fail in a way that removing ${step.step}'s output and ` +
        `running the step again does not remove?`
      );
    case "intervention-budget":
      return (
        `${step.step}${vol} has used the interventions it is allowed on one step in one run, and the deliverable ` +
        `did not move. What is producing ${finding} that those attempts did not?`
      );
    default:
      return null;
  }
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
 * @param {{plan: import("./utils/resume").ResumePlan, state: Object, run: string}} opts
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
 * What an investigation cites: the files the assessment named for that (kind, step), with the batch's
 * own message beside each one.
 *
 * The volume is deliberately absent from an investigation ticket — the question is about the finding
 * kind on the step, and the batch already folded every volume into it. The files are the evidence, and
 * they name the books.
 *
 * @param {Object} investigation - One bounded investigation entry.
 * @param {Object} state - The working state the plan was read from.
 * @returns {Array<{file: string, note: string}>}
 */
function evidenceForInvestigation(investigation, state) {
  const stepState = (state.stepStates || []).find((s) => s.step === investigation.step) || {};
  const batch = (stepState.gapBatches || []).find((b) => b.kind === investigation.kind) || {};
  const files = (investigation.files || []).slice(0, 5);
  if (files.length) {
    return files.map((f) => ({
      file: f,
      note: `[${investigation.level}] ${investigation.kind} in ${investigation.step}: ${batch.message || "the assessment named this file"}`,
    }));
  }
  return [
    {
      file: `${investigation.step}.md (post-mortem report)`,
      note:
        `the assessment for ${investigation.step}: ${investigation.kind} fired ${investigation.occurrences} ` +
        `time(s) — ${batch.message || "no file was named for it"}`,
    },
  ];
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
 * automatically: `endIsProvable` refuses `end` while any ticket is open, and no command closes a
 * ticket today, so a door that opened tickets by itself would make a clean run permanently
 * un-endable. It is a verb a person (or a later slice, once a closing door exists) runs on purpose.
 *
 * @param {Object} opts
 * @param {import("./utils/resume").ResumePlan} opts.plan - The triage, with its bounded investigations.
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

// ─── Act mode: the doing ──────────────────────────────────────────────────────


/**
 * Write the refusal down. A gate that refuses silently is a gate that gets worked around, and
 * "I considered this and stopped" is the half of the ledger a human needs in order to agree or
 * disagree with it.
 *
 * @param {{step: import("./utils/resume").ResumeStepPlan, run: string, reason: string, ticket: Object|null}} opts
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

// ─── Closing a ticket on the deliverable ──────────────────────────────────────


/**
 * Close a ticket by measuring the deliverable now and comparing it with the measurement taken
 * before the fix was attempted.
 *
 * This is the other half of the seam: act mode's ledger entry and a ticket's closure are produced
 * by the same comparison (`utils/delivery-verify.js`), so the manager cannot record `worse` in the
 * ledger and close the ticket `improved`. A ticket may not close as `finding-gone` — `closeTicket`
 * already refuses that — and it may not be closed on a judgement the deliverable does not support.
 *
 * @param {{ticketId: string, before: import("./utils/delivery-verify").DeliverableSnapshot,
 *   seriesDir?: string, note?: string}} opts
 * @returns {Promise<{ticket: Object|null, written: boolean, error: string|null,
 *   comparison: ReturnType<typeof compareDeliverable>}>}
 */
async function closeTicketOnDeliverable({ ticketId, before, seriesDir, note }) {
  const after = await measureDeliverable({ seriesDir });
  const comparison = compareDeliverable(before, after);
  const result = closeTicket(ticketId, closureFromComparison(comparison, note));
  return { ...result, comparison };
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

// ─── Main ─────────────────────────────────────────────────────────────────────


module.exports = {
  evidenceForStep,
  triedForStep,
  openTicketFor,
  questionForEscalation,
  openTicketFromPlan,
  evidenceForInvestigation,
  openInvestigationTickets,
  chooseOption,
  recordRefusal,
  closeTicketOnDeliverable,
  judgePatch,
};

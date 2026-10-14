/**
 * delivery/tickets.js — the ticket channel: the questions the manager may ask, the decisions it
 * records, and the measurement that closes a question.
 *
 * When a step fails this is what turns the failure into something somebody can answer. Four jobs,
 * and they are the four doors:
 *
 *   - **What may be cited.** The assessment's own findings for that step and volume, and what the
 *     ledger says this run already tried. The manager has not read the code, the prompts or the run
 *     transcripts, so a ticket citing those would be the manager reaching into the container it is
 *     not allowed to open (gotcha 74 checks the same boundary on the ANSWER side).
 *   - **The question itself.** Keyed on the triage's own escalation, because the triage REFUSED to
 *     try — re-running a deterministic gate reproduces the identical quarantine (gotcha 68) — and a
 *     ticket claiming an attempt that never happened is the ticket that gets answered by switching
 *     the guard off (gotcha 70).
 *   - **Opening it, and recording a decision on it.** The channel deliberately carries two keys:
 *     (step, volume, finding) for an ATTEMPT and (step, kind) for a QUESTION, so a fault that fired
 *     in 17 books is one question and not seventeen.
 *   - **Closing it.** From the before/after measurement of the actual deliverable, through the same
 *     comparison that wrote the ledger entry, so the layer cannot record `worse` in one place and
 *     close the ticket `improved` in the other. There is no verb a person can type instead.
 *
 * ## Where the code lives
 *
 * The code is in `delivery/tickets/`, one kind of job per file: `evidence.js` (what a ticket may
 * cite, and what this run already tried, read out of the ledger rather than from memory),
 * `question.js` (the wording for each escalation the triage knows), `open.js` (the three doors that
 * write a ticket, each idempotent through the channel rather than through a counter it keeps),
 * `record.js` (a choice, a refusal, and the manager's verdict on a patch — accept or reject, never
 * apply), and `close.js` (the closure, and the sentence that names why a ticket is still open).
 * This file is the public surface and the only thing another module should require.
 *
 * @module delivery/tickets
 */

require("../types"); // JSDoc type definitions

const evidence = require("./tickets/evidence");
const question = require("./tickets/question");
const open = require("./tickets/open");
const record = require("./tickets/record");
const close = require("./tickets/close");

// The public surface, unchanged from the single file.
module.exports = {
  evidenceForStep: evidence.evidenceForStep,
  triedForStep: evidence.triedForStep,
  evidenceForInvestigation: evidence.evidenceForInvestigation,
  questionForEscalation: question.questionForEscalation,
  openTicketFor: open.openTicketFor,
  openTicketFromPlan: open.openTicketFromPlan,
  openInvestigationTickets: open.openInvestigationTickets,
  chooseOption: record.chooseOption,
  recordRefusal: record.recordRefusal,
  judgePatch: record.judgePatch,
  whyTicketRemains: close.whyTicketRemains,
  closeTicketsAboutStepRun: close.closeTicketsAboutStepRun,
  ticketsStillOpenAfterPass: close.ticketsStillOpenAfterPass,
  closeTicketOnDeliverable: close.closeTicketOnDeliverable,
};

/**
 * Closing a ticket on the deliverable. Act mode already measured the deliverable before the step and
 * after it; that comparison is the answer to the question the step run provoked, so the same
 * comparison closes the ticket and writes the ledger entry. There is no verb a person can type
 * instead of this, and no knob on any of it.
 *
 * Part of the delivery/tickets.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions
// `describeComparison`, `accountOf` and `summarizeSnapshot` are carried unchanged from the single
// file's require block: nothing in this layer calls them, and a move does not delete what it finds.
const {
  measureDeliverable,
  compareDeliverable,
  describeComparison,
  accountOf,
  summarizeSnapshot,
  closureFromComparison,
} = require("../../utils/delivery-verify");
const { closeTicket, readTickets, matchesTicketKey } = require("../../utils/tickets");

/**
 * Why a ticket is still open after this plan ran.
 *
 * The reason has to be a fact about the run that just happened, because "the ticket is still open"
 * on its own reads as an oversight somebody should have cleaned up. It is not an oversight: the
 * ticket asks about something this plan did not do, and the honest sentence names the mismatch.
 *
 * @param {import("../../utils/tickets").Ticket} ticket
 * @param {{step: string, fromVolume: string|null, finding: string|null}} action - The action that ran.
 * @returns {string}
 */
function whyTicketRemains(ticket, action) {
  if (ticket.askedAs === "investigation") {
    return (
      `it is an investigation question about ${ticket.step} / ${ticket.finding} — "why does this finding ` +
      `happen", which running ${action.step} does not answer. Its answer is a diagnosis on the ticket ` +
      `itself (npm run diagnose -- --ticket=${ticket.id}).`
    );
  }
  if (ticket.step !== action.step) {
    return (
      `it is about ${ticket.step}, and the action that just ran was ${action.step}. A ticket closes ` +
      `only on a measurement of the step it names.`
    );
  }
  const wantVolume = action.fromVolume === undefined || action.fromVolume === null ? null : String(action.fromVolume);
  const haveVolume = ticket.volume === undefined || ticket.volume === null ? null : String(ticket.volume);
  if (haveVolume !== wantVolume) {
    return (
      `it asks about ${haveVolume === null ? "the whole step" : `volume ${haveVolume}`}, and this run picked ` +
      `${action.step} up at ${wantVolume === null ? "the whole step" : `volume ${wantVolume}`}. The ` +
      `measurement says nothing about the work the ticket is asking about.`
    );
  }
  if (ticket.finding !== action.finding) {
    return (
      `it asks about ${ticket.finding}, and what this run did to ${action.step} was a response to ` +
      `${action.finding || "no named finding"}. Different question, different answer.`
    );
  }
  return `nothing this plan ran is the answer to it, and a ticket closes only on a measurement of the work it names.`;
}

/**
 * Close the tickets the step run in front of this comparison is the answer to.
 *
 * **This is the bottom of the escalation ladder, and it is a measurement.** `delivery/act.js`
 * already snapshots the deliverable before the step, runs the step, re-measures, and writes the
 * comparison to the ledger. A ticket opened about this exact (step, volume, finding) is a question
 * whose answer is that comparison, so the comparison closes it — the same `closureFromComparison`
 * that produced the ledger entry, so the manager cannot record `worse` in the ledger and close the
 * ticket `improved`.
 *
 * Before this existed the ladder had no bottom: `autopilot/loop.js` runs `delivery.js --open-ticket`
 * by itself in act mode, `endIsProvable` refuses `end` while any ticket is open, and nothing closed
 * one. Measured on the fixture at commit 48317f4: the step ran, the deliverable **improved**, the
 * triage said `nothing-to-do`, and `endIsProvable` still answered
 * `1 ticket(s) still open: TCK-run-probe-1 (open)` — every act run that ever escalated was
 * un-endable, and the loop's last line was "stopped after N decisions without a provable end".
 *
 * What it refuses to close:
 *   - **an investigation question** (`askedAs: "investigation"`). It asks why a finding kind keeps
 *     happening on a step; running the step is not an answer to that, and closing it would make
 *     `investigationsAlreadyAsked` stop counting the question as asked and spend a second
 *     diagnostics turn on it.
 *   - **anything that does not match the action's own (step, volume, finding)** — the same key
 *     `matchesTicketKey` and the anti-spin gate use, unchanged. A ticket about volume 01 is not
 *     closed by a run that picked the step up at volume 02, and it is reported with that sentence.
 *
 * Tier C: closing is a record. The ticket, its evidence, its diagnosis, its options, its choice and
 * its history all stay in the file; only `status`, `closure` and `closedAt` are added.
 *
 * @param {{step: import("../../utils/resume").ResumeStepPlan, comparison: Object, ledgerId: string|null}} opts
 * @returns {{closed: Array<{id: string, outcome: string, note: string}>,
 *   stillOpen: Array<{id: string, step: string, volume: string|null, finding: string, status: string, because: string}>,
 *   problems: Object[]}}
 */
function closeTicketsAboutStepRun({ step, comparison, ledgerId }) {
  const current = readTickets();
  if (current.error) {
    return {
      closed: [],
      stillOpen: [],
      problems: [
        {
          kind: "tickets-unreadable",
          message:
            `the ticket channel could not be read (${current.error}), so no ticket could be closed. ` +
            `A step that improved the deliverable left its question open and uncountable.`,
        },
      ],
    };
  }

  const key = { step: step.step, volume: step.fromVolume, finding: step.finding };
  const closure = closureFromComparison(
    comparison,
    `closed by ${step.actionName || "the plan's action"} on ${step.step}` +
      `${step.fromVolume ? ` volume ${step.fromVolume}` : ""} against ${step.finding || "the finding the plan named"}` +
      `${ledgerId ? `; ledger ${ledgerId}` : ""}`
  );

  /** @type {Array<{id: string, outcome: string, note: string}>} */ const closed = [];
  /** @type {Array<{id: string, step: string, volume: string|null, finding: string, status: string, because: string}>} */ const stillOpen = [];
  /** @type {Object[]} */ const problems = [];

  for (const t of current.tickets) {
    if (!t || t.status === "closed") continue;
    const isMine = Boolean(step.finding) && t.askedAs !== "investigation" && matchesTicketKey(t, key);
    if (isMine) {
      const result = closeTicket(t.id, closure);
      if (result.error) {
        problems.push({
          kind: "ticket-not-closed",
          message: `ticket ${t.id} could not be closed (${result.error}). It stays ${t.status}, and the end stays refused.`,
        });
        stillOpen.push({ id: t.id, step: t.step, volume: t.volume, finding: t.finding, status: t.status, because: `the closure could not be written (${result.error})` });
        continue;
      }
      closed.push({ id: t.id, outcome: closure.outcome, note: closure.note });
      continue;
    }
    // Only the tickets about THIS step are reported here: every step in the pass would otherwise
    // print every unrelated ticket, and the pass-level `ticketsStillOpenAfterPass` is what names
    // the rest. What belongs on this line is "the step ran and its own question is still open".
    if (t.step === step.step) {
      stillOpen.push({ id: t.id, step: t.step, volume: t.volume, finding: t.finding, status: t.status, because: whyTicketRemains(t, step) });
    }
  }
  return { closed, stillOpen, problems };
}

/**
 * Every ticket still open after a whole act pass, each with the reason it is still open.
 *
 * Read from the channel rather than carried in memory, because the pass itself closed some of them:
 * the report has to describe the tickets that are open NOW, not the ones the plan started with.
 *
 * @param {Array<{step: string, actionName: string|null, fromVolume: string|null, finding: string|null}>} executed
 * @returns {Array<{id: string, step: string, volume: string|null, finding: string, status: string, because: string}>}
 */
function ticketsStillOpenAfterPass(executed) {
  const current = readTickets();
  const open = (current.tickets || []).filter((t) => t && t.status !== "closed");
  return open.map((t) => {
    const action = executed.find((e) => e.step === t.step) || { step: t.step, fromVolume: null, finding: null };
    return {
      id: t.id,
      step: t.step,
      volume: t.volume,
      finding: t.finding,
      status: t.status,
      because: current.error
        ? `the ticket channel could not be read (${current.error})`
        : whyTicketRemains(t, action),
    };
  });
}

/**
 * Close a ticket by measuring the deliverable now and comparing it with the measurement taken
 * before the fix was attempted.
 *
 * This is the other half of the seam: act mode's ledger entry and a ticket's closure are produced
 * by the same comparison (`utils/delivery-verify.js`), so the manager cannot record `worse` in the
 * ledger and close the ticket `improved`. A ticket may not close as `finding-gone` — `closeTicket`
 * already refuses that — and it may not be closed on a judgement the deliverable does not support.
 *
 * @param {{ticketId: string, before: import("../../utils/delivery-verify").DeliverableSnapshot,
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

module.exports = {
  whyTicketRemains,
  closeTicketsAboutStepRun,
  ticketsStillOpenAfterPass,
  closeTicketOnDeliverable,
};

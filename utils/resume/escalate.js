/**
 * The manager's own correspondence, read back into the triage.
 *
 * The triage's one real blind spot used to be this: it could say "this shape needs a question" but
 * not "I already asked that question, and somebody has already written an answer for it" — so on a
 * series where a fix had already landed, the plan kept re-escalating the same disk shape forever and
 * act mode executed nothing forever. The ticket it wrote and the patch it was handed are the two
 * records in this layer a customer is allowed to read, so reading them is not the manager reaching
 * into the code: it is the manager remembering its own conversation.
 *
 * Both arrive as fields of the state rather than being opened here, for the reason gotcha 71 ends
 * with: `planResume` is a **pure function of a state**, and a decision that opened `tickets.json` by
 * itself would make a hand-built test state silently read the real series' correspondence.
 *
 * Part of the resume.js layer (split out of the original single file).
 */

const { matchesTicketKey } = require("../tickets");

/**
 * Look up what the ticket channel and the patch channel already say about one exact
 * (step, volume, finding).
 *
 * "Newest" is the LAST matching ticket, because tickets are appended: it is the one that carries the
 * ledger's account of what has been tried since, and it is the one escalation reasoning has to read.
 * A patch counts as answering it only when the manager has said yes — `accepted` (in the tree,
 * awaiting the dev team's commit) or `committed` (in `main`). A `proposed` patch does not supersede
 * anything: it is unjudged code, and act mode refuses the whole plan while one is open (gotcha 75).
 *
 * @param {Object} state - The working state.
 * @param {string} step - The step this plan is about.
 * @param {string|null} volume - The volume it picked up at.
 * @returns {(finding: string|null) => { matching: Array, newest: Object|null, live: Object|null, answered: Object|null }}
 */
function openChannels(state, step, volume) {
  const tickets = state.tickets || [];
  const patches = state.patches || [];

  return function channelFor(finding) {
    if (!finding) return { matching: [], newest: null, live: null, answered: null };
    const matching = tickets.filter((t) => matchesTicketKey(t, { step, volume, finding }));
    const newest = matching.length ? matching[matching.length - 1] : null;
    const live = newest && newest.status !== "closed" ? newest : null;
    const answered = newest
      ? patches.find((p) => p && p.ticketId === newest.id && ["accepted", "committed"].includes(p.status)) || null
      : null;
    return { matching, newest, live, answered };
  };
}

/**
 * Build the one helper that can turn the repair into a question.
 *
 * Three outcomes, and the difference between them is the whole point:
 *   - **superseded** — an accepted/committed patch answers the ticket for this exact finding, so the
 *     guard that produced this disk shape is not the guard that will run. The repair stands.
 *   - **already open** — the plan names the ticket it already wrote instead of proposing a duplicate,
 *     so `delivery.js --open-ticket` and the autopilot work the existing one.
 *   - **a new question** — nothing live matches, so the escalation stands and the reason says what
 *     the previous ticket's closure measured.
 *
 * The supersede half applies to the three "re-running reproduces the same result" tells and NOT to
 * `intervention-budget`, and the asymmetry is the point: a patch record does not refund the attempts
 * this run already made, and applying the patch is itself the counted wipe-and-cascade. A code change
 * cannot un-spend an allowance, so a step that used up its attempts is still out of moves whatever
 * else has landed.
 *
 * @param {{ plan: ResumeStepPlan, notes: string[], channelFor: Function }} target
 * @returns {(kind: string, subject: string, reasons: string[]) => boolean} True when the plan became a ticket.
 */
function escalatorFor({ plan, notes, channelFor }) {
  /**
   * @param {("gate-removed"|"audit-verdict"|"recurring-finding"|"intervention-budget")} kind - Which
   *   check fired. Recorded on the plan so the report can name the reason, not just the no.
   * @param {string} subject - The short clause the headline and the reason both read.
   * @param {string[]} reasons - Why a re-run is the spin here.
   * @returns {boolean}
   */
  return function escalate(kind, subject, reasons) {
    const { newest, live, answered } = channelFor(plan.finding);
    if (answered && kind !== "intervention-budget") {
      plan.reasons.push(
        `${subject} — but ${answered.id} (${answered.status}) answers ticket ${newest.id} for this exact finding, ` +
          "so the code that produced this disk shape is not the code that will run. " +
          (plan.actionName === "wipe-and-cascade"
            ? "The cascade is what makes that change take effect: the skip checks do not know the code changed (gotcha 66)."
            : "A plain re-run is legitimate again.")
      );
      if (answered.status === "accepted") {
        notes.push(
          `${answered.id} is accepted but not yet committed. The commit is the dev team's act: npm run fix -- --commit=${answered.id}.`
        );
      }
      return false;
    }
    plan.action = "ticket";
    plan.actionName = "open-ticket";
    plan.cascade = false;
    plan.wipeFirst = [];
    plan.countsAsIntervention = false;
    plan.escalation = kind;
    plan.reasons.push(...reasons);
    if (live) {
      plan.existingTicket = { id: live.id, status: live.status };
      plan.reasons.push(
        `this question is already open as ${live.id} (${live.status}) — the move is to work that ticket, ` +
          "not to write a second one for the same finding."
      );
    } else if (newest) {
      const outcome = newest.closure && newest.closure.outcome ? newest.closure.outcome : "closed";
      plan.reasons.push(
        `the last ticket for this finding (${newest.id}) closed ${outcome}. That answer did not move the deliverable, ` +
          "so the shape is still here and time passing does not make a re-run legitimate; a new ticket is written with the ledger's account of what was tried."
      );
    }
    return true;
  };
}

module.exports = { openChannels, escalatorFor };

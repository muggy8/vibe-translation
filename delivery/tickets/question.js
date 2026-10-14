/**
 * The question a ticket asks, keyed on the triage's own escalation. Each kind gets the sentence that
 * is actually true of it: the triage REFUSED to try anything, and a ticket whose "already tried" list
 * is a fiction is the kind that gets answered by switching the guard off.
 *
 * Part of the delivery/tickets.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions

/**
 * The questions the triage asks when it is the PLAN that says "this is a question, not a re-run".
 *
 * `openTicketFor` (in `open.js`) is written for a gate refusal: something was tried and the deliverable did
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
 * @param {import("../../utils/resume").ResumeStepPlan} step
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

module.exports = {
  questionForEscalation,
};

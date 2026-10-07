/**
 * The three gates every act-mode step passes before anything is touched: the closed action menu (a Tier C move is refused BY NAME at execution time, not only in the proposal), the per-step intervention budget, and the anti-spin ledger. A refusal wipes nothing — a refusal that deleted first would be indistinguishable from a fix.
 *
 * Part of the delivery.js layer (split out of the original single file).
 */

require("../types"); // JSDoc type definitions
const {
  readWorkingState,
  planResume,
  actionIsAvailable,
  maxInterventionsPerStep,
  interventionsUsed,
} = require("../utils/resume");
const { readLedger, interventionAllowed } = require("../utils/ledger");

/**
 * The steps act mode will try to execute, in run order.
 *
 * `run` is the step the run stopped at; `after` are the steps that must follow it. Both are
 * executed: a manager that fixed the glossary and then stopped has not resumed the run, it has
 * answered a question. `ticket`, `blocked` and `none` are not actions.
 *
 * @param {import("./utils/resume").ResumePlan} plan
 * @returns {import("./utils/resume").ResumeStepPlan[]}
 */
function executableSteps(plan) {
  const steps = plan.steps || [];
  const primary = steps.find((s) => s.action === "run" && s.actionName);
  if (!primary) {
    // The plan's own answer is a question, a block, or "nothing to do". The steps listed after
    // the resume point are written on the assumption that the resume point was repaired — running
    // them anyway spends a real run's worth of model calls on a foundation this manager could
    // not fix, which is the exact mistake `planResume` exists to avoid.
    return [];
  }
  return steps.filter((s) => (s.action === "run" || s.action === "after") && s.actionName);
}


/**
 * Gate 1: is this action on the closed menu at all?
 *
 * `planResume` already only names menu entries, and `main` re-checks the whole plan. This is
 * the same check at the moment of execution rather than the moment of proposal, because the
 * thing being protected is the disk, not the report.
 *
 * @param {import("./utils/resume").ResumeStepPlan} step
 * @returns {{allowed: boolean, why: string|null}}
 */
function gateMenu(step) {
  const verdict = actionIsAvailable(step.actionName);
  return { allowed: verdict.allowed, why: verdict.allowed ? null : verdict.why };
}


/**
 * Gate 2: has this step already had this action against this finding, and did it help?
 *
 * @param {import("./utils/resume").ResumeStepPlan} step
 * @param {string} run
 * @returns {{allowed: boolean, why: string|null, attempts: number, unhelpful: number}}
 */
function gateSpin(step, run) {
  const key = { step: step.step, finding: step.finding, action: step.actionName, volume: step.fromVolume };
  if (!key.finding) {
    if (step.countsAsIntervention) {
      // A destructive action with no named finding is the shape this layer exists to refuse: work
      // removed without an answer to "removed because of what?".
      return {
        allowed: false,
        why: `${step.actionName} removes work, and the plan did not name the finding it is a response to`,
        attempts: 0,
        unhelpful: 0,
      };
    }
    // A free action (picking up unfinished work) with no finding is the ordinary "continue the
    // pipeline" case. There is nothing to compare a repeat against, and inventing a finding kind
    // the post-mortem does not produce would make the ledger describe findings that never happened.
    return { allowed: true, why: null, attempts: 0, unhelpful: 0 };
  }
  const verdict = interventionAllowed(key, { run });
  return { allowed: verdict.allowed, why: verdict.allowed ? null : verdict.reason, attempts: verdict.attempts, unhelpful: verdict.unhelpful };
}


/**
 * Gate 3: does this step still have intervention budget left?
 *
 * Read from the ledger NOW, not from the state the plan was built from: act mode spends budget
 * as it goes, and a step that had three attempts left when the plan was written may have none
 * by the time the plan reaches it.
 *
 * @param {import("./utils/resume").ResumeStepPlan} step
 * @param {string} run
 * @returns {{allowed: boolean, why: string|null, used: number, budget: number}}
 */
function gateBudget(step, run) {
  const budget = maxInterventionsPerStep();
  const used = interventionsUsed(readLedger().entries, run)[step.step] || 0;
  if (!step.countsAsIntervention) return { allowed: true, why: null, used, budget };
  if (used >= budget) {
    return {
      allowed: false,
      used,
      budget,
      why:
        `${step.step} has already had ${used} of the ${budget} interventions it is allowed in this run. ` +
        "The budget is per step on purpose, so spending it is the signal that this step needs the " +
        "diagnostics team, not another attempt. Only the account owner may raise it.",
    };
  }
  return { allowed: true, why: null, used, budget };
}


/**
 * The step's progress out of a deliverable measurement.
 *
 * Kept because it is a fact a human reads ("2 of 2 volumes have the glossary files") and because
 * it is NOT the verdict: the verdict is the comparison. The count is the coarse half of the story,
 * the comparison is the half that can see a glossary shrink while every folder still has a file.
 *
 * @param {import("./utils/delivery-verify").DeliverableSnapshot} snapshot
 * @param {string} step
 * @returns {{built: number, missing: number}}
 */
function progressOf(snapshot, step) {
  return (snapshot.steps && snapshot.steps[step]) || { built: 0, missing: 0 };
}


module.exports = {
  executableSteps,
  gateMenu,
  gateSpin,
  gateBudget,
  progressOf,
};

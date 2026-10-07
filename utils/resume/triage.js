/**
 * Reading the working state as a step list: which step the run picks up at, which steps are left
 * alone, and which run afterwards.
 *
 * The triage is deliberately split from the decision (plan.js). This half answers "where is the
 * hole?" from the disk shape alone; it never proposes a move, and it never reads a ticket or a
 * patch. Keeping the two halves apart is what lets a test hand `planResume` a hand-built state and
 * be sure it is not silently reading the real series' correspondence.
 *
 * Part of the resume.js layer (split out of the original single file).
 */

/**
 * Index the per-step assessments by step name.
 * @param {Object} state - The working state (resume/state.js).
 * @returns {Map<string, Object>} step name → its assessment.
 */
function indexStepStates(state) {
  return new Map((state.stepStates || []).map((s) => [s.step, s]));
}

/**
 * Index the recurring finding classes by the step they recurred on.
 *
 * Built before the plan, because it changes what may be *advised*: `index.js` already refuses to
 * repeat "just re-run, it's cheap" when its own ledger says a re-run has not cleared it, and the
 * resume triage giving the opposite advice would undo that.
 *
 * @param {Object} state
 * @returns {Map<string, Array<{finding: string, steps: string[], runs: number}>}>
 */
function indexRecurringFindings(state) {
  /** @type {Map<string, Array<{finding: string, steps: string[], runs: number}>>} */
  const recurringFor = new Map();
  for (const r of state.recurring || []) {
    for (const stepName of r.steps) {
      if (!recurringFor.has(stepName)) recurringFor.set(stepName, []);
      recurringFor.get(stepName).push(r);
    }
  }
  return recurringFor;
}

/**
 * The first step in run order that did not finish what it claims to have.
 *
 * Only `incomplete` and `unknown` open the run. `gaps` and `quarantined` are findings beside work
 * that is finished, and choosing a resume point from *evidence that a gate once fired* proposes
 * throwing away completed volumes (see menu.js, and volume 15 of the live series).
 *
 * @param {string[]} order - The steps in run order.
 * @param {Map<string, Object>} stateByStep
 * @returns {{ index: number, reason: string }} `index` is -1 when nothing is unfinished.
 */
function findResumePoint(order, stateByStep) {
  for (let index = 0; index < order.length; index += 1) {
    const name = order[index];
    const st = stateByStep.get(name);
    if (!st) continue;
    if (st.status !== "incomplete" && st.status !== "unknown") continue;
    return {
      index,
      reason: st.error
        ? `${name} could not be assessed (${st.error})`
        : `${name} did not finish what it claims to have: ${st.damageKinds.join(", ")}`,
    };
  }
  return { index: -1, reason: "" };
}

/**
 * The steps before the resume point: left alone, with the reason they are left alone.
 *
 * @param {string[]} order
 * @param {Map<string, Object>} stateByStep
 * @param {number} resumeAt
 * @returns {ResumeStepPlan[]}
 */
function priorStepPlans(order, stateByStep, resumeAt) {
  /** @type {ResumeStepPlan[]} */
  const steps = [];
  for (let i = 0; i < resumeAt; i += 1) {
    const name = order[i];
    const st = stateByStep.get(name);
    const reasons = [st.status === "complete" ? "finished" : `finished with ${st.notes.length} non-blocking gap(s)`];
    if (st.status === "quarantined") {
      reasons.push(
        `gate evidence in volume(s) ${st.evidenceVolumes.join(", ")} beside output this step finished — worth reading, not worth rebuilding`
      );
    }
    steps.push(stepPlan(name, { action: "none", actionName: null, reasons }));
  }
  return steps;
}

/**
 * The steps after the resume point: they run afterwards because their inputs are about to change,
 * and a later step that is ALSO broken is normally a symptom of the earlier one, not a second
 * problem — which the plan says out loud instead of proposing two fixes.
 *
 * The translation stage's own entry gate is honoured here: it refuses to start on a FAIL or missing
 * consistency verdict, and bypassing that gate is Tier C. So when the audit is the problem, the
 * steps after it are reported as blocked rather than proposed.
 *
 * @param {string[]} order
 * @param {Map<string, Object>} stateByStep
 * @param {number} resumeAt
 * @param {string} resumeStep
 * @param {Map<string, Array<{finding: string, steps: string[], runs: number}>}> recurringFor
 * @param {string|null} inheritedFinding - The finding the whole plan is a response to.
 * @returns {ResumeStepPlan[]}
 */
function laterStepPlans(order, stateByStep, resumeAt, resumeStep, recurringFor, inheritedFinding) {
  const auditState = stateByStep.get("consistency-audit") || null;
  const auditVerdictFails = Boolean(auditState && auditState.damageKinds.some((k) => k === "audit-verdict-fail"));
  const auditReportMissing = Boolean(auditState && auditState.damageKinds.some((k) => k === "missing-required" || k === "audit-verdict-missing"));
  const TRANSLATION_STEPS = new Set(["translate", "translate-qa", "polish"]);

  /** @type {ResumeStepPlan[]} */
  const steps = [];
  for (let i = resumeAt + 1; i < order.length; i += 1) {
    const name = order[i];
    const st = stateByStep.get(name);
    const blocked = TRANSLATION_STEPS.has(name) && auditVerdictFails;
    /** @type {string[]} */
    const reasons = blocked
      ? ["the translation stage refuses to start on a FAIL consistency verdict, and re-auditing unchanged artifacts produces the same FAIL — bypassing that gate is Tier C"]
      : st.status === "incomplete"
        ? [`also unfinished, most likely because ${resumeStep} was: fix the earlier step first, then re-assess this one`]
        : [`its inputs are about to change, so it runs after ${resumeStep}`];
    if (!blocked && TRANSLATION_STEPS.has(name) && auditReportMissing) {
      reasons.push("it cannot start until `consistency-report.md` exists and says PASS — that entry gate is not mine to bypass");
    }
    const recurring = recurringFor.get(name) || [];
    if (recurring.length) {
      reasons.push(
        `the ledger says ${recurring.map((r) => `${r.finding} (${r.runs} runs)`).join(", ")} for this step already — a re-run has not cleared it before, so treat this as a question, not a cheap retry`
      );
    }
    if (!blocked && st.evidenceVolumes.length) {
      reasons.push(
        `gate evidence in volume(s) ${st.evidenceVolumes.join(", ")} — read it; it is not by itself a reason to rebuild a volume this step finished`
      );
    }
    steps.push(
      stepPlan(name, {
        action: blocked ? "blocked" : "after",
        actionName: blocked ? null : "re-run-step",
        reasons,
        // Each step picks up at its own earliest damaged volume, which is usually NOT the same one
        // the resume step picked up at: glossary may be whole through 14 while the voice reference
        // stopped at 02.
        fromVolume: st.volumes.length ? st.volumes[0] : null,
        // A step with its own damage names its own finding. A step that is complete and is only in
        // the plan because the resume step's fix invalidates it inherits the finding the whole plan
        // is a response to — otherwise the ledger has nothing to key on, and "have I already run
        // this step in this sequence, and did it help?" becomes a question the memory cannot answer.
        finding: st.damageKinds[0] || inheritedFinding || null,
      })
    );
  }
  return steps;
}

/**
 * The steps of a run where nothing is unfinished: everything is `none`, except a step with gate
 * evidence beside finished output, which gets the one move that is not a re-run — a ticket.
 *
 * This is the finding a manager is most tempted to "fix" by rebuilding a volume that is already
 * complete, so it is reported without being turned into work.
 *
 * @param {string[]} order
 * @param {Map<string, Object>} stateByStep
 * @returns {{ steps: ResumeStepPlan[], quarantined: string[], notes: string[] }}
 */
function finishedRunStepPlans(order, stateByStep) {
  /** @type {ResumeStepPlan[]} */
  const steps = [];
  /** @type {string[]} */
  const quarantined = [];
  /** @type {string[]} */
  const notes = [];
  for (const name of order) {
    const st = stateByStep.get(name);
    if (!st) continue;
    if (st.status === "gaps") {
      notes.push(`${name}: ${st.notes.length} non-blocking gap(s) — reported, not acted on.`);
    }
    if (st.status === "quarantined") {
      quarantined.push(name);
      notes.push(
        `${name}: gate evidence in volume(s) ${st.evidenceVolumes.join(", ")} beside output that is complete. ` +
          "A gate refused something at some point and the evidence was kept. Read it; it is not a reason to rebuild a volume that is finished."
      );
    }
    steps.push(
      st.status === "quarantined"
        ? stepPlan(name, {
            action: "ticket",
            actionName: "open-ticket",
            reasons: [
              `output for volume(s) ${st.evidenceVolumes.join(", ")} is complete, so this evidence is not a reason to rebuild it: a gate refused something at some point and the file was kept beside it`,
              "reading that evidence is a question for the diagnostics team, not a re-run — and it is not mine to delete (Tier C)",
              ...st.notes,
            ],
            fromVolume: st.evidenceVolumes[0] || null,
            finding: st.evidenceKinds[0] || null,
          })
        : stepPlan(name, { action: "none", actionName: "resume-here", reasons: [st.status] })
    );
  }
  return { steps, quarantined, notes };
}

/**
 * One line of the plan. Every field the menu and the ledger read has a default, so a step that does
 * not act cannot accidentally claim an intervention or a wipe.
 *
 * @param {string} step
 * @param {{action: string, actionName: string|null, reasons: string[], fromVolume?: string|null, finding?: string|null, cascade?: boolean, wipeFirst?: Array, flags?: string[], countsAsIntervention?: boolean}} fields
 * @returns {ResumeStepPlan}
 */
function stepPlan(step, fields) {
  return {
    step,
    action: fields.action,
    actionName: fields.actionName ?? null,
    reasons: fields.reasons,
    fromVolume: fields.fromVolume ?? null,
    cascade: fields.cascade ?? false,
    wipeFirst: fields.wipeFirst ?? [],
    flags: fields.flags ?? [],
    countsAsIntervention: fields.countsAsIntervention ?? false,
    finding: fields.finding ?? null,
  };
}

module.exports = {
  indexStepStates,
  indexRecurringFindings,
  findResumePoint,
  priorStepPlans,
  laterStepPlans,
  finishedRunStepPlans,
  stepPlan,
};

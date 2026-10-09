/**
 * The decision. The repair shape is computed FIRST, then the four 're-running reproduces the same
 * result' checks run through one escalate() helper that either overwrites the plan with a ticket or
 * is superseded by an answered ticket or a landed patch — deliberately NOT applied to the
 * intervention budget, because a code change cannot un-spend attempts this run already made.
 *
 * Reading order of this file, which is the order the decision is made in:
 *   planResume            — pick the branch (no plan of record / nothing unfinished / resume here)
 *   resumeHere            — one step: choose its repair, then ask whether the repair is the spin
 *   chooseRepair          — the primitive, before anybody has objected to it
 *   raiseStructuralTells  — the shapes where a re-run reproduces the same result
 *   spendInterventions    — the per-step allowance, the one tell a landed patch cannot supersede
 *
 * Where the reading of the state lives: ./triage.js. Where the ticket/patch channel lives: ./escalate.js.
 *
 * Part of the resume.js layer (split out of the original single file).
 */

const path = require("path");
const { PIPELINE_STEPS } = require("../../gulpfile");
const { specForStep } = require("../artifacts");

const { maxInterventionsPerStep, resolveDeclaredName } = require("./state");
const { CHAPTER_STATE_STEPS, CUMULATIVE_STEPS, ESCALATION_HEADLINES } = require("./menu");
const { renderResumePlanMarkdown } = require("./report");
const {
  indexStepStates,
  indexRecurringFindings,
  findResumePoint,
  priorStepPlans,
  laterStepPlans,
  finishedRunStepPlans,
  stepPlan,
} = require("./triage");
const { openChannels, escalatorFor } = require("./escalate");

/**
 * The declared outputs one step leaves in one volume folder — the exact list to remove so
 * the skip-checks cannot no-op the fix (gotcha 66: the skip-checks key on source
 * fingerprints, rolling state and `contextHash`, and none of them know the code changed).
 *
 * Quarantine evidence is never in this list. `.rejected` files are not this step's outputs;
 * they are the reason we are looking, and `delete-evidence` is Tier C.
 *
 * @param {string} step
 * @param {string} installment - The volume's `NN`, so a templated name resolves to the real one.
 * @returns {string[]}
 */
function declaredOutputsFor(step, installment) {
  const spec = specForStep(step);
  if (!spec || !spec.perVolume) return [];
  // Every declared name, placeholder resolved. Listing the whole set is the safe direction:
  // `wipeAttemptOutputs` deletes only the names that exist, and a `*-rolling-state.json` left
  // behind is the one thing that makes a re-run skip the volume it is supposed to rebuild
  // (gotcha 66).
  return spec.volume.map((expect) => resolveDeclaredName(expect.name, installment));
}


/**
 * Turn the working state into the step list to run.
 *
 * The rule, in words: walk the steps in run order; the first one that did not finish what it claims
 * to have is where the run picks up. Everything before it is left alone. Everything after it runs
 * *after* the resume point, because its inputs are about to change — and a later step that is also
 * broken is normally a symptom of the earlier one, not a second problem, which the plan says out
 * loud instead of proposing two fixes.
 *
 * @param {Awaited<ReturnType<typeof readWorkingState>>} state
 * @returns {ResumePlan}
 */
function planResume(state) {
  const order = PIPELINE_STEPS.map((s) => s.name);

  // There is no plan of record, so no step can run. Intake is the step to call — and its questions
  // are the account owner's, not the manager's.
  if (!state.manifest) return noPlanOfRecord(state);

  const stateByStep = indexStepStates(state);
  const recurringFor = indexRecurringFindings(state);
  const resume = findResumePoint(order, stateByStep);

  // Nothing is unfinished. Say so, and report what is worth reading without turning any of it into
  // work — including gate evidence lying beside a finished volume.
  if (resume.index === -1) return nothingToResume(state, order, stateByStep);

  return resumeHere(state, { order, stateByStep, recurringFor, resume });
}


/**
 * The plan for a run with no plan of record: `discover` is blocked, and the intake questions stay
 * with the intake agent.
 *
 * @param {Object} state
 * @returns {ResumePlan}
 */
function noPlanOfRecord(state) {
  return finishPlan({
    state,
    verdict: "blocked",
    headline: "There is no plan of record, so no step can run. Intake is the step to call — and its questions are the account owner's, not mine.",
    steps: [
      stepPlan("discover", {
        action: "blocked",
        actionName: null,
        reasons: [state.manifestProblem || "the plan of record is missing"],
      }),
    ],
    notes: [
      "The intake questions — which files are volumes, in what order, what the series is called — " +
        "belong to the intake agent and the account owner. I can report that intake is needed; I do not answer them.",
    ],
  });
}


/**
 * The plan for a run where every step finished what it claims to have.
 *
 * @param {Object} state
 * @param {string[]} order
 * @param {Map<string, Object>} stateByStep
 * @returns {ResumePlan}
 */
function nothingToResume(state, order, stateByStep) {
  const { steps, quarantined, notes } = finishedRunStepPlans(order, stateByStep);

  const d = state.deliverable;
  if (d && (d.counts.unverified || d.counts.missing)) {
    notes.push(
      `the deliverable is not clean: ${d.counts.unverified} unverified and ${d.counts.missing} missing ` +
        `chapter(s) out of ${d.counts.total}. Every step finished; the book is what is not finished.`
    );
  }

  if (quarantined.length) {
    return finishPlan({
      state,
      verdict: "evidence",
      headline: `Every step finished what it claims to have. What is left is unread gate evidence in ${quarantined.join(", ")} — read it before running anything.`,
      steps,
      notes,
    });
  }
  return finishPlan({
    state,
    verdict: "nothing-to-do",
    headline: notes.length
      ? "Every step finished what it claims to have. Nothing to resume — but read the notes."
      : "Every step finished what it claims to have, and the deliverable is clean. Nothing to do.",
    steps,
    notes,
  });
}


/**
 * The plan for a run that stopped somewhere: the resume step's repair, the steps before it (left
 * alone), and the steps after it (they run afterwards).
 *
 * @param {Object} state
 * @param {{ order: string[], stateByStep: Map<string, Object>, recurringFor: Map<string, Array>, resume: {index: number, reason: string} }} ctx
 * @returns {ResumePlan}
 */
function resumeHere(state, { order, stateByStep, recurringFor, resume }) {
  const resumeStep = order[resume.index];
  const resumeState = stateByStep.get(resumeStep);
  const fromVolume = resumeState.volumes.length ? resumeState.volumes[0] : null;
  const notes = [];

  /** @type {ResumeStepPlan} */
  const plan = stepPlan(resumeStep, {
    action: "run",
    actionName: "resume-here",
    reasons: [resume.reason, ...resumeState.damageKinds.map((k) => `finding: ${k}`)],
    fromVolume,
    // The finding this action is a response to. It is what the ledger keys the anti-spin check on,
    // so it has to be named by the triage rather than guessed at by whoever acts.
    finding: resumeState.damageKinds[0] || null,
  });
  // Only the resume step carries these two: they record what the escalation decided about THIS step,
  // and a step that is merely in the plan because its inputs changed has no escalation to report.
  plan.existingTicket = null;
  plan.escalation = null;

  if (resumeStep === "discover") {
    blockIntake(plan, notes);
  } else {
    // The order matters. Reading the evidence first used to decide the whole plan, which made a
    // superseded escalation indistinguishable from a live one: once the plan said `open-ticket` there
    // was no repair left standing to compare a landed patch against. Computing the repair first means
    // the escalation is a decision ON TOP of a concrete alternative, and `escalate` can say out loud
    // which one it is overriding and why that override no longer holds.
    chooseRepair(plan, { state, fromVolume });
    raiseStructuralTells(plan, notes, { state, resumeState, resumeStep, fromVolume, recurringFor });
  }

  const steps = [
    ...priorStepPlans(order, stateByStep, resume.index),
    plan,
    ...laterStepPlans(order, stateByStep, resume.index, resumeStep, recurringFor, plan.finding),
  ];

  // (The resume step's own recurring finding is escalated above, through `escalate`, so a landed patch
  // can supersede it. What is left here is the free half: the classes that recurred on OTHER steps,
  // reported without changing the plan.)
  for (const r of state.recurring || []) {
    notes.push(
      `${r.finding} appeared in ${r.runs} recorded runs${r.steps.length ? ` (${r.steps.join(", ")})` : ""}. ` +
        "A finding that survives a run is structural, not transient — re-running is not the answer, and the ledger refuses the third attempt."
    );
  }

  spendInterventions(plan, notes, { state, resumeStep });

  if (state.ledgerError) {
    notes.push(`the run ledger could not be read (${state.ledgerError}) — so nothing here is counted as safe to repeat.`);
  }

  return finishPlan({
    state,
    verdict: "resume",
    headline: headlineFor(plan, resumeStep, fromVolume),
    steps,
    notes,
  });
}


/**
 * Intake is its own step with its own agent and its own guards.
 * @param {ResumeStepPlan} plan
 * @param {string[]} notes
 */
function blockIntake(plan, notes) {
  plan.action = "blocked";
  plan.actionName = null;
  plan.reasons.push(
    "intake is its own step with its own agent and its own guards. I can tell you it is needed; I do not answer its questions."
  );
  notes.push("The intake questions (volume order, which files are volumes, the series name) belong to the intake agent and the account owner.");
}


/**
 * The primitive, chosen before anybody has objected to it.
 *
 * Three shapes, decided by what the step's artifacts are:
 *   - cumulative → wipe this volume's outputs and re-run the step over the WHOLE series, because the
 *     cumulative invariant rebuilds every later volume and `--volume` would leave them on the broken
 *     base (gotcha 66);
 *   - per-chapter translation work → a plain re-run, which is idempotent per chapter and keeps the
 *     chapters that are already verified;
 *   - anything else → a plain re-run, which the idempotent skip-checks make nearly free.
 *
 * @param {ResumeStepPlan} plan
 * @param {{ state: Object, fromVolume: string|null }} ctx
 */
function chooseRepair(plan, { state, fromVolume }) {
  const { step: resumeStep } = plan;
  const cumulative = CUMULATIVE_STEPS.has(resumeStep);

  if (cumulative && fromVolume) {
    plan.actionName = "wipe-and-cascade";
    plan.cascade = true;
    plan.countsAsIntervention = true;
    const folder = (state.manifest.volumes.find((v) => String(v.installmentNumber) === String(fromVolume)) || {}).folder;
    // The quarantine evidence beside the outputs is named, when there IS any. Saying "the evidence is
    // kept" about a folder that holds none is the same mistake gotcha 81 is about: a standing sentence
    // that reads as a claim about the disk.
    const inventory = (state.volumes || []).find((v) => String(v.installment) === String(fromVolume)) || null;
    const keptEvidence = inventory ? inventory.quarantines : [];
    if (folder) {
      plan.wipeFirst = [
        {
          volumeDir: path.join(state.seriesDir, folder),
          files: declaredOutputsFor(resumeStep, fromVolume),
          quarantinesKept: keptEvidence,
        },
      ];
    }
    plan.reasons.push(
      `the cumulative invariant rebuilds every volume after ${fromVolume}, so the primitive is: remove ${fromVolume}'s ${resumeStep} outputs, then run ${resumeStep} over the whole series.`,
      "not --volume: a filtered run puts one volume in the loop, so the later volumes stay built on the broken one (gotcha 66).",
      keptEvidence.length
        ? `the declared outputs only — ${keptEvidence.map((n) => `\`${n}\``).join(", ")} beside them is kept.`
        : `the declared outputs only — nothing else in that volume folder is touched.`
    );
  } else if (CHAPTER_STATE_STEPS.has(resumeStep)) {
    plan.actionName = "re-translate-volume";
    plan.reasons.push(
      "the translation stage is idempotent per chapter, so a plain re-run repairs a hole without throwing away the chapters that are already verified."
    );
  } else if (resumeStep === "consistency-audit") {
    plan.actionName = "re-audit";
    plan.countsAsIntervention = true;
    plan.reasons.push("the audit report is missing or stale; re-running it is the whole fix.");
  } else {
    plan.actionName = "re-run-step";
    plan.reasons.push("the idempotent skip-checks make a re-run cost almost nothing where the work is already done.");
  }
}


/**
 * The four shapes where a re-run IS the spin — each one says "re-running this reproduces the same
 * result", and each one is asked THROUGH `escalate`, so a landed patch can supersede it and an
 * already-written ticket can be named instead of duplicated.
 *
 * Three of them are read off the disk (a gate removed the output, the audit's own verdict, a finding
 * that survived an earlier run). The fourth is read off the ledger: an attempt this run already made
 * on this step that ended `unchanged` or `worse`. It is the one the disk cannot say, and it is what
 * lets the autopilot keep going after a failed step without turning that into a second identical
 * attempt.
 *
 * @param {ResumeStepPlan} plan
 * @param {string[]} notes
 * @param {{ state: Object, resumeState: Object, resumeStep: string, fromVolume: string|null, recurringFor: Map<string, Array> }} ctx
 */
function raiseStructuralTells(plan, notes, { state, resumeState, resumeStep, fromVolume, recurringFor }) {
  const escalate = escalatorFor({ plan, notes, channelFor: openChannels(state, resumeStep, fromVolume) });

  // Did this step's own gate remove the output? The tell is on the disk, in one folder: the volume is
  // missing the step's required files AND holds that step's quarantine evidence beside them. That is
  // volume 15 of the live series — the carry-forward gate refused a glossary that had GROWN from 445
  // terms to 460, moved the file to `glossary.md.rejected`, and a 12-hour run ended there (gotcha 68).
  // Re-running the step rebuilds the file and then runs the same deterministic gate over it, which
  // produces the identical quarantine.
  const inventory = state.volumes.find((v) => v.installment === String(fromVolume)) || null;
  const gateRemovedIt = Boolean(fromVolume && inventory && inventory.quarantinedForStep.includes(resumeStep));

  if (gateRemovedIt) {
    // Say what the ledger ACTUALLY records. This reason used to assert "the ledger refuses the third
    // attempt" on a series with no ledger file at all, and the diagnostics team spent a whole turn
    // asking the account owner whether two runs had really happened (ticket TCK-delivery-2026-10-06
    // …-1, 2026-10-06). A mechanism that exists is not a record that something has met it, and a plan
    // that claims an attempt nobody made gets answered by somebody switching the guard off.
    const spent = (state.interventionsByStep || {})[resumeStep] || 0;
    const ledgerLine = spent
      ? `the ledger records ${spent} intervention(s) on ${resumeStep} in the newest recorded run, and the same ` +
        `action against the same finding is refused on the third attempt (utils/ledger.js).`
      : `nothing is recorded as attempted on ${resumeStep} in the run ledger: this is not a refused third ` +
        `attempt, it is the shape itself — the gate's check runs at the end of the step, so a re-run does ` +
        `the whole model work and then reproduces the identical quarantine.`;
    const escalated = escalate(
      "gate-removed",
      `volume ${fromVolume} is missing ${resumeStep}'s output AND holds ${resumeStep}'s own gate evidence in the same folder`,
      [
        `a deterministic gate refused that file, and nothing has replaced it since.`,
        `re-running ${resumeStep} rebuilds the file and then runs the same gate over it, which produces the identical quarantine (gotcha 68). That is the spin.`,
        ledgerLine,
        `read ${inventory.quarantines.map((n) => `\`${n}\``).join(", ")} first — it is the gate's own account of what it refused, and it is not mine to delete (Tier C).`,
      ]
    );
    if (escalated) {
      notes.push(
        "A finding whose cause is a gate is not repaired by re-running the step the gate lives in. The evidence names the disagreement; the fix is a code question for the diagnostics team."
      );
    }
    return;
  }

  // A FAIL verdict is not repaired by re-auditing: the same four artifacts produce the same FAIL.
  // Re-running it is the spinning shape, so this is a question, not an action.
  if (resumeState.damageKinds.some((k) => k.startsWith("audit-verdict"))) {
    escalate("audit-verdict", "the consistency audit's own verdict is the problem", [
      "the audit's verdict is the deliverable here, and re-auditing unchanged artifacts produces the same verdict. " +
        "The fix is in the four reference artifacts the findings name — which is a diagnostics question, not a re-run.",
    ]);
    return;
  }

  const recurringHere = recurringFor.get(resumeStep) || [];
  if (recurringHere.length) {
    escalate(
      "recurring-finding",
      `the ledger says ${recurringHere.map((r) => `${r.finding} (${r.runs} runs)`).join(", ")} for this step already`,
      [
        "re-running it has not cleared it before, and the same action against the same finding is refused on the third attempt (utils/ledger.js).",
      ]
    );
    return;
  }

  // Did an attempt in THIS run already fail on this step? This is the tell the disk cannot carry.
  // A step killed part-way through its work leaves a folder that looks exactly like "the work was
  // never done", and a step that ran to the end and was refused by its own gate leaves the quarantine
  // that `gateRemovedIt` above reads. Only the ledger distinguishes "nothing has been tried yet" from
  // "something was tried, it cost a real step's worth of model calls, and the deliverable did not
  // move" — and without this the loop's only reading of a failed attempt is the shape it happened to
  // leave on disk, which is the shape that invites a second identical attempt.
  const unhelpful = (state.unhelpfulInterventionsByStep || {})[resumeStep] || [];
  if (unhelpful.length) {
    escalate(
      "attempt-did-not-help",
      `the ledger records ${unhelpful.length} attempt(s) on ${resumeStep} in this run that did not move the deliverable`,
      [
        unhelpful.map((a) => `${a.id} (${a.action || "action not named"} → ${a.outcome})`).join(", ") + ".",
        "the deliverable is what the acceptance test measures, and it did not move: the attempt spent a step run and left the finding where it was (gotcha 69).",
        "so the next move is not another attempt on this step. It is somebody who can read WHY the step fails, which is the diagnostics team and not this one.",
      ]
    );
  }
}


/**
 * The per-step intervention budget.
 *
 * DELIVERY_MAX_INTERVENTIONS is PER STEP (account owner, 2026-10-06): a run with nine steps is nine
 * problems, and a global cap spends glossary's attempts on the wiki. This is a different limit from
 * the anti-spin gate — the ledger refuses the same action against the same finding twice; this refuses
 * to keep doing *anything* to one step. Both escalate to a ticket, because the honest reading of "I
 * have run out of moves on this step" is "this needs somebody who can see the code".
 *
 * The budget is the ONE escalation a landed patch cannot supersede. A patch record does not un-spend
 * what this run has already spent, and applying the patch is itself the counted wipe-and-cascade — so
 * "this step has used up its attempts" stands even when the code has changed underneath it. The reason
 * says who can raise the limit, because that is the account owner's decision, not the manager's.
 *
 * @param {ResumeStepPlan} plan
 * @param {string[]} notes
 * @param {{ state: Object, resumeStep: string }} ctx
 */
function spendInterventions(plan, notes, { state, resumeStep }) {
  const budget = state.interventionBudget || maxInterventionsPerStep();
  const used = (state.interventionsByStep || {})[resumeStep] || 0;
  if (!used) return;

  notes.push(`${resumeStep}: ${used} of ${budget} interventions used on this step in run ${state.run || "the recorded one"}.`);

  if (plan.countsAsIntervention && used >= budget) {
    const escalate = escalatorFor({ plan, notes, channelFor: openChannels(state, resumeStep, plan.fromVolume) });
    escalate("intervention-budget", "the repair is an intervention and this step has none left", [
      `this step has already had ${used} of the ${budget} interventions it is allowed in this run. ` +
        "The budget is per step on purpose, so spending it is the signal that this step needs the diagnostics team, not another attempt.",
    ]);
    notes.push(
      `${resumeStep} is out of intervention budget (${used}/${budget}). The next move is a ticket, and the account owner is the only role that can raise the limit.`
    );
  }
}


/**
 * The headline keys on what the plan DECIDED, not on which tell was seen on the disk: a gate-removed
 * shape whose ticket has already been answered by a landed patch is a run, and a headline that still
 * said "re-running refuses it again" would describe a plan that is running it. `plan.escalation` is
 * what `escalate` recorded, so the sentence names the real reason.
 *
 * @param {ResumeStepPlan} plan
 * @param {string} resumeStep
 * @param {string|null} fromVolume
 * @returns {string}
 */
function headlineFor(plan, resumeStep, fromVolume) {
  if (plan.action === "ticket") {
    return (
      `The run stops at ${resumeStep}${fromVolume ? ` volume ${fromVolume}` : ""}: ` +
      `${ESCALATION_HEADLINES[plan.escalation] || "the answer is a question, not a re-run"}` +
      `${plan.existingTicket ? ` Already ticket ${plan.existingTicket.id} (${plan.existingTicket.status}).` : ""}`
    );
  }
  if (plan.action === "blocked") {
    return `The run stops at ${resumeStep}, and the next move is not mine.`;
  }
  return `Pick up at ${resumeStep}${fromVolume ? ` volume ${fromVolume}` : ""}${plan.cascade ? ", then let the cascade rebuild the tail" : ""}.`;
}


/**
 * Attach the render and return the plan.
 * @param {{state: Object, verdict: string, headline: string, steps: ResumeStepPlan[], notes: string[]}} input
 * @returns {ResumePlan}
 */
function finishPlan({ state, verdict, headline, steps, notes }) {
  /** @type {ResumePlan} */
  const plan = {
    generatedAt: new Date().toISOString(),
    seriesDir: state.seriesDir,
    verdict,
    headline,
    steps,
    volumes: state.volumes || [],
    notes,
    recurring: state.recurring || [],
    run: state.run || null,
    interventionsByStep: state.interventionsByStep || {},
    interventionBudget: state.interventionBudget || maxInterventionsPerStep(),
    deliverable: state.deliverable,
    markdown: "",
  };
  plan.markdown = renderResumePlanMarkdown(plan);
  return plan;
}

module.exports = {
  declaredOutputsFor,
  planResume,
  finishPlan,
};

/**
 * The decision. The repair shape is computed FIRST, then the three 're-running reproduces the same result' checks run through one escalate() helper that either overwrites the plan with a ticket or is superseded by an answered ticket or a landed patch — deliberately NOT applied to the intervention budget, because a code change cannot un-spend attempts this run already made.
 *
 * Part of the resume.js layer (split out of the original single file).
 */

const path = require("path");
const { PIPELINE_STEPS } = require("../../gulpfile");
const { STEP_ARTIFACT_SPECS, specForStep } = require("../artifacts");
const { readTickets, matchesTicketKey } = require("../tickets");

const { maxInterventionsPerStep, resolveDeclaredName } = require("./state");
const { CHAPTER_STATE_STEPS, CUMULATIVE_STEPS, ESCALATION_HEADLINES } = require("./menu");
const { renderResumePlanMarkdown } = require("./report");

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
 * The rule, in words: walk the steps in run order; the first one that did not finish what it
 * claims to have is where the run picks up. Everything before it is left alone. Everything
 * after it runs *after* the resume point, because its inputs are about to change — and a
 * later step that is also broken is normally a symptom of the earlier one, not a second
 * problem, which the plan says out loud instead of proposing two fixes.
 *
 * @param {Awaited<ReturnType<typeof readWorkingState>>} state
 * @returns {ResumePlan}
 */
function planResume(state) {
  /** @type {ResumeStepPlan[]} */
  const steps = [];
  /** @type {string[]} */
  const notes = [];
  const order = PIPELINE_STEPS.map((s) => s.name);

  if (!state.manifest) {
    return finishPlan({
      state,
      verdict: "blocked",
      headline: "There is no plan of record, so no step can run. Intake is the step to call — and its questions are the account owner's, not mine.",
      steps: [
        {
          step: "discover",
          action: "blocked",
          actionName: null,
          reasons: [state.manifestProblem || "the plan of record is missing"],
          fromVolume: null,
          cascade: false,
          wipeFirst: [],
          flags: [],
          countsAsIntervention: false,
          finding: null,
        },
      ],
      notes: [
        "The intake questions — which files are volumes, in what order, what the series is called — " +
          "belong to the intake agent and the account owner. I can report that intake is needed; I do not answer them.",
      ],
    });
  }

  const stateByStep = new Map(state.stepStates.map((s) => [s.step, s]));
  let resumeAt = -1;
  let resumeReason = "";

  // Which steps carry a finding class that survived an earlier recorded run. Built before the
  // plan, because it changes what may be *advised*: `index.js` already refuses to repeat
  // "just re-run, it's cheap" when its own ledger says a re-run has not cleared it, and the
  // resume triage giving the opposite advice would undo that.
  /** @type {Map<string, Array<{finding: string, steps: string[], runs: number}>>} */
  const recurringFor = new Map();
  for (const r of state.recurring || []) {
    for (const stepName of r.steps) {
      if (!recurringFor.has(stepName)) recurringFor.set(stepName, []);
      recurringFor.get(stepName).push(r);
    }
  }

  order.forEach((name, index) => {
    const st = stateByStep.get(name);
    if (!st) return;

    if (st.status === "incomplete" || st.status === "unknown") {
      if (resumeAt === -1) {
        resumeAt = index;
        resumeReason = st.error
          ? `${name} could not be assessed (${st.error})`
          : `${name} did not finish what it claims to have: ${st.damageKinds.join(", ")}`;
      }
    }
  });

  // Nothing is unfinished. Say so, and report what is worth reading without turning any of it
  // into work — including gate evidence lying beside a finished volume, which is the finding a
  // manager is most tempted to "fix" by rebuilding a volume that is already complete.
  if (resumeAt === -1) {
    const quarantined = [];
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
    }
    const d = state.deliverable;
    if (d && (d.counts.unverified || d.counts.missing)) {
      notes.push(
        `the deliverable is not clean: ${d.counts.unverified} unverified and ${d.counts.missing} missing ` +
          `chapter(s) out of ${d.counts.total}. Every step finished; the book is what is not finished.`
      );
    }
    const allSteps = order.map((name) => ({
      step: name,
      action: quarantined.includes(name) ? "ticket" : "none",
      actionName: quarantined.includes(name) ? "open-ticket" : "resume-here",
      reasons: quarantined.includes(name)
        ? [
            `output for volume(s) ${stateByStep.get(name).evidenceVolumes.join(", ")} is complete, so this evidence is not a reason to rebuild it: a gate refused something at some point and the file was kept beside it`,
            "reading that evidence is a question for the diagnostics team, not a re-run — and it is not mine to delete (Tier C)",
            ...stateByStep.get(name).notes,
          ]
        : [stateByStep.get(name).status],
      fromVolume: quarantined.includes(name) ? stateByStep.get(name).evidenceVolumes[0] || null : null,
      cascade: false,
      wipeFirst: [],
      flags: [],
      countsAsIntervention: false,
      finding: quarantined.includes(name) ? stateByStep.get(name).evidenceKinds[0] || null : null,
    }));

    if (quarantined.length) {
      return finishPlan({
        state,
        verdict: "evidence",
        headline: `Every step finished what it claims to have. What is left is unread gate evidence in ${quarantined.join(", ")} — read it before running anything.`,
        steps: allSteps,
        notes,
      });
    }
    return finishPlan({
      state,
      verdict: "nothing-to-do",
      headline: notes.length
        ? "Every step finished what it claims to have. Nothing to resume — but read the notes."
        : "Every step finished what it claims to have, and the deliverable is clean. Nothing to do.",
      steps: allSteps,
      notes,
    });
  }

  const resumeStep = order[resumeAt];
  const resumeState = stateByStep.get(resumeStep);

  // ── The resume point ────────────────────────────────────────────────────────
  const fromVolume = resumeState.volumes.length ? resumeState.volumes[0] : null;
  const cumulative = CUMULATIVE_STEPS.has(resumeStep);
  const auditVerdictProblem = resumeState.damageKinds.some((k) => k.startsWith("audit-verdict"));

  // Did this step's own gate remove the output? The tell is on the disk, in one folder: the
  // volume is missing the step's required files AND holds that step's quarantine evidence
  // beside them. That is volume 15 of the live series — the carry-forward gate refused a
  // glossary that had GROWN from 445 terms to 460, moved the file to `glossary.md.rejected`,
  // and a 12-hour run ended there (gotcha 68). Re-running the step rebuilds the file and then
  // runs the same deterministic gate over it, which produces the identical quarantine.
  const resumeInventory = state.volumes.find((v) => v.installment === String(fromVolume)) || null;
  const gateRemovedIt = Boolean(fromVolume && resumeInventory && resumeInventory.quarantinedForStep.includes(resumeStep));

  /** @type {ResumeStepPlan} */
  const plan = {
    step: resumeStep,
    action: "run",
    actionName: "resume-here",
    reasons: [resumeReason, ...resumeState.damageKinds.map((k) => `finding: ${k}`)],
    fromVolume,
    cascade: false,
    wipeFirst: [],
    flags: [],
    countsAsIntervention: false,
    // The finding this action is a response to. It is what the ledger keys the anti-spin
    // check on, so it has to be named by the triage rather than guessed at by whoever acts.
    finding: resumeState.damageKinds[0] || null,
    existingTicket: null,
    escalation: null,
  };

  // The manager's own two channels, read out of the same state snapshot the rest of this triage
  // reads. They are here rather than reached for inside `planResume` for the reason gotcha 71 ends
  // with: `planResume` is a **pure function of a state**, and a decision that opened `tickets.json`
  // by itself would make a hand-built test state silently read the real series' correspondence.
  //
  // What they fix is the triage's one real blind spot. It could say "this shape needs a question"
  // but not "I already asked that question, and somebody has already written an answer for it" —
  // so on a series where a fix had already landed, the plan kept re-escalating the same disk shape
  // forever and act mode executed nothing forever. The ticket it wrote and the patch it was handed
  // are the two records in this layer a customer is allowed to read, so reading them is not the
  // manager reaching into the code: it is the manager remembering its own conversation.
  const tickets = state.tickets || [];
  const patches = state.patches || [];

  /**
   * What the channels already say about this exact (step, volume, finding).
   *
   * "Newest" is the LAST matching ticket, because tickets are appended: it is the one that carries
   * the ledger's account of what has been tried since, and it is the one `escalationStatus`-style
   * reasoning has to read. A patch counts as answering it only when the manager has said yes —
   * `accepted` (in the tree, awaiting the dev team's commit) or `committed` (in `main`). A
   * `proposed` patch does not supersede anything: it is unjudged code, and act mode refuses the
   * whole plan while one is open (gotcha 75).
   *
   * @param {string|null} finding
   * @returns {{matching: Array, newest: Object|null, live: Object|null, answered: Object|null}}
   */
  function channelFor(finding) {
    if (!finding) return { matching: [], newest: null, live: null, answered: null };
    const matching = tickets.filter((t) => matchesTicketKey(t, { step: resumeStep, volume: fromVolume, finding }));
    const newest = matching.length ? matching[matching.length - 1] : null;
    const live = newest && newest.status !== "closed" ? newest : null;
    const answered = newest
      ? patches.find((p) => p && p.ticketId === newest.id && ["accepted", "committed"].includes(p.status)) || null
      : null;
    return { matching, newest, live, answered };
  }

  /**
   * Turn the repair into a question — unless the channels show that question has already been
   * asked, and answered with a change the manager accepted.
   *
   * Three outcomes, and the difference between them is the whole point:
   *   - **superseded** — an accepted/committed patch answers the ticket for this exact finding, so
   *     the guard that produced this disk shape is not the guard that will run. The repair stands.
   *   - **already open** — the plan names the ticket it already wrote instead of proposing a
   *     duplicate, so `delivery.js --open-ticket` and the autopilot work the existing one.
   *   - **a new question** — nothing live matches, so the escalation stands and the reason says
   *     what the previous ticket's closure measured.
   *
   * The supersede half applies to the three "re-running reproduces the same result" tells and NOT
   * to `intervention-budget`, and the asymmetry is the point: a patch record does not refund the
   * attempts this run already made, and applying the patch is itself the counted wipe-and-cascade.
   * A code change cannot un-spend an allowance, so a step that used up its attempts is still out of
   * moves whatever else has landed.
   *
   * @param {("gate-removed"|"audit-verdict"|"recurring-finding"|"intervention-budget")} kind
   *   Which check fired. Recorded on the plan so the report can name the reason, not just the no.
   * @param {string} subject - The short clause the headline and the reason both read.
   * @param {string[]} reasons - Why a re-run is the spin here.
   * @returns {boolean} - True when the plan became a ticket.
   */
  function escalate(kind, subject, reasons) {
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
  }

  if (resumeStep === "discover") {
    plan.action = "blocked";
    plan.actionName = null;
    plan.reasons.push(
      "intake is its own step with its own agent and its own guards. I can tell you it is needed; I do not answer its questions."
    );
    notes.push("The intake questions (volume order, which files are volumes, the series name) belong to the intake agent and the account owner.");
  } else {
    // ── The repair shape first, then the escalations ──────────────────────────
    // The order matters. Reading the evidence first used to decide the whole plan, which made a
    // superseded escalation indistinguishable from a live one: once the plan said `open-ticket`
    // there was no repair left standing to compare a landed patch against. Computing the repair
    // first means the escalation is a decision ON TOP of a concrete alternative, and `escalate`
    // can say out loud which one it is overriding and why that override no longer holds.
    if (cumulative && fromVolume) {
      plan.actionName = "wipe-and-cascade";
      plan.cascade = true;
      plan.countsAsIntervention = true;
      const folder = (state.manifest.volumes.find((v) => String(v.installmentNumber) === String(fromVolume)) || {}).folder;
      if (folder) {
        plan.wipeFirst = [
          {
            volumeDir: path.join(state.seriesDir, folder),
            files: declaredOutputsFor(resumeStep, fromVolume),
          },
        ];
      }
      plan.reasons.push(
        `the cumulative invariant rebuilds every volume after ${fromVolume}, so the primitive is: remove ${fromVolume}'s ${resumeStep} outputs, then run ${resumeStep} over the whole series.`,
        "not --volume: a filtered run puts one volume in the loop, so the later volumes stay built on the broken one (gotcha 66).",
        "the declared outputs only — the quarantine evidence beside them is kept."
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

    // ── Then the escalations: three shapes where a re-run IS the spin ─────────
    // Each one says "re-running this reproduces the same result", and each one is now asked
    // THROUGH `escalate`, so a landed patch can supersede it and an already-written ticket can be
    // named instead of duplicated.
    if (gateRemovedIt) {
      const escalated = escalate(
        "gate-removed",
        `volume ${fromVolume} is missing ${resumeStep}'s output AND holds ${resumeStep}'s own gate evidence in the same folder`,
        [
          `a deterministic gate refused that file, and nothing has replaced it since.`,
          `re-running ${resumeStep} rebuilds the file and then runs the same gate over it, which produces the identical quarantine (gotcha 68). That is the spin, and the ledger refuses the third attempt.`,
          `read ${resumeInventory.quarantines.map((n) => `\`${n}\``).join(", ")} first — it is the gate's own account of what it refused, and it is not mine to delete (Tier C).`,
        ]
      );
      if (escalated) {
        notes.push(
          `A finding whose cause is a gate is not repaired by re-running the step the gate lives in. The evidence names the disagreement; the fix is a code question for the diagnostics team.`
        );
      }
    } else if (auditVerdictProblem) {
      // A FAIL verdict is not repaired by re-auditing: the same four artifacts produce the
      // same FAIL. Re-running it is the spinning shape, so this is a question, not an action.
      escalate("audit-verdict", "the consistency audit's own verdict is the problem", [
        "the audit's verdict is the deliverable here, and re-auditing unchanged artifacts produces the same verdict. " +
          "The fix is in the four reference artifacts the findings name — which is a diagnostics question, not a re-run.",
      ]);
    } else {
      const recurringHere = recurringFor.get(resumeStep) || [];
      if (recurringHere.length) {
        escalate(
          "recurring-finding",
          `the ledger says ${recurringHere.map((r) => `${r.finding} (${r.runs} runs)`).join(", ")} for this step already`,
          [
            "re-running it has not cleared it before, and the same action against the same finding is refused on the third attempt (utils/ledger.js).",
          ]
        );
      }
    }
  }

  steps.push(plan);

  // ── Everything before it: leave alone ───────────────────────────────────────
  for (let i = 0; i < resumeAt; i += 1) {
    const name = order[i];
    const st = stateByStep.get(name);
    const reasons = [st.status === "complete" ? "finished" : `finished with ${st.notes.length} non-blocking gap(s)`];
    if (st.status === "quarantined") {
      reasons.push(
        `gate evidence in volume(s) ${st.evidenceVolumes.join(", ")} beside output this step finished — worth reading, not worth rebuilding`
      );
    }
    steps.unshift({
      step: name,
      action: "none",
      actionName: null,
      reasons,
      fromVolume: null,
      cascade: false,
      wipeFirst: [],
      flags: [],
      countsAsIntervention: false,
      finding: null,
    });
  }

  // ── Everything after it: run after, and say whether it is a second problem ──
  // The translation stage's own entry gate: it refuses to start on a FAIL or missing
  // consistency verdict, and bypassing that gate is Tier C. So when the audit is the
  // problem, the steps after it are reported as blocked rather than proposed.
  const auditState = stateByStep.get("consistency-audit") || null;
  const auditVerdictFails = Boolean(auditState && auditState.damageKinds.some((k) => k === "audit-verdict-fail"));
  const auditReportMissing = Boolean(auditState && auditState.damageKinds.some((k) => k === "missing-required" || k === "audit-verdict-missing"));
  const TRANSLATION_STEPS = new Set(["translate", "translate-qa", "polish"]);

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
    steps.push({
      step: name,
      action: blocked ? "blocked" : "after",
      actionName: blocked ? null : "re-run-step",
      reasons,
      // Each step picks up at its own earliest damaged volume, which is usually NOT the same
      // one the resume step picked up at: glossary may be whole through 14 while the voice
      // reference stopped at 02.
      fromVolume: st.volumes.length ? st.volumes[0] : null,
      cascade: false,
      wipeFirst: [],
      flags: [],
      countsAsIntervention: false,
      // A step with its own damage names its own finding. A step that is complete and is only in
      // the plan because the resume step's fix invalidates it inherits the finding the whole plan
      // is a response to — otherwise the ledger has nothing to key on, and "have I already run
      // this step in this sequence, and did it help?" becomes a question the memory cannot answer.
      finding: st.damageKinds[0] || plan.finding || null,
    });
  }

  // ── Recurring findings: the free warning ────────────────────────────────────
  for (const r of state.recurring || []) {
    notes.push(
      `${r.finding} appeared in ${r.runs} recorded runs${r.steps.length ? ` (${r.steps.join(", ")})` : ""}. ` +
        "A finding that survives a run is structural, not transient — re-running is not the answer, and the ledger refuses the third attempt."
    );
  }
  // (The resume step's own recurring finding is escalated above, through `escalate`, so a landed
  // patch can supersede it. What is left here is the free half: the classes that recurred on OTHER
  // steps, reported without changing the plan.)

  // ── The per-step intervention budget ────────────────────────────────────────
  // DELIVERY_MAX_INTERVENTIONS is PER STEP (account owner, 2026-10-06): a run with nine steps is
  // nine problems, and a global cap spends glossary's attempts on the wiki. This is a different
  // limit from the anti-spin gate — the ledger refuses the same action against the same finding
  // twice; this refuses to keep doing *anything* to one step. Both escalate to a ticket, because
  // the honest reading of "I have run out of moves on this step" is "this needs somebody who can
  // see the code".
  const budget = state.interventionBudget || maxInterventionsPerStep();
  const used = (state.interventionsByStep || {})[resumeStep] || 0;
  if (used) {
    notes.push(
      `${resumeStep}: ${used} of ${budget} interventions used on this step in run ${state.run || "the recorded one"}.`
    );
  }
  // The budget is the ONE escalation a landed patch cannot supersede. A patch record does not
  // un-spend what this run has already spent, and applying the patch is itself the counted
  // wipe-and-cascade — so "this step has used up its attempts" stands even when the code has
  // changed underneath it. The reason says who can raise the limit, because that is the account
  // owner's decision, not the manager's.
  if (plan.countsAsIntervention && used >= budget) {
    escalate("intervention-budget", "the repair is an intervention and this step has none left", [
      `this step has already had ${used} of the ${budget} interventions it is allowed in this run. ` +
        "The budget is per step on purpose, so spending it is the signal that this step needs the diagnostics team, not another attempt.",
    ]);
    notes.push(
      `${resumeStep} is out of intervention budget (${used}/${budget}). The next move is a ticket, and the account owner is the only role that can raise the limit.`
    );
  }

  if (state.ledgerError) {
    notes.push(`the run ledger could not be read (${state.ledgerError}) — so nothing here is counted as safe to repeat.`);
  }

  // The headline keys on what the plan DECIDED, not on which tell was seen on the disk: a
  // gate-removed shape whose ticket has already been answered by a landed patch is a run, and a
  // headline that still said "re-running refuses it again" would describe a plan that is running
  // it. `plan.escalation` is what `escalate` recorded, so the sentence names the real reason.
  const headline =
    plan.action === "ticket"
      ? `The run stops at ${resumeStep}${fromVolume ? ` volume ${fromVolume}` : ""}: ` +
        `${ESCALATION_HEADLINES[plan.escalation] || "the answer is a question, not a re-run"}` +
        `${plan.existingTicket ? ` Already ticket ${plan.existingTicket.id} (${plan.existingTicket.status}).` : ""}`
      : plan.action === "blocked"
        ? `The run stops at ${resumeStep}, and the next move is not mine.`
        : `Pick up at ${resumeStep}${fromVolume ? ` volume ${fromVolume}` : ""}${plan.cascade ? ", then let the cascade rebuild the tail" : ""}.`;

  return finishPlan({ state, verdict: "resume", headline, steps, notes });
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

// ─── The human-facing half ────────────────────────────────────────────────────


module.exports = {
  declaredOutputsFor,
  planResume,
  finishPlan,
};

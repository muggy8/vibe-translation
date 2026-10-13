/**
 * Reading the working state as a step list: which step the run picks up at, which steps are left
 * alone, and which run afterwards.
 *
 * The triage is deliberately split from the decision (plan.js). This half answers "where is the
 * hole?" from the disk shape alone; it never proposes a move, and it never reads a ticket or a
 * patch. Keeping the two halves apart is what lets a test hand `planResume` a hand-built state and
 * be sure it is not silently reading the real series' correspondence.
 *
 * **What opens the run is a level, not a severity** (`utils/postmortem/plan/01-finding-levels.md`
 * slice 2). `state.js` routes every finding through `LEVEL_ROUTES`: `STOP` and `MAJOR` are damage and
 * open the run, `MINOR` is a batched gap that is reported and proposed for investigation, `NOTE` is
 * reported only, and `quarantine-present` keeps its exact evidence treatment. This half then reads the
 * resulting status: `incomplete` and `unknown` open the run at their earliest damaged volume, `paused`
 * opens it at the volume the halt record names, and `gaps` / `quarantined` never open it at all.
 *
 * Part of the resume.js layer (split out of the original single file).
 */

// `formatRanges` is the layer's own volume-list wording (`01–03, 07`). A note that lists seventeen
// volumes one by one is a line nobody reads, and the compact form is the same fact.
const { formatRanges } = require("./report");

/**
 * Index the per-step assessments by step name.
 * @param {Object} state - The working state (resume/state.js).
 * @returns {Map<string, Object>} step name → its assessment.
 */
function indexStepStates(state) {
  return new Map((state.stepStates || []).map((s) => [s.step, s]));
}

/**
 * Index the recurring (step, finding kind) facts by the ONE step each one is about.
 *
 * Built before the plan, because it changes what may be *advised*: `index.js` already refuses to
 * repeat "just re-run, it's cheap" when its own ledger says a re-run has not cleared it, and the
 * resume triage giving the opposite advice would undo that.
 *
 * The step comes from the record rather than from a list the reader widens. `recurringFindings`
 * (utils/ledger/report.js) keys on (step, kind) precisely so that a kind recorded once on
 * `glossary` and once on `style-guide` cannot be hung under both and read back as "this step has
 * already been re-run without clearing it". Indexing under `r.step` is the half that keeps the
 * sentence true to the ledger it was built from.
 *
 * @param {Object} state
 * @returns {Map<string, Array<import("../ledger/report").RecurringFinding>}
 */
function indexRecurringFindings(state) {
  /** @type {Map<string, Array<import("../ledger/report").RecurringFinding>>} */
  const recurringFor = new Map();
  for (const r of state.recurring || []) {
    const stepName = r.step;
    if (!stepName) continue;
    if (!recurringFor.has(stepName)) recurringFor.set(stepName, []);
    recurringFor.get(stepName).push(r);
  }
  return recurringFor;
}

/**
 * The first step in run order that did not finish what it claims to have.
 *
 * Only `incomplete`, `unknown` and `paused` open the run. `gaps` and `quarantined` are findings beside
 * work that is finished — a MINOR gap batched across a series, and evidence that a gate once fired, are
 * both reported — and choosing a resume point from either proposes throwing away completed volumes (see
 * menu.js, and volume 15 of the live series).
 *
 * `paused` is the state slice 4's gate produces: the step stopped after volume *n* on a STOP or MAJOR
 * finding and never attempted the rest. It opens the run, and it opens it AT volume *n* — which is a
 * different question from "which volumes are missing", because the volumes after *n* are missing
 * precisely because the step stopped, not because they broke.
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
    if (st.status !== "incomplete" && st.status !== "unknown" && st.status !== "paused") continue;
    if (st.status === "paused" && st.halt) {
      const halt = st.halt;
      const kinds = (halt.trigger || []).map((f) => `${f.level} ${f.kind}`).join(", ") || "a volume-boundary finding";
      const unattempted = halt.unattemptedVolumes || [];
      return {
        index,
        reason:
          `${name} halted after volume ${halt.haltedAfterVolume} on ${kinds}; ${unattempted.length} volume(s)` +
          `${unattempted.length ? ` (${formatRanges(unattempted)})` : ""} were never attempted. The step resumes from ` +
          `volume ${halt.haltedAfterVolume} once the finding is answered — the idempotent skip-checks keep the ` +
          `volumes before it free.`,
      };
    }
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
 * One readable line about a step's MINOR and NOTE findings, batched rather than counted.
 *
 * "3 non-blocking gap(s)" is the sentence this plan exists to retire: it is true, it is cheap to read,
 * and it names neither the kinds that fired nor the fact that somebody is supposed to go and look into
 * them.
 *
 * @param {Object} st - One step state.
 * @returns {string} `""` when the step has none.
 */
function describeGaps(st) {
  const batches = st.gapBatches || [];
  if (!batches.length) return st.notes.length ? `${st.notes.length} reported finding(s)` : "";
  return batches
    .map((b) => `${b.level} ${b.kind} in volume(s) ${formatRanges(b.volumes) || "the series"} (${b.count})`)
    .join("; ");
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
    const gaps = describeGaps(st);
    const reasons = [
      st.status === "complete" || !gaps
        ? "finished"
        : `finished with ${gaps} — reported, and proposed for investigation, not acted on`,
    ];
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
 * @param {Map<string, Array<import("../ledger/report").RecurringFinding>} recurringFor
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
      : st.status === "paused" && st.halt
        ? [
            `also stopped at a volume boundary — it halted after volume ${st.halt.haltedAfterVolume} and never attempted ` +
              `${formatRanges(st.halt.unattemptedVolumes || []) || "any further volume"}. It picks up at that volume: the ` +
                `books before it are accepted and the skip-checks keep them free.`,
          ]
        : st.status === "incomplete"
          ? [`also unfinished, most likely because ${resumeStep} was: fix the earlier step first, then re-assess this one`]
          : [`its inputs are about to change, so it runs after ${resumeStep}`];
    if (!blocked && TRANSLATION_STEPS.has(name) && auditReportMissing) {
      reasons.push("it cannot start until `consistency-report.md` exists and says PASS — that entry gate is not mine to bypass");
    }
    // Only the facts THIS step produced. A kind that recurred on another step says nothing about
    // whether re-running THIS one has ever failed, and this is the sentence that later turns the
    // step's repair into a ticket.
    const recurring = recurringFor.get(name) || [];
    if (recurring.length) {
      reasons.push(
        `the ledger says ${recurring.map((r) => `${r.finding} came back on ${name} in ${r.runs} recorded runs`).join(", ")} — this step has been run before and the same finding is still here, so treat this as a question, not a cheap retry`
      );
    }
    if (!blocked && st.evidenceVolumes.length) {
      reasons.push(
        `gate evidence in volume(s) ${st.evidenceVolumes.join(", ")} — read it; it is not by itself a reason to rebuild a volume this step finished`
      );
    }
    const gaps = describeGaps(st);
    if (!blocked && gaps) {
      reasons.push(`${gaps} — reported, and proposed for investigation, not acted on here`);
    }
    steps.push(
      stepPlan(name, {
        action: blocked ? "blocked" : "after",
        actionName: blocked ? null : "re-run-step",
        reasons,
        // Each step picks up at its own earliest damaged volume, which is usually NOT the same one
        // the resume step picked up at: glossary may be whole through 14 while the voice reference
        // stopped at 02. For a step that HALTED, the resume volume is the one the halt record names —
        // the volumes after it are absent because the step never reached them, not because they broke.
        fromVolume: st.halt ? st.halt.haltedAfterVolume : st.volumes.length ? st.volumes[0] : null,
        paused: st.halt || null,
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
      const gaps = describeGaps(st);
      if (gaps) {
        notes.push(`${name}: ${gaps} — reported, and proposed for investigation, not acted on.`);
      }
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
    // The slice-4 halt record, when this step stopped at a volume boundary on purpose. Null for every
    // other step, so "paused" is a state the plan states rather than one the reader infers from a
    // missing tail. utils/postmortem/halt.js.
    paused: fields.paused ?? null,
  };
}

module.exports = {
  indexStepStates,
  indexRecurringFindings,
  findResumePoint,
  describeGaps,
  priorStepPlans,
  laterStepPlans,
  finishedRunStepPlans,
  stepPlan,
};

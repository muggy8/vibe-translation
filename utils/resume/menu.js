/**
 * The closed action menu, as data: every move the manager may propose, with its tier (A act alone / B capped / C never), the primitive it maps to, and `countsAsIntervention` on each one — so 'picking up unfinished work is free, destroying finished work is an intervention' is a field the code can act on rather than a sentence in a prompt. Tier C entries carry the `why`, so a refusal can name what it refused.
 *
 * Part of the resume.js layer (split out of the original single file).
 */

/**
 * The steps whose artifacts are cumulative: regenerating one volume forces every later
 * volume to regenerate (`regeneratedAny`, docs/pipelines.md). This is what makes
 * "wipe the broken volume and re-run the step" the correct primitive instead of
 * "re-run one volume".
 */
const CUMULATIVE_STEPS = new Set(["glossary", "character-voice", "style-guide", "jump-in-wiki"]);


/**
 * The steps that work per chapter and are already idempotent per chapter, so a plain re-run
 * is the cheap answer and no wipe is needed.
 */
const CHAPTER_STATE_STEPS = new Set(["translate", "translate-qa", "polish"]);


/**
 * The HIGH findings that mean **work is missing or damaged** — the ones that decide where the
 * run picks up.
 *
 * The split exists because the first version of this module chose volume 02 as the resume point
 * on the live series, and volume 02's glossary is fine. What it found there was a `.rejected`
 * file: evidence that a gate fired at some point in a run that has since rebuilt that volume.
 * Choosing a resume point from *evidence a gate once fired* proposes throwing away thirteen
 * volumes of accepted work to deal with a leftover file — which is the destructive shape of
 * spinning, and it is exactly what a manager with no code access cannot see for itself.
 */
const DAMAGE_KINDS = new Set([
  "missing-required",
  "missing-volume-folder",
  "empty-or-stub",
  "bad-json",
  "wrong-shape",
  "chapter-without-draft",
  "accepted-without-acceptance",
  "audit-verdict-fail",
  "audit-verdict-missing",
  "step-undeclared",
]);


/**
 * The HIGH findings that mean **a gate refused something and left its evidence**. Read them;
 * they are not by themselves a reason to rebuild, and they are never wiped (Tier C).
 */
const EVIDENCE_KINDS = new Set(["quarantine-present"]);


/**
 * The four shapes where re-running reproduces the same result, and the one line each one puts in
 * the report's headline. Written as data beside the action menu because a refusal that does not
 * name the spin just looks like caution — and caution is the thing that gets switched off
 * (gotcha 65's lesson, and gotcha 71's volume-15 case).
 *
 * The keys are the `kind` values `planResume`'s `escalate()` records on the plan line, so the
 * sentence a human reads and the record a machine reads come from one table.
 *
 * @type {Record<string, string>}
 */
const ESCALATION_HEADLINES = {
  "gate-removed": "that step's own gate removed this output, and a re-run reproduces the identical quarantine",
  "audit-verdict": "the audit's own verdict is the problem, and re-auditing unchanged artifacts reproduces it",
  "recurring-finding": "the ledger says a re-run of this step has already not cleared it",
  "attempt-did-not-help": "this run already tried repairing it and the deliverable did not move",
  "intervention-budget": "this step has spent the intervention budget this run allows it",
};


/**
 * The manager's whole vocabulary of actions. Nothing outside this table exists for it.
 *
 * Tier C is written down here rather than left as prose for two reasons: the plan's
 * acceptance test asserts Tier C is refused, and a refusal has to name what it refused.
 * `countsAsIntervention` is the account owner's decision of 2026-10-05 — "picking up work
 * is not an intervention" — written where the code can act on it.
 *
 * @type {DeliveryAction[]}
 */
const DELIVERY_ACTIONS = [
  {
    name: "resume-here",
    tier: "A",
    what: "Start the run at this step instead of at step 1, and let the idempotent skip-checks no-op the finished work.",
    primitive: "index.js --stages=<from>",
    countsAsIntervention: false,
  },
  {
    name: "re-run-step",
    tier: "A",
    what: "Run a step again with no flags. Cheap: the skip-checks make it a no-op wherever the work is already done.",
    primitive: "index.js --stages=<step>",
    countsAsIntervention: false,
  },
  {
    name: "wipe-and-cascade",
    tier: "A",
    what: "Remove one volume's declared outputs for one step, then re-run the step over the whole series so the cumulative invariant rebuilds every later volume.",
    primitive: "wipeAttemptOutputs (utils/fs.js) + the step",
    countsAsIntervention: true,
  },
  {
    name: "re-audit",
    tier: "A",
    what: "Re-run the cross-artifact audit with --force.",
    primitive: "index.js --stages=consistency-audit --force",
    countsAsIntervention: true,
  },
  {
    name: "re-translate-volume",
    tier: "A",
    what: "Re-run the translation stage for a volume whose drafts or verdicts are missing.",
    primitive: "index.js --stages=translate,translate-qa,polish",
    countsAsIntervention: false,
  },
  {
    name: "re-run-chunked",
    tier: "B",
    what: "Force the chapter-by-chapter mode for a step whose whole-installment pass did not fit.",
    primitive: "index.js --stages=<step> --chunked",
    countsAsIntervention: true,
  },
  {
    name: "re-run-force",
    tier: "B",
    what: "Regenerate a step's outputs even where they already exist and passed. This throws away accepted work, so it is capped.",
    primitive: "index.js --stages=<step> --force",
    countsAsIntervention: true,
  },
  {
    name: "settle-disputes",
    tier: "B",
    what: "Re-run the glossary amend pass so it settles the open terminology disputes the verifier raised.",
    primitive: "index.js --stages=glossary --force",
    countsAsIntervention: true,
  },
  {
    name: "stop-stalled-run",
    tier: "B",
    what: "End a run that is alive but has stopped making progress, and hand the claim back so the next run can start. The only move in this layer that stops a process, and it is refused for a run that is still making model calls or tool calls.",
    primitive: "delivery.js --stop-run (utils/runlock.js)",
    countsAsIntervention: false,
  },
  {
    name: "stop-and-report",
    tier: "B",
    what: "Stop, write the human-facing report, and leave the run where it is.",
    primitive: "delivery.js",
    countsAsIntervention: false,
  },
  {
    name: "open-ticket",
    tier: "B",
    what: "Ask the diagnostics team. Required when the same action against the same finding has already failed twice (utils/ledger.js).",
    primitive: "delivery.js --open-ticket, then diagnose.js --ticket=<id> (utils/tickets.js)",
    countsAsIntervention: false,
  },
  {
    name: "answer-question",
    tier: "A",
    what: "Reply to a question the diagnostics team asked back. This is the manager answering, not acting: it cites a folder listing, a report, or the plan of record, and it changes nothing on disk.",
    primitive: "recordAnswer (utils/tickets.js)",
    countsAsIntervention: false,
  },
  {
    name: "choose-option",
    tier: "A",
    what: "Pick one of the options the diagnostics team offered. The manager chooses among the options the banned-option filter allowed; it may not invent one, and it may not choose a refused one.",
    primitive: "delivery.js --choose=<optionId> --ticket=<id> --reason=<text> (recordChoice, utils/tickets.js)",
    countsAsIntervention: false,
  },
  {
    name: "dev-team-patch",
    tier: "A",
    what: "Send the ticket to the dev team, which is the only role that may change the code. The manager's move here is choosing an option marked requiresCodeChange and letting that team write it; the manager never writes it.",
    primitive: "fix.js --ticket=<id> (utils/devteam.js)",
    countsAsIntervention: false,
  },
  {
    name: "judge-patch",
    tier: "A",
    what: "Accept or reject a patch the dev team proposed. These are the manager's only two verbs on a code change, and neither one applies it: the commit is the dev team's act, and the wipe-and-cascade that makes the accepted code run is a separate, counted intervention.",
    primitive: "delivery.js --accept-patch=<id> / --reject-patch=<id> (utils/patches.js)",
    countsAsIntervention: false,
  },

  // Tier C — never available, at any count, in any mode. Named here so a refusal can name it.
  {
    name: "disable-guard",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "the carry-forward gates are the only thing that can see a cumulative artifact lose terms (gotcha 64). Only the account owner may un-check one.",
  },
  {
    name: "allow-fail",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "--allow-fail / --allow-no-glossary skip the entry gate that stops a token being spent on a foundation that was never built.",
  },
  {
    name: "lower-threshold",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "PASSING_SCORE is the definition of good enough. Moving it redefines the question instead of improving the artifact.",
  },
  {
    name: "delete-evidence",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: ".rejected files and reports are how a run explains itself, and they are the before-side of every acceptance comparison.",
  },
  {
    name: "edit-code",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "the manager has no code access. A code change is a dev-team proposal the manager accepts or rejects (plan §5).",
  },
  {
    name: "edit-hooks",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "hooks/ are per-machine configuration that decide which model grades the work (gotcha 22).",
  },
  {
    name: "rename-volume-folder",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "renaming a folder that holds pipeline output orphans every artifact built under the old name (gotcha 28).",
  },
  {
    name: "run-intake",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "intake is its own step with its own agent and guards. The manager may report that it is needed; it may not answer the intake questions (decided 2026-10-05).",
  },
];


/**
 * Look up one action by name.
 * @param {string} name
 * @returns {DeliveryAction|null}
 */
function actionByName(name) {
  return DELIVERY_ACTIONS.find((a) => a.name === name) || null;
}


/**
 * Is this action available to the manager at all?
 * @param {string} name
 * @returns {{allowed: boolean, action: DeliveryAction|null, why: string}}
 */
function actionIsAvailable(name) {
  const action = actionByName(name);
  if (!action) return { allowed: false, action: null, why: `"${name}" is not on the action menu at all.` };
  if (action.tier === "C") return { allowed: false, action, why: action.why };
  return { allowed: true, action, why: "" };
}

// ─── Reading the working state ────────────────────────────────────────────────


module.exports = {
  CUMULATIVE_STEPS,
  CHAPTER_STATE_STEPS,
  DAMAGE_KINDS,
  EVIDENCE_KINDS,
  ESCALATION_HEADLINES,
  DELIVERY_ACTIONS,
  actionByName,
  actionIsAvailable,
};

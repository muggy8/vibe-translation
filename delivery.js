#!/usr/bin/env node
/**
 * delivery.js — the delivery manager.
 *
 * What this is: the manager's **eyes** and, in `act` mode, its **hands**. It answers the
 * question the account owner assigned to this layer on 2026-10-05 — *"I'm coming back to this
 * after a long weekend: which step do I call next?"* — by reading the working state off the
 * disk, and in `act` mode it then runs the step list it wrote.
 *
 * It is a *customer* of the pipeline, not an insider (AGENTS.md §3.6, plan §3). Everything it
 * reads is something a customer could read: the plan of record, what each volume folder
 * actually holds, the deterministic step assessments, the run ledger, and the publish report.
 * It never reads `.logs/**`, never reads a `.js`, a prompt file or a hook, and never calls the
 * intake agent. Acting does not change that: it runs the pipeline's own command, it does not
 * reach into it.
 *
 * `DELIVERY_MODE` (default **report**, decided 2026-10-05):
 *   - `report` — write the plan and stop. Nothing is executed.
 *   - `act`    — execute the plan, one step at a time, through the step runner. Every action
 *     passes three gates first (below), and every action that runs is written to the ledger
 *     with its outcome judged by comparing the deliverable before and after
 *     (`utils/delivery-verify.js` — never "did the error go away?", gotcha 73). The same
 *     comparison closes a ticket (`closeTicketOnDeliverable`), so "did it help?" has one answer
 *     here rather than two.
 *
 * The three gates, in the order they are asked:
 *   1. **Is it on the menu?** `DELIVERY_ACTIONS` in `utils/resume.js`. Tier C is not a limit
 *      this tool can reach, and the refusal names what it refused.
 *   2. **Is a run already going?** `utils/runlock.js`. Starting a step while a step is already
 *      writing the same folders is how an artifact ends half-built by one process and half by
 *      another (gotcha 66), and nothing downstream can tell afterwards.
 *   3. **Has this already been tried, and did it help?** `utils/ledger.js`. The same action
 *      against the same finding ending `unchanged` or `worse` twice is refused, and so is a
 *      step that has spent its `DELIVERY_MAX_INTERVENTIONS` share. Both become a ticket,
 *      because "I have run out of moves on this step" means the step needs somebody who can
 *      see the code.
 *
 * And per the account owner's decision, **choosing where to resume is not an intervention** —
 * removing output that already exists is. `countsAsIntervention` on each menu entry is what
 * makes that a field rather than a sentence.
 *
 * Usage:
 *   node delivery.js                       # report for SERIES_LOCATION
 *   node delivery.js --series=<dir>        # report for another series
 *   node delivery.js --mode=act            # run the plan
 *   node delivery.js --json                # also print the plan as JSON
 *   node delivery.js --no-write            # print only, write nothing (report mode only)
 *   node delivery.js --mode=act --accept-patch=<id> --reason="…"   # judge a proposal: accept it
 *   node delivery.js --mode=act --reject-patch=<id> --reason="…"   # judge a proposal: refuse it
 *
 * Accepting or rejecting a proposal is the manager's whole authority over a code change, and it is
 * the only thing it may do with one: it never applies it, and it never commits it (that is the dev
 * team's act, through `npm run fix`). Act mode also refuses to run any step while a proposal is
 * unjudged in the working tree, because the tree is what the step runner executes.
 *
 * See AGENTS.md §3.6 and the plan notebook.
 */

require("./types"); // JSDoc type definitions
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const {
  readWorkingState,
  planResume,
  actionIsAvailable,
  maxInterventionsPerStep,
  interventionsUsed,
} = require("./utils/resume");
const {
  measureDeliverable,
  compareDeliverable,
  describeComparison,
  accountOf,
  summarizeSnapshot,
  closureFromComparison,
} = require("./utils/delivery-verify");
const { postMortemDir } = require("./utils/postmortem");
const { wipeAttemptOutputs } = require("./utils/fs");
const { readLedger, appendLedgerEntry, interventionAllowed } = require("./utils/ledger");
const { createTicket, closeTicket } = require("./utils/tickets");
const { acquireRunLock, releaseRunLock, runLockPath } = require("./utils/runlock");
const patches = require("./utils/patches");

const ROOT = __dirname;
const PLAN_MD = "delivery-plan.md";
const PLAN_JSON = "delivery-plan.json";

/**
 * Read the CLI flags this runner owns. Unknown flags are refused: a mistyped flag on a tool
 * that reads a live 17-volume series should fail, not be ignored.
 *
 * @param {string[]} argv
 * @returns {{mode: string, seriesDir: string|null, json: boolean, write: boolean, error: string|null}}
 */
function readArgs(argv) {
  const out = {
    mode: null,
    seriesDir: null,
    json: false,
    write: true,
    acceptPatch: null,
    rejectPatch: null,
    reason: null,
    error: null,
  };
  for (const arg of argv) {
    if (arg === "--json") out.json = true;
    else if (arg === "--no-write") out.write = false;
    else if (arg.startsWith("--mode=")) out.mode = arg.slice("--mode=".length).trim().toLowerCase();
    else if (arg.startsWith("--series=")) out.seriesDir = arg.slice("--series=".length).trim();
    else if (arg.startsWith("--accept-patch=")) out.acceptPatch = arg.slice("--accept-patch=".length).trim();
    else if (arg.startsWith("--reject-patch=")) out.rejectPatch = arg.slice("--reject-patch=".length).trim();
    else if (arg.startsWith("--reason=")) out.reason = arg.slice("--reason=".length);
    else {
      out.error =
        `unknown flag "${arg}". Known flags: --mode=report|act, --series=<dir>, --json, --no-write, ` +
        `--accept-patch=<id> --reason="<text>", --reject-patch=<id> --reason="<text>"`;
      break;
    }
  }
  if (out.acceptPatch && out.rejectPatch) {
    out.error = `--accept-patch and --reject-patch are one decision. Choose one.`;
  }
  return out;
}

/**
 * `DELIVERY_MODE`, with the command line winning. The default is `report`.
 * @param {string|null} fromFlag
 * @returns {string}
 */
function resolveMode(fromFlag) {
  if (fromFlag) return fromFlag;
  const env = (process.env.DELIVERY_MODE || "").trim().toLowerCase();
  if (env) return env;
  return "report";
}

// ─── The plan as a report ─────────────────────────────────────────────────────

/**
 * The plan as it should be printed: short, readable, and honest about what it is not.
 * @param {import("./utils/resume").ResumePlan} plan
 * @param {string} mode
 * @returns {string}
 */
function renderConsole(plan, mode) {
  const lines = [];
  lines.push(`[delivery] ${plan.headline}`);
  lines.push(`[delivery] series: ${plan.seriesDir}`);
  for (const s of plan.steps) {
    if (s.action === "none") continue;
    const label =
      s.action === "after" ? "then" : s.action === "blocked" ? "blocked" : s.action === "ticket" ? "ask" : "now";
    lines.push(`[delivery]   ${label.padEnd(6)} ${s.step}${s.fromVolume ? ` (from volume ${s.fromVolume})` : ""}${s.actionName ? ` — ${s.actionName}` : ""}`);
    for (const w of s.wipeFirst) lines.push(`[delivery]          remove first: ${w.files.length} file(s) in ${w.volumeDir}`);
  }
  const untouched = plan.steps.filter((s) => s.action === "none").map((s) => s.step);
  if (untouched.length) lines.push(`[delivery]   leave alone: ${untouched.join(", ")}`);
  for (const n of plan.notes) lines.push(`[delivery] note: ${n}`);
  if (mode === "act") {
    lines.push(
      `[delivery] mode act: this is what will be executed, one step at a time, through the step runner.`
    );
  } else {
    lines.push(`[delivery] mode report: nothing was executed. This is a proposal.`);
  }
  return lines.join("\n");
}

/**
 * What act mode actually did, printed after the fact. The manager's report is not complete
 * until it says what happened, and "I ran it" is not an outcome.
 *
 * @param {Array<Object>} execution
 * @returns {string}
 */
function renderExecution(execution) {
  const lines = ["[delivery] ── what act mode did ──"];
  for (const e of execution) {
    if (e.refused) {
      lines.push(`[delivery]   refused ${e.step} (${e.actionName}): ${e.reason}`);
      if (e.ticket) lines.push(`[delivery]     ticket opened: ${e.ticket}`);
      continue;
    }
    lines.push(
      `[delivery]   ran ${e.step} (${e.actionName}): wiped ${e.wiped} file(s), step exited ${e.code}, ` +
        `${e.progress.before} → ${e.progress.after} volumes built → ${e.outcome}`
    );
    lines.push(`[delivery]     deliverable: ${e.account}`);
    if (e.damage && e.damage.length) {
      lines.push(`[delivery]     damage: ${e.damage.join(", ")} — this action is not a fix, whatever it removed`);
    }
    if (e.note) lines.push(`[delivery]     ${e.note}`);
  }
  return lines.join("\n");
}

// ─── Act mode: the gates ──────────────────────────────────────────────────────

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
 * The question the manager asks when a gate stops it. Findings-shaped, never outcome-shaped
 * (`utils/tickets.js` refuses the other shape), and it names what was already tried out of the
 * ledger rather than out of the manager's memory.
 *
 * @param {import("./utils/resume").ResumeStepPlan} step
 * @param {import("./utils/resume").ResumePlan} plan
 * @param {Object} state - The working state the plan was built from.
 * @param {string} reason - The gate's refusal.
 * @param {string} run
 * @returns {{ticket: Object|null, problems: Object[]}}
 */
function openTicketFor({ step, plan, state, reason, run }) {
  const stepState = (state.stepStates || []).find((s) => s.step === step.step) || {};
  const evidence = [];
  const cite = (f, label) => {
    if (!f) return;
    if (step.fromVolume && f.volume && String(f.volume) !== String(step.fromVolume)) return;
    evidence.push({ file: f.file, note: `${label} ${f.kind}: ${f.message}` });
  };
  for (const f of stepState.damageFindings || []) cite(f, `[HIGH]`);
  for (const f of stepState.evidenceFindings || []) cite(f, `[HIGH]`);
  if (!evidence.length) {
    // The assessment named nothing citable (it could not run, or the plan was not built from a
    // triage). Say which report the diagnostics team should read, rather than inventing evidence.
    evidence.push({
      file: `${step.step}.md (post-mortem report)`,
      note: `the assessment for ${step.step}: ${step.finding || "no finding named"} — ${reason}`,
    });
  }

  const tried = (readLedger().entries || [])
    .filter((e) => e.kind === "intervention" && e.step === step.step && e.run === run)
    .map((e) => ({ action: e.action, outcome: e.outcome, ledgerId: e.id }));

  const result = createTicket({
    run,
    step: step.step,
    volume: step.fromVolume,
    finding: step.finding || "unspecified",
    evidence,
    tried,
    ruledOut: [
      `re-running ${step.step} as it stands — the plan already proposes it and the ledger says what it produced`,
      "deleting the gate evidence — Tier C, and not mine to do",
    ],
    question:
      `"${step.actionName}" on ${step.step}${step.fromVolume ? ` volume ${step.fromVolume}` : ""} has been tried and ` +
      `the deliverable did not move. What is producing ${step.finding || "this finding"} that removing ` +
      `${step.step}'s output and running it again does not remove?`,
  });

  return { ticket: result.ticket, problems: result.problems || [] };
}

// ─── Act mode: the doing ──────────────────────────────────────────────────────

/**
 * Run one step through the step runner, in its own process.
 *
 * The manager does not call a task module. It runs the same command a human would
 * (`node index.js --stages=<step>`), which is what keeps "the manager acted" and "the account
 * owner typed it" the same event as far as the pipeline is concerned — and what makes the
 * hooks, the fresh process and the post-mortem fire exactly as they always do.
 *
 * `SERIES_LOCATION` is set explicitly for the child. Inheriting it from `.env` would let a
 * triage asked about `--series=<fixture>` run a step against the live 17 volumes, which is
 * gotcha 69's failure with the volume dial turned up.
 *
 * @param {{step: string, flags: string[], run: string, seriesDir: string}} opts
 * @returns {Promise<{ok: boolean, code: number, output: string}>}
 */
function runPipelineStep({ step, flags = [], run, seriesDir }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "index.js"), `--stages=${step}`, ...flags], {
      cwd: ROOT,
      env: { ...process.env, INDEX_RUN_ID: run, SERIES_LOCATION: seriesDir },
    });

    let output = "";
    const capture = (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    child.on("error", (err) => resolve({ ok: false, code: -2, output: `${output}\nspawn error: ${err.message}` }));
    child.on("close", (code) => resolve({ ok: code === 0, code: code === null ? -1 : code, output }));
  });
}

/**
 * Remove the outputs the plan named, so the skip-checks cannot no-op the fix.
 *
 * The list is the resume step's declared outputs with `{installment}` resolved — never a
 * `.rejected` file (Tier C: gate evidence is not cleanup) and never another step's files.
 * `wipeAttemptOutputs` deletes only what it is handed and never walks the folder, so the staged
 * book cannot be caught in it.
 *
 * @param {import("./utils/resume").ResumeStepPlan} step
 * @returns {Promise<number>} Files actually removed.
 */
async function performWipe(step) {
  let removed = 0;
  for (const w of step.wipeFirst || []) {
    removed += (await wipeAttemptOutputs(w.volumeDir, w.files)).length;
  }
  return removed;
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

/**
 * Execute the plan.
 *
 * @param {{plan: import("./utils/resume").ResumePlan, state: Object,
 *   runStep?: Function}} opts
 * @returns {Promise<{exitCode: number, execution: Object[], run: string}>}
 */
async function runActPlan({ plan, state, runStep = runPipelineStep }) {
  const log = (line) => console.log(`[delivery] ${line}`);
  const targets = executableSteps(plan);

  // An unjudged patch is live code. The working tree of `main` is what the step runner executes, so
  // running a step while a proposal is sitting in it — or while a REJECTED patch has not been put back
  // — runs code the manager has not accepted (gotcha 66). Refusing here costs nothing; running costs a
  // real run's worth of model calls on code nobody signed off.
  const unresolved = patches.unresolvedPatches();
  if (unresolved.length) {
    log(
      `REFUSED: ${unresolved.map((p) => `${p.id} (${p.status})`).join(", ")} ` +
        `is in the working tree of main and has not been accepted. The pipeline runs whatever is in this ` +
        `tree, so acting now would run code you have not judged.`
    );
    for (const p of unresolved) {
      if (p.status === "rejected") log(`  ${p.id} was rejected and not reverted: node fix.js --revert=${p.id}`);
      else log(`  ${p.id} is waiting for your judgment: npm run delivery --mode=act --accept-patch=${p.id} --reason="…" (or --reject-patch)`);
    }
    log("Nothing was executed, and nothing was deleted.");
    return { exitCode: 1, execution: [], run: state.run || null };
  }

  if (!targets.length) {
    const escalated = (plan.steps || []).filter((s) => s.action === "ticket" || s.action === "blocked");
    if (plan.verdict === "blocked") {
      log("act mode: the run is blocked on intake, which is not this manager's step to run (Tier C). Nothing was executed.");
      return { exitCode: 1, execution: [], run: state.run || null };
    }
    if (escalated.length) {
      log(
        `act mode: the plan's answer for ${escalated.map((s) => s.step).join(", ")} is a question, not a step. ` +
          `The steps listed after it are conditional on that question being answered, so nothing was executed.`
      );
      return { exitCode: 1, execution: [], run: state.run || null };
    }
    log("act mode: the plan contains no step to run. Nothing was executed.");
    return { exitCode: 0, execution: [], run: state.run || null };
  }

  // The run the interventions belong to. Continuing the newest recorded run — rather than
  // starting a fresh one per invocation — is what lets the anti-spin gate see the whole story:
  // a manager that starts a new memory every time it acts can never be stopped for repeating
  // itself. A genuinely new pipeline run makes its own id, and that is where the count resets.
  const run = state.run || process.env.INDEX_RUN_ID || `delivery-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  process.env.INDEX_RUN_ID = run;

  const lock = acquireRunLock({ by: "delivery.js act", run });
  if (!lock.acquired && lock.lock) {
    log(`REFUSED: ${lock.note || "a pipeline run is already in progress"}.`);
    log(`Nothing was executed. Starting a step while another process is writing the same volumes is how an artifact ends half-built by one and half by the other.`);
    log(`If that run is not actually running, remove ${runLockPath()}.`);
    return { exitCode: 1, execution: [], run };
  }
  if (!lock.acquired) {
    log(`REFUSED: ${lock.note}`);
    log("Act mode needs to be certain nothing else is writing. Report mode does not, and can still run.");
    return { exitCode: 1, execution: [], run };
  }
  if (lock.note) log(lock.note);

  const execution = [];
  let current = state;
  let stopped = null;

  try {
    for (const step of targets) {
      log(`── ${step.step}: ${step.actionName}${step.fromVolume ? ` from volume ${step.fromVolume}` : ""} ──`);

      const menu = gateMenu(step);
      if (!menu.allowed) {
        log(`REFUSED (not on the menu): ${menu.why}`);
        execution.push({ step: step.step, actionName: step.actionName, refused: true, reason: menu.why });
        stopped = "tier-c";
        break;
      }

      const budget = gateBudget(step, run);
      if (!budget.allowed) {
        log(`REFUSED (budget): ${budget.why}`);
        const t = openTicketFor({ step, plan, state: current, reason: budget.why, run });
        recordRefusal({ step, run, reason: budget.why, ticket: t.ticket });
        execution.push({ step: step.step, actionName: step.actionName, refused: true, reason: budget.why, ticket: t.ticket ? t.ticket.id : null });
        stopped = step.step;
        log(`stopping: the plan is a sequence. ${step.step} is where the run stopped, and every step after it is written on the assumption that this one was repaired.`);
        break;
      }

      const spin = gateSpin(step, run);
      if (!spin.allowed) {
        log(`REFUSED (already tried): ${spin.why}`);
        const t = openTicketFor({ step, plan, state: current, reason: spin.why, run });
        recordRefusal({ step, run, reason: spin.why, ticket: t.ticket });
        execution.push({ step: step.step, actionName: step.actionName, refused: true, reason: spin.why, ticket: t.ticket ? t.ticket.id : null });
        stopped = step.step;
        log(`stopping: ${step.step} needs the diagnostics team, and running the steps after it would build on a foundation this manager could not fix.`);
        break;
      }

      // Measured before anything is deleted: the deliverable as it was when the manager decided to
      // act. The wipe is part of what gets judged. An action that removed a volume's accepted
      // output and rebuilt nothing made the deliverable worse, and the old per-volume count could
      // not see the difference between "nothing moved" and "something was lost".
      const before = await measureDeliverable({ seriesDir: plan.seriesDir, volumes: current.volumes });
      const beforeProgress = progressOf(before, step.step);

      const wiped = await performWipe(step);
      if (wiped) log(`  removed ${wiped} file(s) so the skip-checks cannot read the old work as up to date`);

      const result = await runStep({ step: step.step, flags: step.flags || [], run, seriesDir: plan.seriesDir });
      log(`  step runner exited ${result.code}${result.ok ? "" : " — the step did not finish"}`);

      const afterState = await readWorkingState({ seriesDir: plan.seriesDir });
      const after = await measureDeliverable({ seriesDir: plan.seriesDir, volumes: afterState.volumes });
      const afterProgress = progressOf(after, step.step);
      const comparison = compareDeliverable(before, after);
      const outcome = comparison.outcome;
      const account = accountOf(comparison);

      const entry = appendLedgerEntry({
        kind: "intervention",
        run,
        step: step.step,
        volume: step.fromVolume,
        finding: step.finding,
        action: step.actionName,
        outcome,
        decidedBy: "manager",
        // The account is stored, not just printed. A ledger entry that records a verdict without
        // the numbers behind it is a verdict nobody can check afterwards — including the
        // diagnostics team, who is the reader this layer exists to serve.
        signals: { before: summarizeSnapshot(before), after: summarizeSnapshot(after) },
        note:
          `${account}; ${step.step}: ${beforeProgress.built} → ${afterProgress.built} of ` +
          `${afterProgress.built + afterProgress.missing} volumes built; step exited ${result.code}` +
          `${wiped ? `; wiped ${wiped} file(s) first` : ""}`,
      });
      if (entry.error) log(`  ledger: ${entry.error}`);

      execution.push({
        step: step.step,
        actionName: step.actionName,
        refused: false,
        wiped,
        code: result.code,
        progress: { before: beforeProgress.built, after: afterProgress.built },
        outcome,
        account,
        damage: comparison.regressions.map((r) => r.label),
        ledgerId: entry.entry ? entry.entry.id : null,
        note:
          outcome === "unchanged"
            ? `the deliverable did not move. The ledger now counts this as an attempt that did not help: ` +
              `the next identical action against ${step.finding || "this finding"} is the one the gate refuses.`
            : outcome === "worse"
              ? `the deliverable is worse than before this action (${comparison.regressions
                  .map((r) => r.label)
                  .join(", ")}). The ledger counts it as an attempt that did harm, and the next identical ` +
                `action against ${step.finding || "this finding"} is the one the gate refuses.`
              : null,
      });

      log(`  outcome: ${outcome} — ${account}`);
      for (const line of describeComparison(comparison)) log(line);

      current = afterState;

      if (!result.ok) {
        stopped = step.step;
        log(`stopping: ${step.step} did not finish, and every later step builds on what it did not produce.`);
        break;
      }
    }
  } finally {
    releaseRunLock();
  }

  return { exitCode: stopped === "tier-c" ? 2 : stopped ? 1 : 0, execution, run };
}

/**
 * Write the refusal down. A gate that refuses silently is a gate that gets worked around, and
 * "I considered this and stopped" is the half of the ledger a human needs in order to agree or
 * disagree with it.
 *
 * @param {{step: import("./utils/resume").ResumeStepPlan, run: string, reason: string, ticket: Object|null}} opts
 */
function recordRefusal({ step, run, reason, ticket }) {
  const entry = appendLedgerEntry({
    kind: "intervention",
    run,
    step: step.step,
    volume: step.fromVolume,
    finding: step.finding,
    action: step.actionName,
    outcome: "refused",
    decidedBy: "manager",
    ticket: ticket ? ticket.id : null,
    note: reason,
  });
  if (entry.error) console.log(`[delivery] ledger: ${entry.error}`);
}

// ─── Closing a ticket on the deliverable ──────────────────────────────────────

/**
 * Close a ticket by measuring the deliverable now and comparing it with the measurement taken
 * before the fix was attempted.
 *
 * This is the other half of the seam: act mode's ledger entry and a ticket's closure are produced
 * by the same comparison (`utils/delivery-verify.js`), so the manager cannot record `worse` in the
 * ledger and close the ticket `improved`. A ticket may not close as `finding-gone` — `closeTicket`
 * already refuses that — and it may not be closed on a judgement the deliverable does not support.
 *
 * @param {{ticketId: string, before: import("./utils/delivery-verify").DeliverableSnapshot,
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

/**
 * The manager's whole authority over a code proposal: accept it, or reject it. Never apply it.
 *
 * Three things are deliberate here.
 *
 * **It needs act mode.** Accepting a proposal is a decision with consequences, and `report` mode is
 * the mode that has none. A manager that records decisions while claiming to be rehearsing is the
 * contradiction `--no-write` with `--mode=act` already refuses.
 *
 * **It is not a ledger entry.** The patch record is the record of the judgment. What goes into the
 * ledger is the *consequence* — the wipe-and-cascade that makes the accepted code actually run — and
 * that is already a menu action with a budget and an anti-spin gate. Recording the judgment as an
 * intervention too would spend the step's budget on reading a proposal.
 *
 * **The reason is checked, not just required.** "I accepted it because volume 15 passes now" is the
 * same demand `validateTicketShape` refuses on the manager's question, arriving from the other end of
 * the conversation (gotcha 70). The reason has to say something about the deliverable.
 *
 * @param {{patchId: string, outcome: "accepted"|"rejected", reason: string|null, mode: string}} opts
 * @returns {{exitCode: number, patch: Object|null, error: string|null}}
 */
function judgePatch({ patchId, outcome, reason, mode }) {
  const log = (line) => console.log(`[delivery] ${line}`);
  if (mode !== "act") {
    log(
      `REFUSED: accepting or rejecting a patch is an act, and this run is in report mode. ` +
        `Report mode proposes and decides nothing. Pass --mode=act.`
    );
    return { exitCode: 2, patch: null, error: "report mode does not judge patches" };
  }
  if (!patchId) {
    log("REFUSED: no patch named.");
    return { exitCode: 2, patch: null, error: "no patch named" };
  }

  const paths = patches.patchPaths();
  const stored = patches.findPatch(patchId, patches.readPatches(paths.json).patches);
  if (!stored) {
    log(`REFUSED: no patch ${patchId}. \`node fix.js --status\` lists what exists.`);
    return { exitCode: 2, patch: null, error: `no patch ${patchId}` };
  }

  const result =
    outcome === "accepted"
      ? patches.acceptPatch(patchId, { reason, decidedBy: "manager" }, paths)
      : patches.rejectPatch(patchId, { reason, decidedBy: "manager" }, paths);

  if (result.error) {
    log(`REFUSED: ${result.error}`);
    return { exitCode: 2, patch: result.patch || null, error: result.error };
  }

  const patch = result.patch;
  log(`${patch.id} ${outcome}: ${patch.decision.reason}`);
  log(`  ${patch.step}${patch.volume ? ` volume ${patch.volume}` : ""} — ${patch.summary}`);
  log(`  files it names: ${patch.files ? patch.files.join(", ") : "(none)"}`);
  if (outcome === "accepted") {
    log(
      `  Next: the commit is the dev team's act, not yours — node fix.js --commit=${patch.id}. ` +
        `Then the accepted code has to be made to run: the skip checks do not know the code changed, ` +
        `so the step it fixes has to be wiped and cascaded (gotcha 66). Run npm run delivery --mode=act ` +
        `and the plan will propose that.`
    );
  } else {
    log(
      `  Next: this code is still in the working tree, and the tree is what the next run executes. ` +
        `Put it back — node fix.js --revert=${patch.id}. Act mode refuses to run a step until that is done.`
    );
  }
  return { exitCode: 0, patch, error: null };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`[delivery] ${args.error}`);
    process.exitCode = 2;
    return;
  }

  const mode = resolveMode(args.mode);
  if (mode !== "report" && mode !== "act") {
    console.error(`[delivery] DELIVERY_MODE must be "report" or "act". Got "${mode}".`);
    process.exitCode = 2;
    return;
  }
  if (mode === "act" && !args.write) {
    console.error(
      "[delivery] --no-write with --mode=act is a contradiction: acting writes files, a ledger, and a step's output. " +
        "Use report mode to see the plan without executing it."
    );
    process.exitCode = 2;
    return;
  }

  // Judging a proposal is its own act, and it does not need a triage: the patch, its proposal and its
  // checks are the whole question. Doing it here also means a mistyped patch id is refused before a
  // series is read.
  if (args.acceptPatch || args.rejectPatch) {
    const judged = judgePatch({
      patchId: args.acceptPatch || args.rejectPatch,
      outcome: args.acceptPatch ? "accepted" : "rejected",
      reason: args.reason,
      mode,
    });
    process.exitCode = judged.exitCode;
    return;
  }

  const state = await readWorkingState({ seriesDir: args.seriesDir || undefined });
  const plan = planResume(state);

  // Every action the plan names must be on the menu. This check exists so a future edit to
  // planResume cannot invent an action that was never approved (plan §4).
  for (const s of plan.steps) {
    if (!s.actionName) continue;
    const verdict = actionIsAvailable(s.actionName);
    if (!verdict.allowed) {
      console.error(`[delivery] the plan proposed "${s.actionName}", which is not available: ${verdict.why}`);
      process.exitCode = 2;
      return;
    }
  }

  console.log(renderConsole(plan, mode));

  const execution =
    mode === "act"
      ? await runActPlan({ plan, state })
      : { exitCode: 0, execution: [], run: state.run || null };

  if (mode === "act") console.log(renderExecution(execution.execution));

  if (args.write) {
    const written = { ...plan, mode, run: execution.run, execution: execution.execution };
    written.markdown = `${plan.markdown}\n\n## What was executed\n\n${
      execution.execution.length
        ? execution.execution
            .map((e) =>
              e.refused
                ? `- **${e.step}** — refused: ${e.reason}${e.ticket ? ` (ticket ${e.ticket})` : ""}`
                : `- **${e.step}** — ${e.actionName}: wiped ${e.wiped} file(s), step exited ${e.code}, ` +
                  `${e.progress.before} → ${e.progress.after} volumes built → **${e.outcome}**\n` +
                  `  - deliverable: ${e.account}` +
                  (e.damage && e.damage.length ? `\n  - damage: ${e.damage.join(", ")}` : "")
            )
            .join("\n")
        : mode === "act"
          ? "- nothing was executed. The plan's answer was a question, a block, or \"nothing to do\"."
          : "- nothing. This was a proposal."
    }\n`;

    const dir = postMortemDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, PLAN_MD), written.markdown, "utf8");
      fs.writeFileSync(path.join(dir, PLAN_JSON), JSON.stringify(written, null, 2) + "\n", "utf8");
      console.log(`[delivery] plan written: ${path.join(dir, PLAN_MD)}`);
    } catch (err) {
      console.error(`[delivery] the plan could not be written (${err.message})`);
      process.exitCode = 1;
      return;
    }
  }

  if (args.json) console.log(JSON.stringify({ ...plan, mode, execution: execution.execution }, null, 2));

  process.exitCode = execution.exitCode;
}

module.exports = {
  readArgs,
  resolveMode,
  renderConsole,
  renderExecution,
  executableSteps,
  gateMenu,
  gateSpin,
  gateBudget,
  openTicketFor,
  runPipelineStep,
  performWipe,
  progressOf,
  closeTicketOnDeliverable,
  judgePatch,
  runActPlan,
  main,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[delivery] failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

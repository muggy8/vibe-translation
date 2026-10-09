/**
 * Executing the plan one step at a time: wipe the step's declared outputs (never .rejected evidence), spawn the real step runner in its own process, re-read the state, judge the outcome by comparing the deliverable before and after, and record it under the NEWEST recorded run — a manager that invents its own run id each time is uncatchable by the anti-spin gate. The plan is a SEQUENCE: the first refusal or failed step stops it.
 *
 * Part of the delivery.js layer (split out of the original single file).
 */

require("../types"); // JSDoc type definitions
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  readWorkingState,
  planResume,
  actionIsAvailable,
  maxInterventionsPerStep,
  interventionsUsed,
} = require("../utils/resume");
const {
  measureDeliverable,
  compareDeliverable,
  describeComparison,
  accountOf,
  summarizeSnapshot,
  closureFromComparison,
} = require("../utils/delivery-verify");
const { wipeAttemptOutputs } = require("../utils/fs");
const { appendLedgerEntry } = require("../utils/ledger");
const { acquireRunLock, releaseRunLock, runLockPath } = require("../utils/runlock");
const { installShutdownWatch, trackChild, isStopping, stoppingSignal } = require("../utils/shutdown");
const patches = require("../utils/patches");
const projectRoot = path.resolve(__dirname, "..");

const { executableSteps, gateBudget, gateMenu, gateSpin, progressOf } = require("./gates");
const { openTicketFor, recordRefusal } = require("./tickets");

/**
 * The run this manager's records belong to.
 *
 * Continuing the newest recorded run — rather than starting a fresh one per invocation — is what
 * lets the anti-spin gate see the whole story: a manager that starts a new memory every time it acts
 * can never be caught repeating itself (gotcha 72). A genuinely new `npm run pipeline` makes its own
 * id, and that is where the count resets. One function, so a ticket and the ledger entry that
 * mentions it cannot land under two different runs.
 *
 * @param {Object} state - The working state, whose `run` is the newest recorded one.
 * @returns {string}
 */
function runIdFor(state) {
  return state && state.run ? state.run : process.env.INDEX_RUN_ID || `delivery-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}


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
    // The manager's step is a child process, and Node leaves children running when the process
    // that spawned them is stopped. Registered so stopping the manager stops the step (utils/shutdown.js).
    trackChild(child, `index.js --stages=${step}`);

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
      log(
        "  the question IS the move the menu offers, and it is free. Write it down: " +
          "npm run delivery -- --open-ticket, then npm run diagnose -- --ticket=<id> to have the diagnostics team answer it."
      );
      return { exitCode: 1, execution: [], run: state.run || null };
    }
    log("act mode: the plan contains no step to run. Nothing was executed.");
    return { exitCode: 0, execution: [], run: state.run || null };
  }

  // The run the interventions belong to. See `runIdFor`: the same rule the ticket channel uses, so a
  // ticket and the ledger entry that names it are counted together.
  const run = runIdFor(state);
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

  // Same rule as the runner: a manager that is stopped must not leave its step running. The orphan
  // is what makes every later run refuse — the lock is held by a LIVE pid that nobody can tell to
  // stop, and only a human can clear it (utils/shutdown.js).
  installShutdownWatch({ label: "delivery.js act", onStop: () => releaseRunLock() });

  const execution = [];
  let current = state;
  let stopped = null;

  try {
    for (const step of targets) {
      if (isStopping()) {
        log(`this manager was asked to stop (${stoppingSignal()}). ${targets.length - execution.length} step(s) were not started.`);
        stopped = "stopped";
        break;
      }
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


const ROOT = projectRoot;

module.exports = {
  runIdFor,
  runPipelineStep,
  performWipe,
  runActPlan,
  ROOT,
};

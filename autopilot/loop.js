/**
 * autopilot/loop.js — one decision at a time: read the run, ask the manager, do the move, look again.
 *
 * The loop never assumes its own effect: after every move it re-reads the working state and the
 * plan, because the plan is what the run says now, not what it said when the loop started. A run
 * already in progress stops the loop before it can overlap another process writing the same
 * volume folder (gotcha 66), and the iteration cap is the backstop on the manager, not on the
 * run.
 *
 * **One correction per decision, for a mistyped name only.** The manager's answer has to reproduce
 * ids of the shape `TCK-delivery-2026-10-06T18-27-38-632Z-1/O2` character for character, and a model
 * that drops a chunk of one is a transcription error, not a decision the state should die on. When the
 * refusal is "there is no such ticket / option / question / patch", the loop asks once more with the
 * refusal in front of it — the refusal already prints the ids that exist. When the refusal is a guard
 * (a banned option, an answer that cites the code, an `end` that is not provable) the loop stops at
 * once: a guard the role is asked to try again is a guard with a retry button on it.
 *
 * Watch mode runs the whole loop and writes nothing: the same reading, the same decision, the
 * same account, no command started.
 */

const path = require("path");

const resume = require("../utils/resume");
const manager = require("../utils/manager");
const patches = require("../utils/patches");
const { runInProgress, describeRunLock } = require("../utils/runlock");
const {
  offerMoves,
  unfinishedTickets,
  waitingPatches,
  previewTicketFor,
  ticketNamed,
} = require("./moves");
const { runCommand, commandFor, describeCommand, followUpsFor } = require("./commands");

const projectRoot = path.join(__dirname, ".."); // the runner's ROOT

/**
 * The refusals that are a name written wrong rather than a move the state forbids. Every one of them
 * says "there is no such X" and prints the X's that DO exist, which is what a corrected answer needs.
 *
 * What is deliberately NOT here: `banned-option`, `cited-forbidden`, `already-answered`,
 * `not-answered`, `not-chosen`, `option-not-code`, `patch-exists`, `already-judged`,
 * `unsound-reason`, `thin-escalation`, `end-not-provable`, `unknown-action`. Those are the guards, and
 * re-asking the model about a guard is asking it to rephrase the same move until the guard flinches.
 */
const NAMING_SLIPS = new Set([
  "unknown-ticket",
  "unknown-option",
  "unknown-question",
  "unknown-patch",
  "not-offered",
]);

// ─── The loop ─────────────────────────────────────────────────────────────────

/**
 * One iteration's reading of the state, assembled once and read by everything else in the iteration.
 *
 * @param {Object} opts
 * @param {string|null} opts.seriesDir
 * @returns {Promise<{state: Object, plan: Object, tickets: Object[], patches: Object[]}>}
 */
async function readTheRun({ seriesDir }) {
  const state = await resume.readWorkingState({ seriesDir: seriesDir || undefined });
  const plan = resume.planResume(state);
  return {
    state,
    plan,
    tickets: unfinishedTickets(state.tickets),
    patches: waitingPatches(state.patches),
  };
}

/**
 * Carry out one decision.
 *
 * @param {Object} args
 * @param {import("./utils/manager").ManagerAction} args.action
 * @param {Object} args.snapshot - The iteration's reading (`{state, plan, tickets, patches}`).
 * @param {Object[]} args.tickets - The tickets as they are NOW, which in act mode may include the one
 *   this iteration just opened.
 * @param {string} args.seriesDir
 * @param {(line: string) => void} args.log
 * @returns {Promise<{ok: boolean, stop: boolean, note: string}>}
 */
async function execute({ action, snapshot, tickets, seriesDir, log }) {
  const pending = snapshot.patches;

  if (action.action === "end") {
    return { ok: true, stop: true, note: "the end was provable from the records, and the loop stopped there." };
  }
  if (action.action === "escalate") {
    return {
      ok: false,
      stop: true,
      note:
        `this is the account owner's decision, and the loop stops rather than working around it:\n` +
        `  ${action.note}\n` +
        `  Read: npm run delivery (the plan), npm run diagnose -- --open (the tickets), npm run fix -- --status (the patches).`,
    };
  }

  // An accept is the one move this loop may not take on the manager's word alone. `safeToAcceptAutomatically`
  // is the machine's answer to "is this ordinary project code, with the pinned checks green, with no
  // warning on it, and with nothing the team escalated in prose?" — and anything that fails it is a
  // judgment a human has to make. Rejecting needs no such gate: it is the direction that undoes work,
  // and it is always available.
  if (action.action === "judge" && action.outcome === "accept") {
    const patch = pending.find((p) => p.id === action.patch);
    const safety = manager.safeToAcceptAutomatically(patch);
    if (!safety.safe) {
      return {
        ok: false,
        stop: true,
        note:
          `the manager asked to accept ${action.patch}, and this loop will not do that unattended:\n` +
          safety.reasons.map((r) => `  - ${r}`).join("\n") +
          `\n  It is the account owner's judgment. Read it: npm run fix -- --show=${action.patch}`,
      };
    }
    log(`  accepted unattended because: ${safety.notes.join("; ")}`);
  }

  const args = commandFor(action, { ticket: ticketNamed(action, tickets) });
  if (!args.length) return { ok: false, stop: true, note: `no command maps to "${action.action}".` };

  const first = await runCommand(args, { seriesDir });
  if (first.code !== 0) {
    return {
      ok: false,
      stop: true,
      note:
        `"${path.basename(args[0])}" exited ${first.code}${first.error ? ` (${first.error})` : ""}. ` +
        `The loop stops here rather than spending another decision on a state it cannot describe. ` +
        `Read what it left behind and run this command again — the loop is resumable.`,
    };
  }

  const follow = followUpsFor(action);
  if (follow.length) {
    const next = await runCommand(follow, { seriesDir });
    if (next.code !== 0) {
      return {
        ok: false,
        stop: true,
        note:
          `the judgment was recorded, but "${path.basename(follow[0])} ${follow[1]}" exited ${next.code}. ` +
          `${action.outcome === "accept" ? "The patch is accepted and not yet committed" : "The patch is rejected and still in the tree"}, ` +
          `which gates the pipeline. Finish it by hand: node ${path.basename(follow[0])} ${follow[1]}`,
      };
    }
    log(
      action.outcome === "accept"
        ? `  committed to main. The next triage wipe-and-cascades, which is what makes the change take effect (gotcha 66).`
        : `  put back. The files the patch created are named by the revert output — deleting them is not this loop's move.`
    );
  }

  return { ok: true, stop: false, note: "" };
}

/**
 * Open the ticket the triage proposes, before asking the manager what to do about it.
 *
 * Without this the loop's only legal move at the volume-15 shape is `escalate`: `diagnose` is refused
 * because no ticket exists, `run` is not offered because the plan's answer is a question, and `end`
 * is not provable because the glossary is missing. That is a correct reading and a weak one — the
 * manager would report that it has a question instead of asking it.
 *
 * @param {Object} args
 * @param {Object} args.plan
 * @param {string} args.seriesDir
 * @param {(line: string) => void} args.log
 * @returns {Promise<boolean>} - true when the ticket was opened (or was already open).
 */
async function openTheTicketThePlanProposes({ plan, seriesDir, log }) {
  const step = (plan.steps || []).find((s) => s.action === "ticket");
  if (!step || step.existingTicket) return false;
  log(`the triage says the answer for ${step.step} is a question. Writing it down…`);
  const res = await runCommand([path.join(projectRoot, "delivery.js"), "--open-ticket"], { seriesDir });
  if (res.code !== 0) {
    log(`  the question could not be written (exit ${res.code}). The loop cannot ask what it cannot write.`);
    return false;
  }
  return true;
}

/**
 * The loop.
 *
 * @param {Object} opts
 * @param {string} opts.mode - `watch` or `act`.
 * @param {string|null} [opts.seriesDir]
 * @param {number} opts.iterationCap
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{exitCode: number, why: string, decisions: Object[]}>}
 */
async function runLoop({ mode, seriesDir, iterationCap, log = (line) => console.log(`[autopilot] ${line}`) }) {
  const decisions = [];
  const acting = mode === "act";

  log(`mode ${mode}: ${acting ? "the loop runs the moves it decides" : "the loop decides and prints, and touches nothing"}`);

  for (let iteration = 1; iteration <= iterationCap; iteration += 1) {
    // Something else is writing these volumes. The loop takes no lock of its own (see the header), so
    // this check is the whole of its side of the bargain — and each command it spawns enforces its own
    // rule: act mode refuses while a run holds the lock, and `fix.js` refuses for anything that mutates
    // the tree (gotcha 72, gotcha 66).
    const busy = runInProgress();
    if (busy.inProgress) {
      return {
        exitCode: 1,
        why:
          `a run is already in progress: ${busy.note || describeRunLock(busy.lock)}. ` +
          "The loop will not act beside it, and it will not delete the lock it cannot verify.",
        decisions,
      };
    }

    const snapshot = await readTheRun({ seriesDir });
    const { plan } = snapshot;
    log(`── iteration ${iteration} ── ${plan.headline}`);

    if (!plan.verdict) {
      return { exitCode: 1, why: "the triage produced no verdict: there is no plan of record to read.", decisions };
    }

    let tickets = snapshot.tickets;
    let pending = snapshot.patches;

    if (acting) {
      if (await openTheTicketThePlanProposes({ plan, seriesDir: plan.seriesDir, log })) {
        const again = await readTheRun({ seriesDir });
        tickets = again.tickets;
        pending = again.patches;
      }
    } else {
      const preview = previewTicketFor({ plan, run: plan.run || "unrun" });
      if (preview) {
        tickets = [...tickets, preview];
        log(`  watch mode writes nothing, so this question is shown as a preview, not opened: ${preview.id}`);
      }
    }

    const moves = offerMoves({ plan, tickets, patches: pending });

    let decision = await manager.managerDecision({ plan, moves, tickets, patches: pending, log: (line) => log(line) });

    // One correction, and only for the refusals that are a naming slip: the answer named a ticket,
    // option, question or patch that is not there, or a step that is not on the menu. The refusal
    // already prints the names that DO exist, so asking again is a correction rather than another roll
    // of the dice — and the ids are long enough to be mistyped (`TCK-delivery-2026-10-06T18-27-38-632Z-1`
    // is 43 characters, and on 2026-10-07 one was copied as `…2026-10-27-38-632Z-1`, which cost a whole
    // run whose diagnosis had already been paid for).
    //
    // A safety refusal is never re-asked. A banned option, an answer that cites the code, an `end` that
    // is not provable, a second diagnosis of an answered ticket: putting those in front of the model
    // again is inviting it to phrase the same move so it slips through, and a guard the role can wear
    // down is not a guard (gotcha 70).
    let refusedFirst = null;
    if (!decision.ok && NAMING_SLIPS.has(decision.kind)) {
      refusedFirst = { kind: decision.kind, refusal: decision.refusal };
      log(
        `the answer named something that is not there (${decision.kind}). Asking once more with the refusal ` +
          `in front of it…`
      );
      decision = await manager.managerDecision({
        plan,
        moves,
        tickets,
        patches: pending,
        correction: decision.refusal,
        log: (line) => log(line),
      });
      if (decision.ok) log(`  the second answer is a move this state supports.`);
    }

    const record = {
      iteration,
      verdict: plan.verdict,
      headline: plan.headline,
      offered: moves.map((m) => m.label),
      action: decision.action || null,
      reason: decision.action ? decision.action.reason : null,
      refusal: decision.refusal,
      kind: decision.kind,
      refusedFirst,
      warnings: decision.warnings || [],
      command: (() => {
        if (!decision.action) return null;
        const args = commandFor(decision.action, { ticket: ticketNamed(decision.action, tickets) });
        return args.length ? describeCommand(args) : null;
      })(),
    };
    decisions.push(record);

    if (!decision.ok) {
      // A manager that cannot name a legal move is not a manager that should keep going. Fail closed
      // and say what the menu was, because the useful failure is the one the account owner can read.
      log(`REFUSED: ${decision.refusal}`);
      if (refusedFirst) log(`  (twice: the first answer was refused too — ${refusedFirst.refusal})`);
      if (decision.kind === "unparseable" || decision.kind === "call-failed") {
        log(
          "  the reply was not a decision at all. On this machine the usual cause is the wrong container " +
            "serving the manager's call: every container advertises the same model id, and the only record " +
            "of which one the pre-manager hook started is hooks/.model-switch-state."
        );
      }
      log(`  the menu it was offered:\n${moves.map((m) => `    ${m.label}`).join("\n")}`);
      return { exitCode: 1, why: `the manager's decision was refused (${decision.kind}).`, decisions };
    }

    const action = decision.action;
    log(`decision: ${action.action}${action.step ? ` — ${action.step}` : ""}${action.ticket ? ` — ${action.ticket}` : ""}${action.patch ? ` — ${action.patch}` : ""}${action.outcome ? ` (${action.outcome})` : ""}`);
    log(`  why: ${action.reason}`);

    const args = commandFor(action, { ticket: ticketNamed(action, tickets) });
    if (!acting) {
      log(
        args.length
          ? `  watch mode stops here. In act mode this is the command it would run:\n    ${describeCommand(args)}`
          : `  watch mode stops here. "${action.action}" runs no command: it is a stop, not an action.`
      );
      return {
        exitCode: action.action === "end" ? 0 : 1,
        why:
          action.action === "end"
            ? "watch mode: the manager's decision was end, and the records prove it."
            : `watch mode: the manager's decision was "${action.action}". Nothing was executed and nothing was recorded.`,
        decisions,
      };
    }

    const done = await execute({ action, snapshot, tickets, seriesDir: plan.seriesDir, log: (line) => log(line) });
    if (done.note) log(done.note);
    if (done.stop) {
      return { exitCode: done.ok ? 0 : 1, why: done.ok ? "the loop finished." : "the loop stopped.", decisions };
    }
  }

  return {
    exitCode: 1,
    why:
      `stopped after ${iterationCap} decisions without a provable end. This cap is a wall, not a budget: ` +
      `the anti-spin gate and the per-step allowance are what catch a repetition, and this catches the ` +
      `other case — legal, different moves that never arrive. Read the decisions above.`,
    decisions,
  };
}

module.exports = { readTheRun, execute, openTheTicketThePlanProposes, runLoop };

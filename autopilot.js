#!/usr/bin/env node
/**
 * autopilot.js — the delivery manager driving a run, one decision at a time.
 *
 * Everything else in this layer is a piece of the product: `utils/resume.js` reads the state,
 * `delivery.js` gates and executes a plan, `diagnose.js` is the read-only team, `fix.js` is the dev
 * team, `utils/manager.js` is the manager's judgment. What was missing is the thing that connects
 * them — a loop that asks the manager "what next?" and then types the command for the answer it
 * gave. This is that loop, and it is deliberately thin: it owns no gate, no budget, no wipe, no
 * measurement, and no record. Every one of those already lives behind a command the account owner
 * could type by hand, and the loop types the same commands.
 *
 * **Why the loop calls commands instead of functions.** A code fix takes effect at a process
 * boundary, not inside a running one (gotcha 66): Node caches a module the first time it is
 * required, and `gulpfile.js` requires all ten task modules at the top of the file. A patch that
 * changes `utils/prompt.js` — or `delivery.js` itself, which is not a banned path — would be
 * invisible to a loop that had already required them, so the loop would go on executing the
 * pre-patch gates for the rest of the run. Spawning the account owner's own command per action is
 * the honest reload boundary, and it is cheap here: the idempotent skip-checks make a re-run nearly
 * free, and a process start is not a model container switch (gotcha 22). It also means the loop
 * cannot bypass a gate by reaching past it, which is the difference between a manager and a wrapper.
 *
 * **Why the manager is asked on every iteration.** The triage is deterministic and it already says
 * a great deal. What it cannot say is which of the moves it just listed to make, and that is the
 * only thing here that needs a model. `utils/manager.js` hands it a shaped report and a closed menu,
 * and `validateManagerAction` refuses anything the state does not support — so a wrong answer costs
 * one iteration, not one volume of the series.
 *
 * **Watch mode is the default, and it writes nothing.** `AUTOPILOT_MODE=watch` reads the state,
 * asks the manager, prints the decision, the full menu it was offered, and the exact command the act
 * loop would have run — and then stops. No ticket is opened, no ledger entry is written, no step
 * runs, no lock is taken. That is not caution for its own sake: act mode's rehearsal is refused
 * (`--no-write` with `--mode=act` exits 2) because a recorded intervention that did nothing poisons
 * the ledger that exists to catch a spin (gotcha 72). A mode that records nothing at all is the only
 * safe rehearsal, and this is it. `act` is what the account owner switches on after reading what the
 * manager decided about a real run.
 *
 * **The loop takes no run lock of its own.** `delivery.js --mode=act` takes one under the newest
 * recorded run, and a loop-wide lock would make its own children refuse (gotcha 72). Holding a lock
 * across the whole loop would also claim "a run is in progress" during the `fix` branch, which is
 * exactly the case gotcha 66 forbids: a patch may not land while a run is working on the volumes.
 * What the loop does instead is check `runInProgress()` before each action and stop if something
 * else started — and let each command enforce its own lock rule.
 *
 * Usage:
 *   node autopilot.js                       # watch: decide and print, touch nothing
 *   node autopilot.js --mode=act            # drive the run
 *   node autopilot.js --series=<dir>        # a series other than SERIES_LOCATION
 *   node autopilot.js --max-iterations=8    # the backstop (default 12)
 *   node autopilot.js --json                # also print the decision log as JSON
 *
 * Exit codes: 0 the end was provable; 1 the loop stopped short (a refusal, an escalation, the
 * iteration cap); 2 the request itself was refused (a bad flag, a mode that does not exist).
 *
 * See AGENTS.md §3.6 and the plan notebook.
 */

require("./types"); // JSDoc type definitions

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const resume = require("./utils/resume");
const delivery = require("./delivery");
const manager = require("./utils/manager");
const patches = require("./utils/patches");
const { unansweredQuestions, sameQuestion } = require("./utils/tickets");
const { runInProgress, describeRunLock } = require("./utils/runlock");
const { runTurnWithHooks, AUTOPILOT_TASK } = require("./utils/hooks");

const ROOT = __dirname;

// ─── The loop's own settings ──────────────────────────────────────────────────

/**
 * The flags this loop owns. Unknown flags are refused: this is a tool pointed at a live 17-volume
 * series, and a mistyped flag should fail rather than be quietly ignored.
 *
 * There is deliberately no `--dry-run` here. `--dry-run` is a pipeline flag that also suppresses
 * hooks (utils/hooks.js), so passing it through would make the manager's model switch silently
 * optional — and on this machine the switch is the only thing that decides which container answers
 * (gotcha 22). Watch mode is the rehearsal, and it is a mode, not a flag the pipeline sees.
 *
 * @param {string[]} argv
 * @returns {{mode: string|null, seriesDir: string|null, maxIterations: number|null, json: boolean, error: string|null}}
 */
function readArgs(argv) {
  const out = { mode: null, seriesDir: null, maxIterations: null, json: false, error: null };
  for (const arg of argv) {
    if (arg === "--json") out.json = true;
    else if (arg.startsWith("--mode=")) out.mode = arg.slice("--mode=".length).trim().toLowerCase();
    else if (arg.startsWith("--series=")) out.seriesDir = arg.slice("--series=".length).trim();
    else if (arg.startsWith("--max-iterations=")) {
      const n = parseInt(arg.slice("--max-iterations=".length), 10);
      if (!Number.isFinite(n) || n < 1) {
        out.error = `--max-iterations needs a whole number of 1 or more. Got "${arg.slice("--max-iterations=".length)}".`;
        break;
      }
      out.maxIterations = n;
    } else {
      out.error =
        `unknown flag "${arg}". Known flags: --mode=watch|act, --series=<dir>, --max-iterations=<n>, --json. ` +
        `(There is no --dry-run: watch mode is the rehearsal, and it writes nothing.)`;
      break;
    }
  }
  return out;
}

/**
 * `AUTOPILOT_MODE`, with the command line winning. The default is **watch**.
 *
 * The ordering is the same one `DELIVERY_MODE` uses and for the same reason: this layer earns the
 * right to act by writing a report that is demonstrably right about a real run (AGENTS.md §3.6).
 *
 * @param {string|null} fromFlag
 * @returns {string}
 */
function resolveMode(fromFlag) {
  if (fromFlag) return fromFlag;
  const env = (process.env.AUTOPILOT_MODE || "").trim().toLowerCase();
  if (env) return env;
  return "watch";
}

/**
 * How many decisions this loop may make before it stops and reports.
 *
 * It is a wall, not a budget. There is no token budget in this layer and there will not be one (gotcha
 * 69): what stops a spin is the ledger's anti-spin gate and the per-step intervention allowance, both
 * of which are about *repetition* rather than cost. This cap exists for the one thing those gates do
 * not cover — a loop that keeps making legal, different, non-repeating moves without ever reaching a
 * provable end. That is not a spin the ledger can see, and it should not run overnight.
 *
 * @param {number|null} fromFlag
 * @returns {number} - Default 12, minimum 1.
 */
function maxIterations(fromFlag) {
  if (fromFlag) return fromFlag;
  const n = parseInt(process.env.AUTOPILOT_MAX_ITERATIONS, 10);
  return Number.isFinite(n) && n >= 1 ? n : 12;
}

// ─── The menu the manager is offered ──────────────────────────────────────────

/**
 * The moves the current state actually supports, as data.
 *
 * Two rules decide this list, and both are about what the manager is NOT allowed to do:
 *
 * - **Exactly one `run` move per plan.** `delivery.executableSteps(plan)` returns the plan's whole
 *   executable sequence, and executing it runs the whole sequence: `runActPlan` stops at the first
 *   refusal or failed step, and the sequence IS the triage's answer. Offering the later steps
 *   separately would let the manager skip the cascade, and a skipped cascade is worse than a re-run —
 *   the later volumes would stay built on the artifact that was just repaired (gotcha 66). The label
 *   names the steps the same sequence will run, so the manager is choosing a sequence, not a step.
 * - **A banned option is never on the menu.** The options come from the ticket, and
 *   `utils/tickets.js` already refused the banned ones on the way in (gotcha 70). This list reads
 *   `ticket.options`, not `ticket.refusedOptions`, so the cheap item is not merely discouraged — it
 *   is not offered. The refused ones stay visible on the ticket itself, where the account owner reads
 *   them.
 *
 * @param {Object} args
 * @param {import("./utils/resume").ResumePlan} args.plan
 * @param {Object[]} args.tickets - The tickets still open with the teams.
 * @param {Object[]} args.patches - The patches waiting for a judgment.
 * @returns {import("./utils/manager").ManagerMove[]}
 */
function offerMoves({ plan, tickets, patches: pending }) {
  const moves = [];

  const sequence = delivery.executableSteps(plan);
  if (sequence.length) {
    const entry = sequence[0];
    const after = sequence.slice(1);
    const bits = [entry.actionName];
    if (entry.fromVolume) bits.push(`from volume ${entry.fromVolume}`);
    if (entry.cascade) bits.push("cascade");
    bits.push(entry.countsAsIntervention ? "counts against this step's allowance" : "free");
    moves.push({
      kind: "run",
      step: entry.step,
      actionName: entry.actionName,
      countsAsIntervention: !!entry.countsAsIntervention,
      label:
        `run ${entry.step} — ${bits.join(", ")}` +
        (after.length ? `; the same sequence then continues with ${after.map((s) => s.step).join(", ")}` : ""),
    });
  }

  for (const t of tickets) {
    if (!t.diagnosis) {
      moves.push({
        kind: "diagnose",
        ticket: t.id,
        label: `diagnose ${t.id} — the read-only team opens the code, the prompts and the transcripts. You do not.`,
      });
      continue;
    }
    const answered = new Set((t.answers || []).map((a) => String(a.question).trim()));
    for (const q of (t.diagnosis.questions || []).filter((q) => !answered.has(String(q).trim()))) {
      moves.push({
        kind: "answer",
        ticket: t.id,
        label: `answer ${t.id}: "${q}" — say only what a customer is allowed to see (the folders, the reports, the plan).`,
      });
    }
    for (const o of t.options || []) {
      moves.push({
        kind: "choose",
        ticket: t.id,
        option: o.id,
        label:
          `choose ${o.id} on ${t.id} — ${o.label} [touches ${o.touches}; cost ${o.cost}; risk ${o.risk}]` +
          (o.requiresCodeChange ? " · needs the dev team" : ""),
      });
    }
    const chosen = (t.options || []).find((o) => o.id === (t.choice && t.choice.optionId));
    if (chosen && chosen.requiresCodeChange && !pending.some((p) => p.ticketId === t.id)) {
      moves.push({
        kind: "fix",
        ticket: t.id,
        label: `fix ${t.id} — call in the dev team for ${t.choice.optionId}. They work inside a boundary they may not widen.`,
      });
    }
  }

  // Defensive on purpose: `waitingPatches` already filtered this list, but a menu that offered the
  // re-judging of a decided patch would be a menu the gate then refuses, and a manager shown a move it
  // is about to be refused for is a manager that has to guess which of its options are real.
  for (const p of waitingPatches(pending)) {
    for (const outcome of ["accept", "reject"]) {
      moves.push({
        kind: "judge",
        patch: p.id,
        outcome,
        label: `judge ${p.id} ${outcome} — ${outcome === "accept" ? "the change lands in main and the cascade applies it" : "the change is put back"}. Say what the change does, not that the complaint stopped.`,
      });
    }
  }

  moves.push({
    kind: "escalate",
    label: "escalate — stop, and name in one sentence the decision that belongs to the account owner.",
  });
  return moves;
}

/**
 * The tickets still unfinished: open, answered, or chosen. A closed ticket is a finished piece of
 * work — its closure says what the deliverable did — and re-opening it is the triage's job, not a
 * move here.
 *
 * @param {Object[]} all
 * @returns {Object[]}
 */
function unfinishedTickets(all) {
  return (all || []).filter((t) => t && t.status !== "closed");
}

/**
 * The patches waiting for a judgment. `utils/patches.js` has the list; this only keeps the ones the
 * manager has not decided, because a decided patch is not a question.
 *
 * @param {Object[]} all
 * @returns {Object[]}
 */
function waitingPatches(all) {
  return (all || []).filter((p) => p && patches.UNJUDGED_STATUSES.includes(p.status));
}

/**
 * In watch mode, the question this plan would put in writing, shown as a record that is clearly not
 * one.
 *
 * Watch mode writes nothing, so no ticket exists, so `diagnose` would be an illegal move and the
 * manager would be left with `escalate` as its only answer — which is a correct but useless reading
 * of a state whose honest answer is a question. Showing the question the triage would ask (the exact
 * text `delivery.js --open-ticket` would write, from the same table) makes the rehearsal mean what it
 * claims to mean, and the status line says out loud that it was not written.
 *
 * @param {Object} args
 * @param {import("./utils/resume").ResumePlan} args.plan
 * @param {string} args.run
 * @returns {Object|null}
 */
function previewTicketFor({ plan, run }) {
  const step = (plan.steps || []).find((s) => s.action === "ticket");
  if (!step || step.existingTicket) return null;
  const question = delivery.questionForEscalation(step);
  if (!question) return null;
  return {
    id: `PREVIEW-${step.step}-${step.fromVolume || "whole-step"}`,
    run,
    step: step.step,
    volume: step.fromVolume || null,
    finding: step.finding || "unspecified",
    status: "PREVIEW — not written. Watch mode writes nothing.",
    question,
    evidence: [],
    tried: [],
    ruledOut: [],
  };
}

/**
 * The record a decision names, when it names one.
 *
 * @param {import("./utils/manager").ManagerAction} action
 * @param {Object[]} tickets
 * @returns {Object|null}
 */
function ticketNamed(action, tickets = []) {
  if (!action.ticket) return null;
  return (tickets || []).find((t) => t && t.id === action.ticket) || null;
}

// ─── Running the account owner's commands ─────────────────────────────────────

/**
 * Run one of the commands the account owner would type, in its own process.
 *
 * `SERIES_LOCATION` is set explicitly rather than inherited, for the same reason `delivery.js` sets
 * it on the step children: a `--series=<dir>` override has to reach the child, and task modules read
 * their settings at module load (gotcha 66).
 *
 * The child's output is written straight through, because a step that takes an hour has to be
 * readable while it happens, not summarised afterwards.
 *
 * @param {string[]} args - Arguments after `node`, starting with the script path.
 * @param {{seriesDir: string}} opts
 * @returns {Promise<{code: number, error: string|null}>}
 */
function runCommand(args, { seriesDir }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, SERIES_LOCATION: seriesDir },
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", (err) => resolve({ code: 127, error: err.message }));
    child.on("close", (code) => resolve({ code: code === null ? 1 : code, error: null }));
  });
}

/**
 * The command a decision turns into. Kept as a function of the decision alone so watch mode can
 * print exactly what act mode would have run, and the two cannot drift apart.
 *
 * The one thing it does beyond spelling out the decision is answer a question with the diagnostics
 * team's OWN wording: `recordAnswer` matches a question exactly and `diagnose.js` refuses to guess
 * when a ticket holds more than one open question, so the loop passes the ticket's text rather than
 * the manager's paraphrase of it. `validateManagerAction` has already refused a paraphrase that
 * matches nothing, so the lookup here cannot miss.
 *
 * @param {import("./utils/manager").ManagerAction} action
 * @param {{ticket?: Object}} [context] - The record the decision names, when it names one.
 * @returns {string[]} - Arguments for `node`, or [] for the moves that run nothing.
 */
function commandFor(action, context = {}) {
  switch (action.action) {
    case "run":
      return [path.join(ROOT, "delivery.js"), "--mode=act"];
    case "diagnose":
      return [path.join(ROOT, "diagnose.js"), `--ticket=${action.ticket}`];
    case "answer": {
      const args = [path.join(ROOT, "diagnose.js"), `--ticket=${action.ticket}`];
      const ticket = context.ticket;
      const open = ticket ? unansweredQuestions(ticket) : [];
      const question =
        open.find((q) => sameQuestion(q, action.question)) || (open.length === 1 ? open[0] : null);
      if (question) args.push(`--question=${question}`);
      args.push(`--answer=${action.answer}`);
      return args;
    }
    case "choose":
      return [
        path.join(ROOT, "delivery.js"),
        `--choose=${action.option}`,
        `--ticket=${action.ticket}`,
        `--reason=${action.reason}`,
      ];
    case "fix":
      return [path.join(ROOT, "fix.js"), `--ticket=${action.ticket}`];
    case "judge":
      return [
        path.join(ROOT, "delivery.js"),
        "--mode=act",
        `${action.outcome === "accept" ? "--accept-patch" : "--reject-patch"}=${action.patch}`,
        `--reason=${action.reason}`,
      ];
    default:
      return [];
  }
}

/**
 * The command as the account owner would type it, so watch mode prints the exact thing act mode runs.
 *
 * @param {string[]} args
 * @returns {string}
 */
function describeCommand(args) {
  return `node ${args
    .map((a) => (path.isAbsolute(a) && path.dirname(a) === ROOT ? path.basename(a) : a))
    .join(" ")}`;
}

/**
 * The follow-up commands a judgment needs, and why they are not optional.
 *
 * Accepting a patch is not landing it: the commit is the dev team's act (`fix.js --commit`), and
 * until it happens the change sits uncommitted in the tree of `main`. Rejecting one is not undoing
 * it either — a rejected patch is in `unresolvedPatches()`, which is what makes act mode refuse the
 * whole plan, so a reject that was not reverted deadlocks the next run.
 *
 * @param {import("./utils/manager").ManagerAction} action
 * @returns {string[]}
 */
function followUpsFor(action) {
  if (action.action !== "judge") return [];
  const flag = action.outcome === "accept" ? `--commit=${action.patch}` : `--revert=${action.patch}`;
  return [path.join(ROOT, "fix.js"), flag];
}

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
  const res = await runCommand([path.join(ROOT, "delivery.js"), "--open-ticket"], { seriesDir });
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

    const decision = await manager.managerDecision({ plan, moves, tickets, patches: pending, log: (line) => log(line) });
    const record = {
      iteration,
      verdict: plan.verdict,
      headline: plan.headline,
      offered: moves.map((m) => m.label),
      action: decision.action || null,
      reason: decision.action ? decision.action.reason : null,
      refusal: decision.refusal,
      kind: decision.kind,
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

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`[autopilot] ${args.error}`);
    process.exitCode = 2;
    return;
  }

  const mode = resolveMode(args.mode);
  if (mode !== "watch" && mode !== "act") {
    console.error(
      `[autopilot] AUTOPILOT_MODE must be "watch" (decide and print, touch nothing) or "act" (drive the run). Got "${mode}".`
    );
    process.exitCode = 2;
    return;
  }

  const seriesDir = args.seriesDir || process.env.SERIES_LOCATION || null;
  if (!seriesDir) {
    console.error(
      `[autopilot] SERIES_LOCATION is not set, and --series=<dir> was not given. The loop needs to know which series it is driving.`
    );
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(seriesDir)) {
    console.error(`[autopilot] "${seriesDir}" does not exist.`);
    process.exitCode = 2;
    return;
  }

  const iterationCap = maxIterations(args.maxIterations);

  // `pre-autopilot` / `post-autopilot` wrap the whole loop. `pre-manager` re-fires around every
  // decision (utils/manager.js owns that guarantee), and a repeat switch is a no-op via
  // hooks/.model-switch-state, so the loop does not pay for a container reload per iteration (gotcha 22).
  const result = await runTurnWithHooks(AUTOPILOT_TASK, () =>
    runLoop({ mode, seriesDir, iterationCap })
  );

  console.log(`[autopilot] ${result.why}`);
  if (args.json) console.log(JSON.stringify({ mode, seriesDir, ...result }, null, 2));
  process.exitCode = result.exitCode;
}

module.exports = {
  readArgs,
  resolveMode,
  maxIterations,
  offerMoves,
  unfinishedTickets,
  waitingPatches,
  previewTicketFor,
  commandFor,
  describeCommand,
  followUpsFor,
  ticketNamed,
  runCommand,
  readTheRun,
  runLoop,
  main,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[autopilot] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

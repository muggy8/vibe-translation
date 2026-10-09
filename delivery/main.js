/**
 * The verbs on the escalation ladder (--open-ticket, --choose, --accept-patch, --reject-patch), the run-lock refusal, and the wiring of the above. Each is one act at a time; two in one command is refused.
 *
 * The verbs are separate functions because each one is a different question, and three of them need no
 * triage at all: a patch, a ticket's options and a plan's proposed question are each the whole thing
 * being answered. Reading the series first would make a mistyped id cost a disk walk.
 *
 * Part of the delivery.js layer (split out of the original single file).
 */

require("../types"); // JSDoc type definitions
const fs = require("fs");
const path = require("path");
const { readWorkingState, planResume, actionIsAvailable } = require("../utils/resume");
const { readLedger } = require("../utils/ledger");
const { postMortemDir } = require("../utils/postmortem");

const { readArgs, resolveMode } = require("./cli");
const { renderConsole, renderExecution } = require("./report");
const { chooseOption, judgePatch, openTicketFromPlan } = require("./tickets");
const { runActPlan, runIdFor } = require("./act");
const { stopStalledRun } = require("./stop-run");

const PLAN_MD = "delivery-plan.md";

const PLAN_JSON = "delivery-plan.json";

/**
 * The one shape a refusal takes on this CLI: one line, exit 2, nothing else attempted.
 *
 * @param {string} message - What was refused, and why.
 * @returns {number} The exit code.
 */
function refuse(message) {
  console.error(`[delivery] ${message}`);
  return 2;
}

/**
 * `--accept-patch` / `--reject-patch`: the account owner judging a proposal.
 *
 * It needs no triage — the patch, its proposal and its checks are the whole question — and doing it
 * before the series is read means a mistyped patch id is refused cheaply.
 *
 * @param {Object} args - The parsed CLI arguments.
 * @param {string} mode - "report" or "act".
 * @returns {number} The exit code.
 */
function judgePatchVerb(args, mode) {
  const judged = judgePatch({
    patchId: args.acceptPatch || args.rejectPatch,
    outcome: args.acceptPatch ? "accepted" : "rejected",
    reason: args.reason,
    mode,
  });
  return judged.exitCode;
}

/**
 * `--choose`: the manager picking one of the diagnostics team's options, which summons the dev team.
 *
 * Also needs no triage: the ticket and its options are the whole question. The reply prints the option
 * as the manager has to read it — what it touches, what it could break, and how to check it worked —
 * and names the command that does the work, because choosing is not doing.
 *
 * @param {Object} args - The parsed CLI arguments.
 * @returns {number} The exit code.
 */
function chooseVerb(args) {
  if (!args.write) {
    return refuse(
      "--no-write with --choose is a contradiction: a choice is a record written on a ticket, " +
        "and the dev team is summoned by it. Use --no-write to read the plan, not to answer a ticket."
    );
  }
  const chosen = chooseOption({ ticketId: args.ticket, optionId: args.choose, reason: args.reason });
  if (chosen.error) {
    console.error(`[delivery] REFUSED: ${chosen.error}`);
  } else {
    const t = chosen.ticket;
    console.log(`[delivery] ticket ${t.id}: chose ${chosen.option.id} — ${t.choice.reason}`);
    console.log(`  option: ${chosen.option.label}`);
    console.log(`  touches: ${chosen.option.touches} · cost: ${chosen.option.cost} · risk: ${chosen.option.risk}`);
    console.log(`  how to check it: ${chosen.option.verify}`);
    console.log(
      chosen.option.requiresCodeChange
        ? `  this option needs a code change, which is the dev team's work, not yours: npm run fix -- --ticket=${t.id}`
        : `  this option needs no code change. Run it through the plan: npm run delivery --mode=act`
    );
  }
  if (args.json) console.log(JSON.stringify(chosen, null, 2));
  return chosen.exitCode;
}

/**
 * `--stop-run`: end a run that is alive but has stopped making progress.
 *
 * Needs no triage — the lock and its heartbeat are the whole question — so it is answered before the
 * series is read, the same way a patch judgement is. It is the one verb in this layer that acts on a
 * process rather than on a file, which is why every refusal path in it says what it refused and why
 * (delivery/stop-run.js).
 *
 * @param {Object} args - The parsed CLI arguments.
 * @param {string} mode - "report" or "act".
 * @param {string|null} run - The run the record belongs to.
 * @returns {Promise<number>} The exit code.
 */
async function stopRunVerb(args, mode, run) {
  const result = await stopStalledRun({ mode, run });
  const line = `[delivery] ${result.note}`;
  if (result.exitCode === 2) console.error(line);
  else console.log(line);
  for (const d of result.detail) console.log(`  ${d}`);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  return result.exitCode;
}

/**
 * Every action the plan names must be on the menu.
 *
 * This check exists so a future edit to `planResume` cannot invent an action that was never approved
 * (plan §4).
 *
 * @param {Object} plan - The resume plan.
 * @returns {?string} The refusal to print, or null when every action is available.
 */
function planActionIsUnapproved(plan) {
  for (const s of plan.steps) {
    if (!s.actionName) continue;
    const verdict = actionIsAvailable(s.actionName);
    if (!verdict.allowed) {
      return `the plan proposed "${s.actionName}", which is not available: ${verdict.why}`;
    }
  }
  return null;
}

/**
 * `--open-ticket`: write the question the triage says is the answer.
 *
 * Allowed in BOTH modes: a ticket is the manager's own words, not an action on the corpus. Report
 * mode's "executes nothing" means the pipeline — refusing a question in report mode would make the
 * escalation ladder unusable until the manager was already trusted to act, which is backwards.
 *
 * @param {Object} args - The parsed CLI arguments.
 * @param {Object} plan - The resume plan.
 * @param {Object} state - The working state the plan was read from.
 * @returns {number} The exit code.
 */
function openTicketVerb(args, plan, state) {
  if (!args.write) {
    return refuse(
      "--no-write with --open-ticket is a contradiction: a ticket is a written question for " +
        "the diagnostics team. Use --no-write to read the plan without recording it."
    );
  }
  const opened = openTicketFromPlan({ plan, state, run: runIdFor(state) });
  const line = `[delivery] ${opened.note}`;
  if (opened.exitCode === 2) console.error(line);
  else console.log(line);
  for (const p of opened.problems) {
    console.log(`  ${p.kind || "problem"}: ${p.message || p.note || JSON.stringify(p)}`);
  }
  if (opened.ticket && opened.ticket.question) {
    console.log(`  question: ${opened.ticket.question}`);
    console.log(`  read it: ${path.join(postMortemDir(), "tickets.md")}`);
    console.log(`  next: npm run diagnose -- --ticket=${opened.ticket.id}`);
  }
  if (args.json) console.log(JSON.stringify(opened, null, 2));
  return opened.exitCode;
}

/**
 * The "what was executed" section of the plan of record: one line per step, in the order the run did them.
 *
 * The line is written for the reader who was not there: what was wiped, where the step exited, how the
 * series' progress moved, what the deliverable account says, and what damage was seen.
 *
 * @param {Object[]} executed - The per-step execution records.
 * @param {string} mode - "report" or "act".
 * @returns {string} The Markdown section body.
 */
function executedSection(executed, mode) {
  if (!executed.length) {
    return mode === "act"
      ? "- nothing was executed. The plan's answer was a question, a block, or \"nothing to do\"."
      : "- nothing. This was a proposal.";
  }
  return executed
    .map((e) =>
      e.refused
        ? `- **${e.step}** — refused: ${e.reason}${e.ticket ? ` (ticket ${e.ticket})` : ""}`
        : `- **${e.step}** — ${e.actionName}: wiped ${e.wiped} file(s), step exited ${e.code}, ` +
          `${e.progress.before} → ${e.progress.after} volumes built → **${e.outcome}**\n` +
          `  - deliverable: ${e.account}` +
          (e.damage && e.damage.length ? `\n  - damage: ${e.damage.join(", ")}` : "")
    )
    .join("\n");
}

/**
 * Write the plan of record — the Markdown a human reads and the JSON the next process reads.
 *
 * Both are written or neither is reported as fine: a plan the ledger cannot re-read is how a run
 * forgets what it already tried.
 *
 * @param {Object} args - The parsed CLI arguments.
 * @param {Object} plan - The resume plan.
 * @param {string} mode - "report" or "act".
 * @param {{exitCode: number, execution: Object[], run: string|null}} execution - What the act pass did.
 * @returns {number} 0 when both files were written, 1 when they were not.
 */
function writePlanRecord(args, plan, mode, execution) {
  const written = { ...plan, mode, run: execution.run, execution: execution.execution };
  written.markdown = `${plan.markdown}\n\n## What was executed\n\n${executedSection(execution.execution, mode)}\n`;

  const dir = postMortemDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PLAN_MD), written.markdown, "utf8");
    fs.writeFileSync(path.join(dir, PLAN_JSON), JSON.stringify(written, null, 2) + "\n", "utf8");
    console.log(`[delivery] plan written: ${path.join(dir, PLAN_MD)}`);
  } catch (err) {
    console.error(`[delivery] the plan could not be written (${err.message})`);
    return 1;
  }
  return 0;
}

/**
 * The CLI's whole shape: refuse what cannot be done, answer the verb that needs no triage, then read
 * the run and either report it or act on it.
 * @returns {Promise<void>}
 */
async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.error) {
    process.exitCode = refuse(args.error);
    return;
  }

  const mode = resolveMode(args.mode);
  if (mode !== "report" && mode !== "act") {
    process.exitCode = refuse(`DELIVERY_MODE must be "report" or "act". Got "${mode}".`);
    return;
  }
  if (mode === "act" && !args.write) {
    process.exitCode = refuse(
      "--no-write with --mode=act is a contradiction: acting writes files, a ledger, and a step's output. " +
        "Use report mode to see the plan without executing it."
    );
    return;
  }

  // The two verbs that are complete questions in themselves: a patch, and a ticket's options.
  if (args.acceptPatch || args.rejectPatch) {
    process.exitCode = judgePatchVerb(args, mode);
    return;
  }
  if (args.choose) {
    process.exitCode = chooseVerb(args);
    return;
  }

  // The same rule `runIdFor` uses — continue the newest recorded run so the anti-spin gate sees the
  // whole story — but read straight from the ledger, because a decision about a process does not
  // need to walk 17 volumes first.
  if (args.stopRun) {
    const ledger = readLedger();
    const entries = ledger.entries || [];
    process.exitCode = await stopRunVerb(args, mode, entries.length ? entries[entries.length - 1].run : null);
    return;
  }

  const state = await readWorkingState({ seriesDir: args.seriesDir || undefined });
  const plan = planResume(state);

  // Who is holding the pipeline, said out loud before the plan is printed. Without this line the
  // report proposes "run character-voice" and act mode then refuses it because a live process holds
  // the claim, and the reader has no way to know the two sentences came from different facts.
  if (state.runLock && state.runLock.present) {
    console.log(`[delivery] run lock: ${state.runLock.note}`);
  }

  const unapproved = planActionIsUnapproved(plan);
  if (unapproved) {
    process.exitCode = refuse(unapproved);
    return;
  }

  console.log(renderConsole(plan, mode));

  if (args.openTicket) {
    process.exitCode = openTicketVerb(args, plan, state);
    return;
  }

  const execution =
    mode === "act"
      ? await runActPlan({ plan, state })
      : { exitCode: 0, execution: [], run: state.run || null };

  if (mode === "act") console.log(renderExecution(execution.execution));

  if (args.write) {
    const code = writePlanRecord(args, plan, mode, execution);
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }

  if (args.json) console.log(JSON.stringify({ ...plan, mode, execution: execution.execution }, null, 2));

  process.exitCode = execution.exitCode;
}


module.exports = {
  main,
  PLAN_MD,
  PLAN_JSON,
};

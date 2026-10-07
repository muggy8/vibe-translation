/**
 * The verbs on the escalation ladder (--open-ticket, --choose, --accept-patch, --reject-patch), the run-lock refusal, and the wiring of the above. Each is one act at a time; two in one command is refused.
 *
 * Part of the delivery.js layer (split out of the original single file).
 */

require("../types"); // JSDoc type definitions
const fs = require("fs");
const path = require("path");
const {
  readWorkingState,
  planResume,
  actionIsAvailable,
  maxInterventionsPerStep,
  interventionsUsed,
} = require("../utils/resume");
const { postMortemDir } = require("../utils/postmortem");

const { readArgs, resolveMode } = require("./cli");
const { renderConsole, renderExecution } = require("./report");
const { chooseOption, judgePatch, openTicketFromPlan } = require("./tickets");
const { runActPlan, runIdFor } = require("./act");

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

  // Choosing among the diagnostics team's options is the manager's own act, and it needs no triage
  // either: the ticket and its options are the whole question. Refused before the series is read, so
  // a mistyped ticket id costs no disk walk.
  if (args.choose) {
    if (!args.write) {
      console.error(
        "[delivery] --no-write with --choose is a contradiction: a choice is a record written on a ticket, " +
          "and the dev team is summoned by it. Use --no-write to read the plan, not to answer a ticket."
      );
      process.exitCode = 2;
      return;
    }
    const chosen = chooseOption({ ticketId: args.ticket, optionId: args.choose, reason: args.reason });
    if (chosen.error) console.error(`[delivery] REFUSED: ${chosen.error}`);
    else {
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
    process.exitCode = chosen.exitCode;
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

  // Opening the ticket the plan proposes is the verb behind the `open-ticket` menu entry, and it is
  // allowed in BOTH modes: a ticket is the manager's own words, not an action on the corpus. Report
  // mode's "executes nothing" means the pipeline — refusing a question in report mode would make the
  // escalation ladder unusable until the manager was already trusted to act, which is backwards.
  if (args.openTicket) {
    if (!args.write) {
      console.error(
        "[delivery] --no-write with --open-ticket is a contradiction: a ticket is a written question for " +
          "the diagnostics team. Use --no-write to read the plan without recording it."
      );
      process.exitCode = 2;
      return;
    }
    const opened = openTicketFromPlan({ plan, state, run: runIdFor(state) });
    const line = `[delivery] ${opened.note}`;
    if (opened.exitCode === 2) console.error(line);
    else console.log(line);
    for (const p of opened.problems) console.log(`  ${p.kind || "problem"}: ${p.message || p.note || JSON.stringify(p)}`);
    if (opened.ticket && opened.ticket.question) {
      console.log(`  question: ${opened.ticket.question}`);
      console.log(`  read it: ${path.join(postMortemDir(), "tickets.md")}`);
      console.log(`  next: npm run diagnose -- --ticket=${opened.ticket.id}`);
    }
    if (args.json) console.log(JSON.stringify(opened, null, 2));
    process.exitCode = opened.exitCode;
    return;
  }

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


const PLAN_MD = "delivery-plan.md";

const PLAN_JSON = "delivery-plan.json";


module.exports = {
  main,
  PLAN_MD,
  PLAN_JSON,
};

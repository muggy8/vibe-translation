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
 * See docs/delivery-layer.md and the plan notebook.
 *
 * The code lives in autopilot/: settings.js (what the operator asked for), moves.js (the menu
 * the manager is offered, built from what the run actually says), commands.js (the manager's
 * moves are the account owner's own commands), loop.js (one decision at a time), cli.js (the
 * entry, the hooks, the exit code). This file is the public surface and the CLI entry point.
 */

const settings = require("./autopilot/settings");
const moves = require("./autopilot/moves");
const commands = require("./autopilot/commands");
const loop = require("./autopilot/loop");
const cli = require("./autopilot/cli");

// The public surface, unchanged from the single file.
module.exports = {
  readArgs: settings.readArgs,
  resolveMode: settings.resolveMode,
  maxIterations: settings.maxIterations,
  offerMoves: moves.offerMoves,
  unfinishedTickets: moves.unfinishedTickets,
  waitingPatches: moves.waitingPatches,
  previewTicketFor: moves.previewTicketFor,
  commandFor: commands.commandFor,
  describeCommand: commands.describeCommand,
  followUpsFor: commands.followUpsFor,
  ticketNamed: moves.ticketNamed,
  runCommand: commands.runCommand,
  readTheRun: loop.readTheRun,
  runLoop: loop.runLoop,
  main: cli.main,
};

if (require.main === module) {
  cli.main().catch((err) => {
    console.error(`[autopilot] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

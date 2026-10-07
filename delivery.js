/**
 * delivery.js — the delivery manager's CLI over utils/resume.js, thin on purpose.
 *
 * It reads a state, prints the plan, writes it, and in act mode executes it. Every action
 * the plan names is re-checked against DELIVERY_ACTIONS (exit 2 if it is not on the menu),
 * so a future edit to planResume cannot invent a move. No AI_* variable is read, and no
 * model call is reachable from it.
 *
 * Exit codes: 0 completed, 1 stopped short (a gate refused, or a step did not finish), 2
 * the request itself was refused (an action not on the menu, a contradictory flag).
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./delivery/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

require("./types"); // JSDoc type definitions

const __cli = require("./delivery/cli");
const __report = require("./delivery/report");
const __gates = require("./delivery/gates");
const __tickets = require("./delivery/tickets");
const __act = require("./delivery/act");
const __main = require("./delivery/main");

module.exports = {
  ...__cli,
  ...__report,
  ...__gates,
  ...__tickets,
  ...__act,
  ...__main,
};

const { main } = __main;

if (require.main === module) {
  main().catch((err) => {
    console.error(`[delivery] failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

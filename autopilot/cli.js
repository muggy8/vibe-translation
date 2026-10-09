/**
 * autopilot/cli.js — the entry: the arguments, the hooks around the whole loop, the exit code.
 *
 * `pre-autopilot` / `post-autopilot` wrap the whole loop; `pre-manager` re-fires around every
 * decision (utils/manager.js owns that guarantee), and a repeat switch is a no-op via
 * hooks/.model-switch-state, so the loop does not pay for a container reload per iteration
 * (gotcha 22).
 */

const fs = require("fs");

// The loop drives ONE named series; it does not inherit the pipeline's default source
// folder (AGENTS.md gotcha 79).
const { chosenSeriesLocation } = require("../configs/env-defaults");

const { runTurnWithHooks, AUTOPILOT_TASK } = require("../utils/hooks");
const { auditDeliveryRun, displayPath } = require("../utils/delivery-audit");
const { finding } = require("../utils/postmortem");
const { ledgerPath } = require("../utils/ledger");
const { readArgs, resolveMode, maxIterations } = require("./settings");
const { runLoop } = require("./loop");
const { installShutdownWatch } = require("../utils/shutdown");

// ─── What the loop's refusals become ──────────────────────────────────────────

/**
 * The loop's refused manager decisions, written as findings the audit records.
 *
 * Until now a refusal only ever reached the console: the loop printed the menu it could not read,
 * exited 1, and the next run knew nothing about it. Recurring `manager-refused` entries in the ledger
 * say something the pipeline's own findings cannot — that the *deciding role* produced nothing usable,
 * which on this machine usually means the wrong container is serving the manager's call.
 *
 * The loop itself stays pure: watch mode writes nothing (gotcha 72), and this is the CLI's report on
 * what the loop did, which is the same place the after-run audit already runs.
 *
 * @param {Object[]} decisions - The loop's decision records (`result.decisions`).
 * @returns {import("../utils/postmortem").PostMortemFinding[]}
 */
function refusalFindings(decisions) {
  const file = displayPath(ledgerPath());
  const out = [];
  for (const d of decisions || []) {
    if (d.action) {
      // A move was made, but not on the first answer. The correction is the design working; a run
      // where every decision needs one is a manager that is not reading the menu it was given.
      if (d.refusedFirst) {
        out.push(
          finding("LOW", "manager-corrected", "autopilot", null, file,
            `the manager's first answer was refused (${d.refusedFirst.kind}) and its second was a move ` +
            `this state supports. One correction is the design working; a run where every decision needs ` +
            `one is a manager that is not reading the menu in front of it.`)
        );
      }
      continue;
    }
    out.push(
      finding("HIGH", "manager-refused", "autopilot", null, file,
        `the manager could not name a move (${d.kind}): ${d.refusal}` +
        `${d.refusedFirst ? ` — and the first answer was refused too (${d.refusedFirst.kind})` : ""}. ` +
        `The loop stopped rather than guessing, which is the correct response; the finding is that the` +
        `${d.via === "none" ? " role called none of the tools in front of it and" : " role"} produced no ` +
        `decision at all.`)
    );
  }
  return out;
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

  // The loop holds no run lock of its own — every move is a child command that takes its own. But
  // the loop is the process the account owner stops, so stopping it has to stop the move it is
  // waiting on rather than leaving an hour-long step running with nobody in charge
  // (utils/shutdown.js).
  installShutdownWatch({ label: "autopilot.js" });

  const seriesDir = args.seriesDir || chosenSeriesLocation() || null;
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
  let result;
  try {
    result = await runTurnWithHooks(AUTOPILOT_TASK, () =>
      runLoop({ mode, seriesDir, iterationCap })
    );
  } catch (err) {
    // A loop that threw never reached the point where it reports what it decided. Catching it here is
    // what lets the after-run audit still run: a crash is precisely the moment the records need checking,
    // and an audit that only runs on the happy path is an audit that misses the failure it exists for.
    console.error(`[autopilot] the loop threw: ${err && err.stack ? err.stack : err}`);
    result = {
      exitCode: 1,
      why: `the loop crashed (${err && err.message ? err.message : err}).`,
      decisions: [],
      crashed: String((err && err.message) || err),
    };
  }

  console.log(`[autopilot] ${result.why}`);
  if (args.json) console.log(JSON.stringify({ mode, seriesDir, ...result }, null, 2));
  process.exitCode = result.exitCode;

  // The loop's own after-run check. It is brief because every move the loop made was a child process
  // that ran this same audit and printed its own findings; what the LOOP has to say is whether the
  // channel it drove is consistent afterwards, and that is the one thing no child could see.
  const extraFindings = refusalFindings(result.decisions);
  if (result.crashed) {
    extraFindings.push(
      finding("HIGH", "loop-crashed", "autopilot", null, displayPath(ledgerPath()),
        `the loop threw before it could report a decision: ${result.crashed}. Nothing it decided is on ` +
        `the record, so the next run starts without knowing what this one tried.`)
    );
  }
  await auditDeliveryRun({
    step: "autopilot",
    argv: process.argv.slice(2),
    exitCode: Number(result.exitCode || 0),
    seriesDir,
    brief: true,
    extraFindings,
  });
}

module.exports = { main, refusalFindings };

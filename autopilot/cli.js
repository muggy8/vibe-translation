/**
 * autopilot/cli.js — the entry: the arguments, the hooks around the whole loop, the exit code.
 *
 * `pre-autopilot` / `post-autopilot` wrap the whole loop; `pre-manager` re-fires around every
 * decision (utils/manager.js owns that guarantee), and a repeat switch is a no-op via
 * hooks/.model-switch-state, so the loop does not pay for a container reload per iteration
 * (gotcha 22).
 */

const fs = require("fs");

const { runTurnWithHooks, AUTOPILOT_TASK } = require("../utils/hooks");
const { readArgs, resolveMode, maxIterations } = require("./settings");
const { runLoop } = require("./loop");

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

module.exports = { main };

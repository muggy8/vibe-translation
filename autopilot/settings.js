/**
 * autopilot/settings.js — what the operator asked the manager to do.
 *
 * The default is the safe one and it is the default: watch. Decide, print, touch nothing. Act has
 * to be typed, and the iteration cap is a backstop on the manager, not on the run.
 */

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
 * right to act by writing a report that is demonstrably right about a real run (docs/delivery-layer.md).
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

module.exports = { readArgs, resolveMode, maxIterations };

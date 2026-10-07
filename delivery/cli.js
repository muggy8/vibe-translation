/**
 * Argument parsing and the mode. An unknown flag is refused with exit 2, because a mistyped flag on a tool that reads a live series should fail; --no-write together with --mode=act is refused for the same reason a rehearsal that records is a contradiction.
 *
 * Part of the delivery.js layer (split out of the original single file).
 */

require("../types"); // JSDoc type definitions

/**
 * Read the CLI flags this runner owns. Unknown flags are refused: a mistyped flag on a tool
 * that reads a live 17-volume series should fail, not be ignored.
 *
 * @param {string[]} argv
 * @returns {{mode: string, seriesDir: string|null, json: boolean, write: boolean, error: string|null}}
 */
function readArgs(argv) {
  const out = {
    mode: null,
    seriesDir: null,
    json: false,
    write: true,
    acceptPatch: null,
    rejectPatch: null,
    openTicket: false,
    choose: null,
    ticket: null,
    reason: null,
    error: null,
  };
  for (const arg of argv) {
    if (arg === "--json") out.json = true;
    else if (arg === "--no-write") out.write = false;
    else if (arg === "--open-ticket") out.openTicket = true;
    else if (arg.startsWith("--mode=")) out.mode = arg.slice("--mode=".length).trim().toLowerCase();
    else if (arg.startsWith("--series=")) out.seriesDir = arg.slice("--series=".length).trim();
    else if (arg.startsWith("--accept-patch=")) out.acceptPatch = arg.slice("--accept-patch=".length).trim();
    else if (arg.startsWith("--reject-patch=")) out.rejectPatch = arg.slice("--reject-patch=".length).trim();
    else if (arg.startsWith("--choose=")) out.choose = arg.slice("--choose=".length).trim();
    else if (arg.startsWith("--ticket=")) out.ticket = arg.slice("--ticket=".length).trim();
    else if (arg.startsWith("--reason=")) out.reason = arg.slice("--reason=".length);
    else {
      out.error =
        `unknown flag "${arg}". Known flags: --mode=report|act, --series=<dir>, --json, --no-write, ` +
        `--open-ticket, --choose=<optionId> --ticket=<id> --reason="<text>", ` +
        `--accept-patch=<id> --reason="<text>", --reject-patch=<id> --reason="<text>"`;
      break;
    }
  }
  if (out.acceptPatch && out.rejectPatch) {
    out.error = `--accept-patch and --reject-patch are one decision. Choose one.`;
  }
  const verbs = [out.openTicket, !!out.choose, !!(out.acceptPatch || out.rejectPatch)].filter(Boolean).length;
  if (verbs > 1) {
    out.error =
      "one act at a time: --open-ticket, --choose, --accept-patch and --reject-patch are each a decision " +
      "with its own record. Run them as separate commands.";
  }
  return out;
}


/**
 * `DELIVERY_MODE`, with the command line winning. The default is `report`.
 * @param {string|null} fromFlag
 * @returns {string}
 */
function resolveMode(fromFlag) {
  if (fromFlag) return fromFlag;
  const env = (process.env.DELIVERY_MODE || "").trim().toLowerCase();
  if (env) return env;
  return "report";
}

// ─── The plan as a report ─────────────────────────────────────────────────────


module.exports = {
  readArgs,
  resolveMode,
};

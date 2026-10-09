/**
 * autopilot/commands.js — the manager's moves are the account owner's own commands.
 *
 * The manager does not have a private way to touch a run: every move is the command a human would
 * type, started as its own process, with SERIES_LOCATION set explicitly rather than inherited
 * for the same reason delivery.js sets it. `describeCommand` is what the log shows BEFORE the
 * command runs, so a watch-mode reader can see exactly what act mode would have done.
 */

const path = require("path");
const { spawn } = require("child_process");

const { unansweredQuestions, sameQuestion } = require("../utils/tickets");
const { trackChild } = require("../utils/shutdown");

const projectRoot = path.join(__dirname, ".."); // the runner's ROOT

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
      cwd: projectRoot,
      env: { ...process.env, SERIES_LOCATION: seriesDir },
    });
    // The loop's every move is a child process. Stopping the loop must stop the move it is
    // waiting on, or the loop ends and the step it started keeps running with nobody in charge
    // (utils/shutdown.js).
    trackChild(child, path.basename(args[0]));
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
      return [path.join(projectRoot, "delivery.js"), "--mode=act"];
    case "diagnose":
      return [path.join(projectRoot, "diagnose.js"), `--ticket=${action.ticket}`];
    case "answer": {
      const args = [path.join(projectRoot, "diagnose.js"), `--ticket=${action.ticket}`];
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
        path.join(projectRoot, "delivery.js"),
        `--choose=${action.option}`,
        `--ticket=${action.ticket}`,
        `--reason=${action.reason}`,
      ];
    case "fix":
      return [path.join(projectRoot, "fix.js"), `--ticket=${action.ticket}`];
    case "judge":
      return [
        path.join(projectRoot, "delivery.js"),
        "--mode=act",
        `${action.outcome === "accept" ? "--accept-patch" : "--reject-patch"}=${action.patch}`,
        `--reason=${action.reason}`,
      ];
    // The loop's only move that acts on a process rather than on a file, so it goes through the same
    // gated CLI the account owner would type — and act mode is not optional: report mode reports.
    case "stop-run":
      return [path.join(projectRoot, "delivery.js"), "--mode=act", "--stop-run"];
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
    .map((a) => (path.isAbsolute(a) && path.dirname(a) === projectRoot ? path.basename(a) : a))
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
  return [path.join(projectRoot, "fix.js"), flag];
}

module.exports = { runCommand, commandFor, describeCommand, followUpsFor };

#!/usr/bin/env node
/**
 * delivery.js — the delivery manager, report mode.
 *
 * What this is today: the manager's **eyes**, not its hands. It answers the question the
 * account owner assigned to this layer on 2026-10-05 — *"I'm coming back to this after a long
 * weekend: which step do I call next?"* — by reading the working state off the disk and
 * writing down the step list, with the reason for every line.
 *
 * It is a *customer* of the pipeline, not an insider (AGENTS.md §3.6, plan §3). Everything it
 * reads is something a customer could read: the plan of record, what each volume folder
 * actually holds, the deterministic step assessments, the run ledger, and the publish report.
 * It never reads `.logs/**`, never reads a `.js`, a prompt file or a hook, and never calls the
 * intake agent. It writes exactly one thing: its own report.
 *
 * `DELIVERY_MODE` (default **report**, decided 2026-10-05):
 *   - `report` — write the plan and stop. Nothing is executed. This is the default until the
 *     manager has written a report that was demonstrably right about a real run.
 *   - `act`    — not implemented yet, and asking for it fails loudly rather than falling back
 *     to report mode. A mode that silently does less than it was asked to is the shape of
 *     every "the run finished green while half the artifacts were missing" story in this repo
 *     (gotcha 21).
 *
 * The action menu it names actions from is closed (`DELIVERY_ACTIONS` in `utils/resume.js`):
 * Tier A it may take alone, Tier B is capped, Tier C does not exist for it. And per the
 * account owner's decision, **choosing where to resume is not an intervention** — removing
 * output that already exists is.
 *
 * Usage:
 *   node delivery.js                    # report for SERIES_LOCATION
 *   node delivery.js --series=<dir>     # report for a fixture series
 *   node delivery.js --json             # also print the plan as JSON
 *   node delivery.js --no-write         # print only, write nothing
 *   node delivery.js --mode=act         # refused, with the plan it would have executed
 *
 * See AGENTS.md §3.6 and the plan notebook.
 */

require("./types"); // JSDoc type definitions
const fs = require("fs");
const path = require("path");
const { readWorkingState, planResume, actionIsAvailable } = require("./utils/resume");
const { postMortemDir } = require("./utils/postmortem");

const PLAN_MD = "delivery-plan.md";
const PLAN_JSON = "delivery-plan.json";

/**
 * Read the CLI flags this runner owns. Unknown flags are refused: a mistyped flag on a tool
 * that reads a live 17-volume series should fail, not be ignored.
 *
 * @param {string[]} argv
 * @returns {{mode: string, seriesDir: string|null, json: boolean, write: boolean, error: string|null}}
 */
function readArgs(argv) {
  const out = { mode: null, seriesDir: null, json: false, write: true, error: null };
  for (const arg of argv) {
    if (arg === "--json") out.json = true;
    else if (arg === "--no-write") out.write = false;
    else if (arg.startsWith("--mode=")) out.mode = arg.slice("--mode=".length).trim().toLowerCase();
    else if (arg.startsWith("--series=")) out.seriesDir = arg.slice("--series=".length).trim();
    else {
      out.error = `unknown flag "${arg}". Known flags: --mode=report|act, --series=<dir>, --json, --no-write`;
      break;
    }
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

/**
 * The plan as it should be printed: short, readable, and honest about what it is not.
 * @param {import("./utils/resume").ResumePlan} plan
 * @param {string} mode
 * @returns {string}
 */
function renderConsole(plan, mode) {
  const lines = [];
  lines.push(`[delivery] ${plan.headline}`);
  lines.push(`[delivery] series: ${plan.seriesDir}`);
  for (const s of plan.steps) {
    if (s.action === "none") continue;
    const label =
      s.action === "after" ? "then" : s.action === "blocked" ? "blocked" : s.action === "ticket" ? "ask" : "now";
    lines.push(`[delivery]   ${label.padEnd(6)} ${s.step}${s.fromVolume ? ` (from volume ${s.fromVolume})` : ""}${s.actionName ? ` — ${s.actionName}` : ""}`);
    for (const w of s.wipeFirst) lines.push(`[delivery]          remove first: ${w.files.length} file(s) in ${w.volumeDir}`);
  }
  const untouched = plan.steps.filter((s) => s.action === "none").map((s) => s.step);
  if (untouched.length) lines.push(`[delivery]   leave alone: ${untouched.join(", ")}`);
  for (const n of plan.notes) lines.push(`[delivery] note: ${n}`);
  if (mode !== "report") lines.push(`[delivery] mode "${mode}" is not implemented — nothing above was executed.`);
  else lines.push(`[delivery] mode report: nothing was executed. This is a proposal.`);
  return lines.join("\n");
}

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

  if (args.write) {
    const dir = postMortemDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, PLAN_MD), plan.markdown, "utf8");
      fs.writeFileSync(path.join(dir, PLAN_JSON), JSON.stringify(plan, null, 2) + "\n", "utf8");
      console.log(`[delivery] plan written: ${path.join(dir, PLAN_MD)}`);
    } catch (err) {
      console.error(`[delivery] the plan could not be written (${err.message})`);
      process.exitCode = 1;
      return;
    }
  }

  if (args.json) console.log(JSON.stringify(plan, null, 2));

  if (mode === "act") {
    console.error(
      "[delivery] act mode is not built yet. The plan above is a proposal and nothing was executed.\n" +
        "           Running it by hand: npm run pipeline --stages=<the steps listed>.\n" +
        "           Authority is earned from a correct report, not granted in advance (DELIVERY_MODE, decided 2026-10-05)."
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[delivery] failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});

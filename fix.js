#!/usr/bin/env node
/**
 * fix.js — call in the dev team, and run the checks it is not allowed to run itself.
 *
 * `npm run delivery` is the manager: it runs the pipeline and re-runs steps without ever reading the
 * code. `npm run diagnose` is the support team: it reads the code and changes nothing. This is the
 * third role, and the only one that writes — so it is the one whose command line has to be the
 * narrowest.
 *
 * The order this command enforces is the design:
 *
 *   ticket → diagnosis → the manager chooses an option → the option says it needs code → this command
 *
 * There is no way to reach a dev turn by describing a fix. `patches.createPatch` is the door, and it
 * refuses a ticket with no diagnosis, no recorded choice, an option that does not need code, a ticket
 * whose every option was refused, and a second team while one is already working. All of that happens
 * **before a model is reached**.
 *
 * What this command guarantees, in code rather than in a prompt:
 *
 *   - The team may write inside this project's source, and the file tools refuse the banned paths
 *     during the turn AND `recordProposal` refuses them afterwards — the constraint tables, their
 *     tests, `hooks/`, `.env`, the machine state and the generated corpus (AGENTS.md gotcha 66/67).
 *   - The team has no shell. `--verify` runs `REQUIRED_CHECKS` here and records what they actually
 *     returned; a proposal cannot be accepted while one is missing or failed, and the runner cannot
 *     be pointed at a softer command than the pinned one.
 *   - The working tree inside `ai-client/` is fingerprinted before the turn and again after it. A file
 *     that changed without being named in the proposal is a refusal, not a note — and a tree that
 *     already holds undeclared changes refuses the dev turn before it starts, because a turn cannot
 *     describe an edit it did not make.
 *   - `--commit` is the acceptance act, it only works on a patch the manager has accepted, and it
 *     stages exactly the files the proposal declared. `git add -A` is never used in this repository:
 *     the tree outside `ai-client/` is the account owner's in-progress translation.
 *   - The run lock is **binding** here, as it is for act mode. A patch may not land while a run is in
 *     progress, because a carry-forward gate comparing a volume against the previous one cannot tell a
 *     code change apart from a data loss (gotcha 66).
 *
 * Usage:
 *   node fix.js --open                                  # tickets whose chosen option needs code, unpatched
 *   node fix.js --status                                # what is sitting unjudged in the working tree
 *   node fix.js --ticket=<id>                           # run one dev turn for that ticket
 *   node fix.js --show=<id>                             # read one patch in full
 *   node fix.js --verify=<id>                           # run npm test + npm run pipeline-loop, record them
 *   node fix.js --commit=<id>                           # commit an ACCEPTED patch to main (dev team only)
 *   node fix.js --revert=<id>                           # put a REJECTED patch's changes back
 *   node fix.js --series=<dir>                          # the series the ticket is about
 *   node fix.js --json                                  # also print the machine-readable record
 *
 * The manager's own half — accepting or rejecting a proposal — is `npm run delivery`, not this
 * command. A role that applies its own proposal is not a customer.
 *
 * Exit codes: 0 done, 1 could not do it (a proposal that does not meet the contract, a check that
 * failed), 2 the request itself was refused (an unknown flag, a run in progress, a patch in a state
 * that does not allow the action).
 *
 * See docs/delivery-layer.md.
 */

require("./types"); // JSDoc type definitions

const path = require("path");

// The delivery layer names the series it is answering about; it does not inherit the
// pipeline's default source folder (AGENTS.md gotcha 79). Loading .env here, before any
// support module is required, also keeps dotenv's per-module banner out of the ticket list.
const { chosenSeriesLocation, loadEnv } = require("./configs/env-defaults");
loadEnv();

const devteam = require("./utils/devteam");
const patches = require("./utils/patches");
const { readTickets, ticketPaths } = require("./utils/tickets");
const { runInProgress, describeRunLock } = require("./utils/runlock");
const { auditDeliveryRun } = require("./utils/delivery-audit");

/**
 * Read the CLI flags this command owns. Unknown flags are refused: a mistyped flag on a command that
 * edits the working tree should fail, not be ignored.
 *
 * @param {string[]} argv
 * @returns {{ticketId: string|null, patchId: string|null, action: string|null, list: boolean, status: boolean,
 *   json: boolean, seriesDir: string|null, error: string|null}}
 */
function readArgs(argv) {
  const out = { ticketId: null, patchId: null, action: null, list: false, status: false, json: false, seriesDir: null, error: null };
  for (const arg of argv) {
    if (arg === "--open" || arg === "--list") out.list = true;
    else if (arg === "--status") out.status = true;
    else if (arg === "--json") out.json = true;
    else if (arg.startsWith("--ticket=")) out.ticketId = arg.slice("--ticket=".length).trim();
    else if (arg.startsWith("--verify=")) {
      out.action = "verify";
      out.patchId = arg.slice("--verify=".length).trim();
    } else if (arg.startsWith("--commit=")) {
      out.action = "commit";
      out.patchId = arg.slice("--commit=".length).trim();
    } else if (arg.startsWith("--revert=")) {
      out.action = "revert";
      out.patchId = arg.slice("--revert=".length).trim();
    } else if (arg.startsWith("--show=")) {
      out.action = "show";
      out.patchId = arg.slice("--show=".length).trim();
    } else if (arg.startsWith("--series=")) out.seriesDir = arg.slice("--series=".length).trim();
    else {
      out.error =
        `unknown flag "${arg}". Known flags: --open, --status, --ticket=<id>, --show=<id>, ` +
        `--verify=<id>, --commit=<id>, --revert=<id>, --series=<dir>, --json`;
      break;
    }
  }
  const chosen = [out.list, out.status, out.action, out.ticketId ? "ticket" : null].filter(Boolean);
  if (chosen.length > 1) {
    out.error = `one action at a time. You asked for: ${chosen.join(", ")}.`;
  }
  return out;
}

/**
 * The tickets whose chosen option needs a code change and that nobody has patched yet.
 *
 * @returns {Object[]}
 */
function waitingForDevTeam() {
  const store = readTickets();
  const patchPaths = patches.patchPaths();
  const out = [];
  for (const ticket of store.tickets) {
    if (ticket.status === "closed" || !ticket.diagnosis || !ticket.choice) continue;
    const option = (ticket.options || []).find((o) => o.id === ticket.choice.optionId);
    if (!option || !option.requiresCodeChange) continue;
    if (patches.patchForTicket(ticket.id, patchPaths)) continue;
    out.push({ ticket, option });
  }
  return out;
}

/**
 * @returns {number} exit code
 */
function listWaiting() {
  const store = readTickets();
  const waiting = waitingForDevTeam();
  console.log(`Tickets in ${ticketPaths().json}`);
  if (store.error) console.log(`  ⚠ ${store.error}`);
  if (!waiting.length) {
    console.log(
      "Nothing is waiting for a code change. A dev team is called by the manager choosing an option " +
        "that says it needs one — `npm run delivery` shows the choices, and `node diagnose.js --open` " +
        "shows the tickets still needing an answer."
    );
    return 0;
  }
  console.log(`${waiting.length} waiting for the dev team:\n`);
  for (const { ticket, option } of waiting) {
    console.log(`  ${ticket.id}  ${ticket.step}${ticket.volume ? ` volume ${ticket.volume}` : ""}  ${ticket.finding}`);
    console.log(`     option ${option.id}: ${option.label}`);
    console.log(`     chosen because: ${ticket.choice.reason}`);
    console.log(`     check the manager expects: ${option.verify || "(not stated)"}`);
  }
  console.log(`\nRun: node fix.js --ticket=<id>`);
  return 0;
}

/**
 * What is sitting unjudged in the working tree, and what has already been decided.
 * @returns {number} exit code
 */
function showStatus() {
  const patchPaths = patches.patchPaths();
  const { patches: all, error } = patches.readPatches(patchPaths.json);
  console.log(`Patches in ${patchPaths.json}`);
  if (error) console.log(`  ⚠ ${error}`);
  const pending = patches.pendingPatches(patchPaths);
  if (pending.length) {
    console.log(`\n  ${pending.length} unjudged change(s) in the working tree of main:`);
    for (const p of pending) console.log(`    ${devteam.describePatch(p)}`);
    console.log("    The pipeline runs whatever is in this tree, so act mode refuses to run a step while one is waiting.");
  }
  const rest = all.filter((p) => !pending.includes(p));
  if (rest.length) {
    console.log(`\n  Decided:`);
    for (const p of rest) console.log(`    ${devteam.describePatch(p)}`);
  }
  if (!all.length) console.log("  No patches. Nothing has been proposed, so nothing is waiting in the working tree.");
  console.log(`\nFull detail: ${patchPaths.markdown}`);
  return 0;
}

/**
 * @param {string} patchId
 * @returns {number} exit code
 */
function showPatch(patchId) {
  const patchPaths = patches.patchPaths();
  const { patches: all, error } = patches.readPatches(patchPaths.json);
  if (error) {
    console.error(`⚠ ${error}`);
    return 2;
  }
  const patch = patches.findPatch(patchId, all);
  if (!patch) {
    console.error(`no patch ${patchId} in ${patchPaths.json}. \`node fix.js --status\` lists what exists.`);
    return 2;
  }
  console.log(devteam.describePatch(patch));
  console.log(`  files: ${patch.files ? patch.files.join(", ") : "(none declared)"}`);
  if (patch.summary) console.log(`  summary: ${patch.summary}`);
  if (patch.why) console.log(`  why: ${patch.why}`);
  if (patch.couldBreak) console.log(`  could break: ${patch.couldBreak}`);
  for (const e of patch.expected || []) console.log(`  expects: ${e.signal} ${e.direction} — ${e.why}`);
  if (patch.verify) console.log(`  verify: ${patch.verify}`);
  if (patch.checkVerdict) {
    console.log(`  checks: ${patch.checkVerdict.accepted ? "green" : "not green"}`);
    for (const c of patch.checks || []) console.log(`    ${c.id}: ${c.passed ? "passed" : `exit ${c.exitCode === null ? "never ran" : c.exitCode}`}`);
    if (patch.checkVerdict.missing.length) console.log(`    never ran: ${patch.checkVerdict.missing.join(", ")}`);
  }
  if ((patch.questions || []).length) {
    console.log(`  questions back to the manager:`);
    for (const q of patch.questions) console.log(`    - ${q}`);
  }
  if (patch.ownerNote) console.log(`  for the account owner: ${patch.ownerNote}`);
  console.log(`\nThe manager decides this one: npm run delivery --mode=act --accept-patch=${patch.id} --reason="…"`);
  return 0;
}

/**
 * Run the pinned checks against a patch. The machine runs them; the team does not get to say it ran
 * them, and the harness gives an agent no shell with which to claim otherwise.
 *
 * @param {string} patchId
 * @param {Object} opts
 * @returns {number} exit code
 */
function verify(patchId, { json }) {
  const patchPaths = patches.patchPaths();
  const existing = patches.findPatch(patchId, patches.readPatches(patchPaths.json).patches);
  if (!existing) {
    console.error(`no patch ${patchId}. \`node fix.js --status\` lists what exists.`);
    return 2;
  }
  console.log(`Running the pinned checks for ${patchId}. This is the whole test chain, so it takes minutes.`);
  for (const c of patches.REQUIRED_CHECKS) console.log(`  ${c.id}: ${c.command} ${c.args.join(" ")}`);

  // The checks run against the working tree, so a tree holding edits this patch never named means the
  // verdict describes code nobody has proposed. Reported, not refused: `--verify` changes nothing, and
  // the manager needs the number even when the tree is untidy — but it has to be read knowing this.
  const tree = patches.workingTreeChanges(devteam.ROOT);
  if (!tree.error) {
    const declared = new Set(existing.files || []);
    const extra = tree.files.filter((f) => !declared.has(f.path));
    if (extra.length) {
      console.log(
        `  ⚠ the working tree also holds ${extra.length} change(s) this patch does not name, so these ` +
          `checks are grading more than ${patchId}: ${extra.slice(0, 12).map((f) => f.path).join(", ")}`
      );
    }
  }
  const result = devteam.verifyPatch(patchId, { patchPaths });
  if (result.error) {
    console.error(`⚠ ${result.error}`);
    return 2;
  }
  for (const c of result.patch.checks) {
    console.log(`  ${c.id} → ${c.passed ? "passed" : `FAILED (exit ${c.exitCode === null ? "never ran" : c.exitCode})`}`);
    if (!c.passed && c.tail) {
      const tail = String(c.tail).trim().split("\n").slice(-8).join("\n");
      console.log(tail.split("\n").map((l) => `      ${l}`).join("\n"));
    }
  }
  const v = result.verdict;
  if (v.accepted) console.log(`\nAll checks green. ${patchId} is now verifiable — the manager may accept it.`);
  else {
    if (v.missing.length) console.log(`\n  never ran: ${v.missing.join(", ")}`);
    if (v.failed.length) console.log(`  failed: ${v.failed.join(", ")}`);
    console.log(`${patchId} stays ${result.patch.status}. A proposal is not accepted while a check is missing or failed.`);
  }
  if (json) console.log(JSON.stringify(result.patch, null, 2));
  return v.accepted ? 0 : 1;
}

/**
 * Commit an accepted patch. The commit IS the acceptance act, and only this role makes it.
 * @returns {number} exit code
 */
function commit(patchId, { json }) {
  const patchPaths = patches.patchPaths();
  const result = patches.commitPatch(patchId, { paths: patchPaths });
  if (result.error) {
    console.error(`⚠ ${result.error}`);
    if (result.extra && result.extra.length) {
      console.error(`  Unnamed changes are still in the tree. Put them back, or declare them in the proposal:`);
      for (const f of result.extra) console.error(`    ${f}`);
    }
    return 2;
  }
  console.log(`Committed ${patchId}.`);
  console.log(`  ${result.commit.hash.slice(0, 12)}  ${result.commit.message.split("\n")[0]}`);
  console.log(`  files: ${result.commit.files.join(", ")}`);
  console.log(`\nThe patch is now the code the pipeline runs. For it to take effect on already-built ` +
    `volumes, the manager has to wipe and cascade the step it fixes — the skip checks do not know the ` +
    `code changed (gotcha 66).`);
  if (json) console.log(JSON.stringify(result, null, 2));
  return 0;
}

/**
 * Put a rejected patch's changes back.
 * @returns {number} exit code
 */
function revert(patchId, { json }) {
  const patchPaths = patches.patchPaths();
  const result = patches.revertPatch(patchId, { paths: patchPaths });
  if (result.error) {
    console.error(`⚠ ${result.error}`);
    return 2;
  }
  console.log(`Reverted ${patchId}.`);
  console.log(`  restored: ${result.restored.length ? result.restored.join(", ") : "(nothing tracked was changed)"}`);
  if (result.leftBehind.length) {
    console.log(`  still in the tree, created by this patch, for the account owner to remove:`);
    for (const f of result.leftBehind) console.log(`    ${f}`);
    console.log("  This command does not delete files. Removing a file is not a move either role may make.");
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  return 0;
}

/**
 * Run one dev-team turn.
 * @returns {number} exit code
 */
async function runDevTurn(ticketId, { seriesDir, json }) {
  const patchPaths = patches.patchPaths();
  // The `pre-manager` / `post-manager` hooks fire INSIDE `workTicket`, around the agent turn, not
  // here: this CLI cannot know whether the turn is reachable without repeating every refusal the
  // module makes (unknown ticket, a tree somebody else already edited, a ticket with no chosen
  // option), and a container switch costs a model load (gotcha 22).
  const result = await devteam.workTicket({ ticketId, seriesDir, patchPaths });
  if (result.patch) console.log(devteam.describePatch(result.patch));
  if (result.turnShape) {
    const s = result.turnShape;
    console.log(
      `  turn shape: ${s.toolCalls} tool call(s) over ${s.chunks} chunk(s), uncapped` +
        (s.offloads
          ? `, ${s.offloads} read answer(s) set aside on disk (${s.offloadedTokens} tokens)`
          : "") +
        `, ended: ${s.endedAs || "not recorded"}`
    );
  }
  if (result.actualChanges.length) {
    console.log(`  changed in the working tree: ${result.actualChanges.join(", ")}`);
  } else {
    console.log(`  the working tree inside ${devteam.ROOT} is unchanged.`);
  }
  if (result.writeAttempts.length) {
    console.log(`  writes the boundary refused (${result.writeAttempts.length}):`);
    for (const a of result.writeAttempts) console.log(`    ${a.tool} ${a.path} — stopped by ${a.layer}`);
  }
  for (const p of result.problems) console.log(`  refused: ${p.message}`);
  for (const w of result.warnings) console.log(`  warned: ${w.message}`);
  if (result.error) {
    console.error(`\n⚠ ${result.error}`);
    if (result.patch) {
      console.log(
        `  ${result.patch.id} is still unjudged, so act mode will refuse to run a step. ` +
          `Put the tree back with: node fix.js --revert=${result.patch.id}`
      );
    }
    if (json) console.log(JSON.stringify(result, null, 2));
    return result.problems.length ? 1 : 2;
  }
  const patch = result.patch;
  console.log(`\n${patch.id} is a proposal, not a change the pipeline will run yet.`);
  console.log(`  The manager decides it: npm run delivery --mode=act --accept-patch=${patch.id} --reason="…"`);
  console.log(`  Before that, the checks have to be green: node fix.js --verify=${patch.id}`);
  if ((patch.questions || []).length) {
    console.log(`  The team is asking the manager ${patch.questions.length} question(s) — see ${patchPaths.markdown}.`);
  }
  if (json) console.log(JSON.stringify(patch, null, 2));
  return 0;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`✗ ${args.error}`);
    process.exitCode = 2;
    return;
  }

  const patchPaths = patches.patchPaths();

  // Reading the channel is safe while a run is going on. Touching the working tree is not: a patch
  // that lands mid-run means a carry-forward gate comparing a volume against the previous one cannot
  // tell a code change from a data loss (gotcha 66), and it would quarantine good work while looking
  // like it was enforcing rigor. Binding here, exactly as it is for act mode.
  const mutates = Boolean(args.ticketId || (args.action && args.action !== "show"));
  // `runInProgress()` answers with a record, not a boolean: `inProgress` is the answer and `note` is the
  // sentence. Reading the object as a truthiness test would refuse every mutating flag even when nothing
  // is running — which looks like rigor and is just a command that never works.
  const running = runInProgress();
  if (mutates && running.inProgress) {
    console.error(
      `✗ refused: ${running.note || describeRunLock(running.lock) || running.error || "a run is in progress"}`
    );
    console.error(
      `  A patch may not land while a run is in progress. Finish or stop the run first. If the lock is ` +
        `left over from a run that is genuinely gone, delete the lock file it names.`
    );
    process.exitCode = 2;
    return;
  }
  // "Does the tree already hold edits nobody declared?" is asked inside `workTicket`, against the folder
  // the turn is actually about to edit, rather than here against whatever folder the process happens to
  // sit in. Same rule, better place: the refusal has to name the tree the patch would land in.

  if (args.list) return void (process.exitCode = listWaiting());
  if (args.status) return void (process.exitCode = showStatus());

  if (args.action === "show") return void (process.exitCode = showPatch(args.patchId));
  if (args.action === "verify") return void (process.exitCode = verify(args.patchId, args));
  if (args.action === "commit") return void (process.exitCode = commit(args.patchId, args));
  if (args.action === "revert") return void (process.exitCode = revert(args.patchId, args));

  if (!args.ticketId) {
    console.error(`✗ nothing to do. Known flags: --open, --status, --ticket=<id>, --show=<id>, --verify=<id>, ` +
      `--commit=<id>, --revert=<id>, --series=<dir>, --json`);
    process.exitCode = 2;
    return;
  }

  const seriesDir = args.seriesDir || chosenSeriesLocation() || "";
  if (!seriesDir) {
    console.error(`✗ refused: no series folder. Pass --series=<dir> or set SERIES_LOCATION. The team needs to` +
      ` know which folder the ticket is about, and guessing is how a patch is written against the wrong book` +
      ` — including a folder inherited from the pipeline's default, which says nothing about THIS run.`);
    process.exitCode = 2;
    return;
  }
  if (!require("fs").existsSync(seriesDir)) {
    console.error(`✗ refused: ${seriesDir} does not exist.`);
    process.exitCode = 2;
    return;
  }

  try {
    process.exitCode = await runDevTurn(args.ticketId, { seriesDir, json: args.json });
  } catch (err) {
    console.error(`✗ the dev turn failed: ${err && err.message ? err.message : err}`);
    console.error(`  The turn's tool calls and any files it wrote are in the run's log folder and in the working tree.`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(`✗ fix failed: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  })
  // The layer's own after-run check. For this command it is the sharpest of the four: a patch record
  // is the only evidence of code that changed on the pipeline's authority, so "the dev turn exited 0"
  // is checked against a proposal that exists, declares files, and — for --commit — actually reached
  // `committed`.
  .then(() =>
    auditDeliveryRun({
      step: "fix",
      argv: process.argv.slice(2),
      exitCode: Number(process.exitCode || 0),
      seriesDir: process.env.SERIES_LOCATION || undefined,
    })
  );

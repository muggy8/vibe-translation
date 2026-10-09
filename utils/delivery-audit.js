/**
 * utils/delivery-audit.js — the after-run check for the delivery layer itself.
 *
 * Everything in this repository is supervised except the thing that supervises it. A pipeline step
 * finishes and `utils/postmortem.js` asks what it left behind; the finding reaches the ledger, the
 * ledger reaches the triage, and the next run knows whether re-running is worth paying for. The
 * delivery layer has never had that question asked of it: `npm run delivery`, `npm run diagnose`,
 * `npm run fix` and `npm run autopilot` write the records that *everything else in this layer is
 * built on* — the plan of record, the ticket channel, the patch channel, the ledger, the run lock —
 * and if one of them wrote half of one, nothing noticed.
 *
 * That matters more than it looks, because these records are not reports. They are the inputs:
 *   - the plan of record is what the next run reads to know what was already tried;
 *   - a ticket is the only door to the diagnostics team and to a code change;
 *   - a patch record is the only evidence of code that changed on the pipeline's authority;
 *   - the ledger is the anti-spin gate — a ledger that cannot be read is a gate that lets everything;
 *   - a run lock left behind by a process that has exited makes every later act-mode command refuse
 *     to start, which looks like rigor and is a run that cannot be started.
 * A corrupt one of those is not a missing report. It is the layer quietly losing the ability to
 * remember, decide, or start.
 *
 * Three questions, in increasing ambition:
 *   1. **Are the records there, and are they shaped right?** Declared in utils/artifacts/delivery.js
 *      and assessed by utils/postmortem/scope.js — the same code that assesses a glossary.
 *   2. **Do the records agree with each other?** A patch naming a ticket that does not exist; a
 *      ticket marked answered with no diagnosis behind it; a closed ticket with no measured outcome;
 *      a plan that names a step nothing declares. These are the questions a file-presence check
 *      cannot ask, and they are the reason this module exists.
 *   3. **Did the command do what its exit code says it did?** An exit 0 is a claim. `diagnose`
 *      exiting 0 claims the ticket now holds a diagnosis; `fix --commit` claims the patch is
 *      committed. The claim is checked against the record, and a claim the disk does not back is
 *      HIGH. This is the delivery layer's version of "never let a stage persist empty output".
 *
 * What it deliberately does NOT do: change the command's exit code, or refuse the command. The audit
 * runs *after* the work, and by then the work is done — turning a completed run into a failed one
 * would teach the operator to run the command with the audit disabled. It reports, it writes the
 * report where the other post-mortems live, and it appends to the ledger, which is how a delivery
 * finding reaches the next run's triage instead of ending as a line on a console.
 *
 * It is a leaf module on purpose: utils/tickets, utils/patches, utils/ledger and utils/runlock each
 * resolve their own folder through utils/postmortem, so nothing inside that layer may reach back for
 * them. Nothing requires this file except the four commands it audits.
 *
 * @module utils/delivery-audit
 */

require("../types"); // JSDoc type definitions

const fs = require("fs");
const path = require("path");

const {
  runPostMortem,
  writePostMortemReport,
  renderPostMortemMarkdown,
  postMortemDir,
  finding,
} = require("./postmortem");
const { readTickets, ticketPaths } = require("./tickets");
const { readPatches, patchPaths, unresolvedPatches, findPatch, PATCH_STATUSES } = require("./patches");
const { readLedger, ledgerPath, appendLedgerEntry } = require("./ledger");
const { runInProgress, describeRunLock, runLockPath } = require("./runlock");
const { specForStep } = require("./artifacts");

// This file lives in <root>/utils/, so the repo root is one level up. Getting this wrong is
// gotcha 80 exactly: displayPath() would print `../.postmortem/tickets.json` and nothing would fail.
const projectRoot = path.resolve(__dirname, "..");

/** @typedef {import("./postmortem").PostMortemFinding} PostMortemFinding */
/** @typedef {import("./postmortem").PostMortemReport} PostMortemReport */

/**
 * The statuses a ticket can hold. Mirrors what utils/tickets.js writes: `open` when the question is
 * asked, `answered` when the diagnostics team has replied, `closed` when the deliverable has been
 * measured before and after. A stored ticket outside this vocabulary was not written by the doors
 * that write tickets, which is exactly what this check is for.
 * @type {string[]}
 */
const TICKET_STATUSES = ["open", "answered", "closed"];

// ─── What the command claims ──────────────────────────────────────────────────

/**
 * Read one `--flag=value` out of the command line.
 * @param {string[]} argv
 * @param {string} name
 * @returns {string|null}
 */
function flagValue(argv, name) {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1).trim();
}

/**
 * Whether a flag is present.
 * @param {string[]} argv
 * @param {string} name
 * @returns {boolean}
 */
function hasFlag(argv, name) {
  return argv.includes(name);
}

/**
 * What this command claims it wrote, read off its own command line and its own exit code.
 *
 * The exit code is the claim: `diagnose` exiting 0 is `diagnose` saying "the ticket is answered".
 * Deriving the claims from the invocation rather than threading them through the call stack is what
 * keeps this a check instead of a restatement — a value the command passes down is the command
 * grading its own homework, and the failure mode this exists for is the command being wrong about
 * what it did.
 *
 * @param {Object} opts
 * @param {string} opts.step - One of DELIVERY_COMMANDS.
 * @param {string[]} opts.argv - The arguments the command was given.
 * @param {number} opts.exitCode - What it returned.
 * @returns {{claims: import("./artifacts").ArtifactContext, checks: Array<{kind: string, run: Function, says: string}>}}
 *   `claims` feeds the declared file expectations; `checks` are the record-level claims.
 */
function claimsFromInvocation({ step, argv, exitCode }) {
  const succeeded = exitCode === 0;
  const claims = {
    researchEnabled: true,
    verifyEnabled: true,
    volumeConsistencyEnabled: true,
    polishVerifyEnabled: true,
    installment: "",
    planRecordClaimed: false,
    ticketRecordClaimed: false,
    patchRecordClaimed: false,
    acting: false,
  };
  /** @type {Array<{kind: string, run: Function, says: string}>} */
  const checks = [];

  if (step === "delivery") {
    const mode = flagValue(argv, "--mode") || process.env.DELIVERY_MODE || "report";
    claims.acting = mode.trim().toLowerCase() === "act";

    const choose = flagValue(argv, "--choose");
    const accept = flagValue(argv, "--accept-patch");
    const reject = flagValue(argv, "--reject-patch");
    const ticketId = flagValue(argv, "--ticket");
    const verb = choose || accept || reject || hasFlag(argv, "--open-ticket");

    // The normal path only: a verb answers one thing and legitimately writes no plan.
    claims.planRecordClaimed = succeeded && !verb && !hasFlag(argv, "--no-write");

    if (succeeded && hasFlag(argv, "--open-ticket")) {
      checks.push({
        kind: "ticket-opened",
        says: `it opened a ticket`,
        run: ({ tickets }) =>
          tickets.some((t) => t.status !== "closed")
            ? null
            : { problem: "the ticket file holds no open ticket" },
      });
    }
    if (succeeded && choose) {
      checks.push({
        kind: "choice-recorded",
        says: `it recorded the choice of ${choose} on ${ticketId || "a ticket"}`,
        run: ({ tickets }) => {
          const t = tickets.find((x) => x.id === ticketId);
          if (!t) return { problem: `ticket ${ticketId} is not in the ticket file` };
          if (!t.choice) return { problem: `ticket ${t.id} holds no recorded choice` };
          if (t.choice.optionId && t.choice.optionId !== choose) {
            return { problem: `ticket ${t.id} records a choice of ${t.choice.optionId}, not ${choose}` };
          }
          return null;
        },
      });
    }
    for (const [flag, want] of [[accept, "accepted"], [reject, "rejected"]]) {
      if (!succeeded || !flag) continue;
      checks.push({
        kind: "patch-judged",
        says: `it marked ${flag} ${want}`,
        run: ({ patches }) => {
          const p = findPatch(flag, patches);
          if (!p) return { problem: `patch ${flag} is not in the patch file` };
          if (p.status !== want) return { problem: `patch ${flag} is ${p.status}, not ${want}` };
          return null;
        },
      });
    }
  }

  if (step === "diagnose") {
    const ticketId = flagValue(argv, "--ticket");
    const answering = flagValue(argv, "--answer") !== null;
    if (succeeded && ticketId && !answering && !hasFlag(argv, "--open") && !hasFlag(argv, "--list")) {
      claims.ticketRecordClaimed = true;
      checks.push({
        kind: "diagnosis-recorded",
        says: `it answered ${ticketId}`,
        run: ({ tickets }) => {
          const t = tickets.find((x) => x.id === ticketId);
          if (!t) return { problem: `ticket ${ticketId} is not in the ticket file` };
          if (!t.diagnosis) return { problem: `ticket ${t.id} holds no diagnosis` };
          if (!String(t.diagnosis.cause || "").trim()) {
            return { problem: `ticket ${t.id}'s diagnosis states no cause` };
          }
          return null;
        },
      });
    }
    if (succeeded && ticketId && answering) {
      claims.ticketRecordClaimed = true;
      checks.push({
        kind: "answer-recorded",
        says: `it recorded the manager's answer on ${ticketId}`,
        run: ({ tickets }) => {
          const t = tickets.find((x) => x.id === ticketId);
          if (!t) return { problem: `ticket ${ticketId} is not in the ticket file` };
          if (!Array.isArray(t.answers) || !t.answers.length) {
            return { problem: `ticket ${t.id} holds no recorded answer` };
          }
          return null;
        },
      });
    }
  }

  if (step === "fix") {
    const ticketId = flagValue(argv, "--ticket");
    const commit = flagValue(argv, "--commit");
    const revert = flagValue(argv, "--revert");
    const verify = flagValue(argv, "--verify");

    if (succeeded && (ticketId || commit || revert || verify)) claims.patchRecordClaimed = true;

    if (succeeded && ticketId) {
      checks.push({
        kind: "patch-opened",
        says: `it produced a proposal for ${ticketId}`,
        run: ({ patches }) => {
          const p = patches.find((x) => x.ticketId === ticketId);
          if (!p) return { problem: `no patch in the patch file names ticket ${ticketId}` };
          if (!Array.isArray(p.files) || !p.files.length) {
            return { problem: `patch ${p.id} declares no files, so nothing in the tree is attributed to it` };
          }
          return null;
        },
      });
    }
    if (succeeded && commit) {
      checks.push({
        kind: "patch-committed",
        says: `it committed ${commit}`,
        run: ({ patches }) => {
          const p = findPatch(commit, patches);
          if (!p) return { problem: `patch ${commit} is not in the patch file` };
          if (p.status !== "committed") return { problem: `patch ${commit} is ${p.status}, not committed` };
          return null;
        },
      });
    }
    if (succeeded && revert) {
      checks.push({
        kind: "patch-reverted",
        says: `it put ${revert}'s changes back`,
        run: ({ patches }) => {
          const p = findPatch(revert, patches);
          if (!p) return { problem: `patch ${revert} is not in the patch file` };
          if (!p.reverted) return { problem: `patch ${p.id} records no revert` };
          return null;
        },
      });
    }
  }

  if (step === "autopilot") {
    // The loop claims no file of its own — every move is a child command that files its own record —
    // but it claims a MODE, and the mode is what makes the plan of record's act section meaningful.
    const mode = flagValue(argv, "--mode") || process.env.AUTOPILOT_MODE || "watch";
    claims.acting = mode.trim().toLowerCase() === "act";
  }

  return { claims, checks };
}

// ─── The cross-record questions ───────────────────────────────────────────────

/**
 * A path the report can show a human: relative to the repository when it is inside it.
 * @param {string} filePath
 * @returns {string}
 */
function displayPath(filePath) {
  const rel = path.relative(projectRoot, filePath);
  return rel && !rel.startsWith("..") ? rel : filePath;
}

/**
 * Read the three channels once. A reader that reports an error is not reporting "nothing there":
 * every one of these readers distinguishes the two, and the distinction is the whole honesty rule
 * of this layer (gotcha 33).
 *
 * @returns {{tickets: Object[], patches: Object[], ledger: Object[], errors: PostMortemFinding[]}}
 */
function readChannels(step) {
  const errors = [];
  const ticketsFile = readTickets(ticketPaths().json);
  const patchesFile = readPatches(patchPaths().json);
  const ledger = readLedger(ledgerPath());

  for (const [name, res] of [["tickets", ticketsFile], ["patches", patchesFile], ["ledger", ledger]]) {
    if (!res.error) continue;
    const file = name === "tickets" ? ticketPaths().json : name === "patches" ? patchPaths().json : ledgerPath();
    errors.push(
      finding(
        "HIGH",
        "record-unreadable",
        step,
        null,
        displayPath(file),
        `${res.error}. This file is not a report — it is the input the next run reads. A delivery ` +
          `record that cannot be read is the layer losing the ability to remember what it already tried.`
      )
    );
  }
  return {
    tickets: ticketsFile.tickets || [],
    patches: patchesFile.patches || [],
    ledger: ledger.entries || [],
    errors,
  };
}

/**
 * The questions one ticket record has to answer about itself.
 *
 * Each one is a state the rest of the layer acts on: the manager builds its menu from `options`, so
 * an "answered" ticket with nothing in the menu is a decision with nothing to decide between; a
 * closed ticket is the ledger's evidence that an intervention helped, so a closure with no outcome
 * measured is an intervention recorded as a success for no reason.
 *
 * @param {Object[]} tickets
 * @param {string} step
 * @returns {PostMortemFinding[]}
 */
function ticketFindings(tickets, step) {
  const out = [];
  const seen = new Map();
  for (const t of tickets) {
    seen.set(t.id, (seen.get(t.id) || 0) + 1);

    if (!TICKET_STATUSES.includes(t.status)) {
      out.push(
        finding("HIGH", "record-shape", step, null, displayPath(ticketPaths().json),
          `ticket ${t.id} has status "${t.status === undefined ? "(none)" : t.status}", which is not a ` +
          `status this layer writes. It was not written through the doors that write tickets.`)
      );
      continue;
    }
    if (t.status === "closed" && !t.closure) {
      out.push(
        finding("HIGH", "closed-without-outcome", step, null, displayPath(ticketPaths().json),
          `ticket ${t.id} is closed with no measured outcome. A ticket closes as improved / unchanged / ` +
          `worse, judged on the deliverable — a closure without one says an intervention helped for a ` +
          `reason nobody recorded, and the ledger will count it as a tried-and-failed move.`)
      );
    }
    if (t.status === "answered") {
      if (!t.diagnosis) {
        out.push(
          finding("MEDIUM", "answer-without-diagnosis", step, null, displayPath(ticketPaths().json),
            `ticket ${t.id} is marked answered but holds no diagnosis. The options are a menu with no ` +
            `explanation behind them: the manager picks the cheapest item on a menu it cannot read.`)
        );
      }
      const options = Array.isArray(t.options) ? t.options.length : 0;
      if (!options && t.noUsableOptions !== true) {
        out.push(
          finding("MEDIUM", "menu-without-options", step, null, displayPath(ticketPaths().json),
            `ticket ${t.id} is answered and offers no options, and does not say so. When every option ` +
            `was refused the ticket records that plainly (noUsableOptions); silence here means the ` +
            `next run reads "answered" and waits for a move that does not exist.`)
        );
      }
    }
    if (!Array.isArray(t.evidence) || !t.evidence.length) {
      out.push(
        finding("MEDIUM", "record-shape", step, null, displayPath(ticketPaths().json),
          `ticket ${t.id} cites no evidence. A ticket with no cited artifact is a feeling, and the ` +
          `diagnostics team has to re-derive it from the beginning.`)
      );
    }
  }
  for (const [id, n] of seen) {
    if (n > 1) {
      out.push(
        finding("MEDIUM", "duplicate-record-id", step, null, displayPath(ticketPaths().json),
          `${id} appears ${n} times in the ticket file. Every lookup by id takes the first one, so half ` +
          `of this record is unreachable.`)
      );
    }
  }
  return out;
}

/**
 * The questions one patch record has to answer about itself, and about the ticket it answers.
 *
 * @param {Object[]} patches
 * @param {Object[]} tickets
 * @param {string} step
 * @returns {PostMortemFinding[]}
 */
function patchFindings(patches, tickets, step) {
  const out = [];
  const ids = new Set(tickets.map((t) => t.id));
  for (const p of patches) {
    if (!PATCH_STATUSES.includes(p.status)) {
      out.push(
        finding("HIGH", "record-shape", step, null, displayPath(patchPaths().json),
          `patch ${p.id} has status "${p.status === undefined ? "(none)" : p.status}", which is not a ` +
          `status this layer writes. The gates that decide what a patch may do select on status.`)
      );
      continue;
    }
    if (!ids.has(p.ticketId)) {
      out.push(
        finding("MEDIUM", "record-orphan", step, null, displayPath(patchPaths().json),
          `patch ${p.id} answers ticket ${p.ticketId}, which is not in the ticket file. A code change ` +
          `whose justification has gone is a change nobody can re-derive: the question it answered, the ` +
          `option it came from and the reason for that option are all on that ticket.`)
      );
    }
    if (!Array.isArray(p.files) || !p.files.length) {
      out.push(
        finding("MEDIUM", "record-shape", step, null, displayPath(patchPaths().json),
          `patch ${p.id} declares no files. The declared list is what --commit stages and what the ` +
          `undeclared-change check compares the working tree against, so an empty one attributes this ` +
          `change to nothing.`)
      );
    }
  }
  const seen = new Map();
  for (const p of patches) seen.set(p.id, (seen.get(p.id) || 0) + 1);
  for (const [id, n] of seen) {
    if (n > 1) {
      out.push(
        finding("MEDIUM", "duplicate-record-id", step, null, displayPath(patchPaths().json),
          `${id} appears ${n} times in the patch file. The gates look a patch up by id and take the first.`)
      );
    }
  }
  return out;
}

/**
 * Code in the working tree that nobody has judged.
 *
 * Reported for every delivery command, not only for `fix`: an unjudged patch blocks act mode
 * (`unresolvedPatches` is what the plan refuses against), so a run that keeps reporting "refused"
 * without this line next to it looks like a gate being picky.
 *
 * @param {string} step
 * @returns {PostMortemFinding[]}
 */
function unjudgedPatchFindings(step) {
  let unresolved = [];
  try {
    unresolved = unresolvedPatches();
  } catch {
    return [];
  }
  if (!unresolved.length) return [];
  return [
    finding(
      "MEDIUM",
      "patch-unjudged",
      step,
      null,
      displayPath(patchPaths().json),
      `${unresolved.length} patch(es) hold code in this working tree that nobody has judged: ` +
        `${unresolved.map((p) => `${p.id} (${p.status})`).join(", ")}. Act mode refuses the whole plan ` +
        `while that is true, so a run that keeps stopping here is blocked on a decision, not on a defect.`
    ),
  ];
}

/**
 * The plan of record, read as a record rather than as a report.
 *
 * The next run reads this file to find out what was already tried. A plan that names a step nothing
 * declares, or that claims an act pass it did not describe, is the run forgetting — which is the
 * failure the ledger exists to prevent, arriving from the other direction.
 *
 * @param {Object} opts
 * @param {string} opts.step
 * @param {boolean} opts.acting
 * @returns {PostMortemFinding[]}
 */
function planRecordFindings({ step, acting }) {
  const file = path.join(postMortemDir(), "delivery-plan.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return []; // absence is the declared expectation's job, not this one
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch {
    return []; // `bad-json` is already raised by the declared expectation
  }

  const out = [];
  const mode = String(plan.mode || "");
  if (mode !== "report" && mode !== "act") {
    out.push(
      finding("MEDIUM", "record-shape", step, null, displayPath(file),
        `the plan of record says mode "${mode}". The triage and every later reader branch on this being ` +
        `report or act.`)
    );
  }
  if (mode === "act" && !Array.isArray(plan.execution)) {
    out.push(
      finding("MEDIUM", "record-incomplete", step, null, displayPath(file),
      `the plan of record claims an act pass but carries no execution list. What was wiped, where each ` +
      `step exited, and what the deliverable account said are the half the next run reads to tell a ` +
      `repair from a repeat.`)
    );
  }
  for (const s of Array.isArray(plan.steps) ? plan.steps : []) {
    if (!s || !s.step) continue;
    if (!specForStep(s.step)) {
      out.push(
        finding("MEDIUM", "record-orphan", step, null, displayPath(file),
          `the plan of record names step "${s.step}", which nothing declares an output for. A step the ` +
          `plan can name but the artifact table does not know is a step no after-run check will look at.`)
      );
    }
  }
  if (acting && mode === "act" && Array.isArray(plan.execution) && plan.execution.length === 0) {
    out.push(
      finding("LOW", "nothing-executed", step, null, displayPath(file),
        `act mode ran and executed nothing. That is a legitimate answer — the plan's answer was a ` +
        `question, a block, or "nothing to do" — but it is worth knowing it was that kind of run.`)
    );
  }
  return out;
}

/**
 * The run lock, asked as a fact rather than as a gate.
 *
 * While a run is going on the lock is the gate, and this module has nothing to say about it. Asked
 * afterwards it is evidence: a lock whose process is gone is a run that died mid-way, and every later
 * act-mode command will refuse to start against it. That is the delivery layer failing and nothing
 * noticing, in its most literal shape.
 *
 * @param {string} step
 * @returns {PostMortemFinding[]}
 */
function runLockFindings(step) {
  let state;
  try {
    state = runInProgress();
  } catch (err) {
    return [
      finding("HIGH", "record-unreadable", step, null, displayPath(runLockPath()),
        `the run lock could not be assessed (${err.message}).`),
    ];
  }
  if (state.ours || !state.inProgress && !state.stale && !state.error) return [];

  if (state.error) {
    return [
      finding("HIGH", "record-unreadable", step, null, displayPath(runLockPath()),
        `${state.error}. The lock is what stops two processes writing the same volume folder, and a ` +
        `lock that cannot be read is treated as a run in progress — so this blocks act mode until it is fixed.`),
    ];
  }
  if (state.stale) {
    return [
      finding("HIGH", "run-lock-stale", step, null, displayPath(runLockPath()),
        `a run lock is left behind by ${describeRunLock(state.lock)}. That process is gone, so this is a ` +
        `run that ended without releasing it. Act mode replaces a stale lock automatically; the finding ` +
        `is that a run ended in a way nothing reported.`),
    ];
  }
  if (state.unverifiable) {
    return [
      finding("MEDIUM", "run-lock-unverifiable", step, null, displayPath(runLockPath()),
        `${describeRunLock(state.lock)} — this machine cannot check that pid, so it is treated as running ` +
        `and act mode refuses to start. If that run is not actually running, delete ${displayPath(runLockPath())}.`),
    ];
  }
  return []; // a live run holds it. That is the lock working.
}

// ─── The claims, checked against the records ──────────────────────────────────

/**
 * Check each claim the command made against the record it says it wrote.
 *
 * @param {Array<{kind: string, run: Function, says: string}>} checks
 * @param {{tickets: Object[], patches: Object[]}} channels
 * @param {string} step
 * @returns {PostMortemFinding[]}
 */
function claimFindings(checks, channels, step) {
  const out = [];
  for (const c of checks) {
    let problem = null;
    try {
      problem = c.run(channels);
    } catch (err) {
      problem = { problem: `the record could not be read (${err.message})` };
    }
    if (!problem) continue;
    out.push(
      finding(
        "HIGH",
        "claim-unsupported",
        step,
        null,
        displayPath(ticketPaths().json),
        `${step} exited 0, which means ${c.says} — but ${problem.problem}. The command reported ` +
        `success and the record does not show it.`
      )
    );
  }
  return out;
}

// ─── The audit ────────────────────────────────────────────────────────────────

/**
 * Count a finding list into the shape the ledger and the report header use.
 * @param {PostMortemFinding[]} findings
 * @returns {{HIGH: number, MEDIUM: number, LOW: number}}
 */
function countFindings(findings) {
  return {
    HIGH: findings.filter((f) => f.severity === "HIGH").length,
    MEDIUM: findings.filter((f) => f.severity === "MEDIUM").length,
    LOW: findings.filter((f) => f.severity === "LOW").length,
  };
}

/**
 * Ask the delivery layer what its command left behind.
 *
 * Never throws and never changes the caller's exit code: an audit that can break a completed run is
 * an audit the operator turns off.
 *
 * @param {Object} opts
 * @param {string} opts.step - One of DELIVERY_COMMANDS.
 * @param {string[]} opts.argv - The arguments the command was given (`process.argv.slice(2)`).
 * @param {number} opts.exitCode - What the command returned.
 * @param {string} [opts.seriesDir] - The series the command worked on, when it knows one.
 * @param {boolean} [opts.quiet] - Assess and record, but do not print.
 * @param {boolean} [opts.brief] - Print the verdict line only, not the findings. Used by autopilot,
 *   whose moves are child commands that each ran their own audit and printed their own findings.
 * @param {PostMortemFinding[]} [opts.extraFindings] - Findings the command already knows about and
 *   the file checks cannot see — autopilot's refused manager decisions, for instance. They go into
 *   the report and the ledger like any other finding, which is what makes "the manager could not
 *   name a move" a recorded fact instead of a line on a console.
 * @returns {Promise<{report: PostMortemReport, recorded: boolean, error: string|null}>}
 */
async function auditDeliveryRun({ step, argv, exitCode, seriesDir, quiet, brief, extraFindings }) {
  try {
    const { claims, checks } = claimsFromInvocation({ step, argv, exitCode });

    const base = await runPostMortem({ step, seriesDir, claims });
    const channels = readChannels(step);

    const findings = [
      ...(base.findings || []),
      ...channels.errors,
      ...ticketFindings(channels.tickets, step),
      ...patchFindings(channels.patches, channels.tickets, step),
      ...unjudgedPatchFindings(step),
      ...planRecordFindings({ step, acting: claims.acting }),
      ...runLockFindings(step),
      ...claimFindings(checks, channels, step),
      ...(Array.isArray(extraFindings) ? extraFindings : []),
    ];

    const counts = countFindings(findings);
    /** @type {PostMortemReport} */
    const report = {
      step,
      ok: counts.HIGH === 0 && !base.error,
      findings,
      counts: { ...counts, volumes: 0, checked: base.counts ? base.counts.checked : 0 },
      markdown: "",
      error: base.error,
    };
    report.markdown = renderPostMortemMarkdown(report);

    const written = await writePostMortemReport(report, postMortemDir());

    if (!quiet) printAudit(step, report, written.markdown, brief);

    const recorded = recordAudit(step, report, exitCode);
    return { report, recorded, error: null };
  } catch (err) {
    if (!quiet) console.error(`[${step}] the after-run audit could not run: ${err.message}`);
    return { report: null, recorded: false, error: err.message };
  }
}

/**
 * Print the audit the way the runner prints a post-mortem: the verdict, where the report is, then
 * the findings a reader can act on (capped, because a broken channel produces dozens).
 *
 * @param {string} step
 * @param {PostMortemReport} report
 * @param {string} markdownPath
 * @param {boolean} [brief] - The verdict line only.
 * @returns {void}
 */
function printAudit(step, report, markdownPath, brief) {
  const { HIGH, MEDIUM, LOW } = report.counts;
  console.log(
    `[${step}] after-run audit — ${report.ok ? "CLEAN" : "FINDINGS"} ` +
      `(${HIGH} HIGH, ${MEDIUM} MEDIUM, ${LOW} LOW) — ${displayPath(markdownPath)}`
  );
  if (brief) return;
  if (report.error) console.log(`[${step}]   part of the assessment could not run: ${report.error}`);
  for (const f of report.findings.slice(0, 12)) {
    console.log(`[${step}]   [${f.severity}] ${f.file} — ${f.kind}: ${f.message}`);
  }
  if (report.findings.length > 12) {
    console.log(`[${step}]   … ${report.findings.length - 12} more (see the report)`);
  }
}

/**
 * Write the audit into the ledger, which is how a delivery finding reaches the next run's triage
 * instead of ending as a line on a console.
 *
 * Deliberately non-fatal, for the same reason the runner's is: the ledger is memory, not a gate, and
 * a run must not die because its memory could not be written.
 *
 * @param {string} step
 * @param {PostMortemReport} report
 * @param {number} exitCode
 * @returns {boolean}
 */
function recordAudit(step, report, exitCode) {
  const result = appendLedgerEntry({
    kind: "assessment",
    step,
    volume: null,
    findings: { HIGH: report.counts.HIGH, MEDIUM: report.counts.MEDIUM, LOW: report.counts.LOW },
    findingKinds: [...new Set(report.findings.map((f) => f.kind))],
    decidedBy: "runner",
    note: exitCode === 0 ? undefined : `command exited ${exitCode}`,
  });
  if (result.error) console.error(`[${step}] ledger: ${result.error}`);
  return result.written;
}

module.exports = {
  auditDeliveryRun,
  claimsFromInvocation,
  ticketFindings,
  patchFindings,
  planRecordFindings,
  runLockFindings,
  claimFindings,
  displayPath,
  TICKET_STATUSES,
};

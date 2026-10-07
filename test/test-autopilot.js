/**
 * test/test-autopilot.js — the loop that drives a run (`autopilot.js`).
 *
 * The loop owns no gate, no budget, no wipe and no record: every one of those lives behind a command
 * the account owner could type, and the loop types the same commands. So what is pinned here is the
 * loop's own behaviour, which is short but load-bearing:
 *
 *   1. **Watch mode writes nothing.** No ticket, no ledger entry, no plan file, no run lock. That is
 *      the only reason a rehearsal of this loop is safe: act mode refuses `--no-write` because a
 *      recorded intervention that did nothing poisons the ledger that catches a spin (gotcha 72), and
 *      a mode that records nothing at all is the honest rehearsal.
 *   2. **The menu is a fact about the state.** Exactly one `run` move per plan (the sequence, not a
 *      step an eager manager could cherry-pick and skip the cascade of), no banned option, no judge
 *      move for a patch that has already been decided.
 *   3. **A decision the state does not support stops the loop.** The manager is asked on every
 *      iteration, and `validateManagerAction` is the thing that makes that safe; the loop reports the
 *      refusal and the menu it was offered rather than trying again.
 *   4. **The loop takes no run lock of its own** — its children take their own — but it refuses to act
 *      beside a run that is already going.
 *   5. **An accept is the one move it will not take on the manager's word.**
 *
 * The manager's model call is stubbed at `harness.runOneShot`, which is the layer the real
 * `managerDecision` sits on: the shaped brief, the fail-closed parse and the menu gate all run for
 * real, so a scripted reply is tested through the same gate a live one would meet.
 * `AI_CLIENT_HOOKS_DIR` is pinned to an empty folder: `pre-autopilot` and `pre-manager` are real
 * executables on this machine and they start real model containers (docs/architecture.md, gotcha 22).
 *
 * No scenario spawns a pipeline step. The one act-mode scenario that spawns a command spawns
 * `delivery.js --open-ticket`, which writes a ticket in the fixture's own channel and reaches no
 * model.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const harness = require("../harness");
const autopilot = require("../autopilot");
const manager = require("../utils/manager");
const resume = require("../utils/resume");
const { completeSeries, leaveGateEvidenceBesideTheGap, writeChannel } = require("./fixture-series");

const HOOKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oresuki-empty-hooks-"));
process.env.AI_CLIENT_HOOKS_DIR = HOOKS_DIR;
// The loop's own settings, pinned to "unset" so the suite tests the CODE's defaults and not whatever
// this machine's `.env` says. `harness.js` loads dotenv at require time, and the live `.env` on the
// machine running the real series sets `AUTOPILOT_MODE=act` — a suite that read it would be asserting
// against a mode the account owner chose for a different purpose (gotcha 69, same rule, other half).
// An empty string is the pin: `resolveMode` / `maxIterations` treat it as unset, and `delete` would
// remove the pin and let `.env` win on the next read.
process.env.AUTOPILOT_MODE = "";
process.env.AUTOPILOT_MAX_ITERATIONS = "";
const FIXTURES = "/tmp/opencode/autopilot-tests";

/**
 * Script the manager's replies. Each entry is the raw text a model would have answered with.
 *
 * @param {string[]} replies
 * @returns {Array<Object>} - The calls the manager layer actually made, for asserting on.
 */
function scriptManager(replies) {
  const seen = [];
  const real = harness.runOneShot;
  harness.runOneShot = async (cfg) => {
    seen.push(cfg);
    const next = replies.shift();
    if (next === undefined) throw new Error("the script ran out of manager replies");
    return next;
  };
  return { seen, restore: () => { harness.runOneShot = real; } };
}

const json = (obj) => "```json\n" + JSON.stringify(obj) + "\n```";

/** The volume-15 shape: the gate removed the output and its evidence sits beside the gap. */
async function brokenGlossarySeries(label) {
  const fx = await completeSeries(label, FIXTURES);
  await leaveGateEvidenceBesideTheGap(fx.dir, "Test Story(02)", "02");
  return fx;
}

/** Every file in the fixture's machine-state folder, so "wrote nothing" is checkable. */
function ledgerListing(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// ─── 1: the menu is a fact about the state ────────────────────────────────────

function testOfferMoves() {
  const plan = {
    verdict: "resume",
    steps: [
      { step: "glossary", action: "run", actionName: "wipe-and-cascade", fromVolume: "02", cascade: true, countsAsIntervention: true },
      { step: "character-voice", action: "after", actionName: "re-run-step", countsAsIntervention: false },
      { step: "style-guide", action: "after", actionName: "re-run-step", countsAsIntervention: false },
    ],
  };

  const moves = autopilot.offerMoves({ plan, tickets: [], patches: [] });
  const runs = moves.filter((m) => m.kind === "run");
  assert.strictEqual(runs.length, 1, "one run move per plan: the sequence is the triage's answer");
  assert.strictEqual(runs[0].step, "glossary", "the entry point, not a later step");
  assert.ok(
    runs[0].label.includes("character-voice, style-guide"),
    `the label names what the same sequence then runs, so the manager is choosing a sequence: ${runs[0].label}`
  );
  assert.ok(runs[0].label.includes("counts against this step's allowance"), runs[0].label);
  assert.ok(moves.some((m) => m.kind === "escalate"), "escalate is always on the menu: it is the correct end of a run");

  // A plan whose answer is a question offers no run move at all.
  const ticketPlan = { verdict: "resume", steps: [{ step: "glossary", action: "ticket", actionName: "open-ticket", fromVolume: "02" }] };
  const askOnly = autopilot.offerMoves({ plan: ticketPlan, tickets: [], patches: [] });
  assert.strictEqual(askOnly.filter((m) => m.kind === "run").length, 0, "the steps after a ticket are conditional on it");

  // An answered ticket: the allowed option is offered, the refused one is not, and the dev team is
  // offered only because the chosen option needs code.
  const answered = {
    id: "TCK-1",
    status: "answered",
    step: "glossary",
    volume: "02",
    finding: "missing-required",
    question: "Why?",
    diagnosis: { questions: ["Does the volume print the older spelling?"], at: "" },
    answers: [],
    options: [{ id: "TCK-1/O1", label: "match the aliases inside a term cell", touches: ["utils/prompt.js"], cost: "low", risk: "low", verify: "term rows counted", requiresCodeChange: true }],
    refusedOptions: [{ option: { id: "TCK-1/O2", label: "turn off the carry-forward guard" }, because: "disable-carry-forward-guard", escalateTo: "the account owner" }],
  };
  const withTicket = autopilot.offerMoves({ plan: ticketPlan, tickets: [answered], patches: [] });
  const chooses = withTicket.filter((m) => m.kind === "choose");
  assert.strictEqual(chooses.length, 1, "the banned option is not offered. A manager given a menu picks the cheap item on it (gotcha 70).");
  assert.strictEqual(chooses[0].option, "TCK-1/O1");
  assert.strictEqual(withTicket.filter((m) => m.kind === "diagnose").length, 0, "it has already been answered once");
  assert.strictEqual(withTicket.filter((m) => m.kind === "fix").length, 0, "no patch yet, but nothing has been CHOSEN either");
  assert.ok(withTicket.some((m) => m.kind === "answer" && m.label.includes("older spelling")), "the team's open question is on the menu");

  const chosen = { ...answered, status: "chosen", choice: { optionId: "TCK-1/O1", reason: "it changes the test" } };
  const withChoice = autopilot.offerMoves({ plan: ticketPlan, tickets: [chosen], patches: [] });
  assert.strictEqual(withChoice.filter((m) => m.kind === "fix").length, 1, "the dev team is summoned by a chosen option that needs code");
  const withPatch = autopilot.offerMoves({
    plan: ticketPlan,
    tickets: [chosen],
    patches: [{ id: "P-1", ticketId: "TCK-1", status: "proposed" }],
  });
  assert.strictEqual(withPatch.filter((m) => m.kind === "fix").length, 0, "one team at a time");
  assert.strictEqual(withPatch.filter((m) => m.kind === "judge").length, 2, "accept and reject, and nothing else");
  const decided = autopilot.offerMoves({ plan: ticketPlan, tickets: [chosen], patches: [{ id: "P-1", ticketId: "TCK-1", status: "accepted" }] });
  assert.strictEqual(decided.filter((m) => m.kind === "judge").length, 0, "a decided patch is not a question");

  console.log("  menu: one run move per plan, no banned option, no second team, no re-judging a decision");
}

// ─── 2: a decision becomes the account owner's command ────────────────────────

function testCommands() {
  const at = (args) => autopilot.describeCommand(args);
  assert.strictEqual(at(autopilot.commandFor({ action: "run", step: "glossary", reason: "x" })), "node delivery.js --mode=act");
  assert.strictEqual(
    at(autopilot.commandFor({ action: "diagnose", ticket: "TCK-1", reason: "x" })),
    "node diagnose.js --ticket=TCK-1"
  );
  const answeredForCommand = {
    id: "TCK-1",
    status: "answered",
    diagnosis: { questions: ["Does the volume print the older spelling?"], attempts: 1 },
    answers: [],
  };
  assert.strictEqual(
    at(autopilot.commandFor({ action: "answer", ticket: "TCK-1", answer: "twice in chapter 3" }, { ticket: answeredForCommand })),
    "node diagnose.js --ticket=TCK-1 --question=Does the volume print the older spelling? --answer=twice in chapter 3",
    "the team's own wording of the question is passed through, because recordAnswer matches it exactly"
  );
  assert.strictEqual(
    at(autopilot.commandFor({ action: "answer", ticket: "TCK-1", answer: "twice in chapter 3" }, { ticket: null })),
    "node diagnose.js --ticket=TCK-1 --answer=twice in chapter 3"
  );
  assert.strictEqual(
    at(autopilot.commandFor({ action: "choose", ticket: "TCK-1", option: "TCK-1/O1", reason: "it changes the test" })),
    "node delivery.js --choose=TCK-1/O1 --ticket=TCK-1 --reason=it changes the test"
  );
  assert.strictEqual(at(autopilot.commandFor({ action: "fix", ticket: "TCK-1", reason: "x" })), "node fix.js --ticket=TCK-1");
  assert.strictEqual(
    at(autopilot.commandFor({ action: "judge", patch: "P-1", outcome: "reject", reason: "it hides the loss" })),
    "node delivery.js --mode=act --reject-patch=P-1 --reason=it hides the loss"
  );
  assert.deepStrictEqual(autopilot.commandFor({ action: "escalate", note: "x", reason: "x" }), [], "escalate runs nothing");
  assert.deepStrictEqual(autopilot.commandFor({ action: "end", reason: "x" }), [], "end is proved, not executed");

  // Accepting is not landing it, and rejecting is not undoing it. Both follow-ups are what keep the
  // next run from being gated by a patch nobody finished dealing with (gotcha 75).
  assert.deepStrictEqual(
    autopilot.followUpsFor({ action: "judge", patch: "P-1", outcome: "accept", reason: "x" }).map((a) => path.basename(a)),
    ["fix.js", "--commit=P-1"]
  );
  assert.deepStrictEqual(
    autopilot.followUpsFor({ action: "judge", patch: "P-1", outcome: "reject", reason: "x" }).map((a) => path.basename(a)),
    ["fix.js", "--revert=P-1"]
  );
  assert.deepStrictEqual(autopilot.followUpsFor({ action: "run", step: "glossary", reason: "x" }), []);

  // The loop's own flags. `--dry-run` is refused rather than passed through: it is a pipeline flag that
  // also suppresses hooks, and the hooks are the only thing that decides which container answers.
  assert.ok(autopilot.readArgs(["--dry-run"]).error.includes("no --dry-run"), autopilot.readArgs(["--dry-run"]).error);
  assert.strictEqual(autopilot.readArgs(["--frobnicate"]).error.includes("unknown flag"), true);
  assert.strictEqual(autopilot.readArgs(["--max-iterations=0"]).error !== null, true);
  assert.strictEqual(autopilot.resolveMode(null), "watch", "the default writes nothing");
  assert.strictEqual(autopilot.maxIterations(null), 12);

  console.log("  commands: every decision maps to the command the account owner would type, and the follow-ups are not optional");
}

// ─── 3: watch mode decides, prints, and touches nothing ───────────────────────

async function testWatchModeWritesNothing() {
  const fx = await brokenGlossarySeries("watch");
  const before = ledgerListing(fx.ledgerDir);

  const stub = scriptManager([json({ action: "diagnose", ticket: "PREVIEW-glossary-02", reason: "the gate is the thing I cannot read" })]);
  let log = "";
  let result;
  try {
    result = await autopilot.runLoop({
      mode: "watch",
      seriesDir: fx.dir,
      iterationCap: 12,
      log: (line) => {
        log += `[autopilot] ${line}\n`;
      },
    });
  } finally {
    stub.restore();
  }

  assert.strictEqual(result.exitCode, 1, "watch mode never acts, so it never reaches a provable end");
  assert.strictEqual(result.decisions.length, 1, "one decision, then it stops");
  assert.strictEqual(result.decisions[0].action.action, "diagnose");
  assert.strictEqual(
    result.decisions[0].command,
    "node diagnose.js --ticket=PREVIEW-glossary-02",
    "the exact command act mode would have run is printed, not left to be guessed"
  );

  // The rehearsal half: the manager was shown the real menu, the real question, and the fact that the
  // question is not yet a record. A role that decides from a preview has to be told it is a preview.
  assert.ok(result.decisions[0].offered.some((l) => l.startsWith("diagnose ")), JSON.stringify(result.decisions[0].offered));
  assert.ok(!result.decisions[0].offered.some((l) => l.startsWith("run ")), "there is nothing executable: the plan's answer is a question");
  const brief = stub.seen[0].messages[0].text;
  assert.ok(brief.includes("PREVIEW — not written"), "the preview says what it is, where the manager reads it");
  assert.ok(brief.includes("reproduced rather than repaired"), "the question act mode would write is the one it was shown");
  assert.ok(log.includes("shown as a preview, not opened"), log);

  // The load-bearing half: nothing was written. Not a ticket, not a ledger entry, not a plan file, not
  // a run lock. A rehearsal that records is the rehearsal that gets switched off (gotcha 72).
  assert.deepStrictEqual(ledgerListing(fx.ledgerDir), before, `watch mode wrote into ${fx.ledgerDir}: ${ledgerListing(fx.ledgerDir)}`);
  assert.strictEqual(fs.existsSync(path.join(fx.ledgerDir, "tickets.json")), false, "no ticket was opened");
  assert.strictEqual(fs.existsSync(path.join(fx.ledgerDir, "ledger.json")), false, "no intervention was recorded");
  assert.strictEqual(fs.existsSync(path.join(fx.ledgerDir, "run.lock")), false, "the loop takes no lock of its own");
  assert.strictEqual(
    fs.existsSync(path.join(fx.dir, "Test Story(02)", "glossary.md.rejected")),
    true,
    "the gate's evidence is still where it was"
  );

  console.log("  watch mode: the decision, the menu and the command are printed, and the fixture's machine state is untouched");
}

// ─── 4: a decision the state does not support stops the loop ──────────────────

async function testIllegalDecisionStops() {
  const fx = await brokenGlossarySeries("off-menu");
  const stub = scriptManager([json({ action: "run", step: "polish", reason: "just finish it" })]);
  let log = "";
  try {
    const result = await autopilot.runLoop({
      mode: "watch",
      seriesDir: fx.dir,
      iterationCap: 12,
      log: (line) => {
        log += `[autopilot] ${line}\n`;
      },
    });
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.decisions[0].kind, "not-offered");
    assert.ok(result.decisions[0].refusal.includes("no \"run\" move"), result.decisions[0].refusal);
    assert.ok(log.includes("REFUSED:"), log);
    assert.ok(log.includes("the menu it was offered"), "the refusal prints what WAS available, because a refusal you cannot act on gets worked around");
    assert.strictEqual(stub.seen.length, 1, "one decision, then the loop stops rather than asking again");
  } finally {
    stub.restore();
  }

  // An answer that is not a decision at all. On this machine the usual cause is the wrong container
  // serving — every container advertises the same model id — so the loop says that out loud instead of
  // reporting "the model returned no content" and leaving a human to find it in the logs (gotcha 62).
  const fx2 = await brokenGlossarySeries("unparseable");
  const stub2 = scriptManager(["Honestly, I would just try running it again and see what happens."]);
  let log2 = "";
  try {
    const result2 = await autopilot.runLoop({ mode: "watch", seriesDir: fx2.dir, iterationCap: 12, log: (l) => { log2 += `${l}\n`; } });
    assert.strictEqual(result2.exitCode, 1);
    assert.strictEqual(result2.decisions[0].kind, "unparseable");
    assert.ok(log2.includes("model-switch-state"), log2);
  } finally {
    stub2.restore();
  }

  console.log("  fail-closed: an illegal move and an unparseable reply both stop the loop and say why");
}

// ─── 5: `end` is proved before the loop believes it ───────────────────────────

async function testProvableEnd() {
  const fx = await completeSeries("clean-end", FIXTURES);
  const stub = scriptManager([json({ action: "end", reason: "every step left what it claims to have, and the book is published" })]);
  try {
    const result = await autopilot.runLoop({ mode: "watch", seriesDir: fx.dir, iterationCap: 12, log: () => {} });
    assert.strictEqual(result.exitCode, 0, result.why);
    assert.strictEqual(result.decisions[0].action.action, "end");
  } finally {
    stub.restore();
  }

  // The same words are refused when the records do not support them.
  const broken = await brokenGlossarySeries("end-refused");
  const stub2 = scriptManager([json({ action: "end", reason: "I think we are done" })]);
  try {
    const result = await autopilot.runLoop({ mode: "watch", seriesDir: broken.dir, iterationCap: 12, log: () => {} });
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.decisions[0].kind, "end-not-provable");
    assert.ok(result.decisions[0].refusal.includes("resume"), result.decisions[0].refusal);
  } finally {
    stub2.restore();
  }

  console.log("  end: accepted when the records prove it, refused when they do not");
}

// ─── 6: act mode writes the question the triage says is the answer ────────────

async function testActModeOpensTheTicket() {
  const fx = await brokenGlossarySeries("act-ticket");
  const stub = scriptManager([json({ action: "escalate", note: "the carry-forward gate refused a glossary that grew, and only the account owner may decide whether the guard is wrong", reason: "the question is written and the answer belongs to a human" })]);
  let log = "";
  try {
    const result = await autopilot.runLoop({
      mode: "act",
      seriesDir: fx.dir,
      iterationCap: 12,
      log: (line) => {
        log += `[autopilot] ${line}\n`;
      },
    });
    assert.strictEqual(result.exitCode, 1, "escalate is a stop, and a correct one");
    assert.ok(log.includes("Writing it down"), log);

    const tickets = JSON.parse(fs.readFileSync(path.join(fx.ledgerDir, "tickets.json"), "utf8")).tickets;
    assert.strictEqual(tickets.length, 1, "the plan's question was written once");
    assert.ok(/^Why/.test(tickets[0].question), `findings-shaped, not a demand: ${tickets[0].question}`);
    assert.ok(tickets[0].question.includes("reproduced rather than repaired"), tickets[0].question);

    // And the manager was then offered the move that needed the ticket to exist.
    assert.ok(
      result.decisions[0].offered.some((l) => l.startsWith(`diagnose ${tickets[0].id}`)),
      JSON.stringify(result.decisions[0].offered)
    );
    assert.ok(log.includes("the account owner's decision"), log);
    assert.strictEqual(fs.existsSync(path.join(fx.ledgerDir, "ledger.json")), false, "an escalation records nothing in the ledger");
  } finally {
    stub.restore();
  }

  // Calling the loop again does not write a second question: the triage names the live ticket, and
  // `--open-ticket` is idempotent so the loop may run it every iteration.
  const stub2 = scriptManager([json({ action: "escalate", note: "the ticket is open and the answer belongs to the account owner", reason: "nothing left that this loop may do" })]);
  try {
    const again = await autopilot.runLoop({ mode: "act", seriesDir: fx.dir, iterationCap: 12, log: () => {} });
    assert.strictEqual(again.exitCode, 1);
    const tickets = JSON.parse(fs.readFileSync(path.join(fx.ledgerDir, "tickets.json"), "utf8")).tickets;
    assert.strictEqual(tickets.length, 1, "a live ticket is worked, not duplicated");
  } finally {
    stub2.restore();
  }

  console.log("  act mode: the triage's question is written once, and the loop stops at the decision that belongs to a human");
}

// ─── 7: an accept is the one move it will not take on the manager's word ──────

async function testUnattendedAcceptIsGated() {
  const fx = await completeSeries("accept-gate", FIXTURES);
  // A patch with no checks run: the harness gives the dev team no shell, so the machine ran them or
  // they never happened (gotcha 75).
  await writeChannel(fx.dir, "patches.json", {
    patches: [
      {
        id: "P-1",
        ticketId: "TCK-1",
        status: "proposed",
        files: ["utils/prompt.js"],
        summary: "compare the aliases inside a term cell",
        expected: ["glossaryTermRows"],
        warnings: [],
        questions: [],
        ownerNote: "",
      },
    ],
  });

  const stub = scriptManager([json({ action: "judge", patch: "P-1", outcome: "accept", reason: "it fixes the relevance test rather than the complaint" })]);
  let log = "";
  try {
    const result = await autopilot.runLoop({ mode: "act", seriesDir: fx.dir, iterationCap: 12, log: (l) => { log += `${l}\n`; } });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(log.includes("will not do that unattended"), log);
    assert.ok(log.includes("checks"), log);
    assert.strictEqual(stub.seen.length, 1, "it stops at the gate rather than trying another decision");
    const after = JSON.parse(fs.readFileSync(path.join(fx.dir, ".postmortem", "patches.json"), "utf8")).patches;
    assert.strictEqual(after[0].status, "proposed", "the patch is still waiting for a human's judgment");
  } finally {
    stub.restore();
  }

  console.log("  accept: the loop judges only what the machine can vouch for, and stops rather than widening it");
}

// ─── 8: the loop does not act beside a run that is already going ──────────────

async function testRunLockIsRespected() {
  const fx = await completeSeries("locked", FIXTURES);
  // Somebody else's run, on this machine, with a pid that is demonstrably alive.
  fs.writeFileSync(
    path.join(fx.ledgerDir, "run.lock"),
    JSON.stringify({ runId: "somebody-elses-run", pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), by: "index.js", nested: 1 }, null, 2) + "\n",
    "utf8"
  );

  const stub = scriptManager([]);
  try {
    const result = await autopilot.runLoop({ mode: "act", seriesDir: fx.dir, iterationCap: 12, log: () => {} });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.why.includes("already in progress"), result.why);
    assert.ok(result.why.includes("somebody-elses-run"), result.why);
    assert.strictEqual(stub.seen.length, 0, "it refuses before spending a decision");
    assert.strictEqual(result.decisions.length, 0);
  } finally {
    stub.restore();
    fs.rmSync(path.join(fx.ledgerDir, "run.lock"), { force: true });
  }

  console.log("  run lock: the loop takes none of its own, and refuses to act beside somebody else's");
}

// ─── 9: the iteration cap is a wall, not a budget ─────────────────────────────

/**
 * The shape the ledger's gates cannot see: legal, different, non-repeating moves that never arrive at
 * a provable end. The anti-spin gate needs a repetition and the per-step allowance needs an
 * intervention, and this has neither — so the cap is what bounds it.
 *
 * Act mode, because watch mode stops after one decision by design (re-asking the manager about a
 * state that was not changed would re-pay for the same reading). The moves here answer the diagnostics
 * team's questions one at a time, which is the one act-mode command that reaches no model.
 */
async function testIterationCap() {
  const fx = await completeSeries("capped", FIXTURES);
  await writeChannel(fx.dir, "tickets.json", {
    tickets: [
      {
        id: "TCK-1",
        run: "run-1",
        step: "glossary",
        volume: "02",
        finding: "missing-required",
        status: "answered",
        question: "Why does the carry-forward gate refuse this volume's glossary?",
        evidence: [{ file: "Test Story(02)/glossary.md.rejected", note: "the gate's account" }],
        tried: [],
        ruledOut: [],
        diagnosis: {
          cause: "the relevance test compares the whole term cell instead of the aliases inside it",
          options: [],
          questions: ["Does volume 01 use the older spelling?", "Does volume 02?", "Does the glossary snapshot?"],
          read: ["utils/prompt.js"],
          at: new Date().toISOString(),
        },
        answers: [],
      },
    ],
  });

  const replies = [];
  for (let i = 0; i < 6; i += 1) {
    replies.push(
      json({
        action: "answer",
        ticket: "TCK-1",
        question: ["Does volume 01 use the older spelling?", "Does volume 02?", "Does the glossary snapshot?"][i % 3],
        answer: `volume ${i} prints it twice`,
        reason: `the folders are what I am allowed to read, so I read them (attempt ${i})`,
      })
    );
  }
  const stub = scriptManager(replies);
  try {
    const result = await autopilot.runLoop({ mode: "act", seriesDir: fx.dir, iterationCap: 2, log: () => {} });
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.decisions.length, 2, "two legal, different answers, then the wall");
    assert.ok(result.why.includes("2 decisions"), result.why);
    assert.ok(result.why.includes("wall, not a budget"), result.why);

    const ticket = JSON.parse(fs.readFileSync(path.join(fx.ledgerDir, "tickets.json"), "utf8")).tickets[0];
    assert.strictEqual(ticket.answers.length, 2, "the answers it made were real records, not printed intentions");
    assert.strictEqual(fs.existsSync(path.join(fx.ledgerDir, "ledger.json")), false, "answering is not an intervention");
  } finally {
    stub.restore();
  }
  console.log("  iteration cap: legal and different is not the same as safe, and the cap is the wall for that case");
}

// ─── 10: the CLI ──────────────────────────────────────────────────────────────

function testCli() {
  const { spawnSync } = require("child_process");
  const ROOT = path.resolve(__dirname, "..");
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [path.join(ROOT, "autopilot.js"), ...args], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, AI_CLIENT_HOOKS_DIR: HOOKS_DIR, ...env },
    });

  const dryRun = run(["--dry-run"]);
  assert.strictEqual(dryRun.status, 2, dryRun.stderr);
  assert.ok(dryRun.stderr.includes("no --dry-run"), dryRun.stderr);

  const badMode = run(["--mode=maybe"]);
  assert.strictEqual(badMode.status, 2, badMode.stderr);
  assert.ok(badMode.stderr.includes("AUTOPILOT_MODE"), badMode.stderr);

  const badFlag = run(["--frobnicate"]);
  assert.strictEqual(badFlag.status, 2, badFlag.stderr);
  assert.ok(badFlag.stderr.includes("unknown flag"), badFlag.stderr);

  const noSeries = run([], { SERIES_LOCATION: "" });
  assert.strictEqual(noSeries.status, 2, noSeries.stderr);
  assert.ok(noSeries.stderr.includes("SERIES_LOCATION"), noSeries.stderr);

  const missingDir = run(["--series=/tmp/opencode/definitely-not-a-series"]);
  assert.strictEqual(missingDir.status, 2, missingDir.stderr);
  assert.ok(missingDir.stderr.includes("does not exist"), missingDir.stderr);

  console.log("  autopilot.js: a flag that would rehearse by recording, a mode that does not exist, and a series that does not are all refused");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  testOfferMoves();
  testCommands();
  await testWatchModeWritesNothing();
  await testIllegalDecisionStops();
  await testProvableEnd();
  await testActModeOpensTheTicket();
  await testUnattendedAcceptIsGated();
  await testRunLockIsRespected();
  await testIterationCap();
  testCli();
  fs.rmSync(HOOKS_DIR, { recursive: true, force: true });
  console.log("autopilot loop: ok");
})().catch((err) => {
  console.error("autopilot test failed:", err.message);
  console.error(err.stack);
  process.exitCode = 1;
});

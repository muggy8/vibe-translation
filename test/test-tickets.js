/**
 * test-tickets.js — the conversation between the manager and the teams that can see the code,
 * and proof that both of its rules have teeth.
 *
 * Two rules, both planted from a real incident (AGENTS.md gotcha 68, volume 15 of the live
 * series):
 *
 *   1. A ticket asks a question. It reports what it saw, what it already tried, what it ruled
 *      out — and then asks why. It never states the result it wants. The reason: the cheapest
 *      way to satisfy "make volume 15 pass" is to remove the FINDING rather than the fault, and
 *      in that incident the finding was a gate correctly refusing a glossary that had GROWN
 *      from 445 terms to 460. A fixer chasing the demand would have weakened the guard and
 *      silently lost terms.
 *   2. The options the manager is offered are filtered on the provider's side, in code. A
 *      manager picks the cheap option, so a rule about the manager's judgment is not a rule.
 *      Every refused option stays visible on the ticket with its reason and where it goes
 *      instead — a dropped option looks like it was never thought of.
 *
 * So this suite asserts BOTH directions, every time: the honest ticket is accepted, the demand
 * is refused with a message that says what to write instead; the legitimate option is allowed,
 * each banned one is refused by name.
 *
 * No network, no endpoint, no model call. Run with `npm test` (or standalone:
 * `node test/test-tickets.js`).
 */
require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

// Both files resolve their home through postMortemDir(), which reads POSTMORTEM_DIR at call
// time — so pointing it at a temp folder here keeps the real .postmortem/ untouched (and keeps
// the ledger and the tickets in the same place, which is what the composition test needs).
const TMP = path.join(os.tmpdir(), "oresuki-tickets-test");
process.env.POSTMORTEM_DIR = path.join(TMP, "postmortem");

const {
  BANNED_OPTIONS,
  ticketPaths,
  optionIsBanned,
  filterOptions,
  validateTicketShape,
  triedFromLedger,
  readTickets,
  createTicket,
  attachOptions,
  recordChoice,
  closeTicket,
  openTickets,
  ticketsFor,
  renderTicketMarkdown,
  renderTicketsMarkdown,
} = require("../utils/tickets");
const { appendLedgerEntry, ledgerPath } = require("../utils/ledger");

/** A fresh ticket file per scenario. */
async function freshTickets(name) {
  const dir = path.join(TMP, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return { json: path.join(dir, "tickets.json"), markdown: path.join(dir, "tickets.md") };
}

/** The ticket the manager SHOULD have written about volume 15 — used again and again. */
function goodVolume15Ticket(extra = {}) {
  return {
    step: "glossary",
    volume: "15",
    finding: "quarantine-present",
    evidence: [
      { file: "俺を好きなのはお前だけかよ(15)/glossary.md.rejected", note: "the quarantined file holds 460 term rows" },
      { file: "俺を好きなのはお前だけかよ(14)/glossary.md", note: "the previous volume's baseline holds 445 term rows" },
      { file: ".postmortem/glossary.md", note: "the report calls it a dropped term and blames a reply-budget cut-off" },
    ],
    ruledOut: [
      "the file did not shrink — it grew by 15 rows, so this is not a reply cut off mid-write",
      "re-running the step produced the identical quarantine twice, so it is not a transient failure",
    ],
    question:
      "Why is volume 15's glossary quarantined when it grew from 445 terms to 460? The report says a term was dropped, and the term appears in the file under a different source-language spelling.",
    ...extra,
  };
}

// ─── 1. The honest ticket is accepted, and survives a round trip ──────────────

async function scenarioGoodTicketRoundTrips() {
  const paths = await freshTickets("roundtrip");
  const created = createTicket(goodVolume15Ticket(), paths);
  assert.ok(created.written, `the honest ticket must be accepted: ${created.problems.map((p) => p.message).join(" | ")}`);
  assert.strictEqual(created.ticket.status, "open");
  assert.ok(created.ticket.id.startsWith("TCK-"), created.ticket.id);

  const read = readTickets(paths.json);
  assert.strictEqual(read.tickets.length, 1);
  assert.strictEqual(read.tickets[0].question, created.ticket.question);
  assert.strictEqual(read.tickets[0].volume, "15");

  // The human-readable file is written too, and it is readable.
  const md = await fs.readFile(paths.markdown, "utf8");
  assert.ok(md.includes("grew from 445 terms to 460"), md.slice(0, 400));
  assert.ok(md.includes("Ruled out"), "the eliminations must reach the human file");
  assert.ok(md.includes("Open: 1"), md.slice(0, 400));
}

// ─── 2. A ticket that states the result it wants is refused ───────────────────

async function scenarioOutcomeShapedTicketRefused() {
  const paths = await freshTickets("outcome");

  const demands = [
    "Make volume 15's glossary pass.",
    "Can you make the gate stop quarantining volume 15?",
    "Please remove the quarantine finding so the run can continue.",
    "We need volume 15 accepted before the translation stage starts.",
    "Fix it by reconciling the two spellings so the check clears.",
  ];

  for (const question of demands) {
    const bad = createTicket(goodVolume15Ticket({ question }), paths);
    assert.strictEqual(bad.written, false, `must be refused: "${question}"`);
    assert.ok(bad.problems.length, `must explain itself: ${question}`);
    assert.ok(
      bad.problems.some((p) => p.kind === "outcome-demanded" || p.kind === "demand"),
      `must name the shape, got ${bad.problems.map((p) => p.kind).join(",")}: ${question}`
    );
    // The refusal teaches, it does not just say no.
    assert.ok(
      bad.problems.some((p) => p.message.includes("deliverable") || p.message.includes("question")),
      `a refusal must say what to write instead: ${bad.problems[0].message}`
    );
  }

  assert.strictEqual(readTickets(paths.json).tickets.length, 0, "a refused ticket is not written");

  // And the honest version of the same complaint IS accepted — the false-positive half.
  const honest = createTicket(goodVolume15Ticket(), paths);
  assert.ok(honest.written, honest.problems.map((p) => p.message).join(" | "));
}

// ─── 3. A ticket may not give orders ──────────────────────────────────────────

async function scenarioCommandsRefused() {
  const paths = await freshTickets("commands");
  const commands = [
    "Disable the carry-forward guard for this volume. It is wrong.",
    "Lower PASSING_SCORE and re-run the acceptance check.",
    "Edit the glossary prompt so it stops producing this shape.",
  ];
  for (const question of commands) {
    const bad = createTicket(goodVolume15Ticket({ question }), paths);
    assert.strictEqual(bad.written, false, `a command must be refused: ${question}`);
    assert.ok(
      bad.problems.some((p) => p.kind === "demand"),
      `must be caught as a command: ${bad.problems.map((p) => p.kind).join(",")}`
    );
  }

  // A question about the same mechanism is fine — the line is command vs question.
  const asked = createTicket(
    goodVolume15Ticket({ question: "Which column does the carry-forward gate read when it decides a term is gone?" }),
    paths
  );
  assert.ok(asked.written, asked.problems.map((p) => p.message).join(" | "));
}

// ─── 4. A ticket may not ask for a banned thing either ────────────────────────

async function scenarioBannedQuestionRefused() {
  const paths = await freshTickets("banned-question");
  const bad = createTicket(
    goodVolume15Ticket({ question: "Should GLOSSARY_CARRY_FORWARD_GUARD be set to false for volume 15?" }),
    paths
  );
  assert.strictEqual(bad.written, false);
  const banned = bad.problems.find((p) => p.kind === "banned-requested");
  assert.ok(banned, `must be caught before diagnostics is asked: ${bad.problems.map((p) => p.kind).join(",")}`);
  assert.ok(banned.message.includes("account owner"), banned.message);
}

// ─── 5. A ticket with no finding, or no evidence, is not a ticket ─────────────

async function scenarioIncompleteTicket() {
  const paths = await freshTickets("incomplete");

  const noFinding = createTicket({ ...goodVolume15Ticket(), step: undefined, finding: undefined }, paths);
  assert.strictEqual(noFinding.written, false);
  assert.ok(noFinding.problems.some((p) => p.kind === "missing-finding"), noFinding.problems[0].message);

  const noEvidence = createTicket({ ...goodVolume15Ticket(), evidence: [] }, paths);
  assert.strictEqual(noEvidence.written, false);
  assert.ok(noEvidence.problems.some((p) => p.kind === "no-evidence"), noEvidence.problems[0].message);

  const noQuestion = createTicket({ ...goodVolume15Ticket(), question: "" }, paths);
  assert.strictEqual(noQuestion.written, false);
  assert.ok(noQuestion.problems.some((p) => p.kind === "no-question"), noQuestion.problems[0].message);

  // A summary with no question in it is the common shape of this mistake.
  const summary = createTicket(
    { ...goodVolume15Ticket(), question: "The glossary step quarantined volume 15 twice and the run stopped." },
    paths
  );
  assert.strictEqual(summary.written, false);
  assert.ok(summary.problems.some((p) => p.kind === "not-a-question"), summary.problems[0].message);
}

// ─── 6. Every banned option is refused, by name, with somewhere to go ─────────

async function scenarioBannedOptions() {
  const bannedExamples = [
    ["disable-carry-forward-guard", "Set GLOSSARY_CARRY_FORWARD_GUARD=false for volume 15"],
    ["disable-carry-forward-guard", "Turn off the carry-forward guard for this volume"],
    ["disable-carry-forward-guard", "Disabling the voice carry-forward guard would clear volume 03"],
    ["allow-fail-or-no-glossary", "Run translate with --allow-no-glossary on volume 15"],
    ["allow-fail-or-no-glossary", "Pass --allow-fail so the audit verdict does not block the stage"],
    ["lower-a-threshold", "Lower PASSING_SCORE to 60 so the volume accepts"],
    ["lower-a-threshold", "Relax the acceptance sample floor for the glossary stage"],
    ["delete-evidence", "Delete glossary.md.rejected so the quarantine finding clears"],
    ["delete-evidence", "Clean the .postmortem reports and start fresh"],
    ["edit-hooks", "Edit hooks/pre-glossary.sh to switch the container back"],
    ["hide-the-finding", "Remove the glossary.md expectation from utils/artifacts.js for volume 15"],
    ["hide-the-finding", "Mark the coverage report as not required for this volume"],
    ["turn-a-failure-into-a-skip", "Set ON_VOLUME_ERROR=skip so the run continues past volume 15"],
    ["turn-a-failure-into-a-skip", "Change ON_TASK_ERROR to continue so the remaining steps run"],
    ["disable-the-ledger", "Turn off the ledger so the re-run is not blocked"],
    ["disable-the-ledger", "Raise LEDGER_SPIN_ATTEMPTS to 9"],
  ];

  for (const [expectedId, label] of bannedExamples) {
    const verdict = optionIsBanned({ label });
    assert.ok(verdict.banned, `must be refused: ${label}`);
    assert.ok(
      verdict.reasons.some((r) => r.id === expectedId),
      `refused for the wrong reason (${verdict.reasons.map((r) => r.id).join(",")}), expected ${expectedId}: ${label}`
    );
    for (const r of verdict.reasons) {
      assert.ok(r.because.length > 40, `a refusal must explain itself: ${r.id}`);
      assert.ok(r.escalateTo.includes("account owner"), `a refusal must name the escalation: ${r.id}`);
    }
  }

  // The legitimate half of the same menu must all pass. A filter that refuses everything is the
  // filter that gets switched off (gotcha 65's lesson, in its general form).
  const legitimate = [
    "Wipe volume 15's glossary outputs and cascade the later volumes",
    "Re-run the glossary step for volume 15 from the previous volume's baseline",
    "Restore the previous volume's glossary as the baseline and amend in place",
    "Re-audit the series artifacts with --force after the glossary is rebuilt",
    "Compare the alias spans in the term column instead of the whole cell, in compareGlossaryCarryForward",
    "Hand the extraction pass the complete term list instead of a truncated window",
    "Read the disputes queue and settle the two open terminology disputes",
  ];
  for (const label of legitimate) {
    const verdict = optionIsBanned({ label });
    assert.ok(!verdict.banned, `a legitimate option was refused (${verdict.reasons.map((r) => r.id).join(",")}): ${label}`);
  }

  assert.ok(BANNED_OPTIONS.length >= 8, "the banned list is the design's spine — it must not shrink quietly");
}

// ─── 7. Refused options stay visible, and a refused option cannot be chosen ───

async function scenarioOptionsStayVisible() {
  const paths = await freshTickets("options");
  const created = createTicket(goodVolume15Ticket(), paths);
  assert.ok(created.written, created.problems.map((p) => p.message).join(" | "));
  const id = created.ticket.id;

  const answered = attachOptions(
    id,
    [
      {
        label: "Wipe volume 15's glossary outputs and cascade",
        touches: ["俺を好きなのはお前だけかよ(15)/glossary.md", "俺を好きなのはお前だけかよ(15)/glossary-rolling-state.json"],
        cost: "cheap",
        risk: "rebuilds volumes 16-17's glossaries too",
        verify: "term count after: at least 460, and no .rejected file beside it",
      },
      {
        label: "Compare alias spans in the term column instead of the whole cell",
        touches: ["ai-client/glossary.js"],
        cost: "expensive",
        risk: "a wider match could excuse a real deletion — needs the test that pins both directions",
        verify: "the volume-15 rename passes, and a deleted entry with no trace still fails",
        requiresCodeChange: true,
      },
      {
        label: "Set GLOSSARY_CARRY_FORWARD_GUARD=false for volume 15",
        touches: [".env"],
        cost: "free",
        risk: "none claimed",
        verify: "the finding disappears",
      },
      {
        label: "Lower PASSING_SCORE so the glossary is accepted",
        touches: [".env"],
        cost: "free",
        verify: "the finding disappears",
      },
    ],
    paths
  );

  assert.strictEqual(answered.allowed.length, 2, "the two legitimate options are offered");
  assert.strictEqual(answered.refused.length, 2, "the two cheap ones are refused");
  assert.ok(answered.refused.every((r) => r.escalateTo.includes("account owner")), "each names where it goes");

  const ticket = readTickets(paths.json).tickets[0];
  assert.strictEqual(ticket.status, "answered");
  assert.strictEqual(ticket.options.length, 2);
  assert.strictEqual(ticket.refusedOptions.length, 2, "refused options are KEPT on the ticket");

  const md = renderTicketMarkdown(ticket);
  assert.ok(md.includes("~~Set GLOSSARY_CARRY_FORWARD_GUARD=false"), "the human file must show what was refused");
  assert.ok(md.includes("goes to: the account owner"), md);

  // Choosing a refused option is refused again, with the reason it was refused.
  const sneaked = recordChoice(id, { optionId: ticket.refusedOptions[0].option.id, reason: "cheapest" }, paths);
  assert.strictEqual(sneaked.written, false);
  assert.ok(sneaked.error.includes("refused"), sneaked.error);
  assert.ok(sneaked.error.includes("account owner"), sneaked.error);

  // A choice with no reason is not a choice.
  const reasonless = recordChoice(id, { optionId: ticket.options[0].id, reason: "" }, paths);
  assert.strictEqual(reasonless.written, false);
  assert.ok(reasonless.error.includes("reason"), reasonless.error);

  const chosen = recordChoice(id, { optionId: ticket.options[0].id, reason: "no code change, and it rebuilds the tail" }, paths);
  assert.ok(chosen.written, chosen.error);
  assert.strictEqual(readTickets(paths.json).tickets[0].status, "chosen");
}

// ─── 8. A ticket closes on the deliverable, not on the finding ────────────────

async function scenarioClosureVocabulary() {
  const paths = await freshTickets("closure");
  const created = createTicket(goodVolume15Ticket(), paths);
  const id = created.ticket.id;

  for (const outcome of ["finding-gone", "resolved", "passed", "no-errors"]) {
    const bad = closeTicket(id, { outcome, note: "the quarantine file is gone" }, paths);
    assert.strictEqual(bad.written, false, `"${outcome}" is not an outcome — it is the absence of a finding`);
    assert.ok(bad.error.includes("deliverable"), bad.error);
  }

  const closed = closeTicket(id, { outcome: "worse", note: "the rebuilt glossary holds 431 rows against 460 before" }, paths);
  assert.ok(closed.written, closed.error);
  const ticket = readTickets(paths.json).tickets[0];
  assert.strictEqual(ticket.status, "closed");
  assert.strictEqual(ticket.closure.outcome, "worse");
  assert.ok(renderTicketMarkdown(ticket).includes("closed worse"));

  assert.strictEqual(openTickets(paths).length, 0, "a closed ticket is not open");
}

// ─── 9. Tickets and the ledger are one system ─────────────────────────────────

async function scenarioTriedComesFromTheLedger() {
  const paths = await freshTickets("ledger-link");
  // Clear the shared ledger so this scenario counts only its own attempts.
  await fs.rm(ledgerPath(), { force: true });

  for (const outcome of ["unchanged", "worse"]) {
    appendLedgerEntry({
      kind: "intervention",
      run: "run-9",
      step: "glossary",
      volume: "15",
      finding: "quarantine-present",
      action: "wipe-and-rerun",
      outcome,
      decidedBy: "manager",
    });
  }

  const tried = triedFromLedger("glossary", "15", "quarantine-present");
  assert.strictEqual(tried.length, 2, "the ledger's attempts are the ticket's evidence of a repeat");
  assert.deepStrictEqual(tried.map((t) => t.outcome), ["unchanged", "worse"]);
  assert.ok(tried.every((t) => t.ledgerId), "each attempt is citable back to a ledger entry");

  // createTicket pulls them in without being told to — the honest default.
  const created = createTicket(goodVolume15Ticket({ run: "run-9" }), paths);
  assert.ok(created.written, created.problems.map((p) => p.message).join(" | "));
  assert.strictEqual(created.ticket.tried.length, 2);
  assert.ok(created.ticket.tried[0].ledgerId.includes("run-9/glossary"), created.ticket.tried[0].ledgerId);

  // A different volume's attempts are not this volume's history.
  assert.strictEqual(triedFromLedger("glossary", "16", "quarantine-present").length, 0);

  // And the ticket is citable from the ledger, which is the loop closing.
  const entry = appendLedgerEntry({
    kind: "intervention",
    run: "run-9",
    step: "glossary",
    volume: "15",
    finding: "quarantine-present",
    action: "open-ticket",
    outcome: "refused",
    decidedBy: "manager",
    ticket: created.ticket.id,
  });
  assert.strictEqual(entry.entry.ticket, created.ticket.id);

  // Has anyone already asked this? (So the same question does not open twice.)
  assert.strictEqual(ticketsFor({ step: "glossary", volume: "15", finding: "quarantine-present" }, paths).length, 1);
  assert.strictEqual(ticketsFor({ step: "glossary", volume: "16", finding: "quarantine-present" }, paths).length, 0);
}

// ─── 10. A corrupt ticket file is never treated as an empty one ───────────────

async function scenarioCorruptTicketFile() {
  const paths = await freshTickets("corrupt");
  await fs.mkdir(path.dirname(paths.json), { recursive: true });
  await fs.writeFile(paths.json, "{ not JSON at all\n", "utf8");

  const read = readTickets(paths.json);
  assert.deepStrictEqual(read.tickets, []);
  assert.ok(read.error && read.error.includes("not valid JSON"), `corruption must be reported: ${read.error}`);

  // And a new ticket is not silently appended to a file nobody can read.
  const created = createTicket(goodVolume15Ticket(), paths);
  assert.ok(created.written, "writing must still work — the file is replaced, not trusted");
  assert.strictEqual(readTickets(paths.json).tickets.length, 1);
}

// ─── 11. The empty state says so plainly ──────────────────────────────────────

async function scenarioNothingToReport() {
  const paths = await freshTickets("empty");
  assert.deepStrictEqual(readTickets(paths.json).tickets, []);
  assert.strictEqual(readTickets(paths.json).error, null, "no tickets yet is the normal state, not a fault");
  const md = renderTicketsMarkdown([]);
  assert.ok(md.includes("No tickets"), md);
}

// ─── 12. The volume-15 incident, end to end ───────────────────────────────────

/**
 * The whole design decision in one scenario: the real complaint, in the shape that would have
 * caused the damage, and in the shape that could not.
 */
async function scenarioVolume15() {
  const paths = await freshTickets("volume15");

  // The demand version: what a manager that states its goal would have written.
  const demand = createTicket(
    goodVolume15Ticket({ question: "Make volume 15's glossary pass. The gate is blocking the run." }),
    paths
  );
  assert.strictEqual(demand.written, false, "the demand that would have led to a weakened guard is refused");

  // The question version.
  const question = createTicket(goodVolume15Ticket(), paths);
  assert.ok(question.written, question.problems.map((p) => p.message).join(" | "));

  // The cheap answer to the demand is not on the menu even if diagnostics offers it.
  const answered = attachOptions(
    question.ticket.id,
    [
      { label: "Set GLOSSARY_CARRY_FORWARD_GUARD=false for volume 15", cost: "free", verify: "the finding disappears" },
      { label: "Add the old spelling back as a second row", cost: "cheap", verify: "the finding disappears" },
      {
        label: "Teach the gate to recognise a renamed row, and pin it with a test in both directions",
        touches: ["ai-client/glossary.js", "ai-client/test/test-glossary-load.js"],
        cost: "expensive",
        risk: "a rename test that is too loose would excuse a real deletion",
        verify: "the volume-15 rename passes; a deleted entry with no trace still fails",
        requiresCodeChange: true,
      },
    ],
    paths
  );

  // The interesting line: the banned filter refuses ONE of these, and it is not the one a human
  // would call the bad fix first. "Add the old spelling back as a second row" does not remove a
  // guard or a finding — it manufactures a duplicate, which is a quality judgment about the
  // deliverable. That is the acceptance test's job (plan §6), not this filter's. The filter's
  // job is narrower and dumber on purpose: it stops the options that make the FINDING disappear.
  assert.strictEqual(answered.allowed.length, 2, "the filter refuses guard-removal, not every bad idea");
  assert.strictEqual(answered.refused.length, 1);
  assert.ok(answered.refused[0].ids.includes("disable-carry-forward-guard"), answered.refused[0].ids.join(","));
  assert.ok(
    answered.allowed.some((o) => o.verify === "the finding disappears"),
    "an option whose only stated verification is 'the finding disappears' survives this filter — " +
      "which is exactly why the before/after comparison of the deliverable has to exist"
  );

  const md = renderTicketsMarkdown(readTickets(paths.json).tickets);
  assert.ok(md.includes("Teach the gate to recognise a renamed row"), md.slice(0, 600));
  assert.ok(md.includes("~~Set GLOSSARY_CARRY_FORWARD_GUARD=false"), md.slice(0, 900));
}

// ─── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });

  await scenarioGoodTicketRoundTrips();
  console.log("tickets: the honest ticket is accepted and reaches the human-readable file");

  await scenarioOutcomeShapedTicketRefused();
  console.log("tickets: a ticket that states the result it wants is refused, and says what to write instead");

  await scenarioCommandsRefused();
  console.log("tickets: a ticket may not give orders — asking about the same mechanism is fine");

  await scenarioBannedQuestionRefused();
  console.log("tickets: a ticket may not ask for a banned thing either");

  await scenarioIncompleteTicket();
  console.log("tickets: no finding, no evidence or no question is not a ticket");

  await scenarioBannedOptions();
  console.log("tickets: every banned option is refused by name, and every legitimate one is allowed");

  await scenarioOptionsStayVisible();
  console.log("tickets: refused options stay visible, and cannot be chosen anyway");

  await scenarioClosureVocabulary();
  console.log("tickets: a ticket closes on the deliverable, never on the absence of a finding");

  await scenarioTriedComesFromTheLedger();
  console.log("tickets: what was already tried is read from the ledger, not from memory");

  await scenarioCorruptTicketFile();
  console.log("tickets: a corrupt ticket file is reported, never treated as empty");

  await scenarioNothingToReport();
  console.log("tickets: an empty queue says so plainly");

  await scenarioVolume15();
  console.log("tickets: the volume-15 incident — the demand is refused, the question is not, and turning off the guard is off the menu");

  console.log("tickets: all checks passed.");
})().catch((err) => {
  console.error(`tickets test failed: ${err.message}`);
  process.exit(1);
});

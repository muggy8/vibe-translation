#!/usr/bin/env node
/**
 * test/test-investigation-bound.js — how many investigations one run may pay for, and what it may
 * not pay for twice.
 *
 * `utils/postmortem/plan/01-finding-levels.md` §5 is the plan this file implements. Slice 2 built the
 * batching (one investigation per finding kind per step, whatever number of volumes it fired in) and
 * explicitly stopped before the bound: nothing capped how many the run could act on, nothing consumed
 * the list, and the ticket key is per volume, so "has this already been asked?" could not be answered
 * across volumes. This file is the bound, the reuse, and the numbers.
 *
 * **Why a bound at all.** The assessment is free by design. A real diagnostics turn is not: the one
 * real diagnosis this repository measured ran **702 seconds, 7.2M prompt tokens, 73 tool calls**
 * (`docs/delivery-layer.md`), and the character-voice stage's whole chapter-by-chapter reading pass for
 * one volume is ~1.14M prompt tokens. One diagnosis turn is therefore about six volumes' worth of
 * reading: three answers cost about as much as reading the entire 17-book series once, and a fourth
 * costs more than reading the series is worth. The ceiling is the number that keeps the investigating
 * half of this layer from costing more than the work it investigates.
 *
 * What is pinned here, in order:
 *
 *   1. **One kind in every volume of a 17-volume fixture is ONE investigation**, not seventeen, and it
 *      is the one the run may pay for.
 *   2. **The ceiling is 3 per run, and what it defers is named** — in the plan a human reads and in the
 *      brief the manager reads. A deferred question is reported as unpaid, never silently dropped.
 *   3. **The real diagnostics path, against the scripted server**: one kind × 17 volumes → **one**
 *      diagnosis turn; a second pass over the same fixture → **zero** new turns, because the answer is
 *      on the ticket and the ticket is the record. The request count is printed, not asserted away.
 *   4. **An answered question does not eat a ceiling slot** — three answered questions and one fresh
 *      one leave the fresh one actionable. A ticket that is open and unanswered reads as `pending`:
 *      it is not asked a second time, no second ticket is written for it, and it spends no slot either.
 *   5. **The gate refuses a second diagnosis of a question this run already has an answer to**, and
 *      names the ticket to read instead.
 *   6. **No environment variable moves the number.** A plausible knob is set and the count does not
 *      change, and the source of the bounded modules reads no new one.
 *   7. **`matchesTicketKey` still carries the volume**, and the anti-spin ledger still counts per
 *      volume. The new door is the volume-free one; the old key is untouched, because the anti-spin
 *      budget is deliberately per volume.
 *   8. **The door has a command behind it** (`delivery.js --open-investigations`), it is idempotent,
 *      it refuses `--no-write`, a mistyped verb is refused by name, and the layer's own after-run
 *      audit knows the verb exists — a verb that exits 0 while the audit expects a plan of record is
 *      a run that reports itself broken for writing a ticket.
 *
 * Fixtures only, and the scripted server only. Nothing here reads the real 17 volumes or the real
 * endpoint (AGENTS.md rule 8, gotcha 69).
 *
 * @module test/test-investigation-bound
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Pin the acceptance thresholds the fixture's rolling-state files are judged against, so the fixture
// is complete whatever this machine's .env says.
process.env.PASSING_SCORE = "70";
process.env.ACCEPTANCE_WINDOW_SIZE = "2";
process.env.ACCEPTANCE_MIN_SAMPLES = "2";
// The diagnostics turn is a tool-calling agent against the scripted server. Pin the hooks directory to
// an empty folder so no `pre-manager.sh` on this machine loads a real model (gotcha 22), and pin the
// window the way test-diagnostics.js does (gotcha 69).
process.env.RESEARCH_ENABLED = "false";
process.env.AI_CONTEXT_WINDOW = "32000";
process.env.AI_MAX_TOKENS = "";
process.env.AI_CLIENT_HOOKS_DIR = "/tmp/opencode/investigation-bound-hooks";

const { PIPELINE_STEPS } = require("../gulpfile");
const resume = require("../utils/resume");
const tickets = require("../utils/tickets");
const manager = require("../utils/manager");
const delivery = require("../delivery");
const diagnostics = require("../utils/diagnostics");
const { appendLedgerEntry, readLedger } = require("../utils/ledger");
const { gateSpin } = require("../delivery/gates");
const { startFakeBackend } = require("./fake-backend");
const { readModuleLayer } = require("./module-layer");

const fx = require("./fixture-series");

const ROOT = path.join(__dirname, "..");
const FIXTURE_ROOT = "/tmp/opencode/investigation-bound";
const RUN = "run-bound-1";

let checks = 0;
/**
 * Count one assertion and run it, so the suite can print how many checks it actually made.
 * @param {boolean|void} condition
 * @param {string} message
 * @returns {void}
 */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}
/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} message
 * @returns {void}
 */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

// ─── Fixture ──────────────────────────────────────────────────────────────────

/**
 * A seventeen-volume series every step finished, with one declared-but-optional output removed from
 * every volume of one or more steps.
 *
 * `missing-expected` is the planted kind on purpose: it is declared **MINOR** in
 * `utils/postmortem/levels.js`, it is emitted by the volume assessment of exactly the step that declares
 * the file, and every file used here is declared `expected` by exactly one step — so planting it cannot
 * accidentally produce a `missing-required` (STOP) finding or a second step's gap.
 *
 * @param {string} label
 * @param {Object<string, string[]>} plants - step -> declared `expected` file names to remove
 * @returns {Promise<{dir: string, ledgerDir: string, volumes: Object[]>}
 */
async function seventeenSeries(label, plants) {
  const f = await fx.completeSeries(label, FIXTURE_ROOT);
  const manifest = JSON.parse(await fs.promises.readFile(path.join(f.dir, "translation-target.json"), "utf8"));
  const volumes = [...manifest.volumes];
  while (volumes.length < 17) {
    const n = String(volumes.length + 1).padStart(2, "0");
    volumes.push({
      folder: `Test Story(${n})`,
      sourceFile: `Test Story(${n})/book.epub`,
      installmentNumber: n,
      title: "Test Story",
      integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose in one headed section, no packaging pages" },
    });
  }
  manifest.volumes = volumes;
  await fs.promises.writeFile(path.join(f.dir, "translation-target.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  for (const v of volumes) {
    const volDir = path.join(f.dir, v.folder);
    await fs.promises.mkdir(volDir, { recursive: true });
    await fs.promises.writeFile(path.join(volDir, "book.epub"), "not really an epub", "utf8");
    for (const { name } of PIPELINE_STEPS) await fx.writeVolumeOutputs(f.dir, v, name);
  }
  // `extract`'s deliverable is a record per volume in the run folder, so a 17-volume fixture has to
  // hold 17 of them or the post-mortem is right to say the step never finished.
  await fx.writeRunOutputs(f.ledgerDir, "extract", volumes);
  await fs.promises.writeFile(
    path.join(f.dir, "translation-report.json"),
    JSON.stringify(
      {
        schema: 1,
        generatedAt: new Date().toISOString(),
        seriesName: "Test Story",
        chapters: volumes.map((v) => ({ volume: v.installmentNumber, folder: v.folder, id: "whole", outcome: "PUBLISHED (verified)" })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  for (const [step, names] of Object.entries(plants)) {
    for (const v of volumes) {
      for (const name of names) {
        await fs.promises.rm(path.join(f.dir, v.folder, name.replace("{installment}", v.installmentNumber)), { force: true });
      }
    }
  }
  return { dir: f.dir, ledgerDir: f.ledgerDir, volumes };
}

/**
 * Read the state and the plan for one fixture in one call.
 * @param {string} seriesDir
 * @returns {Promise<{state: Object, plan: Object}>}
 */
async function triage(seriesDir) {
  const state = await resume.readWorkingState({ seriesDir });
  return { state, plan: resume.planResume(state) };
}

/**
 * The gap findings of one kind across the whole state.
 * @param {Object} state
 * @param {string} kind
 * @returns {number}
 */
function gapCount(state, kind) {
  return (state.stepStates || []).reduce((n, s) => n + (s.gapFindings || []).filter((f) => f.kind === kind).length, 0);
}

/**
 * The investigation entries of one kind (across steps).
 * @param {Object} plan
 * @param {string} [kind]
 * @returns {Object[]}
 */
function investigations(plan, kind) {
  return (plan.investigations || []).filter((i) => !kind || i.kind === kind);
}

/**
 * A diagnosis the banned-option filter allows and the shape check accepts: a cause, options with what
 * they touch / cost / risk / how to check, a recommendation, and a question back.
 * @returns {Object}
 */
function scriptedDiagnosis() {
  return {
    cause:
      "The step wrote the report it is required to write and skipped the optional one: the coverage " +
      "report is produced by a pass that only runs when the term table changed, and for these volumes " +
      "the table did not change, so nothing wrote the file and nothing removed it.",
    options: [
      {
        label: "Re-run the step with the optional report forced",
        touches: ["Test Story(01)/glossary-coverage.md"],
        cost: "cheap",
        risk: "Nothing: it writes a report the step already knows how to write.",
        verify: "The file exists in every volume folder on the next assessment.",
      },
    ],
    recommend: "Re-run the step with the optional report forced",
    questions: ["Is this report meant to exist for a volume whose term table never changed?"],
    read: ["utils/resume/plan.js"],
    ownerNote: "",
  };
}

/**
 * Drive one real diagnostics turn against the scripted server and report how many model requests it
 * made. This is the production path — `diagnoseTicket`, the real agent loop, the production approve
 * gate and tool schemas — not a mock (the way test/test-diagnostics.js drives it).
 *
 * @param {Object} args
 * @param {string} args.ticketId
 * @param {string} args.seriesDir
 * @returns {Promise<{ok: boolean, refused: boolean, error: string|null, requests: number}>}
 */
async function oneDiagnosisTurn({ ticketId, seriesDir }) {
  const backend = await startFakeBackend({
    model: "stub",
    reply: (req) => {
      const toolSteps = req.messages.filter((m) => m.role === "tool").length;
      if (toolSteps === 0) {
        // The role must make a real read for `assertRealToolCalls` to accept the turn.
        return { text: "", toolCalls: [{ name: "readFile", arguments: { filePath: "utils/resume/plan.js" } }] };
      }
      return {
        text: "I read the triage.\n\n```json\n" + JSON.stringify(scriptedDiagnosis()) + "\n```\n",
      };
    },
  });
  backend.pointEnvAt();
  try {
    const result = await diagnostics.diagnoseTicket({ ticketId, seriesDir });
    return {
      ok: result.ok,
      refused: result.refused,
      error: result.error,
      requests: backend.requests.length,
      problems: result.problems || [],
    };
  } finally {
    await backend.close();
  }
}

// ─── 0. The measurement, before anything is asserted ──────────────────────────

/**
 * Part 0: the shape BEFORE the bound, measured rather than asserted.
 *
 * It is measured through `investigationsFor` — the batching door, which is the pre-bound list and is
 * still exported — and through `matchesTicketKey`, which is still the volume-carrying key. Both are
 * unchanged by this slice, so the "before" half of the measurement stays reproducible after the change
 * instead of being a number one run remembered.
 *
 * @returns {Promise<void>}
 */
async function measureToday() {
  const f = await seventeenSeries("measure-today", { glossary: ["glossary-new-terms.json"] });
  const { state, plan } = await triage(f.dir);
  const gaps = gapCount(state, "missing-expected");

  // The pre-bound list: what the triage produced before any ceiling touched it.
  const raw = resume.investigationsFor(state);
  console.log(
    `  MEASURE (before the bound): ${gaps} MINOR finding(s) planted in 17 volumes batch into ${raw.length} ` +
      `investigation(s) — ${(raw[0] && raw[0].step) || "?"}/${(raw[0] && raw[0].kind) || "?"}, ` +
      `occurrences=${(raw[0] && raw[0].occurrences) || "?"}`
  );
  console.log(
    `  MEASURE (before the bound): the entry an investigation used to be = ${JSON.stringify(
      Object.keys(raw[0] || {})
    )} — no status, no ticket, no ceiling, and nothing anywhere said how many of them a run may pay for`
  );
  console.log(
    `  MEASURE (after the bound): plan.investigations total = ${plan.investigations.length}; ` +
      `fields on an entry = ${JSON.stringify(Object.keys(plan.investigations[0] || {}))}; ` +
      `ceiling = ${JSON.stringify(plan.investigationCeiling)}`
  );

  // The gap the ticket door closes: the OLD key carries the volume, so the answered ticket for volume 01
  // does not match the same question about volume 02, and a run could pay for both.
  const paths = tickets.ticketPaths();
  const first = tickets.createTicket(
    { run: RUN, step: "glossary", volume: "01", finding: "missing-expected", question: "Why is the coverage report missing?", evidence: [{ file: "Test Story(01)/glossary-coverage.md", note: "the missing report" }] },
    paths
  );
  tickets.recordDiagnosis(first.ticket.id, scriptedDiagnosis(), paths);
  const second = tickets.createTicket(
    { run: RUN, step: "glossary", volume: "02", finding: "missing-expected", question: "Why is the coverage report missing?", evidence: [{ file: "Test Story(02)/glossary-coverage.md", note: "the missing report" }] },
    paths
  );
  const keyMatch = tickets.matchesTicketKey(first.ticket, { step: "glossary", volume: "02", finding: "missing-expected" });
  const perVolume = tickets.ticketsFor({ step: "glossary", volume: "02", finding: "missing-expected" }, paths);
  const all = tickets.readTickets(paths.json).tickets;
  const verdict = manager.validateManagerAction(
    { action: "diagnose", ticket: second.ticket.id, reason: "ask the team about volume 02" },
    { moves: [], tickets: all, patches: [], plan }
  );
  console.log(
    `  MEASURE (before the bound): the answered ticket ${first.ticket.id} matches volume 02's key: ${keyMatch}. ` +
      `The only ticket that matches volume 02's key is the new one itself (${perVolume.map((t) => t.id).join(", ")}), ` +
      `so the same question about the next book was a fresh move with no answer on it.`
  );
  console.log(
    `  MEASURE (after the bound): the gate now says a second diagnosis of ${second.ticket.id} is ` +
      `${verdict.allowed ? "ALLOWED — the gap is still open" : `refused (${verdict.kind})`}.`
  );
}

// ─── 1. One kind in every volume is one investigation, and it is actionable ───

/**
 * @returns {Promise<void>}
 */
async function testOneKindIsOneInvestigation() {
  const f = await seventeenSeries("one-kind-17-volumes", { glossary: ["glossary-new-terms.json"] });
  const { state, plan } = await triage(f.dir);

  same(gapCount(state, "missing-expected"), 17, "the fixture really planted the kind in every volume");
  same(plan.verdict, "nothing-to-do", `a MINOR finding still does not open the run: ${plan.headline}`);

  const inv = investigations(plan, "missing-expected");
  same(inv.length, 1, `17 occurrences of one kind on one step are ONE investigation: ${JSON.stringify(plan.investigations.map((i) => [i.step, i.kind, i.status]))}`);
  same(inv[0].occurrences, 17, "and the batch still counts every volume it fired in");
  same(inv[0].volumes.length, 17, "and names all of them");
  same(inv[0].level, "MINOR", "with its level");

  same(inv[0].status, "actionable", "a fresh question is the one the run may pay for");
  same(inv[0].costsTurn, true, "and it is the one that costs a model turn");
  same(inv[0].ticketId, null, "with no ticket yet");

  same(plan.investigationCeiling.maxPerRun, 3, "the ceiling is 3 per run");
  same(plan.investigationCeiling.actionable, 1, "one of them may be paid for");
  same(plan.investigationCeiling.deferred, 0, "and none is deferred");

  console.log("  one kind × 17 volumes: 17 findings → 1 investigation → 1 turn the run may pay for");
}

// ─── 2. The ceiling, and the deferred ones are named ──────────────────────────

/**
 * @returns {Promise<void>}
 */
async function testTheCeilingNamesWhatItDefers() {
  const f = await seventeenSeries("ceiling", {
    glossary: ["glossary-new-terms.json"],
    "character-voice": ["character-voice-new.json"],
    "style-guide": ["style-guide-new.json"],
    polish: ["polish-qa.md"],
  });
  const { state, plan } = await triage(f.dir);

  same(gapCount(state, "missing-expected"), 68, "one kind on four steps × 17 volumes are planted");
  const inv = investigations(plan, "missing-expected");
  same(inv.length, 4, `four distinct (kind, step) pairs produce four investigations: ${JSON.stringify(inv.map((i) => [i.step, i.files[0]]))}`);

  const actionable = inv.filter((i) => i.status === "actionable");
  const deferred = inv.filter((i) => i.status === "deferred");
  same(actionable.length, 3, `the run acts on at most 3: ${JSON.stringify(actionable.map((i) => [i.step, i.files[0]]))}`);
  same(deferred.length, 1, `and the rest are deferred, not dropped: ${JSON.stringify(deferred.map((i) => [i.step, i.files[0]]))}`);
  for (const d of deferred) {
    same(d.costsTurn, false, "a deferred investigation costs nothing this run");
    ok(d.deferredBecause && /3/.test(d.deferredBecause), `the deferral says why: ${d.deferredBecause}`);
  }
  same(plan.investigationCeiling.actionable, 3, "the plan counts them");
  same(plan.investigationCeiling.deferred, 1, "including the one it did not pay for");

  // Named in the plan a human reads.
  for (const d of deferred) {
    ok(plan.markdown.includes(d.files[0]), `the deferred question names ${d.files[0]} in the plan: ${plan.markdown.slice(-1200)}`);
  }
  ok(/not paid for|deferred/i.test(plan.markdown), `the plan says plainly that some were not paid for: ${plan.markdown.slice(-1200)}`);

  // And in the brief the manager reads.
  const brief = manager.renderManagerBrief({ plan, moves: [], tickets: [], patches: [] });
  for (const d of deferred) {
    ok(brief.includes(d.files[0]), `the manager's brief names the deferred question (${d.files[0]}): ${brief.slice(-1500)}`);
  }
  ok(/not paid for this run|not paid for/i.test(brief), `and says so in the brief: ${brief.slice(-1500)}`);

  console.log("  ceiling: 4 questions proposed, 3 actionable, 1 named as unanswered in the plan and the brief");
}

// ─── 3. The real turn: one diagnosis, then zero ───────────────────────────────

/**
 * @returns {Promise<void>}
 */
async function testTheAnswerIsReusedNotRepaid() {
  const f = await seventeenSeries("reuse-the-answer", { glossary: ["glossary-new-terms.json"] });
  const { state, plan } = await triage(f.dir);
  const run = delivery.runIdFor(state);

  // The run's own door: it opens a ticket for each investigation it may act on, and never a second one
  // for a question already open.
  const opened = delivery.openInvestigationTickets({ plan, state, run });
  same(opened.opened.length, 1, `one actionable investigation opens exactly one ticket: ${JSON.stringify(opened)}`);
  same(opened.tickets.length, 1, "and the ticket is named");
  const ticketId = opened.tickets[0].id;

  // Before anybody answers it, the question is already ASKED. A re-triage must not treat it as a fresh
  // one and spend a second ceiling slot (or a second ticket) on it.
  const waiting = await triage(f.dir);
  const waitingInv = investigations(waiting.plan, "missing-expected");
  same(waitingInv.length, 1, "the open ticket does not split the question in two");
  same(waitingInv[0].status, "pending", `an unanswered ticket reads as pending: ${JSON.stringify(waitingInv[0])}`);
  same(waitingInv[0].ticketId, ticketId, "and names the ticket that is waiting");
  same(waiting.plan.investigationCeiling.actionable, 0, "it takes no ceiling slot — the slot is already spent on that ticket");
  same(waiting.plan.investigationCeiling.pending, 1, "and is counted as waiting");
  const dupe = delivery.openInvestigationTickets({ plan: waiting.plan, state: waiting.state, run });
  same(dupe.opened.length, 0, `the door opens no second ticket for it: ${JSON.stringify(dupe.skipped)}`);

  const first = await oneDiagnosisTurn({ ticketId, seriesDir: f.dir });
  ok(first.ok, `the real diagnostics turn answered it: ${first.error}\n${(first.problems || []).map((p) => p.message).join("\n")}`);
  const firstRequests = first.requests;
  console.log(`  MEASURE: pass 1 — 1 diagnosis turn, ${firstRequests} model request(s) on the scripted server`);

  // The run reads the state again. The answer is on the ticket, so the question is not fresh any more.
  const again = await triage(f.dir);
  const inv = investigations(again.plan, "missing-expected");
  same(inv.length, 1, "still one investigation");
  same(inv[0].status, "answered", `and it is answered, not actionable: ${JSON.stringify(inv[0])}`);
  same(inv[0].ticketId, ticketId, "naming the ticket that carries the answer");
  same(inv[0].costsTurn, false, "and costing nothing");
  same(again.plan.investigationCeiling.actionable, 0, "it does not count against the ceiling");
  same(again.plan.investigationCeiling.answered, 1, "and is counted as answered");
  ok(again.plan.markdown.includes(ticketId), `the plan names the ticket it reuses: ${again.plan.markdown.slice(-1200)}`);

  // The door opens nothing new, and the diagnostics role refuses to re-ask the ticket it already answered.
  const second = delivery.openInvestigationTickets({ plan: again.plan, state: again.state, run });
  same(second.opened.length, 0, `a second pass opens no ticket: ${JSON.stringify(second)}`);
  const askable = diagnostics.diagnosisIsAskable(
    tickets.readTickets().tickets.find((t) => t.id === ticketId),
    { ticketId }
  );
  same(askable.askable, false, `and the answered ticket is not askable again: ${askable.error}`);
  console.log(`  MEASURE: pass 2 — 0 diagnosis turns, 0 model request(s); the answer is reused from ${ticketId}`);
}

// ─── 4. An answered question does not starve a live one ───────────────────────

/**
 * @returns {Promise<void>}
 */
async function testAnsweredQuestionsDoNotEatTheCeiling() {
  const f = await seventeenSeries("answered-not-starving", {
    glossary: ["glossary-new-terms.json"],
    "character-voice": ["character-voice-new.json"],
    "style-guide": ["style-guide-new.json"],
    polish: ["polish-qa.md"],
  });
  const paths = tickets.ticketPaths();
  // Three of the four questions were already asked and answered in this run.
  for (const [step, file] of [
    ["glossary", "glossary-new-terms.json"],
    ["character-voice", "character-voice-new.json"],
    ["style-guide", "style-guide-new.json"],
  ]) {
    const t = tickets.createTicket(
      { run: RUN, step, finding: "missing-expected", volume: null, question: `Why is ${file} missing from every volume?`, evidence: [{ file: `Test Story(01)/${file}`, note: "the missing report" }] },
      paths
    );
    tickets.recordDiagnosis(t.ticket.id, scriptedDiagnosis(), paths);
  }

  const { plan } = await triage(f.dir);
  const inv = investigations(plan, "missing-expected");
  same(inv.length, 4, "four questions are proposed");
  same(inv.filter((i) => i.status === "answered").length, 3, "three are answered");
  const live = inv.filter((i) => i.status === "actionable");
  same(live.length, 1, `the fresh one is still actionable — an answered question does not take its slot: ${JSON.stringify(inv.map((i) => [i.step, i.files[0], i.status]))}`);
  same(live[0].step, "polish", "and it is the one nobody has asked about");
  same(plan.investigationCeiling.deferred, 0, "nothing is deferred, because only one question is fresh");

  console.log("  3 answered + 1 fresh → the fresh one is actionable, 0 deferred");
}

/**
 * A question somebody already asked (and nobody answered) is neither re-asked nor charged to the ceiling.
 *
 * @returns {Promise<void>}
 */
async function testAnOpenTicketIsNotAskedTwice() {
  const f = await seventeenSeries("pending-not-reasked", {
    glossary: ["glossary-new-terms.json"],
    "character-voice": ["character-voice-new.json"],
    "style-guide": ["style-guide-new.json"],
    polish: ["polish-qa.md"],
  });
  const paths = tickets.ticketPaths();
  const open = tickets.createTicket(
    { run: RUN, step: "glossary", volume: null, finding: "missing-expected", question: "Why is glossary-new-terms.json missing from every volume?", evidence: [{ file: "Test Story(01)/glossary-new-terms.json", note: "the missing report" }] },
    paths
  );
  ok(open.written, `the unanswered ticket was written: ${JSON.stringify(open.problems)}`);
  const answered = tickets.createTicket(
    { run: RUN, step: "character-voice", volume: null, finding: "missing-expected", question: "Why is character-voice-new.json missing from every volume?", evidence: [{ file: "Test Story(01)/character-voice-new.json", note: "the missing report" }] },
    paths
  );
  tickets.recordDiagnosis(answered.ticket.id, scriptedDiagnosis(), paths);

  const { plan } = await triage(f.dir);
  const inv = investigations(plan, "missing-expected");
  same(inv.length, 4, "four questions are proposed");
  same(inv.filter((i) => i.status === "pending").length, 1, "one is already asked and unanswered");
  same(inv.filter((i) => i.status === "answered").length, 1, "one is already answered");
  same(inv.filter((i) => i.status === "actionable").length, 2, "and the two nobody has asked are both actionable");
  same(plan.investigationCeiling.deferred, 0, "nothing is deferred: neither an open ticket nor an answer spends a slot");

  // And the door does not write a second copy of the question that is already waiting.
  const opened = delivery.openInvestigationTickets({ plan, state: await resume.readWorkingState({ seriesDir: f.dir }), run: RUN });
  same(opened.opened.length, 2, `only the two unanswered fresh questions get a ticket: ${JSON.stringify(opened.opened.map((t) => [t.step, t.id]))}`);
  const glossarySkip = opened.skipped.find((s) => s.step === "glossary");
  ok(glossarySkip, `the question already on the channel is named as not opened: ${JSON.stringify(opened.skipped)}`);
  same(glossarySkip.status, "pending", "and it is named with its status");
  same(glossarySkip.ticketId, open.ticket.id, "and the ticket that is already waiting");
  const all = tickets.readTickets(paths.json).tickets.filter((t) => t.step === "glossary" && t.finding === "missing-expected");
  same(all.length, 1, `still exactly one ticket for glossary / missing-expected: ${JSON.stringify(all.map((t) => t.id))}`);
  const secondPass = delivery.openInvestigationTickets({ plan, state: await resume.readWorkingState({ seriesDir: f.dir }), run: RUN });
  same(secondPass.opened.length, 0, `a second pass opens nothing: ${secondPass.note}`);

  console.log("  1 pending + 1 answered + 2 fresh → 2 tickets opened, 0 duplicates, 0 deferred");
}

/**
 * An answer the series already paid for is still read for free — and the plan says which run paid for it.
 *
 * @returns {Promise<void>}
 */
async function testAnAnswerFromAnEarlierRunIsNamed() {
  const f = await seventeenSeries("cross-run-answer", { glossary: ["glossary-new-terms.json"] });
  // Give the state a run of its own, so "is this ticket mine?" is a question with an answer.
  appendLedgerEntry({ kind: "intervention", run: "run-current", step: "glossary", volume: "01", finding: "wrong-shape", action: "wipe-and-cascade", outcome: "unchanged" });
  const paths = tickets.ticketPaths();
  const older = tickets.createTicket(
    { run: "run-earlier", step: "glossary", volume: null, finding: "missing-expected", question: "Why is glossary-new-terms.json missing from every volume?", evidence: [{ file: "Test Story(01)/glossary-new-terms.json", note: "the missing report" }] },
    paths
  );
  tickets.recordDiagnosis(older.ticket.id, scriptedDiagnosis(), paths);

  const { state, plan } = await triage(f.dir);
  same(state.run, "run-current", "the state has a run of its own to compare against");
  const inv = investigations(plan, "missing-expected");
  same(inv.length, 1, "still one question");
  same(inv[0].status, "answered", `an answer from an earlier run is still an answer: ${JSON.stringify(inv[0])}`);
  same(inv[0].inRun, false, "and the entry says this run is not the one that paid for it");
  same(inv[0].ticketRun, "run-earlier", "naming the run that did");
  same(plan.investigationCeiling.actionable, 0, "and it still costs nothing and takes no place");
  ok(plan.markdown.includes("run-earlier"), `the plan says which run wrote the answer: ${plan.markdown.slice(-900)}`);

  // The gate's refusal is same-run only: this run's own ticket is still askable, so the escalation
  // ladder is not narrowed by an answer some earlier run happened to have.
  const fresh = tickets.createTicket(
    { run: "run-current", step: "glossary", volume: "02", finding: "missing-expected", question: "Why is glossary-new-terms.json missing from volume 02 specifically?", evidence: [{ file: "Test Story(02)/glossary-new-terms.json", note: "the missing report" }] },
    paths
  );
  const verdict = manager.validateManagerAction(
    { action: "diagnose", ticket: fresh.ticket.id, reason: "this run asks its own question" },
    { moves: [], tickets: tickets.readTickets(paths.json).tickets, patches: [], plan }
  );
  same(verdict.allowed, true, `a ticket of the current run is not refused by an earlier run's answer: ${verdict.why}`);

  console.log("  an answer from an earlier run is reused for free, and the plan names the run that paid for it");
}

// ─── 5. The gate refuses a second diagnosis of an answered question ───────────

/**
 * @returns {Promise<void>}
 */
async function testTheGateRefusesTheSecondDiagnosis() {
  const f = await seventeenSeries("gate-refusal", { glossary: ["glossary-new-terms.json"] });
  const paths = tickets.ticketPaths();
  const answered = tickets.createTicket(
    { run: RUN, step: "glossary", volume: "01", finding: "missing-expected", question: "Why is the coverage report missing?", evidence: [{ file: "Test Story(01)/glossary-coverage.md", note: "the missing report" }] },
    paths
  );
  tickets.recordDiagnosis(answered.ticket.id, scriptedDiagnosis(), paths);
  const duplicate = tickets.createTicket(
    { run: RUN, step: "glossary", volume: "02", finding: "missing-expected", question: "Why is the coverage report missing?", evidence: [{ file: "Test Story(02)/glossary-coverage.md", note: "the missing report" }] },
    paths
  );
  const otherRun = tickets.createTicket(
    { run: "run-bound-2", step: "glossary", volume: "03", finding: "missing-expected", question: "Why is the coverage report missing?", evidence: [{ file: "Test Story(03)/glossary-coverage.md", note: "the missing report" }] },
    paths
  );

  const all = tickets.readTickets(paths.json).tickets;
  const verdict = manager.validateManagerAction(
    { action: "diagnose", ticket: duplicate.ticket.id, reason: "ask about volume 02 as well" },
    { moves: [], tickets: all, patches: [], plan: null }
  );
  same(verdict.allowed, false, "a second diagnosis of a question this run already has an answer to is refused");
  ok(verdict.why.includes(answered.ticket.id), `and it names the ticket to read instead: ${verdict.why}`);
  ok(/diagnose\.js --reask/.test(verdict.why), `and names the door that is the account owner's call: ${verdict.why}`);

  // The rule is across tickets in ONE run. A new run's own ticket is still diagnosable — the escalation
  // ladder is not narrowed by this gate.
  const freshRun = manager.validateManagerAction(
    { action: "diagnose", ticket: otherRun.ticket.id, reason: "a new run asks it again" },
    { moves: [], tickets: all, patches: [], plan: null }
  );
  same(freshRun.allowed, true, `a ticket from another run is not refused by this rule: ${freshRun.why}`);

  // The existing per-ticket rule is untouched.
  const sameTicket = manager.validateManagerAction(
    { action: "diagnose", ticket: answered.ticket.id, reason: "ask the same ticket again" },
    { moves: [], tickets: all, patches: [], plan: null }
  );
  same(sameTicket.allowed, false, "the existing already-answered refusal still fires");
  same(sameTicket.kind, "already-answered", "with its existing kind");

  console.log("  the gate refuses a second diagnosis of an answered (step, kind) and names the ticket");
}

// ─── 6. No environment knob ───────────────────────────────────────────────────

/**
 * @returns {Promise<void>}
 */
async function testNoEnvironmentKnob() {
  const f = await seventeenSeries("no-knob", {
    glossary: ["glossary-new-terms.json"],
    "character-voice": ["character-voice-new.json"],
    "style-guide": ["style-guide-new.json"],
    polish: ["polish-qa.md"],
  });

  const before = await triage(f.dir);
  const base = before.plan.investigationCeiling;

  // Every plausible name somebody might reach for. None of them is read, so none of them moves anything.
  for (const name of [
    "MAX_INVESTIGATIONS_PER_RUN",
    "INVESTIGATIONS_MAX_PER_RUN",
    "RESUME_MAX_INVESTIGATIONS",
    "DELIVERY_MAX_INVESTIGATIONS",
    "INVESTIGATION_CEILING",
    "INVESTIGATIONS_ENABLED",
    "DELIVERY_MAX_INTERVENTIONS",
  ]) {
    process.env[name] = name === "INVESTIGATIONS_ENABLED" ? "false" : "99";
  }
  const after = await triage(f.dir);
  same(after.plan.investigationCeiling, base, "no environment variable moves the bound: the same fixture gives the same counts");
  same(after.plan.investigations.filter((i) => i.status === "actionable").length, 3, "and the same three actionable questions");
  for (const name of Object.keys(process.env)) {
    if (/INVESTIGATION/i.test(name)) delete process.env[name];
  }
  delete process.env.DELIVERY_MAX_INTERVENTIONS;

  // The bound is a constant in a closed path, and it is frozen so importing it is not the same as being
  // able to turn it.
  ok(Object.isFrozen(resume.INVESTIGATION_BOUND), "the bound is frozen");
  let turned = false;
  try {
    (() => {
      "use strict";
      resume.INVESTIGATION_BOUND.maxPerRun = 99;
    })();
  } catch {
    turned = true;
  }
  ok(turned, "a process that tries to raise the ceiling at runtime is refused, not quietly allowed");
  same(resume.INVESTIGATION_BOUND.maxPerRun, 3, "and the number is still 3");

  // And the source reads no new variable. `SERIES_LOCATION` and `DELIVERY_MAX_INTERVENTIONS` are the two
  // the resume layer already read; `INDEX_RUN_ID` is the run identity the ledger already uses, not a dial.
  const layer = readModuleLayer(ROOT, "utils/resume.js", "utils/resume");
  const names = new Set();
  for (const m of layer.matchAll(/process\.env\.([A-Z_0-9]+)/g)) names.add(m[1]);
  same(
    [...names].sort(),
    ["DELIVERY_MAX_INTERVENTIONS", "SERIES_LOCATION"],
    "the resume layer still reads exactly the two environment variables it already read"
  );
  const ticketLayer = readModuleLayer(ROOT, "utils/tickets.js", "utils/tickets");
  ok(
    !/process\.env\.[A-Z_0-9]*(INVESTIGATION|ASKED|CEILING)[A-Z_0-9]*/.test(ticketLayer),
    "the ticket door adds no knob either"
  );

  console.log("  no environment knob: nine plausible dials set, the counts unmoved, the table frozen");
}

// ─── 7. The old key still carries the volume ──────────────────────────────────

/**
 * @returns {Promise<void>}
 */
async function testTheTicketKeyStillCarriesTheVolume() {
  const paths = { json: "/tmp/opencode/investigation-bound/key/tickets.json", markdown: null };
  fs.mkdirSync(path.dirname(paths.json), { recursive: true });
  fs.writeFileSync(paths.json, JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), tickets: [] }, null, 2) + "\n", "utf8");

  const t = tickets.createTicket(
    { run: RUN, step: "glossary", volume: "15", finding: "quarantine-present", question: "Why did the gate refuse this file?", evidence: [{ file: "Test Story(15)/glossary.md.rejected", note: "the gate's account" }] },
    paths
  );
  ok(t.written, JSON.stringify(t.problems));

  // `matchesTicketKey` is unchanged: the volume is part of the key, and the anti-spin budget is
  // deliberately per volume.
  same(tickets.matchesTicketKey(t.ticket, { step: "glossary", volume: "15", finding: "quarantine-present" }), true, "the same (step, volume, finding) still matches");
  same(tickets.matchesTicketKey(t.ticket, { step: "glossary", volume: "16", finding: "quarantine-present" }), false, "a different volume still does NOT match — the key did not lose the volume");
  same(tickets.matchesTicketKey(t.ticket, { step: "glossary", finding: "quarantine-present" }), false, "and a key with no volume still does not match a ticket that has one");
  same(tickets.ticketsFor({ step: "glossary", volume: "15", finding: "quarantine-present" }, paths).length, 1, "ticketsFor is unchanged");
  same(tickets.ticketsFor({ step: "glossary", volume: "16", finding: "quarantine-present" }, paths).length, 0, "per volume, as before");

  // The new door is the volume-free one, and it is the only thing that changed.
  const asked = tickets.investigationsAlreadyAsked({ run: RUN, step: "glossary", kind: "quarantine-present" }, paths);
  same(asked.asked, true, "the investigation door sees the ticket whatever volume it names");
  same(asked.answered, false, "and says it is not answered yet");
  same(asked.pending, true, "and says somebody already asked it");

  // The anti-spin ledger still counts per volume: two failed attempts on volume 15 do not freeze the
  // same action on volume 16.
  process.env.INDEX_RUN_ID = "run-key-1";
  for (const volume of ["15", "15"]) {
    appendLedgerEntry({ kind: "intervention", run: "run-key-1", step: "glossary", volume, finding: "wrong-shape", action: "wipe-and-cascade", outcome: "unchanged" });
  }
  const sameVolume = gateSpin({ step: "glossary", finding: "wrong-shape", actionName: "wipe-and-cascade", fromVolume: "15", countsAsIntervention: true }, "run-key-1");
  const otherVolume = gateSpin({ step: "glossary", finding: "wrong-shape", actionName: "wipe-and-cascade", fromVolume: "16", countsAsIntervention: true }, "run-key-1");
  same(sameVolume.allowed, false, "the third attempt against the same volume is refused, as before");
  same(otherVolume.allowed, true, "and a different volume is still its own question: " + otherVolume.why);
  ok(readLedger().entries.length >= 2, "the ledger itself is unchanged");
  delete process.env.INDEX_RUN_ID;

  console.log("  matchesTicketKey and the anti-spin budget are unchanged; only the new door ignores volume");
}

// ─── 8. The command behind the door ───────────────────────────────────────────

/**
 * Run `delivery.js` as a child against one throwaway fixture and report what it returned.
 *
 * @param {string} seriesDir
 * @param {string[]} args
 * @returns {Promise<{code: number, out: string}>}
 */
function runDeliveryCli(seriesDir, args) {
  const { execFileSync } = require("child_process");
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, "delivery.js"), ...args, `--series=${seriesDir}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, POSTMORTEM_DIR: path.join(seriesDir, ".postmortem"), SERIES_LOCATION: seriesDir },
    });
    return { code: 0, out };
  } catch (/** @type {any} */ err) {
    return { code: err.status ?? 1, out: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

/**
 * The door has a command behind it, the command is idempotent, and the layer's own after-run audit
 * knows the verb exists (a verb that exits 0 while the audit expects a plan of record is a run that
 * reports itself broken for writing a ticket).
 *
 * @returns {Promise<void>}
 */
async function testTheCommandBehindTheDoor() {
  const f = await seventeenSeries("cli-verb", { glossary: ["glossary-new-terms.json"] });
  const first = runDeliveryCli(f.dir, ["--open-investigations"]);
  same(first.code, 0, `the verb ran: ${first.out}`);
  ok(/opened 1 investigation ticket\(s\)/.test(first.out), `it opened exactly one: ${first.out.split("\n").slice(-6).join("\n")}`);
  ok(/after-run audit — CLEAN/.test(first.out), `and the layer's own audit agrees nothing is missing: ${first.out.split("\n").slice(-4).join("\n")}`);

  const second = runDeliveryCli(f.dir, ["--open-investigations"]);
  same(second.code, 0, `the second run ran: ${second.out}`);
  ok(/opened 0 investigation ticket\(s\)/.test(second.out), `it opened nothing the second time: ${second.out.split("\n").slice(-5).join("\n")}`);
  ok(/not opened: glossary \/ missing-expected \(pending\)/.test(second.out), `and it says why, naming the ticket: ${second.out.split("\n").slice(-5).join("\n")}`);
  const onDisk = tickets.readTickets(path.join(f.dir, ".postmortem", "tickets.json")).tickets;
  same(onDisk.length, 1, `the channel holds exactly one ticket after both runs: ${JSON.stringify(onDisk.map((t) => t.id))}`);
  same(onDisk[0].volume, null, "and an investigation ticket is about the step, not one volume");

  const rehearsal = runDeliveryCli(f.dir, ["--open-investigations", "--no-write"]);
  same(rehearsal.code, 2, `--no-write together with a written question is refused: ${rehearsal.out}`);
  const mistyped = runDeliveryCli(f.dir, ["--open-investigation"]);
  same(mistyped.code, 2, `a mistyped verb is refused, not ignored: ${mistyped.out.split("\n").slice(-2).join("\n")}`);
  ok(/--open-investigations/.test(mistyped.out), `and the refusal names the verb that does exist: ${mistyped.out.split("\n").slice(-2).join("\n")}`);

  console.log("  the command behind the door: 1 ticket, then 0, and the after-run audit stays clean");
}


// ─── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  fs.mkdirSync(process.env.AI_CLIENT_HOOKS_DIR, { recursive: true });
  await measureToday();
  await testOneKindIsOneInvestigation();
  await testTheCeilingNamesWhatItDefers();
  await testTheAnswerIsReusedNotRepaid();
  await testAnsweredQuestionsDoNotEatTheCeiling();
  await testAnOpenTicketIsNotAskedTwice();
  await testAnAnswerFromAnEarlierRunIsNamed();
  await testTheGateRefusesTheSecondDiagnosis();
  await testNoEnvironmentKnob();
  await testTheTicketKeyStillCarriesTheVolume();
  await testTheCommandBehindTheDoor();
  console.log(`OK: ${checks} checks on the bound on investigations, the ticket as the record, and the ceiling.`);
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

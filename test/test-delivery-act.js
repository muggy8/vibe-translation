/**
 * test/test-delivery-act.js — act mode: the gates, and what executing actually does.
 *
 * `delivery.js --mode=act` runs the plan it wrote. That is the first place in this pipeline
 * where an agent gets to wipe a volume's accepted work and start a step, so what is pinned here
 * is not the shape of a report but the three things that have to be true before a file is
 * deleted: the action is on the menu, nobody else is writing, and this has not already failed.
 *
 * Every scenario uses a throwaway fixture series with a committed plan of record and its own
 * `POSTMORTEM_DIR`, because a triage that reads "the" series reads whatever `.env` says — which
 * on this machine is the live 17 volumes (gotcha 69). Scenario 5 goes further and pins the
 * child process's `SERIES_LOCATION` too: act mode runs a real step, so a fixture that only
 * looked like a fixture would have run the glossary stage against the real series.
 *
 * The scenarios:
 *   1. an action that is not on the menu is refused **at execution time**, by name, and nothing
 *      is wiped — the menu check is not only a property of how the plan was written;
 *   2. a run already in progress: act mode refuses to start anything, leaves the lock alone,
 *      and deletes nothing (gotcha 66);
 *   3. a step that has spent its per-step intervention budget is refused, and the refusal opens
 *      a ticket and is written to the ledger rather than passing silently;
 *   4. the third identical attempt is refused by the anti-spin gate and becomes a ticket — the
 *      shape volume 15 would have spun in forever (gotcha 68);
 *   4b. when the resume point itself is a ticket, the steps listed after it are NOT run: they are
 *      conditional on the ticket being answered, and running them spends a real run's worth of
 *      model calls on a foundation that was not fixed;
 *   5. an action that passes every gate really runs: the declared files are wiped, a real
 *      `index.js` child runs the step, the outcome is judged by comparing the deliverable before
 *      and after, and the ledger records it — including the half the old per-volume count could
 *      not see, which is that a rehearsal which deletes a glossary and rebuilds nothing made the
 *      deliverable **worse**, not merely unchanged;
 *   6. when the step does rebuild the volume, the outcome is `improved` and the next triage says
 *      there is nothing left to do;
 *   7. the planted "fix" that removes the finding while shrinking the glossary: the step finishes,
 *      the next triage reports nothing to do, and the ledger records damage — the case
 *      `utils/tickets.js` deliberately does not ban, which is why the acceptance test is what has
 *      to catch it (gotcha 70);
 *   8. a ticket closes on the same comparison act mode writes to the ledger, and closing one as
 *      `finding-gone` is still refused.
 *
 * Stubbing, and which half is real: scenarios 1–4 never reach execution, so they use no stub at
 * all. Scenario 5 spawns the real step runner with `--dry-run` (no model call, no artifacts) —
 * which is exactly the point of that scenario: the plumbing is real, nothing is rebuilt, and the
 * honest verdict is the damage the wipe did. Scenarios 6–8 stand in for the *pipeline* (the
 * injected runner writes the files the glossary stage would have written) because the thing under
 * test is whether act mode notices what a rebuild did to the deliverable, not whether the glossary
 * stage can rebuild one — that is `test/test-pipeline-loop.js`'s job.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");
const { PIPELINE_STEPS } = require("../gulpfile");
const resume = require("../utils/resume");
const delivery = require("../delivery");
const { appendLedgerEntry, readLedger } = require("../utils/ledger");
const { createTicket, closeTicket, readTickets } = require("../utils/tickets");
const { measureDeliverable } = require("../utils/delivery-verify");
const { runLockPath } = require("../utils/runlock");

const FIXTURES = path.resolve("/tmp/opencode/delivery-act-tests");
const RUN = "run-act";

// ─── Fixture pieces (same rules as test-resume.js, with a source a step can read) ──

const TABLE = `# Glossary

| Term | Rendering | Notes |
|---|---|---|
| 主人公 | protagonist | fixture |
`;

const DOC = `# Report

## Findings

- nothing wrong here
`;

const PASS_DOC = `${DOC}

**PASS**
`;

/** A book the glossary stage can actually open: plain text, no model needed to read it. */
const SOURCE = `テスト物語

第一章 出会い

主人公は教室で彼女出会った。
「お前だけかよ」と彼女は言った。
主人公は答えに詰まった。

第二章 約束

翌日、二人は屋上で約束した。
「絶対に変えない」と彼女は言った。
`;

/**
 * @param {string} name
 * @param {string} shape
 * @returns {string}
 */
function contentFor(name, shape) {
  if (name === "consistency-report.md") return PASS_DOC;
  if (name.endsWith("-rolling-state.json")) {
    return JSON.stringify({ results: [80, 85], acceptedBy: "rolling-window", lastCheckedAt: new Date().toISOString() }, null, 2);
  }
  if (name === "chapters.json") return "[]\n";
  if (shape === "table") return TABLE;
  if (shape === "json") return JSON.stringify({ fixture: true }, null, 2) + "\n";
  if (shape === "document") return DOC;
  return "fixture\n";
}

/**
 * A two-volume series with a committed plan of record and readable plain-text sources.
 * @param {string} label
 */
async function fixtureSeries(label) {
  const dir = path.join(FIXTURES, label);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  process.env.POSTMORTEM_DIR = path.join(dir, ".postmortem");
  process.env.INDEX_RUN_ID = RUN;
  await fs.promises.mkdir(process.env.POSTMORTEM_DIR, { recursive: true });

  const volumes = [
    { folder: "Test Story(01)", installmentNumber: "01" },
    { folder: "Test Story(02)", installmentNumber: "02" },
  ];
  for (const v of volumes) {
    const volDir = path.join(dir, v.folder);
    await fs.promises.mkdir(volDir, { recursive: true });
    await fs.promises.writeFile(path.join(volDir, "book.txt"), SOURCE, "utf8");
  }

  await fs.promises.writeFile(
    path.join(dir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: dir,
        seriesName: "Test Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test-delivery-act.js",
        generatedAt: new Date().toISOString(),
        discovery: {
          summary: "fixture",
          confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
          evidence: ["two books"],
          excluded: [],
        },
        volumes: volumes.map((v) => ({
          folder: v.folder,
          sourceFile: `${v.folder}/book.txt`,
          installmentNumber: v.installmentNumber,
          title: "Test Story",
          integrity: {
            isNarrative: true,
            confidence: 0.9,
            basis: "fixture: continuous prose in one headed section, no packaging pages",
          },
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return { dir, volumes };
}

/**
 * @param {string} seriesDir
 * @param {{folder: string, installmentNumber: string}} volume
 * @param {string} step
 */
async function writeVolumeOutputs(seriesDir, volume, step) {
  const spec = STEP_ARTIFACT_SPECS[step];
  if (!spec || !spec.perVolume) return;
  const volDir = path.join(seriesDir, volume.folder);
  await fs.promises.mkdir(volDir, { recursive: true });
  for (const e of spec.volume) {
    const name = e.name.replace("{installment}", volume.installmentNumber);
    await fs.promises.writeFile(path.join(volDir, name), contentFor(name, e.shape), "utf8");
  }
}

/**
 * @param {string} seriesDir
 * @param {string} step
 */
async function writeSeriesOutputs(seriesDir, step) {
  const spec = STEP_ARTIFACT_SPECS[step];
  if (!spec) return;
  for (const e of spec.series || []) {
    if (e.name === "translation-target.json") continue; // the plan of record is laid out above
    await fs.promises.writeFile(path.join(seriesDir, e.name), contentFor(e.name, e.shape), "utf8");
  }
}

/** A series where every step finished what it claims to have. */
async function completeSeries(label) {
  const fx = await fixtureSeries(label);
  for (const { name } of PIPELINE_STEPS) {
    for (const v of fx.volumes) await writeVolumeOutputs(fx.dir, v, name);
    await writeSeriesOutputs(fx.dir, name);
  }
  await fs.promises.writeFile(
    path.join(fx.dir, "translation-report.json"),
    JSON.stringify(
      {
        schema: 1,
        generatedAt: new Date().toISOString(),
        seriesName: "Test Story",
        chapters: [
          { volume: "01", folder: "Test Story(01)", id: "whole", outcome: "PUBLISHED (verified)" },
          { volume: "02", folder: "Test Story(02)", id: "whole", outcome: "PUBLISHED (verified)" },
        ],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return fx;
}

/**
 * Break glossary at volume 02: remove the files the step declares there EXCEPT `glossary.md`
 * itself. Leaving the main artifact in place is what makes the fixture honest about the wipe —
 * the manager has to remove a file that exists, not a hole that is already there.
 * @param {{dir: string, volumes: Array<{folder: string, installmentNumber: string}>}} fx
 */
async function breakGlossaryAt02(fx) {
  const volDir = path.join(fx.dir, "Test Story(02)");
  for (const e of STEP_ARTIFACT_SPECS.glossary.volume) {
    if (e.name === "glossary.md") continue;
    await fs.promises.rm(path.join(volDir, e.name.replace("{installment}", "02")), { force: true });
  }
  return volDir;
}

/**
 * The state and the plan a manager would start from.
 * @param {{dir: string}} fx
 */
async function planFor(fx) {
  const state = await resume.readWorkingState({ seriesDir: fx.dir });
  return { state, plan: resume.planResume(state) };
}

/** The glossary step's plan line, whichever scenario produced it. */
function glossaryLine(plan) {
  return plan.steps.find((s) => s.step === "glossary");
}

/** A step runner that must never be called. */
function forbiddenRunner(calls) {
  return async (opts) => {
    calls.push(opts.step);
    return { ok: true, code: 0, output: "" };
  };
}

// ─── 1: an action off the menu is refused at the moment of execution ───────────

async function testTierCRefusedAtExecution() {
  const fx = await completeSeries("tier-c");
  const volDir = await breakGlossaryAt02(fx);
  const listingBefore = (await fs.promises.readdir(volDir)).sort();
  const { state, plan } = await planFor(fx);
  const line = glossaryLine(plan);
  assert.strictEqual(line.actionName, "wipe-and-cascade", "the fixture is the shape act mode acts on");

  // A plan that someone tampered with: the triage would never propose this, but the execution
  // gate must not assume the plan came from the triage.
  const tampered = {
    ...plan,
    steps: [{ ...line, actionName: "edit-code" }],
  };

  const calls = [];
  const res = await delivery.runActPlan({ plan: tampered, state, runStep: forbiddenRunner(calls) });

  assert.strictEqual(res.exitCode, 2, "a Tier C action is not a step that went badly, it is a step that must not happen");
  assert.strictEqual(calls.length, 0, "nothing was run");
  assert.strictEqual(res.execution.length, 1);
  assert.strictEqual(res.execution[0].refused, true);
  assert.ok(res.execution[0].reason.length > 20, `the refusal names what it refused: ${res.execution[0].reason}`);

  // And nothing was removed: a refusal that wiped first would be indistinguishable from a fix.
  assert.deepStrictEqual(
    (await fs.promises.readdir(volDir)).sort(),
    listingBefore,
    "the volume's folder is exactly as it was — a refusal must not change the disk"
  );

  console.log("  tier C: refused by name at execution time, and nothing was wiped");
}

// ─── 2: a run is already in progress ───────────────────────────────────────────

async function testRefusesWhileAnotherRunIsGoing() {
  const fx = await completeSeries("locked");
  const volDir = await breakGlossaryAt02(fx);
  const listingBefore = (await fs.promises.readdir(volDir)).sort();
  const { state, plan } = await planFor(fx);

  // Somebody else's lock, held by a live process (this one — the pid is what matters, not who
  // wrote the file).
  const lockPath = runLockPath();
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.promises.writeFile(
    lockPath,
    JSON.stringify({ runId: "a-run-somewhere-else", pid: process.pid, host: os.hostname(), by: "npm run pipeline", startedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );

  const calls = [];
  const res = await delivery.runActPlan({ plan, state, runStep: forbiddenRunner(calls) });

  assert.strictEqual(res.exitCode, 1, "refusing to act is a failure of the request, not a success");
  assert.strictEqual(calls.length, 0, "no step was started");
  assert.strictEqual(res.execution.length, 0, "not even a refusal entry: it never got as far as a plan");

  const lock = JSON.parse(await fs.promises.readFile(lockPath, "utf8"));
  assert.strictEqual(lock.runId, "a-run-somewhere-else", "it left somebody else's lock alone");

  assert.deepStrictEqual(
    (await fs.promises.readdir(volDir)).sort(),
    listingBefore,
    "and it deleted nothing while it refused"
  );

  console.log("  run in progress: refused, the other run's lock untouched, nothing deleted");
}

// ─── 3: the step has spent its intervention budget ─────────────────────────────

async function testBudgetRefusalOpensATicket() {
  const fx = await completeSeries("budget");
  await breakGlossaryAt02(fx);
  const { state, plan } = await planFor(fx);
  const line = glossaryLine(plan);
  assert.strictEqual(line.actionName, "wipe-and-cascade", "the plan was written while budget remained");

  // Something spent it between the plan and the acting. Act mode re-reads the ledger per action
  // for exactly this reason.
  for (let i = 0; i < 5; i += 1) {
    appendLedgerEntry({
      run: RUN,
      kind: "intervention",
      step: "glossary",
      volume: "02",
      finding: line.finding,
      action: "wipe-and-cascade",
      outcome: "improved",
      decidedBy: "manager",
    });
  }

  const calls = [];
  const res = await delivery.runActPlan({ plan, state, runStep: forbiddenRunner(calls) });

  assert.strictEqual(calls.length, 0, "an over-budget step is not run");
  assert.strictEqual(res.execution[0].refused, true);
  assert.ok(res.execution[0].reason.includes("5 of the 5"), res.execution[0].reason);
  assert.ok(res.execution[0].reason.includes("account owner"), "the escalation path is named: only the owner may raise the limit");
  assert.ok(res.execution[0].ticket, "the refusal opened a ticket");

  const { tickets, error } = readTickets();
  assert.strictEqual(error, null);
  assert.strictEqual(tickets.length, 1, "and it is on the record, not just on the console");
  assert.strictEqual(tickets[0].step, "glossary");
  assert.strictEqual(tickets[0].volume, "02");
  assert.ok(tickets[0].question.includes("?"), "a ticket asks: " + tickets[0].question);
  assert.ok(tickets[0].tried.length >= 5, "what was already tried is copied out of the ledger, not asserted from memory");
  assert.ok(tickets[0].evidence.length > 0, "and it cites what it looked at");

  const ledger = readLedger().entries.filter((e) => e.kind === "intervention" && e.step === "glossary");
  const refusal = ledger.find((e) => e.outcome === "refused");
  assert.ok(refusal, "the refusal itself is written down — a gate that refuses silently gets worked around");
  assert.strictEqual(refusal.ticket, tickets[0].id);

  console.log("  budget spent: refused, ticketed with its evidence, and recorded in the ledger");
}

// ─── 4: the third identical attempt ────────────────────────────────────────────

async function testThirdIdenticalAttemptIsRefused() {
  const fx = await completeSeries("spin");
  await breakGlossaryAt02(fx);
  const { state, plan } = await planFor(fx);
  const line = glossaryLine(plan);

  // Two attempts that did not help, already in this run's memory.
  for (let i = 0; i < 2; i += 1) {
    appendLedgerEntry({
      run: RUN,
      kind: "intervention",
      step: "glossary",
      volume: "02",
      finding: line.finding,
      action: "wipe-and-cascade",
      outcome: "unchanged",
      decidedBy: "manager",
    });
  }

  const calls = [];
  const res = await delivery.runActPlan({ plan, state, runStep: forbiddenRunner(calls) });

  assert.strictEqual(calls.length, 0, "the third one does not run");
  assert.strictEqual(res.execution[0].refused, true);
  assert.ok(res.execution[0].reason.includes("wipe-and-cascade"), res.execution[0].reason);
  assert.ok(res.execution[0].ticket, "and it becomes a question for the diagnostics team instead");

  const { tickets } = readTickets();
  assert.strictEqual(tickets.length, 1);
  assert.ok(
    tickets[0].question.includes("did not move"),
    "the ticket says what was tried and what it produced: " + tickets[0].question
  );

  console.log("  anti-spin: the third identical attempt is refused and becomes a ticket");
}

// ─── 4b: a ticketed resume step does not unlock the rest of the plan ───────────

async function testTicketedResumeStepRunsNothing() {
  const fx = await completeSeries("ticketed");
  await breakGlossaryAt02(fx);
  const { state, plan } = await planFor(fx);
  const line = glossaryLine(plan);

  // The shape the live 17-volume series has today: the step where the run stopped is escalated
  // to a question, and seven steps are still listed after it.
  const escalatedPlan = {
    ...plan,
    steps: plan.steps.map((s) =>
      s.step === line.step ? { ...s, action: "ticket", actionName: "open-ticket", wipeFirst: [], flags: [] } : s
    ),
  };
  assert.ok(
    escalatedPlan.steps.some((s) => s.action === "after"),
    "the fixture is the real shape: a ticket at the resume point and steps listed after it"
  );

  const calls = [];
  const res = await delivery.runActPlan({ plan: escalatedPlan, state, runStep: forbiddenRunner(calls) });

  assert.strictEqual(calls.length, 0, "the steps after a ticket are conditional on the ticket, not independent of it");
  assert.strictEqual(res.execution.length, 0);
  assert.strictEqual(res.exitCode, 1, "the owner asked for the run to be resumed, and it could not be");

  console.log("  ticketed resume point: the steps after it are not run, because they assume it was fixed");
}

// ─── 5: an action that passes every gate really runs ───────────────────────────

async function testExecutesThroughTheStepRunner() {
  const fx = await completeSeries("execute");
  const volDir = await breakGlossaryAt02(fx);
  const { state, plan } = await planFor(fx);
  const line = glossaryLine(plan);

  // Rehearse every step: `--dry-run` means the real runner, the real task modules and the real
  // source bundles, with no model call and no artifacts. The deliverable therefore genuinely does
  // not move, which is what makes `unchanged` the honest verdict rather than a guess — and it is
  // also what keeps a test from spending real model calls on a fixture.
  const rehearsed = {
    ...plan,
    steps: plan.steps.map((s) => (s.action === "run" || s.action === "after" ? { ...s, flags: ["--dry-run"] } : s)),
  };

  // Capture what the child printed, so the fixture's isolation can be asserted rather than
  // assumed: a step started from a fixture must never reach the live series or start the intake
  // agent (gotcha 69).
  const realWrite = process.stderr.write.bind(process.stderr);
  let childOutput = "";
  process.stderr.write = (chunk, ...rest) => {
    childOutput += chunk.toString();
    return realWrite(chunk, ...rest);
  };

  let res;
  try {
    res = await delivery.runActPlan({ plan: rehearsed, state });
  } finally {
    process.stderr.write = realWrite;
  }

  assert.ok(!childOutput.includes("running the intake agent"), "the child used the fixture's plan of record: " + childOutput.slice(0, 400));
  assert.ok(childOutput.includes(`--stages=glossary`) || childOutput.includes("=== glossary ==="), "the real step runner ran the step");

  assert.ok(res.execution.length > 1, "the plan is a sequence: the steps after the resume point ran too");
  assert.strictEqual(res.execution[0].step, "glossary");
  const done = res.execution[0];
  assert.strictEqual(done.refused, false);
  assert.ok(done.wiped > 0, `the wipe happened first: ${done.wiped} file(s) removed`);
  const ran = res.execution.map((e) => e.step);
  const planned = plan.steps.filter((s) => s.action === "run" || s.action === "after").map((s) => s.step);
  assert.deepStrictEqual(
    ran,
    planned.slice(0, ran.length),
    "run order, and it stopped where it stopped — a manager that fixed the glossary and then stopped has answered a question rather than resumed a run"
  );
  const last = res.execution[res.execution.length - 1];
  assert.notStrictEqual(last.code, 0, "the run ended on a step that did not finish");
  assert.strictEqual(res.exitCode, 1, "and act mode reports that as a failure of the request");

  const after = await fs.promises.readdir(volDir);
  assert.ok(!after.includes("glossary.md"), "the wiped output stayed wiped — a dry run does not rebuild it");
  assert.ok(after.includes("book.txt"), "and the staged book is not in the wipe list, because it is not a declared output");

  // The honest verdict, and the reason Phase 4 exists. The old per-volume count said `unchanged`:
  // volume 02 was missing files before the wipe and missing files after it, so nothing had
  // "crossed the line". But the wipe removed a glossary that WAS there and the rehearsal rebuilt
  // nothing, so the deliverable is smaller than it was. A manager that cannot see that is a
  // manager that damages the series and reports a clean run.
  assert.strictEqual(done.outcome, "worse", "the deliverable got smaller, and the report says so");
  assert.ok(done.damage.includes("glossary terms carried"), `the damage is named: ${done.damage.join(", ")}`);
  assert.strictEqual(done.progress.before, 1, "one volume had the step's output before");
  assert.strictEqual(done.progress.after, 1, "and one has it after — which is exactly what the old count could not see through");
  assert.ok(done.account.includes("2 → 1"), `the account names the loss: ${done.account}`);

  const entry = readLedger().entries.find((e) => e.kind === "intervention" && e.step === "glossary");
  assert.ok(entry, "every action that runs is recorded");
  assert.strictEqual(entry.outcome, "worse");
  assert.strictEqual(entry.decidedBy, "manager");
  assert.strictEqual(entry.action, "wipe-and-cascade");
  assert.strictEqual(entry.finding, line.finding, "the finding the action was a response to is named, so a repeat of it is recognisable");
  assert.ok(entry.signals, "the numbers behind the verdict are stored, not just printed");
  assert.strictEqual(entry.signals.before.glossaryTerms, 2);
  assert.strictEqual(entry.signals.after.glossaryTerms, 1);

  console.log("  executes: wiped, ran the real step runner, judged the outcome from the deliverable, recorded it");
}

// ─── 6: when the step does rebuild the volume ──────────────────────────────────

async function testRebuildIsJudgedImproved() {
  const fx = await completeSeries("rebuild");
  const volDir = await breakGlossaryAt02(fx);
  const { state, plan } = await planFor(fx);
  const line = glossaryLine(plan);

  // Stands in for the pipeline: writes what the glossary stage would have written. The half
  // under test is whether act mode *notices* a rebuild and judges it honestly, not whether the
  // glossary stage can perform one (test-pipeline-loop.js covers that end to end).
  const rebuildsTheVolume = async ({ step, seriesDir }) => {
    for (const v of fx.volumes) await writeVolumeOutputs(seriesDir, v, step);
    await writeSeriesOutputs(seriesDir, step);
    return { ok: true, code: 0, output: "" };
  };

  const res = await delivery.runActPlan({ plan, state, runStep: rebuildsTheVolume });

  const done = res.execution[0];
  assert.strictEqual(done.refused, false);
  assert.strictEqual(done.outcome, "improved");
  assert.strictEqual(done.progress.before, 1, "one volume had it before");
  assert.strictEqual(done.progress.after, 2, "both volumes have it after");
  assert.strictEqual(done.damage.length, 0, `nothing was damaged: ${done.damage.join(", ")}`);
  assert.strictEqual(res.exitCode, 0);

  const after = await fs.promises.readdir(volDir);
  assert.ok(after.includes("glossary.md"), "the volume really was rebuilt on disk");

  // The point of acting is that the run is no longer stopped here.
  const retriaged = await planFor(fx);
  assert.strictEqual(retriaged.plan.verdict, "nothing-to-do", retriaged.plan.headline);

  const entry = readLedger().entries.find((e) => e.kind === "intervention" && e.step === "glossary");
  assert.strictEqual(entry.outcome, "improved");
  assert.ok(entry.note.includes("1 → 2"), entry.note);

  console.log("  rebuild: judged improved from the deliverable, and the next triage has nothing to do");
}

// ─── 7: the planted "fix" that removes the finding and shrinks the glossary ───

/**
 * A glossary that finishes the step and loses the terminology.
 *
 * The table is there, the shape is right, the validator's files are all present — and there is not
 * one usable row in it. This is the shape `utils/tickets.js` deliberately does NOT ban
 * (`Add the old spelling back as a second row` and its cousins): a judgment about the deliverable
 * rather than a guard being switched off, and therefore something the option filter cannot refuse.
 * The thing that rejects it is this comparison.
 */
const SHRUNK_TABLE = `# Glossary

| Term | Rendering | Notes |
|---|---|---|
`;

async function testShrinkingFixIsRecordedAsDamage() {
  const fx = await completeSeries("shrink");
  await breakGlossaryAt02(fx);
  const { state, plan } = await planFor(fx);
  const line = glossaryLine(plan);
  assert.strictEqual(line.actionName, "wipe-and-cascade", "the plan is the ordinary one: nothing about this action is suspicious");

  // The planted fix. It really does finish the step — every declared file is written, so the next
  // triage has nothing left to complain about — and it writes a glossary with the rows missing.
  const writesTheFindingAway = async ({ step, seriesDir }) => {
    for (const v of fx.volumes) {
      await writeVolumeOutputs(seriesDir, v, step);
      if (v.installmentNumber === "02") {
        await fs.promises.writeFile(path.join(seriesDir, v.folder, "glossary.md"), SHRUNK_TABLE, "utf8");
      }
    }
    await writeSeriesOutputs(seriesDir, step);
    return { ok: true, code: 0, output: "" };
  };

  const res = await delivery.runActPlan({ plan, state, runStep: writesTheFindingAway });
  const done = res.execution[0];
  assert.strictEqual(
    done.refused,
    false,
    "the action was on the menu and inside the budget — only the measurement stands between this and a success"
  );
  assert.strictEqual(done.outcome, "worse", "the finding is gone and the deliverable is smaller; the measurement reads the deliverable");
  assert.ok(done.damage.includes("glossary terms carried"), `the damage is named, not implied: ${done.damage.join(", ")}`);
  assert.ok(
    done.account.includes("2 → 1"),
    `and it is counted: ${done.account}`
  );

  // The finding genuinely is gone. That is the trap, and it is why "did the error go away?" is not
  // a question this layer is allowed to ask (gotcha 70).
  const retriaged = await planFor(fx);
  assert.strictEqual(retriaged.plan.verdict, "nothing-to-do", retriaged.plan.headline);

  const entry = readLedger().entries.find((e) => e.kind === "intervention" && e.step === "glossary");
  assert.strictEqual(entry.outcome, "worse", "the ledger records what happened to the book, not what happened to the report");
  assert.strictEqual(entry.signals.before.glossaryTerms, 2);
  assert.strictEqual(entry.signals.after.glossaryTerms, 1);

  console.log("  planted \"fix\": the finding disappeared, the glossary shrank, and the ledger recorded damage");
}

// ─── 8: a ticket closes on the same measurement act mode records ──────────────

async function testTicketClosesOnTheSameMeasurement() {
  const fx = await completeSeries("closure");
  const volDir = await breakGlossaryAt02(fx);
  const { state, plan } = await planFor(fx);
  const line = glossaryLine(plan);

  const before = await measureDeliverable({ seriesDir: fx.dir, volumes: state.volumes });

  const opened = createTicket({
    run: RUN,
    step: "glossary",
    volume: "02",
    finding: line.finding,
    evidence: [{ file: "glossary.md", note: "volume 02 holds the glossary and none of the reports that always come with it" }],
    question: "What is leaving volume 02's glossary without its validation report?",
  });
  assert.ok(opened.ticket, (opened.problems || []).join("; "));

  // Somebody else's fix, judged here: the step is finished, the glossary is smaller.
  await fs.promises.writeFile(path.join(volDir, "glossary.md"), SHRUNK_TABLE, "utf8");
  for (const e of STEP_ARTIFACT_SPECS.glossary.volume) {
    if (e.name === "glossary.md") continue;
    await fs.promises.writeFile(path.join(volDir, e.name.replace("{installment}", "02")), contentFor(e.name, e.shape), "utf8");
  }

  const closed = await delivery.closeTicketOnDeliverable({
    ticketId: opened.ticket.id,
    before,
    seriesDir: fx.dir,
    note: "the glossary was rebuilt from the previous volume's copy",
  });
  assert.strictEqual(closed.error, null);
  assert.strictEqual(closed.ticket.status, "closed");
  assert.strictEqual(
    closed.ticket.closure.outcome,
    "worse",
    "the ticket closes on the same comparison act mode writes to the ledger — one answer to \"did it help?\""
  );
  assert.ok(closed.ticket.closure.note.includes("glossary terms carried"), closed.ticket.closure.note);

  // The shape rule still holds next to the measurement: a ticket may not close as "it is fixed now".
  const second = createTicket({
    run: RUN,
    step: "glossary",
    volume: "02",
    finding: line.finding,
    evidence: [{ file: "glossary.md", note: "fixture" }],
    question: "Why is volume 02's glossary missing its validation report?",
  });
  assert.ok(second.ticket);
  const refused = closeTicket(second.ticket.id, { outcome: "finding-gone", note: "it is fixed now" });
  assert.ok(refused.error, "closing on the finding is the exact thing this layer exists to refuse");
  assert.ok(refused.error.includes("deliverable"), refused.error);

  console.log("  ticket closure: judged by the measurement act mode also records, and `finding-gone` is still refused");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  await testTierCRefusedAtExecution();
  await testRefusesWhileAnotherRunIsGoing();
  await testBudgetRefusalOpensATicket();
  await testThirdIdenticalAttemptIsRefused();
  await testTicketedResumeStepRunsNothing();
  await testExecutesThroughTheStepRunner();
  await testRebuildIsJudgedImproved();
  await testShrinkingFixIsRecordedAsDamage();
  await testTicketClosesOnTheSameMeasurement();
  delete process.env.POSTMORTEM_DIR;
  delete process.env.INDEX_RUN_ID;
  console.log("delivery act mode: ok");
})().catch((err) => {
  console.error("delivery act mode test failed:", err.message);
  console.error(err.stack);
  process.exitCode = 1;
});

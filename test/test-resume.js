/**
 * test/test-resume.js — the resume triage (`utils/resume.js`) and its CLI (`delivery.js`).
 *
 * What is being pinned is a DECISION, not a data structure: where a half-built run picks up,
 * and what the delivery manager is allowed to propose about it. Every scenario is a throwaway
 * fixture series with a committed plan of record, because a triage that reads "the" series
 * reads whatever `.env` says — which on this machine is the live 17 volumes (gotcha 69). The
 * suites assert `running the intake agent` never appears in a child's output for the same
 * reason: reading a state must never be able to start a model call.
 *
 * The scenarios, and why each one exists:
 *   1. the range helper, because the report is read by a human at 7am;
 *   2. a half-built series → the right step, the right volume, the cascade, and a wipe list
 *      that is exactly the step's declared outputs;
 *   3. a complete series → "nothing to do", and no proposal to destroy anything;
 *   4. gate evidence beside COMPLETE output → read it, do not rebuild (the mistake this
 *      module made on the live series, where it chose volume 02 whose glossary was fine);
 *   5. gate evidence beside MISSING output → a ticket, not a wipe (volume 15, gotcha 68:
 *      re-running a deterministic gate produces the identical quarantine);
 *   6. no plan of record → blocked, and the intake questions are named as not the manager's;
 *   7. a finding that survived an earlier recorded run → the "just re-run" advice is refused;
 *   8. the intervention budget is PER STEP — a step that has spent its attempts gets a ticket,
 *      and another step's exhausted budget does not spend this one's;
 *   8b. an attempt that ended `unchanged` or `worse` turns the step into a question. The disk cannot
 *      tell a failed repair from work that was never done — a step killed part-way leaves the same
 *      folder either way — so this is read off the ledger, and it is what lets the autopilot keep
 *      going after a failure without spending a second identical attempt;
 *   9. the triage reads its OWN correspondence (`tickets.json` / `patches.json`) — an open ticket
 *      is named rather than duplicated, an accepted/committed patch supersedes the escalation
 *      that was only true of the old code, a closed ticket whose closure measured `unchanged`
 *      does not make a re-run legitimate again, and a spent budget is the one escalation a patch
 *      cannot un-spend;
 *  10. the closed action menu → Tier C refused, picking up work is free, destroying output is
 *      an intervention;
 *  11. the CLI → report mode writes a report and executes nothing, `--mode=act --no-write` is
 *      refused as the contradiction it is, and an unknown flag is refused. (Executing the plan
 *      is `test/test-delivery-act.js`.)
 *  12. the verbs behind the escalation ladder → `--open-ticket` writes the question the plan's own
 *      escalation names (idempotent: a live ticket is named, not duplicated), and `--choose` records
 *      the manager's pick while an option the filter refused stays refused.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");
const resume = require("../utils/resume");
const { appendLedgerEntry } = require("../utils/ledger");
const { attachOptions } = require("../utils/tickets");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.resolve("/tmp/opencode/resume-tests");

// ─── Fixture pieces ───────────────────────────────────────────────────────────
//
// The series fixtures live in `test/fixture-series.js`, shared with `test/test-autopilot.js`: they lay
// a fixture out from `utils/artifacts.js` itself, so the fixture and the declaration cannot drift, and
// each one points `POSTMORTEM_DIR` at its own folder so no scenario can read the live series' history
// (gotcha 69, gotcha 71).

const {
  completeSeries,
  fixtureSeries,
  writeChannel,
  writeVolumeOutputs,
  writeSeriesOutputs,
  leaveGateEvidenceBesideTheGap,
} = require("./fixture-series");

// ─── 1: the range helper ──────────────────────────────────────────────────────

function testRanges() {
  assert.strictEqual(resume.formatRanges(["01", "02", "03", "07"]), "01–03, 07");
  assert.strictEqual(resume.formatRanges(["15", "16", "17"]), "15–17");
  assert.strictEqual(resume.formatRanges(["01"]), "01");
  assert.strictEqual(resume.formatRanges([]), "");
  // The live series' shape: whole through 14, holes at 15–17.
  assert.strictEqual(resume.formatRanges(["01", "02", "14", "15", "16", "17"]), "01–02, 14–17");
  console.log("  ranges: installment lists collapse into readable spans");
}

// ─── 2: a half-built series ───────────────────────────────────────────────────

async function testHalfBuilt() {
  const fx = await completeSeries("half-built");
  // Break glossary at volume 02 only: the step's declared outputs are gone.
  const vol2 = path.join(fx.dir, "Test Story(02)");
  for (const e of STEP_ARTIFACT_SPECS.glossary.volume) {
    await fs.promises.rm(path.join(vol2, e.name.replace("{installment}", "02")), { force: true });
  }
  // And break the NEXT step at the same volume, with its own gate evidence left beside the gap:
  // the two steps pick up at their own volumes, and the evidence belongs to one of them.
  for (const e of STEP_ARTIFACT_SPECS["character-voice"].volume) {
    await fs.promises.rm(path.join(vol2, e.name.replace("{installment}", "02")), { force: true });
  }
  await fs.promises.writeFile(path.join(vol2, "character-voice.md.rejected"), "evidence\n", "utf8");

  const plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));

  assert.strictEqual(plan.verdict, "resume", plan.headline);
  assert.ok(plan.headline.includes("glossary"), plan.headline);

  const resumeStep = plan.steps.find((s) => s.action === "run" || s.action === "ticket");
  assert.strictEqual(resumeStep.step, "glossary");
  assert.strictEqual(resumeStep.fromVolume, "02", "the resume volume is where the step's own output is missing");
  assert.strictEqual(resumeStep.actionName, "wipe-and-cascade");
  assert.strictEqual(resumeStep.cascade, true, "the cumulative invariant rebuilds the tail");
  assert.strictEqual(resumeStep.countsAsIntervention, true, "removing output that exists IS an intervention");

  // The primitive, exactly: the step's declared outputs (placeholders resolved), and nothing else.
  const wipe = resumeStep.wipeFirst[0];
  assert.strictEqual(wipe.volumeDir, vol2);
  const declared = STEP_ARTIFACT_SPECS.glossary.volume.map((e) => e.name.replace("{installment}", "02"));
  assert.deepStrictEqual(wipe.files, declared, "the wipe list is the step's declared outputs, placeholders resolved");
  assert.ok(
    declared.some((f) => f.endsWith("-rolling-state.json")),
    "a rolling-state file left behind is what makes the re-run skip the volume it was meant to rebuild"
  );
  assert.ok(!wipe.files.some((f) => f.includes("{installment}")), "a literal `{installment}` deletes nothing");
  assert.ok(!wipe.files.some((f) => /\.rejected/.test(f)), "quarantine evidence is never in a wipe list (Tier C)");
  assert.ok(!wipe.files.some((f) => /character-voice/.test(f)), "another step's files are not this step's to remove");

  // What the wipe leaves alone is NAMED, when there is something to leave alone. The fixture plants
  // another step's gate evidence in this very folder, which is the case the wording has to get right.
  assert.deepStrictEqual(
    wipe.quarantinesKept,
    ["character-voice.md.rejected"],
    "the file the wipe must not touch is named, not described in the abstract"
  );
  assert.ok(
    !wipe.files.some((f) => /\.rejected/.test(f)),
    "named — and still never in the list of things to remove (Tier C)"
  );
  assert.ok(
    resumeStep.reasons.some((r) => r.includes("`character-voice.md.rejected`")),
    JSON.stringify(resumeStep.reasons)
  );

  // `--force --volume NN` does not cascade (gotcha 66), so no step may be proposed with a
  // volume filter. The plan's own reason text says "not --volume", which is why the check is on
  // the flags and the primitive, not on the prose.
  assert.deepStrictEqual(resumeStep.flags, []);
  assert.ok(plan.steps.every((s) => s.flags.length === 0), "no step is proposed with a flag it did not earn");
  const primitive = resume.actionByName(resumeStep.actionName).primitive;
  assert.ok(!primitive.includes("--volume"), primitive);
  assert.ok(
    resumeStep.reasons.some((r) => r.includes("not --volume")),
    "the reason has to name the tempting wrong primitive, not just avoid it"
  );

  // Everything before the resume point is left alone; everything after names its own volume.
  const discover = plan.steps.find((s) => s.step === "discover");
  assert.strictEqual(discover.action, "none");
  const voice = plan.steps.find((s) => s.step === "character-voice");
  assert.strictEqual(voice.action, "after");
  assert.strictEqual(voice.fromVolume, "02", "each step picks up at its own earliest damaged volume");
  assert.ok(
    voice.reasons.some((r) => r.includes("gate evidence")),
    "the leftover evidence is reported, not acted on"
  );

  // …and when the folder holds NONE, the plan does not claim any. This is the half that used to read
  // "the quarantine evidence beside them is kept" about a folder with no quarantine in it, which a
  // reader takes as a fact about the disk (gotcha 81).
  await fs.promises.rm(path.join(vol2, "character-voice.md.rejected"), { force: true });
  const bare = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));
  const bareStep = bare.steps.find((s) => s.action === "run" || s.action === "ticket");
  assert.strictEqual(bareStep.step, "glossary");
  assert.deepStrictEqual(bareStep.wipeFirst[0].quarantinesKept, [], "nothing is promised about evidence that is not there");
  assert.ok(
    bareStep.reasons.some((r) => r.includes("nothing else in that volume folder is touched")),
    JSON.stringify(bareStep.reasons)
  );
  assert.ok(
    !bareStep.reasons.some((r) => r.includes("quarantine evidence beside them")),
    JSON.stringify(bareStep.reasons)
  );

  console.log("  half-built: picks up at the right step and volume, wipes only that step's outputs");
}

// ─── 3: a complete series ─────────────────────────────────────────────────────

async function testComplete() {
  const fx = await completeSeries("complete");
  const state = await resume.readWorkingState({ seriesDir: fx.dir });
  const plan = resume.planResume(state);

  assert.strictEqual(plan.verdict, "nothing-to-do", plan.headline);
  assert.ok(plan.steps.every((s) => s.action === "none"), "a finished run is not a queue of work");
  assert.ok(plan.steps.every((s) => s.wipeFirst.length === 0), "nothing is proposed for deletion");
  assert.ok(plan.steps.every((s) => !s.countsAsIntervention), "picking up work is not an intervention");
  const counts = state.deliverable.counts;
  assert.deepStrictEqual(
    {
      total: counts.total,
      published: counts.published,
      unverified: counts.unverified,
      missing: counts.missing,
      emptyInSource: counts.emptyInSource,
    },
    { total: 2, published: 2, unverified: 0, missing: 0, emptyInSource: 0 },
    "the deliverable is read off the publish report, not inferred from exit codes"
  );
  assert.strictEqual(counts.scoreCount, 0, "the fixture's report carries no scores, and the roll-up does not invent any");
  // The disk matches the declaration, so the assessment finds nothing. If this ever reports a
  // HIGH finding, either the fixture or utils/artifacts.js drifted.
  assert.ok(
    state.stepStates.every((s) => s.status === "complete" || s.status === "gaps"),
    JSON.stringify(state.stepStates.filter((s) => s.status === "incomplete").map((s) => s.damageKinds))
  );

  console.log("  complete: says so, and proposes nothing");
}

// ─── 4: gate evidence beside COMPLETE output ──────────────────────────────────

async function testEvidenceIsNotAResumePoint() {
  const fx = await completeSeries("evidence-beside-complete");
  // Volume 02's glossary is complete. A `.rejected` from an earlier run is lying beside it.
  await fs.promises.writeFile(path.join(fx.dir, "Test Story(02)", "glossary.md.rejected"), "old quarantine\n", "utf8");

  const plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));

  assert.strictEqual(plan.verdict, "evidence", plan.headline);
  assert.ok(plan.headline.includes("evidence"), plan.headline);
  const glossary = plan.steps.find((s) => s.step === "glossary");
  assert.strictEqual(glossary.action, "ticket", "reading the evidence is a question, not a rebuild");
  assert.strictEqual(glossary.actionName, "open-ticket");
  assert.deepStrictEqual(glossary.wipeFirst, [], "complete output is not removed because a leftover file is next to it");
  assert.ok(
    glossary.reasons.some((r) => r.includes("not a reason to rebuild")),
    "the report has to say out loud that this volume is finished"
  );
  // And it must not become a wipe-and-cascade under any name.
  assert.ok(!plan.markdown.includes("wipe-and-cascade"), plan.markdown.slice(0, 400));

  console.log("  evidence beside finished work: read it, do not rebuild thirteen volumes of it");
}

// ─── 5: gate evidence beside MISSING output (volume 15) ───────────────────────

async function testGateRemovedTheOutput() {
  const fx = await completeSeries("gate-removed-output");
  const vol2 = path.join(fx.dir, "Test Story(02)");
  for (const e of STEP_ARTIFACT_SPECS.glossary.volume) {
    await fs.promises.rm(path.join(vol2, e.name.replace("{installment}", "02")), { force: true });
  }
  // The gate took the file away: the evidence is in the same folder, and nothing replaced it.
  await fs.promises.writeFile(path.join(vol2, "glossary.md.rejected"), "the gate's own account\n", "utf8");

  const plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));

  const resumeStep = plan.steps.find((s) => s.step === "glossary");
  assert.strictEqual(resumeStep.action, "ticket", plan.headline);
  assert.strictEqual(resumeStep.actionName, "open-ticket");
  assert.ok(plan.headline.includes("gate"), plan.headline);
  assert.deepStrictEqual(resumeStep.wipeFirst, [], "rebuilding the file and running the same gate reproduces the quarantine");
  assert.ok(
    resumeStep.reasons.some((r) => r.includes("identical quarantine")),
    "the reason must name the spin, not just refuse"
  );
  assert.ok(
    resumeStep.reasons.some((r) => r.includes("glossary.md.rejected")),
    "it names the evidence to read first"
  );
  assert.strictEqual(resumeStep.countsAsIntervention, false, "asking is not an intervention");

  // What the ledger records is said as what the ledger records. This reason used to assert "the ledger
  // refuses the third attempt" on a series with NO ledger file at all, and the diagnostics team spent a
  // whole turn on 2026-10-06 asking the account owner whether two runs of volume 15 had really happened.
  // A mechanism that exists is not a record that something has met it — and a plan that claims an
  // attempt nobody made is answered by somebody switching the guard off.
  assert.ok(
    resumeStep.reasons.some((r) => r.includes("nothing is recorded as attempted on glossary")),
    `with an empty ledger the plan says so: ${resumeStep.reasons.join(" | ")}`
  );
  assert.ok(
    !resumeStep.reasons.some((r) => r.includes("refuses the third attempt")),
    `no count, no claim of a count: ${resumeStep.reasons.join(" | ")}`
  );

  // And when the ledger DOES record attempts, it counts them out.
  const ledgerDir = path.join(fx.dir, ".postmortem");
  const ledgerFile = path.join(ledgerDir, "ledger.json");
  fs.mkdirSync(ledgerDir, { recursive: true });
  process.env.POSTMORTEM_DIR = ledgerDir;
  try {
    for (let i = 0; i < 3; i += 1) {
      appendLedgerEntry(
        {
          kind: "intervention",
          step: "glossary",
          volume: "02",
          action: "wipe-and-cascade",
          finding: "missing-required",
          outcome: "unchanged",
          run: "run-2",
        },
        ledgerFile
      );
    }
    const again = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));
    const counted = again.steps.find((s) => s.step === "glossary");
    assert.ok(
      counted.reasons.some((r) => r.includes("the ledger records 3 intervention(s) on glossary")),
      `the attempts are named with their number: ${counted.reasons.join(" | ")}`
    );
  } finally {
    delete process.env.POSTMORTEM_DIR;
  }

  console.log("  gate removed the output: a ticket, because re-running reproduces the quarantine");
}

// ─── 6: no plan of record ─────────────────────────────────────────────────────

async function testNoPlan() {
  const fx = await fixtureSeries("no-plan");
  await fs.promises.rm(path.join(fx.dir, "translation-target.json"), { force: true });

  const plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));

  assert.strictEqual(plan.verdict, "blocked");
  assert.strictEqual(plan.steps[0].step, "discover");
  assert.strictEqual(plan.steps[0].action, "blocked");
  assert.ok(plan.steps[0].reasons[0].includes("no plan of record"), plan.steps[0].reasons[0]);
  assert.ok(
    plan.markdown.includes("belong to the intake agent and the account owner"),
    "the manager may report that intake is needed; it may not answer the intake questions"
  );
  // `run-intake` is Tier C: the plan may not name it, and the menu must refuse it.
  assert.ok(!plan.markdown.includes("run-intake"), plan.markdown);
  const refused = resume.actionIsAvailable("run-intake");
  assert.strictEqual(refused.allowed, false);
  assert.ok(refused.why.includes("intake"));

  // A corrupt plan of record is reported, not guessed around.
  await fs.promises.writeFile(path.join(fx.dir, "translation-target.json"), "{ half written", "utf8");
  const broken = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));
  assert.strictEqual(broken.verdict, "blocked");
  assert.ok(broken.steps[0].reasons[0].includes("not valid JSON"), broken.steps[0].reasons[0]);

  console.log("  no plan of record: blocked, and the intake questions stay somebody else's");
}

// ─── 7: a finding that survived an earlier run ────────────────────────────────

async function testRecurringFindings() {
  const fx = await completeSeries("recurring");
  const vol2 = path.join(fx.dir, "Test Story(02)");
  for (const e of STEP_ARTIFACT_SPECS.glossary.volume) {
    await fs.promises.rm(path.join(vol2, e.name.replace("{installment}", "02")), { force: true });
  }

  // Two recorded runs, both assessing glossary with the same finding class. This is what the
  // ledger looks like the morning after a re-run that changed nothing.
  const ledgerDir = path.join(fx.dir, ".postmortem");
  process.env.POSTMORTEM_DIR = ledgerDir;
  for (const run of ["run-one", "run-two"]) {
    await appendLedgerEntry({
      run,
      kind: "assessment",
      step: "glossary",
      findingKinds: ["missing-required"],
      counts: { HIGH: 1, MEDIUM: 0, LOW: 0 },
    });
  }

  const state = await resume.readWorkingState({ seriesDir: fx.dir });
  assert.strictEqual(state.recurring.length, 1, `the ledger says glossary's missing-required survived two runs: ${JSON.stringify(state.recurring)}`);
  assert.strictEqual(state.recurring[0].finding, "missing-required");
  assert.strictEqual(state.recurring[0].runs, 2);

  const plan = resume.planResume(state);
  const glossary = plan.steps.find((s) => s.step === "glossary");
  assert.strictEqual(glossary.actionName, "open-ticket", "a finding that survived a run is not met with a re-run");
  assert.ok(
    glossary.reasons.some((r) => r.includes("has not cleared it before")),
    JSON.stringify(glossary.reasons)
  );
  assert.ok(
    plan.notes.some((n) => n.includes("structural, not transient")),
    JSON.stringify(plan.notes)
  );
  assert.deepStrictEqual(glossary.wipeFirst, []);

  console.log("  recurring finding: the cheap advice is refused, and the ledger is why");
}

// ─── 8: the intervention budget is per step ───────────────────────────────────

async function testInterventionBudgetIsPerStep() {
  const fx = await completeSeries("budget");
  const vol2 = path.join(fx.dir, "Test Story(02)");
  const breakStep = (step) => {
    for (const e of STEP_ARTIFACT_SPECS[step].volume) {
      fs.rmSync(path.join(vol2, e.name.replace("{installment}", "02")), { force: true });
    }
  };

  // Five interventions already spent on glossary in this run, two on character-voice — plus
  // three on character-voice that the menu says are FREE. Picking up unfinished work does not
  // spend a step's allowance; `countsAsIntervention` on the menu entry is what decides, not the
  // ledger's `kind`, because act mode records everything it does and the budget is a separate
  // question from the audit trail.
  //
  // Every one of them `improved` on purpose. An attempt that did not help is a DIFFERENT tell — the
  // triage turns that step into a question (see `testAttemptThatDidNotHelp`), and leaving an
  // `unchanged` entry here would test that rule while this test is trying to say something about the
  // budget being per step.
  for (let i = 0; i < 5; i += 1) {
    await appendLedgerEntry({
      run: "run-budget",
      kind: "intervention",
      step: "glossary",
      volume: "02",
      finding: "missing-required",
      action: "wipe-and-cascade",
      outcome: "improved",
      decidedBy: "manager",
    });
  }
  for (let i = 0; i < 2; i += 1) {
    await appendLedgerEntry({
      run: "run-budget",
      kind: "intervention",
      step: "character-voice",
      volume: "02",
      finding: "missing-required",
      action: "re-run-force",
      outcome: "improved",
      decidedBy: "manager",
    });
  }
  for (let i = 0; i < 3; i += 1) {
    await appendLedgerEntry({
      run: "run-budget",
      kind: "intervention",
      step: "character-voice",
      volume: "02",
      finding: "missing-required",
      action: "re-run-step",
      outcome: "improved",
      decidedBy: "manager",
    });
  }

  // Part A: glossary is the broken step, and it is out of budget.
  breakStep("glossary");
  let state = await resume.readWorkingState({ seriesDir: fx.dir });
  assert.strictEqual(state.run, "run-budget", "the triage counts the newest recorded run");
  assert.deepStrictEqual(
    state.interventionsByStep,
    { glossary: 5, "character-voice": 2 },
    "8 intervention entries were recorded on character-voice's step and glossary's, but only the ones the menu calls interventions spent the budget"
  );
  assert.strictEqual(state.interventionBudget, 5);

  let plan = resume.planResume(state);
  let glossary = plan.steps.find((s) => s.step === "glossary");
  assert.strictEqual(glossary.actionName, "open-ticket", "a step out of budget gets a question, not another attempt");
  assert.ok(glossary.reasons.some((r) => r.includes("5 of the 5")), JSON.stringify(glossary.reasons));
  assert.ok(
    plan.notes.some((n) => n.includes("out of intervention budget (5/5)")),
    JSON.stringify(plan.notes)
  );
  assert.deepStrictEqual(glossary.wipeFirst, [], "the budget refusal removes nothing");

  // Part B: glossary is fine, character-voice is the broken one — and glossary's exhausted
  // budget must NOT spend character-voice's. This is the whole point of making it per step.
  // (Rebuilt in place: `completeSeries` would delete the fixture, and the ledger with it.)
  for (const v of fx.volumes) await writeVolumeOutputs(fx.dir, v, "glossary");
  await writeSeriesOutputs(fx.dir, "glossary");
  breakStep("character-voice");
  state = await resume.readWorkingState({ seriesDir: fx.dir });
  plan = resume.planResume(state);
  const voice = plan.steps.find((s) => s.step === "character-voice");
  assert.strictEqual(voice.step, "character-voice");
  assert.strictEqual(voice.actionName, "wipe-and-cascade", "2 of 5 used is not out of budget");
  assert.strictEqual(voice.countsAsIntervention, true);
  assert.ok(voice.wipeFirst.length === 1, "and it names the wipe it needs");
  const glossaryAgain = plan.steps.find((s) => s.step === "glossary");
  assert.strictEqual(glossaryAgain.action, "none", "glossary is finished; its exhausted budget changes nothing about that");

  console.log("  intervention budget: per step — glossary's spent attempts do not spend character-voice's");
}

// ─── 8b: an attempt that did not help is read off the ledger, not off the disk ─

async function testAttemptThatDidNotHelp() {
  const fx = await completeSeries("attempt-did-not-help");
  const vol2 = path.join(fx.dir, "Test Story(02)");
  const breakVoice = async () => {
    for (const e of STEP_ARTIFACT_SPECS["character-voice"].volume) {
      await fs.promises.rm(path.join(vol2, e.name.replace("{installment}", "02")), { force: true });
    }
  };
  await breakVoice();

  // A. Nothing has been tried yet. The disk says "the work is unfinished", and the honest move is to
  //    finish it. This is the SAME folder shape the next part uses, which is the point: the disk
  //    cannot tell an attempt that failed from an attempt that never happened.
  let plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));
  let voice = plan.steps.find((s) => s.step === "character-voice");
  assert.strictEqual(voice.actionName, "wipe-and-cascade", "with no recorded attempt, this is unfinished work, not a question");
  assert.strictEqual(voice.escalation, null);

  // B. One attempt was made on this step and the deliverable did not move.
  await appendLedgerEntry({
    run: "run-attempt",
    kind: "intervention",
    step: "character-voice",
    volume: "02",
    finding: "missing-required",
    action: "wipe-and-cascade",
    outcome: "unchanged",
    decidedBy: "manager",
  });
  plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));
  voice = plan.steps.find((s) => s.step === "character-voice");
  assert.strictEqual(voice.action, "ticket", plan.headline);
  assert.strictEqual(voice.actionName, "open-ticket");
  assert.strictEqual(voice.escalation, "attempt-did-not-help", "the plan names WHICH check turned the repair into a question");
  assert.deepStrictEqual(voice.wipeFirst, [], "a question removes nothing");
  assert.strictEqual(voice.countsAsIntervention, false, "asking is not an intervention");
  assert.ok(plan.headline.includes("did not move"), plan.headline);
  assert.ok(
    voice.reasons.some((r) => r.includes("run-attempt/character-voice/1") && r.includes("unchanged")),
    `the reason cites the ledger entry it is reading: ${voice.reasons.join(" | ")}`
  );
  assert.ok(
    voice.reasons.some((r) => r.includes("diagnostics team")),
    `and it names who the next move belongs to: ${voice.reasons.join(" | ")}`
  );
  // The run move is gone from the plan, which is what takes it off the manager's menu.
  assert.ok(!plan.steps.some((s) => s.action === "run" && s.step === "character-voice"), plan.markdown.slice(0, 500));

  // C. An attempt that IMPROVED the deliverable is not evidence against anything. The same step, the
  //    same finding, the same folder — and the repair stands.
  await fs.promises.rm(path.join(fx.ledgerDir, "ledger.json"), { force: true });
  await breakVoice();
  await appendLedgerEntry({
    run: "run-attempt-2",
    kind: "intervention",
    step: "character-voice",
    volume: "02",
    finding: "missing-required",
    action: "wipe-and-cascade",
    outcome: "improved",
    decidedBy: "manager",
  });
  plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));
  voice = plan.steps.find((s) => s.step === "character-voice");
  assert.strictEqual(voice.actionName, "wipe-and-cascade", "an attempt that helped is not a reason to stop trying");
  assert.strictEqual(voice.escalation, null);

  // D. A different step's failed attempt does not spend this one's — the same rule the budget uses.
  await fs.promises.rm(path.join(fx.ledgerDir, "ledger.json"), { force: true });
  await appendLedgerEntry({
    run: "run-attempt-3",
    kind: "intervention",
    step: "glossary",
    volume: "02",
    finding: "missing-required",
    action: "wipe-and-cascade",
    outcome: "worse",
    decidedBy: "manager",
  });
  plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));
  voice = plan.steps.find((s) => s.step === "character-voice");
  assert.strictEqual(voice.actionName, "wipe-and-cascade", "glossary's failed attempt is not character-voice's history");

  console.log("  attempt that did not help: the ledger is what tells a failed repair from unfinished work");
}

// ─── 9: the triage reads its own correspondence ───────────────────────────────

async function testTriageReadsItsOwnCorrespondence() {
  const fx = await completeSeries("ticket-aware");
  await leaveGateEvidenceBesideTheGap(fx.dir, "Test Story(02)", "02");

  const ticket = (over) => ({
    id: "T-0001",
    step: "glossary",
    volume: "02",
    finding: "missing-required",
    status: "open",
    question: "Why does the carry-forward gate refuse this volume's glossary?",
    evidence: [{ file: "Test Story(02)/glossary.md.rejected", saw: "the gate's account" }],
    ...over,
  });
  const patch = (over) => ({
    id: "P-0001",
    ticketId: "T-0001",
    status: "committed",
    files: ["utils/prompt.js"],
    summary: "match the aliases inside a term cell, not the whole cell",
    ...over,
  });

  // A. the question is already open: name it, do not write a second one.
  await writeChannel(fx.dir, "tickets.json", { tickets: [ticket()] });
  let state = await resume.readWorkingState({ seriesDir: fx.dir });
  assert.strictEqual(state.tickets.length, 1, "readWorkingState carries the ticket channel onto the state");
  assert.strictEqual(state.patches.length, 0);
  assert.strictEqual(state.ticketsError, null);
  assert.strictEqual(state.patchesError, null);

  let plan = resume.planResume(state);
  let glossary = plan.steps.find((s) => s.step === "glossary");
  assert.strictEqual(glossary.action, "ticket", plan.headline);
  assert.deepStrictEqual(glossary.existingTicket, { id: "T-0001", status: "open" }, "the plan names the ticket it already wrote");
  assert.strictEqual(glossary.escalation, "gate-removed", "the report says WHICH check turned this into a question");
  assert.ok(
    glossary.reasons.some((r) => r.includes("already open as T-0001") && r.includes("not to write a second one")),
    JSON.stringify(glossary.reasons)
  );
  assert.ok(plan.headline.includes("T-0001"), plan.headline);
  assert.ok(
    plan.markdown.includes("already asked: ticket **T-0001**"),
    "the human-readable plan has to point at the existing ticket, not just the JSON"
  );

  // B. a committed patch answering that ticket supersedes the escalation: the guard that produced
  // this disk shape is not the guard that will run, so the repair stands.
  await writeChannel(fx.dir, "patches.json", { patches: [patch()] });
  plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));
  glossary = plan.steps.find((s) => s.step === "glossary");
  assert.strictEqual(glossary.action, "run", plan.headline);
  assert.strictEqual(glossary.actionName, "wipe-and-cascade", "applying the fix is what makes it take effect (gotcha 66)");
  assert.strictEqual(glossary.cascade, true);
  assert.strictEqual(glossary.escalation, null, "nothing was escalated, so the plan does not claim an escalation");
  assert.strictEqual(glossary.existingTicket, null);
  assert.strictEqual(glossary.wipeFirst.length, 1, "and it names the wipe that makes the new code run");
  assert.ok(
    glossary.wipeFirst[0].files.includes("glossary.md"),
    "the cascade is what makes the patch take effect, so the wipe has to name the artifact"
  );
  assert.ok(
    !glossary.wipeFirst[0].files.some((f) => /\.rejected/.test(f)),
    "the evidence the gate left is still not this plan's to remove"
  );
  assert.ok(
    glossary.reasons.some((r) => r.includes("P-0001 (committed) answers ticket T-0001") && r.includes("skip checks do not know the code changed")),
    JSON.stringify(glossary.reasons)
  );
  assert.ok(!plan.notes.some((n) => n.includes("--commit=")), "a committed patch does not still owe a commit");

  // C. `accepted` is not `committed`: the commit is still owed, and it is the dev team's act.
  await writeChannel(fx.dir, "patches.json", { patches: [patch({ status: "accepted" })] });
  plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));
  glossary = plan.steps.find((s) => s.step === "glossary");
  assert.strictEqual(glossary.actionName, "wipe-and-cascade");
  assert.ok(
    plan.notes.some((n) => n.includes("npm run fix -- --commit=P-0001")),
    JSON.stringify(plan.notes)
  );

  // D. a `proposed` patch answers nothing. It is unjudged code already in the tree, and act mode
  // refuses the whole plan while one is open (gotcha 75), so it must not legitimise a re-run.
  await writeChannel(fx.dir, "patches.json", { patches: [patch({ status: "proposed" })] });
  plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));
  glossary = plan.steps.find((s) => s.step === "glossary");
  assert.strictEqual(glossary.action, "ticket", "an unjudged patch is not an answer");
  assert.deepStrictEqual(glossary.existingTicket, { id: "T-0001", status: "open" });

  // E. a CLOSED ticket whose closure measured `unchanged` does not make a re-run legitimate again.
  await fs.promises.rm(path.join(fx.dir, ".postmortem", "patches.json"), { force: true });
  await writeChannel(fx.dir, "tickets.json", {
    tickets: [ticket({ status: "closed", closure: { outcome: "unchanged", note: "the deliverable did not move" } })],
  });
  plan = resume.planResume(await resume.readWorkingState({ seriesDir: fx.dir }));
  glossary = plan.steps.find((s) => s.step === "glossary");
  assert.strictEqual(glossary.action, "ticket");
  assert.strictEqual(glossary.existingTicket, null, "a closed ticket is not one to work — a new question is written");
  assert.ok(
    glossary.reasons.some((r) => r.includes("closed unchanged") && r.includes("time passing does not make a re-run legitimate")),
    JSON.stringify(glossary.reasons)
  );

  // F. `planResume` is a pure function of the state it was handed. The same disk, the same
  // fixture, a state whose channels were not read: the escalation stands, and nothing on disk
  // changed that decision. This is the half that keeps a hand-built test state from silently
  // reading the real series' correspondence (gotcha 71).
  state = await resume.readWorkingState({ seriesDir: fx.dir });
  assert.strictEqual(state.tickets.length, 1, "the channel is still there on disk");
  const blind = resume.planResume({ ...state, tickets: undefined, patches: undefined });
  const blindGlossary = blind.steps.find((s) => s.step === "glossary");
  assert.strictEqual(blindGlossary.action, "ticket");
  assert.strictEqual(blindGlossary.existingTicket, null, "planResume reached for no file of its own");

  // G. the per-step budget is the ONE escalation a landed patch cannot un-spend. The patch record
  // does not refund attempts this run already made, and applying it is itself the counted
  // wipe-and-cascade — so the step is still out of moves, and the report says whose decision that
  // is (the account owner's), rather than pretending the fix resets the allowance.
  const budgetFx = await completeSeries("ticket-aware-budget");
  const bVol2 = path.join(budgetFx.dir, "Test Story(02)");
  for (const e of STEP_ARTIFACT_SPECS.glossary.volume) {
    fs.rmSync(path.join(bVol2, e.name.replace("{installment}", "02")), { force: true });
  }
  for (let i = 0; i < 5; i += 1) {
    await appendLedgerEntry({
      run: "run-spent",
      kind: "intervention",
      step: "glossary",
      volume: "02",
      finding: "missing-required",
      action: "wipe-and-cascade",
      outcome: "unchanged",
      decidedBy: "manager",
    });
  }
  await writeChannel(budgetFx.dir, "tickets.json", { tickets: [ticket()] });
  await writeChannel(budgetFx.dir, "patches.json", { patches: [patch({ status: "committed" })] });
  plan = resume.planResume(await resume.readWorkingState({ seriesDir: budgetFx.dir }));
  glossary = plan.steps.find((s) => s.step === "glossary");
  assert.strictEqual(glossary.action, "ticket", "a patch does not un-spend the attempts this run already made");
  assert.strictEqual(glossary.escalation, "intervention-budget");
  assert.ok(
    plan.notes.some((n) => n.includes("out of intervention budget (5/5)") && n.includes("account owner")),
    JSON.stringify(plan.notes)
  );

  console.log("  correspondence: an open ticket is named not duplicated, a landed patch supersedes the escalation, a spent budget does not");
}

// ─── 10: the closed action menu ───────────────────────────────────────────────

function testActionMenu() {
  // Tier C does not exist for the manager, at any count, in any mode.
  const tierC = resume.DELIVERY_ACTIONS.filter((a) => a.tier === "C");
  assert.ok(tierC.length >= 6, "the refusals have to be named so a refusal can name what it refused");
  for (const a of tierC) {
    const verdict = resume.actionIsAvailable(a.name);
    assert.strictEqual(verdict.allowed, false, `${a.name} must not be available`);
    assert.ok(verdict.why.length > 20, `${a.name} must say why it is refused`);
  }

  // An action that is not on the menu at all is refused too, so a future edit to planResume
  // cannot invent one.
  assert.strictEqual(resume.actionIsAvailable("reformat-the-glossary").allowed, false);

  // The account owner's decision of 2026-10-05, written where the code can act on it.
  const byName = (n) => resume.DELIVERY_ACTIONS.find((a) => a.name === n);
  assert.strictEqual(byName("resume-here").countsAsIntervention, false);
  assert.strictEqual(byName("re-run-step").countsAsIntervention, false);
  assert.strictEqual(byName("open-ticket").countsAsIntervention, false);
  assert.strictEqual(byName("wipe-and-cascade").countsAsIntervention, true);
  assert.strictEqual(byName("re-run-force").countsAsIntervention, true);
  assert.strictEqual(byName("re-audit").countsAsIntervention, true);

  // The cumulative set is what makes wipe-and-cascade the right primitive, so it is pinned.
  for (const step of ["glossary", "character-voice", "style-guide", "jump-in-wiki"]) {
    assert.ok(resume.CUMULATIVE_STEPS.has(step), `${step} is cumulative`);
  }
  for (const step of ["translate", "translate-qa", "polish"]) {
    assert.ok(resume.CHAPTER_STATE_STEPS.has(step), `${step} is idempotent per chapter`);
  }

  console.log("  action menu: Tier C refused with a reason, and the intervention rule pinned");
}

// ─── 11: the CLI ──────────────────────────────────────────────────────────────

function testCli() {
  const fxPath = path.join(FIXTURES, "cli");
  const seriesDir = path.join(fxPath, "series");
  const ledgerDir = path.join(fxPath, ".postmortem");
  fs.rmSync(fxPath, { recursive: true, force: true });
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.mkdirSync(ledgerDir, { recursive: true });
  // A committed plan of record with no volume artifacts at all: the triage must read it and
  // stop, never reach the intake agent.
  fs.writeFileSync(
    path.join(seriesDir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: seriesDir,
        seriesName: "Test Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        discovery: {
          summary: "fixture",
          confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
          evidence: [],
          excluded: [],
        },
        volumes: [
          {
            folder: "Test Story(01)",
            sourceFile: "Test Story(01)/book.epub",
            installmentNumber: "01",
            integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose, one volume, no packaging" },
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
  fs.mkdirSync(path.join(seriesDir, "Test Story(01)"), { recursive: true });
  fs.writeFileSync(path.join(seriesDir, "Test Story(01)", "book.epub"), "not really an epub", "utf8");

  const run = (args) =>
    spawnSync(process.execPath, [path.join(ROOT, "delivery.js"), ...args], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        // Both locks from gotcha 69: the fixture is the series, and no key is available.
        SERIES_LOCATION: seriesDir,
        POSTMORTEM_DIR: ledgerDir,
        AI_API_KEY: "",
      },
    });

  const report = run(["--no-write"]);
  assert.strictEqual(report.status, 0, report.stderr);
  const out = `${report.stdout}\n${report.stderr}`;
  assert.ok(out.includes("[delivery]"), out);
  assert.ok(out.includes(seriesDir), "the report names the series it read");
  assert.ok(!out.includes("running the intake agent"), "reading a state must not start a model call");
  assert.ok(out.includes("mode report: nothing was executed"), out);
  assert.strictEqual(fs.existsSync(path.join(ledgerDir, "delivery-plan.md")), false, "--no-write writes nothing");

  const written = run([]);
  assert.strictEqual(written.status, 0, written.stderr);
  const md = path.join(ledgerDir, "delivery-plan.md");
  const json = path.join(ledgerDir, "delivery-plan.json");
  assert.ok(fs.existsSync(md), "report mode writes the human-facing plan");
  assert.ok(fs.existsSync(json), "and the machine-readable half");
  const planJson = JSON.parse(fs.readFileSync(json, "utf8"));
  assert.strictEqual(planJson.seriesDir, seriesDir);
  assert.strictEqual(planJson.verdict, "resume");
  assert.ok(planJson.markdown.includes("Where each step reached"), planJson.markdown);

  // Act mode exists now, so the CLI test pins the two things that must be refused BEFORE any
  // acting happens. The acting itself is test/test-delivery-act.js, which drives it directly.
  const actWriteConflict = run(["--mode=act", "--no-write"]);
  assert.strictEqual(actWriteConflict.status, 2, actWriteConflict.stderr);
  assert.ok(
    actWriteConflict.stderr.includes("contradiction"),
    "acting writes files; --no-write cannot mean 'act but do not touch anything'"
  );

  const badMode = run(["--mode=maybe"]);
  assert.strictEqual(badMode.status, 2, badMode.stderr);
  assert.ok(badMode.stderr.includes("DELIVERY_MODE"), badMode.stderr);

  const badFlag = run(["--force"]);
  assert.strictEqual(badFlag.status, 2, badFlag.stdout + badFlag.stderr);
  assert.ok(`${badFlag.stdout}${badFlag.stderr}`.includes("unknown flag"), "a mistyped flag on a tool that reads a live series should fail");

  console.log("  delivery.js: report mode writes and executes nothing; a flag that would act without writing is refused");
}

// ─── 12: the verbs behind the escalation ladder ───────────────────────────────

/**
 * The manager has three acts it can perform on its own correspondence: write the question the plan
 * says is the answer (`--open-ticket`), pick an option the diagnostics team offered (`--choose`),
 * and judge a proposal (`--accept-patch` / `--reject-patch`, pinned in `test/test-delivery-act.js`).
 *
 * The first two did not exist as commands. `open-ticket` was a menu entry with nothing behind it —
 * `executableSteps` returns nothing for a `ticket` line, so act mode executed nothing and only a
 * GATE refusal ever reached `openTicketFor` — and an answered ticket could be read but not acted on,
 * which meant the dev team (summoned only by an option marked `requiresCodeChange`) could never be
 * summoned at all. A menu with entries nobody can carry out is a report, not a menu.
 *
 * Pinned here, against a fixture series and the fixture's own channel files: the question that gets
 * written is the one that is TRUE of the escalation (not the "already tried" shape, which assumes an
 * attempt happened), it passes the ticket shape rules, re-running the command names the live ticket
 * instead of writing a second one, and a choice is refused when it names an option the filter
 * already refused.
 */
async function testEscalationVerbs() {
  const fx = await completeSeries("verbs");
  const ledgerDir = path.join(fx.dir, ".postmortem");
  const ticketsJson = path.join(ledgerDir, "tickets.json");
  await leaveGateEvidenceBesideTheGap(fx.dir, "Test Story(02)", "02");

  const run = (args) =>
    spawnSync(process.execPath, [path.join(ROOT, "delivery.js"), ...args], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, SERIES_LOCATION: fx.dir, POSTMORTEM_DIR: ledgerDir, AI_API_KEY: "" },
    });
  const readTickets = () => (fs.existsSync(ticketsJson) ? JSON.parse(fs.readFileSync(ticketsJson, "utf8")).tickets : []);

  // 1. The plan's own escalation becomes a written question.
  const opened = run(["--open-ticket"]);
  assert.strictEqual(opened.status, 0, `${opened.stdout}\n${opened.stderr}`);
  const out = `${opened.stdout}\n${opened.stderr}`;
  let tickets = readTickets();
  assert.strictEqual(tickets.length, 1, "one ticket, written once");
  const t = tickets[0];
  assert.strictEqual(t.step, "glossary");
  assert.strictEqual(t.volume, "02");
  assert.strictEqual(t.finding, "missing-required");
  assert.strictEqual(t.status, "open");
  assert.ok(
    t.evidence.some((e) => e.file.includes("glossary.md.rejected")),
    `the ticket cites the evidence the assessment actually read: ${JSON.stringify(t.evidence)}`
  );
  assert.ok(!/\.js\b|\.logs|system-prompts/.test(t.evidence.map((e) => e.file).join(" ")), "a manager may not cite what it cannot read");

  // The question is the one that is TRUE of a gate-removed escalation. `openTicketFor`'s wording
  // ("has been tried and the deliverable did not move") would state an attempt that never happened,
  // because the triage REFUSED to try — and a ticket whose "already tried" list is a fiction gets
  // answered by switching the guard off (gotcha 70).
  assert.ok(/^Why/.test(t.question), `interrogative, not a demand: ${t.question}`);
  assert.ok(t.question.includes("reproduced rather than repaired"), `it names the spin out loud: ${t.question}`);
  assert.ok(!/make .* pass|so that it passes|get rid of/i.test(t.question), `no demanded result: ${t.question}`);
  assert.ok(out.includes(`npm run diagnose -- --ticket=${t.id}`), "the next command is printed, not left to be guessed");
  assert.strictEqual(
    fs.existsSync(path.join(ledgerDir, "delivery-plan.md")),
    false,
    "the ticket IS the record of this act; the plan file describes a plan"
  );

  // 2. Idempotent: the autopilot may call this on every iteration, and a live ticket for this exact
  // (step, volume, finding) is named, not duplicated. Two tickets for one complaint put the same
  // question in front of the diagnostics team twice and make the ledger's "already tried" list
  // describe neither.
  const again = run(["--open-ticket"]);
  assert.strictEqual(again.status, 0, `${again.stdout}\n${again.stderr}`);
  tickets = readTickets();
  assert.strictEqual(tickets.length, 1, "a second call wrote no second ticket");
  assert.strictEqual(tickets[0].id, t.id);
  assert.ok(`${again.stdout}`.includes("already open"), again.stdout);

  // 3. Refused combinations.
  const noWrite = run(["--open-ticket", "--no-write"]);
  assert.strictEqual(noWrite.status, 2, noWrite.stderr);
  assert.ok(noWrite.stderr.includes("contradiction"), noWrite.stderr);
  assert.strictEqual(readTickets().length, 1, "a refusal writes nothing");

  const twoActs = run(["--open-ticket", "--choose=O1", `--ticket=${t.id}`, '--reason=x']);
  assert.strictEqual(twoActs.status, 2, twoActs.stderr);
  assert.ok(twoActs.stderr.includes("one act at a time"), twoActs.stderr);

  const badFlag = run(["--frobnicate"]);
  assert.strictEqual(badFlag.status, 2, badFlag.stderr);
  assert.ok(
    badFlag.stderr.includes("--open-ticket") && badFlag.stderr.includes("--choose"),
    "the known-flag list names the verbs it now has: " + badFlag.stderr
  );

  // A plan with nothing wrong has no question to ask, and the command says so instead of inventing
  // one: a ticket written from a premise the disk does not support is the ticket that gets answered
  // by removing the complaint.
  const cleanFx = await completeSeries("verbs-clean");
  const cleanOut = spawnSync(process.execPath, [path.join(ROOT, "delivery.js"), "--open-ticket"], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, SERIES_LOCATION: cleanFx.dir, POSTMORTEM_DIR: path.join(cleanFx.dir, ".postmortem"), AI_API_KEY: "" },
  });
  assert.strictEqual(cleanOut.status, 2, `${cleanOut.stdout}\n${cleanOut.stderr}`);
  assert.ok(cleanOut.stderr.includes("does not name a ticket"), cleanOut.stderr);
  assert.strictEqual(fs.existsSync(path.join(cleanFx.dir, ".postmortem", "tickets.json")), false, "no ticket, no channel file");

  // `completeSeries` moved `POSTMORTEM_DIR` to the clean fixture. Put it back before the parent
  // process touches a channel file, or `attachOptions` answers a ticket in the wrong series.
  process.env.POSTMORTEM_DIR = ledgerDir;

  // 4. `--choose`: the manager's own act, and the door the dev team is summoned through.
  // The options come through `attachOptions`, so the banned-option filter runs on the way in
  // (gotcha 70) and the refused one is KEPT on the ticket rather than dropped.
  const attached = attachOptions(t.id, [
    {
      label: "match the aliases inside a term cell, not the whole cell",
      touches: ["utils/prompt.js"],
      cost: "low",
      risk: "low",
      verify: "the glossary term rows carried forward are counted before and after",
      requiresCodeChange: true,
    },
    {
      label: "turn off the glossary carry-forward guard for this volume",
      touches: [".env"],
      cost: "low",
      risk: "high",
      verify: "the finding disappears",
      requiresCodeChange: false,
    },
  ]);
  assert.strictEqual(attached.error, null);
  assert.strictEqual(attached.allowed.length, 1, "one option survives the filter");
  assert.strictEqual(attached.refused.length, 1, "and the refused one is kept where the manager can see it");
  const good = attached.allowed[0].id;
  const bannedId = attached.refused[0].option.id;

  const noReason = run([`--choose=${good}`, `--ticket=${t.id}`]);
  assert.strictEqual(noReason.status, 2, noReason.stderr);
  assert.ok(noReason.stderr.includes("must carry a reason"), noReason.stderr);

  const chooseBanned = run([`--choose=${bannedId}`, `--ticket=${t.id}`, '--reason=cheapest']);
  assert.strictEqual(chooseBanned.status, 2, chooseBanned.stderr);
  assert.ok(chooseBanned.stderr.includes("was refused when it was offered"), chooseBanned.stderr);
  assert.ok(chooseBanned.stderr.includes("account owner"), "a refusal names who it belongs to: " + chooseBanned.stderr);

  const chooseUnknown = run([`--ticket=${t.id}`, "--choose=NOPE", '--reason=x']);
  assert.strictEqual(chooseUnknown.status, 2, chooseUnknown.stderr);

  const chooseUnknownTicket = run(["--ticket=TCK-nope-1", `--choose=${good}`, '--reason=x']);
  assert.strictEqual(chooseUnknownTicket.status, 2, chooseUnknownTicket.stderr);

  // The reason is passed unquoted because `spawnSync` has no shell: the argument arrives verbatim,
  // which is also how `autopilot.js` will pass it. A human typing this in a shell gets the same
  // string, because the shell is what strips the quotes there.
  const chosen = run([`--ticket=${t.id}`, `--choose=${good}`, '--reason=it changes the test, not the guard']);
  assert.strictEqual(chosen.status, 0, `${chosen.stdout}\n${chosen.stderr}`);
  const after = readTickets()[0];
  assert.strictEqual(after.status, "chosen");
  assert.strictEqual(after.choice.optionId, good);
  assert.strictEqual(after.choice.reason, "it changes the test, not the guard");
  assert.ok(
    `${chosen.stdout}`.includes(`npm run fix -- --ticket=${t.id}`),
    "an option that needs code prints the command that summons the dev team:\n" + chosen.stdout
  );

  console.log("  escalation verbs: the plan's question is written once, a refused option stays refused, and choosing one names the dev team");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  testRanges();
  await testHalfBuilt();
  await testComplete();
  await testEvidenceIsNotAResumePoint();
  await testGateRemovedTheOutput();
  await testNoPlan();
  await testRecurringFindings();
  await testInterventionBudgetIsPerStep();
  await testAttemptThatDidNotHelp();
  await testTriageReadsItsOwnCorrespondence();
  testActionMenu();
  delete process.env.POSTMORTEM_DIR;
  testCli();
  await testEscalationVerbs();
  console.log("resume triage: ok");
})().catch((err) => {
  console.error("resume triage test failed:", err.message);
  console.error(err.stack);
  process.exitCode = 1;
});

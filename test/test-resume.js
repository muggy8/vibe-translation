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
 *   9. the closed action menu → Tier C refused, picking up work is free, destroying output is
 *      an intervention;
 *  10. the CLI → report mode writes a report and executes nothing, `--mode=act --no-write` is
 *      refused as the contradiction it is, and an unknown flag is refused. (Executing the plan
 *      is `test/test-delivery-act.js`.)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");
const { PIPELINE_STEPS } = require("../gulpfile");
const resume = require("../utils/resume");
const { appendLedgerEntry } = require("../utils/ledger");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.resolve("/tmp/opencode/resume-tests");

// ─── Fixture pieces ───────────────────────────────────────────────────────────

/** A Markdown table — the shape the glossary's whole contract IS. */
const TABLE = `# Glossary

| Term | Rendering | Notes |
|---|---|---|
| 主人公 | protagonist | fixture |
`;

/** A headed Markdown document. */
const DOC = `# Report

## Findings

- nothing wrong here
`;

/** The audit's own sign-off, which `utils/postmortem.js` reads out of the report. */
const PASS_DOC = `${DOC}

**PASS**
`;

/**
 * Content that satisfies an expectation's declared `shape`, so a fixture built from
 * `utils/artifacts.js` is a fixture the post-mortem agrees is complete. Building it from the
 * declaration is the point: the two cannot drift.
 *
 * @param {string} name
 * @param {string} shape
 * @returns {string}
 */
function contentFor(name, shape) {
  if (name === "consistency-report.md") return PASS_DOC;
  if (name.endsWith("-rolling-state.json")) {
    // `isAcceptedState` reads `results` through the same criterion the QA loop used.
    return JSON.stringify({ results: [80, 85], acceptedBy: "rolling-window", lastCheckedAt: new Date().toISOString() }, null, 2);
  }
  if (name === "chapters.json") return "[]\n";
  if (shape === "table") return TABLE;
  if (shape === "json") return JSON.stringify({ fixture: true }, null, 2) + "\n";
  if (shape === "document") return DOC;
  return "fixture\n";
}

/**
 * Lay out a two-volume series with a committed schema-2 plan of record.
 *
 * `integrity.basis` is ≥ 20 characters on purpose: `validateVolumeIntegrity` rejects a thinner
 * one, and a fixture whose plan is silently rejected makes the intake agent run instead
 * (gotcha 69's fixture half).
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @returns {Promise<{dir: string, volumes: Array<{folder: string, installmentNumber: string}>}>}
 */
async function fixtureSeries(label) {
  const dir = path.join(FIXTURES, label);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  // The ledger lives in `postMortemDir()`, which defaults to the repo's own `.postmortem`. A
  // triage test that reads that file is reading the real series' history, and a finding recorded
  // there would change what the test asserts (gotcha 69, same rule, other half).
  process.env.POSTMORTEM_DIR = path.join(dir, ".postmortem");
  await fs.promises.mkdir(process.env.POSTMORTEM_DIR, { recursive: true });

  const volumes = [
    { folder: "Test Story(01)", installmentNumber: "01" },
    { folder: "Test Story(02)", installmentNumber: "02" },
  ];
  for (const v of volumes) {
    const volDir = path.join(dir, v.folder);
    await fs.promises.mkdir(volDir, { recursive: true });
    await fs.promises.writeFile(path.join(volDir, "book.epub"), "not really an epub", "utf8");
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
        generator: "test-resume.js",
        generatedAt: new Date().toISOString(),
        // `discovery.confidence` is a per-dimension object of 0-1 numbers, not one number —
        // `validateDiscoveryBlock` rejects the flatter shape, and a fixture whose plan does not
        // validate is a fixture with no plan of record at all (gotcha 33).
        discovery: {
          summary: "fixture",
          confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
          evidence: ["two books"],
          excluded: [],
        },
        volumes: volumes.map((v) => ({
          folder: v.folder,
          sourceFile: `${v.folder}/book.epub`,
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
 * Write every file one step is declared to leave in one volume folder.
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
 * Write every file one step is declared to publish at the series root.
 * @param {string} seriesDir
 * @param {string} step
 */
async function writeSeriesOutputs(seriesDir, step) {
  const spec = STEP_ARTIFACT_SPECS[step];
  if (!spec) return;
  for (const e of spec.series || []) {
    // `discover` declares the plan of record as one of its outputs. Seeding a generic copy of
    // it would overwrite the fixture's real committed plan, and the triage would correctly
    // report that there is no usable plan (gotcha 33: a plan that does not validate is never
    // handed downstream). The plan of record is laid out by `fixtureSeries`, never here.
    if (e.name === "translation-target.json") continue;
    await fs.promises.writeFile(path.join(seriesDir, e.name), contentFor(e.name, e.shape), "utf8");
  }
}

/**
 * A series where every pipeline step finished what it claims to have.
 * @param {string} label
 */
async function completeSeries(label) {
  const fx = await fixtureSeries(label);
  for (const { name } of PIPELINE_STEPS) {
    for (const v of fx.volumes) await writeVolumeOutputs(fx.dir, v, name);
    await writeSeriesOutputs(fx.dir, name);
  }
  // The deliverable, so the triage can read the goal function rather than guess it.
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
  assert.deepStrictEqual(
    state.deliverable.counts,
    { total: 2, published: 2, unverified: 0, missing: 0, emptyInSource: 0 },
    "the deliverable is read off the publish report, not inferred from exit codes"
  );
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
      outcome: "unchanged",
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

// ─── 9: the closed action menu ────────────────────────────────────────────────

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

// ─── 10: the CLI ──────────────────────────────────────────────────────────────

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
  testActionMenu();
  delete process.env.POSTMORTEM_DIR;
  testCli();
  console.log("resume triage: ok");
})().catch((err) => {
  console.error("resume triage test failed:", err.message);
  console.error(err.stack);
  process.exitCode = 1;
});

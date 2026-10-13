#!/usr/bin/env node
/**
 * test-prerequisite-gate.js — the gate that stops a step starting before its foundation is finished.
 *
 * The rule this pins, in the account owner's words: pre-production → translation → polish. Once the
 * run is translating, the reference artifacts are frozen. A step may not start unless the steps it
 * needs have run and completed — including when a run is resumed days later. The pre-production
 * steps may run in ANY order relative to each other, but all of them must be complete before
 * `translate` can start, and the translation stage must complete before `polish` begins.
 *
 * What is checked, and from which door:
 *   1. the table itself — every pipeline step declared, the graph is a DAG, and the pre-production
 *      steps do not order themselves;
 *   2. a completed series passes every gate;
 *   3. `translate` refuses on an incomplete glossary, naming the volume and the file;
 *   4. `translate` refuses on a missing character-voice reference even with a complete glossary, and
 *      names the chain through `consistency-audit`;
 *   5. `polish` refuses before `translate-qa`, and `translate-qa` before `translate`;
 *   6. `consistency-audit` refuses when any one of the four artifacts it audits is incomplete;
 *   7. the four pre-production steps run in three different orders and all three are allowed;
 *   8. `--volume` narrows the check — an untouched volume 14 does not block a volume-02 run;
 *   9. `--dry-run` reports and does not refuse;
 *  10. no flag overrides it: `--force`, `--allow-fail`, `--allow-no-glossary` (deleted),
 *      `ON_TASK_ERROR=continue`, and a ledger that already recorded this step failing;
 *  11. a failed acceptance grade is not complete, and a `.rejected` whose artifact is gone is not
 *      complete — while a re-render's kept copy and a quarantined translation DRAFT (kept on purpose,
 *      gotcha 39) both still are;
 *  12. the gate fires from every door: `npx gulp <step>`, `npx gulp` (the default series),
 *      `npm run pipeline -- --stages=`, `npm run delivery -- --mode=act`, and the autopilot's act
 *      command line;
 *  13. a refusal writes nothing into the series and makes no model call;
 *  14. the table is inside `BANNED_PATCH_PATHS` and this file is inside `constraint-tests`.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes, and
 * nothing here reaches a model: `AI_API_KEY` is blank and `AI_BASE_URL` points at a closed port, so
 * a call that was not supposed to happen fails instead of succeeding. `AI_CLIENT_HOOKS_DIR` points at
 * an empty folder so no test can switch a model container (gotcha 22).
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const fx = require("./fixture-series");
const prereqs = require("../utils/prereqs");
const GULPFILE = require("../gulpfile");
const { PIPELINE_STEPS } = GULPFILE;
const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");
const { appendLedgerEntry } = require("../utils/ledger");
const { patchPathIsBanned } = require("../utils/patches");
const resume = require("../utils/resume");
const delivery = require("../delivery");

const FIXTURES = path.resolve("/tmp/opencode/series-fixtures", "prerequisite-gate");
const EMPTY_HOOKS = path.join(FIXTURES, "empty-hooks");
/** A port nothing listens on: a model call that should not happen fails instead of succeeding. */
const DEAD_ENDPOINT = "http://127.0.0.1:1/v1";

const PREPRODUCTION = ["glossary", "character-voice", "style-guide", "jump-in-wiki"];
/** The nine steps the table has prerequisites for. `discover` is the one it does not. */
const GATED_STEPS = PIPELINE_STEPS.map((s) => s.name).filter((name) => prereqs.prerequisitesFor(name).length > 0);

let checks = 0;
/**
 * Count one assertion and run it.
 * @param {boolean|void} condition
 * @param {string} message
 */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}
/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} message
 */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

/**
 * Point this process at one fixture series: its books, its records, its (empty) hooks.
 * @param {string} label
 * @param {boolean} [complete] - Lay out every step's declared output, or only the plan of record.
 * @returns {Promise<{dir: string, ledgerDir: string, volumes: Array<{folder: string, installmentNumber: string}>}>}
 */
async function series(label, complete = false) {
  const built = complete ? await fx.completeSeries(label, FIXTURES) : await fx.fixtureSeries(label, FIXTURES);
  process.env.SERIES_LOCATION = built.dir;
  process.env.AI_CLIENT_HOOKS_DIR = EMPTY_HOOKS;
  process.env.AI_API_KEY = "";
  process.env.AI_BASE_URL = DEAD_ENDPOINT;
  process.env.INDEX_RUN_ID = `prereq-${label}`;
  return built;
}

/**
 * Remove one step's declared outputs from every volume of a fixture.
 * @param {string} seriesDir
 * @param {string} step
 * @param {Array<{folder: string, installmentNumber: string}>} volumes
 */
async function breakStep(seriesDir, step, volumes) {
  for (const v of volumes) await fx.removeStepOutputs(seriesDir, step, v.folder, v.installmentNumber);
}

/**
 * Remove one step's declared outputs from ONE volume.
 * @param {string} seriesDir
 * @param {string} step
 * @param {string} folder
 * @param {string} installment
 */
async function breakStepAt(seriesDir, step, folder, installment) {
  await fx.removeStepOutputs(seriesDir, step, folder, installment);
}

/**
 * Add a volume the run has never touched, so the narrowing test has a volume 14 to ignore.
 * @param {{dir: string, volumes: Object[]}} built
 * @param {string} installment
 * @returns {Promise<{folder: string, installmentNumber: string}>}
 */
async function addUntouchedVolume(built, installment) {
  const folder = `Test Story(${installment})`;
  await fs.promises.mkdir(path.join(built.dir, folder), { recursive: true });
  const plan = JSON.parse(await fs.promises.readFile(path.join(built.dir, "translation-target.json"), "utf8"));
  plan.volumes.push({
    folder,
    sourceFile: `${folder}/book.epub`,
    installmentNumber: installment,
    title: "Test Story",
    integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: a volume this run has not touched" },
  });
  await fs.promises.writeFile(path.join(built.dir, "translation-target.json"), JSON.stringify(plan, null, 2) + "\n", "utf8");
  const entry = { folder, installmentNumber: installment };
  built.volumes.push(entry);
  return entry;
}

/**
 * Run one command in a child process and hand back its exit code and merged output.
 * @param {string[]} args - Arguments to `process.execPath`.
 * @param {Object} [env] - Extra environment for the child.
 * @returns {Promise<{code: number|null, output: string}>}
 */
function runChild(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        AI_CLIENT_HOOKS_DIR: EMPTY_HOOKS,
        AI_API_KEY: "",
        AI_BASE_URL: DEAD_ENDPOINT,
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c.toString()));
    child.stderr.on("data", (c) => (output += c.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 4 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -2, output: `spawn error: ${err.message}` });
    });
  });
}

/**
 * `npx gulp <step>`, the way a person types it.
 * @param {string} step
 * @param {string[]} [flags]
 * @param {Object} [env]
 * @returns {Promise<{code: number|null, output: string}>}
 */
function runGulp(step, flags = [], env = {}) {
  return runChild([path.join(ROOT, "node_modules", "gulp", "bin", "gulp.js"), step, ...flags], env);
}

/**
 * Snapshot a folder tree as `name<TAB>size` lines, so "wrote nothing" is a comparison and not a claim.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function snapshot(dir) {
  const lines = [];
  const walk = async (current, prefix) => {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        await walk(full, `${prefix}${e.name}/`);
        continue;
      }
      const stat = await fs.promises.stat(full);
      lines.push(`${prefix}${e.name}\t${stat.size}`);
    }
  };
  await walk(dir, "");
  return lines.sort();
}

// ─── 1. the table ─────────────────────────────────────────────────────────────

/**
 * The table is the dispatch's table, it covers every pipeline step, it is a DAG, and it does not
 * order the pre-production steps among themselves.
 */
async function scenarioTable() {
  const expected = {
    discover: [],
    extract: ["discover"],
    glossary: ["discover", "extract"],
    "character-voice": ["discover", "extract"],
    "style-guide": ["discover", "extract"],
    "jump-in-wiki": ["discover", "extract"],
    "consistency-audit": ["glossary", "character-voice", "style-guide", "jump-in-wiki"],
    translate: ["discover", "extract", "glossary", "character-voice", "style-guide", "jump-in-wiki", "consistency-audit"],
    "translate-qa": ["translate"],
    polish: ["translate", "translate-qa"],
  };
  same(prereqs.declaredPrerequisiteSteps(), Object.keys(expected), "the table declares exactly the ten pipeline steps");
  for (const [step, wanted] of Object.entries(expected)) {
    same(
      prereqs.prerequisitesFor(step).map((e) => e.step),
      wanted,
      `${step}'s prerequisites are the declared ones`
    );
    for (const edge of prereqs.prerequisitesFor(step)) {
      ok(edge.because && edge.because.length > 20, `${step} → ${edge.step} carries a reason a refused operator can read`);
    }
  }

  // Every gulp step is declared. A step added to the pipeline and not to this table gets a free pass.
  for (const { name } of PIPELINE_STEPS) {
    ok(Object.prototype.hasOwnProperty.call(prereqs.STEP_PREREQUISITES, name), `${name} is declared in the prerequisite table`);
  }

  // No cycles, and every edge points at a declared step.
  for (const [step, edges] of Object.entries(prereqs.STEP_PREREQUISITES)) {
    for (const edge of edges) {
      ok(Boolean(prereqs.STEP_PREREQUISITES[edge.step]), `${step} → ${edge.step} points at a declared step`);
    }
    for (const below of prereqs.transitivePrerequisites(step).keys()) {
      ok(below !== step, `${step} is not its own prerequisite (the table must stay a DAG)`);
    }
  }

  // The owner's rule: the four pre-production steps are not ordered among themselves.
  for (const step of PREPRODUCTION) {
    const listed = prereqs.prerequisitesFor(step).map((e) => e.step);
    for (const other of PREPRODUCTION) {
      ok(!listed.includes(other), `${step} does not require ${other} — the pre-production steps may run in any order`);
    }
  }

  // The chains a refusal names.
  same(
    prereqs.prerequisiteChain("translate", "character-voice"),
    ["consistency-audit", "character-voice"],
    "a missing character-voice reference is reported to translate through the audit that consumes it"
  );
  same(prereqs.prerequisiteChain("polish", "translate"), ["translate-qa", "translate"], "polish reaches translate through translate-qa");
  same(prereqs.prerequisiteChain("glossary", "extract"), ["extract"], "glossary reaches extract directly");
  same(prereqs.prerequisiteChain("discover", "extract"), [], "discover has nothing below it");

  console.log(`  table: 10 steps, ${Object.values(prereqs.STEP_PREREQUISITES).reduce((n, e) => n + e.length, 0)} edges, DAG, pre-production unordered`);
}

// ─── 2. a finished series passes ──────────────────────────────────────────────

/** Every gate opens when every step left what it declares. */
async function scenarioCompleteSeriesPasses() {
  const built = await series("complete-passes", true);
  for (const { name } of PIPELINE_STEPS) {
    const verdict = await prereqs.evaluatePrerequisites({ step: name, seriesDir: built.dir });
    ok(verdict.ok, `${name} is allowed after a finished run (${verdict.message})`);
  }

  // And the one thing that is a RECORD rather than a file in a volume folder: `extract`'s per-book
  // reports. Wipe them and every book-reading step closes, even though every artifact on disk is
  // still there.
  await fx.removeRunOutputs(built.ledgerDir, "extract", built.volumes);
  for (const name of ["glossary", "character-voice", "style-guide", "jump-in-wiki", "translate"]) {
    const verdict = await prereqs.evaluatePrerequisites({ step: name, seriesDir: built.dir });
    ok(!verdict.ok, `${name} refuses when extract's run records are gone (${verdict.message})`);
    ok(verdict.message.includes("extraction-"), `and it names the record that is missing: ${verdict.message}`);
  }
  console.log("  complete series: all ten gates open; wiping extract's records closes the five that read books");
}

// ─── 3–6. the refusals ────────────────────────────────────────────────────────

/** `translate` refuses when a volume's glossary is incomplete, and names the volume and the file. */
async function scenarioMissingGlossary() {
  const built = await series("no-glossary", true);
  await breakStepAt(built.dir, "glossary", "Test Story(02)", "02");
  const verdict = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: built.dir });
  ok(!verdict.ok, "translate refuses when volume 02's glossary is gone");
  ok(verdict.message.includes("volume 02"), `the refusal names the volume: ${verdict.message}`);
  ok(verdict.message.includes("glossary.md"), "the refusal names the missing file");
  ok(verdict.message.includes("npx gulp glossary"), "the refusal names the command to run");
  ok(verdict.message.includes("no override"), "the refusal says there is no flag");

  // A glossary that exists but is empty is not complete either.
  const stub = await series("stub-glossary", true);
  await fs.promises.writeFile(path.join(stub.dir, "Test Story(01)", "glossary.md"), "\n", "utf8");
  const stubVerdict = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: stub.dir });
  ok(!stubVerdict.ok, "a 1-character glossary.md is not a glossary");
  ok(stubVerdict.message.includes("empty or still holds a scaffold stub"), stubVerdict.message);

  // A glossary that exists with the wrong shape is not complete either.
  const wrong = await series("wrong-shape-glossary", true);
  await fs.promises.writeFile(
    path.join(wrong.dir, "Test Story(01)", "glossary.md"),
    "# Glossary\n\nA paragraph about the terms, with no table in it.\n",
    "utf8"
  );
  const wrongVerdict = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: wrong.dir });
  ok(!wrongVerdict.ok, "a glossary.md with no table is not the shape the step declares");
  ok(wrongVerdict.message.includes("table"), wrongVerdict.message);
  console.log("  missing / stub / wrong-shape glossary: translate refuses, naming volume 02 and glossary.md");
}

/** `translate` refuses on a missing character-voice reference even with a complete glossary, naming the chain. */
async function scenarioMissingCharacterVoice() {
  const built = await series("no-character-voice", true);
  await breakStep(built.dir, "character-voice", built.volumes);
  const verdict = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: built.dir });
  ok(!verdict.ok, "translate refuses when the character-voice reference is gone");
  ok(
    verdict.message.includes("`translate` needs `consistency-audit`, which needs `character-voice`"),
    `the refusal names the chain through the audit: ${verdict.message}`
  );
  ok(verdict.message.includes("character-voice.md"), "the refusal names the missing file");
  ok(verdict.message.includes("Run `npx gulp character-voice` first"), "the refusal names the command");
  // The glossary is intact, so it is not blamed.
  ok(!verdict.message.includes("glossary.md"), `only the real gap is named: ${verdict.message}`);
  console.log("  missing character-voice: translate refuses through the consistency-audit chain");
}

/** `polish` refuses before `translate-qa`; `translate-qa` refuses before `translate`. */
async function scenarioTranslationStageOrder() {
  const built = await series("stage-order", true);
  // Only the QA loop's own file is gone: the draft is there, the verdicts are not.
  await fs.promises.rm(path.join(built.dir, "Test Story(01)", "translation-verification.json"), { force: true });

  const polish = await prereqs.evaluatePrerequisites({ step: "polish", seriesDir: built.dir });
  ok(!polish.ok, "polish refuses when translate-qa has no verdicts");
  ok(polish.gaps.some((g) => g.step === "translate-qa"), `polish names translate-qa: ${polish.message}`);
  ok(polish.message.includes("translation-verification.json"), polish.message);

  // And with the draft gone, translate-qa itself refuses.
  await breakStepAt(built.dir, "translate", "Test Story(01)", "01");
  const qa = await prereqs.evaluatePrerequisites({ step: "translate-qa", seriesDir: built.dir });
  ok(!qa.ok, "translate-qa refuses when translate produced no draft");
  ok(qa.gaps.some((g) => g.step === "translate"), `translate-qa names translate: ${qa.message}`);
  ok(qa.message.includes("translation.md"), qa.message);
  console.log("  polish → translate-qa → translate: each refuses on the one below it");
}

/** `consistency-audit` refuses when any one of the four artifacts it audits is incomplete. */
async function scenarioAuditNeedsItsFour() {
  for (const missing of PREPRODUCTION) {
    const built = await series(`audit-missing-${missing}`, true);
    await breakStepAt(built.dir, missing, "Test Story(02)", "02");
    const verdict = await prereqs.evaluatePrerequisites({ step: "consistency-audit", seriesDir: built.dir });
    ok(!verdict.ok, `consistency-audit refuses when ${missing} is incomplete`);
    ok(verdict.gaps.some((g) => g.step === missing), `the audit names ${missing}: ${verdict.message}`);
  }
  console.log("  consistency-audit: refuses on each of the four artifacts it audits");
}

// ─── 7. the pre-production steps are unordered ────────────────────────────────

/** Three different orders of the four pre-production steps, and every step in every order is allowed. */
async function scenarioPreProductionOrderFree() {
  const orders = [
    ["glossary", "character-voice", "style-guide", "jump-in-wiki"],
    ["character-voice", "jump-in-wiki", "glossary", "style-guide"],
    ["style-guide", "jump-in-wiki", "character-voice", "glossary"],
  ];
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    const built = await series(`order-${i}`, false); // only the plan of record exists
    await fx.writeRunOutputs(built.ledgerDir, "extract", built.volumes); // pretend `extract` ran
    for (const step of order) {
      const verdict = await prereqs.evaluatePrerequisites({ step, seriesDir: built.dir });
      ok(verdict.ok, `${step} is allowed in the order ${order.join(" → ")} (${verdict.message})`);
      for (const v of built.volumes) await fx.writeVolumeOutputs(built.dir, v, step);
      await fx.writeSeriesOutputs(built.dir, step);
    }
    // The audit is the one that does care, and it opens only after all four.
    const audit = await prereqs.evaluatePrerequisites({ step: "consistency-audit", seriesDir: built.dir });
    ok(audit.ok, `consistency-audit opens after ${order.join(" → ")}`);
  }
  console.log(`  pre-production order: ${orders.length} orders, every step allowed in every one`);
}

// ─── 8. --volume narrows the check ────────────────────────────────────────────

/** A single-volume run is not blocked by an untouched volume 14; a whole-series run is. */
async function scenarioVolumeNarrowing() {
  const built = await series("narrowing", true);
  const untouched = await addUntouchedVolume(built, "14");

  const whole = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: built.dir });
  ok(!whole.ok, "a whole-series run IS blocked by the untouched volume 14");
  ok(whole.message.includes("volume 14"), `and it names it: ${whole.message}`);

  const narrowed = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: built.dir, volumeArg: "02" });
  ok(narrowed.ok, `--volume 02 is not blocked by volume 14 (${narrowed.message})`);

  // Narrowed ONTO the broken volume, it refuses and tells you to fix that volume.
  const onBroken = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: built.dir, volumeArg: "14" });
  ok(!onBroken.ok, "--volume 14 refuses on volume 14's own missing work");
  ok(onBroken.message.includes(`--volume ${untouched.installmentNumber}`), `and it says to rebuild that volume: ${onBroken.message}`);

  // A --volume that matches nothing is a gap, not a silent empty scope.
  const nonsense = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: built.dir, volumeArg: "99" });
  ok(!nonsense.ok, "--volume 99 is refused rather than quietly narrowing to nothing");
  ok(nonsense.message.includes("--volume 99"), nonsense.message);
  console.log("  --volume: narrows the check; an untouched volume 14 does not block volume 02");
}

// ─── 9. --dry-run reports and does not refuse ─────────────────────────────────

/** A dry run prints the verdict and lets the step continue into its own offline path. */
async function scenarioDryRunReports() {
  const built = await series("dry-run", false); // nothing built at all
  const res = await runChild([path.join(ROOT, "index.js"), "--stages=translate", "--dry-run"], {
    SERIES_LOCATION: built.dir,
    POSTMORTEM_DIR: built.ledgerDir,
  });
  ok(
    res.output.includes("DRY RUN, so the prerequisite gate reports and does NOT refuse"),
    `the dry run prints the verdict: ${res.output.slice(-600)}`
  );
  ok(res.output.includes("`translate` needs"), "and prints what is missing");
  ok(
    !res.output.includes("This gate has no override."),
    "the refusal wording never appears on the dry-run path — the gate did not refuse"
  );
  console.log("  --dry-run: the gate prints its verdict and does not refuse");
}

// ─── 10. no flag overrides it ─────────────────────────────────────────────────

/** `--force`, `--allow-fail`, the deleted `--allow-no-glossary`, `ON_TASK_ERROR=continue`, and a ledger that already recorded the failure. */
async function scenarioNoOverride() {
  const built = await series("no-override", false);
  const env = { SERIES_LOCATION: built.dir, POSTMORTEM_DIR: built.ledgerDir };

  const force = await runGulp("translate", ["--force"], env);
  ok(force.code !== 0, `--force does not open the gate (exit ${force.code})`);
  ok(force.output.includes("This gate has no override"), force.output.slice(-500));

  const allowFail = await runGulp("translate", ["--allow-fail"], env);
  ok(allowFail.code !== 0, "--allow-fail does not open the gate");
  ok(allowFail.output.includes("This gate has no override"), allowFail.output.slice(-500));

  const both = await runGulp("translate", ["--force", "--allow-fail", "--allow-no-glossary"], env);
  ok(both.code !== 0, "every override at once still does not open the gate");
  ok(both.output.includes("This gate has no override"), both.output.slice(-500));

  // The flag itself is gone from the code that used to read it.
  const reportSource = await fs.promises.readFile(path.join(ROOT, "utils/translation-report.js"), "utf8");
  const taskSource = await fs.promises.readFile(path.join(ROOT, "translate/task.js"), "utf8");
  ok(!reportSource.includes("allowNoGlossary"), "checkTranslationPreconditions no longer has an allowNoGlossary parameter");
  ok(!taskSource.includes("--allow-no-glossary"), "translate/task.js no longer reads --allow-no-glossary");
  // The ban entry stays, reworded.
  const banned = require("../utils/tickets/banned-options");
  const ban = banned.BANNED_OPTIONS.find((o) => o.id === "allow-fail-or-no-glossary");
  ok(Boolean(ban), "the banned-option entry for --allow-no-glossary is still there");
  ok(/NO LONGER EXISTS/.test(ban.because), "and it says the flag no longer exists");

  // ON_TASK_ERROR=continue cannot walk past it: the refusal is structural, so the runner stops.
  const cont = await runChild([path.join(ROOT, "index.js"), "--stages=translate,translate-qa"], {
    ...env,
    ON_TASK_ERROR: "continue",
  });
  ok(cont.code !== 0, "ON_TASK_ERROR=continue does not let the run finish");
  ok(cont.output.includes("failed STRUCTURALLY"), `the refusal is structural: ${cont.output.slice(-700)}`);
  ok(!cont.output.includes("=== translate-qa ==="), "translate-qa was never started");
  ok(cont.output.includes("stopped early"), cont.output.slice(-400));

  // A ledger that says this step already failed changes nothing: the gate is not a retry counter.
  appendLedgerEntry({
    kind: "assessment",
    step: "translate",
    volume: null,
    findings: { HIGH: 3, MEDIUM: 0, LOW: 0 },
    findingKinds: ["missing-required"],
    decidedBy: "runner",
    note: "a previous run already tried translate and it failed",
  });
  const again = await runGulp("translate", [], env);
  ok(again.code !== 0, "a ledger that already recorded this step failing does not open the gate");
  ok(again.output.includes("This gate has no override"), again.output.slice(-500));
  console.log("  --force / --allow-fail / --allow-no-glossary / ON_TASK_ERROR=continue / the ledger: none of them open the gate");
}

// ─── 11. a grade that failed, and a gate that fired ───────────────────────────

/** A failed acceptance grade is not complete; a `.rejected` whose artifact is gone is not complete; a re-render's kept copy and a repaired draft still are. */
async function scenarioGradeAndQuarantine() {
  const built = await series("grade-and-quarantine", true);
  const stateFile = path.join(built.dir, "Test Story(01)", "glossary-validation-rolling-state.json");
  await fs.promises.writeFile(
    stateFile,
    JSON.stringify({ results: [40, 55], acceptedBy: "rolling-window" }, null, 2),
    "utf8"
  );
  const graded = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: built.dir });
  ok(!graded.ok, "a volume whose acceptance window never met the criterion is not complete");
  ok(graded.message.includes("no passing acceptance grade"), graded.message);

  // The volume-15 shape: the output is gone and the gate's own evidence sits beside the gap.
  const quarantined = await series("quarantined", true);
  await fx.leaveGateEvidenceBesideTheGap(quarantined.dir, "Test Story(02)", "02", "character-voice");
  const q = await prereqs.evaluatePrerequisites({ step: "consistency-audit", seriesDir: quarantined.dir });
  ok(!q.ok, "a quarantined character-voice.md.rejected is not a completed character-voice step");
  ok(q.message.includes("character-voice.md.rejected"), q.message);

  // A quarantined translation DRAFT is different, and deliberately so: it is kept on purpose so
  // `retranslate` has something to repair (gotcha 39). Treating it as "not complete" would refuse
  // `polish` on a legitimately repaired book — gotcha 130's lesson.
  const repaired = await series("repaired-draft", true);
  await fs.promises.writeFile(
    path.join(repaired.dir, "Test Story(01)", "translation-ch3.rejected.md"),
    "the draft a later round repaired\n",
    "utf8"
  );
  const r = await prereqs.evaluatePrerequisites({ step: "polish", seriesDir: repaired.dir });
  ok(r.ok, `a kept-and-repaired draft does not block polish (${r.message})`);
  // What a quarantine means is decided beside the folder it sits in, not by its severity. The same
  // file blocks completion when the artifact it names is gone and does not when a re-render replaced
  // that artifact and kept the copy — which is the difference between a guard refusing a volume and
  // `npx gulp glossary --force` rebuilding one.
  const cumulative = STEP_ARTIFACT_SPECS.glossary.quarantines[0];
  const draft = STEP_ARTIFACT_SPECS.translate.quarantines[0];
  const installment = "01";
  ok(
    prereqs.quarantineBlocksCompletion(cumulative, {
      name: "glossary.md.rejected",
      spec: STEP_ARTIFACT_SPECS.glossary,
      installment,
      presentNames: new Set(["glossary-validation.md", "glossary.md.rejected"]),
    }) === true,
    "a cumulative quarantine with nothing in the refused artifact's place blocks completion"
  );
  ok(
    prereqs.quarantineBlocksCompletion(cumulative, {
      name: "glossary.md.rejected.2",
      spec: STEP_ARTIFACT_SPECS.glossary,
      installment,
      presentNames: new Set(["glossary-validation.md", "glossary.md.rejected.2"]),
    }) === true,
    "and the numbered one blocks exactly the same way"
  );
  ok(
    prereqs.quarantineBlocksCompletion(cumulative, {
      name: "glossary.md.rejected",
      spec: STEP_ARTIFACT_SPECS.glossary,
      installment,
      presentNames: new Set(["glossary.md", "glossary.md.rejected"]),
    }) === false,
    "the same file beside the artifact it names does not — that is a re-render, not a refusal"
  );
  ok(
    prereqs.quarantineBlocksCompletion(draft, {
      name: "translation-ch3.rejected.md",
      spec: STEP_ARTIFACT_SPECS.translate,
      installment,
      presentNames: new Set(["translation.md", "translation-state.json", "translation-ch3.rejected.md"]),
    }) === false,
    "a MEDIUM quarantine (a draft kept for repair) does not (gotcha 39)"
  );
  console.log("  failed grade and .rejected cumulative artifact: not complete; a re-render's kept copy and a repaired draft: still complete");
}

// ─── 12. every door ───────────────────────────────────────────────────────────

/** The five doors all end in a gulp task wrapper, and the wrapper is where the gate lives. */
async function scenarioEveryDoor() {
  const built = await series("doors", false);
  // A series with no plan of record at all: `discover` has never run, so every gated step must refuse
  // and none of them may reach its own task body.
  await fs.promises.rm(path.join(built.dir, "translation-target.json"), { force: true });
  const env = { SERIES_LOCATION: built.dir, POSTMORTEM_DIR: built.ledgerDir };

  // Door 1 — `npx gulp <step>`, typed at a terminal.
  const door1 = await runGulp("translate", [], env);
  ok(door1.code !== 0 && door1.output.includes("This gate has no override"), "door 1 (npx gulp translate): refused");

  // Door 2 — `npx gulp` (the default series). Its only move is `step.run()`, and every entry of
  // PIPELINE_STEPS is the same wrapped function the exports hand out, so gating those gates the run.
  same(
    PIPELINE_STEPS.filter((s) => prereqs.prerequisitesFor(s.name).length > 0).map((s) => s.run === GULPFILE[s.name]),
    GATED_STEPS.map(() => true),
    "the default run executes the same wrapped tasks the exports do"
  );
  const gulpSource = await fs.promises.readFile(path.join(ROOT, "gulpfile.js"), "utf8");
  ok(/for \(const step of PIPELINE_STEPS\)[\s\S]{0,200}await step\.run\(\)/.test(gulpSource), "the default run's only move is step.run()");
  let refusedInProcess = 0;
  for (const name of GATED_STEPS) {
    let err = null;
    try {
      await GULPFILE[name]();
    } catch (e) {
      err = e;
    }
    ok(Boolean(err) && /This gate has no override/.test(err.message), `door 2 (npx gulp default): ${name} refuses in the default run`);
    ok(Boolean(err) && err.structural === true, `${name}'s refusal is structural, so ON_TASK_ERROR=continue cannot pass it`);
    refusedInProcess++;
  }
  ok(refusedInProcess === GATED_STEPS.length, `all ${GATED_STEPS.length} gated steps refuse`);

  // Door 3 — `npm run pipeline -- --stages=a,b`.
  const door3 = await runChild([path.join(ROOT, "index.js"), "--stages=glossary,translate"], env);
  ok(door3.code !== 0 && door3.output.includes("This gate has no override"), "door 3 (npm run pipeline --stages=): refused");
  ok(!door3.output.includes("=== translate ==="), "and the later stage was never started");

  // Door 4 — `npm run delivery -- --mode=act`. Its default step runner spawns `index.js --stages=`,
  // which spawns gulp, so the gate sits on that path. Run it for real: a manager decides to re-run
  // `translate`, and `character-voice` is missing, so the gate refuses the manager's own choice.
  const actFixture = await series("delivery-act", true);
  await breakStepAt(actFixture.dir, "character-voice", "Test Story(02)", "02");
  const state = await resume.readWorkingState({ seriesDir: actFixture.dir });
  const realPlan = resume.planResume(state);
  const plan = {
    ...realPlan,
    seriesDir: actFixture.dir,
    steps: [{ action: "run", actionName: "re-run-step", step: "translate", flags: [], wipeFirst: [], fromVolume: null, finding: null }],
  };

  // The step runner streams the child's output onto this process's stderr, which is the only place
  // the refusal is visible from here.
  const chunks = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return realWrite(chunk, ...rest);
  };
  let act;
  try {
    act = await delivery.runActPlan({ plan, state });
  } finally {
    process.stderr.write = realWrite;
  }
  const streamed = chunks.join("");
  ok(act.execution.length === 1, `door 4 ran one step: ${JSON.stringify(act.execution.map((e) => e.step))}`);
  ok(act.execution[0].code !== 0, `door 4: the step did not finish (exit ${act.execution[0].code})`);
  ok(
    streamed.includes("This gate has no override"),
    `door 4 (npm run delivery --mode=act): the prerequisite gate refused the manager's own action\n${streamed.slice(-700)}`
  );
  ok(act.exitCode === 1, "and the manager stopped rather than running the steps after it");

  // Door 5 — `npm run autopilot -- --mode=act` shells out to `delivery.js --mode=act`, which is door 4.
  const commands = await fs.promises.readFile(path.join(ROOT, "autopilot/commands.js"), "utf8");
  ok(/"delivery\.js"\),\s*"--mode=act"/.test(commands), "door 5 (npm run autopilot --mode=act): its command is delivery.js --mode=act");
  console.log("  doors: gulp task, default gulp series, npm run pipeline, delivery --mode=act, autopilot --mode=act — all refused");
}

// ─── 13. a refusal writes nothing and costs no call ───────────────────────────

/** The series folder is byte-identical after a refusal, and no model call was made. */
async function scenarioWritesNothing() {
  const built = await series("writes-nothing", false);
  // The records go OUTSIDE the series folder for this scenario, so the snapshot is the corpus and
  // nothing else: the runner's own ledger entry is the runner writing its memory, which is not what
  // "the gate writes nothing" is about.
  const records = path.join(FIXTURES, "writes-nothing-records");
  await fs.promises.rm(records, { recursive: true, force: true });
  await fs.promises.mkdir(records, { recursive: true });
  const postMortem = path.join(records, "postmortem");
  const env = { SERIES_LOCATION: built.dir, POSTMORTEM_DIR: postMortem, RUN_DIR: records };
  process.env.POSTMORTEM_DIR = postMortem;
  process.env.RUN_DIR = records;

  const before = await snapshot(built.dir);
  const res = await runChild([path.join(ROOT, "index.js"), "--stages=translate"], env);
  ok(res.code !== 0, "the step failed");
  ok(res.output.includes("This gate has no override"), "on the gate");

  const after = await snapshot(built.dir);
  const added = after.filter((l) => !before.includes(l));
  same(added, [], `the series folder is exactly as it was; added: ${added.join(" | ")}`);

  // No transcript was written, which is the pipeline's own record of a model call.
  let logs = [];
  try {
    logs = await fs.promises.readdir(path.join(records, "logs"));
  } catch {
    logs = [];
  }
  same(logs, [], "no transcript exists, so no model call was made");
  console.log("  a refusal writes nothing into the series and makes no model call");
}

// ─── 14. the table is a closed path ───────────────────────────────────────────

/** The dev team may not edit the table, and may not edit the test that pins it. */
async function scenarioClosedPath() {
  for (const file of ["utils/prereqs.js", "utils/prereqs/anything.js"]) {
    const verdict = patchPathIsBanned(file);
    ok(verdict.banned, `${file} is a banned patch path`);
    same(verdict.rule.id, "constraint-tables", `${file} is banned as a constraint table`);
  }
  const testVerdict = patchPathIsBanned("test/test-prerequisite-gate.js");
  ok(testVerdict.banned, "this file is a banned patch path");
  same(testVerdict.rule.id, "constraint-tests", "this file is banned as a constraint test");
  console.log("  utils/prereqs.js is in constraint-tables and test/test-prerequisite-gate.js is in constraint-tests");
}

// ─── runner ───────────────────────────────────────────────────────────────────

const scenarios = [
  ["the table", scenarioTable],
  ["a finished series", scenarioCompleteSeriesPasses],
  ["missing glossary", scenarioMissingGlossary],
  ["missing character-voice", scenarioMissingCharacterVoice],
  ["translation stage order", scenarioTranslationStageOrder],
  ["the audit and its four artifacts", scenarioAuditNeedsItsFour],
  ["pre-production order", scenarioPreProductionOrderFree],
  ["--volume narrowing", scenarioVolumeNarrowing],
  ["--dry-run", scenarioDryRunReports],
  ["no override", scenarioNoOverride],
  ["grade and quarantine", scenarioGradeAndQuarantine],
  ["every door", scenarioEveryDoor],
  ["writes nothing", scenarioWritesNothing],
  ["closed path", scenarioClosedPath],
];

(async () => {
  await fs.promises.mkdir(EMPTY_HOOKS, { recursive: true });
  await fs.promises.mkdir(FIXTURES, { recursive: true });
  console.log(`prerequisite gate — ${FIXTURES}`);
  for (const [label, run] of scenarios) {
    const started = Date.now();
    await run();
    console.log(`  (${label}: ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
  console.log(`\nOK: the prerequisite gate refuses every unfinished step (${checks} checks).`);
})().catch((err) => {
  console.error(`\nFAILED: ${err && err.message}`);
  if (err && err.stack) console.error(String(err.stack).split("\n").slice(0, 12).join("\n"));
  process.exitCode = 1;
});

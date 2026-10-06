/**
 * test-ledger.js — the run's memory of what it already tried, and proof the veto has teeth.
 *
 * Why this suite exists and why it plants its own repeats. The delivery-manager design
 * gives an agent authority to re-run steps, wipe a volume's outputs and cascade. The
 * predictable failure is not danger, it is SPINNING: a finding appears, the step is
 * re-run, the same finding appears again, it is re-run again, and a 12-hour run ends
 * where it started. Volume 15 of the live series is exactly that shape — a deterministic
 * gate quarantining the same good file on every attempt, because the finding was never
 * about the data.
 *
 * So the checks here are the two halves, same as test-postmortem.js:
 *   1. A healthy run is never blocked. A veto that fires on normal work is a veto that
 *      gets disabled (gotcha 65's lesson, in its general form).
 *   2. A repeat that has already failed to help IS blocked, and the refusal explains
 *      itself and names what to do instead (open a ticket).
 *
 * Also pinned: only repetition is blocked (a different action is a new attempt); an
 * attempt that improved something is not evidence against trying again; a ledger that
 * cannot be read is treated as spinning rather than as empty; the veto is scoped to one
 * run, because after a real fix the same action in a new run is legitimate; and a
 * finding class that survived an earlier run is reported, because that is the free
 * signal that a problem is structural.
 *
 * Why the index.js scenario builds its own throwaway series. An earlier version of this
 * suite spawned a real step with only `AI_API_KEY` blanked, and `SERIES_LOCATION` still
 * came from `.env` — so the child read the live 17-volume series and wrote a
 * `translation-report.md` at its root. A test that exercises the runner must not be able
 * to touch the work the runner is delivering. The fixture carries a committed plan of
 * record, which is also what keeps the intake agent (and therefore any model call) out
 * of the picture: `readUsableManifest` returns the fixture's manifest.
 *
 * No network, no endpoint, no model call. Run with `npm test` (or standalone:
 * `node test/test-ledger.js`).
 */
const assert = require("assert");
const fs = require("fs").promises;
const syncFs = require("fs");
const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");

const {
  ledgerPath,
  runId,
  readLedger,
  appendLedgerEntry,
  attemptCount,
  unhelpfulAttempts,
  isSpinning,
  interventionAllowed,
  recurringFindings,
  tokensForRun,
  renderLedgerMarkdown,
} = require("../utils/ledger");

const TMP = path.join(os.tmpdir(), "oresuki-ledger-test");

/**
 * A fresh ledger file for one scenario.
 * @param {string} name
 * @returns {{dir: string, file: string}}
 */
async function freshLedger(name) {
  const dir = path.join(TMP, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return { dir, file: path.join(dir, "ledger.json") };
}

/** One intervention entry, spelled out so each scenario reads clearly. */
function intervention(run, step, volume, finding, action, outcome, extra = {}) {
  return appendLedgerEntry(
    {
      kind: "intervention",
      run,
      step,
      volume,
      finding,
      action,
      outcome,
      decidedBy: "manager",
      ...extra,
    },
    extra.file
  );
}

function assessment(run, step, findingKinds, counts = { HIGH: 1, MEDIUM: 0, LOW: 0 }, file) {
  return appendLedgerEntry(
    { kind: "assessment", run, step, findings: counts, findingKinds, decidedBy: "runner" },
    file
  );
}

// ─── 1. A first run has no memory, and that is not an error ───────────────────

async function scenarioEmptyIsNotFailure() {
  const { file } = await freshLedger("empty");
  const ledger = readLedger(file);
  assert.deepStrictEqual(ledger.entries, [], "a first run must read as empty");
  assert.strictEqual(ledger.error, null, "a missing ledger is the normal state, not a fault");

  const decision = interventionAllowed(
    { step: "glossary", volume: "15", finding: "quarantine-present", action: "wipe-and-rerun" },
    { dir: path.dirname(file), run: "run-1" }
  );
  assert.strictEqual(decision.allowed, true, "nothing may be blocked on a series that has never been recorded");
  assert.strictEqual(decision.attempts, 0);
}

// ─── 2. A healthy run is never blocked ────────────────────────────────────────

async function scenarioCleanRunNotBlocked() {
  const { dir, file } = await freshLedger("clean");
  assessment("run-1", "glossary", [], { HIGH: 0, MEDIUM: 0, LOW: 0 }, file);
  assessment("run-1", "jump-in-wiki", [], { HIGH: 0, MEDIUM: 0, LOW: 0 }, file);

  const ledger = readLedger(file);
  assert.strictEqual(ledger.entries.length, 2, "assessments are recorded");

  // Nothing was decided, so nothing can be a repeat.
  const decision = interventionAllowed(
    { step: "glossary", volume: "15", finding: "missing-required", action: "wipe-and-rerun" },
    { dir, run: "run-1" }
  );
  assert.strictEqual(decision.allowed, true, "a clean series must not be vetoed");

  const interventions = ledger.entries.filter((e) => e.kind === "intervention");
  assert.strictEqual(interventions.length, 0, "a clean run records no interventions");
  assert.ok(
    renderLedgerMarkdown(ledger.entries, "run-1").includes("nothing was decided"),
    "the human-facing summary must say plainly that nothing was decided"
  );
}

// ─── 3. The third identical attempt is refused, and says why ──────────────────

async function scenarioSpinRefused() {
  const { dir, file } = await freshLedger("spin");
  const key = { step: "glossary", volume: "15", finding: "quarantine-present", action: "wipe-and-rerun" };

  for (let i = 0; i < 2; i++) {
    const before = interventionAllowed(key, { dir, run: "run-1" });
    assert.strictEqual(before.allowed, true, `attempt ${i + 1} must be allowed (only the third is refused)`);
    intervention("run-1", key.step, key.volume, key.finding, key.action, "unchanged", { file });
  }

  const third = interventionAllowed(key, { dir, run: "run-1" });
  assert.strictEqual(third.allowed, false, "the third identical attempt must be refused");
  assert.strictEqual(third.unhelpful, 2);
  assert.ok(third.reason.includes("wipe-and-rerun"), `the refusal must name the action: ${third.reason}`);
  assert.ok(third.reason.includes("quarantine-present"), `the refusal must name the finding: ${third.reason}`);
  assert.ok(third.reason.includes("volume 15"), `the refusal must name the volume: ${third.reason}`);
  assert.ok(
    third.reason.includes("diagnostics"),
    `a refusal must point at the next step, not just say no: ${third.reason}`
  );

  const ledger = readLedger(file);
  assert.strictEqual(
    ledger.entries.filter((e) => e.kind === "intervention").length,
    2,
    "a refused action is not recorded as having happened"
  );
}

// ─── 4. Only repetition is blocked ────────────────────────────────────────────

async function scenarioDifferentActionIsNew() {
  const { dir, file } = await freshLedger("different");
  const finding = "missing-required";

  intervention("run-1", "glossary", "15", finding, "wipe-and-rerun", "unchanged", { file });
  intervention("run-1", "glossary", "15", finding, "wipe-and-rerun", "unchanged", { file });

  const same = interventionAllowed(
    { step: "glossary", volume: "15", finding, action: "wipe-and-rerun" },
    { dir, run: "run-1" }
  );
  assert.strictEqual(same.allowed, false, "the repeated action is exhausted");

  const different = interventionAllowed(
    { step: "glossary", volume: "15", finding, action: "re-run-with-chunked" },
    { dir, run: "run-1" }
  );
  assert.strictEqual(different.allowed, true, "a different action against the same finding is a new attempt");

  // And a different volume is a different problem.
  const otherVolume = interventionAllowed(
    { step: "glossary", volume: "16", finding, action: "wipe-and-rerun" },
    { dir, run: "run-1" }
  );
  assert.strictEqual(otherVolume.allowed, true, "one volume's exhausted action is not another volume's");
}

// ─── 5. An attempt that helped is not evidence against trying again ───────────

async function scenarioImprovedIsNotSpinning() {
  const { dir, file } = await freshLedger("improved");
  const key = { step: "character-voice", volume: "03", finding: "wrong-shape", action: "wipe-and-rerun" };

  intervention("run-1", key.step, key.volume, key.finding, key.action, "improved", { file });
  intervention("run-1", key.step, key.volume, key.finding, key.action, "improved", { file });

  const ledger = readLedger(file);
  assert.strictEqual(unhelpfulAttempts(ledger.entries, key, { run: "run-1" }), 0, "an improvement is not unhelpful");
  assert.strictEqual(isSpinning(ledger.entries, key, { run: "run-1" }), false);
  assert.strictEqual(attemptCount(ledger.entries, key, { run: "run-1" }), 2, "the attempts are still counted");

  const decision = interventionAllowed(key, { dir, run: "run-1" });
  assert.strictEqual(decision.allowed, true, "work that is making progress must not be vetoed");

  // `worse` counts: an action that damaged something is the strongest reason not to repeat it.
  intervention("run-1", key.step, key.volume, key.finding, key.action, "worse", { file });
  intervention("run-1", key.step, key.volume, key.finding, key.action, "worse", { file });
  const after = interventionAllowed(key, { dir, run: "run-1" });
  assert.strictEqual(after.allowed, false, "two attempts that made it worse must be refused");
  assert.ok(after.reason.includes("without changing anything"), after.reason);
}

// ─── 6. The veto is scoped to one run ─────────────────────────────────────────

async function scenarioRunScoping() {
  const { dir, file } = await freshLedger("scoped");
  const key = { step: "glossary", volume: "15", finding: "quarantine-present", action: "wipe-and-rerun" };

  intervention("run-1", key.step, key.volume, key.finding, key.action, "unchanged", { file });
  intervention("run-1", key.step, key.volume, key.finding, key.action, "unchanged", { file });
  assert.strictEqual(interventionAllowed(key, { dir, run: "run-1" }).allowed, false);

  // A new run is a new situation: after a real fix, the same action is legitimate again.
  const nextRun = interventionAllowed(key, { dir, run: "run-2" });
  assert.strictEqual(nextRun.allowed, true, "a veto must not become a permanent ban on an action");
  assert.ok(
    nextRun.attempts === 0,
    "per-run counting is what keeps the ledger from freezing the pipeline"
  );
}

// ─── 7. A ledger that cannot be read is never treated as empty ────────────────

async function scenarioCorruptLedger() {
  const { dir, file } = await freshLedger("corrupt");
  await fs.writeFile(file, "{ this is not JSON, and it must not be treated as empty\n", "utf8");

  const ledger = readLedger(file);
  assert.deepStrictEqual(ledger.entries, []);
  assert.ok(ledger.error && ledger.error.includes("not valid JSON"), `corruption must be reported: ${ledger.error}`);

  const decision = interventionAllowed(
    { step: "glossary", volume: "15", finding: "quarantine-present", action: "wipe-and-rerun" },
    { dir, run: "run-1" }
  );
  assert.strictEqual(
    decision.allowed,
    false,
    "blind is not the same as clear: refusing is recoverable, spinning is not"
  );
  assert.ok(decision.reason.includes("refused"), decision.reason);
  assert.ok(decision.error, "the decision must carry the underlying fault, not hide it");

  // Half-readable: entries that are unusable are skipped, and that is said out loud.
  await fs.writeFile(
    file,
    JSON.stringify({ schema: 1, entries: [{ id: "run-1/glossary/1", run: "run-1", step: "glossary", kind: "assessment" }, { nonsense: true }] }, null, 2),
    "utf8"
  );
  const partial = readLedger(file);
  assert.strictEqual(partial.entries.length, 1, "usable entries survive");
  assert.ok(partial.error && partial.error.includes("unreadable"), `the skipped half must be reported: ${partial.error}`);
}

// ─── 8. Append-only, unique ids, and a ceiling that says it trimmed ───────────

async function scenarioAppendOnlyAndCeiling() {
  const { file } = await freshLedger("append");
  for (let i = 0; i < 5; i++) {
    assessment("run-1", "glossary", ["missing-required"], { HIGH: 1, MEDIUM: 0, LOW: 0 }, file);
  }
  const ledger = readLedger(file);
  assert.strictEqual(ledger.entries.length, 5);
  const ids = ledger.entries.map((e) => e.id);
  assert.strictEqual(new Set(ids).size, 5, "ids must be unique — a ticket has to be able to cite one");
  assert.deepStrictEqual(
    ledger.entries.map((e) => e.id),
    ["run-1/glossary/1", "run-1/glossary/2", "run-1/glossary/3", "run-1/glossary/4", "run-1/glossary/5"],
    "sequence must increment per run and step"
  );
  assert.deepStrictEqual(
    ledger.entries.map((e) => e.at),
    [...ledger.entries.map((e) => e.at)].sort(),
    "the ledger is a record of what happened, in order"
  );

  process.env.LEDGER_MAX_ENTRIES = "100";
  for (let i = 0; i < 120; i++) {
    assessment("run-2", "glossary", ["missing-required"], { HIGH: 1, MEDIUM: 0, LOW: 0 }, file);
  }
  const trimmed = readLedger(file);
  assert.strictEqual(trimmed.entries.length, 100, "the ceiling holds");
  assert.strictEqual(trimmed.truncated, 25, "the trim must be recorded, not silent");
  assert.strictEqual(trimmed.entries[0].run, "run-2", "the OLDEST entries are dropped, not the recent ones");
  delete process.env.LEDGER_MAX_ENTRIES;
}

// ─── 9. What survives a re-run is reported for free ───────────────────────────

async function scenarioRecurringFindings() {
  const { file } = await freshLedger("recurring");
  assessment("run-1", "glossary", ["quarantine-present", "missing-required"], { HIGH: 3, MEDIUM: 0, LOW: 0 }, file);
  assessment("run-2", "glossary", ["quarantine-present"], { HIGH: 1, MEDIUM: 0, LOW: 0 }, file);
  assessment("run-2", "polish", ["chapter-without-draft"], { HIGH: 1, MEDIUM: 0, LOW: 0 }, file);

  const ledger = readLedger(file);
  const recurring = recurringFindings(ledger.entries, "run-2");
  const kinds = recurring.map((r) => r.finding);

  assert.ok(kinds.includes("quarantine-present"), "a finding that came back must be named");
  assert.ok(!kinds.includes("missing-required"), "a finding that did NOT come back is not recurring");
  assert.ok(!kinds.includes("chapter-without-draft"), "a finding seen in only one run is not recurring");

  const quarantine = recurring.find((r) => r.finding === "quarantine-present");
  assert.strictEqual(quarantine.runs, 2);
  assert.deepStrictEqual(quarantine.steps, ["glossary"], "it must name the step it keeps appearing on");

  // The point of the whole module, stated as an assertion: this is the free signal that
  // a re-run is not the answer.
  assert.ok(
    recurring.length > 0,
    "a finding class that survived a re-run must be visible without a model call"
  );
}

// ─── 10. Costs are attributable ───────────────────────────────────────────────

async function scenarioTokens() {
  const { file } = await freshLedger("tokens");
  intervention("run-1", "glossary", "15", "missing-required", "wipe-and-rerun", "unchanged", { file, tokens: 1_800_000 });
  intervention("run-1", "glossary", "16", "missing-required", "wipe-and-rerun", "unchanged", { file, tokens: 200_000 });
  intervention("run-2", "glossary", "15", "missing-required", "wipe-and-rerun", "improved", { file, tokens: 50_000 });

  const ledger = readLedger(file);
  assert.strictEqual(tokensForRun(ledger.entries, "run-1"), 2_000_000);
  assert.strictEqual(tokensForRun(ledger.entries, "run-2"), 50_000);

  const md = renderLedgerMarkdown(ledger.entries, "run-1");
  assert.ok(md.includes("wipe-and-rerun"), "the human summary must name the actions taken");
  assert.ok(md.includes("unchanged"), "and their outcomes");
  assert.ok(md.includes("v15"), "and the volumes they touched");
}

// ─── 11. An intervention needs a complete key before it can be allowed ────────

async function scenarioIncompleteKey() {
  const { dir } = await freshLedger("incomplete");
  const decision = interventionAllowed({ step: "glossary" }, { dir, run: "run-1" });
  assert.strictEqual(decision.allowed, false, "a half-specified intervention cannot be checked");
  assert.ok(decision.reason.includes("step") && decision.reason.includes("action"), decision.reason);
}

// ─── 12. index.js wiring, without calling a model or touching a real series ───

/**
 * A throwaway series with a committed plan of record.
 *
 * Why the fixture exists rather than pointing at whatever `.env` says: an earlier version
 * of this test spawned a real step with only `AI_API_KEY` blanked, and `SERIES_LOCATION`
 * still came from `.env` — so the child read the live 17-volume series and wrote a
 * `translation-report.md` at its root. A test must not be able to touch the work it is
 * testing the delivery of. The committed manifest is what keeps the intake agent out of
 * the picture: `readUsableManifest` returns it, so no model call is ever attempted.
 *
 * @param {string} name
 * @returns {Promise<{dir: string, ledgerDir: string}>}
 */
async function fixtureSeries(name) {
  const dir = path.join(TMP, `${name}-series`);
  const ledgerDir = path.join(TMP, `${name}-ledger`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(ledgerDir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, "Test Story(01)"), { recursive: true });
  await fs.mkdir(ledgerDir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "Test Story(01)", "test-01.md"),
    "# Test story\n\n主人公はテストをする。\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(dir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: dir,
        seriesName: "Test Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test-ledger.js",
        generatedAt: new Date().toISOString(),
        volumes: [
          {
            folder: "Test Story(01)",
            sourceFile: "Test Story(01)/test-01.md",
            installmentNumber: "01",
            title: "Test Story",
            // `integrity.basis` has a 20-character floor on purpose (validateVolumeIntegrity):
            // a gate the intake agent can pass by saying nothing is not a gate.
            integrity: {
              isNarrative: true,
              confidence: 0.9,
              basis: "fixture: one headed section of continuous prose, one volume, no packaging pages",
            },
          },
        ],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return { dir, ledgerDir };
}

async function scenarioIndexWiring() {
  const root = path.resolve(__dirname, "..");
  const { dir: seriesDir, ledgerDir } = await fixtureSeries("index");
  // AI_API_KEY blanked as a second lock: validateRequiredEnv treats an empty value as
  // missing, and dotenv does not overwrite a key already present (verified on this
  // machine). SERIES_LOCATION points at the fixture, so nothing can reach the real series.
  const env = {
    ...process.env,
    SERIES_LOCATION: seriesDir,
    POSTMORTEM_DIR: ledgerDir,
    AI_API_KEY: "",
  };
  const ledgerFile = path.join(ledgerDir, "ledger.json");

  const run = (args, runIdValue) =>
    spawnSync(process.execPath, [path.join(root, "index.js"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, INDEX_RUN_ID: runIdValue },
      timeout: 180000,
    });

  // --list writes nothing: it is a question, not a run.
  const listed = run(["--list"], "list-run");
  assert.strictEqual(listed.status, 0, listed.stderr);
  assert.ok(!syncFs.existsSync(ledgerFile), "--list must not write a ledger");

  // A real (deterministic, no-AI) step against the fixture: the runner announces the
  // ledger, and the ledger is actually written.
  const on = run(["--stages=translation-report"], "wire-run");
  const onOut = `${on.stdout}\n${on.stderr}`;
  assert.ok(on.stdout.includes("ledger: on"), `the runner must report its ledger state: ${onOut}`);
  assert.ok(
    !onOut.includes("running the intake agent"),
    "the fixture's committed plan of record must be reused — an intake run here means a model call"
  );
  assert.ok(!onOut.includes("AI_API_KEY"), `nothing in this suite may need an endpoint: ${onOut}`);
  assert.strictEqual(on.status, 0, `the fixture step must succeed: ${onOut}`);
  assert.ok(syncFs.existsSync(ledgerFile), `the ledger must be written: ${ledgerFile}`);
  assert.ok(
    syncFs.existsSync(path.join(seriesDir, "translation-report.md")),
    "the step itself must have run — inside the fixture, which is the point of the fixture"
  );

  const written = readLedger(ledgerFile);
  assert.ok(written.entries.length >= 1, "the assessed step must be recorded");
  const assessment = written.entries.find((e) => e.step === "translation-report");
  assert.ok(assessment, `the step must appear in the ledger: ${JSON.stringify(written.entries)}`);
  assert.strictEqual(assessment.kind, "assessment");
  assert.strictEqual(assessment.decidedBy, "runner");
  assert.strictEqual(assessment.run, "wire-run");

  // --dry-run writes nothing at all, ledger included.
  const dry = run(["--stages=translation-report", "--dry-run"], "dry-run");
  assert.ok(dry.stdout.includes("ledger: off (dry-run)"), `--dry-run must disable the ledger: ${dry.stdout}`);
  const afterDry = readLedger(ledgerFile);
  assert.ok(
    !afterDry.entries.some((e) => e.run === "dry-run"),
    "a dry run must add nothing to the ledger"
  );

  // --ledger=off is honoured on a live-shaped run.
  const off = run(["--stages=translation-report", "--ledger=off"], "off-run");
  assert.ok(off.stdout.includes("ledger: off"), `--ledger=off must be reported: ${off.stdout}`);
  assert.ok(
    !readLedger(ledgerFile).entries.some((e) => e.run === "off-run"),
    "--ledger=off must record nothing"
  );

  const bogus = run(["--stages=not-a-step"], "bogus-run");
  assert.strictEqual(bogus.status, 1, "an unknown step must still fail loudly");
  assert.ok(bogus.stderr.includes("not a pipeline step"), bogus.stderr);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });

  await scenarioEmptyIsNotFailure();
  console.log("ledger: a first run has no memory, and that is not treated as a fault");

  await scenarioCleanRunNotBlocked();
  console.log("ledger: a healthy run is never blocked");

  await scenarioSpinRefused();
  console.log("ledger: the third identical attempt is refused, and names what to do instead");

  await scenarioDifferentActionIsNew();
  console.log("ledger: only repetition is blocked — a different action is a new attempt");

  await scenarioImprovedIsNotSpinning();
  console.log("ledger: work that improves is never vetoed; work that damages is");

  await scenarioRunScoping();
  console.log("ledger: the veto is scoped to one run, so a fix is not frozen out");

  await scenarioCorruptLedger();
  console.log("ledger: a ledger that cannot be read is never treated as empty");

  await scenarioAppendOnlyAndCeiling();
  console.log("ledger: append-only, citable ids, and a ceiling that admits it trimmed");

  await scenarioRecurringFindings();
  console.log("ledger: what survives a re-run is reported without a model call");

  await scenarioTokens();
  console.log("ledger: cost is attributable to the decision that spent it");

  await scenarioIncompleteKey();
  console.log("ledger: a half-specified intervention is refused rather than guessed at");

  await scenarioIndexWiring();
  console.log("ledger: index.js records assessments, honours --ledger=off, and stays inside its fixture series");

  console.log("ledger: all checks passed.");
})().catch((err) => {
  console.error(`ledger test failed: ${err.message}`);
  process.exit(1);
});

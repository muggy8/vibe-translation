/**
 * test-task-failure.js — the "a task that failed volumes fails the run" contract.
 *
 * Every per-volume loop is wrapped in a try/catch so an un-monitored run can keep
 * going (ON_VOLUME_ERROR=skip). That is the point of the policy — but "keep going"
 * must not mean "report success". The four pre-production tasks used to print a
 * failure summary and exit 0, so an overnight run in which every volume was broken
 * looked like a clean run and the pipeline marched straight into the audit and the
 * translation stage with half the artifacts missing.
 *
 * `volumeFailureError` (configs/shared.js) is the single gate every task throws at
 * the end of its volume loop. This file pins three things:
 *   1. the pure helper (what it returns, and what it refuses to return),
 *   2. that EVERY task module actually wires it (a source scan — a task that
 *      forgets it silently reintroduces the bug),
 *   3. a live task run: one broken volume, ON_VOLUME_ERROR=skip, and the task
 *      still rejects — plus the structural-error case, which is never skippable.
 *
 * No network, no real endpoint: the AI layer is stubbed and the intake manifest is
 * stubbed too. Run with `npm test` (or standalone: `node test/test-task-failure.js`).
 * The live scenarios run in a spawned child because the run policies
 * (ON_VOLUME_ERROR) are read at module load.
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const childScenario = process.argv.find((a) => a.startsWith("--child="))?.replace("--child=", "") || null;

// Pin the run policies + acceptance config so the scenarios are deterministic
// regardless of the local .env.
process.env.PASSING_SCORE = "70";
process.env.ACCEPTANCE_PASSING_SCORE = "70";
process.env.ACCEPTANCE_WINDOW_SIZE = "2";
process.env.QA_MAX_ITERATIONS = "2";
process.env.RESEARCH_ENABLED = "false";
process.env.AGENT_RECOVERY_ENABLED = "false";
process.env.ON_VOLUME_ERROR = "skip";
process.env.ON_MISSING_PREVIOUS = "skip";
process.env.ON_TASK_ERROR = "continue";
// Never contacted: the harness is stubbed before any task runs.
process.env.AI_API_KEY = "test-key";
process.env.AI_BASE_URL = "http://127.0.0.1:1/v1";
process.env.AI_MODEL = "local";

const { volumeFailureError, structuralError, isStructuralError } = require("../configs/shared");

// ─── volumeFailureError (pure) ───────────────────────────────────────────────

{
  // Nothing failed → nothing to fail on (callers publish first, then throw).
  assert.strictEqual(volumeFailureError("glossary", [], 3), null, "no failures → no error");
  assert.strictEqual(volumeFailureError("glossary", null, 3), null, "a missing list is not a failure");
  assert.strictEqual(volumeFailureError("glossary", [], 0), null, "an empty run is not a failure");

  // One failed volume → an error that names the task, the count, and the reason.
  const one = volumeFailureError(
    "character-voice",
    [{ folder: "Book(02)", installmentNumber: "02", error: new Error("boom") }],
    5
  );
  assert.ok(one instanceof Error, "a failure returns an Error to throw");
  assert.ok(one.message.includes("character-voice: 1 of 5 volume(s) failed"), `message names the task and count: ${one.message}`);
  assert.ok(one.message.includes("02 (boom)"), "the message carries the volume's own reason");
  assert.ok(one.message.includes("Re-run"), "and says how to recover");

  // Several failures are all listed, and a bare folder string still works.
  const many = volumeFailureError("style-guide", ["Book(01)", { installmentNumber: "03" }], 4);
  assert.ok(many.message.includes("2 of 4 volume(s) failed"), many.message);
  assert.ok(many.message.includes("Book(01) (volume failed)"), many.message);
  assert.ok(many.message.includes("03 (failed)"), many.message);

  // It is a plain Error, NOT a structural one: a volume failure is what
  // ON_VOLUME_ERROR=skip exists for, and the run-level summary is what reports it.
  assert.strictEqual(isStructuralError(one), false, "a volume-failure summary is not a structural error");
}

// ─── structuralError (the failure no skip policy walks past) ─────────────────

{
  const s = structuralError("the source file vanished");
  assert.ok(s instanceof Error);
  assert.strictEqual(isStructuralError(s), true, "a structural error is recognisable");
  assert.ok(s.message.includes("source file vanished"));
  assert.strictEqual(isStructuralError(new Error("ordinary")), false, "an ordinary error is not structural");
  assert.strictEqual(isStructuralError(null), false, "null is not structural");
}

// ─── every task wires the gate (a forgotten wiring is the same bug) ──────────

const TASK_FILES = [
  ["glossary.js", "glossary"],
  ["character-voice.js", "character-voice"],
  ["style-guide.js", "style-guide"],
  ["jump-in-wiki.js", "jump-in-wiki"],
  ["translate.js", "translate"],
  ["verify-translate.js", "verify-translate"],
  ["retranslate.js", "retranslate"],
  ["polish.js", "polish"],
];

for (const [file, taskName] of TASK_FILES) {
  const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  assert.ok(
    /require\("\.\/configs\/shared"\)/.test(src) && /volumeFailureError/.test(src),
    `${file} imports volumeFailureError from configs/shared`
  );
  assert.ok(
    new RegExp(`volumeFailureError\\("${taskName}"`).test(src),
    `${file} builds its failure summary under its own task name`
  );
  assert.ok(
    /if \(volumeError\) \{?\s*throw/.test(src),
    `${file} throws the summary (a summary that is only logged is the original bug)`
  );
  // The per-volume catch must NOT let a structural failure be skipped.
  assert.ok(
    /isStructuralError\(err\)/.test(src),
    `${file} treats a structural failure as un-skippable even with ON_VOLUME_ERROR=skip`
  );
}

// The same rule at the STEP level: the default run's ON_TASK_ERROR=continue must
// not walk past a structural failure (no plan of record, vanished source) — every
// remaining step would fail on the same missing foundation, and each attempt
// costs a model container switch.
{
  const src = fs.readFileSync(path.join(__dirname, "..", "gulpfile.js"), "utf8");
  assert.ok(
    /require\("\.\/configs\/shared"\)/.test(src) && /isStructuralError\(err\)/.test(src),
    "gulpfile.js stops the default run on a structural step failure even with ON_TASK_ERROR=continue"
  );
}

// ─── live scenarios (spawned: the policies are read at module load) ──────────

/**
 * A temp series with two plain-text volumes, and the manifest the intake step
 * would have produced for it.
 *
 * @returns {{seriesDir: string, manifest: Object}}
 */
function makeSeries() {
  const seriesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-taskfail-"));
  const volumes = [];
  for (const [folder, installment] of [["Book(01)", "01"], ["Book(02)", "02"]]) {
    const volumeDir = path.join(seriesDir, folder);
    fs.mkdirSync(volumeDir, { recursive: true });
    fs.writeFileSync(
      path.join(volumeDir, `${folder}.md`),
      `# Chapter\n\nBody text for ${folder}. 本文テキスト。\n`,
      "utf8"
    );
    volumes.push({
      folder,
      sourceFile: `${folder}/${folder}.md`,
      installmentNumber: installment,
      title: folder,
      integrity: { isNarrative: true, confidence: 0.9, basis: "test fixture" },
    });
  }
  return {
    seriesDir,
    manifest: {
      schema: 2,
      seriesName: "Book",
      seriesLocation: seriesDir,
      sourceLanguage: "Japanese",
      targetLanguage: "English",
      discovery: { summary: "fixture", confidence: 0.9, evidence: [], excluded: [] },
      volumes,
    },
  };
}

/**
 * Stub the AI layer and the intake step. The intake is patched on the module
 * object BEFORE the task module is required, because the task destructures
 * `getTranslationTarget` at load time.
 *
 * @param {Object} manifest - The manifest the intake step would have written.
 * @param {{failInstallments?: string[]}} opts - Installment numbers whose model calls throw.
 * @returns {void}
 */
function installStubs(manifest, { failInstallments = [] } = {}) {
  const gtt = require("../get-translation-target");
  gtt.getTranslationTarget = async () => manifest;

  // installment number → volume folder, so the agent stub can write into the right
  // folder (every agent name carries the installment number).
  const dirForInstallment = new Map(
    manifest.volumes.map((v) => [v.installmentNumber, path.join(manifest.seriesLocation, v.folder)])
  );
  const installmentOf = (name) => {
    const m = name.match(/-(\d{2})\b/);
    return m ? m[1] : null;
  };

  const harness = require("../harness");
  harness.createGatedFsTools = async () => ({ tools: {}, approve: async () => true });
  harness.createAgentHandle = async (cfg) => ({
    name: cfg.name,
    async sendTurn(prompt, opts) {
      const label = (opts && opts.label) || "";
      const volumeDir = dirForInstallment.get(installmentOf(cfg.name));
      // The compile author and the feedback author write the artifacts for real,
      // so the deterministic output gates see a real file.
      if (cfg.name.startsWith("author-voice-")) {
        fs.writeFileSync(path.join(volumeDir, "character-voice.md"), `# Character Voice (${label})\n`, "utf8");
        fs.writeFileSync(path.join(volumeDir, "pov-map.md"), `# POV Map (${label})\n`, "utf8");
      }
      if (cfg.name.startsWith("validator-voice-")) {
        fs.writeFileSync(
          path.join(volumeDir, "character-voice-validation.md"),
          `# Validation (${label})\n\nFinal recommendation: Pass\n`,
          "utf8"
        );
      }
      return { text: "wrote the files", toolCalls: [{ toolName: "writeFile" }] };
    },
    async close() {},
  });
  harness.runOneShot = async (cfg) => {
    const label = cfg.label || "";
    // The volumes named in failInstallments fail with an ORDINARY error (a flaky
    // model call — exactly what ON_VOLUME_ERROR=skip is for).
    for (const installment of failInstallments) {
      if (label.includes(`-${installment}`)) {
        throw new Error(`stubbed model failure on ${label}`);
      }
    }
    if (label.startsWith("character-voice-extract-")) return "[]";
    if (label.startsWith("character-voice-acceptance-")) {
      // 80: passing, and below the exceptional floor (85) so the confirmation
      // path is not part of this scenario.
      return '{"score": 80, "band": "Pass with minor edits", "note": "fixture"}';
    }
    throw new Error(`Unexpected one-shot label: ${label}`);
  };
}

/**
 * Scenario A — the LAST volume fails for an ordinary (model) reason, the run
 * policy says skip, and the TASK STILL REJECTS. This is the whole point of the
 * fix: before it, this run printed "1 of 2 volume(s) failed" and exited 0.
 */
async function scenarioTaskRejectsAfterSkippedVolume() {
  const { seriesDir, manifest } = makeSeries();
  process.env.SERIES_LOCATION = seriesDir;
  process.env.SERIES_ARTIFACTS_DIR = seriesDir;
  installStubs(manifest, { failInstallments: ["02"] });
  const { characterVoice } = require("../character-voice");

  let err = null;
  try {
    await characterVoice();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "the task rejects when a volume failed (it used to exit 0)");
  assert.ok(
    /character-voice: 1 of 2 volume\(s\) failed/.test(err.message),
    `the rejection names the failed volume(s): ${err.message}`
  );
  assert.ok(err.message.includes("Book(02)"), `and the folder: ${err.message}`);
  assert.strictEqual(isStructuralError(err), false, "a skipped model failure is reported as a volume failure, not a structural one");

  // The volume that DID succeed still produced its artifact (skip really did skip
  // only the broken one), and the series-root copy is the last good snapshot.
  assert.ok(
    fs.existsSync(path.join(seriesDir, "Book(01)", "character-voice.md")),
    "the healthy volume was processed"
  );
  assert.ok(
    !fs.existsSync(path.join(seriesDir, "Book(02)", "character-voice.md")),
    "the failed volume produced nothing (no stub was published in its place)"
  );
  assert.ok(
    fs.existsSync(path.join(seriesDir, "character-voice.md")),
    "the series-root copy still publishes the last good snapshot"
  );

  fs.rmSync(seriesDir, { recursive: true, force: true });
}

/**
 * Scenario A2 — the cascade. In a cumulative task, a broken EARLIER volume also
 * makes the later volumes skip (their previous artifact is missing, which
 * ON_MISSING_PREVIOUS=skip turns into a skip). That is the documented behavior;
 * what must not happen is the run ending green afterwards.
 */
async function scenarioCumulativeCascadeStillFailsTheRun() {
  const { seriesDir, manifest } = makeSeries();
  process.env.SERIES_LOCATION = seriesDir;
  process.env.SERIES_ARTIFACTS_DIR = seriesDir;
  installStubs(manifest, { failInstallments: ["01"] });
  const { characterVoice } = require("../character-voice");

  let err = null;
  try {
    await characterVoice();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "a cascade of skips still fails the run");
  assert.ok(/1 of 2 volume\(s\) failed/.test(err.message), err.message);
  assert.ok(
    !fs.existsSync(path.join(seriesDir, "Book(02)", "character-voice.md")),
    "the later volume cascaded the skip (its previous reference is missing)"
  );
  assert.ok(
    !fs.existsSync(path.join(seriesDir, "character-voice.md")),
    "and nothing was published at the series root"
  );

  fs.rmSync(seriesDir, { recursive: true, force: true });
}

/**
 * Scenario B — the failure is STRUCTURAL (a source that is not a book). No skip
 * policy walks past it: the task fails immediately, and the error is the
 * structural one rather than the end-of-run summary.
 */
async function scenarioStructuralFailureAborts() {
  const { seriesDir, manifest } = makeSeries();
  process.env.SERIES_LOCATION = seriesDir;
  process.env.SERIES_ARTIFACTS_DIR = seriesDir;
  installStubs(manifest, { failInstallments: [] });

  // A staged source that is GONE: resolveSourceBundle reports it as a structural
  // problem (the book itself is broken, not a model call), and no skip policy may
  // walk past that.
  fs.rmSync(path.join(seriesDir, "Book(01)", "Book(01).md"));

  const { characterVoice } = require("../character-voice");
  let err = null;
  try {
    await characterVoice();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "a structurally broken volume fails the run even with ON_VOLUME_ERROR=skip");
  assert.ok(/Required source file not found/.test(err.message), `the structural reason reaches the caller: ${err.message}`);
  assert.strictEqual(isStructuralError(err), true, "and it arrives tagged as structural");
  assert.ok(
    !fs.existsSync(path.join(seriesDir, "Book(02)", "character-voice.md")),
    "the run stopped at the broken volume instead of continuing past a broken book"
  );
  fs.rmSync(seriesDir, { recursive: true, force: true });
}

/**
 * Run one live scenario in a fresh process. Each task module reads
 * SERIES_LOCATION at module load, so the scenarios cannot share a process: the
 * second one would silently reuse the first one's (deleted) series folder.
 *
 * @param {string} name - The scenario key passed as --child=<name>.
 * @param {Function} scenario - The scenario to run in the child.
 * @returns {void}
 */
function runInChild(name, scenario) {
  const out = execFileSync(process.execPath, [__filename, `--child=${name}`], { encoding: "utf8" });
  assert.ok(out.includes("CHILD-OK"), `child ${name} reported the expected failure (got: ${out.trim().slice(-240)})`);
  void scenario;
}

// ─── Entry points ────────────────────────────────────────────────────────────

const CHILD_SCENARIOS = {
  "rejects": scenarioTaskRejectsAfterSkippedVolume,
  "cascade": scenarioCumulativeCascadeStillFailsTheRun,
  "structural": scenarioStructuralFailureAborts,
};

if (childScenario) {
  const run = CHILD_SCENARIOS[childScenario];
  if (!run) {
    console.error(`CHILD-FAIL: unknown scenario --child=${childScenario}`);
    process.exit(1);
  }
  run()
    .then(() => console.log("CHILD-OK"))
    .catch((e) => {
      console.error("CHILD-FAIL:", e && e.stack || e);
      process.exit(1);
    });
} else {
  for (const name of Object.keys(CHILD_SCENARIOS)) runInChild(name, CHILD_SCENARIOS[name]);
  console.log("task-failure: all checks passed.");
}

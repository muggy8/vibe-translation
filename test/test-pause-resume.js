#!/usr/bin/env node
/**
 * test/test-pause-resume.js — the pause is executable end to end.
 *
 * `utils/postmortem/plan/01-finding-levels.md` §7 slice 5: "the run halts at volume *n*, the answer is
 * obtained, the step resumes from volume *n*". Slice 4 built the gate; this file is the proof that a
 * halted run can actually be picked up, through the real doors — the real runner (`index.js`), the real
 * triage (`utils/resume`), the real wipe (`delivery/act.js` → `utils/fs/wipe.js`) and the real
 * skip-checks — against the scripted model server, with 0 real model calls.
 *
 * What it pins, in the order the plan has to prove it:
 *
 *   1. a MAJOR finding in volume 02 stops the walk AFTER volume 02: volume 03 is never attempted and
 *      its folder holds nothing but the book;
 *
 * The defect is planted through two different doors, because the two stages write their validation
 * report differently: the style-guide stage still pays a validator agent (the plant rewrites that
 * agent's `writeFile`), and the glossary stage does not (its report is written by the reference
 * store's deterministic audit, so the plant writes the wrong-shaped file itself). See `reply`.
 *   2. the halt is a record the run can read back — the post-mortem report exists, names the pause and
 *      counts the never-attempted volumes instead of reporting them as broken books;
 *   3. the ledger entry for the halted step names the volume it stopped at and the finding kind that
 *      stopped it (it used to record `findings {0,0,0}` / `findingKinds []` for a step that had just
 *      reported a MAJOR);
 *   4. the triage resumes at volume 02 — not 03 — and for a cumulative step that means
 *      `wipe-and-cascade` with volume 02's declared outputs named;
 *   5. the wipe removes exactly that volume's declared outputs and nothing else: volume 01's accepted
 *      work is byte-identical afterwards, and the staged book survives (Tier C);
 *   6. the resumed pass pays for volume 02 and the never-attempted volume 03, and pays NOTHING for the
 *      volume already accepted;
 *   7. the resumed run finishes: the halt record is gone and the step's post-mortem is CLEAN;
 *   8. the control — re-run with no wipe — pays 0 calls and halts in the same place on the same
 *      finding, which is what "the same assessment would stop it in the same place" is supposed to mean;
 *   9. a second step's halt does not erase the first one's (the record holds one entry per step);
 *  10. `ON_VOLUME_ERROR=skip` cannot walk past the halt, and `--dry-run` does not gate at all.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any
 * file under the series folder (AGENTS.md rule 8, gotcha 69).
 *
 * @module test/test-pause-resume
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const workflow = require("./fake-workflow");
const { startFakeBackend } = require("./fake-backend");
const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");
const resume = require("../utils/resume");
const act = require("../delivery/act");
const { readLedger } = require("../utils/ledger");
const { readVolumeHalt, writeVolumeHalt, clearVolumeHalt, HALT_RECORD_SCHEMA } = require("../utils/postmortem");

const FIXTURE_ROOT = path.join("/tmp/opencode/series-fixtures", "pause-resume");
const HOOKS_DIR = path.join(FIXTURE_ROOT, "empty-hooks");
const CALIBRATION_FILE = path.join(FIXTURE_ROOT, "token-calibration.json");

/** Three books: one accepted before the halt, one that trips it, one never attempted. */
const FOLDERS = ["Pause Story(01)", "Pause Story(02)", "Pause Story(03)"];
/** The scripted brain reads `volume.stagedFile`; every folder carries volume 02's book under that name. */
const STAGED = "Pause Story(02).txt";
const BOOK = workflow.sourceTextOf(workflow.VOLUMES[1]);

/** A validation report with real content and none of the shape the validator prompt asks for. */
const PLANTED =
  "The glossary was read against the volume's source text and every rendering in the table was confirmed " +
  "against the source. The report was written as a paragraph rather than as a findings list, which is not " +
  "the shape the validator prompt asks for.\n";

let checks = 0;
/**
 * Count one assertion and run it.
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

/** @type {{dir: string, runDir: string, logsDir: string}} Where the scenario being measured lives. */
let where = null;
/** @type {Set<string>} Which (step, volume) reports are currently planted. */
const armed = new Set();

/**
 * The scripted brain, plus the plant.
 *
 * The plant is the defect this suite is about: a file that exists, has real content, and is not the
 * document its prompt asked for — `wrong-shape`, which `utils/postmortem/levels.js` declares MAJOR.
 *
 * **The two halves are planted differently, and that is the glossary stage's route, not a fixture
 * preference.** The style-guide stage still pays a validator agent, so its report is still written by
 * a model tool call and the plant rewrites that call. The glossary stage no longer has one: its
 * `glossary-validation.md` is written by the reference store's deterministic audit
 * (`glossary/qa.js` → `glossary/store.js`), which no model call can reach. So the glossary half
 * writes the wrong-shaped report itself, at the moment the volume's acceptance grade is asked for —
 * the last thing that touches that file before the volume is assessed. Same file, same finding kind,
 * same level, same halt point; only the door the defect arrives through had to move.
 *
 * The plant stays armed for the whole step rather than being consumed by the first grade, so a second
 * QA iteration (which would re-run the audit and overwrite the report) cannot quietly repair the
 * defect. `runStep` disarms when the step ends.
 *
 * There is no shim for volume 03's glossary any more. This suite used to hand the glossary author a
 * cumulative table for the third book, because the scripted brain only knows two volumes and its
 * author answer for a third would have dropped volume 02's term and tripped the carry-forward gate for
 * a reason unrelated to this suite. The glossary file is rendered out of the volume's record now, and
 * the record already carries every earlier volume's rows, so the cumulative document is what the
 * render produces on its own (glossary route slice 2).
 *
 * @param {import("./fake-backend").FakeRequest} req
 * @returns {import("./fake-backend").FakeReply}
 */
function reply(req) {
  const answer = workflow.answer(req, { seriesDir: where.dir, log: () => {} });
  const info = workflow.classify(req);
  // Which volume is this request about? The prompt's own "Volume NN" header first: every fixture
  // folder holds the SAME book text, so the scripted brain's source-text lookup cannot tell volume 03
  // from volume 02. The classified volume is the fallback for the calls that carry no header — the
  // acceptance grade, which is shown the artifact and the report, never the source.
  const nn = ((req.userText || "").match(/Volume (\d{2})/) || [])[1]
    || (info.volume ? info.volume.installment : null);

  if (nn && info.kind === "acceptance" && armed.has(`glossary:${nn}`)) {
    const folder = FOLDERS[Number(nn) - 1];
    if (folder) fs.writeFileSync(path.join(where.dir, folder, "glossary-validation.md"), PLANTED, "utf8");
  }

  if (!Array.isArray(answer.toolCalls)) return answer;
  for (const call of answer.toolCalls) {
    if (call.name !== "writeFile") continue;
    const file = String(call.arguments.filePath);
    // The glossary stage writes neither of its files through a model any more: `glossary.md` is
    // rendered out of the volume's record and `glossary-validation.md` is written by the deterministic
    // audit, which is why the glossary half of the plant is planted above, on the filesystem.
    if (file === "style-guide-validation.md") {
      if (armed.has(`style-guide:${nn}`)) call.arguments.content = PLANTED;
      continue;
    }
  }
  return answer;
}

/**
 * Lay out one throwaway three-volume series with a committed schema-2 plan of record.
 *
 * @param {string} label
 * @returns {{dir: string, runDir: string, logsDir: string}}
 */
function buildFixture(label) {
  const root = path.join(FIXTURE_ROOT, label);
  const dir = path.join(root, "series");
  const runDir = path.join(dir, ".postmortem");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  for (const folder of FOLDERS) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, folder, STAGED), `${BOOK}\n`, "utf8");
  }
  fs.writeFileSync(
    path.join(dir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: dir,
        seriesName: "Pause Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test/test-pause-resume.js",
        generatedAt: new Date().toISOString(),
        discovery: {
          summary: "three plain-text books, identical fixture text",
          confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
          evidence: ["fixture"],
          excluded: [],
        },
        // The series' own register declaration (plan 06 slice 3), the same two axes the scripted reading
        // pass answers — this fixture runs the real character-voice stage, and that stage now refuses a
        // plan of record with no declaration rather than falling back to a list it does not have.
        register: workflow.FIXTURE_REGISTER_DECLARATION,
        volumes: FOLDERS.map((folder, i) => ({
          folder,
          sourceFile: `${folder}/${STAGED}`,
          installmentNumber: String(i + 1).padStart(2, "0"),
          title: `Pause Story ${i + 1}`,
          integrity: {
            isNarrative: true,
            confidence: 0.9,
            basis: "fixture: continuous first-person prose with scene breaks, no packaging pages",
          },
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return {
    dir,
    runDir,
    // `test/test-home.js` pins RUN_DIR to a throwaway folder; the transcripts of THIS scenario go
    // beside its own fixture, so the cost of one pass is read from one file (configs/run-state.js).
    logsDir: path.join(root, "run", "logs"),
    runHome: path.join(root, "run"),
  };
}

/**
 * Point this process at one fixture: its books, its records, its transcripts.
 *
 * @param {string} label
 * @returns {{dir: string, runDir: string, logsDir: string}}
 */
function useFixture(label) {
  where = buildFixture(label);
  process.env.SERIES_LOCATION = where.dir;
  process.env.POSTMORTEM_DIR = where.runDir;
  process.env.RUN_DIR = where.runHome;
  return where;
}

/** @returns {string[]} The transcript directories of the current scenario, oldest first. */
function transcripts() {
  if (!fs.existsSync(where.logsDir)) return [];
  return fs.readdirSync(where.logsDir).sort().map((d) => path.join(where.logsDir, d));
}

/**
 * What one run transcript billed, per volume.
 *
 * The harness labels every billable call with the installment it was working on
 * (`glossary-acceptance-02-confirm1`), which is the only attribution that does not depend on how the
 * stage happened to print its own log.
 *
 * @param {string} transcriptDir
 * @returns {{calls: Object<string, number>, total: number, tokens: number}}
 */
function costOfTranscript(transcriptDir) {
  const calls = {};
  let total = 0;
  let tokens = 0;
  const file = path.join(transcriptDir, "summary.log");
  if (!fs.existsSync(file)) return { calls, total, tokens };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/\[call-ai\] RESULT \(([a-z0-9-]+?)(\d{2})(?:-[a-z0-9]+)?\) .* total=(\d+)/);
    if (!m) continue;
    calls[m[2]] = (calls[m[2]] || 0) + 1;
    total++;
    tokens += Number(m[3]);
  }
  return { calls, total, tokens };
}

/**
 * Run one step through the real runner, in a child process, and bill its own transcript.
 *
 * @param {string[]} args
 * @param {string} label
 * @returns {Promise<{code: number|null, output: string, billed: number, tokens: number, perVolume: Object<string, number>}>}
 */
async function runStep(args, label) {
  const before = transcripts().length;
  const { code, output } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "index.js"), ...args], { cwd: ROOT });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 8 * 60 * 1000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(FIXTURE_ROOT, `${label}.log`), out, "utf8");
      resolve({ code: exitCode, output: out });
    });
  });
  // The plant is a property of ONE step, not of the suite: whatever this step did is finished, and a
  // defect that stayed armed would be planted into the next step's volumes too.
  armed.clear();
  const list = transcripts();
  // A step that makes no model call creates no transcript of its own. Billing the previous step's
  // transcript would report its cost as this step's.
  const cost = list[before] ? costOfTranscript(list[before]) : { calls: {}, total: 0, tokens: 0 };
  return { code, output, billed: cost.total, tokens: cost.tokens, perVolume: cost.calls };
}

/**
 * The declared outputs of one step for one volume, resolved from `utils/artifacts.js` — the same list
 * `delivery/act.js` wipes, read from the declaration rather than copied into this file.
 *
 * @param {string} step
 * @param {string} installment
 * @returns {string[]}
 */
function declaredOutputs(step, installment) {
  return (STEP_ARTIFACT_SPECS[step].volume || []).map((e) => e.name.replace("{installment}", installment));
}

/**
 * Read one file, or null when it is not there.
 * @param {string} file
 * @returns {string|null}
 */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Snapshot every file in one volume folder.
 * @param {string} dir
 * @returns {Object<string, string>}
 */
function snapshot(dir) {
  /** @type {Object<string, string>} */
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) continue;
    out[name] = fs.readFileSync(full, "utf8");
  }
  return out;
}

/** @type {import("./fake-backend").FakeBackend|null} The scripted server, kept reachable so a red run can still shut it down. */
let activeBackend = null;

async function main() {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });

  const backend = await startFakeBackend({
    model: ["stub", "stub-translate", "stub-verify", "stub-edit", "stub-audit"],
    reply,
  });
  activeBackend = backend;
  backend.pointEnvAt({ prefixes: ["TRANSLATE", "VERIFY", "EDIT", "AUDIT"] });

  process.env.AI_CONTEXT_WINDOW = "32768";
  process.env.AI_MAX_TOKENS = "8192";
  process.env.AI_TEMPERATURE = "0.7";
  process.env.AI_RETRY = "0";
  process.env.AI_CALL_DEADLINE_MS = "120000";
  process.env.AI_THINKING = "true";
  process.env.AI_THINKING_LEVEL = "xhigh";
  process.env.STAGE_THINKING_LEVEL = "medium";
  process.env.RESEARCH_ENABLED = "false";
  process.env.AI_CLIENT_HOOKS_DIR = HOOKS_DIR;
  process.env.TOKEN_CALIBRATION_FILE = CALIBRATION_FILE;
  process.env.PASSING_SCORE = "70";
  process.env.ACCEPTANCE_WINDOW_SIZE = "2";
  process.env.QA_MAX_ITERATIONS = "3";
  process.env.STAGE_CONCURRENCY = "1";
  process.env.ON_VOLUME_ERROR = "abort";
  process.env.ON_TASK_ERROR = "abort";
  process.env.ON_MISSING_PREVIOUS = "abort";
  process.env.ON_QA_LIMIT = "fail";
  process.env.AI_BASE_URL = backend.baseUrl;
  process.env.AI_API_KEY = process.env.AI_API_KEY || "stub-key";

  // ─── Scenario 1: halt → triage → wipe → resume ─────────────────────────────
  useFixture("halt-then-resume");

  const extract = await runStep(["--stages=extract"], "extract");
  same(extract.code, 0, "extract runs clean, so the paused step is the one the triage picks up");
  same(extract.billed, 0, "extract makes no model call, so nothing here is paid for by the setup");

  armed.add("glossary:02");
  const halted = await runStep(["--stages=glossary"], "halted");

  ok(halted.code === 1, "the step that halted exits non-zero");
  // Four calls per volume: one chapter read pass and the three acceptance samples. The glossary author
  // agent used to be the fifth (glossary route slice 2).
  same(halted.perVolume["01"], 4, "volume 01 was built and paid for");
  same(halted.perVolume["02"], 4, "volume 02 was built and paid for");
  ok(!halted.perVolume["03"], "volume 03 was never attempted, so it was never paid for");

  const halt = readVolumeHalt("glossary");
  ok(halt, "the halt left a record");
  same(halt.haltedAfterVolume, "02", "the record names the volume the step stopped AFTER");
  same(halt.unattemptedVolumes, ["03"], "and the volumes it therefore never attempted");
  same(halt.trigger.map((t) => `${t.level} ${t.kind}`), ["MAJOR wrong-shape"], "the trigger is the level, not a severity");

  const vol3 = path.join(where.dir, FOLDERS[2]);
  same(fs.readdirSync(vol3).sort(), [STAGED], "the never-attempted volume's folder holds nothing but the book");

  // The pause has to be legible in the run's own records, not only in the error message.
  const report = readOrNull(path.join(where.runDir, "glossary.md"));
  ok(report, "the halted step writes its own post-mortem report (it used to write none)");
  ok(/The step halted after volume 02/.test(report), "the report says the step halted, on purpose, after volume 02");
  ok(/never attempted/.test(report), "and that the later volumes were never attempted");
  ok(halted.output.includes("glossary is PAUSED after volume 02"), "the runner says so out loud too");
  ok(halted.output.includes("(paused after volume 02)"), "and the summary line tells a pause apart from a crash");

  const haltedEntry = readLedger().entries.filter((e) => e.step === "glossary" && e.kind === "assessment").pop();
  ok(haltedEntry, "the halted step is recorded in the ledger");
  same(haltedEntry.volume, "02", "the ledger entry names the volume the step stopped at");
  ok(haltedEntry.findingKinds.includes("wrong-shape"), "and the finding kind that stopped it (it used to record none)");
  ok(haltedEntry.findings.MEDIUM + haltedEntry.findings.HIGH > 0, "and the finding is counted, not only narrated");

  // ─── The triage ────────────────────────────────────────────────────────────
  const state = await resume.readWorkingState({ seriesDir: where.dir });
  const glossaryState = state.stepStates.find((s) => s.step === "glossary");
  same(glossaryState.status, "paused", "the triage reads a halt as a pause, not as an unfinished step");

  const plan = resume.planResume(state);
  const planStep = plan.steps.find((s) => s.step === "glossary");
  same(planStep.action, "run", "glossary is the step to run");
  same(planStep.actionName, "wipe-and-cascade", "and for a cumulative step the repair is a wipe plus the cascade");
  same(planStep.fromVolume, "02", "it resumes at volume 02 — NOT volume 03");
  ok(planStep.cascade, "the cascade is what rebuilds every volume after it");
  ok(planStep.paused && planStep.paused.haltedAfterVolume === "02", "the plan carries the pause");

  const wipe = planStep.wipeFirst || [];
  same(wipe.length, 1, "exactly one volume is wiped");
  same(wipe[0].volumeDir, path.join(where.dir, FOLDERS[1]), "and it is volume 02's folder");
  for (const name of declaredOutputs("glossary", "02")) {
    ok(wipe[0].files.includes(name), `the wipe names ${name}, the output the step declared for that volume`);
  }
  ok(!wipe[0].files.some((f) => f.includes(".rejected")), "and it names no gate evidence (Tier C: evidence is not cleanup)");
  ok(wipe[0].files.every((f) => declaredOutputs("glossary", "02").includes(f)), "and nothing outside glossary's own declared outputs for that volume (the wipe boundary does not widen)");

  // ─── The act door: the real wipe, the real re-run ──────────────────────────
  const vol1Dir = path.join(where.dir, FOLDERS[0]);
  const vol2Dir = path.join(where.dir, FOLDERS[1]);
  const vol1Before = snapshot(vol1Dir);
  const plantedFile = readOrNull(path.join(vol2Dir, "glossary-validation.md"));
  ok(plantedFile && !/^#/m.test(plantedFile), "volume 02's validation report is still the wrong-shaped one before the wipe");

  const executed = [];
  const acted = await act.runActPlan({
    plan,
    state,
    runStep: async (opts) => {
      const before = transcripts().length;
      const out = await act.runPipelineStep(opts);
      const dir = transcripts()[before];
      const cost = dir ? costOfTranscript(dir) : { calls: {}, total: 0, tokens: 0 };
      executed.push({ step: opts.step, ok: out.ok, code: out.code, billed: cost.total, perVolume: cost.calls });
      return out;
    },
  });

  same(acted.exitCode, 0, "the resumed run finishes");
  const glossaryRun = executed.find((e) => e.step === "glossary");
  ok(glossaryRun, "the manager ran glossary");
  same(glossaryRun.ok, true, "and it finished");
  same(glossaryRun.perVolume["01"], undefined, "the volume already accepted was NOT paid for again");
  same(glossaryRun.perVolume["02"], 4, "the volume that tripped the gate was rebuilt");
  same(glossaryRun.perVolume["03"], 4, "and the volume the halt never attempted was built");

  const vol1After = snapshot(vol1Dir);
  // Tier C: a pause never justifies deleting accepted work. The later steps of the plan legitimately
  // ADD their own outputs to volume 01, so what is pinned is that nothing volume 01 already had was
  // changed or removed — and that the wipe's own list is the only thing that ever went away.
  for (const name of declaredOutputs("glossary", "01")) {
    same(vol1After[name], vol1Before[name], `volume 01's ${name} is byte-identical after the resume`);
  }
  same(vol1After[STAGED], vol1Before[STAGED], "the staged book survives the wipe");
  const lostFromVolume1 = Object.keys(vol1Before).filter((n) => !(n in vol1After));
  same(lostFromVolume1, [], "nothing volume 01 held was removed");
  same(fs.readdirSync(vol2Dir).includes(STAGED), true, "the staged book survived the wipe");
  const rebuilt = readOrNull(path.join(vol2Dir, "glossary-validation.md"));
  ok(rebuilt && /^# /m.test(rebuilt), "volume 02's validation report is now the document its prompt asked for");

  ok(!readVolumeHalt("glossary"), "a step that finished does not leave a halt behind");
  const afterReport = readOrNull(path.join(where.runDir, "glossary.md"));
  ok(/\*\*CLEAN\*\*/.test(afterReport), "and its post-mortem is clean");

  // ─── Scenario 2: the control — re-run with no wipe ─────────────────────────
  useFixture("halt-without-wipe");

  await runStep(["--stages=extract"], "control-extract");
  armed.add("glossary:02");
  const first = await runStep(["--stages=glossary"], "control-first");
  same(first.code, 1, "the control halts too");
  same(first.billed, 8, "and pays for the two volumes it attempted (4 calls each)");

  armed.add("glossary:02");
  const again = await runStep(["--stages=glossary"], "control-again");
  same(again.code, 1, "re-running it without wiping fails again");
  same(again.billed, 0, "and pays nothing: the skip-checks keep both volumes, wrong-shaped file included");
  const againHalt = readVolumeHalt("glossary");
  same(againHalt.haltedAfterVolume, "02", "in the same place");
  same(againHalt.trigger.map((t) => t.kind), ["wrong-shape"], "on the same finding");

  // ─── Scenario 3: two steps halt, both pauses survive ───────────────────────
  useFixture("two-halts");
  await runStep(["--stages=extract"], "two-extract");
  armed.add("glossary:02");
  await runStep(["--stages=glossary"], "two-glossary");
  armed.add("style-guide:02");
  const secondHalt = await runStep(["--stages=style-guide"], "two-style-guide");
  same(secondHalt.code, 1, "a second step halts at the same boundary");
  ok(readVolumeHalt("glossary"), "the first step's pause is still recorded");
  ok(readVolumeHalt("style-guide"), "and so is the second's — the record holds one entry per step");
  const twoState = await resume.readWorkingState({ seriesDir: where.dir });
  same(twoState.stepStates.find((s) => s.step === "glossary").status, "paused", "the earlier step still reads as paused, not as broken");
  same(twoState.stepStates.find((s) => s.step === "style-guide").status, "paused", "and so does the later one");

  // ─── The guards around the pause ───────────────────────────────────────────
  useFixture("skip-cannot-pass");
  await runStep(["--stages=extract"], "skip-extract");
  process.env.ON_VOLUME_ERROR = "skip";
  armed.add("glossary:02");
  const notSkipped = await runStep(["--stages=glossary"], "skip-halt");
  process.env.ON_VOLUME_ERROR = "abort";
  same(notSkipped.code, 1, "ON_VOLUME_ERROR=skip does not walk past a halt");
  ok(readVolumeHalt("glossary"), "and the halt is still recorded");

  useFixture("dry-run");
  const dry = await runStep(["--stages=glossary", "--dry-run"], "dry-run");
  same(dry.billed, 0, "--dry-run makes no call");
  ok(!readVolumeHalt("glossary"), "--dry-run does not gate: nothing was assessed, so nothing halted");

  // The record is data in a closed path, and it is one entry per step.
  const haltFile = path.join(where.runDir, "last-volume-halt.json");
  writeVolumeHalt({ step: "glossary", haltedAfterVolume: "05", haltedAfterFolder: "X(05)", attemptedVolumes: ["01"], unattemptedVolumes: ["06"] });
  writeVolumeHalt({ step: "style-guide", haltedAfterVolume: "07", haltedAfterFolder: "X(07)", attemptedVolumes: ["01"], unattemptedVolumes: ["08"] });
  const raw = JSON.parse(fs.readFileSync(haltFile, "utf8"));
  same(raw.schema, HALT_RECORD_SCHEMA, "the halt record is versioned");
  same(Object.keys(raw.halts).sort(), ["glossary", "style-guide"], "and holds one entry per step");
  clearVolumeHalt("glossary");
  ok(!readVolumeHalt("glossary"), "clearing one step's halt removes only that entry");
  ok(readVolumeHalt("style-guide"), "and leaves the other step's pause intact");

  // Schema 1 wrote ONE bare record (no `halts` map). A run that halted before this change left that
  // shape on disk, and a pause that stops being readable after a code change is a pause that silently
  // becomes a crash: the triage would read the step as `incomplete` and its unattempted books as plain
  // missing output. The reader keeps reading the old layout.
  fs.writeFileSync(haltFile, JSON.stringify({ step: "glossary", haltedAfterVolume: "03", haltedAfterFolder: "X(03)", attemptedVolumes: ["01"], unattemptedVolumes: ["04"], at: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n", "utf8");
  const legacy = readVolumeHalt("glossary");
  ok(legacy, "a schema-1 halt record is still read, not mistaken for no halt");
  same(legacy && legacy.haltedAfterVolume, "03", "with the volume it stopped after intact");
  ok(!readVolumeHalt("style-guide"), "and it still describes only the step it names");
  fs.rmSync(haltFile, { force: true });

  await backend.close();
  console.log(`OK: ${checks} checks on halting at volume n and resuming at volume n.`);
}

main()
  .catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  })
  // A red suite that never exits is worse than a red suite: the scripted model server is still
  // listening, so the event loop stays alive and `npm test` hangs instead of failing. The server is
  // closed on the way out whatever the outcome, so a failed check ends the run.
  .finally(() => {
    if (activeBackend) activeBackend.close().catch(() => {});
  });

#!/usr/bin/env node
/**
 * test/test-volume-halt-gate.js — a MAJOR finding pauses the run AT the volume boundary.
 *
 * `utils/postmortem/plan/01-finding-levels.md` §3.2 is the plan's load-bearing choice: a fault that
 * every later volume inherits must be caught **before** the next volume is built on it. Until this
 * gate existed the shared volume loop had `afterVolumes` (after ALL volumes) and no hook after ONE,
 * so a MAJOR finding at volume 3 was discovered after volumes 4–17 had already inherited it.
 *
 * What this file pins, in the order the plan's slice 4 has to prove it:
 *
 *   1. a planted **MAJOR** in volume 1 halts the walk — volume 2 is never processed;
 *   2. a planted **STOP** halts it too;
 *   3. a planted **MINOR** and a planted **NOTE** do NOT halt it, and are still assessed;
 *   4. a stage outside the policy table (`polish`) does not halt on the same planted MAJOR;
 *   5. the stages that never reach the gate are NAMED in the policy, not silently absent;
 *   6. after a halt, the after-step assessment does not report the unattempted volumes as
 *      `missing-required` HIGH, and does report the volume that tripped the gate;
 *   7. the halt is not skippable: `ON_VOLUME_ERROR=skip` does not walk past it;
 *   8. nothing is assessed mid-chapter — the gate is asked once per volume;
 *   9. the trigger is the LEVEL: a kind declared NOTE cannot halt and a kind declared MAJOR can,
 *      with no severity named anywhere in this file;
 *  10. no environment variable switches any of it off;
 *  11. the shape the gate halts on describes the artifact the step writes — the gate's first act
 *      on real material was a halt on a false positive, and that is pinned shut here.
 *
 * Fixtures only. Nothing here reads the real 17 volumes, the reference store, or the endpoint —
 * the assessment is deterministic and the "volumes" are two folders of a throwaway series.
 * (AGENTS.md rule 8, gotcha 69.)
 *
 * @module test/test-volume-halt-gate
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const childScenario = process.argv.find((a) => a.startsWith("--child="))?.replace("--child=", "") || null;

// Pin the acceptance thresholds the fixture's rolling-state files are judged against, so the
// "accepted" volumes are accepted on this machine whatever its .env says.
process.env.PASSING_SCORE = "70";
process.env.ACCEPTANCE_WINDOW_SIZE = "2";
process.env.ACCEPTANCE_MIN_SAMPLES = "2";
process.env.ON_MISSING_PREVIOUS = "abort";

const { walkVolumes, runVolumeSeries } = require("../utils/series-run");
const { runPostMortem } = require("../utils/postmortem");
const { writeVolumeHalt, readVolumeHalt, clearVolumeHalt } = require("../utils/postmortem");
const { levelFor, FINDING_LEVELS } = require("../utils/postmortem/levels");
const { isStructuralError } = require("../configs/shared");
const { readModuleLayer } = require("./module-layer");

const ROOT = path.join(__dirname, "..");

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

// ─── The fixture ──────────────────────────────────────────────────────────────

/**
 * A two-volume series on disk, with the plan of record the post-mortem reads.
 *
 * `files` maps folder → { fileName: contents }. A volume left out of `files` gets its folder and
 * nothing inside it, which is how the STOP case is planted.
 *
 * @param {{ volumes: Array<{ folder: string, installment: string, files?: Object<string, string> }> }} opts
 * @returns {{ seriesDir: string, manifest: Object, byFolder: Map<string, Object> }}
 */
function makeSeries({ volumes }) {
  const seriesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-haltgate-"));
  const entries = volumes.map((v) => {
    const volumeDir = path.join(seriesDir, v.folder);
    fs.mkdirSync(volumeDir, { recursive: true });
    const sourceName = `${v.folder}.md`;
    fs.writeFileSync(path.join(volumeDir, sourceName), `# Chapter\n\nBody text for ${v.folder}. 本文テキスト。\n`, "utf8");
    for (const [name, contents] of Object.entries(v.files || {})) {
      if (contents === undefined) continue; // "do not write this file" — the deliverable is simply absent
      fs.writeFileSync(path.join(volumeDir, name), contents, "utf8");
    }
    return {
      folder: v.folder,
      sourceFile: `${v.folder}/${sourceName}`,
      installmentNumber: v.installment,
      title: v.folder,
      integrity: { isNarrative: true, confidence: 0.9, basis: "test fixture" },
    };
  });
  const manifest = {
    schema: 2,
    seriesName: "Gate",
    seriesLocation: seriesDir,
    sourceLanguage: "Japanese",
    targetLanguage: "English",
    discovery: { summary: "fixture", confidence: 0.9, evidence: [], excluded: [] },
    volumes: entries,
  };
  fs.writeFileSync(path.join(seriesDir, "translation-target.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { seriesDir, manifest, byFolder: new Map(entries.map((v) => [v.folder, v])) };
}

/** A glossary volume that finished: every required file present, in the shape it must have. */
const CLEAN_GLOSSARY_VOLUME = {
  "glossary.md": "| Term | Rendering |\n|---|---|\n| 鏡 | Mirror |\n| 玄武 | Genbu |\n",
  "glossary-validation.md": "# Glossary Validation\n\n## Findings\n\n1. **[LOW] Nothing serious.**\n\n**Recommendation:** Pass\n",
  "glossary-validation-rolling-state.json": JSON.stringify({ results: [90, 90] }),
};

/** The same volume with the artifact present but NOT the document it claims to be: `wrong-shape`. */
const WRONG_SHAPE_GLOSSARY_VOLUME = {
  ...CLEAN_GLOSSARY_VOLUME,
  "glossary.md": "# Glossary\n\nThis glossary is written as prose. It has a heading and real content, " +
    "and no table at all, which is the shape every downstream reader parses.\n",
};

/** A volume that was never built: nothing the step owed it is on disk. */
const EMPTY_VOLUME = {};

/**
 * Run a walk and catch what it threw.
 *
 * @param {Function} run
 * @returns {Promise<{ error: Error|null }>}
 */
async function capture(run) {
  try {
    await run();
    return { error: null };
  } catch (err) {
    return { error: err };
  }
}

/**
 * Walk two volumes through the shared loop with the gate pointed at one step.
 *
 * @param {{ seriesDir: string, byFolder: Map<string, Object>, step: string, volumes?: string[] }} opts
 * @returns {Promise<{ processed: string[], assessed: Array<{ folder: string, findings: Object[] }>, error: Error|null }>}
 */
async function walkTwo({ seriesDir, byFolder, step, volumes = ["Book(01)", "Book(02)"] }) {
  /** @type {string[]} */
  const processed = [];
  /** @type {Array<{ folder: string, findings: Object[] }>} */
  const assessed = [];
  const { error } = await capture(() =>
    walkVolumes({
      volumes,
      volumeByFolder: byFolder,
      step,
      seriesDir,
      processVolume: async (folderName) => {
        processed.push(folderName);
      },
      onVolumeAssessed: (folderName, assessment) => {
        assessed.push({ folder: folderName, findings: assessment.findings });
      },
    })
  );
  return { processed, assessed, error };
}

// ─── 1. A planted MAJOR halts the walk at the volume boundary ─────────────────

/**
 * @returns {Promise<void>}
 */
async function testMajorHaltsAtTheVolumeBoundary() {
  const fx = makeSeries({
    volumes: [
      { folder: "Book(01)", installment: "01", files: WRONG_SHAPE_GLOSSARY_VOLUME },
      { folder: "Book(02)", installment: "02", files: EMPTY_VOLUME },
    ],
  });
  const { processed, assessed, error } = await walkTwo({ ...fx, step: "glossary" });

  ok(error, "a MAJOR finding in volume 1 must stop the walk (it used to walk straight into volume 2)");
  ok(isStructuralError(error), `the halt is structural, so no ON_VOLUME_ERROR=skip walks past it: ${error && error.message}`);
  same(error.name, "VolumeHaltError", "the halt is a named error class, not a generic Error");
  ok(/volume 01/.test(error.message), `the halt names the volume it stopped after: ${error.message}`);
  ok(/wrong-shape/.test(error.message), `the halt names the finding that stopped it: ${error.message}`);
  same(processed, ["Book(01)"], "volume 2 was never processed — that is the whole point of the pause");
  same(assessed.map((a) => a.folder), ["Book(01)"], "the gate assessed the volume that finished, once");
  const kinds = assessed[0].findings.map((f) => f.kind);
  ok(kinds.includes("wrong-shape"), `the planted finding is the one the gate saw: ${kinds.join(", ")}`);
  same(
    assessed[0].findings.filter((f) => f.kind === "wrong-shape")[0].level,
    "MAJOR",
    "the planted finding is MAJOR, which is the level the plan says pauses the run"
  );
  ok(!fs.existsSync(path.join(fx.seriesDir, "Book(02)", "glossary.md")), "and volume 2 really has no output");

  fs.rmSync(fx.seriesDir, { recursive: true, force: true });
}

// ─── 2. A planted STOP halts it too ───────────────────────────────────────────

/**
 * @returns {Promise<void>}
 */
async function testStopHalts() {
  const fx = makeSeries({
    volumes: [
      { folder: "Book(01)", installment: "01", files: { ...CLEAN_GLOSSARY_VOLUME, "glossary.md": undefined } },
      { folder: "Book(02)", installment: "02", files: CLEAN_GLOSSARY_VOLUME },
    ],
  });
  // `"glossary.md": undefined` above means "do not write this file" — the deliverable is simply absent.
  const { processed, assessed, error } = await walkTwo({ ...fx, step: "glossary" });
  ok(error, "a STOP finding halts the walk");
  ok(isStructuralError(error), "and it is structural");
  const kinds = (assessed[0] && assessed[0].findings.map((f) => f.kind)) || [];
  ok(kinds.includes("missing-required"), `the planted absence is the trigger: ${kinds.join(", ")}`);
  same(levelFor("missing-required"), "STOP", "the trigger kind is declared STOP");
  same(processed, ["Book(01)"], "volume 2 is never reached");

  fs.rmSync(fx.seriesDir, { recursive: true, force: true });
}

// ─── 3. MINOR and NOTE do not halt, and are still assessed ────────────────────

/**
 * @returns {Promise<void>}
 */
async function testMinorAndNoteDoNotHalt() {
  const fx = makeSeries({
    volumes: [
      {
        folder: "Book(01)",
        installment: "01",
        files: {
          ...CLEAN_GLOSSARY_VOLUME,
          // MINOR: a file the pipeline's vocabulary does not recognise.
          "leftover-from-an-old-run.md": "# stray\n",
          // NOTE: a gate fired and kept its evidence, beside a complete deliverable.
          "glossary.md.rejected": "# rejected draft\n",
        },
      },
      { folder: "Book(02)", installment: "02", files: CLEAN_GLOSSARY_VOLUME },
    ],
  });
  const { processed, assessed, error } = await walkTwo({ ...fx, step: "glossary" });

  ok(!error, `a MINOR and a NOTE must not stop the run: ${error && error.message}`);
  same(processed, ["Book(01)", "Book(02)"], "both volumes were processed");
  same(assessed.map((a) => a.folder), ["Book(01)", "Book(02)"], "and both were assessed");
  const kinds = assessed[0].findings.map((f) => f.kind);
  ok(kinds.includes("unexpected-file"), `the MINOR finding was found and recorded: ${kinds.join(", ")}`);
  ok(kinds.includes("quarantine-present"), `the NOTE finding was found and recorded: ${kinds.join(", ")}`);
  same(levelFor("unexpected-file"), "MINOR", "the stray file is MINOR: investigated, batched, never a halt");
  same(levelFor("quarantine-present"), "NOTE", "the quarantine beside a complete artifact is a NOTE");

  fs.rmSync(fx.seriesDir, { recursive: true, force: true });
}

// ─── 4. A stage outside the policy table does not halt ─────────────────────────

/**
 * @returns {Promise<void>}
 */
async function testPolishDoesNotHalt() {
  // The same shape defect, planted where `polish` is the step being assessed: `translation.md`
  // exists, has content, and is not the book it claims to be — one line of model chatter where a
  // merged volume belongs. `wrong-shape` is MAJOR. (It is NOT a heading-less file: the merge
  // prints no heading for a synthetic or source-language title, so that is legitimate prose.)
  const chatter = "I will now assemble the volume's translation from the chapter files I read.\n";
  const fx = makeSeries({
    volumes: [
      {
        folder: "Book(01)",
        installment: "01",
        files: {
          "translation.md": chatter,
          "translation-state.json": JSON.stringify({ chapters: {} }),
        },
      },
      {
        folder: "Book(02)",
        installment: "02",
        files: {
          "translation.md": chatter,
          "translation-state.json": JSON.stringify({ chapters: {} }),
        },
      },
    ],
  });
  const planted = await runPostMortem({ step: "polish", seriesDir: fx.seriesDir, volumeArg: "01" });
  const kinds = planted.findings.map((f) => f.kind);
  ok(kinds.includes("wrong-shape"), `the planted MAJOR is really there for polish too: ${kinds.join(", ") || "(nothing found)"}`);
  same(
    planted.findings.filter((f) => f.kind === "wrong-shape")[0].level,
    "MAJOR",
    "and it is the same MAJOR that halts glossary"
  );

  const { processed, assessed, error } = await walkTwo({ ...fx, step: "polish" });
  ok(!error, `polish pays per book but inherits nothing, so a halt there would throw away good work: ${error && error.message}`);
  same(processed, ["Book(01)", "Book(02)"], "polish walks every volume");
  same(assessed, [], "and nothing is assessed mid-step for a stage the table does not gate — the after-step assessment still covers it");

  fs.rmSync(fx.seriesDir, { recursive: true, force: true });
}

// ─── 5. The policy is a table, and the ungated stages are named in it ──────────

/**
 * @returns {void}
 */
function testPolicyIsDataAndNamesItsExceptions() {
  const { HALT_STAGES, NO_VOLUME_LOOP_STAGES, HALT_LEVELS, haltsForStep } = require("../utils/postmortem/halt");

  same(HALT_LEVELS, ["STOP", "MAJOR"], "the trigger is the level, declared once");
  same(
    HALT_STAGES.map((s) => s.step),
    ["glossary", "character-voice", "style-guide", "jump-in-wiki", "translate", "verify-translate"],
    "the gate is for the stages that carry the previous book forward AND pay per book"
  );
  for (const stage of HALT_STAGES) {
    ok(typeof stage.reason === "string" && stage.reason.length > 20, `${stage.step}: a stage in the table has to say why it is gated`);
  }
  // The stages that never reach the gate are named, with the reason, rather than absent.
  same(
    NO_VOLUME_LOOP_STAGES.map((s) => s.step).sort(),
    ["consistency-audit", "discover", "extract", "retranslate", "translate-qa", "translation-report"],
    "the steps that do not use the shared volume loop are named out loud, not silently ungated"
  );
  for (const stage of NO_VOLUME_LOOP_STAGES) {
    ok(typeof stage.reason === "string" && stage.reason.length > 20, `${stage.step}: naming a stage means saying why it is outside`);
    ok(!haltsForStep(stage.step), `${stage.step} is outside the gate`);
  }
  // `polish` uses the loop and is deliberately not gated.
  ok(!haltsForStep("polish"), "polish uses the shared loop and is deliberately outside the pause");
  ok(haltsForStep("glossary"), "glossary is inside it");

  // The table reads its trigger from the level table, and nowhere else. (The record and the report
  // still carry a severity, because a report's counts are built from it — but no decision to halt is
  // ever made from one.)
  const haltSource = fs.readFileSync(path.join(ROOT, "utils/postmortem/halt.js"), "utf8");
  ok(/require\("\.\/levels"\)/.test(haltSource), "the gate's trigger comes from utils/postmortem/levels.js");
  for (const fn of ["haltTriggerFor", "haltsForStep"]) {
    const body = haltSource.slice(haltSource.indexOf(`function ${fn}(`));
    ok(body.length > 0 && body.includes("\n}"), `${fn}: found in halt.js`);
    const src = body.slice(0, body.indexOf("\n}"));
    ok(!src.includes("severity"), `${fn}: the decision to halt reads the level, never a severity`);
  }
  const loopSource = fs.readFileSync(path.join(ROOT, "utils/series-run/loop.js"), "utf8");
  ok(!/severity\s*(===|!==)/.test(loopSource), "the loop never compares a severity to decide anything — it asks the level table");

  // The gate lives in a path the role it pauses may not edit.
  const { BANNED_PATCH_PATHS } = require("../utils/patches");
  same(
    BANNED_PATCH_PATHS.filter((r) => r.pattern && r.pattern.test("utils/postmortem/halt.js")).map((r) => r.id),
    ["constraint-tables"],
    "the halt policy lives in the same closed path as the level table — the paused role cannot widen its own exemption"
  );

  // Every stage that borrows the shared loop names itself to the gate. A stage that can stay
  // anonymous is a stage that is not gated.
  const LOOP_TASKS = [
    ["glossary.js", "glossary"],
    ["character-voice.js", "character-voice"],
    ["style-guide.js", "style-guide"],
    ["jump-in-wiki.js", "jump-in-wiki"],
    ["translate.js", "translate"],
    ["verify-translate.js", "verify-translate"],
    ["polish.js", "polish"],
  ];
  for (const [file, taskName] of LOOP_TASKS) {
    const src = readModuleLayer(ROOT, file);
    ok(/walkVolumes\(|runVolumeSeries\(/.test(src), `${file} uses the shared volume loop`);
    const gated = haltsForStep(taskName);
    if (!gated) continue;
    // `runVolumeSeries("glossary", …)` names the stage where the loop builds its failure summary;
    // a stage that borrows only the WALK (verify-translate) has to name itself to the gate directly.
    const namesItself =
      new RegExp(`runVolumeSeries\\("${taskName}"`).test(src) ||
      new RegExp(`step:\\s*"${taskName}"`).test(src);
    ok(namesItself, `${file} is a gated stage, so it must name itself to the gate ("${taskName}")`);
  }
}

// ─── 6. A halt is a record the after-step assessment can read ──────────────────

/**
 * @returns {Promise<void>}
 */
async function testHaltIsRecordedAndTheAfterStepAssessmentTellsItApart() {
  const fx = makeSeries({
    volumes: [
      { folder: "Book(01)", installment: "01", files: WRONG_SHAPE_GLOSSARY_VOLUME },
      { folder: "Book(02)", installment: "02", files: EMPTY_VOLUME },
      { folder: "Book(03)", installment: "03", files: EMPTY_VOLUME },
    ],
  });
  const { error } = await walkTwo({ ...fx, step: "glossary", volumes: ["Book(01)", "Book(02)", "Book(03)"] });
  ok(error, "the walk halted at volume 01");

  // The record the halt left, in the run's own records folder.
  const { readVolumeHalt } = require("../utils/postmortem/halt");
  const record = readVolumeHalt();
  ok(record, "the halt wrote a record a separate process can read");
  same(record.step, "glossary", "the record names the step that halted");
  same(record.haltedAfterVolume, "01", "and the volume it stopped after");
  same(record.attemptedVolumes, ["01"], "the volumes it attempted");
  same(record.unattemptedVolumes, ["02", "03"], "and the volumes it never reached");
  ok(record.trigger.some((f) => f.kind === "wrong-shape" && f.level === "MAJOR"), "the record carries the findings that stopped it");

  // The after-step assessment: the same machinery index/assess.js runs.
  const report = await runPostMortem({ step: "glossary", seriesDir: fx.seriesDir });
  const missing = report.findings.filter((f) => f.kind === "missing-required");
  same(
    missing.filter((f) => f.volume === "02" || f.volume === "03").map((f) => `${f.volume} ${f.file}`),
    [],
    `the volumes the run never attempted are not reported as broken books: ${missing.map((f) => `v${f.volume} ${f.file}`).join("; ")}`
  );
  // The series-root copy is a deliverable the step owes the SERIES, not one volume's output, and the
  // halt genuinely left it unpublished. It stays HIGH — with the halt named above it, so the reader
  // knows why it is missing.
  ok(
    missing.some((f) => f.volume === null),
    "the series-root copy the step never published is still reported, and the halt line says why"
  );
  ok(report.halt.suppressedMissing >= 2, `the unattempted volumes' missing output is counted, not lost: ${report.halt.suppressedMissing}`);
  const tripped = report.findings.filter((f) => f.volume === "01");
  ok(tripped.some((f) => f.kind === "wrong-shape"), "the volume that tripped the gate IS reported");
  ok(report.halt, "the report says the step stopped on purpose");
  same(report.halt.haltedAfterVolume, "01", "and says where");
  same(report.halt.unattemptedVolumes, ["02", "03"], "and which volumes it never reached");
  ok(!report.ok, "a step that halted is never reported as clean");
  ok(report.markdown.includes("halted after volume 01"), `the human-readable report says so:\n${report.markdown.slice(0, 400)}`);

  // A halt for one step must not silence another step's assessment.
  const other = await runPostMortem({ step: "character-voice", seriesDir: fx.seriesDir });
  ok(
    other.findings.some((f) => f.kind === "missing-required" && f.volume === "02"),
    "the record is scoped to the step that halted — another step's missing output is still reported"
  );

  fs.rmSync(fx.seriesDir, { recursive: true, force: true });
}

// ─── 7. The halt is not skippable ─────────────────────────────────────────────

/**
 * @returns {Promise<void>}
 */
async function testHaltSurvivesSkipPolicy() {
  const out = execFileSync(process.execPath, [__filename, "--child=skip-policy"], { encoding: "utf8" });
  ok(out.includes("CHILD-OK"), `the halt is not skippable: ${out.trim().slice(-400)}`);
}

/**
 * The child half of scenario 7: the same walk, with ON_VOLUME_ERROR=skip pinned in the environment
 * before the policy module is loaded.
 *
 * @returns {Promise<void>}
 */
async function childSkipPolicy() {
  const fx = makeSeries({
    volumes: [
      { folder: "Book(01)", installment: "01", files: WRONG_SHAPE_GLOSSARY_VOLUME },
      { folder: "Book(02)", installment: "02", files: CLEAN_GLOSSARY_VOLUME },
    ],
  });
  const { processed, error } = await walkTwo({ ...fx, step: "glossary" });
  if (!error) throw new Error("ON_VOLUME_ERROR=skip walked past a MAJOR finding");
  if (!isStructuralError(error)) throw new Error(`the halt is not tagged structural: ${error.message}`);
  if (processed.length !== 1) throw new Error(`the walk continued: ${processed.join(", ")}`);
  console.log("CHILD-OK");
}

// ─── 8. Nothing is assessed mid-chapter ───────────────────────────────────────

/**
 * @returns {Promise<void>}
 */
async function testAssessedOncePerVolume() {
  const fx = makeSeries({
    volumes: [
      { folder: "Book(01)", installment: "01", files: CLEAN_GLOSSARY_VOLUME },
      { folder: "Book(02)", installment: "02", files: CLEAN_GLOSSARY_VOLUME },
      { folder: "Book(03)", installment: "03", files: CLEAN_GLOSSARY_VOLUME },
    ],
  });
  let assessments = 0;
  /** @type {string[]} */
  const processed = [];
  const { error } = await capture(() =>
    runVolumeSeries("glossary", {
      volumes: ["Book(01)", "Book(02)", "Book(03)"],
      volumeByFolder: fx.byFolder,
      step: "glossary",
      seriesDir: fx.seriesDir,
      processVolume: async (folderName) => {
        processed.push(folderName);
        // A stage's own work touches many chapters. The gate must not follow it in.
        for (let chapter = 0; chapter < 5; chapter++) await Promise.resolve();
      },
      onVolumeAssessed: () => {
        assessments++;
      },
    })
  );
  ok(!error, `a clean run must not halt: ${error && error.message}`);
  same(processed.length, 3, "three volumes processed");
  same(assessments, 3, "three assessments — one per volume, not one per chapter");

  fs.rmSync(fx.seriesDir, { recursive: true, force: true });
}

// ─── 9. The trigger is the level, not the severity ─────────────────────────────

/**
 * @returns {Promise<void>}
 */
async function testTriggerFollowsTheLevel() {
  // `quarantine-present` beside a complete cumulative artifact is emitted at HIGH by the step's own
  // quarantine declaration, and declared NOTE by the level table. The gate follows the table.
  same(levelFor("quarantine-present"), "NOTE", "the level table declares this kind a NOTE");
  same(levelFor("wrong-shape"), "MAJOR", "and this kind a MAJOR");

  const fx = makeSeries({
    volumes: [
      {
        folder: "Book(01)",
        installment: "01",
        files: { ...CLEAN_GLOSSARY_VOLUME, "glossary.md.rejected": "# rejected\n" },
      },
      { folder: "Book(02)", installment: "02", files: CLEAN_GLOSSARY_VOLUME },
    ],
  });
  const noteRun = await walkTwo({ ...fx, step: "glossary" });
  ok(!noteRun.error, `a NOTE-level finding does not halt, whatever it is emitted at: ${noteRun.error && noteRun.error.message}`);
  same(noteRun.processed, ["Book(01)", "Book(02)"], "the walk continued");
  fs.rmSync(fx.seriesDir, { recursive: true, force: true });

  const majorFx = makeSeries({
    volumes: [
      { folder: "Book(01)", installment: "01", files: WRONG_SHAPE_GLOSSARY_VOLUME },
      { folder: "Book(02)", installment: "02", files: CLEAN_GLOSSARY_VOLUME },
    ],
  });
  const majorRun = await walkTwo({ ...majorFx, step: "glossary" });
  ok(majorRun.error, "a MAJOR-level finding halts");
  fs.rmSync(majorFx.seriesDir, { recursive: true, force: true });

  // And the gate's own table cannot be widened by a kind the level table calls a NOTE.
  const { haltTriggerFor } = require("../utils/postmortem/halt");
  same(
    haltTriggerFor([{ kind: "quarantine-present", level: levelFor("quarantine-present") }]),
    [],
    "haltTriggerFor takes the level from the table, so a NOTE kind can never halt"
  );
  same(
    haltTriggerFor([{ kind: "wrong-shape", level: levelFor("wrong-shape") }]).map((f) => f.kind),
    ["wrong-shape"],
    "and a MAJOR kind can"
  );
  ok(FINDING_LEVELS["wrong-shape"].level === "MAJOR", "the row the gate read is the row slice 1 wrote");

  // The two halves must fail closed the same way. `finding()` defaults an undeclared kind to MINOR;
  // the resume triage treats that as damage (utils/resume/state.js). If the gate trusted the defaulted
  // label, the same finding would be damage to the resume decision while the step walked straight past
  // the volume it fired in.
  const { finding } = require("../utils/postmortem/rules");
  const undeclared = finding("HIGH", "a-kind-nobody-declared-in-the-table", "glossary", "01", "x", "y");
  ok(undeclared.levelDeclared === false, "the finding says its own level was defaulted, which is what both halves read");
  same(
    haltTriggerFor([undeclared]).map((f) => f.kind),
    ["a-kind-nobody-declared-in-the-table"],
    "and a kind the level table does not know about halts the walk, not a silent MINOR"
  );
}

// ─── 10. No environment knob ──────────────────────────────────────────────────

/**
 * @returns {void}
 */
function testNoEnvironmentKnob() {
  for (const file of ["utils/postmortem/halt.js", "utils/series-run/loop.js"]) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    ok(!src.includes("process.env"), `${file} reads no environment variable: a guard the role can switch off is not a guard (rule 3, gotcha 70)`);
  }
  const docs = fs.readFileSync(path.join(ROOT, "docs/environment.md"), "utf8");
  ok(!/[A-Z0-9_]*(HALT|PAUSE)[A-Z0-9_]*/.test(docs), "no setting was added to docs/environment.md to switch the gate off");

  // The cost line must measure the assessments, not the walk. The first version timed from before
  // the loop to after it, which counted every model call the stage made as if it were the gate's cost.
  const loop = fs.readFileSync(path.join(ROOT, "utils/series-run/loop.js"), "utf8");
  ok(loop.includes("gateMs += Date.now() - assessStartedAt"), "the gate times each assessment on its own");
  ok(!loop.includes("gateStartedAt"), "and it does not time the walk and call that the gate's cost");
}

// ─── 11. The shape the gate halts on must describe the artifact ───────────────

/**
 * The gate's first act on real material was a halt on a false positive, and this is the
 * check that keeps it from coming back.
 *
 * `translation.md` used to be declared `shape: "document"` — a Markdown heading or a table.
 * The merge prints no heading for a chapter whose title is a file name, a pipeline label, or
 * a title still written in the source language (`utils/translate/merge.js: headingForSegment`),
 * and the translate prompt asks for the translation and nothing else. Measured against the
 * real corpus: 17 volumes, 133 chapters, 0 headings the merge would print. So every
 * legitimate translated volume was a `wrong-shape` MAJOR, and the gate halted the offline
 * loop's own translate stage at volume 1 on it.
 *
 * @returns {Promise<void>}
 */
async function testTranslatedBookIsNotAFalsePositive() {
  const { specForStep } = require("../utils/artifacts/specs");
  const { hasProseShape, proseParagraphs, matchesShape } = require("../utils/postmortem");

  // The published shape: the UNVERIFIED banner and prose paragraphs, no heading anywhere.
  const publishedBook = [
    "> **⚠ UNVERIFIED** — this chapter did not pass translation verification (no verification score).",
    "",
    "Mornings at the academy always began in fog, and the ginkgo trees on either side of the main",
    "gate sank into it at this time of year and kept only their outlines. I liked counting those",
    "outlines. By the time I finished counting, someone was always walking behind me.",
    "",
    "That day it was Akari. She walked three paces faster than me; rather than fast, it would be",
    "more accurate to say she did not know how to stop.",
    "",
    "In the first week we were told that the Pact is not a rule the Student Council wrote down but",
    "an agreement every student at this academy makes with themselves.",
    "",
  ].join("\n");

  for (const step of ["translate", "retranslate", "translate-qa", "polish"]) {
    const spec = specForStep(step);
    const book = (spec.volume || []).find((e) => e.name === "translation.md");
    same(book.shape, "prose", `${step}: translation.md is declared prose, not document`);
  }

  ok(matchesShape(publishedBook, "document") === false, "the OLD declaration rejects the real book — that was the false positive");
  ok(hasProseShape(publishedBook) === true, "the new one accepts it");
  same(proseParagraphs(publishedBook).length, 3, "and it counts the paragraphs, ignoring the banner");

  ok(hasProseShape("I will now assemble the volume's translation from the chapter files.\n") === false, "one line of model chatter is not a book");
  ok(hasProseShape("# Volume 01\n") === false, "a heading with nothing under it is not a book (document ACCEPTED that)");
  ok(hasProseShape("> **⚠ UNVERIFIED** — banner only.\n") === false, "a banner is not a book");
  ok(hasProseShape("| a | b |\n|---|---|\n| 1 | 2 |\n") === false, "a table is not a translated volume");

  // And the gate, walked over two volumes of exactly that legitimate shape, walks both.
  const fx = makeSeries({
    volumes: [
      { folder: "Book(01)", installment: "01", files: { "translation.md": publishedBook, "translation-state.json": "{}" } },
      { folder: "Book(02)", installment: "02", files: { "translation.md": publishedBook, "translation-state.json": "{}" } },
    ],
  });
  const assessed = await runPostMortem({ step: "translate", seriesDir: fx.seriesDir, volumeArg: "01" });
  ok(
    !assessed.findings.some((f) => f.kind === "wrong-shape"),
    `a legitimately heading-less book produces no shape finding: ${assessed.findings.map((f) => f.kind).join(", ") || "(none)"}`
  );
  const { processed, error } = await walkTwo({ ...fx, step: "translate" });
  ok(!error, `the gate does not halt on legitimate prose: ${error && error.message}`);
  same(processed, ["Book(01)", "Book(02)"], "both volumes are walked");
  fs.rmSync(fx.seriesDir, { recursive: true, force: true });
}

// ─── Entry points ─────────────────────────────────────────────────────────────

const CHILD_SCENARIOS = { "skip-policy": childSkipPolicy };

/**
 * A halt record belongs to the run that wrote it.
 *
 * The loop clears its own step's record before it walks. A step that dies BEFORE its walk — during
 * intake, on an unreadable plan of record — never reaches that line, and the previous run's halt would
 * then silence this run's genuinely missing books. `index/run-step.js` clears it beside the structural
 * marker, which is the same rule that file already applies to the marker.
 *
 * @returns {void}
 */
function testHaltRecordDoesNotOutliveItsRun() {
  const src = readModuleLayer(ROOT, "index/run-step.js", "index");
  ok(
    /clearVolumeHalt\(/.test(src),
    "the runner clears the halt record before each step, beside the structural marker it already clears"
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halt-record-"));
  try {
    process.env.POSTMORTEM_DIR = path.join(dir, "postmortem");
    writeVolumeHalt({ step: "glossary", haltedAfterVolume: "03", attemptedVolumes: ["01", "02", "03"], unattemptedVolumes: ["04"] });
    ok(readVolumeHalt(), "a record exists");
    clearVolumeHalt("translate");
    ok(readVolumeHalt(), "clearing for a DIFFERENT step leaves it alone — that step's assessment has not run yet");
    clearVolumeHalt("glossary");
    ok(!readVolumeHalt(), "clearing for the step about to run removes it");
  } finally {
    delete process.env.POSTMORTEM_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (childScenario) {
  const run = CHILD_SCENARIOS[childScenario];
  if (!run) {
    console.error(`CHILD-FAIL: unknown scenario --child=${childScenario}`);
    process.exit(1);
  }
  run()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`CHILD-FAIL: ${e && e.message}`);
      process.exit(1);
    });
} else {
  (async () => {
    await testMajorHaltsAtTheVolumeBoundary();
    console.log("  ok  a planted MAJOR in volume 1 halts the walk before volume 2");
    await testStopHalts();
    console.log("  ok  a planted STOP halts it too");
    await testMinorAndNoteDoNotHalt();
    console.log("  ok  a planted MINOR and a planted NOTE are recorded and the walk continues");
    await testPolishDoesNotHalt();
    console.log("  ok  polish is outside the policy table and does not halt on the same planted MAJOR");
    testPolicyIsDataAndNamesItsExceptions();
    console.log("  ok  the policy is a declared table, its exceptions are named, and it lives in a closed path");
    await testHaltIsRecordedAndTheAfterStepAssessmentTellsItApart();
    console.log("  ok  the halt is a record, and the after-step assessment tells it apart from broken books");
    testHaltSurvivesSkipPolicy();
    console.log("  ok  ON_VOLUME_ERROR=skip does not walk past the halt");
    await testAssessedOncePerVolume();
    console.log("  ok  the gate is asked once per volume, not once per chapter");
    await testTriggerFollowsTheLevel();
    console.log("  ok  the trigger is the level, not the severity");
    testNoEnvironmentKnob();
    console.log("  ok  no environment variable gates any of it");
    await testTranslatedBookIsNotAFalsePositive();
    console.log("  ok  the shape the gate halts on describes the artifact the step writes");
    testHaltRecordDoesNotOutliveItsRun();
    console.log("  ok  a halt record does not outlive the run that wrote it");
    console.log(`OK: ${checks} checks on the per-volume halt gate.`);
  })().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  });
}

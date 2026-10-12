/**
 * test-extract-run-scope.js — the extraction step's own records are checked, per book and for the
 * series, and the shape that makes "one report per volume" expressible is proven to work.
 *
 * Why this suite exists. `extract` writes 17 reports and a summary, all of them into the run's own
 * records folder rather than into a volume folder, and until 2026-10-12 it declared NONE of them, so
 * it was the one step in the run whose output nothing verified (gotcha 127). The account owner
 * reversed that in `utils/postmortem/plan/01-finding-levels.md` §10 for a specific reason: a crash
 * part-way through a 17-volume run leaves some reports written and some not, and a check that only
 * looked at the summary could not tell "the step ran and found nothing" from "the step stopped after
 * book 9". Closing that needed a new shape in the run-scope declaration — one expected file per
 * volume the run was asked to process — and a new shape is exactly the kind of thing that quietly
 * changes the four delivery commands it was built for. So this suite checks the new shape AND the
 * old four, in the same run.
 *
 * What is pinned here:
 *   1. `extract` declares its own records, and it is the ONLY pipeline step that declares a run
 *      scope: the other twelve are asserted to declare none.
 *   2. The names the declaration expects are the names the step WRITES. Checked by calling the
 *      step's own writers (`writeVolumeReport` / `writeSeriesSummary`) and then assessing, and by
 *      pinning the report-key rule against `extract`'s own `extractionReportBase` over the awkward
 *      inputs. A declaration that expects a file the writer never names is a check that fires on
 *      healthy output, which is the failure this repository keeps being told about.
 *   3. A complete extraction run reports NOTHING — including the volume whose archive would not
 *      open, because the step writes that volume's report too and the declaration has to agree.
 *   4. A missing per-book report is a finding that NAMES THE VOLUME, at HIGH, and makes the report
 *      not-clean. A missing summary is a finding. A stub and a half-written JSON are findings.
 *   5. A run limited to one volume expects that volume's report and is NOT blamed for the other
 *      sixteen — and the same series assessed without the limit IS blamed, which is the half that
 *      proves the filter is doing the work rather than the check being switched off.
 *   6. The four delivery commands' run-scope behaviour is unchanged: every one of their expectations
 *      is still one whole-run file, the counts do not move when a volume list is present, and the
 *      audit still reports nothing on a clean folder and HIGH on a claim the disk does not back.
 *   7. A dry run is not assessed as a failure: the runner turns the post-mortem off for it, and the
 *      extraction step writes nothing on that path. Checked by running the real runner.
 *   8. An assessment that cannot read the plan of record is never reported as clean — the step now
 *      needs the plan to know which books it owes a report for.
 *
 * No network, no endpoint, no model call, and nothing near the corpus: every scenario points
 * `POSTMORTEM_DIR` and `SERIES_LOCATION` at its own throwaway fixture (AGENTS.md rule 8, gotcha 69).
 * Run with `npm test`, or standalone: `node test/test-extract-run-scope.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

const { STEP_ARTIFACT_SPECS, DELIVERY_COMMANDS, specForStep } = require("../utils/artifacts");
const {
  runPostMortem,
  postMortemDir,
  countRunExpectations,
  runScopeTargets,
  runScopeVolumeKey,
  declaresPerInstallmentRunScope,
} = require("../utils/postmortem");
const { auditDeliveryRun } = require("../utils/delivery-audit");
const { extractionReportBase, writeVolumeReport, writeSeriesSummary } = require("../extract");
const { fixtureSeries } = require("./fixture-series");

const savedPostMortemDir = process.env.POSTMORTEM_DIR;
const savedSeriesLocation = process.env.SERIES_LOCATION;
const savedLedger = process.env.LEDGER_ENABLED;

let passed = 0;

/**
 * Record one passing check.
 * @param {string} name
 * @returns {void}
 */
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

/**
 * The finding kinds a report raised.
 * @param {import("../utils/postmortem").PostMortemReport} report
 * @returns {Set<string>}
 */
function kinds(report) {
  return new Set(report.findings.map((f) => f.kind));
}

/**
 * The one finding of a kind, for asserting its severity and what it names.
 * @param {import("../utils/postmortem").PostMortemReport} report
 * @param {string} kind
 * @returns {Object|null}
 */
function findingOf(report, kind) {
  return report.findings.find((f) => f.kind === kind) || null;
}

/**
 * A record in the shape `extract/run.js` hands `writeVolumeReport`, so the fixture is built by the
 * step's own writer rather than by a guess about what a report looks like.
 *
 * @param {string} installment
 * @param {string} folder
 * @param {string|null} [error] - Set for the volume the step could not read.
 * @returns {import("../extract/reports").ExtractionVolumeRecord}
 */
function volumeRecord(installment, folder, error = null) {
  return {
    step: "extract",
    installment,
    folder,
    action: error
      ? null
      : {
          state: "verified",
          label: "VERIFIED",
          reason: "the bundle on disk matches the archive and schema",
          line: `[extract] Volume ${installment} · VERIFIED`,
        },
    sourceFile: `${folder}/book.epub`,
    sourceFormat: error ? null : "epub",
    sourceFingerprint: error ? null : "0123456789abcdef",
    bundleSchema: error ? null : 8,
    counts: {
      chapters: 3,
      packaging: 1,
      characters: 1234,
      guides: 12,
      guideChars: 34,
      images: 5,
      HIGH: 0,
      MEDIUM: 0,
      findings: 0,
    },
    chapters: [{ id: "ch1", title: "第一章", file: "book-ch1.md", chars: 400, bodyChars: 380, empty: false, syntheticTitle: false }],
    packaging: [{ title: "表紙", reason: "cover page", pages: 1, bodyChars: 0, textChars: 0 }],
    findings: [],
    error,
  };
}

/**
 * A delivery plan of record in the shape `npm run delivery` writes, so the delivery half of this
 * suite is asserting against a record the audit's own invariants accept rather than against a stub it
 * would (correctly) complain about.
 *
 * @param {string} runDir
 * @returns {Promise<void>}
 */
async function writeDeliveryPlan(runDir) {
  const plan = { mode: "report", run: "run-1", steps: [{ step: "glossary" }], execution: [] };
  await fsp.writeFile(path.join(runDir, "delivery-plan.md"), "# Delivery plan\n\n## Verdict\n\n- resume glossary from volume 02\n", "utf8");
  await fsp.writeFile(path.join(runDir, "delivery-plan.json"), JSON.stringify(plan, null, 2) + "\n", "utf8");
}

/**
 * A fixture series plus the extraction records a finished run of the step would have left in the
 * run's own folder — written through the STEP'S OWN writers, not hand-built.
 *
 * @param {string} label
 * @param {Array<{folder: string, installmentNumber: string}>} [volumes] - Which volumes this fixture's
 *   run processed. Defaults to both.
 * @param {boolean} [withFailedVolume] - Include the volume whose archive would not open.
 * @returns {Promise<{dir: string, runDir: string, volumes: Array<{folder: string, installmentNumber: string}>}>}
 */
async function extractionRun(label, volumes, withFailedVolume = false) {
  const fx = await fixtureSeries(label);
  const wanted = volumes || fx.volumes;
  const records = wanted.map((v) => volumeRecord(v.installmentNumber, v.folder));
  if (withFailedVolume) {
    // The LAST planned volume is the one whose archive would not open. It has to be a volume the plan
    // of record lists, because the plan is what defines which books the run was asked to process —
    // a report for a volume nobody planned is not an expectation, and pretending otherwise would make
    // the assessment invent a book.
    const last = wanted[wanted.length - 1];
    records[records.length - 1] = volumeRecord(
      last.installmentNumber,
      last.folder,
      `ENOENT: no such file or directory, open '${last.folder}/book.epub'`
    );
  }
  for (const record of records) await writeVolumeReport({ record, outDir: fx.ledgerDir });
  await writeSeriesSummary({ records, seriesName: "Test Story", outDir: fx.ledgerDir });
  return { dir: fx.dir, runDir: fx.ledgerDir, volumes: wanted, records };
}

// ─── 1. the declaration, and who is allowed to have one ───────────────────────

/**
 * `extract` declares its records; the other twelve pipeline steps declare none; the delivery
 * commands' expectations are all whole-run files.
 * @returns {Promise<void>}
 */
async function scenarioDeclaration() {
  const spec = specForStep("extract");
  assert.ok(spec && Array.isArray(spec.run) && spec.run.length === 4, `extract declares 4 run expectations: ${JSON.stringify(spec && spec.run)}`);
  const perVolume = spec.run.filter((e) => e.perInstallment === true);
  assert.strictEqual(perVolume.length, 2, "the per-book pair (markdown + json) is the per-installment half");
  assert.ok(
    perVolume.every((e) => e.name.includes("{installment}")),
    `a per-installment expectation names the volume in its file name: ${perVolume.map((e) => e.name).join(", ")}`
  );
  assert.ok(
    spec.run.every((e) => e.level === "required"),
    "every one of them is `required`: the step writes a report for every volume it attempts, " +
      "including the one it could not read, and writes the summary before it throws"
  );
  assert.ok(declaresPerInstallmentRunScope(spec), "the assessment can tell it needs a plan of record to know which books to expect");
  ok("extract declares its own per-book and series records, all four at `required`");

  const pipeline = Object.keys(STEP_ARTIFACT_SPECS).filter((n) => !DELIVERY_COMMANDS.includes(n));
  const withRun = pipeline.filter((n) => STEP_ARTIFACT_SPECS[n].run !== undefined);
  assert.deepStrictEqual(withRun, ["extract"], `extract is the one named exception, got: ${withRun.join(", ") || "(none)"}`);
  assert.strictEqual(pipeline.length - withRun.length, 12, "the other twelve pipeline steps still declare no run scope");
  for (const name of pipeline) {
    if (name === "extract") continue;
    assert.strictEqual(STEP_ARTIFACT_SPECS[name].run, undefined, `${name} must not declare a run scope`);
    assert.ok(!declaresPerInstallmentRunScope(STEP_ARTIFACT_SPECS[name]), `${name} declares no per-installment run expectation`);
  }
  ok("the exception is exactly one step, and the twelve others are still pinned to declare nothing");

  for (const name of DELIVERY_COMMANDS) {
    for (const e of specForStep(name).run || []) {
      assert.notStrictEqual(e.perInstallment, true, `${name}.${e.name} is a whole-run record, not one per volume`);
    }
  }
  ok("none of the four delivery commands' expectations became per-volume");
}

// ─── 2. the names the declaration expects are the names the step writes ───────

/**
 * The report-key rule, pinned against the writer's own.
 *
 * Two implementations of one naming rule is a pair that drifts, and a drift here means the assessment
 * looks for a file the step never promised and reports a healthy run as missing its report.
 * @returns {Promise<void>}
 */
async function scenarioNamingAgreesWithTheWriter() {
  const cases = [
    { installmentNumber: "01", folder: "Test Story(01)" },
    { installmentNumber: "17", folder: "俺を好きなのはお前だけかよ(17)" },
    { installmentNumber: "", folder: "俺を好きなのはお前だけかよ(01)" },
    { installmentNumber: "", folder: "Test Story(01)" },
    { installmentNumber: "", folder: "a book/with: odd*chars" },
    { installmentNumber: "", folder: "..leading-dots" },
    { installmentNumber: "", folder: "" },
  ];
  for (const c of cases) {
    const key = runScopeVolumeKey(c);
    const writerKey = extractionReportBase(c.installmentNumber || c.folder).replace(/^extraction-/, "");
    assert.strictEqual(key, writerKey, `the assessment and the writer disagree about the key for ${JSON.stringify(c)}: ${key} vs ${writerKey}`);
  }
  ok(`the report key matches extract's own rule on ${cases.length} awkward volume identities (0 disagreements)`);

  // And the whole file name, produced by the step's own writers and then assessed.
  const run = await extractionRun("naming");
  const names = (await fsp.readdir(run.runDir)).sort();
  assert.deepStrictEqual(
    names,
    ["extraction-01.json", "extraction-01.md", "extraction-02.json", "extraction-02.md", "extraction-summary.json", "extraction-summary.md"],
    `the step's writers produced: ${names.join(", ")}`
  );
  ok("the step's own writers produce exactly the six files the declaration expects");
}

// ─── 3. a complete extraction run reports nothing ─────────────────────────────

/**
 * The false-positive half, and the more important half: a run that wrote everything is not blamed,
 * including for the volume whose archive would not open.
 * @returns {Promise<void>}
 */
async function scenarioCompleteRunReportsNothing() {
  const run = await extractionRun("complete");
  const report = await runPostMortem({ step: "extract", seriesDir: run.dir });
  assert.strictEqual(report.error, undefined, report.error);
  assert.strictEqual(report.findings.length, 0, `a complete extraction run reported:\n${report.markdown}`);
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.counts.checked, 6, "2 volumes × 2 records + the summary pair");
  assert.strictEqual(report.counts.volumes, 2, "the report says which volumes were looked at");
  ok("a complete extraction run reports nothing, and says 6 expectations were checked");

  // The FAILED volume still has a report: the step writes one for a book it could not read, so the
  // declaration must not call that volume's record missing.
  const failed = await extractionRun("failed-volume", null, true);
  const r2 = await runPostMortem({ step: "extract", seriesDir: failed.dir });
  assert.strictEqual(r2.findings.length, 0, `a run whose volume 02 could not be read reported its report as missing:\n${r2.markdown}`);
  assert.strictEqual(r2.counts.checked, 6, "2 volumes × 2 + the summary pair");
  ok("the volume the step could not read still holds its report, and is not blamed for being unreadable");
}

// ─── 4. every missing or broken record is a finding that names the volume ─────

/**
 * Each case removes or corrupts ONE record in an otherwise complete run folder. If a case stops being
 * detected the suite fails — the only way to know the check is still looking.
 */
const DEFECT_CASES = [
  {
    label: "volume 02's Markdown report is gone",
    async plant(runDir) {
      await fsp.rm(path.join(runDir, "extraction-02.md"), { force: true });
    },
    expect: "missing-required",
    severity: "HIGH",
    namesVolume: "02",
    namesFile: "extraction-02.md",
  },
  {
    label: "volume 01's JSON half is gone",
    async plant(runDir) {
      await fsp.rm(path.join(runDir, "extraction-01.json"), { force: true });
    },
    expect: "missing-required",
    severity: "HIGH",
    namesVolume: "01",
    namesFile: "extraction-01.json",
  },
  {
    label: "the series summary is gone",
    async plant(runDir) {
      await fsp.rm(path.join(runDir, "extraction-summary.md"), { force: true });
    },
    expect: "missing-required",
    severity: "HIGH",
    namesVolume: null,
    namesFile: "extraction-summary.md",
  },
  {
    label: "the summary's JSON half is gone",
    async plant(runDir) {
      await fsp.rm(path.join(runDir, "extraction-summary.json"), { force: true });
    },
    expect: "missing-required",
    severity: "HIGH",
    namesVolume: null,
    namesFile: "extraction-summary.json",
  },
  {
    label: "volume 02's report is a scaffold stub that never became a report",
    async plant(runDir) {
      await fsp.writeFile(path.join(runDir, "extraction-02.md"), "(stub — the merge pass replaces this)\n", "utf8");
    },
    expect: "empty-or-stub",
    severity: "HIGH",
    namesVolume: "02",
    namesFile: "extraction-02.md",
  },
  {
    label: "volume 01's JSON half is half-written JSON",
    async plant(runDir) {
      await fsp.writeFile(path.join(runDir, "extraction-01.json"), '{"volume": "01", "counts": {', "utf8");
    },
    expect: "bad-json",
    severity: "HIGH",
    namesVolume: "01",
    namesFile: "extraction-01.json",
  },
  {
    label: "volume 02's Markdown half has no heading and no table",
    async plant(runDir) {
      await fsp.writeFile(path.join(runDir, "extraction-02.md"), "extracted 3 chapters, all fine\n", "utf8");
    },
    expect: "wrong-shape",
    severity: "MEDIUM",
    namesVolume: "02",
    namesFile: "extraction-02.md",
  },
];

/**
 * Plant one defect at a time and assert it is named, at the right severity, with the volume it
 * belongs to. A finding that says "extract did not finish" is not actionable; one that says volume 02
 * lost its report is.
 * @returns {Promise<void>}
 */
async function scenarioPlantedDefects() {
  for (const c of DEFECT_CASES) {
    const run = await extractionRun("defect");
    await c.plant(run.runDir);
    const report = await runPostMortem({ step: "extract", seriesDir: run.dir });

    const f = findingOf(report, c.expect);
    assert.ok(f, `planted defect not detected — "${c.label}" (expected kind ${c.expect}):\n${report.markdown}`);
    assert.strictEqual(f.severity, c.severity, `${c.label}: severity should be ${c.severity}, got ${f.severity}`);
    assert.strictEqual(f.volume, c.namesVolume, `${c.label}: the finding must name volume ${c.namesVolume}, got ${f.volume}`);
    assert.ok(f.file.includes(c.namesFile), `${c.label}: the finding must name ${c.namesFile}, got ${f.file}`);
    assert.ok(f.message.length > 30, `${c.label}: the finding must say something a reader can act on`);
    assert.strictEqual(
      report.ok,
      c.severity !== "HIGH",
      `${c.label}: a HIGH finding must not read as a clean run, and a MEDIUM one must not read as a failure`
    );
    assert.strictEqual(
      report.counts.checked,
      6,
      `${c.label}: a record that was looked for and found broken still counts as checked`
    );
  }
  ok(`${DEFECT_CASES.length} planted record defects all detected, each naming the volume it belongs to`);

  // The whole-run half of the report line: a run that wrote NOTHING at all is named as such.
  const fx = await fixtureSeries("nothing-written");
  const report = await runPostMortem({ step: "extract", seriesDir: fx.dir });
  assert.strictEqual(report.findings.length, 6, `a run that wrote no record reported ${report.findings.length}:\n${report.markdown}`);
  assert.strictEqual(report.counts.HIGH, 6);
  assert.strictEqual(report.ok, false);
  ok("a run that wrote no record at all is reported as damage, not as a clean step with no output");
}

// ─── 5. a partial run is not 16 false alarms ──────────────────────────────────

/**
 * `--volume=01` processes one volume. The per-volume half of the assessment already filters volumes
 * for the corpus scope; the run scope has to be filtered too, or a one-volume run is blamed for the
 * sixteen reports it was never asked to write.
 * @returns {Promise<void>}
 */
async function scenarioPartialRun() {
  const run = await extractionRun("partial", [
    { folder: "Test Story(01)", installmentNumber: "01" },
  ]);
  const one = await runPostMortem({ step: "extract", seriesDir: run.dir, volumeArg: "01" });
  assert.strictEqual(one.findings.length, 0, `a --volume=01 run was blamed for the volumes it was not asked to process:\n${one.markdown}`);
  assert.strictEqual(one.counts.volumes, 1);
  assert.strictEqual(one.counts.checked, 4, "volume 01's pair + the summary pair the step still writes");
  ok("--volume=01 expects volume 01's report and the summary, and is not blamed for volume 02");

  // The same folder, assessed as a whole-series run, IS blamed for volume 02 — which is the half that
  // proves the filter above is doing the work rather than the check being switched off.
  const whole = await runPostMortem({ step: "extract", seriesDir: run.dir });
  assert.strictEqual(whole.findings.length, 2, `the same folder assessed as a full run reported ${whole.findings.length}:\n${whole.markdown}`);
  assert.ok(
    whole.findings.every((f) => f.file.includes("extraction-02")),
    `the findings must name volume 02: ${whole.findings.map((f) => f.file).join(", ")}`
  );
  assert.strictEqual(whole.counts.checked, 6);
  ok("the same folder assessed without the limit reports volume 02's two missing records");

  // A folder name is a valid `--volume` value, and it scopes the run expectations the same way.
  const byName = await runPostMortem({ step: "extract", seriesDir: run.dir, volumeArg: "Test Story(01)" });
  assert.strictEqual(byName.findings.length, 0, byName.markdown);
  assert.strictEqual(byName.counts.volumes, 1);
  ok("--volume by folder name scopes the run expectations too");

  // And the shape that a real crash leaves: books 01–02 written, book 03 never reached.
  const crashed = await extractionRun("crashed-after-2", [
    { folder: "Test Story(01)", installmentNumber: "01" },
    { folder: "Test Story(02)", installmentNumber: "02" },
  ]);
  await fsp.rm(path.join(crashed.runDir, "extraction-summary.md"), { force: true });
  const stopped = await runPostMortem({ step: "extract", seriesDir: crashed.dir });
  assert.ok(
    kinds(stopped).has("missing-required"),
    `a run that stopped before writing the summary reads as clean:\n${stopped.markdown}`
  );
  ok("a run that stopped part-way is distinguishable from a run that finished and found nothing");
}

// ─── 6. the four delivery commands are assessed exactly as before ─────────────

/**
 * The new shape must not touch the old four. Checked two ways: as pure expansion (every delivery
 * expectation is still one whole-run target with no volume attached, with or without a volume list),
 * and through the real audit on a clean folder and on a claim the disk does not back.
 * @returns {Promise<void>}
 */
async function scenarioDeliveryCommandsUnchanged() {
  const ctx = {
    researchEnabled: true,
    verifyEnabled: true,
    volumeConsistencyEnabled: true,
    polishVerifyEnabled: true,
    installment: "",
    planRecordClaimed: true,
    ticketRecordClaimed: true,
    patchRecordClaimed: true,
    acting: true,
  };
  const volumes = [
    { folder: "Test Story(01)", installmentNumber: "01" },
    { folder: "Test Story(02)", installmentNumber: "02" },
  ];
  for (const name of DELIVERY_COMMANDS) {
    const spec = specForStep(name);
    const expectations = spec.run || [];
    const withoutVolumes = countRunExpectations({ spec, ctx });
    const withVolumes = countRunExpectations({ spec, ctx, volumes });
    assert.strictEqual(withVolumes, withoutVolumes, `${name}: a volume list changed how many expectations apply (${withoutVolumes} → ${withVolumes})`);
    for (const e of expectations) {
      const targets = runScopeTargets(e, volumes);
      assert.strictEqual(targets.length, 1, `${name}.${e.name} must resolve to exactly one file`);
      assert.strictEqual(targets[0].name, e.name, `${name}.${e.name} must keep its declared name`);
      assert.strictEqual(targets[0].volume, null, `${name}.${e.name} is not a per-volume record`);
    }
  }
  ok("all four delivery commands still resolve to whole-run files, with or without a volume list");

  // Through the real audit: a clean run folder still reports nothing, and a claim the disk does not
  // back is still HIGH. These are the two numbers test-delivery-audit.js pins.
  process.env.LEDGER_ENABLED = "false";
  const fx = await fixtureSeries("delivery-unchanged");
  await writeDeliveryPlan(fx.ledgerDir);
  const clean = await auditDeliveryRun({ step: "delivery", argv: ["--mode=report"], exitCode: 0, quiet: true });
  assert.strictEqual(clean.error, null, clean.error);
  assert.strictEqual(clean.report.findings.length, 0, `a delivery run that wrote its plan reported:\n${clean.report.markdown}`);
  assert.strictEqual(clean.report.counts.checked, 2, "both declared records were looked for");

  await fsp.rm(path.join(postMortemDir(), "delivery-plan.json"), { force: true });
  const broken = await auditDeliveryRun({ step: "delivery", argv: ["--mode=report"], exitCode: 0, quiet: true });
  const f = findingOf(broken.report, "missing-required");
  assert.ok(f, `a delivery command that claimed a plan it did not write is not reported:\n${broken.report.markdown}`);
  assert.strictEqual(f.severity, "HIGH");
  assert.strictEqual(f.volume, null, "a whole-run record's finding names no volume");
  ok("the delivery commands' run-scope audit still reports nothing when clean and HIGH when the claim is unsupported");
}

// ─── 7. a dry run is not assessed as a failure ────────────────────────────────

/**
 * `--dry-run` writes nothing, and the extraction step in particular writes no report at all. The
 * runner turns the post-mortem off for a dry run, so the new expectations cannot fire on it. Checked
 * by running the real runner against a fixture, because the gate lives in the walk, not in a function
 * this suite could call.
 * @returns {Promise<void>}
 */
async function scenarioDryRunIsNotAssessed() {
  const fx = await fixtureSeries("dry-run");
  const recordsBefore = (await fsp.readdir(fx.ledgerDir)).sort();
  const res = spawnSync(process.execPath, [path.join(ROOT, "index.js"), "--stages=extract", "--dry-run"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      SERIES_LOCATION: fx.dir,
      POSTMORTEM_DIR: fx.ledgerDir,
      RUN_DIR: await fsp.mkdtemp(path.join(os.tmpdir(), "extract-scope-dryrun-")),
    },
  });
  assert.strictEqual(res.status, 0, `index.js --stages=extract --dry-run failed: ${res.stderr}`);
  assert.ok(/post-mortem: off \(dry-run\)/.test(res.stdout), `the runner did not switch the post-mortem off for a dry run:\n${res.stdout}`);
  assert.ok(!/extract post-mortem/.test(res.stdout), `the runner assessed a dry run:\n${res.stdout}`);
  const recordsAfter = (await fsp.readdir(fx.ledgerDir)).sort();
  assert.deepStrictEqual(recordsAfter, recordsBefore, `a dry run wrote records into the run folder: ${recordsAfter.join(", ")}`);
  assert.ok(!fs.existsSync(path.join(fx.ledgerDir, "extract.md")), "no post-mortem report was written for a dry run");
  ok("--dry-run writes nothing and is not assessed (the runner's own gate, checked by running it)");

  // The step's own sentence, so the operator is not left guessing why nothing happened.
  assert.ok(/no prompt to dump/.test(res.stdout), `the step did not say what --dry-run means for it:\n${res.stdout}`);
  ok("the extraction step says out loud that a dry run does nothing, rather than pretending to plan");
}

// ─── 8. an assessment that cannot read the plan is never clean ────────────────

/**
 * A per-installment run expectation names files after volumes, and the list of volumes only exists in
 * the plan of record. So `extract` now needs the plan, and an assessment that cannot read it has to
 * say so rather than report a step that checked nothing.
 * @returns {Promise<void>}
 */
async function scenarioNeedsThePlan() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "extract-scope-noplan-"));
  const report = await runPostMortem({ step: "extract", seriesDir: dir });
  assert.ok(report.error, "an assessment with no readable plan of record must say it could not run");
  assert.strictEqual(report.ok, false, "and must never read as clean");
  assert.strictEqual(report.counts.checked, 0);
  ok("extract needs the plan of record to know which books it owes a report for, and says so when it cannot read one");

  // A delivery command still does NOT need one: `diagnose` can be pointed at a ticket with no
  // readable series folder beside it, and blaming it for a plan it never read is a false alarm.
  const diagnose = await runPostMortem({ step: "diagnose", seriesDir: dir, claims: {} });
  assert.strictEqual(diagnose.error, undefined, `diagnose was made to need a plan of record: ${diagnose.error}`);
  assert.strictEqual(diagnose.counts.checked, 0, "it claims nothing, so it is blamed for nothing");
  ok("the delivery commands are still assessable without a plan of record — the new requirement is scoped to per-installment expectations");
}

// ─── run ──────────────────────────────────────────────────────────────────────

(async function main() {
  try {
    await scenarioDeclaration();
    await scenarioNamingAgreesWithTheWriter();
    await scenarioCompleteRunReportsNothing();
    await scenarioPlantedDefects();
    await scenarioPartialRun();
    await scenarioDeliveryCommandsUnchanged();
    await scenarioDryRunIsNotAssessed();
    await scenarioNeedsThePlan();
    console.log(`\nextract-run-scope: all ${passed} checks passed.`);
  } finally {
    if (savedPostMortemDir === undefined) delete process.env.POSTMORTEM_DIR;
    else process.env.POSTMORTEM_DIR = savedPostMortemDir;
    if (savedSeriesLocation === undefined) delete process.env.SERIES_LOCATION;
    else process.env.SERIES_LOCATION = savedSeriesLocation;
    if (savedLedger === undefined) delete process.env.LEDGER_ENABLED;
    else process.env.LEDGER_ENABLED = savedLedger;
  }
})();

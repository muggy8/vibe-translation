/**
 * test-postmortem.js — the deterministic "did this step leave what it always
 * leaves?" check, and proof that the check has teeth.
 *
 * Why this suite plants its own defects. `test-pipeline-loop.js --audit-selftest`
 * exists because "a check that can never fail is not a check". The post-mortem is
 * the same kind of thing: a green run tells you nothing about whether it looked.
 * So this suite seeds a healthy series, asserts it reports NOTHING, and then
 * plants one known defect per finding class and asserts every one is reported.
 * A post-mortem that reports nothing on a broken series is the exact failure mode
 * it was written to catch.
 *
 * What is pinned here:
 *   1. The three step lists cannot drift: utils/hooks.js TASKS, gulpfile.js
 *      PIPELINE_STEPS, and utils/artifacts.js declarations. A step the pipeline can
 *      run but nobody declared is itself a HIGH finding — the test catches it earlier.
 *   2. A healthy volume reports nothing. That is the false-positive half, and it is
 *      the half that makes people ignore a checker (gotcha 65's lesson: a guard that
 *      calls an improvement a loss quietly destroys the work the pipeline paid for).
 *   3. Every finding class fires on its real shape: missing required output, a
 *      scaffold stub left in place, unparseable JSON, a document without the shape
 *      its prompt specifies, quarantine evidence nobody read, a stale stray, a volume
 *      published on a rolling window that never accepted it, a chapter with no draft,
 *      and an audit verdict of FAIL.
 *   4. The volume-04 case specifically: a `glossary.md` with nothing beside it, which
 *      is caught by the ABSENCE of the files that always come with it.
 *   5. An assessment that could not run is never reported as clean.
 *   6. `--volume` scoping matches what the tasks actually do (a single-volume run
 *      deliberately does not publish the series-root copies, so it is not blamed for them).
 *   7. index.js reads the step list from gulpfile and runs each step as its own
 *      process — checked without calling a model.
 *   8. The folder a run remembers itself in: the post-mortem reports, the ledger, the tickets
 *      and the run lock all resolve to the repo's own `.postmortem`, and the token-calibration
 *      cache to the repo's own file — not into the folder a split module lives in. Every other
 *      suite passes those paths explicitly, so only this one can catch the default moving.
 *
 * No network, no endpoint, no model call. Run with `npm test` (or standalone:
 * `node test/test-postmortem.js`).
 */
const assert = require("assert");
const fs = require("fs").promises;
const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");

const { TASKS } = require("../utils/hooks");
const { declaredSteps, isKnownVolumeFile } = require("../utils/artifacts");
const {
  runPostMortem,
  renderPostMortemMarkdown,
  postMortemDir,
  hasTableShape,
  matchesShape,
  readConsistencyVerdict,
} = require("../utils/postmortem");

const GULPFILE = require("../gulpfile");

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** A Markdown table — the shape every glossary prompt specifies. */
const TABLE = `# Glossary

| Term | Rendering | Notes |
|---|---|---|
| \u4e3b\u4eba\u516c | protagonist | carried from volume 01 |
`;

/** A headed Markdown document. */
const DOC = `# Report

## Findings

- nothing wrong here
`;

/**
 * Lay out a two-volume series whose glossary step finished cleanly.
 *
 * @param {string} dir - Series folder.
 * @returns {Promise<{dir: string, volumes: Array<{folder: string, installmentNumber: string}>}>}
 */
async function seedSeries(dir) {
  const volumes = [
    { folder: "Test Story(01)", installmentNumber: "01" },
    { folder: "Test Story(02)", installmentNumber: "02" },
  ];
  for (const v of volumes) {
    const volDir = path.join(dir, v.folder);
    await fs.mkdir(volDir, { recursive: true });
    // The staged book and the extraction cache: legitimate, and not step output.
    await fs.writeFile(path.join(volDir, "book.epub"), "not really an epub", "utf8");
    await fs.writeFile(path.join(volDir, "book-whole.md"), DOC, "utf8");
    await fs.writeFile(path.join(volDir, "book-bundle.meta.json"), "{}", "utf8");

    await fs.writeFile(path.join(volDir, "glossary.md"), TABLE, "utf8");
    await fs.writeFile(path.join(volDir, "glossary-validation.md"), DOC, "utf8");
    await fs.writeFile(
      path.join(volDir, "glossary-validation-rolling-state.json"),
      JSON.stringify({ results: [78, 82], acceptedBy: "rolling-window" }),
      "utf8"
    );
    await fs.writeFile(path.join(volDir, "glossary-new-terms.json"), "[]", "utf8");
    await fs.writeFile(path.join(volDir, "glossary-coverage.md"), DOC, "utf8");
    await fs.writeFile(path.join(volDir, "glossary-coverage.json"), "{}", "utf8");
    await fs.writeFile(path.join(volDir, "glossary-research.md"), DOC, "utf8");
  }

  await fs.writeFile(path.join(dir, "glossary.md"), TABLE, "utf8");
  await fs.writeFile(
    path.join(dir, "glossary.md.provenance.json"),
    JSON.stringify({ file: "glossary.md", volume: volumes[1].folder }),
    "utf8"
  );

  await fs.writeFile(
    path.join(dir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesName: "Test Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        seriesLocation: dir,
        volumes: volumes.map((v) => ({
          folder: v.folder,
          sourceFile: `${v.folder}/book.epub`,
          installmentNumber: v.installmentNumber,
        })),
      },
      null,
      2
    ),
    "utf8"
  );

  return { dir, volumes };
}

/**
 * A fresh temp series with a clean glossary step already reflected on disk.
 * @param {string} label
 * @returns {Promise<{dir: string, volumes: Object[]}>}
 */
async function freshSeries(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `postmortem-${label}-`));
  return seedSeries(dir);
}

/**
 * The finding kinds a report raised.
 * @param {import("../utils/postmortem").PostMortemReport} report
 * @returns {Set<string>}
 */
function kinds(report) {
  return new Set(report.findings.map((f) => f.kind));
}

// ─── 1. The three step lists cannot drift ─────────────────────────────────────

async function scenarioStepListsAgree() {
  const declared = new Set(declaredSteps());
  const hookNames = new Set(TASKS);
  const stepNames = GULPFILE.PIPELINE_STEPS.map((s) => s.name);

  // Every step the default run can execute must be declared in the artifact manifest.
  for (const name of stepNames) {
    assert.ok(declared.has(name), `step "${name}" runs in the pipeline but has no artifact spec`);
  }
  // Every hook name too — TASKS is the wider list (it includes the translation
  // sub-tasks that are not default-run steps but are runnable on their own).
  for (const name of hookNames) {
    assert.ok(declared.has(name), `hook name "${name}" has no artifact spec`);
  }
  // And nothing may be declared for a step that does not exist.
  for (const name of declared) {
    assert.ok(hookNames.has(name), `artifact spec "${name}" is not a real step name`);
  }

  // The mistake exporting PIPELINE_STEPS exists to prevent: gulpfile's default
  // export is the single-process runner, not a step list.
  assert.strictEqual(typeof GULPFILE.default, "function");
  assert.ok(Array.isArray(GULPFILE.PIPELINE_STEPS), "PIPELINE_STEPS must be exported as a list");
  assert.ok(GULPFILE.PIPELINE_STEPS.every((s) => typeof s.run === "function"));
}

// ─── 2. Shape rules and the file vocabulary ───────────────────────────────────

async function scenarioShapeRules() {
  assert.ok(hasTableShape(TABLE));
  assert.ok(!hasTableShape(DOC), "a headed document with no table is not a table");
  assert.ok(!hasTableShape("| a | b |\nnot a separator"), "a pipe row needs its separator line");

  assert.ok(matchesShape(TABLE, "table"));
  assert.ok(matchesShape(DOC, "document"));
  assert.ok(!matchesShape(DOC, "table"));
  assert.ok(matchesShape('{"a":1}', "json"));
  assert.ok(!matchesShape('{"a":', "json"));
  assert.ok(matchesShape("anything", "any"));
  assert.ok(matchesShape("anything", undefined));

  // Files the unexpected-file check must NOT complain about. volume-consistency.*
  // is declared for the verify steps but lives in the volume folder for the whole
  // life of the volume, so every other step would otherwise call it a stray.
  for (const name of [
    "book-part-03.md",
    "volume-consistency.json",
    "volume-consistency.md",
    "glossary.md.rejected",
    "translation-ch1.rejected.md",
    "translation-ch1.rejected-passage.md",
  ]) {
    assert.ok(isKnownVolumeFile(name), `${name} is legitimate output, not a stray`);
  }
  assert.ok(!isKnownVolumeFile("notes-from-a-previous-agent.md"));
}

// ─── 3. A healthy step reports nothing ────────────────────────────────────────

async function scenarioCleanRun() {
  const { dir } = await freshSeries("clean");
  const report = await runPostMortem({ step: "glossary", seriesDir: dir });

  assert.strictEqual(
    report.findings.length,
    0,
    `a finished step reported:\n${report.markdown}`
  );
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.counts.volumes, 2);
  assert.ok(report.markdown.includes("CLEAN"));
}

// ─── 3b. A staged book that is a shortcut is still the volume's book ──────────

/**
 * Intake now links each book into its volume folder instead of copying it. The
 * post-mortem asks "does this folder hold exactly what the pipeline writes?" — so
 * the shortcut must read as the volume's own source (not a stray), and a DIFFERENT
 * shortcut must still be caught as a stray. Both halves, because a check that
 * reports every staged book as a stray is a check people learn to ignore.
 */
async function scenarioLinkedSource() {
  const { dir, volumes } = await freshSeries("linked");
  for (const v of volumes) {
    const book = path.join(dir, v.folder, "book.epub");
    const original = path.join(dir, `${v.folder}.epub`);
    await fs.writeFile(original, "not really an epub", "utf8");
    await fs.rm(book);
    await fs.symlink(path.relative(path.dirname(book), original), book);
  }
  const report = await runPostMortem({ step: "glossary", seriesDir: dir });
  assert.strictEqual(
    report.findings.length,
    0,
    `a series whose books are shortcuts reported:\n${report.markdown}`
  );

  // The other half: a shortcut that is NOT the volume's source is a stray.
  await fs.symlink(path.join(dir, "glossary.md"), path.join(dir, "Test Story(01)", "old-notes.md"));
  const stray = await runPostMortem({ step: "glossary", seriesDir: dir });
  assert.ok(
    kinds(stray).has("unexpected-file"),
    `a stray shortcut in a volume folder was invisible:\n${stray.markdown}`
  );
}

// ─── 4. Every finding class fires on its real shape ───────────────────────────

/**
 * Each case plants ONE known defect in an otherwise healthy series and asserts the
 * post-mortem names it. If a case stops being detected the suite fails — which is
 * the only way to know the check is still looking.
 */
const DEFECT_CASES = [
  {
    label: "a required artifact was never written",
    async plant(dir) {
      await fs.rm(path.join(dir, "Test Story(01)", "glossary-validation.md"));
    },
    expect: "missing-required",
    severity: "HIGH",
  },
  {
    label: "a stage left its scaffolding instead of its output",
    async plant(dir) {
      await fs.writeFile(
        path.join(dir, "Test Story(01)", "glossary-validation.md"),
        "(stub \u2014 the merge pass replaces this)",
        "utf8"
      );
    },
    expect: "empty-or-stub",
    severity: "HIGH",
  },
  {
    label: "a state file was cut off mid-write",
    async plant(dir) {
      await fs.writeFile(
        path.join(dir, "Test Story(01)", "glossary-coverage.json"),
        '{"terms": [',
        "utf8"
      );
    },
    expect: "bad-json",
    severity: "HIGH",
  },
  {
    label: "a glossary was written as prose (no table)",
    async plant(dir) {
      await fs.writeFile(
        path.join(dir, "Test Story(02)", "glossary.md"),
        "# Glossary\n\nprotagonist \u2014 \u4e3b\u4eba\u516c. side character \u2014 \u4fae\u914d\u89d2.\n",
        "utf8"
      );
    },
    expect: "wrong-shape",
    severity: "MEDIUM",
  },
  {
    label: "a carry-forward gate quarantined a glossary and nobody read it",
    async plant(dir) {
      await fs.writeFile(path.join(dir, "Test Story(02)", "glossary.md.rejected"), TABLE, "utf8");
    },
    expect: "quarantine-present",
    severity: "HIGH",
  },
  {
    label: "a stale stray is sitting in the volume folder",
    async plant(dir) {
      await fs.writeFile(path.join(dir, "Test Story(01)", "glossary-amend-notes.md"), DOC, "utf8");
    },
    expect: "unexpected-file",
    severity: "LOW",
  },
  {
    label: "the volume was published on a window that never accepted it",
    async plant(dir) {
      await fs.writeFile(
        path.join(dir, "Test Story(01)", "glossary-validation-rolling-state.json"),
        JSON.stringify({ results: [41, 44] }),
        "utf8"
      );
    },
    expect: "accepted-without-acceptance",
    severity: "MEDIUM",
  },
  {
    label: "the series-root copy is missing",
    async plant(dir) {
      await fs.rm(path.join(dir, "glossary.md"));
    },
    expect: "missing-required",
    severity: "HIGH",
  },
  {
    label: "the volume folder does not exist",
    async plant(dir) {
      await fs.rm(path.join(dir, "Test Story(02)"), { recursive: true, force: true });
    },
    expect: "missing-volume-folder",
    severity: "HIGH",
  },
];

async function scenarioPlantedDefects() {
  for (const c of DEFECT_CASES) {
    const { dir } = await freshSeries("defect");
    await c.plant(dir);
    const report = await runPostMortem({ step: "glossary", seriesDir: dir });

    assert.ok(
      kinds(report).has(c.expect),
      `planted defect not detected \u2014 "${c.label}" (expected kind ${c.expect}):\n${report.markdown}`
    );
    const f = report.findings.find((x) => x.kind === c.expect);
    assert.strictEqual(f.severity, c.severity, `${c.label}: severity should be ${c.severity}, got ${f.severity}`);
    assert.ok(f.message.length > 20, `${c.label}: the finding must say something usable`);
  }

  // The volume-04 case, which is the reason this module exists: a glossary with
  // nothing beside it. It is caught by the ABSENCE of the files that always come
  // with it — no error was ever thrown for it, by anything.
  const { dir } = await freshSeries("volume04");
  const vol = path.join(dir, "Test Story(02)");
  for (const name of [
    "glossary-validation.md",
    "glossary-validation-rolling-state.json",
    "glossary-new-terms.json",
    "glossary-coverage.md",
    "glossary-coverage.json",
    "glossary-research.md",
  ]) {
    await fs.rm(path.join(vol, name));
  }
  const report = await runPostMortem({ step: "glossary", seriesDir: dir });
  assert.strictEqual(report.ok, false, "a volume with a glossary and nothing else must not pass");
  const high = report.findings.filter((f) => f.severity === "HIGH");
  assert.ok(high.length >= 2, `expected several HIGH findings, got ${high.length}`);
  assert.ok(
    report.findings.every((f) => !f.volume || f.file.startsWith("Test Story(02)/")),
    "every volume-level finding must name its own volume"
  );
}

// ─── 5. Translation-stage coverage checks ─────────────────────────────────────

async function scenarioChapterCoverage() {
  const { dir } = await freshSeries("translate");
  const vol = path.join(dir, "Test Story(01)");

  // A volume the translation stage finished.
  await fs.writeFile(
    path.join(vol, "chapters.json"),
    JSON.stringify([
      { id: "ch1", file: "book-ch1.md", title: "Chapter 1", bodyChars: 9000, empty: false },
      { id: "ch2", file: "book-ch2.md", title: "Chapter 2", bodyChars: 7000, empty: false },
      { id: "ch3", file: "book-ch3.md", title: null, bodyChars: 0, empty: true },
    ]),
    "utf8"
  );
  await fs.writeFile(path.join(vol, "translation-ch1.md"), DOC, "utf8");
  await fs.writeFile(path.join(vol, "translation-ch2.md"), DOC, "utf8");
  await fs.writeFile(path.join(vol, "translation.md"), DOC, "utf8");
  await fs.writeFile(path.join(vol, "translation-qa.md"), DOC, "utf8");
  await fs.writeFile(
    path.join(vol, "translation-state.json"),
    JSON.stringify({ ch1: { draftHash: "a" }, ch2: { draftHash: "b" } }),
    "utf8"
  );
  // The second volume has its state file but never got a merged book — the
  // partially-failed run every skip policy can leave behind.
  const vol2 = path.join(dir, "Test Story(02)");
  await fs.writeFile(path.join(vol2, "translation-state.json"), "{}", "utf8");

  const report = await runPostMortem({ step: "translate", seriesDir: dir });
  assert.ok(!kinds(report).has("chapter-without-draft"), "a translated volume must not be flagged");
  assert.ok(
    report.findings.some(
      (f) => f.kind === "missing-required" && f.volume === "02" && f.file.includes("translation.md")
    ),
    `a volume with no merged book must be reported:\n${report.markdown}`
  );
  assert.strictEqual(report.ok, false);

  // Finish volume 02's required output: the step now reads as finished.
  await fs.writeFile(path.join(vol2, "translation.md"), DOC, "utf8");
  await fs.writeFile(path.join(vol2, "translation-qa.md"), DOC, "utf8");
  const finished = await runPostMortem({ step: "translate", seriesDir: dir });
  assert.strictEqual(finished.ok, true, `a finished translate step must read clean:\n${finished.markdown}`);

  // Drop one draft and its state entry: a chapter the book has and the run skipped.
  await fs.rm(path.join(vol, "translation-ch2.md"));
  await fs.writeFile(
    path.join(vol, "translation-state.json"),
    JSON.stringify({ ch1: { draftHash: "a" } }),
    "utf8"
  );
  const after = await runPostMortem({ step: "translate", seriesDir: dir });
  const missing = after.findings.filter((f) => f.kind === "chapter-without-draft");
  assert.strictEqual(missing.length, 1, `expected exactly one missing chapter:\n${after.markdown}`);
  assert.ok(missing[0].file.includes("translation-ch2.md"));
  // ch3 is empty IN THE SOURCE — a hole in the book, not a failure of the run.
  assert.ok(!after.findings.some((f) => f.file.includes("translation-ch3.md")));

  // A draft kept as a repair target (qaFailed) is not a hole (gotcha 39).
  await fs.writeFile(
    path.join(vol, "translation-state.json"),
    JSON.stringify({ ch1: { draftHash: "a" }, ch2: { qaFailed: true, qaFindings: "residue" } }),
    "utf8"
  );
  const repaired = await runPostMortem({ step: "translate", seriesDir: dir });
  assert.ok(!kinds(repaired).has("chapter-without-draft"), "a quarantined draft is a repair target, not a hole");

  // The quarantined draft itself is evidence a later stage may have repaired —
  // reported, but not as a failure, and not as a stray.
  await fs.writeFile(path.join(vol, "translation-ch2.rejected.md"), DOC, "utf8");
  const quarantined = await runPostMortem({ step: "translate", seriesDir: dir });
  const q = quarantined.findings.filter((f) => f.kind === "quarantine-present");
  assert.strictEqual(q.length, 1, `expected one quarantine finding:\n${quarantined.markdown}`);
  assert.strictEqual(q[0].severity, "MEDIUM");
  assert.ok(!kinds(quarantined).has("unexpected-file"), "kept evidence is not a stray");
}

// ─── 6. The consistency audit's own verdict ───────────────────────────────────

async function scenarioAuditVerdict() {
  const { dir } = await freshSeries("audit");
  const reportFile = path.join(dir, "consistency-report.md");
  await fs.writeFile(
    reportFile,
    "# Consistency Audit\n\n**FAIL**\n\n## HIGH\n\n- glossary and wiki disagree\n",
    "utf8"
  );
  await fs.writeFile(path.join(dir, "consistency-report.md.provenance.json"), "{}", "utf8");

  assert.strictEqual(await readConsistencyVerdict(reportFile), "FAIL");

  const failed = await runPostMortem({ step: "consistency-audit", seriesDir: dir });
  assert.strictEqual(failed.ok, false, "a FAIL sign-off must not read as a clean step");
  assert.ok(kinds(failed).has("audit-verdict-fail"));

  await fs.writeFile(reportFile, "# Consistency Audit\n\n**PASS**\n", "utf8");
  const passed = await runPostMortem({ step: "consistency-audit", seriesDir: dir });
  assert.strictEqual(passed.ok, true, `a PASS sign-off must be clean:\n${passed.markdown}`);

  await fs.writeFile(reportFile, "# Consistency Audit\n\nno verdict here\n", "utf8");
  const noVerdict = await runPostMortem({ step: "consistency-audit", seriesDir: dir });
  assert.ok(kinds(noVerdict).has("audit-verdict-missing"), "a report with no verdict cannot be read downstream");
}

// ─── 7. An assessment that could not run is never clean ───────────────────────

async function scenarioUnassessable() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "postmortem-noplan-"));
  const noPlan = await runPostMortem({ step: "glossary", seriesDir: dir });
  assert.ok(noPlan.error, "no plan of record must be reported as an error");
  assert.strictEqual(noPlan.ok, false, "an assessment that could not run is not a clean assessment");
  assert.ok(noPlan.markdown.includes("could not run"));

  // A step nobody declared is a finding, not a silent pass.
  const { dir: good } = await freshSeries("undeclared");
  const undeclared = await runPostMortem({ step: "some-new-step", seriesDir: good });
  assert.strictEqual(undeclared.ok, false);
  assert.ok(kinds(undeclared).has("step-undeclared"));
  assert.strictEqual(undeclared.findings[0].severity, "HIGH");

  // A half-written plan of record is the same class of failure (gotcha 33).
  await fs.writeFile(path.join(good, "translation-target.json"), '{"volumes": [', "utf8");
  const corrupt = await runPostMortem({ step: "glossary", seriesDir: good });
  assert.strictEqual(corrupt.ok, false);
  assert.ok(corrupt.error);
}

// ─── 8. --volume scoping ──────────────────────────────────────────────────────

async function scenarioVolumeScoping() {
  const { dir } = await freshSeries("volume");
  // A single-volume run deliberately does not publish the series-root copies (a
  // lone volume's snapshot would misrepresent the series), so it must not be
  // blamed for them.
  await fs.rm(path.join(dir, "glossary.md"));
  await fs.rm(path.join(dir, "glossary.md.provenance.json"));

  const single = await runPostMortem({ step: "glossary", seriesDir: dir, volumeArg: "01" });
  assert.strictEqual(single.ok, true, `a --volume run must not be blamed for the root copies:\n${single.markdown}`);
  assert.strictEqual(single.counts.volumes, 1);

  // The same series, run whole, IS blamed.
  const whole = await runPostMortem({ step: "glossary", seriesDir: dir });
  assert.strictEqual(whole.ok, false);
  assert.ok(kinds(whole).has("missing-required"));

  // A folder name is a valid --volume value (agent-chosen names need no "(NN)").
  const byName = await runPostMortem({ step: "glossary", seriesDir: dir, volumeArg: "Test Story(02)" });
  assert.strictEqual(byName.counts.volumes, 1);
}

// ─── 9. index.js wiring, with no model call ───────────────────────────────────

async function scenarioIndexWiring() {
  const root = path.resolve(__dirname, "..");

  const listed = spawnSync(process.execPath, [path.join(root, "index.js"), "--list"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.strictEqual(listed.status, 0, `index.js --list failed: ${listed.stderr}`);
  for (const step of GULPFILE.PIPELINE_STEPS) {
    assert.ok(listed.stdout.includes(step.name), `index.js --list omits ${step.name}`);
  }

  const bogus = spawnSync(process.execPath, [path.join(root, "index.js"), "--stages=not-a-step"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.strictEqual(bogus.status, 1, "an unknown step must fail loudly, not silently run nothing");
  assert.ok(bogus.stderr.includes("not a pipeline step"), bogus.stderr);
}

// ─── 10. The report is readable ───────────────────────────────────────────────

async function scenarioRendering() {
  const { dir } = await freshSeries("render");
  await fs.rm(path.join(dir, "Test Story(01)", "glossary.md"));
  const report = await runPostMortem({ step: "glossary", seriesDir: dir });
  const md = renderPostMortemMarkdown(report);
  assert.ok(md.includes("## HIGH"), "findings must be grouped by severity");
  assert.ok(md.includes("volume 01"), "a finding must name its volume");
  assert.ok(md.includes("glossary.md"), "a finding must name the file");
}

// ─── 11. The run's machine state has one home ─────────────────────────────────

/**
 * The post-mortem folder is where a run remembers itself: the step reports, the anti-spin
 * ledger, the tickets, the run lock. All four paths come out of postMortemDir(), so a wrong
 * default moves the whole memory of a run into a different folder — and every suite that
 * passes POSTMORTEM_DIR explicitly is unable to notice.
 *
 * That happened for real. utils/postmortem.js split into utils/postmortem/, the one function
 * that built the path kept its `path.resolve(__dirname, "..")`, and ".." from inside the
 * folder is utils/ — so tickets written at the repo root became invisible to
 * `node diagnose.js --open`, which reported "nothing is waiting" about a ticket that was
 * sitting there open. The default is pinned here so the next split cannot repeat it.
 */
function scenarioMachineStateHome() {
  const root = path.resolve(__dirname, "..");
  const saved = process.env.POSTMORTEM_DIR;
  delete process.env.POSTMORTEM_DIR;
  try {
    const dir = postMortemDir();
    assert.strictEqual(
      dir,
      path.join(root, ".postmortem"),
      `postMortemDir() resolves to ${dir}, not the repo's own .postmortem`
    );
    // The exact shape of the bug: a split module's __dirname is the folder, so a
    // machine-state path that lands inside utils/ means the alias is one level short.
    assert.ok(
      !dir.startsWith(path.join(root, "utils") + path.sep),
      `machine state moved inside utils/ — a split module resolved the repo root from its own folder: ${dir}`
    );

    const { ticketPaths } = require("../utils/tickets");
    const { ledgerPath } = require("../utils/ledger");
    const { runLockPath } = require("../utils/runlock");
    for (const [name, file] of [
      ["tickets", ticketPaths().json],
      ["ledger", ledgerPath()],
      ["run lock", runLockPath()],
    ]) {
      assert.strictEqual(
        path.dirname(file),
        dir,
        `${name} must live in the post-mortem folder, and it resolves to ${file}`
      );
    }

    // The token calibration is machine state too, and it moved for the same reason.
    const { calibrationFile } = require("../utils/tokens");
    const savedCalibration = process.env.TOKEN_CALIBRATION_FILE;
    delete process.env.TOKEN_CALIBRATION_FILE;
    try {
      assert.strictEqual(
        calibrationFile(),
        path.join(root, ".token-calibration.json"),
        `calibrationFile() resolves to ${calibrationFile()}, not the repo's own cache file`
      );
    } finally {
      if (savedCalibration === undefined) delete process.env.TOKEN_CALIBRATION_FILE;
      else process.env.TOKEN_CALIBRATION_FILE = savedCalibration;
    }

    // An explicit POSTMORTEM_DIR still wins: two series at once each need their own history.
    process.env.POSTMORTEM_DIR = path.join(root, ".postmortem-other");
    assert.strictEqual(
      postMortemDir(),
      path.join(root, ".postmortem-other"),
      "POSTMORTEM_DIR must override the default"
    );
  } finally {
    if (saved === undefined) delete process.env.POSTMORTEM_DIR;
    else process.env.POSTMORTEM_DIR = saved;
  }
}

// ─── run ──────────────────────────────────────────────────────────────────────

(async function main() {
  await scenarioStepListsAgree();
  console.log(`postmortem: step lists agree (${GULPFILE.PIPELINE_STEPS.length} steps, ${declaredSteps().length} specs)`);

  await scenarioShapeRules();
  console.log("postmortem: shape rules and file vocabulary ok");

  await scenarioCleanRun();
  console.log("postmortem: a finished step reports nothing (the false-positive half)");

  await scenarioLinkedSource();
  console.log("postmortem: a linked book is the volume's source, a stray shortcut is still a stray");

  await scenarioPlantedDefects();
  console.log(`postmortem: ${DEFECT_CASES.length + 1} planted defects all detected`);

  await scenarioChapterCoverage();
  console.log("postmortem: a hole in the book and a hole in the run are told apart");

  await scenarioAuditVerdict();
  console.log("postmortem: the audit's own verdict reaches the finding list");

  await scenarioUnassessable();
  console.log("postmortem: an assessment that cannot run never reads as clean");

  await scenarioVolumeScoping();
  console.log("postmortem: --volume scoping matches what the tasks actually do");

  await scenarioIndexWiring();
  console.log("postmortem: index.js reads the step list from gulpfile and rejects an unknown step");

  await scenarioRendering();
  console.log("postmortem: report rendering names severity, volume and file");

  scenarioMachineStateHome();
  console.log("postmortem: the run's machine state resolves to the repo's own .postmortem");

  console.log("postmortem: all checks passed.");
})();

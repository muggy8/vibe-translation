/**
 * test-delivery-audit.js — the after-run check for the delivery layer itself.
 *
 * Why this suite exists and why it plants its own defects. The pipeline's steps are assessed after
 * they run: utils/postmortem.js asks what a step left behind, the finding reaches the ledger, and the
 * next run knows whether re-running is worth paying for. The delivery layer — `npm run delivery`,
 * `npm run diagnose`, `npm run fix`, `npm run autopilot` — had no such question, and it is the layer
 * that decides whether a failed run gets repaired, escalated, or left alone. A green suite over a
 * supervisor nobody checks is the exact blind spot this repository keeps being told about.
 *
 * So, as test-postmortem.js does: seed a healthy run, assert the audit reports NOTHING, then plant
 * one known defect per finding class and assert each one is named. A check that can never fail is not
 * a check, and a check that fires on healthy output is a check people learn to ignore.
 *
 * What is pinned here:
 *   1. The four delivery commands are declared in utils/artifacts.js, and the declaration cannot
 *      drift from the commands `package.json` actually exposes. A command nobody declared is the gap
 *      this change exists to close.
 *   2. The nine pipeline steps declare no run scope, so the corpus half of the post-mortem is
 *      untouched by this change.
 *   3. A delivery command that wrote what it says it wrote reports nothing — including the paths that
 *      legitimately write nothing (`--no-write`, `--open`, `--status`).
 *   4. Every cross-record defect fires: a channel that does not parse, a patch answering a ticket that
 *      does not exist, a ticket marked answered with no diagnosis, a closed ticket with no measured
 *      outcome, a menu with no options, a duplicate id, a plan naming a step nothing declares, a plan
 *      claiming an act pass it never described, a lock left by a process that is gone.
 *   5. An exit code is a claim, and a claim the records do not back is HIGH: `diagnose` exiting 0
 *      without a diagnosis on the ticket, `fix --commit` leaving a patch `proposed`, `delivery
 *      --accept-patch` leaving the patch unjudged.
 *   6. A live run lock is NOT a finding. Reporting the lock working as a defect is how a check gets
 *      switched off.
 *   7. The audit records what it found into the ledger (which is how a delivery finding reaches the
 *      next run's triage), writes its report beside the other post-mortems, never throws, and never
 *      changes the command's exit code.
 *   8. A channel written through the real doors — createTicket, recordDiagnosis, closeTicket — reports
 *      nothing. That is the half that proves the invariants match what the writers actually produce.
 *
 * No network, no endpoint, no model call, and nothing near the corpus: every scenario points
 * `POSTMORTEM_DIR` at its own throwaway folder (gotcha 69). Run with `npm test`, or standalone:
 * `node test/test-delivery-audit.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

const { DELIVERY_COMMANDS, STEP_ARTIFACT_SPECS, specForStep } = require("../utils/artifacts");
const { postMortemDir, renderPostMortemMarkdown, finding } = require("../utils/postmortem");
const { createTicket, recordDiagnosis, closeTicket, ticketPaths, writeTickets } = require("../utils/tickets");
const { auditDeliveryRun, claimsFromInvocation, displayPath } = require("../utils/delivery-audit");

const savedPostMortemDir = process.env.POSTMORTEM_DIR;
const savedLedger = process.env.LEDGER_ENABLED;

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** A headed Markdown document, the shape every renderer in this layer produces. */
const DOC = `# Delivery plan\n\n## Verdict\n\n- resume glossary from volume 02\n`;

/**
 * A throwaway run folder, with the machine state pointed at it.
 *
 * Every scenario gets its own: the ledger, the ticket channel and the patch channel all resolve their
 * home through `postMortemDir()`, so one shared folder would let one scenario's records leak into the
 * next one's assertions — and both of them would be reading the repository's own history.
 *
 * @param {string} label
 * @returns {Promise<string>} Absolute path to the run folder.
 */
async function runFolder(label) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `delivery-audit-${label}-`));
  process.env.POSTMORTEM_DIR = dir;
  process.env.LEDGER_ENABLED = "true";
  return dir;
}

/**
 * Write a plan of record that is what the delivery command writes.
 * @param {string} dir
 * @param {Object} [over] - Fields to override.
 */
async function writePlan(dir, over = {}) {
  const plan = { mode: "report", run: "run-1", steps: [{ step: "glossary" }], execution: [], ...over };
  await fsp.writeFile(path.join(dir, "delivery-plan.md"), DOC, "utf8");
  await fsp.writeFile(path.join(dir, "delivery-plan.json"), JSON.stringify(plan, null, 2) + "\n", "utf8");
  return plan;
}

/**
 * Write the ticket channel directly. Used for the planted defects, where the point is a record the
 * doors would never have written.
 * @param {string} dir
 * @param {Object[]} tickets
 */
async function writeTicketsRaw(dir, tickets) {
  await fsp.writeFile(
    path.join(dir, "tickets.json"),
    JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), tickets }, null, 2) + "\n",
    "utf8"
  );
}

/**
 * Write the patch channel directly.
 * @param {string} dir
 * @param {Object[]} patches
 */
async function writePatchesRaw(dir, patches) {
  await fsp.writeFile(
    path.join(dir, "patches.json"),
    JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), patches }, null, 2) + "\n",
    "utf8"
  );
}

/**
 * A ticket in the shape the real doors write.
 * @param {Object} [over]
 * @returns {Object}
 */
function ticketRecord(over = {}) {
  return {
    id: "TCK-run-1-1",
    run: "run-1",
    at: new Date().toISOString(),
    step: "glossary",
    volume: "02",
    finding: "missing-required",
    evidence: [{ file: "Test Story(02)/glossary.md", note: "absent from the volume folder" }],
    tried: [],
    ruledOut: [],
    question: "Why is volume 02's glossary missing when volume 01 built one?",
    status: "open",
    ...over,
  };
}

/**
 * A patch in the shape the real doors write.
 * @param {Object} [over]
 * @returns {Object}
 */
function patchRecord(over = {}) {
  return {
    id: "PATCH-1",
    ticketId: "TCK-run-1-1",
    optionId: "TCK-run-1-1/O1",
    step: "glossary",
    volume: "02",
    finding: "missing-required",
    status: "proposed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: ["glossary/extract.js"],
    summary: "widen the term match",
    ...over,
  };
}

/**
 * A pid that is certainly not a live process on this machine: a child that has already exited.
 * @returns {number}
 */
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return child.pid;
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
 * The one finding of a kind, for asserting its severity.
 * @param {import("../utils/postmortem").PostMortemReport} report
 * @param {string} kind
 * @returns {Object|null}
 */
function findingOf(report, kind) {
  return report.findings.find((f) => f.kind === kind) || null;
}

// ─── 1. The commands are declared, and cannot drift ───────────────────────────

async function scenarioCommandsAreDeclared() {
  for (const name of DELIVERY_COMMANDS) {
    const spec = specForStep(name);
    assert.ok(spec, `delivery command "${name}" has no entry in utils/artifacts.js`);
    assert.strictEqual(spec.perVolume, false, `${name} writes no per-volume artifact`);
    assert.ok(Array.isArray(spec.run), `${name} must declare its run-folder expectations (possibly empty)`);
  }

  // The drift this pins: the declared names are the commands package.json exposes. A command added to
  // package.json without a spec is a command nothing checks; a spec for a command that no longer
  // exists is a check nobody runs.
  const scripts = require("../package.json").scripts;
  const exposed = Object.entries(scripts)
    .filter(([, cmd]) => DELIVERY_COMMANDS.some((name) => cmd === `node ${name}.js`))
    .map(([name]) => name);
  for (const name of exposed) {
    assert.ok(DELIVERY_COMMANDS.includes(name), `npm run ${name} exists but is not audited`);
    assert.ok(fs.existsSync(path.join(ROOT, `${name}.js`)), `npm run ${name} names no entry point`);
  }
  for (const name of DELIVERY_COMMANDS) {
    assert.ok(exposed.includes(name), `${name} is declared as a delivery command but no npm script runs it`);
  }

  // The corpus half is untouched: not one pipeline step declares a run scope, so the nine steps are
  // assessed exactly as they were before this change.
  const pipeline = Object.keys(STEP_ARTIFACT_SPECS).filter((n) => !DELIVERY_COMMANDS.includes(n));
  assert.strictEqual(pipeline.length, 12, "the twelve pipeline steps are still the corpus half");
  for (const name of pipeline) {
    assert.strictEqual(STEP_ARTIFACT_SPECS[name].run, undefined, `${name} must not declare a run scope`);
  }
}

// ─── 2. A command that wrote what it says it wrote reports nothing ────────────

async function scenarioCleanRun() {
  const dir = await runFolder("clean");
  await writePlan(dir);

  const r = await auditDeliveryRun({ step: "delivery", argv: ["--mode=report"], exitCode: 0, quiet: true });
  assert.strictEqual(r.error, null, r.error);
  assert.strictEqual(
    r.report.findings.length,
    0,
    `a delivery run that wrote its plan reported:\n${r.report.markdown}`
  );
  assert.strictEqual(r.report.ok, true);
  assert.strictEqual(r.report.counts.checked, 2, "both declared records were looked for");

  // The false-positive half, and the more important half: the paths that legitimately write nothing
  // must not be blamed for it. `--no-write` is a rehearsal; `--open` reads the channel.
  const rehearsal = await auditDeliveryRun({ step: "delivery", argv: ["--mode=report", "--no-write"], exitCode: 0, quiet: true });
  assert.strictEqual(rehearsal.report.findings.length, 0, rehearsal.report.markdown);
  assert.strictEqual(rehearsal.report.counts.checked, 0, "a rehearsal claims nothing");

  const list = await auditDeliveryRun({ step: "diagnose", argv: ["--open"], exitCode: 0, quiet: true });
  assert.strictEqual(list.report.findings.length, 0, list.report.markdown);

  const status = await auditDeliveryRun({ step: "fix", argv: ["--status"], exitCode: 0, quiet: true });
  assert.strictEqual(status.report.findings.length, 0, status.report.markdown);
}

// ─── 3. Every cross-record defect fires ───────────────────────────────────────

/**
 * Each case plants ONE defect in an otherwise clean run folder and asserts the audit names it. If a
 * case stops being detected the suite fails — the only way to know the check is still looking.
 */
const DEFECT_CASES = [
  {
    label: "the ticket channel does not parse",
    async plant(dir) {
      await fsp.writeFile(path.join(dir, "tickets.json"), '{"tickets": [', "utf8");
    },
    expect: "record-unreadable",
    severity: "HIGH",
  },
  {
    label: "the patch channel does not parse",
    async plant(dir) {
      await fsp.writeFile(path.join(dir, "patches.json"), '{"patches": [', "utf8");
    },
    expect: "record-unreadable",
    severity: "HIGH",
  },
  {
    label: "the ledger does not parse — the anti-spin gate is now blind",
    async plant(dir) {
      await fsp.writeFile(path.join(dir, "ledger.json"), '{"entries": [', "utf8");
    },
    expect: "record-unreadable",
    severity: "HIGH",
  },
  {
    label: "a ticket file with no `tickets` array",
    async plant(dir) {
      await fsp.writeFile(path.join(dir, "tickets.json"), '{"ticketz": []}', "utf8");
    },
    expect: "record-unreadable",
    severity: "HIGH",
  },
  {
    label: "a patch answers a ticket that is not in the ticket file",
    async plant(dir) {
      await writeTicketsRaw(dir, [ticketRecord()]);
      await writePatchesRaw(dir, [patchRecord({ ticketId: "TCK-that-never-existed" })]);
    },
    expect: "record-orphan",
    severity: "MEDIUM",
  },
  {
    label: "a ticket is marked answered with no diagnosis behind it",
    async plant(dir) {
      await writeTicketsRaw(dir, [ticketRecord({ status: "answered", options: [{ id: "O1", label: "x" }] })]);
    },
    expect: "answer-without-diagnosis",
    severity: "MEDIUM",
  },
  {
    label: "a ticket is answered, offers no options, and does not say so",
    async plant(dir) {
      await writeTicketsRaw(dir, [
        ticketRecord({ status: "answered", diagnosis: { cause: "the extractor dropped the row" }, options: [] }),
      ]);
    },
    expect: "menu-without-options",
    severity: "MEDIUM",
  },
  {
    label: "a ticket is closed with no measured outcome",
    async plant(dir) {
      await writeTicketsRaw(dir, [ticketRecord({ status: "closed" })]);
    },
    expect: "closed-without-outcome",
    severity: "HIGH",
  },
  {
    label: "a ticket holds a status this layer never writes",
    async plant(dir) {
      await writeTicketsRaw(dir, [ticketRecord({ status: "resolved" })]);
    },
    expect: "record-shape",
    severity: "HIGH",
  },
  {
    label: "a ticket cites no evidence",
    async plant(dir) {
      await writeTicketsRaw(dir, [ticketRecord({ evidence: [] })]);
    },
    expect: "record-shape",
    severity: "MEDIUM",
  },
  {
    label: "the same ticket id appears twice",
    async plant(dir) {
      await writeTicketsRaw(dir, [ticketRecord(), ticketRecord()]);
    },
    expect: "duplicate-record-id",
    severity: "MEDIUM",
  },
  {
    label: "a patch holds a status this layer never writes",
    async plant(dir) {
      await writeTicketsRaw(dir, [ticketRecord()]);
      await writePatchesRaw(dir, [patchRecord({ status: "shipped" })]);
    },
    expect: "record-shape",
    severity: "HIGH",
  },
  {
    label: "a patch declares no files",
    async plant(dir) {
      await writeTicketsRaw(dir, [ticketRecord()]);
      await writePatchesRaw(dir, [patchRecord({ files: [] })]);
    },
    expect: "record-shape",
    severity: "MEDIUM",
  },
  {
    label: "code sits in the working tree with nobody having judged it",
    async plant(dir) {
      await writeTicketsRaw(dir, [ticketRecord()]);
      await writePatchesRaw(dir, [patchRecord({ status: "proposed" })]);
    },
    expect: "patch-unjudged",
    severity: "MEDIUM",
  },
  {
    label: "the plan of record names a step nothing declares an output for",
    async plant(dir) {
      await writePlan(dir, { steps: [{ step: "glossary" }, { step: "step-nobody-declared" }] });
    },
    expect: "record-orphan",
    severity: "MEDIUM",
  },
  {
    label: "the plan claims an act pass and carries no execution list",
    async plant(dir) {
      await writePlan(dir, { mode: "act", execution: undefined });
    },
    expect: "record-incomplete",
    severity: "MEDIUM",
  },
  {
    label: "the plan of record has no mode",
    async plant(dir) {
      await writePlan(dir, { mode: undefined });
    },
    expect: "record-shape",
    severity: "MEDIUM",
  },
  {
    label: "a run lock is left behind by a process that is gone",
    async plant(dir) {
      await fsp.writeFile(
        path.join(dir, "run.lock"),
        JSON.stringify({ runId: "a-run-that-died", pid: deadPid(), host: "here", by: "delivery.js act", startedAt: "2026-01-01T00:00:00.000Z" }),
        "utf8"
      );
    },
    expect: "run-lock-stale",
    severity: "HIGH",
  },
  {
    label: "a run lock whose holder is alive but has stopped making progress",
    async plant(dir) {
      await fsp.writeFile(
        path.join(dir, "run.lock"),
        JSON.stringify({
          runId: "a-run-that-wedged",
          pid: process.pid,
          host: "here",
          by: "gulp glossary",
          startedAt: "2026-01-01T00:00:00.000Z",
          heartbeatAt: new Date(Date.now() - 3 * 3600000).toISOString(),
          beats: 88,
        }),
        "utf8"
      );
    },
    expect: "run-lock-stalled",
    severity: "MEDIUM",
  },
  {
    label: "the run lock does not parse",
    async plant(dir) {
      await fsp.writeFile(path.join(dir, "run.lock"), '{"runId": ', "utf8");
    },
    expect: "record-unreadable",
    severity: "HIGH",
  },
  {
    label: "the run lock names a pid this machine cannot check",
    async plant(dir) {
      await fsp.writeFile(
        path.join(dir, "run.lock"),
        JSON.stringify({ runId: "written-on-another-machine", pid: -1, host: "elsewhere", by: "gulp glossary", startedAt: "2026-01-01T00:00:00.000Z" }),
        "utf8"
      );
    },
    expect: "run-lock-unverifiable",
    severity: "MEDIUM",
  },
  {
    label: "the plan of record is a scaffold stub",
    async plant(dir) {
      await fsp.writeFile(path.join(dir, "delivery-plan.md"), "(stub — the merge pass replaces this)", "utf8");
      await fsp.writeFile(path.join(dir, "delivery-plan.json"), "{}", "utf8");
    },
    expect: "empty-or-stub",
    severity: "HIGH",
  },
  {
    label: "the plan of record is half-written JSON",
    async plant(dir) {
      await fsp.writeFile(path.join(dir, "delivery-plan.md"), DOC, "utf8");
      await fsp.writeFile(path.join(dir, "delivery-plan.json"), '{"steps": [', "utf8");
    },
    expect: "bad-json",
    severity: "HIGH",
  },
];

async function scenarioPlantedDefects() {
  for (const c of DEFECT_CASES) {
    const dir = await runFolder("defect");
    await writePlan(dir);
    await c.plant(dir);
    const r = await auditDeliveryRun({ step: "delivery", argv: ["--mode=report"], exitCode: 0, quiet: true });

    const f = findingOf(r.report, c.expect);
    assert.ok(f, `planted defect not detected — "${c.label}" (expected kind ${c.expect}):\n${r.report.markdown}`);
    assert.strictEqual(f.severity, c.severity, `${c.label}: severity should be ${c.severity}, got ${f.severity}`);
    assert.ok(f.message.length > 30, `${c.label}: the finding must say something a reader can act on`);
    assert.strictEqual(
      r.report.ok,
      c.severity !== "HIGH",
      `${c.label}: a HIGH finding must not read as a clean run, and a MEDIUM one must not read as a failure`
    );
  }
}

// ─── 4. An exit code is a claim, and the records have to back it ──────────────

/**
 * The claims half. Every one of these is a command that exited 0 — the command saying it did the
 * thing — against a channel that does not show it. This is the delivery layer's version of "never let
 * a stage persist empty output": the stage finished, and the output it finished with is not there.
 */
const CLAIM_CASES = [
  {
    label: "diagnose exited 0 and the ticket holds no diagnosis",
    step: "diagnose",
    argv: ["--ticket=TCK-run-1-1"],
    async seed(dir) {
      await writeTicketsRaw(dir, [ticketRecord({ status: "open" })]);
    },
    expect: "claim-unsupported",
  },
  {
    label: "diagnose exited 0 and the ticket is not in the file at all",
    step: "diagnose",
    argv: ["--ticket=TCK-run-1-1"],
    async seed(dir) {
      await writeTicketsRaw(dir, []);
    },
    expect: "claim-unsupported",
  },
  {
    label: "diagnose exited 0 and the diagnosis states no cause",
    step: "diagnose",
    argv: ["--ticket=TCK-run-1-1"],
    async seed(dir) {
      await writeTicketsRaw(dir, [ticketRecord({ status: "answered", diagnosis: { cause: "  " }, options: [{ id: "O1" }] })]);
    },
    expect: "claim-unsupported",
  },
  {
    label: "fix exited 0 and no patch names the ticket it was called for",
    step: "fix",
    argv: ["--ticket=TCK-run-1-1"],
    async seed(dir) {
      await writeTicketsRaw(dir, [ticketRecord()]);
      await writePatchesRaw(dir, [patchRecord({ ticketId: "TCK-some-other-ticket" })]);
    },
    expect: "claim-unsupported",
  },
  {
    label: "fix --commit exited 0 and the patch is still proposed",
    step: "fix",
    argv: ["--commit=PATCH-1"],
    async seed(dir) {
      await writeTicketsRaw(dir, [ticketRecord()]);
      await writePatchesRaw(dir, [patchRecord({ status: "proposed" })]);
    },
    expect: "claim-unsupported",
  },
  {
    label: "delivery --accept-patch exited 0 and the patch was never judged",
    step: "delivery",
    argv: ["--mode=act", "--accept-patch=PATCH-1", "--reason=it widens the match"],
    async seed(dir) {
      await writeTicketsRaw(dir, [ticketRecord()]);
      await writePatchesRaw(dir, [patchRecord({ status: "proposed" })]);
    },
    expect: "claim-unsupported",
  },
  {
    label: "delivery --choose exited 0 and the ticket records a different option",
    step: "delivery",
    argv: ["--choose=O2", "--ticket=TCK-run-1-1", "--reason=it is the cheap one"],
    async seed(dir) {
      await writeTicketsRaw(dir, [ticketRecord({ choice: { optionId: "O1", reason: "…" } })]);
    },
    expect: "claim-unsupported",
  },
  {
    label: "diagnose exited non-zero, so it claims nothing and is not blamed twice",
    step: "diagnose",
    argv: ["--ticket=TCK-run-1-1"],
    exitCode: 1,
    async seed(dir) {
      await writeTicketsRaw(dir, [ticketRecord({ status: "open" })]);
    },
    expect: null,
  },
];

async function scenarioClaimsAreChecked() {
  for (const c of CLAIM_CASES) {
    const dir = await runFolder("claim");
    await writePlan(dir);
    await c.seed(dir);
    const r = await auditDeliveryRun({
      step: c.step,
      argv: c.argv,
      exitCode: c.exitCode === undefined ? 0 : c.exitCode,
      quiet: true,
    });

    if (c.expect === null) {
      assert.ok(
        !kinds(r.report).has("claim-unsupported"),
        `a command that did not claim success must not be blamed for the missing record it never promised:\n${r.report.markdown}`
      );
      continue;
    }
    const f = findingOf(r.report, c.expect);
    assert.ok(f, `claim not checked — "${c.label}":\n${r.report.markdown}`);
    assert.strictEqual(f.severity, "HIGH", `${c.label}: a claim the records do not back is HIGH`);
    assert.ok(/exited 0/.test(f.message), `${c.label}: the finding must name the claim it is checking`);
  }
}

// ─── 4b. The claims a command makes, read off its own invocation ──────────────

async function scenarioClaimsReadOffTheCommandLine() {
  // The mode falls back to the operator's setting when no flag names it, so the setting has to be
  // under the test's control: the account owner's .env says AUTOPILOT_MODE=act, and a test that
  // inherits it is asserting about their machine rather than about this code.
  const savedAutopilot = process.env.AUTOPILOT_MODE;
  const savedDelivery = process.env.DELIVERY_MODE;
  delete process.env.AUTOPILOT_MODE;
  delete process.env.DELIVERY_MODE;
  try {
    // A rehearsal claims no plan; a normal run claims the plan; a verb claims its own record and no plan.
    assert.strictEqual(claimsFromInvocation({ step: "delivery", argv: ["--no-write"], exitCode: 0 }).claims.planRecordClaimed, false);
    assert.strictEqual(claimsFromInvocation({ step: "delivery", argv: [], exitCode: 0 }).claims.planRecordClaimed, true);
    assert.strictEqual(claimsFromInvocation({ step: "delivery", argv: ["--open-ticket"], exitCode: 0 }).claims.planRecordClaimed, false);
    assert.strictEqual(claimsFromInvocation({ step: "delivery", argv: [], exitCode: 2 }).claims.planRecordClaimed, false, "a refusal claims nothing");
    assert.strictEqual(claimsFromInvocation({ step: "delivery", argv: ["--mode=act"], exitCode: 0 }).claims.acting, true);
    assert.strictEqual(claimsFromInvocation({ step: "autopilot", argv: ["--mode=act"], exitCode: 0 }).claims.acting, true);
    assert.strictEqual(claimsFromInvocation({ step: "autopilot", argv: [], exitCode: 0 }).claims.acting, false, "watch is the default, and it touches nothing");

    // The operator's setting is the mode when no flag names it — the same rule the commands use.
    process.env.AUTOPILOT_MODE = "act";
    assert.strictEqual(claimsFromInvocation({ step: "autopilot", argv: [], exitCode: 0 }).claims.acting, true);
    process.env.DELIVERY_MODE = "act";
    assert.strictEqual(claimsFromInvocation({ step: "delivery", argv: [], exitCode: 0 }).claims.acting, true);
    delete process.env.AUTOPILOT_MODE;
    delete process.env.DELIVERY_MODE;

    // Reading the channel claims nothing. This is the difference between an audit and a noise machine.
    assert.strictEqual(claimsFromInvocation({ step: "diagnose", argv: ["--open"], exitCode: 0 }).claims.ticketRecordClaimed, false);
    assert.strictEqual(claimsFromInvocation({ step: "diagnose", argv: ["--ticket=TCK-1"], exitCode: 0 }).claims.ticketRecordClaimed, true);
    assert.strictEqual(claimsFromInvocation({ step: "fix", argv: ["--status"], exitCode: 0 }).claims.patchRecordClaimed, false);
    assert.strictEqual(claimsFromInvocation({ step: "fix", argv: ["--ticket=TCK-1"], exitCode: 0 }).claims.patchRecordClaimed, true);

    // The claims are derived from the invocation, not handed down by the command being audited.
    const c = claimsFromInvocation({ step: "fix", argv: ["--commit=PATCH-7"], exitCode: 0 });
    assert.strictEqual(c.checks.length, 1);
    assert.strictEqual(c.checks[0].kind, "patch-committed");
    assert.deepStrictEqual(
      c.checks[0].run({ patches: [{ id: "PATCH-7", status: "committed", ticketId: "TCK-1", files: ["a.js"] }] }),
      null
    );
    assert.ok(c.checks[0].run({ patches: [{ id: "PATCH-7", status: "accepted", ticketId: "TCK-1", files: ["a.js"] }] }));
  } finally {
    if (savedAutopilot === undefined) delete process.env.AUTOPILOT_MODE;
    else process.env.AUTOPILOT_MODE = savedAutopilot;
    if (savedDelivery === undefined) delete process.env.DELIVERY_MODE;
    else process.env.DELIVERY_MODE = savedDelivery;
  }
}

// ─── 5. A live run lock is the lock working ───────────────────────────────────

async function scenarioLiveLockIsNotAFinding() {
  const dir = await runFolder("lock");
  await writePlan(dir);
  await fsp.writeFile(
    path.join(dir, "run.lock"),
    JSON.stringify({ runId: "a-run-in-progress", pid: process.pid, host: "here", by: "gulp glossary", startedAt: new Date().toISOString() }),
    "utf8"
  );
  const r = await auditDeliveryRun({ step: "delivery", argv: ["--mode=report"], exitCode: 0, quiet: true });
  assert.ok(
    !kinds(r.report).has("run-lock-stale") &&
      !kinds(r.report).has("run-lock-unverifiable") &&
      !kinds(r.report).has("run-lock-stalled"),
    `a live run's lock was reported as a defect:\n${r.report.markdown}`
  );
  assert.strictEqual(r.report.findings.length, 0, r.report.markdown);
}

// ─── 6. A channel written through the real doors reports nothing ──────────────

/**
 * The half that proves the invariants match the writers. Every expectation in scenarioPlantedDefects
 * is checked against a record built by hand; this one is built by `createTicket`, `recordDiagnosis`
 * and `closeTicket`, which is what actually writes the channel. If the audit fires here, the audit is
 * wrong about what a healthy ticket looks like.
 */
async function scenarioRealDoors() {
  const dir = await runFolder("doors");
  await writePlan(dir);

  const opened = createTicket({
    step: "glossary",
    volume: "02",
    finding: "missing-required",
    question: "Why is volume 02's glossary missing when volume 01 built one, and what is the producer doing differently?",
    evidence: [{ file: "Test Story(02)/glossary.md", note: "absent from the volume folder" }],
    ruledOut: ["the volume folder does exist, and its source book is there"],
  });
  assert.ok(opened.ticket, JSON.stringify(opened.problems));
  assert.strictEqual(opened.written, true, opened.error);

  const answered = recordDiagnosis(opened.ticket.id, {
    cause: "the extractor keeps a row only when its whole first column appears verbatim in the text it is processing",
    options: [
      {
        id: "O1",
        label: "Read the extractor's window and confirm the dropped row",
        touches: ["glossary/extract.js"],
        cost: "free",
        risk: "None. It changes nothing.",
        verify: "Count the rows in the quarantined file against the previous volume's glossary.",
        requiresCodeChange: false,
      },
    ],
    questions: ["Does the quarantined file hold MORE rows than the published one?"],
  });
  assert.ok(answered.ticket, answered.error);

  const clean = await auditDeliveryRun({ step: "diagnose", argv: [`--ticket=${opened.ticket.id}`], exitCode: 0, quiet: true });
  assert.strictEqual(clean.report.findings.length, 0, `a ticket answered through the real doors reported:\n${clean.report.markdown}`);

  const closed = closeTicket(opened.ticket.id, { outcome: "unchanged", note: "nothing has been rebuilt yet" });
  assert.ok(!closed.error, closed.error);

  const afterClose = await auditDeliveryRun({ step: "delivery", argv: ["--mode=report"], exitCode: 0, quiet: true });
  assert.strictEqual(afterClose.report.findings.length, 0, `a ticket closed on a measured outcome reported:\n${afterClose.report.markdown}`);

  // And the honest "answered, but every option was refused" state is not a finding either: the ticket
  // says plainly that the decision belongs to the account owner.
  await writeTickets([
    ticketRecord({
      id: "TCK-run-1-2",
      status: "answered",
      diagnosis: { cause: "the gate reads the whole row", attempts: 1 },
      options: [],
      refusedOptions: [{ id: "O1", why: "it removes a finding without changing the deliverable" }],
      noUsableOptions: true,
    }),
  ]);
  const refused = await auditDeliveryRun({ step: "diagnose", argv: ["--open"], exitCode: 0, quiet: true });
  assert.strictEqual(refused.report.findings.length, 0, refused.report.markdown);
}

// ─── 7. The audit records, reports, never throws, and never takes the wheel ───

async function scenarioRecordsAndNeverGrabsTheWheel() {
  const dir = await runFolder("record");
  // No plan on disk, and the command claims one: a HIGH finding, on a command that exited 0.
  const r = await auditDeliveryRun({ step: "delivery", argv: ["--mode=report"], exitCode: 0, quiet: true });
  assert.ok(r.report.counts.HIGH > 0);

  // It wrote the report where the other post-mortems live, in both halves.
  for (const name of ["delivery.md", "delivery.json"]) {
    assert.ok(fs.existsSync(path.join(postMortemDir(), name)), `${name} was not written beside the other reports`);
  }
  const machine = JSON.parse(await fsp.readFile(path.join(postMortemDir(), "delivery.json"), "utf8"));
  assert.strictEqual(machine.step, "delivery");
  assert.ok(machine.findings.length > 0, "the JSON half is what a future diagnosis agent reads");

  // It recorded the finding in the ledger, which is how it reaches the next run's triage.
  assert.strictEqual(r.recorded, true);
  const ledger = JSON.parse(await fsp.readFile(path.join(postMortemDir(), "ledger.json"), "utf8"));
  const entry = ledger.entries.find((e) => e.step === "delivery");
  assert.ok(entry, "the audit left no trace in the ledger — the finding dies with the console");
  assert.strictEqual(entry.kind, "assessment");
  assert.deepStrictEqual(entry.findingKinds, [...new Set(r.report.findings.map((f) => f.kind))]);

  // An audit that cannot run is reported as such and does not throw.
  const broken = await fsp.mkdtemp(path.join(os.tmpdir(), "delivery-audit-broken-"));
  await fsp.writeFile(path.join(broken, "not-a-folder"), "x", "utf8");
  process.env.POSTMORTEM_DIR = path.join(broken, "not-a-folder", "sub");
  const failed = await auditDeliveryRun({ step: "delivery", argv: [], exitCode: 0, quiet: true });
  assert.ok(failed.error, "an audit that could not run must say so");
  assert.strictEqual(failed.report, null);
  assert.strictEqual(failed.recorded, false);

  // The report is readable: severity, file, and a message.
  const md = renderPostMortemMarkdown(r.report);
  assert.ok(md.includes("## HIGH"), "findings must be grouped by severity");
  assert.ok(md.includes("delivery-plan.md"), "a finding must name the file");
}

// ─── 7b. A fact the command knows and no file check can see ───────────────────

/**
 * The autopilot loop's refused manager decisions are not files: there is no "decision record" on
 * disk, so no declared expectation and no cross-record check can find one. `extraFindings` is how
 * they reach the same report and the same ledger entry as everything else — which is the difference
 * between "the manager could not decide" being a line on a console and being something the next
 * run's triage can count across runs.
 */
async function scenarioExtraFindingsAreRecorded() {
  await runFolder("extra");
  const r = await auditDeliveryRun({
    step: "autopilot",
    argv: ["--mode=watch"],
    exitCode: 1,
    quiet: true,
    extraFindings: [
      finding("HIGH", "manager-refused", "autopilot", null, displayPath(path.join(postMortemDir(), "ledger.json")),
        "the manager made no move: it called none of the 3 tool(s) it was offered and wrote nothing."),
    ],
  });
  const f = findingOf(r.report, "manager-refused");
  assert.ok(f, "the finding the command handed in never reached the report");
  assert.strictEqual(f.severity, "HIGH");
  assert.strictEqual(r.report.ok, false, "a run where the deciding role produced nothing is not a clean run");

  const ledger = JSON.parse(await fsp.readFile(path.join(postMortemDir(), "ledger.json"), "utf8"));
  const entry = ledger.entries.find((e) => e.step === "autopilot");
  assert.ok(entry, "the refusal left no trace in the ledger — it dies with the console");
  assert.ok((entry.findingKinds || []).includes("manager-refused"), JSON.stringify(entry));
  assert.strictEqual(
    entry.kind,
    "assessment",
    "a refusal is recorded as an assessment: `attemptCount` and `isSpinning` select on `intervention`, " +
      "so recording a refusal can never spend a move or launder a spin"
  );
}

// ─── 8. The paths the report prints resolve to the repo root ──────────────────

/**
 * Gotcha 80, pinned for the module that exists to catch the class.
 *
 * `utils/delivery-audit.js` lives in `utils/`, so its own `__dirname` is the folder, not the repo.
 * A report that names its findings `../.postmortem/tickets.json` is not wrong in a way anything
 * breaks — it is wrong in a way a reader follows to the wrong folder. Checked as a pure function,
 * because checking it by running the audit would mean writing into a run's records.
 *
 * The records now live next to the series, which is usually OUTSIDE this repository, so the
 * guarantee being pinned is not "relative to the repo" — it is "shown as the path it actually is".
 * Inside the repo: relative, so a reader can open it. Outside: absolute, because a relative path
 * that walks out of the repo is the one a reader follows to a folder that does not exist.
 */
function scenarioReportPathsAreHonest() {
  const saved = { POSTMORTEM_DIR: process.env.POSTMORTEM_DIR, RUN_DIR: process.env.RUN_DIR, SERIES_LOCATION: process.env.SERIES_LOCATION };
  const RECORDS = ["tickets.json", "patches.json", "ledger.json", "run.lock", "delivery-plan.json"];
  try {
    // Inside the repository: relative, and never a path that climbs out of it.
    process.env.RUN_DIR = path.join(ROOT, ".run");
    delete process.env.POSTMORTEM_DIR;
    const inside = postMortemDir();
    assert.strictEqual(inside, path.join(ROOT, ".run", "postmortem"), `postMortemDir() resolves to ${inside}`);
    for (const name of RECORDS) {
      const shown = displayPath(path.join(inside, name));
      assert.strictEqual(shown, path.join(".run", "postmortem", name), `the report would print ${name} as ${shown}`);
      assert.ok(!shown.startsWith(".."), `${name} resolves outside the repository: ${shown}`);
    }

    // Next to a series that is not in this repository: the absolute path, which is the only
    // thing a reader can actually follow.
    process.env.RUN_DIR = "/elsewhere/my-series/.run";
    const outside = postMortemDir();
    for (const name of RECORDS) {
      const shown = displayPath(path.join(outside, name));
      assert.strictEqual(shown, path.join("/elsewhere/my-series/.run/postmortem", name), `a record outside the repo was shown as ${shown}`);
    }

    // A record the operator moved out of the repo is shown as the absolute path it actually is,
    // rather than as a relative path that points nowhere.
    assert.strictEqual(displayPath("/elsewhere/.postmortem/tickets.json"), "/elsewhere/.postmortem/tickets.json");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// ─── 9. The four commands are wired ───────────────────────────────────────────

/**
 * The audit is called by the commands, not only by this suite. Checked by reading the entry points:
 * a wiring that was deleted is the gap coming back, and no behaviour test would notice until a run
 * failed in a way nobody was told about.
 */
async function scenarioEntryPointsAreWired() {
  for (const name of DELIVERY_COMMANDS) {
    const source = await fsp.readFile(path.join(ROOT, `${name}.js`), "utf8");
    const folder = await fsp.readFile(path.join(ROOT, name, "cli.js"), "utf8").catch(() => "");
    const text = source + folder;
    assert.ok(
      /auditDeliveryRun/.test(text),
      `${name}.js does not run the after-run audit — the delivery layer is unsupervised again`
    );
  }
}

// ─── run ──────────────────────────────────────────────────────────────────────

(async function main() {
  try {
    await scenarioCommandsAreDeclared();
    console.log(`delivery audit: ${DELIVERY_COMMANDS.length} delivery commands declared, 12 pipeline steps untouched`);

    await scenarioCleanRun();
    console.log("delivery audit: a command that wrote what it claims reports nothing (and a rehearsal is not blamed)");

    await scenarioPlantedDefects();
    console.log(`delivery audit: ${DEFECT_CASES.length} planted defects all detected`);

    await scenarioClaimsAreChecked();
    await scenarioClaimsReadOffTheCommandLine();
    console.log(`delivery audit: ${CLAIM_CASES.length} claims checked against the records they name`);

    await scenarioLiveLockIsNotAFinding();
    console.log("delivery audit: a live run's lock is the lock working, not a finding");

    await scenarioRealDoors();
    console.log("delivery audit: a channel written through the real doors reports nothing");

    await scenarioRecordsAndNeverGrabsTheWheel();
    console.log("delivery audit: records to the ledger, writes its report, never throws, never changes the exit code");

    await scenarioExtraFindingsAreRecorded();
    console.log("delivery audit: a fact the command knows and no file check can see still reaches the ledger");

    await scenarioReportPathsAreHonest();
    console.log("delivery audit: the report's paths name the records as the paths they actually are (gotcha 80)");

    await scenarioEntryPointsAreWired();
    console.log("delivery audit: all four commands run it");

    console.log("delivery audit: all checks passed.");
  } finally {
    if (savedPostMortemDir === undefined) delete process.env.POSTMORTEM_DIR;
    else process.env.POSTMORTEM_DIR = savedPostMortemDir;
    if (savedLedger === undefined) delete process.env.LEDGER_ENABLED;
    else process.env.LEDGER_ENABLED = savedLedger;
  }
})();

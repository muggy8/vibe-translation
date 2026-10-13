#!/usr/bin/env node
/**
 * test/test-finding-routing.js — what a finding's LEVEL means to the resume triage.
 *
 * `utils/postmortem/plan/01-finding-levels.md` §1 measured the defect this file exists to keep shut:
 * the triage classified a step by filtering findings on **severity first**, so four of the ten kinds it
 * itself calls damage (`wrong-shape`, `chapter-without-draft`, `accepted-without-acceptance`,
 * `audit-verdict-missing`) were emitted at MEDIUM and could never reach its decision. They became a
 * line in a report. `utils/resume/triage.js` said it out loud: "non-blocking gap(s) — reported, not
 * acted on."
 *
 * Slice 2 routes on the level instead. This file is the behavioural half — it plants each shape on a
 * throwaway fixture series and asks what the triage DOES with it:
 *
 *   1. the four blind kinds land as **damage**: they open the run, they are named, and the plan picks
 *      up at the volume they name;
 *   2. a **MINOR** finding does not stop a run and does not open one — it is batched per (kind, step)
 *      and proposed for investigation;
 *   3. a **NOTE** is reported only;
 *   4. `quarantine-present` beside complete output is still evidence, never damage, and never a wipe
 *      (Tier C — this is the volume-15 rule and it must survive the re-routing);
 *   5. a step that HALTED at the volume boundary is a distinct state from a step that failed: the plan
 *      says which book it stopped after, which books were never attempted, and proposes resuming from
 *      that book rather than re-running from volume 1;
 *   6. a kind with no row in the level table lands as **damage** — fail closed — and its message still
 *      says the level was undeclared;
 *   7. batching is per (kind, step), so one kind spread over seventeen volumes is one investigation
 *      per step, not seventeen;
 *   8. `chapter-extraction-never-answered` — a term-list read that never answered — is MAJOR damage,
 *      the stage really emits it, and the post-mortem does **not** see it yet: the channel from a
 *      stage's own finding into the disk assessment does not exist, and that is pinned rather than
 *      assumed;
 *   9. no environment variable gates any of it.
 *
 * Fixtures only. Nothing here reads the real 17 volumes, the reference store, or the endpoint.
 * (AGENTS.md rule 8, gotcha 69.)
 *
 * @module test/test-finding-routing
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Pin the acceptance thresholds the fixture's rolling-state files are judged against, so the planted
// "never accepted" window is refused whatever this machine's .env says.
process.env.PASSING_SCORE = "70";
process.env.ACCEPTANCE_WINDOW_SIZE = "2";
process.env.ACCEPTANCE_MIN_SAMPLES = "2";

const { PIPELINE_STEPS } = require("../gulpfile");
const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");
const resume = require("../utils/resume");
const { finding, writeVolumeHalt } = require("../utils/postmortem");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { readModuleLayer } = require("./module-layer");

const fx = require("./fixture-series");
const FIXTURE_ROOT = "/tmp/opencode/finding-routing";

const ROOT = path.join(__dirname, "..");

let checks = 0;
/**
 * Count one assertion and run it, so the suite can print how many checks it actually made.
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

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * A complete two-volume series whose `chapters.json` actually lists a chapter, so the translation
 * stage can be caught having skipped one.
 *
 * @param {string} label
 * @param {string} [volume] - Which volume's handoff list to fill. Defaults to "02".
 * @returns {Promise<Object>} The fixture.
 */
async function seriesWithAChapter(label, volume = "02") {
  const f = await fx.completeSeries(label, FIXTURE_ROOT);
  const folder = (f.volumes.find((v) => v.installmentNumber === volume) || {}).folder;
  await fs.promises.writeFile(
    path.join(f.dir, folder, "chapters.json"),
    JSON.stringify([{ id: "ch2", title: "Second Chapter", bodyChars: 4200 }], null, 2) + "\n",
    "utf8"
  );
  return f;
}

/**
 * Read the state and the plan for one fixture in one call.
 * @param {Object} f - A fixture series.
 * @returns {Promise<{state: Object, plan: Object}>}
 */
async function triage(f) {
  const state = await resume.readWorkingState({ seriesDir: f.dir });
  return { state, plan: resume.planResume(state) };
}

/**
 * The plan line for one step.
 * @param {Object} plan
 * @param {string} step
 * @returns {Object}
 */
function line(plan, step) {
  const s = (plan.steps || []).find((x) => x.step === step);
  assert.ok(s, `the plan has no line for ${step}: ${JSON.stringify((plan.steps || []).map((x) => x.step))}`);
  return s;
}

/**
 * The step state for one step.
 * @param {Object} state
 * @param {string} step
 * @returns {Object}
 */
function stepState(state, step) {
  const s = (state.stepStates || []).find((x) => x.step === step);
  assert.ok(s, `the state has no assessment for ${step}`);
  return s;
}

// ─── 1. The four kinds the triage used to be blind to ─────────────────────────

/**
 * Each of the four kinds §1 names is planted on its own fixture, and each one must now reach the
 * triage's damage decision: the step reads as unfinished, the kind is named as damage, and the plan
 * picks the run up at the volume the finding names.
 *
 * @returns {Promise<void>}
 */
async function testTheFourBlindKindsAreDamage() {
  /** @type {Array<{label: string, kind: string, step: string, volume: string, plant: (f: Object) => Promise<void>}>} */
  const cases = [
    {
      label: "chapter-without-draft",
      kind: "chapter-without-draft",
      step: "translate",
      volume: "02",
      plant: async (f) => {
        await fs.promises.writeFile(
          path.join(f.dir, "Test Story(02)", "chapters.json"),
          JSON.stringify([{ id: "ch2", title: "Second Chapter", bodyChars: 4200 }], null, 2) + "\n",
          "utf8"
        );
      },
    },
    {
      label: "wrong-shape",
      kind: "wrong-shape",
      step: "glossary",
      volume: "02",
      plant: async (f) => {
        await fs.promises.writeFile(
          path.join(f.dir, "Test Story(02)", "glossary.md"),
          "# Glossary\n\nThis glossary is written as prose. It has a heading and real content and no table at all.\n",
          "utf8"
        );
      },
    },
    {
      label: "accepted-without-acceptance",
      kind: "accepted-without-acceptance",
      step: "glossary",
      volume: "02",
      plant: async (f) => {
        await fs.promises.writeFile(
          path.join(f.dir, "Test Story(02)", "glossary-validation-rolling-state.json"),
          JSON.stringify({ results: [40, 45], acceptedBy: "rolling-window" }, null, 2) + "\n",
          "utf8"
        );
      },
    },
    {
      label: "audit-verdict-missing",
      kind: "audit-verdict-missing",
      step: "consistency-audit",
      volume: null,
      plant: async (f) => {
        await fs.promises.writeFile(
          path.join(f.dir, "consistency-report.md"),
          "# Report\n\n## Findings\n\n- nothing wrong here\n",
          "utf8"
        );
      },
    },
  ];

  for (const c of cases) {
    const f = await fx.completeSeries(`blind-${c.label}`, FIXTURE_ROOT);
    await c.plant(f);
    const { state, plan } = await triage(f);
    const st = stepState(state, c.step);

    ok(
      st.status === "incomplete",
      `${c.kind} is a MAJOR finding: the step must read as unfinished, not as "gaps". status=${st.status}, notes=${JSON.stringify(st.notes)}`
    );
    ok(
      st.damageKinds.includes(c.kind),
      `${c.kind} must reach the triage's damage list. damageKinds=${JSON.stringify(st.damageKinds)}`
    );
    ok(
      !st.notes.some((n) => n.includes(c.kind)),
      `${c.kind} must not be filed as a note beside finished work: ${JSON.stringify(st.notes)}`
    );
    same(plan.verdict, "resume", `${c.kind} opens the run. headline: ${plan.headline}`);
    const l = line(plan, c.step);
    ok(
      l.action === "run" || l.action === "ticket",
      `${c.kind} must produce a move, not a report line. action=${l.action}`
    );
    same(l.finding, c.kind, `${c.kind} is the finding the plan is a response to`);
    if (c.volume) {
      same(l.fromVolume, c.volume, `${c.kind} names the volume it was found in as the resume point`);
    }
    ok(
      l.reasons.some((r) => r.includes(c.kind)),
      `${c.kind} is named in the plan's own reasons: ${l.reasons.join(" | ")}`
    );
    ok(
      plan.markdown.includes(c.kind),
      `${c.kind} reaches the human-readable plan`
    );
  }

  console.log("  the four blind kinds: damage, named, and they open the run");
}

// ─── 2. MINOR does not stop a run and does not open one ───────────────────────

/**
 * `unexpected-file` is declared MINOR. It must be reported and batched, and it must not become a
 * resume point, a re-run, or a wipe.
 *
 * @returns {Promise<void>}
 */
async function testMinorDoesNotOpenTheRun() {
  const f = await fx.completeSeries("minor-stray", FIXTURE_ROOT);
  await fs.promises.writeFile(path.join(f.dir, "Test Story(02)", "notes-from-somebody.txt"), "a stray file\n", "utf8");
  const { state, plan } = await triage(f);

  same(plan.verdict, "nothing-to-do", `a MINOR finding must not open the run: ${plan.headline}`);
  ok(
    (state.stepStates || []).every((s) => s.status !== "incomplete" && s.status !== "paused"),
    `no step may read as unfinished: ${JSON.stringify((state.stepStates || []).filter((s) => s.status === "incomplete").map((s) => s.step))}`
  );
  ok(
    plan.steps.every((s) => s.action === "none"),
    `nothing is proposed as work: ${JSON.stringify(plan.steps.map((s) => [s.step, s.action]))}`
  );
  ok(plan.steps.every((s) => s.wipeFirst.length === 0), "a MINOR finding removes nothing");
  ok(plan.steps.every((s) => !s.countsAsIntervention), "a MINOR finding spends no intervention budget");

  const glossary = stepState(state, "glossary");
  ok(
    glossary.gapKinds.includes("unexpected-file"),
    `the MINOR kind is recorded as a gap, with its level: ${JSON.stringify(glossary.gapKinds)}`
  );
  ok(
    !glossary.damageKinds.includes("unexpected-file"),
    "MINOR is not damage"
  );
  const batch = (glossary.gapBatches || []).find((b) => b.kind === "unexpected-file");
  ok(batch, `the gap is batched per (kind, step): ${JSON.stringify(glossary.gapBatches)}`);
  same(batch.level, "MINOR", "a batch names the level it was routed by");
  same(batch.count, 1, "one occurrence, one count");
  same(batch.volumes, ["02"], "and it names the volume it was found in");

  // The batch is PROPOSED for investigation, and the proposal is in the plan a human reads.
  const investigation = (plan.investigations || []).find((i) => i.step === "glossary" && i.kind === "unexpected-file");
  ok(
    investigation,
    `the plan proposes one investigation per (kind, step): ${JSON.stringify(plan.investigations)}`
  );
  same(investigation.level, "MINOR", "the proposal carries the level, so the investigator knows the size of fix expected");
  ok(
    plan.markdown.includes("unexpected-file"),
    "the batched investigation reaches the human-readable plan"
  );

  console.log("  MINOR: reported, batched, proposed — and it opens nothing");
}

// ─── 3. NOTE is reported only, and evidence is still evidence ─────────────────

/**
 * Two things that must survive the re-routing unchanged:
 *   - a NOTE-level kind is a line in the report and nothing else;
 *   - `quarantine-present` beside COMPLETE output is evidence: read it, never rebuild, never wipe.
 *
 * @returns {Promise<void>}
 */
async function testNoteAndEvidence() {
  // A NOTE-level kind, classified directly (the pipeline emits `manager-corrected` and
  // `nothing-executed` from the manager's own CLI, which no fixture series reproduces).
  const classified = resume.classifyFindings([
    finding("LOW", "manager-corrected", "glossary", null, "", "the manager's first answer was refused and its second worked"),
    finding("LOW", "nothing-executed", "glossary", null, "", "act mode ran and executed nothing"),
    finding("LOW", "reference-source-schema-upgraded", "glossary", "01", "series.db", "the copy upgraded an older record"),
  ]);
  same(classified.damage.map((f) => f.kind), [], "a NOTE-level kind is never damage");
  same(classified.gaps.map((f) => f.kind), [], "a NOTE-level kind is never a MINOR gap either");
  same(
    classified.notes.map((f) => f.kind).sort(),
    ["manager-corrected", "nothing-executed", "reference-source-schema-upgraded"],
    "a NOTE is reported"
  );

  // The volume-15 lesson, on disk: a gate's evidence beside output that is complete.
  const f = await fx.completeSeries("evidence-beside-complete-routing", FIXTURE_ROOT);
  await fs.promises.writeFile(path.join(f.dir, "Test Story(02)", "glossary.md.rejected"), "old quarantine\n", "utf8");
  const { state, plan } = await triage(f);

  const glossary = stepState(state, "glossary");
  ok(glossary.evidenceKinds.includes("quarantine-present"), "the quarantine is still evidence");
  ok(!glossary.damageKinds.includes("quarantine-present"), "and it is still not damage");
  same(plan.verdict, "evidence", plan.headline);
  const l = line(plan, "glossary");
  same(l.action, "ticket", "reading the evidence is a question, not a rebuild");
  same(l.actionName, "open-ticket");
  same(l.wipeFirst, [], "complete output is not removed because a leftover file is next to it");
  ok(!plan.markdown.includes("wipe-and-cascade"), `Tier C survives the re-routing: ${plan.markdown.slice(0, 400)}`);
  ok(
    l.reasons.some((r) => r.includes("not a reason to rebuild")),
    "the plan still says out loud that this volume is finished"
  );

  console.log("  NOTE is reported only; evidence beside finished work is still evidence");
}

// ─── 4. A step that halted is a distinct state ────────────────────────────────

/**
 * The slice-4 halt record, read by the triage. Volume 01's glossary is genuinely the wrong shape (the
 * MAJOR that stopped the walk), volume 02 has no glossary at all (the walk never reached it), and the
 * halt record says so. The plan must say "paused after volume 01", name volume 02 as never attempted,
 * and propose resuming from 01 — not treat volume 02 as a broken book.
 *
 * @returns {Promise<void>}
 */
async function testAPausedStepIsNotABrokenBook() {
  const f = await fx.completeSeries("paused-step", FIXTURE_ROOT);
  const vol1 = path.join(f.dir, "Test Story(01)");
  const vol2 = path.join(f.dir, "Test Story(02)");

  // Volume 01: the artifact is there and is not the document it claims to be.
  await fs.promises.writeFile(
    path.join(vol1, "glossary.md"),
    "# Glossary\n\nWritten as prose, with real content and no table, which is the shape every later volume amends from.\n",
    "utf8"
  );
  // Volume 02: the walk never reached it.
  for (const e of STEP_ARTIFACT_SPECS.glossary.volume) {
    await fs.promises.rm(path.join(vol2, e.name.replace("{installment}", "02")), { force: true });
  }

  const written = writeVolumeHalt({
    step: "glossary",
    haltedAfterVolume: "01",
    haltedAfterFolder: "Test Story(01)",
    attemptedVolumes: ["01"],
    unattemptedVolumes: ["02"],
    trigger: [
      {
        kind: "wrong-shape",
        level: "MAJOR",
        severity: "MEDIUM",
        file: "Test Story(01)/glossary.md",
        message: "glossary.md has no Markdown table",
      },
    ],
  });
  ok(written.written, `the halt record was written where the triage can read it: ${written.error}`);

  const { state, plan } = await triage(f);
  const glossary = stepState(state, "glossary");

  same(glossary.status, "paused", "a step that stopped at a volume boundary is not a step that failed everywhere");
  ok(glossary.halt, "the step state carries the halt record it read");
  same(glossary.halt.haltedAfterVolume, "01", "it names the book the step stopped after");
  same(glossary.halt.unattemptedVolumes, ["02"], "and the books it never attempted");
  ok(glossary.halt.suppressedMissing > 0, "the never-attempted volume's missing output is counted, not reported as damage");
  same(glossary.damageKinds, ["wrong-shape"], "the volume that tripped the gate keeps the finding it earned");
  same(glossary.volumes, ["01"], "the resume volume is the halted one, not the untouched one");

  same(plan.verdict, "resume", plan.headline);
  const l = line(plan, "glossary");
  same(l.fromVolume, "01", "the proposal resumes from the volume the step stopped after, not from volume 01-of-a-broken-tail");
  ok(l.paused, "the plan line says this step is paused, which is a different state from unfinished work");
  same(l.paused.haltedAfterVolume, "01");
  same(l.paused.unattemptedVolumes, ["02"]);
  ok(
    l.reasons.some((r) => r.includes("halted after volume 01")),
    `the plan says the step stopped on purpose: ${l.reasons.join(" | ")}`
  );
  ok(
    l.reasons.some((r) => r.includes("never attempted") && r.includes("02")),
    `and names the books that were not attempted: ${l.reasons.join(" | ")}`
  );
  ok(
    plan.headline.includes("paused") && plan.headline.includes("01"),
    `the headline a human reads: ${plan.headline}`
  );
  ok(plan.markdown.includes("never attempted"), "the Markdown names the unattempted volumes");

  // The untouched tail is not blamed for the halt.
  const voice = stepState(state, "character-voice");
  same(voice.status, "complete", "a step that was never halted is not reported as one");

  console.log("  a halted step: paused after volume 01, volume 02 named as never attempted, resume from 01");
}

// ─── 5. An undeclared kind is damage, not a gap ───────────────────────────────

/**
 * The default level is MINOR, and under level routing MINOR is invisible to the damage decision —
 * which is the exact failure this plan exists to prevent. So an undeclared kind must be routed to
 * damage, and it must still say the level was undeclared.
 *
 * @returns {void}
 */
function testUndeclaredKindFailsClosed() {
  const planted = finding("MEDIUM", "a-kind-nobody-declared", "glossary", "02", "glossary.md", "a planted kind with no row");

  same(planted.level, "MINOR", "the runtime default is unchanged: an unknown kind is not a halt");
  same(planted.levelDeclared, false, "the finding says it was defaulted, so whoever reads it can tell a default from a decision");
  ok(
    planted.message.includes('level undeclared for kind "a-kind-nobody-declared"'),
    `and the message still says so: ${planted.message}`
  );

  const classified = resume.classifyFindings([planted]);
  same(classified.damage.map((f) => f.kind), ["a-kind-nobody-declared"], "an undeclared kind lands as DAMAGE, not as a gap");
  same(classified.gaps, [], "it is not batched away");
  same(classified.notes, [], "and it is not a note");

  // A declared kind is not swept into the fail-closed branch.
  const declared = resume.classifyFindings([
    finding("MEDIUM", "unexpected-file", "glossary", "02", "glossary.md/stray.txt", "a stray file"),
  ]);
  same(declared.damage, [], "a kind the table declares MINOR is a gap");
  same(declared.gaps.map((f) => f.kind), ["unexpected-file"]);

  // A finding that CLAIMS a level for a kind the table does not know is still undeclared: the table is
  // the authority, not the object handed to the triage.
  const smuggled = resume.classifyFindings([{ kind: "a-kind-nobody-declared", level: "NOTE", severity: "LOW", file: "x", message: "trust me" }]);
  same(smuggled.damage.map((f) => f.kind), ["a-kind-nobody-declared"], "the level table decides, not whatever `level` a finding object carries");

  // Every damage kind the menu names must be reachable, and no damage kind may be a NOTE.
  for (const kind of resume.DAMAGE_KINDS) {
    const r = resume.classifyFindings([finding("MEDIUM", kind, "glossary", "02", "glossary.md", `planted ${kind}`)]);
    same(r.damage.map((f) => f.kind), [kind], `${kind} is damage and must reach the damage decision whatever severity it is emitted at`);
  }
  for (const kind of resume.EVIDENCE_KINDS) {
    const high = resume.classifyFindings([finding("HIGH", kind, "glossary", "02", "glossary.md.rejected", "a gate refused it")]);
    same(high.damage, [], `${kind} beside output is evidence, never damage (Tier C)`);
    same(high.evidence.map((f) => f.kind), [kind], `${kind} at HIGH is evidence`);
  }

  console.log("  an undeclared kind fails closed into damage, and says it was undeclared");
}

// ─── 6. Batching is per (kind, step), not per volume ──────────────────────────

/**
 * Batching, measured before any ceiling is applied to it: one kind present in EVERY volume of a
 * seventeen-volume series produces one investigation per (kind, step), not one per volume.
 *
 * (Slice 2 measured this with no bound in the code at all. Slice 3 added the ceiling, and this
 * scenario still asks only the batching question — the bound and the reuse are `test-investigation-bound.js`'s
 * job, and keeping the two suites asking different questions is what stops one of them quietly
 * re-defining the other.)
 *
 * @returns {Promise<void>}
 */
async function testSeventeenVolumesOneKind() {
  const f = await fx.completeSeries("seventeen", FIXTURE_ROOT);
  const manifest = JSON.parse(await fs.promises.readFile(path.join(f.dir, "translation-target.json"), "utf8"));
  const volumes = [...manifest.volumes];
  while (volumes.length < 17) {
    const n = String(volumes.length + 1).padStart(2, "0");
    volumes.push({
      folder: `Test Story(${n})`,
      sourceFile: `Test Story(${n})/book.epub`,
      installmentNumber: n,
      title: "Test Story",
      integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose in one headed section, no packaging pages" },
    });
  }
  manifest.volumes = volumes;
  await fs.promises.writeFile(path.join(f.dir, "translation-target.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  for (const v of volumes) {
    const volDir = path.join(f.dir, v.folder);
    await fs.promises.mkdir(volDir, { recursive: true });
    await fs.promises.writeFile(path.join(volDir, "book.epub"), "not really an epub", "utf8");
    for (const { name } of PIPELINE_STEPS) await fx.writeVolumeOutputs(f.dir, v, name);
    // One unrecognised file in EVERY volume of the series.
    await fs.promises.writeFile(path.join(volDir, "notes-from-somebody.txt"), "a stray file\n", "utf8");
  }
  await fx.writeRunOutputs(f.ledgerDir, "extract", volumes);
  await fs.promises.writeFile(
    path.join(f.dir, "translation-report.json"),
    JSON.stringify(
      {
        schema: 1,
        generatedAt: new Date().toISOString(),
        seriesName: "Test Story",
        chapters: volumes.map((v) => ({ volume: v.installmentNumber, folder: v.folder, id: "whole", outcome: "PUBLISHED (verified)" })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const { state, plan } = await triage(f);
  same(plan.verdict, "nothing-to-do", `seventeen MINOR findings still do not open the run: ${plan.headline}`);

  const occurrences = (state.stepStates || []).reduce((n, s) => n + (s.gapFindings || []).filter((f) => f.kind === "unexpected-file").length, 0);
  const batches = (plan.investigations || []).filter((i) => i.kind === "unexpected-file");
  ok(
    occurrences >= 17,
    `the fixture really planted the kind across the series: ${occurrences} occurrence(s)`
  );
  same(
    batches.length,
    new Set(batches.map((b) => b.step)).size,
    `one investigation per (kind, step) — ${occurrences} occurrences produced ${batches.length} investigation(s), not ${occurrences}`
  );
  for (const b of batches) {
    same(b.occurrences, 17, `${b.step}: the batch counts every volume it fired in, so nothing is lost by batching`);
    same(b.volumes.length, 17, `${b.step}: and names all of them`);
  }
  ok(
    batches.length < occurrences,
    `batching is what slice 3 bounds: ${occurrences} findings → ${batches.length} investigations`
  );

  console.log(
    `  seventeen volumes, one MINOR kind: ${occurrences} findings batch into ${batches.length} investigation(s) — one per (kind, step)`
  );
}

// ─── 7. A chapter nobody read is damage, and it says how far it travels ────────

/**
 * `chapter-extraction-never-answered` — the kind `glossary/store.js` builds when a term-list read came
 * back with no list at all (a refused answer shape, or an answer the parser could not read, after both
 * paid reads).
 *
 * Two things are pinned here, and the second is the uncomfortable one.
 *
 *   1. **The level.** MAJOR, and it reaches the triage's damage decision: the glossary is copied
 *      forward, so a chapter nobody read is missing from every later volume's glossary too. That is the
 *      same shape as `chapter-without-draft`, which is why it sits next to it in the table.
 *   2. **The channel it does not have yet.** The post-mortem assesses a finished step **from the disk**
 *      (`utils/postmortem/run.js` → `volume.js` / `file.js`). A finding a stage builds in its own
 *      process and puts in its own report is not on that disk, so this kind reaches the grader and the
 *      volume's report and NOT the halt gate or the triage. That is asserted here rather than left in a
 *      comment, because a finding kind whose routing a test proves, with nothing saying where it
 *      actually arrives, is exactly the kind of finding that looks like a guard and is not one. Closing
 *      the gap needs a declared sidecar in `utils/artifacts/preproduction.js` or a finding channel in
 *      `utils/postmortem/volume.js`; both are outside the slice that added the kind.
 *
 * @returns {Promise<void>}
 */
async function testAChapterNobodyReadIsDamage() {
  const kind = "chapter-extraction-never-answered";
  same(FINDING_LEVELS[kind].level, "MAJOR", `${kind} is declared MAJOR: the glossary is copied forward, so the hole travels`);

  const planted = finding("HIGH", kind, "glossary", "02", "glossary.md", "chapter ch5: the term-list read never produced a list");
  same(planted.level, "MAJOR", "and finding() records it");
  const routed = resume.classifyFindings([planted]);
  same(routed.damage.map((f) => f.kind), [kind], "it lands in the damage decision, not in the batched gaps");
  same(routed.gaps, [], "and it is not swept into the MINOR batch");

  // The stage really builds it: the kind is emitted from the glossary layer, not only declared here.
  const storeLayer = readModuleLayer(ROOT, "glossary/store.js", "glossary");
  ok(
    storeLayer.includes(`"${kind}"`),
    `glossary/store.js must emit "${kind}" — a level row for a kind nothing emits is decoration`
  );

  // And the honest half: a fixture whose glossary step finished cleanly produces no such finding from
  // the post-mortem, because the post-mortem reads the disk and the stage's finding is not on it.
  const f = await fx.completeSeries("read-hole", FIXTURE_ROOT);
  const { runPostMortem } = require("../utils/postmortem");
  const report = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  same(
    report.findings.filter((x) => x.kind === kind).map((x) => x.volume),
    [],
    `the disk assessment does not emit ${kind} today — the stage's own finding has no route into the post-mortem, and this assertion is what stops anyone claiming it does`
  );
  ok(
    report.findings.length === 0,
    `the fixture's glossary step is clean, so the assessment finds nothing (got: ${report.findings.map((x) => x.kind).join(", ") || "none"})`
  );

  console.log(`  ${kind}: MAJOR, damage, emitted by the stage — and not yet routed through the post-mortem, pinned`);
}

// ─── 8. No environment knob, and the routing is data ──────────────────────────

/**
 * The routing table is code in a closed path, and nothing in the resume layer can be switched off by
 * an environment variable. `DELIVERY_MAX_INTERVENTIONS` and `SERIES_LOCATION` are pre-existing and are
 * not routing dials; the assertion pins that no NEW one appeared.
 *
 * @returns {void}
 */
function testNoEnvironmentKnob() {
  /** @type {Set<string>} */
  const names = new Set();
  for (const file of ["state.js", "triage.js", "plan.js", "report.js", "menu.js", "escalate.js"]) {
    const source = fs.readFileSync(path.join(ROOT, "utils/resume", file), "utf8");
    for (const m of source.matchAll(/process\.env\.([A-Z_0-9]+)/g)) names.add(m[1]);
  }
  same(
    [...names].sort(),
    ["DELIVERY_MAX_INTERVENTIONS", "SERIES_LOCATION"],
    "the resume layer reads exactly the two environment variables it already read: no dial was added to the level routing, the pause, or the batching"
  );

  const stateSource = fs.readFileSync(path.join(ROOT, "utils/resume/state.js"), "utf8");
  ok(stateSource.includes("LEVEL_ROUTES"), "the level → triage action mapping is a table, not a chain of ifs");
  for (const level of ["STOP", "MAJOR", "MINOR", "NOTE"]) {
    ok(
      new RegExp(`\\b${level}\\b`).test(stateSource),
      `${level} is named in the routing table`
    );
  }

  // The routing lives in the banned patch path, like the level table it reads.
  const { BANNED_PATCH_PATHS } = require("../utils/patches");
  for (const file of ["utils/resume/state.js", "utils/resume/triage.js", "utils/resume/plan.js"]) {
    ok(
      BANNED_PATCH_PATHS.some((r) => r.pattern && r.pattern.test(file)),
      `${file} must stay closed to the role the triage investigates`
    );
  }

  // The triage reads the level from the finding / the table. Severity survives in exactly one place:
  // the evidence class, whose treatment this slice must not change (a HIGH quarantine is evidence, a
  // MEDIUM one is the note it already was).
  // The BARREL, not `state.js` with the folder named: naming a file inside its own folder reads that
  // file twice, and a count-based assertion would then be counting the same line two times.
  const layer = readModuleLayer(ROOT, "utils/resume.js", "utils/resume");
  ok(
    !/findings\.filter\(\(f\) => f\.severity === "HIGH"\)/.test(layer),
    "the severity-first filter that made four damage kinds invisible is gone"
  );
  ok(/classifyFindings/.test(layer), "the classification is one function a test can call");
  const highTests = [...layer.matchAll(/severity === "HIGH"/g)];
  same(highTests.length, 1, 'severity still decides exactly one thing — `severity === "HIGH"` appears once, in the EVIDENCE_KINDS branch');
  ok(
    /EVIDENCE_KINDS[\s\S]{0,160}severity === "HIGH"/.test(layer),
    'and the one place it decides is inside the evidence branch, which this slice must not change'
  );

  // The table is the dial, not a decoration next to a chain of ifs — and it cannot be turned.
  ok(
    /LEVEL_ROUTES\[\s*level\s*\]/.test(layer),
    "classifyFindings looks its route UP in LEVEL_ROUTES rather than re-deciding it in a chain of ifs"
  );
  ok(Object.isFrozen(resume.LEVEL_ROUTES), "the routing table is frozen: importing it is not the same as being able to change it");
  let reRouted = false;
  try {
    // Strict mode, because a silent no-op in sloppy mode would look like a guard and not be one.
    (() => {
      "use strict";
      resume.LEVEL_ROUTES.MINOR = "damage";
    })();
  } catch {
    reRouted = true;
  }
  ok(reRouted, "a process that tries to re-route MINOR into damage at runtime is refused, not quietly allowed");
  same(resume.LEVEL_ROUTES.MINOR, "gap", "and the row is still what the closed table says it is");
  ok(Object.isFrozen(resume.LEVEL_FIX_SIZE), "the size-of-fix table is frozen for the same reason");
  same(
    resume.classifyFindings([finding("MEDIUM", "unexpected-file", "glossary", "02", "glossary.md/stray.txt", "a stray file")]).gaps.map((f) => f.kind),
    ["unexpected-file"],
    "MINOR is still a gap, which is the routing the frozen table declares"
  );

  console.log("  no environment knob; the routing is a table in a closed path");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  await testTheFourBlindKindsAreDamage();
  await testMinorDoesNotOpenTheRun();
  await testNoteAndEvidence();
  await testAPausedStepIsNotABrokenBook();
  testUndeclaredKindFailsClosed();
  await testSeventeenVolumesOneKind();
  await testAChapterNobodyReadIsDamage();
  testNoEnvironmentKnob();
  console.log(`OK: ${checks} checks on what a finding level means to the resume triage.`);
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

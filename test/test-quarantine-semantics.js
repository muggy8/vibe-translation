#!/usr/bin/env node
/**
 * test-quarantine-semantics.js — what a `.rejected` file is allowed to MEAN.
 *
 * The pipeline quarantines through ONE door (`utils/reference-store/quarantine.js`'s
 * `moveArtifactAside`), and three different acts walk through it:
 *
 *   1. the carry-forward guard refused the artifact  → damage, the live file is GONE
 *   2. the acceptance grade refused the artifact     → damage, the live file is GONE
 *   3. a re-render replaced a published artifact     → normal, the live file is PRESENT and graded
 *
 * All three write the same name. So the name cannot carry the difference — the PAIR can: a quarantine
 * whose named artifact is also in the folder is the copy a re-render kept; a quarantine whose named
 * artifact is absent is a gate that refused the volume and left nothing behind it.
 *
 * This suite pins, against the real door and the real readers:
 *   1. a re-rendered volume that passed its grade IS finished for `consistency-audit` and `translate`
 *      (the false positive this slice exists to remove — gotcha 130's lesson in a new place);
 *   2. a carry-forward refusal is NOT finished;
 *   3. a failing acceptance grade is NOT finished;
 *   4. the numbered family (`.rejected.2`, `.rejected.4`) is named as quarantine evidence by the
 *      post-mortem, and is not reported as an unexpected file;
 *   5. every reader of the three exported shapes answers the same question for the numbered family as
 *      for the unnumbered one, and a quarantine is attributed to the step whose artifact it NAMES;
 *   6. `QUARANTINED_DRAFT` (a translation draft kept on purpose, gotcha 39) still does not block.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes, and
 * nothing here reaches a model: `AI_API_KEY` is blank and `AI_BASE_URL` points at a closed port, so a
 * call that was not supposed to happen fails instead of succeeding (gotcha 69).
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const fx = require("./fixture-series");
const prereqs = require("../utils/prereqs");
const artifacts = require("../utils/artifacts");
const postmortem = require("../utils/postmortem");
const resume = require("../utils/resume");
const { moveArtifactAside } = require("../utils/reference-store/quarantine");

const FIXTURES = path.resolve("/tmp/opencode/series-fixtures", "quarantine-semantics");
const DEAD_ENDPOINT = "http://127.0.0.1:1/v1";

/** The three cumulative steps that share `QUARANTINED_CUMULATIVE`. */
const CUMULATIVE_STEPS = ["glossary", "character-voice", "style-guide"];

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
 * A complete two-volume fixture, pointed at this process.
 * @param {string} label
 * @returns {Promise<{dir: string, ledgerDir: string, volumes: Array<{folder: string, installmentNumber: string}>}>}
 */
async function series(label) {
  const built = await fx.completeSeries(label, FIXTURES);
  process.env.SERIES_LOCATION = built.dir;
  process.env.AI_CLIENT_HOOKS_DIR = path.join(FIXTURES, "empty-hooks");
  process.env.AI_API_KEY = "";
  process.env.AI_BASE_URL = DEAD_ENDPOINT;
  process.env.INDEX_RUN_ID = `quarantine-${label}`;
  return built;
}

/**
 * Re-run the pipeline's own door over one fixture artifact, the way a stage does.
 *
 * The rewrite writes the shape the artifact's own declaration asks for, so a re-rendered fixture is a
 * fixture the post-mortem agrees is complete rather than one that fails a shape check by accident.
 *
 * @param {string} volDir
 * @param {string} file
 * @param {boolean} rewrite - Whether the stage writes a fresh artifact after moving the old one aside.
 */
async function runTheDoor(volDir, file, rewrite) {
  const aside = moveArtifactAside(volDir, file);
  ok(aside.ok, `${file}: the shared door moved it (${aside.refusal ? aside.refusal.because : ""})`);
  if (rewrite) {
    let shape = "document";
    for (const spec of Object.values(artifacts.STEP_ARTIFACT_SPECS)) {
      const declared = (spec.volume || []).find((e) => e.name === file);
      if (declared) {
        shape = declared.shape || "document";
        break;
      }
    }
    await fs.promises.writeFile(path.join(volDir, file), fx.contentFor(file, shape), "utf8");
  }
  return aside;
}

/**
 * The post-mortem's findings about one step that mention quarantine evidence or stray files.
 * @param {string} step
 * @param {string} seriesDir
 * @returns {Promise<Array<{kind: string, severity: string, file: string, message: string}>>}
 */
async function quarantineFindings(step, seriesDir) {
  const report = await postmortem.runPostMortem({ step, seriesDir });
  return report.findings.filter((f) => f.kind === "quarantine-present" || f.kind === "unexpected-file");
}

// ─── 1. a re-render is not damage ─────────────────────────────────────────────

/** `npx gulp glossary --force` re-renders, keeps the copy it replaced, and passes its grade. */
async function scenarioReRenderIsFinished() {
  const built = await series("re-render");
  const vol = built.volumes[0];
  const volDir = path.join(built.dir, vol.folder);

  const clean = await prereqs.evaluatePrerequisites({ step: "consistency-audit", seriesDir: built.dir });
  ok(clean.ok, `the control: a complete series passes (${clean.message})`);

  // The door, twice: `.rejected` then `.rejected.2`, exactly as `renderGlossaryArtifact` does it.
  const first = await runTheDoor(volDir, "glossary.md", true);
  same(first.moved && path.basename(first.moved), "glossary.md.rejected", "the first copy goes to .rejected");
  const second = await runTheDoor(volDir, "glossary.md", true);
  same(second.moved && path.basename(second.moved), "glossary.md.rejected.2", "the second goes to .rejected.2");

  // The character-voice stage's own render moves both of its artifacts aside.
  await runTheDoor(volDir, "character-voice.md", true);
  await runTheDoor(volDir, "pov-map.md", true);

  ok(fs.existsSync(path.join(volDir, "glossary.md")), "the live glossary is present");
  ok(fs.existsSync(path.join(volDir, "glossary.md.rejected.2")), "and the kept copies are on disk");

  for (const step of ["consistency-audit", "translate"]) {
    const res = await prereqs.evaluatePrerequisites({ step, seriesDir: built.dir });
    ok(res.ok, `${step} starts on a volume that was re-rendered and passed its grade (${res.message})`);
  }

  // The post-mortem still NAMES the evidence — at a level that does not fail the step — and names it
  // only for the step whose artifact it is.
  const named = {};
  for (const step of CUMULATIVE_STEPS) {
    const findings = await quarantineFindings(step, built.dir);
    named[step] = findings.filter((f) => f.kind === "quarantine-present").map((f) => path.basename(f.file)).sort();
    same(
      findings.filter((f) => f.kind === "unexpected-file").length,
      0,
      `${step}: none of the kept copies is reported as a file that does not belong`
    );
  }
  same(named.glossary, ["glossary.md.rejected", "glossary.md.rejected.2"], "the glossary step names the glossary family");
  same(named["character-voice"], ["character-voice.md.rejected", "pov-map.md.rejected"], "the character-voice step names its own reference and its map");
  same(named["style-guide"], [], "and the style-guide step inherits neither — one leftover is not three unfinished steps");

  const glossaryReport = await postmortem.runPostMortem({ step: "glossary", seriesDir: built.dir });
  ok(glossaryReport.counts.HIGH === 0, `a re-rendered volume is not a HIGH step (${JSON.stringify(glossaryReport.counts)})`);

  console.log("  1. re-render + kept copies + passing grade: finished for consistency-audit and translate, evidence named, 0 HIGH");
}

// ─── 2. the carry-forward guard refused the artifact ──────────────────────────

/** `quarantineDamagedGlossary` moves the file aside and does NOT write a new one. */
async function scenarioCarryForwardRefusal() {
  const built = await series("carry-forward");
  const vol = built.volumes[0];
  const volDir = path.join(built.dir, vol.folder);

  await runTheDoor(volDir, "glossary.md", false);
  ok(!fs.existsSync(path.join(volDir, "glossary.md")), "the live glossary is gone — that is what the guard is for");
  ok(fs.existsSync(path.join(volDir, "glossary.md.rejected")), "and the damaged file is kept beside the gap");

  for (const step of ["consistency-audit", "translate"]) {
    const res = await prereqs.evaluatePrerequisites({ step, seriesDir: built.dir });
    ok(!res.ok, `${step} refuses a volume whose glossary a guard removed (${res.message})`);
    ok(res.message.includes("glossary.md"), `the refusal names the missing artifact (${res.message})`);
    ok(res.message.includes("glossary.md.rejected"), `and names the gate's own evidence (${res.message})`);
  }

  const findings = await quarantineFindings("glossary", built.dir);
  const hit = findings.find((f) => f.kind === "quarantine-present" && /glossary\.md\.rejected$/.test(f.file));
  ok(hit, "the post-mortem names the quarantine");
  same(hit.severity, "HIGH", "with nothing standing in its place it is still HIGH");

  // A SECOND refusal of the same volume behaves the same way — the numbered family is not a loophole.
  const again = await series("carry-forward-numbered");
  const againDir = path.join(again.dir, again.volumes[0].folder);
  await runTheDoor(againDir, "glossary.md", true);
  await runTheDoor(againDir, "glossary.md", false);
  ok(fs.existsSync(path.join(againDir, "glossary.md.rejected.2")), "the second refusal is kept as .rejected.2");
  const refused = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: again.dir });
  ok(!refused.ok, "a numbered refusal blocks completion exactly like an unnumbered one");
  ok(refused.message.includes("glossary.md.rejected.2"), `and names it (${refused.message})`);

  console.log("  2. carry-forward refusal: not finished, unnumbered or numbered, and the evidence is named at HIGH");
}

// ─── 3. the acceptance grade refused the artifact ─────────────────────────────

/** `quarantineGlossaryArtifact` / `quarantineAssembledArtifacts`: the grade failed, the file goes aside. */
async function scenarioFailingGrade() {
  const built = await series("failing-grade");
  const vol = built.volumes[0];
  const volDir = path.join(built.dir, vol.folder);

  await runTheDoor(volDir, "glossary.md", false);
  await fs.promises.writeFile(
    path.join(volDir, "glossary-validation-rolling-state.json"),
    JSON.stringify({ results: [40, 55], acceptedBy: "rolling-window" }, null, 2),
    "utf8"
  );

  const res = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: built.dir });
  ok(!res.ok, "a volume whose acceptance window never met the criterion is not complete");
  ok(res.message.includes("no passing acceptance grade"), res.message);

  // The grade alone, with the artifact still standing: the ON_QA_LIMIT=accept shape.
  const accepted = await series("failing-grade-artifact-kept");
  const acceptedDir = path.join(accepted.dir, accepted.volumes[0].folder);
  await fs.promises.writeFile(
    path.join(acceptedDir, "glossary-validation-rolling-state.json"),
    JSON.stringify({ results: [40, 55], acceptedBy: "rolling-window" }, null, 2),
    "utf8"
  );
  const still = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: accepted.dir });
  ok(!still.ok, "a present artifact with an unaccepted window is still not complete");
  ok(still.message.includes("no passing acceptance grade"), still.message);

  // The character-voice stage quarantines BOTH of its artifacts on a failing grade.
  const voice = await series("failing-grade-voice");
  const voiceDir = path.join(voice.dir, voice.volumes[0].folder);
  await runTheDoor(voiceDir, "character-voice.md", false);
  await runTheDoor(voiceDir, "pov-map.md", false);
  const voiceRes = await prereqs.evaluatePrerequisites({ step: "consistency-audit", seriesDir: voice.dir });
  ok(!voiceRes.ok, "a character-voice volume quarantined by its grade is not complete");
  ok(voiceRes.message.includes("character-voice.md"), voiceRes.message);
  ok(voiceRes.message.includes("pov-map.md"), `and the map is named too (${voiceRes.message})`);

  console.log("  3. failing grade: not finished, with the artifact gone or kept, and both voice artifacts named");
}

// ─── 4. the numbered family is evidence, not a stray ──────────────────────────

/** `glossary.md.rejected.2`, `character-voice.md.rejected.4`, `pov-map.md.rejected.4` are named, not stray. */
async function scenarioNumberedFamilyIsNamed() {
  const built = await series("numbered-family");
  const volDir = path.join(built.dir, built.volumes[0].folder);

  // Build the family through the real door: four rejections of the voice reference, two of the glossary,
  // four of the map — the shape `rebuild-voice --apply --move-aside` and `pov-map.js` leave behind.
  for (let i = 0; i < 4; i++) await runTheDoor(volDir, "character-voice.md", true);
  for (let i = 0; i < 2; i++) await runTheDoor(volDir, "glossary.md", true);
  for (let i = 0; i < 4; i++) await runTheDoor(volDir, "pov-map.md", true);

  for (const name of ["character-voice.md.rejected.4", "glossary.md.rejected.2", "pov-map.md.rejected.4"]) {
    ok(fs.existsSync(path.join(volDir, name)), `${name} is on the disk`);
    ok(artifacts.isKnownVolumeFile(name), `${name} is a known volume file, not a stray`);
  }

  const byStep = {};
  for (const step of CUMULATIVE_STEPS) {
    const findings = await quarantineFindings(step, built.dir);
    byStep[step] = findings.filter((f) => f.kind === "quarantine-present").map((f) => path.basename(f.file)).sort();
    same(
      findings.filter((f) => f.kind === "unexpected-file").length,
      0,
      `${step}: the numbered family is not reported as an unexpected file`
    );
  }
  same(byStep.glossary, ["glossary.md.rejected", "glossary.md.rejected.2"], "the glossary step names exactly the glossary family");
  same(
    byStep["character-voice"],
    ["character-voice.md.rejected", "character-voice.md.rejected.2", "character-voice.md.rejected.3", "character-voice.md.rejected.4", "pov-map.md.rejected", "pov-map.md.rejected.2", "pov-map.md.rejected.3", "pov-map.md.rejected.4"],
    "the character-voice step names its own reference AND the map it publishes"
  );
  same(byStep["style-guide"], [], "the style-guide step does not inherit either of them");

  // Every named quarantine is at the same severity, numbered or not.
  const report = await postmortem.runPostMortem({ step: "character-voice", seriesDir: built.dir });
  const severities = new Set(
    report.findings.filter((f) => f.kind === "quarantine-present").map((f) => f.severity)
  );
  same(severities.size, 1, `one severity for the whole family (${JSON.stringify([...severities])})`);

  console.log("  4. numbered family: named as quarantine evidence by its owning step, never as a stray file");
}

// ─── 5. every reader answers the same question ────────────────────────────────

/** The three exported shapes, and each door that reads them, agree on numbered and unnumbered. */
async function scenarioEveryReader() {
  const built = await series("readers");
  const vol = built.volumes[0];
  const volDir = path.join(built.dir, vol.folder);
  const installment = vol.installmentNumber;

  const CUMULATIVE = artifacts.STEP_ARTIFACT_SPECS.glossary.quarantines[0];
  const DRAFT = artifacts.STEP_ARTIFACT_SPECS.translate.quarantines[0];

  // Reader 1 — `QUARANTINED_CUMULATIVE.pattern`, matched by the post-mortem, prereqs and resume.
  for (const name of ["glossary.md.rejected", "glossary.md.rejected.2", "character-voice.md.rejected.4", "pov-map.md.rejected.4", "style-guide.md.rejected.7"]) {
    ok(CUMULATIVE.pattern.test(name), `the cumulative pattern matches ${name}`);
  }
  for (const name of ["glossary.md", "glossary.md.rejected.md", "character-voice.md-audit.md", "pov-map.md-audit.md", "translation-ch3.rejected.md"]) {
    ok(!CUMULATIVE.pattern.test(name), `and does not match ${name}`);
  }

  // Reader 2 — `QUARANTINED_DRAFT` is unchanged, and still does not block.
  for (const name of ["translation-ch3.rejected.md", "translation-ch3.rejected-passage.md"]) {
    ok(DRAFT.pattern.test(name), `the draft pattern matches ${name}`);
    ok(!CUMULATIVE.pattern.test(name), `and only the draft pattern matches ${name}`);
  }
  same(DRAFT.severity, "MEDIUM", "a kept draft is MEDIUM (gotcha 39)");

  // Reader 3 — `KNOWN_VOLUME_FILE_PATTERNS` / `isKnownVolumeFile`.
  for (const name of ["glossary.md.rejected", "glossary.md.rejected.2", "pov-map.md.rejected.4", "translation-ch3.rejected.md", "translation-ch3.rejected-passage.md", ".gitignore"]) {
    ok(artifacts.isKnownVolumeFile(name), `${name} is legitimate`);
  }
  ok(!artifacts.isKnownVolumeFile("notes-from-a-previous-agent.md"), "and a stray is still a stray");

  // Reader 4 — `resume.quarantineBelongsToStep`: attributed to the artifact it NAMES.
  for (const [name, owner] of [
    ["glossary.md.rejected", "glossary"],
    ["glossary.md.rejected.2", "glossary"],
    ["character-voice.md.rejected", "character-voice"],
    ["character-voice.md.rejected.4", "character-voice"],
    ["pov-map.md.rejected", "character-voice"],
    ["pov-map.md.rejected.4", "character-voice"],
    ["style-guide.md.rejected", "style-guide"],
    ["style-guide.md.rejected.9", "style-guide"],
  ]) {
    for (const step of CUMULATIVE_STEPS) {
      const expected = step === owner;
      same(
        resume.quarantineBelongsToStep(step, name, installment),
        expected,
        `${name} belongs to ${owner}, not to ${step}`
      );
    }
  }

  // Reader 5 — `prereqs.quarantineBlocksCompletion`, with the folder it is judging.
  const glossarySpec = artifacts.STEP_ARTIFACT_SPECS.glossary;
  const translateSpec = artifacts.STEP_ARTIFACT_SPECS.translate;
  /** A folder where the glossary is standing, and one where a guard removed it. */
  const rebuilt = new Set(["glossary.md", "glossary.md.rejected", "glossary.md.rejected.2"]);
  const refused = new Set(["glossary-validation.md", "glossary.md.rejected", "glossary.md.rejected.2"]);

  ok(
    prereqs.quarantineBlocksCompletion(CUMULATIVE, { name: "glossary.md.rejected", spec: glossarySpec, installment, presentNames: refused }),
    "a cumulative quarantine whose artifact is absent blocks completion"
  );
  ok(
    prereqs.quarantineBlocksCompletion(CUMULATIVE, { name: "glossary.md.rejected.2", spec: glossarySpec, installment, presentNames: refused }),
    "and the numbered one blocks exactly the same way"
  );
  ok(
    !prereqs.quarantineBlocksCompletion(CUMULATIVE, { name: "glossary.md.rejected", spec: glossarySpec, installment, presentNames: rebuilt }),
    "the same file beside the artifact it names does not — that is a re-render, not a refusal"
  );
  ok(
    !prereqs.quarantineBlocksCompletion(CUMULATIVE, { name: "glossary.md.rejected.2", spec: glossarySpec, installment, presentNames: rebuilt }),
    "numbered or not"
  );
  ok(
    !prereqs.quarantineBlocksCompletion(CUMULATIVE, { name: "character-voice.md.rejected.4", spec: glossarySpec, installment, presentNames: refused }),
    "and it is not glossary's gate: character-voice.md.rejected.4 belongs to the step that declares character-voice.md"
  );
  ok(
    !prereqs.quarantineBlocksCompletion(DRAFT, {
      name: "translation-ch3.rejected.md",
      spec: translateSpec,
      installment,
      presentNames: new Set(["translation-ch3.rejected.md", "translation.md", "translation-state.json"]),
    }),
    "a kept draft does not block completion (gotcha 39)"
  );

  // Reader 6 — the inventory the triage reads: numbered and unnumbered both counted, both attributed.
  const invDir = path.join(built.dir, vol.folder);
  await fs.promises.writeFile(path.join(invDir, "character-voice.md.rejected.4"), "evidence\n", "utf8");
  await fs.promises.writeFile(path.join(invDir, "pov-map.md.rejected.4"), "evidence\n", "utf8");
  const inv = resume.inventoryVolume(built.dir, vol);
  ok(inv.quarantines.includes("character-voice.md.rejected.4"), "the inventory counts the numbered family");
  ok(inv.quarantinedForStep.includes("character-voice"), "and attributes it to the step whose artifact it names");

  console.log("  5. six readers of the three shapes: numbered and unnumbered answer identically, and each file belongs to one step");
}

// ─── 6. a kept draft still does not block ─────────────────────────────────────

/** `translation-<id>.rejected.md` is kept ON PURPOSE so `retranslate` has something to repair. */
async function scenarioDraftStillAllowed() {
  const built = await series("kept-draft");
  const volDir = path.join(built.dir, built.volumes[0].folder);
  await fs.promises.writeFile(path.join(volDir, "translation-ch3.rejected.md"), "the draft a later round repaired\n", "utf8");
  await fs.promises.writeFile(path.join(volDir, "translation-ch3.rejected-passage.md"), "the passage that failed\n", "utf8");

  for (const step of ["translate-qa", "polish"]) {
    const res = await prereqs.evaluatePrerequisites({ step, seriesDir: built.dir });
    ok(res.ok, `a kept-and-repaired draft does not block ${step} (${res.message})`);
  }

  const findings = await quarantineFindings("polish", built.dir);
  const drafts = findings.filter((f) => f.kind === "quarantine-present");
  same(drafts.length, 2, "and the post-mortem still names both halves of the kept draft");
  for (const f of drafts) same(f.severity, "MEDIUM", `${f.file}: a kept draft is MEDIUM, not HIGH`);

  console.log("  6. QUARANTINED_DRAFT: named at MEDIUM, blocks nothing");
}

// ─── run ──────────────────────────────────────────────────────────────────────

(async () => {
  await fs.promises.mkdir(FIXTURES, { recursive: true });
  await scenarioReRenderIsFinished();
  await scenarioCarryForwardRefusal();
  await scenarioFailingGrade();
  await scenarioNumberedFamilyIsNamed();
  await scenarioEveryReader();
  await scenarioDraftStillAllowed();
  console.log(`quarantine semantics: ${checks} checks, 0 model calls.`);
})().catch((err) => {
  console.error("FAIL:", err && err.message ? err.message : err);
  process.exit(1);
});

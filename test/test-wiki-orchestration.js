/**
 * test-wiki-orchestration.js — the wiki task's own guarantees, offline.
 *
 * test-qa-orchestration.js pins the SHARED loop (utils/qa-loop.js) through
 * character-voice. What lives here is the part of jump-in-wiki.js that is NOT
 * the shared loop, because that is where this task differs from the other three
 * — and it is the task that was silently broken (finding 6 of PIPELINE-REVIEW:
 * every volume threw, and the failure was logged and swallowed).
 *
 *   1. TWO-TIER IDEMPOTENCY. If wiki.md + shared-wiki.md already hold real text,
 *      generation is skipped and the volume goes straight to validation (the
 *      expensive half is not repeated). If a persisted, accepted rolling-state
 *      file covers the current source, the whole volume is skipped.
 *   2. A STUB IS NOT A WIKI. A crashed run leaves scaffold stubs. A plain
 *      fileExists() check used to treat them as a finished wiki and publish
 *      "(stub — the agent replaces this…)" as the volume's wiki. Now a surviving
 *      stub fails the volume.
 *   3. THE SESSION SHAPE. The wiki reuses ONE author session for generation and
 *      every feedback pass (the other three tasks use a fresh author per
 *      feedback iteration), while the validator is a FRESH agent every iteration.
 *   4. THE CUMULATIVE CASCADE + THE ROOT COPY (spawned child). Regenerating any
 *      volume regenerates every LATER volume even when its own state says
 *      "accepted" — and the series-root shared-wiki.md is the LAST EXISTING
 *      volume's copy, so a partially failed run publishes the last good one
 *      rather than nothing, while still failing the run.
 *
 * No network, no real endpoint. Run with `npm test`.
 */
require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

// Pin the acceptance config so the scenarios are deterministic regardless of the
// local .env. ACCEPTANCE_EXCEPTIONAL_SCORE=100 keeps the exceptional-consensus
// fast-accept path out of the scenarios below (it is pinned in test-qa-orchestration).
process.env.PASSING_SCORE = "70";
process.env.ACCEPTANCE_PASSING_SCORE = "70";
process.env.ACCEPTANCE_WINDOW_SIZE = "2";
process.env.ACCEPTANCE_EXCEPTIONAL_SCORE = "100";
// Pinned OFF so the scenarios below keep exercising the rolling-window route (a
// passing first grade still earns its second sample through a feedback round).
// The "a passing grade earns its samples by re-grading" path is the shared loop's
// (utils/qa-loop.js) and is pinned in test-qa-orchestration.js; what is pinned
// HERE is that the wiki reaches it too — see childPassingConsensus.
process.env.ACCEPTANCE_CONFIRM_ON_PASSING =
  (process.argv.find((a) => a.startsWith("--child=")) || "") === "--child=passing" ? "true" : "false";
process.env.QA_MAX_ITERATIONS = "4";
process.env.ON_QA_LIMIT = "accept";
process.env.ON_VOLUME_ERROR = "skip";
process.env.ON_MISSING_PREVIOUS = "skip";
// The task's own entry gate (validateRequiredEnv) demands a key even when every model call
// below is stubbed. Pinned here rather than inherited: a test must run the same way with no
// `.env` in the repo at all (a fresh clone, or a container), and it must never depend on
// whatever the local `.env` happens to set.
process.env.AI_API_KEY = "offline-test-key-not-a-real-endpoint";

const childScenario = process.argv.find((a) => a.startsWith("--child="))?.replace("--child=", "") || null;

// A spawned child runs a WHOLE task, and a task module captures both
// SERIES_LOCATION and `getTranslationTarget` when it is first required. So the
// temp series and the intake stub must exist BEFORE the task module is loaded —
// requiring it first is how you get a task quietly pointed at the fixture.
const gtt = require("../get-translation-target");
/** The manifest the stubbed intake step returns (a child only). */
let childManifest = null;
if (childScenario) {
  const series = makeSeries();
  process.env.SERIES_LOCATION = series.seriesDir;
  process.env.SERIES_ARTIFACTS_DIR = series.seriesDir;
  childManifest = series.manifest;
  gtt.getTranslationTarget = async () => childManifest;
}

const harness = require("../harness");
const wiki = require("../jump-in-wiki");
const { loadRollingState, isAcceptedState, isSourceStale } = require("../configs/shared");

// ─── Scenario plumbing ───────────────────────────────────────────────────────

/** The current scenario's behavior script. */
let script = null;
/** Which volume folder the current scenario's agents write into. */
let currentVolumeDir = null;
/** Every agent turn the scenario saw: {name, label, prompt}. */
let agentTurns = [];
/** Every one-shot call: {label}. */
let oneShotCalls = [];

/**
 * Install the harness stubs. Agent handles record their turns so a scenario can
 * assert WHICH session a pass ran in; the stubs write real files so the
 * deterministic gates (assertWrote / assertRealOutput / the rolling window) run
 * unmodified.
 */
function installStubs() {
  harness.createGatedFsTools = async () => ({ tools: {}, approve: async () => true });
  harness.createAgentHandle = async (cfg) => {
    const turns = [];
    return {
      name: cfg.name,
      turns,
      async sendTurn(prompt, opts) {
        const entry = {
          name: cfg.name,
          label: (opts && opts.label) || "",
          prompt,
          turn: turns.length,
          volumeDir: currentVolumeDir,
          maxSteps: cfg.maxSteps,
        };
        turns.push(entry);
        agentTurns.push(entry);
        return script.agent(cfg.name, entry);
      },
      async close() {},
    };
  };
  harness.runOneShot = async (cfg) => {
    oneShotCalls.push({ label: cfg.label || "" });
    return script.oneShot(cfg.label || "");
  };
}

/** Fresh temp series with one plain-text volume. */
function makeVolumeDir(installment = "01") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-wiki-"));
  const folder = `Book(${installment})`;
  const volumeDir = path.join(root, folder);
  fs.mkdirSync(volumeDir, { recursive: true });
  const sourceFile = path.join(volumeDir, `${folder}.md`);
  fs.writeFileSync(sourceFile, `# Chapter\n\nBody text for ${folder}. 本文テキスト。\n`, "utf8");
  return { root, folder, volumeDir, sourceFile };
}

/** The volume context runVolumeAgent needs (whole mode). */
function makeCtx(v, { installment = "01", wikiAndSharedWikiExists = false, previousFolderName = null } = {}) {
  const values = { INSTALLMENT_NUMBER: installment, SOURCE_NAME: "Book", SOURCE_LANGUAGE: "Japanese" };
  return {
    values,
    folderName: v.folder,
    volumeDir: v.volumeDir,
    sourceFile: v.sourceFile,
    bundle: {
      format: "txt",
      wholePath: v.sourceFile,
      originalPath: v.sourceFile,
      segments: [],
      wholeChars: 40,
      sourceFingerprint: `fp-${installment}`,
    },
    chunked: false,
    wikiOutputFile: path.join(v.volumeDir, "wiki.md"),
    sharedWikiOutputFile: path.join(v.volumeDir, "shared-wiki.md"),
    validationOutputFile: path.join(v.volumeDir, `jump-in-wiki-validation-${installment}.md`),
    isFirst: previousFolderName === null,
    previousFolderName,
    previousWikiOutputFile: previousFolderName ? path.join(v.root, previousFolderName, "wiki.md") : null,
    previousSharedWikiOutputFile: previousFolderName ? path.join(v.root, previousFolderName, "shared-wiki.md") : null,
    userPrompt: "Write the wiki.",
    validatorUserPrompt: "Validate the wiki.",
    feedbackUserPrompt: "Apply the findings.",
    acceptanceUserPrompt: "Score the wiki.",
    systemPrompt: "You are the wiki author.",
    validatorSystemPrompt: "You are the wiki validator.",
    feedbackSystemPrompt: "You are the wiki author.",
    acceptanceSystemPrompt: "You are a grader.",
    wikiAndSharedWikiExists,
    glossaryFile: null,
  };
}

/** Real wiki text (NOT a stub) — what hasRealOutput accepts. */
function writeWiki(volumeDir, marker) {
  fs.writeFileSync(path.join(volumeDir, "wiki.md"), `# Volume Wiki (${marker})\n\nReal wiki text.\n`, "utf8");
  fs.writeFileSync(path.join(volumeDir, "shared-wiki.md"), `# Shared Wiki (${marker})\n\nReal shared state.\n`, "utf8");
}

/** The scaffold stubs a crashed run leaves behind. */
function writeStubs(volumeDir, installment) {
  fs.writeFileSync(
    path.join(volumeDir, "wiki.md"),
    `(stub — the agent replaces this with the complete volume wiki for volume ${installment})\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(volumeDir, "shared-wiki.md"),
    `(stub — the agent replaces this with the complete shared wiki)\n`,
    "utf8"
  );
}

function writeValidationReport(volumeDir, installment, marker) {
  fs.writeFileSync(
    path.join(volumeDir, `jump-in-wiki-validation-${installment}.md`),
    `# Validation Report (${marker})\n\nFinal recommendation: Pass\n`,
    "utf8"
  );
}

/**
 * Default script: the author writes both wiki files, the validator writes the
 * report, the acceptance one-shot answers from a scripted list.
 */
function makeScript(acceptanceReplies, { authorWrites = true } = {}) {
  let i = 0;
  return {
    agent(name, entry) {
      const volumeDir = entry.volumeDir;
      if (name.startsWith("wiki-author-")) {
        if (authorWrites) writeWiki(volumeDir, entry.label);
        return { text: "wrote both files", toolCalls: [{ toolName: "writeFile" }] };
      }
      if (name.startsWith("wiki-validator-")) {
        writeValidationReport(volumeDir, name.match(/wiki-validator-(\d{2})/)[1], entry.label);
        return { text: "wrote the report", toolCalls: [{ toolName: "writeFile" }] };
      }
      throw new Error(`Unexpected agent handle: ${name}`);
    },
    oneShot(label) {
      if (!label.startsWith("jump-in-wiki-acceptance-")) throw new Error(`Unexpected one-shot: ${label}`);
      const reply = acceptanceReplies[Math.min(i, acceptanceReplies.length - 1)];
      i += 1;
      return reply;
    },
  };
}

const pass = (score) => JSON.stringify({ score, band: score >= 85 ? "Pass" : "Pass with minor edits", note: "fixture" });

// ─── 1. Generation is skipped when a real wiki already exists ────────────────

async function scenarioGenerationSkipped() {
  const v = makeVolumeDir();
  writeWiki(v.volumeDir, "previous run");
  script = makeScript([pass(88)]);
  agentTurns = [];
  oneShotCalls = [];
  currentVolumeDir = v.volumeDir;
  try {
    await wiki.runVolumeAgent(makeCtx(v, { wikiAndSharedWikiExists: true }));

    const generate = agentTurns.filter((t) => t.label.startsWith("jump-in-wiki-generate-"));
    assert.strictEqual(generate.length, 0, "an existing real wiki must not be regenerated — the expensive half is the generation pass");
    assert.ok(
      agentTurns.some((t) => t.label.startsWith("jump-in-wiki-validate-")),
      "but the volume is still validated"
    );
    assert.ok(
      oneShotCalls.some((c) => c.label.startsWith("jump-in-wiki-acceptance-")),
      "and scored"
    );
    assert.ok(
      !fs.readFileSync(path.join(v.volumeDir, "wiki.md"), "utf8").includes("stub"),
      "the volume still ends with real wiki text (never a scaffold stub)"
    );
    assert.ok(
      agentTurns.some((t) => t.name === "wiki-author-01" && t.label.startsWith("jump-in-wiki-feedback-")),
      "a sub-passing first grade sends the volume through feedback — applied by the same author session, not by a fresh generation pass"
    );
  } finally {
    currentVolumeDir = null;
    fs.rmSync(v.root, { recursive: true, force: true });
  }
}

// ─── 2. A surviving scaffold stub fails the volume instead of shipping ───────

async function scenarioStubIsNotAnArtifact() {
  const v = makeVolumeDir();
  writeStubs(v.volumeDir, "01");
  // The agent makes a real tool call but produces no content: the files stay stubs.
  script = {
    agent: () => ({ text: "", toolCalls: [{ toolName: "writeFile" }] }),
    oneShot: () => pass(88),
  };
  agentTurns = [];
  currentVolumeDir = v.volumeDir;
  const previousRecovery = process.env.AGENT_RECOVERY_ENABLED;
  process.env.AGENT_RECOVERY_ENABLED = "false";
  try {
    let err = null;
    try {
      await wiki.runVolumeAgent(makeCtx(v));
    } catch (e) {
      err = e;
    }
    assert.ok(err, "a volume whose author produced nothing is a failure, not an artifact");
    assert.ok(/stub/i.test(err.message), `the error names the stub left on disk: ${err.message}`);
    assert.ok(
      fs.readFileSync(path.join(v.volumeDir, "wiki.md"), "utf8").includes("stub"),
      "the stub is still there (the run did not quietly overwrite it with something else)"
    );
  } finally {
    currentVolumeDir = null;
    if (previousRecovery === undefined) delete process.env.AGENT_RECOVERY_ENABLED;
    else process.env.AGENT_RECOVERY_ENABLED = previousRecovery;
    fs.rmSync(v.root, { recursive: true, force: true });
  }
}

// ─── 3. One author session for generation + feedback; a fresh validator each time ─

async function scenarioSessionShape() {
  const v = makeVolumeDir();
  // Fail the window once (window size 2 → two sub-passing grades), then pass.
  script = makeScript([pass(50), pass(52), pass(90)]);
  agentTurns = [];
  currentVolumeDir = v.volumeDir;
  try {
    await wiki.runVolumeAgent(makeCtx(v));

    const authors = agentTurns.filter((t) => t.name === "wiki-author-01");
    const generate = authors.filter((t) => t.label.startsWith("jump-in-wiki-generate-"));
    const feedback = authors.filter((t) => t.label.startsWith("jump-in-wiki-feedback-"));
    assert.strictEqual(generate.length, 1, "one generation turn");
    assert.ok(feedback.length >= 1, "the feedback pass ran on the SAME author handle (the wiki keeps its session)")
    assert.ok(
      feedback.length >= 1 && authors.length === generate.length + feedback.length,
      "and no second author session was created for feedback"
    );

    const validatorNames = new Set(agentTurns.filter((t) => t.name.startsWith("wiki-validator-")).map((t) => t.name));
    assert.ok(validatorNames.size >= 2, `a FRESH validator agent per iteration (saw: ${[...validatorNames].join(", ")})`);
    assert.ok(
      !agentTurns.some((t) => t.name.startsWith("wiki-validator-") && t.label.startsWith("jump-in-wiki-feedback-")),
      "the validator never applies the feedback"
    );

    // The accepted window is persisted, so a re-run skips the volume with no AI call.
    const stateFile = path.join(v.volumeDir, "jump-in-wiki-validation-01-rolling-state.json");
    assert.ok(fs.existsSync(stateFile), "the rolling-window state is written on the accepting iteration too");
    const state = await loadRollingState(stateFile);
    assert.ok(state, "and it is readable");
    assert.ok(isAcceptedState(state), "and it records an accepted decision");
    assert.strictEqual(isSourceStale(state, makeCtx(v).bundle), false, "the source fingerprint still matches");
  } finally {
    currentVolumeDir = null;
    fs.rmSync(v.root, { recursive: true, force: true });
  }
}

// ─── 3b. The chapter-by-chapter wiki path (the shared chunked QA loop) ───────
// The fallback path for a volume too large for one pass. It is where the wiki
// used to differ from the other three tasks in ways nobody chose: its
// per-chapter validators got no recovery turn and no "did it actually write?"
// stop, it re-implemented its own grader, and its findings merger ran under the
// flat step cap that a many-chapter volume outgrows. These scenarios pin the
// shared behaviour the wiki now shares.

/** The volume context runChunkedVolumeAgent needs: a bundle cut into chapters. */
function makeChunkedCtx(v, installment = "01") {
  const ctx = makeCtx(v, { installment });
  const segments = ["ch1", "ch2", "ch3"].map((id, i) => ({
    id,
    file: `book-${id}.md`,
    title: `Chapter ${i + 1}`,
    bodyChars: 40,
  }));
  for (const s of segments) {
    fs.writeFileSync(path.join(v.volumeDir, s.file), `# ${s.title}\n\nBody text for ${s.id}. 本文テキスト。\n`, "utf8");
  }
  fs.writeFileSync(path.join(v.volumeDir, "book-whole.md"), "# Whole\n\n" + "Body. ".repeat(120), "utf8");
  ctx.chunked = true;
  ctx.bundle = {
    ...ctx.bundle,
    format: "epub",
    segments,
    wholeChars: 120,
    wholePath: path.join(v.volumeDir, "book-whole.md"),
  };
  return ctx;
}

/**
 * The scripted agents of the chapter-by-chapter path: a section author per
 * chapter, one merge agent, a validator per chapter, one findings merger, and a
 * feedback author per chapter.
 * @param {string[]} acceptanceReplies
 * @param {{validatorsWrite?: boolean, feedbackWrites?: boolean}} [behaviour]
 * @returns {{agent: (name: string, entry: Object) => {text: string, toolCalls: Object[]}, oneShot: (label: string) => string}}
 */
function makeChunkedScript(acceptanceReplies, behaviour = {}) {
  const { validatorsWrite = true, feedbackWrites = true } = behaviour;
  let i = 0;
  return {
    agent(name, entry) {
      const volumeDir = entry.volumeDir;
      if (name.startsWith("wiki-section-")) {
        const id = name.split("-").pop();
        fs.writeFileSync(
          path.join(volumeDir, `wiki-${id}.md`),
          `# Wiki section (${entry.label})\n\nReal section text for ${id}.\n`,
          "utf8"
        );
        return { text: "wrote the section", toolCalls: [{ toolName: "writeFile" }] };
      }
      if (name.startsWith("wiki-merge-")) {
        writeWiki(volumeDir, entry.label);
        return { text: "wrote both files", toolCalls: [{ toolName: "writeFile" }] };
      }
      if (name.startsWith("wiki-validator-merge-")) {
        writeValidationReport(volumeDir, "01", entry.label);
        return { text: "wrote the report", toolCalls: [{ toolName: "writeFile" }] };
      }
      if (name.startsWith("wiki-validator-")) {
        const id = name.split("-").pop();
        if (validatorsWrite) {
          fs.writeFileSync(
            path.join(volumeDir, `jump-in-wiki-validation-01-${id}.md`),
            `# Validation partial (${entry.label})\n\nFINDING [LOW] chapters=${id} — a finding the merger consolidates.\n`,
            "utf8"
          );
          return { text: "wrote the partial", toolCalls: [{ toolName: "writeFile" }] };
        }
        return { text: "", toolCalls: [{ toolName: "readFile" }] };
      }
      if (name.startsWith("wiki-feedback-")) {
        if (feedbackWrites) {
          fs.appendFileSync(path.join(volumeDir, "wiki.md"), "\nA correction the feedback pass applied.\n", "utf8");
        }
        return { text: "", toolCalls: [{ toolName: "readFile" }] };
      }
      throw new Error(`Unexpected agent handle: ${name}`);
    },
    oneShot(label) {
      if (!label.startsWith("jump-in-wiki-acceptance-")) throw new Error(`Unexpected one-shot: ${label}`);
      const reply = acceptanceReplies[Math.min(i, acceptanceReplies.length - 1)];
      i += 1;
      return reply;
    },
  };
}

async function scenarioChunkedWikiFlow() {
  const v = makeVolumeDir();
  script = makeChunkedScript([pass(88), pass(90)]);
  agentTurns = [];
  oneShotCalls = [];
  currentVolumeDir = v.volumeDir;
  try {
    await wiki.runChunkedVolumeAgent(makeChunkedCtx(v));

    const sections = agentTurns.filter((t) => t.name.startsWith("wiki-section-"));
    assert.strictEqual(
      new Set(sections.map((t) => t.name)).size,
      3,
      "one section author per chapter, each in its own session"
    );
    assert.ok(agentTurns.some((t) => t.name === "wiki-merge-01"), "the chapter sections are merged into the wiki");
    assert.ok(
      fs.readFileSync(path.join(v.volumeDir, "wiki.md"), "utf8").includes("Real wiki text"),
      "and the merged wiki is real text, not the stub the merge pass was anchored on"
    );

    const validators = agentTurns.filter((t) => t.name.startsWith("wiki-validator-") && !t.name.startsWith("wiki-validator-merge-"));
    assert.ok(validators.length >= 3, "a validator per chapter");
    for (const id of ["ch1", "ch2", "ch3"]) {
      assert.ok(
        fs.existsSync(path.join(v.volumeDir, `jump-in-wiki-validation-01-${id}.md`)),
        `chapter ${id} left its own validation partial`
      );
    }
    assert.ok(
      agentTurns.some((t) => t.name.startsWith("wiki-validator-merge-")),
      "and a findings-merge agent consolidated them into the standard report"
    );

    // The grading is the shared wikiAcceptanceCheck — the same call the
    // whole-installment path makes, under the same label.
    assert.ok(
      oneShotCalls.some((c) => c.label === "jump-in-wiki-acceptance-01-1"),
      "the chapter-by-chapter loop grades through the shared acceptance check"
    );

    const mergeTurn = agentTurns.find((t) => t.name.startsWith("wiki-validator-merge-"));
    assert.ok(
      mergeTurn.maxSteps > 20,
      `the findings merger's step cap scales with the partials it must read (got ${mergeTurn.maxSteps}; a flat 20 lost a whole validation round on a 10-chapter volume)`
    );
  } finally {
    currentVolumeDir = null;
    fs.rmSync(v.root, { recursive: true, force: true });
  }
}

/**
 * A chapter validator that wrote nothing is re-sent the task once, and then the
 * volume fails. Before the shared loop, the wiki had neither half of this: the
 * hole in the report was merged and graded anyway.
 */
async function scenarioChunkedValidatorWritesNothing() {
  const v = makeVolumeDir();
  script = makeChunkedScript([pass(88)], { validatorsWrite: false });
  agentTurns = [];
  currentVolumeDir = v.volumeDir;
  try {
    await assert.rejects(
      () => wiki.runChunkedVolumeAgent(makeChunkedCtx(v)),
      /never wrote real output/,
      "a chapter validator that produced nothing fails the volume instead of leaving a hole in the report"
    );
    assert.ok(
      agentTurns.some((t) => t.label.startsWith("jump-in-wiki-validate-recovery-")),
      "after the task was re-sent to the same validator agent"
    );
    assert.ok(
      !agentTurns.some((t) => t.name.startsWith("wiki-validator-merge-")),
      "and the loop never went on to consolidate partials it does not have"
    );
  } finally {
    currentVolumeDir = null;
    fs.rmSync(v.root, { recursive: true, force: true });
  }
}

// ─── 4. Task-level: the cascade + the last-existing root copy (spawned) ──────

/**
 * A temp series with two plain-text volumes and the manifest the intake step
 * would have produced.
 */
function makeSeries() {
  const seriesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-wikitask-"));
  const volumes = [];
  for (const [folder, installment] of [["Book(01)", "01"], ["Book(02)", "02"]]) {
    const volumeDir = path.join(seriesDir, folder);
    fs.mkdirSync(volumeDir, { recursive: true });
    fs.writeFileSync(path.join(volumeDir, `${folder}.md`), `# Chapter\n\nBody text for ${folder}. 本文。\n`, "utf8");
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

/** Stub the intake + the AI layer for a whole-task run. */
function installTaskStubs(manifest, { failInstallments = [] } = {}) {
  const gtt = require("../get-translation-target");
  gtt.getTranslationTarget = async () => manifest;

  const dirForInstallment = new Map(
    manifest.volumes.map((v) => [v.installmentNumber, path.join(manifest.seriesLocation, v.folder)])
  );
  const installmentOf = (label) => {
    const m = label.match(/-(\d{2})\b/);
    return m ? m[1] : null;
  };

  harness.createGatedFsTools = async () => ({ tools: {}, approve: async () => true });
  harness.createAgentHandle = async (cfg) => ({
    name: cfg.name,
    async sendTurn(prompt, opts) {
      const label = (opts && opts.label) || "";
      taskLabels.push(label);
      const installment = installmentOf(label) || installmentOf(cfg.name);
      // A failing volume fails at generation, so it leaves NO artifact behind
      // (that is what makes "the last existing snapshot" the interesting case).
      for (const bad of failInstallments) {
        if (label.includes(`generate-${bad}`)) throw new Error(`stubbed model failure on ${label}`);
      }
      const volumeDir = dirForInstallment.get(installment);
      if (cfg.name.startsWith("wiki-author-")) writeWiki(volumeDir, label);
      if (cfg.name.startsWith("wiki-validator-")) writeValidationReport(volumeDir, installment, label);
      return { text: "wrote the files", toolCalls: [{ toolName: "writeFile" }] };
    },
    async close() {},
  });
  harness.runOneShot = async (cfg) => {
    const label = cfg.label || "";
    taskLabels.push(label);
    for (const installment of failInstallments) {
      if (label.includes(`-${installment}`)) throw new Error(`stubbed model failure on ${label}`);
    }
    if (label.startsWith("jump-in-wiki-acceptance-")) return pass(88);
    throw new Error(`Unexpected one-shot label: ${label}`);
  };
}

/** Every agent/one-shot label a whole-task child run produced. */
const taskLabels = [];

/**
 * Cascade: volume 01 has nothing to skip, so it regenerates — and volume 02,
 * whose own state says "accepted", must regenerate too. Its wiki was built on
 * volume 01's, so keeping it would leave the series state built on a stale base.
 */
async function childCascade() {
  const seriesDir = process.env.SERIES_LOCATION;
  const manifest = childManifest;
  // Volume 02 looks already-done: real wiki + an accepted rolling-state file.
  const vol2 = path.join(seriesDir, "Book(02)");
  writeWiki(vol2, "previous run");
  writeValidationReport(vol2, "02", "previous run");
  fs.writeFileSync(
    path.join(vol2, "jump-in-wiki-validation-02-rolling-state.json"),
    JSON.stringify({
      schema: 2,
      results: [88, 90],
      acceptedBy: "rolling-average",
      sourceFingerprint: "fp-02",
    }),
    "utf8"
  );
  installTaskStubs(manifest);

  await wiki.jumpInWiki();
  assert.ok(
    taskLabels.some((l) => l.startsWith("jump-in-wiki-generate-02")),
    `volume 02 got a generation pass despite its accepted state (the cascade). Labels: ${taskLabels.join(", ")}`
  );

  // Volume 02 was re-authored despite its accepted state (the cascade), and the
  // root copy is the LAST volume's snapshot.
  const rootCopy = fs.readFileSync(path.join(seriesDir, "shared-wiki.md"), "utf8");
  const vol2Wiki = fs.readFileSync(path.join(vol2, "shared-wiki.md"), "utf8");
  assert.ok(
    !vol2Wiki.includes("previous run"),
    `volume 02's wiki was rebuilt on the regenerated volume 01 (the cascade), not skipped: ${vol2Wiki}`
  );
  assert.strictEqual(rootCopy, vol2Wiki, "the series-root shared-wiki.md is the last volume's copy");
  assert.ok(fs.existsSync(path.join(seriesDir, "shared-wiki.md.provenance.json")), "with its provenance sidecar");
  console.log("cascade ok");
}

/**
 * The wiki reaches the shared loop's passing-grade re-grade path too.
 *
 * A first grade of 88 (above the 70 line, and the parent pins the exceptional
 * floor at 100 so the exceptional path cannot fire) used to mean: run a feedback
 * pass through the reused author session, then a fresh validator, to obtain the
 * window's second sample. Now the second sample comes from re-grading the same
 * wiki, and the feedback round — the expensive half of a wiki iteration — does
 * not run at all.
 */
async function childPassingConsensus() {
  installTaskStubs(childManifest);
  await wiki.jumpInWiki();

  const feedback = taskLabels.filter((l) => l.startsWith("jump-in-wiki-feedback-"));
  assert.strictEqual(feedback.length, 0, `a passing first grade was confirmed by re-grading, so no feedback pass should run (got: ${feedback.join(", ")})`);
  const grades = taskLabels.filter((l) => l.startsWith("jump-in-wiki-acceptance-"));
  assert.ok(grades.length >= 3, `the window's samples came from re-grades (acceptance labels: ${grades.join(", ")})`);
  assert.ok(grades.some((l) => l.includes("confirm")), `the re-grades are labelled as confirmations (got: ${grades.join(", ")})`);
  console.log("passing ok");
}

/**
 * A partially failed run: the last volume's model call throws, the policy skips
 * it, the root copy falls back to the LAST EXISTING snapshot (volume 01), and
 * the task STILL REJECTS.
 */
async function childPartialRun() {
  const seriesDir = process.env.SERIES_LOCATION;
  installTaskStubs(childManifest, { failInstallments: ["02"] });

  let err = null;
  try {
    await wiki.jumpInWiki();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "a task that skipped a volume fails the run");
  assert.ok(/jump-in-wiki: 1 of 2 volume\(s\) failed/.test(err.message), err.message);
  const vol2Shared = path.join(seriesDir, "Book(02)", "shared-wiki.md");
  assert.ok(fs.existsSync(vol2Shared), "the failed volume still holds its pre-created scaffold stub on disk");
  assert.ok(fs.readFileSync(vol2Shared, "utf8").includes("stub"), "and it is still a stub, not finished work");
  const rootCopy = fs.readFileSync(path.join(seriesDir, "shared-wiki.md"), "utf8");
  const vol1 = fs.readFileSync(path.join(seriesDir, "Book(01)", "shared-wiki.md"), "utf8");
  assert.ok(!rootCopy.includes("stub"), "the series-root copy is NOT that stub — a stub is not the series' living wiki");
  assert.strictEqual(rootCopy, vol1, "it is the LAST REAL snapshot instead");
  console.log("partial run ok");
}

// ─── run ─────────────────────────────────────────────────────────────────────

async function main() {
  installStubs();

  if (childScenario === "cascade") return childCascade();
  if (childScenario === "partial") return childPartialRun();
  if (childScenario === "passing") return childPassingConsensus();
  if (childScenario) throw new Error(`unknown --child=${childScenario}`);

  await scenarioGenerationSkipped();
  await scenarioStubIsNotAnArtifact();
  await scenarioSessionShape();
  await scenarioChunkedWikiFlow();
  await scenarioChunkedValidatorWritesNothing();

  for (const name of ["cascade", "partial", "passing"]) {
    const out = execFileSync(process.execPath, [__filename, `--child=${name}`], { encoding: "utf8" });
    assert.ok(/ok$/.test(out.trim().split("\n").pop()), `child ${name} reported failure:\n${out}`);
  }

  console.log("wiki-orchestration: all checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

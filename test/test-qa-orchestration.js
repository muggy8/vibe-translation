/**
 * test-qa-orchestration.js — offline orchestration tests for the volume QA
 * loop (validator → grader → feedback) in the task modules.
 *
 * The AI layer is stubbed by monkey-patching harness.runOneShot /
 * harness.createAgentHandle / harness.createGatedFsTools (the task code calls
 * them through the harness module object, so the patches apply). The agent
 * stub writes real files into a temp directory, so the deterministic parts
 * run unmodified: assertWrote / assertWroteWithFallback (fallback + recovery
 * gating), the rolling-window bookkeeping, saveRollingState /
 * loadRollingState, meetsAcceptanceCriteria, the ON_QA_LIMIT policy, and the
 * idempotency skip decision (isAcceptedState + isSourceStale).
 *
 * No network, no real endpoint. Run with `npm test` (or standalone:
 * `node test/test-qa-orchestration.js`). The ON_QA_LIMIT=fail variant runs in
 * a spawned child (the policy constant is read at module load).
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

// The ON_QA_LIMIT=fail child must keep its policy — pin the run policies only
// in the parent (the child gets ON_QA_LIMIT=fail via the spawn env below).
const childFailLimit = process.argv.includes("--child-fail-limit");

// Pin the acceptance config so the loop tests are deterministic regardless of
// the local .env (the values below are also the current code defaults: window
// 2 / min samples 2 / passing 70 / average strategy).
process.env.ACCEPTANCE_PASSING_SCORE = "70";
process.env.ACCEPTANCE_STRATEGY = "average";
process.env.ACCEPTANCE_WINDOW_SIZE = "2";
process.env.ACCEPTANCE_MIN_SAMPLES = "2";
process.env.QA_MAX_ITERATIONS = "4";
process.env.AGENT_RECOVERY_ENABLED = "true";
if (!childFailLimit) {
  process.env.ON_QA_LIMIT = "accept";
  process.env.ON_VOLUME_ERROR = "skip";
  process.env.ON_MISSING_PREVIOUS = "skip";
}

const harness = require("../harness");
const cv = require("../character-voice");
const {
  loadRollingState,
  isAcceptedState,
  isSourceStale,
  computeRollingAverage,
} = require("../configs/shared");

// ─── Scenario plumbing ───────────────────────────────────────────────────────

/** The current scenario's behavior script (set before each runVolume call). */
let script = null;
/** Every AI-layer call the scenario made: {kind, name?, label}. */
let callLog = [];

/**
 * Install the harness stubs (idempotent — called once per process).
 * runOneShot answers from script.oneShot(label); agent handles answer from
 * script.agent(name, prompt, turnEntry) and record their turns.
 */
function installStubs() {
  harness.runOneShot = async (cfg) => {
    callLog.push({ kind: "one-shot", label: cfg.label });
    return script.oneShot(cfg.label);
  };
  harness.createGatedFsTools = async () => ({ tools: {}, approve: async () => true });
  harness.createAgentHandle = async (cfg) => {
    const turns = [];
    return {
      name: cfg.name,
      turns,
      async sendTurn(prompt, opts) {
        const entry = { name: cfg.name, label: opts && opts.label, prompt, turn: turns.length };
        turns.push(entry);
        callLog.push({ kind: "agent", name: cfg.name, label: opts && opts.label });
        return script.agent(cfg.name, prompt, entry);
      },
      async close() {},
    };
  };
}

/** Fresh temp dir with a volume folder + a real source file (fs.stat reads it). */
function makeVolumeDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-qa-"));
  const volumeDir = path.join(root, "test_story(1)");
  fs.mkdirSync(volumeDir, { recursive: true });
  const sourceFile = path.join(volumeDir, "test_story(1).md");
  fs.writeFileSync(sourceFile, "# Test source\n\nBody text for the orchestration test.\n", "utf8");
  return { root, volumeDir, sourceFile };
}

/** The full volume context for character-voice runVolume (whole mode, vol 01). */
function makeCtx(v) {
  const volumeDir = v.volumeDir;
  const ctx = {
    values: {
      SOURCE_NAME: "test_story",
      INSTALLMENT_NUMBER: "01",
      SOURCE_LANGUAGE: "Japanese",
      TARGET_LANGUAGE: "English",
    },
    folderName: "test_story(1)",
    volumeDir,
    sourceFile: v.sourceFile,
    bundle: {
      format: "txt",
      wholePath: v.sourceFile,
      originalPath: v.sourceFile,
      segments: [],
      wholeChars: 42,
      sourceFingerprint: "fp-001",
    },
    chunked: false,
    voiceOutputFile: path.join(volumeDir, "character-voice.md"),
    povOutputFile: path.join(volumeDir, "pov-map.md"),
    validationOutputFile: path.join(volumeDir, "character-voice-validation.md"),
    isFirst: true,
    previousFolderName: null,
    previousVoiceRefFile: null,
    extractPrompt: "Extract the quirks. {{SOURCE_NAME}} vol {{INSTALLMENT_NUMBER}}.",
    validatorPrompt: "Validate the reference. {{SOURCE_NAME}} vol {{INSTALLMENT_NUMBER}}.",
    feedbackPrompt: "Apply the feedback. {{SOURCE_NAME}} vol {{INSTALLMENT_NUMBER}}.",
    acceptancePrompt: "Score the reference. {{SOURCE_NAME}} vol {{INSTALLMENT_NUMBER}}.",
    extractTemplate: "Extract. {{SOURCE_NAME}} vol {{INSTALLMENT_NUMBER}}.",
    authorTemplate: "Compile. {{SOURCE_NAME}} vol {{INSTALLMENT_NUMBER}}. {{EXTRACTION_RESULTS}}",
    extractSystemPrompt: "You are an extractor.",
    authorSystemPrompt: "You are an author.",
    validatorSystemPrompt: "You are a validator.",
    acceptanceSystemPrompt: "You are a grader.",
    feedbackSystemPrompt: "You are a fixer.",
  };
  ctx.extractUserPrompt = ctx.extractTemplate;
  ctx.authorUserPrompt = ctx.authorTemplate;
  ctx.validatorUserPrompt = ctx.validatorPrompt;
  ctx.feedbackUserPrompt = ctx.feedbackPrompt;
  return ctx;
}

/** The agent stub's file writers (real fs — the deterministic gates see them). */
function writeArtifacts(volumeDir, marker) {
  fs.writeFileSync(path.join(volumeDir, "character-voice.md"), `# Character Voice (${marker})\n`, "utf8");
  fs.writeFileSync(path.join(volumeDir, "pov-map.md"), `# POV Map (${marker})\n`, "utf8");
}
function writeReport(volumeDir, marker) {
  fs.writeFileSync(
    path.join(volumeDir, "character-voice-validation.md"),
    `# Validation Report (${marker})\n\nFinal recommendation: Pass\n`,
    "utf8"
  );
}

/**
 * Build the default scenario script:
 * - oneShot: extract → "[]" (no terms), acceptance → the next scripted reply.
 * - agent: the compile author writes the artifacts (marker "v1"; "recovered"
 *   on its recovery turn) and returns compileText; the validator writes the
 *   report; the feedback author rewrites the artifacts (marker "revised").
 */
function makeDefaultScript(volumeDir, acceptanceReplies, { compileWritesFiles = true, compileText = "wrote both files" } = {}) {
  let acceptanceIndex = 0;
  return {
    oneShot(label) {
      if (label.startsWith("character-voice-extract-")) return "[]";
      if (label.startsWith("character-voice-acceptance-")) {
        const i = acceptanceIndex++;
        if (i >= acceptanceReplies.length) {
          throw new Error(`Unexpected acceptance call ${i + 1} (only ${acceptanceReplies.length} scripted).`);
        }
        return acceptanceReplies[i];
      }
      throw new Error(`Unexpected one-shot label: ${label}`);
    },
    agent(name, prompt, entry) {
      if (name.startsWith("author-voice-") && !name.includes("feedback")) {
        // Compile author (or its recovery turn).
        if (compileWritesFiles) {
          writeArtifacts(volumeDir, entry.label && entry.label.includes("recovery") ? "recovered" : "v1");
        }
        return { text: compileText };
      }
      if (name.startsWith("validator-voice-")) {
        writeReport(volumeDir, name);
        return { text: "" };
      }
      if (name.startsWith("author-voice-feedback-")) {
        writeArtifacts(volumeDir, "revised");
        return { text: "" };
      }
      throw new Error(`Unexpected agent name: ${name}`);
    },
  };
}

/** The JSON acceptance reply the new prompt contract requires. */
function jsonReply(score) {
  return JSON.stringify({
    score,
    band: score >= 70 ? "Pass" : "Requires revision",
    note: `scripted ${score}`,
  });
}

function acceptanceLabels() {
  return callLog.filter(
    (c) => c.kind === "one-shot" && c.label.startsWith("character-voice-acceptance-")
  ).map((c) => c.label);
}
function agentCalls(namePrefix) {
  return callLog.filter((c) => c.kind === "agent" && c.name.startsWith(namePrefix));
}

/** Load the persisted rolling state written by the QA loop. */
function loadState(validationOutputFile) {
  return loadRollingState(validationOutputFile.replace(".md", "-rolling-state.json"));
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* temp dir — best effort */
  }
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

/**
 * Two consecutive fresh passes meet the criterion (the current default:
 * window 2 / min 2) → the loop stops after iteration 2. The single score of
 * iteration 1 does not yet meet the minimum sample count, so exactly one
 * feedback pass runs. Also pins the recovery gating: the compile agent wrote
 * its files, so its non-empty chat reply must NOT trigger a redundant
 * recovery turn.
 */
async function scenarioAcceptsOnTwoFreshPasses() {
  const v = makeVolumeDir();
  const ctx = makeCtx(v);
  script = makeDefaultScript(v.volumeDir, [jsonReply(85), jsonReply(90)]);
  callLog = [];
  try {
    await cv.runVolume(ctx);
    assert.strictEqual(acceptanceLabels().length, 2, "two acceptance checks");
    assert.strictEqual(agentCalls("author-voice-feedback-").length, 1, "one feedback pass (iteration 1's single score cannot accept)");
    const compile = agentCalls("author-voice-01");
    assert.strictEqual(compile.length, 1, "compile author ran exactly one turn (no recovery over written files)");
    const state = await loadState(ctx.validationOutputFile);
    assert.ok(state, "rolling state persisted");
    assert.deepStrictEqual(state.results, [85, 90], "window holds both fresh scores");
    assert.strictEqual(state.sourceFingerprint, "fp-001", "source fingerprint persisted for the staleness check");
    assert.strictEqual(isAcceptedState(state), true, "state is an accepted state");
    const artifact = fs.readFileSync(ctx.voiceOutputFile, "utf8");
    assert.ok(artifact.includes("revised"), "artifact is the feedback pass's latest revision");
  } finally {
    cleanup(v.root);
  }
}

/**
 * A failing first check triggers exactly one feedback pass; the second
 * (fresh) check then meets the window criterion (avg 73.5) → accepted.
 */
async function scenarioFeedbackThenAccept() {
  const v = makeVolumeDir();
  const ctx = makeCtx(v);
  script = makeDefaultScript(v.volumeDir, [jsonReply(55), jsonReply(92)]);
  callLog = [];
  try {
    await cv.runVolume(ctx);
    assert.strictEqual(acceptanceLabels().length, 2, "two acceptance checks");
    assert.strictEqual(agentCalls("author-voice-feedback-").length, 1, "one feedback pass after the failing check");
    const feedback = agentCalls("author-voice-feedback-")[0];
    assert.strictEqual(feedback.label, "character-voice-feedback-01", "feedback turn label kept");
    const artifact = fs.readFileSync(ctx.voiceOutputFile, "utf8");
    assert.ok(artifact.includes("revised"), "feedback pass rewrote the artifact");
    const state = await loadState(ctx.validationOutputFile);
    assert.deepStrictEqual(state.results, [55, 92], "window holds fail-then-pass");
    assert.strictEqual(isAcceptedState(state), true, "accepted state");
  } finally {
    cleanup(v.root);
  }
}

/**
 * The loop burns all QA_MAX_ITERATIONS (4) without meeting the criterion.
 * With ON_QA_LIMIT=accept the volume is accepted as-is: no throw,
 * limitReached flagged, feedback applied after every failing check (the loop
 * applies feedback before checking the limit), state file holds the final
 * window.
 */
async function scenarioLimitAcceptPolicy() {
  const v = makeVolumeDir();
  const ctx = makeCtx(v);
  script = makeDefaultScript(v.volumeDir, [jsonReply(40), jsonReply(45), jsonReply(50), jsonReply(60)]);
  callLog = [];
  try {
    await cv.runVolume(ctx);
    assert.strictEqual(ctx.limitReached, true, "limit flag set on the ctx");
    assert.strictEqual(acceptanceLabels().length, 4, "one acceptance check per iteration");
    assert.strictEqual(agentCalls("author-voice-feedback-").length, 4, "feedback after every failing check, including the last iteration (the loop applies feedback before checking the limit)");
    const state = await loadState(ctx.validationOutputFile);
    assert.deepStrictEqual(state.results, [50, 60], "state holds the final (window-sized) scores");
    assert.strictEqual(isAcceptedState(state), false, "limit-accepted state is NOT an accepted state (re-run re-validates)");
  } finally {
    cleanup(v.root);
  }
}

/**
 * ON_QA_LIMIT=fail (read at module load) — the same stuck loop must reject.
 * Runs in a spawned child so the module sees the different policy.
 */
function scenarioLimitFailPolicyInChild() {
  const out = execFileSync(process.execPath, [__filename, "--child-fail-limit"], {
    encoding: "utf8",
    env: { ...process.env, ON_QA_LIMIT: "fail" },
  });
  assert.ok(out.includes("CHILD-OK"), "child printed CHILD-OK (got: " + out.trim().slice(-120) + ")");
}

/** The child's entry point (ON_QA_LIMIT=fail). */
async function scenarioLimitFailPolicy() {
  const v = makeVolumeDir();
  const ctx = makeCtx(v);
  script = makeDefaultScript(v.volumeDir, [jsonReply(40), jsonReply(45), jsonReply(50), jsonReply(60)]);
  callLog = [];
  try {
    await assert.rejects(() => cv.runVolume(ctx), /iteration limit/);
    assert.strictEqual(acceptanceLabels().length, 4, "all iterations ran before the policy failed the volume");
  } finally {
    cleanup(v.root);
  }
}

/**
 * Recovery turn gating: the compile agent replies in chat WITHOUT writing
 * the files → assertWroteWithFallback falls back (writes the chat reply),
 * returns true, and the recovery turn fires.
 */
async function scenarioRecoveryWhenFileMissing() {
  const v = makeVolumeDir();
  const ctx = makeCtx(v);
  script = makeDefaultScript(v.volumeDir, [jsonReply(90), jsonReply(95)], {
    compileWritesFiles: false,
    compileText: "Here is the full reference content, written in chat instead of a file.",
  });
  callLog = [];
  try {
    await cv.runVolume(ctx);
    const compile = agentCalls("author-voice-01");
    assert.strictEqual(compile.length, 2, "compile + recovery turns");
    assert.strictEqual(compile[0].label, "character-voice-compile-01");
    assert.strictEqual(compile[1].label, "character-voice-compile-recovery-01", "recovery turn label kept");
    assert.ok(fs.existsSync(ctx.voiceOutputFile), "artifact exists (fallback or recovery wrote it)");
    assert.ok(fs.existsSync(ctx.povOutputFile), "POV map exists");
    assert.strictEqual(acceptanceLabels().length, 2, "QA loop still ran to acceptance");
  } finally {
    cleanup(v.root);
  }
}

/**
 * Recovery DISABLED (AGENT_RECOVERY_ENABLED=false, read at call time): the
 * same missing-file situation falls back to the chat reply but runs NO
 * recovery turn.
 */
async function scenarioRecoveryDisabled() {
  const prev = process.env.AGENT_RECOVERY_ENABLED;
  process.env.AGENT_RECOVERY_ENABLED = "false";
  const v = makeVolumeDir();
  const ctx = makeCtx(v);
  script = makeDefaultScript(v.volumeDir, [jsonReply(90), jsonReply(95)], {
    compileWritesFiles: false,
    compileText: "Reference content in chat.",
  });
  callLog = [];
  try {
    await cv.runVolume(ctx);
    const compile = agentCalls("author-voice-01");
    assert.strictEqual(compile.length, 1, "no recovery turn when AGENT_RECOVERY_ENABLED=false");
    assert.ok(fs.existsSync(ctx.voiceOutputFile), "fallback still wrote the artifact from the chat reply");
  } finally {
    process.env.AGENT_RECOVERY_ENABLED = prev;
    cleanup(v.root);
  }
}

/**
 * Unparseable acceptance replies count as failed checks (fail-closed) and
 * are NOT stored in the window — the loop keeps going and the state file
 * holds only the parseable scores.
 */
async function scenarioUnparseableAcceptanceFailsClosed() {
  const v = makeVolumeDir();
  const ctx = makeCtx(v);
  script = makeDefaultScript(v.volumeDir, [
    "I think it is quite good overall.",
    jsonReply(95),
    jsonReply(95),
  ]);
  callLog = [];
  try {
    await cv.runVolume(ctx);
    assert.strictEqual(acceptanceLabels().length, 3, "three iterations: unparseable + two fresh passes");
    assert.strictEqual(agentCalls("author-voice-feedback-").length, 2, "feedback after the unparseable check and the first single score");
    const state = await loadState(ctx.validationOutputFile);
    assert.deepStrictEqual(state.results, [95, 95], "the unparseable reply was not stored");
    assert.strictEqual(isAcceptedState(state), true, "accepted state");
  } finally {
    cleanup(v.root);
  }
}

/**
 * The idempotency skip decision the task functions make before processing a
 * volume: skip = isAcceptedState(state) && !isSourceStale(state, bundle).
 * Pinned against the real state file format (saveRollingState output):
 * accepted + matching fingerprint → skip; changed source → regenerate;
 * legacy state without a fingerprint → fail-open skip; missing/corrupt
 * state → regenerate.
 */
async function scenarioSkipDecision() {
  const { saveRollingState } = require("../configs/shared");
  const v = makeVolumeDir();
  const ctx = makeCtx(v);
  writeArtifacts(v.volumeDir, "v1");
  const stateFile = ctx.validationOutputFile.replace(".md", "-rolling-state.json");
  try {
    // 1. Accepted state, fingerprint matches → the volume would be skipped.
    await saveRollingState(stateFile, [85, 88], { sourceFingerprint: "fp-001" });
    let state = await loadState(ctx.validationOutputFile);
    assert.ok(state, "state loaded");
    assert.strictEqual(isAcceptedState(state), true, "accepted state");
    assert.strictEqual(isSourceStale(state, ctx.bundle), false, "fingerprint matches");
    assert.strictEqual(isAcceptedState(state) && !isSourceStale(state, ctx.bundle), true, "skip");

    // 2. Same state, changed source → stale → regenerate (no skip).
    const staleBundle = { ...ctx.bundle, sourceFingerprint: "fp-999" };
    assert.strictEqual(isSourceStale(state, staleBundle), true, "fingerprint mismatch → stale");
    assert.strictEqual(isAcceptedState(state) && !isSourceStale(state, staleBundle), false, "no skip");

    // 3. Legacy state (no fingerprint) → fail-open: keeps the legacy skip
    //    behavior for pre-upgrade runs.
    await saveRollingState(stateFile, [85, 88], {});
    state = await loadState(ctx.validationOutputFile);
    assert.strictEqual(state.sourceFingerprint, undefined, "legacy state has no fingerprint");
    assert.strictEqual(isSourceStale(state, ctx.bundle), false, "fail-open on missing fingerprint");
    assert.strictEqual(isAcceptedState(state) && !isSourceStale(state, ctx.bundle), true, "skip");

    // 4. Missing state file → the check falls back to regenerating.
    fs.rmSync(stateFile);
    state = await loadState(ctx.validationOutputFile);
    assert.strictEqual(state, null, "missing state → null");
    assert.strictEqual(state !== null && isAcceptedState(state) && !isSourceStale(state, ctx.bundle), false, "no skip");
  } finally {
    cleanup(v.root);
  }
}

// ─── Entry points ────────────────────────────────────────────────────────────

async function main() {
  installStubs();
  await scenarioAcceptsOnTwoFreshPasses();
  await scenarioFeedbackThenAccept();
  await scenarioLimitAcceptPolicy();
  scenarioLimitFailPolicyInChild();
  await scenarioRecoveryWhenFileMissing();
  await scenarioRecoveryDisabled();
  await scenarioUnparseableAcceptanceFailsClosed();
  await scenarioSkipDecision();
  console.log("qa-orchestration: all checks passed.");
}

if (childFailLimit) {
  installStubs();
  scenarioLimitFailPolicy()
    .then(() => console.log("CHILD-OK"))
    .catch((err) => {
      console.error("CHILD-FAIL:", err && err.stack || err);
      process.exit(1);
    });
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
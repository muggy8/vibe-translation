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
 * loadRollingState (including the grade tally — how many grades were asked for
 * and how many answers were unusable), meetsAcceptanceCriteria, the ON_QA_LIMIT
 * policy, and the idempotency skip decision (isAcceptedState + isSourceStale).
 *
 * No network, no real endpoint. Run with `npm test` (or standalone:
 * `node test/test-qa-orchestration.js`). The ON_QA_LIMIT=fail variant runs in
 * a spawned child (the policy constant is read at module load).
 */
require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

// The ON_QA_LIMIT=fail child must keep its policy — pin the run policies only
// in the parent (the child gets ON_QA_LIMIT=fail via the spawn env below).
const childFailLimit = process.argv.includes("--child-fail-limit");
const childConsensus = process.argv.includes("--child-consensus");
const childPassingConsensus = process.argv.includes("--child-passing-consensus");

// Pin the acceptance config so the loop tests are deterministic regardless of
// the local .env (the values below are also the current code defaults: window
// 2 / min samples 2 / passing 70).
process.env.PASSING_SCORE = "70";
process.env.ACCEPTANCE_PASSING_SCORE = "70";
process.env.ACCEPTANCE_WINDOW_SIZE = "2";
process.env.ACCEPTANCE_MIN_SAMPLES = "2";
// The exceptional-score fast-accept path is pinned OFF in the parent (floor
// 100, and no scenario below scores 100) so the scenarios below keep
// exercising the rolling-window path. The consensus path is exercised in a
// spawned child with its own pins — see scenarioExceptionalConsensusInChild.
if (!childConsensus) {
  process.env.ACCEPTANCE_EXCEPTIONAL_SCORE = "100";
}
process.env.ACCEPTANCE_SCORE_TOLERANCE = "3";
process.env.ACCEPTANCE_CONFIRMATION_CHECKS = "2";
// The "a passing grade earns its second sample by re-grading" path is pinned OFF
// in the parent so the scenarios below keep exercising the rolling-window route
// (one feedback pass between the two samples). It is exercised in a spawned child
// with its own pins — see scenarioPassingConsensusInChild.
process.env.ACCEPTANCE_CONFIRM_ON_PASSING = childPassingConsensus ? "true" : "false";
process.env.QA_MAX_ITERATIONS = "4";
process.env.AGENT_RECOVERY_ENABLED = "true";
if (!childFailLimit) {
  process.env.ON_QA_LIMIT = "accept";
  process.env.ON_VOLUME_ERROR = "skip";
  process.env.ON_MISSING_PREVIOUS = "skip";
}

const harness = require("../harness");
const cv = require("../character-voice");
const { runPerChapterQaLoop } = require("../utils/qa-loop");
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
let feedbackWriteCount = 0;
function writeArtifacts(volumeDir, marker) {
  fs.writeFileSync(path.join(volumeDir, "character-voice.md"), `# Character Voice (${marker})\n`, "utf8");
  fs.writeFileSync(path.join(volumeDir, "pov-map.md"), `# POV Map (${marker})\n`, "utf8");
}
/**
 * The feedback author's writers. Each pass writes DIFFERENT bytes, because that is
 * what a real feedback pass does — and the loop's no-op detector (fingerprintFiles)
 * is exactly what a stub that rewrote identical text would make untestable.
 */
function writeRevisedArtifacts(volumeDir) {
  feedbackWriteCount += 1;
  fs.writeFileSync(path.join(volumeDir, "character-voice.md"), `# Character Voice (revised ${feedbackWriteCount})\n`, "utf8");
  fs.writeFileSync(path.join(volumeDir, "pov-map.md"), `# POV Map (revised ${feedbackWriteCount})\n`, "utf8");
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
 *
 * `recoveryWritesFiles` defaults to `compileWritesFiles`. A scenario that makes
 * the compile turn reply in chat instead of writing must say whether the
 * recovery turn writes: the fallback no longer copies one chat reply into two
 * different artifacts (utils/fs.js), so a two-file gap is repaired by the
 * recovery turn or not at all.
 */
function makeDefaultScript(volumeDir, acceptanceReplies, { compileWritesFiles = true, recoveryWritesFiles = compileWritesFiles, compileText = "wrote both files", confirmationReplies = [], feedbackWritesFiles = true } = {}) {
  let acceptanceIndex = 0;
  let confirmationIndex = 0;
  feedbackWriteCount = 0;
  return {
    oneShot(label) {
      if (label.startsWith("character-voice-extract-")) return "[]";
      if (label.startsWith("character-voice-acceptance-")) {
        // Exceptional-score confirmations are scripted separately so a scenario
        // can control the consensus independently of the first grade.
        if (label.includes("-confirm")) {
          if (confirmationReplies.length === 0) {
            throw new Error(`Unexpected confirmation call on ${label} (no confirmation replies scripted).`);
          }
          const reply = confirmationReplies[Math.min(confirmationIndex, confirmationReplies.length - 1)];
          confirmationIndex += 1;
          return reply;
        }
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
        const isRecovery = Boolean(entry.label && entry.label.includes("recovery"));
        if (compileWritesFiles || (isRecovery && recoveryWritesFiles)) {
          writeArtifacts(volumeDir, isRecovery ? "recovered" : "v1");
        }
        return { text: compileText };
      }
      if (name.startsWith("validator-voice-")) {
        writeReport(volumeDir, name);
        return { text: "" };
      }
      if (name.startsWith("author-voice-feedback-")) {
        // `feedbackWritesFiles: false` scripts the live failure shape: a feedback
        // turn that spent its whole step budget reading and wrote nothing, leaving
        // the artifacts exactly as the compile pass wrote them.
        if (feedbackWritesFiles) writeRevisedArtifacts(volumeDir);
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
 * the files → the fallback REFUSES to use that reply (one chat reply cannot be
 * the content of two different documents), returns true, and the recovery turn
 * fires and writes both files.
 *
 * The refused reply must never reach the disk. Observed live: the fallback wrote
 * one 164-character planning sentence into BOTH character-voice.md and
 * pov-map.md, and the volume passed every "was the work done?" check on it.
 */
async function scenarioRecoveryWhenFileMissing() {
  const v = makeVolumeDir();
  const ctx = makeCtx(v);
  // A reply big enough to clear the size floor, so what refuses it is the
  // two-missing-outputs rule and not the length check.
  const chatReply = `# Character Voice Reference\n\n${"carried-forward voice quirk entry. ".repeat(200)}`;
  script = makeDefaultScript(v.volumeDir, [jsonReply(90), jsonReply(95)], {
    compileWritesFiles: false,
    recoveryWritesFiles: true,
    compileText: chatReply,
  });
  callLog = [];
  try {
    await cv.runVolume(ctx);
    const compile = agentCalls("author-voice-01");
    assert.strictEqual(compile.length, 2, "compile + recovery turns");
    assert.strictEqual(compile[0].label, "character-voice-compile-01");
    assert.strictEqual(compile[1].label, "character-voice-compile-recovery-01", "recovery turn label kept");
    assert.ok(fs.existsSync(ctx.voiceOutputFile), "artifact exists (the recovery turn wrote it)");
    assert.ok(fs.existsSync(ctx.povOutputFile), "POV map exists");
    const voice = fs.readFileSync(ctx.voiceOutputFile, "utf8");
    const pov = fs.readFileSync(ctx.povOutputFile, "utf8");
    assert.ok(!voice.includes("carried-forward voice quirk entry"), "the refused chat reply never became character-voice.md");
    assert.ok(!pov.includes("carried-forward voice quirk entry"), "the refused chat reply never became pov-map.md");
    assert.ok(pov.includes("POV Map"), "the POV map is the recovery turn's own file, not a copy of the voice reference");
    assert.strictEqual(acceptanceLabels().length, 2, "QA loop still ran to acceptance");
  } finally {
    cleanup(v.root);
  }
}

/**
 * Recovery DISABLED (AGENT_RECOVERY_ENABLED=false, read at call time): no
 * recovery turn runs, and because the fallback will not duplicate one chat
 * reply across two artifacts, the volume FAILS LOUDLY instead of publishing a
 * plausible-looking wrong pair. Turning recovery off means the hard stop is the
 * only thing left.
 */
async function scenarioRecoveryDisabled() {
  const prev = process.env.AGENT_RECOVERY_ENABLED;
  process.env.AGENT_RECOVERY_ENABLED = "false";
  const v = makeVolumeDir();
  const ctx = makeCtx(v);
  script = makeDefaultScript(v.volumeDir, [jsonReply(90), jsonReply(95)], {
    compileWritesFiles: false,
    recoveryWritesFiles: true,
    compileText: `# Character Voice Reference\n\n${"carried-forward voice quirk entry. ".repeat(200)}`,
  });
  callLog = [];
  try {
    await assert.rejects(() => cv.runVolume(ctx), /never wrote real output/);
    const compile = agentCalls("author-voice-01");
    assert.strictEqual(compile.length, 1, "no recovery turn when AGENT_RECOVERY_ENABLED=false");
    assert.ok(!fs.existsSync(ctx.voiceOutputFile), "the chat reply was not written as the artifact");
    assert.ok(!fs.existsSync(ctx.povOutputFile), "nor duplicated into the POV map");
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
    // …and it is COUNTED. The window alone cannot tell "the grader refused to answer" apart from
    // "the grader was never called": both leave a short window. The tally is what makes the
    // difference visible afterwards.
    assert.strictEqual(state.gradeAttempts, 3, "all three grades the loop asked for are on the record");
    assert.strictEqual(state.gradeFailures, 1, "the one it could not read is a failure, not a silence");
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

/**
 * Exceptional-score consensus, exercised in a spawned child so configs/shared.js
 * loads with the exceptional floor ON (the parent pins it OFF so the other
 * scenarios keep exercising the rolling-window path).
 *
 * A. confirmed: 87 first, confirmations 86 (temperature 0) and 85 — the loop
 *    accepts WITHOUT a feedback pass and without a second validator turn.
 * B. fluke: 92 first, but the deterministic grade says 74 — the consensus
 *    collapses and the normal loop continues.
 */
function scenarioExceptionalConsensusInChild() {
  const out = execFileSync(process.execPath, [__filename, "--child-consensus"], {
    encoding: "utf8",
    env: { ...process.env, ACCEPTANCE_EXCEPTIONAL_SCORE: "85", ACCEPTANCE_SCORE_TOLERANCE: "3" },
  });
  assert.ok(out.includes("CHILD-OK"), "child printed CHILD-OK (got: " + out.trim().slice(-300) + ")");
}

/** The child's entry point (exceptional-consensus path). */
async function scenarioExceptionalConsensus() {
  // A. confirmed exceptional score → accepted on the spot.
  {
    const v = makeVolumeDir();
    const ctx = makeCtx(v);
    script = makeDefaultScript(v.volumeDir, [jsonReply(87)], {
      confirmationReplies: [jsonReply(86), jsonReply(85)],
    });
    callLog = [];
    try {
      await cv.runVolume(ctx);
      const labels = acceptanceLabels();
      assert.strictEqual(labels.length, 3, `first grade + 2 confirmations (got ${labels.length})`);
      assert.ok(labels.some((l) => l.includes("confirm1")), "the first confirmation ran");
      // One validator turn only: the fast path skipped the feedback pass AND
      // the second full validator turn the normal loop would have needed.
      assert.strictEqual(agentCalls("validator-voice-").length, 1, "exactly one validator turn");
      assert.strictEqual(agentCalls("author-voice-feedback-").length, 0, "no feedback pass");
      const state = await loadState(ctx.validationOutputFile);
      assert.strictEqual(state.acceptedBy, "exceptional-consensus", "the state records HOW it was accepted");
      assert.strictEqual(state.deterministicScore, 86, "the temperature-0 grade is persisted");
      assert.ok(isAcceptedState(state), "the persisted state still reads as accepted (no-AI skip check)");
    } finally {
      cleanup(v.root);
    }
  }

  // B. the deterministic grade disagrees → it was a fluke → normal loop.
  // Both iterations' deterministic confirmation says 74, so the consensus never
  // fires and the volume goes the long way round.
  {
    const v = makeVolumeDir();
    const ctx = makeCtx(v);
    script = makeDefaultScript(v.volumeDir, [jsonReply(92), jsonReply(88)], {
      confirmationReplies: [jsonReply(74), jsonReply(74)],
    });
    callLog = [];
    try {
      await cv.runVolume(ctx);
      assert.strictEqual(agentCalls("author-voice-feedback-").length, 1, "the feedback pass ran — the fast path did not fire");
      assert.strictEqual(agentCalls("validator-voice-").length, 2, "the normal second validation iteration ran");
      const state = await loadState(ctx.validationOutputFile);
      assert.strictEqual(state.acceptedBy, "rolling-window", "accepted by the normal criterion instead");
      // The confirmation grades are recorded for diagnosis but never counted:
      // the window holds only the two iteration grades. (The last iteration's
      // own rejected confirmations are then overwritten by its acceptance
      // save — the state describes the FINAL iteration, which is what the
      // skip-check needs.)
      assert.deepStrictEqual(state.results, [92, 88], "the confirmation scores stayed out of the rolling window");
    } finally {
      cleanup(v.root);
    }
  }
}

/**
 * A feedback pass that changed NOTHING stops the loop instead of buying another
 * full iteration over an unchanged document.
 *
 * This is the live failure it was written for: volume 01's character-voice
 * feedback turn made 46 tool calls (29 reads, 15 searches, zero writes), spent
 * 2.63M tokens, and left both artifacts byte-identical. Every existing gate
 * passed — the files were there and real — so the loop started iteration 2 and
 * paid 8.4M tokens to re-audit a document that had not moved.
 */
async function scenarioFeedbackNoOpStopsLoop() {
  const v = makeVolumeDir();
  const ctx = makeCtx(v);
  // Iteration 1 grades 55 (fails) → feedback runs and writes nothing → the loop
  // must stop there rather than validate the same text four times.
  script = makeDefaultScript(v.volumeDir, [jsonReply(55), jsonReply(56)], {
    feedbackWritesFiles: false,
  });
  callLog = [];
  try {
    await cv.runVolume(ctx);
    assert.strictEqual(agentCalls("author-voice-feedback-").length, 1, "exactly one feedback pass (the no-op is not retried)");
    assert.strictEqual(agentCalls("validator-voice-").length, 1, "no second validator turn over an unchanged document");
    assert.strictEqual(acceptanceLabels().length, 1, "no second grade of the unchanged document");
    const state = await loadState(ctx.validationOutputFile);
    assert.strictEqual(state.stalled, true, "the state records that the loop stalled");
    // The artifact is still the compile pass's, not a phantom "revised" one.
    const artifact = fs.readFileSync(ctx.voiceOutputFile, "utf8");
    assert.ok(artifact.includes("v1") && !artifact.includes("revised"), "the unchanged artifact is what the compile pass wrote");
  } finally {
    cleanup(v.root);
  }
}

/**
 * The passing-grade re-grade path, exercised in a spawned child so
 * configs/shared.js loads with ACCEPTANCE_CONFIRM_ON_PASSING ON (the parent pins
 * it OFF so the scenarios above keep exercising the rolling-window route).
 *
 * A. 76 first (above the 70 line, below the 85 exceptional floor) with re-grades
 *    78 and 76 → accepted with NO feedback pass and NO second validator turn.
 *    This is the exact shape measured live on volume 01, where the old route cost
 *    2.63M + 8.4M tokens for the second sample.
 * B. 76 first, but a re-grade says 41 → the window disagrees with itself, so the
 *    feedback round runs. A passing grade is confirmed, never laundered.
 */
function scenarioPassingConsensusInChild() {
  const out = execFileSync(process.execPath, [__filename, "--child-passing-consensus"], {
    encoding: "utf8",
    env: { ...process.env, ACCEPTANCE_CONFIRM_ON_PASSING: "true" },
  });
  assert.ok(out.includes("CHILD-OK"), "child printed CHILD-OK (got: " + out.trim().slice(-400) + ")");
}

/** The child's entry point (passing-consensus path). */
async function scenarioPassingConsensus() {
  // A. confirmed → accepted without rewriting the artifact.
  {
    const v = makeVolumeDir();
    const ctx = makeCtx(v);
    script = makeDefaultScript(v.volumeDir, [jsonReply(76)], {
      confirmationReplies: [jsonReply(78), jsonReply(76)],
    });
    callLog = [];
    try {
      await cv.runVolume(ctx);
      const labels = acceptanceLabels();
      assert.strictEqual(labels.length, 3, `first grade + 2 re-grades (got ${labels.length})`);
      assert.ok(labels.some((l) => l.includes("confirm1")), "the independent re-grade ran");
      assert.ok(labels.some((l) => l.includes("confirm2")), "the temperature-0 anchor ran");
      assert.strictEqual(agentCalls("author-voice-feedback-").length, 0, "no feedback pass — the samples came from re-grading");
      assert.strictEqual(agentCalls("validator-voice-").length, 1, "no second full validator turn");
      const state = await loadState(ctx.validationOutputFile);
      assert.strictEqual(state.acceptedBy, "passing-consensus", "the state records HOW it was accepted");
      assert.deepStrictEqual(state.results, [76, 78, 76].slice(-2), "the re-grades went INTO the window (unlike the exceptional path)");
      assert.strictEqual(state.deterministicScore, 76, "the temperature-0 grade is persisted");
      assert.ok(isAcceptedState(state), "the persisted state still reads as accepted (no-AI skip check)");
      // The artifact is the compile pass's: nothing rewrote it.
      const artifact = fs.readFileSync(ctx.voiceOutputFile, "utf8");
      assert.ok(artifact.includes("v1") && !artifact.includes("revised"), "the artifact was never rewritten to collect a sample");
    } finally {
      cleanup(v.root);
    }
  }

  // B. a re-grade fails → the feedback round is the right answer, and the loop
  //    does not accept on the strength of the first passing grade alone.
  {
    const v = makeVolumeDir();
    const ctx = makeCtx(v);
    script = makeDefaultScript(v.volumeDir, [jsonReply(76), jsonReply(88)], {
      confirmationReplies: [jsonReply(41), jsonReply(77)],
    });
    callLog = [];
    try {
      await cv.runVolume(ctx);
      assert.strictEqual(agentCalls("author-voice-feedback-").length, 1, "the feedback pass ran — a re-grade disagreed with the passing grade");
      assert.strictEqual(agentCalls("validator-voice-").length, 2, "the normal second validation iteration ran");
      const state = await loadState(ctx.validationOutputFile);
      assert.ok(state.results.every((s) => s >= 70), "the failing re-grade was counted, then the window was rebuilt by real iterations");
      assert.strictEqual(state.acceptedBy, "rolling-window", "accepted by the normal criterion instead");
    } finally {
      cleanup(v.root);
    }
  }
}

// ─── confirmExceptionalScore (the helper the four chunked loops call) ─────────
// The chunked (chapter-by-chapter) QA loops keep their own inline loop, so they
// cannot use runSharedQaLoop — but they must run the SAME exceptional-score
// confirmation, or the biggest volumes (the ones most worth fast-accepting) would
// be the only ones that never got it. This pins the shared helper directly.

async function scenarioConfirmExceptionalScore() {
  const { confirmExceptionalScore } = require("../utils/qa-loop");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-confirm-"));
  const stateFile = path.join(dir, "validation-rolling-state.json");

  // A top-band grade that holds up under re-grading: accepted, and the state file
  // records HOW it was accepted plus the temperature-0 anchor score.
  const calls = [];
  // (The parent pins ACCEPTANCE_EXCEPTIONAL_SCORE=100 so the other scenarios keep
  // exercising the rolling-window path — so the exceptional grades below are 100.)
  const held = await confirmExceptionalScore({
    score: 100,
    recentRollingScores: [92],
    confirmationCheck: async ({ index, temperature }) => {
      calls.push({ index, temperature });
      return { score: 100, temperature: temperature ?? 0.2 };
    },
    volumeLabel: "Volume 01",
    stateFile,
    sourceFingerprint: "abc",
  });
  assert.strictEqual(held.accepted, true, "a consensus accepts the volume");
  assert.strictEqual(calls.length, 2, "ACCEPTANCE_CONFIRMATION_CHECKS re-grades ran");
  assert.strictEqual(calls[0].temperature, 0, "the FIRST confirmation is the temperature-0 anchor");
  const heldState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.strictEqual(heldState.acceptedBy, "exceptional-consensus");
  assert.strictEqual(heldState.deterministicScore, 100, "the temperature-0 score is recorded");

  // A fluke: the consensus collapses, the caller keeps its loop, and the
  // confirmation grades are recorded but NOT counted in the rolling window.
  calls.length = 0;
  const fluke = await confirmExceptionalScore({
    score: 100,
    recentRollingScores: [100],
    confirmationCheck: async () => ({ score: 40, temperature: 0 }),
    volumeLabel: "Volume 02",
    stateFile,
  });
  assert.strictEqual(fluke.accepted, false, "a collapsed consensus does not accept");
  const flukeState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepStrictEqual(flukeState.results, [100], "the window is NOT padded with confirmation grades");
  assert.deepStrictEqual(flukeState.rejectedConfirmations, [40, 40], "the failed consensus is recorded");

  // Nothing to confirm: a normal-band grade, a null grade, or a task that did not
  // supply a confirmation check all fall straight through to the normal loop.
  assert.strictEqual(
    (await confirmExceptionalScore({ score: 74, recentRollingScores: [74], confirmationCheck: async () => 90, volumeLabel: "V", stateFile })).accepted,
    false,
    "a passing-but-not-exceptional grade is not re-graded"
  );
  assert.strictEqual(
    (await confirmExceptionalScore({ score: null, recentRollingScores: [], confirmationCheck: async () => 95, volumeLabel: "V", stateFile })).accepted,
    false,
    "an unparseable grade is never exceptional"
  );
  assert.strictEqual(
    (await confirmExceptionalScore({ score: 100, recentRollingScores: [100], volumeLabel: "V", stateFile })).accepted,
    false,
    "no confirmation check supplied → the fast-accept path never runs"
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── the chapter-by-chapter QA loop (utils/qa-loop/chunked.js) ───────────────
// The four tasks' fallback loops are this one loop plus three stage descriptions.
// The glossary flow test drives it end to end through a real task; these drive the
// shared layer directly, so a change to the layer cannot hide behind one task.

const CHUNKED_PARTIAL =
  "# Validation partial\n\nFINDING [LOW] chapters=ch1 — one Notes cell is longer than a gloss.\n";
const CHUNKED_REPORT =
  "# Validation report\n\nThe artifact covers the chapter sources. No HIGH findings.\n\n" +
  "FINDING [LOW] chapters=ch1 — one Notes cell is longer than a gloss.\n";
/** A chat reply long enough to look like the document the validator owes (see looksLikeArtifact in utils/fs.js). */
const CHUNKED_CHAT_REPLY = `# Validation partial\n\n${"FINDING [LOW] — a finding written in chat instead of with writeFile.\n".repeat(40)}`;

/**
 * A two-chapter volume and the cfg the shared chunked loop expects.
 * @param {{volumeDir: string}} v
 * @param {Object} [overrides] - Scenario changes to the cfg.
 * @returns {{cfg: Object, artifact: string, report: string, partialFile: (id: string) => string}}
 */
function makeChunkedCfg(v, overrides = {}) {
  const chapters = [
    { id: "ch1", file: "book-ch1.md", title: "Chapter 1", bodyChars: 40 },
    { id: "ch2", file: "book-ch2.md", title: "Chapter 2", bodyChars: 40 },
  ];
  for (const s of chapters) {
    fs.writeFileSync(path.join(v.volumeDir, s.file), `# ${s.title}\n\nBody text for ${s.id}.\n`, "utf8");
  }
  const artifact = path.join(v.volumeDir, "artifact.md");
  fs.writeFileSync(
    artifact,
    `# Artifact\n\n${"A real document line the feedback round can change.\n".repeat(30)}`,
    "utf8"
  );
  const report = path.join(v.volumeDir, "artifact-validation.md");
  const partialFile = (id) => path.join(v.volumeDir, `artifact-validation-${id}.md`);

  const cfg = {
    volumeLabel: "Volume 01",
    installment: "01",
    tools: {},
    approve: async () => true,
    cwd: v.volumeDir,
    chapters,
    maxIterations: Number(process.env.QA_MAX_ITERATIONS),
    onQaLimit: "accept",
    validationOutputFile: report,
    sourceFingerprint: "fp-001",
    feedbackArtifactFiles: [artifact],
    acceptanceCheck: async () => 50,
    limitReachedLogLine: () => "Volume 01: reached the validation iteration limit without a passing grade.",
    validate: {
      name: ({ iteration, segment }) => `chunk-validator-${iteration}-${segment.id}`,
      systemPrompt: () => "You audit one chapter.",
      maxSteps: () => 10,
      prompt: ({ segment }) => `audit ${segment.id}`,
      label: ({ iteration, segment }) => `chunk-validate-${iteration}-${segment.id}`,
      writesTo: ({ segment }) => partialFile(segment.id),
      who: ({ segment }) => `the validator agent (chapter ${segment.id})`,
    },
    merge: {
      name: ({ iteration }) => `chunk-merge-${iteration}`,
      systemPrompt: () => "You consolidate the partials.",
      maxSteps: () => 10,
      prompt: () => "consolidate the partials",
      label: ({ iteration }) => `chunk-merge-${iteration}`,
      writesTo: () => report,
      who: () => "the findings-merge agent",
    },
    feedback: {
      name: ({ iteration, segment }) => `chunk-feedback-${iteration}-${segment.id}`,
      systemPrompt: () => "You apply this chapter's findings.",
      maxSteps: () => 10,
      prompt: ({ segment }) => `apply the findings for ${segment.id}`,
      label: ({ iteration, segment }) => `chunk-feedback-${iteration}-${segment.id}`,
      writesTo: () => artifact,
      who: ({ segment }) => `the author agent (feedback pass, chapter ${segment.id})`,
    },
  };
  return { cfg: { ...cfg, ...overrides }, artifact, report, partialFile };
}

/**
 * The scripted agents for a chunked-loop scenario: validators write their
 * chapter's partial, the merger consolidates it, feedback either moves the
 * artifact or (the failure the loop exists to catch) leaves it alone.
 * @param {{artifact: string, report: string, partialFile: (id: string) => string, writes?: boolean, chatReply?: boolean, silent?: boolean}} opts
 *   The files the stages owe, plus how the scripted agents behave.
 * @returns {{oneShot: () => string, agent: (name: string) => {text: string}}}
 */
function chunkedScript(opts) {
  const { artifact, report, partialFile, writes, chatReply, silent } = opts;
  return {
    oneShot: () => '{"score": 80, "band": "Pass", "note": "fixture"}',
    agent: (name) => {
      if (name.startsWith("chunk-validator-")) {
        if (silent) return { text: "" };
        if (chatReply) return { text: CHUNKED_CHAT_REPLY };
        fs.writeFileSync(partialFile(name.split("-").pop()), CHUNKED_PARTIAL, "utf8");
        return { text: "" };
      }
      if (name.startsWith("chunk-merge-")) {
        fs.writeFileSync(report, CHUNKED_REPORT, "utf8");
        return { text: "" };
      }
      if (name.startsWith("chunk-feedback-") && writes) {
        fs.appendFileSync(artifact, "\nA correction the feedback round applied.\n", "utf8");
      }
      return { text: "" };
    },
  };
}

/**
 * The loop accepts on the rolling window and stops BEFORE the second feedback
 * round — the expensive half of an iteration is not paid for twice.
 */
async function scenarioChunkedAcceptsOnRollingWindow() {
  const v = makeVolumeDir();
  const { cfg, artifact, report, partialFile } = makeChunkedCfg(v, { acceptanceCheck: async () => 80 });
  try {
    script = chunkedScript({ artifact, report, partialFile, writes: true });
    callLog = [];
    const result = await runPerChapterQaLoop(cfg);
    assert.strictEqual(result.accepted, true, "the window accepted the volume");
    assert.strictEqual(result.acceptedBy, "rolling-window", "the loop reports WHICH way it got out");
    assert.strictEqual(result.limitReached, false, "the budget was not spent");
    assert.strictEqual(agentCalls("chunk-validator-").length, 4, "two iterations × two chapters of validators");
    assert.strictEqual(agentCalls("chunk-merge-").length, 2, "one findings merge per iteration");
    assert.strictEqual(
      agentCalls("chunk-feedback-").length,
      2,
      "the feedback round ran once (the first failed grade) and not again after the accepting grade"
    );
    const state = await loadState(report);
    assert.deepStrictEqual(state.results, [80, 80], "the window holds both grades");
    assert.strictEqual(state.acceptedBy, "rolling-window", "the state records HOW it accepted");
    assert.strictEqual(isAcceptedState(state), true, "a re-run skips this volume");
  } finally {
    cleanup(v.root);
  }
}

/**
 * A feedback round that changed nothing is not progress: the loop stops, records
 * it as stalled, and does not buy another round of per-chapter validators.
 */
async function scenarioChunkedStalledRound() {
  const v = makeVolumeDir();
  const { cfg, artifact, report, partialFile } = makeChunkedCfg(v);
  try {
    script = chunkedScript({ artifact, report, partialFile, writes: false });
    callLog = [];
    const result = await runPerChapterQaLoop(cfg);
    assert.strictEqual(result.accepted, false, "a failing window does not accept");
    assert.strictEqual(result.limitReached, true, "the loop reports it stopped");
    assert.strictEqual(result.stalled, true, "and reports WHY it stopped");
    assert.strictEqual(agentCalls("chunk-validator-").length, 2, "one round of validators, not two");
    assert.strictEqual(agentCalls("chunk-feedback-").length, 2, "every chapter still got its feedback pass — that is what proved it was a no-op");
    const state = await loadState(report);
    assert.strictEqual(state.stalled, true, "the state file says 'applied nothing', not 'ran out of iterations'");
  } finally {
    cleanup(v.root);
  }
}

/**
 * A feedback round that DOES move the artifact keeps going, and the budget is
 * what ends the loop.
 */
async function scenarioChunkedIterationLimit() {
  const v = makeVolumeDir();
  const { cfg, artifact, report, partialFile } = makeChunkedCfg(v);
  try {
    script = chunkedScript({ artifact, report, partialFile, writes: true });
    callLog = [];
    const result = await runPerChapterQaLoop(cfg);
    assert.strictEqual(result.accepted, false, "no grade ever passed");
    assert.strictEqual(result.stalled, undefined, "the loop did not stop for a no-op round");
    assert.strictEqual(result.limitReached, true, "the iteration budget ended it");
    assert.strictEqual(
      agentCalls("chunk-validator-").length,
      2 * cfg.maxIterations,
      "every iteration ran its full round of per-chapter validators"
    );
  } finally {
    cleanup(v.root);
  }
}

/**
 * The turn protocol the stages share: a validator that left its file missing is
 * re-sent the task exactly once (whatever the chat reply was rescued from), and a
 * validator that still produced nothing fails loudly rather than leaving a hole
 * in the report the grader is about to read.
 */
async function scenarioChunkedTurnProtocol() {
  // (a) The reply is rescued onto disk, and the agent is asked to write it itself.
  {
    const v = makeVolumeDir();
    const { cfg, artifact, report, partialFile } = makeChunkedCfg(v, { acceptanceCheck: async () => 80 });
    try {
      script = chunkedScript({ artifact, report, partialFile, chatReply: true, writes: true });
      callLog = [];
      const result = await runPerChapterQaLoop(cfg);
      assert.strictEqual(result.accepted, true, "a rescued partial is still a real partial — the loop carried on");
      assert.strictEqual(agentCalls("chunk-validator-1-ch1").length, 2, "the task was re-sent to the same agent exactly once");
      assert.ok(fs.readFileSync(partialFile("ch1"), "utf8").includes("FINDING"), "the rescue wrote the reply into the partial");
    } finally {
      cleanup(v.root);
    }
  }
  // (b) Nothing to rescue — one re-send, then a hard stop.
  {
    const v = makeVolumeDir();
    const { cfg } = makeChunkedCfg(v);
    try {
      script = chunkedScript({ artifact: cfg.feedbackArtifactFiles[0], report: cfg.validationOutputFile, partialFile: () => "", silent: true });
      callLog = [];
      await assert.rejects(
        () => runPerChapterQaLoop(cfg),
        /never wrote real output/,
        "a validator that wrote nothing fails instead of leaving a hole in the report"
      );
      assert.strictEqual(agentCalls("chunk-validator-1-ch1").length, 2, "the task was re-sent to the same agent exactly once");
      assert.strictEqual(agentCalls("chunk-merge-").length, 0, "the loop never reached the findings merge");
    } finally {
      cleanup(v.root);
    }
  }
}

/**
 * A grader that answers nothing usable is a recorded fact, not a line on a console: the
 * state file counts the grades the loop asked for and the ones it could not read, a
 * usable grade is not counted as a failure, and a second process on the same volume adds
 * to that count instead of starting from zero.
 */
async function scenarioGradeTallyRecordsUnusableAnswers() {
  // (a) Every grade unusable: the window is empty, and the file says why.
  {
    const v = makeVolumeDir();
    const { cfg, artifact, report, partialFile } = makeChunkedCfg(v, {
      acceptanceCheck: async () => null,
    });
    try {
      script = chunkedScript({ artifact, report, partialFile, writes: true });
      callLog = [];
      const first = await runPerChapterQaLoop(cfg);
      assert.strictEqual(first.accepted, false, "a window with no grades accepts nothing");
      let state = await loadState(report);
      assert.deepStrictEqual(state.results, [], "an unusable grade is not stored in the window");
      assert.strictEqual(state.gradeAttempts, cfg.maxIterations, "every grade asked for is counted");
      assert.strictEqual(state.gradeFailures, cfg.maxIterations, "every unusable one is a failure");

      // The durable half: the next process adds to the count rather than starting over, so
      // "this volume's grader keeps failing" survives the run that saw it.
      callLog = [];
      await runPerChapterQaLoop(cfg);
      state = await loadState(report);
      assert.strictEqual(state.gradeAttempts, cfg.maxIterations * 2, "the tally carries across runs");
      assert.strictEqual(state.gradeFailures, cfg.maxIterations * 2, "including the failures");
    } finally {
      cleanup(v.root);
    }
  }

  // (b) A usable grade is not a failure, and the count separates the two.
  {
    const v = makeVolumeDir();
    let asked = 0;
    const { cfg, artifact, report, partialFile } = makeChunkedCfg(v, {
      acceptanceCheck: async () => (++asked === 1 ? null : 80),
    });
    try {
      script = chunkedScript({ artifact, report, partialFile, writes: true });
      callLog = [];
      const result = await runPerChapterQaLoop(cfg);
      assert.strictEqual(result.accepted, true, "the window filled and accepted after the first grade failed");
      const state = await loadState(report);
      assert.deepStrictEqual(state.results, [80, 80], "the window holds the grades that arrived");
      assert.strictEqual(state.gradeAttempts, 3, "three grades asked for");
      assert.strictEqual(state.gradeFailures, 1, "one of them unusable — the other two are not counted against it");
    } finally {
      cleanup(v.root);
    }
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
  scenarioExceptionalConsensusInChild();
  scenarioPassingConsensusInChild();
  await scenarioFeedbackNoOpStopsLoop();
  await scenarioConfirmExceptionalScore();
  await scenarioChunkedAcceptsOnRollingWindow();
  await scenarioChunkedStalledRound();
  await scenarioChunkedIterationLimit();
  await scenarioChunkedTurnProtocol();
  await scenarioGradeTallyRecordsUnusableAnswers();
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
} else if (childConsensus) {
  installStubs();
  scenarioExceptionalConsensus()
    .then(() => console.log("CHILD-OK"))
    .catch((err) => {
      console.error("CHILD-FAIL:", err && err.stack || err);
      process.exit(1);
    });
} else if (childPassingConsensus) {
  installStubs();
  scenarioPassingConsensus()
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
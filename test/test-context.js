/**
 * Offline tests for the delivery-layer context manager (utils/context.js).
 *
 * No AI, no network: this module is pure arithmetic plus a per-turn folder on
 * disk, so every rule in it is testable without an endpoint — which is the point.
 * The failure this module exists to fix (a 73-call diagnostics turn that spent
 * 7.2M tokens re-opening the same file because its own earlier reads had been
 * silently summarised away) is not reproducible against a live model, but the
 * mechanism that caused it is: a conversation measured with the wrong ruler,
 * trimmed at the wrong moment, and trimmed by throwing text away instead of
 * putting it somewhere retrievable. Each of those three is pinned here.
 *
 * Env is pinned explicitly at the top rather than inherited, for the reason
 * AGENTS.md gotcha 69 states: a suite that reads whatever `.env` says asserts a
 * different thing on the machine that has a live configuration than on the one
 * that does not.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
require("dotenv").config();
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ─── Pinned configuration ────────────────────────────────────────────────────
//
// The token estimate must run on the built-in coefficients so the arithmetic in
// this suite is knowable: a calibration read from the live `.env` endpoint would
// change every number asserted below.
process.env.TOKEN_CALIBRATION_ENABLED = "false";
process.env.TOKEN_ESTIMATE_MARGIN = "1.15";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-context-"));
process.env.TOKEN_CALIBRATION_FILE = path.join(tmpRoot, "token-calibration.json");

// The knobs this module reads, pinned at the values the suite reasons about.
// `contextKeepRecentTokens` is pinned far below its 40000 default so a fixture
// can be a handful of messages instead of a megabyte of text.
process.env.CONTEXT_KEEP_RECENT_TOKENS = "1000";
process.env.CONTEXT_SOFT_LIMIT = "0.7";
process.env.CONTEXT_HARD_LIMIT = "0.9";
process.env.RECALL_MAX_BYTES = "16384";
process.env.AGENT_REPEAT_LIMIT = "3";
process.env.AGENT_COMPACT_EXHAUSTION = "3";
process.env.AGENT_CONTEXT_CHUNK_STEPS = "12";
process.env.AGENT_TURN_MAX_MS = "7200000";

const ctx = require("../utils/context");
const tokens = require("../utils/tokens");
const agents = require("../utils/agents");

const CJK = "あいうえお".repeat(200); // 1000 Japanese characters
const SMALL_CJK = "かきくけこ".repeat(40); // 200 characters

function cjk(n) {
  return "あ".repeat(n);
}

/**
 * One read round in the shape the AI SDK v6 actually puts on the wire: an
 * assistant message carrying the tool CALL, then a tool message carrying the
 * RESULT. `input` is on the result part because `offload` reads it to work out
 * which file the payload came from (utils/context.js `sourceFilesOf`).
 */
function readRound(k, payloadChars, tool = "readFile") {
  const filePath = `src/v01/chapter-${k}.md`;
  const input = { filePath };
  return [
    {
      role: "assistant",
      content: [
        { type: "text", text: `reading chapter ${k}` },
        { type: "tool-call", toolCallId: `call-${k}`, toolName: tool, input },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${k}`,
          toolName: tool,
          input,
          output: { type: "json", value: { text: cjk(payloadChars) } },
        },
      ],
    },
  ];
}

function conversation(rounds, payloadChars = 1000) {
  const messages = [{ role: "user", content: "Answer this ticket: why did volume 15 fail?" }];
  for (let k = 1; k <= rounds; k++) messages.push(...readRound(k, payloadChars));
  return messages;
}

function clone(messages) {
  return JSON.parse(JSON.stringify(messages));
}

function newRunDir(name) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${name}-`));
  return dir;
}

function offloadOne(messages, extra = {}) {
  const runDir = newRunDir("run");
  return {
    runDir,
    result: ctx.offload({
      runDir,
      agentName: "diagnostics",
      turn: 1,
      chunk: 1,
      messages: clone(messages),
      targetTokens: 4000,
      ...extra,
    }),
  };
}

// ─── 1. Which roles get context management ───────────────────────────────────
//
// Design R1: compaction belongs to the delivery layer ONLY. A pipeline stage
// agent's whole job is to hold the volume it is processing in mind, so a role
// name list is the load-bearing line in this module — the mistake this feature
// could make is to "help" the glossary author by summarising the book it is
// reading (AGENTS.md gotcha 56, gotcha 64).
{
  assert.deepStrictEqual(ctx.CONTEXT_MANAGED_ROLES, ["diagnostics", "devteam"]);
  assert.strictEqual(ctx.contextManagementEnabled("diagnostics"), true);
  assert.strictEqual(ctx.contextManagementEnabled("devteam"), true);

  // Every pipeline-stage handle name in this project must be OUTSIDE the list.
  const stageNames = [
    "glossary-research",
    "glossary-amend",
    "glossary-validator",
    "glossary-feedback",
    "glossary-findings-merge",
    "character-voice-compile",
    "character-voice-validator",
    "style-guide-compile",
    "jump-in-wiki-author",
    "jump-in-wiki-merge",
    "consistency-audit",
    "intake",
  ];
  for (const name of stageNames) {
    assert.strictEqual(
      ctx.contextManagementEnabled(name),
      false,
      `${name} must NOT get context management: a stage agent keeps everything in context`
    );
  }
  // An unknown name is not managed either: the list is opt-in, not a default.
  assert.strictEqual(ctx.contextManagementEnabled("something-new"), false);
  console.log("[context] managed roles are exactly the delivery layer");
}

// ─── 2. Configuration readers and their floors ───────────────────────────────
{
  assert.strictEqual(ctx.contextChunkSteps(), 12);
  assert.strictEqual(ctx.contextSoftLimit(), 0.7);
  assert.strictEqual(ctx.contextHardLimit(), 0.9);
  assert.strictEqual(ctx.contextKeepRecentTokens(), 1000);
  assert.strictEqual(ctx.recallMaxBytes(), 16384);
  assert.strictEqual(ctx.agentRepeatLimit(), 3);
  assert.strictEqual(ctx.agentCompactExhaustion(), 3);
  assert.strictEqual(ctx.agentTurnMaxMs(), 7200000);

  // A garbage or too-small value falls back to the tuned default rather than
  // producing a chunk size of 0 (which would make every turn zero steps long).
  process.env.AGENT_CONTEXT_CHUNK_STEPS = "0";
  assert.strictEqual(ctx.contextChunkSteps(), 12, "a chunk size of 0 is refused");
  process.env.AGENT_CONTEXT_CHUNK_STEPS = "abc";
  assert.strictEqual(ctx.contextChunkSteps(), 12);
  process.env.AGENT_CONTEXT_CHUNK_STEPS = "5";
  assert.strictEqual(ctx.contextChunkSteps(), 5);
  process.env.AGENT_CONTEXT_CHUNK_STEPS = "12";

  // A soft limit outside (0,1) is refused: 0 would offload on every step and 1
  // would never offload at all, and both look like a working setting.
  process.env.CONTEXT_SOFT_LIMIT = "0";
  assert.strictEqual(ctx.contextSoftLimit(), 0.7);
  process.env.CONTEXT_SOFT_LIMIT = "1";
  assert.strictEqual(ctx.contextSoftLimit(), 0.7);
  process.env.CONTEXT_SOFT_LIMIT = "0.5";
  assert.strictEqual(ctx.contextSoftLimit(), 0.5);
  // The hard limit can never sit BELOW the soft one, or the "FULL" message would
  // fire before the "getting full" one.
  process.env.CONTEXT_HARD_LIMIT = "0.2";
  assert.strictEqual(ctx.contextHardLimit(), 0.5, "hard limit is clamped up to the soft limit");
  process.env.CONTEXT_HARD_LIMIT = "1";
  assert.strictEqual(ctx.contextHardLimit(), 0.9);
  process.env.CONTEXT_SOFT_LIMIT = "0.7";
  process.env.CONTEXT_HARD_LIMIT = "0.9";

  // Floors: a keep-recent window under 1000 tokens would protect nothing, and a
  // recall under 512 bytes could not return a usable excerpt.
  process.env.CONTEXT_KEEP_RECENT_TOKENS = "500";
  assert.strictEqual(ctx.contextKeepRecentTokens(), 40000, "the 1000-token floor is enforced");
  process.env.CONTEXT_KEEP_RECENT_TOKENS = "1000";
  process.env.RECALL_MAX_BYTES = "100";
  assert.strictEqual(ctx.recallMaxBytes(), 16384, "the 512-byte floor is enforced");
  process.env.RECALL_MAX_BYTES = "16384";

  // A repeat limit of 1 would call the SECOND call of a normal two-step lookup a
  // loop, so the minimum is 2. Same reasoning for the exhaustion counter.
  process.env.AGENT_REPEAT_LIMIT = "1";
  assert.strictEqual(ctx.agentRepeatLimit(), 3);
  process.env.AGENT_REPEAT_LIMIT = "4";
  assert.strictEqual(ctx.agentRepeatLimit(), 4);
  process.env.AGENT_REPEAT_LIMIT = "3";
  process.env.AGENT_COMPACT_EXHAUSTION = "1";
  assert.strictEqual(ctx.agentCompactExhaustion(), 3);
  process.env.AGENT_COMPACT_EXHAUSTION = "3";

  // 0 means "no ceiling", which is a legal answer, not a fallback.
  process.env.AGENT_TURN_MAX_MS = "0";
  assert.strictEqual(ctx.agentTurnMaxMs(), 0, "0 disables the turn ceiling");
  process.env.AGENT_TURN_MAX_MS = "60000";
  assert.strictEqual(ctx.agentTurnMaxMs(), 60000);
  process.env.AGENT_TURN_MAX_MS = "7200000";
  console.log("[context] configuration readers and floors");
}

// ─── 3. The ruler (defect B) ─────────────────────────────────────────────────
//
// The library estimates `JSON.stringify(messages).length / 4`. For Japanese that
// is wrong by roughly 2.5×, and the direction of the error is the dangerous one:
// under-counting means the trim fires late, or never. The live turn that started
// this work reported a final step of ~360,000 tokens against a 262,144-token
// window, which no /4 estimate would ever have seen.
{
  const messages = [{ role: "user", content: CJK }];
  const mine = ctx.estimateMessagesTokens(messages);
  const library = ctx.naiveLibraryEstimate(messages);

  // Built-in coefficients, no calibration in a test process: 1000 CJK chars →
  // ceil(1000 × 0.69 × 1.15) = 794.
  assert.strictEqual(mine, 794, "the estimate is the calibrated coefficients × the margin");
  assert.ok(library < 300, `the library's ruler says ${library} for text that costs ~690`);
  assert.ok(mine / library >= 2.5, "the two rulers differ by the measured 2.5×, not by opinion");

  // The estimate must stay an OVER-estimate against the highest tokens-per-
  // character the live series measured (0.622 — utils/tokens.js, gotcha 54).
  assert.ok(mine / 1000 >= 0.622, "must not under-count a real Japanese volume");

  // A tool result is JSON, and its braces and quotes are billed too.
  const round = readRound(1, 1000);
  const roundTokens = ctx.estimateMessagesTokens(round);
  assert.ok(roundTokens > 794, "the JSON punctuation around a payload is counted");

  // The per-request chat template is NOT billed here: it is charged once, in
  // `tokenBudgetFor` (gotcha 54). An agent turn is many messages, not one block.
  // Measuring the whole conversation must therefore land on the sum of its
  // messages, not on that sum plus 52 per message. The only slack allowed is the
  // rounding the single ceiling takes compared to one ceiling per message.
  const many = conversation(4);
  const whole = ctx.estimateMessagesTokens(many);
  const parts = many.map((m) => ctx.estimateMessagesTokens([m])).reduce((a, b) => a + b, 0);
  assert.ok(whole <= parts, `one ceiling for the whole conversation, not one per message (${whole} vs ${parts})`);
  assert.ok(parts - whole <= many.length, `the only difference is rounding, not a per-message charge (${parts} - ${whole})`);
  // The direct half of the same rule: a message with nothing in it costs nothing.
  // A chat-template charge would report 52 for it, once per message.
  assert.strictEqual(ctx.estimateMessagesTokens([{ role: "user", content: "" }]), 0,
    "the chat wrapper is not billed per message");

  // Empty and malformed input estimate as zero rather than throwing.
  assert.strictEqual(ctx.estimateMessagesTokens([]), 0);
  assert.strictEqual(ctx.estimateMessagesTokens(null), 0);
  assert.strictEqual(ctx.estimateMessagesTokens([{ role: "user", content: null }]), 0);
  console.log(`[context] ruler: 1000 CJK chars → ${mine} estimated vs ${library} by the library's rule`);
}

// ─── 4. Pressure: which measurement wins, and where the lines sit ────────────
{
  const messages = conversation(2);
  const estimated = ctx.estimateMessagesTokens(messages);

  // The server's own count wins when it is larger — it is authoritative.
  const p = ctx.windowPressure({ lastInputTokens: 200000, messages, contextWindow: 262144 });
  assert.strictEqual(p.reported, 200000);
  assert.strictEqual(p.estimated, estimated);
  assert.strictEqual(p.tokens, 200000, "the larger measurement wins");
  assert.strictEqual(p.level, "soft", "200,000 of 262,144 is 76% — past the soft line, not the hard one");

  // A server that reports no usage at all (test/fake-backend.js can script that)
  // must not make the window look empty.
  const q = ctx.windowPressure({ lastInputTokens: 0, messages, contextWindow: 262144 });
  assert.strictEqual(q.tokens, estimated, "the estimate carries a server that reports nothing");

  // Level boundaries.
  const soft = ctx.windowPressure({ lastInputTokens: Math.ceil(262144 * 0.7), messages, contextWindow: 262144 });
  assert.strictEqual(soft.level, "soft");
  const justUnder = ctx.windowPressure({ lastInputTokens: Math.ceil(262144 * 0.7) - 1, messages, contextWindow: 262144 });
  assert.strictEqual(justUnder.level, "ok");
  const hard = ctx.windowPressure({ lastInputTokens: Math.ceil(262144 * 0.9), messages, contextWindow: 262144 });
  assert.strictEqual(hard.level, "hard");

  // No window configured means no pressure reading, not a division by zero and
  // not an invented limit (the same honesty rule as `answerRoom`).
  const none = ctx.windowPressure({ lastInputTokens: 500000, messages, contextWindow: 0 });
  assert.strictEqual(none.window, 0);
  assert.strictEqual(none.fraction, 0);
  assert.strictEqual(none.level, "ok");
  assert.strictEqual(ctx.pressureLine(none), "", "no window means no pressure line");
  console.log("[context] pressure measurement takes the larger of server and estimate");
}

// ─── 5. The pressure line (the mechanism ACM measured actually works) ────────
//
// The paper's case study is that frontier models call context tools ~zero times
// unless something in the transcript tells them their window is filling. So the
// exact wording is the feature, and it is pinned exactly.
{
  const ok = ctx.windowPressure({ lastInputTokens: 57500, messages: [], contextWindow: 262144 });
  assert.strictEqual(ok.level, "ok");
  assert.strictEqual(
    ctx.pressureLine(ok),
    "| working window: 57,500 / 262,144 tokens (22%)"
  );

  const soft = ctx.windowPressure({ lastInputTokens: 200000, messages: [], contextWindow: 262144 });
  assert.strictEqual(soft.level, "soft");
  const softLine = ctx.pressureLine(soft);
  assert.ok(softLine.includes("getting full"));
  assert.ok(softLine.includes("BEFORE your next read"), "the instruction lands before the read that would overflow");

  const hard = ctx.windowPressure({ lastInputTokens: 250000, messages: [], contextWindow: 262144 });
  assert.strictEqual(hard.level, "hard");
  const hardLine = ctx.pressureLine(hard);
  assert.ok(hardLine.includes("FULL"));
  assert.ok(hardLine.includes("manage_context"), "the line names the tool, not a vague suggestion");

  // A tool result that is a plain string gets the line appended.
  const asString = ctx.annotateToolResult("file contents here", ok);
  assert.ok(asString.startsWith("file contents here\n| working window:"));

  // A tool result that is an object joins it into the `status` line the fs tools
  // already return, without inventing one where none existed.
  const obj = ctx.annotateToolResult({ status: "Read 12 lines.", content: "x" }, ok);
  assert.ok(obj.status.startsWith("Read 12 lines. | working window:"));
  assert.strictEqual(obj.content, "x", "the payload is untouched");
  const noStatus = ctx.annotateToolResult({ content: "x" }, ok);
  assert.ok(noStatus.status.startsWith("| working window:"));

  // An array result is left alone rather than corrupted into an object.
  const arr = ctx.annotateToolResult(["a", "b"], ok);
  assert.deepStrictEqual(arr, ["a", "b"]);
  console.log("[context] the pressure line reaches every tool result shape");
}

// ─── 6. What may never be offloaded (design R3/R4/R5/R6) ─────────────────────
{
  const protectedNames = ["writeFile", "editFile", "deleteFile"];
  for (const name of protectedNames) {
    assert.ok(ctx.NEVER_OFFLOADED_TOOLS.includes(name), `${name} results must stay verbatim`);
  }
  assert.ok(!ctx.NEVER_OFFLOADED_TOOLS.includes("readFile"), "a read is what offloading is FOR");

  // `toolResultIsProtected` judges one tool-result PART, which is what `offload`
  // hands it while walking the conversation.
  const okResult = (name = "readFile") => ({
    type: "tool-result", toolCallId: "c", toolName: name, input: {}, output: { type: "json", value: { text: "x" } },
  });
  assert.strictEqual(ctx.toolResultIsProtected(okResult()), false);
  for (const name of protectedNames) {
    assert.strictEqual(ctx.toolResultIsProtected(okResult(name)), true, `a ${name} answer is the record of the agent's own work`);
  }

  // Provider-level tool failures.
  assert.strictEqual(
    ctx.toolResultIsProtected({ type: "tool-result", toolCallId: "c", toolName: "readFile", output: { type: "error-text", value: "ENOENT" } }),
    true
  );
  assert.strictEqual(
    ctx.toolResultIsProtected({ type: "tool-result", toolCallId: "c", toolName: "readFile", output: { type: "error-json", value: { error: "nope" } } }),
    true
  );
  // The harness's own refusals arrive as a plain {error} / {refused} VALUE, not
  // as a provider error part — a denied write must not be offloaded out of the
  // transcript, because "did this role try to write?" is a fact the record needs.
  assert.strictEqual(
    ctx.toolResultIsProtected({ type: "tool-result", toolCallId: "c", toolName: "writeFile", output: { type: "json", value: { error: "refused" } } }),
    true
  );
  assert.strictEqual(
    ctx.toolResultIsProtected({ type: "tool-result", toolCallId: "c", toolName: "readFile", output: { type: "json", value: { refused: "not allowed" } } }),
    true
  );

  // Not a tool result at all, or a missing output: protected by default, because
  // guessing here is how load-bearing text gets moved.
  assert.strictEqual(ctx.toolResultIsProtected({ type: "text", text: "hi" }), true);
  assert.strictEqual(ctx.toolResultIsProtected({ type: "tool-call", toolCallId: "c", toolName: "readFile" }), true);
  assert.strictEqual(ctx.toolResultIsProtected({ type: "tool-result", toolCallId: "c", toolName: "readFile" }), true);
  assert.strictEqual(ctx.toolResultIsProtected(null), true);
  console.log("[context] edits, refusals and errors are never offloaded");
}

// ─── 7. Offload: the core guarantee ──────────────────────────────────────────
//
// The promise is "nothing is discarded, it is moved". So the test is not only
// "the conversation got smaller" but "every tool call is still answerable and
// the text is on disk with a pointer to it".
{
  const messages = conversation(6);
  const before = ctx.estimateMessagesTokens(messages);
  const { runDir, result } = offloadOne(messages);

  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(result.offloadedCount, 5, "five of six read payloads move; the most recent round stays");
  assert.ok(result.tokensAfter < result.tokensBefore, "the conversation got smaller");
  assert.strictEqual(result.tokensBefore, before);
  assert.strictEqual(result.reason, "soft-limit");

  // The input array is not mutated — the harness keeps its own copy and a
  // half-mutated conversation is worse than an untrimmed one.
  const original = clone(messages);
  assert.deepStrictEqual(messages, original, "offload() must not mutate the caller's array");

  // Every tool call is still in the conversation, and its RESULT part is still
  // there (replaced by a pointer). Dropping the part outright would leave a
  // tool call with no answer, which several servers reject outright.
  const idsBefore = new Set();
  for (const m of messages) {
    for (const part of m.content ?? []) if (part.type === "tool-call") idsBefore.add(part.toolCallId);
  }
  const idsAfter = new Set();
  for (const m of result.messages) {
    for (const part of m.content ?? []) {
      if (part.type === "tool-call") idsAfter.add(part.toolCallId);
      if (part.type === "tool-result") idsAfter.add(part.toolCallId);
    }
  }
  assert.deepStrictEqual([...idsAfter], [...idsBefore], "no tool call is orphaned");

  // The assistant's own messages — including its tool CALLS with their arguments
  // — are untouched. `crossCheckReads` (utils/diagnostics.js) reads those calls
  // to prove the answer's claims; offloading them would break that check.
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant") {
      assert.deepStrictEqual(result.messages[i], messages[i], "the agent's own turns are never rewritten");
    }
  }

  // Pointers: exactly ONE map block for the whole conversation, and a one-line
  // pointer for every other moved payload.
  const serialized = JSON.stringify(result.messages);
  const landmarkCount = (serialized.match(/\[context offload /g) ?? []).length;
  assert.strictEqual(landmarkCount, 1, "one map block, not one per offload — a map per chunk is its own kind of bloat");
  const pointerCount = (serialized.match(/\[offloaded /g) ?? []).length;
  assert.strictEqual(pointerCount, result.offloadedCount - 1, "the rest are one-line pointers");
  assert.ok(result.landmark.includes("Nothing was discarded."));
  assert.ok(result.landmark.includes("recall_memory("), "the pointer says how to get the text back");

  // The most recent work is intact, byte for byte.
  const tail = result.messages.slice(-2);
  assert.deepStrictEqual(tail, messages.slice(-2), "the recent tail is not trimmed");

  // The record on disk is readable and complete.
  const record = JSON.parse(fs.readFileSync(result.file, "utf8"));
  assert.strictEqual(record.schema, 1);
  assert.strictEqual(record.id, result.id);
  assert.strictEqual(record.agent, "diagnostics");
  assert.strictEqual(record.turn, 1);
  assert.strictEqual(record.offloaded.length, result.offloadedCount);
  // The record names the ACTUAL size of the protected tail, which is at least the
  // configured window (the walk stops at the message that crossed it, so it counts
  // that message too) and never the whole conversation.
  assert.ok(record.kept.recentTokens >= 1000, `the tail kept is at least the configured window (${record.kept.recentTokens})`);
  assert.ok(record.kept.recentTokens < result.tokensBefore, "the protected tail is not the whole conversation");
  assert.ok(record.offloaded[0].result, "the RAW payload is stored, not a description of it");
  assert.deepStrictEqual(record.offloaded[0].sourceFiles, ["src/v01/chapter-1.md"]);
  assert.ok(record.offloaded[0].bytes > 0);
  assert.strictEqual(result.dir, path.join(runDir, "agent-diagnostics", "turn-001-memory"));
  assert.ok(fs.existsSync(result.dir));
  console.log(`[context] offload moved ${result.offloadedCount} payloads: ${result.tokensBefore} → ${result.tokensAfter} tokens`);
}

// ─── 8. The boundary: a conversation that is already small offloads NOTHING ──
//
// This is the bug that would have made the feature a no-op in the common case:
// with `boundary = list.length - 1` the newest message is always eligible, and a
// short conversation gets trimmed for no reason. A conversation smaller than the
// keep-recent window must be left completely alone.
{
  const messages = [{ role: "user", content: "short ticket" }, ...readRound(1, 600)];
  const { runDir, result } = offloadOne(messages);
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes("nothing was eligible to offload"), result.error);
  assert.deepStrictEqual(result.messages, messages, "the conversation is returned unchanged");
  assert.strictEqual(fs.existsSync(result.dir), false, "no folder is created for an offload that did not happen");
  assert.strictEqual(runDir !== null, true);
  console.log("[context] a conversation inside the keep-recent window is not touched");
}

// ─── 9. A payload too small to be worth a file is skipped ────────────────────
{
  // Rounds 1-2 are tiny, rounds 3-4 are big. The boundary crosses at round 3, so
  // rounds 1-2 are old enough to move but too small to be worth a file.
  const messages = [{ role: "user", content: "ticket" },
    ...readRound(1, 200), ...readRound(2, 200), ...readRound(3, 1000), ...readRound(4, 1000)];
  const { result } = offloadOne(messages);
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(result.offloadedCount, 1, "only the one payload worth moving moved");
  const serialized = JSON.stringify(result.messages);
  assert.ok(!serialized.includes('"text":"かきくけこ'), "a 200-character answer is left where it is");
  console.log("[context] a payload under 512 characters is not worth a file");
}

// ─── 10. Protected results are counted, not moved ────────────────────────────
{
  const messages = [{ role: "user", content: "ticket" },
    ...readRound(1, 1000),
    ...readRound(2, 1000, "writeFile"),
    ...readRound(3, 1000),
    ...readRound(4, 1000)];
  // Make round 2's result look like a real edit answer, and round 3's a refused
  // read. Both keep a payload the size of a real read: a protected result that is
  // nearly empty would shrink the conversation enough to move the keep-recent
  // boundary backwards, and the two results would end up protected by POSITION
  // instead of by content — which is not the thing this group is checking.
  messages[4].content[0].output = {
    type: "json",
    value: { status: "Edited 3 lines.", filePath: "src/v01/chapter-2.md", detail: cjk(1000) },
  };
  messages[6].content[0].output = {
    type: "error-text",
    value: `ENOENT: no such file — ${cjk(1000)}`,
  };

  const { result } = offloadOne(messages);
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(result.offloadedCount, 1, "only the one ordinary read payload moved");
  assert.strictEqual(result.kept.writeCalls, 1, "the agent's own edit result stayed");
  assert.strictEqual(result.kept.refusals, 1, "the refusal stayed");
  assert.ok(JSON.stringify(result.messages).includes("Edited 3 lines."), "a write result is verbatim");
  assert.ok(JSON.stringify(result.messages).includes("ENOENT"), "a refusal is verbatim");
  console.log("[context] edits and refusals are kept and counted");
}

// ─── 11. A failed write aborts and the conversation is untouched ─────────────
{
  const runDir = path.join(newRunDir("broken"), "not-a-directory");
  fs.writeFileSync(runDir, "a file where a folder should be");
  const messages = conversation(6);
  const result = ctx.offload({
    runDir,
    agentName: "diagnostics",
    turn: 1,
    chunk: 1,
    messages: clone(messages),
    targetTokens: 4000,
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes("could not be written"), result.error);
  assert.ok(result.error.includes("nothing was removed from the conversation"));
  assert.deepStrictEqual(result.messages, messages, "a failed offload cannot mutate the conversation");
  console.log("[context] a failed offload leaves the conversation exactly as it was");
}

// ─── 12. The map block is capped, so the map cannot become the new bloat ─────
{
  const { result } = offloadOne(conversation(16));
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(result.offloadedCount, 15);
  const lines = result.landmark.split("\n");
  const lookupLines = lines.filter((l) => l.includes("readFile  "));
  assert.strictEqual(lookupLines.length, 11, "the map lists at most 11 lookups");
  assert.ok(result.landmark.includes("+4 more"), "the rest are counted, not hidden");
  // Each line names the tool, the file, and the size — enough to decide whether
  // to recall it without recalling it blind.
  assert.ok(lookupLines[0].includes("src/v01/chapter-1.md"));
  assert.ok(lookupLines[0].includes("KB"));
  console.log("[context] the map block is capped and says what it left out");
}

// ─── 13. recall: getting the text back ───────────────────────────────────────
{
  const { runDir, result } = offloadOne(conversation(6));
  const dir = result.dir;

  const hit = ctx.recall({ dir, query: cjk(30) });
  assert.strictEqual(hit.error, null);
  assert.ok(hit.matchedCount >= 1, "a substring of an offloaded payload finds it");
  assert.strictEqual(hit.matched[0].id, result.id);
  assert.strictEqual(hit.matched[0].tool, "readFile");
  assert.deepStrictEqual(hit.matched[0].sourceFiles, ["src/v01/chapter-1.md"]);
  assert.strictEqual(hit.matched[0].sourceFile, "src/v01/chapter-1.md");
  assert.ok(hit.note.includes("readFile"), "the note names the whole-file route back");
  assert.ok(hit.note.includes("src/v01/chapter-1.md"), "the note names the file, not just 'the source'");

  // Case-insensitive, because a model does not know which case it saw.
  const latin = ctx.offload({
    runDir: newRunDir("latin"),
    agentName: "devteam",
    turn: 1,
    chunk: 1,
    messages: [
      { role: "user", content: "ticket" },
      // A real grep answer: several matches, all in one file. It has to be big enough
      // to be worth offloading (the small-payload rule skips anything under 512 chars),
      // otherwise there is nothing on disk to recall and the case tests nothing.
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "grep", input: { dirPath: "utils", pattern: "CarryForward" } }] },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "a",
          toolName: "grep",
          input: { dirPath: "utils", pattern: "CarryForward" },
          output: {
            type: "json",
            value: {
              matches: [
                { filePath: "utils/glossary.js", line: "function compareGlossaryCarryForward(previous, current) {" },
                { filePath: "utils/glossary.js", line: "  const missing = compareGlossaryCarryForward(baseline, terms);" },
                { filePath: "utils/glossary.js", line: "function assertGlossaryCarryForward(ctx, baseline) {" },
                { filePath: "utils/glossary.js", line: "  const result = compareGlossaryCarryForward(baseline, current);" },
                { filePath: "utils/glossary.js", line: "function guardCarryForwardAgainst(ctx, baseline, stageLabel) {" },
                { filePath: "utils/glossary.js", line: "  const result = compareGlossaryCarryForward(baseline, parseGlossaryTableTerms(text));" },
                { filePath: "utils/glossary.js", line: "function reportCarryForwardLoss(taskName, volumeLabel, result) {" },
                { filePath: "utils/glossary.js", line: "  if (!GLOSSARY_CARRY_FORWARD_GUARD) return null;" },
              ],
            },
          },
        }],
      },
      ...readRound(2, 1000),
      ...readRound(3, 1000),
    ],
    targetTokens: 4000,
  });
  assert.strictEqual(latin.ok, true, latin.error);
  const found = ctx.recall({ dir: latin.dir, query: "compareglossarycarryforward" });
  assert.strictEqual(found.matchedCount, 1);
  assert.ok(found.matched[0].excerpt.includes("compareGlossaryCarryForward"));
  assert.deepStrictEqual(found.matched[0].sourceFiles, ["utils/glossary.js"], "the grep result's own file is carried through");

  // A query that matches nothing says so, and names what it looked for.
  const miss = ctx.recall({ dir, query: "a phrase that is definitely not in this turn" });
  assert.strictEqual(miss.matchedCount, 0);
  assert.ok(miss.error.includes('no offloaded text from this turn matches "a phrase that is definitely not in this turn"'));

  // An empty query is a usage error, not a search for everything.
  const empty = ctx.recall({ dir, query: "" });
  assert.strictEqual(empty.error, "recall_memory needs a query: the text you are looking for.");

  // A missing folder is reported, not silently empty.
  const gone = ctx.recall({ dir: path.join(dir, "nope"), query: "anything" });
  assert.ok(gone.error.startsWith("no offloaded text for this turn ("));

  // The byte budget truncates rather than returning the whole archive, because a
  // recall that returns everything is an offload that never happened. And it is a
  // BYTE budget: this corpus is three bytes per character, so cutting by character
  // count would return three times what the budget promises.
  const tight = ctx.recall({ dir, query: cjk(30), limitBytes: 600 });
  assert.strictEqual(tight.truncated, true);
  let bytes = 0;
  for (const m of tight.matched) bytes += Buffer.byteLength(m.excerpt, "utf8");
  assert.ok(bytes <= 600, `the budget is honoured in bytes (${bytes} bytes)`);
  assert.ok(tight.matched[0].excerpt.length > 150, "600 BYTES of Japanese is far fewer characters than 600");
  assert.ok(!tight.matched[0].excerpt.includes("\uFFFD"), "a character is never cut in half");

  // Scoping to one record reads only that record.
  const scoped = ctx.recall({ dir, query: cjk(30), id: result.id });
  assert.strictEqual(scoped.filesRead, 1);
  const wrongId = ctx.recall({ dir, query: cjk(30), id: "ctx-not-a-real-id" });
  assert.strictEqual(wrongId.matchedCount, 0);
  assert.strictEqual(wrongId.filesRead, 0, "a record whose id does not match is not read at all");
  console.log("[context] recall finds offloaded text by substring, within a byte budget");
}

// ─── 14. A half-written record is skipped, not trusted ───────────────────────
{
  const { runDir, result } = offloadOne(conversation(6));
  const dir = result.dir;
  const names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  assert.strictEqual(names.length, 1);
  // Simulate a crash mid-write: valid JSON, no payload.
  fs.writeFileSync(path.join(dir, names[0]), JSON.stringify({ schema: 1, id: result.id }));
  const hit = ctx.recall({ dir, query: cjk(30) });
  assert.strictEqual(hit.matchedCount, 0, "a record with no offloaded[] is not a source of text");
  assert.ok(hit.error.includes("no offloaded text from this turn matches"));

  const listed = ctx.listOffloads(dir);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].offloadedCount, 0);

  // A file that is not JSON at all is skipped rather than making the whole
  // listing throw (the `readUsableManifest` rule, gotcha 33).
  fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
  const listed2 = ctx.listOffloads(dir);
  assert.strictEqual(listed2.length, 1, "an unreadable record reports nothing rather than guessing");
  assert.strictEqual(ctx.listOffloads(path.join(dir, "missing")).length, 0);
  console.log("[context] a half-written or corrupt offload record is skipped, not trusted");
}

// ─── 15. callKey: what counts as the same lookup ─────────────────────────────
{
  const a = ctx.callKey("readFile", { filePath: "a.md" });
  const b = ctx.callKey("readFile", { filePath: "a.md" });
  const c = ctx.callKey("readFile", { filePath: "b.md" });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  // Argument order is not meaning: the same call written two ways is the same call.
  assert.strictEqual(
    ctx.callKey("grep", { dirPath: "utils", pattern: "x" }),
    ctx.callKey("grep", { pattern: "x", dirPath: "utils" })
  );
  assert.notStrictEqual(ctx.callKey("grep", { dirPath: "utils" }), ctx.callKey("readFile", { dirPath: "utils" }));
  // A missing input is not a crash.
  assert.strictEqual(typeof ctx.callKey("readFile", undefined), "string");
  // A circular argument must not hang the key builder.
  const circular = { name: "x" };
  circular.self = circular;
  assert.ok(ctx.callKey("tool", circular).includes("[circular]"));
  console.log("[context] the same lookup is recognised whatever order its arguments came in");
}

// ─── 16. The repeat detector: a spin, not a spending limit ───────────────────
//
// Design R7: the wall on an uncapped turn is repetition plus a loose clock. The
// two directions that are easy to get wrong are pinned here: an errored call is
// NOT a repeat of an answered one (the agent changed what it tried), but the
// IDENTICAL error repeated IS a spin — that is exactly the shape of a turn that
// re-opens the same unreadable file forever.
{
  const det = ctx.repeatDetector({ limit: 3 });
  const key = ctx.callKey("readFile", { filePath: "a.md" });

  const first = det.observe({ name: "readFile", input: { filePath: "a.md" }, output: { text: "contents" } });
  assert.strictEqual(first, null, "the first call is not a repeat");
  assert.strictEqual(det.counts().distinct, 1);

  // Same call, DIFFERENT answer (e.g. a paged read with a different offset) is
  // not a spin — the agent is making progress.
  const second = det.observe({ name: "readFile", input: { filePath: "a.md", offset: 200 }, output: { text: "more contents" } });
  assert.strictEqual(second, null);
  assert.strictEqual(det.counts().distinct, 2);

  // Same call, same answer, twice: still under the limit.
  assert.strictEqual(det.observe({ name: "grep", input: { dirPath: "utils" }, output: { matches: [] } }), null);
  assert.strictEqual(det.observe({ name: "grep", input: { dirPath: "utils" }, output: { matches: [] } }), null);
  const third = det.observe({ name: "grep", input: { dirPath: "utils" }, output: { matches: [] } });
  assert.ok(third && third.repeated === true, "the third identical call is the spin");
  assert.strictEqual(third.count, 3);
  assert.strictEqual(third.key, ctx.callKey("grep", { dirPath: "utils" }));

  // An error followed by a success is not a repeat of anything.
  const det2 = ctx.repeatDetector({ limit: 2 });
  assert.strictEqual(det2.observe({ name: "readFile", input: { filePath: "a.md" }, error: "ENOENT" }), null);
  const notRepeat = det2.observe({ name: "readFile", input: { filePath: "a.md" }, output: { text: "found it" } });
  assert.strictEqual(notRepeat, null, "a call that failed is not a repeat of the one that worked");

  // The identical FAILURE repeated is a spin, and it must be caught: this is the
  // real shape of a stuck turn.
  const det3 = ctx.repeatDetector({ limit: 2 });
  assert.strictEqual(det3.observe({ name: "readFile", input: { filePath: "gone.md" }, error: "ENOENT" }), null);
  const spin = det3.observe({ name: "readFile", input: { filePath: "gone.md" }, error: "ENOENT" });
  assert.ok(spin && spin.repeated === true, "the same failed lookup twice in a row is a loop");

  // A call with no name (a malformed tool call) is not evidence of anything.
  assert.strictEqual(det3.observe({}), null);
  assert.strictEqual(det3.observe(null), null);
  console.log("[context] the repeat detector catches a spin in both directions");
}

// ─── 17. Compaction exhaustion: "does not fit" is a different answer ─────────
//
// Design §9 test 9: when trimming repeatedly removes text and the turn still
// makes no new work, the honest report is "this does not fit", not "let me
// summarise it harder".
{
  const det = ctx.exhaustionDetector({ limit: 3 });
  assert.strictEqual(det.consecutive(), 0);

  // A trim that let the agent do new work is not exhaustion.
  assert.strictEqual(det.observe({ trimmed: true, newDistinctCalls: 1 }), false);
  assert.strictEqual(det.consecutive(), 0, "new distinct work resets the count");

  // Three trims with no new distinct work is the signal.
  assert.strictEqual(det.observe({ trimmed: true, newDistinctCalls: 0 }), false);
  assert.strictEqual(det.observe({ trimmed: true, newDistinctCalls: 0 }), false);
  assert.strictEqual(det.observe({ trimmed: true, newDistinctCalls: 0 }), true);
  assert.strictEqual(det.consecutive(), 3);

  // A chunk that needed no trim at all also resets it: the pressure went away.
  const det2 = ctx.exhaustionDetector({ limit: 2 });
  det2.observe({ trimmed: true, newDistinctCalls: 0 });
  assert.strictEqual(det2.observe({ trimmed: false, newDistinctCalls: 0 }), false);
  assert.strictEqual(det2.consecutive(), 0);
  console.log("[context] repeated trims with no new work are reported as exhaustion");
}

// ─── 18. The turn clock ──────────────────────────────────────────────────────
{
  const off = ctx.turnClock(0);
  assert.strictEqual(off.maxMs, 0);
  assert.strictEqual(off.exceeded(), false, "0 means no ceiling");

  const fresh = ctx.turnClock(60000);
  assert.strictEqual(fresh.exceeded(), false);

  const tight = ctx.turnClock(20);
  const until = Date.now() + 40;
  while (Date.now() < until) {
    /* busy-wait: this runtime has no timers, and the point is only that a clock
       that started 40 ms ago has passed a 20 ms ceiling. */
  }
  assert.strictEqual(tight.exceeded(), true);
  assert.ok(tight.elapsedMs() >= 20);
  console.log("[context] the turn clock is a loose ceiling, and 0 disables it");
}

// ─── 19. The offload folder is per turn, so one turn's memory is not another's
{
  const dir = ctx.offloadDirFor("/run/abc", "devteam", 3);
  assert.strictEqual(dir, path.join("/run/abc", "agent-devteam", "turn-003-memory"));
  const a = ctx.offloadDirFor("/run/abc", "diagnostics", 1);
  const b = ctx.offloadDirFor("/run/abc", "diagnostics", 2);
  assert.notStrictEqual(a, b, "turn 2 cannot read turn 1's offloads through recall_memory");
  console.log("[context] offloads are scoped to one agent's one turn");
}

// ─── 20. The estimate this module uses is the project's, not a new one ───────
//
// Two rulers in one pipeline is how a size decision becomes unarguable. This
// module must read the same coefficients `utils/tokens.js` publishes.
{
  // The calibration itself is private to `utils/tokens.js`; what it publishes is
  // the coefficients IN FORCE plus where they came from. Saying "built-in
  // defaults" is the same fact as "no probe ran here", read through the door the
  // module actually has rather than through a variable it keeps to itself.
  const coeff = tokens.activeCoefficients();
  assert.strictEqual(coeff.source, "built-in defaults", "no calibration probe ran in a test process");
  assert.strictEqual(coeff.cjkWeight, 0.69);
  assert.strictEqual(coeff.otherWeight, 0.25);

  const messages = [{ role: "user", content: CJK }];
  const viaContext = ctx.estimateMessagesTokens(messages);
  const viaTokens = tokens.estimateMix(tokens.scriptMixOf(ctx.messageText(messages[0])), { includeOverhead: false });
  assert.strictEqual(viaContext, viaTokens, "one ruler, one implementation");

  // And it must not bill the chat template per message (gotcha 54).
  assert.ok(viaContext < 1000 * 0.69 * 1.15 + 52, "the 52-token template is not charged here");
  console.log("[context] the estimate is the shared calibrated one, template overhead excluded");
}

// ─── 21. The record of how a managed turn RAN ────────────────────────────────
//
// The delivery-layer roles have no step cap, so a ticket or patch record that
// names "the cap it ran under" states a limit that does not exist — a reader of
// `tickets.md` would go looking for a ceiling to raise, and there is none.
// `turnShapeOf` (utils/agents.js) is what stands in its place: how much work the
// turn did, how much of its own reading it had to set aside on disk, and the
// harness's own word for how it ended.
{
  const turn = {
    chunks: 3,
    toolCalls: [{ name: "readFile" }, { name: "grep" }, { name: "readFile" }],
    offloads: [
      { tokensBefore: 60000, tokensAfter: 20000 },
      { tokensBefore: 55000, tokensAfter: 45000 },
    ],
    compactions: 0,
    result: "stopped",
  };
  assert.deepStrictEqual(
    agents.turnShapeOf(turn),
    {
      chunks: 3,
      toolCalls: 3,
      offloads: 2,
      offloadedTokens: 50000,
      compactions: 0,
      endedAs: "stopped",
    },
    "the record says how many pieces of work the turn needed and how much reading it set aside"
  );

  // `endedAs` is the harness's word, kept verbatim, because the four endings mean
  // different things to the reader and a record is not allowed to soften one.
  for (const word of ["complete", "stopped", "error", "max_steps"]) {
    assert.strictEqual(agents.turnShapeOf({ result: word }).endedAs, word);
  }

  // A turn that threw before the harness handed a result back is UNKNOWN, not a
  // row of zeroes: `turnShapeOf(null)` would read as "this turn made no tool
  // calls", which is a claim about work we have no evidence for.
  const unknown = agents.turnShapeOf(null);
  assert.strictEqual(unknown.endedAs, null, "no result means no ending recorded");
  assert.strictEqual(unknown.chunks, 0);
  assert.strictEqual(unknown.toolCalls, 0);
  assert.strictEqual(unknown.offloads, 0);

  // A turn that never filled its window has no offload array at all — that is the
  // ordinary case, and it must not crash or invent a saving.
  const small = agents.turnShapeOf({ chunks: 1, toolCalls: [], result: "complete" });
  assert.strictEqual(small.offloads, 0);
  assert.strictEqual(small.offloadedTokens, 0);
  assert.strictEqual(small.endedAs, "complete");

  // An offload that did not actually shrink the conversation contributes nothing:
  // a trim that moved no text is not a saving, and a record that reports one makes
  // the mechanism look like it worked when it did not.
  const noGain = agents.turnShapeOf({
    chunks: 2,
    toolCalls: [{ name: "readFile" }],
    offloads: [{ tokensBefore: 40000, tokensAfter: 40000 }, { tokensBefore: 30000, tokensAfter: 25000 }],
    result: "complete",
  });
  assert.strictEqual(noGain.offloads, 2, "both attempts are counted");
  assert.strictEqual(noGain.offloadedTokens, 5000, "only the one that moved text is credited");

  console.log("[context] turnShapeOf records an uncapped turn honestly");
}

// ─── 22. The two tools the agent is handed ───────────────────────────────────
//
// This group sits last because the tools' `execute` is async (the harness awaits
// it exactly the way the AI SDK does) and this file is CommonJS, which has no
// top-level await. Its promise is collected below, so the suite's final line and
// the temp-folder cleanup both wait for these assertions — a suite that printed
// "all checks passed" and then failed asynchronously would be a suite that
// reports green for a broken thing.
const toolChecks = (async () => {
  const state = {
    turn: 1,
    dir: "/tmp/whatever/turn-001-memory",
    pressure: { tokens: 123456 },
    requested: false,
    recalls: 0,
  };
  const requested = [];
  const tools = ctx.createContextTools({
    state,
    requestOffload: (note) => requested.push(note),
  });

  assert.deepStrictEqual(Object.keys(tools).sort(), ["manage_context", "recall_memory"]);

  // The wiring is checked when the handle is built, not when the agent reaches for
  // help. `manage_context` is the tool a turn calls precisely when it is running out
  // of room, and answering that call with "requestOffLoad is not a function" teaches
  // the model that asking for help does not work — the real bug this guard was written
  // for (the harness once passed `requestOffLoad:` with a capital L, and the agent's
  // one request for help came back as a tool error).
  assert.throws(
    () => ctx.createContextTools({ state, requestOffLoad: undefined }),
    /requestOffload function/,
    "a misspelled option fails the handle, not the turn"
  );
  assert.throws(
    () => ctx.createContextTools({ state: null, requestOffload: () => {} }),
    /live turn state/,
    "a missing turn state fails the handle too"
  );

  // manage_context schedules a trim at the next chunk boundary rather than
  // rewriting the conversation under the model's feet mid-step.
  const res = await tools.manage_context.execute({ note: "the chapter 1 read is finished with" });
  assert.deepStrictEqual(requested, ["the chapter 1 read is finished with"]);
  assert.strictEqual(res.scheduled, true);
  assert.strictEqual(res.appliesAt, "next chunk boundary");
  assert.strictEqual(res.workingWindowTokens, 123456);
  assert.strictEqual(state.requested, true, "the turn records that the agent asked for a trim");

  // An empty note is fine — the agent is not required to explain itself.
  await tools.manage_context.execute({});
  assert.deepStrictEqual(requested[1], "");

  // recall_memory reads the turn's own folder and counts itself, so the harness
  // can tell "used the tools" apart from "ignored them" (ACM's measurement).
  const { result } = offloadOne(conversation(6));
  const live = { turn: 1, dir: result.dir, pressure: null, requested: false, recalls: 0 };
  const liveTools = ctx.createContextTools({ state: live, requestOffload: () => {} });
  const out = await liveTools.recall_memory.execute({ query: cjk(30) });
  assert.ok(out.matchedCount >= 1, JSON.stringify(out));
  assert.strictEqual(live.recalls, 1);

  // A limit below the floor is RAISED to it rather than honoured: a 10-byte answer
  // is indistinguishable from "nothing matched", which is the silent-nothing failure
  // gotcha 60 is about. The truncation is still reported honestly — the floor is a
  // floor, not a promise that the excerpt fits.
  const limited = await liveTools.recall_memory.execute({ query: cjk(30), limit: 10 });
  assert.ok(limited.matchedCount >= 1, "the raised floor still answers the question");
  const askedBytes = limited.matched.reduce((n, m) => n + Buffer.byteLength(m.excerpt || "", "utf8"), 0);
  assert.ok(askedBytes >= 512, `a 10-byte request was honoured instead of raised to the floor (${askedBytes} bytes)`);
  assert.strictEqual(limited.truncated, true, "a truncated answer still says it was truncated");

  console.log("[context] manage_context schedules, recall_memory retrieves");
})();

toolChecks
  .then(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log("\n[context] all checks passed");
  })
  .catch((err) => {
    console.error(err);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.exit(1);
  });

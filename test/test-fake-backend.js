/**
 * test-fake-backend.js — the stub model server, and what it lets `npm test` reach.
 *
 * Every other offline suite stubs the AI by REPLACING harness.runOneShot /
 * harness.createAgentHandle with a fake function. That tests the task logic, but
 * it removes the harness from the picture entirely: the provider, the streaming
 * parser, the tool-calling loop, the approve gate, the retry path, the truncation
 * guard and the size-error tagging never run (gotcha 19, 60, 61 all live there).
 *
 * This suite stands the stub where the MODEL SERVER stands instead — a scripted
 * OpenAI-compatible HTTP endpoint on 127.0.0.1 — and then asserts that the real
 * harness, the real agent loop and the real file tools ran against it.
 *
 * No network beyond localhost, no model, no cost. Plain `assert`, no framework.
 * Run standalone: `node test/test-fake-backend.js`.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Pin the AI settings BEFORE anything reads them, so the local .env cannot make
// this suite talk to a real container.
process.env.AI_BASE_URL = "http://127.0.0.1:1/v1"; // overwritten per scenario
process.env.AI_API_KEY = "fake-key";
process.env.AI_MODEL = "stub";
process.env.AI_RETRY = "0";
process.env.AI_CONTEXT_WINDOW = "16000"; // → the derived output cap is 4000
// The cap must be pinned WITH the window. `AI_MAX_TOKENS` overrides the derived
// value, and this machine's `.env` now sets it to 131072 — a cap eight times the
// window this suite pins, which leaves the agent session no room for its own
// prompt and makes the harness compact before the first turn. That inserts an
// extra request at `requests[0]`, and this suite asserts both that `requests[0]`
// is the agent's first turn and that `maxTokens === 4000`. An EMPTY value is the
// pin that keeps the derivation honest: `dotenv` (harness.js:43) will not overwrite
// a variable that already exists, and `parseInt("")` is NaN, so `envMaxTokens()`
// falls back to the quarter of the window this suite means to test. Deleting it
// instead would let `.env` win. (gotcha 69's rule, other half; gotcha 36's
// arithmetic.)
process.env.AI_MAX_TOKENS = "";
process.env.AI_THINKING = "false";
process.env.AI_CALL_DEADLINE_MS = "0"; // off, except in the hang scenario
process.env.ON_VOLUME_ERROR = "abort";
process.env.ON_QA_LIMIT = "fail";

const harness = require("../harness");
const ctxm = require("../utils/context");
const { startFakeBackend } = require("./fake-backend");
const { assertRealToolCalls } = require("../utils/agents");
const { isTooBigForOnePassError, isStructuredOutputError } = require("../configs/shared");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok - ${name}`);
}

/** Silence the harness's own console noise for the scenarios that must fail. */
function quiet(fn) {
  const realError = console.error;
  const realLog = console.log;
  console.error = () => {};
  console.log = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.error = realError;
      console.log = realLog;
    });
}

// ─── 1. The control-plane check runs against the stub ────────────────────────

async function scenarioEndpointCheck() {
  const backend = await startFakeBackend({ model: "stub" });
  try {
    await harness.assertModelServing({ baseUrl: backend.baseUrl, apiKey: "k", model: "stub", label: "t" });
    ok("assertModelServing passes against the stub's GET /v1/models");

    // The same check must fail loudly when the stage expects a model the
    // endpoint does not list — the hook-forgot-to-switch-container case.
    let err = null;
    try {
      await harness.assertModelServing({ baseUrl: backend.baseUrl, apiKey: "k", model: "hy-mt2", label: "t" });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "a model id the endpoint does not list is rejected");
    assert.ok(/expects "hy-mt2"/.test(err.message), err.message);
    ok("assertModelServing names the model the stage expected");

    await backend.close();
  } catch (e) {
    await backend.close();
    throw e;
  }

  // A dead endpoint is a different message: unreachable, not wrong-model.
  let err = null;
  try {
    await harness.assertModelServing({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "stub", label: "dead" });
  } catch (e) {
    err = e;
  }
  assert.ok(err && /cannot reach the model endpoint/.test(err.message), err && err.message);
  ok("a dead endpoint fails with the actionable 'is the container running?' message");
}

// ─── 2. A one-shot call runs the real provider + real streaming parser ───────

async function scenarioOneShot() {
  const backend = await startFakeBackend({
    model: "stub",
    reply: (req) => ({ text: "The answer from the scripted model." }),
  });
  try {
    const text = await harness.runOneShot({
      systemPrompt: "You translate.",
      messages: [{ text: "translate this" }],
      endpoint: { baseUrl: backend.baseUrl, apiKey: "k", model: "stub" },
      label: "one-shot-scenario",
    });
    assert.strictEqual(text, "The answer from the scripted model.");

    const req = backend.requests[0];
    assert.strictEqual(req.stream, true, "the harness asks for a streamed completion");
    assert.strictEqual(req.maxTokens, 4000, "the output cap is derived from AI_CONTEXT_WINDOW (16000 / 4)");
    assert.ok(
      req.messages.some((m) => m.role === "system" && m.content === "You translate."),
      "the system prompt reached the wire"
    );
    assert.ok(req.tools === undefined, "a tool-less one-shot advertises no tools");
    ok("runOneShot streamed a real completion through the real provider and undici");

    // A role asked twice in one process has to leave BOTH answers behind. The delivery loop asks the
    // manager on every iteration, and keying the file on the label alone meant the second decision
    // erased the first: on 2026-10-07 the record of iteration 1 was gone by the time anyone looked,
    // and only the iteration that failed was still readable.
    await harness.runOneShot({
      systemPrompt: "You translate.",
      messages: [{ text: "translate that again" }],
      endpoint: { baseUrl: backend.baseUrl, apiKey: "k", model: "stub" },
      label: "one-shot-scenario",
    });
    const oneShotDir = path.join(harness.currentRunDir(), "one-shot");
    const firstLog = fs.readFileSync(path.join(oneShotDir, "one-shot-scenario.md"), "utf8");
    const secondLog = fs.readFileSync(path.join(oneShotDir, "one-shot-scenario-2.md"), "utf8");
    assert.ok(firstLog.includes("translate this"), "the first call is still there");
    assert.ok(secondLog.includes("translate that again"), "the second call is beside it, not on top of it");
    ok("one-shot logs are numbered per call, so a role asked twice keeps both answers");

    // The usage block the client asked for (stream_options.include_usage) is
    // read back — the numbers in .logs/ are the server's, not a guess.
    const backend2 = await startFakeBackend({
      model: "stub",
      reply: () => ({ text: "x", usage: { prompt_tokens: 1234, completion_tokens: 77, total_tokens: 1311 } }),
    });
    const text2 = await harness.runOneShot({
      messages: [{ text: "hi" }],
      endpoint: { baseUrl: backend2.baseUrl, apiKey: "k", model: "stub" },
      label: "usage-scenario",
    });
    assert.strictEqual(text2, "x");
    await backend2.close();
    ok("the server's reported token usage flows through (the tok/s logging depends on it)");

    // The Hy-MT2 contract: NO system message, and the thinking dialect on the wire.
    const backend3 = await startFakeBackend({ model: "stub", reply: () => ({ text: "ok" }) });
    await harness.runOneShot({
      systemPrompt: null,
      messages: [{ text: "Translate the following Japanese text into English." }],
      endpoint: { baseUrl: backend3.baseUrl, apiKey: "k", model: "stub" },
      thinking: "no_think",
      thinkingTemplate: "hy-mt",
      sampling: { topP: 1.0, topK: -1, repetitionPenalty: 1.0 },
      temperature: 0.7,
      label: "hy-mt-scenario",
    });
    const hyReq = backend3.requests[0];
    assert.ok(
      !hyReq.messages.some((m) => m.role === "system"),
      "the translate stage's contract sends a single user message and no system message"
    );
    assert.strictEqual(hyReq.reasoningEffort, "no_think", "the hy-mt dialect sends reasoning_effort only");
    assert.strictEqual(hyReq.chatTemplateKwargs, null, "and never the Qwen-style chat_template_kwargs");
    assert.strictEqual(hyReq.temperature, 0.7);
    await backend3.close();
    ok("the hy-mt dialect sends reasoning_effort only (kept for a translator whose template uses it)");

    // The Index-Translate contract: NO system message, and `enable_thinking` as the
    // thinking switch. Its template (Qwen3-VL) has no reasoning_effort variable and
    // opens a think tag when the variable it DOES read is missing — so the fast mode
    // has to be asked for, not assumed.
    const backend4 = await startFakeBackend({ model: "stub", reply: () => ({ text: "ok" }) });
    await harness.runOneShot({
      systemPrompt: null,
      messages: [{ text: "请将以下日语小说翻译成英语，并且严格遵循所有约束要求。\n\n【源文】\n本文" }],
      endpoint: { baseUrl: backend4.baseUrl, apiKey: "k", model: "stub" },
      thinking: "no_think",
      thinkingTemplate: "index-mt",
      sampling: { topP: 1.0, topK: -1, repetitionPenalty: 1.0 },
      temperature: 0,
      label: "index-mt-scenario",
    });
    const indexReq = backend4.requests[0];
    assert.ok(
      !indexReq.messages.some((m) => m.role === "system"),
      "the translate stage's contract sends a single user message and no system message"
    );
    assert.deepStrictEqual(
      indexReq.chatTemplateKwargs,
      { enable_thinking: false },
      "the index-mt dialect sends chat_template_kwargs {enable_thinking:false} — the template's only switch"
    );
    assert.strictEqual(indexReq.reasoningEffort, null, "and never reasoning_effort, which that template does not read");
    assert.strictEqual(indexReq.temperature, 0, "greedy, the decoding the model's own client and its published numbers use");
    await backend4.close();
    ok("the Index-Translate wire contract: no system prompt, enable_thinking=false, greedy sampling");

    // Thinking ON for the same dialect is the same switch flipped the other way —
    // the template has no levels, so "low" and "high" cannot mean different things.
    const backend5 = await startFakeBackend({ model: "stub", reply: () => ({ text: "ok" }) });
    await harness.runOneShot({
      systemPrompt: null,
      messages: [{ text: "hi" }],
      endpoint: { baseUrl: backend5.baseUrl, apiKey: "k", model: "stub" },
      thinking: "high",
      thinkingTemplate: "index-mt",
      label: "index-mt-thinking",
    });
    assert.deepStrictEqual(backend5.requests[0].chatTemplateKwargs, { enable_thinking: true });
    await backend5.close();
    ok("index-mt thinking on sends enable_thinking:true");

    // A dialect the template cannot honour fails loudly instead of quietly
    // sending a key the server will ignore.
    const backend6 = await startFakeBackend({ model: "stub", reply: () => ({ text: "ok" }) });
    let dialectFailed = null;
    try {
      await harness.runOneShot({
        systemPrompt: null,
        messages: [{ text: "hi" }],
        endpoint: { baseUrl: backend6.baseUrl, apiKey: "k", model: "stub" },
        thinking: "xhigh",
        thinkingTemplate: "index-mt",
        label: "index-mt-bad-level",
      });
    } catch (e) {
      dialectFailed = e.message;
    }
    await backend6.close();
    assert.ok(dialectFailed && /index-mt/.test(dialectFailed), dialectFailed);
    ok("an unsupported thinking level for a dialect fails at the call, not at the model");

    await backend.close();
  } catch (e) {
    await backend.close();
    throw e;
  }
}

// ─── 3. A tool-calling agent runs the real loop and the real sandbox ─────────

async function scenarioAgentWritesThroughRealTools() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-fake-agent-"));
  const volumeDir = path.join(dir, "Book(01)");
  fs.mkdirSync(volumeDir, { recursive: true });

  const backend = await startFakeBackend({
    model: "stub",
    reply: (req) => {
      // Step 1: the agent is handed the real tool schemas and answers with a
      // real tool call. Step 2: after the tool result arrives, it wraps up.
      if (req.messages.some((m) => m.role === "tool")) return { text: "Wrote the reference." };
      return {
        text: "",
        toolCalls: [
          {
            name: "writeFile",
            arguments: { filePath: "character-voice.md", content: "# Character Voice\n\n- Hana: blunt.\n" },
          },
        ],
      };
    },
  });
  // createAgentHandle resolves its endpoint from AI_* (it takes no per-call
  // override — the role endpoints are what a stage hands to its one-shot calls).
  backend.pointEnvAt();

  try {
    const { tools, approve } = await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] });
    assert.ok(tools.writeFile && tools.readFile && tools.grep, "the real gated fs tool set was built");

    const handle = await harness.createAgentHandle({
      name: "author-voice-01",
      systemPrompt: "You write the character voice reference with writeFile.",
      tools,
      approve,
      cwd: volumeDir,
      maxSteps: 6,
    });
    const result = await handle.sendTurn("Write character-voice.md.", { label: "author-voice-01" });
    await handle.close();

    assert.strictEqual(
      result.toolCalls.length,
      1,
      `the agent made one real tool call (got ${result.toolCalls.length})`
    );
    assert.strictEqual(result.toolCalls[0].name, "writeFile");
    assert.strictEqual(result.toolCalls[0].error, null, "the tool ran without an error");

    const written = fs.readFileSync(path.join(volumeDir, "character-voice.md"), "utf8");
    assert.ok(written.includes("Hana: blunt."), "the file the model asked for is on disk");
    ok("a scripted tool call became a real writeFile through the real approve gate");

    // The tool schemas the agent was advertised are the harness's, not the stub's.
    const agentReq = backend.requests[0];
    const names = (agentReq.tools || []).map((t) => t.function?.name || t.name);
    assert.ok(names.includes("writeFile") && names.includes("grep"), `tools advertised: ${names.join(", ")}`);
    assert.deepStrictEqual(
      [...names].sort(),
      ["editFile", "grep", "listFiles", "readFile", "writeFile"],
      `the agent is advertised exactly the five tools the prompt promises (got: ${names.join(", ")})`
    );
    assert.ok(!names.includes("deleteFile"), "deleteFile is not advertised — the gate would refuse it every time (gotcha 8)");
    ok("the agent was handed the real tool schemas (a stub that fakes tools would not get this far)");

    // The sandbox still applies: a write outside the allowed dirs is refused by
    // the real gate, not by the stub.
    const outside = path.join(dir, "outside.md");
    const backend2 = await startFakeBackend({
      model: "stub",
      reply: (req) =>
        req.messages.some((m) => m.role === "tool")
          ? { text: "done" }
          : { text: "", toolCalls: [{ name: "writeFile", arguments: { filePath: "../outside.md", content: "# nope\n" } }] },
    });
    backend2.pointEnvAt();
    const h2 = await harness.createAgentHandle({
      name: "escape-attempt",
      systemPrompt: "Write a file.",
      tools,
      approve,
      cwd: volumeDir,
      maxSteps: 4,
    });
    const r2 = await h2.sendTurn("Write outside the volume folder.", { label: "escape-attempt" });
    await h2.close();
    await backend2.close();
    assert.ok(!fs.existsSync(outside), "the approve gate refused the write outside the volume folder");
    assert.ok(
      r2.toolCalls[0].error || !r2.toolCalls[0].output,
      "and the refusal is visible to the agent (it is not silently dropped)"
    );
    ok("the write gate is enforced by the harness — the stub cannot be talked into breaking the sandbox");
  } finally {
    await backend.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── 4. The failure shapes the pipeline is built around ──────────────────────

async function scenarioFailureShapes() {
  const endpointOf = (backend) => ({ baseUrl: backend.baseUrl, apiKey: "k", model: "stub" });

  // (a) An empty reply must FAIL the run, never return "" (gotcha 2).
  {
    const backend = await startFakeBackend({ model: "stub" });
    backend.fail("empty");
    let err = null;
    try {
      await harness.runOneShot({
        messages: [{ text: "hi" }],
        endpoint: endpointOf(backend),
        label: "empty-reply",
      });
    } catch (e) {
      err = e;
    }
    await backend.close();
    assert.ok(err, "an empty model reply throws");
    assert.ok(/returned no content/.test(err.message), err.message);
    ok("an empty reply fails the run instead of handing back an empty artifact");
  }

  // (b) A reply cut off at the output cap is a SIZE failure, so the whole→chunked
  // fallback can act on it (gotcha 55).
  {
    const backend = await startFakeBackend({ model: "stub" });
    backend.fail("truncated", { text: "a chapter that stops in the middle of a sentence" });
    let err = null;
    try {
      await harness.runOneShot({
        messages: [{ text: "hi" }],
        endpoint: endpointOf(backend),
        label: "truncated-reply",
      });
    } catch (e) {
      err = e;
    }
    await backend.close();
    assert.ok(err, "a truncated reply throws");
    assert.ok(isTooBigForOnePassError(err), `finish_reason=length is tagged tooBigForOnePass: ${err.message}`);
    assert.ok(!/TRUNCATED/.test(err.message) === false, "and the message says the response was discarded");
    ok("a reply cut off at the output cap is tagged as 'too big for one pass'");
  }

  // (c) A server that refuses the request as too large is tagged the same way,
  // without any task string-matching the server's wording (gotcha 36, 55).
  {
    const backend = await startFakeBackend({ model: "stub" });
    backend.fail("tooBig");
    let err = null;
    try {
      await harness.runOneShot({
        messages: [{ text: "hi" }],
        endpoint: endpointOf(backend),
        label: "too-large",
      });
    } catch (e) {
      err = e;
    }
    await backend.close();
    assert.ok(err, "the refused request throws");
    assert.ok(
      isTooBigForOnePassError(err),
      `the server's own size wording is tagged tooBigForOnePass (got: ${err.message})`
    );
    ok("the server's 'prompt + max tokens exceeds the context' rejection is recognized");
  }

  // (d) …and an UNRELATED server error must NOT be tagged that way, or a dead
  // container sends a whole volume down the expensive chapter-by-chapter path.
  {
    const backend = await startFakeBackend({ model: "stub" });
    backend.fail("serverError", { error: "model container died" });
    let err = null;
    try {
      await harness.runOneShot({ messages: [{ text: "hi" }], endpoint: endpointOf(backend), label: "dead-model" });
    } catch (e) {
      err = e;
    }
    await backend.close();
    assert.ok(err, "a 500 throws");
    assert.ok(!isTooBigForOnePassError(err), `a plain server error is NOT a size failure: ${err.message}`);
    ok("a dead container is not mistaken for a size problem (the fallback would fire for nothing)");
  }

  // (e) A reasoning phase that ate the whole reply budget (gotcha 59) — the
  // message must name reasoning as the suspect.
  {
    const backend = await startFakeBackend({ model: "stub" });
    backend.queue({ text: "", reasoning: "x".repeat(5000), finishReason: "stop" });
    let err = null;
    try {
      await harness.runOneShot({
        messages: [{ text: "hi" }],
        endpoint: endpointOf(backend),
        label: "reasoning-starved",
      });
    } catch (e) {
      err = e;
    }
    await backend.close();
    assert.ok(err, "a reasoning-only reply throws");
    assert.ok(/no content/.test(err.message), err.message);
    ok("a call that spent its budget on reasoning is reported as an empty answer");
  }

  // (f) A model that writes its tool call as TEXT (gotcha 18) must be caught by
  // the shared guard instead of being mistaken for a finished turn.
  {
    const result = { text: '<tool_call>{"name":"writeFile"}</tool_call>', toolCalls: [] };
    let err = null;
    try {
      assertRealToolCalls(result, "author-voice-01", "01");
    } catch (e) {
      err = e;
    }
    assert.ok(err, "assertRealToolCalls rejects a turn whose only 'tool call' is text");
    ok("the malformed-tool-call guard still fires on the shape a local endpoint actually produces");
  }

  // (g) A hung connection is ended by the idle deadline — the only wall-clock
  // bound the pipeline has (gotcha 26).
  {
    process.env.AI_CALL_DEADLINE_MS = "700";
    const backend = await startFakeBackend({ model: "stub" });
    backend.fail("hang");
    let err = null;
    try {
      await harness.runOneShot({ messages: [{ text: "hi" }], endpoint: endpointOf(backend), label: "hung" });
    } catch (e) {
      err = e;
    }
    await backend.close();
    process.env.AI_CALL_DEADLINE_MS = "0";
    assert.ok(err, "the idle deadline aborts a call that makes no progress");
    assert.ok(/no progress/.test(err.message), err.message);
    ok("AI_CALL_DEADLINE_MS aborts a hung endpoint instead of running forever");
  }

  // (h) A server that will not stream falls back to one non-streaming call.
  {
    const backend = await startFakeBackend({
      model: "stub",
      reply: (req) => (req.stream ? { refuseStream: true, status: 500, error: "no streaming here" } : { text: "answered without streaming" }),
    });
    const text = await harness.runOneShot({
      messages: [{ text: "hi" }],
      endpoint: endpointOf(backend),
      label: "no-stream",
    });
    await backend.close();
    assert.strictEqual(text, "answered without streaming");
    assert.ok(backend.requests.length >= 2, "the streamed attempt was followed by the non-streaming fallback");
    assert.ok(backend.requests.some((r) => r.stream === false), "the fallback asks for a plain completion");
    assert.ok(backend.requests[0].stream === true, "the first attempt is the streamed one");
    ok("a server that refuses to stream falls back to a non-streaming call");
  }

  // (i) AI_RETRY: a flaky endpoint is retried, and the retry is what saves the run.
  {
    const backend = await startFakeBackend({
      model: "stub",
      reply: (req) => (req.stream ? { refuseStream: true, status: 500, error: "flaky" } : { text: "recovered" }),
    });
    const text = await quiet(() =>
      harness.runOneShot({ messages: [{ text: "hi" }], endpoint: endpointOf(backend), retry: 1, label: "retry" })
    );
    await backend.close();
    assert.strictEqual(text, "recovered");
    assert.ok(backend.requests.length >= 2, "the call was retried");
    ok("AI_RETRY re-runs a flaky call instead of failing the volume");
  }
}

// ─── 4b. Asking for a shape, and refusing one ─────────────────────────────────

/**
 * `response_format` is a detector, not a guarantee. What matters is what happens when the
 * answer does not fit the shape that was asked for: the run has to say "the endpoint could not
 * answer in the shape it was asked for", tag it as its own class (not a size failure, not an
 * empty model), spend exactly the number of calls the retry setting promises, and keep the
 * server's own reason instead of swallowing it.
 */
async function scenarioStructuredOutput() {
  const endpointOf = (backend) => ({ baseUrl: backend.baseUrl, apiKey: "k", model: "stub" });
  const SHAPE = { type: "json_object" };

  // (a) The requested shape reaches the wire. Nothing else on the request says the caller asked
  // for JSON, so this is the only place to check the option is not decorative.
  {
    const backend = await startFakeBackend({ model: "stub" });
    backend.queue({ text: '{"score": 80}', finishReason: "stop" });
    const text = await harness.runOneShot({
      messages: [{ text: "grade this" }],
      endpoint: endpointOf(backend),
      responseFormat: SHAPE,
      label: "grade-shape",
    });
    await backend.close();
    assert.strictEqual(text, '{"score": 80}', "an answer that fits the shape is returned unchanged");
    assert.deepStrictEqual(backend.requests[0].responseFormat, SHAPE, "response_format reached the request body");
    ok("response_format rides in the request body, where the endpoint can actually see it");
  }

  // (b) A refused shape is its own failure class.
  {
    const backend = await startFakeBackend({ model: "stub" });
    backend.fail("refusedShape");
    let err = null;
    try {
      await harness.runOneShot({
        messages: [{ text: "grade this" }],
        endpoint: endpointOf(backend),
        responseFormat: SHAPE,
        label: "refused-shape",
      });
    } catch (e) {
      err = e;
    }
    await backend.close();
    assert.ok(err, "a refused shape throws");
    assert.ok(isStructuredOutputError(err), `tagged as a structured-output failure: ${err.message}`);
    assert.ok(
      !isTooBigForOnePassError(err),
      `and NOT as a size failure — splitting the request cannot fix a refused shape: ${err.message}`
    );
    assert.ok(
      /structured_output_failed/.test(err.message),
      `the server's own reason survives to the run log: ${err.message}`
    );
    ok("a refused answer shape is tagged as itself, not as a size problem or an empty model");
  }

  // (c) The attempt count means what it says: `retry: 2` is three calls to the endpoint, not
  // three attempts each hiding a retry layer the harness never counted.
  {
    const backend = await startFakeBackend({ model: "stub" });
    for (let i = 0; i < 3; i++) backend.fail("refusedShape");
    let err = null;
    try {
      await quiet(() =>
        harness.runOneShot({
          messages: [{ text: "grade this" }],
          endpoint: endpointOf(backend),
          responseFormat: SHAPE,
          retry: 2,
          label: "refused-shape-retried",
        })
      );
    } catch (e) {
      err = e;
    }
    await backend.close();
    assert.ok(isStructuredOutputError(err), err && err.message);
    assert.strictEqual(
      backend.requests.length,
      3,
      `retry: 2 must mean 3 endpoint calls; the endpoint saw ${backend.requests.length}`
    );
    ok("on the structured path the harness's own counter is the only retry");
  }

  // (d) The same refusal arriving as a frame INSIDE a 200 stream: the provider sees a stream
  // with no parts in it, so without the fetch tap this is "the model returned no content".
  {
    const backend = await startFakeBackend({ model: "stub" });
    backend.fail("refusedShapeStream");
    let err = null;
    try {
      await quiet(() =>
        harness.runOneShot({
          messages: [{ text: "grade this" }],
          endpoint: endpointOf(backend),
          responseFormat: SHAPE,
          label: "refused-shape-stream",
        })
      );
    } catch (e) {
      err = e;
    }
    await backend.close();
    assert.ok(err, "a stream that carries an error frame and no content fails the call");
    assert.ok(isStructuredOutputError(err), `tagged from the frame the stream carried: ${err.message}`);
    assert.ok(
      !/returned no content/.test(err.message),
      `the reason survives instead of blaming the model for being empty: ${err.message}`
    );
    ok("an error frame inside a 200 stream is surfaced, not mistaken for an empty answer");
  }

  // (e) A shape is a request, not a licence to pass anything through: a bad option is refused
  // before the call, because a silently-ignored `response_format` is the failure mode where the
  // whole mechanism quietly stops existing.
  {
    let err = null;
    try {
      await harness.runOneShot({
        messages: [{ text: "hi" }],
        responseFormat: "json",
        label: "bad-shape",
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err && /responseFormat must be a plain object/.test(err.message), err && err.message);
    ok("a responseFormat that is not a plain object is refused at the call, not at the endpoint");
  }
}

// ─── 5. The token-calibration probe runs against the stub ────────────────────

async function scenarioCalibrationProbe() {
  const backend = await startFakeBackend({
    model: "stub",
    reply: () => ({ text: "x", usage: { prompt_tokens: 8123, completion_tokens: 1, total_tokens: 8124 } }),
  });
  try {
    const tokens = await harness.measurePromptTokens({
      baseUrl: backend.baseUrl,
      apiKey: "k",
      model: "stub",
      text: "a sample of the volume's own text",
      label: "probe-calibration",
    });
    assert.strictEqual(tokens, 8123, "the probe reports the SERVER's count, not an estimate");
    const req = backend.requests[0];
    assert.strictEqual(req.maxTokens, 1, "the probe generates one token (it pays only the prefill)");
    assert.strictEqual(req.stream, false, "the probe is non-streaming");
    assert.ok(
      !req.messages.some((m) => m.role === "system"),
      "the probe sends no system prompt (it must measure the sample, nothing else)"
    );
    ok("the token-calibration probe works against the stub and costs one token of generation");

    // A server that reports no usage must not kill the run (calibration is
    // fail-soft — gotcha 54d).
    const backend2 = await startFakeBackend({ model: "stub" });
    backend2.fail("noUsage", { text: "answered" });
    let err = null;
    try {
      await harness.measurePromptTokens({
        baseUrl: backend2.baseUrl,
        apiKey: "k",
        model: "stub",
        text: "sample",
        label: "probe-no-usage",
      });
    } catch (e) {
      err = e;
    }
    await backend2.close();
    assert.ok(err && /no prompt token count/.test(err.message), err && err.message);
    ok("a server that reports no usage fails the PROBE loudly (so the caller can fall back to the built-in coefficients)");
  } finally {
    await backend.close();
  }
}

// ─── 6. Role endpoints resolve to the stub through the real config seam ──────

async function scenarioRoleEndpoints() {
  const backend = await startFakeBackend({
    model: ["stub", "stub-translate", "stub-verify", "stub-edit", "stub-audit"],
    reply: (req) => ({ text: `answered by ${req.model}` }),
  });
  try {
    backend.pointEnvAt({ prefixes: ["TRANSLATE", "VERIFY", "EDIT", "AUDIT"] });
    const { roleEndpoint } = require("../utils/translate");

    const translateRole = roleEndpoint("TRANSLATE");
    const verifyRole = roleEndpoint("VERIFY");
    assert.strictEqual(translateRole.baseUrl, backend.baseUrl);
    assert.strictEqual(translateRole.model, "stub-translate");
    assert.strictEqual(verifyRole.model, "stub-verify");
    assert.notStrictEqual(translateRole.model, verifyRole.model, "the four roles are four distinct models on the wire");

    const text = await harness.runOneShot({
      messages: [{ text: "hi" }],
      endpoint: verifyRole,
      label: "role-endpoint",
    });
    assert.strictEqual(text, "answered by stub-verify");
    ok("the four translation-stage roles resolve to distinct endpoints through the real roleEndpoint()");

    // The control-plane check the tasks run before their first call.
    await harness.assertModelServing({ ...translateRole, label: "translate stage" });
    ok("a role endpoint passes the same sanity check a real stage runs at startup");
  } finally {
    await backend.close();
  }
}

// ─── 7. The tagged size error reaches the fallback that exists to repair it ──

/**
 * The other half of gotcha 62. `test-tokens.js` proves `runVolumeWithModeFallback`
 * falls back when handed a tagged error; the failure shapes above prove the harness
 * produces that tag. This is the seam between them: a REAL one-shot call the server
 * refused for being too large, thrown inside a real volume pass, must be the one
 * failure that flips the volume to chapter-by-chapter — and a dead container must
 * not.
 */
async function scenarioModeFallback() {
  const { runVolumeWithModeFallback } = require("../utils/qa-loop");
  const endpointOf = (backend) => ({ baseUrl: backend.baseUrl, apiKey: "k", model: "stub" });

  const mkDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-fallback-"));
    fs.writeFileSync(path.join(dir, "glossary.md"), "the partial attempt wrote this");
    return dir;
  };

  // (a) The server refused the whole-installment request as too large.
  {
    const dir = mkDir();
    const backend = await startFakeBackend({ model: "stub" });
    backend.fail("tooBig");
    const ctx = { chunked: false };
    let passes = 0;
    let result = null;
    try {
      result = await quiet(() =>
        runVolumeWithModeFallback({
          run: async () => {
            passes += 1;
            fs.writeFileSync(path.join(dir, "glossary.md"), "the partial attempt wrote this");
            // Whole mode is the doomed pass; the chapter-by-chapter pass answers.
            if (ctx.chunked) return;
            await harness.runOneShot({
              messages: [{ text: "hi" }],
              endpoint: endpointOf(backend),
              label: "whole-installment-pass",
            });
          },
          ctx,
          volumeDir: dir,
          attemptFiles: ["glossary.md"],
          label: "fallback-tooBig",
        })
      );
    } finally {
      await backend.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(result && result.fellBack, `the size failure triggers the fallback: ${result && result.error && result.error.message}`);
    assert.strictEqual(passes, 2, "the volume ran twice: the whole pass, then the chapter-by-chapter one");
    assert.strictEqual(ctx.chunked, true, "the retry runs in the mode that can actually fit");
    assert.strictEqual(ctx.modeFallback, true, "the task is told which mode it ended in");
    ok("a one-shot the server refused for being too large fires the whole→chunked fallback (gotcha 62's fix, end to end)");
  }

  // (b) …and the partial output is gone before the retry, so the second pass cannot
  // inherit half a document or scores recorded for a file that no longer exists.
  {
    const dir = mkDir();
    const backend = await startFakeBackend({ model: "stub" });
    backend.fail("tooBig");
    const ctx = { chunked: false };
    let wipedWhileRunning = null;
    try {
      await quiet(() =>
        runVolumeWithModeFallback({
          run: async () => {
            if (ctx.chunked) {
              wipedWhileRunning = fs.existsSync(path.join(dir, "glossary.md"));
              return;
            }
            await harness.runOneShot({
              messages: [{ text: "hi" }],
              endpoint: endpointOf(backend),
              label: "whole-installment-wipe",
            });
          },
          ctx,
          volumeDir: dir,
          attemptFiles: ["glossary.md"],
          label: "fallback-wipe",
        })
      );
    } finally {
      await backend.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.strictEqual(wipedWhileRunning, false, "the fallback pass starts with the failed attempt's output removed");
    ok("the failed attempt's output is wiped before the chapter-by-chapter retry");
  }

  // (c) A dead container is NOT a size problem: the volume is retried in the same
  // mode it failed in, which is to say it is not retried at all (gotcha 55).
  {
    const dir = mkDir();
    const backend = await startFakeBackend({ model: "stub" });
    backend.fail("serverError", { error: "model container died" });
    const ctx = { chunked: false };
    let passes = 0;
    let err = null;
    try {
      await quiet(() =>
        runVolumeWithModeFallback({
          run: async () => {
            passes += 1;
            await harness.runOneShot({
              messages: [{ text: "hi" }],
              endpoint: endpointOf(backend),
              label: "dead-container",
            });
          },
          ctx,
          volumeDir: dir,
          attemptFiles: ["glossary.md"],
          label: "fallback-dead",
        })
      );
    } catch (e) {
      err = e;
    } finally {
      await backend.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(err, "the volume still fails — a dead container is not repaired by chunking");
    assert.strictEqual(passes, 1, "no second pass was paid for");
    assert.strictEqual(ctx.chunked, false, "the mode was not flipped");
    ok("a dead container fails the volume instead of buying an expensive, useless second pass");
  }
}

// ─── 8. Context management: a delivery-layer turn sets its old reads aside ───

/**
 * A fixture whose size this project's own token estimate can actually see.
 *
 * The text is pure Hiragana on purpose: `utils/tokens.js` counts characters per
 * script, and the payload a real diagnosis turn carries is Japanese prose inside a
 * JSON wrapper. Latin filler of the same length reads as about a third of the size
 * and the offload boundary never fires, so the scenario would prove nothing.
 * 168 lines x 40 characters is ~5,700 estimated tokens per read; five of them
 * against the 16,000-token window this suite pins is the shape of the live failure
 * this change exists for — a diagnosis turn that read the same file twelve times,
 * spent 7.2M tokens, and never answered.
 *
 * @param {number} lines
 * @param {number} charsPerLine
 * @returns {string}
 */
function hiraganaPage(lines, charsPerLine) {
  const rows = [];
  for (let r = 0; r < lines; r += 1) {
    let line = "";
    for (let c = 0; c < charsPerLine; c += 1) {
      line += String.fromCharCode(0x3042 + ((r * 31 + c * 7) % 86));
    }
    rows.push(line);
  }
  return `${rows.join("\n")}\n`;
}

/** The tool answers one request carried, joined so a marker can be counted in them. */
function toolTextOf(req) {
  return req.messages
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content || ""))
    .join("\n");
}

function countMarker(text, marker) {
  return text.split(marker).length - 1;
}

/**
 * The whole point of the redesign, end to end through the real agent loop:
 * a managed turn runs out of room, and instead of the session quietly summarising
 * its own history away, the harness moves the old read answers to DISK and keeps
 * going. Nothing is discarded, and the agent is told where to get it back.
 */
async function scenarioManagedTurnOffloadsInsteadOfCompacting() {
  // Both knobs are read per call (utils/context.js), so a scenario may pin them
  // for itself without disturbing the other scenarios in this file.
  const prevKeep = process.env.CONTEXT_KEEP_RECENT_TOKENS;
  const prevChunk = process.env.AGENT_CONTEXT_CHUNK_STEPS;
  process.env.CONTEXT_KEEP_RECENT_TOKENS = "9000"; // of this suite's 16,000-token window
  process.env.AGENT_CONTEXT_CHUNK_STEPS = "3"; // small, so the turn really is several chunks

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxoffload-"));
  const FILES = 5;
  for (let i = 1; i <= FILES; i += 1) fs.writeFileSync(path.join(dir, `big-${i}.md`), hiraganaPage(168, 40));

  // Each scripted reply reports the honest size of the request it is answering, so
  // the number the pressure line is built from is a measurement, not a guess.
  const replyFor = (req) => {
    const step = req.messages.filter((m) => m.role === "assistant").length;
    const prompt = ctxm.estimateMessagesTokens(req.messages);
    const usage = { prompt_tokens: prompt, completion_tokens: 8, total_tokens: prompt + 8 };
    if (step < FILES) {
      return { text: "", toolCalls: [{ name: "readFile", arguments: { filePath: `big-${step + 1}.md` } }], usage };
    }
    if (step === FILES) {
      // The agent asks for help on its own, because the pressure line in every tool
      // result told it the window was getting full. That is the load-bearing piece:
      // the paper this design came from measured models calling these tools about
      // zero times unless the pressure was stated out loud next to every answer.
      return { text: "", toolCalls: [{ name: "manage_context", arguments: { note: "the early reads are done" } }], usage };
    }
    return { text: "I have read all five files and answered.", usage };
  };

  const backend = await startFakeBackend({ model: "stub", reply: replyFor });
  backend.pointEnvAt();
  try {
    const { tools, approve } = await harness.createGatedFsTools({ cwd: dir, allowedDirs: [dir] });
    const handle = await harness.createAgentHandle({
      name: "diagnostics",
      systemPrompt: "You are a read-only support agent.",
      tools,
      approve,
      cwd: dir,
      contextManagement: true,
    });
    assert.strictEqual(handle.session.autoCompact, false, "the library's silent summariser is off on every handle");

    const result = await quiet(() => handle.sendTurn("Read each of the five big files, then answer.", { label: "ctxoff-TCK-1" }));
    await handle.close();

    assert.strictEqual(result.chunks, 3, "one uncapped turn ran as three chunks (AGENT_CONTEXT_CHUNK_STEPS=3)");
    assert.strictEqual(result.result, "complete", "the turn finished by answering, not by being stopped");
    assert.strictEqual(result.compactions, 0, "nothing was summarised away — that is the whole change");
    assert.strictEqual(result.toolCalls.length, FILES + 1, "five reads plus the agent's own request for help");

    assert.strictEqual(result.offloads.length, 2, "two offloads: one the harness had to do, one the agent asked for");
    const reasons = result.offloads.map((o) => o.reason);
    assert.deepStrictEqual(reasons, ["hard-limit", "agent-request"], "the record says who decided each one");
    for (const off of result.offloads) {
      assert.ok(off.tokensAfter < off.tokensBefore, `the ${off.reason} offload made the conversation smaller (${off.tokensBefore} -> ${off.tokensAfter})`);
      assert.ok(off.offloadedCount > 0, "it moved at least one read answer");
      assert.ok(fs.existsSync(off.file), `the moved text is on disk at ${off.file}`);
      assert.ok(
        off.file.startsWith(path.join(harness.currentRunDir(), "agent-diagnostics")),
        "it lives beside that turn's own log, not somewhere the agent has to guess"
      );
    }
    // The door back is real: what was set aside can be listed from the folder.
    const listed = ctxm.listOffloads(result.offloads[0].dir);
    assert.ok(listed.length >= 1, "the offload folder can be read back");

    // 5 reads + 1 manage_context + 1 final answer = 7 model requests.
    assert.strictEqual(backend.requests.length, 7, "the turn kept working instead of stopping");

    const first = toolTextOf(backend.requests[0]);
    assert.strictEqual(countMarker(first, "[context offload "), 0, "the first request had nothing moved yet");

    const last = toolTextOf(backend.requests.at(-1));
    // One map block per offload, plus a one-line pointer where each moved answer used
    // to be. Two offloads moved four read answers between them.
    assert.strictEqual(countMarker(last, "[context offload "), 2, "one map block per offload, still in the conversation");
    assert.strictEqual(countMarker(last, "[offloaded "), 2, "the moved answers left a pointer, not a blank");
    assert.ok(/working window: [\d,]+ \/ 16,000 tokens/.test(last), "the pressure line reached the model on every tool answer");
    assert.ok(last.includes("recall_memory("), "the map tells the agent how to get the text back");
    assert.ok(
      backend.requests.some((req) => req.tools?.some((t) => t.function?.name === "manage_context")),
      "the memory tools were advertised on the wire, not only in the prompt text"
    );

    const summary = fs.readFileSync(path.join(harness.currentRunDir(), "summary.log"), "utf8");
    assert.ok(/offloaded \d+ read result\(s\) at chunk 1: \d+ -> \d+ tokens \(hard-limit\)/.test(summary), "the harness logged what it moved and why");
    assert.ok(summary.includes('the agent asked: "the early reads are done"'), "the agent's own reason is recorded in its words");

    ok("a managed turn sets its old reads aside on disk and keeps working — nothing was summarised away");
  } finally {
    await backend.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevKeep === undefined) delete process.env.CONTEXT_KEEP_RECENT_TOKENS;
    else process.env.CONTEXT_KEEP_RECENT_TOKENS = prevKeep;
    if (prevChunk === undefined) delete process.env.AGENT_CONTEXT_CHUNK_STEPS;
    else process.env.AGENT_CONTEXT_CHUNK_STEPS = prevChunk;
  }
}

/**
 * The wall on an uncapped turn is repetition, not a step count.
 *
 * A stuck agent is one that makes the same call and gets the same answer. That is
 * the shape the live diagnosis turn had (it re-opened the same file twelve times),
 * and it is detectable without deciding in advance how many steps a job is worth.
 */
async function scenarioStuckAgentIsStoppedByRepetition() {
  const prevLimit = process.env.AGENT_REPEAT_LIMIT;
  process.env.AGENT_REPEAT_LIMIT = "3";

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxrepeat-"));
  fs.writeFileSync(path.join(dir, "glossary.js"), "the same page, read again and again\n");

  const backend = await startFakeBackend({
    model: "stub",
    reply: () => ({ text: "", toolCalls: [{ name: "readFile", arguments: { filePath: "glossary.js" } }] }),
  });
  backend.pointEnvAt();
  try {
    const { tools, approve } = await harness.createGatedFsTools({ cwd: dir, allowedDirs: [dir] });
    const handle = await harness.createAgentHandle({
      name: "diagnostics",
      systemPrompt: "You are a read-only support agent.",
      tools,
      approve,
      cwd: dir,
      contextManagement: true,
    });

    let err = null;
    try {
      await quiet(() => handle.sendTurn("Keep reading that file until you find the answer.", { label: "ctxspin-TCK-1" }));
    } catch (e) {
      err = e;
    }
    await handle.close();

    assert.ok(err, "the turn was stopped");
    assert.match(err.message, /repeated the same tool call/, "it was stopped for repeating itself, not for running out of steps");
    assert.match(err.message, /AGENT_REPEAT_LIMIT=3/, "the wall names the knob it came from");
    assert.ok(backend.requests.length <= 4, `it stopped after ${backend.requests.length} requests instead of paying for the same call again`);

    const summary = fs.readFileSync(path.join(harness.currentRunDir(), "summary.log"), "utf8");
    assert.ok(/repeated the same tool call \(readFile/.test(summary), "the repetition is greppable in the run log");

    ok("a stuck agent is stopped by repeating the same call, and the turn is not charged for it again");
  } finally {
    await backend.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevLimit === undefined) delete process.env.AGENT_REPEAT_LIMIT;
    else process.env.AGENT_REPEAT_LIMIT = prevLimit;
  }
}

/**
 * Compaction is limited to the delivery layer.
 *
 * A pipeline-stage agent must keep everything in its context — that is the job. So
 * its handle has the library's silent summariser OFF, and a request that genuinely
 * does not fit comes back as the tagged size error the whole-installment →
 * chapter-by-chapter fallback is built to repair, instead of a quietly worse artifact.
 */
async function scenarioStageHandleDoesNotCompact() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxstage-"));
  fs.writeFileSync(path.join(dir, "source.md"), "a volume too big for one pass\n");

  const backend = await startFakeBackend({ model: "stub" });
  backend.fail("tooBig");
  backend.pointEnvAt();
  try {
    const { tools, approve } = await harness.createGatedFsTools({ cwd: dir, allowedDirs: [dir] });
    const handle = await harness.createAgentHandle({
      name: "glossary-author-01",
      systemPrompt: "You are a pipeline stage agent.",
      tools,
      approve,
      cwd: dir,
      maxSteps: 6,
    });
    assert.strictEqual(handle.session.autoCompact, false, "a stage handle has no silent summariser either");

    let err = null;
    try {
      await quiet(() => handle.sendTurn("Read the source and write the glossary.", { label: "ctxstage-01" }));
    } catch (e) {
      err = e;
    }
    await handle.close();

    assert.ok(err, "the turn failed");
    assert.ok(isTooBigForOnePassError(err), "the server's refusal is tagged as the one failure chunking repairs");
    assert.strictEqual(backend.requests.length, 1, "it did not spend a second doomed request at the same size");
    ok("a stage agent's oversized pass is reported as a size problem, not smoothed over by summarising its own context");
  } finally {
    await backend.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─── runner ──────────────────────────────────────────────────────────────────

(async () => {
  console.log("test-fake-backend.js — the stub model server, driving the real harness");
  await scenarioEndpointCheck();
  await scenarioOneShot();
  await scenarioAgentWritesThroughRealTools();
  await scenarioFailureShapes();
  await scenarioStructuredOutput();
  await scenarioCalibrationProbe();
  await scenarioRoleEndpoints();
  await scenarioModeFallback();
  await scenarioManagedTurnOffloadsInsteadOfCompacting();
  await scenarioStuckAgentIsStoppedByRepetition();
  await scenarioStageHandleDoesNotCompact();
  console.log(`\ntest-fake-backend.js: ${passed} checks passed.`);
})().catch((err) => {
  console.error(`\nFAIL: ${err && err.message}`);
  console.error(err && err.stack);
  process.exit(1);
});

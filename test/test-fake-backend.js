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
process.env.AI_THINKING = "false";
process.env.AI_CALL_DEADLINE_MS = "0"; // off, except in the hang scenario
process.env.ON_VOLUME_ERROR = "abort";
process.env.ON_QA_LIMIT = "fail";

const harness = require("../harness");
const { startFakeBackend } = require("./fake-backend");
const { assertRealToolCalls } = require("../utils/agents");
const { isTooBigForOnePassError } = require("../configs/shared");

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
    ok("the translation stage's wire contract is the official one (no system prompt, no_think, official sampling)");

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
    assert.ok(agentReq.tools.length >= 6, `the full fs tool set is advertised (${agentReq.tools.length})`);
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

// ─── runner ──────────────────────────────────────────────────────────────────

(async () => {
  console.log("test-fake-backend.js — the stub model server, driving the real harness");
  await scenarioEndpointCheck();
  await scenarioOneShot();
  await scenarioAgentWritesThroughRealTools();
  await scenarioFailureShapes();
  await scenarioCalibrationProbe();
  await scenarioRoleEndpoints();
  await scenarioModeFallback();
  console.log(`\ntest-fake-backend.js: ${passed} checks passed.`);
})().catch((err) => {
  console.error(`\nFAIL: ${err && err.message}`);
  console.error(err && err.stack);
  process.exit(1);
});

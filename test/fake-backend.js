/**
 * fake-backend.js — a scripted OpenAI-compatible model server for offline tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * The pipeline's other tests stub the AI by replacing `harness.runOneShot` and
 * `harness.createAgentHandle` with a fake function. That is cheap and it tests
 * the task logic well, but it cuts the harness OUT of the picture: the provider
 * plumbing, the streaming parser, the tool-calling loop, the approve gate, the
 * retry path, the truncation guard and the size-error tagging are never run,
 * because the fake returns a string before any of that code exists. Several
 * real bugs live exactly there (gotcha 19, gotcha 60, gotcha 61).
 *
 * This module stands where the model server stands instead. It speaks the same
 * HTTP protocol the real endpoint speaks — `POST /v1/chat/completions` (streaming
 * SSE and plain JSON) plus `GET /v1/models` — so a test points `AI_BASE_URL` at
 * it and then EVERY layer below the task code runs for real:
 *
 *   real harness.runOneShot  →  real AI SDK provider  →  real undici fetch
 *   real agent loop          →  real tool calls       →  real gated fs tools
 *   real assertModelServing  →  real GET /v1/models
 *   real measurePromptTokens →  real calibration probe
 *
 * …with no GPU, no model, no cost, and no network beyond 127.0.0.1.
 *
 * It is also the only way to test the failure shapes the pipeline is built
 * around, because a scripted server can produce them on demand: an empty reply,
 * a reply cut off at the output cap, a server that refuses the request as too
 * large, a model that writes its tool call as text, a hung connection, a 500.
 *
 * USAGE
 * -----
 *   const { startFakeBackend } = require("./fake-backend");
 *
 *   const backend = await startFakeBackend({
 *     model: "stub",
 *     reply: (req) => {
 *       if (req.userText.includes("Score the artifact")) return { text: '{"score": 90}' };
 *       return { text: "translated text" };
 *     },
 *   });
 *   backend.pointEnvAt({ prefixes: ["TRANSLATE", "VERIFY"] });   // AI_* + <PREFIX>_*
 *
 *   ... run the real task ...
 *
 *   console.log(backend.requests.length, backend.requests[0].body);
 *   await backend.close();
 *
 * No dependencies beyond Node's built-ins. Plain CommonJS, like the rest of the
 * project.
 */
const http = require("http");

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * One scripted answer for one request.
 *
 * @typedef {Object} FakeReply
 * @property {string} [text] - Assistant message content.
 * @property {string} [reasoning] - Fills `message.reasoning_content` (the shape
 *   the harness taps for its reasoning diagnostics — see gotcha 59).
 * @property {Array<{name: string, arguments: Object|string, id?: string}>} [toolCalls]
 *   Assistant tool calls. The harness executes these FOR REAL (the gated fs
 *   tools, the approve gate, the file lands on disk).
 * @property {string} [finishReason] - "stop" (default), "length", "tool_calls".
 *   "length" is what the harness's truncation guard acts on.
 * @property {number} [status] - Respond with this HTTP status instead of a
 *   completion (e.g. 400 for "prompt + max tokens exceeds the context").
 * @property {string} [error] - The message a non-2xx response carries.
 * @property {boolean} [refuseStream] - Answer a `stream: true` request with an
 *   HTTP error, so the caller's non-streaming fallback path runs.
 * @property {boolean} [hang] - Accept the request and never answer (exercises
 *   `AI_CALL_DEADLINE_MS`). Pair it with a small deadline in the test.
 * @property {boolean} [noUsage] - Omit the `usage` block (a server that does
 *   not report token counts — the calibration probe must fail softly).
 * @property {{prompt_tokens?: number, completion_tokens?: number}} [usage]
 *   Override the reported token counts.
 * @property {number} [delayMs] - Wait this long before the first byte.
 */

/**
 * One request the pipeline actually sent, as it arrived on the wire.
 *
 * @typedef {Object} FakeRequest
 * @property {string} model - The model id the client asked for.
 * @property {Array<Object>} messages - The chat messages, verbatim.
 * @property {Array<Object>} [tools] - The tool schemas the client advertised
 *   (present on agent calls, absent on tool-less one-shots).
 * @property {boolean} stream
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 * @property {string|null} reasoningEffort - The thinking dialect on the wire.
 * @property {Object|null} chatTemplateKwargs - The Qwen-style thinking switch.
 * @property {Object} body - The full parsed request body.
 * @property {string} allText - system + user text joined (for matching).
 * @property {string} userText - the user messages joined (for matching).
 * @property {number} at - Date.now() when it arrived.
 */

/**
 * @typedef {Object} FakeBackend
 * @property {string} baseUrl - `http://127.0.0.1:<port>/v1` — what to put in `AI_BASE_URL`.
 * @property {string} model - The model id `GET /v1/models` advertises.
 * @property {FakeRequest[]} requests - Every request received, in order.
 * @property {(opts?: {prefixes?: string[], model?: string, apiKey?: string}) => void} pointEnvAt
 *   Set `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` (and the same trio for each
 *   role prefix) at this server. Role prefixes are how a test gives each stage
 *   its own scripted model through the real `roleEndpoint` seam.
 * @property {(reply: FakeReply|((req: FakeRequest) => FakeReply)) => void} queue
 *   Push one answer to use before the `reply` function is consulted.
 * @property {(kind: string, opts?: Object) => void} fail
 *   Queue a named failure shape (see FAILURE_KINDS).
 * @property {(pattern: string|RegExp) => FakeRequest[]} callsMatching
 *   The requests whose text matches a pattern (for assertions).
 * @property {() => void} reset - Drop the recorded requests and the queued answers.
 * @property {() => Promise<void>} close - Stop the server.
 */

// ─── Failure shapes the pipeline is built to survive ─────────────────────────

/**
 * The canned answers `backend.fail(kind)` can queue. Each one is a real failure
 * this pipeline has seen or guards against; the name is what makes a test read
 * as a sentence.
 */
const FAILURE_KINDS = {
  /** finish_reason=stop, no content — `runOneShot` must throw, never return "". */
  empty: () => ({ text: "", finishReason: "stop" }),
  /** finish_reason=length — the truncation guard must tag it tooBigForOnePass. */
  truncated: (opts) => ({ text: opts.text || "half a chapter before the cap hit", finishReason: "length" }),
  /** The server refusing the request as too large for its context (gotcha 36). */
  tooBig: (opts) => ({
    status: 400,
    error:
      opts.error ||
      "prompt (4337 tokens) + max tokens (262144) exceeds the context; requests are never truncated",
  }),
  /** A reasoning phase that ate the whole reply budget (gotcha 59). */
  reasoningOnly: (opts) => ({
    text: "",
    reasoning: opts.reasoning || "x".repeat(4000),
    finishReason: "length",
  }),
  /** A model that writes its tool call as text instead of using the API (gotcha 18). */
  malformedToolCall: (opts) => ({
    text:
      opts.text ||
      '<tool_call>{"name": "writeFile", "arguments": {"filePath": "out.md"}}</tool_call>',
    finishReason: "stop",
  }),
  /** A dead endpoint: HTTP 500 (exercises the retry path and the streaming fallback). */
  serverError: (opts) => ({ status: 500, error: opts.error || "model container died" }),
  /** A server that will not stream (exercises runOneShot's non-streaming fallback). */
  noStreaming: () => ({ refuseStream: true, status: 500, error: "streaming unsupported by this server" }),
  /**
   * A server that honours `response_format` and could not fit the answer to it: HTTP 502
   * with the code the real endpoint uses. `runOneShot` must tag it as a structured-output
   * failure — not a size failure, and not "the model returned no content".
   */
  refusedShape: (opts) => ({
    status: 502,
    error: opts.error || "failed to generate structured output: answer does not match the schema",
    errorCode: opts.errorCode || "structured_output_failed",
  }),
  /**
   * The same refusal on the streaming path: the server answers 200, emits an error FRAME
   * instead of any content, and closes. Nothing downstream sees it — the provider reads a
   * stream with no parts in it — which is exactly the hole the SSE tap exists to catch.
   */
  refusedShapeStream: (opts) => ({
    streamError: {
      message: opts.error || "failed to generate structured output: answer does not match the schema",
      code: opts.errorCode || "structured_output_failed",
    },
  }),
  /** A hung connection (exercises AI_CALL_DEADLINE_MS). */
  hang: () => ({ hang: true }),
  /** A server that reports no token usage (the calibration probe must fail softly). */
  noUsage: (opts) => ({ text: opts.text || "answered", noUsage: true }),
};

// ─── Wire helpers ────────────────────────────────────────────────────────────

/**
 * Flatten a chat-completion body's messages into plain text so a test can match
 * a request by what it asked for (the label is not on the wire — the prompt is).
 *
 * @param {Object} body - The parsed request body.
 * @returns {{allText: string, userText: string}}
 */
function textOfBody(body) {
  const parts = { system: [], user: [], other: [] };
  for (const message of body.messages || []) {
    const content = message?.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
    }
    const bucket = parts[message.role] ? message.role : "other";
    parts[bucket].push(text);
  }
  return {
    allText: [...parts.system, ...parts.user, ...parts.other].join("\n"),
    userText: [...parts.user, ...parts.other].join("\n"),
  };
}

/**
 * Turn one FakeReply into an SSE chunk sequence (what a streaming
 * OpenAI-compatible server puts on the wire).
 *
 * @param {FakeReply} reply
 * @param {{id: string, created: number, model: string}} base
 * @param {Object} body - The request body (decides whether usage is expected).
 * @returns {string} The complete SSE payload.
 */
function ssePayload(reply, base, body) {
  const chunk = (delta, finishReason, extra) => ({
    ...base,
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    ...(extra || {}),
  });
  const lines = [chunk({ role: "assistant" }, null)];

  if (reply.reasoning) {
    // The shape llama.cpp-style servers use for a thinking phase.
    lines.push(chunk({ reasoning_content: reply.reasoning }, null));
  }
  if (Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0) {
    reply.toolCalls.forEach((call, index) => {
      lines.push(
        chunk(
          {
            tool_calls: [
              {
                index,
                id: call.id || `call-${base.id}-${index}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments:
                    typeof call.arguments === "string"
                      ? call.arguments
                      : JSON.stringify(call.arguments ?? {}),
                },
              },
            ],
          },
          null
        )
      );
    });
  }
  if (reply.text) {
    lines.push(chunk({ content: reply.text }, null));
  }
  const finish =
    reply.finishReason ||
    (Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0 ? "tool_calls" : "stop");

  const usage =
    reply.noUsage || body.stream_options?.include_usage !== true
      ? null
      : reply.usage || {
          prompt_tokens: 100,
          completion_tokens: Math.ceil((String(reply.text || "").length + (reply.reasoning || "").length) / 4) || 1,
          total_tokens: 100 + (Math.ceil((String(reply.text || "").length + (reply.reasoning || "").length) / 4) || 1),
        };
  const last = chunk({}, finish, usage ? { usage } : null);
  lines.push(last);

  return lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("") + "data: [DONE]\n\n";
}

/**
 * Turn one FakeReply into a non-streaming chat-completion JSON body.
 *
 * @param {FakeReply} reply
 * @param {{id: string, created: number, model: string}} base
 * @returns {Object}
 */
function jsonPayload(reply, base) {
  const message = { role: "assistant" };
  if (reply.text) message.content = reply.text;
  if (reply.reasoning) message.reasoning_content = reply.reasoning;
  if (Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0) {
    message.tool_calls = reply.toolCalls.map((call, index) => ({
      id: call.id || `call-${base.id}-${index}`,
      type: "function",
      function: {
        name: call.name,
        arguments:
          typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
      },
    }));
  }
  const finish =
    reply.finishReason ||
    (Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0 ? "tool_calls" : "stop");
  const completionTokens =
    Math.ceil((String(reply.text || "").length + (reply.reasoning || "").length) / 4) || 1;
  return {
    ...base,
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: reply.noUsage
      ? undefined
      : reply.usage || {
          prompt_tokens: 100,
          completion_tokens: completionTokens,
          total_tokens: 100 + completionTokens,
        },
  };
}

// ─── The server ──────────────────────────────────────────────────────────────

/**
 * Start the fake model server on a free 127.0.0.1 port.
 *
 * @param {{model?: string|string[], reply?: (req: FakeRequest) => FakeReply|Promise<FakeReply>}} [options]
 *   `model` is the id (or list of ids) advertised by `GET /v1/models` — and
 *   therefore the id a test puts in `AI_MODEL` / `<ROLE>_MODEL` so
 *   `assertModelServing` passes. A test that gives each translation-stage role
 *   its own model id lists them all here, which is what lets ONE server answer
 *   every stage differently while the real control-plane check still does its
 *   job. `reply` decides what each request gets; queued answers take priority.
 * @returns {Promise<FakeBackend>}
 */
async function startFakeBackend({ model = "stub", reply = null } = {}) {
  const advertised = Array.isArray(model) ? model : [model];
  /** @type {FakeRequest[]} */
  const requests = [];
  /** @type {Array<FakeReply|((req: FakeRequest) => FakeReply)>} */
  const queued = [];
  /** @type {Set<import("http").ServerResponse>} */
  const openResponses = new Set();
  let answered = 0;

  /**
   * Resolve the answer for one request: a queued one first (so a test can say
   * "the third call fails"), then the `reply` function.
   *
   * @param {FakeRequest} req
   * @returns {Promise<FakeReply>}
   */
  async function resolveReply(req) {
    const next = queued.shift();
    if (next) return typeof next === "function" ? next(req) : next;
    if (reply) return reply(req);
    return { text: "" };
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && (req.url.endsWith("/models") || req.url === "/v1")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ object: "list", data: advertised.map((id) => ({ id, object: "model" })) })
      );
      return;
    }
    if (req.method === "GET" && (req.url.endsWith("/health") || req.url === "/health")) {
      // The per-machine model-switch hooks poll /health; a test that exercises
      // them needs the same answer.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fake-backend: request body is not JSON" } }));
        return;
      }
      const texts = textOfBody(body);
      /** @type {FakeRequest} */
      const record = {
        model: body.model,
        messages: body.messages || [],
        tools: body.tools,
        stream: body.stream === true,
        maxTokens: body.max_tokens,
        temperature: body.temperature,
        reasoningEffort: body.reasoning_effort ?? null,
        chatTemplateKwargs: body.chat_template_kwargs ?? null,
        // What shape the caller asked the answer to take. A test asserting that a grader
        // actually asked for one checks this, because nothing else on the wire says so.
        responseFormat: body.response_format ?? null,
        body,
        ...texts,
        at: Date.now(),
      };
      requests.push(record);
      answered += 1;

      const answer = await resolveReply(record);
      if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));

      if (answer.hang) {
        // Never answer: the caller's idle deadline is what ends this.
        openResponses.add(res);
        res.on("close", () => openResponses.delete(res));
        return;
      }
      if (answer.status && answer.status >= 400) {
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: answer.error || `fake-backend: scripted HTTP ${answer.status}`,
              // The code is the part a real server uses to name its own failure class, and the
              // part the harness's tagging matches on.
              ...(answer.errorCode ? { code: answer.errorCode } : {}),
            },
          })
        );
        return;
      }
      if (answer.refuseStream && record.stream) {
        res.writeHead(answer.status || 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: answer.error || "streaming unsupported" } }));
        return;
      }

      const base = { id: `chatcmpl-fake-${answered}`, created: Math.floor(Date.now() / 1000), model: body.model };
      if (answer.streamError && record.stream) {
        // HTTP 200, an error FRAME instead of any content, then the stream closes. This is what
        // a server that honours `response_format` does when the model cannot fit the shape — and
        // the shape the provider layer cannot see, because a stream with no parts in it is not
        // an error to it.
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        openResponses.add(res);
        res.on("close", () => openResponses.delete(res));
        res.write(`data: ${JSON.stringify({ ...base, error: answer.streamError })}\n\ndata: [DONE]\n\n`);
        res.end();
        return;
      }
      if (record.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        openResponses.add(res);
        res.on("close", () => openResponses.delete(res));
        res.write(ssePayload(answer, base, body));
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(jsonPayload(answer, base)));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  return {
    baseUrl,
    model: advertised[0],
    advertised,
    requests,

    pointEnvAt({ prefixes = [], apiKey = "fake-key", model: modelOverride } = {}) {
      process.env.AI_BASE_URL = baseUrl;
      process.env.AI_API_KEY = apiKey;
      process.env.AI_MODEL = modelOverride || advertised[0];
      for (const prefix of prefixes) {
        process.env[`${prefix}_BASE_URL`] = baseUrl;
        process.env[`${prefix}_API_KEY`] = apiKey;
        // A distinct model id per role is what lets one server answer every
        // stage differently — and it exercises the real `roleEndpoint` seam.
        process.env[`${prefix}_MODEL`] =
          modelOverride || (advertised.length > 1 ? `${advertised[0]}-${prefix.toLowerCase()}` : advertised[0]);
      }
    },

    queue(next) {
      queued.push(next);
    },

    fail(kind, opts = {}) {
      const make = FAILURE_KINDS[kind];
      if (!make) {
        throw new Error(
          `fake-backend: unknown failure kind "${kind}". Known kinds: ${Object.keys(FAILURE_KINDS).join(", ")}.`
        );
      }
      queued.push(make(opts));
    },

    callsMatching(pattern) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
      return requests.filter((r) => re.test(r.allText));
    },

    reset() {
      requests.length = 0;
      queued.length = 0;
    },

    async close() {
      for (const res of openResponses) {
        try {
          res.destroy();
        } catch {
          /* already gone */
        }
      }
      openResponses.clear();
      // The harness's fetch keeps connections alive; without this the server
      // never finishes closing and the test process hangs.
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startFakeBackend, FAILURE_KINDS };

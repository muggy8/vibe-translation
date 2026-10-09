/**
 * runOneShot — one tool-less call. Streaming with a non-streaming fallback, retries
 * on empty/error, an idle deadline, and a THROW on empty: workflows persist the
 * returned string verbatim, so an empty result must fail the run rather than corrupt
 * an artifact. The non-streaming retry is skipped when the error is already tagged
 * as a size failure (a second doomed request at the same size) or as a refused answer
 * shape (the same request asked the same way is refused the same way).
 *
 * `responseFormat` asks the endpoint for a fixed answer shape. It is a detector, not a
 * guarantee: this machine's endpoint refuses a violation with `structured_output_failed`,
 * and the harness turns that into its own error class so a refused shape never becomes
 * "the model returned no content". On that path the harness's retry counter is the only
 * retry, so the number of attempts means what it says.
 *
 * Part of the harness.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions
const { tool, generateText } = require("ai");
const {
  tooBigForOnePassError,
  isTooBigForOnePassError,
  structuredOutputError,
  isStructuredOutputError,
} = require("../configs/shared");

const { createChatModel, createTaps, createTapsRef, loadEsm, thinkingExtraBody, toModelMessages } = require("./provider");
const { logFilePath, logLine, writeOneShotLog } = require("./log");
const { envCallDeadlineMs, envContextWindow, envRetry, envTemperature, envThinking } = require("./env");
const { consumeEvents, logResultLine } = require("./turn");
const { tagSizeOverflowError, tagStructuredOutputError } = require("./endpoint");

/**
 * A single tool-less model call — the drop-in replacement for the old
 * callAi(). Used by acceptance checks, classic-mode pipeline stages, and
 * the CLI below.
 *
 * Mirrors the old behaviour: retries on API errors (via the open-harness
 * retry middleware), falls back to one non-streaming call if the streaming
 * path fails, retries empty responses up to `retry` times, and throws (never
 * returning empty) so callers never persist an empty result.
 *
 * @param {RunOneShotCfg} cfg
 * @param {string|null} [cfg.systemPrompt] - The system prompt. `null`/
 *   `undefined` sends NO system message at all (required by the Index-Translate
 *   translation role — its official prompt contract is a single user
 *   message; the model has no system prompt).
 * @param {Array<IMessage>} cfg.messages - IMessages ({ text } | { file, name }).
 * @param {number} [cfg.retry] - Extra attempts on empty/error (default: AI_RETRY).
 * @param {boolean|string} [cfg.thinking] - Thinking mode (default: AI_THINKING env, on).
 *   For the hy-mt and index-mt template dialects also accepts "no_think" | "low" | "high".
 * @param {string} [cfg.thinkingLevel] - reasoning_effort level (default: AI_THINKING_LEVEL env / "xhigh").
 * @param {"qwen"|"hy-mt"|"index-mt"} [cfg.thinkingTemplate] - Chat-template dialect for the
 *   thinking parameters (default: "qwen"; "index-mt" for the Index-Translate translation
 *   model — see thinkingExtraBody).
 * @param {{baseUrl?: string, apiKey?: string, model?: string}} [cfg.endpoint] -
 *   Per-call endpoint override (a role's own model; defaults to the global
 *   AI_* settings). The translation stage's roles each use their own.
 * @param {number} [cfg.temperature] - Per-call temperature (default: AI_TEMPERATURE env).
 * @param {{topP?: number, topK?: number, minP?: number, repetitionPenalty?: number, presencePenalty?: number}} [cfg.sampling] -
 *   Per-call sampling parameters merged into the request body (llama.cpp's
 *   OpenAI-compatible API accepts all of these; the server's own defaults
 *   apply to any omitted key).
 * @param {Object} [cfg.responseFormat] - Ask the endpoint for a fixed answer shape: the
 *   `response_format` request field, merged into the same body the thinking parameters ride
 *   in. A plain object, e.g. `{ type: "json_object" }` or
 *   `{ type: "json_schema", json_schema: { name, schema } }`.
 *
 *   Two things this is NOT, and both matter:
 *   - It is not a guarantee. This machine's endpoint enforces it (a violation answers
 *     `structured_output_failed`), but a server that ignores the field answers normally, and
 *     every caller still validates the reply. The format makes a bad answer LOUD; the
 *     validator is what makes it impossible.
 *   - It is not available to a tool-using agent. On this endpoint `response_format` and
 *     `tools` are mutually exclusive (asking for both is an HTTP 400), so this option exists
 *     only on `runOneShot`, which is tool-less by definition. It must never reach the
 *     translation role either: that stage's contract is prose.
 * @param {string} [cfg.label] - Log label (default: "one-shot").
 * @returns {Promise<string>} The model's content.
 */
async function runOneShot({
  systemPrompt = null,
  messages,
  retry,
  thinking = envThinking(),
  thinkingLevel,
  thinkingTemplate = "qwen",
  endpoint = null,
  temperature = null,
  sampling = null,
  responseFormat = null,
  maxTokens: maxTokensOverride = null,
  contextWindow: contextWindowOverride = null,
  label = "one-shot",
}) {
  if (systemPrompt != null && (typeof systemPrompt !== "string" || !systemPrompt.trim())) {
    throw new Error(
      "systemPrompt must be a non-empty string (or null/undefined to send no system message)."
    );
  }
  const retryCount =
    Number.isInteger(retry) && retry >= 0 ? retry : envRetry();
  const apiMessages = await toModelMessages(messages);
  let extraBody = thinkingExtraBody({ thinking, thinkingLevel, template: thinkingTemplate });
  if (sampling && typeof sampling === "object") {
    const wireNames = {
      topP: "top_p",
      topK: "top_k",
      minP: "min_p",
      repetitionPenalty: "repetition_penalty",
      presencePenalty: "presence_penalty",
    };
    for (const [key, wire] of Object.entries(wireNames)) {
      if (typeof sampling[key] === "number" && Number.isFinite(sampling[key])) {
        extraBody = { ...(extraBody || {}), [wire]: sampling[key] };
      }
    }
  }
  // Structured output: the caller asked for a fixed answer shape. It rides in the same body
  // the thinking parameters and the sampling knobs ride in, because that is the one place this
  // harness can add a chat-completions field the SDK does not model for a custom provider.
  //
  // Asking for a shape is not the same as getting one: a server that honours it answers
  // `structured_output_failed` when the model cannot fit the shape, and a server that ignores
  // it answers normally. Either way the caller still validates the reply — the format makes a
  // bad answer loud, the validator is what makes it impossible.
  if (responseFormat !== null && responseFormat !== undefined) {
    if (typeof responseFormat !== "object" || Array.isArray(responseFormat)) {
      throw new Error(
        `${label}: responseFormat must be a plain object (the "response_format" request field), ` +
          `e.g. { type: "json_object" } or { type: "json_schema", json_schema: { name, schema } }. ` +
          `Got ${Array.isArray(responseFormat) ? "an array" : typeof responseFormat}.`
      );
    }
    extraBody = { ...(extraBody || {}), response_format: responseFormat };
  }
  const structured = responseFormat !== null && responseFormat !== undefined;

  const temperatureValue =
    typeof temperature === "number" && Number.isFinite(temperature)
      ? temperature
      : envTemperature();

  // The output cap. AI_MAX_TOKENS (or a per-call override) wins; otherwise it is
  // derived from the context window — the call's own role window when one is
  // given, else the global AI_CONTEXT_WINDOW. Deriving from a quarter of the
  // window keeps "prompt + max tokens exceeds the context" unreachable by
  // construction (gotcha 36), and the per-call override is what lets a role
  // whose server has a SMALLER context (a translation model at 8k, say) ask for
  // a smaller answer instead of being handed the global model's cap.
  const contextWindow =
    Number.isInteger(contextWindowOverride) && contextWindowOverride > 0
      ? contextWindowOverride
      : envContextWindow();
  const maxTokens =
    Number.isInteger(maxTokensOverride) && maxTokensOverride > 0
      ? maxTokensOverride
      : Math.max(1024, Math.floor(contextWindow / 4));

  // Resolve the endpoint this call targets (role override or global AI_*).
  const baseUrl =
    endpoint?.baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1";
  const modelId = endpoint?.model || process.env.AI_MODEL || "gpt-4o-mini";

  const systemPreview = systemPrompt
    ? systemPrompt.trim().split("\n")[0].slice(0, 80)
    : "(no system prompt)";
  logLine(
    `[call-ai] CALL system="${systemPreview}" messages=${messages.length} retry=${retryCount} ` +
      `model=${modelId} endpoint=${baseUrl}` +
      (structured ? ` response_format=${JSON.stringify(responseFormat)}` : "")
  );

  const { core } = await loadEsm();
  let remaining = retryCount;

  // Every refusal of the requested shape this call saw, across every attempt. The provider can
  // ask the endpoint more than once per attempt, so the number of refusals — not the number of
  // attempts — is what tells a reader how many times the endpoint was given the chance and said
  // no. It is also the difference between "the shape was refused once and the next ask worked"
  // and "this endpoint cannot answer in this shape at all".
  let shapeRefusals = 0;
  let lastShapeRefusal = null;
  /**
   * Record the shape refusals one attempt produced.
   * @param {{structuredRefusals?: string[]}|null} taps - The attempt's taps.
   * @returns {void}
   */
  function noteShapeRefusals(taps) {
    for (const refusal of (taps && taps.structuredRefusals) || []) {
      shapeRefusals += 1;
      lastShapeRefusal = refusal;
    }
  }

  for (;;) {
    const tapsRef = createTapsRef();
    tapsRef.current = createTaps();
    const { model } = await createChatModel({ extraBody, tapsRef, endpoint });
    const agent = new core.Agent({
      name: label,
      model,
      // OpenHarness filters falsy system parts, so "" = no system message.
      systemPrompt: systemPrompt || "",
      temperature: temperatureValue,
      maxTokens,
      instructions: false,
      maxSteps: 1,
    });
    const runner = core.apply(
      core.toRunner(agent),
      // On the structured path the harness's own counter is the ONLY retry. Left at `remaining`,
      // the middleware would spend up to that many requests INSIDE one attempt — each one a real
      // call to the endpoint, each one invisible except as a `retry` event — and then the loop
      // below would retry again on top of them. With a shape refusal the two layers multiply, and
      // "it failed once" quietly means "it hit the endpoint four times".
      core.withRetry({ maxRetries: structured ? 0 : remaining, isRetryable: () => true }),
      core.withTurnTracking()
    );
    const chat = new core.Conversation({ runner });

    let result;
    // Idle deadline (AI_CALL_DEADLINE_MS): aborts this attempt when the
    // endpoint makes no progress for this long — the only wall-clock bound
    // on a model call (all fetch timeouts are disabled for local servers).
    const idleMs = envCallDeadlineMs();
    const idleCtrl = new AbortController();
    try {
      // Build logContext for streaming logs.
      const logContext = { type: "one-shot", label };
      result = await consumeEvents(
        chat.send(apiMessages, { signal: idleCtrl.signal }),
        {
          label,
          tapsRef,
          logContext,
          idleDeadlineMs: idleMs,
          onIdleExpire: () => idleCtrl.abort(),
        }
      );
    } catch (streamError) {
      noteShapeRefusals(tapsRef.current);
      if (idleCtrl.signal.aborted) {
        throw new Error(
          `${label}: the call made no progress for ${Math.round(idleMs / 60000)} min ` +
            `and was aborted (AI_CALL_DEADLINE_MS=${idleMs}). The endpoint is likely ` +
            `hung or the model container died — check .logs/ and re-run.`
        );
      }
      // A request the server refused for being too large is a SIZE failure, not a
      // flaky call: tag it before the non-streaming fallback re-throws it, so the
      // task above can act on it (a whole-installment pass may be retried
      // chapter by chapter) instead of re-running the same oversized request.
      streamError = tagStructuredOutputError(tagSizeOverflowError(streamError, label), label);
      // A request the server refused for being too large fails the same way
      // without streaming (identical prompt, identical output cap), so the
      // non-streaming retry would only pay for a second doomed request.
      if (isTooBigForOnePassError(streamError)) throw streamError;
      // A refused shape fails the same way without streaming — identical prompt, identical
      // requested shape — so the non-streaming fallback would only pay for a second doomed call.
      // Go round the harness's own loop instead: a bounded number of re-asks, each one named in
      // the run log, because "the grader could not answer in the shape it was asked for" is the
      // fact a later diagnosis needs and a silent retry is not.
      if (isStructuredOutputError(streamError)) {
        if (remaining > 0) {
          remaining -= 1;
          logLine(
            `  [call-ai] ${label}: the endpoint refused the requested answer shape ` +
              `(${String(streamError.message).slice(0, 200)}). Re-asking: ${remaining} attempt(s) left.`
          );
          continue;
        }
        throw structuredOutputError(
          `${label}: the endpoint could not produce an answer in the shape it was asked for, ` +
            `after ${retryCount + 1} attempt(s). ${streamError.message}`
        );
      }
      // The streaming path failed (API error, parse error, a server that
      // does not actually stream, ...). Fall back to one non-streaming
      // call, mirroring the old call-ai.js behaviour. If the fallback also
      // fails, re-throw the original streaming error.
      logLine(
        `  [call-ai] streaming failed (${streamError.message}); retrying without streaming...`
      );
      const fallbackTapsRef = createTapsRef();
      fallbackTapsRef.current = createTaps();
      const { model: fallbackModel } = await createChatModel({
        extraBody,
        tapsRef: fallbackTapsRef,
        endpoint,
      });
      // The non-streaming fallback has no events to reset the idle timer,
      // so the same deadline applies as a plain (total) timeout.
      const fbCtrl = new AbortController();
      const fbTimer = idleMs > 0 ? setTimeout(() => fbCtrl.abort(), idleMs) : null;
      try {
        const completion = await generateText({
          model: fallbackModel,
          system: systemPrompt || undefined,
          messages: apiMessages,
          temperature: temperatureValue,
          maxOutputTokens: maxTokens,
          abortSignal: fbCtrl.signal,
        });
        await fallbackTapsRef.current.jsonReasoningReady?.catch(() => {});
        result = {
          text: completion.text ?? "",
          reasoning: (fallbackTapsRef.current.reasoning ?? []).join(""),
          finishReason: completion.finishReason,
          usage: {
            inputTokens: completion.usage?.inputTokens,
            outputTokens: completion.usage?.outputTokens,
            totalTokens: completion.usage?.totalTokens,
          },
          result: "complete",
          error: null,
          messages: [],
          startTime: Date.now(),
          firstTokenTime: null,
        };
      } catch {
        if (fbCtrl.signal.aborted) {
          throw new Error(
            `${label}: the call made no progress for ${Math.round(idleMs / 60000)} min ` +
              `and was aborted (AI_CALL_DEADLINE_MS=${idleMs}). The endpoint is likely ` +
              `hung or the model container died — check .logs/ and re-run.`
          );
        }
        throw streamError;
      } finally {
        if (fbTimer) clearTimeout(fbTimer);
      }
    }

    logResultLine(result, label);

    // Log full call details (system prompt, messages, response).
    writeOneShotLog(label, systemPrompt, messages, result.text, result, modelId);

    // Truncation guard: a response cut off at the output token limit
    // (finish_reason="length") is a TRUNCATED answer, never a complete one —
    // persisting it would corrupt the artifact (a half-chapter, a broken JSON
    // extraction, …). Retrying is pointless (the limit is deterministic), so
    // fail loudly instead. The deterministic QA length floor in
    // utils/translate.js is the backstop for the rare case where the finish
    // reason is unavailable.
    if (result.text && result.finishReason === "length") {
      throw tooBigForOnePassError(
        `${label}: the model hit its output token limit (finish_reason=length) after ` +
          `${result.text.length} chars — the response is TRUNCATED and was discarded. ` +
          `Increase AI_MAX_TOKENS (currently ${maxTokens}${
            process.env.AI_MAX_TOKENS ? "" : ", derived from AI_CONTEXT_WINDOW"
          }) or shrink the input ` +
          `(e.g. TRANSLATE_CHUNK_CHARS for translation) and re-run.`
      );
    }
    if (result.text) {
      // An answer that arrived AFTER a refusal is still an answer, but the refusal is the fact
      // worth keeping: a grader that had to be asked twice is a grader whose grades cannot be
      // compared to each other without knowing that.
      if (structured && shapeRefusals > 0) {
        logLine(
          `  [call-ai] ${label}: the endpoint refused the requested answer shape ` +
            `${shapeRefusals} time(s) before producing this answer.`
        );
      }
      return result.text;
    }
    if (remaining > 0) {
      remaining -= 1;
      continue;
    }
    // A shape the endpoint refused is not an empty model, and the two need different fixes:
    // one is a container to restart, the other is a request to rephrase. Say which one happened,
    // and how many times the endpoint was asked.
    if (structured && shapeRefusals > 0) {
      throw structuredOutputError(
        `${label}: the endpoint refused to answer in the shape it was asked for ` +
          `(${shapeRefusals} refusal(s) across ${retryCount + 1} attempt(s)). Its own reason: ` +
          `${lastShapeRefusal}. The request asked for ${JSON.stringify(responseFormat)} — check ` +
          `that this endpoint honours response_format, and that the schema matches what the ` +
          `prompt asks the model to write. Check the run log: ${logFilePath}`
      );
    }
    // Never hand an empty result back to callers: the workflows persist the
    // returned string verbatim, so an empty model response must fail the run
    // instead of corrupting the generated artifacts.
    throw new Error(
      `${label}: the model returned no content (finish_reason=${result.finishReason ?? "n/a"}). ` +
        (structured
          ? `The call asked for a fixed answer shape (${JSON.stringify(responseFormat)}) and the ` +
            `endpoint produced nothing at all — check that the endpoint honours response_format. `
          : "") +
        (result.reasoning
          ? "The token budget appears to have been spent on reasoning; try raising AI_MAX_TOKENS or AI_CONTEXT_WINDOW. "
          : "") +
        `Check the run log: ${logFilePath}`
    );
  }
}

// ─── Tool-using agents ──────────────────────────────────────────────────────


module.exports = {
  runOneShot,
};

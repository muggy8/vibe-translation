/**
 * runOneShot — one tool-less call. Streaming with a non-streaming fallback, retries
 * on empty/error, an idle deadline, and a THROW on empty: workflows persist the
 * returned string verbatim, so an empty result must fail the run rather than corrupt
 * an artifact. The non-streaming retry is skipped when the error is already tagged
 * as a size failure (a second doomed request at the same size).
 *
 * Part of the harness.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions
const { tool, generateText } = require("ai");
const { tooBigForOnePassError, isTooBigForOnePassError } = require("../configs/shared");

const { createChatModel, createTaps, createTapsRef, loadEsm, thinkingExtraBody, toModelMessages } = require("./provider");
const { logFilePath, logLine, writeOneShotLog } = require("./log");
const { envCallDeadlineMs, envContextWindow, envRetry, envTemperature, envThinking } = require("./env");
const { consumeEvents, logResultLine } = require("./turn");
const { tagSizeOverflowError } = require("./endpoint");

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
      `model=${modelId} endpoint=${baseUrl}`
  );

  const { core } = await loadEsm();
  let remaining = retryCount;
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
      core.withRetry({ maxRetries: remaining, isRetryable: () => true }),
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
      streamError = tagSizeOverflowError(streamError, label);
      // A request the server refused for being too large fails the same way
      // without streaming (identical prompt, identical output cap), so the
      // non-streaming retry would only pay for a second doomed request.
      if (isTooBigForOnePassError(streamError)) throw streamError;
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
    if (result.text) return result.text;
    if (remaining > 0) {
      remaining -= 1;
      continue;
    }
    // Never hand an empty result back to callers: the workflows persist the
    // returned string verbatim, so an empty model response must fail the run
    // instead of corrupting the generated artifacts.
    throw new Error(
      `The model returned no content (finish_reason=${result.finishReason ?? "n/a"}). ` +
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

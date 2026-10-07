/**
 * How a stage runs rather than what it does: the bounded worker pool, the one
 * worker-count knob, the judging-vs-writing sampling settings, and the per-role
 * endpoint resolution (TRANSLATE_* / VERIFY_* / EDIT_* / AUDIT_*, each falling back
 * to AI_*).
 *
 * Part of the translate.js layer (split out of the original single file).
 */

/**
 * Run `fn` over `items` with at most `limit` in flight (a bounded worker
 * pool). `fn(item, index)` receives the item's index, so callers can store
 * results in input order regardless of completion order.
 *
 * Used by the per-chapter loops of the translation stage's INDEPENDENT
 * tasks (verify / retranslate / polish). `limit` 1 is the default — the
 * local hardware runs one inference at a time, so concurrency is opt-in —
 * and with limit 1 the behaviour is exactly the old serial loop. When fn
 * rejects, no further items are started (already-running ones finish), and
 * the first error is rethrown.
 *
 * @param {Array<*>} items - The items to process.
 * @param {number} limit - Max concurrent fn calls (minimum 1).
 * @param {(item: *, index: number) => Promise<*>} fn - The per-item work.
 * @returns {Promise<Array<*>} The fn results in input order.
 */
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let firstError = null;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length || 1)) },
    async () => {
      for (;;) {
        if (firstError) return;
        const i = next;
        next += 1;
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i], i);
        } catch (err) {
          if (!firstError) firstError = err;
          return;
        }
      }
    }
  );
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}


/**
 * Per-stage chapter concurrency knob: STAGE_CONCURRENCY — the number of
 * independent units a stage runs at once (chapters per verify / retranslate /
 * polish pass, chapters per audit batch, research agents per glossary term).
 * Defaults to 1 (serial) because the local hardware runs one inference at
 * a time; raise it when the endpoint can serve parallel requests.
 *
 * The old per-stage names (`<PREFIX>_CONCURRENCY`) still work as per-stage
 * overrides for an existing .env.
 *
 * The `translate` task deliberately stays serial: each chapter's prompt
 * carries the previous chapter's ending as continuity context, so its
 * chapters are chained and cannot run in parallel.
 *
 * @param {"VERIFY"|"RETRANSLATE"|"POLISH"|"AUDIT"} prefix - The legacy per-stage prefix.
 * @returns {number} The concurrency limit (minimum 1).
 */
function stageConcurrency(prefix) {
  const perStage = parseInt(process.env[`${prefix}_CONCURRENCY`], 10);
  if (Number.isInteger(perStage) && perStage >= 1) return perStage;
  const shared = parseInt(process.env.STAGE_CONCURRENCY, 10);
  return Number.isInteger(shared) && shared >= 1 ? shared : 1;
}

/**
 * Sampling temperature for every call that GRADES text rather than writes it.
 * Re-exported from configs/shared.js (its home) so the translation-stage tasks
 * keep importing it from here — see configs/shared.js for the knob and its
 * legacy names.
 *
 * @returns {number}
 */
const { judgeTemperature, judgeThinking } = require("../../configs/shared");


/**
 * Thinking dialect for a translation-stage call: the global AI_THINKING switch
 * plus STAGE_THINKING_LEVEL (default "medium").
 *
 * The stage calls deliberate LESS than the authoring agents (AI_THINKING_LEVEL,
 * default "xhigh"): an author writes a long artifact, these judge or proofread a
 * single chapter. Merging the six per-stage knobs into this pair keeps that
 * separation while dropping the bookkeeping; the legacy names
 * (`<PREFIX>_THINKING` / `<PREFIX>_THINKING_LEVEL`) are still honored.
 *
 * Delegates to `judgeThinking()` (configs/shared.js) so the rule "a call that
 * grades does not spend the reply budget thinking" has ONE implementation for
 * the whole pipeline, not one for the translation stage and none for the
 * acceptance graders (gotcha 59).
 *
 * @param {"VERIFY"|"AUDIT"|"EDIT"} prefix - The legacy per-stage prefix.
 * @returns {{thinking: boolean, thinkingLevel: string}}
 */
function stageThinking(prefix) {
  return judgeThinking(prefix);
}


/**
 * Sampling temperature for a stage that WRITES text: the stage's own knob
 * (`<PREFIX>_TEMPERATURE`) when set, otherwise the global AI_TEMPERATURE.
 *
 * Used by polish (a rewrite pass — it follows the run's house temperature).
 * `translate` does NOT use this: Hy-MT2's 0.7 is part of the model's official
 * sampling recipe, not a house preference, so TRANSLATE_TEMPERATURE keeps its
 * own default.
 *
 * @param {"EDIT"} prefix - The stage prefix.
 * @param {number} fallback - Used when neither the stage knob nor AI_TEMPERATURE is set.
 * @returns {number}
 */
function writerTemperature(prefix, fallback) {
  const own = parseFloat(process.env[`${prefix}_TEMPERATURE`]);
  if (Number.isFinite(own)) return own;
  const global = parseFloat(process.env.AI_TEMPERATURE);
  return Number.isFinite(global) ? global : fallback;
}


/**
 * Resolve a model role's endpoint from env: `<PREFIX>_BASE_URL` /
 * `<PREFIX>_API_KEY` / `<PREFIX>_MODEL`, each falling back to the global
 * `AI_*` settings (so a single-model setup works with no extra config).
 *
 * @param {"TRANSLATE"|"VERIFY"|"EDIT"} prefix - The env prefix.
 * @returns {{baseUrl: string, apiKey: string|undefined, model: string}}
 */
function roleEndpoint(prefix) {
  const baseUrl =
    process.env[`${prefix}_BASE_URL`] || process.env.AI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env[`${prefix}_MODEL`] || process.env.AI_MODEL || "local";
  // The role's own context window and output cap, when configured. A stage that
  // runs on a server with a SMALLER context than the global AI_* model cannot
  // use the global cap (it is derived from a different machine's window), and a
  // stage that only ever writes a short answer should not ask for the global one.
  const contextWindowRaw = parseInt(process.env[`${prefix}_CONTEXT_WINDOW`], 10);
  const maxTokensRaw = parseInt(process.env[`${prefix}_MAX_TOKENS`], 10);
  return {
    baseUrl,
    // Which env var the value came from — logged at stage start so a run's
    // log shows whether a role used its own endpoint or fell back to AI_*.
    baseUrlSource: process.env[`${prefix}_BASE_URL`]
      ? `${prefix}_BASE_URL`
      : process.env.AI_BASE_URL
        ? "AI_BASE_URL (fallback)"
        : "(built-in default)",
    apiKey: process.env[`${prefix}_API_KEY`] || process.env.AI_API_KEY,
    model,
    modelSource: process.env[`${prefix}_MODEL`]
      ? `${prefix}_MODEL`
      : process.env.AI_MODEL
        ? "AI_MODEL (fallback)"
        : "(built-in default)",
    /** The role's own context window (null = use the global AI_CONTEXT_WINDOW). */
    contextWindow: Number.isFinite(contextWindowRaw) && contextWindowRaw > 0 ? contextWindowRaw : null,
    contextWindowSource:
      Number.isFinite(contextWindowRaw) && contextWindowRaw > 0 ? `${prefix}_CONTEXT_WINDOW` : "AI_CONTEXT_WINDOW (fallback)",
    /** The role's own output cap (null = derive from the context window). */
    maxTokens: Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? maxTokensRaw : null,
    maxTokensSource:
      Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
      ? `${prefix}_MAX_TOKENS`
      : Number.isFinite(contextWindowRaw) && contextWindowRaw > 0
        ? `derived from ${prefix}_CONTEXT_WINDOW`
        : "AI_MAX_TOKENS / AI_CONTEXT_WINDOW (fallback)",
  };
}


/**
 * One-line description of a resolved role endpoint, for the stage-start log:
 * which env vars each part came from, and what output cap the role will ask
 * for. A stage that silently uses the global model's output cap (because it
 * runs on a different, smaller server) is otherwise invisible in the log.
 *
 * @param {{model: string, baseUrl: string, modelSource: string, baseUrlSource: string, maxTokens: number|null, maxTokensSource: string, contextWindow: number|null, contextWindowSource: string}} endpoint
 * @returns {string}
 */
function describeEndpoint(endpoint) {
  return (
    `${endpoint.model} @ ${endpoint.baseUrl} ` +
    `(model from ${endpoint.modelSource}, base from ${endpoint.baseUrlSource}, ` +
    `output cap ${endpoint.maxTokens ?? "derived"} from ${endpoint.maxTokensSource}, ` +
    `context ${endpoint.contextWindow ?? "AI_CONTEXT_WINDOW (fallback)"} from ${endpoint.contextWindowSource})`
  );
}

// ─── Shared artifact names & the verification sidecar ───────────────────────
//
// These live here rather than in a task module because all four translation
// tasks need them. (Observed: verify-translate.js imports from translate.js;
// the fixes that need the reverse import would have made Node resolve a
// half-initialised module — a cycle whose exports depend on which file was
// required first. Shared names and sidecar I/O belong in the pure layer.)


module.exports = {
  runWithConcurrency,
  stageConcurrency,
  stageThinking,
  writerTemperature,
  roleEndpoint,
  describeEndpoint,
  judgeTemperature,
};

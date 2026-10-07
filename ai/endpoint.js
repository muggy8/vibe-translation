/**
 * Knowing what is actually serving, and knowing when a failure is a SIZE failure.
 *
 * assertModelServing is a GET /v1/models control-plane check that fails loudly
 * before a stage's first call. tagSizeOverflowError recognises the server's own
 * "prompt + max tokens exceeds the context" phrasings and tags the error as the one
 * class the whole-installment -> chapter-by-chapter fallback acts on, so no task has
 * to string-match a server's error text (gotcha 55). measurePromptTokens is the
 * calibration probe: one user message, max_tokens 1, no system prompt — the server's
 * own usage count is the answer, because this server has no /tokenize endpoint.
 *
 * Part of the harness.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions
const { Agent: UndiciAgent, fetch: undiciFetch } = require("undici");
const { readBoolEnv, tooBigForOnePassError, isTooBigForOnePassError } = require("../configs/shared");

const { logLine } = require("./log");
const { noTimeoutAgent } = require("./provider");

/**
 * Recognize the third "did not fit in one pass" signature: the server refusing
 * the request because the prompt plus the output cap exceed its context.
 *
 * The server reports this in its own words, and they differ per server build.
 * The patterns below are the ones this pipeline has actually seen plus the usual
 * OpenAI-compatible phrasings; matching is deliberately narrow, because a false
 * match sends a whole volume down the expensive chapter-by-chapter path to fix a
 * problem that was not a size problem.
 *
 * Tagging happens here rather than at each task: the tasks should not have to
 * string-match a server's error text.
 *
 * @param {Error} err - The error a model call threw.
 * @param {string} label - The call label, for the log.
 * @returns {Error} The same error, tagged when its message is a size signature.
 */
function tagSizeOverflowError(err, label = "") {
  if (!err || typeof err.message !== "string") return err;
  const message = err.message;
  const sizeSignature =
    /exceeds the (available )?context/i.test(message) ||
    /maximum context length/i.test(message) ||
    /context (window|size)[^.]*\b(exceeded|too large)/i.test(message) ||
    /n_ctx/i.test(message) && /exceed/i.test(message) ||
    /prompt \(\d+ tokens\) \+ max tokens/i.test(message) ||
    /input length and `max_tokens` exceed context/i.test(message);
  if (!sizeSignature) return err;
  if (err.tooBigForOnePass === true) return err;
  logLine(
    `  [call-ai] ${label}: the endpoint rejected the request as too large for its ` +
    `context — tagged as "too big for one pass" (a whole-installment pass may be ` +
    `retried chapter by chapter).`
  );
  return tooBigForOnePassError(message, err.cause);
}


// ─── Endpoint sanity check ──────────────────────────────────────────────────
/**
 * Control-plane check that a (role) endpoint is up and serving the expected
 * model — the translation stage's tasks call this at startup instead of
 * failing mid-chapter on a dead/wrong endpoint.
 *
 * The task code deliberately does NOT start or stop containers: that is the
 * per-machine hooks' job (hooks/, gitignored). This check only verifies
 * reachability and — when the endpoint lists its models — that the expected
 * model id is among them, and fails fast with an actionable message when not.
 *
 * Note: local containers may all advertise the same alias (e.g. every local
 * container here reports model id "local"), in which case this check
 * validates that SOMETHING is serving that alias at the expected base URL;
 * which model is actually loaded is guaranteed by the hooks, not by this.
 *
 * @param {{baseUrl?: string, apiKey?: string, model?: string, label?: string, timeoutMs?: number}} cfg
 * @returns {Promise<void>}
 * @throws {Error} When the endpoint is unreachable, errors, or lists no
 *   model matching the expected id.
 */
async function assertModelServing({
  baseUrl,
  apiKey,
  model,
  label = "AI endpoint",
  timeoutMs = 30000,
} = {}) {
  const base = (baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const expected = model || process.env.AI_MODEL || "";
  const url = `${base}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let response;
  try {
    response = await undiciFetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
      dispatcher: noTimeoutAgent,
    });
  } catch (err) {
    throw new Error(
      `${label}: cannot reach the model endpoint at ${base} (${err.message}). ` +
        `Is the model server/container for this stage running? On local setups the ` +
        `per-machine pre-<task> hook (hooks/, see hooks/README.md) is responsible for ` +
        `starting it before the task runs.`
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(
      `${label}: model endpoint ${url} responded with HTTP ${response.status}.`
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label}: model endpoint ${url} returned a non-JSON body.`);
  }
  const ids = (payload?.data || []).map((m) => m?.id).filter(Boolean);
  // Audit the raw /v1/models answer in the run log: on local multi-model
  // setups every container advertises the same alias ("local"), so this is
  // the only trace of WHICH models the endpoint actually lists when a stage
  // runs (and of a hook that forgot to switch the container).
  logLine(
    `[endpoint] ${label}: ${base} /v1/models lists [${ids.join(", ") || "(none)"}] ` +
      `(expected model: "${expected || "(any)"}")`
  );
  if (!expected) return; // no expected model configured — reachability only
  if (!ids.includes(expected)) {
    throw new Error(
      `${label}: endpoint ${base} lists model(s) [${ids.join(", ") || "(none)"}] ` +
        `but this stage expects "${expected}". If several local containers share the ` +
        `same alias, the pre-<task> hook must start the container that serves ` +
        `"${expected}" (check hooks/ and hooks/README.md).`
    );
  }
  console.log(`[endpoint] ${label}: ${base} is up and lists model "${expected}".`);
}


/**
 * Ask the endpoint how many tokens IT counts for a piece of text — the exact
 * number, from the server's own tokenizer.
 *
 * There is no free way to get this: an OpenAI-compatible server reports the
 * prompt token count only as part of a completion, so the measurement is a real
 * request. It is made as cheap as possible — one user message, `max_tokens: 1`,
 * no system prompt, no thinking — so the server pays its prefill and generates
 * a single token. On this machine that is ~2–3 s for an 8,000-character sample
 * and ~35–46 s for a whole volume, which is why the pipeline calibrates the
 * MODEL (one probe per role) and derives every volume's and chapter's count
 * from character counts instead of probing each one.
 *
 * A `/tokenize`-style endpoint would be free, and llama.cpp servers have one;
 * this machine's server does not (probed: /tokenize, /v1/tokenize,
 * /api/tokenize, /num_tokens all return 404). The probe below is the fallback
 * that works on any OpenAI-compatible server.
 *
 * @param {{baseUrl?: string, apiKey?: string, model?: string, text: string, label?: string, timeoutMs?: number}} cfg
 * @returns {Promise<number>} The server's own prompt token count.
 * @throws {Error} When the endpoint is unreachable, errors, or reports no usage.
 */
async function measurePromptTokens({
  baseUrl,
  apiKey,
  model,
  text,
  label = "token calibration",
  timeoutMs = 300000,
} = {}) {
  const body = String(text || "");
  if (!body) throw new Error(`${label}: cannot measure an empty sample.`);
  const base = (baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let response;
  try {
    // undici's OWN fetch (same build as noTimeoutAgent) — see gotcha 19.
    response = await undiciFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model || process.env.AI_MODEL || "local",
        messages: [{ role: "user", content: body }],
        max_tokens: 1,
        stream: false,
      }),
      signal: ctrl.signal,
      dispatcher: noTimeoutAgent,
    });
  } catch (err) {
    throw new Error(`${label}: the token measurement request to ${base} failed (${err.message}).`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${label}: ${base}/chat/completions responded with HTTP ${response.status}. ` +
        `${detail.slice(0, 200)}`
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label}: ${base}/chat/completions returned a non-JSON body.`);
  }
  const promptTokens = payload?.usage?.prompt_tokens;
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
    throw new Error(
      `${label}: the endpoint reported no prompt token count ` +
        `(usage: ${JSON.stringify(payload?.usage ?? null)}).`
    );
  }
  logLine(
    `[calibrate] ${label}: ${promptTokens} prompt tokens for a ${body.length}-character sample ` +
      `(${(promptTokens / body.length).toFixed(3)} tok/char) at ${base}`
  );
  return promptTokens;
}

// ─── Exports ────────────────────────────────────────────────────────────────


module.exports = {
  tagSizeOverflowError,
  assertModelServing,
  measurePromptTokens,
};

/**
 * utils/agents.js — the small, shared agent-turn guard.
 *
 * A local OpenAI-compatible endpoint intermittently emits tool-call syntax as
 * PLAIN TEXT (a few dozen chars of "tool_call" / "<function=…>" in the content
 * field) instead of using the API-level tool_calls protocol. The 30K
 * runaway-generation guard in harness.js only fires on LARGE text output, so a
 * small malformed call slips through: the turn makes zero real tool calls, the
 * agent "replies" with tool-call text, and the stale-file write check passes on
 * a file that was never actually written. These two functions catch exactly
 * that, and are shared by every task module that runs a file-writing agent
 * (previously each module carried its own copy of both).
 */

"use strict";

/**
 * True when an agent turn made no real tool calls but its text contains
 * tool-call syntax — the signature of a model emitting the tool call as text
 * instead of through the tool-calling API.
 *
 * @param {Object|null} result - The result object returned by an agent sendTurn.
 * @returns {boolean}
 */
function emittedToolCallAsText(result) {
  if (!result) return false;
  // A turn with at least one real tool call is fine, whatever its text says.
  if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) return false;
  const text = typeof result.text === "string" ? result.text : "";
  return text.includes("tool_call") || text.includes("<function=");
}

/**
 * Fail loudly when an agent turn made no real tool calls because the model
 * emitted tool-call syntax as plain text (see emittedToolCallAsText). Throws a
 * diagnostic error instead of letting the stale-file write check mask the
 * no-op turn.
 *
 * @param {Object|null} result - The result object returned by an agent sendTurn.
 * @param {string} who - Who the agent was (for the error message).
 * @param {string} [volumeLabel] - Optional volume label; when given, prefixes
 *   the error with "Volume <label>: " (the per-volume tasks pass it; the
 *   series-root audit and intake do not).
 * @returns {void}
 */
function assertRealToolCalls(result, who, volumeLabel) {
  if (!emittedToolCallAsText(result)) return;
  const prefix = volumeLabel ? `Volume ${volumeLabel}: ` : "";
  throw new Error(
    prefix +
      `${who} emitted tool-call syntax as plain text ` +
      `("tool_call" / <function=…>) instead of using the tool-calling API, so no ` +
      `file tools ran — nothing was read or written. See the agent transcript in ` +
      `.logs/ for the exact turn. This is an intermittent model/endpoint issue ` +
      `with OpenAI tool_calls (the smoke test 'npm run smoke fs' can pass even ` +
      `when it happens). Re-run the task; if it persists, check the endpoint.`
  );
}

/**
 * How an agent turn actually RAN, as a record — the honest replacement for "the step cap it ran
 * under" on a turn that has no step cap.
 *
 * The delivery-layer roles (the diagnostics team, the dev team) are uncapped: their turn is bounded
 * by the repetition detector and a loose turn clock, and the harness runs it in CHUNKS, setting old
 * read answers aside on disk when the working window fills (`utils/context.js`,
 * `CONTEXT-MANAGEMENT-DESIGN.md` §4.1/§4.9). So a ticket or patch record that names a cap those
 * roles never had states a limit that does not exist — a reader of `tickets.md` would go looking for
 * a ceiling to raise, and there is none. What a reader actually wants is the shape the turn took:
 * how many pieces of work it needed, how much of its reading it had to set aside, and how it ended.
 *
 * `endedAs` is the harness's own word for the ending, kept verbatim so a record cannot soften one:
 * `"complete"` (it answered), `"stopped"` (a guard stopped it — repeating itself, the turn clock, or
 * the working window refusing), `"error"` (the endpoint failed), `"max_steps"` (only a turn that DOES
 * run under a cap can end this way), `null` (the turn recorded nothing).
 *
 * @param {Object|null} result - The merged result object returned by an agent sendTurn.
 * @returns {{chunks: number, toolCalls: number, offloads: number, offloadedTokens: number, compactions: number, endedAs: string|null}}
 */
function turnShapeOf(result) {
  const r = result || {};
  const offloads = Array.isArray(r.offloads) ? r.offloads : [];
  let offloadedTokens = 0;
  for (const off of offloads) {
    const before = Number(off && off.tokensBefore) || 0;
    const after = Number(off && off.tokensAfter) || 0;
    if (before > after) offloadedTokens += before - after;
  }
  return {
    chunks: Number(r.chunks) || 0,
    toolCalls: Array.isArray(r.toolCalls) ? r.toolCalls.length : 0,
    offloads: offloads.length,
    offloadedTokens,
    compactions: Number(r.compactions) || 0,
    endedAs: typeof r.result === "string" ? r.result : null,
  };
}

module.exports = { emittedToolCallAsText, assertRealToolCalls, turnShapeOf };

/**
 * The two tools the harness adds automatically for a managed handle (manage_context / recall_memory), and the detectors that replaced the step cap: a call counts as a repeat only when the tool name, the arguments AND the answer are identical — so an errored call is never a repeat of an answered one, but the same error repeated IS a spin — and the exhaustion detector that stops a trim that keeps trimming with no new work. The repetition detector watches the tool's RAW answer, before the pressure line is added, or every call would look like a repeat of itself.
 *
 * Part of the context.js layer (split out of the original single file).
 */

const { tool } = require("ai");
const { z } = require("zod");

const { RECALL_MIN_BYTES, agentCompactExhaustion, agentRepeatLimit, recallMaxBytes } = require("./limits");
const { recall } = require("./recall");
const { callKey } = require("./offload");

/**
 * Build the two context tools for one agent handle.
 *
 * They are built here rather than in each role module so the harness owns them:
 * a role cannot hand itself a wider recall window or a different store, and the
 * store is keyed to the turn that produced it.
 *
 * @param {Object} input
 * @param {Object} input.state - The live turn state (`{ turn, dir, pressure, requested }`).
 * @param {Function} input.requestOffload - Marks the turn for offloading at the next chunk boundary.
 * @returns {{manage_context: Object, recall_memory: Object}}
 */
function createContextTools({ state, requestOffload }) {
  // Checked here rather than discovered at the moment the agent asks for help:
  // `manage_context` is the tool a turn reaches for precisely when it is running
  // out of room, and a tool that answers that call with "X is not a function"
  // teaches the agent that asking for help does not work. A misspelled option at
  // the call site is a wiring bug, and it should fail the handle, not the turn.
  if (!state || typeof state !== "object") {
    throw new Error("createContextTools needs the live turn state.");
  }
  if (typeof requestOffload !== "function") {
    throw new Error(
      "createContextTools needs a requestOffload function (the harness records why the agent asked)."
    );
  }
  const manage_context = tool({
    description:
      "Move the bulky results of your earlier lookups to disk, keeping a map of what " +
      "you looked at. Nothing is discarded: every moved result stays retrievable with " +
      "recall_memory. Use it when the working-window line says the window is getting " +
      "full — BEFORE another read, not after. Your own writes and edits are never moved.",
    inputSchema: z.object({
      note: z
        .string()
        .optional()
        .describe("Optional: what you are done reading, so the record says why."),
    }),
    execute: async ({ note }) => {
      // The turn's own record of "the agent asked for a trim" is stamped here, the
      // same way `recall_memory` stamps its own recall count: the harness logs both,
      // and ACM's measurement is that a model calls tools like these almost never
      // unless it is told to. A counter the tool does not write is a counter that
      // silently reports zero for a turn that used them.
      state.requested = true;
      requestOffload(String(note || "").trim());
      return {
        scheduled: true,
        appliesAt: "next chunk boundary",
        note: String(note || ""),
        workingWindowTokens: state.pressure ? state.pressure.tokens : null,
      };
    },
  });

  const recall_memory = tool({
    description:
      "Search what THIS turn already moved to disk with manage_context, and get the " +
      "matching text back verbatim. Plain text search (no regular expressions). It " +
      "cannot reach anything this turn did not already read.",
    inputSchema: z.object({
      query: z.string().describe("The text you are looking for, as a plain phrase."),
      id: z
        .string()
        .optional()
        .describe("Optional: restrict to one offload record, from its [context offload …] marker."),
      limit: z
        .number()
        .optional()
        .describe(`Optional: largest answer in bytes (default ${recallMaxBytes()}).`),
    }),
    execute: async ({ query, id, limit }) => {
      // A `limit` the agent writes is clamped to the same floor the env knob has:
      // a 10-byte answer is indistinguishable from "nothing matched", and an agent
      // that cannot tell the two reports a wrong answer instead of a wrong setting.
      const asked = Number.isFinite(limit) && limit > 0 ? limit : null;
      const out = recall({
        dir: state.dir,
        query,
        id: id || null,
        limitBytes: asked === null ? recallMaxBytes() : Math.max(asked, RECALL_MIN_BYTES),
      });
      state.recalls += 1;
      return out;
    },
  });

  return { manage_context, recall_memory };
}

// ─── Loop detection (design §4.8) ───────────────────────────────────────────


/**
 * The repetition detector that stands in place of a step cap.
 *
 * A call counts as a repeat only when BOTH:
 *   1. the tool name and the normalised arguments are identical to an earlier
 *      call in the same turn, AND
 *   2. its result is byte-identical to that earlier call's result.
 *
 * Condition 2 is what keeps this honest. Re-reading a file after editing it, or
 * re-running a search after a different file changed, is legitimate work and is
 * not counted. Re-running the identical search against an unchanged answer three
 * times is a loop, and it is the shape the other guards cannot see: the idle
 * deadline needs silence (this agent produced something every few seconds) and
 * the runaway-text guard needs lots of prose with few tool calls (this agent made
 * dozens of small lookups).
 *
 * @param {{limit?: number}} [opts]
 * @returns {{observe: (call: {name: string, input: Object, output: *, error: string|null}) => null | {repeated: true, call: Object, count: number, key: string}, counts: () => Object}}
 */
function repeatDetector({ limit = agentRepeatLimit() } = {}) {
  /** @type {Map<string, {count: number, lastResult: string, call: Object}>} */
  const seen = new Map();

  const observe = (call) => {
    if (!call || !call.name) return null;
    const key = callKey(call.name, call.input);
    // A call that errored is not the same lookup as one that answered: the agent
    // is allowed to retry a failure, and a refusal it is trying to work around is
    // information rather than a spin.
    const resultText = call.error
      ? `error:${String(call.error)}`
      : JSON.stringify(call.output ?? null);
    const prior = seen.get(key);
    if (prior && prior.lastResult === resultText) {
      prior.count += 1;
      prior.call = call;
      if (prior.count >= limit) {
        return { repeated: true, call, count: prior.count, key };
      }
      return null;
    }
    seen.set(key, { count: 1, lastResult: resultText, call });
    return null;
  };

  return { observe, counts: () => ({ distinct: seen.size }) };
}


/**
 * The second stop signal: trimming repeatedly while producing no new distinct
 * work. That means the material this turn is NOT allowed to lose — the system
 * prompt, the ticket, its own edits, the refusals, the recent tail — is what no
 * longer fits. That is a different problem from "needs trimming", and compressing
 * harder is the wrong answer to it.
 *
 * @param {{limit?: number}} [opts]
 * @returns {{observe: (o: {trimmed: boolean, newDistinctCalls: number}) => boolean, consecutive: () => number}}
 */
function exhaustionDetector({ limit = agentCompactExhaustion() } = {}) {
  let consecutive = 0;
  const observe = ({ trimmed, newDistinctCalls }) => {
    if (!trimmed) {
      consecutive = 0;
      return false;
    }
    if (newDistinctCalls > 0) {
      consecutive = 0;
      return false;
    }
    consecutive += 1;
    return consecutive >= limit;
  };
  return { observe, consecutive: () => consecutive };
}


module.exports = {
  createContextTools,
  repeatDetector,
  exhaustionDetector,
};

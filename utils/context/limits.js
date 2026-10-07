/**
 * Every knob of the managed turn, read per call so a test may pin one: which roles are managed, the chunk size (a CHUNK, not a turn limit — there is no limit on chunks), the soft and hard window levels, how much of the END of the conversation is never moved, the recall budget in BYTES with a floor an agent cannot lower (a 10-byte answer is indistinguishable from "nothing matched"), the repeat limit, the exhaustion limit, and the loose turn clock where 0 means a deliberate removal of the wall.
 *
 * Part of the context.js layer (split out of the original single file).
 */

/**
 * The delivery-layer roles that manage their own context.
 *
 * Deliberately not an environment variable (design R2): a constraint a role can
 * switch off is not a constraint (AGENTS.md gotcha 70). Whether a role may
 * compact is decided here, in code, and `test/test-context.js` pins that no other
 * module opts in.
 */
const CONTEXT_MANAGED_ROLES = ["diagnostics", "devteam"];


/**
 * @param {string} name - An agent handle name.
 * @returns {boolean} Whether this name is a delivery-layer role.
 */
function contextManagementEnabled(name) {
  return CONTEXT_MANAGED_ROLES.includes(name);
}

// ─── Configuration ──────────────────────────────────────────────────────────


/**
 * Steps one chunk of a context-managed turn is allowed to run.
 *
 * This is NOT a turn limit. The turn has no step count (the account owner's
 * decision, 2026-10-06); it is a chunk of one, and the harness keeps starting
 * chunks until the agent answers or a stop condition fires. Its only job is to
 * create the boundary where the working window gets measured and, if needed,
 * trimmed.
 *
 * @returns {number} AGENT_CONTEXT_CHUNK_STEPS, default 12, minimum 1.
 */
function contextChunkSteps() {
  const n = parseInt(process.env.AGENT_CONTEXT_CHUNK_STEPS, 10);
  return Number.isFinite(n) && n >= 1 ? n : 12;
}


/**
 * The fraction of the window at which the pressure line starts urging the agent
 * to offload, and at which the harness offloads on its own.
 * @returns {number} CONTEXT_SOFT_LIMIT, default 0.70, clamped to (0, 1).
 */
function contextSoftLimit() {
  const n = parseFloat(process.env.CONTEXT_SOFT_LIMIT);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return 0.7;
  return n;
}


/**
 * @returns {number} CONTEXT_HARD_LIMIT, default 0.90, clamped to (soft, 1).
 */
function contextHardLimit() {
  const n = parseFloat(process.env.CONTEXT_HARD_LIMIT);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return 0.9;
  return Math.max(n, contextSoftLimit());
}


/**
 * How much of the most recent work is never offloaded. The agent needs its
 * immediate surroundings intact: the finding it is in the middle of acting on is
 * the one thing it must not have to re-fetch.
 * @returns {number} CONTEXT_KEEP_RECENT_TOKENS, default 40000, minimum 1000.
 */
function contextKeepRecentTokens() {
  const n = parseInt(process.env.CONTEXT_KEEP_RECENT_TOKENS, 10);
  return Number.isFinite(n) && n >= 1000 ? n : 40000;
}


/**
 * The smallest a recall answer may be allowed to be, whether it comes from the
 * env knob or from the agent's own `limit` argument. A 1-byte answer reads as
 * "the text is not there", which is gotcha 60's silent-nothing failure reappearing
 * as a size setting instead of a wildcard.
 */
const RECALL_MIN_BYTES = 512;


/**
 * The largest single `recall_memory` answer. A recall that returns everything is
 * an offload that never happened.
 * @returns {number} RECALL_MAX_BYTES, default 16384, minimum 512.
 */
function recallMaxBytes() {
  const n = parseInt(process.env.RECALL_MAX_BYTES, 10);
  return Number.isFinite(n) && n >= RECALL_MIN_BYTES ? n : 16384;
}


/**
 * How many times the same lookup may run with the same answer before the turn is
 * called a loop.
 *
 * This is a repetition detector, not a spending limit (design §4.8). It is
 * consistent with the standing decision that these roles get no token budget
 * (AGENTS.md §9): "a spending limit would hide the spin behind a cost error, and
 * the spin is the thing this layer exists to catch."
 *
 * @returns {number} AGENT_REPEAT_LIMIT, default 3, minimum 2.
 */
function agentRepeatLimit() {
  const n = parseInt(process.env.AGENT_REPEAT_LIMIT, 10);
  return Number.isFinite(n) && n >= 2 ? n : 3;
}


/**
 * How many consecutive trims with no new distinct work mean the kept material
 * itself no longer fits — a different problem from "needs trimming", and one that
 * must be reported rather than compressed harder.
 * @returns {number} AGENT_COMPACT_EXHAUSTION, default 3, minimum 2.
 */
function agentCompactExhaustion() {
  const n = parseInt(process.env.AGENT_COMPACT_EXHAUSTION, 10);
  return Number.isFinite(n) && n >= 2 ? n : 3;
}


/**
 * Total wall clock one delivery-layer turn may take.
 *
 * Deliberately distinct from `AI_CALL_DEADLINE_MS`, which is an IDLE bound and
 * must stay idle (AGENTS.md gotcha 26). This is the loose ceiling the account
 * owner asked for so an unattended overnight turn cannot loop forever; it is not
 * a per-step cap and it says nothing about a pipeline stage, which is why
 * `INDEX_STEP_TIMEOUT_MS` stays 0 and untouched.
 *
 * @returns {number} AGENT_TURN_MAX_MS, default 7200000 (2 h). 0 = no ceiling.
 */
function agentTurnMaxMs() {
  const n = parseInt(process.env.AGENT_TURN_MAX_MS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 7200000;
}

// ─── The ruler (defect B) ───────────────────────────────────────────────────


/**
 * The turn's wall clock. Distinct from the idle deadline, and deliberately so
 * (gotcha 26 keeps that one idle).
 *
 * @param {number} maxMs - 0 disables the ceiling.
 * @returns {{maxMs: number, startedAt: number, elapsedMs: () => number, exceeded: () => boolean}}
 */
function turnClock(maxMs = agentTurnMaxMs()) {
  const startedAt = Date.now();
  return {
    maxMs,
    startedAt,
    elapsedMs: () => Date.now() - startedAt,
    exceeded: () => maxMs > 0 && Date.now() - startedAt > maxMs,
  };
}

// ─── Reading the store back (for the turn log and the cross-check) ──────────


module.exports = {
  CONTEXT_MANAGED_ROLES,
  contextManagementEnabled,
  contextChunkSteps,
  contextSoftLimit,
  contextHardLimit,
  contextKeepRecentTokens,
  RECALL_MIN_BYTES,
  recallMaxBytes,
  agentRepeatLimit,
  agentCompactExhaustion,
  agentTurnMaxMs,
  turnClock,
};

/**
 * createAgentHandle — the tool-using agent, and the two turn shapes.
 *
 * A handle WITHOUT contextManagement runs exactly one chunk: every pipeline stage
 * keeps its own step cap, its own step-cap warning, its own tool set, and no memory
 * tools. A handle WITH it is the delivery layer's uncapped turn: maxSteps becomes
 * the size of a CHUNK, and between chunks the harness moves the turn's old read
 * answers to disk and continues the SAME conversation, leaving a map block behind so
 * the agent knows it saw something and recall_memory can bring the text back.
 *
 * What makes uncapped affordable is that the turn does not hold everything in its
 * own head; what makes it safe is the pressure line stamped on every tool answer —
 * the paper this design came from measured a model calling offload/recall tools
 * about ZERO times unless it is told to. And what replaces the cap is a repetition
 * detector (identical tool + identical arguments + identical answer), not a bigger
 * number of steps (gotcha 78).
 *
 * Part of the harness.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions
// The delivery layer's context management (design: CONTEXT-MANAGEMENT-DESIGN.md).
// Requires only fs/path + ./tokens, so it can sit at the top level without a cycle.
const ctxm = require("../utils/context");

const { currentRunDir, logLine, runDir, writeAgentTurnLog } = require("./log");
const { createChatModel, createTaps, createTapsRef, loadEsm, thinkingExtraBody } = require("./provider");
const { agentMaxSteps, envCallDeadlineMs, envContextWindow, envMaxTokens, envRetry, envTemperature, envThinking } = require("./env");
const { consumeEvents, logResultLine, mergeUsage } = require("./turn");
const { tagSizeOverflowError } = require("./endpoint");

/**
 * Wrap every tool's `execute` for a context-managed agent: observe the RAW
 * result of each call, then hand the agent its answer with the working-window
 * pressure stamped onto it.
 *
 * Two ordering rules are load-bearing:
 *
 * - **Observe the RAW output, annotate on the way back.** The pressure line
 *   contains a number that changes between two identical calls, so a detector
 *   that saw the annotated result would never notice a spin — the very thing it
 *   exists to catch (gotcha 69's shape, in the agent's own turn).
 * - **Observe an errored call as an error and rethrow.** An error is never a
 *   repeat of an answered call, and the refusal has to reach the model as a tool
 *   error the way it already does (gotcha 74: a denied call surfaces as an error
 *   and the loop continues, which is what lets a turn finish instead of dying).
 *
 * A repeated call is a spin: the same tool, the same arguments, and the same
 * answer. That is the shape of the failed diagnosis turn that re-opened the same
 * file twelve times, and it is stopped by aborting the chunk it happened in —
 * not by a step cap, which is the thing this redesign removes.
 *
 * The wrapper is built ONCE per handle and reads the live turn through
 * `turnOf()`, because "the same call twice" is only a spin WITHIN one turn:
 * re-reading a file in a later turn of the same session is legitimate. Outside a
 * turn (or on an unmanaged handle) `turnOf()` is null and the tool is passed
 * through untouched.
 *
 * @param {Object} toolSet - The tools the agent is handed.
 * @param {Function} turnOf - Returns the live managed turn, or null.
 * @returns {Object} The tool set with every `execute` wrapped.
 */
function wrapToolsWithContext(toolSet, turnOf) {
  const wrapped = {};
  for (const [toolName, def] of Object.entries(toolSet)) {
    const original = def && typeof def.execute === "function" ? def.execute : null;
    if (!original) {
      wrapped[toolName] = def;
      continue;
    }
    wrapped[toolName] = {
      ...def,
      async execute(input, opts) {
        const turn = turnOf();
        if (!turn || !turn.detector) return original(input, opts);
        let output;
        try {
          output = await original(input, opts);
        } catch (err) {
          turn.detector.observe({
            name: toolName,
            input,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        const spin = turn.detector.observe({ name: toolName, input, output });
        if (spin && !turn.repeatHit) {
          turn.repeatHit = spin;
          logLine(
            `  [call-ai] WARNING: ${turn.label} repeated the same tool call ` +
              `(${toolName} ${JSON.stringify(input ?? {})}), ${spin.count} identical ` +
              `result(s) in this turn — the turn is being stopped instead of ` +
              `paying for the same call again.`
          );
          if (typeof turn.abortFn === "function") turn.abortFn();
        }
        // The pressure the agent sees is the pressure AFTER this call's answer
        // landed, read from the server's own count for the current step.
        turn.pressure = turn.pressureOf();
        return ctxm.annotateToolResult(output, turn.pressure);
      },
    };
  }
  return wrapped;
}


/**
 * The error a managed turn throws when the repetition detector says it is spinning.
 *
 * A stuck agent is the failure the delivery layer used to discover by reading a
 * 700-second transcript the next morning: the same `readFile` over the same folder,
 * dozens of times, each one re-billing the whole conversation so far. The detector
 * stops it; this message is what the ticket and the log then say, and it has to name
 * the call it repeated, because "the agent was stuck" is not information the
 * diagnostics team can act on.
 *
 * @param {string} label - The turn's log label.
 * @param {Object} hit - The detector's hit ({ repeated, call, count, key }).
 * @param {number} chunk - The chunk the repeat was detected in.
 * @returns {Error} A descriptive error naming the repeated call and its limit.
 */
function repeatStopError(label, hit, chunk) {
  const call = (hit && hit.call) || {};
  const limit = ctxm.agentRepeatLimit();
  let args = "";
  try {
    args = JSON.stringify(call.input ?? {});
  } catch {
    args = "<unserializable>";
  }
  return new Error(
    `${label}: stopped because it repeated the same tool call ${hit?.count ?? limit} times ` +
      `in one turn (${call.name || "unknown tool"} ${args}) at chunk ${chunk}. ` +
      `The turn is not charged for the identical call again (AGENT_REPEAT_LIMIT=${limit}). ` +
      `What it was looking for is either already in its own transcript under .logs/, or it ` +
      `is not reachable with the tools this role has — say so in the answer rather than ` +
      `reaching for the same file again.`
  );
}


/**
 * The chunk-boundary offload for a context-managed turn.
 *
 * Called after a chunk ends with its step budget spent, which is the only moment the
 * harness may rewrite the agent's conversation. Two things justify it: the agent asked
 * (`manage_context`, which stamps `requested`), or the working window is genuinely
 * full. At "soft" pressure with no request the pressure line already IN the agent's
 * last tool result is the instruction, and offloading material the agent still needs
 * would be the harness guessing on its behalf.
 *
 * Offload failures are told apart by `failure`, not by the count: both failures move
 * nothing, but one means "there is nothing left that is allowed to move" (the honest
 * "this does not fit" — and there is no cap to raise and no lossy summary to fall
 * back on) and the other means "the disk refused" (loud, but the conversation is
 * intact and the turn may still finish).
 *
 * @param {Object} args
 * @param {string} args.label - The turn's log label.
 * @param {number} args.chunk - The chunk that just ended.
 * @param {string} args.agentName - The handle name (names the offload folder).
 * @param {Object} args.session - The open-harness Session (its `messages` are replaced).
 * @param {number} args.contextWindow - The window the pressure is measured against.
 * @param {Object} args.turn - The live turn state.
 * @param {Object} args.exhausted - The exhaustion detector for this turn.
 * @param {Array<Object>} args.offloads - Accumulator, appended on success.
 * @returns {string|null} A stop message when the turn must end, else null.
 */
function offloadAtChunkBoundary({
  label,
  chunk,
  agentName,
  session,
  contextWindow,
  turn,
  exhausted,
  offloads,
}) {
  const messages = session.messages ?? [];
  const pressure =
    turn.pressure ??
    ctxm.windowPressure({
      lastInputTokens: session.lastInputTokens ?? 0,
      messages,
      contextWindow,
    });
  turn.pressure = pressure;
  const asked = turn.requested === true;
  if (!asked && pressure.level !== "hard") return null;
  const askedNote = asked && turn.offloadReason ? turn.offloadReason : "";

  // The reason is a vocabulary, not prose: `offload()` documents it as
  // "soft-limit" | "hard-limit" | "agent-request", and the record is what a later
  // reader judges the turn on. The agent's own note is logged, not stored in the
  // field, so `reason` stays something a test and a report can compare against.
  const reason = asked ? "agent-request" : "hard-limit";
  const off = ctxm.offload({
    runDir: turn.runDir,
    agentName,
    turn: turn.number,
    chunk,
    messages,
    targetTokens: Math.floor(contextWindow * ctxm.contextSoftLimit()),
    reason,
  });
  turn.requested = false;
  turn.offloadReason = null;

  // "Offloading is not helping" needs both halves: a trim that happened, and no new
  // distinct work since the last one. The detector's call count is the cheap proxy
  // for "the agent is doing something it has not done before".
  const distinct = turn.detector ? turn.detector.counts().distinct : 0;
  const newDistinctCalls = Math.max(0, distinct - (turn.distinctSeen || 0));
  turn.distinctSeen = distinct;
  const spent = exhausted.observe({ trimmed: off.ok, newDistinctCalls });

  if (!off.ok) {
    if (off.failure === "write-failed") {
      logLine(
        `  [call-ai] WARNING: ${label} could not write its offload file at chunk ` +
          `${chunk}: ${off.error} The conversation is untouched, so the next chunk may ` +
          `be refused by the server for being too large.`
      );
      return null;
    }
    // Nothing was eligible to offload.
    if (pressure.level === "hard") {
      return (
        `${label}: the working window is full (${pressure.tokens}/${pressure.window} tokens, ` +
        `${Math.round(pressure.fraction * 100)}%) and nothing could be moved out of it — ` +
        `${off.error} This turn has no step cap to raise and no lossy summary to fall back ` +
        `on: what is left in the conversation is the material it is not allowed to lose. ` +
        `The ticket needs to say what it was trying to hold, not that it ran out of steps.`
      );
    }
    logLine(
      `  [call-ai] ${label} asked to offload at chunk ${chunk}, but nothing was eligible: ` +
        `the conversation is already only protected material (the ticket, its own edits, ` +
        `refusals, and the most recent work).`
    );
    return null;
  }

  session.messages = off.messages;
  offloads.push({
    id: off.id,
    file: off.file,
    dir: off.dir,
    offloadedCount: off.offloadedCount,
    tokensBefore: off.tokensBefore,
    tokensAfter: off.tokensAfter,
    reason: off.reason,
  });
  logLine(
    `  [call-ai] ${label} offloaded ${off.offloadedCount} read result(s) at chunk ${chunk}: ` +
      `${off.tokensBefore} -> ${off.tokensAfter} tokens (${off.reason}${
        askedNote ? `, the agent asked: "${askedNote}"` : ""
      }) -> ${off.file}`
  );
  if (spent) {
    const last = offloads[offloads.length - 1];
    return (
      `${label}: offloading is not helping — ${exhausted.consecutive()} chunk boundaries in a ` +
      `row moved read results to disk (${last.tokensBefore} -> ${last.tokensAfter} tokens on ` +
      `the last one) while the turn made no new tool calls. It is re-reading what it already ` +
      `offloaded instead of making progress (AGENT_COMPACT_EXHAUSTION=${ctxm.agentCompactExhaustion()}). ` +
      `Its offload files are under ${last.dir || "the turn's memory folder"}.`
    );
  }
  return null;
}


/**
 * Create a tool-using agent handle backed by an open-harness Session
 * (retry with backoff).
 *
 * The handle's sendTurn() consumes one turn's event stream with the standard
 * logging and returns the accumulated result; the session keeps its message
 * history between turns, so multi-turn flows (generate -> feedback ->
 * revise) stay in one context. Note: for writing agents an empty final
 * text is a *success* (the output went to disk), so — unlike runOneShot —
 * no empty-content retry is applied here.
 *
 * **Session compaction is off on every handle** (`autoCompact: false`). The
 * library's compaction is lossy summarisation, and it was firing silently in the
 * middle of pipeline-stage turns — that is how an agent "quietly stopped honoring
 * the honorific rules" (gotcha 56). With it off, a turn that genuinely does not
 * fit fails as a tagged `tooBigForOnePassError`, which is the one failure
 * `runVolumeWithModeFallback` knows how to repair (gotcha 55). A stage agent's
 * whole point is to keep everything in context; nothing below the task code may
 * throw part of it away on its own initiative.
 *
 * `contextManagement: true` (the delivery layer only) turns one `sendTurn()` into
 * a CHUNKED turn: `maxSteps` becomes the size of a chunk rather than of the turn,
 * so the harness gets a boundary at which to move the agent's oldest read results
 * off to disk and keep the turn going. See `utils/context.js` and
 * `CONTEXT-MANAGEMENT-DESIGN.md`.
 *
 * @param {CreateAgentHandleCfg} cfg
 * @param {string} cfg.name - Agent name (used in logs).
 * @param {string} cfg.systemPrompt - The system prompt.
 * @param {Object} [cfg.tools] - Tool set (omitted/empty = no tools).
 * @param {Function} [cfg.approve] - open-harness ApproveFn (the write gate).
 * @param {string} [cfg.cwd] - Base dir for fs tools (default: process.cwd()).
 * @param {number} [cfg.maxSteps] - Step cap (default: AGENT_MAX_STEPS env / 20). On a
 *   context-managed handle it is the size of one CHUNK, not of the turn.
 * @param {number} [cfg.temperature] - Sampling temperature for this handle (default:
 *   `AI_TEMPERATURE` via {@link envTemperature}). A handle that decides rather than writes — the
 *   delivery manager — passes the grader's temperature here, the same `JUDGE_TEMPERATURE` a one-shot
 *   grader gets (gotcha 59). Without this override an agent handle could only ever sample like a
 *   writer.
 * @param {number} [cfg.maxTokens] - Reply budget for this handle (default: {@link envMaxTokens}).
 *   A role with its own documented cap (the manager's `DELIVERY_MAX_TOKENS`) passes it here.
 * @param {number} [cfg.retry] - Error retries (default: AI_RETRY env).
 * @param {boolean} [cfg.thinking] - Thinking mode (default: AI_THINKING env, on —
 *   agents use full thinking for higher-quality output; tune AI_THINKING_LEVEL
 *   to control reasoning spend).
 * @param {string} [cfg.thinkingLevel] - reasoning_effort level (default: AI_THINKING_LEVEL env / "xhigh").
 * @param {number} [cfg.contextWindow] - The model server's context window
 *   (default: AI_CONTEXT_WINDOW env). On a context-managed handle it is what the
 *   working-window pressure is measured against.
 * @param {boolean} [cfg.contextManagement] - Opt in to the managed (chunked,
 *   offloading, uncapped) turn. Default false: a pipeline stage agent gets the
 *   plain turn, because keeping everything in context IS its job. The delivery
 *   layer (diagnostics, dev team) is the only caller that sets it — see
 *   `CONTEXT_MANAGED_ROLES` in `utils/context.js`.
 * @returns {Promise<Object>} { name, session, sendTurn, close }
 */
async function createAgentHandle({
  name,
  systemPrompt,
  tools,
  approve,
  cwd = process.cwd(),
  maxSteps,
  temperature,
  maxTokens,
  retry,
  thinking = envThinking(),
  thinkingLevel,
  contextWindow,
  contextManagement = false,
}) {
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    throw new Error("systemPrompt must be a non-empty string.");
  }
  const { core } = await loadEsm();
  const extraBody = thinkingExtraBody({ thinking, thinkingLevel });
  const tapsRef = createTapsRef();
  const { model } = await createChatModel({ extraBody, tapsRef });
  const ctxWindow = contextWindow ?? envContextWindow();
  // Opt-in by the CALL SITE, and only for the roles the design names. A stage
  // agent cannot opt itself in by accident: the role list is the gate.
  const managed = contextManagement === true && ctxm.contextManagementEnabled(name);
  const baseTools = tools && Object.keys(tools).length > 0 ? tools : undefined;
  // The live turn the tool wrappers read. One object, mutated per turn, because
  // the context tools (`manage_context` / `recall_memory`) and the wrapper need
  // the SAME turn state, and both are built once at handle creation.
  const turnState = {
    active: false,
    number: 0,
    label: name,
    // The run log directory (where the offload store lives) and this turn's own
    // offload folder, set by sendTurn. `dir` is what `recall_memory` searches.
    runDir: null,
    dir: null,
    // The detector's distinct-call count at the last chunk boundary: the delta is
    // how much NEW work the agent did since the last offload, which is what tells
    // "offloading is not helping" apart from "offloading bought real progress".
    distinctSeen: 0,
    pressure: null,
    requested: false,
    recalls: 0,
    offloadReason: null,
    detector: null,
    repeatHit: null,
    abortFn: null,
    pressureOf: () =>
      ctxm.windowPressure({
        // `session.lastInputTokens` is the server's own count for the last step
        // (stamped by the Session at step.done), so mid-chunk pressure does not
        // depend on the estimate. `session.messages` lags inside a chunk — the
        // Session only reassigns it at `done` — which is why the reported number
        // is what the pressure line is built from, and the message list is only
        // what the offload walks at a chunk boundary.
        lastInputTokens: session.lastInputTokens ?? 0,
        messages: session.messages ?? [],
        contextWindow: ctxWindow,
      }),
  };
  const agent = new core.Agent({
    name,
    model,
    systemPrompt,
    tools: baseTools
      ? managed
        ? {
            ...wrapToolsWithContext(baseTools, () =>
              turnState.active ? turnState : null
            ),
            ...ctxm.createContextTools({
              state: turnState,
              requestOffload: (note) => {
                // The tool stamps its own `requested` counter; the harness only
                // records WHY the offload is happening, for the log.
                turnState.offloadReason = note || "agent-request";
              },
            }),
          }
        : baseTools
      : undefined,
    maxSteps: managed ? ctxm.contextChunkSteps() : maxSteps ?? agentMaxSteps(),
    temperature: temperature ?? envTemperature(),
    maxTokens: maxTokens ?? envMaxTokens(),
    instructions: false,
    ...(approve ? { approve } : {}),
  });
  const session = new core.Session({
    agent,
    contextWindow: ctxWindow,
    // **Compaction is off on every handle, managed or not.** The library's
    // compaction is lossy summarisation, and it was firing silently in the middle
    // of pipeline-stage turns (its default is "on whenever a window is configured"
    // — which is every handle in this project). With it off, the server decides:
    // a request that genuinely does not fit comes back as a size error, which
    // `tagSizeOverflowError` turns into the tagged `tooBigForOnePassError` the
    // whole-installment → chapter-by-chapter fallback is built to repair. A silent
    // lossy summary is not a repair, it is the artifact getting worse with no
    // error to notice it (AGENTS.md gotcha 56). A context-managed turn instead
    // gets the harness's own offload, which moves the text to DISK instead of
    // throwing it away — see `utils/context.js`.
    autoCompact: false,
    retry: { maxRetries: retry ?? envRetry(), isRetryable: () => true },
  });
  const systemPreview = systemPrompt.trim().split("\n")[0].slice(0, 80);
  let turnNumber = 0;
  return {
    name,
    session,
    /**
     * Run one turn (user input string or ModelMessage array) and return the
     * accumulated result. Throws when the run ends in an error.
     *
     * **For a context-managed handle, one `sendTurn()` is a LOOP of model runs,
     * not one.** `agent.maxSteps` is the size of a CHUNK, not of the turn: when a
     * chunk spends its step budget the harness gets a chance to move the chunk's
     * old read payloads to disk (`utils/context.js`) and continue the SAME
     * conversation, so a diagnostics or dev-team turn is not capped at any number
     * of steps. A non-managed handle runs exactly ONE chunk, which is why every
     * pipeline stage keeps its own step cap and its own step-cap warning
     * unchanged — a stage agent's whole point is to keep everything in context,
     * and nothing here is allowed to split or trim that on its own initiative.
     *
     * @param {string|Array<Object>} input - The turn's user input.
     * @param {{label?: string}} [opts] - Log label override.
     * @returns {Promise<Object>} The accumulated result (see consumeEvents), plus
     *   `chunks` (how many model runs this turn needed) and `offloads` (what was
     *   moved to disk between them).
     */
    async sendTurn(input, { label = name } = {}) {
      turnNumber += 1;
      logLine(`[call-ai] CALL system="${systemPreview}" agent=${label} (turn)`);

      // The live turn state the tool wrappers read. Set ONCE, before the chunk
      // loop, because the wrappers were built at handle creation and read this
      // same object; `active` is what tells them a turn is in progress.
      turnState.active = true;
      turnState.number = turnNumber;
      turnState.label = label;
      turnState.runDir = managed ? currentRunDir() : null;
      turnState.dir = managed
        ? ctxm.offloadDirFor(turnState.runDir, name, turnNumber)
        : null;
      turnState.pressure = null;
      turnState.requested = false;
      turnState.recalls = 0;
      turnState.offloadReason = null;
      turnState.distinctSeen = 0;
      turnState.detector = managed ? ctxm.repeatDetector() : null;
      turnState.repeatHit = null;
      turnState.abortFn = null;

      // The two walls a delivery-layer turn DOES have: a model call that stops
      // making progress, and a turn that keeps going for hours. There is
      // deliberately no step cap and no token budget here (AGENTS.md gotcha 69's
      // rule that a spending limit hides the spin instead of catching it).
      const idleMs = envCallDeadlineMs();
      const clock = ctxm.turnClock(ctxm.agentTurnMaxMs());
      const exhausted = ctxm.exhaustionDetector();
      const offloads = [];

      // The turn's accumulated answer: the same shape consumeEvents returns, so
      // every caller (crossCheckReads, assertRealToolCalls, the truncation
      // guard's result) reads the same fields whether the turn ran one chunk or
      // nine. `messages` is the LAST chunk's list, which is the whole
      // conversation, because the Session carries its history across sends.
      const merged = {
        text: "",
        reasoning: "",
        finishReason: null,
        usage: null,
        result: null,
        error: null,
        messages: [],
        startTime: Date.now(),
        firstTokenTime: null,
        toolCalls: [],
        compactions: 0,
        lastInputTokens: 0,
        chunks: 0,
        offloads,
      };

      let stopMessage = null;
      let chunk = 0;
      try {
        while (!stopMessage) {
          chunk += 1;
          merged.chunks = chunk;
          // Fresh taps per chunk: consumeEvents folds the HTTP-tapped reasoning
          // into a chunk's own result, so leaving chunk 1's taps in place would
          // copy its reasoning into chunk 2 and count it twice.
          tapsRef.current = createTaps();
          // AbortController for the runaway-generation guard AND the idle
          // deadline: consumeEvents calls signal.abort() when the model produces
          // excessive text without tool calls, and after AI_CALL_DEADLINE_MS of
          // silence — both cancel the underlying fetch via session.send.
          const abortCtrl = new AbortController();
          turnState.abortFn = () => abortCtrl.abort();
          let idleFired = false;
          // Streaming log context: one file per chunk, so a turn that ran five of
          // them leaves five readable streams.
          const logContext = {
            type: "agent",
            agentName: name,
            turnNumber,
            label,
            chunk,
          };
          const chunkLabel = chunk === 1 ? label : `${label} chunk ${chunk}`;

          let result;
          try {
            // Chunk 1 sends the caller's input; every later chunk CONTINUES the
            // same conversation with no new user message (`send([])` pushes
            // nothing), which is what makes the chunks one turn rather than
            // several turns.
            result = await consumeEvents(
              session.send(chunk === 1 ? input : [], { signal: abortCtrl.signal }),
              {
                label: chunkLabel,
                tapsRef,
                logContext,
                signal: abortCtrl.signal,
                idleDeadlineMs: idleMs,
                onIdleExpire: () => {
                  idleFired = true;
                  abortCtrl.abort();
                },
                // The runaway-text guard is a TURN-wide measurement: a model that
                // rambles across six chunks is one rambling turn, and without the
                // seed each chunk would be measured on its own.
                carryOver:
                  chunk === 1
                    ? null
                    : {
                        textChars: merged.text.length,
                        toolCallCount: merged.toolCalls.length,
                      },
              }
            );
          } catch (err) {
            // A repeat abort is the detector doing its job, so it reports the
            // spin, not whatever the abort looked like at the stream level.
            if (turnState.repeatHit) throw repeatStopError(label, turnState.repeatHit, chunk);
            if (idleFired) {
              throw new Error(
                `${label}: the agent turn made no progress for ${Math.round(idleMs / 60000)} min ` +
                  `and was aborted (AI_CALL_DEADLINE_MS=${idleMs}). The endpoint is likely ` +
                  `hung or the model container died — check .logs/ and re-run.`
              );
            }
            throw tagSizeOverflowError(err, label);
          }

          // Merge this chunk into the turn.
          merged.text += result.text ?? "";
          if (result.reasoning && !merged.reasoning) merged.reasoning = result.reasoning;
          merged.toolCalls.push(...(result.toolCalls ?? []));
          if (result.messages?.length) merged.messages = result.messages;
          merged.usage = mergeUsage(merged.usage, result.usage);
          merged.compactions += result.compactions ?? 0;
          if (result.lastInputTokens) merged.lastInputTokens = result.lastInputTokens;
          merged.finishReason = result.finishReason;
          merged.result = result.result;
          merged.error = result.error;
          if (merged.firstTokenTime === null) merged.firstTokenTime = result.firstTokenTime;

          logResultLine(result, chunkLabel);

          // An abort on the LAST tool call of the LAST step can end the stream
          // cleanly instead of throwing, so the repeat has to be checked here too
          // — otherwise a spinning turn reports a normal finish.
          if (turnState.repeatHit) throw repeatStopError(label, turnState.repeatHit, chunk);

          if (managed) {
            // The working window, per chunk: the number the pressure line has been
            // telling the agent all turn, now in summary.log where a human (and the
            // diagnostics team) can grep it.
            turnState.pressure = turnState.pressureOf();
            const p = turnState.pressure;
            if (p.window) {
              logLine(
                `  [call-ai] ${label} chunk ${chunk}: ${merged.toolCalls.length} tool call(s), ` +
                  `working window ${p.tokens}/${p.window} tokens (${Math.round(p.fraction * 100)}%) ` +
                  `${p.level}`
              );
            }
          }

          // Only a chunk that SPENT its step budget continues. A chunk that ended
          // with a final answer is the turn ending.
          if (result.result !== "max_steps") break;
          // A non-managed handle runs exactly one chunk: its step cap is its cap,
          // and the warning below is the one the pipeline stages already know.
          if (!managed) break;

          const stop = offloadAtChunkBoundary({
            label,
            chunk,
            agentName: name,
            session,
            contextWindow: ctxWindow,
            turn: turnState,
            exhausted,
            offloads,
          });
          if (stop) {
            stopMessage = stop;
            break;
          }

          if (clock.exceeded()) {
            stopMessage =
              `${label}: stopped after ${Math.round(clock.elapsedMs() / 60000)} min in one turn ` +
              `(AGENT_TURN_MAX_MS=${clock.maxMs}) after ${chunk} chunk(s) and ` +
              `${merged.toolCalls.length} tool call(s). The turn has no step cap on purpose; ` +
              `this is the loose wall that keeps a turn which is not making progress from ` +
              `running overnight. Its work so far is in its chat log under .logs/, and what ` +
              `it read is in ${turnState.dir}.`;
            logLine(`  [call-ai] WARNING: ${stopMessage}`);
            break;
          }
        }
      } finally {
        // The wrappers must stop seeing this turn the moment it is over, whether
        // it finished, stopped, or threw.
        turnState.active = false;
        turnState.detector = null;
        turnState.repeatHit = null;
        turnState.abortFn = null;
        turnState.runDir = null;
        turnState.dir = null;
      }

      if (merged.chunks > 1) logResultLine(merged, `${label} (turn total)`);

      if (merged.result === "max_steps") {
        logLine(
          `  [call-ai] WARNING: ${label} hit its step cap without a final ` +
            `answer; the turn may be incomplete. Count the tool calls in its ` +
            `chat log before raising maxSteps: many small reads means the agent ` +
            `could not read the file it was asked to produce (see ` +
            `AGENT_MAX_READ_BYTES / AGENT_MAX_LINE_LENGTH, and the cumulative-` +
            `artifact rules in AGENTS.md), which a bigger cap does not fix.`
        );
      }

      // Write full chat log for this turn — BEFORE the stop message is thrown, so
      // the transcript of a turn that stopped honestly is readable.
      writeAgentTurnLog(name, turnNumber, {
        systemPrompt,
        input,
        result: merged,
        toolCalls: merged.toolCalls ?? [],
        label,
        chunks: merged.chunks,
        offloads,
      });

      if (stopMessage) throw new Error(stopMessage);
      return merged;
    },
    /** Release agent resources (MCP servers, background subagents). */
    async close() {
      await agent.close();
    },
  };
}


module.exports = {
  wrapToolsWithContext,
  repeatStopError,
  offloadAtChunkBoundary,
  createAgentHandle,
};

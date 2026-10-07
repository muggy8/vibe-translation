/**
 * Choosing what may move and writing it out. Never moved: a mutating tool's result (the agent must see what it wrote), an error or a refusal (that is the answer the agent has to react to), the most recent tail, and user or assistant messages. Only old READ answers move, and the CALL stays in the transcript so crossCheckReads can still prove the turn read what it claims. If nothing can be moved, the harness says so honestly — "this does not fit in one turn" — rather than falling back to a summary, because a summary is how the artifact gets worse with no error to notice.
 *
 * Part of the context.js layer (split out of the original single file).
 */

const fs = require("fs");
const path = require("path");
const { tool } = require("ai");

const { contextKeepRecentTokens } = require("./limits");
const { estimateMessagesTokens } = require("./measure");

/**
 * The tools whose RESULT is load-bearing and must stay in the conversation
 * verbatim for the whole turn.
 *
 * For the dev team this is the difference between a patch the manager can judge
 * and one it cannot: if the agent loses the record of what it already edited, it
 * edits the same place twice or declares a file list that does not match the
 * tree (AGENTS.md gotcha 75, "a patch shows its changes").
 */
const NEVER_OFFLOADED_TOOLS = ["writeFile", "editFile", "deleteFile"];


/**
 * Is this tool result protected?
 *
 * Protected: a mutating call's result (R3), a call that errored or was refused
 * (R4 — a gate refusal is evidence that lands on the ticket and in tickets.md),
 * and anything the agent is still working with (the recent tail, applied by the
 * caller).
 *
 * Not protected: the *payload* of a read. The call itself always stays (R6), so
 * the record of what the turn actually looked at survives — which is what
 * `crossCheckReads` judges a diagnosis on (gotcha 74).
 *
 * @param {Object} part - A tool-result part from a ModelMessage.
 * @returns {boolean}
 */
function toolResultIsProtected(part) {
  if (!part || part.type !== "tool-result") return true;
  if (NEVER_OFFLOADED_TOOLS.includes(part.toolName)) return true;
  const output = part.output;
  if (!output) return true;
  const type = output.type || "";
  if (type === "error-json" || type === "error-text") return true;
  const value = output.value;
  // The harness's own refusals come back as a plain { error: ... } answer rather
  // than a provider-level tool error, and they are evidence just the same.
  if (value && typeof value === "object" && (value.error || value.refused)) return true;
  return false;
}

// ─── The landmark ───────────────────────────────────────────────────────────


/**
 * One short line describing an offloaded lookup: the tool, what it pointed at,
 * and how much it held. This is the half the agent needs in order to decide what
 * to re-fetch.
 *
 * The failed live turn re-opened `glossary.js` twelve times precisely because it
 * had no such map — re-reading was its only way back, and every page re-billed
 * the whole growing transcript.
 *
 * @param {Object} entry - One `offloaded` record.
 * @returns {string}
 */
function describeOffloadedLookup(entry) {
  const input = entry.input || {};
  const target =
    input.filePath || input.dirPath || input.pattern || input.query ||
    (entry.sourceFiles && entry.sourceFiles[0]) || "";
  const where =
    input.offset != null
      ? ` offset ${input.offset}${input.limit != null ? ` +${input.limit}` : ""}`
      : input.glob
        ? ` glob "${input.glob}"`
        : "";
  const size = ` (${Math.round((entry.bytes || 0) / 1024)} KB)`;
  return `${entry.tool}  ${target}${where}${size}`;
}


/**
 * The block that replaces the offloaded payloads. Capped at 12 lines: a map that
 * is longer than what it replaced has not saved anything.
 *
 * @param {Object} offload - The offload record (with `offloaded` and `id`).
 * @returns {string}
 */
function renderLandmark(offload) {
  const entries = offload.offloaded || [];
  const lines = [
    `[context offload ${offload.id}]`,
    `${entries.length} earlier lookup(s) moved to disk so this turn can keep working. Nothing was discarded.`,
  ];
  for (const entry of entries.slice(0, 11)) lines.push(`  ${describeOffloadedLookup(entry)}`);
  if (entries.length > 11) lines.push(`  +${entries.length - 11} more`);
  lines.push(
    `Retrieve any of it verbatim: recall_memory("<what you are looking for>", "${offload.id}")`
  );
  return lines.join("\n");
}

// ─── The offload store ──────────────────────────────────────────────────────


/**
 * Where one turn's offload files live: inside the run log directory, which is
 * already gitignored machine state and already the place the diagnostics role is
 * allowed to read.
 *
 * @param {string} runDir - The harness's current run directory.
 * @param {string} agentName
 * @param {number} turn
 * @returns {string}
 */
function offloadDirFor(runDir, agentName, turn) {
  return path.join(runDir, `agent-${agentName}`, `turn-${String(turn).padStart(3, "0")}-memory`);
}


/**
 * A short, stable description of a tool call, used as the repetition key.
 *
 * Keyed on the tool name plus its arguments serialised with sorted keys, so two
 * calls that passed the same arguments in a different order are the same lookup.
 *
 * @param {string} name
 * @param {Object} input
 * @returns {string}
 */
function callKey(name, input) {
  const seen = new WeakSet();
  const normalize = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map(normalize);
    if (typeof value === "object") {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]);
      return out;
    }
    return String(value);
  };
  return `${name}\u0000${JSON.stringify(normalize(input ?? {}))}`;
}


/**
 * Move the oldest read payloads out of the conversation and onto disk.
 *
 * Walks the conversation from the oldest message forward, protects the most
 * recent `CONTEXT_KEEP_RECENT_TOKENS` of work, and moves every other read
 * payload that is not protected by R3/R4. The FIRST moved payload is replaced by
 * the landmark block; the rest are replaced by a one-line pointer, because the
 * tool-result part has to stay in place — the AI SDK pairs each result with the
 * assistant message that called it, and removing one would leave a tool call with
 * no answer.
 *
 * R8: if the file cannot be written, nothing is removed. An offload you cannot
 * retrieve is a deletion wearing a different hat, and silent loss is the one
 * outcome this whole module exists to prevent.
 *
 * @param {Object} input
 * @param {string} input.runDir - The harness's run directory.
 * @param {string} input.agentName
 * @param {number} input.turn
 * @param {number} input.chunk
 * @param {Array<Object>} input.messages - The conversation (not mutated).
 * @param {number} input.targetTokens - What the conversation should come down to.
 * @param {string} [input.reason] - "soft-limit" | "hard-limit" | "agent-request".
 * @returns {{ok: boolean, reason: string, id: string|null, file: string|null, dir: string,
 *   offloadedCount: number, tokensBefore: number, tokensAfter: number, landmark: string,
 *   messages: Array<Object>, error: string|null, kept: Object}}
 */
function offload({ runDir, agentName, turn, chunk, messages, targetTokens, reason = "soft-limit" }) {
  const list = Array.isArray(messages) ? messages : [];
  const tokensBefore = estimateMessagesTokens(list);
  const dir = offloadDirFor(runDir, agentName, turn);
  const keepRecent = contextKeepRecentTokens();

  // Walk backwards to find the protection boundary: `boundary` is the index of the
  // FIRST protected message, so everything from there to the end of the list is the
  // agent's immediate working set and everything older than it is eligible.
  // Starting it at 0 is what makes "the whole conversation is already the working
  // set" mean NOTHING IS ELIGIBLE: the eligibility test skips every message at or
  // after the boundary, so a boundary of 0 protects the whole list. (Starting it at
  // `list.length` protects nothing instead, which trims a conversation that was
  // small enough to keep whole — pinned by test/test-context.js group 8.)
  let accumulated = 0;
  let boundary = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    accumulated += estimateMessagesTokens([list[i]]);
    if (accumulated >= keepRecent) {
      boundary = i + 1;
      break;
    }
  }

  const offloaded = [];
  const moved = []; // [{ messageIndex, partIndex, entry }]
  let keptWriteCalls = 0;
  let keptRefusals = 0;

  list.forEach((message, messageIndex) => {
    // The recent tail is the agent's working set: skip it, and work through
    // everything OLDER than the boundary. (The comparison used to be flipped,
    // which would have moved the newest reads and kept the oldest ones.)
    if (messageIndex >= boundary) return;
    if (message.role !== "tool" || !Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      if (part.type !== "tool-result") return;
      if (toolResultIsProtected(part)) {
        if (NEVER_OFFLOADED_TOOLS.includes(part.toolName)) keptWriteCalls += 1;
        else keptRefusals += 1;
        return;
      }
      const output = part.output || {};
      const value = output.value;
      const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
      if (text.length < 512) return; // a payload this small is not worth a file entry
      offloaded.push({
        seq: offloaded.length + 1,
        tool: part.toolName,
        input: part.input ?? null,
        result: value ?? null,
        sourceFiles: sourceFilesOf(part),
        bytes: Buffer.byteLength(text, "utf8"),
      });
      moved.push({ messageIndex, partIndex, entry: offloaded[offloaded.length - 1] });
    });
  });

  const base = {
    ok: false,
    reason,
    id: null,
    file: null,
    dir,
    offloadedCount: 0,
    tokensBefore,
    tokensAfter: tokensBefore,
    landmark: "",
    messages: list,
    error: null,
    // WHICH kind of failure this is, as a field rather than something the caller
    // has to read out of the sentence: "nothing-eligible" means the conversation
    // is already only protected material (a size problem the harness cannot fix),
    // "write-failed" means the disk refused the copy (a bug or a permissions
    // problem, and the conversation is untouched either way).
    failure: null,
    kept: { writeCalls: keptWriteCalls, refusals: keptRefusals, recentTokens: accumulated },
  };
  if (!moved.length) {
    return { ...base, failure: "nothing-eligible", error: "nothing was eligible to offload: the conversation is already only protected material (the ticket, the system prompt, your own edits, refusals, and the most recent work)." };
  }

  const id = `ctx-${new Date().toISOString().replace(/[:.]/g, "-")}-${agentName}-${turn}-${chunk}-${offloaded.length.toString(16).padStart(3, "0")}`;
  const file = path.join(dir, `memory-${turn}-${chunk}.json`);
  const record = {
    schema: 1,
    id,
    agent: agentName,
    turn,
    chunk,
    at: new Date().toISOString(),
    tokensBefore,
    tokensAfter: 0, // filled below, after the rewrite
    reason,
    offloaded,
    kept: base.kept,
  };

  // R8 first, then the rewrite: write the file, and only touch the conversation
  // once the copy is provably on disk.
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
  } catch (err) {
    return { ...base, failure: "write-failed", error: `the offload file could not be written (${err.code || err.message}), so nothing was removed from the conversation.` };
  }

  const landmark = renderLandmark({ id, offloaded });
  // ONE map for the whole conversation, not one per message. `moved` is built in
  // conversation order, so moved[0] is the first payload that left. Scoping this
  // to "the first payload of THIS message" duplicated the entire map once per
  // message whenever a step fired one tool call at a time — which is the common
  // shape — and an N-copy map can cost more than the payloads it replaced.
  const next = list.map((message, messageIndex) => {
    const touched = moved.filter((m) => m.messageIndex === messageIndex);
    if (!touched.length) return message;
    const content = message.content.map((part, partIndex) => {
      const hit = touched.find((m) => m.partIndex === partIndex);
      if (!hit) return part;
      const pointer =
        hit === moved[0]
          ? landmark
          : `[offloaded ${id} seq ${hit.entry.seq}: ${describeOffloadedLookup(hit.entry)} — recall_memory("<what you need>", "${id}")]`;
      return { ...part, output: { type: "text", value: pointer } };
    });
    return { ...message, content };
  });

  record.tokensAfter = estimateMessagesTokens(next);
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
  } catch {
    /* the copy is already on disk; a stale tokensAfter is not worth abandoning the offload */
  }

  return {
    ok: true,
    reason,
    id,
    file,
    dir,
    offloadedCount: offloaded.length,
    tokensBefore,
    tokensAfter: record.tokensAfter,
    landmark,
    messages: next,
    error: null,
    failure: null,
    kept: record.kept,
  };
}


/**
 * Which real file(s) a read payload came from — the half that makes a recall
 * honest, because it lets the answer say "this text came from glossary.js lines
 * 1930–2110, which is still on disk".
 *
 * @param {Object} part - A tool-result part.
 * @returns {string[]}
 */
function sourceFilesOf(part) {
  const input = part.input || {};
  const output = part.output || {};
  const value = output.value;
  const out = new Set();
  if (typeof input.filePath === "string") out.add(input.filePath);
  // `dirPath` is deliberately NOT collected: it is the folder the tool SEARCHED,
  // not a file the text came from, and it is already on the record as `input`
  // (which is what the map line reads). Putting it here would make recall tell the
  // agent to `readFile` a folder — gotcha 60's mistake, manufactured by our own map.
  if (value && typeof value === "object") {
    if (typeof value.filePath === "string") out.add(value.filePath);
    if (Array.isArray(value.matches)) {
      for (const m of value.matches) {
        if (m && typeof m.filePath === "string") out.add(m.filePath);
      }
    }
    if (Array.isArray(value.entries)) {
      for (const e of value.entries) {
        if (typeof e === "string") out.add(e);
        else if (e && typeof e.path === "string") out.add(e.path);
      }
    }
  }
  return [...out];
}

// ─── Recall ─────────────────────────────────────────────────────────────────


/**
 * List this turn's offload records — the lines a turn log should name, so a
 * reader can find the text the agent gave up.
 *
 * @param {string} dir
 * @returns {Array<{id: string, file: string, offloadedCount: number, tokensBefore: number, tokensAfter: number, reason: string}>}
 */
function listOffloads(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      out.push({
        id: record.id,
        file: path.join(dir, name),
        offloadedCount: (record.offloaded || []).length,
        tokensBefore: record.tokensBefore,
        tokensAfter: record.tokensAfter,
        reason: record.reason,
      });
    } catch {
      /* unreadable record: report nothing rather than guess */
    }
  }
  return out;
}


module.exports = {
  NEVER_OFFLOADED_TOOLS,
  toolResultIsProtected,
  describeOffloadedLookup,
  renderLandmark,
  offloadDirFor,
  callKey,
  offload,
  sourceFilesOf,
  listOffloads,
};

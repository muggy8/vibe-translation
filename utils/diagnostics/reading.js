/**
 * A diagnosis is a claim about reading, so the reading is checked: crossCheckReads compares the reply's `read` list against the turn's real tool calls. A grep or listFiles over a FOLDER covers the files inside it (so a claim about a file under that folder is not "cited but never opened"), and a call that ERRORED covers nothing (so counting it would let a reply cite a file it only managed to fail to open). A file the turn got back with recall_memory counts as read. evidenceFootprint hashes the ticket's evidence before and after the turn, so "read-only" is checked against the disk rather than asserted.
 *
 * Part of the diagnostics.js layer (split out of the original single file).
 */

const fs = require("fs");
const path = require("path");

const { MUTATING_TOOL_NAMES, READ_ONLY_REFUSAL, READ_TOOL_NAMES, ROOT } = require("./contract");

/**
 * Normalise a path for comparing a claimed read against an observed tool call.
 * @param {string} p
 * @returns {string}
 */
function normalizeReadPath(p) {
  return String(p || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}


/**
 * Cross-check the files the reply claims it read against the files the turn actually opened.
 *
 * The point is the direction that matters: a diagnosis that cites a file nobody opened is a guess
 * wearing the shape of evidence. (The other direction — a read the reply forgot to mention — is
 * harmless, so it is reported as information, not as a fault.)
 *
 * Two rules keep the check from accusing an honest turn:
 *   - a `grep`/`listFiles` call names a FOLDER and reads everything in it, so it covers a claim
 *     about a file inside that folder;
 *   - a call that ERRORED covers nothing. "I searched it and the search failed" is not reading, and
 *     counting it would let a reply cite a file it only managed to fail to open.
 *
 * And a third, because this role now sets its old reads aside instead of holding them: a
 * `recall_memory` call covers the file its match came from. Setting a read down and bringing the
 * sentence back is reading, not guessing.
 *
 * @param {string[]} claimed - The reply's `read` list.
 * @param {Array<{name: string, input: Object, output: *, error: string|null}>} observed - The turn's tool calls.
 * @returns {{observed: Array<{tool: string, path: string, errored?: boolean}>, unsupported: string[], unmentioned: string[]}}
 */
function crossCheckReads(claimed, observed) {
  const opened = (observed || [])
    .filter((call) => READ_TOOL_NAMES.includes(call.name))
    .map((call) => ({
      tool: call.name,
      // `readFile` names a file; `grep`/`listFiles` name a FOLDER and walk it (gotcha 60). The two
      // cover different claims, and treating them the same is how a honest diagnosis gets accused.
      path: normalizeReadPath((call.input && (call.input.filePath || call.input.dirPath || call.input.pattern)) || ""),
      scopedToFolder: !call.input?.filePath,
      errored: Boolean(call.error),
    }));

  // What the turn can prove it saw: a file it opened whole, and every file inside a folder it
  // searched or listed. A call that ERRORED proves nothing — "I grepped it and the grep died" is not
  // reading, and counting it would let a diagnosis cite a file it only failed to open.
  const files = new Set(opened.filter((o) => !o.errored && !o.scopedToFolder).map((o) => o.path));
  const folders = new Set(
    opened.filter((o) => !o.errored && o.scopedToFolder && o.path).map((o) => o.path)
  );

  // A `recall_memory` call IS reading. This role now sets its old read answers aside on disk instead
  // of holding them, and a recall brings the text back with the file it came from recorded on the
  // match. Without this rule the new memory tools would manufacture gotcha 74's exact false
  // positive: a diagnosis that read `utils/glossary.js`, set it aside, recalled the sentence it
  // needed, and cited the file would be reported as citing something it never opened.
  const recalled = [];
  const recalledPaths = new Set();
  for (const call of observed || []) {
    if (call.name !== "recall_memory" || call.error) continue;
    for (const p of recalledSourceFiles(call.output)) {
      const path = normalizeReadPath(p);
      if (!path || recalledPaths.has(path)) continue;
      recalledPaths.add(path);
      recalled.push({ tool: "recall_memory", path });
    }
  }

  const covers = (p) =>
    files.has(p) ||
    recalledPaths.has(p) ||
    [...folders].some((f) => f === "." || f === "" || p.startsWith(`${f}/`));

  const claimedSet = new Set((claimed || []).map(normalizeReadPath).filter(Boolean));
  const unsupported = [...claimedSet].filter((p) => !covers(p));
  // `unmentioned` stays the READ calls only: a recall that matched five files is a lookup, not five
  // documents the turn read, and reporting each match as "you read this and never mentioned it"
  // would turn a memory tool into a warning machine.
  const unmentioned = [...new Set(opened.map((o) => o.path))].filter((p) => p && !claimedSet.has(p));
  return {
    observed: [
      ...opened.map(({ tool, path: p, errored }) => ({ tool, path: p, ...(errored ? { errored: true } : {}) })),
      ...recalled,
    ],
    unsupported,
    unmentioned,
  };
}


/**
 * The files a `recall_memory` answer names as the source of what it brought back.
 *
 * Defensive about the shape on purpose: the AI SDK wraps a tool's JSON answer as
 * `{ type: "json", value: {…} }`, the harness has recorded a bare object and a string in other
 * places, and a cross-check that silently reads nothing would report an honest diagnosis as a
 * guessed one (gotcha 74).
 *
 * @param {*} output - The recorded output of one `recall_memory` call.
 * @returns {string[]} The source file paths its matches came from.
 */
function recalledSourceFiles(output) {
  let value = output;
  if (value && typeof value === "object" && value.type === "json" && value.value !== undefined) {
    value = value.value;
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const out = new Set();
  for (const match of (value && Array.isArray(value.matched) ? value.matched : [])) {
    if (match && typeof match.sourceFile === "string" && match.sourceFile) out.add(match.sourceFile);
    for (const f of (match && Array.isArray(match.sourceFiles) ? match.sourceFiles : [])) {
      if (typeof f === "string" && f) out.add(f);
    }
  }
  return [...out];
}


/**
 * Every mutating tool call the turn made, from both layers of the read-only guarantee.
 *
 * Two layers, and which one fires depends on how the attempt was made (gotcha 8):
 *   - the tool SET: `readOnlyFsTools` hands the agent only the three read tools, so a call to
 *     `writeFile` never reaches the sandbox — the provider answers "Model tried to call unavailable
 *     tool 'writeFile'". That is recorded in the turn's `toolCalls`, not in the gate's log.
 *   - the approve gate: the backstop, for a mutating tool that ever does reach the sandbox. It
 *     logs its own refusal.
 * Recording only the gate's log would report "the team did not try" for the common case where it
 * tried and the tool set said no — which is exactly the fact the account owner needs.
 *
 * @param {Array<{tool: string, path: string, reason: string, at: string}>} refusals - The gate's own log.
 * @param {Array<{name: string, input?: Object, error?: string|null}>} toolCalls - The turn's real calls.
 * @returns {Array<{tool: string, path: string, reason: string, at: string, layer: string}>}
 */
function collectWriteAttempts(refusals, toolCalls) {
  const out = (refusals || []).map((r) => ({ ...r, layer: "the approve gate" }));
  const seen = new Set(out.map((r) => `${r.tool}\u0000${r.path}`));
  for (const call of toolCalls || []) {
    if (!MUTATING_TOOL_NAMES.includes(call.name)) continue;
    const target = (call.input && (call.input.filePath || call.input.dirPath)) || "(no path given)";
    const key = `${call.name}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      tool: call.name,
      path: target,
      reason:
        `the diagnostics role is not offered ${call.name} at all — the tool set refused the call ` +
        `before it reached the sandbox. ${READ_ONLY_REFUSAL}`,
      at: new Date().toISOString(),
      layer: "the tool set",
    });
  }
  return out;
}


/**
 * The files a ticket points at, and how big they are — measured so a turn's reading can be described
 * afterwards, not so a cap can be computed from it (this role has no step cap; see the note under
 * `DIAGNOSIS_COSTS`).
 *
 * Missing files count as zero rather than failing: a ticket whose evidence is gone is a different
 * problem (and the turn will discover that by itself), and inventing bytes for it would report a size
 * nobody measured.
 *
 * @param {import("./tickets").Ticket} ticket
 * @param {string[]} extraFiles
 * @param {string} [seriesDir] - The series the ticket is about. A ticket's evidence is named the
 *   way the triage named it — relative to the series folder — so resolving it only against this
 *   repo would find nothing and report an empty footprint for the biggest artifact.
 * @returns {Promise<{bytes: number, files: string[]}>}
 */
async function evidenceFootprint(ticket, extraFiles = [], seriesDir = "") {
  const candidates = [...(ticket.evidence || []).map((e) => e.file), ...extraFiles];
  const bases = [ROOT, seriesDir, ticket.seriesDir || ""].filter(Boolean);
  let bytes = 0;
  const files = [];
  for (const raw of candidates) {
    for (const base of bases) {
      const abs = path.isAbsolute(raw) ? raw : path.join(base, raw);
      try {
        const stat = await fs.promises.stat(abs);
        if (stat.isFile()) {
          bytes += stat.size;
          files.push(abs);
          break;
        }
      } catch {
        /* try the next base */
      }
    }
  }
  return { bytes, files };
}


module.exports = {
  normalizeReadPath,
  crossCheckReads,
  recalledSourceFiles,
  collectWriteAttempts,
  evidenceFootprint,
};

/**
 * Searching what this turn moved and handing the text back verbatim, honouring the byte budget.
 *
 * Part of the context.js layer (split out of the original single file).
 */

const fs = require("fs");
const path = require("path");
const { tool } = require("ai");

const { recallMaxBytes } = require("./limits");

/**
 * The longest prefix of `text` that fits `maxBytes` when encoded as UTF-8.
 *
 * Slicing by CHARACTER count is not a byte budget: a Japanese light novel is three
 * bytes per character, so `text.slice(0, 600)` answers 1,800 bytes for a 600-byte
 * promise — the recall budget would be three times larger than it claims on exactly
 * the corpus this pipeline processes. Walking character by character keeps the
 * budget honest and never cuts a character in half.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateToBytes(text, maxBytes) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let used = 0;
  let out = "";
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    out += ch;
  }
  return out;
}


/**
 * Search one turn's own offloaded text.
 *
 * Plain substring matching, case-insensitive — NOT regular expressions. This
 * codebase already learned that a regex dialect from another language trips the
 * agents and answers "no matches" for a search that should have hit (gotcha 60).
 *
 * Scoped by agent and turn (the safety argument): `recall_memory` cannot become a
 * side door to a file the role's own sandbox would have refused, because the
 * store only ever holds what this same turn already legitimately read.
 *
 * @param {Object} input
 * @param {string} input.dir - The turn's offload directory.
 * @param {string} input.query - Plain substring.
 * @param {string} [input.id] - Restrict to one offload record.
 * @param {number} [input.limitBytes] - RECALL_MAX_BYTES by default.
 * @returns {{matched: Array<Object>, matchedCount: number, truncated: boolean, filesRead: number, error: string|null, note: string}}
 */
function recall({ dir, query, id = null, limitBytes = recallMaxBytes() }) {
  const needle = String(query ?? "").toLowerCase();
  const empty = { matched: [], matchedCount: 0, truncated: false, filesRead: 0, note: "" };
  if (!needle) {
    return { ...empty, error: "recall_memory needs a query: the text you are looking for.", note: "" };
  }
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch (err) {
    return { ...empty, error: `no offloaded text for this turn (${err.code || err.message}).` };
  }
  const matched = [];
  let truncated = false;
  let budget = limitBytes;
  let filesRead = 0;

  for (const name of names.sort()) {
    // The id is matched on the RECORD, never on the file name: the file is named
    // `memory-<turn>-<chunk>.json`, which does not contain the id. Filtering by
    // name here would make a scoped recall skip every file and report "nothing
    // matches" for text that is plainly in the store.
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue; // a half-written offload file is not evidence
    }
    if (id && record.id !== id) continue;
    filesRead += 1;
    for (const entry of record.offloaded || []) {
      const text = typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result ?? "");
      const lower = text.toLowerCase();
      const at = lower.indexOf(needle);
      if (at === -1) continue;
      // Return the matching span with a little of each side, verbatim.
      const start = Math.max(0, at - 400);
      const end = Math.min(text.length, at + Math.max(1200, needle.length + 800));
      let excerpt = text.slice(start, end);
      if (Buffer.byteLength(excerpt, "utf8") > budget) {
        excerpt = truncateToBytes(excerpt, budget);
        truncated = true;
      }
      budget -= Buffer.byteLength(excerpt, "utf8");
      matched.push({
        id: record.id,
        seq: entry.seq,
        tool: entry.tool,
        input: entry.input ?? null,
        sourceFile: (entry.sourceFiles || [])[0] || null,
        sourceFiles: entry.sourceFiles || [],
        excerpt,
      });
      if (budget <= 0) {
        truncated = true;
        break;
      }
    }
    if (budget <= 0) break;
  }

  const sources = [...new Set(matched.flatMap((m) => m.sourceFiles || []).filter(Boolean))];
  return {
    matched,
    matchedCount: matched.length,
    truncated,
    filesRead,
    error: matched.length ? null : `no offloaded text from this turn matches "${query}".`,
    note: matched.length
      ? `recall_memory searches only what THIS turn already read. ${sources.length ? `The original file(s) are still on disk (${sources.join(", ")}) — readFile returns them whole.` : "The original file is still on disk."}`
      : "Nothing this turn offloaded matches that query. The original files are still on disk: read them directly.",
  };
}

// ─── The two tools (ACM's manage_context / query_memory) ────────────────────


module.exports = {
  truncateToBytes,
  recall,
};

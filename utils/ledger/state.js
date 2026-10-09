/**
 * utils/ledger/state.js — the ledger as a file: where it lives, what it holds, and how an entry gets in.
 *
 * The knobs (how many attempts count as spinning, how many entries the file may hold, whether
 * it is written at all) and the two operations: read the whole thing, append one entry.
 * Appending is the only write, and it is capped: a ledger that grows forever is a file
 * nobody reads.
 *
 * The run id is one per process (INDEX_RUN_ID, or the first call in this process), because
 * act mode invokes the ledger several times per run and each entry must land on the SAME run
 * or the anti-spin question cannot be answered (gotcha 73).
 */

const fs = require("fs");
const path = require("path");

const { postMortemDir } = require("../postmortem");
const { readBoolEnv } = require("../../configs/shared");
const { ensureRunStateGitignore } = require("../../configs/run-state");

// ─── Settings ─────────────────────────────────────────────────────────────────

/**
 * How many prior attempts that did not help are required before the same action is
 * refused (LEDGER_SPIN_ATTEMPTS; minimum 1).
 *
 * Two is the default because one failure can be an accident — a container that was not
 * up, a volume that genuinely needed the re-run — while the same action failing twice
 * against the same finding is the shape of a deterministic gate rejecting the same file.
 *
 * @returns {number}
 */
function spinThreshold() {
  const n = parseInt(process.env.LEDGER_SPIN_ATTEMPTS, 10);
  return Number.isFinite(n) && n >= 1 ? n : 2;
}

/**
 * How many entries the ledger keeps (LEDGER_MAX_ENTRIES; minimum 100). When it is
 * exceeded the OLDEST entries are dropped, and the next report says so — machine state
 * that grows without a ceiling is a disk problem waiting to happen on a 17-volume series.
 * @returns {number}
 */
function maxEntries() {
  const n = parseInt(process.env.LEDGER_MAX_ENTRIES, 10);
  return Number.isFinite(n) && n >= 100 ? n : 5000;
}

/**
 * @returns {boolean} Whether the ledger is enabled (LEDGER_ENABLED, default on).
 */
function ledgerEnabled() {
  return readBoolEnv("LEDGER_ENABLED", true);
}

/**
 * Where the ledger lives: beside the post-mortem reports, because it is the same kind
 * of thing — a record of what a run did, kept with the series it describes.
 * @returns {string} Absolute path.
 */
function ledgerPath() {
  return path.join(postMortemDir(), "ledger.json");
}

/**
 * The id for one run. `INDEX_RUN_ID` when the caller supplies one (a test, or a wrapper
 * that wants the entries grouped), otherwise a timestamp taken once per process.
 *
 * It matters because the anti-spin rule is counted per run: after a real fix, the same
 * action against the same finding is a legitimate new attempt in a new run.
 *
 * @returns {string}
 */
function runId() {
  const fromEnv = (process.env.INDEX_RUN_ID || "").trim();
  if (fromEnv) return fromEnv;
  if (!process.env.__LEDGER_RUN_ID) {
    process.env.__LEDGER_RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
  }
  return process.env.__LEDGER_RUN_ID;
}

// ─── Reading and writing ──────────────────────────────────────────────────────

/**
 * Read the ledger.
 *
 * Never returns a half-read ledger, and never reports a corrupt one as empty: `error`
 * is set whenever the file exists and could not be understood, so the caller can say
 * "I cannot tell whether this is a repeat" instead of silently allowing everything.
 * (The same honesty rule as `readUsableManifest` — gotcha 33.)
 *
 * @param {string} [filePath] - Defaults to `ledgerPath()`.
 * @returns {{entries: LedgerEntry[], error: string|null, truncated: number}} `truncated`
 *   is how many entries have been dropped by the ceiling over the ledger's whole life —
 *   a reader must be able to tell that the history is incomplete, not just that it is short.
 */
function readLedger(filePath = ledgerPath()) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    // No ledger yet is the normal state of a first run: that is empty, not an error.
    if (err && err.code === "ENOENT") return { entries: [], error: null, truncated: 0 };
    return { entries: [], error: `the ledger could not be read (${err.message})`, truncated: 0 };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      entries: [],
      error: `the ledger is not valid JSON (${err.message}) — it is not being treated as empty`,
      truncated: 0,
    };
  }

  const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : null;
  if (!entries) {
    return { entries: [], error: "the ledger has no `entries` array — it is not being treated as empty", truncated: 0 };
  }

  const kept = entries.filter((e) => e && typeof e === "object" && e.id && e.run && e.step);
  const dropped = entries.length - kept.length;
  const stored = Number.isFinite(parsed && parsed.truncated) ? parsed.truncated : 0;
  return {
    entries: kept,
    error: dropped
      ? `${dropped} ledger entr(ies) were unreadable and were skipped`
      : null,
    truncated: stored,
  };
}

/**
 * Append one entry. Append-only: existing entries are never rewritten or reordered, so
 * the ledger stays a record of what actually happened rather than a state that gets
 * edited to look better.
 *
 * @param {Object} input
 * @param {"assessment"|"intervention"} input.kind
 * @param {string} input.step
 * @param {string|null} [input.volume]
 * @param {string} [input.action]
 * @param {string|null} [input.finding]
 * @param {("improved"|"unchanged"|"worse"|"refused")} [input.outcome]
 * @param {{HIGH: number, MEDIUM: number, LOW: number}} [input.findings]
 * @param {string[]} [input.findingKinds]
 * @param {number} [input.tokens]
 * @param {("manager"|"diagnostics"|"owner"|"runner")} [input.decidedBy]
 * @param {string|null} [input.ticket]
 * @param {string} [input.note]
 * @param {string} [input.run] - Defaults to `runId()`.
 * @param {string} [filePath] - Defaults to `ledgerPath()`.
 * @returns {{entry: LedgerEntry|null, written: boolean, truncated: number, error: string|null}}
 *   `truncated` is the cumulative number of entries the ceiling has dropped from this
 *   ledger, so a caller can report that the recorded history is incomplete.
 */
function appendLedgerEntry(input, filePath = ledgerPath()) {
  if (!ledgerEnabled()) return { entry: null, written: false, truncated: 0, error: null };
  if (!input || !input.step || !input.kind) {
    return { entry: null, written: false, truncated: 0, error: "a ledger entry needs at least `kind` and `step`" };
  }

  const run = input.run || runId();
  const current = readLedger(filePath);
  const entries = current.entries;
  const sequence = entries.filter((e) => e.run === run && e.step === input.step).length + 1;

  /** @type {LedgerEntry} */
  const entry = {
    id: `${run}/${input.step}/${sequence}`,
    run,
    at: new Date().toISOString(),
    kind: input.kind,
    step: input.step,
    // `null` stays `null`. Coercing it with String() would write the four-character string
    // "null", and `matchesKey` compares a step-level entry (volume null) against a step-level
    // key — a step-level attempt would then never match itself, and the anti-spin gate would
    // silently stop counting the very case it exists for.
    volume: input.volume === undefined || input.volume === null ? null : String(input.volume),
    finding: input.finding === undefined ? null : input.finding,
    action: input.action === undefined ? (input.kind === "assessment" ? "assess" : null) : input.action,
    outcome: input.outcome === undefined ? null : input.outcome,
    decidedBy: input.decidedBy === undefined ? null : input.decidedBy,
    ticket: input.ticket === undefined ? null : input.ticket,
  };
  if (input.findings) entry.findings = input.findings;
  if (input.findingKinds) entry.findingKinds = input.findingKinds;
  // The numbers behind an outcome (`utils/delivery-verify.js`'s before/after account). A verdict
  // with no account next to it is a verdict nobody can check afterwards — least of all the
  // diagnostics team, who is the reader this whole layer exists to serve.
  if (input.signals !== undefined) entry.signals = input.signals;
  if (input.tokens !== undefined) entry.tokens = input.tokens;
  if (input.note) entry.note = input.note;

  const next = [...entries, entry];
  const ceiling = maxEntries();
  let truncated = current.truncated || 0;
  let kept = next;
  if (next.length > ceiling) {
    const droppedNow = next.length - ceiling;
    truncated += droppedNow; // cumulative: the history is incomplete by this many entries
    kept = next.slice(droppedNow); // drop the OLDEST, keep the recent history
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    ensureRunStateGitignore();
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          // Schema marker, so a ledger written by an older runner is recognisable
          // rather than silently misread (the readUsableManifest rule, gotcha 33).
          schema: 1,
          updatedAt: new Date().toISOString(),
          truncated,
          entries: kept,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  } catch (err) {
    return { entry, written: false, truncated, error: `the ledger could not be written (${err.message})` };
  }

  return { entry, written: true, truncated, error: null };
}

module.exports = {
  spinThreshold,
  maxEntries,
  ledgerEnabled,
  ledgerPath,
  runId,
  readLedger,
  appendLedgerEntry,
};

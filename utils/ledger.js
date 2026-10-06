/**
 * utils/ledger.js — What the pipeline has already tried, and whether it helped.
 *
 * Why this exists. The delivery-manager design (see the plan notebook, and AGENTS.md
 * §3.7) gives an agent authority to re-run steps, wipe a volume's outputs and cascade,
 * force a re-audit. That authority is safe, but it has one predictable failure mode
 * that is not danger — it is **spinning**: a finding appears, the manager re-runs the
 * step, the same finding appears again, it re-runs again, and a 12-hour run ends where
 * it started. Volume 15 of the live series is exactly this shape: the carry-forward
 * gate quarantined a good glossary, and re-running a deterministic gate produces the
 * identical quarantine every time, because the gate is deterministic and the finding
 * was never about the data.
 *
 * Nothing in the pipeline remembers a *decision*. `translation-state.json`, the
 * `*-rolling-state.json` files and the verification sidecars all remember artifacts —
 * what was produced and what it was produced from. None of them can answer "have I
 * already tried this, and did it work?", and without that question the manager cannot
 * tell a repair from a repeat.
 *
 * So this module is the run's memory, written as data:
 *   - an **assessment** entry: what a step left behind (recorded automatically);
 *   - an **intervention** entry: what was decided about it, and what happened after.
 *
 * The rule it exists to enforce — the same rule `TRANSLATE_QA_RETRY_BUDGET` already
 * enforces for one chapter inside the translation loop, lifted to the whole run:
 * **the same action against the same finding, producing the same result, is not
 * available a third time.** That is not a safety restriction; it is the signal that
 * the problem is not the data and the diagnostics team is needed.
 *
 * Two directions this file deliberately chooses:
 *   1. **A ledger that cannot be read is treated as spinning, not as empty.** Refusing
 *      an intervention is recoverable (fix or remove the ledger file and the action is
 *      available again); spinning is not. This is the same direction `runPostMortem`
 *      takes — an assessment that could not run never reports clean.
 *   2. **Only repetition is blocked.** A different action against the same finding is
 *      a new attempt, and a prior action that `improved` is not evidence against
 *      anything. A guard that blocks everything is the guard that gets disabled.
 *
 * @module utils/ledger
 */

const fs = require("fs");
const path = require("path");
const { postMortemDir } = require("./postmortem");
const { readBoolEnv } = require("../configs/shared");

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One entry in the run ledger.
 *
 * @typedef {Object} LedgerEntry
 * @property {string} id - Stable identifier: `<run>/<step>/<sequence>`. Unique within
 *   the ledger, so an entry can be cited from a ticket or a report.
 * @property {string} run - The run this entry belongs to (see `runId()`).
 * @property {string} at - ISO timestamp.
 * @property {"assessment"|"intervention"} kind - `assessment`: what a step left behind,
 *   recorded automatically by the runner. `intervention`: something was decided and done.
 * @property {string} step - The pipeline step name (a gulp task name).
 * @property {string|null} [volume] - Two-digit installment, or null for a step-level entry.
 * @property {string|null} [finding] - For an intervention: the finding `kind` it responded
 *   to (`missing-required`, `quarantine-present`, …). Null for an assessment.
 * @property {string|null} [action] - For an intervention: the named action taken. For an
 *   assessment this is `"assess"`.
 * @property {("improved"|"unchanged"|"worse"|"refused")|null} [outcome] - What happened
 *   after the intervention, judged by comparing the deliverable before and after (NOT by
 *   whether the finding disappeared — a fix that removes a finding and shrinks a glossary
 *   is a regression). Null for an assessment.
 * @property {{HIGH: number, MEDIUM: number, LOW: number}} [findings] - For an assessment:
 *   what the post-mortem counted.
 * @property {string[]} [findingKinds] - For an assessment: the distinct finding kinds, so a
 *   later run can tell whether the same class keeps coming back on its own.
 * @property {number} [tokens] - Rough cost attributed to this entry, when known.
 * @property {("manager"|"diagnostics"|"owner"|"runner")|null} [decidedBy] - Who made the call.
 * @property {string|null} [ticket] - Ticket id this entry belongs to, when there is one.
 * @property {string} [note] - One line of human-readable provenance.
 */

/**
 * The four things an action is identified by when deciding "is this a repeat?".
 *
 * @typedef {Object} LedgerKey
 * @property {string} step
 * @property {string|null} [volume]
 * @property {string} finding
 * @property {string} action
 */

/**
 * The answer to "may I take this action?".
 *
 * @typedef {Object} LedgerDecision
 * @property {boolean} allowed - False when this exact action has already failed to help
 *   `threshold` times, or when the ledger could not be read.
 * @property {string} reason - Why. Always populated; a refusal that does not explain itself
 *   is indistinguishable from a bug.
 * @property {number} attempts - Prior attempts with this exact key in the counted scope.
 * @property {number} unhelpful - Prior attempts that ended `unchanged` or `worse`.
 * @property {string|null} error - Set when the ledger could not be read at all.
 */

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
 * of thing — machine state describing what a run did, gitignored like `.logs/`.
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

// ─── The anti-spin question ───────────────────────────────────────────────────

/**
 * Match an entry against a key. Volume is compared loosely on purpose: a step-level
 * entry (volume null) is about the whole step, and it should not be confused with an
 * entry about one volume.
 *
 * @param {LedgerEntry} entry
 * @param {LedgerKey} key
 * @returns {boolean}
 */
function matchesKey(entry, key) {
  if (entry.kind !== "intervention") return false;
  if (entry.step !== key.step) return false;
  if (entry.finding !== key.finding) return false;
  if (entry.action !== key.action) return false;
  const want = key.volume === undefined || key.volume === null ? null : String(key.volume);
  const have = entry.volume === undefined || entry.volume === null ? null : String(entry.volume);
  return want === have;
}

/**
 * How many prior interventions match this key.
 *
 * @param {LedgerEntry[]} entries
 * @param {LedgerKey} key
 * @param {{run?: string|null}} [opts] - Pass `run` to count within one run; omit it to
 *   count across every run the ledger still holds.
 * @returns {number}
 */
function attemptCount(entries, key, opts = {}) {
  const run = opts.run === undefined ? null : opts.run;
  return entries.filter((e) => matchesKey(e, key) && (run === null || e.run === run)).length;
}

/**
 * How many prior interventions matching this key did NOT help — ended `unchanged` or
 * `worse`. This is the number that matters: an attempt that improved something is not
 * evidence against trying again, and an attempt that made things worse is the strongest
 * evidence there is.
 *
 * @param {LedgerEntry[]} entries
 * @param {LedgerKey} key
 * @param {{run?: string|null}} [opts]
 * @returns {number}
 */
function unhelpfulAttempts(entries, key, opts = {}) {
  const run = opts.run === undefined ? null : opts.run;
  return entries.filter(
    (e) =>
      matchesKey(e, key) &&
      (run === null || e.run === run) &&
      (e.outcome === "unchanged" || e.outcome === "worse")
  ).length;
}

/**
 * Is this action a repeat that has already failed to help?
 *
 * Counted within one run by default: after a real fix, the same action in a new run is a
 * legitimate attempt, and blocking it forever would make the ledger a permanent veto.
 *
 * @param {LedgerEntry[]} entries
 * @param {LedgerKey} key
 * @param {{run?: string, threshold?: number}} [opts]
 * @returns {boolean}
 */
function isSpinning(entries, key, opts = {}) {
  const threshold = opts.threshold === undefined ? spinThreshold() : opts.threshold;
  const run = opts.run === undefined ? runId() : opts.run;
  return unhelpfulAttempts(entries, key, { run }) >= threshold;
}

/**
 * The one question the manager asks before acting.
 *
 * @param {LedgerKey} key
 * @param {{dir?: string, run?: string, threshold?: number}} [opts]
 * @returns {LedgerDecision}
 */
function interventionAllowed(key, opts = {}) {
  const filePath = opts.dir ? path.join(opts.dir, "ledger.json") : ledgerPath();
  const run = opts.run === undefined ? runId() : opts.run;
  const threshold = opts.threshold === undefined ? spinThreshold() : opts.threshold;

  if (!key || !key.step || !key.finding || !key.action) {
    return {
      allowed: false,
      reason: "an intervention needs a step, a finding kind and a named action before it can be checked",
      attempts: 0,
      unhelpful: 0,
      error: "incomplete intervention key",
    };
  }

  const ledger = readLedger(filePath);
  if (ledger.error && ledger.entries.length === 0) {
    // Blind. Refuse, and say why: refusing is recoverable, spinning is not.
    return {
      allowed: false,
      reason: `${ledger.error} — the action is refused until the ledger is readable`,
      attempts: 0,
      unhelpful: 0,
      error: ledger.error,
    };
  }

  const attempts = attemptCount(ledger.entries, key, { run });
  const unhelpful = unhelpfulAttempts(ledger.entries, key, { run });
  if (unhelpful >= threshold) {
    const crossRun = unhelpfulAttempts(ledger.entries, key, { run: null });
    return {
      allowed: false,
      reason:
        `"${key.action}" has already been tried against ${key.finding} on ` +
        `${key.volume ? `volume ${key.volume} of ` : ""}${key.step} ${unhelpful} time(s) ` +
        `in this run without changing anything${
          crossRun > unhelpful ? ` (${crossRun} across all recorded runs)` : ""
        }. Repeating it a third time is not a repair — open a ticket for the diagnostics team.`,
      attempts,
      unhelpful,
      error: ledger.error || null,
    };
  }

  return { allowed: true, reason: "", attempts, unhelpful, error: ledger.error || null };
}

// ─── What recurs on its own ───────────────────────────────────────────────────

/**
 * Which finding kinds appeared in an EARLIER run and appeared again in this one.
 *
 * This is the cheap, model-free half of the "call in diagnostics" trigger: a finding that
 * a re-run does not clear is structural, and the manager should not spend a second
 * intervention on it. It costs nothing to know because the assessments are already recorded.
 *
 * @param {LedgerEntry[]} entries
 * @param {string} run - The current run id.
 * @returns {Array<{finding: string, steps: string[], runs: number}>}
 */
function recurringFindings(entries, run) {
  const seen = new Map(); // finding -> { steps:Set, runs:Set }
  for (const e of entries) {
    if (e.kind !== "assessment" || !Array.isArray(e.findingKinds)) continue;
    for (const kind of e.findingKinds) {
      if (!seen.has(kind)) seen.set(kind, { steps: new Set(), runs: new Set() });
      const rec = seen.get(kind);
      rec.steps.add(e.step);
      rec.runs.add(e.run);
    }
  }
  const out = [];
  for (const [finding, rec] of seen) {
    if (!rec.runs.has(run) || rec.runs.size < 2) continue;
    out.push({ finding, steps: [...rec.steps].sort(), runs: rec.runs.size });
  }
  return out.sort((a, b) => b.runs - a.runs || a.finding.localeCompare(b.finding));
}

/**
 * Total tokens the ledger attributes to one run, when entries carry costs.
 * @param {LedgerEntry[]} entries
 * @param {string} run
 * @returns {number}
 */
function tokensForRun(entries, run) {
  return entries.reduce((sum, e) => (e.run === run && typeof e.tokens === "number" ? sum + e.tokens : sum), 0);
}

/**
 * The ledger as Markdown, for the human-facing report.
 * @param {LedgerEntry[]} entries
 * @param {string} run
 * @param {number} [limit]
 * @returns {string}
 */
function renderLedgerMarkdown(entries, run, limit = 40) {
  const mine = entries.filter((e) => e.run === run);
  if (!mine.length) return "Ledger: nothing was recorded in this run.\n";
  const interventions = mine.filter((e) => e.kind === "intervention");
  if (!interventions.length) {
    return `Ledger: ${mine.length} step(s) assessed in run ${run}; nothing was decided.\n`;
  }
  const lines = [`Ledger: ${mine.length} entr(ies) recorded in run ${run}`];
  lines.push(`  interventions: ${interventions.length}`);
  for (const e of interventions.slice(-limit)) {
    lines.push(
      `  [${e.at}] ${e.step}${e.volume ? ` v${e.volume}` : ""} — ${e.finding} → ${e.action} ` +
        `(${e.outcome || "outcome not recorded"})${e.ticket ? ` ticket ${e.ticket}` : ""}`
    );
  }
  return lines.join("\n") + "\n";
}

module.exports = {
  ledgerEnabled,
  ledgerPath,
  runId,
  spinThreshold,
  maxEntries,
  readLedger,
  appendLedgerEntry,
  attemptCount,
  unhelpfulAttempts,
  isSpinning,
  interventionAllowed,
  recurringFindings,
  tokensForRun,
  renderLedgerMarkdown,
};

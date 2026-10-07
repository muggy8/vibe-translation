/**
 * utils/ledger/decide.js — the anti-spin question, and the answer that stops a run from repeating itself.
 *
 * "Have we already tried this, and did it help?" is the whole reason the ledger exists. A key
 * is a (step, volume, finding, action) tuple; the attempts that did NOT help are counted
 * against it, and past the threshold the same action is refused.
 *
 * This is a guard the role may not switch off: there is no env knob that makes a refused
 * intervention allowed again (gotcha 70 — volume 15's gate was correctly refusing a glossary
 * that had GROWN, and the cheapest ticket answer was the setting under which 457 terms once
 * vanished).
 */

const path = require("path");

const { spinThreshold, ledgerPath, runId, readLedger } = require("./state");

/** @typedef {import("../ledger").LedgerEntry} LedgerEntry */
/** @typedef {import("../ledger").LedgerKey} LedgerKey */

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

module.exports = {
  attemptCount,
  unhelpfulAttempts,
  isSpinning,
  interventionAllowed,
};

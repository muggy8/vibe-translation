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
 * The code lives in utils/ledger/: state.js (the file itself — the knobs, the read, the one
 * append), decide.js (the anti-spin question a manager must answer before acting), report.js
 * (what the ledger says out loud). This file is the public surface, and the two shapes the
 * rest of the delivery layer names in its JSDoc.
 *
 * @module utils/ledger
 */

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

const state = require("./ledger/state");
const decide = require("./ledger/decide");
const report = require("./ledger/report");

// The public surface, unchanged from the single file.
module.exports = {
  ledgerEnabled: state.ledgerEnabled,
  ledgerPath: state.ledgerPath,
  runId: state.runId,
  spinThreshold: state.spinThreshold,
  maxEntries: state.maxEntries,
  readLedger: state.readLedger,
  appendLedgerEntry: state.appendLedgerEntry,
  attemptCount: decide.attemptCount,
  unhelpfulAttempts: decide.unhelpfulAttempts,
  isSpinning: decide.isSpinning,
  interventionAllowed: decide.interventionAllowed,
  recurringFindings: report.recurringFindings,
  tokensForRun: report.tokensForRun,
  renderLedgerMarkdown: report.renderLedgerMarkdown,
};

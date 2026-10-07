/**
 * utils/ledger/report.js — what the ledger says out loud.
 *
 * The recurring-finding question (which finding classes came back on their own, across runs),
 * the cost of a run, and the Markdown account a human reads. Pure functions over the entries:
 * nothing here writes.
 */

/** @typedef {import("../ledger").LedgerEntry} LedgerEntry */

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

module.exports = { recurringFindings, tokensForRun, renderLedgerMarkdown };

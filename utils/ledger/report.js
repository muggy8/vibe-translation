/**
 * utils/ledger/report.js — what the ledger says out loud.
 *
 * The recurring-finding question (which (step, finding kind) pairs came back on their own, across
 * runs), the cost of a run, and the Markdown account a human reads. Pure functions over the entries:
 * nothing here writes.
 */

/** @typedef {import("../ledger").LedgerEntry} LedgerEntry */

// ─── What recurs on its own ───────────────────────────────────────────────────

/**
 * @typedef {Object} RecurringFinding
 * @property {string} finding - The finding `kind`.
 * @property {string} step - The ONE step that recorded it, in more than one run.
 * @property {number} runs - How many recorded runs THAT STEP recorded it in.
 */

/**
 * Which (step, finding kind) pairs appeared in an EARLIER run and appeared again in this one.
 *
 * This is the cheap, model-free half of the "call in diagnostics" trigger: a finding a re-run of
 * the step does not clear is structural, and the manager should not spend a second intervention on
 * it. It costs nothing to know because the assessments are already recorded.
 *
 * **Why the key is (step, kind) and not the kind.** The claim this feeds is a sentence about a
 * step: `utils/resume/triage.js` and `utils/resume/plan.js` tell a step "a re-run of THIS step has
 * already not cleared it", and `utils/resume/escalate.js` turns that sentence into a ticket that
 * drops the repair. A key on the kind alone cannot support that sentence. Measured on the two-halt
 * probe (`test/test-pause-resume.js` scenario 3): `glossary` ran once and `style-guide` ran once,
 * both recording `wrong-shape`; keyed on the kind that is one record — `wrong-shape, 2 runs,
 * steps [glossary, style-guide]` — and indexing it under every step it names made the triage say of
 * glossary *"the ledger says a re-run of this step has already not cleared it"* and choose
 * `open-ticket` over `wipe-and-cascade`. Glossary was never re-run. The claim was built out of a
 * different step's record, and what it cost was the repair.
 *
 * A defect that recurred in two different steps is **two facts**, each about its own step, and
 * neither one says anything about the other. Keyed per step, the same ledger supports no recurrence
 * at all; re-run glossary a second time and exactly one fact says "glossary, twice, same kind",
 * which is the claim the escalation makes. The anti-spin half is untouched by this: `isSpinning` /
 * `interventionAllowed` in `./decide.js` key on (step, volume, finding) over `intervention` entries
 * in ONE run, and this function reads `assessment` entries across runs. Narrowing the key here
 * removes a claim nothing earned; it does not weaken the guarantee that a step genuinely re-run and
 * genuinely not cleared still escalates.
 *
 * @param {LedgerEntry[]} entries
 * @param {string} run - The current run id.
 * @returns {RecurringFinding[]}
 */
function recurringFindings(entries, run) {
  /** @type {Map<string, {step: string, finding: string, runs: Set<string>}>} */
  const seen = new Map(); // `${step}\u0000${finding}` -> its own run set
  for (const e of entries) {
    if (e.kind !== "assessment" || !Array.isArray(e.findingKinds)) continue;
    for (const kind of e.findingKinds) {
      const key = `${e.step}\u0000${kind}`;
      if (!seen.has(key)) seen.set(key, { step: e.step, finding: kind, runs: new Set() });
      seen.get(key).runs.add(e.run);
    }
  }
  const out = [];
  for (const rec of seen.values()) {
    if (!rec.runs.has(run) || rec.runs.size < 2) continue;
    out.push({ step: rec.step, finding: rec.finding, runs: rec.runs.size });
  }
  return out.sort(
    (a, b) => b.runs - a.runs || a.step.localeCompare(b.step) || a.finding.localeCompare(b.finding)
  );
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

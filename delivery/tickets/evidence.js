/**
 * What a ticket is allowed to cite: the assessment's own findings for that step and volume, and what
 * this run has already tried, read out of the ledger rather than out of the manager's memory.
 *
 * Part of the delivery/tickets.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions
const { readLedger } = require("../../utils/ledger");

/**
 * What the manager is allowed to cite as evidence for one step of the plan: the assessment's own
 * findings for that step and volume, and nothing else. It has not read the code, the prompts or the
 * run transcripts, so a ticket that cited them would be the manager reaching into the container it
 * is not allowed to open (gotcha 74 checks the same boundary on the ANSWER side).
 *
 * When the assessment named nothing citable — it could not run, or the plan was not built from a
 * triage — the fallback names the report the diagnostics team should read rather than inventing
 * evidence the manager did not look at.
 *
 * @param {import("../../utils/resume").ResumeStepPlan} step
 * @param {Object} state - The working state the plan was built from.
 * @param {string} reason - The sentence that explains why a question is being asked at all.
 * @returns {Array<{file: string, note: string}>}
 */
function evidenceForStep(step, state, reason) {
  const stepState = (state.stepStates || []).find((s) => s.step === step.step) || {};
  const evidence = [];
  const cite = (f, label) => {
    if (!f) return;
    if (step.fromVolume && f.volume && String(f.volume) !== String(step.fromVolume)) return;
    evidence.push({ file: f.file, note: `${label} ${f.kind}: ${f.message}` });
  };
  /**
   * The label a ticket cites beside a finding.
   *
   * It used to be the literal `[HIGH]`, which was true by construction only while "damage" meant
   * "severity HIGH". Damage is now decided by the finding's LEVEL, so a MAJOR finding emitted at MEDIUM
   * was being stamped `[HIGH]` on the ticket — a claim about the finding that the routing no longer
   * makes. Cite the level, with the severity beside it, and say so out loud when the level was defaulted
   * because the kind is not in the table.
   *
   * @param {Object} f - A post-mortem finding.
   * @returns {string}
   */
  const citeLabel = (f) => {
    const level = f.levelDeclared === false ? "UNDECLARED" : f.level;
    return level && f.severity ? `[${level}/${f.severity}]` : `[${level || f.severity || "unknown"}]`;
  };
  for (const f of stepState.damageFindings || []) cite(f, citeLabel(f));
  for (const f of stepState.evidenceFindings || []) cite(f, citeLabel(f));
  if (!evidence.length) {
    evidence.push({
      file: `${step.step}.md (post-mortem report)`,
      note: `the assessment for ${step.step}: ${step.finding || "no finding named"} — ${reason}`,
    });
  }
  return evidence;
}

/**
 * What has already been tried on this step, read out of the ledger rather than out of the
 * manager's memory, so "this is the third time" is a query with citable ids and a spin cannot be
 * laundered into a fresh request (gotcha 70).
 *
 * @param {string} stepName
 * @param {string} run
 * @returns {Array<{action: string, outcome: string, ledgerId: string}>}
 */
function triedForStep(stepName, run) {
  return (readLedger().entries || [])
    .filter((e) => e.kind === "intervention" && e.step === stepName && e.run === run)
    .map((e) => ({ action: e.action, outcome: e.outcome, ledgerId: e.id }));
}

/**
 * What an investigation cites: the files the assessment named for that (kind, step), with the batch's
 * own message beside each one.
 *
 * The volume is deliberately absent from an investigation ticket — the question is about the finding
 * kind on the step, and the batch already folded every volume into it. The files are the evidence, and
 * they name the books.
 *
 * @param {Object} investigation - One bounded investigation entry.
 * @param {Object} state - The working state the plan was read from.
 * @returns {Array<{file: string, note: string}>}
 */
function evidenceForInvestigation(investigation, state) {
  const stepState = (state.stepStates || []).find((s) => s.step === investigation.step) || {};
  const batch = (stepState.gapBatches || []).find((b) => b.kind === investigation.kind) || {};
  const files = (investigation.files || []).slice(0, 5);
  if (files.length) {
    return files.map((f) => ({
      file: f,
      note: `[${investigation.level}] ${investigation.kind} in ${investigation.step}: ${batch.message || "the assessment named this file"}`,
    }));
  }
  return [
    {
      file: `${investigation.step}.md (post-mortem report)`,
      note:
        `the assessment for ${investigation.step}: ${investigation.kind} fired ${investigation.occurrences} ` +
        `time(s) — ${batch.message || "no file was named for it"}`,
    },
  ];
}

module.exports = {
  evidenceForStep,
  triedForStep,
  evidenceForInvestigation,
};

/**
 * The human-facing half: 'glossary is whole through 14, missing 15–17' instead of seventeen folders of file names.
 *
 * Part of the resume.js layer (split out of the original single file).
 */

const { PIPELINE_STEPS } = require("../../gulpfile");

const { actionByName } = require("./menu");

/**
 * Collapse installment numbers into readable ranges: `["01","02","03","07"]` → `"01–03, 07"`.
 *
 * @param {string[]} installments
 * @returns {string} - `""` for an empty list.
 */
function formatRanges(installments) {
  const nums = installments
    .map((raw) => ({ raw, n: parseInt(raw, 10) }))
    .filter((v) => Number.isFinite(v.n))
    .sort((a, b) => a.n - b.n);
  if (!nums.length) return "";
  const chunks = [];
  let start = nums[0];
  let prev = nums[0];
  const flush = () => chunks.push(start.n === prev.n ? start.raw : `${start.raw}–${prev.raw}`);
  for (const cur of nums.slice(1)) {
    if (cur.n === prev.n + 1) {
      prev = cur;
      continue;
    }
    flush();
    start = cur;
    prev = cur;
  }
  flush();
  return chunks.join(", ");
}


/**
 * How far one step has actually got, as a number rather than a sentence.
 *
 * `progressByStep` below renders this for a human at 7am; this is the same measurement for a
 * machine that has to decide whether an intervention changed anything. Comparing the before
 * and after counts is the smallest honest version of "compare the deliverable": it asks what
 * the step was supposed to leave behind, not whether the error message went away (which is
 * the question a fixer answers by removing the guard — gotcha 70).
 *
 * @param {VolumeInventory[]} volumes - A working state's volume inventory.
 * @param {string} step
 * @returns {{built: number, missing: number, builtInstallments: string[], missingInstallments: string[]}}
 */
function progressForStep(volumes, step) {
  const vols = volumes || [];
  const hasGap = (v) => (v.missingForStep || []).some((m) => m.step === step);
  // A folder the plan names but that is not on disk is missing for every step, not none.
  const missingInstallments = vols.filter((v) => !v.exists || hasGap(v)).map((v) => v.installment);
  const builtInstallments = vols.filter((v) => v.exists && !hasGap(v)).map((v) => v.installment);
  return {
    built: builtInstallments.length,
    missing: missingInstallments.length,
    builtInstallments,
    missingInstallments,
  };
}


/**
 * Per step, which volumes hold its required outputs and which do not.
 *
 * This is the sentence a delivery manager actually needs — "glossary is whole through 14,
 * missing 15–17" — instead of seventeen folders' worth of file names, which is what the first
 * version of this report printed and what made the important line impossible to find.
 *
 * @param {VolumeInventory[]} volumes
 * @returns {Array<{step: string, built: string, missing: string}>} - Only the steps with a gap.
 */
function progressByStep(volumes) {
  const vols = volumes || [];
  const gaps = new Set();
  for (const v of vols) for (const m of v.missingForStep) gaps.add(m.step);

  // Only the steps the pipeline actually runs, in run order. `verify-translate` and `retranslate`
  // have their own artifact specs, but they are half-rounds of `translate-qa` — listing them
  // separately makes the table read as though two more steps were missing.
  const ordered = PIPELINE_STEPS.map((s) => s.name).filter((n) => gaps.has(n));
  const out = [];
  for (const step of ordered) {
    const p = progressForStep(vols, step);
    out.push({ step, built: formatRanges(p.builtInstallments), missing: formatRanges(p.missingInstallments) });
  }
  return out;
}


/**
 * The plan as Markdown — the file a human reads, and the file the manager writes in `report`
 * mode.
 * @param {ResumePlan} plan
 * @returns {string}
 */
function renderResumePlanMarkdown(plan) {
  const lines = [
    `# Where the run stopped`,
    ``,
    `_${plan.generatedAt} — read from the working state only: the plan of record, what each volume folder holds, the step assessments, the run ledger, and the publish report. No model call._`,
    ``,
    `## ${plan.headline}`,
    ``,
  ];

  const d = plan.deliverable;
  if (d) {
    lines.push(
      `**The deliverable** (${d.generatedAt || "undated"}): ${d.counts.total} chapter(s) — ` +
        `${d.counts.published} published verified, ${d.counts.unverified} unverified, ${d.counts.missing} missing` +
        (d.counts.emptyInSource ? `, ${d.counts.emptyInSource} empty in the source` : "") +
        `.`,
      ``
    );
  } else {
    lines.push(`**The deliverable:** no publish report yet — the translation stage has not produced one.`, ``);
  }

  const progress = progressByStep(plan.volumes);
  if (progress.length) {
    lines.push(`## Where each step reached`);
    lines.push(``);
    for (const p of progress) {
      lines.push(`- **${p.step}** — built for ${p.built || "nothing"}, missing for ${p.missing}`);
    }
    const evidence = (plan.volumes || []).filter((v) => v.quarantines.length);
    if (evidence.length) {
      lines.push(``);
      lines.push(
        `Gate evidence kept (read it, never delete it): ` +
          evidence.map((v) => `volume ${v.installment} ${v.quarantines.map((n) => `\`${n}\``).join(", ")}`).join("; ")
      );
    }
    lines.push(``);
  }

  lines.push(`## The step list`);
  lines.push(``);
  for (const s of plan.steps) {
    const label =
      s.action === "none" ? "leave alone" : s.action === "after" ? "run after" : s.action === "blocked" ? "blocked" : s.action === "ticket" ? "open a ticket" : "run now";
    lines.push(`### ${label}: \`${s.step}\`${s.fromVolume ? ` — from volume ${s.fromVolume}` : ""}`);
    if (s.actionName) {
      const action = actionByName(s.actionName);
      lines.push(
        `- action: **${s.actionName}**${action ? ` (tier ${action.tier}${action.countsAsIntervention ? ", counts against this step's intervention limit" : ", does not count against the intervention limit"})` : ""}`
      );
    }
    for (const r of s.reasons) lines.push(`- ${r}`);
    if (s.escalation) lines.push(`- why this is a question and not a run: **${s.escalation}**`);
    if (s.existingTicket) {
      lines.push(
        `- already asked: ticket **${s.existingTicket.id}** (${s.existingTicket.status}). Work that ticket ` +
          `(\`npm run diagnose -- --ticket=${s.existingTicket.id}\`) rather than writing a second one for the same finding.`
      );
    }
    if (s.flags.length) lines.push(`- flags: ${s.flags.join(" ")}`);
    for (const w of s.wipeFirst) {
      lines.push(`- remove first, in \`${w.volumeDir}\`:`);
      for (const f of w.files) lines.push(`  - ${f}`);
      lines.push(
        w.quarantinesKept && w.quarantinesKept.length
          ? `  - (and nothing else — ${w.quarantinesKept.map((n) => `\`${n}\``).join(", ")} beside them stays)`
          : `  - (and nothing else in that volume folder is touched)`
      );
    }
    lines.push(``);
  }

  if (plan.notes.length) {
    lines.push(`## Notes`);
    for (const n of plan.notes) lines.push(`- ${n}`);
    lines.push(``);
  }

  lines.push(
    `_Choosing where to resume is not an intervention and is not counted. Removing output that already exists is._`
  );
  return lines.join("\n") + "\n";
}


module.exports = {
  formatRanges,
  progressForStep,
  progressByStep,
  renderResumePlanMarkdown,
};

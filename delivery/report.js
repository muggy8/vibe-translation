/**
 * What the manager prints and writes for a human to read before letting it touch anything.
 *
 * Part of the delivery.js layer (split out of the original single file).
 */

require("../types"); // JSDoc type definitions

/**
 * The plan as it should be printed: short, readable, and honest about what it is not.
 * @param {import("./utils/resume").ResumePlan} plan
 * @param {string} mode
 * @returns {string}
 */
function renderConsole(plan, mode) {
  const lines = [];
  lines.push(`[delivery] ${plan.headline}`);
  lines.push(`[delivery] series: ${plan.seriesDir}`);
  for (const s of plan.steps) {
    if (s.action === "none") continue;
    const label =
      s.action === "after" ? "then" : s.action === "blocked" ? "blocked" : s.action === "ticket" ? "ask" : "now";
    lines.push(`[delivery]   ${label.padEnd(6)} ${s.step}${s.fromVolume ? ` (from volume ${s.fromVolume})` : ""}${s.actionName ? ` — ${s.actionName}` : ""}`);
    for (const w of s.wipeFirst) lines.push(`[delivery]          remove first: ${w.files.length} file(s) in ${w.volumeDir}`);
  }
  const untouched = plan.steps.filter((s) => s.action === "none").map((s) => s.step);
  if (untouched.length) lines.push(`[delivery]   leave alone: ${untouched.join(", ")}`);
  for (const n of plan.notes) lines.push(`[delivery] note: ${n}`);
  if (mode === "act") {
    lines.push(
      `[delivery] mode act: this is what will be executed, one step at a time, through the step runner.`
    );
  } else {
    lines.push(`[delivery] mode report: nothing was executed. This is a proposal.`);
  }
  return lines.join("\n");
}


/**
 * What act mode actually did, printed after the fact. The manager's report is not complete
 * until it says what happened, and "I ran it" is not an outcome.
 *
 * @param {Array<Object>} execution
 * @returns {string}
 */
function renderExecution(execution) {
  const lines = ["[delivery] ── what act mode did ──"];
  for (const e of execution) {
    if (e.refused) {
      lines.push(`[delivery]   refused ${e.step} (${e.actionName}): ${e.reason}`);
      if (e.ticket) lines.push(`[delivery]     ticket opened: ${e.ticket}`);
      continue;
    }
    lines.push(
      `[delivery]   ran ${e.step} (${e.actionName}): wiped ${e.wiped} file(s), step exited ${e.code}, ` +
        `${e.progress.before} → ${e.progress.after} volumes built → ${e.outcome}`
    );
    lines.push(`[delivery]     deliverable: ${e.account}`);
    if (e.damage && e.damage.length) {
      lines.push(`[delivery]     damage: ${e.damage.join(", ")} — this action is not a fix, whatever it removed`);
    }
    if (e.note) lines.push(`[delivery]     ${e.note}`);
  }
  return lines.join("\n");
}

// ─── Act mode: the gates ──────────────────────────────────────────────────────


module.exports = {
  renderConsole,
  renderExecution,
};

/**
 * The whole message, built from records this layer already wrote for a human: the triage, the deliverable counts, the remaining per-step attempts, each ticket, each patch, and the offered menu. Nothing else: no file is read, and the only place a source path reaches this role at all is a patch's declared file list.
 *
 * Part of the manager.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions

const { MANAGER_ACTIONS, MANAGER_RULES } = require("./rules");

/**
 * One ticket, rendered for the role that cannot see the code.
 *
 * @param {import("./tickets").Ticket} ticket
 * @returns {string}
 */
function renderTicketForManager(ticket) {
  const lines = [
    `### ${ticket.id} — ${ticket.step}${ticket.volume ? ` volume ${ticket.volume}` : ""} — ${ticket.finding}`,
    `status: ${ticket.status}`,
    `your question: ${ticket.question}`,
  ];
  if (ticket.evidence && ticket.evidence.length) {
    lines.push("what you looked at:");
    // `note` is the field `utils/tickets.js` stores (`TicketEvidence` is `{file, note}`); a renderer
    // that reaches for a field the record does not have prints `undefined` to the one role that has
    // to decide from it.
    for (const e of ticket.evidence) lines.push(`  - ${e.file}: ${e.note || ""}`);
  }
  if (ticket.tried && ticket.tried.length) {
    lines.push("already tried (read out of the ledger, not from memory):");
    for (const t of ticket.tried) lines.push(`  - ${t.action} → ${t.outcome}${t.ledgerId ? ` (${t.ledgerId})` : ""}`);
  }
  if (ticket.ruledOut && ticket.ruledOut.length) {
    lines.push("ruled out:");
    for (const r of ticket.ruledOut) lines.push(`  - ${r}`);
  }

  const diag = ticket.diagnosis;
  if (diag) {
    lines.push("");
    lines.push("**their answer:**");
    lines.push(`cause: ${diag.cause}`);
    if (diag.recommend) lines.push(`they recommend: ${diag.recommend}`);
    if (diag.read && diag.read.length) {
      lines.push(`they say they read: ${diag.read.join(", ")}`);
    }
    if (diag.citedWithoutReading && diag.citedWithoutReading.length) {
      lines.push(
        `note: they named ${diag.citedWithoutReading.join(", ")} as evidence but that turn never opened ` +
          `it — their answer is weaker than it looks.`
      );
    }
    if (diag.attemptedWrites && diag.attemptedWrites.length) {
      lines.push(
        `note: that turn tried ${diag.attemptedWrites.length} write(s) and the read-only gate refused ` +
          `every one (${diag.attemptedWrites.map((w) => w.path).join(", ")}).`
      );
    }
  }

  const waiting = (diag && diag.questions ? diag.questions : []).filter(
    (q) => !((ticket.answers || []).some((a) => String(a.question).trim() === String(q).trim()))
  );
  if (waiting.length) {
    lines.push("");
    lines.push("**waiting on you:**");
    for (const q of waiting) lines.push(`  - ${q}`);
  }

  const options = ticket.options || [];
  if (options.length) {
    lines.push("");
    lines.push("**options you may choose from:**");
    for (const o of options) {
      const flags = [];
      if (o.requiresCodeChange) flags.push("needs the dev team");
      if (o.outcomeOnlyVerification) {
        flags.push('its only stated check is "the finding disappears" — the before/after comparison of the deliverable is what judges it');
      }
      lines.push(`  - ${o.id}: ${o.label}`);
      lines.push(
        `      cost ${o.cost || "?"} · touches ${o.touches ? o.touches.join(", ") : "?"} · risk ${o.risk || "?"}`
      );
      lines.push(`      how to check it worked: ${o.verify || "?"}${flags.length ? ` · ${flags.join(" · ")}` : ""}`);
    }
  }
  if (ticket.noUsableOptions) {
    lines.push("");
    lines.push(
      "**every option they offered was refused by the filter.** What they actually believe is in " +
        "ownerNote, which is written for the account owner and not for you. Your move here is " +
        "`escalate`, not a workaround."
    );
  }
  if (ticket.refusedOptions && ticket.refusedOptions.length) {
    lines.push("");
    lines.push("**options that are NOT on your menu** (kept visible so you know they were considered):");
    for (const r of ticket.refusedOptions) {
      lines.push(`  - ${r.option.label}: ${r.because} Goes to ${r.escalateTo}.`);
    }
  }
  if (ticket.choice) {
    lines.push("");
    lines.push(`you chose ${ticket.choice.optionId}: ${ticket.choice.reason}`);
  }
  return lines.join("\n");
}


/**
 * One patch proposal, rendered for the role that cannot read a diff.
 *
 * @param {import("./patches").Patch} patch
 * @returns {string}
 */
function renderPatchForManager(patch) {
  const lines = [
    `### ${patch.id} (${patch.status}) — answers ${patch.ticketId} option ${patch.optionId} — ${patch.step}` +
      `${patch.volume ? ` volume ${patch.volume}` : ""}`,
    `what changed: ${patch.summary || "(none given)"}`,
    `why it fixes the mechanism: ${patch.why || "(none given)"}`,
    `what it could break: ${patch.couldBreak || "(none given)"}`,
  ];
  if (patch.expected && patch.expected.length) {
    lines.push("what they expect to move in the deliverable:");
    for (const e of patch.expected) lines.push(`  - ${e.signal} ${e.direction}: ${e.why}`);
  }
  if (patch.verify) lines.push(`how to check it: ${patch.verify}`);
  lines.push(`files they say they touched (${(patch.files || []).length}): ${(patch.files || []).join(", ") || "none"}`);
  const verdict = patch.checkVerdict;
  if (verdict && verdict.accepted) {
    lines.push("the pinned checks ran and passed: " + (patch.checks || []).map((c) => `${c.id} exit ${c.exitCode}`).join(", "));
  } else if (verdict) {
    if (verdict.missing.length) lines.push(`checks that NEVER RAN: ${verdict.missing.join(", ")}`);
    if (verdict.failed.length) lines.push(`checks that FAILED: ${verdict.failed.join(", ")}`);
  } else {
    lines.push("the pinned checks have never run on this patch.");
  }
  if (patch.warnings && patch.warnings.length) {
    for (const w of patch.warnings) lines.push(`note: ${w.message || w.kind}`);
  }
  if (patch.refusedWrites && patch.refusedWrites.length) {
    lines.push(
      `note: that team tried ${patch.refusedWrites.length} write(s) the boundary refused ` +
        `(${patch.refusedWrites.map((w) => `${w.path}: ${w.reason}`).join("; ")}).`
    );
  }
  if (patch.refusedAttempts && patch.refusedAttempts.length) {
    lines.push(`note: this is attempt ${patch.refusedAttempts.length + 1}. Earlier attempts were refused for:`);
    for (const a of patch.refusedAttempts) {
      for (const p of a.problems || []) lines.push(`  - ${p.message}`);
    }
  }
  if (patch.ownerNote) {
    lines.push(`**ownerNote (written for the account owner, not for you):** ${patch.ownerNote}`);
  }
  if (patch.decision) {
    lines.push(`your decision: ${patch.decision.outcome} — ${patch.decision.reason}`);
  }
  return lines.join("\n");
}


/**
 * The whole brief for one decision.
 *
 * Bounded by construction: every section here is a record this layer already wrote for a human
 * reader. Nothing is read from the disk, and nothing that matches `customerMayRead`'s refusals
 * (.logs/, a .js, a prompt, hooks/, utils/) appears in it — the one exception is a patch's declared
 * file list, which is the change the manager is being asked to judge and is the only place a file
 * name reaches this role at all.
 *
 * @param {Object} args
 * @param {import("./resume").ResumePlan} args.plan - The triage, as `planResume` wrote it.
 * @param {ManagerMove[]} args.moves - The offered menu.
 * @param {import("./tickets").Ticket[]} [args.tickets] - The open tickets.
 * @param {import("./patches").Patch[]} [args.patches] - The patches waiting for a judgment.
 * @returns {string}
 */
function renderManagerBrief({ plan, moves, tickets = [], patches = [] }) {
  const out = [MANAGER_RULES, "", "---", ""];

  out.push(`## The question`);
  out.push(
    `A run against "${plan.seriesDir}" has been assessed. You have not read the code and you are not ` +
      `going to. Choose the next move from the list at the end of this message.`
  );
  out.push("");

  out.push(`## What the triage says`);
  out.push(`verdict: ${plan.verdict}`);
  out.push(plan.headline);
  for (const step of plan.steps || []) {
    const bits = [step.actionName || step.action];
    if (step.fromVolume) bits.push(`from volume ${step.fromVolume}`);
    if (step.cascade) bits.push("cascade");
    if (step.countsAsIntervention) bits.push("counts as an intervention");
    out.push(`- ${step.step}: ${bits.join(", ")}`);
    for (const r of step.reasons || []) out.push(`    ${r}`);
  }
  if (plan.notes && plan.notes.length) {
    out.push("");
    out.push("notes that are not actions:");
    for (const n of plan.notes) out.push(`- ${n}`);
  }
  if (plan.recurring && plan.recurring.length) {
    out.push("");
    out.push("findings that survived an earlier recorded run (structural, not transient):");
    for (const r of plan.recurring) {
      out.push(`- ${r.finding} in ${r.runs} run(s)${r.steps.length ? ` (${r.steps.join(", ")})` : ""}`);
    }
  }
  out.push("");

  const d = plan.deliverable;
  out.push(`## The deliverable (what the pipeline actually published)`);
  if (!d) {
    out.push("There is no publish report yet. That means the translation stage has not produced a book, " +
      "not that the book is fine.");
  } else {
    const c = d.counts || {};
    out.push(
      `${c.published || 0} published · ${c.unverified || 0} unverified · ${c.missing || 0} missing · ` +
        `${c.emptyInSource || 0} empty in the source (a hole in the book, not in the run) · ` +
        `of ${c.total || 0} chapters`
    );
    if (typeof c.scoreMedian === "number") out.push(`median verification score: ${c.scoreMedian}`);
    if (c.crossChapterHigh) out.push(`cross-chapter HIGH findings: ${c.crossChapterHigh}`);
    if (c.variantConflicts) out.push(`rendering-variant conflicts: ${c.variantConflicts}`);
  }
  out.push("");

  const budget = plan.interventionBudget;
  const spent = plan.interventionsByStep || {};
  if (Object.keys(spent).length) {
    out.push(`## Your remaining attempts on each step (budget ${budget} per step)`);
    for (const [step, used] of Object.entries(spent)) {
      out.push(`- ${step}: ${used} used, ${Math.max(0, budget - used)} left`);
    }
    out.push("");
  }

  if (tickets.length) {
    out.push(`## Tickets open with the support teams`);
    for (const t of tickets) out.push(renderTicketForManager(t), "");
  }

  if (patches.length) {
    out.push(`## Patches waiting for your judgment`);
    out.push(
      `These are already in the working tree. Until you judge them, the pipeline cannot be run: it ` +
        `would be running code nobody accepted.`
    );
    out.push("");
    for (const p of patches) out.push(renderPatchForManager(p), "");
  }

  out.push(`## The moves available to you right now`);
  if (!moves.length) {
    out.push(
      `None. Nothing on this state is executable for you, which means the correct answer is ` +
        `"escalate" with what the account owner has to decide.`
    );
  }
  for (const m of moves) out.push(`- ${m.label}`);
  out.push("");

  out.push(`## Answer as`);
  out.push("```json");
  out.push(
    JSON.stringify(
      {
        action: "one of: " + MANAGER_ACTIONS.map((a) => a.name).join(" | "),
        reason: "why this move, now, in one or two sentences",
        step: "for run: the step exactly as offered",
        ticket: "for diagnose / answer / choose / fix: the ticket id",
        answer: "for answer: your reply to their question",
        question: "for answer: which question, quoted from the ticket (say it when the ticket has more than one open)",
        option: "for choose: the option id",
        patch: "for judge: the patch id",
        outcome: "for judge: accept or reject",
        note: "for escalate: what the account owner must decide",
      },
      null,
      2
    )
  );
  out.push("```");
  out.push("Only the fields your action needs. Nothing after the block.");
  return out.join("\n");
}

// ─── The reply: fail-closed parse ─────────────────────────────────────────────


module.exports = {
  renderTicketForManager,
  renderPatchForManager,
  renderManagerBrief,
};

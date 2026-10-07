/**
 * tickets.md — the version a human and the diagnostics team read, including the options the filter refused and the layer that stopped each write attempt.
 *
 * Part of the tickets.js layer (split out of the original single file).
 */

const path = require("path");

/**
 * One ticket as Markdown.
 * @param {Ticket} ticket
 * @returns {string}
 */
function renderTicketMarkdown(ticket) {
  const lines = [
    `### ${ticket.id} — ${ticket.step}${ticket.volume ? ` volume ${ticket.volume}` : ""} — ${ticket.finding}`,
    `Status: ${ticket.status}${ticket.closure ? ` — closed ${ticket.closure.outcome}` : ""}`,
    ``,
    `**Asked:** ${ticket.question}`,
    ``,
    `**What was seen:**`,
    ...(ticket.evidence || []).map((e) => `- \`${e.file}\` — ${e.note}`),
  ];
  if ((ticket.tried || []).length) {
    lines.push(``, `**Already tried (from the ledger):**`);
    for (const t of ticket.tried) lines.push(`- ${t.action} → ${t.outcome || "no outcome recorded"}${t.ledgerId ? ` (${t.ledgerId})` : ""}`);
  }
  if ((ticket.ruledOut || []).length) {
    lines.push(``, `**Ruled out:**`);
    for (const r of ticket.ruledOut) lines.push(`- ${r}`);
  }
  const d = ticket.diagnosis;
  if (d) {
    lines.push(``, `**Diagnosis** (from the diagnostics team, attempt ${d.attempts || 1}):`, d.cause);
    if (d.recommend) lines.push(``, `**Recommended:** ${d.recommend}`);
    if ((d.questions || []).length) {
      lines.push(``, `**Asked back of the manager:**`);
      for (const q of d.questions) lines.push(`- ${q}`);
    }
    if ((ticket.answers || []).length) {
      lines.push(``, `**The manager answered:**`);
      for (const a of ticket.answers) {
        lines.push(
          `- Q: ${a.question}\n  A: ${a.answer}` + (a.cites && a.cites.length ? `\n  citing: ${a.cites.map((c) => `\`${c}\``).join(", ")}` : "")
        );
      }
    }
    if (d.ownerNote) {
      lines.push(
        ``,
        `**For the account owner only** (not an option the manager may be offered):`,
        d.ownerNote
      );
    }
    if ((d.read || []).length) {
      lines.push(``, `**It says it read:** ${d.read.map((r) => `\`${r}\``).join(", ")}`);
    }
    if ((d.observedReads || []).length) {
      lines.push(``, `**What its turn actually opened:**`);
      for (const r of d.observedReads) lines.push(`- ${r.tool} → \`${r.path}\``);
    }
    if ((d.citedWithoutReading || []).length) {
      lines.push(
        ``,
        `**Cited but never opened by that turn** (a conclusion with no file behind it): ` +
          d.citedWithoutReading.map((r) => `\`${r}\``).join(", ")
      );
    }
    if ((d.attemptedWrites || []).length) {
      lines.push(``, `**Write attempts the read-only role refused:**`);
      for (const w of d.attemptedWrites) {
        const layer = w.layer ? ` (stopped by ${w.layer})` : "";
        lines.push(`- \`${w.tool}\` on \`${w.path}\`${layer} — ${w.reason}`);
      }
    }
    if (d.turnShape) {
      const s = d.turnShape;
      const aside =
        s.offloads > 0
          ? `, ${s.offloads} read answer(s) set aside on disk (${s.offloadedTokens} tokens) it could read back`
          : "";
      lines.push(
        ``,
        `**How that turn ran** (no step cap — this role is uncapped): ${s.toolCalls} tool call(s) ` +
          `over ${s.chunks} chunk(s)${aside}; it ended: ${s.endedAs || "not recorded"}.`
      );
    }
  }
  if (ticket.noUsableOptions) {
    lines.push(
      ``,
      `**No usable option.** Every option the diagnostics team offered was refused by the banned-option ` +
        `filter. What it believes the right answer is appears under "For the account owner only" above; ` +
        `that is the role this decision belongs to.`
    );
  }
  if ((ticket.options || []).length) {
    lines.push(``, `**Options offered:**`);
    for (const o of ticket.options) {
      lines.push(
        `- **${o.label}** (${o.cost || "cost not stated"}${o.requiresCodeChange ? ", needs a code change" : ""})` +
          (o.touches && o.touches.length ? `\n  - touches: ${o.touches.join(", ")}` : "") +
          (o.risk ? `\n  - could break: ${o.risk}` : "") +
          (o.verify ? `\n  - how to verify: ${o.verify}` : "") +
          (o.outcomeOnlyVerification
            ? `\n  - ⚠ its only stated check is that the finding disappears. That is available for free ` +
              `by switching a check off, so it is not evidence: the before/after comparison of the ` +
              `deliverable (utils/delivery-verify.js) is what will judge it.`
            : "")
      );
    }
  }
  if ((ticket.refusedOptions || []).length) {
    lines.push(``, `**Options refused by the banned-option filter (not offered to the manager):**`);
    for (const r of ticket.refusedOptions) {
      lines.push(`- ~~${r.option.label}~~ — ${r.because}\n  - goes to: ${r.escalateTo}`);
    }
  }
  if (ticket.choice) {
    lines.push(
      ``,
      `**Chosen:** ${ticket.choice.optionId} by ${ticket.choice.decidedBy} — ${ticket.choice.reason}`
    );
  }
  if (ticket.closure) {
    lines.push(``, `**Outcome:** ${ticket.closure.outcome}${ticket.closure.note ? ` — ${ticket.closure.note}` : ""}`);
  }
  return lines.join("\n") + "\n";
}


/**
 * Every ticket as Markdown, newest last — the file a human reads.
 *
 * The list is REQUIRED here on purpose. A renderer that reads the channel when nobody hands it
 * one is how `writeTickets` (which renders exactly what it was just given) and the renderer end
 * up importing each other, and a cycle between the file and its own report is the kind of thing
 * a split is supposed to make visible. "No list means the one on disk" is supplied by the public
 * face (`utils/tickets.js`), which is where a caller looks for it.
 *
 * @param {Ticket[]} tickets
 * @returns {string}
 */
function renderTicketsMarkdown(tickets) {
  const open = tickets.filter((t) => t.status !== "closed");
  const closed = tickets.filter((t) => t.status === "closed");
  const header = [
    `# Tickets`,
    ``,
    `_The delivery manager's questions to the teams that can see the code. Written ${new Date().toISOString()}.`,
    `A ticket asks a question; it never states the result it wants. Options that would remove a`,
    `finding without changing the deliverable are refused here and named, not dropped._`,
    ``,
    `Open: ${open.length} | closed: ${closed.length}`,
    ``,
  ];
  if (!tickets.length) return header.join("\n") + "No tickets. Nothing has needed asking yet.\n";
  return header.join("\n") + tickets.map(renderTicketMarkdown).join("\n---\n\n");
}


module.exports = {
  renderTicketMarkdown,
  renderTicketsMarkdown,
};

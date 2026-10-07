/**
 * What a human reads afterwards, including which layer stopped each refused write.
 *
 * Part of the diagnostics.js layer (split out of the original single file).
 */

const path = require("path");

/**
 * One answered ticket as Markdown — the half a human reads.
 * @param {import("./tickets").Ticket} ticket
 * @returns {string}
 */
function renderDiagnosisMarkdown(ticket) {
  const d = ticket && ticket.diagnosis;
  if (!d) return "";
  const lines = [`**Diagnosis** (by the diagnostics team, attempt ${d.attempts || 1}):`, ``, d.cause];
  if (d.recommend) lines.push(``, `**Recommended:** ${d.recommend}`);
  if ((d.questions || []).length) {
    lines.push(``, `**Questions back to the manager:**`);
    for (const q of d.questions) lines.push(`- ${q}`);
  }
  if (d.ownerNote) {
    lines.push(``, `**For the account owner only** (not an option the manager may be offered):`, d.ownerNote);
  }
  if ((d.read || []).length) lines.push(``, `**Files it says it read:** ${d.read.map((r) => `\`${r}\``).join(", ")}`);
  if ((d.citedWithoutReading || []).length) {
    lines.push(``, `**Cited but never opened by that turn:** ${d.citedWithoutReading.map((r) => `\`${r}\``).join(", ")}`);
  }
  if ((d.attemptedWrites || []).length) {
    lines.push(``, `**Write attempts refused by the read-only role:**`);
    for (const w of d.attemptedWrites) {
      const layer = w.layer ? ` (stopped by ${w.layer})` : "";
      lines.push(`- \`${w.tool}\` on \`${w.path}\`${layer} — ${w.reason}`);
    }
  }
  return lines.join("\n");
}


module.exports = {
  renderDiagnosisMarkdown,
};

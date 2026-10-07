/**
 * Loading the system prompt and rendering the ticket for the team that has to answer it.
 *
 * Part of the diagnostics.js layer (split out of the original single file).
 */

const fs = require("fs");
const path = require("path");
const tickets = require("../tickets");
const { readTickets, ticketPaths, recordDiagnosis } = tickets;

const { SYSTEM_PROMPT_FILE } = require("./contract");

/**
 * Read the system prompt for the role. Fails loudly rather than diagnosing with no brief: a support
 * team with no instructions answers with a guess.
 * @returns {string}
 */
function loadSystemPrompt() {
  let text;
  try {
    text = fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8");
  } catch (err) {
    throw new Error(
      `diagnostics: cannot read ${SYSTEM_PROMPT_FILE} (${err.code || err.message}). ` +
        `The diagnostics role's brief is not optional.`
    );
  }
  if (!text.trim()) throw new Error(`diagnostics: ${SYSTEM_PROMPT_FILE} is empty.`);
  return text;
}


/**
 * The turn's input: the ticket, and nothing else.
 *
 * The evidence is named by path, not inlined. This role's whole advantage over the manager is that
 * it can open those files itself; inlining them would pay for a copy of something it is about to
 * read anyway, and would quietly replace "it read the evidence" with "it was told about it".
 *
 * @param {import("./tickets").Ticket} ticket
 * @param {{seriesDir: string, root: string}} where
 * @returns {string}
 */
function renderTicketForDiagnosis(ticket, { seriesDir, root }) {
  const lines = [
    `## Ticket ${ticket.id}`,
    ``,
    `Step: ${ticket.step}${ticket.volume ? ` | volume: ${ticket.volume}` : ""} | finding: ${ticket.finding}`,
    ``,
    `**The question being asked:**`,
    ticket.question,
    ``,
    `**What the manager saw** (it reads reports and deliverables, never code):`,
    ...(ticket.evidence || []).map((e) => `- \`${e.file}\` — ${e.note}`),
  ];
  if ((ticket.tried || []).length) {
    lines.push(``, `**What has already been tried** (copied out of the run ledger, so it is a record, not a claim):`);
    for (const t of ticket.tried) {
      lines.push(`- ${t.action}${t.volume ? ` (volume ${t.volume})` : ""} → ${t.outcome || "no outcome recorded"}${t.ledgerId ? ` (${t.ledgerId})` : ""}`);
    }
  }
  if ((ticket.ruledOut || []).length) {
    lines.push(``, `**What the manager ruled out:**`);
    for (const r of ticket.ruledOut) lines.push(`- ${r}`);
  }

  lines.push(
    ``,
    `**Where to look:**`,
    `- the series folder: \`${seriesDir}\``,
    `- the step reports and the run ledger: \`${path.relative(root, ticketPaths().json).replace(/[\\/]+$/, "")}\`'s folder`,
    `- the run transcripts (full chat histories, tool calls and their results, streaming dumps): \`.logs/\``,
    `- the code and the prompts: \`ai-client/\` (this project's root is \`${root}\`)`,
    ``,
    `Answer with the JSON object described in your brief. Every option must name what it touches,`,
    `what it costs, what it could break, and how the manager should verify it afterwards.`,
    `The manager cannot read code, prompts or transcripts — so anything you want it to check must be`,
    `something it can see: a folder listing, a term count, a report, the published text.`
  );
  return lines.join("\n");
}


module.exports = {
  loadSystemPrompt,
  renderTicketForDiagnosis,
};

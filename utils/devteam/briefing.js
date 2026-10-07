/**
 * utils/devteam/briefing.js — the ticket as the team reads it, and the footprint of evidence it must not break.
 *
 * `renderTicketForDev` is written for a reader who has the code but not the conversation: the finding,
 * the diagnosis, the option the manager chose, and the boundary. `evidenceFootprint` is the list of
 * files the run's own evidence occupies, so a patch that would overwrite a log or a report is
 * visible before it is written.
 */

const fs = require("fs");
const path = require("path");

const projectRoot = path.join(__dirname, "../.."); // devteam.js's ROOT

/**
 * The ticket, the chosen option and the diagnosis it came from, as the dev team's brief.
 *
 * It is handed the code access the manager does not have, so this text is about the DECISION: what
 * was found, what was already tried, which option was chosen and what that option promised. The team
 * is not told what to write — it is told what was agreed.
 *
 * `root` is the folder the turn is actually about to edit, and the brief names it. A brief that named
 * this module's own folder while the turn ran somewhere else would send the team to write in a tree the
 * machine is not fingerprinting.
 *
 * @param {Object} ticket
 * @param {Object} patch
 * @param {Object} option
 * @param {string} seriesDir
 * @param {string} [root]
 * @returns {string}
 */
function renderTicketForDev({ ticket, patch, option, seriesDir, root = projectRoot }) {
  const d = ticket.diagnosis || {};
  const lines = [
    `## Ticket ${ticket.id} — ${ticket.step}${ticket.volume ? ` volume ${ticket.volume}` : ""}`,
    ``,
    `Finding: \`${ticket.finding}\``,
    ``,
    `### What the diagnostics team found`,
    d.cause || "*(no cause recorded)*",
    ``,
    `### The option the manager chose (${option.id})`,
    `**${option.label}**`,
    `- it touches: ${(option.touches || []).join(", ") || "not stated"}`,
    `- its cost: ${option.cost || "not stated"}`,
    `- its risk: ${option.risk || "not stated"}`,
    `- how the manager will check it: ${option.verify || "not stated"}`,
    ``,
    `**Why the manager chose it:** ${patch.chosenReason || ticket.choice.reason}`,
    ``,
    `### What the run already tried`,
    ...((ticket.tried || []).length
      ? ticket.tried.map((t) => `- ${t.action}${t.volume ? ` (volume ${t.volume})` : ""} → ${t.outcome} [${t.ledgerEntry || "no ledger id"}]`)
      : ["- *(nothing recorded)*"]),
    ``,
    `### What was ruled out`,
    ...((ticket.ruledOut || []).length ? ticket.ruledOut.map((r) => `- ${r}`) : ["- *(nothing recorded)*"]),
    ``,
    `### The question the manager asked`,
    ticket.question,
    ``,
    `### The evidence, at the paths the triage named them`,
    ...((ticket.evidence || []).length
      ? ticket.evidence.map((e) => `- \`${e.file}\` — ${e.note}`)
      : ["- *(none recorded)*"]),
    ``,
    `The series folder is \`${seriesDir}\`. The project root (where the code you may change lives) is`,
    `\`${root}\`. A volume folder's own artifacts are generated output: read them, do not edit them.`,
    ``,
    `Change the mechanism. Then report what you changed, why, what it could break, and what the`,
    `manager should look at afterwards to know it worked.`,
  ];
  return lines.join("\n");
}

/**
 * Total size of the files a ticket points at. The same rule and the same shape as `evidenceFootprint`
 * in utils/diagnostics.js, so the two roles size the same ticket the same way — but the number is no
 * longer a step cap: it is printed so a reader can see how much the turn was pointed at, and it is the
 * thing the working window has to absorb (gotcha 64: a turn that cannot hold what it was pointed at
 * throws away paid-for work; the fix is to set the old read answers aside, not to count steps).
 *
 * @param {Object} ticket
 * @param {string[]} [extraFiles]
 * @param {string} [seriesDir]
 * @param {string} [root]
 * @returns {Promise<{bytes: number, files: string[]}>}
 */
async function evidenceFootprint(ticket, extraFiles = [], seriesDir = "", root = projectRoot) {
  const candidates = [...(ticket.evidence || []).map((e) => e.file), ...extraFiles];
  const bases = [root, seriesDir, ticket.seriesDir || ""].filter(Boolean);
  let bytes = 0;
  const files = [];
  for (const raw of candidates) {
    for (const base of bases) {
      const abs = path.isAbsolute(raw) ? raw : path.join(base, raw);
      try {
        const stat = await fs.promises.stat(abs);
        if (stat.isFile()) {
          bytes += stat.size;
          files.push(abs);
          break;
        }
      } catch {
        /* a missing file is not a size, and inventing one would inflate the cap */
      }
    }
  }
  return { bytes, files };
}

module.exports = { renderTicketForDev, evidenceFootprint };

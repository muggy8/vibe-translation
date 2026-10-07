/**
 * Whether the channel is open, and where its two files live.
 *
 * Part of the tickets.js layer (split out of the original single file).
 */

const path = require("path");
const { postMortemDir } = require("../postmortem");
const { readBoolEnv } = require("../../configs/shared");

/**
 * @returns {boolean} Whether tickets are written (TICKETS_ENABLED, default on).
 */
function ticketsEnabled() {
  return readBoolEnv("TICKETS_ENABLED", true);
}


/**
 * Where tickets live: beside the post-mortem reports and the ledger, because a ticket is the
 * same kind of thing — machine state describing a decision, gitignored like `.logs/`.
 * @returns {{json: string, markdown: string}}
 */
function ticketPaths() {
  const dir = postMortemDir();
  return { json: path.join(dir, "tickets.json"), markdown: path.join(dir, "tickets.md") };
}

// ─── The banned list ──────────────────────────────────────────────────────────


module.exports = {
  ticketsEnabled,
  ticketPaths,
};

#!/usr/bin/env node
/**
 * diagnose.js — ask the diagnostics team one ticket.
 *
 * This is the other side of `npm run delivery`. The delivery manager reads reports and
 * deliverables and never reads the code; when re-running stops working it opens a ticket
 * (`utils/tickets.js`). This command hands that ticket to the role that CAN read the code, the
 * prompts and the run transcripts, and writes the answer back onto the ticket.
 *
 * The analogy the account owner chose: the manager is a customer on a support contract, and this
 * is the support team being handed the ticket. A support team reads its own logs, explains the
 * cause, offers options with their costs and risks, recommends one, and asks the customer
 * clarifying questions back.
 *
 * What this command guarantees, in code rather than in a prompt:
 *
 *   - The agent is handed **three read tools and nothing else**, and its approve gate refuses every
 *     mutating call anyway — and records each refusal, so a write attempt reaches the ticket and
 *     the human-readable report rather than vanishing (AGENTS.md gotcha 8's two-layer pattern).
 *   - The options go through the banned-option filter on the way in (`recordDiagnosis` →
 *     `attachOptions`), so no path from a model reply to a ticket skips it (gotcha 70).
 *   - The turn's real tool calls are recorded next to the files the reply *claims* it read, and a
 *     claim the turn never made is reported.
 *   - The files the ticket points at are hashed before and after the turn. This role has no write
 *     access; if the state moved anyway, something else is writing, and the diagnosis is a snapshot
 *     of a moving state.
 *
 * It is read-only, so unlike `delivery.js --mode=act` it does not refuse to start when a run is in
 * progress — reading a run while it happens is legitimate, and often the only way to catch what a
 * finished run's reports do not say. It does warn, because a diagnosis of a folder that is still
 * being written describes a state that will not be there tomorrow.
 *
 * Usage:
 *   node diagnose.js --open                       # list the tickets waiting for an answer
 *   node diagnose.js --ticket=<id>                # ask the team that one ticket
 *   node diagnose.js --ticket=<id> --reask        # ask again (after the manager answered, say)
 *   node diagnose.js --ticket=<id> --answer="…" [--question="…"]   # the manager's reply to a question
 *   node diagnose.js --ticket=<id> --json         # also print the machine-readable answer
 *   node diagnose.js --series=<dir>               # the series the ticket is about (default SERIES_LOCATION)
 *
 * Exit codes: 0 answered, 1 could not answer (no ticket / no model / a reply that does not meet
 * the contract), 2 the request itself was refused (an unknown flag, a re-ask that was not asked
 * for, an answer citing something the manager may not read).
 *
 * See docs/delivery-layer.md.
 */

require("./types"); // JSDoc type definitions

const {
  diagnoseTicket,
  renderDiagnosisMarkdown,
  diagnosisIsAskable,
  READ_TOOL_NAMES,
} = require("./utils/diagnostics");
const {
  readTickets,
  openTickets,
  ticketPaths,
  recordAnswer,
  unansweredQuestions,
} = require("./utils/tickets");
const { runInProgress, describeRunLock } = require("./utils/runlock");

/**
 * Read the CLI flags this command owns. Unknown flags are refused: a mistyped flag on a tool that
 * spends a model call should fail, not be ignored.
 *
 * @param {string[]} argv
 * @returns {{ticketId: string|null, list: boolean, reask: boolean, json: boolean, seriesDir: string|null,
 *   answer: string|null, question: string|null, error: string|null}}
 */
function readArgs(argv) {
  const out = {
    ticketId: null,
    list: false,
    reask: false,
    json: false,
    seriesDir: null,
    answer: null,
    question: null,
    error: null,
  };
  for (const arg of argv) {
    if (arg === "--open" || arg === "--list") out.list = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--reask") out.reask = true;
    else if (arg.startsWith("--ticket=")) out.ticketId = arg.slice("--ticket=".length).trim();
    else if (arg.startsWith("--series=")) out.seriesDir = arg.slice("--series=".length).trim();
    else if (arg.startsWith("--answer=")) out.answer = arg.slice("--answer=".length);
    else if (arg.startsWith("--question=")) out.question = arg.slice("--question=".length);
    else {
      out.error =
        `unknown flag "${arg}". Known flags: --ticket=<id>, --open, --reask, --answer="<text>", ` +
        `--question="<text>", --series=<dir>, --json`;
      break;
    }
  }
  return out;
}

/**
 * The tickets that are waiting, as a human reads them.
 * @returns {number} exit code
 */
function listOpenTickets() {
  const store = readTickets();
  const open = openTickets();
  console.log(`Tickets in ${ticketPaths().json}`);
  if (store.error) console.log(`  ⚠ ${store.error}`);
  if (!open.length) {
    console.log("Nothing is waiting for an answer. `npm run delivery` says why (no ticket has been opened).");
    return 0;
  }
  console.log(`${open.length} waiting:\n`);
  for (const t of open) {
    const asked = unansweredQuestions(t);
    console.log(`  ${t.id}  ${t.step}${t.volume ? ` volume ${t.volume}` : ""}  ${t.finding}  [${t.status}]`);
    console.log(`     asks: ${t.question}`);
    if (t.diagnosis) {
      console.log(`     already answered (attempt ${t.diagnosis.attempts || 1}) — use --reask to ask again`);
      if (t.noUsableOptions) console.log(`     no usable option survived the banned-option filter`);
    }
    if (asked.length) {
      console.log(`     waiting on the manager:`);
      for (const q of asked) console.log(`       - ${q}`);
    }
    console.log("");
  }
  console.log(`Ask one:  node diagnose.js --ticket=<id>`);
  console.log(`Answer one:  node diagnose.js --ticket=<id> --answer="<what the manager can see>"`);
  return 0;
}

/**
 * `--answer`: the manager replying to a question the diagnostics team asked.
 *
 * No model call — this is the customer answering, and the check is on what the answer cites.
 *
 * @param {Object} args - The parsed CLI flags.
 * @param {Object} ticket - The ticket being answered.
 * @returns {number} The exit code.
 */
function answerQuestion(args, ticket) {
  const asked = unansweredQuestions(ticket);
  if (!asked.length) {
    console.error(
      `ticket ${args.ticketId} has no unanswered question to reply to.` +
        (ticket.diagnosis
          ? ` Its questions are all answered, or it asked none.`
          : ` It has not been diagnosed yet — run: node diagnose.js --ticket=${args.ticketId}`)
    );
    return 2;
  }
  // One question answered without being named; more than one must be named, or the answer lands on
  // the wrong question and the ticket records something the manager never said.
  const question = args.question === null ? (asked.length === 1 ? asked[0] : null) : args.question;
  if (question === null) {
    console.error(
      `this ticket has more than one unanswered question, so say which one you are answering:\n` +
        asked.map((q) => `  - ${q}`).join("\n") +
        `\n\n  node diagnose.js --ticket=${args.ticketId} --question="<that question>" --answer="<your answer>"`
    );
    return 2;
  }
  const cites = [];
  const result = recordAnswer(args.ticketId, { question, answer: args.answer, cites });
  if (result.error) {
    console.error(result.error);
    return 2;
  }
  console.log(`Answered on ${args.ticketId}:`);
  console.log(`  Q: ${question}`);
  console.log(`  A: ${args.answer.trim()}`);
  console.log(`\nWritten to ${ticketPaths().markdown}`);
  console.log(`Re-ask the team with the new information: node diagnose.js --ticket=${args.ticketId} --reask`);
  return 0;
}

/**
 * An answer that did not meet the contract: what failed, what the turn claimed, and what the
 * read-only gate stopped.
 *
 * @param {Object} result - The reply from `diagnoseTicket`.
 * @returns {void}
 */
function printFailedDiagnosis(result) {
  console.error(`\n${result.error}`);
  for (const p of result.problems) console.error(`  - ${p.message}`);
  for (const w of result.warnings) console.error(`  note: ${w.message}`);
  if (result.writeAttempts.length) {
    console.error(`  the read-only gate refused ${result.writeAttempts.length} write attempt(s) during that turn.`);
  }
  console.error(`\nNothing was written to the ticket.`);
}

/**
 * The diagnosis as the manager has to read it: the answer, the menu the banned-option filter left,
 * what the filter refused and where it goes instead, the notes on the answer, what the read-only gate
 * stopped, and what is still waiting on the manager.
 *
 * @param {Object} result - The reply from `diagnoseTicket`.
 * @param {Object} args - The parsed CLI flags.
 * @returns {void}
 */
function printDiagnosis(result, args) {
  const ticket = result.ticket;
  console.log(`\n${renderDiagnosisMarkdown(ticket)}\n`);

  if (result.allowed.length) {
    console.log(`**Options the manager may choose from:**`);
    for (const o of result.allowed) {
      console.log(`  ${o.id}  ${o.label}  (${o.cost}${o.requiresCodeChange ? ", needs a code change" : ""})`);
      console.log(`        touches: ${o.touches.join(", ")}`);
      console.log(`        could break: ${o.risk}`);
      console.log(`        verify: ${o.verify}${o.outcomeOnlyVerification ? "   ⚠ names only the finding disappearing" : ""}`);
    }
  }
  if (result.refusedOptions.length) {
    console.log(`\n**Options refused by the banned-option filter** (kept on the ticket, not offered):`);
    for (const r of result.refusedOptions) {
      console.log(`  ~~${r.option.label}~~ — ${r.because}`);
      console.log(`     goes to: ${r.escalateTo}`);
    }
  }
  if (result.warnings.length) {
    console.log(`\n**Notes on the answer:**`);
    for (const w of result.warnings) console.log(`  - ${w.message}`);
  }
  if (result.writeAttempts.length) {
    console.log(`\n**Write attempts the read-only gate refused:**`);
    for (const w of result.writeAttempts) console.log(`  ${w.tool} on ${w.path} — refused`);
  }
  if (unansweredQuestions(ticket).length) {
    console.log(`\n**Waiting on the manager:**`);
    for (const q of unansweredQuestions(ticket)) console.log(`  - ${q}`);
    console.log(`\n  node diagnose.js --ticket=${ticket.id} --answer="<what you can see>"`);
  }
  if (ticket.noUsableOptions) {
    console.log(
      `\nNo usable option: every option the team offered was refused. The decision is the account ` +
        `owner's, and what the team believes is right is in its note above.`
    );
  }
  if (result.usage) {
    console.log(`\n(that turn used ${result.usage.inputTokens ?? "?"} in / ${result.usage.outputTokens ?? "?"} out tokens)`);
  }

  if (args.json) console.log(`\n${JSON.stringify(ticket, null, 2)}`);
  console.log(`\nWritten to ${ticketPaths().markdown}`);
}

/**
 * The CLI's whole shape: refuse the request that cannot be honoured, answer the manager's own reply,
 * then ask the team — but only if asking is legitimate, and only after deciding that on purpose.
 *
 * @returns {Promise<number>} The exit code.
 */
async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    return 2;
  }
  if (args.list) return listOpenTickets();
  if (!args.ticketId) {
    console.error(
      `Nothing to do. Give a ticket: node diagnose.js --ticket=<id>\n` +
        `Or list the ones that are waiting: node diagnose.js --open`
    );
    return 2;
  }

  const seriesDir = args.seriesDir || process.env.SERIES_LOCATION || null;
  if (!seriesDir) {
    console.error(
      `I need to know which series this ticket is about. Pass --series=<dir> or set SERIES_LOCATION.`
    );
    return 2;
  }

  // The manager's reply to a question the diagnostics team asked. No model call: this is the customer
  // answering, and the check is on what the answer cites.
  if (args.answer !== null) {
    const ticket = readTickets().tickets.find((t) => t.id === args.ticketId);
    if (!ticket) {
      console.error(`no ticket ${args.ticketId}. See: node diagnose.js --open`);
      return 1;
    }
    return answerQuestion(args, ticket);
  }

  // Is this askable at all? Asked BEFORE a model container is switched in, because on this machine a
  // switch means loading a model (gotcha 22) and "already answered" is the common case in a loop that
  // re-reads the state every iteration. `diagnoseTicket` asks the same question internally, so the
  // CLI's decision and the module's refusal cannot drift.
  const ticketsFile = ticketPaths();
  const askable = diagnosisIsAskable(
    readTickets(ticketsFile.json).tickets.find((t) => t.id === args.ticketId),
    { ticketId: args.ticketId, reask: args.reask, jsonPath: ticketsFile.json }
  );
  if (!askable.askable) {
    console.error(`\nRefused: ${askable.error}`);
    return 2;
  }

  // Read-only, so a live run does not block this — but it changes what the answer means.
  const running = runInProgress();
  if (running.inProgress) {
    console.log(
      `note: a run is in progress (${describeRunLock(running.lock) || running.note}). ` +
        `This role only reads, so it will run — but the state it is reading is still moving, ` +
        `and the diagnosis describes a snapshot.`
    );
  }

  console.log(`Asking the diagnostics team about ${args.ticketId} (${READ_TOOL_NAMES.join(" / ")} only, no write access)…`);
  // The `pre-manager` / `post-manager` hooks fire INSIDE `diagnoseTicket`, around the agent turn, not
  // here: this CLI cannot know whether the module is about to reach the model without repeating every
  // refusal the module makes, and a container switch costs a model load (gotcha 22). The guarantee
  // belongs to the role that makes the call.
  const result = await diagnoseTicket({
    ticketId: args.ticketId,
    seriesDir,
    reask: args.reask,
  });

  if (result.refused) {
    console.error(`\nRefused: ${result.error}`);
    return 2;
  }
  if (!result.ok) {
    printFailedDiagnosis(result);
    return 1;
  }

  printDiagnosis(result, args);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\ndiagnose failed: ${err.message}`);
    if (err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
    process.exit(1);
  });

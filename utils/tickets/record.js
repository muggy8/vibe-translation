/**
 * The channel: reading and writing the tickets, what was already tried (read out of the ledger, so 'this is the third time' is a query rather than a claim), and the only doors a model reply reaches a ticket through — `recordDiagnosis` runs the banned-option filter internally, so no path can attach a diagnosis that skips it. A ticket closes only as improved / unchanged / worse, measured on the deliverable, never as `finding-gone`.
 *
 * Part of the tickets.js layer (split out of the original single file).
 */

const fs = require("fs");
const path = require("path");
const { readLedger } = require("../ledger");

const { ticketPaths, ticketsEnabled } = require("./settings");
const { renderTicketsMarkdown } = require("./render");
const { validateTicketShape } = require("./shape");
const { filterOptions } = require("./banned-options");
const { customerMayRead, sameQuestion } = require("./manager-eyes");

/**
 * Read every ticket.
 *
 * Same honesty rule as `readLedger` and `readUsableManifest` (gotcha 33): a corrupt ticket file
 * is reported, never returned as an empty list. A run that silently loses its open tickets is a
 * run that asks the same question twice.
 *
 * @param {string} [filePath] - Defaults to `ticketPaths().json`.
 * @returns {{tickets: Ticket[], error: string|null}}
 */
function readTickets(filePath = ticketPaths().json) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { tickets: [], error: null };
    return { tickets: [], error: `the ticket file could not be read (${err.message})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { tickets: [], error: `the ticket file is not valid JSON (${err.message}) — it is not being treated as empty` };
  }
  const tickets = Array.isArray(parsed && parsed.tickets) ? parsed.tickets : null;
  if (!tickets) return { tickets: [], error: "the ticket file has no `tickets` array — it is not being treated as empty" };
  const kept = tickets.filter((t) => t && typeof t === "object" && t.id && t.step && t.finding);
  const dropped = tickets.length - kept.length;
  return { tickets: kept, error: dropped ? `${dropped} ticket(s) were unreadable and were skipped` : null };
}


/**
 * Write the whole ticket list, then re-render the human-readable file.
 * @param {Ticket[]} tickets
 * @param {{json?: string, markdown?: string}} [paths]
 * @returns {{written: boolean, error: string|null}}
 */
function writeTickets(tickets, paths = ticketPaths()) {
  try {
    fs.mkdirSync(path.dirname(paths.json), { recursive: true });
    fs.writeFileSync(
      paths.json,
      JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), tickets }, null, 2) + "\n",
      "utf8"
    );
    if (paths.markdown) fs.writeFileSync(paths.markdown, renderTicketsMarkdown(tickets), "utf8");
    return { written: true, error: null };
  } catch (err) {
    return { written: false, error: `the ticket file could not be written (${err.message})` };
  }
}


/**
 * The attempts the ledger already recorded for this finding, copied into the ticket.
 *
 * This is why tickets and the ledger are one system: "I have already tried this twice" is not a
 * claim the manager makes from memory, it is a query. It also means a ticket cannot be used to
 * launder a spin — the third attempt's ticket shows the two failures inside it.
 *
 * @param {string} step
 * @param {string|null} volume
 * @param {string} finding
 * @param {Array<{entries: import("./ledger").LedgerEntry[]}>} [ledger] - Defaults to reading it.
 * @returns {TicketAttempt[]}
 */
function triedFromLedger(step, volume, finding, ledger) {
  const entries = (ledger || readLedger()).entries || [];
  const want = volume === undefined || volume === null ? null : String(volume);
  return entries
    .filter(
      (e) =>
        e.kind === "intervention" &&
        e.step === step &&
        e.finding === finding &&
        (e.volume === undefined || e.volume === null ? null : String(e.volume)) === want
    )
    .map((e) => ({ action: e.action, outcome: e.outcome || null, ledgerId: e.id }));
}


/**
 * Open a ticket.
 *
 * Refuses a malformed one rather than writing it, because the ticket file is the record a human
 * reads later, and a demand in it is the thing the whole design exists to keep out.
 *
 * @param {Object} input
 * @param {string} input.step
 * @param {string} input.finding - The finding `kind`.
 * @param {string} [input.volume]
 * @param {string} input.question
 * @param {TicketEvidence[]} input.evidence
 * @param {string[]} [input.ruledOut]
 * @param {TicketAttempt[]} [input.tried] - Defaults to whatever the ledger already holds for this
 *   finding, which is the honest default.
 * @param {string} [input.run]
 * @param {{json?: string, markdown?: string}} [paths]
 * @returns {{ticket: Ticket|null, written: boolean, problems: TicketShapeProblem[], error: string|null}}
 */
function createTicket(input, paths = ticketPaths()) {
  const shape = validateTicketShape(input);
  if (!shape.ok) return { ticket: null, written: false, problems: shape.problems, error: "the ticket is malformed" };

  const run = input.run || process.env.INDEX_RUN_ID || "unrun";
  const current = readTickets(paths.json);
  const sequence = current.tickets.filter((t) => t.run === run).length + 1;

  /** @type {Ticket} */
  const ticket = {
    id: `TCK-${run}-${sequence}`,
    run,
    at: new Date().toISOString(),
    step: input.step,
    volume: input.volume === undefined || input.volume === null ? null : String(input.volume),
    finding: input.finding,
    evidence: input.evidence,
    tried: input.tried === undefined
      ? triedFromLedger(input.step, input.volume, input.finding)
      : input.tried,
    ruledOut: input.ruledOut || [],
    question: String(input.question).trim(),
    status: "open",
  };

  if (!ticketsEnabled()) return { ticket, written: false, problems: [], error: null };

  const result = writeTickets([...current.tickets, ticket], paths);
  return { ticket, written: result.written, problems: [], error: result.error };
}


/**
 * Attach the diagnostics team's reply.
 *
 * The banned-option filter runs HERE, on the provider's side of the conversation, because a
 * manager given a menu picks the cheapest item on it. Refused options are stored on the ticket
 * with their reason and their escalation, so nothing is quietly dropped.
 *
 * @param {string} ticketId
 * @param {TicketOption[]} options
 * @param {{json?: string, markdown?: string}} [paths]
 * @returns {{ticket: Ticket|null, allowed: TicketOption[], refused: Object[], error: string|null}}
 */
function attachOptions(ticketId, options, paths = ticketPaths()) {
  const current = readTickets(paths.json);
  const ticket = current.tickets.find((t) => t.id === ticketId);
  if (!ticket) return { ticket: null, allowed: [], refused: [], error: `no ticket ${ticketId} to answer` };

  const { allowed, refused } = filterOptions(ticketId, options);
  ticket.options = allowed;
  ticket.refusedOptions = refused;
  ticket.status = "answered";
  ticket.answeredAt = new Date().toISOString();

  const result = writeTickets(current.tickets, paths);
  return { ticket, allowed, refused, error: result.error };
}


/**
 * Record the diagnostics team's answer to a ticket — cause, questions, what it read, and its
 * options.
 *
 * **This is the only door from a model's reply to a ticket's options.** It calls `attachOptions`
 * internally, and `attachOptions` is where `optionIsBanned` runs (gotcha 70). A caller that wanted
 * to skip the filter would have to call `attachOptions` directly and say so out loud in the code.
 *
 * Two things are recorded that the model did not choose to report, because they are the halves that
 * can be checked: the tool calls its turn actually made (`observedReads`), and every write the
 * read-only gate refused (`attemptedWrites`). A support team that tried to repair the data while it
 * was being asked to explain it is a fact the account owner should be able to read.
 *
 * @param {string} ticketId
 * @param {Object} reply
 * @param {string} reply.cause
 * @param {TicketOption[]} reply.options
 * @param {string} [reply.recommend]
 * @param {string[]} [reply.questions]
 * @param {string} [reply.ownerNote]
 * @param {string[]} [reply.read]
 * @param {Array<{tool: string, path: string}>} [reply.observedReads]
 * @param {string[]} [reply.citedWithoutReading]
 * @param {Array<{tool: string, path: string, reason: string}>} [reply.attemptedWrites]
 * @param {Object} [reply.turnShape] - How the answering turn actually ran (chunks, tool calls, how
 *   much reading it set aside on disk, how it ended). Replaces the step cap this role no longer has.
 * @param {{json?: string, markdown?: string}} [paths]
 * @returns {{ticket: Ticket|null, allowed: TicketOption[], refused: Object[], error: string|null}}
 */
function recordDiagnosis(ticketId, reply, paths = ticketPaths()) {
  const current = readTickets(paths.json);
  const existing = current.tickets.find((t) => t.id === ticketId);
  if (!existing) return { ticket: null, allowed: [], refused: [], error: `no ticket ${ticketId} to answer` };
  if (existing.status === "closed") {
    return { ticket: null, allowed: [], refused: [], error: `ticket ${ticketId} is closed — a closed ticket is not re-answered` };
  }

  // The options go through the filter. Everything else is attached to the ticket afterwards, so a
  // refusal in the option list cannot take the cause or the questions with it.
  const answered = attachOptions(ticketId, (reply && reply.options) || [], paths);
  if (!answered.ticket) return answered;

  // Re-read: `attachOptions` wrote its own copy of the list, so the list this function read before
  // it is now stale, and writing it back would erase the options that were just filtered in.
  const after = readTickets(paths.json);
  const ticket = after.tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    return { ...answered, ticket: null, error: `ticket ${ticketId} vanished while it was being answered` };
  }

  const prior = ticket.diagnosis;
  ticket.diagnosis = {
    cause: String((reply && reply.cause) || "").trim(),
    recommend: String((reply && reply.recommend) || "").trim(),
    questions: (reply && reply.questions) || [],
    ownerNote: String((reply && reply.ownerNote) || "").trim(),
    read: (reply && reply.read) || [],
    observedReads: (reply && reply.observedReads) || [],
    citedWithoutReading: (reply && reply.citedWithoutReading) || [],
    attemptedWrites: (reply && reply.attemptedWrites) || [],
    // How the answering turn actually ran. This role has no step cap, so a stored cap would state a
    // limit that does not exist; the shape says how many pieces the turn needed and how it ended.
    turnShape: (reply && reply.turnShape) || null,
    usage: (reply && reply.usage) || null,
    // How the answer reached the ticket: "tool" (the role called `submit_diagnosis`) or "prose" (the
    // parser found the JSON block in its reply). Recorded because the fragile half of this channel is
    // the prose scrape, and a ticket that keeps reading "prose" is a role not using the button it was
    // given — which is the fact a reader needs before blaming the answer for being thin.
    answeredBy: (reply && reply.answeredBy) || null,
    answerToolRefusals: (reply && reply.answerToolRefusals) || [],
    stateMovedDuringDiagnosis: Boolean(reply && reply.stateMovedDuringDiagnosis),
    attempts: (prior && prior.attempts ? prior.attempts : 0) + 1,
    askedAgain: Boolean(prior),
    at: new Date().toISOString(),
  };
  // Nothing usable survived the filter. "Answered" would be a lie the manager acts on, so the
  // ticket says plainly that the remaining decision belongs to the account owner.
  ticket.noUsableOptions = answered.allowed.length === 0;

  const result = writeTickets(after.tickets, paths);
  return { ...answered, ticket, error: result.error };
}


/**
 * Record the manager's answer to one of the diagnostics team's clarifying questions.
 *
 * The check is on the ANSWER, not on the question. The team may ask anything; the manager may only
 * reply with what a customer can see, and every path it cites is checked against `customerMayRead`.
 * A refusal names what the manager IS allowed to look at, because the useful failure is the one that
 * produces a usable second answer.
 *
 * @param {string} ticketId
 * @param {{question: string, answer: string, cites?: string[]}} reply
 * @param {{json?: string, markdown?: string}} [paths]
 * @returns {{ticket: Ticket|null, written: boolean, error: string|null}}
 */
function recordAnswer(ticketId, reply, paths = ticketPaths()) {
  const current = readTickets(paths.json);
  const ticket = current.tickets.find((t) => t.id === ticketId);
  if (!ticket) return { ticket: null, written: false, error: `no ticket ${ticketId}` };

  const asked = (ticket.diagnosis && ticket.diagnosis.questions) || [];
  if (!asked.length) {
    return {
      ticket: null,
      written: false,
      error: `ticket ${ticketId} has no open question to answer. The diagnostics team asks questions ` +
        `in its diagnosis; answer one of those, or ask for a diagnosis first.`,
    };
  }
  // Only an OPEN question may be answered, and each one exactly once. An answer is evidence the
  // provider acted on; letting the same question be answered twice is how a first answer that the
  // manager did not like gets quietly replaced instead of challenged.
  const open = unansweredQuestions(ticket);
  const question = open.find((q) => sameQuestion(q, reply && reply.question));
  if (!question) {
    const already = asked.find((q) => sameQuestion(q, reply && reply.question));
    if (already) {
      const prior = (ticket.answers || []).find((a) => sameQuestion(a.question, already)) || {};
      return {
        ticket: null,
        written: false,
        error:
          `"${already}" has no open question behind it — it is already answered: ` +
          `"${prior.answer}" (at ${prior.at}). Every question is answered once. If that answer was ` +
          `wrong or incomplete, say so in the next request for a diagnosis; do not overwrite an ` +
          `answer the provider already acted on.`,
      };
    }
    return {
      ticket: null,
      written: false,
      error:
        `"${(reply && reply.question) || "(none given)"}" is not a question this ticket asked. ` +
        `It asked: ${asked.map((q) => `"${q}"`).join(" / ")}`,
    };
  }
  const answer = String((reply && reply.answer) || "").trim();
  if (!answer) return { ticket: null, written: false, error: "an answer cannot be empty" };

  const cites = Array.isArray(reply.cites) ? reply.cites : [];
  const refusedCites = [];
  for (const c of cites) {
    const verdict = customerMayRead(c);
    if (!verdict.allowed) refusedCites.push(`${c} — ${verdict.because}`);
  }
  if (refusedCites.length) {
    return {
      ticket: null,
      written: false,
      error:
        `the answer cites something a delivery manager may not read:\n  - ${refusedCites.join("\n  - ")}\n` +
        `What the manager CAN cite: the plan of record (translation-target.json), what each volume ` +
        `folder holds, the step reports in .postmortem/, the ledger, the tickets, and ` +
        `translation-report.md. Answer from those, or say that the manager cannot tell and the ` +
        `diagnostics team should read it itself.`,
    };
  }

  ticket.answers = ticket.answers || [];
  ticket.answers.push({ question, answer, cites, at: new Date().toISOString() });
  const result = writeTickets(current.tickets, paths);
  return { ticket, written: result.written, error: result.error };
}


/**
 * The questions on an answered ticket that the manager has not answered yet.
 * @param {Ticket} ticket
 * @returns {string[]}
 */
function unansweredQuestions(ticket) {
  const asked = (ticket.diagnosis && ticket.diagnosis.questions) || [];
  const answers = ticket.answers || [];
  return asked.filter((q) => !answers.some((a) => sameQuestion(a.question, q)));
}


/**
 * Record the manager's choice, in writing, with its reason.
 *
 * The reason is required. A choice without a reason is the thing a human cannot audit six runs
 * later, and it is the half that makes the escalation ladder reviewable.
 *
 * @param {string} ticketId
 * @param {{optionId: string, reason: string, decidedBy?: string}} choice
 * @param {{json?: string, markdown?: string}} [paths]
 * @returns {{ticket: Ticket|null, written: boolean, error: string|null}}
 */
function recordChoice(ticketId, choice, paths = ticketPaths()) {
  const current = readTickets(paths.json);
  const ticket = current.tickets.find((t) => t.id === ticketId);
  if (!ticket) return { ticket: null, written: false, error: `no ticket ${ticketId}` };
  if (!ticket.options || !ticket.options.length) {
    if (ticket.noUsableOptions) {
      return {
        ticket: null,
        written: false,
        error:
          `ticket ${ticketId} has no option left to choose: every option the diagnostics team offered was ` +
          `refused by the banned-option filter, and what it actually believes is written in ownerNote for ` +
          `the account owner. There is nothing here the manager may choose, and choosing it is not the ` +
          `manager's decision to make (gotcha 70).`,
      };
    }
    return { ticket: null, written: false, error: `ticket ${ticketId} has no options to choose from yet` };
  }
  const option = ticket.options.find((o) => o.id === choice.optionId);
  if (!option) {
    const refused = (ticket.refusedOptions || []).find((r) => r.option.id === choice.optionId);
    if (refused) {
      return {
        ticket: null,
        written: false,
        error: `option ${choice.optionId} was refused when it was offered: ${refused.because} It goes to ${refused.escalateTo}.`,
      };
    }
    return { ticket: null, written: false, error: `no option ${choice.optionId} on ticket ${ticketId}` };
  }
  if (!choice.reason || !String(choice.reason).trim()) {
    return { ticket: null, written: false, error: "a choice must carry the reason it was made for" };
  }
  ticket.choice = { optionId: option.id, reason: String(choice.reason).trim(), decidedBy: choice.decidedBy || "manager" };
  ticket.status = "chosen";
  const result = writeTickets(current.tickets, paths);
  return { ticket, written: result.written, error: result.error };
}


/**
 * Close a ticket with the outcome, which is judged by comparing the deliverable before and
 * after — never by whether the finding disappeared.
 *
 * @param {string} ticketId
 * @param {{outcome: "improved"|"unchanged"|"worse", note: string}} closure
 * @param {{json?: string, markdown?: string}} [paths]
 * @returns {{ticket: Ticket|null, written: boolean, error: string|null}}
 */
function closeTicket(ticketId, closure, paths = ticketPaths()) {
  const current = readTickets(paths.json);
  const ticket = current.tickets.find((t) => t.id === ticketId);
  if (!ticket) return { ticket: null, written: false, error: `no ticket ${ticketId}` };
  if (!["improved", "unchanged", "worse"].includes(closure.outcome)) {
    return {
      ticket: null,
      written: false,
      error: `a ticket closes with "improved", "unchanged" or "worse" — measured on the deliverable. Got "${closure.outcome}".`,
    };
  }
  ticket.closure = { outcome: closure.outcome, note: String(closure.note || "") };
  ticket.status = "closed";
  ticket.closedAt = new Date().toISOString();
  const result = writeTickets(current.tickets, paths);
  return { ticket, written: result.written, error: result.error };
}


/**
 * Tickets still waiting for an answer or a choice.
 * @param {{json?: string, markdown?: string}} [paths]
 * @returns {Ticket[]}
 */
function openTickets(paths = ticketPaths()) {
  return readTickets(paths.json).tickets.filter((t) => t.status !== "closed");
}


/**
 * Does this ticket ask about exactly this (step, volume, finding)?
 *
 * The key is the same one the anti-spin gate keys on (`utils/ledger.js`), and it is written here
 * rather than re-derived at each caller because the resume triage (`utils/resume.js`) has to answer
 * "has this already been asked?" from a state snapshot it was handed, while `ticketsFor` answers it
 * from the file. Two implementations of a key is two chances for them to disagree about whether a
 * question is already open — which is how a duplicate ticket gets opened and a manager gets told to
 * ask the same thing twice.
 *
 * @param {Ticket} ticket
 * @param {{step: string, volume?: string|null, finding: string}} key
 * @returns {boolean}
 */
function matchesTicketKey(ticket, key) {
  const want = key.volume === undefined || key.volume === null ? null : String(key.volume);
  return (
    ticket.step === key.step &&
    ticket.finding === key.finding &&
    (ticket.volume === undefined || ticket.volume === null ? null : String(ticket.volume)) === want
  );
}


/**
 * Every ticket about one finding — the question "has anyone already asked this?" before a
 * second ticket is opened for the same thing.
 * @param {{step: string, volume?: string|null, finding: string}} key
 * @param {{json?: string, markdown?: string}} [paths]
 * @returns {Ticket[]}
 */
function ticketsFor(key, paths = ticketPaths()) {
  return readTickets(paths.json).tickets.filter((t) => matchesTicketKey(t, key));
}

// ─── The human-facing half ────────────────────────────────────────────────────


module.exports = {
  readTickets,
  writeTickets,
  triedFromLedger,
  createTicket,
  attachOptions,
  recordDiagnosis,
  recordAnswer,
  unansweredQuestions,
  recordChoice,
  closeTicket,
  openTickets,
  matchesTicketKey,
  ticketsFor,
};

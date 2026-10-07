/**
 * diagnoseTicket: the whole turn in order, uncapped (no step cap — what bounds it is the repetition detector, the loose turn clock, and the fact that its old reads go to disk instead of out of the window), reaching the ticket only through recordDiagnosis, which runs the banned-option filter internally so no path attaches a diagnosis that skips it. One diagnosis per ticket unless somebody asks for a second with --reask.
 *
 * Part of the diagnostics.js layer (split out of the original single file).
 */

const fs = require("fs");
const harness = require("../../harness");
const { assertRealToolCalls, turnShapeOf } = require("../agents");
const { fingerprintFiles } = require("../fs");
const tickets = require("../tickets");
const { runTurnWithHooks, MANAGER_TASK } = require("../hooks");
const { readTickets, ticketPaths, recordDiagnosis } = tickets;

const { DIAGNOSIS_TOOLS_NOTE, ROOT } = require("./contract");
const { readOnlyFsTools } = require("./tools");
const { loadSystemPrompt, renderTicketForDiagnosis } = require("./brief");
const { parseDiagnosisReply, validateDiagnosisShape } = require("./shape");
const { collectWriteAttempts, crossCheckReads, evidenceFootprint } = require("./reading");

/**
 * Can this ticket be asked, before anything expensive is decided?
 *
 * The three refusals `diagnoseTicket` makes before it reaches a model are readable off the ticket
 * record, and a caller needs to know them BEFORE it switches a model container in. On this machine a
 * container switch means loading a model (gotcha 22), and "already answered" is the common case in a
 * loop that re-reads the state every iteration — so the CLI asks this first and only fires the
 * `pre-manager` hook for a request that can actually reach the endpoint.
 *
 * One implementation, two readers: `diagnoseTicket` calls this itself, so the CLI's decision and the
 * module's refusal cannot drift.
 *
 * @param {Object|null} ticket - The ticket record, or null when the id is not in the file.
 * @param {Object} [opts]
 * @param {boolean} [opts.reask] - The `--reask` flag.
 * @param {string} [opts.jsonPath] - Where the tickets live, for the "no ticket" message.
 * @returns {{askable: boolean, error: string|null}}
 */
function diagnosisIsAskable(ticket, { ticketId = "", reask = false, jsonPath = "" } = {}) {
  const id = ticket ? ticket.id : ticketId;
  if (!ticket) {
    return {
      askable: false,
      error:
        `no ticket ${id} in ${jsonPath || "the ticket file"}. Run "node diagnose.js --open" to list the ones ` +
        `that are waiting, or "npm run delivery" to see why there are none.`,
    };
  }
  if (ticket.status === "closed") {
    return {
      askable: false,
      error: `ticket ${ticket.id} is closed (${ticket.closure ? ticket.closure.outcome : "no outcome recorded"}). A closed ticket is not re-asked; open a new one if the finding came back.`,
    };
  }
  const priorAttempts = (ticket.diagnosis && ticket.diagnosis.attempts) || 0;
  if (ticket.diagnosis && !reask) {
    return {
      askable: false,
      error:
        `ticket ${ticket.id} already has a diagnosis (attempt ${priorAttempts}). Re-asking the same question ` +
        `until a cheaper answer appears is the same spin the ledger refuses (gotcha 69). Pass --reask when a ` +
        `second opinion is genuinely wanted — for example after the manager answered a question the team asked.`,
    };
  }
  return { askable: true, error: null };
}


/**
 * Ask the diagnostics team one ticket.
 *
 * @param {Object} cfg
 * @param {string} cfg.ticketId - The ticket to answer.
 * @param {string} cfg.seriesDir - The series the ticket is about (SERIES_LOCATION).
 * @param {string} [cfg.root] - The project root the agent may read (defaults to this repo).
 * @param {boolean} [cfg.reask] - Ask again when the ticket already has a diagnosis.
 * @param {{json?: string, markdown?: string}} [cfg.paths] - Ticket file override (tests).
 * @returns {Promise<{ok: boolean, refused: boolean, ticket: Object|null, diagnosis: Object|null,
 *   allowed: Object[], refusedOptions: Object[], writeAttempts: Object[], problems: Object[],
 *   warnings: Object[], usage: Object|null, error: string|null}>}
 */
async function diagnoseTicket({ ticketId, seriesDir, root = ROOT, reask = false, paths = ticketPaths() }) {
  const fail = (error, extra = {}) => ({
    ok: false,
    refused: true,
    ticket: null,
    diagnosis: null,
    allowed: [],
    refusedOptions: [],
    writeAttempts: [],
    problems: [],
    warnings: [],
    usage: null,
    error,
    ...extra,
  });

  const store = readTickets(paths.json);
  const ticket = store.tickets.find((t) => t.id === ticketId);
  // The same three refusals the CLI asks about before it switches a model container in (see
  // `diagnosisIsAskable`). Kept here so no caller can reach the turn by skipping that question.
  const askable = diagnosisIsAskable(ticket, { ticketId, reask, jsonPath: paths.json });
  if (!askable.askable) return fail(askable.error);

  const where = { seriesDir, root };
  const footprint = await evidenceFootprint(ticket, [], seriesDir);
  // The evidence size is PRINTED, not spent on a cap. This turn is uncapped, so the number that
  // explains a long diagnosis afterwards is "how much it was pointed at", and the run log is where
  // the account owner reads it.
  harness.logLine(
    `[diagnostics] ${ticket.id}: evidence is ${footprint.files.length} file(s), ` +
      `${footprint.bytes} bytes — uncapped turn, old read answers offloaded to disk as it fills`
  );

  const gate = await readOnlyFsTools({ cwd: root, allowedDirs: [root] });

  // The role's read-only promise, checked against the disk rather than asserted: hash what the
  // ticket points at before the turn and again after it. `fingerprintFiles` is the same rule the QA
  // loop uses to tell a rewrite from a no-op (gotcha 65) — here it is the difference between
  // "a support team that only looked" and one that quietly edited the corpus it was asked about.
  // The window includes the per-machine hooks that wrap the turn, because a hook is a side effect
  // this machine chose and "the state moved while we were asking" is the honest reading of it.
  const before = await fingerprintFiles(footprint.files);

  // `pre-manager` / `post-manager` fire HERE, around the turn, not in the CLI that typed the command.
  // Two reasons, both about cost and honesty: every refusal this module makes (no ticket, a closed
  // ticket, a ticket already answered) happens first, so a request that never reaches the model never
  // pays for a container switch (gotcha 22); and this turn is a tool-calling agent, which a container
  // that cannot call tools answers with nothing at all (gotcha 51) — so "the support model is the one
  // serving" has to be guaranteed by the role that makes the call. Which container that is stays
  // entirely the hook's business (docs/architecture.md, "hook names are role labels, never model names").
  const result = await runTurnWithHooks(MANAGER_TASK, async () => {
    const agent = await harness.createAgentHandle({
      name: "diagnostics",
      systemPrompt: loadSystemPrompt() + DIAGNOSIS_TOOLS_NOTE,
      tools: gate.tools,
      approve: gate.approve,
      cwd: root,
      // The delivery-layer context management: no step cap, the working window is reported on every
      // tool answer, and old read answers are set aside on disk where they stay recallable
      // (`utils/context.js`). The harness adds `manage_context` / `recall_memory` to the tool set for
      // a managed role — this module does not add them itself, so the read-only tool SET stays the
      // three senses the contract pins (gotcha 74) and the two memory tools come in through the
      // harness, which is also what keeps `collectWriteAttempts`' "not advertised" layer honest.
      contextManagement: true,
    });
    try {
      const reply = await agent.sendTurn(renderTicketForDiagnosis(ticket, where), {
        label: `diagnose-${ticket.id}`,
      });
      assertRealToolCalls(reply, "the diagnostics agent", ticket.volume || ticket.step);
      return reply;
    } finally {
      await agent.close();
    }
  });

  const after = await fingerprintFiles(footprint.files);
  const moved = before !== after;

  // Both layers of the read-only guarantee, recorded together (gotcha 8's two-layer pattern):
  //   - the tool SET refused it: the mutating tools are never advertised, so the model's attempt
  //     dies before it reaches the sandbox ("Model tried to call unavailable tool 'writeFile'");
  //   - the approve gate refused it: the backstop for a mutating tool that ever reaches here.
  // Whichever layer fired, the attempt is recorded, because "the support team tried to repair the
  // data while it was being asked to explain it" is information the account owner should see.
  const attempts = collectWriteAttempts(gate.refusals, result.toolCalls);

  const parsed = parseDiagnosisReply(result.text);
  if (!parsed.diagnosis) {
    return {
      ok: false,
      refused: false,
      ticket,
      diagnosis: null,
      allowed: [],
      refusedOptions: [],
      writeAttempts: attempts,
      problems: parsed.problems,
      warnings: [],
      usage: result.usage || null,
      error: "the diagnostics team could not answer this ticket (see the problems below).",
    };
  }

  const checked = validateDiagnosisShape(parsed.diagnosis);
  const reads = crossCheckReads(checked.diagnosis.read, result.toolCalls || []);
  const warnings = [...checked.warnings];
  if (reads.unsupported.length) {
    warnings.push({
      kind: "cited-without-reading",
      message:
        `the reply cites ${reads.unsupported.length} file(s) the turn never opened: ` +
        `${reads.unsupported.join(", ")}. The turn's real tool calls are recorded with this ` +
        `diagnosis, so a conclusion that names an unread file is visible as one.`,
    });
  }
  if (moved) {
    warnings.push({
      kind: "state-moved-during-diagnosis",
      message:
        "the files this ticket points at changed while the diagnosis was running. This role has no " +
        "write access, so something else is writing them — a pipeline run is in progress. Read the " +
        "diagnosis as a snapshot of a moving state.",
    });
  }

  if (!checked.ok) {
    return {
      ok: false,
      refused: false,
      ticket,
      diagnosis: null,
      allowed: [],
      refusedOptions: [],
      writeAttempts: attempts,
      problems: checked.problems,
      warnings,
      usage: result.usage || null,
      error: "the diagnostics reply does not meet the contract (see the problems below).",
    };
  }

  // The only door from a model reply to a ticket: recordDiagnosis runs the banned-option filter
  // internally, so there is no way to attach a diagnosis that skips it (gotcha 70).
  const written = recordDiagnosis(
    ticketId,
    {
      cause: checked.diagnosis.cause,
      options: checked.diagnosis.options,
      recommend: checked.diagnosis.recommend,
      questions: checked.diagnosis.questions,
      ownerNote: checked.diagnosis.ownerNote || "",
      read: checked.diagnosis.read,
      observedReads: reads.observed,
      citedWithoutReading: reads.unsupported,
      attemptedWrites: attempts,
      // How the turn actually ran, in place of the step cap it used to run under. This role is
      // uncapped (see the note under `DIAGNOSIS_COSTS`), so a record naming a cap it never had would
      // state a limit that does not exist — and the next reader would go looking for a ceiling to
      // raise. The useful facts are how many pieces the turn needed, how much of its reading it had
      // to set aside on disk, and how it ended.
      turnShape: turnShapeOf(result),
      usage: result.usage || null,
      stateMovedDuringDiagnosis: moved,
    },
    paths
  );

  return {
    ok: !written.error,
    refused: false,
    ticket: written.ticket,
    diagnosis: written.ticket ? written.ticket.diagnosis : null,
    allowed: written.allowed,
    refusedOptions: written.refused,
    writeAttempts: attempts,
    problems: [],
    warnings,
    usage: result.usage || null,
    error: written.error || null,
  };
}


module.exports = {
  diagnosisIsAskable,
  diagnoseTicket,
};

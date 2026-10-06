/**
 * utils/tickets.js — the only channel between the delivery manager and the teams that can
 * see the code.
 *
 * Why a channel needs rules at all. The delivery manager (see AGENTS.md §3.6 and the plan
 * notebook) judges a translation run without ever reading the code: it reads findings,
 * reports and deliverables, and it may re-run steps. When re-running stops working it calls
 * in the diagnostics team, and that request is a TICKET. Two failure modes make an
 * unstructured request worse than no request at all:
 *
 *   1. **A ticket that states the result it wants.** "Make volume 15's glossary pass." That
 *      is not a question, it is an instruction handed to people who know the code — and the
 *      cheapest way to satisfy it is always the one that removes the *finding* rather than
 *      the *fault*. Volume 15 of the live series is the cautionary case (gotcha 68): the
 *      carry-forward gate quarantined a glossary that had GROWN from 445 terms to 460, and
 *      its own log message blamed a reply-budget cut-off. A fixer handed "make it pass"
 *      would have weakened the guard and quietly lost terms — the exact damage the guard
 *      exists to prevent.
 *   2. **An option list that includes the cheap way out.** A manager chooses among the
 *      options it is offered, and it will pick the cheap one. So the constraint cannot sit
 *      on the manager's judgment; it has to sit on the thing that GENERATES the options.
 *      That is what `optionIsBanned` is for: it is enforced here, in code, on the provider's
 *      side of the conversation.
 *
 * So a ticket is findings-shaped and never outcome-shaped: the manager reports what it
 * observed, what it already tried (read straight out of the ledger, not from memory), what
 * it ruled out, and asks a question. The diagnostics team answers with options, and the
 * options that would remove a finding without changing the deliverable are refused here and
 * escalated to the account owner instead.
 *
 * What this module deliberately is NOT: it is not a parser that reads a model's mind. The
 * demand check is a SHAPE check — it catches the forms a demand actually takes, and when it
 * rejects it says what to write instead. A ticket that slips through is still answerable by
 * a diagnostics team that has its own banned list; this is the first gate, not the last one.
 *
 * @module utils/tickets
 */

const fs = require("fs");
const path = require("path");
const { postMortemDir } = require("./postmortem");
const { readLedger } = require("./ledger");
const { readBoolEnv } = require("../configs/shared");

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One thing the manager observed, cited by path.
 *
 * @typedef {Object} TicketEvidence
 * @property {string} file - The artifact or report it looked at (relative to the series root).
 * @property {string} note - One line: what it saw there.
 */

/**
 * One thing already attempted, copied from the run ledger rather than from the manager's
 * memory — which is what makes "this is the third time" provable instead of asserted.
 *
 * @typedef {Object} TicketAttempt
 * @property {string} action
 * @property {("improved"|"unchanged"|"worse"|"refused")|null} outcome
 * @property {string} [ledgerId] - The `LedgerEntry.id` this came from, so a report can cite it.
 */

/**
 * One option the diagnostics team offers back.
 *
 * @typedef {Object} TicketOption
 * @property {string} id - Citable id (`<ticketId>/O<n>`).
 * @property {string} label - What it does, in one line.
 * @property {string[]} [touches] - Files, knobs or artifacts it changes.
 * @property {("free"|"cheap"|"expensive")} [cost] - Rough cost, so the manager is not blind
 *   to the cheap-looking one that is actually a whole-volume re-run.
 * @property {string} [risk] - What it could break.
 * @property {string} [verify] - How to tell afterwards whether it worked — measured on the
 *   DELIVERABLE, not by whether the finding disappeared (see the plan's §6).
 * @property {boolean} [requiresCodeChange] - True when this is a dev-team job, not a manager action.
 */

/**
 * A ticket, and the whole conversation attached to it.
 *
 * @typedef {Object} Ticket
 * @property {string} id - `TCK-<run>-<n>`. Cited by `LedgerEntry.ticket`.
 * @property {string} run
 * @property {string} at - ISO timestamp.
 * @property {string} step
 * @property {string|null} [volume]
 * @property {string} finding - The finding `kind` from `utils/postmortem.js`.
 * @property {TicketEvidence[]} evidence
 * @property {TicketAttempt[]} tried
 * @property {string[]} ruledOut - Causes the manager eliminated, and how.
 * @property {string} question - What it is asking. Required, and the half that must not be a demand.
 * @property {("open"|"answered"|"chosen"|"closed")} status
 * @property {TicketOption[]} [options] - The allowed half of the reply.
 * @property {Array<{option: TicketOption, because: string, escalateTo: string}>} [refusedOptions]
 *   — the half this module refused, kept visible rather than dropped.
 * @property {{optionId: string, reason: string, decidedBy: string}} [choice]
 * @property {{outcome: string, note: string}} [closure]
 */

/**
 * @typedef {Object} TicketShapeProblem
 * @property {string} kind - `no-question` | `not-a-question` | `demand` | `outcome-demanded`
 *   | `banned-requested` | `missing-finding` | `no-evidence`.
 * @property {string} message - What is wrong AND what to write instead.
 * @property {string} [matched] - The text that triggered it.
 */

// ─── Settings ─────────────────────────────────────────────────────────────────

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

/**
 * The options the diagnostics team may NOT offer the manager.
 *
 * The reason this list exists in code: a manager picks the cheapest option it is offered. A
 * constraint on the manager's judgment is therefore not a constraint at all — the constraint
 * has to sit on the option generator. Every entry below is a way to make a FINDING disappear
 * without changing the DELIVERABLE, which is the one class of "fix" this pipeline has already
 * paid for in full (gotcha 64: 457 glossary terms vanished with no error because the guard
 * that would have caught them was checking the wrong thing; gotcha 65: a guard that called an
 * improvement a loss destroyed work the run had already bought).
 *
 * Each entry names the escalation instead of just saying no: if diagnostics genuinely believes
 * one of these is the right answer, it says so in prose to the ACCOUNT OWNER, who is the only
 * role that may turn off a guard.
 *
 * @type {Array<{id: string, pattern: RegExp, because: string, escalateTo: string}>}
 */
const BANNED_OPTIONS = [
  {
    id: "disable-carry-forward-guard",
    pattern: new RegExp(
      [
        // The knob named, and the direction it is being moved: `GUARD = false`,
        // "GUARD to false", "GUARD off".
        "\\b(?:GLOSSARY|VOICE|STYLE)_CARRY_FORWARD_GUARD\\b[^\\n]{0,40}\\b(false|off|disabled|disable|unset)\\b",
        // The direction named first: "turn off the GUARD", "disabling the GUARD".
        "\\b(disable|disabling|turn(?:ing)? off|switch(?:ing)? off)\\b[^\\n]{0,40}\\b(?:GLOSSARY|VOICE|STYLE)_CARRY_FORWARD_GUARD\\b",
        // The prose form, both word orders. The optional word is "the voice carry-forward guard"
        // / "the style carry-forward guard" — three guards, one rule.
        "\\b(disable|disabling|turn(?:ing)?|switch(?:ing)?)\\s+off\\s+the\\s+(?:\\w+\\s+)?carry[- ]forward",
        "\\b(disable|disabling|disabled)\\s+the\\s+(?:\\w+\\s+)?carry[- ]forward",
        "carry[- ]forward\\s+guard[^\\n]{0,30}\\b(off|disabled|turned off|switched off)\\b",
      ].join("|"),
      "i"
    ),
    because:
      "the carry-forward gate is the only thing that can see a cumulative artifact lose terms, " +
      "characters or style categories. Turning it off does not fix a loss; it restores the state " +
      "where 457 terms disappeared between two volumes with no error at all (gotcha 64).",
    escalateTo: "the account owner — only a human may un-check a guard, and only with the loss written down",
  },
  {
    id: "allow-fail-or-no-glossary",
    pattern: /--allow-fail|--allow-no-glossary|translate (despite|even with)out a (glossary|audit)/i,
    because:
      "these skip the entry gate that stops a token being spent on a foundation that was never " +
      "built. A volume translated with no glossary has no terminology law, and the drift shows up " +
      "later as a book that renders one name four ways.",
    escalateTo: "the account owner",
  },
  {
    id: "lower-a-threshold",
    pattern: /\b(lower|raise|change|adjust|tune|relax|loosen)\b[^\n]{0,40}\b(PASSING_SCORE|passing score|threshold|ACCEPTANCE_SAMPLE_FLOOR|sample floor|VERIFY_TIEBREAK|band)\b|PASSING_SCORE\s*=\s*\d+/i,
    because:
      "the threshold is the definition of 'good enough'. Moving it does not improve the artifact, " +
      "it redefines the question. It is also the one knob a run can be judged by, so a fix that " +
      "moves it is not auditable.",
    escalateTo: "the account owner — and only with the grader calibration (`npm run calibrate`) re-run",
  },
  {
    id: "delete-evidence",
    pattern: /\b(delete|remove|drop|clean|wipe|discard|purge)\b[^\n]{0,40}\b(\.rejected|rejected file|quarantine|evidence|postmortem|post-mortem|report|\.logs)\b/i,
    because:
      "quarantine files and reports are how a run explains itself. Deleting them makes the " +
      "finding disappear and the fault unsolvable, and it destroys the before/after comparison " +
      "the acceptance test needs.",
    escalateTo: "the account owner",
  },
  {
    id: "edit-hooks",
    pattern: /\b(edit|change|modify|rewrite|add)\b[^\n]{0,40}\bhooks\//i,
    because:
      "hooks/ are per-machine, gitignored, and they decide which model answers which role. A " +
      "pipeline-side 'fix' that edits them changes which model grades the work while looking like " +
      "it changed the pipeline (gotcha 22).",
    escalateTo: "the account owner — hooks are the machine's own configuration",
  },
  {
    id: "hide-the-finding",
    pattern: /\b(remove|drop|delete|omit|skip|ignore)\b[^\n]{0,40}\b(expectation|artifacts\.js|utils\/artifacts|finding|check|guard|assertion|declaration)\b|\bmark\b[^\n]{0,30}\b(not required|optional|expected to be missing)\b/i,
    because:
      "declaring a file away, or narrowing what a step is expected to leave behind, removes the " +
      "finding without changing the deliverable. `required` is reserved for files the pipeline " +
      "writes on every path it can reach — loosening it is how volume 04's empty folder stopped " +
      "looking like a problem (gotcha 67).",
    escalateTo: "the account owner",
  },
  {
    id: "turn-a-failure-into-a-skip",
    pattern: /\bON_VOLUME_ERROR|ON_MISSING_PREVIOUS|ON_TASK_ERROR|ON_QA_LIMIT|\bset\b[^\n]{0,30}\bskip\b[^\n]{0,30}(policy|mode)?|continue past (a|the) failure/i,
    because:
      "these decide where a failure SURFACES, not whether it happened. Flipping them to `skip` "
      + "or `continue` produces a run that finishes green while half the artifacts are missing — " +
      "the exact overnight failure gotcha 21 exists to prevent.",
    escalateTo: "the account owner — the run policies are the operator's choice, made before a run, not during one",
  },
  {
    id: "disable-the-ledger",
    pattern: /\bLEDGER_ENABLED\s*=\s*false|LEDGER_SPIN_ATTEMPTS|turn(ing)? off the ledger|no[- ]spin|disable[s]? the (anti[- ]spin|ledger)/i,
    because:
      "the anti-spin rule is the only thing standing between a delivery manager with the authority " +
      "to re-run steps and a 12-hour run that ends where it started (gotcha 69). A manager that " +
      "can switch off its own memory is not a manager with a budget, it is a manager without a record.",
    escalateTo: "the account owner",
  },
];

/**
 * Is this option banned?
 *
 * Deliberately conservative in one direction and deliberately blunt in the other: it matches on
 * the option's own words (label + touches), because an option that would turn off a guard says
 * so, and an option that hides it in a rename is a thing the account owner should be reading
 * anyway. A refusal always names where it goes instead.
 *
 * @param {TicketOption|string} option - An option object, or a bare description (for checking a
 *   proposal before it becomes an option).
 * @returns {{banned: boolean, reasons: Array<{id: string, because: string, escalateTo: string}>}}
 */
function optionIsBanned(option) {
  const text =
    typeof option === "string"
      ? option
      : [option && option.label, ...((option && option.touches) || [])].filter(Boolean).join("\n");

  const reasons = [];
  for (const banned of BANNED_OPTIONS) {
    const hit = text.match(banned.pattern);
    if (hit) {
      reasons.push({ id: banned.id, because: banned.because, escalateTo: banned.escalateTo, matched: hit[0] });
    }
  }
  return { banned: reasons.length > 0, reasons };
}

/**
 * Split a diagnostics reply into the options the manager may choose from and the ones this
 * module refused.
 *
 * The refused half is KEPT, not dropped. An option that vanishes is a diagnostics team that
 * looks like it never thought of it; an option that is visibly refused with a reason is an
 * audit trail, and it is how the account owner finds out that a guard is being complained
 * about.
 *
 * @param {string} ticketId
 * @param {TicketOption[]} options
 * @returns {{allowed: TicketOption[], refused: Array<{option: TicketOption, because: string, escalateTo: string, ids: string[]}>}}
 */
function filterOptions(ticketId, options) {
  const allowed = [];
  const refused = [];
  let n = 0;
  for (const raw of options || []) {
    n += 1;
    const option = { ...raw, id: raw.id || `${ticketId}/O${n}` };
    const verdict = optionIsBanned(option);
    if (verdict.banned) {
      refused.push({
        option,
        because: verdict.reasons.map((r) => `${r.id}: ${r.because}`).join(" | "),
        escalateTo: verdict.reasons[0].escalateTo,
        ids: verdict.reasons.map((r) => r.id),
      });
    } else {
      allowed.push(option);
    }
  }
  return { allowed, refused };
}

// ─── Ticket shape: a question, not an order ───────────────────────────────────

/**
 * Sentence-initial verbs that make a sentence a command rather than an observation. A ticket
 * may report what it ruled out and ask why; it may not tell the people reading the code what
 * to do to it.
 */
const DEMAND_VERBS = [
  "disable", "enable", "turn", "switch", "lower", "raise", "increase", "decrease", "relax",
  "loosen", "tighten", "change", "modify", "edit", "rewrite", "patch", "add", "remove", "delete",
  "drop", "set", "make", "get", "force", "allow", "bypass", "skip", "weaken", "bump", "flip",
  "just", "simply", "only",
];

/**
 * Phrases that name a FINDING DISAPPEARING as the goal. This is the shape of an outcome-shaped
 * ticket, and it is the one this module exists to refuse: the acceptance test compares the
 * deliverable before and after (plan §6), precisely because "the error is gone" is not evidence
 * that anything improved.
 */
const OUTCOME_PHRASES = [
  /\bmake\b[^\n]{0,60}\b(pass|accept|work|succeed|compile|finish|complete|stop)\b/i,
  /\bso that\b[^\n]{0,60}\b(passes|is accepted|works|stops|no longer|disappears|clears)\b/i,
  /\b(until|so)\b[^\n]{0,40}\b(it|the (volume|step|run|glossary|audit))\b[^\n]{0,30}\b(passes|accepts|is clean|is green)\b/i,
  /\b(get rid of|remove|clear|erase|suppress|silence)\b[^\n]{0,40}\b(finding|error|warning|verdict|quarantine|failure)\b/i,
  /\bwe (want|need|expect)\b/i,
  /\bi want\b/i,
  /\bfix it by\b/i,
  /\bmust (be )?(changed|fixed|made|done)\b/i,
];

const INTERROGATIVE_START = /^(what|why|how|which|where|when|who|whom|whose|whether|could|can|would|should|is|are|was|were|do|does|did|has|have|had|might|may)\b/i;

/**
 * Check a ticket's shape before it is written.
 *
 * Three things a ticket must have: a finding it is about, evidence it actually looked at, and a
 * QUESTION. And two things it must not have: a command, or a demanded outcome.
 *
 * The messages say what to write instead, because a refusal that only says "malformed" teaches
 * nothing and the next ticket will be the same shape.
 *
 * @param {Object} input - The proposed ticket.
 * @param {string} [input.question]
 * @param {string} [input.step]
 * @param {string} [input.finding]
 * @param {TicketEvidence[]} [input.evidence]
 * @param {TicketAttempt[]} [input.tried]
 * @param {string[]} [input.ruledOut]
 * @returns {{ok: boolean, problems: TicketShapeProblem[]}}
 */
function validateTicketShape(input) {
  const problems = [];
  const q = String((input && input.question) || "").trim();

  if (!input || !input.step || !input.finding) {
    problems.push({
      kind: "missing-finding",
      message:
        "a ticket is about one finding on one step (and usually one volume): it needs `step` and " +
        "`finding` (the `kind` from the post-mortem report). Without them the diagnostics team has " +
        "to guess which part of the run it is being asked about.",
    });
  }

  if (!q) {
    problems.push({
      kind: "no-question",
      message:
        "a ticket must ask a question. Write what you observed, what you already tried, what you " +
        "ruled out, and then ask why — e.g. \"Why is volume 15's glossary quarantined when it grew " +
        "from 445 terms to 460?\"",
    });
  } else {
    const sentences = q.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
    const hasQuestion = sentences.some(
      (s) => s.endsWith("?") || INTERROGATIVE_START.test(s)
    );
    if (!hasQuestion) {
      problems.push({
        kind: "not-a-question",
        matched: q.slice(0, 120),
        message:
          "a ticket must contain a question. It may report observations and eliminations, but the " +
          "part that reaches the diagnostics team is a question, not a summary. Add one: what is " +
          "happening, and why?",
      });
    }

    for (const s of sentences) {
      const first = (s.split(/\s+/)[0] || "").toLowerCase().replace(/[,.-]/g, "");
      if (DEMAND_VERBS.includes(first) && !s.endsWith("?")) {
        problems.push({
          kind: "demand",
          matched: s.slice(0, 120),
          message:
            `"${s.split(/\s+/)[0]}" is a command. The manager reports what it saw and asks a ` +
            "question; the diagnostics team decides what to change, and the dev team changes it. " +
            "Rewrite it as an observation plus a question.",
        });
        continue;
      }
      for (const phrase of OUTCOME_PHRASES) {
        const hit = s.match(phrase);
        if (hit) {
          problems.push({
            kind: "outcome-demanded",
            matched: hit[0],
            message:
              `A ticket may not state the result it wants ("${hit[0]}"). Whether the run improved ` +
              "is decided afterwards, by comparing the deliverable before and after — not by " +
              "whether the finding went away. Ask what is causing it instead.",
          });
          break;
        }
      }
    }

    // A ticket that asks for a banned thing is refused for the same reason the option would be,
    // and earlier: it saves the diagnostics team the work of writing it down.
    const banned = optionIsBanned(q);
    for (const r of banned.reasons) {
      problems.push({
        kind: "banned-requested",
        matched: r.matched,
        message: `A ticket may not ask for ${r.id}. ${r.because} If that really is the right ` +
          `answer, it goes to ${r.escalateTo}, not into a ticket.`,
      });
    }
  }

  if (!Array.isArray(input?.evidence) || input.evidence.length === 0) {
    problems.push({
      kind: "no-evidence",
      message:
        "a ticket must cite what it looked at (`evidence`: a file and one line about it). A " +
        "finding with no cited artifact is a feeling, and the diagnostics team would have to " +
        "re-derive it from the beginning.",
    });
  }

  return { ok: problems.length === 0, problems };
}

// ─── Reading and writing ──────────────────────────────────────────────────────

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
    volume: input.volume === undefined ? null : String(input.volume),
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
 * Every ticket about one finding — the question "has anyone already asked this?" before a
 * second ticket is opened for the same thing.
 * @param {{step: string, volume?: string|null, finding: string}} key
 * @param {{json?: string, markdown?: string}} [paths]
 * @returns {Ticket[]}
 */
function ticketsFor(key, paths = ticketPaths()) {
  const want = key.volume === undefined || key.volume === null ? null : String(key.volume);
  return readTickets(paths.json).tickets.filter(
    (t) =>
      t.step === key.step &&
      t.finding === key.finding &&
      (t.volume === undefined || t.volume === null ? null : String(t.volume)) === want
  );
}

// ─── The human-facing half ────────────────────────────────────────────────────

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
  if ((ticket.options || []).length) {
    lines.push(``, `**Options offered:**`);
    for (const o of ticket.options) {
      lines.push(
        `- **${o.label}** (${o.cost || "cost not stated"}${o.requiresCodeChange ? ", needs a code change" : ""})` +
          (o.touches && o.touches.length ? `\n  - touches: ${o.touches.join(", ")}` : "") +
          (o.risk ? `\n  - could break: ${o.risk}` : "") +
          (o.verify ? `\n  - how to verify: ${o.verify}` : "")
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
 * @param {Ticket[]} [tickets]
 * @returns {string}
 */
function renderTicketsMarkdown(tickets = readTickets().tickets) {
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
  BANNED_OPTIONS,
  ticketsEnabled,
  ticketPaths,
  optionIsBanned,
  filterOptions,
  validateTicketShape,
  triedFromLedger,
  readTickets,
  writeTickets,
  createTicket,
  attachOptions,
  recordChoice,
  closeTicket,
  openTickets,
  ticketsFor,
  renderTicketMarkdown,
  renderTicketsMarkdown,
};

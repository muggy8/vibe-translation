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
 * @property {boolean} [outcomeOnlyVerification] - Set by `utils/diagnostics.js` when `verify` names
 *   only the finding vanishing. Not a refusal: the before/after comparison of the deliverable is
 *   what rejects such an option (gotcha 70/73).
 */

/**
 * The diagnostics team's answer to a ticket — the half that is not the option list.
 *
 * Written by `recordDiagnosis`, which is the ONLY route from a model's reply to a ticket's options:
 * it calls `attachOptions` internally, so the banned-option filter cannot be stepped around.
 *
 * @typedef {Object} TicketDiagnosis
 * @property {string} cause - The mechanism, in language a customer can follow.
 * @property {string} [recommend] - Which option, and why.
 * @property {string[]} [questions] - Clarifying questions back to the manager.
 * @property {string} [ownerNote] - Prose for the account owner alone: the thing the manager may not
 *   be offered as an option.
 * @property {string[]} [read] - The files the team says it read.
 * @property {Array<{tool: string, path: string}>} [observedReads] - The files its turn ACTUALLY
 *   opened, taken from the agent's recorded tool calls. The claim and the record are both kept.
 * @property {string[]} [citedWithoutReading] - Claimed but never opened by that turn.
 * @property {Array<{tool: string, path: string, reason: string}>} [attemptedWrites] - Every write
 *   the read-only gate refused during that turn. A silently dropped attempt would be a support team
 *   that quietly edited the corpus it was asked about.
 * @property {number} [attempts] - How many times this ticket has been asked (1 on the first answer).
 * @property {string} at - ISO timestamp.
 */

/**
 * The manager's reply to one of the diagnostics team's questions.
 *
 * Validated on the ANSWER, not on the question: the manager may be asked anything, but it may only
 * answer from what a customer can see (see `customerMayRead`).
 *
 * @typedef {Object} TicketAnswer
 * @property {string} question - The question being answered, verbatim.
 * @property {string} answer
 * @property {string[]} cites - The files the answer points at. Every one must be customer-visible.
 * @property {string} at
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
 * @property {TicketDiagnosis} [diagnosis] - The diagnostics team's answer (see `recordDiagnosis`).
 * @property {TicketAnswer[]} [answers] - The manager's replies to the team's questions.
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
    // Both word orders, and the adjectival forms: "delete the quarantined file", "delete the
    // .rejected copy", "the quarantined glossary should be removed". A rule that only matches the
    // exact noun "quarantine" is a rule "quarantined" walks past.
    pattern:
      /\b(delete|remove|drop|clean|wipe|discard|purge|clear)\b[^\n]{0,40}\b(\.rejected|rejected[- .]?\w*|quarantin\w*|evidence|postmortem|post-mortem|report|\.logs)\b|\b(\.rejected|quarantin\w*|rejected (?:file|copy|glossary|artifact)|evidence)\b[^\n]{0,40}\b(delete|deleted|remove|removed|drop|dropped|wipe|wiped|discard|purge|gone)\b/i,
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
 * Phrases that name THE FINDING VANISHING as the whole check.
 *
 * Deliberately NOT a refusal, and deliberately kept here rather than only in the module that reads
 * the code: `Add the old spelling back as a second row` survives the banned-option filter on purpose
 * (gotcha 70) — it manufactures a duplicate, which is a judgment about the deliverable, not a guard
 * being switched off. The thing that rejects it is the before/after comparison of the deliverable
 * (utils/delivery-verify.js, gotcha 73). So this table FLAGS the shape on the option itself, where
 * every later reader — the manager, the human-readable report, the comparison — can see it.
 *
 * ONE table for the whole conversation, because the same shape arrives from three directions: an
 * option's `verify` (`filterOptions` here), a patch's `verify` (`validateProposalShape` in
 * utils/patches.js), and the manager's accept/reject reason (`judgmentReasonIsSound` there). Two
 * copies of a phrase list drift, and the drifted half is the one that stops catching things.
 */
const OUTCOME_ONLY_CHECK = [
  /\b(finding|error|warning|verdict|quarantine|complaint|failure)\b[^\n]{0,40}\b(disappear(?:s|ed)?|gone|goes away|clears?|stops|resolve[ds]?|fixed|fix(?:es)?)\b/i,
  /\b(the|this|that)\b[^\n]{0,20}\b(finding|error|warning|quarantine)\b[^\n]{0,20}\b(is|be)\b[^\n]{0,12}\b(gone|clear|resolved)\b/i,
  /\bno longer (reports|appears|shows|fails)\b/i,
  /\bcheck that (it|the finding|the error)\b[^\n]{0,30}\b(passes|is gone|is clean|disappears)\b/i,
  // "make volume 15 pass". The object list carries the volume/step spellings as well as the
  // `the volume` form, because the demand usually names the volume directly.
  /\b(make|make sure|ensure)\b[^\n]{0,30}\b(it|the step|the volume|the ticket|this step|this volume|volume \d+|step [a-z-]+)\b[^\n]{0,25}\b(pass|passes|passing)\b/i,
  /\bno more\b[^\n]{0,30}\b(findings?|errors?|warnings?|quarantines?|complaints?|HIGH)\b/i,
  // "volume 15 passes now", "the step is fixed", "it works". The same demand `validateTicketShape`
  // refuses on the manager's QUESTION, arriving from the other end of the conversation as a stated
  // check or a judgment reason (gotcha 70, and `judgmentReasonIsSound` in utils/patches.js).
  // The `(?![\w-])` after "the volume" is what keeps a real measurement from being read as a result:
  // "the volume-15 rename passes, and a deleted entry with no trace still fails" names a thing that
  // passes a test, which is evidence; "the volume passes now" names only the complaint stopping.
  /\b(?:it|this|the step|the volume(?![\w-])|the ticket|the run|volume \d+|step [a-z-]+)\b[^\n]{0,25}\b(passes|passed|works|succeeds|is fixed|is clean|is green|is resolved|is settled|is done)\b/i,
];

/**
 * Is this option's stated check "the finding disappears"?
 *
 * @param {string} verify
 * @returns {boolean}
 */
function verificationIsOutcomeOnly(verify) {
  const text = String(verify || "");
  return OUTCOME_ONLY_CHECK.some((re) => re.test(text));
}

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
      // The flag that the banned-option filter deliberately does NOT apply (gotcha 70): an option
      // whose only stated check is that the complaint stops. It is not refused here — the
      // before/after comparison of the deliverable is what rejects it (gotcha 73) — but it is
      // stamped here, on the way in, so every later reader (the manager, tickets.md, the closure)
      // can see that the option never promised a check on the book.
      allowed.push(
        verificationIsOutcomeOnly(option.verify)
          ? { ...option, outcomeOnlyVerification: true }
          : option
      );
    }
  }
  return { allowed, refused };
}

// ─── What the manager is allowed to have looked at ────────────────────────────

/**
 * The things a customer of this pipeline cannot see.
 *
 * This is the boundary the whole role split rests on: the delivery manager uses the product, it does
 * not maintain it. It may read the plan of record, what each volume folder holds, the step reports,
 * the ledger, the tickets and the publish report. It may not read the code, the prompts, or the run
 * transcripts — those are what the diagnostics team is FOR.
 *
 * The table is enforced on the manager's ANSWERS to the diagnostics team's questions
 * (`recordAnswer`), which is where the boundary would actually leak: a question like "does the
 * volume folder hold a `.rejected` file?" is fine, and the answer must cite a folder listing, not a
 * transcript. A question that cannot be answered from here is refused at the generator, in
 * `utils/diagnostics.js` — so the conversation cannot stall on something neither side can say.
 */
const MANAGER_EYES = [
  {
    id: "run-transcripts",
    pattern: /(^|[\\/])\.logs([\\/]|$)/,
    because:
      "the run transcripts are the diagnostics team's own material. A manager quoting a chat " +
      "history is quoting something it was not allowed to read.",
  },
  {
    id: "source-code",
    pattern: /\.(js|ts|mjs|cjs)\b/i,
    because: "the manager does not read the code. That is the diagnostics team's job.",
  },
  {
    id: "prompt-files",
    pattern: /(^|[\\/])(system|user)-prompts([\\/]|$)/,
    because: "the prompts are part of the product's internals, not part of what a customer sees.",
  },
  {
    id: "pipeline-hooks",
    pattern: /(^|[\\/])hooks([\\/]|$)/,
    because: "the per-machine hooks are this machine's configuration, and only the account owner changes them.",
  },
  {
    id: "this-module",
    pattern: /(^|[\\/])utils([\\/]|$)/,
    because: "the pipeline's own source lives under utils/ — the manager reads reports, not code.",
  },
];

/**
 * Can the manager cite this path?
 *
 * @param {string} filePath
 * @returns {{allowed: boolean, because: string|null, id: string|null}}
 */
function customerMayRead(filePath) {
  const text = String(filePath || "").replace(/\\/g, "/");
  if (!text.trim()) return { allowed: false, because: "an answer must name the file it is talking about", id: "no-path" };
  for (const rule of MANAGER_EYES) {
    if (rule.pattern.test(text)) return { allowed: false, because: rule.because, id: rule.id };
  }
  return { allowed: true, because: null, id: null };
}

/**
 * Compare two question strings. The manager quotes the question it is answering; small differences
 * in quoting (trailing punctuation, whitespace) are not a reason to refuse an honest answer.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameQuestion(a, b) {
  const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").replace(/[?.!]+$/, "").toLowerCase();
  return norm(a) === norm(b);
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
    maxSteps: Number(reply && reply.maxSteps) || null,
    usage: (reply && reply.usage) || null,
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
  MANAGER_EYES,
  OUTCOME_ONLY_CHECK,
  ticketsEnabled,
  ticketPaths,
  optionIsBanned,
  filterOptions,
  verificationIsOutcomeOnly,
  customerMayRead,
  validateTicketShape,
  triedFromLedger,
  readTickets,
  writeTickets,
  createTicket,
  attachOptions,
  recordDiagnosis,
  recordAnswer,
  unansweredQuestions,
  recordChoice,
  closeTicket,
  openTickets,
  ticketsFor,
  matchesTicketKey,
  sameQuestion,
  renderTicketMarkdown,
  renderTicketsMarkdown,
};

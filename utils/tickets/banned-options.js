/**
 * The filter, and why it sits on the option GENERATOR and not on the chooser: a manager given a menu picks the cheap item on it, so a rule about the manager's judgment written as a rule about the manager's judgment is not a rule (gotcha 70). Refused options are KEPT on the ticket — a dropped option looks like it was never thought of — and every refusal names the escalation: the account owner.
 *
 * Part of the tickets.js layer (split out of the original single file).
 */

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


module.exports = {
  BANNED_OPTIONS,
  OUTCOME_ONLY_CHECK,
  verificationIsOutcomeOnly,
  optionIsBanned,
  filterOptions,
};

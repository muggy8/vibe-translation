/**
 * The gate that refuses every illegal move by name with what IS available: a step not on the menu, an unknown or already-diagnosed ticket, an answer that cites utils/prompt.js, an answer that does not say which of several open questions it answers, a banned option, calling the dev team without a chosen code-changing option, "volume 15 passes now" as a judgment, a two-word escalation, and end on a state that is not finished.
 *
 * It normalises exactly one thing, and reports it: a `choose` whose `ticket` field names nothing but
 * whose `option` id contains a real ticket id (`repairTicketReference`). A mistyped name the state
 * already holds is a transcription slip, not an illegal move; everything else is refused as before.
 *
 * Part of the manager.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions
const { customerMayRead, sameQuestion, unansweredQuestions } = require("../tickets");
const { judgmentReasonIsSound, UNJUDGED_STATUSES } = require("../patches");

const { ACTION_BY_NAME } = require("./rules");

/**
 * The words in a sentence that look like a file path.
 *
 * Used to check a manager's ANSWER against `customerMayRead` (gotcha 74): the diagnostics team may
 * ask about anything it needs to, but a reply may only cite what a customer is allowed to have seen.
 * Two shapes are picked up — anything with a separator in it (`utils/prompt.js`, `hooks/pre-glossary.sh`,
 * `.logs/summary.log`), and any bare word with a code or document extension (`index.js`, `glossary.md`).
 *
 * Deliberately loose on the false-positive side: `1.5/2.5` and `01-03` come back as "paths" and pass
 * the check, because a refusal that accuses an honest answer is a check the next incident routes
 * around (gotcha 65).
 *
 * @param {string} text
 * @returns {string[]}
 */
function pathishWords(text) {
  const NAME = "[A-Za-z0-9_.\\-\\u3040-\\u30FF()]+";
  const re = new RegExp(
    `(?:${NAME}[\\\\/])+${NAME}|\\b${NAME}\\.(?:js|mjs|cjs|ts|md|json|txt|epub|sh|py)\\b`,
    "gi"
  );
  return (String(text || "").match(re) || []).map((w) => w.replace(/\\/g, "/"));
}


/**
 * A ticket id the model mistyped, when the rest of its own answer names the ticket exactly.
 *
 * Observed live on 2026-10-07: the manager chose `TCK-delivery-2026-10-06T18-27-38-632Z-1/O1` — the
 * right option, copied correctly — and named its ticket as
 * `TCK-delivery-2026-10-27-38-632Z-1`, dropping `T18` out of a 43-character id on the way. The gate
 * refused, the loop stopped, and the whole decision was thrown away over a transcription slip.
 *
 * A `choose` carries the ticket id twice: once in `ticket`, once as the prefix of `option`. When the
 * loose copy does not name an open ticket and the exact one does, the exact one wins, and the repair
 * is reported rather than hidden. This is not fuzzy matching and it is not a guess:
 * - only `choose` is considered, because it is the only move with a second field that contains the
 *   ticket id in full;
 * - the match is `option.startsWith(ticket.id + "/")` — the shape `utils/tickets.js` writes;
 * - it applies only when `ticket` names NOTHING, so an answer that names one real ticket and an
 *   option belonging to another is still refused, as `unknown-option`;
 * - it applies only when exactly one open ticket matches.
 *
 * Every other refusal in this module stays exactly as strict as it was: this repairs a name the
 * state already contains, never a move the state does not support.
 *
 * @param {ManagerAction} action - The parsed action.
 * @param {import("./tickets").Ticket[]} tickets - The open tickets.
 * @returns {{action: ManagerAction, repaired: {from: string, to: string}|null}}
 */
function repairTicketReference(action, tickets = []) {
  if (!action || action.action !== "choose" || !action.option) return { action, repaired: null };
  if ((tickets || []).some((t) => t && t.id === action.ticket)) return { action, repaired: null };

  const matches = (tickets || []).filter((t) => t && String(action.option).startsWith(`${t.id}/`));
  if (matches.length !== 1) return { action, repaired: null };

  return {
    action: { ...action, ticket: matches[0].id },
    repaired: { from: String(action.ticket || ""), to: matches[0].id },
  };
}


/**
 * Refuse a decision the current state does not support.
 *
 * This is the manager-side twin of `delivery.js`'s `gateMenu`, and it exists for the same reason:
 * `planResume` already only names menu entries, and `delivery.js` re-checks them at execution time,
 * because the proposal is a document and execution is the thing with consequences. A model's answer
 * is neither — it is the thing that decides which of them happens next.
 *
 * Every refusal names what WAS available, because a refusal that does not name the usable move is
 * the kind of refusal people switch off (gotcha 65).
 *
 * @param {ManagerAction} action - A parsed action.
 * @param {Object} ctx
 * @param {ManagerMove[]} ctx.moves - The offered menu.
 * @param {import("./tickets").Ticket[]} [ctx.tickets] - The open tickets.
 * @param {import("./patches").Patch[]} [ctx.patches] - The patches.
 * @param {import("./resume").ResumePlan} [ctx.plan] - Needed to prove `end`.
 * @returns {{allowed: boolean, why: string|null, kind: string|null}}
 */
function validateManagerAction(action, { moves = [], tickets = [], patches = [], plan = null }) {
  const refuse = (kind, why) => ({ allowed: false, why, kind });
  const spec = ACTION_BY_NAME.get(action.action);
  if (!spec) return refuse("unknown-action", `"${action.action}" is not a move the delivery manager may make.`);

  if (spec.offered) {
    const match = moves.find((m) => {
      if (m.kind !== action.action) return false;
      if (action.action === "run") return m.step === action.step;
      return true;
    });
    if (!match) {
      const offered = moves.filter((m) => m.kind === action.action).map((m) => m.label);
      return refuse(
        "not-offered",
        `there is no "${action.action}" move on the menu for this state.` +
          (offered.length
            ? ` The ${action.action} moves available are: ${offered.join(" | ")}.`
            : ` Nothing on this state supports a ${action.action} move right now.`)
      );
    }
  }

  const findTicket = (id) => tickets.find((t) => t.id === id);

  switch (action.action) {
    case "diagnose": {
      const ticket = findTicket(action.ticket);
      if (!ticket) {
        return refuse(
          "unknown-ticket",
          `there is no open ticket ${action.ticket}. Open tickets: ${tickets.map((t) => t.id).join(", ") || "none"}. ` +
            `A ticket is opened by the triage when a re-run stops working, not by you on request.`
        );
      }
      if (ticket.diagnosis) {
        return refuse(
          "already-answered",
          `ticket ${ticket.id} has already been answered${ticket.diagnosis.attempts ? ` (${ticket.diagnosis.attempts} time(s))` : ""}. ` +
            `A second diagnosis of the same ticket is the account owner's call (\`diagnose.js --reask\`), not yours. ` +
            `Your moves here are: answer their question, choose an option, or escalate.`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    case "answer": {
      const ticket = findTicket(action.ticket);
      if (!ticket) {
        return refuse("unknown-ticket", `there is no open ticket ${action.ticket}.`);
      }
      const asked = (ticket.diagnosis && ticket.diagnosis.questions) || [];
      if (!asked.length) {
        return refuse(
          "no-question",
          `ticket ${ticket.id} asked you nothing, so there is nothing to answer. Its options are what you have to work with.`
        );
      }
      const open = unansweredQuestions(ticket);
      if (!open.length) {
        return refuse(
          "already-answered",
          `every question on ticket ${ticket.id} has been answered once already. Each question is answered exactly once: ` +
            "if an answer was wrong or incomplete, say so in the next request for a diagnosis (`diagnose.js --reask`) rather than overwrite it."
        );
      }
      // WHICH question is being answered is part of the decision, not a detail: a ticket can hold
      // several open questions, `recordAnswer` matches one exactly, and `diagnose.js` refuses to guess
      // when there is more than one. Naming it here means the loop can pass the team's own wording
      // through rather than the manager's paraphrase of it.
      let question = null;
      if (action.question) {
        question = open.find((q) => sameQuestion(q, action.question));
        if (!question) {
          if (asked.some((q) => sameQuestion(q, action.question))) {
            return refuse(
              "already-answered",
              `"${action.question}" is already answered on ticket ${ticket.id}. Every question is answered once.`
            );
          }
          return refuse(
            "unknown-question",
            `"${action.question}" is not a question ticket ${ticket.id} asked. It is waiting on: ${open
              .map((q) => `"${q}"`)
              .join(" / ")}.`
          );
        }
      } else if (open.length > 1) {
        return refuse(
          "question-unnamed",
          `ticket ${ticket.id} has ${open.length} open questions, so an answer has to say which one it answers: ${open
            .map((q) => `"${q}"`)
            .join(" / ")}.`
        );
      } else {
        question = open[0];
      }
      // The boundary is checked on the ANSWER, not the question (gotcha 74). Anything in the reply
      // that looks like a path goes through `customerMayRead`, so a manager cannot answer by quoting
      // the code it is not allowed to have read.
      for (const file of pathishWords(String(action.answer))) {
        const read = customerMayRead(file);
        if (!read.allowed) {
          return refuse(
            "cited-forbidden",
            `your answer cites ${file}: ${read.because} Answer from the volume folders, the reports, or the plan of record.`
          );
        }
      }
      return { allowed: true, why: null, kind: null, question };
    }

    case "choose": {
      const ticket = findTicket(action.ticket);
      if (!ticket)
        return refuse(
          "unknown-ticket",
          `there is no open ticket ${action.ticket}. Open tickets: ${tickets.map((t) => t.id).join(", ") || "none"}. ` +
            `The option id you named carries the ticket id inside it — copy the whole thing from the menu.`
        );
      if (!ticket.diagnosis) {
        return refuse("not-answered", `ticket ${ticket.id} has no answer yet, so it has no options. Ask the diagnostics team first.`);
      }
      const option = (ticket.options || []).find((o) => o.id === action.option);
      if (!option) {
        const refused = (ticket.refusedOptions || []).find((r) => r.option.id === action.option);
        if (refused) {
          return refuse(
            "banned-option",
            `option ${action.option} was refused when it was offered: ${refused.because} It goes to ${refused.escalateTo}. ` +
              `The allowed options are: ${(ticket.options || []).map((o) => o.id).join(", ") || "none"}.`
          );
        }
        return refuse(
          "unknown-option",
          `there is no option ${action.option} on ticket ${ticket.id}. The allowed ones are: ${
            (ticket.options || []).map((o) => o.id).join(", ") || "none"
          }.`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    case "fix": {
      const ticket = findTicket(action.ticket);
      if (!ticket) return refuse("unknown-ticket", `there is no open ticket ${action.ticket}.`);
      if (!ticket.choice) {
        return refuse(
          "not-chosen",
          `ticket ${ticket.id} has no chosen option. You call in the dev team by CHOOSING an option marked ` +
            `"needs the dev team", never by describing a fix.`
        );
      }
      const option = (ticket.options || []).find((o) => o.id === ticket.choice.optionId);
      if (!option || !option.requiresCodeChange) {
        return refuse(
          "option-not-code",
          `the option you chose on ${ticket.id} (${ticket.choice.optionId}) does not require a code change. ` +
            `The dev team is for the options that do.`
        );
      }
      const existing = patches.find((p) => p.ticketId === ticket.id);
      if (existing) {
        return refuse(
          "patch-exists",
          `ticket ${ticket.id} already has patch ${existing.id} (${existing.status}). One team at a time, and an ` +
            `unjudged patch already gates the pipeline. Judge ${existing.id} first.`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    case "judge": {
      const patch = patches.find((p) => p.id === action.patch);
      if (!patch) {
        return refuse(
          "unknown-patch",
          `there is no patch ${action.patch} waiting for a judgment. Waiting: ${
            patches.filter((p) => UNJUDGED_STATUSES.includes(p.status)).map((p) => p.id).join(", ") || "none"
          }.`
        );
      }
      if (!UNJUDGED_STATUSES.includes(patch.status)) {
        return refuse(
          "already-judged",
          `patch ${patch.id} is ${patch.status}; it has already been decided${
            patch.decision ? ` (${patch.decision.outcome}: ${patch.decision.reason})` : ""
          }. A decision is not re-made.`
        );
      }
      const sound = judgmentReasonIsSound(action.reason);
      if (!sound.ok) {
        return refuse(
          "unsound-reason",
          `that is not a judgment about the patch: it says the complaint stopped, not what the change does. ` +
            `Judge the change — which mechanism it fixes, which deliverable signal it expects to move, what it ` +
            `could break (gotcha 70).`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    case "escalate": {
      const note = String(action.note || "").trim();
      if (note.length < 20) {
        return refuse(
          "thin-escalation",
          `an escalation has to say what the account owner is being asked to decide, in a sentence they can act ` +
            `on. ${note.length} characters is not that.`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    case "end": {
      const proof = endIsProvable({ plan, tickets, patches });
      if (!proof.provable) {
        return refuse(
          "end-not-provable",
          `you may not end this run: ${proof.reasons.join("; ")}. "Nothing left to complain about" is not the ` +
            `test — the records are.`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    default:
      return { allowed: true, why: null, kind: null };
  }
}

// ─── The two claims that have to be proved ────────────────────────────────────


/**
 * Is "the run is finished" provable?
 *
 * Four things, all read out of records this layer already wrote:
 * 1. the triage's own verdict is `nothing-to-do` — every step left what it claims to have, and no
 *    unread gate evidence is lying in a volume folder (gotcha 71: evidence is not damage, but it is
 *    not nothing either);
 * 2. no ticket is open — an unanswered question with the teams is an unfinished piece of work;
 * 3. no patch is unjudged — an unjudged patch is live code in the tree (gotcha 75);
 * 4. the deliverable is clean — no chapter MISSING and no chapter published UNVERIFIED. Every step
 *    can finish while the book is not finished, and `planResume` says so in its notes; a manager that
 *    calls that "done" is reporting a book it never read.
 *
 * `EMPTY IN SOURCE` is deliberately NOT a failure here: a hole in the book is a fact about the
 * source, not a failure of the run (gotcha 40), and refusing to end over it would mean no series with
 * an image-only page could ever be reported as finished.
 *
 * @param {Object} args
 * @param {import("./resume").ResumePlan|null} [args.plan]
 * @param {import("./tickets").Ticket[]} [args.tickets]
 * @param {import("./patches").Patch[]} [args.patches]
 * @returns {{provable: boolean, reasons: string[]}}
 */
function endIsProvable({ plan = null, tickets = [], patches = [] }) {
  const reasons = [];
  if (!plan) {
    return { provable: false, reasons: ["there is no triage to read: the plan of record could not be read"] };
  }
  if (plan.verdict !== "nothing-to-do") {
    reasons.push(
      `the triage's own verdict is "${plan.verdict}"${plan.headline ? ` — ${plan.headline}` : ""}`
    );
  }
  const open = (tickets || []).filter((t) => t.status !== "closed");
  if (open.length) {
    reasons.push(`${open.length} ticket(s) still open: ${open.map((t) => `${t.id} (${t.status})`).join(", ")}`);
  }
  const unjudged = (patches || []).filter((p) => UNJUDGED_STATUSES.includes(p.status));
  if (unjudged.length) {
    reasons.push(`${unjudged.length} patch(es) in the working tree without your judgment: ${unjudged.map((p) => `${p.id} (${p.status})`).join(", ")}`);
  }
  const d = plan.deliverable;
  if (d && d.counts) {
    const c = d.counts;
    if (c.missing) reasons.push(`${c.missing} chapter(s) MISSING from the published book`);
    if (c.unverified) reasons.push(`${c.unverified} chapter(s) published UNVERIFIED`);
  }
  return { provable: reasons.length === 0, reasons };
}

/**
 * A patch this loop may accept without a human.
 *
 * The account owner's decision of 2026-10-06: an unattended run may accept a patch on its own when
 * the change is **ordinary project code**, the **pinned checks are green**, and the deliverable does
 * not regress. Anything else stops and waits. This is that boundary, written as data.
 *
 * What the banned-path table already guarantees (guard tables, their tests, `hooks/`, `.env`, the
 * machine state, the corpus, anything outside `ai-client/`) is assumed here and not re-litigated.
 * What it does NOT cover is the rest of what judges this pipeline, and those are the entries below:
 * a patch that edits the thresholds, the sandbox, the runner, or a test is a patch that changed the
 * evidence its own acceptance rests on — and `npm test` going green afterwards proves nothing,
 * because the test is now the one the patch wrote.
 *
 * @typedef {Object} AutoAcceptVerdict
 * @property {boolean} safe
 * @property {string[]} reasons - Every reason it is NOT safe (empty when safe).
 * @property {string[]} notes - What was checked, so a report can show the basis of an unattended accept.
 */


module.exports = {
  pathishWords,
  repairTicketReference,
  validateManagerAction,
  endIsProvable,
};

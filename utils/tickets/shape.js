/**
 * A ticket is a question with its evidence attached, never a demanded result. The check is a SHAPE check, not a mind reader: it catches the forms a demand actually takes and says what to write instead.
 *
 * Part of the tickets.js layer (split out of the original single file).
 */

const { optionIsBanned } = require("./banned-options");

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


module.exports = {
  DEMAND_VERBS,
  OUTCOME_PHRASES,
  INTERROGATIVE_START,
  validateTicketShape,
};

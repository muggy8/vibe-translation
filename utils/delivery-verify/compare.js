/**
 * utils/delivery-verify/compare.js — the one answer to "did it help?".
 *
 * Two snapshots in, one verdict out, plus the three ways that verdict is read: a
 * line of prose for the log, an account for the ledger, and a closure for the
 * ticket. act mode's ledger entry and a ticket's closure both come from here, so
 * "better / the same / worse" has exactly one meaning in this codebase.
 *
 * It never judges whether an artifact is GOOD — that is the scored gates' job —
 * and it never decides what to do about a regression.
 */

const { DELIVERABLE_SIGNALS } = require("./signals");

/** @typedef {import("../delivery-verify").DeliverableSnapshot} DeliverableSnapshot */
/** @typedef {import("../delivery-verify").SignalMovement} SignalMovement */

// ─── The comparison ───────────────────────────────────────────────────────────

/**
 * Compare two measurements of the deliverable.
 *
 * The verdict rule, stated plainly because it is the thing a reader must be able to check:
 *   **any veto-eligible regression ⇒ `worse`, whatever else improved;**
 *   otherwise any improvement ⇒ `improved`;
 *   otherwise `unchanged`.
 *
 * A regression beating an improvement is not caution, it is the acceptance criterion: the fix
 * this module exists to reject is the one that removes a finding while shrinking the deliverable
 * (gotcha 70), and a rule that averaged the two would call it a net win.
 *
 * @param {DeliverableSnapshot} before
 * @param {DeliverableSnapshot} after
 * @returns {{
 *   outcome: ("improved"|"unchanged"|"worse"),
 *   movements: SignalMovement[],
 *   regressions: SignalMovement[],
 *   improvements: SignalMovement[],
 *   noted: SignalMovement[],
 *   notComparable: SignalMovement[],
 * }}
 */
function compareDeliverable(before, after) {
  const movements = [];

  for (const signal of DELIVERABLE_SIGNALS) {
    const from = signal.get(before);
    const to = signal.get(after);

    let reason = null;
    if (signal.comparable) {
      const ok = signal.comparable(before, after);
      if (ok !== true) reason = typeof ok === "string" ? ok : "the two sides are not comparable";
    }
    // The backstop: a signal that produced no number on one side cannot be compared, whatever its
    // own precondition said. Comparing `null` against a number is how a read failure becomes a
    // phantom regression — `null > 1` is false, so a missing measurement reads as damage.
    if (reason === null && (from === null || to === null || from === undefined || to === undefined)) {
      reason = "nothing measurable on both sides";
    }

    if (reason) {
      movements.push({
        name: signal.name,
        label: signal.label,
        direction: "none",
        veto: signal.veto,
        comparable: false,
        from: typeof from === "number" ? from : null,
        to: typeof to === "number" ? to : null,
        why: `${signal.why} — not compared: ${reason}`,
      });
      continue;
    }

    let direction = "none";
    if (to !== from) direction = (to > from) === (signal.betterWhen === "up") ? "better" : "worse";

    movements.push({
      name: signal.name,
      label: signal.label,
      direction,
      veto: signal.veto,
      comparable: true,
      from,
      to,
      why: signal.why,
    });
  }

  const regressions = movements.filter((m) => m.direction === "worse" && m.veto);
  const improvements = movements.filter((m) => m.direction === "better" && m.veto);
  const noted = movements.filter((m) => m.direction !== "none" && !m.veto);
  const notComparable = movements.filter((m) => !m.comparable);

  const outcome = regressions.length ? "worse" : improvements.length ? "improved" : "unchanged";
  return { outcome, movements, regressions, improvements, noted, notComparable };
}

/**
 * The comparison as the lines a human reads.
 *
 * Every signal that moved is printed, including the ones that cannot decide anything, and every
 * signal that could not be compared is printed with its reason. A verdict with no account next
 * to it is a verdict nobody can argue with.
 *
 * @param {ReturnType<typeof compareDeliverable>} comparison
 * @returns {string[]}
 */
function describeComparison(comparison) {
  const lines = [];
  const skipped = new Map();
  for (const m of comparison.movements) {
    if (!m.comparable) {
      const reason = m.why.split(" — not compared: ")[1] || m.why;
      skipped.set(reason, (skipped.get(reason) || []).concat(m.label));
      continue;
    }
    if (m.direction === "none") continue;
    const mark =
      m.direction === "worse"
        ? m.veto
          ? "WORSE"
          : "worse (reported only)"
        : "better";
    lines.push(`  – ${m.label}: ${m.from} → ${m.to}  [${mark}]`);
  }
  for (const [reason, labels] of skipped) {
    lines.push(`  – ${labels.length > 1 ? `${labels.length} signals` : labels[0]}: not compared — ${reason}`);
  }
  if (comparison.regressions.length) {
    lines.push(
      `  damage outranks whatever improved: ${comparison.regressions.map((r) => r.label).join(", ")} — ` +
        "an intervention that shrinks the deliverable is not a fix, whatever it removed."
    );
  }
  return lines;
}

/**
 * The compact account of a snapshot, for storing next to a ledger entry or a ticket.
 *
 * The full snapshot is a measurement of a whole series; this is the handful of numbers a human
 * (or the diagnostics team, later) needs in order to see what moved.
 *
 * @param {DeliverableSnapshot} snapshot
 * @returns {Object}
 */
function summarizeSnapshot(snapshot) {
  const ref = snapshot.reference || {};
  return {
    published: snapshot.book ? snapshot.book.published : null,
    unverified: snapshot.book ? snapshot.book.unverified : null,
    missing: snapshot.book ? snapshot.book.missing : null,
    glossaryTerms: ref.glossary ? ref.glossary.termsTotal : null,
    glossaryHeadVolume: ref.glossary ? ref.glossary.headVolume : null,
    voiceSections: ref["character-voice"] ? ref["character-voice"].headCharacterSections : null,
    styleCategories: ref["style-guide"] ? ref["style-guide"].headSections : null,
    wikiChapters: ref["jump-in-wiki"] ? ref["jump-in-wiki"].chaptersHandedOff : null,
  };
}

/**
 * The account: what moved, in one line.
 *
 * The verdict is useless without it. "worse" is a decision; "glossary terms carried 445→412" is
 * the thing a human can agree or disagree with, and the thing the diagnostics team needs in order
 * to start anywhere near the right place.
 *
 * @param {ReturnType<typeof compareDeliverable>} comparison
 * @returns {string}
 */
function accountOf(comparison) {
  const moved = comparison.movements.filter((m) => m.comparable && m.direction !== "none");
  if (!moved.length) return "nothing in the deliverable moved";
  return moved
    .map((m) => `${m.label} ${m.from} → ${m.to}${m.direction === "worse" && m.veto ? " [damage]" : ""}`)
    .join("; ");
}

/**
 * The closure payload `utils/tickets.js` accepts, produced from the same comparison act mode
 * records.
 *
 * This is the seam the plan asked for: "did it help?" has one answer in this codebase. A ticket
 * cannot close as `finding-gone` (that is already refused by `closeTicket`), and it must not be
 * closed on a different measurement than the one the ledger recorded — so the outcome and the
 * note both come from here.
 *
 * @param {ReturnType<typeof compareDeliverable>} comparison
 * @param {string} [note] - Whoever is closing the ticket adds what they did; the measurement
 *   cannot be edited by the person it is judging.
 * @returns {{outcome: ("improved"|"unchanged"|"worse"), note: string}}
 */
function closureFromComparison(comparison, note = "") {
  const parts = [`measured on the deliverable: ${comparison.outcome}`, accountOf(comparison)];
  if (comparison.regressions.length) {
    parts.push(`refused as a fix because it damaged: ${comparison.regressions.map((r) => r.label).join(", ")}`);
  }
  if (comparison.notComparable.length) {
    parts.push(`${comparison.notComparable.length} signal(s) could not be compared`);
  }
  if (note) parts.push(note);
  return { outcome: comparison.outcome, note: parts.join(". ") };
}

module.exports = {
  compareDeliverable,
  describeComparison,
  summarizeSnapshot,
  accountOf,
  closureFromComparison,
};

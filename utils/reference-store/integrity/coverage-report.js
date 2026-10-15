/**
 * utils/reference-store/integrity/coverage-report.js — the two findings the coverage question
 * produces, one per severity group.
 *
 * The measurement is in `coverage.js`; this is the half that writes them into the post-mortem:
 * the HIGH group is the stop, the MEDIUM group is the price of softening that stop and is
 * printed in full. The line it quotes is the constant in `coverage.js`, not a copy of it.
 *
 * **The two groups are not two levels.** Since plan 06 slice 9 (2026-10-15) the MEDIUM group is a
 * `NOTE` in `utils/postmortem/levels.js`: it names every character this volume's text puts on a page and
 * the reference says nothing about, and it stops nothing. "Is this character worth an investigation?" is
 * not a per-book question — it is taken once, after the last volume, by the closing cast reconciliation
 * (`character-voice/reconcile.js`), which asks it over the settled record. The HIGH group is unchanged
 * and remains a stop.
 *
 * @module utils/reference-store/integrity/coverage-report
 */

const { finding } = require("../../postmortem");
const { COVERAGE_SIGNIFICANCE_CHAPTERS } = require("./coverage");

require("../../../types"); // JSDoc type definitions

/**
 * The two findings the coverage question produces, one per severity group.
 *
 * Split rather than merged, because the two groups need different things from the reader: the HIGH
 * group is the stop — a reference that lost characters the volume and the extraction both say are
 * there, which is the defect that killed the last run. The MEDIUM group is the price of softening
 * that stop, and it is printed in full: every name, and for each one the signal that was missing.
 * A main character wrongly softened has to be visible to a human reading the report, because a
 * number in a query is not.
 *
 * @param {Object} ctx - The store context, for the roster count.
 * @param {Array<Object>} uncovered - The rows from `uncoveredCharacters`.
 * @param {number} upTo - The volume the roster is counted over.
 * @param {string} step - Finding step name.
 * @param {string|null} volume - Finding volume label.
 * @returns {PostMortemFinding[]}
 */
function coverageFindings(ctx, uncovered, upTo, step, volume) {
  if (uncovered.length === 0) return [];
  const roster = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM cast WHERE (first_seen_volume IS NULL OR first_seen_volume <= ?) AND merged_into IS NULL")
    .get(Number(upTo)).n;
  const significant = uncovered.filter((row) => row.severity === "HIGH");
  const mentions = uncovered.filter((row) => row.severity === "MEDIUM");
  const out = [];

  if (significant.length) {
    const basis = significant[0].measured
      ? `the volume's own text contains them, and they are in the book rather than barely in it`
      : `presence has not been measured for this volume, so every uncovered cast entry is reported`;
    out.push(
      finding(
        "HIGH",
        "reference-voice-covers-fewer-characters",
        step,
        volume,
        "series.db",
        `the cast holds ${roster} character(s) but ${significant.length} of them have no character-voice claim ` +
          `at all, and ${basis}: ${significant.map((row) => `${row.key} — ${row.why}`).join("; ")}. A ` +
          "character-voice reference that covers fewer characters than the roster is a damaged reference, " +
          "and importing it faithfully reproduces the damage."
      )
    );
  }

  if (mentions.length) {
    out.push(
      finding(
        "MEDIUM",
        "reference-voice-mention-not-covered",
        step,
        volume,
        "series.db",
        `${mentions.length} character(s) on the roster have no character-voice claim and are only mentioned in ` +
          `this volume's text, so this is reported and not blocked: ${mentions.map((row) => `${row.key} — ${row.why}`).join("; ")}. ` +
          `The line is ${COVERAGE_SIGNIFICANCE_CHAPTERS} chapters or one claim from the extraction. If either ` +
          "signal is wrong for one of these names — a main character the book happens to name once — the fix is " +
          "to give them an entry, not to move the line. " +
          "This is a per-book note: the level table calls it NOTE (plan 06 slice 9), so it pauses nothing. " +
          "Whether any of these names is worth an investigation is decided once, after the last volume, by " +
          "the closing cast reconciliation (character-voice/reconcile.js), which re-asks the whole roster " +
          "over the settled record and prints every one of them either way."
      )
    );
  }

  return out;
}

module.exports = {
  coverageFindings,
};

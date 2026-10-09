/**
 * utils/qa-loop/acceptance.js — the grading half of a QA loop iteration: take
 * one grade, put it in the rolling window, persist the window, and try the two
 * cheap acceptances before the loop pays for a rewrite.
 *
 * Both QA loops (whole-installment and chapter-by-chapter) run exactly this
 * sequence, which is why it lives here once: the two loops used to carry their
 * own copy, and the copies had already drifted (only the whole-installment one
 * recorded HOW it accepted when the rolling window met the criterion).
 *
 * The `tally` is the same lesson on the other side of the boundary. A grade the
 * grader refused to produce is dropped from the window and logged, and a log line is
 * gone when the process is. The tally counts every grade asked for and every one that
 * came back unusable, and it is persisted with the window, so "this volume's grader
 * answered nothing usable 3 times" is a fact on disk that the after-run audit can read.
 *
 * Part of the utils/qa-loop.js layer (split out of the original single file).
 */

const {
  ACCEPTANCE_WINDOW_SIZE,
  ACCEPTANCE_PASSING_SCORE,
  computeRollingAverage,
  meetsAcceptanceCriteria,
  saveRollingState,
  gradeTallyFields,
  tallyGrade,
} = require("../../configs/shared");
const { confirmExceptionalScore, confirmPassingScore } = require("./consensus");

/**
 * Grade the artifact once and decide what the loop should do next.
 *
 * The order is the order that saves the most work:
 *   1. the grade goes into the rolling window (an unparseable reply is a failed
 *      check and is not stored — fail-closed);
 *   2. the window is persisted, so a crash or a re-run recovers it without
 *      re-calling the AI;
 *   3. a top-band grade is confirmed by re-grading (no rewrite needed);
 *   4. the ordinary criterion is checked;
 *   5. a passing grade in a short window is completed by re-grading the same
 *      artifact instead of rewriting it.
 * Only when all five fail does the caller run its feedback round.
 *
 * @param {{
 *   iteration: number|string,
 *   volumeLabel: string,
 *   stateFile: string,
 *   recentRollingScores: number[],
 *   sourceFingerprint?: string,
 *   tally?: {attempts: number, failures: number},
 *   acceptanceCheck: (iteration: number|string) => Promise<number|null>,
 *   confirmationCheck?: (p: {score: number, index: number, temperature: number|undefined}) => Promise<number|null|{score: number|null, temperature: number}>,
 * }} p
 * @returns {Promise<{accepted: boolean, acceptedBy: string|null, score: number|null, scores: number[]}>}
 *   `accepted` when the loop should stop before its feedback round, and `acceptedBy`
 *   naming which of the three ways out it took.
 */
async function scoreAndConfirm({
  iteration,
  volumeLabel,
  stateFile,
  recentRollingScores,
  sourceFingerprint,
  tally,
  acceptanceCheck,
  confirmationCheck,
}) {
  // Acceptance check (always one-shot, tool-less).
  const score = await acceptanceCheck(iteration);

  // Every grade asked for is counted, usable or not. A null is a failed check: it is
  // not stored in the window (fail-closed), but it IS recorded, because "the grader
  // answered nothing four times for this volume" is a fact the next run needs and the
  // window alone cannot tell a refused grade apart from a grade that never happened.
  tallyGrade(tally, score);

  // Record the score in the rolling window (null = unparseable, already logged
  // as a failure by the task's own check; not stored).
  if (score !== null) {
    recentRollingScores.push(score);
    if (recentRollingScores.length > ACCEPTANCE_WINDOW_SIZE) recentRollingScores.shift();
  }

  // Persist the rolling window to disk so that a re-run can recover the exact
  // acceptance state without re-calling the AI. Saved on every iteration —
  // including the accepting one — so the idempotency skip-check sees the final
  // state.
  await saveRollingState(stateFile, recentRollingScores, {
    sourceFingerprint,
    ...gradeTallyFields(tally),
  });

  // ── Exceptional score: is it real, or a fluke? ─────────────────────────────
  const exceptional = await confirmExceptionalScore({
    score,
    recentRollingScores,
    confirmationCheck,
    volumeLabel,
    stateFile,
    sourceFingerprint,
    tally,
  });
  if (exceptional.accepted) {
    return { accepted: true, acceptedBy: "exceptional-consensus", score, scores: recentRollingScores };
  }

  // Check the acceptance criterion: if we have enough samples and the window
  // meets it, accept and stop (skip the feedback round).
  if (meetsAcceptanceCriteria(recentRollingScores)) {
    const avg = computeRollingAverage(recentRollingScores);
    console.log(
      `${volumeLabel}: rolling average ${avg.toFixed(1)}/100 ` +
        `(${recentRollingScores.length} checks) meets the passing score ` +
        `${ACCEPTANCE_PASSING_SCORE}. Accepted.`
    );
    await saveRollingState(stateFile, recentRollingScores, {
      sourceFingerprint,
      acceptedBy: "rolling-window",
      ...gradeTallyFields(tally),
    });
    return { accepted: true, acceptedBy: "rolling-window", score, scores: recentRollingScores };
  }

  // The window is short, but the grade we just got ALREADY passes. Buy the
  // remaining samples by re-grading the same artifact instead of paying for a
  // feedback rewrite plus a full validator turn to obtain them (measured live:
  // 2.63M + 8.4M tokens for a second sample that a 55k-token grade produces).
  const passing = await confirmPassingScore({
    score,
    recentRollingScores,
    confirmationCheck,
    volumeLabel,
    stateFile,
    sourceFingerprint,
    tally,
  });
  if (passing.accepted) {
    return { accepted: true, acceptedBy: "passing-consensus", score, scores: recentRollingScores };
  }

  return { accepted: false, acceptedBy: null, score, scores: recentRollingScores };
}

module.exports = { scoreAndConfirm };

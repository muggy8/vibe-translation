/**
 * utils/qa-loop/consensus.js — the two cheap ways a QA loop can accept a volume
 * without paying for a rewrite: re-grade an exceptional score to prove it is not
 * a fluke, and re-grade a passing score to fill the acceptance window.
 *
 * Part of the utils/qa-loop.js layer (split out of the original single file).
 */

const {
  ACCEPTANCE_MIN_SAMPLES,
  ACCEPTANCE_SAMPLE_FLOOR,
  ACCEPTANCE_PASSING_SCORE,
  ACCEPTANCE_CONFIRMATION_CHECKS,
  ACCEPTANCE_CONFIRM_ON_PASSING,
  ACCEPTANCE_EXCEPTIONAL_SCORE,
  ACCEPTANCE_WINDOW_SIZE,
  computeRollingAverage,
  meetsAcceptanceCriteria,
  meetsExceptionalCriteria,
  isExceptionalScore,
  saveRollingState,
} = require("../../configs/shared");

/**
 * The exceptional-score confirmation, shared by the whole-installment QA loop and
 * the four chunked (per-chapter) loops.
 *
 * A grade in the rubric's top band (≥ ACCEPTANCE_EXCEPTIONAL_SCORE) is re-graded
 * ACCEPTANCE_CONFIRMATION_CHECKS more times on the SAME artifact — the first
 * re-grade at temperature 0 (the deterministic anchor), the rest at the calm
 * judging temperature. If the consensus holds, the volume is accepted NOW: no
 * feedback pass, no second full validator turn (the expensive part of a loop
 * iteration). If it collapses, the scores stay in the window and the normal loop
 * continues — the great grade was luck.
 *
 * The chunked fallback used to run its own acceptance check with none of this, so
 * a big epub volume (the ones most worth fast-accepting) never got the
 * confirmation path at all, and a fluke grade there cost a full extra
 * per-chapter feedback round.
 *
 * @param {{
 *   score: number|null,
 *   recentRollingScores: number[],
 *   confirmationCheck?: (p: {score: number, index: number, temperature: number|undefined}) => Promise<number|null|{score: number|null, temperature: number}>,
 *   volumeLabel: string,
 *   stateFile: string,
 *   sourceFingerprint?: string,
 * }} p
 * @returns {Promise<{accepted: boolean, confirmations: Array<{score: number|null, temperature: number|null}>}>}
 *   `accepted` when the consensus held and the caller should stop its loop.
 */
async function confirmExceptionalScore({ score, recentRollingScores, confirmationCheck, volumeLabel, stateFile, sourceFingerprint }) {
  if (score === null || !confirmationCheck || !isExceptionalScore(score)) {
    return { accepted: false, confirmations: [] };
  }
  console.log(
    `${volumeLabel}: acceptance score ${score}/100 is exceptional (≥ ${ACCEPTANCE_EXCEPTIONAL_SCORE}) ` +
      `— confirming with ${ACCEPTANCE_CONFIRMATION_CHECKS} more grade(s) (one at temperature 0)…`
  );
  const confirmations = [];
  for (let ci = 0; ci < ACCEPTANCE_CONFIRMATION_CHECKS; ci++) {
    // The FIRST confirmation is always the deterministic one.
    const temperature = ci === 0 ? 0 : undefined;
    const raw = await confirmationCheck({ score, index: ci, temperature });
    // A task may return the bare score (its acceptanceCheck does) or a
    // { score, temperature } pair; both are normalized here so the loop — and the
    // temperature-0 anchor rule — cannot depend on which one a task happened to use.
    const confirmationScore = raw !== null && typeof raw === "object" ? raw.score : raw;
    const confirmationTemperature =
      raw !== null && typeof raw === "object" && Number.isFinite(raw.temperature)
        ? raw.temperature
        : temperature ?? null;
    confirmations.push({
      score: Number.isFinite(confirmationScore) ? confirmationScore : null,
      temperature: confirmationTemperature,
    });
  }
  // The confirmation scores are NOT pushed into the rolling window. They exist to
  // answer one question — was the exceptional grade real? — and if the answer is
  // no, the volume must continue through exactly the loop it would have run anyway
  // (feedback pass, next validator turn). Letting extra samples into the window
  // could accept a volume whose consensus just failed, without ever running the
  // feedback that failure calls for.
  const verdict = meetsExceptionalCriteria(score, confirmations);
  const spread = confirmations
    .map((c) => `${c.score === null ? "unparseable" : c.score}${c.temperature === 0 ? " (temp 0)" : ""}`)
    .join(", ");
  if (verdict.accepted) {
    console.log(
      `${volumeLabel}: exceptional score confirmed (${score}; confirmations: ${spread}) — ` +
        `${verdict.reason}. Accepted without a feedback pass.`
    );
    await saveRollingState(stateFile, recentRollingScores, {
      sourceFingerprint,
      acceptedBy: "exceptional-consensus",
      deterministicScore: confirmations.find((c) => c.temperature === 0)?.score,
      confirmations: confirmations.map((c) => c.score),
    });
    return { accepted: true, confirmations };
  }
  console.log(
    `${volumeLabel}: exceptional score NOT confirmed (${score}; confirmations: ${spread}) — ${verdict.reason}. ` +
      `Continuing the normal loop (the confirmation grades are recorded, not counted).`
  );
  await saveRollingState(stateFile, recentRollingScores, {
    sourceFingerprint,
    rejectedConfirmations: confirmations.map((c) => c.score),
  });
  return { accepted: false, confirmations };
}

/**
 * Collect the acceptance window's MISSING samples by re-grading the same artifact,
 * instead of buying them with a full feedback round plus a full validator turn.
 *
 * The problem this removes: acceptance needs `ACCEPTANCE_MIN_SAMPLES` scores, so
 * a first grade of 76 against a passing score of 69 cannot accept yet — and the
 * only route the loop had to a second sample was: rewrite the artifact (feedback
 * pass), re-audit it from scratch (validator agent), grade again. Measured on the
 * live 17-volume run for volume 01's character voice reference: the feedback pass
 * cost 2.63M tokens and wrote NOTHING, and the validator turn that followed cost
 * 8.4M tokens grading a document that had not changed. A grade is a tool-less
 * one-shot over files already on disk — about 55k tokens.
 *
 * The rule: fire only when the window is still short AND the grade we just got
 * already clears both the passing score and the sample floor. Then take the
 * remaining samples from the same artifact — the first at the normal judging
 * temperature (a genuinely independent second opinion), the last at temperature 0
 * (the deterministic anchor) — and put them INTO the window, because collecting
 * them is the whole point. If any of them fails, the window says so and the
 * caller runs the feedback round it was going to run anyway: a grader that
 * disagrees with a passing grade is exactly the signal that wants a rewrite.
 *
 * This is deliberately NOT a lower copy of `confirmExceptionalScore`, and the two
 * differ in the way that matters: that helper asks "is this great grade real?"
 * and keeps its confirmations OUT of the window (a failed consensus must lead to
 * the ordinary loop, not to an acceptance built from the grades that just
 * failed). This one is filling the window, so its grades belong in it.
 *
 * @param {{
 *   score: number|null,
 *   recentRollingScores: number[],
 *   confirmationCheck?: (p: {score: number, index: number, temperature: number|undefined}) => Promise<number|null|{score: number|null, temperature: number}>,
 *   volumeLabel: string,
 *   stateFile: string,
 *   sourceFingerprint?: string,
 * }} p
 * @returns {Promise<{ran: boolean, accepted: boolean, confirmations: Array<{score: number|null, temperature: number|null}>}>}
 *   `ran` when re-grades were taken (the caller must NOT also run the feedback
 *   round for this iteration); `accepted` when the window now meets the criterion.
 */
async function confirmPassingScore({ score, recentRollingScores, confirmationCheck, volumeLabel, stateFile, sourceFingerprint }) {
  if (!ACCEPTANCE_CONFIRM_ON_PASSING || !confirmationCheck) {
    return { ran: false, accepted: false, confirmations: [] };
  }
  // Only a grade that already passes is worth confirming cheaply. A failing grade
  // has a real problem, and the feedback round is the correct response to it.
  if (!Number.isFinite(score) || score < ACCEPTANCE_PASSING_SCORE) {
    return { ran: false, accepted: false, confirmations: [] };
  }
  if (ACCEPTANCE_SAMPLE_FLOOR > 0 && score < ACCEPTANCE_SAMPLE_FLOOR) {
    return { ran: false, accepted: false, confirmations: [] };
  }
  // The window is full: the ordinary criterion has already had its chance and
  // failed, which means a score in it is dragging it down. Re-grading more of the
  // same artifact cannot answer that — only a change to the artifact can.
  if (recentRollingScores.length >= ACCEPTANCE_MIN_SAMPLES) {
    return { ran: false, accepted: false, confirmations: [] };
  }

  const needed = Math.max(ACCEPTANCE_MIN_SAMPLES - recentRollingScores.length, 1);
  const rounds = Math.max(needed, ACCEPTANCE_CONFIRMATION_CHECKS);
  console.log(
    `${volumeLabel}: acceptance score ${score}/100 already passes (≥ ${ACCEPTANCE_PASSING_SCORE}) ` +
      `but the window needs ${ACCEPTANCE_MIN_SAMPLES} sample(s) and has ${recentRollingScores.length} — ` +
      `collecting ${rounds} more grade(s) from the same artifact instead of rewriting it ` +
      `(the last at temperature 0)…`
  );

  const confirmations = [];
  for (let ci = 0; ci < rounds; ci++) {
    // Independent samples first; the deterministic anchor LAST, so it is the one
    // that decides when the stochastic ones disagree.
    const temperature = ci === rounds - 1 ? 0 : undefined;
    const raw = await confirmationCheck({ score, index: ci, temperature });
    const confirmationScore = raw !== null && typeof raw === "object" ? raw.score : raw;
    const confirmationTemperature =
      raw !== null && typeof raw === "object" && Number.isFinite(raw.temperature)
        ? raw.temperature
        : temperature ?? null;
    confirmations.push({
      score: Number.isFinite(confirmationScore) ? confirmationScore : null,
      temperature: confirmationTemperature,
    });
    // An unparseable grade is a failed check (fail-closed) and is NOT stored —
    // the same rule the ordinary acceptance check uses.
    if (Number.isFinite(confirmationScore)) {
      recentRollingScores.push(confirmationScore);
      if (recentRollingScores.length > ACCEPTANCE_WINDOW_SIZE) recentRollingScores.shift();
    }
  }

  const spread = confirmations
    .map((c) => `${c.score === null ? "unparseable" : c.score}${c.temperature === 0 ? " (temp 0)" : ""}`)
    .join(", ");
  await saveRollingState(stateFile, recentRollingScores, {
    sourceFingerprint,
    confirmations: confirmations.map((c) => c.score),
  });

  if (meetsAcceptanceCriteria(recentRollingScores)) {
    const avg = computeRollingAverage(recentRollingScores);
    console.log(
      `${volumeLabel}: passing grade confirmed (${score}; re-grades: ${spread}) — ` +
        `rolling average ${avg.toFixed(1)}/100 (${recentRollingScores.length} checks) meets the passing ` +
        `score ${ACCEPTANCE_PASSING_SCORE}. Accepted without a feedback pass.`
    );
    await saveRollingState(stateFile, recentRollingScores, {
      sourceFingerprint,
      acceptedBy: "passing-consensus",
      deterministicScore: confirmations.find((c) => c.temperature === 0)?.score,
      confirmations: confirmations.map((c) => c.score),
    });
    return { ran: true, accepted: true, confirmations };
  }

  console.log(
    `${volumeLabel}: passing grade NOT confirmed by re-grading the same artifact ` +
      `(${score}; re-grades: ${spread}). The window now disagrees with itself, so the ` +
      `feedback round is the right next step.`
  );
  return { ran: true, accepted: false, confirmations };
}

module.exports = { confirmExceptionalScore, confirmPassingScore };

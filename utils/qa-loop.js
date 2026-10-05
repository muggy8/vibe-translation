/**
 * utils/qa-loop.js — the shared validator → grader → feedback QA loop used
 * by all four volume tasks (glossary, character-voice, style-guide,
 * jump-in-wiki).
 *
 * The loop is identical across tasks except for task-specific pieces, which
 * are injected via the config: validator agent creation (name, system
 * prompt, step cap), the validator turn prompt + labels, the validator
 * recovery prompt, the acceptance check (each task's acceptanceCheck), the
 * feedback stage (each task's runFeedback), and the log lines. Everything
 * else — the rolling window, fail-closed unparseable scores, per-iteration
 * state persistence (with the source fingerprint), the acceptance criterion
 * check, the recovery-turn gating, and the ON_QA_LIMIT policy — lives here
 * so the four tasks cannot drift apart.
 *
 * Pure orchestration: no prompt building, no agent creation of its own.
 */

const {
  ACCEPTANCE_WINDOW_SIZE,
  ACCEPTANCE_MIN_SAMPLES,
  ACCEPTANCE_PASSING_SCORE,
  ACCEPTANCE_SAMPLE_FLOOR,
  ACCEPTANCE_CONFIRMATION_CHECKS,
  ACCEPTANCE_CONFIRM_ON_PASSING,
  ACCEPTANCE_EXCEPTIONAL_SCORE,
  ACCEPTANCE_SCORE_TOLERANCE,
  computeRollingAverage,
  meetsAcceptanceCriteria,
  meetsExceptionalCriteria,
  isExceptionalScore,
  saveRollingState,
  isTooBigForOnePassError,
  isStructuralError,
} = require("../configs/shared");
const { assertWroteWithFallback, fingerprintFiles } = require("./fs");

/**
 * @typedef {Object} SharedQaLoopCfg
 * @property {string} volumeLabel - Log prefix, e.g. "Volume 01".
 * @property {number} maxIterations - QA_MAX_ITERATIONS for this run.
 * @property {"accept"|"fail"} onQaLimit - The ON_QA_LIMIT policy.
 * @property {string} validationOutputFile - The validation report file.
 * @property {string} stateFile - The rolling-state file to persist each iteration.
 * @property {string} [sourceFingerprint] - The source fingerprint to persist (staleness detection).
 * @property {(iteration: number) => string} [iterationLogLine] - Defaults to
 *   "<volumeLabel>: validation iteration <i>/<max>...".
 * @property {() => string} [validatorLogLine] - Optional line before the validator turn.
 * @property {() => string} [acceptanceLogLine] - Optional line before the acceptance check.
 * @property {(iteration: number) => import("../types").AgentHandle} createValidatorAgent -
 *   Fresh validator agent per iteration (the task keeps its own agent naming,
 *   system prompt and size-scaled step cap).
 * @property {(iteration: number) => string} buildValidatorTurn - The validator turn prompt.
 * @property {(iteration: number) => string} validatorLabel - sendTurn label for the validator turn.
 * @property {(iteration: number) => string} validatorRecoveryLabel - sendTurn label for the recovery turn.
 * @property {(hasContent: boolean) => string} validatorRecoveryPrompt - The validator recovery prompt.
 * @property {(result: Object, who: string) => void} assertRealToolCalls - The task's
 *   malformed-tool-call guard (fail-loud on tool-call syntax emitted as text).
 * @property {(iteration: number) => Promise<number|null>} acceptanceCheck - The task's
 *   grader one-shot (artifact + report → 0–100; null = unparseable = failed check).
 * @property {(p: {score: number, index: number, temperature: number}) => Promise<number|null|{score: number|null, temperature: number}>} [confirmationCheck]
 *   Re-grade the SAME artifact at the given temperature (the exceptional-score
 *   confirmation). May return the bare score or a { score, temperature } pair —
 *   the loop normalizes both. Omit it and the fast-accept path never runs.
 * @property {() => string} feedbackLogLine - The line logged before each feedback pass.
 * @property {(iteration: number) => Promise<void>} runFeedback - The task's feedback stage
 *   (fresh author agent per iteration, or the wiki's author session).
 * @property {string[]} [feedbackArtifactFiles] - The files the feedback pass is supposed to
 *   change (e.g. the volume's glossary). When given, the loop fingerprints them before and
 *   after `runFeedback` and stops the loop when nothing changed — a feedback pass that
 *   rewrote nothing is not progress, and another iteration would re-audit an unchanged
 *   document (see fingerprintFiles in utils/fs.js). Omit only for a stage whose feedback
 *   writes nothing to disk.
 * @property {() => string} limitReachedLogLine - The line logged when the iteration limit is hit.

/**
 * Run the shared QA loop (see the module header for the split of
 * responsibilities).
 *
 * @param {SharedQaLoopCfg} cfg - The task-specific configuration.
 * @returns {Promise<{accepted: boolean, limitReached: boolean, scores: number[]}>}
 *   `accepted` when the window met the criterion (the loop stopped early),
 *   `limitReached` when maxIterations ran without acceptance, and the final
 *   window contents (also persisted to cfg.stateFile on every iteration).
 */
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

async function runSharedQaLoop(cfg) {
  const { maxIterations, onQaLimit } = cfg;
  // Rolling window of recent acceptance scores (0–100). A score of `null`
  // (unparseable acceptance response) counts as a failed check (fail-closed)
  // and is not stored in the window.
  const recentRollingScores = [];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    console.log(
      cfg.iterationLogLine
        ? cfg.iterationLogLine(iteration)
        : `${cfg.volumeLabel}: validation iteration ${iteration}/${maxIterations}...`
    );
    if (cfg.validatorLogLine) console.log(cfg.validatorLogLine());

    // Validate with an independent validator agent (fresh per iteration).
    const validator = await cfg.createValidatorAgent(iteration);
    try {
      const validateResult = await validator.sendTurn(
        cfg.buildValidatorTurn(iteration),
        { label: cfg.validatorLabel(iteration) }
      );
      cfg.assertRealToolCalls(validateResult, "the validator agent");
      const validateFallbackUsed = await assertWroteWithFallback(
        cfg.validationOutputFile,
        "the validator agent",
        validateResult?.text
      );

      // Recovery turn: ONLY when the report was actually missing after the
      // fallback (the model replied in chat instead of writeFile, or produced
      // no output) — never over a file the agent already wrote correctly.
      if (validateFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
        const hasContent = validateResult?.text && validateResult.text.trim().length > 0;
        const validateRecoveryResult = await validator.sendTurn(
          cfg.validatorRecoveryPrompt(hasContent),
          { label: cfg.validatorRecoveryLabel(iteration) }
        );
        cfg.assertRealToolCalls(validateRecoveryResult, "the validator agent (recovery)");
        await assertWroteWithFallback(
          cfg.validationOutputFile,
          "the validator agent (recovery)",
          validateRecoveryResult?.text
        );
      }
    } finally {
      await validator.close();
    }

    // Acceptance check (always one-shot, tool-less).
    if (cfg.acceptanceLogLine) console.log(cfg.acceptanceLogLine());
    const score = await cfg.acceptanceCheck(iteration);

    // Record the score in the rolling window (null = unparseable, already
    // logged as a failure; not stored).
    if (score !== null) {
      recentRollingScores.push(score);
      if (recentRollingScores.length > ACCEPTANCE_WINDOW_SIZE) {
        recentRollingScores.shift();
      }
    }

    // ── Exceptional score: is it real, or a fluke? ──────────────────────────
    const exceptional = await confirmExceptionalScore({
      score,
      recentRollingScores,
      confirmationCheck: cfg.confirmationCheck,
      volumeLabel: cfg.volumeLabel,
      stateFile: cfg.stateFile,
      sourceFingerprint: cfg.sourceFingerprint,
    });
    if (exceptional.accepted) {
      return {
        accepted: true,
        limitReached: false,
        scores: recentRollingScores,
        acceptedBy: "exceptional-consensus",
      };
    }

    // Persist the rolling window to disk so that a re-run can recover the
    // exact acceptance state without re-calling the AI. Saved on every
    // iteration — including the accepting one — so the idempotency
    // skip-check sees the final state.
    await saveRollingState(cfg.stateFile, recentRollingScores, {
      sourceFingerprint: cfg.sourceFingerprint,
    });

    // Check the acceptance criterion: if we have enough samples and the
    // window meets it, accept and stop (skip feedback).
    if (meetsAcceptanceCriteria(recentRollingScores)) {
      const avg = computeRollingAverage(recentRollingScores);
      console.log(
        `${cfg.volumeLabel}: rolling average ${avg.toFixed(1)}/100 ` +
          `(${recentRollingScores.length} checks) meets the passing score ` +
          `${ACCEPTANCE_PASSING_SCORE}. Accepted.`
      );
      await saveRollingState(cfg.stateFile, recentRollingScores, {
        sourceFingerprint: cfg.sourceFingerprint,
        acceptedBy: "rolling-window",
      });
      return { accepted: true, limitReached: false, scores: recentRollingScores, acceptedBy: "rolling-window" };
    }

    // The window is short, but the grade we just got ALREADY passes. Buy the
    // remaining samples by re-grading the same artifact instead of paying for a
    // feedback rewrite plus a full validator turn to obtain them (measured live:
    // 2.63M + 8.4M tokens for a second sample that a 55k-token grade produces).
    const passing = await confirmPassingScore({
      score,
      recentRollingScores,
      confirmationCheck: cfg.confirmationCheck,
      volumeLabel: cfg.volumeLabel,
      stateFile: cfg.stateFile,
      sourceFingerprint: cfg.sourceFingerprint,
    });
    if (passing.accepted) {
      return { accepted: true, limitReached: false, scores: recentRollingScores, acceptedBy: "passing-consensus" };
    }

    // Apply the feedback (task-specific stage).
    //
    // Fingerprint the artifacts first: a feedback pass that changed nothing is
    // not a step, and running another iteration would re-audit a document that
    // has not moved (see fingerprintFiles in utils/fs.js — this is the check that
    // was missing when a 46-tool-call, zero-write feedback pass was recorded as
    // a normal iteration and the loop went around again).
    const watchedArtifacts = Array.isArray(cfg.feedbackArtifactFiles) ? cfg.feedbackArtifactFiles.filter(Boolean) : [];
    const beforeFeedback = watchedArtifacts.length ? await fingerprintFiles(watchedArtifacts) : null;
    console.log(cfg.feedbackLogLine());
    await cfg.runFeedback(iteration);

    if (beforeFeedback !== null && (await fingerprintFiles(watchedArtifacts)) === beforeFeedback) {
      console.error(
        `${cfg.volumeLabel}: the feedback pass changed NOTHING — ${watchedArtifacts.length} ` +
          `artifact(s) are byte-identical to what they were before it. Stopping the QA loop here ` +
          `rather than paying for another validator turn and another grade over an unchanged ` +
          `document. Check the agent's turn log in .logs/ for a turn that only read (the usual ` +
          `shape: step cap reached before it wrote anything).`
      );
      await saveRollingState(cfg.stateFile, recentRollingScores, {
        sourceFingerprint: cfg.sourceFingerprint,
        stalled: true,
      });
      if (onQaLimit === "fail") {
        throw new Error(
          `${cfg.volumeLabel}: the feedback pass applied nothing (ON_QA_LIMIT=fail).`
        );
      }
      return { accepted: false, limitReached: true, stalled: true, scores: recentRollingScores };
    }

    if (iteration === maxIterations) {
      console.log(cfg.limitReachedLogLine());
      if (onQaLimit === "fail") {
        throw new Error(
          `${cfg.volumeLabel}: hit the validation iteration limit ` +
            `without a passing grade (ON_QA_LIMIT=fail).`
        );
      }
      return { accepted: false, limitReached: true, scores: recentRollingScores };
    }
  }

  // Unreachable: the loop always returns via acceptance or the limit.
  return { accepted: false, limitReached: false, scores: recentRollingScores };
}

/**
 * Run one volume's processing pass, and if a WHOLE-installment attempt fails in
 * the one way that switching to chapter-by-chapter actually fixes, wipe the
 * attempt and retry the volume in the fallback mode — once.
 *
 * The narrow trigger is the whole point (see tooBigForOnePassError in
 * configs/shared.js): a request the server refused for being too large, or a turn
 * that hit the output cap while writing a file, are size failures, and processing
 * the same volume chapter by chapter is a genuine repair. A hang, a malformed
 * tool call, a dead container, a missing previous artifact, or a bad acceptance
 * score are not, and falling back on them costs the whole volume again to fix
 * something chunking cannot fix — or, in the acceptance-score case, makes which
 * mode ran irreproducible between runs.
 *
 * Exactly one fallback attempt. A second failure is reported, not retried.
 *
 * @param {{
 *   run: () => Promise<void>,
 *   ctx: {chunked: boolean},
 *   volumeDir: string,
 *   attemptFiles: string[],
 *   attemptGlob?: RegExp,
 *   label: string,
 *   enabled?: boolean,
 * }} p - `run` is the task's own processing pass (it reads ctx.chunked); `attemptFiles` are the files that pass writes, which get removed before the fallback.
 * @returns {Promise<{fellBack: boolean, error?: Error}>}
 * @throws {Error} Re-throws anything the fallback does not apply to, or the fallback attempt's own failure.
 */
async function runVolumeWithModeFallback({
  run,
  ctx,
  volumeDir,
  attemptFiles,
  attemptGlob,
  label,
  enabled = true,
}) {
  try {
    await run();
    return { fellBack: false };
  } catch (err) {
    const applies =
      enabled &&
      ctx &&
      ctx.chunked === false &&
      isTooBigForOnePassError(err) &&
      !isStructuralError(err);
    if (!applies) throw err;

    const { wipeAttemptOutputs } = require("./fs");
    const removed = await wipeAttemptOutputs(volumeDir, attemptFiles, { glob: attemptGlob });
    console.warn(
      `\n${label}: the whole-installment pass did not fit in one attempt — ${err.message}\n` +
        `${label}: falling back to chapter-by-chapter for this volume (once).` +
        (removed.length
          ? ` Removed the partial attempt's output: ${removed.join(", ")}.`
          : " The attempt had written nothing yet.") +
        `\n${label}: a whole-mode failure is worth reading — the size check said this volume fitted, so either ` +
        `the estimate is off for this model or the reference material outgrew the allowance. ` +
        `Lower SOURCE_CHUNK_SAFETY_FRACTION, or run with --chunked to skip the attempt next time.`
    );

    ctx.chunked = true;
    ctx.modeFallback = true;
    try {
      await run();
      console.log(`${label}: the chapter-by-chapter pass completed after the fallback.`);
      return { fellBack: true };
    } catch (retryErr) {
      throw new Error(
        `${label}: the whole-installment pass did not fit (${err.message}) and the chapter-by-chapter ` +
          `fallback also failed (${retryErr.message}). Both attempts are recorded; check ` +
          `.logs/ for the two attempts.`
      );
    }
  }
}

module.exports = { runSharedQaLoop, confirmExceptionalScore, confirmPassingScore, runVolumeWithModeFallback };
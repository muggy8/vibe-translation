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
  ACCEPTANCE_PASSING_SCORE,
  ACCEPTANCE_CONFIRMATION_CHECKS,
  ACCEPTANCE_EXCEPTIONAL_SCORE,
  ACCEPTANCE_SCORE_TOLERANCE,
  computeRollingAverage,
  meetsAcceptanceCriteria,
  meetsExceptionalCriteria,
  isExceptionalScore,
  saveRollingState,
} = require("../configs/shared");
const { assertWroteWithFallback } = require("./fs");

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
    // A grade in the rubric's top band (>= ACCEPTANCE_EXCEPTIONAL_SCORE) is
    // re-graded ACCEPTANCE_CONFIRMATION_CHECKS more times on the SAME artifact
    // — the first re-grade at temperature 0 (the deterministic anchor), the
    // rest at the calm judging temperature. If the consensus holds, the volume
    // is accepted NOW: no feedback pass, no second full validator turn (the
    // expensive part of a loop iteration). If it collapses, the scores stay in
    // the window and the normal loop continues — the great grade was luck.
    if (
      score !== null &&
      cfg.confirmationCheck &&
      isExceptionalScore(score)
    ) {
      console.log(
        `${cfg.volumeLabel}: acceptance score ${score}/100 is exceptional (≥ ${ACCEPTANCE_EXCEPTIONAL_SCORE}) ` +
          `— confirming with ${ACCEPTANCE_CONFIRMATION_CHECKS} more grade(s) (one at temperature 0)…`
      );
      const confirmations = [];
      for (let ci = 0; ci < ACCEPTANCE_CONFIRMATION_CHECKS; ci++) {
        // The FIRST confirmation is always the deterministic one.
        const temperature = ci === 0 ? 0 : undefined;
        const raw = await cfg.confirmationCheck({ score, index: ci, temperature });
        // A task may return the bare score (its acceptanceCheck does) or a
        // { score, temperature } pair; both are normalized here so the loop —
        // and the temperature-0 anchor rule — cannot depend on which one a
        // task happened to use.
        const confirmationScore =
          raw !== null && typeof raw === "object" ? raw.score : raw;
        const confirmationTemperature =
          raw !== null && typeof raw === "object" && Number.isFinite(raw.temperature)
            ? raw.temperature
            : temperature ?? null;
        confirmations.push({
          score: Number.isFinite(confirmationScore) ? confirmationScore : null,
          temperature: confirmationTemperature,
        });
      }
      // The confirmation scores are NOT pushed into the rolling window. They
      // exist to answer one question — was the exceptional grade real? — and if
      // the answer is no, the volume must continue through exactly the loop it
      // would have run anyway (feedback pass, next validator turn). Letting
      // extra samples into the window could accept a volume whose consensus just
      // failed, without ever running the feedback that failure calls for.
      const verdict = meetsExceptionalCriteria(score, confirmations);
      const spread = confirmations
        .map((c) => `${c.score === null ? "unparseable" : c.score}${c.temperature === 0 ? " (temp 0)" : ""}`)
        .join(", ");
      if (verdict.accepted) {
        console.log(
          `${cfg.volumeLabel}: exceptional score confirmed (${score}; confirmations: ${spread}) — ` +
            `${verdict.reason}. Accepted without a feedback pass.`
        );
        await saveRollingState(cfg.stateFile, recentRollingScores, {
          sourceFingerprint: cfg.sourceFingerprint,
          acceptedBy: "exceptional-consensus",
          deterministicScore: confirmations.find((c) => c.temperature === 0)?.score,
          confirmations: confirmations.map((c) => c.score),
        });
        return {
          accepted: true,
          limitReached: false,
          scores: recentRollingScores,
          acceptedBy: "exceptional-consensus",
        };
      }
      console.log(
        `${cfg.volumeLabel}: exceptional score NOT confirmed (${score}; confirmations: ${spread}) — ${verdict.reason}. ` +
          `Continuing the normal loop (the confirmation grades are recorded, not counted).`
      );
      await saveRollingState(cfg.stateFile, recentRollingScores, {
        sourceFingerprint: cfg.sourceFingerprint,
        rejectedConfirmations: confirmations.map((c) => c.score),
      });
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

    // Apply the feedback (task-specific stage).
    console.log(cfg.feedbackLogLine());
    await cfg.runFeedback(iteration);

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

module.exports = { runSharedQaLoop };
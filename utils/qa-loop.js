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
  computeRollingAverage,
  meetsAcceptanceCriteria,
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
      return { accepted: true, limitReached: false, scores: recentRollingScores };
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
/**
 * utils/qa-loop/whole.js — the whole-installment QA loop: one validator agent,
 * one grade, one feedback pass per iteration.
 *
 * The chapter-by-chapter version of the same loop is in ./chunked.js; both share
 * the grading half (./acceptance.js) and the turn protocol (./turn.js), which is
 * the part that must not drift between them.
 *
 * Part of the utils/qa-loop.js layer (split out of the original single file).
 */

const { saveRollingState } = require("../../configs/shared");
const { fingerprintFiles } = require("../fs");
const { runWriteTurn } = require("./turn");
const { scoreAndConfirm } = require("./acceptance");

/**
 * @typedef {Object} SharedQaLoopCfg
 * @property {string} volumeLabel - Log prefix, e.g. "Volume 01".
 * @property {number} maxIterations - QA_MAX_ITERATIONS for this run.
 * @property {"accept"|"fail"} onQaLimit - The ON_QA_LIMIT policy.
 * @property {string} validationOutputFile - The validation report.
 * @property {string} stateFile - The rolling-state file to persist each iteration.
 * @property {string} [sourceFingerprint] - The source fingerprint to persist (staleness detection).
 * @property {(iteration: number) => string} [iterationLogLine] - Defaults to
 *   "<volumeLabel>: validation iteration <i>/<max>...".
 * @property {() => string} [validatorLogLine] - Optional line before the validator turn.
 * @property {() => string} [acceptanceLogLine] - Optional line before the acceptance check.
 * @property {(iteration: number) => import("../../types").AgentHandle} createValidatorAgent -
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
 * @property {(p: {score: number, index: number, temperature: number|undefined}) => Promise<number|null|{score: number|null, temperature: number}>} [confirmationCheck]
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
 */

/**
 * Run the shared whole-installment QA loop (see the module header for the split
 * of responsibilities).
 *
 * @param {SharedQaLoopCfg} cfg - The task-specific configuration.
 * @returns {Promise<{accepted: boolean, acceptedBy: string|null, limitReached: boolean, stalled?: boolean, scores: number[]}>}
 *   `accepted` when the window met the criterion (the loop stopped early) and
 *   `acceptedBy` names which of the three ways out it took, `limitReached` when
 *   maxIterations ran without acceptance, and the final window contents (also
 *   persisted to cfg.stateFile on every iteration).
 */
async function runSharedQaLoop(cfg) {
  // Rolling window of recent acceptance scores (0–100). A score of `null`
  // (unparseable acceptance response) counts as a failed check (fail-closed)
  // and is not stored in the window.
  const recentRollingScores = [];
  const { maxIterations, onQaLimit } = cfg;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    console.log(
      cfg.iterationLogLine
        ? cfg.iterationLogLine(iteration)
        : `${cfg.volumeLabel}: validation iteration ${iteration}/${maxIterations}...`
    );
    if (cfg.validatorLogLine) console.log(cfg.validatorLogLine());

    await runValidatorTurn(cfg, iteration);

    if (cfg.acceptanceLogLine) console.log(cfg.acceptanceLogLine());
    const graded = await scoreAndConfirm({
      iteration,
      volumeLabel: cfg.volumeLabel,
      stateFile: cfg.stateFile,
      recentRollingScores,
      sourceFingerprint: cfg.sourceFingerprint,
      acceptanceCheck: cfg.acceptanceCheck,
      confirmationCheck: cfg.confirmationCheck,
    });
    if (graded.accepted) {
      return {
        accepted: true,
        acceptedBy: graded.acceptedBy,
        limitReached: false,
        scores: recentRollingScores,
      };
    }

    // Apply the feedback (task-specific stage), and stop if it applied nothing.
    console.log(cfg.feedbackLogLine());
    const stalled = await feedbackAppliedNothing(cfg, iteration, recentRollingScores);
    if (stalled) return stalled;

    if (iteration === maxIterations) return await hitIterationLimit(cfg, recentRollingScores);
  }

  // Unreachable: the loop always returns via acceptance or the limit.
  return { accepted: false, acceptedBy: null, limitReached: false, scores: recentRollingScores };
}

/**
 * One validator turn: open the task's fresh validator agent, run the shared turn protocol on it, and
 * hand it back.
 *
 * `verifyOutput` stays off here: this loop has never refused to grade a validator report that came back
 * empty, and changing that is a separate decision from sharing the turn protocol.
 *
 * @param {SharedQaLoopCfg} cfg
 * @param {number} iteration
 * @returns {Promise<void>}
 */
async function runValidatorTurn(cfg, iteration) {
  const validator = await cfg.createValidatorAgent(iteration);
  try {
    await runWriteTurn(validator, {
      prompt: cfg.buildValidatorTurn(iteration),
      label: cfg.validatorLabel(iteration),
      who: "the validator agent",
      writesTo: cfg.validationOutputFile,
      recoveryPrompt: cfg.validatorRecoveryPrompt,
      recoveryLabel: cfg.validatorRecoveryLabel(iteration),
      assertToolCalls: cfg.assertRealToolCalls,
      verifyOutput: false,
    });
  } finally {
    await validator.close();
  }
}

/**
 * Run the task's feedback stage, and decide whether it actually did anything.
 *
 * The artifacts are fingerprinted first: a feedback pass that changed nothing is not a step, and running
 * another iteration would re-audit a document that has not moved (see fingerprintFiles in utils/fs.js —
 * this is the check that was missing when a 46-tool-call, zero-write feedback pass was recorded as a
 * normal iteration and the loop went around again).
 *
 * @param {SharedQaLoopCfg} cfg
 * @param {number} iteration
 * @param {number[]} scores - The rolling window, as it stands when the loop stops.
 * @returns {Promise<Object|null>} The loop's return value when it stopped here, or null to continue.
 * @throws {Error} Only under ON_QA_LIMIT=fail.
 */
async function feedbackAppliedNothing(cfg, iteration, scores) {
  const watched = Array.isArray(cfg.feedbackArtifactFiles) ? cfg.feedbackArtifactFiles.filter(Boolean) : [];
  const before = watched.length ? await fingerprintFiles(watched) : null;
  await cfg.runFeedback(iteration);
  if (before === null || (await fingerprintFiles(watched)) !== before) return null;

  console.error(
    `${cfg.volumeLabel}: the feedback pass changed NOTHING — ${watched.length} ` +
      `artifact(s) are byte-identical to what they were before it. Stopping the QA loop here ` +
      `rather than paying for another validator turn and another grade over an unchanged ` +
      `document. Check the agent's turn log in .logs/ for a turn that only read (the usual ` +
      `shape: step cap reached before it wrote anything).`
  );
  await saveRollingState(cfg.stateFile, scores, {
    sourceFingerprint: cfg.sourceFingerprint,
    stalled: true,
  });
  if (cfg.onQaLimit === "fail") {
    throw new Error(`${cfg.volumeLabel}: the feedback pass applied nothing (ON_QA_LIMIT=fail).`);
  }
  return { accepted: false, acceptedBy: null, limitReached: true, stalled: true, scores };
}

/**
 * The last iteration ended without acceptance: say so, and honour ON_QA_LIMIT.
 *
 * @param {SharedQaLoopCfg} cfg
 * @param {number[]} scores - The rolling window, as it stands when the loop stops.
 * @returns {Promise<Object>} The loop's return value.
 * @throws {Error} Under ON_QA_LIMIT=fail.
 */
async function hitIterationLimit(cfg, scores) {
  console.log(cfg.limitReachedLogLine());
  if (cfg.onQaLimit === "fail") {
    throw new Error(`${cfg.volumeLabel}: hit the validation iteration limit without a passing grade (ON_QA_LIMIT=fail).`);
  }
  return { accepted: false, acceptedBy: null, limitReached: true, scores };
}

module.exports = { runSharedQaLoop };

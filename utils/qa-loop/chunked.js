/**
 * utils/qa-loop/chunked.js — the chapter-by-chapter QA loop the four volume
 * tasks fall back to when an installment is too large for one pass.
 *
 * One iteration is always the same four moves: every chapter gets a fresh
 * validator agent that writes its own partial report; one merge agent
 * consolidates those partials into the task's standard validation report; the
 * task's tool-less grader scores that report; and if the grade does not accept
 * the volume, every chapter gets a fresh author agent that applies the findings
 * tagged to it. Then the two ways a loop is allowed to stop: the feedback round
 * changed nothing (so another iteration would re-audit an unchanged document),
 * or the iteration budget ran out.
 *
 * What a task supplies is three stage descriptions (validator / merge /
 * feedback) and its own grader. Everything else — the iteration counting, the
 * rolling window, the consensus gates, the stalled-round detection, the
 * ON_QA_LIMIT policy — lives here so the four tasks cannot drift apart.
 *
 * Part of the utils/qa-loop.js layer (split out of the original single file).
 */

const path = require("path");
const {
  saveRollingState,
  loadRollingState,
  newGradeTally,
  gradeTallyFields,
} = require("../../configs/shared");
const { fingerprintFiles } = require("../fs");
const { runQaAgentStage } = require("./turn");
const { scoreAndConfirm } = require("./acceptance");

/**
 * One turn's coordinates inside a QA loop.
 *
 * @typedef {Object} QaStageRef
 * @property {number} iteration - The loop iteration, 1-based.
 * @property {import("../../types").SourceSegment|null} segment - The chapter this agent is for; `null` for the whole-volume merge stage.
 * @property {number} si - The chapter's index in reading order (0-based).
 */

/**
 * What one QA stage says, to whom, and what it must leave on disk.
 *
 * Every field is a function of the turn's coordinates because a per-chapter
 * stage says something different for each chapter of each iteration.
 *
 * @typedef {Object} QaStage
 * @property {(ref: QaStageRef) => string} name - The agent handle name (the log and the tests key on it).
 * @property {(ref: QaStageRef) => string} systemPrompt
 * @property {(ref: QaStageRef) => number|Promise<number>} maxSteps - The step cap for this agent.
 * @property {(ref: QaStageRef) => string} prompt - The turn itself.
 * @property {(ref: QaStageRef) => string} label - The sendTurn label.
 * @property {(ref: QaStageRef) => string|string[]} writesTo - The file(s) this agent owes.
 * @property {(ref: QaStageRef) => string} who - How the failure messages name this agent.
 * @property {(ref: QaStageRef) => string} [recoveryLabel] - Defaults to `<label>-recovery`.
 * @property {(ref: QaStageRef) => string} [recoveryWho] - Defaults to `<who> (recovery)`.
 * @property {(hasContent: boolean, ref: QaStageRef) => string} [recoveryPrompt] - Defaults to the shared wording in turn.js.
 * @property {boolean} [verifyOutput] - False skips the "did it actually write?" stop. Omit it: skipping is the exception, not the rule.
 * @property {(ref: QaStageRef) => Promise<void>} [beforeChapter] - Runs before this chapter's turn (e.g. re-index the artifact the chapter is about to amend).
 * @property {(ref: QaStageRef) => Promise<void>} [afterChapter] - Runs after it (e.g. the carry-forward guard for this chapter).
 */

/**
 * @typedef {Object} ChunkedQaLoopCfg
 * @property {string} volumeLabel - Log prefix, e.g. "Volume 01".
 * @property {string} installment - The volume number the failure messages name.
 * @property {Object} tools - The gated file tools every QA agent runs behind.
 * @property {(path: string) => Promise<boolean>} approve - The same gate's approval hook.
 * @property {string} cwd - The volume folder the agents work in.
 * @property {Array<import("../../types").SourceSegment>} chapters - The volume's segments, in reading order.
 * @property {number} maxIterations - QA_MAX_ITERATIONS for this run.
 * @property {"accept"|"fail"} onQaLimit - The ON_QA_LIMIT policy.
 * @property {string} validationOutputFile - The consolidated report the merge stage writes; the rolling-state file is derived from its name.
 * @property {string} [sourceFingerprint] - Persisted with every iteration (staleness detection).
 * @property {QaStage} [validate] - The per-chapter validator stage.
 * @property {QaStage} [merge] - The findings-merge stage (one agent for the whole volume).
 * @property {QaStage} [feedback] - The per-chapter feedback stage.
 * @property {(ref: QaStageRef) => Promise<void>} [feedbackRun] - Instead of `feedback`: a task whose feedback pass is already a function shared with its whole-installment loop.
 * @property {(iteration: number|string) => Promise<number|null>} acceptanceCheck - The task's grader (null = unparseable = failed check).
 * @property {(p: {score: number, index: number, temperature: number|undefined}) => Promise<number|null>} [confirmationCheck] - Re-grade the same artifact (the two consensus gates). Omit it and neither fast path runs.
 * @property {string[]|(() => string[])} feedbackArtifactFiles - The files the feedback round is supposed to change; the loop stops when none of them changed.
 * @property {() => string} limitReachedLogLine - The line logged when the iteration budget runs out.
 * @property {(files: string[]) => string} [stalledLogLine] - Defaults to the shared wording, naming the unchanged files.
 * @property {(iteration: number) => Promise<void>} [afterFeedbackRound] - A task's own guard over the whole round (e.g. the voice reference's carry-forward check). Runs after the stalled-round check, before the next iteration.
 */

/**
 * The stalled-round message every task gets unless it names its artifacts differently.
 *
 * @param {string} volumeLabel
 * @param {string[]} files - The artifacts that came out of the round unchanged.
 * @returns {string}
 */
function defaultStalledLogLine(volumeLabel, files) {
  const named = files.map((f) => path.basename(f)).join(" and ");
  return (
    `${volumeLabel}: the per-chapter feedback round changed NOTHING — ${named} ` +
    `${files.length > 1 ? "are byte-identical to what they were" : "is byte-identical to what it was"} ` +
    `before it. Stopping the QA loop here rather than paying for another round of per-chapter ` +
    `validators over an unchanged document. Check the feedback agents' turn logs in .logs/ for turns ` +
    `that only read (the usual shape: step cap reached before anything was written).`
  );
}

/**
 * Run one volume's chapter-by-chapter QA loop (see the module header).
 *
 * @param {ChunkedQaLoopCfg} cfg - The task's stages, grader and policy.
 * @returns {Promise<{accepted: boolean, acceptedBy: string|null, limitReached: boolean, stalled?: boolean, scores: number[]}>}
 *   `acceptedBy` names which of the three acceptances ended the loop; `limitReached`
 *   is true when the budget ran out or a feedback round applied nothing (the caller
 *   records both on its volume context, exactly as the whole-installment loop does).
 * @throws {Error} The stalled-round or iteration-limit failure when ON_QA_LIMIT=fail.
 */
async function runPerChapterQaLoop(cfg) {
  const recentRollingScores = [];
  const stateFile = cfg.stateFile || cfg.validationOutputFile.replace(".md", "-rolling-state.json");
  // Seeded from the state file this volume already has, so a grader that keeps failing
  // to answer is a running count on disk rather than one log line per process (see
  // utils/qa-loop/acceptance.js).
  const gradeTally = newGradeTally(await loadRollingState(stateFile));
  const loop = { tools: cfg.tools, approve: cfg.approve, cwd: cfg.cwd, installment: cfg.installment };

  for (let iteration = 1; iteration <= cfg.maxIterations; iteration++) {
    console.log(
      `${cfg.volumeLabel}: validation iteration ${iteration}/${cfg.maxIterations} (chapter by chapter)...`
    );

    // 1. Per-chapter validation partials (fresh agent per chapter).
    for (let si = 0; si < cfg.chapters.length; si++) {
      const ref = { iteration, segment: cfg.chapters[si], si };
      if (cfg.validate.beforeChapter) await cfg.validate.beforeChapter(ref);
      await runQaAgentStage(cfg.validate, ref, loop);
      if (cfg.validate.afterChapter) await cfg.validate.afterChapter(ref);
    }

    // 2. Findings merge: consolidate the partials into the standard report.
    await runQaAgentStage(cfg.merge, { iteration, segment: null, si: 0 }, loop);

    // 3. Grade the report, and try the cheap acceptances before paying for a rewrite.
    const graded = await scoreAndConfirm({
      iteration,
      volumeLabel: cfg.volumeLabel,
      stateFile,
      recentRollingScores,
      sourceFingerprint: cfg.sourceFingerprint,
      tally: gradeTally,
      acceptanceCheck: cfg.acceptanceCheck,
      confirmationCheck: cfg.confirmationCheck,
    });
    if (graded.accepted) {
      return { accepted: true, acceptedBy: graded.acceptedBy, limitReached: false, scores: recentRollingScores };
    }

    // 4. Per-chapter feedback (fresh author agent per chapter, chapter-tagged
    //    findings). Fingerprinted first: a feedback round that changed nothing is
    //    not progress, and another iteration would re-audit an unchanged document.
    const watched = (typeof cfg.feedbackArtifactFiles === "function" ? cfg.feedbackArtifactFiles() : cfg.feedbackArtifactFiles || []).filter(Boolean);
    const beforeFeedback = watched.length ? await fingerprintFiles(watched) : null;
    // A task whose feedback pass is already a function shared with its
    // whole-installment loop (style-guide's runFeedback, which carries its own
    // carry-forward guard) hands the loop a runner instead of a stage.
    const feedbackChapter = cfg.feedbackRun
      ? (ref) => cfg.feedbackRun(ref)
      : async (ref) => {
          if (cfg.feedback.beforeChapter) await cfg.feedback.beforeChapter(ref);
          await runQaAgentStage(cfg.feedback, ref, loop);
          if (cfg.feedback.afterChapter) await cfg.feedback.afterChapter(ref);
        };
    for (let si = 0; si < cfg.chapters.length; si++) {
      await feedbackChapter({ iteration, segment: cfg.chapters[si], si });
    }

    if (beforeFeedback !== null && (await fingerprintFiles(watched)) === beforeFeedback) {
      console.error(cfg.stalledLogLine ? cfg.stalledLogLine(watched) : defaultStalledLogLine(cfg.volumeLabel, watched));
      await saveRollingState(stateFile, recentRollingScores, {
        sourceFingerprint: cfg.sourceFingerprint,
        stalled: true,
        ...gradeTallyFields(gradeTally),
      });
      if (cfg.onQaLimit === "fail") {
        throw new Error(`${cfg.volumeLabel}: the feedback round applied nothing (ON_QA_LIMIT=fail).`);
      }
      return { accepted: false, limitReached: true, stalled: true, scores: recentRollingScores };
    }

    if (cfg.afterFeedbackRound) await cfg.afterFeedbackRound(iteration);

    if (iteration === cfg.maxIterations) {
      console.log(cfg.limitReachedLogLine());
      if (cfg.onQaLimit === "fail") {
        throw new Error(
          `${cfg.volumeLabel}: hit the validation iteration limit without a passing grade (ON_QA_LIMIT=fail).`
        );
      }
      return { accepted: false, limitReached: true, scores: recentRollingScores };
    }
  }

  // Unreachable: the loop always returns via acceptance or the limit.
  return { accepted: false, limitReached: false, scores: recentRollingScores };
}

module.exports = { runPerChapterQaLoop };

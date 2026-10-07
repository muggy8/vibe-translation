/**
 * One volume, chapter by chapter: per-chapter section files are assembled into wiki.md +
 * shared-wiki.md by a MERGE agent (the wiki is the exception to the other tasks, which
 * carry forward into the next chapter's state), then per-chapter validator partials, a
 * findings-merge agent, the unchanged acceptance one-shot, and per-chapter feedback.
 *
 * Never iterate the bundle by file name — chN.K interludes do not sort into reading order
 * (gotcha 20).
 *
 * Part of the jump-in-wiki.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError } = require("../configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback, assertRealOutput, hasRealOutput, isPublishableArtifact, writeProvenanceSidecar, fingerprintFiles } = require("../utils/fs");
const { emittedToolCallAsText, assertRealToolCalls } = require("../utils/agents");
const { runSharedQaLoop, confirmExceptionalScore, confirmPassingScore, runVolumeWithModeFallback } = require("../utils/qa-loop");
const { transformUserPrompt, isPassingVerdict, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, writePromptDump } = require("../utils/prompt");

const { buildWikiAuthorSystemPrompt, buildWikiFindingsMergePrompt, buildWikiMergeTurnPrompt, buildWikiSectionTurnPrompt, buildWikiSegmentFeedbackPrompt, buildWikiSegmentValidatorPrompt, buildWikiValidatorSystemPrompt } = require("./prompts");
const { maxValidationIterations } = require("./config");
const { wikiAcceptanceCheck } = require("./acceptance");

/**
 * Process a single volume chapter by chapter (the FALLBACK path, used when
 * the whole installment is too large for one pass): a per-chapter section
 * author writes wiki-<id>.md for each chapter (each with the previous
 * chapter's section for continuity and the shared wiki read-only), then a
 * merge pass assembles wiki.md + shared-wiki.md from the sections. The QA
 * loop then validates the finished volume chapter by chapter (per-chapter
 * partial reports → findings merge → acceptance) with per-chapter feedback.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include bundle).
 */
async function runChunkedVolumeAgent(ctx) {
  const { values, bundle, volumeDir, wikiOutputFile, sharedWikiOutputFile } = ctx;
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: chapter-by-chapter fallback ` +
      `(${bundle.segments.length} segments, ${bundle.wholeChars} chars whole)...`
  );
  const fsGate = await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] });
  ctx.fsGate = fsGate;

  // Remove stale strays from earlier runs (agent name drift).
  for (const stray of [
    `jump-in-wiki-${values.INSTALLMENT_NUMBER}.md`,
    "jump-in-wiki-shared.md",
  ]) {
    const strayPath = path.join(volumeDir, stray);
    if (await fileExists(strayPath)) {
      await fs.rm(strayPath);
      console.log(`Removed the stale file "${stray}" (leftover from a previous run).`);
    }
  }

  // Per-chapter section generation (fresh author agent per chapter).
  for (let si = 0; si < bundle.segments.length; si++) {
    const segment = bundle.segments[si];
    const sectionFile = path.join(volumeDir, `wiki-${segment.id}.md`);
    if (!(await fileExists(sectionFile))) {
      await fs.writeFile(
        sectionFile,
        `(stub — the agent replaces this with the complete wiki section for chapter ${segment.id} of volume ${values.INSTALLMENT_NUMBER})\n`,
        "utf8"
      );
    }
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: chapter ${segment.id} (${segment.title}), ` +
        `${si + 1}/${bundle.segments.length} — writing the wiki section (author agent)...`
    );
    const sectionAuthor = await harness.createAgentHandle({
      name: `wiki-section-${values.INSTALLMENT_NUMBER}-${segment.id}`,
      systemPrompt: buildWikiAuthorSystemPrompt(ctx),
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      maxSteps: 40,
    });
    try {
      const sectionResult = await sectionAuthor.sendTurn(
        buildWikiSectionTurnPrompt(ctx, segment, si),
        { label: `jump-in-wiki-section-${values.INSTALLMENT_NUMBER}-${segment.id}` }
      );
      assertRealToolCalls(sectionResult, `the section author agent (chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
      const sectionFallbackUsed = await assertWroteWithFallback(sectionFile, "the section author agent", sectionResult?.text);
      if (sectionFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
        const hasSection = sectionResult?.text && sectionResult.text.trim().length > 0;
        const sectionRecoveryPrompt = hasSection
          ? `You were asked to write this chapter's wiki section to "wiki-${segment.id}.md" using writeFile, but you replied with the content in your chat message instead. Please write the file using writeFile now with the exact same content.`
          : `You produced no output. Please write this chapter's wiki section to "wiki-${segment.id}.md" using writeFile now.`;
        const sectionRecoveryResult = await sectionAuthor.sendTurn(sectionRecoveryPrompt, {
          label: `jump-in-wiki-section-recovery-${values.INSTALLMENT_NUMBER}-${segment.id}`,
        });
        assertRealToolCalls(sectionRecoveryResult, `the section author agent (chapter ${segment.id}, recovery)`, values.INSTALLMENT_NUMBER);
        await assertWroteWithFallback(sectionFile, "the section author agent (recovery)", sectionRecoveryResult?.text);
      }
      // Hard stop: a chapter section left as a stub would be merged straight
      // into wiki.md / shared-wiki.md as finished work.
      await assertRealOutput(sectionFile, `the section author agent (chapter ${segment.id})`);
    } finally {
      await sectionAuthor.close();
    }
  }

  // Merge pass: assemble wiki.md + shared-wiki.md from the sections.
  if (!(await fileExists(wikiOutputFile))) {
    await fs.writeFile(
      wikiOutputFile,
      `(stub — the merge pass replaces this with the complete volume wiki for volume ${values.INSTALLMENT_NUMBER})\n`,
      "utf8"
    );
  }
  if (!(await fileExists(sharedWikiOutputFile))) {
    await fs.writeFile(
      sharedWikiOutputFile,
      `(stub — the merge pass replaces this with the complete shared wiki)\n`,
      "utf8"
    );
  }
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: merging the chapter sections into the wiki (merge agent)...`);
  const merger = await harness.createAgentHandle({
    name: `wiki-merge-${values.INSTALLMENT_NUMBER}`,
    systemPrompt: buildWikiAuthorSystemPrompt(ctx),
    tools: fsGate.tools,
    approve: fsGate.approve,
    cwd: volumeDir,
    maxSteps: 40,
  });
  try {
    const mergeResult = await merger.sendTurn(buildWikiMergeTurnPrompt(ctx), {
      label: `jump-in-wiki-merge-${values.INSTALLMENT_NUMBER}`,
    });
    assertRealToolCalls(mergeResult, "the merge agent", values.INSTALLMENT_NUMBER);
    const mergeFallbackUsed = await assertWroteWithFallback(
      [wikiOutputFile, sharedWikiOutputFile],
      "the merge agent",
      mergeResult?.text
    );
    if (mergeFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
      const hasContent = mergeResult?.text && mergeResult.text.trim().length > 0;
      const recoveryPrompt = hasContent
        ? `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you replied with the content in your chat message instead. Please rewrite both files using writeFile now with the exact same content.`
        : `You produced no output. Please read the chapter sections and write "wiki.md" and "shared-wiki.md" using writeFile now.`;
      const recoveryResult = await merger.sendTurn(recoveryPrompt, {
        label: `jump-in-wiki-merge-recovery-${values.INSTALLMENT_NUMBER}`,
      });
      assertRealToolCalls(recoveryResult, "the merge agent (recovery)", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(
        [wikiOutputFile, sharedWikiOutputFile],
        "the merge agent (recovery)",
        recoveryResult?.text
      );
    }
    // Hard stop: the merged wiki is the deliverable — a surviving stub is a
    // failure, not an artifact.
    await assertRealOutput([wikiOutputFile, sharedWikiOutputFile], "the merge agent");
  } finally {
    await merger.close();
  }

  // QA loop: per-chapter validation partials → findings merge → acceptance.
  await runChunkedQaLoop(ctx);
}


/**
 * Chunked (fallback) QA loop: per-chapter validator passes (fresh agent per
 * chapter) write jump-in-wiki-validation-NN-<id>.md partials; a findings-merge
 * agent consolidates them into the standard jump-in-wiki-validation-NN.md; the
 * unchanged acceptance one-shot scores it; on a failed window, per-chapter
 * feedback agents apply the chapter-tagged findings to wiki.md + shared-wiki.md.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runChunkedQaLoop(ctx) {
  const { values, bundle, volumeDir, wikiOutputFile, sharedWikiOutputFile, validationOutputFile } = ctx;
  const fsGate = ctx.fsGate;
  const recentRollingScores = [];

  for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: validation iteration ` +
        `${iteration}/${maxValidationIterations} (chapter by chapter)...`
    );

    // Per-chapter validation partials (fresh agent per chapter).
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const partialFile = path.join(
        volumeDir,
        `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}-${segment.id}.md`
      );
      const validator = await harness.createAgentHandle({
        name: `wiki-validator-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
        systemPrompt: buildWikiValidatorSystemPrompt(ctx),
        tools: fsGate.tools,
        approve: fsGate.approve,
        cwd: volumeDir,
        maxSteps: validatorMaxStepsFor((await fs.stat(path.join(volumeDir, segment.file))).size),
      });
      try {
        const validateResult = await validator.sendTurn(
          buildWikiSegmentValidatorPrompt(ctx, segment, si),
          { label: `jump-in-wiki-validate-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` }
        );
        assertRealToolCalls(validateResult, `the validator agent (chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        await assertWroteWithFallback(
          partialFile,
          `the validator agent (chapter ${segment.id})`,
          validateResult?.text
        );
      } finally {
        await validator.close();
      }
    }

    // Findings merge: consolidate the partials into the standard report.
    const merger = await harness.createAgentHandle({
      name: `wiki-validator-merge-${values.INSTALLMENT_NUMBER}-${iteration}`,
      systemPrompt: buildWikiValidatorSystemPrompt(ctx),
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      maxSteps: 20,
    });
    try {
      const mergeResult = await merger.sendTurn(
        buildWikiFindingsMergePrompt(ctx),
        { label: `jump-in-wiki-validate-merge-${values.INSTALLMENT_NUMBER}-${iteration}` }
      );
      assertRealToolCalls(mergeResult, "the findings-merge agent", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(validationOutputFile, "the findings-merge agent", mergeResult?.text);
    } finally {
      await merger.close();
    }

    // Acceptance: tool-less one-shot over the wiki artifacts + standard report.
    const acceptanceOutput = await harness.runOneShot({
      systemPrompt: ctx.acceptanceSystemPrompt,
      messages: [
        { file: ctx.wikiOutputFile, name: "wiki.md" },
        { file: ctx.sharedWikiOutputFile, name: "shared-wiki.md" },
        { file: validationOutputFile, name: path.basename(validationOutputFile) },
        { text: ctx.acceptanceUserPrompt },
      ],
      temperature: judgeTemperature(),
      ...judgeThinking("ACCEPTANCE"),
      label: `jump-in-wiki-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}`,
    });
    const reply = parseAcceptanceReply(acceptanceOutput);
    if (reply === null) {
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: acceptance check: no valid score in response ` +
          `(got: ${JSON.stringify(acceptanceOutput.trim().slice(0, 120))}). Counting this check as a failure.`
      );
    } else {
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: acceptance check: score ${reply.score}/100` +
          (reply.band ? ` (band: ${reply.band})` : "") +
          (reply.note ? ` — ${reply.note}` : "") +
          ` (passing score: ${ACCEPTANCE_PASSING_SCORE})`
      );
    }
    if (reply) {
      recentRollingScores.push(reply.score);
      if (recentRollingScores.length > ACCEPTANCE_WINDOW_SIZE) recentRollingScores.shift();
    }
    const wikiStateFile = validationOutputFile.replace(".md", "-rolling-state.json");
    await saveRollingState(wikiStateFile, recentRollingScores, {
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });

    // The same exceptional-score confirmation the whole-installment loop runs
    // (utils/qa-loop.js): a top-band grade is re-graded at temperature 0 and the
    // calm judging temperature, and a consensus accepts the volume WITHOUT the
    // expensive per-chapter feedback round below.
    const exceptional = await confirmExceptionalScore({
      score: reply ? reply.score : null,
      recentRollingScores,
      confirmationCheck: ({ index, temperature }) => wikiAcceptanceCheck(ctx, `confirm${index + 1}`, temperature),
      volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
      stateFile: wikiStateFile,
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });
    if (exceptional.accepted) {
      ctx.acceptedBy = "exceptional-consensus";
      break;
    }

    if (meetsAcceptanceCriteria(recentRollingScores)) {
      const avg = computeRollingAverage(recentRollingScores);
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: rolling average ${avg.toFixed(1)}/100 ` +
          `(${recentRollingScores.length} checks) meets the passing score ` +
          `${ACCEPTANCE_PASSING_SCORE}. Accepted.`
      );
      break;
    }

    // A grade that already passes earns the window's remaining samples by
    // re-grading this wiki, not by paying for a per-chapter feedback round plus a
    // second full round of per-chapter validators (see confirmPassingScore).
    const passing = await confirmPassingScore({
      score: reply ? reply.score : null,
      recentRollingScores,
      confirmationCheck: ({ index, temperature }) => wikiAcceptanceCheck(ctx, `confirm${index + 1}`, temperature),
      volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
      stateFile: wikiStateFile,
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });
    if (passing.accepted) {
      ctx.acceptedBy = "passing-consensus";
      break;
    }

    // Per-chapter feedback (fresh author agent per chapter, chapter-tagged
    // findings). Fingerprinted first: a feedback round that changed nothing is
    // not progress, and another iteration would re-audit an unchanged wiki.
    const watchedWikiFiles = [wikiOutputFile, sharedWikiOutputFile];
    const beforeFeedback = await fingerprintFiles(watchedWikiFiles);
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const feedbackAuthor = await harness.createAgentHandle({
        name: `wiki-feedback-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
        systemPrompt: buildWikiAuthorSystemPrompt(ctx),
        tools: fsGate.tools,
        approve: fsGate.approve,
        cwd: volumeDir,
        maxSteps: 40,
      });
      try {
        const feedbackResult = await feedbackAuthor.sendTurn(
          buildWikiSegmentFeedbackPrompt(ctx, segment, si),
          { label: `jump-in-wiki-feedback-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` }
        );
        assertRealToolCalls(feedbackResult, `the author agent (feedback pass, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        await assertWroteWithFallback(
          [wikiOutputFile, sharedWikiOutputFile],
          `the author agent (feedback pass, chapter ${segment.id})`,
          feedbackResult?.text
        );
      } finally {
        await feedbackAuthor.close();
      }
    }

    if ((await fingerprintFiles(watchedWikiFiles)) === beforeFeedback) {
      console.error(
        `Volume ${values.INSTALLMENT_NUMBER}: the per-chapter feedback round changed NOTHING — ` +
          `wiki.md and shared-wiki.md are byte-identical to what they were before it. Stopping the QA ` +
          `loop here rather than paying for another round of per-chapter validators over an unchanged ` +
          `wiki. Check the feedback agents' turn logs in .logs/ for turns that only read (the usual ` +
          `shape: step cap reached before anything was written).`
      );
      ctx.limitReached = true;
      await saveRollingState(wikiStateFile, recentRollingScores, {
        sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
        stalled: true,
      });
      if (ON_QA_LIMIT === "fail") {
        throw new Error(
          `Volume ${values.INSTALLMENT_NUMBER}: the feedback round applied nothing (ON_QA_LIMIT=fail).`
        );
      }
      break;
    }

    if (iteration === maxValidationIterations) {
      ctx.limitReached = true;
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit ` +
          `without a passing grade. The last feedback pass is unvalidated; re-run the task to validate it.`
      );
      if (ON_QA_LIMIT === "fail") {
        throw new Error(
          `Volume ${values.INSTALLMENT_NUMBER}: hit the validation iteration limit ` +
            `without a passing grade (ON_QA_LIMIT=fail).`
        );
      }
      break;
    }
  }
}


module.exports = {
  runChunkedVolumeAgent,
  runChunkedQaLoop,
};

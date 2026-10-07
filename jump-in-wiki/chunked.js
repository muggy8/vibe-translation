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
const { ON_QA_LIMIT } = require("../configs/shared");
const { fileExists, assertWroteWithFallback, assertRealOutput } = require("../utils/fs");
const { assertRealToolCalls } = require("../utils/agents");
const { runPerChapterQaLoop } = require("../utils/qa-loop");
const { validatorMaxStepsFor, findingsMergeMaxStepsFor } = require("../utils/prompt");

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
 * The loop itself — the iterations, the rolling window, the consensus gates, the
 * stalled-round check, the ON_QA_LIMIT policy — is the shared one in
 * utils/qa-loop/chunked.js. The grading is the shared wikiAcceptanceCheck too:
 * this loop used to re-implement it inline, which is how the two ways of
 * validating a wiki drifted apart.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runChunkedQaLoop(ctx) {
  const { values, bundle, volumeDir, wikiOutputFile, sharedWikiOutputFile, validationOutputFile } = ctx;
  const fsGate = ctx.fsGate;
  const n = values.INSTALLMENT_NUMBER;

  /** The validation partial one chapter's validator owes. @param {import("../types").SourceSegment} segment */
  const partialFile = (segment) => path.join(volumeDir, `jump-in-wiki-validation-${n}-${segment.id}.md`);

  const result = await runPerChapterQaLoop({
    volumeLabel: `Volume ${n}`,
    installment: n,
    cwd: volumeDir,
    tools: fsGate.tools,
    approve: fsGate.approve,
    chapters: bundle.segments,
    maxIterations: maxValidationIterations,
    onQaLimit: ON_QA_LIMIT,
    validationOutputFile,
    sourceFingerprint: bundle ? bundle.sourceFingerprint : undefined,
    feedbackArtifactFiles: [wikiOutputFile, sharedWikiOutputFile],
    acceptanceCheck: (iteration) => wikiAcceptanceCheck(ctx, iteration),
    confirmationCheck: ({ index, temperature }) => wikiAcceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    stalledLogLine: () =>
      `Volume ${n}: the per-chapter feedback round changed NOTHING — ` +
      `wiki.md and shared-wiki.md are byte-identical to what they were before it. Stopping the QA ` +
      `loop here rather than paying for another round of per-chapter validators over an unchanged ` +
      `wiki. Check the feedback agents' turn logs in .logs/ for turns that only read (the usual ` +
      `shape: step cap reached before anything was written).`,
    limitReachedLogLine: () =>
      `Volume ${n}: reached the validation iteration limit ` +
      `without a passing grade. The last feedback pass is unvalidated; re-run the task to validate it.`,

    validate: {
      name: ({ iteration, segment }) => `wiki-validator-${n}-${iteration}-${segment.id}`,
      systemPrompt: () => buildWikiValidatorSystemPrompt(ctx),
      maxSteps: async ({ segment }) => validatorMaxStepsFor((await fs.stat(path.join(volumeDir, segment.file))).size),
      prompt: ({ segment, si }) => buildWikiSegmentValidatorPrompt(ctx, segment, si),
      label: ({ iteration, segment }) => `jump-in-wiki-validate-${n}-${iteration}-${segment.id}`,
      recoveryLabel: ({ iteration, segment }) => `jump-in-wiki-validate-recovery-${n}-${iteration}-${segment.id}`,
      writesTo: ({ segment }) => partialFile(segment),
      who: ({ segment }) => `the validator agent (chapter ${segment.id})`,
    },

    merge: {
      name: ({ iteration }) => `wiki-validator-merge-${n}-${iteration}`,
      systemPrompt: () => buildWikiValidatorSystemPrompt(ctx),
      // Same rule as the other three tasks' merger (see findingsMergeMaxStepsFor
      // in utils/prompt.js): it reads every chapter partial plus the wiki it is
      // auditing before it can write anything, and a flat cap throws away the
      // whole validation round when it runs out mid-read.
      maxSteps: async () =>
        findingsMergeMaxStepsFor(bundle.segments.length, (await fs.stat(wikiOutputFile).catch(() => ({ size: 0 }))).size),
      prompt: () => buildWikiFindingsMergePrompt(ctx),
      label: ({ iteration }) => `jump-in-wiki-validate-merge-${n}-${iteration}`,
      writesTo: () => validationOutputFile,
      who: () => "the findings-merge agent",
    },

    feedback: {
      name: ({ iteration, segment }) => `wiki-feedback-${n}-${iteration}-${segment.id}`,
      systemPrompt: () => buildWikiAuthorSystemPrompt(ctx),
      maxSteps: () => 40,
      prompt: ({ segment, si }) => buildWikiSegmentFeedbackPrompt(ctx, segment, si),
      label: ({ iteration, segment }) => `jump-in-wiki-feedback-${n}-${iteration}-${segment.id}`,
      recoveryLabel: ({ iteration, segment }) => `jump-in-wiki-feedback-recovery-${n}-${iteration}-${segment.id}`,
      writesTo: () => [wikiOutputFile, sharedWikiOutputFile],
      who: ({ segment }) => `the author agent (feedback pass, chapter ${segment.id})`,
    },
  });

  ctx.acceptedBy = result.acceptedBy;
  ctx.limitReached = result.limitReached;
}


module.exports = {
  runChunkedVolumeAgent,
  runChunkedQaLoop,
};

/**
 * The chapter-by-chapter path for a volume too large for one pass: per-chapter
 * extract / research / amend in reading order, each chapter seeing the previous
 * chapter's state, so the cumulative artifact carries forward into the next
 * chapter's prompt instead of being reproduced whole.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { transformUserPrompt, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, authorMaxStepsFor, findingsMergeMaxStepsFor, writePromptDump } = require("../utils/prompt");
const { AGENT_TOOLS_NOTE, STAGE_CONCURRENCY: RESEARCH_CONCURRENCY, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError, readBoolEnv } = require("../configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback, assertRealOutput, writeProvenanceSidecar, inlineReferenceMessage, isPublishableArtifact, fingerprintFiles } = require("../utils/fs");
const { emittedToolCallAsText, assertRealToolCalls } = require("../utils/agents");
const { runSharedQaLoop, confirmExceptionalScore, confirmPassingScore, runVolumeWithModeFallback } = require("../utils/qa-loop");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  sourceSegmentListLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { pendingPlaceholder, researchBatch } = require("./research");
const { maxValidationIterations, researchEnabled } = require("./config");
const { parseTerms, truncateGlossary } = require("./extract");
const { buildGlossaryIndex, guardCarryForwardAgainst, seedGlossaryFromPrevious } = require("./carry-forward");
const { generateGlossary } = require("./amend");
const { acceptanceCheck } = require("./qa");
const { buildGlossaryFindingsMergePrompt, buildGlossarySegmentFeedbackPrompt, buildGlossarySegmentValidatorPrompt } = require("./prompts");
const { glossaryAuthorMaxSteps, glossaryRecoveryPrompt } = require("./authoring");

/**
 * Create or extend the skeleton-first research notes file with this chapter's
 * terms (chunked fallback). Chapter 1 creates the file with the volume header;
 * later chapters append a "## Chapter <id>" section. Each term gets a
 * "### <term>" heading with a unique "- (pending: <term>)" placeholder line.
 *
 * @param {string} researchNotesFile - Absolute path of glossary-research.md.
 * @param {{INSTALLMENT_NUMBER: string}} values - The volume values.
 * @param {SourceSegment} segment - The chapter being researched.
 * @param {Array<{term: string, type: string, query: string}>} terms - Its new terms.
 * @param {boolean} isFirstChapter - True for the first chapter of the volume.
 * @returns {Promise<void>}
 */
async function appendResearchSkeleton(researchNotesFile, values, segment, terms, isFirstChapter) {
  const section = [`## Chapter ${segment.id} — ${segment.title}`, ""];
  for (const t of terms) {
    section.push(`### ${t.term}`);
    section.push(pendingPlaceholder(t.term));
  }
  section.push("");
  const text = section.join("\n");
  if (isFirstChapter || !(await fileExists(researchNotesFile))) {
    await fs.writeFile(
      researchNotesFile,
      `# Research Notes — Volume ${values.INSTALLMENT_NUMBER}\n\n${text}`,
      "utf8"
    );
  } else {
    await fs.appendFile(researchNotesFile, `\n${text}`, "utf8");
  }
}


/**
 * Process a single volume chapter by chapter (the FALLBACK path, used when
 * the whole installment is too large for one pass): each chapter segment goes
 * through the same stage sequence a whole volume does — extract → research →
 * amend — chained so each chapter builds on the previous one's glossary
 * state. The QA loop then validates the finished volume chapter by chapter
 * (per-chapter partial reports → findings merge → acceptance) with
 * per-chapter feedback passes.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include bundle).
 */
async function runChunkedVolumeAgent(ctx) {
  const {
    values,
    bundle,
    volumeDir,
    glossaryOutputFile,
    researchNotesFile,
    isFirst,
    previousGlossaryFile,
    termsPrompt,
    termsSystemPrompt,
  } = ctx;
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: chapter-by-chapter fallback ` +
      `(${bundle.segments.length} segments, ${bundle.wholeChars} chars whole)...`
  );

  const fsGate = await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] });
  ctx.fsGate = fsGate;
  ctx.wikiTools = harness.createWikiTools();

  // Stale stray from earlier runs (same name anchor as the whole flow).
  const strayGlossary = path.join(volumeDir, `glossary-${values.INSTALLMENT_NUMBER}.md`);
  if (await fileExists(strayGlossary)) {
    await fs.rm(strayGlossary);
    console.log(`Removed the stale file "${strayGlossary}" (leftover from a previous run).`);
  }

  // Seed the volume's glossary from the previous volume's before the first
  // chapter touches it, so every chapter amends a real file rather than
  // reproducing a document too large for one reply to write.
  await seedGlossaryFromPrevious(ctx);

  const allChunkedTerms = [];
  for (let si = 0; si < bundle.segments.length; si++) {
    const segment = bundle.segments[si];
    // 1. Extract this chapter's new terms (one-shot). The cumulative reference
    // is the previous volume's glossary for the first chapter and the current
    // in-volume glossary afterwards.
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: chapter ${segment.id} (${segment.title}), ` +
        `${si + 1}/${bundle.segments.length} — extracting terms...`
    );
    const messages = [{ file: path.join(volumeDir, segment.file), name: segment.file }];
    const stateFile = si === 0 ? previousGlossaryFile : glossaryOutputFile;
    if (stateFile) {
      // The truncation is ranked by what THIS chapter actually contains (see
      // truncateGlossary), so the cumulative glossary shown to the extractor is
      // the part of it that matters for this chapter.
      const chapterSource = await fs.readFile(path.join(volumeDir, segment.file), "utf8");
      messages.push(
        await inlineReferenceMessage(stateFile, si === 0 ? "glossary-previous.md" : "glossary-current.md", {
          truncate: (raw) => truncateGlossary(raw, chapterSource),
        })
      );
    }
    messages.push({ text: termsPrompt }, { text: chapterSegmentNote(bundle, segment, si) });
    const termsOutput = await harness.runOneShot({
      systemPrompt: termsSystemPrompt,
      messages,
      label: `glossary-terms-${values.INSTALLMENT_NUMBER}-${segment.id}`,
    });
    let terms = [];
    try {
      terms = parseTerms(termsOutput);
    } catch (err) {
      console.warn(
        `Volume ${values.INSTALLMENT_NUMBER}: could not parse the term list for ` +
          `chapter ${segment.id} (${err.message}). Continuing without research.`
      );
    }
    allChunkedTerms.push(...terms);
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: extracted ${terms.length} new term(s) from chapter ${segment.id}.`
    );

    // 2. Research this chapter's new terms (skeleton-first, appended per chapter).
    if (researchEnabled && terms.length > 0) {
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: researching ${terms.length} new term(s) ` +
          `of chapter ${segment.id} (concurrency=${RESEARCH_CONCURRENCY})...`
      );
      await appendResearchSkeleton(researchNotesFile, values, segment, terms, si === 0);
      const termsWithIndices = terms.map((term, idx) => ({ ...term, _idx: idx }));
      for (let i = 0; i < termsWithIndices.length; i += RESEARCH_CONCURRENCY) {
        const batch = termsWithIndices.slice(i, i + RESEARCH_CONCURRENCY);
        await researchBatch(ctx, batch, segment);
        if (i + RESEARCH_CONCURRENCY < termsWithIndices.length) {
          const delayMs = parseInt(process.env.RESEARCH_DELAY_MS, 10) || 300;
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    // 3. Amend the glossary with this chapter's terms (fresh author agent).
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: amending the glossary with chapter ${segment.id} (author agent)...`
    );
    // The state this chapter must not shrink. Read before the pass, compared
    // after it: a chapter pass that rewrites the glossary from memory is where
    // the cumulative entries actually disappear.
    let chapterBaseline = null;
    try {
      chapterBaseline = await fs.readFile(glossaryOutputFile, "utf8");
    } catch {
      chapterBaseline = null; // No glossary yet — this chapter creates it.
    }
    // The index must describe the state THIS chapter is about to amend, and the
    // earlier chapters have already added rows to it.
    if (chapterBaseline !== null) ctx.glossaryIndex = buildGlossaryIndex(chapterBaseline);

    await generateGlossary(ctx, terms, researchEnabled && terms.length > 0, segment, si);

    if (chapterBaseline !== null) {
      await guardCarryForwardAgainst(
        ctx,
        chapterBaseline,
        `the amend pass for chapter ${segment.id}`,
        "the glossary as of the previous chapter"
      );
    }
  }

  // Persist the volume's new-term extraction (all chapters) so the
  // translation handoff (utils/handoff.js) can render a "what's new in this
  // volume" section without re-calling the AI.
  try {
    await fs.writeFile(
      path.join(volumeDir, "glossary-new-terms.json"),
      JSON.stringify(allChunkedTerms, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not persist glossary-new-terms.json (${err.message}) — continuing.`
    );
  }

  // QA loop: per-chapter validation partials → findings merge → acceptance.
  await runChunkedQaLoop(ctx);
}


/**
 * Chunked (fallback) QA loop: per-chapter validator passes (fresh agent per
 * chapter) write glossary-validation-<id>.md partials; a findings-merge agent
 * consolidates them into the standard glossary-validation.md; the unchanged
 * acceptance one-shot scores it; on a failed window, per-chapter feedback
 * agents apply the chapter-tagged findings.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runChunkedQaLoop(ctx) {
  const { values, bundle, volumeDir, glossaryOutputFile, validationOutputFile } = ctx;
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
      const partialFile = path.join(volumeDir, `glossary-validation-${segment.id}.md`);
      const validator = await harness.createAgentHandle({
        name: `validator-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
        systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
        tools: fsGate.tools,
        approve: fsGate.approve,
        cwd: volumeDir,
        maxSteps: validatorMaxStepsFor((await fs.stat(path.join(volumeDir, segment.file))).size),
      });
      try {
        const validateResult = await validator.sendTurn(
          buildGlossarySegmentValidatorPrompt(ctx, segment, si),
          { label: `glossary-validate-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` }
        );
        assertRealToolCalls(validateResult, `the validator agent (chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        const validateFallbackUsed = await assertWroteWithFallback(
          partialFile,
          `the validator agent (chapter ${segment.id})`,
          validateResult?.text
        );
        // Recovery turn: ONLY when the partial was actually missing after the
        // fallback — never over a file the agent already wrote correctly.
        if (validateFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
          const hasContent = validateResult?.text && validateResult.text.trim().length > 0;
          const recoveryPrompt = hasContent
            ? `You were asked to write the validation report to "${path.basename(partialFile)}" using writeFile, but you replied with the content in your chat message instead. Please rewrite the complete report using writeFile now.`
            : `You produced no output. Please read the materials and write the complete validation report to "${path.basename(partialFile)}" using writeFile now.`;
          const recoveryResult = await validator.sendTurn(recoveryPrompt, {
            label: `glossary-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
          });
          assertRealToolCalls(recoveryResult, `the validator agent (recovery, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
          await assertWroteWithFallback(
            partialFile,
            `the validator agent (recovery, chapter ${segment.id})`,
            recoveryResult?.text
          );
        }
        await assertRealOutput(partialFile, `the validator agent (chapter ${segment.id})`);
      } finally {
        await validator.close();
      }
    }

    // Findings merge: consolidate the partials into the standard report.
    const merger = await harness.createAgentHandle({
      name: `validator-merge-${values.INSTALLMENT_NUMBER}-${iteration}`,
      systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      // The merger reads every chapter partial AND the glossary it is auditing,
      // then writes one consolidated report. A fixed 20 ran out on a 10-chapter
      // volume (observed: 34 read/grep calls before it could write anything),
      // which threw away the whole validation round's work. Scale it with the
      // number of partials plus the pages of glossary it must read.
      maxSteps: findingsMergeMaxStepsFor(
        bundle.segments.length,
        (await fs.stat(glossaryOutputFile)).size
      ),
    });
    try {
      const mergeResult = await merger.sendTurn(
        buildGlossaryFindingsMergePrompt(ctx),
        { label: `glossary-validate-merge-${values.INSTALLMENT_NUMBER}-${iteration}` }
      );
      assertRealToolCalls(mergeResult, "the findings-merge agent", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(validationOutputFile, "the findings-merge agent", mergeResult?.text);
      await assertRealOutput(validationOutputFile, "the findings-merge agent");
    } finally {
      await merger.close();
    }

    // Acceptance (unchanged: tool-less one-shot over the standard report).
    const score = await acceptanceCheck(ctx, iteration);
    if (score !== null) {
      recentRollingScores.push(score);
      if (recentRollingScores.length > ACCEPTANCE_WINDOW_SIZE) recentRollingScores.shift();
    }
    const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
    await saveRollingState(stateFilePath, recentRollingScores, {
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });

    // The same exceptional-score confirmation the whole-installment loop runs
    // (utils/qa-loop.js): a top-band grade is re-graded at temperature 0 and the
    // calm judging temperature, and a consensus accepts the volume WITHOUT the
    // expensive per-chapter feedback round below.
    const exceptional = await confirmExceptionalScore({
      score,
      recentRollingScores,
      confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
      volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
      stateFile: stateFilePath,
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });
    if (exceptional.accepted) {
      // The chunked loop's contract: the only other way out of the loop is the
      // iteration limit (which sets ctx.limitReached). Reaching here means the
      // consensus accepted the volume, so record HOW it was accepted for the
      // run summary and stop before the per-chapter feedback round.
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
    // re-grading this glossary, not by paying for a per-chapter feedback round
    // plus a second full round of per-chapter validators (see confirmPassingScore).
    const passing = await confirmPassingScore({
      score,
      recentRollingScores,
      confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
      volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
      stateFile: stateFilePath,
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });
    if (passing.accepted) {
      ctx.acceptedBy = "passing-consensus";
      break;
    }

    // Per-chapter feedback (fresh agent per chapter, chapter-tagged findings).
    // Fingerprinted first: a feedback round that changed nothing is not progress,
    // and another iteration would re-audit an unchanged glossary.
    const beforeFeedback = await fingerprintFiles(glossaryOutputFile);
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const feedbackAuthor = await harness.createAgentHandle({
        name: `feedback-author-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
        systemPrompt: ctx.glossarySystemPrompt + AGENT_TOOLS_NOTE,
        tools: fsGate.tools,
        approve: fsGate.approve,
        cwd: volumeDir,
        maxSteps: await glossaryAuthorMaxSteps(ctx, segment),
      });
      // The state this chapter's correction must not shrink (see the amend
      // pass above — the same failure mode, reached from the other side).
      let feedbackBaseline = null;
      try {
        feedbackBaseline = await fs.readFile(glossaryOutputFile, "utf8");
      } catch {
        feedbackBaseline = null;
      }
      // The index must describe the glossary as it is NOW, chapter by chapter.
      if (feedbackBaseline !== null) ctx.glossaryIndex = buildGlossaryIndex(feedbackBaseline);

      try {
        const feedbackResult = await feedbackAuthor.sendTurn(
          buildGlossarySegmentFeedbackPrompt(ctx, segment, si),
          { label: `glossary-feedback-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` }
        );
        assertRealToolCalls(feedbackResult, `the author agent (feedback pass, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        const feedbackFallbackUsed = await assertWroteWithFallback(
          glossaryOutputFile,
          `the author agent (feedback pass, chapter ${segment.id})`,
          feedbackResult?.text
        );
        // Recovery turn: ONLY when the glossary was actually missing after the
        // fallback — never over a file the agent already wrote correctly.
        if (feedbackFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
          const hasContent = feedbackResult?.text && feedbackResult.text.trim().length > 0;
          const recoveryPrompt = glossaryRecoveryPrompt(
            hasContent,
            '"glossary.md"',
            `the chapter source, the validation report, and the current glossary`
          );
          const recoveryResult = await feedbackAuthor.sendTurn(recoveryPrompt, {
            label: `glossary-feedback-recovery-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
          });
          assertRealToolCalls(recoveryResult, `the author agent (feedback recovery, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
          await assertWroteWithFallback(
            glossaryOutputFile,
            `the author agent (feedback recovery, chapter ${segment.id})`,
            recoveryResult?.text
          );
        }
        await assertRealOutput(glossaryOutputFile, `the author agent (feedback pass, chapter ${segment.id})`);
      } finally {
        await feedbackAuthor.close();
      }

      if (feedbackBaseline !== null) {
        await guardCarryForwardAgainst(
          ctx,
          feedbackBaseline,
          `the feedback pass for chapter ${segment.id}`,
          "the glossary as of the previous chapter"
        );
      }
    }

    if ((await fingerprintFiles(glossaryOutputFile)) === beforeFeedback) {
      console.error(
        `Volume ${values.INSTALLMENT_NUMBER}: the per-chapter feedback round changed NOTHING — ` +
          `glossary.md is byte-identical to what it was before it. Stopping the QA loop here rather ` +
          `than paying for another round of per-chapter validators over an unchanged glossary. Check ` +
          `the feedback agents' turn logs in .logs/ for turns that only read (the usual shape: step ` +
          `cap reached before anything was written).`
      );
      ctx.limitReached = true;
      await saveRollingState(stateFilePath, recentRollingScores, {
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
          `without a passing grade. The last feedback pass is unvalidated; re-run to validate it.`
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
  appendResearchSkeleton,
  runChunkedVolumeAgent,
  runChunkedQaLoop,
};

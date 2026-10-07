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
const { validatorMaxStepsFor, findingsMergeMaxStepsFor } = require("../utils/prompt");
const { AGENT_TOOLS_NOTE, STAGE_CONCURRENCY: RESEARCH_CONCURRENCY, ON_QA_LIMIT } = require("../configs/shared");
const { fileExists, inlineReferenceMessage } = require("../utils/fs");
const { runPerChapterQaLoop, validationReportRecoveryPrompt } = require("../utils/qa-loop");
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
 * The loop itself — the iterations, the rolling window, the consensus gates, the
 * stalled-round check, the ON_QA_LIMIT policy — is the shared one in
 * utils/qa-loop/chunked.js. What is written here is only what the glossary says
 * to its agents and what it must not lose while they say it.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runChunkedQaLoop(ctx) {
  const { values, bundle, volumeDir, glossaryOutputFile, validationOutputFile } = ctx;
  const fsGate = ctx.fsGate;
  const n = values.INSTALLMENT_NUMBER;

  /** The validation partial one chapter's validator owes. @param {import("../types").SourceSegment} segment */
  const partialFile = (segment) => path.join(volumeDir, `glossary-validation-${segment.id}.md`);

  // The state this chapter's correction must not shrink, read before its turn
  // and compared after it (see the amend pass above — the same failure mode,
  // reached from the other side).
  let feedbackBaseline = null;

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
    feedbackArtifactFiles: [glossaryOutputFile],
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    stalledLogLine: () =>
      `Volume ${n}: the per-chapter feedback round changed NOTHING — ` +
      `glossary.md is byte-identical to what it was before it. Stopping the QA loop here rather ` +
      `than paying for another round of per-chapter validators over an unchanged glossary. Check ` +
      `the feedback agents' turn logs in .logs/ for turns that only read (the usual shape: step ` +
      `cap reached before anything was written).`,
    limitReachedLogLine: () =>
      `Volume ${n}: reached the validation iteration limit ` +
      `without a passing grade. The last feedback pass is unvalidated; re-run to validate it.`,

    validate: {
      name: ({ iteration, segment }) => `validator-${n}-${iteration}-${segment.id}`,
      systemPrompt: () => ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
      maxSteps: async ({ segment }) => validatorMaxStepsFor((await fs.stat(path.join(volumeDir, segment.file))).size),
      prompt: ({ segment, si }) => buildGlossarySegmentValidatorPrompt(ctx, segment, si),
      label: ({ iteration, segment }) => `glossary-validate-${n}-${iteration}-${segment.id}`,
      recoveryLabel: ({ iteration, segment }) => `glossary-validate-recovery-${n}-${iteration}-${segment.id}`,
      recoveryWho: ({ segment }) => `the validator agent (recovery, chapter ${segment.id})`,
      recoveryPrompt: (hasContent, { segment }) => validationReportRecoveryPrompt(hasContent, partialFile(segment)),
      writesTo: ({ segment }) => partialFile(segment),
      who: ({ segment }) => `the validator agent (chapter ${segment.id})`,
    },

    merge: {
      name: ({ iteration }) => `validator-merge-${n}-${iteration}`,
      systemPrompt: () => ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
      // The merger reads every chapter partial AND the glossary it is auditing,
      // then writes one consolidated report. A fixed 20 ran out on a 10-chapter
      // volume (observed: 34 read/grep calls before it could write anything),
      // which threw away the whole validation round's work. Scale it with the
      // number of partials plus the pages of glossary it must read.
      maxSteps: async () =>
        findingsMergeMaxStepsFor(bundle.segments.length, (await fs.stat(glossaryOutputFile)).size),
      prompt: () => buildGlossaryFindingsMergePrompt(ctx),
      label: ({ iteration }) => `glossary-validate-merge-${n}-${iteration}`,
      writesTo: () => validationOutputFile,
      who: () => "the findings-merge agent",
    },

    feedback: {
      name: ({ iteration, segment }) => `feedback-author-${n}-${iteration}-${segment.id}`,
      systemPrompt: () => ctx.glossarySystemPrompt + AGENT_TOOLS_NOTE,
      maxSteps: ({ segment }) => glossaryAuthorMaxSteps(ctx, segment),
      prompt: ({ segment, si }) => buildGlossarySegmentFeedbackPrompt(ctx, segment, si),
      label: ({ iteration, segment }) => `glossary-feedback-${n}-${iteration}-${segment.id}`,
      recoveryLabel: ({ iteration, segment }) => `glossary-feedback-recovery-${n}-${iteration}-${segment.id}`,
      recoveryWho: ({ segment }) => `the author agent (feedback recovery, chapter ${segment.id})`,
      recoveryPrompt: (hasContent) =>
        glossaryRecoveryPrompt(
          hasContent,
          '"glossary.md"',
          `the chapter source, the validation report, and the current glossary`
        ),
      writesTo: () => glossaryOutputFile,
      who: ({ segment }) => `the author agent (feedback pass, chapter ${segment.id})`,
      beforeChapter: async ({ segment }) => {
        feedbackBaseline = await fs.readFile(glossaryOutputFile, "utf8").catch(() => null);
        // The index must describe the glossary as it is NOW, chapter by chapter.
        if (feedbackBaseline !== null) ctx.glossaryIndex = buildGlossaryIndex(feedbackBaseline);
      },
      afterChapter: async ({ segment }) => {
        if (feedbackBaseline !== null) {
          await guardCarryForwardAgainst(
            ctx,
            feedbackBaseline,
            `the feedback pass for chapter ${segment.id}`,
            "the glossary as of the previous chapter"
          );
        }
      },
    },
  });

  ctx.acceptedBy = result.acceptedBy;
  ctx.limitReached = result.limitReached;
}


module.exports = {
  appendResearchSkeleton,
  runChunkedVolumeAgent,
  runChunkedQaLoop,
};

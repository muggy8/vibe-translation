/**
 * One volume, processed in one pass: generate wiki.md + shared-wiki.md (both files are
 * stubbed first — a stronger name anchor than "create a new file", and a crashed run
 * leaves identifiable stubs), then the QA loop (a fresh validator agent writes the
 * validation report, the acceptance one-shot scores the wiki 0-100, and unless the rolling
 * window meets the criterion the SAME author session applies the feedback).
 *
 * Two-tier idempotency: if wiki.md + shared-wiki.md exist, generation is skipped and
 * validation still runs; if a validation report exists and passes acceptance, the whole
 * volume is skipped.
 *
 * Part of the jump-in-wiki.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { ON_QA_LIMIT } = require("../configs/shared");
const { fileExists, assertRealOutput } = require("../utils/fs");
const { assertRealToolCalls } = require("../utils/agents");
const { validatorMaxStepsFor } = require("../utils/prompt");
const { runSharedQaLoop, runWriteTurn } = require("../utils/qa-loop");

const { buildWikiAuthorSystemPrompt, buildWikiAuthorTurnPrompt, buildWikiFeedbackTurnPrompt, buildWikiValidatorSystemPrompt, buildWikiValidatorTurnPrompt } = require("./prompts");
const { runChunkedVolumeAgent } = require("./chunked");
const { maxValidationIterations } = require("./config");
const { wikiAcceptanceCheck } = require("./acceptance");

/**
 * Process a single volume: generate the wiki (author agent) -> QA loop
 * (independent validator agent + one-shot acceptance + same author session
 * for feedback). Chunked (fallback) volumes take runChunkedVolumeAgent instead.
 *
 * @param {WikiVolumeCtx} ctx - The volume context (see jumpInWiki()).
 */
async function runVolumeAgent(ctx) {
  const {
    values,
    volumeDir,
    wikiOutputFile,
    sharedWikiOutputFile,
    wikiAndSharedWikiExists,
  } = ctx;

  // Chunked (fallback) volumes take the per-chapter flow instead.
  if (ctx.chunked) {
    await runChunkedVolumeAgent(ctx);
    return;
  }

  // File tools gated to this volume's folder (reads are allowed anywhere,
  // so the agents can also read the volume source and the previous volume).
  const fsGate = await harness.createGatedFsTools({
    cwd: volumeDir,
    allowedDirs: [volumeDir],
  });
  ctx.fsGate = fsGate;

  // Remove stale strays from earlier runs (agent name drift): the workflow
  // itself never writes files with the classic marker names, so anything
  // named like that in the volume folder is garbage that only wastes agent
  // steps (observed live: a validator audited a stale stray wiki).
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

  // The author agent keeps its session across the generation and feedback
  // turns of this volume.
  const author = await harness.createAgentHandle({
    name: `wiki-author-${values.INSTALLMENT_NUMBER}`,
    systemPrompt: buildWikiAuthorSystemPrompt(ctx),
    tools: fsGate.tools,
    approve: fsGate.approve,
    cwd: volumeDir,
    maxSteps: 40,
  });
  try {
    // the logic for generating the wiki
    if (wikiAndSharedWikiExists) {
      console.log("Wiki for the current volume exists. skipping initial generation and proceeding to validation");
    } else {
      console.log("Calling the AI for initial wiki generation (author agent)...");
      // Scaffold stubs: pre-create both output files so the agent overwrites
      // existing files (a stronger name anchor than "create a new file") and
      // a crashed run leaves identifiable stubs instead of nothing.
      if (!(await fileExists(wikiOutputFile))) {
        await fs.writeFile(
          wikiOutputFile,
          `(stub — the agent replaces this with the complete volume wiki for volume ${values.INSTALLMENT_NUMBER})\n`,
          "utf8"
        );
      }
      if (!(await fileExists(sharedWikiOutputFile))) {
        await fs.writeFile(
          sharedWikiOutputFile,
          `(stub — the agent replaces this with the complete shared wiki)\n`,
          "utf8"
        );
      }
      await runWriteTurn(author, {
        prompt: buildWikiAuthorTurnPrompt(ctx),
        label: `jump-in-wiki-generate-${values.INSTALLMENT_NUMBER}`,
        who: "the author agent",
        writesTo: [wikiOutputFile, sharedWikiOutputFile],
        // The wiki owes TWO documents, so its recovery prompt names both of them and says what
        // already happened to them — the shared default cannot know that.
        recoveryPrompt: (hasContent) =>
          hasContent
            ? `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
              `Both files have been temporarily written from your chat reply, but they must be written properly using writeFile. ` +
              `Please rewrite both files using writeFile now. Use the exact same content you generated in your previous message: ` +
              `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`
            : `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you produced no output.\n\n` +
              `Please read the source materials and write both files using writeFile now: ` +
              `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`,
        recoveryLabel: `jump-in-wiki-recovery-${values.INSTALLMENT_NUMBER}`,
        recoveryWho: "the author agent (recovery)",
        recoveryNote:
          `Volume ${values.INSTALLMENT_NUMBER}: sending recovery turn ` +
          `(model replied in chat instead of writeFile)...`,
        // Hard stop: a surviving scaffold stub is a failure, not an artifact.
        verifyOutput: true,
        assertToolCalls: (result, whoLabel) => assertRealToolCalls(result, whoLabel, values.INSTALLMENT_NUMBER),
      });
    }

    await runQaLoop(ctx, author);
  } finally {
    await author.close();
  }
}


/**
 * QA loop: independent validator agent (fresh per iteration) ->
 * score-based acceptance check (0–100, see configs/shared.js) -> feedback
 * applied by the same author session that generated the wiki. Runs the
 * shared loop from utils/qa-loop.js with the wiki-specific pieces supplied
 * here (the wiki keeps its author session for the feedback pass, unlike the
 * other tasks' fresh-agent-per-iteration feedback).
 *
 * @param {WikiVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 * @param {AgentHandle} author - The author agent handle (keeps its session).
 */
async function runQaLoop(ctx, author) {
  const { values, volumeDir, sourceFile, validationOutputFile, fsGate } = ctx;
  const result = await runSharedQaLoop({
    volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
    iterationLogLine: (iteration) => `Validation iteration ${iteration}/${maxValidationIterations}...`,
    validatorLogLine: () => "Calling the AI for validation (validator agent)...",
    acceptanceLogLine: () => "Calling the AI for the acceptance check...",
    maxIterations: maxValidationIterations,
    onQaLimit: ON_QA_LIMIT,
    validationOutputFile,
    stateFile: validationOutputFile.replace(".md", "-rolling-state.json"),
    sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    createValidatorAgent: async (iteration) => harness.createAgentHandle({
      name: `wiki-validator-${values.INSTALLMENT_NUMBER}-${iteration}`,
      systemPrompt: buildWikiValidatorSystemPrompt(ctx),
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      // scaled to the source size (see validatorMaxStepsFor)
      maxSteps: validatorMaxStepsFor((await fs.stat(sourceFile)).size),
    }),
    buildValidatorTurn: (iteration) => buildWikiValidatorTurnPrompt(ctx),
    validatorLabel: (iteration) => `jump-in-wiki-validate-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryLabel: (iteration) => `jump-in-wiki-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryPrompt: (hasContent) => hasContent
      ? `You were asked to write the validation report to "jump-in-wiki-validation-NN.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
        `The file has been temporarily written from your chat reply, but it must be written properly using writeFile. ` +
        `Please rewrite the complete validation report using writeFile now. Use the exact same content you generated in your previous message.`
      : `You were asked to write the validation report using writeFile, but you produced no output.\n\n` +
        `Please read the source materials and write the complete validation report using writeFile now.`,
    assertRealToolCalls: (result, who) => assertRealToolCalls(result, who, values.INSTALLMENT_NUMBER),
    acceptanceCheck: (iteration) => wikiAcceptanceCheck(ctx, iteration),
    // Exceptional-score confirmation re-grades (see utils/qa-loop.js).
    confirmationCheck: ({ index, temperature }) => wikiAcceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    feedbackLogLine: () => "Calling the AI to apply the validation feedback (author agent)...",
    runFeedback: (iteration) => runWikiFeedback(ctx, author, iteration),
    // The loop stops when a feedback pass leaves these byte-identical: a turn
    // that only read is not an iteration (see fingerprintFiles in utils/fs.js).
    feedbackArtifactFiles: [ctx.wikiOutputFile, ctx.sharedWikiOutputFile],
    limitReachedLogLine: () => `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit (${maxValidationIterations}) without a passing grade. The last feedback pass is unvalidated; re-run the task to validate it.`,
  });
  ctx.limitReached = result.limitReached;
  return result;
}


/**
 * The wiki feedback stage (called by the shared QA loop in
 * utils/qa-loop.js): the SAME author session that generated the wiki applies
 * the validation report (the wiki task reuses its session; the other tasks
 * use a fresh author agent per feedback pass).
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
 * @param {AgentHandle} author - The author agent handle (keeps its session).
 * @param {number} iteration - The current QA iteration (for the labels).
 */
async function runWikiFeedback(ctx, author, iteration) {
  const { values, wikiOutputFile, sharedWikiOutputFile } = ctx;
  // The shared turn protocol (utils/qa-loop/turn.js). The wiki's recovery prompt
  // is kept here because it names the two files and how they pair up — the one
  // thing the generic wording cannot say. No assertRealOutput: this stage reuses
  // the author session that built the wiki, and the loop's own stalled-round
  // check is what catches a feedback turn that wrote nothing.
  await runWriteTurn(author, {
    prompt: buildWikiFeedbackTurnPrompt(ctx),
    label: `jump-in-wiki-feedback-${values.INSTALLMENT_NUMBER}-${iteration}`,
    who: "the author agent (feedback pass)",
    writesTo: [wikiOutputFile, sharedWikiOutputFile],
    recoveryLabel: `jump-in-wiki-feedback-recovery-${values.INSTALLMENT_NUMBER}-${iteration}`,
    recoveryWho: "the author agent (feedback recovery)",
    recoveryPrompt: (hasContent) => hasContent
      ? `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
        `Both files have been temporarily written from your chat reply, but they must be written properly using writeFile. ` +
        `Please rewrite both files using writeFile now. Use the exact same content you generated in your previous message: ` +
        `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`
      : `You were asked to write the complete wiki to "wiki.md" and "shared-wiki.md" using writeFile, but you produced no output.\n\n` +
        `Please read the source materials and the validation report and write both files using writeFile now: ` +
        `write wiki.md to "wiki.md" and shared-wiki.md to "shared-wiki.md".`,
    verifyOutput: false,
    assertToolCalls: (result, who) => assertRealToolCalls(result, who, values.INSTALLMENT_NUMBER),
  });
}

// ─── Export for use as a module ─────────────────────────────────────────────


module.exports = {
  runVolumeAgent,
  runQaLoop,
  runWikiFeedback,
};

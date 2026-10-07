/**
 * The task entry point and the per-volume whole-installment pass: resolve the plan
 * of record, walk the volumes in reading order, and keep the cumulative cascade —
 * regenerating any volume regenerates every later one, because their glossaries
 * would otherwise build on a stale base.
 *
 * The series plumbing (flags, plan of record, previous-volume gate, idempotency skip,
 * series-root publish, per-volume error policy) is the shared `utils/series-run` layer;
 * what is left here is the glossary's own decisions.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { transformUserPrompt, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, authorMaxStepsFor, findingsMergeMaxStepsFor, writePromptDump } = require("../utils/prompt");
const { AGENT_TOOLS_NOTE, STAGE_CONCURRENCY: RESEARCH_CONCURRENCY, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, saveRollingState, ON_QA_LIMIT, validateRequiredEnv, judgeTemperature, judgeThinking, isStructuralError, readBoolEnv } = require("../configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback, assertRealOutput, inlineReferenceMessage } = require("../utils/fs");
const { loadGlossaryDisputes } = require("../utils/disputes");
const { runSharedQaLoop, confirmExceptionalScore, confirmPassingScore, runVolumeWithModeFallback } = require("../utils/qa-loop");
const { readRunArgs, openSeriesRun, locatePreviousVolume, requirePreviousArtifacts, volumeAlreadyAccepted, publishLatestToSeriesRoot, runVolumeSeries } = require("../utils/series-run");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  sourceSegmentListLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { acceptanceSystemPromptFile, acceptanceUserPromptTemplateFile, feedbackSystemPromptFile, feedbackUserPromptTemplateFile, glossarySystemPromptFile, glossaryUserPromptTemplateFile, researchEnabled, seriesDir, termsSystemPromptFile, termsUserPromptTemplateFile, validatorSystemPromptFile, validatorUserPromptTemplateFile } = require("./config");
const { buildDisputesNote, buildUnusedEntriesNote } = require("./notes");
const { RESEARCHER_SYSTEM_PROMPT, buildPerTermResearchPrompt, pendingPlaceholder, researchBatch } = require("./research");
const { buildGlossaryAuthorTurnPrompt, buildGlossaryFeedbackTurnPrompt, buildGlossaryFindingsMergePrompt, buildGlossarySegmentFeedbackPrompt, buildGlossarySegmentValidatorPrompt, buildGlossaryValidatorTurnPrompt } = require("./prompts");
const { assertGlossaryCarryForward, buildGlossaryIndex, seedGlossaryFromPrevious } = require("./carry-forward");
const { writeGlossaryCoverageReport } = require("./coverage");
const { parseTerms, truncateGlossary } = require("./extract");
const { runChunkedVolumeAgent } = require("./chunked");
const { generateGlossary } = require("./amend");
const { runQaLoop } = require("./qa");

/** The glossary stage's own file names inside a volume folder. */
const OUTPUT_FILE = "glossary.md";
const VALIDATION_FILE = "glossary-validation.md";
const RESEARCH_FILE = "glossary-research.md";
const NEW_TERMS_FILE = "glossary-new-terms.json";

/**
 * Read the glossary stage's prompt pair for each of its five roles.
 * @returns {Promise<Object>} `{ <role>SystemPrompt, <role>Template }` for terms/glossary/validator/acceptance/feedback.
 */
async function loadPromptFiles() {
  const read = (file) => fs.readFile(file, "utf-8");
  return {
    termsSystemPrompt: await read(termsSystemPromptFile),
    glossarySystemPrompt: await read(glossarySystemPromptFile),
    validatorSystemPrompt: await read(validatorSystemPromptFile),
    acceptanceSystemPrompt: await read(acceptanceSystemPromptFile),
    feedbackSystemPrompt: await read(feedbackSystemPromptFile),
    termsTemplate: await read(termsUserPromptTemplateFile),
    glossaryTemplate: await read(glossaryUserPromptTemplateFile),
    validatorTemplate: await read(validatorUserPromptTemplateFile),
    acceptanceTemplate: await read(acceptanceUserPromptTemplateFile),
    feedbackTemplate: await read(feedbackUserPromptTemplateFile),
  };
}

/**
 * Run the glossary task.
 *
 * The cascade flag is the cumulative invariant: once any volume is regenerated, every LATER volume
 * is regenerated too, because its glossary was built on the artifact that just changed.
 */
async function glossary() {
  const { dryRun, force, chunked, volumeArg } = readRunArgs();

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  // Fail fast (before any AI call) if required env vars are missing — the aggregated message names
  // every missing variable (SERIES_NAME is never required; the intake step decides it).
  validateRequiredEnv({ dryRun });

  const prompts = await loadPromptFiles();
  const { manifest, runSettings, folders, volumes, volumeByFolder } = await openSeriesRun({ seriesDir, dryRun, volumeArg });
  console.log(`Found ${folders.length} volume folder(s). Processing in order...`);

  const cascade = { regeneratedAny: false };
  const run = { folders, volumeByFolder, runSettings, prompts, dryRun, force, chunked, cascade };
  await runVolumeSeries("glossary", {
    volumes,
    folders,
    volumeByFolder,
    processVolume: (folderName, index) => processGlossaryVolume({ folderName, index }, run),
    // Copy the last volume's glossary to the series root for easy access (skipped for
    // single-volume runs, which would publish a stale snapshot).
    afterVolumes: () =>
      publishLatestToSeriesRoot({
        seriesDir,
        folders,
        fileName: OUTPUT_FILE,
        envKey: "GLOSSARY_OUTPUT_FILE",
        label: "glossary",
        volumeArg,
        dryRun,
      }),
  });
}


/**
 * One volume of the glossary run: resolve its source, its base, and its processing mode; then
 * preview it, skip it, or build it.
 *
 * @param {{ folderName: string, index: number }} target - The volume and its position in the reading order.
 * @param {{
 *   folders: string[],
 *   volumeByFolder: Map<string, Object>,
 *   runSettings: {seriesName: string, sourceLanguage: string, targetLanguage: string},
 *   prompts: Object,
 *   dryRun: boolean,
 *   force: boolean,
 *   chunked: boolean,
 *   cascade: { regeneratedAny: boolean },
 * }} run - What every volume of this run shares.
 * @returns {Promise<void>}
 */
async function processGlossaryVolume({ folderName, index }, run) {
  const { folders, volumeByFolder, runSettings, prompts, dryRun, force, chunked, cascade } = run;
  const volume = volumeByFolder.get(folderName);
  const volumeDir = path.join(seriesDir, folderName);
  const values = {
    INSTALLMENT_NUMBER: volume.installmentNumber,
    SOURCE_NAME: runSettings.seriesName,
    SOURCE_LANGUAGE: runSettings.sourceLanguage,
    TARGET_LANGUAGE: runSettings.targetLanguage,
  };

  // Resolve the source into a bundle: plain-text sources pass through as-is (the default
  // whole-installment path); .epub sources are normalized once (cached) into <base>-whole.md +
  // per-chapter files + images/ in the volume folder. The pipelines then work on plain text only.
  const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
  if (!(await fileExists(bundle.originalPath))) {
    throw new Error(`Required source file not found: ${bundle.originalPath}`);
  }

  const { ctx, proceed } = await buildVolumeContext({
    folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, volume, dryRun, chunked,
  });
  if (!proceed) return;

  if (dryRun) {
    await dumpVolumePreview(ctx);
    return;
  }

  // Idempotency: skip a volume whose glossary already exists and met the score-based acceptance
  // criterion, unless a previous volume was regenerated (which would make it stale).
  if (await volumeAlreadyAccepted({
    installmentNumber: values.INSTALLMENT_NUMBER,
    outputFiles: [ctx.glossaryOutputFile],
    validationOutputFile: ctx.validationOutputFile,
    bundle,
    force,
    regeneratedAny: cascade.regeneratedAny,
    artifactLabel: "glossary",
  })) {
    // The coverage report is deterministic (no AI) — refresh it even on a skip so a source change
    // is visible without a full regeneration.
    await writeGlossaryCoverageReport(ctx);
    return;
  }

  // A volume is being (re)generated; later volumes depend on it.
  cascade.regeneratedAny = true;

  await runVolumeWithModeFallback({
    label: `Volume ${volume.installmentNumber}`,
    ctx,
    volumeDir,
    run: async () => {
      await runVolumeAgent(ctx);
      // Deterministic term-coverage audit of the finished glossary (no AI) — also the per-volume
      // "terms used here" index for the translation stage.
      await writeGlossaryCoverageReport(ctx);
    },
    attemptFiles: [
      OUTPUT_FILE,
      NEW_TERMS_FILE,
      RESEARCH_FILE,
      VALIDATION_FILE,
      "glossary-validation-rolling-state.json",
      "glossary-coverage.md",
      "glossary-coverage.json",
    ],
    attemptGlob: /^glossary-.*\.md$/,
  });
}


/**
 * Assemble the volume context: the previous volume's glossary (the base this one amends), the
 * notes fed back from the previous volume's audits, and the processing mode.
 *
 * @returns {Promise<{ ctx: GlossaryVolumeCtx, proceed: boolean }>} `proceed` false when the
 *   run policy said to skip this volume (a missing base).
 */
async function buildVolumeContext({ folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, volume, dryRun, chunked }) {
  const { isFirst, previousFolderName } = locatePreviousVolume({ folders, index, volumeByFolder });

  // The previous volume's glossary (the in-progress glossary). Absent for the first volume.
  const previous = await requirePreviousArtifacts({
    seriesDir,
    previousFolderName,
    fileNames: [OUTPUT_FILE],
    label: "glossary",
    installmentNumber: values.INSTALLMENT_NUMBER,
    dryRun,
  });
  const previousGlossaryFile = previous.files[0] || null;
  if (previous.skipVolume) return { ctx: null, proceed: false };

  const ctx = {
    values,
    folderName,
    volumeDir,
    sourceFile: bundle.wholePath,
    bundle,
    isFirst,
    previousFolderName,
    previousGlossaryFile,
    glossaryOutputFile: path.join(volumeDir, OUTPUT_FILE),
    validationOutputFile: path.join(volumeDir, VALIDATION_FILE),
    researchNotesFile: path.join(volumeDir, RESEARCH_FILE),
    glossaryTemplate: prompts.glossaryTemplate,
    termsSystemPrompt: prompts.termsSystemPrompt,
    glossarySystemPrompt: prompts.glossarySystemPrompt,
    validatorSystemPrompt: prompts.validatorSystemPrompt,
    acceptanceSystemPrompt: prompts.acceptanceSystemPrompt,
    feedbackSystemPrompt: prompts.feedbackSystemPrompt,
  };

  // Report → input: the previous volume's coverage audit (which glossary entries were never used)
  // is handed to this volume's extraction pass.
  ctx.disputesText = await collectFeedbackNotes(ctx, values);

  // Transform the prompts that use only the standard placeholders. The extraction prompt carries the
  // previous volume's unused-entry audit on the end of it.
  ctx.termsPrompt = transformUserPrompt(prompts.termsTemplate, values) + (ctx.unusedEntriesNote || "");
  ctx.validatorPrompt = transformUserPrompt(prompts.validatorTemplate, values);
  ctx.feedbackPrompt = transformUserPrompt(prompts.feedbackTemplate, values);
  ctx.acceptancePrompt = transformUserPrompt(prompts.acceptanceTemplate, values);

  // Whole-installment vs chapter-by-chapter, decided against THIS stage's model window and the
  // reference it will actually inject (the previous volume's cumulative glossary — decided per
  // volume because it grows every volume). See planProcessingMode in utils/source.js.
  const mode = await decideProcessingMode({
    bundle,
    label: `Volume ${volume.installmentNumber}`,
    previousArtifactFiles: previousGlossaryFile ? [previousGlossaryFile] : [],
    forceChunked: chunked,
    dryRun,
  });
  ctx.chunked = mode.chunked;

  return { ctx, proceed: true };
}


/**
 * Read the two channels that feed a volume's amendment task: the previous volume's unused-entry
 * audit, and the glossary disputes the translation stage raised.
 *
 * Without the second one the glossary only ever grows and a wrong entry is carried forward by every
 * later volume while the QA loop argues about it each time. Both are best-effort: a queue that
 * cannot be read degrades to "amend without it" rather than failing the volume.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (mutated with `unusedEntriesNote` / `disputesText`).
 * @param {{INSTALLMENT_NUMBER: string}} values
 * @returns {Promise<string>} The disputes note.
 */
async function collectFeedbackNotes(ctx, values) {
  const { INSTALLMENT_NUMBER } = values;
  ctx.unusedEntriesNote = "";
  if (ctx.previousFolderName) {
    try {
      const coveragePath = path.join(seriesDir, ctx.previousFolderName, "glossary-coverage.json");
      if (await fileExists(coveragePath)) {
        ctx.unusedEntriesNote = buildUnusedEntriesNote(JSON.parse(await fs.readFile(coveragePath, "utf8")));
      }
    } catch (err) {
      console.warn(
        `Volume ${INSTALLMENT_NUMBER}: could not read the previous volume's coverage audit ` +
          `(${err.message}) — extraction proceeds without it.`
      );
    }
  }

  try {
    const disputes = await loadGlossaryDisputes(seriesDir);
    ctx.disputesText = buildDisputesNote(disputes, INSTALLMENT_NUMBER);
    if (ctx.disputesText) {
      console.log(
        `Volume ${INSTALLMENT_NUMBER}: ${disputes.length} open glossary dispute(s) ` +
          `are part of this volume's amendment task.`
      );
    }
  } catch (err) {
    console.warn(
      `Volume ${INSTALLMENT_NUMBER}: could not read the glossary disputes queue ` +
        `(${err.message}) — amending without them.`
    );
  }
  return ctx.disputesText;
}


/**
 * `--dry-run`: write the exact prompts a live run would send, and make no AI call.
 *
 * The preview must match the live run: a live run copies the previous volume's glossary in before
 * the author turn (seedGlossaryFromPrevious), so from volume 02 on the author is told to edit that
 * file in place — not to recreate it — and the term map that copy produces is part of the preview.
 *
 * @param {GlossaryVolumeCtx} ctx
 * @returns {Promise<void>}
 */
async function dumpVolumePreview(ctx) {
  const { values } = ctx;
  ctx.glossarySeeded = !ctx.isFirst;
  ctx.glossaryIndex = ctx.previousGlossaryFile
    ? buildGlossaryIndex(await fs.readFile(ctx.previousGlossaryFile, "utf8").catch(() => ""))
    : "";
  // The term-dependent prompts carry an illustrative term list (the real list only exists after the
  // extraction call, which dry-run skips).
  const illustrativeTerms = [
    { term: "（例の用語）", type: "character", query: "（例の用語）" },
  ];
  const sections = [
    { title: "One-shot — terms extraction system prompt", prompt: ctx.termsSystemPrompt },
    { title: "One-shot — terms extraction user prompt", prompt: ctx.termsPrompt },
    { title: "AGENT — researcher system prompt", prompt: RESEARCHER_SYSTEM_PROMPT },
    {
      title: "AGENT — per-term researcher turn (illustrative term list, concurrency=" + RESEARCH_CONCURRENCY + ")",
      prompt: buildPerTermResearchPrompt(ctx, illustrativeTerms[0], 0),
    },
    { title: "AGENT — author system prompt", prompt: ctx.glossarySystemPrompt + AGENT_TOOLS_NOTE },
    { title: "AGENT — author turn (illustrative term list)", prompt: buildGlossaryAuthorTurnPrompt(ctx, illustrativeTerms, false) },
    { title: "AGENT — validator system prompt", prompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE },
    { title: "AGENT — validator turn", prompt: buildGlossaryValidatorTurnPrompt(ctx) },
    { title: "AGENT — feedback turn (applied by the author session)", prompt: buildGlossaryFeedbackTurnPrompt(ctx) },
    { title: "One-shot — acceptance user prompt (always tool-less)", prompt: ctx.acceptancePrompt },
  ];
  // Chunked (fallback) volumes: dump the chapter-scoped variants too.
  if (ctx.chunked && ctx.bundle.segments.length > 1) {
    const seg = ctx.bundle.segments[0];
    sections.push(
      {
        title: "CHUNKED — per-chapter terms extraction user prompt (first chapter)",
        prompt: ctx.termsPrompt + "\n\n" + chapterSegmentNote(ctx.bundle, seg, 0),
      },
      { title: "CHUNKED — segment author turn (illustrative term list)", prompt: buildGlossaryAuthorTurnPrompt(ctx, illustrativeTerms, false, seg, 0) },
      { title: "CHUNKED — segment validator turn (first chapter)", prompt: buildGlossarySegmentValidatorPrompt(ctx, seg, 0) },
      { title: "CHUNKED — findings merge turn", prompt: buildGlossaryFindingsMergePrompt(ctx) },
      { title: "CHUNKED — segment feedback turn (first chapter)", prompt: buildGlossarySegmentFeedbackPrompt(ctx, seg, 0) }
    );
  }
  const dumpFile = await writePromptDump("glossary", values.INSTALLMENT_NUMBER, "agent", sections);
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: no AI calls. ` +
      `The exact prompts (agent-mode turns + tool-less stages) are written to ${dumpFile}`
  );
}


/**
 * Process a single volume: extract terms -> research (researcher agent) ->
 * amend the glossary (author agent) -> QA loop (validator agent + acceptance
 * + feedback). Chunked (fallback) volumes take runChunkedVolumeAgent instead.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (see glossary()).
 */
async function runVolumeAgent(ctx) {
  const {
    values,
    folderName,
    volumeDir,
    sourceFile,
    glossaryOutputFile,
    researchNotesFile,
    isFirst,
    previousFolderName,
    previousGlossaryFile,
    termsPrompt,
    termsSystemPrompt,
  } = ctx;

  // Chunked (fallback) volumes take the per-chapter flow instead.
  if (ctx.chunked) {
    await runChunkedVolumeAgent(ctx);
    return;
  }

  const terms = await extractNewTerms(ctx);
  await openAgentTools(ctx);

  // Pass 2: research the new terms with parallel agents (one per term, batched).
  const researchNotesAvailable = researchEnabled && terms.length > 0;
  if (researchNotesAvailable) {
    await researchNewTerms(ctx, terms);
  }

  // Pass 3: amend the glossary with the author agent (standalone — creates and closes its own
  // session; no persistent context across QA iterations).
  //
  // The previous volume's glossary is copied in first (deterministic, no model call), so the agent
  // amends a real file instead of reproducing a document too large for one reply to write. See
  // seedGlossaryFromPrevious.
  await seedGlossaryFromPrevious(ctx);

  console.log(`Volume ${values.INSTALLMENT_NUMBER}: amending the glossary (author agent)...`);

  await generateGlossary(ctx, terms, researchNotesAvailable);
  await assertGlossaryCarryForward(ctx, "the amend pass");

  // QA loop: fresh validator per iteration + fresh author for feedback.
  await runQaLoop(ctx);
}


/**
 * Pass 1 — extract this volume's new terms (one tool-less call: an exhaustive one-pass JSON
 * extraction that needs no tools), persist them for the translation handoff, and return the list.
 *
 * The previous volume's glossary is INLINED (not offered as a readFile) so the cumulative glossary
 * is bounded here: the whole 17-volume glossary sitting in the extraction turn is how the extraction
 * starts inventing rows.
 *
 * @param {GlossaryVolumeCtx} ctx
 * @returns {Promise<Array<{term: string, type: string, query: string}>>} The extracted terms ([] when the reply is unparseable).
 */
async function extractNewTerms(ctx) {
  const { values, sourceFile, previousGlossaryFile, termsPrompt, termsSystemPrompt } = ctx;
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: extracting new terms...`);
  const baseMessages = [{ file: sourceFile, name: path.basename(sourceFile) }];
  if (!ctx.isFirst) {
    const volumeSourceText = await fs.readFile(sourceFile, "utf8");
    baseMessages.push(
      await inlineReferenceMessage(previousGlossaryFile, "glossary-previous.md", {
        truncate: (raw) => truncateGlossary(raw, volumeSourceText),
      })
    );
  }
  const termsOutput = await harness.runOneShot({
    systemPrompt: termsSystemPrompt,
    messages: [...baseMessages, { text: termsPrompt }],
    label: `glossary-terms-${values.INSTALLMENT_NUMBER}`,
  });
  let terms = [];
  try {
    terms = parseTerms(termsOutput);
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not parse the term list ` +
        `(${err.message}). Continuing without research.`
    );
  }
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: extracted ${terms.length} new term(s).`);
  // Persist the volume's new-term extraction so the translation handoff (utils/handoff.js) can
  // render a "what's new in this volume" section without re-calling the AI.
  try {
    await fs.writeFile(
      path.join(ctx.volumeDir, NEW_TERMS_FILE),
      JSON.stringify(terms, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not persist ${NEW_TERMS_FILE} (${err.message}) — continuing.`
    );
  }
  return terms;
}


/**
 * Give this volume's agents their tools, and clear the strays an earlier run left behind.
 *
 * The gate is the sandbox: reads are allowed anywhere (so the agents can also read the volume source
 * and the previous volume), writes are confined to this volume's folder.
 *
 * @param {GlossaryVolumeCtx} ctx - Mutated with `fsGate` and `wikiTools`.
 */
async function openAgentTools(ctx) {
  const { values, volumeDir } = ctx;
  ctx.fsGate = await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] });

  // Wikipedia research tools for the per-term researcher agents. createWikiTools() is synchronous —
  // it just wraps research.js with the current RESEARCH_* env settings. (Observed live: this
  // assignment was missing, so the researcher agents were created with wiki_search/wiki_extract set
  // to undefined and the model's first tool call threw "Cannot read properties of undefined
  // (reading 'execute')".)
  ctx.wikiTools = harness.createWikiTools();

  // Remove stale strays from earlier runs (agent name drift): a per-volume classic-style name like
  // "glossary-01.md" is never written by the workflow itself, so anything like that is leftover garbage.
  const strayGlossary = path.join(volumeDir, `glossary-${values.INSTALLMENT_NUMBER}.md`);
  if (await fileExists(strayGlossary)) {
    await fs.rm(strayGlossary);
    console.log(
      `Removed the stale file "glossary-${values.INSTALLMENT_NUMBER}.md" (leftover from a previous run).`
    );
  }
}


/**
 * Pass 2 — research the extracted terms with parallel agents, one per term, in batches.
 *
 * Skeleton-first: the workflow writes the notes file with a "- (pending)" placeholder under every
 * term, and each agent replaces its own placeholder via editFile. Even a crashed run leaves a usable
 * skeleton, and the placeholders left over at the end are the honest count of what was not answered.
 *
 * @param {GlossaryVolumeCtx} ctx
 * @param {Array<{term: string, type: string, query: string}>} terms
 * @returns {Promise<void>}
 */
async function researchNewTerms(ctx, terms) {
  const { values, researchNotesFile } = ctx;
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: researching ${terms.length} new term(s) ` +
      `in parallel (concurrency=${RESEARCH_CONCURRENCY})...`
  );
  const skeletonLines = ["# Research Notes — Volume " + values.INSTALLMENT_NUMBER, ""];
  for (const term of terms) {
    skeletonLines.push(`### ${term.term}`);
    skeletonLines.push(pendingPlaceholder(term.term));
  }
  skeletonLines.push("");
  await fs.writeFile(researchNotesFile, skeletonLines.join("\n"), "utf8");

  // Tag each term with its original index so the batch function can pass the correct line number to
  // the per-term prompt.
  const termsWithIndices = terms.map((term, idx) => ({ ...term, _idx: idx }));
  for (let i = 0; i < termsWithIndices.length; i += RESEARCH_CONCURRENCY) {
    const batch = termsWithIndices.slice(i, i + RESEARCH_CONCURRENCY);
    await researchBatch(ctx, batch);
    // Politeness delay between batches (not within a batch, which runs in parallel).
    if (i + RESEARCH_CONCURRENCY < termsWithIndices.length) {
      const delayMs = parseInt(process.env.RESEARCH_DELAY_MS, 10) || 300;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  if (!(await fileExists(researchNotesFile))) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: the research notes file is missing ` +
        `(the agent deleted it?); continuing without research.`
    );
    return;
  }
  const remainingText = await fs.readFile(researchNotesFile, "utf8");
  // Count the unique "- (pending: <term>)" lines still present (a bare "- (pending)" split would
  // not match the new unique format).
  const remaining = (remainingText.match(/^- \(pending: .+\)$/gm) || []).length;
  if (remaining > 0) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: research finished with ${remaining} ` +
        `term(s) still unresolved (placeholder left in place).`
    );
  }
}


module.exports = {
  glossary,
  runVolumeAgent,
};

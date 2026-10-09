/**
 * The gulp task and the per-volume decision, including the cumulative cascade.
 *
 * The series plumbing (flags, plan of record, previous-volume gate, idempotency skip, series-root
 * publish, per-volume error policy) is the shared `utils/series-run` layer; what is left here is the
 * style guide's own decisions.
 *
 * Part of the style-guide.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const harness = require("../harness");
const { transformUserPrompt, writePromptDump } = require("../utils/prompt");
const { validateRequiredEnv } = require("../configs/shared");
const { fileExists } = require("../utils/fs");
const { runVolumeWithModeFallback } = require("../utils/qa-loop");
const { readRunArgs, openSeriesRun, locatePreviousVolume, requirePreviousArtifacts, volumeAlreadyAccepted, publishLatestToSeriesRoot, runVolumeSeries } = require("../utils/series-run");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { acceptanceSystemPromptFile, acceptanceUserPromptTemplateFile, authorSystemPromptFile, authorUserPromptTemplateFile, extractSystemPromptFile, extractUserPromptTemplateFile, feedbackSystemPromptFile, feedbackUserPromptTemplateFile, seriesDir, validatorSystemPromptFile, validatorUserPromptTemplateFile } = require("./config");
const { buildStyleIndex } = require("./reference-index");
const { buildAuthorSystemPrompt, buildAuthorTurnPrompt, buildFeedbackTurnPrompt, buildStyleFindingsMergePrompt, buildValidatorSystemPrompt, buildValidatorTurnPrompt } = require("./prompts");
const { assertStyleCarryForward, seedStyleGuideFromPrevious } = require("./carry-forward");
const { parseStyleObservations } = require("./amend");
const { runCompile, runExtract } = require("./stages");
const { runQaLoop } = require("./qa");
const { runChunkedVolume } = require("./chunked");

/** The style-guide stage's own file names inside a volume folder. */
const STYLE_FILE = "style-guide.md";
const VALIDATION_FILE = "style-guide-validation.md";
const NEW_ENTRIES_FILE = "style-guide-new.json";

/**
 * Read the style stage's prompt pair for each of its five roles.
 * @returns {Promise<Object>} `{ <role>SystemPrompt, <role>Template }` for extract/author/validator/acceptance/feedback.
 */
async function loadPromptFiles() {
  const read = (file) => fs.readFile(file, "utf8");
  return {
    extractSystemPrompt: await read(extractSystemPromptFile),
    extractTemplate: await read(extractUserPromptTemplateFile),
    authorSystemPrompt: await read(authorSystemPromptFile),
    authorTemplate: await read(authorUserPromptTemplateFile),
    validatorSystemPrompt: await read(validatorSystemPromptFile),
    validatorTemplate: await read(validatorUserPromptTemplateFile),
    acceptanceSystemPrompt: await read(acceptanceSystemPromptFile),
    acceptanceTemplate: await read(acceptanceUserPromptTemplateFile),
    feedbackSystemPrompt: await read(feedbackSystemPromptFile),
    feedbackTemplate: await read(feedbackUserPromptTemplateFile),
  };
}

/**
 * The gulp task entry point for the style-guide workflow.
 *
 * The cascade flag is the cumulative invariant: once any volume is regenerated, every LATER volume
 * is regenerated too, because its guide was built on the one that just changed.
 */
async function styleGuide() {
  const { dryRun, force, chunked, volumeArg } = readRunArgs();
  console.log("style-guide task starting...");
  validateRequiredEnv({ dryRun });

  const prompts = await loadPromptFiles();
  const { runSettings, folders, volumes, volumeByFolder } = await openSeriesRun({ seriesDir, dryRun, volumeArg });

  const cascade = { regeneratedAny: false };
  const run = { folders, volumeByFolder, runSettings, prompts, dryRun, force, chunked, cascade };
  await runVolumeSeries("style-guide", {
    volumes,
    folders,
    volumeByFolder,
    processVolume: (folderName, index) => processStyleVolume({ folderName, index }, run),
    afterVolumes: () =>
      publishLatestToSeriesRoot({
        seriesDir,
        folders,
        fileName: STYLE_FILE,
        envKey: "STYLE_OUTPUT_FILE",
        label: "style guide",
        volumeArg,
        dryRun,
      }),
  });
}


/**
 * One volume of the style run: resolve its source, its base, and its processing mode; then preview
 * it, skip it, or build it.
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
async function processStyleVolume({ folderName, index }, run) {
  const { folders, volumeByFolder, runSettings, prompts, dryRun, force, chunked, cascade } = run;
  const volume = volumeByFolder.get(folderName);
  const volumeDir = path.join(seriesDir, folderName);
  const values = {
    INSTALLMENT_NUMBER: volume.installmentNumber,
    SOURCE_NAME: runSettings.seriesName,
    SOURCE_LANGUAGE: runSettings.sourceLanguage,
    TARGET_LANGUAGE: runSettings.targetLanguage,
  };

  // Resolve the source into a bundle (utils/source.js): plain-text sources pass through as-is (the
  // default whole-installment path); .epub sources are normalized once (cached) into per-chapter +
  // whole Markdown files.
  const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });

  const { ctx, proceed } = await buildVolumeContext({
    folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, volume, dryRun, chunked,
  });
  if (!proceed) return;

  if (dryRun) {
    await dumpVolumePreview(ctx);
    return;
  }

  if (await volumeAlreadyAccepted({
    installmentNumber: values.INSTALLMENT_NUMBER,
    outputFiles: [ctx.styleOutputFile],
    validationOutputFile: ctx.validationOutputFile,
    bundle,
    force,
    regeneratedAny: cascade.regeneratedAny,
    artifactLabel: "style guide",
  })) {
    return;
  }

  cascade.regeneratedAny = true;

  await runVolumeWithModeFallback({
    label: `Volume ${volume.installmentNumber}`,
    ctx,
    volumeDir,
    run: () => runVolume(ctx),
    attemptFiles: [
      STYLE_FILE,
      NEW_ENTRIES_FILE,
      VALIDATION_FILE,
      "style-guide-validation-rolling-state.json",
    ],
    attemptGlob: /^style-guide-.*\.md$/,
  });
}


/**
 * Assemble the volume context: the previous volume's guide (the base this one amends) and the
 * processing mode.
 *
 * The agent-mode turn prompts name the base at its real relative path
 * (`../<previous folder>/style-guide.md`) — the same convention as the other cumulative stages.
 *
 * @returns {Promise<{ ctx: StyleGuideVolumeCtx, proceed: boolean }>} `proceed` false when the run
 *   policy said to skip this volume (a missing base).
 */
async function buildVolumeContext({ folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, volume, dryRun, chunked }) {
  const { isFirst, previousFolderName } = locatePreviousVolume({ folders, index, volumeByFolder });

  const previous = await requirePreviousArtifacts({
    seriesDir,
    previousFolderName,
    fileNames: [STYLE_FILE],
    label: "style guide",
    installmentNumber: values.INSTALLMENT_NUMBER,
    dryRun,
  });
  if (previous.skipVolume) return { ctx: null, proceed: false };

  const ctx = {
    values,
    folderName,
    volumeDir,
    sourceFile: bundle.wholePath,
    bundle,
    isFirst,
    previousFolderName,
    previousStyleGuideFile: previous.files[0] || null,
    styleOutputFile: path.join(volumeDir, STYLE_FILE),
    validationOutputFile: path.join(volumeDir, VALIDATION_FILE),
    extractPrompt: transformUserPrompt(prompts.extractTemplate, values),
    validatorPrompt: transformUserPrompt(prompts.validatorTemplate, values),
    feedbackPrompt: transformUserPrompt(prompts.feedbackTemplate, values),
    acceptancePrompt: transformUserPrompt(prompts.acceptanceTemplate, values),
    extractTemplate: prompts.extractTemplate,
    authorTemplate: prompts.authorTemplate,
    extractSystemPrompt: prompts.extractSystemPrompt,
    authorSystemPrompt: prompts.authorSystemPrompt,
    validatorSystemPrompt: prompts.validatorSystemPrompt,
    acceptanceSystemPrompt: prompts.acceptanceSystemPrompt,
    feedbackSystemPrompt: prompts.feedbackSystemPrompt,
    authorUserPrompt: prompts.authorTemplate,
    validatorUserPrompt: prompts.validatorTemplate,
    feedbackUserPrompt: prompts.feedbackTemplate,
  };

  // Whole-installment vs chapter-by-chapter, decided against THIS stage's model window and the
  // reference it will actually inject (the previous volume's cumulative guide — decided per volume
  // because it grows every volume). See planProcessingMode in utils/source.js.
  const mode = await decideProcessingMode({
    bundle,
    label: `Volume ${volume.installmentNumber}`,
    previousArtifactFiles: ctx.previousStyleGuideFile ? [ctx.previousStyleGuideFile] : [],
    forceChunked: chunked,
    dryRun,
  });
  ctx.chunked = mode.chunked;

  return { ctx, proceed: true };
}


/**
 * `--dry-run`: write the exact prompts a live run would send, and make no AI call.
 *
 * The preview must match the live run: a live run seeds style-guide.md from the previous volume
 * whenever there is one, and it shows the section map that copy produces — a preview that promises
 * "amend it in place" while hiding the map the agent uses to find the section is a preview of a
 * different prompt.
 *
 * @param {StyleGuideVolumeCtx} ctx
 * @returns {Promise<void>}
 */
async function dumpVolumePreview(ctx) {
  const { values } = ctx;
  ctx.styleSeeded = !ctx.isFirst && Boolean(ctx.previousStyleGuideFile) && (await fileExists(ctx.previousStyleGuideFile));
  ctx.styleIndex = ctx.styleSeeded
    ? buildStyleIndex(await fs.readFile(ctx.previousStyleGuideFile, "utf8").catch(() => ""))
    : "";
  const illustrative = JSON.stringify([{ category: "honorific", pattern: "ex", description: "ex", examples: ["ex"], frequency: "high", notes: "ex" }]);
  const sections = [
    { title: "One-shot — extraction system prompt", prompt: ctx.extractSystemPrompt },
    { title: "One-shot — extraction user prompt", prompt: ctx.extractPrompt },
    { title: "AGENT — author system prompt", prompt: buildAuthorSystemPrompt(ctx.authorSystemPrompt) },
    { title: "AGENT — author turn (illustrative)", prompt: buildAuthorTurnPrompt(ctx, illustrative) },
    { title: "AGENT — validator system prompt", prompt: buildValidatorSystemPrompt(ctx.validatorSystemPrompt) },
    { title: "AGENT — validator turn", prompt: buildValidatorTurnPrompt(ctx) },
    { title: "AGENT — feedback turn", prompt: buildFeedbackTurnPrompt(ctx) },
    { title: "One-shot — acceptance user prompt", prompt: ctx.acceptancePrompt },
  ];
  // Chunked (fallback) volumes: dump the chapter-scoped variants too.
  if (ctx.chunked && ctx.bundle.segments.length > 1) {
    const seg = ctx.bundle.segments[0];
    sections.push(
      { title: "CHUNKED — per-chapter extraction user prompt (first chapter)", prompt: ctx.extractPrompt + "\n\n" + chapterSegmentNote(ctx.bundle, seg, 0) },
      { title: "CHUNKED — segment author turn (illustrative)", prompt: buildAuthorTurnPrompt(ctx, illustrative, seg, 0) },
      { title: "CHUNKED — segment validator turn (first chapter)", prompt: buildValidatorTurnPrompt(ctx, seg, 0) },
      { title: "CHUNKED — findings merge turn", prompt: buildStyleFindingsMergePrompt(ctx) },
      { title: "CHUNKED — segment feedback turn (first chapter)", prompt: buildFeedbackTurnPrompt(ctx, seg, 0) }
    );
  }
  const dumpFile = await writePromptDump("style-guide", values.INSTALLMENT_NUMBER, "agent", sections);
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: --dry-run: prompts dumped to ${dumpFile}`);
}


/**
 * Process a single volume: extract -> compile -> QA loop. Chunked (fallback)
 * volumes take runChunkedVolume instead.
 * @param {StyleGuideVolumeCtx} ctx
 */
async function runVolume(ctx) {
  const { values } = ctx;
  // Chunked (fallback) volumes take the per-chapter flow instead.
  if (ctx.chunked) {
    await runChunkedVolume(ctx);
    return;
  }
  let extractionOutput = "";
  try { extractionOutput = await runExtract(ctx); } catch (err) { console.error(`Volume ${values.INSTALLMENT_NUMBER}: extraction failed: ${err.message}. Check the run's log folder for details.`); throw err; }
  // Persist the volume's extraction results (the new style constructs) so the translation handoff
  // (utils/handoff.js) can render a "what's new in this volume" section without re-calling the AI.
  try {
    await fs.writeFile(path.join(ctx.volumeDir, NEW_ENTRIES_FILE), JSON.stringify(parseStyleObservations(extractionOutput), null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: could not persist ${NEW_ENTRIES_FILE} (${err.message}) — continuing.`);
  }
  // Create fsGate BEFORE runCompile so the author agent has file tools. createGatedFsTools is async —
  // it must be awaited, otherwise fsGate is a Promise and ctx.fsGate.tools/approve are undefined, so
  // the agents are created with no tools at all.
  ctx.fsGate = await harness.createGatedFsTools({ cwd: ctx.volumeDir, allowedDirs: [ctx.volumeDir] });
  // The previous volume's guide is copied in BEFORE any agent touches the folder, so the compile pass
  // amends a real file instead of reproducing a document too large for one reply (see
  // seedStyleGuideFromPrevious).
  await seedStyleGuideFromPrevious(ctx);
  try { await runCompile(ctx, extractionOutput); } catch (err) { console.error(`Volume ${values.INSTALLMENT_NUMBER}: compilation failed: ${err.message}. Check the run's log folder for details.`); throw err; }
  await assertStyleCarryForward(ctx, "the compile pass");
  await runQaLoop(ctx);
}

// The "model emitted tool-call syntax as plain text" guard (emittedToolCallAsText
// + assertRealToolCalls) is shared by every file-writing task — see
// utils/agents.js (AGENTS.md gotcha 18).


module.exports = {
  styleGuide,
  runVolume,
};

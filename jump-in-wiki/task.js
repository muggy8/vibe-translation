/**
 * The gulp task: resolve the plan of record, walk the volumes in reading order, settle each one,
 * write the handoff, then publish the last real shared-wiki.md to the series root and report how
 * many volumes hit the iteration limit.
 *
 * The series plumbing (flags, plan of record, previous-volume gate, idempotency skip, series-root
 * publish, per-volume error policy) is the shared `utils/series-run` layer; what is left here is the
 * wiki's own decisions.
 *
 * adoptStrayOutput and knownVolumeFileNames are the housekeeping half: the files this task is allowed
 * to find in a volume folder, and what to do with an output an agent wrote under a name the workflow
 * does not use.
 *
 * Part of the jump-in-wiki.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const { validateRequiredEnv } = require("../configs/shared");
const { fileExists, hasRealOutput } = require("../utils/fs");
const { runVolumeWithModeFallback } = require("../utils/qa-loop");
const { writeVolumeHandoff } = require("../utils/handoff");
const { readRunArgs, openSeriesRun, locatePreviousVolume, requirePreviousArtifacts, volumeAlreadyAccepted, publishLatestToSeriesRoot, runVolumeSeries } = require("../utils/series-run");
const { transformUserPrompt, writePromptDump } = require("../utils/prompt");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { acceptanceSystemPromptFile, acceptanceUserPromptTemplateFile, feedbackSystemPromptFile, feedbackUserPromptTemplateFile, maxValidationIterations, seriesDir, systemPromptFile, userPromptTemplateFile, validatorSystemPromptFile, validatorUserPromptTemplateFile } = require("./config");
const { buildWikiAuthorSystemPrompt, buildWikiAuthorTurnPrompt, buildWikiFeedbackTurnPrompt, buildWikiFindingsMergePrompt, buildWikiMergeTurnPrompt, buildWikiSectionTurnPrompt, buildWikiSegmentFeedbackPrompt, buildWikiSegmentValidatorPrompt, buildWikiValidatorSystemPrompt, buildWikiValidatorTurnPrompt } = require("./prompts");
const { runVolumeAgent } = require("./whole");

/** The wiki stage's own file names inside a volume folder. */
const WIKI_FILE = "wiki.md";
const SHARED_WIKI_FILE = "shared-wiki.md";

/**
 * Read the wiki stage's prompt pair for each of its four roles.
 * @returns {Promise<Object>} `{ <role>SystemPrompt, <role>Template }` for author/validator/feedback/acceptance.
 */
async function loadPromptFiles() {
  const read = (file) => fs.readFile(file, "utf-8");
  return {
    systemPrompt: await read(systemPromptFile),
    template: await read(userPromptTemplateFile),
    validatorSystemPrompt: await read(validatorSystemPromptFile),
    validatorTemplate: await read(validatorUserPromptTemplateFile),
    feedbackSystemPrompt: await read(feedbackSystemPromptFile),
    feedbackTemplate: await read(feedbackUserPromptTemplateFile),
    acceptanceSystemPrompt: await read(acceptanceSystemPromptFile),
    acceptanceTemplate: await read(acceptanceUserPromptTemplateFile),
  };
}

/**
 * The gulp task entry point for the wiki workflow.
 *
 * The cascade flag is the cumulative invariant the other three cumulative tasks enforce: once any
 * volume is regenerated, every LATER volume is regenerated too — its wiki was built on the artifact
 * that just changed, so keeping it would leave the series state built on a stale base.
 */
async function jumpInWiki() {
  const { dryRun, force, chunked, volumeArg } = readRunArgs();

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  // Fail fast (before any AI call) if required env vars are missing — the aggregated message names
  // every missing variable.
  validateRequiredEnv({ dryRun });

  const prompts = await loadPromptFiles();
  const { runSettings, folders, volumes, volumeByFolder } = await openSeriesRun({ seriesDir, dryRun, volumeArg });

  const cascade = { regeneratedAny: false };
  const tally = { limitReached: 0 };
  const run = { folders, volumeByFolder, runSettings, prompts, dryRun, force, chunked, cascade, tally };

  const failedVolumes = await runVolumeSeries("jump-in-wiki", {
    volumes,
    folders,
    volumeByFolder,
    processVolume: (folderName, index) => processWikiVolume({ folderName, index }, run),
    afterVolumes: async () => {
      if (tally.limitReached > 0) {
        console.log(
          `\n${tally.limitReached} of ${folders.length} volume(s) reached the validation iteration ` +
            `limit (${maxValidationIterations}). Consider increasing QA_MAX_ITERATIONS if this is unexpected.`
        );
      }
      // Copy the last existing shared wiki to the series root (symmetry with the glossary /
      // character-voice / style-guide root copies): a translator or downstream tool starting the next
      // volume reads ONE file instead of having to find the newest volume folder. Skipped for
      // --volume runs (a single volume's snapshot would not be the series-current state).
      await publishLatestToSeriesRoot({
        seriesDir,
        folders,
        fileName: SHARED_WIKI_FILE,
        envKey: "SHARED_WIKI_OUTPUT_FILE",
        label: "shared wiki",
        volumeArg,
        dryRun,
      });
    },
  });

  return failedVolumes;
}


/**
 * One volume of the wiki run: resolve its source, its base, and its processing mode; then preview
 * it, skip it, or build it — and in every case refresh the deterministic translation handoff.
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
 *   tally: { limitReached: number },
 * }} run - What every volume of this run shares.
 * @returns {Promise<void>}
 */
async function processWikiVolume({ folderName, index }, run) {
  const { folders, volumeByFolder, runSettings, prompts, dryRun, force, chunked, cascade, tally } = run;
  const volume = volumeByFolder.get(folderName);
  const volumeDir = path.join(seriesDir, folderName);
  const values = {
    INSTALLMENT_NUMBER: volume.installmentNumber,
    SOURCE_NAME: runSettings.seriesName,
    SOURCE_LANGUAGE: runSettings.sourceLanguage,
  };

  // Resolve the source into a bundle (utils/source.js): plain-text sources pass through as-is (the
  // default whole-installment path); .epub sources are normalized once (cached) into per-chapter +
  // whole Markdown files.
  const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
  if (!(await fileExists(bundle.originalPath))) {
    throw new Error(`Required file not found: ${bundle.originalPath}`);
  }

  const { ctx, proceed } = await buildVolumeContext({
    folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, volume, dryRun, chunked,
  });
  if (!proceed) return;

  printVolumePlan(ctx);

  // The canonical glossary snapshot (written by the glossary task into the same volume folder) is
  // offered to the wiki agents as a read-only reference so the shared wiki's "Glossary" section uses
  // canonical renderings instead of model memory. Absent before the first run.
  const glossarySnapshotFile = path.join(volumeDir, "glossary.md");
  ctx.glossaryFile = (await fileExists(glossarySnapshotFile)) ? glossarySnapshotFile : null;

  if (dryRun) {
    await dumpVolumePreview(ctx);
    return;
  }

  // The idempotency check: the persisted rolling-window state recomputes the acceptance decision
  // deterministically (no AI call). A skipped volume still gets its deterministic handoff refreshed.
  if (await volumeAlreadyAccepted({
    installmentNumber: values.INSTALLMENT_NUMBER,
    outputFiles: [ctx.wikiOutputFile, ctx.sharedWikiOutputFile],
    validationOutputFile: ctx.validationOutputFile,
    bundle,
    force,
    regeneratedAny: cascade.regeneratedAny,
    artifactLabel: "wiki",
  })) {
    console.log("The current volume has already been processed by a previous run.");
    await writeHandoff(ctx, runSettings, volume);
    return;
  }

  await runVolumeWithModeFallback({
    label: `Volume ${volume.installmentNumber}`,
    ctx,
    volumeDir,
    run: () => runVolumeAgent(ctx),
    attemptFiles: [
      WIKI_FILE,
      SHARED_WIKI_FILE,
      ctx.validationOutputFile,
      ctx.validationOutputFile.replace(".md", "-rolling-state.json"),
    ],
    // The chunked path's per-chapter section files, plus the stale classic names the workflow
    // already cleans up.
    attemptGlob: /^wiki-.+\.md$/,
  });
  // This volume's wiki was (re)written, so every later volume's wiki — which was built on it — is
  // now stale and must be rebuilt too.
  cascade.regeneratedAny = true;

  // Deterministic per-volume handoff for the translation stage: chapters.json +
  // translation-brief.md (no AI call; best-effort — a failure here must not fail an already-accepted
  // wiki).
  await writeHandoff(ctx, runSettings, volume);

  if (ctx.limitReached) tally.limitReached += 1;
}


/**
 * Assemble the volume context: the previous volume's wiki + shared wiki (the base this one extends),
 * the four transformed prompts, and the processing mode.
 *
 * The previous volume is resolved FIRST: the validator prompt names the prior volume's real
 * installment number, so that value must exist before the prompt is built. (Observed: these values
 * were declared further down the same block and read here — a use-before-declaration ReferenceError
 * that failed EVERY volume, which the volume-level error handling then logged as a per-volume
 * failure.)
 *
 * @returns {Promise<{ ctx: WikiVolumeCtx, proceed: boolean }>} `proceed` false when the run policy
 *   said to skip this volume (a missing base).
 */
async function buildVolumeContext({ folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, volume, dryRun, chunked }) {
  const { isFirst, previousFolderName, previousInstallmentNumber } = locatePreviousVolume({ folders, index, volumeByFolder });

  // The wiki builds cumulatively on the previous volume's wiki + shared wiki, exactly like the three
  // other cumulative tasks — so a missing previous volume is the same decision (ON_MISSING_PREVIOUS).
  // Both files must exist AND hold real content: a crashed run leaves scaffold stubs, which are not a
  // usable base.
  const previous = await requirePreviousArtifacts({
    seriesDir,
    previousFolderName,
    fileNames: [WIKI_FILE, SHARED_WIKI_FILE],
    label: "wiki",
    installmentNumber: values.INSTALLMENT_NUMBER,
    dryRun,
    isUsable: hasRealOutput,
  });
  if (previous.skipVolume) return { ctx: null, proceed: false };

  const previousVolumeDir = previousFolderName ? path.join(seriesDir, previousFolderName) : null;

  const ctx = {
    values,
    folderName,
    volumeDir,
    sourceFile: bundle.wholePath,
    bundle,
    isFirst,
    previousFolderName,
    previousWikiOutputFile: previousVolumeDir ? path.join(previousVolumeDir, WIKI_FILE) : null,
    previousSharedWikiOutputFile: previousVolumeDir ? path.join(previousVolumeDir, SHARED_WIKI_FILE) : null,
    wikiOutputFile: path.join(volumeDir, WIKI_FILE),
    sharedWikiOutputFile: path.join(volumeDir, SHARED_WIKI_FILE),
    validationOutputFile: path.join(volumeDir, `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`),
    userPrompt: transformUserPrompt(prompts.template, values),
    // The prior volume's real installment number (from the manifest), or a clear marker when this is
    // the first volume — the prose tells the validator which volumes it cannot see.
    validatorUserPrompt: transformUserPrompt(prompts.validatorTemplate, {
      ...values,
      PREVIOUS_INSTALLMENT_NUMBER: previousInstallmentNumber || "(none — this is the first volume)",
    }),
    feedbackUserPrompt: transformUserPrompt(prompts.feedbackTemplate, values),
    acceptanceUserPrompt: transformUserPrompt(prompts.acceptanceTemplate, {
      INSTALLMENT_NUMBER: values.INSTALLMENT_NUMBER,
      SOURCE_NAME: values.SOURCE_NAME,
    }),
    systemPrompt: prompts.systemPrompt,
    validatorSystemPrompt: prompts.validatorSystemPrompt,
    feedbackSystemPrompt: prompts.feedbackSystemPrompt,
    acceptanceSystemPrompt: prompts.acceptanceSystemPrompt,
  };

  // Whole-installment vs chapter-by-chapter, decided against THIS stage's model window and the
  // reference it will actually inject (the previous volume's wiki + the living shared wiki — decided
  // per volume because they grow every volume). See planProcessingMode in utils/source.js.
  const mode = await decideProcessingMode({
    bundle,
    label: `Volume ${volume.installmentNumber}`,
    previousArtifactFiles: [ctx.previousWikiOutputFile, ctx.previousSharedWikiOutputFile].filter(Boolean),
    forceChunked: chunked,
    dryRun,
  });
  ctx.chunked = mode.chunked;

  return { ctx, proceed: true };
}


/**
 * Print what this volume is about to be built from, so a run log can be read without opening the
 * files it names.
 * @param {WikiVolumeCtx} ctx
 */
function printVolumePlan(ctx) {
  const { values } = ctx;
  console.log(`Installment number:      ${values.INSTALLMENT_NUMBER}`);
  console.log(`Source name:             ${values.SOURCE_NAME}`);
  console.log(`Source language:         ${values.SOURCE_LANGUAGE}`);
  console.log(`Source file:             ${ctx.sourceFile}`);
  console.log(`Wiki Output file:        ${ctx.wikiOutputFile}`);
  console.log(`Shared Wiki Output file: ${ctx.sharedWikiOutputFile}`);
  console.log(`Validation Output file:  ${ctx.validationOutputFile}`);
}


/**
 * Refresh the deterministic translation handoff for this volume (no AI call).
 * @param {WikiVolumeCtx} ctx
 * @param {{seriesName: string, sourceLanguage: string, targetLanguage: string}} runSettings
 * @param {Object} volume
 */
function writeHandoff(ctx, runSettings, volume) {
  return writeVolumeHandoff({
    seriesDir,
    seriesName: runSettings.seriesName,
    volume,
    volumeDir: ctx.volumeDir,
    bundle: ctx.bundle,
    installmentNumber: ctx.values.INSTALLMENT_NUMBER,
    sourceLanguage: runSettings.sourceLanguage,
    targetLanguage: runSettings.targetLanguage,
  });
}


/**
 * `--dry-run`: write the exact prompts a live run would send (agent-mode turns + the tool-less
 * acceptance check), and make no AI call.
 * @param {WikiVolumeCtx} ctx
 * @returns {Promise<void>}
 */
async function dumpVolumePreview(ctx) {
  const { values } = ctx;
  const sections = [
    { title: "AGENT — author system prompt", prompt: buildWikiAuthorSystemPrompt(ctx) },
    { title: "AGENT — author turn (generation)", prompt: buildWikiAuthorTurnPrompt(ctx) },
    { title: "AGENT — validator system prompt", prompt: buildWikiValidatorSystemPrompt(ctx) },
    { title: "AGENT — validator turn", prompt: buildWikiValidatorTurnPrompt(ctx) },
    { title: "AGENT — feedback turn (applied by the author session)", prompt: buildWikiFeedbackTurnPrompt(ctx) },
    { title: "One-shot — acceptance user prompt (always tool-less)", prompt: ctx.acceptanceUserPrompt },
  ];
  // Chunked (fallback) volumes: dump the chapter-scoped variants too.
  if (ctx.chunked && ctx.bundle.segments.length > 1) {
    const seg = ctx.bundle.segments[0];
    sections.push(
      { title: "CHUNKED — per-chapter section author turn (first chapter)", prompt: buildWikiSectionTurnPrompt(ctx, seg, 0) },
      { title: "CHUNKED — wiki merge turn", prompt: buildWikiMergeTurnPrompt(ctx) },
      { title: "CHUNKED — segment validator turn (first chapter)", prompt: buildWikiSegmentValidatorPrompt(ctx, seg, 0) },
      { title: "CHUNKED — findings merge turn", prompt: buildWikiFindingsMergePrompt(ctx) },
      { title: "CHUNKED — segment feedback turn (first chapter)", prompt: buildWikiSegmentFeedbackPrompt(ctx, seg, 0) }
    );
  }
  const dumpFile = await writePromptDump("jump-in-wiki", values.INSTALLMENT_NUMBER, "agent", sections);
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: no AI calls. The exact prompts ` +
      `(agent-mode turns + tool-less acceptance) are written to ${dumpFile}`
  );
}


/**
 * The file names that may legitimately live in a volume folder and must
 * never be mistaken for (or renamed into) the wiki outputs.
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
 * @returns {Set<string>} The protected file names.
 */
function knownVolumeFileNames(ctx) {
  return new Set([
    `${ctx.folderName}.md`,
    "glossary.md",
    "glossary-research.md",
    "glossary-validation.md",
    `jump-in-wiki-validation-${ctx.values.INSTALLMENT_NUMBER}.md`,
  ]);
}

// The "model emitted tool-call syntax as plain text" guard
// (emittedToolCallAsText + assertRealToolCalls) is shared by every
// file-writing task — see utils/agents.js (AGENTS.md gotcha 18).


module.exports = {
  jumpInWiki,
  knownVolumeFileNames,
};

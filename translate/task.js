/**
 * The task entry: the entry gate (a FAIL audit or a volume with no glossary stops the stage before
 * a token is spent), the endpoint sanity check, the run estimate, the volume loop, and the
 * completeness check that runs at the END so one untranslatable chapter no longer stops the rest of
 * the series.
 *
 * The shape of the run — flags, plan of record, reading order, `--volume`, the skip policy and the
 * failure summary — is the shared series-run layer (utils/series-run.js). What is specific to this
 * stage is what happens inside one volume, the two gates around it, and the report at the end.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { readRunArgs, openSeriesRun, runVolumeSeries } = require("../utils/series-run");
const { validateRequiredEnv, structuralError } = require("../configs/shared");
const { resolveSourceBundle } = require("../utils/source");
const { writeTranslationReport, checkTranslationPreconditions } = require("../utils/translation-report");
const {
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  readFileOrEmpty,
  previousVolumeTail,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  translateChunkCap,
} = require("../utils/translate");

const { continuityChars, seriesDir, translateSampling, translateTemplateFile, translateThinkingMode } = require("./config");
const { processTranslateVolume } = require("./volume");

/**
 * Translate one volume: resolve its source, decide which references the translator sees, and hand
 * the volume to the chapter loop.
 *
 * @param {Object} deps
 * @param {string} deps.folderName - The volume's folder, as the plan of record names it.
 * @param {Object} deps.volume - The manifest entry for this volume.
 * @param {{manifest: Object, runSettings: {seriesName: string, sourceLanguage: string, targetLanguage: string}}} deps.series
 * @param {{template: string, endpoint: Object, sampling: Object, thinkingMode: Object, dryRun: boolean, force: boolean}} deps.stage
 * @param {{translated: number, skipped: number, failed: number}} deps.tally - Updated in place.
 * @param {Array<{installmentNumber: string, folder: string, missing: string[]}>} deps.incomplete
 * @param {Array<{installmentNumber: string, folder: string, chapters: Object[]}>} deps.emptyInSource
 * @returns {Promise<void>}
 */
async function translateOneVolume(
  { folderName, volume, series, stage, tally, incomplete, emptyInSource }
) {
  const { manifest, runSettings } = series;
  const { template, endpoint, sampling, thinkingMode, dryRun, force } = stage;
  const volumeDir = path.join(seriesDir, folderName);

  const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
  // The prompt budget is measured against THIS role's model, so the estimate is calibrated here
  // (once per run — the lookup is cached per endpoint).
  await calibrateStageTokens({ endpoint, bundle, label: "translate stage", dryRun });
  // The handoff's chapter list and the extracted one must describe the same book (see
  // checkChapterListConsistency). A disagreement is reported, not fatal: the extracted list is the
  // one this stage uses.
  await checkChapterListConsistency(volumeDir, bundle);
  // The volume's own text decides WHICH sections of the cumulative references get injected (see
  // loadVolumeReferences): a 17-volume series must show the translator the state and cast that
  // matter to THIS book.
  const volumeSourceText = await readFileOrEmpty(bundle.wholePath || path.join(volumeDir, bundle.segments[0].file));
  const refs = await loadVolumeReferences(volumeDir, volumeSourceText);

  const result = await processTranslateVolume({
    volume,
    volumeDir,
    bundle,
    refs,
    template,
    endpoint,
    sampling,
    thinkingMode,
    dryRun,
    force,
    targetLanguage: runSettings.targetLanguage,
    sourceLanguage: runSettings.sourceLanguage,
    // A volume's first chapter continues from the end of the PREVIOUS volume's published translation
    // (in the manifest's reading order — so a `--volume 07` run still gets volume 06's ending, and a
    // `--volume` run that starts mid-series does not translate the first chapter as if the story
    // began there).
    incomingTail: await previousVolumeTail(seriesDir, manifest, folderName, continuityChars),
    // The volumes BEFORE this one, in reading order — the source of the measured output ratio (their
    // sources and drafts are on disk).
    previousVolumeDirs: manifest.volumes
      .slice(0, manifest.volumes.findIndex((v) => v.folder === folderName))
      .map((v) => path.join(seriesDir, v.folder)),
  });

  tally.translated += result.translated;
  tally.skipped += result.skipped;
  tally.failed += result.failed;

  // A chapter with no text is only a pipeline failure when the SOURCE had text in it. A chapter that
  // is empty IN the source is a hole in the book, which the pipeline reports but cannot fill — so it
  // is listed separately and does not fail the run (see the report).
  const emptyIds = new Set(result.emptySourceChapters.map((c) => c.id));
  const realMissing = result.missing.filter((m) => !emptyIds.has(m.id));
  if (realMissing.length > 0) {
    incomplete.push({
      installmentNumber: volume.installmentNumber,
      folder: folderName,
      missing: realMissing.map((m) => m.id),
    });
  }
  if (result.emptySourceChapters.length > 0) {
    emptyInSource.push({
      installmentNumber: volume.installmentNumber,
      folder: folderName,
      chapters: result.emptySourceChapters,
    });
  }

  console.log(
    `[translate] Volume ${volume.installmentNumber}: ${result.translated} translated, ` +
      `${result.skipped} skipped` +
      (result.failed > 0 ? `, ${result.failed} FAILED` : "") +
      (result.emptySourceChapters.length > 0
        ? `, ${result.emptySourceChapters.length} EMPTY IN SOURCE`
        : "") +
      "."
  );
}

/**
 * Run the translate task (all volumes, or --volume NN).
 *
 * @returns {Promise<void>}
 */
async function translate() {
  const { dryRun, force, volumeArg } = readRunArgs();

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  validateRequiredEnv({ dryRun });

  const endpoint = roleEndpoint("TRANSLATE");
  const sampling = translateSampling();
  const thinkingMode = translateThinkingMode();

  // Control-plane check BEFORE any call (skipped in dry-run — offline).
  if (!dryRun) {
    await harness.assertModelServing({ ...endpoint, label: "translate stage" });
  }

  const template = await fs.readFile(translateTemplateFile, "utf-8");

  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const series = await openSeriesRun({ seriesDir, dryRun, volumeArg });
  const { manifest, folders, volumes, volumeByFolder } = series;
  const volumeEntries = volumes.map((folder) => volumeByFolder.get(folder)).filter(Boolean);

  // The entry gate: the consistency sign-off and the glossary. Both are things no later stage can
  // repair, so they stop the run instead of scrolling past as a warning in an overnight one.
  // Explicit overrides keep the un-monitored path usable (see utils/translation-report.js).
  await checkTranslationPreconditions({
    seriesDir,
    volumes: volumeEntries,
    allowFail: process.argv.includes("--allow-fail"),
    allowNoGlossary: process.argv.includes("--allow-no-glossary"),
    dryRun,
  });

  console.log(
    `[translate] ${folders.length} volume folder(s); endpoint ${describeEndpoint(endpoint)}; ` +
      `thinking=${thinkingMode}; chunk=${translateChunkCap() ? `${translateChunkCap()} chars (TRANSLATE_CHUNK_CHARS)` : "planned in tokens per chapter"}; continuity=${continuityChars} chars.`
  );
  // What this stage is about to cost, printed before it starts (see logRunEstimate): chapters, model
  // calls, and — when a previous run exists — the generation speed that run actually achieved.
  await logRunEstimate({
    stage: "translate",
    volumes: volumes.length,
    chapters: (await countStageChapters({ seriesDir, volumes: volumeEntries })).chapters,
    callsPerChapter: 1,
    endpoint,
    extra: "chapters are translated serially (each one continues from the previous)",
  });

  const tally = { translated: 0, skipped: 0, failed: 0 };
  /** Volumes whose published text is missing chapters the source had. */
  const incompleteVolumes = [];
  /** Chapters that are empty in the SOURCE (reported, never structural). */
  const emptyInSource = [];

  const stage = { template, endpoint, sampling, thinkingMode, dryRun, force };
  await runVolumeSeries("translate", {
    volumes,
    folders,
    volumeByFolder,
    processVolume: (folderName) =>
      translateOneVolume({
        folderName,
        volume: volumeByFolder.get(folderName),
        series,
        stage,
        tally,
        incomplete: incompleteVolumes,
        emptyInSource,
      }),
    // Completeness gate — at the END of the volume walk, not from inside a volume's merge. A partial
    // volume is a failure, not a deliverable, and it is a STRUCTURAL one (no ON_VOLUME_ERROR=skip
    // walks past it). Deciding it here means every volume was attempted first: one untranslatable
    // chapter in volume 2 no longer prevents volumes 3–17 from being translated.
    afterVolumes: () => {
      if (incompleteVolumes.length === 0) return;
      throw structuralError(
        `${incompleteVolumes.length} volume(s) are INCOMPLETE — chapters with no text: ` +
          `${incompleteVolumes.map((v) => `${v.installmentNumber} (${v.missing.join(", ")})`).join("; ")}. ` +
          `Re-run the translate task to retry them (idempotent skips keep it cheap), then translate-qa ` +
          `to repair the drafts that failed the deterministic QA.`
      );
    },
  });

  console.log(
    `[translate] Done: ${tally.translated} chapter(s) translated, ${tally.skipped} skipped` +
      (tally.failed > 0 ? `, ${tally.failed} chapter(s) FAILED` : "") +
      (emptyInSource.length > 0
        ? `, ${emptyInSource.reduce((n, v) => n + v.chapters.length, 0)} empty in source`
        : "") +
      "."
  );

  if (tally.failed > 0) {
    throw new Error(
      `${tally.failed} chapter(s) failed (model call or deterministic QA). A deterministic-QA failure keeps ` +
        `its draft marked for correction and the translate-qa loop repairs it; a chapter with no draft at ` +
        `all is retried by re-running the translate task.`
    );
  }
  await writeTranslationReport({ seriesDir, manifest, volumes });
}

module.exports = {
  translate,
};

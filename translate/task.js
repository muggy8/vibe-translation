/**
 * The task entry: the entry gate (a FAIL audit or a volume with no glossary stops the stage before a token is spent), the endpoint sanity check, the run estimate, the volume loop, and the completeness check that runs at the END so one untranslatable chapter no longer stops the rest of the series.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { getTranslationTarget } = require("../get-translation-target");
const { filterVolumesByInstallment } = require("../utils/manifest");
const { ON_VOLUME_ERROR, validateRequiredEnv, resolveRunSettings, isStructuralError, structuralError, volumeFailureError } = require("../configs/shared");
const { resolveSourceBundle } = require("../utils/source");
const { writeTranslationReport, checkTranslationPreconditions } = require("../utils/translation-report");
const {
  sha256,
  splitChapter,
  buildTranslationTaskLines,
  buildTranslationPrompt,
  checkTranslationQa,
  mergeVolumeTranslation,
  resolvePublishedChapterTexts,
  findMissingSegments,
  stripMarkdownFence,
  tailOf,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  glossaryBlockMaxChars,
  stripContinuityOverlap,
  chapterArtifactNames,
  readFileOrEmpty,
  previousVolumeTail,
  buildBudgetedTaskLines,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  EMPTY_SOURCE_CHARS,
  loadVerificationSidecar,
  verdictCoversCurrentDraft,
  chapterContextHash,
  unverifiedMarker,
  recordBestDraft,
  STATE_FILE,
  QA_REPORT_FILE,
  MERGED_FILE,
  VERIFICATION_FILE,
  buildPolishGuardFindings,
  planChapterSplit,
  translateChunkCap,
  outputRatioFor,
  thinkingOutputFactor,
  measureOutputRatio,
  estimateTokens,
} = require("../utils/translate");

const { continuityChars, seriesDir, translateSampling, translateTemplateFile, translateThinkingMode } = require("./config");
const { processTranslateVolume } = require("./volume");

/**
 * Run the translate task (all volumes, or --volume NN).
 *
 * @returns {Promise<void>}
 */
async function translate() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

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
  const manifest = await getTranslationTarget({ dryRun });
  // The target language the translation prompt is written for: .env override >
  // the intake manifest's decision > the default.
  const runSettings = resolveRunSettings(manifest);
  const sorted = manifest.volumes.map((v) => v.folder);
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));
  if (sorted.length === 0) {
    throw new Error(`No volume folders found in ${seriesDir}.`);
  }

  const volumeArg =
    (process.argv.find((a) => a.startsWith("--volume=")) || "").replace("--volume=", "") ||
    (process.argv.includes("--volume")
      ? process.argv[process.argv.indexOf("--volume") + 1]
      : null);
  let volumes = sorted;
  if (volumeArg) {
    // Resolved through the manifest's installment numbers, not by parsing folder
    // names — the intake agent chooses the folder names.
    volumes = filterVolumesByInstallment(manifest, volumeArg);
    if (volumes.length === 0) {
      throw new Error(
        `No volume matching --volume ${volumeArg} (manifest volumes: ` +
          `${manifest.volumes.map((v) => `${v.installmentNumber} = ${v.folder}`).join(", ")}).`
      );
    }
    console.log(`--volume: processing only ${volumes.join(", ")}`);
  }

  // The entry gate: the consistency sign-off and the glossary. Both are things
  // no later stage can repair, so they stop the run instead of scrolling past
  // as a warning in an overnight one. Explicit overrides keep the un-monitored
  // path usable (see utils/translation-report.js).
  await checkTranslationPreconditions({
    seriesDir,
    volumes: volumes.map((folder) => volumeByFolder.get(folder)).filter(Boolean),
    allowFail: process.argv.includes("--allow-fail"),
    allowNoGlossary: process.argv.includes("--allow-no-glossary"),
    dryRun,
  });

  console.log(
    `[translate] ${sorted.length} volume folder(s); endpoint ${describeEndpoint(endpoint)}; ` +
      `thinking=${thinkingMode}; chunk=${translateChunkCap() ? `${translateChunkCap()} chars (TRANSLATE_CHUNK_CHARS)` : "planned in tokens per chapter"}; continuity=${continuityChars} chars.`
  );
  // What this stage is about to cost, printed before it starts (see
  // logRunEstimate): chapters, model calls, and — when a previous run exists —
  // the generation speed that run actually achieved.
  await logRunEstimate({
    stage: "translate",
    volumes: volumes.length,
    chapters: (await countStageChapters({ seriesDir, volumes: volumes.map((f) => volumeByFolder.get(f)).filter(Boolean) })).chapters,
    callsPerChapter: 1,
    endpoint,
    extra: "chapters are translated serially (each one continues from the previous)",
  });

  const failedVolumes = [];
  const incompleteVolumes = [];
  /** Chapters that are empty in the SOURCE (reported, never structural). */
  const emptyInSource = [];
  let totalTranslated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
      // The prompt budget is measured against THIS role's model, so the estimate
      // is calibrated here (once per run — the lookup is cached per endpoint).
      await calibrateStageTokens({ endpoint, bundle, label: "translate stage", dryRun });
      // The handoff's chapter list and the extracted one must describe the same
      // book (see checkChapterListConsistency). A disagreement is reported, not
      // fatal: the extracted list is the one this stage uses.
      await checkChapterListConsistency(volumeDir, bundle);
      // The volume's own text decides WHICH sections of the cumulative
      // references get injected (see loadVolumeReferences): a 17-volume series
      // must show the translator the state and cast that matter to THIS book.
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
        // A volume's first chapter continues from the end of the PREVIOUS
        // volume's published translation (in the manifest's reading order — so a
        // `--volume 07` run still gets volume 06's ending, and a `--volume` run
        // that starts mid-series does not translate the first chapter as if the
        // story began there).
        incomingTail: await previousVolumeTail(seriesDir, manifest, folderName, continuityChars),
        // The volumes BEFORE this one, in reading order — the source of the
        // measured output ratio (their sources and drafts are on disk).
        previousVolumeDirs: manifest.volumes
          .slice(0, manifest.volumes.findIndex((v) => v.folder === folderName))
          .map((v) => path.join(seriesDir, v.folder)),
      });
      totalTranslated += result.translated;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
      // A chapter with no text is only a pipeline failure when the SOURCE had text
      // in it. A chapter that is empty IN the source is a hole in the book, which
      // the pipeline reports but cannot fill — so it is listed separately and does
      // not fail the run (see the report).
      const emptyIds = new Set(result.emptySourceChapters.map((c) => c.id));
      const realMissing = result.missing.filter((m) => !emptyIds.has(m.id));
      if (realMissing.length > 0) {
        incompleteVolumes.push({
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
    } catch (err) {
      // A STRUCTURAL failure (a source file that vanished, an archive that will not
      // open, a volume whose chapters are incomplete) is never skippable: ON_VOLUME_ERROR
      //=skip exists for flaky model calls, not for a broken book.
      if (ON_VOLUME_ERROR === "skip" && !isStructuralError(err)) {
        console.error(
          `[skip] Volume ${volume.installmentNumber} (${folderName}) failed: ${err.message}`
        );
        failedVolumes.push(volume.installmentNumber);
        continue;
      }
      throw err;
    }
  }

  console.log(
    `[translate] Done: ${totalTranslated} chapter(s) translated, ${totalSkipped} skipped` +
      (totalFailed > 0 ? `, ${totalFailed} chapter(s) FAILED` : "") +
      (failedVolumes.length > 0 ? `, ${failedVolumes.length} volume(s) FAILED: ${failedVolumes.join(", ")}` : "") +
      "."
  );
  // Completeness gate — at the END of the task, not from inside a volume's
  // merge. A partial volume is a failure, not a deliverable, and it is a
  // STRUCTURAL one (no ON_VOLUME_ERROR=skip walks past it). Deciding it here
  // means every volume was attempted first: one untranslatable chapter in
  // volume 2 no longer prevents volumes 3–17 from being translated.
  if (incompleteVolumes.length > 0) {
    throw structuralError(
      `${incompleteVolumes.length} volume(s) are INCOMPLETE — chapters with no text: ` +
        `${incompleteVolumes.map((v) => `${v.installmentNumber} (${v.missing.join(", ")})`).join("; ")}. ` +
        `Re-run the translate task to retry them (idempotent skips keep it cheap), then translate-qa ` +
        `to repair the drafts that failed the deterministic QA.`
    );
  }
  const volumeError = volumeFailureError("translate", failedVolumes, volumes.length);
  if (volumeError) {
    throw new Error(`${volumeError.message} (ON_VOLUME_ERROR=skip — they can be picked up on a re-run).`);
  }
  if (totalFailed > 0) {
    throw new Error(
      `${totalFailed} chapter(s) failed (model call or deterministic QA). A deterministic-QA failure keeps ` +
        `its draft marked for correction and the translate-qa loop repairs it; a chapter with no draft at ` +
        `all is retried by re-running the translate task.`
    );
  }
  await writeTranslationReport({ seriesDir, manifest, volumes });
}


module.exports = {
  translate,
};

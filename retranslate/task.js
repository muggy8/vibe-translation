/**
 * The task entry: the endpoint sanity check, the run estimate, the volume loop, and the failure
 * summary the translate-qa loop reads.
 *
 * Part of the retranslate.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");
const harness = require("../harness");
const { ON_VOLUME_ERROR, validateRequiredEnv, resolveRunSettings, isStructuralError, volumeFailureError } = require("../configs/shared");
const { resolveSourceBundle } = require("../utils/source");
const { readRunArgs, openSeriesRun } = require("../utils/series-run");
const {
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  readFileOrEmpty,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  previousVolumeTail,
} = require("../utils/translate");
const { translateSampling, translateThinkingMode } = require("../translate");

const { seriesDir, translateTemplateFile, verifyEnabled, retranslateConcurrency, continuityChars } = require("./config");
const { processRetranslateVolume } = require("./volume");

/**
 * Run the retranslate task (all volumes, or --volume NN).
 *
 * Returns the aggregated run summary — the translate-qa loop reads `retranslated` for its stall
 * guard. (A volume that fails the run under ON_VOLUME_ERROR=skip still throws, as before.)
 *
 * @returns {Promise<{retranslated: number, skipped: number, none: number, deferred: number, crossChapter: number}>}
 */
async function retranslate() {
  const { dryRun, force, volumeArg } = readRunArgs();

  if (!verifyEnabled) {
    console.log(
      "[retranslate] VERIFY_TRANSLATE_ENABLED=false — the verification chain is disabled. Nothing to do."
    );
    return;
  }
  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  validateRequiredEnv({ dryRun });

  const endpoint = roleEndpoint("TRANSLATE");
  const sampling = translateSampling();
  const thinkingMode = translateThinkingMode();
  // Control-plane check BEFORE any call (skipped in dry-run — offline).
  if (!dryRun) {
    await harness.assertModelServing({ ...endpoint, label: "retranslate stage" });
  }

  const template = await fs.readFile(translateTemplateFile, "utf-8");
  const { manifest, runSettings, folders, volumes, volumeByFolder } = await openSeriesRun({ seriesDir, dryRun, volumeArg });

  console.log(
    `[retranslate] ${folders.length} volume folder(s); endpoint ${describeEndpoint(endpoint)}; ` +
      `thinking=${thinkingMode}; concurrency=${retranslateConcurrency}.`
  );
  await logRunEstimate({
    stage: "retranslate",
    volumes: volumes.length,
    chapters: (await countStageChapters({ seriesDir, volumes: volumes.map((f) => volumeByFolder.get(f)).filter(Boolean) })).chapters,
    callsPerChapter: 1,
    endpoint,
    extra: "only the chapters that FAILED verification are retranslated, so the real call count is lower",
  });

  const totals = { retranslated: 0, skipped: 0, none: 0, deferred: 0, crossChapter: 0 };
  /** Installment numbers of the volumes ON_VOLUME_ERROR=skip walked past. */
  const failedVolumes = [];

  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const result = await retranslateOneVolume({ seriesDir, manifest, runSettings, template, endpoint, sampling, thinkingMode, dryRun, force, folderName, volume, volumeDir });
      for (const key of Object.keys(totals)) totals[key] += result[key] || 0;
      console.log(
        `[retranslate] Volume ${volume.installmentNumber}: ${result.retranslated} retranslated, ` +
          `${result.skipped} skipped, ${result.none} not applicable` +
          (result.deferred > 0 ? `, ${result.deferred} deferred (cosmetic findings only)` : "") +
          "."
      );
    } catch (err) {
      // A STRUCTURAL failure (a source file that vanished, an archive that will not open, a volume
      // whose chapters are incomplete) is never skippable: ON_VOLUME_ERROR=skip exists for flaky model
      // calls, not for a broken book.
      if (ON_VOLUME_ERROR === "skip" && !isStructuralError(err)) {
        console.error(`[skip] Volume ${volume.installmentNumber} (${folderName}) failed: ${err.message}`);
        failedVolumes.push(volume.installmentNumber);
        continue;
      }
      throw err;
    }
  }

  console.log(
    `[retranslate] Done: ${totals.retranslated} chapter(s) retranslated, ${totals.skipped} skipped` +
      (totals.deferred > 0 ? `, ${totals.deferred} deferred (cosmetic findings only — see the verification reports)` : "") +
      (totals.crossChapter > 0 ? `, ${totals.crossChapter} repaired for cross-chapter contradictions (see volume-consistency.md)` : "") +
      `. Re-run verify-translate to re-score the retranslated chapters.`
  );
  const volumeError = volumeFailureError("retranslate", failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
  return totals;
}


/**
 * Prepare one volume and run the correction pass over it.
 *
 * @returns {Promise<Object>} The volume's own counts.
 */
async function retranslateOneVolume(input) {
  const { seriesDir, manifest, runSettings, template, endpoint, sampling, thinkingMode, dryRun, force, folderName, volume, volumeDir } = input;
  const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
  // The retranslator runs on the TRANSLATE_* role, which is a different model from the verifier that
  // just graded it — re-point the estimate before the prompt budget is computed (cached per endpoint).
  await calibrateStageTokens({ endpoint, bundle, label: "retranslate stage", dryRun });
  // The handoff's chapter list and the extracted one must describe the same book. A disagreement is
  // reported, not fatal: the extracted list is the one this stage uses.
  await checkChapterListConsistency(volumeDir, bundle);
  // The volume's own text decides WHICH sections of the cumulative references get injected: a
  // 17-volume series must show the translator the state and cast that matter to THIS book.
  const volumeSourceText = await readFileOrEmpty(bundle.wholePath || path.join(volumeDir, bundle.segments[0].file));
  const refs = await loadVolumeReferences(volumeDir, volumeSourceText);
  return processRetranslateVolume({
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
    // The first chapter of a volume continues from the previous volume's published ending (the same
    // cue the translate stage uses).
    incomingTail: await previousVolumeTail(seriesDir, manifest, folderName, continuityChars),
    // The volumes before this one — where the measured output ratio comes from.
    previousVolumeDirs: manifest.volumes
      .slice(0, manifest.volumes.findIndex((v) => v.folder === folderName))
      .map((v) => path.join(seriesDir, v.folder)),
  });
}

module.exports = { retranslate };

/**
 * The task entry: the endpoint sanity check, the run estimate, the per-volume loop, the disputes queue, and the failure summary.
 *
 * Part of the verify-translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { getTranslationTarget } = require("../get-translation-target");
const { filterVolumesByInstallment } = require("../utils/manifest");
const { ON_VOLUME_ERROR, PASSING_SCORE, ACCEPTANCE_SCORE_TOLERANCE, validateRequiredEnv, isStructuralError, volumeFailureError, readBoolEnv, resolveRunSettings } = require("../configs/shared");
const { resolveSourceBundle } = require("../utils/source");
const {
  parseGlossaryDisputes,
  collectVolumeDisputes,
  mergeDisputes,
  loadGlossaryDisputes,
  saveGlossaryDisputes,
  DISPUTES_FILE,
  DISPUTES_REPORT,
} = require("../utils/disputes");
const {
  sha256,
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  glossaryBlockMaxChars,
  runWithConcurrency,
  stageConcurrency,
  judgeTemperature,
  stageThinking,
  chapterArtifactNames,
  loadVerificationSidecar,
  readFileOrEmpty,
  saveVerificationSidecar,
  findingsOf,
  glossaryBlock,
  medianScore,
  recordBestDraft,
  verdictCoversCurrentDraft,
  estimateTokens,
  fitPromptBudget,
  describeDroppedBlocks,
  findRenderingVariants,
  renderVariantFindings,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  previousVolumeTail,
  tailOf,
  resolvePublishedChapterTexts,
  planConsistencyWindows,
  parseVolumeFindings,
  buildVolumeConsistencyMarkdown,
  loadVolumeConsistency,
  saveVolumeConsistency,
  VOLUME_CONSISTENCY_FILE,
  VOLUME_CONSISTENCY_REPORT,
  loadTranslationState,
  STATE_FILE,
  MERGED_FILE,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
} = require("../utils/translate");
const { withHooks } = require("../utils/hooks");

const { CONSISTENCY_TAIL_CHARS, consistencySystemPromptFile, consistencyTemplateFile, passingScore, seriesDir, tiebreakBand, tiebreakEnabled, verifyConcurrency, verifyEnabled, verifySamples, verifySystemPromptFile, verifyTemplateFile, verifyThinking, volumeConsistencyEnabled } = require("./config");
const { runVolumeConsistencyPass } = require("./consistency");
const { commitVerificationVolume, processVerifyVolume, runAuditTiebreak } = require("./volume");
const { runVerificationSamples } = require("./grade");

/**
 * Run the verify-translate task (all volumes, or --volume NN).
 *
 * Returns the aggregated run summary — the translate-qa loop reads
 * `failed` to decide whether the validator is happy. (A volume that fails
 * the run under ON_VOLUME_ERROR=skip still throws, as before.)
 *
 * @returns {Promise<{verified: number, passed: number, failed: number, skipped: number, noDraft: number}>}
 */
async function verifyTranslate() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  if (!verifyEnabled) {
    console.log(
      "[verify-translate] VERIFY_TRANSLATE_ENABLED=false — verification (and the retranslate pass) are disabled. Nothing to do."
    );
    return;
  }
  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  validateRequiredEnv({ dryRun });

  const endpoint = roleEndpoint("VERIFY");
  const auditEndpoint = tiebreakEnabled ? roleEndpoint("AUDIT") : null;
  if (!dryRun) {
    await harness.assertModelServing({ ...endpoint, label: "verify-translate stage" });
  }

  const systemPrompt = await fs.readFile(verifySystemPromptFile, "utf-8");
  const template = await fs.readFile(verifyTemplateFile, "utf-8");
  // The cross-chapter audit's own prompt pair (it judges relations between
  // chapters, not one chapter against its source — a different job, a rubric of
  // its own, and deliberately no score).
  const consistencySystemPrompt = await fs.readFile(consistencySystemPromptFile, "utf-8");
  const consistencyTemplate = await fs.readFile(consistencyTemplateFile, "utf-8");

  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
  // Series name / source language / target language: .env override > manifest >
  // default (the same resolution every other task uses — the reports and the
  // prompts must agree about what language the book is in).
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

  console.log(
    `[verify-translate] ${sorted.length} volume folder(s); endpoint ${describeEndpoint(endpoint)}; ` +
      `passing score ${passingScore}; thinking=${verifyThinking.thinking ? verifyThinking.thinkingLevel : "off"}; ` +
      `concurrency=${verifyConcurrency}; ` +
      `tiebreak=${tiebreakEnabled ? `ON (audit endpoint ±${tiebreakBand}, averaged with the verify score)` : "off"}.`
  );
  await logRunEstimate({
    stage: "verify-translate",
    volumes: volumes.length,
    chapters: (await countStageChapters({ seriesDir, volumes: volumes.map((f) => volumeByFolder.get(f)).filter(Boolean) })).chapters,
    // Every chapter gets at least one grading call; a borderline one gets up to
    // VERIFY_SAMPLES, and the borderline ones also get the cross-model audit.
    callsPerChapter: verifySamples + (tiebreakEnabled ? 1 : 0),
    endpoint,
    extra: `samples per borderline chapter: ${verifySamples}`,
  });

  const failedVolumes = [];
  /**
   * The per-volume context the later phases need. Resolving the bundle once and
   * reusing it is what makes the phase split cheap (the epub extraction is
   * already cached on disk).
   */
  const prepared = [];
  let totalVerified = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalNoDraft = 0;

  // ── PHASE 1 — first sample, every volume, one endpoint ────────────────────
  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
      // The verifier's own model is what the prompt budget is measured against
      // (once per run — the lookup is cached per endpoint).
      await calibrateStageTokens({ endpoint, bundle, label: "verify-translate stage", dryRun });
      // The handoff's chapter list and the extracted one must describe the same
      // book (see checkChapterListConsistency). A disagreement is reported, not
      // fatal: the extracted list is the one this stage uses.
      await checkChapterListConsistency(volumeDir, bundle);
      // The volume's own text decides WHICH sections of the cumulative
      // references get injected (see loadVolumeReferences): a 17-volume series
      // must show the translator the state and cast that matter to THIS book.
      const volumeSourceText = await readFileOrEmpty(bundle.wholePath || path.join(volumeDir, bundle.segments[0].file));
      const refs = await loadVolumeReferences(volumeDir, volumeSourceText);
      const result = await processVerifyVolume({
        volume,
        volumeDir,
        bundle,
        refs,
        systemPrompt,
        template,
        endpoint,
        auditEndpoint,
        dryRun,
        force,
      });
      prepared.push({ volume, volumeDir, bundle, refs });
      totalVerified += result.verified;
      totalPassed += result.passed;
      totalFailed += result.failed;
      totalSkipped += result.skipped;
      totalNoDraft += result.noDraft;
      console.log(
        `[verify-translate] Volume ${volume.installmentNumber}: ${result.verified} verified, ` +
          `${result.passed} PASS, ${result.failed} FAIL, ${result.skipped} skipped, ${result.noDraft} without draft.`
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

  if (!dryRun) {
    // ── PHASE 2 — repeat samples for the borderline chapters (same endpoint,
    // so no container switch) ────────────────────────────────────────────────
    for (const p of prepared) {
      const sidecarPath = path.join(p.volumeDir, VERIFICATION_FILE);
      const sidecar = await loadVerificationSidecar(sidecarPath);
      await runVerificationSamples({
        volume: p.volume,
        volumeDir: p.volumeDir,
        bundle: p.bundle,
        refs: p.refs,
        systemPrompt,
        template,
        endpoint,
        sidecar,
        sidecarPath,
      });
    }

    // ── PHASE 3 — ONE cross-model audit batch over EVERY volume ─────────────
    // The hook (the container switch on a shared-port setup) fires ONCE for the
    // whole run. It used to fire per volume, which is the exact interleaving the
    // batching exists to avoid: a 17-volume run paid 17 model switches for a
    // pass that is supposed to need one.
    const auditBatchNeeded = (tiebreakEnabled || volumeConsistencyEnabled) && prepared.length > 0;
    if (auditBatchNeeded && !auditEndpoint) {
      console.error(
        "[verify-translate] the cross-checks (tiebreak / cross-chapter audit) need the AUDIT_* role, " +
          "which falls back to AI_* here — no separate audit endpoint is configured."
      );
    }
    if (auditBatchNeeded && auditEndpoint) {
      const runBatch = withHooks("verify-audit", async () => {
        for (const p of prepared) {
          if (!tiebreakEnabled) continue;
          const sidecarPath = path.join(p.volumeDir, VERIFICATION_FILE);
          const sidecar = await loadVerificationSidecar(sidecarPath);
          await runAuditTiebreak({
            volume: p.volume,
            volumeDir: p.volumeDir,
            bundle: p.bundle,
            refs: p.refs,
            systemPrompt,
            template,
            sidecar,
            sidecarPath,
            auditEndpoint,
            dryRun,
          });
        }
        // ── PHASE 3b — the cross-chapter audit, in the SAME audit batch ──────
        // Same role, same container, same switch: the two checks that need a
        // second model run together instead of paying for two container swaps.
        if (volumeConsistencyEnabled) {
          for (const p of prepared) {
            try {
              const prev = await previousVolumeTail(seriesDir, manifest, p.volume.folder, CONSISTENCY_TAIL_CHARS);
              const res = await runVolumeConsistencyPass({
                volume: p.volume,
                volumeDir: p.volumeDir,
                bundle: p.bundle,
                refs: p.refs,
                systemPrompt: consistencySystemPrompt,
                template: consistencyTemplate,
                auditEndpoint,
                prevTail: prev.text,
                force,
              });
              if (res.skipped) {
                console.log(
                  `  Volume ${p.volume.installmentNumber}: cross-chapter audit skipped (${res.skipped}).`
                );
              }
            } catch (err) {
              // An extra pair of eyes must not break the verification run: the
              // volume keeps its per-chapter verdicts and the failure is logged.
              console.error(
                `[verify-translate] Volume ${p.volume.installmentNumber}: cross-chapter audit failed: ${err.message}`
              );
            }
          }
        }
      });
      await runBatch();
    }
  }

  // ── PHASE 4 — commit the verdicts (best-draft records + the reports) ──────
  // Counts are read back from the sidecar rather than accumulated across the
  // phases, so the numbers always describe the files that are actually on disk.
  let disputeCount = 0;
  if (!dryRun) {
    totalPassed = 0;
    totalFailed = 0;
    totalVerified = 0;
    totalNoDraft = 0;
    totalSkipped = 0;
    for (const p of prepared) {
      const committed = await commitVerificationVolume({
        volume: p.volume,
        volumeDir: p.volumeDir,
        bundle: p.bundle,
        refs: p.refs,
        targetLanguage: runSettings.targetLanguage,
      });
      totalVerified += committed.verified;
      totalPassed += committed.passed;
      totalFailed += committed.failed;
      totalNoDraft += committed.noDraft;
    }
    // ── PHASE 4b — the glossary disputes queue (findings that flow BACKWARDS) ──
    // A verifier that reads the source sometimes finds that the GLOSSARY is the
    // wrong thing. That observation used to die in a per-volume report while the
    // retranslate pass went on obeying the bad entry and the next round complained
    // again. Collected at the series root, the glossary task can actually settle it.
    try {
      const incoming = [];
      for (const p of prepared) {
        const sidecar = await loadVerificationSidecar(path.join(p.volumeDir, VERIFICATION_FILE));
        for (const d of collectVolumeDisputes(sidecar, p.volume.installmentNumber)) incoming.push(d);
      }
      const existing = await loadGlossaryDisputes(seriesDir);
      const merged = mergeDisputes(existing, incoming);
      const saved = await saveGlossaryDisputes(seriesDir, merged, { seriesName: runSettings.seriesName });
      disputeCount = saved.count;
      const fresh = incoming.length;
      if (fresh > 0) {
        console.log(
          `[verify-translate] ${fresh} glossary dispute(s) recorded this run — ` +
            `${disputeCount} open in ${DISPUTES_FILE} / ${DISPUTES_REPORT} (run the glossary task to settle them).`
        );
      }
    } catch (err) {
      // The queue is a channel, not a gate: a failure to write it must not lose
      // the verification verdicts that were just committed.
      console.error(`[verify-translate] could not write the glossary disputes queue: ${err.message}`);
    }
  }

  console.log(
    `[verify-translate] Done: ${totalVerified} chapter(s) verified — ${totalPassed} PASS, ${totalFailed} FAIL ` +
      `(FAILs are retranslated by the "retranslate" task)` +
      (disputeCount > 0 ? ` — ${disputeCount} glossary dispute(s) open.` : ".")
  );
  const volumeError = volumeFailureError("verify-translate", failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
  return {
    verified: totalVerified,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    noDraft: totalNoDraft,
    disputes: disputeCount,
  };
}


module.exports = {
  verifyTranslate,
};

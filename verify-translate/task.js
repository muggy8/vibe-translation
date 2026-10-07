/**
 * The task entry: the endpoint sanity check, the run estimate, the four phases of a verification
 * run, the disputes queue, and the failure summary.
 *
 * The verification run is not one pass over the volumes. It walks the volumes once (one endpoint),
 * then re-grades the borderline chapters, then runs ONE cross-model audit batch over everything it
 * prepared, and only then commits the verdicts and collects the findings that flow backwards. The
 * phases are separate functions because each one has its own reason to exist, and the ordering is
 * the point: the audit batch is one container switch for the whole run, not one per volume.
 *
 * The shape of the volume walk — flags, plan of record, reading order, `--volume`, the skip policy —
 * is the shared series-run layer (utils/series-run.js). This stage keeps its own failure summary,
 * because its run does not end at the volume walk.
 *
 * Part of the verify-translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { readRunArgs, openSeriesRun, walkVolumes } = require("../utils/series-run");
const { validateRequiredEnv, volumeFailureError } = require("../configs/shared");
const { resolveSourceBundle } = require("../utils/source");
const {
  collectVolumeDisputes,
  mergeDisputes,
  loadGlossaryDisputes,
  saveGlossaryDisputes,
  DISPUTES_FILE,
  DISPUTES_REPORT,
} = require("../utils/disputes");
const {
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  loadVerificationSidecar,
  readFileOrEmpty,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  previousVolumeTail,
  VERIFICATION_FILE,
} = require("../utils/translate");
const { withHooks } = require("../utils/hooks");

const { CONSISTENCY_TAIL_CHARS, consistencySystemPromptFile, consistencyTemplateFile, passingScore, seriesDir, tiebreakBand, tiebreakEnabled, verifyConcurrency, verifyEnabled, verifySamples, verifySystemPromptFile, verifyTemplateFile, verifyThinking, volumeConsistencyEnabled } = require("./config");
const { runVolumeConsistencyPass } = require("./consistency");
const { commitVerificationVolume, processVerifyVolume, runAuditTiebreak } = require("./volume");
const { runVerificationSamples } = require("./grade");

/**
 * @typedef {Object} VerifyRun
 * @property {Object} series - What openSeriesRun resolved: manifest, runSettings, folders, volumes, volumeByFolder.
 * @property {Object} endpoint - The VERIFY role's endpoint.
 * @property {Object|null} auditEndpoint - The AUDIT role's endpoint, or null when the cross-checks are off.
 * @property {string} systemPrompt - The per-chapter verifier's system prompt.
 * @property {string} template - Its user prompt template.
 * @property {string} consistencySystemPrompt - The cross-chapter audit's own pair (a different job, a rubric of its own, deliberately no score).
 * @property {string} consistencyTemplate
 * @property {boolean} dryRun
 * @property {boolean} force
 */

/**
 * @typedef {Object} PreparedVolume - One volume's phase-1 context, reused by the later phases.
 * Resolving the bundle once and reusing it is what makes the phase split cheap: the archive
 * extraction is already cached on disk.
 * @property {Object} volume
 * @property {string} volumeDir
 * @property {Object} bundle
 * @property {Object} refs
 */

/**
 * Read the two prompt pairs this stage runs (the verifier's, and the cross-chapter audit's).
 * @returns {Promise<{systemPrompt: string, template: string, consistencySystemPrompt: string, consistencyTemplate: string}>}
 */
async function loadVerifyPrompts() {
  return {
    systemPrompt: await fs.readFile(verifySystemPromptFile, "utf-8"),
    template: await fs.readFile(verifyTemplateFile, "utf-8"),
    consistencySystemPrompt: await fs.readFile(consistencySystemPromptFile, "utf-8"),
    consistencyTemplate: await fs.readFile(consistencyTemplateFile, "utf-8"),
  };
}

/**
 * PHASE 1 — grade one volume's chapters once, on the verify endpoint.
 *
 * @param {Object} args
 * @param {string} args.folderName
 * @param {Object} args.volume
 * @param {VerifyRun} args.run
 * @param {PreparedVolume[]} args.prepared - Appended to: the later phases need this volume's context.
 * @param {Object} args.tally - Phase-1 counts, updated in place.
 * @returns {Promise<void>}
 */
async function verifyOneVolume({ folderName, volume, run, prepared, tally }) {
  const volumeDir = path.join(seriesDir, folderName);
  const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force: run.force });
  // The verifier's own model is what the prompt budget is measured against (once per run — the
  // lookup is cached per endpoint).
  await calibrateStageTokens({ endpoint: run.endpoint, bundle, label: "verify-translate stage", dryRun: run.dryRun });
  // The handoff's chapter list and the extracted one must describe the same book (see
  // checkChapterListConsistency). A disagreement is reported, not fatal: the extracted list is the
  // one this stage uses.
  await checkChapterListConsistency(volumeDir, bundle);
  // The volume's own text decides WHICH sections of the cumulative references get injected (see
  // loadVolumeReferences): a 17-volume series must show the verifier the state and cast that matter
  // to THIS book.
  const volumeSourceText = await readFileOrEmpty(bundle.wholePath || path.join(volumeDir, bundle.segments[0].file));
  const refs = await loadVolumeReferences(volumeDir, volumeSourceText);

  const result = await processVerifyVolume({
    volume,
    volumeDir,
    bundle,
    refs,
    systemPrompt: run.systemPrompt,
    template: run.template,
    endpoint: run.endpoint,
    auditEndpoint: run.auditEndpoint,
    dryRun: run.dryRun,
    force: run.force,
  });

  prepared.push({ volume, volumeDir, bundle, refs });
  tally.verified += result.verified;
  tally.passed += result.passed;
  tally.failed += result.failed;
  tally.skipped += result.skipped;
  tally.noDraft += result.noDraft;

  console.log(
    `[verify-translate] Volume ${volume.installmentNumber}: ${result.verified} verified, ` +
      `${result.passed} PASS, ${result.failed} FAIL, ${result.skipped} skipped, ${result.noDraft} without draft.`
  );
}

/**
 * PHASE 2 — repeat the samples for the borderline chapters, on the SAME endpoint.
 *
 * A borderline chapter is graded `VERIFY_SAMPLES` times because one grading call is one sample of a
 * stochastic judge. Switching containers between those samples would compare two different models
 * rather than two readings of the same one, so this phase deliberately does not use the audit role.
 *
 * @param {{prepared: PreparedVolume[], run: VerifyRun}} args
 * @returns {Promise<void>}
 */
async function repeatBorderlineSamples({ prepared, run }) {
  for (const p of prepared) {
    const sidecarPath = path.join(p.volumeDir, VERIFICATION_FILE);
    const sidecar = await loadVerificationSidecar(sidecarPath);
    await runVerificationSamples({
      volume: p.volume,
      volumeDir: p.volumeDir,
      bundle: p.bundle,
      refs: p.refs,
      systemPrompt: run.systemPrompt,
      template: run.template,
      endpoint: run.endpoint,
      sidecar,
      sidecarPath,
    });
  }
}

/**
 * PHASE 3 (+3b) — ONE cross-model batch: the tiebreak audit, then the cross-chapter audit.
 *
 * The hook (the container switch on a shared-port setup) fires ONCE for the whole run. It used to
 * fire per volume, which is the exact interleaving the batching exists to avoid: a 17-volume run
 * paid 17 model switches for a pass that is supposed to need one. The two checks that need a second
 * model run together share that one switch instead of paying for two.
 *
 * @param {{prepared: PreparedVolume[], run: VerifyRun}} args
 * @returns {Promise<void>}
 */
async function runCrossModelBatch({ prepared, run }) {
  const needed = (tiebreakEnabled || volumeConsistencyEnabled) && prepared.length > 0;
  if (!needed) return;
  if (!run.auditEndpoint) {
    console.error(
      "[verify-translate] the cross-checks (tiebreak / cross-chapter audit) need the AUDIT_* role, " +
        "which falls back to AI_* here — no separate audit endpoint is configured."
    );
    return;
  }

  await withHooks("verify-audit", async () => {
    for (const p of prepared) {
      if (!tiebreakEnabled) continue;
      const sidecarPath = path.join(p.volumeDir, VERIFICATION_FILE);
      const sidecar = await loadVerificationSidecar(sidecarPath);
      await runAuditTiebreak({
        volume: p.volume,
        volumeDir: p.volumeDir,
        bundle: p.bundle,
        refs: p.refs,
        systemPrompt: run.systemPrompt,
        template: run.template,
        sidecar,
        sidecarPath,
        auditEndpoint: run.auditEndpoint,
        dryRun: run.dryRun,
      });
    }

    if (!volumeConsistencyEnabled) return;
    for (const p of prepared) {
      try {
        const prev = await previousVolumeTail(seriesDir, run.series.manifest, p.volume.folder, CONSISTENCY_TAIL_CHARS);
        const res = await runVolumeConsistencyPass({
          volume: p.volume,
          volumeDir: p.volumeDir,
          bundle: p.bundle,
          refs: p.refs,
          systemPrompt: run.consistencySystemPrompt,
          template: run.consistencyTemplate,
          auditEndpoint: run.auditEndpoint,
          prevTail: prev.text,
          force: run.force,
        });
        if (res.skipped) {
          console.log(`  Volume ${p.volume.installmentNumber}: cross-chapter audit skipped (${res.skipped}).`);
        }
      } catch (err) {
        // An extra pair of eyes must not break the verification run: the volume keeps its
        // per-chapter verdicts and the failure is logged.
        console.error(
          `[verify-translate] Volume ${p.volume.installmentNumber}: cross-chapter audit failed: ${err.message}`
        );
      }
    }
  });
}

/**
 * PHASE 4 — commit the verdicts: the best-draft records and each volume's verification report.
 *
 * The counts are read back from the sidecars rather than carried across the phases, so the numbers
 * in the summary always describe the files that are actually on disk. (`skipped` is a phase-1
 * number — "this chapter's verdict already covers the current draft" — and the commit pass does not
 * re-derive it, so a live run reports 0.)
 *
 * @param {{prepared: PreparedVolume[], run: VerifyRun}} args
 * @returns {Promise<{verified: number, passed: number, failed: number, skipped: number, noDraft: number}>}
 */
async function commitVerifiedVolumes({ prepared, run }) {
  const totals = { verified: 0, passed: 0, failed: 0, skipped: 0, noDraft: 0 };
  for (const p of prepared) {
    const committed = await commitVerificationVolume({
      volume: p.volume,
      volumeDir: p.volumeDir,
      bundle: p.bundle,
      refs: p.refs,
      targetLanguage: run.series.runSettings.targetLanguage,
    });
    totals.verified += committed.verified;
    totals.passed += committed.passed;
    totals.failed += committed.failed;
    totals.noDraft += committed.noDraft;
  }
  return totals;
}

/**
 * PHASE 4b — the glossary disputes queue: the findings that flow BACKWARDS.
 *
 * A verifier that reads the source sometimes finds that the GLOSSARY is the wrong thing. That
 * observation used to die in a per-volume report while the retranslate pass went on obeying the bad
 * entry and the next round complained again. Collected at the series root, the glossary task can
 * actually settle it.
 *
 * @param {{prepared: PreparedVolume[], run: VerifyRun}} args
 * @returns {Promise<number>} How many disputes are open after the merge.
 */
async function collectGlossaryDisputes({ prepared, run }) {
  const incoming = [];
  for (const p of prepared) {
    const sidecar = await loadVerificationSidecar(path.join(p.volumeDir, VERIFICATION_FILE));
    for (const d of collectVolumeDisputes(sidecar, p.volume.installmentNumber)) incoming.push(d);
  }
  const existing = await loadGlossaryDisputes(seriesDir);
  const merged = mergeDisputes(existing, incoming);
  const saved = await saveGlossaryDisputes(seriesDir, merged, { seriesName: run.series.runSettings.seriesName });
  if (incoming.length > 0) {
    console.log(
      `[verify-translate] ${incoming.length} glossary dispute(s) recorded this run — ` +
        `${saved.count} open in ${DISPUTES_FILE} / ${DISPUTES_REPORT} (run the glossary task to settle them).`
    );
  }
  return saved.count;
}

/**
 * Run the verify-translate task (all volumes, or --volume NN).
 *
 * Returns the aggregated run summary — the translate-qa loop reads `failed` to decide whether the
 * validator is happy. (A volume that fails the run under ON_VOLUME_ERROR=skip still throws, as
 * before.)
 *
 * @returns {Promise<{verified: number, passed: number, failed: number, skipped: number, noDraft: number, disputes: number}>}
 */
async function verifyTranslate() {
  const { dryRun, force, volumeArg } = readRunArgs();

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

  const prompts = await loadVerifyPrompts();
  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const series = await openSeriesRun({ seriesDir, dryRun, volumeArg });
  const { folders, volumes, volumeByFolder } = series;

  console.log(
    `[verify-translate] ${folders.length} volume folder(s); endpoint ${describeEndpoint(endpoint)}; ` +
      `passing score ${passingScore}; thinking=${verifyThinking.thinking ? verifyThinking.thinkingLevel : "off"}; ` +
      `concurrency=${verifyConcurrency}; ` +
      `tiebreak=${tiebreakEnabled ? `ON (audit endpoint ±${tiebreakBand}, averaged with the verify score)` : "off"}.`
  );
  await logRunEstimate({
    stage: "verify-translate",
    volumes: volumes.length,
    chapters: (await countStageChapters({ seriesDir, volumes: volumes.map((f) => volumeByFolder.get(f)).filter(Boolean) })).chapters,
    // Every chapter gets at least one grading call; a borderline one gets up to VERIFY_SAMPLES, and
    // the borderline ones also get the cross-model audit.
    callsPerChapter: verifySamples + (tiebreakEnabled ? 1 : 0),
    endpoint,
    extra: `samples per borderline chapter: ${verifySamples}`,
  });

  /** @type {VerifyRun} */
  const run = { series, endpoint, auditEndpoint, ...prompts, dryRun, force };

  // PHASE 1 — first sample, every volume, one endpoint.
  const tally = { verified: 0, passed: 0, failed: 0, skipped: 0, noDraft: 0 };
  /** @type {PreparedVolume[]} */
  const prepared = [];
  const failedVolumes = await walkVolumes({
    volumes,
    folders,
    volumeByFolder,
    processVolume: (folderName) =>
      verifyOneVolume({ folderName, volume: volumeByFolder.get(folderName), run, prepared, tally }),
  });

  if (!dryRun) {
    // PHASE 2 — repeat samples for the borderline chapters.
    await repeatBorderlineSamples({ prepared, run });
    // PHASE 3 — one cross-model audit batch over EVERY volume.
    await runCrossModelBatch({ prepared, run });
  }

  // PHASE 4 — commit the verdicts, then 4b: the disputes the commit produced.
  let totals = tally;
  let disputeCount = 0;
  if (!dryRun) {
    totals = await commitVerifiedVolumes({ prepared, run });
    try {
      disputeCount = await collectGlossaryDisputes({ prepared, run });
    } catch (err) {
      // The queue is a channel, not a gate: a failure to write it must not lose the verification
      // verdicts that were just committed.
      console.error(`[verify-translate] could not write the glossary disputes queue: ${err.message}`);
    }
  }

  console.log(
    `[verify-translate] Done: ${totals.verified} chapter(s) verified — ${totals.passed} PASS, ${totals.failed} FAIL ` +
      `(FAILs are retranslated by the "retranslate" task)` +
      (disputeCount > 0 ? ` — ${disputeCount} glossary dispute(s) open.` : ".")
  );

  // This stage's summary is thrown here, not at the end of the volume walk: the run still has three
  // phases to go after the walk, and a skipped volume must not cancel the verdicts already earned.
  const volumeError = volumeFailureError("verify-translate", failedVolumes, volumes.length);
  if (volumeError) throw volumeError;

  return {
    verified: totals.verified,
    passed: totals.passed,
    failed: totals.failed,
    skipped: totals.skipped,
    noDraft: totals.noDraft,
    disputes: disputeCount,
  };
}

module.exports = {
  verifyTranslate,
};

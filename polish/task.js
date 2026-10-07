/**
 * The gulp task: the rounds, the hooks at each endpoint boundary, and the report.
 *
 * Part of the polish.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { getTranslationTarget } = require("../get-translation-target");
const { filterVolumesByInstallment } = require("../utils/manifest");
const { ON_VOLUME_ERROR, PASSING_SCORE, validateRequiredEnv, resolveRunSettings, isStructuralError, structuralError, volumeFailureError } = require("../configs/shared");
const { resolveSourceBundle } = require("../utils/source");
const { writeTranslationReport } = require("../utils/translation-report");
const {
  sha256,
  checkTranslationQa,
  buildPolishGuardFindings,
  stripMarkdownFence,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  runWithConcurrency,
  stageConcurrency,
  judgeTemperature,
  stageThinking,
  writerTemperature,
  estimateTokens,
  fitPromptBudget,
  describeDroppedBlocks,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  glossaryBlock,
  loadVerificationSidecar,
  readFileOrEmpty,
  saveVerificationSidecar,
  findingsOf,
  chapterArtifactNames,
  MERGED_FILE,
  STATE_FILE,
  POLISH_QA_REPORT,
  POLISH_VERIFICATION_FILE,
} = require("../utils/translate");
const { withHooks } = require("../utils/hooks");

const { polishConcurrency, polishMaxRounds, polishSystemPromptFile, polishTemplateFile, polishThinking, polishVerifyEnabled, polishVerifyPassingScore, polishVerifySystemPromptFile, polishVerifyTemplateFile, seriesDir } = require("./config");
const { acceptPolishCandidatesWithoutAudit, polishVolumePhaseA } = require("./phase-a");
const { runPolishAuditRound } = require("./audit");
const { runPolishRepairRound } = require("./repair");
const { finishPolishVolume } = require("./commit");

/**
 * Run the polish task (all volumes, or --volume NN).
 *
 * @returns {Promise<void>}
 */
async function polish() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  validateRequiredEnv({ dryRun });

  const endpoint = roleEndpoint("EDIT");
  const auditEndpoint = polishVerifyEnabled ? roleEndpoint("AUDIT") : null;
  if (!dryRun) {
    await harness.assertModelServing({ ...endpoint, label: "polish stage" });
  }

  const systemPrompt = await fs.readFile(polishSystemPromptFile, "utf-8");
  const template = await fs.readFile(polishTemplateFile, "utf-8");
  const verifySystemPrompt = polishVerifyEnabled
    ? await fs.readFile(polishVerifySystemPromptFile, "utf-8")
    : null;
  const verifyTemplate = polishVerifyEnabled
    ? await fs.readFile(polishVerifyTemplateFile, "utf-8")
    : null;

  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
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
    `[polish] ${sorted.length} volume folder(s); endpoint ${describeEndpoint(endpoint)}; ` +
      `thinking=${polishThinking.thinking ? polishThinking.thinkingLevel : "off"}; ` +
      `final audit ${polishVerifyEnabled ? `ON (batched cross-model audit, PASS ≥ ${polishVerifyPassingScore}/100)` : "OFF (deterministic guard only)"}; ` +
      `max ${polishMaxRounds} round(s)/chapter; concurrency=${polishConcurrency}.`
  );
  await logRunEstimate({
    stage: "polish",
    volumes: volumes.length,
    chapters: (await countStageChapters({ seriesDir, volumes: volumes.map((f) => volumeByFolder.get(f)).filter(Boolean) })).chapters,
    // One polish call per chapter, plus one audit call, plus a re-polish + audit
    // for every round the audit rejects.
    callsPerChapter: 1 + (polishVerifyEnabled ? 2 * polishMaxRounds - 1 : 0),
    endpoint,
    extra: polishVerifyEnabled ? "the audit calls run on the audit endpoint" : "no audit calls (deterministic guard only)",
  });

  const failedVolumes = [];
  /** The Phase A results, kept so the audit rounds can run across ALL volumes. */
  const volumeCtxs = [];

  // ── PHASE A — polish every volume's chapters (the edit endpoint) ──────────
  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
      // The polisher runs on the EDIT_* role — a different model from the
      // verifier and from the auditor that grades its work (see the polish
      // final audit). Re-point the estimate for THIS role before budgeting.
      await calibrateStageTokens({ endpoint, bundle, label: "polish stage", dryRun });
      // The handoff's chapter list and the extracted one must describe the same
      // book (see checkChapterListConsistency). A disagreement is reported, not
      // fatal: the extracted list is the one this stage uses.
      await checkChapterListConsistency(volumeDir, bundle);
      // The volume's own text decides WHICH sections of the cumulative
      // references get injected (see loadVolumeReferences): a 17-volume series
      // must show the translator the state and cast that matter to THIS book.
      const volumeSourceText = await readFileOrEmpty(bundle.wholePath || path.join(volumeDir, bundle.segments[0].file));
      const refs = await loadVolumeReferences(volumeDir, volumeSourceText);
      const vc = await polishVolumePhaseA({
        volume,
        volumeDir,
        bundle,
        refs,
        systemPrompt,
        template,
        verifySystemPrompt,
        verifyTemplate,
        endpoint,
        auditEndpoint,
        dryRun,
        force,
        sourceLanguage: runSettings.sourceLanguage,
        targetLanguage: runSettings.targetLanguage,
      });
      if (dryRun) continue; // Phase A dumped prompts and produced nothing to audit
      volumeCtxs.push(vc);
      console.log(
        `[polish] Volume ${volume.installmentNumber}: ${vc.auditPending.length} guard-gated candidate(s), ` +
          `${vc.rejected} guard-rejected (draft kept), ${vc.skipped} skipped, ${vc.noDraft} without draft.`
      );
    } catch (err) {
      // A STRUCTURAL failure (a source file that vanished, an archive that will not
      // open, a volume whose chapters are incomplete) is never skippable: ON_VOLUME_ERROR
      //=skip exists for flaky model calls, not for a broken book.
      if (ON_VOLUME_ERROR === "skip" && !isStructuralError(err)) {
        console.error(`[skip] Volume ${volume.installmentNumber} (${folderName}) failed: ${err.message}`);
        failedVolumes.push(volume.installmentNumber);
        continue;
      }
      throw err;
    }
  }

  // ── PHASE B — the cross-model audit rounds, batched across EVERY volume ───
  // One hook invocation per round for the whole run (the container switch on a
  // shared-port setup), then one re-polish batch, then the next audit round.
  // It used to be per volume: a 17-volume run paid ~17 switches per round.
  const auditRounds = Math.max(1, polishMaxRounds);
  if (!dryRun) {
    if (!polishVerifyEnabled) {
      for (const vc of volumeCtxs) await acceptPolishCandidatesWithoutAudit(vc);
    } else {
      for (let round = 1; round <= auditRounds; round++) {
        const pending = volumeCtxs.filter((vc) => vc.auditPending.length > 0);
        if (pending.length === 0) break;
        console.log(
          `[polish-audit] round ${round}/${auditRounds} — auditing ` +
            `${pending.reduce((n, vc) => n + vc.auditPending.length, 0)} candidate(s) across ` +
            `${pending.length} volume(s) on ${auditEndpoint.model} (one batch, one switch).`
        );
        const auditBatch = withHooks("polish-audit", async () => {
          for (const vc of pending) {
            await runPolishAuditRound(vc, { verifySystemPrompt, verifyTemplate, auditEndpoint, dryRun });
          }
        });
        await auditBatch();

        const failedCount = pending.reduce((n, vc) => n + vc.auditPending.length, 0);
        if (failedCount === 0) break;
        if (round === auditRounds) break; // the remaining candidates are finished off below

        const repairBatch = withHooks("polish", async () => {
          for (const vc of pending) {
            if (vc.auditPending.length === 0) continue;
            await runPolishRepairRound(vc, { systemPrompt, template, endpoint });
          }
        });
        await repairBatch();
      }
    }

    let totalPolished = 0;
    let totalRejected = 0;
    let totalSkipped = 0;
    let totalNoDraft = 0;
    const incompleteVolumes = [];
    for (const vc of volumeCtxs) {
      const result = await finishPolishVolume(vc, auditRounds);
      totalPolished += result.polished;
      totalRejected += result.rejected;
      totalSkipped += result.skipped;
      totalNoDraft += result.noDraft;
      if (result.missing.length > 0) {
        incompleteVolumes.push({
          installmentNumber: vc.volume.installmentNumber,
          missing: result.missing.map((m) => m.id),
        });
      }
    }
    console.log(
      `[polish] Done: ${totalPolished} chapter(s) polished, ${totalRejected} rejected ` +
        `(rejected chapters keep their draft and retry on the next run), ${totalSkipped} skipped, ` +
        `${totalNoDraft} without draft.`
    );
    await writeTranslationReport({ seriesDir, manifest, volumes, dryRun });
    if (incompleteVolumes.length > 0) {
      throw structuralError(
        `${incompleteVolumes.length} volume(s) are INCOMPLETE after the polish pass — chapters with no ` +
          `text: ${incompleteVolumes.map((v) => `${v.installmentNumber} (${v.missing.join(", ")})`).join("; ")}.`
      );
    }
    const volumeError = volumeFailureError("polish", failedVolumes, volumes.length);
    if (volumeError) throw volumeError;
    return;
  }

  console.log(`[polish] --dry-run: ${volumes.length} volume(s) previewed, no files written.`);
}


module.exports = {
  polish,
};

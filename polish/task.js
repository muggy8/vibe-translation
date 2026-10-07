/**
 * The gulp task: the two phases (polish every volume on the edit endpoint, then the audit rounds
 * batched across every volume), the hooks at each endpoint boundary, and the report.
 *
 * The phase split is the point of the ordering: the audit is a cross-model pass, and a container
 * switch is the expensive part of it. Polishing volume 1, auditing volume 1, polishing volume 2,
 * auditing volume 2 pays one switch per volume per round; batching pays one switch per round for the
 * whole run.
 *
 * The shape of the volume walk — flags, plan of record, reading order, `--volume`, the skip policy —
 * is the shared series-run layer (utils/series-run.js). This stage keeps its own failure summary,
 * because its run does not end at the volume walk.
 *
 * Part of the polish.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { readRunArgs, openSeriesRun, walkVolumes } = require("../utils/series-run");
const { validateRequiredEnv, structuralError, volumeFailureError } = require("../configs/shared");
const { resolveSourceBundle } = require("../utils/source");
const { writeTranslationReport } = require("../utils/translation-report");
const {
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  readFileOrEmpty,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
} = require("../utils/translate");
const { withHooks } = require("../utils/hooks");

const { polishConcurrency, polishMaxRounds, polishSystemPromptFile, polishTemplateFile, polishThinking, polishVerifyEnabled, polishVerifyPassingScore, polishVerifySystemPromptFile, polishVerifyTemplateFile, seriesDir } = require("./config");
const { acceptPolishCandidatesWithoutAudit, polishVolumePhaseA } = require("./phase-a");
const { runPolishAuditRound } = require("./audit");
const { runPolishRepairRound } = require("./repair");
const { finishPolishVolume } = require("./commit");

/**
 * @typedef {Object} PolishRun
 * @property {Object} series - What openSeriesRun resolved: manifest, runSettings, folders, volumes, volumeByFolder.
 * @property {Object} endpoint - The EDIT role's endpoint (the polisher).
 * @property {Object|null} auditEndpoint - The AUDIT role's endpoint, or null when the final audit is off.
 * @property {string} systemPrompt
 * @property {string} template
 * @property {string|null} verifySystemPrompt
 * @property {string|null} verifyTemplate
 * @property {boolean} dryRun
 * @property {boolean} force
 */

/**
 * Read the polish pair and (when the final audit is on) the audit pair.
 * @returns {Promise<{systemPrompt: string, template: string, verifySystemPrompt: string|null, verifyTemplate: string|null}>}
 */
async function loadPolishPrompts() {
  return {
    systemPrompt: await fs.readFile(polishSystemPromptFile, "utf-8"),
    template: await fs.readFile(polishTemplateFile, "utf-8"),
    verifySystemPrompt: polishVerifyEnabled ? await fs.readFile(polishVerifySystemPromptFile, "utf-8") : null,
    verifyTemplate: polishVerifyEnabled ? await fs.readFile(polishVerifyTemplateFile, "utf-8") : null,
  };
}

/**
 * PHASE A — polish one volume's chapters on the edit endpoint.
 *
 * @param {Object} args
 * @param {string} args.folderName
 * @param {Object} args.volume
 * @param {PolishRun} args.run
 * @param {Object[]} args.volumeCtxs - Phase A's results, appended to; the audit rounds run across ALL
 *   of them, which is what makes one batch per round possible.
 * @returns {Promise<void>}
 */
async function polishOneVolume({ folderName, volume, run, volumeCtxs }) {
  const volumeDir = path.join(seriesDir, folderName);
  const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force: run.force });
  // The polisher runs on the EDIT_* role — a different model from the verifier and from the auditor
  // that grades its work (see the polish final audit). Re-point the estimate for THIS role before
  // budgeting.
  await calibrateStageTokens({ endpoint: run.endpoint, bundle, label: "polish stage", dryRun: run.dryRun });
  // The handoff's chapter list and the extracted one must describe the same book (see
  // checkChapterListConsistency). A disagreement is reported, not fatal: the extracted list is the
  // one this stage uses.
  await checkChapterListConsistency(volumeDir, bundle);
  // The volume's own text decides WHICH sections of the cumulative references get injected (see
  // loadVolumeReferences): a 17-volume series must show the polisher the state and cast that matter
  // to THIS book.
  const volumeSourceText = await readFileOrEmpty(bundle.wholePath || path.join(volumeDir, bundle.segments[0].file));
  const refs = await loadVolumeReferences(volumeDir, volumeSourceText);

  const vc = await polishVolumePhaseA({
    volume,
    volumeDir,
    bundle,
    refs,
    systemPrompt: run.systemPrompt,
    template: run.template,
    verifySystemPrompt: run.verifySystemPrompt,
    verifyTemplate: run.verifyTemplate,
    endpoint: run.endpoint,
    auditEndpoint: run.auditEndpoint,
    dryRun: run.dryRun,
    force: run.force,
    sourceLanguage: run.series.runSettings.sourceLanguage,
    targetLanguage: run.series.runSettings.targetLanguage,
  });
  if (run.dryRun) return; // Phase A dumped prompts and produced nothing to audit

  volumeCtxs.push(vc);
  console.log(
    `[polish] Volume ${volume.installmentNumber}: ${vc.auditPending.length} guard-gated candidate(s), ` +
      `${vc.rejected} guard-rejected (draft kept), ${vc.skipped} skipped, ${vc.noDraft} without draft.`
  );
}

/**
 * PHASE B — the audit rounds, batched across every volume.
 *
 * One hook invocation per round for the whole run (the container switch on a shared-port setup), then
 * one re-polish batch, then the next audit round. It used to be per volume: a 17-volume run paid ~17
 * switches per round for a pass that needs one.
 *
 * @param {{volumeCtxs: Object[], run: PolishRun, auditRounds: number}} args
 * @returns {Promise<void>}
 */
async function runAuditRounds({ volumeCtxs, run, auditRounds }) {
  if (!polishVerifyEnabled) {
    for (const vc of volumeCtxs) await acceptPolishCandidatesWithoutAudit(vc);
    return;
  }

  for (let round = 1; round <= auditRounds; round++) {
    const pending = volumeCtxs.filter((vc) => vc.auditPending.length > 0);
    if (pending.length === 0) break;
    console.log(
      `[polish-audit] round ${round}/${auditRounds} — auditing ` +
        `${pending.reduce((n, vc) => n + vc.auditPending.length, 0)} candidate(s) across ` +
        `${pending.length} volume(s) on ${run.auditEndpoint.model} (one batch, one switch).`
    );
    const auditBatch = withHooks("polish-audit", async () => {
      for (const vc of pending) {
        await runPolishAuditRound(vc, {
          verifySystemPrompt: run.verifySystemPrompt,
          verifyTemplate: run.verifyTemplate,
          auditEndpoint: run.auditEndpoint,
          dryRun: run.dryRun,
        });
      }
    });
    await auditBatch();

    const failedCount = pending.reduce((n, vc) => n + vc.auditPending.length, 0);
    if (failedCount === 0) break;
    if (round === auditRounds) break; // the remaining candidates are finished off in the commit pass

    const repairBatch = withHooks("polish", async () => {
      for (const vc of pending) {
        if (vc.auditPending.length === 0) continue;
        await runPolishRepairRound(vc, { systemPrompt: run.systemPrompt, template: run.template, endpoint: run.endpoint });
      }
    });
    await repairBatch();
  }
}

/**
 * Commit every volume's polished chapters and collect what is still missing.
 *
 * @param {{volumeCtxs: Object[], auditRounds: number}} args
 * @returns {Promise<{polished: number, rejected: number, skipped: number, noDraft: number, incompleteVolumes: Array<{installmentNumber: string, missing: string[]}>}>}
 */
async function commitPolishedVolumes({ volumeCtxs, auditRounds }) {
  const totals = { polished: 0, rejected: 0, skipped: 0, noDraft: 0 };
  /** @type {Array<{installmentNumber: string, missing: string[]}>} */
  const incompleteVolumes = [];
  for (const vc of volumeCtxs) {
    const result = await finishPolishVolume(vc, auditRounds);
    totals.polished += result.polished;
    totals.rejected += result.rejected;
    totals.skipped += result.skipped;
    totals.noDraft += result.noDraft;
    if (result.missing.length > 0) {
      incompleteVolumes.push({
        installmentNumber: vc.volume.installmentNumber,
        missing: result.missing.map((m) => m.id),
      });
    }
  }
  return { ...totals, incompleteVolumes };
}

/**
 * Run the polish task (all volumes, or --volume NN).
 *
 * @returns {Promise<void>}
 */
async function polish() {
  const { dryRun, force, volumeArg } = readRunArgs();

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  validateRequiredEnv({ dryRun });

  const endpoint = roleEndpoint("EDIT");
  const auditEndpoint = polishVerifyEnabled ? roleEndpoint("AUDIT") : null;
  if (!dryRun) {
    await harness.assertModelServing({ ...endpoint, label: "polish stage" });
  }

  const prompts = await loadPolishPrompts();
  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const series = await openSeriesRun({ seriesDir, dryRun, volumeArg });
  const { manifest, folders, volumes, volumeByFolder } = series;

  console.log(
    `[polish] ${folders.length} volume folder(s); endpoint ${describeEndpoint(endpoint)}; ` +
      `thinking=${polishThinking.thinking ? polishThinking.thinkingLevel : "off"}; ` +
      `final audit ${polishVerifyEnabled ? `ON (batched cross-model audit, PASS ≥ ${polishVerifyPassingScore}/100)` : "OFF (deterministic guard only)"}; ` +
      `max ${polishMaxRounds} round(s)/chapter; concurrency=${polishConcurrency}.`
  );
  await logRunEstimate({
    stage: "polish",
    volumes: volumes.length,
    chapters: (await countStageChapters({ seriesDir, volumes: volumes.map((f) => volumeByFolder.get(f)).filter(Boolean) })).chapters,
    // One polish call per chapter, plus one audit call, plus a re-polish + audit for every round the
    // audit rejects.
    callsPerChapter: 1 + (polishVerifyEnabled ? 2 * polishMaxRounds - 1 : 0),
    endpoint,
    extra: polishVerifyEnabled ? "the audit calls run on the audit endpoint" : "no audit calls (deterministic guard only)",
  });

  /** @type {PolishRun} */
  const run = { series, endpoint, auditEndpoint, ...prompts, dryRun, force };

  // PHASE A — polish every volume's chapters (the edit endpoint).
  /** @type {Object[]} */
  const volumeCtxs = [];
  const failedVolumes = await walkVolumes({
    volumes,
    folders,
    volumeByFolder,
    processVolume: (folderName) =>
      polishOneVolume({ folderName, volume: volumeByFolder.get(folderName), run, volumeCtxs }),
  });

  if (dryRun) {
    console.log(`[polish] --dry-run: ${volumes.length} volume(s) previewed, no files written.`);
    return;
  }

  // PHASE B — the cross-model audit rounds, batched across EVERY volume.
  const auditRounds = Math.max(1, polishMaxRounds);
  await runAuditRounds({ volumeCtxs, run, auditRounds });

  const { polished, rejected, skipped, noDraft, incompleteVolumes } = await commitPolishedVolumes({
    volumeCtxs,
    auditRounds,
  });
  console.log(
    `[polish] Done: ${polished} chapter(s) polished, ${rejected} rejected ` +
      `(rejected chapters keep their draft and retry on the next run), ${skipped} skipped, ` +
      `${noDraft} without draft.`
  );
  await writeTranslationReport({ seriesDir, manifest, volumes, dryRun });

  // A chapter the polish pass left with no text is a STRUCTURAL failure: the report above has now
  // said so, and no ON_VOLUME_ERROR=skip walks past it.
  if (incompleteVolumes.length > 0) {
    throw structuralError(
      `${incompleteVolumes.length} volume(s) are INCOMPLETE after the polish pass — chapters with no ` +
        `text: ${incompleteVolumes.map((v) => `${v.installmentNumber} (${v.missing.join(", ")})`).join("; ")}.`
    );
  }
  const volumeError = volumeFailureError("polish", failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
}

module.exports = {
  polish,
};

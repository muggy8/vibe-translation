/**
 * One volume of the correction pass.
 *
 * The volume's own job is small: load the three records the pass reads, plan the chapter parts with
 * the SAME rule the translate stage used, snapshot the continuity cues once, and hand every chapter to
 * the per-chapter module. Chapters are INDEPENDENT here (each is retranslated from its own source +
 * findings — no cross-chapter chaining), so they can run in parallel when STAGE_CONCURRENCY > 1.
 *
 * Part of the retranslate.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");
const harness = require("../harness");
const {
  createChapterPlanner,
  runWithConcurrency,
  MERGED_FILE,
} = require("../utils/translate");
const { mergeVolumeTranslationFiles } = require("../translate");

const { retranslateConcurrency, continuityChars } = require("./config");
const { snapshotContinuityTails } = require("./tails");
const { loadVolumeRecords, decideTarget, repairChapter } = require("./chapter");

/**
 * Re-translate one volume's failed chapters.
 *
 * @param {{
 *   volume: {folder: string, sourceFile: string, installmentNumber: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string, chars: number}>},
 *   refs: {terms: Array<{term: string, rendering: string, section: string}>, background: string, styleRules: string, contextHash: string},
 *   template: string,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   sampling: {temperature: number, topP: number, topK: number, repetitionPenalty: number},
 *   thinkingMode: "no_think"|"low"|"high",
 *   dryRun: boolean,
 *   force: boolean,
 *   incomingTail?: {text: string, fromLabel: string},
 *   previousVolumeDirs?: string[],
 * }} ctx
 * @returns {Promise<{retranslated: number, skipped: number, none: number, deferred: number, crossChapter: number, missing: Array, promptDrops: Array}>}
 */
async function processRetranslateVolume(ctx) {
  const { volume, volumeDir, bundle, refs, template, endpoint, thinkingMode, sourceLanguage, targetLanguage } = ctx;
  const records = await loadVolumeRecords(volumeDir);

  // The context budget for this role (see the translate task's identical block): every injected
  // reference block is fitted into it, and every drop is logged.
  const roleWindow = endpoint.contextWindow || harness.envContextWindow();
  const outputReserve = endpoint.maxTokens || harness.envMaxTokens();

  // Chapter parts are planned in tokens, the same rule the translate task uses — the two tasks must
  // not disagree about how a chapter is cut up, or a retranslate would produce a differently-shaped
  // chapter than the one verify graded.
  const planner = await createChapterPlanner({
    refs,
    template,
    thinkingMode,
    sourceLanguage,
    targetLanguage,
    previousVolumeDirs: ctx.previousVolumeDirs || [],
    roleWindow,
    outputReserve,
  });

  /** @type {Object} The counters, the prompt drops, and the shared per-chapter state. */
  const run = {
    retranslated: 0,
    skipped: 0,
    none: 0,
    deferred: 0,
    crossChapter: 0,
    promptDrops: [],
    roleWindow,
    outputReserve,
    planner,
    state: records.state,
    // The cues are snapshotted first so every worker sees the same book (see tails.js).
    continuityTails: await snapshotContinuityTails(bundle, volumeDir, continuityChars, ctx.incomingTail),
  };

  await runWithConcurrency(bundle.segments, retranslateConcurrency, async (seg) => {
    const target = await decideTarget(ctx, run, seg, records);
    if (!target.go) return;
    await repairChapter(ctx, run, seg, target, records);
  });

  // Re-merge the volume (drafts changed; the stale polished files were dropped).
  const merged = await mergeVolumeTranslationFiles(volumeDir, bundle, records.state, { sourceLanguage, targetLanguage });
  if (merged.text) {
    await fs.writeFile(path.join(volumeDir, MERGED_FILE), merged.text, "utf8");
  }
  if (merged.missing.length > 0) {
    console.error(
      `  Volume ${volume.installmentNumber}: still incomplete after retranslation — ` +
        `${merged.missing.map((m) => m.id).join(", ")}.`
    );
  }
  if (run.promptDrops.length > 0) {
    console.warn(
      `  Volume ${volume.installmentNumber}: ${run.promptDrops.length} chapter-part(s) had reference material ` +
        `dropped to fit the ${roleWindow}-token context window (see the log lines above).`
    );
  }
  return {
    retranslated: run.retranslated,
    skipped: run.skipped,
    none: run.none,
    deferred: run.deferred,
    crossChapter: run.crossChapter,
    missing: merged.missing,
    promptDrops: run.promptDrops,
  };
}

module.exports = { processRetranslateVolume };

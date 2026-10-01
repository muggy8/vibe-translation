/**
 * retranslate.js — Logic for the "retranslate" gulp task: the correction
 * pass of the translation pipeline.
 *
 * Task: retranslate
 *   For each volume, for each chapter whose verification (the
 *   translation-verification.json sidecar written by verify-translate) says
 *   FAIL (or the score was unparseable) AND the entry still covers the
 *   current source + draft:
 *     1. Skip it when the state file already shows a retranslate run for the
 *        SAME findings (retranslated=true + matching findingsHash) —
 *        idempotency; --force re-runs.
 *     2. Re-translate the chapter with Hy-MT2 (translate endpoint, no system
 *        prompt, official sampling, no_think mode) — the verification
 *        FINDINGS are injected as a numbered "fix these problems" task in
 *        the official prompt. The bad draft is deliberately NOT fed back
 *        (re-reading a bad translation anchors the model to its errors).
 *        Like the translate stage, oversized chapters are split
 *        (TRANSLATE_CHUNK_CHARS) and retranslated part by part, each part
 *        continuing the previous one (TRANSLATE_CONTINUITY_CHARS).
 *     3. Deterministic QA (hard failures fail the chapter before writing).
 *     4. Overwrite the draft, update the state (draftHash, retranslated,
 *        findingsHash; the polish pass is invalidated), and re-merge the
 *        volume's translation.md.
 *
 * The pipeline then re-runs verify-translate: the retranslated draft gets a
 * fresh score (the sidecar entry was keyed to the old draft, so it is
 * re-verified automatically).
 *
 * Usage:
 *   npx gulp retranslate              # run the full task
 *   npx gulp retranslate --dry-run    # dump the prompts only, no AI calls
 *   npx gulp retranslate --force      # re-run even if already retranslated
 *   npx gulp retranslate --volume 01  # single volume
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types"); // JSDoc type definitions
const harness = require("./harness");
const { getTranslationTarget } = require("./get-translation-target");
const { filterVolumesByInstallment } = require("./utils/manifest");
const { ON_VOLUME_ERROR, validateRequiredEnv, resolveRunSettings, isStructuralError } = require("./configs/shared");
const { fileExists } = require("./utils/fs");
const { resolveSourceBundle } = require("./utils/source");
const { writePromptDump } = require("./utils/prompt");
const {
  sha256,
  splitChapter,
  buildTranslationTaskLines,
  buildTranslationPrompt,
  checkTranslationQa,
  stripMarkdownFence,
  tailOf,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  stripContinuityOverlap,
  runWithConcurrency,
  stageConcurrency,
} = require("./utils/translate");
const {
  chapterArtifactNames,
  mergeVolumeTranslationFiles,
  translateThinkingMode,
  translateSampling,
  translateChunkChars,
  translateContinuityChars,
} = require("./translate");
const { loadVerificationSidecar } = require("./verify-translate");

// ─── Paths & config ──────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const translateTemplateFile = path.join(clientDir, "user-prompts", "translate.md");

/** Verification is default-ON — retranslate is its correction pass. */
const verifyEnabled = process.env.VERIFY_TRANSLATE_ENABLED !== "false";
/** Chapter concurrency within a volume (opt-in; default 1 = serial — the
 *  local hardware runs one inference at a time). */
const retranslateConcurrency = stageConcurrency("RETRANSLATE");
/** Findings injected into the retranslate prompt (bounded — they are a
 *  numbered correction task, not a document to re-read). */
const RETRANSLATE_FINDINGS_CHARS = 3000;
/** Same splitting/continuity budget as the translate stage. */
const chunkChars = translateChunkChars();
const continuityChars = translateContinuityChars();
/** (#6) How many times a chapter may be retranslated against an IDENTICAL set
 *  of verification findings before the stall guard skips it. Default 2 = the
 *  single retranslate plus one extra fresh stochastic shot (the translator runs
 *  at temp 0.7, so a repeat can succeed). Set 1 to restore retranslate-once. */
const retranslateRetryBudget = Math.max(
  1,
  parseInt(process.env.TRANSLATE_QA_RETRY_BUDGET, 10) || 2
);

/**
 * Read the previous chapter's current draft ending to seed this chapter's
 * first-part continuity context (so a retranslated chapter still flows from
 * the one before it — the first-pass translate stage chains chapters this way,
 * and a standalone retranslate would otherwise leave a seam). Returns "" when
 * there is no previous chapter or no draft on disk (both fine — the tail is a
 * soft style cue, not a hard dependency).
 *
 * @param {{segments: Array<{id: string}>}} bundle
 * @param {string} segId - The id of the chapter being retranslated.
 * @param {string} volumeDir
 * @param {number} chars - How many chars of the ending to keep.
 * @returns {Promise<string>} The previous chapter's ending (or "").
 */
async function prevChapterContinuityTail(bundle, segId, volumeDir, chars) {
  const idx = bundle.segments.findIndex((s) => s.id === segId);
  if (idx <= 0 || chars <= 0) return "";
  const { draftFile } = chapterArtifactNames(bundle.segments[idx - 1].id);
  let prevDraft = "";
  try {
    prevDraft = await fs.readFile(path.join(volumeDir, draftFile), "utf8");
  } catch {
    prevDraft = "";
  }
  if (!prevDraft.trim()) return "";
  return tailOf(prevDraft, chars);
}

// ─── Per-volume processing ──────────────────────────────────────────────────

/**
 * Retranslate one volume's failed chapters.
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
 * }} ctx
 * @returns {Promise<{retranslated: number, skipped: number, none: number}>}
 */
async function processRetranslateVolume(ctx) {
  const { volume, volumeDir, bundle, refs, template, endpoint, sampling, thinkingMode, dryRun, force, targetLanguage } = ctx;
  const sidecar = await loadVerificationSidecar(path.join(volumeDir, "translation-verification.json"));
  const state = await loadTranslationState(path.join(volumeDir, "translation-state.json"));
  let retranslated = 0;
  let skipped = 0;
  let none = 0;

  // Chapters are INDEPENDENT here (each is retranslated from its own source
  // + findings — no cross-chapter chaining), so they can run in parallel
  // when STAGE_CONCURRENCY > 1.
  await runWithConcurrency(bundle.segments, retranslateConcurrency, async (seg) => {
    const { draftFile, polishedFile } = chapterArtifactNames(seg.id);
    const chapterPath = path.join(volumeDir, seg.file);
    const draftPath = path.join(volumeDir, draftFile);
    const vEntry = sidecar.chapters[seg.id] || {};

    // Nothing to do for this chapter: no verification, or it passed.
    if (!vEntry || typeof vEntry.pass !== "boolean") {
      none += 1;
      return;
    }
    if (vEntry.pass) {
      skipped += 1;
      return;
    }

    // The verification must cover the CURRENT draft — a stale entry means
    // the draft changed since (re-verify first, don't guess).
    if (!(await fileExists(draftPath))) {
      none += 1;
      return;
    }
    const sourceText = await fs.readFile(chapterPath, "utf8");
    const draft = await fs.readFile(draftPath, "utf8");
    const sourceHash = sha256(sourceText);
    const draftHash = sha256(draft);
    // Only the glossary terms this chapter actually contains go into the prompt.
    const chapterTerms = chapterTerminology(refs, sourceText);
    if (vEntry.sourceHash !== sourceHash || vEntry.draftHash !== draftHash) {
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: verification is stale for the current draft — ` +
          `skipping (run verify-translate first).`
      );
      none += 1;
      return;
    }

    const findings = (vEntry.findings || "").slice(0, RETRANSLATE_FINDINGS_CHARS);
    const sEntry = state.chapters[seg.id] || {};
    const findingsHashNow = sha256(vEntry.findings || "");
    const sameFindings =
      typeof sEntry.findingsHash === "string" && sEntry.findingsHash === findingsHashNow;
    // (#6) Retry budget: a chapter may be retranslated up to
    // `retranslateRetryBudget` times against an IDENTICAL set of verification
    // findings before the stall guard skips it. The extra shots matter because
    // the translator is stochastic (temp 0.7) — same findings ≠ same outcome.
    // A DIFFERENT findings set resets the budget. Cross-run re-runs stay cheap:
    // once the budget is spent on these findings, a plain re-run skips.
    const attemptsUsed = sameFindings ? (sEntry.retranslateAttempts ?? 1) : 0;
    const alreadyDone =
      !force &&
      sEntry.retranslated === true &&
      sEntry.sourceHash === sourceHash &&
      sameFindings &&
      attemptsUsed >= retranslateRetryBudget;
    if (alreadyDone) {
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: already retranslated for these findings ` +
          `(${attemptsUsed}×, budget ${retranslateRetryBudget}) — skipping.`
      );
      skipped += 1;
      return;
    }

    const findingsTask =
      findings ||
      "(no findings text — the verification score was unparseable; translate the source faithfully)";

    // Same part-by-part shape as the translate stage: oversized chapters are
    // split (TRANSLATE_CHUNK_CHARS), each part continues the previous one
    // (TRANSLATE_CONTINUITY_CHARS), and the findings — chapter-wide
    // correction tasks — are injected into every part.
    const parts = splitChapter(sourceText, chunkChars);
    if (dryRun) {
      // Dump the first part's prompt for every applicable chapter (one file
      // per chapter, no AI calls in dry-run) — the later parts differ only
      // in the source part and the continuity tail.
      const tasks = buildTranslationTaskLines({
        terminologyLines: chapterTerms.lines,
        background: refs.background,
        styleRules: refs.styleRules,
        continuityText: "(the previous part's ending would go here)",
        findingsText: findingsTask,
        targetLanguage,
      });
      const prompt = buildTranslationPrompt({ template, sourceText: parts[0], tasks });
      const file = await writePromptDump(
        `retranslate-${volume.installmentNumber}-${seg.id}`,
        volume.installmentNumber,
        "one-shot (no system prompt — Hy-MT2 contract)",
        [
          {
            title:
              `One-shot — retranslate ${seg.id} part 1/${parts.length} (score ${
                vEntry.score === null ? "n/a" : vEntry.score + "/100"
              }) (endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${thinkingMode})`,
            prompt,
          },
        ]
      );
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: --dry-run prompt dump → ${file}`);
      return;
    }

    const partTexts = [];
    // (#7) Seed the first part's continuity from the previous chapter's
    // CURRENT draft ending (the translate stage chains chapters this way).
    let continuity = await prevChapterContinuityTail(bundle, seg.id, volumeDir, continuityChars);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const tasks = buildTranslationTaskLines({
        terminologyLines: chapterTerms.lines,
        background: refs.background,
        styleRules: refs.styleRules,
        continuityText: continuity || undefined,
        findingsText: findingsTask,
        targetLanguage,
      });
      const prompt = buildTranslationPrompt({ template, sourceText: part, tasks });
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: retranslating part ${i + 1}/${parts.length} ` +
          `(${part.length} chars) with ${endpoint.model}…`
      );
      const result = await harness.runOneShot({
        systemPrompt: null, // Hy-MT2: single user message, no system prompt.
        messages: [{ text: prompt }],
        endpoint,
        temperature: sampling.temperature,
        sampling: {
          topP: sampling.topP,
          topK: sampling.topK,
          repetitionPenalty: sampling.repetitionPenalty,
        },
        thinking: thinkingMode,
        thinkingTemplate: "hy-mt",
        label: `retranslate-v${volume.installmentNumber}-${seg.id}-${parts.length > 1 ? "part" + (i + 1) : "full"}`,
      });
      const cleanPart = stripMarkdownFence(result);
      if (!cleanPart) {
        throw new Error(
          `Volume ${volume.installmentNumber} ${seg.id}: the model returned no content for ` +
            `part ${i + 1}. Check .logs/ and re-run.`
        );
      }
      // Continuity dedup (same backstop as the translate stage): when the
      // model repeats the previous part's ending at the start of its reply,
      // strip the duplicated prefix from the merged draft.
      const deduped = i > 0 ? stripContinuityOverlap(partTexts[i - 1], cleanPart) : cleanPart;
      partTexts.push(deduped);
      continuity = tailOf(deduped, continuityChars);
    }
    const clean = partTexts.join("\n\n");
    const qa = checkTranslationQa({ sourceText, draftText: clean, terms: refs.terms });
    if (!qa.ok) {
      throw new Error(
        `Volume ${volume.installmentNumber} ${seg.id}: retranslation QA failed: ${qa.errors.join("; ")}. ` +
          `The old draft is kept — check .logs/ and re-run.`
      );
    }

    await fs.writeFile(draftPath, clean + "\n", "utf8");
    state.chapters[seg.id] = {
      sourceHash,
      contextHash: refs.contextHash,
      // Hash of the FILE content as written (with trailing newline) — the
      // skip-checks elsewhere compare against the on-disk file.
      draftHash: sha256(clean + "\n"),
      retranslated: true,
      findingsHash: findingsHashNow,
      // (#6) How many times this chapter has been retranslated against THIS
      // findings set (resets when the findings change) — the stall guard's
      // retry budget.
      retranslateAttempts: (sameFindings ? (sEntry.retranslateAttempts ?? 1) : 0) + 1,
      polishedDraftHash: null,
    };
    await fs.rm(path.join(volumeDir, polishedFile), { force: true });
    await saveTranslationState(path.join(volumeDir, "translation-state.json"), state);
    retranslated += 1;
    if (qa.warnings.length > 0) {
      console.warn(`  Volume ${volume.installmentNumber} ${seg.id}: QA warning: ${qa.warnings.join("; ")}`);
    }
  });

  // Re-merge the volume (drafts changed; the stale polished files were dropped).
  const mergedText = await mergeVolumeTranslationFiles(volumeDir, bundle, state);
  if (mergedText) {
    await fs.writeFile(path.join(volumeDir, "translation.md"), mergedText, "utf8");
  }
  return { retranslated, skipped, none };
}

// ─── Task entry ─────────────────────────────────────────────────────────────

/**
 * Run the retranslate task (all volumes, or --volume NN).
 *
 * Returns the aggregated run summary — the translate-qa loop reads
 * `retranslated` for its stall guard. (A volume that fails the run under
 * ON_VOLUME_ERROR=skip still throws, as before.)
 *
 * @returns {Promise<{retranslated: number, skipped: number, none: number}>}
 */
async function retranslate() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

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
  if (!dryRun) {
    await harness.assertModelServing({ ...endpoint, label: "retranslate stage" });
  }

  const template = await fs.readFile(translateTemplateFile, "utf-8");

  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
  // The target language the correction prompt is written for: .env override >
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

  console.log(
    `[retranslate] ${sorted.length} volume folder(s); endpoint ${endpoint.model} @ ${endpoint.baseUrl} ` +
      `(model from ${endpoint.modelSource}, base from ${endpoint.baseUrlSource}); ` +
      `thinking=${thinkingMode}; concurrency=${retranslateConcurrency}.`
  );

  const failedVolumes = [];
  let totalRetranslated = 0;
  let totalSkipped = 0;
  let totalNone = 0;

  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
      const refs = await loadVolumeReferences(volumeDir);
      const result = await processRetranslateVolume({
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
      });
      totalRetranslated += result.retranslated;
      totalSkipped += result.skipped;
      totalNone += result.none;
      console.log(
        `[retranslate] Volume ${volume.installmentNumber}: ${result.retranslated} retranslated, ` +
          `${result.skipped} skipped, ${result.none} not applicable.`
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

  console.log(
    `[retranslate] Done: ${totalRetranslated} chapter(s) retranslated, ${totalSkipped} skipped. ` +
      `Re-run verify-translate to re-score the retranslated chapters.`
  );
  if (failedVolumes.length > 0) {
    throw new Error(
      `${failedVolumes.length} of ${volumes.length} volume(s) failed: ${failedVolumes.join(", ")}.`
    );
  }
  return {
    retranslated: totalRetranslated,
    skipped: totalSkipped,
    none: totalNone,
  };
}

module.exports = {
  retranslate,
  processRetranslateVolume,
};
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
const { ON_VOLUME_ERROR, PASSING_SCORE, validateRequiredEnv, resolveRunSettings, isStructuralError, volumeFailureError, readBoolEnv } = require("./configs/shared");
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
  describeEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  stripContinuityOverlap,
  buildBudgetedTaskLines,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  runWithConcurrency,
  stageConcurrency,
  loadVerificationSidecar,
  readFileOrEmpty,
  worthRetranslating,
  previousVolumeTail,
  loadVolumeConsistency,
  findingsForChapter,
  paragraphBlocks,
  planTargetedRepair,
  stitchParagraphs,
  buildPassageScopeLine,
  volumeFindingsText,
  planChapterSplit,
  translateChunkCap,
  outputRatioFor,
  thinkingOutputFactor,
  measureOutputRatio,
  estimateTokens,
  retranslateTarget,
  chapterContextHash,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
  MERGED_FILE,
} = require("./utils/translate");
const {
  chapterArtifactNames,
  mergeVolumeTranslationFiles,
  translateThinkingMode,
  translateSampling,
  translateChunkChars,
  translateContinuityChars,
} = require("./translate");

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
/** Same continuity budget as the translate stage; the part SIZE is planned in
 *  tokens per chapter (see planChapterSplit), not by one character constant. */
const continuityChars = translateContinuityChars();
/** (#6) How many times a chapter may be retranslated against an IDENTICAL set
 *  of verification findings before the stall guard skips it. Default 2 = the
 *  single retranslate plus one extra fresh stochastic shot (the translator runs
 *  at temp 0.7, so a repeat can succeed). Set 1 to restore retranslate-once. */
const retranslateRetryBudget = Math.max(
  1,
  parseInt(process.env.TRANSLATE_QA_RETRY_BUDGET, 10) || 2
);
/** How far below the passing line a chapter must sit before a whole-chapter
 *  rewrite is worth it when the findings are only MEDIUM/LOW (see
 *  worthRetranslating). Default 5. */
const retranslateValueMargin = Math.max(
  0,
  parseInt(process.env.TRANSLATE_RETRANSLATE_VALUE_MARGIN, 10) || 5
);
/**
 * Targeted correction (DEFAULT-ON): when the verification findings quote spans
 * that can be located in the source, re-translate ONLY those passages and
 * stitch the corrected text back into the draft.
 *
 * The whole-chapter pass is the blunt instrument: one bad sentence costs a full
 * chapter of generation and a fresh chance to break something that was already
 * right. The findings quote short source spans, so the spans can be found, and
 * `planTargetedRepair` refuses the shortcut whenever the source↔draft mapping is
 * not trustworthy (paragraph counts disagree, a quote cannot be found, the
 * affected span covers the chapter, or a draft paragraph is not a plausible
 * rendering of its source paragraph) — in which case the chapter gets the whole
 * pass it always got.
 *
 * Set TRANSLATE_TARGETED_FIX=false to always rewrite whole chapters.
 */
const targetedFixEnabled = readBoolEnv("TRANSLATE_TARGETED_FIX", true);
/** Draft paragraphs of the surrounding translated text given to a passage pass
 *  on each side, so names / tense / voice match at the seams. */
const TARGETED_CONTEXT_BLOCKS = 2;

/**
 * Snapshot every chapter's continuity tail BEFORE the (possibly concurrent)
 * retranslate batch starts.
 *
 * The tail is the previous chapter's ending, used as a flow cue. Reading it
 * lazily inside the batch means a chapter can read a neighbour's draft while
 * that neighbour is mid-rewrite — the cue then depends on worker scheduling
 * (with STAGE_CONCURRENCY > 1 it is a genuine race, and with concurrency 1 it
 * only works by accident). Snapshotting once makes the whole batch see the same
 * book, and the batch's own output is deliberately not fed back into it.
 *
 * @param {{segments: Array<{id: string}>}} bundle
 * @param {string} volumeDir
 * @param {number} chars - How many chars of each ending to keep.
 * @param {{text: string, fromLabel: string}} [incomingTail] - The previous VOLUME's published ending (for the first chapter).
 * @returns {Promise<Map<string, {text: string, source: string}>>} segment id → the cue text and an honest label of where it came from.
 */
async function snapshotContinuityTails(bundle, volumeDir, chars, incomingTail) {
  const tails = new Map();
  if (chars <= 0) return tails;
  for (let idx = 0; idx < bundle.segments.length; idx++) {
    if (idx === 0) {
      // The volume's first chapter continues from the previous VOLUME's ending
      // (when one is available) — not from nothing.
      tails.set(bundle.segments[idx].id, {
        text: incomingTail && incomingTail.text ? incomingTail.text : "",
        source: incomingTail && incomingTail.text
          ? `the end of the previous volume (${incomingTail.fromLabel || "the previous volume"})`
          : "",
      });
      continue;
    }
    const { draftFile } = chapterArtifactNames(bundle.segments[idx - 1].id);
    let prevDraft = "";
    try {
      prevDraft = await fs.readFile(path.join(volumeDir, draftFile), "utf8");
    } catch {
      prevDraft = "";
    }
    tails.set(bundle.segments[idx].id, {
      text: prevDraft.trim() ? tailOf(prevDraft, chars) : "",
      source: prevDraft.trim() ? `the previous chapter (${bundle.segments[idx - 1].id})` : "",
    });
  }
  return tails;
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
 * @returns {Promise<{retranslated: number, skipped: number, none: number, deferred: number}>}
 */
/**
 * Re-translate ONLY the passages the verification findings point at, and stitch
 * the corrected text back into the chapter's existing draft.
 *
 * Returns null when the passage pass cannot be trusted or produced nothing, in
 * which case the caller runs the whole-chapter pass it always ran. The caller
 * also re-runs the deterministic QA on the STITCHED chapter, so a repair that
 * breaks the seams (or duplicates a paragraph) is caught before it becomes the
 * draft.
 *
 * @param {{
 *   volume: {installmentNumber: string},
 *   seg: {id: string},
 *   plan: {blocks: Array<{start: number, end: number, findings: string[]}>},
 *   sourceText: string,
 *   draft: string,
 *   endpoint: Object,
 *   template: string,
 *   sampling: Object,
 *   thinkingMode: string,
 *   roleWindow: number,
 *   outputReserve: number,
 *   targetLanguage: string,
 *   refs: Object,
 *   chapterTerms: {lines: string[]},
 *   cue: {text: string, source: string},
 *   promptDrops: Array<Object>,
 * }} ctx
 * @returns {Promise<string|null>} The stitched draft, or null to fall back.
 */
async function runTargetedRepair({
  volume,
  seg,
  plan,
  sourceText,
  draft,
  endpoint,
  template,
  sampling,
  thinkingMode,
  roleWindow,
  outputReserve,
  targetLanguage,
  refs,
  chapterTerms,
  cue,
  promptDrops,
}) {
  const sourceBlocks = paragraphBlocks(sourceText);
  const draftBlocks = paragraphBlocks(draft);
  const replacements = [];

  for (const [bi, block] of plan.blocks.entries()) {
    const srcSpan = sourceBlocks.slice(block.start, block.end + 1).join("\n\n");
    const before = draftBlocks
      .slice(Math.max(0, block.start - TARGETED_CONTEXT_BLOCKS), block.start)
      .join("\n\n");
    const after = draftBlocks
      .slice(block.end + 1, block.end + 1 + TARGETED_CONTEXT_BLOCKS)
      .join("\n\n");
    // Only the findings whose quoted span lives in THIS passage — plus the
    // chapter-wide ones planTargetedRepair could not locate. Injecting a
    // finding about paragraph 7 into the pass that rewrites paragraph 2 invites
    // the model to "fix" it in the wrong place.
    const blockFindings = (block.findings || []).filter((t) => t && t.trim()).join("\n\n");
    const findingsText =
      blockFindings || "(no passage-specific findings — translate the source faithfully)";
    const scopeText = buildPassageScopeLine({
      before,
      after,
      blockNumber: bi + 1,
      blockCount: plan.blocks.length,
    });

    const { tasks, dropped } = buildBudgetedTaskLines({
      terminologyLines: chapterTerms.lines,
      background: refs.background,
      styleRules: refs.styleRules,
      voiceNotes: refs.voiceNotes,
      continuityText: cue.text || undefined,
      continuitySource: cue.source || "the previous chapter",
      findingsText,
      scopeText,
      sourceText: srcSpan,
      template,
      roleWindow,
      outputReserve,
      targetLanguage,
      label: `Volume ${volume.installmentNumber} ${seg.id} passage ${bi + 1}`,
    });
    if (dropped.length > 0) promptDrops.push({ id: seg.id, part: `passage ${bi + 1}`, dropped });

    const prompt = buildTranslationPrompt({ template, sourceText: srcSpan, tasks });
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: repairing passage ${bi + 1}/${plan.blocks.length} ` +
        `(source paragraphs ${block.start + 1}–${block.end + 1}, ${srcSpan.length} chars) with ${endpoint.model}…`
    );
    const result = await harness.runOneShot({
      systemPrompt: null, // Hy-MT2: single user message, no system prompt.
      messages: [{ text: prompt }],
      endpoint,
      maxTokens: endpoint.maxTokens,
      contextWindow: endpoint.contextWindow,
      temperature: sampling.temperature,
      sampling: {
        topP: sampling.topP,
        topK: sampling.topK,
        repetitionPenalty: sampling.repetitionPenalty,
      },
      thinking: thinkingMode,
      thinkingTemplate: "hy-mt",
      label: `retranslate-v${volume.installmentNumber}-${seg.id}-passage${bi + 1}`,
    });
    const text = stripMarkdownFence(result);
    if (!text) {
      console.warn(
        `  Volume ${volume.installmentNumber} ${seg.id}: the passage pass returned no content — ` +
          `falling back to the whole-chapter rewrite.`
      );
      return null;
    }
    replacements.push(text);
  }

  try {
    return stitchParagraphs(draftBlocks, plan.blocks, replacements);
  } catch (err) {
    console.warn(
      `  Volume ${volume.installmentNumber} ${seg.id}: the passage repair could not be stitched ` +
        `(${err.message}) — falling back to the whole-chapter rewrite.`
    );
    return null;
  }
}

async function processRetranslateVolume(ctx) {
  const { volume, volumeDir, bundle, refs, template, endpoint, sampling, thinkingMode, dryRun, force, targetLanguage, sourceLanguage } = ctx;
  const sidecar = await loadVerificationSidecar(path.join(volumeDir, "translation-verification.json"));
  const state = await loadTranslationState(path.join(volumeDir, "translation-state.json"));
  // The cross-chapter audit's findings (volume-consistency.json). A chapter can
  // pass its own source-anchored check at 92/100 and still contradict the
  // chapter before it — the per-chapter verifier structurally cannot see that,
  // so the volume pass's HIGH findings are a repair target of their own.
  const consistency = await loadVolumeConsistency(volumeDir);
  const consistencyFindings = consistency.findings || [];
  let retranslated = 0;
  let skipped = 0;
  let none = 0;
  let deferred = 0;
  let crossChapter = 0;
  // The context budget for this role (see the translate task's identical block):
  // every injected reference block is fitted into it, and every drop is logged.
  const roleWindow = endpoint.contextWindow || harness.envContextWindow();
  const outputReserve = endpoint.maxTokens || harness.envMaxTokens();
  const promptDrops = [];

  // Chapter parts are planned in tokens, the same rule the translate task uses
  // (see planChapterSplit) — the two tasks must not disagree about how a chapter
  // is cut up, or a retranslate would produce a differently-shaped chapter than
  // the one verify graded.
  const chunkCap = translateChunkCap();
  const measuredRatio = await measureOutputRatio(ctx.previousVolumeDirs || [], {
    sourceLanguage,
    targetLanguage,
  });
  const outputRatio = measuredRatio.ratio ?? outputRatioFor(sourceLanguage, targetLanguage);
  const thinkingFactor = thinkingOutputFactor(thinkingMode);
  /**
   * Split one chapter by the token plan (character rule only as the fallback).
   * @param {string} text
   * @param {{continuityText?: string, terminologyLines?: string[], findingsText?: string}} [carry]
   * @returns {{parts: string[], plan: Object}}
   */
  const splitChapterFor = (text, { continuityText = "", terminologyLines = [], findingsText = "" } = {}) => {
    const plan = planChapterSplit({
      sourceText: text,
      referenceTokens:
        estimateTokens(terminologyLines.join("\n")) +
        estimateTokens(refs.background || "") +
        estimateTokens(refs.styleRules || "") +
        estimateTokens(refs.voiceNotes || "") +
        estimateTokens(continuityText),
      findingsTokens: estimateTokens(findingsText),
      instructionsTokens: estimateTokens(template) + 400,
      roleWindow,
      outputReserve,
      outputRatio,
      thinkingFactor,
      hardCapChars: chunkCap,
    });
    const limit = plan.maxChars > 0 ? plan.maxChars : translateChunkChars();
    return { parts: splitChapter(text, limit), plan };
  };

  // Chapters are INDEPENDENT here (each is retranslated from its own source
  // + findings — no cross-chapter chaining), so they can run in parallel
  // when STAGE_CONCURRENCY > 1. The continuity cues are snapshotted first so
  // every worker sees the same book (see snapshotContinuityTails).
  const continuityTails = await snapshotContinuityTails(
    bundle,
    volumeDir,
    continuityChars,
    ctx.incomingTail
  );
  await runWithConcurrency(bundle.segments, retranslateConcurrency, async (seg) => {
    const { draftFile, polishedFile, rejectedFile } = chapterArtifactNames(seg.id);
    const chapterPath = path.join(volumeDir, seg.file);
    const draftPath = path.join(volumeDir, draftFile);
    const vEntry = sidecar.chapters[seg.id] || {};
    const volumeFindings = findingsForChapter(consistencyFindings, seg.id);
    const target = retranslateTarget(vEntry, volumeFindings);

    // Nothing to do for this chapter: no verification covering this draft.
    if (target.action === "none") {
      none += 1;
      return;
    }
    if (target.action === "skip") {
      skipped += 1;
      return;
    }
    const isCrossChapterRepair = target.action === "cross-chapter";
    if (isCrossChapterRepair) {
      crossChapter += 1;
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: verification PASSED (${vEntry.score}/100) but the ` +
          `volume audit found ${target.reason} — repairing this chapter against its neighbours.`
      );
    }

    // Value filter: a retranslate throws away a whole chapter and re-derives it
    // to fix what may be one awkward sentence. Worth it for a meaning /
    // terminology problem; a bad trade for a cosmetic one (the fresh pass can
    // introduce new errors while fixing a nit, and it costs a full chapter of
    // generation). Deferred chapters are counted and logged — never dropped in
    // silence; their findings stay in the verification report. A cross-chapter
    // repair is never filtered: a HIGH finding there is a contradiction, not a nit.
    if (!isCrossChapterRepair && !worthRetranslating(vEntry, PASSING_SCORE)) {
      deferred += 1;
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: FAIL at ${vEntry.score}/100 with no HIGH finding ` +
          `and within ${retranslateValueMargin} of the passing line — not worth a whole-chapter rewrite. ` +
          `Left as-is; the findings stay in ${VERIFICATION_REPORT}.`
      );
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

    const ownFindings = (vEntry.findings || "").slice(0, RETRANSLATE_FINDINGS_CHARS);
    // The volume audit's findings for this chapter, appended as correction tasks.
    // A contradiction has two sides; the prompt tells the model to change only
    // the text it is given, or the "fix" moves the contradiction to another
    // chapter instead of resolving it.
    const crossFindings = volumeFindingsText(volumeFindings);
    const findings = [ownFindings, crossFindings].filter((t) => t.trim()).join("\n\n");
    const sEntry = state.chapters[seg.id] || {};
    const findingsHashNow = sha256(
      `${vEntry.findings || ""}\n\u0000${consistency.findingsHash || ""}|${seg.id}`
    );
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
    // (#7) Seed the first part's continuity from the previous chapter's
    // CURRENT draft ending (the translate stage chains chapters this way).
    const cue = continuityTails.get(seg.id) || { text: "", source: "" };
    const { parts, plan } = splitChapterFor(sourceText, {
      continuityText: cue.text,
      terminologyLines: chapterTerms.lines,
      findingsText: findingsTask,
    });
    if (parts.length > 1) {
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: split into ${parts.length} part(s) — ${plan.reason}.`
      );
    }
    if (dryRun) {
      // Dump the first part's prompt for every applicable chapter (one file
      // per chapter, no AI calls in dry-run) — the later parts differ only
      // in the source part and the continuity tail.
      const { tasks } = buildBudgetedTaskLines({
        terminologyLines: chapterTerms.lines,
        background: refs.background,
        styleRules: refs.styleRules,
        voiceNotes: refs.voiceNotes,
        continuityText: cue.text || "(the previous part's ending would go here)",
        continuitySource: cue.source || "the previous chapter",
        findingsText: findingsTask,
        sourceText: parts[0],
        template,
        roleWindow,
        outputReserve,
        targetLanguage,
        label: `Volume ${volume.installmentNumber} ${seg.id}`,
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

    // ── Targeted correction: repair only the passages the findings point at ──
    // The whole-chapter pass below stays the fallback for every case the
    // mapping cannot be trusted for (see planTargetedRepair). An oversized
    // chapter is already being rewritten in parts, so the passage shortcut does
    // not apply to it.
    let clean = null;
    let repairKind = "whole chapter";
    if (targetedFixEnabled && parts.length === 1) {
      const plan = planTargetedRepair({ sourceText, draftText: draft, findingsText: findingsTask });
      if (plan.usable) {
        const stitched = await runTargetedRepair({
          volume,
          seg,
          plan,
          sourceText,
          draft,
          endpoint,
          template,
          sampling,
          thinkingMode,
          roleWindow,
          outputReserve,
          targetLanguage,
          refs,
          chapterTerms,
          cue,
          promptDrops,
        });
        if (stitched) {
          clean = stitched;
          repairKind = `targeted repair — ${plan.reason}`;
        }
      } else {
        console.log(
          `  Volume ${volume.installmentNumber} ${seg.id}: whole-chapter rewrite (${plan.reason}).`
        );
      }
    }

    // The whole-chapter pass the shortcut above replaces — unchanged behaviour:
    // an oversized chapter still goes through it part by part.
    const wholeChapterPass = async () => {
      const partTexts = [];
      let continuity = cue.text;
      for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const { tasks, dropped: partDrops } = buildBudgetedTaskLines({
        terminologyLines: chapterTerms.lines,
        background: refs.background,
        styleRules: refs.styleRules,
        voiceNotes: refs.voiceNotes,
        continuityText: continuity || undefined,
        continuitySource: cue.source || "the previous chapter",
        findingsText: findingsTask,
        sourceText: part,
        template,
        roleWindow,
        outputReserve,
        targetLanguage,
        label: `Volume ${volume.installmentNumber} ${seg.id} part ${i + 1}`,
      });
      if (partDrops.length > 0) promptDrops.push({ id: seg.id, part: i + 1, dropped: partDrops });
      const prompt = buildTranslationPrompt({ template, sourceText: part, tasks });
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: retranslating part ${i + 1}/${parts.length} ` +
          `(${part.length} chars) with ${endpoint.model}…`
      );
      const result = await harness.runOneShot({
        systemPrompt: null, // Hy-MT2: single user message, no system prompt.
        messages: [{ text: prompt }],
        endpoint,
        // The role endpoint's own output cap / context window (harness.js derives
        // them from the global AI_* settings when the role sets neither).
        maxTokens: endpoint.maxTokens,
        contextWindow: endpoint.contextWindow,
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
      return partTexts.join("\n\n");
    };

    if (!clean) clean = await wholeChapterPass();

    let qa = checkTranslationQa({ sourceText, draftText: clean, terms: refs.terms, sourceLanguage, targetLanguage });
    if (!qa.ok && repairKind !== "whole chapter") {
      // The passage repair broke something the no-AI checks can see (source-script
      // residue, truncation, lost terminology). Quarantine it and run the
      // whole-chapter pass it replaced — a shortcut that makes a chapter worse
      // is not allowed to become the draft.
      const passageRejected = rejectedFile.replace(/\.md$/, ".passage.md");
      console.warn(
        `  Volume ${volume.installmentNumber} ${seg.id}: the passage repair failed the deterministic QA ` +
          `(${qa.errors.join("; ")}) — quarantined to ${passageRejected}, rewriting the whole chapter.`
      );
      await fs.writeFile(path.join(volumeDir, passageRejected), clean + "\n", "utf8");
      clean = await wholeChapterPass();
      repairKind = "whole chapter (the passage repair failed the QA)";
      qa = checkTranslationQa({ sourceText, draftText: clean, terms: refs.terms, sourceLanguage, targetLanguage });
    }
    if (!qa.ok) {
      // Quarantine the rejected correction instead of discarding it: the reason
      // stays on disk, and the chapter keeps the draft it had (the ratchet's
      // baseline is untouched).
      await fs.writeFile(path.join(volumeDir, rejectedFile), clean + "\n", "utf8");
      throw new Error(
        `Volume ${volume.installmentNumber} ${seg.id}: retranslation QA failed: ${qa.errors.join("; ")}. ` +
          `The correction was quarantined to ${rejectedFile} and the previous draft is kept — ` +
          `check .logs/ and re-run.`
      );
    }

    await fs.writeFile(draftPath, clean + "\n", "utf8");
    state.chapters[seg.id] = {
      sourceHash,
      contextHash: refs.contextHash,
      chapterContextHash: chapterContextHash(refs, sourceText),
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
      // A successful retranslation is a real draft: the QA-failure marker goes.
      qaFailed: false,
      // The ratchet baseline SURVIVES a retranslate — that is the whole point:
      // if this new draft scores worse than the best one we already had, the
      // loop rolls back to it instead of publishing the regression.
      bestScore: sEntry.bestScore ?? null,
      bestDraftHash: sEntry.bestDraftHash ?? null,
      bestVerdict: sEntry.bestVerdict ?? null,
      // HOW the chapter was repaired (a whole rewrite or a stitched passage
      // repair) — so a report can tell a cheap fix from an expensive one.
      repairKind,
    };
    await fs.rm(path.join(volumeDir, polishedFile), { force: true });
    await fs.rm(path.join(volumeDir, rejectedFile), { force: true });
    await fs.rm(path.join(volumeDir, rejectedFile.replace(/\.md$/, ".passage.md")), { force: true });
    await saveTranslationState(path.join(volumeDir, "translation-state.json"), state);
    retranslated += 1;
    console.log(`  Volume ${volume.installmentNumber} ${seg.id}: repaired — ${repairKind}.`);
    if (qa.warnings.length > 0) {
      console.warn(`  Volume ${volume.installmentNumber} ${seg.id}: QA warning: ${qa.warnings.join("; ")}`);
    }
  });

  // Re-merge the volume (drafts changed; the stale polished files were dropped).
  const merged = await mergeVolumeTranslationFiles(volumeDir, bundle, state, {
    sourceLanguage,
    targetLanguage,
  });
  if (merged.text) {
    await fs.writeFile(path.join(volumeDir, MERGED_FILE), merged.text, "utf8");
  }
  if (merged.missing.length > 0) {
    console.error(
      `  Volume ${volume.installmentNumber}: still incomplete after retranslation — ` +
        `${merged.missing.map((m) => m.id).join(", ")}.`
    );
  }
  if (promptDrops.length > 0) {
    console.warn(
      `  Volume ${volume.installmentNumber}: ${promptDrops.length} chapter-part(s) had reference material ` +
        `dropped to fit the ${roleWindow}-token context window (see the log lines above).`
    );
  }
  return { retranslated, skipped, none, deferred, crossChapter, missing: merged.missing, promptDrops };
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
    `[retranslate] ${sorted.length} volume folder(s); endpoint ${describeEndpoint(endpoint)}; ` +
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

  const failedVolumes = [];
  let totalRetranslated = 0;
  let totalSkipped = 0;
  let totalNone = 0;
  let totalDeferred = 0;
  let totalCrossChapter = 0;

  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
      // The retranslator runs on the TRANSLATE_* role, which is a different
      // model from the verifier that just graded it — re-point the estimate
      // before the prompt budget is computed (cached per endpoint).
      await calibrateStageTokens({ endpoint, bundle, label: "retranslate stage", dryRun });
      // The handoff's chapter list and the extracted one must describe the same
      // book (see checkChapterListConsistency). A disagreement is reported, not
      // fatal: the extracted list is the one this stage uses.
      await checkChapterListConsistency(volumeDir, bundle);
      // The volume's own text decides WHICH sections of the cumulative
      // references get injected (see loadVolumeReferences): a 17-volume series
      // must show the translator the state and cast that matter to THIS book.
      const volumeSourceText = await readFileOrEmpty(bundle.wholePath || path.join(volumeDir, bundle.segments[0].file));
      const refs = await loadVolumeReferences(volumeDir, volumeSourceText);
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
        sourceLanguage: runSettings.sourceLanguage,
        // The first chapter of a volume continues from the previous volume's
        // published ending (same cue the translate stage uses).
        incomingTail: await previousVolumeTail(seriesDir, manifest, folderName, continuityChars),
        // The volumes before this one — where the measured output ratio comes from.
        previousVolumeDirs: manifest.volumes
          .slice(0, manifest.volumes.findIndex((v) => v.folder === folderName))
          .map((v) => path.join(seriesDir, v.folder)),
      });
      totalRetranslated += result.retranslated;
      totalSkipped += result.skipped;
      totalNone += result.none;
      totalDeferred += result.deferred;
      totalCrossChapter += result.crossChapter || 0;
      console.log(
        `[retranslate] Volume ${volume.installmentNumber}: ${result.retranslated} retranslated, ` +
          `${result.skipped} skipped, ${result.none} not applicable` +
          (result.deferred > 0 ? `, ${result.deferred} deferred (cosmetic findings only)` : "") +
          `.`
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
    `[retranslate] Done: ${totalRetranslated} chapter(s) retranslated, ${totalSkipped} skipped` +
      (totalDeferred > 0 ? `, ${totalDeferred} deferred (cosmetic findings only — see the verification reports)` : "") +
      (totalCrossChapter > 0 ? `, ${totalCrossChapter} repaired for cross-chapter contradictions (see volume-consistency.md)` : "") +
      `. Re-run verify-translate to re-score the retranslated chapters.`
  );
  const volumeError = volumeFailureError("retranslate", failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
  return {
    retranslated: totalRetranslated,
    skipped: totalSkipped,
    none: totalNone,
    deferred: totalDeferred,
    crossChapter: totalCrossChapter,
  };
}

module.exports = {
  retranslate,
  processRetranslateVolume,
  runTargetedRepair,
  // Exported for the tests (a test that pins "the shortcut is refused when the
  // mapping is not trustworthy" has to know the shortcut is on).
  targetedFixEnabled,
};
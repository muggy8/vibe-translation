/**
 * One volume, chapter by chapter, in bundle order: skip what the current source and references already cover, size each chapter's parts with planChapterSplit, translate each part with the previous part's ending as continuity context, run the deterministic QA, and PERSIST the state. A deterministic-QA failure keeps the draft and quarantines the rejection, because the one artifact that can fix it (retranslate) needs something to work from (gotcha 39).
 *
 * Part of the translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { writePromptDump } = require("../utils/prompt");
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

const { continuityChars, translateChunkChars } = require("./config");
const { mergeVolumeTranslationFiles } = require("./merge");
const { buildQaReportMarkdown, buildQaRow } = require("./report");

/**
 * Translate one volume: per-chapter idempotent one-shot calls to the
 * translation model, deterministic QA, state persistence, and the merged
 * translation.md.
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
 * @returns {Promise<{translated: number, skipped: number, qa: Array<{id: string, title: string, status: string, ok: boolean, cjk: number, lengthRatio: number, warnings: string[]}>}>}
 */
async function processTranslateVolume(ctx) {
  const { volume, volumeDir, bundle, refs, template, endpoint, sampling, thinkingMode, dryRun, force, targetLanguage, sourceLanguage } = ctx;
  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  const qaRows = [];
  // The context budget for this role: the role's own window/cap when configured,
  // else the global ones (harness.js derives the output cap from the window).
  // Every injected reference block is fitted into it, and every drop is logged
  // and recorded in the QA row — "the model never saw the style rules" must
  // never be invisible.
  const roleWindow = endpoint.contextWindow || harness.envContextWindow();
  const outputReserve = endpoint.maxTokens || harness.envMaxTokens();

  // ─── How big a chapter part may be (tokens, not characters) ───────────────
  // The old rule was one character constant for every chapter, every model and
  // every language. Measured against the real series it split 55 of 133 chapters
  // for no reason the numbers supported — and every split is a seam where the
  // continuity tail has to rebuild the join and a name can drift between parts.
  // planChapterSplit bounds a part by BOTH limits that actually exist: the
  // request the server will admit, and the answer the output cap can hold.
  const chunkCap = translateChunkCap();
  // The answer-size ratio, measured from this series' own earlier volumes when
  // it has any (their sources and drafts are both on disk), else the per-pair
  // table. Fail-open: the first volume gets the same assumption the old code made.
  const measuredRatio = await measureOutputRatio(ctx.previousVolumeDirs || [], {
    sourceLanguage,
    targetLanguage,
  });
  const outputRatio = measuredRatio.ratio ?? outputRatioFor(sourceLanguage, targetLanguage);
  const thinkingFactor = thinkingOutputFactor(thinkingMode);
  /**
   * Split one chapter using the token plan, falling back to the character rule
   * only when the token rule has nothing to work with.
   * @param {string} text - The chapter source text.
   * @param {{continuityText?: string, terminologyLines?: string[], findingsText?: string}} [carry] - The reference material this chapter's prompt will carry.
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
  console.log(
    `  Volume ${volume.installmentNumber}: chapter parts planned in tokens — ` +
      `expect ${outputRatio.toFixed(2)}× output per source token ` +
      `${measuredRatio.ratio ? `(measured from ${measuredRatio.chapters} already-translated chapter(s): ` +
        `${measuredRatio.sourceTokens.toLocaleString()} source → ${measuredRatio.draftTokens.toLocaleString()} draft)` : "(from the per-pair table: no earlier volume to measure)"}` +
      `, thinking factor ${thinkingFactor}` +
      `${chunkCap ? `, capped at ${chunkCap} chars by TRANSLATE_CHUNK_CHARS` : " (TRANSLATE_CHUNK_CHARS unset — the token plan decides)"}.`
  );
  /** Every chapter whose prompt had to be trimmed, recorded for the QA report. */
  const promptDrops = [];
  /**
   * Chapters that are EMPTY IN THE SOURCE (a section that converted to nothing,
   * a blank page, an image-only page). They are recorded rather than translated:
   * no model call is spent inventing prose for a chapter that has no text, and
   * they are reported separately from chapters the pipeline FAILED to translate —
   * the pipeline cannot invent a book, but it must say the book has a hole.
   */
  const emptySourceChapters = [];
  let translated = 0;
  let skipped = 0;
  // Chapters whose model call or deterministic QA failed — isolated per
  // chapter (the draft is not written, so a re-run retries them) rather than
  // aborting the whole volume.
  let failed = 0;
  /**
   * The ending the NEXT chapter's continuity cue is built from, plus an honest
   * label for WHERE it came from. Two cases the old code blurred:
   *   - a chapter failed, so the tail is the last SUCCESSFUL chapter's ending —
   *     which is not "the previous chapter". Telling the model it is makes it
   *     match a neighbour it is not continuing from.
   *   - the first chapter of a volume has no previous chapter in this volume at
   *     all: it continues from the end of the PREVIOUS volume (ctx.incomingTail).
   */
  let prevChapterTail = ctx.incomingTail && ctx.incomingTail.text
    ? { text: ctx.incomingTail.text, source: `the end of the previous volume (${ctx.incomingTail.fromLabel || "the previous volume"})` }
    : { text: "", source: "" };

  // Chapters are processed SEQUENTIALLY on purpose: each chapter's prompt
  // carries the previous chapter's ending (prevChapterTail) as continuity
  // context, so chapter N+1 depends on chapter N's output. (The independent
  // tasks — verify / retranslate / polish — use runWithConcurrency instead.)
  for (let segIdx = 0; segIdx < bundle.segments.length; segIdx++) {
    const seg = bundle.segments[segIdx];
    // A heartbeat for an un-monitored run: every 10 chapters a greppable "N/M"
    // line, so a slow stage can be told apart from a stuck one.
    if ((segIdx + 1) % 10 === 0 || segIdx + 1 === bundle.segments.length) {
      harness.logLine(
        `[progress] translate Volume ${volume.installmentNumber}: ${segIdx + 1}/${bundle.segments.length} chapter(s) (last: ${seg.id})`
      );
    }
    const { draftFile, polishedFile, rejectedFile, bestFile } = chapterArtifactNames(seg.id);
    const chapterPath = path.join(volumeDir, seg.file);
    const sourceText = await fs.readFile(chapterPath, "utf8");
    if (sourceText.trim().length < EMPTY_SOURCE_CHARS) {
      console.warn(
        `  Volume ${volume.installmentNumber} ${seg.id}: EMPTY IN SOURCE ` +
          `(${sourceText.trim().length} character(s), floor ${EMPTY_SOURCE_CHARS}) — no translation call made.`
      );
      emptySourceChapters.push({ id: seg.id, title: seg.title || seg.id, chars: sourceText.trim().length });
      qaRows.push({
        id: seg.id,
        title: seg.title,
        status: "empty in source — not translated",
        ok: false,
        cjk: 0,
        lengthRatio: 0,
        warnings: [],
      });
      continue;
    }
    // The extraction's own empty flag is a LOUDER warning than the floor above: it
    // means the section converted to almost nothing (an image-only page, a page
    // whose text lives in a structure the converter does not map). There is still
    // text, so it is still translated — but the hole is announced, because a
    // chapter translated from 120 characters of a 3,000-character page is a
    // damaged chapter, and the reader of the run must be able to see that.
    if (seg.empty === true) {
      console.warn(
        `  Volume ${volume.installmentNumber} ${seg.id}: the extraction flagged this chapter as ` +
          `EMPTY (${seg.bodyChars ?? sourceText.trim().length} character(s) of converted text) — ` +
          `translating what is there, but check the [source] log lines for lost text.`
      );
    }
    const sourceHash = sha256(sourceText);
    // Only the glossary terms this chapter actually contains go into the
    // prompt — the cumulative glossary would otherwise grow with the series.
    const chapterTerms = chapterTerminology(refs, sourceText);
    if (chapterTerms.dropped > 0 && chapterTerms.present > 0) {
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: ${chapterTerms.present} glossary term(s) apply to this chapter ` +
          `(${refs.terms.length} in the volume glossary; ${chapterTerms.dropped - chapterTerms.present} dropped by the ${glossaryBlockMaxChars()}-char budget).`
      );
    }

    const entry = state.chapters[seg.id] || {};
    const draftPath = path.join(volumeDir, draftFile);
    let existingDraft = "";
    try {
      existingDraft = await fs.readFile(draftPath, "utf8");
    } catch {
      existingDraft = "";
    }
    // The chapter's OWN reference key (see chapterContextHash): a glossary edit
    // to a term this chapter never says must not re-translate it. A state entry
    // written before this key existed falls back to the volume-level hash, so an
    // existing run keeps its current behavior instead of re-translating everything
    // the moment the key is introduced.
    const chapterHash = chapterContextHash(refs, sourceText);
    const contextIsCurrent =
      entry.chapterContextHash !== undefined
        ? entry.chapterContextHash === chapterHash
        : entry.contextHash === refs.contextHash;
    const upToDate =
      !force &&
      entry.sourceHash === sourceHash &&
      contextIsCurrent &&
      // A draft that failed the deterministic QA is NOT up to date: it is a
      // repair target, and a plain re-run of this task is one of the ways it
      // gets repaired.
      entry.qaFailed !== true &&
      existingDraft.trim().length > 0;
    if (upToDate) {
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: draft up to date — skipping.`);
      skipped += 1;
      prevChapterTail = { text: tailOf(existingDraft, continuityChars), source: `the previous chapter (${seg.id})` };
      qaRows.push(await buildQaRow(seg, sourceText, existingDraft, refs, "skipped (up to date)", sourceLanguage, targetLanguage));
      continue;
    }

    // The part plan is computed ONCE, before the dry-run branch, so a preview
    // shows the same cut a live run would make (a dry run that silently split
    // differently from the real one would be a preview of a different book).
    const { parts, plan } = splitChapterFor(sourceText, {
      continuityText: prevChapterTail.text,
      terminologyLines: chapterTerms.lines,
    });
    if (parts.length > 1) {
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: split into ${parts.length} part(s) — ${plan.reason}.`
      );
    }

    if (dryRun) {
      // Dump the first part's prompt for every chapter a live run would
      // translate (up-to-date chapters were skipped above) — one file per
      // chapter, no AI calls in dry-run.
      const { tasks } = buildBudgetedTaskLines({
        terminologyLines: chapterTerms.lines,
        background: refs.background,
        styleRules: refs.styleRules,
        voiceNotes: refs.voiceNotes,
        continuityText: prevChapterTail.text || "(the previous text's ending would go here)",
        continuitySource: prevChapterTail.source || "the previous chapter",
        sourceText: parts[0],
        template,
        roleWindow,
        outputReserve,
        targetLanguage,
        label: `Volume ${volume.installmentNumber} ${seg.id}`,
      });
      const prompt = buildTranslationPrompt({ template, sourceText: parts[0], tasks });
      const file = await writePromptDump(
        `translate-${volume.installmentNumber}-${seg.id}`,
        volume.installmentNumber,
        "one-shot (no system prompt — Hy-MT2 contract)",
        [
          {
            title:
              `One-shot — translate ${seg.id} ` +
              `(endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${thinkingMode}, ` +
              `sampling=${JSON.stringify(sampling)})`,
            prompt,
          },
        ]
      );
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: --dry-run prompt dump → ${file}`);
      continue;
    }

    // Translate the chapter part by part (oversized chapters are split; each
    // part continues the previous one). A per-chapter try/catch isolates
    // failures: a bad chapter (truncated/empty model output, or a
    // deterministic-QA hard fail) is marked FAILED and the loop moves on
    // instead of aborting the whole volume — the draft is simply not written,
    // so a re-run retries it. prevChapterTail keeps the last good chapter's
    // ending for the next chapter's continuity context.
    try {
    const partTexts = [];
    let continuity = prevChapterTail.text;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const { tasks, dropped: partDrops } = buildBudgetedTaskLines({
        terminologyLines: chapterTerms.lines,
        background: refs.background,
        styleRules: refs.styleRules,
        voiceNotes: refs.voiceNotes,
        continuityText: continuity,
        continuitySource: i === 0 ? prevChapterTail.source : "the previous part of this chapter",
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
        `  Volume ${volume.installmentNumber} ${seg.id}: translating part ${i + 1}/${parts.length} ` +
          `(${part.length} chars) with ${endpoint.model}…`
      );
      const result = await harness.runOneShot({
        // NO system prompt — Hy-MT2's official contract is a single user
        // message (systemPrompt: null sends none).
        systemPrompt: null,
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
        label: `translate-v${volume.installmentNumber}-${seg.id}-${parts.length > 1 ? "part" + (i + 1) : "full"}`,
      });
      const clean = stripMarkdownFence(result);
      if (!clean) {
        throw new Error(
          `Volume ${volume.installmentNumber} ${seg.id}: the model returned no content for part ${i + 1}. ` +
            `Check the run log: .logs/`
        );
      }
      // Continuity dedup: when the model repeats the previous part's ending
      // (the continuity tail it was given) at the start of its reply, strip
      // the duplicated prefix so the merged draft has no repeated passage.
      const deduped = i > 0 ? stripContinuityOverlap(partTexts[i - 1], clean) : clean;
      partTexts.push(deduped);
      continuity = tailOf(deduped, continuityChars);
    }
    const draft = partTexts.join("\n\n");

    // Deterministic QA (no AI). A hard failure means this attempt is unusable —
    // but the attempt is NOT thrown away (observed: a residue failure threw the
    // draft out, the completeness gate then aborted the whole task, and volumes
    // 3–17 were never translated; and the QA loop had nothing to correct).
    //   - a usable draft already exists → quarantine this attempt, keep the good one
    //   - there is no usable draft → this text becomes the draft, marked
    //     qaFailed, and the QA loop (verify → retranslate) owns repairing it
    const qa = checkTranslationQa({ sourceText, draftText: draft, terms: refs.terms, sourceLanguage, targetLanguage });
    if (!qa.ok) {
      const reason = qa.errors.join("; ");
      await fs.writeFile(path.join(volumeDir, rejectedFile), draft + "\n", "utf8");
      const hasUsableDraft = existingDraft.trim().length > 0 && entry.qaFailed !== true;
      failed += 1;
      if (hasUsableDraft) {
        console.error(
          `  Volume ${volume.installmentNumber} ${seg.id}: new draft REJECTED by deterministic QA ` +
            `(${reason}) — quarantined to ${rejectedFile}; the previous draft is kept.`
        );
        prevChapterTail = { text: tailOf(existingDraft, continuityChars), source: `the last usable chapter draft (${seg.id})` };
        qaRows.push(
          buildQaRow(seg, sourceText, existingDraft, refs, `new attempt rejected — ${reason} (previous draft kept)`, sourceLanguage, targetLanguage)
        );
        continue;
      }
      await fs.writeFile(draftPath, draft + "\n", "utf8");
      state.chapters[seg.id] = {
        sourceHash,
        contextHash: refs.contextHash,
        chapterContextHash: chapterHash,
        draftHash: sha256(draft + "\n"),
        retranslated: false,
        findingsHash: null,
        polishedDraftHash: null,
        // The repair target: verify treats this as a known FAIL (no model call
        // needed — the reason is already known) and retranslate re-drafts it.
        qaFailed: true,
        qaFindings: buildPolishGuardFindings(qa),
        bestScore: null,
        bestDraftHash: null,
        bestVerdict: null,
      };
      await fs.rm(path.join(volumeDir, polishedFile), { force: true });
      await saveTranslationState(path.join(volumeDir, STATE_FILE), state);
      console.error(
        `  Volume ${volume.installmentNumber} ${seg.id}: draft FAILED deterministic QA (${reason}) — ` +
          `written and marked for correction by the translate-qa loop (also kept in ${rejectedFile}).`
      );
      prevChapterTail = { text: tailOf(draft, continuityChars), source: `the previous chapter (${seg.id})` };
      qaRows.push(buildQaRow(seg, sourceText, draft, refs, qa.warnings, sourceLanguage, targetLanguage));
      continue;
    }

    await fs.writeFile(draftPath, draft + "\n", "utf8");
    state.chapters[seg.id] = {
      sourceHash,
      contextHash: refs.contextHash,
      chapterContextHash: chapterHash,
      // Hash of the FILE content as written (with trailing newline) — the
      // skip-checks elsewhere compare against the on-disk file.
      draftHash: sha256(draft + "\n"),
      retranslated: false,
      findingsHash: null,
      // A fresh draft invalidates any earlier polish pass (and its file).
      polishedDraftHash: null,
      qaFailed: false,
      // A fresh translation starts a new ratchet baseline: the previous best
      // draft belongs to a superseded context and must not be restored into it.
      bestScore: null,
      bestDraftHash: null,
      bestVerdict: null,
    };
    await fs.rm(path.join(volumeDir, polishedFile), { force: true });
    await fs.rm(path.join(volumeDir, bestFile), { force: true });
    await fs.rm(path.join(volumeDir, rejectedFile), { force: true });
    // Persist per chapter — a crash mid-volume resumes at the next chapter.
    await saveTranslationState(path.join(volumeDir, STATE_FILE), state);
    translated += 1;
    prevChapterTail = { text: tailOf(draft, continuityChars), source: `the previous chapter (${seg.id})` };
    qaRows.push(await buildQaRow(seg, sourceText, draft, refs, qa.warnings, sourceLanguage, targetLanguage));
    if (qa.warnings.length > 0) {
      console.warn(`  Volume ${volume.installmentNumber} ${seg.id}: QA warning: ${qa.warnings.join("; ")}`);
    }
    } catch (err) {
      failed += 1;
      console.error(
        `  Volume ${volume.installmentNumber} ${seg.id}: FAILED — ${err.message} The draft was NOT ` +
          `written, so the chapter will be retried on re-run (no state entry was saved).`
      );
      qaRows.push({
        id: seg.id,
        title: seg.title,
        status: `failed — ${err.message}`,
        ok: false,
        cjk: 0,
        lengthRatio: 0,
        warnings: [],
      });
    }
  }

  // Merge the volume's chapters (the polished text wins when it was produced
  // from the CURRENT draft, otherwise the draft) — rewritten even when every
  // chapter was skipped (the merged file may be missing after a crash).
  const merged = await mergeVolumeTranslationFiles(volumeDir, bundle, state, {
    sourceLanguage,
    targetLanguage,
  });
  if (merged.text) {
    await fs.writeFile(path.join(volumeDir, MERGED_FILE), merged.text, "utf8");
  }
  if (merged.missing.length > 0) {
    // Reported here, failed by the TASK at its end: an incomplete volume must
    // not stop the other volumes from being translated.
    console.error(
      `  Volume ${volume.installmentNumber}: INCOMPLETE — ${merged.missing.length} of ` +
        `${bundle.segments.length} chapter(s) have no text: ${merged.missing.map((m) => m.id).join(", ")}.`
    );
  }
  if (merged.unverified.length > 0) {
    console.warn(
      `  Volume ${volume.installmentNumber}: ${merged.unverified.length} chapter(s) published without ` +
        `a passing verification verdict (marked UNVERIFIED in ${MERGED_FILE}).`
    );
  }
  await fs.writeFile(
    path.join(volumeDir, QA_REPORT_FILE),
    buildQaReportMarkdown(volume, qaRows, promptDrops),
    "utf8"
  );
  return {
    translated,
    skipped,
    failed,
    qa: qaRows,
    missing: merged.missing,
    unverified: merged.unverified,
    // The published ending of THIS volume, so the next volume's first chapter
    // continues from it (see the task loop).
    tail: {
      text: tailOf(merged.text || "", continuityChars),
      fromLabel: `Volume ${volume.installmentNumber}`,
    },
    emptySourceChapters,
  };
}


module.exports = {
  processTranslateVolume,
};

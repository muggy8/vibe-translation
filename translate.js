/**
 * translate.js — Logic for the "translate" gulp task: the first stage of the
 * local multi-model translation pipeline.
 *
 * Task: translate
 *   For each volume (in natural order):
 *     1. Resolve the volume's source bundle (utils/source.js) and load the
 *        reference artifacts (glossary.md → terminology, style-guide.md
 *        → house rules, shared-wiki.md + wiki.md + pov-map.md → background).
 *     2. For each chapter segment (reading order — the bundle's segments
 *        array, NEVER a filename sort):
 *        - Skip it when its translation-<id>.md draft exists and the state
 *          file (translation-state.json) shows the same source + reference
 *          hashes (idempotency; --force re-translates).
 *        - Split oversized chapters (TRANSLATE_CHUNK_CHARS) and translate
 *          each part with Hy-MT2 via runOneShot — NO system prompt (the
 *          model's official contract is a single user message), official
 *          sampling (temp 0.7, top_p 1.0, top_k -1, rep-pen 1.0), fast
 *          "no_think" mode by default (TRANSLATE_THINKING).
 *        - Each part after the first gets the previous part's ending as
 *          continuity context (TRANSLATE_CONTINUITY_CHARS).
 *        - Run the deterministic QA (utils/translate.js: CJK ratio, length
 *          ratio, glossary coverage) — a hard failure fails the chapter.
 *        - Persist the draft + state entry (crash-safe, per chapter).
 *     3. Merge all chapters into the volume's translation.md and write the
 *        deterministic QA report (translation-qa.md).
 *
 * The endpoint is role-specific (TRANSLATE_BASE_URL / TRANSLATE_MODEL /
 * TRANSLATE_API_KEY, falling back to the global AI_* settings). On local
 * setups the per-machine pre-translate hook (hooks/) starts the Hy-MT2
 * container; the task itself only checks the endpoint via
 * harness.assertModelServing before the first call.
 *
 * Idempotent and resumable: re-runs skip finished chapters; a changed source
 * or a regenerated glossary/style guide (reference hash) invalidates the
 * stale drafts.
 *
 * Usage:
 *   npx gulp translate              # run the full task
 *   npx gulp translate --dry-run    # dump the prompts only, no AI calls
 *   npx gulp translate --force      # re-translate even if drafts exist
 *   npx gulp translate --volume 01  # single volume
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types"); // JSDoc type definitions
const harness = require("./harness");
const { getTranslationTarget } = require("./get-translation-target");
const { filterVolumesByInstallment } = require("./utils/manifest");
const { ON_VOLUME_ERROR, validateRequiredEnv, resolveRunSettings, isStructuralError, structuralError, volumeFailureError } = require("./configs/shared");
const { resolveSourceBundle } = require("./utils/source");
const { writePromptDump } = require("./utils/prompt");
const { writeTranslationReport, checkTranslationPreconditions } = require("./utils/translation-report");
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
} = require("./utils/translate");

// ─── Paths & config ──────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const translateTemplateFile = path.join(clientDir, "user-prompts", "translate.md");

// Per-chapter artifact names and the per-volume file names (chapterArtifactNames,
// STATE_FILE, QA_REPORT_FILE, MERGED_FILE, readFileOrEmpty) now live in
// utils/translate.js — all four translation tasks need them, and keeping them in
// a task module made the tasks import from each other. They are re-exported
// below so existing imports keep working.

/**
 * Chapter text longer than this (chars) is split and translated per part.
 *
 * Only the FALLBACK now: the size rule is planChapterSplit (tokens, against this
 * role's window and output cap). This number stands in when the token rule has
 * nothing to work with, and TRANSLATE_CHUNK_CHARS remains a hard ceiling when an
 * operator sets it explicitly (see translateChunkCap).
 * @returns {number} TRANSLATE_CHUNK_CHARS (default 24000, minimum 2000).
 */
function translateChunkChars() {
  const parsed = parseInt(process.env.TRANSLATE_CHUNK_CHARS, 10);
  return Number.isFinite(parsed) ? Math.max(2000, parsed) : 24000;
}

/**
 * How many chars of the previous chapter's ending feed the next chapter.
 * @returns {number} TRANSLATE_CONTINUITY_CHARS (default 400; 0 = off).
 */
function translateContinuityChars() {
  const parsed = parseInt(process.env.TRANSLATE_CONTINUITY_CHARS, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 400;
}

const continuityChars = translateContinuityChars();

/**
 * Hy-MT2 thinking mode. The model's published numbers are for the fast
 * (non-thinking) mode, so the default is "no_think"; "low"/"high" enable
 * the think tag (slower, unproven benefit for translation).
 * @returns {"no_think"|"low"|"high"}
 */
function translateThinkingMode() {
  const raw = String(process.env.TRANSLATE_THINKING ?? "no_think").trim().toLowerCase();
  if (raw === "true") return "low"; // "thinking on" without a level → low
  if (raw === "false") return "no_think";
  if (["no_think", "low", "high"].includes(raw)) return raw;
  console.warn(`[translate] unknown TRANSLATE_THINKING value "${raw}" — using "no_think".`);
  return "no_think";
}

/**
 * Hy-MT2 sampling. Official 30B-A3B recipe: temperature 0.7, top_p 1.0,
 * top_k -1, repetition_penalty 1.0 (temperature is overridable via
 * TRANSLATE_TEMPERATURE).
 * @returns {{temperature: number, topP: number, topK: number, repetitionPenalty: number}}
 */
function translateSampling() {
  const t = parseFloat(process.env.TRANSLATE_TEMPERATURE ?? "0.7");
  return {
    temperature: Number.isFinite(t) ? t : 0.7,
    topP: 1.0,
    topK: -1,
    repetitionPenalty: 1.0,
  };
}

// ─── Per-volume processing ──────────────────────────────────────────────────

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

/**
 * Merge a volume's chapter files into the translation.md content: the
 * polished file is used when the state shows it was produced from the
 * CURRENT draft (polishedDraftHash === draftHash), otherwise the draft.
 *
 * Two guarantees the merge used to lack:
 *   - **The published file carries its own verdict.** A chapter whose
 *     verification FAILED (or that was never verified) gets a visible
 *     UNVERIFIED marker in the book itself. (Observed: a chapter that failed
 *     verification at 57/100 was published as accepted polished text with
 *     nothing on the page saying so.)
 *   - **Incompleteness is reported, not thrown from the middle of a run.** The
 *     missing list is returned so the task can finish every volume and fail at
 *     the END — one untranslatable chapter in volume 2 must not prevent
 *     volumes 3–17 from being translated.
 *
 * @param {string} volumeDir
 * @param {{segments: Array<{id: string, title: string}>}} bundle
 * @param {{chapters: Object}} state
 * @returns {Promise<{text: string, missing: Array<{id: string, title: string}>, unverified: Array<{id: string, title: string, score: number|null, reason: string}>}>}
 *   The merged text ("" when no chapter has text), the chapters with no text,
 *   and the chapters published without a passing verdict.
 */
async function mergeVolumeTranslationFiles(volumeDir, bundle, state, languages = {}) {
  // Resolve the per-chapter texts first (the pure merge helper takes a sync
  // getter). ONE rule for "what this volume publishes" — the same resolver the
  // cross-chapter audit and the variant scan read (resolvePublishedChapterTexts),
  // so the reports and the book cannot end up describing different texts.
  const sidecar = await loadVerificationSidecar(path.join(volumeDir, VERIFICATION_FILE));
  const published = await resolvePublishedChapterTexts(volumeDir, bundle, state);
  const resolved = new Map();
  const verdicts = new Map();
  for (const { id: segId, text } of published) {
    const seg = bundle.segments.find((s) => s.id === segId);
    const entry = (state.chapters && state.chapters[segId]) || {};
    resolved.set(segId, text || null);

    // The verdict that applies to the draft this text came from.
    const verdict = sidecar.chapters[segId];
    if (text) {
      if (entry.qaFailed === true) {
        verdicts.set(seg.id, {
          score: verdictCoversCurrentDraft(verdict, entry) ? verdict.score : null,
          pass: false,
          reason: `it failed the deterministic QA checks (${(entry.qaFindings || "residue / length / coverage").slice(0, 200)})`,
        });
      } else if (verdictCoversCurrentDraft(verdict, entry)) {
        if (verdict.pass !== true) {
          verdicts.set(segId, {
            score: typeof verdict.score === "number" ? verdict.score : null,
            pass: false,
            // The verifier's own reason when it recorded one — the reader of the
            // published volume sees WHY this chapter is flagged, not just that it
            // is. The generic phrase is the fallback (an older sidecar, or a
            // verdict written before reasons were stored).
            reason:
              typeof verdict.reason === "string" && verdict.reason.trim()
                ? verdict.reason.trim()
                : verdict.score === null
                  ? "the verifier's score could not be read"
                  : "the verifier scored it below the passing threshold",
          });
        }
      } else {
        verdicts.set(seg.id, {
          score: null,
          pass: false,
          reason: "verification has not run for this draft (run verify-translate / translate-qa)",
        });
      }
    }
  }
  const missing = findMissingSegments(bundle.segments, (seg) => resolved.get(seg.id) || null);
  const unverified = [];
  const text = mergeVolumeTranslation({
    segments: bundle.segments,
    languages,
    sourceLanguage: languages.sourceLanguage,
    targetLanguage: languages.targetLanguage,
    getText: (seg) => resolved.get(seg.id) || null,
    getNote: (seg) => {
      const verdict = verdicts.get(seg.id);
      if (!verdict) return "";
      unverified.push({ id: seg.id, title: seg.title || seg.id, score: verdict.score, reason: verdict.reason });
      return unverifiedMarker(verdict);
    },
  });
  return { text, missing, unverified };
}

/**
 * Build one QA-report row for a chapter (re-runs the deterministic checks on
 * the given text — the report is always in sync with the files on disk).
 *
 * @param {{id: string, title: string}} seg
 * @param {string} sourceText
 * @param {string} draftText
 * @param {{terms: Array<{term: string, rendering: string}>}} refs
 * @param {string|string[]} statusOrWarnings - A status string (skipped) or
 *   the warnings array from the chapter's own QA run.
 * @returns {{id: string, title: string, status: string, ok: boolean, cjk: number, lengthRatio: number, warnings: string[]}}
 */
function buildQaRow(seg, sourceText, draftText, refs, statusOrWarnings, sourceLanguage, targetLanguage) {
  const qa = checkTranslationQa({ sourceText, draftText, terms: refs.terms, sourceLanguage, targetLanguage });
  const status =
    typeof statusOrWarnings === "string"
      ? statusOrWarnings
      : qa.warnings.length > 0
        ? "translated — with warnings"
        : "translated";
  const warnings = typeof statusOrWarnings === "string" ? qa.warnings : statusOrWarnings;
  return {
    id: seg.id,
    title: seg.title,
    status,
    ok: qa.ok,
    cjk: qa.cjk,
    lengthRatio: qa.lengthRatio,
    warnings,
  };
}

/**
 * Build the per-volume deterministic QA report (translation-qa.md).
 *
 * @param {{installmentNumber: string, folder: string}} volume
 * @param {Array<{id: string, title: string, status: string, ok: boolean, cjk: number, lengthRatio: number, warnings: string[]}>} qaRows
 * @returns {string} The Markdown report.
 */
function buildQaReportMarkdown(volume, qaRows, promptDrops = []) {
  const lines = [];
  lines.push(`# Translation QA — Volume ${volume.installmentNumber} (${volume.folder})`);
  lines.push("");
  lines.push(
    "_Deterministic audit of the chapter drafts (no AI): residual CJK ratio, length ratio vs the " +
      "source, and glossary-term coverage. CJK > 5% or an empty draft fails the chapter; CJK > 0.5%, " +
      "length ratio outside 0.6–2.5, and missing glossary renderings are warnings. Generated by the " +
      "translate task; refreshed on every run (including skipped chapters)._"
  );
  lines.push("");
  lines.push("| Chapter | Title | Status | CJK % | Length ratio | Warnings |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of qaRows) {
    lines.push(
      `| ${row.id} | ${row.title || "—"} | ${row.ok ? row.status : row.status + " — FAILED"} | ` +
        `${(row.cjk * 100).toFixed(2)} | ${Number.isFinite(row.lengthRatio) ? row.lengthRatio.toFixed(2) : "n/a"} | ` +
        (row.warnings.length > 0 ? row.warnings.join("; ") : "—") +
        " |"
    );
  }
  lines.push("");
  const failed = qaRows.filter((r) => !r.ok);
  if (failed.length > 0) {
    lines.push(`**${failed.length} chapter(s) FAILED deterministic QA.**`);
    lines.push("");
  }
  if (promptDrops.length > 0) {
    lines.push("## Reference material the model did NOT see");
    lines.push("");
    lines.push(
      "_These chapters' prompts were trimmed to fit the model's context window. A chapter translated " +
        "without a block it should have had is a known limitation of that draft, not a hidden detail._"
    );
    lines.push("");
    lines.push("| Chapter | Part | Dropped |");
    lines.push("|---|---|---|");
    for (const d of promptDrops) {
      lines.push(
        `| ${d.id} | ${d.part} | ${d.dropped.map((x) => `${x.name} (${x.chars} chars)`).join(", ")} |`
      );
    }
    lines.push("");
    lines.push(
      "**Fix:** raise the role's context window (`TRANSLATE_CONTEXT_WINDOW`), lower " +
        "`TRANSLATE_CHUNK_CHARS` so chapters are split sooner, or shrink the reference artifact."
    );
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Task entry ─────────────────────────────────────────────────────────────

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
  processTranslateVolume,
  chapterArtifactNames,
  STATE_FILE,
  QA_REPORT_FILE,
  MERGED_FILE,
  mergeVolumeTranslationFiles,
  buildQaRow,
  buildQaReportMarkdown,
  translateThinkingMode,
  translateSampling,
  translateChunkChars,
  translateContinuityChars,
};
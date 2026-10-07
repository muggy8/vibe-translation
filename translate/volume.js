/**
 * One volume, chapter by chapter, in bundle order.
 *
 * The loop, in the order it actually runs:
 *   1. planChapterParts   — how big a chapter part may be, decided in tokens not characters
 *   2. readChapter        — the chapter's source, and the two ways it can be empty
 *   3. chapterIsCurrent   — the idempotency check: does the draft on disk already match this
 *                           source and these references?
 *   4. translateChapter   — the part-by-part model calls, each continuing from the last
 *   5. commitChapter      — the deterministic QA, and what to do with the draft it produced
 *   6. finishVolume       — merge the chapters, write the QA report, hand the volume's ending on
 *
 * A deterministic-QA failure keeps the draft and quarantines the rejection, because the one artifact
 * that can fix it (retranslate) needs something to work from (gotcha 39).
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
  buildTranslationPrompt,
  checkTranslationQa,
  tailOf,
  loadTranslationState,
  saveTranslationState,
  chapterTerminology,
  glossaryBlockMaxChars,
  stripContinuityOverlap,
  chapterArtifactNames,
  buildBudgetedTaskLines,
  EMPTY_SOURCE_CHARS,
  buildPolishGuardFindings,
  createChapterPlanner,
  chapterHeartbeat,
  stripMarkdownFence,
  chapterContextHash,
  STATE_FILE,
  QA_REPORT_FILE,
  MERGED_FILE,
} = require("../utils/translate");

const { continuityChars } = require("./config");
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
 * @returns {Promise<{translated: number, skipped: number, failed: number, qa: Array<Object>, missing: Array, unverified: Array, tail: {text: string, fromLabel: string}, emptySourceChapters: Array}>}
 */
async function processTranslateVolume(ctx) {
  const { volume, volumeDir, bundle, dryRun, force, targetLanguage, sourceLanguage } = ctx;
  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));

  // The context budget for this role: the role's own window/cap when configured, else the global
  // ones (harness.js derives the output cap from the window). Every injected reference block is
  // fitted into it, and every drop is logged and recorded in the QA row — "the model never saw the
  // style rules" must never be invisible.
  const roleWindow = ctx.endpoint.contextWindow || harness.envContextWindow();
  const outputReserve = ctx.endpoint.maxTokens || harness.envMaxTokens();

  const planner = await planChapterParts(ctx, { roleWindow, outputReserve });
  const run = createVolumeRun(ctx);

  // Chapters are processed SEQUENTIALLY on purpose: each chapter's prompt carries the previous
  // chapter's ending (run.tail) as continuity context, so chapter N+1 depends on chapter N's output.
  // (The independent tasks — verify / retranslate / polish — use runWithConcurrency instead.)
  const heartbeat = chapterHeartbeat("translate", volume.installmentNumber, bundle.segments.length);
  for (let segIdx = 0; segIdx < bundle.segments.length; segIdx++) {
    const seg = bundle.segments[segIdx];
    // A heartbeat for an un-monitored run: every 10 chapters a greppable "N/M" line, so a slow stage
    // can be told apart from a stuck one.
    heartbeat(seg.id);

    const chapter = await readChapter(ctx, seg);
    if (chapter.empty) {
      run.emptySourceChapters.push({ id: seg.id, title: seg.title || seg.id, chars: chapter.chars });
      run.qaRows.push(emptySourceRow(seg, chapter.chars));
      continue;
    }

    // Only the glossary terms this chapter actually contains go into the prompt — the cumulative
    // glossary would otherwise grow with the series.
    const terms = chapterTerminology(ctx.refs, chapter.sourceText);
    reportTermBudget(ctx, seg, terms);

    const existing = await readExistingDraft(ctx, seg);
    if (chapterIsCurrent(ctx, state, seg, chapter, existing)) {
      run.skipped += 1;
      run.tail = tailFrom(existing, `the previous chapter (${seg.id})`);
      run.qaRows.push(await buildQaRow(seg, chapter.sourceText, existing, ctx.refs, "skipped (up to date)", sourceLanguage, targetLanguage));
      continue;
    }

    // The part plan is computed ONCE, before the dry-run branch, so a preview shows the same cut a
    // live run would make (a dry run that silently split differently from the real one would be a
    // preview of a different book).
    const { parts, plan } = planner.split(chapter.sourceText, {
      continuityText: run.tail.text,
      terminologyLines: terms.lines,
    });
    if (parts.length > 1) {
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: split into ${parts.length} part(s) — ${plan.reason}.`);
    }

    if (dryRun) {
      await dumpChapterPreview(ctx, run, seg, parts, { terms, roleWindow, outputReserve });
      continue;
    }

    await translateOneChapter(ctx, state, run, seg, chapter, existing, parts, { terms, roleWindow, outputReserve });
  }

  return await finishVolume(ctx, state, run);
}


/**
 * The counters, the QA rows, and the continuity tail a volume's chapter loop carries from one
 * chapter to the next.
 * @param {Object} ctx
 * @returns {{qaRows: Array, promptDrops: Array, emptySourceChapters: Array, translated: number, skipped: number, failed: number, tail: {text: string, source: string}}}
 */
function createVolumeRun(ctx) {
  /**
   * Chapters that are EMPTY IN THE SOURCE (a section that converted to nothing, a blank page, an
   * image-only page). They are recorded rather than translated: no model call is spent inventing
   * prose for a chapter that has no text, and they are reported separately from chapters the
   * pipeline FAILED to translate — the pipeline cannot invent a book, but it must say the book has a
   * hole.
   */
  return {
    qaRows: [],
    /** Every chapter whose prompt had to be trimmed, recorded for the QA report. */
    promptDrops: [],
    emptySourceChapters: [],
    translated: 0,
    skipped: 0,
    // Chapters whose model call or deterministic QA failed — isolated per chapter (the draft is not
    // written, so a re-run retries them) rather than aborting the whole volume.
    failed: 0,
    /**
     * The ending the NEXT chapter's continuity cue is built from, plus an honest label for WHERE it
     * came from. Two cases the old code blurred:
     *   - a chapter failed, so the tail is the last SUCCESSFUL chapter's ending — which is not "the
     *     previous chapter". Telling the model it is makes it match a neighbour it is not continuing
     *     from.
     *   - the first chapter of a volume has no previous chapter in this volume at all: it continues
     *     from the end of the PREVIOUS volume (ctx.incomingTail).
     */
    tail: ctx.incomingTail && ctx.incomingTail.text
      ? { text: ctx.incomingTail.text, source: `the end of the previous volume (${ctx.incomingTail.fromLabel || "the previous volume"})` }
      : { text: "", source: "" },
  };
}


/**
 * How big a chapter part may be — decided in tokens, not characters.
 *
 * The old rule was one character constant for every chapter, every model and every language. Measured
 * against the real series it split 55 of 133 chapters for no reason the numbers supported — and every
 * split is a seam where the continuity tail has to rebuild the join and a name can drift between
 * parts. planChapterSplit bounds a part by BOTH limits that actually exist: the request the server
 * will admit, and the answer the output cap can hold.
 *
 * @param {Object} ctx
 * @param {{roleWindow: number, outputReserve: number}} budget
 * @returns {Promise<{ split: (text: string, carry?: Object) => {parts: string[], plan: Object} }>}
 */
async function planChapterParts(ctx, { roleWindow, outputReserve }) {
  const { volume, refs, template, thinkingMode, sourceLanguage, targetLanguage } = ctx;
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
  const { ratio, outputRatio, thinkingFactor, hardCap } = planner;

  console.log(
    `  Volume ${volume.installmentNumber}: chapter parts planned in tokens — ` +
      `expect ${outputRatio.toFixed(2)}× output per source token ` +
      `${ratio.ratio ? `(measured from ${ratio.chapters} already-translated chapter(s): ` +
        `${ratio.sourceTokens.toLocaleString()} source → ${ratio.draftTokens.toLocaleString()} draft)` : "(from the per-pair table: no earlier volume to measure)"}` +
      `, thinking factor ${thinkingFactor}` +
      `${hardCap ? `, capped at ${hardCap} chars by TRANSLATE_CHUNK_CHARS` : " (TRANSLATE_CHUNK_CHARS unset — the token plan decides)"}.`
  );
  return planner;
}


/**
 * Read one chapter's source and report the two ways it can be empty.
 *
 * The character floor is the hard one: no translation call is made for a chapter with no text. The
 * extraction's own `empty` flag is a LOUDER warning than the floor: it means the section converted to
 * almost nothing (an image-only page, a page whose text lives in a structure the converter does not
 * map). There is still text, so it is still translated — but the hole is announced, because a chapter
 * translated from 120 characters of a 3,000-character page is a damaged chapter, and the reader of the
 * run must be able to see that.
 *
 * @param {Object} ctx
 * @param {{id: string, file: string, title: string, empty?: boolean, bodyChars?: number}} seg
 * @returns {Promise<{ sourceText: string, sourceHash: string, chars: number, empty: boolean }>}
 */
async function readChapter(ctx, seg) {
  const { volume, volumeDir } = ctx;
  const sourceText = await fs.readFile(path.join(volumeDir, seg.file), "utf8");
  const chars = sourceText.trim().length;
  if (chars < EMPTY_SOURCE_CHARS) {
    console.warn(
      `  Volume ${volume.installmentNumber} ${seg.id}: EMPTY IN SOURCE ` +
        `(${chars} character(s), floor ${EMPTY_SOURCE_CHARS}) — no translation call made.`
    );
    return { sourceText, sourceHash: "", chars, empty: true };
  }
  if (seg.empty === true) {
    console.warn(
      `  Volume ${volume.installmentNumber} ${seg.id}: the extraction flagged this chapter as ` +
        `EMPTY (${seg.bodyChars ?? chars} character(s) of converted text) — ` +
        `translating what is there, but check the [source] log lines for lost text.`
    );
  }
  return { sourceText, sourceHash: sha256(sourceText), chars, empty: false };
}

/**
 * The QA row for a chapter that has no text to translate.
 * @param {{id: string, title: string}} seg
 * @param {number} chars
 * @returns {Object}
 */
function emptySourceRow(seg, chars) {
  return { id: seg.id, title: seg.title, status: "empty in source — not translated", ok: false, cjk: 0, lengthRatio: 0, warnings: [] };
}

/**
 * Say how much of the volume's glossary this chapter's prompt could carry.
 * @param {Object} ctx
 * @param {{id: string}} seg
 * @param {{present: number, dropped: number, lines: string[]}} terms
 */
function reportTermBudget(ctx, seg, terms) {
  if (terms.dropped > 0 && terms.present > 0) {
    console.log(
      `  Volume ${ctx.volume.installmentNumber} ${seg.id}: ${terms.present} glossary term(s) apply to this chapter ` +
        `(${ctx.refs.terms.length} in the volume glossary; ${terms.dropped - terms.present} dropped by the ${glossaryBlockMaxChars()}-char budget).`
    );
  }
}


/**
 * The draft already on disk for this chapter ("" when there is none).
 * @param {Object} ctx
 * @param {{id: string}} seg
 * @returns {Promise<string>}
 */
async function readExistingDraft(ctx, seg) {
  const { draftFile } = chapterArtifactNames(seg.id);
  try {
    return await fs.readFile(path.join(ctx.volumeDir, draftFile), "utf8");
  } catch {
    return "";
  }
}


/**
 * The idempotency check: is the draft on disk still the one these references and this source imply?
 *
 * A chapter's OWN reference key is used (see chapterContextHash): a glossary edit to a term this
 * chapter never says must not re-translate it. A state entry written before this key existed falls
 * back to the volume-level hash, so an existing run keeps its current behavior instead of
 * re-translating everything the moment the key is introduced.
 *
 * A draft that failed the deterministic QA is NOT up to date: it is a repair target, and a plain
 * re-run of this task is one of the ways it gets repaired.
 *
 * @param {Object} ctx
 * @param {Object} state - The volume's translation state.
 * @param {{id: string}} seg
 * @param {{sourceHash: string}} chapter
 * @param {string} existingDraft
 * @returns {boolean}
 */
function chapterIsCurrent(ctx, state, seg, chapter, existingDraft) {
  if (ctx.force) return false;
  const entry = state.chapters[seg.id] || {};
  const chapterHash = chapterContextHash(ctx.refs, chapter.sourceText);
  const contextIsCurrent =
    entry.chapterContextHash !== undefined
      ? entry.chapterContextHash === chapterHash
      : entry.contextHash === ctx.refs.contextHash;
  return (
    entry.sourceHash === chapter.sourceHash &&
    contextIsCurrent &&
    entry.qaFailed !== true &&
    existingDraft.trim().length > 0
  );
}


/**
 * `--dry-run`: dump the first part's prompt for every chapter a live run would translate (up-to-date
 * chapters were skipped before this point) — one file per chapter, no AI calls.
 *
 * @param {Object} ctx
 * @param {Object} run - The volume run, for the continuity tail this chapter would have been given.
 * @param {Object} seg
 * @param {string[]} parts
 * @param {{terms: Object, roleWindow: number, outputReserve: number}} carry
 * @returns {Promise<void>}
 */
async function dumpChapterPreview(ctx, run, seg, parts, { terms, roleWindow, outputReserve }) {
  const { volume, template, endpoint, sampling, thinkingMode, targetLanguage } = ctx;
  const { tasks } = buildBudgetedTaskLines({
    terminologyLines: terms.lines,
    background: ctx.refs.background,
    styleRules: ctx.refs.styleRules,
    voiceNotes: ctx.refs.voiceNotes,
    continuityText: run.tail.text || "(the previous text's ending would go here)",
    continuitySource: run.tail.source || "the previous chapter",
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
}


/**
 * Translate one chapter, then run the deterministic QA over what came back.
 *
 * A per-chapter try/catch isolates failures: a bad chapter (truncated/empty model output, or a
 * deterministic-QA hard fail) is marked FAILED and the loop moves on instead of aborting the whole
 * volume — the draft is simply not written, so a re-run retries it. The continuity tail keeps the last
 * good chapter's ending for the next chapter's prompt.
 *
 * @param {Object} ctx
 * @param {Object} state
 * @param {Object} run - The volume's counters and continuity tail.
 * @param {Object} seg
 * @param {{sourceText: string, sourceHash: string}} chapter
 * @param {string} existingDraft
 * @param {string[]} parts
 * @param {{terms: Object, roleWindow: number, outputReserve: number}} carry
 * @returns {Promise<void>}
 */
async function translateOneChapter(ctx, state, run, seg, chapter, existingDraft, parts, carry) {
  const { volume, volumeDir, targetLanguage, sourceLanguage } = ctx;
  const { draftFile, polishedFile, rejectedFile, bestFile } = chapterArtifactNames(seg.id);
  const draftPath = path.join(volumeDir, draftFile);
  try {
    const draft = await translateChapterParts(ctx, run, seg, parts, carry);

    // Deterministic QA (no AI). A hard failure means this attempt is unusable — but the attempt is NOT
    // thrown away (observed: a residue failure threw the draft out, the completeness gate then aborted
    // the whole task, and volumes 3–17 were never translated; and the QA loop had nothing to correct).
    //   - a usable draft already exists → quarantine this attempt, keep the good one
    //   - there is no usable draft → this text becomes the draft, marked qaFailed, and the QA loop
    //     (verify → retranslate) owns repairing it
    const qa = checkTranslationQa({ sourceText: chapter.sourceText, draftText: draft, terms: ctx.refs.terms, sourceLanguage, targetLanguage });
    if (!qa.ok) {
      await commitRejectedDraft(ctx, state, run, seg, chapter, existingDraft, draft, qa, { rejectedFile, draftPath, polishedFile });
      return;
    }
    await commitDraft(ctx, state, run, seg, chapter, draft, qa, { draftPath, polishedFile, bestFile, rejectedFile });
  } catch (err) {
    run.failed += 1;
    console.error(
      `  Volume ${volume.installmentNumber} ${seg.id}: FAILED — ${err.message} The draft was NOT ` +
        `written, so the chapter will be retried on re-run (no state entry was saved).`
    );
    run.qaRows.push({ id: seg.id, title: seg.title, status: `failed — ${err.message}`, ok: false, cjk: 0, lengthRatio: 0, warnings: [] });
  }
}


/**
 * Translate the chapter part by part (oversized chapters are split; each part continues the previous
 * one) and return the joined draft.
 *
 * @returns {Promise<string>}
 */
async function translateChapterParts(ctx, run, seg, parts, { terms, roleWindow, outputReserve }) {
  const { volume, template, endpoint, sampling, thinkingMode, targetLanguage } = ctx;
  const partTexts = [];
  let continuity = run.tail.text;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const { tasks, dropped: partDrops } = buildBudgetedTaskLines({
      terminologyLines: terms.lines,
      background: ctx.refs.background,
      styleRules: ctx.refs.styleRules,
      voiceNotes: ctx.refs.voiceNotes,
      continuityText: continuity,
      continuitySource: i === 0 ? run.tail.source : "the previous part of this chapter",
      sourceText: part,
      template,
      roleWindow,
      outputReserve,
      targetLanguage,
      label: `Volume ${volume.installmentNumber} ${seg.id} part ${i + 1}`,
    });
    if (partDrops.length > 0) run.promptDrops.push({ id: seg.id, part: i + 1, dropped: partDrops });
    const prompt = buildTranslationPrompt({ template, sourceText: part, tasks });
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: translating part ${i + 1}/${parts.length} ` +
        `(${part.length} chars) with ${endpoint.model}…`
    );
    const result = await harness.runOneShot({
      // NO system prompt — Hy-MT2's official contract is a single user message (systemPrompt: null
      // sends none).
      systemPrompt: null,
      messages: [{ text: prompt }],
      endpoint,
      // The role endpoint's own output cap / context window (harness.js derives them from the global
      // AI_* settings when the role sets neither).
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
    // Continuity dedup: when the model repeats the previous part's ending (the continuity tail it was
    // given) at the start of its reply, strip the duplicated prefix so the merged draft has no
    // repeated passage.
    const deduped = i > 0 ? stripContinuityOverlap(partTexts[i - 1], clean) : clean;
    partTexts.push(deduped);
    continuity = tailOf(deduped, continuityChars);
  }
  return partTexts.join("\n\n");
}


/**
 * The deterministic QA said no. Keep something usable on disk either way.
 * @returns {Promise<void>}
 */
async function commitRejectedDraft(ctx, state, run, seg, chapter, existingDraft, draft, qa, { rejectedFile, draftPath, polishedFile }) {
  const { volume, volumeDir, targetLanguage, sourceLanguage } = ctx;
  const reason = qa.errors.join("; ");
  await fs.writeFile(path.join(volumeDir, rejectedFile), draft + "\n", "utf8");
  const entry = state.chapters[seg.id] || {};
  const hasUsableDraft = existingDraft.trim().length > 0 && entry.qaFailed !== true;
  run.failed += 1;
  if (hasUsableDraft) {
    console.error(
      `  Volume ${volume.installmentNumber} ${seg.id}: new draft REJECTED by deterministic QA ` +
        `(${reason}) — quarantined to ${rejectedFile}; the previous draft is kept.`
    );
    run.tail = tailFrom(existingDraft, `the last usable chapter draft (${seg.id})`);
    run.qaRows.push(
      buildQaRow(seg, chapter.sourceText, existingDraft, ctx.refs, `new attempt rejected — ${reason} (previous draft kept)`, sourceLanguage, targetLanguage)
    );
    return;
  }
  await fs.writeFile(draftPath, draft + "\n", "utf8");
  state.chapters[seg.id] = newStateEntry(ctx, chapter, draft, {
    qaFailed: true,
    // The repair target: verify treats this as a known FAIL (no model call needed — the reason is
    // already known) and retranslate re-drafts it.
    qaFindings: buildPolishGuardFindings(qa),
  });
  await fs.rm(path.join(volumeDir, polishedFile), { force: true });
  await saveTranslationState(path.join(volumeDir, STATE_FILE), state);
  console.error(
    `  Volume ${volume.installmentNumber} ${seg.id}: draft FAILED deterministic QA (${reason}) — ` +
      `written and marked for correction by the translate-qa loop (also kept in ${rejectedFile}).`
  );
  run.tail = tailFrom(draft, `the previous chapter (${seg.id})`);
  run.qaRows.push(buildQaRow(seg, chapter.sourceText, draft, ctx.refs, qa.warnings, sourceLanguage, targetLanguage));
}


/**
 * The deterministic QA said yes: publish the draft, reset the ratchet, and persist per chapter so a
 * crash mid-volume resumes at the next chapter.
 * @returns {Promise<void>}
 */
async function commitDraft(ctx, state, run, seg, chapter, draft, qa, { draftPath, polishedFile, bestFile, rejectedFile }) {
  const { volume, volumeDir, targetLanguage, sourceLanguage } = ctx;
  await fs.writeFile(draftPath, draft + "\n", "utf8");
  state.chapters[seg.id] = newStateEntry(ctx, chapter, draft, { qaFailed: false });
  // A fresh draft invalidates any earlier polish pass (and its files).
  await fs.rm(path.join(volumeDir, polishedFile), { force: true });
  await fs.rm(path.join(volumeDir, bestFile), { force: true });
  await fs.rm(path.join(volumeDir, rejectedFile), { force: true });
  await saveTranslationState(path.join(volumeDir, STATE_FILE), state);
  run.translated += 1;
  run.tail = tailFrom(draft, `the previous chapter (${seg.id})`);
  run.qaRows.push(await buildQaRow(seg, chapter.sourceText, draft, ctx.refs, qa.warnings, sourceLanguage, targetLanguage));
  if (qa.warnings.length > 0) {
    console.warn(`  Volume ${volume.installmentNumber} ${seg.id}: QA warning: ${qa.warnings.join("; ")}`);
  }
}


/**
 * A chapter's state entry.
 *
 * `draftHash` is the hash of the FILE content as written (with trailing newline) — the skip-checks
 * elsewhere compare against the on-disk file. A fresh translation starts a NEW ratchet baseline: the
 * previous best draft belongs to a superseded context and must not be restored into it.
 *
 * @param {Object} ctx
 * @param {{sourceHash: string}} chapter
 * @param {string} draft
 * @param {{qaFailed: boolean, qaFindings?: Array}} extra
 * @returns {Object}
 */
function newStateEntry(ctx, chapter, draft, extra) {
  return {
    sourceHash: chapter.sourceHash,
    contextHash: ctx.refs.contextHash,
    chapterContextHash: chapterContextHash(ctx.refs, chapter.sourceText),
    draftHash: sha256(draft + "\n"),
    retranslated: false,
    findingsHash: null,
    polishedDraftHash: null,
    qaFailed: extra.qaFailed,
    qaFindings: extra.qaFindings ?? null,
    bestScore: null,
    bestDraftHash: null,
    bestVerdict: null,
  };
}

/**
 * The continuity cue for the next chapter: the ending of this text, and an honest label for where it
 * came from.
 * @param {string} text
 * @param {string} source
 * @returns {{text: string, source: string}}
 */
function tailFrom(text, source) {
  return { text: tailOf(text, continuityChars), source };
}


/**
 * Merge the volume's chapters, write the QA report, and hand this volume's published ending to the
 * next one.
 *
 * The merged file is rewritten even when every chapter was skipped (it may be missing after a crash).
 * An incomplete volume is REPORTED here and FAILED by the task at its end: one untranslatable chapter
 * must not stop the rest of the series from being translated.
 *
 * @param {Object} ctx
 * @param {Object} state
 * @param {Object} run
 * @returns {Promise<Object>}
 */
async function finishVolume(ctx, state, run) {
  const { volume, volumeDir, bundle, targetLanguage, sourceLanguage } = ctx;
  const merged = await mergeVolumeTranslationFiles(volumeDir, bundle, state, { sourceLanguage, targetLanguage });
  if (merged.text) {
    await fs.writeFile(path.join(volumeDir, MERGED_FILE), merged.text, "utf8");
  }
  if (merged.missing.length > 0) {
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
    buildQaReportMarkdown(volume, run.qaRows, run.promptDrops),
    "utf8"
  );
  return {
    translated: run.translated,
    skipped: run.skipped,
    failed: run.failed,
    qa: run.qaRows,
    missing: merged.missing,
    unverified: merged.unverified,
    // The published ending of THIS volume, so the next volume's first chapter continues from it.
    tail: {
      text: tailOf(merged.text || "", continuityChars),
      fromLabel: `Volume ${volume.installmentNumber}`,
    },
    emptySourceChapters: run.emptySourceChapters,
  };
}

module.exports = {
  processTranslateVolume,
};

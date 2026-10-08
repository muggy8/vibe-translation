/**
 * One chapter of the correction pass.
 *
 * The chapter's own story, in the order the decisions are made:
 *   1. decideTarget   — does the verification (per-chapter or cross-chapter) ask for a repair at all?
 *   2. worthRewriting — is a whole-chapter rewrite a good trade for what the findings actually say?
 *   3. the verification must cover the CURRENT draft — a stale entry means re-verify first, don't guess
 *   4. alreadyRepaired — the retry budget for an IDENTICAL set of findings
 *   5. repair         — the targeted passage stitch when the mapping can be trusted, otherwise the
 *                       whole-chapter pass (part by part when the chapter is oversized)
 *   6. commit         — the deterministic QA decides whether the correction becomes the draft
 *
 * Part of the retranslate.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");
const harness = require("../harness");
const { writePromptDump } = require("../utils/prompt");
const {
  sha256,
  checkTranslationQa,
  stripMarkdownFence,
  stripThinkBlock,
  tailOf,
  loadTranslationState,
  saveTranslationState,
  chapterTerminology,
  stripContinuityOverlap,
  buildBudgetedTaskLines,
  loadVerificationSidecar,
  worthRetranslating,
  retranslateTarget,
  loadVolumeConsistency,
  findingsForChapter,
  volumeFindingsText,
  planTargetedRepair,
  chapterContextHash,
  STATE_FILE,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
} = require("../utils/translate");
const { fileExists } = require("../utils/fs");
const { chapterArtifactNames } = require("../translate");

const {
  RETRANSLATE_FINDINGS_CHARS,
  continuityChars,
  retranslateRetryBudget,
  retranslateValueMargin,
  targetedFixEnabled,
  PASSING_SCORE,
} = require("./config");
const { runTargetedRepair } = require("./targeted");

/** The volume's own verification sidecar and translation state. */
async function loadVolumeRecords(volumeDir) {
  const sidecar = await loadVerificationSidecar(path.join(volumeDir, VERIFICATION_FILE));
  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  // The cross-chapter audit's findings (volume-consistency.json). A chapter can pass its own
  // source-anchored check at 92/100 and still contradict the chapter before it — the per-chapter
  // verifier structurally cannot see that, so the volume pass's HIGH findings are a repair target of
  // their own.
  const consistency = await loadVolumeConsistency(volumeDir);
  return { sidecar, state, consistency, consistencyFindings: consistency.findings || [] };
}

/**
 * Decide what this chapter needs.
 *
 * @param {Object} ctx - The volume context.
 * @param {Object} run - The volume's counters.
 * @param {Object} seg
 * @param {{sidecar: Object, consistencyFindings: Array}} records
 * @returns {Promise<{ go: boolean, vEntry: Object, volumeFindings: Array, isCrossChapter: boolean }>}
 */
async function decideTarget(ctx, run, seg, { sidecar, consistencyFindings }) {
  const { volume } = ctx;
  const vEntry = sidecar.chapters[seg.id] || {};
  const volumeFindings = findingsForChapter(consistencyFindings, seg.id);
  const target = retranslateTarget(vEntry, volumeFindings);

  if (target.action === "none") {
    run.none += 1;
    return { go: false };
  }
  if (target.action === "skip") {
    run.skipped += 1;
    return { go: false };
  }
  const isCrossChapter = target.action === "cross-chapter";
  if (isCrossChapter) {
    run.crossChapter += 1;
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: verification PASSED (${vEntry.score}/100) but the ` +
        `volume audit found ${target.reason} — repairing this chapter against its neighbours.`
    );
  }

  // Value filter: a retranslate throws away a whole chapter and re-derives it to fix what may be one
  // awkward sentence. Worth it for a meaning / terminology problem; a bad trade for a cosmetic one (the
  // fresh pass can introduce new errors while fixing a nit, and it costs a full chapter of
  // generation). Deferred chapters are counted and logged — never dropped in silence; their findings
  // stay in the verification report. A cross-chapter repair is never filtered: a HIGH finding there is
  // a contradiction, not a nit.
  if (!isCrossChapter && !worthRetranslating(vEntry, PASSING_SCORE)) {
    run.deferred += 1;
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: FAIL at ${vEntry.score}/100 with no HIGH finding ` +
        `and within ${retranslateValueMargin} of the passing line — not worth a whole-chapter rewrite. ` +
        `Left as-is; the findings stay in ${VERIFICATION_REPORT}.`
    );
    return { go: false };
  }
  return { go: true, vEntry, volumeFindings, isCrossChapter };
}

/**
 * The findings this chapter is repaired against, and the key that identifies THAT set of findings.
 * @returns {{ findings: string, findingsHash: string, sameFindings: boolean, attemptsUsed: number, alreadyDone: boolean }}
 */
function findingsForRepair(ctx, seg, vEntry, volumeFindings, sEntry, consistency, sourceHash) {
  const ownFindings = (vEntry.findings || "").slice(0, RETRANSLATE_FINDINGS_CHARS);
  // The volume audit's findings for this chapter, appended as correction tasks. A contradiction has
  // two sides; the prompt tells the model to change only the text it is given, or the "fix" moves the
  // contradiction to another chapter instead of resolving it.
  const crossFindings = volumeFindingsText(volumeFindings);
  const findings = [ownFindings, crossFindings].filter((t) => t.trim()).join("\n\n");
  const findingsHash = sha256(`${vEntry.findings || ""}\n\u0000${consistency.findingsHash || ""}|${seg.id}`);
  const sameFindings = typeof sEntry.findingsHash === "string" && sEntry.findingsHash === findingsHash;
  // (#6) Retry budget: a chapter may be retranslated up to `retranslateRetryBudget` times against an
  // IDENTICAL set of verification findings before the stall guard skips it. The extra shots matter only
  // when the translator is STOCHASTIC — a DIFFERENT findings set resets the budget either way, and so
  // does a raised TRANSLATE_TEMPERATURE. At the model's own greedy default the prompt is identical and
  // greedy decoding reproduces an identical draft, so the second shot against the same findings is a
  // model call that cannot land anywhere new: the budget is spent on the first one. Cross-run re-runs
  // stay cheap: once the budget is spent on these findings, a plain re-run skips.
  const deterministicTranslator = ctx.sampling && ctx.sampling.temperature === 0;
  const retryBudget = deterministicTranslator ? 1 : retranslateRetryBudget;
  const attemptsUsed = sameFindings ? (sEntry.retranslateAttempts ?? 1) : 0;
  const alreadyDone =
    !ctx.force &&
    sEntry.retranslated === true &&
    sEntry.sourceHash === sourceHash &&
    sameFindings &&
    attemptsUsed >= retryBudget;
  return { findings, findingsHash, sameFindings, attemptsUsed, alreadyDone };
}

/**
 * Repair one chapter, then run the deterministic QA over the result and decide whether it becomes the
 * draft.
 *
 * @returns {Promise<void>}
 */
async function repairChapter(ctx, run, seg, { vEntry, volumeFindings }, records) {
  const { volume, volumeDir, refs, template, endpoint, sampling, thinkingMode, dryRun, targetLanguage, sourceLanguage } = ctx;
  const { state, consistency, consistencyFindings } = records;
  const { draftFile, polishedFile, rejectedFile } = chapterArtifactNames(seg.id);
  const chapterPath = path.join(volumeDir, seg.file);
  const draftPath = path.join(volumeDir, draftFile);

  // The verification must cover the CURRENT draft — a stale entry means the draft changed since
  // (re-verify first, don't guess).
  if (!(await fileExists(draftPath))) {
    run.none += 1;
    return;
  }
  const sourceText = await fs.readFile(chapterPath, "utf8");
  const draft = await fs.readFile(draftPath, "utf8");
  const sourceHash = sha256(sourceText);
  const draftHash = sha256(draft);
  const vEntryNow = records.sidecar.chapters[seg.id] || {};
  if (vEntryNow.sourceHash !== sourceHash || vEntryNow.draftHash !== draftHash) {
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: verification is stale for the current draft — ` +
        `skipping (run verify-translate first).`
    );
    run.none += 1;
    return;
  }

  // Only the glossary terms this chapter actually contains go into the prompt.
  const chapterTerms = chapterTerminology(refs, sourceText);
  const sEntry = state.chapters[seg.id] || {};
  const plan = findingsForRepair(ctx, seg, vEntryNow, volumeFindings, sEntry, consistency, sourceHash);
  if (plan.alreadyDone) {
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: already retranslated for these findings ` +
        `(${plan.attemptsUsed}×, budget ${retranslateRetryBudget}) — skipping.`
    );
    run.skipped += 1;
    return;
  }

  const findingsTask =
    plan.findings ||
    "（无发现文本 — 校验分数无法解析；忠实翻译源文即可）";

  // Same part-by-part shape as the translate stage: oversized chapters are split, each part continues
  // the previous one, and the findings — chapter-wide correction tasks — are injected into every part.
  // (#7) The first part's continuity is seeded from the previous chapter's CURRENT draft ending (the
  // translate stage chains chapters this way).
  const cue = run.continuityTails.get(seg.id) || { text: "", source: "" };
  const { parts, plan: splitPlan } = run.planner.split(sourceText, {
    continuityText: cue.text,
    terminologyLines: chapterTerms.lines,
    findingsText: findingsTask,
  });
  if (parts.length > 1) {
    console.log(`  Volume ${volume.installmentNumber} ${seg.id}: split into ${parts.length} part(s) — ${splitPlan.reason}.`);
  }

  if (dryRun) {
    // Dump the first part's prompt for every applicable chapter (one file per chapter, no AI calls in
    // dry-run) — the later parts differ only in the source part and the continuity tail.
    await dumpChapterPreview(ctx, run, seg, vEntryNow, parts, { chapterTerms, cue, findingsTask });
    return;
  }

  const carry = { chapterTerms, cue, findingsTask };
  const wholeChapterPass = () => runWholeChapterPass(ctx, run, seg, parts, carry);

  // ── Targeted correction: repair only the passages the findings point at ──────
  // The whole-chapter pass stays the fallback for every case the mapping cannot be trusted for (see
  // planTargetedRepair). An oversized chapter is already being rewritten in parts, so the passage
  // shortcut does not apply to it.
  let clean = null;
  let repairKind = "whole chapter";
  if (targetedFixEnabled && parts.length === 1) {
    const targeted = planTargetedRepair({ sourceText, draftText: draft, findingsText: findingsTask });
    if (targeted.usable) {
      const stitched = await runTargetedRepair({
        volume,
        seg,
        plan: targeted,
        sourceText,
        draft,
        endpoint,
        template,
        sampling,
        thinkingMode,
        roleWindow: run.roleWindow,
        outputReserve: run.outputReserve,
        sourceLanguage,
        targetLanguage,
        refs,
        chapterTerms,
        cue,
        promptDrops: run.promptDrops,
      });
      if (stitched) {
        clean = stitched;
        repairKind = `targeted repair — ${targeted.reason}`;
      }
    } else {
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: whole-chapter rewrite (${targeted.reason}).`);
    }
  }
  if (!clean) clean = await wholeChapterPass();

  let qa = checkTranslationQa({ sourceText, draftText: clean, terms: refs.terms, sourceLanguage, targetLanguage });
  if (!qa.ok && repairKind !== "whole chapter") {
    // The passage repair broke something the no-AI checks can see (source-script residue, truncation,
    // lost terminology). Quarantine it and run the whole-chapter pass it replaced — a shortcut that
    // makes a chapter worse is not allowed to become the draft.
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
    // Quarantine the rejected correction instead of discarding it: the reason stays on disk, and the
    // chapter keeps the draft it had (the ratchet's baseline is untouched).
    await fs.writeFile(path.join(volumeDir, rejectedFile), clean + "\n", "utf8");
    throw new Error(
      `Volume ${volume.installmentNumber} ${seg.id}: retranslation QA failed: ${qa.errors.join("; ")}. ` +
        `The correction was quarantined to ${rejectedFile} and the previous draft is kept — ` +
        `check .logs/ and re-run.`
    );
  }

  await publishRepair(ctx, run, seg, { clean, qa, repairKind, sourceText, sourceHash, plan, sEntry });
}

/**
 * Publish the correction: overwrite the draft, record how the chapter was repaired, and drop the
 * polished / quarantined files the old draft made.
 * @returns {Promise<void>}
 */
async function publishRepair(ctx, run, seg, { clean, qa, repairKind, sourceText, sourceHash, plan, sEntry }) {
  const { volume, volumeDir, refs } = ctx;
  const { draftFile, polishedFile, rejectedFile } = chapterArtifactNames(seg.id);
  await fs.writeFile(path.join(volumeDir, draftFile), clean + "\n", "utf8");
  run.state.chapters[seg.id] = {
    sourceHash,
    contextHash: refs.contextHash,
    chapterContextHash: chapterContextHash(refs, sourceText),
    // Hash of the FILE content as written (with trailing newline) — the skip-checks elsewhere compare
    // against the on-disk file.
    draftHash: sha256(clean + "\n"),
    retranslated: true,
    findingsHash: plan.findingsHash,
    // (#6) How many times this chapter has been retranslated against THIS findings set (resets when
    // the findings change) — the stall guard's retry budget.
    retranslateAttempts: (plan.sameFindings ? (sEntry.retranslateAttempts ?? 1) : 0) + 1,
    polishedDraftHash: null,
    // A successful retranslation is a real draft: the QA-failure marker goes.
    qaFailed: false,
    // The ratchet baseline SURVIVES a retranslate — that is the whole point: if this new draft scores
    // worse than the best one we already had, the loop rolls back to it instead of publishing the
    // regression.
    bestScore: sEntry.bestScore ?? null,
    bestDraftHash: sEntry.bestDraftHash ?? null,
    bestVerdict: sEntry.bestVerdict ?? null,
    // HOW the chapter was repaired (a whole rewrite or a stitched passage repair) — so a report can
    // tell a cheap fix from an expensive one.
    repairKind,
  };
  await fs.rm(path.join(volumeDir, polishedFile), { force: true });
  await fs.rm(path.join(volumeDir, rejectedFile), { force: true });
  await fs.rm(path.join(volumeDir, rejectedFile.replace(/\.md$/, ".passage.md")), { force: true });
  await saveTranslationState(path.join(volumeDir, "translation-state.json"), run.state);
  run.retranslated += 1;
  console.log(`  Volume ${volume.installmentNumber} ${seg.id}: repaired — ${repairKind}.`);
  if (qa.warnings.length > 0) {
    console.warn(`  Volume ${volume.installmentNumber} ${seg.id}: QA warning: ${qa.warnings.join("; ")}`);
  }
}

/**
 * The whole-chapter pass the passage shortcut replaces: an oversized chapter goes through it part by
 * part, each part continuing the previous one.
 * @returns {Promise<string>}
 */
async function runWholeChapterPass(ctx, run, seg, parts, { chapterTerms, cue, findingsTask }) {
  const { volume, refs, template, endpoint, sampling, thinkingMode, sourceLanguage, targetLanguage } = ctx;
  const partTexts = [];
  let continuity = cue.text;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const { prompt, dropped: partDrops } = buildBudgetedTaskLines({
      terminologyLines: chapterTerms.lines,
      disputedTerms: chapterTerms.disputed,
      background: refs.background,
      styleRules: refs.styleRules,
      voiceNotes: refs.voiceNotes,
      continuityText: continuity || undefined,
      continuitySource: i === 0 ? cue.source || "上一章节" : "本章的上一段",
      findingsText: findingsTask,
      sourceText: part,
      template,
      roleWindow: run.roleWindow,
      outputReserve: run.outputReserve,
      sourceLanguage,
      targetLanguage,
      label: `Volume ${volume.installmentNumber} ${seg.id} part ${i + 1}`,
    });
    if (partDrops.length > 0) run.promptDrops.push({ id: seg.id, part: i + 1, dropped: partDrops });
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: retranslating part ${i + 1}/${parts.length} ` +
        `(${part.length} chars) with ${endpoint.model}…`
    );
    const result = await harness.runOneShot({
      // Index-Translate: single user message, no system prompt. The role endpoint's own output cap /
      // context window (harness.js derives them from the global AI_* settings when the role sets neither).
      systemPrompt: null,
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
      thinkingTemplate: "index-mt",
      label: `retranslate-v${volume.installmentNumber}-${seg.id}-${parts.length > 1 ? "part" + (i + 1) : "full"}`,
    });
    const cleanPart = stripThinkBlock(stripMarkdownFence(result));
    if (!cleanPart) {
      throw new Error(
        `Volume ${volume.installmentNumber} ${seg.id}: the model returned no content for ` +
          `part ${i + 1}. Check .logs/ and re-run.`
      );
    }
    // Continuity dedup (same backstop as the translate stage): when the model repeats the previous
    // part's ending at the start of its reply, strip the duplicated prefix from the merged draft.
    const deduped = i > 0 ? stripContinuityOverlap(partTexts[i - 1], cleanPart) : cleanPart;
    partTexts.push(deduped);
    continuity = tailOf(deduped, continuityChars);
  }
  return partTexts.join("\n\n");
}

/**
 * `--dry-run`: dump the first part's prompt for every applicable chapter. No AI calls.
 * @returns {Promise<void>}
 */
async function dumpChapterPreview(ctx, run, seg, vEntry, parts, { chapterTerms, cue, findingsTask }) {
  const { volume, refs, template, endpoint, thinkingMode, sourceLanguage, targetLanguage } = ctx;
  const { prompt } = buildBudgetedTaskLines({
    terminologyLines: chapterTerms.lines,
    disputedTerms: chapterTerms.disputed,
    background: refs.background,
    styleRules: refs.styleRules,
    voiceNotes: refs.voiceNotes,
    continuityText: cue.text || "（此处为上一段的结尾）",
    continuitySource: cue.source || "上一章节",
    findingsText: findingsTask,
    sourceText: parts[0],
    template,
    roleWindow: run.roleWindow,
    outputReserve: run.outputReserve,
    sourceLanguage,
    targetLanguage,
    label: `Volume ${volume.installmentNumber} ${seg.id}`,
  });
  const file = await writePromptDump(
    `retranslate-${volume.installmentNumber}-${seg.id}`,
    volume.installmentNumber,
    "one-shot (no system prompt — Index-Translate instTrans contract)",
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
}

module.exports = { loadVolumeRecords, decideTarget, repairChapter };

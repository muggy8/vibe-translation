/**
 * The cross-chapter pass — the one thing a per-chapter check structurally cannot see: a name rendered two ways inside the volume, a fact chapter 3 states and chapter 9 denies. It reads the MERGE's own resolver, so the audit and translation.md cannot describe different texts, and a volume larger than the auditor's window is split into windows that say plainly which chapters were never compared.
 *
 * Part of the verify-translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { transformUserPrompt } = require("../utils/prompt");
const {
  sha256,
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  glossaryBlockMaxChars,
  runWithConcurrency,
  stageConcurrency,
  judgeTemperature,
  stageThinking,
  chapterArtifactNames,
  loadVerificationSidecar,
  readFileOrEmpty,
  saveVerificationSidecar,
  findingsOf,
  glossaryBlock,
  medianScore,
  recordBestDraft,
  verdictCoversCurrentDraft,
  estimateTokens,
  fitPromptBudget,
  describeDroppedBlocks,
  findRenderingVariants,
  renderVariantFindings,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  previousVolumeTail,
  tailOf,
  resolvePublishedChapterTexts,
  planConsistencyWindows,
  parseVolumeFindings,
  buildVolumeConsistencyMarkdown,
  loadVolumeConsistency,
  saveVolumeConsistency,
  VOLUME_CONSISTENCY_FILE,
  VOLUME_CONSISTENCY_REPORT,
  loadTranslationState,
  STATE_FILE,
  MERGED_FILE,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
} = require("../utils/translate");

const { CONSISTENCY_TAIL_CHARS, auditTemperature, auditThinking } = require("./config");

/**
 * One audit call per volume window that reads the volume's PUBLISHED chapters
 * TOGETHER.
 *
 * Every other translation check reads one chapter at a time. That is the right
 * shape for fidelity ("does this chapter say what its source says?") and the
 * wrong shape for drift: a volume that renders one name two ways, states a fact
 * in chapter 3 and denies it in chapter 9, or quietly changes tense halfway
 * through publishes chapters that each score 90 and a book that contradicts
 * itself. Nothing in the per-chapter chain can see that class at all.
 *
 * It runs on the AUDIT_* role, inside the SAME batch as the borderline
 * tiebreak — one container switch for both cross-checks, never interleaved
 * with the verifier.
 *
 * It reads what the reader reads: `resolvePublishedChapterTexts` is the merge's
 * own rule, so the audit and `translation.md` cannot describe different texts.
 *
 * Findings are chapter-tagged and written to `volume-consistency.json`, which
 * the retranslate pass reads as correction tasks for the named chapters (the
 * draft ratchet guarantees a repair that scores worse is rolled back).
 *
 * Idempotent: the sidecar records the hash of the published volume text plus
 * the reference fingerprint, so a re-run re-audits only a volume whose text or
 * references actually changed.
 *
 * @param {{
 *   volume: {installmentNumber: string, folder: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<Object>},
 *   refs: {glossaryText: string, styleRules: string, contextHash: string},
 *   systemPrompt: string,
 *   template: string,
 *   auditEndpoint: {model: string, contextWindow?: number, maxTokens?: number},
 *   prevTail: string,
 *   force: boolean,
 * }} ctx
 * @returns {Promise<{windows: number, findings: Array<Object>, skipped: string|null, findingsHash: string}>}
 */
async function runVolumeConsistencyPass({
  volume,
  volumeDir,
  bundle,
  refs,
  systemPrompt,
  template,
  auditEndpoint,
  prevTail,
  force,
}) {
  const out = { windows: 0, findings: [], skipped: null, findingsHash: "" };

  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  const published = await resolvePublishedChapterTexts(volumeDir, bundle, state);
  const withText = published.filter((c) => c.text);
  if (withText.length < 2) {
    // One chapter (or none) has no cross-chapter relations to audit.
    out.skipped = withText.length === 0 ? "no chapter text published" : "only one chapter has text";
    return out;
  }

  const volumeHash = sha256(withText.map((c) => `${c.id}\u0000${c.text}`).join("\n"));
  const existing = await loadVolumeConsistency(volumeDir);
  if (
    !force &&
    existing.volumeHash === volumeHash &&
    existing.contextHash === refs.contextHash &&
    existing.model === auditEndpoint.model
  ) {
    out.skipped = "already audited for this volume text and reference state";
    out.windows = (existing.windows || []).length;
    out.findings = existing.findings || [];
    out.findingsHash = existing.findingsHash || "";
    return out;
  }

  const roleWindow = auditEndpoint.contextWindow || 0;
  const outputReserve = auditEndpoint.maxTokens || 0;
  // The references are part of the request too: reserve for them so the windows
  // are sized for the call that will actually be made, not for the text alone.
  const referenceTokens =
    estimateTokens(systemPrompt) +
    estimateTokens(template) +
    estimateTokens(refs.glossaryText) +
    estimateTokens(refs.styleRules) +
    600;
  const windows = planConsistencyWindows(withText, {
    maxTokens: roleWindow,
    reserve: outputReserve + referenceTokens,
  });

  const findings = [];
  const dropped = [];
  const notes = [];
  const windowSummaries = [];
  let previousWindowTail = prevTail || "";

  for (const [wi, win] of windows.entries()) {
    const ids = win.chapters.map((c) => c.id);
    const chapterTable = win.chapters
      .map((c) => `- \`${c.id}\` — ${c.title || c.id} (${c.text.length} chars)`)
      .join("\n");
    const volumeText = win.chapters
      .map((c) => `--- CHAPTER ${c.id}: ${c.title || c.id} ---\n\n${c.text}`)
      .join("\n\n");

    const tail = previousWindowTail
      ? `This pass begins mid-volume. The text the auditor saw BEFORE this pass ended with:\n\n…${previousWindowTail}`
      : "(this is the first volume in the series — there is no previous volume)";

    const fixedTokens = estimateTokens(volumeText) + estimateTokens(chapterTable) + 400;
    const fitted = fitPromptBudget({
      blocks: [
        { name: "canonical glossary", text: refs.glossaryText || "", priority: 5 },
        { name: "house style rules", text: refs.styleRules || "", priority: 4 },
        { name: "previous volume / window tail", text: tail, priority: 3 },
      ],
      fixedTokens,
      roleWindow,
      outputReserve,
    });
    for (const d of fitted.dropped) dropped.push(`${d.name} (${d.chars} chars) in audit window ${wi + 1}`);

    const prompt = transformUserPrompt(template, {
      VOLUME_LABEL: `Volume ${volume.installmentNumber} (${volume.folder})`,
      TARGET_LANGUAGE: "the target language of this translation",
      CHAPTER_COUNT: String(win.chapters.length),
      CHAPTER_TABLE: chapterTable,
      PREVIOUS_TAIL: fitted.blocks.find((b) => b.name === "previous volume / window tail")?.text || "(not provided)",
      GLOSSARY: fitted.blocks.find((b) => b.name === "canonical glossary")?.text || "(none provided — run the glossary task)",
      STYLE_RULES: fitted.blocks.find((b) => b.name === "house style rules")?.text || "(none provided — run the style-guide task)",
      VOLUME_TEXT: volumeText,
    });

    let reply;
    try {
      reply = await harness.runOneShot({
        systemPrompt,
        messages: [{ text: prompt }],
        endpoint: auditEndpoint,
        maxTokens: auditEndpoint.maxTokens,
        contextWindow: auditEndpoint.contextWindow,
        temperature: auditTemperature,
        thinking: auditThinking.thinking,
        thinkingLevel: auditThinking.thinkingLevel,
        label: `volume-consistency-${volume.installmentNumber}-w${wi + 1}`,
      });
    } catch (err) {
      // The pass is an extra pair of eyes, not a gate: a failed audit call is
      // reported and the volume keeps its per-chapter verdicts.
      notes.push(
        `Audit window ${wi + 1} (${ids.join(", ")}) could not be audited: ${err.message}`
      );
      windowSummaries.push({ chapters: ids, tokens: win.tokens, oversized: win.oversized, failed: true });
      continue;
    }

    const parsed = parseVolumeFindings(reply, ids);
    for (const f of parsed) findings.push(f);
    windowSummaries.push({ chapters: ids, tokens: win.tokens, oversized: win.oversized, failed: false });
    previousWindowTail = tailOf(win.chapters.map((c) => c.text).join("\n\n"), CONSISTENCY_TAIL_CHARS);
  }

  const untagged = findings.filter((f) => f.untagged).length;
  if (untagged > 0) {
    notes.push(
      `${untagged} finding(s) named no chapter id the pass provided — recorded, but the retranslate pass cannot act on them.`
    );
  }
  for (const win of windows) {
    if (win.oversized) {
      notes.push(
        `Chapter ${win.chapters.map((c) => c.id).join(", ")} is larger than the auditor's whole context window: it was audited alone, not against its neighbours.`
      );
    }
  }

  const findingsHash = sha256(
    findings.map((f) => `${f.severity}|${(f.chapters || []).join(",")}|${f.statement}`).join("\n")
  );
  const data = {
    schema: 1,
    volume: volume.installmentNumber,
    volumeHash,
    contextHash: refs.contextHash,
    model: auditEndpoint.model,
    generatedAt: new Date().toISOString(),
    windows: windowSummaries,
    findings,
    findingsHash,
    notes,
  };
  await saveVolumeConsistency(volumeDir, data);
  await fs.writeFile(
    path.join(volumeDir, VOLUME_CONSISTENCY_REPORT),
    buildVolumeConsistencyMarkdown(volume, windowSummaries, findings, {
      model: describeEndpoint(auditEndpoint),
      notes,
      dropped,
    }),
    "utf8"
  );

  out.windows = windowSummaries.length;
  out.findings = findings;
  out.findingsHash = findingsHash;
  const high = findings.filter((f) => f.severity === "HIGH").length;
  console.log(
    `  Volume ${volume.installmentNumber}: cross-chapter audit over ${windowSummaries.length} window(s) — ` +
      `${findings.length} finding(s) (${high} HIGH).`
  );
  return out;
}

// ─── Per-volume processing ──────────────────────────────────────────────────


module.exports = {
  runVolumeConsistencyPass,
};

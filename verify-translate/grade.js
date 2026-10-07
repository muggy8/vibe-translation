/**
 * One chapter's verdict: the source-anchored prompt, the 0–100 grade (fail-closed — unparseable is a FAIL), the repeat sampling whose MEDIAN is the score, and the deterministic seed that grades a deterministic-QA failure with no model call at all.
 *
 * Part of the verify-translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { transformUserPrompt, parseAcceptanceScore, writePromptDump } = require("../utils/prompt");
const {
  parseGlossaryDisputes,
  collectVolumeDisputes,
  mergeDisputes,
  loadGlossaryDisputes,
  saveGlossaryDisputes,
  DISPUTES_FILE,
  DISPUTES_REPORT,
} = require("../utils/disputes");
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

const { FINDINGS_MAX_CHARS, passingScore, sampleBand, sampleTolerance, verifyConcurrency, verifySamples, verifyTemperature, verifyThinking } = require("./config");

/**
 * The verify prompt for one chapter — shared by every grading pass (first
 * sample, repeat samples, audit tiebreak) so they cannot drift apart.
 *
 * @param {{template: string, sourceText: string, draft: string, refs: {terms: Array, styleRules: string, background: string}}} p
 * @returns {string}
 */
/**
 * The verify prompt for one chapter, fitted into the grader's context window.
 *
 * The source text and the draft are never trimmed (a grader that cannot see the
 * whole chapter cannot grade it) — the reference blocks are what give way, and
 * the drop list is returned so the caller can log it.
 *
 * @param {{template: string, sourceText: string, draft: string, refs: {terms: Array, styleRules: string, background: string}, roleWindow: number, outputReserve: number}} p
 * @returns {{prompt: string, dropped: Array<{name: string, chars: number}>}}
 */
function buildVerifyPrompt({ template, sourceText, draft, refs, roleWindow, outputReserve }) {
  const fitted = fitPromptBudget({
    blocks: [
      { name: "glossary", text: glossaryBlock(chapterTerminology(refs, sourceText).terms), priority: 5 },
      { name: "style rules", text: refs.styleRules || "", priority: 3 },
      { name: "story background", text: refs.background || "", priority: 2 },
    ],
    fixedTokens: estimateTokens(sourceText) + estimateTokens(draft) + estimateTokens(template) + 120,
    roleWindow,
    outputReserve,
  });
  const pick = (name, fallback) => {
    const b = fitted.blocks.find((x) => x.name === name);
    return b && b.text.trim() ? b.text : fallback;
  };
  return {
    prompt: transformUserPrompt(template, {
      SOURCE_TEXT: sourceText,
      TRANSLATION_TEXT: draft,
      GLOSSARY: pick("glossary", "(none provided — run the glossary task)"),
      STYLE_RULES: pick("style rules", "(none provided — run the style-guide task)"),
      BACKGROUND: pick("story background", "(none provided — run the jump-in-wiki task)"),
    }),
    dropped: fitted.dropped,
  };
}


/**
 * One grading call for one chapter → { score, findings }.
 *
 * @param {{
 *   volume: {installmentNumber: string},
 *   systemPrompt: string,
 *   template: string,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   sourceText: string,
 *   draft: string,
 *   refs: Object,
 *   label: string,
 *   temperature?: number,
 *   thinking?: {thinking: boolean, thinkingLevel: string},
 * }} p
 * @returns {Promise<{score: number|null, findings: string}>}
 */
async function gradeChapter({ volume, systemPrompt, template, endpoint, sourceText, draft, refs, label, temperature, thinking }) {
  const th = thinking || verifyThinking;
  const roleWindow = endpoint.contextWindow || harness.envContextWindow();
  const outputReserve = endpoint.maxTokens || harness.envMaxTokens();
  const { prompt, dropped } = buildVerifyPrompt({ template, sourceText, draft, refs, roleWindow, outputReserve });
  if (dropped.length > 0) describeDroppedBlocks(dropped, `Volume ${volume.installmentNumber} ${label}`);
  const result = await harness.runOneShot({
    systemPrompt,
    messages: [{ text: prompt }],
    endpoint,
    // The role endpoint's own output cap / context window (harness.js derives
    // them from the global AI_* settings when the role sets neither).
    maxTokens: endpoint.maxTokens,
    contextWindow: endpoint.contextWindow,
    temperature: Number.isFinite(temperature) ? temperature : verifyTemperature,
    thinking: th.thinking,
    thinkingLevel: th.thinkingLevel,
    label,
  });
  return {
    score: parseAcceptanceScore(result),
    findings: findingsOf(result, FINDINGS_MAX_CHARS),
    // A challenge to the GLOSSARY itself (the translation was right, the entry
    // was not). Recorded so it can travel back to the glossary task instead of
    // dying in a report while the retranslate pass keeps obeying the wrong entry.
    disputes: parseGlossaryDisputes(result),
  };
}


/**
 * The repeat-sample batch (the same gate the pre-production artifacts use,
 * applied to the deliverable).
 *
 * A chapter's fate is decided by ONE stochastic score while the reference
 * artifacts require a rolling window of samples plus a temperature-0 anchor.
 * The deliverable deserves the same rigour — but only where the decision is
 * actually close: chapters within ±VERIFY_SAMPLE_BAND of the passing line.
 * Two samples further apart than ACCEPTANCE_SCORE_TOLERANCE are settled by a
 * third at temperature 0, and the MEDIAN is the verdict, so one outlier cannot
 * move a chapter across the line.
 *
 * Batched: every chapter's second sample runs as its own batch on the same
 * verify endpoint (no model switch).
 *
 * @param {{
 *   volume: {installmentNumber: string, folder: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string}>},
 *   refs: Object,
 *   systemPrompt: string,
 *   template: string,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   sidecar: {chapters: Object},
 *   sidecarPath: string,
 * }} ctx
 * @returns {Promise<Array<{id: string, samples: number[], score: number}>>} The chapters whose verdict was resampled.
 */
async function runVerificationSamples({ volume, volumeDir, bundle, refs, systemPrompt, template, endpoint, sidecar, sidecarPath }) {
  const targets = [];
  for (const seg of bundle.segments) {
    const e = sidecar.chapters[seg.id];
    if (!e) continue;
    if (e.deterministic) continue; // no model call to repeat — the reason is deterministic
    if (typeof e.score !== "number") continue; // unparseable: already a FAIL, the retranslate pass retries it
    if (Array.isArray(e.samples) && e.samples.length >= verifySamples) continue;
    if (Math.abs(e.score - passingScore) > sampleBand) continue; // not a close call
    targets.push(seg);
  }
  if (targets.length === 0) return [];

  console.log(
    `[verify-translate] ${targets.length} chapter(s) within ±${sampleBand} of the passing score — ` +
      `taking repeat samples (up to ${verifySamples} per chapter; a disagreement beyond ` +
      `±${sampleTolerance} is settled at temperature 0).`
  );

  const resampled = [];
  await runWithConcurrency(targets, verifyConcurrency, async (seg) => {
    const { draftFile } = chapterArtifactNames(seg.id);
    let sourceText;
    let draft;
    try {
      sourceText = await fs.readFile(path.join(volumeDir, seg.file), "utf8");
      draft = await fs.readFile(path.join(volumeDir, draftFile), "utf8");
    } catch {
      return; // source/draft vanished since the first pass
    }
    const e = sidecar.chapters[seg.id];
    if (e.sourceHash !== sha256(sourceText) || e.draftHash !== sha256(draft)) return; // stale entry

    const samples = Array.isArray(e.samples) && e.samples.length > 0 ? [...e.samples] : [e.score];
    let settled = false;
    while (samples.length < verifySamples && !settled) {
      const spread = Math.max(...samples) - Math.min(...samples);
      if (samples.length >= 2 && spread <= sampleTolerance) {
        settled = true;
        break;
      }
      // The tie-breaking sample is the calm one: temperature 0, no thinking.
      const tieBreak = samples.length >= 2;
      const graded = await gradeChapter({
        volume,
        systemPrompt,
        template,
        endpoint,
        sourceText,
        draft,
        refs,
        label: `verify-sample${samples.length + 1}-v${volume.installmentNumber}-${seg.id}`,
        temperature: tieBreak ? 0 : verifyTemperature,
        thinking: tieBreak ? { thinking: false, thinkingLevel: null } : undefined,
      });
      if (graded.score === null) break; // an unparseable repeat does not improve the evidence
      samples.push(graded.score);
    }

    const score = medianScore(samples);
    const pass = score !== null && score >= passingScore;
    sidecar.chapters[seg.id] = {
      ...e,
      score,
      pass,
      samples,
      verifiedAt: new Date().toISOString(),
    };
    await saveVerificationSidecar(sidecarPath, sidecar);
    resampled.push({ id: seg.id, samples, score });
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: samples [${samples.join(", ")}] → median ` +
        `${score}/100 → ${pass ? "PASS" : "FAIL"}.`
    );
  });
  return resampled;
}


module.exports = {
  buildVerifyPrompt,
  gradeChapter,
  runVerificationSamples,
};

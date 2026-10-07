/**
 * The re-polish: the failed audit's findings injected as a numbered "fix these" task (the retranslate pattern), on the EDIT_* endpoint.
 *
 * Part of the polish.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const tokens = require("../utils/tokens");
const { transformUserPrompt } = require("../utils/prompt");
const {
  sha256,
  checkTranslationQa,
  buildPolishGuardFindings,
  stripMarkdownFence,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  runWithConcurrency,
  stageConcurrency,
  judgeTemperature,
  stageThinking,
  writerTemperature,
  estimateTokens,
  fitPromptBudget,
  describeDroppedBlocks,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  glossaryBlock,
  loadVerificationSidecar,
  readFileOrEmpty,
  saveVerificationSidecar,
  findingsOf,
  chapterArtifactNames,
  MERGED_FILE,
  STATE_FILE,
  POLISH_QA_REPORT,
  POLISH_VERIFICATION_FILE,
} = require("../utils/translate");

const { POLISH_FINDINGS_MAX_CHARS, polishConcurrency, polishTemperature, polishThinking } = require("./config");
const { fitReferenceBlocks, polishReferenceBlocks } = require("./references");

/**
 * (#3/#4) The batched re-polish — the correction pass over the candidates the
 * audit failed. Each is re-polished on the edit endpoint (NO source text —
 * surface cleanup) with the audit's findings injected as a numbered "fix
 * these" task (the retranslate pattern). The new candidate is written and
 * marked pending the next audit round. The caller wraps this in the polish
 * hook (on local setups: the switch back to the edit container).
 *
 * @param {{
 *   volume: {installmentNumber: string}, volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string}>},
 *   refs: {terms: Array<{term: string, rendering: string}>, styleRules: string, voiceNotes: string, contextHash: string},
 *   systemPrompt: string, template: string,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   state: {chapters: Object},
 *   failed: Array<{id: string, findings: string, draftHash: string}>,
 * }} ctx
 * @returns {Promise<void>}
 */
async function runRePolish({ volume, volumeDir, bundle, refs, systemPrompt, template, endpoint, state, failed }) {
  // The audit that just graded these candidates ran on a DIFFERENT model, and the
  // active token calibration is process-global — re-point it at the polisher's
  // tokenizer before budgeting this phase's prompts.
  tokens.useCalibrationFor(endpoint);
  console.log(
    `[polish] re-polishing ${failed.length} chapter(s) with ${endpoint.model} (audit findings injected)…`
  );
  await runWithConcurrency(failed, polishConcurrency, async ({ id, findings, draftHash }) => {
    const { draftFile, polishedFile } = chapterArtifactNames(id);
    const draft = await fs.readFile(path.join(volumeDir, draftFile), "utf8");
    // Chapter-scoped terminology: the polisher sees no source text, so the
    // selection is anchored on the chapter's own source file.
    const seg = bundle.segments.find((s) => s.id === id);
    let chapterSource = "";
    try {
      chapterSource = await fs.readFile(path.join(volumeDir, seg.file), "utf8");
    } catch {
      chapterSource = "";
    }
    const findingsText = findings ? findings.slice(0, POLISH_FINDINGS_MAX_CHARS) : "(none)";
    const { pick } = fitReferenceBlocks({
      blocks: polishReferenceBlocks({ refs, sourceText: chapterSource }),
      fixedTokens: estimateTokens(draft) + estimateTokens(findingsText) + estimateTokens(template) + 120,
      endpoint,
      label: `Volume ${volume.installmentNumber} ${id} (re-polish)`,
    });
    const values = {
      TRANSLATION_TEXT: draft,
      GLOSSARY: pick("GLOSSARY", "(none provided — run the glossary task)"),
      STYLE_RULES: pick("STYLE_RULES", "(none provided — run the style-guide task)"),
      VOICE_NOTES: pick("VOICE_NOTES", "(none provided — run the character-voice task)"),
      POLISH_FINDINGS: findingsText,
    };
    const prompt = transformUserPrompt(template, values);
    const result = await harness.runOneShot({
      systemPrompt,
      messages: [{ text: prompt }],
      endpoint,
      // The role endpoint's own output cap / context window (harness.js derives
      // them from the global AI_* settings when the role sets neither).
      maxTokens: endpoint.maxTokens,
      contextWindow: endpoint.contextWindow,
      temperature: Number.isFinite(polishTemperature) ? polishTemperature : 0.6,
      thinking: polishThinking.thinking,
      thinkingLevel: polishThinking.thinkingLevel,
      label: `polish-v${volume.installmentNumber}-${id}-audit-retry`,
    });
    const attemptText = stripMarkdownFence(result);
    if (!attemptText) {
      throw new Error(
        `Volume ${volume.installmentNumber} ${id}: the model returned no content for the audit re-polish. ` +
          `Check .logs/ and re-run.`
      );
    }
    await fs.writeFile(path.join(volumeDir, polishedFile), attemptText + "\n", "utf8");
    const e = state.chapters[id] || {};
    state.chapters[id] = {
      ...e,
      polishedDraftHash: draftHash,
      polishVerifiedDraftHash: null, // pending the next audit round
      // Persist the audit findings that triggered this re-polish: if the run
      // ends with the chapter still failing, they seed the next run's re-polish.
      polishFindings: findings,
      polishFindingsHash: findings ? sha256(findings) : null,
    };
  });
}


/**
 * Re-polish one volume's audit-failed candidates on the edit endpoint, with the
 * audit findings injected as a numbered correction task (the retranslate
 * pattern). Called inside the task-level re-polish batch.
 *
 * @param {Object} vc - The volume context.
 * @param {{systemPrompt: string, template: string, endpoint: Object}} ctx
 */
async function runPolishRepairRound(vc, { systemPrompt, template, endpoint }) {
  await runRePolish({
    volume: vc.volume,
    volumeDir: vc.volumeDir,
    bundle: vc.bundle,
    refs: vc.refs,
    systemPrompt,
    template,
    endpoint,
    state: vc.state,
    failed: vc.auditPending,
  });
  await saveTranslationState(path.join(vc.volumeDir, STATE_FILE), vc.state);
}


module.exports = {
  runRePolish,
  runPolishRepairRound,
};

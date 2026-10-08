/**
 * The targeted correction: re-translate ONLY the passages the verification findings point at, and
 * stitch the corrected text back into the chapter's existing draft.
 *
 * The whole-chapter pass is the blunt instrument — one bad sentence costs a full chapter of
 * generation and a fresh chance to break something that was already right. The findings quote short
 * source spans, so the spans can be found. This module does the passage passes; `planTargetedRepair`
 * (utils/translate) decides whether the source↔draft mapping can be trusted at all, and the caller
 * re-runs the deterministic QA on the STITCHED chapter, so a repair that breaks the seams (or
 * duplicates a paragraph) is caught before it becomes the draft.
 *
 * Part of the retranslate.js layer (split out of the original single file).
 */

const harness = require("../harness");
const {
  buildBudgetedTaskLines,
  stripMarkdownFence,
  stripThinkBlock,
  paragraphBlocks,
  stitchParagraphs,
  buildPassageScopeLine,
} = require("../utils/translate");

const { TARGETED_CONTEXT_BLOCKS } = require("./config");

/**
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
 *   sourceLanguage: string,
 *   targetLanguage: string,
 *   refs: Object,
 *   chapterTerms: {lines: string[]},
 *   cue: {text: string, source: string},
 *   promptDrops: Array<Object>,
 * }} ctx
 * @returns {Promise<string|null>} The stitched draft, or null to fall back to the whole-chapter pass.
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
  sourceLanguage,
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
    // Only the findings whose quoted span lives in THIS passage — plus the chapter-wide ones
    // planTargetedRepair could not locate. Injecting a finding about paragraph 7 into the pass that
    // rewrites paragraph 2 invites the model to "fix" it in the wrong place.
    const blockFindings = (block.findings || []).filter((t) => t && t.trim()).join("\n\n");
    const findingsText =
      blockFindings || "（本片段没有具体发现 — 忠实翻译源文即可）";
    const scopeText = buildPassageScopeLine({
      before,
      after,
      blockNumber: bi + 1,
      blockCount: plan.blocks.length,
    });

    const { prompt, dropped } = buildBudgetedTaskLines({
      terminologyLines: chapterTerms.lines,
      disputedTerms: chapterTerms.disputed,
      background: refs.background,
      styleRules: refs.styleRules,
      voiceNotes: refs.voiceNotes,
      continuityText: cue.text || undefined,
      continuitySource: cue.source || "上一章节",
      findingsText,
      scopeText,
      sourceText: srcSpan,
      template,
      roleWindow,
      outputReserve,
      sourceLanguage,
      targetLanguage,
      label: `Volume ${volume.installmentNumber} ${seg.id} passage ${bi + 1}`,
    });
    if (dropped.length > 0) promptDrops.push({ id: seg.id, part: `passage ${bi + 1}`, dropped });
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: repairing passage ${bi + 1}/${plan.blocks.length} ` +
        `(source paragraphs ${block.start + 1}–${block.end + 1}, ${srcSpan.length} chars) with ${endpoint.model}…`
    );
    const text = stripThinkBlock(stripMarkdownFence(await runPassageModel({ endpoint, sampling, thinkingMode, prompt, volume, seg, bi })));
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

/**
 * One passage's model call. Index-Translate's request format is a single user message and no system
 * prompt — the same contract the whole-chapter pass uses, so a shortcut and the pass it replaces
 * cannot drift.
 * @returns {Promise<string>}
 */
function runPassageModel({ endpoint, sampling, thinkingMode, prompt, volume, seg, bi }) {
  return harness.runOneShot({
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
    label: `retranslate-v${volume.installmentNumber}-${seg.id}-passage${bi + 1}`,
  });
}

module.exports = { runTargetedRepair };

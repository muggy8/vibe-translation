/**
 * The amend pass turn: run the author agent over the seeded glossary, then run the deterministic carry-forward gate over what it wrote. Kept apart from the instruction helpers because those prompts are shared by the amend, feedback and per-chapter passes, while this is the pass that calls them.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { AGENT_TOOLS_NOTE } = require("../configs/shared");
const { assertRealToolCalls } = require("../utils/agents");
const { runWriteTurn } = require("../utils/qa-loop");

const { buildGlossaryAuthorTurnPrompt } = require("./prompts");
const { glossaryAuthorMaxSteps, glossaryRecoveryPrompt } = require("./authoring");

/**
 * Generate (or regenerate) the glossary using a standalone author agent.
 * The agent is created and closed within this function — no persistent session.
 * With `seg` set (chunked fallback) the pass is scoped to one chapter: the
 * prompt names the chapter file and the current in-volume state.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {Array<{term: string, type: string, query: string}>} terms - The new terms.
 * @param {boolean} researchNotesAvailable - Whether research notes exist.
 * @param {SourceSegment|null} [seg] - The chapter being processed (fallback).
 * @param {number} [si] - Zero-based position of the chapter in reading order.
 * @returns {Promise<void>}
 */
async function generateGlossary(ctx, terms, researchNotesAvailable, seg = null, si = null) {
  const { values, volumeDir, glossaryOutputFile } = ctx;
  const labelSuffix = seg ? `-${seg.id}` : "";

  const author = await harness.createAgentHandle({
    name: `author-${values.INSTALLMENT_NUMBER}${labelSuffix}`,
    systemPrompt: ctx.glossarySystemPrompt + AGENT_TOOLS_NOTE,
    tools: ctx.fsGate.tools,
    approve: ctx.fsGate.approve,
    cwd: volumeDir,
    maxSteps: await glossaryAuthorMaxSteps(ctx, seg),
  });
  try {
    await runWriteTurn(author, {
      prompt: buildGlossaryAuthorTurnPrompt(ctx, terms, researchNotesAvailable, seg, si),
      label: `glossary-amend-${values.INSTALLMENT_NUMBER}${labelSuffix}`,
      who: `the author agent (amend${seg ? `, chapter ${seg.id}` : ""})`,
      writesTo: glossaryOutputFile,
      recoveryPrompt: (hasContent) =>
        glossaryRecoveryPrompt(hasContent, '"glossary.md"', "the volume source and the new-terms list"),
      recoveryLabel: `glossary-recovery-${values.INSTALLMENT_NUMBER}`,
      recoveryWho: "the author agent (recovery)",
      recoveryNote:
        `Volume ${values.INSTALLMENT_NUMBER}: sending recovery turn ` +
        `(model replied in chat instead of writeFile)...`,
      // Hard stop: the recovery turn is the last chance — a still-missing or empty glossary is a
      // failure, not an output.
      verifyOutput: true,
      assertToolCalls: (result, whoLabel) => assertRealToolCalls(result, whoLabel, values.INSTALLMENT_NUMBER),
    });

    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: saved the glossary to ${glossaryOutputFile}`
    );
  } finally {
    await author.close();
  }
}


module.exports = {
  generateGlossary,
};

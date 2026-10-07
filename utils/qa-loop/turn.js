/**
 * utils/qa-loop/turn.js — the one way a QA stage hands a task to an agent and
 * makes sure the task actually ended up on disk.
 *
 * Every validator pass, findings merge and feedback pass in this repository is
 * the same six-step exchange, and each task used to write it out again (nine
 * copies between the two QA loops). The steps are: send the turn; refuse a tool
 * call the model emitted as plain text; if the expected file is missing, try to
 * rescue it from the chat reply; if that rescue was needed, send the task once
 * more to the SAME agent; then refuse to continue over a file that is still
 * missing, empty, or the scaffold stub the workflow pre-wrote.
 *
 * Part of the utils/qa-loop.js layer (split out of the original single file).
 */

const path = require("path");
const harness = require("../../harness");
const { assertWroteWithFallback, assertRealOutput } = require("../fs");
const { assertRealToolCalls } = require("../agents");

/**
 * The file label a recovery prompt names: "glossary.md", or "wiki.md" and
 * "shared-wiki.md" when the stage owes two documents.
 *
 * @param {string|string[]} writesTo - The file path(s) the agent was asked to write.
 * @returns {string}
 */
function quotedFileLabels(writesTo) {
  const paths = Array.isArray(writesTo) ? writesTo : [writesTo];
  return paths.map((p) => `"${path.basename(p)}"`).join(" and ");
}

/**
 * The recovery prompt a QA stage gets when it does not supply its own.
 *
 * It is only ever sent after a turn that left its output file missing, so it can
 * state plainly what happened instead of guessing.
 *
 * @param {boolean} hasContent - True when the agent said the content in chat but
 *   did not write it to a file.
 * @param {string|string[]} writesTo - The file path(s) it owes.
 * @returns {string}
 */
function defaultRecoveryPrompt(hasContent, writesTo) {
  const label = quotedFileLabels(writesTo);
  return hasContent
    ? `You were asked to write ${label} using writeFile, but you replied with the content in your chat message instead. Please rewrite the complete document using writeFile now.`
    : `You produced no output. Please read the materials and write ${label} using writeFile now.`;
}

/**
 * The validator-report recovery prompt the three tasks that have always used one
 * share word for word. Kept here so the fourth task cannot drift from it.
 *
 * @param {boolean} hasContent - True when the agent replied in chat instead of writing.
 * @param {string} partialFile - The validation report the validator owes.
 * @returns {string}
 */
function validationReportRecoveryPrompt(hasContent, partialFile) {
  const label = `"${path.basename(partialFile)}"`;
  return hasContent
    ? `You were asked to write the validation report to ${label} using writeFile, but you replied with the content in your chat message instead. Please rewrite the complete report using writeFile now.`
    : `You produced no output. Please read the materials and write the complete validation report to ${label} using writeFile now.`;
}

/**
 * Send one turn to an already-open agent and enforce that it produced a file.
 *
 * @param {{sendTurn: (prompt: string, opts: {label?: string}) => Promise<{text?: string}>}} agent
 * @param {{
 *   prompt: string,
 *   label: string,
 *   who: string,
 *   writesTo: string|string[],
 *   assertToolCalls: (result: Object, who: string) => void,
 *   recoveryPrompt?: (hasContent: boolean) => string,
 *   recoveryLabel?: string,
 *   recoveryWho?: string,
 *   recoveryNote?: string,
 *   verifyOutput?: boolean,
 * }} o - `who` names this agent in the failure messages; `recoveryNote` is what the stage prints
 *   before it sends the second turn, in its own words; `verifyOutput` gates the final "did it
 *   actually write?" stop (see assertRealOutput in utils/fs.js).
 * @returns {Promise<{fallbackUsed: boolean}>} `fallbackUsed` when the chat reply
 *   had to stand in for a missing file (or nothing usable was found).
 */
async function runWriteTurn(agent, o) {
  const result = await agent.sendTurn(o.prompt, { label: o.label });
  o.assertToolCalls(result, o.who);
  const fallbackUsed = await assertWroteWithFallback(o.writesTo, o.who, result?.text);

  // Recovery turn: ONLY when the file was actually missing after the fallback —
  // never over a file the agent already wrote correctly.
  if (fallbackUsed && o.recoveryPrompt && process.env.AGENT_RECOVERY_ENABLED !== "false") {
    // A stage may say what it is about to do, in its own words, before the second turn.
    if (o.recoveryNote) console.log(o.recoveryNote);
    const hasContent = result?.text && result.text.trim().length > 0;
    const recovery = await agent.sendTurn(o.recoveryPrompt(hasContent), {
      label: o.recoveryLabel || `${o.label}-recovery`,
    });
    o.assertToolCalls(recovery, o.recoveryWho || `${o.who} (recovery)`);
    await assertWroteWithFallback(o.writesTo, o.recoveryWho || `${o.who} (recovery)`, recovery?.text);
  }

  if (o.verifyOutput) {
    await assertRealOutput(o.writesTo, o.who);
  }
  return { fallbackUsed };
}

/**
 * Open one agent for one QA stage, run its turn, and close it — the same
 * lifecycle for a chapter validator, the findings merger and a chapter's
 * feedback author.
 *
 * @param {import("./chunked").QaStage} stage - What to say, to whom, and what it must write.
 * @param {import("./chunked").QaStageRef} ref - The iteration and (for a per-chapter
 *   stage) the chapter this agent is for.
 * @param {{tools: Object, approve: Function, cwd: string, installment: string}} loop
 *   - The sandbox gate every QA agent runs behind, and the volume it belongs to.
 * @returns {Promise<void>}
 */
async function runQaAgentStage(stage, ref, loop) {
  const agent = await harness.createAgentHandle({
    name: stage.name(ref),
    systemPrompt: stage.systemPrompt(ref),
    tools: loop.tools,
    approve: loop.approve,
    cwd: loop.cwd,
    maxSteps: await stage.maxSteps(ref),
  });
  try {
    const writesTo = stage.writesTo(ref);
    const who = stage.who(ref);
    await runWriteTurn(agent, {
      prompt: stage.prompt(ref),
      label: stage.label(ref),
      who,
      writesTo,
      recoveryWho: stage.recoveryWho ? stage.recoveryWho(ref) : undefined,
      recoveryPrompt: stage.recoveryPrompt
        ? (hasContent) => stage.recoveryPrompt(hasContent, ref)
        : (hasContent) => defaultRecoveryPrompt(hasContent, writesTo),
      recoveryLabel: stage.recoveryLabel ? stage.recoveryLabel(ref) : undefined,
      verifyOutput: stage.verifyOutput !== false,
      assertToolCalls: (result, whoLabel) => assertRealToolCalls(result, whoLabel, loop.installment),
    });
  } finally {
    await agent.close();
  }
}

module.exports = {
  runWriteTurn,
  runQaAgentStage,
  defaultRecoveryPrompt,
  validationReportRecoveryPrompt,
  quotedFileLabels,
};

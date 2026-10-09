/**
 * readOnlyFsTools: the three read tools, the composed gate that denies every mutating call and records each refusal, and the refusal reaching the MODEL (a denied call surfaces as a tool error and the loop continues, which is what lets the turn finish with an answer instead of dying on a refusal).
 *
 * Plus the answer button: `submit_diagnosis`, the tool whose arguments ARE the diagnosis.
 *
 * Part of the diagnostics.js layer (split out of the original single file).
 */

const path = require("path");
const { tool } = require("ai");
const { z } = require("zod");
const harness = require("../../harness");

const { DIAGNOSIS_COSTS, MUTATING_TOOL_NAMES, READ_ONLY_REFUSAL, READ_TOOL_NAMES, ROOT } = require("./contract");

/**
 * Build the read-only tool set and its gate.
 *
 * Two layers, both load-bearing (gotcha 8's pattern, applied to writes): the advertised set has no
 * mutating tool, so the model is never offered a promise the sandbox will not keep; and the gate
 * refuses every mutating call anyway, so a tool injected by a future library version, or a caller
 * that composes its own set, still hits the wall. The refusal is RECORDED — a dropped attempt is a
 * diagnostics team that quietly tried to repair the data, and the account owner is the only reader
 * who would never find out.
 *
 * @param {Object} cfg
 * @param {string} cfg.cwd - The agent's working directory (the project root: it reads the code).
 * @param {string} cfg.allowedDirs - Folders the underlying fs gate would allow writes to. Irrelevant
 *   to the outcome (every write is refused) but required by `createGatedFsTools`, and kept narrow so
 *   the backstop gate is the only thing doing the work.
 * @returns {Promise<{tools: Object, approve: Function, refusals: Object[], advertised: string[], dropped: string[]}>}
 */
async function readOnlyFsTools({ cwd = ROOT, allowedDirs = [ROOT] }) {
  const { tools, approve: fsApprove } = await harness.createGatedFsTools({ cwd, allowedDirs });

  /** @type {Array<{tool: string, path: string, reason: string, at: string}>} */
  const refusals = [];

  const approve = (call) => {
    const toolName = call && call.toolName;
    if (MUTATING_TOOL_NAMES.includes(toolName)) {
      const input = (call && call.input) || {};
      const target = input.filePath || input.dirPath || input.path || "(no path given)";
      refusals.push({ tool: toolName, path: target, reason: READ_ONLY_REFUSAL, at: new Date().toISOString() });
      harness.logLine(`  [diagnostics] REFUSED ${toolName} on ${target}: ${READ_ONLY_REFUSAL}.`);
      return false;
    }
    // Reads go through the harness gate unchanged (it allows reads anywhere, refuses archives).
    return fsApprove(call);
  };

  const advertised = {};
  for (const name of READ_TOOL_NAMES) {
    if (tools && tools[name]) advertised[name] = tools[name];
  }
  const dropped = Object.keys(tools || {}).filter((name) => !READ_TOOL_NAMES.includes(name));

  return { tools: advertised, approve, refusals, advertised: Object.keys(advertised), dropped };
}


/**
 * The name of the button the diagnostics role answers with.
 *
 * It is not one of the three senses and it is not a mutating tool: it writes nothing to disk. It is
 * how the turn's answer reaches the ticket — as arguments the provider checked against the contract,
 * instead of as a JSON block scraped out of prose.
 */
const DIAGNOSIS_ANSWER_TOOL = "submit_diagnosis";

/**
 * Build the diagnostics role's answer tool and the holder it records into.
 *
 * **Why a tool and not a fenced block.** Until now this role answered by writing a JSON object into
 * its own prose, and `parseDiagnosisReply` had to find it: the last fenced block, or failing that the
 * span from the first `{` to the last `}`. Every failure of the diagnosis channel ran through that
 * scrape — a reply that quotes a JSON example while reasoning, a fence that is not a fence, a field
 * spelled with the wrong case — and each one threw away a turn that is deliberately uncapped, i.e. the
 * most expensive turn in this codebase. The manager's menu was fixed the same way (gotcha 81/84): make
 * the answer a call instead of text to transcribe.
 *
 * **What the tool buys.** The provider validates the arguments against the contract before this code
 * ever sees them, so a missing `verify` is a tool error the model can answer again inside the same
 * turn rather than a parse failure that ends it; the answer is recorded at the moment it is given, so a
 * turn that dies afterwards still has an answer; and one answer per turn is enforced by the tool, in
 * the same shape the manager's menu enforces one move.
 *
 * **What it does not buy.** It cannot force the role to use it. `parseDiagnosisReply` stays, and stays
 * fail-closed: no call and no readable JSON is still a refused answer, recorded as one.
 *
 * The five things every option must say are required HERE and re-checked by `validateDiagnosisShape`
 * there — deliberately in both places. This filter is the one that can tell the model to answer again;
 * that one is the one that decides whether the answer may reach a ticket.
 *
 * @returns {{tool: Object, name: string, state: {answer: Object|null, repeats: number, refusals: Object[]}}}
 *   `state.answer` is the submitted diagnosis (null when the role answered in prose instead).
 */
function diagnosisAnswerTool() {
  /** @type {{answer: Object|null, repeats: number, refusals: Array<{kind: string, message: string}>}} */
  const state = { answer: null, repeats: 0, refusals: [] };

  const optionShape = z.object({
    label: z.string().min(1).describe("What the option is, in one line the manager can repeat."),
    touches: z
      .array(z.string().min(1))
      .min(1)
      .describe("The files, folders or settings it changes. An option that does not say what it touches cannot be judged."),
    cost: z.enum([...DIAGNOSIS_COSTS]).describe("free | cheap | expensive — the words the channel uses, not a token figure a guess invented."),
    risk: z.string().min(1).describe("What it could break."),
    verify: z
      .string()
      .min(1)
      .describe("How the manager checks it worked, using something it can see: a folder listing, a term count, a report, the published text."),
    requiresCodeChange: z.boolean().optional().describe("True when this option is the one that calls in the dev team."),
  });

  const answerTool = tool({
    description:
      `Give your diagnosis. These arguments ARE the answer: the fields the brief describes, passed ` +
      `directly, so nothing has to be transcribed out of your prose.\n` +
      `Call it once, when you have actually read enough to answer. Calling it again is refused — the ` +
      `first answer is the one recorded.`,
    inputSchema: z.object({
      cause: z
        .string()
        .min(1)
        .describe("The mechanism that produced this finding, in plain language a customer can follow. Name the mechanism, not the label."),
      options: z
        .array(optionShape)
        .min(1)
        .describe("At least one option, always. If the honest answer is 'nothing the manager can do', offer the escalation itself as the option and say why in ownerNote."),
      recommend: z.string().optional().describe("The label of the one you would take, and why."),
      questions: z
        .array(z.string().min(1))
        .optional()
        .describe("What you need from the manager. Ask something a customer can answer from a folder listing, a report or the published text."),
      read: z
        .array(z.string().min(1))
        .optional()
        .describe("The files your conclusion actually came from. Recorded against the turn's real tool calls either way."),
      ownerNote: z
        .string()
        .optional()
        .describe("For the account owner alone: the thing you believe is right but the manager may not be offered. Not an option."),
    }),
    execute: async (input) => {
      if (state.answer) {
        state.repeats += 1;
        const message =
          `REFUSED: the diagnosis for this ticket is already recorded (cause: ` +
          `"${String(state.answer.cause || "").slice(0, 120)}"). One answer per turn — a second one ` +
          `would be a diagnosis nobody assessed, and the ticket keeps the first. Write your closing ` +
          `sentence and stop.`;
        state.refusals.push({ kind: "second-answer", message });
        harness.logLine(`  [diagnostics] ${DIAGNOSIS_ANSWER_TOOL} called a second time — refused.`);
        return message;
      }
      state.answer = input;
      harness.logLine(
        `  [diagnostics] ${DIAGNOSIS_ANSWER_TOOL}: answer submitted as tool arguments ` +
          `(${(input.options || []).length} option(s), ${(input.questions || []).length} question(s), ` +
          `${(input.read || []).length} file(s) cited).`
      );
      return (
        `RECORDED. The ticket keeps this answer, the manager reads it next, and the banned-option ` +
        `filter runs on the way in — an option that switches a guard off is refused there, not here. ` +
        `Call nothing else.`
      );
    },
  });

  return { tool: answerTool, name: DIAGNOSIS_ANSWER_TOOL, state };
}


module.exports = {
  readOnlyFsTools,
  DIAGNOSIS_ANSWER_TOOL,
  diagnosisAnswerTool,
};

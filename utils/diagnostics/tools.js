/**
 * readOnlyFsTools: the three read tools, the composed gate that denies every mutating call and records each refusal, and the refusal reaching the MODEL (a denied call surfaces as a tool error and the loop continues, which is what lets the turn finish with an answer instead of dying on a refusal).
 *
 * Part of the diagnostics.js layer (split out of the original single file).
 */

const path = require("path");
const harness = require("../../harness");

const { MUTATING_TOOL_NAMES, READ_ONLY_REFUSAL, READ_TOOL_NAMES, ROOT } = require("./contract");

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


module.exports = {
  readOnlyFsTools,
};

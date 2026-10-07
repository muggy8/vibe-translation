/**
 * utils/devteam/tools.js — the dev team's file tools, and the record of every write the gate stopped.
 *
 * The check runs on the path the agent actually passed, BEFORE the harness repairs it: a path a gate
 * judged must not slip through in a normalised form. A refused write is recorded rather than
 * silently dropped — a team that quietly edited the constraint table and nobody ever found out is
 * the most expensive kind of bug this project has had. `deleteFile` is never offered (gotcha 8).
 * 
 * harness is reached through the module object, so a suite that stubs `harness.createGatedFsTools`
 * still reaches this code.
 */

const path = require("path");

const harness = require("../../harness");
const patches = require("../patches");
const { MUTATING_TOOL_NAMES, DELETION_REFUSAL } = require("./brief");

const projectRoot = path.join(__dirname, "../.."); // devteam.js's ROOT

/**
 * Build the dev team's tool set and its gate.
 *
 * Two layers again (gotcha 8's pattern, which gotcha 74 applies to writes): the harness's own gate
 * confines writes to the project, and this gate refuses the banned paths inside it and RECORDS each
 * refusal. The recording is the point — a silently dropped write attempt is a dev team that quietly
 * edited the constraint table and nobody ever found out.
 *
 * The check runs on the path the agent actually passed, before the harness repairs it (gotcha 60): a
 * repaired path must never slip past a gate that judged the original one.
 *
 * @param {Object} cfg
 * @param {string} cfg.cwd
 * @param {string[]} cfg.allowedDirs
 * @returns {Promise<{tools: Object, approve: Function, refusals: Object[], advertised: string[]}>}
 */
async function patchFsTools({ cwd = projectRoot, allowedDirs = [projectRoot] }) {
  const { tools, approve: fsApprove } = await harness.createGatedFsTools({ cwd, allowedDirs });

  /** @type {Array<{tool: string, path: string, rule: string|null, reason: string, at: string}>} */
  const refusals = [];

  const approve = (call) => {
    const toolName = call && call.toolName;
    if (MUTATING_TOOL_NAMES.includes(toolName)) {
      const input = (call && call.input) || {};
      const target = input.filePath || input.dirPath || input.path || "(no path given)";
      if (toolName === "deleteFile") {
        refusals.push({ tool: toolName, path: target, rule: "delete-file", reason: DELETION_REFUSAL, at: new Date().toISOString() });
        harness.logLine(`  [devteam] REFUSED deleteFile on ${target}: ${DELETION_REFUSAL}`);
        return false;
      }
      const verdict = patches.patchPathIsBanned(target, cwd);
      if (verdict.banned && verdict.rule) {
        const reason = `${verdict.rule.because} It goes to ${verdict.rule.escalateTo}`;
        refusals.push({ tool: toolName, path: target, rule: verdict.rule.id, reason, at: new Date().toISOString() });
        harness.logLine(`  [devteam] REFUSED ${toolName} on ${target} (${verdict.rule.id}): ${reason}`);
        return false;
      }
    }
    // Reads, and writes the banned list is silent about, go through the harness gate unchanged.
    return fsApprove(call);
  };

  return { tools, approve, refusals, advertised: Object.keys(tools || {}) };
}

/**
 * Both layers of the write boundary, recorded together.
 *
 * For this role the tool-set layer only fires for `deleteFile` (the harness does not advertise it, so
 * the provider answers before the call reaches the sandbox). The gate layer fires for the banned
 * paths. Counting only the gate's log would report "the team never tried" for the common case where it
 * tried and the tool set said no — the exact mistake gotcha 74 describes.
 *
 * The third argument keeps the record honest in the other direction. Unlike the read-only team, this role
 * IS offered `writeFile` and `editFile`, and a normal turn uses them. Reading every mutating tool call as
 * a refusal would report the edit the patch exists for as "the tool set refused the call before it reached
 * the sandbox" — true of `deleteFile`, a lie about the work. So a call counts as a tool-set refusal only
 * when its name is NOT in `advertised`, which is exactly the condition under which the provider answers
 * before the sandbox is reached. A write that succeeded is reported where it belongs: in `actualChanges`,
 * the tree fingerprint.
 *
 * @param {Array<{tool: string, path: string, rule: string|null, reason: string, at: string}>} refusals
 * @param {Array<{name: string, input: Object}>} toolCalls
 * @param {string[]} [advertised] the tool names the role was actually handed (empty = assume none of the
 *   mutating ones were, which is the read-only role's case)
 * @returns {Array<{tool: string, path: string, rule: string|null, reason: string, layer: string, at: string}>}
 */
function collectPatchWriteAttempts(refusals, toolCalls, advertised = []) {
  const out = (refusals || []).map((r) => ({ ...r, layer: "the approve gate" }));
  const seen = new Set(out.map((r) => `${r.tool}\u0000${r.path}`));
  for (const call of toolCalls || []) {
    if (!MUTATING_TOOL_NAMES.includes(call.name)) continue;
    // The gate approved this one, so the only open question is whether the tool set ever offered it.
    if (advertised.includes(call.name)) continue;
    const target = (call.input && (call.input.filePath || call.input.dirPath)) || "(no path given)";
    const key = `${call.name}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      tool: call.name,
      path: target,
      rule: call.name === "deleteFile" ? "delete-file" : null,
      reason:
        `${call.name} is not offered to this role at all — the tool set refused the call before it ` +
        `reached the sandbox. ${call.name === "deleteFile" ? DELETION_REFUSAL : "the write boundary applies regardless."}`,
      at: new Date().toISOString(),
      layer: "the tool set",
    });
  }
  return out;
}

module.exports = { patchFsTools, collectPatchWriteAttempts };

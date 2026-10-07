/**
 * Reading the reply. Fail-closed, and the LAST fenced block wins, because a real answer reasons in prose first; a missing reason or a missing per-action field is not a decision.
 *
 * Part of the manager.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions
const { extractJsonObject } = require("../manifest");

const { ACTION_BY_NAME, ACTION_NAMES, MANAGER_ACTIONS } = require("./rules");

/**
 * Pull the machine-readable block out of a reply that reasoned in prose first.
 *
 * The LAST fenced block wins, for the same reason `utils/devteam.js` takes the last one: a real
 * answer thinks out loud and puts the JSON at the end, and `extractJsonObject`'s first-brace-to-
 * last-brace rule mangles a reply that quotes a JSON example on its way to the real one.
 *
 * @param {string} text
 * @returns {Object|null} - null when nothing parseable is there.
 */
function extractActionJson(text) {
  const raw = String(text || "");
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(fences[i].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Not the block. Keep looking backwards.
    }
  }
  try {
    const salvaged = extractJsonObject(raw);
    if (salvaged) {
      const parsed = JSON.parse(salvaged);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Fall through to the refusal below.
  }
  return null;
}


/**
 * Parse and shape-check one manager reply. Fail-closed, like `parseAcceptanceReply` and
 * `validateProposalShape`: an unparseable decision is a failed check, never a default action.
 *
 * There is no "safe default" here on purpose. Defaulting to `end` would end a run that is not
 * finished; defaulting to `run` would spend a real run's worth of model calls on a guess.
 *
 * @param {string} reply - The model's raw reply.
 * @returns {{action: ManagerAction|null, problems: Array<{kind: string, message: string}>, warnings: Array<{kind: string, message: string}>}}
 */
function parseManagerAction(reply) {
  const problems = [];
  const warnings = [];
  const raw = extractActionJson(reply);
  if (!raw) {
    return {
      action: null,
      problems: [
        {
          kind: "unparseable",
          message:
            `the reply contains no parseable JSON action block. Answer with one fenced \`\`\`json block ` +
            `containing action / reason and the fields that action needs.`,
        },
      ],
      warnings,
    };
  }

  const action = String(raw.action || "").trim();
  if (!action) {
    problems.push({ kind: "missing-field", message: "action is required: one of " + [...ACTION_NAMES].join(" | ") });
  } else if (!ACTION_NAMES.has(action)) {
    problems.push({
      kind: "unknown-action",
      message:
        `"${action}" is not a move the delivery manager may make. The whole vocabulary is: ` +
        `${MANAGER_ACTIONS.map((a) => a.name).join(", ")}.`,
    });
  }

  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (!reason) {
    problems.push({
      kind: "missing-field",
      message: "reason is required for every action: a decision nobody wrote down is not reviewable afterwards.",
    });
  } else if (reason.length < 30) {
    warnings.push({
      kind: "thin-reason",
      message: `the reason is ${reason.length} characters. The ledger and the report are what a human reads ` +
        `six runs later; one clause is the whole record of why this run did what it did.`,
    });
  }

  const spec = ACTION_BY_NAME.get(action);
  if (spec) {
    for (const field of spec.needs) {
      const value = raw[field];
      const empty =
        value === undefined || value === null || (typeof value === "string" && !value.trim());
      if (empty) {
        problems.push({
          kind: "missing-field",
          message: `${field} is required for action "${action}": ${spec.what}`,
        });
      }
    }
  }

  if (raw.outcome !== undefined && raw.outcome !== "accept" && raw.outcome !== "reject") {
    problems.push({ kind: "bad-value", message: `outcome must be "accept" or "reject", not ${JSON.stringify(raw.outcome)}` });
  }

  // Extra fields are not a refusal: a model that answers `step` on a `judge` action has said
  // something harmless, and refusing it would be a rule about style rather than about safety.
  const allowed = new Set(["action", "reason", "step", "ticket", "answer", "option", "patch", "outcome", "note"]);
  const extra = Object.keys(raw).filter((k) => !allowed.has(k));
  if (extra.length) warnings.push({ kind: "extra-fields", message: `ignored field(s): ${extra.join(", ")}` });

  if (problems.length) return { action: null, problems, warnings };
  return { action: raw, problems, warnings };
}

// ─── The menu gate: is this move actually on the menu? ────────────────────────


module.exports = {
  extractActionJson,
  parseManagerAction,
};

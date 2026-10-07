/**
 * utils/devteam/proposal.js — the one shape the dev turn's reply must have.
 *
 * Fail-closed on the shape, like `parseDiagnosisReply` and `parseAcceptanceReply`: a proposal another
 * program cannot read is not a proposal, and prose that sounds like a fix is refused rather than
 * generously interpreted.
 */

const { extractJsonObject } = require("../manifest");

/**
 * Parse the dev turn's reply. Fail-closed on the shape, like `parseDiagnosisReply` and
 * `parseAcceptanceReply`: a proposal another program cannot read is not a thin proposal.
 *
 * @param {string} text
 * @returns {{proposal: Object|null, problems: Object[]}}
 */
function parseProposalReply(text) {
  if (typeof text !== "string" || !text.trim()) {
    return {
      proposal: null,
      problems: [
        {
          kind: "empty-reply",
          message:
            "the dev turn produced no proposal. The turn's tool calls and any files it wrote are still " +
            "in the working tree and in .logs/ — read them before re-running, because a turn stopped for " +
            "repeating itself or for running past the turn clock is a different problem from a turn that " +
            "answered nothing, and this turn has no step limit to blame.",
        },
      ],
    };
  }

  // The LAST fenced JSON block: a real answer reasons in prose first and puts the machine-readable
  // part at the end. `extractJsonObject` takes first-{ to last-}, which mangles a reply that quotes an
  // example inside its prose.
  let raw = null;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((m) => m[1])
    .filter((block) => block.trim().startsWith("{"));
  for (let i = fences.length - 1; i >= 0 && raw === null; i -= 1) {
    try {
      raw = JSON.parse(fences[i].trim());
    } catch {
      /* try the previous block */
    }
  }
  if (raw === null) {
    try {
      raw = extractJsonObject(text);
    } catch (err) {
      return {
        proposal: null,
        problems: [
          {
            kind: "unparseable",
            message:
              `the reply does not contain the JSON object the brief asks for (${err.message}). Write ` +
              `the proposal as one fenced \`\`\`json block with files / summary / why / couldBreak / ` +
              `expected / verify. Prose alone is not a proposal the manager can judge.`,
          },
        ],
      };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { proposal: null, problems: [{ kind: "not-an-object", message: "the reply parsed as something other than one JSON object." }] };
  }
  return { proposal: raw, problems: [] };
}

module.exports = { parseProposalReply };

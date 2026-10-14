/**
 * utils/prereqs/verdict.js — the decision, the sentence it produces, and the refusal it throws.
 *
 * Asks `completion.js` about every step reachable below the one being gated, sorts what came back so
 * the deepest missing thing is named before the consequences the operator would otherwise have to work
 * out, and phrases it as a refusal a person can act on: the chain through the NEAREST consumer, the
 * two gaps that fit, and the command that would fix it.
 *
 * It reads the disk only. It writes nothing, makes no model call, and never consults a flag: `--force`,
 * `--allow-fail`, `ON_TASK_ERROR=continue`, the ledger and the resume menu are not inputs to this
 * question, which is the whole point of the gate. The refusal is a STRUCTURAL error, so no run policy
 * can walk past it.
 *
 * @module utils/prereqs/verdict
 */

const { structuralError } = require("../../configs/shared");

const { prerequisitesFor, transitivePrerequisites, prerequisiteChain } = require("./table");
const { gateContext, readVolumesInScope } = require("./scope");
const { stepGaps } = require("./completion");

/**
 * One incomplete prerequisite, phrased as a refusal a person can act on.
 *
 * @typedef {Object} PrerequisiteGap
 * @property {string} step - The prerequisite that is not complete.
 * @property {string[]} chain - The steps between the gated step and this one, nearest first.
 * @property {string[]} gaps - What is missing, in the words the checks produced.
 * @property {string} line - The rendered bullet.
 */

/**
 * The command that would fix one gap.
 *
 * A narrowed run is told to rebuild that one volume, because that is the cheap move and it is the
 * one the run was already asked to make. A whole-series run is told to re-run the step, which
 * rebuilds the missing volume and cascades the volumes after it.
 *
 * @param {string} step
 * @param {string[]} gaps
 * @param {boolean} narrowed
 * @returns {string}
 */
function fixCommandFor(step, gaps, narrowed) {
  const volumeMatch = gaps.map((g) => /^volume (\S+)/.exec(g)).filter(Boolean).map((m) => m[1]);
  if (volumeMatch.length === 0) return `npx gulp ${step}`;
  if (narrowed) return `npx gulp ${step} --volume ${volumeMatch[0]}`;
  return `npx gulp ${step}`;
}

/**
 * Ask whether every prerequisite of one step is complete, and phrase the answer.
 *
 * Reads the disk only. It writes nothing, makes no model call, and never consults a flag: `--force`,
 * `--allow-fail`, `ON_TASK_ERROR=continue`, the ledger and the resume menu are not inputs to this
 * question, which is the whole point of the gate.
 *
 * @param {Object} opts
 * @param {string} opts.step - The gulp task about to start.
 * @param {string} opts.seriesDir - `SERIES_LOCATION`.
 * @param {string|null} [opts.volumeArg] - The `--volume` filter, when the run is narrowed.
 * @returns {Promise<{
 *   ok: boolean, step: string, narrowed: boolean, gaps: PrerequisiteGap[],
 *   headline: string, bullets: string[], message: string, planMissing: boolean,
 * }>} `headline` + `bullets` are the verdict in the shape a dry run prints; `message` is the same
 *   thing as the one string a refusal throws.
 */
async function evaluatePrerequisites({ step, seriesDir, volumeArg = null }) {
  const edges = prerequisitesFor(step);
  const narrowed = Boolean(volumeArg);
  const empty = { ok: true, step, narrowed, gaps: [], headline: "", bullets: [], message: "", planMissing: false };
  if (edges.length === 0) return empty;

  /**
   * Turn the collected gaps into the headline and bullets a person can act on.
   * @param {PrerequisiteGap[]} found
   * @returns {{headline: string, bullets: string[]}}
   */
  const render = (found) => {
    for (const gap of found) {
      const needs = gap.chain.length > 0
        ? gap.chain.map((s) => `\`${s}\``).join(", which needs ")
        : "it";
      const shown = gap.gaps.slice(0, 2);
      const more = gap.gaps.length > shown.length ? ` (and ${gap.gaps.length - shown.length} more)` : "";
      gap.line =
        `\`${step}\` needs ${needs}; ${shown.join("; ")}${more}. ` +
        `Run \`${fixCommandFor(gap.step, gap.gaps, narrowed)}\` first.`;
    }
    const shown = found.slice(0, 6);
    const hidden = found.length - shown.length;
    const bullets = shown.map((g) => g.line);
    if (hidden > 0) bullets.push(`… ${hidden} more incomplete prerequisite(s); fix these first.`);
    return {
      headline:
        `${step} refuses to start: ${found.length} prerequisite${found.length === 1 ? "" : "s"} ` +
        `${found.length === 1 ? "is" : "are"} not complete. This gate has no override.`,
      bullets,
    };
  };

  /**
   * @param {PrerequisiteGap[]} found
   * @param {boolean} planMissing
   * @returns {Object} A failed verdict with the message composed.
   */
  const failed = (found, planMissing = false) => {
    const rendered = render(found);
    return {
      ok: false,
      step,
      narrowed,
      planMissing,
      gaps: found,
      headline: rendered.headline,
      bullets: rendered.bullets,
      message: `${rendered.headline}\n  - ${rendered.bullets.join("\n  - ")}`,
    };
  };

  if (!seriesDir) {
    return failed([{ step: "discover", chain: ["discover"], gaps: ["SERIES_LOCATION is not set"], line: "" }], true);
  }

  const { volumes, error } = readVolumesInScope(seriesDir, volumeArg);
  if (error) return failed([{ step, chain: [], gaps: [error], line: "" }]);

  const ctx = gateContext();
  const below = [...transitivePrerequisites(step).keys()];
  /** @type {PrerequisiteGap[]} */
  const gaps = [];
  for (const prereq of below) {
    const found = await stepGaps({ step: prereq, seriesDir, volumes, narrowed, ctx });
    if (found.length === 0) continue;
    gaps.push({ step: prereq, chain: prerequisiteChain(step, prereq), gaps: found, line: "" });
  }
  // Name the deepest missing thing first: it is the root cause, and everything above it is a
  // consequence the operator would otherwise have to work out.
  gaps.sort((a, b) => b.chain.length - a.chain.length);
  if (gaps.length === 0) return empty;
  return failed(gaps);
}

/**
 * The refusal this gate throws: a STRUCTURAL error, so `ON_TASK_ERROR=continue` cannot walk past it
 * and `isStructuralError` sees it (gotcha 21).
 *
 * @param {string} message
 * @returns {Error}
 */
function prerequisiteRefusal(message) {
  return structuralError(message);
}

module.exports = {
  fixCommandFor,
  evaluatePrerequisites,
  prerequisiteRefusal,
};

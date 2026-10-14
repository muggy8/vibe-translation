/**
 * utils/reference-store/validation/artifact-shape.js — measuring the file an agent wrote.
 *
 * The shape of a published artifact is the one thing about a reference a model cannot report honestly,
 * because reading it is what damages it: volume 01's character-voice reference carried a line of 54,341
 * characters, every read of it came back truncated, and the agent asked to repair it lost track of the
 * document it was editing. All three measurements here are one pass over the text with no model in the
 * loop, which is what lets the acceptance gate refuse such a file on a number instead of on a reader's
 * impression of it.
 *
 * `VALIDATION_STEP` lives here because this is the file in this folder that emits findings of its own;
 * the step name is what those findings are filed under, and `pipeline-store.js` files the findings it adds
 * under the same one.
 *
 * @module utils/reference-store/validation/artifact-shape
 */

const { finding } = require("../../postmortem");
const { envMaxLineLength } = require("../../../ai/env");
const { unfinishedProseFindings } = require("../drafting");
const { sectionHeading } = require("./headings");
require("../../../types"); // JSDoc type definitions

/** The step name findings from this audit are filed under. */
const VALIDATION_STEP = "reference-audit";

/**
 * Measure the shape of a published artifact.
 *
 * Two measurements, both of which the store already knows the true answer to:
 *
 *   - **A line no agent can read.** `AGENT_MAX_LINE_LENGTH` is the longest line the file tools will
 *     answer with; past it, every read comes back with a truncation marker. Volume 01's character-voice
 *     reference has a line of 54,341 characters, which is how its repair agent lost track of the
 *     document it was editing. A reference an agent cannot read is not a reference.
 *   - **Sections fewer than the roster.** The artifact's own `### ` headings, counted, against the
 *     cast the store holds. This is the deferred check from review 05 §4 — the one whose absence made
 *     volume 01's voice numbers look small instead of alarming.
 *   - **Prose the writer never finished.** `utils/reference-store/drafting.js` names every line that
 *     carries a drafting aside or a claim arguing with itself. Volume 01's reference carries
 *     `(wait, this is パンジー — need to recheck)` and volume 02's quotes `'〜Fantastic'` five times
 *     while saying it is not present; `Fantastic` is in neither book. See that module's header for what
 *     the rule is not, and for the 700 false positives the obvious version of it produced.
 *
 * @param {string} markdown - The artifact as it is on disk.
 * @param {{file: string, volume: number|string, step?: string}} opts
 * @returns {PostMortemFinding[]}
 */
function artifactShapeFindings(markdown, { file, volume, step = VALIDATION_STEP }) {
  const findings = [];
  const text = String(markdown === undefined || markdown === null ? "" : markdown);
  const lines = text.split("\n");
  const limit = envMaxLineLength();

  let longest = 0;
  let longestAt = 0;
  lines.forEach((line, index) => {
    if (line.length > longest) {
      longest = line.length;
      longestAt = index + 1;
    }
  });
  if (longest > limit) {
    findings.push(
      finding(
        "HIGH",
        "reference-artifact-line-unreadable",
        step,
        volume,
        file,
        `line ${longestAt} of ${file} is ${longest} characters, and an agent's file tools answer with at ` +
          `${limit} of a line. An agent asked to preserve this document cannot read it: every read comes ` +
          "back truncated, which is how volume 01's reference was welded into one line and never repaired. " +
          "Split the line into one claim per line."
      )
    );
  }

  const sections = lines.filter((line) => line.startsWith(sectionHeading(lines, "### "))).length;
  if (sections === 0 && text.trim().length > 0) {
    findings.push(
      finding(
        "MEDIUM",
        "reference-artifact-has-no-sections",
        step,
        volume,
        file,
        `${file} has no sections at any heading level, so nothing in it is addressable as one entry.`
      )
    );
  }

  findings.push(...unfinishedProseFindings(text, { file, volume, step }));

  return findings;
}

module.exports = {
  VALIDATION_STEP,
  artifactShapeFindings,
};

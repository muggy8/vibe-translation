/**
 * utils/reference-store/validation/sample.js — the slice of the artifact the acceptance grader is shown.
 *
 * The whole-document grade is what made the voice stage cost what it cost: the grader was handed the
 * cumulative reference, which grows every volume, and the grading call is repeated for the
 * exceptional-score confirmation. The sampled grade keeps the rubric and the answer contract exactly as
 * they are and changes only how much of the document is in the message. Selection is deterministic and
 * stated in the sample's own header, because a grade whose sample a model chose would not be comparable
 * from volume to volume: the document's opening always, the sections this volume's record added first,
 * the rest in document order until the budget runs out — and a section too big for the space that is left
 * is cut mid-line and named out loud, which is the opposite of what happened to volume 01's reference,
 * whose single 54,341-character line made a 20,000-character budget a number that was printed and not
 * obeyed.
 *
 * @module utils/reference-store/validation/sample
 */

const { sectionHeading } = require("./headings");
require("../../../types"); // JSDoc type definitions

/**
 * How much of the artifact the acceptance grader is shown, in characters.
 *
 * The whole-document grade is what made the voice stage cost what it cost: the grader is handed the
 * cumulative reference, which grows every volume, and the grading call is repeated for the
 * exceptional-score confirmation. The sampled grade keeps the rubric and the answer contract exactly
 * as they are and changes only how much of the document is in the message. 20,000 characters is
 * roughly the size of the largest *chapter* the pipeline already sends in one call, so it is a size
 * the endpoint is known to take.
 */
const GRADE_SAMPLE_MAX_CHARS = 20000;

/**
 * Build the sample the acceptance grader is shown instead of the whole artifact.
 *
 * Selection is deterministic and stated in the sample's own header, because a grade whose sample was
 * chosen by a model would be a grade you cannot compare from volume to volume:
 *
 *   - the document's opening (everything before the first section) is always shown — the rubric
 *     judges the document's shape, and a sample without its shape cannot grade that;
 *   - sections this volume's record added come first — the work this volume did is what is being
 *     accepted;
 *   - the rest fill the remaining space in document order.
 *
 * The deterministic audit report is sent alongside the sample, so a defect in a section that did not
 * make the cut is still in front of the grader — as a finding with a severity, which is more than the
 * old whole-document read produced.
 *
 * @param {string} markdown - The artifact as it is on disk.
 * @param {Object} opts
 * @param {string} opts.file - Artifact name, for the header.
 * @param {number|string} opts.volume
 * @param {string} [opts.heading] - The heading that starts a section: `### ` for the voice reference,
 *   `## ` for the glossary.
 * @param {string[]} [opts.newestSections] - Section headings this volume's record added.
 * @param {number} [opts.maxChars]
 * @returns {{text: string, sectionsShown: number, sectionsTotal: number, chars: number, omitted: string[], truncated: string[]}}
 */
function buildGradeSample(markdown, { file, volume, heading = "### ", newestSections = [], maxChars = GRADE_SAMPLE_MAX_CHARS }) {
  const lines = String(markdown === undefined || markdown === null ? "" : markdown).split("\n");

  // The heading the sections actually use. The voice reference's canonical shape puts each character
  // under `### `, and the glossary puts its rows under `## ` — but the shape an agent left behind is
  // not always the shape the prompt asked for, and a sampler that silently finds no sections would
  // grade a document consisting of its own first paragraph.
  const used = sectionHeading(lines, heading);

  /** @type {Array<{heading: string|null, lines: string[]}>} */
  const blocks = [];
  let current = { heading: null, lines: [] };
  for (const line of lines) {
    if (line.startsWith(used)) {
      blocks.push(current);
      current = { heading: line.slice(heading.length).trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);

  const opening = blocks[0];
  const sections = blocks.slice(1).filter((block) => block.heading !== null);
  const newest = new Set(newestSections);

  const ranked = [
    ...sections.filter((block) => newest.has(block.heading)),
    ...sections.filter((block) => !newest.has(block.heading)),
  ];

  // The opening is always shown — the rubric judges the document's shape, and a grader that never saw
  // the title and the preamble cannot judge it — but it is clipped to the budget like everything else.
  const openingCut = takeWithinBudget(opening.lines, maxChars);
  /** @type {Array<{block: Object, lines: string[]}>} */
  const chosen = [];
  /** @type {string[]} */
  const truncated = [];
  let taken = openingCut.lines.join("\n").length;
  for (const block of ranked) {
    const size = block.lines.join("\n").length;
    if (chosen.length > 0 && taken + size > maxChars) continue;
    const room = maxChars - taken;
    if (size <= room) {
      chosen.push({ block, lines: block.lines });
      taken += size;
      continue;
    }
    // Over budget on its own. Giving up here would grade a document consisting of its own first
    // paragraph; taking it whole would not be a sample at all, and that is what happened to volume 01's
    // character-voice reference, whose single 54,341-character line made a 20,000-character budget
    // meaningless. Take as much of it as fits and say out loud that you did.
    const cut = takeWithinBudget(block.lines, Math.max(room, 0));
    chosen.push({ block, lines: cut.lines });
    truncated.push(block.heading);
    taken += cut.lines.join("\n").length;
    break;
  }

  const chosenBlocks = new Set(chosen.map((entry) => entry.block));
  const omitted = ranked.filter((block) => !chosenBlocks.has(block)).map((block) => block.heading);

  const header = [
    `### What you are being shown`,
    "",
    `This is a **sample** of ${file} (volume ${volume}), not the whole document: ${chosen.length} of ` +
      `${sections.length} sections, ${taken} characters. The sections this volume added were selected ` +
      `first${omitted.length ? `; ${omitted.length} section(s) are not shown (${omitted.join(", ")})` : ""}` +
      `${truncated.length ? `; ${truncated.length} section(s) are shown cut short (${truncated.join(", ")}) because they are larger than this sample's budget` : ""}. ` +
      "The deterministic audit below was produced by querying the whole document's record, not a part " +
      "of it, so what it says about the parts you are not shown is measured, not sampled.",
    "",
  ];

  const body = [...openingCut.lines, ...chosen.flatMap((entry) => entry.lines)];
  return {
    text: header.join("\n") + "\n" + body.join("\n").replace(/\n+$/, "") + "\n",
    sectionsShown: chosen.length,
    sectionsTotal: sections.length,
    chars: taken,
    omitted,
    truncated,
  };
}

/**
 * Take whole lines from a block until the budget runs out, and report whether anything was left out.
 *
 * A line longer than the remaining budget is cut mid-line rather than taken whole. That is deliberate:
 * the budget exists to keep a grading prompt inside a context window, and one 54,341-character line —
 * the exact damage volume 01's reference took — would otherwise make the budget a number that is
 * printed and not obeyed.
 *
 * @param {string[]} lines
 * @param {number} budget
 * @returns {{lines: string[], truncated: boolean}}
 */
function takeWithinBudget(lines, budget) {
  /** @type {string[]} */
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const size = line.length + (kept.length ? 1 : 0);
    if (used + size <= budget) {
      kept.push(line);
      used += size;
      continue;
    }
    // The newline that joins this line to the ones already kept has to be paid for as well, or the
    // joined block lands one character over the budget every time.
    const room = budget - used - (kept.length ? 1 : 0);
    if (room > 1) kept.push(`${line.slice(0, room - 1)}…`);
    return { lines: kept, truncated: true };
  }
  return { lines: kept, truncated: false };
}

module.exports = {
  GRADE_SAMPLE_MAX_CHARS,
  buildGradeSample,
  takeWithinBudget,
};

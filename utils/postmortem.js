/**
 * utils/postmortem.js — Deterministic assessment of what a pipeline step left behind.
 *
 * This is the question utils/artifacts.js writes down, asked against the disk:
 * "did this step produce the files this step always produces, in the shape those
 * files always have?" It is deliberately **deterministic** — no model call, no
 * network, no judgement about quality. It is the tier that can run on every
 * volume of every step for free, and it is the tier that would have caught
 * volume 04's `glossary.md` with nothing beside it (gotcha 64), the 457 vanished
 * terms, and the 164-character sentence that became a published artifact
 * (gotcha 58) — all of which passed every check the pipeline had.
 *
 * What it checks, per step:
 *   1. every expected file exists, at the right level of requiredness;
 *   2. a file that exists is not empty and not a scaffold stub;
 *   3. a `.json` file parses;
 *   4. a document has the shape its prompt specifies (a heading, or a table);
 *   5. quarantine files a gate left behind are reported, not silently accumulated;
 *   6. a volume folder holds no file the pipeline's own vocabulary does not
 *      recognise (the stale-stray class: gotcha 3);
 *   7. an acceptance state that was never actually accepted is named (the
 *      `ON_QA_LIMIT=accept` path publishes output no grader signed off);
 *   8. a chapter the handoff listed has no draft;
 *   9. the consistency audit's own verdict is carried into the finding list;
 *   10. for a delivery command, the records it claims it wrote are in the run folder
 *       and have the shape their renderer always gives them (utils/postmortem/scope.js).
 *       The questions about those records agreeing with EACH OTHER — a patch naming a
 *       ticket that does not exist, a lock left by a process that is gone — are asked
 *       by utils/delivery-audit.js, which sits on top of this layer rather than inside it.
 *
 * What it deliberately does NOT do: decide whether an artifact is GOOD. That is
 * the scored gates' job, and moving it here would put a second, weaker version
 * of the grader next to the real one. This module only asks whether the step
 * finished, and whether the evidence it left is the evidence it always leaves.
 *
 * Findings are data, not thrown errors. The caller (index.js) decides what to do
 * with them; the post-mortem's job is to be honest and cheap.
 *
 * The code lives in utils/postmortem/: rules.js (what a finding is, and what a shape means),
 * file.js (one file, one verdict), volume.js (one volume folder against what its step owed),
 * series.js (the series-root copies and the audit's verdict), scope.js (the run folder, where the
 * delivery layer's records live), run.js (the assessment itself), render.js (the report a human
 * reads). This file is the public surface, and the two shapes the delivery layer names in its JSDoc.
 *
 * @module utils/postmortem
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One thing the post-mortem found.
 *
 * @typedef {Object} PostMortemFinding
 * @property {"HIGH"|"MEDIUM"|"LOW"} severity - HIGH: the step did not finish what it
 *   claims to have finished. MEDIUM: a gap worth reading about. LOW: worth knowing,
 *   normally fine.
 * @property {string} kind - The stable machine-readable class (`missing-required`,
 *   `wrong-shape`, `unexpected-file`, …). A future diagnosis agent selects on this.
 * @property {string} step - The step being assessed.
 * @property {string|null} volume - The installment number, or null for a series-level finding.
 * @property {string} file - Path relative to the series folder (or the volume folder name
 *   for a folder-level finding).
 * @property {string} message - What is wrong, and what it probably means.
 */

/**
 * The assessment of one step.
 *
 * @typedef {Object} PostMortemReport
 * @property {string} step
 * @property {boolean} ok - True when no HIGH finding was raised.
 * @property {PostMortemFinding[]} findings
 * @property {{HIGH: number, MEDIUM: number, LOW: number, volumes: number, checked: number}} counts
 * @property {string} markdown - The human-readable report.
 * @property {string} [error] - Set when the assessment itself could not run (a missing
 *   plan of record). An assessment that could not run is never reported as clean.
 */

const rules = require("./postmortem/rules");
const volume = require("./postmortem/volume");
const series = require("./postmortem/series");
const scope = require("./postmortem/scope");
const run = require("./postmortem/run");
const render = require("./postmortem/render");

// The public surface, unchanged from the single file.
module.exports = {
  runPostMortem: run.runPostMortem,
  writePostMortemReport: render.writePostMortemReport,
  renderPostMortemMarkdown: render.renderPostMortemMarkdown,
  postMortemDir: render.postMortemDir,
  hasTableShape: rules.hasTableShape,
  matchesShape: rules.matchesShape,
  readConsistencyVerdict: series.readConsistencyVerdict,
  finding: rules.finding,
  assessRunScope: scope.assessRunScope,
  declaresRunScope: scope.declaresRunScope,
};

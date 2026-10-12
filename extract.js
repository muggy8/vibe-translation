/**
 * extract.js — the `extract` pipeline step: the one place that owns whether the extracted text is right.
 *
 * Thin barrel over `extract/` (AGENTS.md §3): `extract/run.js` (the step — walk the volumes, resolve
 * each bundle, audit it, record it, fail the run on a HIGH finding), `extract/bundle-state.js` (which
 * of the two happened to a volume's bundle: verified, or extracted), `extract/reports.js` (the
 * per-volume report and the series summary, written into the run's records).
 *
 * NOT THE CONVERTER. `utils/source/extract.js` is the thing that opens an archive and writes chapter
 * files; this module is the step that runs it, checks what came out, and writes down the answer. The
 * plan of record is `utils/source/plan/01-extraction-step.md`.
 *
 * WHAT IT IS FOR. Eleven callers resolve a volume's bundle and none of them checked what they got
 * (gotcha 119, gotcha 123). This step does not replace them — they become cache hits on work that has
 * already been checked — it is the step that asks the question once, before anything is built on the
 * answer, and the step that leaves the numbers this layer has never had.
 *
 * NO MODEL. No harness, no one-shot, no agent, no prompt file. Every question here is answered by code
 * over a checksum and a file listing, so the step is free and can be re-run as often as anybody likes.
 *
 * Registered as the gulp task `extract`, between `discover` and `glossary` (gulpfile.js
 * PIPELINE_STEPS), and runnable on its own: `npx gulp extract`, or
 * `npm run pipeline -- --stages=extract`.
 */

require("./types"); // JSDoc type definitions

const bundleState = require("./extract/bundle-state");
const reports = require("./extract/reports");
const run = require("./extract/run");

module.exports = {
  // The step itself (the gulp task body).
  extractVolumes: run.extractVolumes,
  // The pieces, exported so a test or a later slice can ask one question instead of running the step.
  extractOneVolume: run.extractOneVolume,
  recordOf: run.recordOf,
  imageCountOf: run.imageCountOf,
  bundleCachePresent: bundleState.bundleCachePresent,
  bundleStateOf: bundleState.bundleStateOf,
  extractionReportBase: reports.extractionReportBase,
  renderVolumeReport: reports.renderVolumeReport,
  renderSeriesSummary: reports.renderSeriesSummary,
  writeVolumeReport: reports.writeVolumeReport,
  writeSeriesSummary: reports.writeSeriesSummary,
};

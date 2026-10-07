/**
 * utils/series-run.js — the plumbing every pipeline stage shares when it walks a series.
 *
 * A stage task is the same shape seven times over: read the flags, load the plan of record, resolve
 * the languages, list the volumes in reading order, check the previous volume, decide whether this
 * volume is already done, publish the series-current artifact, and fail the run if volumes broke.
 * Each stage's own work sits in the middle of that shape.
 *
 * This layer holds the shape. It is deliberately not a framework: there is no class, no lifecycle,
 * no registration — each piece is a function a task calls where it needs it, so a task still reads
 * top to bottom and the stage-specific decisions stay visible in the stage.
 *
 * @example
 * const { readRunArgs, openSeriesRun, runVolumeSeries } = require("../utils/series-run");
 */

const { readRunArgs } = require("./series-run/args");
const { openSeriesRun } = require("./series-run/open");
const { locatePreviousVolume, requirePreviousArtifacts } = require("./series-run/previous");
const { volumeAlreadyAccepted } = require("./series-run/skip");
const { publishLatestToSeriesRoot } = require("./series-run/publish");
const { runVolumeSeries } = require("./series-run/loop");

module.exports = {
  readRunArgs,
  openSeriesRun,
  locatePreviousVolume,
  requirePreviousArtifacts,
  volumeAlreadyAccepted,
  publishLatestToSeriesRoot,
  runVolumeSeries,
};

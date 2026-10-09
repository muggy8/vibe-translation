/**
 * index/main.js — the entry: the step list, the run lock, and the run.
 *
 * The lock is taken here and not inside the walk: the question "is somebody else already
 * doing this" has to be answered before any of it starts, and released whatever happens.
 */

const { PIPELINE_STEPS } = require("../gulpfile");
const { runId } = require("../utils/ledger");
const { acquireRunLock, releaseRunLock, runLockPath } = require("../utils/runlock");
const { installShutdownWatch } = require("../utils/shutdown");
const { parseArgs } = require("./args");
const { runPipelineSteps } = require("./steps");

/**
 * The process entry point: answer "is a run already going?" before starting one.
 *
 * Two processes writing the same volume folder is how an artifact ends half-built by one and
 * half by the other, and nothing downstream can tell afterwards. The lock is the only way
 * either process can know (gotcha 66 — the whole design of this runner is that a step is a
 * process, so the thing that must not overlap is also a process).
 *
 * @returns {Promise<number>} The process exit code.
 */
async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.list) {
    console.log("Pipeline steps (gulp order):");
    for (const step of PIPELINE_STEPS) console.log(`  ${step.name}`);
    return 0;
  }

  // One run, one id, one lock. Each step runs in its own gulp process, and inheriting this
  // id is what lets those children see the lock as theirs rather than a rival's — and what
  // groups their ledger entries under the run that actually caused them.
  process.env.INDEX_RUN_ID = runId();

  const lock = acquireRunLock({ by: "index.js" });
  if (!lock.acquired && lock.lock) {
    console.error(
      `[index] refusing to start: ${lock.note || "a pipeline run is already in progress"}. ` +
        `If that run is not actually running, remove ${runLockPath()}. Two DIFFERENT series no ` +
        `longer collide — the reports and the lock now live in each series' own records folder ` +
        `(<SERIES_LOCATION>/.run/), so one series' run cannot see another's — but two runs of ` +
        `the SAME series still write the same volume folders, and that is what this refusal is ` +
        `for. Run them one after the other, or point one at a copy of the series.`
    );
    return 1;
  }
  if (!lock.acquired) {
    // The file could not be written. A bookkeeping file must not be the reason a 12-hour run
    // dies — but "nothing is preventing a second run" has to be said out loud, not swallowed.
    console.error(`[index] warning: ${lock.note}`);
  } else if (lock.note) {
    console.log(`[index] ${lock.note}`);
  }

  // A stopped run stops COMPLETELY. Node ends the process that received the signal and leaves its
  // children running, so `kill <pid>` / a container stop / an OOM kill of this runner used to leave
  // a gulp task working alone — still writing volume files, still holding the lock under a LIVE pid,
  // which makes every later run refuse until a human deletes a file. The watch stops the children,
  // waits for them, and hands the lock back on the way out (utils/shutdown.js).
  installShutdownWatch({ label: "index.js", onStop: () => releaseRunLock() });

  try {
    return await runPipelineSteps(parsed);
  } finally {
    releaseRunLock();
  }
}

module.exports = { main };

/**
 * test/test-home.js — the first thing every suite does: give the run's records a throwaway home.
 *
 * A run's memory (the step reports, the ledger, the tickets, the patch records, the transcripts)
 * now lives next to the series it is about — `<SERIES_LOCATION>/.run/`, configs/run-state.js —
 * because that is what lets another machine pull the books and continue the run. The same rule
 * that makes it right for a run makes it wrong for a test: a suite that never says where its
 * records go would write them into whatever folder `.env` names, i.e. into the corpus the suite
 * exists to protect. AGENTS.md rule 8 and gotcha 69 are exactly this rule, and before the memory
 * moved, forgetting it only ever dirtied the repo's own ignored folder. Now it would dirty the
 * books.
 *
 * So `RUN_DIR` is pinned to a throwaway folder before anything else in the suite is loaded. A
 * suite that wants its records somewhere specific (a fixture series' own `.run/`, a channel
 * folder outside a fixture repository) sets `POSTMORTEM_DIR` after this, which still wins —
 * this file provides the floor, not the ceiling.
 *
 * @module test/test-home
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Make a throwaway records folder and point the run at it.
 *
 * @returns {string} Absolute path to the folder this process keeps its records in.
 */
function useThrowawayRunHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-test-run-"));
  process.env.RUN_DIR = dir;

  // The guard is the point of the file: if the floor ever stops holding, the suite that leans on
  // it is writing into the series .env points at, and that is the failure this exists to prevent.
  const series = (process.env.SERIES_LOCATION || "").trim();
  if (series) {
    const rel = path.relative(path.resolve(series), dir);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      throw new Error(
        `test/test-home.js: the throwaway records folder (${dir}) is inside SERIES_LOCATION ` +
          `(${series}). A suite must not be able to write into the corpus it is testing.`
      );
    }
  }
  return dir;
}

const runHome = useThrowawayRunHome();

module.exports = { runHome, useThrowawayRunHome };

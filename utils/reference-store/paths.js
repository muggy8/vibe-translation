/**
 * utils/reference-store/paths.js — where a volume's reference database lives, decided
 * at CALL time from `SERIES_LOCATION` plus the volume.
 *
 * This is the file gotchas 79 and 94 were written to prevent. Both are the same mistake
 * wearing different hats: a path frozen into a module constant at require time silently
 * becomes the repo fallback on every run. Doc 03 §7.3 says per-volume files make the rule
 * **more** important, not less, because the path now depends on which volume is running —
 * a store that resolved its file once per process would hand volume 05 volume 01's facts,
 * which is not a bug in a filename, it is the spoiler guard quietly turned off.
 *
 * So: nothing here is a constant. Every function re-reads the setting when it is called.
 *
 * The second rule, and the one that makes this file different from `configs/run-state.js`:
 * **there is no repo fallback.** `runHomeDir()` falls back to the repo folder when no
 * series was chosen, and for the run's *records* that is survivable. For the corpus's
 * source of truth it is not: a store written into the tool's own folder is a store that
 * survives a change of series, is committed into the wrong repository, and is invisible to
 * the machine that pulled the books. This module **refuses** instead, and the refusal names
 * the setting to set.
 *
 * @module utils/reference-store/paths
 */

const fs = require("fs");
const path = require("path");

const { runStateSeriesDir } = require("../../configs/run-state");
require("../../types"); // JSDoc type definitions

/** The file name every volume's store uses, inside that volume's own folder (doc 03 §7). */
const REFERENCE_STORE_FILE_NAME = "series.db";

/**
 * Build the error every refusal in this file uses.
 *
 * @param {string} what - What could not be decided.
 * @param {string} how - The concrete thing the operator or caller does about it.
 * @returns {Error}
 */
function storePathError(what, how) {
  return new Error(`[reference-store] ${what} ${how}`);
}

/**
 * The series folder this call is working on.
 *
 * Read at call time (gotcha 79, gotcha 94). An explicit `seriesDir` argument wins over
 * the environment, because a test and a `--series=` command both need to name the folder
 * they mean without editing the process.
 *
 * There is no fallback to the repository folder, on purpose: see the header.
 *
 * @param {string} [seriesDir] - An explicit series folder.
 * @returns {string} Absolute path.
 */
function referenceStoreSeriesDir(seriesDir) {
  const explicit = typeof seriesDir === "string" ? seriesDir.trim() : "";
  if (explicit) return path.resolve(explicit);
  const fromEnv = runStateSeriesDir();
  if (fromEnv) return fromEnv;
  throw storePathError(
    "cannot decide which series this store belongs to: SERIES_LOCATION is not set.",
    "Set SERIES_LOCATION (or pass seriesDir explicitly). The store is deliberately NOT " +
      "kept in the ai-client folder: it is the corpus's source of truth, and it belongs " +
      "next to the books it describes."
  );
}

/**
 * The volume folder a store belongs to.
 *
 * An explicit `folder` wins. Otherwise the volume's folder is read out of the plan of
 * record (`translation-target.json`), which is the only place that knows which folder
 * installment 05 is. Reading it at call time matters for the same reason the rest of this
 * file does: the plan is rewritten by `discover`, and a folder name remembered from an
 * earlier read is a folder name that may no longer exist.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir - Absolute series folder.
 * @param {number|string} [opts.volume] - Installment number (1 or "01").
 * @param {string} [opts.folder] - The volume folder name, if the caller already knows it.
 * @returns {string} The volume folder name (relative to the series folder).
 */
function referenceStoreVolumeFolder({ seriesDir, volume, folder }) {
  const explicit = typeof folder === "string" ? folder.trim() : "";
  if (explicit) return explicit;

  const installment = installmentKey(volume);
  if (!installment) {
    throw storePathError(
      "cannot decide which volume this store belongs to: no volume was given.",
      "Pass { volume: 3 } or { folder: 'Series(03)' }."
    );
  }

  const plan = readPlanOfRecord(seriesDir);
  if (!plan) {
    throw storePathError(
      `cannot find volume ${installment}'s folder: there is no plan of record at ` +
        `${path.join(seriesDir, "translation-target.json")}.`,
      'Run "npx gulp discover" first, or pass the volume folder name explicitly.'
    );
  }
  const entry = plan.find((v) => installmentKey(v && v.installmentNumber) === installment);
  if (!entry || !entry.folder) {
    throw storePathError(
      `cannot find volume ${installment} in the plan of record ` +
        `(${path.join(seriesDir, "translation-target.json")}).`,
      `The plan lists ${plan.map((v) => v && v.installmentNumber).join(", ") || "no volumes"}. ` +
        "Re-run \"npx gulp discover\" or pass the folder name explicitly."
    );
  }
  return entry.folder;
}

/**
 * The database file for one volume.
 *
 * `<SERIES_LOCATION>/<volume folder>/series.db` — the volume's own folder, beside the
 * book, which is what makes "volume 3's file cannot contain volume 10's facts" a fact
 * about the filesystem instead of a rule the code has to remember (doc 03 §7).
 *
 * @param {Object} opts
 * @param {string} [opts.seriesDir] - Absolute series folder. Defaults to SERIES_LOCATION.
 * @param {number|string} [opts.volume] - Installment number.
 * @param {string} [opts.folder] - Volume folder name, when the caller already knows it.
 * @returns {{file: string, seriesDir: string, volumeDir: string, folder: string}}
 */
function referenceStorePath({ seriesDir, volume, folder } = {}) {
  const series = referenceStoreSeriesDir(seriesDir);
  const volFolder = referenceStoreVolumeFolder({ seriesDir: series, volume, folder });
  const volumeDir = path.join(series, volFolder);
  return {
    file: path.join(volumeDir, REFERENCE_STORE_FILE_NAME),
    seriesDir: series,
    volumeDir,
    folder: volFolder,
  };
}

/**
 * An installment number as the plan of record writes it: two digits.
 *
 * `1`, `"1"`, `"01"` and `5` all mean the volume the plan calls `01` / `05`. Accepting
 * only one spelling is how a caller gets "volume 1 is not in the plan" from a plan that
 * lists `01`.
 *
 * @param {number|string|null|undefined} volume
 * @returns {string|null} The two-digit key, or null when nothing usable was given.
 */
function installmentKey(volume) {
  if (volume === null || volume === undefined || volume === "") return null;
  const raw = String(volume).trim();
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (!digits) return null;
  return digits.padStart(2, "0");
}

/**
 * The plan of record's volume list, or null when there is no readable one.
 *
 * Read-only, and read fresh every call (see the header). A plan that does not parse is
 * reported as absent rather than guessed at — a store path invented from a broken plan is
 * a store written into the wrong folder.
 *
 * @param {string} seriesDir - Absolute series folder.
 * @returns {Array<Object>|null}
 */
function readPlanOfRecord(seriesDir) {
  const file = path.join(seriesDir, "translation-target.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const plan = JSON.parse(raw);
    return Array.isArray(plan && plan.volumes) ? plan.volumes : null;
  } catch {
    return null;
  }
}

module.exports = {
  REFERENCE_STORE_FILE_NAME,
  referenceStoreSeriesDir,
  referenceStoreVolumeFolder,
  referenceStorePath,
  installmentKey,
  readPlanOfRecord,
};

/**
 * glossary/re-render/record.js — read a volume's record **from a copy** and render its glossary.
 *
 * The one rule this file exists for: **a render-only act never opens the corpus record.** Opening a
 * volume's `series.db` with a database client folds its write-ahead log into the main file and deletes
 * the `-wal` / `-shm` sidecars beside it (gotcha 124, measured on the real volumes 1 and 2). A door that
 * only wants to *look* at a record must not be the thing that rewrites the shape of the record it looked
 * at, so the copy is made with `fs.copyFileSync` — the corpus file is read as bytes and never handed to
 * the engine — and everything after that happens to the copy.
 *
 * The copy carries the write-ahead log too. Volume 03's `series.db-wal` holds 49,472 bytes of committed
 * rows; copying the main file alone would render a record that is missing them and report the difference
 * as damage the record caused. The `-shm` sidecar is deliberately NOT copied: it is an index the engine
 * rebuilds, and a stale one copied beside a live log is a hint the engine would trust and a recovery it
 * would skip.
 *
 * @module glossary/re-render/record
 */

const fs = require("fs");
const path = require("path");

const { openReferenceStore } = require("../../utils/reference-store");
const { renderGlossary, glossaryReadingCellsForRows } = require("../../utils/reference-store/glossary-adapter");
const { readRubyGuideFile } = require("../../utils/source/ruby-guides");
const { deriveBase } = require("../../utils/reference-store/source-chapters");
require("../../types"); // JSDoc type definitions

/** The record file a volume folder holds. */
const RECORD_FILE = "series.db";

/**
 * Copy one volume's record into a scratch folder, as bytes.
 *
 * @param {Object} opts
 * @param {string} opts.volumeDir - The volume folder the record lives in.
 * @param {string} opts.scratchVolumeDir - Where the copy goes.
 * @returns {{ok: boolean, copied: string[], recordPresent: boolean, error: string|null}}
 */
function copyRecordForReading({ volumeDir, scratchVolumeDir }) {
  const source = path.join(volumeDir, RECORD_FILE);
  if (!fs.existsSync(source)) return { ok: true, copied: [], recordPresent: false, error: null };
  // The copy is opened, so it must not be the record. Copying a `series.db` onto itself and then opening
  // the result opens the corpus record: its write-ahead log is checkpointed, its `-wal` / `-shm` are
  // rewritten, and the schema migration runs in place (gotcha 124). This is refused here rather than at
  // each caller, because the caller that gets it wrong is a caller that reports the corpus as untouched.
  if (path.resolve(scratchVolumeDir) === path.resolve(volumeDir)) {
    return {
      ok: false,
      copied: [],
      recordPresent: true,
      error:
        `the scratch folder is the volume folder itself (${volumeDir}). The copy is opened to be read, ` +
        `and opening a corpus record rewrites it. Point the scratch folder outside the volume folder.`,
    };
  }
  if (path.resolve(scratchVolumeDir).startsWith(path.resolve(volumeDir) + path.sep)) {
    return {
      ok: false,
      copied: [],
      recordPresent: true,
      error: `the scratch folder (${scratchVolumeDir}) sits inside the volume folder it is copied from.`,
    };
  }
  try {
    fs.mkdirSync(scratchVolumeDir, { recursive: true });
    /** @type {string[]} */
    const copied = [];
    for (const suffix of ["", "-wal"]) {
      if (!fs.existsSync(source + suffix)) continue;
      fs.copyFileSync(source + suffix, path.join(scratchVolumeDir, RECORD_FILE + suffix));
      copied.push(path.basename(source + suffix));
    }
    // A copied `-shm` would be an index the engine might trust instead of recovering the log it was
    // copied beside. The engine builds its own; this door does not hand it a guess.
    for (const suffix of ["-shm"]) {
      fs.rmSync(path.join(scratchVolumeDir, RECORD_FILE + suffix), { force: true });
    }
    return { ok: true, copied, recordPresent: true, error: null };
  } catch (err) {
    return { ok: false, copied: [], recordPresent: true, error: String((err && err.message) || err) };
  }
}

/**
 * This volume's pronunciation-guide harvest, when it has one — the rows the guide-split explanation reads.
 *
 * @param {string} volumeDir
 * @returns {Promise<Array<{annotated?: Array<{base: string, reading: string}>}>>} Empty when the volume has no harvest.
 */
async function readHarvestRows(volumeDir) {
  const base = deriveBase(volumeDir);
  if (!base) return [];
  const harvest = await readRubyGuideFile(volumeDir, base);
  return harvest && Array.isArray(harvest.guides) ? harvest.guides : [];
}

/**
 * Render one volume's glossary **from a copy of its record**, and close the copy.
 *
 * @param {Object} opts
 * @param {number} opts.volume - Installment number.
 * @param {string} opts.folder - The volume folder name.
 * @param {string} opts.seriesDir - The series folder the volume folder sits in.
 * @param {string} opts.scratchSeriesDir - Where the copy goes.
 * @param {string} opts.title - The title block the stage renders with, so the render reproduces the
 *   document the stage published rather than a bare `# Glossary`.
 * @returns {Promise<{ok: boolean, markdown: string|null, readingCells: Map<string, string>, readingTotals: Object|null, refusal: {rule: string, because: string, fix: string}|null, copied: string[]}>}
 *   `readingCells` is what the record says each row's `Readings` cell holds, keyed on
 *   `normalizeQuote(term)` — asked through the same helper {@link renderGlossary} used, against this same
 *   store, so the comparison gate checks the render against the record rather than against the render's own
 *   opinion of itself.
 */
async function renderGlossaryFromRecordCopy({ volume, folder, seriesDir, scratchSeriesDir, title }) {
  const volumeDir = path.join(seriesDir, folder);
  const scratchVolumeDir = path.join(scratchSeriesDir, folder);
  const copy = copyRecordForReading({ volumeDir, scratchVolumeDir });
  if (!copy.ok) {
    return {
      ok: false,
      markdown: null,
      readingCells: new Map(),
      readingTotals: null,
      copied: [],
      refusal: {
        rule: "glossary-record-copy-failed",
        because: `could not copy ${volumeDir}/${RECORD_FILE} to read it: ${copy.error}`,
        fix: "fix whatever is holding the file, then run the rehearsal again.",
      },
    };
  }
  if (!copy.recordPresent) {
    return {
      ok: false,
      markdown: null,
      readingCells: new Map(),
      readingTotals: null,
      copied: [],
      refusal: {
        rule: "reference-record-not-found",
        because:
          `${folder} holds no ${RECORD_FILE}, so there is no record to render a glossary out of. ` +
          "This door renders a published glossary from the record that published it; it does not build one.",
        fix: "run the glossary stage for this volume, which opens the record and files the rows into it.",
      },
    };
  }

  let store = null;
  try {
    store = openReferenceStore({ seriesDir: scratchSeriesDir, volume, folder, create: false, stage: "merge" });
    const markdown = renderGlossary(store, { volume, title });
    // The gate needs to know what the record says the reading column holds. Asked here, from this store,
    // through the same helper the renderer just used — a gate that re-derived the answer a different way
    // would be a second opinion about one fact, which is the disagreement this store keeps paying to avoid.
    const readings = glossaryReadingCellsForRows(store, { volume });
    if (!readings.ok) {
      return {
        ok: false,
        markdown: null,
        readingCells: new Map(),
        readingTotals: null,
        copied: copy.copied,
        refusal: {
          rule: readings.refusal.rule,
          because: readings.refusal.because,
          fix: readings.refusal.fix,
        },
      };
    }
    return { ok: true, markdown, readingCells: readings.cells, readingTotals: readings.totals, refusal: null, copied: copy.copied };
  } catch (err) {
    return {
      ok: false,
      markdown: null,
      readingCells: new Map(),
      readingTotals: null,
      copied: copy.copied,
      refusal: {
        rule: "glossary-record-unreadable",
        because: `the copy of ${folder}'s record could not be opened or rendered: ${String((err && err.message) || err)}`,
        fix: "check the record with `npm run pipeline -- --stages=extract` and re-run the rehearsal.",
      },
    };
  } finally {
    if (store && typeof store.close === "function") store.close();
  }
}

module.exports = {
  RECORD_FILE,
  copyRecordForReading,
  readHarvestRows,
  renderGlossaryFromRecordCopy,
};

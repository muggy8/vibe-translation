/**
 * utils/delivery-verify/book.js — the half of the deliverable the pipeline itself signs off on.
 *
 * Read through utils/translation-report.js, the module that WRITES the report, so
 * the triage and this measurement cannot describe one report two different ways.
 */

const path = require("path");

const { readJsonForMeasurement } = require("./read");
const { readTranslationReport, summarizeReportRows } = require("../translation-report");
const { DISPUTES_FILE } = require("../disputes");

// ─── The book ─────────────────────────────────────────────────────────────────

/**
 * Measure the deliverable the pipeline itself signs off on.
 *
 * @param {string} seriesDir
 * @param {string[]} notes - Measurement notes are appended here.
 * @returns {Promise<Object|null>} The roll-up, or null when there is no publish report yet.
 */
async function measureBook(seriesDir, notes) {
  const report = await readTranslationReport(seriesDir);
  if (!report) return null;
  const summary = summarizeReportRows(report.chapters);

  // The disputes queue is part of what the run produced (the report itself carries it), and it is
  // the one thing the translation stage discovered that the reference layer has to fix. It is read
  // here rather than through `loadGlossaryDisputes`, because that reader answers "corrupt file"
  // with an empty list — and an empty list would be counted as three disputes having been settled.
  const queue = await readJsonForMeasurement(path.join(seriesDir, DISPUTES_FILE));
  let disputes = 0;
  if (queue.state === "read") {
    const list =
      queue.value && Array.isArray(queue.value.disputes)
        ? queue.value.disputes
        : Array.isArray(queue.value)
          ? queue.value
          : [];
    disputes = list.length;
  } else if (queue.state === "unreadable") {
    disputes = null;
    notes.push(`the glossary disputes queue could not be read — the signal is not compared (${queue.note})`);
  }

  return { present: true, file: report.file, generatedAt: report.generatedAt, disputes, ...summary };
}

module.exports = { measureBook };

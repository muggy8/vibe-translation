/**
 * glossary/store.js — this stage's side of the volume's reference record.
 *
 * Slice 6. The store itself is `utils/reference-store/`; this file is the glossary stage's own glue:
 * when the record is opened, what gets filed in it, and when it is audited. It lives here rather than
 * in `utils/reference-store/` because it knows the stage's file names and its context object, and in
 * its own file rather than in `task.js` because `qa.js` and `chunked.js` need it too.
 *
 * **No agent reaches any of this.** No tool, no prompt, no agent-facing query. That is slice 7.
 *
 * Everything is behind `GLOSSARY_STORE_VALIDATORS` (checked by the caller, once): with the flag off,
 * `ctx.refStore` is never set and every function here returns without touching anything.
 *
 * One asymmetry worth naming, because it is the shape of the pipeline rather than a preference: the
 * glossary stage **does** seal the volume, and the character-voice stage seals it again. `npx gulp`
 * runs each stage over every volume before the next stage starts, so "the end of a volume's
 * pre-production" is not one moment — volume 05's glossary is built before volume 01's voice reference
 * exists. Sealing is therefore the end of each stage's work on that volume, and it is idempotent: the
 * marker says the record is published, and the second seal marks the rows the voice stage added.
 *
 * What that sentence used to claim — that a half-finished volume is stopped by a voice-mirror marker
 * rather than by the seal, naming an `openVolumeRecord` option that does not exist — was wrong, and it
 * was wrong in the direction that mattered: the seal IS the gate, `reference-volume-unsealed` is HIGH,
 * and it is the check that stopped volume 02 from starting at all when volume 01's rebuild published a
 * record and never sealed it (gotcha 102). The voice mirror marker (`documentMirrored`) does real work
 * too, but a different work: it decides whether the **coverage question is asked at all** for this
 * volume, so a volume whose voice stage never ran is caught by the sealing check and not by a coverage
 * finding that would be a false positive.
 *
 * @module glossary/store
 */

const fs = require("fs").promises;
require("../types"); // JSDoc type definitions
const {
  openVolumeRecord,
  importVolumeExtraction,
  importVolumeArtifacts,
  resetDocumentMirror,
  auditVolumeRecord,
  sealVolumeRecord,
  buildGradeSample,
  glossaryNewestSections,
} = require("../utils/reference-store");

/** The artifact this stage publishes, for the audit report's headings. */
const GLOSSARY_ARTIFACT_NAME = "glossary.md";

/**
 * Open this volume's reference record, carrying the previous volume's published record in first.
 *
 * A refusal here stops the volume: the integrity gate inside copy-forward is the rule that a volume
 * whose character-voice reference lost characters may not be copied forward, with no exception.
 *
 * @param {{ values: Object, folderName: string, seriesDir: string, previousFolderName: string|null }} ctx
 * @param {number|null} previousVolume - The previous volume's installment number, when there is one.
 * @returns {{ok: boolean, opened: Object|null, error: string|null}}
 */
function openGlossaryRecord(ctx, previousVolume) {
  const opened = openVolumeRecord({
    volume: ctx.values.INSTALLMENT_NUMBER,
    folder: ctx.folderName,
    seriesDir: ctx.seriesDir,
    previousVolume,
    previousFolder: ctx.previousFolderName || null,
    bundleSegments: ctx.bundle && ctx.bundle.segments ? ctx.bundle.segments : null,
  });
  if (opened.ok) {
    const backfill = opened.glossaryBackfill;
    if (backfill && backfill.ran) {
      console.log(
        `Volume ${ctx.values.INSTALLMENT_NUMBER}: the reference record held no glossary rows of its own, so it read this ` +
          `volume's published ${GLOSSARY_ARTIFACT_NAME} into itself (${backfill.imported} new row(s), ${backfill.carried} ` +
          `already held from earlier volumes, ${backfill.refused.length} refused for want of a line this volume's text prints).`
      );
    }
    return { ok: true, opened, error: null };
  }
  const detail = opened.findings.map((f) => `${f.severity} ${f.kind}: ${f.message}`).join("\n  ");
  return {
    ok: false,
    opened,
    error:
      `the reference record could not be opened, so this volume is not built.\n  ` +
      `${opened.refusal.because}\n  Fix: ${opened.refusal.fix}` +
      (detail ? `\n  Findings:\n  ${detail}` : ""),
  };
}

/**
 * File this volume's extracted new terms in its record.
 *
 * These are not glossary rows and never render as one: they are the record of what this volume's
 * extraction pass found, which is what makes "the glossary has no row for a term the extractor found"
 * a query with a number in it instead of something a validator agent might notice.
 *
 * @param {{ values: Object, folderName: string, seriesDir: string, refStore: Object|null }} ctx
 * @param {Array<Object>} terms - The parsed `glossary-new-terms.json`.
 * @returns {Object|null} The import report, or null when no record is open.
 */
function fileGlossaryExtraction(ctx, terms) {
  if (!ctx.refStore) return null;
  const filed = importVolumeExtraction({
    volume: ctx.values.INSTALLMENT_NUMBER,
    folder: ctx.folderName,
    seriesDir: ctx.seriesDir,
    newTerms: terms,
  });
  const found = filed.terms;
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: reference record filed ${found.importedCount} new term(s) ` +
      `(${found.carried.length} already filed); ${found.refused.length} refused because the volume's text ` +
      "does not print them."
  );
  return found;
}

/**
 * Rebuild this volume's record of its published glossary.
 *
 * Rebuilt rather than appended, because the QA loop re-audits after every feedback pass and the
 * feedback pass edits the file. Only this volume's own glossary rows are replaced — the character-voice
 * stage's rows in the same record are a different document and are not touched.
 *
 * @param {{ values: Object, refStore: Object|null, glossaryOutputFile: string }} ctx
 * @returns {Promise<Object|null>} The import report, or null when no record is open.
 */
async function mirrorGlossaryArtifact(ctx) {
  if (!ctx.refStore) return null;
  const markdown = await fs.readFile(ctx.glossaryOutputFile, "utf8").catch(() => null);
  if (markdown === null) return null;
  resetDocumentMirror(ctx.refStore, { document: "glossary" });
  const { glossary } = importVolumeArtifacts(ctx.refStore, { glossaryMarkdown: markdown });
  ctx.storeImport = glossary;
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: reference record mirrors ${glossary.imported.length} row(s) ` +
      `from ${GLOSSARY_ARTIFACT_NAME} (${glossary.carried.length} already in the record, ` +
      `${glossary.refused.length} refused, ${glossary.castRegistered} cast entr(ies) registered).`
  );
  return glossary;
}

/**
 * Run the deterministic audit and write the report the validator agent used to write.
 *
 * @param {{ values: Object, refStore: Object|null, glossaryOutputFile: string, storeImport: Object|null }} ctx
 * @returns {Promise<Object|null>} The audit, or null when no record is open.
 */
async function auditGlossaryArtifact(ctx) {
  if (!ctx.refStore) return null;
  const markdown = await fs.readFile(ctx.glossaryOutputFile, "utf8").catch(() => "");
  const audit = auditVolumeRecord(ctx.refStore, {
    title: "Glossary",
    file: GLOSSARY_ARTIFACT_NAME,
    markdown,
    refused: (ctx.storeImport && ctx.storeImport.refused) || [],
  });
  ctx.storeAudit = audit;
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: deterministic audit — ${audit.findings.length} finding(s), ` +
      `${audit.highFindings.length} at HIGH; ${audit.checked} citation(s) re-checked against the source text.`
  );
  return audit;
}

/**
 * The sample the acceptance grader is shown instead of the whole glossary.
 *
 * @param {{ values: Object, refStore: Object|null, glossaryOutputFile: string }} ctx
 * @returns {Promise<string|null>} The sample text, or null when no record is open (the grader then
 *   gets the whole file, exactly as it does today).
 */
async function glossaryGradeSample(ctx) {
  if (!ctx.refStore) return null;
  const markdown = await fs.readFile(ctx.glossaryOutputFile, "utf8").catch(() => null);
  if (markdown === null) return null;
  const sample = buildGradeSample(markdown, {
    file: GLOSSARY_ARTIFACT_NAME,
    volume: ctx.values.INSTALLMENT_NUMBER,
    heading: "## ",
    newestSections: glossaryNewestSections(ctx.refStore),
  });
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: graded sample — ${sample.sectionsShown} of ` +
      `${sample.sectionsTotal} section(s), ${sample.chars} characters.`
  );
  return sample.text;
}

/**
 * Seal this volume's record at the end of the glossary stage's work on it.
 *
 * Idempotent, and deliberately not the last seal the volume gets — see the module header.
 *
 * @param {{ values: Object, refStore: Object|null }} ctx
 * @returns {void}
 */
function sealGlossaryRecord(ctx) {
  if (!ctx.refStore) return;
  const sealed = sealVolumeRecord(ctx.refStore);
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: reference record sealed by the glossary stage ` +
      `(${sealed.sealedRows} row(s) newly sealed${sealed.alreadySealed ? ", the record was already published" : ""}).`
  );
}

module.exports = {
  GLOSSARY_ARTIFACT_NAME,
  openGlossaryRecord,
  fileGlossaryExtraction,
  mirrorGlossaryArtifact,
  auditGlossaryArtifact,
  glossaryGradeSample,
  sealGlossaryRecord,
};

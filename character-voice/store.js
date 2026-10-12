/**
 * character-voice/store.js — this stage's side of the volume's reference record.
 *
 * Slice 6. The store itself is `utils/reference-store/`; this file is the voice stage's own glue:
 * when the record is opened, what gets filed in it, when it is audited, and when it is sealed. It
 * lives here rather than in `utils/reference-store/` because it knows the stage's file names and its
 * context object, and it lives in its own file rather than inside `task.js` because `qa.js` and
 * `chunked.js` need it too and `task.js` already requires both of them.
 *
 * **No agent reaches any of this.** There is no tool here, no prompt mentions it, and an agent cannot
 * read, write, or query the record through it. That is slice 7.
 *
 * Everything in this file is behind `VOICE_STORE_VALIDATORS` (checked by the caller, once): with the
 * flag off, `ctx.refStore` is never set and every function here returns without touching anything.
 *
 * @module character-voice/store
 */

const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const {
  openVolumeRecord,
  importVolumeExtraction,
  importVolumeArtifacts,
  resetDocumentMirror,
  auditVolumeRecord,
  sealVolumeRecord,
  buildGradeSample,
  voiceNewestSections,
  rosterReconciliationLog,
  moveArtifactAside,
  ensureArtifactRejectIgnoreRule,
} = require("../utils/reference-store");

/** The artifact this stage publishes, for the audit report's headings. */
const VOICE_ARTIFACT_NAME = "character-voice.md";

/**
 * Open this volume's reference record, carrying the previous volume's published record in first.
 *
 * A refusal here stops the volume. The refusal is the account owner's rule that a volume whose
 * character-voice reference lost characters may not be copied forward — HIGH, no exception, no
 * downgrade — so the volume is not built on top of it.
 *
 * @param {{ values: Object, folderName: string, volumeDir: string, seriesDir: string, previousFolderName: string|null }} ctx
 * @param {number|null} previousVolume - The previous volume's installment number, when there is one.
 * @returns {{ok: boolean, opened: Object|null, error: string|null}}
 */
function openVoiceRecord(ctx, previousVolume) {
  const opened = openVolumeRecord({
    volume: ctx.values.INSTALLMENT_NUMBER,
    folder: ctx.folderName,
    seriesDir: ctx.seriesDir,
    previousVolume,
    previousFolder: ctx.previousFolderName || null,
    bundleSegments: ctx.bundle && ctx.bundle.segments ? ctx.bundle.segments : null,
  });
  if (opened.ok) {
    if (opened.toppedUp && !opened.toppedUp.skipped && opened.toppedUp.total > 0) {
      console.log(
        `Volume ${ctx.values.INSTALLMENT_NUMBER}: reference record topped up from volume ${previousVolume} ` +
          `(${opened.toppedUp.total} row(s) this record was missing — the copy was made before that volume's ` +
          "voice stage finished)."
      );
    }
    const backfill = opened.glossaryBackfill;
    if (backfill && backfill.ran) {
      console.log(
        `Volume ${ctx.values.INSTALLMENT_NUMBER}: the reference record held no glossary rows of its own, so it read this ` +
          `volume's published glossary.md into itself (${backfill.imported} new row(s), ${backfill.carried} already held ` +
          `from earlier volumes, ${backfill.refused.length} refused for want of a line this volume's text prints, ` +
          `${backfill.castRegistered} roster entr(ies) registered). The glossary stage skips a volume whose accepted ` +
          `glossary is already on disk, and it skips before its store block — this is what keeps the roster whole.`
      );
    }
    for (const line of rosterReconciliationLog(ctx.values.INSTALLMENT_NUMBER, opened.roster)) console.log(line);
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
 * File this volume's extraction claims in its record.
 *
 * @param {{ values: Object, folderName: string, seriesDir: string, refStore: Object|null }} ctx
 * @param {Array<Object>} entries - The parsed `character-voice-new.json`.
 * @returns {Object|null} The import report, or null when no record is open.
 */
function fileVoiceExtraction(ctx, entries) {
  if (!ctx.refStore) return null;
  const filed = importVolumeExtraction({
    volume: ctx.values.INSTALLMENT_NUMBER,
    folder: ctx.folderName,
    seriesDir: ctx.seriesDir,
    voiceEntries: entries,
  });
  const voice = filed.voice;
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: reference record filed ${voice.importedCount} extraction claim(s) ` +
      `(${voice.characters} character(s), ${voice.povCount} POV claim(s), ${voice.carried.length} already filed); ` +
      `${voice.refused.length} refused for want of a quote that verifies.`
  );
  return voice;
}

/**
 * Rebuild this volume's record of its published character-voice document.
 *
 * The audit reads the mirror, so the mirror has to be the file as it is on disk right now: it is
 * rebuilt after the compile pass and again after every feedback pass. Rows this volume wrote and has
 * not sealed are replaced through the store's own delete-own-rows verb; rows carried from an earlier
 * volume belong to that volume's published record and are not touched.
 *
 * @param {{ values: Object, refStore: Object|null, voiceOutputFile: string }} ctx
 * @returns {Promise<Object|null>} The import report, or null when no record is open.
 */
async function mirrorVoiceArtifact(ctx) {
  if (!ctx.refStore) return null;
  const markdown = await fs.readFile(ctx.voiceOutputFile, "utf8").catch(() => null);
  if (markdown === null) return null;
  resetDocumentMirror(ctx.refStore, { document: "voice" });
  const { voice } = importVolumeArtifacts(ctx.refStore, { voiceMarkdown: markdown });
  ctx.storeImport = voice;
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: reference record mirrors ${voice.imported.length} bullet(s) ` +
      `from ${VOICE_ARTIFACT_NAME} (${voice.carried.length} already in the record, ${voice.refused.length} ` +
      "refused for want of a quote that verifies)."
  );
  return voice;
}

/**
 * Run the deterministic audit and write the report the validator agent used to write.
 *
 * What the audit does NOT do is stop the volume. The report is written and the HIGH count is logged;
 * the QA loop's gate is still the acceptance grade, and the grader is reading the report this function
 * just wrote, so a HIGH finding reaches the loop through the grade it drags down rather than through a
 * check the loop runs itself. Sealing is the same shape: it is the end of the volume's pre-production,
 * and the volume that gets there is sealed whether or not the audit found anything (the volume that
 * *threw* on the way is the one left unsealed, and an unsealed volume is what copy-forward refuses).
 *
 * @param {{ values: Object, refStore: Object|null, voiceOutputFile: string, storeImport: Object|null }} ctx
 * @returns {Promise<Object|null>} The audit, or null when no record is open.
 */
async function auditVoiceArtifact(ctx) {
  if (!ctx.refStore) return null;
  const markdown = await fs.readFile(ctx.voiceOutputFile, "utf8").catch(() => "");
  const audit = auditVolumeRecord(ctx.refStore, {
    title: "Character-voice reference",
    file: VOICE_ARTIFACT_NAME,
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
 * The sample the acceptance grader is shown instead of the whole reference.
 *
 * @param {{ values: Object, refStore: Object|null, voiceOutputFile: string }} ctx
 * @returns {Promise<string|null>} The sample text, or null when no record is open (the grader then
 *   gets the whole file, exactly as it does today).
 */
async function voiceGradeSample(ctx) {
  if (!ctx.refStore) return null;
  const markdown = await fs.readFile(ctx.voiceOutputFile, "utf8").catch(() => null);
  if (markdown === null) return null;
  const sample = buildGradeSample(markdown, {
    file: VOICE_ARTIFACT_NAME,
    volume: ctx.values.INSTALLMENT_NUMBER,
    heading: "### ",
    newestSections: voiceNewestSections(ctx.refStore),
  });
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: graded sample — ${sample.sectionsShown} of ` +
      `${sample.sectionsTotal} section(s), ${sample.chars} characters.`
  );
  return sample.text;
}

/**
 * The deterministic audit for the **assembled** route: audit the record against the artifacts this
 * route rendered, say how the volume was read, and write the report the grader is handed.
 *
 * It deliberately does **not** mirror the artifacts back into the record. On the author route the file
 * is what an agent wrote and the record has to be made to agree with it; on the assembled route the
 * file *is* the record's own render, and mirroring it would file the same claims twice under two
 * different provenances — and the second copy would be the one the audit then reported on.
 *
 * @param {{ values: Object, refStore: Object|null, voiceOutputFile: string, validationOutputFile: string, readingReport?: string }} ctx
 * @param {{refused?: Array<Object>}} [opts] - What the adoption step refused, so the report names it.
 * @returns {Promise<Object|null>} The audit, or null when no record is open.
 */
async function auditAssembledArtifacts(ctx, { refused = [] } = {}) {
  if (!ctx.refStore) return null;
  const markdown = await fs.readFile(ctx.voiceOutputFile, "utf8").catch(() => "");
  const audit = auditVolumeRecord(ctx.refStore, {
    title: "Character-voice reference (assembled from the volume's reading pass)",
    file: VOICE_ARTIFACT_NAME,
    markdown,
    refused,
  });
  ctx.storeAudit = audit;
  ctx.storeImport = { refused };

const report = ctx.readingReport || "";
  const full = report ? `${audit.markdown}\n${report}` : audit.markdown;
  await fs.writeFile(ctx.validationOutputFile, full, "utf8");

  // The audit report **next to the artifact it judges**, the way `rebuild-voice.js` writes it.
  //
  // The stage route ran the audit and folded its text into the validation report, and never wrote this
  // file — so both real volume folders held a `character-voice.md-audit.md` from a run months old,
  // describing a record that had since been retired, sitting beside a reference that no longer matched
  // it. A stale report beside an artifact is worse than no report: it is the document a person opens
  // when they want to know what the record says about the file in front of them. The superseded one is
  // kept, numbered, like every other artifact this pipeline replaces.
  const volumeDir = path.dirname(ctx.voiceOutputFile);
  const auditFile = `${VOICE_ARTIFACT_NAME}-audit.md`;
  const aside = moveArtifactAside(volumeDir, auditFile);
  if (aside.ok) {
    await fs.writeFile(path.join(volumeDir, auditFile), audit.markdown, "utf8");
    ensureArtifactRejectIgnoreRule(volumeDir);
  }

  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: deterministic audit — ${audit.findings.length} finding(s), ` +
      `${audit.highFindings.length} at HIGH; ${audit.checked} citation(s) re-checked against the source text.`
  );
  return audit;
}

/**
 * Seal this volume's record: the last act of its pre-production.
 *
 * @param {{ values: Object, refStore: Object|null }} ctx
 * @returns {void}
 */
function sealVoiceRecord(ctx) {
  if (!ctx.refStore) return;
  const sealed = sealVolumeRecord(ctx.refStore);
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: reference record sealed (${sealed.sealedRows} row(s), ` +
      `${sealed.snapshot} in the volume's snapshot).`
  );
  ctx.refStore.close();
  ctx.refStore = null;
}

module.exports = {
  VOICE_ARTIFACT_NAME,
  openVoiceRecord,
  fileVoiceExtraction,
  mirrorVoiceArtifact,
  auditVoiceArtifact,
  auditAssembledArtifacts,
  voiceGradeSample,
  sealVoiceRecord,
};

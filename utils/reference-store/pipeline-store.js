/**
 * utils/reference-store/pipeline-store.js — the pipeline's side of the reference store.
 *
 * Nothing in the pipeline wrote to `series.db` before slice 6, so the integrity queries had nothing
 * to answer. This module is the code-side door: it opens a volume's record, carries the previous
 * volume's published record into it, files what this volume already produced, measures who is in the
 * volume's text, runs the audit, and seals the volume when its pre-production is done.
 *
 * **It is not agent tool access.** Every function here is called from a stage's own orchestration,
 * from code that already reads the artifact files and already writes them. An agent cannot reach any
 * of it, and no prompt mentions it — that is slice 7, and the shape it will need
 * (`createReferenceTools({volume, stage})`) is deliberately not built here.
 *
 * The order the stages use, and why it is that order:
 *
 *   1. carry-forward — the inherited record must be sound before anything is added to it, and this
 *      is the one place the sealing question is asked about a finished volume (decision: a volume
 *      whose voice reference lost characters may not be copied forward, no exception);
 *   2. import the extraction claims — the cheapest data the pipeline has, because it was already
 *      paid for;
 *   3. import the published artifact — the rows that *are* the document;
 *   4. measure presence — who is actually in this volume's text;
 *   5. audit — the store's questions, the artifact's shape, and what the document failed to adopt;
 *   6. seal — the last act of a stage's work on a volume. Both stages seal, because `npx gulp` runs
 *      each stage over every volume before the next stage starts: volume 05's glossary is built before
 *      volume 01's voice reference exists, so "the end of a volume's pre-production" is not one moment.
 *      Sealing is idempotent, and the second seal marks the rows the voice stage added.
 *
 * Where the hard stop actually lands, since it is not where it looks like it should be: a volume whose
 * character-voice reference lost characters is caught by **its own** audit (HIGH), and it is the *next*
 * volume's copy-forward that refuses to carry it — by which time the voice mirror marker is in the
 * source record and the coverage question is being asked about it. A damaged volume is therefore
 * published and then stopped, not stopped before it is published. That is what decision 1 says
 * ("may not be copied forward"), and it is worth knowing that the cost is one volume of work before
 * the run halts.
 *
 * @module utils/reference-store/pipeline-store
 */

const fs = require("fs");

const { openReferenceStore } = require("./open");
const { referenceStorePath } = require("./paths");
const { copyForwardStore, topUpVolumeRecord } = require("./copy-forward");
const { DOCUMENT_SOURCE_STAGE } = require("./schema");
const { importGlossary } = require("./glossary-adapter");
const { importVoice } = require("./voice-adapter");
const { importVoiceExtraction, importNewTerms } = require("./extraction-adapter");
const {
  VALIDATION_STEP,
  artifactShapeFindings,
  unadoptedVoiceClaims,
  unadoptedTerms,
  absentCharacters,
  renderAuditReport,
} = require("./validation");
require("../../types"); // JSDoc type definitions

/**
 * Whether this volume already has a reference record.
 *
 * @param {{volume: number|string, folder?: string, seriesDir?: string}} opts
 * @returns {boolean}
 */
function volumeRecordExists({ volume, folder, seriesDir }) {
  try {
    return fs.existsSync(referenceStorePath({ seriesDir, volume, folder }).file);
  } catch {
    // paths.js refuses rather than guessing a folder. "No record" is the honest answer when the
    // folder cannot be decided, because the caller then takes the same path it takes today.
    return false;
  }
}

/**
 * Open this volume's reference record, carrying the previous volume's published record in first
 * when this volume does not have one yet.
 *
 * Carrying forward is skipped when the volume already has a record — a re-run adds to a volume's
 * record, it does not erase it, and `copyForwardStore` refuses to overwrite one for exactly that
 * reason. It is a hard stop when the previous volume's record exists but is not sound: the audit
 * there is the account owner's rule that a volume whose character-voice reference lost characters
 * may not be copied forward, with no exception and no downgrade.
 *
 * @param {Object} opts
 * @param {number|string} opts.volume
 * @param {string} [opts.folder]
 * @param {string} [opts.seriesDir]
 * @param {number|string|null} [opts.previousVolume]
 * @param {string|null} [opts.previousFolder]
 * @param {string} [opts.stage] - The write scope this handle stamps into every row it writes.
 * @param {Array<{id: string, file: string, chars?: number}>} [opts.bundleSegments] - The volume's
 *   source segments as the stage resolved them (`utils/source.js`'s bundle). Passed because a
 *   plain-text volume has no bundle file on disk for `listVolumeChapters` to find.
 * @returns {{ok: boolean, store: ReferenceStore|null, carried: Object|null, toppedUp: Object|null, refusal: ReferenceRefusal|null, findings: PostMortemFinding[]}}
 */
function openVolumeRecord({ volume, folder, seriesDir, previousVolume = null, previousFolder = null, stage = DOCUMENT_SOURCE_STAGE, bundleSegments = null }) {
  let carried = null;
  let toppedUp = null;

  if (previousVolume) {
    if (!volumeRecordExists({ volume, folder, seriesDir })) {
      carried = copyForwardStore({
        fromVolume: Number(previousVolume),
        toVolume: Number(volume),
        seriesDir,
        fromFolder: previousFolder || undefined,
        toFolder: folder || undefined,
      });
      if (!carried.ok) {
        return { ok: false, store: null, carried, toppedUp: null, refusal: carried.refusal, findings: carried.findings };
      }
      // copyForwardStore leaves its destination open so the caller can verify it; this one is done
      // with it, and opening the same file twice while a handle is still on it is how a stale read
      // starts.
      if (typeof carried.closeDest === "function") carried.closeDest();
    } else {
      // The record is already here — which, for every volume after the first, means it was made by
      // an earlier stage, from a source that has since been finished. Top it up rather than leave it
      // holding an earlier volume's unfinished half.
      toppedUp = topUpVolumeRecord({
        fromVolume: Number(previousVolume),
        toVolume: Number(volume),
        seriesDir,
        fromFolder: previousFolder || undefined,
        toFolder: folder || undefined,
      });
      if (!toppedUp.ok) {
        return { ok: false, store: null, carried: null, toppedUp, refusal: toppedUp.refusal, findings: toppedUp.findings };
      }
    }
  }

  const store = openReferenceStore({ volume, folder, seriesDir, stage });
  const registered = store.registerChaptersFromSource(bundleSegments);
  if (!registered.ok) {
    store.close();
    return {
      ok: false,
      store: null,
      carried,
      toppedUp,
      refusal: {
        verb: "open_volume_record",
        rule: "reference-source-unreadable",
        because: `this volume's own source could not be listed: ${registered.error}`,
        fix: "extract the volume first; the store cites the same chapter files the evidence rule reads.",
      },
      findings: [],
    };
  }

  return { ok: true, store, carried, toppedUp, refusal: null, findings: [] };
}

/**
 * File this volume's extraction results in its record, in a handle scoped to the extract stage.
 *
 * A separate handle, deliberately: the rows the extractor produced are stamped
 * `source_stage: "extract"` and the rows that came out of the published document are stamped
 * `"import"`, and the difference is what keeps the extraction from counting as coverage for a
 * reference that lost the character (`schema.js`'s `EXTRACTION_SOURCE_STAGE`). The write scope is
 * frozen when a store is opened, so the two stamps need two handles.
 *
 * @param {Object} opts
 * @param {number|string} opts.volume
 * @param {string} [opts.folder]
 * @param {string} [opts.seriesDir]
 * @param {Array<Object>|null} [opts.voiceEntries] - Parsed `character-voice-new.json`.
 * @param {Array<Object>|null} [opts.newTerms] - Parsed `glossary-new-terms.json`.
 * @returns {{ok: boolean, voice: Object|null, terms: Object|null}}
 */
function importVolumeExtraction({ volume, folder, seriesDir, voiceEntries = null, newTerms = null }) {
  const store = openReferenceStore({ volume, folder, seriesDir, stage: "extract" });
  try {
    const voice = voiceEntries ? importVoiceExtraction(store, voiceEntries) : null;
    const terms = newTerms ? importNewTerms(store, newTerms) : null;
    return { ok: true, voice, terms };
  } finally {
    store.close();
  }
}

/**
 * Import this volume's published artifact rows into its record.
 *
 * Called after the artifact is on disk and after the carry-forward gate has already passed, so the
 * rows describe the file the pipeline actually published — including its damage, which is the point:
 * the store agrees with the file, and then the audit says what is wrong with the file.
 *
 * @param {ReferenceStore} store
 * @param {{glossaryMarkdown?: string|null, voiceMarkdown?: string|null}} artifacts
 * @returns {{glossary: Object|null, voice: Object|null}}
 */
function importVolumeArtifacts(store, { glossaryMarkdown = null, voiceMarkdown = null }) {
  return {
    glossary: glossaryMarkdown !== null && glossaryMarkdown !== undefined ? importGlossary(store, glossaryMarkdown) : null,
    voice: voiceMarkdown !== null && voiceMarkdown !== undefined ? importVoice(store, voiceMarkdown) : null,
  };
}

/**
 * Measure who this volume's own text contains.
 *
 * @param {ReferenceStore} store
 * @returns {{ok: boolean, measured: number, present: number, absent: number, refusal: ReferenceRefusal|null}}
 */
function measureVolumePresence(store) {
  const result = store.recordCastPresence();
  if (!result.ok) return { ok: false, measured: 0, present: 0, absent: 0, refusal: result.refusal };
  return { ok: true, measured: result.measured, present: result.present, absent: result.absent, refusal: null };
}

/**
 * Rebuild this volume's own mirror of its published document.
 *
 * The QA loop re-audits after every feedback pass, and the feedback pass edits the artifact. A
 * mirror that is only ever added to would keep the rows from the version the agent has already
 * rewritten, so the audit would grade a document that no longer exists. Resetting the mirror is the
 * honest shape — and it is a legal one: the rows being removed are this volume's own, unsealed, and
 * written by this handle's stage, which is exactly the set `delete_own_fact` exists for. Rows carried
 * from an earlier volume belong to that volume's published record and are not touched, and neither
 * are this volume's extraction claims, which are the extractor's record rather than the document's.
 *
 * @param {ReferenceStore} store
 * @param {{document?: "voice"|"glossary"}} [opts] - Which mirror to rebuild. The two documents share
 *   one volume's record, and a voice-stage reset must not erase the glossary stage's rows.
 * @returns {{deleted: number, refused: Array<{id: string, because: string}>}}
 */
function resetDocumentMirror(store, { document = "voice" } = {}) {
  const aspectClause = document === "glossary" ? "AND aspect = 'term_usage'" : "AND aspect != 'term_usage'";
  const rows = store.db
    .prepare(`SELECT id FROM facts WHERE owner_volume = ? AND source_stage = ? AND sealed = 0 ${aspectClause} ORDER BY ord`)
    .all(store.volume, DOCUMENT_SOURCE_STAGE);
  const refused = [];
  let deleted = 0;
  for (const row of rows) {
    const result = store.deleteOwnFact(row.id, "rebuilding this volume's mirror of its published document before re-auditing it");
    if (result.ok) deleted += 1;
    else refused.push({ id: row.id, because: result.refusal.because });
  }
  return { deleted, refused };
}

/**
 * Run the whole deterministic audit of one volume and render the report its validator used to write.
 *
 * @param {ReferenceStore} store
 * @param {Object} opts
 * @param {string} opts.title - Report heading, e.g. "Character-voice reference".
 * @param {string} opts.file - The artifact file this audit describes.
 * @param {string} opts.markdown - The artifact as it is on disk.
 * @param {Array<Object>} [opts.refused] - Rows the imports refused, for the report.
 * @param {string} [opts.step]
 * @returns {{findings: PostMortemFinding[], highFindings: PostMortemFinding[], markdown: string, counts: Object<string, number>, checked: number, presence: Object, unadopted: Array<Object>, unadoptedTerms: Array<Object>, absent: Array<Object>}}
 */
function auditVolumeRecord(store, { title, file, markdown, refused = [], step = VALIDATION_STEP }) {
  // Presence first: the coverage question is refined by it, and running the audit before the
  // measurement would answer the strict version of the question and report characters who are
  // simply not in the book.
  const presence = measureVolumePresence(store);
  const audit = store.integrityFindings({ volume: String(store.volume), step });
  const shape = artifactShapeFindings(markdown, { file, volume: String(store.volume), step });
  const findings = [...audit.findings, ...shape];
  const unadopted = unadoptedVoiceClaims(store);
  const terms = unadoptedTerms(store);
  const absent = absentCharacters(store);

  const report = renderAuditReport({
    title,
    file,
    volume: store.volume,
    findings,
    counts: audit.counts,
    checked: audit.checked,
    coverageAsked: audit.coverageAsked,
    unadopted,
    unadoptedTerms: terms,
    absent,
    presence,
    refused,
  });

  return {
    findings,
    highFindings: findings.filter((f) => f.severity === "HIGH"),
    markdown: report,
    counts: audit.counts,
    checked: audit.checked,
    coverageAsked: audit.coverageAsked,
    presence,
    unadopted,
    unadoptedTerms: terms,
    absent,
  };
}

/**
 * Seal this volume's record: the last act of its pre-production (review 05 §3.2 — code seals, at
 * the end of the volume's own pre-production, not a role and not a model).
 *
 * @param {ReferenceStore} store
 * @returns {{ok: boolean, volume: number, sealedRows: number, snapshot: number, alreadySealed: boolean}}
 */
function sealVolumeRecord(store) {
  return store.sealVolume(store.volume);
}

module.exports = {
  volumeRecordExists,
  openVolumeRecord,
  importVolumeExtraction,
  importVolumeArtifacts,
  resetDocumentMirror,
  measureVolumePresence,
  auditVolumeRecord,
  sealVolumeRecord,
};

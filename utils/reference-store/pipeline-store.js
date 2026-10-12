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
 * Two rules are asked at the open, not inside a stage, because a stage can be skipped and an open cannot:
 *
 *   - **the glossary completeness rule** — a volume with a published `glossary.md` and no glossary rows
 *     in its record is an incomplete record (gotcha 103);
 *   - **the roster rule** — an entry whose own heading names another entry on the roster is folded into
 *     it, in the record that is *inheriting* the split, never in the sealed record that published it.
 *     Volume 01's entry keyed `俺` with the heading `俺（如月雨露・第二章終盤）` is the case: volume 01's
 *     record is published and stays exactly as it is, and volume 02's copy is where the split gets folded
 *     before it becomes sixteen volumes' worth of split.
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
const path = require("path");

const { openReferenceStore } = require("./open");
const { referenceStorePath } = require("./paths");
const { copyForwardStore, topUpVolumeRecord } = require("./copy-forward");
const { volumeRecordIsStale, readReopenHistory } = require("./reopen");
const { pronounKeyedRosterEntries } = require("./integrity");
const { DOCUMENT_SOURCE_STAGE } = require("./schema");
const { importGlossary } = require("./glossary-adapter");
const { importVoice } = require("./voice-adapter");
const { importVoiceExtraction, importNewTerms } = require("./extraction-adapter");
const { markGlossaryBackfilled, glossaryBackfilled, markRosterReconciled, rosterReconciled } = require("./document-prose");
const { rosterIdentityConflicts } = require("./name-resolution");
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
 * How many glossary rows this volume's own record holds.
 *
 * `aspect = 'term_usage'` is the store's existing way to say "this row is glossary content" — it is the
 * same clause `resetDocumentMirror` uses to tell the two documents in one record apart.
 *
 * @param {{db: Object}} ctx
 * @param {number|string} volume
 * @returns {number}
 */
function glossaryRowsInRecord(ctx, volume) {
  return ctx.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE owner_volume = ? AND aspect = 'term_usage'")
    .get(Number(volume)).n;
}

/**
 * What this volume's record holds of the glossary, and how it got there.
 *
 * The audit prints this so that a volume which contributed nothing is a number on the page rather
 * than an absence somebody has to notice by reading the absence.
 *
 * @param {{db: Object}} ctx
 * @param {number|string} volume
 * @returns {{rows: number, backfill: Object|null}}
 */
function glossaryContribution(ctx, volume) {
  return { rows: glossaryRowsInRecord(ctx, volume), backfill: glossaryBackfilled(ctx, volume) };
}

/**
 * The completeness rule: a volume's published glossary has to be in that volume's record.
 *
 * Why this is a rule on the record and not a stage behaviour. The glossary stage finished for all 17
 * volumes in a run that predates the store, and its idempotence check skips a volume whose accepted
 * `glossary.md` is already on disk — a check that runs **before** the stage's store block. So with the
 * flags switched on mid-series, volumes 02–17 skip the stage, never reach the import, and the record
 * stays frozen at volume 1's 86 rows for the whole series: the roster the coverage guard asks about
 * would be volume 1's cast plus whatever the voice extraction happens to introduce, and every later
 * volume inherits that hole. A rule that only fires when somebody remembers to add the stage to a
 * command line is the same hole with better documentation.
 *
 * So the rule is asked where every stage already goes — when the record is opened for writing — and it
 * fires whether the stage ran, skipped, or was never invoked.
 *
 * Three things it will not do:
 *   - **It never overwrites.** If the record already holds glossary rows of its own it reports them and
 *     touches nothing (gotcha 97: carrying into a record does not erase it).
 *   - **The evidence rule still applies at the door.** `importGlossary` refuses a term whose rendering
 *     cites no line of this volume's text, and every refusal comes back named, because a glossary the
 *     record cannot vouch for is information rather than an error to swallow.
 *   - **It is not a substitute for the stage.** It imports the published document; it does not build one
 *     and it does not claim the document was authored in this run. `markGlossaryBackfilled` records that
 *     it happened here and the audit report prints it.
 *
 * @param {ReferenceStore} store - Opened with a document-scoped handle, which is what `import` rows need.
 * @param {{volume?: number|string}} [opts]
 * @returns {{ran: boolean, held: number, imported: number, carried: number, refused: Array<Object>, castRegistered: number, artifact: string|null, because: string}}
 */
function ensureVolumeGlossaryInRecord(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const held = glossaryRowsInRecord(store, vol);
  if (held > 0) {
    return {
      ran: false,
      held,
      imported: 0,
      carried: 0,
      refused: [],
      castRegistered: 0,
      artifact: null,
      because: `this volume's record already holds ${held} glossary row(s), so nothing was imported`,
    };
  }

  const artifact = path.join(store.volumeDir, "glossary.md");
  let markdown = null;
  try {
    markdown = fs.readFileSync(artifact, "utf8");
  } catch {
    markdown = null;
  }
  if (markdown === null) {
    return {
      ran: false,
      held: 0,
      imported: 0,
      carried: 0,
      refused: [],
      castRegistered: 0,
      artifact: null,
      because: `this volume has no published glossary.md to import, and its record holds none`,
    };
  }

  const result = importGlossary(store, markdown);
  markGlossaryBackfilled(store, vol, {
    imported: result.imported.length,
    carried: result.carried.length,
    refused: result.refused.length,
    artifact: path.basename(artifact),
  });

  return {
    ran: true,
    held,
    imported: result.imported.length,
    carried: result.carried.length,
    refused: result.refused,
    castRegistered: result.castRegistered,
    artifact,
    because: `this volume's record held no glossary rows, so its published glossary.md was read into it (${result.imported.length} row(s))`,
  };
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
 * @returns {{ok: boolean, store: ReferenceStore|null, carried: Object|null, toppedUp: Object|null, glossaryBackfill: Object|null, roster: Object|null, refusal: ReferenceRefusal|null, findings: PostMortemFinding[]}}
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
      /**
       * The staleness guard, asked before anything is carried or topped up.
       *
       * This volume's record exists, which for every volume after the first means it was made by copying
       * an earlier volume's record at a moment in time. If that volume has since been reopened — its
       * published record thrown away and redone — this file is a copy of a record that no longer describes
       * the book, and the door that would otherwise run here (`topUpVolumeRecord`) only ever ADDS rows.
       * Topping up a stale record would pour the new volume 1's claims into a file that still holds the old
       * volume 1's claims and report success. So a stale record is refused, and the fix it names is the act
       * that made it stale.
       */
      const stale = volumeRecordIsStale({ seriesDir, volume, folder });
      if (stale.stale) {
        return {
          ok: false,
          store: null,
          carried: null,
          toppedUp: null,
          refusal: {
            verb: "open_volume_record",
            rule: "record-copy-is-stale",
            because:
              `volume ${volume}'s record was copied from volume ${stale.sourceVolume} at ${stale.copiedAt || "an unrecorded time"}, ` +
              `and volume ${stale.sourceVolume} was reopened at ${stale.reopenedAt} for the reason ` +
              `"${stale.reason}". This record is therefore a copy of a record that no longer describes the book, and it ` +
              "still holds the claims the redo threw away.",
            useInstead: [
              `reopenVolumeRecord({ volume: ${stale.sourceVolume}, reason, cascade: "retire" }) — retires this record with the same reason recorded`,
              `then run volume ${volume} normally: its record is rebuilt from the beginning, copied forward from volume ${stale.sourceVolume}'s new one`,
            ],
            fix: "retire this volume's record and re-derive it. A top-up is not a fix here: it adds rows and never removes one.",
          },
          findings: [],
        };
      }

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

  /**
   * The completeness rule, asked here because this is the one place every stage that writes to a
   * volume's record has to come through. A volume with a published glossary and no glossary rows in its
   * record is an incomplete record, and the stage that would have noticed is the one that skipped.
   */
  const glossaryBackfill = ensureVolumeGlossaryInRecord(store, { volume: store.volume });

  /**
   * The roster rule, asked at the same door for the same reason: a record's roster is not only this
   * volume's business, because the next volume inherits it. A split the earlier volume froze is carried
   * forward by every copy after it, and the only moment it can be folded without rewriting a published
   * record is the moment a new record is created from that published one.
   */
  const roster = reconcileInheritedRoster(store);

  return { ok: true, store, carried, toppedUp, glossaryBackfill, roster, refusal: null, findings: [] };
}

/**
 * Fold roster entries that their own headings say are the same person.
 *
 * Volume 01 left an entry keyed `俺` with the heading `俺（如月雨露・第二章終盤）` and 14 of the
 * protagonist's claims under it. Volume 01's record is published and sealed, so it stays exactly as it
 * is — that record is the one a translation was already built on. Volume 02's record is a copy of it,
 * and a copy is where the split can be folded: nothing has been built from volume 02's record yet, and
 * leaving the split in place is what would carry it into all sixteen volumes after that.
 *
 * The rule is `name-resolution.js`'s `rosterIdentityConflicts`, and it is as narrow as it is because a
 * merge is the one operation in this layer that can make a character's claims vanish from a query: a
 * bracketed span of the entry's own heading has to contain another entry's **key** as a whole token.
 * `女（図書委員）` names nothing and stays. `俺（如月雨露の友人）` names nothing either — a heading that
 * mentions a character in prose is a translation decision, and `castAlias` is the door for a decision.
 *
 * An entry whose heading names **two** roster entries is reported and never merged. Picking between two
 * candidates is a decision, and a rule that makes a decision in silence is the bug this module's header
 * was written about.
 *
 * @param {ReferenceStore} store - Opened for the volume whose roster is being reconciled.
 * @returns {{ran: boolean, conflicts: number, merged: Array<{merged: string, survivor: string, heading: string, movedFacts: number}>, ambiguous: Array<{merged: string, heading: string, names: string[]}>, refused: Array<{merged: string, survivor: string, because: string}>}}
 */
function reconcileInheritedRoster(store) {
  const conflicts = rosterIdentityConflicts(store);
  if (conflicts.length === 0) {
    const empty = { ran: false, conflicts: 0, merged: [], ambiguous: [], refused: [] };
    markRosterReconciled(store, store.volume, empty);
    return empty;
  }

  /** @type {Array<{merged: string, survivor: string, heading: string, movedFacts: number}>} */
  const merged = [];
  /** @type {Array<{merged: string, heading: string, names: string[]}>} */
  const ambiguous = [];
  /** @type {Array<{merged: string, survivor: string, because: string}>} */
  const refused = [];

  for (const conflict of conflicts) {
    if (conflict.ambiguous) {
      // One report per entry, not per candidate it names: `rosterIdentityConflicts` returns a row per
      // pair, and a run that printed the same problem twice reads as two problems.
      if (!ambiguous.some((row) => row.merged === conflict.merged)) {
        ambiguous.push({
          merged: conflict.merged,
          heading: conflict.heading,
          names: conflicts.filter((other) => other.merged === conflict.merged).map((other) => other.survivor),
        });
      }
      continue;
    }
    const result = store.mergeInheritedCastEntry({
      survivor: conflict.survivor,
      merged: conflict.merged,
      volume: store.volume,
      reason:
        `its own heading "${conflict.heading}" names ${conflict.survivor} as a whole word inside the label ` +
        `this entry was given — the pass that wrote it put the real name in the bracket. Volume ${store.volume}'s ` +
        `record inherited the split from the volume before it, and the entry it was split from is sealed there.`,
    });
    if (!result.ok) {
      refused.push({ merged: conflict.merged, survivor: conflict.survivor, because: result.refusal.because });
      continue;
    }
    if (result.alreadyMerged) continue;
    merged.push({ merged: conflict.merged, survivor: conflict.survivor, heading: conflict.heading, movedFacts: result.movedFacts });
  }

  const result = { ran: true, conflicts: conflicts.length, merged, ambiguous, refused };
  markRosterReconciled(store, store.volume, result);
  return result;
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
 * @returns {{ok: boolean, measured: number, present: number, absent: number, chapters: number, matchRows: number, refusal: ReferenceRefusal|null}}
 */
function measureVolumePresence(store) {
  const result = store.recordCastPresence();
  if (!result.ok) return { ok: false, measured: 0, present: 0, absent: 0, merged: 0, chapters: 0, matchRows: 0, refusal: result.refusal };
  return { ok: true, measured: result.measured, present: result.present, absent: result.absent, merged: result.merged, chapters: result.chapters, matchRows: result.matchRows, refusal: null };
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
 * Render the report for an audit that has already been computed.
 *
 * Split out because the rebuild has to render its report **after** it seals, and it cannot seal
 * before it has published the reference and published only after the audit said whether the reference
 * is damaged. Re-running the audit to add one line to the report would re-check every citation in the
 * volume a second time, which on volume 01 is 514 source reads for a sentence.
 *
 * @param {Object} audit - What `auditVolumeRecord` returned.
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.file
 * @param {number|string} opts.volume
 * @param {Array<Object>} [opts.refused]
 * @param {Array<Object>} [opts.screened] - Claims adopted with an offered quotation dropped; see `renderAuditReport`.
 * @param {Object|null} [opts.sealed] - The sealing answer, for `renderAuditReport`.
 * @param {string} [opts.document] - Which document's rebuild provenance to show.
 * @returns {string}
 */
function renderVolumeAuditReport(audit, { title, file, volume, refused = [], screened = [], sealed = null, document = "character-voice" }) {
  return renderAuditReport({
    title,
    file,
    volume,
    findings: audit.findings,
    counts: audit.counts,
    checked: audit.checked,
    coverageAsked: audit.coverageAsked,
    coverage: audit.coverage,
    unadopted: audit.unadopted,
    unadoptedTerms: audit.unadoptedTerms,
    absent: audit.absent,
    presence: audit.presence,
    glossary: audit.glossary || null,
    roster: audit.roster || null,
    refused,
    screened: screened.length ? screened : audit.screened || [],
    reopens: audit.reopens || [],
    rebuilt: (audit.rebuilt || []).find((entry) => entry.document === document && entry.volume === Number(volume)) || null,
    sealed,
  });
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
 * @returns {{findings: PostMortemFinding[], highFindings: PostMortemFinding[], markdown: string, counts: Object<string, number>, checked: number, coverageAsked: boolean, coverage: Object, presence: Object, unadopted: Array<Object>, unadoptedTerms: Array<Object>, absent: Array<Object>}}
 */
function auditVolumeRecord(store, { title, file, markdown, refused = [], screened = [], step = VALIDATION_STEP }) {
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
  const glossary = glossaryContribution(store, store.volume);
  const roster = rosterReconciled(store, store.volume);
  // The fold's answer and the split the fold could not see, side by side: "no entry's heading names
  // another" is a true answer to the narrow question and a misleading one on its own.
  if (roster) roster.pronounEntries = pronounKeyedRosterEntries(store);
  // Read out of the record itself, so a redo is visible to whoever opens the audit report months later
  // even if the run that did it is long gone and its console output with it.
  // Every reopen row, not just this volume's: the copy-forward carries its source's reopen history in,
  // and the report has to say which of these rows are this volume's act and which are the foundation it
  // was rebuilt on. Filtering here is what left volume 02's report silent about its own record being a redo.
  const reopens = readReopenHistory(store);

  const computed = {
    findings,
    counts: audit.counts,
    checked: audit.checked,
    coverageAsked: audit.coverageAsked,
    coverage: audit.coverage,
    unadopted,
    unadoptedTerms: terms,
    absent,
    presence,
    glossary,
    roster,
    reopens,
    rebuilt: audit.rebuilt || [],
  };

  const report = renderVolumeAuditReport(computed, { title, file, volume: store.volume, refused, screened, reopens });

  return {
    findings,
    highFindings: findings.filter((f) => f.severity === "HIGH"),
    markdown: report,
    counts: audit.counts,
    checked: audit.checked,
    coverageAsked: audit.coverageAsked,
    coverage: audit.coverage,
    presence,
    unadopted,
    unadoptedTerms: terms,
    absent,
    glossary,
    roster,
    reopens,
    rebuilt: audit.rebuilt || [],
  };
}

/**
 * The stage-facing sentence about what the roster rule did, so the two stages that open a record say
 * the same thing about it.
 *
 * A merge moves a character's claims, and a stage log is the only place a run notices a merge at all:
 * the audit report is written per artifact, and by the time it exists the merge has already happened.
 *
 * @param {number|string} volume
 * @param {{ran: boolean, conflicts: number, merged: Array<{merged: string, survivor: string, heading: string, movedFacts: number}>, ambiguous: Array<{merged: string, heading: string, names: string[]}>, refused: Array<{merged: string, survivor: string, because: string}>}|null} roster
 * @returns {string[]} Lines to log. Empty when there is nothing to say.
 */
function rosterReconciliationLog(volume, roster) {
  if (!roster) return [];
  const out = [];
  for (const m of roster.merged || []) {
    out.push(
      `Volume ${volume}: roster entry "${m.merged}" is the same person as ${m.survivor} — its own heading ` +
        `"${m.heading}" names that name as a whole word. ${m.movedFacts} claim(s) moved onto ${m.survivor}, ` +
        `and the merge is recorded in cast_merges.`
    );
  }
  for (const a of roster.ambiguous || []) {
    out.push(
      `Volume ${volume}: roster entry "${a.merged}" names ${a.names.length} entries in its heading ` +
        `(${a.names.join(", ")}) and was NOT merged — choosing between them is a decision, and this rule ` +
        `only makes the ones the artifact already made.`
    );
  }
  for (const r of roster.refused || []) {
    out.push(`Volume ${volume}: merging "${r.merged}" into ${r.survivor} was refused — ${r.because}`);
  }
  return out;
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
  glossaryRowsInRecord,
  glossaryContribution,
  ensureVolumeGlossaryInRecord,
  reconcileInheritedRoster,
  rosterReconciliationLog,
  importVolumeExtraction,
  importVolumeArtifacts,
  resetDocumentMirror,
  measureVolumePresence,
  auditVolumeRecord,
  renderVolumeAuditReport,
  sealVolumeRecord,
};

/**
 * utils/reference-store/open.js — open one volume's reference store.
 *
 * This is where the two things the guards depend on get decided, and neither of them is
 * decided by the caller of a write:
 *
 *   - **the file**, resolved at call time from `SERIES_LOCATION` plus the volume
 *     (`paths.js`; gotchas 79 and 94). Opening volume 05's store and getting volume 01's
 *     file would not be a filename bug, it would be the spoiler guard off;
 *   - **the write scope** — `{volume, stage}` — which is stamped into every row this handle
 *     writes and is the only thing the ownership guard reads. It is frozen here, exactly
 *     once, and no later call can change it. That is the same shape the file sandbox uses:
 *     the volume folder is fixed by the caller at launch and every mutation passes through
 *     one predicate (`ai/tools-fs.js`). Slice 7 will build it as
 *     `createReferenceTools({volume: 3, stage: "extract"})`; the store already takes it.
 *
 * @module utils/reference-store/open
 */

const fs = require("fs");
const path = require("path");

const { openDatabase } = require("./db");
const { applySchema, readSchemaVersion, SCHEMA_VERSION, COUNTED_TABLES } = require("./schema");
const {
  referenceStorePath,
  referenceStoreVolumeFolder,
  referenceStoreSeriesDir,
  readPlanOfRecord,
  installmentKey,
} = require("./paths");
const { listVolumeChapters } = require("./source-chapters");
const facts = require("./facts");
const cast = require("./cast");
const queries = require("./queries");
const integrity = require("./integrity");
const documentProse = require("./document-prose");
const presence = require("./presence");
const identity = require("./identity");
const attribution = require("./attribution");
const { storeError } = require("./refusals");
require("../../types"); // JSDoc type definitions

/**
 * Open (creating when needed) one volume's reference database.
 *
 * @param {Object} opts
 * @param {number|string} [opts.volume] - The installment this store is writing FOR.
 * @param {string} [opts.folder] - The volume folder name, when the caller already knows it.
 * @param {string} [opts.seriesDir] - Series folder. Defaults to SERIES_LOCATION (call time).
 * @param {string} [opts.stage] - Which stage of the volume's pre-production is writing.
 *   Defaults to "merge" — the code-side merge, which is what writes in slices 2–5.
 * @param {boolean} [opts.create] - Create the file when it is absent. Default true.
 * @returns {ReferenceStore}
 */
function openReferenceStore({ volume, folder, seriesDir, stage = "merge", create = true } = {}) {
  const resolved = referenceStorePath({ seriesDir, volume, folder });
  if (!create && !fs.existsSync(resolved.file)) {
    throw storeError(`no reference store at ${resolved.file} (create: false was asked for).`);
  }

  const db = openDatabase(resolved.file);
  const schema = applySchema(db);

  const volNumber = Number.parseInt(installmentKey(volume) || "0", 10);
  if (!Number.isInteger(volNumber) || volNumber < 1) {
    db.close();
    throw storeError(`cannot open ${resolved.file}: the volume number "${volume}" is not usable.`);
  }

  /** @type {ReferenceStoreScope} */
  const scope = Object.freeze({ volume: volNumber, stage: String(stage) });

  /** @type {ReferenceStore} */
  const ctx = {
    file: resolved.file,
    seriesDir: resolved.seriesDir,
    volumeDir: resolved.volumeDir,
    folder: resolved.folder,
    volume: volNumber,
    scope,
    schemaVersion: schema.version,
    created: schema.created,
    db,
    close: () => db.close(),
  };

  // The volume row is what makes "which folder was volume 07's record in" answerable from
  // inside the file, years later (doc 03 §2.2).
  db
    .prepare("INSERT INTO volumes (volume, folder, title) VALUES (?,?,?) ON CONFLICT(volume) DO UPDATE SET folder = excluded.folder")
    .run(volNumber, resolved.folder, null);

  /**
   * Resolve a volume number to the folder and chapter list its evidence cites.
   *
   * A fact may cite an EARLIER volume (that is the late-discovery case the design protects),
   * so the store has to be able to find that volume's folder. It looks in its own file
   * first, then the plan of record. It never looks in a later volume's folder, and it says
   * so when a citation asks for one it cannot reach.
   *
   * @param {number} citedVolume
   * @returns {{volumeDir: string|null, chapters: Array<{id: string, file: string}>, error: string|null}}
   */
  ctx.resolveVolume = function resolveVolume(citedVolume) {
    const target = Number(citedVolume);
    if (!Number.isInteger(target) || target < 1) {
      return { volumeDir: null, chapters: [], error: `"${citedVolume}" is not a volume number` };
    }
    // Which folder this volume's text is in: the store's own record first (it is the record
    // copy-forward wrote), then the plan of record.
    let folderName = null;
    const row = db.prepare("SELECT folder FROM volumes WHERE volume = ?").get(target);
    if (row) folderName = row.folder;
    if (!folderName) {
      const plan = ctx.readPlan();
      const entry = plan.find((v) => installmentKey(v && v.installmentNumber) === installmentKey(target));
      if (entry && entry.folder) folderName = entry.folder;
    }
    if (!folderName) {
      return {
        volumeDir: null,
        chapters: [],
        error:
          `volume ${target}'s folder is not recorded in this store and is not in the plan of record ` +
          `(${path.join(ctx.seriesDir, "translation-target.json")}).`,
      };
    }
    const dir = target === ctx.volume ? ctx.volumeDir : path.join(ctx.seriesDir, folderName);

    // The chapters this store already knows about, which includes an earlier volume's chapters that
    // arrived inside the copy this store was built from. Preferring them matters: a plain-text volume
    // never produces a bundle file, so re-deriving its chapters from the folder fails, and every
    // carried citation in the next volume's record would then report as unverifiable.
    const registered = db
      .prepare("SELECT chapter_id, file FROM chapters WHERE volume = ? AND file IS NOT NULL ORDER BY ord, chapter_id")
      .all(target);
    if (registered.length > 0) {
      return { volumeDir: dir, chapters: registered.map((r) => ({ id: r.chapter_id, file: r.file })), error: null };
    }

    const listed = listVolumeChapters(dir);
    if (listed.error) return { volumeDir: null, chapters: [], error: listed.error };
    return { volumeDir: dir, chapters: listed.chapters, error: null };
  };

  /**
   * The plan of record's volume list, read fresh (see paths.js).
   * @returns {Array<Object>}
   */
  ctx.readPlan = function readPlan() {
    return readPlanOfRecord(ctx.seriesDir) || [];
  };

  // ─── The repository API ─────────────────────────────────────────────────────
  ctx.registerVolume = (entry) => {
    db.prepare(
      "INSERT INTO volumes (volume, folder, title) VALUES (?,?,?) " +
        "ON CONFLICT(volume) DO UPDATE SET folder = excluded.folder, title = excluded.title"
    ).run(Number(entry.volume), String(entry.folder), entry.title === undefined ? null : entry.title);
    return db.prepare("SELECT * FROM volumes WHERE volume = ?").get(Number(entry.volume));
  };

  ctx.volumes = () => db.prepare("SELECT * FROM volumes ORDER BY volume").all();

  ctx.registerChapter = (entry) => {
    const vol = Number(entry.volume === undefined ? ctx.volume : entry.volume);
    const ord = Number(entry.ord === undefined ? 0 : entry.ord);
    db.prepare(
      "INSERT INTO chapters (volume, chapter_id, ord, file, char_count, source_fingerprint, title) VALUES (?,?,?,?,?,?,?) " +
        "ON CONFLICT(volume, chapter_id) DO UPDATE SET ord = excluded.ord, file = excluded.file, " +
        "char_count = excluded.char_count, source_fingerprint = excluded.source_fingerprint, " +
        "title = COALESCE(excluded.title, chapters.title)"
    ).run(vol, String(entry.chapterId), ord, entry.file === undefined ? null : String(entry.file),
      entry.charCount === undefined ? null : Number(entry.charCount),
      entry.sourceFingerprint === undefined ? null : String(entry.sourceFingerprint),
      entry.title === undefined || entry.title === null || entry.title === "" ? null : String(entry.title));
    return db.prepare("SELECT * FROM chapters WHERE volume = ? AND chapter_id = ?").get(vol, String(entry.chapterId));
  };

  ctx.chapters = (vol) =>
    db
      .prepare("SELECT * FROM chapters WHERE volume = ? ORDER BY ord, chapter_id")
      .all(Number(vol === undefined ? ctx.volume : vol));

  /**
   * Register this volume's chapters from its own extracted source.
   *
   * `segments` is what the stage already resolved (`utils/source.js`'s bundle). Passing it matters:
   * a plain-text source is used as it is, with no `*-whole.md` and no bundle metadata file, so
   * `listVolumeChapters` — which reads the folder — finds nothing, and a store that cannot name the
   * volume's chapters cannot cite a line in it. The bundle is the same source the stage is reading,
   * so the store cites the files the stage actually used.
   *
   * @param {Array<{id: string, file: string, chars?: number}>} [segments]
   * @returns {{ok: boolean, chapters: number, error: string|null}}
   */
  ctx.registerChaptersFromSource = (segments) => {
    const listed =
      Array.isArray(segments) && segments.length > 0
        ? {
            chapters: segments.map((segment) => ({
              id: String(segment.id),
              file: String(segment.file),
              title: segment.title ? String(segment.title) : null,
              chars: Number.isFinite(segment.chars) ? segment.chars : null,
            })),
            error: null,
          }
        : listVolumeChapters(ctx.volumeDir);
    if (listed.error) return { ok: false, chapters: 0, error: listed.error };
    listed.chapters.forEach((chapter, index) => {
      ctx.registerChapter({
        volume: ctx.volume,
        chapterId: chapter.id,
        ord: index,
        file: chapter.file,
        charCount: chapter.chars === null ? null : chapter.chars,
        title: chapter.title === null ? null : chapter.title,
      });
    });
    return { ok: true, chapters: listed.chapters.length, error: null };
  };

  /**
   * This volume's chapters, preferring what the store registered.
   *
   * Every evidence search in this layer starts here, so it has to answer for the source the stage
   * actually read — including a plain-text volume that never produced a bundle file on disk.
   *
   * @returns {{chapters: Array<{id: string, file: string, title: string|null}>, error: string|null}}
   */
  ctx.listChapters = () => {
    const rows = ctx.db
      .prepare("SELECT chapter_id, file, title FROM chapters WHERE volume = ? AND file IS NOT NULL ORDER BY ord, chapter_id")
      .all(ctx.volume);
    if (rows.length > 0) {
      return {
        chapters: rows.map((row) => ({ id: row.chapter_id, file: row.file, title: row.title === null ? null : row.title })),
        error: null,
      };
    }
    const listed = listVolumeChapters(ctx.volumeDir);
    return { chapters: listed.chapters, error: listed.error };
  };

  ctx.getCast = (key) => cast.getCast(ctx, key);
  ctx.listCast = (vol) => cast.listCast(ctx, vol);
  ctx.upsertCast = (entry) => cast.upsertCast(ctx, entry);
  ctx.castAlias = (key, alias, reason) => cast.castAlias(ctx, key, alias, reason);
  ctx.mergeInheritedCastEntry = (opts) => cast.mergeInheritedCastEntry(ctx, opts);
  ctx.castMerges = () => cast.castMerges(ctx);
  ctx.factCharacters = (id) => cast.factCharacters(ctx, id);

  ctx.getFact = (id) => facts.getFact(ctx, id);
  ctx.allFacts = () => facts.allFacts(ctx);
  ctx.insertFact = (proposal) => facts.insertFact(ctx, proposal);
  ctx.updateOwnFact = (id, patch) => facts.updateOwnFact(ctx, id, patch);
  ctx.deleteOwnFact = (id, reason) => facts.deleteOwnFact(ctx, id, reason);
  ctx.challengeFact = (id, proposal) => facts.challengeFact(ctx, id, proposal);
  ctx.listChallenges = (opts) => facts.listChallenges(ctx, opts);
  ctx.resolveChallenge = (id, outcome) => facts.resolveChallenge(ctx, id, outcome);
  ctx.sealVolume = (vol, opts) => facts.sealVolume(ctx, vol, opts);
  ctx.isVolumeSealed = (vol) => facts.isVolumeSealed(ctx, vol);
  ctx.factsAtVolume = (vol) => facts.factsAtVolume(ctx, vol);

  ctx.documentProse = (document) => documentProse.readDocumentProse(ctx, document);

  ctx.recordCastPresence = (opts) => presence.recordCastPresence(ctx, opts);
  ctx.castPresence = (vol) => presence.castPresence(ctx, vol);
  ctx.presenceDetail = (vol, key) => presence.presenceDetail(ctx, vol, key);
  ctx.presenceMeasured = (vol) => presence.presenceMeasured(ctx, vol);

  // The identity tables (plan 06 slice 1b). Reachable from the store, and from NOTHING that files a
  // claim: `castAlias`, `mergeInheritedCastEntry`, `resolveExtractionName` and `recordCastPresence` do
  // not require this module and never will — filing a link must not be able to change who a claim lands
  // under, which is the guarantee `test/test-identity-table-isolation.js` pins.
  ctx.fileIdentityLinks = (opts) => identity.fileIdentityLinks(ctx, opts);
  ctx.withdrawIdentityLink = (linkId, reason) => identity.withdrawIdentityLink(ctx, linkId, reason);
  ctx.castIdentities = (opts) => identity.castIdentities(ctx, opts);
  ctx.castIdentityLinks = (opts) => identity.castIdentityLinks(ctx, opts);
  ctx.castIdentityMembers = (id) => identity.castIdentityMembers(ctx, id);
  ctx.identityOfCastKey = (key) => identity.identityOfCastKey(ctx, key);
  ctx.unlinkedCastKeys = () => identity.unlinkedCastKeys(ctx);
  ctx.identityCoverageSummary = () => identity.identityCoverageSummary(ctx);

  ctx.attributionDoubts = (opts) => attribution.attributionDoubts(ctx, opts);
  ctx.attributionSummary = (opts) => attribution.attributionSummary(ctx, opts);
  ctx.attributionFindings = (opts) => attribution.attributionFindings(ctx, opts);
  ctx.namePrintedWithReadingAids = (opts) => attribution.namePrintedWithReadingAids(ctx, opts);
  ctx.speakerPassage = (opts) => attribution.speakerPassage(ctx, opts);
  ctx.attributionAnswers = (upTo) => attribution.attributionAnswers(ctx, upTo);
  ctx.recordAttributionAnswer = (proposal) => attribution.recordAttributionAnswer(ctx, proposal);

  ctx.factsFor = (query) => queries.factsFor(ctx, query);
  ctx.factsForChapter = (query) => queries.factsForChapter(ctx, query);
  ctx.factHistory = (query) => queries.factHistory(ctx, query);
  ctx.searchFacts = (query) => queries.searchFacts(ctx, query);
  ctx.showableFacts = (vol, opts) => queries.showableFacts(ctx, vol, opts);
  ctx.tableCounts = () => queries.tableCounts(ctx, COUNTED_TABLES);

  ctx.integrityFindings = (opts) => integrity.integrityFindings(ctx, opts);

  return ctx;
}

/**
 * `path.join` without making this module depend on a second require for it.
 * (Kept as a function so the error strings read the same everywhere.)
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function path_join(a, b) {
  return require("path").join(a, b);
}

module.exports = { openReferenceStore, SCHEMA_VERSION, readSchemaVersion, referenceStoreSeriesDir, referenceStoreVolumeFolder };

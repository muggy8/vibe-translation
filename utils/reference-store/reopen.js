/**
 * utils/reference-store/reopen.js — redoing a volume whose record is already published, as a
 * deliberate and recorded act.
 *
 * ## The problem this is the door for
 *
 * A sealed volume is a volume some later volume was built on: volume 2's record is a copy of volume
 * 1's, made at a moment and stamped with the hash of the file it was copied from. So "run volume 1
 * again" is not a local edit — it invalidates every copy made from it. And the guards that keep a
 * published record from being rewritten (`rebuild-refuses-a-sealed-voice-record`, the sealed-volume
 * refusals in `extract-voice.js` and `rebuild-voice.js`) are correct guards, which is exactly why
 * nothing can redo a volume without a door that is not a flag switched on in front of them.
 *
 * ## What the act is
 *
 * **Retire the record and re-derive it.** The volume's `series.db` is moved aside whole — every sealed
 * row in it stays sealed, in a file that is still readable — and the next time the volume is opened its
 * record is built from the beginning: copied forward from the volume before it, topped up with its own
 * published glossary, and re-read from its own chapters. Nothing is unsealed, no sealed row is edited,
 * and no guard is loosened. The guard still refuses a sealed record; what changed is the state it is
 * being asked about, by an act that records who did it and why.
 *
 * That is the difference between this and a `--no-seal` flag, which would be the same effect with the
 * guard switched off. The guard stays.
 *
 * ## The cascade, said out loud
 *
 * `copy_provenance` already records, for every volume after the first, which volume its record was
 * copied from, when, and the hash of the file at that moment. A reopen writes a row into
 * `record_reopens`. The staleness question is therefore answerable from the two tables together:
 *
 *     a copy is stale when its source volume was reopened AFTER the copy was made
 *
 * and `openVolumeRecord` asks it before it carries or tops up anything. A stale record is refused, not
 * quietly topped up — and topping up is the real danger, because `topUpVolumeRecord` only ever *adds*
 * rows. A top-up of a stale record would pour the new volume 1's claims into a file that still holds the
 * old volume 1's claims and report success. That is how a redo ends up with two volumes' worth of claims
 * about the same book and a log line saying everything was fine.
 *
 * So reopening a volume that has derived records refuses unless the caller says what happens to them,
 * and the only thing it does with them is retire those too, with the same reason recorded.
 *
 * @module utils/reference-store/reopen
 */

const fs = require("fs");
const path = require("path");

require("../../types"); // JSDoc type definitions

const { openDatabase } = require("./db");
const { referenceStorePath, readPlanOfRecord, REFERENCE_STORE_FILE_NAME } = require("./paths");
const { refusal } = require("./refusals");
const { applySchema } = require("./schema");

/**
 * How much of a reason counts as a reason.
 *
 * "redo" is not a reason; it is the act restated. The row this writes is read by whoever opens this
 * record a year from now, and the question they are asking is *why was this volume's published record
 * thrown away*. A floor on length is a crude test, and it is the only test that can be applied without
 * asking a model.
 */
const MIN_REOPEN_REASON_CHARS = 20;

/** The prefix a retired record file is moved to. Compact UTC: these folders live on Windows too. */
const RETIRED_PREFIX = `${REFERENCE_STORE_FILE_NAME}.retired-`;

/**
 * A compact UTC stamp usable in a file name — no colons, which a Windows folder cannot have.
 *
 * @param {Date} [when]
 * @returns {string} e.g. `20261012T014155`
 */
function stamp(when = new Date()) {
  return when.toISOString().replace(/[-:]/g, "").slice(0, 15);
}

/**
 * Read a record's reopen history out of itself.
 *
 * @param {{db: Object}|Object} ctx - An open database handle, or a store handle that carries one.
 * @param {number} [volume] - Whose reopen rows to return. Defaults to every volume this file knows about.
 * @returns {Array<{volume: number, reopened_at: string, reason: string, was_sealed: boolean, sealed_at: string|null, rows_at_reopen: Object<string, number>, copies_affected: number[]}>}
 */
function readReopenHistory(ctx, volume) {
  const handle = ctx && ctx.prepare ? ctx : ctx.db;
  /** @type {Array<Object>} */
  let rows = [];
  try {
    rows = handle.prepare("SELECT * FROM record_reopens ORDER BY reopened_at").all();
  } catch {
    return [];
  }
  return rows
    .filter((row) => volume === undefined || Number(row.volume) === Number(volume))
    .map((row) => {
      /** @type {Object<string, number>} */
      let counts = {};
      /** @type {number[]} */
      let copies = [];
      try { counts = JSON.parse(row.rows_at_reopen || "{}"); } catch { counts = {}; }
      try { copies = JSON.parse(row.copies_affected || "[]").map(Number); } catch { copies = []; }
      return {
        volume: Number(row.volume),
        reopened_at: row.reopened_at,
        reason: row.reason,
        was_sealed: Number(row.was_sealed) === 1,
        sealed_at: row.sealed_at === null ? null : row.sealed_at,
        rows_at_reopen: counts,
        copies_affected: copies,
      };
    });
}

/**
 * What a record holds at the moment it is retired, so the reopen row can say what was thrown away
 * rather than only that something was.
 *
 * @param {{db: Object}|Object} db - An open database handle, or a store handle that carries one.
 * @returns {Object<string, number>}
 */
function recordRowCounts(db) {
  const handle = db && db.prepare ? db : db.db;
  /** @type {Object<string, number>} */
  const counts = {};
  for (const table of ["facts", "cast", "chapters", "copy_provenance", "cast_merges"]) {
    try {
      counts[table] = handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}

/**
 * Every volume folder in this series that has a reference record.
 *
 * The plan of record is the first answer because it is the one the pipeline itself decided. When it is
 * missing — a fixture, or a series nobody has discovered yet — the folders are read from disk, because
 * the staleness question has to be answerable about a record that exists even when the plan does not.
 *
 * @param {string} seriesDir
 * @returns {Array<{volume: number, folder: string, file: string}>}
 */
function recordsInSeries(seriesDir) {
  /** @type {Array<{volume: number, folder: string, file: string}>} */
  const found = [];
  const plan = readPlanOfRecord(seriesDir) || [];
  for (const entry of plan) {
    const volume = Number(entry.installmentNumber === undefined ? entry.volume : entry.installmentNumber);
    const folder = entry.folder;
    if (!Number.isFinite(volume) || !folder) continue;
    const file = path.join(seriesDir, folder, REFERENCE_STORE_FILE_NAME);
    if (fs.existsSync(file)) found.push({ volume, folder, file });
  }
  if (found.length) return found.sort((a, b) => a.volume - b.volume);

  let entries;
  try {
    entries = fs.readdirSync(seriesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(seriesDir, entry.name, REFERENCE_STORE_FILE_NAME);
    if (!fs.existsSync(file)) continue;
    const digits = entry.name.match(/(\d+)\s*\)?$/);
    found.push({ volume: digits ? Number(digits[1]) : Number.NaN, folder: entry.name, file });
  }
  return found.sort((a, b) => a.volume - b.volume);
}

/**
 * The records derived from this volume, directly or through another volume, and therefore stale the
 * moment this volume is redone.
 *
 * Directly: `copy_provenance.source_volume = volume`. Transitively: a record copied from a record that
 * is itself stale is stale, because it was built on a copy of a record that no longer describes the book.
 *
 * @param {string} seriesDir
 * @param {number} volume
 * @returns {{direct: Array<{volume: number, folder: string, copiedAt: string|null}>, transitive: Array<{volume: number, folder: string, copiedAt: string|null, via: number}>}}
 */
function derivedRecords(seriesDir, volume) {
  const records = recordsInSeries(seriesDir);
  /** @type {Map<number, {volume: number, folder: string, copiedAt: string|null, sourceVolume: number|null}>} */
  const derivedFrom = new Map();
  for (const record of records) {
    let db = null;
    try {
      db = openDatabase(record.file, { readOnly: true });
      const row = db.prepare("SELECT source_volume, copied_at FROM copy_provenance WHERE volume = ?").get(record.volume);
      if (row) {
        derivedFrom.set(record.volume, {
          volume: record.volume,
          folder: record.folder,
          copiedAt: row.copied_at === null ? null : row.copied_at,
          sourceVolume: Number(row.source_volume),
        });
      }
    } catch {
      // A file that will not open is not a derived record. The door that opens it will say what is wrong.
    } finally {
      if (db) db.close();
    }
  }

  /** @type {Set<number>} */
  const known = new Set([Number(volume)]);
  /** @type {Array<{volume: number, folder: string, copiedAt: string|null}>} */
  const direct = [];
  /** @type {Array<{volume: number, folder: string, copiedAt: string|null, via: number}>} */
  const transitive = [];
  for (const entry of derivedFrom.values()) {
    if (entry.sourceVolume === Number(volume)) {
      direct.push({ volume: entry.volume, folder: entry.folder, copiedAt: entry.copiedAt });
      known.add(entry.volume);
    }
  }
  for (let pass = 0; pass < derivedFrom.size; pass++) {
    let grew = false;
    for (const entry of derivedFrom.values()) {
      if (known.has(entry.volume)) continue;
      if (entry.sourceVolume !== null && known.has(entry.sourceVolume)) {
        transitive.push({ volume: entry.volume, folder: entry.folder, copiedAt: entry.copiedAt, via: entry.sourceVolume });
        known.add(entry.volume);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return { direct: direct.sort((a, b) => a.volume - b.volume), transitive: transitive.sort((a, b) => a.volume - b.volume) };
}

/**
 * How many times a volume's record has been reopened, according to one open handle.
 *
 * The number a copy stamps into its own provenance row, so the staleness question is a comparison of two
 * integers rather than two millisecond timestamps.
 *
 * @param {Object} db - An open database handle on a record.
 * @param {number} volume - The volume whose reopen count is wanted.
 * @returns {number} 0 when the record has no reopen table or no rows.
 */
function countReopenRows(db, volume) {
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM record_reopens WHERE volume = ?").get(Number(volume)).n;
  } catch {
    return 0;
  }
}

/**
 * Whether an existing record was copied from a volume that has since been reopened.
 *
 * This is the guard that stops a stale copy from passing silently, and it is asked before anything is
 * carried or topped up. `topUpVolumeRecord` only ever ADDS rows, so topping up a stale record would
 * leave the old volume's claims in place beside the new ones and report success.
 *
 * How it decides, since the obvious ways do not work. Comparing the copy's `copied_at` with the reopen's
 * `reopened_at` fails when the two land in the same millisecond — which is exactly what a redo does to the
 * volume immediately after it. Comparing a count stamped into `copy_provenance.source_reopens` at copy time
 * fails when the stamp was written wrong, which it was on the first real use of this door. What is left is
 * the reopen history itself: a copy-forward copies the file whole, `record_reopens` is one of the counted
 * tables, so **the copy carries its source's reopen history at the moment it was made**. A record copied
 * before a redo holds fewer of its source's reopen rows than that source holds now; a record copied after
 * one holds them all. Two files, one comparison, no clock.
 *
 * @param {{db: Object, volume: number}} ctx - An open handle on the record being asked about.
 * @param {string} seriesDir
 * @returns {{stale: boolean, sourceVolume: number|null, copiedAt: string|null, reopenedAt: string|null, reason: string|null, reopensInCopy: number, reopensInSource: number, stamped: number}}
 */
function recordIsStale(ctx, seriesDir) {
  /** @type {{source_volume: number, copied_at: string|null}|null} */
  let provenance = null;
  try {
    provenance = ctx.db.prepare("SELECT source_volume, copied_at FROM copy_provenance WHERE volume = ?").get(ctx.volume) || null;
  } catch {
    return { stale: false, sourceVolume: null, copiedAt: null, reopenedAt: null, reason: null, reopensInCopy: 0, reopensInSource: 0, stamped: 0 };
  }
  if (!provenance) return { stale: false, sourceVolume: null, copiedAt: null, reopenedAt: null, reason: null, reopensInCopy: 0, reopensInSource: 0, stamped: 0 };

  const sourceVolume = Number(provenance.source_volume);
  const copiedAt = provenance.copied_at === null ? null : provenance.copied_at;

  let source;
  try {
    source = referenceStorePath({ seriesDir, volume: sourceVolume });
  } catch {
    return { stale: false, sourceVolume, copiedAt, reopenedAt: null, reason: null, reopensInCopy: 0, reopensInSource: 0, stamped: 0 };
  }
  if (!fs.existsSync(source.file)) return { stale: false, sourceVolume, copiedAt, reopenedAt: null, reason: null, reopensInCopy: 0, reopensInSource: 0, stamped: 0 };

  let db = null;
  try {
    db = openDatabase(source.file, { readOnly: true });
    const reopensInSource = countReopenRows(db, sourceVolume);
    // The copy carries its source's reopen history, because a copy-forward copies the file whole and
    // `record_reopens` is one of the counted tables. So the question answers itself out of the two files:
    // a record copied BEFORE the redo holds fewer of its source's reopen rows than the source now holds,
    // and a record copied AFTER it holds all of them.
    const reopensInCopy = countReopenRows(ctx.db, sourceVolume);
    let stamped = 0;
    try {
      stamped = Number(ctx.db.prepare("SELECT source_reopens FROM copy_provenance WHERE volume = ?").get(ctx.volume).source_reopens) || 0;
    } catch {
      stamped = 0;
    }
    const latest = db.prepare("SELECT reopened_at, reason FROM record_reopens WHERE volume = ? ORDER BY reopened_at DESC LIMIT 1").get(sourceVolume);
    if (!latest) return { stale: false, sourceVolume, copiedAt, reopenedAt: null, reason: null, reopensInCopy, reopensInSource, stamped };

    // The histories are the answer, and they are exact: no clock resolution is involved, and a copy and a
    // reopen landing in the same millisecond — which is precisely what a redo does to the volume right
    // after it — cannot be misread. `copy_provenance.source_reopens` is reported alongside as what the copy
    // said about the source at the time it was made; it is provenance, not the verdict, because a stamp can
    // be written wrong and a history that travelled inside the copy cannot.
    const stale = reopensInCopy < reopensInSource;
    return { stale, sourceVolume, copiedAt, reopenedAt: latest.reopened_at, reason: latest.reason, reopensInCopy, reopensInSource, stamped };
  } catch {
    return { stale: false, sourceVolume, copiedAt, reopenedAt: null, reason: null, reopensInCopy: 0, reopensInSource: 0, stamped: 0 };
  } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }
}

/**
 * Whether the record a volume already has is a copy of a volume that has since been reopened.
 *
 * The door `openVolumeRecord` asks: it has a volume number and a folder, not an open handle, and the
 * question has to be answered before the record is opened for writing — because opening it is what a
 * top-up would then go on to add rows to.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir
 * @param {number|string} opts.volume
 * @param {string} [opts.folder]
 * @returns {{checked: boolean, stale: boolean, sourceVolume: number|null, copiedAt: string|null, reopenedAt: string|null, reason: string|null, error: string|null}}
 */
function volumeRecordIsStale({ seriesDir, volume, folder }) {
  let resolved;
  try {
    resolved = referenceStorePath({ seriesDir, volume, folder });
  } catch (err) {
    return { checked: false, stale: false, sourceVolume: null, copiedAt: null, reopenedAt: null, reason: null, error: String(err && err.message ? err.message : err) };
  }
  if (!fs.existsSync(resolved.file)) {
    return { checked: false, stale: false, sourceVolume: null, copiedAt: null, reopenedAt: null, reason: null, error: null };
  }
  let db = null;
  try {
    db = openDatabase(resolved.file, { readOnly: true });
    const result = recordIsStale({ db, volume: Number(volume) }, resolved.seriesDir);
    return { checked: true, ...result, error: null };
  } catch (err) {
    return { checked: false, stale: false, sourceVolume: null, copiedAt: null, reopenedAt: null, reason: null, error: String(err && err.message ? err.message : err) };
  } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }
}

/**
 * The acceptance windows a reopen voids, per volume folder.
 *
 * A volume's acceptance window (`character-voice-validation-rolling-state.json`) is the rolling list of
 * grades that let that volume's reference through its gate, persisted so a re-run can recover it instead
 * of paying for the grades again. It is therefore the *record's* memory, not the folder's: the grades in
 * volume 1's window are the grades a reference that has just been retired was accepted on.
 *
 * Left in place, a reopen quietly inherits them. Measured on the real volume 01 before this was fixed:
 * its window held `[48]` — the grade the destroyed authored reference earned — and the acceptance
 * criterion averages the window, so a redone reference graded 82 would have been accepted at
 * (48 + 82) / 2 = 65 against a passing score of 70, i.e. **refused by the grade of the file the reopen
 * threw away**. Retiring the record without retiring its grades is half an act.
 *
 * Only the character-voice window is here. The glossary's window belongs to the glossary stage, and a
 * voice-record reopen does not re-render the glossary artifact; the glossary's own gate is its own.
 *
 * @type {string[]}
 */
const RETIRED_ACCEPTANCE_WINDOWS = Object.freeze(["character-voice-validation-rolling-state.json"]);

/**
 * Move a volume's acceptance window(s) aside, so a redone volume is graded on its own merits rather than
 * averaged with the grades of the record that was retired.
 *
 * @param {string} volumeDir
 * @param {{stampValue?: string, files?: string[]}} [opts]
 * @returns {{retired: Array<{file: string, retired: string}>, absent: string[], error: string|null}}
 */
function retireAcceptanceWindows(volumeDir, { stampValue, files = RETIRED_ACCEPTANCE_WINDOWS } = {}) {
  const when = stampValue || stamp();
  /** @type {Array<{file: string, retired: string}>} */
  const retired = [];
  /** @type {string[]} */
  const absent = [];
  for (const name of files) {
    const from = path.join(volumeDir, name);
    if (!fs.existsSync(from)) {
      absent.push(name);
      continue;
    }
    const to = path.join(volumeDir, `${name}.retired-${when}`);
    try {
      fs.renameSync(from, to);
      retired.push({ file: name, retired: to });
    } catch (err) {
      return { retired, absent, error: `could not move ${name} aside: ${String(err && err.message ? err.message : err)}` };
    }
  }
  return { retired, absent, error: null };
}

/**
 * Move a volume's record file aside, whole, and say where it went.
 *
 * The sidecar files go with it: a retired `series.db` with a live `-wal` beside it is a record whose
 * last transactions are sitting in a file the next run will not read.
 *
 * @param {string} seriesDir
 * @param {number|string} volume
 * @param {string} [folder]
 * @param {{stampValue?: string}} [opts]
 * @returns {{ok: boolean, retired: string|null, from: string, refusal: ReferenceRefusal|null}}
 */
function retireVolumeRecordFile(seriesDir, volume, folder, { stampValue } = {}) {
  let resolved;
  try {
    resolved = referenceStorePath({ seriesDir, volume, folder });
  } catch (err) {
    return {
      ok: false,
      retired: null,
      from: "",
      refusal: refusal({
        verb: "retire_record",
        rule: "reference-copy-path-undecided",
        because: `the record to retire could not be located: ${String(err && err.message ? err.message : err)}`,
        fix: "name the volume folder explicitly, or re-run \"npx gulp discover\" so the plan of record lists them.",
      }),
    };
  }
  if (!fs.existsSync(resolved.file)) {
    return {
      ok: false,
      retired: null,
      from: resolved.file,
      refusal: refusal({
        verb: "retire_record",
        rule: "reopen-nothing-to-reopen",
        because: `volume ${volume} has no reference record at ${resolved.file}. There is nothing to retire.`,
        fix: "run the volume normally; a volume with no record is built from the volume before it.",
      }),
    };
  }

  const dir = path.dirname(resolved.file);
  const when = stampValue || stamp();
  let target = path.join(dir, `${RETIRED_PREFIX}${when}`);
  let n = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${RETIRED_PREFIX}${when}.${n}`);
    n += 1;
  }

  for (const suffix of ["", "-wal", "-shm"]) {
    if (!fs.existsSync(resolved.file + suffix)) continue;
    try {
      fs.renameSync(resolved.file + suffix, target + suffix);
    } catch (err) {
      return {
        ok: false,
        retired: null,
        from: resolved.file,
        refusal: refusal({
          verb: "retire_record",
          rule: "reopen-retire-failed",
          because: `could not move ${path.basename(resolved.file + suffix)} to ${path.basename(target + suffix)}: ${err.message}`,
          fix: "close whatever is holding the record open (a run in another terminal), then retire it again.",
        }),
      };
    }
  }
  return { ok: true, retired: target, from: resolved.file, refusal: null };
}

/**
 * Carry a retired record's reopen history into the fresh record.
 *
 * Without this, the act that records the reopen is the act that destroys the record of it. The history
 * is the only part of a retired record the live one has to keep: every claim in it is being redone on
 * purpose, but "this volume was redone, on this date, for this reason" is not something the redo is
 * redoing.
 *
 * @param {string} retiredFile - The retired `series.db`.
 * @param {string} freshFile - The record being built.
 * @returns {{carried: number, error: string|null}}
 */
function carryReopenHistory(retiredFile, freshFile) {
  let db = null;
  try {
    db = openDatabase(freshFile);
    applySchema(db);
    const source = openDatabase(retiredFile, { readOnly: true });
    const rows = source
      .prepare("SELECT volume, reopened_at, reason, was_sealed, sealed_at, rows_at_reopen, copies_affected FROM record_reopens")
      .all();
    const insert = db.prepare(
      "INSERT OR IGNORE INTO record_reopens (volume, reopened_at, reason, was_sealed, sealed_at, rows_at_reopen, copies_affected) VALUES (?,?,?,?,?,?,?)"
    );
    let carried = 0;
    for (const row of rows) {
      insert.run(row.volume, row.reopened_at, row.reason, row.was_sealed, row.sealed_at, row.rows_at_reopen, row.copies_affected);
      carried += 1;
    }
    source.close();
    db.close();
    return { carried, error: null };
  } catch (err) {
    if (db) { try { db.close(); } catch { /* already gone */ } }
    return { carried: 0, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Reopen one volume's published record: record why, retire the record, and say what happens to the
 * volumes that were built on it.
 *
 * @param {Object} opts
 * @param {number|string} opts.volume
 * @param {string} [opts.folder]
 * @param {string} [opts.seriesDir]
 * @param {string} opts.reason - Required, and required to be a reason rather than the act restated.
 * @param {"refuse"|"retire"} [opts.cascade] - What to do with the records derived from this volume.
 *   `refuse` (the default) stops here and names them. `retire` retires them too, with the same reason
 *   recorded. There is no third value, and no environment variable supplies one.
 * @returns {{ok: boolean, volume: number, folder: string, reopened: Object|null, retired: string|null, cascade: Array<{volume: number, folder: string, retired: string|null, because?: string|null}>, refusal: ReferenceRefusal|null}}
 */
function reopenVolumeRecord({ volume, folder, seriesDir, reason, cascade = "refuse" }) {
  const vol = Number(volume);
  const why = String(reason === undefined || reason === null ? "" : reason).replace(/\s+/g, " ").trim();

  /**
   * The one shape every refusal in this function returns, so a caller can always read `.refusal`.
   * @param {ReferenceRefusal} ref
   */
  const refused = (ref) => ({ ok: false, volume: vol, folder: folder || "", reopened: null, retired: null, cascade: [], refusal: ref });

  if (!why) {
    return refused(refusal({
      verb: "reopen_record",
      rule: "reopen-reason-required",
      because: `reopening volume ${vol}'s published record was asked for with no reason.`,
      useInstead: [`reopenVolumeRecord({ volume: ${vol}, reason }) — the reason is written into the record, not into a log`],
      fix: `say why this volume is being redone, in at least ${MIN_REOPEN_REASON_CHARS} characters: what is wrong with the record as published, and what the redo is meant to fix.`,
    }));
  }
  if (why.length < MIN_REOPEN_REASON_CHARS) {
    return refused(refusal({
      verb: "reopen_record",
      rule: "reopen-reason-too-thin",
      because:
        `"${why}" (${why.length} characters) names the act, not the reason. The row this writes is read by whoever ` +
        "opens this record later, and the question they have is why the published record was thrown away.",
      fix: `say what is wrong with the record as published and what the redo fixes — at least ${MIN_REOPEN_REASON_CHARS} characters.`,
    }));
  }
  if (cascade !== "refuse" && cascade !== "retire") {
    return refused(refusal({
      verb: "reopen_record",
      rule: "reopen-cascade-unknown",
      because:
        `"${cascade}" is not a cascade answer. The two are "refuse" (stop here and name the volumes built on this ` +
        "one) and \"retire\" (retire them too, with this reason recorded).",
      fix: "choose one explicitly. A redo that guesses what happens to the later volumes is the stale copy this guard exists to stop.",
    }));
  }

  let resolved;
  try {
    resolved = referenceStorePath({ seriesDir, volume: vol, folder });
  } catch (err) {
    return refused(refusal({
      verb: "reopen_record",
      rule: "reference-copy-path-undecided",
      because: `the record to reopen could not be located: ${String(err && err.message ? err.message : err)}`,
      fix: "name the volume folder explicitly, or re-run \"npx gulp discover\" so the plan of record lists them.",
    }));
  }

  if (!fs.existsSync(resolved.file)) {
    return refused(refusal({
      verb: "reopen_record",
      rule: "reopen-nothing-to-reopen",
      because: `volume ${vol} has no reference record at ${resolved.file}. A volume with no record is not reopened; it is built.`,
      fix: "run the volume normally.",
    }));
  }

  /** @type {Object<string, number>} */
  let counts = {};
  let sealedAt = null;
  let wasSealed = false;
  let db = null;
  try {
    db = openDatabase(resolved.file);
    applySchema(db);
    counts = recordRowCounts(db);
    const marker = db.prepare("SELECT value FROM store_info WHERE key = ?").get(`sealed_volume_${vol}`);
    wasSealed = Boolean(marker);
    sealedAt = marker ? marker.value : null;
  } catch (err) {
    if (db) { try { db.close(); } catch { /* already gone */ } }
    return refused(refusal({
      verb: "reopen_record",
      rule: "reference-source-unreadable",
      because: `volume ${vol}'s record could not be opened to be reopened: ${String(err && err.message ? err.message : err)}`,
      fix: "read the error before retiring anything — a record that will not open may be a record worth keeping.",
    }));
  } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }

  const derived = derivedRecords(resolved.seriesDir, vol);
  const downstream = [...derived.direct, ...derived.transitive];
  if (downstream.length && cascade !== "retire") {
    return refused(refusal({
      verb: "reopen_record",
      rule: "reopen-has-stale-copies",
      because:
        `volume ${vol}'s record is the source of ${downstream.length} other record(s): ` +
        downstream.map((d) => `volume ${d.volume} (${d.folder})${d.via ? ` via volume ${d.via}` : ""}`).join(", ") +
        `. Redoing volume ${vol} makes every one of them a copy of a record that no longer describes the book, ` +
        "and the top-up door only ever ADDS rows — topping up a stale record would leave the old volume's claims " +
        "in place beside the new ones and report success.",
      useInstead: [`reopenVolumeRecord({ volume: ${vol}, reason, cascade: "retire" }) — retires those records too, with the same reason recorded`],
      fix: "say what happens to the volumes built on this one. Retiring them is the honest answer; leaving them is the stale copy.",
    }));
  }

  const when = new Date().toISOString();
  const copiesAffected = downstream.map((d) => d.volume);

  // The reopen row is written into the record BEFORE it is retired, and then carried into the fresh one,
  // so the act survives the act.
  db = null;
  try {
    db = openDatabase(resolved.file);
    applySchema(db);
    db.prepare(
      "INSERT INTO record_reopens (volume, reopened_at, reason, was_sealed, sealed_at, rows_at_reopen, copies_affected) VALUES (?,?,?,?,?,?,?)"
    ).run(vol, when, why, wasSealed ? 1 : 0, sealedAt, JSON.stringify(counts), JSON.stringify(copiesAffected));
  } catch (err) {
    if (db) { try { db.close(); } catch { /* already gone */ } }
    return refused(refusal({
      verb: "reopen_record",
      rule: "reopen-record-refused",
      because: `the reopen could not be written into volume ${vol}'s record: ${String(err && err.message ? err.message : err)}`,
      fix: "an act that cannot be recorded is not an act; nothing was retired.",
    }));
  } finally {
    if (db) { try { db.close(); } catch { /* already closed */ } }
  }

  const retired = retireVolumeRecordFile(resolved.seriesDir, vol, resolved.folder, { stampValue: stamp(new Date(when)) });
  if (!retired.ok) return { ok: false, volume: vol, folder: resolved.folder, reopened: null, retired: null, cascade: [], windows: [], refusal: retired.refusal };

  const carried = carryReopenHistory(retired.retired, resolved.file);
  if (carried.error) {
    return {
      ok: false,
      volume: vol,
      folder: resolved.folder,
      reopened: null,
      retired: retired.retired,
      cascade: [],
      windows: [],
      refusal: refusal({
        verb: "reopen_record",
        rule: "reopen-history-not-carried",
        because: `the record was retired but its reopen history could not be written into the fresh record: ${carried.error}`,
        fix: `the retired file is ${retired.retired}; read the reopen row from it, or re-derive volume ${vol}'s record.`,
      }),
    };
  }

  /** @type {Array<{volume: number, folder: string, retired: string|null, because: string|null}>} */
  const cascadeDone = [];
  if (cascade === "retire") {
    for (const entry of downstream) {
      const entryRetire = retireVolumeRecordFile(resolved.seriesDir, entry.volume, entry.folder, { stampValue: stamp(new Date(when)) });
      cascadeDone.push({
        volume: entry.volume,
        folder: entry.folder,
        retired: entryRetire.ok ? entryRetire.retired : null,
        because: entryRetire.ok ? null : String(entryRetire.refusal && entryRetire.refusal.because),
      });
    }
  }

  // The grades go with the record they graded. See `RETIRED_ACCEPTANCE_WINDOWS` for why leaving them is
  // half an act: the acceptance criterion averages the window, so an inherited grade from a retired
  // reference decides whether a redone one passes.
  const windowDirs = [{ volume: vol, folder: resolved.folder }, ...cascadeDone.map((c) => ({ volume: c.volume, folder: c.folder }))];
  /** @type {Array<{volume: number, folder: string, retired: Array<{file: string, retired: string}>}>} */
  const windows = [];
  for (const dir of windowDirs) {
    const win = retireAcceptanceWindows(path.join(resolved.seriesDir, dir.folder), { stampValue: stamp(new Date(when)) });
    if (win.error) {
      return {
        ok: false,
        volume: vol,
        folder: resolved.folder,
        reopened: null,
        retired: retired.retired,
        cascade: cascadeDone,
        refusal: refusal({
          verb: "reopen_record",
          rule: "reopen-acceptance-window-not-retired",
          because: `volume ${dir.volume}'s acceptance window could not be moved aside: ${win.error}. The reopen is not finished, because the next run of that volume would be graded against the window of the record this act retired.`,
          fix: `move ${path.join(resolved.seriesDir, dir.folder, "character-voice-validation-rolling-state.json")} aside yourself, then re-run the reopen.`,
        }),
      };
    }
    if (win.retired.length) windows.push({ volume: dir.volume, folder: dir.folder, retired: win.retired });
  }

  return {
    ok: true,
    volume: vol,
    folder: resolved.folder,
    reopened: {
      volume: vol,
      reopened_at: when,
      reason: why,
      was_sealed: wasSealed,
      sealed_at: sealedAt,
      rows_at_reopen: counts,
      copies_affected: copiesAffected,
    },
    retired: retired.retired,
    cascade: cascadeDone,
    windows,
    refusal: null,
  };
}

module.exports = {
  MIN_REOPEN_REASON_CHARS,
  RETIRED_ACCEPTANCE_WINDOWS,
  RETIRED_PREFIX,
  carryReopenHistory,
  countReopenRows,
  derivedRecords,
  readReopenHistory,
  recordIsStale,
  recordRowCounts,
  retireAcceptanceWindows,
  recordsInSeries,
  reopenVolumeRecord,
  retireVolumeRecordFile,
  stamp,
  volumeRecordIsStale,
};

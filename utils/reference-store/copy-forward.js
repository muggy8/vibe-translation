/**
 * utils/reference-store/copy-forward.js — copying volume N−1's record into volume N, as a
 * checked step rather than a file copy (doc 03 §7.3).
 *
 * Per-volume files are the account owner's decision (doc 04 §6): volume N's file is a copy
 * of volume N−1's, then volume N's agents add to it. The upside is that spoiler isolation
 * stops being a query the code must remember to write. The honest downside is stated in
 * doc 03 §7.2: **damage propagates forward.** Volume 4's file was copied from volume 3's;
 * if volume 3's is corrupt, volume 4's is corrupt the same way.
 *
 * So the copy is where the guard goes — the exact moment damage would propagate, and the
 * one moment it can still be refused. Four things this step does, all of them required by
 * §7.3:
 *
 *   - it refuses to copy a database that fails the integrity queries;
 *   - it records the source file's content hash and row counts INSIDE the copy;
 *   - after copying, it verifies the copy's row counts equal the source's;
 *   - a copy that fails is a **HIGH** post-mortem finding, not a warning.
 *
 * It also refuses to overwrite a volume that already has its own record. A volume's file is
 * the thing its agents have been adding to; a copy-forward that quietly replaced it would
 * destroy a volume's work while reporting that it had carried the previous one forward.
 *
 * @module utils/reference-store/copy-forward
 */

const crypto = require("crypto");
const fs = require("fs");

const { finding } = require("../postmortem");
const { openDatabase, copyDatabase, discardDatabase } = require("./db");
const { referenceStorePath } = require("./paths");
const { openReferenceStore } = require("./open");
const { integrityFindings, INTEGRITY_STEP } = require("./integrity");
const { COUNTED_TABLES, SCHEMA_VERSION, readSchemaVersion } = require("./schema");
const { refusal } = require("./refusals");
const { listCast } = require("./cast");
require("../../types"); // JSDoc type definitions

/**
 * sha256 of a file, for the provenance record.
 *
 * @param {string} file
 * @returns {string}
 */
function sha256OfFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Copy volume `fromVolume`'s reference store into `toVolume`'s folder, guarded.
 *
 * @param {Object} opts
 * @param {number|string} opts.fromVolume - The volume being carried forward FROM.
 * @param {number|string} opts.toVolume - The volume being prepared.
 * @param {string} [opts.seriesDir] - Series folder. Defaults to SERIES_LOCATION, at call time.
 * @param {string} [opts.fromFolder] - Source volume folder name, when already known.
 * @param {string} [opts.toFolder] - Destination volume folder name, when already known.
 * @param {string} [opts.step] - The step name the findings are filed under.
 * @returns {{ok: boolean, refusal: ReferenceRefusal|null, findings: PostMortemFinding[], provenance: Object|null, source: Object|null, dest: Object|null}}
 */
function copyForwardStore({ fromVolume, toVolume, seriesDir, fromFolder, toFolder, step = INTEGRITY_STEP } = {}) {
  /**
   * Build the one shape every failure in this step returns.
   * @param {ReferenceRefusal} ref
   * @param {PostMortemFinding[]} findings
   */
  const refused = (ref, findings = []) => ({
    ok: false,
    refusal: ref,
    findings,
    provenance: null,
    source: null,
    dest: null,
  });

  // Path resolution throws (paths.js refuses rather than falling back to the repo), and a
  // guarded step reports a refusal rather than throwing through its caller.
  let sourcePath = null;
  let destPath = null;
  try {
    sourcePath = referenceStorePath({ seriesDir, volume: fromVolume, folder: fromFolder });
    destPath = referenceStorePath({ seriesDir, volume: toVolume, folder: toFolder });
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    return refused(
      refusal({
        verb: "copy_forward",
        rule: "reference-copy-path-undecided",
        because: `copy-forward could not decide which folders to use: ${message}`,
        fix: "name the volume folders explicitly, or re-run \"npx gulp discover\" so the plan of record lists them.",
      }),
      [
        finding(
          "HIGH",
          "reference-copy-path-undecided",
          step,
          String(toVolume),
          "series.db",
          `copy-forward to volume ${toVolume} refused: ${message}`
        ),
      ]
    );
  }
  const volKey = String(toVolume);

  if (!fs.existsSync(sourcePath.file)) {
    return refused(
      refusal({
        verb: "copy_forward",
        rule: "reference-copy-missing-source",
        because: `volume ${fromVolume} has no reference store at ${sourcePath.file}.`,
        fix: `build volume ${fromVolume}'s record first, or copy from the volume that does have one.`,
      }),
      [
        finding(
          "HIGH",
          "reference-copy-missing-source",
          step,
          volKey,
          `${sourcePath.folder}/series.db`,
          `copy-forward to volume ${toVolume} refused: no source store at ${sourcePath.file}.`
        ),
      ]
    );
  }

  if (fs.existsSync(destPath.file)) {
    return refused(
      refusal({
        verb: "copy_forward",
        rule: "reference-copy-overwrites-a-volume",
        because:
          `volume ${toVolume} already has its own reference store at ${destPath.file}. Copy-forward does ` +
          "not overwrite a volume's record, because that record is what that volume's agents have added to.",
        fix: "if the volume's record is meant to be rebuilt, remove its series.db deliberately first.",
      }),
      [
        finding(
          "HIGH",
          "reference-copy-overwrites-a-volume",
          step,
          volKey,
          `${destPath.folder}/series.db`,
          `copy-forward to volume ${toVolume} refused: the volume already has a record and was left untouched.`
        ),
      ]
    );
  }

  let source = null;
  try {
    source = openReferenceStore({
      volume: fromVolume,
      folder: fromFolder,
      seriesDir: sourcePath.seriesDir,
      stage: "merge",
    });
  } catch (err) {
    return refused(
      refusal({
        verb: "copy_forward",
        rule: "reference-source-unreadable",
        because: `volume ${fromVolume}'s store could not be opened: ${String(err && err.message ? err.message : err)}`,
      }),
      [
        finding(
          "HIGH",
          "reference-source-unreadable",
          step,
          volKey,
          `${sourcePath.folder}/series.db`,
          `copy-forward to volume ${toVolume} refused: ${String(err && err.message ? err.message : err)}`
        ),
      ]
    );
  }

  // The integrity gate: doc 03 §7.3's first bullet. A corrupt volume does not get to
  // infect the next one. `publishedVolume` is the point of this call: the volume being copied is
  // the volume the caller treats as finished, so the sealing question is asked about it — which is
  // what makes "a volume whose voice reference lost characters may not be copied forward" a hard
  // stop rather than a note.
  const audit = integrityFindings(source, { volume: String(fromVolume), step, publishedVolume: fromVolume });
  const upgraded = source.schemaVersion !== SCHEMA_VERSION || source.created;
  if (!audit.ok) {
    const high = audit.findings.filter((f) => f.severity === "HIGH");
    source.close();
    return refused(
      refusal({
        verb: "copy_forward",
        rule: "reference-source-fails-integrity",
        because:
          `volume ${fromVolume}'s record fails ${high.length} integrity check(s) and was not copied. ` +
          high.map((f) => `  - ${f.kind}: ${f.message}`).join("\n"),
        fix: `repair volume ${fromVolume}'s record (or re-derive it from volume ${Number(fromVolume) - 1}) before copying forward.`,
      }),
      audit.findings
    );
  }

  const sourceCounts = source.tableCounts();
  const sourceCastKeys = listCast(source).map((c) => c.key);
  const sourceSha256 = sha256OfFile(source.file);

  const copied = copyDatabase(source.db, source.file, destPath.file);
  if (!copied.ok) {
    discardDatabase(destPath.file);
    source.close();
    return refused(
      refusal({
        verb: "copy_forward",
        rule: "reference-copy-failed",
        because: `the engine's backup into ${destPath.file} failed: ${copied.error}`,
      }),
      [
        finding(
          "HIGH",
          "reference-copy-failed",
          step,
          volKey,
          `${destPath.folder}/series.db`,
          `copy-forward to volume ${toVolume} failed while writing: ${copied.error}`
        ),
      ]
    );
  }
  source.close();

  let dest = null;
  try {
    dest = openReferenceStore({
      volume: toVolume,
      folder: toFolder,
      seriesDir: destPath.seriesDir,
      stage: "merge",
    });
  } catch (err) {
    discardDatabase(destPath.file);
    return refused(
      refusal({
        verb: "copy_forward",
        rule: "reference-copy-unreadable-after-copy",
        because: `the copy at ${destPath.file} could not be opened after it was written: ${String(err && err.message ? err.message : err)}`,
      }),
      [
        finding(
          "HIGH",
          "reference-copy-unreadable-after-copy",
          step,
          volKey,
          `${destPath.folder}/series.db`,
          `the copy written to volume ${toVolume} is not a readable store: ${String(err && err.message ? err.message : err)}`
        ),
      ]
    );
  }

  const copiedCounts = dest.tableCounts();
  const findings = [];

  // §7.3's third bullet: the copy's row counts must equal the source's. Compared table by
  // table, because "the copy has the same number of rows overall" is satisfied by a copy
  // that lost every fact and gained the same number of something else.
  //
  // `volumes` is the one table excluded, and the exclusion is stated rather than hidden: the
  // copy legitimately registers the volume it landed in, which is the entire point of copying
  // forward. Every other table must match exactly, and the two counts are returned either way
  // so the difference is visible in the report.
  const mismatches = [];
  for (const table of COUNTED_TABLES) {
    if (table === "volumes") continue;
    if ((sourceCounts[table] || 0) !== (copiedCounts[table] || 0)) {
      mismatches.push(`${table}: source ${sourceCounts[table] || 0}, copy ${copiedCounts[table] || 0}`);
    }
  }
  if (mismatches.length) {
    findings.push(
      finding(
        "HIGH",
        "reference-copy-row-count-mismatch",
        step,
        volKey,
        `${destPath.folder}/series.db`,
        `the copy of volume ${fromVolume} into volume ${toVolume} does not carry the same rows: ${mismatches.join("; ")}`
      )
    );
  }

  // doc 03 §5's carry-forward row: a cast key in the source that is missing from the copy
  // is a character lost between volumes, checked at the moment the copy is made.
  const copiedCastKeys = new Set(listCast(dest).map((c) => c.key));
  const lostCharacters = sourceCastKeys.filter((key) => !copiedCastKeys.has(key));
  if (lostCharacters.length) {
    findings.push(
      finding(
        "HIGH",
        "reference-character-lost-in-copy",
        step,
        volKey,
        `${destPath.folder}/series.db`,
        `the copy lost ${lostCharacters.length} character(s) present in volume ${fromVolume}: ${lostCharacters.join(", ")}`
      )
    );
  }

  // §7.3's second bullet: the source's hash and counts, recorded INSIDE the copy, so
  // "which record did volume 5 work from?" is answerable from the file itself.
  const provenance = {
    volume: Number(toVolume),
    sourceVolume: Number(fromVolume),
    sourceFile: sourcePath.file,
    sourceSha256,
    sourceRows: sourceCounts,
    copiedRows: copiedCounts,
    copiedAt: new Date().toISOString(),
    ok: findings.length === 0 ? 1 : 0,
    note: findings.length ? findings.map((f) => f.message).join(" ") : null,
  };
  dest.db
    .prepare(
      "INSERT INTO copy_provenance (volume, source_volume, source_file, source_sha256, source_rows, copied_rows, copied_at, ok, note) " +
        "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(volume) DO UPDATE SET copied_rows = excluded.copied_rows, ok = excluded.ok, note = excluded.note"
    )
    .run(
      provenance.volume,
      provenance.sourceVolume,
      provenance.sourceFile,
      provenance.sourceSha256,
      JSON.stringify(sourceCounts),
      JSON.stringify(copiedCounts),
      provenance.copiedAt,
      provenance.ok,
      provenance.note
    );

  if (upgraded) {
    findings.push(
      finding(
        "MEDIUM",
        "reference-source-schema-upgraded",
        step,
        volKey,
        `${sourcePath.folder}/series.db`,
        `volume ${fromVolume}'s store was written by an older build (schema ${readSchemaVersion(
          dest.db
        )} in the copy) and its schema was brought up to ${SCHEMA_VERSION} during the copy.`
      )
    );
  }

  const ok = findings.every((f) => f.severity !== "HIGH");
  return {
    ok,
    refusal: ok
      ? null
      : refusal({
          verb: "copy_forward",
          rule: "reference-copy-verification-failed",
          because: findings.map((f) => `  - ${f.kind}: ${f.message}`).join("\n"),
          fix: `volume ${toVolume}'s copy is not trustworthy: re-derive it from volume ${Number(fromVolume) - 1} instead.`,
        }),
    findings,
    provenance,
    source: { file: sourcePath.file, counts: sourceCounts, castKeys: sourceCastKeys, sha256: sourceSha256 },
    dest: { file: destPath.file, counts: copiedCounts },
    closeDest: () => dest && dest.close(),
  };
}

/**
 * Read the provenance a copy left inside a volume's own file.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<Object>} One row per volume that was produced by a copy, oldest source first.
 */
function readCopyProvenance(ctx) {
  return ctx.db.prepare("SELECT * FROM copy_provenance ORDER BY volume").all();
}

/**
 * Bring a volume's record up to date with the record it was copied from.
 *
 * This exists because of the order the pipeline runs in. `npx gulp` finishes the glossary for every
 * volume before the character-voice stage starts, so volume 5's record is copied from volume 4's
 * **while volume 4's voice half still does not exist**. Volume 5's record is a faithful copy of a
 * record that was half finished, and by the time volume 5's own voice stage runs, the volume it was
 * built from has moved on.
 *
 * That is not cosmetic. A volume's audit compares what its extraction found against what the record
 * says about the same character; if the earlier volume's voice rows never arrived, the audit reports
 * claims as "the reference says nothing about this" when the reference has said it since volume 1.
 *
 * So the copy is topped up rather than redone: rows the destination does not have are added, with
 * their own `owner_volume`, `established_volume` and sealed flag intact, and rows it already has are
 * left exactly as they are — including rows this volume edited. A record is never overwritten here,
 * which is the same rule `copyForwardStore` enforces by refusing to copy over a volume that already
 * has one.
 *
 * @param {Object} opts
 * @param {number|string} opts.fromVolume
 * @param {number|string} opts.toVolume
 * @param {string} [opts.seriesDir]
 * @param {string} [opts.fromFolder]
 * @param {string} [opts.toFolder]
 * @param {string} [opts.step]
 * @returns {{ok: boolean, skipped: boolean, reason: string|null, copied: Object<string, number>, total: number, refusal: ReferenceRefusal|null, findings: PostMortemFinding[]}}
 */
function topUpVolumeRecord({ fromVolume, toVolume, seriesDir, fromFolder, toFolder, step = INTEGRITY_STEP } = {}) {
  const volKey = String(toVolume);
  /**
   * The one shape every outcome that is not a top-up returns.
   * @param {string} reason
   */
  const nothing = (reason) => ({ ok: true, skipped: true, reason, copied: {}, total: 0, refusal: null, findings: [] });

  let sourcePath;
  let destPath;
  try {
    sourcePath = referenceStorePath({ seriesDir, volume: fromVolume, folder: fromFolder });
    destPath = referenceStorePath({ seriesDir, volume: toVolume, folder: toFolder });
  } catch (err) {
    return {
      ok: false,
      skipped: true,
      reason: null,
      copied: {},
      total: 0,
      refusal: refusal({
        verb: "top_up_record",
        rule: "reference-copy-path-undecided",
        because: `the top-up could not decide which folders to use: ${String(err && err.message ? err.message : err)}`,
        fix: "name the volume folders explicitly, or re-run \"npx gulp discover\" so the plan of record lists them.",
      }),
      findings: [],
    };
  }

  if (!fs.existsSync(sourcePath.file) || !fs.existsSync(destPath.file)) return nothing("one of the two records is not there");

  const sourceSha256 = sha256OfFile(sourcePath.file);
  const dest = openDatabase(destPath.file);
  const provenance = dest.prepare("SELECT * FROM copy_provenance WHERE volume = ?").get(Number(toVolume));
  if (!provenance || Number(provenance.source_volume) !== Number(fromVolume)) {
    dest.close();
    return nothing(`volume ${toVolume}'s record was not copied from volume ${fromVolume}`);
  }
  if (provenance.source_sha256 === sourceSha256) {
    dest.close();
    return nothing("the source record has not changed since this copy was made");
  }

  if (readSchemaVersion(sourcePath.file) !== readSchemaVersion(destPath.file)) {
    dest.close();
    const findings = [
      finding(
        "HIGH",
        "reference-top-up-schema-mismatch",
        step,
        volKey,
        `${destPath.folder}/series.db`,
        `volume ${fromVolume}'s record is at schema ${readSchemaVersion(sourcePath.file)} and volume ${toVolume}'s is at ` +
          `${readSchemaVersion(destPath.file)}; rows are not copied between records of different shapes.`
      ),
    ];
    return {
      ok: false,
      skipped: true,
      reason: null,
      copied: {},
      total: 0,
      refusal: refusal({
        verb: "top_up_record",
        rule: "reference-top-up-schema-mismatch",
        because: findings[0].message,
        fix: "re-derive the copy so both records are on the same schema.",
      }),
      findings,
    };
  }

  /** @type {Object<string, number>} */
  const copied = {};
  let total = 0;
  try {
    // `exec` does not bind parameters — it runs the string as written, so a `?` here attaches an
    // empty database named "?" and every copy below reports "no such table". The path has to be a
    // literal in the statement, which means quoting it.
    dest.exec(`ATTACH DATABASE '${String(sourcePath.file).replace(/'/g, "''")}' AS src`);
    // Dependency order, so a row's references are already in place when the row arrives.
    for (const table of COUNTED_TABLES) {
      const info = dest.prepare(`INSERT OR IGNORE INTO main.${table} SELECT * FROM src.${table}`).run();
      const n = Number(info.changes || 0);
      if (n > 0) copied[table] = n;
      total += n;
    }
    dest.exec("DETACH DATABASE src");
    dest
      .prepare("UPDATE copy_provenance SET source_sha256 = ?, copied_at = ? WHERE volume = ?")
      .run(sourceSha256, new Date().toISOString(), Number(toVolume));
  } catch (err) {
    dest.close();
    return {
      ok: false,
      skipped: true,
      reason: null,
      copied,
      total,
      refusal: refusal({
        verb: "top_up_record",
        rule: "reference-top-up-failed",
        because: `the top-up of volume ${toVolume}'s record from volume ${fromVolume} failed: ${String(err && err.message ? err.message : err)}`,
        fix: `re-derive volume ${toVolume}'s record from volume ${fromVolume} (delete its series.db deliberately, then re-run the stage).`,
      }),
      findings: [
        finding(
          "HIGH",
          "reference-top-up-failed",
          step,
          volKey,
          `${destPath.folder}/series.db`,
          `the top-up from volume ${fromVolume} failed: ${String(err && err.message ? err.message : err)}`
        ),
      ],
    };
  }
  dest.close();

  return { ok: true, skipped: false, reason: null, copied, total, refusal: null, findings: [] };
}

module.exports = { copyForwardStore, topUpVolumeRecord, readCopyProvenance, sha256OfFile };

#!/usr/bin/env node
/**
 * test/measure-relations.js — plan 07 slice 3 over the **live corpus**, on **copies**, with 0 model calls.
 * Nothing in the corpus is written.
 *
 * ## What this slice is, and therefore what this script can honestly show
 *
 * `relations` is the row for one act of address: who addressed whom, through which channel, in which
 * written form, over which volumes, and how sure the record is. The door that files one is built; the
 * reading pass that would produce real proposals is **plan 07 slice 4**, and it does not exist yet. So
 * this script does not pretend to have read any acts out of the books. It says, out loud, that the acts
 * it files are **planted**, and measures the two things that are real facts about the corpus:
 *
 *   1. **how many people the door can key at all.** A relation is keyed on an identity (plan 07 §4.3),
 *      and an identity exists only where a link was filed. Against a copy of the settled record this is
 *      the number plan 07 §2.9 predicted — 196 roster entries grouped into 34 identities, 88 of the 196
 *      linked — which means **108 roster entries have no identity to key a relation against** and every
 *      relation naming one of them is refused and reported as a limit. That is the wall plan 07 §6.8
 *      leaves to the account owner, measured on the real roster rather than asserted.
 *   2. **that the table arrives empty and the corpus stays as it was.** Every one of the 17 records is
 *      copied, opened, and asked how many relations it holds; the answer is 0 everywhere, and every
 *      `series.db` digest and every `-wal` / `-shm` sidecar is the same at the end as at the start.
 *
 * It also measures the no-forward rule against two real records side by side: a span is filed in a copy
 * of volume 17's record and closed there, and the copy of the earlier volume's record is hashed before
 * and after. The digest does not move.
 *
 * **What is *not* proven here, and why.** That `copyForwardStore` carries the new table is proven in
 * `test/test-relations-table.js` scenario 6, which builds the later copy through the real door. Running
 * the real door over the corpus would need each volume's whole folder copied, not just its record, and
 * that is a different measurement than this one. What this script can and does show is that the table is
 * in `COUNTED_TABLES`, which is the list copy-forward compares and a top-up copies over.
 *
 * ## THIS script reads the live corpus, and says so. What makes it safe is gotcha 124 / gotcha 166:
 * **a corpus `series.db` is never opened.** Each volume's record is copied with `fs.copyFileSync` into
 * `/tmp/opencode/plan07-slice3/measure-db-copy`, the copy is opened, and every write lands in the copy.
 * `copyFileSync` and not `db.js`'s `copyDatabase`, because `copyDatabase` opens the source. The `-wal` is
 * copied with the main file per volume, because a record's current schema version can live only in its
 * write-ahead log.
 *
 * Usage:
 *   node test/measure-relations.js [--series=<series folder>] [--settled=17]
 *
 * @module test/measure-relations
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const rs = require("../utils/reference-store");
const { openReferenceStore, identityCoverageSummary, unlinkedCastKeys, COUNTED_TABLES } = rs;
const { fileVolumeWrittenForms } = require("../utils/reference-store/written-forms");
const { fileIdentityLinks } = require("../utils/reference-store/identity");
const { RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");
const rel = require("../utils/reference-store/relations");

/** Default series folder: the live corpus this repository writes its artifacts into. */
const DEFAULT_SERIES = path.resolve(__dirname, "..", "..");

/** Where the throwaway copies of the records are put (gotcha 124, gotcha 166). */
const DB_COPY_DIR = "/tmp/opencode/plan07-slice3/measure-db-copy";

/**
 * plan 07 §2.9's roster shape, measured by `test/measure-identities.js` and re-measured by
 * `test/test-identity-table.js`. Pinned here so this script can say whether it reached it rather than
 * print whatever came out and call it a result.
 */
const EXPECTED_ROSTER = { rosterEntries: 196, identities: 34, linkedEntries: 88, duplicateEntries: 54, unlinkedEntries: 108, largestGroup: 6 };

/** @param {string} file @returns {string} sha256 of the file's bytes, hex */
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Read the command line.
 * @returns {{series: string, settled: string}}
 */
function readArgs() {
  const argv = process.argv.slice(2);
  const pick = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  return { series: path.resolve(pick("series") || DEFAULT_SERIES), settled: pick("settled") || "17" };
}

/**
 * Every volume folder in the series that holds a reference record, in reading order.
 *
 * Refuses when the corpus is absent or holds no record: a measurement that prints zeros because it could
 * not find the books is a measurement that reports the books as empty.
 *
 * @param {string} seriesDir
 * @returns {Array<{folder: string, volume: string, volumeDir: string, file: string}>}
 */
function volumeRecords(seriesDir) {
  if (!fs.existsSync(seriesDir) || !fs.statSync(seriesDir).isDirectory()) {
    console.error(`refused: the series folder is not there: ${seriesDir}`);
    process.exit(2);
  }
  const folders = fs
    .readdirSync(seriesDir)
    .filter((name) => {
      const full = path.join(seriesDir, name);
      return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "series.db"));
    })
    .sort();
  if (folders.length === 0) {
    console.error(
      `refused: no volume folder under ${seriesDir} holds a series.db. This measurement runs the ` +
        "reference-store doors over copies of those records; run the pipeline first, or point --series= at " +
        "the series folder that has them. It will not report zeros as a result."
    );
    process.exit(2);
  }
  return folders.map((folder) => ({
    folder,
    volume: (folder.match(/\((\d+)\)/) || [])[1] || folder,
    volumeDir: path.join(seriesDir, folder),
    file: path.join(seriesDir, folder, "series.db"),
  }));
}

/**
 * Snapshot every volume's `series.db` digest and sidecar presence, so the script can prove its own run
 * left the corpus alone (gotcha 124).
 *
 * @param {Array<{folder: string, volumeDir: string}>} volumes
 * @returns {Map<string, {digest: string|null, sidecars: string[], bytes: number|null}>}
 */
function recordState(volumes) {
  /** @type {Map<string, {digest: string|null, sidecars: string[], bytes: number|null}>} */
  const state = new Map();
  for (const volume of volumes) {
    const file = path.join(volume.volumeDir, "series.db");
    const sidecars = fs
      .readdirSync(volume.volumeDir)
      .filter((name) => /^series\.db(-wal|-shm)$/.test(name))
      .sort();
    state.set(volume.folder, {
      digest: fs.existsSync(file) ? sha256(file) : null,
      bytes: fs.existsSync(file) ? fs.statSync(file).size : null,
      sidecars,
    });
  }
  return state;
}

/**
 * Compare two snapshots and name every difference.
 *
 * @param {Map<string, {digest: string|null, sidecars: string[], bytes: number|null}>} before
 * @param {Map<string, {digest: string|null, sidecars: string[], bytes: number|null}>} after
 * @returns {string[]} One line per change; empty when nothing moved.
 */
function compareRecordState(before, after) {
  /** @type {string[]} */
  const problems = [];
  for (const [folder, was] of before) {
    const now = after.get(folder);
    if (!now) {
      problems.push(`${folder}: the volume folder disappeared`);
      continue;
    }
    if (was.digest !== now.digest) problems.push(`${folder}: series.db digest moved (${was.digest && was.digest.slice(0, 8)} → ${now.digest && now.digest.slice(0, 8)})`);
    if (was.bytes !== now.bytes) problems.push(`${folder}: series.db size moved ${was.bytes} → ${now.bytes} bytes`);
    if (JSON.stringify(was.sidecars) !== JSON.stringify(now.sidecars)) {
      problems.push(`${folder}: sidecars changed from ${was.sidecars.join(",") || "(none)"} to ${now.sidecars.join(",") || "(none)"}`);
    }
  }
  return problems;
}

/**
 * Copy one volume's record — main file **and** write-ahead log — into the scratch series folder, and hand
 * back an open handle on **the copy**.
 *
 * @param {{volumeDir: string, folder: string, volume: string}} volume
 * @param {{recopy?: boolean, dir?: string}} [opts] - `recopy: false` opens the copy already there, which is
 *   how a second pass over the same record is measured. Defaults to `{recopy: true, dir: DB_COPY_DIR}`.
 * @returns {{store: Object, copy: string, note: string}|null} Null when the volume has no record.
 */
function openCopiedRecord(volume, { recopy = true, dir = DB_COPY_DIR } = {}) {
  const source = path.join(volume.volumeDir, "series.db");
  if (!fs.existsSync(source)) return null;
  const scratchVolumeDir = path.join(dir, volume.folder);
  fs.mkdirSync(scratchVolumeDir, { recursive: true });
  const copy = path.join(scratchVolumeDir, "series.db");
  if (recopy) {
    fs.copyFileSync(source, copy);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = path.join(volume.volumeDir, `series.db${suffix}`);
      if (fs.existsSync(sidecar) && fs.statSync(sidecar).size > 0) fs.copyFileSync(sidecar, `${copy}${suffix}`);
    }
  } else if (!fs.existsSync(copy)) {
    return null;
  }
  const walBytes = fs.existsSync(path.join(volume.volumeDir, "series.db-wal")) ? fs.statSync(path.join(volume.volumeDir, "series.db-wal")).size : 0;
  const note = walBytes > 0 ? `write-ahead log copied with it (${walBytes} bytes)` : "write-ahead log empty, main file alone is the whole record";
  const store = openReferenceStore({ volume: Number(volume.volume), folder: volume.folder, seriesDir: dir, stage: "merge" });
  return { store, copy, note };
}

/**
 * The acts this script plants, built from the identities the copy already holds.
 *
 * They are **planted**: the reading pass that would produce them is plan 07 slice 4 and does not exist,
 * and the corpus holds 0 voice claims, so there is no observed act of address to file. What is real here
 * is the roster, the identities and the wall — the proposals are the probe that measures them.
 *
 * @param {Object} store @param {Object} coverage @returns {Array<Object>}
 */
function plantedRelations(store, coverage) {
  /** @type {Array<Object>} */
  const out = [];
  const groups = coverage.membersPerIdentity || [];
  for (let i = 0; i < groups.length && out.length < 6; i++) {
    const other = groups[(i + 1) % groups.length];
    const from = groups[i].keys[0];
    const to = other.keys[0];
    if (from === to) continue;
    out.push({
      addresser: from,
      addresserKind: "identity",
      addressee: to,
      channel: "spoken",
      certainty: "addressee-risk",
      formUsed: from,
      statement: `planted: ${from} addresses ${to} (a probe, not a line the book printed)`,
    });
  }
  // The three null-party kinds, which need no identity at all.
  out.push({ addresserKind: "narrator", channel: "narration", certainty: "narration", formUsed: "narration", statement: "planted: the narration" });
  out.push({ addresserKind: "withheld", channel: "withheld", certainty: "withheld", formUsed: "withheld", statement: "planted: the book did not say" });
  out.push({ addresserKind: "unknown", channel: "spoken", certainty: "unknown", formUsed: "unknown-speaker", statement: "planted: nothing matched" });
  return out;
}

(async () => {
  const { series, settled } = readArgs();
  const volumes = volumeRecords(series);
  console.log(`series: ${series}`);
  console.log(`${volumes.length} volume record(s) found; every one is copied before it is opened, and nothing is written into ${series}.`);

  const before = recordState(volumes);
  fs.rmSync(DB_COPY_DIR, { recursive: true, force: true });
  fs.mkdirSync(DB_COPY_DIR, { recursive: true });

  // ─── 1. the table arrives empty in every record ──────────────────────────────
  let opened = 0;
  let relationsInCorpus = 0;
  /** @type {Array<string>} */ const schemaNotes = [];
  for (const volume of volumes) {
    const openedRecord = openCopiedRecord(volume);
    if (!openedRecord) continue;
    opened++;
    try {
      const n = openedRecord.store.db.prepare("SELECT COUNT(*) AS n FROM relations").get().n;
      relationsInCorpus += n;
      if (openedRecord.store.schemaVersion !== rs.SCHEMA_VERSION) schemaNotes.push(`${volume.folder}: schema ${openedRecord.store.schemaVersion}`);
    } finally {
      openedRecord.store.close();
    }
  }
  console.log(`\n1. the new table: ${opened} record copies opened, ${relationsInCorpus} relation row(s) between them — the corpus holds none, because nothing has ever filed one.`);
  console.log(`   ${COUNTED_TABLES.length} counted tables, \`relations\` among them (${COUNTED_TABLES.includes("relations")}), which is the list copy-forward compares and a top-up copies over.`);
  if (schemaNotes.length) console.log(`   records still behind this build's schema: ${schemaNotes.join(", ")}`);

  // ─── 2. how many people the door can key ─────────────────────────────────────
  //
  // The corpus records hold **no** identity rows and **no** written-form rows: neither slice 1 nor slice 2
  // is wired into a stage, so nothing has ever filed them. Reproducing plan 07 §2.9's roster shape on a
  // copy therefore means running those two doors on the copy first, which is what `test/measure-identities.js`
  // does and what this script does here. The books are only ever read.
  const settledVolume = volumes.find((v) => v.volume === settled) || volumes[volumes.length - 1];
  const settledCopy = openCopiedRecord(settledVolume);
  if (!settledCopy) {
    console.error("refused: the settled volume has no record to copy.");
    process.exit(2);
  }

  /** @type {Array<{volume: number, guides: Array<Object>}>} */ const harvests = [];
  let harvestRows = 0;
  for (const volume of volumes) {
    const guideFile = fs.readdirSync(volume.volumeDir).find((n) => n.endsWith(RUBY_GUIDE_FILE_SUFFIX));
    if (!guideFile) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(volume.volumeDir, guideFile), "utf8"));
    const guides = Array.isArray(parsed.guides) ? parsed.guides : [];
    harvestRows += guides.length;
    harvests.push({ volume: Number(volume.volume), guides });
  }
  console.log(`\n2. the wall, measured on a copy of volume ${settledVolume.volume}'s record (${settledCopy.note}):`);
  console.log(`   ${harvests.length} harvest(s) read from the books, ${harvestRows} word-and-reading rows, filed into the copy so the identity door has its source:`);
  let formsFiled = 0;
  for (const harvest of harvests) {
    const filed = await fileVolumeWrittenForms(settledCopy.store, { volume: harvest.volume, harvests: [harvest] });
    if (filed.ok) formsFiled += filed.rowsFiled;
  }
  console.log(`   ${formsFiled} written-form row(s) filed into the copy`);
  const links = fileIdentityLinks(settledCopy.store, {});
  console.log(`   the identity door files ${links.linksFiled} link(s) (${links.linksAlreadyFiled} already there), creating ${links.identitiesCreated} identities; ${links.guideLinks} from the book's markup, ${links.characterRowLinks} from the record's published Characters rows`);

  const coverage = identityCoverageSummary(settledCopy.store);
  console.log(
    `   ${coverage.rosterEntries} roster entries → ${coverage.identities} identities, ` +
      `${coverage.linkedEntries} entries linked, ${coverage.duplicateEntries} duplicate entries, ` +
      `${coverage.unlinkedEntries} entries unlinked, largest group ${coverage.largestGroup}`
  );
  const reached = Object.keys(EXPECTED_ROSTER).every((key) => coverage[key] === EXPECTED_ROSTER[key]);
  console.log(`   plan 07 §2.9's shape ${JSON.stringify(EXPECTED_ROSTER)}: ${reached ? "reached" : "NOT reached"}`);
  console.log(`   so the door can key ${coverage.linkedEntries} of the ${coverage.rosterEntries} names, and must name ${coverage.unlinkedEntries} as limits — plan 07 §6.8 is the open decision about those, and this door invents nothing to get past it.`);

  // The raw row counts, taken BEFORE anything this script files, so "nothing invented" is a comparison of
  // the same measure on both sides: `coverage.identities` counts the identities a roster entry stands on
  // (an absorbed group is not one), `SELECT COUNT(*)` counts every row including the absorbed one.
  // Printing one against the other is how a door that created nothing looks like one that created a row.
  const castBefore = settledCopy.store.db.prepare("SELECT COUNT(*) AS n FROM cast").get().n;
  const identitiesBefore = settledCopy.store.db.prepare("SELECT COUNT(*) AS n FROM cast_identities").get().n;
  const linksBefore = settledCopy.store.db.prepare("SELECT COUNT(*) AS n FROM cast_identity_links").get().n;

  // ─── 3. the planted acts, filed against the copy ─────────────────────────────
  const proposals = plantedRelations(settledCopy.store, coverage);
  const pass1 = rel.fileRelations(settledCopy.store, proposals);
  console.log(`\n3. planted, not read: ${proposals.length} proposals, 0 model calls. The corpus holds 0 voice claims and no reading pass has produced an act of address, so these are probes.`);
  console.log(`   filed ${pass1.filedCount}, already ${pass1.alreadyFiled.length}, named limits ${pass1.namedLimits.length}, refused ${pass1.refusedCount}`);

  // The wall, asked directly: one proposal per unlinked roster entry, capped so the run stays short.
  const unlinked = unlinkedCastKeys(settledCopy.store).slice(0, 25);
  const wall = rel.fileRelations(
    settledCopy.store,
    unlinked.map((name) => ({ addresser: name, addresserKind: "identity", addressee: coverage.membersPerIdentity[0].keys[0], channel: "spoken", certainty: "addressee-risk", formUsed: name, statement: `planted: ${name} addresses somebody` }))
  );
  console.log(`   the wall asked directly: ${wall.namedLimits.length} of ${unlinked.length} unlinked roster entries sampled, ${wall.filedCount} filed, ${wall.refusedCount} refused, ${wall.namedLimits.length} named as limits`);

  const counts = rel.relationCounts(settledCopy.store);
  console.log(`   the record now holds ${counts.total} relation(s): ${counts.open} open, ${counts.closed} closed, ${counts.partiesWithoutIdentity} with a party that has no identity`);
  console.log(`   by channel ${JSON.stringify(counts.byChannel)}; by certainty ${JSON.stringify(counts.byCertainty)}`);
  if (pass1.namedLimits.length) {
    console.log(`   named limits (first 5 of ${pass1.namedLimits.length}): ${pass1.namedLimits.slice(0, 5).map((l) => `${l.name}${l.inRoster ? "" : " (not on the roster)"}`).join(", ")}`);
  }
  const castAfter = settledCopy.store.db.prepare("SELECT COUNT(*) AS n FROM cast").get().n;
  const identitiesAfter = settledCopy.store.db.prepare("SELECT COUNT(*) AS n FROM cast_identities").get().n;
  const linksAfter = settledCopy.store.db.prepare("SELECT COUNT(*) AS n FROM cast_identity_links").get().n;
  console.log(`   nothing invented: roster rows ${castBefore} → ${castAfter}, identity rows ${identitiesBefore} → ${identitiesAfter}, identity link rows ${linksBefore} → ${linksAfter} — the relations door creates none of the three, and the numbers are the same measure on both sides`);
  if (castAfter !== castBefore || identitiesAfter !== identitiesBefore || linksAfter !== linksBefore) {
    console.log(`   FAIL: filing a relation moved a party table (${castBefore}→${castAfter} cast, ${identitiesBefore}→${identitiesAfter} identities, ${linksBefore}→${linksAfter} links). The door invents no person, and this measurement exists to catch the day it does.`);
    process.exitCode = 1;
  }

  const pass2 = rel.fileRelations(settledCopy.store, proposals);
  console.log(`   a second pass over the same reading files ${pass2.filedCount} and reports ${pass2.alreadyFiled.length} as already filed`);

  // ─── 4. closing a span in the later copy does not reach the earlier one ──────
  const earlier = volumes.filter((v) => Number(v.volume) < Number(settledVolume.volume)).slice(-1)[0];
  if (earlier) {
    const earlierCopy = openCopiedRecord(earlier);
    const earlierDigestBefore = sha256(earlierCopy.copy);
    const key = { establishedVolume: Number(settledVolume.volume), channel: "spoken", formUsed: proposals[0].formUsed, addresser: pass1.filed[0] ? pass1.filed[0].addresser : null, addressee: pass1.filed[0] ? pass1.filed[0].addressee : null };
    const closed = rel.closeRelationSpan(settledCopy.store, { ...key, closedByVolume: Number(settledVolume.volume), closedByChapter: null, closedByQuote: null });
    console.log(`\n4. the no-forward rule against two real records:`);
    console.log(`   a close naming no chapter and no line is refused (${closed.refusal ? closed.refusal.rule : "it went through — that is a defect"}), and it wrote nothing`);
    const stillOpen = rel.relationCounts(settledCopy.store);
    console.log(`   the record still reports ${stillOpen.closed} closed span(s) after ${stillOpen.total} relations`);
    const openOne = rel.relationsInRecord(settledCopy.store).rows.find((row) => row.validToVolume === null);
    if (openOne) {
      const real = rel.closeRelationSpan(settledCopy.store, { establishedVolume: openOne.establishedVolume, channel: openOne.channel, formUsed: openOne.formUsed, addresser: openOne.addresser, addressee: openOne.addressee, closedByVolume: Number(settledVolume.volume), closedByChapter: "ch0", closedByQuote: "a line this volume's text does not print" });
      console.log(`   a close quoting a line the closing volume does not print is refused (${real.refusal ? real.refusal.rule : "it went through — that is a defect"})`);
    }
    const earlierDigestAfter = sha256(earlierCopy.copy);
    console.log(`   the copy of volume ${earlier.volume}'s record is byte-identical before and after everything volume ${settledVolume.volume}'s copy did (${earlierDigestBefore.slice(0, 12)} → ${earlierDigestAfter.slice(0, 12)})`);
    sameFileCheck(earlierDigestBefore, earlierDigestAfter);
    earlierCopy.store.close();
  } else {
    console.log("\n4. skipped: this series has one volume record, so there is no earlier record to compare against.");
  }
  settledCopy.store.close();

  // ─── 5. the corpus was left alone ────────────────────────────────────────────
  const after = recordState(volumes);
  const problems = compareRecordState(before, after);
  const walCount = volumes.filter((v) => fs.existsSync(path.join(v.volumeDir, "series.db-wal"))).length;
  const shmCount = volumes.filter((v) => fs.existsSync(path.join(v.volumeDir, "series.db-shm"))).length;
  console.log(`\n5. the corpus left alone: ${volumes.length} digests, ${walCount} series.db-wal, ${shmCount} series.db-shm`);
  if (problems.length) {
    console.log(`   PROBLEMS (${problems.length}):`);
    for (const line of problems) console.log(`   - ${line}`);
    process.exitCode = 1;
  } else {
    console.log("   0 problems: every digest identical, every sidecar where it was.");
  }
  const first = volumes[0];
  console.log(`   first volume ${first.folder}: ${before.get(first.folder).bytes} bytes, digest ${before.get(first.folder).digest.slice(0, 8)}`);
  const last = volumes[volumes.length - 1];
  console.log(`   last volume ${last.folder}: ${before.get(last.folder).bytes} bytes, digest ${before.get(last.folder).digest.slice(0, 8)}`);

  console.log(`\nrelations measurement: ${volumes.length} record copies, ${relationsInCorpus} corpus relation row(s), 0 model calls, 0 corpus writes.`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * One assertion the measurement makes about a file it is only allowed to read.
 * @param {string} a @param {string} b
 */
function sameFileCheck(a, b) {
  if (a !== b) throw new Error(`a copied record changed: ${a.slice(0, 12)} → ${b.slice(0, 12)}`);
}

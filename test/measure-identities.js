#!/usr/bin/env node
/**
 * test/measure-identities.js — plan 07 slice 2: run the identity door over the **live corpus** on
 * **copies** of the 17 records, and print what changed when its guide half stopped reading the volume
 * folder and started reading the record. Zero model calls. Nothing in the corpus is written.
 *
 * ## What this slice changed, and therefore what this script has to show
 *
 * The guide half of `fileIdentityLinks` used to open the volume folder and read
 * `<base>-ruby-guides.json`, and it filed a pair when **both** the annotated word and the guided reading
 * were roster entries. It now groups the record's own written-form rows through the shipped read
 * (`candidateGroupsInRecord`) and keeps only the groups plan 07 §2.9 selects — *one of the group's written
 * forms is a roster entry, **or the guided reading itself is*** — measured at 18 of the 97 candidate groups
 * with zero false positives. So the script prints, side by side:
 *
 *   - the **old rule**, recomputed from the harvests themselves, so the difference is a number and not a
 *     description;
 *   - the **new rule**, run through the door, per volume and once over a cumulative record;
 *   - the groups §2.9 selects that the door **cannot** file, because `cast_identity_links.a` / `.b` are
 *     foreign keys to `cast(key)` and those groups hold exactly one published name.
 *
 * ## THIS script reads the live corpus, and says so. What makes it safe is gotcha 124 / gotcha 166:
 * **a corpus `series.db` is never opened.** Each volume's record is copied with `fs.copyFileSync` into
 * `/tmp/opencode/plan07-slice2/measure-db-copy`, the copy is opened, and the door writes into the copy.
 * `copyFileSync` and not `db.js`'s `copyDatabase`, because `copyDatabase` opens the source.
 *
 * The script hashes every volume's `series.db` and lists its `-wal` / `-shm` sidecars before its own run and
 * again after it, and fails if any digest moved or any sidecar appeared or disappeared.
 *
 * What it prints, in order:
 *   1. the harvest baseline;
 *   2. the OLD rule recomputed from the harvests (pairs, entries, per-volume statements);
 *   3. the door, one volume at a time, on a copy of that volume's record, plus a second pass that must file 0;
 *   4. the door once over a **cumulative** record — volume 17's copy holding every volume's written forms —
 *      with the 18 selected groups printed, each one marked filed or named-as-a-limit;
 *   5. the roster shape that comes out (plan 06 §8's "35 groups instead of 196 names" prediction, re-measured);
 *   6. the near misses the small-kana fold names, including the one the missing ェ → エ entry hid;
 *   7. the corpus-left-alone proof.
 *
 * It files nothing in the corpus, declares nothing, and calls no model. `npm test` does not run it: it
 * depends on books that are not in this repository (AGENTS.md rule 8), and `test/test-identity-table.js` is
 * the fixture that carries its rules.
 *
 * Usage:
 *   node test/measure-identities.js [--series=<series folder>] [--roster-volume=17] [--limit=N]
 *
 * @module test/measure-identities
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { collectGuideGroups } = require("../utils/source/guide-groups");
const { RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");
const rs = require("../utils/reference-store");
const {
  openReferenceStore,
  fileVolumeWrittenForms,
  writtenFormCounts,
  candidateGroupsInRecord,
  rosterKeysInRecord,
  splitGroupsByRoster,
  guideNamesInGroup,
  guideLinksFromGroups,
  guideNearMisses,
  foldSmallKana,
} = rs;

/** Default series folder: the live corpus this repository writes its artifacts into. */
const DEFAULT_SERIES = path.resolve(__dirname, "..", "..");

/** Where the throwaway copies of the records are put (gotcha 124, gotcha 166). */
const DB_COPY_DIR = "/tmp/opencode/plan07-slice2/measure-db-copy";

/**
 * plan 07 §2.9's numbers, and plan 06 §8 slice 1b's prediction. Pinned here so the script can say whether
 * it reached them rather than print whatever came out and call it a result.
 */
const EXPECTED = {
  harvestRows: 10005,
  harvestOccurrences: 45429,
  candidateGroups: 97,
  identityBearingGroups: 18,
  identityBearingRows: 134,
  identityBearingOccurrences: 1402,
  // plan 06 §2.11's measurement of the OLD rule: pairs where BOTH sides were already roster names.
  oldRulePairs: 13,
  oldRuleEntries: 24,
  // plan 06 §8 slice 1b's prediction for the roster shape, measured with the prose half included.
  rosterEntries: 196,
};

/**
 * sha256 of a file, hex.
 *
 * @param {string} file
 * @returns {string}
 */
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Read the command line.
 *
 * @returns {{series: string, rosterVolume: string, limit: number|null}}
 */
function readArgs() {
  const argv = process.argv.slice(2);
  const pick = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const limit = pick("limit");
  return {
    series: path.resolve(pick("series") || DEFAULT_SERIES),
    rosterVolume: pick("roster-volume") || "17",
    limit: limit === null ? null : Number(limit),
  };
}

/**
 * Every volume folder in the series that holds a pronunciation-guide harvest, in reading order.
 *
 * Refuses when the corpus is absent or holds no harvest: a measurement that prints zeros because it could
 * not find the books is a measurement that reports the books as empty.
 *
 * @param {string} seriesDir
 * @returns {Array<{folder: string, volume: string, volumeDir: string, base: string, guideFile: string}>}
 */
function volumeHarvests(seriesDir) {
  if (!fs.existsSync(seriesDir) || !fs.statSync(seriesDir).isDirectory()) {
    console.error(`refused: the series folder is not there: ${seriesDir}`);
    process.exit(2);
  }
  const folders = fs
    .readdirSync(seriesDir)
    .filter((name) => {
      const full = path.join(seriesDir, name);
      return fs.statSync(full).isDirectory() && fs.readdirSync(full).some((n) => n.endsWith(RUBY_GUIDE_FILE_SUFFIX));
    })
    .sort();
  if (folders.length === 0) {
    console.error(
      `refused: no volume folder under ${seriesDir} holds a ${RUBY_GUIDE_FILE_SUFFIX} file. ` +
        "This measurement files what the extraction harvested; run `npx gulp extract` first, or point " +
        "--series= at the series folder that has one. It will not report zeros as a result."
    );
    process.exit(2);
  }
  return folders.map((folder) => {
    const volumeDir = path.join(seriesDir, folder);
    const guideFile = fs.readdirSync(volumeDir).find((n) => n.endsWith(RUBY_GUIDE_FILE_SUFFIX));
    return {
      folder,
      volume: (folder.match(/\((\d+)\)/) || [])[1] || folder,
      volumeDir,
      base: guideFile.slice(0, -RUBY_GUIDE_FILE_SUFFIX.length),
      guideFile,
    };
  });
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
 * Copy one volume's record into the scratch series folder and hand back an open handle on **the copy**.
 *
 * @param {{volumeDir: string, folder: string, volume: string}} volume
 * @param {{recopy?: boolean, dir?: string}} [opts] - `recopy: false` opens the copy already there, which is
 *   how a second pass over the same record is measured. `dir` picks the scratch folder, so a read that has
 *   to see the corpus as it is cannot be reading what this script wrote. Defaults to `{recopy: true, dir: DB_COPY_DIR}`.
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
  const walBytes = fs.existsSync(path.join(volume.volumeDir, "series.db-wal"))
    ? fs.statSync(path.join(volume.volumeDir, "series.db-wal")).size
    : 0;
  const note = walBytes > 0 ? `write-ahead log copied with it (${walBytes} bytes)` : "write-ahead log empty, main file alone is the whole record";
  const store = openReferenceStore({ volume: Number(volume.volume), folder: volume.folder, seriesDir: dir, stage: "merge" });
  return { store, copy, note };
}

/**
 * The OLD rule, recomputed straight from the harvests: a guide row stated a link when **both** the annotated
 * word and the guided reading were roster entries. Kept here as a comparator, not as code the store runs.
 *
 * @param {Array<{volume: number, guides: Array<Object>}>} harvests
 * @param {Set<string>} roster
 * @returns {{pairs: Map<string, {a: string, b: string, annotations: number, volumes: Set<number>}>, statementsPerVolume: number, entries: Set<string>, rows: number}}
 */
function oldRule(harvests, roster) {
  /** @type {Map<string, {a: string, b: string, annotations: number, volumes: Set<number>}>} */
  const pairs = new Map();
  let statementsPerVolume = 0;
  let rows = 0;
  for (const harvest of harvests) {
    /** @type {Set<string>} */
    const seenHere = new Set();
    for (const guide of harvest.guides) {
      rows++;
      const word = String(guide.word || "").trim();
      const reading = String(guide.reading || "").trim();
      if (!word || !reading || word === reading) continue;
      if (!roster.has(word) || !roster.has(reading)) continue;
      const [a, b] = [word, reading].sort();
      const id = `${a} ${b}`;
      seenHere.add(id);
      if (!pairs.has(id)) pairs.set(id, { a, b, annotations: 0, volumes: new Set() });
      const pair = pairs.get(id);
      pair.annotations += Number(guide.count || 0);
      pair.volumes.add(harvest.volume);
    }
    statementsPerVolume += seenHere.size;
  }
  /** @type {Set<string>} */
  const entries = new Set();
  for (const pair of pairs.values()) {
    entries.add(pair.a);
    entries.add(pair.b);
  }
  return { pairs, statementsPerVolume, entries, rows };
}

/**
 * Run the whole measurement.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = readArgs();
  const allVolumes = volumeHarvests(args.series);
  const before = recordState(allVolumes);
  const volumes = args.limit ? allVolumes.slice(0, args.limit) : allVolumes;

  fs.rmSync(DB_COPY_DIR, { recursive: true, force: true });

  /** @type {string[]} */
  const problems = [];

  console.log("# plan 07 slice 2 — the identity door reads the RECORD, measured on the live corpus");
  console.log(`series: ${args.series}`);
  console.log(`volumes with a harvest: ${volumes.length}`);
  console.log("guide rule: the record's written-form rows, grouped by `candidateGroupsInRecord`, kept by plan 07 §2.9's roster-or-reading rule.");
  console.log(`model calls: 0. Writes to the corpus: none. Records opened: copies under ${DB_COPY_DIR}.\n`);

  // ── 1. the harvest baseline ────────────────────────────────────────────────────────────────────
  /** @type {Array<{volume: number, folder: string, guides: Array<Object>}>} */
  const harvests = volumes.map((volume) => ({
    volume: Number(volume.volume),
    folder: volume.folder,
    guides: JSON.parse(fs.readFileSync(path.join(volume.volumeDir, volume.guideFile), "utf8")).guides,
  }));
  const allRows = harvests.flatMap((harvest) => harvest.guides);
  console.log("## 1. the harvest baseline");
  console.log(`  distinct word-and-reading rows: ${allRows.length}`);
  console.log(`  total occurrences: ${allRows.reduce((sum, row) => sum + (row.count || 0), 0)}`);
  const wholeSeries = collectGuideGroups(harvests, { displaySubset: false });
  console.log(`  candidate groups over the whole series: ${wholeSeries.totals.candidateGroups} / ${wholeSeries.totals.candidateForms} written forms / ${wholeSeries.totals.candidateRows} rows / ${wholeSeries.totals.candidateOccurrences} occurrences\n`);

  // ── 2. the OLD rule, recomputed, against the roster a copy of the last record holds ────────────
  const rosterHolder = volumes.find((volume) => String(Number(volume.volume)) === String(Number(args.rosterVolume))) || volumes[volumes.length - 1];
  const openedRoster = openCopiedRecord(rosterHolder);
  if (!openedRoster) {
    console.log(`## 2. volume ${rosterHolder.volume} has no series.db: the roster question is not asked, and the old rule is not recomputed.\n`);
  } else {
    let roster;
    try {
      roster = rosterKeysInRecord(openedRoster.store);
    } finally {
      openedRoster.store.close();
    }
    const old = oldRule(harvests, roster);
    console.log(`## 2. the OLD rule, recomputed from the harvests against a COPY of volume ${rosterHolder.volume}'s roster (${roster.size} entries)`);
    console.log(`  a row stated a link only when BOTH the annotated word and the reading were roster entries.`);
    console.log(`  distinct pairs: ${old.pairs.size}   roster entries they touch: ${old.entries.size}   per-volume statements summed: ${old.statementsPerVolume}`);
    if (args.limit === null) {
      if (old.pairs.size !== EXPECTED.oldRulePairs) problems.push(`old-rule pairs: recomputed ${old.pairs.size}, plan 06 §2.11 states ${EXPECTED.oldRulePairs}`);
      if (old.entries.size !== EXPECTED.oldRuleEntries) problems.push(`old-rule entries: recomputed ${old.entries.size}, plan 06 §2.11 states ${EXPECTED.oldRuleEntries}`);
    }
    console.log("  --- the pairs the old rule filed:");
    for (const pair of old.pairs.values()) {
      console.log(`      ${pair.a} / ${pair.b}   ${pair.annotations} annotation(s), volumes ${[...pair.volumes].sort((x, y) => x - y).join(", ")}`);
    }
    console.log();
  }

  // ── 3. the door, one volume at a time, on a copy of that volume's record ───────────────────────
  console.log("## 3. the door per volume (each on a copy of that volume's record, its own written forms filed first)");
  console.log("  vol  forms-filed  groups  id-bearing  unselected  GUIDE LINKS  names-linked  unlinked-groups  near-miss  prose-rows  prose-links  identities  already  merges");
  /** @type {Array<{volume: number, pass: Object, door: Object, rosterSize: number}>} */
  const runs = [];
  for (const volume of volumes) {
    const opened = openCopiedRecord(volume);
    if (!opened) {
      console.log(`  ${volume.volume.padStart(4)}  (no series.db in this volume folder — nothing filed, named rather than guessed at)`);
      continue;
    }
    try {
      const harvest = harvests.find((entry) => entry.folder === volume.folder);
      const pass = await fileVolumeWrittenForms(opened.store, { harvests: [{ volume: Number(volume.volume), guides: harvest.guides }] });
      if (!pass.ok) {
        console.log(`  ${volume.volume.padStart(4)}  WRITTEN FORMS REFUSED: ${pass.refusal.rule} — ${pass.refusal.because}`);
        continue;
      }
      const door = opened.store.fileIdentityLinks();
      if (!door.ok) {
        console.log(`  ${volume.volume.padStart(4)}  IDENTITY DOOR REFUSED: ${door.refusal.rule} — ${door.refusal.because}`);
        continue;
      }
      const merges = opened.store.db.prepare("SELECT COUNT(*) n FROM cast_merges").get().n;
      if (merges !== 0) problems.push(`volume ${volume.volume}: the identity door wrote ${merges} cast_merges row(s)`);
      console.log(
        `  ${volume.volume.padStart(4)}  ${String(pass.rowsFiled).padStart(11)}  ${String(door.guideCandidateGroups).padStart(6)}  ` +
          `${String(door.guideIdentityBearingGroups).padStart(10)}  ${String(door.guideUnselectedGroups).padStart(10)}  ` +
          `${String(door.guideLinks).padStart(11)}  ${String(door.guideNamesLinked).padStart(13)}  ` +
          `${String(door.guideUnlinkedGroups.length).padStart(15)}  ${String(door.guideNearMisses.length).padStart(8)}  ` +
          `${String(door.characterRows).padStart(10)}  ${String(door.characterRowLinks).padStart(11)}  ` +
          `${String(door.identitiesCreated).padStart(10)}  ${String(door.linksAlreadyFiled).padStart(7)}  ${String(merges).padStart(7)}`
      );
      runs.push({ volume: Number(volume.volume), pass, door, rosterSize: rosterKeysInRecord(opened.store).size });
    } finally {
      opened.store.close();
    }
  }
  const sumOf = (fn) => runs.reduce((sum, entry) => sum + fn(entry), 0);
  const cell = (fn, width) => String(sumOf(fn)).padStart(width);
  console.log(
    `  TOTAL  ${cell((r) => r.pass.rowsFiled, 11)}  ${cell((r) => r.door.guideCandidateGroups, 6)}  ` +
      `${cell((r) => r.door.guideIdentityBearingGroups, 10)}  ${cell((r) => r.door.guideUnselectedGroups, 10)}  ` +
      `${cell((r) => r.door.guideLinks, 11)}  ${cell((r) => r.door.guideNamesLinked, 13)}  ` +
      `${cell((r) => r.door.guideUnlinkedGroups.length, 15)}  ${cell((r) => r.door.guideNearMisses.length, 8)}  ` +
      `${cell((r) => r.door.characterRows, 10)}  ${cell((r) => r.door.characterRowLinks, 11)}  ` +
      `${cell((r) => r.door.identitiesCreated, 10)}  ${cell((r) => r.door.linksAlreadyFiled, 7)}`
  );
  console.log(`  (the per-volume totals ADD, they do not UNION: a reading that spans four books is counted in each of the four records that carry it.)`);

  // A second pass over the SAME copy, so the idempotence claim is measured on the corpus, not on a fixture.
  if (runs.length) {
    const last = volumes[volumes.length - 1];
    const again = openCopiedRecord(last, { recopy: false });
    if (again) {
      try {
        const second = again.store.fileIdentityLinks();
        console.log(`  second pass over volume ${last.volume}: ${second.linksFiled} link(s) filed, ${second.linksAlreadyFiled} already filed (the key is the rule)`);
        if (second.linksFiled !== 0) problems.push(`second pass over volume ${last.volume} filed ${second.linksFiled} link(s); the door is supposed to file 0`);
        console.log();
      } finally {
        again.store.close();
      }
    }
  }

  // ── 4. the door once over a CUMULATIVE record ──────────────────────────────────────────────────
  const target = volumes.find((volume) => String(Number(volume.volume)) === String(Number(args.rosterVolume))) || volumes[volumes.length - 1];
  const openedTarget = openCopiedRecord(target);
  if (!openedTarget) {
    console.log(`## 4. volume ${target.volume} has no series.db: the cumulative question is not asked.\n`);
  } else {
    try {
      for (const entry of harvests) {
        if (Number(entry.volume) === Number(target.volume)) continue;
        const carried = await fileVolumeWrittenForms(openedTarget.store, { volume: Number(entry.volume), harvests: [{ volume: Number(entry.volume), guides: entry.guides }] });
        if (!carried.ok) problems.push(`volume ${entry.volume}'s rows could not be carried into volume ${target.volume}'s copy: ${carried.refusal && carried.refusal.rule}`);
      }
      const ownHarvest = harvests.find((h) => Number(h.volume) === Number(target.volume));
      await fileVolumeWrittenForms(openedTarget.store, { harvests: [{ volume: Number(target.volume), guides: ownHarvest.guides }] });

      const counts = writtenFormCounts(openedTarget.store);
      const built = candidateGroupsInRecord(openedTarget.store);
      const roster = rosterKeysInRecord(openedTarget.store);
      const split = splitGroupsByRoster(built.groups, roster);
      const guide = guideLinksFromGroups(split.identityBearing, roster);
      const misses = guideNearMisses(built.groups, roster);

      console.log(`## 4. the door over a CUMULATIVE record (volume ${target.volume}'s copy, holding every volume's written forms the way copy-forward carries them)`);
      console.log(`  written-form rows in that record: ${counts.total} (${counts.distinctForms} distinct forms, ${counts.distinctReadings} distinct readings, ${counts.occurrences} occurrences)`);
      console.log(`  candidate groups: ${built.totals.candidateGroups} / ${built.totals.candidateForms} forms / ${built.totals.candidateRows} rows / ${built.totals.candidateOccurrences} occurrences`);
      console.log(`  roster entries in that record: ${roster.size}`);
      console.log(`  §2.9 selects: ${split.totals.identityBearing} groups / ${split.totals.identityBearingRows} rows / ${split.totals.identityBearingOccurrences} occurrences; leaves out ${split.totals.unselected}`);
      if (args.limit === null) {
        if (built.totals.candidateGroups !== EXPECTED.candidateGroups) problems.push(`candidate groups in the cumulative record: measured ${built.totals.candidateGroups}, plan 07 §2.2 states ${EXPECTED.candidateGroups}`);
        if (split.totals.identityBearing !== EXPECTED.identityBearingGroups) problems.push(`identity-bearing groups: measured ${split.totals.identityBearing}, plan 07 §2.9 states ${EXPECTED.identityBearingGroups}`);
        if (split.totals.identityBearingRows !== EXPECTED.identityBearingRows) problems.push(`identity-bearing rows: measured ${split.totals.identityBearingRows}, plan 07 §2.9 states ${EXPECTED.identityBearingRows}`);
        if (split.totals.identityBearingOccurrences !== EXPECTED.identityBearingOccurrences) problems.push(`identity-bearing occurrences: measured ${split.totals.identityBearingOccurrences}, plan 07 §2.9 states ${EXPECTED.identityBearingOccurrences}`);
        if (roster.size !== EXPECTED.rosterEntries) problems.push(`roster entries: measured ${roster.size}, plan 06 §2.11 states ${EXPECTED.rosterEntries}`);
      }

      console.log("  --- every selected group, and what the door can do with it (a * marks a name the roster publishes):");
      for (const group of split.identityBearing) {
        const names = guideNamesInGroup(group, roster);
        const marked = names.map((n) => `${n.name}${n.via === "reading" ? "†" : ""}`).join(" + ") || "(none)";
        const unlinked = guide.unlinkedGroups.find((u) => u.reading === group.reading);
        console.log(
          `      ${group.reading}  ←  ${group.forms.map((f) => `${f.form}${roster.has(f.form) ? "*" : ""} x${f.count}`).join(", ")}` +
            `   [${group.volumes.join(", ")}, ${group.occurrences} occ]  published names: ${marked}  ->  ${unlinked ? "NAMED AS A LIMIT (1 name)" : `${names.length - 1} link(s)`}`
        );
      }
      console.log(`  groups §2.9 selects that hold exactly ONE published name: ${guide.unlinkedGroups.length} — ${guide.unlinkedGroups.map((u) => `${u.reading} (${u.rosterName})`).join(", ")}`);
      console.log(`  groups §2.9 selects that can file a link: ${split.totals.identityBearing - guide.unlinkedGroups.length}, stating ${guide.links.length} pair(s) over ${guide.namesLinked} name(s)`);
      const byReadingOnly = split.identityBearing.filter((group) => !group.forms.some((form) => roster.has(form.form)));
      console.log(`  selected ONLY because the guided reading is itself a roster entry: ${byReadingOnly.length} — ${byReadingOnly.map((g) => g.reading).join(", ")}`);

      const door = openedTarget.store.fileIdentityLinks();
      // Statements and rows are different numbers, and the difference is the point: the two halves state
      // `guideLinks + characterRowLinks` pairs, and the door's own key — (a, b, stated_by, stated_by_volume) —
      // absorbs the ones this record already carries from the volumes copy-forward brought with it.
      console.log(
        `\n  the door's own pass over that record: ${door.linksFiled} link row(s) filed from ` +
          `${door.guideLinks + door.characterRowLinks} stated pair(s) ` +
          `(${door.guideLinks} from the record's written forms, ${door.characterRowLinks} from published Characters rows, ` +
          `${door.linksAlreadyFiled} already filed under the same key), ` +
          `${door.identitiesCreated} identities created, ${door.identitiesAbsorbed} absorbed`
      );
      console.log(`  pairs the door NAMES and files nothing for (one written form guided into another roster name — not a candidate group, so §2.9 has nothing to select): ${door.guideSoloPairs.length}`);
      for (const pair of door.guideSoloPairs) {
        console.log(`      ${pair.a} / ${pair.b}   guided ${pair.reading}, volumes ${pair.volumes.join(", ")}, ${pair.occurrences} occurrence(s)`);
      }

      // ── 4b. the guide pairs, old rule against new ──────────────────────────────────────────────
      if (openedRoster) {
        const newPairs = new Map();
        for (const link of guide.links) newPairs.set([link.a, link.b].sort().join(" / "), link.reading);
        const oldPairs = new Map();
        for (const pair of oldRule(harvests, roster).pairs.values()) oldPairs.set([pair.a, pair.b].sort().join(" / "), `${pair.annotations} annotation(s)`);
        const kept = [...newPairs.keys()].filter((k) => oldPairs.has(k));
        const dropped = [...oldPairs.keys()].filter((k) => !newPairs.has(k));
        const added = [...newPairs.keys()].filter((k) => !oldPairs.has(k));
        console.log("\n  ## 4b. the guide pairs: the OLD rule (both sides already roster names) against §2.9's rule");
        console.log(`  old: ${oldPairs.size} pairs   new: ${newPairs.size} pairs   kept: ${kept.length}`);
        console.log(`  the old rule's pairs the new rule DROPS (${dropped.length}) — each is ONE written form annotated with a reading that happens to be another roster name, so it is not a group of two forms and the grouping guards never see it:`);
        for (const pair of dropped) console.log(`      ${pair}   (${oldPairs.get(pair)})`);
        console.log(`  the pairs only §2.9's rule finds (${added.length}) — a roster FORM plus another name under the same guided reading, or the reading itself:`);
        for (const pair of added) console.log(`      ${pair}   (under ${newPairs.get(pair)})`);
      }

      // ── 5. the roster shape that comes out ─────────────────────────────────────────────────────
      const summary = openedTarget.store.identityCoverageSummary();
      console.log(`\n## 5. the roster shape (plan 06 §8 slice 1b predicted 35 identities / 91 members / 56 duplicates / 105 unlinked / largest group 6)`);
      console.log(`  roster entries: ${summary.rosterEntries}`);
      console.log(`  identities: ${summary.identities}   groups of 2+: ${summary.groupsOfTwoOrMore}   linked entries: ${summary.linkedEntries}   duplicates: ${summary.duplicateEntries}   unlinked: ${summary.unlinkedEntries}   largest group: ${summary.largestGroup}`);
      console.log(`  the largest groups: ${summary.membersPerIdentity.slice(0, 6).map((g) => `${g.members} [${g.keys.join(", ")}]`).join("  |  ")}`);
      const merges = openedTarget.store.db.prepare("SELECT COUNT(*) n FROM cast_merges").get().n;
      const mergedInto = openedTarget.store.db.prepare("SELECT COUNT(*) n FROM cast WHERE merged_into IS NOT NULL").get().n;
      console.log(`  cast_merges rows: ${merges}   cast entries marked merged_into: ${mergedInto}   (the door files a relation, never a merge)`);
      if (merges !== 0 || mergedInto !== 0) problems.push(`the identity door touched the roster on volume ${target.volume}: ${merges} merge(s), ${mergedInto} merged_into mark(s)`);

      // ── 6. the near misses the fold names ─────────────────────────────────────────────────────
      console.log("\n## 6. the guided readings one small kana away from a roster name (reported, never filed)");
      for (const miss of misses.nearMisses) {
        console.log(`      ${miss.reading}  ->  ${miss.rosterName}   (folded: ${miss.folded})   forms: ${miss.forms.join(", ")}   volumes: ${miss.volumes.join(", ")}   ${miss.occurrences} occurrence(s)`);
      }
      console.log(`  ambiguous (one reading folds onto more than one roster name, left open rather than settled): ${misses.ambiguous.length}${misses.ambiguous.length ? " — " + misses.ambiguous.map((a) => `${a.reading} -> ${a.rosterNames.join(" / ")}`).join("; ") : ""}`);
      const withoutNewEntry = misses.nearMisses.filter((m) => m.reading !== "チエリー");
      console.log(`  with the ェ → エ entry added: ${misses.nearMisses.length}; without it: ${withoutNewEntry.length} — the entry plan 07 §2.11 measured missing is what names チエリー / チェリー`);
      const sumireko = split.identityBearing.find((group) => group.reading === "すみれこ");
      if (sumireko) {
        console.log(`  董子 / 菫子 under すみれこ is a TRUE link candidate, not an anomaly: ${sumireko.forms.map((f) => `${f.form} x${f.count}`).join(" / ")} in volumes ${sumireko.volumes.join(", ")} — plan 07 §2b's withdrawn typo diagnosis, kept as what it is`);
      }
      console.log();
    } finally {
      openedTarget.store.close();
    }
  }

  // ── 7. the corpus left alone ───────────────────────────────────────────────────────────────────
  const after = recordState(allVolumes);
  const corpusProblems = compareRecordState(before, after);
  console.log("## 7. corpus left alone");
  console.log(`  volumes checked: ${before.size}`);
  const sidecarFiles = [...before.values()].reduce((n, state) => n + state.sidecars.length, 0);
  const sidecarVolumes = [...before.values()].filter((state) => state.sidecars.length > 0).length;
  console.log(`  -wal / -shm sidecars: ${sidecarFiles} files across ${sidecarVolumes} volumes, ${[...after.values()].reduce((n, state) => n + state.sidecars.length, 0)} still there`);
  console.log("  digests after the run:");
  for (const [folder, state] of after) {
    if (!state.digest) continue;
    console.log(`    ${folder}  ${state.digest.slice(0, 8)}  ${state.bytes} bytes  sidecars: ${state.sidecars.length}`);
  }
  if (corpusProblems.length === 0) {
    console.log("  every series.db digest unchanged, every -wal/-shm sidecar still present: OK");
  } else {
    console.log("  CORPUS PROBLEMS:");
    for (const problem of corpusProblems) console.log(`    ${problem}`);
    process.exitCode = 1;
  }

  // The corpus's own records, read from **fresh** copies in a directory nothing else wrote to. Reusing the
  // copies above would report what this script filed as if it were already there.
  const FRESH_DIR = "/tmp/opencode/plan07-slice2/fresh-read";
  fs.rmSync(FRESH_DIR, { recursive: true, force: true });
  console.log("\n## 8. what the corpus itself holds (read from fresh copies in a directory nothing else wrote to)");
  let corpusForms = 0;
  let corpusIdentities = 0;
  let corpusLinks = 0;
  for (const volume of volumes) {
    const opened = openCopiedRecord(volume, { recopy: true, dir: FRESH_DIR });
    if (!opened) continue;
    try {
      corpusForms += writtenFormCounts(opened.store).total;
      corpusIdentities += opened.store.db.prepare("SELECT COUNT(*) n FROM cast_identities").get().n;
      corpusLinks += opened.store.db.prepare("SELECT COUNT(*) n FROM cast_identity_links").get().n;
    } finally {
      opened.store.close();
    }
  }
  fs.rmSync(FRESH_DIR, { recursive: true, force: true });
  console.log(`  the corpus's own records hold: ${corpusForms} written-form row(s), ${corpusIdentities} identity row(s), ${corpusLinks} link row(s).`);
  console.log("  (0 in every column is the honest answer: no stage calls either door, so nothing has ever been filed in a run.)");

  if (problems.length) {
    console.log("\nPROBLEMS (the acceptance line is not met):");
    for (const problem of problems) console.log(`  ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("\nOK: the record-fed guide rule reproduces plan 07 §2.2 and §2.9, files what the schema allows, names what it cannot, and the corpus is untouched.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

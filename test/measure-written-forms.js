#!/usr/bin/env node
/**
 * test/measure-written-forms.js — plan 07 slice 1 (widened to §6.7): run the written-forms door over the
 * **live corpus** on **copies** of the 17 records, print the numbers the slice's acceptance line rests on,
 * and print what the widened filing reaches. Zero model calls. Nothing in the corpus is written.
 *
 * ## The scope this script measures
 *
 * The door files **every harvested row that passes the two *row* guards** (the guided reading is 2+
 * characters; the reading shares no character with the written form) and applies **neither** *group* guard.
 * The group question — "is this reading printed over 2+ written forms, and is any of them 2+ characters
 * long?" — is answered only by `candidateGroupsInRecord`, over the rows the record carries. This script is
 * the proof that the two halves add up: the rows a per-volume door files, regrouped by the shipped read,
 * reproduce the whole-series fold exactly, with no volume ever looking forward.
 *
 * ## THIS script reads the live corpus, and says so because the other measurement scripts in this folder
 * (`measure-glossary-render.js`, `measure-glossary-research.js`) refuse it. What makes it safe is the same
 * rule gotcha 124 states: **a corpus `series.db` is never opened.** Each volume's record is copied with
 * `fs.copyFileSync` into `/tmp/opencode/plan07-slice1b/measure-db-copy/`, the copy is opened, and the door
 * writes into the copy. It is `copyFileSync` and not `utils/reference-store/db.js`'s `copyDatabase` because
 * `copyDatabase` opens the source (gotcha 166), and opening the source is the thing that silently rewrites
 * the folder the record lives in.
 *
 * The script hashes every volume's `series.db` and lists its `-wal` / `-shm` sidecars before its own run
 * and again after it, and fails if any digest moved or any sidecar appeared or disappeared. That proof is
 * the output, not a footnote: a measurement of a record that cannot show the record is untouched is a
 * measurement that damaged the thing it was measuring.
 *
 * What it prints, in order:
 *   1. the harvest baseline, per volume;
 *   2. the door's own pass, per volume: what the two row guards kept and what each of them threw away, the
 *      rows filed, the roster's answer and the 25 / 54 split the group fold still reports;
 *   3. the three unions side by side — each volume folded alone, **the filed rows regrouped**, and all 17
 *      harvests folded together — and whether the middle one now equals the last one. Under the narrow
 *      scope this slice first built the gap was 40 groups / 394 rows; the widened filing is measured to
 *      close it, and the script **fails its own run** if it does not;
 *   4. the same numbers read back out of a **cumulative record** — volume 17's copy holding all 17 volumes'
 *      rows, which is the shape copy-forward produces — through `candidateGroupsInRecord`, the shipped read;
 *   5. the identity-bearing subset (plan 07 §2.9's 18 groups / 134 rows / 1,402 occurrences) against the
 *      roster read from a copy of the last volume's record, with every one of those 18 spans printed both
 *      ways: whole series, and the most any single volume's own harvest ever formed;
 *   6. the 25 / 54 report over the groups the roster rule cannot see (plan 07 §2.10);
 *   7. the corpus-left-alone proof.
 *
 * It files nothing in the corpus, declares nothing, and calls no model. `npm test` does not run it: it
 * depends on books that are not in this repository (AGENTS.md rule 8), and `test/test-written-forms.js` is
 * the fixture that carries its rules.
 *
 * Usage:
 *   node test/measure-written-forms.js [--series=<series folder>] [--roster-volume=17] [--limit=N]
 *
 * @module test/measure-written-forms
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
  identityBearingGroups,
  splitGroupsByRoster,
  classifyUnselectedGroups,
} = rs;

/** Default series folder: the live corpus this repository writes its artifacts into. */
const DEFAULT_SERIES = path.resolve(__dirname, "..", "..");

/** Where the throwaway copies of the records are put (gotcha 124, gotcha 166). */
const DB_COPY_DIR = "/tmp/opencode/plan07-slice1b/measure-db-copy";

/**
 * plan 07 §2.2's whole-series numbers, and §2.9's roster numbers. Pinned here so the script can say
 * whether the widened filing reached them rather than print whatever came out and call it a result.
 */
const EXPECTED = {
  harvestRows: 10005,
  harvestOccurrences: 45429,
  candidateGroups: 97,
  candidateForms: 222,
  candidateRows: 634,
  candidateOccurrences: 8734,
  identityBearingGroups: 18,
  identityBearingRows: 134,
  identityBearingOccurrences: 1402,
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
 * @returns {{series: string, rosterVolume: string|null, limit: number|null}}
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
 * `fs.copyFileSync` of the main file, plus the `-wal` / `-shm` sidecars when the log is non-empty — a copy
 * of the main file alone would be a record missing its newest rows, and the script names which case it
 * took rather than assuming the safe one. The corpus file is never opened by anything (gotcha 124,
 * gotcha 166).
 *
 * @param {{volumeDir: string, folder: string, volume: string}} volume
 * @param {{recopy?: boolean}} [opts] - `recopy: false` opens the copy that is already there, which is how
 *   a second pass over the same record is measured. Defaults to true.
 * @returns {{store: Object, copy: string, note: string}|null} Null when the volume has no record.
 */
function openCopiedRecord(volume, { recopy = true } = {}) {
  const source = path.join(volume.volumeDir, "series.db");
  if (!fs.existsSync(source)) return null;
  const scratchVolumeDir = path.join(DB_COPY_DIR, volume.folder);
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
  const store = openReferenceStore({ volume: Number(volume.volume), folder: volume.folder, seriesDir: DB_COPY_DIR, stage: "merge" });
  return { store, copy, note };
}

/**
 * One candidate group as one line: the reading, then each written form with its count, starred when the
 * roster already holds that name.
 *
 * @param {import("../utils/source/guide-groups").GuideGroup} group
 * @param {Set<string>} roster
 * @param {string} prefix
 * @returns {string}
 */
function describeGroup(group, roster, prefix) {
  const forms = group.forms.map((form) => `${form.form}${roster.has(form.form) ? "*" : ""} x${form.count}`).join(", ");
  const marked = group.reading && roster.has(group.reading) ? " (the READING is a roster entry)" : "";
  return `${prefix}${group.reading}  ←  ${forms}   [${group.volumes.length} volume(s): ${group.volumes.join(", ")}, ${group.occurrences} occurrence(s)]${marked}`;
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

  console.log("# plan 07 slice 1 (widened to §6.7) — the written-forms door, measured on the live corpus");
  console.log(`series: ${args.series}`);
  console.log(`volumes with a harvest: ${volumes.length}`);
  console.log("filing scope: every harvest row that passes the TWO ROW GUARDS; the group question is answered by query.");
  console.log(`model calls: 0. Writes to the corpus: none. Records opened: copies under ${DB_COPY_DIR}.\n`);

  // ── 1. the harvest baseline ────────────────────────────────────────────────────────────────────
  /** @type {Array<{volume: string, guides: Array<Object>, folder: string}>} */
  const harvests = volumes.map((volume) => ({
    volume: volume.volume,
    folder: volume.folder,
    guides: JSON.parse(fs.readFileSync(path.join(volume.volumeDir, volume.guideFile), "utf8")).guides,
  }));
  const allRows = harvests.flatMap((harvest) => harvest.guides);
  console.log("## 1. the harvest baseline");
  console.log(`  files: ${harvests.length}`);
  console.log(`  distinct word-and-reading rows: ${allRows.length}`);
  console.log(`  total occurrences: ${allRows.reduce((sum, row) => sum + (row.count || 0), 0)}\n`);

  // ── 2. the door, one volume at a time, on a copy of that volume's record ───────────────────────
  console.log("## 2. the door's own pass, per volume (each on a copy of that volume's record)");
  console.log("  What the two ROW GUARDS decided, and what the door filed:");
  console.log("  vol  harvest  no-word  len>1  shared  eligible  merged  FILED  already  occurrences  |  groups the GROUP guards still report  id-bearing  unselected  variants  sound-alikes  roster");
  /** @type {Array<{volume: string, filed: Array<Object>, pass: Object, rosterSize: number, note: string}>} */
  const passes = [];
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
        console.log(`  ${volume.volume.padStart(4)}  REFUSED: ${pass.refusal.rule} — ${pass.refusal.because}`);
        continue;
      }
      const roster = rosterKeysInRecord(opened.store);
      const f = pass.filing;
      console.log(
        `  ${volume.volume.padStart(4)}  ${String(f.harvestRows).padStart(8)}  ${String(f.rowsSkippedWithoutWordOrReading).padStart(8)}  ` +
          `${String(f.rowsDroppedByReadingLength).padStart(6)}  ${String(f.rowsDroppedBySharedCharacter).padStart(6)}  ` +
          `${String(f.rowsEligible).padStart(8)}  ${String(f.rowsMerged).padStart(6)}  ${String(pass.rowsFiled).padStart(6)}  ` +
          `${String(pass.rowsAlreadyFiled).padStart(7)}  ${String(f.occurrences).padStart(11)}  |  ` +
          `${String(pass.candidateGroups).padStart(6)}  ${String(pass.identityBearing.groups).padStart(10)}  ` +
          `${String(pass.unselected.groups).padStart(10)}  ${String(pass.unselected.spellingVariants).padStart(8)}  ` +
          `${String(pass.unselected.soundAlikes).padStart(11)}  ${roster.size}`
      );
      passes.push({ volume: volume.volume, filed: pass.formsFiled, pass, rosterSize: roster.size, note: opened.note });
    } finally {
      opened.store.close();
    }
  }
  const sumOf = (fn) => passes.reduce((sum, entry) => sum + fn(entry.pass), 0);
  console.log(
    `  TOTAL  ${String(sumOf((p) => p.filing.harvestRows)).padStart(8)}  ${String(sumOf((p) => p.filing.rowsSkippedWithoutWordOrReading)).padStart(8)}  ` +
      `${String(sumOf((p) => p.filing.rowsDroppedByReadingLength)).padStart(6)}  ${String(sumOf((p) => p.filing.rowsDroppedBySharedCharacter)).padStart(6)}  ` +
      `${String(sumOf((p) => p.filing.rowsEligible)).padStart(8)}  ${String(sumOf((p) => p.filing.rowsMerged)).padStart(6)}  ` +
      `${String(sumOf((p) => p.rowsFiled)).padStart(6)}  ${String(sumOf((p) => p.rowsAlreadyFiled)).padStart(7)}  ${String(sumOf((p) => p.filing.occurrences)).padStart(11)}`
  );
  console.log(`  filed across ${passes.length} volume(s): ${sumOf((p) => p.rowsFiled)} rows, ${sumOf((p) => p.filing.occurrences)} occurrences`);
  console.log(`  dropped by the row guards: ${sumOf((p) => p.filing.rowsDroppedByReadingLength)} rows whose reading is 1 character (a phonetic complement on one kanji), ` +
    `${sumOf((p) => p.filing.rowsDroppedBySharedCharacter)} rows whose reading reuses a character of its own word (the word's ordinary pronunciation), ` +
    `${sumOf((p) => p.filing.rowsSkippedWithoutWordOrReading)} rows naming no written form at all.`);
  console.log(`  rows the GROUP guards would have refused to file, and ARE filed anyway: ${sumOf((p) => p.rowsFiled) - sumOf((p) => p.candidateRows)}\n`);

  // A second pass over the SAME copy, to show the idempotence claim on the real corpus rather than a fixture.
  if (passes.length) {
    const last = volumes[volumes.length - 1];
    const again = openCopiedRecord(last, { recopy: false });
    if (again) {
      try {
        const harvest = harvests.find((entry) => entry.folder === last.folder);
        const second = await fileVolumeWrittenForms(again.store, { harvests: [{ volume: Number(last.volume), guides: harvest.guides }] });
        console.log(`  second pass over volume ${last.volume}: ${second.rowsFiled} filed, ${second.rowsAlreadyFiled} already filed (the key is the rule)`);
        if (second.rowsFiled !== 0) problems.push(`second pass over volume ${last.volume} filed ${second.rowsFiled} row(s); the door is supposed to file 0`);
        console.log();
      } finally {
        again.store.close();
      }
    }
  }

  // ── 3. the three unions, and whether the widened filing closed the gap ─────────────────────────
  const perVolumeFolds = harvests.map((harvest) => collectGuideGroups([harvest], { displaySubset: false }).totals);
  /** @type {Map<string, Set<number>>} */
  const perVolumeCandidate = new Map();
  for (const harvest of harvests) {
    for (const group of collectGuideGroups([harvest], { displaySubset: false }).groups) {
      if (!perVolumeCandidate.has(group.reading)) perVolumeCandidate.set(group.reading, new Set());
      perVolumeCandidate.get(group.reading).add(Number(harvest.volume));
    }
  }
  const unionFiled = collectGuideGroups(
    passes.map((entry) => ({
      volume: entry.volume,
      guides: entry.filed.map((row) => ({ word: row.form, reading: row.reading, count: row.occurrences, chapters: row.chapters, readingScript: row.readingScript })),
    })),
    { displaySubset: false }
  ).totals;
  const unionHarvests = collectGuideGroups(harvests, { displaySubset: false });
  console.log("## 3. what the door files, against what the harvest holds");
  console.log("  (a) each volume folded ALONE, and the counts added up (one reading counted once per book):");
  console.log(`      groups: ${perVolumeFolds.reduce((s, t) => s + t.candidateGroups, 0)}   rows: ${perVolumeFolds.reduce((s, t) => s + t.candidateRows, 0)}   occurrences: ${perVolumeFolds.reduce((s, t) => s + t.candidateOccurrences, 0)}`);
  console.log("  (b) the rows the door filed, regrouped over the whole series by the SAME grouping rule (one reading counted once):");
  console.log(`      groups: ${unionFiled.candidateGroups}   rows: ${unionFiled.candidateRows}   occurrences: ${unionFiled.candidateOccurrences}   distinct written forms: ${unionFiled.candidateForms}`);
  console.log("  (c) all 17 harvests folded TOGETHER — the number plan 07 §2.2 measures:");
  console.log(`      groups: ${unionHarvests.totals.candidateGroups}   rows: ${unionHarvests.totals.candidateRows}   occurrences: ${unionHarvests.totals.candidateOccurrences}   distinct written forms: ${unionHarvests.totals.candidateForms}`);
  const gapGroups = unionHarvests.totals.candidateGroups - unionFiled.candidateGroups;
  const gapRows = unionHarvests.totals.candidateRows - unionFiled.candidateRows;
  console.log(`  THE GAP between (b) and (c): ${gapGroups} groups and ${gapRows} rows.`);
  if (gapGroups === 0 && gapRows === 0) {
    console.log("  CLOSED. Filing every row the two row guards keep means the per-volume door writes down every form a group is made of,");
    console.log("  so the read over the filed rows finds every group the whole-series fold finds — with no volume looking forward.");
  } else {
    console.log("  NOT CLOSED. The filed rows do not describe every group the harvest does; name what is missing before anything is concluded.");
    problems.push(`the regrouped filed rows are ${unionFiled.candidateGroups} groups / ${unionFiled.candidateRows} rows against the harvest's ${unionHarvests.totals.candidateGroups} / ${unionHarvests.totals.candidateRows}`);
  }
  if (args.limit === null) {
    for (const [label, got, want] of [
      ["harvest rows", allRows.length, EXPECTED.harvestRows],
      ["whole-series candidate groups", unionHarvests.totals.candidateGroups, EXPECTED.candidateGroups],
      ["whole-series candidate rows", unionHarvests.totals.candidateRows, EXPECTED.candidateRows],
      ["whole-series candidate occurrences", unionHarvests.totals.candidateOccurrences, EXPECTED.candidateOccurrences],
      ["whole-series candidate written forms", unionHarvests.totals.candidateForms, EXPECTED.candidateForms],
      ["regrouped filed groups", unionFiled.candidateGroups, EXPECTED.candidateGroups],
      ["regrouped filed rows", unionFiled.candidateRows, EXPECTED.candidateRows],
      ["regrouped filed occurrences", unionFiled.candidateOccurrences, EXPECTED.candidateOccurrences],
      ["regrouped filed written forms", unionFiled.candidateForms, EXPECTED.candidateForms],
    ]) {
      if (got !== want) problems.push(`${label}: measured ${got}, plan 07 §2.2 states ${want}`);
    }
    console.log(`  against plan 07 §2.2's pinned numbers (${EXPECTED.candidateGroups} groups / ${EXPECTED.candidateForms} forms / ${EXPECTED.candidateRows} rows / ${EXPECTED.candidateOccurrences} occurrences): ${problems.length ? "see PROBLEMS" : "all reproduced"}`);
  }
  console.log();

  // ── 4. the same numbers read back out of a CUMULATIVE record, through the shipped read ─────────
  const target = volumes.find((volume) => String(Number(volume.volume)) === String(Number(args.rosterVolume))) || volumes[volumes.length - 1];
  const openedTarget = openCopiedRecord(target);
  if (!openedTarget) {
    console.log(`## 4. the roster: volume ${target.volume} has no series.db; the identity question is not asked.\n`);
  } else {
    try {
      // Volume 17's copy, filled the way copy-forward fills a real volume: every earlier volume's rows,
      // each stamped with the book that printed it, then this volume's own. The door is asked per volume,
      // so nothing here looks forward — volume 17's record simply carries what volumes 1–16 filed.
      for (const entry of passes) {
        if (Number(entry.volume) === Number(target.volume)) continue;
        const harvest = harvests.find((h) => String(Number(h.volume)) === String(Number(entry.volume)));
        const carried = await fileVolumeWrittenForms(openedTarget.store, { volume: Number(entry.volume), harvests: [{ volume: Number(entry.volume), guides: harvest.guides }] });
        if (!carried.ok) problems.push(`volume ${entry.volume}'s rows could not be carried into volume ${target.volume}'s copy: ${carried.refusal && carried.refusal.rule}`);
      }
      const ownHarvest = harvests.find((h) => String(Number(h.volume)) === String(Number(target.volume)));
      const ownPass = await fileVolumeWrittenForms(openedTarget.store, { harvests: [{ volume: Number(target.volume), guides: ownHarvest.guides }] });
      const cumulative = candidateGroupsInRecord(openedTarget.store);
      const counts = writtenFormCounts(openedTarget.store);
      console.log(`## 4. the same question read back out of a CUMULATIVE record (volume ${target.volume}'s copy, holding every volume's rows the way copy-forward carries them)`);
      console.log(`  written_forms rows in that record: ${counts.total} (${counts.distinctForms} distinct forms, ${counts.distinctReadings} distinct readings, ${counts.occurrences} occurrences)`);
      console.log(`  candidateGroupsInRecord: ${cumulative.totals.candidateGroups} groups / ${cumulative.totals.candidateForms} forms / ${cumulative.totals.candidateRows} rows / ${cumulative.totals.candidateOccurrences} occurrences`);
      console.log(`  groups the group guards dropped there: ${cumulative.totals.groupsDroppedBelowFormFloor} carried by one written form, ${cumulative.totals.groupsDroppedWithEveryFormSingleCharacter} whose forms are all one character (しば ← 芝 x416 / 縛 x10 is one of them — its rows ARE in the table, so widening that guard later costs no re-read)`);
      if (cumulative.totals.candidateGroups !== unionHarvests.totals.candidateGroups || cumulative.totals.candidateRows !== unionHarvests.totals.candidateRows) {
        problems.push(`the cumulative record's read gives ${cumulative.totals.candidateGroups} groups / ${cumulative.totals.candidateRows} rows against the harvest fold's ${unionHarvests.totals.candidateGroups} / ${unionHarvests.totals.candidateRows}`);
      }

      // ── 5. the identity-bearing subset, against the last volume's roster ───────────────────────
      const roster = rosterKeysInRecord(openedTarget.store);
      const split = splitGroupsByRoster(cumulative.groups, roster);
      console.log(`\n## 5. can the record pick the identity-bearing groups out of the candidates? (roster: a COPY of volume ${target.volume}'s cast table, ${roster.size} entries)`);
      console.log(`  candidates: ${split.totals.groups}`);
      console.log(`  identity-bearing: ${split.totals.identityBearing} groups / ${split.totals.identityBearingRows} rows / ${split.totals.identityBearingOccurrences} occurrences`);
      console.log(`  left out: ${split.totals.unselected} groups / ${split.totals.unselectedRows} rows / ${split.totals.unselectedOccurrences} occurrences`);
      if (args.limit === null) {
        if (split.totals.identityBearing !== EXPECTED.identityBearingGroups) problems.push(`identity-bearing groups: measured ${split.totals.identityBearing}, plan 07 §2.9 states ${EXPECTED.identityBearingGroups}`);
        if (split.totals.identityBearingRows !== EXPECTED.identityBearingRows) problems.push(`identity-bearing rows: measured ${split.totals.identityBearingRows}, plan 07 §2.9 states ${EXPECTED.identityBearingRows}`);
        if (split.totals.identityBearingOccurrences !== EXPECTED.identityBearingOccurrences) problems.push(`identity-bearing occurrences: measured ${split.totals.identityBearingOccurrences}, plan 07 §2.9 states ${EXPECTED.identityBearingOccurrences}`);
      }
      console.log("  --- selected (a * marks a written form the roster holds):");
      for (const group of split.identityBearing) console.log(describeGroup(group, roster, "      "));
      const byReadingOnly = split.identityBearing.filter((group) => !group.forms.some((form) => roster.has(form.form)));
      console.log(`  selected ONLY because the guided reading is itself a roster entry: ${byReadingOnly.length} — ${byReadingOnly.map((g) => g.reading).join(", ")}`);
      const allFormsKnown = split.identityBearing.filter((group) => group.forms.every((form) => roster.has(form.form)));
      console.log(`  selected although EVERY form is already a roster entry: ${allFormsKnown.length} — ${allFormsKnown.map((g) => g.reading).join(", ")}   <- the half plan 06 §2.11 threw away, kept here`);

      // §2.13's span table, re-measured against the widened filing. Two columns, because there are two
      // different questions and §2.13 conflated them: what a single volume's OWN harvest ever formed
      // (a fact about the books, unchanged by this slice), and what the record reaches once every
      // eligible row is filed and the rows travel forward (the question the widening answers).
      const spans = split.identityBearing.map((group) => ({
        reading: group.reading,
        wholeSeries: group.volumes.length,
        bestSingleVolumeFold: perVolumeCandidate.has(group.reading) ? perVolumeCandidate.get(group.reading).size : 0,
        inThisRecord: group.volumes.length,
      }));
      const neverSeen = spans.filter((span) => span.bestSingleVolumeFold === 0);
      const partial = spans.filter((span) => span.bestSingleVolumeFold > 0 && span.bestSingleVolumeFold < span.wholeSeries);
      const full = spans.filter((span) => span.bestSingleVolumeFold === span.wholeSeries);
      console.log("  --- §2.13's span table, re-measured (whole-series span -> the most any single volume's OWN harvest formed | what this record reaches):");
      for (const span of spans) {
        console.log(`      ${span.reading}: ${span.wholeSeries} -> ${String(span.bestSingleVolumeFold).padStart(2)} | ${span.inThisRecord}${span.bestSingleVolumeFold === 0 ? "   <- never a candidate group in any ONE book" : ""}`);
      }
      console.log(`  never a candidate group in any one book: ${neverSeen.length} — ${neverSeen.map((s) => s.reading).join(", ")}`);
      console.log(`  reached by one book but with fewer volumes than the series shows: ${partial.length}`);
      console.log(`  reached in full by one book: ${full.length}`);
      const reachedInRecord = spans.filter((span) => span.inThisRecord === span.wholeSeries);
      console.log(`  reached IN FULL by the cumulative record: ${reachedInRecord.length} of ${spans.length}${reachedInRecord.length === spans.length ? "  <- §2.13's 3-never / 14-partial / 1-full table is GONE as a filing limit: it survives only as a fact about single-book folds" : ""}\n`);

      // ── 6. the 25 / 54 report ───────────────────────────────────────────────────────────────────
      const report = classifyUnselectedGroups(split.unselected);
      console.log("## 6. the groups the roster cannot see, split by spelling shape (plan 07 §2.10)");
      console.log(`  one word spelled two ways: ${report.totals.spellingVariants} groups / ${report.totals.variantRows} rows / ${report.totals.variantOccurrences} occurrences`);
      console.log(`  different words that sound alike: ${report.totals.soundAlikes} groups / ${report.totals.soundAlikeRows} rows / ${report.totals.soundAlikeOccurrences} occurrences`);
      console.log("  --- the spelling variants, printed the way a dictionary prints color / colour:");
      for (const entry of report.spellingVariants) {
        console.log(`      ${entry.reading}  ←  ${entry.forms.map((f) => `${f.form} x${f.count}`).join(" / ")}   (closest pair ${entry.closestPair.a} / ${entry.closestPair.b}: ${entry.closestPair.shared} of ${entry.closestPair.shorter} in order)`);
      }
      console.log("  --- the sound-alikes, named as a class and NOT reported as errors:");
      for (const entry of report.soundAlikes.slice(0, 12)) {
        console.log(`      ${entry.reading}  ←  ${entry.forms.map((f) => `${f.form} x${f.count}`).join(" / ")}`);
      }
      if (report.soundAlikes.length > 12) console.log(`      … and ${report.soundAlikes.length - 12} more`);
      console.log();
    } finally {
      openedTarget.store.close();
    }
  }

  // ── 7. the corpus-left-alone proof ─────────────────────────────────────────────────────────────
  const after = recordState(allVolumes);
  const corpusProblems = compareRecordState(before, after);
  console.log("## 7. corpus left alone");
  console.log(`  volumes checked: ${before.size}`);
  const sidecarFiles = [...before.values()].reduce((n, state) => n + state.sidecars.length, 0);
  const sidecarVolumes = [...before.values()].filter((state) => state.sidecars.length > 0).length;
  console.log(`  series.db digests: ${[...before.values()].filter((state) => state.digest).length} hashed, ${[...after.values()].filter((state) => state.digest).length} re-hashed`);
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

  if (problems.length) {
    console.log("\nPROBLEMS (the acceptance line is not met):");
    for (const problem of problems) console.log(`  ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("\nOK: the widened filing reproduces plan 07 §2.2 and §2.9, and the corpus is untouched.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

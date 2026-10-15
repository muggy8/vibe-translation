#!/usr/bin/env node
/**
 * test/measure-written-forms.js — plan 07 slice 1: run the written-forms door over the **live corpus**
 * on **copies** of the 17 records, print the numbers the slice's acceptance line rests on, and print the
 * gap the door's own scope cannot close. Zero model calls. Nothing in the corpus is written.
 *
 * THIS SCRIPT READS THE LIVE CORPUS, and says so because the other measurement scripts in this folder
 * (`measure-glossary-render.js`, `measure-glossary-research.js`) refuse it. What makes it safe is the
 * same rule gotcha 124 states: **a corpus `series.db` is never opened.** Each volume's record is copied
 * with `fs.copyFileSync` into `/tmp/opencode/plan07-slice1/measure-db-copy/`, the copy is opened, and the
 * door writes into the copy. It is `copyFileSync` and not `utils/reference-store/db.js`'s `copyDatabase`
 * because `copyDatabase` opens the source (gotcha 166), and opening the source is the thing that silently
 * rewrites the folder the record lives in.
 *
 * The script hashes every volume's `series.db` and lists its `-wal` / `-shm` sidecars before its own run
 * and again after it, and fails if any digest moved or any sidecar appeared or disappeared. That proof is
 * the output, not a footnote: a measurement of a record that cannot show the record is untouched is a
 * measurement that damaged the thing it was measuring.
 *
 * What it prints, in order:
 *   1. the harvest baseline, per volume;
 *   2. the door's own pass, per volume: rows filed, already filed, the roster's answer, the 25 / 54 split;
 *   3. the union of the 17 passes — what the records would hold — against the union of the 17 harvests,
 *      which is the number plan 07 §2.2 measures (97 groups / 634 rows) and the number a per-volume door
 *      can reach (57 groups / 240 rows). **The gap is the finding**, and it is printed as a gap;
 *   4. the identity-bearing subset (plan 07 §2.9's 18 groups / 134 rows / 1,402 occurrences) against the
 *      roster read from a copy of the last volume's record;
 *   5. the 25 / 54 report over the groups the roster rule cannot see (plan 07 §2.10);
 *   6. the corpus-left-alone proof.
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
  rosterKeysInRecord,
  identityBearingGroups,
  splitGroupsByRoster,
  classifyUnselectedGroups,
} = rs;

/** Default series folder: the live corpus this repository writes its artifacts into. */
const DEFAULT_SERIES = path.resolve(__dirname, "..", "..");

/** Where the throwaway copies of the records are put (gotcha 124, gotcha 166). */
const DB_COPY_DIR = "/tmp/opencode/plan07-slice1/measure-db-copy";

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
  return `${prefix}${group.reading}  ←  ${forms}   [${group.volumes.length} volume(s), ${group.occurrences} occurrence(s)]${marked}`;
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

  console.log("# plan 07 slice 1 — the written-forms door, measured on the live corpus");
  console.log(`series: ${args.series}`);
  console.log(`volumes with a harvest: ${volumes.length}`);
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
  console.log("  volume  harvest rows  candidate groups  rows filed  already filed  identity-bearing  unselected  spelling variants  sound-alikes  roster");
  /** @type {Array<{volume: string, filed: Array<Object>, pass: Object, rosterSize: number, note: string}>} */
  const passes = [];
  for (const volume of volumes) {
    const opened = openCopiedRecord(volume);
    if (!opened) {
      console.log(`  ${volume.volume.padStart(6)}  (no series.db in this volume folder — nothing filed, named rather than guessed at)`);
      continue;
    }
    try {
      const harvest = harvests.find((entry) => entry.folder === volume.folder);
      const pass = await fileVolumeWrittenForms(opened.store, { harvests: [{ volume: Number(volume.volume), guides: harvest.guides }] });
      if (!pass.ok) {
        console.log(`  ${volume.volume.padStart(6)}  REFUSED: ${pass.refusal.rule} — ${pass.refusal.because}`);
        continue;
      }
      const roster = rosterKeysInRecord(opened.store);
      const counts = writtenFormCounts(opened.store);
      console.log(
        `  ${volume.volume.padStart(6)}  ${String(pass.totals.harvestRows).padStart(12)}  ${String(pass.candidateGroups).padStart(16)}  ` +
          `${String(pass.rowsFiled).padStart(11)}  ${String(pass.rowsAlreadyFiled).padStart(13)}  ` +
          `${String(pass.identityBearing.groups).padStart(16)}  ${String(pass.unselected.groups).padStart(10)}  ` +
          `${String(pass.unselected.spellingVariants).padStart(15)}  ${String(pass.unselected.soundAlikes).padStart(12)}  ${roster.size}`
      );
      passes.push({ volume: volume.volume, filed: pass.formsFiled, pass, rosterSize: roster.size, note: opened.note });
    } finally {
      opened.store.close();
    }
  }
  const totalFiled = passes.reduce((sum, entry) => sum + entry.pass.rowsFiled, 0);
  console.log(`  filed across ${passes.length} volume(s): ${totalFiled} rows\n`);

  // A second pass over the SAME copy, to show the idempotence claim on the real corpus rather than a fixture.
  if (passes.length) {
    const last = volumes[volumes.length - 1];
    const again = openCopiedRecord(last, { recopy: false });
    if (again) {
      try {
        const harvest = harvests.find((entry) => entry.folder === last.folder);
        const second = await fileVolumeWrittenForms(again.store, { harvests: [{ volume: Number(last.volume), guides: harvest.guides }] });
        console.log(`  second pass over volume ${last.volume}: ${second.rowsFiled} filed, ${second.rowsAlreadyFiled} already filed (the key is the rule)\n`);
      } finally {
        again.store.close();
      }
    }
  }

  // ── 3. the union, and the gap the door's own scope cannot close ─────────────────────────────────
  const perVolumeFolds = harvests.map((harvest) => collectGuideGroups([harvest], { displaySubset: false }).totals);
  // Which readings are a candidate group **inside one book alone**, and in how many books that happens.
  // This is the shape the gap is made of: a group a single volume can never form on its own harvest.
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
  console.log("  (a) each volume folded ALONE, and the counts added up (one reading counted once per book) — what a no-forward door can reach:");
  console.log(`      groups: ${perVolumeFolds.reduce((s, t) => s + t.candidateGroups, 0)}   rows: ${perVolumeFolds.reduce((s, t) => s + t.candidateRows, 0)}   occurrences: ${perVolumeFolds.reduce((s, t) => s + t.candidateOccurrences, 0)}`);
  console.log("  (b) the rows the door actually filed, regrouped over the whole series (one reading counted once):");
  console.log(`      groups: ${unionFiled.candidateGroups}   rows: ${unionFiled.candidateRows}   occurrences: ${unionFiled.candidateOccurrences}`);
  console.log("  (c) all 17 harvests folded TOGETHER — the number plan 07 §2.2 measures:");
  console.log(`      groups: ${unionHarvests.totals.candidateGroups}   rows: ${unionHarvests.totals.candidateRows}   occurrences: ${unionHarvests.totals.candidateOccurrences}   distinct written forms: ${unionHarvests.totals.candidateForms}`);
  console.log(`  THE GAP: ${unionHarvests.totals.candidateGroups - unionFiled.candidateGroups} groups and ${unionHarvests.totals.candidateRows - unionFiled.candidateRows} rows exist only in the union,`);
  console.log("  because \"one reading over 2+ written forms\" is a question about a SET, and the account owner's");
  console.log("  rule is that no volume looks forward. The rows whose second written form appears in a LATER");
  console.log("  book are therefore invisible to the volume that printed the first one. See");
  console.log("  /tmp/opencode/plan07-slice1-questions.md.\n");

  // ── 4. the identity-bearing subset, against the last volume's roster ───────────────────────────
  const target = volumes.find((volume) => String(Number(volume.volume)) === String(Number(args.rosterVolume))) || volumes[volumes.length - 1];
  const openedTarget = openCopiedRecord(target);
  if (!openedTarget) {
    console.log(`## 4. the roster: volume ${target.volume} has no series.db; the identity question is not asked.\n`);
  } else {
    try {
      const roster = rosterKeysInRecord(openedTarget.store);
      const split = splitGroupsByRoster(unionHarvests.groups, roster);
      console.log(`## 4. can the record pick the identity-bearing groups out of the candidates? (roster: a COPY of volume ${target.volume}'s cast table, ${roster.size} entries)`);
      console.log(`  candidates: ${split.totals.groups}`);
      console.log(`  identity-bearing: ${split.totals.identityBearing} groups / ${split.totals.identityBearingRows} rows / ${split.totals.identityBearingOccurrences} occurrences`);
      console.log(`  left out: ${split.totals.unselected} groups / ${split.totals.unselectedRows} rows / ${split.totals.unselectedOccurrences} occurrences`);
      console.log("  --- selected (a * marks a written form the roster holds):");
      for (const group of split.identityBearing) console.log(describeGroup(group, roster, "      "));
      const byReadingOnly = split.identityBearing.filter((group) => !group.forms.some((form) => roster.has(form.form)));
      console.log(`  selected ONLY because the guided reading is itself a roster entry: ${byReadingOnly.length} — ${byReadingOnly.map((g) => g.reading).join(", ")}`);
      const allFormsKnown = split.identityBearing.filter((group) => group.forms.every((form) => roster.has(form.form)));
      console.log(`  selected although EVERY form is already a roster entry: ${allFormsKnown.length} — ${allFormsKnown.map((g) => g.reading).join(", ")}   <- the half plan 06 §2.11 threw away, kept here`);

      // What the door's own scope does to those 18. A group is only a group when two forms are in the rows
      // being folded, so the question "how many books print this reading over 2+ forms" has one answer over
      // the whole series and a smaller answer inside any one book.
      const spans = split.identityBearing.map((group) => ({
        reading: group.reading,
        wholeSeries: group.volumes.length,
        bestSingleVolume: perVolumeCandidate.has(group.reading) ? perVolumeCandidate.get(group.reading).size : 0,
      }));
      const neverSeen = spans.filter((span) => span.bestSingleVolume === 0);
      const partial = spans.filter((span) => span.bestSingleVolume > 0 && span.bestSingleVolume < span.wholeSeries);
      console.log("  --- what a no-forward door sees of those groups (whole-series volume span -> the most any single volume's own fold reaches):");
      for (const span of spans) console.log(`      ${span.reading}: ${span.wholeSeries} -> ${span.bestSingleVolume}${span.bestSingleVolume === 0 ? "   <- never a candidate group in any one book" : ""}`);
      console.log(`  never reached at all: ${neverSeen.length} — ${neverSeen.map((s) => s.reading).join(", ")}`);
      console.log(`  reached but with fewer volumes than the series shows: ${partial.length}`);
      console.log(`  reached in full: ${spans.length - neverSeen.length - partial.length}\n`);

      // ── 5. the 25 / 54 report ───────────────────────────────────────────────────────────────────
      const report = classifyUnselectedGroups(split.unselected);
      console.log("## 5. the groups the roster cannot see, split by spelling shape (plan 07 §2.10)");
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

  // ── 6. the corpus-left-alone proof ─────────────────────────────────────────────────────────────
  const after = recordState(allVolumes);
  const problems = compareRecordState(before, after);
  console.log("## 6. corpus left alone");
  console.log(`  volumes checked: ${before.size}`);
  const sidecars = [...before.values()].filter((state) => state.sidecars.length > 0).length;
  console.log(`  series.db digests: ${[...before.values()].filter((state) => state.digest).length} hashed, ${[...after.values()].filter((state) => state.digest).length} re-hashed`);
  console.log(`  volumes carrying a -wal / -shm sidecar: ${sidecars}`);
  if (problems.length === 0) {
    console.log("  every series.db digest unchanged, every -wal/-shm sidecar still present: OK");
  } else {
    console.log("  PROBLEMS:");
    for (const problem of problems) console.log(`    ${problem}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

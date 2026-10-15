#!/usr/bin/env node
/**
 * test/measure-guide-groups.js — plan 07 slice 0: read every volume's pronunciation-guide harvest
 * over the **live corpus**, print the numbers plan 07 §2 rests on, and answer the question that
 * decides whether slices 1–2 can be built at all. Zero model calls.
 *
 * THIS SCRIPT READS THE LIVE CORPUS, and says so because the two other measurement scripts in this
 * folder (`measure-glossary-render.js`, `measure-glossary-research.js`) refuse it. The difference is
 * what it opens: those two run the store's doors, which write. This one reads plain JSON files and
 * the published markdown, and **writes nothing anywhere** — no report file, no artifact, no row. It
 * is `npm test`-excluded for the same reason the others are: it depends on books that are not in
 * this repository, so a fixture is the only honest place for its numbers (AGENTS.md rule 8), and
 * `test/test-guide-groups.js` is that fixture.
 *
 * The one thing here that could touch a book is the reference record, and it is handled the way
 * AGENTS.md gotcha 124 requires: the corpus `series.db` is **never opened**. Its bytes are copied to
 * `/tmp/opencode/plan07-slice0/measure-db-copy/` and the copy is opened. The script hashes every
 * volume's `series.db` before and after its own run and fails if any digest moved or if a
 * `-wal` / `-shm` sidecar appeared or disappeared — because the failure mode of measuring a record
 * is silently rewriting the folder the record lives in.
 *
 * What it prints, in order:
 *   1. the harvest baseline (files, rows, occurrences, characters of reading text);
 *   2. the **display** subset — a Han-script word guided in katakana — and the correction to the
 *      "readings printed over more than one written form" count;
 *   3. the rejected candidate rule, kept runnable so the rejection can be re-measured;
 *   4. the script-neutral candidate set, produced by the shipped reader `utils/source/guide-groups.js`,
 *      with every guard's own tally;
 *   5. the decisive measurement: does the record's own roster separate the identity-bearing groups
 *      from the homophone noise;
 *   6. the second signal the measurement found, and the near-miss spellings it exposes.
 *
 * Usage:
 *   node test/measure-guide-groups.js [--series=<series folder>] [--db-volume=17] [--no-db]
 *
 * @module test/measure-guide-groups
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  collectGuideGroups,
  guideGroupDisplaySubset,
  isGuideGroupKatakanaOverHanForm,
  GUIDE_GROUP_MIN_READING_CHARS,
  GUIDE_GROUP_MIN_FORMS,
  GUIDE_GROUP_MIN_FORM_CHARS,
} = require("../utils/source/guide-groups");
const { RUBY_GUIDE_FILE_SUFFIX, readingScriptOf } = require("../utils/source/ruby-guides");
const { parseGlossaryMarkdown } = require("../utils/reference-store");

/** Default series folder: the live corpus this repository writes its artifacts into. */
const DEFAULT_SERIES = path.resolve(__dirname, "..", "..");

/** Where the throwaway copy of one volume's record is put (gotcha 124). */
const DB_COPY_DIR = "/tmp/opencode/plan07-slice0/measure-db-copy";

/**
 * The Han block, used only by the **display** subset. It is not part of the grouping rule, which
 * names no script at all (`utils/source/guide-groups.js` header).
 *
 * @param {string} text
 * @returns {boolean}
 */
function containsHan(text) {
  return /[\u4e00-\u9fff]/u.test(String(text || ""));
}

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
 * @returns {{series: string, dbVolume: string|null, useDb: boolean}}
 */
function readArgs() {
  const argv = process.argv.slice(2);
  const pick = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  return {
    series: path.resolve(pick("series") || DEFAULT_SERIES),
    dbVolume: pick("db-volume") || "17",
    useDb: !argv.includes("--no-db"),
  };
}

/**
 * Every volume folder in the series, in reading order, with the harvest file beside its source.
 *
 * Refuses when the corpus is absent: a measurement that prints zeros because it could not find the
 * books is a measurement that reports the books as empty.
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
        "This measurement reads the extraction's harvest; run `npx gulp extract` first, or point " +
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
 * Snapshot every volume's `series.db` digest and sidecar presence, so the script can prove its own
 * run left the corpus alone (gotcha 124).
 *
 * @param {Array<{folder: string, volumeDir: string}>} volumes
 * @returns {Map<string, {digest: string|null, sidecars: string[]}>}
 */
function recordState(volumes) {
  /** @type {Map<string, {digest: string|null, sidecars: string[]}>} */
  const state = new Map();
  for (const volume of volumes) {
    const file = path.join(volume.volumeDir, "series.db");
    const sidecars = fs
      .readdirSync(volume.volumeDir)
      .filter((name) => /^series\.db(-wal|-shm)$/.test(name))
      .sort();
    state.set(volume.folder, {
      digest: fs.existsSync(file) ? sha256(file) : null,
      sidecars,
    });
  }
  return state;
}

/**
 * Compare two snapshots and name every difference.
 *
 * @param {Map<string, {digest: string|null, sidecars: string[]}>} before
 * @param {Map<string, {digest: string|null, sidecars: string[]}>} after
 * @returns {string[]} One line per change; empty when nothing moved.
 */
function compareRecordState(before, after) {
  const problems = [];
  for (const [folder, was] of before) {
    const now = after.get(folder);
    if (!now) {
      problems.push(`${folder}: the volume folder disappeared`);
      continue;
    }
    if (was.digest !== now.digest) problems.push(`${folder}: series.db digest moved`);
    if (JSON.stringify(was.sidecars) !== JSON.stringify(now.sidecars)) {
      problems.push(`${folder}: sidecars changed from ${was.sidecars.join(",") || "(none)"} to ${now.sidecars.join(",") || "(none)"}`);
    }
  }
  return problems;
}

/**
 * Open a **copy** of one volume's record, read-only, and read its roster.
 *
 * The corpus file is never opened. The copy lives under /tmp/opencode. If the source carries a
 * non-empty write-ahead log the log and its shared-memory sidecar are copied with it, because a copy
 * of the main file alone would be a record missing its newest rows — and the script says which case
 * it took rather than assuming the safe one.
 *
 * @param {{volumeDir: string, folder: string}} volume
 * @returns {{keys: string[], file: string, note: string}|null} Null when the volume has no record.
 */
function readRosterFromCopy(volume) {
  const source = path.join(volume.volumeDir, "series.db");
  if (!fs.existsSync(source)) return null;
  fs.mkdirSync(DB_COPY_DIR, { recursive: true });
  const copy = path.join(DB_COPY_DIR, `volume-${volume.volume}.db`);
  fs.copyFileSync(source, copy);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = path.join(volume.volumeDir, `series.db${suffix}`);
    if (fs.existsSync(sidecar) && fs.statSync(sidecar).size > 0) fs.copyFileSync(sidecar, `${copy}${suffix}`);
  }
  const walBytes = fs.existsSync(path.join(volume.volumeDir, "series.db-wal"))
    ? fs.statSync(path.join(volume.volumeDir, "series.db-wal")).size
    : 0;
  const note = walBytes > 0 ? `write-ahead log copied with it (${walBytes} bytes)` : "write-ahead log empty, main file alone is the whole record";

  // The engine's documented load-time warning is silenced the way utils/reference-store/db.js does it;
  // nothing else about the engine is used here.
  const warningListeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (!/SQLite is an experimental feature/.test(String(warning && warning.message))) {
      for (const listener of warningListeners) listener(warning);
    }
  });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    const keys = db.prepare("SELECT key FROM cast ORDER BY key").all().map((row) => row.key);
    return { keys, file: copy, note };
  } finally {
    db.close();
    process.removeAllListeners("warning");
    for (const listener of warningListeners) process.on("warning", listener);
  }
}

/**
 * The roster the published glossaries hold: every term in every volume's `## Characters` table, read
 * through the store's own markdown parser rather than a second parser written here.
 *
 * @param {Array<{volumeDir: string}>} volumes
 * @returns {{keys: Set<string>, perVolume: Map<string, number>}}
 */
function readRosterFromGlossaries(volumes) {
  /** @type {Set<string>} */
  const keys = new Set();
  /** @type {Map<string, number>} */
  const perVolume = new Map();
  for (const volume of volumes) {
    const file = path.join(volume.volumeDir, "glossary.md");
    if (!fs.existsSync(file)) continue;
    const parsed = parseGlossaryMarkdown(fs.readFileSync(file, "utf8"));
    const terms = parsed.rows.filter((row) => row.section === "Characters").map((row) => row.term);
    perVolume.set(volume.volume, terms.length);
    for (const term of terms) keys.add(term);
  }
  return { keys, perVolume };
}

/**
 * Whether two strings differ by at most one inserted, deleted or replaced character.
 *
 * Used only to name the near misses the guide file produces (the book prints サンちやん, the roster
 * spells サンちゃん) so a later slice knows the exact-match test is not the whole answer.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function withinOneEdit(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x === y) return false;
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i++;
      j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (x.length > y.length) i++;
    else if (x.length < y.length) j++;
    else {
      i++;
      j++;
    }
  }
  edits += Math.max(0, x.length - i) + Math.max(0, y.length - j);
  return edits <= 1;
}

/**
 * Print one candidate group as one line: the reading, then each form with its count, marked when the
 * record already knows that form.
 *
 * @param {import("../utils/source/guide-groups").GuideGroup} group
 * @param {Set<string>} roster
 * @param {string} prefix
 * @returns {string}
 */
function describeGroup(group, roster, prefix) {
  const forms = group.forms
    .map((form) => `${form.form}${roster.has(form.form) ? "*" : ""} x${form.count}`)
    .join(", ");
  return `${prefix}${group.reading}  ←  ${forms}   [${group.volumes.length} volume(s), ${group.occurrences} occurrence(s)]`;
}

/**
 * Run the whole measurement.
 *
 * @returns {void}
 */
function main() {
  const args = readArgs();
  const volumes = volumeHarvests(args.series);
  const before = recordState(volumes);

  console.log(`# plan 07 slice 0 — the guide measurement`);
  console.log(`series: ${args.series}`);
  console.log(`volumes with a harvest: ${volumes.length}`);
  console.log(`model calls: 0. Writes to the corpus: none. Record read: a copy under ${DB_COPY_DIR}.\n`);

  // ── 1. the baseline ────────────────────────────────────────────────────────────────────────────
  /** @type {Array<{volume: string, guides: import("../types").RubyGuideRow[]}>} */
  const harvests = volumes.map((volume) => ({
    volume: volume.volume,
    guides: JSON.parse(fs.readFileSync(path.join(volume.volumeDir, volume.guideFile), "utf8")).guides,
  }));
  /** @type {Array<import("../types").RubyGuideRow & {volume: string}>} */
  const allRows = harvests.flatMap((harvest) => harvest.guides.map((row) => ({ ...row, volume: harvest.volume })));
  console.log("## 1. the harvest baseline");
  console.log(`  files: ${volumes.length}`);
  console.log(`  distinct word-and-reading rows: ${allRows.length}`);
  console.log(`  total occurrences: ${allRows.reduce((sum, row) => sum + row.count, 0)}`);
  console.log(`  characters of reading text: ${allRows.reduce((sum, row) => sum + row.reading.replace(/\s+/g, "").length, 0)}\n`);

  // ── 2. the display subset, and the correction to its multi-form count ──────────────────────────
  const displayRows = allRows.filter((row) => containsHan(row.word) && readingScriptOf(row.reading) === "katakana");
  const displayByReading = new Map();
  for (const row of displayRows) {
    if (!displayByReading.has(row.reading)) displayByReading.set(row.reading, []);
    displayByReading.get(row.reading).push(row);
  }
  const displayMultiForm = [...displayByReading.entries()].filter(([, rows]) => new Set(rows.map((r) => r.word)).size >= 2);
  const displayMultiVolumeForm = [...displayByReading.entries()].filter(
    ([, rows]) => new Set(rows.map((r) => `${r.volume}\u0000${r.word}`)).size >= 2
  );
  const displayMultiVolume = [...displayByReading.entries()].filter(([, rows]) => new Set(rows.map((r) => r.volume)).size >= 2);
  console.log("## 2. the display subset — a Han-script word guided in katakana");
  console.log(`  rows: ${displayRows.length}`);
  console.log(`  distinct readings: ${displayByReading.size}`);
  console.log(`  occurrences: ${displayRows.reduce((sum, row) => sum + row.count, 0)}`);
  console.log(`  readings over 2+ DISTINCT WRITTEN FORMS: ${displayMultiForm.length}`);
  console.log(`  readings over 2+ (volume, form) pairs: ${displayMultiVolumeForm.length}   <- the number plan 07 §2.3 printed as "more than one written form"`);
  console.log(`  readings appearing in 2+ volumes: ${displayMultiVolume.length}`);
  const conflated = displayMultiVolumeForm.filter(([reading, rows]) => new Set(rows.map((r) => r.word)).size < 2);
  console.log(`  of those, printed over exactly ONE written form in several volumes (${conflated.length}):`);
  for (const [reading, rows] of conflated) {
    console.log(`      ${reading} ← ${[...new Set(rows.map((r) => r.word))].join(", ")} in ${new Set(rows.map((r) => r.volume)).size} volumes`);
  }
  console.log(`  the multi-form ones (${displayMultiForm.length}):`);
  for (const [reading, rows] of displayMultiForm) {
    const counts = new Map();
    for (const row of rows) counts.set(row.word, (counts.get(row.word) || 0) + row.count);
    console.log(`      ${reading} ← ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w, c]) => `${w} x${c}`).join(", ")}`);
  }
  console.log();

  // ── 3. the rejected candidate rule, kept runnable ───────────────────────────────────────────────
  const byReadingAll = new Map();
  for (const row of allRows) {
    if (!byReadingAll.has(row.reading)) byReadingAll.set(row.reading, []);
    byReadingAll.get(row.reading).push(row);
  }
  const ruleA = [...byReadingAll.entries()].filter(([, rows]) => new Set(rows.map((r) => r.word)).size >= 2);
  console.log("## 3. candidate rule A — 2+ distinct forms, no other guard (TRIED AND REJECTED)");
  console.log(`  readings: ${ruleA.length}, rows: ${ruleA.reduce((s, [, r]) => s + r.length, 0)}, occurrences: ${ruleA.reduce((s, [, r]) => s + r.reduce((n, x) => n + x.count, 0), 0)}`);
  console.log("  rejected because it is dominated by single-mora phonetic complements: か over 替/嚙/換, と over 取/遂/捕, つ over 尽/突/付.\n");

  // ── 4. the shipped reader ──────────────────────────────────────────────────────────────────────
  const built = collectGuideGroups(harvests);
  const t = built.totals;
  console.log("## 4. the script-neutral candidate set (utils/source/guide-groups.js)");
  console.log(`  rule: the reading is ${GUIDE_GROUP_MIN_READING_CHARS}+ characters long, shares no character with the written form,`);
  console.log(`        is printed over ${GUIDE_GROUP_MIN_FORMS}+ distinct written forms, and at least one of those forms is ${GUIDE_GROUP_MIN_FORM_CHARS}+ characters long.`);
  console.log(`  rows dropped by the reading-length guard: ${t.rowsDroppedByReadingLength}`);
  console.log(`  rows dropped by the shared-character guard: ${t.rowsDroppedBySharedCharacter}   <- measured, and nearly inert: the harvest stores the word ALREADY guide-free, so a reading almost never reuses a character of it`);
  console.log(`  rows skipped for naming no word or no reading: ${t.rowsSkippedWithoutWordOrReading}`);
  console.log(`  readings seen among eligible rows: ${t.groupsSeen}`);
  console.log(`  readings dropped for having 1 form: ${t.groupsDroppedBelowFormFloor}`);
  console.log(`  readings dropped because every form is one character: ${t.groupsDroppedWithEveryFormSingleCharacter}`);
  console.log(`  CANDIDATE GROUPS: ${t.candidateGroups}   rows: ${t.candidateRows}   occurrences: ${t.candidateOccurrences}   distinct written forms: ${t.candidateForms}   volumes touched: ${t.candidateVolumes}`);
  console.log(`  of those, the display filter selects: ${guideGroupDisplaySubset(built.groups).length} groups (the same objects, a view not a rewrite)`);
  console.log(`  asking for the display flag changes nothing: displaySubset=false gives ${collectGuideGroups(harvests, { displaySubset: false }).groups.length} groups, displaySubset=true gives ${built.groups.length}\n`);

  // ── 5. the decisive measurement ────────────────────────────────────────────────────────────────
  const fromGlossaries = readRosterFromGlossaries(volumes);
  let fromRecord = null;
  if (args.useDb) {
    const target = volumes.find((volume) => String(Number(volume.volume)) === String(Number(args.dbVolume)));
    if (!target) {
      console.log(`## 5. the record's own roster: volume ${args.dbVolume} is not in this series; the markdown roster is used alone.\n`);
    } else {
      try {
        fromRecord = readRosterFromCopy(target);
      } catch (error) {
        console.log(`## 5. the record's own roster: the copy of volume ${target.volume} could not be opened (${error.message}); the markdown roster is used alone.\n`);
      }
    }
  }

  console.log("## 5. can the record separate the identity-bearing groups from the homophone noise?");
  console.log(`  roster from the published glossary Characters rows: ${fromGlossaries.keys.size} entries`);
  if (fromRecord) {
    console.log(`  roster from a COPY of volume ${args.dbVolume}'s series.db (${fromRecord.note}): ${fromRecord.keys.length} entries`);
    console.log(`  the two rosters are the same set: ${new Set(fromRecord.keys).size === fromGlossaries.keys.size && fromRecord.keys.every((key) => fromGlossaries.keys.has(key))}`);
  }
  for (const [label, roster] of [["glossary markdown", fromGlossaries.keys], ...(fromRecord ? [[`copy of volume ${args.dbVolume} cast table`, new Set(fromRecord.keys)]] : [])]) {
    const mixed = [];
    const allKnown = [];
    const noneKnown = [];
    for (const group of built.groups) {
      const known = group.forms.filter((form) => roster.has(form.form));
      if (known.length > 0 && known.length < group.forms.length) mixed.push(group);
      else if (known.length > 0) allKnown.push(group);
      else noneKnown.push(group);
    }
    console.log(`\n  roster source: ${label}`);
    console.log(`    at least one form known AND at least one form unknown: ${mixed.length}`);
    console.log(`    every form known: ${allKnown.length}`);
    console.log(`    no form known: ${noneKnown.length}`);
    console.log(`    at least one form known (either way): ${mixed.length + allKnown.length}`);
    console.log("    --- groups with at least one form the record already knows:");
    for (const group of [...mixed, ...allKnown]) console.log(describeGroup(group, roster, "      "));
    console.log("    --- groups with NO form the record knows:");
    for (const group of noneKnown) console.log(describeGroup(group, roster, "      "));
  }

  // ── 6. the second signal ───────────────────────────────────────────────────────────────────────
  const roster = fromRecord ? new Set(fromRecord.keys) : fromGlossaries.keys;
  const readingIsRoster = built.groups.filter((group) => roster.has(group.reading));
  const formOrReadingIsRoster = built.groups.filter((group) => roster.has(group.reading) || group.forms.some((form) => roster.has(form.form)));
  const nearMisses = built.groups.filter(
    (group) => !roster.has(group.reading) && [...roster].some((key) => withinOneEdit(group.reading, key))
  );
  console.log("\n## 6. the second signal, and the near misses");
  console.log(`  groups whose READING is itself a roster entry: ${readingIsRoster.length} — ${readingIsRoster.map((g) => g.reading).join(", ")}`);
  console.log(`  groups selected by (a form is a roster entry) OR (the reading is one): ${formOrReadingIsRoster.length} of ${built.groups.length}`);
  console.log(`  groups left out: ${built.groups.length - formOrReadingIsRoster.length}`);
  console.log(`  readings within one edit of a roster entry but not equal to one: ${nearMisses.length}`);
  for (const group of nearMisses) {
    const close = [...roster].filter((key) => withinOneEdit(group.reading, key));
    console.log(`      ${group.reading} vs ${close.join(", ")}`);
  }
  console.log(`  groups the display filter selects that the roster rule does not: ${built.groups.filter((group) => isGuideGroupKatakanaOverHanForm(group) && !formOrReadingIsRoster.includes(group)).map((group) => group.reading).join(", ") || "(none)"}`);

  // ── 7. the safety proof ────────────────────────────────────────────────────────────────────────
  const after = recordState(volumes);
  const problems = compareRecordState(before, after);
  console.log("\n## 7. corpus left alone");
  console.log(`  volumes checked: ${before.size}`);
  if (problems.length === 0) {
    console.log("  every series.db digest unchanged, every -wal/-shm sidecar still present: OK");
  } else {
    console.log("  PROBLEMS:");
    for (const problem of problems) console.log(`    ${problem}`);
    process.exitCode = 1;
  }
}

main();

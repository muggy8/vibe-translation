#!/usr/bin/env node
/**
 * test/measure-annotated-view.js — plan 07 slice 5's acceptance line, on the **live corpus**, on **copies**
 * of the 17 records. Zero model calls. Nothing in the corpus is written.
 *
 * ## What it measures
 *
 * The three steps of the slice, in order, over the real books:
 *
 *   1. **file** — the shipped written-forms door files each volume's own harvest into a **copy** of that
 *      volume's record (8,910 rows / 41,710 occurrences across 17 volumes, plan 07 §2.2's numbers), and a
 *      second pass over the same copy files **0**;
 *   2. **select** — `annotatedFormsForVolume` answers, from those rows plus that volume's own extracted text,
 *      which written forms a view may put a guide over, with every refusal tallied by rule;
 *   3. **render** — `annotateChapterText` actually builds the annotated chapter for all 133 chapters, and the
 *      script asserts the strip invariant on every one of them and counts the characters the markup adds.
 *
 * ## The four numbers plan 07 §2.12 promised, and what the shipped door produces
 *
 * §2.12's second row says: the renames, plus a guide the author applies **every single time** and the series
 * uses **at most twice** — **4,808 forms / 6,739 occurrences / +192,251 characters (7.8% of 2,450,316)**.
 * This script prints that row beside what the shipped selection rule reproduces, and the gap, rather than
 * printing one of them and calling it the result. The gap is not rounding; it is three named differences in
 * the rule, and they are written up in plan 07 §5's slice-5 verdict and in
 * `/tmp/opencode/plan07-slice5-questions.md`:
 *
 *   - **"at most twice" is per volume, not series-wide.** Counted per book the bound leaves 4,606 always-guided
 *     forms; counted across the whole series it leaves 1,857. §2.12's number is neither.
 *   - **The equality guard is load-bearing.** A form guided **fewer** times than the volume prints it cannot be
 *     annotated at every printed occurrence without inventing guides: 2,532 forms, 21,082 guided against
 *     64,326 printed, which would print **43,244 guides the author never wrote**. §2.12's 4,808 counts forms
 *     this rule refuses.
 *   - **The character column is not reproducible from the shipped markup shape.** One annotation costs
 *     `<ruby></ruby><rt></rt>` (22 characters) plus the reading. Over §2.12's own 6,739 occurrences that is
 *     176,271 characters, not 192,251; a grid search over per-occurrence, per-piece and per-reading-character
 *     costs found no model that fits all four of §2.12's rows (best fit 1.7% off). The plan's number is
 *     reported as a gap, not quietly adopted.
 *
 * All four of §2.12's rows are **recomputed here** — `plan212Rows` folds the 17 harvests into (volume, form)
 * pairs, counts each form's printed occurrences in its own volume's text, and prices each row with the markup
 * shape `annotateChapterText` emits. So every number the plan quotes is printed by a file in the repository,
 * including the 176,271 above and the 43,244 invented guides.
 *
 * ## Why it is safe to read the corpus
 *
 * The same rule gotcha 124 states: **a corpus `series.db` is never opened.** Each volume's record is copied
 * with `fs.copyFileSync` (plus its `-wal` / `-shm` when the log is non-empty) into
 * `/tmp/opencode/plan07-slice5/measure-db-copy/`, the **copy** is opened, and the door writes into the copy.
 * `copyFileSync` and not `copyDatabase`, because `copyDatabase` opens the source (gotcha 166). The script
 * hashes all 17 digests and lists all 17 sidecar sets before its own run and again after it, and **fails its
 * own run** if any digest moved, any size changed, or any sidecar appeared or disappeared — and it re-reads
 * the corpus row count out of a copy, so "this script filed nothing into a book" is a number.
 *
 * The books themselves are read only as text files (the harvest, the bundle manifest, the chapter files),
 * which is what the selection rule needs and what no door in the store is allowed to do on its own.
 *
 * Usage:
 *   node test/measure-annotated-view.js [--series=<series folder>] [--limit=N] [--no-rename-classification]
 *
 * @module test/measure-annotated-view
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");
const rs = require("../utils/reference-store");
const {
  openReferenceStore,
  openDatabase,
  readSchemaVersion,
  fileVolumeWrittenForms,
  writtenFormCounts,
  writtenFormsInRecord,
  annotatedFormsForVolume,
  annotateChapterText,
  VIEW_MAX_USES_PER_VOLUME,
} = rs;
const { stripRubyMarkup, rubyMarkupAddedChars, RUBY_MARKUP_OVERHEAD_CHARS } = require("../utils/reference-store/ruby-markup");

/** Default series folder: the live corpus this repository writes its artifacts into. */
const DEFAULT_SERIES = path.resolve(__dirname, "..", "..");

/** Where the throwaway copies of the records are put (gotcha 124, gotcha 166). */
const DB_COPY_DIR = "/tmp/opencode/plan07-slice5/measure-db-copy";

/**
 * plan 07 §2.12's second row, kept here as the number this script is measured AGAINST, not as a number it
 * is allowed to print as its own result.
 */
const PLAN_212 = { forms: 4808, occurrences: 6739, addedChars: 192251, percent: 7.8 };

/** plan 07 §2.2's filing numbers, which this script must reproduce or fail. */
const EXPECTED_FILING = { rows: 8910, occurrences: 41710, harvestRows: 10005, harvestOccurrences: 45429 };

/**
 * sha256 of a file, hex.
 * @param {string} file @returns {string}
 */
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Read the command line.
 * @returns {{series: string, limit: number|null, classifyRenames: boolean}}
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
    limit: limit === null ? null : Number(limit),
    classifyRenames: !argv.includes("--no-rename-classification"),
  };
}

/**
 * Every volume folder that holds a pronunciation-guide harvest, in reading order, with its extracted text.
 *
 * Refuses when the corpus is absent or holds no harvest: a measurement that prints zeros because it could not
 * find the books is a measurement that reports the books as empty.
 *
 * @param {string} seriesDir
 * @returns {Array<{folder: string, volume: string, volumeDir: string, base: string, chapters: Array<{id: string, file: string, text: string}>, harvest: Object}>}
 */
function readVolumes(seriesDir) {
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
      `refused: no volume folder under ${seriesDir} holds a ${RUBY_GUIDE_FILE_SUFFIX} file. Run ` +
        "`npx gulp extract` first, or point --series= at the series folder that has one."
    );
    process.exit(2);
  }
  return folders.map((folder) => {
    const volumeDir = path.join(seriesDir, folder);
    const guideFile = fs.readdirSync(volumeDir).find((n) => n.endsWith(RUBY_GUIDE_FILE_SUFFIX));
    const base = guideFile.slice(0, -RUBY_GUIDE_FILE_SUFFIX.length);
    const meta = JSON.parse(fs.readFileSync(path.join(volumeDir, `${base}-bundle.meta.json`), "utf8"));
    const chapters = (meta.segments || []).map((segment) => ({
      id: segment.id,
      file: segment.file,
      text: fs.readFileSync(path.join(volumeDir, segment.file), "utf8"),
    }));
    return {
      folder,
      volume: (folder.match(/\((\d+)\)/) || [])[1] || folder,
      volumeDir,
      base,
      chapters,
      harvest: JSON.parse(fs.readFileSync(path.join(volumeDir, guideFile), "utf8")),
    };
  });
}

/**
 * Snapshot every volume's `series.db` digest, size and sidecar presence (gotcha 124).
 * @param {Array<{folder: string, volumeDir: string}>} volumes
 * @returns {Map<string, {digest: string|null, bytes: number|null, sidecars: string[]}>}
 */
function recordState(volumes) {
  /** @type {Map<string, {digest: string|null, bytes: number|null, sidecars: string[]}>} */
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
 * @param {Map<string, Object>} before @param {Map<string, Object>} after @returns {string[]}
 */
function compareRecordState(before, after) {
  /** @type {string[]} */ const problems = [];
  for (const [folder, was] of before) {
    const now = after.get(folder);
    if (!now) {
      problems.push(`${folder}: the volume folder disappeared`);
      continue;
    }
    if (was.digest !== now.digest) problems.push(`${folder}: series.db digest moved (${String(was.digest).slice(0, 12)} → ${String(now.digest).slice(0, 12)})`);
    if (was.bytes !== now.bytes) problems.push(`${folder}: series.db size moved ${was.bytes} → ${now.bytes} bytes`);
    if (JSON.stringify(was.sidecars) !== JSON.stringify(now.sidecars)) {
      problems.push(`${folder}: sidecars changed from ${was.sidecars.join(",") || "(none)"} to ${now.sidecars.join(",") || "(none)"}`);
    }
  }
  return problems;
}

/**
 * Copy one volume's record into the scratch folder and open **the copy**.
 *
 * @param {{volumeDir: string, folder: string, volume: string}} volume
 * @param {{recopy?: boolean}} [opts]
 * @returns {{store: Object, copy: string, note: string}|null} Null when the volume has no record.
 */
function openRecordCopy(volume, { recopy = true } = {}) {
  const source = path.join(volume.volumeDir, "series.db");
  if (!fs.existsSync(source)) return null;
  const targetDir = path.join(DB_COPY_DIR, volume.folder);
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, "series.db");
  let note = "opened the copy already on disk";
  if (recopy) {
    fs.copyFileSync(source, target);
    const wal = path.join(volume.volumeDir, "series.db-wal");
    const walBytes = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
    if (walBytes > 0) {
      fs.copyFileSync(wal, path.join(targetDir, "series.db-wal"));
      const shm = path.join(volume.volumeDir, "series.db-shm");
      if (fs.existsSync(shm)) fs.copyFileSync(shm, path.join(targetDir, "series.db-shm"));
    }
    note = `copied with fs.copyFileSync${walBytes > 0 ? ` (+ a ${walBytes}-byte -wal)` : " (no -wal to copy)"}`;
  }
  const store = openReferenceStore({ volume: Number(volume.volume), folder: volume.folder, seriesDir: DB_COPY_DIR, stage: "merge" });
  return { store, copy: target, note };
}

/**
 * Count non-overlapping occurrences of a form across a list of texts.
 *
 * An empty form returns 0 rather than looping: `indexOf("")` matches at position 0 forever, and the real
 * corpus has exactly one harvest row with no base word (volume 11 guides マイナス over nothing at all) — the
 * row the store's own filing door refuses, because a written-form row needs both halves (gotcha 164).
 *
 * @param {string[]} pieces @param {string} form @returns {number}
 */
function countIn(pieces, form) {
  const word = String(form === undefined || form === null ? "" : form);
  if (!word) return 0;
  let total = 0;
  for (const piece of pieces) {
    let at = piece.indexOf(word);
    while (at !== -1) {
      total += 1;
      at = piece.indexOf(word, at + word.length);
    }
  }
  return total;
}

/**
 * Reproduce plan 07 §2.12's four view rows **from the harvests**, and price each one with the markup shape the
 * shipped renderer actually emits (`RUBY_MARKUP_OVERHEAD_CHARS` fixed characters per annotation, plus the
 * reading's own characters).
 *
 * This is here because §2.12's added-character column is the number the plan's decision was made on, and the
 * slice-5 verdict says that column does not reproduce. A verdict that quotes a number must print it.
 *
 * **It is a measurement, so it is allowed to name a writing system.** The rename half of §2.12 is "a form given
 * a reading in one particular script", and no script-neutral rule reproduces its 202 / 1,033 (plan 07 §6 item
 * 11). The selection door holds no such rule; this file states one so the plan's row can be checked.
 *
 * @param {Array<{volume: string, chapters: Array<{text: string}>, harvest: Object}>} volumes
 * @returns {{rows: Array<{name: string, pairs: number, occurrences: number, addedChars: number}>, pairsTotal: number, notEveryTime: {pairs: number, guided: number, printed: number}, severalWays: number, perVolumeBound: {pairs: number, occurrences: number}, perVolumeBoundNotRename: {pairs: number, occurrences: number}, seriesWide: number, seriesWideNotRename: number, longestForm: {form: string, reading: string}, rowsWithNoForm: number}}
 */
function plan212Rows(volumes) {
  /** @type {Map<string, {volume: string, form: string, readings: Array<{reading: string, script: string, count: number}>, guided: number, printed: number}>} */
  const byForm = new Map();
  let rowsWithNoForm = 0;
  for (const volume of volumes) {
    const texts = volume.chapters.map((chapter) => chapter.text);
    for (const row of volume.harvest.guides || []) {
      if (!String(row.word || "").trim()) {
        rowsWithNoForm += 1;
        continue;
      }
      const key = `${volume.volume}|${row.word}`;
      if (!byForm.has(key)) {
        byForm.set(key, { volume: volume.volume, form: row.word, readings: [], guided: 0, printed: countIn(texts, row.word) });
      }
      const entry = byForm.get(key);
      entry.readings.push({ reading: row.reading, script: row.readingScript || "", count: Number(row.count) || 1 });
      entry.guided += Number(row.count) || 1;
    }
  }
  const entries = [...byForm.values()];
  const isRename = (entry) => entry.readings.some((reading) => reading.script === "katakana");
  const alwaysGuided = (entry) => entry.guided === entry.printed;
  const costOf = (entry) =>
    entry.readings.reduce((sum, reading) => sum + reading.count * (RUBY_MARKUP_OVERHEAD_CHARS + reading.reading.length), 0);

  const rowDefs = [
    ["the renames only", (entry) => isRename(entry)],
    ["renames + always-guided and <= 2", (entry) => isRename(entry) || (alwaysGuided(entry) && entry.guided <= 2)],
    ["every always-guided form", (entry) => alwaysGuided(entry)],
    ["every guide the converter set aside", () => true],
  ];
  const rows = rowDefs.map(([name, pick]) => {
    const chosen = entries.filter(pick);
    return {
      name,
      pairs: chosen.length,
      occurrences: chosen.reduce((sum, entry) => sum + entry.guided, 0),
      addedChars: chosen.reduce((sum, entry) => sum + costOf(entry), 0),
    };
  });

  const notEveryTime = entries.filter((entry) => entry.guided !== entry.printed);
  const withinBound = entries.filter((entry) => alwaysGuided(entry) && entry.guided <= 2);
  const withinBoundNotRename = withinBound.filter((entry) => !isRename(entry));
  const guidedByForm = new Map();
  for (const entry of entries) guidedByForm.set(entry.form, (guidedByForm.get(entry.form) || 0) + entry.guided);
  const seriesWide = withinBound.filter((entry) => guidedByForm.get(entry.form) <= 2);
  const longest = withinBound.reduce(
    (best, entry) => (entry.readings[0] && entry.readings[0].reading.length + entry.form.length > best.form.length + best.reading.length ? { form: entry.form, reading: entry.readings[0].reading } : best),
    { form: "", reading: "" }
  );
  return {
    rows,
    pairsTotal: entries.length,
    notEveryTime: {
      pairs: notEveryTime.length,
      guided: notEveryTime.reduce((sum, entry) => sum + entry.guided, 0),
      printed: notEveryTime.reduce((sum, entry) => sum + entry.printed, 0),
    },
    severalWays: entries.filter((entry) => entry.readings.length > 1).length,
    perVolumeBound: { pairs: withinBound.length, occurrences: withinBound.reduce((sum, entry) => sum + entry.guided, 0) },
    perVolumeBoundNotRename: { pairs: withinBoundNotRename.length, occurrences: withinBoundNotRename.reduce((sum, entry) => sum + entry.guided, 0) },
    seriesWide: seriesWide.length,
    seriesWideNotRename: seriesWide.filter((entry) => !isRename(entry)).length,
    longestForm: longest,
    rowsWithNoForm,
  };
}

/**
 * The rename classification this measurement supplies, read out of the record's own `reading_script` column.
 *
 * **This is the script-named half of plan 07 §2.12, and it lives here rather than in the door on purpose**
 * (plan 07 §6 question 1, `/tmp/opencode/plan07-slice5-questions.md`): the selection door holds no rule about
 * what a rename is and names no writing system, so a series written in another script gets a view too. This
 * script is a measurement, and a measurement is allowed to name a script.
 *
 * @param {Array<{form: string, readingScript: string}>} rows @returns {Array<{volume: number, form: string}>}
 */
function renameKeysFromScript(rows) {
  const forms = new Set();
  for (const row of rows) if (row.readingScript === "katakana") forms.add(row.form);
  return [...forms].map((form) => ({ volume: 0, form }));
}

/**
 * Run the measurement.
 * @returns {Promise<void>}
 */
async function main() {
  const args = readArgs();
  let volumes = readVolumes(args.series);
  if (args.limit !== null) volumes = volumes.slice(0, args.limit);

  console.log(`series: ${args.series}`);
  console.log(`volumes: ${volumes.length}; copies go to ${DB_COPY_DIR}; 0 model calls\n`);

  const before = recordState(volumes);
  const firstDigest = [...before.values()][0];
  const lastDigest = [...before.values()][volumes.length - 1];
  console.log(`corpus records before: ${before.size} digests, first ${String(firstDigest.digest).slice(0, 12)}, last ${String(lastDigest.digest).slice(0, 12)}`);
  console.log(`sidecars before: ${[...before.values()].reduce((sum, state) => sum + state.sidecars.length, 0)}\n`);

  /** @type {Array<Object>} */ const perVolume = [];
  let sourceChars = 0;
  let chapterCount = 0;
  let invariantFailures = 0;
  let harvestRows = 0;
  let harvestOccurrences = 0;
  let filedRows = 0;
  let filedOccurrences = 0;
  let secondPassFiled = 0;

  const refusalRules = {};

  for (const volume of volumes) {
    const opened = openRecordCopy(volume);
    if (!opened) {
      console.log(`vol ${volume.volume}: no series.db to copy — skipped`);
      continue;
    }
    const texts = volume.chapters.map((chapter) => chapter.text);
    const volumeChars = texts.reduce((sum, text) => sum + text.length, 0);
    sourceChars += volumeChars;
    chapterCount += volume.chapters.length;
    harvestRows += Number(volume.harvest.totals && volume.harvest.totals.rows) || volume.harvest.guides.length;
    harvestOccurrences += Number(volume.harvest.totals && volume.harvest.totals.guides) || 0;

    const pass = await fileVolumeWrittenForms(opened.store, {
      volume: Number(volume.volume),
      harvests: [{ volume: Number(volume.volume), guides: volume.harvest.guides }],
    });
    if (!pass.ok) {
      console.log(`vol ${volume.volume}: the filing door refused — ${JSON.stringify(pass.refusal)}`);
      opened.store.close();
      continue;
    }
    const counts = writtenFormCounts(opened.store);
    const rows = writtenFormsInRecord(opened.store, { volume: Number(volume.volume) });
    const volumeOccurrences = rows.reduce((total, row) => total + row.occurrences, 0);
    filedRows += counts.thisVolume;
    filedOccurrences += volumeOccurrences;
    const renameForms = args.classifyRenames ? renameKeysFromScript(rows).map((entry) => ({ volume: Number(volume.volume), form: entry.form })) : [];

    const selection = annotatedFormsForVolume(opened.store, { volume: Number(volume.volume), volumeText: texts, renameForms });
    if (!selection.ok) {
      console.log(`vol ${volume.volume}: the view refused — ${selection.refusal.rule}`);
      opened.store.close();
      continue;
    }

    // Render every chapter, and check the invariant on each one.
    let renderedOccurrences = 0;
    let renderedAddedChars = 0;
    for (const chapter of volume.chapters) {
      const rendered = annotateChapterText(chapter.text, { forms: selection.forms, label: chapter.id });
      if (!rendered.ok) {
        invariantFailures += 1;
        console.log(`vol ${volume.volume} ${chapter.id}: the annotator refused — ${rendered.refusal.rule}`);
        continue;
      }
      if (stripRubyMarkup(rendered.text) !== chapter.text) {
        invariantFailures += 1;
        console.log(`vol ${volume.volume} ${chapter.id}: STRIP INVARIANT BROKEN`);
      }
      renderedOccurrences += rendered.totals.annotatedOccurrences;
      renderedAddedChars += rendered.totals.addedChars;
    }

    for (const item of selection.refused) {
      refusalRules[item.rule] = refusalRules[item.rule] || { forms: 0, guided: 0, printed: 0 };
      refusalRules[item.rule].forms += 1;
      refusalRules[item.rule].guided += item.guided;
      refusalRules[item.rule].printed += item.printed;
    }

    const selectedRename = selection.forms.filter((form) => form.reason === "named-rename");
    perVolume.push({
      volume: volume.volume,
      chapters: volume.chapters.length,
      chars: volumeChars,
      filedRows: counts.thisVolume,
      filedOccurrences: counts.occurrences,
      formsInRecord: selection.totals.formsInRecord,
      selected: selection.totals.formsSelected,
      selectedOccurrences: selection.totals.guidedOccurrences,
      renameForms: renameForms.length,
      selectedRename: selectedRename.length,
      renameOccurrences: selectedRename.reduce((sum, form) => sum + form.guided, 0),
      addedChars: selection.totals.addedChars,
      renderedOccurrences,
      renderedAddedChars,
      refused: selection.totals.formsRefused,
    });

    // A second pass over the SAME copy: the door files 0, and the selection answers the same question.
    const again = await fileVolumeWrittenForms(opened.store, { volume: Number(volume.volume) });
    secondPassFiled += again.rowsFiled;

    opened.store.close();
  }

  const sum = (fn) => perVolume.reduce((total, row) => total + fn(row), 0);

  console.log("vol  chapters      chars  filedRows  filedOcc  forms  SELECTED  selectedOcc  renames  selRen  addedChars  renderedOcc  renderedAdded");
  for (const row of perVolume) {
    console.log(
      `${String(row.volume).padStart(4)}  ${String(row.chapters).padStart(8)} ${String(row.chars).padStart(10)} ${String(row.filedRows).padStart(9)} ` +
        `${String(row.filedOccurrences).padStart(9)} ${String(row.formsInRecord).padStart(6)} ${String(row.selected).padStart(9)} ` +
        `${String(row.selectedOccurrences).padStart(11)} ${String(row.renameForms).padStart(8)} ${String(row.selectedRename).padStart(6)} ` +
        `${String(row.addedChars).padStart(11)}  ${String(row.renderedOccurrences).padStart(12)} ${String(row.renderedAddedChars).padStart(13)}`
    );
  }

  console.log("\nrefusals, by rule:");
  for (const [rule, tally] of Object.entries(refusalRules)) {
    console.log(`  ${rule}: ${tally.forms} form(s), ${tally.guided} guided occurrences against ${tally.printed} printed occurrences`);
  }

  const selected = sum((row) => row.selected);
  const selectedOccurrences = sum((row) => row.selectedOccurrences);
  const addedChars = sum((row) => row.addedChars);
  const renderedOccurrences = sum((row) => row.renderedOccurrences);
  const renderedAddedChars = sum((row) => row.renderedAddedChars);
  const renames = sum((row) => row.selectedRename);
  const renameOccurrences = sum((row) => row.renameOccurrences);

  console.log("\nwhat the shipped doors reproduce:");
  console.log(`  harvest: ${harvestRows} rows / ${harvestOccurrences} occurrences (plan 07 §2.2: ${EXPECTED_FILING.harvestRows} / ${EXPECTED_FILING.harvestOccurrences})`);
  console.log(`  filed into the copies: ${filedRows} rows / ${filedOccurrences} occurrences (plan 07 §2.2: ${EXPECTED_FILING.rows} / ${EXPECTED_FILING.occurrences})`);
  console.log(`  a second pass over the same copies filed: ${secondPassFiled}`);
  console.log(`  SELECTED: ${selected} (volume, form) pairs / ${selectedOccurrences} guided occurrences / +${addedChars} characters over ${sourceChars} source characters (${((addedChars / sourceChars) * 100).toFixed(2)}%)`);
  console.log(`  of which named renames: ${renames} pairs / ${renameOccurrences} occurrences`);
  console.log(`  RENDERED over all ${chapterCount} chapters: ${renderedOccurrences} annotated occurrences / +${renderedAddedChars} characters (${((renderedAddedChars / sourceChars) * 100).toFixed(2)}%)`);
  console.log(`  strip invariant failures: ${invariantFailures}`);

  const plan212 = plan212Rows(volumes);
  console.log("\nplan 07 §2.12's four rows, recomputed from the harvests and priced with the shipped markup shape:");
  console.log("  row".padEnd(44), "pairs".padStart(7), "guidedOcc".padStart(11), "addedChars".padStart(12), "percent".padStart(8));
  for (const row of plan212.rows) {
    console.log(`  ${row.name}`.padEnd(44), String(row.pairs).padStart(7), String(row.occurrences).padStart(11), String(row.addedChars).padStart(12), `${((row.addedChars / sourceChars) * 100).toFixed(2)}%`.padStart(8));
  }
  console.log(`  "at most twice" counted PER VOLUME: ${plan212.perVolumeBound.pairs} pairs / ${plan212.perVolumeBound.occurrences} occurrences, or ${plan212.perVolumeBoundNotRename.pairs} pairs / ${plan212.perVolumeBoundNotRename.occurrences} occurrences with the renames taken out; counted across the WHOLE SERIES: ${plan212.seriesWide} pairs, or ${plan212.seriesWideNotRename} without the renames`);
  console.log(`  forms NOT guided as often as the volume prints them, over the whole harvest (${plan212.pairsTotal} pairs, before the store's row guards): ${plan212.notEveryTime.pairs} pairs, ${plan212.notEveryTime.guided} guided against ${plan212.notEveryTime.printed} printed — annotating every printed place would invent ${plan212.notEveryTime.printed - plan212.notEveryTime.guided} guides`);
  console.log(`  forms guided more than one way: ${plan212.severalWays}`);
  console.log(`  harvest rows naming no written form (the store's filing door refuses every one): ${plan212.rowsWithNoForm}`);
  console.log(`  longest annotated pair in the always-guided ≤ 2 set: "${plan212.longestForm.form}" → "${plan212.longestForm.reading}"`);

  console.log("\nplan 07 §2.12's second row, beside what the shipped rule produces:");
  console.log(`  §2.12 promised: ${PLAN_212.forms} forms / ${PLAN_212.occurrences} occurrences / +${PLAN_212.addedChars} characters (${PLAN_212.percent}%)`);
  console.log(`  shipped door:   ${selected} forms / ${selectedOccurrences} occurrences / +${addedChars} characters (${((addedChars / sourceChars) * 100).toFixed(2)}%)`);
  console.log(`  gap:            ${selected - PLAN_212.forms} forms / ${selectedOccurrences - PLAN_212.occurrences} occurrences / ${addedChars - PLAN_212.addedChars} characters`);
  console.log(`  markup model:   one annotation costs ${RUBY_MARKUP_OVERHEAD_CHARS} fixed characters + the reading; over §2.12's own ${PLAN_212.occurrences} occurrences the shipped shape cannot reach +${PLAN_212.addedChars}`);

  // The corpus-left-alone proof. The digest comparison is the strong one; the row count is read out of a
  // **standalone copy** opened read-only, so no copy-forward pass can carry a filed row into it.
  const after = recordState(volumes);
  const problems = compareRecordState(before, after);
  const lastVolume = volumes[volumes.length - 1];
  const proofDir = path.join(DB_COPY_DIR, "_proof");
  fs.mkdirSync(proofDir, { recursive: true });
  const proofCopy = path.join(proofDir, "series.db");
  fs.copyFileSync(path.join(lastVolume.volumeDir, "series.db"), proofCopy);
  const walPath = path.join(lastVolume.volumeDir, "series.db-wal");
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    fs.copyFileSync(walPath, path.join(proofDir, "series.db-wal"));
    const shmPath = path.join(lastVolume.volumeDir, "series.db-shm");
    if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, path.join(proofDir, "series.db-shm"));
  }
  const proofDb = openDatabase(proofCopy, { readOnly: true });
  const proofSchema = readSchemaVersion(proofDb);
  const proofTable = proofDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='written_forms'").get();
  const corpusRows = proofTable ? proofDb.prepare("SELECT COUNT(*) AS n FROM written_forms").get().n : 0;
  proofDb.close();

  console.log("\ncorpus left alone:");
  console.log(`  digests after: ${after.size}; moved: ${problems.length}`);
  for (const problem of problems) console.log(`  !! ${problem}`);
  console.log(`  the corpus's own cumulative record (volume ${lastVolume.volume}) is at schema ${proofSchema}; its copy holds a written_forms table: ${proofTable ? "yes" : "no"}; rows: ${corpusRows}`);
  console.log("  model calls: 0");

  /** @type {string[]} */ const failures = [];
  if (harvestRows !== EXPECTED_FILING.harvestRows || harvestOccurrences !== EXPECTED_FILING.harvestOccurrences) {
    failures.push(`the harvest baseline moved off plan 07 §2.2 (${EXPECTED_FILING.harvestRows} / ${EXPECTED_FILING.harvestOccurrences})`);
  }
  if (filedRows !== EXPECTED_FILING.rows || filedOccurrences !== EXPECTED_FILING.occurrences) {
    failures.push(`the filing door did not reproduce plan 07 §2.2 (${EXPECTED_FILING.rows} / ${EXPECTED_FILING.occurrences})`);
  }
  if (secondPassFiled !== 0) failures.push(`a second pass over the same copies filed ${secondPassFiled} row(s), and idempotence is the acceptance line`);
  if (invariantFailures !== 0) failures.push(`${invariantFailures} chapter(s) failed stripRubyMarkup(annotate(text)) === text`);
  if (problems.length) failures.push(`${problems.length} corpus record(s) changed`);
  if (corpusRows !== 0) failures.push(`the corpus record itself holds ${corpusRows} written_forms rows, and this script was told to file nothing into a book`);
  if (selected > PLAN_212.forms) failures.push(`the view selected ${selected} forms, more than §2.12's ${PLAN_212.forms}: the bound is not holding`);
  const row2 = plan212.rows[1];
  if (row2.pairs !== PLAN_212.forms || row2.occurrences !== PLAN_212.occurrences) {
    failures.push(`§2.12's second row no longer reproduces from the harvests (${row2.pairs} / ${row2.occurrences} against ${PLAN_212.forms} / ${PLAN_212.occurrences}) — the row the owner's decision was made on has moved`);
  }

  if (failures.length) {
    console.log("\nFAILED:");
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\nmeasured: the filing reproduces §2.2, the second pass costs 0, every chapter round-trips, and the corpus is untouched.");
  console.log(`the view's set is ${selected} / ${selectedOccurrences} / +${addedChars}, which is NOT §2.12's ${PLAN_212.forms} / ${PLAN_212.occurrences} / +${PLAN_212.addedChars} — see plan 07 §5's slice-5 verdict.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

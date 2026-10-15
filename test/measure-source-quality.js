#!/usr/bin/env node
/**
 * test/measure-source-quality.js — plan 07 slice 2b: run the two source-quality reports over the **live
 * corpus** on a **copy** of the last volume's record, print every number the slice's acceptance line rests
 * on, and print the widths beside the defects so plan 07 §6.5's decision can be made against a measurement.
 * Zero model calls. Nothing in the corpus is written.
 *
 * ## What it measures
 *
 *   1. the harvest baseline, per volume, and what the two **row** guards kept;
 *   2. the variant-spelling report, against plan 07 §2.10's pinned **25 / 166 / 1,561** and
 *     **54 / 334 / 5,771**, with every variant group printed;
 *   3. the inconsistent-guidance report's **widths** — the loose count, the two chapter-scoped counts, and
 *     the four buckets that add up to the second one;
 *   4. the **defects** it names, in full, and the fact that 董子 and 如雨露 are not among them;
 *   5. the **rejected** "10× more common" rule, run against the same collisions, side by side, with what it
 *     flags and what it misses;
 *   6. idempotence: the same record gives the same answer, and the same **bytes**; and re-filing the last
 *      volume's harvest into the same copy files **0** new rows and reports every one already filed;
 *   7. the corpus-left-alone proof: every `series.db` digest and every `-wal` / `-shm` sidecar, before and
 *     after, compared.
 *
 * ## Why it reads the live corpus, and why that is safe
 *
 * The other measurement scripts in this folder refuse the corpus; this one needs it because the whole point
 * of slice 2b is a defect that exists only in a real book. What makes it safe is gotcha 124 and gotcha 166:
 * **a corpus `series.db` is never opened.** The record is copied with `fs.copyFileSync` into
 * `/tmp/opencode/plan07-slice2b/measure-db-copy/`, the copy is opened, and every write lands in the copy.
 * `copyFileSync` and not `utils/reference-store/db.js`'s `copyDatabase`, because `copyDatabase` opens the
 * source, and opening the source is the thing that silently rewrites the folder the record lives in.
 *
 * It files nothing in the corpus, declares nothing, calls no model, and is **not** part of `npm test` and
 * not an npm script: it depends on books that are not in this repository (AGENTS.md rule 8), and
 * `test/test-source-quality-reports.js` is the fixture that carries its rules.
 *
 * Usage:
 *   node test/measure-source-quality.js [--series=<series folder>] [--roster-volume=17] [--limit=N]
 *
 * @module test/measure-source-quality
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");
const rs = require("../utils/reference-store");
const {
  COUNTED_TABLES,
  fileVolumeWrittenForms,
  readWrittenFormHarvest,
  writtenFormCounts,
  rosterKeysInRecord,
  candidateGroupsInRecord,
  splitGroupsByRoster,
  variantSpellingReport,
  inconsistentGuidanceReport,
  naiveFrequencyCandidates,
  VARIANT_REPORT_FILES,
  GUIDANCE_REPORT_FILES,
} = rs;

/** Default series folder: the live corpus this repository writes its artifacts into. */
const DEFAULT_SERIES = path.resolve(__dirname, "..", "..");

/** Where the throwaway copy of the record is put (gotcha 124, gotcha 166). */
const DB_COPY_DIR = "/tmp/opencode/plan07-slice2b/measure-db-copy";

/** Where the two reports are written. Never a volume folder, never the series root. */
const OUT_DIR = "/tmp/opencode/plan07-slice2b/measure-out";

/**
 * plan 07 §2.10's numbers, pinned so the script can say whether it reproduced them rather than print
 * whatever came out and call it a result.
 */
const EXPECTED = {
  harvestRows: 10005,
  harvestOccurrences: 45429,
  filedRows: 8910,
  filedOccurrences: 41710,
  candidateGroups: 97,
  identityBearingGroups: 18,
  unselectedGroups: 79,
  spellingVariantGroups: 25,
  spellingVariantRows: 166,
  spellingVariantOccurrences: 1561,
  soundAlikeGroups: 54,
  soundAlikeRows: 334,
  soundAlikeOccurrences: 5771,
  naiveRawHarvestPairs: 132,
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
 * @returns {{series: string, rosterVolume: number, limit: number|null}}
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
    rosterVolume: Number(pick("roster-volume") || 17),
    limit: limit === null ? null : Number(limit),
  };
}

/**
 * Every volume folder in a series, in book order.
 *
 * @param {string} series
 * @returns {Array<{volume: number, folder: string, dir: string}>}
 */
function findVolumes(series) {
  if (!fs.existsSync(series)) return [];
  const out = [];
  for (const entry of fs.readdirSync(series, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const hit = entry.name.match(/\((\d+)\)$/);
    if (!hit) continue;
    out.push({ volume: Number(hit[1]), folder: entry.name, dir: path.join(series, entry.name) });
  }
  return out.sort((a, b) => a.volume - b.volume);
}

/**
 * Every `series.db` digest and every sidecar, so "the corpus was left alone" is a comparison.
 *
 * @param {Array<{volume: number, folder: string, dir: string}>} volumes
 * @returns {Object<string, {digest: string|null, size: number, sidecars: string[]}>}
 */
function corpusState(volumes) {
  /** @type {Object<string, {digest: string|null, size: number, sidecars: string[]}>} */
  const state = {};
  for (const volume of volumes) {
    const file = path.join(volume.dir, "series.db");
    if (!fs.existsSync(file)) {
      state[volume.folder] = { digest: null, size: 0, sidecars: [] };
      continue;
    }
    state[volume.folder] = {
      digest: sha256(file),
      size: fs.statSync(file).size,
      sidecars: fs.readdirSync(volume.dir).filter((name) => name.startsWith("series.db-")).sort(),
    };
  }
  return state;
}

/**
 * Copy one volume's record into a throwaway series folder and open **the copy**.
 *
 * `fs.copyFileSync`, and the write-ahead log with it, because gotcha 124 and gotcha 166: opening a corpus
 * `series.db` folds its write-ahead log in and deletes the sidecars in the folder it was read from. The
 * corpus file is never opened here — only the copy is.
 *
 * @param {{dir: string, folder: string, volume: number}} volume
 * @returns {{store: Object, copy: string, note: string}|null}
 */
function openCopiedRecord(volume) {
  const source = path.join(volume.dir, "series.db");
  if (!fs.existsSync(source)) return null;
  const scratchVolumeDir = path.join(DB_COPY_DIR, volume.folder);
  fs.mkdirSync(scratchVolumeDir, { recursive: true });
  const copy = path.join(scratchVolumeDir, "series.db");
  fs.copyFileSync(source, copy);
  let walBytes = 0;
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = path.join(volume.dir, `series.db${suffix}`);
    if (fs.existsSync(sidecar) && fs.statSync(sidecar).size > 0) {
      fs.copyFileSync(sidecar, `${copy}${suffix}`);
      if (suffix === "-wal") walBytes = fs.statSync(sidecar).size;
    }
  }
  const note = walBytes > 0 ? `write-ahead log copied with it (${walBytes} bytes)` : "write-ahead log empty, main file alone is the whole record";
  const store = rs.openReferenceStore({ volume: Number(volume.volume), folder: volume.folder, seriesDir: DB_COPY_DIR, stage: "merge" });
  return { store, copy, note };
}

/**
 * Every counted table's row count on an open handle.
 *
 * @param {Object} store
 * @returns {Object<string, number>}
 */
function tableCounts(store) {
  /** @type {Object<string, number>} */
  const out = {};
  for (const table of COUNTED_TABLES) out[table] = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return out;
}

/**
 * The rows one collision list holds that name a given written form or reading.
 *
 * @param {Array<Object>} collisions
 * @param {string} needle - Exact form or reading, or a substring when `partial` is set.
 * @param {boolean} [partial]
 * @returns {Array<string>} Human-readable hits.
 */
function collisionsNaming(collisions, needle, partial = false) {
  const hits = [];
  for (const collision of collisions) {
    const sides = [
      ...(collision.forms || []).map((form) => form.form),
      ...(collision.readings || []).map((reading) => reading.reading),
      collision.form,
      collision.reading,
    ].filter(Boolean);
    if (sides.some((side) => (partial ? String(side).includes(needle) : String(side) === needle))) {
      hits.push(`volume ${collision.volume} ${collision.chapter} ${collision.form || collision.reading} → ${sides.join(" / ")}`);
    }
  }
  return hits;
}

(async () => {
  const args = readArgs();
  const problems = [];
  const volumes = findVolumes(args.series);
  if (!volumes.length) {
    console.error(`measure-source-quality: no volume folders found under ${args.series}.`);
    console.error("This script measures the live corpus; point --series at it, or run test/test-source-quality-reports.js for the fixtures.");
    process.exitCode = 1;
    return;
  }
  const considered = args.limit === null ? volumes : volumes.slice(0, args.limit);

  console.log(`series: ${args.series}`);
  console.log(`volumes: ${considered.length}${args.limit ? ` (limited to ${args.limit})` : ""}`);
  console.log(`record copied and opened: a COPY of volume ${args.rosterVolume}'s series.db, into ${DB_COPY_DIR}`);
  console.log(`reports written to: ${OUT_DIR}\n`);

  const before = corpusState(considered);

  // ── 1. the harvest baseline ────────────────────────────────────────────────────────────────────
  /** @type {Array<{volume: number, guides: Array<Object>, file: string}>} */
  const harvests = [];
  for (const volume of considered) {
    const read = await readWrittenFormHarvest(volume.dir, volume.volume);
    if (!read.harvests.length) {
      problems.push(`volume ${volume.volume} has no ${RUBY_GUIDE_FILE_SUFFIX} file`);
      continue;
    }
    const guides = read.harvests.flatMap((harvest) => harvest.guides);
    harvests.push({ volume: volume.volume, guides, file: read.harvests[0].file });
  }
  const harvestRows = harvests.reduce((sum, harvest) => sum + harvest.guides.length, 0);
  const harvestOccurrences = harvests.reduce((sum, harvest) => sum + harvest.guides.reduce((n, guide) => n + Number(guide.count), 0), 0);
  console.log(`## 1. the harvest`);
  console.log(`  ${harvests.length} volume(s), ${harvestRows} rows, ${harvestOccurrences} guided occurrences`);
  if (args.limit === null && (harvestRows !== EXPECTED.harvestRows || harvestOccurrences !== EXPECTED.harvestOccurrences)) {
    problems.push(`harvest baseline moved: ${harvestRows} rows / ${harvestOccurrences} occurrences against ${EXPECTED.harvestRows} / ${EXPECTED.harvestOccurrences}`);
  }
  console.log();

  // ── 2. build the cumulative copy, the way copy-forward builds a real volume ────────────────────
  const rosterVolume = considered.find((volume) => volume.volume === args.rosterVolume) || considered[considered.length - 1];
  const openedRecord = openCopiedRecord(rosterVolume);
  if (!openedRecord) {
    console.error(`measure-source-quality: volume ${rosterVolume.volume} has no series.db to copy; nothing can be measured.`);
    process.exitCode = 1;
    return;
  }
  const opened = openedRecord.store;
  console.log(`## 2. filing every volume's own harvest into the copy (${openedRecord.note})`);
  for (const harvest of harvests) {
    const pass = await fileVolumeWrittenForms(opened, { volume: harvest.volume, harvests: [{ volume: harvest.volume, guides: harvest.guides }] });
    if (!pass.ok) {
      problems.push(`volume ${harvest.volume} could not be filed: ${pass.refusal && pass.refusal.rule}`);
      continue;
    }
    console.log(`  volume ${String(harvest.volume).padStart(2, "0")}: ${pass.filing.harvestRows} harvest rows → ${pass.rowsFiled} filed (${pass.rowsAlreadyFiled} already there), ${pass.filing.rowsDroppedByReadingLength} refused for a 1-character reading, ${pass.filing.rowsDroppedBySharedCharacter} refused for reusing a character of the word`);
  }
  const counts = writtenFormCounts(opened);
  console.log(`  record now holds ${counts.total} written_forms rows / ${counts.occurrences} occurrences / ${counts.distinctForms} distinct forms / ${counts.distinctReadings} distinct readings`);
  if (args.limit === null && (counts.total !== EXPECTED.filedRows || counts.occurrences !== EXPECTED.filedOccurrences)) {
    problems.push(`filed rows moved: ${counts.total} / ${counts.occurrences} against ${EXPECTED.filedRows} / ${EXPECTED.filedOccurrences}`);
  }
  console.log();

  // ── 3. the variant-spelling report ─────────────────────────────────────────────────────────────
  const variant = variantSpellingReport(opened, { out: OUT_DIR });
  if (!variant.ok) {
    problems.push(`the variant report refused: ${variant.refusal.rule} — ${variant.refusal.because}`);
  } else {
    console.log(`## 3. variant spellings (roster: the copy's own cast table, ${variant.roster.entries} entries)`);
    console.log(`  candidate groups: ${variant.groups.total} — ${variant.groups.identityBearing} the roster selects, ${variant.groups.unselected} it cannot see`);
    console.log(`  spelling variants: ${variant.totals.spellingVariants} groups / ${variant.totals.variantRows} rows / ${variant.totals.variantOccurrences} occurrences`);
    console.log(`  sound-alikes:      ${variant.totals.soundAlikes} groups / ${variant.totals.soundAlikeRows} rows / ${variant.totals.soundAlikeOccurrences} occurrences`);
    console.log(`  roster-selected groups that would pass the same spelling test, and are NOT printed here: ${variant.identityBearingVariantsNotReported.groups} — ${variant.identityBearingVariantsNotReported.readings.join(", ")}`);
    if (args.limit === null) {
      for (const [label, got, want] of [
        ["candidate groups", variant.groups.total, EXPECTED.candidateGroups],
        ["identity-bearing groups", variant.groups.identityBearing, EXPECTED.identityBearingGroups],
        ["unselected groups", variant.groups.unselected, EXPECTED.unselectedGroups],
        ["spelling-variant groups", variant.totals.spellingVariants, EXPECTED.spellingVariantGroups],
        ["spelling-variant rows", variant.totals.variantRows, EXPECTED.spellingVariantRows],
        ["spelling-variant occurrences", variant.totals.variantOccurrences, EXPECTED.spellingVariantOccurrences],
        ["sound-alike groups", variant.totals.soundAlikes, EXPECTED.soundAlikeGroups],
        ["sound-alike rows", variant.totals.soundAlikeRows, EXPECTED.soundAlikeRows],
        ["sound-alike occurrences", variant.totals.soundAlikeOccurrences, EXPECTED.soundAlikeOccurrences],
      ]) {
        if (got !== want) problems.push(`${label}: measured ${got}, plan 07 §2.10 states ${want}`);
      }
    }
    console.log("  --- every spelling variant, both spellings and both counts:");
    for (const group of variant.spellingVariants) {
      console.log(`      ${group.reading}  (${group.closestPair.a} / ${group.closestPair.b}: ${group.closestPair.shared} of ${group.closestPair.shorter})  ${group.forms.map((form) => `${form.form} ×${form.count} in ${form.chaptersByVolume.map((entry) => `v${entry.volume}`).join(",")}`).join("  ")}`);
    }
    console.log();
  }

  // ── 4. the inconsistent-guidance report ────────────────────────────────────────────────────────
  const guidance = inconsistentGuidanceReport(opened, { out: OUT_DIR });
  if (!guidance.ok) {
    problems.push(`the guidance report refused: ${guidance.refusal.rule} — ${guidance.refusal.because}`);
  } else {
    console.log(`## 4. inconsistent guidance — the widths`);
    console.log(`  one written form, 2+ readings, anywhere in the record: ${guidance.widths.formsWithMoreThanOneReading.pairs} (volume, form) pairs / ${guidance.widths.formsWithMoreThanOneReading.keys} distinct forms`);
    console.log(`  one written form, 2+ readings, IN ONE CHAPTER:        ${guidance.widths.formCollisions.collisions} collisions / ${guidance.widths.formCollisions.pairs} pairs / ${guidance.widths.formCollisions.keys} distinct forms`);
    console.log(`  one reading, 2+ written forms, IN ONE CHAPTER:        ${guidance.widths.readingCollisions.collisions} collisions / ${guidance.widths.readingCollisions.pairs} pairs / ${guidance.widths.readingCollisions.keys} distinct readings`);
    console.log("  buckets of the last row (disjoint, and they add up):");
    for (const [name, bucket] of Object.entries(guidance.buckets)) console.log(`      ${name.padEnd(22)} ${String(bucket.collisions).padStart(4)} collisions / ${String(bucket.pairs).padStart(4)} pairs`);
    const bucketTotal = Object.values(guidance.buckets).reduce((sum, bucket) => sum + bucket.collisions, 0);
    if (bucketTotal !== guidance.widths.readingCollisions.collisions) problems.push(`the buckets add to ${bucketTotal}, not to ${guidance.widths.readingCollisions.collisions}`);

    console.log(`\n## 5. the defects this report names: ${guidance.anomalyTotals.total}`);
    for (const collision of guidance.anomalies.transposedReadings) {
      console.log(`  reading side: volume ${collision.volume} ${collision.chapter} — ${collision.form} guided ${collision.transposedPair.join(" and ")} (${collision.readings.map((reading) => `${reading.reading} ×${reading.occurrences}`).join(", ")})`);
    }
    for (const collision of guidance.anomalies.transposedForms) {
      console.log(`  form side: volume ${collision.volume} ${collision.chapter} — ${collision.reading} printed over ${collision.transposedPair.join(" and ")}`);
    }
    if (!guidance.anomalies.transposedForms.length) console.log("  form side: none");

    // The names the acceptance line says must stay out, and the one it says must be in. Exact and
    // substring are kept apart on purpose: 三色院董子 contains 董子, and a report that counted that as
    // "董子 was named" would re-commit the mistake gotcha 168 withdrew.
    const anomalyKeys = (report) => [
      ...report.anomalies.transposedReadings.map((collision) => collision.form),
      ...report.anomalies.transposedForms.map((collision) => collision.reading),
    ];
    const widthKeys = (report) => [
      ...report.formCollisions.map((collision) => collision.form),
      ...report.readingCollisions.map((collision) => collision.reading),
    ];
    for (const needle of ["董子", "三色院董子", "如雨露"]) {
      const exact = anomalyKeys(guidance).filter((key) => key === needle);
      const containing = [...new Set(anomalyKeys(guidance).filter((key) => key !== needle && key.includes(needle)))];
      const widthExact = widthKeys(guidance).filter((key) => key === needle).length;
      const widthContaining = new Set(widthKeys(guidance).filter((key) => key !== needle && key.includes(needle))).size;
      console.log(
        `  "${needle}": named exactly as a defect ${exact.length} time(s); a defect whose name merely CONTAINS it: ${containing.length ? containing.join(", ") : "none"}; ` +
          `in the widths: ${widthExact} exact / ${widthContaining} containing → ${exact.length ? "NAMED AS A DEFECT" : "silent as a defect in its own right"}`
      );
    }
    const sumireko = guidance.readingCollisions.filter((collision) => collision.reading === "すみれこ");
    const sumirekoBuckets = [...new Set(sumireko.map((collision) => collision.bucket))];
    console.log(`  すみれこ over 菫子 and 董子 in one chapter: ${sumireko.length} collision(s), in bucket(s) ${sumirekoBuckets.length ? sumirekoBuckets.join(", ") : "n/a"} — counted, and not a defect`);
    const amatsuyu = collisionsNaming(guidance.readingCollisions, "如雨露").concat(collisionsNaming(guidance.formCollisions, "如雨露"));
    console.log(`  如雨露 in any collision at all: ${amatsuyu.length}`);
    console.log();

    // ── 6. the rejected rule, on the same rows ───────────────────────────────────────────────────
    const naive = naiveFrequencyCandidates(guidance.readingCollisions);
    console.log(`## 6. the rejected "10× more common" rule, run against the same collisions`);
    console.log(`  it would flag ${naive.totals.candidates} collision(s) over ${naive.totals.pairs} reading(s); ${naive.totals.smallerCountAtLeastTwo} with the rarer side at 2 or more occurrences`);
    console.log(`  plan 07 §2.11 measured the same rule against the raw harvest at ${EXPECTED.naiveRawHarvestPairs} candidate pairs`);
    const flagged = naive.candidates.map((candidate) => `${candidate.reading}: ${candidate.largerForm} ×${candidate.largerCount} / ${candidate.smallerForm} ×${candidate.smallerCount}`);
    for (const line of flagged.slice(0, 20)) console.log(`      ${line}`);
    if (flagged.length > 20) console.log(`      … ${flagged.length - 20} more`);
    const naiveNamesDefect = naive.candidates.filter((candidate) => guidance.anomalies.transposedReadings.some((collision) => collision.form === candidate.largerForm || collision.form === candidate.smallerForm));
    console.log(`  of the ${guidance.anomalies.transposedReadings.length} defect(s) this report names, the rejected rule finds ${naiveNamesDefect.length} — which is the other half of why it was rejected`);
    console.log();

    // ── 7. idempotence, byte for byte ────────────────────────────────────────────────────────────
    const secondVariant = variantSpellingReport(opened, { out: OUT_DIR });
    const secondGuidance = inconsistentGuidanceReport(opened, { out: OUT_DIR });
    const sameBytes =
      fs.readFileSync(variant.files.markdown, "utf8") === fs.readFileSync(secondVariant.files.markdown, "utf8") &&
      fs.readFileSync(variant.files.json, "utf8") === fs.readFileSync(secondVariant.files.json, "utf8") &&
      fs.readFileSync(guidance.files.markdown, "utf8") === fs.readFileSync(secondGuidance.files.markdown, "utf8") &&
      fs.readFileSync(guidance.files.json, "utf8") === fs.readFileSync(secondGuidance.files.json, "utf8");
    console.log(`## 7. a second pass over the same record`);
    console.log(`  same answer: ${JSON.stringify(secondVariant.totals) === JSON.stringify(variant.totals) && JSON.stringify(secondGuidance.anomalyTotals) === JSON.stringify(guidance.anomalyTotals)}`);
    console.log(`  same bytes in all four files: ${sameBytes}`);
    if (!sameBytes) problems.push("a second pass wrote different bytes for the same record");
    console.log(`  files: ${[VARIANT_REPORT_FILES, GUIDANCE_REPORT_FILES].flatMap((names) => [names.markdown, names.json]).join(", ")}`);
    console.log();

    // ── 8. the copy: nothing else moved ──────────────────────────────────────────────────────────
    const after = tableCounts(opened);
    console.log(`## 8. what the two reports wrote into the record`);
    console.log(`  cast_merges: ${after.cast_merges} · cast_identities: ${after.cast_identities} · cast_identity_links: ${after.cast_identity_links} · challenges: ${after.challenge_fact || 0}`);
    if (after.cast_merges !== 0) problems.push("cast_merges moved: a source-quality report must not merge a name");
    console.log(`  written_forms: ${after.written_forms} (the filing did that; the reports did not)`);
  }

  // Filing the last volume's harvest a SECOND time into the same copy: the acceptance line's "a second pass
  // files 0 and reports N already filed", measured on the real rows rather than only on a fixture.
  const lastHarvest = harvests[harvests.length - 1];
  if (lastHarvest) {
    const beforeRefill = tableCounts(opened).written_forms;
    const again = await fileVolumeWrittenForms(opened, { volume: lastHarvest.volume, harvests: [{ volume: lastHarvest.volume, guides: lastHarvest.guides }] });
    console.log(`  re-filing volume ${lastHarvest.volume}'s harvest into the same record: ${again.ok ? `${again.rowsFiled} new row(s), ${again.rowsAlreadyFiled} reported already filed` : `refused: ${again.refusal && again.refusal.rule}`}`);
    if (again.ok && again.rowsFiled !== 0) problems.push(`a second filing of the same harvest filed ${again.rowsFiled} row(s) a second time`);
    if (again.ok && tableCounts(opened).written_forms !== beforeRefill) problems.push("the second filing changed the row count");
  }

  opened.close();

  // ── 9. the corpus left alone ───────────────────────────────────────────────────────────────────
  const afterState = corpusState(considered);
  const moved = [];
  let sidecars = 0;
  for (const folder of Object.keys(before)) {
    const a = before[folder];
    const b = afterState[folder];
    sidecars += (b.sidecars || []).length;
    if (a.digest !== b.digest || a.size !== b.size) moved.push(`${folder}: digest or size moved`);
    if (JSON.stringify(a.sidecars) !== JSON.stringify(b.sidecars)) moved.push(`${folder}: sidecars changed (${a.sidecars.join(",")} → ${b.sidecars.join(",")})`);
  }
  console.log(`## 9. the corpus, left alone`);
  console.log(`  volumes checked: ${Object.keys(before).length}; -wal / -shm sidecars after: ${sidecars}`);
  console.log(`  digests moved: ${moved.length ? moved.join("; ") : "none — every series.db is byte-identical to what it was before this script ran"}`);
  // The row count is read out of a COPY of each record, never out of the corpus file (gotcha 124).
  let corpusWrittenForms = 0;
  for (const volume of considered) {
    const probe = openCopiedRecord(volume);
    if (!probe) continue;
    try {
      corpusWrittenForms += probe.store.db.prepare("SELECT COUNT(*) AS n FROM written_forms").get().n;
    } catch {
      corpusWrittenForms += 0;
    } finally {
      probe.store.close();
    }
  }
  console.log(`  written_forms rows in the corpus itself: ${corpusWrittenForms} (0 means this script filed nothing into a book)`);
  if (corpusWrittenForms !== 0) problems.push("the corpus holds written_forms rows this script filed, which is the one thing it must not do");

  console.log();
  if (problems.length) {
    console.log(`PROBLEMS (${problems.length}):`);
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("No problems: every pinned number reproduced, the corpus untouched, 0 model calls.");
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

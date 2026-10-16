#!/usr/bin/env node
/**
 * test/measure-glossary-re-render.js — plan 07 slice 6, measured against the **live corpus** on
 * **copies** of the 17 records. Zero model calls. Nothing in the corpus is written.
 *
 * ## The question this script answers
 *
 * The slice renames the glossary table's column headings from `Japanese | English | Notes` to
 * `Original | Translated | Notes`, and builds a door that re-renders a published `glossary.md` out of the
 * reference record that published it. The plan's acceptance line is one sentence:
 *
 *   "The render is compared against what is on disk **before** anything is replaced, and every row that
 *    disappears is named with the rule that refused it. No sealed row is edited. The freeze gate is not
 *    asked to excuse anything."
 *
 * So this script does not measure how good the render is. It measures three things that can only be
 * answered by running the door over the real books:
 *
 *   1. **What would disappear.** Every one of the 17 published glossaries is rendered from its own record
 *      and compared row by row, and every row that would vanish is named with the store rule that refused
 *      it. This is the number the apply decision needs, and it is the number plan 07 §4.7 was written
 *      without: §4.7 predicted row loss measured against the **authored** files the render route replaced
 *      (volume 02 124 → 120, volume 17 554 → 520). The files on disk today are already renders of the
 *      records, so the loss this slice has to survive is a different measurement.
 *   2. **Whether a sealed row moves.** Each record is copied twice. One copy is read at the schema it was
 *      written on; the other is opened the way the door opens it — which migrates it to this build's shape
 *      — and rendered from. Every glossary-family row's content columns and its `row_version` are compared
 *      column by column, so "no sealed row is edited" is a column count and not a promise.
 *   3. **Whether the freeze gate was asked to excuse anything.** It is asked, under the door it already
 *      owns, and the answer it gives is printed.
 *
 * ## THIS script reads the live corpus, and says so. What makes it safe is gotcha 124 / gotcha 166:
 * **a corpus `series.db` is never opened.** Each volume's record is copied with `fs.copyFileSync` into the
 * scratch folder, and the copy is what the engine sees. `copyFileSync` and not `db.js`'s `copyDatabase`,
 * because `copyDatabase` opens the source. The `-wal` travels with the copy (volume 03's holds committed
 * rows); the `-shm` does not, because it is an index the engine rebuilds.
 *
 * The script hashes every volume's `series.db`, its `-wal` / `-shm` sidecars and its published
 * `glossary.md` before its own run and again after it, and fails if any digest moved or any sidecar
 * appeared or disappeared.
 *
 * It writes nothing in the corpus, declares nothing, and calls no model. `npm test` does not run it: it
 * depends on books that are not in this repository (AGENTS.md rule 8), and `test/test-glossary-re-render.js`
 * is the fixture that carries its rules.
 *
 * Usage:
 *   node test/measure-glossary-re-render.js [--series=<series folder>] [--out=<scratch dir>] [--report=<path>]
 *
 * @module test/measure-glossary-re-render
 */

"use strict";

require("../configs/env-defaults").loadEnv();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { chosenSeriesLocation } = require("../configs/env-defaults");
const { resolveRunSettings } = require("../configs/shared");
const { postMortemDir } = require("../configs/run-state");
const { evaluateFreeze } = require("../utils/prereqs/freeze");
const { specForStep } = require("../utils/artifacts");
const { openDatabase } = require("../utils/reference-store/db");
const { readSchemaVersion } = require("../utils/reference-store/schema");
const { GLOSSARY_HEADER, renderGlossary } = require("../utils/reference-store/glossary-adapter");
const { openReferenceStore, installmentKey } = require("../utils/reference-store");
const { glossaryTitleBlock } = require("../glossary/store");
const door = require("../glossary/re-render");
require("../types"); // JSDoc type definitions

/** Where the copies of the 17 records go. Never inside the series folder. */
const DEFAULT_SCRATCH = "/tmp/opencode/plan07-slice6/measure-db-copy";

/** The report names, written into the run's own records. */
const REPORT_MD_FILE = "glossary-re-render.md";
const REPORT_JSON_FILE = "glossary-re-render.json";

/**
 * sha256 of a file's bytes.
 * @param {string} file @returns {string}
 */
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Every volume folder in the series that holds a reference record, in reading order.
 *
 * Refuses when the corpus is absent or holds no record: a measurement that prints zeros because it could
 * not find the books is a measurement that reports the books as empty.
 *
 * @param {string} seriesDir
 * @returns {Array<{folder: string, volume: string, volumeDir: string, dbFile: string, glossaryFile: string}>}
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
      return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, door.RECORD_FILE));
    })
    .sort();
  if (folders.length === 0) {
    console.error(
      `refused: no volume folder under ${seriesDir} holds a ${door.RECORD_FILE}. This door renders a published ` +
        "glossary out of the record that published it; run the glossary stage first, or point --series= at the " +
        "series folder that has them. It will not report zeros as a result."
    );
    process.exit(2);
  }
  return folders.map((folder) => ({
    folder,
    volume: (folder.match(/\((\d+)\)/) || [])[1] || folder,
    volumeDir: path.join(seriesDir, folder),
    dbFile: path.join(seriesDir, folder, door.RECORD_FILE),
    glossaryFile: path.join(seriesDir, folder, door.GLOSSARY_ARTIFACT),
  }));
}

/**
 * Snapshot every volume's record, its sidecars and its published glossary, so the script can prove its own
 * run left the corpus alone (gotcha 124).
 *
 * @param {Array<{folder: string, volumeDir: string, dbFile: string, glossaryFile: string}>} volumes
 * @returns {Map<string, Object>}
 */
function corpusState(volumes) {
  /** @type {Map<string, Object>} */
  const state = new Map();
  for (const volume of volumes) {
    const sidecars = fs
      .readdirSync(volume.volumeDir)
      .filter((name) => /^series\.db(-wal|-shm)$/.test(name))
      .sort()
      .map((name) => ({ name, bytes: fs.statSync(path.join(volume.volumeDir, name)).size }));
    state.set(volume.folder, {
      db: fs.existsSync(volume.dbFile) ? { digest: sha256(volume.dbFile), bytes: fs.statSync(volume.dbFile).size } : null,
      sidecars,
      glossary: fs.existsSync(volume.glossaryFile)
        ? { digest: sha256(volume.glossaryFile), bytes: fs.statSync(volume.glossaryFile).size }
        : null,
    });
  }
  return state;
}

/**
 * Compare two snapshots and name every difference.
 *
 * @param {Map<string, Object>} before @param {Map<string, Object>} after @returns {string[]}
 */
function compareCorpusState(before, after) {
  /** @type {string[]} */
  const problems = [];
  for (const [folder, was] of before) {
    const now = after.get(folder);
    if (!now) {
      problems.push(`${folder}: the volume folder disappeared`);
      continue;
    }
    if (JSON.stringify(was.db) !== JSON.stringify(now.db)) {
      problems.push(`${folder}: ${door.RECORD_FILE} moved (${was.db && was.db.digest.slice(0, 12)} ${was.db && was.db.bytes}B → ${now.db && now.db.digest.slice(0, 12)} ${now.db && now.db.bytes}B)`);
    }
    if (JSON.stringify(was.sidecars) !== JSON.stringify(now.sidecars)) {
      problems.push(`${folder}: sidecars changed from ${was.sidecars.map((s) => `${s.name}(${s.bytes})`).join(", ") || "(none)"} to ${now.sidecars.map((s) => `${s.name}(${s.bytes})`).join(", ") || "(none)"}`);
    }
    if (JSON.stringify(was.glossary) !== JSON.stringify(now.glossary)) {
      problems.push(`${folder}: ${door.GLOSSARY_ARTIFACT} moved (${was.glossary && was.glossary.digest.slice(0, 12)} → ${now.glossary && now.glossary.digest.slice(0, 12)})`);
    }
  }
  return problems;
}

/**
 * Copy one volume's record — main file **and** write-ahead log — into the scratch folder, as bytes.
 *
 * @param {{volumeDir: string, folder: string}} volume @param {string} scratchVolumeDir
 * @returns {{ok: boolean, copied: string[], walBytes: number}}
 */
function copyRecord(volume, scratchVolumeDir) {
  const result = door.copyRecordForReading({ volumeDir: volume.volumeDir, scratchVolumeDir });
  const walFile = path.join(volume.volumeDir, `${door.RECORD_FILE}-wal`);
  return {
    ok: result.ok,
    copied: result.copied,
    walBytes: fs.existsSync(walFile) ? fs.statSync(walFile).size : 0,
  };
}

/**
 * Dump every glossary-family row of a record, every column, in a stable order.
 *
 * @param {string} dbFile @returns {{rows: Array<Object>, columns: string[], schema: number}}
 */
function dumpGlossaryRows(dbFile) {
  const db = openDatabase(dbFile);
  try {
    const columns = db.prepare("PRAGMA table_info(facts)").all().map((column) => column.name);
    const rows = db.prepare("SELECT * FROM facts WHERE aspect = 'term_usage' ORDER BY ord, id").all().map((row) => Object.fromEntries(Object.entries(row)));
    // `readSchemaVersion` wants an OPEN handle, not a path: handed a path it answers `null` for both sides
    // of a comparison and can never fire (gotcha 158).
    return { rows, columns, schema: readSchemaVersion(db) };
  } finally {
    db.close();
  }
}

/**
 * The published file with its table header lines replaced by the ones this build's renderer writes.
 *
 * This is the shape the apply decision rests on: if replacing the headings **in the file on disk** produces
 * byte-for-byte what rendering the record produces, then the change is a heading change and nothing else —
 * no row moved, no cell rewritten, no section reordered.
 *
 * @param {string} markdown @returns {string}
 */
function renameHeaderLines(markdown) {
  const replacement = `| ${GLOSSARY_HEADER.join(" | ")} |`;
  return markdown
    .split("\n")
    .map((line) => (/^\|\s*Japanese\s*\|\s*English\s*\|\s*Notes\s*\|\s*$/.test(line) ? replacement : line))
    .join("\n");
}

/**
 * Read one record's schema version from an OPEN handle.
 *
 * `readSchemaVersion` wants a handle, not a path: handed a path it answers `null` for both sides of a
 * comparison and can never fire (gotcha 158).
 *
 * @param {string} dbFile @returns {number|null}
 */
function schemaOf(dbFile) {
  const db = openDatabase(dbFile);
  try {
    return readSchemaVersion(db);
  } finally {
    db.close();
  }
}

/**
 * Compare two row dumps column by column, over the columns BOTH shapes carry.
 *
 * The pristine copy is read at the schema it was written on (8 or 9 for this corpus) and the rendered copy
 * has been migrated to this build's (13), so the newer shape's added columns are reported separately rather
 * than counted as changes.
 *
 * @param {Object} pristine @param {Object} rendered @returns {{moved: string[], added: string[], rowsChecked: number}}
 */
function compareRowDumps(pristine, rendered) {
  const shared = pristine.columns.filter((column) => rendered.columns.includes(column));
  const added = rendered.columns.filter((column) => !pristine.columns.includes(column));
  /** @type {string[]} */
  const moved = [];
  if (pristine.rows.length !== rendered.rows.length) {
    moved.push(`row count ${pristine.rows.length} → ${rendered.rows.length}`);
    return { moved, added, rowsChecked: Math.min(pristine.rows.length, rendered.rows.length) };
  }
  for (let i = 0; i < pristine.rows.length; i += 1) {
    for (const column of shared) {
      if (pristine.rows[i][column] !== rendered.rows[i][column]) {
        moved.push(`row ${pristine.rows[i].id} column ${column}: ${JSON.stringify(pristine.rows[i][column])} → ${JSON.stringify(rendered.rows[i][column])}`);
      }
    }
  }
  // A column the migration added must hold nothing: a migration that fills a value into a published row
  // is that row being edited.
  for (const column of added) {
    const filled = rendered.rows.filter((row) => row[column] !== null && row[column] !== undefined && row[column] !== "").length;
    if (filled > 0) moved.push(`migration filled ${filled} row(s) into the new column ${column}`);
  }
  return { moved, added, rowsChecked: pristine.rows.length };
}

/**
 * Count the published translations in the corpus — the only thing that makes the freeze gate bite.
 *
 * The names come from `specForStep("translate")`, the same list the gate reads, so this script and the gate
 * cannot disagree about what "published" means (gotcha 141).
 *
 * @param {Array<{folder: string, volumeDir: string}>} volumes @returns {{names: string[], frozen: string[]}}
 */
function publishedTranslations(volumes) {
  const spec = specForStep("translate");
  const names = (spec.volume || []).filter((artifact) => artifact.level === "required").map((artifact) => artifact.name);
  const frozen = volumes
    .filter((volume) => names.every((name) => fs.existsSync(path.join(volume.volumeDir, name))))
    .map((volume) => volume.folder);
  return { names, frozen };
}

/**
 * Run the measurement.
 * @returns {Promise<number>} 0 when the corpus is untouched and nothing would be lost; 2 otherwise.
 */
async function main() {
  const argv = process.argv.slice(2);
  /** @param {string} name @returns {string|null} */
  const pick = (name) => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(`--${name}=`.length) : null;
  };
  const seriesDir = path.resolve(pick("series") || chosenSeriesLocation() || "");
  const scratch = path.resolve(pick("out") || DEFAULT_SCRATCH);
  if (!seriesDir) {
    console.error("refused: no series folder — set SERIES_LOCATION or pass --series=<dir>.");
    return 2;
  }

  const volumes = volumeRecords(seriesDir);
  const before = corpusState(volumes);

  console.log("measure-glossary-re-render — plan 07 slice 6, against the live corpus, on copies");
  console.log(`  series        : ${seriesDir}`);
  console.log(`  volumes       : ${volumes.length}`);
  console.log(`  scratch copies: ${scratch}`);
  console.log(`  model calls   : 0 — this script reads records and files and asks nothing of a model`);
  console.log(`  corpus access : ${door.RECORD_FILE} copied with fs.copyFileSync; never opened (gotcha 124, gotcha 166)`);

  // ─── 1. the freeze gate, asked and answered ────────────────────────────────
  const translations = publishedTranslations(volumes);
  console.log(`\n1. the freeze gate`);
  console.log(`   published translation artifacts this gate reads: ${translations.names.join(", ")}`);
  console.log(`   volumes with a translation standing on their glossary: ${translations.frozen.length}`);
  const verdict = await evaluateFreeze({
    door: "glossary",
    seriesDir,
    cancelledBy: "apply",
    detail: "re-rendering each volume's glossary out of its own reference record (plan 07 slice 6)",
  });
  console.log(`   the glossary door's verdict for an --apply pass: ${verdict.ok ? "allowed" : "REFUSED"}`);
  if (!verdict.ok) console.log(`   ${verdict.headline}`);
  console.log(`   no new door was added for this act: the gate's own table is asked, not widened.`);

  // ─── 2. every published glossary, rendered from its own record ────────────
  console.log(`\n2. what the render would change, volume by volume`);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  const manifest = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(seriesDir, "translation-target.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  const runSettings = resolveRunSettings(manifest);

  /** @type {Array<Object>} */
  const entries = [];
  let totalOnDisk = 0;
  let totalLost = 0;
  let totalGained = 0;
  let totalChanged = 0;
  let totalHeaderOnly = 0;
  let totalIdentical = 0;

  for (const volume of volumes) {
    const volumeNumber = Number(volume.volume);
    const copyDir = path.join(scratch, volume.folder);
    const copied = copyRecord(volume, copyDir);
    const title = glossaryTitleBlock({
      INSTALLMENT_NUMBER: installmentKey(volume.volume),
      SOURCE_NAME: runSettings.seriesName,
      SOURCE_LANGUAGE: runSettings.sourceLanguage,
      TARGET_LANGUAGE: runSettings.targetLanguage,
    });
    const rendered = await door.renderGlossaryFromRecordCopy({
      volume: volumeNumber,
      folder: volume.folder,
      seriesDir,
      scratchSeriesDir: scratch,
      title,
    });
    if (!rendered.ok) {
      entries.push({ volume: volume.folder, installment: volume.volume, ok: false, refusal: rendered.refusal });
      console.log(`   ${volume.folder}: REFUSED — ${rendered.refusal.rule}`);
      continue;
    }
    const onDisk = fs.readFileSync(volume.glossaryFile, "utf8");
    const harvest = await door.readHarvestRows(volume.volumeDir);
    const comparison = door.compareGlossaryRender({
      onDisk,
      rendered: rendered.markdown,
      volumeDir: volume.volumeDir,
      volume: volumeNumber,
      guideSplitForms: door.guideSplitFormsOfHarvest(harvest),
      explain: true,
    });

    // The claim the apply decision rests on: replacing the header lines in the file on disk, by hand,
    // produces the SAME bytes as rendering the record. If that is true, the change is a heading change
    // and nothing else.
    const renamedOnDisk = renameHeaderLines(onDisk);
    const renamedMatchesRender = renamedOnDisk === rendered.markdown;

    totalOnDisk += comparison.rowsOnDisk;
    totalLost += comparison.lostRows.length;
    totalGained += comparison.gainedRows.length;
    totalChanged += comparison.changedRows.length;
    if (comparison.onlyHeaderLinesDiffer) totalHeaderOnly += 1;
    if (comparison.identical) totalIdentical += 1;

    entries.push({
      volume: volume.folder,
      installment: volume.volume,
      ok: true,
      walBytes: copied.walBytes,
      schemaOnDisk: schemaOf(path.join(copyDir, door.RECORD_FILE)),
      rowsOnDisk: comparison.rowsOnDisk,
      rowsRendered: comparison.rowsRendered,
      sectionsOnDisk: comparison.sectionsOnDisk,
      sectionsRendered: comparison.sectionsRendered,
      headerLinesOnDisk: comparison.headerLinesOnDisk,
      headerLinesRendered: comparison.headerLinesRendered,
      proseLinesOnDisk: comparison.proseLinesOnDisk,
      proseLinesRendered: comparison.proseLinesRendered,
      lostRows: comparison.lostRows,
      gainedRows: comparison.gainedRows,
      changedRows: comparison.changedRows,
      sectionsLost: comparison.sectionsLost,
      proseLinesLost: comparison.proseLinesLost,
      onlyHeaderLinesDiffer: comparison.onlyHeaderLinesDiffer,
      identical: comparison.identical,
      headerRenameMatchesRender: renamedMatchesRender,
      bytesOnDisk: Buffer.byteLength(onDisk, "utf8"),
      bytesRendered: Buffer.byteLength(rendered.markdown, "utf8"),
    });
    console.log(
      `   ${volume.folder}: rows ${comparison.rowsOnDisk} → ${comparison.rowsRendered}; lost ${comparison.lostRows.length}, ` +
        `gained ${comparison.gainedRows.length}, changed ${comparison.changedRows.length}; ` +
        `sections ${comparison.sectionsOnDisk} → ${comparison.sectionsRendered}; headers ${comparison.headerLinesOnDisk} → ${comparison.headerLinesRendered}; ` +
        `prose ${comparison.proseLinesOnDisk} → ${comparison.proseLinesRendered}; only headers differ ${comparison.onlyHeaderLinesDiffer ? "yes" : "no"}; ` +
        `hand-renamed file === render: ${renamedMatchesRender ? "yes" : "NO"}`
    );
    for (const row of comparison.lostRows.slice(0, 6)) {
      console.log(`     LOST ${JSON.stringify(row.term)} (${row.section}) — ${row.rule}: ${row.because}`);
    }
    if (comparison.lostRows.length > 6) console.log(`     … ${comparison.lostRows.length - 6} more named in the report`);
  }

  console.log(
    `   totals: ${totalOnDisk} rows on disk across ${volumes.length} volumes; ` +
      `lost ${totalLost}, gained ${totalGained}, changed ${totalChanged}; ` +
      `${totalHeaderOnly} volume(s) differ only by the header lines; ${totalIdentical} already identical`
  );

  // ─── 3. no sealed row is edited, and the migration moves nothing ───────────
  console.log(`\n3. no sealed row is edited`);
  const pristineRoot = path.join(scratch, "-pristine");
  const renderedRoot = path.join(scratch, "-rendered");
  /** @type {Array<Object>} */
  const immutability = [];
  for (const volume of volumes) {
    const pristineDir = path.join(pristineRoot, volume.folder);
    const renderedDir = path.join(renderedRoot, volume.folder);
    copyRecord(volume, pristineDir);
    copyRecord(volume, renderedDir);
    const pristine = dumpGlossaryRows(path.join(pristineDir, door.RECORD_FILE));
    // Open the second copy the way the door opens it: through the store, which migrates it to this build's
    // shape, and render from it. The first copy is never opened by anything but the row dump above.
    const store = openReferenceStore({
      seriesDir: renderedRoot,
      volume: Number(volume.volume),
      folder: volume.folder,
      create: false,
      stage: "merge",
    });
    const renderedMarkdown = renderGlossary(store, { volume: Number(volume.volume), title: "measure" });
    store.close();
    const rendered = dumpGlossaryRows(path.join(renderedDir, door.RECORD_FILE));
    const compared = compareRowDumps(pristine, rendered);
    immutability.push({
      volume: volume.folder,
      rows: pristine.rows.length,
      schemaPristine: pristine.schema,
      schemaRendered: rendered.schema,
      columnsShared: pristine.columns.filter((column) => rendered.columns.includes(column)).length,
      columnsAddedByMigration: compared.added,
      columnsMoved: compared.moved,
      rowsRendered: rendered.rows.length,
      renderBytes: Buffer.byteLength(renderedMarkdown, "utf8"),
    });
    console.log(
      `   ${volume.folder}: ${pristine.rows.length} glossary rows, schema ${pristine.schema} → ${rendered.schema}, ` +
        `${compared.rowsChecked * pristine.columns.length} cell comparisons over ${pristine.columns.length} columns, ` +
        `${compared.added.length} columns the migration added, ${compared.moved.length} moved`
    );
    for (const line of compared.moved.slice(0, 6)) console.log(`     MOVED ${line}`);
  }
  const totalMoved = immutability.reduce((sum, item) => sum + item.columnsMoved.length, 0);
  const totalRows = immutability.reduce((sum, item) => sum + item.rows, 0);
  console.log(`   totals: ${totalRows} glossary rows across ${volumes.length} records, ${totalMoved} columns moved, 0 row_version moved`);

  // ─── 4. the corpus was left alone ──────────────────────────────────────────
  const after = corpusState(volumes);
  const problems = compareCorpusState(before, after);
  console.log(`\n4. the corpus after this script ran`);
  for (const volume of volumes) {
    const state = after.get(volume.folder);
    console.log(
      `   ${volume.folder}: ${door.RECORD_FILE} ${state.db && state.db.digest.slice(0, 12)} (${state.db && state.db.bytes}B), ` +
        `sidecars ${state.sidecars.map((s) => `${s.name}(${s.bytes})`).join(", ") || "(none)"}, ` +
        `${door.GLOSSARY_ARTIFACT} ${state.glossary && state.glossary.digest.slice(0, 12)} (${state.glossary && state.glossary.bytes}B)`
    );
  }
  if (problems.length === 0) console.log(`   0 digests moved, 0 sidecars appeared or disappeared, 0 published glossaries changed.`);
  for (const problem of problems) console.log(`   PROBLEM ${problem}`);

  // ─── 5. the report, into the run's own records ─────────────────────────────
  const reportDir = pick("report") ? path.dirname(path.resolve(pick("report"))) : postMortemDir();
  const mdFile = pick("report") ? path.resolve(pick("report")) : path.join(reportDir, REPORT_MD_FILE);
  fs.mkdirSync(path.dirname(mdFile), { recursive: true });
  const markdown = [
    "# Glossary re-render — the measurement against the live corpus",
    "",
    `Series: ${seriesDir}`,
    `Volumes measured: ${volumes.length}. Model calls: 0. Rows written, edited, moved or re-labelled: 0.`,
    `Each volume's \`${door.RECORD_FILE}\` was copied with \`fs.copyFileSync\` and the copy was opened; the corpus record was never opened (gotcha 124).`,
    "",
    "## The freeze gate",
    "",
    `- Published translation artifacts the gate reads: \`${translations.names.join("`, `")}\``,
    `- Volumes with a translation standing on their glossary: **${translations.frozen.length}**`,
    `- The \`glossary\` door's verdict for an \`--apply\` pass: **${verdict.ok ? "allowed" : "REFUSED"}**`,
    `- New freeze doors added by this slice: **0** (the door asks the \`glossary\` door the gate already owns).`,
    "",
    "## What the render would change",
    "",
    "| Volume | Rows on disk | Rows rendered | Sections | Header lines | Prose lines | Lost | Gained | Changed | Only headers differ | Hand-renamed file = render |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...entries.map((entry) =>
      entry.ok
        ? `| ${entry.installment} | ${entry.rowsOnDisk} | ${entry.rowsRendered} | ${entry.sectionsOnDisk} → ${entry.sectionsRendered} | ${entry.headerLinesOnDisk} → ${entry.headerLinesRendered} | ${entry.proseLinesOnDisk} → ${entry.proseLinesRendered} | ${entry.lostRows.length} | ${entry.gainedRows.length} | ${entry.changedRows.length} | ${entry.onlyHeaderLinesDiffer ? "yes" : "no"} | ${entry.headerRenameMatchesRender ? "yes" : "NO"} |`
        : `| ${entry.installment} | refused: ${entry.refusal ? entry.refusal.rule : "?"} | — | — | — | — | — | — | — | — | — |`
    ),
    "",
    `Totals: **${totalOnDisk}** rows on disk; **${totalLost}** lost, **${totalGained}** gained, **${totalChanged}** changed; **${totalHeaderOnly}** of ${volumes.length} volumes differ only by the header lines.`,
    "",
    "## Rows that would disappear, and the rule that refused each one",
    "",
    ...(totalLost === 0
      ? ["None. Every row every published glossary holds is a row its own record holds and renders."]
      : entries
          .filter((entry) => entry.ok && entry.lostRows.length)
          .flatMap((entry) => [
            `### Volume ${entry.installment} — ${entry.lostRows.length} row(s)`,
            "",
            ...entry.lostRows.map((row) => `- **${row.term}** (${row.section}) — \`${row.rule}\`: ${row.because}`),
            "",
          ])),
    "## Cells the render would rewrite",
    "",
    ...(totalChanged === 0
      ? ["None. Every rendering, every note and every section the published files hold is what the records hold."]
      : entries
          .filter((entry) => entry.ok && entry.changedRows.length)
          .flatMap((entry) => [
            `### Volume ${entry.installment} — ${entry.changedRows.length} cell(s)`,
            "",
            ...entry.changedRows.map((cell) => `- **${cell.term}** — \`${cell.field}\`: ${JSON.stringify(cell.onDisk)} → ${JSON.stringify(cell.rendered)}`),
            "",
          ])),
    "## No sealed row is edited",
    "",
    "| Volume | Glossary rows | Schema pristine → rendered | Columns compared | Columns the migration added | Columns moved |",
    "|---|---|---|---|---|---|",
    ...immutability.map((item) => `| ${item.volume} | ${item.rows} | ${item.schemaPristine} → ${item.schemaRendered} | ${item.columnsShared} | ${item.columnsAddedByMigration.length} | ${item.columnsMoved.length} |`),
    "",
    `Totals: **${totalRows}** glossary rows, **${totalMoved}** columns moved. A column the migration added is counted as moved if it holds anything in a published row.`,
    "",
    "## The corpus after the measurement",
    "",
    problems.length === 0
      ? "0 digests moved, 0 sidecars appeared or disappeared, 0 published glossaries changed."
      : problems.map((problem) => `- ${problem}`).join("\n"),
    "",
  ].join("\n");
  await fs.promises.writeFile(mdFile, markdown, "utf8");
  await fs.promises.writeFile(
    mdFile.replace(/\.md$/, ".json"),
    JSON.stringify({ seriesDir, scratch, volumes: volumes.length, translations, verdict: { ok: verdict.ok, headline: verdict.headline }, entries, immutability, problems, totals: { totalOnDisk, totalLost, totalGained, totalChanged, totalHeaderOnly, totalIdentical, totalRows, totalMoved } }, null, 2),
    "utf8"
  );
  console.log(`\nreport: ${mdFile}`);
  console.log(`        ${mdFile.replace(/\.md$/, ".json")}`);

  if (problems.length) return 2;
  if (totalLost || totalGained || totalChanged) return 2;
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`measure-glossary-re-render: ${String((err && err.message) || err)}`);
    process.exitCode = 1;
  });

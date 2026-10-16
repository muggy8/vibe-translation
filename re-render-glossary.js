#!/usr/bin/env node
/**
 * re-render-glossary.js — re-render one volume's published `glossary.md` out of the reference record
 * that published it, with **no model call anywhere**.
 *
 * The stage that owns this artifact already renders it (`glossary/store.js`'s `renderGlossaryArtifact`).
 * What no door provided was the cheap half: republish the document from the record a run already paid
 * for, without re-running the stage and without re-reading the book. That is the door a document-shape
 * change needs — a column heading is a fact about the renderer, not about the rows — and the door that
 * makes it safe is the comparison it runs first.
 *
 * The guarantees are in `glossary/re-render.js`; the ones this file adds are about the command line:
 *
 *   - **Rehearsal is the default.** Without `--apply` the record is copied, the render is produced, the
 *     comparison is written, and nothing in the series folder changes. `--apply` is the only word that
 *     publishes, and `--move-aside` is the only word that lets a published glossary be replaced.
 *   - **The freeze gate is asked under the door it already covers.** `--apply` asks the `glossary` door —
 *     the one that already owns `glossary.md` — with `cancelledBy: "apply"`. No new door is added to the
 *     table, no flag reaches the gate, and a volume whose translation stands on its glossary is refused
 *     with `release-translation` named as the only way past. A rehearsal writes nothing into the series
 *     folder and is not a rewrite, so it does not ask.
 *   - **The corpus record is never opened.** The copy is made with `fs.copyFileSync` and the copy is what
 *     the engine sees (gotcha 124).
 *
 * Usage:
 *   node re-render-glossary.js --volume=01 --out=/tmp/opencode/rehearsal   # rehearsal: write nothing
 *   node re-render-glossary.js --all                                       # compare every volume, write nothing
 *   node re-render-glossary.js --volume=01 --apply --move-aside            # publish, keeping the old file
 *   node re-render-glossary.js --list                                      # what it would do, against which folder
 *
 * Exit codes: 0 nothing found, 2 a volume refused or a render differs, 1 the freeze gate refused or a
 * folder could not be read.
 *
 * @module re-render-glossary
 */

const fs = require("fs");
const path = require("path");

const { chosenSeriesLocation, loadEnv } = require("./configs/env-defaults");
const { resolveRunSettings } = require("./configs/shared");
const { postMortemDir } = require("./configs/run-state");
const { assertDoorAllowed } = require("./utils/prereqs/freeze");
const { readPlanOfRecord, installmentKey } = require("./utils/reference-store");
const { glossaryTitleBlock } = require("./glossary/store");
const door = require("./glossary/re-render");
require("./types"); // JSDoc type definitions

/** Where a rehearsal goes when `--out` is not given. */
const DEFAULT_REHEARSAL_ROOT = "/tmp/opencode/re-render-glossary";

/** The report names, written into the rehearsal root, or into the run's own records when `--apply` published. */
const REPORT_MD_FILE = "glossary-re-render.md";
const REPORT_JSON_FILE = "glossary-re-render.json";

/**
 * Parse this command's flags.
 *
 * @param {string[]} argv
 * @returns {{volume: string|null, all: boolean, series: string|null, out: string|null, apply: boolean, moveAside: boolean, report: string|null, json: boolean, list: boolean, error: string|null}}
 */
function readArgs(argv) {
  const out = {
    volume: null,
    all: false,
    series: null,
    out: null,
    apply: false,
    moveAside: false,
    report: null,
    json: false,
    list: false,
    error: null,
  };
  for (const arg of argv) {
    if (arg === "--all") out.all = true;
    else if (arg === "--apply") out.apply = true;
    else if (arg === "--move-aside") out.moveAside = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--list") out.list = true;
    else if (arg.startsWith("--volume=")) out.volume = arg.slice("--volume=".length);
    else if (arg.startsWith("--series=")) out.series = arg.slice("--series=".length);
    else if (arg.startsWith("--out=")) out.out = arg.slice("--out=".length);
    else if (arg.startsWith("--report=")) out.report = arg.slice("--report=".length);
    else {
      out.error = `unrecognised flag ${JSON.stringify(arg)}. This door takes --volume / --all / --series / --out / --apply / --move-aside / --report / --json / --list.`;
      return out;
    }
  }
  if (!out.volume && !out.all && !out.list) {
    out.error = "say which volumes: --volume=NN, or --all. Nothing is re-rendered by default.";
  } else if (out.volume && out.all) {
    out.error = "--volume and --all are two answers to one question.";
  } else if (out.moveAside && !out.apply) {
    out.error = "--move-aside is only meaningful with --apply: without --apply nothing in the series folder is touched.";
  }
  return out;
}

/**
 * The volumes this command will visit, in reading order, from the plan of record.
 *
 * @param {string} seriesDir
 * @param {{volume: string|null, all: boolean}} args
 * @returns {{volumes: Array<{installmentNumber: string, folder: string}>, error: string|null}}
 */
function resolveVolumes(seriesDir, args) {
  const plan = readPlanOfRecord(seriesDir);
  if (!plan) {
    return { volumes: [], error: `no plan of record at ${path.join(seriesDir, "translation-target.json")} — this door reads each volume's folder out of the plan.` };
  }
  if (args.volume) {
    const key = installmentKey(args.volume);
    const entry = plan.find((v) => installmentKey(v && v.installmentNumber) === key);
    if (!entry || !entry.folder) {
      return { volumes: [], error: `volume ${args.volume} is not in the plan of record (it lists ${plan.map((v) => v && v.installmentNumber).join(", ")}).` };
    }
    return { volumes: [{ installmentNumber: entry.installmentNumber, folder: entry.folder }], error: null };
  }
  return { volumes: plan.filter((v) => v && v.folder).map((v) => ({ installmentNumber: v.installmentNumber, folder: v.folder })), error: null };
}

/**
 * Print what this command is about to do, and against which folder.
 *
 * @param {Object} plan
 * @param {string} plan.seriesDir
 * @param {string} plan.rehearsalRoot
 * @param {string} plan.workSeriesDir
 * @param {boolean} plan.apply
 * @param {boolean} plan.moveAside
 * @param {Array<{installmentNumber: string, folder: string}>} plan.volumes
 * @returns {void}
 */
function printPlan({ seriesDir, rehearsalRoot, workSeriesDir, apply, moveAside, volumes }) {
  console.log("re-render-glossary — the glossary a volume's record already describes, rendered again");
  console.log(`  series:              ${seriesDir}`);
  console.log(`  volumes:             ${volumes.map((v) => v.installmentNumber).join(", ") || "none"}`);
  console.log(`  model calls:         0 — this door reads a record and a file, and asks nothing of a model`);
  console.log(`  record access:       a COPY of each volume's ${door.RECORD_FILE}, made with fs.copyFileSync; the corpus record is never opened`);
  console.log(`  writes and seals:    ${apply ? `${door.GLOSSARY_ARTIFACT} in each volume folder; no row added, changed, or deleted; nothing sealed` : `a copy under ${rehearsalRoot}; nothing in the series folder touched`}`);
  console.log(`  replaces the volume's ${door.GLOSSARY_ARTIFACT}: ${apply ? `yes — the published file moves to ${door.GLOSSARY_ARTIFACT}.rejected` : "no — the render is written into the copy only"}`);
  console.log(`  move-aside required: ${apply && moveAside ? "yes, and it was given" : apply ? "no — a volume with a published glossary will be refused" : "n/a (rehearsal)"}`);
  console.log(`  work folder:         ${workSeriesDir}`);
}

/**
 * One volume's rehearsal or publish.
 *
 * @param {Object} opts
 * @param {{installmentNumber: string, folder: string}} opts.volume
 * @param {string} opts.seriesDir - The series folder the published glossary lives in.
 * @param {string} opts.scratchSeriesDir - Where the COPY of the record goes. Never inside `seriesDir`.
 * @param {string} opts.workSeriesDir - Where the rehearsal writes its render (the scratch folder; a publish
 *   writes into `seriesDir` through the publish door, not through this path).
 * @param {boolean} opts.apply
 * @param {boolean} opts.moveAside
 * @param {{SOURCE_NAME: string|null, SOURCE_LANGUAGE: string, TARGET_LANGUAGE: string}} opts.runSettings
 * @returns {Promise<Object>} The report entry for this volume.
 */
async function reRenderOneVolume({ volume, seriesDir, scratchSeriesDir, workSeriesDir, apply, moveAside, runSettings }) {
  const volumeNumber = Number(installmentKey(volume.installmentNumber));
  const volumeDir = path.join(seriesDir, volume.folder);
  const artifactFile = path.join(volumeDir, door.GLOSSARY_ARTIFACT);
  const artifactPresent = fs.existsSync(artifactFile);
  const onDisk = artifactPresent ? fs.readFileSync(artifactFile, "utf8") : null;

  const title = glossaryTitleBlock({
    INSTALLMENT_NUMBER: volume.installmentNumber,
    SOURCE_NAME: runSettings.seriesName,
    SOURCE_LANGUAGE: runSettings.sourceLanguage,
    TARGET_LANGUAGE: runSettings.targetLanguage,
  });

  // The record is ALWAYS copied into the scratch folder, even when `--apply` was given. `--apply` decides
  // where the rendered markdown goes; it must never decide where the record is read from, because the copy
  // is opened and opening a corpus record checkpoints its write-ahead log and runs the schema migration in
  // place (gotcha 124).
  const rendered = await door.renderGlossaryFromRecordCopy({
    volume: volumeNumber,
    folder: volume.folder,
    seriesDir,
    scratchSeriesDir: scratchSeriesDir,
    title,
  });
  if (!rendered.ok) {
    return { installment: volume.installmentNumber, folder: volume.folder, ok: false, refusal: rendered.refusal };
  }

  // The volume's own harvest is read whether or not a published file exists, because the report has to be
  // able to say WHY its reading column is empty. A copy of a corpus record is migrated by the store's own
  // open door, so the table is there and EMPTY — the thing that files a harvest into a record is
  // `ensureVolumeWrittenFormsInRecord`, inside `openVolumeRecord`, which this door deliberately does not
  // use. Without the harvest count beside it, "render fills 0 of 410 rows" reads as "this book guided
  // nothing", next to a harvest file that holds 825 guided forms.
  const harvest = await door.readHarvestRows(volumeDir);
  const harvestGuideRows = harvest.length;

  let comparison = null;
  if (artifactPresent) {
    comparison = door.compareGlossaryRender({
      onDisk,
      rendered: rendered.markdown,
      volumeDir,
      volume: volumeNumber,
      guideSplitForms: door.guideSplitFormsOfHarvest(harvest),
      explain: true,
      // The third text the gate compares: what the RECORD says each row's reading cell is. Without it the
      // gate would only be able to ask "does the file match the render", which a renderer that invents a
      // guide answers perfectly well.
      expectedReadingCells: rendered.readingCells,
    });
  }

  const measured = door.measureGlossaryRender(rendered.markdown);
  const entry = {
    installment: volume.installmentNumber,
    folder: volume.folder,
    ok: true,
    artifactPresent,
    identical: comparison ? comparison.identical : false,
    onlyHeaderLinesDiffer: comparison ? comparison.onlyHeaderLinesDiffer : false,
    rowsOnDisk: comparison ? comparison.rowsOnDisk : 0,
    rowsRendered: comparison ? comparison.rowsRendered : measured.rows,
    sectionsOnDisk: comparison ? comparison.sectionsOnDisk : measured.sections,
    sectionsRendered: comparison ? comparison.sectionsRendered : measured.sections,
    headerLinesOnDisk: comparison ? comparison.headerLinesOnDisk : 0,
    headerLinesRendered: comparison ? comparison.headerLinesRendered : 0,
    proseLinesOnDisk: comparison ? comparison.proseLinesOnDisk : 0,
    proseLinesRendered: comparison ? comparison.proseLinesRendered : 0,
    lostRows: comparison ? comparison.lostRows : [],
    gainedRows: comparison ? comparison.gainedRows : [],
    changedRows: comparison ? comparison.changedRows : [],
    readingChanges: comparison ? comparison.readingChanges : [],
    readingChangesByKind: comparison ? comparison.readingChangesByKind : {},
    readingColumnOnDisk: comparison ? comparison.readingColumnOnDisk : false,
    readingColumnRendered: comparison ? comparison.readingColumnRendered : false,
    readingTotals: rendered.readingTotals || null,
    harvestGuideRows,
    sectionsLost: comparison ? comparison.sectionsLost : [],
    proseLinesLost: comparison ? comparison.proseLinesLost : [],
    proseLinesGained: comparison ? comparison.proseLinesGained : [],
    bytesOnDisk: artifactPresent ? Buffer.byteLength(onDisk, "utf8") : 0,
    bytesRendered: measured.bytes,
    written: null,
    movedAside: [],
    refusal: null,
  };

  if (!apply) {
    // Rehearsal: the render lands in the copy, and the volume folder is untouched.
    const rehearsalFile = path.join(workSeriesDir, volume.folder, door.GLOSSARY_ARTIFACT);
    fs.mkdirSync(path.dirname(rehearsalFile), { recursive: true });
    await fs.promises.writeFile(rehearsalFile, rendered.markdown, "utf8");
    entry.rehearsalFile = rehearsalFile;
    return entry;
  }

  const published = await door.publishGlossaryRender({
    volumeDir,
    markdown: rendered.markdown,
    comparison,
    artifactPresent,
    moveAside,
  });
  if (!published.ok) {
    entry.ok = false;
    entry.refusal = published.refusal;
    return entry;
  }
  entry.written = published.written;
  entry.unchanged = published.unchanged;
  entry.movedAside = published.moved ? [path.basename(published.moved)] : [];
  entry.keptAside = published.keptAside;
  return entry;
}

/**
 * One line about what the `Readings` column would do to one volume.
 *
 * Written as one function because the same sentence is printed on the console and in the report, and a
 * column that reports itself two ways is a column two reports can disagree about.
 *
 * @param {Object} entry - One volume's report entry.
 * @returns {string}
 */
function describeReadings(entry) {
  const totals = entry.readingTotals;
  const kinds = entry.readingChangesByKind || {};
  const filled = totals ? totals.rowsFilled : 0;
  const empty = totals ? totals.rowsEmpty : 0;
  const several = totals ? totals.rowsWithSeveralReadings : 0;
  return (
    `file ${entry.readingColumnOnDisk ? "prints guides" : "has no reading column"} → ` +
    `render fills ${filled} of ${totals ? totals.rows : 0} row(s)${totals ? ` (${empty} say "no reading recorded", ${several} carry more than one)` : ""}${readingColumnReason(entry)}; ` +
    `added ${kinds.added || 0}, lost ${kinds.lost || 0}, invented ${kinds.invented || 0}`
  );
}

/**
 * Why the column this render would publish is empty, when it is — the sentence that keeps "0 rows filled"
 * from being read as "this book guided nothing".
 *
 * There are two different empties and this door can meet both on the same corpus. A record that predates
 * schema 12 has no `written_forms` table. A record copied from a corpus volume IS migrated by the store's
 * own open door, so its table exists and is empty, because the thing that files a harvest into a record is
 * `ensureVolumeWrittenFormsInRecord` inside `openVolumeRecord` and this door reads a copy, not a stage run.
 * The second one is the easy one to mistake for the first, and both sit beside a harvest file full of
 * guides.
 *
 * @param {Object} entry - One volume's report entry.
 * @returns {string} A clause, or "" when the column is not empty and nothing has to be explained.
 */
function readingColumnReason(entry) {
  const totals = entry.readingTotals;
  if (!totals || totals.rowsFilled > 0) return "";
  if (totals.tablePresent === false) return ", and this record has NO written-forms table at all";
  const harvest = entry.harvestGuideRows || 0;
  if (harvest === 0) return ", and this volume's folder holds no pronunciation-guide harvest to file";
  return `, and the copy this render read holds 0 written-form rows while volume ${entry.installment}'s own harvest holds ${harvest} guide row(s) — nothing has filed that harvest into the record`
}

/**
 * Render the report a person reads.
 *
 * @param {Object} report
 * @param {string} report.seriesDir
 * @param {boolean} report.apply
 * @param {Array<Object>} report.entries
 * @returns {string}
 */
function renderReport({ seriesDir, apply, entries }) {
  const lines = [
    "# Glossary re-render — what the record renders, against what is published",
    "",
    `Series: ${seriesDir}`,
    `Mode: ${apply ? "APPLIED — the published files were replaced, each kept as \`glossary.md.rejected\`" : "rehearsal — nothing in the series folder was touched"}`,
    "Model calls: 0. Rows written, edited or moved: 0. The corpus records were copied, never opened.",
    "",
    "| Volume | Rows on disk | Rows rendered | Sections | Header lines | Lost | Gained | Changed | Rows with a guide | Rows saying \"no reading recorded\" | Guides added | Guides lost | Guides invented | Only headers differ | Identical |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const entry of entries) {
    if (!entry.ok) {
      lines.push(`| ${entry.installment} | — | — | — | — | — | — | — | — | — | — | — | — | refused: ${entry.refusal ? entry.refusal.rule : "unknown"} |`);
      continue;
    }
    const totals = entry.readingTotals || {};
    const kinds = entry.readingChangesByKind || {};
    lines.push(
      `| ${entry.installment} | ${entry.rowsOnDisk} | ${entry.rowsRendered} | ${entry.sectionsOnDisk} → ${entry.sectionsRendered} | ` +
        `${entry.headerLinesOnDisk} → ${entry.headerLinesRendered} | ${entry.lostRows.length} | ${entry.gainedRows.length} | ` +
        `${entry.changedRows.length} | ${totals.rowsFilled ?? "—"} | ${totals.rowsEmpty ?? "—"} | ` +
        `${kinds.added || 0} | ${kinds.lost || 0} | ${kinds.invented || 0} | ` +
        `${entry.onlyHeaderLinesDiffer ? "yes" : "no"} | ${entry.identical ? "yes" : "no"} |`
    );
  }
  lines.push("");
  lines.push("## The reading column, volume by volume");
  lines.push("");
  lines.push("Every guide below comes from a `written_forms` row this volume's own record carries, bounded to");
  lines.push("this volume and the ones before it. A guide the record does not hold is refused, not printed.");
  lines.push("");
  for (const entry of entries) {
    if (!entry.ok) continue;
    lines.push(`- volume ${entry.installment}: ${describeReadings(entry)}`);
    if (entry.readingTotals && entry.readingTotals.rowsFilled === 0) {
      lines.push(
        `    (every row prints "no reading recorded", and that is NOT the sentence "these books guided ` +
          `nothing": ${readingColumnReason(entry).replace(/^, and /, "")})`
      );
    }
  }
  lines.push("");
  const guideDamage = entries.filter((entry) => entry.ok && entry.readingChanges && entry.readingChanges.some((change) => change.kind === "lost" || change.kind === "invented"));
  lines.push("## Guides this render would lose, or print without a record to back them");
  lines.push("");
  if (!guideDamage.length) lines.push("None. Every guide every published glossary prints is a guide its own record holds, and every guide the render prints is in the record.");
  for (const entry of guideDamage) {
    const bad = entry.readingChanges.filter((change) => change.kind === "lost" || change.kind === "invented");
    lines.push(`### Volume ${entry.installment} — ${bad.length} row(s)`);
    lines.push("");
    for (const change of bad) {
      lines.push(
        `- **${change.term}** (${change.section}) — \`${change.kind}\`: file prints ` +
          `${change.onDisk.map((r) => JSON.stringify(r)).join(", ") || "(nothing)"}, record holds ` +
          `${(change.expected || []).map((r) => JSON.stringify(r)).join(", ") || "(nothing)"}, render prints ` +
          `${change.rendered.map((r) => JSON.stringify(r)).join(", ") || "(nothing)"}`
      );
    }
    lines.push("");
  }
  const named = entries.filter((entry) => entry.lostRows && entry.lostRows.length);
  lines.push("");
  lines.push("## Rows that would disappear, and the rule that refused each one");
  lines.push("");
  if (!named.length) lines.push("None. Every row every published glossary holds is a row its own record holds and renders.");
  for (const entry of named) {
    lines.push(`### Volume ${entry.installment} — ${entry.lostRows.length} row(s)`);
    lines.push("");
    for (const row of entry.lostRows) {
      lines.push(`- **${row.term}** (${row.section}) — \`${row.rule}\`: ${row.because}`);
    }
    lines.push("");
  }
  const changed = entries.filter((entry) => entry.changedRows && entry.changedRows.length);
  lines.push("## Cells the render would rewrite");
  lines.push("");
  if (!changed.length) lines.push("None. Every rendering, every note and every section the published files hold is what the records hold.");
  for (const entry of changed) {
    lines.push(`### Volume ${entry.installment} — ${entry.changedRows.length} cell(s)`);
    for (const cell of entry.changedRows) lines.push(`- **${cell.term}** — \`${cell.field}\`: ${JSON.stringify(cell.onDisk)} → ${JSON.stringify(cell.rendered)}`);
    lines.push("");
  }
  const refused = entries.filter((entry) => !entry.ok);
  if (refused.length) {
    lines.push("## Volumes this door refused");
    lines.push("");
    for (const entry of refused) lines.push(`- volume ${entry.installment}: \`${entry.refusal ? entry.refusal.rule : "?"}\` — ${entry.refusal ? entry.refusal.because : ""}`);
    lines.push("");
  }
  const published = entries.filter((entry) => entry.movedAside && entry.movedAside.length);
  if (published.length) {
    lines.push("## Files replaced, and the copy kept");
    lines.push("");
    for (const entry of published) lines.push(`- volume ${entry.installment}: ${entry.movedAside.join(", ")} kept beside the new ${door.GLOSSARY_ARTIFACT}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`.replace(/\n{3,}/g, "\n\n");
}

/**
 * Run the command.
 * @returns {Promise<number>} The exit code.
 */
async function main() {
  loadEnv();
  const args = readArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`re-render-glossary: ${args.error}`);
    return 1;
  }
  const seriesDir = path.resolve(args.series || chosenSeriesLocation() || "");
  if (!seriesDir || !fs.existsSync(seriesDir)) {
    console.error("re-render-glossary: no series folder — set SERIES_LOCATION or pass --series=<dir>.");
    return 1;
  }

  const resolved = resolveVolumes(seriesDir, args);
  if (resolved.error) {
    console.error(`re-render-glossary: ${resolved.error}`);
    return 1;
  }
  const rehearsalRoot = path.resolve(args.out || DEFAULT_REHEARSAL_ROOT);
  // The record copy goes to the scratch folder **whether or not `--apply` was given**. It used to follow
  // `--apply`, and that was a defect: with `--apply` the scratch folder became the series folder, the copy
  // landed on top of the record it was copied from, and opening the copy opened the corpus record — which
  // checkpoints its write-ahead log and rewrites the file (gotcha 124), and runs the schema migration in
  // place. `--apply` decides where the rendered MARKDOWN is written. It must never decide where the record
  // is read from.
  // The scratch series folder the record copy is opened from. It is the SAME folder whether or not
  // `--apply` was given: `--apply` changes where the rendered markdown is written (the volume folder,
  // through the publish door), never where the record is read from.
  const workSeriesDir = rehearsalRoot;
  if (rehearsalRoot === seriesDir || rehearsalRoot.startsWith(seriesDir + path.sep)) {
    console.error(
      `re-render-glossary: refused — --out (${rehearsalRoot}) is the series folder or inside it. ` +
        `The record is copied there and opened, which is the one thing this door must not do to a corpus ` +
        `record (gotcha 124). Point --out= at a scratch folder outside ${seriesDir}.`
    );
    return 1;
  }
  printPlan({ seriesDir, rehearsalRoot, workSeriesDir, apply: args.apply, moveAside: args.moveAside, volumes: resolved.volumes });
  if (args.list) return 0;

  // The freeze gate, and the one thing that decides it here: `--apply`. A rehearsal writes into a copy
  // under `--out` and touches nothing in the series folder, so it is not a rewrite and stays allowed.
  // `--apply` replaces the volume's published `glossary.md`, which is the artifact the `glossary` door
  // already owns — so this door asks THAT door, and adds no door to the table.
  if (args.apply) {
    try {
      await assertDoorAllowed({
        door: "glossary",
        seriesDir,
        cancelledBy: "apply",
        volumes: resolved.volumes.map((v) => ({ folder: v.folder, installmentNumber: v.installmentNumber })),
      });
    } catch (err) {
      console.error(String((err && err.message) || err));
      return 1;
    }
  }

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(seriesDir, "translation-target.json"), "utf8"));
  } catch {
    manifest = null;
  }
  const runSettings = resolveRunSettings(manifest);

  /** @type {Array<Object>} */
  const entries = [];
  for (const volume of resolved.volumes) {
    const entry = await reRenderOneVolume({
      volume,
      seriesDir,
      scratchSeriesDir: workSeriesDir,
      workSeriesDir,
      apply: args.apply,
      moveAside: args.moveAside,
      runSettings,
    });
    entries.push(entry);
    if (!entry.ok) {
      console.log(`\nvolume ${entry.installment}: REFUSED — ${entry.refusal ? entry.refusal.rule : "?"}`);
      if (entry.refusal) console.log(`  ${entry.refusal.because}`);
      continue;
    }
    console.log(
      `\nvolume ${entry.installment}: rows on disk ${entry.rowsOnDisk} → rendered ${entry.rowsRendered}; ` +
        `lost ${entry.lostRows.length}, gained ${entry.gainedRows.length}, changed ${entry.changedRows.length}; ` +
        `sections ${entry.sectionsOnDisk} → ${entry.sectionsRendered}; header lines ${entry.headerLinesOnDisk} → ${entry.headerLinesRendered}; ` +
        `readings: ${describeReadings(entry)}; ` +
        `only headers differ: ${entry.onlyHeaderLinesDiffer ? "yes" : "no"}; identical: ${entry.identical ? "yes" : "no"}`
    );
    for (const row of entry.lostRows.slice(0, 8)) console.log(`  LOST ${JSON.stringify(row.term)} (${row.section}) — ${row.rule}`);
    if (entry.lostRows.length > 8) console.log(`  … ${entry.lostRows.length - 8} more named in the report`);
    if (entry.written) console.log(`  wrote ${entry.written}${entry.movedAside.length ? ` (kept: ${entry.movedAside.join(", ")})` : ""}`);
    else if (entry.unchanged) console.log(`  unchanged — the record already renders exactly the file on disk`);
    else if (entry.rehearsalFile) console.log(`  rehearsal render written to ${entry.rehearsalFile}`);
  }

  const reportDir = args.report ? path.dirname(path.resolve(args.report)) : args.apply ? postMortemDir() : rehearsalRoot;
  const mdFile = args.report ? path.resolve(args.report) : path.join(reportDir, REPORT_MD_FILE);
  fs.mkdirSync(path.dirname(mdFile), { recursive: true });
  await fs.promises.writeFile(mdFile, renderReport({ seriesDir, apply: args.apply, entries }), "utf8");
  await fs.promises.writeFile(mdFile.replace(/\.md$/, ".json"), JSON.stringify({ seriesDir, apply: args.apply, entries }, null, 2), "utf8");
  console.log(`\nreport: ${mdFile}`);
  console.log(`        ${mdFile.replace(/\.md$/, ".json")}`);
  if (args.json) console.log(JSON.stringify({ entries }, null, 2));

  const refused = entries.filter((entry) => !entry.ok).length;
  const differed = entries.filter((entry) => entry.ok && !entry.identical).length;
  if (refused) return 2;
  if (differed && !args.apply) return 2;
  return 0;
}

main()
  .then((code) => process.exitCode = code)
  .catch((err) => {
    console.error(`re-render-glossary: ${String((err && err.message) || err)}`);
    process.exitCode = 1;
  });

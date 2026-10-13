#!/usr/bin/env node
/**
 * test/measure-glossary-render.js — Part A of glossary route slice 2: compare a RENDERED
 * glossary against an AUTHORED one, entry for entry, with zero model calls.
 *
 * This is a **measurement**, not a test. `npm test` does not run it, and it refuses to run
 * against the live corpus: it only reads a scratch copy of the extracted books that the operator
 * (or the worker running it) placed under `--corpus-copy`, plus the authored artifacts pulled
 * out of the books' repository at the tag `pre-extraction-fix-2026-10-12` with
 * `git show <tag>:<path>` (AGENTS.md gotcha 10 — that repository is never checked out).
 *
 * What it does, per volume:
 *   1. copies the scratch volume folders into a throwaway series folder and drops that volume's
 *      authored `glossary.md` beside its extracted chapters;
 *   2. walks volumes 01..N through the store's own door — `openVolumeRecord` (copy-forward from
 *      the previous sealed record) and `importGlossary` (the door `ensureVolumeGlossaryInRecord`
 *      uses) — and seals each volume, which is what the acceptance gate does on a passing grade;
 *   3. renders volume N's record with `renderGlossary` and diffs it against the authored file:
 *      rows, sections, and the prose that is not a row.
 *
 * Usage:
 *   node test/measure-glossary-render.js --corpus-copy=<dir> --authored=<dir> --volumes=01,02,17
 *
 * @module test/measure-glossary-render
 */

"use strict";

const fs = require("fs");
const path = require("path");

const {
  openVolumeRecord,
  importGlossary,
  renderGlossary,
  parseGlossaryMarkdown,
  glossaryTermSpans,
  normalizeQuote,
} = require("../utils/reference-store");

/** Refuse to run against the live corpus. A scratch copy is a hard requirement (AGENTS.md rule 8). */
const LIVE_SERIES = "/mnt/windows/weeb/oresuki";

/**
 * Read the command line.
 * @returns {{corpusCopy: string, authored: string, volumes: string[], out: string}}
 */
function readArgs() {
  const argv = process.argv.slice(2);
  const pick = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const corpusCopy = pick("corpus-copy");
  const authored = pick("authored");
  if (!corpusCopy || !authored) {
    console.error(
      "usage: node test/measure-glossary-render.js --corpus-copy=<scratch series dir> " +
        "--authored=<dir of authored glossary-NN.md> [--volumes=01,02,17] [--out=<report dir>]"
    );
    process.exit(2);
  }
  if (path.resolve(corpusCopy) === LIVE_SERIES) {
    console.error(`refused: --corpus-copy must be a scratch COPY, not the live corpus (${LIVE_SERIES}).`);
    process.exit(2);
  }
  return {
    corpusCopy: path.resolve(corpusCopy),
    authored: path.resolve(authored),
    volumes: (pick("volumes") || "01,02,17").split(",").map((v) => v.trim()).filter(Boolean),
    out: path.resolve(pick("out") || "/tmp/opencode/glossary-slice2/report"),
  };
}

/**
 * The volume folder names in the scratch copy, in reading order.
 * @param {string} seriesDir
 * @returns {Array<{folder: string, installment: number}>}
 */
function volumeFolders(seriesDir) {
  return fs
    .readdirSync(seriesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /\((\d{1,2})\)$/.test(name))
    .map((name) => ({ folder: name, installment: Number(name.match(/\((\d{1,2})\)$/)[1]) }))
    .sort((a, b) => a.installment - b.installment);
}

/**
 * Count the data rows of a Markdown glossary the way a reader counts them: every `|` line that is
 * not a column header and not a separator, under the `## ` heading it sits under.
 *
 * Deliberately independent of the store's own parser, so "authored rows" and "parsed rows" are two
 * measurements and not one number printed twice.
 *
 * @param {string} markdown
 * @returns {Array<{term: string, rendering: string, notes: string, section: string, line: number}>}
 */
function countAuthoredRows(markdown) {
  const rows = [];
  let section = "";
  let tableLine = 0;
  String(markdown)
    .split("\n")
    .forEach((raw, index) => {
      const line = raw.trim();
      const heading = line.match(/^##\s+(.+)$/);
      if (heading) {
        section = heading[1].replace(/\*\*/g, "").trim();
        tableLine = 0;
        return;
      }
      if (!line.startsWith("|")) return;
      const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
      if (cells.length === 0) return;
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return;
      tableLine += 1;
      if (tableLine === 1) return; // the column header row
      rows.push({
        term: cells[0] || "",
        rendering: cells[1] || "",
        notes: cells.slice(2).join(" | ").trim(),
        section,
        line: index + 1,
      });
    });
  return rows;
}

/**
 * The `## ` sections of a glossary, with their line and byte totals.
 * @param {string} markdown
 * @returns {Array<{name: string, lines: number, bytes: number, rows: number}>}
 */
function sectionsOf(markdown) {
  const out = [];
  let current = null;
  for (const raw of String(markdown).split("\n")) {
    const heading = raw.trim().match(/^##\s+(.+)$/);
    if (heading) {
      if (current) out.push(current);
      current = { name: heading[1].replace(/\*\*/g, "").trim(), lines: 1, bytes: Buffer.byteLength(raw, "utf8"), rows: 0 };
      continue;
    }
    if (!current) continue;
    current.lines += 1;
    current.bytes += Buffer.byteLength(raw, "utf8");
    const cells = raw.trim().split("|").map((c) => c.trim()).filter((c) => c !== "");
    if (raw.trim().startsWith("|") && cells.length > 0 && !cells.every((c) => /^:?-{2,}:?$/.test(c))) current.rows += 1;
  }
  if (current) out.push(current);
  // The header row and the separator row are not entries.
  for (const section of out) section.rows = Math.max(0, section.rows - 1);
  return out;
}

/**
 * Every line of a glossary that is neither a heading nor a table line — the prose.
 * @param {string} markdown
 * @returns {Array<{text: string, line: number, section: string}>}
 */
function proseLinesOf(markdown) {
  const out = [];
  let section = "";
  String(markdown)
    .split("\n")
    .forEach((raw, index) => {
      const line = raw.trim();
      const heading = line.match(/^##\s+(.+)$/);
      if (heading) {
        section = heading[1].replace(/\*\*/g, "").trim();
        return;
      }
      if (!line || line.startsWith("|") || line.startsWith("#")) return;
      out.push({ text: raw.trimEnd(), line: index + 1, section });
    });
  return out;
}

/**
 * The identity of one glossary entry: its term cell, resolved to the spellings it names.
 *
 * Matched the way the carry-forward gate matches (gotcha 64/65/68): an entry is carried when its
 * spellings survive, so the comparison is on spellings, not on the whole cell string.
 *
 * @param {{term: string}} row
 * @returns {string[]} normalized spellings
 */
function entrySpans(row) {
  return glossaryTermSpans(row.term).map(normalizeQuote).filter(Boolean);
}

/**
 * Run one volume's chain and diff the render against the authored file.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir - Throwaway series folder holding the scratch copies.
 * @param {Array<{folder: string, installment: number}>} opts.folders - All volumes in reading order.
 * @param {number} opts.through - Render the record that exists after volumes 01..through.
 * @param {string} opts.authoredDir - Where `glossary-NN.md` lives.
 * @returns {Object} The measurement.
 */
function runChain({ seriesDir, folders, through, authoredDir }) {
  const importReports = [];
  let lastStore = null;

  for (const entry of folders) {
    if (entry.installment > through) break;
    const previous = folders.find((f) => f.installment === entry.installment - 1) || null;
    const opened = openVolumeRecord({
      volume: entry.installment,
      folder: entry.folder,
      seriesDir,
      previousVolume: previous ? previous.installment : null,
      previousFolder: previous ? previous.folder : null,
    });
    if (!opened.ok) {
      throw new Error(
        `volume ${entry.installment}'s record could not be opened: ${opened.refusal.because}\n` +
          opened.findings.map((f) => `  ${f.severity} ${f.kind}: ${f.message}`).join("\n")
      );
    }
    const store = opened.store;
    const authoredFile = path.join(authoredDir, `glossary-${String(entry.installment).padStart(2, "0")}.md`);
    const markdown = fs.readFileSync(authoredFile, "utf8");
    const result = importGlossary(store, markdown);
    importReports.push({
      volume: entry.installment,
      parsed: parseGlossaryMarkdown(markdown).rows.length,
      authored: countAuthoredRows(markdown).length,
      imported: result.imported.length,
      carried: result.carried.length,
      refused: result.refused,
      unplacedProse: result.unplacedProse,
      castRegistered: result.castRegistered,
      proseStored: result.proseStored,
      aliasesDeclared: result.aliasesDeclared,
      aliasRefused: result.aliasRefused,
      ambiguousAliases: result.ambiguousAliases,
    });
    store.sealVolume(entry.installment);
    if (lastStore) lastStore.close();
    lastStore = store;
  }

  const rendered = renderGlossary(lastStore);
  const renderedRows = countAuthoredRows(rendered);
  const renderedSections = sectionsOf(rendered);
  const renderedProse = proseLinesOf(rendered);

  const authoredFile = path.join(authoredDir, `glossary-${String(through).padStart(2, "0")}.md`);
  const authored = fs.readFileSync(authoredFile, "utf8");
  const authoredRows = countAuthoredRows(authored);
  const authoredSections = sectionsOf(authored);
  const authoredProse = proseLinesOf(authored);

  // Entry-for-entry: every authored entry, matched by its spellings against the render.
  const renderedSpanSet = new Set();
  for (const row of renderedRows) for (const span of entrySpans(row)) renderedSpanSet.add(span);
  const renderedRowByKey = new Map();
  for (const row of renderedRows) renderedRowByKey.set(`${normalizeQuote(row.term)}\u0000${row.section}`, row);

  const missingEntries = [];
  const changedEntries = [];
  for (const row of authoredRows) {
    const spans = entrySpans(row);
    const present = spans.length > 0 && spans.some((span) => renderedSpanSet.has(span));
    if (!present) {
      missingEntries.push({ term: row.term, section: row.section, line: row.line, rendering: row.rendering });
      continue;
    }
    const twin = renderedRowByKey.get(`${normalizeQuote(row.term)}\u0000${row.section}`);
    if (!twin) {
      changedEntries.push({ kind: "moved section", term: row.term, section: row.section });
      continue;
    }
    if (normalizeQuote(twin.rendering) !== normalizeQuote(row.rendering)) {
      changedEntries.push({ kind: "rendering differs", term: row.term, section: row.section, authored: row.rendering, rendered: twin.rendering });
    }
    if (normalizeQuote(twin.notes) !== normalizeQuote(row.notes)) {
      changedEntries.push({ kind: "notes differ", term: row.term, section: row.section, authoredBytes: Buffer.byteLength(row.notes, "utf8"), renderedBytes: Buffer.byteLength(twin.notes, "utf8") });
    }
  }

  // Entries the render produces that the authored file does not have.
  const authoredSpanSet = new Set();
  for (const row of authoredRows) for (const span of entrySpans(row)) authoredSpanSet.add(span);
  const extraEntries = renderedRows.filter((row) => {
    const spans = entrySpans(row);
    return spans.length > 0 && !spans.some((span) => authoredSpanSet.has(span));
  });

  const missingSections = authoredSections.filter(
    (section) => !renderedSections.some((r) => r.name === section.name)
  );
  const extraSections = renderedSections.filter(
    (section) => !authoredSections.some((a) => a.name === section.name)
  );

  // Prose: every authored non-table line, and whether the render carries it.
  const renderedProseSet = new Set(renderedProse.map((p) => normalizeQuote(p.text)));
  const lostProse = authoredProse.filter((p) => !renderedProseSet.has(normalizeQuote(p.text)));

  const refusedByReason = new Map();
  for (const report of importReports) {
    for (const item of report.refused) {
      const reason = item.because.replace(/volume \d+/, "volume N").slice(0, 120);
      if (!refusedByReason.has(reason)) refusedByReason.set(reason, { count: 0, examples: [] });
      const bucket = refusedByReason.get(reason);
      bucket.count += 1;
      if (bucket.examples.length < 3) bucket.examples.push(`${item.row.section} / ${item.row.term}`);
    }
  }

  if (lastStore) lastStore.close();

  return {
    through,
    importReports,
    authoredFile,
    authoredBytes: Buffer.byteLength(authored, "utf8"),
    authoredLines: authored.split("\n").length,
    authoredRows: authoredRows.length,
    authoredSections,
    authoredProse,
    renderedBytes: Buffer.byteLength(rendered, "utf8"),
    renderedLines: rendered.split("\n").length,
    renderedRows: renderedRows.length,
    renderedSections,
    renderedProse,
    missingEntries,
    changedEntries,
    extraEntries,
    missingSections,
    extraSections,
    lostProse,
    refusedByReason: [...refusedByReason.entries()].map(([reason, info]) => ({ reason, ...info })),
    renderedText: rendered,
  };
}

/**
 * Print one measurement as a report.
 * @param {Object} m - The measurement from `runChain`.
 * @param {string} outDir - Where to write the rendered file and the JSON.
 * @returns {void}
 */
function printReport(m, outDir) {
  const tag = `volume ${String(m.through).padStart(2, "0")}`;
  console.log(`\n════ ${tag} ════`);
  console.log(`authored : ${m.authoredBytes} bytes, ${m.authoredLines} lines, ${m.authoredRows} rows, ${m.authoredSections.length} sections`);
  console.log(`rendered : ${m.renderedBytes} bytes, ${m.renderedLines} lines, ${m.renderedRows} rows, ${m.renderedSections.length} sections`);
  console.log(`delta    : ${m.renderedBytes - m.authoredBytes} bytes (${((m.renderedBytes / m.authoredBytes) * 100).toFixed(1)}% of authored)`);

  let totalAuthored = 0;
  let totalParsed = 0;
  let totalImported = 0;
  let totalCarried = 0;
  let totalRefused = 0;
  for (const r of m.importReports) {
    totalAuthored += r.authored;
    totalParsed += r.parsed;
    totalImported += r.imported;
    totalCarried += r.carried;
    totalRefused += r.refused.length;
    console.log(
      `  vol ${String(r.volume).padStart(2, "0")}: authored ${r.authored} rows, parsed ${r.parsed}, filed ${r.imported}, ` +
        `carried ${r.carried}, refused ${r.refused.length}, cast ${r.castRegistered}, prose blocks ${r.proseStored}, ` +
        `unplaced prose ${r.unplacedProse.length}, aliases ${r.aliasesDeclared.length}`
    );
  }
  console.log(`totals   : authored ${totalAuthored}, parsed ${totalParsed}, filed ${totalImported}, carried ${totalCarried}, refused ${totalRefused}`);

  console.log(`\n  sections the render does NOT produce: ${m.missingSections.length}`);
  for (const s of m.missingSections) console.log(`    - "${s.name}" — ${s.lines} lines, ${s.bytes} bytes, ${s.rows} rows`);
  console.log(`  sections the render adds: ${m.extraSections.length}`);
  for (const s of m.extraSections) console.log(`    + "${s.name}" — ${s.rows} rows`);

  console.log(`\n  entries the authored file has that the render does NOT produce: ${m.missingEntries.length}`);
  for (const e of m.missingEntries.slice(0, 40)) console.log(`    - [${e.section}] ${e.term}  (authored line ${e.line})`);
  if (m.missingEntries.length > 40) console.log(`    … ${m.missingEntries.length - 40} more`);

  console.log(`\n  entries present but CHANGED: ${m.changedEntries.length}`);
  for (const e of m.changedEntries.slice(0, 25)) console.log(`    ~ ${e.kind}: [${e.section}] ${e.term}`);
  if (m.changedEntries.length > 25) console.log(`    … ${m.changedEntries.length - 25} more`);

  console.log(`\n  entries the render produces that the authored file does not have: ${m.extraEntries.length}`);
  for (const e of m.extraEntries.slice(0, 20)) console.log(`    + [${e.section}] ${e.term}`);
  if (m.extraEntries.length > 20) console.log(`    … ${m.extraEntries.length - 20} more`);

  console.log(`\n  prose lines the authored file has that the render does NOT carry: ${m.lostProse.length} of ${m.authoredProse.length}`);
  for (const p of m.lostProse.slice(0, 20)) console.log(`    - [${p.section}] line ${p.line}: ${p.text.slice(0, 160)}`);
  if (m.lostProse.length > 20) console.log(`    … ${m.lostProse.length - 20} more`);

  console.log(`\n  refusal reasons:`);
  for (const r of m.refusedByReason) {
    console.log(`    ${r.count} × ${r.reason}`);
    for (const ex of r.examples) console.log(`        · ${ex}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `rendered-${String(m.through).padStart(2, "0")}`);
  fs.writeFileSync(`${base}.md`, m.renderedText, "utf8");
  fs.writeFileSync(
    `${base}.json`,
    JSON.stringify({ ...m, renderedText: undefined }, null, 2) + "\n",
    "utf8"
  );
  console.log(`\n  wrote ${base}.md and ${base}.json`);
}

/**
 * Entry point.
 * @returns {void}
 */
function main() {
  const args = readArgs();
  const folders = volumeFolders(args.corpusCopy);
  if (folders.length === 0) {
    console.error(`no volume folders found under ${args.corpusCopy}`);
    process.exit(1);
  }
  console.log(`scratch series: ${args.corpusCopy} (${folders.length} volumes)`);
  console.log(`authored dir  : ${args.authored}`);

  for (const wanted of args.volumes) {
    const through = Number(wanted);
    const work = path.join(args.out, `chain-${String(through).padStart(2, "0")}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    // Copy the scratch volumes into a throwaway series so the measurement never reuses a record.
    for (const entry of folders) {
      if (entry.installment > through) continue;
      fs.cpSync(path.join(args.corpusCopy, entry.folder), path.join(work, entry.folder), { recursive: true });
    }
    const measurement = runChain({ seriesDir: work, folders, through, authoredDir: args.authored });
    printReport(measurement, args.out);
  }
}

main();

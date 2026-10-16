#!/usr/bin/env node
/**
 * test/measure-settlement-agenda.js — plan 07 slice 7, measured against the **live corpus** on
 * **copies** of the 17 records. Zero model calls. Nothing in the corpus is written.
 *
 * Three questions, all answerable without asking a model anything:
 *
 *   1. **How much work the shipped text rule actually does.** Each of the 15 forward-reveal shapes is
 *      run over every published glossary row's notes cell in the settled record, and the per-shape hit
 *      count, the row count and the distinct-term count are printed. The chain half is counted beside it.
 *   2. **What language the notes are actually in.** Every notes cell in all 17 records is classified by
 *      the script its letters are written in — a script count, not a language claim — so the question
 *      "are the notes English today?" is answered by a number rather than by a guess.
 *   3. **What the agenda says today when the notes are not in the script the rule was written in.**
 *      Answered by a fixture, in `test/test-settlement-agenda-coverage.js`, and summarised here.
 *
 * Safety (gotcha 124 / gotcha 166 / gotcha 172): a corpus `series.db` is **never opened**. Each volume's
 * record is copied with `fs.copyFileSync` into a scratch folder outside `SERIES_LOCATION`, and the copy is
 * what the engine sees. Every corpus `series.db`, `-wal`, `-shm` and `glossary.md` is hashed before the
 * run and again after it, and the script fails if any digest moved or any sidecar appeared or vanished.
 *
 * `npm test` does not run it: it depends on books that are not in this repository (AGENTS.md rule 8).
 *
 * Usage: node test/measure-settlement-agenda.js [--series=<series folder>] [--out=<scratch dir>]
 *
 * @module test/measure-settlement-agenda
 */

"use strict";

require("../configs/env-defaults").loadEnv();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { chosenSeriesLocation } = require("../configs/env-defaults");
const { openReferenceStore } = require("../utils/reference-store");
const { publishedGlossaryRowsInRecord } = require("../utils/reference-store/glossary-adapter");
const { settlementAgenda, FORWARD_REVEAL_SHAPES, DROPPED_SHAPES } = require("../glossary/settlement/agenda");
const { researchNotesInRecord } = require("../utils/reference-store");
require("../types"); // JSDoc type definitions

/** Where the copies go. Never inside the series folder (gotcha 172). */
const DEFAULT_SCRATCH = "/tmp/opencode/plan07-slice7/measure-db-copy";

/** The corpus files whose digests must not move. */
const GUARDED_FILES = ["series.db", "series.db-wal", "series.db-shm", "glossary.md"];

/**
 * sha256 of a file's bytes.
 * @param {string} file @returns {string}
 */
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Snapshot every guarded corpus file.
 * @param {string} seriesDir
 * @param {string[]} folders
 * @returns {Map<string, {bytes: number, sha256: string|null}>} keyed `<folder>/<name>`
 */
function snapshot(seriesDir, folders) {
  /** @type {Map<string, {bytes: number, sha256: string|null}>} */
  const out = new Map();
  for (const folder of folders) {
    for (const name of GUARDED_FILES) {
      const full = path.join(seriesDir, folder, name);
      if (!fs.existsSync(full)) {
        out.set(`${folder}/${name}`, { bytes: 0, sha256: null });
        continue;
      }
      out.set(`${folder}/${name}`, { bytes: fs.statSync(full).size, sha256: sha256(full) });
    }
  }
  return out;
}

/**
 * Compare two snapshots and report every difference.
 * @param {Map<string, Object>} before
 * @param {Map<string, Object>} after
 * @returns {string[]} One line per difference; empty means nothing moved.
 */
function diffSnapshots(before, after) {
  const problems = [];
  for (const [key, was] of before) {
    const now = after.get(key);
    if (!now) {
      problems.push(`${key} disappeared`);
      continue;
    }
    if (was.sha256 === null && now.sha256 === null) continue;
    if (was.sha256 === null) problems.push(`${key} appeared`);
    else if (now.sha256 === null) problems.push(`${key} disappeared`);
    else if (was.sha256 !== now.sha256) problems.push(`${key} changed (${was.sha256.slice(0, 12)} → ${now.sha256.slice(0, 12)})`);
  }
  for (const key of after.keys()) if (!before.has(key)) problems.push(`${key} appeared`);
  return problems;
}

/**
 * Every volume folder in the series that holds a reference record, in reading order.
 * @param {string} seriesDir
 * @returns {Array<{folder: string, volume: number}>}
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
    .sort((a, b) => volumeOf(a) - volumeOf(b));
  if (!folders.length) {
    console.error(`refused: no volume folder under ${seriesDir} holds a series.db.`);
    process.exit(2);
  }
  return folders.map((folder) => ({ folder, volume: volumeOf(folder) }));
}

/**
 * The installment number a folder name carries.
 * @param {string} folder @returns {number}
 */
function volumeOf(folder) {
  const m = folder.match(/\((\d+)\)/);
  return m ? Number(m[1]) : Number(folder) || 0;
}

// ─── Script classification (a script count, never a language claim) ───────────

/**
 * The scripts this measurement can tell apart, by Unicode range. Names are script names, not language
 * names: the measurement answers "which writing system are these letters from", which is all the
 * question needs.
 *
 * @type {Array<{name: string, range: [number, number]}>}
 */
const SCRIPTS = [
  { name: "Han", range: [0x3400, 0x4dbf] },
  { name: "Han", range: [0x4e00, 0x9fff] },
  { name: "Han", range: [0xf900, 0xfaff] },
  { name: "Hiragana", range: [0x3040, 0x309f] },
  { name: "Katakana", range: [0x30a0, 0x30ff] },
  { name: "Hangul", range: [0x1100, 0x11ff] },
  { name: "Hangul", range: [0x3130, 0x318f] },
  { name: "Hangul", range: [0xac00, 0xd7af] },
  { name: "Cyrillic", range: [0x0400, 0x04ff] },
  { name: "Greek", range: [0x0370, 0x03ff] },
  { name: "Arabic", range: [0x0600, 0x06ff] },
  { name: "Hebrew", range: [0x0590, 0x05ff] },
  { name: "Devanagari", range: [0x0900, 0x097f] },
  { name: "Thai", range: [0x0e00, 0x0e7f] },
  { name: "Latin", range: [0x0041, 0x005a] },
  { name: "Latin", range: [0x0061, 0x007a] },
  { name: "Latin", range: [0x00c0, 0x024f] },
];

/**
 * The script of one character, or null when it is punctuation, a digit or a space.
 * @param {string} ch @returns {string|null}
 */
function scriptOf(ch) {
  const code = ch.codePointAt(0);
  for (const script of SCRIPTS) {
    if (code >= script.range[0] && code <= script.range[1]) return script.name;
  }
  return null;
}

/**
 * The script counts of one string.
 * @param {string} text @returns {Map<string, number>} script → letter count
 */
function scriptCounts(text) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const ch of String(text || "")) {
    const s = scriptOf(ch);
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  return counts;
}

/**
 * The dominant script of a string, or `none` when it holds no letters at all.
 * @param {string} text @returns {string}
 */
function dominantScript(text) {
  const counts = scriptCounts(text);
  let best = "none";
  let bestCount = 0;
  for (const [name, n] of counts) {
    if (n > bestCount) {
      best = name;
      bestCount = n;
    }
  }
  return best;
}

// ─── The run ──────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

async function main() {
  const seriesDir = path.resolve(arg("series", chosenSeriesLocation()));
  const scratchSeriesDir = path.resolve(arg("out", DEFAULT_SCRATCH));
  if (scratchSeriesDir === seriesDir || scratchSeriesDir.startsWith(seriesDir + path.sep)) {
    console.error(`refused: the scratch folder (${scratchSeriesDir}) sits inside the series folder (${seriesDir}). (gotcha 172)`);
    process.exit(2);
  }

  const refs = volumeRecords(seriesDir);
  const folders = refs.map((r) => r.folder);
  const before = snapshot(seriesDir, folders);
  console.log(`corpus: ${refs.length} volume record(s). Guarded files hashed: ${before.size}.`);

  fs.rmSync(scratchSeriesDir, { recursive: true, force: true });
  fs.mkdirSync(scratchSeriesDir, { recursive: true });

  /** Per-volume notes-cell script census. @type {Map<string, number>} */
  const scriptCensus = new Map();
  /** Rows whose notes hold letters of more than one script. */
  let mixedRows = 0;
  let rowsWithNotes = 0;
  let rowsWithoutNotes = 0;
  let totalRows = 0;
  /** @type {Array<{volume: number, rows: number, withNotes: number}>} */
  const perVolume = [];

  /** @type {Map<number, {folder: string, store: Object}>} */
  const opened = new Map();
  for (const ref of refs) {
    const volumeDir = path.join(seriesDir, ref.folder);
    const scratchVolumeDir = path.join(scratchSeriesDir, ref.folder);
    fs.mkdirSync(scratchVolumeDir, { recursive: true });
    for (const suffix of ["", "-wal"]) {
      if (fs.existsSync(volumeDir + "/series.db" + suffix)) fs.copyFileSync(path.join(volumeDir, "series.db" + suffix), path.join(scratchVolumeDir, "series.db" + suffix));
    }
    const store = openReferenceStore({ seriesDir: scratchSeriesDir, volume: ref.volume, folder: ref.folder, create: false, stage: "merge" });
    opened.set(ref.volume, { folder: ref.folder, store });
    const rows = publishedGlossaryRowsInRecord(store, { volume: ref.volume });
    let withNotes = 0;
    for (const row of rows) {
      totalRows += 1;
      const notes = String(row.notes || "");
      if (!notes.trim()) {
        rowsWithoutNotes += 1;
        continue;
      }
      withNotes += 1;
      rowsWithNotes += 1;
      const counts = scriptCounts(notes);
      if (counts.size > 1) mixedRows += 1;
      const dom = dominantScript(notes);
      scriptCensus.set(dom, (scriptCensus.get(dom) || 0) + 1);
    }
    perVolume.push({ volume: ref.volume, rows: rows.length, withNotes });
  }

  console.log("\n1. what script the published notes are written in (all 17 records, copies only)");
  console.log(`   rows read: ${totalRows}; with a notes cell: ${rowsWithNotes}; empty notes cell: ${rowsWithoutNotes}`);
  console.log(`   notes holding letters of more than one script: ${mixedRows}`);
  for (const [script, n] of [...scriptCensus].sort((a, b) => b[1] - a[1])) {
    console.log(`   dominant script "${script}": ${n} notes cell(s) (${((n / Math.max(rowsWithNotes, 1)) * 100).toFixed(1)}%)`);
  }
  console.log("   per volume (rows / rows with a notes cell):");
  for (const v of perVolume) console.log(`     volume ${String(v.volume).padStart(2)}: ${v.rows} / ${v.withNotes}`);

  // ── 2. the agenda, and the per-shape firing, on the settled record ──────────
  const settledVolume = Math.max(...refs.map((r) => r.volume));
  const settled = opened.get(settledVolume).store;
  const rows = publishedGlossaryRowsInRecord(settled, { volume: settledVolume });
  const notesByTerm = new Map();
  for (const note of researchNotesInRecord(settled)) {
    const key = String(note.term || "").trim();
    if (!key) continue;
    if (!notesByTerm.has(key)) notesByTerm.set(key, []);
    notesByTerm.get(key).push(note);
  }

  console.log(`\n2. the shipped text rule, run over the settled record (volume ${settledVolume}, ${rows.length} published row(s))`);
  /** @type {Map<string, {rows: number, terms: Set<string>}>} */
  const perShape = new Map();
  for (const shape of FORWARD_REVEAL_SHAPES) perShape.set(shape.name, { rows: 0, terms: new Set() });
  const droppedPerShape = new Map();
  for (const shape of DROPPED_SHAPES) droppedPerShape.set(shape.name, { rows: 0, terms: new Set() });

  let firedRows = 0;
  /** @type {Set<string>} */
  const firedTerms = new Set();
  for (const row of rows) {
    const key = String(row.term || "").trim();
    const notes = String(row.notes || "");
    const merged = notesByTerm.has(key) ? `${notes} ${notesByTerm.get(key).map((n) => String(n.note || n.text || "")).join(" ")}` : notes;
    let any = false;
    for (const shape of FORWARD_REVEAL_SHAPES) {
      if (shape.re.test(merged)) {
        const rec = perShape.get(shape.name);
        rec.rows += 1;
        rec.terms.add(key);
        any = true;
      }
    }
    for (const shape of DROPPED_SHAPES) {
      if (shape.re.test(merged)) {
        const rec = droppedPerShape.get(shape.name);
        rec.rows += 1;
        rec.terms.add(key);
      }
    }
    if (any) {
      firedRows += 1;
      firedTerms.add(key);
    }
  }
  console.log(`   shapes that fire on at least one row: ${[...perShape].filter(([, v]) => v.rows > 0).length} of ${FORWARD_REVEAL_SHAPES.length}`);
  for (const [name, rec] of perShape) {
    console.log(`   ${name.padEnd(24)} rows ${String(rec.rows).padStart(4)}  terms ${rec.terms.size}`);
  }
  console.log(`   rows the shipped shapes fire on: ${firedRows}; distinct terms: ${firedTerms.size}`);
  console.log("   the two DROPPED shapes, kept for the record (they must not fire on the rows they fired on):");
  for (const [name, rec] of droppedPerShape) console.log(`   ${name.padEnd(24)} rows ${String(rec.rows).padStart(4)}  terms ${rec.terms.size}`);

  console.log("   the rows the shipped shapes fire on, and what the notes say:");
  for (const row of rows) {
    const key = String(row.term || "").trim();
    const merged = notesByTerm.has(key) ? `${String(row.notes || "")} ${notesByTerm.get(key).map((n) => String(n.note || n.text || "")).join(" ")}` : String(row.notes || "");
    if (!FORWARD_REVEAL_SHAPES.some((s) => s.re.test(merged))) continue;
    console.log(`     · ${key} (volume ${row.ownerVolume}): ${merged.slice(0, 220)}`);
  }

  // ── 2b. two script-neutral proxies, measured against the same 10 terms ──────
  // Both are candidate replacements for the text rule. Neither is shipped here; they are measured so the
  // choice is made against numbers rather than against a preference.
  const numberInNote = /\b(?:volume|vol\.?|chapter|book|instalment|installment)\s*(?:no\.?\s*)?(\d+)/i;
  /** @type {Set<string>} */
  const proxyTerms = new Set();
  for (const row of rows) {
    const key = String(row.term || "").trim();
    const merged = notesByTerm.has(key) ? `${String(row.notes || "")} ${notesByTerm.get(key).map((n) => String(n.note || n.text || "")).join(" ")}` : String(row.notes || "");
    const own = Number(row.appliesFromVolume);
    let m;
    const re = new RegExp(numberInNote.source, "gi");
    while ((m = re.exec(merged))) {
      if (Number(m[1]) > own) {
        proxyTerms.add(key);
        break;
      }
    }
  }
  console.log(`   proxy A (the note names a volume/chapter number greater than the row's own volume): ${proxyTerms.size} term(s)`);

  // Proxy B: the term shows up again in a LATER volume's own extraction pass — the book kept printing it.
  const extractionTermsByVolume = new Map();
  for (const [volume, { store }] of opened) {
    const terms = new Set();
    for (const r of store.db
      .prepare("SELECT examples FROM facts WHERE aspect = 'term_usage' AND source_stage = ?")
      .all("extract")) {
      try {
        const ex = JSON.parse(r.examples || "[]");
        const t = String(ex[0] || "").trim();
        if (t) terms.add(t);
      } catch {
        /* an unparsable candidate row names no term */
      }
    }
    extractionTermsByVolume.set(volume, terms);
  }
  let proxyB = 0;
  /** @type {Set<string>} */
  const proxyBSet = new Set();
  for (const row of rows) {
    const key = String(row.term || "").trim();
    for (const [volume, terms] of extractionTermsByVolume) {
      if (volume > Number(row.appliesFromVolume) && terms.has(key)) {
        proxyB += 1;
        proxyBSet.add(key);
        break;
      }
    }
  }
  console.log(`   proxy B (the term is re-reported by a later volume's own read pass): ${proxyBSet.size} term(s) of ${rows.length}`);

  // Proxy C: a LATER volume's own read pass would have rendered this term DIFFERENTLY. The record already
  // holds each volume's extraction candidates (`source_stage = 'extract'`), so this is a disagreement
  // between the pipeline's own judgements, separated in time — and it needs no vocabulary in any language.
  /** @type {Map<number, Map<string, string>>} volume → term → rendering the read pass proposed */
  const proposedByVolume = new Map();
  for (const [volume, { store }] of opened) {
    /** @type {Map<string, string>} */
    const proposed = new Map();
    for (const r of store.db
      .prepare("SELECT examples FROM facts WHERE aspect = 'term_usage' AND source_stage = ?")
      .all("extract")) {
      try {
        const ex = JSON.parse(r.examples || "[]");
        const t = String(ex[0] || "").trim();
        const rendering = String(ex[1] || "").trim();
        if (t) proposed.set(t, rendering);
      } catch {
        /* an unparsable candidate row proposes nothing */
      }
    }
    proposedByVolume.set(volume, proposed);
  }
  /** @type {Set<string>} */
  const proxyCSet = new Set();
  for (const row of rows) {
    const key = String(row.term || "").trim();
    const settledRendering = String(row.rendering || "").trim();
    for (const [volume, proposed] of proposedByVolume) {
      if (volume <= Number(row.appliesFromVolume)) continue;
      if (!proposed.has(key)) continue;
      if (String(proposed.get(key) || "").trim() !== settledRendering) {
        proxyCSet.add(key);
        break;
      }
    }
  }
  console.log(`   proxy C (a later volume's own read pass proposes a DIFFERENT rendering for the term): ${proxyCSet.size} term(s) of ${rows.length}`);
  console.log(`   overlap of proxy A with the 10 shipped-rule terms: ${[...proxyTerms].filter((t) => firedTerms.has(t)).length}`);
  console.log(`   overlap of proxy B with the 10 shipped-rule terms: ${[...proxyBSet].filter((t) => firedTerms.has(t)).length}`);
  console.log(`   overlap of proxy C with the 10 shipped-rule terms: ${[...proxyCSet].filter((t) => firedTerms.has(t)).length}`);
  console.log(`   proxy C terms, named: ${[...proxyCSet].slice(0, 40).join(", ")}`);

  const agenda = settlementAgenda(settled, {});
  console.log(`   agenda: ${agenda.candidateCount} term(s) — ${agenda.chainCount} already revised, ${agenda.forwardCount} whose own note points forward; bound ${agenda.limit}, capped ${agenda.capped}`);
  for (const item of agenda.agenda) console.log(`     · ${item.term} (volume ${item.flaggingVolume}) — ${item.because}`);

  // The coverage of the note half, asked of the same record the agenda was read from. This is the number
  // plan 07 §4.8 says the pass must not lose: today it is `covered`, and the whole point of measuring it
  // is to have the number to compare against after the extraction prompt starts writing its notes in the
  // language of the book.
  const rule = agenda.textRule;
  console.log(`   note-half coverage: state ${rule.state}, askable ${rule.askable}, ` +
    `vocabulary scripts [${rule.vocabularyScripts.join(", ")}], notes read ${rule.notesRead}, ` +
    `outside the vocabulary ${rule.notesOutsideVocabulary}, holding no letters ${rule.notesWithNoLetters}, ` +
    `rows fired by a shipped shape ${rule.rowsFiredByShapes}, by a declared marker ${rule.rowsFiredByMarkers}, ` +
    `markers in force ${rule.markerCount}`);
  console.log(`     — ${rule.because}`);
  const withMarkers = settlementAgenda(settled, { forwardMarkers: [{ phrase: "revealed later", because: "probe: a phrase the shipped list already matches" }] });
  console.log(`   declared-marker probe (1 marker, the shipped vocabulary's own phrase): agenda ${withMarkers.candidateCount} term(s), ` +
    `forward ${withMarkers.forwardCount}, rows a marker fired on ${withMarkers.textRule.rowsFiredByMarkers}, ` +
    `markers that fired on nothing ${withMarkers.textRule.markersThatFiredOnNothing.length}`);

  for (const { store } of opened.values()) {
    try {
      store.close();
    } catch {
      /* a copy that will not close leaves nothing behind but a handle */
    }
  }

  const after = snapshot(seriesDir, folders);
  const problems = diffSnapshots(before, after);
  console.log(`\n3. corpus untouched: ${problems.length} difference(s) across ${before.size} guarded files.`);
  for (const p of problems) console.error(`   ${p}`);
  if (problems.length) {
    console.error("FAILED: the measurement moved the corpus it was supposed to only read.");
    process.exit(1);
  }
  console.log("   0 model calls, 0 corpus writes.");
}

main().catch((err) => {
  console.error(String((err && err.stack) || err));
  process.exit(1);
});

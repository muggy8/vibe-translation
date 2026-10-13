#!/usr/bin/env node
/**
 * test/measure-glossary-research.js — Part A of glossary route slice 5: run the SHIPPED research
 * classifier over the tagged real glossaries and print what it picks, what it drops, and what a
 * per-volume cap would cost. With zero model calls. It also re-runs the five candidate rules the plan
 * measured and rejected, so §5.1 of `glossary/plan/01-glossary-route.md` is reproducible rather than
 * remembered.
 *
 * This is a **measurement**, not a test. `npm test` does not run it, and it refuses to run against the
 * live corpus (AGENTS.md rule 8). It reads only the read-only copies of the authored artifacts that the
 * operator (or the worker running it) pulled out of the books' repository at the tag
 * `pre-extraction-fix-2026-10-12` with `git show <tag>:<path>` — never a checkout, never a write
 * (AGENTS.md gotcha 10).
 *
 * It imports the predicate the stage actually runs on (`glossary/researchable.js`), so the numbers it
 * prints are the numbers the bound enforces, not the numbers a prototype once produced.
 *
 * Usage:
 *   node test/measure-glossary-research.js --tagged=/tmp/opencode/tagged
 *
 * The tagged folder must hold `cumulative-glossary.md` and `volume-01.md` … `volume-17.md`.
 *
 * @module test/measure-glossary-research
 */

"use strict";

const fs = require("fs");
const path = require("path");

const { parseGlossaryMarkdown, glossaryTermSpans, normalizeQuote } = require("../utils/reference-store");
const {
  classifyResearchable,
  RESEARCH_MAX_TERMS_PER_VOLUME,
  RESEARCH_WORLD_SECTIONS,
  OUTSIDE_REFERENT_SHAPES,
  INVENTED_BY_SERIES_SHAPES,
} = require("../glossary/researchable");

/** Refuse to run against the live corpus. A scratch copy is a hard requirement (AGENTS.md rule 8). */
const LIVE_SERIES = "/mnt/windows/weeb/oresuki";

/**
 * Read the command line.
 * @returns {{tagged: string}} Where the read-only tagged copies live.
 */
function readArgs() {
  const hit = process.argv.slice(2).find((a) => a.startsWith("--tagged="));
  const tagged = hit ? hit.slice("--tagged=".length) : null;
  if (!tagged) {
    console.error("usage: node test/measure-glossary-research.js --tagged=<dir of tagged glossary copies>");
    process.exit(2);
  }
  const resolved = path.resolve(tagged);
  if (resolved === LIVE_SERIES || resolved.startsWith(LIVE_SERIES + path.sep)) {
    console.error(`refused: ${resolved} is the live corpus. This measurement reads tagged copies only.`);
    process.exit(2);
  }
  return { tagged: resolved };
}

/**
 * The identity of one glossary row's term, the same shape `documentTermAlreadyStored` compares on.
 * @param {string} term
 * @returns {string}
 */
function termKey(term) {
  return glossaryTermSpans(term)
    .map((span) => normalizeQuote(span))
    .filter(Boolean)
    .join("\u0000");
}

/**
 * The rule candidates that were tried before the shipped one, so the numbers in
 * `glossary/plan/01-glossary-route.md` §5.1 are reproducible from this file rather than remembered.
 *
 * "Loose outside markers" are the ones the measurement rejected: they fire on prose that is not a
 * real-world reference at all ("her real name is withheld", "the school's real cultural festival", a
 * Japanese word that is simply standard Japanese). They are kept here so the rejection can be re-run.
 *
 * @type {Array<{name: string, test: function({section: string|null, notes: string}): boolean, why: string}>}
 */
const CANDIDATE_RULES = [
  {
    name: "A — section only (Real-World References ∪ Places)",
    test: (row) => RESEARCH_WORLD_SECTIONS.includes(row.section),
    why: "the plan's first idea: the section a row renders under",
  },
  {
    name: "B — A minus the invented markers",
    test: (row) => RESEARCH_WORLD_SECTIONS.includes(row.section) && classifyResearchable(row).invented.length === 0,
    why: "A, with the disqualifier bolted on",
  },
  {
    name: "C — A ∪ loose outside markers",
    test: (row) => RESEARCH_WORLD_SECTIONS.includes(row.section) || LOOSE_OUTSIDE_MARKERS.some((re) => re.test(row.notes || "")),
    why: "the wide version: any note that smells like a real-world reference",
  },
  {
    name: "D — C minus the invented markers",
    test:
      (row) =>
        (RESEARCH_WORLD_SECTIONS.includes(row.section) || LOOSE_OUTSIDE_MARKERS.some((re) => re.test(row.notes || ""))) &&
        classifyResearchable(row).invented.length === 0,
    why: "C with the disqualifier",
  },
  {
    name: "E — loose markers only",
    test: (row) => LOOSE_OUTSIDE_MARKERS.some((re) => re.test(row.notes || "")),
    why: "the note alone, with no section at all",
  },
  {
    name: "SHIPPED — narrow section ∪ narrow note declaration, minus invented",
    test: (row) => classifyResearchable(row).researchable,
    why: "what the stage actually runs",
  },
];

/** The loose markers, kept so their rejection is re-runnable. None of them shipped. */
const LOOSE_OUTSIDE_MARKERS = [
  /\bReal\b/,
  /\bthe real\b/i,
  /\ballusion\b/i,
  /\bestablished English\b/i,
  /\bStandard Japanese\b/i,
  /\bwasei-eigo\b/i,
  /\bloanword\b/i,
  /\bstraight literature\b/i,
  /\bclassical allusion\b/i,
  /\breal brand\b/i,
];

/**
 * Print the candidate rules side by side over the same rows.
 * @param {Array<Object>} rows The parsed glossary rows.
 * @returns {void}
 */
function measureCandidates(rows) {
  console.log("\n--- candidate rules, the same 554 rows ---");
  for (const candidate of CANDIDATE_RULES) {
    const selected = rows.filter((row) => candidate.test(row));
    console.log(
      `  ${candidate.name}: selected ${selected.length}, skipped ${rows.length - selected.length} — ${candidate.why}`
    );
  }
  console.log("  (the loose markers in C/D/E are the ones the measurement rejected; none of them shipped)");
}

/**
 * Run the measurement.
 * @returns {void}
 */
function main() {
  const { tagged } = readArgs();
  const cumulative = path.join(tagged, "cumulative-glossary.md");
  if (!fs.existsSync(cumulative)) {
    console.error(`refused: ${cumulative} is not there.`);
    process.exit(2);
  }

  const rows = parseGlossaryMarkdown(fs.readFileSync(cumulative, "utf8")).rows;
  console.log(`tagged cumulative glossary: ${rows.length} row(s)`);

  const bySection = new Map();
  for (const row of rows) bySection.set(row.section, (bySection.get(row.section) || 0) + 1);
  console.log("\nsections:");
  for (const [section, count] of [...bySection].sort((a, b) => b[1] - a[1])) console.log(`  ${section}: ${count}`);
  console.log(`\nworld sections the rule can key on: ${RESEARCH_WORLD_SECTIONS.join(", ")}`);
  console.log(`outside shapes: ${OUTSIDE_REFERENT_SHAPES.map((s) => s.name).join(", ")}`);
  console.log(`invented shapes: ${INVENTED_BY_SERIES_SHAPES.map((s) => s.name).join(", ")}`);
  console.log(`cap: RESEARCH_MAX_TERMS_PER_VOLUME = ${RESEARCH_MAX_TERMS_PER_VOLUME}`);

  const verdicts = rows.map((row) => ({ row, verdict: classifyResearchable(row) }));
  const picked = verdicts.filter((item) => item.verdict.researchable);
  const dropped = verdicts.filter((item) => !item.verdict.researchable);
  console.log(`\nselected ${picked.length} / ${rows.length}; skipped ${dropped.length}`);

  const pickedBySection = new Map();
  for (const { row } of picked) pickedBySection.set(row.section, (pickedBySection.get(row.section) || 0) + 1);
  console.log("selected by section:", [...pickedBySection].sort((a, b) => b[1] - a[1]));

  measureCandidates(rows);

  console.log("\n--- selected OUTSIDE a world section (the note-declaration half did the work) ---");
  for (const { row, verdict } of picked) {
    if (RESEARCH_WORLD_SECTIONS.includes(row.section)) continue;
    console.log(`  [${row.section}] ${row.term} {${verdict.outside.join(",")}} ${(row.notes || "").slice(0, 100)}`);
  }

  console.log("\n--- world-section rows the disqualifier dropped ---");
  for (const { row, verdict } of dropped) {
    if (!RESEARCH_WORLD_SECTIONS.includes(row.section)) continue;
    console.log(`  [${row.section}] ${row.term} {${verdict.invented.join(",")}} ${(row.notes || "").slice(0, 100)}`);
  }

  // Per volume: the rows each volume ADDED, which is the set a volume's research pass would see.
  console.log("\n--- per volume: new rows, researchable new rows, and what the cap cuts ---");
  let previous = new Map();
  let totalNew = 0;
  let totalResearchable = 0;
  let totalAsked = 0;
  let worst = 0;
  for (let i = 1; i <= 17; i += 1) {
    const file = path.join(tagged, `volume-${String(i).padStart(2, "0")}.md`);
    if (!fs.existsSync(file)) {
      console.log(`  volume ${String(i).padStart(2)}: ${file} is not there`);
      continue;
    }
    const volumeRows = parseGlossaryMarkdown(fs.readFileSync(file, "utf8")).rows;
    const current = new Map(volumeRows.map((row) => [termKey(row.term), row]));
    const added = [...current.values()].filter((row) => !previous.has(termKey(row.term)));
    const verdictsForVolume = added.map((row) => ({ row, verdict: classifyResearchable(row) }));
    const researchable = verdictsForVolume.filter((item) => item.verdict.researchable);
    const asked = researchable.slice(0, RESEARCH_MAX_TERMS_PER_VOLUME);
    const cut = researchable.slice(RESEARCH_MAX_TERMS_PER_VOLUME);
    totalNew += added.length;
    totalResearchable += researchable.length;
    totalAsked += asked.length;
    worst = Math.max(worst, researchable.length);
    console.log(
      `  volume ${String(i).padStart(2)}: file ${current.size} row(s), new ${added.length}, ` +
        `researchable ${researchable.length}, asked ${asked.length}` +
        (cut.length ? `, CUT ${cut.length} (${cut.map((item) => item.row.term).join(", ")})` : "")
    );
    previous = current;
  }
  console.log(
    `\nTOTAL new rows ${totalNew}; researchable ${totalResearchable}; asked under the cap ${totalAsked}; ` +
      `worst volume ${worst}`
  );
  console.log(
    `Against the 494 research conversations the last live 17-volume run paid for, the bound spends ` +
      `${totalAsked} research turns — and each one is a single tool-less one-shot, not a 15-step agent turn.`
  );
}

main();

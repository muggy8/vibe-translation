#!/usr/bin/env node
/**
 * test/test-voice-confirmations.js — plan 06 slice 7: a volume that saw a claim again records that it saw
 * it, and the record stops assuming "still holds".
 *
 * The acceptance line, verbatim from the plan's slice-7 row:
 *
 *   "A second pass over the same fixture reports confirmations rather than new claims, and pays 0 calls
 *    for chapters it already read."
 *
 * Both numbers are printed. "Rather than new claims" is measured as a pair of identical fixtures whose
 * reading pass answers the same observation two different ways — once as a `confirm` entry, once as a
 * `voice` claim — so the only difference between them is the shape of the answer.
 *
 * Scenarios:
 *
 *   1. **the acceptance line** — the whole route (read → file → render) over a two-volume fixture. Volume
 *      2's chapter answers name two things the record already stands behind and assert nothing new: it
 *      files **0 new claims** and **2 confirmations**. A second pass pays **0 model calls** (every chapter
 *      already read for the same text), files **0 new claims** and **0 new confirmations**. The same
 *      fixture answered as claims instead files 2 new claims and 0 confirmations.
 *   2. **a confirmation is not a bullet** — the bullet counts are identical with and without confirmations,
 *      the confirmation is one non-bullet line **before** the first bullet, and the file parses back to the
 *      same claims with no bullet body carrying the line. The counterfactual (the same line below the
 *      bullets) is measured too, because the render writes a file the store reads back (gotcha 157). Plus
 *      both caps, each named.
 *   3. **it does not reach a chapter** — the known-facts block a reading pass is shown, and the axis
 *      queries, are identical with and without confirmations.
 *   4. **the coverage answer is identical** — the audit's findings, message for message, and every other
 *      table's row count are identical with and without confirmations.
 *   5. **the confirmed claim row is untouched** — every column of every claim, including `status`,
 *      `updated_at`, `applies_to_volume` and `row_version`, is identical before and after. This is stricter
 *      than the revision door's proof: `markSuperseded` moves `status` and `updated_at`; this door moves
 *      nothing, because it attributes nothing to the claim.
 *   6. **idempotence** — the same claim named by two chapters of one volume is one row, and re-running the
 *      whole rebuild files nothing.
 *   7. **the guards** — nine shapes, each proven to store nothing: a volume confirming its own new claim, a
 *      character this volume's text does not contain, a quoted line this volume does not print, two claims
 *      the entry could mean with nothing separating them, a character the record holds no claim about, an
 *      entry naming no character, a non-entry, the extraction handle, and a handle opened on another volume.
 *   8. **an empty answer is a real answer** — a volume whose reading pass reported nothing files 0 claims
 *      and 0 confirmations, and nothing anywhere is marked confirmed.
 *   9. **a series that declares no register questions** — the same route, the same numbers, with no
 *      `register` block in its plan of record. This is the state every real volume in this corpus is in
 *      today (plan 06 §10.10), and it is why the row is keyed on the claim and not on the axis.
 *  10. **a record written by an older build** — a volume-2 record left at schema 10 opens, is topped up,
 *      and keeps every row it carried. Measured before this slice's fix, the same state returned
 *      `HIGH / reference-top-up-failed` and `openVolumeRecord` refused the volume outright.
 *  11. **what this slice did not add** — no finding kind, no setting, no environment knob, no manual
 *      command, no handle verb, no identity table read, no model call, and no write into `facts`.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model: the harness is a counting stub (AGENTS.md
 * rule 8, gotcha 69, gotcha 124).
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

// Read before anything is required: the part-packing target is a load-time constant, and a fixture whose
// chapter is smaller than it never gets a chapter-by-chapter path at all.
process.env.SOURCE_TEXT_PART_TARGET_CHARS = "1000";
delete process.env.SOURCE_CHUNK_THRESHOLD_CHARS;

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const harness = require("../harness");
const { assertInsideFixture } = require("./fixture-reference-store");
const rs = require("../utils/reference-store");
const { openDatabase } = require("../utils/reference-store/db");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { MANIFEST_SCHEMA } = require("../intake/config");
const { readModuleLayer } = require("./module-layer");

const {
  SCHEMA_VERSION,
  MIGRATIONS,
  COUNTED_TABLES,
  readSchemaVersion,
  openReferenceStore,
  openVolumeRecord,
  copyForwardStore,
  topUpVolumeRecord,
  importVolumeExtraction,
  rebuildVoiceFromExtraction,
  rebuildVoiceVolume,
  renderRebuiltVoice,
  auditVolumeRecord,
  parseVoiceMarkdown,
  fileVoiceConfirmation,
  fileVoiceConfirmations,
  confirmationCounts,
  claimsAnsweringAxis,
  CONFIRMATION_ENTRY_TYPE,
  MAX_REBUILD_CONFIRMATION_LINES_PER_CHARACTER,
  MAX_REBUILD_CONFIRMATION_BODY_CHARS,
  MAX_REBUILD_BULLET_CHARS,
  REGISTER_MANIFEST_KEY,
} = rs;

const ROOT = process.cwd();
const FIXTURES_ROOT = "/tmp/opencode/series-fixtures";

let checks = 0;
/** Count one assertion and run it. @param {boolean|void} condition @param {string} message */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}
/** @param {any} a @param {any} b @param {string} message */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

// ─── The fixture ──────────────────────────────────────────────────────────────

/**
 * Volume 1 and volume 2 print the **same** two lines for the same two characters.
 *
 * That is the point of the fixture: a confirmation is only worth filing when a later book really does bear
 * out what an earlier one established, so the later book has to contain the lines. The one thing volume 2
 * adds is a room, which is what makes the *claims* different and the *traits* the same.
 */
const BOOK_01 = {
  ch0: [
    "# Capítulo 1",
    "Marina entró en el aula sin golpear.",
    "Usted está equivocado, señor director —Marina no bajó la voz.",
    "Renata cerró la puerta sin decir nada.",
  ],
};
const BOOK_02 = {
  ch0: [
    "# Capítulo 2",
    "Marina entró en la oficina sin golpear.",
    "Usted está equivocado, señor director —Marina no bajó la voz.",
    "Renata cerró la puerta sin decir nada.",
  ],
};

/** What volume 1's reading pass files. */
const ENTRIES_01 = [
  {
    type: "voice",
    character: "Marina",
    quirkType: "formality",
    description: "Answers a superior with the formal second person and never softens it.",
    examples: ["Usted está equivocado, señor director"],
  },
  {
    type: "voice",
    character: "Renata",
    quirkType: "sentenceEnding",
    description: "Closes the door and says nothing at all.",
    examples: ["Renata cerró la puerta sin decir nada."],
  },
];

/** Volume 2's answer, told two ways. The observation is identical; only its shape differs. */
const ANSWER_AS_CONFIRMATIONS = [
  {
    type: CONFIRMATION_ENTRY_TYPE,
    character: "Marina",
    quirkType: "formality",
    examples: ["Usted está equivocado, señor director"],
    notes: "the same formal second person, in the same breath, in this chapter too",
  },
  {
    type: CONFIRMATION_ENTRY_TYPE,
    character: "Renata",
    quirkType: "sentenceEnding",
    examples: ["Renata cerró la puerta sin decir nada."],
    notes: "still silent, still closing the door",
  },
];
const ANSWER_AS_CLAIMS = [
  {
    type: "voice",
    character: "Marina",
    quirkType: "formality",
    description: "Uses the formal second person with the man in the office as well.",
    examples: ["Usted está equivocado, señor director"],
  },
  {
    type: "voice",
    character: "Renata",
    quirkType: "sentenceEnding",
    description: "Says nothing in the office either.",
    examples: ["Renata cerró la puerta sin decir nada."],
  },
];

/** One register question, for the scenarios that want a declaration at all. */
const REGISTER = {
  axes: [
    {
      id: "treatment",
      asks: "How does this character address somebody they take to be above them?",
      values: ["formal", "informal"],
      scope: "character-addressee",
      evidence: ["capítulo 1: the formal second person, in front of the director"],
    },
  ],
  note: "One question: deference.",
};

/**
 * Two books and one plan of record.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @param {{register?: any, seriesName?: string}} opts - `register: undefined` means "this series wrote no
 *   register block", which is a different fact from "use the default one".
 * @returns {{dir: string, volumes: Array<{folder: string, base: string, installmentNumber: string, dir: string}>}}
 */
function laySeries(label, { register = REGISTER, seriesName = "Confirmation Proof" } = {}) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const books = [
    { installmentNumber: "01", folder: `${seriesName}(01)`, base: `${seriesName.toLowerCase().replace(/\s+/g, "_")}(1)`, lines: BOOK_01 },
    { installmentNumber: "02", folder: `${seriesName}(02)`, base: `${seriesName.toLowerCase().replace(/\s+/g, "_")}(2)`, lines: BOOK_02 },
  ];
  for (const volume of books) {
    const volumeDir = path.join(dir, volume.folder);
    fs.mkdirSync(volumeDir, { recursive: true });
    const segments = Object.entries(volume.lines).map(([id, lines]) => {
      const file = `${volume.base}-${id}.md`;
      fs.writeFileSync(path.join(volumeDir, file), lines.join("\n") + "\n", "utf8");
      return { id, file, title: lines[0].replace(/^#\s+/, ""), chars: lines.join("\n").length };
    });
    fs.writeFileSync(
      path.join(volumeDir, `${volume.base}-bundle.meta.json`),
      JSON.stringify({ format: "epub", schema: 8, base: volume.base, wholeFile: `${volume.base}-whole.md`, segments }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(path.join(volumeDir, `${volume.base}-whole.md`), Object.values(volume.lines).flat().join("\n") + "\n", "utf8");
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    seriesLocation: dir,
    seriesName,
    sourceLanguage: "Spanish",
    targetLanguage: "English",
    generator: "test/test-voice-confirmations.js",
    generatedAt: new Date().toISOString(),
    discovery: {
      summary: "fixture: two books, continuous prose, one headed chapter each",
      confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
      evidence: ["fixture"],
      excluded: [],
    },
    volumes: books.map((volume) => ({
      folder: volume.folder,
      sourceFile: `${volume.folder}/${volume.base}.epub`,
      installmentNumber: volume.installmentNumber,
      title: seriesName,
      integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose in one headed section" },
    })),
  };
  if (register !== undefined) manifest[REGISTER_MANIFEST_KEY] = register;
  fs.writeFileSync(path.join(dir, "translation-target.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return {
    dir,
    volumes: books.map((volume) => ({
      ...volume,
      dir: path.join(dir, volume.folder),
      // The chapters, in reading order, in the shape `readVolumeChapters` and
      // `registerChaptersFromSource` both take. The fixture wrote these files, so the fixture names them;
      // no door here has to open an archive to know what the volume's chapters are.
      segments: Object.entries(volume.lines).map(([id, lines]) => ({
        id,
        file: `${volume.base}-${id}.md`,
        title: lines[0].replace(/^#\s+/, ""),
        chars: lines.join("\n").length,
      })),
    })),
  };
}

/**
 * Open one handle on a fixture volume's record, and refuse to go anywhere else.
 *
 * @param {{dir: string}} series @param {number} volume @param {string} folder @param {string} stage
 * @returns {Object}
 */
function openFixtureStore(series, volume, folder, stage) {
  const store = openReferenceStore({ volume, folder, seriesDir: series.dir, stage });
  assertInsideFixture(store.file, series.dir);
  return store;
}

/**
 * Volume 1 read, filed and sealed; volume 2's record carried from it and its chapters registered.
 *
 * @param {string} label @param {{register?: any}} [opts]
 * @returns {{series: Object, v2: Object}}
 */
function buildVolumeOne(label, { register = REGISTER } = {}) {
  const series = laySeries(label, { register });
  const [first, second] = series.volumes;

  const candidateStore = openFixtureStore(series, 1, first.folder, "extract");
  const v1 = openFixtureStore(series, 1, first.folder, "rebuild");
  v1.registerChaptersFromSource();
  const filed = rebuildVoiceFromExtraction(v1, ENTRIES_01, { volume: 1, candidateStore });
  assert.ok(filed.ok, `volume 1's claims were refused: ${JSON.stringify(filed.refused.map((r) => r.because))}`);
  same(filed.filedCount, 2, "volume 1 filed its two claims");
  same(filed.confirmations.confirmations, 0, "and its answer carried no confirmation, because nothing came before it");
  v1.sealVolume(1);
  candidateStore.close();
  v1.close();

  const copy = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: series.dir, fromFolder: first.folder, toFolder: second.folder });
  assert.ok(copy.ok, `the record did not carry forward: ${JSON.stringify(copy.refusal)}`);
  copy.closeDest();

  const v2 = openFixtureStore(series, 2, second.folder, "rebuild");
  v2.registerChaptersFromSource();
  return { series, v2 };
}

// ─── Measurement helpers ──────────────────────────────────────────────────────

/**
 * Every column of one facts row, in a stable order.
 *
 * @param {Object} store @param {string} id
 * @returns {Object|null}
 */
function rowOf(store, id) {
  const row = store.db.prepare("SELECT * FROM facts WHERE id = ?").get(id);
  if (!row) return null;
  const columns = store.db.prepare("PRAGMA table_info(facts)").all().map((c) => c.name).sort();
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}

/**
 * Row counts of every table this record counts, confirmations included.
 *
 * @param {Object} store
 * @returns {Object<string, number>}
 */
function tableCounts(store) {
  /** @type {Object<string, number>} */
  const counts = {};
  for (const table of new Set([...COUNTED_TABLES, "claim_confirmations"])) {
    counts[table] = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  }
  return counts;
}

/**
 * The chapter files of one fixture volume, the way the store lists them.
 * @param {Object} series @param {number} volume
 * @returns {Array<{id: string, file: string}>}
 */
function chapterFiles(series, volume) {
  const book = series.volumes[volume - 1];
  const meta = JSON.parse(fs.readFileSync(path.join(book.dir, `${book.base}-bundle.meta.json`), "utf8"));
  return meta.segments.map((segment) => ({ id: segment.id, file: segment.file }));
}

/**
 * The hash the copy door stamps its provenance with, computed the same way for the test to compare.
 * @param {string} file
 * @returns {string}
 */
function fileSha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Run one volume's whole route through the door the stage and `rebuild-voice` both use.
 *
 * @param {Object} series @param {number} volume @param {Array<Object>} entries
 * @returns {Object} The `rebuildVoiceVolume` report.
 */
function rebuildVolume(series, volume, entries) {
  const book = series.volumes[volume - 1];
  const meta = JSON.parse(fs.readFileSync(path.join(book.dir, `${book.base}-bundle.meta.json`), "utf8"));
  return rebuildVoiceVolume({ volume, folder: book.folder, seriesDir: series.dir, entries, bundleSegments: meta.segments, apply: false });
}

/**
 * Replace the harness's one-shot with a counter that answers from a table.
 *
 * @param {Array<Object>} calls @param {() => Array<Object>} answerFor
 * @returns {void}
 */
function stubHarness(calls, answerFor) {
  harness.runOneShot = async ({ systemPrompt, messages, label, thinkingLevel }) => {
    calls.push({ label, messages, systemPrompt, thinkingLevel });
    return JSON.stringify({ entries: answerFor() });
  };
}

// ─── The scenarios ────────────────────────────────────────────────────────────

/**
 * Every scenario, in order. Async because scenario 1 runs the stage's own reading pass, and that pass is
 * the thing the acceptance line is about.
 *
 * @returns {Promise<void>}
 */
async function main() {

// ─── 1. the acceptance line ───────────────────────────────────────────────────

{
  const reading = require("../character-voice/reading");
  const { readVolumeChapters } = reading;

  /**
   * Read volume 2 chapter by chapter with a stubbed backend.
   *
   * @param {Object} series @param {Object} v2 @param {Array<Object>} answer
   * @returns {Promise<{calls: Array<Object>, entries: Array<Object>}>}
   */
  async function readVolumeTwo(series, v2, answer) {
    const calls = [];
    stubHarness(calls, () => answer);
    const book = series.volumes[1];
    const segments = chapterFiles(series, 2);
    const ctx = {
      refStore: v2,
      volumeDir: book.dir,
      // `runExtract` prints which chapter of how many it is asking about, and it reads that off the
      // volume's bundle. The fixture's own bundle metadata is the honest stand-in: it is the same list
      // of files the fixture wrote and the store lists.
      bundle: { segments: book.segments },
      values: { INSTALLMENT_NUMBER: "02" },
      extractPrompt: "fixture user prompt",
      extractSystemPrompt: "fixture system prompt",
    };
    const pass = await readVolumeChapters({ ctx, segments, volumeDir: book.dir, installmentNumber: 2, log: () => {} });
    assert.ok(pass.ok, `the reading pass was refused: ${JSON.stringify(pass.refusal)}`);
    return { calls, entries: reading.consolidateExtraction(pass.chapters) };
  }

  // (a) the observation, told as a confirmation.
  const a = buildVolumeOne("slice7-acceptance");
  const firstPass = await readVolumeTwo(a.series, a.v2, ANSWER_AS_CONFIRMATIONS);
  const paidFirst = firstPass.calls.length;
  ok(
    firstPass.entries.every((entry) => entry.chapter === "ch0"),
    "and the notebook now says which chapter each answer came from"
  );
  const built = rebuildVolume(a.series, 2, firstPass.entries);
  assert.ok(built.ok, `volume 2 was refused: ${JSON.stringify(built.refusal)}`);
  const report = built.rebuild;

  same(report.filedCount, 0, "volume 2 filed no new claim — it reported that two claims still hold");
  same(report.confirmations.filed.length, 2, "and both of those reports became confirmations");
  same(report.confirmations.refused.length, 0, "none of them was refused");
  same(
    report.confirmations.filed.map((row) => `${row.factId}@v${row.seenVolume}:${row.seenChapter}`).sort(),
    ["v01-ch0-002@v2:ch0", "v01-ch0-004@v2:ch0"],
    "each one names the claim it re-confirms, the volume that saw it, and the chapter that saw it"
  );

  // (b) the second pass: the same fixture, the same code, nothing re-read.
  const secondPass = await readVolumeTwo(a.series, a.v2, ANSWER_AS_CONFIRMATIONS);
  same(secondPass.calls.length, 0, `the second pass paid ${secondPass.calls.length} model call(s) for chapters it had already read (it must pay 0)`);
  const rebuilt = rebuildVolume(a.series, 2, secondPass.entries);
  ok(rebuilt.ok, "the second pass is not an error");
  same(rebuilt.rebuild.filedCount, 0, "it files no new claim");
  same(rebuilt.rebuild.confirmations.filed.length, 0, "and no new confirmation either — the observation is already filed");
  same(rebuilt.rebuild.confirmations.alreadyFiled.length, 2, "both are reported as already filed rather than re-filed");
  same(confirmationCounts(a.v2, { volume: 2 }), { total: 2, thisVolume: 2, claimsConfirmed: 2, volumes: { 2: 2 } }, "the record holds exactly two confirmations after two passes");

  // (c) the same observation told as claims — the "rather than new claims" half of the line.
  const b = buildVolumeOne("slice7-acceptance-claims");
  const asClaims = rebuildVolume(b.series, 2, ANSWER_AS_CLAIMS);
  ok(asClaims.ok, "the claims variant runs");
  same(asClaims.rebuild.filedCount, 2, "answered as claims, the same two observations file 2 new claim rows");
  same(asClaims.rebuild.confirmations.filed.length, 0, "and 0 confirmations");
  same(b.v2.db.prepare("SELECT COUNT(*) n FROM claim_confirmations").get().n, 0, "that record holds no confirmation at all");

  console.log(
    `  pass 1: ${paidFirst} model call(s), ${report.filedCount} new claim(s), ${report.confirmations.filed.length} confirmation(s); ` +
      `pass 2: ${secondPass.calls.length} model call(s), ${rebuilt.rebuild.filedCount} new claim(s), ${rebuilt.rebuild.confirmations.filed.length} new confirmation(s); ` +
      `the same answer told as claims: ${asClaims.rebuild.filedCount} new claim(s), 0 confirmation(s)`
  );
  a.v2.close();
  b.v2.close();
}

// ─── 2. a confirmation is not a bullet ────────────────────────────────────────

{
  const withConfirmations = buildVolumeOne("slice7-render-with");
  const without = buildVolumeOne("slice7-render-without");

  rebuildVolume(withConfirmations.series, 2, ANSWER_AS_CONFIRMATIONS);
  const plain = renderRebuiltVoice(without.v2, { volume: 2 });
  const confirmed = renderRebuiltVoice(withConfirmations.v2, { volume: 2 });

  same(
    plain.characters.map((c) => `${c.key}:${c.bullets}`),
    confirmed.characters.map((c) => `${c.key}:${c.bullets}`),
    "the bullet counts are identical with and without confirmations — a confirmation never becomes a bullet"
  );
  same(plain.sections, confirmed.sections, "and neither does it add a section");
  same(plain.characters.map((c) => `${c.arc}/${c.confirmed}/${c.confirmedOmitted}`), ["0/0/0", "0/0/0"], "the plain render carries no arc and no confirmation");
  same(confirmed.characters.map((c) => `${c.arc}/${c.confirmed}/${c.confirmedOmitted}`), ["0/1/0", "0/1/0"], "the confirmed render carries exactly one confirmation line per character");

  const lines = confirmed.markdown.split("\n");
  const confirmationLines = lines.filter((line) => line.startsWith("_Confirmed in volume"));
  same(confirmationLines.length, 2, "two confirmation lines, one per confirmed claim");
  ok(confirmationLines.every((line) => !line.startsWith("- ")), "and not one of them is a bullet");
  for (const line of confirmationLines) {
    const at = lines.indexOf(line);
    const underAHeading = lines.slice(0, at).some((earlier) => earlier.startsWith("### "));
    ok(underAHeading, `the line sits under a heading: ${line}`);
    const after = lines.slice(at + 1);
    const firstBullet = after.findIndex((entry) => entry.startsWith("- "));
    const nextHeading = after.findIndex((entry) => entry.startsWith("### "));
    ok(firstBullet >= 0 && (nextHeading === -1 || firstBullet < nextHeading), `the section's bullets come after its confirmation line: ${line}`);
  }

  // The file is one the store reads back, so round-trip it.
  const parsedPlain = parseVoiceMarkdown(plain.markdown);
  const parsedConfirmed = parseVoiceMarkdown(confirmed.markdown);
  same(
    parsedConfirmed.characters.map((c) => ({ key: c.key, entries: c.entries })),
    parsedPlain.characters.map((c) => ({ key: c.key, entries: c.entries })),
    "the confirmed file parses back to exactly the same claims as the plain one"
  );
  ok(
    !parsedConfirmed.characters.some((c) => c.entries.some((entry) => entry.body.includes("Confirmed in volume"))),
    "and no published claim's body carries the confirmation line"
  );
  same(parsedConfirmed.characters.map((c) => c.lead.length), [1, 1], "each section keeps its confirmation line as its own prose");

  // The counterfactual, written out rather than regexed: the same line placed **below** the bullets. It
  // parses as the same number of claims, and a bullet's body now carries the line, with nothing saying so.
  const counterfactual = [
    "## Characters",
    "",
    "### Marina",
    "",
    "- **Formality level**: Answers a superior with the formal second person and never softens it.",
    "_Confirmed in volume 2 — **Formality level**: \"Answers a superior with the formal second person and never softens it.\"._",
    "",
  ].join("\n");
  const parsedCounterfactual = parseVoiceMarkdown(counterfactual);
  same(parsedCounterfactual.characters.map((c) => c.entries.length), [1], "the counterfactual still parses as the same number of claims");
  ok(
    parsedCounterfactual.characters[0].entries[0].body.includes("Confirmed in volume"),
    "and that is the damage: the claim's body now carries the line, and nothing announces it (gotcha 157)"
  );

  // Cap 1: the per-character line cap, and the named remainder.
  const capped = buildVolumeOne("slice7-render-cap");
  const cappedStore = capped.v2;
  const longBody = "A very long claim about how this character reaches for words ".repeat(6).trim();
  const planted = cappedStore.insertFact({
    key: "Marina",
    aspect: "register",
    label: "Vocabulary register",
    body: longBody,
    examples: ["Marina entró en la oficina sin golpear."],
    evidence: [{ volume: 1, chapter: "ch0", line: 3, quote: "Usted está equivocado, señor director", kind: "quote", matched: "verbatim" }],
    establishedVolume: 1,
    appliesFromVolume: 1,
  });
  ok(planted.ok, `the long claim files: ${JSON.stringify(planted.refusal)}`);
  const longConfirmed = fileVoiceConfirmation(cappedStore, { type: CONFIRMATION_ENTRY_TYPE, character: "Marina", quirkType: "vocabulary", chapter: "ch0" }, {
    volume: 2,
    volumeDir: capped.series.volumes[1].dir,
    chapters: chapterFiles(capped.series, 2),
  });
  ok(longConfirmed.ok && longConfirmed.filed, "and a volume that contains the character confirms it even when the entry quotes nothing");
  same(longConfirmed.quote, null, "with no quote offered, which the row says out loud");
  ok(/the entry offered no line/.test(longConfirmed.filed.note), `the note names the weaker evidence: ${longConfirmed.filed.note}`);
  same(longConfirmed.how, "label:Vocabulary register", "resolved by the label the extraction named");

  const cappedRender = renderRebuiltVoice(cappedStore, { volume: 2 });
  const longLine = cappedRender.markdown.split("\n").find((line) => line.startsWith("_Confirmed in volume 2 — **Vocabulary register**"));
  ok(longLine, "the long claim gets a confirmation line");
  ok(longLine.length < MAX_REBUILD_BULLET_CHARS, `and the line is bounded (${longLine.length} < ${MAX_REBUILD_BULLET_CHARS})`);
  ok(longLine.includes("…"), "with the fragment marked as a fragment");
  ok(longLine.length < MAX_REBUILD_CONFIRMATION_BODY_CHARS + 80, `the body is quoted as a fragment of at most ${MAX_REBUILD_CONFIRMATION_BODY_CHARS} characters, not reprinted (plan 06 §5)`);

  // Cap 2: the same claim named by nine entries is one row, because the cap is on observations, not attempts.
  const many = [];
  for (let i = 0; i < MAX_REBUILD_CONFIRMATION_LINES_PER_CHARACTER + 3; i++) many.push({ type: CONFIRMATION_ENTRY_TYPE, character: "Renata", quirkType: "sentenceEnding", chapter: "ch0" });
  const filedMany = fileVoiceConfirmations(cappedStore, many, { volume: 2, volumeDir: capped.series.volumes[1].dir, chapters: chapterFiles(capped.series, 2) });
  same(filedMany.filed.length, 1, "nine entries naming one claim file one row");
  same(filedMany.alreadyFiled.length, many.length - 1, "and the other eight are reported as already filed");
  same(confirmationCounts(cappedStore, { volume: 2 }).thisVolume, 2, "this fixture's record holds two confirmations: Marina's long one and Renata's one");

  withConfirmations.v2.close();
  without.v2.close();
  capped.v2.close();
}

// ─── 3. it does not reach a chapter, and it does not reach the axis queries ───

{
  const withConfirmations = buildVolumeOne("slice7-block-with");
  const without = buildVolumeOne("slice7-block-without");
  // Both sides run the same route, so the only difference between them is the rows the door filed.
  // "Without" is the same record with those rows taken back out — not a fixture that skipped the route,
  // which would differ in more than the thing being measured.
  rebuildVolume(withConfirmations.series, 2, ANSWER_AS_CONFIRMATIONS);
  rebuildVolume(without.series, 2, ANSWER_AS_CONFIRMATIONS);
  const removed = without.v2.db.prepare("DELETE FROM claim_confirmations").run();
  same(Number(removed.changes), 2, "the without side is the same record with its two confirmation rows taken back out");

  const { knownFactsForChapter } = require("../character-voice/known-facts");
  const segment = chapterFiles(withConfirmations.series, 2)[0];

  /**
   * The block one chapter is shown, out of a given record.
   * @param {{series: Object, v2: Object}} fixture
   */
  const blockFor = (fixture) => {
    const ctx = { refStore: fixture.v2, volumeDir: fixture.series.volumes[1].dir, values: { INSTALLMENT_NUMBER: 2 } };
    const built = knownFactsForChapter(ctx, segment);
    assert.ok(built.ok, `the block was refused: ${JSON.stringify(built.refusal)}`);
    return { block: built.block, claimsShown: built.claimsShown, namedCount: built.namedCount };
  };
  same(blockFor(withConfirmations), blockFor(without), "the known-facts block a chapter is shown is identical with and without confirmations");

  const axisWith = claimsAnsweringAxis(withConfirmations.v2, { axis: "treatment", volume: 2 });
  const axisWithout = claimsAnsweringAxis(without.v2, { axis: "treatment", volume: 2 });
  same(axisWith.rows.map((row) => row.id), axisWithout.rows.map((row) => row.id), `and the axis query answers the same claims (${axisWith.claimCount} claim(s) either way)`);
  same(
    withConfirmations.v2.db.prepare("SELECT id, key, label, body FROM facts ORDER BY id").all(),
    without.v2.db.prepare("SELECT id, key, label, body FROM facts ORDER BY id").all(),
    "while the two records hold exactly the same claims"
  );

  withConfirmations.v2.close();
  without.v2.close();
}

// ─── 4. the coverage answer is identical ──────────────────────────────────────

{
  const withConfirmations = buildVolumeOne("slice7-audit-with");
  const without = buildVolumeOne("slice7-audit-without");
  rebuildVolume(withConfirmations.series, 2, ANSWER_AS_CONFIRMATIONS);
  rebuildVolume(without.series, 2, ANSWER_AS_CONFIRMATIONS);
  without.v2.db.prepare("DELETE FROM claim_confirmations").run();

  /**
   * The deterministic audit of one fixture's volume 2.
   * @param {{series: Object, v2: Object}} fixture
   */
  const auditOf = (fixture) => {
    const rendered = renderRebuiltVoice(fixture.v2, { volume: 2 });
    const audit = auditVolumeRecord(fixture.v2, {
      title: "Character-voice reference (rebuilt from extraction)",
      file: "character-voice.md",
      markdown: rendered.markdown,
      refused: [],
    });
    // The rebuilt-from-extraction note carries the moment the rebuild happened, and two fixtures are built
    // a few milliseconds apart. The finding is the same finding; the clock is not the comparison.
    const findings = audit.findings.map((f) => `${f.severity}/${f.kind}/${f.message.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<at>")}`);
    return { findings, counts: tableCounts(fixture.v2) };
  };
  const a = auditOf(withConfirmations);
  const b = auditOf(without);
  same(a.findings, b.findings, `the audit's findings are identical with and without confirmations (${a.findings.map((f) => f.split("/").slice(0, 2).join("/")).join(", ") || "none"})`);
  same(
    Object.fromEntries(Object.entries(a.counts).filter(([table]) => table !== "claim_confirmations")),
    Object.fromEntries(Object.entries(b.counts).filter(([table]) => table !== "claim_confirmations")),
    "and every other table holds the same number of rows"
  );
  ok(a.counts.claim_confirmations === 2 && b.counts.claim_confirmations === 0, "the only table that differs is the confirmations table");

  withConfirmations.v2.close();
  without.v2.close();
}

// ─── 5. the confirmed claim row is untouched ──────────────────────────────────

{
  const fixture = buildVolumeOne("slice7-row-untouched");
  const ids = fixture.v2.db.prepare("SELECT id FROM facts ORDER BY id").all().map((row) => row.id);
  const rowsBefore = Object.fromEntries(ids.map((id) => [id, rowOf(fixture.v2, id)]));

  const result = rebuildVolume(fixture.series, 2, ANSWER_AS_CONFIRMATIONS);
  same(result.rebuild.confirmations.filed.length, 2, "two confirmations filed");

  const rowsAfter = Object.fromEntries(ids.map((id) => [id, rowOf(fixture.v2, id)]));
  same(rowsAfter, rowsBefore, "every column of every claim row is identical — a confirmation writes nothing into facts");
  for (const id of ids) {
    same(rowsAfter[id].row_version, rowsBefore[id].row_version, `row_version did not move on ${id}`);
    same(rowsAfter[id].status, rowsBefore[id].status, `status did not move on ${id}`);
    same(rowsAfter[id].applies_to_volume, null, `applies_to_volume is still null on ${id} — a confirmation never writes a span onto a published row`);
    same(rowsAfter[id].updated_at, rowsBefore[id].updated_at, `updated_at did not move on ${id} (the revision door moves it; this door does not)`);
  }
  same(fixture.v2.db.prepare("SELECT COUNT(*) n FROM facts").get().n, ids.length, "and no claim row was added either");

  fixture.v2.close();
}

// ─── 6. idempotence ───────────────────────────────────────────────────────────

{
  const fixture = buildVolumeOne("slice7-idempotence");
  const opts = { volume: 2, volumeDir: fixture.series.volumes[1].dir, chapters: chapterFiles(fixture.series, 2) };

  const first = fileVoiceConfirmation(fixture.v2, { type: CONFIRMATION_ENTRY_TYPE, character: "Marina", quirkType: "formality", chapter: "ch0" }, opts);
  ok(first.ok && first.filed, "the first confirmation files");
  const second = fileVoiceConfirmation(fixture.v2, { type: CONFIRMATION_ENTRY_TYPE, character: "Marina", quirkType: "formality", chapter: "ch1" }, opts);
  ok(second.ok && !second.filed && second.already, "the same claim named by a second chapter of the same volume is already filed");
  same(second.already.seen_chapter, "ch0", "and the row keeps the first chapter that reported it");
  same(fixture.v2.db.prepare("SELECT COUNT(*) n FROM claim_confirmations").get().n, 1, "one row, not two");

  // Nine more entries naming the same claim, so the key is a measured fact rather than a two-entry sample.
  let filedAgain = 0;
  let alreadyAgain = 0;
  for (let n = 0; n < 9; n++) {
    const again = fileVoiceConfirmation(fixture.v2, { type: CONFIRMATION_ENTRY_TYPE, character: "Marina", quirkType: "formality", chapter: `ch${n}` }, opts);
    if (again.filed) filedAgain++;
    else if (again.already) alreadyAgain++;
  }
  same(filedAgain, 0, "9 further entries naming the same claim file no new row");
  same(alreadyAgain, 9, "and every one of them is reported as already filed, not refused");
  same(fixture.v2.db.prepare("SELECT COUNT(*) n FROM claim_confirmations").get().n, 1, "the record still holds one confirmation for that (claim, volume)");

  const whole = rebuildVolume(fixture.series, 2, ANSWER_AS_CONFIRMATIONS);
  same(whole.rebuild.confirmations.filed.length, 1, "the whole rebuild then files only the other claim");
  same(whole.rebuild.confirmations.alreadyFiled.length, 1, "and reports Marina's as already filed");
  const countsBeforeThirdRun = tableCounts(fixture.v2);
  const again = rebuildVolume(fixture.series, 2, ANSWER_AS_CONFIRMATIONS);
  same(again.rebuild.confirmations.filed.length, 0, "a third run files nothing");
  same(tableCounts(fixture.v2), countsBeforeThirdRun, "and the record's counts are unmoved by it");
  same(again.rendered.markdown, renderRebuiltVoice(fixture.v2, { volume: 2 }).markdown, "and the rendered file is byte-identical");

  fixture.v2.close();
}

// ─── 7. the guards ────────────────────────────────────────────────────────────

{
  const fixture = buildVolumeOne("slice7-guards");
  const store = fixture.v2;
  const opts = { volume: 2, volumeDir: fixture.series.volumes[1].dir, chapters: chapterFiles(fixture.series, 2) };
  // The self-volume guard is about a volume confirming the claim it just established, so it has to be
  // asked on that volume's own handle — asking volume 1 on volume 2's handle hits a different guard first.
  const firstVolumeStore = openFixtureStore(fixture.series, 1, fixture.series.volumes[0].folder, "rebuild");
  const firstVolumeOpts = { volume: 1, volumeDir: fixture.series.volumes[0].dir, chapters: chapterFiles(fixture.series, 1) };

  const countsBefore = tableCounts(store);
  const rowsBefore = store.db.prepare("SELECT * FROM facts ORDER BY id").all();

  /** @type {Array<{name: string, store: Object, entry: Object|null, opts: Object, rule: string}>} */
  const refusals = [
    {
      name: "a volume cannot confirm its own new claim",
      store: firstVolumeStore,
      entry: { type: CONFIRMATION_ENTRY_TYPE, character: "Marina", quirkType: "formality" },
      opts: firstVolumeOpts,
      rule: "voice-confirmation-cannot-confirm-its-own-volume",
    },
    {
      name: "the character has to be in this volume's own text",
      store,
      entry: { type: CONFIRMATION_ENTRY_TYPE, character: "Marina", quirkType: "formality" },
      opts: { volume: 2, volumeDir: opts.volumeDir, chapters: [{ id: "ghost", file: "does-not-exist.md" }] },
      rule: "voice-confirmation-character-not-in-this-volume",
    },
    {
      name: "a quoted line has to be a line this volume prints",
      store,
      entry: { type: CONFIRMATION_ENTRY_TYPE, character: "Marina", quirkType: "formality", examples: ["a line this book never prints"] },
      opts,
      rule: "voice-confirmation-quote-not-in-this-volume",
    },
    { name: "a character the record holds no claim about", store, entry: { type: CONFIRMATION_ENTRY_TYPE, character: "Nobody", quirkType: "formality" }, opts, rule: "voice-confirmation-has-no-claim-to-confirm" },
    {
      name: "a character the record has no roster entry for at all",
      store,
      entry: { type: CONFIRMATION_ENTRY_TYPE, character: "俺", quirkType: "formality" },
      opts,
      rule: "voice-confirmation-names-nobody-in-this-record",
    },
    { name: "an entry naming no character", store, entry: { type: CONFIRMATION_ENTRY_TYPE, quirkType: "formality" }, opts, rule: "voice-confirmation-names-nobody" },
    { name: "an entry that is not an entry", store, entry: null, opts, rule: "voice-confirmation-names-nobody" },
  ];

  for (const plant of refusals) {
    const result = fileVoiceConfirmation(plant.store, plant.entry, plant.opts);
    ok(!result.ok && result.refusal, `${plant.name}: refused`);
    same(result.refusal.rule, plant.rule, `${plant.name}: rule ${result.refusal && result.refusal.rule}`);
    same(result.filed, null, `${plant.name}: nothing filed`);
  }

  same(tableCounts(store), countsBefore, "and those refusals stored nothing: the record's counts are exactly what they were");
  same(store.db.prepare("SELECT * FROM facts ORDER BY id").all(), rowsBefore, "including every claim row, column for column");
  same(store.db.prepare("SELECT COUNT(*) n FROM claim_confirmations").get().n, 0, "and no confirmation was filed by any of them");

  // The ambiguity refusal, planted after the others so it does not change their answers.
  const planted = store.insertFact({
    key: "Marina",
    aspect: "register",
    label: "Formality level",
    body: "A second live answer to the same question, linked to nothing.",
    examples: ["Usted está equivocado, señor director"],
    evidence: [{ volume: 1, chapter: "ch0", line: 3, quote: "Usted está equivocado, señor director", kind: "quote", matched: "verbatim" }],
    establishedVolume: 1,
    appliesFromVolume: 1,
  });
  ok(planted.ok, `the second live claim files: ${JSON.stringify(planted.refusal)}`);
  const countsAfterPlant = tableCounts(store);
  const rowsAfterPlant = store.db.prepare("SELECT * FROM facts ORDER BY id").all();
  const ambiguous = fileVoiceConfirmation(store, { type: CONFIRMATION_ENTRY_TYPE, character: "Marina", quirkType: "formality" }, opts);
  same(ambiguous.refusal.rule, "voice-confirmation-is-ambiguous", "two live claims the entry could mean is a refusal, not a pick by table order");
  ok(ambiguous.refusal.detail.candidates.length === 2, `and it names both candidates: ${JSON.stringify(ambiguous.refusal.detail.candidates)}`);

  // The handle guards, asked on their own handles.
  const extractHandle = openFixtureStore(fixture.series, 2, fixture.series.volumes[1].folder, "extract");
  const wrongStage = fileVoiceConfirmation(extractHandle, { type: CONFIRMATION_ENTRY_TYPE, character: "Marina", quirkType: "formality" }, opts);
  same(wrongStage.refusal.rule, "voice-confirmation-needs-a-record-handle", "the extraction handle is refused, because everything it files is invisible to the renderers");
  extractHandle.close();

  const otherVolume = openFixtureStore(fixture.series, 1, fixture.series.volumes[0].folder, "rebuild");
  const wrongVolume = fileVoiceConfirmation(otherVolume, { type: CONFIRMATION_ENTRY_TYPE, character: "Marina", quirkType: "formality" }, opts);
  same(wrongVolume.refusal.rule, "voice-confirmation-volume-is-not-the-handles", "and a handle cannot report what another volume read");
  otherVolume.close();

  same(tableCounts(store), countsAfterPlant, "and the ambiguity and handle refusals stored nothing either");
  same(store.db.prepare("SELECT * FROM facts ORDER BY id").all(), rowsAfterPlant, "including every claim row, column for column");
  same(store.db.prepare("SELECT COUNT(*) n FROM claim_confirmations").get().n, 0, "and no confirmation was filed by any of them");

  firstVolumeStore.close();
  store.close();
}

// ─── 8. an empty answer is a real answer ──────────────────────────────────────

{
  const fixture = buildVolumeOne("slice7-empty-answer");
  const built = rebuildVolume(fixture.series, 2, []);
  ok(built.ok, "a volume whose reading pass found nothing is not an error");
  same(built.rebuild.filedCount, 0, "it files no claim");
  same(built.rebuild.confirmations.filed.length, 0, "and it files no confirmation");
  same(built.rebuild.confirmations.alreadyFiled.length, 0, "and it reports nothing as confirmed");
  same(confirmationCounts(fixture.v2, { volume: 2 }), { total: 0, thisVolume: 0, claimsConfirmed: 0, volumes: {} }, "'nothing new' is not 'everything still holds'");
  same(
    fixture.v2.db.prepare("SELECT applies_to_volume FROM facts ORDER BY id").all().map((row) => row.applies_to_volume),
    [null, null, null, null],
    "and no carried claim gained an end-of-validity from an empty answer"
  );
  fixture.v2.close();
}

// ─── 9. a series that declares no register questions ──────────────────────────

{
  const fixture = buildVolumeOne("slice7-no-register", { register: undefined });
  const built = rebuildVolume(fixture.series, 2, ANSWER_AS_CONFIRMATIONS);
  ok(built.ok, "the route runs for a series with no register block");
  same(built.rebuild.confirmations.filed.length, 2, "and both confirmations file");
  same(
    built.rebuild.confirmations.filed.map((row) => row.note.match(/resolved by ([^;]+)/)[1]).sort(),
    ["label:Formality level", "label:Sentence endings"],
    "resolved by the label the extraction named, which needs no axis"
  );
  same(fixture.v2.db.prepare("SELECT COUNT(*) n FROM facts WHERE axis IS NOT NULL").get().n, 0, "in a record where 0 claims carry an axis — the shape every real volume in this corpus is in today");
  same(renderRebuiltVoice(fixture.v2, { volume: 2 }).markdown.split("\n").filter((line) => line.startsWith("_Confirmed in volume")).length, 2, "and the render prints them");
  fixture.v2.close();
}

// ─── 10. a record written by an older build ───────────────────────────────────

{
  const fixture = buildVolumeOne("slice7-prebump");
  const file = path.join(fixture.series.volumes[1].dir, "series.db");
  fixture.v2.close();

  // Volume 1 moves on after the copy was made — the state the top-up door exists for.
  const late = openFixtureStore(fixture.series, 1, fixture.series.volumes[0].folder, "rebuild");
  const added = late.insertFact({
    key: "Renata",
    aspect: "register",
    label: "Notes",
    body: "Also waits by the stairs.",
    examples: ["Renata cerró la puerta sin decir nada."],
    evidence: [{ volume: 1, chapter: "ch0", line: 4, quote: "Renata cerró la puerta sin decir nada.", kind: "quote", matched: "verbatim" }],
    establishedVolume: 1,
    appliesFromVolume: 1,
  });
  ok(added.ok, `volume 1 gains a claim: ${JSON.stringify(added.refusal)}`);
  late.close();

  // Volume 2's record, as an older build left it: no confirmations table, stamped 10.
  const down = openDatabase(file);
  down.exec("DROP TABLE IF EXISTS claim_confirmations;");
  down.prepare("UPDATE store_info SET value = '10' WHERE key = 'schema_version'").run();
  down.close();

  const probe = openDatabase(file, { readOnly: true });
  same(readSchemaVersion(probe), 10, "volume 2's record on disk is at schema 10");
  const carriedBefore = probe.prepare("SELECT id, key, body, owner_volume, established_volume, sealed FROM facts ORDER BY id").all();
  probe.close();

  const opened = openVolumeRecord({ volume: 2, folder: fixture.series.volumes[1].folder, seriesDir: fixture.series.dir, previousVolume: 1, previousFolder: fixture.series.volumes[0].folder, stage: "rebuild" });
  ok(opened.ok, `a pre-bump record opens with this build: ${opened.refusal && `${opened.refusal.rule} — ${opened.refusal.because}`}`);
  same(opened.findings.map((f) => `${f.severity}/${f.kind}`), [], "and the door reports no finding about it");
  ok(opened.toppedUp && opened.toppedUp.ok && !opened.toppedUp.skipped, `the top-up ran rather than skipping or failing (${JSON.stringify(opened.toppedUp && { ok: opened.toppedUp.ok, skipped: opened.toppedUp.skipped, reason: opened.toppedUp.reason, refusal: opened.toppedUp.refusal && opened.toppedUp.refusal.rule, total: opened.toppedUp.total })})`);
  same(opened.toppedUp.total, 1, "and it carried the one row volume 1 gained after the copy was made");

  const after = opened.store.db.prepare("SELECT id, key, body, owner_volume, established_volume, sealed FROM facts ORDER BY id").all();
  same(after.filter((row) => carriedBefore.some((old) => old.id === row.id)), carriedBefore, "every row the copy already carried is unchanged, column for column");
  same(readSchemaVersion(opened.store.db), SCHEMA_VERSION, "and the record was brought up to this build's schema");
  same(opened.store.db.prepare("SELECT COUNT(*) n FROM claim_confirmations").get().n, 0, "with the new table present and empty");
  const sourceShaAfterMigration = fileSha(path.join(fixture.series.dir, fixture.series.volumes[0].folder, "series.db"));
  opened.store.close();

  // Migrating the source changes its bytes, so the *first* top-up after a schema bump always runs. It has
  // to stamp the new hash, or every later pass over the same volume would copy the same rows again forever.
  const secondTopUp = topUpVolumeRecord({ fromVolume: 1, toVolume: 2, seriesDir: fixture.series.dir, fromFolder: fixture.series.volumes[0].folder, toFolder: fixture.series.volumes[1].folder });
  ok(secondTopUp.ok && secondTopUp.skipped, `the next top-up skips rather than copying the same rows again (${JSON.stringify({ ok: secondTopUp.ok, skipped: secondTopUp.skipped, reason: secondTopUp.reason, total: secondTopUp.total })})`);
  same(secondTopUp.total, 0, "and it moved no row");
  ok(fileSha(path.join(fixture.series.dir, fixture.series.volumes[0].folder, "series.db")) === sourceShaAfterMigration, "and the top-up did not change the source record a second time");

  // And the door still refuses a shape it genuinely cannot read, rather than half-copying it.
  const newer = openDatabase(file);
  newer.prepare("UPDATE store_info SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
  newer.close();
  const refused = topUpVolumeRecord({ fromVolume: 1, toVolume: 2, seriesDir: fixture.series.dir, fromFolder: fixture.series.volumes[0].folder, toFolder: fixture.series.volumes[1].folder });
  ok(!refused.ok, "a record written by a NEWER build is refused, not half-read");
  same(refused.refusal.rule, "reference-top-up-schema-mismatch", "by the guard that used to compare null with null");
  same(refused.findings.map((f) => `${f.severity}/${f.kind}`), ["HIGH/reference-top-up-schema-mismatch"], "and the finding is filed");
}

// ─── 11. what this slice did not add ──────────────────────────────────────────

{
  const kinds = Object.keys(FINDING_LEVELS);
  same(kinds.length, 70, "the finding level table is still 70 kinds — this slice added none");
  same(kinds.filter((kind) => /confirm/i.test(kind)), [], "and none of them is a confirmation kind");

  same(SCHEMA_VERSION, 11, "the store is at schema 11");
  const migration = MIGRATIONS.find((entry) => entry.version === 11);
  ok(migration && migration.up.join("\n").includes("claim_confirmations"), `the confirmation migration is appended, not folded into an older one: ${migration && `v${migration.version} — ${migration.name}`}`);
  ok(migration.up.join("\n").includes("CREATE TABLE IF NOT EXISTS claim_confirmations"), "it creates its own table");
  ok(!migration.up.some((statement) => /ALTER TABLE facts/.test(statement)), "and it adds no column to facts: a confirmation touches no claim");
  ok(COUNTED_TABLES.includes("claim_confirmations"), "the table is counted, so copy-forward compares it and a top-up carries it");

  // No new verb on the store's handle, and no new command.
  const handleLayer = readModuleLayer(ROOT, "utils/reference-store/open.js");
  ok(!/confirm/i.test(handleLayer), "the store's handle gained no confirmation verb — the door is a function, not a write scope");
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  same(Object.keys(packageJson.scripts).filter((name) => /confirm/i.test(name)), [], "and no new manual command");

  // No environment knob anywhere in the layer.
  for (const file of ["utils/reference-store/confirmations.js", "utils/reference-store/confirmations/shapes.js", "utils/reference-store/confirmations/rows.js", "utils/reference-store/confirmations/file.js"]) {
    const layer = readModuleLayer(ROOT, file);
    ok(!/process\.env/.test(layer), `${file} reads no environment variable`);
  }
  const labels = readModuleLayer(ROOT, "utils/reference-store/rebuild/labels.js");
  ok(/MAX_REBUILD_CONFIRMATION_LINES_PER_CHARACTER = 6/.test(labels), "the render's cap is a constant with no knob");
  ok(/MAX_REBUILD_CONFIRMATION_BODY_CHARS = 120/.test(labels), "and so is the fragment's length");
  same(MAX_REBUILD_CONFIRMATION_LINES_PER_CHARACTER, 6, "the cap the render uses");
  same(MAX_REBUILD_CONFIRMATION_BODY_CHARS, 120, "and the fragment bound");

  // The identity tables stay unwired (plan 06 §10.8).
  for (const file of ["utils/reference-store/confirmations/rows.js", "utils/reference-store/confirmations/file.js", "utils/reference-store/rebuild/render.js"]) {
    const layer = readModuleLayer(ROOT, file);
    ok(!/cast_identit/i.test(layer), `${file} names neither identity table`);
  }

  // Nothing asks the model a second question: the door is reached from the call that already ran.
  const filing = readModuleLayer(ROOT, "utils/reference-store/rebuild/filing.js");
  ok(/fileVoiceConfirmations\(store, entries/.test(filing), "the confirmations are filed by the same call that files the claims");
  const adapter = readModuleLayer(ROOT, "utils/reference-store/extraction-adapter.js");
  ok(adapter.includes("CONFIRMATION_ENTRY_TYPE"), "and the extraction door recognises the kind rather than filing it as a claim");
  for (const file of ["utils/reference-store/confirmations/file.js", "utils/reference-store/confirmations/rows.js", "utils/reference-store/confirmations/shapes.js", "utils/reference-store/rebuild/filing.js", "utils/reference-store/rebuild/render.js"]) {
    const layer = readModuleLayer(ROOT, file);
    ok(!/runOneShot|createAgentHandle/.test(layer), `${file} makes no model call`);
  }

  // A confirmation never becomes a claim, through either door.
  const fixture = buildVolumeOne("slice7-not-a-claim");
  const mixed = [...ENTRIES_01, ...ANSWER_AS_CONFIRMATIONS];
  const throughExtractionDoor = importVolumeExtraction({
    volume: 2,
    folder: fixture.series.volumes[1].folder,
    seriesDir: fixture.series.dir,
    voiceEntries: mixed,
  });
  ok(throughExtractionDoor.voice, "the extraction door ran");
  same(throughExtractionDoor.voice.confirmations.length, 2, "it named both confirmations");
  same(
    throughExtractionDoor.voice.imported.filter((fact) => fact.aspect === "unclassified" || /confirm/i.test(String(fact.label))),
    [],
    "and filed none of them as a claim"
  );
  same(fixture.v2.db.prepare("SELECT COUNT(*) n FROM claim_confirmations").get().n, 0, "and it filed no confirmation either — that is the rebuild door's act");
  fixture.v2.close();
}

console.log(`\nvoice confirmations: 11 scenarios, ${checks} checks, 0 model calls.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

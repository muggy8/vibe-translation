#!/usr/bin/env node
/**
 * test/test-settlement-agenda-coverage.js — the invariant plan 07 slice 7 exists for:
 * **an agenda that could not be asked must never look like an agenda that found nothing.**
 *
 * The terminology settlement's agenda has two halves. The structural half — a rendering a later volume
 * already replaced — is a fact about the record and needs no words from any language. The other half reads
 * a term's own note for a promise that the book has not finished making, and that half is unavoidably a
 * **vocabulary**: the 15 shipped shapes are phrases in one script (`vocabularyScripts()` returns exactly
 * one name), measured against notes written in that script.
 *
 * The prompt half of this slice asks the glossary read pass to write its notes **in the language the book
 * is written in**. The moment that happens, a Latin-script vocabulary run over those notes fires on
 * nothing — and "fires on nothing" is printed exactly like "this series has nothing to settle". That is
 * the failure §4.8 names, and it is the reason this suite is written against a **Cyrillic** fixture: a
 * blind spot proved only against a fixture in the one script the vocabulary covers proves nothing about
 * the blind spot.
 *
 * Scenarios:
 *
 *   1. **the shipped vocabulary covers one script, and the coverage states are four** — the number the
 *      coverage line is built on, and the four states it can report.
 *   2. **a Cyrillic record: the shipped shapes fire on nothing, and the agenda says `blind`** — the same
 *      record that reports 0 forward terms must say the question could not be asked, and must say that 0
 *      is NOT a finding.
 *   3. **a declared marker makes the same record askable** — the term arrives through the series' own
 *      declared phrase, is named as `declared:<phrase>`, and the shipped half stays named as blind.
 *   4. **a marker is matched as literal text and never compiled** — a regex-shaped marker matches nothing
 *      it is not literally spelled in.
 *   5. **all four coverage states, each reached over a real record** — `covered`, `partially-blind`,
 *      `blind`, `no-notes`.
 *   6. **the declaration is four answers, not one** — `absent` / `empty` / `declared` / `malformed`, and
 *      the reader never throws.
 *   7. **the intake refuses a malformed block and does not refuse a missing one** — the plan-06 register
 *      precedent, applied to the marker list.
 *   8. **the whole pass, end to end, on a blind fixture** — the coverage reaches the log, the JSON, and
 *      the console; a second pass pays 0 calls; a sealed row is never edited.
 *   9. **a published glossary carries the source-language note, and reads back the same note** — the
 *      render/parse round trip is script-neutral, so a note in the book's language is not a note the
 *      pipeline cannot re-import.
 *  10. **what this slice did not add** — no table, no schema bump, no finding kind, no level, no freeze
 *      door, no setting, no environment knob, no model call.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69).
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project. 0 model calls.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { FIXTURES_ROOT, assertInsideFixture } = require("./fixture-reference-store");
const { readModuleLayer } = require("./module-layer");
const rs = require("../utils/reference-store");
const settlement = require("../glossary/settlement");
const { validateManifest } = require("../intake/validate");
const { MANIFEST_SCHEMA } = require("../intake/config");
const { SCHEMA_VERSION, MIGRATIONS, COUNTED_TABLES } = require("../utils/reference-store/schema");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { frozenDoors } = require("../utils/prereqs/freeze");

const ROOT = path.resolve(__dirname, "..");

const {
  GLOSSARY_HEADER,
  openVolumeRecord,
  sealVolumeRecord,
  importGlossary,
  renderGlossary,
  parseGlossaryMarkdown,
  publishedGlossaryRowsInRecord,
} = rs;

const {
  FORWARD_REVEAL_SHAPES,
  FORWARD_RULE_STATES,
  SCRIPT_RANGES,
  SETTLEMENT_MANIFEST_KEY,
  MARKER_MIN_CHARS,
  MARKER_MAX_CHARS,
  MARKER_MAX_PER_SERIES,
  DECLARATION_STATES,
  NOTE_RULE_NOT_REPORTED,
  vocabularyScripts,
  dominantScriptOf,
  scriptCountsOf,
  scriptOfCharacter,
  firedForwardMarkers,
  firedForwardShapes,
  settlementAgenda,
  readSettlementDeclaration,
  settlementDeclarationProblems,
  validateSettlementDeclaration,
  planSettlementPass,
  executeSettlementPass,
  settlementRecordPaths,
  readSettlementDecisions,
} = settlement;

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

/**
 * sha256 of a file's bytes.
 * @param {string} file @returns {string}
 */
function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Capture everything one function prints, so "the pass said it out loud" is an assertion.
 *
 * @param {Function} fn - The call to run.
 * @returns {{logs: string[], warns: string[], errors: string[], result: *}} What it printed and returned.
 */
function captureConsole(fn) {
  const logs = [];
  const warns = [];
  const errors = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => warns.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  try {
    return { result: fn(), logs, warns, errors };
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
}

// ─── The fixture: a series written in a script the shipped vocabulary is not ───

/**
 * Volume 1's book. Every term the fixture glossary is allowed to claim is printed here.
 *
 * Cyrillic on purpose. The shipped forward-reveal vocabulary is written in one script, and a blind spot
 * can only be proved against a record written in another.
 */
const BOOK_01 = {
  ch0: [
    "# Глава 1",
    "Замок стоял на холме над рекой.",
    "Зеркало в замке было старое и тёмное.",
    "Знамя повешено над воротами замка.",
  ],
};
/** Volume 2's book: the same castle, one new word, and the line a settlement revision may quote. */
const BOOK_02 = {
  ch0: [
    "# Глава 2",
    "Замок на холме был заперт.",
    "Знамя над воротами оказалось чужим: это штандарт.",
  ],
};

/**
 * The Cyrillic phrase this series declares as meaning "more comes later".
 *
 * It is a phrase in the fixture's own language, supplied by the fixture's plan of record. No module in the
 * pipeline holds it: `agenda.js` holds the shipped shapes and nothing else, which is the whole design.
 */
const DECLARED_MARKER = "будет объяснена позже";

/**
 * The fixture glossary: three rows, every note written in the book's own language.
 *
 * `Знамя`'s note carries the fixture's declared marker. `Замок`'s note says something useful and points
 * nowhere. `Зеркало`'s note is the one a Latin reader would call a forward pointer — "появится позже"
 * means "appears later" — and no shipped shape can read it.
 */
function cyrillicGlossary() {
  return [
    "# Glossary — Coverage Proof",
    "",
    "_Canonical renderings for translating Coverage Proof. Current through volume 01._",
    "",
    "## Places",
    "",
    `| ${GLOSSARY_HEADER.join(" | ")} |`,
    "|---|---|---|",
    "| Замок | The Castle | Крепость на холме; весь пролог происходит в ней. |",
    "| Знамя | The Banner | Что это за знамя, будет объяснена позже, в другой главе. |",
    "",
    "## Items",
    "",
    `| ${GLOSSARY_HEADER.join(" | ")} |`,
    "|---|---|---|",
    "| Зеркало | The Mirror | Старое и тёмное зеркало в замке; его роль появится позже. |",
    "",
  ].join("\n");
}

/**
 * The same three rows with Latin notes, for the state the shipped vocabulary can actually answer.
 *
 * Deliberately the same three terms and the same shape, so the only difference between the two fixtures
 * is the script the notes are written in — which is the only thing the coverage line is about.
 */
function latinGlossary() {
  return [
    "# Glossary — Coverage Proof",
    "",
    "_Canonical renderings for translating Coverage Proof. Current through volume 01._",
    "",
    "## Places",
    "",
    `| ${GLOSSARY_HEADER.join(" | ")} |`,
    "|---|---|---|",
    "| Замок | The Castle | The fortress on the hill; the whole prologue happens in it. |",
    "| Знамя | The Banner | What this banner is will be explained later, in another chapter. |",
    "",
    "## Items",
    "",
    `| ${GLOSSARY_HEADER.join(" | ")} |`,
    "|---|---|---|",
    "| Зеркало | The Mirror | An old, dark mirror in the castle; its role appears later. |",
    "",
  ].join("\n");
}

/**
 * Lay a two-volume fixture series in Cyrillic, with a plan of record that may or may not carry a
 * `settlement` block.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @param {Object} [options]
 * @param {Object|null} [options.settlement] - The `settlement` block to write into the plan, or null to omit the key.
 * @param {string} [options.sourceLanguage] - What the plan says the book is written in.
 * @returns {{dir: string, volumes: Array<{folder: string, base: string, installmentNumber: string, dir: string}>}}
 */
function laySeries(label, { settlement: block = null, sourceLanguage = "Bulgarian" } = {}) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const books = [
    { installmentNumber: "01", folder: "Coverage Proof(01)", base: "coverage_proof(1)", lines: BOOK_01 },
    { installmentNumber: "02", folder: "Coverage Proof(02)", base: "coverage_proof(2)", lines: BOOK_02 },
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
    fs.writeFileSync(
      path.join(volumeDir, `${volume.base}-whole.md`),
      Object.values(volume.lines).flat().join("\n") + "\n",
      "utf8"
    );
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    seriesLocation: dir,
    seriesName: "Coverage Proof",
    sourceLanguage,
    targetLanguage: "English",
    generator: "test/test-settlement-agenda-coverage.js",
    generatedAt: new Date().toISOString(),
    discovery: { summary: "fixture", confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 }, evidence: ["fixture"], excluded: [] },
    volumes: books.map((volume) => ({
      folder: volume.folder,
      sourceFile: `${volume.folder}/${volume.base}.epub`,
      installmentNumber: volume.installmentNumber,
      title: "Coverage Proof",
      integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose in one headed section, no packaging pages" },
    })),
  };
  if (block !== null) manifest[SETTLEMENT_MANIFEST_KEY] = block;
  fs.writeFileSync(path.join(dir, "translation-target.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return { dir, volumes: books.map((volume) => ({ ...volume, dir: path.join(dir, volume.folder) })) };
}

/**
 * Open one fixture volume's record through the store's own front door, refusing to leave the fixture.
 *
 * @param {{dir: string, volumes: Array<{folder: string, installmentNumber: string}>}} series
 * @param {number} volume
 * @returns {Object} An open store handle.
 */
function openRecord(series, volume) {
  const entry = series.volumes[volume - 1];
  const previous = volume > 1 ? series.volumes[volume - 2] : null;
  const opened = openVolumeRecord({
    volume,
    folder: entry.folder,
    seriesDir: series.dir,
    previousVolume: previous ? Number(previous.installmentNumber) : null,
    previousFolder: previous ? previous.folder : null,
  });
  assert.ok(opened.ok, `volume ${volume}: ${opened.refusal ? `${opened.refusal.rule}: ${opened.refusal.because}` : "the record could not be opened"}`);
  assertInsideFixture(opened.store.file, series.dir);
  return opened.store;
}

/**
 * Build a two-volume fixture whose settled record holds the fixture glossary, sealed.
 *
 * @param {string} label
 * @param {Object} glossaryMarkdown - The volume 1 glossary to import.
 * @param {Object} [options] - Passed through to {@link laySeries}.
 * @returns {Promise<{series: Object, settled: Object, rows: Array<Object>}>} The settled (volume 2) record and its rows.
 */
async function buildSeries(label, glossaryMarkdown, options = {}) {
  const series = laySeries(label, options);
  const one = openRecord(series, 1);
  const imported = importGlossary(one, glossaryMarkdown);
  assert.ok(imported.refused.length === 0, `the fixture glossary was refused: ${JSON.stringify(imported.refused.map((r) => r.because))}`);
  sealVolumeRecord(one);
  one.close();

  const two = openRecord(series, 2);
  sealVolumeRecord(two);
  two.close();
  return { series };
}

/**
 * Read a fixture series' settled record and its agenda, without leaving the record open.
 *
 * @param {Object} series - A {@link laySeries} result.
 * @param {Array<{phrase: string, because?: string|null}>} [forwardMarkers]
 * @returns {Object} The {@link settlementAgenda} result.
 */
function agendaOf(series, forwardMarkers = []) {
  const opened = openRecord(series, 2);
  try {
    return settlementAgenda(opened, { forwardMarkers });
  } finally {
    opened.close();
  }
}

/**
 * Every `facts` row of a record, as the database holds it.
 *
 * @param {{db: Object}} store
 * @returns {Map<string, Object>} row id → its full column set.
 */
function factRows(store) {
  /** @type {Map<string, Object>} */
  const out = new Map();
  for (const row of store.db.prepare("SELECT * FROM facts").all()) out.set(String(row.id), { ...row });
  return out;
}

/**
 * The names of the columns that differ between two stored rows.
 *
 * @param {Object} before
 * @param {Object} after
 * @returns {string[]} Sorted column names, empty when the rows are identical.
 */
function movedColumns(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])).sort();
}

const scenarios = [];
/** Register one scenario. @param {string} name @param {Function} fn */
function scenario(name, fn) {
  scenarios.push({ name, fn });
}

// ─── 1. the vocabulary covers one script, and the states are four ─────────────

scenario("the shipped note vocabulary is written in one script, and the coverage has four states", () => {
  const scripts = vocabularyScripts();
  same(scripts.length, 1, `the shipped forward-reveal vocabulary is written in ${scripts.length} script(s); the coverage line exists because it is not written in more`);
  ok(FORWARD_REVEAL_SHAPES.length === 15, `the shipped list is ${FORWARD_REVEAL_SHAPES.length} shapes, not the measured 15`);
  for (const shape of FORWARD_REVEAL_SHAPES) {
    same(dominantScriptOf(shape.re.source), scripts[0], `the shipped shape "${shape.name}" is not written in the script the coverage reports`);
  }
  same(FORWARD_RULE_STATES, ["covered", "partially-blind", "blind", "no-notes"], "the coverage states moved");

  // The script table is script-neutral: it tells a Cyrillic note from a Latin one and from a Han one,
  // and it claims nothing about which language any of them belongs to.
  same(dominantScriptOf("Замок стоял на холме."), "Cyrillic", "a Cyrillic note is not read as Latin");
  same(dominantScriptOf("Замок stands on the hill."), "Latin", "a Latin note is not read as Cyrillic");
  same(dominantScriptOf("城壁都市国家"), "Han", "the check is not Cyrillic-specific either");
  same(dominantScriptOf("1234 — 56"), "none", "a notes cell with no letters has no script, and is counted as one");
  same(scriptOfCharacter(" "), null, "a space belongs to no script");
  ok(SCRIPT_RANGES.some((range) => range.name === "Cyrillic"), "the script table cannot tell the fixture's script from the vocabulary's");
});

// ─── 2. a Cyrillic record: 0 forward terms, and the reason is named ───────────

scenario("a Cyrillic record reports 0 forward terms AND says the question could not be asked", async () => {
  const { series } = await buildSeries("coverage-blind-cyrillic", cyrillicGlossary());
  const agenda = agendaOf(series);

  same(agenda.forwardCount, 0, "the shipped vocabulary found nothing in a record whose notes really do point forward");
  same(agenda.textRule.state, "blind", "an agenda that could not read these notes is reported as an empty one");
  same(agenda.textRule.askable, false, "a blind note half is reported as askable");
  same(agenda.textRule.notesRead, 3, "the agenda read every published note");
  same(agenda.textRule.notesOutsideVocabulary, 3, "and every one of them is outside the vocabulary's script");
  same(agenda.textRule.rowsFiredByShapes, 0, "no shipped shape fired, which is the blind spot, not a clean result");
  same(agenda.textRule.markerCount, 0, "no markers are declared for this fixture");
  same(agenda.textRule.outsideExamples.map((e) => e.script), ["Cyrillic", "Cyrillic", "Cyrillic"], "the notes it could not read are named with their script");

  // The sentence that carries the invariant.
  ok(/could not be asked/.test(agenda.textRule.because), `the coverage line does not say the note half could not be asked: ${agenda.textRule.because}`);
  ok(/NOT a finding that this series has nothing to settle/.test(agenda.textRule.because), `the coverage line does not refuse the "nothing to settle" reading: ${agenda.textRule.because}`);
  ok(/0 term\(s\) point forward/.test(agenda.textRule.because) === false, "a blind agenda is worded like a count");

  // The structural half is untouched by the blind spot: it needs no words from any language.
  same(agenda.chainCount, 0, "the chain half is 0 here because this fixture has no supersede chain, not because of the script");
  same(agenda.candidateCount, 0, "and the agenda is empty — which is exactly the shape the coverage line exists to qualify");
});

// ─── 3. the declared marker makes the same record askable ─────────────────────

scenario("a declared marker puts the same term on the agenda, and names itself as the reason", async () => {
  const { series } = await buildSeries("coverage-declared-cyrillic", cyrillicGlossary(), {
    settlement: { forwardMarkers: [{ phrase: DECLARED_MARKER, because: "the phrase this series' own notes use to promise a later explanation" }], note: null },
  });

  const declaration = readSettlementDeclaration(series.dir);
  same(declaration.state, "declared", "the plan of record declares a marker and the reader did not see it");
  same(declaration.markers.map((m) => m.phrase), [DECLARED_MARKER], "the declared marker did not survive the read");

  const agenda = agendaOf(series, declaration.markers);
  same(agenda.forwardCount, 1, "the declared marker did not put the term on the agenda");
  same(agenda.agenda.map((item) => item.term), ["Знамя"], "the wrong term arrived through the declared marker");
  same(agenda.agenda[0].markers, [DECLARED_MARKER], "the agenda item does not name the declared phrase that fired");
  same(agenda.agenda[0].shapes, [], "the shipped vocabulary fired on a Cyrillic note, which is the blind spot pretending to work");
  ok(agenda.agenda[0].because.includes(`declared:${DECLARED_MARKER}`), `the reason does not name the declared phrase: ${agenda.agenda[0].because}`);

  same(agenda.textRule.rowsFiredByMarkers, 1, "the coverage does not count the row a declared marker fired on");
  same(agenda.textRule.markerCount, 1, "the coverage does not report how many markers were in force");
  same(agenda.textRule.markersThatFiredOnNothing, [], "a marker that fired is reported as having fired");
  same(agenda.textRule.askable, true, "a declared marker makes the note half askable, and the coverage does not say so");
  same(agenda.textRule.state, "blind", "the shipped half is still blind, and the coverage does not say so either");
  ok(/declared marker\(s\) were matched as literal text over all 3 note\(s\)/.test(agenda.textRule.because),
    `the blind wording does not say the declared markers are what made it askable: ${agenda.textRule.because}`);

  // A marker set that matches nothing is a vocabulary gap, and it is named as one.
  const gap = agendaOf(series, [{ phrase: "появится на следующей странице" }]);
  same(gap.forwardCount, 0, "a marker that matches nothing put a term on the agenda");
  same(gap.textRule.markersThatFiredOnNothing, ["появится на следующей странице"], "a marker that fired on 0 notes is not named");
  ok(/fired on 0 rows/.test(gap.textRule.because), `the coverage does not say the declared vocabulary matched nothing: ${gap.textRule.because}`);
});

// ─── 4. a marker is text, never a pattern ─────────────────────────────────────

scenario("a declared marker is matched as literal text and never compiled", () => {
  const notes = "Что это за знамя, будет объяснена позже, в другой главе.";
  same(firedForwardMarkers(notes, [{ phrase: "объяснена" }]), ["объяснена"], "a literal marker that is present did not fire");
  // Matched case-insensitively, and reported with the spelling the series declared — the record names the
  // phrase a person wrote, not the spelling the note happened to use.
  same(firedForwardMarkers(notes, [{ phrase: "ОБЪЯСНЕНА" }]), ["ОБЪЯСНЕНА"], "a marker is not matched case-insensitively");
  same(firedForwardMarkers(notes, [{ phrase: ".*" }]), [], "a regex-shaped marker was compiled — a declaration a model wrote can execute");
  same(firedForwardMarkers(notes, [{ phrase: "будет+объяснена" }]), [], "a quantifier in a marker was treated as a pattern");
  same(firedForwardMarkers(notes, [{ phrase: "позже, в другой" }]), ["позже, в другой"], "a multi-word marker did not match across punctuation");
  same(firedForwardMarkers(notes, []), [], "an empty marker list fired something");
  same(firedForwardMarkers(notes, undefined), [], "an absent marker list fired something");
  same(firedForwardMarkers("", [{ phrase: "объяснена" }]), [], "an empty notes cell fired a marker");
  same(firedForwardMarkers(notes, [{ phrase: "объяснена" }, { phrase: "объяснена" }]), ["объяснена"], "a duplicated marker was counted twice");
  // The shipped half is a pattern list, and the two halves are not the same kind of thing.
  ok(firedForwardShapes(notes).length === 0, "a shipped shape fired on a note written in another script");
});

// ─── 5. all four states, each reached over a real record ──────────────────────

scenario("all four coverage states are reachable, each over a real record", async () => {
  const covered = await buildSeries("coverage-covered-latin", latinGlossary());
  const coveredAgenda = agendaOf(covered.series);
  same(coveredAgenda.textRule.state, "covered", "a Latin-note record is not reported as covered");
  same(coveredAgenda.textRule.askable, true, "a covered note half is not reported as askable");
  same(coveredAgenda.forwardCount, 1, "the shipped vocabulary did not read its own script");
  same(coveredAgenda.agenda.map((item) => item.term), ["Знамя"], "the wrong term arrived through the shipped shapes");
  same(coveredAgenda.agenda[0].markers, [], "a term found by the shipped shapes is also reported as declared-marker found");
  ok(/is an answer and not a blind spot/.test(coveredAgenda.textRule.because), `the covered wording does not claim the count is an answer: ${coveredAgenda.textRule.because}`);

  const blind = await buildSeries("coverage-blind-state", cyrillicGlossary());
  same(agendaOf(blind.series).textRule.state, "blind", "the all-Cyrillic record is not reported as blind");

  // partially-blind: the same record, one note rewritten in the vocabulary's own script.
  const mixed = [
    "# Glossary — Coverage Proof",
    "",
    "_Canonical renderings for translating Coverage Proof. Current through volume 01._",
    "",
    "## Places",
    "",
    `| ${GLOSSARY_HEADER.join(" | ")} |`,
    "|---|---|---|",
    "| Замок | The Castle | Крепость на холме; весь пролог происходит в ней. |",
    "| Знамя | The Banner | What this banner is will be explained later, in another chapter. |",
    "",
    "## Items",
    "",
    `| ${GLOSSARY_HEADER.join(" | ")} |`,
    "|---|---|---|",
    "| Зеркало | The Mirror | Старое и тёмное зеркало в замке; его роль появится позже. |",
    "",
  ].join("\n");
  const partial = await buildSeries("coverage-partial", mixed);
  const partialAgenda = agendaOf(partial.series);
  same(partialAgenda.textRule.state, "partially-blind", "a record half outside the vocabulary is not reported as partially-blind");
  same(partialAgenda.textRule.notesOutsideVocabulary, 2, "the count of notes outside the vocabulary moved");
  same(partialAgenda.forwardCount, 1, "the half the vocabulary can read did not produce its term");
  ok(/it read 1 and could not read 2/.test(partialAgenda.textRule.because), `the partial wording does not name both halves: ${partialAgenda.textRule.because}`);

  // no-notes: a settled record that publishes no rows at all. (An empty notes cell is not this state —
  // the document door stores the rendering as the body when the cell is blank, which is why this fixture
  // files nothing rather than filing three blanks.)
  const blank = laySeries("coverage-no-notes");
  for (const volume of [1, 2]) {
    const sealed = openRecord(blank, volume);
    sealVolumeRecord(sealed);
    sealed.close();
  }
  const emptyStore = openRecord(blank, 2);
  const noNotes = settlementAgenda(emptyStore);
  same(publishedGlossaryRowsInRecord(emptyStore, { volume: 2 }).length, 0, "the empty fixture published rows anyway");
  same(noNotes.textRule.state, "no-notes", "a record with no notes at all is reported as blind");
  same(noNotes.textRule.askable, true, "an empty record is reported as a vocabulary problem");
  same(noNotes.textRule.notesRead, 0, "the agenda read notes that are not there");
  ok(/publishes no notes at all/.test(noNotes.textRule.because), `the no-notes wording does not say it is a fact about the record: ${noNotes.textRule.because}`);
  ok(/not a vocabulary problem/.test(noNotes.textRule.because), "the no-notes wording blames the vocabulary");
  emptyStore.close();
});

// ─── 6. the declaration is four answers ───────────────────────────────────────

scenario("the declaration reads as four different facts, and the reader never throws", async () => {
  const absent = laySeries("coverage-declaration-absent");
  same(readSettlementDeclaration(absent.dir).state, "absent", "a plan with no settlement block is not reported as absent");

  const emptyBlock = laySeries("coverage-declaration-empty", {
    settlement: { forwardMarkers: [], note: "This series' notes are written in the language of the book, and the shipped vocabulary is not." },
  });
  const emptyRead = readSettlementDeclaration(emptyBlock.dir);
  same(emptyRead.state, "empty", "a declared-empty block is not reported as empty");
  same(emptyRead.markers, [], "an empty declaration produced markers");
  ok(emptyRead.note && emptyRead.note.includes("language of the book"), "the reason a series declares none was dropped");

  const declared = laySeries("coverage-declaration-declared", {
    settlement: { forwardMarkers: [{ phrase: DECLARED_MARKER, because: "the phrase this series uses" }], note: null },
  });
  const declaredRead = readSettlementDeclaration(declared.dir);
  same(declaredRead.state, "declared", "a declared block is not reported as declared");
  same(declaredRead.markers, [{ phrase: DECLARED_MARKER, because: "the phrase this series uses" }], "the declared marker or its reason did not survive the read");

  const malformed = laySeries("coverage-declaration-malformed", { settlement: { forwardMarkers: [{ phrase: "а" }] } });
  const malformedRead = readSettlementDeclaration(malformed.dir);
  same(malformedRead.state, "malformed", "a malformed block is not reported as malformed");
  same(malformedRead.markers, [], "a malformed block still handed the agenda its markers");
  ok(malformedRead.problems.length > 0 && /character/.test(malformedRead.problems[0]), `the malformed read names no problem: ${JSON.stringify(malformedRead.problems)}`);

  // A missing plan file and an unreadable one are both answers, and neither throws.
  const noPlan = path.join(FIXTURES_ROOT, "coverage-declaration-no-plan");
  fs.rmSync(noPlan, { recursive: true, force: true });
  fs.mkdirSync(noPlan, { recursive: true });
  same(readSettlementDeclaration(noPlan.dir || noPlan).state, "absent", "a series with no plan of record is not reported as absent");
  fs.writeFileSync(path.join(noPlan, "translation-target.json"), "{ not json", "utf8");
  same(readSettlementDeclaration(noPlan).state, "malformed", "an unreadable plan is not reported as malformed");

  same(DECLARATION_STATES, ["declared", "empty", "absent", "malformed"], "the declaration states moved");
});

// ─── 7. the intake refuses a malformed block, and nothing else ────────────────

scenario("the intake refuses a malformed marker list and does not refuse a missing one", () => {
  const base = () => JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, "coverage-declaration-declared", "translation-target.json"), "utf8"));

  ok(validateManifest(base()) === undefined || true, "a plan with no settlement block was refused");
  const noBlock = base();
  delete noBlock[SETTLEMENT_MANIFEST_KEY];
  validateManifest(noBlock);
  checks++;
  ok(noBlock[SETTLEMENT_MANIFEST_KEY] === undefined, "the intake invented a settlement block for a plan that declared none");

  validateManifest({ ...base(), [SETTLEMENT_MANIFEST_KEY]: { forwardMarkers: [], note: "declared none, on purpose" } });
  checks++;

  const refusals = [
    { settlement: { forwardMarkers: [{ phrase: "а" }] }, names: /character/ },
    { settlement: { forwardMarkers: [{ phrase: "x".repeat(MARKER_MAX_CHARS + 1) }] }, names: /character/ },
    { settlement: { forwardMarkers: [{ phrase: "объяснена" }, { phrase: "объяснена" }] }, names: /a marker set is a set/ },
    { settlement: { forwardMarkers: [{ phras: "объяснена" }] }, names: /does not have/ },
    { settlement: { forwardMarkers: "объяснена" }, names: /must be an array/ },
    { settlement: { markers: [{ phrase: "объяснена" }] }, names: /missing "forwardMarkers"/ },
    { settlement: { forwardMarkers: [] }, names: /no "note"/ },
    { settlement: { forwardMarkers: [{ phrase: "объяснена" }], note: "   " }, names: /"note" must be a non-empty string/ },
    { settlement: "объяснена позже", names: /it is an object with/ },
    { settlement: [{ phrase: "объяснена" }], names: /an array/ },
    { settlement: { forwardMarkers: Array.from({ length: MARKER_MAX_PER_SERIES + 1 }, (_, i) => ({ phrase: `объяснена позже ${i + 1}` })) }, names: /may declare/ },
  ];
  for (const plant of refusals) {
    let thrown = "";
    try {
      validateManifest({ ...base(), [SETTLEMENT_MANIFEST_KEY]: plant[SETTLEMENT_MANIFEST_KEY] });
    } catch (err) {
      thrown = String(err && err.message ? err.message : err);
    }
    ok(thrown !== "", `the intake accepted a malformed ${SETTLEMENT_MANIFEST_KEY} block: ${JSON.stringify(plant[SETTLEMENT_MANIFEST_KEY])}`);
    ok(plant.names.test(thrown), `the refusal does not name the problem (${plant.names}): ${thrown}`);
  }

  // The leaf's own guards, asked directly, agree with the door that refuses.
  same(settlementDeclarationProblems(undefined), [], "the leaf reports a problem for a block that is not there");
  same(settlementDeclarationProblems({ forwardMarkers: [], note: "reason" }), [], "the leaf reports a problem for a legal empty declaration");
  let leafThrew = "";
  try {
    validateSettlementDeclaration({ forwardMarkers: [{ phrase: "а" }] });
  } catch (err) {
    leafThrew = String(err && err.message ? err.message : err);
  }
  ok(/malformed/.test(leafThrew), "validateSettlementDeclaration did not refuse a one-character marker");
});

// ─── 8. the whole pass, end to end, on a blind fixture ────────────────────────

scenario("the pass reports the blind spot in its log, its JSON and its console, and a sealed row is never edited", async () => {
  const { series } = await buildSeries("coverage-pass-end-to-end", cyrillicGlossary(), {
    settlement: { forwardMarkers: [{ phrase: DECLARED_MARKER, because: "the phrase this series' notes use" }] },
  });
  const volumeRefs = series.volumes.map((v) => ({ folder: v.folder, installmentNumber: Number(v.installmentNumber) }));
  const values = { SOURCE_NAME: "Coverage Proof", SOURCE_LANGUAGE: "Bulgarian", TARGET_LANGUAGE: "English" };
  // The published per-volume files are not the settlement's to rewrite, and this is the one place that
  // says so with bytes rather than with a sentence.
  const publishedBefore = series.volumes.map((volume) => {
    const file = path.join(volume.dir, "glossary.md");
    return { file, exists: fs.existsSync(file), digest: fs.existsSync(file) ? sha(file) : null };
  });

  const before = (() => {
    /** @type {Map<number, Map<string, Object>>} */
    const out = new Map();
    for (const volume of [1, 2]) {
      const store = openRecord(series, volume);
      out.set(volume, factRows(store));
      store.close();
    }
    return out;
  })();

  /** @type {Array<Object>} */
  const calls = [];
  const ask = async ({ item }) => {
    calls.push({ term: item.term });
    // The quote has to be a line the FLAGGING volume's own book prints — volume 1 in this fixture, because
    // volume 1's read pass is what published the row. That is the revision door's rule, unchanged.
    return JSON.stringify({ decision: "revise", rendering: "The Chieftain's Banner", quote: "Знамя повешено над воротами замка.", reason: "Volume 2 prints a different word for this banner." });
  };

  const planned = captureConsole(() => planSettlementPass({ seriesDir: series.dir, volumeRefs }));
  const coverageLine = planned.logs.find((line) => line.includes("[glossary-settlement] the note half"));
  ok(Boolean(coverageLine), "the pass did not print the note half's coverage on its own line");
  ok(/blind/.test(coverageLine || ""), `the coverage line does not name the state: ${coverageLine}`);
  ok(/1 marker\(s\) declared by this series' plan of record/.test(coverageLine || ""), `the coverage line does not say which vocabulary was in force: ${coverageLine}`);

  const pass = await executeSettlementPass(planned.result, { values, ask });
  same(calls.length, 1, `the pass paid ${calls.length} call(s) for the one term the declared marker put on the agenda`);
  same(pass.agendaCount, 1, "the agenda the pass ran is not the one the declared marker produced");
  same(pass.revised, 1, "the revision was not filed");
  same(pass.textRule.state, "blind", "the pass does not carry the coverage out to its caller");
  same(pass.declaration.state, "declared", "the pass does not carry the declaration out to its caller");

  const paths = settlementRecordPaths(series.dir);
  const record = JSON.parse(fs.readFileSync(paths.json, "utf8"));
  same(record.noteRule.state, "blind", "the JSON record does not carry the coverage");
  same(record.noteRule.askable, true, "the JSON record reports a marker-backed note half as unaskable");
  same(record.noteRule.notesOutsideVocabulary, 3, "the JSON record does not count the notes the vocabulary could not read");
  same(record.noteRule.rowsFiredByMarkers, 1, "the JSON record does not count the row a declared marker fired on");
  same(record.markerDeclaration.state, "declared", "the JSON record does not say which vocabulary was in force");
  same(record.markerDeclaration.markers.map((m) => m.phrase), [DECLARED_MARKER], "the JSON record does not name the declared markers");
  same(record.agenda, { candidates: 1, chain: 0, forward: 1 }, "the JSON record does not say what the agenda was made of");
  same(record.decisions[0].agenda, ["declared-marker"], "the decision does not name which half put the term on the agenda");
  same(record.decisions[0].markers, [DECLARED_MARKER], "the decision does not name the phrase that fired");
  same(record.decisions[0].shapes, [], "the decision claims a shipped shape fired on a Cyrillic note");

  const log = fs.readFileSync(paths.markdown, "utf8");
  ok(log.includes("## What the note half of the agenda was able to read"), "the log has no coverage section");
  ok(/State: \*\*blind\*\*/.test(log), "the log does not name the state");
  // The honest wording depends on whether the blind half found anything: 0 is "NOT a finding that this
  // series has nothing to settle", a non-zero count is "a floor, not a count". Both say the same thing.
  ok(/NOT a finding that this series has nothing to settle|floor, not a count/.test(log),
    "the log reports a blind note half as a plain count");
  ok(/declared marker\(s\) were matched as literal text over all 3 note\(s\)/.test(log), "the log does not say the declared markers were what made it askable");
  ok(/Coverage Proof\(02\)/.test(log), "the log does not name the settled record it asked");

  // A second pass over the same agenda pays nothing, blind spot and all.
  const secondPlan = captureConsole(() => planSettlementPass({ seriesDir: series.dir, volumeRefs }));
  const second = await executeSettlementPass(secondPlan.result, { values, ask });
  same(calls.length, 1, `the second pass paid ${calls.length - 1} extra call(s) for a question already answered`);
  same(second.asked, 0, "the second pass asked something");
  same(second.carriedOver, 1, "the second pass did not carry the answer over");
  same(readSettlementDecisions(paths.json).unanswered, [], "an answered question is still owed");

  // No sealed row was edited, in either record. The revision files a NEW row into the record of the volume
  // whose book carries the quote, and the only columns that move on the row it replaces are the two
  // `markSuperseded` has always written. The settled record receives the new row through the store's own
  // top-up door, which is `INSERT OR IGNORE` — it adds rows and edits none.
  const after = (() => {
    /** @type {Map<number, Map<string, Object>>} */
    const out = new Map();
    for (const volume of [1, 2]) {
      const store = openRecord(series, volume);
      out.set(volume, factRows(store));
      store.close();
    }
    return out;
  })();

  /**
   * Compare one record's rows before and after the pass, and report what moved.
   *
   * @param {number} volume
   * @returns {{added: string[], removed: string[], moved: Array<{id: string, columns: string[]}>}}
   */
  function diffRecord(volume) {
    const was = before.get(volume);
    const now = after.get(volume);
    const added = [...now.keys()].filter((id) => !was.has(id));
    const removed = [...was.keys()].filter((id) => !now.has(id));
    /** @type {Array<{id: string, columns: string[]}>} */
    const moved = [];
    for (const [id, row] of was) {
      const current = now.get(id);
      assert.ok(current, `the pass removed the published row ${id} from volume ${volume}'s record`);
      const columns = movedColumns(row, current);
      if (columns.length) moved.push({ id, columns });
    }
    return { added, removed, moved };
  }

  const filed = diffRecord(1);
  same(filed.removed, [], "volume 1's record lost a row");
  same(filed.added.length, 1, `volume 1's record gained ${filed.added.length} row(s); the revision files exactly one`);
  same(filed.moved.length, 1, `volume 1's record had ${filed.moved.length} row(s) with a column moved; the settlement marks exactly one row superseded`);
  const replacedRow = after.get(1).get(filed.moved[0].id);
  same(filed.moved[0].columns, ["status", "updated_at"], `the settlement edited the published row ${filed.moved[0].id}: columns ${filed.moved[0].columns.join(", ")}`);
  same(replacedRow.status, "superseded", `the replaced row was marked ${replacedRow.status}, not superseded`);
  same(replacedRow.row_version, before.get(1).get(filed.moved[0].id).row_version, "the replaced row's row_version moved");

  const carried = diffRecord(2);
  same(carried.removed, [], "the settled record lost a row");
  same(carried.moved, [], `the settled record had ${carried.moved.length} row(s) edited — the top-up door adds rows and edits none`);
  same(carried.added.length, 1, "the settled record did not receive the new row");

  // The settled record now prints the new rendering, which is the whole point of the pass.
  const settledStore = openRecord(series, 2);
  const inForce = publishedGlossaryRowsInRecord(settledStore, { volume: 2 }).find((row) => row.term === "Знамя");
  settledStore.close();
  same(inForce.rendering, "The Chieftain's Banner", "the settled record still prints the rendering the pass replaced");
  // A named limit, asserted rather than hidden: the revision door files the settlement's own `reason` as
  // the NEW row's notes cell, so a settled revision replaces a note written in the book's language with one
  // written by the pass in the language the series is translated into. The old row survives marked
  // superseded and the published file keeps its `Earlier rendering:` history line; nothing is edited. What
  // it means for the agenda is that a settled term's note becomes readable by the shipped vocabulary —
  // which is the pass narrowing its own blind spot one term at a time, and is not the same as the blind
  // spot being closed.
  same(dominantScriptOf(inForce.notes), "Latin", "the settled record's note for the revised term is not the pass's own reason");
  same(dominantScriptOf(before.get(1).get(filed.moved[0].id).body), "Cyrillic", "the row the settlement replaced was not written in the book's script");

  for (const entry of publishedBefore) {
    if (!entry.exists) continue;
    same(sha(entry.file), entry.digest, `the settlement rewrote the published file ${entry.file}`);
  }
});

// ─── 9. a source-language note survives the render and reads back ─────────────

scenario("a published glossary prints the source-language note and reads it back unchanged", async () => {
  const { series } = await buildSeries("coverage-render-round-trip", cyrillicGlossary());
  const store = openRecord(series, 1);
  const markdown = renderGlossary(store, { volume: 1 });
  const rows = publishedGlossaryRowsInRecord(store, { volume: 1 });
  store.close();

  const banner = rows.find((row) => row.term === "Знамя");
  ok(Boolean(banner), "the fixture's forward-pointing row is not in the record");
  ok(markdown.includes(DECLARED_MARKER), "the published file does not print the note in the book's own language");
  same(dominantScriptOf(banner.notes), "Cyrillic", "the row's own notes cell is not written in the book's script");

  const parsed = parseGlossaryMarkdown(markdown);
  const back = parsed.rows.find((row) => row.term === "Знамя");
  ok(Boolean(back), "the published file does not parse back into the row it printed");
  same(back.notes, banner.notes, "re-reading the published file changes the note the record holds");
  same(dominantScriptOf(back.notes), "Cyrillic", "the note that came back is not in the book's script");
  ok(firedForwardShapes(back.notes).length === 0, "a shipped shape fired on the note after the round trip — the blind spot is not symmetrical");
  same(firedForwardMarkers(back.notes, [{ phrase: DECLARED_MARKER }]), [DECLARED_MARKER], "the declared marker stopped matching after the round trip");
  same(parsed.annotatedRows, [], "the published file reports markup it does not contain");
});

// ─── 10. what this slice did not add ──────────────────────────────────────────

scenario("no table, no schema bump, no finding kind, no level, no freeze door, no knob, no model call", () => {
  same(SCHEMA_VERSION, 13, `SCHEMA_VERSION moved to ${SCHEMA_VERSION}`);
  same(MIGRATIONS.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], "a migration was added");
  ok(!COUNTED_TABLES.includes("settlement_markers") && !COUNTED_TABLES.includes("forward_markers"), "a table was added for the declared markers");
  same(Object.keys(FINDING_LEVELS).length, 72, `the finding level table is ${Object.keys(FINDING_LEVELS).length} kinds`);
  same(frozenDoors().length, 12, `the freeze gate has ${frozenDoors().length} doors`);

  const layer = readModuleLayer(ROOT, "glossary/settlement.js");
  ok(!/process\.env/.test(layer), "the settlement layer reads the environment — a guard with a knob is not a guard");
  ok(!/new RegExp\(/.test(layer), "the settlement layer compiles a pattern out of data a series wrote");
  ok(!/createAgentHandle\(/.test(layer), "the settlement layer opens an agent turn");
  ok(!/runAgent\(/.test(layer), "the settlement layer runs an agent");

  // The declaration leaf is a leaf: it needs fs/path/types and nothing else.
  const leaf = fs.readFileSync(path.join(ROOT, "glossary/settlement/declaration.js"), "utf8");
  const requires = [...leaf.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  same(requires, ["fs", "path", "../../types"], `the declaration leaf requires ${requires.join(", ")} — it is not a leaf`);

  // The prompt half asks for the note in the book's language and names no language doing it.
  const prompt = fs.readFileSync(path.join(ROOT, "system-prompts", "glossary-terms.md"), "utf8");
  ok(/write the note in the language the volume's source text is written in/.test(prompt), "the glossary prompt no longer asks for a source-language note");
  ok(/\*\*written in the language the source text is written in\*\* \(string\)/.test(prompt), "the glossary prompt's `note` key no longer names the language it is written in");
  ok(!/\b(Japanese|English|Korean|Chinese|Russian|Spanish|French|German)\b/.test(prompt), "the glossary prompt names a language doing this");
  ok(/Respond with \*\*only\*\* a JSON object holding two keys, `terms` and `revisions`/.test(prompt), "the glossary prompt's envelope line moved");
  ok(/\{"terms": \[\], "revisions": \[\]\}/.test(prompt), "the glossary prompt's nothing-new answer moved");
  const example = prompt.slice(prompt.indexOf("Example shape (do not copy these values):"));
  const exampleNotes = [...example.matchAll(/"note": "([^"]+)"/g)].map((m) => m[1]);
  ok(exampleNotes.length >= 3, `the prompt's example carries ${exampleNotes.length} notes, fewer than the three rows it shows`);
  for (const note of exampleNotes) {
    // The example's notes are written in the script its terms are written in, and the example's renderings
    // are written in the language the series is translated into. That split is the whole prompt change.
    ok(dominantScriptOf(note) !== "Latin", `the prompt's own example note "${note}" is written in the target language, not the term's`);
    ok(scriptCountsOf(note).get("Latin") === undefined, `the prompt's example note "${note}" mixes in letters of the target language`);
  }
  for (const rendering of [...example.matchAll(/"rendering": "([^"]+)"/g)].map((m) => m[1])) {
    same(dominantScriptOf(rendering), "Latin", `the prompt's example rendering "${rendering}" is no longer written in the target language`);
  }
  for (const key of ["term", "rendering", "note", "quote", "reason"]) {
    ok(example.includes(`"${key}"`), `the prompt's example no longer produces "${key}"`);
  }
  same((prompt.match(/```/g) || []).length % 2, 0, "the glossary prompt shows the model an unterminated example");

  // The coverage is never a refusal and never a finding.
  const agenda = { textRule: NOTE_RULE_NOT_REPORTED, forwardCount: 0, chainCount: 0 };
  same(agenda.textRule.state, "not-reported", "a pass that reports no coverage reports a state at all");
  ok(/never be readable as an agenda that found nothing|cannot tell an agenda that found nothing/.test(
    fs.readFileSync(path.join(ROOT, "glossary/settlement/records.js"), "utf8")
  ), "the records module does not say why a missing coverage is a hole");
});

// ─── run ──────────────────────────────────────────────────────────────────────

(async () => {
  for (const { name, fn } of scenarios) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      console.log(`  FAIL ${name}\n      ${String(err && err.message ? err.message : err)}`);
      process.exitCode = 1;
    }
  }
  console.log(`\nsettlement agenda coverage: ${scenarios.length} scenario(s), ${checks} check(s), 0 model calls.`);
  if (process.exitCode) process.exit(1);
})();

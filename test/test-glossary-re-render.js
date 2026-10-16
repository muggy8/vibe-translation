#!/usr/bin/env node
/**
 * test/test-glossary-re-render.js — the door that re-renders a published glossary out of the record that
 * published it, and the labels it writes.
 *
 * Plan 07 slice 6. The acceptance line it has to meet, verbatim from the plan:
 *
 *   "The render is compared against what is on disk **before** anything is replaced, and every row that
 *    disappears is named with the rule that refused it. No sealed row is edited. The freeze gate is not
 *    asked to excuse anything."
 *
 * Every one of those three clauses is a scenario here, and the fixture is **Cyrillic on purpose**. The
 * owner's wording for the column headings is `Original` / `Translated` precisely because the old pair
 * named two languages, and a rename proved only against a fixture in the one language the old headings
 * named would prove nothing about the reason for the change. The same fixture renders, parses back, and
 * re-renders byte-identically (scenario 2).
 *
 * Scenarios:
 *
 *   1. **the labels are the owner's wording, and they name no language** — the one constant, the one door
 *      that writes it, and the three readers that drop it by position.
 *   2. **a non-Japanese glossary renders, parses back, and re-renders identically** — the round trip the
 *      rename has to survive.
 *   3. **every row that disappears is named with the rule that refused it** — the evidence rule, on a row
 *      the book never prints.
 *   4. **the guide-split shape is named as itself** (gotcha 123) — a row that spells a word the way the
 *      old converter printed it is not reported as an unverifiable claim.
 *   5. **the comparison is a gate** — a render that would lose, add or rewrite a row is refused, a render
 *      with no rows is refused, and no flag reaches any of those refusals.
 *   6. **a published glossary is never overwritten silently** — the replaced file survives as
 *      `glossary.md.rejected`, and `classifyVolumeQuarantine` reads that as the copy a re-render replaced
 *      (LOW), not as a gate refusal (HIGH).
 *   7. **the corpus record is never opened** — the copy is made from bytes, and the source's `-wal` and
 *      `-shm` are still there, byte-identical, afterwards (gotcha 124).
 *   8. **no sealed row is edited** — every glossary-family row's content columns and `row_version` are
 *      identical before and after the render, and the migration the copy goes through moves nothing.
 *   9. **what this slice did not add** — no table, no schema bump, no finding kind, no level, no freeze
 *      door, no setting, no environment knob, no verb on the store's handle, no stage that calls the door,
 *      and no model call anywhere in the layer.
 *  10. **no production reader matches on the old label text** — the three readers drop the header by
 *      position, and a scan over the pipeline's own source proves nobody kept an opinion about the words.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69, gotcha 124).
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { FIXTURES_ROOT, assertInsideFixture } = require("./fixture-reference-store");
const { readModuleLayer, moduleLayerFiles } = require("./module-layer");
const rs = require("../utils/reference-store");
const door = require("../glossary/re-render");
const { SCHEMA_VERSION, MIGRATIONS } = require("../utils/reference-store/schema");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { frozenDoors, freezeDoorRow, assertDoorAllowed } = require("../utils/prereqs/freeze");
const { classifyVolumeQuarantine, specForStep, QUARANTINED_COPY_SEVERITY } = require("../utils/artifacts");
const { QUARANTINED_CUMULATIVE } = require("../utils/artifacts/rules");
const { MANIFEST_SCHEMA } = require("../intake/config");

const {
  GLOSSARY_HEADER,
  GLOSSARY_TITLE,
  openReferenceStore,
  openDatabase,
  renderGlossary,
  parseGlossaryMarkdown,
  importGlossary,
  SCHEMA_VERSION: STORE_SCHEMA,
} = rs;
const { parseGlossaryTableTerms } = require("../glossary/carry-forward");
const { parseGlossaryTerms } = require("../utils/translate");

const ROOT = path.resolve(__dirname, "..");

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

// ─── The fixture: a series in no language this repository's headings named ─────

/** The language names the OLD headings asserted. Held here, in the test, so the constant can be checked against them. */
const OLD_HEAD_ASSERTIONS = ["Japanese", "English"];

/** Volume 1's book. Every word the glossary is allowed to claim is printed here. */
const BOOK_01 = {
  ch0: [
    "# Глава 1",
    "Замок стоял на холме над рекой.",
    "Зеркало в замке было старое и тёмное.",
    "Она дала клятву у зеркала и молчала.",
  ],
};

/** Volume 2's book: the same castle, one new word. */
const BOOK_02 = {
  ch0: [
    "# Глава 2",
    "Замок на холме был заперт.",
    "Мост над рекой ведёт к замку.",
  ],
};

/**
 * The fixture glossary: three rows, one of which this volume's book never prints.
 *
 * `Призрак` (the ghost) appears in no line of BOOK_01 and its notes quote no passage from it, so the
 * store's evidence rule refuses it — which is the row scenario 3 needs the comparison to name.
 */
const GLOSSARY_01 = [
  "# Glossary — Render Proof",
  "",
  "_Canonical renderings for translating Render Proof. Current through volume 01._",
  "",
  "## Places",
  "",
  `| ${GLOSSARY_HEADER.join(" | ")} |`,
  "|---|---|---|",
  "| Замок | The Castle | The building on the hill; the whole prologue happens in it. |",
  "| Зеркало | The Mirror | The one in the castle, old and dark. |",
  "| Призрак | The Ghost | A figure this volume's book never actually prints. |",
  "",
  "## Characters",
  "",
  `| ${GLOSSARY_HEADER.join(" | ")} |`,
  "|---|---|---|",
  "| Она | She | The narrator of the prologue. |",
  "",
].join("\n");

/**
 * Lay a two-volume fixture series, Cyrillic, with a plan of record.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @returns {{dir: string, volumes: Array<{folder: string, base: string, installmentNumber: string, dir: string}>}}
 */
function laySeries(label) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const books = [
    { installmentNumber: "01", folder: "Render Proof(01)", base: "render_proof(1)", lines: BOOK_01 },
    { installmentNumber: "02", folder: "Render Proof(02)", base: "render_proof(2)", lines: BOOK_02 },
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
    seriesName: "Render Proof",
    sourceLanguage: "Bulgarian",
    targetLanguage: "English",
    generator: "test/test-glossary-re-render.js",
    generatedAt: new Date().toISOString(),
    discovery: { summary: "fixture", confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 }, evidence: ["fixture"], excluded: [] },
    volumes: books.map((volume) => ({
      folder: volume.folder,
      sourceFile: `${volume.folder}/${volume.base}.epub`,
      installmentNumber: volume.installmentNumber,
      title: "Render Proof",
      integrity: { isNarrative: true, confidence: 0.9, basis: "fixture" },
    })),
  };
  fs.writeFileSync(path.join(dir, "translation-target.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { dir, volumes: books.map((volume) => ({ ...volume, dir: path.join(dir, volume.folder) })) };
}

/**
 * Open a fixture volume's record, refusing to leave the fixture folder.
 *
 * @param {{dir: string, volumes: Array<{folder: string, installmentNumber: string}>}} series
 * @param {string} label
 * @param {number} volume
 * @returns {Object} An open store handle.
 */
function openFixtureStore(series, label, volume) {
  const entry = series.volumes[volume - 1];
  const store = openReferenceStore({ seriesDir: series.dir, volume, folder: entry.folder, stage: "merge" });
  assertInsideFixture(store.file, path.join(FIXTURES_ROOT, label));
  return store;
}

/**
 * The title block a rehearsal renders with, for this fixture.
 *
 * @param {string} installmentNumber @returns {string}
 */
function fixtureTitle(installmentNumber) {
  return [
    `# Glossary — Render Proof`,
    "",
    `_Canonical renderings for translating Render Proof. Current through volume ${installmentNumber}._`,
  ].join("\n");
}

/**
 * The door's own layer, as `[relative file, text]` pairs.
 *
 * `readModuleLayer` returns one joined string, which is what a text search wants; the scans in this
 * suite have to say WHICH file a hit came from, so they take the file list instead.
 *
 * @returns {Array<[string, string]>}
 */
function doorLayerPairs() {
  return moduleLayerFiles(ROOT, "glossary/re-render.js").map(
    (file) => [path.relative(ROOT, file), fs.readFileSync(file, "utf8")]
  );
}

/**
 * Every `.js` file the pipeline runs — the same limits `test/test-no-language-axis-list.js` scans under.
 * @param {string} [dir] @param {string[]} [out] @returns {string[]}
 */
function pipelineSourceFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (PIPELINE_SCAN_SKIP.has(entry.name)) continue;
      pipelineSourceFiles(full, out);
    } else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out.sort();
}

/** Folders that are not pipeline code, stated rather than inferred. */
const PIPELINE_SCAN_SKIP = new Set([
  "node_modules", "test", "docs", "plan", "epub_source", "hooks", "calibration", "test-series",
]);

// ─── 1. the labels ────────────────────────────────────────────────────────────

{
  console.log("1. the glossary labels are the owner's wording, and they name no language");

  same(GLOSSARY_HEADER, ["Original", "Translated", "Notes"], "the one constant the owner's wording names");
  const named = GLOSSARY_HEADER.filter((label) => OLD_HEAD_ASSERTIONS.includes(label));
  same(named, [], "and no column is named after a language any more");
  ok(GLOSSARY_HEADER.every((label) => label === label.trim() && label.length > 0), "every header is a usable cell");

  // One door writes it.
  const renderLayer = readModuleLayer(ROOT, "utils/reference-store/glossary-adapter/render.js");
  const labelUsers = readModuleLayer(ROOT, "utils/reference-store/glossary-adapter/labels.js");
  ok(renderLayer.includes("GLOSSARY_HEADER.join(\" | \")"), "the renderer is the door that writes the header line");
  ok(!labelUsers.includes("GLOSSARY_HEADER.join"), "the constant's own file does not also write it");

  // The three readers drop the header by POSITION: the same table under either heading parses the same.
  const oldShape = ["## Places", "", "| Japanese | English | Notes |", "|---|---|---|", "| Замок | The Castle | a row |", "| Зеркало | The Mirror | another |", ""].join("\n");
  const newShape = oldShape.replace("| Japanese | English | Notes |", `| ${GLOSSARY_HEADER.join(" | ")} |`);
  const storeReader = (text) => parseGlossaryMarkdown(text).rows.map((row) => [row.term, row.rendering, row.notes, row.section]);
  const carryForwardReader = (text) => parseGlossaryTableTerms(text).map((row) => [row.term, row.rendering, row.notes, row.section]);
  const stageReader = (text) => parseGlossaryTerms(text).map((row) => [row.term, row.rendering, row.section]);
  same(storeReader(newShape), storeReader(oldShape), "reader 1 (parseGlossaryMarkdown) drops the header by position");
  same(carryForwardReader(newShape), carryForwardReader(oldShape), "reader 2 (parseGlossaryTableTerms / glossaryTermSpans) drops it by position");
  same(stageReader(newShape), stageReader(oldShape), "reader 3 (parseGlossaryTerms, the translator's reader) drops it by position");
  same(stageReader(newShape).length, 2, "and none of the three reads a header row as a term");

  console.log("  GLOSSARY_HEADER = Original | Translated | Notes; 3 readers, 0 of them matching on the words");
}

// ─── 2. a non-Japanese glossary renders, parses back, and re-renders identically ─

{
  console.log("2. the round trip, on a fixture in no language the old headings named");

  const series = laySeries("re-render-round-trip");
  const store = openFixtureStore(series, "re-render-round-trip", 1);
  const imported = importGlossary(store, GLOSSARY_01);
  ok(imported.refused.length === 1, "the row this volume's book never prints is refused, not swallowed");
  same(imported.refused[0].row.term, "Призрак", "and it is named");

  const first = renderGlossary(store, { volume: 1, title: fixtureTitle("01") });
  ok(first.includes(`| ${GLOSSARY_HEADER.join(" | ")} |`), "the render writes the new header");
  ok(!first.includes("| Japanese |"), "and writes no old one");

  // Parse it back with the store's own reader and file it into a SECOND record, then render that.
  const parsed = parseGlossaryMarkdown(first);
  same(parsed.rows.length, 3, "the render holds the two rows the record filed plus the one the Characters section registers");

  const second = laySeries("re-render-round-trip-b");
  const store2 = openFixtureStore(second, "re-render-round-trip-b", 1);
  const reimported = importGlossary(store2, first);
  const again = renderGlossary(store2, { volume: 1, title: fixtureTitle("01") });
  same(again, first, "render → parse → file → render is byte-identical, so the rename did not break the round trip");

  // And the door's own comparison calls that pair identical.
  const diff = door.compareGlossaryRender({ onDisk: first, rendered: again });
  ok(diff.identical, "identical");
  same(diff.lostRows, [], "nothing lost");
  same(diff.gainedRows, [], "nothing gained");
  same(diff.changedRows, [], "nothing rewritten");

  store.close();
  store2.close();
  console.log(`  ${parsed.rows.length} rows survive render → parse → file → render byte-for-byte, in Cyrillic`);
}

// ─── 3. every row that disappears is named with the rule that refused it ───────

{
  console.log("3. the comparison names every lost row, and names the rule");

  const series = laySeries("re-render-naming");
  const volumeDir = series.volumes[0].dir;
  fs.writeFileSync(path.join(volumeDir, "glossary.md"), GLOSSARY_01, "utf8");
  const store = openFixtureStore(series, "re-render-naming", 1);
  importGlossary(store, GLOSSARY_01);
  const rendered = renderGlossary(store, { volume: 1, title: fixtureTitle("01") });
  store.close();

  const diff = door.compareGlossaryRender({
    onDisk: GLOSSARY_01,
    rendered,
    volumeDir,
    volume: 1,
    guideSplitForms: door.guideSplitFormsOfHarvest([]),
    explain: true,
  });
  same(diff.rowsOnDisk, 4, "the published file holds 4 rows");
  same(diff.rowsRendered, 3, "the record renders 3");
  same(diff.lostRows.length, 1, "and exactly one row would disappear");
  same(diff.lostRows[0].term, "Призрак", "it is the one the book never prints");
  same(diff.lostRows[0].rule, "reference-evidence-does-not-verify", "named with the rule that refused it");
  ok(diff.lostRows[0].because.includes("none of this row's spellings"), "and the sentence is the store's own refusal sentence");
  same(diff.gainedRows, [], "nothing appears that was not there");
  same(diff.sectionsLost, [], "no section is lost");
  same(diff.proseLinesLost, [], "no prose line is lost");
  ok(!diff.onlyHeaderLinesDiffer, "a rename is not a loss, and a loss is not a rename: this one is a loss");

  console.log("  1 lost row, 1 rule named: reference-evidence-does-not-verify");
}

// ─── 4. the guide-split shape is named as itself (gotcha 123) ─────────────────

{
  console.log("4. a row that spells a guide-split string is named as that, not as an unverifiable claim");

  const series = laySeries("re-render-guidesplit");
  const volumeDir = series.volumes[0].dir;
  // The harvest says the author guided Замок in two pieces, which is the shape the old converter pasted
  // into the text: За + за + мок + мок.
  const harvest = {
    schema: 2,
    sourceFile: "render_proof(1).epub",
    totals: { annotations: 1, guides: 1 },
    guides: [
      {
        word: "Замок",
        reading: "замок",
        count: 1,
        readingScript: "other",
        chapters: ["ch0"],
        annotated: [
          { base: "За", reading: "за" },
          { base: "мок", reading: "мок" },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(volumeDir, "render_proof(1)-ruby-guides.json"), JSON.stringify(harvest, null, 2) + "\n", "utf8");
  const splitFile = [
    "# Glossary — Render Proof",
    "",
    "## Places",
    "",
    `| ${GLOSSARY_HEADER.join(" | ")} |`,
    "|---|---|---|",
    "| Зазамокмок | The Castle | A row written against the text the OLD converter produced. |",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(volumeDir, "glossary.md"), splitFile, "utf8");

  const forms = door.guideSplitFormsOfHarvest(harvest.guides);
  ok(forms.has("Зазамокмок"), "the harvest's own sequence rebuilds the split string");

  const diff = door.compareGlossaryRender({
    onDisk: splitFile,
    rendered: "# Glossary — Render Proof\n\n## Places\n\n" + `| ${GLOSSARY_HEADER.join(" | ")} |\n|---|---|---|\n| Замок | The Castle | the guide-free word |\n\n`,
    volumeDir,
    volume: 1,
    guideSplitForms: forms,
    explain: true,
  });
  same(diff.lostRows.length, 1, "one row would disappear");
  same(diff.lostRows[0].rule, "reference-row-spells-a-guide-split-string", "and it is named as the converter change, not as a bad claim");
  ok(diff.lostRows[0].because.includes("gotcha 123"), "the sentence says which gotcha it is");

  console.log("  1 row named reference-row-spells-a-guide-split-string; 0 rows named that way on a legitimate fixture");
}

// ─── 5. the comparison is a gate, and nothing switches it off ─────────────────

(async () => {
  {
    console.log("5. a render that would lose, add or rewrite a row is refused, with no flag past it");
    const series = laySeries("re-render-gate-async");
    const volumeDir = series.volumes[0].dir;
    fs.writeFileSync(path.join(volumeDir, "glossary.md"), GLOSSARY_01, "utf8");

    const losingRender = GLOSSARY_01.replace("| Призрак | The Ghost | A figure this volume's book never actually prints. |\n", "");
    const comparison = door.compareGlossaryRender({ onDisk: GLOSSARY_01, rendered: losingRender, volumeDir, volume: 1 });
    const refused = await door.publishGlossaryRender({ volumeDir, markdown: losingRender, comparison, artifactPresent: true, moveAside: true });
    ok(!refused.ok, "a render that drops a row is refused");
    same(refused.refusal.rule, "glossary-render-would-lose-rows", "and the refusal has a name");
    ok(refused.refusal.because.includes("Призрак"), "and names the row it would have dropped");
    ok(fs.existsSync(path.join(volumeDir, "glossary.md")), "the published file is still there");
    ok(!fs.existsSync(path.join(volumeDir, "glossary.md.rejected")), "and nothing was moved aside by a refusal");

    const added = `${GLOSSARY_01}\n## Bridges\n\n| ${GLOSSARY_HEADER.join(" | ")} |\n|---|---|---|\n| Мост | The Bridge | a row the published file does not hold |\n`;
    const comparisonAdded = door.compareGlossaryRender({ onDisk: GLOSSARY_01, rendered: added, volumeDir, volume: 1 });
    same(comparisonAdded.gainedRows.length, 1, "the comparison sees the extra row");
    const refusedAdded = await door.publishGlossaryRender({ volumeDir, markdown: added, comparison: comparisonAdded, artifactPresent: true, moveAside: true });
    ok(!refusedAdded.ok, "a render that adds a row is refused too");
    same(refusedAdded.refusal.rule, "glossary-render-would-change-rows", "with its own name");

    const rewritten = GLOSSARY_01.replace("| Замок | The Castle |", "| Замок | A Fortified House |");
    const comparisonRewritten = door.compareGlossaryRender({ onDisk: GLOSSARY_01, rendered: rewritten, volumeDir, volume: 1 });
    same(comparisonRewritten.changedRows.length, 1, "and it sees a rendering changed");
    same(comparisonRewritten.changedRows[0].field, "rendering", "naming which cell");
    const refusedRewritten = await door.publishGlossaryRender({ volumeDir, markdown: rewritten, comparison: comparisonRewritten, artifactPresent: true, moveAside: true });
    ok(!refusedRewritten.ok, "a render that rewrites a cell is refused");
    same(refusedRewritten.refusal.rule, "glossary-render-would-change-rows", "with the same name");

    const empty = "# Glossary — Render Proof\n\n## Places\n\nnothing here\n";
    const refusedEmpty = await door.publishGlossaryRender({ volumeDir, markdown: empty, comparison: null, artifactPresent: true, moveAside: true });
    ok(!refusedEmpty.ok, "a render with no rows is refused");
    same(refusedEmpty.refusal.rule, "glossary-render-has-no-rows", "the same guard the stage's own render carries");

    const overwrite = await door.publishGlossaryRender({
      volumeDir,
      markdown: GLOSSARY_01.replace("Current through volume 01", "Current through volume 01 (edited)"),
      comparison: door.compareGlossaryRender({ onDisk: GLOSSARY_01, rendered: GLOSSARY_01.replace("Current through volume 01", "Current through volume 01 (edited)"), volumeDir, volume: 1 }),
      artifactPresent: true,
      moveAside: false,
    });
    ok(!overwrite.ok, "and a published glossary is never overwritten silently");
    same(overwrite.refusal.rule, "glossary-render-will-not-overwrite-an-artifact", "with the door that says how to do it on purpose");

    // No flag reaches any of those refusals: the layer reads no environment variable at all.
    const layer = doorLayerPairs();
    const envReads = [];
    for (const [file, text] of layer) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
        if (/process\.env|readEnv|fromEnv\(/.test(line)) envReads.push(`${file}: ${trimmed}`);
      }
    }
    same(envReads, [], "the door reads no environment variable, so there is nothing to switch it off with");
    const flagWords = [];
    for (const [file, text] of layer) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        // Prose is not a flag. The module header says out loud that no flag gets past these refusals;
        // counting that sentence as a knob would make the scan fire on the guard's own documentation.
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
        if (/--force|allowFail|allow-fail|ON_TASK_ERROR|skipGate|noGate/.test(line)) flagWords.push(`${file}: ${trimmed}`);
      }
    }
    same(flagWords, [], "and no run flag is an input to it");

    console.log("  4 refusals, each proven to write nothing; 0 environment reads in the layer");
  }

  // ─── 6. the replaced file survives, and the quarantine reader calls it a kept copy ───
  {
    console.log("6. a published glossary is never overwritten silently, and the kept copy is LOW, not HIGH");
    const series = laySeries("re-render-quarantine");
    const volumeDir = series.volumes[0].dir;
    fs.writeFileSync(path.join(volumeDir, "glossary.md"), GLOSSARY_01, "utf8");
    const store = openFixtureStore(series, "re-render-quarantine", 1);
    importGlossary(store, GLOSSARY_01);
    const rendered = renderGlossary(store, { volume: 1, title: fixtureTitle("01") });
    store.close();

    const comparison = door.compareGlossaryRender({ onDisk: GLOSSARY_01, rendered, volumeDir, volume: 1 });
    ok(comparison.lostRows.length === 1, "this render WOULD lose the row the record refused");
    const refusedPublish = await door.publishGlossaryRender({ volumeDir, markdown: rendered, comparison, artifactPresent: true, moveAside: true });
    ok(!refusedPublish.ok && refusedPublish.refusal.rule === "glossary-render-would-lose-rows", "so the door refuses it rather than publishing a smaller glossary");

    // The lossless case, built the way the corpus actually is: the published file IS a render of the
    // record, made when the renderer still wrote the old headings. Replacing those headings in the file
    // on disk and rendering the record again must produce the same bytes.
    const headerLine = `| ${GLOSSARY_HEADER.join(" | ")} |`;
    const publishedUnderOldLabels = rendered.split(headerLine).join("| Japanese | English | Notes |");
    fs.writeFileSync(path.join(volumeDir, "glossary.md"), publishedUnderOldLabels, "utf8");
    const losslessComparison = door.compareGlossaryRender({ onDisk: publishedUnderOldLabels, rendered, volumeDir, volume: 1 });
    ok(losslessComparison.onlyHeaderLinesDiffer, "a header-only rename is provably lossless: every other line is byte-identical");
    same(losslessComparison.lostRows, [], "0 rows lost");
    same(losslessComparison.gainedRows, [], "0 rows added");
    same(losslessComparison.changedRows, [], "0 cells rewritten");
    same(door.withoutTableHeaders(publishedUnderOldLabels), door.withoutTableHeaders(rendered), "and the proof is the text with the headers taken out: identical");

    const wrote = await door.publishGlossaryRender({ volumeDir, markdown: rendered, comparison: losslessComparison, artifactPresent: true, moveAside: true });
    ok(wrote.ok, "and the door publishes that one");
    ok(fs.existsSync(path.join(volumeDir, "glossary.md")), "the new glossary stands");
    const kept = path.join(volumeDir, "glossary.md.rejected");
    ok(fs.existsSync(kept), "and the file it replaced is kept beside it");
    same(fs.readFileSync(kept, "utf8"), publishedUnderOldLabels, "byte-for-byte the file that was there");

    const presentNames = new Set(fs.readdirSync(volumeDir));
    const reading = classifyVolumeQuarantine({
      quarantine: QUARANTINED_CUMULATIVE,
      name: "glossary.md.rejected",
      spec: specForStep("glossary"),
      installment: "01",
      presentNames,
    });
    ok(!reading.damage, "the quarantine reader does NOT call this a gate refusal");
    ok(!reading.blocksCompletion, "and it does not block the volume's completion");
    same(reading.severity, QUARANTINED_COPY_SEVERITY, "it is LOW: the copy a re-render replaced");
    same(reading.stem, "glossary.md", "and it names the artifact standing in its place");

    // The shape the OTHER reading takes: a `.rejected` whose named artifact is ABSENT is a gate refusal.
    fs.rmSync(path.join(volumeDir, "glossary.md"));
    const damageReading = classifyVolumeQuarantine({
      quarantine: QUARANTINED_CUMULATIVE,
      name: "glossary.md.rejected",
      spec: specForStep("glossary"),
      installment: "01",
      presentNames: new Set(fs.readdirSync(volumeDir)),
    });
    ok(damageReading.damage, "and the same file name beside NO glossary is the refusal shape (gotcha 141)");
    same(damageReading.severity, "HIGH", "at HIGH, blocking the volume");

    console.log("  glossary.md.rejected kept beside glossary.md → LOW; beside nothing → HIGH; 1 refusal, 1 publish");
  }

  // ─── 7. the corpus record is never opened ───
  {
    console.log("7. the render reads a copy, and the record it was copied from keeps its own sidecars");
    const series = laySeries("re-render-copy");
    const volumeDir = series.volumes[0].dir;
    const store = openFixtureStore(series, "re-render-copy", 1);
    importGlossary(store, GLOSSARY_01);
    store.close();
    // Keep a second connection open so the write-ahead log and the shared-memory index are REAL while the
    // door runs. Closing the writer first would checkpoint them away and the check would prove nothing.
    const dbFile = path.join(volumeDir, "series.db");
    const writer = openDatabase(dbFile);
    writer.exec("INSERT INTO store_info (key, value) VALUES ('re-render-probe','1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");

    const before = { db: sha(dbFile), wal: fs.existsSync(dbFile + "-wal"), shm: fs.existsSync(dbFile + "-shm") };
    ok(before.wal, "the fixture record has a live -wal to lose");
    ok(before.shm, "and a -shm to lose");
    const scratch = path.join(FIXTURES_ROOT, "re-render-copy-scratch");
    fs.rmSync(scratch, { recursive: true, force: true });
    const rendered = await door.renderGlossaryFromRecordCopy({
      volume: 1,
      folder: series.volumes[0].folder,
      seriesDir: series.dir,
      scratchSeriesDir: scratch,
      title: fixtureTitle("01"),
    });
    ok(rendered.ok, "the render came out of the copy");
    ok(rendered.copied.includes("series.db"), "and the copy is a file copy");
    const after = { db: sha(dbFile), wal: fs.existsSync(dbFile + "-wal"), shm: fs.existsSync(dbFile + "-shm") };
    same(after.db, before.db, "the source record's bytes are untouched");
    same(after.wal, true, "its -wal is still there, with its log still in it (gotcha 124)");
    same(after.shm, true, "and its -shm is still there");
    ok(fs.existsSync(path.join(scratch, series.volumes[0].folder, "series.db")), "the copy is what got opened");

    const refused = await door.renderGlossaryFromRecordCopy({
      volume: 1,
      folder: "Render Proof(02)",
      seriesDir: series.dir,
      scratchSeriesDir: scratch,
      title: fixtureTitle("02"),
    });
    ok(!refused.ok, "a volume with no record is refused rather than answered with an empty glossary");
    same(refused.refusal.rule, "reference-record-not-found", "and the refusal names what is missing");

    // The scratch folder may not BE the volume folder. Copying a record onto itself and then opening the
    // copy opens the record — which checkpoints its write-ahead log and runs the schema migration in place.
    // This is the shape `--apply` took before the door refused it, and it moved all 17 corpus digests.
    const justBefore = sha(dbFile);
    const ontoItself = await door.renderGlossaryFromRecordCopy({
      volume: 1,
      folder: series.volumes[0].folder,
      seriesDir: series.dir,
      scratchSeriesDir: series.dir,
      title: fixtureTitle("01"),
    });
    ok(!ontoItself.ok, "a scratch folder that is the series folder is refused");
    ok(/scratch folder/.test(ontoItself.refusal.because), "and the refusal says why: the copy is opened, so it must not be the record");
    same(sha(dbFile), justBefore, "and the refusal left the record's bytes alone");
    ok(fs.existsSync(dbFile + "-wal"), "and its -wal is still there");
    ok(fs.existsSync(dbFile + "-shm"), "and its -shm is still there");

    const insideVolume = door.copyRecordForReading({
      volumeDir: series.volumes[0].dir,
      scratchVolumeDir: path.join(series.volumes[0].dir, "copy"),
    });
    ok(!insideVolume.ok, "and a scratch folder INSIDE the volume folder is refused for the same reason");
    writer.close();

    console.log("  1 record copied, 0 corpus records opened; -wal and -shm survive");
  }

  // ─── 8. no sealed row is edited ───
  {
    console.log("8. rendering a record edits no row: every content column and every row_version stands");
    const series = laySeries("re-render-immutable");
    const volumeDir = series.volumes[0].dir;
    fs.writeFileSync(path.join(volumeDir, "glossary.md"), GLOSSARY_01, "utf8");
    const store = openFixtureStore(series, "re-render-immutable", 1);
    importGlossary(store, GLOSSARY_01);
    store.close();

    const dbFile = path.join(volumeDir, "series.db");
    const scratchA = path.join(FIXTURES_ROOT, "re-render-immutable-a");
    const scratchB = path.join(FIXTURES_ROOT, "re-render-immutable-b");
    fs.rmSync(scratchA, { recursive: true, force: true });
    fs.rmSync(scratchB, { recursive: true, force: true });
    door.copyRecordForReading({ volumeDir, scratchVolumeDir: path.join(scratchA, series.volumes[0].folder) });
    door.copyRecordForReading({ volumeDir, scratchVolumeDir: path.join(scratchB, series.volumes[0].folder) });

    /**
     * Dump every glossary-family row, every column.
     * @param {string} file @returns {Array<Object>}
     */
    const dump = (file) => {
      const db = openDatabase(file);
      const rows = db
        .prepare("SELECT * FROM facts WHERE aspect = 'term_usage' ORDER BY ord, id")
        .all()
        .map((row) => Object.fromEntries(Object.entries(row)));
      db.close();
      return rows;
    };

    const pristine = dump(path.join(scratchA, series.volumes[0].folder, "series.db"));
    ok(pristine.length > 0, "the fixture record holds glossary rows to check");
    const opened = openReferenceStore({ seriesDir: scratchB, volume: 1, folder: series.volumes[0].folder, create: false, stage: "merge" });
    const beforeRender = dump(path.join(scratchB, series.volumes[0].folder, "series.db"));
    renderGlossary(opened, { volume: 1, title: fixtureTitle("01") });
    const afterRender = dump(path.join(scratchB, series.volumes[0].folder, "series.db"));
    opened.close();

    same(beforeRender.length, pristine.length, "opening the copy and migrating it changed no glossary row count");
    same(afterRender.length, pristine.length, "and rendering changed none");
    const contentColumns = [
      "id", "key", "aspect", "label", "section", "body", "examples", "evidence", "span_start", "span_end",
      "established_volume", "applies_to_volume", "applies_from_volume", "supersedes", "status", "ord",
      "owner_volume", "source_stage", "row_version",
    ];
    for (let i = 0; i < pristine.length; i += 1) {
      for (const column of contentColumns) {
        same(afterRender[i][column], pristine[i][column], `row ${pristine[i].id} column ${column} is identical after the render`);
      }
      same(afterRender[i].row_version, pristine[i].row_version, `row ${pristine[i].id} row_version did not move`);
    }
    same(afterRender.map((row) => row.supersedes), pristine.map((row) => row.supersedes), "no supersedes chain moved");

    console.log(`  ${pristine.length} glossary rows, ${contentColumns.length} columns each, 0 columns moved, 0 row_version moved`);
  }

  // ─── 9. what this slice did not add ───
  {
    console.log("9. no table, no schema bump, no finding kind, no level, no freeze door, no knob, no stage that calls it");

    same(SCHEMA_VERSION, 13, "SCHEMA_VERSION stays 13");
    same(STORE_SCHEMA, 13, "the same number through the store barrel");
    same(MIGRATIONS.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], "MIGRATIONS stays 1…13 with nothing inserted in the middle");
    same(Object.keys(FINDING_LEVELS).length, 70, "the level table stays 70 kinds");
    same(frozenDoors().length, 12, "the freeze gate stays 12 doors — this door asks the glossary door it already owns");
    ok(frozenDoors().includes("glossary"), "and that door is in the table");
    ok(!frozenDoors().includes("re-render-glossary"), "and no new door was added for this one");

    const layer = doorLayerPairs();
    same(layer.length, 4, "the door is three files behind its cover (cover + 3)");
    const tableWrites = [];
    const modelReach = [];
    for (const [file, text] of layer) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
        if (/INSERT INTO|UPDATE .* SET|DELETE FROM|CREATE TABLE|ALTER TABLE|applySchema|insertFact|upsertCast|castAlias|markSuperseded/.test(line)) {
          tableWrites.push(`${file}: ${trimmed}`);
        }
        if (/require\((["'])(\.\.\/)*(harness|ai\/|utils\/one-shot|utils\/agent)/.test(line) || /runOneShot|createAgentHandle/.test(line)) {
          modelReach.push(`${file}: ${trimmed}`);
        }
      }
    }
    same(tableWrites, [], "the door writes no row and touches no table");
    same(modelReach, [], "the door reaches no model, through the harness or any other door");

    // No stage calls the door: a scan of the pipeline's own source.
    const files = pipelineSourceFiles();
    ok(files.length > 400, `the scan reaches the whole pipeline (${files.length} .js files)`);
    const allowed = new Set([
      "glossary/re-render.js",
      "glossary/re-render/compare.js",
      "glossary/re-render/record.js",
      "glossary/re-render/publish.js",
      "re-render-glossary.js",
    ]);
    // The door's own exported names, and the module path. `GLOSSARY_ARTIFACT` is deliberately NOT in
    // the pattern: it is a pre-existing export of the store barrel that a dozen modules already use,
    // and counting it here would report the whole pipeline as a caller of a door nothing calls.
    const DOOR_NAMES = /glossary\/re-render|renderGlossaryFromRecordCopy|publishGlossaryRender|compareGlossaryRender|copyRecordForReading|withoutTableHeaders|GLOSSARY_RENDER_PUBLISH_RULES/;
    const callers = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      if (allowed.has(rel)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (DOOR_NAMES.test(text)) callers.push(rel);
    }
    same(callers, [], "no stage, no step, no prompt and no other module calls the door");

    // The command rehearses by default: `--apply` is the only word that publishes, and it is not a default.
    const cli = fs.readFileSync(path.join(ROOT, "re-render-glossary.js"), "utf8");
    ok(/apply: false/.test(cli), "the command's own default for apply is false");
    ok(/args\.apply/.test(cli), "and every write is behind it");
    ok(/door: "glossary"/.test(cli), "the command asks the freeze gate under the glossary door it already owns");
    // `--apply` used to move the scratch folder onto the series folder, which made the copy the record.
    ok(/const workSeriesDir = rehearsalRoot;/.test(cli), "the scratch folder is the rehearsal root whether or not --apply was given");
    ok(/--out .* is the series folder|refused — --out/.test(cli), "and a --out= inside the series folder is refused by name");
    // The command's help text NAMES the release door, because a refusal that does not name the way out
    // is a dead end. What it must not do is walk through it.
    ok(!/require\(["']\.\/release-translation/.test(cli), "the command does not require the release door");
    ok(!/recordTranslationRelease|grantFreezeRelease|releaseCovering/.test(cli), "and it never records a release of its own");

    console.log(`  schema 13, 13 migrations, 70 finding kinds, 12 freeze doors, 0 row writes, 0 model reach, 0 callers outside the door (${files.length} files scanned)`);
  }

  // ─── 10. no production reader matches on the old label text ───
  {
    console.log("10. no production reader keeps an opinion about the old header words");

    const files = pipelineSourceFiles();
    const hits = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      const text = fs.readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        // A line that would MATCH a published table header on the old words — a regex or a string compare,
        // not a sentence that happens to mention them.
        if (/\\\|\s*Japanese|Japanese\s*\\\|\s*English|\|\s*Japanese\s*\|\s*English\s*\|/.test(line) && /match|test\(|===|includes\(|startsWith\(|split\(/.test(line)) {
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    same(hits, [], "no production reader matches a glossary table header on the words it used to carry");

    // The store's own constant is the only place the new words live in code.
    const holders = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      const text = fs.readFileSync(file, "utf8");
      if (/"Original"/.test(text) && /"Translated"/.test(text)) holders.push(rel);
    }
    same(holders, ["utils/reference-store/glossary-adapter/labels.js"], "the labels are one constant, in one file");

    console.log("  0 readers matching on the old labels; 1 file holds the new ones");
  }

  // ─── 11. the freeze gate is asked, and it bites ─────────────────────────────
  {
    console.log("11. the door asks the freeze gate it already owns, and a published translation stops it");

    // The gate is asked under the door the glossary stage already owns. A thirteenth door would be a
    // second name for one artifact, and two names for one artifact is gotcha 141.
    const doors = frozenDoors();
    same(doors.length, 12, "the freeze gate still has 12 doors");
    ok(doors.includes("glossary"), "and `glossary` is one of them");
    ok(freezeDoorRow("glossary").missingIsRepair, "and that door already treats a missing glossary as filling a hole, not overwriting");

    const series = laySeries("re-render-freeze");
    const volumeDir = series.volumes[0].dir;
    fs.writeFileSync(path.join(volumeDir, "glossary.md"), GLOSSARY_01, "utf8");
    const before = sha(path.join(volumeDir, "glossary.md"));

    /**
     * Ask the gate the way the command asks it, and catch what it says.
     * @param {Object} [opts] @returns {Promise<{threw: boolean, verdict?: Object, message?: string, lines: string[]}>}
     */
    async function askGate(opts = {}) {
      const lines = [];
      try {
        const verdict = await assertDoorAllowed({
          door: "glossary",
          seriesDir: series.dir,
          cancelledBy: "apply",
          detail: "re-rendering this volume's glossary out of its own reference record",
          log: (line) => lines.push(String(line)),
          ...opts,
        });
        return { threw: false, verdict, lines };
      } catch (error) {
        return { threw: true, message: String(error.message || error), lines };
      }
    }

    // (a) Nothing published on top of the glossary: the gate lets the act through.
    const openPass = await askGate({ volumeArg: 1 });
    ok(!openPass.threw, "with no translation standing, the gate lets the re-render through");
    ok(openPass.verdict.ok, "and its own verdict says so");
    ok(!openPass.verdict.undeclaredCancellation, "and `--apply` is a cancellation this gate already knows, not one the caller invented");

    // (b) A published translation in that volume's folder: the gate refuses, structurally.
    fs.writeFileSync(path.join(volumeDir, "translation.md"), "# Перевод\n\nЗамок на холме.\n", "utf8");
    fs.writeFileSync(path.join(volumeDir, "translation-state.json"), JSON.stringify({ chapters: {} }), "utf8");
    const frozen = await askGate({ volumeArg: 1 });
    ok(frozen.threw, "and once a translation stands on top of the glossary, the gate refuses");
    ok(/refuses to rewrite 1 volume/.test(frozen.message), "the refusal names how many volumes it is protecting");
    ok(/release-translation\.js --volume=01 --door=glossary/.test(frozen.message), "and names the recorded act that is the only way past");
    // The door names the release door in its own prose (a refusal that does not name the way out is a
    // dead end), so the scan is of code lines only — the same rule scenario 5 uses for the flag words.
    const doorText = readModuleLayer(ROOT, "glossary/re-render.js");
    const releaseCalls = doorText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"))
      .filter((line) => /require\(["']\.\/+release-translation|recordTranslationRelease|grantFreezeRelease|releaseCovering/.test(line));
    same(releaseCalls, [], "while the door itself never reaches for that way past");
    same(sha(path.join(volumeDir, "glossary.md")), before, "and the refusal wrote nothing");

    // (c) A rehearsal is not a rewrite, so the gate reports instead of refusing — which is what lets
    // `--apply` be the only word that has to pass it.
    const rehearsal = await askGate({ volumeArg: 1, dryRun: true });
    ok(!rehearsal.threw, "a rehearsal is not refused");
    ok(rehearsal.verdict.reported, "but it is reported, with the same frozen volume named");
    ok(rehearsal.lines.some((line) => /DRY RUN/.test(line)), "in the run's own log");
    same(sha(path.join(volumeDir, "glossary.md")), before, "and a rehearsal writes nothing either");

    // (d) Asking for the whole series is asked of the gate as one act, not slipped past volume by volume.
    const whole = await askGate({});
    ok(whole.threw, "and a series-wide ask is refused too");
    ok(/release-translation\.js --volume=01/.test(whole.message), "naming every frozen volume it would rewrite");

    console.log("  12 freeze doors, 0 new ones; 1 pass with nothing published, 1 refusal that writes nothing, 1 rehearsal that reports, 1 series-wide refusal");
  }

  console.log(`\nOK: ${checks} checks on re-rendering a published glossary from its own record, and on the labels it writes.`);
})();

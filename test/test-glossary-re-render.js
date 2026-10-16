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
 *  11. **the freeze gate is asked, and it bites** — the door uses the `glossary` door that already exists,
 *      a published translation stops `--apply`, and a rehearsal only reports.
 *  12. **the `Readings` column is a gate too** (plan 09 slice 3b) — a render that drops a guide, drops the
 *      whole column, or prints a guide its own record does not hold is refused; a render that only **adds**
 *      guides the record holds is the one change the door exists to make, and it is allowed. The comparison
 *      is three-way — the file, the render, and the record — and the limit of asking only two is named.
 *  13. **the round trip with the guides filled** — render → parse → file → render is byte-identical with a
 *      two-guide cell in place, no guide leaks into the term, the rendering or the Notes, and a record that
 *      files no written forms is refused rather than allowed to empty the column.
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
  GLOSSARY_READING_COLUMN,
  GLOSSARY_NO_READING_CELL,
  openReferenceStore,
  openDatabase,
  renderGlossary,
  renderReadingCell,
  readingsFromCell,
  glossaryReadingCellsForRows,
  parseGlossaryMarkdown,
  importGlossary,
  fileVolumeWrittenForms,
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
  `|${GLOSSARY_HEADER.map(() => "---").join("|")}|`,
  "| Замок | The Castle |  | The building on the hill; the whole prologue happens in it. |",
  "| Зеркало | The Mirror |  | The one in the castle, old and dark. |",
  "| Призрак | The Ghost |  | A figure this volume's book never actually prints. |",
  "",
  "## Characters",
  "",
  `| ${GLOSSARY_HEADER.join(" | ")} |`,
  `|${GLOSSARY_HEADER.map(() => "---").join("|")}|`,
  "| Она | She |  | The narrator of the prologue. |",
  "",
].join("\n");

/**
 * The fixture's own pronunciation-guide harvest: what volume 1's book printed over its own words.
 *
 * Cyrillic written forms, Latin readings — which is what lets the store's row guard (a guided reading
 * shares **no character** with the written form) be exercised rather than skipped, and keeps the fixture
 * in no language the old column headings named. `Замок` is guided two ways so the multi-guide cell shape,
 * and the count that separates a habitual guide from a one-off, are both in the fixture.
 */
const HARVEST_01 = {
  volume: 1,
  guides: [
    { word: "Замок", reading: "zamok", count: 7, readingScript: "latin", chapters: ["ch0"] },
    { word: "Замок", reading: "krepost", count: 2, readingScript: "latin", chapters: ["ch0"] },
    { word: "Зеркало", reading: "zerkalo", count: 3, readingScript: "latin", chapters: ["ch0"] },
  ],
};

/** The cell the record says `Замок`'s `Readings` column holds: most-guided first, each with its count. */
const ZAMOK_CELL = "zamok ×7; krepost ×2";

/**
 * The same document with the `Readings` column taken out.
 *
 * Two shapes need this, and they are not the same event: the real corpus today (every published glossary
 * predates the column), and a renderer that stopped asking the record. Both produce a three-column table,
 * and the gate has to tell them apart from a document that never had a fourth column at all.
 *
 * @param {string} markdown @returns {string}
 */
function withoutReadingColumn(markdown) {
  return String(markdown)
    .split("\n")
    .map((line) => {
      if (!line.startsWith("|")) return line;
      const parts = line.split("|").map((cell) => cell.trim());
      if (parts.length > 0 && parts[0] === "") parts.shift();
      if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
      if (parts.length < 4) return line;
      if (parts.every((cell) => /^:?-{2,}:?$/.test(cell))) return "|---|---|---|";
      const kept = [parts[0], parts[1], ...parts.slice(3)];
      return `| ${kept.join(" | ")} |`;
    })
    .join("\n");
}

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

/**
 * Which files in a list **call** the re-render door, by the call shape, on code lines only.
 *
 * Parameterised on the file list so the same scan can be run against a tree with a caller planted in it:
 * a caller pin that has never been seen to fail is a sentence rather than a guard.
 *
 * @param {string[]} files - Absolute paths.
 * @param {Set<string>} allowed - Paths (relative to ROOT) that ARE the door and are not callers of it.
 * @param {RegExp} pattern - The call shapes.
 * @returns {string[]} Matching paths relative to ROOT, sorted.
 */
function findDoorCallers(files, allowed, pattern) {
  const callers = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (allowed.has(rel)) continue;
    // Only code lines. A module that says "the re-render gate asks the same question" in a doc comment is
    // not a caller, and a scan that counts prose reports a pipeline full of callers that do not exist.
    const code = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !(trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"));
      })
      .join("\n");
    if (pattern.test(code)) callers.push(rel);
  }
  return callers.sort();
}

// ─── 1. the labels ────────────────────────────────────────────────────────────

{
  console.log("1. the glossary labels are the owner's wording, and they name no language");

  same(
    GLOSSARY_HEADER,
    ["Original", "Translated", "Readings", "Notes"],
    "the one constant the owner's wording names, plus the fourth column plan 09 slice 3b added"
  );
  const named = GLOSSARY_HEADER.filter((label) => OLD_HEAD_ASSERTIONS.includes(label));
  same(named, [], "and no column is named after a language any more");
  ok(GLOSSARY_HEADER.every((label) => label === label.trim() && label.length > 0), "every header is a usable cell");
  // The fourth label is checked by the same rule that caught the old pair, in this file rather than by
  // trusting the scan to be run elsewhere: a column named for one language's speech is the defect.
  same(
    GLOSSARY_HEADER.filter((label) => /japanese|english|korean|chinese|pronunciation|polite|formal/i.test(label)),
    [],
    "and `Readings` is not a language's name either — it says what the cell holds, which is the guides this book printed"
  );
  same(GLOSSARY_HEADER.indexOf("Notes"), 3, "the free-text column stays last: it carries the `Earlier rendering:` history line");
  same(GLOSSARY_READING_COLUMN, GLOSSARY_HEADER.indexOf("Readings"), "and the renderer's column index is the header's own position, not a second number");

  // One door writes it.
  const renderLayer = readModuleLayer(ROOT, "utils/reference-store/glossary-adapter/render.js");
  const labelUsers = readModuleLayer(ROOT, "utils/reference-store/glossary-adapter/labels.js");
  ok(renderLayer.includes("GLOSSARY_HEADER.join(\" | \")"), "the renderer is the door that writes the header line");
  ok(!labelUsers.includes("GLOSSARY_HEADER.join"), "the constant's own file does not also write it");

  // The three readers drop the header by POSITION: the same table under either heading parses the same.
  const oldShape = ["## Places", "", "| Japanese | English | Notes |", "|---|---|---|", "| Замок | The Castle | a row |", "| Зеркало | The Mirror | another |", ""].join("\n");
  const threeCol = oldShape.replace("| Japanese | English | Notes |", "| Original | Translated | Notes |");
  // The shape the renderer writes now: the same two rows, with an empty cell where the guides go.
  const fourCol = oldShape
    .replace("| Japanese | English | Notes |", `| ${GLOSSARY_HEADER.join(" | ")} |`)
    .replace("|---|---|---|", `|${GLOSSARY_HEADER.map(() => "---").join("|")}|`)
    .replace("| Замок | The Castle | a row |", "| Замок | The Castle |  | a row |")
    .replace("| Зеркало | The Mirror | another |", "| Зеркало | The Mirror |  | another |");
  const fourColFilled = fourCol
    .replace("| Замок | The Castle |  | a row |", "| Замок | The Castle | замок ×7 | a row |")
    .replace("| Зеркало | The Mirror |  | another |", "| Зеркало | The Mirror | зеркало ×3 | another |");

  const storeReader = (text) => parseGlossaryMarkdown(text).rows.map((row) => [row.term, row.rendering, row.notes, row.section]);
  const carryForwardReader = (text) => parseGlossaryTableTerms(text).map((row) => [row.term, row.rendering, row.notes, row.section]);
  const stageReader = (text) => parseGlossaryTerms(text).map((row) => [row.term, row.rendering, row.section]);
  const newShape = fourCol;
  same(storeReader(newShape), storeReader(oldShape), "reader 1 (parseGlossaryMarkdown) drops the header by position");
  same(carryForwardReader(newShape), carryForwardReader(oldShape), "reader 2 (parseGlossaryTableTerms / glossaryTermSpans) drops it by position");
  same(stageReader(newShape), stageReader(oldShape), "reader 3 (parseGlossaryTerms, the translator's reader) drops it by position");
  same(stageReader(newShape).length, 2, "and none of the three reads a header row as a term");

  // A three-column file — every glossary this repository published before this change, and the whole real
  // corpus today — still reads exactly as it did. That is what "the column count comes from the table" is
  // for: a reader told the new shape is four columns would put the Notes in the reading column.
  same(storeReader(threeCol), storeReader(oldShape), "reader 1 reads a three-column table exactly as it always did");
  same(carryForwardReader(threeCol), carryForwardReader(oldShape), "so does reader 2");
  same(stageReader(threeCol), stageReader(oldShape), "so does reader 3");

  // And the guide stays in its own column: the term, the rendering and the notes of a filled row are the
  // same four values they are when the cell is empty.
  const filledStore = parseGlossaryMarkdown(fourColFilled).rows;
  const filledCarry = parseGlossaryTableTerms(fourColFilled);
  const filledStage = parseGlossaryTerms(fourColFilled);
  same(storeReader(fourColFilled), storeReader(fourCol), "a filled reading cell moves no other cell, in reader 1");
  same(carryForwardReader(fourColFilled), carryForwardReader(fourCol), "nor in reader 2 — the Notes cell is what the carry-forward gate reads as rename evidence, and a guide is not that");
  same(filledStage.map((row) => row.rendering), ["The Castle", "The Mirror"], "and reader 3 never takes a guide for a rendering");
  same(filledStore.map((row) => row.reading), ["замок ×7", "зеркало ×3"], "reader 1 reads the guide as its own column");
  same(filledCarry.map((row) => row.reading), ["замок ×7", "зеркало ×3"], "and so does reader 2");
  same(parseGlossaryMarkdown(fourCol).rows.map((row) => row.reading), ["", ""], "a three-cell-in-a-four-column table is not guessed at: the empty cell is empty");

  console.log("  GLOSSARY_HEADER = Original | Translated | Readings | Notes; 3 readers, 0 of them matching on the words, and a 3-column file still reads as a 3-column file");
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
    `|${GLOSSARY_HEADER.map(() => "---").join("|")}|`,
    "| Зазамокмок | The Castle |  | A row written against the text the OLD converter produced. |",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(volumeDir, "glossary.md"), splitFile, "utf8");

  const forms = door.guideSplitFormsOfHarvest(harvest.guides);
  ok(forms.has("Зазамокмок"), "the harvest's own sequence rebuilds the split string");

  const diff = door.compareGlossaryRender({
    onDisk: splitFile,
    rendered: "# Glossary — Render Proof\n\n## Places\n\n" + `| ${GLOSSARY_HEADER.join(" | ")} |\n|${GLOSSARY_HEADER.map(() => "---").join("|")}|\n| Замок | The Castle |  | the guide-free word |\n\n`,
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

    const ghostRow = "| Призрак | The Ghost |  | A figure this volume's book never actually prints. |";
    const losingRender = GLOSSARY_01.replace(`${ghostRow}\n`, "");
    const comparison = door.compareGlossaryRender({ onDisk: GLOSSARY_01, rendered: losingRender, volumeDir, volume: 1 });
    const refused = await door.publishGlossaryRender({ volumeDir, markdown: losingRender, comparison, artifactPresent: true, moveAside: true });
    ok(!refused.ok, "a render that drops a row is refused");
    same(refused.refusal.rule, "glossary-render-would-lose-rows", "and the refusal has a name");
    ok(refused.refusal.because.includes("Призрак"), "and names the row it would have dropped");
    ok(fs.existsSync(path.join(volumeDir, "glossary.md")), "the published file is still there");
    ok(!fs.existsSync(path.join(volumeDir, "glossary.md.rejected")), "and nothing was moved aside by a refusal");

    const added = `${GLOSSARY_01}\n## Bridges\n\n| ${GLOSSARY_HEADER.join(" | ")} |\n|${GLOSSARY_HEADER.map(() => "---").join("|")}|\n| Мост | The Bridge |  | a row the published file does not hold |\n`;
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
    // The third text the gate compares, taken from the same store the render came from.
    const expected = glossaryReadingCellsForRows(store, { volume: 1 });
    store.close();
    same(expected.ok, true, "the record can be asked what its reading column holds");
    same(expected.totals.rows, 3, "it answers for the 3 rows this record publishes (the refused row is not one)");
    same(expected.totals.rowsFilled, 0, "and fills none of them: this fixture files no written-form rows");
    same(expected.totals.rowsEmpty, 3, "so every row prints the empty marker, and the marker is counted rather than invisible");
    same(expected.totals.tablePresent, true, "and the report says the table is there, which is what separates \"no guides\" from \"no table\"");

    const comparison = door.compareGlossaryRender({ onDisk: GLOSSARY_01, rendered, volumeDir, volume: 1 });
    ok(comparison.lostRows.length === 1, "this render WOULD lose the row the record refused");
    const refusedPublish = await door.publishGlossaryRender({ volumeDir, markdown: rendered, comparison, artifactPresent: true, moveAside: true });
    ok(!refusedPublish.ok && refusedPublish.refusal.rule === "glossary-render-would-lose-rows", "so the door refuses it rather than publishing a smaller glossary");

    // ── The two shapes a re-render now has to answer, both of them real. ────────────────────────
    const headerLine = `| ${GLOSSARY_HEADER.join(" | ")} |`;
    const separatorLine = `|${GLOSSARY_HEADER.map(() => "---").join("|")}|`;

    // (a) A header-only rename is still provably lossless, and the guard for it still fires. The words in
    //     the header change; every cell of every row stands.
    const renamedHeader = rendered.split(headerLine).join("| Original | Translated | Guides | Notes |");
    const renameComparison = door.compareGlossaryRender({ onDisk: renamedHeader, rendered, volumeDir, volume: 1 });
    ok(renameComparison.onlyHeaderLinesDiffer, "a header-only rename is provably lossless: every other line is byte-identical");
    same(renameComparison.lostRows, [], "0 rows lost");
    same(renameComparison.gainedRows, [], "0 rows added");
    same(renameComparison.changedRows, [], "0 cells rewritten");
    same(renameComparison.readingChanges, [], "and the reading column reports nothing, because both files print the same guides");
    same(door.withoutTableHeaders(renamedHeader), door.withoutTableHeaders(rendered), "and the proof is the text with the headers taken out: identical");

    // (b) The case the real corpus is in: the published file is a THREE-column render of this same record,
    //     and the render is four. This is not a header-only change — the separator line and every data row
    //     gain a cell — so `onlyHeaderLinesDiffer` is false and the row-level gate is what carries the
    //     proof. It has to say: no row lost, no row added, no rendering/note/section moved, no guide
    //     invented, no guide lost.
    const publishedThreeColumns = rendered
      .split(headerLine).join("| Original | Translated | Notes |")
      .split(separatorLine).join("|---|---|---|")
      .split(` | ${GLOSSARY_NO_READING_CELL} | `).join(" | ");
    fs.writeFileSync(path.join(volumeDir, "glossary.md"), publishedThreeColumns, "utf8");
    const legacyComparison = door.compareGlossaryRender({
      onDisk: publishedThreeColumns,
      rendered,
      volumeDir,
      volume: 1,
      expectedReadingCells: expected.cells,
    });
    ok(!legacyComparison.onlyHeaderLinesDiffer, "adding a column is not a rename, and the lossless-by-headers proof does not cover it");
    ok(legacyComparison.readingColumnOnDisk === false, "the published file declares three columns");
    ok(legacyComparison.readingColumnRendered === true, "and the render declares four — the column is a fact about the table's header, not about whether any cell is filled");
    same(legacyComparison.readingChanges, [], "and the column still reports no change: an absent column and a column of empty markers are the same answer");
    same(legacyComparison.lostRows, [], "0 rows lost");
    same(legacyComparison.gainedRows, [], "0 rows added");
    same(legacyComparison.changedRows, [], "0 rendering, note or section cells moved — the guide did not ride into the Notes cell");

    const wrote = await door.publishGlossaryRender({ volumeDir, markdown: rendered, comparison: legacyComparison, artifactPresent: true, moveAside: true });
    ok(wrote.ok, "and the door publishes that one");
    ok(fs.existsSync(path.join(volumeDir, "glossary.md")), "the new glossary stands");
    const kept = path.join(volumeDir, "glossary.md.rejected");
    ok(fs.existsSync(kept), "and the file it replaced is kept beside it");
    same(fs.readFileSync(kept, "utf8"), publishedThreeColumns, "byte-for-byte the file that was there");

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

    console.log("  glossary.md.rejected kept beside glossary.md → LOW; beside nothing → HIGH; 1 refusal, 1 publish; and the two shapes a re-render answers: a header-only rename, and a 3-column file gaining a 4th column");
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
    same(Object.keys(FINDING_LEVELS).length, 72, "the level table stays at its 72 kinds — this door added none");
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
    const callers = findDoorCallers(files, allowed, DOOR_NAMES);
    same(callers, [], "no stage, no step, no prompt and no other module calls the door");

    // The scan is proven by running it against a tree with a caller planted in it. A pin nobody has seen
    // fail is a sentence, and this one just had its matching rule narrowed — which is exactly when a pin
    // needs to be seen firing.
    const plantedDir = path.join(FIXTURES_ROOT, "re-render-planted-caller");
    fs.rmSync(plantedDir, { recursive: true, force: true });
    fs.mkdirSync(plantedDir, { recursive: true });
    fs.writeFileSync(
      path.join(plantedDir, "planted-stage.js"),
      "// glossary/re-render is mentioned here in prose only, and must not be reported.\n" +
        'const door = require("../glossary/re-render");\n' +
        "function run(store) { return door.publishGlossaryRender({ volumeDir: store, markdown: '', comparison: null, artifactPresent: false }); }\n" +
        "module.exports = { run };\n",
      "utf8"
    );
    const planted = findDoorCallers([...files, path.join(plantedDir, "planted-stage.js")], allowed, DOOR_NAMES);
    same(planted.length, callers.length + 1, "and the scan fires: a stage that requires the door is named beside the real tree");
    ok(planted.some((rel) => rel.endsWith("planted-stage.js")), "by its own path");
    fs.rmSync(plantedDir, { recursive: true, force: true });

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

    console.log(`  schema 13, 13 migrations, 72 finding kinds, 12 freeze doors, 0 row writes, 0 model reach, 0 callers outside the door (${files.length} files scanned)`);
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

  // ─── 12. the reading column is a gate too (plan 09 slice 3b) ─────────────────
  {
    console.log("12. a render that invents a guide, or drops one, is refused; one that only adds guides the record holds is not");

    const series = laySeries("re-render-readings");
    const volumeDir = series.volumes[0].dir;
    const store = openFixtureStore(series, "re-render-readings", 1);
    importGlossary(store, GLOSSARY_01);
    const filed = fileVolumeWrittenForms(store, { volume: 1, harvests: [HARVEST_01] });
    same(filed.rowsFiled, 3, "the fixture's three written forms are filed through the store's own door");

    const filled = renderGlossary(store, { volume: 1, title: fixtureTitle("01") });
    const expected = glossaryReadingCellsForRows(store, { volume: 1 });
    ok(expected.ok, "and the record can be asked what its reading column holds");
    same(expected.totals.rows, 3, "it answers for the 3 rows the record publishes");
    same(expected.totals.rowsFilled, 2, "filling two of them");
    same(expected.totals.rowsEmpty, 1, "and marking the third as holding no guide");
    same(expected.totals.rowsWithSeveralReadings, 1, "one of them guided two ways");
    ok(filled.includes(`| Замок | The Castle | ${ZAMOK_CELL} |`), "and the render prints that cell: most-guided first, each with its count");
    ok(filled.includes("| Зеркало | The Mirror | zerkalo |"), "while a single guide prints bare, with no count");
    ok(filled.includes(`| Она | She | ${GLOSSARY_NO_READING_CELL} |`), "and a term with no guide says the RECORD holds none, not that the author guided nothing");

    // (a) A render that drops ONE of the two guides the record holds.
    const dropped = filled.replace(`| Замок | The Castle | ${ZAMOK_CELL} |`, "| Замок | The Castle | zamok |");
    const droppedComparison = door.compareGlossaryRender({
      onDisk: filled, rendered: dropped, volumeDir, volume: 1, expectedReadingCells: expected.cells,
    });
    same(droppedComparison.readingChanges.length, 1, "the comparison sees exactly one row's readings change");
    same(droppedComparison.readingChanges[0].kind, "lost", "and calls it lost");
    same(droppedComparison.readingChanges[0].lost, ["krepost"], "naming the guide that would vanish");
    const refusedDropped = await door.publishGlossaryRender({ volumeDir, markdown: dropped, comparison: droppedComparison, artifactPresent: false, moveAside: true });
    ok(!refusedDropped.ok, "and the door refuses it");
    same(refusedDropped.refusal.rule, "glossary-render-loses-readings", "by name");
    ok(refusedDropped.refusal.because.includes("krepost"), "naming the guide rather than only counting the rows");

    // (b) A render that drops the WHOLE column from a file that prints it — the shape a regression takes,
    //     and the shape every glossary in the real corpus is in until this column is published.
    const columnGone = withoutReadingColumn(filled);
    ok(!columnGone.includes("Readings"), "the rewritten file names no reading column");
    const goneComparison = door.compareGlossaryRender({
      onDisk: filled, rendered: columnGone, volumeDir, volume: 1, expectedReadingCells: expected.cells,
    });
    ok(goneComparison.readingColumnOnDisk, "the published file declares four columns");
    ok(!goneComparison.readingColumnRendered, "and the render declares three");
    same(goneComparison.lostRows, [], "no ROW is lost — the three rows are still there");
    same(goneComparison.changedRows, [], "and no rendering, note or section cell moved: the guide did not ride into the Notes");
    same(goneComparison.readingChangesByKind.lost, 2, "but 2 rows lose the guides the published file prints");
    const refusedGone = await door.publishGlossaryRender({ volumeDir, markdown: columnGone, comparison: goneComparison, artifactPresent: false, moveAside: true });
    ok(!refusedGone.ok, "so that render is refused too");
    same(refusedGone.refusal.rule, "glossary-render-loses-readings", "under the same name a single dropped guide gets");

    // (c) A render that prints a guide the record does NOT hold.
    const invented = filled.replace("| Зеркало | The Mirror | zerkalo |", "| Зеркало | The Mirror | zerkalo; стекло |");
    const inventedComparison = door.compareGlossaryRender({
      onDisk: filled, rendered: invented, volumeDir, volume: 1, expectedReadingCells: expected.cells,
    });
    same(inventedComparison.changedRows, [], "the other cells are untouched, so this is the column's own refusal");
    same(inventedComparison.readingChanges.length, 1, "one row's readings change");
    same(inventedComparison.readingChanges[0].kind, "invented", "and the comparison calls it invented");
    same(inventedComparison.readingChanges[0].invented, ["стекло"], "naming the guide no book of this series ever printed");
    const refusedInvented = await door.publishGlossaryRender({ volumeDir, markdown: invented, comparison: inventedComparison, artifactPresent: false, moveAside: true });
    ok(!refusedInvented.ok, "and the door refuses it");
    same(refusedInvented.refusal.rule, "glossary-render-invents-readings", "by name");
    ok(/worse than no reading column/.test(refusedInvented.refusal.because), "and says why a column that can lie is worse than no column");

    // (d) The one answer that is NOT refused: a guide the record holds and the published file lacks. That
    //     is the entire content of the change this column exists to make, and refusing it would mean no
    //     published glossary could ever gain a guide without re-deriving its volume from its book.
    fs.writeFileSync(path.join(volumeDir, "glossary.md"), columnGone, "utf8");
    const adding = door.compareGlossaryRender({
      onDisk: columnGone, rendered: filled, volumeDir, volume: 1, expectedReadingCells: expected.cells,
    });
    same(adding.readingChangesByKind.added, 2, "2 rows gain a guide the record already holds");
    same(adding.readingChangesByKind.invented, undefined, "and none of them is invented");
    same(adding.readingChangesByKind.lost, undefined, "and none of them loses one");
    same(adding.lostRows, [], "0 rows lost");
    same(adding.gainedRows, [], "0 rows gained");
    same(adding.changedRows, [], "0 rendering, note or section cells moved");
    const wroteAdding = await door.publishGlossaryRender({ volumeDir, markdown: filled, comparison: adding, artifactPresent: true, moveAside: true });
    ok(wroteAdding.ok, "so the door publishes it");
    same(fs.readFileSync(path.join(volumeDir, "glossary.md"), "utf8"), filled, "and what stands is the render, guides and all");
    ok(fs.existsSync(path.join(volumeDir, "glossary.md.rejected")), "with the three-column file it replaced kept beside it");

    // (e) The named limit: without the record asked, the `invented` answer cannot be given, and the result
    //     says that instead of reporting a clean comparison.
    const notAsked = door.compareGlossaryRender({ onDisk: filled, rendered: invented, volumeDir, volume: 1 });
    ok(!notAsked.readingsAsked, "the comparison says it did not ask the record");
    same(notAsked.readingChanges[0].kind, "added", "so a guide the record does not hold reads as an addition — the honest limit of a two-text comparison");
    same(notAsked.readingChanges[0].expected, null, "and the row records that the third text was absent");

    store.close();
    console.log("  3 refusals (a guide dropped, the column dropped, a guide invented), 1 allowed change (a guide the record holds), 1 named limit; 0 rows lost in the allowed one");
  }

  // ─── 13. the round trip, with the readings actually filled ───────────────────
  {
    console.log("13. render → parse → file → render, with guides in the column and none of them leaking");

    const series = laySeries("re-render-readings-round-trip");
    const volumeDir = series.volumes[0].dir;
    const store = openFixtureStore(series, "re-render-readings-round-trip", 1);
    importGlossary(store, GLOSSARY_01);
    fileVolumeWrittenForms(store, { volume: 1, harvests: [HARVEST_01] });
    const first = renderGlossary(store, { volume: 1, title: fixtureTitle("01") });
    ok(first.includes(ZAMOK_CELL), "the first render carries the two-guide cell");

    // Parse it back. The acceptance line: a reading never comes back as a term, part of a term, or part
    // of the notes.
    const parsed = parseGlossaryMarkdown(first);
    const byTerm = new Map(parsed.rows.map((row) => [row.term, row]));
    same(byTerm.get("Замок").reading, ZAMOK_CELL, "the guide cell is read as its own column");
    same(byTerm.get("Замок").term, "Замок", "and the term is the word, not the word plus its guide");
    same(byTerm.get("Замок").rendering, "The Castle", "and the rendering is the rendering");
    same(
      byTerm.get("Замок").notes,
      "The building on the hill; the whole prologue happens in it.",
      "and the Notes cell is the notes, unchanged — the guide did not ride into it"
    );
    same(readingsFromCell(byTerm.get("Замок").reading).map((entry) => entry.reading), ["zamok", "krepost"], "the cell reads back into the two guides, in the order the column printed them");
    same(readingsFromCell(byTerm.get("Замок").reading).map((entry) => entry.occurrences), [7, 2], "each with the count the record gave it");
    same(readingsFromCell(byTerm.get("Зеркало").reading), [{ reading: "zerkalo", occurrences: 0 }], "a bare cell reads back as one guide with no count");
    same(readingsFromCell(byTerm.get("Она").reading), [], "and the empty marker reads back as no guides, which is the honest answer");
    same(parsed.annotatedRows, [], "0 rows carry pronunciation MARKUP — the column is text, not tags");
    same(parsed.shortRows, [], "and 0 rows are short for the width their own table declares");

    // File the parsed document into a SECOND record carrying the same written-form rows, and render that.
    const second = laySeries("re-render-readings-round-trip-b");
    const store2 = openFixtureStore(second, "re-render-readings-round-trip-b", 1);
    const reimported = importGlossary(store2, first);
    same(reimported.refused.length, 0, "re-importing the render refuses nothing: the row the book never printed is not in it");
    fileVolumeWrittenForms(store2, { volume: 1, harvests: [HARVEST_01] });
    const again = renderGlossary(store2, { volume: 1, title: fixtureTitle("01") });
    same(again, first, "render → parse → file → render is byte-identical WITH the guides in place");

    // And the gate calls that pair clean.
    const diff = door.compareGlossaryRender({
      onDisk: first, rendered: again, volumeDir, volume: 1,
      expectedReadingCells: glossaryReadingCellsForRows(store, { volume: 1 }).cells,
    });
    ok(diff.identical, "identical");
    same(diff.readingChanges, [], "0 reading changes");
    ok(diff.readingColumnOnDisk && diff.readingColumnRendered, "both declare the column");

    // The negative half, which is the half that matters: a record that files NO written forms renders the
    // same three rows with the empty marker. Row by row that is a clean re-render, and the gate calls it a
    // loss instead of publishing a glossary whose guides silently emptied.
    const third = laySeries("re-render-readings-round-trip-c");
    const store3 = openFixtureStore(third, "re-render-readings-round-trip-c", 1);
    importGlossary(store3, first);
    const emptied = renderGlossary(store3, { volume: 1, title: fixtureTitle("01") });
    const emptiedComparison = door.compareGlossaryRender({
      onDisk: first, rendered: emptied, volumeDir, volume: 1,
      expectedReadingCells: glossaryReadingCellsForRows(store3, { volume: 1 }).cells,
    });
    same(emptiedComparison.lostRows, [], "no row is lost — the same three rows");
    same(emptiedComparison.changedRows, [], "no rendering or note moved");
    same(emptiedComparison.readingChangesByKind.lost, 2, "but 2 rows lose the guides the published file prints");
    const refusedEmptied = await door.publishGlossaryRender({
      volumeDir, markdown: emptied, comparison: emptiedComparison, artifactPresent: false, moveAside: true,
    });
    ok(!refusedEmptied.ok, "and that render is refused");
    same(refusedEmptied.refusal.rule, "glossary-render-loses-readings", "under the same name a dropped guide gets");

    store.close();
    store2.close();
    store3.close();
    console.log(`  ${parsed.rows.length} rows survive render → parse → file → render byte-for-byte WITH guides; 0 leak into term / rendering / notes; 1 emptied render refused`);
  }
  console.log(`\nOK: ${checks} checks on re-rendering a published glossary from its own record, and on the labels it writes.`);
})();

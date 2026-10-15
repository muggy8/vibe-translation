#!/usr/bin/env node
/**
 * test/test-cast-reconciliation.js — the closing cast reconciliation: three buckets over the settled
 * reference record, 0 model calls, and the per-book guard it takes a decision away from is now a NOTE.
 *
 * Plan 06 slice 9. The acceptance lines it has to meet:
 *
 *   1. **The three buckets are a query, not a judgement.** Every name on the roster lands in exactly one
 *      bucket, and every input to the split is a row the store already wrote (`cast`, `cast_presence`,
 *      `facts`). No model is asked whether a character matters (plan 06 §9).
 *   2. **The middle bucket is a named absence.** A name the roster holds and the book never puts on a page
 *      is printed and filed nowhere: no finding, no pause, no row.
 *   3. **The third bucket splits by the owner's rule.** Interchangeable ones are recorded and the run
 *      continues; ones the story keeps get a dossier built from what the record already measures.
 *   4. **The demotion is real end to end.** `reference-voice-mention-not-covered` no longer halts a walk
 *      through the actual volume-boundary gate, and `reference-voice-covers-fewer-characters` still does.
 *   5. **The half of the rule that could not be run is in the output**, not in a comment.
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

const { assertInsideFixture } = require("./fixture-reference-store");
const { readModuleLayer } = require("./module-layer");
const rs = require("../utils/reference-store");
const { FINDING_LEVELS, levelFor } = require("../utils/postmortem/levels");
const { MANIFEST_SCHEMA } = require("../intake/config");
const { walkVolumes } = require("../utils/series-run/loop");
const { reportVolumeFindings } = require("../utils/series-run/findings");
const { resolveSourceBundle } = require("../utils/source");
const { finding } = require("../utils/postmortem");
const { readVolumeHalt } = require("../utils/postmortem/halt");
const { classifyFindings } = require("../utils/resume");

const {
  openReferenceStore,
  copyForwardStore,
  openDatabase,
  parseVoiceMarkdown,
  REFERENCE_STORE_FILE_NAME,
} = rs;

const {
  reconcileCastRun,
  recurrenceSplits,
  castBuckets,
  classifyFungibility,
  rosterVolumesHeld,
  reconciliationRecordPaths,
  renderReconciliationLog,
  NOT_FUNGIBLE_MIN_VOLUMES,
  SPEAKER_TEST_NOT_RUN,
  BLIND_SPOT,
  RECONCILIATION_JSON_FILE,
  RECONCILIATION_MD_FILE,
  RECONCILIATION_RECORD_SCHEMA,
  RECONCILIATION_MAX_NAMES_LISTED,
} = require("../character-voice/reconcile");

const FIXTURES_ROOT = "/tmp/opencode/series-fixtures";

/** The finding this slice demoted, and the one that still stops a run. */
const DEMOTED_KIND = "reference-voice-mention-not-covered";
const STILL_STOPPING_KIND = "reference-voice-covers-fewer-characters";

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

// ─── The fixture: three books, four names on the roster ───────────────────────

/**
 * The cast, and what each name is there to exercise.
 *
 * All four are put on the roster in volume 1, so every one of them is carried into volumes 2 and 3 by
 * copy-forward — which is the point: the plan's measure counts that carrying, the shipped rule counts the
 * text, and the two only disagree when a name is on the roster for a long time and on the page once.
 */
const CAST = {
  /** On the roster, on the page in all three books, and something is recorded about how she speaks → bucket 1. */
  VOICED: "Marina",
  /** On the roster, on the page in two books, nothing recorded → bucket 3, not interchangeable → investigated. */
  INVESTIGATED: "Renata",
  /** On the roster in all three records, on the page in exactly one book → bucket 3, interchangeable → recorded. */
  RECORDED: "Camarero",
  /** On the roster, on the page in no book at all → bucket 2, the named absence. */
  ABSENT: "Ezequiel",
};

/** Volume 1's source. Every quoted line the fixture cites is one of these. */
const BOOK_01 = {
  ch0: [
    "# Capítulo 1",
    "Marina entró en el aula sin golpear.",
    "Usted está equivocado, señor director —Marina no bajó la voz.",
    "Renata cerró la puerta sin decir nada.",
    "El señor Camarero cobró la entrada y no levantó la vista.",
  ],
  ch1: [
    "# Capítulo 2",
    "Marina volvió al aula al día siguiente.",
    "Renata esperaba en el pasillo, callada.",
  ],
};

/** Volume 2's source: the same two names, and nobody else from the roster. */
const BOOK_02 = {
  ch0: [
    "# Capítulo 3",
    "Marina entró en la oficina sin golpear.",
    "Renata cerró la puerta sin decir nada, también allí.",
  ],
};

/** Volume 3's source: only the protagonist is left on a page. */
const BOOK_03 = {
  ch0: [
    "# Capítulo 4",
    "Marina cerró el expediente y se fue.",
  ],
};

const BOOKS = [
  { installmentNumber: "01", folder: "Cast Story(01)", base: "cast_story(1)", lines: BOOK_01 },
  { installmentNumber: "02", folder: "Cast Story(02)", base: "cast_story(2)", lines: BOOK_02 },
  { installmentNumber: "03", folder: "Cast Story(03)", base: "cast_story(3)", lines: BOOK_03 },
];

/** The claim volume 1 files — the only thing the fixture records about how anybody speaks. */
const MARINA_CLAIM = {
  key: CAST.VOICED,
  aspect: "register",
  label: "Formality level",
  body: "Answers a superior with the formal second person and never softens it.",
};

/**
 * The 1-based line a chapter file's reader will report for a quote.
 *
 * Computed from the fixture's own lines rather than written by hand, so a scenario cannot pass because the
 * test author counted the heading wrong.
 *
 * @param {string[]} lines - The chapter's lines, in file order.
 * @param {string} needle - The quote to cite.
 * @returns {number} 1-based line number.
 */
function lineOf(lines, needle) {
  const index = lines.findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `the fixture cites a line it does not print: ${needle}`);
  return index + 1;
}

/**
 * Three books, one plan of record, laid out the way the extraction lays a volume out.
 *
 * Spanish-shaped on purpose, like the slice-3 through slice-7 suites: a rule proved only against fixtures
 * written next to the language the code happened to be written in proves the design for that language and
 * nothing else. This fixture declares **no** register block, because that is the state this corpus is in
 * (plan 06 §2.11) and the reconciliation has to work there.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @returns {{dir: string, volumes: Array<{folder: string, base: string, installmentNumber: string, dir: string, lines: Object<string, string[]>}>}}
 */
function laySeries(label) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  for (const volume of BOOKS) {
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
    seriesName: "Cast Story",
    sourceLanguage: "Spanish",
    targetLanguage: "English",
    generator: "test/test-cast-reconciliation.js",
    generatedAt: new Date().toISOString(),
    discovery: {
      summary: "fixture: three books, continuous prose, headed chapters",
      confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
      evidence: ["fixture"],
      excluded: [],
    },
    volumes: BOOKS.map((volume) => ({
      folder: volume.folder,
      sourceFile: `${volume.folder}/${volume.base}.epub`,
      installmentNumber: volume.installmentNumber,
      title: "Cast Story",
      integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose in headed sections" },
    })),
  };
  fs.writeFileSync(path.join(dir, "translation-target.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return { dir, volumes: BOOKS.map((volume) => ({ ...volume, dir: path.join(dir, volume.folder) })) };
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
 * The state every scenario starts from: three volumes, each with its cast registered, its chapters
 * registered, its presence measured from its own text, and its record sealed and carried forward.
 *
 * Presence is measured per volume because that is what the reconciliation asks about, and it is measured
 * by the store's own door (`recordCastPresence`) rather than by rows the test inserts — a fixture that
 * hand-wrote its own presence rows would prove the query against a shape the pipeline never produces.
 *
 * @param {string} label
 * @param {{fileClaim?: boolean, measurePresence?: boolean, seal?: boolean}} [opts]
 * @returns {{series: Object, records: Array<{folder: string, file: string, volume: number}>}}
 */
function buildSeries(label, { fileClaim = true, measurePresence = true, seal = true } = {}) {
  const series = laySeries(label);
  /** @type {Array<{folder: string, file: string, volume: number}>} */
  const records = [];

  for (let i = 0; i < series.volumes.length; i++) {
    const volume = i + 1;
    const book = series.volumes[i];
    const store = openFixtureStore(series, volume, book.folder, volume === 1 ? "rebuild" : "merge");
    store.registerChaptersFromSource();

    if (volume === 1) {
      for (const key of Object.values(CAST)) {
        const upserted = store.upsertCast({ key, display: key, firstSeenVolume: 1 });
        assert.ok(upserted.ok, `the fixture roster entry ${key} was refused: ${upserted.refusal && upserted.refusal.because}`);
      }
      if (fileClaim) {
        const inserted = store.insertFact({
          ...MARINA_CLAIM,
          cast: { display: CAST.VOICED },
          evidence: [{ volume: 1, chapter: "ch0", line: lineOf(BOOK_01.ch0, "Usted está equivocado"), quote: "Usted está equivocado, señor director" }],
        });
        assert.ok(inserted.ok, `the fixture claim was refused: ${inserted.refusal && inserted.refusal.because}`);
      }
    }

    if (measurePresence) {
      const measured = store.recordCastPresence();
      assert.ok(measured.ok, `presence was not measurable in volume ${volume}: ${measured.refusal && measured.refusal.because}`);
    }

    records.push({ folder: book.folder, file: store.file, volume });
    if (seal) store.sealVolume(volume);
    store.close();

    if (i + 1 < series.volumes.length) {
      const copy = copyForwardStore({
        fromVolume: volume,
        toVolume: volume + 1,
        seriesDir: series.dir,
        fromFolder: book.folder,
        toFolder: series.volumes[i + 1].folder,
      });
      assert.ok(copy.ok, `the record did not carry forward: ${JSON.stringify(copy.refusal)}`);
      copy.closeDest();
    }
  }

  return { series, records };
}

/**
 * Run the reconciliation over a fixture series, with the records folder pinned inside that fixture.
 *
 * `POSTMORTEM_DIR` is cleared for the call rather than pointed at the fixture: clearing it is what makes
 * the pass resolve its own default (`<series>/.run/postmortem`), and the assertion after the call is what
 * proves it landed inside the fixture and not next to the books `.env` names (gotcha 69).
 *
 * @param {{dir: string}} series @param {Object} [opts] - Passed through to `reconcileCastRun`.
 * @returns {Promise<{result: Object, markdown: string, json: Object, paths: Object}>}
 */
async function runReconciliation(series, opts = {}) {
  const saved = process.env.POSTMORTEM_DIR;
  delete process.env.POSTMORTEM_DIR;
  try {
    const result = await reconcileCastRun({ seriesDir: series.dir, dryRun: false, ...opts });
    const paths = reconciliationRecordPaths(series.dir);
    assertInsideFixture(paths.markdown, series.dir);
    assertInsideFixture(paths.json, series.dir);
    return {
      result,
      paths,
      markdown: fs.readFileSync(paths.markdown, "utf8"),
      json: JSON.parse(fs.readFileSync(paths.json, "utf8")),
    };
  } finally {
    if (saved === undefined) delete process.env.POSTMORTEM_DIR;
    else process.env.POSTMORTEM_DIR = saved;
  }
}

/**
 * Every table of a record, as one digest, read through a read-only handle.
 *
 * Read-only because of gotcha 124: opening a corpus record with a write-capable client folds its write-ahead
 * log in and deletes the sidecars in the folder it was read from. The reconciliation must leave the record
 * it read exactly as it found it, and this is how that is measured.
 *
 * @param {string} file
 * @returns {Object<string, string>}
 */
function recordDigest(file) {
  let db = null;
  try {
    db = openDatabase(file, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    /** @type {Object<string, string>} */
    const out = {};
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
      out[table] = crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    }
    return out;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* a read handle that will not close has nothing to lose */
      }
    }
  }
}

/**
 * The files sitting in one folder, sorted — so "nothing else was written" is a comparison, not a hope.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function filesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

// ─── 1. The three buckets, on one fixture that has all three ──────────────────

async function main() {
console.log("\n=== 1. the three buckets ===");

const bucketsFixture = buildSeries("reconcile-buckets");
const bucketsRun = await runReconciliation(bucketsFixture.series);

{
  const { json, result } = bucketsRun;
  const buckets = castBucketsOf(json);

  same(json.counts.roster, 4, "the settled record's roster is the four names the fixture put on it");
  same(json.counts.voiced, 1, "one name has something recorded about how they speak");
  same(json.counts.neverSeen, 1, "one name the roster holds never appears in any volume's text");
  same(json.counts.onPageUnrecorded, 2, "two names are on a page in a book that said nothing about them");

  same(buckets.voiced.map((row) => row.key), [CAST.VOICED], "bucket 1 is the character with a recorded claim");
  same(buckets.neverSeen.map((row) => row.key), [CAST.ABSENT], "bucket 2 is the name the book never prints");
  same(buckets.onPageUnrecorded.map((row) => row.key).sort(), [CAST.INVESTIGATED, CAST.RECORDED].sort(), "bucket 3 is the two names on a page with nothing recorded");

  const all = [...buckets.voiced, ...buckets.neverSeen, ...buckets.onPageUnrecorded].map((row) => row.key).sort();
  same(all, Object.values(CAST).sort(), "every roster entry lands in exactly one bucket, and none lands in two");

  same(buckets.voiced[0].volumesPresent, [1, 2, 3], "the voiced character is measured present in all three books");
  same(buckets.neverSeen[0].volumesPresent, [], "the absent character is measured present nowhere");
  same(buckets.neverSeen[0].recordedClaims, 0, "and nothing is recorded about them either, which is what makes it the absence bucket and not the voiced one");

  same(json.counts.volumes, [1, 2, 3], "the volumes the reconciliation reports are the ones the record registers");
  same(json.counts.volumesMeasured, [1, 2, 3], "and every one of them has a presence measurement");
  same(json.counts.volumesUnmeasured, [], "so there is no volume whose presence nobody searched");
  ok(result.ran === true && result.skipped === null, "the pass ran");
  ok(result.summary.modelCalls === undefined || result.summary.modelCalls === 0, "and it asked nothing of a model");
  console.log(`  1. ${json.counts.roster} roster entries → ${json.counts.voiced} voiced / ${json.counts.neverSeen} never seen / ${json.counts.onPageUnrecorded} on the page with nothing recorded`);
}

/**
 * The JSON record's buckets, with the markdown's own counts checked against them.
 *
 * @param {Object} json - The written `cast-reconciliation.json`.
 * @returns {{voiced: Array<Object>, neverSeen: Array<Object>, onPageUnrecorded: Array<Object>}}
 */
function castBucketsOf(json) {
  for (const name of ["voiced", "neverSeen", "onPageUnrecorded"]) {
    assert.ok(Array.isArray(json.buckets[name]), `the JSON record carries a ${name} bucket`);
  }
  same(json.buckets.voiced.length, json.counts.voiced, "the JSON's voiced list matches its own count");
  same(json.buckets.neverSeen.length, json.counts.neverSeen, "the JSON's never-seen list matches its own count");
  same(json.buckets.onPageUnrecorded.length, json.counts.onPageUnrecorded, "the JSON's on-page list matches its own count");
  return json.buckets;
}

// ─── 2. The middle bucket is a named absence, and nothing else ────────────────

console.log("\n=== 2. the named absence is named, not filed ===");

{
  const before = recordDigest(bucketsFixture.records[2].file);
  const volumeDirFiles = filesIn(bucketsFixture.records[2].folder && path.join(bucketsFixture.series.dir, bucketsFixture.records[2].folder));
  const runDir = reconciliationRecordPaths(bucketsFixture.series.dir).dir;
  const findingsDirBefore = filesIn(path.join(runDir, "step-findings"));

  ok(bucketsRun.markdown.includes("named absence"), "the markdown calls bucket 2 a named absence in its own words");
  ok(bucketsRun.markdown.includes(CAST.ABSENT), "and it prints the name");
  ok(bucketsRun.json.buckets.neverSeen[0].recordedClaims === 0, "the entry carries no claims, because there are none");

  const after = recordDigest(bucketsFixture.records[2].file);
  same(after, before, "the settled record is identical in every table after the reconciliation read it");

  const volumeDirFilesAfter = filesIn(path.join(bucketsFixture.series.dir, bucketsFixture.records[2].folder));
  same(volumeDirFilesAfter, volumeDirFiles, "and it wrote nothing into the volume folder it read the record from");

  const findingsDirAfter = filesIn(path.join(runDir, "step-findings"));
  same(findingsDirAfter, findingsDirBefore, "it filed no finding: the finding channel holds exactly what it held before");

  same(filesIn(runDir), [RECONCILIATION_JSON_FILE, RECONCILIATION_MD_FILE].sort(), "the whole of what it wrote is its two record files");

  ok(!bucketsRun.markdown.includes("HIGH"), "the named absence is not reported as a HIGH");
  ok(!/MAJOR/.test(bucketsRun.markdown.split("## 2.")[1].split("## 3.")[0]), "nor as a MAJOR, in the section that names it");
  console.log(`  2. ${CAST.ABSENT} is printed as a named absence; 0 findings filed, 0 rows written, the record byte-for-byte unchanged`);
}

// ─── 3. The third bucket splits, and the investigated one gets a dossier ──────

console.log("\n=== 3. interchangeable is recorded, the story keeps its own ===");

{
  const json = bucketsRun.json;
  const investigated = json.buckets.onPageUnrecorded.filter((row) => row.fungible === false);
  const recorded = json.buckets.onPageUnrecorded.filter((row) => row.fungible === true);

  same(investigated.map((row) => row.key), [CAST.INVESTIGATED], "the name printed in two books is the one investigated");
  same(recorded.map((row) => row.key), [CAST.RECORDED], "the name printed in one book is the one recorded and carried on");
  same(investigated[0].volumesSeen, 2, "and the number that decided it is the number of books the store found the name in");
  same(recorded[0].volumesSeen, 1, "against the line, which is 2");
  same(NOT_FUNGIBLE_MIN_VOLUMES, 2, "the line is a constant, and it is 2");

  const dossier = bucketsRun.markdown.split(`### ${CAST.INVESTIGATED}`)[1] || "";
  ok(dossier.length > 0, "the investigated name gets its own section in the log");
  ok(dossier.includes("the book prints the name in 2 volume(s)"), "the dossier says where the book prints them");
  ok(dossier.includes("volume 1 (2 chapter(s)"), "chapter by chapter, with the store's own counts");
  ok(/by (verbatim|skeleton)/.test(dossier), "and names which matching rule proved each hit");
  ok(dossier.includes("the extraction pass filed 0 claim(s)"), "it says what the extraction filed instead — here, nothing");
  ok(dossier.includes("why this one is investigated"), "and it says which signal decided it");

  ok(bucketsRun.markdown.includes(`### Recorded and carried on (1)`), "the interchangeable half is its own section");
  ok(bucketsRun.markdown.includes(CAST.RECORDED), "and it names that character too — recorded is not hidden");

  same(json.modelCalls, 0, "the whole split cost 0 model calls");
  console.log(`  3. ${investigated.length} investigated / ${recorded.length} recorded, decided by presence in ${json.counts.volumesMeasured.length} measured volumes, 0 model calls`);
}

// ─── 3b. The print bound is a print bound, and the remainder is named ─────────

console.log("\n=== 3b. a long list is capped in the log, never in the answer ===");

{
  /**
   * A synthetic bucket row: the shape `buckets.js` produces, built here so the bound can be exercised
   * without building 45 characters into a reference record.
   *
   * @param {number} index
   * @returns {Object}
   */
  const syntheticRow = (index) => ({
    key: `name-${index}`,
    display: `Name ${index}`,
    firstSeenVolume: 1,
    recordedClaims: 0,
    extractionClaims: 0,
    volumesPresent: [1, 2],
    volumesMeasured: [1, 2],
    chaptersTotal: 4,
    perVolume: [
      { volume: 1, chapters: 2, matches: 3, rules: ["verbatim"] },
      { volume: 2, chapters: 2, matches: 3, rules: ["verbatim"] },
    ],
    identityKeys: [`name-${index}`],
    decision: {
      fungible: false,
      volumesSeen: 2,
      volumesSeenList: [1, 2],
      volumesMeasured: 2,
      rosterVolumesHeld: 2,
      because: "the book prints this name in 2 volumes (1, 2), at or above the 2-volume line",
      decidedBy: "presence",
    },
  });

  const many = Array.from({ length: RECONCILIATION_MAX_NAMES_LISTED + 5 }, (_unused, index) => syntheticRow(index));
  const header = {
    settled: { folder: "/fixture/volume(02)", volume: 2, file: "/fixture/volume(02)/series.db" },
    buckets: { voiced: [], neverSeen: many.map((row) => ({ ...row, volumesPresent: [] })), onPageUnrecorded: many },
    counts: { roster: many.length, mergedEntries: 0, voiced: 0, neverSeen: many.length, onPageUnrecorded: many.length, volumes: [1, 2], volumesMeasured: [1, 2], volumesUnmeasured: [] },
    splits: { rosterAge: { recurring: many.length, single: 0 }, presence: { recurring: many.length, single: 0, neverPresent: 0 }, disagreement: 0 },
    folders: null,
    volumeByFolder: null,
  };
  const log = renderReconciliationLog(header);

  ok(log.includes(`## 2. Named, and never seen (${many.length})`), "the section heading still states the whole count");
  same((log.match(/^- Name /gm) || []).length, RECONCILIATION_MAX_NAMES_LISTED, "and spells out only the bound's worth of names");
  ok(log.includes(`_… 5 more named in \`cast-reconciliation.json\` and not spelled out here._`), "naming the remainder and where it is kept");
  ok(log.includes(`### Investigated — not interchangeable (${many.length})`), "the investigated heading states the whole count too");
  same((log.match(/^### Name /gm) || []).length, RECONCILIATION_MAX_NAMES_LISTED, "and its dossiers are capped at the same bound");
  ok(log.includes("_… 5 more investigated, each with its own dossier in `cast-reconciliation.json` and not spelled out here._"), "with the remainder named, not dropped");
  console.log(`  3b. ${many.length} names → ${RECONCILIATION_MAX_NAMES_LISTED} spelled out, 5 named by count, every total printed`);
}

// ─── 4. The demotion, end to end through the real volume-boundary gate ────────

console.log("\n=== 4. the demoted guard no longer halts a walk, and the one that stops still does ===");

/**
 * A three-volume fixture whose character-voice outputs are all present and correctly shaped, so the only
 * finding the assessment can raise is the planted one.
 *
 * @param {string} label
 * @returns {{seriesDir: string, folders: string[], byFolder: Map<string, Object>, manifest: Object}}
 */
function layWalkFixture(label) {
  const seriesDir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(seriesDir, { recursive: true, force: true });
  fs.mkdirSync(seriesDir, { recursive: true });
  const folders = ["Cast Walk(01)", "Cast Walk(02)", "Cast Walk(03)"];
  const entries = folders.map((folder, i) => {
    const volumeDir = path.join(seriesDir, folder);
    fs.mkdirSync(volumeDir, { recursive: true });
    const sourceName = `${folder}.md`;
    fs.writeFileSync(path.join(volumeDir, sourceName), `# Capítulo ${i + 1}\n\nTexto de la prueba para ${folder}.\n`, "utf8");
    fs.writeFileSync(
      path.join(volumeDir, "character-voice.md"),
      "# Character voice\n\n## Voice\n\n### Somebody\n\n- **Notes**: A planted fixture line about a character.\n",
      "utf8"
    );
    fs.writeFileSync(path.join(volumeDir, "pov-map.md"), "# POV map\n\n## Chapters\n\n### ch0\n\n- Somebody — close.\n", "utf8");
    fs.writeFileSync(
      path.join(volumeDir, "character-voice-validation.md"),
      "# Character Voice Validation\n\n## Findings\n\n**Recommendation:** Pass\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(volumeDir, "character-voice-validation-rolling-state.json"),
      JSON.stringify({ results: [90, 90] }),
      "utf8"
    );
    return {
      folder,
      sourceFile: `${folder}/${sourceName}`,
      installmentNumber: String(i + 1).padStart(2, "0"),
      title: folder,
      integrity: { isNarrative: true, confidence: 0.9, basis: "test fixture" },
    };
  });
  const manifest = {
    schema: 2,
    seriesName: "Cast Walk",
    seriesLocation: seriesDir,
    sourceLanguage: "Spanish",
    targetLanguage: "English",
    discovery: { summary: "fixture", confidence: 0.9, evidence: [], excluded: [] },
    volumes: entries,
  };
  fs.writeFileSync(path.join(seriesDir, "translation-target.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { seriesDir, folders, byFolder: new Map(entries.map((entry) => [entry.folder, entry])), manifest };
}

/**
 * Plant one finding in one volume through the door the stage actually uses, then walk the three volumes
 * through the real shared loop with the gate pointed at `character-voice`.
 *
 * @param {string} label @param {string} kind @param {string} severity
 * @returns {Promise<{processed: string[], assessed: Array<{folder: string, findings: Array<Object>}>, error: Error|null, halt: Object|null, routed: Object}>}
 */
async function walkWithPlantedFinding(label, kind, severity) {
  const savedRunDir = process.env.RUN_DIR;
  const fx = layWalkFixture(label);
  process.env.RUN_DIR = path.join(fx.seriesDir, ".run");
  try {
    const volumeEntry = fx.byFolder.get("Cast Walk(02)");
    const volumeDir = path.join(fx.seriesDir, volumeEntry.folder);
    const bundle = await resolveSourceBundle({ seriesDir: fx.seriesDir, volume: volumeEntry, volumeDir });
    const planted = finding(
      severity,
      kind,
      "character-voice",
      volumeEntry.installmentNumber,
      REFERENCE_STORE_FILE_NAME,
      `fixture: 1 character(s) on the roster have no character-voice claim in this volume's text: ${CAST.RECORDED}`
    );
    const reported = await reportVolumeFindings({ step: "character-voice", volumeEntry, volumeDir, bundle, findings: [planted], dryRun: false });
    ok(reported.written === true, `the planted ${kind} reached the finding channel`);

    /** @type {string[]} */
    const processed = [];
    /** @type {Array<{folder: string, findings: Array<Object>}>} */
    const assessed = [];
    /** @type {Error|null} */
    let error = null;
    try {
      await walkVolumes({
        volumes: fx.folders,
        volumeByFolder: fx.byFolder,
        step: "character-voice",
        seriesDir: fx.seriesDir,
        processVolume: async (folderName) => {
          processed.push(folderName);
        },
        onVolumeAssessed: (folderName, report) => {
          assessed.push({ folder: folderName, findings: report.findings });
        },
      });
    } catch (err) {
      error = err;
    }
    const halt = readVolumeHalt("character-voice");
    return {
      processed,
      assessed,
      error,
      halt,
      routed: classifyFindings(assessed.flatMap((entry) => entry.findings)),
    };
  } finally {
    if (savedRunDir === undefined) delete process.env.RUN_DIR;
    else process.env.RUN_DIR = savedRunDir;
  }
}

{
  same(levelFor(DEMOTED_KIND), "NOTE", `the level table calls ${DEMOTED_KIND} a NOTE`);
  same(levelFor(STILL_STOPPING_KIND), "MAJOR", `${STILL_STOPPING_KIND} is still a MAJOR, untouched`);

  const demoted = await walkWithPlantedFinding("reconcile-walk-note", DEMOTED_KIND, "MEDIUM");
  same(demoted.processed, ["Cast Walk(01)", "Cast Walk(02)", "Cast Walk(03)"], "the walk reaches every volume: the demoted guard stops nothing");
  ok(demoted.error === null, `and the step does not fail: ${demoted.error && demoted.error.message}`);
  ok(demoted.halt === null, "no halt record is written");

  const named = demoted.assessed.flatMap((entry) => entry.findings).filter((entry) => entry.kind === DEMOTED_KIND);
  ok(named.length > 0, "the finding is still named in the assessment — a NOTE is a report, not a deletion");
  ok(named.every((entry) => entry.level === "NOTE"), "and it is named at its level");
  const routed = demoted.routed;
  ok(!routed.damage.some((entry) => entry.kind === DEMOTED_KIND), "the resume triage does not route it as damage");
  ok(routed.notes.some((entry) => entry.kind === DEMOTED_KIND), "it routes it as a note");

  const control = await walkWithPlantedFinding("reconcile-walk-major", STILL_STOPPING_KIND, "HIGH");
  same(control.processed, ["Cast Walk(01)", "Cast Walk(02)"], "the guard that still stops halts the same fixture after volume 02");
  ok(control.error !== null && control.error.name === "VolumeHaltError", `and it fails structurally: ${control.error && control.error.name}`);
  ok(control.halt !== null, "with a halt record");
  same(control.halt.unattemptedVolumes, ["03"], "naming the volume nobody paid for");
  ok(control.halt.trigger.some((trigger) => trigger.kind === STILL_STOPPING_KIND && trigger.level === "MAJOR"), "and naming what triggered it");
  ok(control.routed.damage.some((entry) => entry.kind === STILL_STOPPING_KIND), "the triage routes it as damage");
  console.log(`  4. ${DEMOTED_KIND}: 3/3 volumes, no halt, routed as a note — ${STILL_STOPPING_KIND}: 2/3 volumes, halted, routed as damage`);
}

// ─── 5. The half of the rule that could not be run is in the output ───────────

console.log("\n=== 5. the test that was not run is named in the file, not in a comment ===");

{
  ok(bucketsRun.markdown.includes(SPEAKER_TEST_NOT_RUN), "the markdown prints the not-run sentence verbatim");
  same(bucketsRun.json.speakerTestRun, false, "the JSON stores it as a false, not as an omission");
  same(bucketsRun.json.speakerTestNotRunBecause, SPEAKER_TEST_NOT_RUN, "and stores the sentence itself");
  ok(bucketsRun.json.speakerTestNotRunBecause.includes("was NOT run"), "the sentence says it was not run, in those words");
  ok(bucketsRun.markdown.includes("## What this pass could not test"), "in its own section");

  ok(bucketsRun.markdown.includes(BLIND_SPOT), "the accepted blind spot is printed too");
  same(bucketsRun.json.blindSpot, BLIND_SPOT, "and stored");
  ok(bucketsRun.markdown.includes("## The miss this rule cannot catch"), "under its own heading");
  ok(bucketsRun.markdown.includes("pivotal in exactly one volume"), "naming the miss it cannot catch");

  ok(bucketsRun.markdown.includes("0 model calls"), "the log says what it cost");
  console.log("  5. speaker half: speakerTestRun=false in the JSON, the sentence in the markdown, the blind spot beside it");
}

// ─── 6. The two recurrence measures, printed side by side ─────────────────────

console.log("\n=== 6. the plan's measure and the shipped measure, both printed ===");

{
  const splits = bucketsRun.json.splits;
  same(splits.rosterAge.recurring, 4, "by the plan's measure every fixture name is held by 2 or more volume records — the roster never drops an entry");
  same(splits.rosterAge.single, 0, "and none is single");
  same(splits.presence.recurring, 2, "by the shipped measure only two names are printed in 2 or more books");
  same(splits.presence.single, 1, "one is printed in exactly one");
  same(splits.presence.neverPresent, 1, "and one is never printed at all");
  same(splits.disagreement, 2, "so the two measures disagree for two names: the shop clerk the roster held for three volumes while the book printed it once, and the name the roster held while the book never printed it at all");

  const held = rosterVolumesHeld({ firstSeenVolume: 1 }, [1, 2, 3]);
  same(held, 3, "the plan's measure is the entry's age on a cumulative roster: 18 − first_seen_volume, here 3");

  ok(bucketsRun.markdown.includes("held by N volume records (plan §2.10's measure)"), "the log prints the plan's measure under its own name");
  ok(bucketsRun.markdown.includes("printed in N volumes' text (**the rule this pass used**)"), "and the shipped measure beside it, saying which one decided");
  ok(bucketsRun.markdown.includes("The two disagree for 2 name(s)"), "and prints the disagreement as a number");

  const recordedRow = bucketsRun.json.buckets.onPageUnrecorded.find((row) => row.key === CAST.RECORDED);
  ok(recordedRow.because.includes("the roster has held the entry for 3 volume(s)"), "the interchangeable name's own line says the roster held it longer than the book printed it");
  console.log(`  6. roster age ${splits.rosterAge.recurring}/${splits.rosterAge.single} vs presence ${splits.presence.recurring}/${splits.presence.single}/${splits.presence.neverPresent}, disagreeing for ${splits.disagreement}`);
}

// ─── 7. The refusals ──────────────────────────────────────────────────────────

console.log("\n=== 7. what it refuses, and what it writes when it refuses ===");

{
  // 7a. No record at all.
  const empty = laySeries("reconcile-refuse-no-record");
  let noRecord = null;
  try {
    await reconcileCastRun({ seriesDir: empty.dir, dryRun: false });
  } catch (err) {
    noRecord = err;
  }
  ok(noRecord !== null, "a series with no reference record is refused, not answered with an empty roster");
  ok(noRecord.structural === true, "structurally, so ON_TASK_ERROR=continue cannot walk past it");
  ok(/no volume folder under/.test(noRecord.message) || /could not be read/.test(noRecord.message), `and the refusal says what it looked for: ${noRecord.message.split("\n")[0]}`);
  same(filesIn(reconciliationRecordPaths(empty.dir).dir), [], "and it wrote nothing");

  // 7b. A record with a roster but no presence measurement.
  const unmeasured = buildSeries("reconcile-refuse-no-presence", { measurePresence: false });
  let noPresence = null;
  try {
    await reconcileCastRun({ seriesDir: unmeasured.series.dir, dryRun: false });
  } catch (err) {
    noPresence = err;
  }
  ok(noPresence !== null, "a record nobody measured presence for is refused too");
  ok(noPresence.structural === true, "structurally");
  ok(/no presence measurement for any volume/.test(noPresence.message), "naming the missing measurement, not the missing characters");
  ok(/every roster entry would land in "named and never seen"/.test(noPresence.message), "and saying why that would be a lie");
  same(filesIn(reconciliationRecordPaths(unmeasured.series.dir).dir), [], "and it wrote nothing");

  // 7c. --volume.
  const volumeSkipped = await reconcileCastRun({ seriesDir: bucketsFixture.series.dir, dryRun: false, volumeArg: "02" });
  same(volumeSkipped.skipped, "volume-arg", "--volume skips the pass: one volume's roster is not the series' roster");
  same(volumeSkipped.ran, false, "and it ran nothing");
  same(volumeSkipped.summary, null, "reporting no summary");
  same(volumeSkipped.written, null, "writing no files");

  // 7d. --dry-run.
  const drySkipped = await reconcileCastRun({ seriesDir: bucketsFixture.series.dir, dryRun: true });
  same(drySkipped.skipped, "dry-run", "--dry-run skips it, the way the settlement pass is skipped");
  same(drySkipped.ran, false, "and it ran nothing");
  same(drySkipped.written, null, "writing no files");

  // 7e. A walk that did not finish every volume.
  const partial = await reconcileCastRun({ seriesDir: bucketsFixture.series.dir, dryRun: false, unfinishedVolumes: ["Cast Story(02)"] });
  same(partial.skipped, "unfinished-volumes", "a run that left a volume broken does not reconcile a cast at all");
  same(partial.ran, false, "and it ran nothing");
  same(partial.written, null, "writing no files — the volume failure is the report, not this pass");

  // 7f. A handle that is not a record.
  let noHandle = null;
  try {
    castBuckets(null);
  } catch (err) {
    noHandle = err;
  }
  ok(noHandle !== null && noHandle.structural === true, "the query itself refuses a caller that handed it no record");
  ok(/handed no record to query/.test(noHandle.message), "and says the difference between an empty answer and nobody looking");

  // 7g. A handle that does not say which volume it is.
  let noVolume = null;
  const bareDb = openDatabase(bucketsFixture.records[2].file, { readOnly: true });
  try {
    castBuckets({ db: bareDb });
  } catch (err) {
    noVolume = err;
  } finally {
    bareDb.close();
  }
  ok(noVolume !== null && noVolume.structural === true, "a handle that does not say which volume it is gets refused rather than a roster read at no volume");
  ok(/does not say which volume it is/.test(noVolume.message), `and the refusal names the missing thing: ${noVolume.message.split("\n")[0]}`);

  console.log("  7. no record / no presence measurement / --volume / --dry-run / an unfinished walk / no handle / no volume number: 7 refusals and skips, 0 files written by any of them");
}

// ─── 8. Why nothing was written into character-voice.md ───────────────────────

console.log("\n=== 8. the published reference is left alone, and the reason is measurable ===");

{
  const HEAD = "# Character voice\n\n## Voice\n\n";
  const SECTION = "### Marina\n\n- **Formality level**: Answers a superior with the formal second person.\n";
  const LINE = "_Named in this record, never recorded: Camarero._\n";

  // Before the first bullet: the parser keeps it as the section's own prose, and the file round-trips.
  const beforeBullets = parseVoiceMarkdown(`${HEAD}${SECTION.replace("\n- ", `\n${LINE}- `)}`).characters;
  same(beforeBullets.length, 1, "the fixture reference parses back as one character section");
  same(beforeBullets[0].entries.length, 1, "placed before the first bullet, the claim is still one claim");
  same(beforeBullets[0].entries[0].body, "Answers a superior with the formal second person.", "with its body unchanged");
  ok(beforeBullets[0].lead.some((line) => line.includes(CAST.RECORDED)), "and the absence line survives as the section's own prose");

  // After the first bullet: the parser glues it onto the published claim's body, and nothing says so.
  const afterBullets = parseVoiceMarkdown(`${HEAD}${SECTION}\n${LINE}`).characters;
  same(afterBullets.length, 1, "the same file with the line under the bullets still parses as one section");
  same(afterBullets[0].entries.length, 1, "but it is not a line any more");
  ok(
    afterBullets[0].entries[0].body.includes("_Named in this record, never recorded: Camarero._"),
    `it is glued onto the published claim's body — gotcha 157, which is why this pass writes nothing into the artifact: "${afterBullets[0].entries[0].body}"`
  );
  ok(!afterBullets[0].lead.length, "and nothing in the parse announces the damage");

  ok(!bucketsRun.markdown.includes("character-voice.md written"), "the reconciliation's own log does not claim to have touched the artifact");
  const volumeDir = path.join(bucketsFixture.series.dir, bucketsFixture.records[2].folder);
  ok(!fs.existsSync(path.join(volumeDir, "character-voice.md")), "and on this fixture it had no artifact to touch, so none appeared");
  console.log("  8. the same line before the first bullet round-trips; after the first bullet it becomes part of a published claim's body");
}

// ─── 9. What this slice did not add ───────────────────────────────────────────

console.log("\n=== 9. what this slice did not add ===");

{
  const layer = readModuleLayer(path.join(__dirname, ".."), "character-voice/reconcile.js");

  // The level table is the only pinned count this slice moves, and it moves by one row, not by a kind.
  same(Object.keys(FINDING_LEVELS).length, 70, "the finding level table is still 70 kinds — no new kind was added");
  const levels = Object.values(FINDING_LEVELS).map((row) => row.level);
  const countOf = (level) => levels.filter((value) => value === level).length;
  same(countOf("STOP"), 18, "STOP 18");
  same(countOf("MAJOR"), 30, "MAJOR 30, one down from the demotion");
  same(countOf("MINOR"), 16, "MINOR 16");
  same(countOf("NOTE"), 6, "NOTE 6, one up from the demotion");
  same(countOf("STOP") + countOf("MAJOR") + countOf("MINOR") + countOf("NOTE"), 70, "and the four add back up to 70");

  // No new declared artifact, no new run expectation.
  const artifactLayer = readModuleLayer(path.join(__dirname, ".."), "utils/artifacts.js");
  ok(!artifactLayer.includes(RECONCILIATION_MD_FILE), `the reconciliation's files are not declared artifacts (${RECONCILIATION_MD_FILE} appears nowhere in utils/artifacts.js)`);
  ok(!artifactLayer.includes(RECONCILIATION_JSON_FILE), `nor its machine twin (${RECONCILIATION_JSON_FILE})`);

  // No new freeze door.
  const { FREEZE_DOORS } = require("../utils/prereqs/freeze");
  const doors = Object.keys(FREEZE_DOORS);
  same(doors.length, 12, "the freeze gate covers the same 12 doors it covered before this slice");
  ok(!doors.includes("cast-reconciliation"), "and this pass is not one of them");
  ok(!readModuleLayer(path.join(__dirname, ".."), "utils/prereqs/freeze.js").includes("cast-reconciliation"), "nor is it named anywhere in the freeze layer");

  // No environment knob anywhere in the new layer.
  ok(!layer.includes("process.env"), "the new layer reads no environment variable");
  ok(!/process\.env/.test(readModuleLayer(path.join(__dirname, ".."), "character-voice/reconcile/fungibility.js")), "including the file that owns the line");
  same(NOT_FUNGIBLE_MIN_VOLUMES, 2, "and the line it owns is a constant");

  // No identity tables, no model, no writes.
  for (const name of ["cast_identities", "cast_identity_links", "fileIdentityLinks", "identityCoverageSummary", "liveIdentitiesOf"]) {
    ok(!layer.includes(name), `the new layer never names ${name} — the identity tables stay isolated`);
  }
  ok(!/require\((["'])[^"']*harness/.test(layer), "the new layer never reaches the model: no harness require");
  ok(!/createAgentHandle\(|runOneShot\(/.test(layer), "and it opens no agent and makes no one-shot call");
  for (const verb of ["INSERT INTO", "UPDATE ", "DELETE FROM", "applySchema"]) {
    ok(!layer.includes(verb), `the new layer writes no SQL (${verb}) — it is a read over the record`);
  }

  // One call site, in the stage that owns the closing act.
  const callers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const text = fs.readFileSync(full, "utf8");
      if (text.includes("reconcileCastRun")) callers.push(path.relative(path.join(__dirname, ".."), full));
    }
  };
  walk(path.join(__dirname, ".."));
  same(callers.sort(), ["character-voice/reconcile.js", "character-voice/task.js", "test/test-cast-reconciliation.js"].sort(), "exactly one stage calls it, from character-voice/task.js");

  // No new command, no new setting.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  ok(!Object.keys(pkg.scripts || {}).some((name) => /reconcile/i.test(name)), "no new npm command was added");
  const envDoc = fs.readFileSync(path.join(__dirname, "..", "docs", "environment.md"), "utf8");
  ok(!/RECONCILE|NOT_FUNGIBLE/.test(envDoc), "and no new setting was added to the environment reference");

  // The record's own shape, pinned.
  same(bucketsRun.json.schema, RECONCILIATION_RECORD_SCHEMA, "the machine twin declares its schema");
  same(bucketsRun.json.limit.notFungibleMinVolumes, NOT_FUNGIBLE_MIN_VOLUMES, "and prints the bound it applied");
  same(bucketsRun.json.limit.maxNamesListed, RECONCILIATION_MAX_NAMES_LISTED, "and the print bound");
  console.log(`  9. 70 kinds (${countOf("STOP")}/${countOf("MAJOR")}/${countOf("MINOR")}/${countOf("NOTE")}), 0 new artifacts, 0 new doors, 0 new settings, 0 new commands, 1 call site, 0 SQL`);
}

// ─── 10. The split is a pure function over the record's own rows ──────────────

console.log("\n=== 10. the same record gives the same answer, twice ===");

{
  const second = await runReconciliation(bucketsFixture.series);
  const stripClocks = (json) => JSON.stringify({ ...json, writtenAt: null });
  same(stripClocks(second.json), stripClocks(bucketsRun.json), "a second pass over the same record produces the same buckets, counts and splits");
  same(second.markdown.replace(/[0-9]{2}:[0-9]{2}:[0-9]{2}/g, ""), bucketsRun.markdown.replace(/[0-9]{2}:[0-9]{2}:[0-9]{2}/g, ""), "and the same log");

  const splits = recurrenceSplits(
    [
      { key: "a", volumesOnRoster: 3, volumesPresent: [1] },
      { key: "b", volumesOnRoster: 3, volumesPresent: [1, 2] },
      { key: "c", volumesOnRoster: 1, volumesPresent: [] },
    ],
    [1, 2, 3]
  );
  same(splits.rosterAge, { recurring: 2, single: 1 }, "the age split counts the roster");
  same(splits.presence, { recurring: 1, single: 1, neverPresent: 1 }, "the presence split counts the text");
  same(splits.disagreement, 1, "and the disagreement is the name the two measures put in different halves");

  const decided = classifyFungibility({ key: "x", volumesPresent: [2, 3], volumesMeasured: [1, 2, 3], firstSeenVolume: 1 }, [1, 2, 3]);
  same(decided.fungible, false, "a name printed in two measured volumes is not interchangeable");
  same(decided.volumesSeenList, [2, 3], "and the log can name which volumes");
  same(decided.decidedBy, "presence", "saying which signal decided it");
  console.log("  10. a re-run over the same record writes the same answer; the split is a function over rows, not a fresh judgement");
}

console.log(`\ntest-cast-reconciliation: ${checks} checks, 0 model calls, 0 rows written to any record`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

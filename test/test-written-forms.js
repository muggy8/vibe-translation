#!/usr/bin/env node
/**
 * test/test-written-forms.js — a written form the book printed, filed as a fact.
 *
 * Plan 07 slice 1. Since gotcha 123 fixed the guide-split defect, every volume's extraction writes
 * `<base>-ruby-guides.json` beside its bundle — one row per (word, reading) pair the converter set aside,
 * 10,005 rows and 45,429 occurrences across the 17 real books — and **nothing read that file back** until
 * this slice. The interesting shape in it is one reading the author printed over two or more different
 * written forms: 虹彩寺菫, 三色院菫子, 好きな女 and 主人公 all guided パンジー. That is the author writing a
 * description and naming it in the reading, and no name-matching rule over the extracted text can find it,
 * because the converter stripped the reading out of the text entirely.
 *
 * What this suite pins:
 *
 *   1. **the migration.** A record written at schema 11 opens after this change, is brought to 12, keeps
 *      every row every other table had, and `written_forms` starts empty. A migration does not invent a
 *      written form nobody harvested.
 *   2. **the door files every row the two ROW guards keep — plan 07 §6.7, the account owner's answer.**
 *      15 harvest rows → **13 filed**, whatever group each one would or would not have joined, with the
 *      count and the chapters the harvest recorded. Both halves are pinned: a row that joins **no** group
 *      in this volume (大賀太陽 → サンちゃん, guided over one written form; 恐 / 遅 → おそ, a group whose
 *      forms are all one character — the shape that hides しば ← 芝 / 縛) is **filed**, and a row one of the
 *      two row guards refuses (言い訳 → いい, 替 → か) is **not**. The two report halves (the roster's
 *      answer, and the spelling-shape split) are computed over the **groups the fold derives**, not over
 *      what was filed, and they are unmoved by the widening.
 *   3. **a second pass files 0, and every content column is identical column by column** — not "nothing
 *      obviously changed".
 *   4. **it files no identity and touches no roster.** `cast`, `facts` and `cast_merges` come out
 *      byte-identical, and `cast_identities` / `cast_identity_links` stay at 0 rows even when a group is
 *      identity-bearing. The identity claim is plan 07 slice 2's, and this is the scenario that keeps it so.
 *   5. **the roster rule, four ways.** A form on the roster selects. The **reading** on the roster selects.
 *      A group whose **every** form is a roster entry selects — the half plan 06 §2.11 got wrong, pinned as
 *      a requirement rather than trusted. A group with neither is left out.
 *   6. **the 25 / 54 classifier.** The same-word-two-spellings shape fires; the different-words-that-sound-
 *      alike shape stays out of the variant list; the ratio is a subsequence over the **shorter** form, so
 *      美味 / 上手 is 0 of 2 and is left alone.
 *   7. **no forward look, asked twice** — the volume, and every harvest handed to the door. Each refusal
 *      files nothing. The widening does not soften this: a volume files its own rows and nothing else.
 *   8. **the group question is a query, not a column.** Two volumes that each saw one form of one reading
 *      describe the group only when the rows are read together, and `upToVolume` bounds how far the read may
 *      look. This is why the door is allowed to file judgement-free: the read is where a set is decided.
 *   9. **the point of the widening, end to end.** 芝 is planted in one fixture volume and 縛 in another —
 *      the exact shape of plan 07 §2.7's measured false negative. Neither volume's own harvest forms the
 *      group, so under the scope this slice first built **neither form would ever have been filed**; under
 *      the widened scope both are, and the group appears in `candidateGroupsInRecord` at the later volume
 *      and did not appear at the earlier one.
 *   10. **insert-only.** A duplicate row throws rather than overwriting; a damaged `chapters` cell is named
 *      rather than repaired.
 *   11. **what this slice did not add**: no finding kind, no setting, no command, no freeze door, no declared
 *      artifact, no verb on the store's handle, **no stage that calls the door**, and **nothing outside the
 *      layer that reads the table**. The one door outside the layer that asks the **grouping** question is
 *      pinned by name — `utils/reference-store/identity/file.js`, slice 2's — because a scan that expects
 *      zero callers after slice 2 wired one would be a scan that fails on correct code. And the cover's whole
 *      export list is compared against the store's barrel, because the barrel is a spread and a name a
 *      submodule forgets disappears from it silently (gotcha 151) — the widened door added one name,
 *      `eligibleWrittenFormRows`, and slice 2b's reports added 23 more.
 *
 * The two row guards the door applies are pinned in scenario 2 beside the two group guards the fold still
 * applies to its own report, and the two tallies are asserted to agree field for field — the door's guards
 * are the reader's constant and the reader's predicate, not a copy of them.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69). The real-corpus
 * numbers this shape is modelled on are measured by `test/measure-written-forms.js`.
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { readModuleLayer } = require("./module-layer");
const rs = require("../utils/reference-store");
const { importGlossary } = require("../utils/reference-store/glossary-adapter");
const { openDatabase } = require("../utils/reference-store/db");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { FREEZE_DOORS } = require("../utils/prereqs/freeze");
const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");
const { collectGuideGroups } = require("../utils/source/guide-groups");
const { RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");
const {
  SCHEMA_VERSION,
  MIGRATIONS,
  COUNTED_TABLES,
  readSchemaVersion,
  openReferenceStore,
  writtenFormAlreadyFiled,
  insertWrittenFormRow,
  writtenFormsInRecord,
  writtenFormCounts,
  candidateGroupsInRecord,
  parseChaptersCell,
  rosterKeysInRecord,
  fileVolumeWrittenForms,
  identityBearingGroups,
  splitGroupsByRoster,
  classifyUnselectedGroups,
  closestFormPairOf,
  longestCommonSubsequenceLength,
  SPELLING_VARIANT_MIN_RATIO,
} = rs;

const { fixtureStoreSeries, assertInsideFixture } = require("./fixture-reference-store");

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

// ─── The fixture ──────────────────────────────────────────────────────────────

/**
 * The glossary whose Characters rows are the roster this suite asks.
 *
 * パンジー and ツバキ are on the roster and are **not** printed by the fixture's book, which is the real
 * corpus's shape: the glossary registered the author's guided readings as entries of their own, and that is
 * what lets plan 07 §2.9's rule select a group by its **reading** (ツバキ ← 椿 / 特別な存在).
 */
const GLOSSARY = `# Glossary

_Starter glossary for the written-forms suite._

## Characters

| Japanese | English | Notes |
|---|---|---|
| 如月雨露 | Kisaragi Amatsuyu | Protagonist; the narrator |
| 三色院菫子 | Sanshokuin Sumireko | Library committee |
| パンジー | Pansy | The name the cast uses for her |
| 大賀太陽 | Oga Taiyo | Best friend since junior high |
| ツバキ | Camellia | Registered from the readings the book prints over her name |

## Terms

| Japanese | English | Notes |
|---|---|---|
| 会計担当 | The Accounting Person | The book says it plainly: 「山田は会計の人である。」 |
`;

/**
 * The harvest this suite writes into the fixture volume folder, in the shape
 * `utils/source/ruby-guides.js` writes it.
 *
 * Every guard `utils/source/guide-groups.js` carries has a planted row here, and each planted row is a shape
 * the real corpus contains: 三色院菫子 → パンジー is the rename, 偽物 / 偽者 is the 25-group shape, 美味 /
 * 上手 is the 54-group shape, 言い訳 → いい is the ordinary prose gotcha 128 says a pattern rule cannot tell
 * apart from a defect, and 恐 / 遅 → おそ is the single-character group that hides しば ← 芝.
 *
 * **The last four rows are the widened scope, planted.** 言い訳 → いい and 替 → か are refused by the two
 * ROW guards, so the door does not file them. 大賀太陽 → サンちゃん (one written form under that reading)
 * and 恐 / 遅 → おそ (a group whose forms are all one character) are refused only by the two GROUP guards,
 * so the door files all three of them and the fold still reports their groups as dropped. That is plan 07
 * §6.7 in fixture shape: filing keeps the row, grouping decides the set.
 */
const HARVEST = {
  schema: 2,
  whatThisIs: "fixture harvest for the written-forms suite",
  generatedBy: "test/test-written-forms.js",
  sourceFile: "test_story(1).epub",
  totals: { guides: 15, rows: 15 },
  guides: [
    { word: "三色院菫子", reading: "パンジー", count: 18, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "三色院菫子", reading: "パンジー" }] },
    { word: "好きな女", reading: "パンジー", count: 3, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "好きな女", reading: "パンジー" }] },

    { word: "椿", reading: "ツバキ", count: 5, readingScript: "katakana", chapters: ["ch0"], annotated: [{ base: "椿", reading: "ツバキ" }] },
    { word: "特別な存在", reading: "ツバキ", count: 2, readingScript: "katakana", chapters: ["ch2"], annotated: [{ base: "特別な存在", reading: "ツバキ" }] },

    { word: "如月雨露", reading: "主人公", count: 4, readingScript: "han", chapters: ["ch0"], annotated: [{ base: "如月雨露", reading: "主人公" }] },
    { word: "三色院菫子", reading: "主人公", count: 2, readingScript: "han", chapters: ["ch1"], annotated: [{ base: "三色院菫子", reading: "主人公" }] },

    { word: "偽物", reading: "にせもの", count: 11, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "偽物", reading: "にせもの" }] },
    { word: "偽者", reading: "にせもの", count: 10, readingScript: "hiragana", chapters: ["ch2"], annotated: [{ base: "偽者", reading: "にせもの" }] },

    { word: "美味", reading: "うま", count: 113, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "美味", reading: "うま" }] },
    { word: "上手", reading: "うま", count: 104, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "上手", reading: "うま" }] },

    // The four the guards throw away, one per guard.
    { word: "言い訳", reading: "いい", count: 7, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "言い訳", reading: "いい" }] },
    { word: "替", reading: "か", count: 9, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "替", reading: "か" }] },
    { word: "大賀太陽", reading: "サンちゃん", count: 6, readingScript: "katakana", chapters: ["ch0"], annotated: [{ base: "大賀太陽", reading: "サンちゃん" }] },
    { word: "恐", reading: "おそ", count: 3, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "恐", reading: "おそ" }] },
    { word: "遅", reading: "おそ", count: 2, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "遅", reading: "おそ" }] },
  ],
};

/**
 * A fixture volume 01 with the harvest written beside its source and the glossary imported into its record.
 *
 * @param {string} label
 * @param {{import?: boolean}} [opts]
 * @returns {{fx: Object, store: Object, seriesDir: string}}
 */
function openFixture(label, { import: doImport = true } = {}) {
  const fx = fixtureStoreSeries(`written-forms-${label}`);
  const seriesDir = fx.dir;
  fs.writeFileSync(path.join(fx.volumes[0].dir, `test_story(1)${RUBY_GUIDE_FILE_SUFFIX}`), JSON.stringify(HARVEST, null, 2) + "\n", "utf8");
  const store = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir, stage: "merge" });
  store.registerChaptersFromSource();
  assertInsideFixture(store.file, seriesDir);
  if (doImport) {
    const imported = importGlossary(store, GLOSSARY);
    ok(imported.castRegistered >= 5, `the fixture glossary should register its Characters rows as the roster: ${JSON.stringify(imported.refused)}`);
  }
  return { fx, store, seriesDir };
}

/**
 * Every counted table's row count, so "the migration moved nothing" is a comparison.
 * @param {Object} db @returns {Object<string, number>}
 */
function tableCounts(db) {
  /** @type {Object<string, number>} */
  const out = {};
  for (const table of COUNTED_TABLES) out[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return out;
}

/**
 * The roster and claim tables as one digest, so "no identity was filed and no name moved" is a check.
 * @param {Object} store @returns {{cast: string, facts: string, merges: number, identities: number, links: number}}
 */
function rosterDigest(store) {
  return {
    cast: JSON.stringify(store.db.prepare("SELECT * FROM cast ORDER BY key").all()),
    facts: JSON.stringify(store.db.prepare("SELECT * FROM facts ORDER BY id").all()),
    merges: store.db.prepare("SELECT COUNT(*) n FROM cast_merges").get().n,
    identities: store.db.prepare("SELECT COUNT(*) n FROM cast_identities").get().n,
    links: store.db.prepare("SELECT COUNT(*) n FROM cast_identity_links").get().n,
  };
}

/**
 * The filed rows without their timestamps, so a second pass can be compared column by column.
 * @param {Object} store @returns {Array<Object>}
 */
function filedRowsWithoutStamps(store) {
  return writtenFormsInRecord(store).map((row) => ({
    volume: row.volume,
    form: row.form,
    reading: row.reading,
    readingScript: row.readingScript,
    occurrences: row.occurrences,
    chapters: row.chapters,
  }));
}

/**
 * One candidate group out of a planted list of written forms, built by the shipped fold so the pure
 * scenarios ask the same shape the door produces.
 *
 * @param {string} reading @param {Array<[string, number]>} forms
 * @returns {Object|null} The group, or null when the guards drop it.
 */
function plantedGroup(reading, forms) {
  const built = collectGuideGroups(
    [{ volume: 1, guides: forms.map(([form, count]) => ({ word: form, reading, count, readingScript: "hiragana", chapters: ["ch0"] })) }],
    { displaySubset: false }
  );
  return built.groups.find((group) => group.reading === reading) || null;
}

// ─── 1. the migration: a record at schema 11 opens after this change ──────────

/** Scenario 1. @returns {Promise<void>} */
async function scenarioMigration() {
  const { store, seriesDir } = openFixture("migration", { import: false });
  const file = path.join(seriesDir, "Test Story(01)", "series.db");
  try {
    same(SCHEMA_VERSION, 12, "this build writes schema 12");
    same(MIGRATIONS.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "the migrations are a list, oldest first, and each one is appended rather than an older one edited");
    const written = MIGRATIONS.find((m) => m.version === 12);
    ok(written && /written form/i.test(written.name), `the written-forms migration is appended, not folded into an older one: ${written && written.name}`);
    ok(written.up.join("\n").includes("CREATE TABLE IF NOT EXISTS written_forms"), "it creates its own table");
    ok(!written.up.some((statement) => /ALTER TABLE/.test(statement)), "and it adds no column to any existing table: a written form is a new fact, not a change to an old one");
    ok(COUNTED_TABLES.includes("written_forms"), "the table is counted, so copy-forward compares it and a top-up carries it");
    ok(written.up.join("\n").includes("PRIMARY KEY (volume, form, reading)"), "the key is (volume, form, reading): a written form is dated by the book that printed it");
    ok(!/updated_at|status|row_version|identity/i.test(written.up.join("\n")), "and the table is insert-only with no identity column: it transcribes markup and asserts no person");

    // Build the state the migration has to survive: a record written by the PREVIOUS build.
    const before = tableCounts(store.db);
    const rosterBefore = rosterDigest(store);
    store.close();
    const down = openDatabase(file);
    down.exec("DROP TABLE written_forms");
    down.prepare("UPDATE store_info SET value = '11' WHERE key = 'schema_version'").run();
    down.close();
    const probe = openDatabase(file, { readOnly: true });
    same(readSchemaVersion(probe), 11, "the record on disk is at schema 11");
    probe.close();

    const reopened = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir, stage: "merge" });
    try {
      same(readSchemaVersion(reopened.db), 12, "opening it with this build brings it up to 12");
      same(reopened.schemaVersion, 12, "and the handle reports 12");
      const tables = new Set(reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
      ok(tables.has("written_forms"), "the new table exists in the reopened record");
      same(reopened.db.prepare("SELECT COUNT(*) n FROM written_forms").get().n, 0, "and it starts empty: a migration does not invent a written form nobody harvested");
      same(reopened.tableCounts().written_forms, 0, "the counted-table report carries it");
      ok(!reopened.created, "the file was opened, not re-created");
      same(Object.keys(reopened.tableCounts()).length, COUNTED_TABLES.length, "every counted table is reported, old ones included");
      same(tableCounts(reopened.db), before, "and every table that predates the migration keeps exactly the rows it had");
      same(rosterDigest(reopened), rosterBefore, "including the roster and the claims: the migration touches no name and no fact");
    } finally {
      reopened.close();
    }
  } finally {
    try {
      store.close();
    } catch {}
  }
  console.log("1. migration: schema 11 → 12, every other table's rows identical, the new table empty");
}

// ─── 2. the door files every row the two ROW guards keep ──────────────────────

/** Scenario 2. @returns {Promise<void>} */
async function scenarioDoor() {
  const { store } = openFixture("door");
  try {
    const roster = rosterKeysInRecord(store);
    ok(roster.has("三色院菫子") && roster.has("パンジー") && roster.has("ツバキ"), "the roster is the glossary's Characters rows");

    const pass = await fileVolumeWrittenForms(store, {});
    ok(pass.ok && pass.refusal === null, `the door should file: ${pass.refusal && pass.refusal.because}`);
    same(pass.volume, 1, "it files under the store's own volume");
    same(pass.harvestFiles, [`test_story(1)${RUBY_GUIDE_FILE_SUFFIX}`], "and it read the harvest the extraction wrote, named");
    same(pass.harvestMissing, false, "the volume has a harvest, so nothing is missing");
    same(pass.harvestErrors, [], "and it parsed");

    // ── the filing tally: the two ROW guards, counted per guard (plan 07 §6.7) ──
    same(pass.filing.harvestRows, 15, "every harvest row was counted, including the ones the guards throw away");
    same(pass.filing.rowsSkippedWithoutWordOrReading, 0, "no row in this fixture names neither a form nor a reading");
    same(pass.filing.rowsDroppedByReadingLength, 1, "a one-character reading is a phonetic complement, not a name (替 → か)");
    same(pass.filing.rowsDroppedBySharedCharacter, 1, "a reading that reuses a character of its own word is the word's ordinary pronunciation (言い訳 → いい)");
    same(pass.filing.rowsEligible, 13, "13 rows passed the two row guards");
    same(pass.filing.rowsMerged, 0, "and no two of them share a (form, reading) key, so nothing was summed");
    same(pass.filing.rowsToFile, 13, "13 distinct (form, reading) keys to file");
    same(pass.filing.distinctReadings, 7, "over 7 guided readings");
    same(pass.filing.distinctForms, 12, "and 12 written forms");
    same(pass.filing.occurrences, 283, "283 guided occurrences filed");

    same(pass.rowsFiled, 13, "and the door filed exactly those 13 rows — every row the row guards keep, whatever group it joins");
    same(pass.rowsAlreadyFiled, 0, "none of them was already there");
    same(pass.counts.thisVolume, 13, "the record's own count agrees");
    same(pass.counts.distinctForms, 12, "and so does its distinct-form count");
    same(pass.counts.distinctReadings, 7, "and its distinct-reading count");
    same(pass.counts.occurrences, 283, "and the occurrences it summed");

    // The door's row guards are the reader's constant and the reader's predicate, not a copy of them:
    // the two tallies count the same rows through the same two guards, so they must agree field for field.
    same(pass.filing.harvestRows, pass.totals.harvestRows, "the door and the fold read the same 15 rows");
    same(pass.filing.rowsDroppedByReadingLength, pass.totals.rowsDroppedByReadingLength, "and agree on what the reading-length guard dropped");
    same(pass.filing.rowsDroppedBySharedCharacter, pass.totals.rowsDroppedBySharedCharacter, "and on what the shared-character guard dropped");
    same(pass.filing.rowsSkippedWithoutWordOrReading, pass.totals.rowsSkippedWithoutWordOrReading, "and on the rows that name nothing");
    same(pass.filing.rowsEligible, pass.totals.rowsEligible, "and on how many rows are eligible");

    // ── the group report: the two GROUP guards, still applied, still deciding nothing about filing ──
    same(pass.totals.groupsDroppedBelowFormFloor, 1, "one reading carried by one written form is not a candidate group (大賀太陽 → サンちゃん)");
    same(pass.totals.groupsDroppedWithEveryFormSingleCharacter, 1, "and a group whose forms are all one character is not one either — the guard that also hides しば ← 芝 / 縛, plan 07 §2's known false negative");
    same(pass.totals.candidateGroups, 5, "five candidate groups survive the group guards");
    same(pass.totals.candidateRows, 10, "ten harvest rows sit inside them");
    same(pass.totals.candidateForms, 9, "nine distinct written forms");
    same(pass.totals.candidateOccurrences, 272, "272 guided occurrences");
    same(pass.candidateGroups, 5, "and the door reports the same five groups it reported before the scope widened");

    // **The half the widening is for: a row that joins NO group in this volume is filed anyway.**
    ok(writtenFormAlreadyFiled(store, { volume: 1, form: "大賀太陽", reading: "サンちゃん" }), "the lone form under its reading is filed, even though no group guard would have kept it");
    ok(writtenFormAlreadyFiled(store, { volume: 1, form: "恐", reading: "おそ" }), "and so is a form inside the all-single-character group the length guard drops");
    ok(writtenFormAlreadyFiled(store, { volume: 1, form: "遅", reading: "おそ" }), "…and its partner: both rows are in the record, so widening that guard later costs no re-read of the book");

    // **The half that did not change: a row one of the two ROW guards refuses is not filed.**
    same(writtenFormAlreadyFiled(store, { volume: 1, form: "言い訳", reading: "いい" }), null, "a reading that reuses a character of its own word is not filed");
    same(writtenFormAlreadyFiled(store, { volume: 1, form: "替", reading: "か" }), null, "and neither is a one-character reading");

    const pansy = pass.formsFiled.filter((row) => row.reading === "パンジー").map((row) => row.form).sort();
    same(pansy, ["三色院菫子", "好きな女"], "the rename group is filed as the two forms the book printed, not as one entry");
    const tsubaki = pass.formsFiled.filter((row) => row.reading === "ツバキ").map((row) => row.form).sort();
    same(tsubaki, ["椿", "特別な存在"], "and the group only the reading half selects is filed too");

    const sumire = writtenFormAlreadyFiled(store, { volume: 1, form: "三色院菫子", reading: "パンジー" });
    ok(sumire, "the row is findable by its key");
    same(sumire.occurrences, 18, "with the count the harvest recorded");
    same(sumire.chapters, ["ch1"], "and the chapters it recorded");
    same(sumire.readingScript, "katakana", "and the script label the harvest carried");

    // The two report halves, printed beside the filing, computed over the GROUPS the fold derives.
    same(pass.identityBearing.groups, 3, "the roster selects three of the five groups");
    same(pass.identityBearing.readings, ["パンジー", "ツバキ", "主人公"], "named, in the order the fold produced them");
    same(pass.identityBearing.rows, 6, "six harvest rows inside them");
    same(pass.identityBearing.occurrences, 34, "34 occurrences");
    same(pass.unselected.groups, 2, "and it cannot see the other two");
    same(pass.unselected.rows, 4, "four harvest rows inside those two");
    same(pass.unselected.spellingVariants, 1, "one of them is one word spelled two ways");
    same(pass.unselected.soundAlikes, 1, "the other is two words that happen to sound alike");
    same(pass.spellingVariantGroups.map((g) => g.reading), ["にせもの"], "named with both spellings");
    same(pass.spellingVariantGroups[0].forms.map((f) => f.form), ["偽物", "偽者"], "so a dictionary can print it");
    same(pass.soundAlikeGroups.map((g) => g.reading), ["うま"], "and the sound-alike is named as a class, not as an error");
    same(pass.ambiguousReadingScripts, [], "no reading arrives under two script labels");
    console.log("2. door: 15 harvest rows → 13 filed under the two row guards, 5 candidate groups reported (not filed), 3 identity-bearing, 1 spelling variant, 1 sound-alike");
  } finally {
    store.close();
  }
}

// ─── 3. a second pass files 0, and every content column is identical ──────────

/** Scenario 3. @returns {Promise<void>} */
async function scenarioIdempotence() {
  const { store } = openFixture("idempotence");
  try {
    await fileVolumeWrittenForms(store, {});
    const rowsAfterFirst = filedRowsWithoutStamps(store);
    const stampsAfterFirst = writtenFormsInRecord(store).map((row) => row.createdAt);

    const second = await fileVolumeWrittenForms(store, {});
    ok(second.ok && second.refusal === null, `the second pass should not fail: ${second.refusal && second.refusal.because}`);
    same(second.rowsFiled, 0, "a second pass over the same volume files 0 new rows");
    same(second.rowsAlreadyFiled, 13, "and reports all thirteen as already filed, rather than failing on them");
    same(second.candidateGroups, 5, "it still sees the same five groups");
    same(second.filing.rowsEligible, 13, "and the same thirteen eligible rows");
    same(second.formsFiled, [], "and files nothing");

    same(filedRowsWithoutStamps(store), rowsAfterFirst, "every content column of every filed row is identical, column by column");
    same(writtenFormsInRecord(store).map((row) => row.createdAt), stampsAfterFirst, "and no created_at moved either: the table is insert-only, so there is nothing to update");
    same(writtenFormCounts(store).total, 13, "the record still holds thirteen rows, not twenty-six");
    console.log("3. idempotence: pass 2 files 0 / reports 13 already filed, and every column is byte-identical");
  } finally {
    store.close();
  }
}

// ─── 4. it files no identity, and touches no roster ───────────────────────────

/** Scenario 4. @returns {Promise<void>} */
async function scenarioNoIdentity() {
  const { store } = openFixture("no-identity");
  try {
    const before = rosterDigest(store);
    const factsBefore = store.db.prepare("SELECT COUNT(*) n FROM facts").get().n;
    const castBefore = store.db.prepare("SELECT COUNT(*) n FROM cast").get().n;

    const pass = await fileVolumeWrittenForms(store, {});
    ok(pass.ok, `the door should file: ${pass.refusal && pass.refusal.because}`);
    same(pass.identityBearing.groups, 3, "it reports three identity-bearing groups, including パンジー ← 三色院菫子 / 好きな女");

    const after = rosterDigest(store);
    same(after.cast, before.cast, "and files nothing into `cast`: no entry, no alias, no merge");
    same(after.facts, before.facts, "nothing into `facts`: a written form is not a claim");
    same(after.merges, 0, "no `cast_merges` row");
    same(after.identities, 0, "and no `cast_identities` row either — the identity claim is plan 07 slice 2, not this slice");
    same(after.links, 0, "nor a link");
    same(store.db.prepare("SELECT COUNT(*) n FROM facts").get().n, factsBefore, "the claim count is unmoved");
    same(store.db.prepare("SELECT COUNT(*) n FROM cast").get().n, castBefore, "and the roster size is unmoved");

    // The unselected groups are filed too: the owner's answer is "record the words, no character".
    same(writtenFormsInRecord(store).filter((row) => row.reading === "うま").map((row) => row.form).sort(), ["上手", "美味"], "the sound-alike group is filed even though no rule calls it anything");
    same(writtenFormsInRecord(store).filter((row) => row.reading === "にせもの").map((row) => row.form).sort(), ["偽物", "偽者"], "and so is the spelling-variant group");
    console.log("4. no identity: 3 identity-bearing groups reported, 0 identity rows, 0 cast rows, 0 facts written");
  } finally {
    store.close();
  }
}

// ─── 5. the roster rule, four ways ────────────────────────────────────────────

/** Scenario 5. @returns {void} */
function scenarioRosterRule() {
  const roster = ["三色院菫子", "パンジー", "ツバキ", "如月雨露"];

  const byForm = plantedGroup("すみれこ", [["三色院菫子", 289], ["三色院董子", 1]]);
  const byReading = plantedGroup("ツバキ", [["椿", 5], ["特別な存在", 2]]);
  const bothRoster = plantedGroup("あい", [["三色院菫子", 4], ["如月雨露", 2]]);
  const neither = plantedGroup("うま", [["美味", 113], ["上手", 104]]);
  ok(Boolean(byForm) && Boolean(byReading) && Boolean(bothRoster) && Boolean(neither), "the four planted groups exist");

  same(identityBearingGroups([byForm], roster).map((g) => g.reading), ["すみれこ"], "a written form on the roster selects");
  same(identityBearingGroups([byReading], roster).map((g) => g.reading), ["ツバキ"], "and so does the guided **reading** being on the roster — the half that selects ツバキ ← 椿 / 特別な存在, which the form test alone misses");
  same(identityBearingGroups([bothRoster], roster).map((g) => g.reading), ["あい"], "a group whose EVERY form is a roster entry selects: the rule never requires an unknown form");
  same(identityBearingGroups([neither], roster), [], "a group with neither is left out");

  const all = [byForm, byReading, bothRoster, neither];
  const split = splitGroupsByRoster(all, roster);
  same(split.totals.groups, 4, "the split sees all four");
  same(split.totals.identityBearing, 3, "selects three");
  same(split.totals.unselected, 1, "and leaves one");
  same(split.unselected.map((g) => g.reading), ["うま"], "named, not dropped silently");

  // The half plan 06 §2.11 attached to the rule, pinned as ABSENT: it would throw away
  // さんしよくいんすみれこ (三色院菫子 x289 / 三色院董子 x1) and つきみ (月見 / 草見月), which are links
  // between two roster names — the mistake that measurement made, reappearing in a new rule.
  const everyFormKnown = plantedGroup("つきみ", [["月見", 1], ["草見月", 1]]);
  same(identityBearingGroups([everyFormKnown], ["月見", "草見月"]).map((g) => g.reading), ["つきみ"], "…and a group whose every form is on the roster is still selected, which is the mistake §2.11 made, pinned as a requirement");

  // Exact match only: the measured near misses are NOT selected, and that is the measurement, not an oversight.
  same(identityBearingGroups([plantedGroup("サンちやん", [["大賀太陽", 12], ["好きな男", 3]])], ["サンちゃん"]), [], "サンちやん is not サンちゃん: the name rule stays narrow (gotcha 121), and the near miss belongs to the reader that reports it");
  console.log("5. roster rule: form selects, reading selects, all-forms-known selects, neither does not; no unknown-form requirement");
}

// ─── 6. the 25 / 54 classifier ────────────────────────────────────────────────

/** Scenario 6. @returns {void} */
function scenarioClassifier() {
  same(SPELLING_VARIANT_MIN_RATIO, 0.5, "the floor is 0.5 of the shorter form, and it is a constant with no environment knob");
  same(longestCommonSubsequenceLength("偽物", "偽者"), 1, "偽 survives, 物 / 者 do not");
  same(longestCommonSubsequenceLength("美味", "上手"), 0, "and 美味 / 上手 share nothing in order, whatever they mean");
  same(longestCommonSubsequenceLength("", "abc"), 0, "an empty side is 0, not an error");

  const variant = plantedGroup("にせもの", [["偽物", 11], ["偽者", 10]]);
  const alike = plantedGroup("うま", [["美味", 113], ["上手", 104], ["旨", 2]]);
  const mixed = plantedGroup("かぞく", [["家族", 9], ["家庭", 4], ["カズ", 1]]);
  ok(Boolean(variant) && Boolean(alike) && Boolean(mixed), "the three planted groups exist");

  same(closestFormPairOf(variant).ratio, 0.5, "the variant pair sits exactly on the floor");
  same(closestFormPairOf(alike).ratio, 0, "the three-word homophone group scores 0 on its closest pair");
  same(closestFormPairOf(mixed).a, "家族", "the closest pair is taken over the group's pairs, not over the whole group at once");
  same(closestFormPairOf(mixed).b, "家庭", "家 survives in both, which is what makes 家族 / 家庭 one word spelled two ways rather than a homophone");

  const report = classifyUnselectedGroups([variant, alike, mixed]);
  same(report.totals.groups, 3, "three groups asked");
  same(report.totals.spellingVariants, 2, "two of them read as one word spelled two ways");
  same(report.totals.soundAlikes, 1, "one reads as different words that sound alike");
  same(report.spellingVariants.map((g) => g.reading), ["にせもの", "かぞく"], "named, in the order they were given");
  same(report.soundAlikes.map((g) => g.reading), ["うま"], "and the homophone is named as a class, not as a defect");
  same(report.totals.variantRows, 5, "the report counts the rows and occurrences it split, so the number is re-readable");
  same(report.totals.variantOccurrences, 35, "…and the occurrences");
  same(report.spellingVariants[0].closestPair.shared, 1, "each entry carries the pair that decided its class");
  same(report.spellingVariants[0].closestPair.shorter, 2, "measured against the shorter form");

  same(classifyUnselectedGroups([]).totals.groups, 0, "an empty list says so rather than guessing");
  same(classifyUnselectedGroups(undefined).totals.groups, 0, "and so does no list at all");
  console.log("6. classifier: 0.5 floor, subsequence over the shorter form, 2 variants / 1 sound-alike on the planted shapes");
}

// ─── 7. no forward look, asked twice ──────────────────────────────────────────

/** Scenario 7. @returns {Promise<void>} */
async function scenarioNoForward() {
  const { store } = openFixture("no-forward");
  try {
    const tooLate = await fileVolumeWrittenForms(store, { volume: 2 });
    ok(!tooLate.ok, "volume 2's harvest cannot be filed into volume 1's record");
    same(tooLate.refusal.rule, "written-forms-cannot-look-forward", "refused by name");
    same(tooLate.rowsFiled, 0, "and it filed nothing");
    same(writtenFormCounts(store).total, 0, "the record is untouched");

    const plantedForward = await fileVolumeWrittenForms(store, {
      volume: 1,
      harvests: [{ volume: 2, guides: [{ word: "草見月", reading: "つきみ", count: 1, readingScript: "hiragana", chapters: ["ch0"] }] }],
    });
    ok(!plantedForward.ok, "and a harvest handed to the door cannot smuggle a later volume in");
    same(plantedForward.refusal.rule, "written-forms-cannot-look-forward", "same rule, same name");
    same(writtenFormCounts(store).total, 0, "still nothing filed");

    const noVolume = await fileVolumeWrittenForms(store, { volume: "second" });
    ok(!noVolume.ok, "a volume that is not a number is refused");
    same(noVolume.refusal.rule, "written-forms-volume-undecided", "by its own rule");
    same(noVolume.refusal.verb, "file_written_forms", "and it names the door that refused");

    // An earlier volume's harvest is accepted, and the fold still sees only this volume's own rows.
    const earlier = await fileVolumeWrittenForms(store, {
      volume: 1,
      harvests: [
        { volume: 1, guides: HARVEST.guides },
        { volume: 0, guides: [] },
      ],
    });
    ok(earlier.ok, "volume 0 is not later than volume 1, so it is not a forward look");
    same(earlier.rowsFiled, 13, "the door files only volume 1's own rows");
    same(earlier.totals.harvestRows, 15, "and the fold saw only volume 1's harvest: another volume's rows are not folded in here");
    same(earlier.harvestVolumesIgnored, [0], "and it names the volume whose harvest it did not file here");
    console.log("7. no forward look: the volume is checked, the harvests are checked, and each refusal files 0");
  } finally {
    store.close();
  }
}

// ─── 8. the group question is a query, not a column ───────────────────────────

/** Scenario 8. @returns {void} */
function scenarioGroupQuery() {
  const { store } = openFixture("query");
  try {
    // Two books that each guided one form of one reading. Neither volume could have called it a candidate
    // on its own, and the door is not allowed to look forward to find out. These rows are planted through
    // the row layer, not through the door, which is the point: the door would refuse to file them.
    insertWrittenFormRow(store, { volume: 1, form: "月見", reading: "つきみ", readingScript: "hiragana", occurrences: 1, chapters: ["ch0"] });
    insertWrittenFormRow(store, { volume: 2, form: "草見月", reading: "つきみ", readingScript: "hiragana", occurrences: 1, chapters: ["ch0"] });

    const onlyOne = candidateGroupsInRecord(store, { upToVolume: 1 });
    same(onlyOne.totals.candidateGroups, 0, "volume 1's rows alone describe no candidate group: one reading, one written form");
    same(onlyOne.totals.groupsSeen, 1, "the reading was seen");
    same(onlyOne.totals.groupsDroppedBelowFormFloor, 1, "and dropped for having one form, which is reported rather than hidden");

    const both = candidateGroupsInRecord(store, { upToVolume: 2 });
    same(both.totals.candidateGroups, 1, "read together, the same two rows describe one candidate group");
    same(both.groups[0].reading, "つきみ", "つきみ");
    same(both.groups[0].forms.map((f) => f.form), ["月見", "草見月"], "with both written forms");
    same(both.groups[0].volumes, ["1", "2"], "and the two books that printed them");
    same(both.groups[0].forms[0].volumes, ["1"], "each form keeps the volume it came out of, so a later slice can date it");

    same(candidateGroupsInRecord(store).totals.candidateGroups, 0, "and the read is bounded by the record's own volume by default: this is volume 1's record, so volume 2's row is out of reach");

    // The fold is the shipped one, not a second copy of it.
    const direct = collectGuideGroups(
      [
        { volume: 1, guides: [{ word: "月見", reading: "つきみ", count: 1, readingScript: "hiragana", chapters: ["ch0"] }] },
        { volume: 2, guides: [{ word: "草見月", reading: "つきみ", count: 1, readingScript: "hiragana", chapters: ["ch0"] }] },
      ],
      { displaySubset: false }
    );
    same(both.groups, direct.groups, "the record's rows and the harvest's rows come out through the same grouping rule, field for field");
    console.log("8. query: 1 form per volume is 0 groups, the union is 1, and the read is bounded by the record's own volume");
  } finally {
    store.close();
  }
}

// ─── 9. the point of the widening: a group two books make together is filed anyway ─

/**
 * The two harvests of scenario 9, planted as the real corpus's two shapes.
 *
 * 芝 → しば x416 and 縛 → しば x10 are plan 07 §2.7's measured false negative, split across two books:
 * each form is one character, so the "at least one form is 2+ characters" guard drops the group **even in
 * the whole-series fold**. 月見 → つきみ and 草見月 → つきみ are the shape §2.13 names as unreachable per
 * volume but reachable in the union: both forms are multi-character, and each book prints only one of them.
 *
 * @type {Object<string, Array<Object>>}
 */
const SPLIT_HARVESTS = {
  1: [
    { word: "芝", reading: "しば", count: 416, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "芝", reading: "しば" }] },
    { word: "月見", reading: "つきみ", count: 1, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "月見", reading: "つきみ" }] },
  ],
  2: [
    { word: "縛", reading: "しば", count: 10, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "縛", reading: "しば" }] },
    { word: "草見月", reading: "つきみ", count: 1, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "草見月", reading: "つきみ" }] },
  ],
};

/**
 * A two-volume fixture with a different harvest in each volume folder.
 *
 * @param {string} label
 * @returns {{fx: Object, seriesDir: string}}
 */
function openSplitFixture(label) {
  const fx = fixtureStoreSeries(`written-forms-${label}`);
  for (const [volume, guides] of Object.entries(SPLIT_HARVESTS)) {
    const index = Number(volume) - 1;
    const base = fx.volumes[index].base;
    fs.writeFileSync(
      path.join(fx.volumes[index].dir, `${base}${RUBY_GUIDE_FILE_SUFFIX}`),
      JSON.stringify({ schema: 2, guides }, null, 2) + "\n",
      "utf8"
    );
  }
  return { fx, seriesDir: fx.dir };
}

/** Scenario 9. @returns {Promise<void>} */
async function scenarioCrossVolumeGroup() {
  const { fx, seriesDir } = openSplitFixture("cross-volume");
  const store1 = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir, stage: "merge" });
  const store2 = openReferenceStore({ volume: 2, folder: "Test Story(02)", seriesDir, stage: "merge" });
  assertInsideFixture(store1.file, seriesDir);
  assertInsideFixture(store2.file, seriesDir);
  try {
    // Neither book forms either group on its own. This is the fact the widening is built on: under the
    // scope slice 1 first shipped, the door filed what the group guards kept, so **none of these four
    // forms would ever have been written down** — the group exists only across two books, and no volume
    // is allowed to look forward to find it.
    const alone1 = collectGuideGroups([{ volume: 1, guides: SPLIT_HARVESTS[1] }], { displaySubset: false });
    const alone2 = collectGuideGroups([{ volume: 2, guides: SPLIT_HARVESTS[2] }], { displaySubset: false });
    same(alone1.totals.candidateGroups, 0, "volume 1's own harvest forms no candidate group");
    same(alone1.totals.candidateRows, 0, "and files no row under the grouping rule");
    same(alone2.totals.candidateGroups, 0, "nor does volume 2's");
    same(alone2.totals.candidateRows, 0, "…nor its rows");

    // Volume 1's own record: the door files its rows anyway.
    const pass1 = await fileVolumeWrittenForms(store1, {});
    ok(pass1.ok, `volume 1's door should file: ${pass1.refusal && pass1.refusal.because}`);
    same(pass1.rowsFiled, 2, "volume 1 files both of its eligible rows, group or no group");
    same(pass1.candidateGroups, 0, "and reports honestly that its own harvest describes no candidate group");
    same(candidateGroupsInRecord(store1).totals.candidateGroups, 0, "read back from the record, volume 1 alone is still no group: つきみ has one written form here");

    // Volume 2's record carries volume 1's rows — which is what copy-forward does in a real run, because
    // `written_forms` is in `COUNTED_TABLES`. Filed here through the same door, stamped with the volume
    // that printed each form, so the scenario needs no sealed volume to show the shape.
    const carried = await fileVolumeWrittenForms(store2, { volume: 1, harvests: [{ volume: 1, guides: SPLIT_HARVESTS[1] }] });
    ok(carried.ok && carried.rowsFiled === 2, `volume 1's rows should travel into volume 2's record: ${carried.refusal && carried.refusal.because}`);
    const own2 = await fileVolumeWrittenForms(store2, {});
    ok(own2.ok && own2.rowsFiled === 2, `volume 2's own pass should file its two rows: ${own2.refusal && own2.refusal.because}`);
    same(writtenFormCounts(store2).total, 4, "volume 2's record now holds four written forms, two from each book");

    // The group the two books make together, found by the READ.
    const union = candidateGroupsInRecord(store2);
    same(union.totals.candidateGroups, 1, "read together, the same four rows describe one candidate group");
    same(union.totals.groupsSeen, 2, "two readings were seen");
    same(union.totals.groupsDroppedWithEveryFormSingleCharacter, 1, "and しば is dropped by the length guard — **named, not lost**: both of its rows are in the table, so widening that guard later recovers the group with 0 model calls and 0 re-reads of any book");
    const tsukimi = union.groups.find((group) => group.reading === "つきみ");
    ok(Boolean(tsukimi), "つきみ is the group the union produces");
    same(tsukimi.forms.map((f) => f.form), ["月見", "草見月"], "with both written forms");
    same(tsukimi.forms.map((f) => f.volumes), [["1"], ["2"]], "each form keeping the book it came out of");
    same(tsukimi.volumes, ["1", "2"], "and the group dated to both books");

    // The read is still bounded: volume 2 may not look past itself, and volume 1's own record never saw this.
    same(candidateGroupsInRecord(store2, { upToVolume: 1 }).totals.candidateGroups, 0, "and the read bounded to volume 1 still finds nothing: the second form had not been printed yet");
    console.log("9. widening: 4 rows filed across two books, 0 groups in either book alone, 1 group (つきみ) in the union, しば kept as rows and named as a dropped group");
  } finally {
    store1.close();
    store2.close();
  }
}

// ─── 10. insert-only, and a damaged cell is named ──────────────────────────────

/** Scenario 10. @returns {void} */
function scenarioInsertOnly() {
  const { store } = openFixture("insert-only");
  try {
    insertWrittenFormRow(store, { volume: 1, form: "美味", reading: "うま", readingScript: "hiragana", occurrences: 113, chapters: ["ch0", "ch1"] });
    let threw = null;
    try {
      insertWrittenFormRow(store, { volume: 1, form: "美味", reading: "うま", readingScript: "hiragana", occurrences: 999, chapters: [] });
    } catch (err) {
      threw = String(err && err.message ? err.message : err);
    }
    ok(threw !== null, "a duplicate row throws rather than overwriting the count another pass measured");
    same(writtenFormAlreadyFiled(store, { volume: 1, form: "美味", reading: "うま" }).occurrences, 113, "and the row that was there keeps its count");

    same(writtenFormAlreadyFiled(store, { volume: 0, form: "美味", reading: "うま" }), null, "a row asked for under no volume is not found");
    same(writtenFormAlreadyFiled(store, { volume: 1, form: "", reading: "うま" }), null, "nor one asked for with no form");
    same(writtenFormAlreadyFiled(store), null, "nor one asked for with nothing at all");

    for (const bad of [
      { volume: 0, form: "a", reading: "b", readingScript: "hiragana" },
      { volume: 1, form: "", reading: "b", readingScript: "hiragana" },
      { volume: 1, form: "a", reading: "", readingScript: "hiragana" },
      { volume: 1, form: "a", reading: "b", readingScript: "" },
    ]) {
      let refused = null;
      try {
        insertWrittenFormRow(store, bad);
      } catch (err) {
        refused = String(err && err.message ? err.message : err);
      }
      ok(refused !== null, `a row missing part of its key (${JSON.stringify(bad)}) is refused, not filed half`);
    }
    same(writtenFormCounts(store).total, 1, "and none of them landed");

    same(parseChaptersCell('["ch0","ch1"]').chapters, ["ch0", "ch1"], "the chapters cell reads back as the list it was filed as");
    same(parseChaptersCell("").chapters, [], "an empty cell is empty, and readable");
    same(parseChaptersCell(null).unreadable, false, "as is a missing one");
    same(parseChaptersCell("ch0,ch1"), { chapters: [], unreadable: true }, "a cell that does not parse is **named**, not repaired into an empty list");
    same(parseChaptersCell("{}").unreadable, true, "and so is one that parses to the wrong shape");

    const counts = writtenFormCounts(store);
    same(counts.perVolume, { 1: 1 }, "the per-volume report says which book each row came out of");
    same(counts.occurrences, 113, "and sums the occurrences");
    console.log("10. insert-only: a duplicate throws, four malformed rows are refused, a damaged cell is named");
  } finally {
    store.close();
  }
}

// ─── 11. what this slice did not add ──────────────────────────────────────────

/** Folders that are not pipeline code — the same list `test/test-no-language-axis-list.js` states. */
const SKIP_DIRS = new Set(["node_modules", "test", "docs", "plan", "epub_source", "hooks", "calibration", "test-series"]);

/**
 * The pipeline's own `.js` files, so "no stage calls the door" is a scan and not a claim.
 * @param {string} [dir] @param {string[]} [out] @returns {string[]}
 */
function pipelineSourceFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      pipelineSourceFiles(full, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Scenario 11. @returns {void} */
function scenarioNothingAdded() {
  const kinds = Object.keys(FINDING_LEVELS);
  same(kinds.length, 70, "the finding level table is still 70 kinds — this slice added none");
  same(kinds.filter((kind) => /written|form/i.test(kind)), [], "and none of them is a written-form kind: a volume whose harvest produced no candidate group is a fact about that book, not a defect");

  same(Object.keys(FREEZE_DOORS).length, 12, "the freeze gate is still 12 doors — this slice added none (measured against `utils/prereqs/freeze/doors.js`; `AGENTS.md` still says 15, which is stale)");
  same(Object.keys(FREEZE_DOORS).filter((door) => /written/i.test(door)), [], "and no door is named for a written form");
  same(Object.keys(STEP_ARTIFACT_SPECS).filter((step) => /written/i.test(step)), [], "and no step declares a written-forms artifact");

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  same(Object.keys(packageJson.scripts).filter((name) => /written/i.test(name)), [], "no new manual command");
  ok(!fs.existsSync(path.join(ROOT, "written-forms.js")), "and no command module at the repository root");

  const handleLayer = readModuleLayer(ROOT, "utils/reference-store/open.js");
  ok(!/writtenForm/i.test(handleLayer), "the store's handle gained no written-forms verb — the door is a function, not a write scope");

  const files = pipelineSourceFiles();
  ok(files.length > 300, `the scan sees the pipeline's own code: ${files.length} files`);

  const layerPrefix = path.join(ROOT, "utils", "reference-store", "written-forms") + path.sep;
  const coverFile = path.join(ROOT, "utils", "reference-store", "written-forms.js");
  const schemaFile = path.join(ROOT, "utils", "reference-store", "schema.js");
  const barrelFile = path.join(ROOT, "utils", "reference-store.js");

  /** @type {string[]} */ const doorCallers = [];
  /** @type {string[]} */ const tableReaders = [];
  /** @type {string[]} */ const identityRequires = [];
  /** @type {string[]} */ const groupQueryCallers = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const insideLayer = file.startsWith(layerPrefix) || file === coverFile;
    if (/fileVolumeWrittenForms\s*\(/.test(text) && !insideLayer) doorCallers.push(path.relative(ROOT, file));
    if (/\bwritten_forms\b/.test(text) && !insideLayer && file !== schemaFile) tableReaders.push(path.relative(ROOT, file));
    if (/reference-store\/identity/.test(text) && file.startsWith(layerPrefix)) identityRequires.push(path.relative(ROOT, file));
    if (/candidateGroupsInRecord\s*\(/.test(text) && !insideLayer) groupQueryCallers.push(path.relative(ROOT, file));
  }

  same(doorCallers, [], "no stage, no step, no command and no door calls it: the only mentions outside the layer are the barrel's re-export, which never calls it");
  same(tableReaders, [], "and nothing outside the layer and the migration reads the table: no renderer, no audit rule, no presence matcher, no coverage rule, no chapter-facts query, no stage");
  same(identityRequires, [], "the layer requires nothing under `utils/reference-store/identity/`: the identity claim is slice 2's, and this slice does not reach it");
  same(groupQueryCallers, [path.join("utils", "reference-store", "identity", "file.js")], "the only door outside this layer that asks the grouping question is slice 2's identity door — no stage, no report renderer, and no audit rule asks it");

  const coverText = fs.readFileSync(coverFile, "utf8");
  ok(/fileVolumeWrittenForms/.test(coverText) && /candidateGroupsInRecord/.test(coverText) && /identityBearingGroups/.test(coverText), "the cover re-exports the door, the read and the pure half");
  ok(/require\("\.\.\/\.\.\/source\/guide-groups"\)/.test(fs.readFileSync(path.join(layerPrefix, "rows.js"), "utf8")), "and the read hands its rows to the shipped grouping rule rather than restating it");

  // The store's barrel is a spread, so a name a submodule forgets to export disappears from it silently and
  // a caller destructures `undefined` — gotcha 151. The widened door added one name (`eligibleWrittenFormRows`,
  // the filing set on its own, for a caller that wants to ask what the two row guards keep without opening a
  // record), so the whole cover list is compared against the barrel rather than a hand-written subset.
  const coverNames = Object.keys(require(coverFile));
  ok(coverNames.includes("eligibleWrittenFormRows"), "the cover exports the row-guard filing set, so the widened scope is readable without a store");
  const missingFromBarrel = coverNames.filter((name) => rs[name] === undefined);
  same(missingFromBarrel, [], `and every one of the cover's ${coverNames.length} names reaches the store's barrel`);

  const barrelText = fs.readFileSync(barrelFile, "utf8");
  ok(/__writtenForms/.test(barrelText), "and the store's barrel re-exports the cover");
  same(RUBY_GUIDE_FILE_SUFFIX, "-ruby-guides.json", "the file name the door scans for is the name the extraction writes");

  console.log("11. nothing added: 70 finding kinds, 12 freeze doors, 0 new artifact, 0 new command, 0 stage callers, 0 readers of the table, 1 reader of the grouping question (the identity door)");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  await scenarioMigration();
  await scenarioDoor();
  await scenarioIdempotence();
  await scenarioNoIdentity();
  scenarioRosterRule();
  scenarioClassifier();
  await scenarioNoForward();
  scenarioGroupQuery();
  await scenarioCrossVolumeGroup();
  scenarioInsertOnly();
  scenarioNothingAdded();
  console.log(`\nwritten forms: ${checks} checks, 0 model calls.`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

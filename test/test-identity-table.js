#!/usr/bin/env node
/**
 * test/test-identity-table.js — an identity, and the roster names that belong to it.
 *
 * Plan 06 slice 1b, re-pointed by **plan 07 slice 2 (2026-10-15)**. The roster is the glossary's Characters
 * table copied into `cast`, so a character the glossary described under two names is two roster entries by
 * construction, and the coverage guard asks its question per entry. The account owner's answer (plan 06
 * §10.8) is a **relation, not a merge**: a table holding an identity, and the cast entries that reference
 * it, each link recording which source stated it and in which volume.
 *
 * What slice 2 changed is **where the guide half reads from and which groups it files**:
 *
 *   - it no longer opens the volume folder and reads `<base>-ruby-guides.json`. It groups the record's own
 *     written-form rows through `written-forms/rows.js`'s `candidateGroupsInRecord` — the shipped grouping
 *     read, not a second grouping implementation;
 *   - only the groups plan 07 §2.9 selects produce links, and the selection is `written-forms/shapes.js`'s
 *     `identityBearingGroups`, not a rule restated here: *one of the group's written forms is a roster
 *     entry, **or the guided reading itself is***;
 *   - a link joins two names **the record publishes** — `cast_identity_links.a` / `.b` are foreign keys to
 *     `cast(key)` with `PRAGMA foreign_keys` ON — so a selected group whose roster holds exactly one name
 *     files nothing and is **named** in `guideUnlinkedGroups`;
 *   - the small-kana fold gained the one entry plan 07 §2.11 measured missing (ェ → エ), and it stays a
 *     **reporting** rule: チェリー / チエリー is named as a near miss and files no link.
 *
 * What this suite pins:
 *
 *   1. **the migration.** A record written at schema 8 opens after this change, is brought up, and keeps
 *      every row it had. Nothing is re-derived, nothing is refused, and the identity tables start empty.
 *   2. **the door files only what a source STATES, and only for the groups §2.9 selects.** A group whose
 *      written form is a roster entry is selected; a group whose guided **reading** is a roster entry is
 *      selected; a group where both sides are roster entries is still selected (the old rule's true
 *      positives do not regress); a group of two non-roster homophones is **not**, and files nothing.
 *      Every link carries the source, the volume that could first state it, the rows it came out of, and
 *      the statement the source gave.
 *   3. **a link joins published names only.** A selected group holding one roster name is named, not
 *      invented around: no roster entry is created to make the link fileable.
 *   4. **the fold reports and never files.** サンちやん / サンちゃん and チェリー / チエリー are named; the
 *      roster's spelling does not become a member of the group that guides the reading.
 *   5. **a group two books make.** One volume files 月見 ← つきみ, a later volume files 草見月 ← つきみ, and
 *      the link appears only in the later volume's record, dated to the volume that completed it.
 *   6. **the shape grammar is pinned, and the shape measured wrong is pinned as excluded.** Eight shapes
 *      were measured against the real character rows; seven produced no wrong pair, the eighth —
 *      `<K>'s nickname` — produced 5 pairs and all 5 were wrong. It stays in the table, marked excluded,
 *      and a row that matches only it files nothing and is reported by name.
 *   7. **two identities a new link connects are joined, not merged** — the absorbed row stays marked, and
 *      no cast entry, no claim and no `cast_merges` row is involved.
 *   8. **a wrong link is traceable and removable**, the removal needs a reason, and the removed row survives.
 *   9. **no knob, no file read, and an identity row with no label.**
 *
 * Through all of it, one invariant is re-asserted in every scenario: the `cast` table and the `facts`
 * table come out byte-identical, `cast_merges` stays empty, and no cast entry is marked `merged_into`.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69). The real-corpus
 * numbers this shape is measured against are printed by `test/measure-identities.js`.
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
const { RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");
const {
  SCHEMA_VERSION,
  MIGRATIONS,
  COUNTED_TABLES,
  IDENTITY_LINK_SOURCES,
  IDENTITY_PROSE_SHAPES,
  MIN_LINK_WITHDRAWAL_REASON_CHARS,
  openReferenceStore,
  readSchemaVersion,
  fileVolumeWrittenForms,
  candidateGroupsInRecord,
  writtenFormCounts,
  guideNamesInGroup,
  guideLinksFromGroups,
  guideNearMisses,
  identityMemberKeys,
  SMALL_KANA_TO_FULL,
  foldSmallKana,
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

/**
 * The glossary this suite imports.
 *
 * パンジー and チェリー are rows the fixture's book never prints, so the evidence rule refuses their
 * claims — but `importGlossary` registers a Characters row in the cast BEFORE it asks for evidence, which
 * is what makes them roster entries a guided reading can point at. That is the real corpus's shape: the
 * glossary recorded the author's nickname as the character's own entry, which is why plan 07 §2.9's
 * reading half selects 11 of the 18 groups.
 */
const GLOSSARY = `# Glossary

_Starter glossary for the identity suite._

## Characters

| Japanese | English | Notes |
|---|---|---|
| 如月雨露 | Kisaragi Amatsuyu | Protagonist; the narrator |
| ジョーロ | Joro | Nickname for 如月雨露, used constantly by the cast |
| 三色院菫子 | Sanshokuin Sumireko | Library committee |
| パンジー | Pansy | The name the cast uses for her |
| 大賀太陽 | Oga Taiyo | Best friend since junior high; previously listed as サンちゃん |
| サンちゃん | San-chan | The other name for him |
| 担任の教師 | The Teacher | 如月雨露's nickname for the staff room is "the wall" |
| ツバキ | Camellia | A name the glossary took from the author's own reading over 椿 |
| チェリー | Cherry | A nickname the glossary recorded from the body text |
| 月見 | Tsukimi | Named in volume 1 only |
| 草見月 | Kusamizuki | Named in volume 2 only |

## Terms

| Japanese | English | Notes |
|---|---|---|
| 会計担当 | The Accounting Person | The book says it plainly: 「山田は会計の人である。」 |
`;

/**
 * The harvest this suite writes into the fixture volume 01 folder, in the shape
 * `utils/source/ruby-guides.js` writes it.
 *
 * Six candidate groups, chosen so §2.9's rule is pinned on every side at once:
 *   - パンジー ← 三色院菫子 / 虹彩寺菫 — a roster form AND a roster reading. The old rule's true positive.
 *   - うま ← 美味 / 上手 — two non-roster homophones. Selected by nothing, files nothing.
 *   - ツバキ ← 椿 / 特別な存在 — selected by the READING alone, and the record publishes one name.
 *   - 存在しない名 ← 如月雨露 / 玄武 — a roster form, a reading nobody published.
 *   - サンちやん ← 大賀太陽 / 親友 — a roster form, and a reading one small kana from a roster name.
 *   - チエリー ← 桜原桃 / 桜桃 — no roster form, a reading one small kana from a roster name.
 *   - ジョーロ ← 如月雨露 — ONE form, both names on the roster: not a candidate group, so §2.9 cannot see
 *     it, and the door names it in `guideSoloPairs` instead of filing it.
 * Plus 担任の教師 → 担任, which the row guards refuse before any grouping happens (the reading reuses a
 * character of the word it sits on).
 */
const HARVEST = {
  schema: 2,
  whatThisIs: "fixture harvest for the identity suite",
  generatedBy: "test/test-identity-table.js",
  sourceFile: "test_story(1).epub",
  guides: [
    { word: "三色院菫子", reading: "パンジー", count: 18, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "三色院菫子", reading: "パンジー" }] },
    { word: "虹彩寺菫", reading: "パンジー", count: 406, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "虹彩寺菫", reading: "パンジー" }] },
    { word: "美味", reading: "うま", count: 113, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "美味", reading: "うま" }] },
    { word: "上手", reading: "うま", count: 104, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "上手", reading: "うま" }] },
    { word: "椿", reading: "ツバキ", count: 2, readingScript: "katakana", chapters: ["ch0"], annotated: [{ base: "椿", reading: "ツバキ" }] },
    { word: "特別な存在", reading: "ツバキ", count: 1, readingScript: "katakana", chapters: ["ch2"], annotated: [{ base: "特別な存在", reading: "ツバキ" }] },
    { word: "如月雨露", reading: "存在しない名", count: 4, readingScript: "katakana", chapters: ["ch0"], annotated: [{ base: "如月雨露", reading: "存在しない名" }] },
    { word: "玄武", reading: "存在しない名", count: 1, readingScript: "katakana", chapters: ["ch2"], annotated: [{ base: "玄武", reading: "存在しない名" }] },
    { word: "大賀太陽", reading: "サンちやん", count: 2, readingScript: "katakana", chapters: ["ch0"], annotated: [{ base: "大賀太陽", reading: "サンちやん" }] },
    { word: "親友", reading: "サンちやん", count: 3, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "親友", reading: "サンちやん" }] },
    { word: "桜原桃", reading: "チエリー", count: 5, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "桜原桃", reading: "チエリー" }] },
    { word: "桜桃", reading: "チエリー", count: 2, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "桜桃", reading: "チエリー" }] },
    // The shape §2.9's group rule cannot see, planted so the named limit is measured rather than asserted:
  // 如月雨露 guided ジョーロ is ONE written form under one reading, so it is not a candidate group, and both
  // names are on the roster. The old rule filed it; §2.9's rule has nothing to select. It is named, not filed.
  { word: "如月雨露", reading: "ジョーロ", count: 7, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "如月雨露", reading: "ジョーロ" }] },
  { word: "担任の教師", reading: "担任", count: 2, readingScript: "kanji", chapters: ["ch0"], annotated: [{ base: "担任の教師", reading: "担任" }] },
  ],
};

/** The harvests of the two-volume cross-volume fixture, one per book. */
const SPLIT_HARVESTS = {
  1: [{ word: "月見", reading: "つきみ", count: 1, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "月見", reading: "つきみ" }] }],
  2: [{ word: "草見月", reading: "つきみ", count: 1, readingScript: "hiragana", chapters: ["ch0"], annotated: [{ base: "草見月", reading: "つきみ" }] }],
};

/**
 * A fixture volume 01 with the harvest written beside its source, the harvest filed into the record, and
 * the glossary imported into it — the state the identity door is meant to run on.
 *
 * @param {string} label
 * @param {{import?: boolean, fileForms?: boolean}} [opts]
 * @returns {Promise<{fx: Object, store: Object, seriesDir: string, forms: Object}>}
 */
async function openFixture(label, { import: doImport = true, fileForms = true } = {}) {
  const fx = fixtureStoreSeries(`identity-${label}`);
  const seriesDir = fx.dir;
  fs.writeFileSync(path.join(fx.volumes[0].dir, `test_story(1)${RUBY_GUIDE_FILE_SUFFIX}`), JSON.stringify(HARVEST, null, 2) + "\n", "utf8");
  const store = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir, stage: "merge" });
  store.registerChaptersFromSource();
  assertInsideFixture(store.file, seriesDir);
  if (doImport) {
    const imported = importGlossary(store, GLOSSARY);
    ok(imported.castRegistered >= 11, `the fixture glossary should register its Characters rows as the roster: ${JSON.stringify(imported.refused.map((r) => r.row.term))}`);
  }
  let forms = null;
  if (fileForms) {
    forms = await fileVolumeWrittenForms(store, {});
    assert.ok(forms.ok, `the written-forms door should file the fixture harvest: ${forms.refusal && forms.refusal.because}`);
  }
  return { fx, store, seriesDir, forms };
}

/**
 * A stable digest of the two tables a claim lives in, so "nothing moved" is a comparison and not a hope.
 * @param {Object} store
 * @returns {{cast: string, facts: string, merges: number, mergedInto: number}}
 */
function rosterDigest(store) {
  const cast = store.db.prepare("SELECT * FROM cast ORDER BY key").all();
  const facts = store.db
    .prepare("SELECT id, key, extracted_as, aspect, section, body, established_volume, status, supersedes, source_stage, owner_volume FROM facts ORDER BY id")
    .all();
  return {
    cast: JSON.stringify(cast),
    facts: JSON.stringify(facts),
    merges: store.db.prepare("SELECT COUNT(*) n FROM cast_merges").get().n,
    mergedInto: store.db.prepare("SELECT COUNT(*) n FROM cast WHERE merged_into IS NOT NULL").get().n,
  };
}

/**
 * File one published Characters row straight into the record, with a citation the fixture's book prints.
 *
 * @param {Object} store
 * @param {string} term
 * @param {string} notes
 * @returns {Object} the inserted fact
 */
function fileCharacterRow(store, term, notes) {
  const inserted = store.insertFact({
    key: null,
    aspect: "term_usage",
    label: null,
    section: "Characters",
    body: notes,
    examples: [term],
    evidence: [{ volume: 1, chapter: "ch0", line: 2, quote: "如月雨露は教室に入った。" }],
    establishedVolume: 1,
    appliesFromVolume: 1,
  });
  assert.ok(inserted.ok, `the fixture character row should file: ${inserted.refusal && inserted.refusal.because}`);
  return inserted.fact;
}

// ─── 1. the migration: a record at schema 8 opens after this change ───────────

async function scenarioMigration() {
  const { store, seriesDir } = await openFixture("migration", { import: false, fileForms: false });
  const file = path.join(seriesDir, "Test Story(01)", "series.db");
  try {
    same(SCHEMA_VERSION, 12, "this build writes schema 12");
    same(MIGRATIONS.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "the migrations are a list, oldest first, and each one is appended rather than an older one edited");
    const register = MIGRATIONS.find((m) => m.version === 10);
    ok(register && /register/.test(register.name), `the register migration is still there, unchanged: ${register && register.name}`);
    ok(MIGRATIONS.some((m) => m.version === 9 && /identity/.test(m.name)), "the identity migration is still there, unchanged, below it");
    ok(COUNTED_TABLES.includes("cast_identities") && COUNTED_TABLES.includes("cast_identity_links"), "both identity tables are counted, so copy-forward compares them");

    // Build the state the migration has to survive: a record written by an OLDER build.
    store.close();
    const down = openDatabase(file);
    down.exec("DROP TABLE cast_identity_links");
    down.exec("DROP TABLE cast_identities");
    // And the shape migration 10 adds, taken back off, so the ALTER TABLEs in this build's newest
    // migration run against a file that genuinely does not have the columns rather than failing on a
    // duplicate. Dropping the indexes first is what lets the columns go.
    down.exec("DROP INDEX IF EXISTS idx_facts_axis");
    down.exec("DROP INDEX IF EXISTS idx_facts_axis_key");
    down.exec("ALTER TABLE facts DROP COLUMN axis_value");
    down.exec("ALTER TABLE facts DROP COLUMN axis");
    down.prepare("UPDATE store_info SET value = '8' WHERE key = 'schema_version'").run();
    down.close();
    const probe = openDatabase(file, { readOnly: true });
    same(readSchemaVersion(probe), 8, "the record on disk is at schema 8");
    probe.close();

    const reopened = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir, stage: "merge" });
    try {
      same(readSchemaVersion(reopened.db), 12, "opening it with this build brings it up to 12");
      same(reopened.schemaVersion, 12, "and the handle reports 12");
      const tables = new Set(reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
      ok(tables.has("cast_identities") && tables.has("cast_identity_links"), "the identity tables exist in the reopened record");
      same(reopened.db.prepare("SELECT COUNT(*) n FROM cast_identities").get().n, 0, "and they start empty: a migration does not invent links");
      same(reopened.db.prepare("SELECT COUNT(*) n FROM cast_identity_links").get().n, 0, "including the link table");
      same(reopened.db.prepare("SELECT COUNT(*) n FROM claim_confirmations").get().n, 0, "and neither does it invent a confirmation nobody observed");
      same(reopened.tableCounts().cast_identities, 0, "the counted-table report carries the identity tables");
      ok(!reopened.created, "the file was opened, not re-created");
      const counts = reopened.tableCounts();
      ok(Object.keys(counts).length === COUNTED_TABLES.length, "every counted table is reported, old ones included");

      // Migration 10, on the same file: the two register columns arrive, and every row that predates
      // them arrives with them NULL — a carried claim does not gain an answer it never gave.
      const factCols = new Set(reopened.db.prepare("PRAGMA table_info(facts)").all().map((c) => c.name));
      ok(factCols.has("axis") && factCols.has("axis_value"), "the facts table gains the register pair");
      same(reopened.db.prepare("SELECT COUNT(*) n FROM facts WHERE axis IS NOT NULL OR axis_value IS NOT NULL").get().n, 0, "and no pre-existing row is given an axis it never claimed");
    } finally {
      reopened.close();
    }
    console.log("  1. migration: a schema-8 record opens, is brought to 12, gains two empty tables and two null columns");
  } finally {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
}

// ─── 2. the door files only what a source states, for the groups §2.9 selects ──

async function scenarioDoor() {
  const { store, forms } = await openFixture("door");
  try {
    // The written-forms door ran first: it is what puts the book's markup into the record the identity
    // door reads. 13 of the 14 harvest rows pass the two row guards; 担任の教師 → 担任 does not.
    same(forms.rowsFiled, 13, "the written-forms door filed 13 of the 14 harvest rows");
    same(forms.filing.rowsDroppedBySharedCharacter, 1, "and the row guard refused the one whose reading reuses a character of its own word");
    same(candidateGroupsInRecord(store).totals.candidateGroups, 6, "the record's rows describe six candidate groups");

    const before = rosterDigest(store);
    const res = store.fileIdentityLinks();
    ok(res.ok, `the door ran: ${res.refusal && res.refusal.because}`);
    same(res.refusal, null, "and it refused nothing");
    same(res.guideCandidateGroups, 6, "it read the groups out of the record, not out of a file");
    same(res.guideIdentityBearingGroups, 4, "plan 07 §2.9 selects four of the six");
    same(res.guideUnselectedGroups, 2, "and leaves two out");
    same(res.guideLinks, 1, "one group holds two names the record publishes, so one guide link is stated");
    same(res.characterRowLinks, 2, "two published Characters rows state a link");

    const links = store.castIdentityLinks();
    const rubyLink = links.find((l) => l.statedBy === "ruby-guide");
    ok(!!rubyLink, "the book's own markup filed a link");
    same([rubyLink.a, rubyLink.b], ["三色院菫子", "パンジー"].sort(), "and it names the two roster entries the guided reading joined");
    same(rubyLink.statedByVolume, 1, "the link records the volume whose markup stated it");
    ok(/written-forms\(パンジー\)/.test(rubyLink.sourceFile), `the link names the rows it came out of: ${rubyLink.sourceFile}`);
    ok(/guided パンジー/.test(rubyLink.reason) && /三色院菫子/.test(rubyLink.reason) && /パンジー/.test(rubyLink.reason), `the link carries the source's own statement: ${rubyLink.reason}`);

    const pairs = new Set(links.map((l) => [l.a, l.b].sort().join(" | ")));
    ok(pairs.has(["三色院菫子", "パンジー"].sort().join(" | ")), "a group with a roster FORM and a roster READING is filed — the old rule's true positive, unmoved");
    ok(pairs.has(["ジョーロ", "如月雨露"].sort().join(" | ")), "a Characters row that states a nickname filed a link");
    ok(pairs.has(["サンちゃん", "大賀太陽"].sort().join(" | ")), "a Characters row that says 'previously listed as' filed a link");

    // §2.9's rule, both ways, and the noise it refuses.
    const unselected = candidateGroupsInRecord(store).groups.filter((g) => !res.guideUnlinkedGroups.some((u) => u.reading === g.reading) && g.reading !== "パンジー");
    ok(unselected.some((g) => g.reading === "うま"), "うま ← 美味 / 上手 is a candidate group the roster rule does not select");
    ok(!pairs.has(["美味", "上手"].sort().join(" | ")), "and it filed no link: two homophones are not a character");
    ok(!links.some((l) => l.a === "美味" || l.b === "美味" || l.a === "上手" || l.b === "上手"), "neither written form appears in any link — they stay words");
    ok(!links.some((l) => l.a === "虹彩寺菫" || l.b === "虹彩寺菫"), "虹彩寺菫 is in the パンジー group and is NOT a link member: a link joins names the record publishes, and the glossary never entered it");

    // The shape §2.9's group rule cannot see, named rather than silently dropped.
    same(res.guideSoloPairs.map((p) => `${p.a}/${p.b}←${p.reading}`), ["ジョーロ/如月雨露←ジョーロ"], "one written form guided into another roster name is named as a pair the group rule cannot select");
    ok(!pairs.has(["ジョーロ", "如月雨露"].sort().join(" | ") + " §"), "and it is not filed BY THE GUIDE: the only ジョーロ/如月雨露 link standing was stated by the glossary's prose");
    const soloGuide = links.filter((l) => l.statedBy === "ruby-guide" && [l.a, l.b].sort().join(" | ") === ["ジョーロ", "如月雨露"].sort().join(" | "));
    same(soloGuide.length, 0, "measured directly: the guide half filed 0 links for that pair");
    ok(res.guideSoloPairs.every((p) => /not a candidate group/.test(p.because)), "and the named pair says why it is not filed");

    const proseLink = links.find((l) => l.statedBy === "glossary-character-row" && l.a === "ジョーロ");    ok(/Nickname for 如月雨露/.test(proseLink.reason), `the prose link quotes the row's own notes: ${proseLink.reason}`);
    ok(/series\.db facts\(/.test(proseLink.sourceFile), `the prose link names the row it came out of: ${proseLink.sourceFile}`);
    same(proseLink.statedByVolume, 1, "and the volume that row belongs to");
    ok(links.every((l) => IDENTITY_LINK_SOURCES.includes(l.statedBy)), "every link names a source from the closed list");

    const after = rosterDigest(store);
    same(after.cast, before.cast, "filing links changed no cast row");
    same(after.facts, before.facts, "and no facts row");
    same(after.merges, 0, "cast_merges is still empty");
    same(after.mergedInto, 0, "and no cast entry is marked merged_into");

    const again = store.fileIdentityLinks();
    same(again.linksFiled, 0, "a second pass over the same record files nothing new");
    same(again.linksAlreadyFiled, 3, `and it says what it skipped: ${again.linksAlreadyFiled} already filed`);
    same(rosterDigest(store).cast, before.cast, "and it still changed no cast row");

    console.log(`  2. the door: ${res.linksFiled} link(s) from ${res.guideLinks} guide statement(s) + ${res.characterRowLinks} prose statement(s); ${res.guideIdentityBearingGroups}/${res.guideCandidateGroups} groups selected; 0 cast rows touched`);
  } finally {
    store.close();
  }
}

// ─── 3. a selected group the record cannot file a link for is NAMED ────────────

async function scenarioUnlinkedGroups() {
  const { store } = await openFixture("unlinked");
  try {
    const res = store.fileIdentityLinks();
    const named = res.guideUnlinkedGroups.map((u) => u.reading).sort();
    same(named, ["サンちやん", "ツバキ", "存在しない名"], "three selected groups hold exactly one published name each, and all three are named");
    for (const entry of res.guideUnlinkedGroups) {
      ok(entry.rosterName && entry.rosterName.length > 0, `${entry.reading}: the one name the record publishes is named (${entry.rosterName})`);
      ok(entry.forms.length >= 2, `${entry.reading}: the group's written forms are printed, so the limit is readable`);
      ok(/roster publishes 1 of them/.test(entry.because), `${entry.reading}: and it says why no link was filed: ${entry.because}`);
    }
    const tsubaki = res.guideUnlinkedGroups.find((u) => u.reading === "ツバキ");
    same(tsubaki.via, "reading", "ツバキ is selected by the READING half of §2.9 — the case the form test alone misses");
    same(tsubaki.forms, ["椿", "特別な存在"], "and neither of its written forms is a roster entry");
    ok(!store.castIdentityLinks().some((l) => l.a === "椿" || l.b === "椿" || l.a === "特別な存在" || l.b === "特別な存在"), "no link was filed for them, and no cast entry was invented to make one fileable");
    same(store.db.prepare("SELECT COUNT(*) n FROM cast WHERE key IN ('椿','特別な存在','玄武','親友')").get().n, 0, "the roster is the same size it was: filing a limit does not grow it");
    same(store.castIdentities().length, 3, "only the three links a source actually stated produced an identity — the three named groups produced none");
    console.log(`  3. the named limit: ${named.length} selected group(s) hold one published name; 0 links filed for them, 0 roster entries invented`);
  } finally {
    store.close();
  }
}

// ─── 4. the small-kana fold reports, and never files ───────────────────────────

async function scenarioNearMisses() {
  const { store } = await openFixture("near-miss");
  try {
    ok(SMALL_KANA_TO_FULL["\u30a7"] === "\u30a8", "the fold table carries the one entry plan 07 §2.11 measured missing: ェ (U+30A7) → エ (U+30A8)");
    same(foldSmallKana("チエリー"), foldSmallKana("チェリー"), "so チェリー / チエリー resolves to one string");
    same(foldSmallKana("サンちやん"), foldSmallKana("サンちゃん"), "and サンちやん / サンちゃん already did");

    const res = store.fileIdentityLinks();
    const named = res.guideNearMisses.map((m) => `${m.reading}→${m.rosterName}`).sort();
    same(named, ["サンちやん→サンちゃん", "チエリー→チェリー"], "both near misses are named, including the one the missing table entry hid");
    same(res.guideAmbiguousReadings, [], "and none of them is ambiguous — each reading folds onto exactly one roster name");

    const links = store.castIdentityLinks();
    ok(!links.some((l) => l.a === "チェリー" || l.b === "チェリー"), "チェリー files no link into the チエリー group: the fold is a reporting rule, not a name match");
    ok(!links.some((l) => l.a === "サンちゃん" && l.b === "大賀太陽" && l.statedBy === "ruby-guide"), "and サンちゃん is not filed as a member of the サンちやん group by the guide");
    ok(links.some((l) => l.a === "サンちゃん" && l.b === "大賀太陽" && l.statedBy === "glossary-character-row"), "the one サンちゃん link that DOES stand was stated by the glossary's own prose, not by the fold");
    same(res.guideLinks, 1, "the guide half still filed exactly one link, and it is not a folded spelling");

    // Asked over every candidate group, not only the selected ones: チエリー is not selected by §2.9 and is
    // still named, which is the shape plan 07 §2.9's ジヨーロ case has.
    const groups = candidateGroupsInRecord(store).groups;
    const direct = guideNearMisses(groups, new Set(store.db.prepare("SELECT key FROM cast").all().map((r) => r.key)));
    same(direct.nearMisses.length, 2, "the near-miss read is asked over every candidate group, selected or not");
    ok(!groups.some((g) => g.reading === "チェリー"), "there is no チェリー group to file: the roster's spelling is body text, the guide's is a reading");
    console.log(`  4. the fold: ${named.length} near miss(es) named, 0 links filed from a folded spelling`);
  } finally {
    store.close();
  }
}

// ─── 5. a group two books make: the link appears only in the later record ──────

async function scenarioCrossVolume() {
  const fx = fixtureStoreSeries("identity-cross-volume");
  const seriesDir = fx.dir;
  for (const [volume, guides] of Object.entries(SPLIT_HARVESTS)) {
    const index = Number(volume) - 1;
    fs.writeFileSync(path.join(fx.volumes[index].dir, `${fx.volumes[index].base}${RUBY_GUIDE_FILE_SUFFIX}`), JSON.stringify({ schema: 2, guides }, null, 2) + "\n", "utf8");
  }
  const store1 = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir, stage: "merge" });
  const store2 = openReferenceStore({ volume: 2, folder: "Test Story(02)", seriesDir, stage: "merge" });
  assertInsideFixture(store1.file, seriesDir);
  assertInsideFixture(store2.file, seriesDir);
  try {
    for (const store of [store1, store2]) {
      store.registerChaptersFromSource();
      const imported = importGlossary(store, GLOSSARY);
      assert.ok(imported.castRegistered >= 11, "both records hold the same roster");
    }
    const before1 = rosterDigest(store1);
    const before2 = rosterDigest(store2);

    // Volume 1 saw one form of つきみ. One written form under one reading is not a candidate group, so
    // volume 1's own record states no link and invents no identity.
    const pass1 = await fileVolumeWrittenForms(store1, {});
    ok(pass1.ok, `volume 1 files its own row: ${pass1.refusal && pass1.refusal.because}`);
    same(candidateGroupsInRecord(store1).totals.candidateGroups, 0, "volume 1's record describes no candidate group: つきみ has one written form here");
    const links1 = store1.fileIdentityLinks();
    same(links1.guideLinks, 0, "so the guide half states nothing in volume 1");
    same(links1.guideUnlinkedGroups, [], "and it is not even a selected group — a group needs two forms before the roster question can be asked");
    same(links1.identitiesCreated, 2, "the only identities volume 1 has are the two its glossary prose stated");

    // Volume 2's record carries volume 1's row — which is what copy-forward does, because `written_forms`
    // is in COUNTED_TABLES — and then files its own.
    const carried = await fileVolumeWrittenForms(store2, { volume: 1, harvests: [{ volume: 1, guides: SPLIT_HARVESTS[1] }] });
    ok(carried.ok && carried.rowsFiled === 1, `volume 1's row travels into volume 2's record: ${carried.refusal && carried.refusal.because}`);
    const own2 = await fileVolumeWrittenForms(store2, {});
    ok(own2.ok && own2.rowsFiled === 1, `volume 2 files its own row: ${own2.refusal && own2.refusal.because}`);
    same(writtenFormCounts(store2).total, 2, "volume 2's record holds both rows, each stamped with the book that printed it");

    const links2 = store2.fileIdentityLinks();
    const tsukimi = links2.guideUnlinkedGroups.concat().map((u) => u.reading);
    same(tsukimi.filter((r) => r === "つきみ"), [], "つきみ is NOT a named limit in volume 2's record: both of its forms are on the roster");
    const pair = links2.guideLinks;
    same(pair, 1, "and it files exactly one guide link");
    const link = store2.castIdentityLinks().find((l) => l.statedBy === "ruby-guide" && [l.a, l.b].sort().join(" | ") === ["月見", "草見月"].sort().join(" | "));
    ok(Boolean(link), "the link joins 月見 and 草見月 — the two roster entries the same guided reading names");
    same(link.statedByVolume, 2, "dated to volume 2, the volume whose own book completed the pair; volume 1 had never seen 草見月");
    ok(/volume 1/.test(link.reason) && /volume 2/.test(link.reason), `and the reason says which book printed which form: ${link.reason}`);
    const identity = store2.identityOfCastKey("月見");
    same(identity.length, 1, "月見 is inside exactly one identity");
    same(identityMemberKeys(store2, identity[0].identity).sort(), ["月見", "草見月"].sort(), "and that identity holds both names");

    // The read is still bounded, and the door is bounded with it.
    same(store2.fileIdentityLinks({ volume: 1 }).guideLinks, 0, "asked as volume 1, the same record states no guide link: the read is bounded at the volume being filed");
    const forward = store2.fileIdentityLinks({ volume: 3 });
    ok(!forward.ok, "and asking a record for a volume later than itself is refused");
    same(forward.refusal.rule, "identity-cannot-look-forward", `by name: ${forward.refusal.because}`);
    same(forward.linksFiled, 0, "the refusal filed nothing");

    same(rosterDigest(store1).cast, before1.cast, "no cast row moved in volume 1");
    same(rosterDigest(store2).cast, before2.cast, "or in volume 2");
    same(rosterDigest(store2).merges, 0, "and no merge was written");
    console.log("  5. cross-volume: 1 row in volume 1 (no group, no link), 2 rows in volume 2 (1 group, 1 link dated to volume 2), a later volume refused by name");
  } finally {
    store1.close();
    store2.close();
  }
}

// ─── 6. the shape grammar is pinned, and the wrong shape is pinned excluded ────

async function scenarioShapes() {
  const { store } = await openFixture("shapes");
  try {
    same(IDENTITY_PROSE_SHAPES.length, 8, "eight shapes were measured against the real character rows");
    same(
      IDENTITY_PROSE_SHAPES.filter((s) => s.accepted).map((s) => s.name),
      [
        "nickname for <K>",
        "nicknamed <K>",
        "nickname <K>",
        "full name of <K>",
        "previously listed as <K>",
        "name used to address <K>",
        "reveals themself as <K>",
      ],
      "seven are accepted, in the order the measurement tried them"
    );
    same(IDENTITY_PROSE_SHAPES.filter((s) => !s.accepted).map((s) => s.name), ["<K>'s nickname"], "and the eighth is in the table, marked excluded, by name");
    const rejected = IDENTITY_PROSE_SHAPES.find((s) => !s.accepted);
    ok(
      /49 row-hits/.test(rejected.because) && /all 5 pairs are wrong/i.test(rejected.because),
      `the exclusion carries the measurement that caused it, not just a veto: ${rejected.because}`
    );
    same(IDENTITY_LINK_SOURCES, ["ruby-guide", "glossary-character-row"], "the sources allowed to state a link are a closed list");

    // The fixture's 担任の教師 row matches ONLY the excluded shape.
    const res = store.fileIdentityLinks();
    const excludedHits = res.proseShapesExcluded.filter((e) => e.shape === "<K>'s nickname");
    ok(excludedHits.length > 0, "the excluded shape was still MATCHED, so the exclusion is a fact and not an absence");
    ok(
      excludedHits.some((e) => e.term === "担任の教師" && e.otherKey === "如月雨露"),
      `and it names the row and the pair it refused: ${JSON.stringify(excludedHits[0] || {})}`
    );
    const pairs = new Set(store.castIdentityLinks().map((l) => [l.a, l.b].sort().join(" | ")));
    ok(!pairs.has(["担任の教師", "如月雨露"].sort().join(" | ")), "and it filed nothing");

    // Order is part of the table: the real corpus's wrong case matches an accepted shape on 芝 and the
    // excluded shape on アネモネ, in the same sentence.
    const { statedLinksInProse } = rs;
    const wrong = statedLinksInProse({ term: "しばにゃん", notes: "アネモネ's nickname for 芝, given in chapter 4" }, new Set(["アネモネ", "芝", "しばにゃん"]));
    same(wrong.stated.map((s) => s.otherKey), ["芝"], "the accepted shape 'nickname for <K>' is what fires on that sentence");
    same(wrong.excluded.map((e) => [e.otherKey, e.shape]), [["アネモネ", "<K>'s nickname"]], "and the possessive is reported as the excluded shape, not filed");
    const only = statedLinksInProse({ term: "担任の教師", notes: "如月雨露's nickname for the staff room" }, new Set(["如月雨露", "担任の教師"]));
    same(only.stated, [], "a row that matches only the excluded shape states nothing");
    same(only.excluded.map((e) => e.shape), ["<K>'s nickname"], "and it says which shape it matched");
    const mention = statedLinksInProse({ term: "如月雨露", notes: "Protagonist; 三色院菫子 is in the same class" }, new Set(["如月雨露", "三色院菫子"]));
    same(mention.stated, [], "naming another roster key in prose is not a link");
    same(mention.excluded, [], "and it is not even an excluded hit");

    console.log(`  6. shapes: 7 accepted, 1 pinned excluded; ${excludedHits.length} fixture row(s) matched the excluded shape and filed nothing`);
  } finally {
    store.close();
  }
}

// ─── 7. two identities a new link connects are joined, not merged ──────────────

async function scenarioJoin() {
  const { store } = await openFixture("join");
  try {
    store.fileIdentityLinks();
    const groupsBefore = store.castIdentities();
    same(groupsBefore.length, 3, "three identities stand before the connecting row: 三色院菫子/パンジー (guide), ジョーロ/如月雨露 (prose) and サンちゃん/大賀太陽 (prose)");

    // One new published row states TWO links, and the second one bridges two groups that were separate.
    // The digest is taken AFTER this setup, so what the comparison measures is the door, not the fixture.
    store.upsertCast({ key: "雨露っち", display: "雨露っち", firstSeenVolume: 1 });
    fileCharacterRow(store, "雨露っち", "Nickname for 如月雨露; nickname for パンジー, both in the same chapter");
    const before = rosterDigest(store);
    const joined = store.fileIdentityLinks();
    ok(joined.identitiesAbsorbed >= 1, `the link that bridges two groups absorbed one: ${joined.identitiesAbsorbed}`);
    const absorbed = store.castIdentities({ includeAbsorbed: true }).filter((i) => i.absorbedInto !== null);
    ok(absorbed.length >= 1, `the absorbed row is still in the table: ${JSON.stringify(absorbed.map((i) => i.identity))}`);
    ok(absorbed.every((i) => typeof i.absorbedReason === "string" && i.absorbedReason.length > 0), "and it says which link absorbed it");
    const live = store.castIdentities();
    ok(!live.some((i) => i.absorbedInto !== null), "an absorbed identity is not offered as a live group");
    const merged = live.find((i) => i.memberKeys.includes("雨露っち"));
    ok(merged && merged.memberKeys.includes("如月雨露") && merged.memberKeys.includes("パンジー"), `the two groups are now one: ${JSON.stringify(merged && merged.memberKeys)}`);
    same(rosterDigest(store).cast, before.cast, "joining two identities touched no cast row");
    same(rosterDigest(store).merges, 0, "and wrote no cast_merges row");
    same(rosterDigest(store).mergedInto, 0, "and marked no cast entry merged_into");
    console.log(`  7. joining: ${absorbed.length} identity row(s) absorbed and marked; 0 cast rows touched`);
  } finally {
    store.close();
  }
}

// ─── 8. a planted wrong link is traceable, and removable with a reason ─────────

async function scenarioWrongLink() {
  const { store } = await openFixture("wrong-link");
  try {
    const before = rosterDigest(store);
    store.fileIdentityLinks();
    const linksBefore = store.castIdentityLinks();
    const [a, b] = ["担任の教師", "三色院菫子"].sort();
    const planted = store.db
      .prepare(
        "INSERT INTO cast_identity_links (identity, a, b, stated_by, stated_by_volume, source_file, reason, added_at) " +
          "VALUES (?,?,?,?,?,?,?,?)"
      )
      .run(
        linksBefore[0].identity,
        a,
        b,
        "ruby-guide",
        1,
        "series.db written-forms(fixture-wrong)",
        "planted: a written-form row no volume's harvest holds",
        new Date().toISOString()
      );
    const wrongId = Number(planted.lastInsertRowid);
    const found = store.castIdentityLinks().find((l) => l.linkId === wrongId);
    same(found.statedBy, "ruby-guide", "the wrong link is findable by the source it claims");
    same(found.sourceFile, "series.db written-forms(fixture-wrong)", "and by the rows it claims to come from");
    same(found.statedByVolume, 1, "and by the volume it claims");
    ok(store.castIdentityMembers(linksBefore[0].identity).some((m) => m.key === "担任の教師" && m.linkId === wrongId), "and it is visible as a member with its link id");

    const tooShort = store.withdrawIdentityLink(wrongId, "wrong");
    ok(!tooShort.ok, "a withdrawal without a real reason is refused");
    same(tooShort.refusal.rule, "identity-link-withdrawal-needs-reason", "and names the rule");
    ok(
      tooShort.refusal.because.includes(a) && tooShort.refusal.because.includes(b),
      `and names the link it refused to remove: ${tooShort.refusal.because}`
    );
    ok(MIN_LINK_WITHDRAWAL_REASON_CHARS >= 20, `the floor is a constant (${MIN_LINK_WITHDRAWAL_REASON_CHARS}), not a setting`);
    ok(!/process\.env/.test(fs.readFileSync(path.join(ROOT, "utils/reference-store/identity/file.js"), "utf8")), "and nothing switches it off");

    const withdrawn = store.withdrawIdentityLink(wrongId, "the written-form rows this link cites do not exist in any volume's record");
    ok(withdrawn.ok, "a real reason removes it");
    same(withdrawn.link.withdrawn_reason, "the written-form rows this link cites do not exist in any volume's record", "and the row keeps the reason");
    ok(!store.castIdentityLinks().some((l) => l.linkId === wrongId), "the link no longer stands");
    ok(store.castIdentityLinks({ includeWithdrawn: true }).some((l) => l.linkId === wrongId), "but the row is still there, marked — a removed link has to be findable");
    same(store.identityOfCastKey("担任の教師"), [], "and the name it dragged in is out of every group");
    ok(store.unlinkedCastKeys().includes("担任の教師"), "reported as a roster entry nothing links");
    ok(store.castIdentityMembers(linksBefore[0].identity).every((m) => m.key !== "担任の教師"), "the group it was planted into no longer holds it");

    const already = store.withdrawIdentityLink(wrongId, "withdrawing it a second time changes nothing and says so");
    ok(already.ok && already.alreadyWithdrawn, "withdrawing it twice is idempotent and says so, not silent");
    const unknown = store.withdrawIdentityLink(999999, "there is no link with this id, and the door says so");
    ok(!unknown.ok && unknown.refusal.rule === "identity-link-unknown", "an unknown link id is refused, not ignored");

    same(rosterDigest(store).facts, before.facts, "and none of that moved a claim");
    same(rosterDigest(store).cast, before.cast, "or a roster entry");
    same(rosterDigest(store).merges, 0, "or produced a merge");
    console.log("  8. wrong link: traceable to its stated source, refused without a reason, withdrawn with one, kept marked");
  } finally {
    store.close();
  }
}

// ─── 9. no knob, no file read, and an identity row with no label ───────────────

function scenarioNoKnob() {
  // The barrel is a spread, so a name a submodule forgets to export disappears from it silently and a
  // test that destructures it gets `undefined` — which is how this suite once wrote a fixture file
  // named `test_story(1)undefined`. Pinned rather than remembered. (gotcha 151)
  const subBarrel = require(path.join(ROOT, "utils/reference-store/identity.js"));
  const names = Object.keys(subBarrel);
  same(names.length, 26, `the identity cover exports its whole layer (${names.length} names)`);
  const missing = names.filter((name) => rs[name] === undefined);
  same(missing, [], "and every one of them reaches the store's barrel, so a door cannot destructure an undefined name");

  const layer = readModuleLayer(ROOT, "utils/reference-store/identity.js");
  ok(!/process\.env/.test(layer), "no environment variable is read anywhere in the identity layer");
  ok(!/require\("node:sqlite"\)/.test(layer), "and the layer does not touch the engine directly (db.js is the only door)");
  ok(!/createAgentHandle|runOneShot|callModel/.test(layer), "and it never reaches the model: 0 calls, by construction");

  // Plan 07 slice 2: the guide half reads the RECORD. The harvest file belongs to the written-forms door.
  ok(!/require\("fs"\)/.test(layer), "the identity layer requires no file system: it reads the record it is filing into");
  ok(!/readdirSync|readFileSync/.test(layer), "and it opens no folder and no file — `written-forms/file.js` is the only door in this store that reads a harvest");
  ok(/require\("\.\.\/written-forms\/rows"\)/.test(layer) && /require\("\.\.\/written-forms\/shapes"\)/.test(layer), "it reaches the forms through the written-forms layer's own read and its own roster rule");
  ok(!/collectGuideGroups/.test(layer), "and the identity layer does not fold a harvest itself: it asks the shipped read");

  const schemaSource = fs.readFileSync(path.join(ROOT, "utils/reference-store/schema.js"), "utf8");
  const identityTable = (schemaSource.match(/CREATE TABLE IF NOT EXISTS cast_identities \([\s\S]*?`/) || [""])[0];
  ok(identityTable.length > 0, "the identity table is created by a migration, not an edit to version 1");
  ok(!/\blabel\b/.test(identityTable), "and the identity row has no label column: an identity carries no name, only its members");
  const linkTable = (schemaSource.match(/CREATE TABLE IF NOT EXISTS cast_identity_links \([\s\S]*?`/) || [""])[0];
  ok(/stated_by\s+TEXT NOT NULL CHECK/.test(linkTable), "the link table closes its source list in the schema, not only in code");
  ok(/withdrawn_at\s+TEXT/.test(linkTable) && /withdrawn_reason\s+TEXT/.test(linkTable), "and it carries the withdrawal, so a removed link is still readable");
  ok(/a\s+TEXT NOT NULL REFERENCES cast\(key\)/.test(linkTable) && /b\s+TEXT NOT NULL REFERENCES cast\(key\)/.test(linkTable), "and both ends of a link are foreign keys to `cast(key)`: a link joins published names, which is why a one-name group is named rather than filed");
  console.log("  9. no knob, no folder opened, and an identity row with no label column");
}

// ─── Run ───────────────────────────────────────────────────────────────────────

(async () => {
  await scenarioMigration();
  await scenarioDoor();
  await scenarioUnlinkedGroups();
  await scenarioNearMisses();
  await scenarioCrossVolume();
  await scenarioShapes();
  await scenarioJoin();
  await scenarioWrongLink();
  scenarioNoKnob();
  console.log(`identity table: ${checks} checks, 0 model calls.`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

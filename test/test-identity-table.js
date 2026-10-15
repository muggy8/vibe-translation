#!/usr/bin/env node
/**
 * test/test-identity-table.js — an identity, and the roster names that belong to it.
 *
 * Plan 06 slice 1b. The roster is the glossary's Characters table copied into `cast`, so a character the
 * glossary described under two names is two roster entries by construction, and the coverage guard asks
 * its question per entry. The account owner's answer (plan 06 §10.8) is a **relation, not a merge**: a
 * table holding an identity, and the cast entries that reference it, each link recording which source
 * stated it and in which volume.
 *
 * What this suite pins:
 *
 *   1. **the migration.** A record written at schema 8 opens after this change, is brought to 9, and keeps
 *      every row it had. Nothing is re-derived, nothing is refused, and the new tables start empty.
 *   2. **the door files only what a source STATES.** The ruby-guide harvest (the book's own markup) and
 *      the record's published Characters rows (read through a pinned shape table) are the only two
 *      sources, and every link carries the source, the volume, the file or row it came from, and the
 *      statement the source gave.
 *   3. **the shape grammar is pinned, and the shape measured wrong is pinned as excluded.** Eight shapes
 *      were measured against all 2,017 real character rows; seven produced no wrong pair, the eighth —
 *      `<K>'s nickname` — produced 5 pairs and all 5 were wrong. It stays in the table, marked excluded,
 *      and a row that matches only it files nothing and is reported by name.
 *   4. **two identities a new link connects are joined, not merged** — the absorbed row stays marked, and
 *      no cast entry, no claim and no `cast_merges` row is involved.
 *   5. **a wrong link is traceable and removable**, the removal needs a reason, and the removed row survives.
 *   6. **no knob**, and the harvest file name agrees with the extraction's own.
 *
 * Through all of it, one invariant is re-asserted in every scenario: the `cast` table and the `facts`
 * table come out byte-identical, `cast_merges` stays empty, and no cast entry is marked `merged_into`.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69).
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
const {
  SCHEMA_VERSION,
  MIGRATIONS,
  COUNTED_TABLES,
  IDENTITY_LINK_SOURCES,
  IDENTITY_PROSE_SHAPES,
  RUBY_GUIDE_HARVEST_SUFFIX,
  MIN_LINK_WITHDRAWAL_REASON_CHARS,
  openReferenceStore,
  readSchemaVersion,
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
 * パンジー and サンちゃん are rows the fixture's book never prints, so the evidence rule refuses them —
 * but `importGlossary` registers a Characters row in the cast BEFORE it asks for evidence, which is what
 * makes them roster entries the ruby guide and the other rows can point at. That is the real corpus's
 * shape: 12 of the 13 ruby pairs join a name the glossary registered in a later volume.
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

## Terms

| Japanese | English | Notes |
|---|---|---|
| 会計担当 | The Accounting Person | The book says it plainly: 「山田は会計の人である。」 |
`;

/**
 * The harvest this suite writes into the fixture volume folder, in the shape
 * `utils/source/ruby-guides.js` writes.
 *
 * 三色院菫子 → パンジー is the real corpus's case: the book annotates one roster name with another.
 * 如月雨露 → 存在しない名 is the case that must file nothing: the reading is not on the roster.
 */
const HARVEST = {
  schema: 2,
  whatThisIs: "fixture harvest for the identity suite",
  generatedBy: "test/test-identity-table.js",
  sourceFile: "test_story(1).epub",
  totals: { guides: 3, rows: 3 },
  guides: [
    { word: "三色院菫子", reading: "パンジー", count: 18, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "三色院菫子", reading: "パンジー" }] },
    { word: "如月雨露", reading: "存在しない名", count: 4, readingScript: "katakana", chapters: ["ch0"], annotated: [{ base: "如月雨露", reading: "存在しない名" }] },
    { word: "担任の教師", reading: "担任", count: 2, readingScript: "kanji", chapters: ["ch0"], annotated: [{ base: "担任の教師", reading: "担任" }] },
  ],
};

/**
 * A fixture volume 01 with the harvest written beside its source and the glossary imported into its record
 * — the state the door is meant to run on.
 *
 * @param {string} label
 * @param {{import?: boolean}} [opts]
 * @returns {{fx: Object, store: Object, seriesDir: string}}
 */
function openFixture(label, { import: doImport = true } = {}) {
  const fx = fixtureStoreSeries(`identity-${label}`);
  const seriesDir = fx.dir;
  fs.writeFileSync(path.join(fx.volumes[0].dir, `test_story(1)${RUBY_GUIDE_HARVEST_SUFFIX}`), JSON.stringify(HARVEST, null, 2) + "\n", "utf8");
  const store = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir, stage: "merge" });
  store.registerChaptersFromSource();
  assertInsideFixture(store.file, seriesDir);
  if (doImport) {
    const imported = importGlossary(store, GLOSSARY);
    ok(imported.castRegistered >= 6, `the fixture glossary should register its Characters rows as the roster: ${JSON.stringify(imported.refused.map((r) => r.row.term))}`);
  }
  return { fx, store, seriesDir };
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

{
  const { store, seriesDir } = openFixture("migration", { import: false });
  const file = path.join(seriesDir, "Test Story(01)", "series.db");
  try {
    same(SCHEMA_VERSION, 12, "this build writes schema 12");
    same(MIGRATIONS.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "the migrations are a list, oldest first, and each one is appended rather than an older one edited");
    const register = MIGRATIONS.find((m) => m.version === 10);
    ok(register && /register/.test(register.name), `the register migration is still there, unchanged: ${register && register.name}`);
    ok(MIGRATIONS.some((m) => m.version === 9 && /identity/.test(m.name)), "the identity migration is still there, unchanged, below it");
    ok(COUNTED_TABLES.includes("cast_identities") && COUNTED_TABLES.includes("cast_identity_links"), "both new tables are counted, so copy-forward compares them");

    // Build the state the migration has to survive: a record written by the PREVIOUS build.
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
      ok(tables.has("cast_identities") && tables.has("cast_identity_links"), "the new tables exist in the reopened record");
      same(reopened.db.prepare("SELECT COUNT(*) n FROM cast_identities").get().n, 0, "and they start empty: a migration does not invent links");
      same(reopened.db.prepare("SELECT COUNT(*) n FROM cast_identity_links").get().n, 0, "including the link table");
      same(reopened.db.prepare("SELECT COUNT(*) n FROM claim_confirmations").get().n, 0, "and neither does it invent a confirmation nobody observed");
      same(reopened.tableCounts().cast_identities, 0, "the counted-table report carries the new tables");
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
    console.log("  1. migration: a schema-8 record opens, is brought to 10, gains two empty tables and two null columns");
  } finally {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
}

// ─── 2. the door files only what a source states ──────────────────────────────

{
  const { store } = openFixture("door");
  try {
    const before = rosterDigest(store);
    const res = store.fileIdentityLinks();
    ok(res.ok, `the door ran: ${res.refusal && res.refusal.because}`);
    same(res.refusal, null, "and it refused nothing");
    same(res.rubyGuideLinks, 1, "one pair in the fixture harvest joins two roster names");
    same(res.characterRowLinks, 2, "two published Characters rows state a link");

    const links = store.castIdentityLinks();
    const rubyLink = links.find((l) => l.statedBy === "ruby-guide");
    ok(!!rubyLink, "the book's own markup filed a link");
    same([rubyLink.a, rubyLink.b], ["三色院菫子", "パンジー"].sort(), "and it names the two roster entries the annotation joined");
    same(rubyLink.statedByVolume, 1, "the link records the volume whose markup stated it");
    ok(/ruby-guides\.json/.test(rubyLink.sourceFile), `the link names the file it came from: ${rubyLink.sourceFile}`);
    ok(/annotates 三色院菫子 with the reading パンジー/.test(rubyLink.reason), `the link carries the source's own statement: ${rubyLink.reason}`);

    const pairs = new Set(links.map((l) => [l.a, l.b].sort().join(" | ")));
    ok(pairs.has(["ジョーロ", "如月雨露"].sort().join(" | ")), "a Characters row that states a nickname filed a link");
    ok(pairs.has(["サンちゃん", "大賀太陽"].sort().join(" | ")), "a Characters row that says 'previously listed as' filed a link");
    ok(!pairs.has(["存在しない名", "如月雨露"].sort().join(" | ")), "a guide whose reading is NOT on the roster filed nothing");
    ok(!pairs.has(["担任", "担任の教師"].sort().join(" | ")), "a guide whose reading is not a roster name filed nothing");
    ok(pairs.has(["三色院菫子", "パンジー"].sort().join(" | ")), "and the book's markup did");

    const proseLink = links.find((l) => l.statedBy === "glossary-character-row" && l.a === "ジョーロ");
    ok(/Nickname for 如月雨露/.test(proseLink.reason), `the prose link quotes the row's own notes: ${proseLink.reason}`);
    ok(/series\.db facts\(/.test(proseLink.sourceFile), `the prose link names the row it came out of: ${proseLink.sourceFile}`);
    same(proseLink.statedByVolume, 1, "and the volume that row belongs to");
    ok(links.every((l) => IDENTITY_LINK_SOURCES.includes(l.statedBy)), "every link names a source from the closed list");

    const after = rosterDigest(store);
    same(after.cast, before.cast, "filing links changed no cast row");
    same(after.facts, before.facts, "and no facts row");
    same(after.merges, 0, "cast_merges is still empty");
    same(after.mergedInto, 0, "and no cast entry is marked merged_into");

    const again = store.fileIdentityLinks();
    same(again.linksFiled, 0, "a second pass over the same volume files nothing new");
    ok(again.linksAlreadyFiled > 0, `and it says what it skipped: ${again.linksAlreadyFiled} already filed`);
    same(rosterDigest(store).cast, before.cast, "and it still changed no cast row");

    console.log(`  2. the door: ${res.linksFiled} link(s) from ${res.rubyGuideLinks} ruby pair(s) + ${res.characterRowLinks} prose statement(s); 0 cast rows touched`);
  } finally {
    store.close();
  }
}

// ─── 3. the shape grammar is pinned, and the wrong shape is pinned excluded ───

{
  const { store } = openFixture("shapes");
  try {
    same(IDENTITY_PROSE_SHAPES.length, 8, "eight shapes were measured against the 2,017 real character rows");
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

    console.log(`  3. shapes: 7 accepted, 1 pinned excluded; ${excludedHits.length} fixture row(s) matched the excluded shape and filed nothing`);
  } finally {
    store.close();
  }
}

// ─── 4. two identities a new link connects are joined, not merged ─────────────

{
  const { store } = openFixture("join");
  try {
    store.fileIdentityLinks();
    const groupsBefore = store.castIdentities();
    same(groupsBefore.length, 3, "three identities stand before the connecting row: 三色院菫子/パンジー, ジョーロ/如月雨露, サンちゃん/大賀太陽");

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
    console.log(`  4. joining: ${absorbed.length} identity row(s) absorbed and marked; 0 cast rows touched`);
  } finally {
    store.close();
  }
}

// ─── 5. a planted wrong link is traceable, and removable with a reason ────────

{
  const { store } = openFixture("wrong-link");
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
        "fixture-wrong(1)-ruby-guides.json",
        "planted: a guide row no volume's harvest holds",
        new Date().toISOString()
      );
    const wrongId = Number(planted.lastInsertRowid);
    const found = store.castIdentityLinks().find((l) => l.linkId === wrongId);
    same(found.statedBy, "ruby-guide", "the wrong link is findable by the source it claims");
    same(found.sourceFile, "fixture-wrong(1)-ruby-guides.json", "and by the file it claims to come from");
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

    const withdrawn = store.withdrawIdentityLink(wrongId, "the guide row this link cites does not exist in any volume's harvest");
    ok(withdrawn.ok, "a real reason removes it");
    same(withdrawn.link.withdrawn_reason, "the guide row this link cites does not exist in any volume's harvest", "and the row keeps the reason");
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
    console.log("  5. wrong link: traceable to its stated source, refused without a reason, withdrawn with one, kept marked");
  } finally {
    store.close();
  }
}

// ─── 6. no knob, one file name, and an identity row with no label ─────────────

{
  // The barrel is a spread, so a name a submodule forgets to export disappears from it silently and a
  // test that destructures it gets `undefined` — which is how this suite once wrote a fixture file
  // named `test_story(1)undefined`. Pinned rather than remembered. (gotcha 151)
  const subBarrel = require(path.join(ROOT, "utils/reference-store/identity.js"));
  const names = Object.keys(subBarrel);
  ok(names.length >= 24, `the identity cover exports its whole layer (${names.length} names)`);
  const missing = names.filter((name) => rs[name] === undefined);
  same(missing, [], "and every one of them reaches the store's barrel, so a door cannot destructure an undefined name");

  const layer = readModuleLayer(ROOT, "utils/reference-store/identity.js");
  ok(!/process\.env/.test(layer), "no environment variable is read anywhere in the identity layer");
  ok(!/require\("node:sqlite"\)/.test(layer), "and the layer does not touch the engine directly (db.js is the only door)");
  ok(!/createAgentHandle|runOneShot|callModel/.test(layer), "and it never reaches the model: 0 calls, by construction");

  const harvestSource = fs.readFileSync(path.join(ROOT, "utils/source/ruby-guides.js"), "utf8");
  const m = harvestSource.match(/const RUBY_GUIDE_FILE_SUFFIX = "([^"]+)"/);
  ok(m, "utils/source/ruby-guides.js declares the harvest suffix");
  same(RUBY_GUIDE_HARVEST_SUFFIX, m[1], "the store's copy of the name is the same string, so the two doors read the same file");

  const schemaSource = fs.readFileSync(path.join(ROOT, "utils/reference-store/schema.js"), "utf8");
  const identityTable = (schemaSource.match(/CREATE TABLE IF NOT EXISTS cast_identities \([\s\S]*?`/) || [""])[0];
  ok(identityTable.length > 0, "the identity table is created by a migration, not an edit to version 1");
  ok(!/\blabel\b/.test(identityTable), "and the identity row has no label column: an identity carries no name, only its members");
  const linkTable = (schemaSource.match(/CREATE TABLE IF NOT EXISTS cast_identity_links \([\s\S]*?`/) || [""])[0];
  ok(/stated_by\s+TEXT NOT NULL CHECK/.test(linkTable), "the link table closes its source list in the schema, not only in code");
  ok(/withdrawn_at\s+TEXT/.test(linkTable) && /withdrawn_reason\s+TEXT/.test(linkTable), "and it carries the withdrawal, so a removed link is still readable");
  console.log("  6. no knob, one file name, and an identity row with no label column");
}

console.log(`identity table: ${checks} checks, 0 model calls.`);

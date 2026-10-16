#!/usr/bin/env node
/**
 * test/test-relations-table.js — plan 07 slice 3: one act of address, filed, and the span it held.
 *
 * The table is `relations`. The two rules this suite exists for are the two plan 07 §4.3 calls
 * non-negotiable, and each one is pinned from both sides:
 *
 *   1. **A row is never edited after the volume that filed it published.** Scenario 4 reads every column
 *      of a row before and after a span closes and asserts the content columns are identical, one by
 *      one, against `RELATION_INSERT_ONLY_COLUMNS` — the same list the store's single `UPDATE` is built
 *      from. Scenario 5 pins the other half: a close that names no reason is refused and stores nothing.
 *   2. **A volume's translation reads that volume's record.** Scenario 6 files a relation in volume 1,
 *      copies the record forward the way the pipeline does, closes the span **in the later copy**, and
 *      then hashes volume 1's file and re-reads volume 1's own record. The file is byte-identical and the
 *      span in it is still open. The read direction is pinned too: asking a volume-1 record about volume 2
 *      is refused, and a relation a volume-2 pass filed is invisible to volume 2's own record asked "as of
 *      volume 1".
 *
 * The rest of the suite pins the shapes the door refuses on: the closed vocabularies (and that the
 * database's own `CHECK` lists say the same words the layer's lists do), the party kinds a channel and a
 * certainty level allow, the ladder's record-checkable preconditions, the rule that the narration and a
 * withheld speaker never become a person, and the wall the door hits — a party with no identity files
 * nothing and is **named**, because plan 07 §6.8 is the account owner's decision and not this door's.
 *
 * **The ladder is not computed here.** Plan 07 slice 4 is the reading that decides which level a line
 * supports. This suite plants a level and checks the door accepts or refuses it against what the record
 * can show, which is all slice 3 is allowed to do.
 *
 * **One fixture is not in the language the real books are in.** Scenario 11 rebuilds a volume whose text
 * and names are Latin-script and files the same shapes through the same doors, because a rule that only
 * works on one script is a rule about that script and not about an act of address.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69).
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { readModuleLayer } = require("./module-layer");
const { fixtureStoreSeries, assertInsideFixture } = require("./fixture-reference-store");

const rs = require("../utils/reference-store");
const { importGlossary } = require("../utils/reference-store/glossary-adapter");
const { fileVolumeWrittenForms } = require("../utils/reference-store/written-forms");
const { fileIdentityLinks, identityCoverageSummary } = require("../utils/reference-store/identity");
const { RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { FREEZE_DOORS } = require("../utils/prereqs/freeze");
const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");

const rel = require("../utils/reference-store/relations");

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
 * The glossary the fixture volumes import.
 *
 * Four things are planted here, and each one is a case a scenario needs:
 *
 *   - **パンジー ← 三色院菫子** — a pair the book's own pronunciation markup states (the harvest below),
 *     so the identity it forms is stated by `ruby-guide` and `reading-resolved` is available for it;
 *   - **ジョーロ / 如月雨露** — a pair only the glossary's prose states, so `reading-resolved` must be
 *     refused for it and `measured` must not be;
 *   - **大賀太陽** — a roster entry no link still standing connects to anything, which is the named-limit
 *     case plan 07 §6.8 leaves open;
 *   - **虹彩寺菫** — a written form the book guides and the glossary never publishes, so it is not on the
 *     roster at all.
 */
const GLOSSARY = `# Glossary

_Starter glossary for the relations suite._

## Characters

| Japanese | English | Notes |
|---|---|---|
| 如月雨露 | Kisaragi Amatsuyu | Protagonist; the narrator |
| ジョーロ | Joro | Nickname for 如月雨露 |
| 三色院菫子 | Sanshokuin Sumireko | Library committee |
| パンジー | Pansy | The name the cast uses for her |
| 大賀太陽 | Oga Taiyo | Best friend since junior high |

## Terms

| Japanese | English | Notes |
|---|---|---|
| 会計担当 | The Accounting Person | The book says it plainly: 「山田は会計の人である。」 |
`;

/** The harvest that makes one identity the **book's own markup** stated, not a model's prose. */
const HARVEST = {
  schema: 2,
  whatThisIs: "fixture harvest for the relations suite",
  generatedBy: "test/test-relations-table.js",
  sourceFile: "test_story(1).epub",
  guides: [
    { word: "三色院菫子", reading: "パンジー", count: 12, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "三色院菫子", reading: "パンジー" }] },
    { word: "虹彩寺菫", reading: "パンジー", count: 5, readingScript: "katakana", chapters: ["ch2"], annotated: [{ base: "虹彩寺菫", reading: "パンジー" }] },
  ],
};

/**
 * Build one fixture volume's record, with its roster, its written forms and its two identities filed.
 *
 * @param {string} label - Scenario name, so fixtures cannot collide.
 * @param {{seal?: boolean}} [opts] - Seal volume 1 when the scenario copies it forward.
 * @returns {Promise<{fx: Object, store: Object, identities: Object}>}
 */
async function seedFixture(label, { seal = false } = {}) {
  const fx = fixtureStoreSeries(label);
  fs.writeFileSync(path.join(fx.volumes[0].dir, `test_story(1)${RUBY_GUIDE_FILE_SUFFIX}`), JSON.stringify(HARVEST, null, 2) + "\n", "utf8");
  const store = rs.openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: fx.dir, stage: "merge" });
  assertInsideFixture(store.file, fx.dir);
  store.registerVolume({ volume: 1, folder: "Test Story(01)", title: "Test Story" });
  const registered = store.registerChaptersFromSource();
  assert.ok(registered.ok, `the fixture chapters should register: ${registered.error}`);
  const imported = importGlossary(store, GLOSSARY);
  assert.ok(imported.castRegistered >= 5, `the fixture glossary should register its Characters rows: ${JSON.stringify(imported.refused.map((r) => r.row && r.row.term))}`);
  const forms = await fileVolumeWrittenForms(store, {});
  assert.ok(forms.ok && forms.rowsFiled === HARVEST.guides.length, `the fixture should file its written forms: ${forms.refusal && forms.refusal.because}`);
  const links = fileIdentityLinks(store, {});
  assert.ok(links.ok && links.linksFiled >= 2, `the fixture should file its identity links: ${links.refusal && links.refusal.because}`);
  if (seal) {
    const sealed = store.sealVolume(1);
    assert.ok(sealed.ok, `the fixture volume is published before it is copied: ${sealed.refusal && sealed.refusal.rule}`);
  }
  return { fx, store, identities: identityCoverageSummary(store) };
}

/**
 * The identity number a roster name currently sits in, for a scenario that has to name one.
 *
 * @param {Object} store
 * @param {string} key
 * @returns {number|null}
 */
function identityOf(store, key) {
  const rows = rel.identitiesOfParty(store, key).identities;
  return rows.length === 1 ? rows[0].identity : null;
}

/** @param {string} file @returns {string} sha256 of the file's bytes */
function digestOf(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Every column of one relation row, as stored.
 *
 * @param {Object} store @param {number} relationId @returns {Object}
 */
function rawRow(store, relationId) {
  return store.db.prepare("SELECT * FROM relations WHERE relation_id = ?").get(relationId);
}

// ─── 1. the migration, and the shape it writes ────────────────────────────────

/** Scenario 1. @returns {Promise<void>} */
async function scenarioMigration() {
  same(rs.SCHEMA_VERSION, 13, "the store is at schema 13 — plan 07 slice 3 appended migration 13");
  same(rs.MIGRATIONS.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], "and the migration list is append-only: nothing before 13 moved");

  const migration = rs.MIGRATIONS[rs.MIGRATIONS.length - 1];
  same(migration.version, 13, "the last migration is 13");
  ok(/act of address/.test(migration.name), `and it is named for this slice: "${migration.name}"`);
  ok(rs.COUNTED_TABLES.includes("relations"), "the table is counted, so copy-forward compares it and a top-up carries it");
  same(rs.MIGRATIONS.filter((m) => m.up.some((sql) => /\brelations\b/.test(sql))).map((m) => m.version), [13], "and no migration before it names the table: an existing migration was not edited to add it");

  const { store } = await seedFixture("migration");
  try {
    const columns = store.db.prepare("PRAGMA table_info(relations)").all().map((row) => row.name);
    same(columns, [...rel.RELATION_TABLE_COLUMNS], "the layer's own account of the columns is the table's, in table order");
    same(rel.RELATION_CLOSE_COLUMNS.filter((c) => rel.RELATION_INSERT_ONLY_COLUMNS.includes(c)), [], "the close columns and the insert-only columns do not overlap");
    same(rel.RELATION_INSERT_ONLY_COLUMNS.length + rel.RELATION_CLOSE_COLUMNS.length, rel.RELATION_TABLE_COLUMNS.length, "and between them they are the whole row");
    same(rel.RELATION_KEY_COLUMNS, ["established_volume", "channel", "form_used", "addresser", "addressee"], "the key a close matches on is the key a filing is idempotent on");

    // The vocabularies are declared twice on purpose — once here, once as a CHECK in the migration — so
    // the test is the thing that keeps the two copies the same list.
    const sql = migration.up.join("\n");
    /** @param {string} column @returns {string[]} */
    const checkList = (column) => {
      const hit = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sql);
      assert.ok(hit, `the migration declares a CHECK on ${column}`);
      return hit[1].split(",").map((piece) => piece.trim().replace(/^'|'$/g, ""));
    };
    same(checkList("channel"), [...rel.RELATION_CHANNELS], "the database's channel list is the layer's");
    same(checkList("certainty"), [...rel.RELATION_CERTAINTY_LEVELS], "so is the certainty ladder");
    same(checkList("addresser_kind"), [...rel.ADDRESSER_KINDS], "so is the addresser kind");
    same(checkList("addressee_kind"), [...rel.ADDRESSEE_KINDS], "and the addressee kind");

    const indexes = store.db.prepare("PRAGMA index_list(relations)").all();
    const unique = indexes.filter((idx) => idx.unique);
    same(unique.length, 1, "exactly one unique index guards the row");
    const indexSql = String(store.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(unique[0].name).sql);
    ok(/ifnull\(addresser, -1\)/.test(indexSql) && /ifnull\(addressee, -1\)/.test(indexSql), "and it collapses both null parties with ifnull, because SQL treats NULL as distinct from NULL and a narrator row would otherwise be filed once per pass");

    // The CHECK is the guard a door this layer has not seen yet still cannot get past.
    let threw = null;
    try {
      store.db.prepare("INSERT INTO relations (addresser_kind, addressee_kind, channel, certainty, form_used, statement, established_volume, valid_from_volume, filed_by_volume, filed_by_stage, filed_at) VALUES ('identity','none','shouting','measured','x','y',1,1,1,'merge','now')").run();
    } catch (err) {
      threw = String(err && err.message ? err.message : err);
    }
    ok(threw !== null, `a channel outside the ladder is refused by the database itself, not only by the door: ${threw ? threw.slice(0, 70) : "it was accepted"}`);

    // Migration 13 upgrades a record written before it, and leaves what that record already held alone.
    const before = {
      facts: store.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n,
      cast: store.db.prepare("SELECT COUNT(*) AS n FROM cast").get().n,
      writtenForms: store.db.prepare("SELECT COUNT(*) AS n FROM written_forms").get().n,
      identities: store.db.prepare("SELECT COUNT(*) AS n FROM cast_identities").get().n,
    };
    store.db.prepare("UPDATE store_info SET value = '12' WHERE key = 'schema_version'").run();
    store.db.prepare("DROP TABLE relations").run();
    store.close();

    const reopened = rs.openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: process.env.SERIES_LOCATION, stage: "merge" });
    assertInsideFixture(reopened.file, process.env.SERIES_LOCATION);
    try {
      same(reopened.schemaVersion, 13, "reopening a schema-12 record brings it to 13");
      same(reopened.db.prepare("SELECT COUNT(*) AS n FROM relations").get().n, 0, "and the new table arrives empty");
      const after = {
        facts: reopened.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n,
        cast: reopened.db.prepare("SELECT COUNT(*) AS n FROM cast").get().n,
        writtenForms: reopened.db.prepare("SELECT COUNT(*) AS n FROM written_forms").get().n,
        identities: reopened.db.prepare("SELECT COUNT(*) AS n FROM cast_identities").get().n,
      };
      same(after, before, "and nothing the record already held moved or vanished");
    } finally {
      reopened.close();
    }
    console.log("1. migration: schema 13 appended, 25 columns, 4 CHECK lists matching the layer's 4 vocabularies, 1 unique index with ifnull on both parties, a schema-12 record upgraded with its rows intact");
  } catch (err) {
    try {
      store.close();
    } catch {}
    throw err;
  }
}

// ─── 2. filing one act, and reading it back ───────────────────────────────────

/** Scenario 2. @returns {Promise<void>} */
async function scenarioFiling() {
  const { store, identities } = await seedFixture("filing");
  try {
    same(identities.linkedEntries, 4, "the fixture links 4 of its 5 roster entries into 2 identities");
    const guideIdentity = identityOf(store, "三色院菫子");
    const proseIdentity = identityOf(store, "如月雨露");
    ok(guideIdentity !== null && proseIdentity !== null && guideIdentity !== proseIdentity, "one identity the book's markup stated, one the glossary's prose stated, and they are different groups");

    const result = rel.fileRelation(store, {
      addresser: "三色院菫子",
      addresserKind: "identity",
      addressee: "如月雨露",
      channel: "spoken",
      certainty: "measured",
      formUsed: "テメェ",
      formReading: "てめぇ",
      statement: "三色院菫子 addresses 如月雨露 with テメェ.",
      chapter: "ch1",
      quote: "三色院菫子は本を読んでいた。",
    });
    ok(result.ok && result.filed, `the relation files: ${result.refusal && result.refusal.because}`);
    const row = result.filed;
    same(row.addresser, guideIdentity, "the addresser is the identity number, not the name the caller wrote");
    same(row.addressee, proseIdentity, "and so is the addressee");
    same(row.addresserKind, "identity", "the addresser kind is stored");
    same(row.addresseeKind, "identity", "and so is the addressee's");
    same(row.channel, "spoken", "the channel is the one named");
    same(row.certainty, "measured", "the certainty is the one named");
    same(row.formUsed, "テメェ", "the written form is kept exactly as the book prints it");
    same(row.formReading, "てめぇ", "with the reading beside it");
    same(row.establishedVolume, 1, "established in volume 1");
    same(row.validFromVolume, 1, "and the span starts at the same volume — the start is not a second thought");
    same(row.validFromChapter, "ch1", "the chapter the act was seen in");
    same(row.validToVolume, null, "the span is open");
    same(row.closedByVolume, null, "nothing has closed it");
    same(row.filedByVolume, 1, "the act is recorded as volume 1's");
    same(row.filedByStage, "merge", "through the stage that filed it");
    ok(typeof row.filedAt === "string" && row.filedAt.length > 0, "and when");
    same(row.evidence.length, 1, "the quoted line became one citation");
    same(row.evidence[0].volume, 1, "dated to volume 1");
    same(row.evidence[0].chapter, "ch1", "in chapter ch1");
    ok(Number.isInteger(row.evidence[0].line) && row.evidence[0].line > 0, `on line ${row.evidence[0].line} — the line the book prints, not the line the caller guessed`);
    same(row.evidence[0].quote, "三色院菫子は本を読んでいた。", "quoting the line as found");
    same(row.evidenceUnreadable, false, "and the citation cell reads back as JSON");

    const read = rel.relationsInRecord(store);
    ok(read.ok, "the record answers the read");
    same(read.rows.length, 1, "with one row");
    same(read.asOfVolume, 1, "bounded by default to the record's own volume");
    same(rel.relationsForIdentity(store, { identity: guideIdentity }).rows.length, 1, "and the identity query finds it from the addresser's side");
    same(rel.relationsForIdentity(store, { identity: proseIdentity }).rows.length, 1, "and from the addressee's side, which a one-column filter would miss");

    const counts = rel.relationCounts(store);
    same(counts.total, 1, "the counts report one relation");
    same([counts.open, counts.closed, counts.thisVolumeFiled], [1, 0, 1], "open, not closed, filed by this volume");
    same(counts.byChannel, { spoken: 1 }, "by channel");
    same(counts.byCertainty, { measured: 1 }, "by certainty");
    same(counts.byEstablishedVolume, { 1: 1 }, "and by the book that showed it");
    console.log("2. filing: identity numbers not names, the span starts where the act was seen, the quote becomes a citation with the line the book prints, and both reads and the counts answer");
  } finally {
    store.close();
  }
}

// ─── 3. one row per act, including the ones with no party ─────────────────────

/** Scenario 3. @returns {Promise<void>} */
async function scenarioIdempotence() {
  const { store } = await seedFixture("idempotence");
  try {
    const proposal = { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "x", quote: "三色院菫子は本を読んでいた。" };
    const first = rel.fileRelation(store, proposal);
    ok(first.ok && first.filed, "the first pass files");
    const second = rel.fileRelation(store, proposal);
    ok(second.ok, "the second pass is not an error");
    ok(second.filed === null, "and it files nothing");
    ok(second.already !== null && second.already.relationId === first.filed.relationId, "it reports the row that is already there, by id");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM relations").get().n, 1, "one row, two passes");

    // A re-run that changes the wording of the statement is the same act, and stays one row.
    const reworded = rel.fileRelation(store, { ...proposal, statement: "a different sentence about the same act" });
    ok(reworded.ok && reworded.filed === null && reworded.already !== null, "a reworded statement is the same act, not a second one");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM relations").get().n, 1, "still one row");

    // A different form, channel or book is a different act.
    same(rel.fileRelation(store, { ...proposal, formUsed: "あんた" }).filed !== null, true, "a different written form is a different act");
    same(rel.fileRelation(store, { ...proposal, channel: "inner-monologue", certainty: "addressee-risk" }).filed !== null, true, "a different channel is a different act");
    same(rel.fileRelation(store, { ...proposal, establishedVolume: 1, formUsed: "テメェ", chapter: "ch2" }).already !== null, true, "and a different chapter is not: the key is the act, not where it was noticed");

    // The null-party case, which is the one a plain UNIQUE would let through.
    const narration = { addresserKind: "narrator", channel: "narration", certainty: "narration", formUsed: "俺", statement: "The narration speaks in 俺." };
    const narrated = rel.fileRelation(store, narration);
    ok(narrated.ok && narrated.filed && narrated.filed.addresser === null, "a narration relation has no addresser");
    const narratedAgain = rel.fileRelation(store, narration);
    ok(narratedAgain.filed === null && narratedAgain.already !== null, "and filing it again finds it — the index collapses the null, it does not treat NULL as distinct from NULL");

    // The database enforces it too, with the door's idempotence read bypassed.
    let threw = null;
    try {
      rel.insertRelationRow(store, { addresserKind: "narrator", addresseeKind: "none", channel: "narration", certainty: "narration", formUsed: "俺", statement: "a second copy written straight in", evidence: [], establishedVolume: 1, filedByVolume: 1, filedByStage: "merge", filedAt: "now" });
    } catch (err) {
      threw = String(err && err.message ? err.message : err);
    }
    ok(threw !== null, `a duplicate written past the door throws on the index rather than overwriting the row: ${threw ? threw.slice(0, 60) : "it was accepted"}`);
    same(store.db.prepare("SELECT COUNT(*) AS n FROM relations WHERE channel = 'narration'").get().n, 1, "and the row that was there keeps its statement");

    // An incomplete row is refused rather than filed half.
    let halfRefused = null;
    try {
      rel.insertRelationRow(store, { addresserKind: "identity", addresseeKind: "none", channel: "spoken", certainty: "unknown", evidence: [], establishedVolume: 1, filedByVolume: 1, filedByStage: "merge", filedAt: "now" });
    } catch (err) {
      halfRefused = String(err && err.message ? err.message : err);
    }
    ok(halfRefused !== null && /relation-row-incomplete/.test(halfRefused), "and a row missing its form or statement is refused at the row door too");
    console.log("3. idempotence: 2 passes file 1 row, a reworded statement is the same act, a null party is matched by the index, a duplicate written past the door throws, a half row is refused");
  } finally {
    store.close();
  }
}

// ─── 4. a close writes the close columns and nothing else ─────────────────────

/** Scenario 4. @returns {Promise<void>} */
async function scenarioInsertOnly() {
  const { store } = await seedFixture("insert-only");
  try {
    const filed = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "三色院菫子 addresses 如月雨露 with テメェ.", chapter: "ch1", quote: "三色院菫子は本を読んでいた。" });
    ok(filed.ok && filed.filed, `the relation files: ${filed.refusal && filed.refusal.because}`);
    const id = filed.filed.relationId;
    const before = rawRow(store, id);

    const closed = rel.closeRelationSpan(store, { establishedVolume: 1, channel: "spoken", formUsed: "テメェ", addresser: before.addresser, addressee: before.addressee, closedByChapter: "ch2", closedByQuote: "ジョーロは窓を見た。" });
    ok(closed.ok && closed.closed, `the span closes: ${closed.refusal && closed.refusal.because}`);
    same(closed.columns, [...rel.RELATION_CLOSE_COLUMNS], "and the door reports the columns it wrote as exactly the pinned list");

    const after = rawRow(store, id);
    /** @type {string[]} */ const moved = rel.RELATION_TABLE_COLUMNS.filter((column) => !Object.is(before[column], after[column]));
    same(moved, [...rel.RELATION_CLOSE_COLUMNS], "column by column, the columns that moved are the close columns — no content column, no stamp column, no id");
    for (const column of rel.RELATION_INSERT_ONLY_COLUMNS) {
      ok(Object.is(before[column], after[column]), `the insert-only column ${column} is identical before and after the close`);
    }
    same(after.valid_to_volume, 1, "the span now ends at the closing volume");
    same(after.valid_to_chapter, "ch2", "named to the chapter it was seen in");
    same(after.closed_by_volume, 1, "closed by volume 1");
    same(after.closed_by_chapter, "ch2", "in chapter ch2");
    same(after.closed_by_quote, "ジョーロは窓を見た。", "quoting the line");
    ok(Number.isInteger(after.closed_by_line) && after.closed_by_line > 0, `on line ${after.closed_by_line}`);
    ok(typeof after.closed_at === "string" && after.closed_at.length > 0, "and when the record wrote it");
    same(after.evidence, before.evidence, "the citation the act was filed with is untouched by the close");

    // The store's only update contract belongs to `facts`, and this table does not borrow it.
    ok(!rs.UPDATABLE_FIELDS.some((field) => /validTo|closedBy/i.test(field)), "the facts update contract names no span-closing field, so this table is not reachable through it");

    // The one UPDATE in the row layer is the generated one, and there is no other write path.
    const layer = readModuleLayer(ROOT, "utils/reference-store/relations.js");
    const updates = layer.match(/\bUPDATE\s+relations\b/g) || [];
    same(updates.length, 1, "the whole layer contains exactly one `UPDATE relations`");
    ok(/RELATION_CLOSE_COLUMNS\.map/.test(layer), "and it is generated from the pinned column list rather than hand-written beside it");
    same((layer.match(/\bDELETE FROM relations\b/g) || []).length, 0, "and nothing in the layer deletes a relation: a span that ended is a fact about the book");
    console.log(`4. insert-only: a close moved ${moved.length} column(s) and left all ${rel.RELATION_INSERT_ONLY_COLUMNS.length} content columns byte-identical, through the layer's single generated UPDATE`);
  } finally {
    store.close();
  }
}

// ─── 5. a span closes only with a reason, and the reason is a line ────────────

/** Scenario 5. @returns {Promise<void>} */
async function scenarioCloseReason() {
  const { store } = await seedFixture("close-reason");
  try {
    const filed = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "x", chapter: "ch1", quote: "三色院菫子は本を読んでいた。" });
    ok(filed.ok && filed.filed, "the relation files");
    const row = filed.filed;
    const key = { establishedVolume: 1, channel: "spoken", formUsed: "テメェ", addresser: row.addresser, addressee: row.addressee };

    const noChapter = rel.closeRelationSpan(store, { ...key, closedByQuote: "ジョーロは窓を見た。" });
    same(noChapter.refusal && noChapter.refusal.rule, "relation-span-closes-without-a-reason", "a close naming a line but no chapter is refused");
    const noQuote = rel.closeRelationSpan(store, { ...key, closedByChapter: "ch2" });
    same(noQuote.refusal && noQuote.refusal.rule, "relation-span-closes-without-a-reason", "and one naming a chapter but no line");
    const neither = rel.closeRelationSpan(store, key);
    same(neither.refusal && neither.refusal.rule, "relation-span-closes-without-a-reason", "and one naming neither — `valid_to` without a reason is a quiet rewrite");
    const stillOpen = store.db.prepare("SELECT valid_to_volume, closed_by_volume FROM relations WHERE relation_id = ?").get(row.relationId);
    same([stillOpen.valid_to_volume, stillOpen.closed_by_volume], [null, null], "and all three refusals stored nothing: the span is still open");

    const badQuote = rel.closeRelationSpan(store, { ...key, closedByChapter: "ch2", closedByQuote: "これはこの本の中に書かれていない。" });
    same(badQuote.refusal && badQuote.refusal.rule, "relation-close-quote-not-in-this-volume", "a close quoting a line the closing volume does not print is refused");
    same(store.db.prepare("SELECT valid_to_volume FROM relations WHERE relation_id = ?").get(row.relationId).valid_to_volume, null, "and it stored nothing");

    const badChapter = rel.closeRelationSpan(store, { ...key, closedByChapter: "ch9", closedByQuote: "ジョーロは窓を見た。" });
    same(badChapter.refusal && badChapter.refusal.rule, "relation-chapter-not-in-this-record", "a close naming a chapter this record never registered is refused — a chapter nothing can check is not a reason");

    const noRow = rel.closeRelationSpan(store, { ...key, formUsed: "存在しない言い方", closedByChapter: "ch2", closedByQuote: "ジョーロは窓を見た。" });
    same(noRow.refusal && noRow.refusal.rule, "relation-row-not-found", "a close names a row; it does not create one");

    const wrongCopy = rel.closeRelationSpan(store, { ...key, closedByVolume: 2, closedByChapter: "ch2", closedByQuote: "ジョーロは窓を見た。" });
    same(wrongCopy.refusal && wrongCopy.refusal.rule, "relation-close-is-not-in-its-own-copy", "and a close asked of a handle that is not the closing volume's own is refused before anything is read");

    const okClose = rel.closeRelationSpan(store, { ...key, closedByChapter: "ch2", closedByQuote: "ジョーロは窓を見た。" });
    ok(okClose.ok && okClose.closed, "the close that names its chapter and a line the volume prints goes through");
    const again = rel.closeRelationSpan(store, { ...key, closedByChapter: "ch1", closedByQuote: "如月雨露は教室に入った。" });
    same(again.refusal && again.refusal.rule, "relation-span-already-closed", "and a second close is refused rather than moving which volume closed it");
    const stands = store.db.prepare("SELECT valid_to_volume, closed_by_chapter FROM relations WHERE relation_id = ?").get(row.relationId);
    same([stands.valid_to_volume, stands.closed_by_chapter], [1, "ch2"], "the first close stands where it was written");

    const extraction = rs.openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: process.env.SERIES_LOCATION, stage: "extract" });
    try {
      const refused = rel.closeRelationSpan(extraction, { ...key, closedByChapter: "ch2", closedByQuote: "ジョーロは窓を見た。" });
      same(refused.refusal && refused.refusal.rule, "relation-needs-a-record-handle", "and the extraction handle, which files candidates it has not decided about, cannot close a span at all");
    } finally {
      extraction.close();
    }
    console.log("5. the reason: 3 shape refusals, 1 line the book does not print, 1 chapter the record never registered, 1 row that does not exist, 1 close asked of the wrong copy, 1 second close refused, 1 extraction handle refused — and every refusal stored nothing");
  } finally {
    store.close();
  }
}

// ─── 6. a volume's translation reads that volume's record ─────────────────────

/** Scenario 6. @returns {Promise<void>} */
async function scenarioNoForward() {
  const { fx, store } = await seedFixture("no-forward", { seal: true });
  const volumeOneFile = store.file;
  const filed = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "x", chapter: "ch1", quote: "三色院菫子は本を読んでいた。" });
  ok(filed.ok && filed.filed, "volume 1 files the act its own text showed");

  // Direction one: a volume may not file an act from a book it has not read.
  const forward = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "x", establishedVolume: 2, quote: "三色院菫子は本を読んでいた。" });
  same(forward.refusal && forward.refusal.rule, "relations-cannot-look-forward", "a volume-1 handle refuses to establish a relation in volume 2");
  // …and the late-discovery case `facts` already allows stays open.
  const late = rel.fileRelation(store, { addresserKind: "unknown", channel: "spoken", certainty: "unknown", formUsed: "あんた", statement: "noticed now, seen in volume 1", establishedVolume: 1 });
  ok(late.ok && late.filed, "while establishing an act at the handle's own volume or earlier stays allowed");
  store.close();

  const copy = rs.copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: fx.dir });
  ok(copy.ok, `the record is copied forward the way a run copies it: ${copy.refusal && copy.refusal.because}`);
  const volumeOneAfterCopy = digestOf(volumeOneFile);

  const store2 = rs.openReferenceStore({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, stage: "merge" });
  assertInsideFixture(store2.file, fx.dir);
  try {
    ok(store2.registerChaptersFromSource().ok, "volume 2 registers its own chapters");
    const carried = rel.relationsInRecord(store2);
    ok(carried.ok && carried.rows.length === 2, `the copy carries both volume-1 relations: ${carried.rows.length}`);
    same(carried.rows.every((row) => row.validToVolume === null), true, "and every span in it is still open — the copy does not arrive pre-closed");

    const key = { establishedVolume: 1, channel: "spoken", formUsed: "テメェ", addresser: identityOf(store2, "三色院菫子"), addressee: identityOf(store2, "如月雨露") };
    const closed = rel.closeRelationSpan(store2, { ...key, closedByChapter: "ch0", closedByQuote: "駱駝はあとがきに書いた。" });
    ok(closed.ok && closed.closed, `volume 2 closes the span in its own copy: ${closed.refusal && closed.refusal.because}`);
    same(closed.closed.validToVolume, 2, "the span now ends at volume 2, the volume whose text showed the change");

    // Direction two: the earlier file is untouched, and the earlier record still says the span is open.
    same(digestOf(volumeOneFile), volumeOneAfterCopy, "volume 1's series.db is byte-identical after volume 2 closed the span — the published snapshot never changes");
    const atVolume1 = rel.relationsInRecord(store2, { asOfVolume: 1 });
    ok(atVolume1.ok, "volume 2's record can be asked what it knew as of volume 1");
    same(atVolume1.rows.filter((row) => row.relationId === closed.closed.relationId).map((row) => row.validToVolume), [2], "and the span is still standing at volume 1, which is what \"closed at volume 2\" means");

    const filedAtTwo = rel.fileRelation(store2, { addresserKind: "unknown", channel: "spoken", certainty: "unknown", formUsed: "あんた", statement: "volume 2's own gap", establishedVolume: 2 });
    ok(filedAtTwo.ok && filedAtTwo.filed, "volume 2 files an act its own text showed");
    same(rel.relationsInRecord(store2, { asOfVolume: 1 }).rows.some((row) => row.relationId === filedAtTwo.filed.relationId), false, "and that row is invisible to the same record asked as of volume 1: a later book's observation does not reach an earlier volume's answer");

    same(rel.relationsInRecord(store2, { asOfVolume: 3 }).refusal.rule, "relations-cannot-look-forward", "and asking a volume-2 record about volume 3 is refused rather than answered");
    same(rel.relationsInRecord(store2, { asOfVolume: 0 }).refusal.rule, "relation-read-volume-undecided", "and asking it about no volume is refused too");
  } finally {
    store2.close();
  }

  const back = rs.openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: fx.dir, stage: "merge" });
  try {
    const rows = rel.relationsInRecord(back);
    same(rows.rows.map((row) => row.validToVolume), [null, null], "volume 1's own record still reports both spans open — the close lives only in the copy that made it");
    same(rel.relationCounts(back).closed, 0, "and its counts agree");
  } finally {
    back.close();
  }
  console.log("6. no forward leak: a volume-1 handle refuses volume 2's act, volume 2 closes the span in its own copy, volume 1's file is byte-identical and still reports the span open, and a volume-2 row is invisible to a read asked as of volume 1");
}

// ─── 7. the narration and a withheld speaker never become a person ────────────

/** Scenario 7. @returns {Promise<void>} */
async function scenarioNoInventedPerson() {
  const { store } = await seedFixture("no-invented-person");
  try {
    const castBefore = store.db.prepare("SELECT COUNT(*) AS n FROM cast").get().n;
    const identitiesBefore = store.db.prepare("SELECT COUNT(*) AS n FROM cast_identities").get().n;
    const linksBefore = store.db.prepare("SELECT COUNT(*) AS n FROM cast_identity_links").get().n;

    const narrated = rel.fileRelation(store, { addresserKind: "narrator", channel: "narration", certainty: "narration", formUsed: "俺", statement: "The narration speaks in 俺.", chapter: "ch0" });
    ok(narrated.ok && narrated.filed, `the narration files: ${narrated.refusal && narrated.refusal.because}`);
    same(narrated.filed.addresser, null, "with no addresser");
    same(narrated.filed.addresserKind, "narrator", "and a named kind, which is the whole of what the row says about who spoke");
    same(narrated.filed.addresseeKind, "none", "and no addressee either");

    const withheld = rel.fileRelation(store, { addresserKind: "withheld", addressee: "如月雨露", channel: "withheld", certainty: "withheld", formUsed: "テメェ", statement: "Somebody addresses 如月雨露 and the book pointedly does not say who." });
    ok(withheld.ok && withheld.filed, `a withheld speaker files: ${withheld.refusal && withheld.refusal.because}`);
    same(withheld.filed.addresser, null, "with no addresser");
    same(withheld.filed.addresserKind, "withheld", "and its own kind");
    same(withheld.filed.addresseeKind, "identity", "while the person addressed is still named — a withheld speaker is not a withheld act");

    const gap = rel.fileRelation(store, { addresserKind: "unknown", channel: "spoken", certainty: "unknown", formUsed: "あんた", statement: "Nothing matched, and the book did not withhold." });
    ok(gap.ok && gap.filed, "and the honest gap files too");
    same(gap.filed.addresserKind, "unknown", "with a kind of its own");
    ok(narrated.filed.addresserKind !== withheld.filed.addresserKind && withheld.filed.addresserKind !== gap.filed.addresserKind, "and the three look different from each other, which is why the kind is stored rather than derived from the channel: a gap and an authorial act must not be the same row shape");

    same(store.db.prepare("SELECT COUNT(*) AS n FROM cast").get().n, castBefore, "none of the three added a roster entry");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM cast_identities").get().n, identitiesBefore, "nor an identity");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM cast_identity_links").get().n, linksBefore, "nor an identity link");

    const counts = rel.relationCounts(store);
    same(counts.partiesWithoutIdentity, 3, "and the counts name all three as a party with no identity, rather than counting them as people");

    // The word for the narration is refused as a *name*, before anything is resolved.
    for (const word of ["narrator", "NARRATOR", "the narrator", "地の文"]) {
      const refused = rel.fileRelation(store, { addresser: word, addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "addressee-risk", formUsed: "テメェ", statement: "x" });
      same(refused.refusal && refused.refusal.rule, "narrator-is-not-a-party", `"${word}" is refused as a party name, the same way \`cast.js\` refuses it as a roster key`);
    }
    same(store.db.prepare("SELECT COUNT(*) AS n FROM cast WHERE key IN ('narrator','NARRATOR','the narrator','地の文')").get().n, 0, "and none of them reached the roster");

    // A channel and a kind that contradict each other are refused rather than reconciled.
    same(rel.fileRelation(store, { addresser: "如月雨露", addresserKind: "identity", channel: "narration", certainty: "narration", formUsed: "x", statement: "y" }).refusal.rule, "relation-channel-and-party-disagree", "a narration channel with a named identity is refused");
    same(rel.fileRelation(store, { addresserKind: "narrator", channel: "spoken", certainty: "measured", formUsed: "x", statement: "y", quote: "如月雨露は教室に入った。" }).refusal.rule, "relation-channel-and-party-disagree", "and a spoken channel with the narration is refused");
    same(rel.fileRelation(store, { addresserKind: "withheld", channel: "withheld", certainty: "narration", formUsed: "x", statement: "y" }).refusal.rule, "relation-certainty-and-party-disagree", "and a certainty level is refused when it names a different kind of party than the row does");
    same(rel.fileRelation(store, { addresser: "如月雨露", addresserKind: "identity", channel: "spoken", certainty: "narration", formUsed: "x", statement: "y" }).refusal.rule, "relation-certainty-and-party-disagree", "including a narration certainty with a roster entry in it, which is the exact shape plan 07 §4.4 says that level must not have");
    same(rel.fileRelation(store, { addresser: "如月雨露", addresserKind: "unknown", channel: "spoken", certainty: "unknown", formUsed: "x", statement: "y" }).refusal.rule, "relation-names-a-party-it-is-not-claiming", "and a name offered beside a kind that claims no person is refused rather than quietly dropped");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM relations WHERE form_used IN ('x','y')").get().n, 0, "and none of those refusals filed a row");
    console.log("7. no invented person: 3 null-party kinds filed with 0 new roster entries, 0 identities, 0 links; 4 narration words refused as names; 2 channel/kind refusals, 2 certainty/kind refusals, 1 name offered beside a kind that claims no person");
  } finally {
    store.close();
  }
}

// ─── 8. parties are keyed on identities, and the wall is named ────────────────

/** Scenario 8. @returns {Promise<void>} */
async function scenarioIdentityKeyed() {
  const { store } = await seedFixture("identity-keyed");
  try {
    // A roster entry the record publishes, with no identity link standing under it.
    const unlinked = rel.fileRelation(store, { addresser: "大賀太陽", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "addressee-risk", formUsed: "テメェ", statement: "x" });
    same(unlinked.ok, false, "a relation naming an unlinked roster entry files nothing");
    ok(unlinked.refusal !== null && unlinked.namedLimit !== null, "and it is reported twice on purpose: a refusal the caller can act on, and the limit in its own field so a measurement can count these without reading prose");
    same(unlinked.namedLimit.side, "addresser", "the limit names which side it is on");
    same(unlinked.namedLimit.name, "大賀太陽", "which name it is");
    same(unlinked.namedLimit.inRoster, true, "and that the name IS on the roster — the record publishes it, it just has no group");
    same(unlinked.namedLimit.rule, "relation-party-not-in-an-identity", "with the rule attached, so a measurement can count these");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM relations").get().n, 0, "and nothing was filed");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM cast WHERE key = '大賀太陽'").get().n, 1, "the door did not invent a roster entry to make it fileable");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM cast_identities").get().n, 2, "nor an identity");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM cast_identity_links").get().n, 2, "nor a link");

    // A written form the book guides and the record never published.
    const notRoster = rel.fileRelation(store, { addresser: "虹彩寺菫", addresserKind: "identity", channel: "inner-monologue", certainty: "addressee-risk", addressee: "如月雨露", formUsed: "虹彩寺菫", statement: "x" });
    same(notRoster.ok, false, "a form the record never published files nothing either");
    same(notRoster.namedLimit.inRoster, false, "and the limit says so: it is not on the roster at all");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM cast WHERE key = '虹彩寺菫'").get().n, 0, "and it was not added to make the answer yes");

    // Both sides are keyed, so the addressee hits the same wall.
    const addresseeSide = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "大賀太陽", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "x", quote: "三色院菫子は本を読んでいた。" });
    same(addresseeSide.ok, false, "the addressee side is keyed too");
    same(addresseeSide.namedLimit.side, "addressee", "and is named on that side");

    // The same identity reached through either of its published spellings is the same party.
    const byForm = rel.fileRelation(store, { addresser: "パンジー", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "x", quote: "三色院菫子は本を読んでいた。" });
    const byOtherForm = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "x", quote: "三色院菫子は本を読んでいた。" });
    ok(byForm.filed && byOtherForm.already, "and the two spellings of one person are one party: the second filing finds the first row rather than filing a second act");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM relations").get().n, 1, "one row for one act, whichever spelling the reading wrote");

    // Self-address is the channel where both sides must be the same person, and that is checkable.
    const selfSame = rel.fileRelation(store, { addresser: "如月雨露", addresserKind: "identity", addressee: "ジョーロ", channel: "self-address", certainty: "addressee-risk", formUsed: "俺", statement: "如月雨露 addresses himself." });
    ok(selfSame.filed, "two spellings of one identity are the same person, so a self-address through them files");
    same(selfSame.filed.addresser, selfSame.filed.addressee, "stored as one identity on both sides");
    const selfTwo = rel.fileRelation(store, { addresser: "如月雨露", addresserKind: "identity", addressee: "三色院菫子", channel: "self-address", certainty: "addressee-risk", formUsed: "俺", statement: "x" });
    same(selfTwo.refusal && selfTwo.refusal.rule, "relation-self-address-has-two-parties", "and a self-address whose two sides are different people is refused");
    const selfUnknown = rel.fileRelation(store, { addresserKind: "unknown", channel: "self-address", certainty: "unknown", formUsed: "俺", statement: "x" });
    same(selfUnknown.refusal && selfUnknown.refusal.rule, "relation-channel-and-party-disagree", "and a self-address whose speaker is unknown is not a self-address at all");
    console.log("8. keyed on identities: 3 named limits (2 on the roster, 1 not), 0 rows filed for them, 0 roster entries or identities invented, 2 spellings = 1 party, 2 self-address refusals");
  } finally {
    store.close();
  }
}

// ─── 9. the ladder: the vocabulary, and what each level has to show ───────────

/** Scenario 9. @returns {Promise<void>} */
async function scenarioCertaintyLadder() {
  const { store } = await seedFixture("certainty");
  try {
    same(rel.RELATION_CERTAINTY_LEVELS, ["measured", "addressee-risk", "reading-resolved", "narration", "withheld", "unknown"], "the ladder is the six levels of plan 07 §4.4, in order");
    same(rel.RELATION_CERTAINTY_LEVELS.filter((level) => typeof rel.RELATION_CERTAINTY_PRECONDITIONS[level] !== "object"), [], "and every one of them declares what the record has to be able to show for it");
    same(rel.RELATION_CERTAINTY_LEVELS.filter((level) => typeof level === "number"), [], "and none of them is a number a model reported about itself");

    // `measured` promises a line and an addressee.
    const measured = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "x", quote: "三色院菫子は本を読んでいた。" });
    ok(measured.filed, "`measured` with a verified line and a named addressee files");
    same(rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "x" }).refusal.rule, "relation-certainty-has-no-line-to-point-at", "and `measured` with no line is refused: the level says the line names exactly one cast form");
    same(rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "x", quote: "三色院菫子は本を読んでいた。" }).refusal.rule, "relation-certainty-names-no-addressee", "and `measured` with no addressee is refused: the level is defined by the name not being the person being spoken to");
    same(rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "x", quote: "これはこの本の中にない。" }).refusal.rule, "relation-quote-not-in-this-volume", "and a line the volume does not print is refused before the level is ever reached");

    // `addressee-risk` is the measured failure mode, and it needs an addressee to be a risk about.
    const risk = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "addressee-risk", formUsed: "キミ", statement: "x" });
    ok(risk.filed, `and \`addressee-risk\` files without a line, because the level is about who is being spoken to: ${risk.refusal && risk.refusal.because}`);
    same(rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", channel: "spoken", certainty: "addressee-risk", formUsed: "キミ", statement: "x" }).refusal.rule, "relation-certainty-names-no-addressee", "and a risk about the addressee with no addressee named is a risk about nothing, so it is refused");

    // `reading-resolved` rests on the author's markup, and only on the author's markup.
    const guide = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", channel: "inner-monologue", certainty: "reading-resolved", formUsed: "パンジー", statement: "This identity is known only because the book guided these forms with one reading." });
    ok(guide.filed, "`reading-resolved` files for an identity the book's own pronunciation markup stated");
    const prose = rel.fileRelation(store, { addresser: "如月雨露", addresserKind: "identity", channel: "inner-monologue", certainty: "reading-resolved", formUsed: "ジョーロ", statement: "This identity comes from the glossary's prose, not from the book's markup." });
    same(prose.refusal && prose.refusal.rule, "relation-certainty-has-no-guide-stated-identity", "and it is refused for one joined only by the glossary's model-written prose — which is the whole point of the level existing");
    same(rel.GUIDE_LINK_SOURCE, "ruby-guide", "the source the level leans on is a constant, not a literal in a query");
    ok(rs.IDENTITY_LINK_SOURCES.includes(rel.GUIDE_LINK_SOURCE), "and it is still one of the identity layer's closed source list — if that list ever drops it, this precondition fails loudly rather than silently stopping firing");
    same(rel.identityStatedByGuide(store, identityOf(store, "三色院菫子")), true, "the guide side answers true");
    same(rel.identityStatedByGuide(store, identityOf(store, "如月雨露")), false, "the prose side answers false");

    // A level outside the ladder is refused by name, including the number a model would report.
    for (const bad of ["0.9", "confident", "high", "", "measured-ish"]) {
      const refused = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: bad, formUsed: "テメェ", statement: "x", quote: "三色院菫子は本を読んでいた。" });
      same(refused.refusal && refused.refusal.rule, "relation-certainty-unknown", `the certainty "${bad}" is refused as not being on the ladder`);
    }
    for (const bad of ["shouting", "thought", "", "narrator"]) {
      const refused = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: bad, certainty: "addressee-risk", formUsed: "テメェ", statement: "x" });
      same(refused.refusal && refused.refusal.rule, "relation-channel-unknown", `the channel "${bad}" is refused as not being on the list`);
    }
    for (const bad of ["person", "cast", "", "identity-ish"]) {
      const refused = rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: bad, addressee: "如月雨露", channel: "spoken", certainty: "addressee-risk", formUsed: "テメェ", statement: "x" });
      same(refused.refusal && refused.refusal.rule, "relation-addresser-kind-unknown", `the addresser kind "${bad}" is refused`);
    }

    // The row's own content is required, because a row that asserts nothing asserts nothing.
    same(rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "addressee-risk", formUsed: "", statement: "x" }).refusal.rule, "relation-names-no-form", "no written form is refused");
    same(rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "addressee-risk", formUsed: "キミ", statement: "   " }).refusal.rule, "relation-states-nothing", "and a blank statement is refused");
    same(rel.fileRelation(store, { addresser: "", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "addressee-risk", formUsed: "キミ", statement: "x" }).refusal.rule, "relation-names-no-addresser", "and an identity kind with no name is refused");
    same(rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "addressee-risk", formUsed: "キミ", statement: "x", chapter: "ch9" }).refusal.rule, "relation-chapter-not-in-this-record", "and a chapter this record never registered is refused");
    same(rel.fileRelation(store, { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "addressee-risk", formUsed: "キミ", statement: "x", establishedVolume: 0 }).refusal.rule, "relation-volume-undecided", "and a volume that is not a volume number is refused");

    const extraction = rs.openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: process.env.SERIES_LOCATION, stage: "extract" });
    try {
      same(rel.fileRelation(extraction, { addresser: "三色院菫子", addresserKind: "identity", channel: "spoken", certainty: "unknown", formUsed: "テメェ", statement: "x" }).refusal.rule, "relation-needs-a-record-handle", "and the extraction handle cannot file a relation at all");
    } finally {
      extraction.close();
    }
    console.log("9. the ladder: 6 levels each with a record-checkable precondition, 2 `measured` refusals, 1 `addressee-risk` refusal, 1 `reading-resolved` accepted on the book's markup and 1 refused on prose alone, 10 vocabulary refusals, 5 content refusals, 1 handle refusal");
  } finally {
    store.close();
  }
}

// ─── 10. the batch half reports the loss in its own column ────────────────────

/** Scenario 10. @returns {Promise<void>} */
async function scenarioBatch() {
  const { store } = await seedFixture("batch");
  try {
    const batch = rel.fileRelations(store, [
      { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "a", quote: "三色院菫子は本を読んでいた。" },
      { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "a again", quote: "三色院菫子は本を読んでいた。" },
      { addresserKind: "narrator", channel: "narration", certainty: "narration", formUsed: "俺", statement: "b" },
      { addresser: "大賀太陽", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "addressee-risk", formUsed: "テメェ", statement: "c" },
      { addresser: "三色院菫子", addresserKind: "identity", channel: "shouting", certainty: "unknown", formUsed: "テメェ", statement: "d" },
    ]);
    same(batch.filedCount, 2, "two filed");
    same(batch.alreadyFiled.length, 1, "one was already there, reported as already rather than as a failure");
    same(batch.namedLimits.length, 1, "one is a named limit — its own column, not buried in the refusals");
    same(batch.namedLimits[0].name, "大賀太陽", "and it names the name");
    same(batch.refusedCount, 1, "and one is a refusal the door actually refused");
    same(batch.refused[0].rule, "relation-channel-unknown", "with its rule attached");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM relations").get().n, 2, "two rows in the table");

    const again = rel.fileRelations(store, [
      { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "a", quote: "三色院菫子は本を読んでいた。" },
      { addresserKind: "narrator", channel: "narration", certainty: "narration", formUsed: "俺", statement: "b" },
    ]);
    same([again.filedCount, again.alreadyFiled.length], [0, 2], "a second pass over the same reading files 0 and reports both as already filed");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM relations").get().n, 2, "and the table is unchanged");
    same(rel.fileRelations(store, []).filedCount, 0, "an empty reading files nothing and is not an error");
    same(rel.fileRelations(store, null).filedCount, 0, "and neither is a missing list");
    console.log("10. the batch half: 2 filed, 1 already, 1 named limit, 1 refused, and a second pass files 0");
  } finally {
    store.close();
  }
}

// ─── 11. the same doors over a book written in another script ─────────────────

/**
 * A volume whose text and names are Latin-script.
 *
 * The fixture machinery is reused and then the source is replaced, because the point is not a different
 * folder shape — it is that every rule in this layer is about a *name*, a *line* and a *span*, and none
 * of them is about the writing system the real books happen to use.
 *
 * @param {string} label @returns {{fx: Object, volumes: Object[]}}
 */
function latinFixture(label) {
  const fx = fixtureStoreSeries(label);
  const source = {
    ch0: ["# Prologue", "Voss walked into the room.", "Hale laughed at the door.", "The teacher struck the board."],
    ch1: ["# Chapter One", "Marchetti read a book by the window.", "Voss said nothing at all.", "Renn waited under the stairs."],
    ch2: ["# Chapter Two", "Vane looked out of the window.", "Marchetti never said why."],
  };
  const base = "test_story(1)";
  const segments = Object.entries(source).map(([id, lines], index) => {
    const file = `${base}-${id}.md`;
    fs.writeFileSync(path.join(fx.volumes[0].dir, file), lines.join("\n") + "\n", "utf8");
    return { id, file, title: lines[0].replace(/^#\s+/, ""), chars: lines.join("\n").length };
  });
  fs.writeFileSync(path.join(fx.volumes[0].dir, `${base}-whole.md`), Object.values(source).flat().join("\n") + "\n", "utf8");
  fs.writeFileSync(
    path.join(fx.volumes[0].dir, `${base}-bundle.meta.json`),
    JSON.stringify({ format: "epub", schema: 6, base, wholeFile: `${base}-whole.md`, segments }, null, 2) + "\n",
    "utf8"
  );
  return fx;
}

/** The Latin-script glossary: two prose-stated links, and one name no link connects. */
const LATIN_GLOSSARY = `# Glossary

_Starter glossary for the other-script fixture._

## Characters

| Japanese | English | Notes |
|---|---|---|
| Voss | Voss | The one the book follows |
| Hale | Hale | Nickname for Voss |
| Marchetti | Marchetti | Reads everything |
| Vane | Vane | Previously listed as Marchetti |
| Renn | Renn | Named once and never again |
`;

/** Scenario 11. @returns {Promise<void>} */
async function scenarioAnotherScript() {
  const fx = latinFixture("another-script");
  const store = rs.openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: fx.dir, stage: "merge" });
  assertInsideFixture(store.file, fx.dir);
  try {
    store.registerVolume({ volume: 1, folder: "Test Story(01)", title: "Test Story" });
    ok(store.registerChaptersFromSource().ok, "the other-script volume registers its chapters");
    const imported = importGlossary(store, LATIN_GLOSSARY);
    same(imported.castRegistered, 5, "and its five names register");
    const links = fileIdentityLinks(store, {});
    ok(links.ok, `the identity door runs over it: ${links.refusal && links.refusal.because}`);
    same(links.characterRowLinks, 2, "two links stated by the glossary's prose, in a script with no pronunciation markup at all");
    same(links.guideLinks, 0, "and none from a harvest, because this book has none");

    const filed = rel.fileRelation(store, { addresser: "Vane", addresserKind: "identity", addressee: "Voss", channel: "spoken", certainty: "measured", formUsed: "quell", statement: "Vane addresses Voss with quell.", chapter: "ch2", quote: "Vane looked out of the window." });
    ok(filed.ok && filed.filed, `the same door files the same shape: ${filed.refusal && filed.refusal.because}`);
    same(filed.filed.evidence[0].quote, "Vane looked out of the window.", "the line was found in this book's own text");
    ok(Number.isInteger(filed.filed.evidence[0].line), `on line ${filed.filed.evidence[0].line}`);

    const closed = rel.closeRelationSpan(store, { establishedVolume: 1, channel: "spoken", formUsed: "quell", addresser: filed.filed.addresser, addressee: filed.filed.addressee, closedByChapter: "ch1", closedByQuote: "Marchetti never said why." });
    ok(closed.ok && closed.closed, `and the span closes on a line of the same book: ${closed.refusal && closed.refusal.because}`);

    const limit = rel.fileRelation(store, { addresser: "Renn", addresserKind: "identity", addressee: "Voss", channel: "spoken", certainty: "addressee-risk", formUsed: "quell", statement: "x" });
    same(limit.ok, false, "and the wall is the same wall: a name with no identity files nothing here too");
    same(limit.namedLimit.name, "Renn", "named, in this script as in that one");

    const narration = rel.fileRelation(store, { addresserKind: "narrator", channel: "narration", certainty: "narration", formUsed: "one", statement: "The narration keeps one person throughout." });
    ok(narration.filed && narration.filed.addresser === null, "and the narration is still a kind with no person behind it");
    same(store.db.prepare("SELECT COUNT(*) AS n FROM cast WHERE key = 'one'").get().n, 0, "with no roster entry invented for the word");
    console.log("11. another script: 5 names, 2 prose-stated links, 1 relation filed, 1 span closed, 1 named limit, 1 narration with no person — 0 rules in this layer name a writing system");
  } finally {
    store.close();
  }
}

// ─── 12. what this slice did not add ──────────────────────────────────────────

/** Folders that are not pipeline code — the same list `test/test-written-forms.js` states. */
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

/** Scenario 12. @returns {void} */
function scenarioNothingAdded() {
  const kinds = Object.keys(FINDING_LEVELS);
  same(kinds.length, 70, "the finding level table is still 70 kinds — this slice added none");
  same(kinds.filter((kind) => /relation|address|span/i.test(kind)), [], "and none of them is a relation kind: a volume whose cast addressed nobody in a form the record could place is a fact about that book, not a defect");
  same(Object.values(FINDING_LEVELS).filter((entry) => entry && entry.level === "STOP").length, 18, "and the level counts are unmoved");

  same(Object.keys(FREEZE_DOORS).length, 12, "the freeze gate is still 12 doors — this slice added none");
  same(Object.keys(FREEZE_DOORS).filter((door) => /relation/i.test(door)), [], "and no door is named for a relation");
  same(Object.keys(STEP_ARTIFACT_SPECS).filter((step) => /relation/i.test(step)), [], "and no step declares a relation artifact");

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  same(Object.keys(packageJson.scripts).filter((name) => /relation/i.test(name)), [], "no new manual command");
  ok(!fs.existsSync(path.join(ROOT, "relations.js")), "and no command module at the repository root");
  same(fs.readdirSync(path.join(ROOT, "system-prompts")).filter((name) => /relation/i.test(name)), [], "and no new prompt file: this slice asks the model nothing");

  const handleLayer = readModuleLayer(ROOT, "utils/reference-store/open.js");
  ok(!/relation/i.test(handleLayer), "the store's handle gained no relation verb — the door is a function, not a write scope");

  const files = pipelineSourceFiles();
  ok(files.length > 300, `the scan sees the pipeline's own code: ${files.length} files`);

  const layerPrefix = path.join(ROOT, "utils", "reference-store", "relations") + path.sep;
  const coverFile = path.join(ROOT, "utils", "reference-store", "relations.js");
  const schemaFile = path.join(ROOT, "utils", "reference-store", "schema.js");
  const barrelFile = path.join(ROOT, "utils", "reference-store.js");

  /** @type {string[]} */ const doorCallers = [];
  /** @type {string[]} */ const tableReaders = [];
  /** @type {string[]} */ const envKnobs = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const insideLayer = file.startsWith(layerPrefix) || file === coverFile;
    if (/\b(fileRelation|fileRelations|closeRelationSpan|relationsInRecord|relationsForIdentity|relationCounts|fileRelationsFromExtraction)\s*\(/.test(text) && !insideLayer) doorCallers.push(path.relative(ROOT, file));
    if (/(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+relations\b/.test(text) && !insideLayer && file !== schemaFile) tableReaders.push(path.relative(ROOT, file));
    if (insideLayer && /process\.env/.test(text)) envKnobs.push(path.relative(ROOT, file));
  }

  same(
    doorCallers,
    ["utils/reference-store/rebuild/filing.js"],
    "exactly one module outside the layer calls the door: `rebuild/filing.js`, the door the stage route and " +
      "`rebuild-voice.js` both file through, and the same one that files the `confirm` kind. No stage, no step, " +
      "no command and no renderer calls it, and the barrel's re-export never calls it either."
  );
  same(
    doorCallers.filter((file) => !/rebuild\/filing\.js$/.test(file)),
    [],
    "and no second producer joined: a module that starts filing acts of address has to be added to this list, in words, by whoever wires it"
  );
  same(tableReaders, [], "and nothing outside the layer and the migration reads or writes the table: no renderer, no audit rule, no presence matcher, no coverage rule, no chapter-facts query, no stage");
  same(envKnobs, [], "and no file in the layer reads an environment variable: every bound in it is a constant, so there is nothing to switch a guard off with");

  // The layer names no language and prints no character of any one script, which is what makes the
  // fixture in scenario 11 more than a courtesy.
  const layerText = readModuleLayer(ROOT, "utils/reference-store/relations.js");
  const cjk = layerText.match(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) || [];
  same(cjk.length, 0, `the layer's own source prints 0 characters of any CJK script (${cjk.length} found) — the rules are about a name, a line and a span`);
  same(layerText.match(/\b(Japanese|English|Chinese|Korean|Latin)\b/g) || [], [], "and names no language either");

  const coverText = fs.readFileSync(coverFile, "utf8");
  ok(/fileRelation/.test(coverText) && /closeRelationSpan/.test(coverText) && /relationsInRecord/.test(coverText) && /RELATION_CERTAINTY_LEVELS/.test(coverText), "the cover re-exports the door, the read and the vocabularies");

  // The barrel is a spread, so a name a submodule forgets disappears from it silently (gotcha 151).
  const coverNames = Object.keys(require(coverFile));
  const missingFromBarrel = coverNames.filter((name) => rs[name] === undefined);
  same(missingFromBarrel, [], `and every one of the cover's ${coverNames.length} names reaches the store's barrel`);
  ok(/__relations/.test(fs.readFileSync(barrelFile, "utf8")), "and the store's barrel re-exports the cover");

  same(rel.RELATION_CHANNELS.length, 5, "5 channels");
  same(rel.RELATION_CERTAINTY_LEVELS.length, 6, "6 certainty levels");
  same(rel.ADDRESSER_KINDS.length, 4, "4 addresser kinds");
  same(rel.ADDRESSEE_KINDS.length, 2, "2 addressee kinds");
  console.log("12. nothing added: 70 finding kinds, 12 freeze doors, 0 new artifact, 0 new command, 0 new prompt, 0 handle verbs, 0 stage callers, 0 readers of the table, 0 environment knobs, 0 CJK characters in the layer");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  await scenarioMigration();
  await scenarioFiling();
  await scenarioIdempotence();
  await scenarioInsertOnly();
  await scenarioCloseReason();
  await scenarioNoForward();
  await scenarioNoInventedPerson();
  await scenarioIdentityKeyed();
  await scenarioCertaintyLadder();
  await scenarioBatch();
  await scenarioAnotherScript();
  scenarioNothingAdded();
  console.log(`\nrelations: ${checks} checks, 0 model calls.`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

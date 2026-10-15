#!/usr/bin/env node
/**
 * test/test-identity-table-isolation.js — the guard plan 06 §10.8 is built on.
 *
 * The identity tables (plan 06 slice 1b) say "these roster names are one character". The account owner
 * accepted them on one condition, stated in the plan as a requirement rather than a preference: **filing
 * a link must not be able to change who a claim lands under.** A merge can do that — it re-points rows a
 * record already published, and on a sealed record it cannot be undone — which is exactly why the identity
 * table was chosen over `cast_merges`.
 *
 * So this suite is not about the identity tables working. It is about everything else not noticing them.
 * Two halves, because a guarantee like this one fails in two different ways:
 *
 *   1. **the source-text scan.** The doors that decide where a claim lands — `name-resolution.js` (whose
 *      answer *is* "who this claim lands under"), `presence.js` (which decides whether a character counts
 *      as present in a chapter), `cast.js` (the roster itself, and the merge door), the extraction
 *      adapter, the facts layer, the integrity/coverage audit, the renderers — must not name the identity
 *      tables or their doors at all. A scan, not a review: the day someone wires a link into name
 *      resolution, this suite is the thing that says so.
 *   2. **the behavioural A/B.** Two fixture stores built the same way, one with every link filed and one
 *      with none. Then the same extraction is imported into both, presence is measured in both, the audit
 *      runs in both, and every artifact is rendered in both. Every one of those answers must come out
 *      identical, and `cast_merges` must be empty in both.
 *
 * The second half is what stops the first from being satisfied by a rename: a module could reach the
 * tables through a helper with an unrelated name, and only the A/B would notice.
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
const { importGlossary, renderGlossary } = require("../utils/reference-store/glossary-adapter");
const { importVoiceExtraction } = require("../utils/reference-store/extraction-adapter");
const { importVoice, renderVoice } = require("../utils/reference-store/voice-adapter");
const { renderRebuiltVoice } = require("../utils/reference-store/rebuild");
const { povClaimsInRecord, renderPovMap } = require("../utils/reference-store/pov-map");
const { resolveExtractionName } = require("../utils/reference-store/name-resolution");
const { recordCastPresence } = require("../utils/reference-store/presence");
const { integrityFindings } = require("../utils/reference-store/integrity");

const { fixtureStoreSeries, assertInsideFixture, EXTRACTION_01 } = require("./fixture-reference-store");

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
 * The glossary both stores import. Identical in both, by construction: the only difference between the
 * two stores is whether the identity door ran.
 */
const GLOSSARY = `# Glossary

_Starter glossary for the isolation suite._

## Characters

| Japanese | English | Notes |
|---|---|---|
| 如月雨露 | Kisaragi Amatsuyu | Protagonist; the narrator |
| ジョーロ | Joro | Nickname for 如月雨露, used constantly by the cast |
| 三色院菫子 | Sanshokuin Sumireko | Library committee |
| パンジー | Pansy | The name the cast uses for her |
| 大賀太陽 | Oga Taiyo | Best friend since junior high; previously listed as サンちゃん |
| サンちゃん | San-chan | The other name for him |

## Terms

| Japanese | English | Notes |
|---|---|---|
| 会計担当 | The Accounting Person | The book says it plainly: 「山田は会計の人である。」 |
`;

/** The voice reference both stores import, so the renderers have something to render. */
const VOICE = `# Character Voice Reference

## Characters

### 如月雨露（ジョーロ）【俺人格】

- **Pronouns**: 一人称は俺。
- **Catchphrases**: 「気にすんな！」はジョーロの定型である。

### 三色院菫子

- **Appears in**: 三色院菫子は本を読んでいた。
`;

/**
 * Every name the identity layer owns. A protected module may not contain any of them.
 *
 * The list is names, not the word "identity": `name-resolution.js` already exports
 * `rosterIdentityConflicts`, and a scan that fired on that would be a scan people learn to ignore.
 */
const IDENTITY_NAMES = [
  "cast_identities",
  "cast_identity_links",
  "fileIdentityLinks",
  "withdrawIdentityLink",
  "castIdentities",
  "castIdentityLinks",
  "castIdentityMembers",
  "identityMemberKeys",
  "identityOfCastKey",
  "unlinkedCastKeys",
  "identityCoverageSummary",
  "IDENTITY_PROSE_SHAPES",
  "IDENTITY_LINK_SOURCES",
  "RUBY_GUIDE_HARVEST_SUFFIX",
  "statedLinksInProse",
  "readRubyGuideHarvests",
  "rubyGuideStatedLinks",
  "characterRowsInRecord",
  "characterRowStatedLinks",
  "castKeysInRecord",
  "liveIdentitiesOf",
  "recountIdentity",
  "foldSmallKana",
  "MIN_LINK_WITHDRAWAL_REASON_CHARS",
];

/**
 * The modules a filed link must not reach.
 *
 * Each one is named with the question it answers, because the point of the list is that these are the
 * doors a claim actually goes through — not a survey of the folder.
 */
const PROTECTED_MODULES = [
  ["utils/reference-store/name-resolution.js", "decides whose roster entry an extraction name lands under"],
  ["utils/reference-store/presence.js", "decides whether a character is present in a chapter"],
  ["utils/reference-store/cast.js", "the roster itself, and the merge door it refuses"],
  ["utils/reference-store/extraction-adapter.js", "files an extraction claim"],
  ["utils/reference-store/facts.js", "inserts, supersedes and seals every row in `facts`"],
  ["utils/reference-store/evidence.js", "checks a claim's quote against the book"],
  ["utils/reference-store/drafting.js", "screens a claim body before it is filed"],
  ["utils/reference-store/glossary-adapter.js", "imports the glossary and renders it"],
  ["utils/reference-store/voice-adapter.js", "imports the voice reference and renders it"],
  ["utils/reference-store/rebuild.js", "renders a volume's reference from its extraction output"],
  ["utils/reference-store/pov-map.js", "renders the point-of-view map"],
  ["utils/reference-store/integrity.js", "the audit, including the coverage rule"],
  ["utils/reference-store/copy-forward.js", "carries one volume's record into the next"],
  ["utils/reference-store/pipeline-store.js", "the stage-facing store doors"],
  ["utils/reference-store/queries.js", "answers a stage's questions about the record"],
];

/**
 * The pronunciation-guide harvest both arms' volume folders hold.
 *
 * Written in BOTH arms on purpose: the file sitting in the folder is not the difference between them.
 * The only difference is whether the door ran. 三色院菫子 → パンジー is the book's own markup stating a
 * link; 如月雨露 → 存在しない名 is the case that must file nothing because the reading is not on the roster.
 */
const HARVEST = {
  schema: 2,
  whatThisIs: "fixture harvest for the isolation suite",
  generatedBy: "test/test-identity-table-isolation.js",
  sourceFile: "test_story(1).epub",
  totals: { guides: 2, rows: 2 },
  guides: [
    { word: "三色院菫子", reading: "パンジー", count: 18, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "三色院菫子", reading: "パンジー" }] },
    { word: "如月雨露", reading: "存在しない名", count: 4, readingScript: "katakana", chapters: ["ch0"], annotated: [{ base: "如月雨露", reading: "存在しない名" }] },
  ],
};

/**
 * Build one fixture store, identically in both arms.
 *
 * @param {string} label - The fixture label, so the two arms cannot collide.
 * @returns {{store: Object, seriesDir: string}}
 */
function buildStore(label) {
  const fx = fixtureStoreSeries(label);
  fs.writeFileSync(path.join(fx.volumes[0].dir, `test_story(1)${rs.RUBY_GUIDE_HARVEST_SUFFIX}`), JSON.stringify(HARVEST, null, 2) + "\n", "utf8");
  const store = rs.openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: fx.dir, stage: "merge" });
  assertInsideFixture(store.file, fx.dir);
  store.registerVolume({ volume: 1, folder: "Test Story(01)", title: "Test Story" });
  const registered = store.registerChaptersFromSource();
  assert.ok(registered.ok, `the fixture chapters should register: ${registered.error}`);
  const imported = importGlossary(store, GLOSSARY);
  assert.ok(imported.castRegistered >= 6, `the fixture glossary should register its Characters rows: ${JSON.stringify(imported.refused.map((r) => r.row.term))}`);
  return { store, seriesDir: fx.dir };
}

/**
 * One wall clock, replaced by one marker.
 *
 * The two arms are built milliseconds apart, so `created_at` and the document-mirror stamp differ
 * between them for a reason that has nothing to do with a link. Every timestamp is therefore replaced
 * by the same marker before the comparison — and the marker COUNT is compared too, so a row that
 * appeared or disappeared cannot hide behind the masking.
 */
const CLOCK = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

/** @param {string} text @returns {string} the same text with every timestamp replaced by `<clock>` */
function maskClocks(text) {
  return String(text).replace(CLOCK, "<clock>");
}
/** @param {string} text @returns {number} how many timestamps the masking replaced */
function clockCount(text) {
  return (String(text).match(/<clock>/g) || []).length;
}

/**
 * A stable digest of everything a claim, a roster entry or a presence measurement lives in.
 *
 * @param {Object} store
 * @returns {Object<string, string>} table name → the JSON of its rows, ordered, clocks masked
 */
function claimDigest(store) {
  const tables = [
    "cast",
    "facts",
    "fact_characters",
    "cast_presence",
    "cast_presence_match",
    "cast_merges",
    "chapters",
    "challenges",
    "document_prose",
    "research_notes",
    "attribution_answers",
  ];
  const out = {};
  for (const table of tables) out[table] = maskClocks(JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
  return out;
}

/**
 * Compare two digests table by table: the masked rows must match, and so must the number of clocks the
 * masking replaced.
 *
 * @param {Object<string, string>} a
 * @param {Object<string, string>} b
 * @param {string} message
 */
function sameDigest(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
  for (const table of Object.keys(a)) {
    ok(
      clockCount(a[table]) === clockCount(b[table]),
      `the ${table} table keeps the same number of timestamps in both records (${clockCount(a[table])} vs ${clockCount(b[table])})`
    );
  }
}

/**
 * Every table in the record except the two identity tables, as one digest.
 *
 * Read off `sqlite_master` rather than a hand-written list, so a table nobody thought to name is still
 * covered — which is the whole point of the check.
 *
 * @param {Object} store
 * @returns {Object<string, string>}
 */
function everythingButIdentity(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  /** @type {Object<string, string>} */
  const out = {};
  for (const table of tables) {
    if (table === "cast_identities" || table === "cast_identity_links") continue;
    out[table] = maskClocks(JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
  }
  return out;
}

// ─── 1. the source-text scan: the claim path never names these tables ──────────

{
  let files = 0;
  for (const [file, why] of PROTECTED_MODULES) {
    const layer = readModuleLayer(ROOT, file);
    const filesInLayer = layer.split("\n").length;
    ok(filesInLayer > 0, `${file} was read`);
    files++;
    for (const name of IDENTITY_NAMES) {
      ok(!layer.includes(name), `${file} must not name "${name}" — ${why}`);
    }
    ok(
      !/require\((["'])[^"']*\/?identity(\/|["'])/.test(layer),
      `${file} must not require the identity layer — ${why}`
    );
  }
  ok(files === PROTECTED_MODULES.length, `every protected module was scanned (${files}/${PROTECTED_MODULES.length})`);
  console.log(`  1. source scan: ${files} module layers, ${IDENTITY_NAMES.length} identity names, 0 mentions, 0 requires`);
}

// ─── 2. the two arms: identical until the door runs, and identical after it ────

const linked = buildStore("isolation-linked");
const plain = buildStore("isolation-plain");

try {
  const beforeLinked = everythingButIdentity(linked.store);
  const beforePlain = everythingButIdentity(plain.store);
  sameDigest(beforeLinked, beforePlain, "the two arms start identical outside the identity tables");
  same(linked.store.castIdentities(), [], "and neither has an identity yet");

  const filed = linked.store.fileIdentityLinks();
  ok(filed.ok && filed.linksFiled > 0, `the linked arm files its stated links: ${filed.linksFiled}`);
  same([filed.rubyGuideLinks, filed.characterRowLinks], [1, 2], "and both sources contributed: the book's markup and the record's own rows");
  ok(linked.store.castIdentities().length > 0, "and the identity table is not empty — the comparison is not vacuous");
  same(plain.store.castIdentities(), [], "while the other arm still has none");

  const afterLinked = everythingButIdentity(linked.store);
  sameDigest(afterLinked, beforeLinked, "filing every link changed nothing outside the two identity tables");
  sameDigest(afterLinked, everythingButIdentity(plain.store), "so the two records are still identical outside them");

  const linkedTables = linked.store.db
    .prepare("SELECT COUNT(*) n FROM cast_identities")
    .get().n;
  const linkedLinks = linked.store.db.prepare("SELECT COUNT(*) n FROM cast_identity_links").get().n;
  ok(linkedLinks > 0 && linkedTables > 0, `the identity tables hold ${linkedTables} identities / ${linkedLinks} links`);
  console.log(`  2. the door writes its two tables and nothing else: ${linkedTables} identities, ${linkedLinks} links, ${Object.keys(afterLinked).length} other tables unchanged`);

  // ─── 3. who a claim lands under: asked directly, in both arms ────────────────

  const names = EXTRACTION_01.map((entry) => entry.character || entry.assignedCharacter || "").filter(Boolean);
  ok(names.length >= 5, `the fixture extraction names ${names.length} characters`);
  const answersLinked = names.map((name) => {
    const a = resolveExtractionName(linked.store, name);
    return { name, key: a.key, resolved: a.resolved, how: a.how, unattached: a.unattached, ambiguous: a.ambiguous };
  });
  const answersPlain = names.map((name) => {
    const a = resolveExtractionName(plain.store, name);
    return { name, key: a.key, resolved: a.resolved, how: a.how, unattached: a.unattached, ambiguous: a.ambiguous };
  });
  same(answersLinked, answersPlain, "resolveExtractionName gives the same answer in both arms, for every name");
  const resolved = answersLinked.filter((a) => a.resolved);
  ok(resolved.length >= 3, `and the fixture actually resolves names onto the roster (${resolved.length}), so the comparison is not vacuous`);
  const linkedMembers = new Set();
  for (const identity of linked.store.castIdentities()) for (const key of identity.memberKeys) linkedMembers.add(key);
  ok(
    resolved.some((a) => linkedMembers.has(a.key)),
    `and at least one answer lands on a roster entry an identity links (${[...linkedMembers].join(", ")})`
  );
  console.log(`  3. name resolution: ${answersLinked.length} name(s) asked, ${resolved.length} resolved, identical in both arms`);

  // ─── 4. filing the claims, in both arms ──────────────────────────────────────

  const importLinked = importVoiceExtraction(linked.store, EXTRACTION_01);
  const importPlain = importVoiceExtraction(plain.store, EXTRACTION_01);
  same(importLinked.imported.length, importPlain.imported.length, "both arms filed the same number of claims");
  same(
    importLinked.imported.map((f) => `${f.id}|${f.key ?? "∅"}|${f.aspect}|${f.section}`),
    importPlain.imported.map((f) => `${f.id}|${f.key ?? "∅"}|${f.aspect}|${f.section}`),
    "and every claim landed under the same roster entry in both arms"
  );
  same(importLinked.refused.map((r) => r.kind), importPlain.refused.map((r) => r.kind), "and both refused the same ones");
  same(importLinked.unresolved, importPlain.unresolved, "and both named the same unresolved names");

  const presenceLinked = recordCastPresence(linked.store);
  const presencePlain = recordCastPresence(plain.store);
  same(presenceLinked, presencePlain, "presence measurement gives the same answer in both arms");

  importVoice(linked.store, VOICE);
  importVoice(plain.store, VOICE);

  const digestLinked = claimDigest(linked.store);
  const digestPlain = claimDigest(plain.store);
  for (const table of Object.keys(digestLinked)) {
    same(digestLinked[table], digestPlain[table], `the ${table} table is identical in both arms`);
    ok(
      clockCount(digestLinked[table]) === clockCount(digestPlain[table]),
      `and ${table} keeps the same number of timestamps (${clockCount(digestLinked[table])})`
    );
  }
  const merges = JSON.parse(digestLinked.cast_merges);
  same(merges.length, 0, "cast_merges is empty in the arm that filed every link");
  const mergedInto = linked.store.db.prepare("SELECT COUNT(*) n FROM cast WHERE merged_into IS NOT NULL").get().n;
  same(mergedInto, 0, "and no roster entry is marked merged_into there");
  console.log(`  4. claims filed: ${importLinked.imported.length} in each arm, identical rows across ${Object.keys(digestLinked).length} tables, 0 merges`);

  // ─── 5. the audit says the same thing in both arms ───────────────────────────

  const auditLinked = integrityFindings(linked.store, { volume: "1", publishedVolume: 1 });
  const auditPlain = integrityFindings(plain.store, { volume: "1", publishedVolume: 1 });
  const shape = (audit) => audit.findings.map((f) => `${f.severity}|${f.kind}|${f.volume}|${f.file}|${f.message}`);
  same(shape(auditLinked), shape(auditPlain), "the integrity audit reports the same findings in both arms");
  same(auditLinked.ok, auditPlain.ok, "and the same verdict");
  const coverage = auditLinked.findings.filter((f) => /coverage|uncovered|roster|character/i.test(f.kind));
  ok(coverage.length > 0, `and the audit actually asks its character questions (${coverage.map((f) => f.kind).join(", ")})`);
  console.log(
    `  5. the audit: ${auditLinked.findings.length} finding(s) — ${auditLinked.findings.map((f) => f.kind).join(", ")} — the same in both arms`
  );

  // ─── 6. the artifacts render byte-identical ──────────────────────────────────

  const glossaryLinked = renderGlossary(linked.store, { volume: 1 });
  const glossaryPlain = renderGlossary(plain.store, { volume: 1 });
  same(glossaryLinked, glossaryPlain, "the rendered glossary is byte-identical in both arms");
  ok(glossaryLinked.length > 200, `and it is a real document (${glossaryLinked.length} characters), not an empty render`);

  const voiceLinked = renderVoice(linked.store);
  const voicePlain = renderVoice(plain.store);
  same(voiceLinked, voicePlain, "the rendered voice reference is byte-identical in both arms");

  const rebuiltLinked = renderRebuiltVoice(linked.store, { volume: 1 });
  const rebuiltPlain = renderRebuiltVoice(plain.store, { volume: 1 });
  same(rebuiltLinked, rebuiltPlain, "the rebuilt voice reference is byte-identical in both arms");

  const povLinked = povClaimsInRecord(linked.store, { volume: 1 });
  const povPlain = povClaimsInRecord(plain.store, { volume: 1 });
  same(povLinked, povPlain, "the POV claims are the same in both arms");
  const mapLinked = renderPovMap(linked.store, { volume: 1 });
  const mapPlain = renderPovMap(plain.store, { volume: 1 });
  same(mapLinked, mapPlain, "and the POV map they render is identical in both arms");

  console.log(
    `  6. artifacts: glossary ${glossaryLinked.length} B, voice ${voiceLinked.length} B, ` +
      `rebuilt ${rebuiltLinked.markdown.length} B, POV map ${mapLinked.markdown.length} B (${mapLinked.claims} claims) — all identical in both arms`
  );

  // ─── 7. and the identity arm still answers its own question ──────────────────

  const summary = linked.store.identityCoverageSummary();
  same(summary.rosterEntries, plain.store.db.prepare("SELECT COUNT(*) n FROM cast").get().n, "the roster is the same size in both arms");
  ok(summary.identities > 0 && summary.linkedEntries > 0, `the linked arm groups ${summary.identities} identities over ${summary.linkedEntries} entries`);
  same(
    linked.store.db.prepare("SELECT key FROM cast ORDER BY key").all().map((r) => r.key),
    plain.store.db.prepare("SELECT key FROM cast ORDER BY key").all().map((r) => r.key),
    "and the roster keys are the same names in the same order"
  );
  console.log(
    `  7. the roster: ${summary.rosterEntries} entries, ${summary.identities} identities, ` +
      `${summary.duplicateEntries} duplicate entries, ${summary.unlinkedEntries} unlinked — same roster in both arms`
  );
} finally {
  for (const arm of [linked, plain]) {
    try {
      arm.store.close();
    } catch {
      /* already closed */
    }
  }
}

console.log(`identity isolation: ${checks} checks, 0 model calls.`);

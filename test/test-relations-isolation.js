#!/usr/bin/env node
/**
 * test/test-relations-isolation.js — the guard plan 07 slice 3 is built on.
 *
 * A relation says *who addressed whom, in which form, over which volumes*. That is a claim about
 * people, and this store already has two ways a claim about people can move another claim: a
 * `cast_merges` row re-points rows a record published (gotcha 105), and an identity group changes what
 * "is this name inside a group" answers. Both were pinned by their own isolation suite for exactly that
 * reason.
 *
 * So this suite is not about the relations table working — `test/test-relations-table.js` is that. It is
 * about **everything else not noticing it**, in the two ways a guarantee like this one fails:
 *
 *   1. **the source-text scan.** The doors a claim actually goes through — name resolution, presence,
 *      the roster, the facts layer, the evidence check, the audit, the renderers, the chapter-facts
 *      query, the two reading passes, the settled-glossary read, the store's handle — must not name a
 *      relations table, a relations door or a relations vocabulary at all. A scan, not a review: the day
 *      somebody wires an act of address into the coverage rule, this suite is the thing that says so.
 *   2. **the behavioural A/B.** Two fixture records built the same way, one with every relation filed
 *      and one with none. Then the same extraction is imported into both, presence is measured in both,
 *      the audit runs in both, the chapter block is built in both, and every artifact is rendered in
 *      both. Every one of those answers must come out identical, and the only table allowed to differ is
 *      `relations`.
 *
 * The second half is what stops the first from being satisfied by a rename: a module could reach the
 * rows through a helper with an unrelated name, and only the A/B would notice.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any
 * file under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69).
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
const { chapterKnownFacts } = require("../utils/reference-store/chapter-facts");
const { buildKnownFactsBlock } = require("../character-voice/known-facts");
const { fileVolumeWrittenForms } = require("../utils/reference-store/written-forms");
const { fileIdentityLinks, identityCoverageSummary } = require("../utils/reference-store/identity");
const { RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");
const { fixtureStoreSeries, assertInsideFixture, EXTRACTION_01 } = require("./fixture-reference-store");

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

/**
 * Every name the relations layer owns. A protected module may not contain any of them.
 *
 * The table name is in the list, and so is every exported door and vocabulary: a module that reaches a
 * relation through a helper with a friendlier name is caught by the A/B half, not by this one.
 */
const RELATION_NAMES = [
  "relations",
  "fileRelation",
  "fileRelations",
  "closeRelationSpan",
  "closeRelationSpanRow",
  "relationsInRecord",
  "relationsForIdentity",
  "relationCounts",
  "relationById",
  "relationAlreadyFiled",
  "insertRelationRow",
  "mapRelationRow",
  "relationKeyOf",
  "RELATION_COLUMNS",
  "RELATION_KEY_WHERE",
  "RELATION_CHANNELS",
  "RELATION_CERTAINTY_LEVELS",
  "RELATION_CERTAINTY_PRECONDITIONS",
  "RELATION_CERTAINTY_PARTY_KINDS",
  "RELATION_CHANNEL_PARTY_KINDS",
  "RELATION_TABLE_COLUMNS",
  "RELATION_CLOSE_COLUMNS",
  "RELATION_INSERT_ONLY_COLUMNS",
  "RELATION_KEY_COLUMNS",
  "ADDRESSER_KINDS",
  "ADDRESSEE_KINDS",
  "GUIDE_LINK_SOURCE",
  "isRelationValue",
  "channelAcceptsPartyKind",
  "certaintyAcceptsPartyKind",
  "partyKindsAllowedByChannel",
  "partyKindsAllowedByCertainty",
  "identitiesOfParty",
  "identityStatedByGuide",
  "registeredChapterIds",
  "citationForQuote",
];

/**
 * The modules a filed relation must not reach.
 *
 * Each one is named with the question it answers, because the point of the list is that these are the
 * doors a claim, a roster entry and a published artifact actually go through — not a survey of the
 * folder.
 */
const PROTECTED_MODULES = [
  ["utils/reference-store/name-resolution.js", "decides whose roster entry an extraction name lands under"],
  ["utils/reference-store/presence.js", "decides whether a character is present in a chapter"],
  ["utils/reference-store/cast.js", "the roster itself, and the merge door it refuses"],
  ["utils/reference-store/facts.js", "inserts, supersedes and seals every row in `facts`"],
  ["utils/reference-store/evidence.js", "checks a claim's quote against the book"],
  ["utils/reference-store/drafting.js", "screens a claim body before it is filed"],
  ["utils/reference-store/glossary-adapter.js", "imports the glossary and renders it"],
  ["utils/reference-store/voice-adapter.js", "imports the voice reference and renders it"],
  ["utils/reference-store/extraction-adapter.js", "files an extraction claim"],
  ["utils/reference-store/rebuild.js", "renders a volume's reference from its extraction output"],
  ["utils/reference-store/pov-map.js", "renders the point-of-view map"],
  ["utils/reference-store/confirmations.js", "files the observation that a claim still holds"],
  ["utils/reference-store/voice-revision.js", "replaces one register answer with a later volume's"],
  ["utils/reference-store/identity.js", "the identity tables this layer keys its parties on"],
  ["utils/reference-store/written-forms.js", "the written forms the identity door groups"],
  ["utils/reference-store/register.js", "the register questions a series declares"],
  ["utils/reference-store/integrity.js", "the audit, including the coverage rule"],
  ["utils/reference-store/chapter-facts.js", "answers which recorded facts belong to this chapter"],
  ["utils/reference-store/queries.js", "answers a stage's questions about the record"],
  ["utils/reference-store/copy-forward.js", "carries one volume's record into the next"],
  ["utils/reference-store/pipeline-store.js", "the stage-facing store doors"],
  ["utils/reference-store/open.js", "the store's handle, and every verb it exposes"],
  ["character-voice/reading.js", "the voice stage's paid reading pass"],
  ["character-voice/known-facts.js", "renders what a chapter is shown as already known"],
  ["glossary/extract.js", "the glossary stage's paid reading pass"],
  ["glossary/store.js", "files the glossary stage's terms into the record"],
  ["utils/translate/settled-glossary.js", "the render of the settled record a translator is handed"],
];

/** The glossary both arms import. Identical by construction. */
const GLOSSARY = `# Glossary

_Starter glossary for the relations isolation suite._

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

/** The voice reference both arms import, so the renderers have something to render. */
const VOICE = `# Character Voice Reference

## Characters

### 如月雨露（ジョーロ）【俺人格】

- **Pronouns**: 一人称は俺。
- **Catchphrases**: 「気にすんな！」はジョーロの定型である。

### 三色院菫子

- **Appears in**: 三色院菫子は本を読んでいた。
`;

/** The harvest both arms write AND file, so the written-form rows are shared starting state. */
const HARVEST = {
  schema: 2,
  whatThisIs: "fixture harvest for the relations isolation suite",
  generatedBy: "test/test-relations-isolation.js",
  sourceFile: "test_story(1).epub",
  guides: [
    { word: "三色院菫子", reading: "パンジー", count: 12, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "三色院菫子", reading: "パンジー" }] },
    { word: "虹彩寺菫", reading: "パンジー", count: 5, readingScript: "katakana", chapters: ["ch2"], annotated: [{ base: "虹彩寺菫", reading: "パンジー" }] },
  ],
};

/**
 * The relations one arm files and the other does not.
 *
 * Four of them, covering the shapes that could plausibly reach something else: a person addressing a
 * person, the narration addressing nobody, a withheld speaker addressing a named person, and an admitted
 * gap. Then one span is closed with a line the volume prints.
 */
const RELATIONS = [
  { addresser: "三色院菫子", addresserKind: "identity", addressee: "如月雨露", channel: "spoken", certainty: "measured", formUsed: "テメェ", statement: "三色院菫子 addresses 如月雨露 with テメェ.", chapter: "ch1", quote: "三色院菫子は本を読んでいた。" },
  { addresserKind: "narrator", channel: "narration", certainty: "narration", formUsed: "俺", statement: "The narration speaks in 俺.", chapter: "ch0" },
  { addresserKind: "withheld", addressee: "如月雨露", channel: "withheld", certainty: "withheld", formUsed: "テメェ", statement: "Somebody addresses 如月雨露 and the book does not say who." },
  { addresser: "如月雨露", addresserKind: "identity", channel: "self-address", certainty: "addressee-risk", formUsed: "俺", statement: "如月雨露 addresses himself as 俺." },
];

/**
 * Build one fixture store, identically in both arms.
 *
 * Both arms write the harvest, file its rows and file their identity links: the roster, the written
 * forms and the identities are the shared starting state, and the only thing that differs between the
 * arms is whether the relations door ran.
 *
 * @param {string} label - The fixture label, so the two arms cannot collide.
 * @returns {Promise<{store: Object, seriesDir: string}>}
 */
async function buildStore(label) {
  const fx = fixtureStoreSeries(`relations-isolation-${label}`);
  fs.writeFileSync(path.join(fx.volumes[0].dir, `test_story(1)${RUBY_GUIDE_FILE_SUFFIX}`), JSON.stringify(HARVEST, null, 2) + "\n", "utf8");
  const store = rs.openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: fx.dir, stage: "merge" });
  assertInsideFixture(store.file, fx.dir);
  store.registerVolume({ volume: 1, folder: "Test Story(01)", title: "Test Story" });
  const registered = store.registerChaptersFromSource();
  assert.ok(registered.ok, `the fixture chapters should register: ${registered.error}`);
  const imported = importGlossary(store, GLOSSARY);
  assert.ok(imported.castRegistered >= 5, `the fixture glossary should register its Characters rows: ${JSON.stringify(imported.refused.map((r) => r.row && r.row.term))}`);
  const forms = await fileVolumeWrittenForms(store, {});
  assert.ok(forms.ok && forms.rowsFiled === HARVEST.guides.length, `both arms file the same written-form rows: ${forms.refusal && forms.refusal.because}`);
  const links = fileIdentityLinks(store, {});
  assert.ok(links.ok && links.linksFiled >= 2, `both arms file the same identity links: ${links.refusal && links.refusal.because}`);
  return { store, seriesDir: fx.dir };
}

/** One wall clock, replaced by one marker. @param {string} text @returns {string} */
const CLOCK = /\d{4}-\d-05T\d{2}:\d{2}:\d{2}\.\d{3}Z|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
/** @param {string} text @returns {string} the same text with every timestamp replaced by `<clock>` */
function maskClocks(text) {
  return String(text).replace(CLOCK, "<clock>");
}
/** @param {string} text @returns {number} how many timestamps the masking replaced */
function clockCount(text) {
  return (String(text).match(/<clock>/g) || []).length;
}

/**
 * Every table in the record except `relations`, as one digest.
 *
 * Read off `sqlite_master` rather than a hand-written list, so a table nobody thought to name is still
 * covered — which is the whole point of the check.
 *
 * @param {Object} store @returns {Object<string, string>}
 */
function everythingButRelations(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  /** @type {Object<string, string>} */
  const out = {};
  for (const table of tables) {
    if (table === "relations") continue;
    out[table] = maskClocks(JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
  }
  return out;
}

/**
 * Compare two digests table by table: the masked rows must match, and so must the number of clocks the
 * masking replaced.
 *
 * @param {Object<string, string>} a @param {Object<string, string>} b @param {string} message
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

// ─── 1. the source-text scan: the claim path never names these ────────────────

{
  let files = 0;
  let mentions = 0;
  for (const [file, why] of PROTECTED_MODULES) {
    const layer = readModuleLayer(ROOT, file);
    ok(layer.split("\n").length > 0, `${file} was read`);
    files++;
    for (const name of RELATION_NAMES) {
      if (layer.includes(name)) {
        mentions++;
        assert.ok(false, `${file} must not name "${name}" — ${why}`);
      }
    }
    ok(!/require\((["'])[^"']*\/?relations(\/|["'])/.test(layer), `${file} must not require the relations layer — ${why}`);
    ok(!/(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+relations\b/.test(layer), `${file} must not read or write the relations table — ${why}`);
  }
  ok(files === PROTECTED_MODULES.length, `every protected module was scanned (${files}/${PROTECTED_MODULES.length})`);
  ok(mentions === 0, `and ${RELATION_NAMES.length} relations names appear 0 times across them`);
  console.log(`  1. source scan: ${files} module layers, ${RELATION_NAMES.length} relations names, 0 mentions, 0 requires, 0 reads of the table`);
}

// ─── 2. the two arms ──────────────────────────────────────────────────────────

async function main() {
  const filed = await buildStore("relations");
  const plain = await buildStore("none");

  try {
    const beforeFiled = everythingButRelations(filed.store);
    const beforePlain = everythingButRelations(plain.store);
    sameDigest(beforeFiled, beforePlain, "the two arms start identical");
    same(rel.relationCounts(filed.store).total, 0, "and neither holds a relation yet");

    const batch = rel.fileRelations(filed.store, RELATIONS);
    same(batch.filedCount, 4, "the relations arm files all four acts");
    same([batch.refusedCount, batch.namedLimits.length], [0, 0], "and none of them hits the identity wall or a vocabulary refusal");
    const closed = rel.closeRelationSpan(filed.store, {
      establishedVolume: 1,
      channel: "spoken",
      formUsed: "テメェ",
      addresser: rel.identitiesOfParty(filed.store, "三色院菫子").identities[0].identity,
      addressee: rel.identitiesOfParty(filed.store, "如月雨露").identities[0].identity,
      closedByChapter: "ch2",
      closedByQuote: "ジョーロは窓を見た。",
    });
    ok(closed.ok && closed.closed, `and closes one span with a line the volume prints: ${closed.refusal && closed.refusal.because}`);

    const counts = rel.relationCounts(filed.store);
    same([counts.total, counts.open, counts.closed, counts.partiesWithoutIdentity], [4, 3, 1, 2], "the relations arm holds 4 relations, 1 closed span and 2 parties with no identity");
    same(rel.relationCounts(plain.store).total, 0, "while the other arm, holding the same roster and the same identities, holds none: the door never ran there");

    sameDigest(everythingButRelations(filed.store), beforeFiled, "filing and closing changed nothing outside the relations table");
    sameDigest(everythingButRelations(filed.store), everythingButRelations(plain.store), "so the two records are still identical outside it");
    const otherTables = Object.keys(everythingButRelations(filed.store)).length;
    console.log(`  2. the door writes one table and nothing else: 4 relations, 1 closed span, ${otherTables} other tables unchanged`);

    // ─── 3. who a claim lands under: asked directly, in both arms ──────────────
    const names = EXTRACTION_01.map((entry) => entry.character || entry.assignedCharacter || "").filter(Boolean);
    ok(names.length >= 5, `the fixture extraction names ${names.length} characters`);
    const answersOf = (store) =>
      names.map((name) => {
        const a = resolveExtractionName(store, name);
        return { name, key: a.key, resolved: a.resolved, how: a.how, unattached: a.unattached, ambiguous: a.ambiguous };
      });
    const answersFiled = answersOf(filed.store);
    const answersPlain = answersOf(plain.store);
    same(answersFiled, answersPlain, "resolveExtractionName gives the same answer in both arms, for every name");
    ok(answersFiled.filter((a) => a.resolved).length >= 3, `and the fixture actually resolves names onto the roster (${answersFiled.filter((a) => a.resolved).length}), so the comparison is not vacuous`);
    console.log(`  3. name resolution: ${names.length} name(s) asked, ${answersFiled.filter((a) => a.resolved).length} resolved, identical in both arms`);

    // ─── 4. filing the claims, and measuring presence, in both arms ────────────
    const importFiled = importVoiceExtraction(filed.store, EXTRACTION_01);
    const importPlain = importVoiceExtraction(plain.store, EXTRACTION_01);
    same(importFiled.imported.length, importPlain.imported.length, "both arms filed the same number of claims");
    same(
      importFiled.imported.map((f) => `${f.id}|${f.key ?? "∅"}|${f.aspect}|${f.section}`),
      importPlain.imported.map((f) => `${f.id}|${f.key ?? "∅"}|${f.aspect}|${f.section}`),
      "and every claim landed under the same roster entry in both arms"
    );
    same(importFiled.refused.map((r) => r.kind), importPlain.refused.map((r) => r.kind), "and both refused the same ones");
    same(importFiled.unresolved, importPlain.unresolved, "and both named the same unresolved names");

    same(recordCastPresence(filed.store), recordCastPresence(plain.store), "presence measurement gives the same answer in both arms");

    importVoice(filed.store, VOICE);
    importVoice(plain.store, VOICE);
    sameDigest(everythingButRelations(filed.store), everythingButRelations(plain.store), "and after the claims are filed the records are still identical outside the relations table");
    console.log(`  4. claims: ${importFiled.imported.length} filed, ${importFiled.refused.length} refused, identical in both arms`);

    // ─── 5. the audit and the chapter block, in both arms ──────────────────────
    const auditFiled = integrityFindings(filed.store, { volume: "1", step: "character-voice" });
    const auditPlain = integrityFindings(plain.store, { volume: "1", step: "character-voice" });
    same(auditFiled.findings.map((f) => [f.severity, f.kind, f.file]), auditPlain.findings.map((f) => [f.severity, f.kind, f.file]), "the audit reports the same findings in both arms");
    same(auditFiled.ok, auditPlain.ok, "and agrees about whether the volume is clean");
    /** Every counted table except the one this slice added. */
    const countsOf = (audit) => Object.fromEntries(Object.entries(audit.counts).filter(([table]) => table !== "relations"));
    same(countsOf(auditFiled), countsOf(auditPlain), "and every counted table except the new one holds the same number of rows in both arms");
    same([auditFiled.counts.relations, auditPlain.counts.relations], [4, 0], "while the new table is the one place they are allowed to differ — 4 relations against 0, and it is in the counted list because copy-forward has to carry it");

    const chapterText = fs.readFileSync(path.join(filed.store.volumeDir, "test_story(1)-ch1.md"), "utf8");
    const queryFiled = chapterKnownFacts(filed.store, { chapterText });
    const queryPlain = chapterKnownFacts(plain.store, { chapterText });
    same(queryFiled, queryPlain, "the query underneath the block answers the same in both arms");
    const blockFiled = buildKnownFactsBlock(queryFiled);
    const blockPlain = buildKnownFactsBlock(queryPlain);
    same(blockFiled, blockPlain, "and the block a chapter is shown is byte-identical in both arms");
    ok(blockFiled.text.length > 0, `and it is a real block (${blockFiled.text.length} characters), not an empty one`);
    console.log(`  5. audit + chapter block: ${auditFiled.findings.length} finding(s), ${auditFiled.counts.relations ?? 0} vs ${auditPlain.counts.relations ?? 0} relations, block ${blockFiled.text.length} characters, identical`);

    // ─── 6. the artifacts render byte-identical ────────────────────────────────
    const glossaryFiled = renderGlossary(filed.store, { volume: 1 });
    const glossaryPlain = renderGlossary(plain.store, { volume: 1 });
    same(glossaryFiled, glossaryPlain, "the rendered glossary is byte-identical in both arms");
    ok(glossaryFiled.length > 200, `and it is a real document (${glossaryFiled.length} characters), not an empty render`);

    const voiceFiled = renderVoice(filed.store);
    const voicePlain = renderVoice(plain.store);
    same(voiceFiled, voicePlain, "the rendered voice reference is byte-identical in both arms");
    ok(!/テメェ/.test(voiceFiled), "and no act of address reached it: the form the relations arm filed appears nowhere in the published reference");

    const rebuiltFiled = renderRebuiltVoice(filed.store, { volume: 1 });
    const rebuiltPlain = renderRebuiltVoice(plain.store, { volume: 1 });
    same(rebuiltFiled.markdown, rebuiltPlain.markdown, "the rebuilt voice reference is byte-identical in both arms");

    const povFiled = povClaimsInRecord(filed.store, { volume: 1 });
    const povPlain = povClaimsInRecord(plain.store, { volume: 1 });
    same(povFiled, povPlain, "the POV claims are the same in both arms");
    const mapFiled = renderPovMap(filed.store, { volume: 1 });
    const mapPlain = renderPovMap(plain.store, { volume: 1 });
    same(mapFiled.markdown, mapPlain.markdown, "and the POV map they render is identical in both arms");

    console.log(
      `  6. artifacts: glossary ${glossaryFiled.length} B, voice ${voiceFiled.length} B, ` +
        `rebuilt ${rebuiltFiled.markdown.length} B, POV map ${mapFiled.markdown.length} B (${mapFiled.claims} claims) — all identical in both arms`
    );

    // ─── 7. the roster and the identities are untouched by the relations arm ───
    const summaryFiled = identityCoverageSummary(filed.store);
    const summaryPlain = identityCoverageSummary(plain.store);
    same(summaryFiled, summaryPlain, "the roster groups exactly the same in both arms");
    ok(summaryFiled.identities > 0 && summaryFiled.linkedEntries > 0, `both arms group ${summaryFiled.identities} identities over ${summaryFiled.linkedEntries} entries, so the comparison is not vacuous`);
    same(
      filed.store.db.prepare("SELECT key FROM cast ORDER BY key").all().map((r) => r.key),
      plain.store.db.prepare("SELECT key FROM cast ORDER BY key").all().map((r) => r.key),
      "and the roster keys are the same names in the same order"
    );
    same(filed.store.db.prepare("SELECT COUNT(*) n FROM cast_merges").get().n, 0, "and no merge row appeared in either arm");
    console.log(
      `  7. the roster: ${summaryFiled.rosterEntries} entries, ${summaryFiled.identities} identities, ` +
        `${summaryFiled.linkedEntries} linked, ${summaryFiled.unlinkedEntries} unlinked — same roster in both arms, 0 merges`
    );
  } finally {
    for (const arm of [filed, plain]) {
      try {
        arm.store.close();
      } catch {
        /* already closed */
      }
    }
  }

  console.log(`relations isolation: ${checks} checks, 0 model calls.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

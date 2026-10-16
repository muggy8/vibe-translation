#!/usr/bin/env node
/**
 * test/test-relation-contract.js — plan 07 slice 4: an act of address arrives in the chapter call that
 * already runs, and the record decides how sure it is about who is speaking.
 *
 * The acceptance line, from the plan's slice-4 row:
 *
 *   "Pass 1 files relations; a second pass over the same fixture pays **0 calls** and files 0; a planted
 *    'the name in the quote is the addressee' case comes back **`addressee-risk`**, not `measured`; a
 *    chapter that names nobody files nothing and is **named, not punished**."
 *
 * Every one of those four is measured here, and the second one is measured through the stage's own reading
 * pass with a counting stub in place of the backend — the same shape `test/test-voice-confirmations.js`
 * uses — because "0 extra model calls" is only a number if somebody counts the calls.
 *
 * Scenarios:
 *
 *   1. **the acceptance line** — one fixture volume read chapter by chapter, filed, and read again. Pass 1
 *      pays one call per chapter and files five acts of address at four different levels. Pass 2 pays
 *      **0 calls**, files **0**, reports all five as already filed, and leaves every other table byte for
 *      byte.
 *   2. **the ladder, rung by rung** — `certaintyOfObservation` asked directly, including the two rungs that
 *      answer `null` and the reason each one gives.
 *   3. **the planted case comes back `addressee-risk`** — the same line, the same channel, the same form,
 *      the parties swapped: one row says `measured`, the other says `addressee-risk`, and the second is not
 *      a softer version of the first but the name of the failure plan 07 §2.9 measured ten times in one
 *      volume (gotcha 121).
 *   4. **a gap files with no person** — `narration`, `withheld` and `unknown` each file a row with a null
 *      party beside a named kind, and no `cast` row and no `cast_identities` row appears anywhere.
 *   5. **a chapter that names nobody is named, not punished** — a chapter whose own text names no roster
 *      entry, and a chapter that reported no act at all, both printed in the report, neither turned into a
 *      finding.
 *   6. **the limits are named and nothing is invented** — a party this record has no identity for is
 *      reported with the door's own rule, and the roster and the identity tables come out the same size
 *      they went in.
 *   7. **an entry the ladder cannot level is named with the rung that failed** — three shapes, each with its
 *      reason in the report, none filed.
 *   8. **the door's refusals reach the report** — a channel outside the vocabulary, and a name offered
 *      beside a gap.
 *   9. **nothing else notices** — every table except `relations` identical, the published reference
 *      byte-identical, the audit's findings identical, and the door that reads the extraction notebook
 *      recognises the kind and files nothing.
 *  10. **what this slice did not add** — no finding kind, no level, no freeze door, no table, no schema
 *      bump, no handle verb, no command, no setting, no environment knob, no model call, no CJK character
 *      in the contract, and nothing published.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model: the harness is a counting stub (AGENTS.md
 * rule 8, gotcha 69, gotcha 124).
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const harness = require("../harness");
const rs = require("../utils/reference-store");
const { importGlossary } = require("../utils/reference-store/glossary-adapter");
const { importVoiceExtraction } = require("../utils/reference-store/extraction-adapter");
const { fileVolumeWrittenForms } = require("../utils/reference-store/written-forms");
const { fileIdentityLinks } = require("../utils/reference-store/identity");
const { renderRebuiltVoice } = require("../utils/reference-store/rebuild");
const { integrityFindings } = require("../utils/reference-store/integrity");
const { RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { FREEZE_DOORS } = require("../utils/prereqs/freeze");
const { readModuleLayer } = require("./module-layer");
const { fixtureStoreSeries, assertInsideFixture } = require("./fixture-reference-store");

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
 * The glossary the fixture record imports.
 *
 * Six of these names are the book's own, and three of them (ジョーロ / サンちゃん / パンジー) are nicknames
 * the book prints **over somebody's head** rather than in the prose — which is why two of them are refused
 * as glossary *terms* by the evidence rule and still registered as roster entries. That is the real shape
 * of a nickname in this corpus, and the identity door needs the roster entry, not the term row.
 *
 * 山田 is on the roster and is **not** guided anywhere, which is the fixture's stand-in for plan 07 §6.8's
 * wall: a name the record publishes, with no identity to key a relation on.
 */
const GLOSSARY = `# Glossary

_Starter glossary for the relation contract suite._

## Characters

| Japanese | English | Notes |
|---|---|---|
| 如月雨露 | Kisaragi Amatsuyu | Protagonist |
| 大賀太陽 | Oga Taiyo | Best friend since junior high |
| 三色院菫子 | Sanshokuin Sumireko | Library committee |
| ジョーロ | Joro | A name the cast uses |
| サンちゃん | San-chan | A name the cast uses |
| パンジー | Pansy | A name the cast uses |
| 山田 | Yamada | Named only by what job he has |
`;

/**
 * The book's own pronunciation markup, in the shape `utils/source/ruby-guides.js` writes.
 *
 * Three groups, each one reading printed over two written forms, which is what makes each group a
 * *candidate* group and each pair a link the identity door is allowed to file. The links are what the
 * ladder's `reading-resolved` rung is defined on, so they are starting state here rather than something
 * this slice produced.
 */
const HARVEST = {
  schema: 2,
  whatThisIs: "fixture harvest for the relation contract suite",
  generatedBy: "test/test-relation-contract.js",
  sourceFile: "test_story(1).epub",
  guides: [
    { word: "如月雨露", reading: "ジョーロ", count: 3, readingScript: "katakana", chapters: ["ch0"], annotated: [{ base: "如月雨露", reading: "ジョーロ" }] },
    { word: "如雨露", reading: "ジョーロ", count: 1, readingScript: "katakana", chapters: ["ch2"], annotated: [{ base: "如雨露", reading: "ジョーロ" }] },
    { word: "大賀太陽", reading: "サンちゃん", count: 2, readingScript: "katakana", chapters: ["ch0"], annotated: [{ base: "大賀太陽", reading: "サンちゃん" }] },
    { word: "太陽", reading: "サンちゃん", count: 1, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "太陽", reading: "サンちゃん" }] },
    { word: "三色院菫子", reading: "パンジー", count: 4, readingScript: "katakana", chapters: ["ch1"], annotated: [{ base: "三色院菫子", reading: "パンジー" }] },
    { word: "虹彩寺菫", reading: "パンジー", count: 2, readingScript: "katakana", chapters: ["ch2"], annotated: [{ base: "虹彩寺菫", reading: "パンジー" }] },
  ],
};

/**
 * The extra chapter: a page of the book that names **nobody on the roster**.
 *
 * The fixture's own three chapters each name at least one cast entry, so the case the acceptance line asks
 * for — a chapter that names nobody, named rather than punished — needs a chapter that really does. It is
 * added to the bundle metadata before the store registers anything, so it is a chapter the record knows,
 * a chapter the evidence rule can find a line in, and a chapter the reading pass reads.
 */
const CHAPTER_NINE = {
  id: "ch9",
  file: "test_story(1)-ch9.md",
  title: "第九章",
  lines: ["# 第九章", "誰もいない部屋で時計が止まっていた。", "窓の外では風だけが動いていた。"],
};

/**
 * Lay out one fixture volume, open its record, and give it the roster, the written forms and the
 * identities the ladder reads.
 *
 * @param {string} label - The fixture label, so scenarios cannot collide.
 * @returns {Promise<{fx: Object, book: Object, store: Object, segments: Array<Object>}>}
 */
async function buildFixture(label) {
  const fx = fixtureStoreSeries(label);
  const book = fx.volumes[0];

  fs.writeFileSync(path.join(book.dir, CHAPTER_NINE.file), CHAPTER_NINE.lines.join("\n") + "\n", "utf8");
  const meta = JSON.parse(fs.readFileSync(path.join(book.dir, `${book.base}-bundle.meta.json`), "utf8"));
  meta.segments.push({ id: CHAPTER_NINE.id, file: CHAPTER_NINE.file, title: CHAPTER_NINE.title, chars: CHAPTER_NINE.lines.join("\n").length });
  fs.writeFileSync(path.join(book.dir, `${book.base}-bundle.meta.json`), JSON.stringify(meta, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(book.dir, `${book.base}-whole.md`), meta.segments.map((s) => s.id === CHAPTER_NINE.id ? CHAPTER_NINE.lines.join("\n") : null).filter(Boolean).join("\n") + "\n", "utf8");

  fs.writeFileSync(path.join(book.dir, `${book.base}${RUBY_GUIDE_FILE_SUFFIX}`), JSON.stringify(HARVEST, null, 2) + "\n", "utf8");

  const store = rs.openReferenceStore({ volume: 1, folder: book.folder, seriesDir: fx.dir, stage: "rebuild" });
  assertInsideFixture(store.file, fx.dir);
  store.registerVolume({ volume: 1, folder: book.folder, title: "Test Story" });
  const registered = store.registerChaptersFromSource(meta.segments);
  assert.ok(registered.ok && registered.chapters === meta.segments.length, `the fixture chapters should register: ${registered.error}`);

  const imported = importGlossary(store, GLOSSARY);
  assert.ok(imported.castRegistered >= 7, `the fixture glossary should register its Characters rows: ${JSON.stringify(imported.refused.map((r) => r.row && r.row.term))}`);

  const forms = await fileVolumeWrittenForms(store, {});
  assert.ok(forms.ok && forms.filing.rowsToFile === HARVEST.guides.length, `the fixture should file its written forms: ${JSON.stringify(forms.filing)}`);
  const links = fileIdentityLinks(store, {});
  assert.ok(links.ok && links.linksFiled === 3, `the fixture should file three guide-stated identity links: ${JSON.stringify(links)}`);

  return { fx, book, store, segments: meta.segments };
}

/**
 * The rows of one table, with every timestamp replaced by one marker.
 *
 * Read off `sqlite_master` rather than a hand-written list, so a table nobody thought to name is still
 * covered. `except` names the tables the scenario expects to differ.
 *
 * @param {Object} store @param {string[]} [except] @returns {Object<string, string>}
 */
function tableDigest(store, except = []) {
  const skip = new Set(except);
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  /** @type {Object<string, string>} */
  const out = {};
  for (const table of tables) {
    if (skip.has(table)) continue;
    const rows = store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
    out[table] = JSON.stringify(rows).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<clock>");
  }
  return out;
}

/**
 * The same value with every timestamp replaced by one marker.
 *
 * The audit's own messages quote when a reference was rebuilt, so two identical records built a second
 * apart differ in prose that says nothing about the record. Masked before comparing, and the mask is the
 * same one every other suite in this folder uses.
 *
 * @param {any} value @returns {any}
 */
function maskClocks(value) {
  return JSON.parse(JSON.stringify(value).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<clock>"));
}

/** How many rows one table holds. @param {Object} store @param {string} table @returns {number} */
function rowCount(store, table) {
  return store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

/**
 * The store's own key-value notebook, with every timestamp masked.
 *
 * Kept out of the table digest on purpose: the rebuild stamps its own summary of the pass into it, so a
 * digest that included it would report "a table changed" for the record of the run rather than for a row
 * the door wrote. Named separately so the difference is still measured.
 *
 * @param {Object} store @returns {Object<string, string>}
 */
function storeInfoMap(store) {
  /** @type {Object<string, string>} */
  const out = {};
  for (const row of store.db.prepare("SELECT key, value FROM store_info ORDER BY key").all()) {
    out[row.key] = String(row.value).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<clock>");
  }
  return out;
}

/**
 * Replace the harness's one-shot with a counter that answers from a table, chapter by chapter.
 *
 * The label the reading pass puts on each call names the chapter (`character-voice-extract-01-ch1`), so the
 * answer can be the one that belongs to that chapter's own lines — which is what lets the fixture plant a
 * quote whose only cast name is the person being spoken to.
 *
 * @param {Array<Object>} calls @param {(chapterId: string) => Array<Object>} answerFor
 * @returns {void}
 */
function stubHarness(calls, answerFor) {
  harness.runOneShot = async ({ systemPrompt, messages, label, thinkingLevel }) => {
    calls.push({ label, messages, systemPrompt, thinkingLevel });
    const chapterId = String(label || "").split("-").pop();
    return JSON.stringify({ entries: answerFor(chapterId) });
  };
}

/**
 * Read one fixture volume chapter by chapter through the stage's own reading pass.
 *
 * @param {Object} fixture @param {Object} store @param {(chapterId: string) => Array<Object>} answerFor
 * @returns {Promise<{calls: Array<Object>, entries: Array<Object>}>}
 */
async function readVolume(fixture, store, answerFor) {
  const reading = require("../character-voice/reading");
  const calls = [];
  stubHarness(calls, answerFor);
  const ctx = {
    refStore: store,
    volumeDir: fixture.book.dir,
    bundle: { segments: fixture.segments },
    values: { INSTALLMENT_NUMBER: "01" },
    extractPrompt: "fixture user prompt",
    extractSystemPrompt: "fixture system prompt",
  };
  const pass = await reading.readVolumeChapters({
    ctx,
    segments: fixture.segments,
    volumeDir: fixture.book.dir,
    installmentNumber: 1,
    log: () => {},
  });
  assert.ok(pass.ok, `the reading pass was refused: ${JSON.stringify(pass.refusal)}`);
  return { calls, entries: reading.consolidateExtraction(pass.chapters) };
}

/**
 * Run one fixture volume through the door the stage and `rebuild-voice` both use.
 *
 * @param {Object} fixture @param {Array<Object>} entries @returns {Object}
 */
function rebuildVolume(fixture, entries) {
  return rs.rebuildVoiceVolume({
    volume: 1,
    folder: fixture.book.folder,
    seriesDir: fixture.fx.dir,
    entries,
    bundleSegments: fixture.segments,
    apply: false,
  });
}

// ─── The answers the stub gives ───────────────────────────────────────────────

/**
 * What each chapter of the fixture volume answers.
 *
 * Four claims and five acts of address, spread over four chapters, at four different levels. The two
 * `spoken` rows in `ch1` are the planted pair: the same line, the same channel, the same form, the parties
 * swapped — one of them is the case plan 07 §2.9 measured, and it must come back `addressee-risk`.
 *
 * @param {string} chapterId @returns {Array<Object>}
 */
function answerFor(chapterId) {
  if (chapterId === "ch0") {
    return [
      {
        type: "voice",
        character: "如月雨露",
        quirkType: "pronoun",
        description: "First person is the blunt one throughout the opening.",
        examples: ["如月雨露は教室に入った。"],
      },
      {
        type: "relation",
        channel: "narration",
        formUsed: "俺",
        statement: "The opening is narrated in the blunt first person.",
        examples: ["「さぁ、今日も俺の熱き血潮を迸らせるぜ！」"],
      },
    ];
  }
  if (chapterId === "ch1") {
    return [
      {
        type: "voice",
        character: "大賀太陽",
        quirkType: "catchphrase",
        description: "Encourages people with the same word twice.",
        examples: ["ドンマイだ！ ドンマイ！"],
      },
      {
        type: "relation",
        channel: "spoken",
        addresser: "大賀太陽",
        addressee: "如月雨露",
        formUsed: "テメェ",
        statement: "大賀太陽 addresses 如月雨露 with the crude second person.",
        examples: ["「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。"],
      },
      {
        type: "relation",
        channel: "spoken",
        addresser: "如月雨露",
        addressee: "大賀太陽",
        formUsed: "オイ",
        statement: "如月雨露 addresses 大賀太陽 with the blunt second person.",
        examples: ["「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。"],
      },
    ];
  }
  if (chapterId === "ch2") {
    return [
      {
        type: "relation",
        channel: "inner-monologue",
        addresser: "三色院菫子",
        addressee: "如月雨露",
        formUsed: "キミ",
        statement: "三色院菫子 thinks of 如月雨露 with the plain second person.",
        examples: ["担任の教師は何も言わなかった。"],
      },
    ];
  }
  return [
    {
      type: "relation",
      channel: "withheld",
      addressee: "如月雨露",
      formUsed: "テメェ",
      statement: "Somebody addresses 如月雨露 and this page does not say who.",
      examples: ["窓の外では風だけが動いていた。"],
    },
    {
      type: "relation",
      channel: "inner-monologue",
      addressee: "三色院菫子",
      formUsed: "俺",
      statement: "Somebody on this page thinks of 三色院菫子 in the blunt first person, and the page does not say who.",
      examples: ["誰もいない部屋で時計が止まっていた。"],
    },
  ];
}

// ─── The scenarios ────────────────────────────────────────────────────────────

/**
 * Every scenario, in order. Async because scenario 1 runs the stage's own reading pass, and that pass is
 * what the "0 calls" half of the acceptance line is about.
 *
 * @returns {Promise<void>}
 */
async function main() {

  // ─── 1. the acceptance line ─────────────────────────────────────────────────

  console.log("1. the acceptance line: pass 1 files, pass 2 pays 0 calls and files 0");

  const fixture = await buildFixture("relation-contract-acceptance");
  const store = fixture.store;

  const firstRead = await readVolume(fixture, store, answerFor);
  same(firstRead.calls.length, fixture.segments.length, `pass 1 paid ${firstRead.calls.length} model call(s) — one per chapter, which is the call the stage already pays`);
  ok(
    firstRead.entries.filter((entry) => entry.type === rel.RELATION_ENTRY_TYPE).length === 6,
    "and the same answers carry six acts of address beside the claims"
  );
  ok(
    firstRead.entries.every((entry) => entry.chapter),
    "every answer is stamped with the chapter it came from"
  );

  const pass1 = rebuildVolume(fixture, firstRead.entries);
  ok(pass1.ok, `volume 1 was refused: ${JSON.stringify(pass1.refusal)}`);
  const r1 = pass1.rebuild.relations;

  same(r1.relations, 6, "six acts of address arrived in the notebook");
  same(r1.nonRelations, 2, "and the two claims in the same array were not counted as acts");
  same(r1.filedCount, 6, "all six filed");
  same(r1.alreadyFiledCount, 0, "none of them was already there");
  same(r1.refusedCount, 0, "none of them was refused");
  same(r1.namedLimitCount, 0, "none of them named a party this record has no identity for");
  same(r1.unlevelledCount, 0, "and the ladder levelled every one of them");
  same(
    r1.filed.map((row) => `${row.channel}:${row.certainty}:${row.via}`).sort(),
    ["inner-monologue:reading-resolved:guide", "inner-monologue:unknown:channel", "narration:narration:channel", "spoken:addressee-risk:line", "spoken:measured:line", "withheld:withheld:channel"],
    "the six rows carry five levels, and each one names the rung that produced it"
  );
  same(r1.filed.map((row) => row.chapter).sort(), ["ch0", "ch1", "ch1", "ch2", "ch9", "ch9"], "each filed row names the chapter its act came from");
  same(r1.chaptersWithoutRelations, [], "every chapter of this volume reported at least one act");
  same(r1.chaptersNamingNobody, ["ch9"], "and the one chapter whose own text names no roster entry is named");
  same(r1.chapters.find((row) => row.chapter === "ch1").castNamed, 4, "a chapter that did report an act carries how many roster entries its own text names");
  same(r1.chapters.find((row) => row.chapter === "ch9").castNamed, 0, "and the chapter that names nobody carries 0, which is where its name comes from");
  same(r1.unstampedRelations, 0, "no act arrived without a chapter on it");

  same(rowCount(store, "relations"), 6, "the record holds six relation rows after pass 1");
  same(pass1.rebuild.filedCount, 2, "the two claims in the same answer filed as claims, in the same pass");

  // The second pass: the same fixture, the same code, nothing re-read.
  const afterPass1 = tableDigest(store, ["relations", "store_info"]);
  const infoAfterPass1 = storeInfoMap(store);
  const secondRead = await readVolume(fixture, store, answerFor);
  same(secondRead.calls.length, 0, `the second pass paid ${secondRead.calls.length} model call(s) for chapters it had already read (it must pay 0)`);
  const pass2 = rebuildVolume(fixture, secondRead.entries);
  ok(pass2.ok, "the second pass is not an error");
  const r2 = pass2.rebuild.relations;
  same(r2.relations, 6, "the same six acts arrive again");
  same(r2.filedCount, 0, "and not one of them is filed again");
  same(r2.alreadyFiledCount, 6, "all six are reported as already filed rather than re-filed");
  same(r2.refusedCount, 0, "nothing is refused a second time either");
  same(rowCount(store, "relations"), 6, "the record still holds exactly six relation rows");
  same(
    tableDigest(store, ["relations", "store_info"]),
    afterPass1,
    "and every table except the one this slice files into is byte for byte what pass 1 left it as"
  );
  same(
    Object.keys(storeInfoMap(store))
      .filter((key) => storeInfoMap(store)[key] !== infoAfterPass1[key])
      .sort(),
    ["rebuilt_character-voice_1"],
    "the only cell that moved is the rebuild's own summary stamp of the pass — the run's record of what it did, not a row the relation door touched"
  );

  const relationIds = store.db.prepare("SELECT relation_id FROM relations ORDER BY relation_id").all().map((row) => row.relation_id);
  const refiled = rebuildVolume(fixture, secondRead.entries);
  same(
    refiled.rebuild.relations.alreadyFiled.map((row) => row.relationId).sort((a, b) => a - b),
    relationIds,
    "the second pass reports the very rows the first one filed, by id"
  );

  console.log(`  pass 1: ${firstRead.calls.length} call(s), ${r1.filedCount} relation(s) filed · pass 2: ${secondRead.calls.length} call(s), ${r2.filedCount} filed, ${r2.alreadyFiledCount} already filed`);

  // ─── 2. the ladder, rung by rung ────────────────────────────────────────────

  console.log("2. the ladder, asked directly");

  const ladder = await buildFixture("relation-contract-ladder");
  const ls = ladder.store;
  const roster = rs.rosterForChapterQuery(ls);
  const lines = rel.chapterLineCache(ls.volumeDir, ladder.segments);
  /** The 1-based line of a fixture chapter, the way a citation numbers it. @param {string} chapterId @param {number} lineNumber @returns {string} */
  const lineOf = (chapterId, lineNumber) => lines.get(chapterId)[lineNumber - 1];
  /** The cast forms one fixture line names. @param {string} chapterId @param {number} lineNumber @returns {Array<Object>} */
  const formsOf = (chapterId, lineNumber) => rel.castFormsNamedInLine(ls, roster, lineOf(chapterId, lineNumber));

  same([...lines.keys()].sort(), ["ch0", "ch1", "ch2", "ch9"], "the line cache holds one entry per chapter the record registered");
  same(lineOf("ch1", 5), "「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。", "and a citation's line number means the line the book prints, counting from 1");
  same(formsOf("ch1", 5).map((form) => form.key), ["大賀太陽"], "the line the fixture quotes names exactly one cast form");
  ok(formsOf("ch1", 5)[0].identity !== null, "and that form resolves to one identity");
  same(formsOf("ch0", 5), [], "a line that names nobody on the roster names no cast form");
  same(formsOf("ch9", 2), [], "and the chapter that names nobody names no cast form on any of its lines");

  const identityOf = (name) => rel.identityForName(ls, name).id;
  ok(identityOf("如月雨露") !== null && identityOf("大賀太陽") !== null, "both parties resolve to an identity");
  ok(identityOf("如月雨露") !== identityOf("大賀太陽"), "and they are two different people, which is what `measured` is allowed to claim");
  same(rel.identityForName(ls, "山田"), { id: null, count: 0, inRoster: true, identities: [] }, "a roster entry with no identity link resolves to no identity, and says it is on the roster");

  const measuredLine = formsOf("ch1", 5);
  const noLine = formsOf("ch0", 5);

  const measured = rel.certaintyOfObservation(ls, {
    addresserId: identityOf("大賀太陽"),
    addresseeId: identityOf("如月雨露"),
    formUsedId: null,
    lineForms: measuredLine,
    lineVerified: true,
  });
  same(measured.certainty, "measured", "the line names exactly one cast form, it is the addresser's, and the addressee is somebody else");
  same(measured.via, "line", "and the rung that produced it is the line");

  const risk = rel.certaintyOfObservation(ls, {
    addresserId: identityOf("如月雨露"),
    addresseeId: identityOf("大賀太陽"),
    formUsedId: null,
    lineForms: measuredLine,
    lineVerified: true,
  });
  same(risk.certainty, "addressee-risk", "the same line with the parties swapped is the failure this level exists to name");
  same(risk.via, "line", "and it is still the line that says so");

  const riskByForm = rel.certaintyOfObservation(ls, {
    addresserId: identityOf("如月雨露"),
    addresseeId: identityOf("三色院菫子"),
    formUsedId: identityOf("パンジー"),
    lineForms: noLine,
    lineVerified: true,
  });
  same(riskByForm.certainty, "addressee-risk", "a form that is itself a form of the addressee is the same failure from the other side");
  same(riskByForm.via, "form", "and the report says which side it came from");

  const guide = rel.certaintyOfObservation(ls, {
    addresserId: identityOf("三色院菫子"),
    addresseeId: identityOf("如月雨露"),
    formUsedId: null,
    lineForms: noLine,
    lineVerified: true,
  });
  same(guide.certainty, "reading-resolved", "with nothing in the line to read, the only thing left is the link the book's own markup stated");
  same(guide.via, "guide", "and the rung is named as the markup, not as the line");

  const samePerson = rel.certaintyOfObservation(ls, {
    addresserId: identityOf("如月雨露"),
    addresseeId: identityOf("如月雨露"),
    formUsedId: null,
    lineForms: formsOf("ch0", 2),
    lineVerified: true,
  });
  same(samePerson.certainty, null, "a self-address whose two sides are already the same identity is not `measured`, because `measured` is the level that separates them");
  ok(/same identity/.test(samePerson.because), "and the reason the report gives names the identity it could not separate");

  const neitherParty = rel.certaintyOfObservation(ls, {
    addresserId: identityOf("如月雨露"),
    addresseeId: identityOf("大賀太陽"),
    formUsedId: null,
    lineForms: formsOf("ch1", 2),
    lineVerified: true,
  });
  same(neitherParty.certainty, null, "a line whose only cast form belongs to neither party does not say who is speaking it");
  ok(/neither party/.test(neitherParty.because), "and that is what the report says");

  const noRung = rel.certaintyOfObservation(ls, {
    addresserId: null,
    addresseeId: identityOf("如月雨露"),
    formUsedId: null,
    lineForms: noLine,
    lineVerified: true,
  });
  same(noRung.certainty, null, "nothing fires, so nothing is filed — there is no fallback level");
  same(noRung.because.split("; ").length, 3, "and every rung that failed is listed, not just the first");

  const unverified = rel.certaintyOfObservation(ls, {
    addresserId: identityOf("三色院菫子"),
    addresseeId: identityOf("如月雨露"),
    formUsedId: null,
    lineForms: [],
    lineVerified: false,
  });
  same(unverified.certainty, "reading-resolved", "a level that rests on the markup does not need a line, and the door's own precondition agrees");
  ok(!rel.certaintyOfObservation(ls, { addresserId: null, addresseeId: null, formUsedId: null, lineForms: [], lineVerified: false }).certainty, "and with no identity and no line there is nothing to stand on");

  same(
    [rel.isPersonChannel("spoken"), rel.isPersonChannel("inner-monologue"), rel.isPersonChannel("self-address"), rel.isPersonChannel("narration"), rel.isPersonChannel("withheld")],
    [true, true, true, false, false],
    "the ladder is asked of the three person channels and not of the two that name the act without a person"
  );
  same(
    [rel.kindOfNamelessChannel("narration"), rel.kindOfNamelessChannel("withheld"), rel.kindOfNamelessChannel("spoken"), rel.kindOfNamelessChannel("shouted")],
    ["narrator", "withheld", null, null],
    "the nameless channels name their party kind, and a channel outside the vocabulary names nothing"
  );

  console.log("  6 rungs asked, 4 of them levelled, 2 of them answered `null` with a reason");

  // ─── 3. the planted case comes back addressee-risk ──────────────────────────

  console.log("3. the planted case is filed as `addressee-risk`, not `measured`");

  const rows = store.db
    .prepare("SELECT channel, certainty, form_used AS formUsed, addresser_kind AS addresserKind, statement FROM relations ORDER BY relation_id")
    .all();
  const pair = rows.filter((row) => row.channel === "spoken");
  same(pair.length, 2, "the two planted `spoken` acts are both in the record");
  same(
    pair.map((row) => row.certainty).sort(),
    ["addressee-risk", "measured"],
    "one is `measured` and the other is `addressee-risk` — the swap is visible in the table, not only in the report"
  );
  const riskRow = pair.find((row) => row.certainty === "addressee-risk");
  ok(/大賀太陽/.test(riskRow.statement), "the row that says `addressee-risk` is the one whose quote names the person being spoken to");
  same(
    store.db.prepare("SELECT COUNT(*) AS c FROM relations WHERE certainty = 'measured' AND addresser IS NULL").get().c,
    0,
    "`measured` never files a row with no addresser — the level promises a person"
  );
  same(
    store.db.prepare("SELECT COUNT(*) AS c FROM relations WHERE certainty = 'measured' AND addresser = addressee").get().c,
    0,
    "and `measured` never files a row whose two sides are the same identity"
  );
  same(
    store.db.prepare("SELECT COUNT(*) AS c FROM relations WHERE certainty = 'addressee-risk'").get().c,
    1,
    "exactly one row in this volume is the addressee risk, and it is the planted one"
  );

  // ─── 4. a gap files with no person ──────────────────────────────────────────

  console.log("4. narration, withheld and unknown file with no roster entry and no identity");

  const gaps = store.db
    .prepare("SELECT certainty, addresser, addressee, addresser_kind AS addresserKind, addressee_kind AS addresseeKind FROM relations WHERE addresser IS NULL ORDER BY certainty")
    .all();
  same(gaps.map((row) => row.certainty), ["narration", "unknown", "withheld"], "all three gap levels filed, each with a null addresser");
  same(gaps.map((row) => row.addresserKind), ["narrator", "unknown", "withheld"], "and each row names the kind of party it is claiming instead of a name");
  same(gaps.map((row) => row.addresseeKind), ["none", "identity", "identity"], "the narration addresses nobody; the other two address a person the record has an identity for");
  same(rowCount(store, "cast"), 7, "filing them created no roster entry — the roster is the seven the glossary published");
  same(rowCount(store, "cast_identities"), 3, "and it created no identity either — the three are the guide's");
  same(rowCount(store, "cast_identity_links"), 3, "and no link was added to make a gap fileable");
  same(rowCount(store, "cast_merges"), 0, "and nothing was merged");
  same(
    store.db.prepare("SELECT COUNT(*) AS c FROM cast WHERE key IN ('narrator', 'withheld', 'unknown')").get().c,
    0,
    "the words for a gap never become roster entries"
  );

  // ─── 5. a chapter that names nobody is named, not punished ──────────────────

  console.log("5. a chapter that names nobody, and a chapter that reported nothing, are both named");

  const named = await buildFixture("relation-contract-nobody");
  const ns = named.store;
  const nobodyEntry = {
    type: rel.RELATION_ENTRY_TYPE,
    chapter: "ch9",
    channel: "narration",
    formUsed: "俺",
    statement: "This page is narrated, and it names nobody the record publishes.",
    examples: ["誰もいない部屋で時計が止まっていた。"],
  };
  const nobodyReport = rel.fileRelationsFromExtraction(ns, [nobodyEntry], {
    volume: 1,
    volumeDir: ns.volumeDir,
    chapters: named.segments.map((segment) => ({ id: segment.id, file: segment.file })),
  });
  same(nobodyReport.filedCount, 1, "the act itself still files — a chapter that names nobody is not a chapter with no narration");
  same(nobodyReport.chaptersNamingNobody, ["ch9"], "and the chapter is named in the report");
  same(nobodyReport.chaptersWithoutRelations.sort(), ["ch0", "ch1", "ch2"], "the three chapters that reported nothing are named too");
  same(nobodyReport.chapters.map((row) => row.chapter), ["ch9"], "only the chapter that reported an act gets a per-chapter row");
  same(nobodyReport.chapters[0].castNamed, 0, "and that row carries the measurement that produced the name — 0 roster entries named in its own text");
  same(nobodyReport.refusedCount, 0, "nobody is refused");
  same(nobodyReport.unlevelledCount, 0, "nobody is left unlevelled");
  same(nobodyReport.ok, true, "and the pass is not an error");

  const findingsBefore = integrityFindings(ns, { volume: 1 });
  const afterNobody = rel.fileRelationsFromExtraction(ns, [nobodyEntry], {
    volume: 1,
    volumeDir: ns.volumeDir,
    chapters: named.segments.map((segment) => ({ id: segment.id, file: segment.file })),
  });
  same(afterNobody.alreadyFiledCount, 1, "the second filing of the same act files nothing");
  same(maskClocks(integrityFindings(ns, { volume: 1 }).findings), maskClocks(findingsBefore.findings), "and the audit says exactly what it said before: naming a chapter is not a finding");

  console.log(`  ${nobodyReport.chaptersNamingNobody.length} chapter named for naming nobody, ${nobodyReport.chaptersWithoutRelations.length} for reporting nothing, 0 findings`);

  // ─── 6. the limits are named and nothing is invented ────────────────────────

  console.log("6. a party with no identity is named, and no roster entry or identity is invented");

  const limits = await buildFixture("relation-contract-limits");
  const lim = limits.store;
  const castBefore = tableDigest(lim, ["relations"]);
  const limitReport = rel.fileRelationsFromExtraction(
    lim,
    [
      {
        type: rel.RELATION_ENTRY_TYPE,
        chapter: "ch1",
        channel: "spoken",
        addresser: "山田",
        addressee: "三色院菫子",
        formUsed: "パンジー",
        statement: "山田 addresses 三色院菫子 with the name the cast uses for her.",
        examples: ["担任の教師は出口に立っていた。"],
      },
      {
        type: rel.RELATION_ENTRY_TYPE,
        chapter: "ch1",
        channel: "spoken",
        addresser: "誰でもない人物",
        addressee: "如月雨露",
        formUsed: "ジョーロ",
        statement: "Somebody addresses 如月雨露 by the nickname the cast uses for him.",
        examples: ["担任の教師は出口に立っていた。"],
      },
    ],
    { volume: 1, volumeDir: lim.volumeDir, chapters: limits.segments.map((segment) => ({ id: segment.id, file: segment.file })) }
  );
  same(limitReport.filedCount, 0, "neither act files");
  same(limitReport.namedLimitCount, 2, "and both are reported as limits");
  same(limitReport.namedLimits.map((row) => row.rule), ["relation-party-not-in-an-identity", "relation-party-not-in-an-identity"], "with the door's own rule, not a paraphrase of it");
  same(limitReport.namedLimits.map((row) => row.inRoster), [true, false], "one name is on the roster and unlinked, the other is not on the roster at all — the two cases are told apart");
  same(limitReport.namedLimits.map((row) => row.certainty), ["addressee-risk", "addressee-risk"], "the ladder had already levelled both before the door found the wall");
  same(limitReport.unlevelledCount, 0, "and neither was dropped as unlevelled: the ladder worked, the record is what cannot key it");
  same(tableDigest(lim, ["relations"]), castBefore, "nothing was invented to get past the wall: the roster, the identities and the links are untouched");
  same(rowCount(lim, "relations"), 0, "and no half-row was filed either");

  // ─── 7. an entry the ladder cannot level is named with the rung that failed ──

  console.log("7. an entry the ladder cannot level is named with the reason, and files nothing");

  const unlevelled = await buildFixture("relation-contract-unlevelled");
  const us = unlevelled.store;
  const beforeUnlevelled = tableDigest(us, ["relations"]);
  const unReport = rel.fileRelationsFromExtraction(
    us,
    [
      {
        type: rel.RELATION_ENTRY_TYPE,
        chapter: "ch0",
        channel: "self-address",
        addresser: "如月雨露",
        addressee: "如月雨露",
        formUsed: "俺",
        statement: "如月雨露 thinks of himself in the blunt first person.",
        examples: ["如月雨露は教室に入った。"],
      },
      {
        type: rel.RELATION_ENTRY_TYPE,
        chapter: "ch0",
        channel: "self-address",
        formUsed: "俺",
        statement: "Somebody addresses themselves, and the page does not say who.",
        examples: ["如月雨露は教室に入った。"],
      },
      {
        type: rel.RELATION_ENTRY_TYPE,
        chapter: "ch1",
        channel: "spoken",
        addresser: "山田",
        addressee: "如月雨露",
        formUsed: "キミ",
        statement: "山田 addresses 如月雨露.",
        examples: ["山田は会計の人である。"],
      },
    ],
    { volume: 1, volumeDir: us.volumeDir, chapters: unlevelled.segments.map((segment) => ({ id: segment.id, file: segment.file })) }
  );
  same(unReport.filedCount, 0, "none of the three files");
  same(unReport.unlevelledCount, 3, "and all three are reported");
  same(unReport.namedLimitCount, 0, "none of them reached the door, so none of them is a door's limit");
  same(unReport.unlevelled.map((row) => row.chapter), ["ch0", "ch0", "ch1"], "each one names the chapter it came from");
  ok(/same identity/.test(unReport.unlevelled[0].because), "the first names the identity it could not separate");
  ok(/does not allow an admitted gap/.test(unReport.unlevelled[1].because), "the second names the channel that will not accept an unnamed speaker");
  ok(/resolves to 0 identity/.test(unReport.unlevelled[2].because) && /not inside an identity/.test(unReport.unlevelled[2].because), "the third names every rung that failed, in order");
  same(tableDigest(us, ["relations"]), beforeUnlevelled, "and an unlevelled entry leaves no row anywhere");
  same(rowCount(us, "relations"), 0, "not even a row with a weaker level on it");

  // ─── 8. the door's refusals reach the report ────────────────────────────────

  console.log("8. a channel outside the vocabulary, and a name beside a gap, are refused by the door and reported");

  const refused = await buildFixture("relation-contract-refusals");
  const rf = refused.store;
  const refusedReport = rel.fileRelationsFromExtraction(
    rf,
    [
      {
        type: rel.RELATION_ENTRY_TYPE,
        chapter: "ch1",
        channel: "shouted",
        addresser: "大賀太陽",
        addressee: "如月雨露",
        formUsed: "テメェ",
        statement: "大賀太陽 shouts at 如月雨露.",
        examples: ["「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。"],
      },
      {
        type: rel.RELATION_ENTRY_TYPE,
        chapter: "ch0",
        channel: "narration",
        addresser: "如月雨露",
        formUsed: "俺",
        statement: "The narration speaks as 如月雨露.",
        examples: ["如月雨露は教室に入った。"],
      },
      {
        type: rel.RELATION_ENTRY_TYPE,
        chapter: "ch1",
        channel: "spoken",
        addresser: "大賀太陽",
        addressee: "如月雨露",
        formUsed: "テメェ",
        statement: "大賀太陽 addresses 如月雨露 with a line the book does not print.",
        examples: ["存在しない台詞など無い。"],
      },
    ],
    { volume: 1, volumeDir: rf.volumeDir, chapters: refused.segments.map((segment) => ({ id: segment.id, file: segment.file })) }
  );
  same(refusedReport.filedCount, 0, "none of the three files");
  same(refusedReport.refused.map((row) => row.rule), ["relation-channel-unknown", "relation-names-a-party-it-is-not-claiming", "relation-quote-not-in-this-volume"], "each with the door's own rule");
  same(refusedReport.refused.map((row) => row.channel), ["shouted", "narration", "spoken"], "each naming the act it refused");
  same(refusedReport.unlevelledCount, 0, "and none of them was quietly reported as unlevelled instead — the ladder levelled two of them, and the door is what said no");
  same(rowCount(rf, "relations"), 0, "a refusal stores nothing");

  // ─── 9. nothing else notices ────────────────────────────────────────────────

  console.log("9. nothing else in the store notices that an act of address was filed");

  const withRelations = await buildFixture("relation-contract-with");
  const without = await buildFixture("relation-contract-without");
  const entries = [
    ...answerFor("ch0"),
    ...answerFor("ch1"),
    ...answerFor("ch2"),
    ...answerFor("ch9"),
  ];

  const filedWith = rebuildVolume(withRelations, entries);
  const filedWithout = rebuildVolume(
    without,
    entries.filter((entry) => entry.type !== rel.RELATION_ENTRY_TYPE)
  );
  ok(filedWith.ok && filedWithout.ok, "both volumes rebuild");
  same(filedWith.rebuild.filedCount, filedWithout.rebuild.filedCount, "the same claims file either way — an act of address files no claim and blocks none");
  same(filedWith.rebuild.characters, filedWithout.rebuild.characters, "the same characters");
  same(filedWith.rebuild.refused, filedWithout.rebuild.refused, "the same refusals");
  same(filedWith.rebuild.candidates, filedWithout.rebuild.candidates, "the same candidate copies");
  same(rowCount(withRelations.store, "relations"), 6, "and the only difference in the record is the table this slice files into");

  same(
    tableDigest(withRelations.store, ["relations", "store_info"]),
    tableDigest(without.store, ["relations", "store_info"]),
    "every other table is identical, row for row"
  );
  same(
    Object.keys(storeInfoMap(withRelations.store)).sort(),
    Object.keys(storeInfoMap(without.store)).sort(),
    "and the two records wrote the same notebook keys — the rebuild stamped both the same way"
  );
  same(
    renderRebuiltVoice(withRelations.store, { volume: 1 }).markdown,
    renderRebuiltVoice(without.store, { volume: 1 }).markdown,
    "the published character-voice reference is byte-identical: nothing a relation files reaches a published file"
  );
  same(
    maskClocks(integrityFindings(withRelations.store, { volume: 1 }).findings),
    maskClocks(integrityFindings(without.store, { volume: 1 }).findings),
    "the audit says the same thing about both records"
  );
  same(
    rs.chapterKnownFacts(withRelations.store, { chapter: "ch1", volume: 1 }).characters.map((row) => row.key),
    rs.chapterKnownFacts(without.store, { chapter: "ch1", volume: 1 }).characters.map((row) => row.key),
    "and the block a chapter is shown as already known does not contain a relation"
  );

  const factsBeforeAdapter = rowCount(without.store, "facts");
  const adapterWith = importVoiceExtraction(without.store, entries);
  same(adapterWith.importedCount, 0, "it imports no claim a second time — both claims are already in this record");
  same(adapterWith.carried.length, 2, "and it reports both of them as already there");
  same(adapterWith.refused.length, 0, "and it refuses nothing");
  same(adapterWith.relations.length, 6, "it recognises all six acts of address");
  same(adapterWith.relations.map((row) => row.kind), new Array(6).fill("relation"), "and reports them as what they are");
  same(adapterWith.relations.map((row) => row.channel).sort(), ["inner-monologue", "inner-monologue", "narration", "spoken", "spoken", "withheld"], "naming the act without filing it");
  same(rowCount(without.store, "relations"), 0, "it files nothing into the relations table — the door that files is the rebuild's");
  same(rowCount(without.store, "facts"), factsBeforeAdapter, "and it files no claim either: the record holds the same rows it held before it was asked");

  console.log("  0 tables moved, 0 bytes of published prose changed, 0 audit findings added");

  // ─── 10. what this slice did not add ────────────────────────────────────────

  console.log("10. what this slice did not add");

  const kinds = Object.keys(FINDING_LEVELS);
  same(kinds.length, 72, "the finding level table is 72 kinds — this slice added none");
  same(kinds.filter((kind) => /relation/i.test(kind)), [], "and no kind is named for a relation");
  same(Object.values(FINDING_LEVELS).filter((entry) => /relation/i.test(entry.reason || "")).length, 0, "and no level was declared for one either");
  same(Object.keys(FREEZE_DOORS).length, 12, "the freeze gate is still 12 doors — this slice added none");
  same(Object.keys(FREEZE_DOORS).filter((door) => /relation/i.test(door)), [], "and no door is named for a relation");
  same(rs.SCHEMA_VERSION, 13, "the store's schema is still 13 — this slice added no table and bumped nothing");
  same(
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'relation%' ORDER BY name")
      .all()
      .map((row) => row.name),
    ["relations"],
    "the only table with that name is the one plan 07 slice 3 built"
  );
  ok(rs.COUNTED_TABLES.includes("relations"), "`relations` is still copied forward with the rest of the record");

  const handleVerbs = Object.keys(store).filter((key) => typeof store[key] === "function");
  same(handleVerbs.filter((verb) => /relation/i.test(verb)), [], "the store's handle gained no verb for a relation — the door is reached through the cover");

  const contractFile = path.join(ROOT, "utils/reference-store/relations/contract.js");
  const contractText = fs.readFileSync(contractFile, "utf8");
  same(contractText.match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || [], [], "the contract prints no character of any one language's script");
  same(contractText.match(/process\.env/g) || [], [], "and it reads no environment variable — no knob reaches it");
  same(contractText.match(/runOneShot|createAgentHandle/g) || [], [], "and it makes no model call");

  const layerText = readModuleLayer(ROOT, "utils/reference-store/relations.js");
  for (const doorFile of ["relations/rows.js", "relations/file.js", "relations/shapes.js"]) {
    ok(layerText.includes(`utils/reference-store/${doorFile}`), `the scan reaches ${doorFile}, the door layer this slice was told not to modify`);
  }
  ok(layerText.includes("utils/reference-store/relations/contract.js"), "and it reaches the contract this slice added");
  for (const file of ["rebuild/filing.js", "extraction-adapter.js"]) {
    const text = readModuleLayer(ROOT, `utils/reference-store/${file}`);
    same(text.match(/relations\/(rows|file|shapes)/g) || [], [], `${file} does not reach inside the door layer`);
    same(text.match(/\bINSERT INTO relations\b/g) || [], [], `${file} writes no relation row itself`);
  }

  const commands = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  same(Object.keys(require(path.join(ROOT, "configs/shared"))).filter((name) => /RELATION/i.test(name)), [], "no setting was added");
  same(commands.match(/"--?[a-z-]*relation[a-z-]*"/g) || [], [], "and no command-line switch was");

  console.log(`\nrelation contract: ${checks} checks, 0 calls to the endpoint, 0 rows written to any real record.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

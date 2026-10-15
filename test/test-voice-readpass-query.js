/**
 * test/test-voice-readpass-query.js — plan 06 slice 2: what a chapter's extraction call is shown as
 * "already known", measured against the document it replaced.
 *
 * The defect this suite exists to keep fixed. `character-voice/reading.js` used to hand every chapter
 * of every volume the previous volume's published `character-voice.md`, and `truncateVoiceRef` was
 * supposed to bound it. It could not: the picker's cap is a **section count** (200), a cumulative voice
 * reference renders one `### ` section per roster entry, and this series' roster is 196 entries — so the
 * guard ran, found 196 ≤ 200, and returned the document whole. Plan 06 §2.6 measured that against the
 * real function on a synthesized 196-section reference: 351,771 bytes in, 351,771 bytes out,
 * `kept=196 dropped=0 truncated=false`. The voice stage's problem was never a lossy view of the
 * reference. It was the whole reference, every chapter, forever, bounded by nothing in the code.
 *
 * What replaced it is a **query** (`utils/reference-store/chapter-facts.js`) rendered into a bounded
 * block (`character-voice/known-facts.js`): the record's *current* claims, for the characters this
 * chapter's own text names, judged as of this volume. This suite is the proof of that swap, in the order
 * the claims were made:
 *
 *   1. **the size proof** — a 196-entry record rendered through the stage's own renderer, the old
 *      document path measured against the new block at five cast sizes, and the projection onto a
 *      133-chapter run;
 *   2. **the correctness proof** — a claim the record has replaced reaches the prompt through the old
 *      path and does **not** reach it through the new one, while the replacement does;
 *   3. **the refusal proof** — a reading pass with no record open is refused structurally, costs no
 *      model call, and has no markdown fallback behind it;
 *   4. **the named-nothing proof** — a chapter the record names nobody in is *named*, in the log, on the
 *      chapter record, and in the report the acceptance grader reads;
 *   5. **the caps proof** — every bound fires on a roster big enough to need it, and each one says so
 *      inside the block;
 *   6. **the cost proof** — one call per chapter, unmoved by the block, and a reused partial still
 *      costs nothing;
 *   7. **the shape proof** — the block is a query result, not a document: no file is inlined, the query
 *      files nothing, and a name union that selects claims moves no row.
 *
 * The one number in this file that is not measured here is `REAL_SERIES_FAR_END_BYTES` (358,233): the
 * byte size of volume 17's published `glossary.md` in the real corpus, read once outside the suite
 * (plan 06 §2.6). No test may open the corpus (AGENTS.md rule 8, gotcha 69), so it is carried as a
 * documented constant and used only as the far end of the scale.
 *
 * Everything else happens in a throwaway fixture under `/tmp/opencode`. The harness is a counting stub,
 * so no scenario can reach a real endpoint, and 0 model calls are made here.
 *
 * Run with `npm test`, or standalone: `node test/test-voice-readpass-query.js`.
 */

// Read before anything is required: the part-packing target is a load-time constant in
// `utils/source/config.js`, and a fixture whose book is smaller than it never gets a chapter-by-chapter
// path at all. `splitPlainTextSegments` clamps the target to 1000 characters, and every chapter block
// below is written longer than that, so each chapter is exactly one segment.
process.env.SOURCE_TEXT_PART_TARGET_CHARS = "1000";
delete process.env.SOURCE_CHUNK_THRESHOLD_CHARS;

require("./test-home"); // the run's records get a throwaway home (gotcha 69)

const assertRaw = require("assert");

/** Assertions executed, so the printed line carries a number the way the other store suites do. */
let checks = 0;

/**
 * The real `assert`, wrapped so every assertion that runs is counted. The wrapper adds no behaviour
 * and no leniency: a failing assertion throws exactly as `assert` would throw it.
 */
const assert = new Proxy(assertRaw, {
  get(target, key) {
    const fn = target[key];
    if (typeof fn !== "function") return fn;
    return (...args) => {
      checks++;
      return fn.apply(target, args);
    };
  },
});

const fs = require("fs");
const path = require("path");

const harness = require("../harness");
const rs = require("../utils/reference-store");
const { selectSectionsByRelevance } = require("../utils/prompt");
const { resolveSourceBundle } = require("../utils/source");
const reading = require("../character-voice/reading");
const { truncateVoiceRef } = require("../character-voice/stages");
const { VOICE_REF_TRUNCATION_MAX_CHARS, VOICE_REF_TRUNCATION_MAX_ENTRIES } = require("../character-voice/config");
const kf = require("../character-voice/known-facts");
const { CHAPTER_FACT_LIMITS } = require("../utils/reference-store/chapter-facts");
const { FIXTURES_ROOT, assertInsideFixture } = require("./fixture-reference-store");

/** Volume 17's published glossary in the real corpus — see the header. Not read from disk by this suite. */
const REAL_SERIES_FAR_END_BYTES = 358233;

/** The roster size plan 06 §2.11 predicts for a finished series, and the size the real roster has. */
const CAST_SIZE = 196;

/** How long one claim's body runs in the fixture, chosen so the rendered reference lands near 350 KB. */
const CLAIM_BODY_CHARS = 520;

/** The two markers the supersession scenario plants, so "reached the prompt" is a string search. */
const OLD_CLAIM_MARKER = "SUPERSEDED-RENDERING-DOES-NOT-REACH-THE-PROMPT";
const NEW_CLAIM_MARKER = "CURRENT-RENDERING-DOES-REACH-THE-PROMPT";

/** One filler line: prose with no roster name in it, used to make a chapter long enough to be its own segment. */
const FILLER_LINE = "誰もが出ていない。";

/**
 * One roster entry's name.
 *
 * Han skeleton is two characters long, under `GLOSSARY_SKELETON_MIN_CHARS`, so a name is only ever found
 * verbatim — which keeps the matching half of this suite about the verbatim rule and not about the
 * skeleton guard.
 *
 * @param {number} index - 1-based.
 * @returns {string}
 */
function castName(index) {
  return `人物${String(index).padStart(3, "0")}`;
}

/** The whole fixture roster. @type {string[]} */
const CAST = Array.from({ length: CAST_SIZE }, (_, i) => castName(i + 1));

/**
 * One chapter block: a heading, its content lines, and enough filler to push the block past the part
 * target so the splitter gives it a segment of its own.
 *
 * @param {string} title
 * @param {string[]} lines
 * @param {number} [minChars]
 * @returns {string}
 */
function chapterBlock(title, lines, minChars = 1300) {
  const body = [title, ...lines];
  while (body.join("\n").length < minChars) body.push(FILLER_LINE);
  return body.join("\n");
}

/**
 * Volume 01's book: five chapters that name 196, 40, 12, 3 and 0 roster entries.
 *
 * The first chapter is the one every claim cites, so its line numbers are stable: line 1 is the heading,
 * line `i + 1` is roster entry `i`.
 *
 * @returns {string}
 */
function book01() {
  return [
    chapterBlock("# 第一章", CAST.map((name) => `${name} は教室にいた。`), 3000),
    chapterBlock("# 第二章", CAST.slice(0, 40).map((name) => `${name} は廊下にいた。`)),
    chapterBlock("# 第三章", CAST.slice(0, 12).map((name) => `${name} は図書室にいた。`)),
    chapterBlock("# 第四章", CAST.slice(0, 3).map((name) => `${name} は屋上にいた。`)),
    chapterBlock("# 第五章", ["誰もいない廊下を歩いた。", "誰も出ていなかった。"]),
  ].join("\n\n");
}

/** Volume 02's book: one chapter naming two roster entries, one naming nobody. @returns {string} */
function book02() {
  return [
    chapterBlock("# 第一章", [`${castName(1)} は屋上にいた。`, `${castName(2)} は廊下にいた。`]),
    chapterBlock("# 第二章", ["誰もいない廊下を歩いた。", "誰も出ていなかった。"]),
  ].join("\n\n");
}

/**
 * One claim's body: a fixed sentence padded to a fixed length, so the rendered document's size is a
 * chosen number rather than an accident of the fixture.
 *
 * @param {string} name - The roster entry the claim is about.
 * @param {number} ordinal - Which claim of that character's this is.
 * @param {string} [marker] - Text to embed verbatim, for the scenarios that search for a claim.
 * @returns {string}
 */
function claimBody(name, ordinal, marker = "") {
  const head = marker ? `${marker} — a claim about ${name}:` : `A claim about ${name}:`;
  const pad = "this is the note the record stands behind, measured against a line the book prints. ";
  let body = head;
  while (body.length < CLAIM_BODY_CHARS) body += pad;
  return body;
}

/**
 * Lay out a two-volume plain-text series whose volume 01 record holds a full roster and three claims per
 * entry, rendered and sealed the way a finished volume leaves it.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @param {{castSize?: number, claimsPerCharacter?: number}} [opts]
 * @returns {Promise<{dir: string, volumes: Array<Object>, bundle: Object, store: Object, calls: Array<Object>}>}
 */
async function fixtureQuerySeries(label, { castSize = CAST_SIZE, claimsPerCharacter = 3 } = {}) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  process.env.SERIES_LOCATION = dir;
  process.env.POSTMORTEM_DIR = path.join(dir, ".postmortem");
  process.env.LOGS_DIR = path.join(dir, ".logs");
  process.env.DRY_RUN_DIR = path.join(dir, ".dry-run");

  const volumes = [
    { folder: "Query Story(01)", installmentNumber: "01", sourceFile: "Query Story(01)/book.txt", book: book01() },
    { folder: "Query Story(02)", installmentNumber: "02", sourceFile: "Query Story(02)/book.txt", book: book02() },
  ];
  for (const v of volumes) {
    v.dir = path.join(dir, v.folder);
    fs.mkdirSync(v.dir, { recursive: true });
    fs.writeFileSync(path.join(v.dir, "book.txt"), v.book + "\n", "utf8");
  }

  fs.writeFileSync(
    path.join(dir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: dir,
        seriesName: "Query Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test/test-voice-readpass-query.js",
        generatedAt: new Date().toISOString(),
        discovery: { summary: "fixture", confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 }, evidence: ["two books"], excluded: [] },
        volumes: volumes.map((v) => ({
          folder: v.folder,
          sourceFile: v.sourceFile,
          installmentNumber: v.installmentNumber,
          title: "Query Story",
          integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose" },
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  /** @type {Array<Object>} Every model call the stubbed harness heard. */
  const calls = [];
  stubHarness(calls);

  const bundle = await resolveSourceBundle({
    seriesDir: dir,
    volume: volumes[0],
    volumeDir: volumes[0].dir,
    force: false,
  });

  const store = rs.openReferenceStore({ volume: 1, folder: volumes[0].folder, seriesDir: dir, stage: "merge" });
  assertInsideFixture(store.file, dir);
  store.registerChaptersFromSource(bundle.segments);

  const names = CAST.slice(0, castSize);
  for (const name of names) {
    const created = store.upsertCast({ key: name, display: name });
    assert.ok(created.ok, `cast ${name}: ${JSON.stringify(created.refusal)}`);
  }
  // The chapter that every claim cites is the first segment, and its line for roster entry `i` is `i + 1`
  // (line 1 is the chapter heading).
  const citedChapter = bundle.segments[0].id;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const line = i + 2;
    const quote = `${name} は教室にいた。`;
    for (let c = 0; c < claimsPerCharacter; c++) {
      const filed = store.insertFact({
        key: name,
        aspect: "quirk",
        label: ["Pronouns", "Catchphrases", "Notes"][c % 3],
        body: claimBody(name, c, i === 0 && c === 0 ? OLD_CLAIM_MARKER : ""),
        examples: [quote],
        evidence: [{ volume: 1, chapter: citedChapter, line, quote }],
      });
      assert.ok(filed.ok, `fact ${name}/${c}: ${JSON.stringify(filed.refusal)}`);
    }
  }

  return { dir, volumes, bundle, store, calls };
}

/**
 * Replace the harness's one-shot with a counter that answers like the extraction pass.
 *
 * The answer quotes the first content line of the chapter the call was given, so every claim the pass
 * files can pass the evidence rule — and so the call count is the only thing this suite is measuring.
 *
 * @param {Array<Object>} calls
 * @returns {void}
 */
function stubHarness(calls) {
  harness.runOneShot = async ({ systemPrompt, messages, label, thinkingLevel }) => {
    const fileMessage = messages.find((m) => m && m.file);
    const text = fileMessage ? fs.readFileSync(fileMessage.file, "utf8") : "";
    const line = (text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))[0] || "").trim();
    calls.push({ label, messages, systemPrompt, thinkingLevel });
    return JSON.stringify({
      entries: [
        {
          type: "voice",
          character: castName(1),
          quirkType: "catchphrase",
          description: `A new claim this chapter found (${label}).`,
          examples: [line],
        },
      ],
    });
  };
}

/**
 * The ctx `character-voice/reading.js` reads, built the way `extract-voice.js` builds it.
 *
 * @param {{dir: string, volumes: Array<Object>, bundle: Object}} series
 * @param {number} index - Which volume.
 * @param {Object|null} [refStore] - The volume's open record, or null to exercise the refusal.
 * @returns {Object}
 */
function readingCtx(series, index, refStore) {
  const volume = series.volumes[index];
  return {
    values: { INSTALLMENT_NUMBER: volume.installmentNumber, SOURCE_NAME: "Query Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" },
    folderName: volume.folder,
    volumeDir: volume.dir,
    seriesDir: series.dir,
    sourceFile: path.join(volume.dir, "book.txt"),
    bundle: series.bundle,
    isFirst: index === 0,
    previousVoiceRefFile: null,
    voiceOutputFile: path.join(volume.dir, "character-voice.md"),
    extractPrompt: "Extract the voice quirks and POV patterns of this chapter.",
    extractSystemPrompt: "You are a **Voice and Perspective Analyst**.",
    refStore,
  };
}

/**
 * Row counts of the tables a read-only query must never touch.
 *
 * @param {Object} store
 * @returns {Object}
 */
function tableCounts(store) {
  const out = {};
  for (const table of rs.COUNTED_TABLES) out[table] = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return out;
}

// ─── 1. the size proof ────────────────────────────────────────────────────────

/**
 * Render a full roster through the stage's own renderer, run the document path the stage used to use,
 * and measure the query block against it at five cast sizes.
 *
 * @returns {Promise<void>}
 */
async function scenarioSizeProof() {
  console.log("1. the size proof: 196 roster entries, the document path vs the query block");

  const series = await fixtureQuerySeries("slice2-size");
  const rendered = rs.renderRebuiltVoice(series.store, { volume: 1 });
  const doc = rendered.markdown;
  const docBytes = Buffer.byteLength(doc, "utf8");

  assert.strictEqual(rendered.sections, CAST_SIZE, "one section per roster entry, which is what makes a section cap useless");
  assert.ok(docBytes > 300000, `the synthesized reference is ${docBytes} bytes — it has to be in the real corpus's range to be a fair stand-in`);
  console.log(`  rendered reference: ${rendered.sections} sections, ${docBytes} bytes (the real corpus's far end is ${farEndNote()})`);

  // **The defect, reproduced against the real function.** This is the call `truncateVoiceRef` used to be
  // — the same picker, the same section cap, no character budget.
  const chapterText = fs.readFileSync(path.join(series.volumes[0].dir, series.bundle.segments[0].file), "utf8");
  const oldPath = selectSectionsByRelevance({
    content: doc,
    headingRe: /^### /m,
    sourceText: chapterText,
    maxUnits: VOICE_REF_TRUNCATION_MAX_ENTRIES,
    unitLabel: "character section(s)",
  });
  assert.strictEqual(oldPath.kept, CAST_SIZE, `the section cap kept all ${CAST_SIZE} sections`);
  assert.strictEqual(oldPath.dropped, 0, "and dropped none of them");
  assert.strictEqual(oldPath.truncated, false, "and did not report truncating anything");
  assert.strictEqual(Buffer.byteLength(oldPath.content, "utf8"), docBytes, "so the document reached the prompt whole");

  // The same helper, capped. It is still exported and still tested, and since this slice it has **no
  // production caller** — `character-voice/reading.js` no longer calls it, and `grep` over the non-test
  // tree finds only its own definition and its export (measured 2026-10-14). Whether to delete it is the
  // owner's call, written up in `/tmp/opencode/voice-readpass-slice2-questions.md`; the cap is here so the
  // door that stays open is a bounded door.
  // The budget bounds the **sections it packs**; the header and the note that announces the cut are added
  // on top, which is what makes the cut visible, so the assertion is on the packed part.
  const capped = truncateVoiceRef(doc, chapterText);
  const header = doc.slice(0, doc.indexOf("### "));
  const note = capped.split("\n\n").find((part) => part.startsWith("[TRUNCATED:"));
  assert.ok(note, "and it says out loud that it cut the document");
  assert.ok(capped.length <= VOICE_REF_TRUNCATION_MAX_CHARS + header.length + note.length + 4, `the window packs its sections inside ${VOICE_REF_TRUNCATION_MAX_CHARS} characters (${capped.length} total, ${note.length} of it the note)`);
  assert.ok(capped.length < docBytes / 10, `and it is ${capped.length} characters against a ${docBytes}-byte document`);
  console.log(`  the old document path: ${Buffer.byteLength(oldPath.content, "utf8")} bytes through unchanged (kept=${oldPath.kept} dropped=${oldPath.dropped} truncated=${oldPath.truncated}); the same helper capped at ${VOICE_REF_TRUNCATION_MAX_CHARS} characters returns ${capped.length}`);

  // **The new path, at five cast sizes.** Same record, same renderer, same chapters — a query instead.
  const rows = [];
  for (const segment of series.bundle.segments) {
    const built = kf.knownFactsForChapter(readingCtx(series, 0, series.store), segment);
    assert.ok(built.ok, JSON.stringify(built.refusal));
    assert.ok(built.bytes <= kf.KNOWN_FACTS_MAX_BLOCK_CHARS, `the block is ${built.bytes} characters against a ${kf.KNOWN_FACTS_MAX_BLOCK_CHARS}-character ceiling`);
    assert.ok(built.bytes < docBytes, `the block (${built.bytes}) is smaller than the document (${docBytes}) for the same chapter`);
    assert.ok(built.bytes < capped.length, `and smaller than the capped window too (${capped.length})`);
    rows.push({ id: segment.id, named: built.namedCount, claims: built.claimsShown, bytes: built.bytes });
  }
  for (const row of rows) console.log(`  chapter ${row.id}: named ${row.named}, shown ${row.claims} claim(s), ${row.bytes} characters (was ${docBytes})`);

  // The projection the plan asked for: what a 133-chapter run pays, at this fixture's chapter mix.
  const meanBlock = Math.round(rows.reduce((sum, r) => sum + r.bytes, 0) / rows.length);
  const oldRun = docBytes * 133;
  const newRun = meanBlock * 133;
  console.log(`  projected over 133 chapters: ${oldRun} bytes of reference material → ${newRun} bytes of query result (${(newRun / oldRun * 100).toFixed(2)}%)`);
  assert.ok(newRun < oldRun / 10, "the new path is an order of magnitude smaller on this fixture");
  assert.ok(docBytes < REAL_SERIES_FAR_END_BYTES, "the synthesized reference is below the real corpus's far end, so the projection is conservative");

  series.store.close();
}

/**
 * The one number in this suite that came from outside it, phrased so the log says where it came from.
 *
 * @returns {string}
 */
function farEndNote() {
  return `${REAL_SERIES_FAR_END_BYTES} bytes, volume 17's published glossary, measured outside the suite`;
}

// ─── 2. the correctness proof ─────────────────────────────────────────────────

/**
 * A claim the record replaced reaches the prompt through the document path and does not reach it through
 * the query — while the replacement does.
 *
 * @returns {Promise<void>}
 */
async function scenarioSupersededClaim() {
  console.log("2. a claim the record replaced does not reach the chapter");

  const series = await fixtureQuerySeries("slice2-supersede");
  const rendered = rs.renderRebuiltVoice(series.store, { volume: 1 });
  assert.ok(rendered.markdown.includes(OLD_CLAIM_MARKER), "volume 01's published reference prints the claim");
  const publishedFile = path.join(series.volumes[0].dir, "character-voice.md");
  fs.writeFileSync(publishedFile, rendered.markdown, "utf8");
  series.store.sealVolume(1);
  series.store.close();

  const bundle2 = await resolveSourceBundle({ seriesDir: series.dir, volume: series.volumes[1], volumeDir: series.volumes[1].dir, force: false });
  series.bundle = bundle2;
  const opened = rs.openVolumeRecord({
    volume: 2,
    folder: series.volumes[1].folder,
    seriesDir: series.dir,
    previousVolume: 1,
    previousFolder: series.volumes[0].folder,
    bundleSegments: bundle2.segments,
  });
  assert.ok(opened.ok, JSON.stringify(opened.refusal));
  const store = opened.store;

  const carried = store.db.prepare("SELECT id, body FROM facts WHERE body LIKE ?").get(`%${OLD_CLAIM_MARKER}%`);
  assert.ok(carried, "the copy-forward carried the claim into this volume's record");

  // The revision door's own shape: a NEW row naming the published one, quoting a line of THIS volume.
  const citedChapter = bundle2.segments[0].id;
  const quote = `${castName(1)} は屋上にいた。`;
  const replacement = store.insertFact({
    key: castName(1),
    aspect: "quirk",
    label: "Catchphrases",
    body: claimBody(castName(1), 0, NEW_CLAIM_MARKER),
    examples: [quote],
    evidence: [{ volume: 2, chapter: citedChapter, line: 2, quote }],
    supersedes: carried.id,
  });
  assert.ok(replacement.ok, JSON.stringify(replacement.refusal));
  const marked = rs.markSuperseded(store, carried.id, { byVolume: 2, byStage: rs.DOCUMENT_SOURCE_STAGE });
  assert.ok(marked.ok, JSON.stringify(marked.refusal));

  // A claim whose validity span stops at volume 1: current, in the record, and out of this volume's span.
  const expired = store.insertFact({
    key: castName(2),
    aspect: "quirk",
    label: "Notes",
    body: `A claim about ${castName(2)} that stopped holding after volume 1.`,
    examples: [`${castName(2)} は廊下にいた。`],
    evidence: [{ volume: 2, chapter: citedChapter, line: 3, quote: `${castName(2)} は廊下にいた。` }],
    appliesFromVolume: 1,
    appliesToVolume: 1,
  });
  assert.ok(expired.ok, JSON.stringify(expired.refusal));

  const segment = bundle2.segments[0];
  const built = kf.knownFactsForChapter(readingCtx(series, 1, store), segment);
  assert.ok(built.ok, JSON.stringify(built.refusal));
  assert.ok(!built.block.includes(OLD_CLAIM_MARKER), "the replaced claim does not reach the chapter");
  assert.ok(built.block.includes(NEW_CLAIM_MARKER), "the replacement does");
  assert.ok(built.block.includes("claim(s) this record has replaced"), "and the block says a claim was left out because it was replaced");
  assert.ok(built.block.includes("validity span"), "and says the same about the out-of-span one");

  // The same chapter through the old path: the published file still asserts the replaced claim.
  const shownByTheOldPath = truncateVoiceRef(fs.readFileSync(publishedFile, "utf8"), fs.readFileSync(path.join(series.volumes[1].dir, bundle2.segments[0].file), "utf8"));
  assert.ok(shownByTheOldPath.includes(OLD_CLAIM_MARKER), "the document path still shows what the record has replaced — which is the defect this slice closes");

  const counts = store.chapterKnownFacts({
    chapterText: fs.readFileSync(path.join(series.volumes[1].dir, bundle2.segments[0].file), "utf8"),
    volume: 2,
  });
  console.log(`  record says: ${counts.claimsCurrent} current claim(s), ${counts.claimsReplaced} replaced, ${counts.claimsOutOfSpan} out of span, ${built.claimsShown} shown to this chapter; the published document still prints the replaced claim, the query block does not`);

  store.close();
}

// ─── 3. the refusal proof ─────────────────────────────────────────────────────

/**
 * A reading pass with no record open is refused structurally, costs nothing, and has no file fallback.
 *
 * @returns {Promise<void>}
 */
async function scenarioRefusal() {
  console.log("3. no record is a refusal, not a smaller reference");

  const series = await fixtureQuerySeries("slice2-refusal");
  series.store.close();

  const segments = series.bundle.segments;
  const before = series.calls.length;

  const pass = await reading.readVolumeChapters({
    ctx: readingCtx(series, 0, null),
    segments,
    volumeDir: series.volumes[0].dir,
    installmentNumber: "01",
    log: () => {},
  });
  assert.strictEqual(pass.ok, false, "the pass refuses");
  assert.strictEqual(pass.refusal.rule, "no-reference-record", "with a named rule");
  assert.deepStrictEqual(pass.chapters, [], "and files no chapters");
  assert.strictEqual(series.calls.length, before, "and pays nothing: no chapter was read on a guess");
  assert.ok(/openVoiceRecord/.test(pass.refusal.fix), `the refusal names the door that fixes it: ${pass.refusal.fix}`);
  assert.ok(/no fallback/i.test(pass.refusal.fix), "and says out loud that there is no markdown behind it");

  const door = kf.knownFactsForChapter(readingCtx(series, 0, null), segments[0]);
  assert.strictEqual(door.ok, false, "the door itself refuses too");
  assert.strictEqual(door.refusal.rule, "no-reference-record");
  assert.strictEqual(door.block, "", "and hands back no block");

  // A chapter whose own text could not be read is a separate refusal, not an empty answer.
  const store = rs.openReferenceStore({ volume: 1, folder: series.volumes[0].folder, seriesDir: series.dir, stage: "merge" });
  const missing = kf.knownFactsForChapter(readingCtx(series, 0, store), { id: "part-99", file: "does-not-exist.md" });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.refusal.rule, "chapter-source-missing");
  console.log(`  refused with rule "${pass.refusal.rule}" after ${series.calls.length - before} model call(s), and the door refuses with "${door.refusal.rule}" / "${missing.refusal.rule}" on its own`);
  store.close();
}

// ─── 4. the named-nothing proof ───────────────────────────────────────────────

/**
 * A chapter the record names nobody in is read, and says so — in the log, on the chapter record, and in
 * the report the acceptance grader reads.
 *
 * @returns {Promise<void>}
 */
async function scenarioNothingKnownIsNamed() {
  console.log("4. a chapter shown nothing is named, not silently shown nothing");

  const series = await fixtureQuerySeries("slice2-nothing-known");
  const rendered = rs.renderRebuiltVoice(series.store, { volume: 1 });
  series.store.sealVolume(1);
  series.store.close();

  const bundle2 = await resolveSourceBundle({ seriesDir: series.dir, volume: series.volumes[1], volumeDir: series.volumes[1].dir, force: false });
  series.bundle = bundle2;
  const opened = rs.openVolumeRecord({
    volume: 2,
    folder: series.volumes[1].folder,
    seriesDir: series.dir,
    previousVolume: 1,
    previousFolder: series.volumes[0].folder,
    bundleSegments: bundle2.segments,
  });
  assert.ok(opened.ok, JSON.stringify(opened.refusal));

  /** @type {string[]} */
  const logLines = [];
  const callsBefore = series.calls.length;
  const pass = await reading.readVolumeChapters({
    ctx: readingCtx(series, 1, opened.store),
    segments: bundle2.segments,
    volumeDir: series.volumes[1].dir,
    installmentNumber: "02",
    log: (line) => logLines.push(String(line)),
  });
  assert.ok(pass.ok, JSON.stringify(pass.refusal));
  assert.strictEqual(pass.chapters.length, bundle2.segments.length, "every chapter is still read");
  assert.strictEqual(series.calls.length - callsBefore, bundle2.segments.length, "one call per chapter");

  const silent = pass.chapters.filter((c) => c.knownCharacters === 0);
  assert.strictEqual(silent.length, 1, `exactly one chapter names nobody (${pass.chapters.map((c) => `${c.id}:${c.knownCharacters}`).join(", ")})`);
  const named = pass.chapters.filter((c) => c.knownCharacters > 0);
  assert.ok(named.length >= 1, "and at least one chapter is shown claims");
  assert.ok(named.every((c) => c.knownBytes > 0), "each one measured the bytes it was shown");

  const logForSilent = logLines.find((line) => line.includes(silent[0].id) && /NOBODY/.test(line));
  assert.ok(logForSilent, `the run says it out loud: ${logForSilent || "(no such line)"}`);

  const report = reading.readingReport(pass.chapters, { volume: 2 });
  assert.ok(report.includes("read with nothing known about anybody in them"), "and the report the grader reads says so too");
  assert.ok(report.includes(silent[0].id), "naming the chapter");

  // A record with no roster at all is a different fact, and it is said differently.
  const firstVolumeDir = path.join(series.dir, "Query Story(09)");
  fs.mkdirSync(firstVolumeDir, { recursive: true });
  const empty = rs.openReferenceStore({ volume: 9, folder: "Query Story(09)", seriesDir: series.dir, stage: "merge" });
  assertInsideFixture(empty.file, series.dir);
  const firstVolumeBlock = kf.buildKnownFactsBlock(empty.chapterKnownFacts({ chapterText: fs.readFileSync(path.join(series.volumes[0].dir, series.bundle.segments[0].file), "utf8"), volume: 1 }));
  assert.ok(firstVolumeBlock.text.includes("no earlier claims about anybody"), "the first volume is told the record is empty, not that the chapter is empty");
  assert.ok(!firstVolumeBlock.text.includes("None of them is named"), "and not with the wording a full roster gets");
  console.log(`  ${silent[0].id} names nobody and is named in the log and in the report; ${named.length} chapter(s) were shown ${named.map((c) => `${c.knownClaims} claim(s)/${c.knownBytes} chars`).join(", ")}`);
  empty.close();
  opened.store.close();
}

// ─── 5. the caps proof ────────────────────────────────────────────────────────

/**
 * Every bound bites on a roster big enough to need it, and each one says so inside the block.
 *
 * @returns {Promise<void>}
 */
async function scenarioCapsFireAndSaySo() {
  console.log("5. every cap fires, and every cap names itself");

  const series = await fixtureQuerySeries("slice2-caps");
  // One character with far more claims than the per-character limit, so the claim cap has a case.
  const citedChapter = series.bundle.segments[0].id;
  const crowded = castName(1);
  const quote = `${crowded} は教室にいた。`;
  for (let i = 0; i < 12; i++) {
    const filed = series.store.insertFact({
      key: crowded,
      aspect: "quirk",
      label: "Notes",
      body: `An extra claim ${i + 1} about ${crowded}.`,
      examples: [quote],
      evidence: [{ volume: 1, chapter: citedChapter, line: 2, quote }],
    });
    assert.ok(filed.ok, JSON.stringify(filed.refusal));
  }

  const allNames = series.bundle.segments[0];
  const result = series.store.chapterKnownFacts({
    chapterText: fs.readFileSync(path.join(series.volumes[0].dir, allNames.file), "utf8"),
    volume: 1,
  });
  assert.ok(result.ok, JSON.stringify(result.refusal));
  assert.strictEqual(result.namedCount, CAST_SIZE, "the chapter names the whole roster");
  assert.strictEqual(result.charactersNotShown, CAST_SIZE - CHAPTER_FACT_LIMITS.maxCharacters, `the character cap drops ${result.charactersNotShown}`);
  assert.ok(result.claimsCapped >= 12 - CHAPTER_FACT_LIMITS.maxClaimsPerCharacter, `the per-character cap drops ${result.claimsCapped} claim(s)`);
  assert.strictEqual(result.claimsReplaced, 0, "and nothing here is replaced");
  assert.strictEqual(result.claimsShown, result.claimsCurrent - result.claimsCapped, "the counts add up");

  const built = kf.buildKnownFactsBlock(result);
  assert.ok(built.text.length <= kf.KNOWN_FACTS_MAX_BLOCK_CHARS, `the block is ${built.text.length} characters, inside its ${kf.KNOWN_FACTS_MAX_BLOCK_CHARS}-character ceiling`);
  assert.ok(built.sectionsOmitted > 0, `the ceiling dropped ${built.sectionsOmitted} section(s)`);
  assert.ok(built.truncatedClaims > 0, `and shortened ${built.truncatedClaims} claim(s) to ${kf.KNOWN_FACTS_BULLET_CHARS} characters`);
  assert.ok(built.text.includes(`${result.charactersNotShown} roster entr(ies)`), "the block names the characters the character cap left out");
  assert.ok(built.text.includes(`${built.sectionsOmitted} character section(s) left out`), "the ones the ceiling left out");
  assert.ok(built.text.includes(`${result.claimsCapped} older claim(s) beyond the ${CHAPTER_FACT_LIMITS.maxClaimsPerCharacter}-per-character limit`), "the claims the per-character cap left out");
  assert.ok(built.text.includes(`${built.truncatedClaims} claim(s) shortened to ${kf.KNOWN_FACTS_BULLET_CHARS} characters`), "and the claims it shortened");
  assert.ok(built.text.includes("do not treat something as new merely because it is absent"), "and tells the model what an absence means");
  // The trailer that names what the ceiling left out is paid for **before** the sections are packed
  // (`KNOWN_FACTS_NOTE_RESERVE`), because a block that fills its budget and then appends the announcement
  // is longer than the budget it just promised.
  const trailerStart = built.text.lastIndexOf("\n\n");
  console.log(`  caps fired: ${result.charactersNotShown} roster entries left out by the ${CHAPTER_FACT_LIMITS.maxCharacters}-character cap, ${result.claimsCapped} claim(s) by the ${CHAPTER_FACT_LIMITS.maxClaimsPerCharacter}-per-character cap, ${built.sectionsOmitted} section(s) and ${built.truncatedClaims} shortened claim(s) by the ${kf.KNOWN_FACTS_MAX_BLOCK_CHARS}-character ceiling — block is ${built.text.length} characters, ${built.text.length - trailerStart} of them the trailer that says so, ${kf.KNOWN_FACTS_MAX_BLOCK_CHARS - built.text.length} left in reserve`);

  // The most recent claims are the ones that survive, printed in the order they were established.
  const crowdedSection = result.characters.find((c) => c.key === crowded);
  assert.strictEqual(crowdedSection.claimsShown, CHAPTER_FACT_LIMITS.maxClaimsPerCharacter, "the survivor set is exactly the limit");
  assert.ok(crowdedSection.claims.some((row) => row.body.includes("extra claim 12")), "and it holds the newest claim, not the first one filed");
  const order = crowdedSection.claims.map((row) => row.establishedVolume);
  assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), "printed in establishment order");

  series.store.close();
}

// ─── 6. the cost proof ────────────────────────────────────────────────────────

/**
 * One call per chapter, unmoved by the block; a reused partial still costs nothing.
 *
 * @returns {Promise<void>}
 */
async function scenarioCallCountUnmoved() {
  console.log("6. the block adds no call, and a reused chapter still costs nothing");

  const series = await fixtureQuerySeries("slice2-cost");
  series.store.sealVolume(1);
  series.store.close();

  const bundle2 = await resolveSourceBundle({ seriesDir: series.dir, volume: series.volumes[1], volumeDir: series.volumes[1].dir, force: false });
  series.bundle = bundle2;
  const opened = rs.openVolumeRecord({
    volume: 2,
    folder: series.volumes[1].folder,
    seriesDir: series.dir,
    previousVolume: 1,
    previousFolder: series.volumes[0].folder,
    bundleSegments: bundle2.segments,
  });
  assert.ok(opened.ok, JSON.stringify(opened.refusal));
  const ctx = readingCtx(series, 1, opened.store);

  const first = await reading.readVolumeChapters({ ctx, segments: bundle2.segments, volumeDir: series.volumes[1].dir, installmentNumber: "02", log: () => {} });
  assert.ok(first.ok, JSON.stringify(first.refusal));
  const paid = series.calls.length;
  assert.strictEqual(paid, bundle2.segments.length, `the pass paid ${paid} call(s) for ${bundle2.segments.length} chapter(s)`);
  for (const call of series.calls) {
    const blockMessage = call.messages.find((m) => m && typeof m.text === "string" && m.text.startsWith(kf.KNOWN_FACTS_HEADING));
    assert.ok(blockMessage, `chapter ${call.label} was shown the query block`);
  }

  const second = await reading.readVolumeChapters({ ctx, segments: bundle2.segments, volumeDir: series.volumes[1].dir, installmentNumber: "02", log: () => {} });
  assert.ok(second.ok, JSON.stringify(second.refusal));
  assert.strictEqual(series.calls.length, paid, `the second pass paid ${series.calls.length - paid} call(s) — a chapter already read for the same text is not paid for twice`);
  assert.ok(second.chapters.every((c) => c.reused), "and every chapter came from its partial");
  assert.ok(second.chapters.every((c) => c.knownCharacters === null), "a chapter never asked is recorded as never measured, not as measured-and-empty");

  // `--force` pays again, exactly as it did before this slice.
  const forced = await reading.readVolumeChapters({ ctx, segments: bundle2.segments, volumeDir: series.volumes[1].dir, installmentNumber: "02", force: true, log: () => {} });
  assert.ok(forced.ok, JSON.stringify(forced.refusal));
  assert.strictEqual(series.calls.length, paid * 2, "and --force is still the way to pay for a chapter twice");
  console.log(`  ${paid} call(s) for ${bundle2.segments.length} chapter(s), 0 for the re-run that reused every partial, ${series.calls.length - paid} again only for --force`);

  opened.store.close();
}

// ─── 7. the shape proof ───────────────────────────────────────────────────────

/**
 * The block is a query result, not a document: nothing is inlined, the query files nothing, and a name
 * union that selects claims moves no row.
 *
 * @returns {Promise<void>}
 */
async function scenarioQueryNotDocument() {
  console.log("7. the block is a query: no document inlined, nothing filed, no row moved");

  const series = await fixtureQuerySeries("slice2-shape");
  const before = tableCounts(series.store);

  const segment = series.bundle.segments[2]; // the chapter naming 12 roster entries
  const ctx = readingCtx(series, 0, series.store);
  for (let i = 0; i < 5; i++) {
    const built = kf.knownFactsForChapter(ctx, segment);
    assert.ok(built.ok, JSON.stringify(built.refusal));
    assert.ok(!built.block.includes("# Character Voice Reference"), "the block is not a copy of the artifact");
    assert.ok(!/^File: /m.test(built.block), "and carries no inlined file");
  }
  const after = tableCounts(series.store);
  assert.deepStrictEqual(after, before, "five queries filed nothing: every counted table is where it was");

  // The name union selects claims without re-keying anybody: an alias reaches the block, and no merge row
  // appears and no claim moves.
  const aliased = castName(7);
  const alias = "屋上の人";
  const upserted = series.store.upsertCast({ key: aliased, display: aliased, aliases: [alias] });
  assert.ok(upserted.ok, JSON.stringify(upserted.refusal));
  const chapterText = [`${alias} は屋上にいた。`, FILLER_LINE.repeat(80)].join("\n");
  const result = series.store.chapterKnownFacts({ chapterText, volume: 1 });
  assert.ok(result.ok, JSON.stringify(result.refusal));
  assert.strictEqual(result.namedCount, 1, "the alias is how the record found this person");
  assert.strictEqual(result.characters[0].key, aliased, "and the claims it shows are that person's");
  assert.deepStrictEqual(
    series.store.db.prepare("SELECT COUNT(*) AS n FROM cast_merges").get().n,
    0,
    "and no roster entry was merged to make that happen"
  );
  const built = kf.buildKnownFactsBlock(result);
  assert.ok(built.text.includes(`appears here through: ${alias}`), "the block prints the name that produced the match, not one the chapter never prints");

  // No chapter call carries a character-voice document as a file any more.
  series.store.sealVolume(1);
  const bundle2 = await resolveSourceBundle({ seriesDir: series.dir, volume: series.volumes[1], volumeDir: series.volumes[1].dir, force: false });
  series.bundle = bundle2;
  const opened = rs.openVolumeRecord({ volume: 2, folder: series.volumes[1].folder, seriesDir: series.dir, previousVolume: 1, previousFolder: series.volumes[0].folder, bundleSegments: bundle2.segments });
  assert.ok(opened.ok, JSON.stringify(opened.refusal));
  const callsBefore = series.calls.length;
  const pass = await reading.readVolumeChapters({ ctx: readingCtx(series, 1, opened.store), segments: bundle2.segments, volumeDir: series.volumes[1].dir, installmentNumber: "02", log: () => {} });
  assert.ok(pass.ok, JSON.stringify(pass.refusal));
  for (const call of series.calls.slice(callsBefore)) {
    const files = call.messages.filter((m) => m && m.file).map((m) => String(m.name || m.file));
    assert.ok(!files.some((f) => /character-voice.*\.md/.test(f)), `chapter ${call.label} is given ${files.join(", ")} — no reference document among them`);
  }
  console.log(`  alias "${alias}" matched through the roster fold with 0 cast_merges rows written, and ${series.calls.length - callsBefore} chapter call(s) carried no character-voice document`);

  opened.store.close();
  series.store.close();
}

// ─── Run ──────────────────────────────────────────────────────────────────────

(async function main() {
  await scenarioSizeProof();
  await scenarioSupersededClaim();
  await scenarioRefusal();
  await scenarioNothingKnownIsNamed();
  await scenarioCapsFireAndSaySo();
  await scenarioCallCountUnmoved();
  await scenarioQueryNotDocument();
  console.log(`\nvoice read-pass query: 7 scenarios, ${checks} checks, 0 model calls.`);
})().catch((err) => {
  console.error("\nvoice read-pass query FAILED:", err && err.stack ? err.stack : err);
  process.exitCode = 1;
});

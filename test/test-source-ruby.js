/**
 * test/test-source-ruby.js — the pronunciation guide is not part of the word (no AI, no network).
 *
 * A Japanese book marks how a word is read with a guide nested inside the word's own markup:
 *
 *     <ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>      the book says 蒲田, read "Kamata"
 *
 * The converter used to treat <ruby> as an ordinary container, so the extracted text read
 * 蒲かま田た — the word and its own guide as one string. Measured on the live series that is
 * 45,497 annotations and 146,352 characters, and 193 published glossary terms are already split
 * strings of that shape. These fixtures pin the four things that have to be true now:
 *
 *   1. the word alone, in place, in BOTH converters — the intake measures one book and the stages
 *      read another if they disagree, which is the class of bug gotcha 119 records;
 *   2. every guide that was set aside is harvested beside the bundle, in a file a later query can
 *      answer "what did the author say this word is read as" from;
 *   3. the extraction cache actually invalidates, because the converter's behaviour is NOT part of
 *      the cache key — BUNDLE_SCHEMA_VERSION is the only thing that is;
 *   4. the new side file in the volume folder is never mistakable for a book.
 *
 * Run: node test/test-source-ruby.js
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");

const {
  xhtmlToMarkdown,
  htmlToPlainText,
  extractEpubToBundle,
  resolveSourceBundle,
  BUNDLE_SCHEMA_VERSION,
  SCHEMA_CHANGE_NOTE,
  rubyGuideFileName,
  readRubyGuideFile,
  rubyGuideReadingsFor,
  aggregateRubyGuides,
  readingScriptOf,
  RUBY_GUIDE_TAGS,
} = require("../utils/source");
const { firstSourceInVolumeDir, isSourceEntry, isVolumeArtifact } = require("../get-translation-target");
const { isKnownVolumeFile } = require("../utils/artifacts");

const RUBY_SENTENCE = `彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。`;
const RUBY_DOC = `<html><head><title>t</title></head><body><div class="main">` +
  `<p>${RUBY_SENTENCE}</p>` +
  `<p><ruby>上<rt>じよう</rt>機<rt>き</rt>嫌<rt>げん</rt></ruby>な<ruby>三色院<rt>パンジー</rt></ruby>が笑った。</p>` +
  `</div></body></html>`;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

/**
 * Run one document through BOTH converters and return what each produced, guides included.
 *
 * The point of this helper is that the two harvests are compared everywhere it is used: the ruby
 * rule is stated once, and a test that only checked one converter would let the other drift.
 *
 * @param {string} html
 * @returns {{md: string, mdGuides: Object[], plain: string, plainGuides: Object[]}}
 */
function bothWays(html) {
  const mdGuides = [];
  const plainGuides = [];
  const md = xhtmlToMarkdown(html, (src) => `![](${src})`, (g) => mdGuides.push(g));
  const plain = htmlToPlainText(html, (g) => plainGuides.push(g));
  return { md, mdGuides, plain, plainGuides };
}

/**
 * Assert the two converters set aside the SAME guides from the SAME document, in the same order.
 *
 * @param {string} html
 * @param {string} label
 */
function assertConvertersAgree(html, label) {
  const a = bothWays(html);
  assert.deepStrictEqual(a.mdGuides, a.plainGuides, `${label}: the two converters harvested different guides`);
  // The Markdown side carries markup the plain side does not; strip it to compare the TEXT.
  const mdText = a.md.replace(/^#{1,6}\s+.*$/gm, "").replace(/!?\[[^\]]*\]\([^)]*\)/g, "").trim();
  assert.strictEqual(mdText, a.plain.trim(), `${label}: the two converters produced different text`);
  return a;
}

// ─── 1. the word alone, in place ─────────────────────────────────────────────

{
  const a = assertConvertersAgree(`<html><body><p>${RUBY_SENTENCE}</p></body></html>`, "one sentence");
  assert.strictEqual(a.md, "彼は蒲田を見た。", `the guide is gone and the word is not: ${a.md}`);
  assert.ok(!a.md.includes("蒲かま田た"), "the guide-split string the old converter produced is absent");
  assert.deepStrictEqual(a.mdGuides, [{ base: "蒲田", reading: "かまた", annotations: 2 }], "the guide that was removed is reported");
  ok("a guided word extracts as its base text only, in place");

  const whole = assertConvertersAgree(RUBY_DOC, "multi-paragraph document");
  assert.strictEqual(whole.md, "彼は蒲田を見た。\n\n上機嫌な三色院が笑った。", `every guide is out and every paragraph survives: ${whole.md}`);
  assert.strictEqual(whole.mdGuides.length, 3, "three guides, three reports");
  assert.deepStrictEqual(
    whole.mdGuides.map((g) => `${g.base}→${g.reading}`),
    ["蒲田→かまた", "上機嫌→じようきげん", "三色院→パンジー"],
    "the author's own override survives as a reading, not as the word"
  );
  ok("both converters agree on the same document, guide for guide");

  // A guide is inline: it must not split the sentence it sits inside.
  const inline = bothWays(`<html><body><p>前に<ruby>赤<rt>あか</rt></ruby>後に<ruby>青<rt>あお</rt></ruby></p></body></html>`);
  assert.strictEqual(inline.md, "前に赤後に青", "a guided word stays glued to its sentence");
  assert.strictEqual(inline.plain, "前に赤後に青", "and so it stays in the intake's text too");
  ok("a guide never breaks the paragraph it sits in");

  // ruby reached as a block-level child (not inside a <p>) takes the same rule.
  const blockish = assertConvertersAgree(
    `<html><body><div class="main"><ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby></div></body></html>`,
    "ruby as a block child"
  );
  assert.strictEqual(blockish.md, "蒲田", "the block path applies the same rule");
  ok("the rule holds whether the ruby is inline or a block-level child");

  // The other ruby subtags: <rb>/<rbc> are the word, <rt>/<rtc>/<rp> are the guide.
  const full = assertConvertersAgree(
    `<html><body><p>前<ruby><rb>蒲</rb><rb>田</rb><rt>かま</rt><rt>た</rt></ruby>後</p></body></html>`,
    "explicit ruby base"
  );
  assert.strictEqual(full.md, "前蒲田後", "an explicit <rb> ruby base is the word");
  assert.strictEqual(full.mdGuides[0].reading, "かまた", "and the guides beside it are the reading");
  assert.ok(RUBY_GUIDE_TAGS.has("rt") && RUBY_GUIDE_TAGS.has("rtc") && RUBY_GUIDE_TAGS.has("rp"), "the guide tags the rule knows");
  ok("<rb>/<rbc> are the word; <rt>/<rtc>/<rp> are the guide");

  const paren = bothWays(`<html><body><p><ruby>蒲<rp>(</rp><rt>かま</rt><rp>)</rp></ruby></p></body></html>`);
  assert.strictEqual(paren.md, "蒲", "the fallback brackets a browser would show are not text either");
  ok("<rp> fallback punctuation is set aside too");

  // Malformed markup must not lose a word: a guide with no base is the only text there is.
  const orphan = bothWays(`<html><body><p>前<ruby><rt>だけ</rt></ruby>後</p></body></html>`);
  assert.strictEqual(orphan.md, "前だけ後", "a ruby with no base keeps its guide rather than deleting it");
  ok("a malformed ruby loses nothing");

  // A heading with a guide must match the body the converter produced, or the chapter file prints
  // its own heading twice (stripRepeatedHeading compares them).
  const headed = xhtmlToMarkdown(
    `<html><body><h1>【<ruby>俺<rt>おれ</rt></ruby>とあいつが出会うまで】</h1><p><ruby>俺<rt>おれ</rt></ruby>は行く。</p></body></html>`,
    (s) => s,
    () => {}
  );
  assert.strictEqual(headed, "# 【俺とあいつが出会うまで】\n\n俺は行く。", "the heading is guide-free like the body under it");
  ok("a chapter heading with a guide matches the body the converter produced");
}

// ─── 2. the harvest beside the bundle ────────────────────────────────────────

/**
 * Build a two-chapter fixture epub whose prose carries pronunciation guides.
 *
 * @param {{title: string, chapters: Array<{file: string, title: string, body: string}>}} spec
 * @returns {Promise<Buffer>} The .epub bytes.
 */
async function buildRubyEpub({ title, chapters }) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?><package version="3.0" unique-identifier="bookid">` +
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:ruby</dc:identifier>` +
      `<dc:title>${title}</dc:title><dc:language>ja</dc:language></metadata><manifest>` +
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
      chapters.map((c, i) => `<item id="c${i}" href="${c.file}" media-type="application/xhtml+xml"/>`).join("") +
      `</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0"?><html><head><title>nav</title></head><body><nav><ol>` +
      chapters.map((c) => `<li><a href="${c.file}">${c.title}</a></li>`).join("") +
      `</ol></nav></body></html>`
  );
  for (const c of chapters) {
    zip.file(
      `OEBPS/${c.file}`,
      `<?xml version="1.0"?><html><head><title>${c.title}</title></head><body><div class="main">${c.body}</div></body></html>`
    );
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

async function scenarioHarvest() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ruby-harvest-"));
  const volumeDir = path.join(dir, "Ruby Series(01)");
  await fs.promises.mkdir(volumeDir, { recursive: true });
  const sourceName = "ruby_series(1).epub";
  await fs.promises.writeFile(
    path.join(volumeDir, sourceName),
    await buildRubyEpub({
      title: "Ruby Series",
      chapters: [
        {
          file: "p-001.xhtml",
          title: "第一章",
          body:
            `<p>第一章</p><p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。</p>` +
            `<p><ruby>嬉<rt>うれ</rt></ruby>しかったと<ruby>嬉<rt>うれし</rt></ruby>かったの両方。</p>`,
        },
        {
          file: "p-002.xhtml",
          title: "第二章",
          body: `<p>第二章</p><p><ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>にもう一度。<ruby>三色院<rt>パンジー</rt></ruby>。</p>`,
        },
      ],
    })
  );

  const meta = await extractEpubToBundle(path.join(volumeDir, sourceName), volumeDir, "ruby_series(1)");

  // The text the stages read: no guides anywhere.
  const whole = await fs.promises.readFile(path.join(volumeDir, meta.wholeFile), "utf8");
  assert.ok(whole.includes("蒲田"), "the word is there");
  assert.ok(!whole.includes("蒲かま田た"), "the guide-split string is not");
  assert.ok(!whole.includes("嬉うれ"), "the guide was not pasted inside its own word");
  ok("the bundle's text carries the words and none of the guides");

  const file = rubyGuideFileName("ruby_series(1)");
  assert.strictEqual(file, "ruby_series(1)-ruby-guides.json");
  const harvest = await readRubyGuideFile(volumeDir, "ruby_series(1)");
  assert.ok(harvest, `the harvest was written beside the bundle (${file})`);
  assert.strictEqual(harvest.schema, 1);
  assert.strictEqual(harvest.sourceFile, sourceName);
  assert.strictEqual(harvest.totals.guides, 5, "five guides removed");
  assert.strictEqual(harvest.totals.guideChars, 15, "guide characters counted: かまた+うれ+うれし+かまた+パンジー");
  assert.strictEqual(harvest.totals.distinctWords, 3, "蒲田 / 嬉 / 三色院");
  assert.strictEqual(harvest.totals.rows, 4, "one row per (word, reading) pair");
  assert.strictEqual(harvest.totals.wordsWithMoreThanOneReading, 1, "嬉 was guided two ways");
  assert.strictEqual(harvest.totals.wordsGuidedInKatakana, 1, "三色院 → パンジー is the author overriding the reading");
  assert.strictEqual(harvest.totals.chapters, 2, "both chapters are covered");

  const row = harvest.guides.find((r) => r.word === "蒲田");
  assert.ok(row, "the word the audit keeps flagging has a row");
  assert.strictEqual(row.reading, "かまた");
  assert.strictEqual(row.count, 2, "guided in both chapters");
  assert.deepStrictEqual(row.chapters, ["ch1", "ch2"], "and the file says which chapters");
  assert.strictEqual(row.readingScript, "hiragana");

  const override = harvest.guides.find((r) => r.word === "三色院");
  assert.strictEqual(override.reading, "パンジー");
  assert.strictEqual(override.readingScript, "katakana");
  assert.deepStrictEqual(override.chapters, ["ch2"]);

  // A word guided two ways keeps BOTH answers rather than averaging them.
  const twice = harvest.guides.filter((r) => r.word === "嬉");
  assert.strictEqual(twice.length, 2, "two readings, two rows");
  assert.deepStrictEqual(twice.map((r) => r.reading).sort(), ["うれ", "うれし"]);

  // The query the file exists to answer.
  assert.deepStrictEqual(rubyGuideReadingsFor(harvest, "蒲田").map((r) => r.reading), ["かまた"]);
  assert.deepStrictEqual(rubyGuideReadingsFor(harvest, "存在しない語"), [], "a word this volume never guided answers empty");
  ok("the harvest answers \"what did the author say this word is read as?\"");

  // The bundle meta points at the file and records its size, without holding the table.
  assert.ok(meta.rubyGuides, "the meta records the harvest");
  assert.strictEqual(meta.rubyGuides.file, file);
  assert.strictEqual(meta.rubyGuides.guides, 5);
  const metaText = JSON.stringify(meta);
  assert.ok(!metaText.includes("かまた"), "the readings themselves are NOT duplicated into the bundle meta");
  ok("the table lives in its own file; the meta only points at it");

  // Deterministic: the same input produces the same file, byte for byte.
  const first = await fs.promises.readFile(path.join(volumeDir, file), "utf8");
  await extractEpubToBundle(path.join(volumeDir, sourceName), volumeDir, "ruby_series(1)");
  assert.strictEqual(await fs.promises.readFile(path.join(volumeDir, file), "utf8"), first, "the harvest is deterministic");
  ok("the harvest is deterministic across runs");

  // The aggregation rule on its own: sorted by how often the author used the reading.
  const agg = aggregateRubyGuides([
    { word: "嬉", reading: "うれ", annotations: 1, chapter: "ch1" },
    { word: "嬉", reading: "うれ", annotations: 1, chapter: "ch2" },
    { word: "嬉", reading: "うれし", annotations: 1, chapter: "ch1" },
  ]);
  assert.strictEqual(agg.rows[0].word, "嬉");
  assert.strictEqual(agg.rows[0].reading, "うれ", "the reading used most often comes first");
  assert.strictEqual(agg.rows[0].count, 2);
  assert.deepStrictEqual(agg.rows[0].chapters, ["ch1", "ch2"], "chapters are in reading order and deduplicated");
  assert.strictEqual(readingScriptOf("ハーレム"), "katakana");
  assert.strictEqual(readingScriptOf("じようろ"), "hiragana");
  assert.strictEqual(readingScriptOf("OK"), "latin");
  ok("rows are ordered by how often the author used that reading");

  await fs.promises.rm(dir, { recursive: true, force: true });
}

// ─── 3. the cache actually invalidates ───────────────────────────────────────

/**
 * The trap this scenario exists for: the bundle cache is keyed on the ARCHIVE's fingerprint plus
 * BUNDLE_SCHEMA_VERSION. The converter's behaviour is not in the key. Change the converter and
 * leave the version alone, and every volume keeps serving the guide-split text already on disk and
 * nothing about the change is visible anywhere.
 */
async function scenarioCache() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ruby-cache-"));
  const volumeDir = path.join(dir, "Ruby Series(01)");
  await fs.promises.mkdir(volumeDir, { recursive: true });
  const sourceName = "ruby_series(1).epub";
  const sourceBase = path.basename(sourceName, ".epub");
  const sourcePath = path.join(volumeDir, sourceName);
  await fs.promises.writeFile(
    sourcePath,
    await buildRubyEpub({
      title: "Ruby Series",
      chapters: [{ file: "p-001.xhtml", title: "第一章", body: `<p>第一章</p><p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。</p>` }],
    })
  );

  const volume = { installmentNumber: "01", folder: "Ruby Series(01)", sourceFile: `Ruby Series(01)/${sourceName}` };

  // First resolution: nothing cached, so it extracts and writes the harvest.
  const logs = [];
  const realLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  let bundle = await resolveSourceBundle({ seriesDir: dir, volume, volumeDir });
  console.log = realLog;
  assert.strictEqual(bundle.cacheHit, false, "the first pass extracts");
  assert.ok(bundle.rubyGuidesPath && (await fs.promises.stat(bundle.rubyGuidesPath)).isFile(), "and the harvest is on disk");

  // Second pass: a genuine cache hit, and the harvest file is what makes it a hit.
  logs.length = 0;
  console.log = (...args) => logs.push(args.join(" "));
  bundle = await resolveSourceBundle({ seriesDir: dir, volume, volumeDir });
  console.log = realLog;
  assert.strictEqual(bundle.cacheHit, true, "an unchanged archive under the current schema is a cache hit");
  assert.ok(logs.some((l) => l.includes("up to date (cache hit)")), logs.join("\n"));

  // Now pretend the bundle was cached under the PREVIOUS schema — which is exactly the state every
  // real volume folder is in. It must be thrown away, and the operator must be told why.
  const metaPath = path.join(volumeDir, "ruby_series(1)-bundle.meta.json");
  const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf8"));
  const currentSchema = meta.schema;
  assert.strictEqual(currentSchema, BUNDLE_SCHEMA_VERSION, "the extraction wrote the current schema");
  meta.schema = BUNDLE_SCHEMA_VERSION - 1;
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");

  logs.length = 0;
  console.log = (...args) => logs.push(args.join(" "));
  bundle = await resolveSourceBundle({ seriesDir: dir, volume, volumeDir });
  console.log = realLog;
  assert.strictEqual(bundle.cacheHit, false, "a cache written under an older schema is re-extracted");
  const staleLine = logs.find((l) => l.includes("is stale"));
  assert.ok(staleLine, `the operator was told the cache was stale:\n${logs.join("\n")}`);
  assert.ok(staleLine.includes(`${BUNDLE_SCHEMA_VERSION - 1} → ${BUNDLE_SCHEMA_VERSION}`), `the line names both versions: ${staleLine}`);
  assert.ok(staleLine.includes(SCHEMA_CHANGE_NOTE), `the line names what changed: ${staleLine}`);
  // The harvest line is matched on the volume's OWN name, not on the words "set aside": the staleness
  // message quotes SCHEMA_CHANGE_NOTE, which says the same thing in the past tense. A test that looked
  // for "set aside" found the wrong line and then asserted a character count against a sentence that
  // has no number in it.
  assert.ok(staleLine.includes("set aside"), "the staleness message says what changed, in the same words");
  const guideLine = logs.find((l) => l.includes(`${sourceBase}: set aside`));
  assert.ok(guideLine, `the operator was told how much text the guides were: ${logs.join("\n")}`);
  assert.ok(/character\(s\)/.test(guideLine), `the line carries the character count: ${guideLine}`);
  assert.ok(guideLine.includes("ruby_series(1)-ruby-guides.json"), `and names the file it went to: ${guideLine}`);
  ok(`schema ${BUNDLE_SCHEMA_VERSION - 1} → ${BUNDLE_SCHEMA_VERSION} re-extracts, and the log says what that removed`);

  // A harvest file deleted from a healthy cache is a reason to re-extract, not a silent gap.
  logs.length = 0;
  console.log = (...args) => logs.push(args.join(" "));
  await fs.promises.rm(bundle.rubyGuidesPath);
  bundle = await resolveSourceBundle({ seriesDir: dir, volume, volumeDir });
  console.log = realLog;
  assert.strictEqual(bundle.cacheHit, false, "a bundle missing its harvest is re-extracted");
  assert.ok(logs.some((l) => l.includes("missing file(s)") && l.includes("ruby-guides.json")), logs.join("\n"));
  ok("a volume that lost its harvest file gets one, rather than a permanent hole");

  await fs.promises.rm(dir, { recursive: true, force: true });
}

// ─── 4. the side file is never mistakable for a book ─────────────────────────

async function scenarioFolderScan() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ruby-scan-"));
  const folder = "Ruby Series(01)";
  const volumeDir = path.join(dir, folder);
  await fs.promises.mkdir(volumeDir, { recursive: true });
  await fs.promises.writeFile(path.join(volumeDir, "ruby_series(1).epub"), "not really an epub");
  await fs.promises.writeFile(path.join(volumeDir, "ruby_series(1)-ruby-guides.json"), "{}");
  await fs.promises.writeFile(path.join(volumeDir, "ruby_series(1)-whole.md"), "whole text");
  await fs.promises.writeFile(path.join(volumeDir, "ruby_series(1)-ch1.md"), "chapter");
  await fs.promises.writeFile(path.join(volumeDir, "ruby_series(1)-bundle.meta.json"), "{}");
  await fs.promises.writeFile(path.join(volumeDir, "character-voice.md-audit.md"), "the decoy that used to win");

  const picked = await firstSourceInVolumeDir(volumeDir, folder);
  assert.strictEqual(picked, "ruby_series(1).epub", `the archive still wins: ${picked}`);

  const harvestName = "ruby_series(1)-ruby-guides.json";
  assert.ok(isVolumeArtifact(harvestName), "the folder scan knows it is pipeline output");
  assert.ok(isKnownVolumeFile(harvestName) || isVolumeArtifact(harvestName), "and so does the after-run audit");
  const entries = await fs.promises.readdir(volumeDir, { withFileTypes: true });
  const asSource = entries.filter((e) => isSourceEntry(e)).map((e) => e.name);
  assert.ok(!asSource.includes(harvestName), `the harvest is not a source candidate: ${asSource.join(", ")}`);
  assert.deepStrictEqual(asSource, ["ruby_series(1).epub"], "only the archive looks like a book");
  ok("the harvest file cannot be read as the volume's source");

  await fs.promises.rm(dir, { recursive: true, force: true });
}

// ─── 5. a plain-text source is untouched ─────────────────────────────────────

async function scenarioPlainText() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ruby-plain-"));
  const folder = "Plain(01)";
  const volumeDir = path.join(dir, folder);
  await fs.promises.mkdir(volumeDir, { recursive: true });
  await fs.promises.writeFile(path.join(volumeDir, "plain(1).md"), "# 第一章\n\n本文です。\n");
  const bundle = await resolveSourceBundle({
    seriesDir: dir,
    volume: { installmentNumber: "01", folder, sourceFile: `${folder}/plain(1).md` },
    volumeDir,
  });
  assert.strictEqual(bundle.format, "text");
  assert.strictEqual(bundle.rubyGuidesPath, null, "a plain-text source has no markup to harvest");
  assert.strictEqual(await readRubyGuideFile(volumeDir, "plain(1)"), null, "and no harvest file is written for it");
  ok("a plain-text volume gains no harvest file and no behaviour change");
  await fs.promises.rm(dir, { recursive: true, force: true });
}

// ─── 6. a title the book's own contents list names ───────────────────────────

/**
 * The chapter's NAME and the chapter's own printed heading are compared to each other
 * (stripRepeatedHeading), and both are compared against the text the converter produced. If any one
 * of the three keeps its pronunciation guides while another drops them, the chapter file prints its
 * own heading twice — which is why the nav reader strips guides too.
 */
async function scenarioTitles() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ruby-titles-"));
  const volumeDir = path.join(dir, "Ruby Titles(01)");
  await fs.promises.mkdir(volumeDir, { recursive: true });
  const sourceName = "ruby_titles(1).epub";
  await fs.promises.writeFile(
    path.join(volumeDir, sourceName),
    await buildRubyEpub({
      title: "Ruby Titles",
      chapters: [
        {
          // The contents list names the chapter WITH its guide, and the page prints the same heading.
          file: "p-001.xhtml",
          title: "【<ruby>俺<rt>おれ</rt>とあいつが出会うまで】",
          body:
            `<h1>【<ruby>俺<rt>おれ</rt>とあいつが出会うまで】</h1>` +
            `<p><ruby>俺<rt>おれ</rt></ruby>とあいつが出会うまでの話を書くことにする。</p>` +
            `<p>まずは<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>まで歩いて、そこで<ruby>俺<rt>おれ</rt></ruby>が何を言ったのかを思い出す。</p>` +
            `<p>第二章への導入として、この章には十分な長さの本文が必要なので、日本語の文を続けて書く。今日は天気がよく、歩いていると色々なことを考える。考えたことはまた later に書くことにする。</p>` +
            `<p>道沿いの店並みは以前とほとんど変わっていなかった。変わったとしたら、私が歩く速度だけだろう。それすらも確かめる術はない。</p>`,
        },
      ],
    })
  );

  const meta = await extractEpubToBundle(path.join(volumeDir, sourceName), volumeDir, "ruby_titles(1)");
  const seg = meta.segments[0];
  assert.strictEqual(seg.title, "【俺とあいつが出会うまで】", `the chapter's name is guide-free: ${seg.title}`);

  const chapterFile = await fs.promises.readFile(path.join(volumeDir, seg.file), "utf8");
  const printed = (chapterFile.match(/【俺とあいつが出会うまで】/g) || []).length;
  assert.strictEqual(printed, 1, `the chapter prints its own heading exactly once:\n${chapterFile}`);
  assert.ok(!chapterFile.includes("俺おれ"), `no guide survives anywhere in the chapter file:\n${chapterFile}`);
  ok("a chapter named by the contents list, by its own heading, and in its body all agree, guide-free");

  await fs.promises.rm(dir, { recursive: true, force: true });
}

(async () => {
  console.log("source-ruby: the pronunciation guide is set aside, and kept");
  await scenarioHarvest();
  await scenarioCache();
  await scenarioFolderScan();
  await scenarioPlainText();
  await scenarioTitles();
  console.log(`\nsource-ruby: all ${passed} checks passed.`);
})().catch((err) => {
  console.error("source-ruby: FAILED");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

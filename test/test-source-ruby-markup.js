/**
 * test/test-source-ruby-markup.js — plan 09 slice 0: the converter KEEPS every pronunciation guide in the
 * text it writes, as ruby markup over a word that stays whole (no AI, no network, fixtures only).
 *
 * A Japanese book marks how a word is read with a guide nested inside the word's own markup:
 *
 *     <ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>      the book says 蒲田, read "Kamata"
 *
 * Three shapes have now passed through this code. (1) The converter treated `<ruby>` as an ordinary
 * container, so the text read 蒲かま田た — the word and its guide as one string (gotcha 123). (2) The
 * 2026-10-12 fix took the guide OUT and wrote the word alone, which cleaned the text and threw the
 * author's own reading away into a side file no stage read. (3) Plan 09 (2026-10-16, the account owner's
 * decision) puts it back in a shape that cannot split the word:
 *
 *     <ruby>蒲田<rt>かまた</rt></ruby>
 *
 * What has to be true for that to be safe, and what this suite pins:
 *
 *   1. **the base is contiguous**, so the split string is not merely absent — nothing in this file can
 *      assemble it;
 *   2. **the harvest does not move**: same rows, same counts, same per-character `annotated` sequence,
 *      because the harvest is built by `splitRuby`, not by the renderer. This is asserted against the
 *      harvest the SAME fixture produced under schema 8, captured before the change;
 *   3. **the guide-free projection is the old text**, character for character — `stripRubyMarkup` is what
 *      every citation door in the reference store already compares against, so a published record's quote
 *      still matches the book;
 *   4. **the converter's strip and the store's strip are one rule**, restated only because neither module
 *      may sit behind the other (cheerio at require time / a database module behind every evidence query);
 *   5. **the size questions the extraction asks are answered guide-free**, so a page of annotated front
 *      matter does not start looking like a chapter of the book;
 *   6. **a chapter heading and a chapter title stay guide-free**, because a name carrying markup matches no
 *      name that does not;
 *   7. **BUNDLE_SCHEMA_VERSION moved 9 → 10**, and a cache written under 9 is refused rather than reused —
 *      the mistake that made gotcha 123 invisible for a whole series run, in its new form: a schema-9 cache
 *      carries the annotated text but no measurement of it, so the two new markup checks would be silent on
 *      every book the pipeline reads;
 *   8. **the eight extraction audits run over markup-bearing text and stay silent** on a legitimate book;
 *   9. **the markup a chapter carries and the guides that chapter was harvested with are the same number**,
 *      and the converter's own shape scan reports 0 defects on a legitimate book.
 *
 * Run: node test/test-source-ruby-markup.js
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
  auditExtractedVolume,
  EXTRACTION_AUDIT_KINDS,
  BUNDLE_SCHEMA_VERSION,
  SCHEMA_CHANGE_NOTE,
  readRubyGuideFile,
  RUBY_GUIDE_TAGS,
  RUBY_TAG_PATTERN_SOURCE,
  RUBY_MARKUP_UNSAFE_RE,
  canonicalRubyMarkup,
  rubyTextFor,
  rubyWritesMarkup,
  rubyUnitCountOf,
  canonicalRubyShapeScan,
  guideFreeTextOf,
  textCharsOf,
  classifySectionGroup,
  titleOfUnnamedSection,
  stripRepeatedHeading,
} = require("../utils/source");
const {
  RUBY_GUIDE_TAGS: STORE_RUBY_GUIDE_TAGS,
  RUBY_TAG_PATTERN_SOURCE: STORE_RUBY_TAG_PATTERN_SOURCE,
  RUBY_MARKUP_OVERHEAD_CHARS,
  stripRubyMarkup,
  rubyMarkupUnitCount,
  hasRubyMarkup,
  rubyMarkupAddedChars,
} = require("../utils/reference-store/ruby-markup");

/** One annotation costs these characters of tags: `<ruby>` 6 + `<rt>` 4 + `</rt>` 5 + `</ruby>` 7. */
const TAG_CHARS_PER_MARKUP = "<ruby>".length + "<rt>".length + "</rt>".length + "</ruby>".length;

let passed = 0;
/**
 * Record one passing check.
 *
 * @param {string} name
 * @returns {void}
 */
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

/**
 * Run a function with every console.log / console.warn it produces captured instead of printed.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{result: T, logs: string[]}>}
 */
async function quiet(fn) {
  const logs = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

/**
 * Build a fixture epub: a nav that names every page, and one XHTML page per entry.
 *
 * @param {{title: string, pages: Array<{file: string, navTitle: string, bodyClass?: string, body: string}>}} spec
 * @returns {Promise<Buffer>} The .epub bytes.
 */
async function buildBookEpub({ title, pages }) {
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
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:markup</dc:identifier>` +
      `<dc:title>${title}</dc:title><dc:language>ja</dc:language></metadata><manifest>` +
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
      pages.map((c, i) => `<item id="c${i}" href="${c.file}" media-type="application/xhtml+xml"/>`).join("") +
      `</manifest><spine>${pages.map((_, i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>`
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0"?><html><head><title>nav</title></head><body><nav><ol>` +
      pages.map((c) => `<li><a href="${c.file}">${c.navTitle}</a></li>`).join("") +
      `</ol></nav></body></html>`
  );
  for (const c of pages) {
    zip.file(
      `OEBPS/${c.file}`,
      `<?xml version="1.0"?><html><head><title>${c.navTitle}</title></head>` +
        `<body><div class="${c.bodyClass || "p-text"}">${c.body}</div></body></html>`
    );
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * Lay out one fixture volume: a folder holding a fixture book, resolved through the real door.
 *
 * @param {string} tag - Prefix for the throwaway folder.
 * @param {{title: string, sourceName: string, pages: Object[]}} spec
 * @returns {Promise<{seriesDir: string, volumeDir: string, volume: Object, bundle: Object, base: string, logs: string[]}>}
 */
async function fixtureVolume(tag, spec) {
  const seriesDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `markup-${tag}-`));
  const folder = `${spec.title}(01)`;
  const volumeDir = path.join(seriesDir, folder);
  await fs.promises.mkdir(volumeDir, { recursive: true });
  await fs.promises.writeFile(path.join(volumeDir, spec.sourceName), await buildBookEpub(spec));
  const volume = { installmentNumber: "01", folder, sourceFile: `${folder}/${spec.sourceName}` };
  const { result: bundle, logs } = await quiet(() => resolveSourceBundle({ seriesDir, volume, volumeDir }));
  return { seriesDir, volumeDir, volume, bundle, base: path.basename(spec.sourceName, ".epub"), logs };
}

/**
 * Two paragraphs — comfortably above the extraction's 200-character "converted to nothing" floor.
 *
 * @param {string} label - The chapter name, so the fixture's paragraphs are distinguishable.
 * @returns {string} Two XHTML paragraphs.
 */
function prose(label) {
  return (
    `<p>${label}の話を書くことにする。まずは彼が何を言ったのかを思い出すところから始めることにする。` +
      `道沿いの店並みは以前とほとんど変わっていなかったし、変わったとしたら私が歩く速度だけだろう。</p>` +
      `<p>それすらも確かめる術はないので、今日はそのまま歩き続けて、考えたことをまた later に書くことにする。` +
      `歩きながら何度も昨日の会話を思い返していたが、思い出すたびに順番が変わって、結局どれが先だったのかはわからなくなった。</p>`
  );
}

// ─── 1. the canonical shape, and the split string nothing can assemble ────────

/**
 * The canonical shape, the split string that cannot be assembled, and the two converters agreeing.
 */
function scenarioCanonicalShape() {
  const md = xhtmlToMarkdown(`<html><body><p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。</p></body></html>`, (s) => s, () => {});
  assert.strictEqual(md, "彼は<ruby>蒲田<rt>かまた</rt></ruby>を見た。", `the acceptance line, exactly: ${md}`);
  assert.strictEqual(md, `彼は${canonicalRubyMarkup({ base: "蒲田", reading: "かまた" })}を見た。`, "and it is the one markup shape the module exports");
  assert.strictEqual(rubyMarkupUnitCount(md), 1, "one annotated word is one ruby element in the text");
  assert.strictEqual(hasRubyMarkup(md), true, "and the store recognises it as markup");
  assert.strictEqual(stripRubyMarkup(md), "彼は蒲田を見た。", "the store's strip returns the guide-free sentence");
  assert.strictEqual(guideFreeTextOf(md), "彼は蒲田を見た。", "and so does the converter's own copy of the rule");
  ok("a word annotated piece by piece extracts as <ruby>蒲田<rt>かまた</rt></ruby>, base contiguous");

  // The split string is not "absent by luck": the base is never interrupted, so nothing here assembles it.
  const shapes = [
    `<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>`,
    `<ruby><rb>蒲</rb><rb>田</rb><rt>かま</rt><rt>た</rt></ruby>`,
    `<ruby><rbc>蒲田</rbc><rtc><rt>かま</rt><rt>た</rt></rtc></ruby>`,
    `<ruby>蒲<rp>(</rp><rt>かま</rt><rp>)</rp>田<rt>た</rt></ruby>`,
  ];
  for (const src of shapes) {
    const out = xhtmlToMarkdown(`<html><body><p>x${src}y</p></body></html>`, (s) => s, () => {});
    assert.ok(!out.includes("蒲かま田た"), `"${src}" did not produce the split string: ${out}`);
    assert.ok(!out.includes("蒲田かまた"), `"${src}" did not interleave the word with its whole reading either: ${out}`);
    assert.strictEqual(stripRubyMarkup(out), "x蒲田y", `"${src}" strips back to the word, in place`);
  }
  ok("every ruby markup shape this converter meets strips back to the contiguous word");

  // Both converters, the same document, the same text. The intake measures one book and the stages read
  // another when these disagree — gotcha 119's class.
  const doc = `<html><body><div class="p-text"><p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。</p>` +
    `<p><ruby>上<rt>じよう</rt>機<rt>き</rt>嫌<rt>げん</rt></ruby>な<ruby>三色院<rt>パンジー</rt></ruby>が笑った。</p></div></body></html>`;
  const mdGuides = [];
  const plainGuides = [];
  const asMd = xhtmlToMarkdown(doc, (s) => `![](${s})`, (g) => mdGuides.push(g));
  const asPlain = htmlToPlainText(doc, (g) => plainGuides.push(g));
  assert.strictEqual(asMd, asPlain, "the two converters write the SAME annotated text");
  assert.deepStrictEqual(mdGuides, plainGuides, "and they harvest the SAME guides, in the same order");
  assert.strictEqual(mdGuides.length, 3, "three annotations, three reports");
  assert.strictEqual(rubyMarkupUnitCount(asMd), 3, "three ruby elements");
  ok("both converters write the same markup into the same document and harvest the same annotations");
}

// ─── 2. the harvest does not move ────────────────────────────────────────────

/**
 * The harvest this EXACT fixture produced under bundle schema 8, captured on 2026-10-16 before the
 * converter changed (`/tmp/opencode/plan09-capture-harvest-baseline.js` →
 * `/tmp/opencode/plan09-harvest-baseline.json`). It is inlined rather than read from /tmp so the suite is
 * self-contained; the point of it is that the plan's "the harvest is unchanged" is a number, not a claim.
 */
const HARVEST_BEFORE_THE_CHANGE = {
  totals: {
    guides: 7,
    guideParts: 10,
    guideChars: 20,
    distinctWords: 4,
    rows: 5,
    wordsWithMoreThanOneReading: 1,
    wordsGuidedInKatakana: 1,
    chapters: 2,
    rowsWithMoreThanOneAnnotationShape: 1,
  },
  rows: [
    {
      word: "蒲田",
      reading: "かまた",
      count: 3,
      readingScript: "hiragana",
      chapters: ["ch1", "ch2"],
      annotated: [
        { base: "蒲", reading: "かま" },
        { base: "田", reading: "た" },
      ],
      annotatedVariants: [[{ base: "蒲田", reading: "かまた" }]],
    },
    { word: "三色院", reading: "パンジー", count: 1, readingScript: "katakana", chapters: ["ch2"], annotated: [{ base: "三色院", reading: "パンジー" }] },
    { word: "前", reading: "ぜん", count: 1, readingScript: "hiragana", chapters: ["ch2"], annotated: [{ base: "前", reading: "ぜん" }] },
    { word: "嬉", reading: "うれ", count: 1, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "嬉", reading: "うれ" }] },
    { word: "嬉", reading: "うれし", count: 1, readingScript: "hiragana", chapters: ["ch1"], annotated: [{ base: "嬉", reading: "うれし" }] },
  ],
};

/**
 * The fixture body the pre-change baseline was captured from, reproduced verbatim.
 *
 * @returns {Object[]} The fixture's pages.
 */
function baselineFixturePages() {
  const filler =
    `<p>第一章について書くことにして、そのために必要なだけの本文をここに続けて書く。今日は天気がよく、道を歩いているといろいろなことを考える。` +
    `立ち止まって空を見上げると、昨日の会話のことを思い出していた。順番はいつも変わった。</p>`;
  const filler2 = filler.replace(/第一章/g, "第二章");
  return [
    {
      file: "p-001.xhtml",
      navTitle: "第一章",
      body:
        `<p>第一章</p><p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。<ruby>嬉<rt>うれ</rt></ruby>しかったと<ruby>嬉<rt>うれし</rt></ruby>かったの両方。</p>${filler}`,
    },
    {
      file: "p-002.xhtml",
      navTitle: "第二章",
      body:
        `<p>第二章</p><p><ruby><rb>蒲</rb><rb>田</rb><rt>かま</rt><rt>た</rt></ruby>だった。<em><ruby>三色院<rt>パンジー</rt></ruby></em>が笑った。<ruby>前<rt>ぜん</rt></ruby><ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>。</p>${filler2}`,
    },
  ];
}

/**
 * Re-extract the baseline fixture and compare its harvest, row for row, against the pre-change capture.
 */
async function scenarioHarvestUnchanged() {
  const fx = await fixtureVolume("harvest", {
    title: "Markup Series",
    sourceName: "markup_series(1).epub",
    pages: baselineFixturePages(),
  });

  const harvest = await readRubyGuideFile(fx.volumeDir, fx.base);
  assert.ok(harvest, "the harvest file is still written beside the bundle");
  assert.deepStrictEqual(harvest.totals, HARVEST_BEFORE_THE_CHANGE.totals, "every harvest TOTAL is what the same fixture produced before the change");
  assert.deepStrictEqual(harvest.guides, HARVEST_BEFORE_THE_CHANGE.rows, "and every ROW is, including the per-character annotation sequence");
  assert.strictEqual(harvest.guides.length, 5, "five rows");
  assert.strictEqual(harvest.totals.guideChars, 20, "twenty characters of reading — the same characters the old converter threw away");
  ok("the harvest is identical to what the same fixture produced under schema 8: rows, counts and sequences");

  // The text, though, is a different text — and the guide-free projection of it is the old one.
  const ch1 = await fs.promises.readFile(path.join(fx.volumeDir, `${fx.base}-ch1.md`), "utf8");
  assert.ok(ch1.includes("彼は<ruby>蒲田<rt>かまた</rt></ruby>を見た。"), `the chapter carries the reading over the word:\n${ch1}`);
  assert.ok(ch1.includes("<ruby>嬉<rt>うれ</rt></ruby>しかったと<ruby>嬉<rt>うれし</rt></ruby>かった"), "and keeps both readings of a word guided two ways");
  assert.ok(!ch1.includes("蒲かま田た"), "and never writes the split string");
  // Guide-free, this is the sentence schema 8 wrote — including the one the fixture planted to show the
  // reading is not the word: 嬉 guided うれし strips to 嬉かった, because the し belonged to the reading.
  assert.ok(stripRubyMarkup(ch1).includes("彼は蒲田を見た。嬉しかったと嬉かったの両方。"), "stripped, it is the sentence schema 8 wrote");
  assert.ok(!hasRubyMarkup(stripRubyMarkup(ch1)), "and the stripped form carries no markup at all");

  // The cost is arithmetic, not an estimate: tags per annotated word, plus the reading itself.
  const units = rubyMarkupUnitCount(ch1);
  assert.strictEqual(units, 3, "three annotated words in chapter 1");
  const guideFreeChars = stripRubyMarkup(ch1).length;
  assert.strictEqual(ch1.length - guideFreeChars, units * TAG_CHARS_PER_MARKUP + "かまたうれうれし".length, `the chapter grew by exactly ${units} × ${TAG_CHARS_PER_MARKUP} tags plus its readings`);
  assert.strictEqual(TAG_CHARS_PER_MARKUP, RUBY_MARKUP_OVERHEAD_CHARS, "and that overhead is the store's own constant, not this test's arithmetic");
  assert.strictEqual(rubyMarkupAddedChars({ form: "蒲田", reading: "かまた" }), TAG_CHARS_PER_MARKUP + "かまた".length, "which is also what the store prices one annotation at");

  // Every chapter of this fixture: the growth is the markup, and the tripwire is 0.
  for (const seg of fx.bundle.segments) {
    assert.strictEqual(seg.guideSplitForms, 0, `${seg.id}: the guide-split tripwire reports 0 on a legitimate chapter`);
    assert.deepStrictEqual(seg.guideSplitExamples, [], `${seg.id}: and names no example`);
  }
  assert.strictEqual(fx.bundle.rubyGuides.splitForms, 0, "the volume total is 0 too");
  const meta = JSON.parse(await fs.promises.readFile(path.join(fx.volumeDir, `${fx.base}-bundle.meta.json`), "utf8"));
  assert.strictEqual(meta.schema, BUNDLE_SCHEMA_VERSION, "the bundle cache records the current schema");
  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
}

// ─── 3. the three shapes, through the extraction ─────────────────────────────

/**
 * A guide with no base, a base with no guide, and a half that cannot go inside a tag — as the extraction
 * writes them into a chapter file.
 */
async function scenarioTheThreeFallbacks() {
  const fx = await fixtureVolume("shapes", {
    title: "Markup Shapes",
    sourceName: "markup_shapes(1).epub",
    pages: [
      {
        file: "p-001.xhtml",
        navTitle: "第一章",
        body:
          `<p>第一章</p><p>前<ruby><rt>だけ</rt></ruby>後。</p>` +
          `<p><ruby><rb>蒲田</rb></ruby>を見た。</p>` +
          `<p><ruby>危険<rt>&lt;こわい&gt;</rt></ruby>と<ruby>安全<rt>あんぜん</rt></ruby>。</p>` +
          prose("第一章"),
      },
    ],
  });
  const file = await fs.promises.readFile(path.join(fx.volumeDir, `${fx.base}-ch1.md`), "utf8");

  // A ruby with no base: the reading as plain text. An empty <ruby> is a shape error, not markup.
  assert.ok(file.includes("前だけ後。"), `a guide with no base is plain text:\n${file}`);
  assert.ok(!file.includes("<ruby>だけ"), "and no markup is written over nothing");
  // A ruby base the author never guided: the bare word.
  assert.ok(file.includes("蒲田を見た。"), "a base with no guide is the bare word");
  assert.ok(!file.includes("<ruby>蒲田<rt></rt>"), "and no empty <rt> is emitted");
  // A half carrying a tag character: the word alone, guide-free, and the guide is still harvested.
  assert.ok(file.includes("危険と"), `a half that cannot sit inside a tag falls back to the word:\n${file}`);
  assert.ok(!file.includes("<ruby>危険<rt>"), "and no corrupted element is written");
  assert.ok(file.includes("<ruby>安全<rt>あんぜん</rt></ruby>"), "while the annotation beside it is written normally");

  const harvest = await readRubyGuideFile(fx.volumeDir, fx.base);
  const readings = harvest.guides.map((r) => `${r.word}→${r.reading}`);
  assert.ok(readings.includes("危険→<こわい>"), "the guide that could not be displayed is STILL in the harvest");
  assert.ok(readings.includes("→だけ"), "and so is the orphan reading, with no word of its own");
  assert.strictEqual(fx.bundle.rubyGuides.splitForms, 0, "and none of this produced a split string");
  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
}

// ─── 4. markup survives the inline nesting a real book uses ──────────────────

/**
 * Ruby written inside every inline and block shape a real book uses, and the strip that undoes it.
 */
function scenarioInlineNesting() {
  const doc =
    `<html><body><p><em>前に<ruby>赤<rt>あか</rt></ruby>後ろに</em><strong><ruby>太<rt>ふと</rt></ruby>い</strong>` +
    `<del><ruby>昔<rt>むかし</rt></ruby></del><a href="x.xhtml"><ruby>頁<rt>ページ</rt></ruby></a></p>` +
    `<ul><li><ruby>列<rt>れつ</rt></ruby>の項目</li></ul>` +
    `<table><tr><td><ruby>表<rt>ひょう</rt></ruby></td><td>cell</td></tr></table>` +
    `<blockquote><p><ruby>引<rt>ひき</rt></ruby>用</p></blockquote>` +
    `<p>一行目<br /><ruby>改<rt>かい</rt></ruby>行</p></body></html>`;
  const guides = [];
  const md = xhtmlToMarkdown(doc, (s) => `![](${s})`, (g) => guides.push(g));

  assert.strictEqual(rubyMarkupUnitCount(md), 8, "eight annotated words, eight ruby elements");
  assert.strictEqual(guides.length, 8, "and eight annotations reported");
  for (const [emphasis, wrapped] of [
    ["*", "前に<ruby>赤<rt>あか</rt></ruby>後ろに"],
    ["**", "<ruby>太<rt>ふと</rt></ruby>い"],
    ["~~", "<ruby>昔<rt>むかし</rt></ruby>"],
  ]) {
    assert.ok(md.includes(`${emphasis}${wrapped}${emphasis}`), `the ${emphasis} emphasis still wraps the whole annotated run:\n${md}`);
  }
  assert.ok(md.includes("<ruby>頁<rt>ページ</rt></ruby>"), "a link's text keeps its guide");
  assert.ok(md.includes("- <ruby>列<rt>れつ</rt></ruby>の項目"), "a list item keeps its guide");
  assert.ok(md.includes("<ruby>表<rt>ひょう</rt></ruby> | cell"), "a table cell keeps its guide");
  assert.ok(md.includes("> <ruby>引<rt>ひき</rt></ruby>用"), "a blockquote keeps its guide");
  assert.ok(md.includes("一行目\n<ruby>改<rt>かい</rt></ruby>行"), "and a hard line break still breaks the line");

  const stripped = stripRubyMarkup(md);
  assert.strictEqual(stripped, guideFreeTextOf(md), "the store's strip and the converter's strip return the same thing on a whole page");
  assert.ok(!hasRubyMarkup(stripped), "the stripped page carries no markup");
  assert.ok(stripped.includes("*前に赤後ろに***太い**~~昔~~頁"), "and the Markdown syntax survives the strip: " + stripped.split("\n")[0]);
  assert.strictEqual(rubyMarkupUnitCount(stripped), 0, "counting the stripped page finds nothing to count");
  ok("ruby survives <em>/<strong>/<del>/<a>/lists/tables/blockquotes/<br>, and strips back without cutting them");
}

// ─── 5. the converter's strip and the store's strip are one rule ─────────────

/**
 * The two copies of the ruby rule, compared on every shape either module can meet.
 */
function scenarioTwoStripsAgree() {
  assert.strictEqual(RUBY_TAG_PATTERN_SOURCE, STORE_RUBY_TAG_PATTERN_SOURCE, "the converter's tag pattern and the store's are the SAME string");
  assert.deepStrictEqual([...RUBY_GUIDE_TAGS].sort(), [...STORE_RUBY_GUIDE_TAGS].sort(), "and so are the guide tags");
  assert.strictEqual(RUBY_MARKUP_UNSAFE_RE.source, "[<>]", "the unsafe-half guard is the two characters it says it is");

  /** Shapes either side of the two modules can produce, plus the ones only a broken book produces. */
  const shapes = [
    ["plain text", "彼は蒲田を見た。"],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
    ["canonical", "<ruby>蒲田<rt>かまた</rt></ruby>"],
    ["nested ruby inside a guide", "<ruby>外<rt><ruby>内<rt>ない</rt></ruby>外</rt></ruby>"],
    ["ruby base tags", "<ruby><rb>蒲</rb><rb>田</rb><rt>かま</rt></ruby>"],
    ["grouped guides", "<ruby>蒲田<rtc><rt>かま</rt><rt>た</rt></rtc></ruby>"],
    ["fallback punctuation", "<ruby>蒲田<rp>(</rp><rt>かまた</rt><rp>)</rp></ruby>"],
    ["unbalanced open", "彼は<ruby>蒲田<rt>かまた"],
    ["unbalanced close", "彼は蒲田かまた</rt></ruby>を見た。"],
    ["tag with attributes", '<ruby class="x">蒲田<rt lang="ja">かまた</rt></ruby>'],
    ["markup in the middle of a sentence", "前に<ruby>赤<rt>あか</rt></ruby>後に"],
    ["two adjacent rubies", "<ruby>前<rt>ぜん</rt></ruby><ruby>蒲田<rt>かまた</rt></ruby>"],
    ["a ruby with no guide", "<ruby>蒲田</ruby>"],
    ["a guide with no ruby", "<rt>だけ</rt>"],
  ];
  for (const [label, text] of shapes) {
    const byStore = stripRubyMarkup(text);
    const byConverter = guideFreeTextOf(text);
    assert.strictEqual(byConverter, byStore, `"${label}": the two strips disagree`);
    assert.ok(!byStore.includes("<ruby") && !byStore.includes("<rt"), `"${label}": the strip left a ruby tag behind: ${byStore}`);
  }
  // The word is kept and the reading is dropped — the direction the evidence rule depends on.
  assert.strictEqual(stripRubyMarkup("<ruby>蒲田<rt>かまた</rt></ruby>"), "蒲田", "the word survives, the reading goes");
  assert.strictEqual(stripRubyMarkup("彼は<ruby>蒲田<rt>かまた"), "彼は蒲田", "an unbalanced tag loses its markup and keeps its word");
  ok(`the converter's strip and the store's strip agree on all ${shapes.length} shapes, and neither loses a word`);
}

// ─── 6. the size questions the extraction asks are answered guide-free ───────

/**
 * `textCharsOf`, `classifySectionGroup`, `titleOfUnnamedSection` and `stripRepeatedHeading` all measure the
 * words, not the tags around them.
 */
function scenarioGuideFreeMeasurements() {
  const annotated = `<ruby>表<rt>ひょう</rt></ruby>紙のページ\n\n<ruby>奥<rt>おく</rt></ruby>付\n\n![plate](images/img-0001.jpg)`;
  const guideFree = stripRubyMarkup(annotated);
  assert.strictEqual(textCharsOf(annotated), textCharsOf(guideFree), "a page counts the same story text whether or not its words carry guides");
  assert.strictEqual(textCharsOf(annotated), 8, "and what it counts is the words: 表紙のページ + 奥付, with the tags, the readings, the blank lines and the image reference all removed");

  const group = { title: "表紙", declared: false, inToc: false, types: [], kind: "undeclared", reason: "" };
  const verdictAnnotated = classifySectionGroup(group, textCharsOf(annotated));
  const verdictGuideFree = classifySectionGroup(group, textCharsOf(guideFree));
  assert.deepStrictEqual(verdictAnnotated, verdictGuideFree, "so the packaging decision is the same decision");
  assert.strictEqual(verdictAnnotated.chapter, false, "and an annotated cover plate is still packaging, not a chapter worth translating");

  // Counting the MARKUP as story text is the mistake this prevents: 24 characters per annotated word.
  const heavy = "<ruby>語<rt>ご</rt></ruby>".repeat(20);
  assert.strictEqual(textCharsOf(heavy), 20, "twenty annotated one-character words are twenty characters of story text, not 20 × 24");
  assert.strictEqual(heavy.length, 480, "even though the file holds 480 characters");
  assert.strictEqual(classifySectionGroup(group, textCharsOf(heavy)).chapter, false, "and that page is still not a section of the book");
  assert.strictEqual(classifySectionGroup(group, heavy.length).chapter, true, "which is the wrong answer the guide-free measurement exists to stop: the tags alone would clear the floor");

  // A title an unnamed section prints for itself is the NAME, not the name plus its guides. These books set
  // it as a short bracketed line, and the guide sits on the first word of it.
  const titled = titleOfUnnamedSection([], `【<ruby>俺<rt>おれ</rt></ruby>とあいつが出会うまで】\n\n本文はここから始まる。`);
  assert.deepStrictEqual(titled, { title: "【俺とあいつが出会うまで】", synthetic: false }, "the body-line title is guide-free");
  assert.strictEqual(titled.title.length, 13, "and the 60-character rule measures the name, not the markup");
  assert.ok(!titled.title.includes("<ruby>"), "and the name the chapter is filed under carries no markup — which is what stripRepeatedHeading can match a heading against");
  const annotatedTitle = titleOfUnnamedSection([], "<ruby>語<rt>ご</rt></ruby>".repeat(12) + "【名前】");
  assert.strictEqual(annotatedTitle.title, "語語語語語語語語語語語語【名前】", "a line that is 292 characters of markup and 16 characters of name is measured as the name");
  assert.strictEqual(annotatedTitle.synthetic, false, "so it is still a name the page printed");
  assert.strictEqual(titleOfUnnamedSection([], "本文はここから始まる。").synthetic, true, "and a plain prose first line is still not a title");

  // stripRepeatedHeading compares the page's own heading against that guide-free title.
  const page = `# 俺とあいつが出会うまで\n\n<ruby>俺<rt>おれ</rt></ruby>は行く。`;
  assert.strictEqual(stripRepeatedHeading(page, "俺とあいつが出会うまで"), "<ruby>俺<rt>おれ</rt></ruby>は行く。", "the duplicate heading is dropped, and the body keeps its guides");
  ok("textCharsOf, classifySectionGroup, titleOfUnnamedSection and stripRepeatedHeading all answer guide-free");
}

// ─── 7. a cache written under the previous schema is refused, not reused ─────

/**
 * The exact state every real volume folder is in right now: a healthy bundle cached under schema 9, whose
 * chapter files carry the ruby markup but whose meta records nothing about that markup. It must be thrown
 * away, and the operator must be told why.
 */
async function scenarioSchema8CacheRefused() {
  assert.strictEqual(BUNDLE_SCHEMA_VERSION, 10, "the bundle schema is 10");
  const fx = await fixtureVolume("cache", {
    title: "Markup Cache",
    sourceName: "markup_cache(1).epub",
    pages: [{ file: "p-001.xhtml", navTitle: "第一章", body: `<p>第一章</p><p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。</p>${prose("第一章")}` }],
  });

  // A second resolution of an unchanged archive is a cache hit — under the CURRENT schema.
  const again = await quiet(() => resolveSourceBundle({ seriesDir: fx.seriesDir, volume: fx.volume, volumeDir: fx.volumeDir }));
  assert.strictEqual(again.result.cacheHit, true, "an unchanged archive under the current schema is a cache hit");
  assert.ok(again.logs.some((l) => l.includes("cache hit")), again.logs.join("\n"));

  // Now put the bundle back to schema 8 — which is what every real volume's cache says today.
  const metaPath = path.join(fx.volumeDir, `${fx.base}-bundle.meta.json`);
  const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf8"));
  assert.strictEqual(meta.schema, BUNDLE_SCHEMA_VERSION, "the extraction just wrote a schema-10 cache");
  meta.schema = BUNDLE_SCHEMA_VERSION - 1;
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");

  const stale = await quiet(() => resolveSourceBundle({ seriesDir: fx.seriesDir, volume: fx.volume, volumeDir: fx.volumeDir }));
  assert.strictEqual(stale.result.cacheHit, false, "a schema-9 cache is re-extracted rather than served");
  const rewritten = JSON.parse(await fs.promises.readFile(metaPath, "utf8"));
  assert.strictEqual(rewritten.schema, BUNDLE_SCHEMA_VERSION, "and the cache that comes back is a schema-10 one");
  const staleLine = stale.logs.find((l) => l.includes("is stale"));
  assert.ok(staleLine, `the operator was told the cache was stale:\n${stale.logs.join("\n")}`);
  assert.ok(staleLine.includes("9 → 10"), `the line names both versions: ${staleLine}`);
  assert.ok(staleLine.includes(SCHEMA_CHANGE_NOTE), `and what changed: ${staleLine}`);
  assert.ok(staleLine.includes("ruby-markup measurements"), `in words that say what the new schema records: ${staleLine}`);

  // The chapter file on disk is the annotated one, not the guide-free one it replaced.
  const chapter = await fs.promises.readFile(path.join(fx.volumeDir, `${fx.base}-ch1.md`), "utf8");
  assert.ok(chapter.includes("<ruby>蒲田<rt>かまた</rt></ruby>"), "the re-extraction writes the annotated text");
  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
}

// ─── 8. the six audits over markup-bearing text: silent on a legitimate book ─

/**
 * A book shaped like volume 1 of the live series — cover, contents page, three chapters with pronunciation
 * guides in the prose, colophon — resolved through the real door and audited.
 *
 * @returns {Promise<Object>} The fixture, its bundle and the folder listing.
 */
async function annotatedBook() {
  const fx = await fixtureVolume("audit", {
    title: "Markup Audit",
    sourceName: "markup_audit(1).epub",
    pages: [
      { file: "p-001.xhtml", navTitle: "表紙", bodyClass: "p-cover", body: `<p>表紙</p>` },
      { file: "p-002.xhtml", navTitle: "目次", bodyClass: "p-toc", body: `<p>目次</p>` },
      { file: "p-003.xhtml", navTitle: "第一章", body: `<p>第一章</p>${prose("第一章")}` },
      {
        file: "p-004.xhtml",
        navTitle: "第二章",
        body: `<p>第二章</p><p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。<ruby>三色院<rt>パンジー</rt></ruby>も見た。${prose("第二章")}</p>`,
      },
      { file: "p-005.xhtml", navTitle: "第三章", body: `<p>第三章</p>${prose("第三章")}` },
      { file: "p-006.xhtml", navTitle: "奥付", bodyClass: "p-colophon", body: `<p>奥付</p>` },
    ],
  });
  const volumeFiles = await fs.promises.readdir(fx.volumeDir);
  return { ...fx, volumeFiles };
}

/**
 * The eight extraction checks over a book whose chapters carry ruby markup.
 */
async function scenarioAuditsStaySilent() {
  const fx = await annotatedBook();
  assert.strictEqual(fx.bundle.segments.length, 3, "three chapters");
  assert.strictEqual(fx.bundle.packaging.length, 3, "cover, contents page and colophon are packaging");

  // The chapter files on disk DO carry the markup — the audit is being asked about annotated text.
  const chapter = await fs.promises.readFile(path.join(fx.volumeDir, `${fx.base}-ch2.md`), "utf8");
  assert.ok(hasRubyMarkup(chapter), "the chapter file the audit is about carries ruby markup");
  assert.strictEqual(rubyMarkupUnitCount(chapter), 2, "two annotated words in it");

  const result = auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: fx.volumeFiles });
  assert.deepStrictEqual(
    result.findings.map((f) => `${f.severity} ${f.kind}`),
    [],
    `eight checks over annotated text found: ${result.findings.map((f) => `${f.severity} ${f.kind} — ${f.message}`).join(" | ")}`
  );
  assert.strictEqual(result.counts.chapters, 3, "and it still counts the book");
  assert.strictEqual(result.counts.HIGH, 0, "0 HIGH");
  assert.strictEqual(result.counts.MEDIUM, 0, "0 MEDIUM");
  for (const seg of fx.bundle.segments) {
    assert.strictEqual(seg.guideSplitForms, 0, `${seg.id}: the split tripwire measured 0 as it wrote the file`);
    // The two new measurements, on the segment the extraction wrote and on the bundle that reads it back.
    assert.ok(Number.isFinite(seg.rubyUnits), `${seg.id}: the bundle carries the chapter's ruby-unit count`);
    assert.strictEqual(seg.rubyShapeDefects, 0, `${seg.id}: the converter's own output is not a shape defect`);
    assert.strictEqual(
      seg.rubyUnits + seg.rubyUndisplayed,
      seg.rubyAnnotations,
      `${seg.id}: every harvested guide is either markup in the text or a guide written as plain text`
    );
  }
  assert.strictEqual(fx.bundle.rubyGuides.splitForms, 0, "the volume total is 0");
  assert.strictEqual(fx.bundle.rubyGuides.rubyShapeDefects, 0, "and so is the shape-defect total");
  assert.strictEqual(
    fx.bundle.rubyGuides.rubyUnits + fx.bundle.rubyGuides.rubyUndisplayed,
    fx.bundle.rubyGuides.guides,
    "the volume's markup adds up to the volume's harvest"
  );
  assert.strictEqual(fx.bundle.rubyGuides.guides, 2, "and the harvest still records the two guides");
  assert.ok(
    fx.volumeFiles.includes(`${fx.base}-ruby-guides.json`),
    "the harvest file is in the folder, so the harvest check is silent rather than missing"
  );
  for (const f of result.findings) {
    assert.ok(EXTRACTION_AUDIT_KINDS[f.kind], `any finding this audit can raise has a declared kind (${f.kind})`);
  }
  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
  ok("the eight extraction audits run over markup-bearing text and report 0 findings on a legitimate book");
}

// ─── 9. the tripwire still fires when a chapter really does hold the split string ─

/**
 * The guard is only worth having if it still fires. A chapter file that holds the old shape — a hand edit,
 * or a source that prints it as ordinary text — is still a HIGH.
 */
async function scenarioTripwireStillFires() {
  const fx = await fixtureVolume("tripwire", {
    title: "Markup Tripwire",
    sourceName: "markup_tripwire(1).epub",
    pages: [
      {
        file: "p-001.xhtml",
        navTitle: "第一章",
        body:
          `<p>第一章</p><p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。</p>` +
          `<p>誰かがこのファイルを直手で 蒲かま田た という形に書き換えた、という想定でこの文章を書く。</p>` +
          prose("第一章"),
      },
    ],
  });
  const result = auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: await fs.promises.readdir(fx.volumeDir) });
  assert.deepStrictEqual(result.findings.map((f) => `${f.severity} ${f.kind}`), ["HIGH guide-split-in-text"], "the planted split string is still a HIGH");
  assert.ok(result.findings[0].message.includes("蒲かま田た"), "and the finding names the string it found");
  assert.strictEqual(result.findings[0].levelDeclared, true, "whose level is a row in the level table, not a default");
  assert.strictEqual(fx.bundle.segments[0].guideSplitForms, 1, "measured as the file was written");
  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
  ok("the tripwire still fires on a chapter that really holds the split string, and only on that chapter");
}

// ─── 10. the plain-text door is untouched ────────────────────────────────────

/**
 * A plain-text volume has no converter in its path at all, so nothing about this change may reach it.
 */
async function scenarioPlainTextUntouched() {
  const seriesDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "markup-plain-"));
  const folder = "Plain(01)";
  const volumeDir = path.join(seriesDir, folder);
  await fs.promises.mkdir(volumeDir, { recursive: true });
  await fs.promises.writeFile(path.join(volumeDir, "plain(1).md"), "# 第一章\n\n本文です。\n");
  const bundle = await resolveSourceBundle({
    seriesDir,
    volume: { installmentNumber: "01", folder, sourceFile: `${folder}/plain(1).md` },
    volumeDir,
  });
  assert.strictEqual(bundle.format, "text");
  assert.strictEqual(bundle.rubyGuidesPath, null, "a plain-text source has no markup to harvest");
  assert.strictEqual(await readRubyGuideFile(volumeDir, "plain(1)"), null, "and no harvest file is written for it");
  const text = await fs.promises.readFile(path.join(volumeDir, "plain(1).md"), "utf8");
  assert.strictEqual(text, "# 第一章\n\n本文です。\n", "and the file itself is not rewritten");
  await fs.promises.rm(seriesDir, { recursive: true, force: true });
  ok("a plain-text volume gains no harvest file, no markup and no behaviour change");
}

// ─── 11. the converter's ruby-unit count is the store's, on every shape ──────

/**
 * `rubyUnitCountOf` (the converter's copy) and `rubyMarkupUnitCount` (the store's) are the same question
 * asked from two sides that may not require each other. The extraction's count check compares this count
 * against the harvest, so a drift between the two is a drift between the guard and the thing it guards.
 */
function scenarioUnitCountsAgree() {
  /** @type {Array<[string, number]>} */
  const shapes = [
    ["no markup at all", 0],
    ["<ruby>蒲田<rt>かまた</rt></ruby>", 1],
    ["<ruby>蒲田<rt>かまた</rt></ruby>と<ruby>三色院<rt>パンジー</rt></ruby>", 2],
    // The book's own per-piece markup: still ONE element, whatever the shape error inside it is.
    ["<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>", 1],
    // A nested ruby is two elements opened, and the shape scan calls it a defect for a different reason.
    ["<ruby>外<ruby>内<rt>ない</rt></ruby>側</ruby>", 2],
    // An element never closed is still an element opened.
    ["<ruby>蒲田<rt>かまた", 1],
    // A guide tag on its own is not a ruby.
    ["<rt>だけ</rt>", 0],
    ["text with <b>other</b> tags", 0],
    ["", 0],
  ];
  for (const [text, expected] of shapes) {
    assert.strictEqual(rubyUnitCountOf(text), expected, `rubyUnitCountOf(${JSON.stringify(text)})`);
    assert.strictEqual(rubyMarkupUnitCount(text), expected, `the store's count disagrees on ${JSON.stringify(text)}`);
  }
  ok("the converter's ruby-unit count and the store's are the same number on all 9 shapes");
}

// ─── 12. the canonical shape scan: silent on what the converter writes, loud on what it does not ─

/**
 * The scan is the guard behind `ruby-markup-not-canonical`. Two halves: it must report 0 defects on every
 * element the two converters actually write (otherwise it fires on every legitimate book, which is the
 * failure mode `utils/source/plan/01-extraction-step.md` §3 measured 666 of), and it must name each of the
 * six shapes it exists to name.
 */
function scenarioCanonicalShapeScan() {
  // (a) the converter's own output, both converters, over the shapes the real corpus is made of.
  const annotated = [
    `<p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。</p>`,
    `<p><ruby>三色院<rt>パンジー</rt></ruby>も<ruby>三色院菫子<rt>パンジー</rt></ruby>もいた。</p>`,
    `<p><ruby>亜茶花<rt>あ</rt><rt>さ</rt><rt>か</rt></ruby>と<ruby>玄武<rt>ジヨーロ</rt></ruby>。</p>`,
    `<p>ガイドのない<ruby>蒲田<rt>かまた</rt></ruby>だけの文。</p>`,
  ];
  for (const html of annotated) {
    const md = xhtmlToMarkdown(html, (s) => s, () => {});
    const plain = htmlToPlainText(html, () => {});
    for (const [label, text] of [["markdown", md], ["plain text", plain]]) {
      const scan = canonicalRubyShapeScan(text);
      assert.strictEqual(scan.defects, 0, `${label} of ${html}: the converter's own output is reported as defective: ${scan.examples.join(" | ")}`);
      assert.ok(scan.units > 0, `${label} of ${html}: the scan found no element to measure`);
      assert.strictEqual(scan.units, rubyUnitCountOf(text), `${label}: units counted twice, differently`);
    }
  }
  // The two converters must agree on the count for the same source, or the count check depends on which
  // path a page took.
  for (const html of annotated) {
    assert.strictEqual(
      rubyUnitCountOf(xhtmlToMarkdown(html, (s) => s, () => {})),
      rubyUnitCountOf(htmlToPlainText(html, () => {})),
      `the two converters disagree about how many guides ${html} carries`
    );
  }
  ok("the shape scan reports 0 defects on everything both converters actually write");

  // (b) each defect shape, named.
  /** @type {Array<[string, string, string]>} */
  const planted = [
    ["base-not-contiguous", "<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>", "the base is not one contiguous run — the old interleaving"],
    ["multiple-guide-runs", "<ruby>蒲田<rt>かま</rt><rt>た</rt></ruby>", "two guide runs over one word"],
    ["empty-guide", "<ruby>蒲田<rt></rt></ruby>", "markup with nothing in the guide"],
    ["empty-base", "<ruby><rt>だけ</rt></ruby>", "markup with no word in it"],
    ["nested-markup", "<ruby>外<ruby>内<rt>ない</rt></ruby>側</ruby>", "a tag inside the ruby that is not a guide"],
    ["unbalanced-markup", "<ruby>蒲田<rt>かまた", "an element that was never closed"],
    ["nested-markup", "<ruby>蒲田<rb>蒲</rb><rt>かまた</rt></ruby>", "a base tag the converter never writes"],
  ];
  for (const [reason, text, why] of planted) {
    const scan = canonicalRubyShapeScan(text);
    assert.strictEqual(scan.units, rubyUnitCountOf(text), `${text}: units`);
    assert.ok(scan.defects >= 1, `${text} (${why}) is not reported as a defect`);
    assert.ok(scan.reasons.includes(reason), `${text} (${why}) is not named "${reason}": ${scan.reasons.join(", ")}`);
    assert.ok(scan.examples.length >= 1 && scan.examples.length <= 3, `${text}: the scan quotes between 1 and 3 examples`);
    // A defect is a fact about the markup, and the guide-free projection is still the word: the two
    // measurements are independent, and the audit reports both.
    assert.ok(guideFreeTextOf(text).includes("蒲") || !text.includes("蒲"), `${text}: the strip lost the word`);
  }

  // (c) a clean element and a planted defect in the same chapter: the count is exact, and only the bad
  // element counts.
  const mixed = `<ruby>蒲田<rt>かまた</rt></ruby>と<ruby>三色院<rb>色</rb><rt>パンジー</rt></ruby>を見た。`;
  const scan = canonicalRubyShapeScan(mixed);
  assert.strictEqual(scan.units, 2, "two elements opened");
  assert.strictEqual(scan.defects, 1, "one of them is not canonical");
  assert.ok(scan.reasons.includes("nested-markup"), `and it is named: ${scan.reasons.join(", ")}`);

  // (d) `rubyWritesMarkup` is the stamp `displayed` carries, and it is `rubyTextFor`'s own rule.
  assert.strictEqual(rubyWritesMarkup({ base: "蒲田", reading: "かまた" }), true, "a whole word with a reading becomes markup");
  assert.strictEqual(rubyWritesMarkup({ base: "", reading: "だけ" }), false, "a reading with no word is plain text");
  assert.strictEqual(rubyWritesMarkup({ base: "蒲田", reading: "" }), false, "a word with no reading is plain text");
  assert.strictEqual(rubyWritesMarkup({ base: "a<b", reading: "x" }), false, "a half carrying a tag is plain text");
  assert.strictEqual(rubyWritesMarkup(null), false, "and nothing at all is plain text");
  for (const annotation of [
    { base: "蒲田", reading: "かまた" },
    { base: "", reading: "だけ" },
    { base: "蒲田", reading: "" },
    { base: "a<b", reading: "x" },
  ]) {
    const written = rubyTextFor(annotation);
    assert.strictEqual(
      rubyUnitCountOf(written),
      rubyWritesMarkup(annotation) ? 1 : 0,
      `rubyWritesMarkup disagrees with what rubyTextFor wrote for ${JSON.stringify(annotation)}: ${written}`
    );
  }
  ok("the shape scan names all six defects, counts them exactly, and `displayed` is `rubyTextFor`'s own rule");
}

(async () => {
  console.log("source-ruby-markup: the guide stays in the text, over a word that stays whole");
  scenarioCanonicalShape();
  await scenarioHarvestUnchanged();
  await scenarioTheThreeFallbacks();
  scenarioInlineNesting();
  scenarioTwoStripsAgree();
  scenarioGuideFreeMeasurements();
  await scenarioSchema8CacheRefused();
  await scenarioAuditsStaySilent();
  await scenarioTripwireStillFires();
  await scenarioPlainTextUntouched();
  scenarioUnitCountsAgree();
  scenarioCanonicalShapeScan();
  console.log(`\nsource-ruby-markup: all ${passed} checks passed.`);
})().catch((err) => {
  console.error("source-ruby-markup: FAILED");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

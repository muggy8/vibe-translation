/**
 * test/test-intake.js — pure tests for the series intake (no AI, no network).
 *
 * Covers the pieces the intake agent stands on:
 *   - the shared epub reader (utils/source.js openEpub / readEpubSection /
 *     scriptCounts) and the epub tools the intake agent uses (harness.js
 *     createEpubTools: epubInfo / readEpubText / stageVolume + its approve gate)
 *   - manifest schema-2 validation, folder-name sanitizing, installment-number
 *     normalization, and the manifest-based "--volume NN" lookup
 *   - the settings precedence rule (resolveRunSettings)
 *   - the plan-of-record stability rule (readCommittedLayout / applyCommittedLayout)
 *   - the deterministic (--dry-run) layout builder
 *   - the full intake run end to end with a stubbed agent (getTranslationTarget):
 *     validation + stamping + persisting the plan of record, .env overrides,
 *     committed-folder protection, the confidence gate, the correction turn,
 *     manifest reuse, and the loud failure when the agent produces no plan
 *
 * Run: node test/test-intake.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");

const {
  openEpub,
  readEpubSection,
  htmlToPlainText,
  scriptCounts,
  extractEpubToBundle,
  splitPlainTextSegments,
  materializeTextParts,
  shouldProcessChunked,
} = require("../utils/source");
const harness = require("../harness");
const {
  sanitizeFolderName,
  normalizeInstallmentNumber,
  filterVolumesByInstallment,
} = require("../utils/manifest");
const { resolveRunSettings } = require("../configs/shared");
const {
  buildDeterministicManifest,
  readCommittedLayout,
  applyCommittedLayout,
  confidenceGate,
  fixedValuesBlock,
  committedLayoutBlock,
  isVolumeArtifact,
  validateManifest,
  findDuplicateSources,
  readUsableManifest,
  createIntakeApprove,
  MANIFEST_SCHEMA,
  validateVolumeIntegrity,
  checkVolumeSourceShape,
  volumeIntegrityProblems,
  minVolumeTextChars,
} = require("../get-translation-target");

// ─── temp-dir helpers ─────────────────────────────────────────────────────────

const tmpDirs = [];
function makeTmpDir(prefix = "ai-client-intake-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ─── epub fixture builder ─────────────────────────────────────────────────────

/**
 * Build a minimal but real epub: container.xml + OPF (Dublin Core + a Calibre
 * series marker + an EPUB3 collection) + an EPUB3 nav + XHTML sections.
 *
 * @param {{title: string, series?: string, seriesIndex?: string, language?: string, sections: Array<{file: string, title: string, text: string}>, images?: number}} spec
 * @returns {Promise<Buffer>} The .epub bytes.
 */
async function buildEpub({ title, series, seriesIndex, language = "ja", sections, images = 0 }) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>` +
      `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>` +
      `</container>`
  );
  const metaExtras = [
    series
      ? `<meta property="belongs-to-collection" id="coll1">${series}</meta>` +
        `<meta refines="#coll1" property="collection-type">set</meta>` +
        `<meta refines="#coll1" property="group-type">series</meta>`
      : "",
    series ? `<meta name="calibre:series" content="${series}"/>` : "",
    seriesIndex ? `<meta name="calibre:series_index" content="${seriesIndex}"/>` : "",
  ].join("");
  const imageItems = Array.from({ length: images }, (_, i) =>
    `<item id="img${i}" href="images/i${i}.png" media-type="image/png"/>`
  ).join("");
  const manifestItems = sections
    .map((s, i) => `<item id="s${i}" href="${s.file}" media-type="application/xhtml+xml"/>`)
    .join("");
  const itemrefs = sections.map((_, i) => `<itemref idref="s${i}"/>`).join("");
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>` +
      `<package version="3.0" unique-identifier="bookid">` +
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      `<dc:identifier id="bookid">urn:uuid:book</dc:identifier>` +
      `<dc:title>${title}</dc:title>` +
      `<dc:creator>Some Author</dc:creator>` +
      `<dc:language>${language}</dc:language>` +
      `<dc:publisher>Some Publisher</dc:publisher>` +
      metaExtras +
      `</metadata>` +
      `<manifest>` +
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
      manifestItems +
      imageItems +
      `</manifest>` +
      `<spine>${itemrefs}</spine>` +
      `</package>`
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0"?><html><head><title>nav</title></head><body>` +
      `<nav><ol>` +
      sections.map((s) => `<li><a href="${s.file}">${s.title}</a></li>`).join("") +
      `</ol></nav></body></html>`
  );
  for (const s of sections) {
    zip.file(
      `OEBPS/${s.file}`,
      `<?xml version="1.0"?><html><head><title>${s.title}</title></head><body>` +
        `<h1>${s.title}</h1><p>${s.text}</p></body></html>`
    );
  }
  for (let i = 0; i < images; i++) {
    zip.file(`OEBPS/images/i${i}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Write a fixture epub into a folder and return its path. */
async function writeEpub(dir, name, spec) {
  const buf = await buildEpub(spec);
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, buf);
  return file;
}

const JP_TEXT = "その日、教室で出会った彼女はこう言った。今日からあなたと私は敵同士よ。";
const KR_TEXT = "그날 교실에서 만난 그녀는 이렇게 말했다. 오늘부터 우리는 적이다.";

// ─── Tests ────────────────────────────────────────────────────────────────────

(async () => {
  // ─── openEpub: the catalog card + the spine ────────────────────────────────
  const dir = makeTmpDir();
  const epubPath = await writeEpub(dir, "book01.epub", {
    title: "俺を好きなのはお前だけかよ",
    series: "俺を好きなのはお前だけかよ",
    seriesIndex: "3",
    language: "ja",
    sections: [
      { file: "prologue.xhtml", title: "序章", text: JP_TEXT },
      { file: "ch1.xhtml", title: "第一章 出会い", text: JP_TEXT + JP_TEXT },
    ],
    images: 2,
  });

  const opened = await openEpub(epubPath);
  assert.strictEqual(opened.metadata.title, "俺を好きなのはお前だけかよ", "dc:title");
  assert.strictEqual(opened.metadata.creator, "Some Author", "dc:creator");
  assert.strictEqual(opened.metadata.language, "ja", "dc:language");
  assert.strictEqual(opened.metadata.publisher, "Some Publisher", "dc:publisher");
  assert.strictEqual(opened.metadata.series, "俺を好きなのはお前だけかよ", "series marker");
  assert.strictEqual(opened.metadata.seriesIndex, "3", "series index");
  assert.deepStrictEqual(
    opened.metadata.collections,
    [{ name: "俺を好きなのはお前だけかよ", kinds: ["set", "series"] }],
    "EPUB3 collection entry"
  );
  assert.strictEqual(opened.textItems.length, 2, "two readable sections");
  assert.strictEqual(opened.textItems[0].index, 1, "sections are 1-based, in spine order");
  assert.strictEqual(opened.textItems[1].zipPath, "OEBPS/ch1.xhtml", "hrefs resolve against the OPF dir");
  assert.strictEqual(opened.titles.get("OEBPS/ch1.xhtml"), "第一章 出会い", "nav titles");
  assert.strictEqual(opened.imageCount, 2, "images declared in the OPF manifest");
  assert.ok(opened.entryCount > 4, "archive entry count");

  // A zip that is not an epub, and a file that is not a zip: loud errors.
  const notEpub = path.join(dir, "not-an-epub.epub");
  await fs.promises.writeFile(notEpub, await new JSZip().generateAsync({ type: "nodebuffer" }));
  await assert.rejects(() => openEpub(notEpub), /not a valid epub/i);
  const notZip = path.join(dir, "broken.epub");
  await fs.promises.writeFile(notZip, "this is not a zip");
  await assert.rejects(() => openEpub(notZip), /.+/);

  // The OPF is parsed as XML (so EPUB3's text-valued <meta> keeps its value) but
  // it must stay CASE-INSENSITIVE: XML mode keeps tag names exactly as written,
  // and real files do use <Package>/<Manifest>/<Spine>. A strict parser reports
  // those perfectly readable books as "the spine contains no readable items".
  const upperZip = new JSZip();
  upperZip.file("mimetype", "application/epub+zip");
  upperZip.file(
    "META-INF/container.xml",
    `<container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  );
  upperZip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?><Package version="3.0" unique-identifier="id">` +
      `<Metadata><dc:Title xmlns:dc="dc">Upper Case Book</dc:Title><dc:Language>ja</dc:Language></Metadata>` +
      `<Manifest><Item id="s0" href="c1.xhtml" media-type="application/xhtml+xml"/></Manifest>` +
      `<Spine><ItemRef idref="s0"/></Spine></Package>`
  );
  upperZip.file("OEBPS/c1.xhtml", `<?xml version="1.0"?><html><body><p>text</p></body></html>`);
  const upperPath = path.join(dir, "uppercase.opf.epub");
  await fs.promises.writeFile(upperPath, await upperZip.generateAsync({ type: "nodebuffer" }));
  const upperOpened = await openEpub(upperPath);
  assert.strictEqual(upperOpened.textItems.length, 1, "uppercase OPF tags still resolve");
  assert.strictEqual(upperOpened.metadata.title, "Upper Case Book", "uppercase Dublin Core too");

  // ─── htmlToPlainText: the text the intake agent judges a book by ───────────
  // A real chapter is ONE wrapping div around many <p>. Walking only the
  // top-level children glued every paragraph into one run-on line.
  assert.strictEqual(
    htmlToPlainText(`<html><body><div class="body"><p>line one</p><p>line two</p><p>line three</p></div></body></html>`),
    "line one\n\nline two\n\nline three",
    "paragraph breaks survive a wrapping div"
  );
  assert.strictEqual(htmlToPlainText(`<p>a <em>b</em> c</p>`), "a b c", "inline markup stays inside its sentence");
  assert.strictEqual(htmlToPlainText(`<div>lead<p>next</p></div>`), "lead\n\nnext", "mixed text and blocks");
  assert.strictEqual(htmlToPlainText(`<p>a<br/>b</p>`), "a\n\nb", "a hard break starts a new piece");
  assert.strictEqual(htmlToPlainText(`<html><body><script>var x=1;</script><p>real</p></body></html>`), "real");

  // ─── readEpubSection: bounded sampling ─────────────────────────────────────
  const first = await readEpubSection(opened, 1, { limit: 20 });
  assert.strictEqual(first.index, 1);
  assert.strictEqual(first.title, "序章");
  assert.strictEqual(first.text.length, 20, "the limit caps the slice");
  assert.strictEqual(first.from, 0);
  assert.ok(first.totalChars > 20, "the whole length is reported so the agent can page on");
  const paged = await readEpubSection(opened, 1, { offset: 20, limit: 20 });
  assert.strictEqual(paged.from, 20);
  assert.notStrictEqual(paged.text, first.text, "offset moves the window");
  const whole = await readEpubSection(opened, 1, { limit: 100000 });
  assert.strictEqual(whole.text.length, whole.totalChars, "a limit past the end returns it all");
  await assert.rejects(() => readEpubSection(opened, 9, {}), /does not exist/);

  // ─── scriptCounts: raw evidence, not a decision ────────────────────────────
  const jp = scriptCounts(JP_TEXT);
  assert.ok(jp.kana > 10, "kana present");
  assert.strictEqual(jp.hangul, 0, "no hangul in Japanese text");
  assert.strictEqual(scriptCounts(KR_TEXT).hangul > 10, true, "hangul means Korean");
  assert.strictEqual(scriptCounts("Hello world").latin, 10, "latin only");
  assert.strictEqual(scriptCounts("").total, 0);

  // ─── extractEpubToBundle still works on the shared openEpub ────────────────
  const volumeDir = path.join(dir, "Series(03)");
  await fs.promises.mkdir(volumeDir, { recursive: true });
  const bundle = await extractEpubToBundle(epubPath, volumeDir, "book01");
  assert.strictEqual(bundle.format, "epub");
  assert.deepStrictEqual(
    bundle.segments.map((s) => s.id),
    ["ch0", "ch1"],
    "reading order preserved (prologue then chapter)"
  );
  assert.strictEqual(bundle.segments[1].title, "第一章 出会い", "titles carried into the bundle");
  const wholeMd = await fs.promises.readFile(path.join(volumeDir, bundle.wholeFile), "utf-8");
  assert.ok(wholeMd.includes("第一章"), "the whole-volume file holds the chapters in order");

  // ─── plain-text chunking: the chapter-by-chapter fallback for big .md/.txt ──
  // Paragraph-aware, lossless, and a giant paragraph is its own segment.
  const paras = Array.from({ length: 1200 }, (_, i) => `Paragraph number ${i} with some body text in it.`);
  const bigText = paras.join("\n\n");
  const parts = splitPlainTextSegments(bigText, 30000);
  assert.ok(parts.length >= 2, `a 58KB text splits into ${parts.length} parts`);
  assert.ok(parts.every((p) => p.length <= 30000 + 60), "each part is near the target (a whole para may overshoot slightly)");
  const rejoined = parts.join("\n\n");
  assert.ok(paras.every((p) => rejoined.includes(p)), "every paragraph is preserved exactly once");
  assert.deepStrictEqual(splitPlainTextSegments("", 30000), [], "empty text → no parts");
  const giant = splitPlainTextSegments("x".repeat(5000) + "\n\nshort para", 1000);
  assert.strictEqual(giant.length, 2, "a giant paragraph is its own segment");
  assert.strictEqual(giant[0].length, 5000);

  // materializeTextParts writes the part files, caches by fingerprint, and
  // re-splits when the source changes.
  const chunkDir = makeTmpDir("ai-client-chunk-");
  const srcPath = path.join(chunkDir, "novel.txt");
  await fs.promises.writeFile(srcPath, bigText);
  const { sha256OfFile } = require("../utils/source");
  const fp = await sha256OfFile(srcPath);
  const m1 = await materializeTextParts(srcPath, chunkDir, "novel", bigText.length, fp, false);
  assert.ok(m1.length >= 2, "parts written");
  assert.ok(m1.every((p) => p.cacheHit === false), "first materialisation is a miss");
  assert.ok(await fs.promises.stat(path.join(chunkDir, m1[0].file)), "part files exist");
  const m2 = await materializeTextParts(srcPath, chunkDir, "novel", bigText.length, fp, false);
  assert.ok(m2.every((p) => p.cacheHit === true), "an unchanged source is a cache hit (no re-split)");
  assert.deepStrictEqual(m2.map((p) => p.file), m1.map((p) => p.file), "same part files");
  // A changed source (errata) re-splits and reuses the fingerprint key.
  await fs.promises.writeFile(srcPath, bigText + "\n\nAn errata paragraph added at the end.");
  const fp2 = await sha256OfFile(srcPath);
  const m3 = await materializeTextParts(srcPath, chunkDir, "novel", bigText.length + 40, fp2, false);
  assert.ok(m3.every((p) => p.cacheHit === false), "a changed source re-splits");
  assert.ok(m3[m3.length - 1].chars > m2[m2.length - 1].chars, "the new paragraph lands in the last part");

  // shouldProcessChunked: a multi-segment text bundle over the threshold chunks;
  // a single-segment (small) text bundle never does.
  assert.strictEqual(shouldProcessChunked({ format: "text", segments: [{}, {}], wholeChars: 40000 }, { thresholdChars: 120000 }), false, "under the threshold → whole");
  assert.strictEqual(shouldProcessChunked({ format: "text", segments: [{}, {}], wholeChars: 400000 }, { thresholdChars: 120000 }), true, "over the threshold → chunked");
  assert.strictEqual(shouldProcessChunked({ format: "text", segments: [{}], wholeChars: 400000 }, { thresholdChars: 120000 }), false, "a single-segment text bundle is always whole");
  assert.strictEqual(shouldProcessChunked({ format: "epub", segments: [{}, {}], wholeChars: 400000 }, { thresholdChars: 120000 }), true, "epub behaviour is unchanged");

  // ─── the epub tools the intake agent uses ──────────────────────────────────
  const seriesDir = makeTmpDir("ai-client-series-");
  const loose = await writeEpub(seriesDir, "loose01.epub", {
    title: "Loose One",
    series: "Loose",
    seriesIndex: "1",
    sections: [{ file: "c1.xhtml", title: "One", text: JP_TEXT }],
  });
  const gates = await harness.createEpubTools({
    cwd: seriesDir,
    allowedDirs: [seriesDir],
    sampleChars: 40,
  });

  const info = JSON.parse(await gates.tools.epubInfo.execute({ filePath: "loose01.epub" }));
  assert.strictEqual(info.metadata.title, "Loose One", "epubInfo reports the catalog card");
  assert.strictEqual(info.readableSections, 1);
  assert.strictEqual(info.sections[0].title, "One");
  assert.strictEqual(typeof info.sizeBytes, "number");
  assert.ok(info.textBytes > 0, "text size reported");
  assert.ok(
    String(await gates.tools.epubInfo.execute({ filePath: "nope.epub" })).includes("error"),
    "a missing book is reported to the agent, not thrown at it"
  );

  const sample = JSON.parse(await gates.tools.readEpubText.execute({ filePath: "loose01.epub" }));
  assert.strictEqual(sample.text.length, 40, "sampleChars caps the slice per call");
  assert.ok(sample.scripts.kana > 0, "the script counts come back as evidence");
  const smaller = JSON.parse(
    await gates.tools.readEpubText.execute({ filePath: "loose01.epub", limit: 12 })
  );
  assert.strictEqual(smaller.text.length, 12, "an explicit limit is honoured");

  // stageVolume: creates the folder, copies the source, never touches the original.
  const staged = JSON.parse(
    await gates.tools.stageVolume.execute({ sourceFile: "loose01.epub", folder: "Loose(01)" })
  );
  assert.strictEqual(staged.staged, true);
  assert.strictEqual(staged.unchanged, false);
  assert.strictEqual(staged.isEpub, true);
  assert.strictEqual(staged.file, path.join(seriesDir, "Loose(01)", "loose01.epub"));
  assert.ok(await fs.promises.stat(loose), "the original is still there");

  // Re-staging the same content is a no-op (idempotent).
  const again = JSON.parse(
    await gates.tools.stageVolume.execute({ sourceFile: "loose01.epub", folder: "Loose(01)" })
  );
  assert.strictEqual(again.unchanged, true, "re-staging identical content changes nothing");
  assert.strictEqual(again.sha256, staged.sha256);

  // Staging a DIFFERENT book over an existing staged file is refused.
  const other = await writeEpub(seriesDir, "other.epub", {
    title: "Other",
    sections: [{ file: "c1.xhtml", title: "One", text: KR_TEXT }],
  });
  const refused = await gates.tools.stageVolume.execute({
    sourceFile: "other.epub",
    folder: "Loose(01)",
    as: "loose01.epub",
  });
  assert.ok(String(refused).includes("refused"), "a different file is not clobbered");
  assert.ok(await fs.promises.stat(other), "the refused source is untouched");
  const stillThere = JSON.parse(
    await gates.tools.epubInfo.execute({ filePath: "Loose(01)/loose01.epub" })
  );
  assert.strictEqual(stillThere.metadata.title, "Loose One", "the staged book is unchanged");

  // Path safety: no escaping the series folder, no nested paths, no odd names.
  assert.ok(
    (await gates.tools.stageVolume.execute({ sourceFile: "other.epub", folder: "../outside" })).includes("refused")
  );
  assert.ok(
    (await gates.tools.stageVolume.execute({ sourceFile: "other.epub", folder: "a/b" })).includes("single folder name"),
    "nested volume folders are refused (the manifest validator forbids them too)"
  );
  assert.ok(
    (await gates.tools.stageVolume.execute({ sourceFile: "other.epub", folder: "/etc" })).includes("refused")
  );
  assert.ok(
    (await gates.tools.stageVolume.execute({ sourceFile: "other.epub", folder: "X(01)", as: "../escape.txt" })).includes("refused")
  );
  assert.ok(
    (await gates.tools.stageVolume.execute({ sourceFile: "missing.epub", folder: "X(02)" })).includes("not found")
  );
  assert.strictEqual(
    await fs.promises.stat(path.join(seriesDir, "outside")).then(() => "exists", () => "absent"),
    "absent",
    "the refused escape created nothing"
  );

  // The intake approve gate: the plain file tools are text tools, so they are
  // shut at book files (readFile on an epub returns zip bytes, and writeFile
  // over a book would destroy the source the pipeline exists to translate).
  const intakeGate = createIntakeApprove(
    await harness.createGatedFsTools({ cwd: seriesDir, allowedDirs: [seriesDir] }),
    await harness.createEpubTools({ cwd: seriesDir, allowedDirs: [seriesDir], sampleChars: 40 })
  );
  assert.strictEqual(intakeGate({ toolName: "readFile", input: { filePath: "loose01.epub" } }), false, "a book is not readable as text");
  assert.strictEqual(intakeGate({ toolName: "writeFile", input: { filePath: "loose01.epub" } }), false, "a book can never be overwritten");
  assert.strictEqual(intakeGate({ toolName: "editFile", input: { filePath: "Loose(01)/loose01.epub" } }), false);
  assert.strictEqual(intakeGate({ toolName: "readFile", input: { filePath: "notes.txt" } }), true, "plain text is still readable");
  assert.strictEqual(intakeGate({ toolName: "writeFile", input: { filePath: "translation-target.json" } }), true, "the outputs are still writable");
  assert.strictEqual(intakeGate({ toolName: "writeFile", input: { filePath: "../outside/x.md" } }), false, "the write gate still applies");
  assert.strictEqual(intakeGate({ toolName: "epubInfo", input: { filePath: "loose01.epub" } }), true, "the epub tools are the door to a book");
  assert.strictEqual(intakeGate({ toolName: "stageVolume", input: { sourceFile: "loose01.epub", folder: "Loose(01)" } }), true);
  assert.strictEqual(intakeGate({ toolName: "stageVolume", input: { sourceFile: "loose01.epub", folder: "../outside" } }), false);

  // The approve gate: reading a book is always allowed; staging is confined to
  // the allowed dirs; deletes are denied outright.
  assert.strictEqual(gates.approve({ toolName: "epubInfo", input: { filePath: "/anywhere/x.epub" } }), true);
  assert.strictEqual(gates.approve({ toolName: "readEpubText", input: { filePath: "loose01.epub" } }), true);
  assert.strictEqual(gates.approve({ toolName: "stageVolume", input: { sourceFile: "loose01.epub", folder: "Loose(01)" } }), true);
  assert.strictEqual(gates.approve({ toolName: "stageVolume", input: { sourceFile: "loose01.epub", folder: "../outside" } }), false);
  assert.strictEqual(gates.approve({ toolName: "stageVolume", input: { sourceFile: "loose01.epub", folder: "" } }), false);
  assert.strictEqual(gates.approve({ toolName: "deleteFile", input: { path: "loose01.epub" } }), false);

  // ─── folder names the agent chose are checked, not rewritten ───────────────
  assert.strictEqual(sanitizeFolderName("俺を好きなのはお前だけかよ(01)"), "俺を好きなのはお前だけかよ(01)", "source-language names are kept");
  assert.strictEqual(sanitizeFolderName("  Oresuki  (01)  "), "Oresuki (01)", "trimmed, inner runs collapsed");
  assert.strictEqual(sanitizeFolderName("Vol.3 - Side Story"), "Vol.3 - Side Story", "dashes and dots inside a name are fine");
  for (const bad of ["", "   ", "../evil", "a/b", "C:\\evil", "/abs", "..", ".", ".hidden", "trailing.", "bad:name", 'quote"', "star*", "q?u", "pipe|", "<angle>"]) {
    assert.throws(() => sanitizeFolderName(bad), /./, `rejected: ${JSON.stringify(bad)}`);
  }

  // ─── installment numbers ───────────────────────────────────────────────────
  assert.strictEqual(normalizeInstallmentNumber("1"), "01");
  assert.strictEqual(normalizeInstallmentNumber(3), "03");
  assert.strictEqual(normalizeInstallmentNumber("007"), "07");
  for (const bad of ["", "0", "abc", "-2", "1.5", null, undefined, {}]) {
    assert.throws(() => normalizeInstallmentNumber(bad), /positive integer|greater than zero/);
  }

  // "--volume NN" is looked up in the manifest, not parsed out of folder names.
  const manifestForFilter = {
    volumes: [
      { installmentNumber: "01", folder: "Oresuki(01)" },
      { installmentNumber: "02", folder: "Second Book" },
      { installmentNumber: "10", folder: "第十巻" },
    ],
  };
  assert.deepStrictEqual(filterVolumesByInstallment(manifestForFilter, "2"), ["Second Book"], "no (NN) in the name is fine");
  assert.deepStrictEqual(filterVolumesByInstallment(manifestForFilter, "02"), ["Second Book"]);
  assert.deepStrictEqual(filterVolumesByInstallment(manifestForFilter, "10"), ["第十巻"]);
  assert.deepStrictEqual(filterVolumesByInstallment(manifestForFilter, "Second Book"), ["Second Book"], "an exact folder name also matches");
  assert.deepStrictEqual(filterVolumesByInstallment(manifestForFilter, "9"), [], "no match is an empty list, not a guess");

  // ─── the manifest rules that keep a volume and its book in one place ──────
  /**
   * A minimal valid manifest for the pure validation tests. Every volume gets a
   * default `integrity` block so these fixtures stay focused on the rule each
   * test is actually about (the integrity requirement is tested on its own).
   */
  const OK_INTEGRITY = {
    isNarrative: true,
    confidence: 0.9,
    basis: "opening sample is continuous prose with chapter structure",
  };
  const manifestWith = (volumes) => ({
    schema: MANIFEST_SCHEMA,
    seriesName: "S",
    sourceLanguage: "Japanese",
    targetLanguage: "English",
    volumes: volumes.map((v) => ({ integrity: { ...OK_INTEGRITY }, ...v })),
  });
  // A volume's source must be the staged copy inside its own folder. Pointing a
  // volume at a loose file at the series root (or at another volume's book)
  // writes the artifacts into one folder while the book sits in another, and
  // the loose copy then looks like a new book to the next intake.
  assert.throws(
    () => validateManifest(manifestWith([{ installmentNumber: "01", folder: "Loose(01)", sourceFile: "loose01.epub" }])),
    /inside its own volume folder/,
    "a source at the series root is rejected"
  );
  assert.throws(
    () => validateManifest(manifestWith([{ installmentNumber: "01", folder: "A(01)", sourceFile: "B(02)/book.epub" }])),
    /inside its own volume folder/,
    "another volume's book is rejected"
  );
  assert.strictEqual(
    validateManifest(manifestWith([{ installmentNumber: "01", folder: "A(01)", sourceFile: "A(01)/book.epub" }])).volumes[0].sourceFile,
    "A(01)/book.epub",
    "the staged path is accepted"
  );
  assert.strictEqual(
    validateManifest(manifestWith([{ installmentNumber: "01", folder: "A(01)", sourceFile: "A(01)\\book.epub" }])).volumes[0].sourceFile,
    "A(01)/book.epub",
    "backslashes are stored as forward slashes (a Windows manifest must resolve on Linux)"
  );

  // The same book listed twice is the one mistake folder-name freedom makes
  // possible, and it doubles every cumulative artifact built on it.
  const dupDir = makeTmpDir("ai-client-dup-");
  for (const folder of ["A(01)", "B(02)"]) {
    await fs.promises.mkdir(path.join(dupDir, folder), { recursive: true });
  }
  await fs.promises.writeFile(path.join(dupDir, "A(01)", "book.epub"), "identical content");
  await fs.promises.writeFile(path.join(dupDir, "B(02)", "copy-of-book.epub"), "identical content");
  await fs.promises.writeFile(path.join(dupDir, "B(02)", "other.epub"), "a different book");
  const duplicate = await findDuplicateSources(
    dupDir,
    manifestWith([
      { installmentNumber: "01", folder: "A(01)", sourceFile: "A(01)/book.epub" },
      { installmentNumber: "02", folder: "B(02)", sourceFile: "B(02)/copy-of-book.epub" },
    ])
  );
  assert.ok(duplicate && /SAME book/.test(duplicate), "the same book as two volumes is detected");
  assert.ok(/discovery.excluded/.test(duplicate), "and the fix is spelled out for the agent");
  assert.strictEqual(
    await findDuplicateSources(
      dupDir,
      manifestWith([
        { installmentNumber: "01", folder: "A(01)", sourceFile: "A(01)/book.epub" },
        { installmentNumber: "02", folder: "B(02)", sourceFile: "B(02)/other.epub" },
      ])
    ),
    null,
    "distinct books pass"
  );

  // ─── per-volume integrity: "is this actually a book?" ──────────────────────
  // The judgment must EXIST, be stated, and say what it was based on. A gate
  // the model can pass by saying nothing is not a gate.
  assert.throws(() => validateVolumeIntegrity(undefined, "volumes[0]"), /integrity/, "a missing block is rejected");
  assert.throws(
    () => validateVolumeIntegrity({ isNarrative: "yes", confidence: 0.9, basis: "a".repeat(30) }, "volumes[0]"),
    /isNarrative/,
    "a non-boolean isNarrative is rejected"
  );
  assert.throws(
    () => validateVolumeIntegrity({ isNarrative: true, confidence: 4, basis: "a".repeat(30) }, "volumes[0]"),
    /confidence/,
    "a confidence outside 0..1 is rejected"
  );
  assert.throws(
    () => validateVolumeIntegrity({ isNarrative: true, confidence: 0.9, basis: "prose" }, "volumes[0]"),
    /basis/,
    "a one-word basis is rejected"
  );
  assert.deepStrictEqual(
    validateVolumeIntegrity({ isNarrative: true, confidence: 0.9, basis: " " + "a".repeat(30) + " " }, "volumes[0]"),
    { isNarrative: true, confidence: 0.9, basis: "a".repeat(30) },
    "a good block is normalised (basis trimmed)"
  );

  // validateManifest enforces the block per volume.
  assert.throws(
    () => validateManifest({ ...manifestWith([{ installmentNumber: "01", folder: "A(01)", sourceFile: "A(01)/book.epub" }]), volumes: [{ installmentNumber: "01", folder: "A(01)", sourceFile: "A(01)/book.epub" }] }),
    /integrity/,
    "a volume without an integrity block fails validation"
  );

  // The objective shape check — the half that needs no guessing about what a
  // story is. It can override the agent when the file is objectively not a book.
  process.env.DISCOVER_MIN_VOLUME_TEXT_CHARS = "200";
  assert.strictEqual(minVolumeTextChars(), 200, "the floor is env-driven");

  const shapeDir = makeTmpDir("ai-client-shape-");
  // A real epub with one short section → too thin by the (raised) floor.
  await fs.promises.mkdir(path.join(shapeDir, "Thin(01)"), { recursive: true });
  await writeEpub(path.join(shapeDir, "Thin(01)"), "thin.epub", {
    title: "Thin",
    series: "S",
    seriesIndex: 1,
    sections: [{ file: "c1.xhtml", title: "One", text: "just a short sentence." }],
  });
  let thin = await checkVolumeSourceShape(shapeDir, { folder: "Thin(01)", sourceFile: "Thin(01)/thin.epub" });
  assert.strictEqual(thin.ok, false, "an epub with under the floor of text is rejected");
  assert.ok(/under the/.test(thin.problem), "and the floor is named");

  // An archive with no readable text at all (only an image).
  const zip = new JSZip();
  zip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0"?><package xmlns="http://www.idli.org/2007/ops" version="3.0"><manifest><item id="img" href="art.png" media-type="image/png"/></manifest><spine><itemref idref="img"/></spine></package>`);
  zip.file("OEBPS/art.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]));
  await fs.promises.writeFile(path.join(shapeDir, "noimg.epub"), await zip.generateAsync({ type: "nodebuffer" }));
  let noText = await checkVolumeSourceShape(shapeDir, { folder: "X", sourceFile: "noimg.epub" });
  assert.strictEqual(noText.ok, false, "an archive with no text section is rejected");
  assert.ok(/no readable text/.test(noText.problem), "and why");

  // An art book: plenty of text, overwhelmingly images → rejected.
  await fs.promises.mkdir(path.join(shapeDir, "Art(01)"), { recursive: true });
  const artZip = new JSZip();
  artZip.file("META-INF/container.xml", `<?xml version="1.0"?><container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`);
  const artOpf = `<?xml version="1.0"?><package xmlns="http://www.idli.org/2007/ops" version="3.0"><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="big.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/><itemref idref="img"/></spine></package>`;
  artZip.file("OEBPS/content.opf", artOpf);
  artZip.file("OEBPS/c1.xhtml", `<html><body><p>${"a ".repeat(200)}prose that clears the floor so the image test is the one that fires.</p></body></html>`);
  // ~300KB of "image" bytes — 200KB of text × 4 is 800KB, so this must trip.
  artZip.file("OEBPS/big.png", Buffer.alloc(300 * 1024, 0x00));
  await fs.promises.writeFile(path.join(shapeDir, "Art(01)", "art.epub"), await artZip.generateAsync({ type: "nodebuffer" }));
  let art = await checkVolumeSourceShape(shapeDir, { folder: "Art(01)", sourceFile: "Art(01)/art.epub" });
  assert.strictEqual(art.ok, false, "an image-dominated archive is rejected");
  assert.ok(/overwhelmingly non-text/.test(art.problem), "and it is called an art book");

  // A sound book: text clears the floor, images are modest.
  await fs.promises.mkdir(path.join(shapeDir, "Good(01)"), { recursive: true });
  await writeEpub(path.join(shapeDir, "Good(01)"), "good.epub", {
    title: "Good",
    series: "S",
    seriesIndex: 1,
    sections: [{ file: "c1.xhtml", title: "One", text: "a ".repeat(400) + "a long enough passage of prose." }],
  });
  let good = await checkVolumeSourceShape(shapeDir, { folder: "Good(01)", sourceFile: "Good(01)/good.epub" });
  assert.strictEqual(good.ok, true, "a text-dominated book passes");

  // Plain-text sources: empty, too short, and binary-renamed are all rejected.
  await fs.promises.writeFile(path.join(shapeDir, "empty.txt"), "");
  let empty = await checkVolumeSourceShape(shapeDir, { folder: "E", sourceFile: "empty.txt" });
  assert.strictEqual(empty.ok, false, "an empty text file is rejected");
  await fs.promises.writeFile(path.join(shapeDir, "short.txt"), "only a few words");
  let short = await checkVolumeSourceShape(shapeDir, { folder: "E", sourceFile: "short.txt" });
  assert.strictEqual(short.ok, false, "a text file under the floor is rejected");
  // Raw bytes that are not valid UTF-8 — readFile(…, "utf8") turns them into
  // replacement characters, which is exactly the signature of a binary file.
  const junkBytes = Buffer.alloc(2000);
  for (let i = 0; i < 2000; i += 1) junkBytes[i] = 0xff;
  await fs.promises.writeFile(path.join(shapeDir, "junk.bin.txt"), junkBytes);
  let junk = await checkVolumeSourceShape(shapeDir, { folder: "E", sourceFile: "junk.bin.txt" });
  assert.strictEqual(junk.ok, false, "a binary file renamed to .txt is rejected");
  assert.ok(/undecodable/.test(junk.problem), "and it is named as such");
  await fs.promises.writeFile(path.join(shapeDir, "ok.txt"), "a ".repeat(400) + "enough text");
  let okText = await checkVolumeSourceShape(shapeDir, { folder: "E", sourceFile: "ok.txt" });
  assert.strictEqual(okText.ok, true, "a plain text file over the floor passes");
  delete process.env.DISCOVER_MIN_VOLUME_TEXT_CHARS;

  // volumeIntegrityProblems combines both halves: the agent's own judgment and
  // the objective shape.
  const comboDir = makeTmpDir("ai-client-combo-");
  await fs.promises.mkdir(path.join(comboDir, "NotAStory(01)"), { recursive: true });
  await fs.promises.writeFile(
    path.join(comboDir, "NotAStory(01)", "ok.txt"),
    "a ".repeat(400) + "text over the floor"
  );
  delete process.env.DISCOVER_MIN_VOLUME_TEXT_CHARS;
  const combo = {
    schema: MANIFEST_SCHEMA,
    seriesName: "S",
    sourceLanguage: "Japanese",
    targetLanguage: "English",
    volumes: [
      {
        installmentNumber: "01",
        folder: "NotAStory(01)",
        sourceFile: "NotAStory(01)/ok.txt",
        title: "T",
        notes: "",
        integrity: { isNarrative: false, confidence: 0.8, basis: "it reads like a transcript, not a story" },
      },
      {
        installmentNumber: "02",
        folder: "Unsure(01)",
        sourceFile: "Unsure(01)/ok.txt",
        title: "T",
        notes: "",
        integrity: { isNarrative: true, confidence: 0.3, basis: "a ".repeat(40) },
      },
    ],
  };
  const problems = await volumeIntegrityProblems(comboDir, combo);
  assert.strictEqual(problems.length, 2, "both unsound volumes are flagged");
  assert.ok(/NOT a narrative/.test(problems[0]), "a non-narrative volume is told to be excluded");
  assert.ok(/confidence/.test(problems[1]), "a low-confidence volume is flagged");

  // ─── settings precedence: .env > manifest > default ────────────────────────
  const savedEnv = {
    SERIES_NAME: process.env.SERIES_NAME,
    TRANSLATION_SOURCE_LANGUAGE: process.env.TRANSLATION_SOURCE_LANGUAGE,
    TRANSLATION_TARGET_LANGUAGE: process.env.TRANSLATION_TARGET_LANGUAGE,
  };
  const restore = () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const intakeManifest = {
    seriesName: "俺だけ",
    seriesNameAlt: "Oresuki",
    sourceLanguage: "Japanese",
    targetLanguage: "English",
  };
  try {
    delete process.env.SERIES_NAME;
    delete process.env.TRANSLATION_SOURCE_LANGUAGE;
    delete process.env.TRANSLATION_TARGET_LANGUAGE;
    assert.deepStrictEqual(
      resolveRunSettings(intakeManifest),
      { seriesName: "俺だけ", seriesNameAlt: "Oresuki", sourceLanguage: "Japanese", targetLanguage: "English" },
      "nothing in .env: the intake agent's decisions are used"
    );
    process.env.TRANSLATION_SOURCE_LANGUAGE = "Korean";
    assert.strictEqual(
      resolveRunSettings(intakeManifest).sourceLanguage,
      "Korean",
      "an explicit .env value beats the manifest"
    );
    process.env.SERIES_NAME = "My Series";
    assert.strictEqual(resolveRunSettings(intakeManifest).seriesName, "My Series", ".env override wins");
    delete process.env.TRANSLATION_SOURCE_LANGUAGE;
    delete process.env.SERIES_NAME;
    assert.strictEqual(resolveRunSettings(null).sourceLanguage, "Japanese", "no manifest: the default");
    assert.strictEqual(resolveRunSettings(null).targetLanguage, "English");
    assert.strictEqual(resolveRunSettings({}).targetLanguage, "English", "a manifest without the field: the default");
  } finally {
    restore();
  }

  // ─── the plan of record is stable: committed folders keep their names ──────
  const planDir = makeTmpDir("ai-client-plan-");
  const committedDir = path.join(planDir, "Oresuki(02)");
  await fs.promises.mkdir(committedDir, { recursive: true });
  const committedBook = await writeEpub(committedDir, "oresuki2.epub", {
    title: "Oresuki 2",
    series: "Oresuki",
    seriesIndex: "2",
    sections: [{ file: "c1.xhtml", title: "One", text: JP_TEXT }],
  });
  await fs.promises.writeFile(path.join(committedDir, "glossary.md"), "# glossary\n");
  // The same book loose at the series root (what a re-intake would plan from).
  await writeEpub(planDir, "oresuki2-copy.epub", {
    title: "Oresuki 2",
    series: "Oresuki",
    seriesIndex: "2",
    sections: [{ file: "c1.xhtml", title: "One", text: JP_TEXT }],
  });
  const newBook = await writeEpub(planDir, "oresuki3.epub", {
    title: "Oresuki 3",
    series: "Oresuki",
    seriesIndex: "3",
    sections: [{ file: "c1.xhtml", title: "One", text: JP_TEXT }],
  });

  const committed = await readCommittedLayout(planDir);
  const committedTwo = committed.find((c) => c.folder === "Oresuki(02)");
  assert.ok(committedTwo, "the existing folder is seen");
  assert.strictEqual(committedTwo.hasPipelineOutput, true, "glossary.md marks it as worked on");
  assert.ok(committedTwo.sources.some((s) => s.file === "oresuki2.epub"), "its staged book is recorded");

  const plan = {
    schema: MANIFEST_SCHEMA,
    seriesName: "Oresuki",
    sourceLanguage: "Japanese",
    targetLanguage: "English",
    volumes: [
      { installmentNumber: "02", folder: "Oresuki Volume Two", sourceFile: "oresuki2-copy.epub" },
      { installmentNumber: "03", folder: "Oresuki(03)", sourceFile: "oresuki3.epub" },
    ],
  };
  const warnings = await applyCommittedLayout(planDir, plan, committed);
  assert.strictEqual(warnings.length, 1, "renaming a finished folder is caught");
  assert.strictEqual(plan.volumes[0].folder, "Oresuki(02)", "the committed name is kept");
  assert.strictEqual(
    plan.volumes[0].sourceFile,
    path.join("Oresuki(02)", "oresuki2.epub"),
    "the manifest points at the copy already there"
  );
  assert.ok(plan.volumes[0].notes.includes("Oresuki(02)"), "the reason is recorded in the notes");
  assert.strictEqual(plan.volumes[1].folder, "Oresuki(03)", "a new volume keeps the planned name");
  assert.ok(await fs.promises.stat(committedBook), "the finished folder's book was not touched");
  assert.ok(await fs.promises.stat(newBook), "the new book was not touched either");

  // A plan that already reuses the committed name needs no correction.
  const goodPlan = {
    schema: MANIFEST_SCHEMA,
    seriesName: "Oresuki",
    sourceLanguage: "Japanese",
    targetLanguage: "English",
    volumes: [{ installmentNumber: "02", folder: "Oresuki(02)", sourceFile: "Oresuki(02)/oresuki2.epub" }],
  };
  assert.deepStrictEqual(await applyCommittedLayout(planDir, goodPlan, committed), [], "reusing a committed name is a no-op");

  // ─── the confidence gate ───────────────────────────────────────────────────
  process.env.DISCOVER_MIN_CONFIDENCE = "0.6";
  assert.strictEqual(confidenceGate({ discovery: { confidence: { order: 0.9, seriesName: 0.8 } } }).ok, true);
  const low = confidenceGate({ discovery: { confidence: { order: 0.3, seriesName: 0.9 } } });
  assert.strictEqual(low.ok, false, "a guessed order stops the run");
  assert.strictEqual(low.worstKey, "order");
  // Fail-closed: a gate the model can pass by saying nothing is not a gate.
  const silent = confidenceGate({});
  assert.strictEqual(silent.ok, false, "a plan that reports no confidence is refused");
  assert.ok(/no "discovery.confidence"/.test(silent.reason), "and the reason is stated");
  assert.strictEqual(confidenceGate({ discovery: { summary: "guessed", confidence: {} } }).ok, false, "an empty confidence block is refused too");
  process.env.DISCOVER_MIN_CONFIDENCE = "0";
  assert.strictEqual(confidenceGate({ discovery: { confidence: { order: 0.1 } } }).ok, true, "0 disables the gate");
  assert.strictEqual(confidenceGate({}).ok, true, "0 also disables the missing-confidence check");
  delete process.env.DISCOVER_MIN_CONFIDENCE;

  // ─── the deterministic (--dry-run) layout: a flat pile gets staged ─────────
  const flatDir = makeTmpDir("ai-client-flat-");
  await writeEpub(flatDir, "side-story.epub", {
    title: "Side Story",
    series: "Flat",
    seriesIndex: "2",
    sections: [{ file: "c1.xhtml", title: "One", text: JP_TEXT }],
  });
  await writeEpub(flatDir, "volume-one.epub", {
    title: "Volume One",
    series: "Flat",
    seriesIndex: "1",
    sections: [{ file: "c1.xhtml", title: "One", text: JP_TEXT }],
  });
  await fs.promises.writeFile(path.join(flatDir, "glossary.md"), "# not a book\n");
  const flat = await buildDeterministicManifest(flatDir, {
    sourceLanguage: "Japanese",
    targetLanguage: "English",
    seriesName: "Flat",
  });
  assert.strictEqual(flat.schema, MANIFEST_SCHEMA);
  assert.strictEqual(flat.volumes.length, 2, "only the two books became volumes");
  assert.ok(!flat.volumes.some((v) => v.folder.includes("glossary")), "pipeline output is never a source");
  assert.deepStrictEqual(flat.volumes.map((v) => v.installmentNumber), ["01", "02"], "natural order, numbered");
  assert.ok(
    await fs.promises.stat(path.join(flatDir, "side-story(01)", "side-story.epub")),
    "the flat pile was staged into volume folders"
  );
  assert.ok(
    await fs.promises.stat(path.join(flatDir, "volume-one.epub")),
    "staging copies: the originals are untouched"
  );
  assert.strictEqual(flat.volumes[0].sourceFile, path.join("side-story(01)", "side-story.epub"));
  assert.ok(isVolumeArtifact("translation-01.md") && !isVolumeArtifact("volume-one.epub"));

  // A series the intake agent already laid out must preview AS IT IS. The old
  // builder only recognised the legacy "<folder>/<folder>.epub" naming, so a
  // dry run re-staged every book into a SECOND set of folders next to the
  // committed ones — including the files the agent had deliberately excluded —
  // and previewed a different order than the real run.
  const laidOut = makeTmpDir("ai-client-laidout-");
  for (const [folder, file] of [["My Series(01)", "book-one.epub"], ["My Series(02)", "book-two.epub"]]) {
    await fs.promises.mkdir(path.join(laidOut, folder), { recursive: true });
    await writeEpub(laidOut, path.join(folder, file), {
      title: folder,
      series: "My Series",
      sections: [{ file: "c1.xhtml", title: "One", text: JP_TEXT }],
    });
    // the original copy is still loose at the root, exactly as stageVolume leaves it
    await fs.promises.copyFile(path.join(laidOut, folder, file), path.join(laidOut, file));
  }
  const laidOutPreview = await buildDeterministicManifest(laidOut, {
    sourceLanguage: "Japanese",
    targetLanguage: "English",
    seriesName: undefined, // SERIES_NAME is optional now — the preview must still work
  });
  assert.deepStrictEqual(
    laidOutPreview.volumes.map((v) => v.sourceFile),
    ["My Series(01)/book-one.epub", "My Series(02)/book-two.epub"],
    "the committed folders are previewed, with the file names the agent chose"
  );
  assert.deepStrictEqual(
    laidOutPreview.volumes.map((v) => v.installmentNumber),
    ["01", "02"],
    "numbered from the folder names"
  );
  assert.deepStrictEqual(
    fs.readdirSync(laidOut).filter((n) => n.endsWith(")")).sort(),
    ["My Series(01)", "My Series(02)"],
    "no rival set of volume folders was created"
  );

  // ─── the prompt blocks the agent is given ──────────────────────────────────
  const fixed = fixedValuesBlock({ targetLanguage: "English" });
  assert.ok(fixed.includes("English") && fixed.includes("yours to decide"), "nothing fixed but the target");
  const fixedAll = fixedValuesBlock({ seriesName: "S", sourceLanguage: "Japanese", targetLanguage: "English" });
  assert.ok(fixedAll.includes("use exactly this: S"), "an override is stated as a command");
  assert.ok(committedLayoutBlock([]).includes("no pipeline output"));
  const block = committedLayoutBlock([
    { folder: "Oresuki(02)", hasPipelineOutput: true, sources: [{ file: "oresuki2.epub", sha256: "x" }] },
    { folder: "Draft(03)", hasPipelineOutput: false, sources: [{ file: "oresuki3.epub", sha256: "y" }] },
  ]);
  assert.ok(block.includes("Reuse their names") && block.includes("Oresuki(02)"), "committed folders are called out");
  assert.ok(block.includes("Draft(03)"), "uncommitted folders are listed separately");

  // ─── the full intake run, end to end with a stubbed agent ──────────────────
  // The live path (getTranslationTarget without --dry-run) is exercised offline:
  // the harness is monkey-patched (the same pattern as test-qa-orchestration.js)
  // and the fake agent writes the manifest with the real file system, the way
  // the real agent does with writeFile. No AI, no network.
  const intake = require("../get-translation-target");
  const realHarness = {
    createAgentHandle: harness.createAgentHandle,
    createGatedFsTools: harness.createGatedFsTools,
    createEpubTools: harness.createEpubTools,
    logLine: harness.logLine,
  };
  const envKeys = [
    "SERIES_LOCATION",
    "SERIES_NAME",
    "TRANSLATION_SOURCE_LANGUAGE",
    "TRANSLATION_TARGET_LANGUAGE",
    "DISCOVER_MIN_CONFIDENCE",
    "DISCOVER_MAX_ATTEMPTS",
  ];
  const envBackup = {};
  for (const key of envKeys) envBackup[key] = process.env[key];

  const logs = [];
  harness.logLine = (message) => {
    logs.push(String(message));
  };
  harness.createGatedFsTools = async () => ({ tools: {}, approve: () => true });
  harness.createEpubTools = async () => ({ tools: {}, approve: () => true });

  /**
   * Install a fake intake agent that writes the given plans (one entry per turn)
   * to disk and reports a real tool call, like the real agent's writeFile turn.
   * @param {Array<{manifest?: Object, plan?: string, text?: string}>} plans
   * @returns {void}
   */
  function stubIntakeAgent(plans) {
    let turn = 0;
    harness.createAgentHandle = async ({ cwd }) => ({
      sendTurn: async () => {
        const plan = plans[Math.min(turn, plans.length - 1)];
        turn += 1;
        if (plan.manifest !== undefined) {
          await fs.promises.writeFile(
            path.join(cwd, intake.DRAFT_MANIFEST_FILE_NAME),
            JSON.stringify(plan.manifest, null, 2)
          );
        }
        if (plan.plan !== undefined) {
          await fs.promises.writeFile(path.join(cwd, intake.PLAN_FILE_NAME), plan.plan);
        }
        return { text: plan.text || "", toolCalls: [{ toolName: "writeFile" }] };
      },
      close: async () => {},
    });
  }

  /** A valid agent plan for the given volume list. */
  const planFor = (volumes, confidence = { volumes: 0.9, order: 0.9, language: 0.9 }) => ({
    manifest: {
      schema: MANIFEST_SCHEMA,
      seriesName: "Oresuki",
      seriesNameAlt: "Oresuki",
      sourceLanguage: "Japanese",
      targetLanguage: "English",
      discovery: {
        summary: "Two volumes, in the order the series marker numbered them.",
        confidence,
        evidence: ["calibre:series matched on both books"],
        excluded: [],
      },
      volumes,
    },
    plan: "# Translation plan\n\nTwo volumes.\n",
  });
  const twoVolumes = () => [
    { installmentNumber: "1", folder: "Oresuki(01)", sourceFile: path.join("Oresuki(01)", "vol1.epub"), title: "Vol 1", notes: "", integrity: { isNarrative: true, confidence: 0.9, basis: "opening sample is continuous prose with chapter structure" } },
    { installmentNumber: "2", folder: "Oresuki(02)", sourceFile: path.join("Oresuki(02)", "vol2.epub"), title: "Vol 2", notes: "", integrity: { isNarrative: true, confidence: 0.9, basis: "opening sample is continuous prose with chapter structure" } },
  ];

  /** Point the run at a temp series dir (1 attempt, so a failing case stays fast). */
  function setSeriesEnv(dir, extra = {}) {
    process.env.SERIES_LOCATION = dir;
    process.env.DISCOVER_MAX_ATTEMPTS = "1";
    // The fixture books are one short paragraph each, so the objective
    // "is there any text at all" floor has to be lowered for them. The floor
    // itself is tested on its own (see the integrity checks below).
    process.env.DISCOVER_MIN_VOLUME_TEXT_CHARS = "10";
    delete process.env.SERIES_NAME;
    delete process.env.TRANSLATION_SOURCE_LANGUAGE;
    delete process.env.DISCOVER_MIN_CONFIDENCE;
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const liveDir = makeTmpDir("ai-client-intake-live-");
  for (const [folder, index] of [["Oresuki(01)", "1"], ["Oresuki(02)", "2"]]) {
    await fs.promises.mkdir(path.join(liveDir, folder), { recursive: true });
    await writeEpub(path.join(liveDir, folder), `vol${index}.epub`, {
      title: `Volume ${index}`,
      series: "Oresuki",
      seriesIndex: index,
      sections: [{ file: "c1.xhtml", title: "One", text: JP_TEXT }],
    });
  }

  // A. the happy path: the agent's plan is validated, stamped, and persisted.
  setSeriesEnv(liveDir);
  stubIntakeAgent([planFor(twoVolumes())]);
  const live = await intake.getTranslationTarget({ forceIntake: true });
  assert.strictEqual(live.seriesLocation, liveDir, "the live SERIES_LOCATION wins over the agent's copy");
  assert.deepStrictEqual(live.volumes.map((v) => v.installmentNumber), ["01", "02"], "installment numbers normalized");
  const persisted = intake.extractJsonObject(
    await fs.promises.readFile(path.join(liveDir, intake.MANIFEST_FILE_NAME), "utf-8")
  );
  assert.strictEqual(persisted.seriesName, "Oresuki", "the agent's series name is the plan of record");
  assert.strictEqual(persisted.generator, "get-translation-target.js");
  assert.ok(await fs.promises.stat(path.join(liveDir, intake.PLAN_FILE_NAME)), "the human-readable plan was written");

  // B. .env overrides win over the agent's decisions.
  setSeriesEnv(liveDir, { SERIES_NAME: "Chosen Name", TRANSLATION_SOURCE_LANGUAGE: "Korean" });
  stubIntakeAgent([planFor(twoVolumes())]);
  const overridden = await intake.getTranslationTarget({ forceIntake: true });
  assert.strictEqual(overridden.seriesName, "Chosen Name", "SERIES_NAME overrides the agent's name");
  assert.strictEqual(overridden.sourceLanguage, "Korean", "TRANSLATION_SOURCE_LANGUAGE overrides the agent's guess");
  assert.strictEqual(overridden.targetLanguage, "English", "the target language is a fixed setting");

  // C. a folder that already holds pipeline output keeps its name.
  const keepDir = makeTmpDir("ai-client-intake-committed-");
  for (const folder of ["Old(01)", "Pretty(01)"]) {
    await fs.promises.mkdir(path.join(keepDir, folder), { recursive: true });
    // A real archive: the intake now checks that a listed volume actually opens
    // and contains readable text (see checkVolumeSourceShape).
    await writeEpub(path.join(keepDir, folder), "book.epub", {
      title: "Book",
      series: "Oresuki",
      seriesIndex: 1,
      sections: [{ file: "c1.xhtml", title: "One", text: JP_TEXT }],
    });
  }
  await fs.promises.writeFile(path.join(keepDir, "Old(01)", "glossary.md"), "# glossary\n");
  setSeriesEnv(keepDir);
  stubIntakeAgent([
    planFor([
      { installmentNumber: "1", folder: "Pretty(01)", sourceFile: path.join("Pretty(01)", "book.epub"), title: "One", notes: "", integrity: { isNarrative: true, confidence: 0.9, basis: "opening sample is continuous prose with chapter structure" } },
    ]),
  ]);
  const kept = await intake.getTranslationTarget({ forceIntake: true });
  assert.strictEqual(kept.volumes[0].folder, "Old(01)", "the folder holding pipeline output keeps its name");
  assert.strictEqual(kept.volumes[0].sourceFile, path.join("Old(01)", "book.epub"), "and the manifest points at the copy already there");
  assert.ok(kept.volumes[0].notes.includes("folder kept"), "the reason is recorded in the manifest");
  assert.ok(logs.some((l) => /keeping that folder name/.test(l)), "the disagreement is logged");


  // D. the confidence gate stops an unsure plan.
  setSeriesEnv(liveDir);
  stubIntakeAgent([planFor(twoVolumes(), { volumes: 0.9, order: 0.2, language: 0.9 })]);
  await assert.rejects(
    () => intake.getTranslationTarget({ forceIntake: true }),
    /DISCOVER_MIN_CONFIDENCE/,
    "low confidence stops the run"
  );

  // E. an agent that writes nothing on its first turn is given the correction turn.
  setSeriesEnv(liveDir);
  stubIntakeAgent([{ text: "" }, planFor(twoVolumes())]);
  const corrected = await intake.getTranslationTarget({ forceIntake: true });
  assert.strictEqual(corrected.volumes.length, 2, "the correction turn saved the attempt");
  assert.ok(logs.some((l) => /correction turn/.test(l)), "the correction turn is logged");

  // F. a valid committed manifest is reused without running the agent again.
  setSeriesEnv(liveDir);
  harness.createAgentHandle = async () => {
    throw new Error("the intake agent must not run when a valid manifest is cached");
  };
  const reused = await intake.getTranslationTarget();
  assert.strictEqual(reused.volumes.length, 2, "the cached plan of record was reused");
  assert.ok(logs.some((l) => /reusing the existing manifest/.test(l)), "the reuse is logged");

  // G. an INVALID cached manifest is never reused — not even when every file it
  // lists still exists. (The bug this pins: the code logged "cached manifest is
  // invalid … re-running intake" and then returned that manifest on the next
  // line, so an old-schema plan with an unsanitized folder name and an
  // un-normalized installment number went to every downstream task.)
  setSeriesEnv(liveDir);
  await fs.promises.writeFile(
    path.join(liveDir, intake.MANIFEST_FILE_NAME),
    JSON.stringify({
      schema: 1,
      seriesName: "Old Name",
      sourceLanguage: "Japanese",
      targetLanguage: "English",
      volumes: [{ installmentNumber: "1", folder: "Bad:Name", sourceFile: "Oresuki(01)/vol1.epub" }],
    })
  );
  assert.strictEqual(
    await readUsableManifest(liveDir, path.join(liveDir, intake.MANIFEST_FILE_NAME)),
    null,
    "an invalid manifest is not usable"
  );
  stubIntakeAgent([planFor(twoVolumes())]);
  const repaired = await intake.getTranslationTarget();
  assert.strictEqual(repaired.schema, MANIFEST_SCHEMA, "the old-schema plan was replaced, not reused");
  assert.notStrictEqual(repaired.seriesName, "Old Name", "and the agent's decisions are the plan of record");
  assert.ok(logs.some((l) => /cached manifest is invalid/.test(l)), "the rejection is logged");
  assert.ok(logs.some((l) => /running the intake agent/.test(l)), "intake actually re-ran");

  // H. a half-written manifest (no volumes at all) must not crash the task.
  setSeriesEnv(liveDir);
  await fs.promises.writeFile(
    path.join(liveDir, intake.MANIFEST_FILE_NAME),
    JSON.stringify({ schema: MANIFEST_SCHEMA, seriesName: "Half written" })
  );
  stubIntakeAgent([planFor(twoVolumes())]);
  const repaired2 = await intake.getTranslationTarget();
  assert.strictEqual(repaired2.volumes.length, 2, "a corrupt plan falls back to a fresh intake");

  // H2. a FAILED intake must not destroy the plan of record. (The bug this
  // pins: runDiscoveryAgent deleted translation-target.json before the agent
  // even ran, so an intake that failed left the series with NO plan — and every
  // later task then had to re-decide the whole series from scratch.)
  setSeriesEnv(liveDir);
  stubIntakeAgent([{ manifest: { schema: MANIFEST_SCHEMA, seriesName: "Broken" } }]);
  const before = await fs.promises.readFile(path.join(liveDir, intake.MANIFEST_FILE_NAME), "utf-8");
  await assert.rejects(() => intake.getTranslationTarget({ forceIntake: true }), /intake failed/i);
  assert.strictEqual(
    await fs.promises.readFile(path.join(liveDir, intake.MANIFEST_FILE_NAME), "utf-8"),
    before,
    "the previous plan of record survived the failed intake untouched"
  );
  // The rejected draft may stay on disk (it is the evidence of what the agent
  // got wrong) — but it is never the plan of record, and it is never read as
  // one: readUsableManifest only ever looks at translation-target.json.
  assert.ok(
    await fs.promises.stat(path.join(liveDir, intake.DRAFT_MANIFEST_FILE_NAME)).catch(() => null),
    "the rejected draft is kept as diagnostic evidence"
  );
  assert.ok(
    await readUsableManifest(liveDir, path.join(liveDir, intake.MANIFEST_FILE_NAME)),
    "the surviving plan of record still validates as the plan of record"
  );
  // …and the next run still works off the surviving plan, with no intake.
  harness.createAgentHandle = async () => {
    throw new Error("the intake agent must not run when a valid manifest survived");
  };
  const afterFailure = await intake.getTranslationTarget();
  assert.strictEqual(afterFailure.volumes.length, 2, "the surviving plan of record is still the plan of record");

  // I. --dry-run previews the committed plan instead of building a rival layout
  // (and creates nothing on disk while doing it).
  setSeriesEnv(liveDir);
  const beforePreview = fs.readdirSync(liveDir);
  const preview = await intake.getTranslationTarget({ dryRun: true });
  assert.deepStrictEqual(
    preview.volumes.map((v) => v.folder),
    ["Oresuki(01)", "Oresuki(02)"],
    "the preview is the plan the real run will follow"
  );
  assert.deepStrictEqual(fs.readdirSync(liveDir), beforePreview, "the dry run created no new folders");
  assert.ok(logs.some((l) => /previewing the committed plan of record/.test(l)), "the preview is logged");

  // J. a series with no committed plan previews ANYWAY: the deterministic
  //    layout names itself from the books it found. (SERIES_NAME is no longer a
  //    variable every .env carries — the intake agent normally decides it, and a
  //    preview must not depend on a value the real run does not need.)
  setSeriesEnv(liveDir);
  await fs.promises.unlink(path.join(liveDir, intake.MANIFEST_FILE_NAME));
  const previewUnnamed = await intake.getTranslationTarget({ dryRun: true });
  assert.ok(
    previewUnnamed.volumes.length >= 2,
    "the deterministic layout previews with no SERIES_NAME in .env"
  );
  assert.strictEqual(
    previewUnnamed.seriesName,
    "Oresuki",
    "the preview derived the series name from the volume folders it found"
  );
  await writeEpub(liveDir, "loose-extra.epub", {
    title: "Loose Extra",
    series: "Oresuki",
    sections: [{ file: "c1.xhtml", title: "One", text: JP_TEXT }],
  });
  process.env.SERIES_NAME = "Oresuki";
  const previewNamed = await intake.getTranslationTarget({ dryRun: true });
  assert.ok(previewNamed.volumes.length >= 2, "an explicit SERIES_NAME still wins");
  assert.strictEqual(previewNamed.seriesName, "Oresuki", "and it is used verbatim");
  delete process.env.SERIES_NAME;
  // restore the committed plan for anything after this block
  stubIntakeAgent([planFor(twoVolumes())]);
  await intake.getTranslationTarget({ forceIntake: true });

  // K. the same book planned as two volumes is rejected — and shown to the agent
  // as its own correction task before the attempt is thrown away.
  const dupLive = makeTmpDir("ai-client-intake-dup-");
  for (const folder of ["First(01)", "Second(02)"]) {
    await fs.promises.mkdir(path.join(dupLive, folder), { recursive: true });
    await fs.promises.writeFile(path.join(dupLive, folder, "book.epub"), "the same book, staged twice");
  }
  setSeriesEnv(dupLive);
  stubIntakeAgent([
    planFor([
      { installmentNumber: "1", folder: "First(01)", sourceFile: "First(01)/book.epub", title: "One", notes: "", integrity: { isNarrative: true, confidence: 0.9, basis: "opening sample is continuous prose with chapter structure" } },
      { installmentNumber: "2", folder: "Second(02)", sourceFile: "Second(02)/book.epub", title: "Two", notes: "", integrity: { isNarrative: true, confidence: 0.9, basis: "opening sample is continuous prose with chapter structure" } },
    ]),
  ]);
  await assert.rejects(
    () => intake.getTranslationTarget({ forceIntake: true }),
    /SAME book/,
    "a duplicated volume stops the run"
  );
  assert.ok(logs.some((l) => /correction turn/.test(l)), "the agent was given the chance to fix it first");

  // L. an agent that never produces a plan fails the step loudly.
  setSeriesEnv(liveDir);
  stubIntakeAgent([{ text: "" }]);
  await assert.rejects(
    () => intake.getTranslationTarget({ forceIntake: true }),
    /Series intake failed after 1 attempt/,
    "a planless agent fails the step"
  );

  for (const key of envKeys) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
  Object.assign(harness, realHarness);


  console.log("intake: all checks passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

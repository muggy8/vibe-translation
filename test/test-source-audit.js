/**
 * test/test-source-audit.js — the extraction audit: six checks, each one fired and each one kept
 * silent, on fixtures (no AI, no network, no real volume).
 *
 * The audit (`utils/source/audit.js` + `utils/source/audit/`) is the check that was missing when four
 * stages were told a 102,892-token novel was a 2,394-token single-segment source (gotcha 119), and when
 * a converter that split 蒲田 into 蒲かま田た sat in all 17 volumes unnoticed (gotcha 123). It is a pure
 * function over what the extraction layer already produced, so every one of these scenarios is a
 * fixture book built with jszip, run through the real `resolveSourceBundle`, and audited — the same
 * bundle the nine pipeline stages would have received.
 *
 * Each of the six checks gets two fixtures: one planted so it fires at the right severity with the
 * right `kind`, and one clean so it stays silent. A check that only has the firing fixture is a check
 * that can be made to fire on anything.
 *
 * The packaging exemption is tested from both sides, because it is the one place this audit could
 * invent holes that are not there: the pages the book declares as packaging (a cover plate, the
 * contents page, the colophon) legitimately have no story text, and reporting them as missing chapters
 * is the exact phantom-"EMPTY IN SOURCE" failure gotcha 52 records. The fixture that used to be the
 * exemption's blind spot — a cover plate the book names after its own FILE, which no packaging word
 * list can recognise — is here too, and it is the reason a segment now carries the book's declaration
 * as a fact (gotcha 126).
 *
 * Run: node test/test-source-audit.js
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");

const { resolveSourceBundle, auditExtractedVolume, EXTRACTION_AUDIT_KINDS, EXTRACTION_STEP } = require("../utils/source");
const { rubyGuideFileName } = require("../utils/source/ruby-guides");
const { readModuleLayer } = require("./module-layer");

const PROJECT_ROOT = path.join(__dirname, "..");

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
 * The extraction is loud on purpose, and these fixtures are deliberately broken books, so the warnings
 * are correct — they just are not the thing under test.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{result: T, logs: string[]}>}
 */
async function quiet(fn) {
  const realLog = console.log;
  const realWarn = console.warn;
  /** @type {string[]} */
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  try {
    return { result: await fn(), logs };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

/**
 * Build a fixture book.
 *
 * @param {{title: string, pages: Array<{file: string, pageTitle: string, navTitle?: string|null, bodyClass?: string, body: string}>}} spec
 *   `navTitle` is what the book's OWN contents list calls this page (no navTitle = the contents list
 *   does not name it, which is the shape that makes a page an inserted illustration or an undeclared
 *   section). `bodyClass` is what the page declares itself to be (`p-cover`, `p-colophon`, …).
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
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:audit</dc:identifier>` +
      `<dc:title>${title}</dc:title><dc:language>ja</dc:language></metadata><manifest>` +
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
      pages.map((p, i) => `<item id="p${i}" href="${p.file}" media-type="application/xhtml+xml"/>`).join("") +
      `</manifest><spine>${pages.map((_, i) => `<itemref idref="p${i}"/>`).join("")}</spine></package>`
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0"?><html><head><title>nav</title></head><body><nav><ol>` +
      pages
        .filter((p) => p.navTitle)
        .map((p) => `<li><a href="${p.file}">${p.navTitle}</a></li>`)
        .join("") +
      `</ol></nav></body></html>`
  );
  for (const p of pages) {
    zip.file(
      `OEBPS/${p.file}`,
      `<?xml version="1.0"?><html><head><title>${p.pageTitle}</title></head>` +
        `<body class="${p.bodyClass || "main"}">${p.body}</body></html>`
    );
  }
  zip.file("OEBPS/images/plate.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return zip.generateAsync({ type: "nodebuffer" });
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

/**
 * Lay out one fixture volume: a folder holding a fixture book, resolved through the real door.
 *
 * @param {string} tag - Prefix for the throwaway folder.
 * @param {{title: string, sourceName: string, pages: Object[]}} spec
 * @returns {Promise<{seriesDir: string, volumeDir: string, volume: Object, bundle: Object, logs: string[]}>}
 */
async function fixtureVolume(tag, spec) {
  const seriesDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `audit-${tag}-`));
  const folder = `${spec.title}(01)`;
  const volumeDir = path.join(seriesDir, folder);
  await fs.promises.mkdir(volumeDir, { recursive: true });
  await fs.promises.writeFile(path.join(volumeDir, spec.sourceName), await buildBookEpub(spec));
  const volume = { installmentNumber: "01", folder, sourceFile: `${folder}/${spec.sourceName}` };
  const { result: bundle, logs } = await quiet(() =>
    resolveSourceBundle({ seriesDir, volume, volumeDir })
  );
  return { seriesDir, volumeDir, volume, bundle, logs };
}

/**
 * The volume folder's file listing, in the form a caller naturally has it.
 *
 * @param {string} volumeDir
 * @returns {Promise<string[]>}
 */
async function listingOf(volumeDir) {
  return fs.promises.readdir(volumeDir);
}

/**
 * Assert one audit result is exactly the findings expected, and that every finding is a well-formed
 * post-mortem finding.
 *
 * @param {Object} auditResult - What auditExtractedVolume returned.
 * @param {Array<{severity: "HIGH"|"MEDIUM", kind: string}>} expected - The findings, in order.
 * @param {string} label
 */
function assertFindings(auditResult, expected, label) {
  const got = auditResult.findings.map((f) => `${f.severity} ${f.kind}`);
  const want = expected.map((f) => `${f.severity} ${f.kind}`);
  assert.deepStrictEqual(got, want, `${label}: expected ${want.join(", ") || "(no findings)"}, got ${got.join(", ") || "(none)"}`);
  for (const f of auditResult.findings) {
    assert.deepStrictEqual(
      Object.keys(f).sort(),
      ["file", "kind", "message", "severity", "step", "volume"],
      `${label}: a finding must be exactly the post-mortem's own shape (severity, kind, step, volume, file, message)`
    );
    assert.strictEqual(f.step, EXTRACTION_STEP, `${label}: findings belong to the extract step`);
    assert.strictEqual(f.volume, "01", `${label}: a finding names the volume it is about`);
    assert.strictEqual(typeof f.file, "string");
    assert.strictEqual(typeof f.message, "string");
    assert.ok(f.file, `${label}: a finding names the file or folder it is about`);
    assert.ok(f.message.length > 40, `${label}: a finding has to say what is wrong, not just that something is`);
    assert.strictEqual(
      EXTRACTION_AUDIT_KINDS[f.kind],
      f.severity,
      `${label}: "${f.kind}" is declared at ${EXTRACTION_AUDIT_KINDS[f.kind]}, not ${f.severity}`
    );
  }
  assert.strictEqual(auditResult.counts.findings, auditResult.findings.length, `${label}: counts.findings`);
  assert.strictEqual(
    auditResult.counts.HIGH,
    auditResult.findings.filter((f) => f.severity === "HIGH").length,
    `${label}: counts.HIGH`
  );
  assert.strictEqual(
    auditResult.counts.MEDIUM,
    auditResult.findings.filter((f) => f.severity === "MEDIUM").length,
    `${label}: counts.MEDIUM`
  );
}

// ─── 1. the clean book: every check silent ───────────────────────────────────

/**
 * The fixture every "stays silent" assertion leans on: a book that looks like volume 1 of the live
 * series — a cover, a contents page, three real chapters and a colophon, the contents list naming all
 * six, and pronunciation guides in the prose.
 *
 * @returns {Promise<Object>}
 */
async function cleanBook() {
  return fixtureVolume("clean", {
    title: "Audit Series",
    sourceName: "audit_series(1).epub",
    pages: [
      { file: "p-001.xhtml", pageTitle: "表紙", navTitle: "表紙", bodyClass: "p-cover", body: `<p>表紙</p>` },
      { file: "p-002.xhtml", pageTitle: "目次", navTitle: "目次", bodyClass: "p-toc", body: `<p>目次</p>` },
      { file: "p-003.xhtml", pageTitle: "第一章", navTitle: "第一章", body: `<p>第一章</p>${prose("第一章")}` },
      {
        file: "p-004.xhtml",
        pageTitle: "第二章",
        navTitle: "第二章",
        body: `<p>第二章</p><p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。${prose("第二章")}</p>`,
      },
      { file: "p-005.xhtml", pageTitle: "第三章", navTitle: "第三章", body: `<p>第三章</p>${prose("第三章")}` },
      { file: "p-006.xhtml", pageTitle: "奥付", navTitle: "奥付", bodyClass: "p-colophon", body: `<p>奥付</p>` },
    ],
  });
}

/**
 * The clean fixture: every one of the five checks stays silent, and the audit writes nothing.
 */
async function scenarioCleanBook() {
  const fx = await cleanBook();
  const names = await listingOf(fx.volumeDir);

  assert.strictEqual(fx.bundle.format, "epub");
  assert.strictEqual(fx.bundle.segments.length, 3, "the book's three chapters are the three segments");
  assert.deepStrictEqual(
    fx.bundle.segments.map((s) => s.title),
    ["第一章", "第二章", "第三章"],
    "the chapters are named by the book's own contents list"
  );
  assert.strictEqual(fx.bundle.packaging.length, 3, "cover, contents page and colophon are packaging");

  const result = auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: names });
  assertFindings(result, [], "a clean book");
  assert.strictEqual(result.counts.chapters, 3, "the audit reports what the bundle holds");
  assert.strictEqual(result.counts.packaging, 3, "including the pages the book declares as packaging");
  ok("a clean book produces no findings at all — six checks, zero hits");

  // The empty pages are the book's OWN packaging, and they are the reason the empty-chapter check has
  // an exemption: 表紙 / 目次 / 奥付 hold no story text and are not missing chapters.
  assert.ok(
    fx.bundle.packaging.every((p) => p.textChars === 0),
    "every packaging group in this fixture really is empty of story text"
  );
  ok("the pages the book declares as packaging are not reported as chapters that extracted to nothing");

  // Pure: the same input twice is the same output, and auditing a folder does not change the folder.
  const before = fs.readdirSync(fx.volumeDir).sort();
  const again = auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: names });
  assert.deepStrictEqual(again, result, "the audit is deterministic");
  assert.deepStrictEqual(fs.readdirSync(fx.volumeDir).sort(), before, "the audit wrote nothing into the volume folder");
  ok("the audit is pure: same input, same findings, nothing written");

  // A Dirent listing is what a caller naturally has; the audit must accept it without a map.
  const asDirents = await fs.promises.readdir(fx.volumeDir, { withFileTypes: true });
  assertFindings(
    auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: asDirents }),
    [],
    "a withFileTypes listing"
  );
  ok("a Dirent listing and a name listing answer the same question");

  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
}

// ─── 2. check 1 · the volume's source is not the book archive (HIGH) ──────────

/**
 * Check 1: fired on gotcha 119 reproduced, silent on the same folder read from the archive, and silent
 * on a plain-text volume that has no archive anywhere.
 */
async function scenarioSourceNotArchive() {
  // The planted fixture is gotcha 119 reproduced exactly: the folder holds the archive AND the
  // pipeline's own audit report, and the plan of record points at the report.
  const fx = await cleanBook();
  const decoy = "character-voice.md-audit.md";
  await fs.promises.writeFile(
    path.join(fx.volumeDir, decoy),
    `${"# character-voice audit\n\n".repeat(30)}volume 01 graded 80/100 with 3 medium findings.\n`,
    "utf8"
  );
  const wrongVolume = { ...fx.volume, sourceFile: `${fx.volume.folder}/${decoy}` };
  const { result: wrongBundle } = await quiet(() =>
    resolveSourceBundle({ seriesDir: fx.seriesDir, volume: wrongVolume, volumeDir: fx.volumeDir })
  );
  assert.strictEqual(wrongBundle.format, "text", "the decoy resolves as a plain-text source");

  const result = auditExtractedVolume({
    volume: wrongVolume,
    bundle: wrongBundle,
    volumeFiles: await listingOf(fx.volumeDir),
  });
  assertFindings(result, [{ severity: "HIGH", kind: "source-not-archive" }], "a volume read from its own audit report");
  const message = result.findings[0].message;
  assert.ok(message.includes(decoy), `the finding names the file that was read: ${message}`);
  assert.ok(message.includes("audit_series(1).epub"), `and names the archive that was ignored: ${message}`);
  ok("a volume extracted from a loose text file while its folder holds the archive is HIGH");

  // The clean counterpart: the same folder, the plan pointing at the archive, the decoy still sitting
  // there. An archive in the folder is only a finding when the bundle did not open it.
  assertFindings(
    auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: await listingOf(fx.volumeDir) }),
    [],
    "the same folder, read from the archive"
  );
  ok("the same folder read from the archive is silent — the finding is about what was opened");

  // The second shape: the bundle was resolved for a different file than the plan of record names.
  const mismatched = { ...fx.volume, sourceFile: `${fx.volume.folder}/audit_series(2).epub` };
  assertFindings(
    auditExtractedVolume({ volume: mismatched, bundle: fx.bundle, volumeFiles: await listingOf(fx.volumeDir) }),
    [{ severity: "HIGH", kind: "source-not-archive" }],
    "a bundle resolved from a different file than the plan names"
  );
  ok("a bundle opened from a different file than the plan of record names is HIGH");

  // A plain-text volume with no archive anywhere is a supported shape, not a defect.
  const textDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "audit-plain-"));
  const folder = "Plain(01)";
  const volumeDir = path.join(textDir, folder);
  await fs.promises.mkdir(volumeDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(volumeDir, "plain(1).md"),
    `# 第一章\n\n${"これは本文です。".repeat(60)}\n`,
    "utf8"
  );
  const textVolume = { installmentNumber: "01", folder, sourceFile: `${folder}/plain(1).md` };
  const { result: textBundle } = await quiet(() =>
    resolveSourceBundle({ seriesDir: textDir, volume: textVolume, volumeDir })
  );
  assertFindings(
    auditExtractedVolume({ volume: textVolume, bundle: textBundle, volumeFiles: await listingOf(volumeDir) }),
    [],
    "a plain-text volume"
  );
  ok("a plain-text volume with no archive anywhere is silent — .md books are a supported shape");

  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
  await fs.promises.rm(textDir, { recursive: true, force: true });
}

// ─── 3. check 2 · a volume with no usable chapter (HIGH) ──────────────────────

/**
 * Check 2: fired by a bundle with no segments and by a real book whose every chapter is empty; silent
 * when the same chapters hold text.
 */
async function scenarioNoUsableChapter() {
  // (a) A bundle with no segments at all.
  const volume = { installmentNumber: "01", folder: "Empty(01)", sourceFile: "Empty(01)/empty(1).epub" };
  const noSegments = {
    format: "epub",
    originalPath: "/fixture/Empty(01)/empty(1).epub",
    base: "empty(1)",
    volumeDir: "/fixture/Empty(01)",
    segments: [],
    packaging: [],
    rubyGuides: { file: "empty(1)-ruby-guides.json", guides: 0 },
  };
  const emptyAudit = auditExtractedVolume({ volume, bundle: noSegments, volumeFiles: ["empty(1).epub", "empty(1)-ruby-guides.json"] });
  assertFindings(emptyAudit, [{ severity: "HIGH", kind: "no-usable-chapter" }], "a bundle with no segments");
  assert.strictEqual(emptyAudit.counts.chapters, 0, "and the report says how many chapters it found");
  ok("a bundle with zero chapters is HIGH — nothing downstream has anything to walk");

  // (b) A real book whose named chapters all converted to nothing.
  const fx = await fixtureVolume("all-empty", {
    title: "Hollow Series",
    sourceName: "hollow(1).epub",
    pages: [
      { file: "p-001.xhtml", pageTitle: "第一章", navTitle: "第一章", body: `<p>第一章</p>` },
      { file: "p-002.xhtml", pageTitle: "第二章", navTitle: "第二章", body: `<p>第二章</p>` },
      { file: "p-003.xhtml", pageTitle: "第三章", navTitle: "第三章", body: `<p>第三章</p>` },
    ],
  });
  const result = auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: await listingOf(fx.volumeDir) });
  assertFindings(
    result,
    [
      { severity: "HIGH", kind: "no-usable-chapter" },
      { severity: "HIGH", kind: "chapter-extracted-empty" },
      { severity: "HIGH", kind: "chapter-extracted-empty" },
      { severity: "HIGH", kind: "chapter-extracted-empty" },
    ],
    "a book whose every chapter is empty"
  );
  assert.ok(
    result.findings[0].message.includes("All 3 chapter"),
    `the volume-level finding says the whole volume is empty: ${result.findings[0].message}`
  );
  ok("a volume whose every chapter is empty is HIGH, and the per-chapter findings still name which ones");

  // The clean counterpart is scenario 1: three real chapters, zero findings.
  assert.strictEqual(
    auditExtractedVolume({ volume: fx.volume, bundle: { ...fx.bundle, segments: fx.bundle.segments.map((s) => ({ ...s, empty: false })) }, volumeFiles: await listingOf(fx.volumeDir) })
      .findings.length,
    0,
    "the same bundle with its chapters marked non-empty is silent"
  );
  ok("the same volume with real text in its chapters is silent");

  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
}

// ─── 4. check 3 · a chapter that extracted to nothing (HIGH) ──────────────────

/**
 * Check 3: fired by a named chapter that converted to nothing, and kept silent by the pages the book
 * declares as packaging — from the normal path and from the contents-list fallback.
 */
async function scenarioEmptyChapter() {
  // The planted fixture: a named chapter whose page is an illustration plate. The book says the chapter
  // is there; the text is not. This is the hole that looks like a short chapter.
  const fx = await fixtureVolume("one-empty", {
    title: "Hole Series",
    sourceName: "hole(1).epub",
    pages: [
      { file: "p-001.xhtml", pageTitle: "表紙", navTitle: "表紙", bodyClass: "p-cover", body: `<p>表紙</p>` },
      { file: "p-002.xhtml", pageTitle: "第一章", navTitle: "第一章", body: `<p>第一章</p>${prose("第一章")}` },
      {
        file: "p-003.xhtml",
        pageTitle: "第二章",
        navTitle: "第二章",
        body: `<p>第二章</p><p><img src="images/plate.png" alt="挿絵"/></p>`,
      },
      { file: "p-004.xhtml", pageTitle: "第三章", navTitle: "第三章", body: `<p>第三章</p>${prose("第三章")}` },
      { file: "p-005.xhtml", pageTitle: "奥付", navTitle: "奥付", bodyClass: "p-colophon", body: `<p>奥付</p>` },
    ],
  });
  const result = auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: await listingOf(fx.volumeDir) });
  assertFindings(result, [{ severity: "HIGH", kind: "chapter-extracted-empty" }], "one chapter converted to nothing");
  const finding = result.findings[0];
  assert.ok(finding.message.includes("第二章"), `the finding names the chapter: ${finding.message}`);
  assert.strictEqual(finding.file, "Hole Series(01)/hole(1)-ch2.md", `the finding points at the chapter file: ${finding.file}`);
  assert.strictEqual(result.counts.chapters, 3, "the other two chapters are still chapters");
  assert.strictEqual(result.counts.packaging, 2, "the cover and the colophon are packaging, not chapters");
  ok("a named chapter that converted to nothing is HIGH, and only that chapter is reported");

  // The exemption, from the shape the extraction actually produces when its contents-list fallback runs:
  // a book whose navigation names only packaging cannot be zero chapters, so every page stands alone as
  // a chapter — cover plates included. Those empty plates are NOT missing chapters.
  const plate = await fixtureVolume("all-packaging", {
    title: "Plate Series",
    sourceName: "plate(1).epub",
    pages: [
      { file: "p-001.xhtml", pageTitle: "表紙", navTitle: "表紙", bodyClass: "p-cover", body: `<p>表紙</p>` },
      { file: "p-002.xhtml", pageTitle: "カバー", bodyClass: "p-image", body: `<p><img src="images/plate.png" alt=""/></p>` },
      { file: "p-003.xhtml", pageTitle: "奥付", navTitle: "奥付", bodyClass: "p-colophon", body: `<p>奥付</p>` },
    ],
  });
  assert.strictEqual(plate.bundle.segments.length, 3, "the fallback made every page a chapter");
  assert.strictEqual(plate.bundle.packaging.length, 0, "and cleared the packaging list");
  const plateAudit = auditExtractedVolume({ volume: plate.volume, bundle: plate.bundle, volumeFiles: await listingOf(plate.volumeDir) });
  assertFindings(plateAudit, [{ severity: "HIGH", kind: "no-usable-chapter" }], "a book that is nothing but packaging");
  assert.strictEqual(
    plateAudit.findings.filter((f) => f.kind === "chapter-extracted-empty").length,
    0,
    `no phantom missing chapters were invented: ${plateAudit.findings.map((f) => f.message).join("\n")}`
  );
  ok("empty pages the book declares as packaging produce no phantom 'chapter extracted to nothing' (gotcha 52)");

  // The exemption is the extraction's OWN packaging vocabulary, not a second list: a chapter the book
  // named is reported even when its title is short, and a packaging word is exempt even when it came
  // from the bundle's packaging list rather than the title.
  const volume = { installmentNumber: "01", folder: "Exempt(01)", sourceFile: "Exempt(01)/exempt(1).epub" };
  const bundle = {
    format: "epub",
    originalPath: "/fixture/Exempt(01)/exempt(1).epub",
    base: "exempt(1)",
    volumeDir: "/fixture/Exempt(01)",
    segments: [
      { id: "ch1", file: "exempt(1)-ch1.md", title: "第一章", empty: false, bodyChars: 1200 },
      { id: "ch2", file: "exempt(1)-ch2.md", title: "第二章", empty: true, bodyChars: 0 },
      { id: "ch3", file: "exempt(1)-ch3.md", title: "本編", empty: true, bodyChars: 0 },
    ],
    packaging: [{ title: "本編", reason: '"本編" names packaging, not a chapter', pages: 1, bodyChars: 0, textChars: 0 }],
    rubyGuides: { file: "exempt(1)-ruby-guides.json", guides: 0 },
  };
  const exempt = auditExtractedVolume({ volume, bundle, volumeFiles: ["exempt(1).epub", "exempt(1)-ruby-guides.json"] });
  assertFindings(exempt, [{ severity: "HIGH", kind: "chapter-extracted-empty" }], "one exempt, one not");
  assert.ok(exempt.findings[0].message.includes("第二章"), `only the real chapter is reported: ${exempt.findings[0].message}`);
  assert.strictEqual(exempt.counts.chapters, 3, "the volume still has usable chapters, so the volume-level check stays silent");
  ok("the exemption reads the bundle's own packaging list, so a page the extraction already named packaging is not a hole");

  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
  await fs.promises.rm(plate.seriesDir, { recursive: true, force: true });
}

// ─── 5. check 4 · a chapter title that is only the file's name (MEDIUM) ───────

/**
 * Check 4: fired by a chapter titled after its file (both shapes this repository shipped), silent on a
 * volume that declares its own heading and on an honest "Untitled section" placeholder.
 */
async function scenarioTitleIsFilename() {
  // The shape this repository shipped: a plain-text volume headed with its own file name, because the
  // source declares no heading of its own.
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "audit-title-"));
  const folder = "test_story(01)";
  const volumeDir = path.join(dir, folder);
  await fs.promises.mkdir(volumeDir, { recursive: true });
  await fs.promises.writeFile(path.join(volumeDir, "test_story(1).md"), `${"これは本文です。".repeat(60)}\n`, "utf8");
  const volume = { installmentNumber: "01", folder, sourceFile: `${folder}/test_story(1).md` };
  const { result: bundle } = await quiet(() => resolveSourceBundle({ seriesDir: dir, volume, volumeDir }));
  assert.strictEqual(bundle.segments[0].title, "test_story(1)", "the extraction marked the file name as the title");
  const result = auditExtractedVolume({ volume, bundle, volumeFiles: await listingOf(volumeDir) });
  assertFindings(result, [{ severity: "MEDIUM", kind: "title-is-filename" }], "a chapter titled after its file");
  assert.ok(
    result.findings[0].message.includes("test_story(1)"),
    `the finding quotes the title: ${result.findings[0].message}`
  );
  ok("a chapter titled with the file's name is MEDIUM — the published book used to begin with it");

  // The clean counterpart: the same shape of volume, and the source declares its own heading.
  await fs.promises.writeFile(path.join(volumeDir, "test_story(2).md"), `# 第一章\n\n${"これは本文です。".repeat(60)}\n`, "utf8");
  const declared = { installmentNumber: "01", folder, sourceFile: `${folder}/test_story(2).md` };
  const { result: declaredBundle } = await quiet(() =>
    resolveSourceBundle({ seriesDir: dir, volume: declared, volumeDir })
  );
  assert.strictEqual(declaredBundle.segments[0].title, "第一章");
  assertFindings(
    auditExtractedVolume({ volume: declared, bundle: declaredBundle, volumeFiles: await listingOf(volumeDir) }),
    [],
    "a plain-text volume that declares its own title"
  );
  ok("a plain-text volume that declares its own heading is silent");
  await fs.promises.rm(dir, { recursive: true, force: true });

  // The other shape this series actually shipped (volumes 8 and 11): a section titled `p-001.xhtml`.
  const volume2 = { installmentNumber: "01", folder: "Plate(01)", sourceFile: "Plate(01)/plate(1).epub" };
  const bundle2 = {
    format: "epub",
    originalPath: "/fixture/Plate(01)/plate(1).epub",
    base: "plate(1)",
    volumeDir: "/fixture/Plate(01)",
    segments: [
      { id: "ch1", file: "plate(1)-ch1.md", title: "p-001.xhtml", empty: false, bodyChars: 4000 },
      { id: "ch2", file: "plate(1)-ch2.md", title: "第二章", empty: false, bodyChars: 4000 },
      { id: "ch3", file: "plate(1)-ch3.md", title: "Untitled section 3", empty: false, bodyChars: 4000 },
    ],
    packaging: [],
    rubyGuides: { file: "plate(1)-ruby-guides.json", guides: 12 },
  };
  const result2 = auditExtractedVolume({
    volume: volume2,
    bundle: bundle2,
    volumeFiles: ["plate(1).epub", "plate(1)-ruby-guides.json"],
  });
  assertFindings(result2, [{ severity: "MEDIUM", kind: "title-is-filename" }], "a chapter titled p-001.xhtml");
  assert.ok(result2.findings[0].message.includes("p-001.xhtml"), result2.findings[0].message);
  ok("a chapter titled with a page's file name is caught, and 'Untitled section 3' is not — an honest placeholder is not a fake title");

  // The clean counterpart from a real bundle: three chapters named by the book, nothing reported.
  const fx = await cleanBook();
  assertFindings(
    auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: await listingOf(fx.volumeDir) }),
    [],
    "a book whose chapters are named by its own contents list"
  );
  ok("chapters named by the book's own contents list are silent");
  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
}

// ─── 6. check 5 · a bundle whose guide harvest is missing (MEDIUM) ────────────

/**
 * Check 5: fired when the harvest file is gone from the folder or the bundle meta points at one that
 * does not exist; silent when it is there, and silent on a plain-text volume.
 */
async function scenarioGuideHarvest() {
  const fx = await cleanBook();
  const harvest = rubyGuideFileName("audit_series(1)");
  const names = await listingOf(fx.volumeDir);
  assert.ok(names.includes(harvest), `the extraction wrote the harvest (${harvest})`);
  assert.ok(fx.bundle.rubyGuidesPath, "and the bundle points at it");

  // Silent: the harvest is there.
  assertFindings(
    auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: names }),
    [],
    "a bundle with its harvest"
  );
  ok("a bundle with its harvest file beside it is silent");

  // Planted: the file is gone from the folder. This is the cache that certifies a hole — a bundle
  // resolved past resolveSourceBundle's own missing-file check.
  const withoutHarvest = names.filter((name) => name !== harvest);
  const result = auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: withoutHarvest });
  assertFindings(result, [{ severity: "MEDIUM", kind: "ruby-harvest-missing" }], "a bundle missing its harvest");
  assert.ok(result.findings[0].message.includes(harvest), `the finding names the missing file: ${result.findings[0].message}`);
  assert.ok(result.findings[0].message.includes("1 pronunciation guide") || result.findings[0].message.includes("2 pronunciation guide") || /\d+ pronunciation guide/.test(result.findings[0].message),
    `and how many guides are now unrecorded: ${result.findings[0].message}`);
  ok("a bundle whose harvest file is gone is MEDIUM, and the finding says how many readings were lost");

  // A bundle whose meta points at a harvest file that is not the one the current source would write.
  const renamed = { ...fx.bundle, rubyGuides: { ...fx.bundle.rubyGuides, file: "audit_series(0)-ruby-guides.json" } };
  const renamedResult = auditExtractedVolume({ volume: fx.volume, bundle: renamed, volumeFiles: names });
  assertFindings(renamedResult, [{ severity: "MEDIUM", kind: "ruby-harvest-missing" }], "a meta pointing at a harvest that is not there");
  assert.ok(
    renamedResult.findings[0].message.includes("audit_series(0)-ruby-guides.json"),
    `and names both the expected file and the one the meta points at: ${renamedResult.findings[0].message}`
  );
  ok("a bundle meta pointing at a harvest file that does not exist is MEDIUM");

  // A plain-text volume has no markup to harvest, so it has nothing to be missing.
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "audit-plain-harvest-"));
  const folder = "Plain(01)";
  const volumeDir = path.join(dir, folder);
  await fs.promises.mkdir(volumeDir, { recursive: true });
  await fs.promises.writeFile(path.join(volumeDir, "plain(1).md"), `# 第一章\n\n${"これは本文です。".repeat(60)}\n`, "utf8");
  const volume = { installmentNumber: "01", folder, sourceFile: `${folder}/plain(1).md` };
  const { result: textBundle } = await quiet(() =>
    resolveSourceBundle({ seriesDir: dir, volume, volumeDir })
  );
  assert.strictEqual(textBundle.rubyGuidesPath, null);
  assertFindings(
    auditExtractedVolume({ volume, bundle: textBundle, volumeFiles: await listingOf(volumeDir) }),
    [],
    "a plain-text volume"
  );
  ok("a plain-text volume is silent — it has no markup to harvest");

  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
  await fs.promises.rm(dir, { recursive: true, force: true });
}

// ─── 7. check 6 · a guide-split string still in the extracted text (HIGH) ─────

/**
 * A book whose chapter text holds the string the broken converter produced, alongside the very ruby
 * that annotation came from. The harvest knows 蒲 carried かま and 田 carried た; the audit reports the
 * chapter that still prints 蒲かま田た.
 *
 * @returns {Promise<Object>}
 */
async function splitBook() {
  return fixtureVolume("split", {
    title: "Split Series",
    sourceName: "split(1).epub",
    pages: [
      {
        file: "p-001.xhtml",
        pageTitle: "第一章",
        navTitle: "第一章",
        body:
          `<p>第一章</p><p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。</p>${prose("第一章")}` +
          `<p>壊れた変換がそのまま残した 蒲かま田た という文字列を、この章は意図的に含む。</p>`,
      },
      {
        file: "p-002.xhtml",
        pageTitle: "第二章",
        navTitle: "第二章",
        body: `<p>第二章</p><p>こちらも<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>だが、本文は正しい。</p>${prose("第二章")}`,
      },
    ],
  });
}

/**
 * Check 6: fired on a planted guide-split string, silent on the same ruby extracted correctly, and
 * silent (not answerable) on a bundle that never recorded the measurement.
 */
async function scenarioGuideSplitInText() {
  const fx = await splitBook();
  const result = auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: await listingOf(fx.volumeDir) });
  assertFindings(result, [{ severity: "HIGH", kind: "guide-split-in-text" }], "a chapter that still prints 蒲かま田た");
  const finding = result.findings[0];
  assert.strictEqual(finding.file, "Split Series(01)/split(1)-ch1.md", `the finding points at the chapter file: ${finding.file}`);
  assert.ok(finding.message.includes("蒲かま田た"), `the finding quotes the string it found: ${finding.message}`);
  assert.ok(finding.message.includes("第一章"), `and names the chapter: ${finding.message}`);
  assert.strictEqual(fx.bundle.segments[1].guideSplitForms, 0, "the chapter with the same ruby, extracted correctly, records 0");
  ok("a guide-split string still in a chapter's text is HIGH, and only that chapter is reported");

  // The silent counterpart from the clean fixture: the same ruby, extracted the right way, in a book
  // whose chapters hold ordinary Japanese.
  const clean = await cleanBook();
  const cleanAudit = auditExtractedVolume({ volume: clean.volume, bundle: clean.bundle, volumeFiles: await listingOf(clean.volumeDir) });
  assertFindings(cleanAudit, [], "a clean book with the same ruby in it");
  assert.ok(
    clean.bundle.segments.every((s) => s.guideSplitForms === 0),
    `every chapter of the clean book measured 0: ${clean.bundle.segments.map((s) => `${s.id}=${s.guideSplitForms}`).join(", ")}`
  );
  ok("the tripwire is silent on a correct extraction — the same annotation, the same books, zero hits");

  // A bundle that never recorded the measurement (a cache written before the schema that measures it)
  // is NOT reported as clean: the check cannot answer, and silence here is the documented limit.
  const unmeasured = {
    ...clean.bundle,
    segments: clean.bundle.segments.map(({ guideSplitForms, guideSplitExamples, ...rest }) => rest),
  };
  assertFindings(
    auditExtractedVolume({ volume: clean.volume, bundle: unmeasured, volumeFiles: await listingOf(clean.volumeDir) }),
    [],
    "a bundle with no recorded measurement"
  );
  ok("a segment with no recorded measurement is not answered — which is why the schema bump is part of this check");

  // And the audit reports what the extraction recorded, at the volume's own file granularity.
  const volume = { installmentNumber: "01", folder: "Split(01)", sourceFile: "Split(01)/split(1).epub" };
  const planted = {
    format: "epub",
    originalPath: "/fixture/Split(01)/split(1).epub",
    base: "split(1)",
    volumeDir: "/fixture/Split(01)",
    segments: [
      { id: "ch1", file: "split(1)-ch1.md", title: "第一章", empty: false, bodyChars: 4000, guideSplitForms: 3, guideSplitExamples: ["蒲かま田た", "上じよう機き嫌げん"] },
      { id: "ch2", file: "split(1)-ch2.md", title: "第二章", empty: false, bodyChars: 4000, guideSplitForms: 0, guideSplitExamples: [] },
    ],
    packaging: [],
    rubyGuides: { file: "split(1)-ruby-guides.json", guides: 40 },
  };
  const plantedAudit = auditExtractedVolume({ volume, bundle: planted, volumeFiles: ["split(1).epub", "split(1)-ruby-guides.json"] });
  assertFindings(plantedAudit, [{ severity: "HIGH", kind: "guide-split-in-text" }], "a recorded measurement of 3");
  assert.ok(plantedAudit.findings[0].message.includes("3 guide-split string"), plantedAudit.findings[0].message);
  assert.ok(
    plantedAudit.findings[0].message.includes("蒲かま田た") && plantedAudit.findings[0].message.includes("上じよう機き嫌げん"),
    `the finding quotes the recorded examples: ${plantedAudit.findings[0].message}`
  );
  ok("the audit reads the extraction's own measurement, chapter by chapter, and quotes what it found");

  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
  await fs.promises.rm(clean.seriesDir, { recursive: true, force: true });
}

// ─── 8. the packaging mark: a cover plate named after its own file ────────────

/**
 * The blind spot gotcha 126 recorded, reproduced. The live series titles five of its packaging pages
 * `p-fmatter-002.xhtml`; a page like that which the contents list names, and which holds no story text,
 * becomes a segment whose title no packaging word list can recognise. Before the per-segment mark that
 * was a phantom "chapter extracted to nothing" — a HIGH that stops a run over a cover plate.
 */
async function scenarioPackagingMark() {
  const fx = await fixtureVolume("packaging-mark", {
    title: "Mark Series",
    sourceName: "mark(1).epub",
    pages: [
      {
        file: "p-cover.xhtml",
        pageTitle: "p-cover.xhtml",
        navTitle: "p-cover.xhtml",
        bodyClass: "p-cover",
        body: `<p><img src="images/plate.png" alt=""/></p>`,
      },
      { file: "p-002.xhtml", pageTitle: "第一章", navTitle: "第一章", body: `<p>第一章</p>${prose("第一章")}` },
      { file: "p-003.xhtml", pageTitle: "第二章", navTitle: "第二章", body: `<p>第二章</p>${prose("第二章")}` },
    ],
  });

  const cover = fx.bundle.segments[0];
  assert.strictEqual(cover.title, "p-cover.xhtml", "the segment is titled after its file — the shape the real books produce");
  assert.strictEqual(cover.empty, true, "it converted to nothing, as a cover plate does");
  assert.strictEqual(cover.declaresPackaging, true, "and the bundle records that the BOOK declared it packaging");
  assert.strictEqual(fx.bundle.segments[1].declaresPackaging, false, "an ordinary chapter carries the mark as false");
  assert.strictEqual(fx.bundle.segments[2].declaresPackaging, false, "and so does the next one");

  const result = auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: await listingOf(fx.volumeDir) });
  assertFindings(result, [{ severity: "MEDIUM", kind: "title-is-filename" }], "a cover plate the book named after its own file");
  assert.strictEqual(
    result.findings.filter((f) => f.kind === "chapter-extracted-empty").length,
    0,
    `no phantom missing chapter was invented for the cover plate: ${result.findings.map((f) => f.message).join("\n")}`
  );
  assert.strictEqual(result.counts.HIGH, 0, "and the run is not stopped over a cover plate");
  ok("an empty cover plate named p-cover.xhtml is exempted by the mark, not by a title guess (gotcha 126)");

  // The mark does not weaken the check: a NAMED CHAPTER that converted to nothing and declared nothing
  // is still the hole it has always been.
  const hole = await fixtureVolume("packaging-hole", {
    title: "Mark Hole Series",
    sourceName: "hole(1).epub",
    pages: [
      { file: "p-001.xhtml", pageTitle: "第一章", navTitle: "第一章", body: `<p>第一章</p>${prose("第一章")}` },
      { file: "p-002.xhtml", pageTitle: "第二章", navTitle: "第二章", body: `<p><img src="images/plate.png" alt="挿絵"/></p>` },
    ],
  });
  assert.strictEqual(hole.bundle.segments[1].declaresPackaging, false, "the page declared nothing, so the mark says nothing");
  const holeAudit = auditExtractedVolume({ volume: hole.volume, bundle: hole.bundle, volumeFiles: await listingOf(hole.volumeDir) });
  assertFindings(holeAudit, [{ severity: "HIGH", kind: "chapter-extracted-empty" }], "a real chapter that converted to nothing");
  ok("the mark exempts only what the book declared — an undeclared empty chapter is still HIGH");

  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
  await fs.promises.rm(hole.seriesDir, { recursive: true, force: true });
}

// ─── 9. the audit itself: no model, no store, no writes, and never silently clean ───

/**
 * The guarantees about the audit itself: no model, no store, no writes, a STRUCTURAL refusal instead of
 * a false clean, and every emitted kind declared.
 */
async function scenarioGuarantees() {
  const layer = readModuleLayer(PROJECT_ROOT, "utils/source/audit.js");

  for (const banned of ["harness", "runOneShot", "createAgent", "reference-store", 'require("fs")', "fetch("]) {
    assert.ok(
      !layer.includes(banned),
      `the extraction audit must not reach ${banned} — it is a deterministic check, and the plan of record (§4) excludes a model from it`
    );
  }
  ok("the audit layer contains no model call, no agent, no filesystem read and no reference-store import");

  const volume = { installmentNumber: "01", folder: "Bad(01)", sourceFile: "Bad(01)/bad(1).epub" };

  // An audit that could not run is never reported as a clean one.
  assert.throws(
    () => auditExtractedVolume({ volume, bundle: null, volumeFiles: [] }),
    (err) => err.structural === true && /resolveSourceBundle/.test(err.message),
    "a bundle that is not a bundle is a STRUCTURAL refusal, not an empty findings list"
  );
  assert.throws(
    () => auditExtractedVolume({ volume: null, bundle: { segments: [] }, volumeFiles: [] }),
    (err) => err.structural === true,
    "a missing volume entry is refused too"
  );
  ok("an audit that cannot run throws a STRUCTURAL error rather than reporting a clean volume");

  // Every kind the audit can emit is declared, and every declared kind is one the audit emits.
  const kinds = new Set(Object.keys(EXTRACTION_AUDIT_KINDS));
  const emitted = new Set();
  for (const name of [
    "auditSourceIsArchive",
    "auditHasUsableChapter",
    "auditEmptyChapters",
    "auditGuideSplitSurvives",
    "auditTitlesAreTitles",
    "auditGuideHarvest",
  ]) {
    const fn = require("../utils/source")[name];
    assert.strictEqual(typeof fn, "function", `${name} is reachable from the source barrel`);
  }
  ok("all six checks are reachable from the source barrel");
  // A volume entry with no installment number still produces findings the post-mortem can read: the
  // `volume` field is null (its documented shape for a finding that is not about one installment), never
  // undefined.
  const noNumber = auditExtractedVolume({
    volume: { folder: "NoNumber(01)", sourceFile: "NoNumber(01)/no(1).epub" },
    bundle: {
      format: "epub",
      originalPath: "/fixture/NoNumber(01)/no(1).epub",
      base: "no(1)",
      volumeDir: "/fixture/NoNumber(01)",
      segments: [{ id: "ch1", file: "no(1)-ch1.md", title: "第一章", empty: true, bodyChars: 0 }],
      packaging: [],
      rubyGuides: { file: "no(1)-ruby-guides.json", guides: 3 },
    },
    volumeFiles: ["no(1).epub", "no(1)-ruby-guides.json"],
  });
  assert.strictEqual(noNumber.findings.length, 2, "no-usable-chapter and chapter-extracted-empty");
  for (const f of noNumber.findings) {
    assert.strictEqual(f.volume, null, `a volume with no installment number reports null, not undefined: ${JSON.stringify(f)}`);
    assert.strictEqual(f.step, "extract");
  }
  ok("a finding's volume field is the post-mortem's own string-or-null, never undefined");

  const fx = await fixtureVolume("kinds", {
    title: "Kind Series",
    sourceName: "kind(1).epub",
    pages: [
      { file: "p-001.xhtml", pageTitle: "第一章", navTitle: "第一章", body: `<p>第一章</p>` },
      { file: "p-002.xhtml", pageTitle: "第二章", navTitle: "第二章", body: `<p>第二章</p>${prose("第二章")}` },
    ],
  });
  const names = (await listingOf(fx.volumeDir)).filter((n) => !n.endsWith("-ruby-guides.json"));
  const all = auditExtractedVolume({ volume: fx.volume, bundle: fx.bundle, volumeFiles: names });
  for (const f of all.findings) emitted.add(f.kind);
  assert.ok(emitted.has("no-usable-chapter") || emitted.has("chapter-extracted-empty"), "the empty chapter is reported");
  assert.ok(emitted.has("ruby-harvest-missing"), "the missing harvest is reported");
  for (const kind of emitted) assert.ok(kinds.has(kind), `"${kind}" is not a declared kind`);
  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
  ok("every kind the audit emits is one the audit declares");
}

(async () => {
  console.log("source-audit: six deterministic checks over an extracted volume");
  await scenarioCleanBook();
  await scenarioSourceNotArchive();
  await scenarioNoUsableChapter();
  await scenarioEmptyChapter();
  await scenarioTitleIsFilename();
  await scenarioGuideHarvest();
  await scenarioGuideSplitInText();
  await scenarioPackagingMark();
  await scenarioGuarantees();
  console.log(`\nsource-audit: all ${passed} checks passed.`);
})().catch((err) => {
  console.error("source-audit: FAILED");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

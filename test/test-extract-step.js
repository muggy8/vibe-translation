#!/usr/bin/env node
/**
 * test/test-extract-step.js — the `extract` pipeline step, end to end, with no model anywhere.
 *
 * What this suite pins is the part of the extraction step that a unit test of the audit cannot reach:
 * the step is registered in the pipeline in the right place, it decides per volume whether it verified
 * a bundle or extracted one, it writes its reports into the run's records rather than into the volume
 * folders, it fails the run on a HIGH finding and does not fail it on a MEDIUM one, and it makes no
 * model call at all — proved against a live stub server that records every request it receives, not by
 * reading the source and hoping.
 *
 * Every fixture is a throwaway folder under the system temp dir, built here with jszip. Nothing in this
 * file can reach the real corpus: `SERIES_LOCATION` is repointed at the fixture before the step runs,
 * and `test/test-home.js` has already pinned the run's records to a throwaway home (AGENTS.md rule 8,
 * gotcha 69).
 *
 * The scenarios:
 *   1. the step is a pipeline step, in the right place, with a name every door accepts;
 *   2. a planted HIGH finding fails the step — structurally — and the reports are on disk before it throws;
 *   3. a planted MEDIUM finding is recorded and printed, and the run continues;
 *   4. a warm cache is verified, not re-extracted, and the log says which one happened;
 *   5. the reports land under the run's records and nowhere in the volume folders;
 *   6. zero model calls, measured at the wire;
 *   7. a book that will not open is named as a volume that could not be read, not swallowed.
 *
 * Run: node test/test-extract-step.js
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");

const GULPFILE = require("../gulpfile");
const { TASKS } = require("../utils/hooks");
const { parseArgs } = require("../index/args");
const { specForStep } = require("../utils/artifacts");
const { VOLUME_ARTIFACT_PATTERNS } = require("../intake/config");
const { postMortemDir } = require("../utils/postmortem");
const { bundleCachePresent } = require("../extract");
const { startFakeBackend } = require("./fake-backend");
const { readModuleLayer } = require("./module-layer");

const PROJECT_ROOT = path.join(__dirname, "..");

let passed = 0;

/**
 * Record one passing check.
 * @param {string} name
 * @returns {void}
 */
function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}

/**
 * Run a function with every console.log / warn / error it produces captured instead of printed, and
 * hand back the failure too.
 *
 * The extraction is loud on purpose — the whole point of the step is that it says what it saw — and
 * these fixtures are deliberately broken books, so the noise is correct output that is not the thing
 * under test. The failure is returned rather than thrown for the same reason: the scenario that plants
 * a HIGH finding has to read the log the step produced on its way to throwing, and a helper that lets
 * the error fly past it loses the log with it.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{result: T|null, logs: string[], error: Error|null}>}
 */
async function capture(fn) {
  const real = { log: console.log, warn: console.warn, error: console.error };
  /** @type {string[]} */
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    return { result: await fn(), logs, error: null };
  } catch (err) {
    return { result: null, logs, error: err };
  } finally {
    Object.assign(console, real);
  }
}

/**
 * Build a fixture book. Same shape as the audit suite's: a real archive the real converter opens.
 *
 * @param {{title: string, pages: Array<{file: string, pageTitle: string, navTitle?: string|null, bodyClass?: string, body: string}>}} spec
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
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:extractstep</dc:identifier>` +
      `<dc:title>${title}</dc:title><dc:language>ja</dc:language></metadata><manifest>` +
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
      pages.map((p, i) => `<item id="p${i}" href="${p.file}" media-type="application/xhtml+xml"/>`).join("") +
      `</manifest><spine>${pages.map((_, i) => `<itemref idref="p${i}"/>`).join("")}</spine></package>`
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0"?><html><head><title>nav</title></head><body><nav><ol>` +
      pages.filter((p) => p.navTitle).map((p) => `<li><a href="${p.file}">${p.navTitle}</a></li>`).join("") +
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
 * @param {string} label
 * @returns {string}
 */
function prose(label) {
  return (
    `<p>${label}の話を書くことにする。まずは彼が何を言ったのかを思い出すところから始めることにする。` +
      `道沿いの店並みは以前とほとんど変わっていなかったし、変わったとしたら私が歩く速度だけだろう。</p>` +
      `<p>それすらも確かめる術はないので、今日はそのまま歩き続けて、考えたことをまた later に書くことにする。` +
      `歩きながら何度も昨日の会話を思い返していたが、思い出すたびに順番が変わって、結局どれが先だったのかはわからなくなった。</p>`
  );
}

/** A chapter page with real story text. */
const CHAPTER = (file, title) => ({
  file,
  pageTitle: title,
  navTitle: title,
  body: `<p>${title}</p>${prose(title)}`,
});

/**
 * Lay out a throwaway series with a plan of record the intake accepts, and point SERIES_LOCATION at it.
 *
 * The manifest is written by hand rather than produced by `discover`, on purpose: the intake agent is a
 * model call, and this step must be testable without one. The shape is the one `readUsableManifest`
 * validates (schema 2, a discovery block with per-dimension confidence, per-volume integrity).
 *
 * @param {string} label
 * @param {Array<{installment: string, folder: string, sourceName: string, write: () => Promise<Buffer|string>}>} volumes
 * @returns {Promise<{seriesDir: string, volumes: Array<{folder: string, installmentNumber: string, sourceFile: string}>}>}
 */
async function fixtureSeries(label, volumes) {
  const seriesDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `extract-step-${label}-`));
  for (const v of volumes) {
    const volumeDir = path.join(seriesDir, v.folder);
    await fs.promises.mkdir(volumeDir, { recursive: true });
    await fs.promises.writeFile(path.join(volumeDir, v.sourceName), await v.write());
  }
  await fs.promises.writeFile(
    path.join(seriesDir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: seriesDir,
        seriesName: "Extract Step Series",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test/test-extract-step.js",
        generatedAt: new Date().toISOString(),
        discovery: {
          summary: "fixture",
          confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
          evidence: ["two fixture books"],
          excluded: [],
        },
        volumes: volumes.map((v) => ({
          folder: v.folder,
          sourceFile: `${v.folder}/${v.sourceName}`,
          installmentNumber: v.installment,
          title: "Extract Step Series",
          integrity: {
            isNarrative: true,
            confidence: 0.9,
            basis: "fixture: continuous prose in named sections, no packaging pages",
          },
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  const saved = process.env.SERIES_LOCATION;
  process.env.SERIES_LOCATION = seriesDir;
  // Each scenario gets its own records folder: the assertions are about what THIS run wrote.
  process.env.RUN_DIR = await fs.promises.mkdtemp(path.join(os.tmpdir(), `extract-step-records-${label}-`));
  try {
    fs.rmSync(postMortemDir(), { recursive: true, force: true });
  } catch {
    /* nothing to clear yet */
  }
  return {
    seriesDir,
    savedSeriesLocation: saved,
    volumes: volumes.map((v) => ({
      folder: v.folder,
      installmentNumber: v.installment,
      sourceFile: `${v.folder}/${v.sourceName}`,
    })),
  };
}

/**
 * Wipe a fixture series and its records.
 * @param {{seriesDir: string}} fx
 * @returns {Promise<void>}
 */
async function dispose(fx) {
  await fs.promises.rm(fx.seriesDir, { recursive: true, force: true });
  await fs.promises.rm(process.env.RUN_DIR, { recursive: true, force: true });
}

/**
 * The step, run the way the gulp task runs it.
 * @returns {Promise<{volumes: number, HIGH: number, MEDIUM: number, reports: Object}>}
 */
function runStep() {
  return require("../extract").extractVolumes({ argv: [process.execPath, "extract"] });
}

// ─── 1. the step is registered, in the right place, everywhere it must be ─────

/**
 * `extract` sits between `discover` and `glossary`, is a real gulp task, is a hook name, has an
 * artifact spec, and is a name `--stages=` accepts.
 */
async function scenarioRegistered() {
  const names = GULPFILE.PIPELINE_STEPS.map((s) => s.name);
  const at = names.indexOf("extract");
  assert.ok(at > 0, `extract is in PIPELINE_STEPS (found at ${at})`);
  assert.strictEqual(names[at - 1], "discover", `extract follows discover: ${names.join(", ")}`);
  assert.strictEqual(names[at + 1], "glossary", `extract precedes glossary: ${names.join(", ")}`);
  ok(`extract sits between discover and glossary (${names.join(" -> ")})`);

  assert.strictEqual(typeof GULPFILE.extract, "function", "npx gulp extract is a real task");
  assert.ok(
    GULPFILE.PIPELINE_STEPS[at].run === GULPFILE.extract,
    "the step list and the exported task are the same wrapped function"
  );
  ok("the gulp task `extract` exists and is the one the default run executes");

  assert.ok(TASKS.includes("extract"), "utils/hooks.js TASKS knows the step, so its hooks can fire");
  ok("extract is a hook name (pre-extract / post-extract are reachable)");

  const spec = specForStep("extract");
  assert.ok(spec, "extract is declared in utils/artifacts.js — an undeclared step is a HIGH finding");
  assert.strictEqual(spec.perVolume, false, "it owes nothing to a volume folder");
  assert.deepStrictEqual(spec.volume, [], "it owes nothing to a volume folder");
  assert.deepStrictEqual(spec.series, [], "it owes nothing to the series root");
  assert.deepStrictEqual(
    (spec.run || []).map((e) => e.name),
    [
      "extraction-{installment}.md",
      "extraction-{installment}.json",
      "extraction-summary.md",
      "extraction-summary.json",
    ],
    "its declared output is the record pair it writes for every volume plus the series summary pair — " +
      "the run scope the account owner granted it in utils/postmortem/plan/01-finding-levels.md §10 " +
      "(gotcha 127), and test/test-delivery-audit.js pins it to be the ONLY pipeline step with one"
  );
  ok("its declared output is its own reports, and it is the one pipeline step granted a run scope");

  const parsed = parseArgs(["--stages=extract"]);
  assert.deepStrictEqual(parsed.steps.map((s) => s.name), ["extract"], "--stages=extract resolves the step");
  ok("npm run pipeline -- --stages=extract runs it alone");

  const listed = require("child_process").spawnSync(process.execPath, [path.join(PROJECT_ROOT, "index.js"), "--list"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.strictEqual(listed.status, 0, listed.stderr);
  assert.ok(listed.stdout.includes("extract"), "index.js --list names it");
  ok("index.js --list reports the step");
}

// ─── 2. a planted HIGH finding fails the step, and the reports survive it ─────

/**
 * The HIGH path: a named chapter that converted to nothing. The step audits every volume, writes every
 * report, and THEN throws — structurally, so no run policy can continue past it.
 */
async function scenarioHighFailsTheStep() {
  const fx = await fixtureSeries("high", [
    {
      installment: "01",
      folder: "Extract Series(01)",
      sourceName: "extract(1).epub",
      write: () =>
        buildBookEpub({
          title: "Extract Series 1",
          pages: [
            { file: "p-001.xhtml", pageTitle: "表紙", navTitle: "表紙", bodyClass: "p-cover", body: `<p>表紙</p>` },
            CHAPTER("p-002.xhtml", "第一章"),
            CHAPTER("p-003.xhtml", "第二章"),
          ],
        }),
    },
    {
      installment: "02",
      folder: "Extract Series(02)",
      sourceName: "extract(2).epub",
      write: () =>
        buildBookEpub({
          title: "Extract Series 2",
          pages: [
            CHAPTER("p-001.xhtml", "第一章"),
            // The hole that looks like a short chapter: the book's contents list names it, the page is
            // an illustration plate, and the text is not there.
            {
              file: "p-002.xhtml",
              pageTitle: "第二章",
              navTitle: "第二章",
              body: `<p>第二章</p><p><img src="images/plate.png" alt="挿絵"/></p>`,
            },
          ],
        }),
    },
  ]);

  const { logs, error: thrown } = await capture(() => runStep());

  assert.ok(thrown, "a HIGH finding fails the step");
  assert.strictEqual(thrown.structural, true, "and it fails it STRUCTURALLY — ON_TASK_ERROR=continue must not paper over a broken book");
  assert.ok(/chapter-extracted-empty/.test(thrown.message), `the error names the kind: ${thrown.message}`);
  assert.ok(/02/.test(thrown.message), `and the volume: ${thrown.message}`);
  ok("a planted HIGH finding throws a structural error naming the volume and the kind");

  // The reports are written BEFORE the throw: a run that stops on a bad book has to leave the account
  // of what is wrong, not a stack trace.
  const outDir = postMortemDir();
  for (const name of ["extraction-01.md", "extraction-02.md", "extraction-summary.md", "extraction-summary.json"]) {
    assert.ok(fs.existsSync(path.join(outDir, name)), `${name} was written before the step failed`);
  }
  ok("the per-volume reports and the series summary are on disk before the step throws");

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "extraction-summary.json"), "utf8"));
  assert.strictEqual(summary.totals.HIGH, 1, `the summary counts the HIGH finding: ${JSON.stringify(summary.totals)}`);
  assert.strictEqual(summary.volumes.length, 2, "and it audited BOTH volumes, not just the one that broke");
  assert.strictEqual(summary.volumes[0].counts.HIGH, 0, "volume 01 is clean");
  assert.strictEqual(summary.volumes[1].counts.HIGH, 1, "volume 02 is the broken one");
  ok("the summary is the whole series: every volume audited, the finding counted");

  assert.ok(
    logs.some((l) => /\[extract\] Volume 02 · \[HIGH\] chapter-extracted-empty/.test(l)),
    `the HIGH finding is printed, not only filed:\n${logs.join("\n")}`
  );
  ok("the finding is printed in the step's own log");

  await dispose(fx);
}

// ─── 3. a planted MEDIUM finding is recorded, and the run continues ───────────

/**
 * The MEDIUM path: a chapter titled after its file. Recorded, printed, counted — and the step finishes.
 */
async function scenarioMediumContinues() {
  const fx = await fixtureSeries("medium", [
    {
      installment: "01",
      folder: "Medium Series(01)",
      sourceName: "medium(1).epub",
      write: () =>
        buildBookEpub({
          title: "Medium Series 1",
          pages: [CHAPTER("p-001.xhtml", "第一章"), CHAPTER("p-002.xhtml", "第二章")],
        }),
    },
    {
      // A plain-text book that declares no heading of its own: the extraction titles it after the file,
      // which is the shape `auditTitlesAreTitles` is the tripwire for.
      installment: "02",
      folder: "Medium Series(02)",
      sourceName: "medium(2).txt",
      write: () => `${"これは本文です。この続きも同じ調子で書き足しておく。\n".repeat(40)}`,
    },
  ]);

  const { result, logs, error } = await capture(() => runStep());
  assert.strictEqual(error, null, `a MEDIUM finding must not fail the step: ${error && error.message}\n${logs.join("\n")}`);
  assert.strictEqual(result.HIGH, 0, "no HIGH finding");
  assert.strictEqual(result.MEDIUM, 1, `one MEDIUM finding: ${logs.join("\n")}`);
  ok("a planted MEDIUM finding does NOT fail the step");

  assert.ok(
    logs.some((l) => /\[extract\] Volume 02 · \[MEDIUM\] title-is-filename/.test(l)),
    `the MEDIUM finding is printed:\n${logs.join("\n")}`
  );
  ok("the MEDIUM finding is printed with its volume and its kind");

  const outDir = postMortemDir();
  const report = fs.readFileSync(path.join(outDir, "extraction-02.md"), "utf8");
  assert.ok(report.includes("title-is-filename"), `the report records it:\n${report}`);
  assert.ok(report.includes("MEDIUM FINDINGS"), "and says so in its verdict line");
  ok("the MEDIUM finding is recorded in the volume's report");

  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "extraction-summary.json"), "utf8"));
  assert.strictEqual(summary.totals.MEDIUM, 1);
  assert.strictEqual(summary.totals.HIGH, 0);
  ok("the summary counts it as a gap, not as damage");

  await dispose(fx);
}

// ─── 3b. the guide-split tripwire fails the step too ─────────────────────────

/**
 * The sixth check is HIGH, and a HIGH is a STOP. This is the delivery consequence of the tripwire: a
 * book whose text still carries 蒲かま田た stops the run at the free step, before a glossary stage spends
 * tokens turning that string into a glossary entry.
 */
async function scenarioGuideSplitFailsTheStep() {
  const fx = await fixtureSeries("guidesplit", [
    {
      installment: "01",
      folder: "Split Step Series(01)",
      sourceName: "splitstep(1).epub",
      write: () =>
        buildBookEpub({
          title: "Split Step Series 1",
          pages: [
            {
              file: "p-001.xhtml",
              pageTitle: "第一章",
              navTitle: "第一章",
              body:
                `<p>第一章</p><p>彼は<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>を見た。</p>${prose("第一章")}` +
                `<p>壊れた変換が残した 蒲かま田た という文字列が、この章の本文にそのまま残っている。</p>`,
            },
          ],
        }),
    },
    {
      installment: "02",
      folder: "Split Step Series(02)",
      sourceName: "splitstep(2).epub",
      write: () =>
        buildBookEpub({
          title: "Split Step Series 2",
          pages: [CHAPTER("p-001.xhtml", "第一章"), CHAPTER("p-002.xhtml", "第二章")],
        }),
    },
  ]);

  const { logs, error: thrown } = await capture(() => runStep());
  assert.ok(thrown, "a guide-split string in a chapter fails the step");
  assert.strictEqual(thrown.structural, true, "and structurally — no run policy walks past a book the converter mangled");
  assert.ok(/guide-split-in-text/.test(thrown.message), `the error names the kind: ${thrown.message}`);
  assert.ok(/01/.test(thrown.message), `and the volume: ${thrown.message}`);
  assert.ok(
    logs.some((l) => /\[extract\] Volume 01 · \[HIGH\] guide-split-in-text/.test(l)),
    `the finding is printed with the string it found:\n${logs.join("\n")}`
  );
  ok("the guide-split tripwire is a HIGH the step stops the run on");

  const summary = JSON.parse(fs.readFileSync(path.join(postMortemDir(), "extraction-summary.json"), "utf8"));
  assert.strictEqual(summary.totals.HIGH, 1, "one HIGH across the series");
  assert.strictEqual(summary.volumes[1].counts.HIGH, 0, "the clean volume is still clean, and audited anyway");
  ok("the clean volume is audited and reported even though its neighbour stopped the run");

  await dispose(fx);
}

// ─── 4. a warm cache is verified, not re-extracted, and the log says which ────

/**
 * The step's own promise: it does not re-extract 17 books on every run. First run extracts, second
 * run verifies, and the chapter files are not rewritten in between.
 */
async function scenarioWarmCache() {
  const fx = await fixtureSeries("warm", [
    {
      installment: "01",
      folder: "Warm Series(01)",
      sourceName: "warm(1).epub",
      write: () =>
        buildBookEpub({
          title: "Warm Series 1",
          pages: [
            { file: "p-001.xhtml", pageTitle: "表紙", navTitle: "表紙", bodyClass: "p-cover", body: `<p>表紙</p>` },
            CHAPTER("p-002.xhtml", "第一章"),
            CHAPTER("p-003.xhtml", "第二章"),
          ],
        }),
    },
  ]);
  const volumeDir = path.join(fx.seriesDir, "Warm Series(01)");

  const first = await capture(() => runStep());
  assert.strictEqual(first.error, null, `a clean fixture must not fail the step: ${first.error && first.error.message}\n${first.logs.join("\n")}`);
  assert.ok(
    first.logs.some((l) => /Volume 01 · EXTRACTED — no bundle existed/.test(l)),
    `the first run says it extracted:\n${first.logs.join("\n")}`
  );
  ok("a volume with no bundle yet is EXTRACTED, and the log says so");

  assert.ok(await bundleCachePresent(volumeDir), "the extraction left its bundle cache");
  const chapterFile = fs.readdirSync(volumeDir).find((n) => /-ch1\.md$/.test(n));
  assert.ok(chapterFile, "and a chapter file");
  const before = fs.statSync(path.join(volumeDir, chapterFile)).mtimeMs;

  const second = await capture(() => runStep());
  const lines = second.logs.join("\n");
  assert.ok(
    lines.includes("Volume 01 · VERIFIED"),
    `the second run says it verified:\n${lines}`
  );
  assert.ok(
    lines.includes("nothing re-extracted"),
    `and says plainly that it extracted nothing:\n${lines}`
  );
  assert.ok(!lines.includes("RE-EXTRACTED"), `a warm cache is not re-extracted:\n${lines}`);
  ok("a warm cache is VERIFIED, the log says 'nothing re-extracted', and it never says RE-EXTRACTED");

  const after = fs.statSync(path.join(volumeDir, chapterFile)).mtimeMs;
  assert.strictEqual(after, before, "the chapter file was not rewritten between the two runs");
  ok("the bundle on disk is reused, not rebuilt (the file's own mtime is the proof)");

  // And the distinction is real: touch the archive and the same step says RE-EXTRACTED.
  const archive = path.join(volumeDir, "warm(1).epub");
  const bytes = fs.readFileSync(archive);
  fs.writeFileSync(archive, bytes);
  fs.utimesSync(archive, new Date(), new Date(Date.now() + 5000));
  const third = await capture(() => runStep());
  assert.ok(
    third.logs.some((l) => /Volume 01 · RE-EXTRACTED/.test(l)),
    `a changed archive is re-extracted, and says so:\n${third.logs.join("\n")}`
  );
  ok("a changed archive is RE-EXTRACTED — the step can tell the two apart");

  await dispose(fx);
}

// ─── 4b. a frozen volume re-extracted by a changed archive is NAMED, not refused ─

/**
 * The freeze gate refuses `extract --force` on a volume whose translation is published. This is the
 * OTHER way that volume's text gets rewritten — the archive changed, so the cache is no longer current
 * — and there the step **warns** instead of refusing, because the book on disk has already changed and
 * the translation beside it was made from the old text. Refusing would protect nothing; the sentence is
 * the whole value of the act, so it is pinned here rather than asserted in a comment.
 *
 * @returns {Promise<void>}
 */
async function scenarioFrozenReExtractionIsNamed() {
  const fx = await fixtureSeries("frozen-reextract", [
    {
      installment: "01",
      folder: "Frozen Series(01)",
      sourceName: "frozen(1).epub",
      write: () =>
        buildBookEpub({
          title: "Frozen Series 1",
          pages: [
            { file: "p-001.xhtml", pageTitle: "表紙", navTitle: "表紙", bodyClass: "p-cover", body: `<p>表紙</p>` },
            CHAPTER("p-002.xhtml", "第一章"),
            CHAPTER("p-003.xhtml", "第二章"),
          ],
        }),
    },
  ]);
  const volumeDir = path.join(fx.seriesDir, "Frozen Series(01)");

  const first = await capture(() => runStep());
  assert.strictEqual(first.error, null, `the cold pass must succeed: ${first.error && first.error.message}\n${first.logs.join("\n")}`);
  ok("the fixture's book extracts");

  // Publish a translation on top of it: the two names `specForStep("translate")` declares `required`.
  // That is what makes this volume frozen, and nothing else in this scenario changes that fact.
  await fs.promises.writeFile(path.join(volumeDir, "translation.md"), "# translated\n", "utf8");
  await fs.promises.writeFile(
    path.join(volumeDir, "translation-state.json"),
    JSON.stringify({ sourceFingerprint: "whatever-the-translation-was-made-from" }, null, 2) + "\n",
    "utf8"
  );
  ok("a volume holding the translate step's two required artifacts is a frozen volume");

  // The archive changes underneath it. No `--force` anywhere in this scenario.
  const archive = path.join(volumeDir, "frozen(1).epub");
  const bytes = fs.readFileSync(archive);
  fs.writeFileSync(archive, bytes);
  fs.utimesSync(archive, new Date(), new Date(Date.now() + 5000));

  const second = await capture(() => runStep());
  const lines = second.logs.join("\n");
  assert.strictEqual(second.error, null, `a stale cache is not a refusal, so the step still finishes:\n${lines}`);
  assert.ok(/Volume 01 · RE-EXTRACTED/.test(lines), `the archive change is re-extracted:\n${lines}`);
  ok("the step re-extracts a stale cache without being told to");

  assert.ok(
    /FROZEN VOLUME RE-EXTRACTED/.test(lines),
    `and it says out loud that the volume was frozen:\n${lines}`
  );
  assert.ok(
    /translation\.md/.test(lines.split("\n").find((l) => /FROZEN VOLUME RE-EXTRACTED/.test(l)) || ""),
    "the warning names the translation standing in the folder"
  );
  assert.ok(
    /release-translation\.js --volume=01 --door=extract/.test(lines),
    `and it names the door past the gate rather than inventing a flag:\n${lines}`
  );
  ok("a frozen volume whose text this run replaced is named, with the recorded act it would need");

  // And the warning is not a refusal wearing a different colour: the volume's own report still records
  // the re-extraction, and the translation files are untouched.
  const report = fs.readFileSync(path.join(postMortemDir(), "extraction-01.md"), "utf8");
  assert.ok(/RE-EXTRACTED/.test(report), `the report records what happened:\n${report}`);
  assert.strictEqual(
    fs.readFileSync(path.join(volumeDir, "translation.md"), "utf8"),
    "# translated\n",
    "the warning touched no translation"
  );
  ok("the sentence is a warning: the report still says RE-EXTRACTED and the translation is byte-identical");

  await dispose(fx);
}

// ─── 5. the reports land in the run's records, not in the corpus ──────────────

/**
 * Volume folders are the deliverable; the run's memory lives in `.run/`. The extraction step's reports
 * must not add a single new file name to a volume folder — and the bundle files the extraction does
 * write must all be names the intake already recognises, so the step cannot hand the next intake run a
 * file to mistake for a book (gotcha 119).
 */
async function scenarioReportLocation() {
  const fx = await fixtureSeries("reports", [
    {
      installment: "01",
      folder: "Report Series(01)",
      sourceName: "report(1).epub",
      write: () =>
        buildBookEpub({
          title: "Report Series 1",
          pages: [CHAPTER("p-001.xhtml", "第一章"), CHAPTER("p-002.xhtml", "第二章")],
        }),
    },
  ]);
  const volumeDir = path.join(fx.seriesDir, "Report Series(01)");
  const before = fs.readdirSync(volumeDir).sort();

  await capture(() => runStep());

  const outDir = postMortemDir();
  const mdPath = path.join(outDir, "extraction-01.md");
  const jsonPath = path.join(outDir, "extraction-01.json");
  assert.ok(fs.existsSync(mdPath), `${mdPath} exists`);
  assert.ok(fs.existsSync(jsonPath), `${jsonPath} exists`);
  assert.ok(fs.existsSync(path.join(outDir, "extraction-summary.md")), "and the series summary beside it");
  ok("the reports are written under the run's records folder (postMortemDir())");

  for (const file of [mdPath, jsonPath, path.join(outDir, "extraction-summary.md")]) {
    const rel = path.relative(outDir, file);
    assert.ok(rel && !rel.startsWith(".."), `${file} is inside postMortemDir()`);
  }
  ok("every report is inside the run's records folder");

  const after = fs.readdirSync(volumeDir).sort();
  const added = after.filter((n) => !before.includes(n));
  assert.ok(added.length > 0, "the extraction did write its bundle into the volume folder — that is what extraction is");
  const unknown = added.filter((n) => !VOLUME_ARTIFACT_PATTERNS.some((re) => re.test(n)));
  assert.deepStrictEqual(
    unknown,
    [],
    `every file the step added is already in the artifact vocabulary the intake knows: ${added.join(", ")}`
  );
  assert.ok(
    !added.some((n) => /^extraction-/.test(n)),
    `no extraction report landed in the volume folder: ${added.join(", ")}`
  );
  ok("the volume folder gains only bundle files the intake already recognises — no new name, no report");

  const md = fs.readFileSync(mdPath, "utf8");
  for (const needle of ["# Extraction — volume 01", "## Chapters (2)", "第一章", "第二章", "| id | title | file |"]) {
    assert.ok(md.includes(needle), `the volume report holds "${needle}":\n${md}`);
  }
  assert.ok(md.includes("CLEAN"), "and its verdict line");
  ok("the volume report names the chapters, their titles and their sizes");

  const summaryMd = fs.readFileSync(path.join(outDir, "extraction-summary.md"), "utf8");
  assert.ok(summaryMd.includes("| 01 | Report Series(01) |"), `the summary is a table across the volumes:\n${summaryMd}`);
  ok("the series summary is one table, so a change in one book reads as a difference");

  const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.strictEqual(json.step, "extract");
  assert.strictEqual(json.counts.chapters, 2);
  assert.ok(json.sourceFingerprint, "the record carries the source fingerprint it verified against");
  assert.strictEqual(json.action, "extracted");
  ok("the JSON half is queryable: the action, the counts and the fingerprint");

  await dispose(fx);
}

// ─── 6. zero model calls, measured at the wire ────────────────────────────────

/**
 * The step's central promise, proved against a live stub server rather than by reading the source:
 * nothing this step does reaches an endpoint.
 */
async function scenarioNoModelCalls() {
  const fx = await fixtureSeries("nomodel", [
    {
      installment: "01",
      folder: "Quiet Series(01)",
      sourceName: "quiet(1).epub",
      write: () => buildBookEpub({ title: "Quiet Series 1", pages: [CHAPTER("p-001.xhtml", "第一章")] }),
    },
  ]);

  const savedEnv = {
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
  };
  const backend = await startFakeBackend({ model: ["stub", "stub-translate", "stub-verify", "stub-edit", "stub-audit"] });
  try {
    backend.pointEnvAt({ prefixes: ["TRANSLATE", "VERIFY", "EDIT", "AUDIT"] });
    const { result, logs, error } = await capture(() => runStep());
    assert.strictEqual(error, null, `a clean fixture must not fail the step: ${error && error.message}\n${logs.join("\n")}`);
    assert.strictEqual(result.volumes, 1, `the step ran: ${logs.join("\n")}`);
    assert.strictEqual(backend.requests.length, 0, `the step made ${backend.requests.length} model call(s) — it must make none`);
    ok("a live stub endpoint recorded ZERO requests from the extract step");
  } finally {
    await backend.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const layer = readModuleLayer(PROJECT_ROOT, "extract.js");
  // The guarantee is a REQUIREMENT graph, not a word search: a step cannot reach the model without
  // requiring the door to it, and a word search would report my own comments as violations.
  const specifiers = [...layer.matchAll(/require\(\s*"([^"]+)"/g)].map((m) => m[1]);
  const reached = specifiers.filter((s) => /(harness|openharness|ai-sdk|prompt)/i.test(s));
  assert.deepStrictEqual(reached, [], `the extract step's module layer reaches the model through: ${reached.join(", ")}`);
  assert.ok(
    specifiers.includes("../utils/source"),
    `and it does reach the source layer, which is the point: ${specifiers.join(", ")}`
  );
  ok("the step's whole module layer requires no harness, no agent and no prompt file — only the source layer");

  await dispose(fx);
}

// ─── 7. a book that will not open is named, not swallowed ─────────────────────

/**
 * The loop's fake `book.epub` is the literal string `not really an epub`. The step must not special-case
 * it away: the archive does not open, so the volume could not be extracted at all, and that is reported
 * as a volume that failed — named, written down, and fatal to the run.
 */
async function scenarioUnreadableBook() {
  const fx = await fixtureSeries("garbage", [
    {
      installment: "01",
      folder: "Test Story(01)",
      sourceName: "book.epub",
      write: () => "not really an epub",
    },
  ]);

  const { error: thrown } = await capture(() => runStep());
  assert.ok(thrown, "a book that will not open fails the step");
  assert.ok(/could not be read/.test(thrown.message), `and says what kind of failure it was: ${thrown.message}`);
  assert.ok(/Test Story\(01\)/.test(thrown.message), `naming the volume: ${thrown.message}`);
  ok("an archive that will not open is reported as a volume that could not be read, and fails the run");

  const outDir = postMortemDir();
  const report = fs.readFileSync(path.join(outDir, "extraction-01.md"), "utf8");
  assert.ok(report.includes("**FAILED**"), `the volume's own report says FAILED:\n${report}`);
  const summary = JSON.parse(fs.readFileSync(path.join(outDir, "extraction-summary.json"), "utf8"));
  assert.ok(summary.volumes[0].error, `the summary carries the error rather than an empty clean row: ${JSON.stringify(summary.volumes[0])}`);
  assert.strictEqual(summary.volumes[0].action, null, "and it does not claim a state for a bundle it never resolved");
  assert.strictEqual(summary.volumes[0].counts.chapters, 0, "with zero chapters, which is the truth and not a measurement");
  ok("the reports record the failure instead of reporting a clean volume it never audited");

  await dispose(fx);
}

(async () => {
  console.log("extract-step: the extraction step as a pipeline step, with no model in it");
  await scenarioRegistered();
  await scenarioHighFailsTheStep();
  await scenarioMediumContinues();
  await scenarioGuideSplitFailsTheStep();
  await scenarioWarmCache();
  await scenarioFrozenReExtractionIsNamed();
  await scenarioReportLocation();
  await scenarioNoModelCalls();
  await scenarioUnreadableBook();
  console.log(`\nextract-step: all ${passed} checks passed.`);
})().catch((err) => {
  console.error("extract-step: FAILED");
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

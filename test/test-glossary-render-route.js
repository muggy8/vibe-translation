#!/usr/bin/env node
/**
 * test/test-glossary-render-route.js — slice 2 of the glossary route: the published `glossary.md`
 * is **rendered out of the volume's reference record**, and the author agent that used to write it
 * is gone from the stage.
 *
 * `test/test-glossary-store-unconditional.js` pins slice 1 — that the record is opened, filed,
 * audited, graded and sealed with no setting in front of it. This suite pins what changed on top of
 * that: who writes the file, whether the render can be trusted to be the same file twice, and what
 * stops it from publishing a shorter document than the volume before it.
 *
 * The scenarios:
 *
 *   1. **The stage has no author, validator or feedback agent.** Read off the module layer: no
 *      `glossary-author` / `glossary-validator` / `glossary-feedback` kind survives anywhere in the
 *      stage, the only agent handle it opens is the research reader, and the file is written by
 *      `renderGlossaryArtifact` in both routes.
 *   2. **The render is the same bytes in a fresh process.** Two child processes render the same
 *      fixture record and produce the same sha256. A renderer whose order came from whatever SQLite
 *      felt like would pass every single-process test and produce a different file on the next run.
 *   3. **The rendered file is the cumulative one** — the previous volume's rows, then this volume's,
 *      under the sections the record filed them in.
 *   4. **The no-AI loss gate stops a render that drops an entry** (AGENTS.md rule 5). The plant is
 *      the case the render route actually risks: a published document that holds a row the record
 *      never carried. Nothing in the stage can see that except this gate.
 *   5. **A render with no rows refuses, and the published file stays where it is.** A title and an
 *      empty table is not a glossary, and it is not allowed to replace one.
 *   6. **A quarantine is numbered and keeps every failure** (gotcha 111): `.rejected`, then
 *      `.rejected.2`, through the shared door.
 *   7. **The chapter-by-chapter route re-renders after every chapter and gates between chapters**,
 *      and both routes share the one volume-level acceptance gate.
 *   8. **The gate grades once.** One grade per volume is a constant, not a setting.
 *
 * Every scenario runs in a throwaway fixture under the fixture root. Nothing here reads the real 17
 * volumes or any file under the series folder (AGENTS.md rule 8, gotcha 69), and no scenario makes a
 * model call: the render, the filing doors, the audit and the gate are all deterministic.
 *
 * Run with `npm test`, or standalone: `node test/test-glossary-render-route.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const { isVolumeSealed } = require("../utils/reference-store");
const glossaryStore = require("../glossary/store");
const { assertGlossaryCarryForward, compareGlossaryCarryForward } = require("../glossary");
const { readModuleLayer } = require("./module-layer");
const { fixtureStoreSeries, assertInsideFixture } = require("./fixture-reference-store");

let checks = 0;
/**
 * Count one assertion and run it.
 * @param {boolean|void} condition
 * @param {string} message
 * @returns {void}
 */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}
/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} message
 * @returns {void}
 */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

/** A row the fixture's volume 01 text prints ("山田は会計の人である。"). */
const ROW_ACCOUNTING = { term: "会計", rendering: "The Accounting Person", note: "The book says it plainly.", type: "concept", query: "会計" };
/** A row only volume 02's text prints ("駱駝はあとがきに書いた。"). */
const ROW_CAMEL = { term: "駱駝", rendering: "The Camel", note: "Writes the afterword.", type: "concept", query: "駱駝" };
/** A row volume 01's text prints in its prologue ("担任の教師は黒板を叩いた。"). */
const ROW_BLACKBOARD = { term: "黒板", rendering: "Blackboard", note: "The teacher hits it.", type: "item", query: "黒板" };

/**
 * Build the context object `glossary/task.js` hands its store glue, for a fixture volume.
 *
 * Same shape as `test/test-glossary-store-unconditional.js`: the point of these scenarios is that the
 * doors under test are the ones the stage itself opens.
 *
 * @param {{dir: string, volumes: Array<{folder: string, installmentNumber: string, base: string, dir: string}>}} fx
 * @param {number} index - 0 for volume 01, 1 for volume 02.
 * @returns {Object}
 */
function stageCtx(fx, index) {
  const volume = fx.volumes[index];
  const previous = index > 0 ? fx.volumes[index - 1] : null;
  const meta = JSON.parse(fs.readFileSync(path.join(volume.dir, `${volume.base}-bundle.meta.json`), "utf8"));
  return {
    values: {
      INSTALLMENT_NUMBER: volume.installmentNumber,
      SOURCE_NAME: "Test Story",
      SOURCE_LANGUAGE: "Japanese",
      TARGET_LANGUAGE: "English",
    },
    folderName: volume.folder,
    seriesDir: fx.dir,
    volumeDir: volume.dir,
    isFirst: index === 0,
    previousFolderName: previous ? previous.folder : null,
    previousGlossaryFile: previous ? path.join(previous.dir, "glossary.md") : null,
    bundle: { segments: meta.segments, sourceFingerprint: "fixture" },
    glossaryOutputFile: path.join(volume.dir, "glossary.md"),
    validationOutputFile: path.join(volume.dir, "glossary-validation.md"),
    refStore: null,
  };
}

/**
 * Open a fixture volume's record through the stage's own door, and fail loudly when it refuses.
 *
 * @param {Object} fx
 * @param {number} index
 * @returns {{ctx: Object, opened: Object}}
 */
function openThroughTheStage(fx, index) {
  const ctx = stageCtx(fx, index);
  const previous = index > 0 ? Number(fx.volumes[index - 1].installmentNumber) : null;
  const attempt = glossaryStore.openGlossaryRecord(ctx, previous);
  assert.ok(attempt.ok, `volume ${ctx.values.INSTALLMENT_NUMBER}: ${attempt.error}`);
  ctx.refStore = attempt.opened.store;
  assertInsideFixture(ctx.refStore.file, fx.dir);
  return { ctx, opened: attempt.opened };
}

// ─── Scenario 1 ───────────────────────────────────────────────────────────────

/**
 * The author agent, the whole-document validator agent and the feedback agent are gone from the
 * stage's own code, and the file is written by the render in both routes.
 *
 * This is a source-text pin, and it is the narrowest honest form of "the agent is deleted": the kinds
 * do not exist, no agent handle is created for them, and the only `createAgentHandle` left in the
 * stage is the research reader.
 * @returns {void}
 */
function scenarioTheStageHasNoAuthorAgent() {
  const layer = readModuleLayer(ROOT, "glossary.js", "glossary");

  for (const kind of ["glossary-author", "glossary-validator", "glossary-feedback", "glossary-findings-merge"]) {
    ok(!layer.includes(`"${kind}"`), `the stage's code still names the deleted call kind ${kind}`);
  }
  ok(!layer.includes("runGlossaryFeedback"), "the stage still has a feedback pass it could run");
  ok(!layer.includes("mirrorGlossaryArtifact"), "the stage still re-imports its own rendered file into the record");
  ok(!layer.includes("seedGlossaryFromPrevious"), "the stage still copies the previous volume's document in before rendering");

  const agentHandles = layer.match(/createAgentHandle\(/g) || [];
  same(agentHandles.length, 1, "the stage opens more than one agent turn; its only one is the research reader");
  ok(/name: `researcher-/.test(layer), "the one agent turn the stage opens is not the research reader");

  // Both routes publish through the render door.
  ok(/renderGlossaryArtifact\(/.test(layer), "no route renders the glossary out of the record");
  const chunked = fs.readFileSync(path.join(ROOT, "glossary/chunked.js"), "utf8");
  ok(/renderGlossaryArtifact\(/.test(chunked), "the chapter-by-chapter route does not render after a chapter");
  ok(!/runPerChapterQaLoop|runChunkedQaLoop/.test(chunked), "the chapter-by-chapter route still runs its own QA loop with per-chapter validators");

  // The prompt files the deleted agents were built from are gone, so nothing can rebuild them.
  for (const file of [
    "system-prompts/glossary.md",
    "system-prompts/glossary-validator.md",
    "system-prompts/glossary-feedback.md",
    "user-prompts/glossary.md",
    "user-prompts/glossary-validator.md",
    "user-prompts/glossary-feedback.md",
  ]) {
    ok(!fs.existsSync(path.join(ROOT, file)), `${file} is still on disk, so the deleted agent is still one edit away`);
  }
  ok(fs.existsSync(path.join(ROOT, "system-prompts/glossary-terms.md")), "the read pass's own prompt is missing");
  ok(fs.existsSync(path.join(ROOT, "system-prompts/glossary-acceptance.md")), "the acceptance rubric is missing — the gate is unchanged");

  console.log("glossary render route: the stage has no author, validator or feedback agent; its one agent turn is the research reader, and both routes render the file out of the record");
}

// ─── Scenario 2 ───────────────────────────────────────────────────────────────

/**
 * Render one fixture volume's record in a fresh child process and report the bytes' sha256.
 *
 * @param {{dir: string, folder: string, installmentNumber: string}} volume
 * @returns {string} The hash of the rendered document.
 */
function renderInAFreshProcess(volume) {
  const script = [
    'const crypto = require("crypto");',
    'const { openVolumeRecord, renderGlossary } = require("./utils/reference-store");',
    'const { glossaryTitleBlock } = require("./glossary/store");',
    "const opened = openVolumeRecord({",
    `  volume: ${JSON.stringify(volume.installmentNumber)},`,
    `  folder: ${JSON.stringify(volume.folder)},`,
    `  seriesDir: ${JSON.stringify(volume.dir)},`,
    "});",
    'if (!opened.ok) { console.error("open refused: " + opened.refusal.because); process.exit(1); }',
    "const markdown = renderGlossary(opened.store, {",
    `  volume: ${JSON.stringify(volume.installmentNumber)},`,
    "  title: glossaryTitleBlock({",
    '    SOURCE_NAME: "Test Story",',
    '    SOURCE_LANGUAGE: "Japanese",',
    '    TARGET_LANGUAGE: "English",',
    `    INSTALLMENT_NUMBER: ${JSON.stringify(volume.installmentNumber)},`,
    "  }),",
    "});",
    'console.log(crypto.createHash("sha256").update(markdown, "utf8").digest("hex"));',
    "opened.store.close();",
  ].join("\n");
  const res = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
  assert.strictEqual(res.status, 0, `the fresh-process render failed:\n${res.stderr || res.stdout}`);
  return String(res.stdout || "").trim();
}

/**
 * The same record renders to the same bytes in two separate processes.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheRenderIsTheSameBytesInAFreshProcess() {
  const fx = fixtureStoreSeries("glossary-render-determinism");
  const { ctx } = openThroughTheStage(fx, 0);
  const filed = glossaryStore.fileGlossaryTermRows(ctx, [ROW_ACCOUNTING, ROW_BLACKBOARD]);
  same(filed.importedCount, 2, "both rows should be filed: " + JSON.stringify(filed.refused));
  const rendered = await glossaryStore.renderGlossaryArtifact(ctx);
  ok(rendered.ok, `the render refused: ${JSON.stringify(rendered.refusal)}`);
  ctx.qaAccepted = true;
  glossaryStore.sealGlossaryRecord(ctx);
  ctx.refStore.close();

  const first = renderInAFreshProcess({ ...fx.volumes[0], dir: fx.dir });
  const second = renderInAFreshProcess({ ...fx.volumes[0], dir: fx.dir });
  ok(/^[0-9a-f]{64}$/.test(first), `the child render printed nothing usable: ${first}`);
  same(second, first, "the same record rendered to different bytes in a fresh process — the row order is not pinned");

  // And the render the stage itself wrote is the same document, byte for byte.
  const published = fs.readFileSync(ctx.glossaryOutputFile, "utf8");
  const publishedHash = crypto.createHash("sha256").update(published, "utf8").digest("hex");
  same(publishedHash, first, "the file the stage published is not the document the record renders");

  console.log(`glossary render route: the same record renders to the same ${first.slice(0, 12)}… bytes in two fresh processes and to the file the stage published`);
}

// ─── Scenario 3 ───────────────────────────────────────────────────────────────

/**
 * The published file is the cumulative one: the previous volume's rows, then this volume's own.
 * @returns {void}
 */
async function scenarioTheRenderedFileIsTheCumulativeOne() {
  const fx = fixtureStoreSeries("glossary-render-cumulative");

  const first = openThroughTheStage(fx, 0);
  glossaryStore.fileGlossaryTermRows(first.ctx, [ROW_ACCOUNTING]);
  const renderedOne = await glossaryStore.renderGlossaryArtifact(first.ctx);
  ok(renderedOne.ok, `volume 1's render refused: ${JSON.stringify(renderedOne.refusal)}`);
  first.ctx.qaAccepted = true;
  glossaryStore.sealGlossaryRecord(first.ctx);
  const fileOne = fs.readFileSync(first.ctx.glossaryOutputFile, "utf8");
  first.ctx.refStore.close();

  const second = openThroughTheStage(fx, 1);
  glossaryStore.fileGlossaryTermRows(second.ctx, [ROW_CAMEL]);
  const renderedTwo = await glossaryStore.renderGlossaryArtifact(second.ctx);
  ok(renderedTwo.ok, `volume 2's render refused: ${JSON.stringify(renderedTwo.refusal)}`);
  const fileTwo = fs.readFileSync(second.ctx.glossaryOutputFile, "utf8");
  second.ctx.refStore.close();

  ok(fileTwo.includes(`| ${ROW_ACCOUNTING.term} | ${ROW_ACCOUNTING.rendering} |`), "volume 2's file lost the row volume 1 published");
  ok(fileTwo.includes(`| ${ROW_CAMEL.term} | ${ROW_CAMEL.rendering} |`), "volume 2's file does not hold the row volume 2 found");
  ok(renderedTwo.rows === renderedOne.rows + 1, `the file is not the record's row count: ${renderedOne.rows} then ${renderedTwo.rows}`);

  // The gate that protects a cumulative artifact sees no loss, because there is none.
  const diff = compareGlossaryCarryForward(fileOne, fileTwo);
  same(diff.missing.map((e) => e.term), [], "the cumulative gate reports a loss where the render carried everything");

  // The title block is the deterministic one, and it names the volume the file is current through.
  ok(/^# Glossary/m.test(fileTwo), "the rendered file has no title line");
  ok(fileTwo.includes("Current through volume 02"), "the rendered file does not say which volume it is current through");

  console.log(`glossary render route: volume 2 publishes ${renderedTwo.rows} rows — volume 1's carried row and its own — and the cumulative gate reports no loss`);
}

// ─── Scenario 4 ───────────────────────────────────────────────────────────────

/**
 * The no-AI cumulative gate stops a render that drops an entry, and moves the file aside.
 *
 * The plant is the shape the render route can actually fail in: the previous volume's PUBLISHED file
 * holds a row that its RECORD never carried (an authored glossary from before the store, or a row a
 * filing door refused). The copy-forward carries rows, not documents, so volume 2's render is shorter
 * than volume 1's file — and every other check in the stage is blind to it.
 * @returns {Promise<void>}
 */
async function scenarioTheLossGateStopsARenderThatDropsAnEntry() {
  const fx = fixtureStoreSeries("glossary-render-loss");

  const first = openThroughTheStage(fx, 0);
  glossaryStore.fileGlossaryTermRows(first.ctx, [ROW_ACCOUNTING]);
  const renderedOne = await glossaryStore.renderGlossaryArtifact(first.ctx);
  ok(renderedOne.ok, `volume 1's render refused: ${JSON.stringify(renderedOne.refusal)}`);
  first.ctx.qaAccepted = true;
  glossaryStore.sealGlossaryRecord(first.ctx);
  first.ctx.refStore.close();

  // The plant: volume 1's published document is replaced by one holding a row its record never held.
  const plantedRow = `| ${ROW_BLACKBOARD.term} | ${ROW_BLACKBOARD.rendering} | planted: the record never carried this row |`;
  const publishedWithPlant = `${fs.readFileSync(first.ctx.glossaryOutputFile, "utf8").replace(/\n*$/, "")}\n${plantedRow}\n`;
  fs.writeFileSync(first.ctx.glossaryOutputFile, publishedWithPlant, "utf8");

  const second = openThroughTheStage(fx, 1);
  glossaryStore.fileGlossaryTermRows(second.ctx, [ROW_CAMEL]);
  const renderedTwo = await glossaryStore.renderGlossaryArtifact(second.ctx);
  ok(renderedTwo.ok, `volume 2's render refused: ${JSON.stringify(renderedTwo.refusal)}`);

  let failure = null;
  try {
    await assertGlossaryCarryForward(second.ctx, "the render");
  } catch (err) {
    failure = err;
  }
  ok(failure, "a render that dropped a carried-forward row passed the cumulative gate");
  ok(/dropped 1 of the 2 term\(s\)/.test(failure && failure.message), `the failure does not name the numbers: ${failure && failure.message}`);
  ok(/黒板/.test(failure && failure.message), "the failure does not name the row the render lost");

  const quarantined = path.join(second.ctx.volumeDir, "glossary.md.rejected");
  ok(!fs.existsSync(second.ctx.glossaryOutputFile), "the damaged file is still where the next volume would read it");
  ok(fs.existsSync(quarantined), "the damaged file was not kept as evidence");
  ok(fs.readFileSync(quarantined, "utf8").includes(`| ${ROW_CAMEL.term} |`), "the quarantined evidence is not the file the render wrote");

  // The volume is a failure, so its record is not sealed, and the seal door says why.
  second.ctx.qaAccepted = false;
  const sealed = glossaryStore.sealGlossaryRecord(second.ctx);
  same(sealed.sealed, false, "the volume the gate stopped was sealed anyway");
  ok(!isVolumeSealed(second.ctx.refStore, 2), "the failed volume's record is not a draft");
  second.ctx.refStore.close();

  console.log("glossary render route: a render that dropped a row the previous volume published fails the volume, names the row, and the file is moved to glossary.md.rejected");
}

// ─── Scenario 5 ───────────────────────────────────────────────────────────────

/**
 * A record with no glossary rows renders a file with nothing in it, and that render is refused —
 * the `glossary.md` already on disk stays exactly where it is.
 * @returns {Promise<void>}
 */
async function scenarioARenderWithNoRowsRefusesAndKeepsThePublishedFile() {
  const fx = fixtureStoreSeries("glossary-render-empty");
  const { ctx } = openThroughTheStage(fx, 0);

  // A document already on disk (a previous failed run's, or a hand-written one).
  const existing = "# Glossary\n\n## Terms & Concepts\n\n| Japanese | English | Notes |\n|---|---|---|\n| 会計 | The Accounting Person | from the earlier run |\n";
  fs.writeFileSync(ctx.glossaryOutputFile, existing, "utf8");

  const rendered = await glossaryStore.renderGlossaryArtifact(ctx);
  same(rendered.ok, false, "a render with no rows was reported as a success");
  same(rendered.refusal.rule, "glossary-render-has-no-rows", `the refusal does not name the rule: ${JSON.stringify(rendered.refusal)}`);
  ok(rendered.refusal.because.includes("left where it is"), `the refusal does not say the published file was kept: ${rendered.refusal.because}`);
  same(fs.readFileSync(ctx.glossaryOutputFile, "utf8"), existing, "the empty render replaced the published glossary anyway");
  ok(!fs.existsSync(path.join(ctx.volumeDir, "glossary.md.rejected")), "a refused render moved a file it never wrote aside");

  ctx.refStore.close();
  console.log("glossary render route: a record with no rows refuses to render, and the glossary already on disk is left alone");
}

// ─── Scenario 6 ───────────────────────────────────────────────────────────────

/**
 * A volume that fails twice keeps both failures: the quarantine is numbered through the shared door.
 * @returns {Promise<void>}
 */
async function scenarioAQuarantineIsNumberedAndKeepsEveryFailure() {
  const fx = fixtureStoreSeries("glossary-render-quarantine");
  const { ctx } = openThroughTheStage(fx, 0);

  fs.writeFileSync(ctx.glossaryOutputFile, "## Terms & Concepts\n\n| Japanese | English | Notes |\n|---|---|---|\n| 会計 | The Accounting Person | first failure |\n", "utf8");
  const firstMoved = await glossaryStore.quarantineGlossaryArtifact(ctx);
  same(firstMoved, ["glossary.md.rejected"], "the first quarantine is not the plain `.rejected` name the loop and the wipe expect");

  fs.writeFileSync(ctx.glossaryOutputFile, "## Terms & Concepts\n\n| Japanese | English | Notes |\n|---|---|---|\n| 駱駝 | The Camel | second failure |\n", "utf8");
  const secondMoved = await glossaryStore.quarantineGlossaryArtifact(ctx);
  same(secondMoved, ["glossary.md.rejected.2"], "the second quarantine replaced the first one instead of numbering");

  const kept = fs.readFileSync(path.join(ctx.volumeDir, "glossary.md.rejected"), "utf8");
  ok(kept.includes("first failure"), "the first failure's document was overwritten");
  const kept2 = fs.readFileSync(path.join(ctx.volumeDir, "glossary.md.rejected.2"), "utf8");
  ok(kept2.includes("second failure"), "the second failure's document is not the one that was quarantined");

  // The folder's own ignore rule is written by the same door (gotcha 111).
  const ignore = fs.readFileSync(path.join(ctx.volumeDir, ".gitignore"), "utf8");
  ok(ignore.includes("*.rejected*"), "the volume folder does not ignore the quarantined family it writes");

  ctx.refStore.close();
  console.log("glossary render route: a volume that fails twice keeps glossary.md.rejected and glossary.md.rejected.2, and the folder ignores them");
}

// ─── Scenario 7 ───────────────────────────────────────────────────────────────

/**
 * Both routes end at the same volume-level gate, and the chapter-by-chapter route keeps the
 * between-chapter carry-forward guard by re-rendering after every chapter.
 * @returns {void}
 */
function scenarioBothRoutesShareTheOneGate() {
  const qa = fs.readFileSync(path.join(ROOT, "glossary/qa.js"), "utf8");
  const chunked = fs.readFileSync(path.join(ROOT, "glossary/chunked.js"), "utf8");
  const task = fs.readFileSync(path.join(ROOT, "glossary/task.js"), "utf8");

  ok(/maxIterations:\s*1/.test(qa), "the glossary gate is not the one-grade gate both routes share");
  ok(/feedbackArtifactFiles:\s*\[\]/.test(qa), "the glossary gate still hands a rewrite pass the artifact files to fix");
  ok(/deterministic/.test(qa), "the gate's validator is not the deterministic audit the store runs");

  // The chunked route's between-chapter guard, and the fact that only the first render moves a file.
  ok(/guardCarryForwardAgainst\(/.test(chunked), "the chapter-by-chapter route does not gate between chapters");
  ok(/renderGlossaryArtifact\(ctx, \{ moveAside: si === 0 \}\)/.test(chunked), "every chapter's render moves the previous chapter's file aside — the pile is noise, not evidence");

  // The shared tail: render, prove nothing was lost, grade, quarantine on failure.
  ok(/assertGlossaryCarryForward\(ctx, "the render"\)/.test(task), "the whole-volume route does not run the cumulative gate on its own render");
  ok(/quarantineGlossaryArtifact\(/.test(task), "a failing grade does not move the rendered file aside");

  console.log("glossary render route: both routes end at the one volume-level gate, and the chapter-by-chapter route re-renders and gates between chapters");
}

// ─── Scenario 8 ───────────────────────────────────────────────────────────────

/**
 * One acceptance ITERATION per volume is a constant, not a setting a run can raise. (One iteration is
 * not one score — `glossary/qa.js`'s header says why: the shared loop still fills its sample window by
 * re-grading the same artifact.)
 * @returns {void}
 */
function scenarioTheGateGradesOnce() {
  const layer = readModuleLayer(ROOT, "glossary.js", "glossary");
  ok(!/maxValidationIterations/.test(layer), "the stage still reads a setting for how many times to grade a rendered file");
  // The name may appear in a comment explaining why the stage does not use it; it must not be read.
  ok(!/process\.env\.QA_MAX_ITERATIONS/.test(layer), "the stage still reads the multi-pass stages' iteration setting from the environment");
  ok(!/QA_MAX_ITERATIONS\s*[,}]/.test(layer), "the stage still imports the multi-pass stages' iteration setting");

  const config = fs.readFileSync(path.join(ROOT, "glossary/config.js"), "utf8");
  ok(!/maxValidationIterations/.test(config), "glossary/config.js still carries the iteration setting the render route made meaningless");
  ok(!/maxIterations\s*[:=]/.test(fs.readFileSync(path.join(ROOT, "glossary/qa.js"), "utf8").replace(/maxIterations:\s*1/, "")), "the gate's iteration count is not a constant in glossary/qa.js");

  console.log("glossary render route: one acceptance iteration per volume is a constant in glossary/qa.js, and no setting in the stage can raise it");
}

async function main() {
  scenarioTheStageHasNoAuthorAgent();
  await scenarioTheRenderIsTheSameBytesInAFreshProcess();
  await scenarioTheRenderedFileIsTheCumulativeOne();
  await scenarioTheLossGateStopsARenderThatDropsAnEntry();
  await scenarioARenderWithNoRowsRefusesAndKeepsThePublishedFile();
  await scenarioAQuarantineIsNumberedAndKeepsEveryFailure();
  scenarioBothRoutesShareTheOneGate();
  scenarioTheGateGradesOnce();
  console.log(`\nOK: ${checks} checks on publishing the glossary out of the volume's record.`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});

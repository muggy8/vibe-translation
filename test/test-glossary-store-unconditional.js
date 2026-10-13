#!/usr/bin/env node
/**
 * test/test-glossary-store-unconditional.js — slice 1 of the glossary route: the volume's
 * reference record is opened, filed, audited, graded and sealed by the glossary stage with
 * **no setting in the environment in front of it**.
 *
 * Why this suite exists as its own file. The store's own rules are pinned by
 * `test/test-reference-store-pipeline.js`, and the stage's document shape by
 * `test/test-glossary-load.js`. What neither could pin is the thing slice 1 changes: the
 * decision to reach the store at all used to be a setting (`GLOSSARY_STORE_VALIDATORS`,
 * default off), so every existing suite could describe a stage that never opened a record and
 * still be green. This suite asks the question the setting answered:
 *
 *   **with nothing set in the environment, does the glossary stage build the record?**
 *
 * The scenarios, in the order the stage does its work:
 *
 *   1. **The default path is the store path.** The glossary stage runs offline against the
 *      scripted model server with no store setting anywhere in its environment, and every
 *      volume ends with a sealed record holding its glossary rows, and the second volume's
 *      record is a copy of the first one's. This is the plan's acceptance line
 *      (`glossary/plan/01-glossary-route.md` §6 row 1) read off the filesystem.
 *   2. **The seal follows the grade, one way.** A volume whose acceptance gate did not accept
 *      leaves its record a draft, and the next volume's copy-forward refuses it with
 *      `reference-volume-unsealed` (gotcha 102). The gate is the refusal, not the seal.
 *   3. **The seal follows the grade, the other way.** A volume the gate accepted is sealed, and
 *      the next volume copies forward from it. Without this half, scenario 2 only proves a seal
 *      can be withheld, not that the grade is what withholds it.
 *   4. **A term the book does not print is refused at filing** (plan §2 rule 1) — on the
 *      glossary stage's own door, not only on the store's.
 *   5. **Damage to a reference is still a hard stop** (plan §2 rule 4): a copy-forward that
 *      loses coverage is HIGH and blocks, with no exception and no downgrade.
 *   6. **The artifact stays cumulative** (plan §2 rule 5): what the previous volume published is
 *      still in the record the next volume builds on.
 *   7. **The acceptance gate keeps its shape** (plan §2 rule 6): the deterministic audit writes
 *      the same report file, with the same `**Recommendation:**` line the loop, the delivery
 *      layer and `test/prompt-audit.js`'s `acceptance-context` rule read.
 *   8. **The deleted flag is refused by name**, the way `--route=` is refused for the
 *      character-voice stage: a meaningless flag that is silently accepted is a flag that still
 *      means something to the next person who types it.
 *   9. **The flag's name is gone from the repository**, plans included, with a closed allow-list
 *      for the two files that must name it.
 *  10. **The stage asks no setting** whether to open the record: `glossary/task.js` and
 *      `glossary/store.js` carry no store switch, and `configs/shared` exports none.

 * Every scenario runs in a throwaway fixture. Nothing here reads the real 17 volumes or any file
 * under the series folder (AGENTS.md rule 8, gotcha 69). No real model call: scenario 1 goes
 * through the scripted server in `test/fake-backend.js`, exactly as `npm run pipeline-loop` does.
 *
 * Run with `npm test`, or standalone: `node test/test-glossary-store-unconditional.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// The flag under test must be read as a fresh clone reads it: absent. Deleting it here is the
// scenario, not hygiene — a suite that inherited it from a shell would be testing the setting.
delete process.env.GLOSSARY_STORE_VALIDATORS;
delete process.env.STORE_VALIDATORS;

const ROOT = path.resolve(__dirname, "..");
const {
  openVolumeRecord,
  copyForwardStore,
  glossaryRowsInRecord,
  auditVolumeRecord,
  isVolumeSealed,
  DOCUMENT_SOURCE_STAGE,
} = require("../utils/reference-store");
const glossaryStore = require("../glossary/store");
const {
  fixtureStoreSeries,
  assertInsideFixture,
  GLOSSARY_01,
  VOICE_01,
  VOICE_01_MISSING_CHARACTERS,
} = require("./fixture-reference-store");

/** A term the fixture's volume 01 text never prints: the refusal case for rule 1. */
const TERM_NOT_IN_THE_BOOK = { term: "存在しない用語", type: "concept", query: "存在しない用語" };
/** A term it does print, on a known line of `SOURCE_01` ("山田は会計の人である。"). */
const TERM_IN_THE_BOOK = { term: "会計", type: "concept", query: "会計" };

/**
 * Build the context object `glossary/task.js` hands its store glue, for a fixture volume.
 *
 * It is the same shape the stage builds (`values.INSTALLMENT_NUMBER`, `folderName`, `seriesDir`,
 * `previousFolderName`, `bundle`), because the point of these scenarios is that the glue is the
 * stage's own door: a fixture that passed a different shape would be testing a door the stage
 * does not open.
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
    values: { INSTALLMENT_NUMBER: volume.installmentNumber },
    folderName: volume.folder,
    seriesDir: fx.dir,
    previousFolderName: previous ? previous.folder : null,
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
 * Run the glossary stage for real — offline, against the scripted model server — with no store
 * setting in the child's environment, and report what the stage left on disk.
 *
 * `test-pipeline-loop.js` is the only place a task module runs with its own process environment
 * (task modules read `SERIES_LOCATION` at require time), so the honest way to ask "what does the
 * default path do" is to run the default path. `--stages=discover,glossary` keeps it to the two
 * tasks this scenario is about, and `--no-second-pass` keeps it to one pass.
 *
 * @param {string} label - The throwaway output folder name.
 * @returns {{code: number, out: string, seriesDir: string}}
 */
function runGlossaryStageOffline(label) {
  const dir = path.join("/tmp/opencode", label);
  const args = [path.join(ROOT, "test", "test-pipeline-loop.js"), "--stages=discover,glossary", "--no-second-pass", `--dir=${dir}`];
  const env = { ...process.env };
  delete env.GLOSSARY_STORE_VALIDATORS; // the scenario: nothing is set
  const res = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8", timeout: 10 * 60 * 1000 });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  // Each stage runs in its own child process and its console output is captured to its own log
  // (`report/<pass>-<stage>.log`), so the stage's own words are read from there, not from the parent.
  const stageLog = fs.readFileSync(path.join(dir, "report", "pass-1-glossary.log"), "utf8");
  return { code: res.status, out, stageLog, reportDir: path.join(dir, "report"), seriesDir: path.join(dir, "series") };
}

/**
 * Read one number out of a fixture volume's record.
 *
 * These are fixture records under /tmp/opencode, never a corpus record: opening a real
 * `series.db` folds its write-ahead log in and deletes the sidecars (gotcha 124).
 *
 * @param {string} seriesDir
 * @param {string} folder
 * @param {string} sql
 * @returns {Object[]}
 */
function queryFixtureRecord(seriesDir, folder, sql) {
  const { DatabaseSync } = require("node:sqlite");
  const file = path.join(seriesDir, folder, "series.db");
  assert.ok(fs.existsSync(file), `no reference record at ${file}`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/**
 * The default glossary path IS the store path: no setting, and every volume ends published.
 * @returns {void}
 */
function scenarioTheDefaultPathOpensFilesAndSealsTheRecord() {
  const { code, out, stageLog, reportDir, seriesDir } = runGlossaryStageOffline("glossary-store-default");
  assert.strictEqual(code, 0, `the glossary stage failed offline:\n${out.split("\n").slice(-25).join("\n")}`);

  const folders = ["Moonshadow Academy(01)", "Moonshadow Academy(02)"];
  for (const folder of folders) {
    const sealed = queryFixtureRecord(seriesDir, folder, "SELECT key, value FROM store_info WHERE key LIKE 'sealed_volume_%'");
    assert.ok(sealed.length > 0, `${folder}: the glossary stage left no sealed volume — the record was never published`);
    const rows = queryFixtureRecord(seriesDir, folder, "SELECT COUNT(*) AS n FROM facts WHERE aspect = 'term_usage'");
    assert.ok(rows[0].n > 0, `${folder}: the record holds no glossary row, so the stage filed nothing into it`);
  }

  // The second volume is built ON the first one's published record, and the copy is recorded.
  const provenance = queryFixtureRecord(seriesDir, folders[1], "SELECT volume, source_volume, copied_rows FROM copy_provenance");
  assert.ok(provenance.length > 0, "volume 02's record carries no copy provenance: it was not copied forward");
  assert.strictEqual(provenance[0].source_volume, 1, "volume 02's record was not copied from volume 1");
  const carried = queryFixtureRecord(
    seriesDir,
    folders[1],
    "SELECT COUNT(*) AS n FROM facts WHERE owner_volume = 1 AND aspect = 'term_usage'"
  );
  assert.ok(carried[0].n > 0, "volume 02's record holds none of volume 1's glossary rows: the copy lost what the first volume published");

  // The stage said out loud what it did: it queried the record, and it published it.
  assert.ok(
    /deterministic audit/.test(stageLog),
    "the glossary stage never ran the deterministic audit, so the record was never queried"
  );
  assert.ok(
    /reference record sealed by the glossary stage/.test(stageLog),
    "the glossary stage never sealed the record it built"
  );
  assert.ok(
    /reference record mirrors \d+ row/.test(stageLog),
    "the glossary stage never filed its published rows into the record"
  );

  // The validator agent is gone from this path: the report the grader reads is written by a query.
  const wire = JSON.parse(fs.readFileSync(path.join(reportDir, "wire-log.json"), "utf8"));
  const glossaryRequests = wire.filter((e) => e.stage === "glossary");
  const validatorRequests = glossaryRequests.filter((e) => `${e.systemText || ""}\n${e.userText || ""}`.includes("**Glossary Auditor**"));
  assert.strictEqual(validatorRequests.length, 0, `the glossary stage still pays for a validator agent: ${validatorRequests.map((r) => r.index).join(", ")}`);
  assert.ok(glossaryRequests.length > 0, "the glossary stage made no request at all");

  console.log(
    "glossary store unconditional: with nothing set in the environment the glossary stage opens, " +
      "files, audits, grades and seals every volume's record, and volume 02 copies forward from volume 1"
  );
}

// ─── Scenario 2 ───────────────────────────────────────────────────────────────

/**
 * The seal is the end of a volume's pre-production, and a volume the gate did not accept has not
 * reached it. The next volume's copy-forward is what says so.
 * @returns {Promise<void>}
 */
async function scenarioAFailingGradeLeavesTheRecordADraft() {
  const fx = fixtureStoreSeries("glossary-store-draft");
  const { ctx } = openThroughTheStage(fx, 0);
  fs.writeFileSync(ctx.glossaryOutputFile, GLOSSARY_01, "utf8");
  glossaryStore.fileGlossaryExtraction(ctx, [TERM_IN_THE_BOOK]);
  await glossaryStore.mirrorGlossaryArtifact(ctx);
  // The gate did not accept. `sealGlossaryRecord` is the stage's only door to the seal.
  ctx.qaAccepted = false;
  glossaryStore.sealGlossaryRecord(ctx);
  assert.strictEqual(isVolumeSealed(ctx.refStore, 1), false, "a volume the gate did not accept was sealed anyway");
  const sealedRows = ctx.refStore.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE sealed = 1").get().n;
  assert.strictEqual(sealedRows, 0, "and its rows were published anyway");
  ctx.refStore.close();
  ctx.refStore = null;

  const next = glossaryStore.openGlossaryRecord(stageCtx(fx, 1), 1);
  assert.strictEqual(next.ok, false, "the next volume copied forward over a record that was never accepted");
  const kinds = next.opened.findings.map((f) => f.kind);
  assert.ok(kinds.includes("reference-volume-unsealed"), `the refusal does not name the unsealed record: ${JSON.stringify(next.opened)}`);
  const high = next.opened.findings.filter((f) => f.severity === "HIGH" && f.kind === "reference-volume-unsealed");
  assert.ok(high.length > 0, "`reference-volume-unsealed` is not HIGH, so it cannot block a copy-forward");
  assert.ok(/unsealed|not been sealed/i.test(next.error), `the stage-facing error does not say why: ${next.error}`);

  console.log("glossary store unconditional: a failing grade leaves the record a draft, and the next volume's copy-forward refuses it at HIGH");
}

// ─── Scenario 3 ───────────────────────────────────────────────────────────────

/**
 * The same door, with a passing grade: the record is published and the next volume may build on it.
 * @returns {Promise<void>}
 */
async function scenarioAPassingGradePublishesTheRecord() {
  const fx = fixtureStoreSeries("glossary-store-seal");
  const { ctx } = openThroughTheStage(fx, 0);
  fs.writeFileSync(ctx.glossaryOutputFile, GLOSSARY_01, "utf8");
  glossaryStore.fileGlossaryExtraction(ctx, [TERM_IN_THE_BOOK]);
  await glossaryStore.mirrorGlossaryArtifact(ctx);

  ctx.qaAccepted = true;
  glossaryStore.sealGlossaryRecord(ctx);
  assert.strictEqual(isVolumeSealed(ctx.refStore, 1), true, "a volume the gate accepted was not sealed");
  ctx.refStore.close();
  ctx.refStore = null;

  const next = openThroughTheStage(fx, 1);
  const carried = next.ctx.refStore.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE owner_volume = 1 AND aspect = 'term_usage'")
    .get().n;
  assert.ok(carried > 0, "the accepted volume's glossary rows did not reach the next volume's record");
  next.ctx.refStore.close();

  console.log("glossary store unconditional: a passing grade seals the volume, and the next volume copies forward from it");
}

// ─── Scenario 4 ───────────────────────────────────────────────────────────────

/**
 * Plan §2 rule 1, on the stage's own door: a term this volume's text does not print is refused
 * where the stage files it, and it is named.
 * @returns {void}
 */
function scenarioATermTheBookDoesNotPrintIsRefusedAtFiling() {
  const fx = fixtureStoreSeries("glossary-store-refusal");
  const { ctx } = openThroughTheStage(fx, 0);

  const found = glossaryStore.fileGlossaryExtraction(ctx, [TERM_IN_THE_BOOK, TERM_NOT_IN_THE_BOOK]);
  assert.ok(found, "the stage's filing door did not run");
  assert.strictEqual(found.importedCount, 1, `expected the printed term to be filed: ${JSON.stringify(found)}`);
  assert.strictEqual(found.refused.length, 1, `expected exactly one refusal: ${JSON.stringify(found.refused)}`);
  assert.strictEqual(found.refused[0].term, TERM_NOT_IN_THE_BOOK.term, "the refusal does not name the term it refused");

  const filed = ctx.refStore.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE body LIKE ?")
    .get(`%${TERM_NOT_IN_THE_BOOK.term}%`).n;
  assert.strictEqual(filed, 0, "the refused term reached the record anyway");

  ctx.refStore.close();
  console.log("glossary store unconditional: a term the volume's text does not print is refused at filing and named");
}

// ─── Scenario 5 ───────────────────────────────────────────────────────────────

/**
 * Plan §2 rule 4: damage to a reference is a hard stop, with no exception and no downgrade.
 *
 * The planted damage is volume 01's real defect in fixture shape — a character-voice reference that
 * says nothing about two people this volume's extraction filed claims about and its own text names.
 * The glossary stage is the stage that opens the next volume's copy, so it is the stage that has to
 * refuse it. The fixture shape is the one `test/test-reference-store-pipeline.js` proves.
 * @returns {void}
 */
function scenarioDamageToAReferenceIsStillAHardStop() {
  const fx = fixtureStoreSeries("glossary-store-damage");

  // Volume 01 publishes a record whose character-voice half lost the cast.
  const { ctx } = openThroughTheStage(fx, 0);
  fs.writeFileSync(ctx.glossaryOutputFile, GLOSSARY_01, "utf8");
  const writer = ctx.refStore;
  const { importVoice, importVolumeExtraction, recordCastPresence } = require("../utils/reference-store");
  importVoice(writer, VOICE_01_MISSING_CHARACTERS);

  // The extraction pass over the same volume noticed the two the reference lost.
  const filed = importVolumeExtraction({
    volume: 1,
    folder: fx.volumes[0].folder,
    seriesDir: fx.dir,
    voiceEntries: [
      { type: "voice", character: "大賀太陽", quirkType: "catchphrase", description: "Chants it.", examples: ["ドンマイだ！ ドンマイ！"] },
      { type: "voice", character: "三色院菫子", quirkType: "pronoun", description: "She reads.", examples: ["三色院菫子は本を読んでいた。"] },
    ],
  }).voice;
  assert.strictEqual(filed.importedCount, 2, `the extraction claims were not filed: ${JSON.stringify(filed.refused)}`);

  recordCastPresence(writer);
  const audit = writer.integrityFindings({ volume: "01" });
  const high = audit.findings.filter((f) => f.severity === "HIGH" && f.kind === "reference-voice-covers-fewer-characters");
  assert.ok(high.length > 0, `the lost coverage was not reported at HIGH: ${JSON.stringify(audit.findings.map((f) => `${f.severity} ${f.kind}`))}`);
  assert.match(high[0].message, /大賀太陽/, "the finding does not name the character the reference lost");

  glossaryStore.sealGlossaryRecord(Object.assign(ctx, { qaAccepted: true }));
  writer.close();
  ctx.refStore = null;

  // The next volume may not be built on it.
  const next = glossaryStore.openGlossaryRecord(stageCtx(fx, 1), 1);
  assert.strictEqual(next.ok, false, "a record that lost the cast was copied forward");
  assert.ok(
    next.opened.findings.some((f) => f.severity === "HIGH" && f.kind === "reference-voice-covers-fewer-characters"),
    `the copy-forward did not refuse at HIGH: ${JSON.stringify(next.opened.findings.map((f) => `${f.severity} ${f.kind}`))}`
  );
  assert.ok(/not built/i.test(next.error), `the stage-facing error does not stop the volume: ${next.error}`);

  console.log("glossary store unconditional: a reference that lost coverage is HIGH, and the next volume is not built on it");
}

// ─── Scenario 6 ───────────────────────────────────────────────────────────────

/**
 * Plan §2 rule 5: the artifact is cumulative. Whatever the previous volume published is still in
 * the record the next volume builds on, and the next volume's own rows do not replace it.
 * @returns {Promise<void>}
 */
async function scenarioTheRecordStaysCumulative() {
  const fx = fixtureStoreSeries("glossary-store-cumulative");
  const first = openThroughTheStage(fx, 0);
  fs.writeFileSync(first.ctx.glossaryOutputFile, GLOSSARY_01, "utf8");
  await glossaryStore.mirrorGlossaryArtifact(first.ctx);
  const volumeOneRows = glossaryRowsInRecord(first.ctx.refStore, 1);
  assert.ok(volumeOneRows > 0, "volume 1 filed no glossary rows of its own");
  first.ctx.qaAccepted = true;
  glossaryStore.sealGlossaryRecord(first.ctx);
  first.ctx.refStore.close();

  const second = openThroughTheStage(fx, 1);
  const carriedFromOne = glossaryRowsInRecord(second.ctx.refStore, 1);
  assert.strictEqual(carriedFromOne, volumeOneRows, "the copy did not carry volume 1's glossary rows intact");

  fs.writeFileSync(second.ctx.glossaryOutputFile, `${GLOSSARY_01}\n| 会計担当 | The Accounting Person | amended in volume 2 |\n`, "utf8");
  await glossaryStore.mirrorGlossaryArtifact(second.ctx);
  assert.strictEqual(glossaryRowsInRecord(second.ctx.refStore, 1), volumeOneRows, "volume 2's own mirror touched volume 1's published rows");
  second.ctx.qaAccepted = true;
  glossaryStore.sealGlossaryRecord(second.ctx);
  second.ctx.refStore.close();

  console.log(`glossary store unconditional: volume 2's record still holds all ${volumeOneRows} of volume 1's glossary rows next to its own`);
}

// ─── Scenario 7 ───────────────────────────────────────────────────────────────

/**
 * Plan §2 rule 6: the acceptance gate keeps its shape. The deterministic audit writes the report
 * the grader reads, under the same name, with the same `**Recommendation:**` line — which is what
 * `test/prompt-audit.js`'s `acceptance-context` rule and the delivery layer both read.
 * @returns {void}
 */
async function scenarioTheAcceptanceGateKeepsItsShape() {
  const fx = fixtureStoreSeries("glossary-store-gate");
  const { ctx } = openThroughTheStage(fx, 0);
  fs.writeFileSync(ctx.glossaryOutputFile, GLOSSARY_01, "utf8");
  glossaryStore.mirrorGlossaryArtifact(ctx);

  const audit = await glossaryStore.auditGlossaryArtifact(ctx);
  assert.ok(audit, "the deterministic audit did not run");
  await fs.promises.writeFile(ctx.validationOutputFile, audit.markdown, "utf8");

  const written = await fs.promises.readFile(ctx.validationOutputFile, "utf8");
  assert.ok(/Recommendation:\*\*/.test(written), "the report has no `**Recommendation:**` line for the grader to read");
  assert.ok(/Glossary/.test(written), "the report does not name the artifact it judges");
  assert.ok(audit.checked > 0, "the audit re-checked no citation, so it did not read the book");
  assert.strictEqual(path.basename(ctx.validationOutputFile), "glossary-validation.md", "the report file is no longer the one the loop reads");

  const sample = await glossaryStore.glossaryGradeSample(ctx);
  assert.ok(sample && sample.length > 0, "the grader was shown no sample of the artifact");
  assert.ok(sample.includes(GLOSSARY_01.split("\n").find((l) => l.startsWith("| 会計担当")).trim()), "the sample does not contain the artifact's own rows");

  ctx.refStore.close();
  console.log("glossary store unconditional: the deterministic audit writes glossary-validation.md with its Recommendation line, and the grader is shown a sample of the artifact");
}

// ─── Scenario 8 ───────────────────────────────────────────────────────────────

/**
 * A flag that means nothing is refused, not ignored — the way `--route=` is refused for the
 * character-voice stage. Somebody typing the old flag has to be told what replaced it.
 * @returns {void}
 */
function scenarioTheDeletedFlagIsRefusedByName() {
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, "test", "test-pipeline-loop.js"), "--store-validators", "--stages=discover"],
    { cwd: ROOT, encoding: "utf8", timeout: 60000 }
  );
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  assert.notStrictEqual(res.status, 0, "`--store-validators` was accepted, so it still looks like a setting");
  assert.ok(/store-validators/.test(out), `the refusal does not name the flag it refused:\n${out}`);
  assert.ok(
    /unconditional|no longer a setting|removed/i.test(out),
    `the refusal does not say what replaced the flag:\n${out}`
  );

  console.log("glossary store unconditional: --store-validators is refused with a message naming what replaced it");
}

// ─── Scenario 9 ───────────────────────────────────────────────────────────────

/**
 * The files that may still carry the deleted setting's name, each with the reason it is allowed.
 *
 * This is a closed list, not a filter: a third file carrying the name fails the suite.
 *
 * - **this suite** — it refuses the old flag on the command line and asserts the name is gone, so it
 *   has to be able to write the name down in order to look for it;
 * - **`AGENTS.md`** — the index is the conductor's own file (AGENTS.md §7: the conductor writes the
 *   index, a build session does not), so the table row that used to describe the setting is edited
 *   above this suite. The walk still prints what it finds there on every run, so a row that stays
 *   stale is visible rather than quietly tolerated.
 *
 * @type {Map<string, string>}
 */
const FLAG_NAME_ALLOWED_IN = new Map([
  ["test/test-glossary-store-unconditional.js", "the suite that refuses the old flag has to name it"],
  ["AGENTS.md", "the index is written by the conductor, not by a build session (AGENTS.md §7)"],
]);

/**
 * The name is gone from the repository, plans of record included: a passing reference in a plan is
 * still a name somebody can set.
 * @returns {void}
 */
function scenarioTheFlagNameIsGoneFromTheRepository() {
  const banned = "GLOSSARY_STORE_VALIDATORS";
  const skip = new Set(["node_modules", ".git", "dry-run"]);
  const hits = [];
  /**
   * Walk the repository's own text files.
   * @param {string} dir
   * @returns {void}
   */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|json|md|cjs|mjs|txt|example)$/i.test(entry.name)) continue;
      const text = fs.readFileSync(full, "utf8");
      if (!text.includes(banned)) continue;
      const rel = path.relative(ROOT, full);
      const lines = text.split("\n").filter((l) => l.includes(banned)).length;
      hits.push({ rel, lines });
    }
  };
  walk(ROOT);

  const offenders = hits.filter((h) => !FLAG_NAME_ALLOWED_IN.has(h.rel));
  assert.deepStrictEqual(
    offenders.map((h) => `${h.rel} (${h.lines} line(s))`),
    [],
    `the deleted setting's name is still in the repository:\n${offenders.map((h) => `${h.rel} (${h.lines} line(s))`).join("\n")}`
  );
  for (const rel of FLAG_NAME_ALLOWED_IN.keys()) {
    const hit = hits.find((h) => h.rel === rel);
    if (hit) console.log(`glossary store unconditional: ${rel} still names the deleted setting (${hit.lines} line(s)) — allowed because ${FLAG_NAME_ALLOWED_IN.get(rel)}`);
  }

  const shared = require("../configs/shared");
  assert.strictEqual(shared.STORE_VALIDATORS, undefined, "`STORE_VALIDATORS` is still exported from configs/shared");

  console.log("glossary store unconditional: GLOSSARY_STORE_VALIDATORS appears nowhere in the repository but the two files named above, and configs/shared no longer exports a store switch");
}

// ─── Scenario 10 ──────────────────────────────────────────────────────────────

/**
 * The stage's own source no longer asks a setting whether to reach the record.
 *
 * This is the narrowest possible pin of "unconditional": the door is not behind a branch. It reads
 * the module LAYER (`glossary/task.js` plus `glossary/`), because a guarantee about a split module
 * that scans only the face reports a wiring that exists as a missing one.
 * @returns {void}
 */
function scenarioTheStageAsksNoSettingWhetherToOpenTheRecord() {
  const { readModuleLayer } = require("./module-layer");
  const layer = readModuleLayer(ROOT, "glossary/task.js", "glossary");
  assert.ok(/openGlossaryRecord\(/.test(layer), "the glossary stage no longer opens the volume's record at all");
  assert.ok(!/STORE_VALIDATORS/.test(layer), "the glossary stage still gates its store block behind a setting");
  assert.ok(/sealGlossaryRecord\(/.test(layer), "the glossary stage no longer seals the volume at the end of its work on it");

  console.log("glossary store unconditional: glossary/task.js opens and seals the record with no setting in front of it");
}

async function main() {
  await scenarioTheDefaultPathOpensFilesAndSealsTheRecord();
  await scenarioAFailingGradeLeavesTheRecordADraft();
  await scenarioAPassingGradePublishesTheRecord();
  await scenarioATermTheBookDoesNotPrintIsRefusedAtFiling();
  await scenarioDamageToAReferenceIsStillAHardStop();
  await scenarioTheRecordStaysCumulative();
  await scenarioTheAcceptanceGateKeepsItsShape();
  await scenarioTheDeletedFlagIsRefusedByName();
  await scenarioTheFlagNameIsGoneFromTheRepository();
  await scenarioTheStageAsksNoSettingWhetherToOpenTheRecord();
  console.log("\nOK: the glossary stage's reference record is unconditional, and the flag that used to switch it on is gone.");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});

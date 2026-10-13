#!/usr/bin/env node
/**
 * test/test-glossary-revisions.js — a later volume **revises** a rendering an earlier volume published,
 * and the revision is an act the record can show.
 *
 * `glossary/plan/01-glossary-route.md` §8 records what the render route could not do: once the published
 * `glossary.md` is rendered out of the record, **no later volume can improve a term the record already
 * holds**. `documentTermAlreadyStored` skipped every term the previous volume published, the store's
 * supersede door was never called from the glossary route, and the measured consequence on the last real
 * 17-volume run was 504 re-listed terms and exactly **2** renderings that ever changed — both of them
 * silently, in volume 11, with nothing on disk saying which volume decided what or why.
 *
 * This suite pins the feature that closes that, and the guards that keep it from becoming a rewrite door:
 *
 *   1. **The door files one replacement row and refuses four proposals**, and the row it replaces survives
 *      byte-identical except its `status`. A sealed row is never edited (AGENTS.md rule 5), so the change
 *      is a NEW row that `supersedes` the old one. The refusals are the load-bearing half: a revision
 *      justified by the previous glossary's own row rather than by a line this volume's book prints is
 *      refused, not filed with a warning.
 *   2. **`markSuperseded` refuses an unattributed supersession.** The attribution IS a successor row owned
 *      by the volume and stage named — not a timestamp, not a claim in a message. A published row cannot
 *      be marked superseded out of nowhere.
 *   3. **"In force at volume V" is bounded by V**, for a term's first row as much as for its replacements.
 *      Rendering volume 1 out of a record that has reached volume 2 reproduces volume 1's published file
 *      **byte for byte**, and does not print a term volume 1 never saw. The same record renders volume 2's
 *      file byte for byte, in a fresh process, twice.
 *   4. **One revision per term per volume.** The chapter-by-chapter route asks every chapter the same
 *      question; the second and later proposals are reported as already settled and file nothing.
 *   5. **The cumulative gate carries a revised term and still stops a planted loss** (AGENTS.md rule 5).
 *      A revision is not a loss, and the guard has to know that without being weakened.
 *   6. **The translation stage's terminology law holds one pair per term.** The superseded rendering lives
 *      in the Notes cell; a file that put it in the rendering column, or that carried two rows for one
 *      term, is reported rather than silently decided.
 *   7. **The answer carries two lists and the report names both.** `parseTermAnswer` reads the envelope and
 *      the bare array, and `revisionReport` puts the filed table and every refusal into the report the
 *      acceptance grader already reads.
 *
 * Every scenario runs in a throwaway fixture under the fixture root. Nothing here reads the real 17 volumes
 * or any file under the series folder (AGENTS.md rule 8, gotcha 69), and no scenario makes a model call:
 * the door, the query, the render, the gate and the report are all deterministic. No scenario opens a
 * volume's own `series.db` with a client — the fixture store is opened through the store's own door
 * (gotcha 124).
 *
 * Run with `npm test`, or standalone: `node test/test-glossary-revisions.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const {
  renderGlossary,
  publishedGlossaryRowsInRecord,
  glossaryRowInForceForTerm,
  fileGlossaryRevision,
  importGlossaryRevisions,
  markSuperseded,
  supersededBy,
  updateOwnFact,
  revisionHistoryFragment,
  mergeRevisionHistory,
  findQuoteEvidence,
  isVolumeSealed,
  DOCUMENT_SOURCE_STAGE,
} = require("../utils/reference-store");
const glossaryStore = require("../glossary/store");
const { parseTermAnswer, parseTerms } = require("../glossary/extract");
const { assertGlossaryCarryForward, compareGlossaryCarryForward } = require("../glossary");
const { parseGlossaryTerms, GLOSSARY_HISTORY_PREFIX } = require("../utils/translate");
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

// ─── The fixture's terms and revisions ────────────────────────────────────────

/** Volume 01's text prints it in ch1: 「如月雨露は「気にすんな！」と言った。」 */
const ROW_KISARAGI = {
  term: "如月雨露",
  rendering: "Kisaragi Amatsuyu",
  note: "The narrator; first person is 俺.",
  type: "character",
  query: "如月雨露",
};
/** Volume 01's text prints it in ch0: 「大賀太陽は笑った。」 */
const ROW_OGA = { term: "大賀太陽", rendering: "Oga Taiyo", note: "Best friend since junior high.", type: "character", query: "大賀太陽" };
/** Volume 01's text prints it in ch0: 「担任の教師は黒板を叩いた。」 */
const ROW_BOARD = { term: "黒板", rendering: "Blackboard", note: "The teacher hits it.", type: "item", query: "黒板" };
/** Only volume 02's text prints it: 「駱駝はあとがきに書いた。」 */
const ROW_CAMEL = { term: "駱駝", rendering: "The Camel", note: "Writes the afterword.", type: "concept", query: "駱駝" };

/** A line volume 02's own source prints (its ch0 line 2). */
const QUOTE_IN_VOLUME_TWO = "如月雨露は「気にすんな！」と言った。";
/** A line ONLY volume 01's source prints (its ch0 line 4) — the planted unjustified revision. */
const QUOTE_ONLY_IN_VOLUME_ONE = "大賀太陽は笑った。";

/** The one proposal this fixture is entitled to file: volume 2's own book carries the evidence. */
const REVISION_JUSTIFIED = {
  term: "如月雨露",
  rendering: "Amatsuyu Kisaragi",
  note: "Volume 2's afterword gives the family name first.",
  quote: QUOTE_IN_VOLUME_TWO,
  reason: "The afterword signs him family-name first, and the narration never contradicts it.",
};
/** The planted one: a real term, a nicer rendering, and a quote this volume's book does not print. */
const REVISION_UNJUSTIFIED = {
  term: "大賀太陽",
  rendering: "Taiyo Oga",
  note: "Western name order reads better.",
  quote: QUOTE_ONLY_IN_VOLUME_ONE,
  reason: "sounds more natural in English",
};
/** A revision of a term the record has no row for: that is a new term, and `terms` is the door for it. */
const REVISION_UNKNOWN_TERM = {
  term: "存在しない用語",
  rendering: "A Term Nobody Published",
  note: "nothing",
  quote: "駱駝はあとがきに書いた。",
  reason: "planted",
};
/** A complaint rather than a replacement. */
const REVISION_WITHOUT_A_RENDERING = {
  term: "駱駝",
  rendering: "",
  note: "the old one is wrong",
  quote: "駱駝はあとがきに書いた。",
  reason: "planted",
};
/** A revision that does not say which term it is about. */
const REVISION_WITHOUT_A_TERM = {
  term: "",
  rendering: "No Term At All",
  note: "nothing",
  quote: QUOTE_IN_VOLUME_TWO,
  reason: "planted",
};

/** Every proposal at once, so one call exercises the filed half and all four refusals. */
const ALL_PROPOSALS = [
  REVISION_JUSTIFIED,
  REVISION_UNJUSTIFIED,
  REVISION_UNKNOWN_TERM,
  REVISION_WITHOUT_A_RENDERING,
  REVISION_WITHOUT_A_TERM,
];

/** The columns of a stored row a revision must NOT touch (`status` and `updated_at` are the two it may). */
const IMMUTABLE_COLUMNS = [
  "id",
  "key",
  "aspect",
  "label",
  "section",
  "body",
  "examples",
  "formality",
  "evidence",
  "established_volume",
  "established_chapter",
  "applies_from_volume",
  "applies_to_volume",
  "confidence",
  "owner_volume",
  "owner_stage",
  "sealed",
  "ord",
  "supersedes",
];

/**
 * Build the context object `glossary/task.js` hands its store glue, for a fixture volume.
 *
 * Same shape as `test/test-glossary-render-route.js`: the point of these scenarios is that the doors under
 * test are the ones the stage itself opens.
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

/**
 * Build volume 01's record, publish its glossary, and seal it — the state a later volume revises.
 *
 * @param {Object} fx
 * @returns {Promise<{ctx: Object, file: string, rows: number}>}
 */
async function buildVolumeOne(fx) {
  const { ctx } = openThroughTheStage(fx, 0);
  const filed = glossaryStore.fileGlossaryTermRows(ctx, [ROW_KISARAGI, ROW_OGA, ROW_BOARD]);
  assert.strictEqual(filed.importedCount, 3, `volume 1 filed ${filed.importedCount} rows: ${JSON.stringify(filed.refused)}`);
  const rendered = await glossaryStore.renderGlossaryArtifact(ctx);
  assert.ok(rendered.ok, `volume 1's render refused: ${JSON.stringify(rendered.refusal)}`);
  ctx.qaAccepted = true;
  glossaryStore.sealGlossaryRecord(ctx);
  const file = fs.readFileSync(ctx.glossaryOutputFile, "utf8");
  return { ctx, file, rows: rendered.rows };
}

/**
 * The title block the stage hands the renderer for one fixture volume.
 *
 * The renderer's opening lines are a fallback argument, not stored rows, so reproducing a volume's file
 * means passing that volume's own block.
 *
 * @param {string} installment - `01` or `02`.
 * @returns {string}
 */
function titleFor(installment) {
  return glossaryStore.glossaryTitleBlock({
    SOURCE_NAME: "Test Story",
    SOURCE_LANGUAGE: "Japanese",
    TARGET_LANGUAGE: "English",
    INSTALLMENT_NUMBER: installment,
  });
}

/**
 * Read one stored row, as the database holds it.
 *
 * @param {Object} store - The open record.
 * @param {string} id
 * @returns {Object|null} The whole row, so a scenario can name `status` and compare `IMMUTABLE_COLUMNS`.
 */
function rowColumns(store, id) {
  return store.db.prepare("SELECT * FROM facts WHERE id = ?").get(id) || null;
}

/**
 * How many published glossary rows a record holds, superseded ones included.
 *
 * @param {Object} store
 * @returns {number}
 */
function publishedRowCount(store) {
  return store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE aspect = 'term_usage' AND source_stage != 'extract'")
    .get().n;
}

// ─── Scenario 1 ───────────────────────────────────────────────────────────────

/**
 * The door files one replacement row, refuses four proposals, and never edits the row it replaces.
 * @returns {Promise<void>}
 */
async function scenarioTheDoorFilesOneRevisionAndRefusesFour() {
  const fx = fixtureStoreSeries("glossary-revisions-door");
  const one = await buildVolumeOne(fx);
  const targetId = glossaryRowInForceForTerm(one.ctx.refStore, ROW_KISARAGI.term, 1).id;
  const before = rowColumns(one.ctx.refStore, targetId);
  ok(before.status === "active", `volume 1's row starts in the ${before.status} state`);
  ok(before.sealed === 1, "volume 1's row is not sealed, so this scenario would not be testing a published row");
  one.ctx.refStore.close();

  const two = openThroughTheStage(fx, 1);
  glossaryStore.fileGlossaryTermRows(two.ctx, [ROW_CAMEL]);
  const rowsBefore = publishedRowCount(two.ctx.refStore);

  const report = glossaryStore.fileGlossaryRevisions(two.ctx, ALL_PROPOSALS);
  same(report.filed.length, 1, `one revision should have been filed: ${JSON.stringify(report.refused)}`);
  same(report.replaced.length, 1, "the filing does not name the row it replaced");
  same(report.replaced[0].id, targetId, "the row it names as replaced is not the row volume 1 published");
  same(report.replaced[0].appliesFromVolume, 1, "the replaced rendering is not attributed to the volume that published it");
  same(report.alreadyFiled, [], "a first filing reports an already-settled term");
  same(
    report.refused.map((item) => [item.term, item.rule]),
    [
      [REVISION_UNJUSTIFIED.term, "revision-quote-not-in-source"],
      [REVISION_UNKNOWN_TERM.term, "revision-of-unknown-term"],
      [REVISION_WITHOUT_A_RENDERING.term, "revision-has-no-rendering"],
      [REVISION_WITHOUT_A_TERM.term, "revision-has-no-term"],
    ],
    `the refusals are not the four this scenario plants: ${JSON.stringify(report.refused.map((r) => [r.term, r.rule]))}`
  );
  ok(
    /no line of volume 2's source text contains it/.test(report.refused[0].because),
    `the quote refusal does not say what it checked: ${report.refused[0].because}`
  );
  ok(report.ok === false, "a batch with a refusal in it reports itself clean");

  // The replaced row: status is the only column that moved.
  const after = rowColumns(two.ctx.refStore, targetId);
  /**
   * The columns a scenario compares, out of a whole row.
   * @param {Object} row
   * @returns {Object}
   */
  const pick = (row) => Object.fromEntries(IMMUTABLE_COLUMNS.map((column) => [column, row[column]]));
  for (const column of IMMUTABLE_COLUMNS) {
    same(after[column], before[column], `the revision touched "${column}" on the row it replaced`);
  }
  ok(after.status === "superseded", `the replaced row is marked ${after.status}`);
  ok(after.sealed === 1, "the replaced row lost its seal, which is an edit to a published row");

  // The replacement is a row of its own, owned by the volume that filed it, citing this volume's line.
  same(publishedRowCount(two.ctx.refStore), rowsBefore + 1, "the revision did not add exactly one row");
  const replacement = two.ctx.refStore.db
    .prepare("SELECT * FROM facts WHERE supersedes = ?")
    .get(targetId);
  ok(replacement, "no row in the record supersedes the row the report says was replaced");
  same(JSON.parse(replacement.examples), [ROW_KISARAGI.term, REVISION_JUSTIFIED.rendering], "the replacement row's term/rendering pair is not what was proposed");
  same(replacement.owner_volume, 2, "the replacement row is not owned by the volume that filed it");
  same(replacement.owner_stage, DOCUMENT_SOURCE_STAGE, "the replacement row is not a document row, so the render would not print it");
  same(replacement.applies_from_volume, 2, "the replacement row does not say it applies from this volume");
  same(replacement.established_volume, 2, "the replacement row does not say this volume established it");
  same(replacement.sealed, 0, "a row filed this moment is already sealed");
  const evidence = JSON.parse(replacement.evidence);
  same(evidence.length, 1, `the replacement cites ${evidence.length} line(s)`);
  same([evidence[0].volume, evidence[0].chapter], [2, "ch0"], `the replacement cites volume ${evidence[0].volume} chapter ${evidence[0].chapter}`);
  ok(evidence[0].quote === QUOTE_IN_VOLUME_TWO, `the replacement cites "${evidence[0].quote}", not the line the answer quoted`);

  // The refused term keeps the rendering it already had, and the record still holds one row for it.
  const oga = glossaryRowInForceForTerm(two.ctx.refStore, ROW_OGA.term, 2);
  same(oga.rendering, ROW_OGA.rendering, "a refused revision changed the term's rendering");
  same(oga.superseded, [], "a refused revision filed a chain anyway");

  // The store's own edit door still cannot touch the superseded published row.
  const attempted = updateOwnFact(two.ctx.refStore, targetId, { body: "rewritten by the volume that replaced it" });
  ok(!attempted.ok, "updateOwnFact edited a row another volume owns and published");
  same(attempted.changed, 0, `the refused edit still changed ${attempted.changed} row(s)`);
  same(rowColumns(two.ctx.refStore, targetId), after, "the refused edit touched the row it refused to touch");

  two.ctx.refStore.close();
  console.log(
    "glossary revisions: 1 filed and 4 refused; the replaced row survives with every column but `status` " +
      "identical, and the replacement cites volume 2's own line"
  );
}

// ─── Scenario 2 ───────────────────────────────────────────────────────────────

/**
 * `markSuperseded` refuses to mark a published row superseded when no replacement row stands behind it.
 * @returns {Promise<void>}
 */
async function scenarioMarkSupersededRefusesAnUnattributedSupersession() {
  const fx = fixtureStoreSeries("glossary-revisions-attribution");
  const one = await buildVolumeOne(fx);
  const targetId = glossaryRowInForceForTerm(one.ctx.refStore, ROW_KISARAGI.term, 1).id;
  one.ctx.refStore.close();

  const two = openThroughTheStage(fx, 1);
  const store = two.ctx.refStore;

  const noSuccessor = markSuperseded(store, targetId, { byVolume: 2, byStage: DOCUMENT_SOURCE_STAGE });
  ok(!noSuccessor.ok, "a published row was marked superseded with nothing replacing it");
  same(noSuccessor.refusal.rule, "supersede-needs-a-successor", `the refusal is "${noSuccessor.refusal.rule}" instead of naming the missing successor`);
  same(noSuccessor.changed, 0, `the refused mark changed ${noSuccessor.changed} row(s)`);
  same(rowColumns(store, targetId).status, "active", "the refused mark still moved the row's status");
  ok(noSuccessor.refusal.useInstead.some((entry) => entry.startsWith("insert_fact")), "the refusal does not name the legal door");

  const unknown = markSuperseded(store, "v09-ch0-999", { byVolume: 2, byStage: DOCUMENT_SOURCE_STAGE });
  ok(!unknown.ok && unknown.refusal.rule === "unknown-fact", "markSuperseded invented a row it was asked to supersede");

  const noAttribution = markSuperseded(store, targetId, { byVolume: 2 });
  ok(!noAttribution.ok && noAttribution.refusal.rule === "supersede-needs-attribution", "markSuperseded acted without being told which stage did it");
  same(rowColumns(store, targetId).status, "active", "the refused unattributed mark moved the status anyway");

  // File the replacement through the door, and the same call becomes a no-op that says so.
  const filed = fileGlossaryRevision(store, REVISION_JUSTIFIED, { volume: 2 });
  ok(filed.ok, `the revision refused: ${JSON.stringify(filed.refusal)}`);
  const successors = supersededBy(store, targetId);
  same(successors.length, 1, `supersededBy names ${successors.length} replacement row(s)`);
  same(successors[0].id, filed.filed.id, "supersededBy names a different row than the one the door filed");

  const again = markSuperseded(store, targetId, { byVolume: 2, byStage: DOCUMENT_SOURCE_STAGE });
  ok(again.ok, `the second mark refused: ${JSON.stringify(again.refusal)}`);
  ok(again.alreadySuperseded, "the second mark pretends it did something");
  same(again.changed, 0, `the idempotent mark changed ${again.changed} row(s)`);

  // The door's own transaction: a replacement row whose predecessor was never marked is not left behind.
  const halfFiled = store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE aspect = 'term_usage' AND source_stage != 'extract' AND status = 'active' AND supersedes IS NOT NULL")
    .get().n;
  same(halfFiled, 1, `${halfFiled} live row(s) supersede a row that was never marked — the transaction left half an act`);

  store.close();
  console.log("glossary revisions: markSuperseded refuses an unattributed supersession, and the attribution is the successor row itself");
}

// ─── Scenario 3 ───────────────────────────────────────────────────────────────

/**
 * Render one fixture volume's record in a fresh child process and report the bytes' sha256.
 *
 * @param {{dir: string, folder: string, installmentNumber: string}} volume
 * @param {string} renderAt - The volume to render the record AS.
 * @param {string} titleFor - The installment whose title block to use.
 * @returns {string} The hash of the rendered document.
 */
function renderInAFreshProcess(volume, renderAt, titleFor) {
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
    `  volume: ${JSON.stringify(renderAt)},`,
    "  title: glossaryTitleBlock({",
    '    SOURCE_NAME: "Test Story",',
    '    SOURCE_LANGUAGE: "Japanese",',
    '    TARGET_LANGUAGE: "English",',
    `    INSTALLMENT_NUMBER: ${JSON.stringify(titleFor)},`,
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
 * "In force at volume V" is bounded by V, and a record that reached volume 2 still prints volume 1's file.
 * @returns {Promise<void>}
 */
async function scenarioInForceAtVolumeIsBoundedByThatVolume() {
  const fx = fixtureStoreSeries("glossary-revisions-in-force");
  const one = await buildVolumeOne(fx);
  const fileOne = one.file;
  one.ctx.refStore.close();

  const two = openThroughTheStage(fx, 1);
  glossaryStore.fileGlossaryTermRows(two.ctx, [ROW_CAMEL]);
  const filed = glossaryStore.fileGlossaryRevisions(two.ctx, [REVISION_JUSTIFIED]);
  ok(filed.filed.length === 1, `the revision refused: ${JSON.stringify(filed.refused)}`);
  const renderedTwo = await glossaryStore.renderGlossaryArtifact(two.ctx);
  ok(renderedTwo.ok, `volume 2's render refused: ${JSON.stringify(renderedTwo.refusal)}`);
  const fileTwo = fs.readFileSync(two.ctx.glossaryOutputFile, "utf8");
  const store = two.ctx.refStore;

  // The rows in force at each volume.
  const atOne = publishedGlossaryRowsInRecord(store, { volume: 1 });
  const atTwo = publishedGlossaryRowsInRecord(store, { volume: 2 });
  const atThree = publishedGlossaryRowsInRecord(store, { volume: 3 });
  same(atOne.map((row) => row.term), [ROW_KISARAGI.term, ROW_OGA.term, ROW_BOARD.term], "volume 1's glossary is not the three terms volume 1 published");
  ok(!atOne.some((row) => row.term === ROW_CAMEL.term), "volume 1's glossary prints a term volume 2 introduced");
  same(atTwo.length, 4, `volume 2's glossary holds ${atTwo.length} rows`);
  same(atThree.length, 4, "a volume past the record's own loses the revision");

  const kisaragiAtOne = glossaryRowInForceForTerm(store, ROW_KISARAGI.term, 1);
  const kisaragiAtTwo = glossaryRowInForceForTerm(store, ROW_KISARAGI.term, 2);
  same(kisaragiAtOne.rendering, ROW_KISARAGI.rendering, "volume 1's in-force rendering was rewritten by volume 2's decision");
  same(kisaragiAtOne.superseded, [], "volume 1's row reports a supersession that had not happened yet");
  same(kisaragiAtTwo.rendering, REVISION_JUSTIFIED.rendering, "volume 2's in-force rendering is not the one volume 2 filed");
  same(kisaragiAtTwo.superseded.map((row) => [row.rendering, row.appliesFromVolume]), [[ROW_KISARAGI.rendering, 1]], "the superseded half does not name the old rendering and the volume it was in force from");
  same(kisaragiAtTwo.ord, kisaragiAtOne.ord, "the revised term moved position in the document");

  // The file volume 1 published, reproduced out of the record that has moved on.
  const reproduced = renderGlossary(store, { volume: 1, title: titleFor("01") });
  ok(reproduced === fileOne, "rendering volume 1 out of volume 2's record does not reproduce volume 1's published file");
  ok(!reproduced.includes(GLOSSARY_HISTORY_PREFIX), "the reproduction of volume 1's file carries a history line volume 1 never had");
  ok(reproduced.includes(`| ${ROW_KISARAGI.term} | ${ROW_KISARAGI.rendering} |`), "the reproduction lost volume 1's rendering");

  // And volume 2's own file, out of the same record.
  const renderedAtTwo = renderGlossary(store, { volume: 2, title: titleFor("02") });
  ok(renderedAtTwo === fileTwo, "the record does not render the file the stage published");
  const history = revisionHistoryFragment({ rendering: ROW_KISARAGI.rendering, appliesFromVolume: 1 });
  ok(fileTwo.includes(history), `volume 2's file does not carry "${history}"`);
  ok(!fileTwo.includes(`| ${ROW_KISARAGI.term} | ${ROW_KISARAGI.rendering} |`), "the superseded rendering is still printed as the term's rendering");
  const revisedRows = fileTwo.split("\n").filter((line) => line.startsWith(`| ${ROW_KISARAGI.term} |`));
  same(revisedRows.length, 1, `the revised term is printed in ${revisedRows.length} table rows — the file prints the argument, not its outcome`);

  // Determinism, in a fresh process, twice, for both volumes.
  const hashVolume = (renderAt, title) => crypto.createHash("sha256").update(renderGlossary(store, { volume: renderAt, title: titleFor(title) }), "utf8").digest("hex");
  const childOne = renderInAFreshProcess({ ...fx.volumes[1], dir: fx.dir }, "02", "02");
  const childTwo = renderInAFreshProcess({ ...fx.volumes[1], dir: fx.dir }, "02", "02");
  ok(/^[0-9a-f]{64}$/.test(childOne), `the fresh-process render printed nothing usable: ${childOne}`);
  same(childTwo, childOne, "the same record rendered to different bytes in a fresh process — the history line is not pinned to stored columns");
  same(childOne, hashVolume(2, "02"), "the fresh-process render is not the document this process renders");
  same(hashVolume(2, "02"), crypto.createHash("sha256").update(fileTwo, "utf8").digest("hex"), "the published file is not the document the record renders");
  same(hashVolume(1, "01"), crypto.createHash("sha256").update(fileOne, "utf8").digest("hex"), "the reproduction of volume 1 is not byte-stable");

  // The merge is idempotent: a published file read back into a record does not stack a second history line.
  const once = mergeRevisionHistory("A note.", [{ rendering: "Old", appliesFromVolume: 1 }], { rendering: "New" });
  const twice = mergeRevisionHistory(once, [{ rendering: "Old", appliesFromVolume: 1 }], { rendering: "New" });
  same(twice, once, "re-rendering stacks a second copy of the same history line");
  same(mergeRevisionHistory("A note.", [{ rendering: "New", appliesFromVolume: 1 }], { rendering: "New" }), "A note.", "the file claims a change the revision did not make");
  same(mergeRevisionHistory("", [{ rendering: "Old", appliesFromVolume: 3 }], { rendering: "New" }), revisionHistoryFragment({ rendering: "Old", appliesFromVolume: 3 }), "a row with no note of its own loses the history line entirely");

  store.close();
  console.log(
    `glossary revisions: volume 1's published file is reproduced byte for byte out of a record that reached ` +
      `volume 2 (${crypto.createHash("sha256").update(fileOne, "utf8").digest("hex").slice(0, 12)}…), volume 2's ` +
      `term prints one row with "${GLOSSARY_HISTORY_PREFIX}" in its Notes cell`
  );
}

// ─── Scenario 4 ───────────────────────────────────────────────────────────────

/**
 * One revision per term per volume: the chapter-by-chapter route asks every chapter the same question.
 * @returns {Promise<void>}
 */
async function scenarioTheSameRevisionIsFiledOnce() {
  const fx = fixtureStoreSeries("glossary-revisions-idempotence");
  const one = await buildVolumeOne(fx);
  one.ctx.refStore.close();

  const two = openThroughTheStage(fx, 1);
  const store = two.ctx.refStore;
  const rowsBefore = publishedRowCount(store);

  const first = glossaryStore.fileGlossaryRevisions(two.ctx, [REVISION_JUSTIFIED]);
  same(first.filed.length, 1, "the first filing did not file");
  const second = glossaryStore.fileGlossaryRevisions(two.ctx, [REVISION_JUSTIFIED]);
  same(second.filed.length, 0, "the second filing filed the same revision again");
  same(second.alreadyFiled, [REVISION_JUSTIFIED.term], "the second filing does not report the term as already settled");
  same(second.refused, [], "the second filing refused a proposal it had already accepted");
  same(publishedRowCount(store), rowsBefore + 1, `the record holds ${publishedRowCount(store) - rowsBefore} extra row(s) after two filings`);

  // The accumulation the chapter-by-chapter route needs: the report describes the whole volume.
  const accumulated = two.ctx.storeRevisions;
  same(accumulated.filed.length, 1, "the accumulated report lost the revision that landed in the first chapter");
  same(accumulated.alreadyFiled.length, 1, "the accumulated report lost the already-settled term");
  const block = glossaryStore.revisionReport(accumulated, { volume: "02" });
  ok(/already settled by this volume's own revision and were not filed twice/.test(block), `the report does not say the term was settled: ${block}`);

  // A different rendering for the same term is a second revision, not an idempotent repeat.
  const third = fileGlossaryRevision(store, { ...REVISION_JUSTIFIED, rendering: "Amatsuyu-kun" }, { volume: 2 });
  ok(third.ok, `the second revision of the same term refused: ${JSON.stringify(third.refusal)}`);
  same(publishedRowCount(store), rowsBefore + 2, "a chain of two revisions in one volume is not two rows");
  const inForce = glossaryRowInForceForTerm(store, ROW_KISARAGI.term, 2);
  same(inForce.rendering, "Amatsuyu-kun", "the last revision filed is not the one in force");
  same(inForce.superseded.map((row) => row.rendering), [ROW_KISARAGI.rendering, REVISION_JUSTIFIED.rendering], "the chain collapses out of order");
  same(inForce.ord, glossaryRowInForceForTerm(store, ROW_KISARAGI.term, 1).ord, "a two-step chain moved the term's position");
  const atOne = glossaryRowInForceForTerm(store, ROW_KISARAGI.term, 1);
  same(atOne.rendering, ROW_KISARAGI.rendering, "a chain filed at volume 2 rewrote volume 1's rendering");

  // Re-running the volume over the same text files nothing again — and, asked against the whole chain,
  // it does not flip the term back to the rendering the second proposal replaced.
  const again = importGlossaryRevisions(store, ALL_PROPOSALS);
  same(again.filed.length, 0, `a re-run filed ${again.filed.length} revision(s) over the same text`);
  same(again.alreadyFiled, [REVISION_JUSTIFIED.term], "the re-run does not report the settled term");
  same(again.refused.length, 4, `the re-run refused ${again.refused.length} proposals instead of the four it always refuses`);
  same(publishedRowCount(store), rowsBefore + 2, `the re-run grew the chain to ${publishedRowCount(store) - rowsBefore} extra rows`);
  same(glossaryRowInForceForTerm(store, ROW_KISARAGI.term, 2).rendering, "Amatsuyu-kun", "the re-run rewrote the term back to a rendering this volume had already replaced");

  store.close();
  console.log("glossary revisions: the same proposal asked twice files one row, and a chain of two revisions in one volume still prints one row");
}

// ─── Scenario 5 ───────────────────────────────────────────────────────────────

/**
 * The cumulative gate carries a revised term, and still stops a render that drops one.
 * @returns {Promise<void>}
 */
async function scenarioTheCumulativeGateCarriesARevisedTermAndStillStopsALoss() {
  const fx = fixtureStoreSeries("glossary-revisions-carry-forward");
  const one = await buildVolumeOne(fx);
  one.ctx.refStore.close();

  const two = openThroughTheStage(fx, 1);
  glossaryStore.fileGlossaryTermRows(two.ctx, [ROW_CAMEL]);
  glossaryStore.fileGlossaryRevisions(two.ctx, [REVISION_JUSTIFIED]);
  const rendered = await glossaryStore.renderGlossaryArtifact(two.ctx);
  ok(rendered.ok, `volume 2's render refused: ${JSON.stringify(rendered.refusal)}`);
  const fileTwo = fs.readFileSync(two.ctx.glossaryOutputFile, "utf8");

  const diff = compareGlossaryCarryForward(one.file, fileTwo);
  same(diff.missing.map((entry) => entry.term), [], "the cumulative gate reports the revised term as a loss");
  same(diff.renamed, [], "the gate read a changed rendering as a renamed term");
  same(diff.restructured, 0, "the gate read the history line as a restructured row");
  same(diff.added, [ROW_CAMEL.term], `the gate's "new this volume" list is ${JSON.stringify(diff.added)}`);
  same(diff.previousCount, 3, "the gate does not count volume 1's three rows");
  same(diff.currentCount, 4, "the gate does not count volume 2's four rows");

  let cleanRun = null;
  try {
    await assertGlossaryCarryForward(two.ctx, "the render");
  } catch (err) {
    cleanRun = err;
  }
  ok(!cleanRun, `the gate reported damage where the revision carried everything: ${cleanRun && cleanRun.message}`);

  // The plant: a render that drops the revised term's row entirely.
  const damaged = fileTwo
    .split("\n")
    .filter((line) => !line.startsWith(`| ${ROW_KISARAGI.term} |`))
    .join("\n");
  fs.writeFileSync(two.ctx.glossaryOutputFile, damaged, "utf8");
  let failure = null;
  try {
    await assertGlossaryCarryForward(two.ctx, "the render");
  } catch (err) {
    failure = err;
  }
  ok(failure, "a render that dropped the revised term passed the cumulative gate");
  ok(/如月雨露/.test(failure && failure.message), `the failure does not name the revised term it lost: ${failure && failure.message}`);
  ok(!fs.existsSync(two.ctx.glossaryOutputFile), "the damaged file is still where the next volume would read it");
  ok(fs.existsSync(path.join(two.ctx.volumeDir, "glossary.md.rejected")), "the damaged file was not kept as evidence");

  two.ctx.refStore.close();
  console.log("glossary revisions: the cumulative gate carries a revised term as one row and still stops a render that drops it");
}

// ─── Scenario 6 ───────────────────────────────────────────────────────────────

/**
 * The translation stage's terminology law holds one pair per term, and says so when a file breaks that.
 * @returns {Promise<void>}
 */
async function scenarioTheTerminologyLawHoldsOnePairPerTerm() {
  const fx = fixtureStoreSeries("glossary-revisions-terminology");
  const one = await buildVolumeOne(fx);
  one.ctx.refStore.close();

  const two = openThroughTheStage(fx, 1);
  glossaryStore.fileGlossaryTermRows(two.ctx, [ROW_CAMEL]);
  glossaryStore.fileGlossaryRevisions(two.ctx, [REVISION_JUSTIFIED]);
  const rendered = await glossaryStore.renderGlossaryArtifact(two.ctx);
  ok(rendered.ok, `volume 2's render refused: ${JSON.stringify(rendered.refusal)}`);
  const fileTwo = fs.readFileSync(two.ctx.glossaryOutputFile, "utf8");
  two.ctx.refStore.close();

  const seen = { duplicates: [], malformed: [] };
  const pairs = parseGlossaryTerms(fileTwo, {
    onDuplicate: (entry) => seen.duplicates.push([entry.term, entry.rendering, entry.kept]),
    onMalformed: (entry) => seen.malformed.push([entry.term, entry.reason]),
  });
  same(pairs.map((entry) => [entry.term, entry.rendering]), [
    [ROW_KISARAGI.term, REVISION_JUSTIFIED.rendering],
    [ROW_OGA.term, ROW_OGA.rendering],
    [ROW_BOARD.term, ROW_BOARD.rendering],
    [ROW_CAMEL.term, ROW_CAMEL.rendering],
  ], "the terminology law is not one pair per term, with the revised rendering winning");
  same(seen.duplicates, [], "the law found a term twice in a file the render wrote");
  same(seen.malformed, [], "the law read the history line as a rendering");
  ok(!pairs.some((entry) => entry.rendering.startsWith(GLOSSARY_HISTORY_PREFIX)), "a superseded rendering reached a translation prompt as law");

  // The plant the render cannot produce but an authored or hand-edited file can: the history line in the
  // rendering column.
  const plantedInRendering = fileTwo.replace(
    `| ${ROW_KISARAGI.term} | ${REVISION_JUSTIFIED.rendering} |`,
    `| ${ROW_KISARAGI.term} | ${revisionHistoryFragment({ rendering: ROW_KISARAGI.rendering, appliesFromVolume: 1 })} |`
  );
  const plantedSeen = [];
  const plantedPairs = parseGlossaryTerms(plantedInRendering, { onMalformed: (entry) => plantedSeen.push([entry.term, entry.reason]) });
  ok(!plantedPairs.some((entry) => entry.term === ROW_KISARAGI.term), "the law used a history line as the term's rendering");
  same(plantedSeen.map((entry) => entry[0]), [ROW_KISARAGI.term], `the malformed row was not reported: ${JSON.stringify(plantedSeen)}`);
  ok(/history line/.test(plantedSeen[0][1]), `the report does not say what it found: ${plantedSeen[0][1]}`);

  // The other plant: two rows for one term, which is what a file with a `## Revisions` section would do.
  const plantedDuplicate = fileTwo.replace(
    `| ${ROW_KISARAGI.term} | ${REVISION_JUSTIFIED.rendering} |`,
    `| ${ROW_KISARAGI.term} | ${REVISION_JUSTIFIED.rendering} |\n| ${ROW_KISARAGI.term} | ${ROW_KISARAGI.rendering} | planted second row |`
  );
  const dupes = [];
  const dupPairs = parseGlossaryTerms(plantedDuplicate, { onDuplicate: (entry) => dupes.push([entry.term, entry.rendering, entry.kept]) });
  same(dupPairs.filter((entry) => entry.term === ROW_KISARAGI.term).map((entry) => entry.rendering), [REVISION_JUSTIFIED.rendering], "the law kept both renderings for one term");
  same(dupes, [[ROW_KISARAGI.term, ROW_KISARAGI.rendering, REVISION_JUSTIFIED.rendering]], `the second row was not reported: ${JSON.stringify(dupes)}`);

  console.log("glossary revisions: the terminology law carries one pair per term, and reports a history line or a second row instead of choosing one");
}

// ─── Scenario 7 ───────────────────────────────────────────────────────────────

/**
 * The read pass's answer carries two lists, and the report the grader reads names what each one did.
 * @returns {Promise<void>}
 */
async function scenarioTheAnswerCarriesTwoListsAndTheReportNamesBoth() {
  const termsJson = JSON.stringify([
    { term: "駱駝", rendering: "The Camel", note: "Writes the afterword.", type: "concept", query: "駱駝" },
  ]);
  const ONE_REVISION = { term: "如月雨露", rendering: "Amatsuyu Kisaragi", note: "Family name first.", quote: QUOTE_IN_VOLUME_TWO, reason: "The afterword signs him that way." };
  const revisionsJson = JSON.stringify([ONE_REVISION]);

  // The envelope the request asks for.
  const envelope = parseTermAnswer(`{"terms": ${termsJson}, "revisions": ${revisionsJson}}`);
  same(envelope.terms.map((entry) => entry.term), ["駱駝"], "the envelope's terms half is not read");
  same(envelope.revisions.map((entry) => entry.term), ["如月雨露"], "the envelope's revisions half is not read");
  same(Object.keys(envelope.revisions[0]).sort(), ["note", "quote", "reason", "rendering", "term"], "the parsed revision does not keep quote and reason apart");

  // The forms a server answers in anyway.
  same(parseTermAnswer(`{"terms": ${termsJson}}`).revisions, [], "an envelope with no revisions key is not an answer with no revisions");
  same(parseTermAnswer(termsJson).revisions, [], "a bare array answer is not an answer with no revisions");
  const fenced = parseTermAnswer("Here is what volume 2 found:\n```json\n" + `{"terms": ${termsJson}, "revisions": ${revisionsJson}}` + "\n```\nThat is all.");
  same([fenced.terms.length, fenced.revisions.length], [1, 1], "a fenced answer with prose around it is not read");
  same(parseTermAnswer("").terms, [], "an empty answer is not an empty list");
  same(parseTermAnswer("").revisions, [], "an empty answer invented a revision");

  // A revision element that names no term never reaches the door.
  const sloppy = parseTermAnswer(
    `{"terms": [], "revisions": [{"term": "   ", "rendering": "X", "note": "n", "quote": "q", "reason": "r"}, ${JSON.stringify(ONE_REVISION)}]}`
  );
  same(sloppy.revisions.map((entry) => entry.term), ["如月雨露"], `the parser passed a nameless revision through: ${JSON.stringify(sloppy.revisions)}`);

  // `parseTerms` is still the terms-only half.
  same(parseTerms(`{"terms": ${termsJson}, "revisions": ${revisionsJson}}`).map((entry) => entry.term), ["駱駝"], "parseTerms no longer returns the terms");

  let threw = null;
  try {
    parseTermAnswer("no JSON in this answer at all");
  } catch (err) {
    threw = err;
  }
  ok(threw, "an answer with no term list in any form was read as an empty one");

  // The report the acceptance grader reads.
  const report = glossaryStore.revisionReport(
    {
      filed: [{ examples: JSON.stringify([ROW_KISARAGI.term, REVISION_JUSTIFIED.rendering]), evidence: JSON.stringify([{ volume: 2, chapter: "ch0", line: 2, quote: QUOTE_IN_VOLUME_TWO }]), body: REVISION_JUSTIFIED.note }],
      replaced: [{ term: ROW_KISARAGI.term, rendering: ROW_KISARAGI.rendering, appliesFromVolume: 1 }],
      alreadyFiled: [ROW_OGA.term, ROW_OGA.term, ROW_BOARD.term],
      refused: [
        { term: REVISION_UNJUSTIFIED.term, rendering: REVISION_UNJUSTIFIED.rendering, quote: REVISION_UNJUSTIFIED.quote, reason: REVISION_UNJUSTIFIED.reason, rule: "revision-quote-not-in-source", because: "no line of volume 2's source text contains it." },
        { term: REVISION_UNJUSTIFIED.term, rendering: REVISION_UNJUSTIFIED.rendering, quote: REVISION_UNJUSTIFIED.quote, reason: REVISION_UNJUSTIFIED.reason, rule: "revision-quote-not-in-source", because: "no line of volume 2's source text contains it." },
      ],
    },
    { volume: "02" }
  );
  ok(report.includes("## Revisions this volume filed"), "the report has no revision block");
  ok(report.includes(`| ${ROW_KISARAGI.term} | ${ROW_KISARAGI.rendering} | ${REVISION_JUSTIFIED.rendering} |`), `the filed table does not name both renderings: ${report}`);
  ok(report.includes(`volume 02 (replacing volume 1)`), "the filed table does not say which volume the new rendering replaces");
  ok(report.includes(`"${QUOTE_IN_VOLUME_TWO}"`), "the filed table does not name the line the revision came from");
  ok(report.includes("2 revision proposal(s) were refused (1 distinct)"), `the refusals are not deduped: ${report}`);
  ok(report.includes("(proposed 2 times)"), "the deduped refusal does not say how often it was proposed");
  ok(report.includes("`revision-quote-not-in-source`"), "the report does not name the rule that refused it");
  ok(report.includes("the answer's stated reason: sounds more natural in English"), "the report drops the answer's own reason");
  ok(report.includes("2 term(s) were already settled"), "the report does not name the already-settled terms");
  same(glossaryStore.revisionReport(null, { volume: "02" }), "", "a volume that revised nothing gets a revision block anyway");
  same(glossaryStore.revisionReport({ filed: [], replaced: [], alreadyFiled: [], refused: [] }, { volume: "02" }), "", "an empty batch gets a revision block anyway");

  // And the block reaches the report the grader's message list already contains.
  const fx = fixtureStoreSeries("glossary-revisions-report");
  const one = await buildVolumeOne(fx);
  one.ctx.refStore.close();
  const two = openThroughTheStage(fx, 1);
  glossaryStore.fileGlossaryTermRows(two.ctx, [ROW_CAMEL]);
  glossaryStore.fileGlossaryRevisions(two.ctx, ALL_PROPOSALS);
  const rendered = await glossaryStore.renderGlossaryArtifact(two.ctx);
  ok(rendered.ok, `volume 2's render refused: ${JSON.stringify(rendered.refusal)}`);
  const audit = await glossaryStore.auditGlossaryArtifact(two.ctx);
  ok(audit && audit.markdown.includes("## Revisions this volume filed"), "the audit report carries no revision block");
  ok(audit.markdown.includes("revision-quote-not-in-source"), "the audit report does not name the refusal the grader would have to grade");
  ok(audit.markdown.includes(ROW_KISARAGI.term), "the audit report does not name the term that was revised");
  same(audit.highFindings.length, 0, `the revision produced a HIGH finding: ${JSON.stringify(audit.findings.map((f) => f.kind))}`);
  same(audit.findings.length, 0, `the revision damaged the record's own audit: ${JSON.stringify(audit.findings.map((f) => [f.severity, f.kind]))}`);
  ok(findQuoteEvidence(two.ctx.volumeDir, two.ctx.refStore.listChapters().chapters, 2, QUOTE_ONLY_IN_VOLUME_ONE).evidence === null, "the quote search found volume 1's line in volume 2's book");
  two.ctx.refStore.close();

  console.log("glossary revisions: the answer carries terms and revisions, and the report the grader reads names every filed revision and every refusal");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

/**
 * Run every scenario in order.
 * @returns {Promise<void>}
 */
async function main() {
  const started = Date.now();
  await scenarioTheDoorFilesOneRevisionAndRefusesFour();
  await scenarioMarkSupersededRefusesAnUnattributedSupersession();
  await scenarioInForceAtVolumeIsBoundedByThatVolume();
  await scenarioTheSameRevisionIsFiledOnce();
  await scenarioTheCumulativeGateCarriesARevisedTermAndStillStopsALoss();
  await scenarioTheTerminologyLawHoldsOnePairPerTerm();
  await scenarioTheAnswerCarriesTwoListsAndTheReportNamesBoth();
  console.log(`test/test-glossary-revisions.js: 7 scenarios, ${checks} checks, ${Date.now() - started} ms, 0 model calls`);
}

main().catch((err) => {
  console.error("test/test-glossary-revisions.js FAILED:", err && err.stack);
  process.exit(1);
});

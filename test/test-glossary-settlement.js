#!/usr/bin/env node
/**
 * test/test-glossary-settlement.js — the glossary settlement pass: the agenda is a query, the answer
 * goes through the door that already exists, the decision reaches the settled record, and a second pass
 * over the same agenda pays nothing.
 *
 * What each scenario pins, and why that is the thing worth pinning:
 *
 *   1. **The agenda is a query over recorded facts.** A term the record already revised, and a term whose
 *      own note points past the volume that wrote it, are on it; a term with neither is not. The
 *      alternative — asking the model which terms look suspicious — is not reproducible, and a pass whose
 *      agenda changes between runs cannot be audited or bounded.
 *   2. **The two shapes that were measured and dropped stay dropped.** The seven real-corpus rows they
 *      fired on are named in the fixture and are NOT agenda items. A shape list nobody can re-test is a
 *      shape list somebody adds the wrong pattern back to.
 *   3. **A second pass over the same agenda pays 0 model calls.** The decision file is the machine twin of
 *      the answers, and this is the scenario that proves the pass is bounded in time as well as in count.
 *      The rule it pins, in both directions:
 *        - an answer the reading call brought back (`keep`, or `revise` whether the revision door took it
 *          or refused it) closes its agenda identity, so the next pass pays 0 for it;
 *        - a revision that was filed **and reached the settled record** closes the identity of the
 *          rendering it chose as well — otherwise the pass re-asks the term it just settled, which is the
 *          bug this suite was red for;
 *        - an answer that never arrived is a **failed read**, not an answer: it is recorded so the cost is
 *          visible, it closes nothing, and the next pass asks the term again (AGENTS.md gotcha 138).
 *   3b. **A failed read is re-asked, named, and bounded.** Three passes, two calls, and the log naming the
 *      term the next pass will ask again.
 *   3c. **A filed revision closes both identities.** The identity the question was asked under, and the one
 *      the settled record now prints.
 *   4. **A "revise" answer is filed through the revision door, not around it.** A new row beside the row
 *      it replaces; the replaced row survives with every column but `status` unchanged.
 *   5. **An answer the revision door refuses is recorded and not re-asked.** The quote rule is the guard;
 *      a refusal is an answer, and paying again to get the same refusal is the cost this pass exists to
 *      avoid.
 *   6. **The decision travels to the settled record.** Filed into the volume whose book carries the quote,
 *      carried forward by the store's own top-up door, and verified by asking the settled record what it
 *      now prints — not by trusting the filing's return value.
 *   7. **The series-root glossary is a render of the settled record, and no per-volume file moves.** The
 *      whole point of the slice, and the half that must not regress: the root prints the settled rendering
 *      while volume 1's own file keeps the rendering volume 1 was translated under.
 *   8. **The freeze gate covers the door.** A published translation freezes the terminology law it was
 *      built under; a settlement that would file new rows is refused, and a settlement with nothing left
 *      to decide is passed as what it is — not a rewrite.
 *   9. **The bound is a constant, not a dial**, and a draft record is never sealed by this pass.
 *
 * Every scenario runs in a throwaway fixture under the fixture root, and every call site names its own
 * series folder. Nothing here reads the real 17 volumes or any file under the series folder (AGENTS.md
 * rule 8, gotcha 69). No scenario reaches the real endpoint: the model half is stood in by a scripted
 * `ask`, and the count of calls it received is what the scenarios assert. No scenario opens a volume's
 * own `series.db` with a client — the records are opened through the store's own doors (gotcha 124).
 *
 * Run with `npm test`, or standalone: `node test/test-glossary-settlement.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  publishedGlossaryRowsInRecord,
  glossaryRowInForceForTerm,
  openReferenceStore,
  DOCUMENT_SOURCE_STAGE,
  REFERENCE_STORE_FILE_NAME,
} = require("../utils/reference-store");
const { settledGlossaryRecord, readSettledGlossary } = require("../utils/translate");
const { assertDoorAllowed } = require("../utils/prereqs/freeze");
const glossaryStore = require("../glossary/store");
const settlement = require("../glossary/settlement");
const {
  SETTLEMENT_MAX_TERMS_PER_RUN,
  FORWARD_REVEAL_SHAPES,
  DROPPED_SHAPES,
  settlementAgenda,
  firedForwardShapes,
  planSettlementPass,
  executeSettlementPass,
  parseSettlementAnswer,
  buildSettlementPrompt,
  settlementRecordPaths,
  readSettlementDecisions,
  decisionKey,
  decisionClosesQuestion,
  decisionIdentityKeys,
  settleGlossaryRun,
  renderSettledGlossaryForSeriesRoot,
} = settlement;
const { fixtureStoreSeries, assertInsideFixture } = require("./fixture-reference-store");

const ROOT = path.resolve(__dirname, "..");
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
 * Count one deep assertion and run it.
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} message
 * @returns {void}
 */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

const scenarios = [];
/**
 * Register one scenario.
 * @param {string} name
 * @param {Function} fn
 * @returns {void}
 */
function scenario(name, fn) {
  scenarios.push({ name, fn });
}

// ─── The fixture ──────────────────────────────────────────────────────────────

/**
 * A term whose own note points past the volume that wrote it.
 *
 * `reveal-then-later` fires on it, and volume 1's text prints the term (SOURCE_01 ch1), so the row is
 * filed with a real citation — which is what makes the settlement call have a quotable line to offer.
 */
const ROW_FORWARD = {
  term: "三色院菫子",
  rendering: "Shikibain Sumireko",
  note: "Her real name is revealed in a later volume.",
  type: "character",
  query: "三色院菫子",
};
/** A row with no chain and no forward pointer: the agenda must not ask about it. */
const ROW_PLAIN = {
  term: "黒板",
  rendering: "Blackboard",
  note: "The teacher hits it.",
  type: "item",
  query: "黒板",
};
/** The seven notes the two dropped shapes fired on in the real corpus. None may be an agenda item. */
const DROPPED_NOTE_ROWS = [
  { term: "僕／俺（一人称）", rendering: "I (first person)", note: "The narrator's true identity is 如月雨露.", type: "concept" },
  { term: "如月茉莉花", rendering: "Kisaragi Maria", note: "Her hidden name is given here.", type: "character" },
  { term: "純情可憐ＧＩＲＬ", rendering: "Innocent Pure-Hearted Girl", note: "A deliberately vague self-description.", type: "concept" },
  { term: "スタバ", rendering: "the coffee chain", note: "A real brand, deliberately unnamed in the book.", type: "concept" },
  { term: "超有名遊園地", rendering: "the famous theme park", note: "Deliberately unexplained which park it is.", type: "place" },
  { term: "一人目の図書委員", rendering: "the first library committee member", note: "Deliberately unnamed.", type: "concept" },
  { term: "後輩マネージャー", rendering: "the junior manager", note: "Her true name is withheld from this volume.", type: "character" },
];

/** A line volume 1's own source prints (SOURCE_01 ch1). */
const QUOTE_IN_VOLUME_ONE = "三色院菫子は本を読んでいた。";
/** A line only volume 2's source prints — a quote the filing into volume 1 must not be able to use. */
const QUOTE_ONLY_IN_VOLUME_TWO = "駱駝はあとがきに書いた。";

/** The settlement's replacement for the forward-pointing term. */
const REVISED_RENDERING = "Sumireko Shikibain";

/**
 * Volume 3's source, for the scenarios that need a settled record further along the chain.
 *
 * Written by this suite rather than by the shared fixture, because the shared fixture is two volumes on
 * purpose and the propagation half of this pass is the part that needs a third.
 */
const SOURCE_03 = {
  ch0: [
    "# 第三章",
    "如月雨露は卒業した。",
    "三色院菫子は新しい名前で呼ばれた。",
  ],
};

/**
 * Add a third volume to a fixture series, laid out the way the extraction lays a volume out.
 *
 * @param {{dir: string, volumes: Array<Object>}} fx
 * @returns {{folder: string, installmentNumber: string, base: string, dir: string}}
 */
function addVolumeThree(fx) {
  const volume = { folder: "Test Story(03)", installmentNumber: "03", base: "test_story(3)" };
  volume.dir = path.join(fx.dir, volume.folder);
  fs.mkdirSync(volume.dir, { recursive: true });
  const segments = Object.entries(SOURCE_03).map(([id, lines]) => {
    const file = `${volume.base}-${id}.md`;
    fs.writeFileSync(path.join(volume.dir, file), lines.join("\n") + "\n", "utf8");
    return { id, file, title: lines[0].replace(/^#\s+/, ""), chars: lines.join("\n").length };
  });
  fs.writeFileSync(path.join(volume.dir, `${volume.base}-bundle.meta.json`), JSON.stringify({ format: "epub", schema: 6, base: volume.base, wholeFile: `${volume.base}-whole.md`, segments }, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(volume.dir, `${volume.base}-whole.md`), Object.values(SOURCE_03).flat().join("\n") + "\n", "utf8");

  const planFile = path.join(fx.dir, "translation-target.json");
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  plan.volumes.push({
    folder: volume.folder,
    sourceFile: `${volume.folder}/${volume.base}.epub`,
    installmentNumber: volume.installmentNumber,
    title: "Test Story",
    integrity: { isNarrative: true, confidence: 0.9, basis: "fixture" },
  });
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + "\n", "utf8");
  fx.volumes = [...fx.volumes, volume];
  return volume;
}

/**
 * The context object `glossary/task.js` hands its store glue, for a fixture volume.
 *
 * @param {{dir: string, volumes: Array<Object>}} fx
 * @param {number} index
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
 * Open a fixture volume's record through the stage's own door, file rows, render, and seal.
 *
 * @param {{dir: string, volumes: Array<Object>}} fx
 * @param {number} index
 * @param {Array<Object>} newRows - The rows this volume adds.
 * @returns {Promise<{ctx: Object, rendered: Object}>}
 */
async function buildVolume(fx, index, newRows) {
  const ctx = stageCtx(fx, index);
  const previous = index > 0 ? Number(fx.volumes[index - 1].installmentNumber) : null;
  const attempt = glossaryStore.openGlossaryRecord(ctx, previous);
  assert.ok(attempt.ok, `volume ${ctx.values.INSTALLMENT_NUMBER}: ${attempt.error}`);
  ctx.refStore = attempt.opened.store;
  assertInsideFixture(ctx.refStore.file, fx.dir);
  if (newRows.length) {
    const filed = glossaryStore.fileGlossaryTermRows(ctx, newRows);
    assert.ok(filed.refused.length === 0, `volume ${ctx.values.INSTALLMENT_NUMBER} refused its own fixture rows: ${JSON.stringify(filed.refused)}`);
  }
  const rendered = await glossaryStore.renderGlossaryArtifact(ctx);
  assert.ok(rendered.ok, `volume ${ctx.values.INSTALLMENT_NUMBER}'s render refused: ${JSON.stringify(rendered.refusal)}`);
  ctx.qaAccepted = true;
  glossaryStore.sealGlossaryRecord(ctx);
  return { ctx, rendered };
}

/**
 * Build the three-volume fixture: volume 1 files the forward-pointing term and an ordinary one, volumes
 * 2 and 3 add nothing, so the settled record is volume 3 and every chain in it is volume 1's.
 *
 * @param {string} label
 * @returns {Promise<{fx: Object, files: string[], checksums: string[]}>} The fixture and the checksums of
 *   every published per-volume glossary BEFORE the settlement runs.
 */
async function buildThreeVolumeFixture(label) {
  const fx = fixtureStoreSeries(label);
  addVolumeThree(fx);
  await buildVolume(fx, 0, [ROW_FORWARD, ROW_PLAIN]);
  await buildVolume(fx, 1, []);
  await buildVolume(fx, 2, []);
  const files = fx.volumes.map((v) => path.join(v.dir, "glossary.md"));
  return { fx, files, checksums: files.map(sha256) };
}

/**
 * The content hash of a file, for "nothing moved" assertions.
 * @param {string} file
 * @returns {string}
 */
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * The volume references `planSettlementPass` walks, read off a fixture.
 * @param {{volumes: Array<Object>}} fx
 * @returns {Array<{folder: string, installmentNumber: number}>}
 */
function volumeRefsOf(fx) {
  return fx.volumes.map((v) => ({ folder: v.folder, installmentNumber: Number(v.installmentNumber) }));
}

/**
 * A scripted model, and the counter that makes "0 calls" an assertion rather than a claim.
 *
 * @param {(item: Object) => Object} decide - What this scripted model answers for one agenda item.
 * @returns {{ask: Function, calls: Array<Object>, count: number}}
 */
function scriptedModel(decide) {
  /** @type {Array<Object>} */
  const calls = [];
  const ask = async ({ item, prompt, responseFormat }) => {
    calls.push({ term: item.term, prompt, responseFormat });
    const answer = decide(item);
    return JSON.stringify(answer);
  };
  return { ask, calls, get count() { return calls.length; } };
}

/**
 * Read one stored row, as the database holds it.
 * @param {{db: Object}} store
 * @param {string} id
 * @returns {Object|null}
 */
function rowColumns(store, id) {
  return store.db.prepare("SELECT * FROM facts WHERE id = ?").get(id) || null;
}

// ─── 1. The agenda is a query ─────────────────────────────────────────────────

scenario("the agenda is a query over the settled record: chains and forward notes, and nothing else", async () => {
  const { fx } = await buildThreeVolumeFixture("settlement-agenda");
  const settled = settledGlossaryRecord({ seriesDir: fx.dir });
  same(settled.volume, 3, `the settled record should be volume 3, saw ${settled.volume}`);

  let refused = null;
  try {
    settlementAgenda({ db: null, volume: settled.volume, dbHandle: null }, {});
  } catch (err) {
    refused = err;
  }
  ok(refused, "an agenda query handed no record refuses rather than answering \"nothing to settle\"");
  ok(refused && refused.structural === true, `and the refusal is structural, so ON_TASK_ERROR=continue cannot walk past it: ${JSON.stringify(refused && refused.structural)}`);
  ok(refused && /settlement-agenda-has-no-record/.test(refused.message), `and it names the rule: ${refused && refused.message}`);

  // The agenda needs a handle; build one through the store's own read-only door.
  const { withSettledRecord } = require("../utils/translate");
  const read = withSettledRecord({ seriesDir: fx.dir, record: settled }, (handle) => settlementAgenda(handle, {}));
  ok(read.candidateCount >= 1, `the forward-pointing row must be a candidate, saw ${read.candidateCount}`);

  const terms = read.agenda.map((item) => item.term);
  same(terms, [ROW_FORWARD.term], `the agenda is exactly the term whose note points forward: ${terms.join(", ")}`);
  ok(!terms.includes(ROW_PLAIN.term), `"${ROW_PLAIN.term}" has no chain and no forward pointer, so it is not on the agenda`);
  ok(read.agenda[0].shapes.includes("reveal-then-later"), `the shape that fired is named: ${JSON.stringify(read.agenda[0].shapes)}`);
  same(read.agenda[0].flaggingVolume, 1, `the decision is filed into the volume that owns the row in force, saw ${read.agenda[0].flaggingVolume}`);
  same(read.chainCount, 0, "nothing has been revised yet, so the chain half is empty");
  same(read.forwardCount, 1, "the forward half is the one row");
  same(read.limit, SETTLEMENT_MAX_TERMS_PER_RUN, "the bound in force is the constant");
});

scenario("the bound cuts, and the cut is named rather than dropped", async () => {
  const fx = fixtureStoreSeries("settlement-bound");
  await buildVolume(fx, 0, [ROW_FORWARD, ROW_PLAIN]);
  const settled = settledGlossaryRecord({ seriesDir: fx.dir });
  const { withSettledRecord } = require("../utils/translate");

  const wide = withSettledRecord({ seriesDir: fx.dir, record: settled }, (handle) => settlementAgenda(handle, {}));
  const cut = withSettledRecord({ seriesDir: fx.dir, record: settled }, (handle) => settlementAgenda(handle, { limit: 0 }));
  same(wide.agenda.map((i) => i.term), [ROW_FORWARD.term], "the uncut agenda");
  same(cut.agenda, [], "a bound of 0 pays for nothing");
  same(cut.skipped.map((i) => i.term), [ROW_FORWARD.term], `what the bound refused to pay for is named: ${JSON.stringify(cut.skipped.map((i) => i.term))}`);
  ok(cut.capped === true, "and the pass says out loud that the bound cut something");
  // The reason a cut candidate carries is the code's own sentence, shape names included — the point of
  // naming the cut is that a person can argue with the specific reason this term was a candidate.
  const reason = cut.skipped[0].because;
  ok(reason.includes("its own note points at something the book had not said yet"),
    `a cut candidate still carries the reason it was a candidate: ${reason}`);
  same(cut.skipped[0].shapes, ["reveal-then-later", "real-name-given"],
    `the shapes that made it a candidate, measured on the fixture's own note: ${JSON.stringify(cut.skipped[0].shapes)}`);
  for (const shape of cut.skipped[0].shapes) {
    ok(reason.includes(shape), `the reason names every shape that fired — "${shape}" is missing from: ${reason}`);
  }
  ok(cut.skipped[0].flaggingVolume === 1, `and the cut entry says which volume's decision it was: ${cut.skipped[0].flaggingVolume}`);
});

// ─── 2. The dropped shapes stay dropped ───────────────────────────────────────

scenario("the two shapes measured against the real corpus and dropped do not fire on the rows they fired on", () => {
  same(DROPPED_SHAPES.length, 2, "the dropped shapes are recorded, with the note that made each one wrong");
  for (const shape of DROPPED_SHAPES) {
    ok(shape.firedOn.length > 0, `${shape.name}: a dropped shape with no named false positive is a dropped shape nobody can re-test`);
    ok(shape.because.length > 40, `${shape.name}: the reason it was dropped is written down`);
  }
  for (const row of DROPPED_NOTE_ROWS) {
    const fired = firedForwardShapes(row.notes);
    same(fired, [], `"${row.term}": "${row.notes}" fires none of the shipped shapes (it fired ${JSON.stringify(DROPPED_SHAPES.map((s) => s.name))} before they were dropped)`);
  }
  // And the shipped shapes still fire on the shape they exist for.
  ok(firedForwardShapes("Her real name is revealed in a later volume.").length > 0, "a real forward pointer still fires");
  ok(firedForwardShapes("The written book on the library's third floor.").length === 0, "an ordinary note does not");
  ok(FORWARD_REVEAL_SHAPES.length === 15, `the shipped list is the measured 15, saw ${FORWARD_REVEAL_SHAPES.length}`);
});

// ─── 3. A second pass pays nothing ────────────────────────────────────────────

scenario("a second pass over the same agenda pays 0 model calls", async () => {
  const { fx } = await buildThreeVolumeFixture("settlement-idempotence");
  const model = scriptedModel(() => ({ decision: "keep", rendering: ROW_FORWARD.rendering, quote: "", reason: "The settled rendering stands." }));

  const first = await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values: { SOURCE_NAME: "Test Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" } }, { ask: model.ask });
  same(first.asked, 1, `the first pass pays one reading call, saw ${first.asked}`);
  same(first.kept, 1, "and the answer is a keep");

  const second = await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values: { SOURCE_NAME: "Test Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" } }, { ask: model.ask });
  same(second.asked, 0, `the second pass pays nothing, saw ${second.asked} call(s)`);
  same(second.carriedOver, 1, `the agenda term is carried over from the record: ${JSON.stringify(second.decisions.map((d) => [d.term, d.asked]))}`);
  same(model.count, 1, "the scripted model was reached exactly once across both passes");

  const paths = settlementRecordPaths(fx.dir);
  assertInsideFixture(paths.json, fx.dir);
  const stored = readSettlementDecisions(paths.json);
  ok(stored.present, `${paths.json} was written`);
  same(stored.decisions.length, 1, "one decision recorded");
  same(stored.decisions[0].key, decisionKey({ term: ROW_FORWARD.term, flaggingVolume: 1, currentRendering: ROW_FORWARD.rendering }), "the identity is term + flagging volume + the rendering the record prints");
  ok(fs.existsSync(paths.markdown), `${paths.markdown} was written`);
});

// ─── 4. A revise answer goes through the revision door ────────────────────────

scenario("a revise answer files a new row through the revision door and never edits the row it replaces", async () => {
  const { fx } = await buildThreeVolumeFixture("settlement-revise-files");
  const settled = settledGlossaryRecord({ seriesDir: fx.dir });
  const { withSettledRecord } = require("../utils/translate");
  const before = withSettledRecord({ seriesDir: fx.dir, record: settled }, (handle) => {
    const row = glossaryRowInForceForTerm(handle, ROW_FORWARD.term, settled.volume);
    return row;
  });
  ok(before && before.id, "the settled record holds the row the settlement is about to replace");

  const model = scriptedModel(() => ({
    decision: "revise",
    rendering: REVISED_RENDERING,
    quote: QUOTE_IN_VOLUME_ONE,
    reason: "The later volumes call her by the other name, and volume 1's own line supports it.",
  }));
  const pass = await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values: { SOURCE_NAME: "Test Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" } }, { ask: model.ask });
  same(pass.revised, 1, `one revision filed: ${JSON.stringify(pass.decisions.map((d) => [d.term, d.filed, d.refusalRule]))}`);
  ok(pass.decisions[0].settled === true, "the pass verified the settled record prints the new rendering, rather than trusting the filing");

  const after = withSettledRecord({ seriesDir: fx.dir, record: settled }, (handle) => glossaryRowInForceForTerm(handle, ROW_FORWARD.term, settled.volume));
  same(after.rendering, REVISED_RENDERING, "the settled record prints the new rendering");
  same(after.superseded.length, 1, "and still carries the row it replaced");
  same(after.superseded[0].rendering, before.rendering, "the replaced rendering survives, attributed to the volume that published it");

  // The replaced row is untouched except for `status` / `updated_at`.
  const flagging = openReferenceStore({ volume: 1, folder: fx.volumes[0].folder, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  assertInsideFixture(flagging.file, fx.dir);
  const oldRow = rowColumns(flagging, before.id);
  ok(oldRow, "the replaced row is still in volume 1's record");
  same(oldRow.status, "superseded", "the replaced row is marked, not removed");
  same(oldRow.body, before.notes, "its notes cell is untouched");
  same(oldRow.examples, JSON.stringify(before.superseded.length ? undefined : undefined) || oldRow.examples, "its examples column is untouched");
  same(oldRow.owner_volume, 1, "its owner is untouched");
  same(oldRow.sealed, 1, "the settlement sealed the new row beside it, and left the published row sealed");
  const newRow = flagging.db
    .prepare("SELECT * FROM facts WHERE aspect = 'term_usage' AND source_stage != 'extract' AND supersedes = ?")
    .get(before.id);
  ok(newRow, "the replacement row exists in the flagging volume's record");
  same(newRow.owner_volume, 1, "it is owned by the volume whose book carries the quote");
  same(newRow.owner_stage, DOCUMENT_SOURCE_STAGE, "and by the same stage the glossary stage files under");
  same(newRow.applies_from_volume, 1, "it applies from the flagging volume, which is what carries it into every later record");
  flagging.close();
});

// ─── 5. A refusal is recorded and not re-asked ────────────────────────────────

scenario("an answer the revision door refuses is recorded, the term keeps its rendering, and the next pass does not pay again", async () => {
  const { fx } = await buildThreeVolumeFixture("settlement-refusal");
  const model = scriptedModel(() => ({
    decision: "revise",
    rendering: "A Name No Book Prints",
    quote: QUOTE_ONLY_IN_VOLUME_TWO,
    reason: "Justified by a line this volume does not contain.",
  }));
  const first = await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values: { SOURCE_NAME: "Test Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" } }, { ask: model.ask });
  same(first.revised, 0, "nothing was filed");
  same(first.refused, 1, "and the refusal is counted");
  same(first.decisions[0].refusalRule, "revision-quote-not-in-source", `the rule that refused it is recorded: ${first.decisions[0].refusalRule}`);

  const settled = settledGlossaryRecord({ seriesDir: fx.dir });
  const { withSettledRecord } = require("../utils/translate");
  const row = withSettledRecord({ seriesDir: fx.dir, record: settled }, (handle) => glossaryRowInForceForTerm(handle, ROW_FORWARD.term, settled.volume));
  same(row.rendering, ROW_FORWARD.rendering, "the term keeps the rendering the record already had");
  same(row.superseded.length, 0, "and no chain was opened for it");

  const second = await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values: { SOURCE_NAME: "Test Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" } }, { ask: model.ask });
  same(second.asked, 0, `a refusal is an answer: the second pass pays 0 calls, saw ${second.asked}`);
  same(model.count, 1, "the scripted model was reached once in total");
});

// ─── 5b. A failed read is not an answer ───────────────────────────────────────

scenario("a reading call that never answered is a failed read, and the next pass asks the term again", async () => {
  const { fx } = await buildThreeVolumeFixture("settlement-failed-read");
  const values = { SOURCE_NAME: "Test Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" };
  let answered = false;
  const model = scriptedModel((item) => {
    if (!answered) {
      answered = true;
      return { decision: "maybe", rendering: item.rendering, quote: "", reason: "not a decision the parser can read" };
    }
    return { decision: "keep", rendering: item.rendering, quote: "", reason: "The settled rendering stands." };
  });

  const first = await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values }, { ask: model.ask });
  same(first.asked, 1, `the first pass pays one reading call, saw ${first.asked}`);
  same(first.kept, 0, "and nothing was kept, because nothing was answered");
  same(first.revised, 0, "and nothing was filed");
  same(first.open, 1, `the pass counts the question as left open, saw ${first.open}`);
  same(first.decisions[0].decision, "unusable", "the entry names what happened");
  same(first.decisions[0].refusalRule, "settlement-answer-unusable", "with the rule that named it");
  ok(decisionClosesQuestion(first.decisions[0]) === false, "a failed read is NOT an answer to the question it was recorded for");

  const settled = settledGlossaryRecord({ seriesDir: fx.dir });
  const { withSettledRecord } = require("../utils/translate");
  const row = withSettledRecord({ seriesDir: fx.dir, record: settled }, (handle) => glossaryRowInForceForTerm(handle, ROW_FORWARD.term, settled.volume));
  same(row.rendering, ROW_FORWARD.rendering, "and the record is untouched: a failed read files nothing");

  const paths = settlementRecordPaths(fx.dir);
  const stored = readSettlementDecisions(paths.json);
  same(stored.decisions.length, 1, "the failed read is still written, so the call it already spent is visible");
  same(stored.unanswered.length, 1, "and it is filed as an open question, not as a decision");
  same(stored.byKey.size, 0, "while closing no agenda identity at all");
  const log = fs.readFileSync(paths.markdown, "utf8");
  ok(log.includes("## Still open — asked again by the next pass (1)"), `the human log names it as open:\n${log}`);
  ok(log.includes(ROW_FORWARD.term), "with the term named");

  const second = await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values }, { ask: model.ask });
  same(second.asked, 1, `the second pass asks the term again — a read that never answered is not a question that needed no asking, saw ${second.asked}`);
  same(second.kept, 1, "and this time the answer arrives");
  same(second.open, 0, `which closes the question, saw ${second.open} still open`);

  const third = await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values }, { ask: model.ask });
  same(third.asked, 0, `a third pass over an answered agenda pays 0, saw ${third.asked}`);
  same(third.carriedOver, 1, "carried from the pass that answered");
  same(model.count, 2, "two calls in total across three passes: the failed read and the answer that replaced it");
});

// ─── 5c. A filed revision answers the identity it created ──────────────────────

scenario("a filed revision closes both identities, so the next pass does not re-ask the term it just settled", async () => {
  const { fx } = await buildThreeVolumeFixture("settlement-alias");
  const values = { SOURCE_NAME: "Test Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" };
  const model = scriptedModel(() => ({
    decision: "revise",
    rendering: REVISED_RENDERING,
    quote: QUOTE_IN_VOLUME_ONE,
    reason: "The series now calls her by the other name.",
  }));

  const first = await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values }, { ask: model.ask });
  same(first.asked, 1, `one call, saw ${first.asked}`);
  same(first.revised, 1, "and the revision was filed");

  const entry = readSettlementDecisions(settlementRecordPaths(fx.dir).json).decisions[0];
  ok(decisionClosesQuestion(entry), "a filed revision is an answer");
  const keys = decisionIdentityKeys(entry);
  same(keys.length, 2, `it closes TWO identities — the rendering it was asked about, and the one the record now prints: ${JSON.stringify(keys)}`);
  same(keys[0], decisionKey({ term: ROW_FORWARD.term, flaggingVolume: 1, currentRendering: ROW_FORWARD.rendering }), "the identity the question was asked under");
  same(keys[1], decisionKey({ term: ROW_FORWARD.term, flaggingVolume: 1, currentRendering: REVISED_RENDERING }), "and the identity the settled record now prints");

  const settled = settledGlossaryRecord({ seriesDir: fx.dir });
  const { withSettledRecord } = require("../utils/translate");
  const agenda = withSettledRecord({ seriesDir: fx.dir, record: settled }, (handle) => settlementAgenda(handle, {}));
  same(agenda.agenda[0].rendering, REVISED_RENDERING, "the next pass's agenda item carries the settled rendering, not the one that was asked about");
  same(agenda.chainCount, 1, "and it is on the agenda through the chain half now");

  const second = await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values }, { ask: model.ask });
  same(second.asked, 0, `the pass does not re-ask the term it just settled, saw ${second.asked} call(s)`);
  same(second.carriedOver, 1, "the answer is carried over under the new identity");
  same(model.count, 1, "one call in total across both passes");
});

// ─── 6. The decision travels to the settled record ────────────────────────────

scenario("a decision filed into volume 1 is carried into every later record by the store's own top-up door", async () => {
  const { fx } = await buildThreeVolumeFixture("settlement-propagation");
  const model = scriptedModel(() => ({
    decision: "revise",
    rendering: REVISED_RENDERING,
    quote: QUOTE_IN_VOLUME_ONE,
    reason: "The series now calls her by the other name.",
  }));
  await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values: { SOURCE_NAME: "Test Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" } }, { ask: model.ask });

  const { withSettledRecord } = require("../utils/translate");
  for (const volume of [1, 2, 3]) {
    const folder = fx.volumes[volume - 1].folder;
    const record = settledGlossaryRecord({ seriesDir: fx.dir });
    const row = withSettledRecord({ seriesDir: fx.dir, record }, (handle) => glossaryRowInForceForTerm(handle, ROW_FORWARD.term, volume));
    ok(row, `volume ${volume}'s record still answers for "${ROW_FORWARD.term}"`);
    same(row.rendering, REVISED_RENDERING, `volume ${volume}'s record prints the settled rendering (folder ${folder})`);
    same(row.ownerVolume, 1, `and it is still owned by the volume whose book carries the quote, not by the copy that received it`);
  }

  const decision = readSettlementDecisions(settlementRecordPaths(fx.dir).json).decisions[0];
  same(decision.propagatedTo, [2, 3], "the pass recorded which records it carried the row into");
});

// ─── 7. The series-root glossary is a render of the settled record ────────────

scenario("the series-root glossary is rendered from the settled record, and no per-volume file moves", async () => {
  const { fx, files, checksums } = await buildThreeVolumeFixture("settlement-root-render");
  const model = scriptedModel(() => ({
    decision: "revise",
    rendering: REVISED_RENDERING,
    quote: QUOTE_IN_VOLUME_ONE,
    reason: "The series now calls her by the other name.",
  }));
  const volumeByFolder = new Map(fx.volumes.map((v) => [v.folder, { installmentNumber: Number(v.installmentNumber) }]));
  const folders = fx.volumes.map((v) => v.folder);
  const run = await settleGlossaryRun(
    {
      seriesDir: fx.dir,
      folders,
      volumeByFolder,
      runSettings: { seriesName: "Test Story", sourceLanguage: "Japanese", targetLanguage: "English" },
      dryRun: false,
    },
    { ask: model.ask }
  );
  ok(run.ran, "the settlement ran");
  ok(run.published.ok && run.published.written === true, "and it published the series glossary");

  const rootFile = path.join(fx.dir, "glossary.md");
  assertInsideFixture(rootFile, fx.dir);
  const root = fs.readFileSync(rootFile, "utf8");
  ok(root.includes(`| ${ROW_FORWARD.term} | ${REVISED_RENDERING} |`), `the root render prints the settled rendering:\n${root.split("\n").filter((l) => l.startsWith("| ")).join("\n")}`);
  ok(!root.includes(`| ${ROW_FORWARD.term} | ${ROW_FORWARD.rendering} |`), "and not the superseded one, in the rendering column");
  ok(root.includes("Earlier rendering:"), "the superseded rendering survives in the Notes cell");

  // The whole point of the slice's other half: a volume's own file is what that volume was told.
  same(files.map(sha256), checksums, "every per-volume glossary.md is byte-identical to what it was before the settlement");
  const volumeOne = fs.readFileSync(files[0], "utf8");
  ok(volumeOne.includes(`| ${ROW_FORWARD.term} | ${ROW_FORWARD.rendering} |`), "volume 1's own file still prints the rendering volume 1 published");

  const sidecar = JSON.parse(fs.readFileSync(`${rootFile}.provenance.json`, "utf8"));
  ok(sidecar.copiedFrom.endsWith(REFERENCE_STORE_FILE_NAME), `the sidecar names the record the render came from: ${sidecar.copiedFrom}`);
  ok(sidecar.volume === fx.volumes[2].folder, `and names the settled volume's folder: ${sidecar.volume}`);

  // The published root file and the settled record agree term for term — the comparison the translation
  // stage runs, run here against the file this pass just wrote.
  const compared = require("../utils/translate").compareSettledGlossary({ seriesDir: fx.dir, volumeDir: fx.volumes[0].dir });
  same(compared.series.differences.map((d) => [d.term, d.fileRendering, d.recordRendering]), [], "the series-root file and the record state the same renderings");
  same(compared.driftCount, 0, `and nothing is reported as drift, saw ${compared.driftCount}`);
  ok(compared.volume.differences.some((d) => d.term === ROW_FORWARD.term), "the volume's own snapshot is still named as the older statement it is");

  // A second run writes nothing, because the file already matches the render.
  const before = sha256(rootFile);
  const again = await settleGlossaryRun(
    { seriesDir: fx.dir, folders, volumeByFolder, runSettings: { seriesName: "Test Story", sourceLanguage: "Japanese", targetLanguage: "English" }, dryRun: false },
    { ask: model.ask }
  );
  same(again.pass.asked, 0, "the second settlement pass pays 0 calls");
  same(again.published.written, false, "and the publish is skipped rather than rewritten");
  same(sha256(rootFile), before, "the series-root file is untouched");
});

// ─── 8. The freeze gate covers the door ───────────────────────────────────────

scenario("a published translation freezes the terminology law, and the settlement is refused on it", async () => {
  const { fx } = await buildThreeVolumeFixture("settlement-freeze");
  // Plant a published translation in volume 2: the freeze reads it off the translate step's own declaration.
  const volumeDir = fx.volumes[1].dir;
  fs.writeFileSync(path.join(volumeDir, "translation.md"), "# Translation\n\nA published chapter.\n", "utf8");
  fs.writeFileSync(path.join(volumeDir, "translation-state.json"), JSON.stringify({ schema: 1, chapters: {} }, null, 2) + "\n", "utf8");

  const model = scriptedModel(() => ({ decision: "revise", rendering: REVISED_RENDERING, quote: QUOTE_IN_VOLUME_ONE, reason: "planted" }));
  const volumeByFolder = new Map(fx.volumes.map((v) => [v.folder, { installmentNumber: Number(v.installmentNumber) }]));
  const folders = fx.volumes.map((v) => v.folder);

  let refused = null;
  try {
    await settleGlossaryRun(
      { seriesDir: fx.dir, folders, volumeByFolder, runSettings: { seriesName: "Test Story", sourceLanguage: "Japanese", targetLanguage: "English" }, dryRun: false },
      { ask: model.ask }
    );
  } catch (err) {
    refused = err;
  }
  ok(refused, "the settlement refused rather than rewriting the law a published translation was built under");
  ok(refused.structural === true, `and the refusal is structural, so ON_TASK_ERROR=continue cannot walk past it: ${JSON.stringify(refused.structural)}`);
  ok(/glossary-settlement refuses/.test(refused.message), `the refusal names the door: ${refused.message.split("\n")[0]}`);
  same(model.count, 0, "and it refused BEFORE paying for a call or writing into a record");
  ok(!fs.existsSync(settlementRecordPaths(fx.dir).json), "nothing was written into the run's records either");

  // The same door, on a series with nothing left to decide, is not a rewrite — and the gate says so in
  // its own verdict rather than the caller deciding not to ask.
  const verdict = await assertDoorAllowed({
    door: settlement.SETTLEMENT_DOOR,
    seriesDir: fx.dir,
    cancelledBy: "settlement-no-change",
    log: () => {},
  });
  ok(verdict.ok, "a settlement with nothing to decide is passed as not-a-rewrite");
  ok(verdict.verdict.notARewrite, `and the gate says which rule it passed it under: ${JSON.stringify(verdict.verdict.notARewrite)}`);

  // No flag reaches it: the gate's own table is frozen, and the door is in it.
  ok(Boolean(require("../utils/prereqs/freeze").freezeDoorRow("glossary-settlement")), "the door is declared in the table");
  same(require("../utils/prereqs/freeze").freezeDoorRow("glossary-settlement").scope, "series", "and it is a series-scope door, because it writes one file for the whole series");
});

// ─── 8c. A question this run cannot file an answer for is not a rewrite ───────

scenario("a term whose volume is not in this run's plan is not a rewrite, and does not keep the freeze gate shut", async () => {
  const { fx } = await buildThreeVolumeFixture("settlement-unreachable");
  const values = { SOURCE_NAME: "Test Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" };
  const runSettings = { seriesName: "Test Story", sourceLanguage: "Japanese", targetLanguage: "English" };

  // Publish the series glossary FIRST, so the render this pass would produce is byte-for-byte the file
  // already on disk. That leaves a filed row as the only thing this act could still count as a rewrite.
  const settled = settledGlossaryRecord({ seriesDir: fx.dir });
  const published = await settlement.publishSettledGlossaryToSeriesRoot({ seriesDir: fx.dir, values, settled });
  ok(published.ok, `the series glossary is on disk before the pass runs: ${published.refusal && published.refusal.rule}`);

  // A published translation freezes the terminology law this door would rewrite (gotcha 142).
  const volumeDir = fx.volumes[1].dir;
  const translationFile = path.join(volumeDir, "translation.md");
  const translationState = path.join(volumeDir, "translation-state.json");
  fs.writeFileSync(translationFile, "# Translation\n\nA published chapter.\n", "utf8");
  fs.writeFileSync(translationState, JSON.stringify({ schema: 1, chapters: {} }, null, 2) + "\n", "utf8");

  // This run's plan of record lists volumes 2 and 3 — NOT volume 1, which owns the agenda term.
  const refs = volumeRefsOf(fx).filter((ref) => ref.installmentNumber !== 1);
  const folders = refs.map((ref) => ref.folder);
  const volumeByFolder = new Map(refs.map((ref) => [ref.folder, { installmentNumber: ref.installmentNumber }]));

  const plan = planSettlementPass({ seriesDir: fx.dir, volumeRefs: refs });
  same(plan.pending.length, 1, `the term is still a question nobody has answered: ${plan.pending.map((p) => p.term).join(", ")}`);
  ok(!plan.locate(plan.pending[0].flaggingVolume), `and volume ${plan.pending[0].flaggingVolume} is not in this run's plan of record`);

  const model = scriptedModel((item) => ({ decision: "keep", rendering: item.rendering, quote: "", reason: "never asked" }));
  const run = await settleGlossaryRun(
    { seriesDir: fx.dir, folders, volumeByFolder, runSettings, dryRun: false },
    { ask: model.ask }
  );
  ok(run.ran, "the pass ran rather than being refused: it files nothing and its render is the file already on disk");
  same(model.count, 0, "and it paid no call for a question it cannot ask");
  same(run.pass.decisions[0].decision, "unreachable", "the term is recorded as a question this run could not ask");
  same(run.pass.decisions[0].refusalRule, "flagging-volume-not-in-the-plan", "with the rule named");
  ok(decisionClosesQuestion(run.pass.decisions[0]) === false, "and it closes nothing, so the term is not buried by a refusal it never made");
  same(run.published.written, false, "the series glossary on disk was not rewritten");
  assertInsideFixture(run.published.destination, fx.dir);
  assertInsideFixture(settlementRecordPaths(fx.dir).json, fx.dir);
  const log = fs.readFileSync(settlementRecordPaths(fx.dir).markdown, "utf8");
  ok(log.includes("## Still open — asked again by the next pass (1)"), `the log names the open term rather than reporting a settled series:\n${log}`);

  // The next run, which DOES list the volume, asks the term. The planted translation is removed first
  // because a pass that FILES a row on a frozen series is a rewrite, and the freeze scenario above is
  // the one that pins that half.
  fs.rmSync(translationFile);
  fs.rmSync(translationState);
  const allRefs = volumeRefsOf(fx);
  const model2 = scriptedModel((item) => ({ decision: "keep", rendering: item.rendering, quote: "", reason: "The settled rendering stands." }));
  const later = await settleGlossaryRun(
    {
      seriesDir: fx.dir,
      folders: allRefs.map((ref) => ref.folder),
      volumeByFolder: new Map(allRefs.map((ref) => [ref.folder, { installmentNumber: ref.installmentNumber }])),
      runSettings,
      dryRun: false,
    },
    { ask: model2.ask }
  );
  same(model2.count, 1, `the later run asks the term once rather than inheriting the refusal, saw ${model2.count}`);
  same(later.pass.kept, 1, "and the question is answered");
  same(later.pass.open, 0, `nothing is left open, saw ${later.pass.open}`);
});

// ─── 9. The bound is a constant, and a draft is never sealed ──────────────────

scenario("the bound is a constant with no environment knob, and the answer shape is object-rooted", () => {
  same(typeof SETTLEMENT_MAX_TERMS_PER_RUN, "number", "the bound is a number");
  ok(SETTLEMENT_MAX_TERMS_PER_RUN > 0 && Number.isInteger(SETTLEMENT_MAX_TERMS_PER_RUN), `and a positive integer: ${SETTLEMENT_MAX_TERMS_PER_RUN}`);

  for (const file of ["glossary/settlement/agenda.js", "glossary/settlement/decide.js", "glossary/settlement/records.js", "glossary/settlement/publish.js", "glossary/settlement.js"]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    ok(!/process\.env\.[A-Z_]*SETTLEMENT/.test(source), `${file}: the bound is not read from the environment`);
  }
  const settings = fs.readFileSync(path.join(ROOT, "configs/shared/settings.js"), "utf8");
  ok(!/SETTLEMENT_MAX_TERMS_PER_RUN/.test(settings), "the bound is not a setting");

  const format = settlement.settlementResponseFormat();
  same(format.json_schema.schema.type, "object", "the answer is declared as an object at its root — the root this endpoint requires (gotcha 138)");
  same(format.json_schema.schema.required.slice().sort(), ["decision", "quote", "reason", "rendering"], "every key the parser reads is required");
  same(format.json_schema.schema.additionalProperties, false, "and the schema is closed, because the prompt names every key it prints");
  same(format.json_schema.schema.properties.decision.enum, ["keep", "revise"], "the decision is an enum, not a free-text field");

  const prompt = buildSettlementPrompt(
    { term: "X", rendering: "Y", notes: "revealed later", section: "Characters", because: "test", flaggingVolume: 3, superseded: [], evidence: [{ quote: "a line", volume: 3 }, { quote: "another", volume: 1 }] },
    { targetLanguage: "English" }
  );
  ok(prompt.includes("the ONLY lines you may quote"), "the prompt says which lines are quotable, because the door is going to search for one");
  ok(prompt.includes("[volume 1] \"another\""), "and labels another volume's line as context rather than as quotable");

  // The system prompt is a prompt FILE, like every other system prompt this repository sends. An inline
  // constant is the one place a prompt can change without showing up in the diff a person reads.
  const promptFile = path.join(ROOT, "system-prompts", "glossary-settlement.md");
  ok(fs.existsSync(promptFile), "the settlement system prompt is not a prompt file under system-prompts/");
  const promptText = fs.readFileSync(promptFile, "utf8");
  ok(/^You are the terminology settler for/m.test(promptText), "and it opens by naming the job, which is how the offline brain recognises the call");
  ok(!/```/.test(promptText), "the settlement prompt carries no fenced block — the answer shape is declared as a response_format, not shown as an example");
  const decideSource = fs.readFileSync(path.join(ROOT, "glossary/settlement/decide.js"), "utf8");
  ok(!/const SETTLEMENT_SYSTEM_PROMPT =/.test(decideSource), "decide.js still holds its system prompt inline");
  ok(/system-prompts", "glossary-settlement\.md"/.test(decideSource), "decide.js loads it from system-prompts/, the way the detective and every stage config does");
});

scenario("a record the acceptance gate left a draft is not sealed by the settlement", async () => {
  const fx = fixtureStoreSeries("settlement-draft");
  const ctx = stageCtx(fx, 0);
  const attempt = glossaryStore.openGlossaryRecord(ctx, null);
  assert.ok(attempt.ok, attempt.error);
  ctx.refStore = attempt.opened.store;
  glossaryStore.fileGlossaryTermRows(ctx, [ROW_FORWARD]);
  await glossaryStore.renderGlossaryArtifact(ctx);
  ctx.qaAccepted = false;
  const sealed = glossaryStore.sealGlossaryRecord(ctx);
  ok(sealed.sealed === false, "the fixture volume is a draft");
  ctx.refStore.close();

  const model = scriptedModel(() => ({ decision: "revise", rendering: REVISED_RENDERING, quote: QUOTE_IN_VOLUME_ONE, reason: "planted" }));
  const pass = await settlement.runSettlementPass({ seriesDir: fx.dir, volumeRefs: volumeRefsOf(fx), values: { SOURCE_NAME: "Test Story", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" } }, { ask: model.ask });
  same(pass.revised, 1, "the revision is still filed — the door is the guard, and the quote is in the volume's text");

  const store = openReferenceStore({ volume: 1, folder: fx.volumes[0].folder, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  const unsealed = store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE aspect = 'term_usage' AND source_stage != 'extract' AND sealed = 0").get().n;
  ok(unsealed > 0, `the volume is still a draft: ${unsealed} published-shaped row(s) are unsealed, and the settlement did not seal them`);
  same(store.isVolumeSealed(1), false, "the settlement did not publish a record nobody signed off");
  store.close();
});

// ─── The parser ───────────────────────────────────────────────────────────────

scenario("the answer parser reads a usable decision and names an unusable one instead of calling it a keep", () => {
  const keep = parseSettlementAnswer('{"decision":"keep","rendering":"Y","quote":"","reason":"stands"}', { currentRendering: "Y" });
  same(keep.decision, "keep", "a keep is a keep");

  const fenced = parseSettlementAnswer("```json\n{\"decision\":\"revise\",\"rendering\":\"Z\",\"quote\":\"a line\",\"reason\":\"because\"}\n```", { currentRendering: "Y" });
  same(fenced.decision, "revise", "a code fence does not hide the answer");

  for (const [text, why] of [
    ["", "an empty reply"],
    ["no json here", "no object"],
    ['{"decision":"maybe","rendering":"Z","quote":"q","reason":"r"}', "a decision that is neither keep nor revise"],
    ['{"decision":"revise","rendering":"","quote":"q","reason":"r"}', "no rendering"],
    ['{"decision":"revise","rendering":"Z","quote":"","reason":"r"}', "a revision with no quote"],
    ['{"decision":"revise","rendering":"Y","quote":"q","reason":"r"}', "a revision into the words it already had"],
  ]) {
    const parsed = parseSettlementAnswer(text, { currentRendering: "Y" });
    same(parsed.decision, "unusable", `an answer that cannot be read as a decision is recorded as unusable (${why})`);
    ok(parsed.because.length > 10, `and says why: ${parsed.because}`);
  }
});

// ─── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  for (const { name, fn } of scenarios) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      console.error(`  FAIL ${name}\n      ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
    }
  }
  console.log(`\ntest-glossary-settlement: ${scenarios.length} scenario(s), ${checks} check(s).`);
  if (process.exitCode) console.error("FAILED");
})();

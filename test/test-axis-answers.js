#!/usr/bin/env node
/**
 * test/test-axis-answers.js — a query answers one register question without returning another's claims,
 * and the record says plainly which of its claims no question can reach.
 *
 * Plan 06 slice 5. The acceptance line it has to meet, verbatim from the plan:
 *
 *   "A query answers 'how formal is this character' without also returning their vocabulary.
 *    The coverage rules still count what they count today."
 *
 * The two halves of that sentence are two different kinds of proof, and this suite runs both.
 *
 * Scenarios:
 *
 *   1. **the acceptance line** — one character, two claims, two different extraction kinds, ONE aspect
 *      (`register`) for both. Ask the first question, get the first claim and not the second. Both numbers
 *      printed, plus the number the aspect query *would* have returned.
 *   2. **the record's own account** — the inventory: which declared questions it can answer, how many
 *      claims answer none, and the four-into-one collapse named with the bullet labels that are the only
 *      place the extractor's distinction still survives.
 *   3. **the re-run hazard** — the reason this slice could not rename the aspects. File a volume, run the
 *      same volume again, through BOTH doors, and show the claim counts do not double. Then the sharper
 *      half: a claim filed without an axis keeps no axis when the same volume is re-read with one, because
 *      the dedupe matches the claim's own words and a sealed row is never re-labelled.
 *   4. **the coverage rules, unmoved** — the counts the coverage guard produces on this fixture, printed
 *      and pinned, with the axis feature switched on.
 *   5. **the axis-less path still works** — a series with no declaration files the same claims, and the
 *      record states plainly that none of them answers a declared question.
 *   6. **the audit output carries both facts** — the report the grader reads prints the questions it can
 *      answer, the claims it cannot, the collapse, and why the aspects were not renamed.
 *   7. **what the read answers, and what it refuses to answer** — a glossary row that happens to carry an
 *      axis is not a voice claim, a claim whose validity span has closed is not an answer at a later volume,
 *      and a read with no record / no question / no roster entry named refuses and stores nothing. Plus the
 *      report branch for a series that declared questions and got no answers.
 *   8. **what this slice did not add** — no finding kind, no setting, no command, no new door onto the
 *      sealed rows, and slice 3's filing gate still the gate.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69, gotcha 124).
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { assertInsideFixture } = require("./fixture-reference-store");
const rs = require("../utils/reference-store");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { MANIFEST_SCHEMA } = require("../intake/config");
const { readModuleLayer } = require("./module-layer");

const {
  openReferenceStore,
  importVoiceExtraction,
  rebuildVoiceFromExtraction,
  renderRebuiltVoice,
  auditVolumeRecord,
  claimsAnsweringAxis,
  axisAnswersForCharacter,
  registerAxisInventory,
  collapsedAspectAccount,
  QUIRK_TYPE_TO_ASPECT,
  REGISTER_MANIFEST_KEY,
  AXIS_ANSWER_LIMITS,
} = rs;

const FIXTURES_ROOT = "/tmp/opencode/series-fixtures";

let checks = 0;
/** Count one assertion and run it. @param {boolean|void} condition @param {string} message */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}
/** @param {any} a @param {any} b @param {string} message */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

// ─── The fixture ──────────────────────────────────────────────────────────────

/**
 * Lay out a one-volume fixture series whose plan of record carries whatever register block this scenario
 * is testing — including none.
 *
 * Spanish on purpose, like the slice-3 suite: a register slice proved only against Japanese fixtures would
 * prove the design works for the language it happened to be built next to.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @param {{register?: any, chapters: Object<string,string[]>, sourceLanguage?: string, seriesName?: string}} opts
 * @returns {{dir: string, folder: string, base: string, volumeDir: string}}
 */
function layFixture(label, { register, chapters, sourceLanguage = "Spanish", seriesName = "Axis Proof" }) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const folder = `${seriesName}(01)`;
  const base = `${seriesName.toLowerCase().replace(/\s+/g, "_")}(1)`;
  const volumeDir = path.join(dir, folder);
  fs.mkdirSync(volumeDir, { recursive: true });

  const segments = Object.entries(chapters).map(([id, lines]) => {
    const file = `${base}-${id}.md`;
    fs.writeFileSync(path.join(volumeDir, file), lines.join("\n") + "\n", "utf8");
    return { id, file, title: lines[0].replace(/^#\s+/, ""), chars: lines.join("\n").length };
  });
  fs.writeFileSync(
    path.join(volumeDir, `${base}-bundle.meta.json`),
    JSON.stringify({ format: "epub", schema: 8, base, wholeFile: `${base}-whole.md`, segments }, null, 2) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(volumeDir, `${base}-whole.md`),
    Object.values(chapters).flat().join("\n") + "\n",
    "utf8"
  );

  const manifest = {
    schema: MANIFEST_SCHEMA,
    seriesLocation: dir,
    seriesName,
    sourceLanguage,
    targetLanguage: "English",
    generator: "test/test-axis-answers.js",
    generatedAt: new Date().toISOString(),
    discovery: {
      summary: "fixture: one book, continuous prose, one headed chapter",
      confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
      evidence: ["fixture"],
      excluded: [],
    },
    volumes: [
      {
        folder,
        sourceFile: `${folder}/${base}.epub`,
        installmentNumber: "01",
        title: seriesName,
        integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose in one headed section" },
      },
    ],
  };
  if (register !== undefined) manifest[REGISTER_MANIFEST_KEY] = register;
  fs.writeFileSync(path.join(dir, "translation-target.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { dir, folder, base, volumeDir };
}

/**
 * Open one handle on a fixture volume's record, and refuse to go anywhere else.
 *
 * @param {{dir: string, folder: string}} fixture
 * @param {string} stage
 * @returns {Object}
 */
function openFixtureStore(fixture, stage) {
  const store = openReferenceStore({ volume: 1, folder: fixture.folder, seriesDir: fixture.dir, stage });
  assertInsideFixture(store.file, fixture.dir);
  return store;
}

/** A Spanish-shaped book whose distinctions are second-person form and deference. */
const SOURCE = {
  ch0: [
    "# Capítulo 1",
    "Marina entró en el aula sin golpear.",
    "—¿Podés repetir lo que dijiste, vos? —preguntó Diego.",
    "Usted está equivocado, señor director —Marina no bajó la voz.",
    "Renata cerró la puerta sin decir nada.",
    "Yo no voy a repetir nada —dijo Diego.",
    "—Che, che —insistió Diego.",
    "Diego pensaba en primera persona, sin comillas.",
  ],
};

/** Two questions this series declares for itself. */
const REGISTER = {
  axes: [
    {
      id: "treatment",
      asks: "How does this character address somebody they take to be above them?",
      values: ["formal-usted", "informal-tú"],
      scope: "character-addressee",
      evidence: ["capítulo 1: Marina se dirige al director con usted"],
    },
    {
      id: "voseo",
      asks: "Which second-person form does this character use with somebody they know?",
      values: ["vos", "tú", "usted"],
      scope: "character",
      evidence: ["capítulo 1: Diego pregunta con vos"],
    },
  ],
  note: "Two axes: deference, and which second-person form.",
};

/**
 * The claims. Marina carries TWO of them, from two different extraction kinds, and both land on the one
 * aspect `register` — the collapse plan 06 §2.3 measured, planted on purpose.
 */
const ENTRIES = [
  {
    type: "voice",
    character: "Marina",
    quirkType: "formality",
    description: "Answers a superior with usted and never softens it.",
    examples: ["Usted está equivocado, señor director"],
    axis: "treatment",
    value: "formal-usted",
  },
  {
    type: "voice",
    character: "Marina",
    quirkType: "vocabulary",
    description: "Uses the language of an office, never of a classroom.",
    examples: ["Marina entró en el aula sin golpear."],
    axis: "voseo",
    value: "usted",
  },
  {
    type: "voice",
    character: "Diego",
    quirkType: "vocabulary",
    description: "Asks him to repeat himself with vos.",
    examples: ["¿Podés repetir lo que dijiste, vos?"],
    axis: "voseo",
    value: "vos",
  },
  {
    // A claim the extractor never attached to a declared question. It files, and it is answerable only by
    // its aspect — which is the collapsed one.
    type: "voice",
    character: "Renata",
    quirkType: "sentenceending",
    description: "Closes the door and says nothing at all.",
    examples: ["Renata cerró la puerta sin decir nada."],
  },
];

/** The same claims with the axis pair taken off — what the manual doors file today. */
const ENTRIES_NO_AXIS = ENTRIES.map((entry) => {
  const copy = { ...entry };
  delete copy.axis;
  delete copy.value;
  return copy;
});

/**
 * Row counts over one record.
 * @param {Object} store
 */
function rowCounts(store) {
  const one = (sql) => store.db.prepare(sql).get().n;
  return {
    facts: one("SELECT COUNT(*) n FROM facts"),
    cast: one("SELECT COUNT(*) n FROM cast"),
    axisBearing: one("SELECT COUNT(*) n FROM facts WHERE axis IS NOT NULL"),
    axisless: one("SELECT COUNT(*) n FROM facts WHERE axis IS NULL"),
    registerAspect: one("SELECT COUNT(*) n FROM facts WHERE aspect = 'register'"),
    candidates: one("SELECT COUNT(*) n FROM facts WHERE source_stage = 'extract'"),
    adopted: one("SELECT COUNT(*) n FROM facts WHERE source_stage = 'rebuild'"),
  };
}

/**
 * File a fixture volume through the stage's own route: the rebuild door, with its candidate handle.
 * @param {{dir: string, folder: string}} fixture
 * @param {Array<Object>} entries
 * @returns {{store: Object, candidateStore: Object, result: Object}}
 */
function fileThroughTheStageRoute(fixture, entries) {
  const candidateStore = openFixtureStore(fixture, "extract");
  const store = openFixtureStore(fixture, "rebuild");
  const result = rebuildVoiceFromExtraction(store, entries, { volume: 1, candidateStore });
  return { store, candidateStore, result };
}

// ─── 1. the acceptance line ───────────────────────────────────────────────────

{
  console.log("1. one character, two claims, one aspect — and one question returns one of them");

  const fixture = layFixture("axis-acceptance-line", { chapters: SOURCE, register: REGISTER });
  const { store, candidateStore, result } = fileThroughTheStageRoute(fixture, ENTRIES);
  try {
    same(result.filedCount, 4, "all four claims were adopted (none answered a question this series does not declare)");

    // The collapse, planted and measured: Marina's two claims are ONE aspect apart from nothing.
    const marinaByAspect = store.db
      .prepare("SELECT label, aspect, axis, axis_value FROM facts WHERE key = 'Marina' AND aspect = 'register' AND source_stage != 'extract' ORDER BY ord")
      .all();
    same(marinaByAspect.length, 2, "Marina holds 2 claims, and BOTH carry the aspect `register` — the §2.3 collapse");
    same(marinaByAspect.map((row) => row.aspect), ["register", "register"], "the aspect cannot tell them apart");
    same(marinaByAspect.map((row) => row.label), ["Formality level", "Vocabulary register"],
      "the extractor's own distinction survives only in the bullet's label");

    // Ask the first question.
    const formal = claimsAnsweringAxis(store, { axis: "treatment", key: "Marina", volume: 1 });
    ok(formal.ok, "the query answered");
    same(formal.claimCount, 1, "asking 'how does she address a superior' returns ONE claim");
    same(formal.rows.map((row) => row.body), ["Answers a superior with usted and never softens it."],
      "and it is the formality claim");
    same(formal.asks, "How does this character address somebody they take to be above them?",
      "the answer carries the series' own question, not a pipeline's");
    same(formal.valuesAnswered, [{ value: "formal-usted", claims: 1 }], "with the answer the series declared");

    // Ask the second.
    const vocab = claimsAnsweringAxis(store, { axis: "voseo", key: "Marina", volume: 1 });
    same(vocab.claimCount, 1, "asking 'which second-person form' returns the OTHER claim");
    same(vocab.rows.map((row) => row.body), ["Uses the language of an office, never of a classroom."],
      "and not the one the first question returned");

    // The numbers that prove the separation rather than just a narrow result.
    same(formal.claimsInScope, 2, "Marina has 2 claims in scope");
    same(formal.answeringAnotherAxis, 1, "1 of them answers a DIFFERENT declared question — and this query withheld it");
    same(formal.answeringNoAxis, 0, "0 of them answer no question");
    same(formal.collapsedRegisterClaimsHeldBack, 1,
      "1 claim on the same `register` aspect was NOT returned — the acceptance line, as a number");
    same(vocab.collapsedRegisterClaimsHeldBack, 1, "and the same the other way round");
    same(formal.candidateRowsHeldBack, 1, "the extraction's own candidate copy of that claim is kept out of the answer, like the renderers and the coverage rule keep theirs out");
    same(formal.declared, true, "the question asked is one this series declared");

    // The whole-record version of the same door.
    const perCharacter = axisAnswersForCharacter(store, { key: "Marina", volume: 1 });
    same(perCharacter.claimsTotal, 2, "Marina: 2 claims");
    same(perCharacter.questionsAnswered, 2, "answered as 2 separate questions");
    same(perCharacter.answers.map((a) => [a.axis, a.claims]), [["treatment", 1], ["voseo", 1]],
      "one bucket per question — 'how formal' and 'which words' are not one list");
    same(perCharacter.axislessClaims, 0, "and nothing axis-less hiding in her record");

    // A character whose claim answers no question gets no bucket, and is not silently counted as answered.
    const renata = axisAnswersForCharacter(store, { key: "Renata", volume: 1 });
    same(renata.answers, [], "Renata answers no declared question, and no bucket is invented for her");
    same(renata.axislessClaims, 1, "reported beside the answer instead");
    same(renata.axislessByAspect, [{ aspect: "register", claims: 1 }],
      "and the aspect it is sitting on is the collapsed one");

    console.log(
      `  Marina: 2 claims, both aspect \`register\` → ask 'treatment' = ${formal.claimCount}, ask 'voseo' = ${vocab.claimCount}; ` +
      `held back by each query: ${formal.collapsedRegisterClaimsHeldBack}`
    );
  } finally {
    store.close();
    candidateStore.close();
  }
}

// ─── 2. the record's own account ──────────────────────────────────────────────

{
  console.log("2. the inventory: which questions this record can answer, and how much of it answers none");

  const fixture = layFixture("axis-inventory", { chapters: SOURCE, register: REGISTER });
  const { store, candidateStore } = fileThroughTheStageRoute(fixture, ENTRIES);
  try {
    const inv = registerAxisInventory(store, { volume: 1 });
    ok(inv.ok, "the inventory ran");
    same(inv.claimsTotal, 4, "4 character-voice claims in this record (the 4 candidate copies are a separate number)");
    same(inv.candidateRows, 4, "reported separately, not mixed into the answer");
    same(inv.claimsAnswering, 3, "3 of them answer a declared question");
    same(inv.claimsAnsweringNone, 1, "1 answers none");
    same(inv.declaredAxes.map((a) => a.id), ["treatment", "voseo"], "the questions come from the series' own plan of record");
    same(inv.byAxis.map((entry) => [entry.axis, entry.claims, entry.characters]),
      [["treatment", 1, 1], ["voseo", 2, 2]], "per question: claims and characters");
    same(inv.byAxis.map((entry) => entry.declared), [true, true], "every axis in the record is one this series declared");
    same(inv.undeclaredAxes, [], "so there is nothing to name as undeclared");
    same(inv.axislessByAspect, [{ aspect: "register", claims: 1 }], "the axis-less claim's aspect, named");

    // The collapse, reported by the read side and derived from the mapping table rather than restated.
    const collapse = collapsedAspectAccount();
    same(collapse.aspect, "register", "the collapsed aspect");
    same(collapse.kindsCollapsed, 4, "four of the seven quirk kinds land on it");
    same(inv.collapse.aspect, collapse.aspect, "the inventory and the mapping agree, because the inventory reads the mapping");
    same(inv.collapse.kindsCollapsed, collapse.kindsCollapsed, "including the count");
    same(inv.collapse.claimsAnswering, 3, "3 claims sit on that aspect AND answer a declared question — answerable per question");
    same(inv.collapse.claimsAnsweringNone, 1, "1 sits on it and answers nothing — answerable only by the collapsed aspect");
    same(inv.collapse.labels, [{ label: "Sentence endings", claims: 1 }],
      "and the label is the only place that claim's own kind is still written");

    // The limits are constants with no knob, and they report themselves.
    same(Object.keys(AXIS_ANSWER_LIMITS).sort(), ["maxAspectsReported", "maxAxesReported", "maxClaims", "maxValuesPerAxis"],
      "the read's caps are named");
    same([inv.truncatedAxes, inv.truncatedAspects], [0, 0], "and none of them bit on this fixture");

    console.log(
      `  ${inv.claimsTotal} claim(s): ${inv.claimsAnswering} answer ${inv.axesAnswered} declared question(s), ` +
      `${inv.claimsAnsweringNone} answers none (${inv.collapse.claimsAnsweringNone} of them on \`${collapse.aspect}\`)`
    );
  } finally {
    store.close();
    candidateStore.close();
  }
}

// ─── 3. the re-run hazard ─────────────────────────────────────────────────────

{
  console.log("3. the re-run hazard: the same volume twice, through both doors, files nothing twice");

  // Door 1: the extraction door.
  const a = layFixture("axis-rerun-extract", { chapters: SOURCE, register: REGISTER });
  const storeA = openFixtureStore(a, "extract");
  try {
    const first = importVoiceExtraction(storeA, ENTRIES);
    const afterFirst = rowCounts(storeA);
    const second = importVoiceExtraction(storeA, ENTRIES);
    const afterSecond = rowCounts(storeA);
    same(first.importedCount, 4, "pass 1 files 4 claims");
    same(second.importedCount, 0, "pass 2 files nothing");
    same(second.carried.length, 4, "and recognises all four as already filed");
    same(afterSecond, afterFirst, "the record is the same size after the second pass — the dedupe still matches");
    same(afterFirst.facts, 4, "4 rows");
    same(afterFirst.axisBearing, 3, "3 of them name a question");
    same(afterFirst.registerAspect, 4, "all 4 share the aspect `register` — the dedupe key this slice had to leave alone");
  } finally {
    storeA.close();
  }

  // Door 2: the stage's own route (adoption + candidate), which is the one that publishes.
  const b = layFixture("axis-rerun-stage", { chapters: SOURCE, register: REGISTER });
  const candidateB = openFixtureStore(b, "extract");
  const storeB = openFixtureStore(b, "rebuild");
  try {
    const first = rebuildVoiceFromExtraction(storeB, ENTRIES, { volume: 1, candidateStore: candidateB });
    const afterFirst = rowCounts(storeB);
    const second = rebuildVoiceFromExtraction(storeB, ENTRIES, { volume: 1, candidateStore: candidateB });
    const afterSecond = rowCounts(storeB);
    same(first.filedCount, 4, "pass 1 adopts 4 claims");
    same(first.candidates.filed, 4, "and files 4 candidate copies beside them");
    same(second.filedCount, 0, "pass 2 adopts nothing");
    same(second.candidates.filed, 0, "and files no candidate copy twice");
    same(second.carried.length, 4, "it recognises all four");
    same(afterSecond, afterFirst, "8 rows before, 8 rows after — the claim count does not double");
    same(afterFirst.facts, 8, "4 adopted + 4 candidates");
    same(afterFirst.axisBearing, 6, "3 adopted rows and their 3 candidate copies all name the same question");
  } finally {
    storeB.close();
    candidateB.close();
  }

  // The sharper half: an axis never travels backwards onto a row the record already holds.
  const c = layFixture("axis-rerun-backwards", { chapters: SOURCE, register: REGISTER });
  const storeC = openFixtureStore(c, "extract");
  try {
    const axislessFirst = importVoiceExtraction(storeC, ENTRIES_NO_AXIS);
    const filedWithoutAxis = rowCounts(storeC);
    same(axislessFirst.importedCount, 4, "the same four claims, filed naming no question");
    same(filedWithoutAxis.axisBearing, 0, "none of them names a question");

    const withAxis = importVoiceExtraction(storeC, ENTRIES);
    const afterSecond = rowCounts(storeC);
    same(withAxis.importedCount, 0, "re-reading the volume with the axis in place files nothing new");
    same(withAxis.carried.length, 4, "the dedupe matched them on their own words, exactly as it must");
    same(afterSecond, filedWithoutAxis, "the record did not grow");
    same(afterSecond.axisBearing, 0,
      "and the axis did NOT travel backwards onto the rows already there — a filed row is never re-labelled, so the new answer has to arrive as a new row beside the old one");
  } finally {
    storeC.close();
  }

  console.log("  extract door 4→4 rows, stage door 8→8 rows, axis-less rows stay axis-less on a re-run");
}

// ─── 4. the coverage rules, unmoved ───────────────────────────────────────────

{
  console.log("4. the coverage rules still count what they count today");

  const fixture = layFixture("axis-coverage", { chapters: SOURCE, register: REGISTER });
  const { store, candidateStore } = fileThroughTheStageRoute(fixture, ENTRIES);
  try {
    const rendered = renderRebuiltVoice(store, { volume: 1 });
    const audit = auditVolumeRecord(store, {
      title: "Character-voice reference",
      file: "character-voice.md",
      markdown: rendered.markdown,
    });
    const coverage = audit.coverage;
    same(coverage.asked, true, "the coverage question was asked");
    same(coverage.chapters, 1, "1 chapter of this volume's text was searched");
    same(coverage.significanceChapters, 3, "the pinned 3-chapter line is unchanged");
    same(coverage.rows.length, 0, "and it found 0 uncovered characters — the same answer the guard gave before this slice");
    same(coverage.rows.filter((row) => row.severity === "HIGH").length, 0, "0 HIGH");
    same(coverage.rows.filter((row) => row.severity === "MEDIUM").length, 0, "0 MEDIUM");
    same(audit.presence, { ok: true, measured: 3, present: 3, absent: 0, merged: 0, chapters: 1, matchRows: 7, refusal: null },
      "the presence measurement this guard reads is unchanged");
    same([audit.counts.facts, audit.counts.cast], [8, 3], "8 facts / 3 cast rows — the same record the doors wrote");
    same(audit.findings.map((f) => f.kind).sort(), ["reference-document-rebuilt-from-extraction"],
      "and the findings are the ones this fixture always produced: no new kind, and no kind naming an axis");
    same(audit.findings.filter((f) => f.severity === "HIGH").length, 0, "0 HIGH — the axis answer did not make a covered character look uncovered or the reverse");

    // The same fixture with the axis taken off: the coverage answer is identical either way.
    const plain = layFixture("axis-coverage-axisless", { chapters: SOURCE, register: REGISTER });
    const plainRoute = fileThroughTheStageRoute(plain, ENTRIES_NO_AXIS);
    try {
      const plainRendered = renderRebuiltVoice(plainRoute.store, { volume: 1 });
      const plainAudit = auditVolumeRecord(plainRoute.store, {
        title: "Character-voice reference",
        file: "character-voice.md",
        markdown: plainRendered.markdown,
      });
      same(plainAudit.coverage.rows.length, coverage.rows.length, "uncovered characters: the same with or without the axis");
      same(plainAudit.presence, audit.presence, "presence: the same");
      same([plainAudit.counts.facts, plainAudit.counts.cast], [audit.counts.facts, audit.counts.cast], "row counts: the same");
    } finally {
      plainRoute.store.close();
      plainRoute.candidateStore.close();
    }

    console.log(`  coverage: ${coverage.rows.length} uncovered (0 HIGH / 0 MEDIUM), presence ${audit.presence.present}/${audit.presence.measured}, facts ${audit.counts.facts}, cast ${audit.counts.cast}`);
  } finally {
    store.close();
    candidateStore.close();
  }
}

// ─── 5. the axis-less path still works, and says so ───────────────────────────

{
  console.log("5. a series with no declaration: the same claims, and the record says plainly that none answers a question");

  const fixture = layFixture("axis-none", { chapters: SOURCE });
  const { store, candidateStore, result } = fileThroughTheStageRoute(fixture, ENTRIES_NO_AXIS);
  try {
    same(result.filedCount, 4, "the manual doors' path files the same four claims it filed before this slice existed");
    same(result.refused.length, 0, "and refuses nothing");

    const inv = registerAxisInventory(store, { volume: 1 });
    same(inv.declarationState, "absent", "the series wrote no register block");
    same(inv.declaredAxes, [], "so it asks no questions");
    same(inv.claimsTotal, 4, "and holds 4 claims");
    same(inv.claimsAnswering, 0, "0 of them answer a declared question");
    same(inv.claimsAnsweringNone, 4, "all 4 answer none — stated, not hidden");
    same(inv.collapse.claimsAnsweringNone, 4, "and every one of them sits on the aspect the four kinds collapse into");
    same(inv.collapse.labels, [
      { label: "Vocabulary register", claims: 2 },
      { label: "Formality level", claims: 1 },
      { label: "Sentence endings", claims: 1 },
    ], "named by label, which is the only place the distinction still exists for them");

    // An axis-bearing claim on such a series is still refused — slice 3's gate is unmoved.
    const attempted = store.insertFact({
      key: "Marina",
      aspect: "register",
      body: "Answers a superior with usted, on an axis nobody declared.",
      evidence: [{ volume: 1, chapter: "ch0", line: 4, quote: "Usted está equivocado, señor director" }],
      axis: "treatment",
      axisValue: "formal-usted",
    });
    ok(!attempted.ok, "a claim naming a question this series never declared is refused");
    same(attempted.refusal.rule, "register-declaration-absent",
      "by the gate slice 3 built — there is no axis list in the pipeline to fall back on, in any language");
    same(registerAxisInventory(store, { volume: 1 }).claimsTotal, 4, "and it stored nothing");

  } finally {
    store.close();
    candidateStore.close();
  }
}

// ─── 6. the audit report carries both facts ───────────────────────────────────

{
  console.log("6. the report the grader reads prints both halves");

  const declared = layFixture("axis-report-declared", { chapters: SOURCE, register: REGISTER });
  const declaredRoute = fileThroughTheStageRoute(declared, ENTRIES);
  const axisless = layFixture("axis-report-axisless", { chapters: SOURCE });
  const axislessRoute = fileThroughTheStageRoute(axisless, ENTRIES_NO_AXIS);
  try {
    const report = auditVolumeRecord(declaredRoute.store, {
      title: "Character-voice reference",
      file: "character-voice.md",
      markdown: renderRebuiltVoice(declaredRoute.store, { volume: 1 }).markdown,
    }).markdown;

    ok(/## Which register questions this record can answer/.test(report), "the section is in the report");
    ok(/\| claims that answer a declared register question \| \*\*3\*\*/.test(report), "the table row names the answered count");
    ok(/`treatment` \(1\), `voseo` \(2\)/.test(report), "question by question");
    ok(/\| claims that answer no declared question \| \*\*1\*\*/.test(report), "and the unanswered count");
    ok(/sit on the one `register` aspect the extraction's 4 kinds collapse into/.test(report),
      "the collapse is named in the report, not only in a comment");
    ok(/Sentence endings ×1/.test(report), "with the label that is the only place the kind survives");
    ok(/never edited, moved or re-labelled/.test(report), "and the reason the aspect names were not simply changed");
    ok(/extraction candidate row\(s\) about this volume are kept out of every number/.test(report),
      "and the candidates are said to be excluded, so the numbers cannot be read as row counts");

    const plainReport = auditVolumeRecord(axislessRoute.store, {
      title: "Character-voice reference",
      file: "character-voice.md",
      markdown: renderRebuiltVoice(axislessRoute.store, { volume: 1 }).markdown,
    }).markdown;
    ok(/This series declares no register questions/.test(plainReport),
      "a series with no declaration is told plainly that nothing in its record can answer a question");
    ok(/\| claims that answer a declared register question \| \*\*0\*\* — this series declares \*\*no\*\* register questions/.test(plainReport),
      "in the table the grader reads, not only in the prose");
    ok(/4 claim\(s\) in this record answer no declared question/.test(plainReport), "with the count");

    // A glossary audit over the same record does not print it: the answer belongs to the voice artifact.
    const glossaryReport = auditVolumeRecord(declaredRoute.store, {
      title: "Glossary",
      file: "glossary.md",
      markdown: "# Glossary\n\n| term | rendering |\n|---|---|\n| aula | classroom |\n",
    }).markdown;
    ok(!/## Which register questions this record can answer/.test(glossaryReport),
      "and it is not printed on the report that describes glossary.md");

    console.log("  both facts are in the report; the axis-less case is named; the glossary report is left alone");
  } finally {
    declaredRoute.store.close();
    declaredRoute.candidateStore.close();
    axislessRoute.store.close();
    axislessRoute.candidateStore.close();
  }
}

// ─── 7. what the read answers, and what it refuses to answer ──────────────────

{
  console.log("7. the read answers the record's own claims — not every row, not a row outside its span, not a question nobody named");

  const fixture = layFixture("axis-read-scope", { chapters: SOURCE, register: REGISTER });
  const { store, candidateStore } = fileThroughTheStageRoute(fixture, ENTRIES);
  try {
    // (a) A glossary-shaped row that happens to carry an axis is not a character-voice claim.
    const termRow = store.insertFact({
      aspect: "term_usage",
      label: "Term usage",
      body: "Printed as aula; the scene happens in the classroom.",
      evidence: [{ volume: 1, chapter: "ch0", line: 2, quote: "Marina entró en el aula sin golpear." }],
      axis: "treatment",
      axisValue: "formal-usted",
    });
    ok(termRow.ok, "an unkeyed term_usage row naming a declared axis files — the filing gate is not the same thing as the read scope");
    const afterTerm = claimsAnsweringAxis(store, { axis: "treatment", volume: 1 });
    same(afterTerm.claimCount, 1, "and the register question still returns ONE claim: the glossary-shaped row is not a voice claim");
    same(afterTerm.rows.map((row) => row.aspect), ["register"], "the answer carries no term_usage row");
    same(registerAxisInventory(store, { volume: 1 }).claimsTotal, 4, "the inventory counts 4 character-voice claims, not 5 rows in the table");
    same(registerAxisInventory(store, { volume: 1 }).unkeyedClaims, 0,
      "and it is not even counted as an unkeyed claim: 'character-voice claims only' keeps a glossary row out of every number here");

    // (b) The validity span is honoured: a claim that stops applying is not an answer at a later volume.
    const endsAtOne = store.insertFact({
      key: "Marina",
      aspect: "register",
      label: "Formality level",
      body: "Addressed the director with usted, in this volume only.",
      evidence: [{ volume: 1, chapter: "ch0", line: 4, quote: "Usted está equivocado, señor director" }],
      axis: "treatment",
      axisValue: "formal-usted",
      appliesFromVolume: 1,
      appliesToVolume: 1,
    });
    ok(endsAtOne.ok, "a claim whose span closes at volume 1 files");
    same(claimsAnsweringAxis(store, { axis: "treatment", volume: 1 }).claimCount, 2, "asked AT volume 1 it is part of the answer");
    same(claimsAnsweringAxis(store, { axis: "treatment", volume: 2 }).claimCount, 1, "asked at volume 2 it is not — the span is honoured, not ignored");
    same(claimsAnsweringAxis(store, { axis: "treatment", key: "Marina", volume: 1 }).claimCount, 2,
      "and asked about one character at the volume it applies to, both of her treatment claims come back");

    // (c) A voice claim the record holds under no roster entry is still an answer, and is reported as unkeyed.
    const unkeyed = store.insertFact({
      aspect: "register",
      label: "Vocabulary register",
      body: "A narration that uses the office words, filed under nobody.",
      evidence: [{ volume: 1, chapter: "ch0", line: 5, quote: "Renata cerró la puerta sin decir nada." }],
      axis: "voseo",
      axisValue: "usted",
    });
    ok(unkeyed.ok, "a voice claim with no roster entry files");
    const wholeRecord = claimsAnsweringAxis(store, { axis: "voseo", volume: 1 });
    same(wholeRecord.claimCount, 3, "the whole-record question reaches it: Marina, Diego, and the claim filed under nobody");
    same(wholeRecord.characters, 2, "and the character count stays 2 — a claim with no roster entry is not a character");
    same(registerAxisInventory(store, { volume: 1 }).unkeyedClaims, 1, "reported as an unkeyed claim rather than folded into somebody's answer");
    same(claimsAnsweringAxis(store, { axis: "voseo", key: "Marina", volume: 1 }).claimCount, 1,
      "and asked about one character it does not appear, because it belongs to no character");

    const afterPlanting = rowCounts(store);

    // (d) The refusals, each named, each storing nothing.
    const noRecord = claimsAnsweringAxis(null, { axis: "treatment" });
    ok(!noRecord.ok, "with no record open the read refuses rather than answering 'nothing'");
    same(noRecord.refusal.rule, "no-reference-record", "and names the door that opens one");

    const noAxis = claimsAnsweringAxis(store, { volume: 1 });
    ok(!noAxis.ok, "with no question named the read refuses rather than picking one");
    same(noAxis.refusal.rule, "register-axis-not-named", "because the pipeline holds no list of questions to pick from");
    same(noAxis.refusal.detail.declaredAxes, ["treatment", "voseo"],
      "and the refusal names the questions this series DID declare, so the caller is not left guessing");

    const noKey = axisAnswersForCharacter(store, { volume: 1 });
    ok(!noKey.ok, "and the per-character door refuses when no roster entry is named");
    same(noKey.refusal.rule, "no-roster-entry-named", "naming nothing is not the same as finding nothing");

    same(rowCounts(store), afterPlanting, "three refused reads stored nothing");

    // (e) The report branch a declared series with an unanswered record lands in.
    const silent = layFixture("axis-report-declared-silent", { chapters: SOURCE, register: REGISTER });
    const silentRoute = fileThroughTheStageRoute(silent, ENTRIES_NO_AXIS);
    try {
      const silentReport = auditVolumeRecord(silentRoute.store, {
        title: "Character-voice reference",
        file: "character-voice.md",
        markdown: renderRebuiltVoice(silentRoute.store, { volume: 1 }).markdown,
      }).markdown;
      ok(/no claim in this record answers any of them/.test(silentReport),
        "a series that declared questions and got no answers is told so, in those words");
      ok(/\| claims that answer a declared register question \| \*\*0\*\* — this series declares 2 question\(s\) and no claim in this record answers any of them/.test(silentReport),
        "in the table the grader reads, with the declared count");
      ok(/guard 3 exists to report; that guard is not built/.test(silentReport),
        "and the report says which unbuilt guard this fact is the signal for, rather than pretending to be one");
      ok(silentReport.includes("§10.12"), "naming where the reason is written");
    } finally {
      silentRoute.store.close();
      silentRoute.candidateStore.close();
    }

    console.log(
      "  term_usage kept out, span honoured (2 claims at volume 1, 1 at volume 2), 1 unkeyed claim named, 3 refusals named, 0 rows written by a refused read"
    );
  } finally {
    store.close();
    candidateStore.close();
  }
}

// ─── 8. what this slice did not add ───────────────────────────────────────────

{
  console.log("8. no new finding kind, no knob, no new door onto a sealed row");

  const kinds = Object.keys(FINDING_LEVELS);
  same(kinds.length, 70, "the finding level table is still 70 kinds — plan 06 §4.3 guards 3 and 4 are still unbuilt (§10.12)");
  same(kinds.filter((kind) => /axis|register/i.test(kind)), [],
    "and this slice added no kind that names an axis or the register layer");

  const layerFiles = [
    "utils/reference-store/register/answers.js",
    "utils/reference-store/validation/report-axes.js",
    "utils/reference-store/integrity/audit.js",
  ];
  for (const file of layerFiles) {
    const text = readModuleLayer(path.resolve(__dirname, ".."), file);
    ok(!/process\.env/.test(text), `${file} reads no environment variable — a check with a switch is not a check`);
  }

  // The read side is a read: it opens nothing for writing and reaches no sealed row.
  const answersText = readModuleLayer(path.resolve(__dirname, ".."), "utils/reference-store/register/answers.js");
  for (const verb of ["UPDATE ", "DELETE FROM", "INSERT INTO"]) {
    ok(!answersText.includes(verb), `register/answers.js issues no ${verb.trim()} — the read side cannot edit a published row`);
  }
  ok(answersText.includes("currentClaimSql"), "and it answers over the record's current claims, the same predicate all three renderers use");

  // The collapse table is untouched: the aspects are what they were.
  same(Object.values(QUIRK_TYPE_TO_ASPECT).filter((aspect) => aspect === "register").length, 4,
    "the four-into-one mapping is byte-for-byte the mapping slice 4 pinned");

  console.log(`  ${kinds.length} finding kinds, ${layerFiles.length} files read with no knob, no write statement in the read side`);
}

console.log("");
console.log(`axis answers: ${checks} checks, 0 model calls.`);

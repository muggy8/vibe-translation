#!/usr/bin/env node
/**
 * test/test-glossary-extraction-reads.js — a term list that never arrived is not the same thing as a
 * volume with nothing new, and this suite is what keeps the two apart.
 *
 * The defect this file exists for is a `catch`. Both of the glossary stage's reading passes used to
 * parse the model's reply inside a `try`, and on a parse failure log "Continuing without research" /
 * "The chapter files nothing" and hand the stage an empty list. `[]` is also the honest answer for a
 * volume or chapter that genuinely has nothing new, so the two looked identical in the log, in
 * `glossary-new-terms.json`, in the published glossary, and in the coverage audit — which counts rows,
 * not reads. On the whole-installment route that empty list was the volume's ONLY reading pass: a
 * volume whose one read came back as prose published a glossary of carried rows only, and every later
 * volume copied that forward.
 *
 * The scenarios:
 *
 *   1. **A refused shape is re-asked once, and the answer is kept.** The endpoint says it could not
 *      answer in the shape it was asked for; the second read answers; the volume gets its terms and
 *      the attempts record both reads.
 *   2. **Two failed reads are a named hole, not an empty list.** `failed: true`, the failure kind is
 *      named, and the read report prints it as NOTHING READ.
 *   3. **A size failure is not re-asked.** `finish_reason=length` is deterministic; the stage pays for
 *      one read and the error is re-thrown, which is what the stage did before this file existed.
 *   4. **A clean volume prints nothing extra.** The read report is "" when every read answered, so the
 *      grader's report is not padded with a table about nothing.
 *   5. **The hole reaches the report the grader reads, and it is a finding.** Through the stage's own
 *      store door: the validation markdown carries the block, and the finding is HIGH / declared MAJOR.
 *   6. **The chapter-by-chapter pass asks for the `{"terms": […]}` envelope its own parser declares**, and
 *      a chapter whose read never answered is recorded with `failed: true` rather than quietly filing
 *      nothing. The first half is the measurement: the array-rooted shape this pass used to be barred from
 *      sending was refused by this endpoint before it generated — HTTP 400, measured 2026-10-13 against the
 *      replayed request that lost volume 01 chapter 5 — and the list under an object root is the same
 *      contract in the form the endpoint accepts.
 *   7. **The harness refuses an array-rooted schema before it is sent**, and every shape this repository
 *      does send passes the same check.
 *
 * Fixtures only. Nothing here reads the real 17 volumes or any file under the series folder
 * (AGENTS.md rule 8, gotcha 69). No real model call: scenarios 1-3 and 6 stub the call, and scenario 7
 * checks a request field without making one.
 *
 * Run with `npm test`, or standalone: `node test/test-glossary-extraction-reads.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const harness = require("../harness");
const { structuredOutputError, tooBigForOnePassError, acceptanceResponseFormat } = require("../configs/shared");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const glossaryStore = require("../glossary/store");
const { assertShapeIsExpressible } = harness;
const {
  parseTerms,
  termsResponseFormat,
  readTermList,
  extractionReadReport,
  EXTRACTION_MAX_ATTEMPTS,
  EXTRACTION_RETRY_THINKING_LEVEL,
  classifyExtractionFailure,
} = require("../glossary/extract");
const { extractChapterTerms } = require("../glossary/chunked");
const {
  fixtureStoreSeries,
  assertInsideFixture,
} = require("./fixture-reference-store");

/** The finding kind this slice adds, named once so every scenario asks about the same one. */
const KIND = "chapter-extraction-never-answered";

/** A term the fixture's volume 01 text prints ("山田は会計の人である。"). */
const TERM_IN_THE_BOOK = {
  term: "会計",
  rendering: "Accounting",
  note: "Yamada's role; named outright.",
  type: "concept",
  query: "会計",
};

/**
 * The answer one successful read produces, in the shape the prompt and the schema both name.
 *
 * @param {number} count
 * @returns {string}
 */
function termListAnswer(count = 1) {
  const rows = Array.from({ length: count }, (unused, i) => ({
    term: i === 0 ? TERM_IN_THE_BOOK.term : `用語${i}`,
    rendering: i === 0 ? TERM_IN_THE_BOOK.rendering : `Term ${i}`,
    note: "A fixture term.",
    type: "concept",
    query: i === 0 ? TERM_IN_THE_BOOK.term : `用語${i}`,
  }));
  return JSON.stringify(rows);
}

/**
 * Stand in for the model and record every paid read.
 *
 * @param {{answers: Array<() => string>, calls: Array<Object>}} plan - One answer per paid read, in order.
 * @returns {{ask: Function, calls: Array<Object>}}
 */
function scriptedReads(plan) {
  plan.calls = plan.calls || [];
  let n = 0;
  const ask = async ({ attempt, thinkingLevel }) => {
    const call = { attempt, thinkingLevel, answer: null };
    plan.calls.push(call);
    const next = plan.answers[n++];
    if (!next) throw new Error(`the scenario scripted ${n - 1} answer(s) and the pass asked for a ${n}th`);
    call.answer = next();
    return call.answer;
  };
  return { ask, calls: plan.calls };
}

let checks = 0;
/**
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

/**
 * Run one function with `harness.runOneShot` replaced, and restore it afterwards.
 *
 * @param {Function} replacement - What the model call becomes.
 * @param {Function} body - The code to run while it is replaced.
 * @returns {Promise<*>} Whatever `body` returned.
 */
async function withStubbedModel(replacement, body) {
  const original = harness.runOneShot;
  harness.runOneShot = replacement;
  try {
    return await body();
  } finally {
    harness.runOneShot = original;
  }
}

/**
 * Collect what a function writes to stdout/stderr, so a scenario can prove the stage SAID the thing
 * rather than only stored it.
 *
 * @param {Function} body
 * @returns {Promise<{result: *, lines: string[]}>}
 */
async function captureConsole(body) {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const collect = (...args) => lines.push(args.map((a) => String(a)).join(" "));
  console.log = collect;
  console.warn = collect;
  console.error = collect;
  try {
    const result = await body();
    return { result, lines };
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
}

// ─── Scenario 1 ───────────────────────────────────────────────────────────────

/**
 * A refused answer shape is re-asked once, at the retry level, and the answer that arrives is kept.
 *
 * @returns {Promise<void>}
 */
async function scenarioRefusedShapeIsReAskedOnce() {
  const warns = [];
  const plan = {
    answers: [
      () => {
        throw structuredOutputError("the endpoint could not answer in the shape it was asked for");
      },
      () => termListAnswer(2),
    ],
  };
  const { ask, calls } = scriptedReads(plan);
  const { result } = await captureConsole(async () =>
    readTermList({ ask, label: "Volume 01: the term list", warn: (line) => warns.push(line) })
  );

  same(calls.length, EXTRACTION_MAX_ATTEMPTS, `the pass paid ${calls.length} read(s); the budget is ${EXTRACTION_MAX_ATTEMPTS}`);
  same(calls.map((c) => c.attempt), [1, 2], "the reads are numbered, so the report can say which one answered");
  same(calls[0].thinkingLevel, null, "the first read runs at the run's own reasoning level (no level is passed)");
  same(calls[1].thinkingLevel, EXTRACTION_RETRY_THINKING_LEVEL, `the re-ask runs at ${EXTRACTION_RETRY_THINKING_LEVEL}`);
  same(result.failed, false, "a read that answered is not a failure");
  same(result.terms.length, 2, `the answer that arrived was thrown away: ${JSON.stringify(result.terms)}`);
  same(result.attempts.length, 2, "both paid reads are recorded");
  same(result.attempts[0].failure.kind, "shape-refused", "the first attempt records WHICH failure it was");
  same(result.attempts[1].failure, null, "and the second records that it answered");
  ok(warns.some((line) => /refused by the endpoint/.test(line) && line.includes(EXTRACTION_RETRY_THINKING_LEVEL)),
    `the retry was never announced: ${JSON.stringify(warns)}`);

  console.log("1/7: a refused shape is re-asked once at the retry level, both reads are recorded, and the answer is kept");
}

// ─── Scenario 2 ───────────────────────────────────────────────────────────────

/**
 * Two failed reads are a named hole. The list is empty, but it is empty **and said to be empty for the
 * wrong reason** — which is the whole distinction this file exists to make.
 *
 * @returns {Promise<void>}
 */
async function scenarioTwoFailedReadsAreNamed() {
  const warns = [];
  const plan = {
    answers: [
      () => "I could not find any terms in this volume, but here is a summary instead.",
      () => {
        throw structuredOutputError("still cannot answer in the shape it was asked for");
      },
    ],
  };
  const { ask, calls } = scriptedReads(plan);
  const { result } = await captureConsole(async () =>
    readTermList({ ask, label: "Volume 01: the term list", warn: (line) => warns.push(line) })
  );

  same(calls.length, EXTRACTION_MAX_ATTEMPTS, `the pass paid ${calls.length} read(s) and no more`);
  same(result.failed, true, "a list that never arrived is reported as a failure, not as an empty list");
  same(result.terms, [], "the terms are empty — and `failed` is what tells that apart from a volume with nothing new");
  same(result.failure.kind, "shape-refused", `the failure is not named: ${JSON.stringify(result.failure)}`);
  same(result.attempts.map((a) => a.failure.kind), ["unparseable-answer", "shape-refused"], "each read's own failure is recorded");
  ok(warns.some((line) => /NO term list after 2 paid read/.test(line) && /not the same as finding nothing/.test(line)),
    `the stage never said out loud that nothing was read: ${JSON.stringify(warns)}`);

  const report = extractionReadReport(
    [{ id: "volume 01", title: "whole installment", terms: 0, attempts: result.attempts, failed: true }],
    { volume: "01" }
  );
  ok(report.includes("NOTHING READ"), `the read report does not name the failed read:\n${report}`);
  ok(report.includes("produced no term list"), `the report does not say what that means:\n${report}`);
  ok(report.includes("copied forward"), `the report does not say how far the hole travels:\n${report}`);

  console.log("2/7: two failed reads come back as `failed: true` with a named kind, and the report prints NOTHING READ");
}

// ─── Scenario 3 ───────────────────────────────────────────────────────────────

/**
 * A size failure is not re-asked, and the error is re-thrown unchanged.
 *
 * The harness already throws on `finish_reason=length`; re-asking the same request at the same cap pays
 * for a doomed call, and swallowing it would turn the stage's loudest existing failure into a quiet one.
 *
 * @returns {Promise<void>}
 */
async function scenarioSizeFailureIsNotReAsked() {
  const warns = [];
  const plan = {
    answers: [
      () => {
        throw tooBigForOnePassError("the model hit its output token limit (finish_reason=length)");
      },
      () => termListAnswer(1),
    ],
  };
  const { ask, calls } = scriptedReads(plan);
  let thrown = null;
  try {
    await readTermList({ ask, label: "Volume 01: the term list", warn: (line) => warns.push(line) });
  } catch (err) {
    thrown = err;
  }
  ok(thrown !== null, "a size failure was swallowed instead of re-thrown");
  ok(classifyExtractionFailure(thrown) === "ran-out-mid-shape", `the re-thrown error is no longer the size class: ${thrown.message}`);
  same(calls.length, 1, `a doomed second read was paid for: ${calls.length} reads`);
  ok(warns.some((line) => /hit the output cap/.test(line) && /Not re-asked/.test(line)),
    `the stage did not say why it stopped: ${JSON.stringify(warns)}`);

  console.log("3/7: a size failure costs one read and is re-thrown unchanged — the stage's loudest failure is not softened");
}

// ─── Scenario 4 ───────────────────────────────────────────────────────────────

/**
 * A volume whose every read answered adds nothing to its report.
 *
 * @returns {void}
 */
function scenarioACleanVolumePrintsNothingExtra() {
  const attempts = [{ attempt: 1, thinkingLevel: "run default", terms: 4, failure: null }];
  same(extractionReadReport([{ id: "volume 01", terms: 4, attempts }], { volume: "01" }), "", "a clean volume gets no block");
  same(extractionReadReport([], { volume: "01" }), "", "and neither does a volume with no recorded reads");

  const retried = [{ id: "chapter ch5", title: "Fifth Chapter", terms: 3, attempts: [
    { attempt: 1, thinkingLevel: "run default", terms: 0, failure: { kind: "shape-refused", because: "refused" } },
    { attempt: 2, thinkingLevel: EXTRACTION_RETRY_THINKING_LEVEL, terms: 3, failure: null },
  ], failed: false }];
  const block = extractionReadReport(retried, { volume: "02" });
  ok(block.includes("Every read produced a list"), `a chapter that needed a second read is not reported:\n${block}`);
  ok(block.includes("chapter ch5") && block.includes("shape-refused"), `the retry is not in the table:\n${block}`);
  ok(!block.includes("NOTHING READ"), "a read that eventually answered is not named as a hole");

  console.log("4/7: a clean volume prints nothing extra; a chapter that needed its second read is still shown");
}

// ─── Scenario 5 ───────────────────────────────────────────────────────────────

/**
 * The stage's own store door: the hole reaches the validation report the grader reads, and it is a
 * finding with a declared level.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheHoleReachesTheReportTheGraderReads() {
  const fx = fixtureStoreSeries("glossary-extraction-reads");
  const volume = fx.volumes[0];
  const ctx = {
    values: { INSTALLMENT_NUMBER: volume.installmentNumber },
    folderName: volume.folder,
    seriesDir: fx.dir,
    volumeDir: volume.dir,
    previousFolderName: null,
    bundle: { segments: JSON.parse(fs.readFileSync(path.join(volume.dir, `${volume.base}-bundle.meta.json`), "utf8")).segments, sourceFingerprint: "fixture" },
    glossaryOutputFile: path.join(volume.dir, "glossary.md"),
    validationOutputFile: path.join(volume.dir, "glossary-validation.md"),
    refStore: null,
    extractionReads: [],
  };
  const attempt = glossaryStore.openGlossaryRecord(ctx, null);
  assert.ok(attempt.ok, `the record refused: ${attempt.error}`);
  ctx.refStore = attempt.opened.store;
  assertInsideFixture(ctx.refStore.file, fx.dir);

  glossaryStore.fileGlossaryTermRows(ctx, [TERM_IN_THE_BOOK]);
  const rendered = await glossaryStore.renderGlossaryArtifact(ctx);
  assert.ok(rendered.ok, `the render refused: ${JSON.stringify(rendered.refusal)}`);

  // A clean volume first: the audit's report is the audit's, with nothing appended.
  ctx.extractionReads = [{ id: "volume 01", terms: 1, attempts: [{ attempt: 1, thinkingLevel: "run default", terms: 1, failure: null }], failed: false }];
  const clean = await glossaryStore.auditGlossaryArtifact(ctx);
  ok(!clean.markdown.includes("How this volume's terms were read"), "a volume whose read answered got a block about a hole it does not have");
  same(ctx.extractionFindings, [], "and no finding was invented for it");

  // Now the same volume with one read that never answered.
  ctx.extractionReads = [{
    id: "chapter ch5",
    title: "Fifth Chapter",
    terms: 0,
    attempts: [
      { attempt: 1, thinkingLevel: "run default", terms: 0, failure: { kind: "shape-refused", because: "the endpoint refused the shape" } },
      { attempt: 2, thinkingLevel: EXTRACTION_RETRY_THINKING_LEVEL, terms: 0, failure: { kind: "unparseable-answer", because: "prose instead of an array" } },
    ],
    failed: true,
  }];
  const { result: audit, lines } = await captureConsole(() => glossaryStore.auditGlossaryArtifact(ctx));

  ok(audit.markdown.includes("How this volume's terms were read"), "the audit report does not carry the read block");
  ok(audit.markdown.includes("NOTHING READ"), "the report does not name the read that never answered");
  ok(audit.markdown.includes("chapter ch5"), "the report does not say WHICH read it was");
  ok(lines.some((line) => line.includes("HIGH") && line.includes(KIND)), `the stage never said it on the console: ${JSON.stringify(lines)}`);

  same(ctx.extractionFindings.length, 1, "the failed read did not become a finding");
  const finding = ctx.extractionFindings[0];
  same(finding.kind, KIND, "the finding names the wrong kind");
  same(finding.severity, "HIGH", "a chapter nobody read is not a note");
  same(finding.level, FINDING_LEVELS[KIND].level, "the finding does not carry the level the table declares");
  same(finding.level, "MAJOR", "the level table does not declare this kind MAJOR");
  same(finding.step, "glossary", "the finding is not owned by the glossary stage");
  same(finding.volume, volume.installmentNumber, "the finding does not name the volume it is about");
  ok(finding.message.includes("copied forward"), `the finding does not say how far the hole travels: ${finding.message}`);

  ctx.refStore.close();
  ctx.refStore = null;

  console.log(`5/7: the hole is in the report the grader reads, on the console, and is a HIGH finding declared ${finding.level}`);
}

// ─── Scenario 6 ───────────────────────────────────────────────────────────────

/**
 * The chapter-by-chapter pass: it asks for the `{"terms": […]}` envelope, and a chapter whose read never
 * answered is recorded as a failed read rather than quietly filing nothing.
 *
 * The first half is the measurement, not a preference. The array-rooted shape this pass used to be barred
 * from sending was replayed against this endpoint and refused before the model was asked — HTTP 400 before
 * it generates (measured 2026-10-13, replaying the exact request that lost volume 01 chapter 5). The list
 * under an object root is the same contract in a form the endpoint accepts, so the pass now asks for it and
 * the audit compares the wire against `termsResponseFormat()`. What the pass ALSO has, and what fixed the
 * defect before the envelope existed, is `readTermList`: a failed read is re-asked once, and a read that
 * never produced a list is recorded as one.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheChapterPassAsksForTheEnvelopeAndNamesAFailedRead() {
  const fx = fixtureStoreSeries("glossary-extraction-reads-chunked");
  const volume = fx.volumes[0];
  const meta = JSON.parse(fs.readFileSync(path.join(volume.dir, `${volume.base}-bundle.meta.json`), "utf8"));
  const segment = meta.segments[0];
  const ctx = {
    values: { INSTALLMENT_NUMBER: volume.installmentNumber, SERIES_NAME: "Test Story" },
    folderName: volume.folder,
    seriesDir: fx.dir,
    volumeDir: volume.dir,
    bundle: { segments: meta.segments, wholeChars: 100, sourceFingerprint: "fixture" },
    glossaryOutputFile: path.join(volume.dir, "glossary.md"),
    previousGlossaryFile: null,
    termsPrompt: "Volume being processed: 01",
    termsSystemPrompt: "You are a **Terminology Extraction Specialist**.",
    extractionReads: [],
  };

  /** @type {Array<Object>} */
  const requests = [];
  const answers = [
    () => {
      throw structuredOutputError("the endpoint refused the shape");
    },
    () => termListAnswer(1),
  ];
  let n = 0;
  const terms = await withStubbedModel(async (request) => {
    requests.push(request);
    return answers[n++]();
  }, () => extractChapterTerms(ctx, segment, 0));

  same(requests.length, EXTRACTION_MAX_ATTEMPTS, `the chapter paid ${requests.length} read(s)`);
  const envelope = termsResponseFormat();
  for (const request of requests) {
    same(JSON.stringify(request.responseFormat ?? null), JSON.stringify(envelope),
      "the chapter's read did not ask for the envelope its own parser declares (an array-rooted schema is " +
        "refused by this endpoint before it generates, so the list has to sit inside an object)");
  }
  same(requests[1].thinkingLevel, EXTRACTION_RETRY_THINKING_LEVEL, "the re-ask did not run at the retry level");
  ok(requests[1].label.endsWith("-retry"), `the re-ask is not distinguishable in the log: ${requests[1].label}`);
  same(terms.length, 1, "the chapter's terms were lost");
  same(ctx.extractionReads.length, 1, "the chapter was not recorded in the volume's read list");
  same(ctx.extractionReads[0].failed, false, "a chapter that answered on its second read is recorded as a failure");
  same(ctx.extractionReads[0].attempts.length, 2, "the chapter's two paid reads are not recorded");

  // And the failure half: a chapter that never answers is recorded as failed, and still files nothing
  // without pretending the chapter was empty.
  const failedAnswers = [
    () => { throw structuredOutputError("refused"); },
    () => { throw structuredOutputError("refused again"); },
  ];
  let m = 0;
  const failedTerms = await withStubbedModel(async () => failedAnswers[m++](), () => extractChapterTerms(ctx, segment, 0));
  same(failedTerms, [], "a chapter that never answered produced terms out of nowhere");
  same(ctx.extractionReads.length, 2, "the failed chapter was not recorded");
  same(ctx.extractionReads[1].failed, true, "the failed chapter is recorded as if it answered");
  same(ctx.extractionReads[1].id, `chapter ${segment.id}`, "the record does not name the chapter");
  const block = extractionReadReport(ctx.extractionReads, { volume: volume.installmentNumber });
  ok(block.includes(`chapter ${segment.id}`) && block.includes("NOTHING READ"), `the report does not name the chapter:\n${block}`);

  console.log("6/7: the chapter pass asks for the envelope its own parser declares, and a chapter that never answered is recorded as one");
}

// ─── Scenario 7 ───────────────────────────────────────────────────────────────

/**
 * The harness refuses an array-rooted `response_format` before it is sent.
 *
 * This is the guard that turns the measured failure into a local one. Against the real endpoint an
 * array-rooted schema costs an HTTP 400 per call, and the harness re-asks a refused shape `AI_RETRY`
 * times while `readTermList` re-asks once more on top of that — six doomed requests per read, and then an
 * empty artifact. Against the harness's own check it costs nothing and names the fix.
 *
 * @returns {void}
 */
function scenarioTheHarnessRefusesAnArrayRootedShape() {
  const arrayRooted = {
    type: "json_schema",
    json_schema: {
      name: "glossary_new_terms",
      strict: true,
      schema: { type: "array", items: { type: "object", properties: { term: { type: "string" } }, required: ["term"], additionalProperties: false } },
    },
  };
  let thrown = null;
  try {
    assertShapeIsExpressible(arrayRooted, "scenario");
  } catch (err) {
    thrown = err;
  }
  ok(thrown !== null, "an array-rooted JSON Schema was accepted — it is the shape this endpoint refuses before it generates");
  ok(/root is "array"/.test(thrown.message), `the error does not name the root type: ${thrown.message}`);
  ok(/must accept only JSON objects at its root/.test(thrown.message), `the error does not quote the endpoint's own rule: ${thrown.message}`);
  ok(/wrap the array in an object/.test(thrown.message), `the error does not say what to do instead: ${thrown.message}`);

  // The shapes this repository does send must pass the same check, or the guard is decoration. These are the
  // real declared shapes, imported from the modules that declare them — the same three the prompt audit
  // compares the wire against, so a shape that drifts from its parser is caught twice.
  const expressible = [
    acceptanceResponseFormat(),
    require("../glossary/research").researchResponseFormat(),
    termsResponseFormat(),
    require("../character-voice/stages").voiceResponseFormat(),
    require("../style-guide/amend").styleResponseFormat(),
    // A union of objects is expressible too, and so is the shapeless `{ type: "json_object" }`.
    { type: "json_schema", json_schema: { name: "union", schema: { anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "string" } } }] } } },
    { type: "json_object" },
  ];
  for (const shape of expressible) {
    let accepted = true;
    try {
      assertShapeIsExpressible(shape, "scenario");
    } catch (err) {
      accepted = false;
      ok(false, `a shape this repository sends was refused: ${JSON.stringify(shape)} — ${err.message}`);
    }
    ok(accepted, `the guard refused a shape the endpoint accepts: ${JSON.stringify(shape)}`);
  }

  console.log("7/7: the harness refuses an array-rooted schema before it is sent, and every shape this repository does send passes");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  await scenarioRefusedShapeIsReAskedOnce();
  await scenarioTwoFailedReadsAreNamed();
  await scenarioSizeFailureIsNotReAsked();
  scenarioACleanVolumePrintsNothingExtra();
  await scenarioTheHoleReachesTheReportTheGraderReads();
  await scenarioTheChapterPassAsksForTheEnvelopeAndNamesAFailedRead();
  scenarioTheHarnessRefusesAnArrayRootedShape();
  console.log(`OK: ${checks} checks on the glossary stage's term-list reads.`);
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

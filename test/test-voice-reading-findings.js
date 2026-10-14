#!/usr/bin/env node
/**
 * test/test-voice-reading-findings.js — the character-voice reading pass's own findings reach the
 * delivery layer, at the level the table declares.
 *
 * Slice 0 of `character-voice/plan/06-register-declarations.md`. The glossary's read pass already had
 * this pipe (`glossary/store.js` builds `chapter-extraction-never-answered`, `glossary/task.js` hands it
 * to `utils/series-run/findings.js` at the end of every volume it read). The voice stage measured the
 * same facts — which chapters came back whole, which needed a second paid read, which never answered —
 * and printed them only into `character-voice-validation.md` and the run log. That is gotcha 138 in a
 * second stage: a fact a step discovered inside its own process is not on the disk the post-mortem
 * assesses from, so it never reached the assessment, the ledger, the triage or the volume-boundary gate.
 *
 * What this file pins, in order:
 *
 *   1. the finding builder says **nothing** about a volume whose every chapter came back whole — a
 *      chapter with nothing new to report is not damage, and a guard that fires on legitimate material is
 *      a defect (gotcha 130);
 *   2. a chapter kept although its answer came back half is one MEDIUM `voice-chapter-kept-cut-off`, and
 *      the level table declares it **MINOR**;
 *   3. a chapter whose paid reads produced nothing is one HIGH `voice-chapter-never-answered`, declared
 *      **MAJOR** — the sibling of the glossary's kind, and a separate kind because the routing keys on
 *      kind and the glossary row's `why` names the glossary;
 *   4. a mistyped `--chapter=` is not a hole in what the volume read, so it is not a finding;
 *   5. the two levels do different things: the MAJOR is a trigger for the volume-boundary gate and damage
 *      for the triage, the MINOR is neither;
 *   6. through the real door and the real assessment: the finding arrives with the TABLE's level whatever
 *      the stage claimed, the record on disk holds four fields, and a MINOR does not make a step look
 *      broken;
 *   7. **absence is named, not punished**: a character-voice volume with no record is silence, not damage,
 *      and `--dry-run` writes nothing;
 *   8. end to end, 0 real model calls: a planted chapter read that never answers puts the finding on the
 *      disk, the after-step assessment names it once at MAJOR, the ledger counts it, the resume triage
 *      routes it as damage and picks up at that volume, the volumes after it are never paid for, the
 *      resumed pass pays **nothing** for the volume already accepted — **and no halt record is written**,
 *      because the gate assesses a volume only after that volume's work returns and this stage throws
 *      instead. That is measured, pinned, and written up in
 *      `/tmp/opencode/voice-findings-slice0-questions.md`; it is the one place where the slice's brief and
 *      what the code can do disagree;
 *   9. end to end: a chapter kept cut off produces a MINOR, **does not** halt the walk, every volume is
 *      attempted, and the step still reads clean;
 *  10. end to end: a volume whose reading pass never ran writes no record — the record an earlier pass
 *      left stands, byte for byte — and a volume the step never reached is named silent.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder (AGENTS.md rule 8, gotcha 69), and every call site names its own series folder.
 * Zero real model calls: the scripted server in `test/fake-backend.js` answers everything.
 *
 * @module test/test-voice-reading-findings
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const workflow = require("./fake-workflow");
const { startFakeBackend } = require("./fake-backend");
const fx = require("./fixture-series");
const resume = require("../utils/resume");
const act = require("../delivery/act");
const { readLedger } = require("../utils/ledger");
const { runPostMortem, readVolumeHalt, finding, FINDING_LEVELS } = require("../utils/postmortem");
const { haltTriggerFor } = require("../utils/postmortem/halt");
const channel = require("../utils/postmortem/channel");
const { classifyFindings } = require("../utils/resume");
const { reportVolumeFindings } = require("../utils/series-run");
const voiceFindings = require("../character-voice/findings");

const MAJOR_KIND = "voice-chapter-never-answered";
const MINOR_KIND = "voice-chapter-kept-cut-off";
const STEP = "character-voice";
const FIXTURE_ROOT = fx.FIXTURES_ROOT;
const HOOKS_DIR = path.join(FIXTURE_ROOT, "voice-reading-findings-empty-hooks");
const CALIBRATION_FILE = path.join(FIXTURE_ROOT, "voice-reading-findings-token-calibration.json");

/** The three books the end-to-end scenarios walk. */
const FOLDERS = ["Voice Story(01)", "Voice Story(02)", "Voice Story(03)"];
/** The scripted brain reads `volume.stagedFile`; every folder carries volume 02's book under that name. */
const STAGED = "Voice Story(02).txt";
const BOOK = workflow.sourceTextOf(workflow.VOLUMES[1]);

/** A reply that is an answer-shaped non-answer: real prose, no JSON array, `finish_reason=stop`. */
const PROSE_ANSWER =
  "I read this chapter and here is what happens in it: the narrator walks to the roof and talks about the " +
  "pact. There is no list here, only a paragraph, which is exactly how the real failure looked.\n";

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

/** @type {{dir: string, runDir: string, logsDir: string, runHome: string}} Where the live scenario lives. */
let where = null;
/** @type {Object<string, number>} How many voice reads to spoil, keyed `"<volume>/<chapter>"`. */
let plantRemaining = {};

// ─── Part A: the builder, no model call and no disk anywhere ──────────────────

/**
 * One chapter record, in the shape `character-voice/reading.js` hands the stage.
 *
 * @param {string} id
 * @param {Object} [over]
 * @returns {Object}
 */
function chapter(id, over = {}) {
  return {
    id,
    segment: { id, file: `part-${id}.md` },
    entries: over.entries === undefined ? [{ type: "voice", character: "灯里" }] : over.entries,
    reused: Boolean(over.reused),
    paidReads: over.paidReads === undefined ? 1 : over.paidReads,
    cutOff: Boolean(over.cutOff),
    incomplete: Boolean(over.incomplete || over.cutOff),
    attempts: over.attempts === undefined
      ? [{ at: "2026-10-14T00:00:00.000Z", thinkingLevel: "xhigh", claims: 1, cutOff: Boolean(over.cutOff), lostClaims: 0, parseError: null, failure: null }]
      : over.attempts,
    lostClaims: 0,
  };
}

/**
 * 1. A volume whose every chapter came back whole earns nothing.
 *
 * @returns {void}
 */
function testACleanVolumeEarnsNothing() {
  const built = voiceFindings.readingFindings({
    chapters: [chapter("part-01"), chapter("part-02", { entries: [] })],
    refusal: null,
    volume: "01",
  });
  same(built, [], "a clean reading pass builds no finding — an empty answer for a chapter with nothing new in it is not damage");

  const noChapters = voiceFindings.readingFindings({ chapters: [], refusal: null, volume: "01" });
  same(noChapters, [], "and a pass that kept nothing but reported no refusal still invents nothing");
}

/**
 * 2. A chapter kept although its answer came back half is one MEDIUM, declared MINOR.
 *
 * @returns {void}
 */
function testAKeptCutOffChapterIsAMinor() {
  const built = voiceFindings.readingFindings({
    chapters: [
      chapter("part-01"),
      chapter("part-02", {
        entries: [{ type: "voice", character: "灯里" }],
        cutOff: true,
        paidReads: 2,
        attempts: [
          { thinkingLevel: "xhigh", claims: 6, cutOff: true, failure: null },
          { thinkingLevel: "medium", claims: 4, cutOff: true, failure: null },
        ],
      }),
    ],
    refusal: null,
    volume: "02",
  });
  same(built.length, 1, "one cut-off chapter is one finding, not one per paid read");
  same(built[0].kind, MINOR_KIND, "of the kept-cut-off kind");
  same(built[0].severity, "MEDIUM", "at MEDIUM severity");
  same(built[0].level, "MINOR", "at the level the TABLE declares");
  same(built[0].levelDeclared, true, "and the table really does declare it — the MINOR is not the unknown-kind default");
  same(built[0].step, STEP, "owned by the character-voice step");
  same(built[0].volume, "02", "on the volume it happened in");
  same(built[0].file, "character-voice.md", "naming the artifact the hole is missing from");
  ok(/part-02/.test(built[0].message), `the message names the chapter: ${built[0].message}`);
  ok(/xhigh: 6 \(cut off\); medium: 4 \(cut off\)/.test(built[0].message), `and both paid reads: ${built[0].message}`);
  ok(!/level undeclared/.test(built[0].message), "with no disclaimer, because the kind is classified");
}

/**
 * 3–4. A chapter that never answered is one HIGH, declared MAJOR; a mistyped chapter is not a hole.
 *
 * @returns {void}
 */
function testAChapterThatNeverAnsweredIsAMajor() {
  const unparseable = voiceFindings.readingFindings({
    chapters: [chapter("part-01")],
    refusal: {
      rule: "chapter-extraction-unparseable",
      because: "chapter part-02: Unexpected end of JSON input — and the answer never reached its closing bracket, so it was cut off, not merely malformed (paid reads: xhigh: cut off; medium: cut off)",
      fix: "run this command again",
    },
    volume: "02",
  });
  same(unparseable.length, 1, "the refusal is one finding");
  same(unparseable[0].kind, MAJOR_KIND, "of the never-answered kind");
  same(unparseable[0].severity, "HIGH", "at HIGH severity");
  same(unparseable[0].level, "MAJOR", "at the level the table declares — the sibling of the glossary's kind");
  same(unparseable[0].levelDeclared, true, "declared, not defaulted");
  ok(/part-02/.test(unparseable[0].message), `naming the chapter that never answered: ${unparseable[0].message}`);
  ok(/copied from/.test(unparseable[0].message), `and saying where the hole travels: ${unparseable[0].message}`);

  const callFailed = voiceFindings.readingFindings({
    chapters: [],
    refusal: { rule: "chapter-extraction-failed", because: "chapter part-01 (call-failed): the endpoint is down", fix: "run again" },
    volume: "03",
  });
  same(callFailed.map((f) => f.kind), [MAJOR_KIND], "a read that failed for a reason a re-ask cannot fix is the same hole");
  same(callFailed[0].volume, "03", "on the volume it happened in");

  const mistyped = voiceFindings.readingFindings({
    chapters: [],
    refusal: { rule: "unknown-chapter", because: 'this volume has no chapter named "ch99"', fix: "chapters here are: part-01" },
    volume: "01",
  });
  same(mistyped, [], "and a chapter the operator typed wrong is not a hole in what this volume read");

  const both = voiceFindings.readingFindings({
    chapters: [chapter("part-01"), chapter("part-02", { cutOff: true })],
    refusal: { rule: "chapter-extraction-unparseable", because: "chapter part-03: no answer (paid reads: xhigh: cut off; medium: cut off)", fix: "again" },
    volume: "02",
  });
  same(both.map((f) => f.kind), [MINOR_KIND, MAJOR_KIND], "the two are separate findings about separate chapters, in reading order");
}

/**
 * 5. The two levels do different things to the layer.
 *
 * @returns {void}
 */
function testTheLevelsDoDifferentThings() {
  const major = finding("HIGH", MAJOR_KIND, STEP, "02", "character-voice.md", "planted");
  const minor = finding("MEDIUM", MINOR_KIND, STEP, "02", "character-voice.md", "planted");

  same(haltTriggerFor([major]).map((f) => `${f.level} ${f.kind}`), [`MAJOR ${MAJOR_KIND}`], "the MAJOR is a trigger for the volume-boundary gate");
  same(haltTriggerFor([minor]), [], "the MINOR is not: a chapter that came back half does not stop a 17-volume run");

  const routed = classifyFindings([major, minor]);
  same(routed.damage.map((f) => f.kind), [MAJOR_KIND], "the MAJOR is damage the triage acts on");
  same(routed.gaps.map((f) => f.kind), [MINOR_KIND], "the MINOR is a gap it investigates in a batch");
  same(routed.notes, [], "and neither is a line in a report nobody acts on");

  same(FINDING_LEVELS[MAJOR_KIND].level, "MAJOR", "the table declares the never-answered kind MAJOR");
  same(FINDING_LEVELS[MINOR_KIND].level, "MINOR", "and the kept-cut-off kind MINOR");
  ok(FINDING_LEVELS[MAJOR_KIND].why.length > 20, "each row says how far the damage travels, not just a level");
  ok(FINDING_LEVELS[MINOR_KIND].why.length > 20, "including the MINOR, whose row carries the reason it is not a MAJOR");
}

// ─── Part B: the door and the assessment, still no model call ─────────────────

/**
 * Lay out a throwaway two-volume series whose every step looks finished.
 *
 * @param {string} label
 * @returns {Promise<{dir: string, ledgerDir: string, volumes: Array<{folder: string, installmentNumber: string}>}>}
 */
async function cleanFixture(label) {
  return fx.completeSeries(`voice-reading-findings-${label}`, FIXTURE_ROOT);
}

/**
 * The identity of one fixture volume's book, the way the stage would have computed it.
 * @param {{dir: string}} f
 * @param {{folder: string}} volumeEntry
 * @returns {{sourceFile: string, sourceFingerprint: string}}
 */
function identityFor(f, volumeEntry) {
  const file = path.join(f.dir, volumeEntry.folder, "book.epub");
  return { sourceFile: "book.epub", sourceFingerprint: channel.sha256Of(file) };
}

/**
 * Write one channel record through the real door, as the voice stage does.
 *
 * @param {{dir: string}} f
 * @param {{folder: string, installmentNumber: string}} volumeEntry
 * @param {Array<Object>} findings
 * @param {Object} [over]
 * @returns {Promise<Object>}
 */
async function reportThroughTheDoor(f, volumeEntry, findings, over = {}) {
  return reportVolumeFindings({
    step: over.step || STEP,
    volumeEntry,
    volumeDir: path.join(f.dir, volumeEntry.folder),
    bundle: over.bundle === undefined
      ? { originalPath: path.join(f.dir, volumeEntry.folder, "book.epub"), sourceFingerprint: identityFor(f, volumeEntry).sourceFingerprint }
      : over.bundle,
    findings,
    dryRun: over.dryRun,
  });
}

/**
 * 6–7. The finding travels through the door with the table's level; a MINOR does not make a step look
 * broken; a volume that said nothing is named, not damaged; `--dry-run` writes nothing.
 *
 * @returns {Promise<void>}
 */
async function testTheDoorAndTheAssessment() {
  const f = await cleanFixture("door");
  const major = finding("HIGH", MAJOR_KIND, STEP, "02", "character-voice.md", "a planted chapter that never answered");
  const wrote = await reportThroughTheDoor(f, f.volumes[1], [major]);
  same(wrote.written, true, "the voice stage's report is written");
  same(wrote.count, 1, "and carries one finding");

  const raw = JSON.parse(fs.readFileSync(channel.channelRecordPath({ runDir: f.ledgerDir, step: STEP, volume: "02" }), "utf8"));
  same(Object.keys(raw.findings[0]).sort(), ["file", "kind", "message", "severity"], "the record on disk holds exactly the four fields the channel keeps — no level, no step, no volume");
  same(raw.step, STEP, "and it is addressed to the character-voice step");

  const report = await runPostMortem({ step: STEP, seriesDir: f.dir });
  const found = report.findings.filter((x) => x.kind === MAJOR_KIND);
  same(found.length, 1, `the finding reached the assessment (got ${found.length})`);
  same(found[0].volume, "02", "on the volume it was reported about");
  same(found[0].level, "MAJOR", "at the level the TABLE declares");
  same(haltTriggerFor(found).map((f2) => f2.kind), [MAJOR_KIND], "and the volume-boundary gate treats it as a trigger");
  same(report.channel.findings, 1, "the report's channel line agrees");
  same(report.channel.silent, 1, "the other volume said nothing");
  same(report.channel.silentVolumes, ["01"], "and the report names which one");
  ok(/reported nothing/.test(report.markdown), "the Markdown says the step reported nothing about it");

  // A MINOR is real and investigated, and it does not make the step read as broken.
  const f2 = await cleanFixture("minor");
  const minor = finding("MEDIUM", MINOR_KIND, STEP, "01", "character-voice.md", "a planted chapter kept cut off");
  await reportThroughTheDoor(f2, f2.volumes[0], [minor]);
  const minorReport = await runPostMortem({ step: STEP, seriesDir: f2.dir });
  same(minorReport.findings.filter((x) => x.kind === MINOR_KIND).length, 1, "the MINOR reaches the assessment");
  same(minorReport.findings.filter((x) => x.kind === MINOR_KIND)[0].level, "MINOR", "at its declared level");
  same(minorReport.counts.HIGH, 0, "and it is not a HIGH");
  same(minorReport.ok, true, "so the step still reads clean: a chapter that came back half is investigated, not a stop");
  same(haltTriggerFor(minorReport.findings), [], "and it does not halt the walk");

  // Silence is silence.
  const f3 = await cleanFixture("silent");
  const silent = await runPostMortem({ step: STEP, seriesDir: f3.dir });
  same(silent.findings.length, 0, `a finished voice step with no channel record is clean (got: ${silent.findings.map((x) => `${x.severity} ${x.kind}`).join(", ") || "none"})`);
  same(silent.channel.reported, 0, "nothing was reported");
  same(silent.channel.silent, 2, "both volumes are silence");
  same(silent.ok, true, "and silence is not damage");

  // `--dry-run` writes nothing, and a rehearsal complains about nothing.
  const dry = await reportThroughTheDoor(f3, f3.volumes[0], [major], { dryRun: true });
  same(dry.written, false, "--dry-run writes no run record");
  same(dry.reason, "dry-run writes no run records", "and says why");
  ok(!fs.existsSync(channel.channelRecordPath({ runDir: f3.ledgerDir, step: STEP, volume: "01" })), "and nothing landed on the disk");

  // One step's finding is not another step's: the record is honoured only for the step it names.
  const f4 = await cleanFixture("other-step");
  await reportThroughTheDoor(f4, f4.volumes[0], [major]);
  const asGlossary = await runPostMortem({ step: "glossary", seriesDir: f4.dir });
  same(asGlossary.findings.filter((x) => x.kind === MAJOR_KIND).length, 0, "a character-voice record is not read as a glossary finding");
  same(asGlossary.channel.silent, 2, "and the glossary is told it reported nothing, rather than being handed the other step's hole");
}

// ─── Part C: the real runner, the scripted server, the halt and the resume ────

/**
 * The scripted brain, plus the plant.
 *
 * `plantRemaining["<volume>/<chapter>"]` is how many paid reads to spoil for that chapter: 2 is the whole
 * budget, which is what makes a chapter "never answered" rather than "re-read". `mode` decides the shape
 * of the spoiled answer — prose with no array at all (nothing to keep), or a half envelope (claims to
 * keep, and a chapter still cut off after both paid reads).
 *
 * @param {import("./fake-backend").FakeRequest} req
 * @returns {import("./fake-backend").FakeReply}
 */
function reply(req) {
  const answer = workflow.answer(req, { seriesDir: where.dir, log: () => {} });
  const info = workflow.classify(req);
  if (info.kind !== "voice-extract") return answer;
  const nn = ((req.userText || "").match(/Volume (\d{2})/) || [])[1] || (info.volume ? info.volume.installment : null);
  const chapterId = (req.userText || "").match(/chapter "([^"]+)"/) || [];
  const key = `${nn}/${chapterId[1]}`;
  if (!nn || !chapterId[1] || !(plantRemaining[key] > 0)) return answer;
  plantRemaining[key]--;
  if (plantMode === "half") {
    // A half envelope: one claim that arrived, and **the claim array never closed**. This is the real
    // volume-02 shape — the model ending its turn in the middle of the list.
    //
    // Cutting the envelope's own closing brace instead would be wrong, and `reading.js` says so in its own
    // comment: `{"entries": […]` with the outer brace missing has lost no claim, so the reader calls that
    // chapter whole and refuses to spend a paid read on it. The hole has to be the array's.
    const full = JSON.parse(answer.text);
    return { text: `{"entries":[${JSON.stringify(full.entries[0])},` };
  }
  return { text: PROSE_ANSWER };
}

/** @type {"none"|"prose"|"half"} What shape the spoiled answer takes. */
let plantMode = "none";

/**
 * Lay out one throwaway three-volume series with a committed schema-2 plan of record.
 * @param {string} label
 * @returns {{dir: string, runDir: string, logsDir: string, runHome: string}}
 */
function buildFixture(label) {
  const root = path.join(FIXTURE_ROOT, `voice-reading-findings-${label}`);
  const dir = path.join(root, "series");
  const runDir = path.join(dir, ".postmortem");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  for (const folder of FOLDERS) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, folder, STAGED), `${BOOK}\n`, "utf8");
  }
  fs.writeFileSync(
    path.join(dir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: dir,
        seriesName: "Voice Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test/test-voice-reading-findings.js",
        generatedAt: new Date().toISOString(),
        discovery: {
          summary: "three plain-text books, identical fixture text",
          confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
          evidence: ["fixture"],
          excluded: [],
        },
        volumes: FOLDERS.map((folder, i) => ({
          folder,
          sourceFile: `${folder}/${STAGED}`,
          installmentNumber: String(i + 1).padStart(2, "0"),
          title: `Voice Story ${i + 1}`,
          integrity: {
            isNarrative: true,
            confidence: 0.9,
            basis: "fixture: continuous first-person prose with scene breaks, no packaging pages",
          },
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return { dir, runDir, logsDir: path.join(root, "run", "logs"), runHome: path.join(root, "run") };
}

/**
 * Point this process at one fixture: its books, its records, its transcripts.
 * @param {string} label
 * @returns {{dir: string, runDir: string, logsDir: string, runHome: string}}
 */
function useFixture(label) {
  where = buildFixture(label);
  process.env.SERIES_LOCATION = where.dir;
  process.env.POSTMORTEM_DIR = where.runDir;
  process.env.RUN_DIR = where.runHome;
  plantRemaining = {};
  plantMode = "none";
  return where;
}

/** @returns {string[]} The transcript directories of the current scenario, oldest first. */
function transcripts() {
  if (!fs.existsSync(where.logsDir)) return [];
  return fs.readdirSync(where.logsDir).sort().map((d) => path.join(where.logsDir, d));
}

/**
 * What one run transcript billed, per volume.
 *
 * The volume is read out of the call **label** (`<kind>-<NN>[-<chapter>]`), not out of the label's last
 * two digits: a chapter-suffixed label like `character-voice-extract-03-part-01` ends in a number that is
 * a chapter, not a volume, and billing it as volume 01 is how a free reused chapter turns into a paid one.
 *
 * @param {string} transcriptDir
 * @returns {{calls: Object<string, number>, total: number}}
 */
function costOfTranscript(transcriptDir) {
  const calls = {};
  let total = 0;
  const file = path.join(transcriptDir, "summary.log");
  if (!fs.existsSync(file)) return { calls, total };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/\[call-ai\] RESULT \(([^)]+)\) .* total=(\d+)/);
    if (!m) continue;
    const volume = (m[1].match(/(?:^|[-_v])(\d{2})(?=[-_]|$)/) || [])[1];
    if (!volume) continue;
    calls[volume] = (calls[volume] || 0) + 1;
    total++;
  }
  return { calls, total };
}

/**
 * Bill every transcript a step created.
 *
 * Mapped by *set difference*, not by index: a step that retries creates more than one transcript, and
 * indexing one slot would attribute the retry's calls to the next step's bill.
 *
 * @param {string[]} before - The transcript directories that existed before the step ran.
 * @returns {{calls: Object<string, number>, total: number}}
 */
function costSince(before) {
  const known = new Set(before);
  /** @type {Object<string, number>} */
  const calls = {};
  let total = 0;
  for (const dir of transcripts()) {
    if (known.has(dir)) continue;
    const cost = costOfTranscript(dir);
    for (const [volume, n] of Object.entries(cost.calls)) calls[volume] = (calls[volume] || 0) + n;
    total += cost.total;
  }
  return { calls, total };
}

/**
 * Run one step through the real runner, in a child process, and bill its own transcript.
 * @param {string[]} args
 * @param {string} label
 * @returns {Promise<{code: number|null, output: string, billed: number, perVolume: Object<string, number>}>}
 */
async function runStep(args, label) {
  const before = transcripts();
  const { code, output } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "index.js"), ...args], { cwd: ROOT });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(FIXTURE_ROOT, `voice-reading-findings-${label}.log`), out, "utf8");
      resolve({ code: exitCode, output: out });
    });
  });
  plantRemaining = {};
  plantMode = "none";
  const cost = costSince(before);
  return { code, output, billed: cost.total, perVolume: cost.calls };
}

/**
 * Read one file, or null when it is not there.
 * @param {string} file
 * @returns {string|null}
 */
function readOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Snapshot every file in one volume folder.
 * @param {string} dir
 * @returns {Object<string, string>}
 */
function snapshot(dir) {
  /** @type {Object<string, string>} */
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) continue;
    out[name] = fs.readFileSync(full, "utf8");
  }
  return out;
}

/**
 * The channel record for one volume of the current fixture, or null.
 * @param {string} volume
 * @returns {Object|null}
 */
function channelRecord(volume) {
  const file = channel.channelRecordPath({ runDir: where.runDir, step: STEP, volume });
  const raw = readOrNull(file);
  return raw ? JSON.parse(raw) : null;
}

/**
 * 8. End to end: a chapter that never answers puts a MAJOR on the disk, and the resume picks up there.
 *
 * @returns {Promise<void>}
 */
async function testAChapterThatNeverAnswersReachesTheLayer() {
  useFixture("never-answered");
  // Cut the fixture books into several chapters so one planted chapter is one hole in a volume that
  // otherwise reads normally — the shape the real failure has.
  process.env.SOURCE_TEXT_PART_TARGET_CHARS = "200";

  const setup = await runStep(["--stages=extract,glossary"], "setup");
  same(setup.code, 0, "extract and glossary run clean, so the step the triage picks up is the voice stage");
  same(setup.perVolume["01"] > 0, true, "and the setup paid for the glossary — none of it is charged to the step under test");

  plantMode = "prose";
  plantRemaining = { "02/part-02": 2 };
  const failed = await runStep(["--stages=character-voice"], "never-answered");

  ok(failed.code === 1, `the step whose chapter never answered exits non-zero (got ${failed.code})`);
  ok(/chapter-extraction-unparseable/.test(failed.output), "the stage says which rule refused it");
  ok(failed.perVolume["01"] > 0, "volume 01 was built and paid for");
  ok(failed.perVolume["02"] > 0, "volume 02 was attempted and paid for — the failed read is not free");
  ok(!failed.perVolume["03"], "volume 03 was never attempted, so it was never paid for");

  // The record is the thing that makes it a finding at all.
  const record = channelRecord("02");
  ok(record, "the voice stage wrote its findings record into the run's own records");
  same(record.findings.map((f) => f.kind), [MAJOR_KIND], "it holds the finding the reading pass earned");
  ok(!("level" in record.findings[0]), "and it stores no level — the level is the table's, decided when the record is read");
  same(channelRecord("01").findings, [], "volume 01's record says it found nothing");
  same(channelRecord("03"), null, "and the volume the step never reached has no record, which is silence, not damage");

  // **The halt record is not written, and this pins why nobody should be surprised.** The volume-boundary
  // gate assesses a volume AFTER that volume's own work returns (`utils/series-run/loop.js:163-186`); this
  // stage throws instead, so the gate never reaches the volume whose chapter failed. The MAJOR still does
  // everything a MAJOR is for — it is named at its level, counted in the ledger, routed as damage, and the
  // books after it are never paid for — but the pause arrives as a failed step, not as a halt. Making the
  // halt itself appear means publishing a volume with a named hole, which seals it and every later volume
  // copies forward: an owner's decision, written up in `/tmp/opencode/voice-findings-slice0-questions.md`.
  same(readVolumeHalt(STEP), null, "no halt record for a chapter that never answered — the stage threw before the gate could assess that volume");
  ok(!/halted after volume/.test(failed.output), "and the walk prints no halt line, because the walk ended in the refusal itself");

  const reportJson = JSON.parse(readOrNull(path.join(where.runDir, "character-voice.json")));
  const named = reportJson.findings.filter((f) => f.kind === MAJOR_KIND);
  same(named.length, 1, `the after-step assessment names the finding once (got ${named.length})`);
  same(named[0].level, "MAJOR", "at the level the table declares");
  same(named[0].severity, "HIGH", "at the severity the stage's own check produced");
  same(named[0].volume, "02", "against the volume whose chapter it was");
  same(reportJson.channel.findings, 1, "and the report's channel line agrees with it");
  same(reportJson.channel.reported, 2, "two volumes reported");
  same(reportJson.channel.silent, 1, "one reported nothing");
  same(reportJson.channel.silentVolumes, ["03"], "and the report names it rather than blaming it");
  ok(/voice-chapter-never-answered/.test(readOrNull(path.join(where.runDir, "character-voice.md"))), "the Markdown a human reads names it");

  const entry = readLedger().entries.filter((e) => e.step === STEP && e.kind === "assessment").pop();
  ok(entry, "the failed step is recorded in the ledger");
  ok(entry.findingKinds.includes(MAJOR_KIND), `and the kind that caused it (got: ${entry.findingKinds.join(", ") || "none"})`);
  ok(entry.findings.HIGH > 0, "counted, not only narrated");

  // The triage reads it as damage and picks the volume up at the volume whose chapter never answered.
  const state = await resume.readWorkingState({ seriesDir: where.dir });
  const routed = classifyFindings(reportJson.findings);
  ok(routed.damage.some((f) => f.kind === MAJOR_KIND && f.volume === "02"), `the resume triage routes the never-answered chapter as damage (damage: ${routed.damage.map((f) => `${f.kind}@${f.volume}`).join(", ") || "none"})`);
  const plan = resume.planResume(state);
  const planStep = plan.steps.find((s) => s.step === STEP);
  ok(planStep, "the triage has a move for this step");
  same(planStep.fromVolume, "02", "and the repair starts at that volume, not at volume 03");

  // ─── The resume ────────────────────────────────────────────────────────────
  const vol1Dir = path.join(where.dir, FOLDERS[0]);
  const vol1Before = snapshot(vol1Dir);

  const executed = [];
  const acted = await act.runActPlan({
    plan,
    state,
    runStep: async (opts) => {
      const before = transcripts();
      const out = await act.runPipelineStep(opts);
      const cost = costSince(before);
      executed.push({ step: opts.step, ok: out.ok, billed: cost.total, perVolume: cost.calls });
      return out;
    },
  });

  same(acted.exitCode, 0, "the resumed run finishes");
  const voiceRun = executed.find((e) => e.step === STEP);
  ok(voiceRun && voiceRun.ok, `the manager ran character-voice and it finished (executed: ${executed.map((e) => `${e.step}:${e.billed}`).join(", ")})`);
  same(voiceRun.perVolume["01"], undefined, `the volume already accepted was NOT paid for again — 0 calls (perVolume: ${JSON.stringify(voiceRun.perVolume)})`);
  ok(voiceRun.perVolume["02"] > 0, "the volume whose chapter never answered was re-read");
  ok(voiceRun.perVolume["03"] > 0, "and the volume the failed pass never attempted was built");
  same(voiceRun.perVolume["03"], failed.perVolume["01"], "a clean volume costs the same whether it was built in the first pass or in the resumed one");

  for (const [name, text] of Object.entries(vol1Before)) {
    same(snapshot(vol1Dir)[name], text, `volume 01's ${name} is byte-identical after the resume`);
  }

  const after = JSON.parse(readOrNull(path.join(where.runDir, "character-voice.json")));
  same(after.findings.filter((f) => f.kind === MAJOR_KIND).length, 0, "the finding is gone once the chapter that never answered answered");
  same(after.channel.findings, 0, "the channel contributed nothing to the finished step's report");
  same(after.channel.reported, 3, "and every volume reported");
  same(after.channel.silent, 0, "none of them silently");
  same(after.ok, true, `and the step's post-mortem is clean (got: ${after.findings.map((f) => `${f.severity} ${f.kind}`).join(", ") || "none"})`);
  same(channelRecord("02").findings, [], "volume 02's own record now says it found nothing");
  delete process.env.SOURCE_TEXT_PART_TARGET_CHARS;
}

/**
 * 9. End to end: a chapter kept cut off is a MINOR, and the walk is not halted.
 *
 * @returns {Promise<void>}
 */
async function testAKeptCutOffChapterDoesNotHaltTheWalk() {
  useFixture("kept-cut-off");
  process.env.SOURCE_TEXT_PART_TARGET_CHARS = "200";

  await runStep(["--stages=extract"], "kept-extract");

  plantMode = "half";
  plantRemaining = { "02/part-02": 2 };
  const run = await runStep(["--stages=character-voice"], "kept-cut-off");

  same(run.code, 0, `the volume whose chapter came back half still finishes (got ${run.code})`);
  ok(/INCOMPLETE and kept/.test(run.output) || /still cut off/.test(run.output), "and the reading pass says so out loud");

  const record = channelRecord("02");
  same(record.findings.map((f) => f.kind), [MINOR_KIND], "the record carries the kept-cut-off finding, and only that one");
  same(channelRecord("01").findings, [], "the volume whose chapters answered reports nothing");
  same(channelRecord("03").findings, [], "and so does the one after it");

  same(readVolumeHalt(STEP), null, "no halt record: a MINOR is not a trigger, so the walk ran to the end");
  ok(/assessed 3 volume\(s\) inside the step/.test(run.output), "and the volume-boundary gate really did run inside this step — it assessed every volume that finished");
  ok(run.perVolume["03"] > 0, "which is why the volume after it was attempted and paid for");
  const vol3 = fs.readdirSync(path.join(where.dir, FOLDERS[2])).sort();
  ok(vol3.includes("character-voice.md"), "and built its reference");

  const reportJson = JSON.parse(readOrNull(path.join(where.runDir, "character-voice.json")));
  const named = reportJson.findings.filter((f) => f.kind === MINOR_KIND);
  same(named.length, 1, `the assessment names the MINOR once (got ${named.length})`);
  same(named[0].level, "MINOR", "at its declared level");
  same(named[0].volume, "02", "against the volume it happened in");
  same(reportJson.findings.filter((f) => f.severity === "HIGH").length, 0, "and the step has no HIGH finding from it");
  same(reportJson.ok, true, `so the step reads clean (got: ${reportJson.findings.map((f) => `${f.severity} ${f.kind}`).join(", ") || "none"})`);
  ok(/voice-chapter-kept-cut-off/.test(readOrNull(path.join(where.runDir, "character-voice.md"))), "the Markdown a human reads names it");

  // The grader is still shown how the volume was read — the report the channel now mirrors.
  const validation = readOrNull(path.join(where.dir, FOLDERS[1], "character-voice-validation.md"));
  ok(/INCOMPLETE/.test(validation), "character-voice-validation.md still names the incomplete chapter");
  delete process.env.SOURCE_TEXT_PART_TARGET_CHARS;
}

/**
 * 10. A volume whose reading pass never ran writes no record, and the record an earlier pass left stands.
 *
 * @returns {Promise<void>}
 */
async function testAVolumeThatNeverReadWritesNoRecord() {
  useFixture("no-reread");
  process.env.SOURCE_TEXT_PART_TARGET_CHARS = "200";

  await runStep(["--stages=extract"], "no-reread-extract");
  const first = await runStep(["--stages=character-voice"], "no-reread-first");
  same(first.code, 0, "the first pass builds every volume");
  same(first.perVolume["01"] > 0 && first.perVolume["02"] > 0 && first.perVolume["03"] > 0, true, "and pays for all three");

  const before = {
    "01": channelRecord("01"),
    "02": channelRecord("02"),
    "03": channelRecord("03"),
  };
  same(Object.values(before).map((r) => r.findings), [[], [], []], "every volume reported, and every volume found nothing");

  // Second pass: every volume is already accepted, so the reading pass never runs and nothing is written.
  const second = await runStep(["--stages=character-voice"], "no-reread-second");
  same(second.code, 0, "the second pass finishes");
  same(second.billed, 0, "and pays nothing at all — no chapter was read");
  for (const volume of ["01", "02", "03"]) {
    const after = channelRecord(volume);
    same(after.reportedAt, before[volume].reportedAt, `volume ${volume}'s record was not rewritten by a pass that never read the book`);
  }

  // A volume the step never reached is named, not punished.
  const reportJson = JSON.parse(readOrNull(path.join(where.runDir, "character-voice.json")));
  same(reportJson.channel.findings, 0, "the channel contributed nothing to the second pass's report");
  same(reportJson.channel.reported, 3, "the three records the first pass left are still read");
  same(reportJson.channel.silent, 0, "and none of them is silent");
  same(reportJson.ok, true, "and the step reads clean");
  delete process.env.SOURCE_TEXT_PART_TARGET_CHARS;
}

/**
 * The channel is not a voice-stage feature: nothing in the post-mortem or the shared loop knows the word
 * "character-voice", and the two files that ARE the channel read no environment variable.
 *
 * @returns {void}
 */
function testTheChannelIsStillGeneric() {
  const generic = ["utils/postmortem/channel.js", "utils/postmortem/run.js", "utils/series-run/loop.js", "utils/series-run/findings.js"];
  for (const rel of generic) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok(!/"character-voice"/.test(code), `${rel} names no step by name — the channel is not a voice feature`);
    ok(!new RegExp(`"${MAJOR_KIND}"`).test(code), `${rel} names no finding kind — it carries whatever the step reported`);
  }
  // The voice stage's own door is wired at exactly one place, and it is a `finally`.
  const taskSource = fs.readFileSync(path.join(ROOT, "character-voice/task.js"), "utf8");
  ok(/const \{[^}]*\breportVolumeFindings\b[^}]*\} = require\("\.\.\/utils\/series-run"\);/.test(taskSource), "character-voice/task.js reaches the door through the shared series-run barrel, not through the post-mortem's internals");
  same(taskSource.split("reportVolumeFindings(").length - 1, 1, "and it calls it exactly once — one volume, one record");
  ok(/finally \{[\s\S]{0,1200}reportVolumeFindings\(/.test(taskSource), "and that one call sits inside a finally, so a volume that threw still reports what it learned");
}

/** @type {import("./fake-backend").FakeBackend|null} Kept reachable so a red run can still shut it down. */
let activeBackend = null;

async function main() {
  testACleanVolumeEarnsNothing();
  testAKeptCutOffChapterIsAMinor();
  testAChapterThatNeverAnsweredIsAMajor();
  testTheLevelsDoDifferentThings();
  testTheChannelIsStillGeneric();

  await testTheDoorAndTheAssessment();

  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  const backend = await startFakeBackend({ model: ["stub", "stub-translate", "stub-verify", "stub-edit", "stub-audit"], reply });
  activeBackend = backend;
  backend.pointEnvAt({ prefixes: ["TRANSLATE", "VERIFY", "EDIT", "AUDIT"] });

  process.env.AI_CONTEXT_WINDOW = "32768";
  process.env.AI_MAX_TOKENS = "8192";
  process.env.AI_TEMPERATURE = "0.7";
  process.env.AI_RETRY = "0";
  process.env.AI_CALL_DEADLINE_MS = "120000";
  process.env.AI_THINKING = "true";
  process.env.AI_THINKING_LEVEL = "xhigh";
  process.env.STAGE_THINKING_LEVEL = "medium";
  process.env.RESEARCH_ENABLED = "false";
  process.env.AI_CLIENT_HOOKS_DIR = HOOKS_DIR;
  process.env.TOKEN_CALIBRATION_FILE = CALIBRATION_FILE;
  process.env.PASSING_SCORE = "70";
  process.env.ACCEPTANCE_WINDOW_SIZE = "2";
  process.env.QA_MAX_ITERATIONS = "3";
  process.env.STAGE_CONCURRENCY = "1";
  process.env.ON_VOLUME_ERROR = "abort";
  process.env.ON_TASK_ERROR = "abort";
  process.env.ON_MISSING_PREVIOUS = "abort";
  process.env.ON_QA_LIMIT = "fail";
  process.env.AI_BASE_URL = backend.baseUrl;
  process.env.AI_API_KEY = process.env.AI_API_KEY || "stub-key";

  await testAChapterThatNeverAnswersReachesTheLayer();
  await testAKeptCutOffChapterDoesNotHaltTheWalk();
  await testAVolumeThatNeverReadWritesNoRecord();

  await backend.close();
  console.log(`OK: ${checks} checks on the character-voice reading pass's findings reaching the delivery layer.`);
}

main()
  .catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  })
  .finally(() => {
    if (activeBackend) activeBackend.close().catch(() => {});
  });

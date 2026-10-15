#!/usr/bin/env node
/**
 * test/test-finding-channel.js — the pipe from a step's own finding into the delivery layer.
 *
 * `utils/postmortem/channel.js` + `utils/series-run/findings.js` (gotcha 138). Before it existed, a stage
 * could discover something while it was running, describe it perfectly, print it, and lose it: the
 * post-mortem assesses a finished step **from the disk**, and a finding that only ever lived inside the
 * step's process was not on the disk. The live measurement is volume 01 chapter 5 of run
 * `2026-10-13T12-45-22-158Z` — 73,330 tokens spent, 0 terms filed, and the run's ledger recorded
 * 0 HIGH / 0 MEDIUM / 0 LOW for that step.
 *
 * What this file pins, in order:
 *
 *   1. a finding a step reports **reaches** the per-volume assessment, with its level taken from the table;
 *   2. a caller cannot pass a level — the record stores severity/kind/file/message and the reader looks the
 *      level up again, so `level: "STOP"` from a stage still arrives MAJOR;
 *   3. an unknown kind arrives at MINOR **and says so exactly once**;
 *   4. **absence is named, not punished**: a volume with no record is not damaged, and the report says the
 *      step reported nothing for it;
 *   5. a record that does not describe the book being assessed is **stale** — the source file changed, or is
 *      gone, or the record carries no identity — and its findings are not counted;
 *   6. a legitimate volume produces **zero** findings through the channel (gotcha 130's guard: a MAJOR that
 *      fires on real content is a defect, not a guard);
 *   7. `--dry-run` writes nothing and complains about nothing;
 *   8. the door refuses a report with no identity rather than writing one the assessment will throw away;
 *   9. the channel is generic: nothing in the post-mortem or the shared loop knows the word "glossary";
 *  10. the level table is still **68 kinds** and `chapter-extraction-never-answered` is still MAJOR;
 *  11. **end to end, through the real runner**: a glossary chapter read that never answers halts the walk
 *      after that volume, the halt record names the finding, the never-attempted volume is never paid for,
 *      the after-step report names the finding **once**, and the resume path recovers the halted volume
 *      rather than re-paying the accepted one;
 *  12. the same on the **chapter-by-chapter** route, which is a different pass through the same door.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder (AGENTS.md rule 8, gotcha 69), and every call site names its own series folder.
 * Zero real model calls: the scripted server in `test/fake-backend.js` answers everything.
 *
 * @module test/test-finding-channel
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
const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");
const resume = require("../utils/resume");
const act = require("../delivery/act");
const { readLedger } = require("../utils/ledger");
const { runPostMortem, readVolumeHalt, FINDING_LEVELS } = require("../utils/postmortem");
const channel = require("../utils/postmortem/channel");
const { reportVolumeFindings } = require("../utils/series-run");
const { sha256OfFile } = require("../utils/source");

const KIND = "chapter-extraction-never-answered";
const FIXTURE_ROOT = fx.FIXTURES_ROOT;
const HOOKS_DIR = path.join(FIXTURE_ROOT, "finding-channel-empty-hooks");
const CALIBRATION_FILE = path.join(FIXTURE_ROOT, "finding-channel-token-calibration.json");

/** The three books the end-to-end scenarios walk. */
const FOLDERS = ["Channel Story(01)", "Channel Story(02)", "Channel Story(03)"];
/** The scripted brain reads `volume.stagedFile`; every folder carries volume 02's book under that name. */
const STAGED = "Channel Story(02).txt";
const BOOK = workflow.sourceTextOf(workflow.VOLUMES[1]);

/** What the stage's own report says when a read never answered — the wording `glossary/store.js` uses. */
const PLANTED_MESSAGE =
  "chapter part-01: this volume's glossary was built from a term-list read that never produced a list " +
  "(run default: unparseable-answer; medium: unparseable-answer). Every term that read was supposed to find " +
  "is missing from this glossary and from every later volume's, because the glossary is copied forward.";

/** A reply that is an answer-shaped non-answer: real prose, no JSON array, `finish_reason=stop`. */
const PROSE_ANSWER =
  "I read the chapter and here is what happens in it: the narrator walks to the roof and talks about the " +
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
/** @type {Object<string, number>} How many extraction requests to spoil, per installment. */
let plantRemaining = {};

// ─── Part A: the channel's own rules, no model call anywhere ──────────────────

/**
 * Lay out a throwaway two-volume series whose every step looks finished.
 *
 * @param {string} label
 * @returns {Promise<{dir: string, ledgerDir: string, volumes: Array<{folder: string, installmentNumber: string}>}>}
 */
async function cleanFixture(label) {
  const f = await fx.completeSeries(`finding-channel-${label}`, FIXTURE_ROOT);
  return f;
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
 * Write one channel record through the real door (`utils/series-run/findings.js`).
 *
 * @param {{dir: string}} f
 * @param {{folder: string, installmentNumber: string}} volumeEntry
 * @param {Array<Object>} findings
 * @param {Object} [over] - Overrides for the door's inputs, for the refusals.
 * @returns {Promise<Object>} What the door reported.
 */
async function reportThroughTheDoor(f, volumeEntry, findings, over = {}) {
  const bundle = over.bundle === undefined
    ? { originalPath: path.join(f.dir, volumeEntry.folder, "book.epub"), sourceFingerprint: identityFor(f, volumeEntry).sourceFingerprint }
    : over.bundle;
  return reportVolumeFindings({
    step: over.step || "glossary",
    volumeEntry,
    volumeDir: path.join(f.dir, volumeEntry.folder),
    bundle,
    findings,
    dryRun: over.dryRun,
  });
}

/**
 * 1–3. A reported finding reaches the assessment, at the level the TABLE says, whatever the caller claimed.
 *
 * @returns {Promise<void>}
 */
async function testReportedFindingReachesTheAssessment() {
  const f = await cleanFixture("reaches");
  const built = require("../utils/postmortem").finding("HIGH", KIND, "glossary", "01", "glossary.md", PLANTED_MESSAGE);
  const wrote = await reportThroughTheDoor(f, f.volumes[0], [built]);
  same(wrote.written, true, "the door wrote the record");
  same(wrote.count, 1, "and counted one finding into it");

  const report = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  const found = report.findings.filter((x) => x.kind === KIND);
  same(found.length, 1, `the finding the step reported reached the assessment (got ${found.length})`);
  same(found[0].volume, "01", "on the volume it was reported about");
  same(found[0].file, "glossary.md", "naming the file the stage named");
  same(found[0].severity, "HIGH", "at the severity the stage's own check produced");
  same(found[0].level, "MAJOR", "at the level the TABLE declares, which is the level the gate acts on");
  same(found[0].levelDeclared, true, "and the table really does declare it");
  same(report.channel.findings, 1, "the report counts the channel's findings");
  same(report.channel.reported, 1, "one volume reported through the channel");
  same(report.channel.silent, 1, "and the other volume said nothing");
  ok(report.markdown.includes(KIND), "the finding is in the Markdown a human reads");

  // The halt gate reads levels, not severities, so this is the line that matters: the finding the channel
  // carried is a trigger.
  const { haltTriggerFor } = require("../utils/postmortem/halt");
  same(haltTriggerFor(found).map((f2) => `${f2.level} ${f2.kind}`), [`MAJOR ${KIND}`], "and the volume-boundary gate treats it as a trigger");
}

/**
 * 2. A step cannot invent its own level.
 *
 * @returns {Promise<void>}
 */
async function testALevelIsNeverTheCallers() {
  const f = await cleanFixture("level");
  // A stage that tried to grade itself: the object it hands the door carries a level, a levelDeclared flag,
  // and a severity chosen to match. The door keeps four fields and throws the rest away.
  const wrote = await reportThroughTheDoor(f, f.volumes[0], [
    { severity: "LOW", kind: KIND, file: "glossary.md", message: "a stage that claims its own level", level: "STOP", levelDeclared: true },
  ]);
  same(wrote.count, 1, "the finding itself is accepted");

  const raw = JSON.parse(fs.readFileSync(channel.channelRecordPath({ runDir: f.ledgerDir, step: "glossary", volume: "01" }), "utf8"));
  same(Object.keys(raw.findings[0]).sort(), ["file", "kind", "message", "severity"], "and the record on disk holds exactly the four fields the channel is allowed to keep — no level, no flag");

  const report = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  const found = report.findings.filter((x) => x.kind === KIND);
  same(found.length, 1, "the finding still arrives");
  same(found[0].level, "MAJOR", "at the level the table declares — the caller's STOP was dropped on the way in");
  same(found[0].levelDeclared, true, "and it is declared, because the table says so, not because the record said so");
  same(found[0].severity, "LOW", "the severity is the stage's own, and is kept as it was written");

  const { haltTriggerFor } = require("../utils/postmortem/halt");
  same(haltTriggerFor(found).map((x) => x.level), ["MAJOR"], "so a stage that downgraded its own severity still cannot step over the level the gate acts on");
}

/**
 * 3. A kind the table does not know arrives at MINOR, and says so exactly once.
 *
 * @returns {Promise<void>}
 */
async function testAnUnknownKindSaysSo() {
  const f = await cleanFixture("unknown-kind");
  const unknown = "a-kind-nobody-declared-in-this-repository";
  const built = require("../utils/postmortem").finding("HIGH", unknown, "glossary", "01", "glossary.md", "something a stage invented");
  ok(built.message.includes('level undeclared'), "finding() says it when the stage builds it");
  const wrote = await reportThroughTheDoor(f, f.volumes[0], [built]);
  same(wrote.count, 1, "the channel accepts the finding — it is not the channel's job to classify kinds");

  const report = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  const found = report.findings.filter((x) => x.kind === unknown);
  same(found.length, 1, "it reaches the assessment once");
  same(found[0].level, "MINOR", "at the default level");
  same(found[0].levelDeclared, false, "and the report knows the level was defaulted");
  const mentions = (found[0].message.match(/level undeclared/g) || []).length;
  same(mentions, 1, `the disclaimer is printed once, not twice (got ${mentions}) — the round trip through the channel must not re-decorate it`);

  const { classifyFindings } = require("../utils/resume");
  const routed = classifyFindings(found);
  same(routed.damage.map((x) => x.kind), [unknown], "and an undeclared kind fails closed into damage, exactly as a disk finding does");
}

/**
 * 4. A volume the step said nothing about is not damaged, and the report says so.
 *
 * @returns {Promise<void>}
 */
async function testAbsenceIsNamedNotPunished() {
  const f = await cleanFixture("absence");
  const report = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  same(report.findings.length, 0, `a finished step with no channel record is clean (got: ${report.findings.map((x) => x.kind).join(", ") || "none"})`);
  same(report.ok, true, "and the report says so");
  same(report.channel.reported, 0, "no volume reported");
  same(report.channel.silent, 2, "both volumes reported nothing");
  same(report.channel.silentVolumes, ["01", "02"], "and the report names which ones");
  same(report.channel.findings, 0, "and contributed nothing");
  ok(report.channel.stale.length === 0, "nothing was stale");
  ok(/reported nothing/.test(report.markdown), `the Markdown says the step reported nothing:\n${report.markdown}`);
  ok(!/missing-required/.test(report.markdown), "and does not invent damage for the silence");

  // A step that does not walk volumes has no volumes to ask about, so it carries no channel line at all.
  const extract = await runPostMortem({ step: "extract", seriesDir: f.dir });
  same(extract.channel, undefined, "extract walks no volumes, so the channel asks it nothing");
}

/**
 * 5. A record that does not describe the book being assessed is stale, and its findings are not counted.
 *
 * @returns {Promise<void>}
 */
async function testAStaleRecordIsNotThisRunsFinding() {
  const f = await cleanFixture("stale");
  const vol = f.volumes[1];
  const built = require("../utils/postmortem").finding("HIGH", KIND, "glossary", "02", "glossary.md", PLANTED_MESSAGE);
  const wrote = await reportThroughTheDoor(f, vol, [built]);
  same(wrote.written, true, "the record is written against the book that is there now");

  const clean = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  same(clean.findings.filter((x) => x.kind === KIND).length, 1, "and while that book is there, it counts");

  // (a) the book changed under the same name.
  fs.writeFileSync(path.join(f.dir, vol.folder, "book.epub"), "a different book entirely, re-released", "utf8");
  const changed = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  same(changed.findings.filter((x) => x.kind === KIND).length, 0, "a finding about a different book is not counted");
  same(changed.channel.stale.map((s) => s.volume), ["02"], "and the volume is named as stale");
  ok(/not the book there now/.test(changed.channel.stale[0].reason), `the reason says what changed: ${changed.channel.stale[0].reason}`);
  ok(/stale channel record was \*\*not\*\* counted/.test(changed.markdown), "and the Markdown says it was not counted");
  same(changed.ok, true, "a stale record does not make the step look broken — it says the record is out of date");

  // (b) the book is gone.
  fs.rmSync(path.join(f.dir, vol.folder, "book.epub"));
  const gone = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  same(gone.findings.filter((x) => x.kind === KIND).length, 0, "a record whose book is no longer in the folder is not counted");
  same(gone.channel.stale.map((s) => s.volume), ["02"], "and it is named");
  ok(/no longer in the volume folder/.test(gone.channel.stale[0].reason), `and the reason names the missing book: ${gone.channel.stale[0].reason}`);

  // (c) the record carries no identity at all. Fail closed: a record nothing can vouch for cannot halt a run.
  const f2 = await cleanFixture("stale-no-identity");
  const file = channel.channelRecordPath({ runDir: f2.ledgerDir, step: "glossary", volume: "01" });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ schema: 1, step: "glossary", volume: "01", folder: f2.volumes[0].folder, findings: [{ severity: "HIGH", kind: KIND, file: "glossary.md", message: "no identity" }] }, null, 2) + "\n",
    "utf8"
  );
  const noId = await runPostMortem({ step: "glossary", seriesDir: f2.dir });
  same(noId.findings.filter((x) => x.kind === KIND).length, 0, "a record with no source identity is not counted");
  same(noId.channel.stale.map((s) => s.volume), ["01"], "and it is named stale rather than trusted");

  // (d) a record sitting at one step's address that names another step.
  const f3 = await cleanFixture("stale-other-step");
  const file3 = channel.channelRecordPath({ runDir: f3.ledgerDir, step: "glossary", volume: "01" });
  fs.mkdirSync(path.dirname(file3), { recursive: true });
  fs.writeFileSync(
    file3,
    JSON.stringify({ schema: 1, step: "style-guide", volume: "01", folder: f3.volumes[0].folder, identity: identityFor(f3, f3.volumes[0]), findings: [{ severity: "HIGH", kind: KIND, file: "glossary.md", message: "another step's finding" }] }, null, 2) + "\n",
    "utf8"
  );
  const other = await runPostMortem({ step: "glossary", seriesDir: f3.dir });
  same(other.findings.filter((x) => x.kind === KIND).length, 0, "one step's finding is not another step's");
  same(other.channel.stale.map((s) => s.volume), ["01"], "and the mismatch is named, not silently honoured");
}

/**
 * 6. A legitimate volume produces zero findings through the channel. Gotcha 130's guard.
 *
 * @returns {Promise<void>}
 */
async function testALegitimateVolumeReportsNothing() {
  const f = await cleanFixture("legitimate");
  /** @type {string[]} */
  const counts = [];
  for (const v of f.volumes) {
    const wrote = await reportThroughTheDoor(f, v, []);
    same(wrote.written, true, `volume ${v.installmentNumber}: a clean volume's report is written, not skipped`);
    counts.push(wrote.count);
  }
  same(counts, [0, 0], "both volumes reported nothing, and the records exist");

  const report = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  same(report.channel.findings, 0, "the channel contributed zero findings across the whole fixture");
  same(report.channel.reported, 2, "and both volumes were read");
  same(report.channel.silent, 0, "neither is silent any more");
  same(report.findings.length, 0, `a legitimate volume is not damaged by the channel (got: ${report.findings.map((x) => `${x.severity} ${x.kind}`).join(", ") || "none"})`);
  same(report.ok, true, "and the step still reads clean");

  // A second assessment over the same records costs nothing and changes nothing: the channel is idempotent
  // the way the store's own bounded passes are (gotcha 121).
  const again = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  same(again.findings.length, 0, "a second pass over the same records finds the same nothing");
}

/**
 * 7–8. `--dry-run` writes nothing; a report with no identity is refused.
 *
 * @returns {Promise<void>}
 */
async function testTheDoorsRefusals() {
  const f = await cleanFixture("refusals");
  const vol = f.volumes[0];
  const built = require("../utils/postmortem").finding("HIGH", KIND, "glossary", "01", "glossary.md", PLANTED_MESSAGE);

  const dry = await reportThroughTheDoor(f, vol, [built], { dryRun: true });
  same(dry.written, false, "--dry-run writes no run record");
  same(dry.reason, "dry-run writes no run records", "and says why");
  ok(!fs.existsSync(channel.channelRecordPath({ runDir: f.ledgerDir, step: "glossary", volume: "01" })), "and nothing landed on the disk");
  const dryReport = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  same(dryReport.findings.length, 0, "the rehearsal complains about nothing");
  same(dryReport.channel.silent, 2, "both volumes are silence, which is not damage");

  const noBundle = await reportThroughTheDoor(f, vol, [built], { bundle: {} });
  same(noBundle.written, false, "a report that cannot say which book it is about is refused");
  ok(/identity/.test(noBundle.error || ""), `and the refusal says why: ${noBundle.error}`);
  ok(!fs.existsSync(channel.channelRecordPath({ runDir: f.ledgerDir, step: "glossary", volume: "01" })), "and a refused report leaves no half-record behind");

  // A finding the ladder does not have is named, never quietly dropped.
  const bad = await reportThroughTheDoor(f, vol, [{ severity: "CRITICAL", kind: KIND, file: "glossary.md", message: "not a severity" }]);
  same(bad.written, true, "the record is still written");
  same(bad.count, 0, "with the unusable finding left out");
  same(bad.refused.length, 1, "and the refusal is reported");
  const badReport = await runPostMortem({ step: "glossary", seriesDir: f.dir });
  same(badReport.findings.filter((x) => x.kind === KIND).length, 0, "a finding with no severity on the ladder is not invented back into existence");
}

/**
 * 9–10. The channel is generic, the table is unmoved, and nothing here is a switch.
 *
 * @returns {Promise<void>}
 */
async function testTheChannelIsGenericAndTheTableIsUnmoved() {
  same(Object.keys(FINDING_LEVELS).length, 70, "the level table is 70 kinds — the two the character-voice reading pass reports are declared, and this file adds none");
  same(FINDING_LEVELS[KIND].level, "MAJOR", `${KIND} is still MAJOR`);

  const generic = ["utils/postmortem/channel.js", "utils/postmortem/run.js", "utils/series-run/loop.js", "utils/series-run/findings.js"];
  for (const rel of generic) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok(!/"glossary"/.test(code), `${rel} names no step by name — the channel is not a glossary feature`);
    ok(!new RegExp(`"${KIND}"`).test(code), `${rel} names no finding kind — it carries whatever the step reported`);
  }
  // The two files that ARE the channel read nothing from the environment. `run.js` reads the artifact
  // context's pre-existing switches and is not in this assertion: the point is that this slice added none.
  for (const rel of ["utils/postmortem/channel.js", "utils/series-run/findings.js"]) {
    const code = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    same([...code.matchAll(/process\.env\.([A-Z_0-9]+)/g)].map((m) => m[1]), [], `${rel} reads no environment variable — a guard the role can switch off is not a guard`);
  }

  // The channel is not a declared artifact, so it cannot retroactively damage a volume that never used it.
  const { STEP_ARTIFACT_SPECS: specs } = require("../utils/artifacts");
  for (const step of ["glossary", "character-voice", "extract"]) {
    const declared = [...(specs[step].volume || []), ...(specs[step].series || []), ...(specs[step].run || [])].map((e) => e.name);
    ok(!declared.some((n) => /step-findings/.test(n)), `${step} declares no step-findings artifact — absence is silence, not missing-required`);
  }

  // The digest the identity is built from is the digest the rest of the pipeline compares.
  const probe = path.join(FIXTURE_ROOT, "finding-channel-digest-probe.txt");
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  fs.writeFileSync(probe, "the same bytes, hashed two ways\n", "utf8");
  same(channel.sha256Of(probe), await sha256OfFile(probe), "channel.sha256Of agrees with utils/source's sha256OfFile");
  same(channel.sha256Of(path.join(probe, "nope")), null, "and a file that is not there answers null rather than throwing");
}

// ─── Part B/C: the real runner, the scripted server, the halt and the resume ──

/**
 * The scripted brain, plus the plant.
 *
 * The plant is the real defect: an extraction request answered with a paragraph instead of a term list,
 * `finish_reason=stop`, which is what volume 01 chapter 5 of the live run actually did. `readTermList`
 * pays for it twice and then reports `failed: true`, which is what `glossary/store.js` turns into
 * `chapter-extraction-never-answered`.
 *
 * `plantRemaining[volume]` is how many extraction requests to spoil for that volume: 2 is both paid reads of
 * one read pass, so the whole-installment route fails its one read and the chapter-by-chapter route fails
 * its first chapter and answers the rest.
 *
 * @param {import("./fake-backend").FakeRequest} req
 * @returns {import("./fake-backend").FakeReply}
 */
function reply(req) {
  const answer = workflow.answer(req, { seriesDir: where.dir, log: () => {} });
  const info = workflow.classify(req);
  const nn = ((req.userText || "").match(/Volume (\d{2})/) || [])[1]
    || (info.volume ? info.volume.installment : null);
  if (nn && info.kind === "glossary-extract" && (plantRemaining[nn] || 0) > 0) {
    plantRemaining[nn]--;
    return { text: PROSE_ANSWER };
  }
  return answer;
}

/**
 * Lay out one throwaway three-volume series with a committed schema-2 plan of record.
 * @param {string} label
 * @returns {{dir: string, runDir: string, logsDir: string, runHome: string}}
 */
function buildFixture(label) {
  const root = path.join(FIXTURE_ROOT, `finding-channel-${label}`);
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
        seriesName: "Channel Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test/test-finding-channel.js",
        generatedAt: new Date().toISOString(),
        discovery: {
          summary: "three plain-text books, identical fixture text",
          confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
          evidence: ["fixture"],
          excluded: [],
        },
        // The series' own register declaration (plan 06 slice 3), the same two axes the scripted reading
        // pass answers — this fixture runs the real character-voice stage, and that stage now refuses a
        // plan of record with no declaration rather than falling back to a list it does not have.
        register: workflow.FIXTURE_REGISTER_DECLARATION,
        volumes: FOLDERS.map((folder, i) => ({
          folder,
          sourceFile: `${folder}/${STAGED}`,
          installmentNumber: String(i + 1).padStart(2, "0"),
          title: `Channel Story ${i + 1}`,
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
  return where;
}

/** @returns {string[]} The transcript directories of the current scenario, oldest first. */
function transcripts() {
  if (!fs.existsSync(where.logsDir)) return [];
  return fs.readdirSync(where.logsDir).sort().map((d) => path.join(where.logsDir, d));
}

/**
 * What one run transcript billed, per volume.
 * @param {string} transcriptDir
 * @returns {{calls: Object<string, number>, total: number}}
 */
function costOfTranscript(transcriptDir) {
  const calls = {};
  let total = 0;
  const file = path.join(transcriptDir, "summary.log");
  if (!fs.existsSync(file)) return { calls, total };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/\[call-ai\] RESULT \(([a-z0-9-]+?)(\d{2})(?:-[a-z0-9]+)?\) .* total=(\d+)/);
    if (!m) continue;
    calls[m[2]] = (calls[m[2]] || 0) + 1;
    total++;
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
  const before = transcripts().length;
  const { code, output } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "index.js"), ...args], { cwd: ROOT });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(FIXTURE_ROOT, `finding-channel-${label}.log`), out, "utf8");
      resolve({ code: exitCode, output: out });
    });
  });
  plantRemaining = {};
  const list = transcripts();
  const cost = list[before] ? costOfTranscript(list[before]) : { calls: {}, total: 0 };
  return { code, output, billed: cost.total, perVolume: cost.calls };
}

/**
 * The declared outputs of one step for one volume, read from `utils/artifacts.js`.
 * @param {string} step
 * @param {string} installment
 * @returns {string[]}
 */
function declaredOutputs(step, installment) {
  return (STEP_ARTIFACT_SPECS[step].volume || []).map((e) => e.name.replace("{installment}", installment));
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
 * 11. End to end: a chapter read that never answers halts the walk, and the resume recovers it.
 *
 * @returns {Promise<void>}
 */
async function testAChapterThatNeverAnswersHaltsTheWalk() {
  useFixture("halt");

  const extract = await runStep(["--stages=extract"], "extract");
  same(extract.code, 0, "extract runs clean, so the paused step is the one the triage picks up");
  same(extract.billed, 0, "and it pays nothing, so nothing here is paid for by the setup");

  plantRemaining = { "02": 2 };
  const halted = await runStep(["--stages=glossary"], "glossary-halted");

  ok(halted.code === 1, "the step that halted exits non-zero");
  ok(halted.output.includes("halted after volume 02"), `the runner says where it stopped:\n${halted.output.split("\n").filter((l) => /halted|gate/.test(l)).join("\n")}`);
  ok(halted.perVolume["01"] > 0, "volume 01 was built and paid for");
  ok(halted.perVolume["02"] > 0, "volume 02 was built and paid for — the halted volume has already spent its earlier chapters");
  ok(!halted.perVolume["03"], "volume 03 was never attempted, so it was never paid for");

  // The channel record is the thing that made it a finding at all.
  const recordFile = channel.channelRecordPath({ runDir: where.runDir, step: "glossary", volume: "02" });
  ok(fs.existsSync(recordFile), "the step wrote its findings record into the run's own records");
  const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  same(record.findings.map((f) => f.kind), [KIND], "it holds the finding the read pass earned");
  ok(!("level" in record.findings[0]), "and it stores no level");
  same(JSON.parse(fs.readFileSync(channel.channelRecordPath({ runDir: where.runDir, step: "glossary", volume: "01" }), "utf8")).findings, [], "volume 01's record says it found nothing");

  const halt = readVolumeHalt("glossary");
  ok(halt, "the halt left a record");
  same(halt.haltedAfterVolume, "02", "after volume 02");
  same(halt.unattemptedVolumes, ["03"], "and volume 03 was never attempted");
  same(halt.trigger.map((t) => `${t.level} ${t.kind}`), [`MAJOR ${KIND}`], "triggered by the finding the channel carried");

  same(fs.readdirSync(path.join(where.dir, FOLDERS[2])).sort(), [STAGED], "the never-attempted volume's folder holds nothing but the book");

  // The after-step assessment names it ONCE.
  const reportJson = JSON.parse(readOrNull(path.join(where.runDir, "glossary.json")));
  const named = reportJson.findings.filter((f) => f.kind === KIND);
  same(named.length, 1, `the after-step assessment names the finding once, not twice (got ${named.length})`);
  same(named[0].level, "MAJOR", "at the level the table declares");
  same(reportJson.channel.findings, 1, "and the report's own channel line agrees with it");
  const md = readOrNull(path.join(where.runDir, "glossary.md"));
  ok(/The step halted after volume 02/.test(md), "the human-readable report says the step halted on purpose");
  ok(/never attempted/.test(md), "and that the later volume was never attempted");

  const entry = readLedger().entries.filter((e) => e.step === "glossary" && e.kind === "assessment").pop();
  ok(entry, "the halted step is recorded in the ledger");
  same(entry.volume, "02", "against the volume it stopped at");
  ok(entry.findingKinds.includes(KIND), `and the kind that stopped it (got: ${entry.findingKinds.join(", ") || "none"})`);
  ok(entry.findings.HIGH > 0, "counted, not only narrated");

  // The triage reads it as a pause at volume 02, and the repair starts there.
  const state = await resume.readWorkingState({ seriesDir: where.dir });
  same(state.stepStates.find((s) => s.step === "glossary").status, "paused", "the triage reads a halt as a pause");
  const plan = resume.planResume(state);
  const planStep = plan.steps.find((s) => s.step === "glossary");
  same(planStep.actionName, "wipe-and-cascade", "the repair is a wipe plus the cascade");
  same(planStep.fromVolume, "02", "and it resumes at volume 02, not volume 03");

  // ─── The resume ────────────────────────────────────────────────────────────
  const vol1Dir = path.join(where.dir, FOLDERS[0]);
  const vol2Dir = path.join(where.dir, FOLDERS[1]);
  const vol1Before = snapshot(vol1Dir);

  const executed = [];
  const acted = await act.runActPlan({
    plan,
    state,
    runStep: async (opts) => {
      const before = transcripts().length;
      const out = await act.runPipelineStep(opts);
      const dir = transcripts()[before];
      const cost = dir ? costOfTranscript(dir) : { calls: {}, total: 0 };
      executed.push({ step: opts.step, ok: out.ok, billed: cost.total, perVolume: cost.calls });
      return out;
    },
  });

  same(acted.exitCode, 0, "the resumed run finishes");
  const glossaryRun = executed.find((e) => e.step === "glossary");
  ok(glossaryRun && glossaryRun.ok, "the manager ran glossary and it finished");
  same(glossaryRun.perVolume["01"], undefined, "the volume already accepted was NOT paid for again");
  same(glossaryRun.perVolume["03"], halted.perVolume["01"], "a clean volume costs the same whether it was built in the first pass or in the resumed one");
  same(halted.perVolume["02"], halted.perVolume["01"] + 1, "the read that never answered cost exactly ONE extra paid read — the retry — and nothing else");
  same(glossaryRun.perVolume["02"], halted.perVolume["01"], "and the rebuilt volume 02 costs what a clean volume costs: the resume re-reads the halted volume, it does not re-pay the accepted one");
  ok(glossaryRun.perVolume["03"] > 0, "and the volume the halt never attempted was built");

  for (const name of declaredOutputs("glossary", "01")) {
    same(snapshot(vol1Dir)[name], vol1Before[name], `volume 01's ${name} is byte-identical after the resume`);
  }

  same(readVolumeHalt("glossary"), null, "a step that finished does not leave a halt behind");
  const after = JSON.parse(readOrNull(path.join(where.runDir, "glossary.json")));
  same(after.findings.filter((f) => f.kind === KIND).length, 0, "the finding is gone once the read that caused it answered");
  same(after.channel.findings, 0, "the channel contributed nothing to the finished step's report");
  same(after.channel.reported, 3, "and every volume reported");
  same(after.channel.silent, 0, "none of them silently");
  same(after.ok, true, `and the step's post-mortem is clean (got: ${after.findings.map((f) => `${f.severity} ${f.kind}`).join(", ") || "none"})`);
  const afterRecord = JSON.parse(fs.readFileSync(channel.channelRecordPath({ runDir: where.runDir, step: "glossary", volume: "02" }), "utf8"));
  same(afterRecord.findings, [], "volume 02's own record now says it found nothing");
}

/**
 * 12. The chapter-by-chapter route reaches the same door.
 *
 * @returns {Promise<void>}
 */
async function testTheChunkedRouteReachesTheChannel() {
  useFixture("chunked");
  process.env.SOURCE_TEXT_PART_TARGET_CHARS = "200";

  await runStep(["--stages=extract"], "chunked-extract");
  plantRemaining = { "02": 2 };
  const halted = await runStep(["--stages=glossary", "--chunked"], "chunked-glossary");

  ok(halted.code === 1, "the chapter-by-chapter route halts too");
  const halt = readVolumeHalt("glossary");
  ok(halt, "and records the pause");
  same(halt.haltedAfterVolume, "02", "after the volume whose chapter failed");
  same(halt.trigger.map((t) => t.kind), [KIND], "on the same finding kind");
  ok(/part-01/.test(halt.trigger[0].message), `naming the chapter that failed: ${halt.trigger[0].message}`);

  const record = JSON.parse(fs.readFileSync(channel.channelRecordPath({ runDir: where.runDir, step: "glossary", volume: "02" }), "utf8"));
  same(record.findings.map((f) => f.kind), [KIND], "one chapter's failed read is one finding, not one per chapter");
  same(JSON.parse(fs.readFileSync(channel.channelRecordPath({ runDir: where.runDir, step: "glossary", volume: "01" }), "utf8")).findings, [], "and the volume whose chapters all answered reports nothing");

  const vol3 = fs.readdirSync(path.join(where.dir, FOLDERS[2])).sort();
  same(vol3.filter((n) => /^glossary/.test(n)), [], "the next volume was never attempted: its folder holds the extraction parts the extract step wrote, and no glossary output at all");
  ok(vol3.includes(STAGED), "and the book is still there");
  delete process.env.SOURCE_TEXT_PART_TARGET_CHARS;
}

/** @type {import("./fake-backend").FakeBackend|null} Kept reachable so a red run can still shut it down. */
let activeBackend = null;

async function main() {
  await testReportedFindingReachesTheAssessment();
  await testALevelIsNeverTheCallers();
  await testAnUnknownKindSaysSo();
  await testAbsenceIsNamedNotPunished();
  await testAStaleRecordIsNotThisRunsFinding();
  await testALegitimateVolumeReportsNothing();
  await testTheDoorsRefusals();
  await testTheChannelIsGenericAndTheTableIsUnmoved();

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

  await testAChapterThatNeverAnswersHaltsTheWalk();
  await testTheChunkedRouteReachesTheChannel();

  await backend.close();
  console.log(`OK: ${checks} checks on the finding channel from a step's own process into the delivery layer.`);
}

main()
  .catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exitCode = 1;
  })
  .finally(() => {
    if (activeBackend) activeBackend.close().catch(() => {});
  });

/**
 * test/test-reference-store-reopen.js — redoing a published volume, and the guard that stops a stale
 * copy of it from being used.
 *
 * What this suite is for. Volumes 1 and 2 are sealed, and every door that could re-read them refuses a
 * sealed volume. That is correct, and it is also why nothing could redo them: the fix had to be a door
 * that is not a flag switched on in front of the guard. So every scenario here checks one edge of that
 * door — and, as in the other reference-store suites, plants the defect and names the rule a refusal is
 * supposed to carry, because "it stopped" is not a result.
 *
 * The edges:
 *
 *   - a reopen **requires a reason**, and a reason that restates the act is refused;
 *   - reopening a volume that other records were copied from **refuses** and names them, and retires
 *     nothing;
 *   - `cascade: "retire"` retires those too, with the same reason recorded, and the reason **survives in
 *     the fresh record** — the act that records the reopen is not the act that destroys the record of it;
 *   - a record whose source volume was reopened after the copy was made is **refused at the door that
 *     would have topped it up**, because a top-up only ever adds rows;
 *   - a volume that is **not the first** gets the volume before it back when it is reopened: the fresh
 *     record arrives as an empty shell with no provenance row, and the top-up door now recognises that
 *     shape, attaches the source's rows and stamps the copy — while a record with no provenance row and
 *     no reopen row of its own is still refused;
 *   - nothing is unsealed: the retired file still holds its sealed rows, sealed;
 *   - the audit report says the volume was reopened, and why.
 *
 * The second half is the unfinished-prose detector (`utils/reference-store/drafting.js`): a claim whose
 * own prose is unfinished is refused at filing, a citation with the writer's note glued to it is dropped
 * and named while the claim stands, and the audit names every line of a published artifact that carries
 * one. And the calibration cases — a gloss of a Japanese catchphrase — must NOT fire, because a detector
 * that cries wolf is the reason the last guard had to be recalibrated (gotcha 99).
 *
 * Every scenario runs inside `test/fixture-reference-store.js`'s throwaway series. Nothing here can reach
 * the real corpus (AGENTS.md rule 8, gotcha 69). No model, no network.
 *
 * Run with `npm test`, or standalone: `node test/test-reference-store-reopen.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Neither reference-store stage has a setting in front of its record any more, so there is
// nothing here to blank before the store's values are read.

const {
  openReferenceStore,
  openVolumeRecord,
  importVolumeArtifacts,
  sealVolumeRecord,
  auditVolumeRecord,
  copyForwardStore,
  topUpVolumeRecord,
  reopenVolumeRecord,
  readReopenHistory,
  volumeRecordIsStale,
  derivedRecords,
  MIN_REOPEN_REASON_CHARS,
  RETIRED_PREFIX,
  rebuildVoiceFromExtraction,
  renderRebuiltVoice,
  unfinishedProseIn,
  draftingAsides,
  selfContradictions,
  screenClaim,
  unfinishedProseFindings,
  resolveExtractionName,
  DOCUMENT_SOURCE_STAGE,
  REBUILD_SOURCE_STAGE,
  EXTRACTION_SOURCE_STAGE,
} = require("../utils/reference-store");

const {
  fixtureStoreSeries,
  assertInsideFixture,
  GLOSSARY_01,
  VOICE_01,
  EXTRACTION_01,
} = require("./fixture-reference-store");

require("../types"); // JSDoc type definitions

/** A reason long enough to pass the floor, and specific enough to be a reason. */
const REASON = "the extraction pass that built this record swallowed its parse errors in an empty catch";

/**
 * Build a two-volume fixture whose volume 1 is published and sealed, and whose volume 2 is a copy of it.
 *
 * @param {string} label
 * @returns {{series: Object, sealVolume1: () => void}}
 */
function publishedSeries(label) {
  const series = fixtureStoreSeries(label);
  const first = series.volumes[0];
  const store = openReferenceStore({ volume: 1, folder: first.folder, seriesDir: series.dir, stage: DOCUMENT_SOURCE_STAGE });
  assertInsideFixture(store.file, series.dir);
  store.registerChaptersFromSource();
  importVolumeArtifacts(store, { glossaryMarkdown: GLOSSARY_01, voiceMarkdown: VOICE_01 });
  sealVolumeRecord(store);
  store.close();

  const copy = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: series.dir });
  assert.ok(copy.ok, JSON.stringify(copy.refusal));
  if (typeof copy.closeDest === "function") copy.closeDest();
  return { series };
}

/**
 * Seed a fixture volume's roster from the fixture glossary, the way the rebuild suites do.
 *
 * @param {Object} series
 * @param {number} [volume]
 * @returns {void}
 */
function withRoster(series, volume = 1) {
  const entry = series.volumes[volume - 1];
  const store = openReferenceStore({ volume, folder: entry.folder, seriesDir: series.dir, stage: DOCUMENT_SOURCE_STAGE });
  assertInsideFixture(store.file, series.dir);
  importVolumeArtifacts(store, { glossaryMarkdown: GLOSSARY_01 });
  store.close();
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A reopen with no reason, and a reopen with a reason that is the act restated.
 *
 * @returns {void}
 */
function scenarioAReopenRequiresAReason() {
  const { series } = publishedSeries("reopen-reason");
  const folder = series.volumes[0].folder;

  const none = reopenVolumeRecord({ volume: 1, folder, seriesDir: series.dir, reason: "" });
  assert.strictEqual(none.ok, false, "a reopen with no reason is refused");
  assert.strictEqual(none.refusal.rule, "reopen-reason-required", none.refusal && none.refusal.rule);
  assert.ok(fs.existsSync(path.join(series.dir, folder, "series.db")), "and the record is still there");

  const thin = reopenVolumeRecord({ volume: 1, folder, seriesDir: series.dir, reason: "redo" });
  assert.strictEqual(thin.ok, false, "a reason that names the act rather than the reason is refused");
  assert.strictEqual(thin.refusal.rule, "reopen-reason-too-thin", thin.refusal && thin.refusal.rule);
  assert.ok(
    thin.refusal.fix.includes(String(MIN_REOPEN_REASON_CHARS)),
    "and the refusal says what length it wanted, so the caller can supply it"
  );

  fs.rmSync(path.join(series.dir, series.volumes[1].folder, "series.db"), { force: true });
  const nothing = reopenVolumeRecord({ volume: 2, folder: series.volumes[1].folder, seriesDir: series.dir, reason: REASON });
  assert.strictEqual(nothing.ok, false, "a volume with no record is not reopened");
  assert.strictEqual(nothing.refusal.rule, "reopen-nothing-to-reopen", nothing.refusal && nothing.refusal.rule);

  console.log("  reopening a published record requires a reason, and a thin one is refused");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Reopening volume 1 while volume 2's record is a copy of it: refused, and named.
 *
 * @returns {void}
 */
function scenarioReopeningAVolumeWithDerivedRecordsRefusesAndNamesThem() {
  const { series } = publishedSeries("reopen-cascade-refused");

  const result = reopenVolumeRecord({ volume: 1, seriesDir: series.dir, reason: REASON });
  assert.strictEqual(result.ok, false, "a redo that leaves the copies behind is refused");
  assert.strictEqual(result.refusal.rule, "reopen-has-stale-copies", result.refusal && result.refusal.rule);
  assert.ok(result.refusal.because.includes("volume 2"), `and it names the copy: ${result.refusal.because}`);
  assert.ok(
    result.refusal.because.includes("only ever ADDS rows"),
    "and it says why a top-up is the danger rather than the fix"
  );

  assert.ok(fs.existsSync(path.join(series.dir, series.volumes[0].folder, "series.db")), "volume 1's record is untouched");
  assert.ok(fs.existsSync(path.join(series.dir, series.volumes[1].folder, "series.db")), "and so is volume 2's");

  const derived = derivedRecords(series.dir, 1);
  assert.deepStrictEqual(derived.direct.map((d) => d.volume), [2], "the derived-record query is what the refusal read");

  console.log("  redoing a volume other records were built on refuses, and names them");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * `cascade: "retire"` — both records retired, the reason carried into the fresh one, and nothing unsealed.
 *
 * @returns {void}
 */
function scenarioCascadeRetireRetiresBothAndTheReasonSurvives() {
  const { series } = publishedSeries("reopen-cascade-retire");
  const vol1Dir = path.join(series.dir, series.volumes[0].folder);
  const vol2Dir = path.join(series.dir, series.volumes[1].folder);

  const before = fs.readFileSync(path.join(vol1Dir, "series.db"));
  const result = reopenVolumeRecord({ volume: 1, seriesDir: series.dir, reason: REASON, cascade: "retire" });
  assert.ok(result.ok, JSON.stringify(result.refusal));

  assert.ok(result.reopened.was_sealed, "it says the record it threw away was sealed");
  assert.ok(result.reopened.sealed_at, "and when it was sealed");
  assert.ok(result.reopened.rows_at_reopen.facts > 0, `and how many rows it threw away: ${JSON.stringify(result.reopened.rows_at_reopen)}`);
  assert.deepStrictEqual(result.reopened.copies_affected, [2], "and which copies this act marked");

  // The retired file is the record it replaces, plus the one row that says it was replaced: the reopen
  // row is written in before the move, so the act is inside the thing it retires.
  assert.ok(fs.existsSync(result.retired), `retired to ${result.retired}`);
  assert.ok(path.basename(result.retired).startsWith(RETIRED_PREFIX));
  assert.ok(!fs.existsSync(path.join(vol1Dir, "series.db-wal")), "and its write-ahead log went with it");

  assert.strictEqual(result.cascade.length, 1);
  assert.strictEqual(result.cascade[0].volume, 2);
  assert.ok(fs.existsSync(result.cascade[0].retired), "volume 2's record was retired too");

  // The fresh record exists and holds the reopen row: the act survives the act.
  const fresh = openReferenceStore({ volume: 1, folder: series.volumes[0].folder, seriesDir: series.dir, stage: DOCUMENT_SOURCE_STAGE });
  const history = readReopenHistory(fresh);
  assert.strictEqual(history.length, 1, "the fresh record carries the reopen history");
  assert.strictEqual(history[0].reason, REASON);
  assert.strictEqual(history[0].was_sealed, true);
  assert.deepStrictEqual(history[0].copies_affected, [2]);
  fresh.close();

  // Nothing was unsealed: the retired file still reports its rows as sealed.
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(result.retired, { readOnly: true });
  const sealedRows = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE sealed = 1").get().n;
  assert.ok(sealedRows > 0, `the retired record's ${sealedRows} sealed rows are still sealed`);
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS n FROM facts").get().n,
    result.reopened.rows_at_reopen.facts,
    "and the row counts the reopen recorded are the counts the retired file actually holds"
  );
  assert.strictEqual(Buffer.from(fs.readFileSync(result.retired)).length >= before.length, true, "nothing was rewritten out of it");
  const marker = db.prepare("SELECT value FROM store_info WHERE key = ?").get("sealed_volume_1");
  assert.ok(marker, "and the retired record is still sealed");
  db.close();

  console.log("  --cascade=retire retires both records, keeps every sealed row sealed, and records the reason");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A copy that outlived its source's redo is refused at the door that would have used it.
 *
 * The state is built the way it happens for real: the cascade retired volume 2's record, and somebody
 * put it back. The reopen row is in volume 1's fresh record, the copy's own provenance row still names
 * the copy date, and the door that would have topped it up is the one that has to notice.
 *
 * @returns {void}
 */
function scenarioAStaleCopyRefusesToBeOpened() {
  const { series } = publishedSeries("reopen-stale");
  const vol2Dir = path.join(series.dir, series.volumes[1].folder);

  const result = reopenVolumeRecord({ volume: 1, seriesDir: series.dir, reason: REASON, cascade: "retire" });
  assert.ok(result.ok, JSON.stringify(result.refusal));
  const restored = result.cascade[0].retired;

  // Somebody puts the retired copy back.
  fs.renameSync(restored, path.join(vol2Dir, "series.db"));

  const stale = volumeRecordIsStale({ seriesDir: series.dir, volume: 2, folder: series.volumes[1].folder });
  assert.strictEqual(stale.checked, true);
  assert.strictEqual(stale.stale, true, "the copy is stale: its source was reopened after the copy was made");
  assert.strictEqual(stale.sourceVolume, 1);
  assert.strictEqual(stale.reason, REASON, "and the guard can quote the reason back");
  assert.strictEqual(stale.reopensInCopy, 0, "the copy carries none of its source's reopen rows — it predates them");
  assert.strictEqual(stale.reopensInSource, 1, "and the source now carries one");

  const opened = openVolumeRecord({ volume: 2, folder: series.volumes[1].folder, seriesDir: series.dir, previousVolume: 1 });
  assert.strictEqual(opened.ok, false, "and the door that would have topped it up refuses instead");
  assert.strictEqual(opened.refusal.rule, "record-copy-is-stale", opened.refusal && opened.refusal.rule);
  assert.ok(opened.refusal.because.includes(REASON), "the refusal names the reopen that made it stale");
  assert.ok(
    opened.refusal.useInstead.some((line) => line.includes("cascade: \"retire\"")),
    `and the fix it names is the act: ${JSON.stringify(opened.refusal.useInstead)}`
  );

  console.log("  a record copied from a volume that has since been redone refuses to be opened");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * After the redo, the volume is built from the beginning — and the audit report says it was redone.
 *
 * @returns {void}
 */
function scenarioTheAuditReportSaysTheVolumeWasReopened() {
  const { series } = publishedSeries("reopen-audit");
  const folder = series.volumes[0].folder;

  const reopened = reopenVolumeRecord({ volume: 1, seriesDir: series.dir, reason: REASON, cascade: "retire" });
  assert.ok(reopened.ok, JSON.stringify(reopened.refusal));

  const opened = openVolumeRecord({ volume: 1, folder, seriesDir: series.dir });
  assert.ok(opened.ok, JSON.stringify(opened.refusal));
  const store = opened.store;

  const rows = store.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n;
  assert.strictEqual(rows, 0, "the fresh record holds nothing until this run files it");

  importVolumeArtifacts(store, { glossaryMarkdown: GLOSSARY_01, voiceMarkdown: VOICE_01 });
  const audit = auditVolumeRecord(store, { title: "Character-voice reference", file: "character-voice.md", markdown: VOICE_01 });
  assert.strictEqual(audit.reopens.length, 1, "the audit read the reopen out of the record");
  assert.ok(audit.markdown.includes("## This volume's record was reopened"), audit.markdown.slice(0, 400));
  assert.ok(audit.markdown.includes(REASON), "and it printed the reason, not only the fact");

  store.close();
  console.log("  a redone volume's audit report says it was redone, and why");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A copy made immediately after a redo is fresh, and the guard must say so.
 *
 * This is the case the first version of the guard got wrong. It compared the copy's `copied_at` with a
 * count stamped into `copy_provenance.source_reopens` — and the stamp was written from a handle that had
 * already been closed, so it read 0, and volume 2's brand-new copy of a just-redone volume 1 looked stale.
 * A guard that refuses the legitimate re-derivation right after a reopen is worse than no guard: it stops
 * the very run the reopen was performed to make.
 *
 * @returns {void}
 */
function scenarioACopyMadeAfterTheRedoIsNotStale() {
  const { series } = publishedSeries("reopen-fresh-copy");
  const folder1 = series.volumes[0].folder;
  const folder2 = series.volumes[1].folder;

  const reopened = reopenVolumeRecord({ volume: 1, seriesDir: series.dir, reason: REASON, cascade: "retire" });
  assert.ok(reopened.ok, JSON.stringify(reopened.refusal));

  // Volume 1 is re-derived and published again.
  const first = openVolumeRecord({ volume: 1, folder: folder1, seriesDir: series.dir });
  assert.ok(first.ok, JSON.stringify(first.refusal));
  importVolumeArtifacts(first.store, { glossaryMarkdown: GLOSSARY_01, voiceMarkdown: VOICE_01 });
  const sealed = sealVolumeRecord(first.store);
  assert.ok(sealed.ok, JSON.stringify(sealed.refusal));
  first.store.close();

  // Volume 2 is re-derived from it, in the same breath.
  const copy = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: series.dir });
  assert.ok(copy.ok, JSON.stringify(copy.refusal));
  if (typeof copy.closeDest === "function") copy.closeDest();

  const stale = volumeRecordIsStale({ seriesDir: series.dir, volume: 2, folder: folder2 });
  assert.strictEqual(stale.stale, false, "a copy made after the redo is not stale, and the reopen row is inside it to prove it");
  assert.strictEqual(stale.reopensInCopy, stale.reopensInSource, `the copy carries the source's whole reopen history: ${stale.reopensInCopy} vs ${stale.reopensInSource}`);
  assert.strictEqual(stale.reopensInSource, 1, "the source really was reopened");

  // And the door that would have refused it now opens the record and tops it up.
  const opened = openVolumeRecord({ volume: 2, folder: folder2, seriesDir: series.dir, previousVolume: 1 });
  assert.ok(opened.ok, JSON.stringify(opened.refusal));

  // The reopen row travelled in with the copy, and the report has to say whose it is. Volume 2 was never
  // reopened itself — its record was retired by the cascade and rebuilt from scratch — so a report that
  // only prints "this volume was redone" leaves the reader of a rebuilt volume with no sign that its whole
  // foundation is a redo.
  importVolumeArtifacts(opened.store, { glossaryMarkdown: GLOSSARY_01, voiceMarkdown: VOICE_01 });
  const audit = auditVolumeRecord(opened.store, { title: "Character-voice reference", file: "character-voice.md", markdown: VOICE_01 });
  assert.ok(audit.reopens.some((r) => r.volume === 1), `the source's reopen row is inside this record: ${JSON.stringify(audit.reopens.map((r) => r.volume))}`);
  assert.ok(!audit.reopens.some((r) => r.volume === 2), "and volume 2 has no reopen row of its own");
  assert.ok(audit.markdown.includes("rebuilt from a volume that was reopened"), audit.markdown.slice(0, 400));
  assert.ok(!audit.markdown.includes("## This volume's record was reopened"), "the section that says THIS volume was redone is not printed for a volume that was not");
  assert.ok(audit.markdown.includes(REASON), "and the reason is quoted, so a reader can tell what the foundation was thrown away for");

  opened.store.close();

  console.log("  a record copied right after a redo is fresh, and the guard says so");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A reopen voids the grades the retired record was accepted on.
 *
 * @returns {void}
 */
function scenarioAReopenVoidstheGradesOfTheRecordItRetires() {
  const { series } = publishedSeries("reopen-grades");
  const vol1Dir = path.join(series.dir, series.volumes[0].folder);
  const vol2Dir = path.join(series.dir, series.volumes[1].folder);

  // The window a real run leaves behind: one grade, and the fingerprint that lets a re-run reuse it.
  const windowFile = "character-voice-validation-rolling-state.json";
  const window = { results: [48], lastCheckedAt: "2026-10-10T08:18:03.752Z", sourceFingerprint: "b1bda35a9e9e", gradeAttempts: 1, gradeFailures: 0 };
  fs.writeFileSync(path.join(vol1Dir, windowFile), JSON.stringify(window), "utf8");
  fs.writeFileSync(path.join(vol2Dir, windowFile), JSON.stringify({ results: [82], sourceFingerprint: "aa" }), "utf8");

  const result = reopenVolumeRecord({ volume: 1, seriesDir: series.dir, reason: REASON, cascade: "retire" });
  assert.ok(result.ok, JSON.stringify(result.refusal));

  assert.strictEqual(result.windows.length, 2, "both volumes' windows are voided: the reopened one and the one retired by the cascade");
  assert.deepStrictEqual(result.windows.map((w) => w.volume), [1, 2]);
  for (const w of result.windows) {
    const dir = w.volume === 1 ? vol1Dir : vol2Dir;
    assert.ok(!fs.existsSync(path.join(dir, windowFile)), `volume ${w.volume}'s window is no longer where the next run would read it`);
    assert.ok(fs.existsSync(w.retired[0].retired), `and it is kept, named, beside the record it graded: ${path.basename(w.retired[0].retired)}`);
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(result.windows[0].retired[0].retired, "utf8")).results[0], 48, "the voided grade is still readable");

  console.log("  a reopen retires the acceptance grades with the record they graded");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The detector's two shapes, measured against the prose this project has actually published.
 *
 * @returns {void}
 */
function scenarioTheDetectorFiresOnTheTwoRealDefectsAndNowhereElse() {
  // Shape 1: the drafting aside volume 01 published.
  const aside = "Refined vocabulary. — e.g. 「私の鞄の中に隠してある可能性が高いわ」 (wait, this is パンジー — need to recheck)";
  const hits1 = unfinishedProseIn(aside);
  assert.strictEqual(hits1.length, 1, JSON.stringify(hits1));
  assert.strictEqual(hits1[0].kind, "aside");
  assert.strictEqual(hits1[0].span, "wait, this is パンジー — need to recheck");

  // Shape 2: the claim volume 02 published, quoting a token five times while saying it is not there.
  const contradiction = "New ending patterns: '〜じゃないとね', '〜しちゃう', '〜に決まってます', '〜Fantastic' — no, '〜Fantastic' not present. '〜Fantastic' not present. '〜Fantastic' not present.";
  const hits2 = unfinishedProseIn(contradiction);
  assert.strictEqual(hits2.length, 1, JSON.stringify(hits2));
  assert.strictEqual(hits2[0].kind, "contradiction");
  assert.strictEqual(hits2[0].span, "〜Fantastic");
  assert.strictEqual(hits2[0].times, 4, "the token appears four times in this copy of the bullet");

  // The calibration cases. Each of these is legitimate analysis in this series' own published reference,
  // and a detector that flagged them is the detector that had to be recalibrated last slice (gotcha 99).
  const legitimate = [
    // A gloss of a catchphrase. "well, not really" is the character dismissing something.
    "Recurring softening phrases: 'ま、いっか' (well, whatever), 'って言うか' (I mean / rather), 'まぁ別に' (well, not really).",
    // An annotation about whose voice a line is in.
    "Uses '〜かい' for formal constructions. — e.g. 「この人と毎日会えて会話できることこそが、まさに生徒会の醍醐味と言ってもいいだろう！」 (僕's narration using her register)",
    // A list of five quoted expressions: repetition alone is not a defect.
    "Her inner state is revealed through observation: '不安な表情', '顔がものすごく近く', '子供っぽい表情', '顔を真っ赤にしている', '不安そう'.",
    // Analysis that weighs alternatives, in the writer's own voice, without a job left undone.
    "Formality is plain but not sloppy; she uses the polite form when addressing an adult she does not know.",
    // A glossary row describing what a character is doing — the phrase "to verify" is the character's purpose.
    "She shadows him at school to verify or clear the three-timing suspicion.",
  ];
  for (const line of legitimate) {
    assert.deepStrictEqual(unfinishedProseIn(line), [], `false positive on legitimate prose: ${line}`);
  }

  // Each half alone is too loose, and the shipped rule is the intersection.
  assert.deepStrictEqual(selfContradictions("Recurring phrases: 'a', 'a', 'a'."), [], "repetition alone does not fire");
  assert.deepStrictEqual(selfContradictions("She uses the polite form; the casual form is not present."), [], "a hedge alone does not fire");
  assert.deepStrictEqual(draftingAsides("(well, whatever)"), [], "a gloss alone does not fire");

  console.log("  the unfinished-prose detector fires on the two real defects and on none of the calibration cases");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Filing time: a claim whose own prose is unfinished is refused; a dirty citation is dropped and the
 * claim stands.
 *
 * @returns {void}
 */
function scenarioFilingRefusesUnfinishedProseAndDropsADirtyCitation() {
  const dirtyClaim = {
    type: "voice",
    character: "三色院菫子（パンジー）",
    quirkType: "vocabulary",
    description: "Narration about her is flat and bookish. (wait, need to recheck which chapter this was in)",
    examples: ["三色院菫子は本を読んでいた。"],
    formalityLevel: "formal",
  };
  const dirtyCitation = {
    type: "voice",
    character: "如月雨露（ジョーロ）",
    quirkType: "pronoun",
    description: "First person is 俺 throughout the prologue.",
    examples: [
      "さぁ、今日も俺の熱き血潮を迸らせるぜ！",
      "さぁ、今日も俺の熱き血潮を迸らせるぜ！ (wait, this is Panzy — need to recheck)",
    ],
    formalityLevel: "casual",
  };

  const screened = screenClaim({ body: dirtyClaim.description, examples: dirtyClaim.examples });
  assert.strictEqual(screened.ok, false, "a claim whose own prose is unfinished is not adopted");
  assert.ok(screened.because.includes("drafting aside"), screened.because);

  const kept = screenClaim({ body: dirtyCitation.description, examples: dirtyCitation.examples });
  assert.strictEqual(kept.ok, true, "a claim whose citation is dirty is still a claim");
  assert.strictEqual(kept.examples.length, 1, "and the dirty citation is dropped");
  assert.strictEqual(kept.dropped.length, 1);
  assert.ok(kept.dropped[0].example.includes("need to recheck"), kept.dropped[0].example);

  // Through the filing door itself: the refusal is reported, and the record keeps the extraction's own
  // copy of what the extractor wrote.
  const series = fixtureStoreSeries("drafting-filing");
  withRoster(series);
  const entry = series.volumes[0];
  const store = openReferenceStore({ volume: 1, folder: entry.folder, seriesDir: series.dir, stage: REBUILD_SOURCE_STAGE });
  assertInsideFixture(store.file, series.dir);
  store.registerChaptersFromSource();
  const candidateStore = openReferenceStore({ volume: 1, folder: entry.folder, seriesDir: series.dir, stage: EXTRACTION_SOURCE_STAGE });
  const result = rebuildVoiceFromExtraction(store, [dirtyClaim, dirtyCitation], { candidateStore });
  candidateStore.close();

  const proseRefusals = result.refused.filter((r) => String(r.because).includes("not finished writing"));
  assert.strictEqual(proseRefusals.length, 1, `the unfinished claim is refused and named: ${JSON.stringify(result.refused)}`);
  assert.strictEqual(result.screened.length, 1, "and the dropped citation is reported, not swallowed");
  assert.strictEqual(result.screened[0].dropped.length, 1);

  const adopted = store.db.prepare("SELECT body, examples FROM facts WHERE source_stage = ?").all(REBUILD_SOURCE_STAGE);
  assert.strictEqual(adopted.length, 1, "only the sound claim was adopted");
  assert.ok(!JSON.stringify(adopted[0]).includes("need to recheck"), "and the published row carries no drafting note");

  const candidates = store.db.prepare("SELECT body FROM facts WHERE source_stage = ?").all(EXTRACTION_SOURCE_STAGE);
  assert.ok(
    candidates.some((row) => String(row.body).includes("need to recheck")),
    "the extraction's own copy keeps the extractor's note, so the record still shows what it wrote"
  );

  store.close();
  console.log("  an unfinished claim is refused at filing, and a dirty citation is dropped and named");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Audit time: the published artifact is asked the same question, because a defect can arrive through a
 * copy-forward from an older record.
 *
 * @returns {void}
 */
function scenarioTheAuditNamesEveryLineThatCarriesADraftingNote() {
  const markdown = [
    "# Character voice reference",
    "",
    "## Cosmos",
    "",
    "- **Vocabulary register**: Refined. — e.g. 「畏かしこまりました」 (wait, this is Panzy — need to recheck)",
    "- **Sentence endings**: New: '〜Fantastic' — no, '〜Fantastic' not present. '〜Fantastic' not present. '〜Fantastic' not present.",
    "- **Catchphrase**: 'ま、いっか' (well, whatever). This one is legitimate.",
    "",
  ].join("\n");

  const findings = unfinishedProseFindings(markdown, { file: "character-voice.md", volume: 1 });
  assert.strictEqual(findings.length, 1, "one finding, naming every line");
  assert.strictEqual(findings[0].severity, "MEDIUM", "a drafting note is a defect, not a corrupted record");
  assert.strictEqual(findings[0].kind, "reference-claim-carries-unfinished-prose");
  assert.ok(findings[0].message.includes("line 5"), findings[0].message);
  assert.ok(findings[0].message.includes("line 6"), findings[0].message);
  assert.ok(!findings[0].message.includes("line 7"), `the legitimate line is not named: ${findings[0].message}`);
  assert.ok(findings[0].message.includes("drafting aside"), findings[0].message);

  console.log("  the audit names every published line that carries the writer's own drafting work");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A bare first-person pronoun never becomes a roster entry, and the claims it was filed under are named.
 *
 * The old behaviour: the resolver fell through and created a cast entry keyed `俺`, so volume 01's real
 * record held `俺` (20 claims) beside `如月雨露` (188) and volume 02's held `俺` (282) beside 如月雨露
 * (190) — one person in two places, and a published reference whose protagonist section is headed with the
 * word for "I" (gotcha 115). The guard that was supposed to close the split read an *authored* heading, and
 * on the read-then-assemble route there is no authored heading to read.
 *
 * The new behaviour is checked here in both directions: the claims are **kept** (with the name the
 * extraction used, in `extracted_as`) and **reported**, and the roster gains no entry. Nothing is merged,
 * because deciding that 俺 is 如月雨露 is a decision about a person.
 *
 * @returns {void}
 */
function scenarioAPronounIsNeverARosterEntry() {
  const series = fixtureStoreSeries("pronoun-roster");
  const entry = series.volumes[0];
  const opened = openVolumeRecord({ volume: 1, folder: entry.folder, seriesDir: series.dir });
  assert.ok(opened.ok, JSON.stringify(opened.refusal));
  const store = opened.store;
  assertInsideFixture(store.file, series.dir);
  store.registerChaptersFromSource();
  importVolumeArtifacts(store, { glossaryMarkdown: GLOSSARY_01 });

  const markdown = [
    "# Character voice reference",
    "",
    "## Characters",
    "",
    "### 俺",
    "",
    "- **Pronouns**: First person is 俺 in the second half of the chapter. — e.g. 「さぁ、今日も俺の熱き血潮を迸らせるぜ！」",
    "",
    "### 如月雨露",
    "",
    "- **Pronouns**: First person is 僕 in the opening. — e.g. 「僕の名前は如月雨露。通称ジョーロ。」",
    "",
  ].join("\n");
  importVolumeArtifacts(store, { voiceMarkdown: markdown });

  // No roster entry was made out of the pronoun.
  const cast = store.db.prepare("SELECT key, merged_into AS mergedInto FROM cast ORDER BY key").all();
  assert.ok(!cast.some((row) => row.key === "俺"), `the roster gained a pronoun entry: ${JSON.stringify(cast.map((r) => r.key))}`);
  assert.ok(cast.every((row) => !row.mergedInto), `nothing was merged: ${JSON.stringify(cast)}`);

  // The claims are still there, with the name they were written under.
  const unattached = store.db
    .prepare("SELECT id, key, extracted_as AS extractedAs FROM facts WHERE key IS NULL AND extracted_as IS NOT NULL")
    .all();
  assert.strictEqual(unattached.length, 1, JSON.stringify(unattached));
  assert.strictEqual(unattached[0].extractedAs, "俺", "the claim kept the heading it was published under");

  const audit = auditVolumeRecord(store, { title: "Character-voice reference", file: "character-voice.md", markdown });
  const finding = audit.findings.filter((f) => f.kind === "reference-claim-filed-without-a-roster-entry");
  assert.strictEqual(finding.length, 1, JSON.stringify(audit.findings.map((f) => f.kind)));
  assert.strictEqual(finding[0].severity, "MEDIUM", "the claims are real; what is missing is who they belong to");
  assert.ok(finding[0].message.includes("俺"), finding[0].message);
  assert.ok(finding[0].message.includes("cast_alias"), "and the fix it names is the door a person uses, not a rule that picks a person");
  assert.ok(audit.markdown.includes("claims filed with no roster entry"), audit.markdown.slice(0, 900));
  assert.ok(audit.markdown.includes("「俺」"), audit.markdown.slice(0, 900));

  store.close();
  console.log("  a bare pronoun is never a roster entry, and the claim it was filed under is kept and named");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The glossary already says whose "I" this is, and the store now reads that sentence.
 *
 * Volume 1's real Characters row for 如月雨露 ends: "Narrator: switches between 僕 and 俺 (see 僕／俺)".
 * That is the only place in the pipeline where the answer is written, and until now nothing read it — which
 * is why `俺（ジョーロ）` resolved to nobody and 282 claims landed under a pronoun.
 *
 * Measured against all 17 real glossaries before the rule was pinned: 17 hits, one per volume, all of them
 * this same row. Zero hits on any other character row. That measurement is why the rule is "a Characters
 * row whose notes name a bare pronoun" and not a nickname-section rule — see `firstPersonAliasDeclarations`.
 *
 * @returns {void}
 */
function scenarioTheGlossarysOwnRowResolvesThePronoun() {
  const series = fixtureStoreSeries("pronoun-declared");
  const entry = series.volumes[0];
  const opened = openVolumeRecord({ volume: 1, folder: entry.folder, seriesDir: series.dir });
  assert.ok(opened.ok, JSON.stringify(opened.refusal));
  const store = opened.store;
  store.registerChaptersFromSource();

  const narratorGlossary = GLOSSARY_01.replace(
    "| 如月雨露 | Kisaragi Amatsuyu | Protagonist; the narrator |",
    "| 如月雨露 | Kisaragi Amatsuyu | Protagonist. Narrator: switches between 僕 and 俺 |"
  );
  const imported = importVolumeArtifacts(store, { glossaryMarkdown: narratorGlossary });
  assert.ok(imported.glossary, JSON.stringify(imported));

  const row = store.db.prepare("SELECT key, aliases FROM cast WHERE key = ?").get("如月雨露");
  const aliases = JSON.parse(row.aliases || "[]");
  assert.ok(aliases.includes("俺"), `the pronoun is declared as an alias: ${JSON.stringify(aliases)}`);
  assert.ok(aliases.includes("僕"), `both first-person forms are declared: ${JSON.stringify(aliases)}`);

  // The name the real volume 02 extraction used for the protagonist, resolved.
  const ore = resolveExtractionName(store, "俺（ジョーロ）");
  assert.strictEqual(ore.key, "如月雨露", ore.how);
  assert.strictEqual(ore.resolved, true, ore.how);
  assert.ok(ore.how.includes("alias"), ore.how);

  // And the name the real volume 01 extraction used, which names no nickname at all: the pronoun is the
  // declared one, so it resolves too.
  const protagonist = resolveExtractionName(store, "俺（主人公）");
  assert.strictEqual(protagonist.key, "如月雨露", protagonist.how);

  // A pronoun nobody declared still resolves to nobody: the declaration is what makes the difference, and
  // the same store asked about a pronoun it was never told about answers honestly.
  const boku = resolveExtractionName(store, "私（クラスメイト）");
  assert.strictEqual(boku.key, null, boku.how);
  assert.strictEqual(boku.unattached, true, boku.how);

  // Filing through the document door puts the bullets on the person, not on the pronoun.
  const markdown = [
    "# Character voice reference",
    "",
    "## Characters",
    "",
    "### 俺（ジョーロ）",
    "",
    "- **Pronouns**: First person is 俺. — e.g. 「さぁ、今日も俺の熱き血潮を迸らせるぜ！」",
    "",
  ].join("\n");
  importVolumeArtifacts(store, { voiceMarkdown: markdown });
  const cast = store.db.prepare("SELECT key FROM cast ORDER BY key").all().map((r) => r.key);
  assert.ok(!cast.includes("俺"), `no pronoun entry: ${JSON.stringify(cast)}`);
  const filed = store.db
    .prepare("SELECT key, extracted_as AS extractedAs FROM facts WHERE aspect = 'pronoun' AND body LIKE ?")
    .all("%熱き血潮%");
  assert.strictEqual(filed.length, 1, JSON.stringify(filed));
  assert.strictEqual(filed[0].key, "如月雨露", "the bullet landed on the character the glossary names");
  assert.strictEqual(filed[0].extractedAs, "俺（ジョーロ）", "and the record keeps the name the heading used");

  store.close();
  console.log("  the glossary's own narrator row resolves the pronoun onto the character it names");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Two characters declaring the same "I" is not a tie to break.
 *
 * A first-person novel with two narrators is the case the rule has to answer without guessing: if both
 * Characters rows name 俺, picking whichever row the table reaches first would file one narrator's claims
 * under the other, and a merge is the one operation in this layer that makes claims quietly change hands.
 * So the declaration is refused, the name is reported as ambiguous, and the claims wait unattached.
 *
 * @returns {void}
 */
function scenarioTwoNarratorsRefuseToBePickedBetween() {
  const series = fixtureStoreSeries("pronoun-ambiguous");
  const entry = series.volumes[0];
  const opened = openVolumeRecord({ volume: 1, folder: entry.folder, seriesDir: series.dir });
  assert.ok(opened.ok, JSON.stringify(opened.refusal));
  const store = opened.store;
  store.registerChaptersFromSource();

  const twoNarrators = GLOSSARY_01.replace(
    "| 如月雨露 | Kisaragi Amatsuyu | Protagonist; the narrator |",
    "| 如月雨露 | Kisaragi Amatsuyu | Protagonist. Narrator: switches between 僕 and 俺 |"
  ).replace(
    "| 大賀太陽 | Oga Taiyo | Best friend since junior high |",
    "| 大賀太陽 | Oga Taiyo | The other narrator: this chapter is told in 俺 |"
  );
  const imported = importVolumeArtifacts(store, { glossaryMarkdown: twoNarrators });
  const glossary = imported.glossary;
  assert.strictEqual(glossary.ambiguousAliases.length, 1, JSON.stringify(glossary.ambiguousAliases));
  assert.strictEqual(glossary.ambiguousAliases[0].alias, "俺");
  assert.deepStrictEqual(glossary.ambiguousAliases[0].keys, ["如月雨露", "大賀太陽"], JSON.stringify(glossary.ambiguousAliases));
  assert.strictEqual(glossary.aliasesDeclared.filter((a) => a.alias === "俺").length, 0, "neither declaration was applied");

  const resolved = resolveExtractionName(store, "俺（二人目）");
  assert.strictEqual(resolved.key, null, resolved.how);
  assert.strictEqual(resolved.ambiguous, false, "the declarations were refused, so the name is simply unresolved now");
  assert.strictEqual(resolved.unattached, true, resolved.how);
  assert.ok(resolved.how.includes('the word for "I"'), resolved.how);

  // If somebody declares it on both entries anyway, the resolver still refuses to pick.
  assert.ok(store.castAlias("如月雨露", "俺", "declared by hand for the test").ok);
  assert.ok(store.castAlias("大賀太陽", "俺", "declared by hand for the test").ok);
  const both = resolveExtractionName(store, "俺（二人目）");
  assert.strictEqual(both.key, null, both.how);
  assert.strictEqual(both.ambiguous, true, both.how);
  assert.ok(both.how.includes("如月雨露") && both.how.includes("大賀太陽"), both.how);

  store.close();
  console.log("  two characters declaring the same pronoun are reported as a question, not resolved by table order");
}


// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The extractor's own label is taken off the published claim, and the claim survives.
 *
 * `NEW CHARACTER. Uses あんた as second-person pronoun for ジョーロ.` — three of those reached volume 02's
 * published reference. The observation is real; the label is the extraction pass writing in the field it
 * was filling in, and the record already says the same thing as `established_volume`.
 *
 * Measured before it was pinned: 2,744 claim bodies — every bullet of the two published references that
 * exist (227 and 583) plus every row of both real records (574 and 1,360) — and the shape fires 9 times, on
 * one distinct label, all in volume 02. Zero false positives. That is the number that made it a rule; the
 * two shapes above were pinned the same way (gotcha 112).
 *
 * @returns {void}
 */
function scenarioTheExtractorSLabelIsTakenOffAndTheClaimSurvives() {
  const series = fixtureStoreSeries("scaffolding-label");
  const entry = series.volumes[0];
  const roster = openReferenceStore({ volume: 1, folder: entry.folder, seriesDir: series.dir, stage: DOCUMENT_SOURCE_STAGE });
  roster.registerChaptersFromSource();
  importVolumeArtifacts(roster, { glossaryMarkdown: GLOSSARY_01 });
  roster.close();

  const opened = openReferenceStore({ volume: 1, folder: entry.folder, seriesDir: series.dir, stage: REBUILD_SOURCE_STAGE });
  assertInsideFixture(opened.file, series.dir);
  opened.registerChaptersFromSource();

  const entries = [
    {
      type: "voice",
      character: "三色院菫子（パンジー）",
      quirkType: "vocabulary",
      description: "NEW CHARACTER. Narration about her is flat and bookish.",
      examples: ["三色院菫子は本を読んでいた。"],
    },
    {
      type: "voice",
      character: "三色院菫子（パンジー）",
      quirkType: "vocabulary",
      description: "Her register is flat and bookish, and nothing about it is new.",
      examples: ["三色院菫子は本を読んでいた。"],
    },
  ];

  const candidateHandle = openReferenceStore({
    volume: 1,
    folder: series.volumes[0].folder,
    seriesDir: series.dir,
    stage: EXTRACTION_SOURCE_STAGE,
  });
  let result;
  try {
    result = rebuildVoiceFromExtraction(opened, entries, { candidateStore: candidateHandle });
  } finally {
    candidateHandle.close();
  }
  assert.strictEqual(result.refusal, null, JSON.stringify(result.refusal));

  const adopted = opened.db
    .prepare("SELECT body FROM facts WHERE source_stage = ? AND aspect = 'register' ORDER BY ord")
    .all(REBUILD_SOURCE_STAGE)
    .map((row) => row.body);
  assert.ok(adopted.includes("Narration about her is flat and bookish."), `the label is off the published claim: ${JSON.stringify(adopted)}`);
  assert.ok(!adopted.some((body) => body.startsWith("NEW CHARACTER")), `no published claim opens with the label: ${JSON.stringify(adopted)}`);
  assert.strictEqual(adopted.length, 2, "and the claim was not thrown away: " + JSON.stringify(adopted));

  const candidate = opened.db
    .prepare("SELECT body FROM facts WHERE source_stage = ? AND body LIKE ?")
    .all(EXTRACTION_SOURCE_STAGE, "NEW CHARACTER%");
  assert.strictEqual(candidate.length, 1, `the extraction's own copy keeps the label: ${JSON.stringify(candidate)}`);

  const labelled = result.screened.filter((item) => item.dropped.some((d) => d.example.startsWith("label:")));
  assert.strictEqual(labelled.length, 1, JSON.stringify(result.screened));
  assert.ok(labelled[0].dropped[0].because.includes("NEW CHARACTER"), JSON.stringify(labelled[0].dropped));

  // And the audit names it when a published file carries one — the authored route writes its own prose.
  const markdown = [
    "# Character voice reference",
    "",
    "## Characters",
    "",
    "### 三色院菫子",
    "",
    "- **Vocabulary register**: NEW CHARACTER. Narration about her is flat and bookish. — e.g. 「三色院菫子は本を読んでいた。」",
    "- **Vocabulary register**: Her register is flat and bookish. — e.g. 「三色院菫子は本を読んでいた。」",
    "",
  ].join("\n");
  const audit = auditVolumeRecord(opened, { title: "Character-voice reference", file: "character-voice.md", markdown });
  const finding = audit.findings.filter((f) => f.kind === "reference-claim-carries-unfinished-prose");
  assert.strictEqual(finding.length, 1, JSON.stringify(audit.findings.map((f) => f.kind)));
  assert.ok(finding[0].message.includes("line 7"), finding[0].message);
  assert.ok(!finding[0].message.includes("line 8"), `the legitimate bullet is not named: ${finding[0].message}`);
  assert.ok(finding[0].message.includes("NEW CHARACTER"), finding[0].message);

  opened.close();
  console.log("  the extractor's own label is taken off the published claim, kept in the candidate, and named in the audit");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Reopening a volume that is NOT the first: the fresh record is an empty shell, and the door that opens
 * it has to put the volume before it back in.
 *
 * Why this scenario exists. Every other reopen scenario reopens volume 1 — the one volume with nothing
 * downstream and nothing upstream. The real volume 02 was reopened on 2026-10-12, and the fresh record
 * `carryReopenHistory` builds holds only the reopen history: no `copy_provenance` row. That made
 * `openVolumeRecord` skip the copy-forward (a record exists) and made `topUpVolumeRecord` skip too (no
 * provenance row to tell it whose rows to attach), and **nothing printed either skip**. The volume was
 * about to be re-derived with none of volume 1's 574 rows, which is a reference smaller than the one it
 * replaced. Measured on a fixture before the fix: `facts 0, cast 0, copy_provenance 0, record_reopens 1`,
 * unchanged by opening it.
 *
 * The repair is narrow: the top-up door accepts a destination with no provenance row **only** when that
 * destination holds a `record_reopens` row for its own volume — a shape only the reopen door writes — and
 * it stamps the copy it attaches. This scenario pins both halves, including the half that must stay
 * refused.
 *
 * @returns {void}
 */
function scenarioReopeningANonFirstVolumeReattachesTheVolumeBeforeIt() {
  const { series } = publishedSeries("reopen-nonfirst");
  const first = series.volumes[0];
  const second = series.volumes[1];

  const res = reopenVolumeRecord({ volume: 2, folder: second.folder, seriesDir: series.dir, reason: REASON });
  assert.ok(res.ok, JSON.stringify(res.refusal));

  // The shell, pinned as the shell — this is the shape that used to be invisible.
  const shell = openReferenceStore({ volume: 2, folder: second.folder, seriesDir: series.dir, stage: DOCUMENT_SOURCE_STAGE, create: false });
  const shellCounts = shell.tableCounts();
  shell.close();
  assert.strictEqual(shellCounts.facts, 0, `a reopened record starts empty: ${JSON.stringify(shellCounts)}`);
  assert.strictEqual(shellCounts.cast, 0, JSON.stringify(shellCounts));
  assert.strictEqual(shellCounts.copy_provenance, 0, "and it carries no provenance row, which is what made every door skip");
  assert.strictEqual(shellCounts.record_reopens, 1, "the only thing it holds is the reopen row");

  const opened = openVolumeRecord({ volume: 2, folder: second.folder, seriesDir: series.dir, previousVolume: 1, previousFolder: first.folder });
  assert.ok(opened.ok, JSON.stringify(opened.refusal));
  assert.ok(opened.toppedUp && opened.toppedUp.reattached, `the reopened record must be re-attached, not skipped: ${JSON.stringify(opened.toppedUp)}`);
  assert.ok(opened.toppedUp.total > 0, `and rows actually arrived: ${JSON.stringify(opened.toppedUp.copied)}`);

  const counts = opened.store.tableCounts();
  assert.ok(counts.facts >= 10, `volume 1's claims are in the record again: ${JSON.stringify(counts)}`);
  assert.ok(counts.cast >= 3, `and its roster: ${JSON.stringify(counts)}`);
  assert.strictEqual(counts.copy_provenance, 1, "the attach is stamped, so the next door knows what this record was built from");
  const reattach = opened.toppedUp.findings.filter((f) => f.kind === "reference-record-reattached-to-its-source");
  assert.strictEqual(reattach.length, 1, `and it is said out loud: ${JSON.stringify(opened.toppedUp.findings)}`);
  assert.ok(reattach[0].message.includes("reopened"), reattach[0].message);
  opened.store.close();

  // It is not stale, and the next open is a clean no-op rather than a second attach.
  const again = openVolumeRecord({ volume: 2, folder: second.folder, seriesDir: series.dir, previousVolume: 1, previousFolder: first.folder });
  assert.ok(again.ok, `a record re-attached after the redo is not a stale copy: ${JSON.stringify(again.refusal)}`);
  assert.ok(again.toppedUp.skipped && /has not changed/.test(again.toppedUp.reason || ""), JSON.stringify(again.toppedUp));
  assert.strictEqual(again.toppedUp.reattached, false, JSON.stringify(again.toppedUp));
  const after = again.store.tableCounts();
  again.store.close();
  assert.strictEqual(after.facts, counts.facts, "and the second open adds nothing");

  // The reason survives the act that records it.
  const histStore = openReferenceStore({ volume: 2, folder: second.folder, seriesDir: series.dir, stage: DOCUMENT_SOURCE_STAGE, create: false });
  const history = readReopenHistory(histStore);
  histStore.close();
  assert.strictEqual(history.length, 1, JSON.stringify(history));
  assert.strictEqual(history[0].volume, 2);
  assert.strictEqual(history[0].reason, REASON);

  // ── The narrow half ────────────────────────────────────────────────────────
  // A record with no provenance row and NO reopen row of its own is still not a licence to attach.
  const other = fixtureStoreSeries("reopen-nonfirst-refused");
  const one = other.volumes[0];
  const sealed = openReferenceStore({ volume: 1, folder: one.folder, seriesDir: other.dir, stage: DOCUMENT_SOURCE_STAGE });
  sealed.registerChaptersFromSource();
  importVolumeArtifacts(sealed, { glossaryMarkdown: GLOSSARY_01, voiceMarkdown: VOICE_01 });
  sealVolumeRecord(sealed);
  sealed.close();
  const two = other.volumes[1];
  const own = openReferenceStore({ volume: 2, folder: two.folder, seriesDir: other.dir, stage: DOCUMENT_SOURCE_STAGE });
  own.registerChaptersFromSource();
  own.close();

  const refused = topUpVolumeRecord({ fromVolume: 1, toVolume: 2, seriesDir: other.dir });
  assert.strictEqual(refused.ok, true, JSON.stringify(refused.refusal));
  assert.strictEqual(refused.skipped, true, "a record nobody copied is still not a top-up target");
  assert.strictEqual(refused.reattached, false, JSON.stringify(refused));
  assert.strictEqual(refused.total, 0, JSON.stringify(refused.copied));
  assert.ok(refused.reason.includes("was not copied from volume 1"), refused.reason);

  console.log("  a reopened volume gets the volume before it back, and a record with no provenance and no reopen row still does not");
}

// ─── Runner ──────────────────────────────────────────────────────────────────

scenarioAReopenRequiresAReason();
scenarioReopeningAVolumeWithDerivedRecordsRefusesAndNamesThem();
scenarioCascadeRetireRetiresBothAndTheReasonSurvives();
scenarioAStaleCopyRefusesToBeOpened();
scenarioACopyMadeAfterTheRedoIsNotStale();
scenarioTheAuditReportSaysTheVolumeWasReopened();
scenarioAReopenVoidstheGradesOfTheRecordItRetires();
scenarioReopeningANonFirstVolumeReattachesTheVolumeBeforeIt();
scenarioTheDetectorFiresOnTheTwoRealDefectsAndNowhereElse();
scenarioFilingRefusesUnfinishedProseAndDropsADirtyCitation();
scenarioTheAuditNamesEveryLineThatCarriesADraftingNote();
scenarioAPronounIsNeverARosterEntry();
scenarioTheGlossarysOwnRowResolvesThePronoun();
scenarioTwoNarratorsRefuseToBePickedBetween();
scenarioTheExtractorSLabelIsTakenOffAndTheClaimSurvives();

console.log("\nreference-store reopen: all checks passed.");

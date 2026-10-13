/**
 * test/test-reference-store-attribution.js — who is speaking the words a claim quotes.
 *
 * What this suite is for. `utils/reference-store/attribution.js` decides **when the record's own answer is
 * in doubt**, `character-voice/detective.js` reads the scene and answers, and the answer lands in
 * `attribution_answers` — with a `challenge_fact` row per claim when it disagrees. The edges below are the
 * ones that make that safe, and as in the other reference-store suites each one plants the defect and names
 * the rule the refusal is supposed to carry, because "it stopped" is not a result.
 *
 *   - the doubt is measured against **the volume that established the claim**, not the volume being audited,
 *     and an unmeasured volume is reported as *not asked* rather than as *clean*;
 *   - the reading-aid probe explains an absence without becoming a second matching rule, and says so when it
 *     cannot look at all;
 *   - the narration is not a character: it cannot be filed as a roster entry, a roster entry cannot be
 *     renamed into it, and a record that already holds one is reported at HIGH;
 *   - an answer that disagrees files its challenger **under another entry, or under none at all**, and the
 *     published reference does not grow a bullet because of it;
 *   - an answer is filed with a reason and a citation that verifies, or not at all;
 *   - nothing is half-written: an answer whose challenge cannot be filed leaves no answer row either;
 *   - a dispute that is closed changes what is published, in the direction `resolve_challenge` decided.
 *
 * Every scenario runs inside `test/fixture-reference-store.js`'s throwaway series. Nothing here can reach the
 * real corpus (AGENTS.md rule 8, gotcha 69). No model, no network.
 *
 * Run with `npm test`, or standalone: `node test/test-reference-store-attribution.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Neither reference-store stage has a setting in front of its record any more, so there is
// nothing here to blank before the store's values are read.

const rs = require("../utils/reference-store");
const {
  openReferenceStore,
  renderVoice,
  renderPovMap,
  recordCastPresence,
  DOCUMENT_SOURCE_STAGE,
  ATTRIBUTION_ANSWERS,
  SKELETON_MIN_CHARS,
  READING_AID_MAX_GAP,
  NARRATOR,
} = rs;

const { fixtureStoreSeries, assertInsideFixture, SOURCE_01 } = require("./fixture-reference-store");

const { readArgs, renderReport, ATTRIBUTION_REPORT_FILE } = require("../attribute-voice");

require("../types"); // JSDoc type definitions

/** A reason long enough to pass the floor, and specific enough to be a reason. */
const REASON = "the scene names the speaker out loud, in the first person, one line after the cited quote";

/**
 * A throwaway series with volume 1's record open, its chapters registered, and one character filed under a
 * name this volume's text does not contain.
 *
 * The absent character is 蒲田. The fixture's book never prints that name, so the doubt the module reports
 * is a real contradiction in the record rather than a fixture trick: the claims are there, the name is not.
 *
 * @param {string} label
 * @returns {{fx: Object, store: Object, seriesDir: string}}
 */
function openFixture(label, stage = DOCUMENT_SOURCE_STAGE) {
  const fx = fixtureStoreSeries(`attribution-${label}`);
  const seriesDir = fx.dir;
  const store = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir, stage });
  store.registerChaptersFromSource();
  return { fx, store, seriesDir };
}

/**
 * File one character and one claim about them, at this store's volume.
 *
 * @param {Object} store
 * @param {string} key
 * @param {string} body
 * @param {{volume: number, chapter: string, line: number, quote: string}} evidence
 * @param {string} [aspect]
 * @returns {Object} The inserted fact.
 */
function fileClaim(store, key, body, evidence, aspect = "catchphrase") {
  const inserted = store.insertFact({
    key,
    cast: { display: key },
    aspect,
    label: "Catchphrases",
    body,
    evidence: [evidence],
  });
  assert.ok(inserted.ok, `the fixture claim should file: ${inserted.refusal && inserted.refusal.because}`);
  return inserted.fact;
}

/** The volume-1 line the fixture claims can cite. */
const LINE_CH1_3 = { volume: 1, chapter: "ch1", line: 3, quote: "「気にすんな！」" };

/**
 * The doubt groups this volume's record holds, after presence has been measured.
 *
 * @param {Object} store
 * @returns {Object}
 */
function doubtsAfterMeasuring(store) {
  const measured = store.recordCastPresence();
  assert.ok(measured.ok, `presence should be measurable: ${measured.refusal && measured.refusal.because}`);
  return store.attributionDoubts({ volume: store.volume });
}

// ─── The deterministic check ─────────────────────────────────────────────────

{
  const { store, seriesDir } = openFixture("doubt-rule");
  try {
    fileClaim(store, "如月雨露", "「気にすんな！」 is his stock reassurance.", LINE_CH1_3);
    fileClaim(store, "蒲田", "「ドンマイだ！」 is what she says when flustered.", {
      volume: 1,
      chapter: "ch1",
      line: 5,
      quote: "「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。",
    });

    const doubts = doubtsAfterMeasuring(store);
    assert.ok(doubts.asked, "presence was measured, so the question is asked");
    assert.strictEqual(doubts.groups.length, 1, `one entry in doubt, got ${doubts.groups.map((g) => g.key).join(", ")}`);
    assert.strictEqual(doubts.groups[0].key, "蒲田", "the entry measured absent from its own volume is the one in doubt");
    assert.strictEqual(doubts.groups[0].claimCount, 1, "one claim under it");
    assert.ok(
      doubts.groups[0].claims.every((c) => c.establishedVolume === undefined || c.establishedVolume === 1),
      "the claims are this volume's own"
    );

    // The name that IS printed is not in doubt, even though it has claims.
    assert.ok(
      !doubts.groups.some((g) => g.key === "如月雨露"),
      "如月雨露 is printed in this volume's text, so its attribution is not in doubt"
    );

    // The finding is MEDIUM: a doubt is a question, not damage.
    const findings = store.attributionFindings({ volume: 1 });
    const doubt = findings.find((f) => f.kind === "reference-claim-attribution-in-doubt");
    assert.ok(doubt, "the audit names the doubt");
    assert.strictEqual(doubt.severity, "MEDIUM", "an unanswered doubt is reported, not blocked");
    assert.ok(
      doubt.message.includes("attribute-voice"),
      "the finding names the door that answers it, so a reader is not left to guess"
    );
    assertInsideFixture(store.file, seriesDir);
  } finally {
    store.close();
  }
}

{
  // An unmeasured volume must not read as a clean one.
  const { store } = openFixture("presence-unmeasured");
  try {
    fileClaim(store, "蒲田", "「ドンマイだ！」 is what she says when flustered.", {
      volume: 1,
      chapter: "ch1",
      line: 5,
      quote: "「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。",
    });
    const doubts = store.attributionDoubts({ volume: 1 });
    assert.strictEqual(doubts.asked, false, "presence has not been measured, so nothing here may say the volume is clean");
    assert.ok(/presence has not been measured/.test(doubts.because), `the reason says why: ${doubts.because}`);
    assert.strictEqual(doubts.groups.length, 0, "no groups are invented for an unasked question");
  } finally {
    store.close();
  }
}

{
  // The doubt is about the volume that ESTABLISHED the claim, not the volume being audited.
  const { fx, store, seriesDir } = openFixture("establishing-volume");
  // Volume 1 files a claim under a name volume 2's text does not print…
  fileClaim(store, "茅ヶ崎春", "A name volume 1 read out of volume 1's book.", LINE_CH1_3);
  store.recordCastPresence();
  store.sealVolume(1);
  store.close();

  const copied = rs.copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir });
  assert.ok(copied.ok, `the record should copy forward: ${copied.refusal && copied.refusal.because}`);

  const vol2 = openReferenceStore({ volume: 2, folder: "Test Story(02)", seriesDir, stage: DOCUMENT_SOURCE_STAGE });
  try {
    vol2.registerChaptersFromSource();
    const measured = vol2.recordCastPresence();
    assert.ok(measured.ok, `volume 2's presence should be measurable: ${measured.refusal && measured.refusal.because}`);
    const doubts = vol2.attributionDoubts({ volume: 2 });
    assert.ok(doubts.asked, "volume 2's presence is measured");
    assert.ok(
      !doubts.groups.some((g) => g.key === "茅ヶ崎春"),
      "a claim established in volume 1 is not volume 2's doubt: volume 2's text is not the book it was read out of"
    );
    assert.ok(fx.dir.startsWith("/tmp/opencode/"), "the whole scenario stayed inside the fixture");
    assertInsideFixture(vol2.file, seriesDir);
  } finally {
    vol2.close();
  }
}

// ─── The reading-aid probe ───────────────────────────────────────────────────

{
  // A name printed only with its reading aids between the kanji is invisible to the store's matching rule
  // and visible to this probe — which is the difference between a finding and a false alarm.
  const { fx, store, seriesDir } = openFixture("reading-aids");
  try {
    const chapterFile = path.join(fx.dir, "Test Story(01)", "test_story(1)-ch1.md");
    const lines = [...SOURCE_01.ch1, "「私は……、一年の蒲かま田たです。」"];
    fs.writeFileSync(chapterFile, lines.join("\n") + "\n", "utf8");

    fileClaim(store, "蒲田", "She introduces herself as a first-year manager.", {
      volume: 1,
      chapter: "ch1",
      line: 7,
      quote: "「私は……、一年の蒲かま田たです。」",
    });

    const doubts = doubtsAfterMeasuring(store);
    const group = doubts.groups.find((g) => g.key === "蒲田");
    assert.ok(group, "the name is still measured absent: the probe is not wired into the matching rule");
    assert.strictEqual(group.presence.present, 0, "presence says absent, and the probe does not change that");

    const probe = group.readingAids;
    assert.strictEqual(probe.found, true, "the probe finds the name written with reading aids between its kanji");
    assert.ok(
      probe.hits.some((h) => h.span === "蒲かま田" && h.chapter === "ch1" && h.line === 7),
      `and it names where: ${JSON.stringify(probe.hits)}`
    );
    assert.ok(probe.hits.every((h) => h.gap <= READING_AID_MAX_GAP), `the gap stays bounded (${READING_AID_MAX_GAP})`);

    // The finding says which of the two it is, because a reader has to be able to tell a blind spot from an
    // absent character.
    const doubt = store.attributionFindings({ volume: 1 }).find((f) => f.kind === "reference-claim-attribution-in-doubt");
    assert.ok(doubt.message.includes("the name IS printed there"), `the finding names the blind spot: ${doubt.message}`);
    assert.ok(doubt.message.includes("deliberately not widened"), "and says the measurement is not widened for it");

    // A name with too few kanji to order is reported as un-lookable, not as absent.
    const katakana = store.upsertCast({ key: "Ｋ藤", display: "Ｋ藤", aliases: [] });
    assert.ok(katakana.ok, `the cast entry should file: ${katakana.refusal && katakana.refusal.because}`);
    fileClaim(store, "Ｋ藤", "A name this book writes in katakana.", {
      volume: 1,
      chapter: "ch1",
      line: 5,
      quote: "「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。",
    });
    const again = store.attributionDoubts({ volume: 1 });
    const k = again.groups.find((g) => g.key === "Ｋ藤");
    assert.ok(k, "the katakana name is measured absent");
    assert.strictEqual(k.readingAids.found, false, "the probe cannot look for it");
    assert.ok(k.readingAids.skipped.includes("Ｋ藤"), `and it says why: ${JSON.stringify(k.readingAids.skipped)}`);

    assert.ok(SKELETON_MIN_CHARS >= 3, `the store's own matching floor is ${SKELETON_MIN_CHARS}`);
    assertInsideFixture(store.file, seriesDir);
  } finally {
    store.close();
  }
}

// ─── The narration is not a character ────────────────────────────────────────

{
  const { store } = openFixture("narrator-not-a-character");
  try {
    for (const key of ["narrator", "Narrator", "narration", "the narrator"]) {
      const tried = store.upsertCast({ key, display: key, aliases: [] });
      assert.strictEqual(tried.ok, false, `"${key}" is the word for the narration, not a name in this book`);
      assert.strictEqual(tried.refusal.rule, "narrator-is-not-a-character", `"${key}": ${tried.refusal.because}`);
    }

    // A record that already holds one — written before this rule existed, or by hand — is reported at HIGH,
    // because the coverage rule counts cast entries as characters and would start asking for the narration.
    store.db.prepare("INSERT INTO cast (key, display, first_seen_volume) VALUES (?,?,?)").run("narrator", "narrator", 1);
    fileClaim(store, "narrator", "A claim filed under the narration as if it were a person.", LINE_CH1_3);
    const findings = store.attributionFindings({ volume: 1 });
    const high = findings.find((f) => f.kind === "reference-narrator-counted-as-a-character");
    assert.ok(high, "the audit names it");
    assert.strictEqual(high.severity, "HIGH", "counting the narration as a character is damage, not a question");
  } finally {
    store.close();
  }
}

// ─── Filing an answer ────────────────────────────────────────────────────────

/**
 * A store with one doubted entry, ready to be answered.
 *
 * @param {string} label
 * @returns {{fx: Object, store: Object, seriesDir: string, group: Object}}
 */
function doubtedStore(label) {
  const built = openFixture(label);
  fileClaim(built.store, "蒲田", "「ドンマイだ！」 is what she says when flustered.", {
    volume: 1,
    chapter: "ch1",
    line: 5,
    quote: "「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。",
  });
  // The character an answer may reassign the words to has to be on the roster first: naming a speaker the
  // record has never heard of is the reading pass's act, not an answer's.
  fileClaim(built.store, "大賀太陽", "「ドンマイだ！」 is his shout.", {
    volume: 1,
    chapter: "ch1",
    line: 5,
    quote: "「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。",
  });
  const measured = built.store.recordCastPresence();
  assert.ok(measured.ok, `presence should be measurable: ${measured.refusal && measured.refusal.because}`);
  // Published, the way both real volumes are: the answer is filed into a record that is already sealed, by
  // a door opened with its own stage.
  built.store.sealVolume(1);
  built.store.close();

  const store = openReferenceStore({ volume: 1, folder: "Test Story(01)", seriesDir: built.seriesDir, stage: "attribution", create: false });
  const doubts = store.attributionDoubts({ volume: 1 });
  const group = doubts.groups.find((g) => g.key === "蒲田");
  assert.ok(group, "the fixture store must hold one doubted entry");
  assert.strictEqual(store.isVolumeSealed(1), true, "and the record it is filed into is a published one");
  return { ...built, store, group };
}

{
  // Every refusal path, and what each one protects.
  const { store, group } = doubtedStore("answer-refusals");
  try {
    const id = group.claims[0].id;
    const cases = [
      { args: { key: "", answer: "confirmed", reason: REASON, evidence: [LINE_CH1_3] }, rule: "attribution-needs-a-key", protects: "an answer answers one roster entry" },
      { args: { key: "蒲田", answer: "maybe", reason: REASON, evidence: [LINE_CH1_3] }, rule: "attribution-answer-unknown", protects: "the answer vocabulary is closed" },
      { args: { key: "蒲田", answer: "confirmed", reason: "too sure", evidence: [LINE_CH1_3] }, rule: "attribution-answer-needs-a-reason", protects: "an answer has to say what the scene shows" },
      { args: { key: "蒲田", answer: "confirmed", reason: REASON, evidence: [] }, rule: "attribution-answer-needs-evidence", protects: "an answer cites the book" },
      { args: { key: "蒲田", answer: "confirmed", reason: REASON, evidence: [{ volume: 1, chapter: "ch1", line: 3, quote: "「存在しない台詞」" }] }, rule: "attribution-evidence-does-not-verify", protects: "the citation is checked against the line it names" },
      { args: { key: "蒲田", answer: "reassign", reason: REASON, evidence: [LINE_CH1_3] }, rule: "attribution-reassign-needs-a-speaker", protects: "a reassignment names somebody" },
      { args: { key: "蒲田", answer: "reassign", speaker: "narrator", reason: REASON, evidence: [LINE_CH1_3] }, rule: "attribution-narrator-is-not-a-reassignment", protects: "the narration is its own answer" },
      { args: { key: "蒲田", answer: "reassign", speaker: "蒲田", reason: REASON, evidence: [LINE_CH1_3] }, rule: "attribution-reassigns-to-itself", protects: "an answer that changes nothing is `confirmed`" },
      { args: { key: "蒲田", answer: "reassign", speaker: " nobody ", reason: REASON, evidence: [LINE_CH1_3] }, rule: "attribution-speaker-not-on-the-roster", protects: "an answer may not invent a character" },
      { args: { key: "蒲田", answer: "confirmed", reason: REASON, evidence: [LINE_CH1_3], claimIds: ["v99-ch9-999"] }, rule: "attribution-claim-not-in-this-group", protects: "an answer covers claims it has read" },
      { args: { key: " nobody ", answer: "confirmed", reason: REASON, evidence: [LINE_CH1_3] }, rule: "attribution-unknown-cast-key", protects: "there is no doubt here to answer" },
    ];
    for (const c of cases) {
      const out = store.recordAttributionAnswer(c.args);
      assert.strictEqual(out.ok, false, `should refuse: ${JSON.stringify(c.args)}`);
      assert.strictEqual(out.refusal.rule, c.rule, `${c.protects} — got ${out.refusal.rule}: ${out.refusal.because}`);
    }

    // Nothing was half-written by any of them.
    assert.strictEqual(store.attributionAnswers().length, 0, "a refused answer leaves no answer row");
    assert.strictEqual(store.listChallenges().length, 0, "a refused answer leaves no challenge row");
    assert.strictEqual(store.getFact(id).status, "active", "and it does not touch the claim it was asked about");
  } finally {
    store.close();
  }
}

{
  // An answer that agrees closes the question and opens nothing.
  const { store } = doubtedStore("answer-confirmed");
  try {
    const before = renderVoice(store);
    const out = store.recordAttributionAnswer({
      volume: 1,
      key: "蒲田",
      answer: "confirmed",
      reason: REASON,
      evidence: [LINE_CH1_3],
    });
    assert.ok(out.ok, `the answer should file: ${out.refusal && out.refusal.because}`);
    assert.strictEqual(out.challenges.length, 0, "agreeing with the record opens no dispute");
    assert.strictEqual(out.answer.speaker, "蒲田", "`confirmed` keeps the entry the claim is filed under");

    const doubts = store.attributionDoubts({ volume: 1 });
    assert.ok(doubts.groups[0].answer, "the record now knows somebody asked and agreed");
    assert.strictEqual(store.attributionFindings({ volume: 1 }).filter((f) => f.kind === "reference-claim-attribution-in-doubt").length, 0, "an answered doubt is not reported again");
    assert.strictEqual(renderVoice(store), before, "and the published reference is byte-identical");
  } finally {
    store.close();
  }
}

{
  // A narrator answer files its challenger with NO roster entry, and the narration is never counted.
  const { store } = doubtedStore("answer-narrator");
  try {
    const before = renderVoice(store);
    const out = store.recordAttributionAnswer({
      volume: 1,
      key: "蒲田",
      answer: "narrator",
      reason: "the cited line is the first-person narrator's own narration, not speech: the book reports it, nobody says it",
      evidence: [{ volume: 1, chapter: "ch1", line: 2, quote: "三色院菫子は本を読んでいた。" }],
    });
    assert.ok(out.ok, `a narrator answer is a real answer: ${out.refusal && out.refusal.because}`);
    assert.strictEqual(out.challenges.length, 1, "it disputes the claim the record published");

    const challenger = store.getFact(out.challenges[0].challengerId);
    assert.strictEqual(challenger.key, null, "the challenger is filed with no roster entry at all");
    assert.strictEqual(challenger.extracted_as, NARRATOR, `and names its answer in the record: ${challenger.extracted_as}`);
    assert.strictEqual(store.getFact(out.challenges[0].id).status, "disputed", "the published claim is marked, not edited");

    const cast = store.db.prepare("SELECT key FROM cast").all().map((r) => r.key);
    assert.ok(!cast.includes(NARRATOR), "answering `narrator` creates no cast entry, so the coverage rule never counts it");
    assert.strictEqual(store.attributionSummary({ volume: 1 }).narratorClaims, 1, "and the audit can count them");
    assert.strictEqual(renderVoice(store), before, "a narrator answer adds no bullet to the published reference");

    const high = store.attributionFindings({ volume: 1 }).find((f) => f.kind === "reference-attribution-contested-unresolved");
    assert.ok(high, "an open dispute is damage while it is open");
    assert.strictEqual(high.severity, "HIGH", "the reference is attributing these words one way while its own record disputes it");
  } finally {
    store.close();
  }
}

{
  // A reassignment files its challenger under the character it names — and the published reference does
  // NOT grow a bullet because of it. That is the whole reason the render rule exists.
  const { store } = doubtedStore("answer-reassign");
  try {
    const before = renderVoice(store);
    const out = store.recordAttributionAnswer({
      volume: 1,
      key: "蒲田",
      answer: "reassign",
      speaker: "大賀太陽",
      reason: "the line is 大賀太陽's shout in the scene: the volume filed it under the wrong person",
      evidence: [{ volume: 1, chapter: "ch1", line: 5, quote: "「ドンマイだ！」と大賀太陽が叫んだ。" }],
    });
    assert.ok(out.ok, `the reassignment should file: ${out.refusal && out.refusal.because}`);
    const challenger = store.getFact(out.challenges[0].challengerId);
    assert.strictEqual(challenger.key, "大賀太陽", "the challenger is filed under the speaker it names");
    assert.strictEqual(challenger.source_stage, "attribution", "and it is stamped as an answer, not as a claim a merge adopted");

    const after = renderVoice(store);
    assert.strictEqual(after, before, "an open challenger is not published content: the reference does not gain a bullet about 大賀太陽");
    assert.ok(after.includes("「ドンマイだ！」 is what she says when flustered."), "the original bullet is still published, marked disputed");
    assert.strictEqual(renderPovMap(store, { volume: 1 }).markdown, renderPovMap(store, { volume: 1 }).markdown, "the map is stable");
  } finally {
    store.close();
  }
}

{
  // Nothing is half-written: an answer whose challenge cannot be filed leaves no answer row either.
  // Reachable through provenance — an answer built on a passage from a volume this record has not read
  // cites text it cannot have read, so the challenger cannot be filed and the answer goes with it.
  const { store, group } = doubtedStore("answer-rollback");
  try {
    const out = store.recordAttributionAnswer({
      volume: 1,
      key: "蒲田",
      answer: "narrator",
      reason: "an answer built on a passage from a later volume, which this record's own reading has not reached",
      evidence: [{ volume: 2, chapter: "ch0", line: 3, quote: "駱駝はあとがきに書いた。" }],
    });
    assert.strictEqual(out.ok, false, "the challenger cannot be filed, so the answer cannot be filed either");
    assert.strictEqual(out.refusal.rule, "attribution-challenge-refused", out.refusal.because);
    assert.strictEqual(store.attributionAnswers().length, 0, "no answer row survived the rollback");
    assert.strictEqual(store.listChallenges().length, 0, "no challenge row survived either");
    assert.strictEqual(store.getFact(group.claims[0].id).status, "active", "and the claim it was asked about is untouched");
  } finally {
    store.close();
  }
}

// ─── Closing a dispute changes what is published ─────────────────────────────

{
  const { store } = doubtedStore("dispute-accepted");
  try {
    const before = renderVoice(store);
    const out = store.recordAttributionAnswer({
      volume: 1,
      key: "蒲田",
      answer: "reassign",
      speaker: "大賀太陽",
      reason: "the line is 大賀太陽's shout in the scene: the volume filed it under the wrong person",
      evidence: [{ volume: 1, chapter: "ch1", line: 5, quote: "「ドンマイだ！」と大賀太陽が叫んだ。" }],
    });
    assert.ok(out.ok, `the reassignment should file: ${out.refusal && out.refusal.because}`);

    const closed = store.resolveChallenge(out.challenges[0].challengeId, "accept");
    assert.ok(closed.ok, `the dispute should close: ${closed.refusal && closed.refusal.because}`);

    const after = renderVoice(store);
    assert.notStrictEqual(after, before, "a closed dispute changes what is published — that is what closing one means");
    assert.ok(!after.includes("「ドンマイだ！」 is what she says when flustered."), "the claim the dispute replaced is no longer published");
    assert.ok(after.includes("these words belong to 大賀太陽"), "the claim that replaced it is");
    assert.strictEqual(
      store.attributionFindings({ volume: 1 }).filter((f) => f.kind === "reference-attribution-contested-unresolved").length,
      0,
      "and the HIGH finding is gone, because the dispute is no longer open"
    );
  } finally {
    store.close();
  }
}

{
  const { store } = doubtedStore("dispute-upheld");
  try {
    const before = renderVoice(store);
    const out = store.recordAttributionAnswer({
      volume: 1,
      key: "蒲田",
      answer: "narrator",
      reason: "an answer that turns out not to hold: the line is speech after all",
      evidence: [{ volume: 1, chapter: "ch1", line: 2, quote: "三色院菫子は本を読んでいた。" }],
    });
    assert.ok(out.ok, `the answer should file: ${out.refusal && out.refusal.because}`);

    const closed = store.resolveChallenge(out.challenges[0].challengeId, "uphold");
    assert.ok(closed.ok, `the dispute should close: ${closed.refusal && closed.refusal.because}`);

    const after = renderVoice(store);
    assert.strictEqual(after, before, "upholding the record's own claim publishes exactly what it published before");
    assert.strictEqual(store.getFact(out.challenges[0].id).status, "active", "the original claim is no longer disputed");
    assert.strictEqual(store.getFact(out.challenges[0].challengerId).status, "retracted", "the answer that lost is withdrawn, not deleted");
  } finally {
    store.close();
  }
}

// ─── The command's own surface ───────────────────────────────────────────────

{
  assert.deepStrictEqual(readArgs(["--volume=02", "--check"]).volume, "02", "--volume");
  assert.strictEqual(readArgs(["--volume=02", "--check"]).check, true, "--check is the deterministic half alone");
  assert.strictEqual(readArgs(["--volume=02", "--dry-run"]).dryRun, true, "--dry-run calls nothing");
  assert.ok(readArgs(["--no-guard"]).error, "an unrecognised flag is refused rather than ignored");
  assert.strictEqual(readArgs(["--answers"]).answers, true, "--answers reads the filed answers");

  const { store } = doubtedStore("command-report");
  try {
    const doubts = store.attributionDoubts({ volume: 1 });
    const report = renderReport(doubts, { results: [], skipped: [], usage: null });
    assert.ok(report.includes("# Who is speaking"), "the report says what it is about, in prose a reader can follow");
    assert.ok(report.includes("蒲田"), "it names the entry in doubt");
    assert.ok(report.includes("Nobody has answered this yet."), "and says plainly that nobody has");
    assert.ok(report.includes("cast_alias"), "it names the door that closes a blind spot instead of walking through it");
    assert.ok(report.includes("It did not rewrite `character-voice.md`"), "and says what it did not do");
    assert.ok(ATTRIBUTION_REPORT_FILE === "character-voice-attribution.md", "the notebook's name is the one the intake knows");
  } finally {
    store.close();
  }
}

// ─── The vocabulary is closed ────────────────────────────────────────────────

{
  assert.deepStrictEqual(ATTRIBUTION_ANSWERS, ["confirmed", "reassign", "narrator", "unknown"], "the answer vocabulary, in the order the prompt states it");
  assert.ok(ATTRIBUTION_ANSWERS.includes("unknown"), "an answer that admits it does not know is recorded, so 'nobody asked' and 'nobody knows' are different rows");
  assert.ok(!ATTRIBUTION_ANSWERS.includes("guess"), "and there is no value that means 'probably'");
}

console.log("test-reference-store-attribution: ok");

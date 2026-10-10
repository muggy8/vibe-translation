/**
 * test/test-reference-store-pipeline.js — slice 6: the store populated from what the pipeline
 * already produces, and the deterministic audit that replaces the whole-document validators.
 *
 * What this suite is for. Slices 2–5 built the store and proved it can hold and reproduce the two
 * reference artifacts. Slice 6 puts data in it and asks the store the questions a validator agent
 * used to answer by reading the document. So every scenario here plants a defect and checks that a
 * query catches it **at a named severity** — the same shape `test/test-postmortem.js` uses — because
 * "the audit found something" is not a result; "this defect is HIGH and this one is MEDIUM" is.
 *
 * The planted defects mirror the real damage, not hypothetical ones: a character-voice reference that
 * lost characters who are in the volume's text (volume 01's actual failure); a line too long for an
 * agent to read (the 54,341-character line that made that reference unreparable); a claim the
 * extraction produced and the document never adopted; a carried-forward record that is missing the
 * half its source published after the copy was made.
 *
 * The other half of the suite is the rule that keeps the new questions honest: an absence measured
 * from the volume's own text must not fire, and must not touch a claim; an extraction claim must not
 * count as coverage; and with the flag off, nothing in this layer writes anything at all.
 *
 * Every scenario runs inside `test/fixture-reference-store.js`'s throwaway series. Nothing here can
 * reach the real corpus (AGENTS.md rule 8, gotcha 69). No model, no network.
 *
 * Run with `npm test`, or standalone: `node test/test/test-reference-store-pipeline.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// The two flags must be read as a fresh clone reads them, before anything caches their values.
delete process.env.GLOSSARY_STORE_VALIDATORS;
delete process.env.VOICE_STORE_VALIDATORS;

const {
  openReferenceStore,
  openVolumeRecord,
  volumeRecordExists,
  importVolumeExtraction,
  importVolumeArtifacts,
  resetDocumentMirror,
  auditVolumeRecord,
  sealVolumeRecord,
  copyForwardStore,
  topUpVolumeRecord,
  importGlossary,
  importVoice,
  renderGlossary,
  renderVoice,
  recordCastPresence,
  castPresence,
  presenceMeasured,
  artifactShapeFindings,
  unadoptedVoiceClaims,
  unadoptedTerms,
  absentCharacters,
  renderAuditReport,
  buildGradeSample,
  voiceNewestSections,
  GRADE_SAMPLE_MAX_CHARS,
  REPORT_LIST_LIMIT,
  COVERAGE_SIGNIFICANCE_CHAPTERS,
  EXTRACTION_SOURCE_STAGE,
  DOCUMENT_SOURCE_STAGE,
} = require("../utils/reference-store");
const { documentMirrored, DOCUMENT_VOICE } = require("../utils/reference-store/document-prose");
const { STORE_VALIDATORS } = require("../configs/shared");
const { envMaxLineLength } = require("../ai/env");
const { fixtureStoreSeries, assertInsideFixture, GLOSSARY_01, VOICE_01, VOICE_01_MISSING_CHARACTERS, EXTRACTION_01 } = require("./fixture-reference-store");
const voiceStore = require("../character-voice/store");
const glossaryStore = require("../glossary/store");

/**
 * A fixture volume 01 with its chapters registered and a write scope of its own.
 *
 * @param {string} label
 * @param {string} [stage]
 * @returns {{fx: Object, store: Object, dir: string}}
 */
function openVolumeOne(label, stage = DOCUMENT_SOURCE_STAGE) {
  const fx = fixtureStoreSeries(label);
  const store = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage });
  assertInsideFixture(store.file, fx.dir);
  const registered = store.registerChaptersFromSource();
  assert.ok(registered.ok, registered.error);
  return { fx, store, dir: fx.dir };
}

/**
 * File extraction claims the way a stage does: through its own handle, scoped to the extract stage.
 *
 * The artifact import and the extraction import are two handles with two write scopes, and a test
 * that used one handle for both would stamp the document's own rows as extraction candidates — which
 * is the exact distinction this layer exists to keep.
 *
 * @param {Object} fx - The fixture from `openVolumeOne`.
 * @param {Array<Object>|null} [voiceEntries]
 * @param {Array<Object>|null} [newTerms]
 * @returns {{voice: Object|null, terms: Object|null}}
 */
function fileExtractionClaims(fx, voiceEntries = null, newTerms = null) {
  return importVolumeExtraction({
    volume: 1,
    folder: fx.volumes[0].folder,
    seriesDir: fx.dir,
    voiceEntries,
    newTerms,
  });
}

/**
 * Find one finding by kind, or describe what the audit actually said when it is not there.
 *
 * @param {Object} audit
 * @param {string} kind
 * @param {string} [expectation]
 * @returns {Object}
 */
function expectFinding(audit, kind, expectation = "the audit reports it") {
  const found = audit.findings.filter((f) => f.kind === kind);
  if (found.length === 0) {
    throw new Error(
      `${kind}: ${expectation}. Findings instead: ${audit.findings.map((f) => `${f.severity} ${f.kind}`).join(", ") || "none"}`
    );
  }
  return found[0];
}

/**
 * Assert a kind is absent, and say what was there instead.
 *
 * @param {Object} audit
 * @param {string} kind
 * @param {string} because
 */
function expectNoFinding(audit, kind, because) {
  const found = audit.findings.filter((f) => f.kind === kind);
  assert.strictEqual(found.length, 0, `${kind} must not fire: ${because}. Findings: ${audit.findings.map((f) => `${f.severity} ${f.kind}`).join(", ") || "none"}`);
}

// ─── Presence: the measurement absence is decided from ────────────────────────

/**
 * Presence is measured from the volume's own chapter files, including a name that only ever appears
 * with its reading aids between the characters (gotcha 96), and it is stored rather than inferred.
 */
function scenarioPresenceIsMeasuredFromTheText() {
  const { store } = openVolumeOne("pipeline-presence");

  assert.strictEqual(presenceMeasured(store, 1), false, "a volume nobody has measured is not a volume where nobody appears");

  importGlossary(store, GLOSSARY_01);
  // 秋野桜 is in the fixture's source only as 秋野あきの桜さくら — never as three bare kanji. The
  // store's one matching rule has to find it here too, or presence would report a character who is
  // on the page as absent.
  store.upsertCast({ key: "秋野桜", display: "秋野桜", firstSeenVolume: 1 });

  const measured = recordCastPresence(store);
  assert.ok(measured.ok, measured.refusal ? measured.refusal.because : "measurement failed");
  assert.strictEqual(measured.measured, 4, "the three the glossary registered, plus 秋野桜");
  assert.strictEqual(measured.present, 4, "all four are in volume 01's text");

  const rows = castPresence(store, 1);
  const sumireko = rows.find((row) => row.key === "三色院菫子");
  assert.strictEqual(sumireko.present, 1);
  assert.strictEqual(sumireko.chapter, "ch1", "and the store records WHERE it found them");
  assert.ok(sumireko.line >= 2, "at a line number, not just a yes");

  const akino = rows.find((row) => row.key === "秋野桜");
  assert.strictEqual(akino.matched, "skeleton", "found by the reading-aid rule, and the store says which rule proved it");

  assert.strictEqual(presenceMeasured(store, 1), true);
  store.close();
  console.log("reference-store pipeline: presence is measured from the volume's own text, and the rule that proved it is recorded");
}

/**
 * A volume with no extracted source cannot be measured, and says so rather than reporting nobody is
 * there.
 */
function scenarioPresenceRefusesWithoutASource() {
  const fx = fixtureStoreSeries("pipeline-presence-no-source");
  // The fixture lays its source out the way an extraction does; this scenario needs the opposite
  // case, so the source is removed from the volume folder before the store is opened.
  for (const name of fs.readdirSync(fx.volumes[0].dir)) fs.rmSync(path.join(fx.volumes[0].dir, name));

  const store = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  assertInsideFixture(store.file, fx.dir);

  const measured = recordCastPresence(store);
  assert.strictEqual(measured.ok, false, "no chapters registered, no measurement");
  assert.strictEqual(measured.refusal.rule, "presence-source-missing");
  assert.match(measured.refusal.because, /no extracted source/, "and the refusal names the missing thing");
  assert.strictEqual(presenceMeasured(store, 1), false, "a refused measurement is still an unmeasured volume");

  store.close();
  console.log("reference-store pipeline: a volume with no extracted source is refused, not read as a volume where nobody appears");
}

// ─── The coverage question, refined ───────────────────────────────────────────

/**
 * Owner decision 2. A character with no lines in this volume is left alone: their existing claims are
 * not touched, and no entry is demanded for them. The character who IS in the text and IS missing from
 * the reference is the HIGH finding (see `scenarioDamagedReferenceIsNotCarriedForward`).
 */
function scenarioAbsentCharactersAreLeftAloneAndNotDemanded() {
  const fx = fixtureStoreSeries("pipeline-absence");

  // Volume 01 registers the roster and publishes no reference yet, so all three carry into volume
  // 02 with nothing said about two of them.
  const one = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importGlossary(one, GLOSSARY_01);
  one.sealVolume(1);
  one.close();

  // Volume 02's text contains 如月雨露 and 駱駝 only.
  const opened = openVolumeRecord({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, previousVolume: 1, previousFolder: "Test Story(01)" });
  assert.ok(opened.ok, opened.error || opened.refusal && opened.refusal.because);
  const two = opened.store;

  const voiceMarkdown = `# Character Voice Reference\n\n## Characters\n\n### 如月雨露（ジョーロ）【俺人格】\n\n- **Pronouns**: 一人称は俺。\n`;
  importVoice(two, voiceMarkdown);

  const before = two.db
    .prepare("SELECT id, key, aspect, body, owner_volume FROM facts WHERE key IS NOT NULL ORDER BY id")
    .all();

  const audit = auditVolumeRecord(two, { title: "Character-voice reference", file: "character-voice.md", markdown: voiceMarkdown });

  expectNoFinding(audit, "reference-voice-covers-fewer-characters", "the two uncovered characters have no lines in volume 02's text");

  const absent = absentCharacters(two);
  const absentKeys = absent.map((entry) => entry.key).sort();
  assert.deepStrictEqual(absentKeys, ["三色院菫子", "大賀太陽"], "and the report says which ones, out loud");
  assert.match(audit.markdown, /三色院菫子/, "the absent characters are named in the report, not hidden in a query");
  assert.match(audit.markdown, /no entry is required for them/);

  // The claims themselves are untouched: same ids, same owners, same bodies.
  const after = two.db
    .prepare("SELECT id, key, aspect, body, owner_volume FROM facts WHERE key IS NOT NULL ORDER BY id")
    .all();
  assert.deepStrictEqual(after, before, "auditing a volume must not rewrite a claim because the character stayed off the page");

  two.close();
  console.log("reference-store pipeline: a character who makes no appearance in the volume is left alone, and no entry is demanded for them");
}

/**
 * The same volume, before anyone measured it: with no measurement the audit falls back to the
 * stricter rule, because "nobody appears in this volume" is not a thing a store may assume.
 */
function scenarioUnmeasuredVolumeUsesTheStricterRule() {
  const fx = fixtureStoreSeries("pipeline-unmeasured");

  // Volume 01 publishes a glossary only — no character-voice reference yet, which is exactly the
  // state the glossary stage leaves a volume in when `npx gulp` runs stage by stage.
  const one = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importGlossary(one, GLOSSARY_01);
  one.sealVolume(1);
  one.close();

  // Volume 02 inherits the roster (3 characters) and publishes a reference covering one of them.
  const two = openVolumeRecord({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, previousVolume: 1, previousFolder: "Test Story(01)" }).store;
  importVoice(two, `# Character Voice Reference\n\n## Characters\n\n### 如月雨露（ジョーロ）【俺人格】\n\n- **Catchphrases**: 「気にすんな！」\n`);

  assert.strictEqual(presenceMeasured(two, 2), false);
  const unmeasured = two.integrityFindings({ volume: "02" });
  const firing = expectFinding(unmeasured, "reference-voice-covers-fewer-characters", "an unmeasured volume reports every uncovered cast entry");
  assert.strictEqual(firing.severity, "HIGH");
  assert.match(firing.message, /presence has not been measured/, "and the finding says that is the basis it answered on");
  assert.match(firing.message, /三色院菫子/, "including the one volume 02's text does not contain");

  recordCastPresence(two);
  const measured = two.integrityFindings({ volume: "02" });
  expectNoFinding(measured, "reference-voice-covers-fewer-characters", "once measured, the volume's own text decides who is required");

  two.close();
  console.log("reference-store pipeline: an unmeasured volume falls back to the stricter rule, and measuring it is what refines it");
}

/**
 * A reference that lost characters who ARE in the volume's text, and whom the extraction found, is
 * HIGH, and the next volume cannot be built on it. No exception, no downgrade.
 *
 * This is volume 01's failure in fixture shape, with both of the rule's signals planted: the
 * extraction pass filed claims about the lost characters (two independent readings of the same book
 * disagreeing), and the volume's own text names them. Either one alone is enough for HIGH — see
 * `scenarioACharacterInEnoughChaptersIsALossWithoutTheExtraction` for the other half.
 * @returns {void}
 */
function scenarioDamagedReferenceIsNotCarriedForward() {
  const fx = fixtureStoreSeries("pipeline-damaged-chain");

  const one = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importGlossary(one, GLOSSARY_01);
  importVoice(one, VOICE_01_MISSING_CHARACTERS);

  // The extraction pass ran over this volume and noticed the two characters the reference lost.
  // Filed through its own handle, the way a stage files them.
  const filed = importVolumeExtraction({
    volume: 1,
    folder: fx.volumes[0].folder,
    seriesDir: fx.dir,
    voiceEntries: [
      { type: "voice", character: "大賀太陽", quirkType: "catchphrase", description: "Chants it.", examples: ["ドンマイだ！ ドンマイ！"] },
      { type: "voice", character: "三色院菫子", quirkType: "pronoun", description: "She reads.", examples: ["三色院菫子は本を読んでいた。"] },
    ],
  }).voice;
  assert.strictEqual(filed.importedCount, 2, "both claims cite a line that is really there");

  recordCastPresence(one);
  const audit = one.integrityFindings({ volume: "01" });
  const coverage = expectFinding(audit, "reference-voice-covers-fewer-characters");
  assert.strictEqual(coverage.severity, "HIGH", "the severity that stops a copy-forward");
  assert.match(coverage.message, /大賀太陽/, "it names the characters the reference lost");
  assert.match(coverage.message, /三色院菫子/);
  assert.match(coverage.message, /the volume's own text contains them/, "and it says the absence was measured, not assumed");
  assert.match(coverage.message, /the extraction filed 1 claim\(s\) about them/, "and it says which signal made it a loss");
  one.sealVolume(1);
  one.close();

  const carried = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: fx.dir, fromFolder: "Test Story(01)", toFolder: "Test Story(02)" });
  assert.strictEqual(carried.ok, false, "a volume whose reference lost characters is not copied forward");
  assert.strictEqual(carried.refusal.rule, "reference-source-fails-integrity");
  assert.ok(carried.findings.some((f) => f.severity === "HIGH" && f.kind === "reference-voice-covers-fewer-characters"));

  assert.strictEqual(volumeRecordExists({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir }), false, "and the next volume's record is not created by a refused copy");

  console.log("reference-store pipeline: a volume whose character-voice reference lost characters is not copied forward, at HIGH");
}

/**
 * The extraction's own spellings land on the roster entry the record already uses for that character.
 *
 * This is not tidiness. The coverage rule's first signal asks "did this volume's extraction file a
 * claim about them", and if 三色院菫子（パンジー）'s claims were filed under 三色院菫子（パンジー） the answer is
 * "no" for a character the extraction wrote claims about — a signal that is always false, which looks
 * exactly like a volume whose extractor saw nothing. Volume 01's extraction names all 11 of its
 * characters with brackets.
 * @returns {void}
 */
function scenarioExtractionNamesLandOnTheRosterEntry() {
  const { fx, store } = openVolumeOne("pipeline-name-resolution");
  importGlossary(store, GLOSSARY_01);

  const filed = fileExtractionClaims(fx, EXTRACTION_01).voice;
  assert.ok(filed.ok, JSON.stringify(filed.refused));

  const keys = store.db.prepare("SELECT key FROM cast ORDER BY key").all().map((row) => row.key);
  assert.ok(keys.includes("三色院菫子") && !keys.includes("三色院菫子（パンジー）"), `the claims land on the roster entry: ${keys.join(", ")}`);
  assert.ok(!keys.includes("如月雨露（ジョーロ）") && !keys.includes("大賀太陽（サンちゃん）"), "the same for the two other names the glossary already carries");
  const claims = store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE key = '三色院菫子' AND source_stage = ?")
    .get(EXTRACTION_SOURCE_STAGE).n;
  assert.ok(claims > 0, "and the claim is filed under it, which is what the coverage query reads");

  const unresolved = filed.unresolved.map((row) => row.name);
  assert.ok(unresolved.includes("俺（主人公）") && unresolved.includes("秋野桜（コスモス）"), `names nothing carries are reported, not guessed at: ${unresolved.join(", ")}`);

  // The consequence, measured: a reference that mentions only 如月雨露 is a HIGH loss for the two
  // characters the extraction filed claims about, because those claims are findable under their keys.
  importVoice(store, `# Character Voice Reference\n\n## Characters\n\n### 如月雨露（ジョーロ）【俺人格】\n\n- **Pronouns**: 一人称は俺。\n`);
  recordCastPresence(store);
  const coverage = expectFinding(store.integrityFindings({ volume: "01" }), "reference-voice-covers-fewer-characters", "the extraction found them and the reference did not");
  assert.match(coverage.message, /三色院菫子 — the extraction filed \d+ claim\(s\) about them/);

  store.close();
  console.log("reference-store pipeline: an extraction name is resolved onto the roster entry, so the coverage rule's extraction signal can actually be found");
}

/**
 * The coverage line, pinned. It is a constant in the module that uses it and there is no
 * environment variable that moves it (AGENTS.md rule 3), so the only way to change it is to edit
 * the file that states how it was measured.
 * @returns {void}
 */
function scenarioTheCoverageLineIsAConstant() {
  assert.strictEqual(
    COVERAGE_SIGNIFICANCE_CHAPTERS,
    3,
    "volume 01's measurements put the line here: a fictional film actor named in 2 chapters is a " +
      "mention, and 如月雨露, whom the destroyed reference lost, is named in 3"
  );
  console.log("reference-store pipeline: the coverage line is a pinned constant, not a setting");
}

/**
 * Presence records every place a name occurs, not the first one, and says which rule proved each.
 * Without this the coverage rule cannot ask "in how many chapters", because a character named once
 * and a character named in every chapter would look identical.
 * @returns {void}
 */
function scenarioPresenceRecordsEveryPlaceANameOccurs() {
  const { store } = openVolumeOne("pipeline-presence-matches");
  importGlossary(store, GLOSSARY_01);
  store.upsertCast({ key: "担任教師", display: "担任教師", firstSeenVolume: 1 });

  const measured = recordCastPresence(store);
  assert.ok(measured.ok, measured.refusal ? measured.refusal.because : "measurement failed");
  assert.ok(measured.matchRows > 4, `every match is a row: ${measured.matchRows}`);

  const rows = castPresence(store, 1);
  const teacher = rows.find((row) => row.key === "担任教師");
  assert.strictEqual(teacher.present, 1);
  assert.strictEqual(teacher.chapters, 3, "the summary answers \"how many chapters\", which the first match alone could not");
  assert.strictEqual(teacher.matches, 3, "and how many lines");
  assert.strictEqual(teacher.matched, "skeleton", "the name is only ever printed with 担任の教師, so the skeleton rule is what proved it");

  const detail = store.presenceDetail(1, "担任教師");
  assert.deepStrictEqual(detail.map((row) => row.chapter), ["ch0", "ch1", "ch2"], "and the audit can name WHICH chapters");
  assert.ok(detail.every((row) => row.matched === "skeleton"), "with the rule that proved each one");

  const hits = store.db
    .prepare("SELECT chapter, line, name, matched FROM cast_presence_match WHERE volume = 1 AND key = ? ORDER BY chapter, line")
    .all("担任教師");
  assert.strictEqual(hits.length, 3, "one row per place the name occurs");
  assert.ok(hits.every((row) => row.line >= 2 && row.name === "担任教師"));

  // Re-measuring replaces the answer instead of layering on top of it.
  const again = recordCastPresence(store);
  assert.strictEqual(again.matchRows, measured.matchRows, "a second measurement does not double the rows");

  store.close();
  console.log("reference-store pipeline: presence records every place a name occurs, with the rule that proved it");
}

/**
 * The second signal on its own: a character the extraction says nothing about, named in enough of
 * the volume's chapters to be in the book. HIGH, and it stops the copy.
 * @returns {void}
 */
function scenarioACharacterInEnoughChaptersIsALossWithoutTheExtraction() {
  const fx = fixtureStoreSeries("pipeline-chapter-signal");

  const one = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importGlossary(one, GLOSSARY_01);
  // 担任教師 is in the roster and in all three chapters, and the reference never mentions them.
  // Nothing from the extraction is filed: this character is caught by the chapter signal alone.
  one.upsertCast({ key: "担任教師", display: "担任教師", firstSeenVolume: 1 });
  importVoice(one, `# Character Voice Reference\n\n## Characters\n\n### 如月雨露（ジョーロ）【俺人格】\n\n- **Pronouns**: 一人称は俺。\n- **Catchphrases**: 「気にすんな！」はジョーロの定型である。\n`);
  recordCastPresence(one);

  const audit = one.integrityFindings({ volume: "01" });
  const coverage = expectFinding(audit, "reference-voice-covers-fewer-characters", "somebody named in three of three chapters is in the book");
  assert.strictEqual(coverage.severity, "HIGH");
  assert.match(coverage.message, /担任教師/);
  assert.match(coverage.message, /their name occurs in 3 of this volume's 3 chapters/);

  one.close();
  console.log("reference-store pipeline: a character named in enough chapters is a loss even when the extraction says nothing about them");
}

/**
 * The softened half: a character who IS in the volume but only barely, and about whom the
 * extraction says nothing either, is a mention. MEDIUM, named with the signal that was missing, and
 * the next volume is still built on this record.
 * @returns {void}
 */
function scenarioABarelyPresentCharacterIsAMentionNotALoss() {
  const fx = fixtureStoreSeries("pipeline-mention-only");

  const one = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importGlossary(one, GLOSSARY_01);
  // 山田 (one line, one chapter) and 三色院菫子 (one chapter) are both in the text and both absent
  // from the reference, and no extraction claim covers either.
  importVoice(one, `# Character Voice Reference\n\n## Characters\n\n### 如月雨露（ジョーロ）【俺人格】\n\n- **Pronouns**: 一人称は俺。\n- **Catchphrases**: 「気にすんな！」はジョーロの定型である。\n`);
  recordCastPresence(one);

  const audit = one.integrityFindings({ volume: "01" });
  expectNoFinding(audit, "reference-voice-covers-fewer-characters", "neither signal holds for these two, so this is not the stop");
  const mention = expectFinding(audit, "reference-voice-mention-not-covered", "a barely-present character is still reported");
  assert.strictEqual(mention.severity, "MEDIUM");
  assert.match(mention.message, /三色院菫子/, "named, not counted");
  assert.match(mention.message, /below the 3-chapter line/, "with the signal that was missing");
  assert.match(mention.message, /the extraction found nothing about them/);

  const report = renderAuditReport({
    title: "Character-voice reference",
    file: "character-voice.md",
    volume: 1,
    findings: audit.findings,
    counts: audit.counts,
    checked: audit.checked,
    coverageAsked: audit.coverageAsked,
    coverage: audit.coverage,
  });
  assert.match(report, /## Characters the reference does not cover/, "and every one of them is in the report a human reads");
  assert.match(report, /MEDIUM — a mention/);
  assert.match(report, /三色院菫子.*1 of 3 chapters \(1 line\(s\); verbatim\) — ch1/, "and it names WHICH chapter it found them in, so the verdict can be checked by opening the book");

  one.sealVolume(1);
  one.close();

  const carried = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: fx.dir, fromFolder: "Test Story(01)", toFolder: "Test Story(02)" });
  assert.ok(carried.ok, carried.refusal ? carried.refusal.because : "a mention does not stop the next volume");
  assert.strictEqual(volumeRecordExists({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir }), true);

  console.log("reference-store pipeline: a barely-present character is a mention — named in the report, and not a stop");
}


/**
 * The store's own record of who is in the volume, and the report's statement of it, agree.
 */
function scenarioCoverageIsNotAskedBeforeTheReferenceIsMirrored() {
  const { store } = openVolumeOne("pipeline-not-yet-mirrored");
  importGlossary(store, GLOSSARY_01);
  recordCastPresence(store);

  const audit = store.integrityFindings({ volume: "01" });
  expectNoFinding(audit, "reference-voice-covers-fewer-characters", "this volume's character-voice document has not been read into the record yet");
  assert.strictEqual(audit.coverageAsked, false);
  assert.match(renderAuditReport({ title: "Glossary", file: "glossary.md", volume: 1, findings: audit.findings, counts: audit.counts, checked: audit.checked, coverageAsked: audit.coverageAsked }), /not asked yet/);

  importVoice(store, VOICE_01_MISSING_CHARACTERS);
  assert.strictEqual(documentMirrored(store, DOCUMENT_VOICE, 1), true, "the import records that the mirror exists");
  const after = store.integrityFindings({ volume: "01" });
  assert.strictEqual(after.coverageAsked, true);
  assert.strictEqual(after.coverage.asked, true, "and the answer carries the measured signals for each name");
  expectFinding(
    after,
    "reference-voice-mention-not-covered",
    "once the reference is in the record the question is asked — these two are barely-present, so it lands at MEDIUM"
  );
  assert.ok(after.coverage.rows.length === 2, `both uncovered characters are in the answer: ${JSON.stringify(after.coverage.rows.map((r) => r.key))}`);

  store.close();
  console.log("reference-store pipeline: the coverage question is asked once the volume's reference is in the record, and the report says which it did");
}

// ─── Extraction claims: filed, compared, and never counted as coverage ────────

/**
 * The claims the extraction pass already produced are filed, and the ones the published document
 * never took are named with a number in them.
 */
function scenarioUnadoptedClaimsAreNamed() {
  const { fx, store } = openVolumeOne("pipeline-unadopted");
  importGlossary(store, GLOSSARY_01);
  importVoice(store, VOICE_01_MISSING_CHARACTERS);

  const filed = fileExtractionClaims(fx, [
    { type: "voice", character: "大賀太陽", quirkType: "catchphrase", description: "Turns a mistake into a chant.", examples: ["ドンマイだ！ ドンマイ！"], formalityLevel: "casual" },
    { type: "voice", character: "如月雨露", quirkType: "pronoun", description: "Uses 俺 in every chapter.", examples: ["気にすんな！"], formalityLevel: "casual" },
    { type: "voice", character: "三色院菫子", quirkType: "sentenceEnding", description: "Plain declarative sentences.", examples: ["三色院菫子は本を読んでいた。"], formalityLevel: "neutral" },
  ]).voice;
  assert.strictEqual(filed.importedCount, 3, "all three claims cite a line that is really there");

  const unadopted = unadoptedVoiceClaims(store);
  const named = unadopted.map((row) => `${row.key}/${row.aspect}`).sort();
  assert.deepStrictEqual(
    named,
    ["三色院菫子/register", "大賀太陽/catchphrase"],
    "the reference says nothing of those kinds about those characters; 如月雨露's pronoun IS in the reference, so it is not listed"
  );

  const terms = fileExtractionClaims(fx, null, [
    { term: "禁忌の書", type: "concept", query: "Is it named anywhere else?" },
    { term: "ジョーロ", type: "nickname", query: "Already in the glossary." },
  ]).terms;
  assert.strictEqual(terms.importedCount, 1, "a term the volume never prints is refused");
  assert.strictEqual(terms.refused[0].term, "禁忌の書");
  assert.deepStrictEqual(unadoptedTerms(store), [], "and the term the glossary already carries is not reported as missing");

  store.close();
  console.log("reference-store pipeline: what the extraction found and the document never took is a query with a number in it");
}

/**
 * An extraction claim must not count as coverage. This is the false pass the whole distinction exists
 * to prevent: the extractor noticed the character, the reference still lost them.
 */
function scenarioExtractionClaimsAreNotCoverage() {
  const { fx, store } = openVolumeOne("pipeline-extract-not-coverage");
  importGlossary(store, GLOSSARY_01);
  importVoice(store, VOICE_01_MISSING_CHARACTERS);
  recordCastPresence(store);

  fileExtractionClaims(fx, [
    { type: "voice", character: "大賀太陽", quirkType: "catchphrase", description: "Chants it.", examples: ["ドンマイだ！ ドンマイ！"] },
    { type: "voice", character: "三色院菫子", quirkType: "pronoun", description: "She reads.", examples: ["三色院菫子は本を読んでいた。"] },
  ]);

  const audit = store.integrityFindings({ volume: "01" });
  const coverage = expectFinding(audit, "reference-voice-covers-fewer-characters", "the reference still says nothing about them");
  assert.strictEqual(coverage.severity, "HIGH", "and filing the extractor's claims does not downgrade it");

  const rows = store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE key IS NOT NULL AND source_stage = ?")
    .get(EXTRACTION_SOURCE_STAGE).n;
  assert.ok(rows > 0, "the extraction rows are there — they simply do not answer the question");

  store.close();
  console.log("reference-store pipeline: an extraction claim is not coverage for a reference that lost the character");
}

/**
 * A claim the store cannot cite is refused and reported, exactly like a glossary row whose term the
 * book never prints. A model wrote it; that is not evidence.
 */
function scenarioInventedExtractionClaimsAreRefused() {
  const { fx, store } = openVolumeOne("pipeline-invented");
  const filed = fileExtractionClaims(fx, [
    { type: "voice", character: "氷室", quirkType: "catchphrase", description: "Says something the book never prints.", examples: ["これは源文に存在しない台詞である。"] },
  ]).voice;
  assert.strictEqual(filed.importedCount, 0);
  assert.strictEqual(filed.refused.length, 1);
  assert.match(filed.refused[0].because, /none of this claim's quotes .* occurs in volume 1's source text/);
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM cast WHERE key = '氷室'").get().n,
    0,
    "a claim the store refused does not put its character on the roster — the coverage query would then demand an entry for somebody nobody wrote anything about"
  );

  store.close();
  console.log("reference-store pipeline: an extraction claim with no quote in the book is refused and named, not filed");
}

// ─── The mirror: rebuilt on every audit, never duplicated ─────────────────────

/**
 * The QA loop re-audits after every feedback pass, and the feedback pass edits the file. The mirror
 * is rebuilt rather than appended, and rebuilding one document's mirror must not erase the other's.
 */
function scenarioMirrorResetReplacesOnlyItsOwnRows() {
  const { store } = openVolumeOne("pipeline-mirror");

  const first = importGlossary(store, GLOSSARY_01);
  assert.strictEqual(first.imported.length, 5, "the fixture glossary's rows");
  importVoice(store, VOICE_01);
  const voiceRows = store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE key IS NOT NULL").get().n;
  assert.ok(voiceRows > 0);

  const reset = resetDocumentMirror(store, { document: "glossary" });
  assert.strictEqual(reset.refused.length, 0, "these are this volume's own unsealed rows, which is what delete-own-rows exists for");
  assert.strictEqual(reset.deleted, 5);
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE key IS NOT NULL").get().n,
    voiceRows,
    "a glossary reset does not touch the character-voice stage's rows in the same record"
  );

  const again = importGlossary(store, GLOSSARY_01);
  assert.strictEqual(again.imported.length, 5, "re-importing after a reset imports them again");
  assert.strictEqual(again.carried.length, 0);

  // Without the reset, re-importing the same cumulative file does not double it either.
  const third = importGlossary(store, GLOSSARY_01);
  assert.strictEqual(third.imported.length, 0, "every row the record already has is counted as carried");
  assert.strictEqual(third.carried.length, 5);

  store.close();
  console.log("reference-store pipeline: the mirror is rebuilt, the carried rows are counted rather than duplicated, and one document's reset does not erase the other's");
}

/**
 * A volume's record carried from an earlier one keeps the earlier volume's ownership, and this
 * volume's reset leaves those rows alone.
 */
function scenarioCarriedRowsStayTheEarlierVolumes() {
  const fx = fixtureStoreSeries("pipeline-carried-ownership");

  const one = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importGlossary(one, GLOSSARY_01);
  importVoice(one, VOICE_01);
  one.sealVolume(1);
  one.close();

  const two = openVolumeRecord({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, previousVolume: 1, previousFolder: "Test Story(01)" }).store;
  const carried = store_factsOwnedBy(two, 1);
  assert.ok(carried.length > 0, "volume 1's rows arrived in volume 2's record");
  assert.ok(carried.every((row) => row.ownerVolume === 1), "with volume 1 as their owner");
  assert.ok(carried.every((row) => row.sealed === 1), "and sealed, because volume 1 published them");

  const reset = resetDocumentMirror(two, { document: "glossary" });
  assert.strictEqual(reset.deleted, 0, "volume 2's reset deletes volume 2's rows, and it has none yet");
  assert.deepStrictEqual(store_factsOwnedBy(two, 1).map((row) => row.id), carried.map((row) => row.id), "volume 1's rows are untouched");

  two.close();
  console.log("reference-store pipeline: carried rows keep their own volume's ownership and sealing, and a later volume cannot delete them");
}

/**
 * A character-voice reference with nothing wrong with it: every bullet maps to a real aspect, every
 * cast entry the glossary registered has a claim, and no bullet is left `unclassified`. The fixture's
 * own `VOICE_01` has a `**Notes**:` bullet on purpose (the escape hatch has to be exercised), which
 * makes it the wrong prop for "the report says so when there is nothing wrong".
 */
const VOICE_01_CLEAN = `# Character Voice Reference

## Characters

### 如月雨露（ジョーロ）【俺人格】

- **Pronouns**: 一人称は俺。
- **Catchphrases**: 「気にすんな！」はジョーロの定型である。

### 大賀太陽（サンちゃん）

- **Catchphrases**: 「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。

### 三色院菫子

- **Pronouns**: 三色院菫子は本を読んでいた。
`;

/**
 * @param {Object} store
 * @param {number} volume
 * @returns {Array<{id: string, ownerVolume: number, sealed: number}>}
 */
function store_factsOwnedBy(store, volume) {
  return store.db
    .prepare("SELECT id, owner_volume AS ownerVolume, sealed FROM facts WHERE owner_volume = ? ORDER BY id")
    .all(volume);
}

// ─── The record that was copied before its source finished ────────────────────

/**
 * `npx gulp` finishes the glossary for every volume before the voice stage starts, so volume 2's
 * record is copied from volume 1 while volume 1's voice half does not exist yet. Opening volume 2's
 * record later tops it up rather than leaving it holding half a volume.
 */
function scenarioTopUpBringsTheMissingHalf() {
  const fx = fixtureStoreSeries("pipeline-top-up");

  // Glossary stage, volume 1: glossary rows only, sealed.
  const one = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importGlossary(one, GLOSSARY_01);
  one.sealVolume(1);
  one.close();

  // Glossary stage, volume 2: the copy is made now, and volume 1 has no voice half yet.
  const firstOpen = openVolumeRecord({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, previousVolume: 1, previousFolder: "Test Story(01)" });
  assert.ok(firstOpen.ok, firstOpen.refusal && firstOpen.refusal.because);
  assert.ok(firstOpen.carried, "volume 2's record is created by the copy");
  assert.strictEqual(documentMirrored(firstOpen.store, DOCUMENT_VOICE, 1), false, "and it carries no voice rows, because there were none to carry");
  firstOpen.store.close();

  // Voice stage, volume 1: the half that was missing gets published.
  const oneAgain = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importVoice(oneAgain, VOICE_01);
  oneAgain.sealVolume(1);
  oneAgain.close();

  // Voice stage, volume 2: the record is already here, so it is topped up.
  const secondOpen = openVolumeRecord({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, previousVolume: 1, previousFolder: "Test Story(01)" });
  assert.ok(secondOpen.ok, secondOpen.refusal && secondOpen.refusal.because);
  assert.strictEqual(secondOpen.carried, null, "nothing is copied over an existing record");
  assert.ok(secondOpen.toppedUp && !secondOpen.toppedUp.skipped, "the top-up ran");
  assert.ok(secondOpen.toppedUp.copied.facts > 0, `it brought the rows this record was missing (${JSON.stringify(secondOpen.toppedUp.copied)})`);
  assert.strictEqual(documentMirrored(secondOpen.store, DOCUMENT_VOICE, 1), true, "including the marker that says volume 1's reference is in the record");

  const voiceRows = secondOpen.store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE key IS NOT NULL AND owner_volume = 1")
    .get().n;
  assert.ok(voiceRows > 0, "volume 1's voice rows are now in volume 2's record, owned by volume 1");

  // A second top-up has nothing left to do.
  const again = topUpVolumeRecord({ fromVolume: 1, toVolume: 2, seriesDir: fx.dir, fromFolder: "Test Story(01)", toFolder: "Test Story(02)" });
  assert.ok(again.ok);
  assert.strictEqual(again.skipped, true, "the source has not changed since the copy's recorded hash was updated");

  secondOpen.store.close();
  console.log("reference-store pipeline: a record copied from a volume that has since finished is topped up, not overwritten");
}

// ─── The artifact's own shape, measured ───────────────────────────────────────

/**
 * A line longer than an agent's file tools can answer with is HIGH. This is the exact damage volume
 * 01's reference took, and it is measurable in one pass over the file.
 */
function scenarioUnreadableLineIsHigh() {
  const limit = envMaxLineLength();
  const piece = "翻訳時はこの区切りを保持すること。";
  const welded = `### 如月雨露（ジョーロ）【俺人格】\n\n- **Notes**: ${piece.repeat(Math.ceil((limit + 500) / piece.length))}\n`;
  const findings = artifactShapeFindings(welded, { file: "character-voice.md", volume: "01" });
  const finding = findings.find((f) => f.kind === "reference-artifact-line-unreadable");
  assert.ok(finding, `a ${welded.length}-character line must be reported (the read limit is ${limit})`);
  assert.strictEqual(finding.severity, "HIGH", "an artifact no agent can read is not an artifact an agent can repair");
  assert.match(finding.message, /line 3 of character-voice\.md is \d+ characters/);
  assert.match(finding.message, /Split the line into one claim per line/, "and the report says what to do about it");

  const tidy = artifactShapeFindings(VOICE_01, { file: "character-voice.md", volume: "01" });
  assert.deepStrictEqual(tidy, [], "the same check on a well-formed reference finds nothing");

  console.log("reference-store pipeline: a line longer than an agent can read is a HIGH finding, measured from the file");
}

/**
 * An artifact with no sections at all is MEDIUM: nothing in it is addressable, which is a slower and
 * quieter failure than an unreadable line but not a harmless one.
 */
function scenarioArtifactWithoutSectionsIsMedium() {
  const findings = artifactShapeFindings("# Character Voice Reference\n\nEveryone is described in one paragraph here.\n", {
    file: "character-voice.md",
    volume: "01",
  });
  const finding = findings.find((f) => f.kind === "reference-artifact-has-no-sections");
  assert.ok(finding, "a reference with no sections is reported");
  assert.strictEqual(finding.severity, "MEDIUM");

  const glossaryShape = artifactShapeFindings(GLOSSARY_01, { file: "glossary.md", volume: "01" });
  assert.deepStrictEqual(glossaryShape, [], "the glossary's `## ` sections are sections too");

  console.log("reference-store pipeline: an artifact with no addressable sections is a MEDIUM finding, at any heading level");
}

// ─── The graded sample ────────────────────────────────────────────────────────

/**
 * The sample the acceptance grader is shown: deterministic, opening first, this volume's sections
 * first, bounded, and it says what it left out.
 */
function scenarioGradedSampleIsDeterministicAndBounded() {
  const { store } = openVolumeOne("pipeline-sample");
  importGlossary(store, GLOSSARY_01);
  importVoice(store, VOICE_01);

  const newest = voiceNewestSections(store);
  assert.ok(newest.includes("如月雨露（ジョーロ）【俺人格】"), `the sections this volume's record added are known to the sampler (${newest.join(", ")})`);

  const first = buildGradeSample(VOICE_01, { file: "character-voice.md", volume: 1, heading: "### ", newestSections: newest, maxChars: 200 });
  const second = buildGradeSample(VOICE_01, { file: "character-voice.md", volume: 1, heading: "### ", newestSections: newest, maxChars: 200 });
  assert.strictEqual(first.text, second.text, "a grade whose sample moved between calls could not be compared with yesterday's grade");

  assert.match(first.text, /# Character Voice Reference/, "the document's opening is always shown — the rubric judges the document's shape");
  assert.match(first.text, /### 如月雨露/, "and this volume's own section comes first");
  assert.ok(first.omitted.length > 0, `the rest is left out and named: ${first.omitted.join(", ")}`);
  assert.match(first.text, /not shown \(/, "the sample says what it omitted, so the grader knows what it is not seeing");
  assert.ok(first.chars <= 200 + first.text.length, "the budget is respected");

  const whole = buildGradeSample(VOICE_01, { file: "character-voice.md", volume: 1, heading: "### ", newestSections: newest });
  assert.strictEqual(whole.omitted.length, 0, "under the cap nothing is omitted — the cap is what bites on a real volume, not on a fixture");
  assert.ok(GRADE_SAMPLE_MAX_CHARS >= whole.chars, `the whole fixture reference (${whole.chars} characters) fits the cap of ${GRADE_SAMPLE_MAX_CHARS}`);

  // The cap has to survive the damage the real volume 01 actually took: one section whose single line
  // is longer than the whole budget. A sampler that took it "whole, because it is first" printed a
  // budget it did not obey.
  const piece = "翻訳時はこの区切りを保持すること。";
  const huge = `# Character Voice Reference\n\n現行：1巻まで\n\n### 駱駝（作者）\n\n- **Notes**: ${piece.repeat(4000)}\n\n### 如月雨露（ジョーロ）【俺人格】\n\n- **Pronouns**: 一人称は俺。\n`;
  const capped = buildGradeSample(huge, { file: "character-voice.md", volume: 1, heading: "### " });
  assert.ok(capped.chars <= GRADE_SAMPLE_MAX_CHARS, `the sample is ${capped.chars} characters; the cap is ${GRADE_SAMPLE_MAX_CHARS} and a 68,000-character section must not defeat it`);
  assert.ok(capped.text.length <= GRADE_SAMPLE_MAX_CHARS + 1200, `and the text handed to the grader (${capped.text.length} characters) is the budget plus its own header`);
  assert.deepStrictEqual(capped.truncated, ["駱駝（作者）"], "the section that was cut short is named, not quietly shortened");
  assert.match(capped.text, /shown cut short \(駱駝（作者）\)/);
  assert.deepStrictEqual(capped.omitted, ["如月雨露（ジョーロ）【俺人格】"], "and what did not fit at all is named too");

  store.close();
  console.log("reference-store pipeline: the graded sample is deterministic, opening-first, this-volume-first, bounded, and it names what it left out");
}

// ─── The report the feedback stage reads ──────────────────────────────────────

/**
 * The deterministic report keeps the shape its readers already depend on — including the
 * `**Recommendation:**` line the prompt audit checks for — and it never stays silent about what it
 * checked.
 */
function scenarioReportKeepsTheShapeItsReadersExpect() {
  const { fx, store } = openVolumeOne("pipeline-report");
  importGlossary(store, GLOSSARY_01);
  importVoice(store, VOICE_01_MISSING_CHARACTERS);
  // The extraction noticed both characters the reference lost, which is what makes this the HIGH
  // shape of the coverage finding rather than the mention shape.
  fileExtractionClaims(fx, [
    { type: "voice", character: "大賀太陽", quirkType: "catchphrase", description: "Chants it.", examples: ["ドンマイだ！ ドンマイ！"] },
    { type: "voice", character: "三色院菫子", quirkType: "pronoun", description: "She reads.", examples: ["三色院菫子は本を読んでいた。"] },
  ]);

  const audit = auditVolumeRecord(store, {
    title: "Character-voice reference",
    file: "character-voice.md",
    markdown: VOICE_01_MISSING_CHARACTERS,
    refused: [{ character: "大賀太陽", label: "Catchphrases", because: "the quote is not in the volume's text" }],
  });

  assert.match(audit.markdown, /^\*\*Recommendation:\*\* revise — \d+ HIGH finding/m, "the line every validator report has, and the prompt audit looks for");
  assert.match(audit.markdown, /## HIGH findings/);
  assert.match(audit.markdown, /reference-voice-covers-fewer-characters/);
  assert.match(audit.markdown, /## What was checked/, "a report that is silent about what it checked is indistinguishable from one that checked nothing");
  assert.match(audit.markdown, /\| facts in the store \| \d+ \|/);
  assert.match(audit.markdown, /## Rows the store refused to record/);
  assert.match(audit.markdown, /大賀太陽/, "a refused row is named, not dropped quietly");
  assert.ok(audit.highFindings.length >= 1);
  assert.match(audit.markdown, /## Characters the reference does not cover/, "and the coverage answer is a table a human can read, not only a finding message");
  assert.match(audit.markdown, /\*\*HIGH — a real loss\*\*/, "with the verdict and the signal that produced it");

  const clean = auditVolumeRecord(
    (() => {
      const opened = openVolumeOne("pipeline-report-clean");
      importGlossary(opened.store, GLOSSARY_01);
      importVoice(opened.store, VOICE_01_CLEAN);
      return opened.store;
    })(),
    { title: "Character-voice reference", file: "character-voice.md", markdown: VOICE_01_CLEAN }
  );
  assert.deepStrictEqual(
    clean.findings,
    [],
    `a sound volume should produce no findings; got ${clean.findings.map((f) => `${f.severity} ${f.kind}`).join(", ") || "none"}`
  );
  assert.match(clean.markdown, /\*\*Recommendation:\*\* accept — no finding at any severity\./, "and the same report says so when there is nothing wrong");
  assert.match(clean.markdown, /None\. Every question the store can ask/);

  store.close();
  console.log("reference-store pipeline: the deterministic report keeps the name, the reader and the shape the loop already relies on");
}

/**
 * The report's size is a cost the run pays on every volume, so a section names a bounded number of
 * rows and then states the total. Truncation that hides the size of the problem would be worse than
 * a long report.
 */
function scenarioReportSectionsAreBoundedAndSayHowBigTheyAre() {
  const many = Array.from({ length: REPORT_LIST_LIMIT + 5 }, (_, i) => ({
    key: `人物${i}`,
    aspect: "catchphrase",
    label: "Catchphrases",
    body: `A claim about ${i}.`,
    id: `f${i}`,
  }));
  const report = renderAuditReport({
    title: "Character-voice reference",
    file: "character-voice.md",
    volume: 1,
    findings: [],
    checked: 0,
    coverageAsked: true,
    unadopted: many,
  });
  assert.match(report, /^25 claim\(s\) the extraction pass produced/m, "the section's own sentence carries the total");
  assert.match(report, /…and 5 more, not listed here \(25 in total\)\./);
  assert.strictEqual(report.split("\n").filter((line) => line.startsWith("- **人物")).length, REPORT_LIST_LIMIT, "and the list itself stops at the limit");

  const few = renderAuditReport({
    title: "Character-voice reference",
    file: "character-voice.md",
    volume: 1,
    findings: [],
    checked: 0,
    coverageAsked: true,
    unadopted: many.slice(0, 3),
  });
  assert.ok(!/not listed here/.test(few), "a section under the limit names everything and says nothing about truncation");

  console.log("reference-store pipeline: the report's lists are bounded, and the bound is stated as a number rather than hidden");
}

/**
 * The audit's own numbers are the ones the store holds, and the citations it re-checked are counted.
 */
function scenarioAuditCountsAreTheStoresOwn() {
  const { store } = openVolumeOne("pipeline-counts");
  importGlossary(store, GLOSSARY_01);
  importVoice(store, VOICE_01);

  const audit = auditVolumeRecord(store, { title: "Character-voice reference", file: "character-voice.md", markdown: VOICE_01 });
  const facts = store.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n;
  assert.strictEqual(audit.counts.facts, facts);
  assert.strictEqual(audit.checked, facts, "every stored citation is re-checked against the source text, not sampled");
  assert.ok(audit.presence.measured > 0, "and presence is measured before the audit, so the refined question is the one asked");

  store.close();
  console.log("reference-store pipeline: the audit re-checks every citation it holds and reports its own counts");
}

// ─── The flag: off means nothing here runs ────────────────────────────────────

/**
 * Both flags default off, and with them off the stage glue touches nothing: no record is opened, no
 * row is written, no file is changed. That is the rollback guarantee, tested rather than asserted.
 */
async function scenarioFlagOffTouchesNothing() {
  assert.deepStrictEqual(STORE_VALIDATORS, { glossary: false, voice: false }, "both flags default off (plan 04 §12: a stage that has not run a real volume through the new path keeps the old one)");

  const fx = fixtureStoreSeries("pipeline-flag-off");
  const ctx = {
    values: { INSTALLMENT_NUMBER: "01" },
    folderName: "Test Story(01)",
    seriesDir: fx.dir,
    previousFolderName: null,
    bundle: null,
    refStore: null,
    voiceOutputFile: path.join(fx.volumes[0].dir, "character-voice.md"),
    glossaryOutputFile: path.join(fx.volumes[0].dir, "glossary.md"),
  };

  assert.strictEqual(voiceStore.fileVoiceExtraction(ctx, [{ type: "voice", character: "如月雨露", quirkType: "pronoun", description: "x", examples: ["気にすんな！"] }]), null);
  assert.strictEqual(glossaryStore.fileGlossaryExtraction(ctx, [{ term: "会計担当", type: "concept", query: "x" }]), null);
  assert.strictEqual(await voiceStore.mirrorVoiceArtifact(ctx), null);
  assert.strictEqual(await glossaryStore.mirrorGlossaryArtifact(ctx), null);
  assert.strictEqual(await voiceStore.auditVoiceArtifact(ctx), null);
  assert.strictEqual(await glossaryStore.auditGlossaryArtifact(ctx), null);
  assert.strictEqual(await voiceStore.voiceGradeSample(ctx), null);
  assert.strictEqual(await glossaryStore.glossaryGradeSample(ctx), null);
  voiceStore.sealVoiceRecord(ctx);
  glossaryStore.sealGlossaryRecord(ctx);

  assert.strictEqual(fs.existsSync(path.join(fx.volumes[0].dir, "series.db")), false, "with the flag off, no volume's record is created at all");
  assert.strictEqual(fs.existsSync(path.join(fx.volumes[1].dir, "series.db")), false);

  console.log("reference-store pipeline: with the flags off, the stage glue writes nothing and no record is created");
}

/**
 * The two kinds of row are one decision, stated once: which rows are the record and which are
 * candidates. A renderer that mixed them would publish sentences no agent ever put in the document.
 */
function scenarioExtractionRowsNeverRenderIntoADocument() {
  const { fx, store } = openVolumeOne("pipeline-render-isolation");
  importGlossary(store, GLOSSARY_01);
  importVoice(store, VOICE_01);
  const glossaryBefore = renderGlossary(store);
  const voiceBefore = renderVoice(store);

  fileExtractionClaims(fx, [
    { type: "voice", character: "大賀太陽", quirkType: "catchphrase", description: "A sentence the author agent never wrote.", examples: ["ドンマイだ！ ドンマイ！"] },
  ], [{ term: "ドンマイ", type: "concept", query: "already a catchphrase" }]);

  assert.strictEqual(renderGlossary(store), glossaryBefore, "the glossary does not gain the extractor's term");
  assert.strictEqual(renderVoice(store), voiceBefore, "the reference does not gain the extractor's sentence");

  store.close();
  console.log("reference-store pipeline: extraction rows are filed but never rendered, so a published file keeps only what an agent put in it");
}

(async () => {
  scenarioPresenceIsMeasuredFromTheText();
  scenarioPresenceRefusesWithoutASource();
  scenarioAbsentCharactersAreLeftAloneAndNotDemanded();
  scenarioUnmeasuredVolumeUsesTheStricterRule();
  scenarioDamagedReferenceIsNotCarriedForward();
  scenarioTheCoverageLineIsAConstant();
  scenarioExtractionNamesLandOnTheRosterEntry();
  scenarioPresenceRecordsEveryPlaceANameOccurs();
  scenarioACharacterInEnoughChaptersIsALossWithoutTheExtraction();
  scenarioABarelyPresentCharacterIsAMentionNotALoss();
  scenarioCoverageIsNotAskedBeforeTheReferenceIsMirrored();
  scenarioUnadoptedClaimsAreNamed();
  scenarioExtractionClaimsAreNotCoverage();
  scenarioInventedExtractionClaimsAreRefused();
  scenarioMirrorResetReplacesOnlyItsOwnRows();
  scenarioCarriedRowsStayTheEarlierVolumes();
  scenarioTopUpBringsTheMissingHalf();
  scenarioUnreadableLineIsHigh();
  scenarioArtifactWithoutSectionsIsMedium();
  scenarioGradedSampleIsDeterministicAndBounded();
  scenarioReportKeepsTheShapeItsReadersExpect();
  scenarioReportSectionsAreBoundedAndSayHowBigTheyAre();
  scenarioAuditCountsAreTheStoresOwn();
  await scenarioFlagOffTouchesNothing();
  scenarioExtractionRowsNeverRenderIntoADocument();
  console.log("reference-store pipeline: all checks passed.");
})().catch((err) => {
  console.error(`reference-store pipeline test failed: ${err.message}`);
  process.exit(1);
});

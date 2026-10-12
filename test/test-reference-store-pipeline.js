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
 * The roster scenarios are the same shape applied to the roster itself. Volume 01's record carries an
 * entry keyed `俺` with 14 of the protagonist's claims under it, and that record is sealed. So the suite
 * plants the same split in a fixture and asks where the fold is allowed (the next volume's copy, never
 * the published record), what it does to the presence measurement (the pronoun's occurrences stay under
 * the pronoun; the coverage count is the union, which makes the guard stronger rather than weaker), and
 * what it must not do (fold a character into their own nickname, or choose between two candidates).
 *
 * The planted damage case — a character named in three of three chapters whom the reference never
 * mentions — is re-run here after those changes and is still HIGH, and still stops the copy-forward.
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
  glossaryRowsInRecord,
  ensureVolumeGlossaryInRecord,
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
  reconcileInheritedRoster,
  rosterIdentityConflicts,
  resolveExtractionName,
  displayAliasSpans,
  uncoveredCharacters,
  BARE_FIRST_PERSON_PRONOUNS,
} = require("../utils/reference-store");
const { documentMirrored, documentRebuilt, glossaryBackfilled, DOCUMENT_VOICE } = require("../utils/reference-store/document-prose");
const { STORE_VALIDATORS } = require("../configs/shared");
const { envMaxLineLength } = require("../ai/env");
const { fixtureStoreSeries, assertInsideFixture, GLOSSARY_01, SOURCE_02, VOICE_01, VOICE_01_MISSING_CHARACTERS, EXTRACTION_01 } = require("./fixture-reference-store");
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

// ─── The completeness rule: a volume's published glossary is in that volume's record ────────────

/**
 * Volume 02's published glossary, written into the fixture the way the real one is on disk: a
 * cumulative file that carries the earlier volume's rows and adds its own.
 *
 * Its four rows are chosen so all three answers the rule can give appear at once: a term the record
 * already owns and this volume's text prints (carried), a term the record already owns that this
 * volume's text does NOT print (carried without being re-proved), a term this volume introduces
 * (imported), and a term no volume's text prints (refused).
 */
const GLOSSARY_02 = `# Glossary

_Canonical renderings for the fixture series._

## Characters

| Japanese | English | Notes |
|---|---|---|
| 如月雨露 | Kisaragi Amatsuyu | Protagonist; the narrator |
| 三色院菫子 | Sanshokuin Sumireko | Library committee |

## Terms

| Japanese | English | Notes |
|---|---|---|
| 駱駝 | The Camel | 駱駝はあとがきに書いた。 |
| 存在しない用語 | Not In The Book | This term is never printed |
`;

/** The one-row glossary used to plant a row this volume already owns. */
const GLOSSARY_02_PLANTED = `# Glossary

## Terms

| Japanese | English | Notes |
|---|---|---|
| 駱駝 | The Camel | planted by hand before the completeness rule ever ran |
`;

/**
 * A volume's published glossary reaches that volume's record even though the glossary stage never
 * ran on it. This is the shape the real series is in: the stage finished for all 17 volumes before
 * the store existed, its idempotence check skips a volume whose accepted file is on disk, and the
 * skip happens before the stage's store block — so a rule hung on the stage would never fire.
 */
function scenarioAPublishedGlossaryReachesItsOwnVolumesRecord() {
  const fx = fixtureStoreSeries("pipeline-glossary-completeness");

  const one = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importGlossary(one, GLOSSARY_01);
  importVoice(one, VOICE_01);
  one.sealVolume(1);
  one.close();

  // Volume 2's published glossary is on disk. No glossary stage is invoked anywhere in this scenario.
  fs.writeFileSync(path.join(fx.dir, "Test Story(02)", "glossary.md"), GLOSSARY_02, "utf8");

  const opened = openVolumeRecord({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, previousVolume: 1, previousFolder: "Test Story(01)" });
  assert.ok(opened.ok, opened.refusal && opened.refusal.because);
  const two = opened.store;

  const backfill = opened.glossaryBackfill;
  assert.ok(backfill.ran, `the rule ran: ${backfill.because}`);
  assert.strictEqual(backfill.held, 0, "the record held no glossary rows of its own before it");
  assert.strictEqual(backfill.imported, 1, "the term this volume introduces becomes this volume's row");
  const ownRow = two.db
    .prepare("SELECT examples FROM facts WHERE aspect = 'term_usage' AND owner_volume = 2")
    .get();
  assert.ok(ownRow && String(JSON.parse(ownRow.examples)[0]) === "駱駝", `volume 2's own glossary row is the one volume 2 introduced: ${ownRow && ownRow.examples}`);
  assert.strictEqual(backfill.carried, 2, "the rows the record already owns are counted, not duplicated");
  assert.strictEqual(backfill.refused.length, 1, "and the row no volume's text prints is refused");
  assert.match(backfill.refused[0].because, /存在しない用語/, `the refusal names the term: ${backfill.refused[0].because}`);
  assert.ok(backfill.castRegistered > 0, "the glossary's Characters section registers the roster, which is what the coverage guard asks about");

  assert.strictEqual(glossaryRowsInRecord(two, 2), 1, "one glossary row is owned by volume 2");
  assert.strictEqual(glossaryRowsInRecord(two, 1), 5, "volume 1's five rows are still owned by volume 1");
  assert.ok(glossaryBackfilled(two, 2), "and the record says where volume 2's rows came from");

  const audit = auditVolumeRecord(two, { title: "Glossary", file: "glossary.md", markdown: GLOSSARY_02 });
  assert.ok(audit.glossary.rows === 1, "the audit counts this volume's glossary rows");
  assert.ok(audit.markdown.includes("glossary rows this volume's record holds | **1**"), `the report prints the number:\n${audit.markdown}`);

  two.close();
  console.log("reference-store pipeline: a volume's published glossary is read into that volume's record when the record is opened, whether or not the glossary stage ran on it");
}

/**
 * The rule tops up and never overwrites: a row this volume's record already owns is left exactly as
 * it is, and the rule says so instead of quietly re-reading the published file over it.
 */
function scenarioTheGlossaryRuleTopsUpAndNeverOverwrites() {
  const fx = fixtureStoreSeries("pipeline-glossary-top-up");

  const one = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importGlossary(one, GLOSSARY_01);
  importVoice(one, VOICE_01);
  one.sealVolume(1);
  one.close();

  const first = openVolumeRecord({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, previousVolume: 1, previousFolder: "Test Story(01)" });
  assert.ok(first.ok, first.refusal && first.refusal.because);
  const two = first.store;
  assert.strictEqual(first.glossaryBackfill.ran, false, "there is no published glossary here yet, so there is nothing to import");

  // Plant a row this volume owns, then put the published file on disk.
  importGlossary(two, GLOSSARY_02_PLANTED);
  fs.writeFileSync(path.join(fx.dir, "Test Story(02)", "glossary.md"), GLOSSARY_02, "utf8");

  const before = two.db
    .prepare("SELECT id, body, owner_volume AS ownerVolume FROM facts WHERE aspect = 'term_usage' AND owner_volume = 2 ORDER BY id")
    .all();
  assert.strictEqual(before.length, 1, "the planted row is this volume's only glossary row");

  const again = ensureVolumeGlossaryInRecord(two, { volume: 2 });
  assert.strictEqual(again.ran, false, `a record that already owns glossary rows is not re-imported: ${again.because}`);
  assert.strictEqual(again.held, 1, "and the answer says how many it holds");

  const after = two.db
    .prepare("SELECT id, body, owner_volume AS ownerVolume FROM facts WHERE aspect = 'term_usage' AND owner_volume = 2 ORDER BY id")
    .all();
  assert.deepStrictEqual(after, before, "the planted row is byte-for-byte what it was, and nothing else arrived");

  two.close();
  console.log("reference-store pipeline: the glossary completeness rule tops up a record that holds nothing and leaves a record that holds something alone");
}

/**
 * A row the record already owns is not asked to re-prove itself in a volume that never claimed it.
 *
 * The glossary is cumulative, so every later volume's file carries the earlier volumes' rows. Checking
 * the "already stored" rule after the evidence rule made each of those rows a refusal in every volume
 * it was merely carried through — on the real volume 02 that was 42 of its 46 refusals, for rows that
 * were sitting in the record the whole time with volume 1's evidence behind them.
 */
function scenarioCarriedGlossaryRowsAreNotReProvedAgainstThisVolume() {
  const fx = fixtureStoreSeries("pipeline-glossary-carried");

  const one = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importGlossary(one, GLOSSARY_01);
  importVoice(one, VOICE_01);
  one.sealVolume(1);
  one.close();

  // 三色院菫子 is volume 1's character: the record owns her row, and volume 2's text never prints her.
  const volumeTwoText = Object.values(SOURCE_02).flat().join("\n");
  assert.ok(!volumeTwoText.includes("三色院菫子"), "the fixture's volume 02 text must not print her, or this scenario proves nothing");

  fs.writeFileSync(path.join(fx.dir, "Test Story(02)", "glossary.md"), GLOSSARY_02, "utf8");
  const opened = openVolumeRecord({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, previousVolume: 1, previousFolder: "Test Story(01)" });
  const carried = opened.glossaryBackfill.carried;
  assert.strictEqual(carried, 2, `the two rows the record already owns are carried, not re-proved (refused: ${opened.glossaryBackfill.refused.map((r) => r.row.term).join(", ")})`);
  assert.ok(!opened.glossaryBackfill.refused.some((r) => r.row.term === "三色院菫子"), "and it is not reported as damage");

  const row = opened.store.db
    .prepare("SELECT owner_volume AS ownerVolume, body FROM facts WHERE aspect = 'term_usage' AND examples LIKE '%三色院菫子%'")
    .get();
  assert.strictEqual(row.ownerVolume, 1, "the row is still volume 1's, with volume 1's evidence");

  opened.store.close();
  console.log("reference-store pipeline: a cumulative glossary row the record already owns is carried through a volume, not refused by it");
}

/**
 * A volume that contributed nothing is a number on the page, not an absence somebody has to notice.
 */
function scenarioAVolumeThatContributedNoGlossarySaysZero() {
  const fx = fixtureStoreSeries("pipeline-glossary-silent");

  const one = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  importGlossary(one, GLOSSARY_01);
  importVoice(one, VOICE_01);
  one.sealVolume(1);
  one.close();

  const opened = openVolumeRecord({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, previousVolume: 1, previousFolder: "Test Story(01)" });
  assert.strictEqual(opened.glossaryBackfill.ran, false);
  assert.match(opened.glossaryBackfill.because, /no published glossary\.md/, opened.glossaryBackfill.because);

  const audit = auditVolumeRecord(opened.store, { title: "Character-voice reference", file: "character-voice.md", markdown: VOICE_01 });
  assert.ok(audit.markdown.includes("glossary rows this volume's record holds | **0**"), `the report says zero out loud:\n${audit.markdown}`);

  opened.store.close();
  console.log("reference-store pipeline: a volume whose record holds no glossary rows is reported as holding no glossary rows");
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

// ─── The flag: off means the glossary glue runs nothing ───────────────────────

/**
 * The glossary flag defaults off, and with it off the stage glue touches nothing: no record is opened,
 * no row is written, no file is changed. That is the rollback guarantee, tested rather than asserted.
 *
 * The voice half of the flag is gone (the voice stage renders its artifacts out of the record, so the
 * record is not optional), and `voiceStore.*` with no record open is the same guarantee from the other
 * side: every glue verb returns null and writes nothing.
 */
async function scenarioFlagOffTouchesNothing() {
  assert.deepStrictEqual(STORE_VALIDATORS, { glossary: false }, "the glossary flag defaults off (plan 04 §12: a stage that has not run a real volume through the new path keeps the old one)");

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

/**
 * Append lines to a fixture volume's chapter files, before its chapters are registered.
 *
 * Presence is measured from the files on disk, so this is how a scenario puts a name into enough
 * chapters to reach the significance line. It stays inside the fixture (AGENTS.md rule 8).
 *
 * @param {{dir: string, volumes: Array<{folder: string, base: string}>}} fx
 * @param {number} volumeIndex
 * @param {Object<string, string[]>} linesByChapter - `{ch1: ["…"], ch2: ["…"]}`
 * @returns {void}
 */
function appendToFixtureChapters(fx, volumeIndex, linesByChapter) {
  const volume = fx.volumes[volumeIndex];
  for (const [id, lines] of Object.entries(linesByChapter)) {
    const file = path.join(volume.dir, `${volume.base}-${id}.md`);
    fs.appendFileSync(file, lines.join("\n") + "\n", "utf8");
  }
}

/**
 * Volume 01's actual defect, planted in a fixture: a roster entry keyed by the word for "I".
 *
 * The extraction named a character `俺（如月雨露・第二章終盤）`, none of the name rules could read it,
 * and it became its own entry with the protagonist's claims under it. The claim is filed through the
 * extraction handle, because that is where it came from — a claim filed under the document stage would
 * count as coverage and hide the very thing this scenario is about.
 *
 * @param {Object} fx
 * @param {string} stage
 * @returns {{store: Object, phantomId: string}}
 */
function plantPronounPhantom(fx, stage = DOCUMENT_SOURCE_STAGE) {
  appendToFixtureChapters(fx, 0, { ch1: ["俺は窓を見た。"], ch2: ["俺は廊下に出た。"] });
  const store = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage });
  assertInsideFixture(store.file, fx.dir);
  const registered = store.registerChaptersFromSource();
  assert.ok(registered.ok, registered.error);
  importGlossary(store, GLOSSARY_01);
  store.upsertCast({ key: "俺", display: "俺（如月雨露・第二章終盤）", firstSeenVolume: 1 });
  const filed = importVolumeExtraction({
    volume: 1,
    folder: fx.volumes[0].folder,
    seriesDir: fx.dir,
    voiceEntries: [
      {
        type: "voice",
        character: "俺（主人公）",
        quirkType: "pronoun",
        description: "First person 俺, and the narration never leaves it.",
        examples: ["「さぁ、今日も俺の熱き血潮を迸らせるぜ！」"],
      },
    ],
  }).voice;
  assert.ok(filed.ok, JSON.stringify(filed.refused));
  return { store, phantomId: filed.imported[0].id };
}

/**
 * A split the earlier volume froze is folded when the next volume's record is built, and the sealed
 * record it came from is not touched.
 *
 * Volume 01's record is published: it is the record a translation was already built on, and it stays
 * byte-identical. Volume 02's record is a copy that has published nothing, and the phantom it carries is
 * volume 01's error arriving in every volume after it. This is the only moment the fold is legal, and the
 * merge is written down with the heading that produced it as its reason.
 * @returns {void}
 */
function scenarioAPhantomRosterEntryIsFoldedByTheNextVolume() {
  const fx = fixtureStoreSeries("pipeline-roster-merge");
  const { store: one, phantomId } = plantPronounPhantom(fx);
  // No character-voice document is imported here on purpose: the coverage question is not asked until
  // this volume's reference has been read into the record, so the volume is copyable, which is the state
  // volume 01 is actually in — a published record that passes its own audit and still carries the split.
  const sealed = one.sealVolume(1);
  assert.ok(sealed.ok, "the volume that made the phantom publishes it, and this test does not undo that");
  const published = {
    cast: one.db.prepare("SELECT key, display, merged_into AS merged FROM cast ORDER BY key").all(),
    facts: one.db.prepare("SELECT id, key, sealed FROM facts ORDER BY id").all(),
    merges: one.db.prepare("SELECT survivor, merged FROM cast_merges ORDER BY survivor, merged").all(),
  };
  one.close();

  const opened = openVolumeRecord({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, previousVolume: 1, previousFolder: "Test Story(01)" });
  assert.ok(opened.ok, opened.refusal && opened.refusal.because);
  const two = opened.store;

  assert.deepStrictEqual(
    opened.roster.merged.map((m) => [m.merged, m.survivor, m.movedFacts]),
    [["俺", "如月雨露", 1]],
    "the fold happens, and it says how many claims moved"
  );
  assert.match(opened.roster.merged[0].heading, /如月雨露・第二章終盤/, "and it names the heading that produced it");

  assert.strictEqual(two.getCast("俺").merged_into, "如月雨露", "the phantom stays, marked with where it went");
  assert.strictEqual(two.getCast("如月雨露").merged_into, null, "the surviving entry is the one claims are filed under");
  const merges = two.castMerges();
  assert.strictEqual(merges.length, 1, "and the merge is recorded, because a wrong merge is the one thing a reader must be able to find");
  assert.match(merges[0].reason, /俺（如月雨露・第二章終盤）/, "with the reason, which is quotable rather than invented");

  const moved = two.db.prepare("SELECT id, key, owner_volume AS ownerVolume, sealed FROM facts WHERE id = ?").get(phantomId);
  assert.strictEqual(moved.key, "如月雨露", "the claim moved onto the character it was always about");
  assert.strictEqual(moved.ownerVolume, 1, "and it still belongs to the volume that wrote it");
  assert.strictEqual(moved.sealed, 1, "and it is still sealed: the fold re-points a copy, it does not un-publish anything");
  assert.strictEqual(two.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE key = '俺'").get().n, 0, "nothing is left under the pronoun");

  const reopened = openVolumeRecord({ volume: 2, folder: "Test Story(02)", seriesDir: fx.dir, previousVolume: 1, previousFolder: "Test Story(01)" });
  assert.ok(reopened.ok, reopened.refusal && reopened.refusal.because);
  assert.deepStrictEqual(reopened.roster.merged, [], "reopening the same volume does not merge it a second time");
  assert.strictEqual(reopened.store.castMerges().length, 1, "and the record still says it happened once");

  reopened.store.close();
  two.close();

  const after = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  assert.deepStrictEqual(
    after.db.prepare("SELECT key, display, merged_into AS merged FROM cast ORDER BY key").all(),
    published.cast,
    "volume 01's own roster is untouched: the phantom is still there, as published"
  );
  assert.deepStrictEqual(
    after.db.prepare("SELECT id, key, sealed FROM facts ORDER BY id").all(),
    published.facts,
    "with its claim under the name it was filed under, still sealed"
  );
  assert.deepStrictEqual(
    after.db.prepare("SELECT survivor, merged FROM cast_merges ORDER BY survivor, merged").all(),
    published.merges,
    "and volume 01's record has no merge in it: the fold happened in the copy, not in the original"
  );
  after.close();

  console.log("reference-store pipeline: a roster entry keyed by a pronoun is folded when the next volume inherits it, and the sealed record it came from is untouched");
}

/**
 * A record that has published cannot have its own roster reconciled.
 *
 * The fold is legal at one moment only: after a record is copied in and before it publishes anything.
 * Asked of a sealed volume it is the same edit `castAlias` refuses, and it is refused here for the same
 * reason, stated about the record rather than about the rows.
 * @returns {void}
 */
function scenarioASealedRecordDoesNotReconcileItsOwnRoster() {
  const fx = fixtureStoreSeries("pipeline-roster-sealed");
  const { store } = plantPronounPhantom(fx);
  assert.ok(store.sealVolume(1).ok);

  const refused = store.mergeInheritedCastEntry({
    survivor: "如月雨露",
    merged: "俺",
    reason: "its own heading names 如月雨露",
  });
  assert.strictEqual(refused.ok, false, "a sealed record is the record a translation was built on");
  assert.strictEqual(refused.refusal.rule, "cast-merge-volume-sealed");
  assert.strictEqual(store.getCast("俺").merged_into, null, "and nothing moved");

  store.close();
  console.log("reference-store pipeline: a sealed volume's own roster is not reconciled, and the refusal says why");
}

/**
 * The fold moves identity, not evidence: the pronoun's occurrences stay attributed to the pronoun, and
 * the coverage rule's chapter count is the union — which makes the guard stronger, never weaker.
 *
 * Before the fold the record reports the phantom as a character in 3 of 3 chapters and the protagonist as
 * a barely-present mention in 2. After it, there is one person, present in 3 chapters, and the report
 * names which spellings produced that number. A protagonist whose surname the book prints twice is not a
 * bit part, and a rule that only looked at his surname would call him one.
 * @returns {void}
 */
function scenarioAMergedNameStaysAttributedToTheNameThatProducedIt() {
  const fx = fixtureStoreSeries("pipeline-roster-presence");
  const { store } = plantPronounPhantom(fx);
  importVoice(
    store,
    "# Character Voice Reference\n\n## Characters\n\n### 三色院菫子（パンジー）\n\n- **Pronouns**: 一人称は私。\n\n### 大賀太陽\n\n- **Catchphrases**: 「ドンマイだ！ ドンマイ！」\n\n### ジョーロ\n\n- **Notes**: ジョーロは窓を見た。\n"
  );
  recordCastPresence(store);

  const before = store.integrityFindings({ volume: "01" });
  const beforeLoss = expectFinding(before, "reference-voice-covers-fewer-characters");
  const beforeMention = expectFinding(before, "reference-voice-mention-not-covered");
  assert.strictEqual(beforeLoss.severity, "HIGH");
  assert.match(beforeLoss.message, /俺/, "before the fold, the phantom is the character in 3 of 3 chapters");
  assert.match(beforeMention.message, /如月雨露/, "and the protagonist is the soft one — a mention, because only his own surname was counted");

  const merged = store.mergeInheritedCastEntry({
    survivor: "如月雨露",
    merged: "俺",
    reason: "its own heading names 如月雨露 as a whole word",
  });
  assert.ok(merged.ok, merged.refusal && merged.refusal.because);

  recordCastPresence(store);
  const rows = castPresence(store, 1);
  const pronounRow = rows.find((row) => row.key === "俺");
  const protagonistRow = rows.find((row) => row.key === "如月雨露");
  assert.ok(pronounRow && protagonistRow, "both names are still measured, each under its own key");
  assert.strictEqual(pronounRow.chapters, 3, "the pronoun's occurrences stay attributed to the pronoun");
  assert.strictEqual(protagonistRow.chapters, 2, "and the protagonist's own row counts only his own name, not the alias a merge handed him");

  const after = store.integrityFindings({ volume: "01" });
  const afterCoverage = expectFinding(after, "reference-voice-covers-fewer-characters");
  assert.strictEqual(afterCoverage.severity, "HIGH", "the fold does not soften the guard: one person in 3 of 3 chapters is a loss");
  assert.match(afterCoverage.message, /3 of this volume's 3 chapters/, "counted over every name that person is filed under");
  assert.match(afterCoverage.message, /through 如月雨露/, "and the report says which spellings produced the count");
  assert.match(afterCoverage.message, /through 俺/);

  const uncovered = uncoveredCharacters(store, 1).map((row) => row.key);
  assert.deepStrictEqual(uncovered, ["如月雨露"], "the phantom is no longer a character of its own, so it is not reported as one");
  expectNoFinding(
    after,
    "reference-character-split-in-two",
    "the merge put 俺 in 如月雨露's alias list, and an alias that is a merged entry is the merged state, not a split"
  );

  store.close();
  console.log("reference-store pipeline: a merged name keeps its own presence evidence, and the coverage count is the union of the names one person is filed under");
}

/**
 * The rule does not merge on containment alone, and it does not choose between two candidates.
 *
 * `如月雨露（ジョーロ）【俺人格】` contains ジョーロ, which is a roster entry: a rule that merged on
 * containment would fold the protagonist into his own nickname and orphan every glossary row keyed with
 * his name. `女（図書委員）` names nothing. An entry that names two entries is reported and left alone.
 * @returns {void}
 */
function scenarioTheRosterRuleDoesNotMergeOnContainmentAlone() {
  const fx = fixtureStoreSeries("pipeline-roster-narrow");
  const store = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  store.registerChaptersFromSource();
  importGlossary(store, GLOSSARY_01);
  store.upsertCast({ key: "女", display: "女（図書委員）", firstSeenVolume: 1 });
  store.upsertCast({ key: "私", display: "私（如月雨露・大賀太陽）", firstSeenVolume: 1 });
  // The shape that a containment-only rule would get wrong: the protagonist's own heading carries his
  // nickname, and the nickname is a roster entry of its own.
  store.upsertCast({ key: "如月雨露", display: "如月雨露（ジョーロ）【俺人格】", firstSeenVolume: 1 });
  store.upsertCast({ key: "ジョーロ", display: "ジョーロ", firstSeenVolume: 1 });

  const conflicts = rosterIdentityConflicts(store);
  assert.deepStrictEqual([...new Set(conflicts.map((c) => c.merged))], ["私"], "a nickname inside a heading is not a conflict, and neither is a label that names nothing");
  assert.ok(conflicts.every((c) => c.ambiguous), "and the one entry it did find names two roster entries, so every row about it is flagged");

  const opened = reconcileInheritedRoster(store);
  assert.strictEqual(opened.merged.length, 0, "and the one conflict it found is not merged");
  assert.strictEqual(opened.ambiguous.length, 1, "because it names two entries, and picking between them is a decision");
  assert.deepStrictEqual(opened.ambiguous[0].names, ["如月雨露", "大賀太陽"]);
  assert.strictEqual(store.castMerges().length, 0, "so the roster is left exactly as it was, with the conflict reported");
  assert.strictEqual(store.getCast("如月雨露").merged_into, null, "the protagonist is not folded into his own nickname");
  assert.strictEqual(store.getCast("ジョーロ").merged_into, null);
  assert.strictEqual(store.getCast("女").merged_into, null, "and a label that names no roster entry is left where it was");
  assert.ok(displayAliasSpans(store.getCast("如月雨露").display).includes("ジョーロ"), "the containment is really there — it is the pronoun gate that declines it");

  store.close();
  console.log("reference-store pipeline: the roster rule needs a pronoun key and a whole-token name, and it reports an ambiguous heading instead of choosing");
}

/**
 * A pronoun label that names a roster entry no longer creates a roster entry of its own.
 *
 * This is the prevention half. Without it, the fold has to run again in every later volume, because the
 * extraction keeps producing the same phantom name.
 * @returns {void}
 */
function scenarioAPronounLabelResolvesOntoTheEntryItNames() {
  const fx = fixtureStoreSeries("pipeline-roster-prevention");
  const store = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: DOCUMENT_SOURCE_STAGE });
  store.registerChaptersFromSource();
  importGlossary(store, GLOSSARY_01);

  const named = resolveExtractionName(store, "俺（如月雨露・第二章終盤）");
  assert.strictEqual(named.key, "如月雨露", "the label names the roster entry, so the label is that entry");
  assert.strictEqual(named.resolved, true);
  assert.match(named.how, /its own label names 如月雨露/);

  const nickname = resolveExtractionName(store, "如月雨露（ジョーロ）【俺人格】");
  assert.strictEqual(nickname.key, "如月雨露", "and a heading that contains a nickname still resolves onto the character, not onto the nickname");

  const prose = resolveExtractionName(store, "俺（如月雨露の友人）");
  assert.strictEqual(prose.resolved, false, "a label that mentions a character in prose is not a link: the token has to BE the key");

  const filed = importVolumeExtraction({
    volume: 1,
    folder: fx.volumes[0].folder,
    seriesDir: fx.dir,
    voiceEntries: [
      {
        type: "voice",
        character: "俺（如月雨露・第二章終盤）",
        quirkType: "pronoun",
        description: "First person 俺, filed where the label says it belongs.",
        examples: ["「さぁ、今日も俺の熱き血潮を迸らせるぜ！」"],
      },
    ],
  }).voice;
  assert.ok(filed.ok, JSON.stringify(filed.refused));
  assert.strictEqual(store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE key = '如月雨露'").get().n, 1, "the claim lands on the protagonist");
  assert.strictEqual(store.getCast("俺"), null, "and the phantom is never created");

  store.close();
  console.log("reference-store pipeline: a pronoun label that names a roster entry resolves onto it, so the phantom is not created in the first place");
}

/**
 * The pronoun list is a closed vocabulary, and the test is what stops it from drifting.
 * @returns {void}
 */
function scenarioThePronounListIsClosed() {
  assert.ok(BARE_FIRST_PERSON_PRONOUNS.includes("俺"), "the word this whole rule exists for is in it");
  assert.ok(!BARE_FIRST_PERSON_PRONOUNS.includes("如月雨露"), "a name is not");
  assert.ok(!BARE_FIRST_PERSON_PRONOUNS.includes("俺様"), "and neither is a pronoun with a suffix on it: the rule is about the bare word");
  assert.strictEqual(new Set(BARE_FIRST_PERSON_PRONOUNS).size, BARE_FIRST_PERSON_PRONOUNS.length, "no duplicates");
  console.log(`reference-store pipeline: the bare first-person pronouns are a closed list of ${BARE_FIRST_PERSON_PRONOUNS.length}, pinned here`);
}

/**
 * A document section headed by the retired name files onto the surviving entry, and still renders.
 *
 * Volume 01's published reference has a section headed `俺（如月雨露・第二章終盤）`, and volume 02's voice
 * stage starts from a copy of that file. If the document door asked its own question about that heading —
 * which it used to, separately from the extraction door — the section's bullets would be filed under a
 * roster entry the record has already retired, and `renderVoice` does not render merged entries, so the
 * bullets would disappear from the next volume's reference without anyone being told.
 * @returns {void}
 */
function scenarioAFoldedHeadingFilesOntoTheSurvivorAndStillRenders() {
  const fx = fixtureStoreSeries("pipeline-voice-rekey");
  const { store } = plantPronounPhantom(fx);
  assert.ok(
    store.mergeInheritedCastEntry({ survivor: "如月雨露", merged: "俺", reason: "its own heading names 如月雨露" }).ok
  );

  const markdown =
    "# Character Voice Reference\n\n## Characters\n\n### 俺（如月雨露・第二章終盤）\n\n" +
    "- **Pronouns**: 一人称は「さぁ、今日も俺の熱き血潮を迸らせるぜ！」で語られる。\n";
  const imported = importVoice(store, markdown);
  assert.ok(imported.ok, JSON.stringify(imported.refused));
  assert.deepStrictEqual(
    imported.rekeyed.map((r) => [r.heading, r.key]),
    [["俺（如月雨露・第二章終盤）", "如月雨露"]],
    "the move is reported, not absorbed"
  );
  assert.strictEqual(store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE key = '俺' AND source_stage = 'import'").get().n, 0, "nothing is filed under the retired name");
  assert.strictEqual(store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE key = '如月雨露' AND source_stage = 'import'").get().n, 1, "it is filed under the character it is about");

  const rendered = renderVoice(store);
  assert.match(rendered, /### 如月雨露/, "and the reference renders the character, not the pronoun");
  assert.ok(rendered.includes("熱き血潮"), "with the bullet that would otherwise have vanished");
  assert.ok(!rendered.includes("### 俺（"), "and the retired heading is not a section of its own");

  store.close();
  console.log("reference-store pipeline: a document section headed by a retired name files onto the survivor and still renders");
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
  scenarioAPhantomRosterEntryIsFoldedByTheNextVolume();
  scenarioASealedRecordDoesNotReconcileItsOwnRoster();
  scenarioAMergedNameStaysAttributedToTheNameThatProducedIt();
  scenarioTheRosterRuleDoesNotMergeOnContainmentAlone();
  scenarioAPronounLabelResolvesOntoTheEntryItNames();
  scenarioAFoldedHeadingFilesOntoTheSurvivorAndStillRenders();
  scenarioThePronounListIsClosed();
  scenarioCoverageIsNotAskedBeforeTheReferenceIsMirrored();
  scenarioUnadoptedClaimsAreNamed();
  scenarioExtractionClaimsAreNotCoverage();
  scenarioInventedExtractionClaimsAreRefused();
  scenarioMirrorResetReplacesOnlyItsOwnRows();
  scenarioCarriedRowsStayTheEarlierVolumes();
  scenarioTopUpBringsTheMissingHalf();
  scenarioAPublishedGlossaryReachesItsOwnVolumesRecord();
  scenarioTheGlossaryRuleTopsUpAndNeverOverwrites();
  scenarioCarriedGlossaryRowsAreNotReProvedAgainstThisVolume();
  scenarioAVolumeThatContributedNoGlossarySaysZero();
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

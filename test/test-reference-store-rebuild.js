/**
 * test/test-reference-store-rebuild.js — the rebuild-from-extraction path.
 *
 * What this suite is for. Volume 01's `character-voice.md` is destroyed and its extraction output is
 * healthy, so `utils/reference-store/rebuild.js` can type the reference from the extraction instead of
 * paying the authoring agents to re-type it. That is a path which, done wrong, is simply "let the
 * extractor's raw output into a published artifact", so every scenario here checks a boundary that
 * path is supposed to respect — and, as in `test/test-reference-store-pipeline.js`, plants the defect
 * and names the severity a query is supposed to report, because "the audit found something" is not a
 * result.
 *
 * The boundaries:
 *
 *   - the candidate rule is untouched: rows the extractor filed still do not render, and a rebuild
 *     makes a claim renderable by **adopting it into a new kind of row**, not by loosening a filter;
 *   - the evidence rule is untouched: a claim whose quotes are not in this volume's text is refused;
 *   - the damaged artifact is not an input, and it is not overwritten without being moved aside;
 *   - a rebuilt reference is audited by the same queries as an authored one — coverage still fires at
 *     HIGH — and it is labelled as rebuilt in the record, in the report and in the file;
 *   - names are resolved narrowly, so a rebuilt roster does not silently split one character in two,
 *     and the links a human has to supply are reported rather than invented.
 *
 * Every scenario runs inside `test/fixture-reference-store.js`'s throwaway series. Nothing here can
 * reach the real corpus (AGENTS.md rule 8, gotcha 69). No model, no network — and the last scenario
 * points the environment at the scripted endpoint in `test/fake-backend.js` and asserts it heard
 * nothing, which is the only way to assert "this path is deterministic" without reading the source for
 * promises.
 *
 * Run with `npm test`, or standalone: `node test/test-reference-store-rebuild.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

delete process.env.GLOSSARY_STORE_VALIDATORS;
delete process.env.VOICE_STORE_VALIDATORS;

const {
  openReferenceStore,
  importVolumeArtifacts,
  importVolumeExtraction,
  importVoiceExtraction,
  copyForwardStore,
  sealVolumeRecord,
  auditVolumeRecord,
  importVoice,
  renderVoice,
  rebuildVoiceFromExtraction,
  renderRebuiltVoice,
  writeRebuiltVoiceFile,
  rebuildVoiceVolume,
  renderPovMap,
  writePovMapFile,
  renderPovMapFromRecord,
  povClaimsInRecord,
  POV_MAP_FILE,
  POV_UNATTACHED_LABEL,
  moveArtifactAside,
  resolveExtractionName,
  applyAliasDeclarations,
  displayAliasSpans,
  rebuiltDocuments,
  rebuildProvenance,
  unadoptedVoiceClaims,
  artifactShapeFindings,
  REBUILD_SOURCE_STAGE,
  EXTRACTION_SOURCE_STAGE,
  DOCUMENT_SOURCE_STAGE,
  COVERAGE_SIGNIFICANCE_CHAPTERS,
  MAX_REBUILD_BULLET_CHARS,
  voicePrimaryName,
  isVolumeSealed,
  factsAtVolume,
} = require("../utils/reference-store");
const { documentRebuilt, DOCUMENT_VOICE } = require("../utils/reference-store/document-prose");
const { startFakeBackend } = require("./fake-backend");
const { fixtureStoreSeries, assertInsideFixture, GLOSSARY_01, VOICE_01, EXTRACTION_01, EXTRACTION_01_UNVERIFIABLE } = require("./fixture-reference-store");

/**
 * Open a fixture volume's record in a named stage.
 *
 * @param {ReturnType<typeof fixtureStoreSeries>} series
 * @param {number} volume
 * @param {string} stage
 * @returns {ReferenceStore}
 */
function openFixture(series, volume, stage) {
  const entry = series.volumes[volume - 1];
  const store = openReferenceStore({ volume, folder: entry.folder, seriesDir: series.dir, stage });
  assertInsideFixture(store.file, series.dir);
  store.registerChaptersFromSource();
  return store;
}

/**
 * Read the volume's glossary into its record — the roster the coverage question needs.
 *
 * @param {ReturnType<typeof fixtureStoreSeries>} series
 * @param {number} [volume]
 * @returns {ReferenceStore}
 */
function withRoster(series, volume = 1) {
  const store = openFixture(series, volume, DOCUMENT_SOURCE_STAGE);
  importVolumeArtifacts(store, { glossaryMarkdown: GLOSSARY_01 });
  store.close();
  return store;
}

/**
 * Run a rebuild against a fixture volume and report what it did.
 *
 * @param {ReturnType<typeof fixtureStoreSeries>} series
 * @param {{volume?: number, entries?: Array<Object>, aliases?: Array<{key: string, alias: string, reason: string}>}} [opts]
 * @returns {{store: ReferenceStore, result: Object}}
 */
function rebuildFixture(series, { volume = 1, entries = EXTRACTION_01, aliases = [], candidates = true } = {}) {
  const entry = series.volumes[volume - 1];
  const store = openReferenceStore({ volume, folder: entry.folder, seriesDir: series.dir, stage: REBUILD_SOURCE_STAGE });
  assertInsideFixture(store.file, series.dir);
  store.registerChaptersFromSource();
  const aliasResult = applyAliasDeclarations(store, aliases);
  // The same wiring `rebuildVoiceVolume` uses: the adopted rows through the rebuild handle, the
  // candidate copies through a handle opened as the extraction stage. `candidates: false` is how a
  // scenario asks what a record looks like without them.
  const candidateStore = candidates
    ? openReferenceStore({ volume, folder: entry.folder, seriesDir: series.dir, stage: EXTRACTION_SOURCE_STAGE })
    : null;
  let rebuild;
  try {
    rebuild = rebuildVoiceFromExtraction(store, entries, { candidateStore });
  } finally {
    if (candidateStore) candidateStore.close();
  }
  return { store, result: { rebuild, aliasResult } };
}

/**
 * A claim long enough to break the artifact's read limit.
 *
 * @returns {Object}
 */
function anOverlongClaim() {
  return {
    type: "voice",
    character: "三色院菫子（パンジー）",
    quirkType: "vocabulary",
    description: `Her register is flat. ${"flat bookish narration ".repeat(120)}`,
    examples: ["三色院菫子は本を読んでいた。"],
  };
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A rebuild files claims as rows the document renders, and leaves the candidate rule alone.
 * @returns {void}
 */
function scenarioRebuildFilesClaimsAsRenderableRows() {
  const series = fixtureStoreSeries("rebuild-renderable");
  withRoster(series);
  const { store, result } = rebuildFixture(series);

  assert.strictEqual(result.rebuild.refusal, null, "the rebuild ran");
  assert.ok(result.rebuild.filedCount >= 7, `claims filed: ${result.rebuild.filedCount}`);

  const stages = store.db.prepare("SELECT source_stage, COUNT(*) AS n FROM facts GROUP BY source_stage ORDER BY source_stage").all();
  const byStage = new Map(stages.map((row) => [row.source_stage, row.n]));
  assert.ok((byStage.get(REBUILD_SOURCE_STAGE) || 0) >= 7, "the rows are stamped rebuild");
  assert.strictEqual(
    byStage.get(EXTRACTION_SOURCE_STAGE) || 0,
    result.rebuild.candidates.filed,
    "and every claim the rebuild evaluated and could cite is also filed as a candidate, through the extraction door's own row shape"
  );
  assert.ok(result.rebuild.candidates.filed >= 7, `candidates filed: ${result.rebuild.candidates.filed}`);

  const paired = store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM facts r WHERE r.source_stage = ? AND EXISTS (SELECT 1 FROM facts c " +
        "WHERE c.source_stage = ? AND c.key IS r.key AND c.aspect = r.aspect AND c.body = r.body)"
    )
    .get(REBUILD_SOURCE_STAGE, EXTRACTION_SOURCE_STAGE).n;
  assert.strictEqual(paired, byStage.get(REBUILD_SOURCE_STAGE), "each adopted claim has its candidate beside it — the record holds both readings of the same claim");

  const candidateLabel = store.db
    .prepare("SELECT label FROM facts WHERE source_stage = ? AND aspect = 'catchphrase' AND label IS NOT NULL LIMIT 1")
    .get(EXTRACTION_SOURCE_STAGE);
  const adoptedLabel = store.db
    .prepare("SELECT label FROM facts WHERE source_stage = ? AND aspect = 'catchphrase' AND label IS NOT NULL LIMIT 1")
    .get(REBUILD_SOURCE_STAGE);
  assert.ok(candidateLabel && adoptedLabel, "both kinds carry a catchphrase claim");
  assert.notStrictEqual(candidateLabel.label, adoptedLabel.label, "the candidate keeps the extraction's own label; the adopted row uses the artifact's wording");

  const rendered = renderRebuiltVoice(store);
  assert.ok(rendered.markdown.includes("### 如月雨露"), "the roster's own spelling is the heading");
  assert.ok(rendered.markdown.includes("- **Pronouns**:"), "the artifact's own bullet labels are used");
  assert.ok(rendered.markdown.includes("「気にすんな！」"), "the verified quote is printed, not only a description of it");

  store.close();
  console.log("  rebuild files claims as rows the document renders");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The candidate rule is untouched: extraction rows still do not render, before or after a rebuild.
 * @returns {void}
 */
function scenarioExtractionClaimsStillDoNotRender() {
  const series = fixtureStoreSeries("rebuild-candidate-guard");
  withRoster(series);

  const extractor = openFixture(series, 1, EXTRACTION_SOURCE_STAGE);
  importVoiceExtraction(extractor, EXTRACTION_01);
  const beforeRender = renderVoice(extractor);
  assert.strictEqual(beforeRender.split("\n").filter((line) => line.startsWith("### ")).length, 0, "a store holding only candidates renders no character");
  extractor.close();

  const { store } = rebuildFixture(series);
  const after = renderRebuiltVoice(store);
  assert.ok(after.sections > 0, "the rebuild's own rows do render");

  // And the ordinary renderer still refuses the candidates it has always refused.
  const reader = openReferenceStore({ volume: 1, folder: series.volumes[0].folder, seriesDir: series.dir, stage: DOCUMENT_SOURCE_STAGE });
  const authored = renderVoice(reader);
  const bullets = authored.split("\n").filter((line) => line.startsWith("- **"));
  assert.ok(bullets.length > 0 && bullets.every((line) => !line.includes("Her register is flat")), "the extractor's sentences are not in the document");
  reader.close();
  store.close();
  console.log("  extraction claims still do not render — the guard was not widened");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Planted defect: a claim whose quote the book never prints. Refused, named, and not stored.
 * @returns {void}
 */
function scenarioRebuildRefusesAnUncitableClaim() {
  const series = fixtureStoreSeries("rebuild-evidence");
  withRoster(series);
  const { store, result } = rebuildFixture(series, { entries: [...EXTRACTION_01, EXTRACTION_01_UNVERIFIABLE] });

  const refused = result.rebuild.refused.filter((item) => item.kind === "voice");
  assert.strictEqual(refused.length, 1, `one claim refused: ${JSON.stringify(refused.map((r) => r.because))}`);
  assert.ok(refused[0].because.includes("does not occur") || refused[0].because.includes("occurs in volume"), refused[0].because);

  const stored = store.db.prepare("SELECT body FROM facts WHERE source_stage = ?").all(REBUILD_SOURCE_STAGE);
  assert.ok(!stored.some((row) => row.body.includes("A line the extractor invented")), "the refused claim is not in the record");
  assert.ok(!renderRebuiltVoice(store).markdown.includes("A line the extractor invented"), "and not in the file");
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM cast WHERE key = ?").get("存在しない人物").n,
    0,
    "and it did not put a character the book never prints onto the roster either"
  );

  store.close();
  console.log("  a claim the book does not print is refused by name");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A rebuild needs its own write scope; an ordinary handle cannot stamp its rows.
 * @returns {void}
 */
function scenarioRebuildNeedsItsOwnWriteScope() {
  const series = fixtureStoreSeries("rebuild-scope");
  withRoster(series);
  const store = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  const result = rebuildVoiceFromExtraction(store, EXTRACTION_01);
  assert.strictEqual(result.ok, false, "refused");
  assert.strictEqual(result.refusal.rule, "rebuild-needs-its-own-write-scope", result.refusal && result.refusal.rule);
  assert.strictEqual(result.filedCount, 0, "nothing was filed");
  assert.strictEqual(store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ?").get(REBUILD_SOURCE_STAGE).n, 0, "and no rebuild row exists");
  store.close();
  console.log("  a rebuild run from the wrong stage is refused");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A rebuild is re-runnable: the second pass files nothing new.
 * @returns {void}
 */
function scenarioRebuildIsIdempotent() {
  const series = fixtureStoreSeries("rebuild-idempotent");
  withRoster(series);
  const first = rebuildFixture(series);
  const firstCount = first.store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ?").get(REBUILD_SOURCE_STAGE).n;
  const firstCandidates = first.store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ?").get(EXTRACTION_SOURCE_STAGE).n;
  first.store.close();

  const second = rebuildFixture(series);
  const secondCount = second.store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ?").get(REBUILD_SOURCE_STAGE).n;
  assert.strictEqual(secondCount, firstCount, `the second pass added rows: ${firstCount} → ${secondCount}`);
  assert.strictEqual(second.result.rebuild.filedCount, 0, `the second pass filed ${second.result.rebuild.filedCount} claims again`);
  assert.strictEqual(second.result.rebuild.carried.length, firstCount, `the second pass recognised ${second.result.rebuild.carried.length} of ${firstCount}`);
  assert.strictEqual(
    second.store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ?").get(EXTRACTION_SOURCE_STAGE).n,
    firstCandidates,
    "and the candidate copies are not doubled either — the extraction door's own idempotence guard is what the rebuild files through"
  );
  assert.strictEqual(second.result.rebuild.candidates.filed, 0, `the second pass filed ${second.result.rebuild.candidates.filed} candidates again`);
  second.store.close();
  console.log("  running the rebuild twice files nothing twice");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Names are resolved onto the roster the glossary built — and only by rules that cannot guess.
 * @returns {void}
 */
function scenarioNamesResolveOntoTheRoster() {
  const series = fixtureStoreSeries("rebuild-names");
  withRoster(series);
  const store = openFixture(series, 1, REBUILD_SOURCE_STAGE);

  const nickname = resolveExtractionName(store, "如月雨露（ジョーロ）");
  assert.strictEqual(nickname.key, "如月雨露", "a bracketed nickname finds the roster entry");
  assert.strictEqual(nickname.resolved, true, nickname.how);

  const persona = resolveExtractionName(store, "如月雨露（ジョーロ）【俺人格】");
  assert.strictEqual(persona.key, "如月雨露", "a persona tag does not hide the name");

  const unknown = resolveExtractionName(store, "俺（主人公）");
  assert.strictEqual(unknown.resolved, false, "a name nothing in the roster carries stays unresolved");
  assert.strictEqual(unknown.key, "俺", "and is reported under the name it would create");

  // The narrowness is the point: 女 is a substring of 一人の女子生徒, and a substring match would
  // make a character look covered when nothing was written about them.
  store.upsertCast({ key: "一人の女子生徒", display: "一人の女子生徒", firstSeenVolume: 1 });
  const substring = resolveExtractionName(store, "女（図書委員）");
  assert.strictEqual(substring.resolved, false, "a substring of a roster name is not that character");

  assert.deepStrictEqual(displayAliasSpans("如月雨露（ジョーロ）【俺人格】"), ["ジョーロ", "俺人格"], "the bracketed spans are the aliases the heading carries");

  store.close();
  console.log("  names resolve onto the roster, and a substring match is refused");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A link the artifacts do not record is a human decision, and the store makes them say the reason.
 * @returns {void}
 */
function scenarioAnAliasNeedsAReason() {
  const series = fixtureStoreSeries("rebuild-alias");
  withRoster(series);
  const store = openFixture(series, 1, REBUILD_SOURCE_STAGE);

  const withoutReason = applyAliasDeclarations(store, [{ key: "如月雨露", alias: "俺", reason: "" }]);
  assert.strictEqual(withoutReason.applied.length, 0, "nothing applied");
  assert.ok(withoutReason.refused[0].because.includes("needs a reason"), withoutReason.refused[0].because);
  assert.strictEqual(resolveExtractionName(store, "俺（主人公）").resolved, false, "and the link really was not made");

  const withReason = applyAliasDeclarations(store, [{ key: "如月雨露", alias: "俺", reason: "the glossary's own row says the narrator switches between 僕 and 俺" }]);
  assert.strictEqual(withReason.applied.length, 1, JSON.stringify(withReason));
  assert.strictEqual(resolveExtractionName(store, "俺（主人公）").key, "如月雨露", "the declared link resolves the name");

  store.close();
  console.log("  an undeclared name stays unresolved; a declared one needs a reason");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A declared alias keeps one character from being filed as two roster entries.
 * @returns {void}
 */
function scenarioADeclaredAliasMergesTheRosterBeforeFiling() {
  const series = fixtureStoreSeries("rebuild-alias-merge");
  withRoster(series);
  const { store, result } = rebuildFixture(series, { aliases: [{ key: "如月雨露", alias: "俺", reason: "the glossary's own row says the narrator switches between 僕 and 俺" }] });

  assert.strictEqual(result.aliasResult.applied.length, 1, "the alias was declared");
  const keys = store.db.prepare("SELECT key FROM cast WHERE merged_into IS NULL ORDER BY key").all().map((row) => row.key);
  assert.ok(!keys.includes("俺"), `the roster did not gain a second protagonist: ${keys.join(", ")}`);

  const protagonist = store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE key = ? AND source_stage = ?")
    .get("如月雨露", REBUILD_SOURCE_STAGE).n;
  assert.ok(protagonist >= 2, `the protagonist's claims all landed on the roster entry: ${protagonist}`);
  assert.deepStrictEqual(
    result.rebuild.unresolved.map((entry) => entry.key).sort(),
    ["山田", "秋野桜"],
    `the names the fixture glossary never registered: ${JSON.stringify(result.rebuild.unresolved)}`
  );

  store.close();
  console.log("  a declared alias files the extraction's claims on the character they belong to");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Sections and bullets follow the order the book prints them in, not the order the extraction listed them.
 * @returns {void}
 */
function scenarioSectionsAndBulletsFollowChapterOrder() {
  const series = fixtureStoreSeries("rebuild-order");
  withRoster(series);
  const { store } = rebuildFixture(series, {
    aliases: [{ key: "如月雨露", alias: "俺", reason: "the glossary's own row says the narrator switches between 僕 and 俺" }],
  });
  const rendered = renderRebuiltVoice(store);

  const order = rendered.characters.map((entry) => entry.key);
  assert.ok(order.indexOf("如月雨露") < order.indexOf("三色院菫子"), `the prologue's character comes first: ${order.join(", ")}`);
  assert.ok(order.indexOf("三色院菫子") < order.indexOf("秋野桜"), `the first chapter's character comes before the second chapter's: ${order.join(", ")}`);
  assert.strictEqual(rendered.characters.find((entry) => entry.key === "秋野桜").firstChapter, "ch2", "秋野桜 is only in the second chapter");

  // Inside one character, the bullets are in chapter order too: that ordering is the only thing
  // carrying "what changed and when" (doc 04 §7.1).
  const lines = rendered.markdown.split("\n");
  const start = lines.findIndex((line) => line === "### 如月雨露");
  const bullets = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith("### "); i += 1) {
    if (lines[i].startsWith("- **")) bullets.push(lines[i]);
  }
  const classroom = bullets.findIndex((line) => line.includes("教室に入った"));
  const catchphrase = bullets.findIndex((line) => line.includes("気にすんな！"));
  assert.ok(classroom >= 0 && catchphrase >= 0, "both claims are rendered");
  assert.ok(classroom < catchphrase, `the prologue's claim comes before the first chapter's: ${classroom} vs ${catchphrase}`);

  store.close();
  console.log("  sections and bullets are in chapter order");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Planted defect: a claim long enough to become the 54,341-character line. It is capped, and the cap
 * says so in the file.
 * @returns {void}
 */
function scenarioAnOverlongBulletIsCappedAndNamed() {
  const series = fixtureStoreSeries("rebuild-long-line");
  withRoster(series);
  const { store } = rebuildFixture(series, { entries: [...EXTRACTION_01, anOverlongClaim()] });
  const rendered = renderRebuiltVoice(store);

  const longest = Math.max(...rendered.markdown.split("\n").map((line) => line.length));
  assert.ok(longest <= MAX_REBUILD_BULLET_CHARS, `the file has a ${longest}-character line (the cap is ${MAX_REBUILD_BULLET_CHARS})`);
  assert.strictEqual(rendered.truncated, 1, `truncated bullets: ${rendered.truncated}`);
  assert.ok(rendered.markdown.includes("the full claim is in this volume's reference record"), "the file says the claim was truncated and where the whole of it is");

  const shape = artifactShapeFindings(rendered.markdown, { file: "character-voice.md", volume: "01", step: "rebuild" });
  assert.deepStrictEqual(shape.map((item) => item.kind), [], `the rebuilt file fails its own shape check: ${JSON.stringify(shape.map((item) => item.kind))}`);

  const full = store.db.prepare("SELECT body FROM facts WHERE body LIKE 'Her register is flat%'").get();
  assert.ok(full.body.length > MAX_REBUILD_BULLET_CHARS, "the record still holds the whole claim");

  store.close();
  console.log("  a bullet too long to read is capped, named, and kept whole in the record");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A rebuilt reference is labelled as rebuilt — in the record, in the report, and in the file.
 * @returns {void}
 */
function scenarioARebuiltReferenceIsReportedAsRebuilt() {
  const series = fixtureStoreSeries("rebuild-provenance");
  withRoster(series);
  const { store, result } = rebuildFixture(series);
  const rendered = renderRebuiltVoice(store);

  const marker = documentRebuilt(store, DOCUMENT_VOICE, 1);
  assert.ok(marker, "the record carries a rebuild marker");
  assert.strictEqual(marker.filed, result.rebuild.filedCount, "with the counts the rebuild reported");
  assert.strictEqual(rebuildProvenance(store).characters, result.rebuild.characters, "and the read half agrees");

  const audit = auditVolumeRecord(store, { title: "Character-voice reference", file: "character-voice.md", markdown: rendered.markdown });
  const provenance = audit.findings.find((item) => item.kind === "reference-document-rebuilt-from-extraction");
  assert.ok(provenance, `the audit does not say how this reference was written: ${JSON.stringify(audit.findings.map((f) => f.kind))}`);
  assert.strictEqual(provenance.severity, "MEDIUM", "provenance is not damage, and it is not silence either");
  assert.ok(audit.markdown.includes("## How this reference was written"), "the report has a section for it");
  assert.ok(rendered.markdown.includes("no author agent wrote this file"), "and the file says it about itself");

  store.close();
  console.log("  a rebuilt reference is distinguishable from an authored one, at MEDIUM");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Planted defect at HIGH: a rebuilt reference that does not cover the cast is still damaged.
 * Rebuilding is not an exemption.
 *
 * The extraction claims are filed first, through their own handle, the way a stage files them — which
 * is what makes this volume 01's real failure rather than a hypothetical one: two independent passes
 * over the same book, the extraction and the reference, disagreeing about the same characters.
 * @returns {void}
 */
function scenarioCoverageStillFiresOnARebuiltReference() {
  const series = fixtureStoreSeries("rebuild-coverage");
  withRoster(series);

  const extractor = openFixture(series, 1, EXTRACTION_SOURCE_STAGE);
  const filed = importVoiceExtraction(extractor, EXTRACTION_01);
  assert.ok(filed.ok, JSON.stringify(filed.refused));
  extractor.close();

  // The reference this rebuild types covers two of them and nothing about the rest.
  const thin = EXTRACTION_01.filter((entry) => entry.character === "如月雨露（ジョーロ）" || entry.character === "俺（主人公）");
  const { store } = rebuildFixture(series, { entries: thin });
  const rendered = renderRebuiltVoice(store);

  const audit = auditVolumeRecord(store, { title: "Character-voice reference", file: "character-voice.md", markdown: rendered.markdown });
  const coverage = audit.findings.find((item) => item.kind === "reference-voice-covers-fewer-characters");
  assert.ok(coverage, `coverage did not fire: ${JSON.stringify(audit.findings.map((f) => f.kind))}`);
  assert.strictEqual(coverage.severity, "HIGH", "the damaged-reference stop is not downgraded for a rebuild");
  assert.ok(coverage.message.includes("三色院菫子"), coverage.message);
  assert.ok(coverage.message.includes("the extraction filed"), `and it says which signal made it a loss: ${coverage.message}`);
  assert.strictEqual(audit.highFindings.length, 1, JSON.stringify(audit.findings.map((f) => f.kind)));

  store.close();
  console.log("  a rebuilt reference that misses the cast is still HIGH");
}

/**
 * The other half, on a rebuilt reference: a character the extraction says nothing about, named in
 * one chapter, is a mention. MEDIUM, named with the missing signal, and the next volume is still
 * built on this record.
 * @returns {void}
 */
function scenarioARebuiltReferenceThatMissesAMentionIsNotAStop() {
  const series = fixtureStoreSeries("rebuild-mention");
  withRoster(series);

  // Nothing from the extraction is filed, and the rebuild types only 如月雨露. 大賀太陽 (two
  // chapters) and 三色院菫子 (one chapter) are in the text and in the roster, and neither signal holds.
  const thin = EXTRACTION_01.filter((entry) => entry.character === "如月雨露（ジョーロ）");
  const { store } = rebuildFixture(series, { entries: thin });
  const rendered = renderRebuiltVoice(store);

  const audit = auditVolumeRecord(store, { title: "Character-voice reference", file: "character-voice.md", markdown: rendered.markdown });
  const mention = audit.findings.find((item) => item.kind === "reference-voice-mention-not-covered");
  assert.ok(mention, `the mention finding did not fire: ${JSON.stringify(audit.findings.map((f) => f.kind))}`);
  assert.strictEqual(mention.severity, "MEDIUM");
  assert.ok(mention.message.includes("三色院菫子") && mention.message.includes("大賀太陽"), mention.message);
  assert.strictEqual(audit.highFindings.length, 0, JSON.stringify(audit.findings.map((f) => `${f.severity} ${f.kind}`)));
  assert.match(audit.markdown, /## Characters the reference does not cover/, "and the report names every one of them");

  sealVolumeRecord(store);
  store.close();

  const carried = copyForwardStore({
    fromVolume: 1,
    toVolume: 2,
    seriesDir: series.dir,
    fromFolder: series.volumes[0].folder,
    toFolder: series.volumes[1].folder,
  });
  assert.ok(carried.ok, carried.refusal ? carried.refusal.because : "a mention does not stop the next volume");

  console.log("  a rebuilt reference that misses a barely-present character is a MEDIUM, and the copy still runs");
}

/**
 * Make a rebuilt reference lose a character it had covered, using only the verb the rebuild itself owns.
 *
 * `deleteOwnFact` is the legal door: these rows were written by this volume's rebuild handle and are
 * unsealed, so the rebuild can take them back. What is being simulated is the failure the guard exists
 * for — a reference that says nothing about somebody the volume's extraction wrote claims about.
 *
 * @param {ReferenceStore} store - Opened with the rebuild stage.
 * @param {string} key - The character.
 * @returns {number} How many rows were removed.
 */
function dropCharacterFromTheRebuiltReference(store, key) {
  const rows = store.db
    .prepare("SELECT id FROM facts WHERE key = ? AND source_stage = ? AND owner_volume = ?")
    .all(key, REBUILD_SOURCE_STAGE, store.volume);
  assert.ok(rows.length > 0, `the rebuilt reference covered ${key} before this scenario took it away`);
  let removed = 0;
  for (const row of rows) {
    const result = store.deleteOwnFact(row.id, "the rebuilt reference lost this character's section");
    assert.ok(result.ok, JSON.stringify(result.refusal));
    assert.strictEqual(result.changed, 1, `a rebuild may delete the row its own handle wrote (changed ${result.changed})`);
    removed += result.changed;
  }
  return removed;
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * **The point of this slice.** A rebuilt reference that lost a character the extraction found, named in
 * only one chapter, is a HIGH loss and the next volume is not built on it.
 *
 * Before the rebuild filed candidate copies, this exact record could not be seen as damaged: the rebuild
 * had consumed the extraction into the document, so the record held one reading of the book and the
 * coverage rule's second signal had nothing to compare against. 三色院菫子 is in 1 of the fixture's 3
 * chapters — below the 3-chapter line — so the chapter signal alone says "mention". Only the extraction's
 * own rows, kept beside the adopted ones, say "loss".
 * @returns {void}
 */
function scenarioARebuiltReferenceThatLostACharacterTheExtractionFiledIsAStop() {
  const series = fixtureStoreSeries("rebuild-candidate-loss");
  withRoster(series);

  // A standalone rebuild: no extraction stage ran first, which is exactly the state
  // `node rebuild-voice.js` produces.
  const { store } = rebuildFixture(series);
  dropCharacterFromTheRebuiltReference(store, "三色院菫子");

  const audit = auditVolumeRecord(store, {
    title: "Character-voice reference",
    file: "character-voice.md",
    markdown: renderRebuiltVoice(store).markdown,
  });
  const coverage = audit.findings.find((item) => item.kind === "reference-voice-covers-fewer-characters");
  assert.ok(coverage, `the loss was not reported as a loss: ${JSON.stringify(audit.findings.map((f) => `${f.severity} ${f.kind}`))}`);
  assert.strictEqual(coverage.severity, "HIGH");

  const row = audit.coverage.rows.find((item) => item.key === "三色院菫子");
  assert.ok(row, JSON.stringify(audit.coverage.rows.map((r) => r.key)));
  assert.ok(row.chapters < COVERAGE_SIGNIFICANCE_CHAPTERS, `she is below the chapter line (${row.chapters})`);
  assert.ok(row.extractionClaims >= 1, `and the extraction's reading of her is still in the record: ${row.extractionClaims}`);
  assert.match(coverage.message, /三色院菫子 — the extraction filed \d+ claim\(s\) about them/);

  assert.ok(
    unadoptedVoiceClaims(store).some((claim) => claim.key === "三色院菫子"),
    "and the adoption query sees the same gap, which is what 'the query became useless' would have denied"
  );

  sealVolumeRecord(store);
  store.close();

  const carried = copyForwardStore({
    fromVolume: 1,
    toVolume: 2,
    seriesDir: series.dir,
    fromFolder: series.volumes[0].folder,
    toFolder: series.volumes[1].folder,
  });
  assert.strictEqual(carried.ok, false, "a rebuilt reference that lost a character the extraction found does not become the next volume's starting point");
  assert.strictEqual(carried.refusal.rule, "reference-source-fails-integrity");

  console.log("  a rebuilt reference that lost a 1-chapter character the extraction filed is HIGH, and the copy refuses");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The same record without the candidate copies, which is what a rebuilt record looked like before this
 * change. Same fixture, same loss, different answer — the difference is the second reading, not the rule.
 * @returns {void}
 */
function scenarioARebuiltRecordWithoutItsCandidatesCannotSeeThatLoss() {
  const series = fixtureStoreSeries("rebuild-no-candidate-loss");
  withRoster(series);
  const { store } = rebuildFixture(series, { candidates: false });
  dropCharacterFromTheRebuiltReference(store, "三色院菫子");

  const audit = auditVolumeRecord(store, {
    title: "Character-voice reference",
    file: "character-voice.md",
    markdown: renderRebuiltVoice(store).markdown,
  });
  assert.ok(
    !audit.findings.some((item) => item.kind === "reference-voice-covers-fewer-characters"),
    "with one reading of the book there is nothing to disagree with, so the loss is not a stop"
  );
  const mention = audit.findings.find((item) => item.kind === "reference-voice-mention-not-covered");
  assert.ok(mention, JSON.stringify(audit.findings.map((f) => f.kind)));
  assert.ok(mention.message.includes("三色院菫子"), "she is still named — a softened guard that is silent is worse than a strict one");

  sealVolumeRecord(store);
  store.close();
  const carried = copyForwardStore({
    fromVolume: 1,
    toVolume: 2,
    seriesDir: series.dir,
    fromFolder: series.volumes[0].folder,
    toFolder: series.volumes[1].folder,
  });
  assert.ok(carried.ok, carried.refusal ? carried.refusal.because : "and the copy runs, which is the hole");

  console.log("  the same loss in a record with no candidate copies is only a MEDIUM — that is what the candidates bought");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The candidate handle is checked, not trusted.
 *
 * A row's kind comes from the scope its handle was opened with, so a rebuild cannot file a candidate
 * through its own handle. Handing `rebuildVoiceFromExtraction` a handle scoped to something else is a
 * wiring mistake, and the answer is a refusal that names the door — not a quiet "no candidates then",
 * which is how a record ends up missing its second reading for a whole series.
 * @returns {void}
 */
function scenarioARebuildRefusesACandidateHandleOfAnotherStage() {
  const series = fixtureStoreSeries("rebuild-candidate-scope");
  withRoster(series);
  const store = openFixture(series, 1, REBUILD_SOURCE_STAGE);
  const wrongStage = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  try {
    const result = rebuildVoiceFromExtraction(store, EXTRACTION_01, { candidateStore: wrongStage });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.refusal.rule, "rebuild-candidates-need-the-extraction-scope");
    assert.match(result.refusal.because, /not "extract" on volume 1/);
    assert.strictEqual(result.filedCount, 0, "and nothing was filed: the refusal happens before the first claim is evaluated");
    assert.strictEqual(
      store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage IN (?, ?)").get(REBUILD_SOURCE_STAGE, EXTRACTION_SOURCE_STAGE).n,
      0,
      "and no row of either kind was written"
    );
  } finally {
    wrongStage.close();
    store.close();
  }

  console.log("  a candidate handle opened as the wrong stage is a refusal, not a silent omission");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * What the candidate copies are **not**: a place for a claim the evidence rule refused, and a way to make
 * the adoption query report something that is not there.
 * @returns {void}
 */
function scenarioRefusedClaimsAreNotCandidatesAndAnEmptyAdoptionQueryIsTheTrueAnswer() {
  const series = fixtureStoreSeries("rebuild-candidate-refusals");
  withRoster(series);
  const { store, result } = rebuildFixture(series, { entries: [...EXTRACTION_01, EXTRACTION_01_UNVERIFIABLE] });

  assert.ok(result.rebuild.refused.some((row) => row.character === "存在しない人物"), "the uncitable claim is refused by name");
  assert.strictEqual(
    store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ? AND key = ?").get(EXTRACTION_SOURCE_STAGE, "存在しない人物").n,
    0,
    "and it is not filed as a candidate either — a claim with no citation is not evidence in either door"
  );
  assert.strictEqual(store.db.prepare("SELECT COUNT(*) AS n FROM cast WHERE key = ?").get("存在しない人物").n, 0, "and it does not register the character");
  assert.strictEqual(result.rebuild.candidates.refused.length, 0, "no candidate copy failed for a different reason");

  const unadopted = unadoptedVoiceClaims(store);
  assert.deepStrictEqual(unadopted, [], "a rebuild that adopted every claim it could cite has nothing unadopted, and the query says so because it checked, not because it had nothing to check");

  const audit = auditVolumeRecord(store, {
    title: "Character-voice reference",
    file: "character-voice.md",
    markdown: renderRebuiltVoice(store).markdown,
    refused: result.rebuild.refused,
  });
  assert.match(audit.markdown, /存在しない人物/, "and the refused claim is named in the report, so an empty adoption query does not hide it");

  store.close();
  console.log("  refused claims are not candidates, and 'nothing unadopted' is a measured answer");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run the whole rebuild through the library door, with the publishing question asked the way the
 * command asks it.
 *
 * @param {ReturnType<typeof fixtureStoreSeries>} series
 * @param {{volume?: number, entries?: Array<Object>, aliases?: Array<{alias: string, key: string, reason: string}>, apply?: boolean, moveAside?: boolean}} [opts]
 * @returns {ReturnType<typeof rebuildVoiceVolume>}
 */
function rebuildFixtureVolume(series, { volume = 1, entries = EXTRACTION_01, aliases = [], apply = false, moveAside = false } = {}) {
  const entry = series.volumes[volume - 1];
  return rebuildVoiceVolume({
    volume,
    folder: entry.folder,
    seriesDir: series.dir,
    entries,
    aliases,
    apply,
    moveAside,
  });
}

/**
 * Count a record's rows by kind, and whether they are sealed.
 *
 * @param {ReferenceStore} store
 * @param {number} [ownerVolume] - Whose rows to count. Defaults to the volume this handle is scoped to,
 *   which is not the same as everything the record holds: a carried row keeps the volume that wrote it.
 * @returns {Object<string, number>}
 */
function rowsByStage(store, ownerVolume = store.volume) {
  const out = {};
  const rows = ownerVolume === null
    ? store.db.prepare("SELECT source_stage, sealed, COUNT(*) AS n FROM facts GROUP BY source_stage, sealed").all()
    : store.db.prepare("SELECT source_stage, sealed, COUNT(*) AS n FROM facts WHERE owner_volume = ? GROUP BY source_stage, sealed").all(ownerVolume);
  for (const row of rows) {
    out[`${row.source_stage}${row.sealed ? ":sealed" : ":open"}`] = row.n;
  }
  return out;
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Publishing seals the volume; rehearsing does not, and both say so in the report.
 *
 * This is the gap that stopped volume 2 from starting at all: `rebuild-voice` built a record and never
 * published it, and a record nobody published is a draft the next volume may not build on.
 * @returns {void}
 */
function scenarioAPublishedRebuildSealsItsVolumeAndARehearsalDoesNot() {
  const rehearsal = fixtureStoreSeries("rebuild-rehearsal-unsealed");
  withRoster(rehearsal);
  const dry = rebuildFixtureVolume(rehearsal);
  assert.ok(dry.ok, JSON.stringify(dry.refusal));
  assert.strictEqual(dry.published, null, "a rehearsal publishes nothing");
  assert.ok(!fs.existsSync(path.join(rehearsal.volumes[0].dir, "character-voice.md")), "and it writes no artifact into the volume folder");
  assert.match(dry.audit.markdown, /## This volume's record is not sealed/, "and the report says which happened");

  const dryReader = openFixture(rehearsal, 1, DOCUMENT_SOURCE_STAGE);
  assert.strictEqual(isVolumeSealed(dryReader, 1), false, "so it seals nothing");
  dryReader.close();

  const published = fixtureStoreSeries("rebuild-published-sealed");
  withRoster(published);
  const run = rebuildFixtureVolume(published, { apply: true });
  assert.ok(run.ok, JSON.stringify(run.refusal));
  assert.ok(run.published && run.published.ok, "the published run seals");
  assert.strictEqual(run.published.moved, null, "with nothing to move aside, nothing was moved");

  const artifact = path.join(published.volumes[0].dir, "character-voice.md");
  assert.ok(fs.existsSync(artifact), "the reference is in the volume's own folder");
  assert.strictEqual(fs.readFileSync(artifact, "utf8"), run.rendered.markdown, "and the file on disk is byte-for-byte what the record renders — the seal was earned by that, not by the run finishing");

  assert.match(run.audit.markdown, /## This volume's record is sealed/, "the report records the seal");
  assert.match(run.audit.markdown, /is this volume's record sealed \(published, immutable\) \| \*\*yes\*\*/, "and the checked table answers it");
  assert.ok(run.published.sealed.snapshot > 0, "and the snapshot of what this volume published was taken");

  const reader = openFixture(published, 1, DOCUMENT_SOURCE_STAGE);
  assert.strictEqual(isVolumeSealed(reader, 1), true, "and the volume's record is now immutable");
  reader.close();

  console.log("  publishing a rebuilt reference seals its volume; rehearsing one does not, and the report says which happened");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The gate the account owner hit: volume 2 cannot start on an unsealed volume 1, and publishing is
 * what opens it.
 * @returns {void}
 */
function scenarioTheCopyForwardGateOpensWhenTheRebuildPublishes() {
  const blocked = fixtureStoreSeries("rebuild-gate-blocked");
  withRoster(blocked);
  const dry = rebuildFixtureVolume(blocked);
  assert.ok(dry.ok, JSON.stringify(dry.refusal));

  let carried = copyForwardStore({
    fromVolume: 1,
    toVolume: 2,
    seriesDir: blocked.dir,
    fromFolder: blocked.volumes[0].folder,
    toFolder: blocked.volumes[1].folder,
  });
  assert.strictEqual(carried.ok, false, "a rebuilt record that was never published does not become the next volume's starting point");
  assert.strictEqual(carried.refusal.rule, "reference-source-fails-integrity");
  assert.ok(
    carried.refusal.because.includes("reference-volume-unsealed"),
    carried.refusal.because
  );

  const open = fixtureStoreSeries("rebuild-gate-open");
  withRoster(open);
  const run = rebuildFixtureVolume(open, { apply: true });
  assert.ok(run.ok, JSON.stringify(run.refusal));

  const source = openFixture(open, 1, DOCUMENT_SOURCE_STAGE);
  const sourceRows = rowsByStage(source);
  source.close();

  carried = copyForwardStore({
    fromVolume: 1,
    toVolume: 2,
    seriesDir: open.dir,
    fromFolder: open.volumes[0].folder,
    toFolder: open.volumes[1].folder,
  });
  assert.ok(carried.ok, JSON.stringify(carried.refusal));

  const next = openFixture(open, 2, DOCUMENT_SOURCE_STAGE);
  const carriedRows = rowsByStage(next, null);
  assert.ok(isVolumeSealed(next, 1), "the carried rows arrive sealed: volume 1 is history, not a draft volume 2 can edit");
  assert.strictEqual(
    carriedRows["rebuild:sealed"] || 0,
    sourceRows["rebuild:sealed"] || 0,
    `the rebuilt rows travelled: ${JSON.stringify({ source: sourceRows, carried: carriedRows })}`
  );
  assert.ok((carriedRows["extract:sealed"] || 0) > 0, "and so did their candidate copies");
  assert.ok((carriedRows["import:sealed"] || 0) > 0, "and the glossary half travelled too");
  assert.strictEqual(
    Object.values(carriedRows).reduce((sum, n) => sum + n, 0),
    Object.values(sourceRows).reduce((sum, n) => sum + n, 0),
    "every row in volume 1's record travelled into volume 2's, and none of them arrived editable"
  );
  next.close();

  console.log("  the copy-forward gate closes on an unpublished rebuild and opens on a published one");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A damaged rebuilt reference is written and **not** sealed.
 *
 * Sealing is what lets the next volume build on a record, so a record the audit calls damaged does not
 * become immutable just because the rebuild finished. The file is still written — the run is stopped at
 * the copy-forward, which is this pipeline's shape for a bad volume — but the draft stays a draft.
 * @returns {void}
 */
function scenarioARebuildRefusesToSealARecordTheAuditCallsDamaged() {
  const series = fixtureStoreSeries("rebuild-damaged-no-seal");
  withRoster(series);

  // A thin extraction file: the rebuilt reference says nothing about 三色院菫子, who is in this volume's
  // text and whose claims the record's extraction half does carry.
  const thin = EXTRACTION_01.filter((entry) => entry.character !== "三色院菫子（パンジー）");
  const opened = openFixture(series, 1, EXTRACTION_SOURCE_STAGE);
  const filed = importVoiceExtraction(opened, EXTRACTION_01);
  assert.ok(filed.importedCount > 0, JSON.stringify(filed.refused));
  opened.close();

  const run = rebuildFixtureVolume(series, { entries: thin, apply: true });
  assert.strictEqual(run.ok, false, "the publish is refused");
  assert.strictEqual(run.refusal.rule, "rebuild-will-not-seal-a-damaged-record", JSON.stringify(run.refusal));
  assert.ok(run.published && run.published.written, "the file was still written — the stop is at the copy-forward, not a silent rollback");
  assert.match(run.audit.markdown, /## This volume's record is not sealed/, "and the report says so, with the reason");

  const reader = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  assert.strictEqual(isVolumeSealed(reader, 1), false, "and the record stays a draft");
  reader.close();

  const carried = copyForwardStore({
    fromVolume: 1,
    toVolume: 2,
    seriesDir: series.dir,
    fromFolder: series.volumes[0].folder,
    toFolder: series.volumes[1].folder,
  });
  assert.strictEqual(carried.ok, false, "and volume 2 does not start on it");

  console.log("  a rebuilt reference the audit calls damaged is written but never sealed");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Sealing is per-volume, and that is the right grain: publishing volume 1 publishes its glossary too.
 *
 * The store has no per-stage seal, and it should not: what volume 2 inherits is volume 1's *record*,
 * and a half-published volume is the state gotcha 97 exists to describe. The asymmetry the account
 * owner pointed at — accepted glossary rows versus a rebuilt reference nobody has read — is recorded
 * where it belongs, as provenance, not as a second kind of seal.
 * @returns {void}
 */
function scenarioSealingPublishesTheWholeVolumeNotJustTheRebuiltHalf() {
  const series = fixtureStoreSeries("rebuild-seals-the-volume");
  withRoster(series);
  const run = rebuildFixtureVolume(series, { apply: true });
  assert.ok(run.ok, JSON.stringify(run.refusal));

  const reader = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  const open = reader.db
    .prepare("SELECT source_stage, COUNT(*) AS n FROM facts WHERE owner_volume = 1 AND sealed = 0 GROUP BY source_stage")
    .all();
  assert.deepStrictEqual(open, [], `rows still open after sealing: ${JSON.stringify(open)}`);

  const byStage = reader.db
    .prepare("SELECT source_stage, COUNT(*) AS n FROM facts WHERE owner_volume = 1 GROUP BY source_stage ORDER BY source_stage")
    .all();
  assert.ok(byStage.some((row) => row.source_stage === DOCUMENT_SOURCE_STAGE), "the glossary half is in the volume's record");
  assert.ok(byStage.some((row) => row.source_stage === REBUILD_SOURCE_STAGE), "so is the rebuilt reference");
  assert.ok(factsAtVolume(reader, 1).length > 0, "and the snapshot says what this volume published");

  reader.close();
  console.log("  sealing a volume seals the whole volume — the rebuilt reference and the glossary it carries");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Re-running a rebuild over its own output seals the volume instead of locking it out.
 *
 * Volume 1 is the real case: it was published by a rebuild that predated the seal, so its folder holds
 * `character-voice.md` **and** `character-voice.md.rejected`, and its record is a draft. The obvious
 * repair — run the rebuild again with `--apply --move-aside` — hits `rejected-artifact-already-exists`,
 * because a second rejection would destroy the evidence of the first. That would leave the volume
 * permanently unpublishable. The way out is not a new flag: a rebuild that renders exactly the file
 * already there is not overwriting anything, so it has nothing to move aside and needs no new `.rejected`.
 * @returns {void}
 */
function scenarioRePublishingARebuildsOwnOutputSealsItWithoutStackingRejectedFiles() {
  const series = fixtureStoreSeries("rebuild-republish-seals");
  withRoster(series);
  const volumeDir = series.volumes[0].dir;

  // The pre-fix state: the record exists, the artifact was written into the volume folder, a damaged
  // file was moved aside, and nothing was ever sealed.
  const first = rebuildFixtureVolume(series);
  assert.ok(first.ok, JSON.stringify(first.refusal));
  fs.writeFileSync(path.join(volumeDir, "character-voice.md"), first.rendered.markdown, "utf8");
  fs.writeFileSync(path.join(volumeDir, "character-voice.md.rejected"), "the destroyed reference, kept as evidence\n", "utf8");

  const before = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  assert.strictEqual(isVolumeSealed(before, 1), false, "the record is a draft");
  before.close();

  const again = rebuildFixtureVolume(series, { apply: true, moveAside: true });
  assert.ok(again.ok, JSON.stringify(again.refusal));
  assert.strictEqual(again.published.unchanged, true, "the file on disk is exactly what the record renders, so nothing was replaced");
  assert.strictEqual(again.published.moved, null, "and no second `.rejected` was created on top of the first");
  assert.strictEqual(
    fs.readFileSync(path.join(volumeDir, "character-voice.md.rejected"), "utf8"),
    "the destroyed reference, kept as evidence\n",
    "the evidence of the first rejection is untouched"
  );

  const after = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  assert.strictEqual(isVolumeSealed(after, 1), true, "and the volume is now sealed, which is what the next volume was waiting on");
  after.close();

  // The report describes the record, not the run. A second rebuild files nothing, and a report that
  // quoted the run would say this reference adopted zero claims across zero characters.
  const adopted = /(\d+) claim\(s\) adopted about (\d+) character\(s\)/.exec(again.audit.markdown);
  assert.ok(adopted, again.audit.markdown.split("\n").slice(0, 14).join("\n"));
  assert.strictEqual(Number(adopted[1]), again.rebuild.adoptedClaims, "the report counts what the record holds");
  assert.ok(Number(adopted[1]) > 0, "and that is not zero just because this run added nothing");
  assert.ok(Number(adopted[2]) > 0, "and it names the characters the reference covers");

  console.log("  re-running a rebuild over its own output seals the volume and leaves the earlier rejection alone");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A recorded alias beats a primary-name collision — including on the second run, when the collision
 * has become a roster entry.
 *
 * This is volume 01's real defect, found while rehearsing the seal. The extraction names the same
 * person 俺（主人公） (which the operator linked to 如月雨露 with a reason) and 俺（如月雨露・第二章終盤）
 * (which nothing carries, so it becomes its own entry keyed 俺). On the first run the alias decided the
 * 48 claims. On the second run the entry keyed 俺 already existed, the "primary name is a key" rule fired
 * first, and the same 48 claims landed on 俺 — same file, same rules, a different record. A rebuild that
 * re-files a character's claims onto a different character is not idempotent, and it changes which
 * character the coverage guard thinks is covered.
 * @returns {void}
 */
function scenarioARecordedAliasOutlivesTheRunThatCreatedTheRosterEntry() {
  const series = fixtureStoreSeries("rebuild-alias-beats-collision");
  withRoster(series);

  // The second spelling: nothing in the roster carries it, so it becomes its own entry keyed 俺.
  const secondPersonality = {
    type: "voice",
    character: "俺（第二章の別人格）",
    quirkType: "pronoun",
    description: "A second register the same narrator uses late in the volume.",
    examples: ["気にすんな！"],
  };
  const entries = [...EXTRACTION_01, secondPersonality];
  const aliases = [
    {
      key: "如月雨露",
      alias: "俺（主人公）",
      reason: "the glossary's own row says the narrator switches between 僕 and 俺",
    },
  ];

  const first = rebuildFixtureVolume(series, { entries, aliases });
  assert.ok(first.ok, JSON.stringify(first.refusal));

  const reader = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  const firstCounts = new Map(
    reader.db
      .prepare("SELECT key, COUNT(*) AS n FROM facts WHERE source_stage = ? AND key IS NOT NULL GROUP BY key")
      .all(REBUILD_SOURCE_STAGE)
      .map((row) => [row.key, row.n])
  );
  assert.ok((firstCounts.get("如月雨露") || 0) > 0, `the alias carried its claims: ${JSON.stringify([...firstCounts])}`);
  assert.ok(firstCounts.has("俺"), "and the unlinked spelling became its own roster entry");

  const resolved = resolveExtractionName(reader, "俺（主人公）");
  assert.strictEqual(resolved.key, "如月雨露", JSON.stringify(resolved));
  assert.match(resolved.how, /alias recorded on 如月雨露/, `the recorded alias has to beat the collision: ${resolved.how}`);
  reader.close();

  // Run it again over the record the first run built. The roster now holds 俺, and that must not move
  // anybody's claims.
  const again = rebuildFixtureVolume(series, { entries, aliases });
  assert.ok(again.ok, JSON.stringify(again.refusal));

  const second = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  const secondCounts = new Map(
    second.db
      .prepare("SELECT key, COUNT(*) AS n FROM facts WHERE source_stage = ? AND key IS NOT NULL GROUP BY key")
      .all(REBUILD_SOURCE_STAGE)
      .map((row) => [row.key, row.n])
  );
  second.close();

  assert.deepStrictEqual(
    [...secondCounts].sort(),
    [...firstCounts].sort(),
    `the second run moved a character's claims: first ${JSON.stringify([...firstCounts].sort())}, second ${JSON.stringify([...secondCounts].sort())}`
  );
  assert.strictEqual(again.rebuild.filedCount, 0, `and it filed nothing a second time: ${again.rebuild.filedCount}`);

  console.log("  a recorded alias beats a primary-name collision, on the second run too");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A volume whose voice record is already published cannot be rebuilt over: a rebuild is not a challenge.
 * @returns {void}
 */
function scenarioASealedVoiceRecordRefusesARebuild() {
  const series = fixtureStoreSeries("rebuild-sealed");
  const store = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  importVolumeArtifacts(store, { glossaryMarkdown: GLOSSARY_01, voiceMarkdown: VOICE_01 });
  sealVolumeRecord(store);
  store.close();

  const attempt = openReferenceStore({ volume: 1, folder: series.volumes[0].folder, seriesDir: series.dir, stage: REBUILD_SOURCE_STAGE });
  attempt.registerChaptersFromSource();
  const result = rebuildVoiceFromExtraction(attempt, EXTRACTION_01);
  assert.strictEqual(result.ok, false, "refused");
  assert.strictEqual(result.refusal.rule, "rebuild-refuses-a-sealed-voice-record", result.refusal && result.refusal.rule);
  assert.ok(result.refusal.useInstead.some((entry) => entry.includes("challenge_fact")), JSON.stringify(result.refusal.useInstead));

  const stillThere = attempt.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ? AND sealed = 1").get(DOCUMENT_SOURCE_STAGE).n;
  assert.ok(stillThere > 0, "the published rows are untouched");
  attempt.close();
  console.log("  a sealed voice record refuses to be rebuilt over");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A rebuild replaces this volume's own mirror of the reference it is rebuilding, and nothing else —
 * and it does it through the verb that is allowed to, not by reaching across stages.
 * @returns {void}
 */
function scenarioARebuildClearsOnlyItsOwnMirror() {
  const series = fixtureStoreSeries("rebuild-mirror");
  const writer = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  const imported = importVolumeArtifacts(writer, { glossaryMarkdown: GLOSSARY_01, voiceMarkdown: VOICE_01 });
  const glossaryRows = writer.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE aspect = 'term_usage'").get().n;
  const voiceRows = imported.voice.importedCount;
  writer.close();

  // Asked directly, from a rebuild handle: refused, because those rows belong to the import stage.
  const direct = openReferenceStore({ volume: 1, folder: series.volumes[0].folder, seriesDir: series.dir, stage: REBUILD_SOURCE_STAGE });
  direct.registerChaptersFromSource();
  const refused = rebuildVoiceFromExtraction(direct, EXTRACTION_01);
  assert.strictEqual(refused.ok, false, "refused");
  assert.strictEqual(refused.refusal.rule, "rebuild-needs-its-mirror-cleared-first", refused.refusal && refused.refusal.rule);
  assert.ok(refused.refusal.useInstead.some((entry) => entry.includes("resetDocumentMirror")), JSON.stringify(refused.refusal.useInstead));
  const untouched = direct.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ? AND sealed = 0 AND aspect != 'term_usage'")
    .get(DOCUMENT_SOURCE_STAGE).n;
  assert.strictEqual(untouched, voiceRows, "and nothing was deleted on the way to the refusal");
  direct.close();

  // Through the flow, which clears the mirror with the handle that owns those rows.
  const result = rebuildVoiceVolume({
    volume: 1,
    folder: series.volumes[0].folder,
    seriesDir: series.dir,
    entries: EXTRACTION_01,
  });
  assert.ok(result.ok, JSON.stringify(result.refusal));
  assert.strictEqual(result.cleared.deleted, voiceRows, `cleared ${result.cleared.deleted} of ${voiceRows} mirror rows`);

  const store = openReferenceStore({ volume: 1, folder: series.volumes[0].folder, seriesDir: series.dir, stage: DOCUMENT_SOURCE_STAGE });
  assert.strictEqual(documentRebuilt(store, DOCUMENT_VOICE, 1).mirrorRowsRemoved, voiceRows, "and the record says so");
  const glossaryNow = store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE aspect = 'term_usage'").get().n;
  assert.strictEqual(glossaryNow, glossaryRows, "the glossary's rows are not the reference being rebuilt");
  const leftover = store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ? AND sealed = 0 AND aspect != 'term_usage'")
    .get(DOCUMENT_SOURCE_STAGE).n;
  assert.strictEqual(leftover, 0, `${leftover} mirror rows survived`);
  store.close();

  console.log("  a rebuild clears the mirror of the file it replaces, and only that");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The damaged artifact is moved aside, kept, and never silently overwritten.
 * @returns {void}
 */
function scenarioTheDamagedFileIsMovedAsideAndKept() {
  const series = fixtureStoreSeries("rebuild-aside");
  withRoster(series);
  const volumeDir = series.volumes[0].dir;
  fs.writeFileSync(path.join(volumeDir, "character-voice.md"), VOICE_01, "utf8");

  const { store } = rebuildFixture(series);
  const rendered = renderRebuiltVoice(store);

  const refused = writeRebuiltVoiceFile(store, volumeDir, rendered, { moveAside: false });
  assert.strictEqual(refused.ok, false, "writing over an existing artifact without permission is refused");
  assert.strictEqual(refused.refusal.rule, "rebuild-will-not-overwrite-an-artifact", refused.refusal && refused.refusal.rule);
  assert.strictEqual(fs.readFileSync(path.join(volumeDir, "character-voice.md"), "utf8"), VOICE_01, "and the existing file is untouched");

  const written = writeRebuiltVoiceFile(store, volumeDir, rendered, { moveAside: true });
  assert.ok(written.ok, JSON.stringify(written.refusal));
  assert.ok(fs.existsSync(written.moved), "the file it replaced is kept as evidence");
  assert.strictEqual(fs.readFileSync(written.moved, "utf8"), VOICE_01, "kept whole");
  assert.ok(fs.readFileSync(written.written, "utf8").includes("no author agent wrote this file"), "and the new one replaced it");

  // Re-running the rebuild over its own output is not a second rejection: the file on disk is exactly
  // what the record renders, so nothing is being destroyed and nothing has to be moved aside.
  const sameAgain = writeRebuiltVoiceFile(store, volumeDir, rendered, { moveAside: true });
  assert.ok(sameAgain.ok, JSON.stringify(sameAgain.refusal));
  assert.strictEqual(sameAgain.unchanged, true, "a rebuild that renders the file already there is not overwriting it");
  assert.strictEqual(sameAgain.moved, null, "and no second `.rejected` is stacked on the first");

  // A file that is **not** what the record renders is still protected — and the second rejection does not
  // spend the first one. Volume 01's folder already holds the original damaged reference, and redoing
  // volume 01 has to set aside its current file without touching that.
  fs.writeFileSync(path.join(volumeDir, "character-voice.md"), "somebody edited this reference by hand\n", "utf8");
  const second = writeRebuiltVoiceFile(store, volumeDir, rendered, { moveAside: true });
  assert.ok(second.ok, JSON.stringify(second.refusal));
  assert.strictEqual(second.asideSlot, 2, "the second rejection lands in the second slot");
  assert.deepStrictEqual(second.keptAside, ["character-voice.md.rejected"], "and it names the rejection it kept");
  assert.strictEqual(path.basename(second.moved), "character-voice.md.rejected.2");
  assert.strictEqual(
    fs.readFileSync(path.join(volumeDir, "character-voice.md.rejected"), "utf8"),
    VOICE_01,
    "the first rejection's evidence is byte-for-byte what it was"
  );
  assert.strictEqual(
    fs.readFileSync(path.join(volumeDir, "character-voice.md.rejected.2"), "utf8"),
    "somebody edited this reference by hand\n",
    "the second rejection's evidence is kept beside it"
  );

  const aside = moveArtifactAside(volumeDir, "character-voice.md");
  assert.strictEqual(aside.ok, true, "and the move door no longer refuses a volume out of its own redo");
  assert.strictEqual(aside.slot, 3, JSON.stringify(aside));
  assert.deepStrictEqual(aside.keptAside.map((p) => path.basename(p)), ["character-voice.md.rejected", "character-voice.md.rejected.2"]);

  // The quarantine family is written with an ignore rule in the folder that holds it, because nothing in
  // the series repository ignores these files and the rule has to travel with the books.
  const ignore = fs.readFileSync(path.join(volumeDir, ".gitignore"), "utf8");
  assert.ok(ignore.includes("*.rejected*"), "the numbered family is covered by one pattern");
  assert.ok(
    !ignore.split("\n").some((line) => line.trim() === "series.db" || line.startsWith("series.db*")),
    "and the reference record is deliberately NOT ignored — it is the run's memory"
  );

  store.close();
  console.log("  the reference being replaced is moved aside, kept, and never overwritten silently; rejects stack");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The rebuilt file re-imports into the aspects it was filed as — the round trip closes.
 * @returns {void}
 */
function scenarioTheRebuiltFileRoundTrips() {
  const series = fixtureStoreSeries("rebuild-round-trip");
  withRoster(series);
  const { store } = rebuildFixture(series);
  const rendered = renderRebuiltVoice(store);
  const before = store.db
    .prepare("SELECT key, aspect, label, body FROM facts WHERE source_stage = ? AND key IS NOT NULL ORDER BY ord")
    .all(REBUILD_SOURCE_STAGE);

  const reader = openReferenceStore({ volume: 1, folder: series.volumes[0].folder, seriesDir: series.dir, stage: DOCUMENT_SOURCE_STAGE });
  reader.registerChaptersFromSource();
  const imported = importVoice(reader, rendered.markdown);
  assert.strictEqual(imported.refused.length, 0, `the rebuilt file could not be re-imported: ${JSON.stringify(imported.refused.map((r) => r.because))}`);

  const after = reader.db
    .prepare("SELECT key, aspect, label, body FROM facts WHERE source_stage = ? AND key IS NOT NULL ORDER BY ord")
    .all(DOCUMENT_SOURCE_STAGE);
  assert.strictEqual(after.length, before.length, `${before.length} claims became ${after.length}`);
  for (const row of after) {
    assert.notStrictEqual(row.aspect, "unclassified", `the label ${row.label} came back as the fallback`);
  }
  const pov = after.filter((row) => row.aspect === "pov");
  assert.ok(pov.length > 0, "the Point of view label maps back to the pov aspect");

  reader.close();
  store.close();
  console.log("  the rebuilt file re-imports into the same aspects it was filed as");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The provenance carries forward: volume 2's record still says volume 1 was rebuilt.
 * @returns {void}
 */
function scenarioTheProvenanceCarriesForward() {
  const series = fixtureStoreSeries("rebuild-carried");
  withRoster(series);
  const { store } = rebuildFixture(series);
  sealVolumeRecord(store);
  store.close();

  const copy = copyForwardStore({
    fromVolume: 1,
    toVolume: 2,
    seriesDir: series.dir,
    fromFolder: series.volumes[0].folder,
    toFolder: series.volumes[1].folder,
  });
  assert.ok(copy.ok, JSON.stringify(copy.refusal));

  const next = openFixture(series, 2, DOCUMENT_SOURCE_STAGE);
  const carried = rebuiltDocuments(next, 2);
  assert.strictEqual(carried.length, 1, JSON.stringify(carried));
  assert.strictEqual(carried[0].volume, 1, "it names the volume that was rebuilt, not the volume that carried it");
  assert.strictEqual(
    carried[0].candidatesFiled,
    next.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ? AND owner_volume = 1").get(EXTRACTION_SOURCE_STAGE).n,
    "and the record still says how many candidate copies it carries, because that is what keeps the coverage signal alive in every later volume"
  );
  assert.strictEqual(
    next.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ? AND owner_volume = 1").get(EXTRACTION_SOURCE_STAGE).n,
    next.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source_stage = ? AND owner_volume = 1").get(REBUILD_SOURCE_STAGE).n,
    "the candidate copies travel with the adopted rows — one beside each"
  );

  const audit = next.integrityFindings({ volume: "02" });
  const provenance = audit.findings.find((item) => item.kind === "reference-document-rebuilt-from-extraction");
  assert.ok(provenance, `volume 2's audit does not know volume 1 was rebuilt: ${JSON.stringify(audit.findings.map((f) => f.kind))}`);
  assert.ok(provenance.message.includes("volume 1's"), provenance.message);

  next.close();
  console.log("  a rebuilt volume is still labelled as rebuilt in every later volume's record");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The whole flow, end to end, with a real endpoint listening and nothing reaching it.
 *
 * The claim this suite is really making is that this path is deterministic: extraction JSON in,
 * markdown out. Pointing the environment at the scripted server and then asserting the server heard
 * nothing is the only way to assert that without reading the source for promises.
 *
 * @returns {Promise<void>}
 */
async function scenarioTheWholePathMakesNoModelCall() {
  const series = fixtureStoreSeries("rebuild-no-model");
  withRoster(series);
  const volumeDir = series.volumes[0].dir;

  const backend = await startFakeBackend({ model: "stub" });
  backend.pointEnvAt({ prefixes: ["GLOSSARY", "VOICE"] });
  try {
    const result = rebuildVoiceVolume({
      volume: 1,
      folder: series.volumes[0].folder,
      seriesDir: series.dir,
      entries: EXTRACTION_01,
      aliases: [{ key: "如月雨露", alias: "俺", reason: "the glossary's own row says the narrator switches between 僕 and 俺" }],
    });
    assert.ok(result.ok, JSON.stringify(result.refusal));
    assert.ok(result.rendered.markdown.includes("### 如月雨露"), "it rendered");
    assert.ok(result.audit, "it audited");
    assert.strictEqual(backend.requests.length, 0, `the rebuild made ${backend.requests.length} request(s) to the endpoint`);
    assert.ok(!result.audit.findings.some((item) => item.severity === "HIGH"), JSON.stringify(result.audit.findings.map((f) => `${f.severity} ${f.kind}`)));

    const writer = openReferenceStore({ volume: 1, folder: series.volumes[0].folder, seriesDir: series.dir, stage: REBUILD_SOURCE_STAGE });
    const written = writeRebuiltVoiceFile(writer, volumeDir, result.rendered, { moveAside: true });
    writer.close();
    assert.ok(written.ok, JSON.stringify(written.refusal));
    assert.ok(fs.existsSync(path.join(volumeDir, "series.db")), "and the record it built is in the volume folder, where the next volume reads it");
    assert.strictEqual(backend.requests.length, 0, `writing the artifact made ${backend.requests.length} request(s)`);
  } finally {
    await backend.close();
  }
  console.log("  extraction in, markdown out: the scripted endpoint heard nothing at all");
}

/**
 * A rebuild does not carry the earlier volumes' record, so it refuses rather than rendering a
 * reference that has silently forgotten them.
 * @returns {void}
 */
function scenarioALaterVolumeNeedsItsEarlierRecordFirst() {
  const series = fixtureStoreSeries("rebuild-carried-first");
  withRoster(series, 1);
  const { store } = rebuildFixture(series);
  sealVolumeRecord(store);
  store.close();

  // Volume 2 exists in the plan of record and its own record is empty.
  const empty = rebuildVoiceVolume({
    volume: 2,
    folder: series.volumes[1].folder,
    seriesDir: series.dir,
    entries: [{ type: "voice", character: "如月雨露", quirkType: "pronoun", description: "First person is 僕.", examples: ["如月雨露は「気にすんな！」と言った。"] }],
  });
  assert.strictEqual(empty.ok, false, "refused");
  assert.strictEqual(empty.refusal.rule, "rebuild-record-missing-its-earlier-volumes", empty.refusal && empty.refusal.rule);
  assert.ok(empty.refusal.useInstead.some((entry) => entry.includes("openVolumeRecord")), JSON.stringify(empty.refusal.useInstead));

  // Carry volume 1 forward the way the pipeline does, and the same rebuild is allowed.
  const carried = copyForwardStore({
    fromVolume: 1,
    toVolume: 2,
    seriesDir: series.dir,
    fromFolder: series.volumes[0].folder,
    toFolder: series.volumes[1].folder,
  });
  assert.ok(carried.ok, JSON.stringify(carried.refusal));

  const allowed = rebuildVoiceVolume({
    volume: 2,
    folder: series.volumes[1].folder,
    seriesDir: series.dir,
    entries: [{ type: "voice", character: "如月雨露", quirkType: "pronoun", description: "First person is 僕.", examples: ["如月雨露は「気にすんな！」と言った。"] }],
  });
  assert.ok(allowed.ok, JSON.stringify(allowed.refusal));
  const carriedRows = allowed.audit.counts.facts;
  assert.ok(carriedRows > 1, `the earlier volume's rows are still there: ${carriedRows}`);

  console.log("  rebuilding a later volume into an empty record is refused, not silently truncated");
}

// ─── The POV map ─────────────────────────────────────────────────────────────

/**
 * The claims a character section cannot hold are not lost: they are rendered in the POV map.
 *
 * `renderVoice` drops a POV claim that has no character to file it under and reports how many it
 * dropped. That was honest but it left the claims nowhere — and the acceptance check names
 * `pov-map.md`, so a route that published the reference without the map could not be graded at all.
 * A map is organised by chapter, which is exactly the shape that does not need a person to hang a
 * claim on.
 * @returns {void}
 */
function scenarioThePovMapRendersWhatTheCharacterReferenceCannot() {
  const series = fixtureStoreSeries("povmap-renders-unattached");
  withRoster(series);
  const { store } = rebuildFixture(series);

  const voice = renderRebuiltVoice(store);
  const map = renderPovMap(store);

  assert.strictEqual(map.claims, 2, "the fixture files two adopted POV claims: one about a character, one about a chapter");
  assert.strictEqual(map.attached, 1);
  assert.strictEqual(map.unattached, 1);
  assert.strictEqual(voice.unattached, 1, "the reference reports one POV claim it has no section to put in");
  assert.ok(!voice.markdown.includes("Narration borrows the protagonist's vocabulary"), "and it really is not in the reference");
  assert.ok(map.markdown.includes("Narration borrows the protagonist's vocabulary"), "while the map renders it");
  assert.ok(map.markdown.includes(POV_UNATTACHED_LABEL), "and the unattached one is labelled as what it is, not invented a name");
  assert.ok(!map.markdown.includes("## Characters"), "a POV map is not a character reference: it has no character sections");

  // The candidate rule is the same filter, spelled the same way: extraction-only rows do not render.
  // A separate fixture, because "only candidates" is a fact about the record, not about the handle.
  const candidatesSeries = fixtureStoreSeries("povmap-candidates-only");
  withRoster(candidatesSeries);
  const candidatesOnly = openFixture(candidatesSeries, 1, EXTRACTION_SOURCE_STAGE);
  try {
    importVoiceExtraction(candidatesOnly, EXTRACTION_01);
    const empty = renderPovMap(candidatesOnly);
    assert.strictEqual(empty.claims, 0, "a record whose only POV rows are candidates renders an empty map, not the candidates");
    assert.ok(empty.markdown.includes("0 point-of-view claim"), "and the map says so in its own header rather than looking like a map");
  } finally {
    candidatesOnly.close();
    store.close();
  }

  console.log("  the POV map renders the point-of-view claims the record adopted, including the ones a character section has no room for");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The map is cumulative, in the order the chapters it cites appear.
 *
 * This is a change to the artifact's contract: `character-voice/carry-forward.js` and
 * `character-voice/amend.js` both used to say `pov-map.md` describes only this volume. The claims
 * being carried are sealed rows of the same record the cumulative reference is rendered from, so a
 * per-volume map would drop the point-of-view history the reference keeps.
 * @returns {void}
 */
function scenarioThePovMapCarriesEarlierVolumesForwardInChapterOrder() {
  const series = fixtureStoreSeries("povmap-cumulative");
  withRoster(series);
  const first = rebuildFixtureVolume(series, { apply: true });
  assert.ok(first.ok, JSON.stringify(first.refusal));

  const carried = copyForwardStore({
    fromVolume: 1,
    toVolume: 2,
    seriesDir: series.dir,
    fromFolder: series.volumes[0].folder,
    toFolder: series.volumes[1].folder,
  });
  assert.ok(carried.ok, JSON.stringify(carried.refusal));

  const second = rebuildFixtureVolume(series, {
    volume: 2,
    entries: [
      {
        type: "pov",
        povCategory: "distance",
        assignedCharacter: "如月雨露",
        sectionDescription: "Volume 2 stays inside the protagonist, closer than volume 1 ever got.",
        examples: ["如月雨露は「気にすんな！」と言った。"],
      },
    ],
  });
  assert.ok(second.ok, JSON.stringify(second.refusal));

  const map = second.povRendered;
  assert.ok(map, "the rebuild renders the map in the same breath as the reference");
  assert.strictEqual(map.claims, 3, "two carried from volume 1 plus this volume's own");
  assert.strictEqual(map.carriedClaims, 2);
  assert.strictEqual(map.ownClaims, 1);
  assert.deepStrictEqual(map.volumes, [1, 2], "and the map says which volumes it is carrying");

  const headings = map.markdown.split("\n").filter((line) => line.startsWith("## "));
  assert.deepStrictEqual(
    headings,
    [
      "## Volume 01 · chapter ch0 — プロローグ",
      "## Volume 01 · chapter ch1 — 第一章",
      "## Volume 02 · chapter ch0 — 第二章",
    ],
    "volume 1's chapters come first, in volume 1's own chapter order, then this volume's"
  );
  // The id survives the title. Every evidence citation in this layer names a chapter by id, and a map
  // that replaced `ch0` with a heading would be easier to read and impossible to check against a report.
  assert.ok(
    headings.every((h) => /· chapter \S+ — /.test(h)),
    "each heading still names the chapter id before the title, so the old heading is a prefix of the new one"
  );
  assert.ok(map.chapters.every((c) => c.title), "and the render reports the title it used, not only printed it");

  const lines = map.markdown.split("\n");
  const own = lines.findIndex((line) => line.includes("closer than volume 1 ever got"));
  const carriedLine = lines.findIndex((line) => line.includes("keeps the same narrator"));
  assert.ok(carriedLine < own, "and the bullets are in that order inside the file, not just in the counts");

  const store = openFixture(series, 2, DOCUMENT_SOURCE_STAGE);
  const rows = povClaimsInRecord(store, { volume: 2 });
  store.close();
  assert.strictEqual(rows.length, 3, "the query the renderer uses is the whole cumulative set");
  assert.ok(rows.every((row) => row.established_volume <= 2), "and it never reaches past the volume it was asked for");

  console.log("  the POV map is cumulative: earlier volumes' sealed claims first, in the order their own chapters appear");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * A POV claim written under the other field name keeps its prose instead of degenerating.
 *
 * The extraction prompt asks for `sectionDescription`. Volume 01's real prologue answered with
 * `description` instead, and the POV row builder read only the prompt's spelling: four of the five
 * observations were filed as the body "POV marker ※" and the fifth — no marker, so nothing left — was
 * refused. Volume 1's published map has nine chapter sections for a ten-chapter volume, and the prologue
 * is not one of them. This is the shape that lost it.
 *
 * @returns {void}
 */
function scenarioAPovClaimWrittenWithTheOtherFieldNameKeepsItsProse() {
  const series = fixtureStoreSeries("povmap-field-name");
  withRoster(series);
  const first = rebuildFixtureVolume(series, { apply: true });
  assert.ok(first.ok, JSON.stringify(first.refusal));

  const carried = copyForwardStore({
    fromVolume: 1,
    toVolume: 2,
    seriesDir: series.dir,
    fromFolder: series.volumes[0].folder,
    toFolder: series.volumes[1].folder,
  });
  assert.ok(carried.ok, JSON.stringify(carried.refusal));

  const PROSE = "The prologue is the protagonist's, start to finish, and the girl is only ever seen through him.";
  const second = rebuildFixtureVolume(series, {
    volume: 2,
    entries: [
      {
        type: "pov",
        povCategory: "narrationType",
        assignedCharacter: "如月雨露",
        description: PROSE,
        marker: null,
        examples: ["如月雨露は「気にすんな！」と言った。"],
      },
    ],
  });
  assert.ok(second.ok, JSON.stringify(second.refusal));

  const store = openFixture(series, 2, DOCUMENT_SOURCE_STAGE);
  const rows = povClaimsInRecord(store, { volume: 2 }).filter((row) => row.established_volume === 2);
  store.close();

  assert.strictEqual(rows.length, 1, `the claim was filed, not refused: ${JSON.stringify(second.refused || [])}`);
  assert.strictEqual(rows[0].body, PROSE, "with the prose the model wrote, not a marker standing in for it");
  assert.ok(!/^POV marker /.test(rows[0].body), "and the degenerate fallback body was not used, because there was something to say");

  const map = second.povRendered;
  assert.ok(map.markdown.includes(PROSE), "and it reaches the published map");

  console.log("  a POV claim the model wrote under the other field name keeps its prose and reaches the map");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * Rendering a map for a **sealed** volume files nothing and leaves it sealed.
 *
 * This is the door that makes publishing a map for an already-published volume a read rather than a
 * workaround. The store is opened with `create: false`, so a volume with no record is a refusal
 * instead of a freshly created empty one; the render is a query; the only write is the artifact file.
 * @returns {void}
 */
function scenarioRenderingAMapForASealedRecordFilesNothingAndKeepsItSealed() {
  const series = fixtureStoreSeries("povmap-sealed-record");
  withRoster(series);
  const run = rebuildFixtureVolume(series, { apply: true });
  assert.ok(run.ok, JSON.stringify(run.refusal));

  const before = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  const countsBefore = {
    facts: before.db.prepare("SELECT COUNT(*) n FROM facts").get().n,
    cast: before.db.prepare("SELECT COUNT(*) n FROM cast").get().n,
    chapters: before.db.prepare("SELECT COUNT(*) n FROM chapters").get().n,
    sealed: isVolumeSealed(before, 1),
  };
  before.close();
  assert.strictEqual(countsBefore.sealed, true, "the volume is published, which is the situation this is about");

  const rendered = renderPovMapFromRecord({ volume: 1, folder: series.volumes[0].folder, seriesDir: series.dir });
  assert.ok(rendered.ok, JSON.stringify(rendered.refusal));
  assert.strictEqual(rendered.sealed, true, "and it reports the sealed state instead of changing it");
  assert.strictEqual(rendered.rendered.claims, 2);

  const after = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  assert.strictEqual(isVolumeSealed(after, 1), true, "still sealed");
  assert.strictEqual(after.db.prepare("SELECT COUNT(*) n FROM facts").get().n, countsBefore.facts, "no row added");
  assert.strictEqual(after.db.prepare("SELECT COUNT(*) n FROM cast").get().n, countsBefore.cast, "no roster entry added");
  assert.strictEqual(after.db.prepare("SELECT COUNT(*) n FROM chapters").get().n, countsBefore.chapters, "and no chapter registered: rendering does not read the book");
  after.close();

  // And the other half of `create: false`: a volume with no record is a refusal, not an empty file.
  const empty = renderPovMapFromRecord({ volume: 2, folder: series.volumes[1].folder, seriesDir: series.dir });
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.refusal.rule, "pov-map-needs-a-record");
  assert.ok(!fs.existsSync(path.join(series.volumes[1].dir, "series.db")), "and it did not create one on the way past");

  console.log("  rendering a map for a sealed record adds, changes and deletes no row, and a volume with no record is a refusal");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * An authored POV map is somebody's work, and a rendered one does not silently replace it.
 *
 * Volume 01's map was written by an author agent over 12 hours. A renderer that overwrote it because
 * the operator typed the wrong flag would destroy the more expensive artifact of the two.
 * @returns {void}
 */
function scenarioAnAuthoredPovMapIsNotOverwrittenSilently() {
  const series = fixtureStoreSeries("povmap-authored");
  withRoster(series);
  const { store } = rebuildFixture(series);
  const map = renderPovMap(store);
  const target = path.join(series.volumes[0].dir, POV_MAP_FILE);
  const authored = "# POV Map\n\n_A written by an author agent, with a marker census no renderer writes._\n";
  fs.writeFileSync(target, authored, "utf8");

  const refused = writePovMapFile(series.volumes[0].dir, map, { file: POV_MAP_FILE });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.refusal.rule, "pov-map-will-not-overwrite-an-artifact");
  assert.strictEqual(fs.readFileSync(target, "utf8"), authored, "the authored file is untouched");
  assert.ok(!fs.existsSync(`${target}.rejected`), "and nothing was moved either");

  const moved = writePovMapFile(series.volumes[0].dir, map, { file: POV_MAP_FILE, moveAside: true });
  assert.ok(moved.ok, JSON.stringify(moved.refusal));
  assert.strictEqual(fs.readFileSync(target, "utf8"), map.markdown, "with the operator's say-so the render goes in");
  assert.strictEqual(fs.readFileSync(`${target}.rejected`, "utf8"), authored, "and the authored map is kept as evidence, not deleted");

  const again = writePovMapFile(series.volumes[0].dir, map, { file: POV_MAP_FILE, moveAside: true });
  assert.ok(again.ok, JSON.stringify(again.refusal));
  assert.strictEqual(again.unchanged, true, "re-rendering identical bytes is not a second rejection");
  assert.strictEqual(fs.readdirSync(series.volumes[0].dir).filter((name) => name.startsWith(POV_MAP_FILE)).length, 2, "and it does not stack `.rejected` files");

  store.close();
  console.log("  a rendered map replaces an authored one only when told to, and the authored file survives as .rejected");
}

// ─── Scenario ────────────────────────────────────────────────────────────────

/**
 * The map goes down **before** the seal, and a refusal to write it stops the publish.
 *
 * The acceptance check names `pov-map.md` and the harness throws on a named file that is not there,
 * so a volume published without its map is a volume the stage's own gate cannot run on. Sealing first
 * and failing on the map afterwards would hand the next volume a record built on an ungradeable
 * artifact.
 * @returns {void}
 */
function scenarioAPublishedRebuildWritesTheMapBeforeItSeals() {
  const series = fixtureStoreSeries("povmap-publish-order");
  withRoster(series);
  const run = rebuildFixtureVolume(series, { apply: true });
  assert.ok(run.ok, JSON.stringify(run.refusal));

  const target = path.join(series.volumes[0].dir, POV_MAP_FILE);
  assert.ok(fs.existsSync(target), "publishing a rebuilt reference publishes its map with it");
  assert.strictEqual(fs.readFileSync(target, "utf8"), run.povRendered.markdown, "byte-for-byte the render");

  const reader = openFixture(series, 1, DOCUMENT_SOURCE_STAGE);
  assert.strictEqual(isVolumeSealed(reader, 1), true);
  reader.close();

  // Now put an authored map in front of it and publish again: the refusal must arrive before the seal.
  const blocked = fixtureStoreSeries("povmap-publish-blocked");
  withRoster(blocked);
  fs.writeFileSync(path.join(blocked.volumes[0].dir, POV_MAP_FILE), "# POV Map\n\n_authored_\n", "utf8");
  const refused = rebuildFixtureVolume(blocked, { apply: true });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.published.ok, false);
  assert.strictEqual(refused.published.refusal.rule, "pov-map-will-not-overwrite-an-artifact");
  assert.strictEqual(refused.published.sealed, null, "and the seal did not happen: the map refusal stopped the publish, not just the map");

  const blockedReader = openFixture(blocked, 1, DOCUMENT_SOURCE_STAGE);
  assert.strictEqual(isVolumeSealed(blockedReader, 1), false, "the record stays a draft, so the next volume still refuses to build on it");
  blockedReader.close();
  assert.strictEqual(fs.readFileSync(path.join(blocked.volumes[0].dir, POV_MAP_FILE), "utf8"), "# POV Map\n\n_authored_\n", "and the authored map is still there");

  console.log("  publishing writes the map before it seals, and a map refusal stops the publish rather than leaving a sealed, ungradeable volume");
}

// ─── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  scenarioRebuildFilesClaimsAsRenderableRows();
  scenarioExtractionClaimsStillDoNotRender();
  scenarioRebuildRefusesAnUncitableClaim();
  scenarioRebuildNeedsItsOwnWriteScope();
  scenarioRebuildIsIdempotent();
  scenarioNamesResolveOntoTheRoster();
  scenarioAnAliasNeedsAReason();
  scenarioADeclaredAliasMergesTheRosterBeforeFiling();
  scenarioSectionsAndBulletsFollowChapterOrder();
  scenarioAnOverlongBulletIsCappedAndNamed();
  scenarioARebuiltReferenceIsReportedAsRebuilt();
  scenarioCoverageStillFiresOnARebuiltReference();
  scenarioARebuiltReferenceThatMissesAMentionIsNotAStop();
  scenarioARebuiltReferenceThatLostACharacterTheExtractionFiledIsAStop();
  scenarioARebuiltRecordWithoutItsCandidatesCannotSeeThatLoss();
  scenarioARebuildRefusesACandidateHandleOfAnotherStage();
  scenarioRefusedClaimsAreNotCandidatesAndAnEmptyAdoptionQueryIsTheTrueAnswer();
  scenarioAPublishedRebuildSealsItsVolumeAndARehearsalDoesNot();
  scenarioTheCopyForwardGateOpensWhenTheRebuildPublishes();
  scenarioARebuildRefusesToSealARecordTheAuditCallsDamaged();
  scenarioSealingPublishesTheWholeVolumeNotJustTheRebuiltHalf();
  scenarioRePublishingARebuildsOwnOutputSealsItWithoutStackingRejectedFiles();
  scenarioARecordedAliasOutlivesTheRunThatCreatedTheRosterEntry();
  scenarioASealedVoiceRecordRefusesARebuild();
  scenarioARebuildClearsOnlyItsOwnMirror();
  scenarioTheDamagedFileIsMovedAsideAndKept();
  scenarioTheRebuiltFileRoundTrips();
  scenarioTheProvenanceCarriesForward();
  scenarioALaterVolumeNeedsItsEarlierRecordFirst();
  scenarioThePovMapRendersWhatTheCharacterReferenceCannot();
  scenarioThePovMapCarriesEarlierVolumesForwardInChapterOrder();
  scenarioAPovClaimWrittenWithTheOtherFieldNameKeepsItsProse();
  scenarioRenderingAMapForASealedRecordFilesNothingAndKeepsItSealed();
  scenarioAnAuthoredPovMapIsNotOverwrittenSilently();
  scenarioAPublishedRebuildWritesTheMapBeforeItSeals();
  await scenarioTheWholePathMakesNoModelCall();
  console.log("reference-store rebuild: all checks passed.");
})().catch((err) => {
  console.error(`reference-store rebuild test failed: ${err.message}`);
  process.exit(1);
});

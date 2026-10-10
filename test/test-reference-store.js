/**
 * test-reference-store.js — slice 2 of the reference-store plan: the store itself, with no
 * agent tools in sight.
 *
 * What has to be true before any agent is allowed near this database, and what each
 * scenario below is the proof of:
 *
 *   - **The file follows `SERIES_LOCATION` and the volume, and never falls back to the repo
 *     folder.** Gotchas 79 and 94 both exist because a path frozen at require time silently
 *     becomes the repo fallback on every run. With one file per volume the same mistake is
 *     worse than a wrong filename: volume 05 opening volume 01's file is the spoiler guard
 *     off. So the default is pinned here (the folder, the file name, the per-volume split),
 *     not only the override.
 *   - **A fact without evidence is refused.** Not warned about, not stored with a flag.
 *   - **A fact whose quoted evidence is not at the cited volume/chapter/line is refused**,
 *     and the refusal says where the quote really is — because "wrong line" and "wrong
 *     chapter" need different fixes, and a refusal that cannot be acted on gets switched
 *     off (gotcha 65's lesson).
 *   - **Ownership is stamped by the store, never by the caller.** A proposal that names its
 *     own owner is refused BY NAME, which is the only thing that stops a model from writing
 *     the field again.
 *
 * Every scenario runs against a throwaway fixture series (`test/fixture-reference-store.js`)
 * and asserts the store path it used is inside that fixture. No scenario can reach the real
 * 17 volumes (AGENTS.md rule 8, gotcha 69). No model call, no network.
 *
 * Run with `npm test`, or standalone: `node test/test-reference-store.js`.
 */
require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { projectRoot } = require("../configs/env-defaults");
const {
  openReferenceStore,
  referenceStorePath,
  referenceStoreSeriesDir,
  referenceStoreVolumeFolder,
  installmentKey,
  readSchemaVersion,
  SCHEMA_VERSION,
  REFERENCE_STORE_FILE_NAME,
  FACT_ASPECTS,
  silenceSqliteExperimentalWarning,
} = require("../utils/reference-store");

const {
  fixtureStoreSeries,
  assertInsideFixture,
  SOURCE_01,
} = require("./fixture-reference-store");

const ROOT = path.resolve(__dirname, "..");

/**
 * Open volume 1 of a fresh fixture, with its chapters registered.
 *
 * @param {string} label
 * @param {{volume?: number, stage?: string}} [opts]
 * @returns {{fx: Object, store: Object, dir: string}}
 */
function openFixtureStore(label, { volume = 1, stage = "merge" } = {}) {
  const fx = fixtureStoreSeries(label);
  const store = openReferenceStore({ volume, stage, seriesDir: fx.dir });
  assertInsideFixture(store.file, fx.dir);
  const registered = store.registerChaptersFromSource();
  assert.ok(registered.ok, `the fixture's chapters should register: ${registered.error}`);
  return { fx, store, dir: fx.dir };
}

/**
 * A fact that really is where it says it is: line 3 of ch1 quotes 「気にすんな！」.
 * @param {Object} [over]
 * @returns {Object}
 */
function trueFact(over = {}) {
  return {
    aspect: "catchphrase",
    label: "Catchphrases",
    body: "「気にすんな！」 is his stock reassurance.",
    evidence: [{ volume: 1, chapter: "ch1", line: 3, quote: "「気にすんな！」" }],
    ...over,
  };
}

// ─── 1. The path follows the series and the volume ────────────────────────────

/**
 * The default is pinned, not just the override: `<SERIES_LOCATION>/<volume folder>/series.db`,
 * resolved per call, with no repo fallback.
 */
function scenarioPathFollowsSeriesAndVolume() {
  const fx = fixtureStoreSeries("paths");

  // The default shape, pinned: the volume's own folder, the store's own file name.
  const one = referenceStorePath({ seriesDir: fx.dir, volume: 1 });
  assert.strictEqual(one.file, path.join(fx.dir, "Test Story(01)", "series.db"), "volume 01's store is in volume 01's folder");
  assert.strictEqual(REFERENCE_STORE_FILE_NAME, "series.db", "the file name is part of the design, not a detail");
  assertInsideFixture(one.file, fx.dir);

  // The volume decides the folder, through the plan of record — not a caller remembering it.
  const two = referenceStorePath({ seriesDir: fx.dir, volume: 2 });
  assert.strictEqual(two.file, path.join(fx.dir, "Test Story(02)", "series.db"), "volume 02 is a DIFFERENT file");
  assert.notStrictEqual(one.file, two.file, "one file per volume is the whole spoiler guard (doc 03 §7)");

  // Call-time resolution: change the setting, and the next call follows it. A constant
  // frozen at require time would keep handing out the first answer (gotcha 79, gotcha 94).
  const second = fixtureStoreSeries("paths-second");
  process.env.SERIES_LOCATION = second.dir;
  try {
    const moved = referenceStorePath({ volume: 1 });
    assert.strictEqual(
      moved.file,
      path.join(second.dir, "Test Story(01)", "series.db"),
      "the path follows SERIES_LOCATION at call time"
    );
    assert.notStrictEqual(moved.file, one.file, "and it is a different file from the one this call resolved a moment ago");
  } finally {
    process.env.SERIES_LOCATION = fx.dir;
  }

  // No series chosen is a refusal, never the repo folder.
  const saved = process.env.SERIES_LOCATION;
  delete process.env.SERIES_LOCATION;
  try {
    let threw = null;
    try {
      referenceStoreSeriesDir();
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, "with no SERIES_LOCATION the store refuses rather than guessing");
    assert.match(threw.message, /SERIES_LOCATION/, "the refusal names the setting to set");
    assert.match(threw.message, /NOT kept in the ai-client folder/, "and it says the repo folder is deliberately not the fallback");
  } finally {
    process.env.SERIES_LOCATION = saved;
  }

  // A volume the plan does not list is refused with the volumes it DOES list.
  let missing = null;
  try {
    referenceStoreVolumeFolder({ seriesDir: fx.dir, volume: 9 });
  } catch (err) {
    missing = err;
  }
  assert.ok(missing, "an unknown volume is refused rather than invented");
  assert.match(missing.message, /01, 02/, "the refusal names the volumes the plan actually has");

  // `1`, `"1"`, `"01"` and `5` all mean the volume the plan calls `01` / `05`.
  assert.strictEqual(installmentKey(1), "01");
  assert.strictEqual(installmentKey("01"), "01");
  assert.strictEqual(installmentKey(2), "02");
  assert.strictEqual(referenceStoreVolumeFolder({ seriesDir: fx.dir, volume: "2" }), "Test Story(02)");

  console.log("reference-store: the database path follows SERIES_LOCATION and the volume, and never the repo");
}

// ─── 2. The schema round-trips ────────────────────────────────────────────────

/**
 * Write, close, reopen: the rows, the cast, the chapters and the version are all still
 * there, and reopening creates nothing twice.
 */
function scenarioSchemaRoundTrip() {
  const { store, dir } = openFixtureStore("round-trip");
  const inserted = store.insertFact(trueFact({ key: "如月雨露", cast: { display: "如月雨露（ジョーロ）" } }));
  assert.ok(inserted.ok, `the fact should insert: ${inserted.refusal && inserted.refusal.because}`);
  const firstCounts = store.tableCounts();
  const firstVersion = store.schemaVersion;
  store.close();

  const again = openReferenceStore({ volume: 1, seriesDir: dir });
  assert.strictEqual(again.schemaVersion, firstVersion, "the version is read back, not re-decided");
  assert.strictEqual(again.schemaVersion, SCHEMA_VERSION, "and it is this build's version");
  assert.strictEqual(readSchemaVersion(again.db), SCHEMA_VERSION);
  assert.deepStrictEqual(again.tableCounts(), firstCounts, "reopening does not add or lose rows");
  assert.ok(again.getFact(inserted.fact.id), "the fact survived the round trip");
  assert.ok(again.getCast("如月雨露"), "so did the cast entry");
  assert.strictEqual(again.chapters().length, 3, "and the chapter list");

  const engine = again.db.prepare("SELECT value FROM store_info WHERE key = 'engine'").get();
  assert.strictEqual(engine.value, "node:sqlite", "the store records which engine wrote it");

  // A store written by a NEWER build is refused, not half-read.
  again.db.prepare("UPDATE store_info SET value = '99' WHERE key = 'schema_version'").run();
  again.close();
  let refused = null;
  try {
    openReferenceStore({ volume: 1, seriesDir: dir });
  } catch (err) {
    refused = err;
  }
  assert.ok(refused, "a store on a newer schema is refused rather than queried blind");
  assert.match(refused.message, /schema version 99/);

  console.log("reference-store: the schema round-trips, and a newer schema is refused rather than guessed at");
}

// ─── 3. Evidence is mandatory, and verified ───────────────────────────────────

/**
 * The three shapes the evidence rule has to refuse, and the sentence each refusal must
 * contain for the refusal to be usable.
 */
function scenarioEvidenceIsVerifiedAtInsert() {
  const { store } = openFixtureStore("evidence");

  // (a) No evidence at all.
  const none = store.insertFact({ aspect: "quirk", body: "He always does this.", evidence: [] });
  assert.strictEqual(none.ok, false, "a fact with no evidence is refused");
  assert.strictEqual(none.refusal.rule, "missing-evidence");
  assert.match(none.refusal.because, /at least one evidence item/);
  assert.strictEqual(store.allFacts().length, 0, "and nothing was written");

  // (b) Evidence whose quote is not at the cited line — and the refusal says where it is.
  const wrongLine = store.insertFact(
    trueFact({ evidence: [{ volume: 1, chapter: "ch1", line: 2, quote: "「気にすんな！」" }] })
  );
  assert.strictEqual(wrongLine.ok, false, "a mis-cited line is refused at the door");
  assert.strictEqual(wrongLine.refusal.rule, "evidence-does-not-verify");
  assert.match(wrongLine.refusal.because, /chapter ch1 line 2 does not contain/, "it names the citation that failed");
  assert.match(wrongLine.refusal.because, /chapter ch1 line 3/, "and it names where the quote actually is");
  assert.deepStrictEqual(wrongLine.refusal.detail.problems[0].found, [
    { chapter: "ch1", line: 3, matched: "verbatim" },
    { chapter: "ch2", line: 3, matched: "verbatim" },
  ]);

  // (c) A chapter this volume does not have.
  const wrongChapter = store.insertFact(
    trueFact({ evidence: [{ volume: 1, chapter: "ch9", line: 3, quote: "「気にすんな！」" }] })
  );
  assert.strictEqual(wrongChapter.ok, false, "a chapter that does not exist is refused");
  assert.match(wrongChapter.refusal.because, /no chapter "ch9"/);
  assert.match(wrongChapter.refusal.because, /ch0, ch1, ch2/, "and the refusal lists the chapters that DO exist");

  // (d) A quote that is not in the volume at all.
  const invented = store.insertFact(
    trueFact({ evidence: [{ volume: 1, chapter: "ch1", line: 3, quote: "「存在しない台詞！」" }] })
  );
  assert.strictEqual(invented.ok, false, "an invented quote is refused");
  assert.match(invented.refusal.because, /does not occur anywhere in this volume's source text/);

  // (e) One true citation and one invented one is still a refused fact.
  const mixed = store.insertFact(
    trueFact({
      evidence: [
        { volume: 1, chapter: "ch1", line: 3, quote: "「気にすんな！」" },
        { volume: 1, chapter: "ch1", line: 4, quote: "「存在しない台詞！」" },
      ],
    })
  );
  assert.strictEqual(mixed.ok, false, "one bad citation poisons the fact");

  // (f) The same fact, cited correctly, goes in.
  const good = store.insertFact(trueFact());
  assert.ok(good.ok, `the correctly cited fact should insert: ${good.refusal && good.refusal.because}`);
  assert.match(good.fact.id, /^v01-ch1-\d{3}$/, "ids are generated in doc 03 §2's shape");

  // (g) Impossible provenance: a volume-1 reading cannot cite volume 2.
  const impossible = store.insertFact(
    trueFact({ establishedVolume: 1, evidence: [{ volume: 2, chapter: "ch0", line: 2, quote: "「気にすんな！」" }] })
  );
  assert.strictEqual(impossible.ok, false, "a fact cannot cite a volume later than the one that produced it");
  assert.strictEqual(impossible.refusal.rule, "impossible-provenance");

  // (h) An aspect outside the closed vocabulary is refused, and the refusal lists the vocabulary.
  const badAspect = store.insertFact(trueFact({ aspect: "vibes" }));
  assert.strictEqual(badAspect.ok, false, "aspect is a closed vocabulary (doc 03 §9.5)");
  assert.strictEqual(badAspect.refusal.rule, "aspect-not-in-vocabulary");
  assert.deepStrictEqual(badAspect.refusal.detail.allowed, FACT_ASPECTS);

  store.close();
  console.log("reference-store: a fact without evidence, or with evidence that is not at its citation, is refused at insert");
}

// ─── 4. Ownership is stamped by the store ─────────────────────────────────────

/**
 * The label a caller writes is not the label the guard reads (doc 03 §3.2). Naming a
 * harness-owned field is refused BY NAME — silently discarding it would let the caller keep
 * writing it.
 */
function scenarioOwnershipIsStampedNotClaimed() {
  const { store } = openFixtureStore("ownership-stamp", { volume: 1, stage: "extract" });

  const claimed = store.insertFact(trueFact({ owner_volume: 7, owner_stage: "verify" }));
  assert.strictEqual(claimed.ok, false, "a proposal may not name its own owner");
  assert.strictEqual(claimed.refusal.rule, "harness-owned-field");
  assert.match(claimed.refusal.because, /owner_volume/, "the refusal names the field it refused");

  const inserted = store.insertFact(trueFact());
  assert.ok(inserted.ok);
  assert.strictEqual(inserted.fact.owner_volume, 1, "the store wrote the volume it was opened with");
  assert.strictEqual(inserted.fact.owner_stage, "extract", "and the stage it was opened with");
  assert.strictEqual(inserted.fact.sealed, 0, "and it starts as a draft");

  // The scope is frozen: nothing later can move it. (A plain assignment to a frozen object
  // is silently ignored outside strict mode, so the check is on the value, not on the throw.)
  try {
    store.scope.volume = 9;
  } catch {
    /* strict-mode callers get a throw; the assertion below covers both */
  }
  assert.strictEqual(store.scope.volume, 1, "the write scope is frozen at open time");

  store.close();
  console.log("reference-store: ownership comes from the context the store was opened with, never from the row");
}

// ─── 5. The spoiler ceiling is the query ──────────────────────────────────────

/**
 * doc 03 §2.1's sharp edge, checked end to end: a fact whose evidence ceiling is later than
 * the volume being served is not showable there, and a fact established late but evidenced
 * early IS.
 */
function scenarioShowableCeiling() {
  const { store } = openFixtureStore("ceiling", { volume: 2, stage: "merge" });

  // Registered so the store can reach volume 1's source from a volume-2 file.
  store.registerVolume({ volume: 1, folder: "Test Story(01)" });

  const late = store.insertFact({
    aspect: "quirk",
    body: "Established while reading volume 2.",
    evidence: [{ volume: 2, chapter: "ch0", line: 2, quote: "「気にすんな！」" }],
    establishedVolume: 2,
    appliesFromVolume: 1,
  });
  assert.ok(late.ok, `the volume-2 fact should insert: ${late.refusal && late.refusal.because}`);

  const early = store.insertFact({
    aspect: "quirk",
    body: "A late discovery about something volume 1 printed.",
    evidence: [{ volume: 1, chapter: "ch1", line: 3, quote: "「気にすんな！」" }],
    establishedVolume: 2,
    appliesFromVolume: 1,
  });
  assert.ok(early.ok, `the late-discovery fact should insert: ${early.refusal && early.refusal.because}`);

  const atOne = store.showableFacts(1).rows.map((r) => r.id);
  assert.ok(!atOne.includes(late.fact.id), "a volume-2 revelation is not showable at volume 1");
  assert.ok(atOne.includes(early.fact.id), "a late discovery of a volume-1 line IS showable at volume 1 (doc 03 §2.1)");

  const atTwo = store.showableFacts(2).rows.map((r) => r.id);
  assert.ok(atTwo.includes(late.fact.id) && atTwo.includes(early.fact.id), "both are showable at volume 2");

  store.close();
  console.log("reference-store: the spoiler rule is derived from the evidence, not from a flag");
}

// ─── 6. The engine's load-time warning ────────────────────────────────────────

/**
 * The `ExperimentalWarning` decision (doc 03 §2.1.1 leaves it open), pinned in a real child
 * process so stderr can be read: the SQLite warning does not print, and a different warning
 * still does.
 */
function scenarioExperimentalWarningIsFiltered() {
  // The filter is installed once, not once per call.
  silenceSqliteExperimentalWarning();
  const before = process.listeners("warning").length;
  silenceSqliteExperimentalWarning();
  assert.strictEqual(process.listeners("warning").length, before, "installing the filter twice does not stack a second copy");

  const child = spawnSync(
    process.execPath,
    [
      "-e",
      [
        `const rs = require(${JSON.stringify(path.join(ROOT, "utils/reference-store.js"))});`,
        `rs.openReferenceStore(${JSON.stringify({ volume: 1, seriesDir: process.env.SERIES_LOCATION, stage: "merge" })}).close();`,
        `process.emitWarning("canary warning", "Warning", "CANARY");`,
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env } }
  );
  const stderr = String(child.stderr || "");
  assert.strictEqual(child.status, 0, `the child should have run: ${stderr}`);
  assert.ok(
    !/SQLite is an experimental feature/.test(stderr),
    `the store's load must not print the engine's experimental warning, but stderr was:\n${stderr}`
  );
  assert.ok(stderr.includes("canary warning"), `every other warning still reaches stderr, but stderr was:\n${stderr}`);

  console.log("reference-store: node:sqlite's load-time warning is filtered, and every other warning is not");
}

// ─── 7. Two kinds of evidence, and which rule proved them ─────────────────────

/**
 * Review 05 §3.1 and §3.6, pinned together because they are the same rule seen from two sides.
 *
 * The book prints 如月きさらぎ雨あま露つゆ and a glossary row says 如月雨露: neither string
 * contains the other, so a store that only matches verbatim refuses the row that is most
 * obviously in the book. The answer is the Han-character skeleton comparison the carry-forward
 * gate already uses — with its length guard, because two kanji sitting in one line is
 * coincidence and coincidence is not evidence. And whatever the rule is, it has to be the same
 * rule at import and at re-verification, or every furiganed row becomes a HIGH finding the
 * second time anybody looks.
 */
function scenarioEvidenceKindsAndMatching() {
  const { store } = openFixtureStore("evidence-kinds");

  // (a) A quote the book prints only with reading aids written between its characters.
  const furiganed = store.insertFact({
    aspect: "quirk",
    body: "She stops in the corridor.",
    evidence: [{ volume: 1, chapter: "ch2", line: 4, quote: "秋野桜" }],
  });
  assert.strictEqual(furiganed.ok, true, "the Han-character skeleton is a citation this store accepts");
  const furiganedEvidence = JSON.parse(furiganed.fact.evidence)[0];
  assert.strictEqual(furiganedEvidence.matched, "skeleton", "and the store records WHICH rule matched");
  assert.strictEqual(furiganedEvidence.kind, "quote", "and what the citation claims");

  // (b) The helper's length guard travels with it. 桜 and 廊 are both in that line, and they are
  // not adjacent in it — which is exactly the coincidence the guard is for.
  const coincidence = store.insertFact({
    aspect: "quirk",
    body: "Two kanji that happen to appear in one line.",
    evidence: [{ volume: 1, chapter: "ch2", line: 4, quote: "桜廊" }],
  });
  assert.strictEqual(coincidence.ok, false, "a two-kanji skeleton is not evidence");
  assert.strictEqual(coincidence.refusal.rule, "evidence-does-not-verify");

  // (c) `governs` — this row is the decision made about a passage that IS in the book.
  const governs = store.insertFact({
    aspect: "term_usage",
    body: "The catchphrase is his stock line.",
    evidence: [{ volume: 1, chapter: "ch2", line: 3, quote: "「気にすんな！」はジョーロの定型である。", kind: "governs" }],
  });
  assert.strictEqual(governs.ok, true, "a governed passage is evidence");
  assert.strictEqual(JSON.parse(governs.fact.evidence)[0].kind, "governs", "and the kind is stored, not assumed");

  // (d) A `governs` citation is checked exactly like a quote: the line it names has to contain it.
  const badGoverns = store.insertFact({
    aspect: "term_usage",
    body: "A governed citation that points at the wrong line.",
    evidence: [{ volume: 1, chapter: "ch2", line: 2, quote: "「気にすんな！」はジョーロの定型である。", kind: "governs" }],
  });
  assert.strictEqual(badGoverns.ok, false, "there is no citation shape here that is taken on trust");
  assert.strictEqual(badGoverns.refusal.rule, "evidence-does-not-verify");

  // (e) An unknown kind is refused rather than defaulted.
  const unknownKind = store.insertFact({
    aspect: "quirk",
    body: "Evidence of a kind this store does not have.",
    evidence: [{ volume: 1, chapter: "ch2", line: 3, quote: "ジョーロ", kind: "vibes" }],
  });
  assert.strictEqual(unknownKind.ok, false, "the two kinds are a closed list");

  // (f) Symmetry: the rows that got in by the skeleton rule re-verify by the same rule.
  const audit = store.integrityFindings();
  const evidenceFailures = audit.findings.filter((f) => f.kind === "reference-evidence-does-not-verify");
  assert.deepStrictEqual(evidenceFailures.map((f) => f.message), [], "import and re-verification use one matching rule");

  store.close();

  console.log("reference-store: evidence has two kinds, and the store records which rule proved each one");
}

// ─── 8. The fixture cannot reach the corpus ───────────────────────────────────

/**
 * The guard itself: a store path outside the fixture is a hard failure, not a warning.
 * This is the check that makes "no test may read the real books" a fact rather than an
 * intention (gotcha 69).
 */
function scenarioFixtureCannotReachTheCorpus() {
  const fx = fixtureStoreSeries("guard");
  assertInsideFixture(path.join(fx.dir, "Test Story(01)", "series.db"), fx.dir);
  let threw = null;
  try {
    assertInsideFixture(path.join(projectRoot, "epub_source", "series.db"), fx.dir);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, "a store path inside the repo is refused by the fixture guard");

  // And the fixture's own source is what the store read, not the real books.
  const { store } = openFixtureStore("guard-source");
  const chapters = store.chapters();
  assert.deepStrictEqual(
    chapters.map((c) => c.chapter_id),
    ["ch0", "ch1", "ch2"],
    "the fixture's chapters are the ones the store sees"
  );
  assert.strictEqual(SOURCE_01.ch0.length, 5, "the fixture's own chapter is the small known thing the tests are measuring");
  store.close();

  console.log("reference-store: every scenario is inside a fixture, and the guard says so");
}

(async () => {
  scenarioPathFollowsSeriesAndVolume();
  scenarioSchemaRoundTrip();
  scenarioEvidenceIsVerifiedAtInsert();
  scenarioOwnershipIsStampedNotClaimed();
  scenarioShowableCeiling();
  scenarioExperimentalWarningIsFiltered();
  scenarioEvidenceKindsAndMatching();
  scenarioFixtureCannotReachTheCorpus();
  console.log("reference-store: all checks passed.");
})().catch((err) => {
  console.error(`reference-store test failed: ${err.message}`);
  process.exit(1);
});

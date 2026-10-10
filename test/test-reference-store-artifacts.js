/**
 * test-reference-store-artifacts.js — slice 4: import both artifacts for one volume, then
 * render them back, and prove the store is not a second source of truth.
 *
 * Doc 03 §7.3's last paragraph is the safety net this suite exists to hold: *bidirectional
 * reconstructibility — import the existing artifacts into the database, then render and diff
 * against the files on disk. If the diff is clean, the round trip is proven and the database
 * is never the only copy of anything.* Slice 4 is the slice that proves it, for **both**
 * artifacts at once (doc 04 §6's decision), because a store that can hold the glossary but
 * not the voice reference has only solved half of the artifact that killed the last run.
 *
 * The two criteria, both pinned:
 *   - the rendered file diffs clean against the file on disk, for the glossary AND the
 *     character-voice reference;
 *   - rendering the same data twice is byte-identical — which is what makes "the documents
 *     are views" (doc 03 §4) a property rather than a hope, and what lets a re-run's skip
 *     check trust a rendered file.
 *
 * And the honest half: a row the store cannot check is **refused and reported**, never
 * quietly dropped. An import that loses rows while reporting success is the same failure the
 * carry-forward gates exist to catch (gotcha 64's 457 vanished terms), just wearing a
 * migration's clothes.
 *
 * Review 05 added the two halves of that honesty this suite did not have. **§3.4**: a document is
 * more than its rows — the title line, the preamble, and the paragraph that sits under a section
 * before its table are stored and rendered back verbatim, blank lines included, which is what
 * turns "diffs clean" from an approximation into a byte-for-byte claim (measured on the real
 * volume 01: the rendered glossary equals the file on disk except for the one row the store
 * refused). **§4 item D**: a character-voice reference that covers fewer characters than the cast
 * holds is a HIGH finding, and a character whose bullets all failed to verify keeps its place in
 * the roster — because a store that shrinks the roster to match a damaged artifact has recorded
 * the damage as fact.
 *
 * Fixture series only. No model call, no network, and no test here reads the real 17 volumes
 * (AGENTS.md rule 8, gotcha 69). Run with `npm test`, or standalone:
 * `node test/test-reference-store-artifacts.js`.
 */
require("./test-home");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  openReferenceStore,
  importGlossary,
  renderGlossary,
  importVoice,
  renderVoice,
  parseGlossaryMarkdown,
  parseVoiceMarkdown,
  GLOSSARY_HEADER,
  VOICE_SECTION,
} = require("../utils/reference-store");

const { fixtureStoreSeries, assertInsideFixture, GLOSSARY_01, GLOSSARY_UNVERIFIABLE_ROW, VOICE_01, VOICE_01_MISSING_CHARACTERS } = require("./fixture-reference-store");

/**
 * A fixture volume 01 with its chapters registered.
 * @param {string} label
 * @returns {{fx: Object, store: Object, dir: string}}
 */
function openVolumeOne(label) {
  const fx = fixtureStoreSeries(label);
  const store = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: "import" });
  assertInsideFixture(store.file, fx.dir);
  const registered = store.registerChaptersFromSource();
  assert.ok(registered.ok, registered.error);
  return { fx, store, dir: fx.dir };
}

/**
 * The diff, in the shape a human can read when an assertion fails.
 * @param {string} name
 * @param {string} expected
 * @param {string} actual
 */
function assertCleanRoundTrip(name, expected, actual) {
  if (expected === actual) return;
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const diff = [];
  for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i += 1) {
    if (expectedLines[i] !== actualLines[i]) {
      diff.push(`  line ${i + 1}:\n    on disk: ${JSON.stringify(expectedLines[i])}\n    rendered: ${JSON.stringify(actualLines[i])}`);
    }
  }
  throw new Error(`${name} did not round-trip:\n${diff.join("\n")}`);
}

// ─── 1. The glossary round-trips ──────────────────────────────────────────────

function scenarioGlossaryRoundTrip() {
  const { store } = openVolumeOne("artifact-glossary");
  const parsed = parseGlossaryMarkdown(GLOSSARY_01);
  assert.strictEqual(parsed.rows.length, 5, "the fixture glossary has five term rows");
  assert.strictEqual(parsed.title, "# Glossary", "and its title line is read, not skipped");
  assert.ok(parsed.preamble.includes("_Canonical renderings for the fixture series._"), "and so is its preamble");

  const result = importGlossary(store, GLOSSARY_01);
  assert.ok(result.ok, `every row should import: ${result.refused.map((r) => `${r.row.term}: ${r.because}`).join("\n")}`);
  assert.strictEqual(result.imported.length, 5);
  assert.strictEqual(store.tableCounts().facts, 5, "one row per glossary entry");
  assert.strictEqual(store.tableCounts().cast, 3, "and the Characters section IS the roster the store keeps");
  assert.strictEqual(result.castRegistered, 3);

  const rendered = renderGlossary(store);
  assertCleanRoundTrip("glossary.md", GLOSSARY_01, rendered);

  // Review 05 §3.4: the document's own prose is stored and rendered back, and the column
  // headers are the ones the real artifact and the rest of the pipeline already read.
  assert.ok(
    rendered.startsWith("# Glossary\n\n_Canonical renderings for the fixture series._\n\n## Characters"),
    "the title and preamble come back verbatim"
  );
  assert.match(rendered, /^\| Japanese \| English \| Notes \|$/m, "the header row is the pipeline's, not the store's");
  const proseRows = store.documentProse("glossary");
  assert.strictEqual(proseRows.filter((row) => row.section === null).length, 4, "title plus the preamble block, blank lines included");
  assert.strictEqual(proseRows.filter((row) => row.section === "Terms").length, 3, "and a section's own paragraph is stored against that section");
  assert.strictEqual(proseRows[0].kind, "title", "the first line is recorded as the title");

  // The sections survived as data, not as formatting.
  const sections = store
    .db.prepare("SELECT section FROM facts GROUP BY section ORDER BY MIN(ord)")
    .all()
    .map((r) => r.section);
  assert.deepStrictEqual(sections, ["Characters", "Nicknames", "Terms"]);

  store.close();
  console.log("reference-store artifacts: the glossary imports, renders back, and diffs clean");
}

// ─── 2. The character-voice reference round-trips ─────────────────────────────

function scenarioVoiceRoundTrip() {
  const { store } = openVolumeOne("artifact-voice");
  const parsed = parseVoiceMarkdown(VOICE_01);
  assert.strictEqual(parsed.characters.length, 3);
  assert.strictEqual(parsed.characters[0].key, "如月雨露", "the heading's aliases and persona tag do not hide who it is about");
  assert.strictEqual(parsed.characters[0].persona, "俺人格");
  assert.deepStrictEqual(parsed.preamble, ["", "## Characters", ""], "the opening prose is kept, blank lines and all");

  const result = importVoice(store, VOICE_01);
  assert.ok(result.ok, `every bullet should import: ${result.refused.map((r) => `${r.character}/${r.label}: ${r.because}`).join("\n")}`);
  assert.strictEqual(result.characters, 3);
  assert.strictEqual(result.imported.length, 5);
  assert.strictEqual(result.importedCount, 5, "and the count is stated, not implied by an array's length");
  assert.strictEqual(store.tableCounts().cast, 3);
  assert.strictEqual(store.tableCounts().facts, 5);

  const rendered = renderVoice(store);
  assertCleanRoundTrip("character-voice.md", VOICE_01, rendered);
  assert.strictEqual(store.documentProse("character-voice").length, 4, "the title and the preamble are stored, not dropped");

  // The aspect vocabulary and the artifact's own label are separate, and both survived:
  // `register` is what a query runs on, "Sentence endings" is what the file says.
  // The "Notes" label lands in `unclassified` — the fallback named as a fallback (review 05 §2.3).
  const aspects = store.db.prepare("SELECT aspect, label FROM facts ORDER BY ord").all();
  assert.deepStrictEqual(
    aspects.map((r) => `${r.aspect}/${r.label}`),
    [
      "pronoun/Pronouns",
      "catchphrase/Catchphrases",
      "catchphrase/Catchphrases",
      "unclassified/Notes",
      "appearance/Appears in",
    ]
  );

  store.close();
  console.log("reference-store artifacts: the character-voice reference imports, renders back, and diffs clean");
}

// ─── 3. Both artifacts in one store, without interfering ──────────────────────

/**
 * Doc 04 §10.1: **one** store, **two** thin adapters. The two artifacts share the store
 * without either renderer picking up the other's rows.
 */
function scenarioBothArtifactsInOneStore() {
  const { store } = openVolumeOne("artifact-both");
  const glossary = importGlossary(store, GLOSSARY_01);
  const voice = importVoice(store, VOICE_01);
  assert.ok(glossary.ok && voice.ok);
  assert.strictEqual(store.tableCounts().facts, 10, "one store, both artifacts");

  assertCleanRoundTrip("glossary.md", GLOSSARY_01, renderGlossary(store));
  assertCleanRoundTrip("character-voice.md", VOICE_01, renderVoice(store));

  // A glossary term is not a character, and a character's bullet is not a term row.
  const termRows = store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE aspect = 'term_usage'").get().n;
  assert.strictEqual(termRows, 5);
  assert.strictEqual(store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE key IS NOT NULL").get().n, 5);
  assert.strictEqual(store.tableCounts().cast, 3, "and the roster is the union of the two artifacts' characters, not their sum");

  store.close();
  console.log("reference-store artifacts: one store, two adapters, and neither renderer leaks the other's rows");
}

// ─── 4. Rendering the same data twice is byte-identical ───────────────────────

/**
 * Including across a close and reopen, which is the case that actually matters: a re-run is
 * a new process, and a rendered artifact that changes between runs invalidates every draft
 * built from it.
 */
function scenarioRenderingIsDeterministic() {
  const { store, dir } = openVolumeOne("artifact-deterministic");
  importGlossary(store, GLOSSARY_01);
  importVoice(store, VOICE_01);

  const firstGlossary = renderGlossary(store);
  const firstVoice = renderVoice(store);
  const secondGlossary = renderGlossary(store);
  const secondVoice = renderVoice(store);
  assert.strictEqual(firstGlossary, secondGlossary, "the glossary renders byte-identically twice");
  assert.strictEqual(firstVoice, secondVoice, "and so does the voice reference");
  store.close();

  const again = openReferenceStore({ volume: 1, seriesDir: dir, create: false });
  assert.strictEqual(renderGlossary(again), firstGlossary, "a new process renders the same bytes");
  assert.strictEqual(renderVoice(again), firstVoice);
  again.close();

  console.log("reference-store artifacts: rendering the same data twice is byte-identical, across processes too");
}

// ─── 5. A row the store cannot check is refused and reported ──────────────────

function scenarioUnverifiableRowsAreReported() {
  const { store } = openVolumeOne("artifact-refused");

  const withBadRow = `${GLOSSARY_01}\n## Ghosts\n\n| Japanese | English | Notes |\n|---|---|---|\n${GLOSSARY_UNVERIFIABLE_ROW}\n`;
  const result = importGlossary(store, withBadRow);
  assert.strictEqual(result.ok, false, "an import that could not check a row does not report success");
  assert.strictEqual(result.imported.length, 5, "the rows it COULD check still went in");
  assert.strictEqual(result.refused.length, 1);
  assert.strictEqual(result.refused[0].row.term, "存在しない用語");
  assert.match(result.refused[0].because, /occurs in volume 1's source text/, "and the refusal says why");
  assert.match(result.refused[0].because, /neither kind of evidence/, "naming both kinds it tried");

  // The refused row is not in the store, and so it is not in the render — which is the
  // difference between a lossy import and a silent one: the report is where the loss is visible.
  assert.strictEqual(store.tableCounts().facts, 5);
  const rendered = renderGlossary(store);
  assert.ok(!rendered.includes("存在しない用語"), "a row with no evidence is not published");
  assert.ok(rendered.includes("## Characters") && rendered.includes("## Nicknames"), "and the sections that did import are intact");

  // The voice half, same rule: a bullet that quotes nothing the book contains.
  const badVoice = `# Character Voice Reference

## Characters

### 幽霊（名前なし）

- **Notes**: この人物について本には何も書かれていない。
`;
  const voiceResult = importVoice(store, badVoice);
  assert.strictEqual(voiceResult.ok, false, "a character section with nothing to cite is refused");
  assert.strictEqual(voiceResult.imported.length, 0);
  assert.strictEqual(voiceResult.refused.length, 1);
  assert.match(voiceResult.refused[0].because, /occurs in volume 1's source text/);
  // The cast entry STAYS. Deleting it is how a damaged reference imports as a smaller, tidy
  // store; keeping it is what lets the coverage query notice (review 05 §4 item D).
  assert.ok(store.getCast("幽霊"), "the roster survives the import that could not describe it");

  store.close();
  console.log("reference-store artifacts: a row that cannot be checked is refused and named, never dropped quietly");
}

// ─── 6. The store is the source; the file is the view ─────────────────────────

/**
 * The direction the whole design depends on (doc 03 §9.4): the rendered file is derived
 * from the rows, so a query answers "what does the translator get?" and the file is a
 * printout of that answer.
 */
function scenarioStoreIsAuthoritative() {
  const { store } = openVolumeOne("artifact-authoritative");
  importGlossary(store, GLOSSARY_01);
  importVoice(store, VOICE_01);

  const before = renderVoice(store);
  const target = store
    .db.prepare("SELECT id FROM facts WHERE aspect = 'catchphrase' AND key = ? ORDER BY ord LIMIT 1")
    .get("如月雨露");
  const updated = store.updateOwnFact(target.id, { body: "「気にすんな！」 becomes his default reassurance." });
  assert.ok(updated.ok, `the store should be editable through the guards: ${updated.refusal && updated.refusal.because}`);

  const after = renderVoice(store);
  assert.notStrictEqual(before, after, "the rendered file follows the rows");
  assert.ok(after.includes("becomes his default reassurance"));
  assert.ok(!before.includes("becomes his default reassurance"));

  // And the file on disk is never edited to make that true — the renderer writes it.
  const written = path.join(store.volumeDir, "character-voice.md");
  fs.writeFileSync(written, after, "utf8");
  assert.strictEqual(fs.readFileSync(written, "utf8"), renderVoice(store), "re-rendering reproduces the published file");

  store.close();
  console.log("reference-store artifacts: the database is the source and the document is the view");
}

// ─── 7. The adapters' own parsers are not the pipeline's ──────────────────────

/**
 * Deliberate, and worth pinning: the store's parser is NOT `glossary/carry-forward/table.js`
 * or `character-voice/reference-index.js`. A round trip through the parser that already reads
 * these files would prove the parser agrees with itself, not that the store can reproduce
 * the artifact.
 */
function scenarioParsersAreIndependent() {
  const { parseGlossaryTableTerms } = require("../glossary/carry-forward/table");
  const { parseVoiceSections } = require("../character-voice/reference-index");

  const theirs = parseGlossaryTableTerms(GLOSSARY_01).map((e) => e.term);
  const ours = parseGlossaryMarkdown(GLOSSARY_01).rows.map((r) => r.term);
  assert.deepStrictEqual(ours, theirs, "the two parsers agree about which rows exist — different code, same book");

  const theirSections = parseVoiceSections(VOICE_01).map((s) => s.primary);
  const ourSections = parseVoiceMarkdown(VOICE_01).characters.map((c) => c.key);
  assert.deepStrictEqual(ourSections, theirSections, "and the same for the character sections");

  assert.deepStrictEqual(GLOSSARY_HEADER, ["Japanese", "English", "Notes"], "the headers the real artifact and delivery-verify already read");
  assert.strictEqual(VOICE_SECTION, "Characters");

  console.log("reference-store artifacts: the store's parsers are its own, so the round trip is a real cross-check");
}

// ─── 8. A row whose term the book never prints can still cite the passage it governs ──

/**
 * Review 05 §3.6. The glossary has rows that are decisions about a passage rather than
 * spellings of a word — 僕／俺（一人称） is the real one — and a store that only accepts "the
 * book prints this string" refuses them. The answer is a second KIND of evidence, checked the
 * same way: the row's notes quote a passage, the passage is really there, at a line the store
 * found. A row that can cite neither is refused, which is the rule working rather than a hole in it.
 */
function scenarioGovernsEvidence() {
  const { store } = openVolumeOne("artifact-governs");
  const result = importGlossary(store, GLOSSARY_01);
  assert.ok(result.ok);

  const governed = store.db
    .prepare("SELECT id, evidence FROM facts WHERE examples LIKE ? ORDER BY ord LIMIT 1")
    .get("%会計担当%");
  assert.ok(governed, "the row whose term is never printed still imported");
  const [item] = JSON.parse(governed.evidence);
  assert.strictEqual(item.kind, "governs", "as a governed passage, and the store records that it is one");
  assert.strictEqual(item.matched, "verbatim");
  assert.strictEqual(item.chapter, "ch1");
  assert.strictEqual(item.quote, "山田は会計の人である。", "the citation is the passage the notes quote, not the term");

  // And the refusal when neither kind is available.
  const { store: other } = openVolumeOne("artifact-governs-refused");
  const refused = importGlossary(
    other,
    `# Glossary\n\n## Terms\n\n| Japanese | English | Notes |\n|---|---|---|\n| 架空の映画 | A Film That Is Not In This Book | A parody of something else entirely |\n`
  );
  assert.strictEqual(refused.imported.length, 0, "a row with no quote and no governed passage does not enter the store");
  assert.strictEqual(refused.refused.length, 1);
  assert.match(refused.refused[0].because, /quote no passage to govern/);

  store.close();
  other.close();
  console.log("reference-store artifacts: quote and governs are the two kinds, and a row that can cite neither is refused");
}

// ─── 9. A voice reference that lost the cast is reported, not imported quietly ─

/**
 * The check that would have caught volume 01 (review 05 §4 item D). The real volume 01
 * character-voice reference has three `### ` sections; the glossary names seven characters. An
 * import that only asks "did every line I read verify?" imports that as a clean three-character
 * store, and the damage becomes invisible. The roster the glossary registered is what makes the
 * gap a number, and the number is a HIGH finding.
 */
function scenarioVoiceCoverageIsChecked() {
  const { store } = openVolumeOne("artifact-coverage");
  importGlossary(store, GLOSSARY_01);
  const damaged = importVoice(store, VOICE_01_MISSING_CHARACTERS);
  assert.ok(damaged.ok, "every line of the damaged file verifies — that is exactly why the check is needed");
  assert.strictEqual(damaged.characters, 1);
  assert.strictEqual(store.tableCounts().cast, 3, "and the roster the glossary registered is still three characters");

  const audit = store.integrityFindings();
  const coverage = audit.findings.filter((f) => f.kind === "reference-voice-covers-fewer-characters");
  assert.strictEqual(coverage.length, 1, "the gap between the roster and the reference is a finding");
  assert.strictEqual(coverage[0].severity, "HIGH", "at the severity that stops a copy-forward");
  assert.match(coverage[0].message, /大賀太陽/, "and it names the characters the reference lost");
  assert.strictEqual(audit.ok, false);

  // Importing the whole reference clears it.
  importVoice(store, VOICE_01);
  const after = store.integrityFindings();
  assert.deepStrictEqual(
    after.findings.filter((f) => f.kind === "reference-voice-covers-fewer-characters").map((f) => f.message),
    [],
    "the finding is about the store's state, not about the file that was imported"
  );

  store.close();
  console.log("reference-store artifacts: a character-voice reference that covers fewer characters than the cast is a HIGH finding");
}

(async () => {
  scenarioGlossaryRoundTrip();
  scenarioVoiceRoundTrip();
  scenarioBothArtifactsInOneStore();
  scenarioRenderingIsDeterministic();
  scenarioUnverifiableRowsAreReported();
  scenarioStoreIsAuthoritative();
  scenarioParsersAreIndependent();
  scenarioGovernsEvidence();
  scenarioVoiceCoverageIsChecked();
  console.log("reference-store artifacts: all checks passed.");
})().catch((err) => {
  console.error(`reference-store artifacts test failed: ${err.message}`);
  process.exit(1);
});

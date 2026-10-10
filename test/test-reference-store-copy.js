/**
 * test-reference-store-copy.js — slice 3: copying volume N−1's record into volume N is a
 * guarded step, not a file copy (doc 03 §7.3).
 *
 * Per-volume files buy spoiler isolation and cost something real: doc 03 §7.2 states it
 * plainly, **damage propagates forward.** Volume 4's file was copied from volume 3's, so a
 * corrupt volume 3 makes volume 4 corrupt in exactly the same way. The copy is therefore
 * where the guard goes — the moment damage would propagate, and the last moment it can
 * still be refused.
 *
 * The four things §7.3 requires, each pinned here:
 *   - a database that fails the integrity queries is **not copied**;
 *   - the source's content hash and row counts are recorded **inside the copy**;
 *   - after copying, the copy's row counts are verified against the source's;
 *   - a copy that fails is a **HIGH** post-mortem finding, not a warning.
 *
 * Plus the one this build added, because it is the failure a re-run actually hits: a copy
 * never overwrites a volume that already has its own record. That record is what that
 * volume's agents added to, and a step that replaced it while reporting that it had carried
 * the previous volume forward would be the worst kind of lie this layer can tell.
 *
 * And the one review 05 §3.2 added: **a volume that was never sealed is not copied forward.**
 * Sealing is what makes "this volume's record is published" a fact about the file, and copying a
 * draft forward would make the copy's provenance claim a stability the source does not have. The
 * mechanism is not a new gate — it is one more HIGH finding in the audit the copy already runs,
 * which is why every scenario here seals volume 1 before it copies it.
 *
 * Fixture series only; no model call, no network (gotcha 69).
 * Run with `npm test`, or standalone: `node test/test-reference-store-copy.js`.
 */
require("./test-home");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { openReferenceStore, copyForwardStore, readCopyProvenance } = require("../utils/reference-store");
const { fixtureStoreSeries, assertInsideFixture } = require("./fixture-reference-store");

/**
 * Row counts with `volumes` removed — the one table a copy is allowed to gain, because the
 * destination registers the volume it landed in. copy-forward.js excludes it for the same
 * reason; the tests exclude it explicitly rather than relying on the check to forget it.
 *
 * @param {Object} counts
 * @returns {Object}
 */
function withoutVolumes(counts) {
  const out = { ...counts };
  delete out.volumes;
  return out;
}

/**
 * A fixture volume 01 with one verified fact and one character, **sealed**.
 *
 * Sealed by default because that is the order the pipeline will actually run in: a volume's
 * pre-production ends, its record is sealed, and only then may it become the next volume's
 * starting point (review 05 §3.2). Pass `{seal: false}` to plant the case where it was not.
 *
 * @param {string} label
 * @param {{seal?: boolean}} [opts]
 * @returns {{fx: Object, store: Object, dir: string, factId: string}}
 */
function seededVolumeOne(label, { seal = true } = {}) {
  const fx = fixtureStoreSeries(label);
  const store = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: "merge" });
  assertInsideFixture(store.file, fx.dir);
  store.registerChaptersFromSource();
  store.upsertCast({ key: "如月雨露", display: "如月雨露（ジョーロ）", firstSeenVolume: 1 });
  const inserted = store.insertFact({
    key: "如月雨露",
    aspect: "catchphrase",
    label: "Catchphrases",
    body: "「気にすんな！」 is his stock reassurance.",
    evidence: [{ volume: 1, chapter: "ch1", line: 3, quote: "「気にすんな！」" }],
  });
  assert.ok(inserted.ok, `the seed fact should insert: ${inserted.refusal && inserted.refusal.because}`);
  if (seal) {
    const sealed = store.sealVolume(1);
    assert.ok(sealed.ok, "the fixture volume is published before it is copied");
  }
  return { fx, store, dir: fx.dir, factId: inserted.fact.id };
}

/**
 * Plant a row that the guards would have refused, by writing it straight into the table.
 *
 * That is the point: copy-forward's job is to catch the row that got in some other way —
 * a hand-edited file, a volume built by an older build, a database that was half-written
 * when a run died.
 *
 * @param {Object} store
 * @param {{evidence: string, establishedVolume?: number}} plant
 * @returns {string} The planted id.
 */
function plantBadFact(store, { evidence, establishedVolume = 1 }) {
  const id = `v01-planted-${store.allFacts().length + 1}`;
  store.db
    .prepare(
      "INSERT INTO facts (id, key, aspect, body, examples, evidence, established_volume, applies_from_volume, " +
        "status, source_stage, owner_volume, owner_stage, sealed, created_at, row_version, ord) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .run(
      id,
      null,
      "quirk",
      "A row that never went through the guards.",
      "[]",
      evidence,
      establishedVolume,
      1,
      "active",
      "merge",
      1,
      "merge",
      0,
      new Date().toISOString(),
      1,
      999
    );
  return id;
}

/**
 * The bytes of a file, so a refusal can be proven to have changed nothing.
 * @param {string} file
 * @returns {string|null}
 */
function snapshot(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// ─── 1. A clean copy: identical counts, provenance recorded ───────────────────

function scenarioCleanCopy() {
  const { store, dir, factId } = seededVolumeOne("copy-clean");
  const sourceCounts = store.tableCounts();
  const sourceFile = store.file;
  const sourceFact = JSON.stringify(store.getFact(factId));
  const sourceCast = JSON.stringify(store.getCast("如月雨露"));
  store.close();

  const result = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: dir });
  assert.ok(result.ok, `a clean copy should succeed: ${result.refusal && result.refusal.because}`);
  assert.deepStrictEqual(
    result.findings.filter((f) => f.severity === "HIGH"),
    [],
    "a clean copy raises no HIGH finding"
  );

  const destFile = path.join(dir, "Test Story(02)", "series.db");
  assertInsideFixture(destFile, dir);

  // §7.3's third bullet: the copy's counts equal the source's, table by table.
  //
  // `volumes` is the one table the copy is ALLOWED to gain, and the test says so out loud
  // instead of letting the check quietly ignore it: the destination registers the volume it
  // landed in, which is what makes the copy traceable. Gaining any other row is the failure.
  assert.deepStrictEqual(
    withoutVolumes(result.dest.counts),
    withoutVolumes(result.source.counts),
    "the copy carries the same rows"
  );
  assert.strictEqual(
    result.dest.counts.volumes,
    result.source.counts.volumes + 1,
    "and the only table it gains a row in is the one that names the volume it landed in"
  );
  for (const table of Object.keys(sourceCounts)) {
    assert.ok(result.source.counts[table] > 0 || sourceCounts[table] === 0);
  }
  assert.strictEqual(result.dest.counts.facts, sourceCounts.facts, "the facts survived");
  assert.strictEqual(result.dest.counts.cast, sourceCounts.cast, "so did the cast");

  // §7.3's second bullet: the source's hash and counts, recorded INSIDE the copy.
  const dest = openReferenceStore({ volume: 2, seriesDir: dir, create: false });
  const [provenance] = readCopyProvenance(dest);
  assert.ok(provenance, "the copy records where it came from");
  assert.strictEqual(provenance.source_volume, 1);
  assert.strictEqual(provenance.source_file, sourceFile);
  assert.match(provenance.source_sha256, /^[0-9a-f]{64}$/, "the source hash is a sha256");
  assert.deepStrictEqual(JSON.parse(provenance.source_rows), sourceCounts);
  assert.deepStrictEqual(JSON.parse(provenance.copied_rows), result.dest.counts);
  assert.strictEqual(provenance.ok, 1);
  assert.ok(dest.getFact(factId), "volume 2's file carries volume 1's fact (doc 03 §7: knowledge accumulates)");
  assert.ok(dest.getCast("如月雨露"), "and volume 1's character");
  dest.close();

  // Checking the source must not damage it. (The copy checkpoints the source's write-ahead
  // log, which rewrites the file's bytes; what must not change is what the file SAYS.)
  const after = openReferenceStore({ volume: 1, seriesDir: dir, create: false });
  assert.strictEqual(JSON.stringify(after.getFact(factId)), sourceFact, "the source's fact is untouched by being checked");
  assert.strictEqual(JSON.stringify(after.getCast("如月雨露")), sourceCast, "so is its cast entry");
  assert.deepStrictEqual(after.tableCounts(), sourceCounts, "and the source's row counts");
  after.close();

  console.log("reference-store copy: a clean copy has identical row counts and records its source hash");
}

// ─── 2. A corrupt source is refused, and reported HIGH ────────────────────────

/**
 * Three shapes of "corrupt", because they get in three different ways and only the first
 * is a broken file.
 */
function scenarioCorruptSourceIsRefused() {
  // (a) A fact with no evidence.
  const a = seededVolumeOne("copy-corrupt-no-evidence");
  plantBadFact(a.store, { evidence: "[]" });
  a.store.close();
  const refusedA = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: a.dir });
  assert.strictEqual(refusedA.ok, false, "a volume with an unevidenced fact is not copied forward");
  assert.strictEqual(refusedA.refusal.rule, "reference-source-fails-integrity");
  const highA = refusedA.findings.filter((f) => f.severity === "HIGH");
  assert.ok(highA.length > 0, "the failure is HIGH, not a warning (§7.3)");
  assert.ok(highA.some((f) => f.kind === "reference-fact-without-evidence"));
  assert.strictEqual(refusedA.findings.filter((f) => f.severity === "LOW").length, 0, "and it is not softened into LOW");
  assert.strictEqual(
    fs.existsSync(path.join(a.dir, "Test Story(02)", "series.db")),
    false,
    "a refused copy writes nothing into the next volume"
  );

  // (b) A fact whose quoted evidence is not at the line it cites.
  const b = seededVolumeOne("copy-corrupt-bad-citation");
  const planted = plantBadFact(b.store, {
    evidence: JSON.stringify([{ volume: 1, chapter: "ch1", line: 4, quote: "「気にすんな！」" }]),
  });
  b.store.close();
  const refusedB = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: b.dir });
  assert.strictEqual(refusedB.ok, false, "a mis-dated claim does not get to infect the next volume");
  assert.ok(refusedB.findings.some((f) => f.kind === "reference-evidence-does-not-verify" && f.severity === "HIGH"));
  assert.ok(refusedB.refusal.because.includes(planted), "the refusal names the row that failed");

  // (c) A file that is not a database at all.
  const c = seededVolumeOne("copy-corrupt-garbage");
  c.store.close();
  fs.writeFileSync(c.store.file, "this is not a database, it is a mistake\n", "utf8");
  const refusedC = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: c.dir });
  assert.strictEqual(refusedC.ok, false, "an unreadable source is refused");
  assert.strictEqual(refusedC.refusal.rule, "reference-source-unreadable");
  assert.strictEqual(refusedC.findings[0].severity, "HIGH");

  console.log("reference-store copy: a corrupt source is refused, and reported at HIGH severity");
}

// ─── 3. A copy never overwrites a volume that already has a record ────────────

function scenarioCopyDoesNotOverwrite() {
  const { store, dir } = seededVolumeOne("copy-overwrite");
  store.close();

  const first = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: dir });
  assert.ok(first.ok, `the first copy should succeed: ${first.refusal && first.refusal.because}`);

  // Volume 2 does its own work.
  const vol2 = openReferenceStore({ volume: 2, seriesDir: dir, create: false });
  const own = vol2.insertFact({
    aspect: "quirk",
    body: "Volume 2's own reading.",
    evidence: [{ volume: 2, chapter: "ch0", line: 2, quote: "「気にすんな！」" }],
  });
  assert.ok(own.ok, `volume 2 should be able to add its own fact: ${own.refusal && own.refusal.because}`);
  const beforeCounts = vol2.tableCounts();
  vol2.close();

  const destFile = path.join(dir, "Test Story(02)", "series.db");
  const before = snapshot(destFile);

  const again = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: dir });
  assert.strictEqual(again.ok, false, "a second copy-forward does not silently replace volume 2's record");
  assert.strictEqual(again.refusal.rule, "reference-copy-overwrites-a-volume");
  assert.match(again.refusal.because, /already has its own reference store/);
  assert.match(again.refusal.fix, /remove its series\.db deliberately/, "and the refusal says what to do about it");

  assert.ok(Buffer.from(before).equals(snapshot(destFile)), "the refusal left volume 2's file byte-for-byte as it was");
  const after = openReferenceStore({ volume: 2, seriesDir: dir, create: false });
  assert.strictEqual(after.tableCounts().facts, beforeCounts.facts, "volume 2's own fact is still there");
  assert.ok(after.getFact(own.fact.id));
  after.close();

  console.log("reference-store copy: a volume that already has a record is refused, and left untouched");
}

// ─── 4. A missing source is refused, not skipped ──────────────────────────────

function scenarioMissingSource() {
  const fx = fixtureStoreSeries("copy-missing");
  const result = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: fx.dir });
  assert.strictEqual(result.ok, false, "there is nothing to copy, and the step says so");
  assert.strictEqual(result.refusal.rule, "reference-copy-missing-source");
  assert.strictEqual(result.findings[0].severity, "HIGH");
  assert.strictEqual(result.findings[0].kind, "reference-copy-missing-source");
  assert.strictEqual(result.findings[0].volume, "2", "the finding is filed against the volume that was being prepared");
  assert.strictEqual(fs.existsSync(path.join(fx.dir, "Test Story(02)", "series.db")), false);

  console.log("reference-store copy: a volume with no record is a refusal, not an empty starting point");
}

// ─── 5. The copy is checked against the source it came from ───────────────────

/**
 * The provenance row is what makes "which record did volume 5 work from?" answerable from
 * the file itself, years later (doc 03 §2.2, §7.1).
 */
function scenarioProvenanceChain() {
  const { store, dir } = seededVolumeOne("copy-chain");
  store.close();
  assert.ok(copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: dir }).ok);
  const missingThird = copyForwardStore({ fromVolume: 2, toVolume: 3, seriesDir: dir });
  assert.strictEqual(missingThird.ok, false, "volume 03 has no folder in this fixture, so the step refuses");
  assert.strictEqual(missingThird.refusal.rule, "reference-copy-path-undecided");
  assert.strictEqual(missingThird.findings[0].severity, "HIGH");
  assert.strictEqual(
    fs.existsSync(path.join(dir, "Test Story(02)", "series.db")),
    true,
    "and the refusal did not disturb the volume it was copying FROM"
  );

  const vol2 = openReferenceStore({ volume: 2, seriesDir: dir, create: false });
  const provenance = readCopyProvenance(vol2);
  assert.strictEqual(provenance.length, 1, "volume 2 knows exactly one source");
  assert.strictEqual(provenance[0].source_volume, 1);
  assert.strictEqual(provenance[0].source_file, path.join(dir, "Test Story(01)", "series.db"));
  vol2.close();

  console.log("reference-store copy: the chain of custody is recorded inside each volume's own file");
}

// ─── 6. An unsealed volume is not published, so it is not copied ──────────────

/**
 * Review 05 §3.2: sealing is what makes "this volume's record is published" a fact about the
 * file, and copy-forward is where that fact is enforced. The mechanism is not a new gate — it is
 * one more finding in the audit copy-forward already runs, at HIGH, which is the severity that
 * stops the copy.
 */
function scenarioUnsealedSourceIsRefused() {
  const { store, dir } = seededVolumeOne("copy-unsealed", { seal: false });
  store.close();

  const refused = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: dir });
  assert.strictEqual(refused.ok, false, "a draft does not become another volume's starting point");
  assert.strictEqual(refused.refusal.rule, "reference-source-fails-integrity");
  const unsealed = refused.findings.filter((f) => f.kind === "reference-volume-unsealed");
  assert.strictEqual(unsealed.length, 1, "the audit names the volume that was never published");
  assert.strictEqual(unsealed[0].severity, "HIGH", "and it is a refusal, not a note");
  assert.strictEqual(
    fs.existsSync(path.join(dir, "Test Story(02)", "series.db")),
    false,
    "and the refused copy writes nothing into the next volume"
  );

  // Sealing it is the fix, and the same call then copies cleanly: the refusal is a state, not a
  // verdict about the data.
  const publish = openReferenceStore({ volume: 1, seriesDir: dir, create: false });
  assert.strictEqual(publish.isVolumeSealed(1), false, "the store says so before it is sealed");
  publish.sealVolume(1);
  publish.close();

  const second = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: dir });
  assert.ok(second.ok, `sealing volume 1 lets the copy run: ${second.refusal && second.refusal.because}`);
  assert.deepStrictEqual(second.findings.filter((f) => f.severity === "HIGH"), []);

  console.log("reference-store copy: a volume that was never sealed is not copied forward");
}

(async () => {
  scenarioCleanCopy();
  scenarioCorruptSourceIsRefused();
  scenarioCopyDoesNotOverwrite();
  scenarioMissingSource();
  scenarioProvenanceChain();
  scenarioUnsealedSourceIsRefused();
  console.log("reference-store copy: all checks passed.");
})().catch((err) => {
  console.error(`reference-store copy test failed: ${err.message}`);
  process.exit(1);
});

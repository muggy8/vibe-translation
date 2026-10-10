/**
 * test-reference-store-ownership.js — slice 5: drafts are yours, published history is not.
 *
 * The rule doc 03 §3.2–§3.3 sets, in the words the design uses:
 *
 *     before the volume's record is sealed   →  the agent's own rows are DRAFTS
 *                                               update and delete freely
 *     after it is sealed                     →  those rows are part of the published record
 *                                               no delete; challenge or supersede instead
 *
 * and the way it is enforced, which is the part that decides whether it is a rule at all:
 * **in the statement, not the prompt.**
 *
 *     UPDATE facts SET … WHERE id = :id AND owner_volume = :currentVolume
 *                        AND owner_stage = :currentStage AND sealed = 0
 *
 * A row this scope does not own is not written and then reported — it is never matched, so
 * **zero rows change**, and the refusal is built afterwards from the row's real owner. That is
 * what makes half of this suite's criteria meaningful: the refusal has to name the volume that
 * actually owns the row and the verb that IS available (`challenge_fact`), because a refusal
 * that only says "not allowed" is the refusal that gets a knob added to it — which is why
 * `utils/tickets` and `utils/patches` refuse by name too (gotcha 65, gotcha 70).
 *
 * Review 05 closed three gaps in that rule, and each one is a scenario here. **§3.2**: a volume
 * seals its own record, so a row copied forward arrives *sealed* and the refusal volume 2 hits is
 * the sealing one — while a foreign row that is somehow unsealed (a hand-edited file) is still
 * refused by ownership. **§3.5**: a challenge is closable (`uphold` / `accept`) and by default it
 * contests rather than replaces, so `supersedes` is set only when someone decides it should be.
 * **§3.3**: a cast merge is supersession rather than deletion, and a sealed volume's cast takes
 * aliases but not merges.
 *
 * Fixture series only. No model call, no network (gotcha 69). Run with `npm test`, or
 * standalone: `node test/test-reference-store-ownership.js`.
 */
require("./test-home");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { openReferenceStore, copyForwardStore, importVoice } = require("../utils/reference-store");
const { fixtureStoreSeries, assertInsideFixture, VOICE_01 } = require("./fixture-reference-store");

/**
 * A volume 01 carrying one fact, **sealed**, copied forward into volume 02, and volume 02 opened
 * as the stage that is about to try to write.
 *
 * Sealed because review 05 §3.2 decides when a volume is published: its own record is sealed at
 * the end of its pre-production, and copy-forward refuses to carry a record that is still
 * editable. So the rows volume 2 receives are published rows, and the refusal volume 2 hits when
 * it reaches for one is the sealing refusal.
 *
 * @param {string} label - Which fixture series to build.
 * @param {{stage?: string, seal?: boolean}} [opts] - The stage volume 02 is opened as.
 * @returns {{fx: Object, dir: string, vol1FactId: string, store: Object}}
 */
function volumeTwoCarryingVolumeOne(label, { stage = "extract", seal = true } = {}) {
  const fx = fixtureStoreSeries(label);
  const vol1 = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: "merge" });
  assertInsideFixture(vol1.file, fx.dir);
  vol1.registerChaptersFromSource();
  vol1.upsertCast({ key: "如月雨露", display: "如月雨露（ジョーロ）", firstSeenVolume: 1 });
  const seed = vol1.insertFact({
    key: "如月雨露",
    aspect: "catchphrase",
    label: "Catchphrases",
    body: "「気にすんな！」 is his stock reassurance.",
    evidence: [{ volume: 1, chapter: "ch1", line: 3, quote: "「気にすんな！」" }],
  });
  assert.ok(seed.ok, `the seed fact should insert: ${seed.refusal && seed.refusal.because}`);
  if (seal) vol1.sealVolume(1);
  vol1.close();

  const copied = copyForwardStore({ fromVolume: 1, toVolume: 2, seriesDir: fx.dir });
  assert.ok(copied.ok, `the copy should succeed: ${copied.refusal && copied.refusal.because}`);
  assert.deepStrictEqual(
    withoutVolumes(copied.source.counts),
    withoutVolumes(copied.dest.counts),
    "the copy carries the same rows, table by table"
  );
  if (typeof copied.closeDest === "function") copied.closeDest();

  const store = openReferenceStore({ volume: 2, seriesDir: fx.dir, stage });
  assertInsideFixture(store.file, fx.dir);
  store.registerChaptersFromSource();
  return { fx, dir: fx.dir, vol1FactId: seed.fact.id, store };
}

/**
 * The copy's row-count comparison: `volumes` is excluded because the destination legitimately
 * registers its own volume row — that row is what makes the copy traceable to the volume it
 * landed in. Every other table must match exactly (copy-forward.js states the same exclusion).
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
 * A fact volume 2's own reading produced.
 * @param {Object} store
 * @returns {Object} The inserted fact.
 */
function volumeTwosOwnFact(store) {
  const inserted = store.insertFact({
    aspect: "quirk",
    label: "Notes",
    body: "Volume 2's own reading of the epilogue.",
    evidence: [{ volume: 2, chapter: "ch0", line: 3, quote: "駱駝はあとがきに書いた。" }],
  });
  assert.ok(inserted.ok, `volume 2 should be able to insert: ${inserted.refusal && inserted.refusal.because}`);
  return inserted.fact;
}

/**
 * The `challenges` rows against one fact, read straight from the table the verb writes.
 * @param {Object} store
 * @param {string} factId
 * @returns {Array<Object>}
 */
function challengeRows(store, factId) {
  return store.db.prepare("SELECT * FROM challenges WHERE fact_id = ? ORDER BY id").all(factId);
}

// ─── 1. Your own unsealed rows: update and delete freely ──────────────────────

function scenarioOwnRowsAreEditable() {
  const { store } = volumeTwoCarryingVolumeOne("own-rows");
  const own = volumeTwosOwnFact(store);

  const updated = store.updateOwnFact(own.id, { body: "Volume 2's reading, corrected.", label: "Notes" });
  assert.ok(updated.ok, `an agent may correct its own mis-stated claim: ${updated.refusal && updated.refusal.because}`);
  assert.strictEqual(updated.changed, 1);
  assert.strictEqual(updated.fact.body, "Volume 2's reading, corrected.");
  assert.strictEqual(updated.fact.row_version, 2, "and the row version moves, so the change is visible");

  const deleted = store.deleteOwnFact(own.id, "the claim was wrong and nothing replaces it");
  assert.ok(deleted.ok, `deleting your own draft is legal: ${deleted.refusal && deleted.refusal.because}`);
  assert.strictEqual(deleted.changed, 1);
  assert.strictEqual(store.getFact(own.id), null, "and it is gone");

  store.close();
  console.log("reference-store ownership: a volume edits and deletes its own unsealed rows");
}

// ─── 2. Another volume's row: zero rows change, and the refusal names the owner ─

/**
 * The two shapes a foreign row arrives in, and the refusal each one gets.
 *
 * A row copied from a published volume arrives **sealed** (review 05 §3.2), so the refusal is the
 * sealing one. A foreign row that is NOT sealed is the shape of a hand-edited file or a store
 * built by an older build — and ownership still refuses it, naming the volume that owns it.
 */
function scenarioAnotherVolumesRowIsUntouchable() {
  const { store, vol1FactId } = volumeTwoCarryingVolumeOne("other-volumes-row");

  // (a) The carried row: published, therefore sealed, therefore not this volume's to edit.
  assert.strictEqual(store.getFact(vol1FactId).sealed, 1, "a copied row arrives published, because volume 1 was sealed first");
  const triedPublished = store.updateOwnFact(vol1FactId, { body: "volume 2 rewrites a published claim" });
  assert.strictEqual(triedPublished.ok, false);
  assert.strictEqual(triedPublished.changed, 0, "the statement matched no row — the write never happened");
  assert.strictEqual(triedPublished.refusal.rule, "fact-is-sealed");

  // (b) A foreign row that is NOT sealed: ownership alone has to stop it. Planted by writing it
  // straight into the table, which is how such a row really appears — a hand-edited file, or a
  // volume built before sealing existed.
  const plantedId = "v01-unsealed-plant";
  store.db
    .prepare(
      "INSERT INTO facts (id, key, aspect, body, examples, evidence, established_volume, applies_from_volume, " +
        "status, source_stage, owner_volume, owner_stage, sealed, created_at, row_version, ord) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .run(
      plantedId,
      "如月雨露",
      "quirk",
      "A row volume 1 wrote, in a file volume 2 is holding.",
      "[]",
      JSON.stringify([{ volume: 1, chapter: "ch1", line: 3, quote: "「気にすんな！」", kind: "quote", matched: "verbatim" }]),
      1,
      1,
      "active",
      "merge",
      1,
      "merge",
      0,
      new Date().toISOString(),
      1,
      900
    );

  const tried = store.updateOwnFact(plantedId, { body: "volume 2 rewrites volume 1's claim" });
  assert.strictEqual(tried.ok, false);
  assert.strictEqual(tried.changed, 0, "the statement matched no row — the write never happened");
  assert.strictEqual(store.getFact(plantedId).body, "A row volume 1 wrote, in a file volume 2 is holding.",
    "and the row is exactly what its owner wrote");
  assert.strictEqual(tried.refusal.rule, "fact-owned-by-another-volume");
  assert.match(tried.refusal.because, /written by volume 1/,
    "the refusal names the volume that actually owns it");
  assert.deepStrictEqual(tried.refusal.useInstead, ["challenge_fact"],
    "and it names the verb that IS available, because a bare 'not allowed' gets a knob added to it");
  assert.strictEqual(tried.refusal.detail.ownerVolume, 1, "the refusal is data, not a sentence");

  const deleted = store.deleteOwnFact(plantedId, "volume 2 does not like this claim");
  assert.strictEqual(deleted.ok, false);
  assert.strictEqual(deleted.changed, 0);
  assert.strictEqual(deleted.refusal.rule, "fact-owned-by-another-volume");
  assert.ok(store.getFact(plantedId), "the published row is still there");
  assert.ok(store.getFact(vol1FactId), "and so is the sealed one");

  store.close();
  console.log("reference-store ownership: another volume's row changes zero rows, sealed or not, and the refusal names its owner");
}

// ─── 3. Stage scope: the extract stage does not own the merge stage's rows ─────

function scenarioStageScope() {
  const base = volumeTwoCarryingVolumeOne("stage-scope", { stage: "extract" });
  const extractFact = volumeTwosOwnFact(base.store); // owned by (volume 2, stage "extract")
  base.store.close();

  // The same volume's file, opened as a different stage.
  const store = openReferenceStore({ volume: 2, seriesDir: base.dir, stage: "merge", create: false });
  const tried = store.updateOwnFact(extractFact.id, { body: "the merge stage rewrites what the extract stage wrote" });
  assert.strictEqual(tried.ok, false);
  assert.strictEqual(tried.changed, 0);
  assert.strictEqual(tried.refusal.rule, "fact-owned-by-another-stage",
    "the same volume, a different stage, is still not yours to rewrite");
  assert.deepStrictEqual(tried.refusal.useInstead, ["challenge_fact"]);
  assert.strictEqual(store.getFact(extractFact.id).body, "Volume 2's own reading of the epilogue.");

  const ownRow = volumeTwosOwnFact(store); // owned by (volume 2, stage "merge")
  const edited = store.updateOwnFact(ownRow.id, { body: "the merge stage corrects its own row" });
  assert.ok(edited.ok, `the same stage may still edit its own row: ${edited.refusal && edited.refusal.because}`);

  // And when BOTH differ, the refusal says the louder half: it is another volume's published row.
  const crossVolume = store.updateOwnFact(base.vol1FactId, { body: "volume 2 rewrites volume 1" });
  assert.strictEqual(crossVolume.refusal.rule, "fact-is-sealed");

  store.close();
  console.log("reference-store ownership: ownership is (volume, stage), not volume alone");
}

// ─── 4. Sealing: the volume's rows become part of the published record ────────

function scenarioSealingClosesTheWindow() {
  const { store } = volumeTwoCarryingVolumeOne("sealed", { stage: "merge" });
  const own = volumeTwosOwnFact(store);

  assert.strictEqual(store.isVolumeSealed(2), false);
  const sealed = store.sealVolume(2);
  assert.ok(sealed.ok, `a volume may seal its own record: ${sealed.refusal && sealed.refusal.because}`);
  assert.strictEqual(sealed.sealedRows, 1, "the rows this volume wrote are the rows it seals");
  assert.strictEqual(store.isVolumeSealed(2), true);
  assert.strictEqual(store.sealVolume(2).alreadySealed, true, "sealing twice is a no-op, not an error");

  const deleted = store.deleteOwnFact(own.id, "the window closed before this arrived");
  assert.strictEqual(deleted.ok, false);
  assert.strictEqual(deleted.changed, 0, "the row is not deleted, and the count proves it");
  assert.strictEqual(deleted.refusal.rule, "fact-is-sealed");
  assert.deepStrictEqual(deleted.refusal.useInstead, ["challenge_fact"]);

  const updated = store.updateOwnFact(own.id, { body: "a sealed row is edited anyway" });
  assert.strictEqual(updated.ok, false);
  assert.strictEqual(updated.changed, 0);
  assert.strictEqual(updated.refusal.rule, "fact-is-sealed");
  assert.strictEqual(store.getFact(own.id).body, "Volume 2's own reading of the epilogue.");

  // The snapshot the plan's acceptance test is measured against: the sealed volume's showable
  // set is frozen, and it still contains both the row the agent wanted to delete and the row
  // volume 1 published.
  const snapshot = store.factsAtVolume(2);
  assert.ok(snapshot.includes(own.id), "the frozen snapshot contains the volume's own row");
  const carried = store.factsFor({ key: "如月雨露" }).rows[0];
  assert.ok(snapshot.includes(carried.id), "and it contains the carried-forward row");
  assert.ok(
    snapshot.filter((id) => store.getFact(id).owner_volume === 2).every((id) => store.getFact(id).sealed === 1),
    "every row this volume wrote is sealed"
  );
  // The carried-forward row is in the snapshot and it is sealed — because volume 1 sealed its own
  // record before the copy ran, which is the rule review 05 §3.2 sets: a volume seals its own
  // rows at the end of its pre-production, and copy-forward refuses to carry a record that is
  // still editable. Sealing is not something a later volume does to an earlier one.
  assert.strictEqual(store.getFact(carried.id).sealed, 1, "a copied row arrives published, not editable");

  store.close();
  console.log("reference-store ownership: sealing closes the window, and the snapshot keeps the record");
}

// ─── 5. Challenging a published row: the only door, and what it takes ─────────

function scenarioChallengeIsTheOnlyDoor() {
  const { store, vol1FactId } = volumeTwoCarryingVolumeOne("challenge", { stage: "merge" });

  const noReason = store.challengeFact(vol1FactId, { reason: "" });
  assert.strictEqual(noReason.ok, false);
  assert.strictEqual(noReason.refusal.rule, "challenge-needs-reason",
    "a challenge with no reason is not a challenge, it is a mood");
  assert.strictEqual(challengeRows(store, vol1FactId).length, 0, "and nothing was recorded");
  assert.strictEqual(store.getFact(vol1FactId).status, "active", "and the target is untouched");

  const challenged = store.challengeFact(vol1FactId, {
    reason: "volume 1's chapter 1 has him say the line to 我妻, not to 春.",
    evidence: [{ volume: 1, chapter: "ch1", line: 3, quote: "「気にすんな！」" }],
  });
  assert.ok(challenged.ok, `a reasoned challenge is allowed: ${challenged.refusal && challenged.refusal.because}`);
  assert.strictEqual(challenged.fact.owner_volume, 2, "the challenger's row belongs to the challenger");
  // Review 05 §3.5: supersession is a CHOICE, and the default is not to supersede. A challenge
  // that automatically replaced its target would make every disagreement a decision nobody made.
  assert.strictEqual(challenged.supersede, false, "the default contests the claim, it does not replace it");
  assert.strictEqual(challenged.fact.supersedes, null, "so the challenger is filed against nothing yet");
  assert.strictEqual(challenged.target.status, "disputed", "and the challenged row is marked, not removed");

  const record = challengeRows(store, vol1FactId);
  assert.strictEqual(record.length, 1);
  assert.strictEqual(record[0].challenger_id, challenged.fact.id);
  assert.strictEqual(record[0].outcome, null, "the challenge is open, and the store knows it is open");
  assert.match(record[0].reason, /我妻/, "the reason is stored, so 'who said this was wrong' is answerable");

  // The evidence rule is the same rule as everywhere else in the store: a challenge is not a
  // licence to assert something unverified.
  const badEvidence = store.challengeFact(vol1FactId, {
    reason: "I am sure of this.",
    evidence: [{ volume: 1, chapter: "ch1", line: 3, quote: "a line that is not in the source" }],
  });
  assert.strictEqual(badEvidence.ok, false);
  assert.strictEqual(badEvidence.refusal.rule, "evidence-does-not-verify");
  assert.strictEqual(challengeRows(store, vol1FactId).length, 1, "and the failed challenge left nothing behind");

  // A contested claim is still a claim the translator gets: both rows are showable, and the
  // target carries the `disputed` mark. That is what "contested, not replaced" has to mean.
  const showable = store.showableFacts(2).rows;
  assert.ok(showable.some((fact) => fact.id === challenged.fact.id), "the challenger's row is showable");
  assert.ok(showable.some((fact) => fact.id === vol1FactId), "and so is the disputed row it answers");
  assert.strictEqual(store.factHistory({ key: "如月雨露", aspect: "catchphrase" }).rows.length, 2,
    "and both rows are still in the store");

  store.close();
  console.log("reference-store ownership: challenge needs a reason, and by default it contests rather than replaces");
}

// ─── 6. Merging two cast entries: the merge is a recorded decision ───────────

function scenarioCastMergeIsRecorded() {
  const { store } = volumeTwoCarryingVolumeOne("cast-merge", { stage: "merge" });

  store.upsertCast({ key: "ジョーロ", display: "ジョーロ", firstSeenVolume: 2 });
  const aliasFact = store.insertFact({
    key: "ジョーロ",
    aspect: "catchphrase",
    label: "Catchphrases",
    body: "「任せておけ！」 under his nickname.",
    evidence: [{ volume: 2, chapter: "ch0", line: 3, quote: "駱駝はあとがきに書いた。" }],
  });
  assert.ok(aliasFact.ok, `the duplicate entry's fact should insert: ${aliasFact.refusal && aliasFact.refusal.because}`);

  // A merge is the branch of this verb that rewrites other rows' keys, so it has to say why. It
  // is expressed as supersession rather than deletion (review 05 §3.3): the merged entry stays,
  // marked with the entry it joined.
  const silent = store.castAlias("如月雨露", "ジョーロ");
  assert.strictEqual(silent.ok, false);
  assert.strictEqual(silent.refusal.rule, "cast-merge-needs-reason");
  assert.ok(store.getCast("ジョーロ"), "and the duplicate is still there, untouched");
  assert.strictEqual(store.castMerges().length, 0);

  const merged = store.castAlias("如月雨露", "ジョーロ", "the same person: the nickname is his alias");
  assert.ok(merged.ok, `a reasoned merge is allowed: ${merged.refusal && merged.refusal.because}`);
  assert.strictEqual(merged.merged, "ジョーロ");
  assert.strictEqual(merged.movedFacts, 1, "the duplicate's facts moved with it");
  const mergedAway = store.getCast("ジョーロ");
  assert.ok(mergedAway, "the merged entry is NOT deleted — a deleted row cannot be audited");
  assert.strictEqual(mergedAway.merged_into, "如月雨露", "it stays, marked with the entry it joined");
  assert.strictEqual(store.getFact(aliasFact.fact.id).key, "如月雨露", "and its fact is now the survivor's");
  assert.strictEqual(store.castMerges().length, 1);
  assert.strictEqual(store.castMerges()[0].reason, "the same person: the nickname is his alias",
    "the merge is answerable afterwards, which is the only defence against a wrong one");

  // Re-merging an entry that already joined somewhere else is refused rather than chained
  // silently: two rows claiming the same character is the defect this verb exists to fix.
  store.upsertCast({ key: "春", display: "春", firstSeenVolume: 2 });
  const reMerge = store.castAlias("春", "ジョーロ", "a third spelling of the same person");
  assert.strictEqual(reMerge.ok, false);
  assert.strictEqual(reMerge.refusal.rule, "cast-entry-already-merged");
  assert.match(reMerge.refusal.because, /already merged into "如月雨露"/, "and the refusal says where it already went");

  const selfMerge = store.castAlias("如月雨露", "如月雨露", "merge a character into itself");
  assert.strictEqual(selfMerge.ok, false);
  assert.strictEqual(selfMerge.refusal.rule, "cast-alias-is-self");

  const unknown = store.castAlias("我妻", "春", "merge into a character that is not in the cast");
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.refusal.rule, "cast-unknown-key");

  // A plain alias — a spelling, not a duplicate entry — is not destructive, so it needs no reason
  // and records no merge.
  const aliasOnly = store.castAlias("如月雨露", "キサラギ");
  assert.ok(aliasOnly.ok, `a plain alias is allowed: ${aliasOnly.refusal && aliasOnly.refusal.because}`);
  assert.strictEqual(aliasOnly.merged, null);
  assert.strictEqual(store.castMerges().length, 1, "and it is not a merge");
  assert.ok(JSON.parse(store.getCast("如月雨露").aliases).includes("キサラギ"));

  store.close();
  console.log("reference-store ownership: a cast merge needs a reason and is recorded with one");
}

// ─── 7. Imported rows: owned by the import, so the volume can still fix them ──

function scenarioImportedRowsAreOwnedByTheImport() {
  const fx = fixtureStoreSeries("imported-rows");
  const volumeDir = fx.volumes[0].dir;
  const file = path.join(volumeDir, "character-voice.md");
  fs.writeFileSync(file, VOICE_01, "utf8");

  // Volume 1 is the first volume, so there is nothing to copy forward from: its record starts
  // empty and the import is what fills it.
  const store = openReferenceStore({ volume: 1, seriesDir: fx.dir, stage: "import" });
  const report = importVoice(store, fs.readFileSync(file, "utf8"));
  assert.ok(report.ok, `the import should succeed: ${report.refused.map((r) => `${r.character}/${r.label}: ${r.because}`).join("\n")}`);
  assert.ok(report.imported.length >= 2, "and it imported rows, not just a count");

  const imported = report.imported[0];
  assert.strictEqual(imported.owner_volume, 1);
  assert.strictEqual(imported.owner_stage, "import",
    "an imported row is owned by the stage that imported it, so the volume can still correct it");

  const corrected = store.updateOwnFact(imported.id, { body: `${imported.body} (checked against the source)` });
  assert.ok(corrected.ok, `the importing stage may correct the row it imported: ${corrected.refusal && corrected.refusal.because}`);

  store.sealVolume(1);
  const afterSeal = store.updateOwnFact(imported.id, { body: "after the seal" });
  assert.strictEqual(afterSeal.ok, false);
  assert.strictEqual(afterSeal.refusal.rule, "fact-is-sealed",
    "and an imported row is sealed like any other row: the artifact it came from is now history");

  store.close();
  console.log("reference-store ownership: imported rows are owned by the import, and sealed like any other row");
}

// ─── 8. A challenge is closable: uphold or accept, and the count reaches zero ──

/**
 * Review 05 §3.5. A challenge that cannot be closed is a permanent warning nobody can clear, and
 * the pipeline already counts open disputes as something that has to be able to reach zero.
 *
 * `uphold` — the original stands: the challenger is retracted (never deleted) and the target's
 * `disputed` mark is cleared. `accept` — the challenger stands: its `supersedes` is set now, which
 * is the mechanism that takes the target out of the guidance.
 */
function scenarioChallengesAreClosable() {
  const { store, vol1FactId } = volumeTwoCarryingVolumeOne("challenge-resolve", { stage: "merge" });
  const evidence = [{ volume: 1, chapter: "ch1", line: 3, quote: "「気にすんな！」" }];

  // Upheld: the original claim stands and the disagreement is withdrawn, not erased.
  const first = store.challengeFact(vol1FactId, { reason: "the line is addressed to 我妻.", evidence });
  assert.ok(first.ok, `the challenge should open: ${first.refusal && first.refusal.because}`);
  assert.strictEqual(store.listChallenges().length, 1, "open disputes are countable, which is what lets the signal reach zero");

  const upheld = store.resolveChallenge(first.challengeId, "uphold");
  assert.ok(upheld.ok, `a challenge can be closed: ${upheld.refusal && upheld.refusal.because}`);
  assert.strictEqual(store.getFact(first.fact.id).status, "retracted", "the challenger is withdrawn, and still in the store");
  assert.strictEqual(store.getFact(vol1FactId).status, "active", "and the target's disputed mark is cleared");
  assert.strictEqual(store.listChallenges().length, 0, "the open-disputes count reaches zero");
  const closedRow = store.listChallenges({ openOnly: false })[0];
  assert.strictEqual(closedRow.outcome, "uphold");
  assert.strictEqual(closedRow.resolved_by_volume, 2, "the resolution is attributed to the volume that made it");
  assert.strictEqual(closedRow.resolved_by_stage, "merge");
  const afterUphold = store.showableFacts(2).rows;
  assert.ok(afterUphold.some((fact) => fact.id === vol1FactId), "the upheld claim is showable again");
  assert.ok(!afterUphold.some((fact) => fact.id === first.fact.id), "the withdrawn one is not");

  // Accepted: the challenger stands, and only now does it supersede.
  const second = store.challengeFact(vol1FactId, { reason: "volume 2 has him drop the line entirely.", evidence });
  assert.ok(second.ok);
  assert.strictEqual(store.getFact(vol1FactId).status, "disputed", "until it is judged, the claim is contested, not replaced");
  const accepted = store.resolveChallenge(second.fact.id, "accept");
  assert.ok(accepted.ok, `a challenge is resolvable by the challenger's own id: ${accepted.refusal && accepted.refusal.because}`);
  assert.strictEqual(store.getFact(second.fact.id).supersedes, vol1FactId, "accepting is what sets the supersession");
  assert.strictEqual(store.getFact(vol1FactId).status, "superseded");
  const afterAccept = store.showableFacts(2).rows;
  assert.ok(afterAccept.some((fact) => fact.id === second.fact.id));
  assert.ok(!afterAccept.some((fact) => fact.id === vol1FactId), "and only now does the target leave the guidance");

  // A challenge may also supersede at the door, when the caller says so.
  const explicit = store.challengeFact(vol1FactId, { reason: "the later book is explicit.", evidence, supersede: true });
  assert.ok(explicit.ok);
  assert.strictEqual(explicit.supersede, true);
  assert.strictEqual(store.getFact(explicit.fact.id).supersedes, vol1FactId, "supersede: true is the stronger claim, made deliberately");

  // A resolution is not re-decided.
  const reDecided = store.resolveChallenge(first.challengeId, "accept");
  assert.strictEqual(reDecided.ok, false);
  assert.strictEqual(reDecided.refusal.rule, "challenge-already-resolved");
  assert.match(reDecided.refusal.because, /already resolved as "uphold"/);
  assert.deepStrictEqual(reDecided.refusal.useInstead, ["challenge_fact"], "and it names the verb that is available");

  // The outcome is a closed list, and an id that is not a challenge is a refusal.
  const nonsense = store.resolveChallenge(second.challengeId, "maybe");
  assert.strictEqual(nonsense.ok, false);
  assert.strictEqual(nonsense.refusal.rule, "challenge-outcome-unknown");
  const nothing = store.resolveChallenge("no-such-challenge", "uphold");
  assert.strictEqual(nothing.ok, false);
  assert.strictEqual(nothing.refusal.rule, "unknown-challenge");

  // Closing a challenge does not count as retracting a claim with nothing replacing it: the
  // integrity query that looks for silent deletions does not fire on a lost challenge.
  const audit = store.integrityFindings();
  assert.deepStrictEqual(
    audit.findings.filter((f) => f.kind === "reference-broken-supersession").map((f) => f.message),
    [],
    "an upheld challenge is a withdrawn claim, not a deleted one"
  );

  store.close();
  console.log("reference-store ownership: a challenge is closed by uphold or accept, and the open count reaches zero");
}

// ─── 9. A sealed volume's cast is frozen: aliases yes, merges no ──────────────

/**
 * Review 05 §3.3. A merge re-points other rows' keys, which is the one operation in this layer
 * that can make published facts quietly disappear. After a volume is published its cast is
 * frozen: linking a spelling to a character is non-destructive and stays available; merging two
 * cast entries is refused.
 */
function scenarioSealedCastIsFrozen() {
  const { store } = volumeTwoCarryingVolumeOne("sealed-cast", { stage: "merge" });

  // Volume 2's own character, with its own published fact.
  store.upsertCast({ key: "ジョーロ", display: "ジョーロ", firstSeenVolume: 2 });
  const nickname = store.insertFact({
    key: "ジョーロ",
    aspect: "catchphrase",
    label: "Catchphrases",
    body: "「任せておけ！」 under his nickname.",
    evidence: [{ volume: 2, chapter: "ch0", line: 3, quote: "駱駝はあとがきに書いた。" }],
  });
  assert.ok(nickname.ok, `the seed row should insert: ${nickname.refusal && nickname.refusal.because}`);
  store.sealVolume(2);

  // An alias is a spelling. It re-points nobody's claims, so sealing does not stop it.
  const alias = store.castAlias("ジョーロ", "キサラギ");
  assert.ok(alias.ok, `linking a spelling after sealing is allowed: ${alias.refusal && alias.refusal.because}`);
  assert.strictEqual(alias.merged, null);
  assert.ok(JSON.parse(store.getCast("ジョーロ").aliases).includes("キサラギ"));

  // A merge would re-point a sealed row onto another character: that rewrites the record a
  // translation was already built from.
  const merge = store.castAlias("如月雨露", "ジョーロ", "the same person");
  assert.strictEqual(merge.ok, false, "a sealed cast entry is not merged");
  assert.strictEqual(merge.refusal.rule, "cast-merge-has-sealed-facts");
  assert.match(merge.refusal.because, /sealed fact/, "and the refusal says which published rows it would have moved");
  assert.strictEqual(store.getCast("ジョーロ").merged_into, null, "nothing moved, and the row proves it");
  assert.strictEqual(store.getFact(nickname.fact.id).key, "ジョーロ", "including the fact it would have re-pointed");
  assert.deepStrictEqual(merge.refusal.useInstead, ["cast_alias on the unsealed volume", "challenge_fact"]);

  store.close();
  console.log("reference-store ownership: a sealed cast takes aliases but not merges");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

const scenarios = [
  scenarioOwnRowsAreEditable,
  scenarioAnotherVolumesRowIsUntouchable,
  scenarioStageScope,
  scenarioSealingClosesTheWindow,
  scenarioChallengeIsTheOnlyDoor,
  scenarioCastMergeIsRecorded,
  scenarioImportedRowsAreOwnedByTheImport,
  scenarioChallengesAreClosable,
  scenarioSealedCastIsFrozen,
];

try {
  for (const scenario of scenarios) scenario();
  console.log(`reference-store ownership test passed (${scenarios.length} scenarios).`);
} catch (err) {
  console.error(`reference-store ownership test failed: ${err && err.message}`);
  if (err && err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
  process.exitCode = 1;
}

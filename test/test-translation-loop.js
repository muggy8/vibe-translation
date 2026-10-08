/**
 * test-translation-loop.js — the translation QA loop's contract, on real files.
 *
 * The pure helpers (qaLoopDecision, worthRetranslating, the QA gates) are pinned in
 * test-translate.js. What lives HERE is the part that only exists on disk: the
 * three guarantees about the text the pipeline actually publishes.
 *
 *   1. THE RATCHET — a chapter may only move forward through the loop. A
 *      retranslate that scores WORSE than the draft it replaced is rolled back to
 *      the better draft (which is kept on disk as translation-<id>.best.md), and
 *      the verification sidecar is re-pointed at that draft's own verdict so the
 *      next batch does not pay to re-grade identical text.
 *   2. THE PUBLISH GATE — a chapter that did not pass verification is published
 *      WITH A VISIBLE MARKER inside translation.md (the reader is told), and a
 *      chapter with no text at all is reported as missing rather than silently
 *      absent from the volume.
 *   3. THE VALUE FILTER — a chapter that missed the passing line by a hair on
 *      cosmetic findings only is not worth burning a whole chapter of generation
 *      for; a HIGH finding or a deterministic failure always is.
 *
 * No network, no real endpoint. Run with `npm test` (or standalone:
 * `node test/test-translation-loop.js`).
 */
const assert = require("assert");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const os = require("os");

const {
  sha256,
  STATE_FILE,
  VERIFICATION_FILE,
  MERGED_FILE,
  chapterArtifactNames,
  loadTranslationState,
  saveTranslationState,
  loadVerificationSidecar,
  saveVerificationSidecar,
  recordBestDraft,
  applyDraftRatchet,
  unverifiedMarker,
  verdictCoversCurrentDraft,
  worthRetranslating,
  qaLoopDecision,
  loadVolumeReferences,
  parseVolumeFindings,
  findingsForChapter,
  volumeFindingsText,
  retranslateTarget,
  planConsistencyWindows,
} = require("../utils/translate");
const { mergeVolumeTranslationFiles } = require("../translate");

const PASSING = 70;

/**
 * A temp volume folder holding one chapter's worth of artifacts.
 *
 * @param {Array<{id: string, title?: string}>} segments
 * @returns {Promise<{volumeDir: string, bundle: {segments: Array<Object>}}>}
 */
async function makeVolume(segments) {
  const volumeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ai-client-loop-"));
  const bundle = {
    format: "txt",
    segments: segments.map((s) => ({ id: s.id, title: s.title || s.id, file: `src-${s.id}.md` })),
    wholeChars: 100,
    sourceFingerprint: "fp-loop",
  };
  for (const seg of bundle.segments) {
    await fs.writeFile(path.join(volumeDir, seg.file), `# ${seg.title}\n\nSource text of ${seg.id}.\n`, "utf8");
  }
  return { volumeDir, bundle };
}

/**
 * Write one chapter's draft (+ optional best-draft restore point and polished
 * text) and register it in the state / verification sidecar.
 *
 * @param {string} volumeDir
 * @param {Object} spec - {id, draft, best?, polished?, score, pass, sourceHash?, draftHash?, extra?}
 * @returns {Promise<Object>} The state entry that was written.
 */
async function putChapter(volumeDir, spec) {
  const { draftFile, bestFile, polishedFile } = chapterArtifactNames(spec.id);
  await fs.writeFile(path.join(volumeDir, draftFile), spec.draft, "utf8");
  if (typeof spec.best === "string") await fs.writeFile(path.join(volumeDir, bestFile), spec.best, "utf8");
  if (typeof spec.polished === "string") await fs.writeFile(path.join(volumeDir, polishedFile), spec.polished, "utf8");

  const statePath = path.join(volumeDir, STATE_FILE);
  const state = await loadTranslationState(statePath);
  state.chapters[spec.id] = {
    sourceHash: spec.sourceHash || "src-hash",
    contextHash: "ctx-hash",
    draftHash: sha256(spec.draft),
    retranslated: false,
    findingsHash: null,
    polishedDraftHash: spec.polishedDraftHash ?? null,
    ...(spec.extra || {}),
  };
  await saveTranslationState(statePath, state);

  const sidecarPath = path.join(volumeDir, VERIFICATION_FILE);
  const sidecar = await loadVerificationSidecar(sidecarPath);
  sidecar.chapters[spec.id] = {
    sourceHash: spec.sourceHash || "src-hash",
    draftHash: sha256(spec.draft),
    score: spec.score,
    pass: spec.pass,
    findings: spec.findings || "",
    reason: spec.reason || (spec.pass ? "verified" : "the verifier scored it below the passing threshold"),
    ...(spec.verdictExtra || {}),
  };
  await saveVerificationSidecar(sidecarPath, sidecar);
  return state.chapters[spec.id];
}

// ─── 1. The draft ratchet ────────────────────────────────────────────────────

async function scenarioRatchet() {
  const { volumeDir, bundle } = await makeVolume([{ id: "ch1", title: "One" }, { id: "ch2", title: "Two" }]);

  // ch1: the loop retranslated it and the NEW draft scored worse (50) than the
  // old one (75). The better text is still on disk as the restore point.
  const betterText = "The better draft of chapter one.\n";
  const worseText = "The worse draft of chapter one.\n";
  await putChapter(volumeDir, {
    id: "ch1",
    draft: worseText,
    best: betterText,
    score: 50,
    pass: false,
    extra: { bestScore: 75, bestDraftHash: sha256(betterText), bestVerdict: { score: 75, pass: true } },
  });
  // ch2: the newest draft IS the best one — the ratchet must leave it alone.
  const goodText = "A draft that scored well.\n";
  await putChapter(volumeDir, {
    id: "ch2",
    draft: goodText,
    best: goodText,
    score: 88,
    pass: true,
    extra: { bestScore: 88, bestDraftHash: sha256(goodText) },
  });

  const result = await applyDraftRatchet(volumeDir, bundle);
  assert.strictEqual(result.restored, 1, `only the regressed chapter is rolled back: ${JSON.stringify(result)}`);
  assert.deepStrictEqual(result.noImprovement, ["ch1"], "the rolled-back chapters are reported (the loop's stall signal)");

  const { draftFile: ch1Draft } = chapterArtifactNames("ch1");
  const restored = await fs.readFile(path.join(volumeDir, ch1Draft), "utf8");
  assert.strictEqual(restored, betterText, "the BETTER draft is what the volume now holds");

  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  assert.strictEqual(state.chapters.ch1.draftHash, sha256(betterText), "the state follows the restored text");
  assert.strictEqual(state.chapters.ch1.noImprovement, true, "the chapter is flagged so the loop can call the round a no-improvement one");
  assert.strictEqual(state.chapters.ch1.qaFailed, false, "a restored draft is not a QA failure");
  assert.strictEqual(state.chapters.ch1.polishedDraftHash, null, "any polish built on the rejected draft is invalidated");
  assert.strictEqual(state.chapters.ch2.noImprovement, undefined, "a chapter that did not regress is untouched");

  // The sidecar is re-pointed at the restored draft's OWN verdict, so the next
  // verify batch skips it instead of paying to re-grade identical text.
  const sidecar = await loadVerificationSidecar(path.join(volumeDir, VERIFICATION_FILE));
  assert.strictEqual(sidecar.chapters.ch1.score, 75, "the verdict that belongs to the restored text is the one on record");
  assert.strictEqual(sidecar.chapters.ch1.draftHash, sha256(betterText), "and it covers the draft that is actually on disk");
  assert.strictEqual(verdictCoversCurrentDraft(sidecar.chapters.ch1, state.chapters.ch1), true, "so the chapter is a verify skip next round");

  // Running the ratchet again changes nothing (it is idempotent).
  const again = await applyDraftRatchet(volumeDir, bundle);
  assert.strictEqual(again.restored, 0, "a second pass restores nothing — the chapter is already its best draft");

  fsSync.rmSync(volumeDir, { recursive: true, force: true });
}

// ─── 1b. The ratchet refuses to invent a restore ─────────────────────────────

async function scenarioRatchetRefusals() {
  const { volumeDir, bundle } = await makeVolume([{ id: "ch1", title: "One" }]);

  // The recorded best draft is not on disk: keep the current one (a ratchet that
  // restored from a missing file would publish nothing).
  await putChapter(volumeDir, {
    id: "ch1",
    draft: "Current draft.\n",
    score: 40,
    pass: false,
    extra: { bestScore: 90, bestDraftHash: sha256("text that was never written to disk") },
  });
  const missing = await applyDraftRatchet(volumeDir, bundle);
  assert.strictEqual(missing.restored, 0, "a best draft that is not on disk is not restored");
  const { draftFile } = chapterArtifactNames("ch1");
  assert.strictEqual(await fs.readFile(path.join(volumeDir, draftFile), "utf8"), "Current draft.\n", "the current draft survives");

  // The file on disk no longer matches its recorded hash (someone edited it): the
  // restore point is untrustworthy, so it is not used.
  const other = await makeVolume([{ id: "ch1", title: "One" }]);
  const tampered = "Tampered text.\n";
  await putChapter(other.volumeDir, {
    id: "ch1",
    draft: "Current draft.\n",
    best: tampered,
    score: 40,
    pass: false,
    extra: { bestScore: 90, bestDraftHash: sha256("the original better text") },
  });
  const tamperedResult = await applyDraftRatchet(other.volumeDir, other.bundle);
  assert.strictEqual(tamperedResult.restored, 0, "a restore point that does not match its hash is refused");
  const tamperedDraft = await fs.readFile(path.join(other.volumeDir, chapterArtifactNames("ch1").draftFile), "utf8");
  assert.strictEqual(tamperedDraft, "Current draft.\n", "and the current draft is kept rather than the unverified one");

  fsSync.rmSync(volumeDir, { recursive: true, force: true });
  fsSync.rmSync(other.volumeDir, { recursive: true, force: true });
}

// ─── 1c. recordBestDraft (the verify task's half of the ratchet) ─────────────

async function scenarioRecordBestDraft() {
  const { volumeDir } = await makeVolume([{ id: "ch1", title: "One" }]);
  const draft = "A draft worth keeping.\n";
  await putChapter(volumeDir, { id: "ch1", draft, score: 74, pass: true });

  const first = await recordBestDraft(volumeDir, "ch1", {
    score: 74,
    pass: true,
    findings: "",
    sourceHash: "src-hash",
    draftHash: sha256(draft),
  });
  assert.strictEqual(first, true, "the first verdict becomes the best draft");
  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  assert.strictEqual(state.chapters.ch1.bestScore, 74);
  const { bestFile } = chapterArtifactNames("ch1");
  assert.strictEqual(await fs.readFile(path.join(volumeDir, bestFile), "utf8"), draft, "the restore point is a copy of the draft");

  // A worse verdict does not replace it (the ratchet only ever improves).
  const worse = await recordBestDraft(volumeDir, "ch1", { score: 51, pass: false, findings: "", sourceHash: "src-hash", draftHash: "d2" });
  assert.strictEqual(worse, false, "a worse score does not become the best draft");
  // An equal score does not either (no pointless re-copying).
  const equal = await recordBestDraft(volumeDir, "ch1", { score: 74, pass: true, findings: "", sourceHash: "src-hash", draftHash: "d3" });
  assert.strictEqual(equal, false, "an equal score keeps the existing restore point");

  fsSync.rmSync(volumeDir, { recursive: true, force: true });
}

// ─── 2. The publish gate ─────────────────────────────────────────────────────

async function scenarioPublishGate() {
  const { volumeDir, bundle } = await makeVolume([
    { id: "ch1", title: "Passed" },
    { id: "ch2", title: "Failed" },
    { id: "ch3", title: "Missing" },
    { id: "ch4", title: "Polished" },
  ]);

  await putChapter(volumeDir, { id: "ch1", draft: "Chapter one, verified.\n", score: 91, pass: true });
  await putChapter(volumeDir, {
    id: "ch2",
    draft: "Chapter two, rejected.\n",
    score: 57,
    pass: false,
    reason: "omits the second sentence of the source",
  });
  // ch3 has no draft file at all.
  await putChapter(volumeDir, { id: "ch3", draft: "", score: null, pass: null });
  await fs.rm(path.join(volumeDir, chapterArtifactNames("ch3").draftFile), { force: true });
  // ch4: polished text exists, and the state says it was produced from the CURRENT draft.
  await putChapter(volumeDir, {
    id: "ch4",
    draft: "Chapter four draft.\n",
    polished: "Chapter four, polished.\n",
    polishedDraftHash: sha256("Chapter four draft.\n"),
    score: 80,
    pass: true,
  });

  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  const merged = await mergeVolumeTranslationFiles(volumeDir, bundle, state, {
    sourceLanguage: "Japanese",
    targetLanguage: "English",
  });

  // A verified chapter is published clean.
  assert.ok(merged.text.includes("Chapter one, verified."), "a passing chapter is published");
  assert.ok(!merged.text.includes("UNVERIFIED** — this chapter did not pass") || merged.text.indexOf("UNVERIFIED") > merged.text.indexOf("Chapter one"), "the marker is not attached to a passing chapter");

  // A failed chapter is published, but the reader is TOLD, inline, in the file
  // they actually read (quarantining it out of the volume loses the book).
  assert.ok(merged.text.includes("Chapter two, rejected."), "a failing chapter is still published");
  const markerIndex = merged.text.indexOf("⚠ UNVERIFIED");
  const failedIndex = merged.text.indexOf("Chapter two, rejected.");
  assert.ok(markerIndex >= 0, "the published volume carries the UNVERIFIED marker");
  assert.ok(markerIndex < failedIndex, "the marker sits ABOVE the text it is warning about");
  assert.ok(merged.text.includes("verification score 57/100"), "and names the score");
  assert.ok(merged.text.includes("omits the second sentence"), "and the reason");

  // A chapter with no text is reported, not silently absent.
  assert.deepStrictEqual(merged.missing.map((m) => m.id), ["ch3"], "the chapter with no text is reported as missing");

  // Polished text wins only when it was produced from the current draft.
  assert.ok(merged.text.includes("Chapter four, polished."), "accepted polish is published");
  assert.ok(!merged.text.includes("Chapter four draft."), "and it replaces the draft it was verified against");

  assert.deepStrictEqual(
    merged.unverified.map((u) => u.id),
    ["ch2"],
    "the unverified chapters are returned for the run summary"
  );

  fsSync.rmSync(volumeDir, { recursive: true, force: true });
}

// ─── 2b. Stale polish must not be published ──────────────────────────────────

async function scenarioStalePolish() {
  const { volumeDir, bundle } = await makeVolume([{ id: "ch1", title: "One" }]);
  // The polish file exists, but the draft was retranslated AFTER it was made
  // (polishedDraftHash points at the old draft) — the stale polish is not the
  // verified text and must not ship.
  await putChapter(volumeDir, {
    id: "ch1",
    draft: "The fresh retranslated draft.\n",
    polished: "The stale polish of an older draft.\n",
    polishedDraftHash: sha256("a draft that no longer exists"),
    score: 78,
    pass: true,
  });
  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  const merged = await mergeVolumeTranslationFiles(volumeDir, bundle, state, {
    sourceLanguage: "Japanese",
    targetLanguage: "English",
  });
  assert.ok(merged.text.includes("The fresh retranslated draft."), "the current draft is published");
  assert.ok(!merged.text.includes("stale polish"), "the stale polished file is not");

  fsSync.rmSync(volumeDir, { recursive: true, force: true });
}

// ─── 3. The retranslation value filter ───────────────────────────────────────

function scenarioValueFilter() {
  // A HIGH finding is a meaning / fidelity / terminology problem: always rewrite.
  assert.strictEqual(
    worthRetranslating({ score: 69, findings: "[HIGH] omits the protagonist's reply" }, PASSING),
    true,
    "a HIGH finding justifies a full re-translation even one point under the line"
  );
  // A deterministic QA failure (residue / truncation / empty) is never cosmetic.
  assert.strictEqual(worthRetranslating({ score: 69, deterministic: true, findings: "" }, PASSING), true);
  // An unparseable score carries no information: retry it.
  assert.strictEqual(worthRetranslating({ score: null, findings: "" }, PASSING), true);
  // A hair under the line on MEDIUM/LOW findings only is a copy-edit, not a
  // re-translation: the fresh pass can introduce new errors while fixing a nit.
  assert.strictEqual(
    worthRetranslating({ score: 68, findings: "[LOW] awkward phrasing in paragraph 3" }, PASSING),
    false,
    "a cosmetic near-miss is not worth a whole chapter of generation"
  );
  // Well under the line, even with only MEDIUM findings, is a real problem.
  assert.strictEqual(
    worthRetranslating({ score: 40, findings: "[MEDIUM] tense drift" }, PASSING),
    true,
    "a chapter that missed badly is retranslated whatever the finding bands"
  );
  // The margin is tunable: with a margin of 0 every FAIL is worth a rewrite.
  assert.strictEqual(worthRetranslating({ score: 69, findings: "[LOW] nit" }, PASSING, 0), true);

  // The stop-decision matrix (the loop's whole brain, pinned end to end).
  const d = (p) => qaLoopDecision({ maxRounds: 3, ...p });
  assert.deepStrictEqual(d({ phase: "after-verify", round: 1, failed: 0, noDraft: 0 }), { stop: true, reason: "all-pass" });
  assert.deepStrictEqual(
    d({ phase: "after-verify", round: 1, failed: 0, noDraft: 4 }),
    { stop: true, reason: "missing-drafts" },
    "an untranslated volume is never reported as all-pass"
  );
  assert.deepStrictEqual(
    d({ phase: "after-verify", round: 1, failed: 2, noImprovement: 2 }),
    { stop: true, reason: "no-improvement" },
    "every FAIL rolled back by the ratchet means the next round would repeat the same damage"
  );
  assert.deepStrictEqual(
    d({ phase: "after-verify", round: 1, failed: 3, noImprovement: 2 }),
    { stop: false, reason: null },
    "FAILs that were NOT rolled back are still worth a round"
  );
  assert.deepStrictEqual(
    d({ phase: "after-verify", round: 1, failed: 1, noDraft: 2 }),
    { stop: false, reason: null },
    "a missing chapter does not stop a round that can still fix another one"
  );
  assert.deepStrictEqual(d({ phase: "after-verify", round: 3, failed: 1 }), { stop: true, reason: "round-limit" });
  assert.deepStrictEqual(d({ phase: "after-retranslate", round: 1, retranslated: 0 }), { stop: true, reason: "stalled" });
  assert.deepStrictEqual(d({ phase: "after-retranslate", round: 1, retranslated: 2 }), { stop: false, reason: null });
  assert.throws(() => d({ phase: "nonsense" }), /unknown phase/, "an unknown phase fails loudly");
}

// ─── 4a. The cross-chapter audit: parsing, windowing, and what it targets ────

{
  const ids = ["ch1", "ch2", "ch2.1", "ch10"];
  const reply = [
    "FINDING [HIGH] chapters=ch2,ch10 — the same organization is rendered two ways",
    "  Where: \"the Blacksteel Workshop\"",
    "  Contradicts: \"the Black Steel workshop\"",
    "  Fix: use \"Blacksteel Workshop\" everywhere",
    "",
    "FINDING [MEDIUM] chapters=ch2.1 — tense shifts to present inside a flashback",
    "  Where: \"She walks to the door\"",
    "  Contradicts: \"She had walked to the door\"",
    "  Fix: keep the past tense used by the surrounding chapters",
    "",
    "FINDING [LOW] chapters=ch99 — names a chapter that was never provided",
    "  Where: \"a\"",
    "  Contradicts: \"b\"",
    "  Fix: n/a",
  ].join("\n");

  const parsed = parseVolumeFindings(reply, ids);
  assert.strictEqual(parsed.length, 3, "every finding block is parsed");
  assert.deepStrictEqual(parsed[0].chapters, ["ch2", "ch10"], "both sides of the contradiction are named");
  assert.strictEqual(parsed[0].severity, "HIGH");
  assert.strictEqual(parsed[0].quote, "the Blacksteel Workshop", "both sides are quoted verbatim");
  assert.strictEqual(parsed[0].contradicts, "the Black Steel workshop");
  assert.strictEqual(parsed[0].fix, 'use "Blacksteel Workshop" everywhere');
  assert.strictEqual(parsed[0].untagged, false);

  // ch2 must NOT claim ch2.1 (and vice versa): the ids are matched whole.
  assert.deepStrictEqual(parsed[1].chapters, ["ch2.1"], "an interlude id is not confused with its chapter");

  // A finding that names a chapter the pass never sent is recorded but flagged
  // unfixable, rather than silently attached to the wrong chapter.
  assert.deepStrictEqual(parsed[2].chapters, [], "an invented chapter id is not accepted");
  assert.strictEqual(parsed[2].untagged, true, "and it is flagged as not actionable");

  assert.deepStrictEqual(parseVolumeFindings("(no findings)", ids), [], "a clean volume parses to nothing");
  assert.deepStrictEqual(parseVolumeFindings("", ids), []);
  assert.deepStrictEqual(parseVolumeFindings(null, ids), []);

  // The findings a chapter is repaired for, and the text the corrector sees.
  const forCh2 = findingsForChapter(parsed, "ch2");
  assert.strictEqual(forCh2.length, 1, "only the finding that names ch2");
  assert.strictEqual(forCh2[0].homeChapter, "ch2", "the chapter knows it is one side of the pair");
  const task = volumeFindingsText(forCh2);
  assert.ok(task.includes("Cross-chapter problems found in this volume"), "the corrector is told what these are");
  assert.ok(task.includes("also involves: ch10"), "and which side it is NOT allowed to rewrite");
  assert.strictEqual(volumeFindingsText([]), "", "nothing to fix → no task line");

  // What the retranslate pass does with a chapter, given both kinds of verdict.
  assert.strictEqual(retranslateTarget({ pass: true, score: 92 }, []).action, "skip", "a clean pass is left alone");
  assert.strictEqual(
    retranslateTarget({ pass: true, score: 92 }, [{ severity: "HIGH" }]).action,
    "cross-chapter",
    "a HIGH contradiction makes even a 92-scoring chapter a repair target"
  );
  assert.strictEqual(
    retranslateTarget({ pass: true, score: 92 }, [{ severity: "MEDIUM" }]).action,
    "skip",
    "a MEDIUM drift note does not spend a whole chapter of generation on a passing chapter"
  );
  assert.strictEqual(retranslateTarget({ pass: false, score: 55 }, []).action, "fail");
  assert.strictEqual(retranslateTarget(undefined, [{ severity: "HIGH" }]).action, "none", "no verdict covers this draft — verify first");

  // Windowing: a volume bigger than the auditor's window is split into
  // consecutive windows, and a chapter that alone exceeds it is flagged.
  //
  // The sizes are chosen against the CALIBRATED estimate (utils/tokens.js): a
  // 4,000-character Latin chapter estimates at ceil(4000 × 0.25 × 1.10) + 40 =
  // 1,140 tokens, so three of them fit the 20,000 − 16,000 = 4,000-token budget
  // and the fourth does not. (Under the old 0.35-per-char coefficients the same
  // fixture packed two per window — the packing changed because the estimate got
  // accurate, which is the point of the change.)
  const chapters = [
    { id: "ch1", text: "a".repeat(4000) },
    { id: "ch2", text: "b".repeat(4000) },
    { id: "ch3", text: "c".repeat(4000) },
    { id: "ch4", text: "d".repeat(4000) },
    { id: "ch5", text: "e".repeat(4000) },
    { id: "ch6", text: "f".repeat(4000) },
    { id: "ch7", text: "g".repeat(400000) },
  ];
  const windows = planConsistencyWindows(chapters, { maxTokens: 20000, reserve: 16000 });
  assert.strictEqual(windows.length, 3, `the volume is split rather than dropped: ${windows.length} window(s)`);
  assert.deepStrictEqual(
    windows[0].chapters.map((c) => c.id),
    ["ch1", "ch2", "ch3"],
    "consecutive chapters stay together (that is the point)"
  );
  assert.deepStrictEqual(
    windows[1].chapters.map((c) => c.id),
    ["ch4", "ch5", "ch6"],
    "the split is a real packing decision, not one chapter per window"
  );
  assert.ok(windows.some((w) => w.oversized && w.chapters[0].id === "ch7"), "a chapter larger than the whole window is flagged, not silently skipped");
  const flat = windows.flatMap((w) => w.chapters.map((c) => c.id));
  assert.deepStrictEqual(flat, ["ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7"], "windowing loses no chapter and keeps reading order");
}

// ─── 4b. The cross-chapter pass, end to end on real files ────────────────────

async function scenarioVolumeConsistencyPass() {
  const { volumeDir, bundle } = await makeVolume([
    { id: "ch1", title: "The Workshop" },
    { id: "ch2", title: "The Offer" },
  ]);
  // Two chapters, each published with a DIFFERENT rendering of the same name —
  // the exact defect a per-chapter verifier cannot see (each chapter is
  // internally consistent).
  await putChapter(volumeDir, { id: "ch1", draft: "He signed at the Blacksteel Workshop.\n", score: 91, pass: true });
  await putChapter(volumeDir, { id: "ch2", draft: "The Black Steel workshop offered more.\n", score: 88, pass: true });

  const harness = require("../harness");
  const original = harness.runOneShot;
  let seen = null;
  harness.runOneShot = async (cfg) => {
    seen = cfg;
    // A canned auditor reply in the contract's own shape, naming both chapters.
    return [
      "FINDING [HIGH] chapters=ch1,ch2 — the same workshop is rendered two ways",
      "  Where: \"He signed at the Blacksteel Workshop\"",
      "  Contradicts: \"The Black Steel workshop offered more\"",
      "  Fix: render the name as \"Blacksteel Workshop\" in both chapters",
    ].join("\n");
  };
  try {
    const { runVolumeConsistencyPass } = require("../verify-translate");
    const { loadVolumeConsistency, VOLUME_CONSISTENCY_FILE, VOLUME_CONSISTENCY_REPORT } = require("../utils/translate");
    const systemPrompt = await fs.readFile(path.join(__dirname, "..", "system-prompts", "volume-consistency.md"), "utf8");
    const template = await fs.readFile(path.join(__dirname, "..", "user-prompts", "volume-consistency.md"), "utf8");

    const res = await runVolumeConsistencyPass({
      volume: { installmentNumber: "02", folder: "Book(02)" },
      volumeDir,
      bundle,
      refs: { glossaryText: "| 黒鋼工房 | Blacksteel Workshop | the workshop |", styleRules: "- Keep organization names identical.", contextHash: "ctx-1" },
      systemPrompt,
      template,
      auditEndpoint: { model: "local", contextWindow: 32000, maxTokens: 4000 },
      prevTail: "",
      force: false,
    });

    assert.strictEqual(res.windows, 1, "a small volume is audited as one document");
    assert.strictEqual(res.findings.length, 1, "the contradiction is found");
    assert.deepStrictEqual(res.findings[0].chapters, ["ch1", "ch2"], "and BOTH chapters are named");
    assert.strictEqual(res.findings[0].severity, "HIGH");

    // The prompt the auditor actually received: both chapters, in reading order,
    // each labelled with the id it must cite.
    assert.ok(seen, "the audit call was made");
    assert.ok(seen.messages[0].text.includes("--- CHAPTER ch1: The Workshop ---"), "chapter 1 is in the prompt under its id");
    assert.ok(seen.messages[0].text.includes("--- CHAPTER ch2: The Offer ---"), "chapter 2 too");
    assert.ok(seen.messages[0].text.indexOf("CHAPTER ch1") < seen.messages[0].text.indexOf("CHAPTER ch2"), "in reading order");
    assert.ok(seen.messages[0].text.includes("Blacksteel Workshop"), "the glossary is injected (a terminology finding needs it)");
    assert.ok(seen.messages[0].text.includes("Keep organization names identical"), "so are the style rules");
    assert.strictEqual(seen.systemPrompt, systemPrompt, "the auditor runs on its own system prompt, not the verifier's");

    // Sidecar + report on disk, and the idempotency key.
    const sidecar = await loadVolumeConsistency(volumeDir);
    assert.strictEqual(sidecar.findings.length, 1, "the findings are persisted for the retranslate pass");
    assert.ok(sidecar.findingsHash, "with a hash the stall guard can compare");
    assert.ok(sidecar.volumeHash && sidecar.contextHash === "ctx-1", "and the keys that decide whether a re-run must re-audit");
    const report = await fs.readFile(path.join(volumeDir, VOLUME_CONSISTENCY_REPORT), "utf8");
    assert.ok(report.includes("ch1, ch2"), "the report names the chapters");
    assert.ok(report.includes("Blacksteel Workshop"), "and quotes both sides");

    // Re-running with nothing changed does not spend another call.
    const callsBefore = seen;
    const again = await runVolumeConsistencyPass({
      volume: { installmentNumber: "02", folder: "Book(02)" },
      volumeDir,
      bundle,
      refs: { glossaryText: "| 黒鋼工房 | Blacksteel Workshop | the workshop |", styleRules: "- Keep organization names identical.", contextHash: "ctx-1" },
      systemPrompt,
      template,
      auditEndpoint: { model: "local", contextWindow: 32000, maxTokens: 4000 },
      prevTail: "",
      force: false,
    });
    assert.strictEqual(again.skipped, "already audited for this volume text and reference state", "a re-run is a skip");
    assert.strictEqual(seen, callsBefore, "and costs no model call");
    assert.deepStrictEqual(again.findings.map((f) => f.chapters), [["ch1", "ch2"]], "the recorded findings still come back");

    // A changed reference state invalidates it (the safe direction).
    const invalidated = await runVolumeConsistencyPass({
      volume: { installmentNumber: "02", folder: "Book(02)" },
      volumeDir,
      bundle,
      refs: { glossaryText: "| 黒鋼工房 | Blacksteel Works | the workshop |", styleRules: "- Keep organization names identical.", contextHash: "ctx-2" },
      systemPrompt,
      template,
      auditEndpoint: { model: "local", contextWindow: 32000, maxTokens: 4000 },
      prevTail: "",
      force: false,
    });
    assert.strictEqual(invalidated.skipped, null, "a new glossary re-audits the volume");

    assert.ok(fsSync.existsSync(path.join(volumeDir, VOLUME_CONSISTENCY_FILE)), "the sidecar file exists");
    void original;
  } finally {
    harness.runOneShot = original;
    fsSync.rmSync(volumeDir, { recursive: true, force: true });
  }
}

// ─── 4c. Targeted correction: one bad sentence must not re-translate a chapter ─

async function scenarioTargetedRepair() {
  const { volumeDir, bundle } = await makeVolume([{ id: "ch1", title: "Night Shift" }]);

  const source = [
    "研究所は静かだった。",
    "七番基板の温度が基準値を超えている。正常な過熱ではない。",
    "ソラは平静に言った。",
    "黒鋼は飛び起きた。",
    "そして沈黙が続いた。",
  ].join("\n\n");
  const draft = [
    "The laboratory was quiet.",
    "The seventh board's temperature exceeded the baseline.",
    "Sora said calmly.",
    "Kurogane jumped up.",
    "Then the silence went on.",
  ].join("\n\n");
  await fs.writeFile(path.join(volumeDir, "src-ch1.md"), source + "\n", "utf8");

  // Two findings: one about paragraph 2 (locatable), one chapter-wide (no quote).
  const findings = [
    "## Findings",
    '1. [HIGH] the negation is omitted',
    '   - Source: "正常な過熱ではない。"',
    '   - Translation: "exceeded the baseline"',
    '   - Fix: render the second sentence too',
    "",
    '2. [MEDIUM] the register is too formal throughout (no span quoted)',
  ].join("\n");

  const harness = require("../harness");
  const original = harness.runOneShot;
  const calls = [];
  harness.runOneShot = async (cfg) => {
    calls.push(cfg);
    // The model is handed ONE paragraph of source and returns its correction.
    return "The seventh board's temperature exceeded the baseline — and this was not normal overheating.";
  };

  try {
    const { runTargetedRepair } = require("../retranslate");
    const { planTargetedRepair, paragraphBlocks } = require("../utils/translate");
    const template = await fs.readFile(path.join(__dirname, "..", "user-prompts", "translate.md"), "utf8");

    const plan = planTargetedRepair({ sourceText: source, draftText: draft, findingsText: findings });
    assert.strictEqual(plan.usable, true, plan.reason);

    const promptDrops = [];
    const stitched = await runTargetedRepair({
      volume: { installmentNumber: "01" },
      seg: { id: "ch1" },
      plan,
      sourceText: source,
      draft,
      endpoint: { model: "local", baseUrl: "http://127.0.0.1:1/v1", contextWindow: 32000, maxTokens: 4000 },
      template,
      sampling: { temperature: 0.7, topP: 1, topK: -1, repetitionPenalty: 1 },
      thinkingMode: "no_think",
      roleWindow: 32000,
      outputReserve: 4000,
      targetLanguage: "English",
      refs: { background: "", styleRules: "", voiceNotes: "" },
      chapterTerms: { lines: [] },
      cue: { text: "", source: "" },
      promptDrops,
    });

    assert.strictEqual(calls.length, 1, `ONE passage call, not a whole chapter: ${calls.length}`);
    const prompt = calls[0].messages[0].text;
    // The model sees ONLY the paragraph it is correcting…
    assert.ok(prompt.includes("七番基板の温度が基準値を超えている。正常な過熱ではない。"), "the affected source span is in the prompt");
    assert.ok(!prompt.includes("研究所は静かだった。"), "the untouched paragraphs are NOT sent as source to be re-translated");
    // …with the neighbouring TRANSLATED text as the seam it must match…
    assert.ok(prompt.includes("The laboratory was quiet."), "the preceding draft text is given as context");
    assert.ok(prompt.includes("Sora said calmly."), "and the following draft text too");
    assert.ok(prompt.includes("第 1 个片段（共 1 个）"), "and it is told this is a passage correction, not a chapter translation");
    // …and only the finding that belongs to this passage, plus the chapter-wide one.
    assert.ok(prompt.includes("the negation is omitted"), "the passage's own finding is injected");
    assert.ok(prompt.includes("register is too formal"), "a finding with no locatable span is not silently dropped");

    assert.ok(stitched.includes("The laboratory was quiet."), "the stitched draft keeps the paragraph before");
    assert.ok(stitched.includes("Sora said calmly."), "keeps the paragraph after");
    assert.ok(stitched.includes("not normal overheating"), "and carries the correction");
    assert.strictEqual(paragraphBlocks(stitched).length, 5, "no paragraph was lost or duplicated by the stitch");
    assert.strictEqual(paragraphBlocks(stitched)[3], "Kurogane jumped up.", "an untouched paragraph is byte-for-byte identical");

    void bundle;
    void volumeDir;
    void promptDrops;
  } finally {
    harness.runOneShot = original;
    fsSync.rmSync(volumeDir, { recursive: true, force: true });
  }
}

// ─── 4. The marker's own contract ────────────────────────────────────────────

function scenarioMarkerContract() {
  const marker = unverifiedMarker({ score: 57, pass: false, reason: "terminology drift" });
  assert.ok(marker.startsWith("> **⚠ UNVERIFIED**"), "the marker is a visible blockquote, not a comment");
  assert.ok(marker.includes("57/100") && marker.includes("terminology drift"));
  assert.ok(unverifiedMarker({ score: null, pass: false, reason: "not verified" }).includes("no verification score"));
}

// ─── Entry point ─────────────────────────────────────────────────────────────

(async () => {
  await scenarioRatchet();
  await scenarioRatchetRefusals();
  await scenarioRecordBestDraft();
  await scenarioPublishGate();
  await scenarioStalePolish();
  await scenarioVolumeConsistencyPass();
  await scenarioTargetedRepair();
  scenarioValueFilter();
  scenarioMarkerContract();
  console.log("translation-loop: all checks passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * test-artifact-integrity.js — the guarantees that only exist on a LIVE path.
 *
 * Two run-killing crashes were invisible to every pure test and every dry run,
 * because the code they live in runs only after the model work is done (gotcha
 * 49):
 *   - polish's Phase B commit used a language pair Phase A never handed it
 *     (`sourceLanguage is not defined`) — on every volume of every run;
 *   - verify-translate's commit phase used the merged-volume file name without
 *     importing it (`MERGED_FILE is not defined`) — after the whole verify loop
 *     had already been paid for.
 * Both phases are run here for real, on real temp files, with NO model call:
 * these are the commit phases, so stubbing nothing is what makes the test
 * honest — a ReferenceError is exactly what a live run hit.
 *
 * The third block proves the file tools an agent is handed can actually read the
 * cumulative artifacts. The library's default line cap (2000 characters) cut a
 * compiled character-voice reference's entries in half — an author agent could
 * not read what it was required to preserve, and one such turn ended by replying
 * in chat about splitting the long lines, and that reply became the artifact.
 *
 * No network, no endpoint. Run with `npm test` (or standalone:
 * `node test/test-artifact-integrity.js`).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const harness = require("../harness");
const { commitVerificationVolume } = require("../verify-translate");
const { finishPolishVolume } = require("../polish");
const {
  chapterArtifactNames,
  loadTranslationState,
  saveTranslationState,
  sha256,
  STATE_FILE,
  MERGED_FILE,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
  POLISH_QA_REPORT,
} = require("../utils/translate");

const volume = { folder: "Series(01)", installmentNumber: "01" };

/** A temp series root holding one volume folder. */
function makeVolumeDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-integrity-"));
  const volumeDir = path.join(root, "Series(01)");
  fs.mkdirSync(volumeDir, { recursive: true });
  return { root, volumeDir };
}

/** @param {string} root */
function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* temp dir — best effort */
  }
}

// ─── 1. verify-translate's commit phase runs end to end ──────────────────────

/**
 * `commitVerificationVolume` is the phase that runs AFTER the per-chapter verify
 * loop: it rebuilds the rows from the sidecar, records the ratchet's restore
 * point, runs the deterministic rendering-variant scan against the text the
 * volume actually publishes, and writes the report. It used to die on the first
 * line of that scan — `MERGED_FILE is not defined` — which meant a volume's
 * whole verification bill was paid and no report existed.
 */
async function scenarioCommitVerificationPhase() {
  const { root, volumeDir } = makeVolumeDir();
  try {
    const draft = "Chapter one in English, about the mirror system.\n";
    fs.writeFileSync(path.join(volumeDir, chapterArtifactNames("ch1").draftFile), draft, "utf8");
    // What the volume publishes. The variant scan reads THIS file — the line
    // whose constant was missing.
    fs.writeFileSync(
      path.join(volumeDir, MERGED_FILE),
      "Chapter One\n\nBlacksteel is a name. Black steel is the same name written another way.\n",
      "utf8"
    );

    const sourceHash = sha256("source of chapter one");
    const draftHash = sha256(draft);
    await saveTranslationState(path.join(volumeDir, STATE_FILE), {
      chapters: { ch1: { sourceHash, draftHash } },
    });
    fs.writeFileSync(
      path.join(volumeDir, VERIFICATION_FILE),
      JSON.stringify({ chapters: { ch1: { sourceHash, draftHash, score: 82, pass: true, findings: "" } } }),
      "utf8"
    );

    const bundle = {
      segments: [
        { id: "ch1", file: "src-ch1.md", title: "Chapter One" },
        { id: "ch2", file: "src-ch2.md", title: "Chapter Two" },
      ],
    };

    const res = await commitVerificationVolume({
      volume,
      volumeDir,
      bundle,
      refs: { terms: [{ term: "黒鋼", rendering: "Blacksteel" }] },
      targetLanguage: "English",
    });

    assert.strictEqual(res.verified, 1, "ch1's recorded verdict covers the current draft");
    assert.strictEqual(res.passed, 1, "and it passed");
    assert.strictEqual(res.noDraft, 1, "ch2 has no draft — counted, never hidden");

    // The ratchet's restore point, written from the verified draft.
    assert.ok(
      fs.existsSync(path.join(volumeDir, chapterArtifactNames("ch1").bestFile)),
      "the best draft was recorded"
    );

    // The deterministic scan ran against translation.md (the file whose name the
    // commit phase used without importing). "Blacksteel" vs "Black steel" is the
    // spacing class.
    assert.ok(res.variantFindings.length > 0, "the variant scan read the published text");
    assert.strictEqual(res.variantFindings[0].severity, "MEDIUM", "spacing variant");

    const report = fs.readFileSync(path.join(volumeDir, VERIFICATION_REPORT), "utf8");
    assert.ok(report.includes("Chapter Two"), "the report lists every chapter, not only the graded ones");
    assert.ok(report.includes("82"), "and carries the score");

    // The scan is persisted in the sidecar so the translation report can count it.
    const sidecar = JSON.parse(fs.readFileSync(path.join(volumeDir, VERIFICATION_FILE), "utf8"));
    assert.ok(Array.isArray(sidecar.volume.renderingVariants), "the scan is persisted");
  } finally {
    cleanup(root);
  }
}

// ─── 2. polish's Phase B commit phase runs end to end ─────────────────────────

/**
 * `finishPolishVolume` is polish's commit phase. It drops the candidates that
 * never passed the cross-model audit, re-merges the volume, and writes the
 * report — and the merge needs the language pair to decide which chapters look
 * truncated. Phase A used to hand back a context object without it, so this
 * threw `sourceLanguage is not defined` for every volume, even one with zero
 * drafts.
 */
async function scenarioFinishPolishPhase() {
  const { root, volumeDir } = makeVolumeDir();
  try {
    const draft1 = "The draft text, verified but rough.\n";
    const polished1 = "The polished text, smoother and the same meaning.\n";
    const draft2 = "Second chapter draft, kept because its polish was rejected.\n";

    fs.writeFileSync(path.join(volumeDir, chapterArtifactNames("ch1").draftFile), draft1, "utf8");
    fs.writeFileSync(path.join(volumeDir, chapterArtifactNames("ch1").polishedFile), polished1, "utf8");
    fs.writeFileSync(path.join(volumeDir, chapterArtifactNames("ch2").draftFile), draft2, "utf8");
    // A candidate that failed every audit round: its polished file must be
    // dropped so the merge publishes the draft.
    fs.writeFileSync(path.join(volumeDir, chapterArtifactNames("ch2").polishedFile), "A rejected polish.\n", "utf8");

    const state = {
      chapters: {
        // ch1: the polish was produced from the CURRENT draft (polishedDraftHash
        // records the draft it was made from) and the audit accepted it — so it
        // wins the merge.
        ch1: {
          draftHash: sha256(draft1),
          polishedDraftHash: sha256(draft1),
          polishVerifiedDraftHash: sha256(draft1),
        },
        ch2: {
          draftHash: sha256(draft2),
          polishFindings: "FINDING [HIGH] — the polish changed who is speaking",
          polishFindingsHash: "fh-2",
        },
      },
    };

    const vc = {
      volume,
      volumeDir,
      bundle: {
        segments: [
          { id: "ch1", file: "src-ch1.md", title: "Chapter One" },
          { id: "ch2", file: "src-ch2.md", title: "Chapter Two" },
        ],
      },
      state,
      rows: [
        { id: "ch1", title: "Chapter One", status: "polished", score: 88, warnings: [] },
        { id: "ch2", title: "Chapter Two", status: "auditing", score: null, warnings: [] },
      ],
      auditPending: [{ id: "ch2", draftHash: sha256(draft2) }],
      polished: 1,
      skipped: 0,
      rejected: 0,
      noDraft: 0,
      // The pair Phase A now carries. Without it this phase throws.
      sourceLanguage: "Japanese",
      targetLanguage: "English",
    };

    const res = await finishPolishVolume(vc, 3);

    assert.strictEqual(res.rejected, 1, "the exhausted candidate is counted as rejected");
    assert.ok(
      !fs.existsSync(path.join(volumeDir, chapterArtifactNames("ch2").polishedFile)),
      "the rejected candidate's polished file is dropped so the merge publishes the draft"
    );

    const merged = fs.readFileSync(path.join(volumeDir, MERGED_FILE), "utf8");
    assert.ok(merged.includes(polished1.trim()), "the audit-accepted polish wins the merge");
    assert.ok(merged.includes(draft2.trim()), "the rejected chapter still publishes its draft");
    assert.ok(!merged.includes("A rejected polish"), "and the rejected polish is not published");
    assert.deepStrictEqual(res.missing, [], "no chapter is missing from the volume");

    const report = fs.readFileSync(path.join(volumeDir, POLISH_QA_REPORT), "utf8");
    assert.ok(report.includes("polish rejected after 3 audit round"), "the report says why ch2 kept its draft");
    assert.ok(report.includes("88/100"), "and carries the accepted chapter's drift score");

    // The findings survive for the next run (it re-audits with them).
    const persisted = await loadTranslationState(path.join(volumeDir, STATE_FILE));
    assert.strictEqual(persisted.chapters.ch2.polishVerifiedDraftHash, null, "ch2 is not polish-up-to-date");
    assert.ok(persisted.chapters.ch2.polishFindings.includes("HIGH"), "its findings persist");
  } finally {
    cleanup(root);
  }
}

// ─── 3. an agent can read a cumulative artifact whole ─────────────────────────

/**
 * The file tools every writing agent is handed (harness.createGatedFsTools) used
 * the library's defaults: 2000 characters per line, 32 KB per read. The
 * cumulative artifacts hold one long line per entry — 2,344 characters at volume
 * 02 of the live series, 2,863 at volume 03 — so an agent asked to carry them
 * forward was answered with a cut-off line every time it looked.
 *
 * Pinned both ways: the raised caps read the line whole, and the old default
 * (restored through the env knob) still cuts it — so the fix is the thing under
 * test, not an accident of the fixture.
 */
async function scenarioAgentReadCaps() {
  const { root, volumeDir } = makeVolumeDir();
  const prevLine = process.env.AGENT_MAX_LINE_LENGTH;
  const prevBytes = process.env.AGENT_MAX_READ_BYTES;
  try {
    // The real shape: a glossary/voice-reference table row with a long Notes cell.
    const longLine = `| Hime | Princess Hime | ${"speech quirk evidence and carried-forward examples ".repeat(45)} |`;
    assert.ok(longLine.length > 2000 && longLine.length < 8000, `fixture line is ${longLine.length} chars`);
    const artifact = `# Character Voice Reference — Series\n\n${longLine}\n`;
    fs.writeFileSync(path.join(volumeDir, "character-voice.md"), artifact, "utf8");

    assert.strictEqual(harness.envMaxLineLength(), 8000, "the line cap is raised from the library's 2000");
    assert.strictEqual(harness.envMaxReadBytes(), 65536, "the read cap is raised from the library's 32 KB");

    const { tools, approve } = await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] });

    const read = await tools.readFile.execute({ filePath: "character-voice.md" });
    assert.ok(!read.error, `readFile failed: ${read.error}`);
    assert.ok(read.content.includes(longLine), "the agent sees the whole line it has to preserve");
    assert.ok(!read.content.includes("line truncated"), "no truncation marker in the answer");

    // The old default, restored through the knob: the same read IS cut. This is
    // the failure the raised cap exists to remove.
    process.env.AGENT_MAX_LINE_LENGTH = "2000";
    const legacy = await (
      await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] })
    ).tools.readFile.execute({ filePath: "character-voice.md" });
    assert.ok(
      legacy.content.includes("line truncated at 2000 chars"),
      "the library default cuts the artifact's entry in half (the bug)"
    );
    delete process.env.AGENT_MAX_LINE_LENGTH;

    // The byte cap: a 40 KB artifact is over the library's 32 KB ceiling and
    // under the raised one. (The cap is reported in the answer's `status` line.)
    const bigFile = path.join(volumeDir, "big-reference.md");
    fs.writeFileSync(bigFile, `# Big\n\n${"carried-forward entry line.\n".repeat(1600)}`, "utf8");
    assert.ok(fs.statSync(bigFile).size > 32768, "the fixture is larger than the library's read ceiling");
    const bigRead = await tools.readFile.execute({ filePath: "big-reference.md" });
    assert.ok(!bigRead.error, `readFile failed: ${bigRead.error}`);
    assert.ok(!String(bigRead.status).includes("Output capped at"), "one read covers a 40 KB artifact");
    assert.strictEqual(bigRead.toLine, bigRead.totalLines, "and it reaches the end of the file");

    process.env.AGENT_MAX_READ_BYTES = "32768";
    const legacyBig = await (
      await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] })
    ).tools.readFile.execute({ filePath: "big-reference.md" });
    assert.ok(
      String(legacyBig.status).includes("Output capped at"),
      "the library default pages it (the old cost: every page re-bills the growing transcript)"
    );
    assert.ok(legacyBig.toLine < legacyBig.totalLines, "the read stops short of the end");
    if (prevBytes === undefined) delete process.env.AGENT_MAX_READ_BYTES;
    else process.env.AGENT_MAX_READ_BYTES = prevBytes;

    // Raising the read caps must not widen the WRITE gate: reads are free,
    // writes stay inside the volume folder, deleteFile is never allowed.
    assert.strictEqual(approve({ toolName: "readFile", input: { filePath: "../outside.md" } }), true, "reads are allowed anywhere");
    assert.strictEqual(approve({ toolName: "writeFile", input: { filePath: "../outside.md" } }), false, "writes stay confined");
    assert.strictEqual(approve({ toolName: "editFile", input: { filePath: "character-voice.md" } }), true, "the volume's own file is writable");
    assert.strictEqual(approve({ toolName: "deleteFile", input: { filePath: "character-voice.md" } }), false, "deleteFile stays denied");
  } finally {
    if (prevLine === undefined) delete process.env.AGENT_MAX_LINE_LENGTH;
    else process.env.AGENT_MAX_LINE_LENGTH = prevLine;
    if (prevBytes === undefined) delete process.env.AGENT_MAX_READ_BYTES;
    else process.env.AGENT_MAX_READ_BYTES = prevBytes;
    cleanup(root);
  }
}

// ─── 4. a chat reply is not an artifact ───────────────────────────────────────

/**
 * The corruption path, end to end on real files: an author agent replied in chat
 * with a sentence about what it was going to do, made no writeFile call, and the
 * fallback wrote that sentence into BOTH expected outputs. The volume then passed
 * every "was the work done?" check (164 characters of English prose is neither
 * empty nor a scaffold stub) and the sentence was promoted to the series root as
 * the character voice reference.
 *
 * The gate and the hard stop are what now stand between a no-op turn and a
 * published artifact — asserted together, because either one alone is not enough.
 */
async function scenarioChatReplyIsNotAnArtifact() {
  const { assertWroteWithFallback, assertRealOutput, looksLikeArtifact } = require("../utils/fs");
  const { root, volumeDir } = makeVolumeDir();
  try {
    const voiceFile = path.join(volumeDir, "character-voice.md");
    const povFile = path.join(volumeDir, "pov-map.md");
    const liveReply =
      "I need the full content of two very long lines in the previous reference. " +
      "Let me temporarily split them (and restore them afterwards) so I can read them completely.";

    // The reply that produced the live corruption.
    assert.strictEqual(looksLikeArtifact(liveReply).ok, false, "planning narration is not a document");

    const missing = await assertWroteWithFallback([voiceFile, povFile], "the author agent (compile)", liveReply);
    assert.strictEqual(missing, true, "the caller is told to run the recovery turn");
    assert.ok(!fs.existsSync(voiceFile), "character-voice.md was NOT created from the reply");
    assert.ok(!fs.existsSync(povFile), "nor pov-map.md");

    // The hard stop after the recovery turn fails the volume loudly — which is
    // what a skipped volume means, instead of a published wrong artifact.
    await assert.rejects(
      () => assertRealOutput([voiceFile, povFile], "the author agent (compile)"),
      /never wrote real output/
    );

    // A real document for a single missing file is still recovered (the fallback
    // exists for a reason).
    const single = path.join(volumeDir, "character-voice-validation.md");
    const doc = `# Character Voice Validation Report — Volume 01\n\n${"finding: the POV shift in chapter 4 is unmarked. ".repeat(40)}`;
    assert.strictEqual(await assertWroteWithFallback(single, "the validator agent", doc), true);
    assert.strictEqual(fs.readFileSync(single, "utf8"), doc);
    await assertRealOutput(single, "the validator agent");
  } finally {
    cleanup(root);
  }
}

// ─── 5. a non-document is never promoted to the series root ───────────────────

/**
 * The second half of the live corruption: the root-copy walk takes the newest
 * per-volume snapshot and copies it to the series root, where the consistency
 * audit, every later volume's prompts and the translation stage all read it.
 * "Exists, not empty, not a stub" accepted the 164-character sentence; the
 * publish check refuses it by SHAPE (no heading, no table) rather than by a size
 * guess, and says so instead of skipping silently.
 */
async function scenarioRootCopyRefusesANonDocument() {
  const { hasRealOutput, isPublishableArtifact } = require("../utils/fs");
  const { root, volumeDir } = makeVolumeDir();
  try {
    const garbage = path.join(volumeDir, "character-voice.md");
    fs.writeFileSync(
      garbage,
      "I need the full content of two very long lines in the previous reference. " +
        "Let me temporarily split them (and restore them afterwards) so I can read them completely.",
      "utf8"
    );
    // The old rule passed it — that is how it reached the series root.
    assert.strictEqual(await hasRealOutput(garbage), true, "exists + non-empty + not a stub: the skip-check rule accepts it");
    assert.strictEqual(
      await isPublishableArtifact(garbage, "character voice reference"),
      false,
      "the publish rule refuses it, and warns"
    );

    // A scaffold stub is refused by both rules.
    const stub = path.join(volumeDir, "pov-map.md");
    fs.writeFileSync(stub, "(stub — the agent replaces this with the complete POV map)\n", "utf8");
    assert.strictEqual(await hasRealOutput(stub), false, "a stub is not real output");
    assert.strictEqual(await isPublishableArtifact(stub, "POV map"), false, "and not publishable");

    // A real artifact passes whatever its length — the rule is shape, not size.
    const real = path.join(volumeDir, "glossary.md");
    fs.writeFileSync(real, "# Glossary — Series\n\n| Source | Target |\n|---|---|\n| 鏡 | Mirror |\n", "utf8");
    assert.strictEqual(await isPublishableArtifact(real, "glossary"), true, "a short headed table is publishable");

    // Absent: refused without a warning, so the walk keeps looking backwards.
    assert.strictEqual(await isPublishableArtifact(path.join(volumeDir, "style-guide.md"), "style guide"), false);
  } finally {
    cleanup(root);
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

(async function main() {
  await scenarioCommitVerificationPhase();
  await scenarioFinishPolishPhase();
  await scenarioAgentReadCaps();
  await scenarioChatReplyIsNotAnArtifact();
  await scenarioRootCopyRefusesANonDocument();
  console.log("artifact-integrity: all checks passed.");
})();

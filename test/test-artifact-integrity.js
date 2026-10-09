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
 * The sixth block proves those same tools match how a model actually reaches for
 * them: grep pointed at a FILE (40 ENOTDIR crashes in the live runs), grep with
 * the wildcard every model writes — `glob: "*.md"`, which is a filename ENDING
 * in this library and matched NOTHING, 398 times, silently — and a staged
 * `.epub` decoded as text. Pinned both ways: the library still does all three.
 *
 * The seventh block pins the agent-turn log: the library's `tool.done` event is
 * consumed (a transcript without tool RESULTS cannot tell "found nothing" from
 * "never ran"), calls pair with their results by id, and a tool input serializes
 * instead of printing `[object Object]`.
 *
 * No network, no endpoint. Run with `npm test` (or standalone:
 * `node test/test-artifact-integrity.js`).
 */
require("./test-home"); // the run's records get a throwaway home (gotcha 69)
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

// ─── 6. the file tools match how agents actually reach for them ───────────────

/**
 * The library's file tools are stricter than the way a model naturally uses
 * them, and nothing validated the gap — the schema is "some string", so the
 * mismatch was only discovered while a run was live. Observed on the live
 * series (1030 logged grep calls):
 *
 *   - 40 calls passed a FILE as grep's `dirPath`, which the tool walks, and died
 *     with `ENOTDIR: not a directory`. The pipeline's own prompts caused it:
 *     they name one file and say "read it selectively with readFile/grep".
 *   - 398 calls passed `glob: "*whole.md"` or `"*.md"`. grep's glob is a
 *     filename ENDING (the implementation is `file.endsWith(glob)`), so those
 *     matched NOTHING and answered "No matches found" — silently. An agent then
 *     reports the term as absent from the source, which is the difference
 *     between a wasted step and a wrong artifact.
 *
 * Pinned both ways, like the read caps above: the library still does the wrong
 * thing, and the tools an agent is handed do not.
 */
async function scenarioFileToolContract() {
  const { root, volumeDir } = makeVolumeDir();
  try {
    const whole = "Series(1)-whole.md";
    fs.writeFileSync(
      path.join(volumeDir, whole),
      "# 俺を好きなのはお前だけかよ\n\nジョーロがそこにある。\nひまわり理論の話。\n",
      "utf8"
    );
    fs.writeFileSync(path.join(volumeDir, "glossary.md"), "# Glossary\n\n| ジョーロ | Watering Can |\n", "utf8");
    // A staged book sitting in the volume folder. The library's binary-file list
    // knows .zip but not .epub, so a folder search used to decode it as text.
    fs.writeFileSync(path.join(volumeDir, "Series(1).epub"), "PK\u0003\u0004ジョーロ zip noise\u0000\u0001", "utf8");

    const { tools } = await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] });

    // The library, unpatched: both failures are real.
    const core = await import("@openharness/core");
    const raw = core.createFsTools(new core.NodeFsProvider({ cwd: volumeDir }), {});
    await assert.rejects(
      () => raw.grep.execute({ pattern: "ジョーロ", dirPath: whole }),
      /ENOTDIR/,
      "grep pointed at a file dies in the library (the bug)"
    );
    const rawStar = await raw.grep.execute({ pattern: "ひまわり", dirPath: ".", glob: "*.md" });
    assert.strictEqual(rawStar.matchCount, 0, "glob \"*.md\" matches nothing in the library (the silent bug)");
    assert.ok(!rawStar.error, "and it reports success while doing so");
    const rawBooks = await raw.grep.execute({ pattern: "ジョーロ", dirPath: "." });
    assert.ok(
      rawBooks.matches.some((m) => m.file.endsWith(".epub")),
      "the library reads a staged book as text and matches its zip bytes (the bug)"
    );

    // 1. grep pointed AT a file: works, and says what it did.
    const onFile = await tools.grep.execute({ pattern: "ジョーロ", dirPath: whole });
    assert.ok(!onFile.error, `grep on a file errored: ${onFile.error}`);
    assert.strictEqual(onFile.matchCount, 1, "the agent's file-scoped search finds its line");
    assert.ok(onFile.matches.every((m) => m.file === whole), "and it stayed scoped to that file");
    assert.ok(String(onFile.status).includes("takes a FOLDER"), "the agent is told what was corrected");

    // 2. the wildcard an agent writes still searches the Markdown files.
    const star = await tools.grep.execute({ pattern: "ひまわり", dirPath: ".", glob: "*.md" });
    assert.ok(!star.error, `grep with glob "*.md" errored: ${star.error}`);
    assert.strictEqual(star.matchCount, 1, "the search actually ran (it used to answer zero matches)");
    assert.ok(String(star.status).includes("filename ENDING"), "and the agent is told glob is not a wildcard");

    // 3. a file name as glob narrows to that file, with no correction needed.
    const named = await tools.grep.execute({ pattern: "ジョーロ", dirPath: ".", glob: whole });
    assert.strictEqual(named.matchCount, 1, "glob naming one file works");
    assert.ok(named.matches.every((m) => m.file === whole), "and only that file was searched");

    // 4. a pattern from another regex dialect is explained, not thrown.
    const badPattern = await tools.grep.execute({ pattern: "(?i)vice", dirPath: "." });
    assert.ok(badPattern.error, "an uncompilable pattern is an answer, not a crash");
    assert.ok(/ignoreCase/.test(badPattern.error), "and the answer names the flag the tool actually has");

    // 5. listFiles on a file lists its folder instead of crashing.
    const listed = await tools.listFiles.execute({ dirPath: whole });
    assert.ok(!listed.error, `listFiles on a file errored: ${listed.error}`);
    assert.ok(listed.entries.some((e) => e.name === whole), "the folder's contents came back");

    // 6. a book is never searched or read as text.
    const overFolder = await tools.grep.execute({ pattern: "ジョーロ", dirPath: "." });
    assert.ok(
      overFolder.matches.every((m) => !m.file.endsWith(".epub")),
      "the folder search skips the staged book"
    );
    const bookRead = await tools.readFile.execute({ filePath: "Series(1).epub" });
    assert.ok(bookRead.error && /archive, not a text file/.test(bookRead.error), "reading a book as text is refused with a reason");
    const textRead = await tools.readFile.execute({ filePath: whole });
    assert.ok(!textRead.error, "plain text is still readable");

    // The contract is stated where the model reads it: the tool description.
    assert.ok(/DIRECTORY/.test(tools.grep.description) && /NOT a wildcard/i.test(tools.grep.description), "grep's description states the contract");
    assert.ok(/DIRECTORY/.test(tools.listFiles.description), "listFiles' description states the contract");
    assert.ok(/Archives/.test(tools.readFile.description), "readFile's description says an archive is not text");

    // A repair must never smuggle a path past a gate that judged the agent's own
    // path: the gate wraps this execute and sees the input before normalization.
    const approve = (await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] })).approve;
    assert.strictEqual(approve({ toolName: "grep", input: { dirPath: "Series(1).epub" } }), true, "reads stay allowed");
    assert.strictEqual(approve({ toolName: "writeFile", input: { filePath: "../outside.md" } }), false, "the write gate is untouched");
    assert.strictEqual(approve({ toolName: "writeFile", input: { filePath: "Series(1).epub" } }), false, "an agent cannot overwrite the staged book — the volume folder is where the source lives");
    assert.strictEqual(approve({ toolName: "editFile", input: { filePath: "Series(1).epub" } }), false, "nor patch it");
    assert.strictEqual(approve({ toolName: "writeFile", input: { filePath: "glossary.md" } }), true, "the volume's own artifacts are still writable");

    // A tool the sandbox will never allow is not offered at all: advertising it
    // costs the agent a step of a capped budget learning that it cannot, and
    // contradicts the prompt, which names only the five tools it really has.
    assert.ok(!("deleteFile" in tools), "deleteFile is not in the tool set an agent is handed");
    assert.deepStrictEqual(
      Object.keys(tools).sort(),
      ["editFile", "grep", "listFiles", "readFile", "writeFile"],
      "the agent's tool set is exactly the five the prompt promises"
    );
    assert.strictEqual(approve({ toolName: "deleteFile", input: { filePath: "glossary.md" } }), false, "the gate still refuses it if anything reaches for it anyway");

    // The normalization rules themselves, without a filesystem in the way.
    const norm = (input) => harness.normalizeDirToolInput({ input, cwd: volumeDir, toolName: "grep" });
    assert.strictEqual((await norm({ dirPath: ".", glob: "**/*.md" })).input.glob, ".md", "a path-shaped glob reduces to its ending");
    assert.strictEqual((await norm({ dirPath: ".", glob: "*" })).input.glob, undefined, "a bare \"*\" is dropped rather than matching nothing");
    assert.strictEqual((await norm({ dirPath: ".", glob: "-whole.md" })).input.glob, "-whole.md", "a suffix the agent got right is left alone");
    assert.strictEqual((await norm({ dirPath: ".", glob: "sub/notes.md" })).input.glob, "notes.md", "a nested glob keeps its file name");
    assert.strictEqual((await norm({ dirPath: ".", pattern: "x" })).input.dirPath, ".", "a correct call is not rewritten");
    assert.strictEqual((await norm({})).input.dirPath, undefined, "a call with no dirPath is left alone (the tool's own default fills it)");
  } finally {
    cleanup(root);
  }
}

// ─── 7. an agent turn's tool results survive into the chat log ────────────────

/**
 * The library emits tool.start / tool.done / tool.error. consumeEvents had no
 * case for tool.done, so every agent transcript recorded each tool CALL and none
 * of their answers — 0 output lines across 526 logged turns, while AGENTS.md
 * promised "tool calls + results". That is the difference between reading "the
 * search found nothing" and "the search could not run".
 *
 * escapeInline is the other half: it ran String() on a tool input, which answers
 * "[object Object]" — every logged call was unreadable.
 *
 * Pairing is by toolCallId, not "the last call seen": a step fires several calls
 * at once, and an error used to be pinned onto a call that succeeded.
 */
function scenarioToolCallLogging() {
  const src = require("./module-layer").readModuleLayer(path.join(__dirname, ".."), "harness.js", "ai");
  assert.ok(/case "tool\.done":/.test(src), 'consumeEvents handles the "tool.done" event (the missing case)');
  assert.ok(/toolCallId: event\.toolCallId/.test(src), "a collected tool call carries the id that pairs it with its result");

  const calls = [
    { toolCallId: "a", name: "grep", input: { pattern: "x" }, output: null, error: null },
    { toolCallId: "b", name: "grep", input: { pattern: "y" }, output: null, error: null },
  ];
  assert.strictEqual(harness.findToolCall(calls, "b"), calls[1], "a result finds its own call");
  assert.strictEqual(harness.findToolCall(calls, "nope"), null, "an unknown id matches nothing");
  assert.strictEqual(harness.findToolCall(calls, undefined), null, "an event without an id matches nothing");

  assert.strictEqual(
    harness.escapeInline({ pattern: "ジョーロ", dirPath: "." }),
    '{"pattern":"ジョーロ","dirPath":"."}',
    "a tool input is serialized, not \"[object Object]\""
  );
  assert.strictEqual(harness.escapeInline("plain text"), "plain text", "strings pass through");
  assert.strictEqual(harness.escapeInline(null), "", "nothing is empty");
  assert.strictEqual(harness.escapeInline({ a: 1, b: { c: 2 } }).length <= 500, true, "and the log line stays bounded");
}

// ─── run ─────────────────────────────────────────────────────────────────────

(async function main() {
  await scenarioCommitVerificationPhase();
  await scenarioFinishPolishPhase();
  await scenarioAgentReadCaps();
  await scenarioChatReplyIsNotAnArtifact();
  await scenarioRootCopyRefusesANonDocument();
  await scenarioFileToolContract();
  scenarioToolCallLogging();
  console.log("artifact-integrity: all checks passed.");
})();

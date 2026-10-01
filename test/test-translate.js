/**
 * test-translate.js — self-checks for the translation stage's pure helpers in
 * utils/translate.js (chapter splitting, prompt construction, deterministic
 * QA, state load/save). Run with `npm test`. No AI, no network; the state
 * tests use a temporary directory.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  sha256,
  splitChapter,
  parseGlossaryTerms,
  parseGlossaryRows,
  splitTableRow,
  selectTermsForChapter,
  chapterTerminology,
  extractStyleRules,
  buildTranslationTaskLines,
  buildTranslationPrompt,
  cjkRatio,
  countOccurrences,
  checkTranslationQa,
  buildPolishGuardFindings,
  mergeVolumeTranslation,
  headingForSegment,
  findMissingSegments,
  stripMarkdownFence,
  tailOf,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  qaLoopDecision,
  qaMaxRounds,
  stripContinuityOverlap,
  runWithConcurrency,
  stageConcurrency,
  previousVolumeTail,
  chapterContextHash,
  loadVolumeReferences,
  findRenderingVariants,
  renderVariantFindings,
  checkChapterListConsistency,
  estimateTokens,
  fitPromptBudget,
  buildBudgetedTaskLines,
  medianScore,
  verdictCoversCurrentDraft,
  unverifiedMarker,
  worthRetranslating,
} = require("../utils/translate");

// ─── sha256 ───────────────────────────────────────────────────────────────────

assert.strictEqual(sha256("").length, 64);
assert.notStrictEqual(sha256("a"), sha256("b"));
assert.strictEqual(sha256("a"), sha256("a"));

// ─── splitChapter ─────────────────────────────────────────────────────────────

{
  // Short text: one part, content preserved.
  const short = "para one\n\npara two";
  assert.deepStrictEqual(splitChapter(short, 24000), [short]);

  // Empty / whitespace-only: no parts.
  assert.deepStrictEqual(splitChapter("", 1000), []);
  assert.deepStrictEqual(splitChapter("   \n  ", 1000), []);

  // Long multi-paragraph text: split at paragraph boundaries, no content loss.
  const p1 = "x".repeat(1500);
  const p2 = "y".repeat(1500);
  const p3 = "z".repeat(1500);
  const text = [p1, p2, p3].join("\n\n");
  const parts = splitChapter(text, 3100);
  assert.strictEqual(parts.length, 2, `expected 2 parts, got ${parts.length}`);
  for (const part of parts) assert.ok(part.length <= 3100, `part over limit: ${part.length}`);
  const noWs = (s) => s.replace(/\s+/g, "");
  assert.strictEqual(noWs(parts.join("")), noWs(text), "content loss in split");

  // A single paragraph longer than the limit: hard-split, no content loss.
  const huge = "a".repeat(7000);
  const hParts = splitChapter(huge, 3000);
  assert.strictEqual(hParts.length, 3);
  assert.strictEqual(noWs(hParts.join("")), noWs(huge));
}

// ─── parseGlossaryTerms ───────────────────────────────────────────────────────

{
  const glossary = [
    "# Glossary — test",
    "",
    "## Characters",
    "| 日本語 | English | Notes |",
    "|---|---|---|",
    "| ソラ | Sora | protagonist |",
    "| *黒鋼* | Kurogane | — |",
    "",
    "## Terms & Concepts",
    "| 日本語 | English | Notes |",
    "|---|---|---|",
    "| 端末 | terminal | device |",
    "| 謎 | — | unresolved |",
    "",
    "Prose outside tables is ignored.",
    "",
  ].join("\n");
  const terms = parseGlossaryTerms(glossary);
  assert.deepStrictEqual(
    terms.map((t) => [t.term, t.rendering, t.section]),
    [
      ["ソラ", "Sora", "Characters"],
      ["黒鋼", "Kurogane", "Characters"],
      ["端末", "terminal", "Terms & Concepts"],
    ],
    "rows without a rendering (—) are dropped; emphasis is normalized"
  );
  assert.deepStrictEqual(parseGlossaryTerms(""), []);
  assert.deepStrictEqual(parseGlossaryTerms(null), []);
}

{
  // The column-shift bug: an EMPTY middle cell must stay a cell. Filtering out
  // empty cells shifted every later column one place left and promoted the
  // Notes cell into the canonical-rendering column — the translation stage then
  // enforced "ソラ" → "AI agent of the institute" as terminology law.
  const sparse = [
    "## Characters",
    "| Source | Target | Notes |",
    "|---|---|---|",
    "| ソラ |  | AI agent of the institute |",
    "| 黒鋼 | Kurogane |  |",
    "| 端末 | terminal | a device |",
  ].join("\n");
  assert.deepStrictEqual(
    parseGlossaryTerms(sparse).map((t) => [t.term, t.rendering]),
    [
      ["黒鋼", "Kurogane"],
      ["端末", "terminal"],
    ],
    "an empty Target column drops the row (no rendering) — it never promotes the Notes column"
  );

  // The malformed rows are reported, not silently swallowed.
  const seen = [];
  parseGlossaryTerms(sparse, { onMalformed: (e) => seen.push([e.term, e.reason]) });
  assert.deepStrictEqual(
    seen,
    [["ソラ", "rendering column is empty"]],
    "onMalformed reports a row the model left unrendered"
  );

  // A 4-column table (the style-guide shape) keeps its columns aligned — an
  // empty cell in column 3 must not pull column 4 left into column 2.
  const wide = [
    "## Address & Honorifics",
    "| Source | Meaning / Context | Rendering | Notes |",
    "|---|---|---|---|",
    "| 〜さん | general polite address | -san | keep as-is |",
    "| 〜様 |  | -sama |  |",
  ].join("\n");
  const wideRows = parseGlossaryRows(wide);
  assert.deepStrictEqual(
    wideRows.map((r) => r.cells.length),
    [4, 4],
    "every data row keeps all 4 columns, empty cells included"
  );
  assert.deepStrictEqual(wideRows[1].cells, ["〜様", "", "-sama", ""]);
  assert.deepStrictEqual(
    parseGlossaryTerms(wide).map((t) => [t.term, t.rendering]),
    [["〜さん", "general polite address"]],
    "column 2 is read as column 2 (the glossary convention: Source | Target | Notes)"
  );

  // parseGlossaryRows is the shared low-level reader: every data row, positionally.
  const rows = parseGlossaryRows(sparse);
  assert.deepStrictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0].cells, ["ソラ", "", "AI agent of the institute"]);
  assert.deepStrictEqual(rows[0].section, "Characters");
  assert.deepStrictEqual(parseGlossaryRows(""), []);
}

// ─── extractStyleRules ────────────────────────────────────────────────────────

{
  const guide = [
    "# Style Guide — test",
    "",
    "## Policy Summary",
    "- rule one",
    "- rule two",
    "",
    "## Pronouns",
    "| 私 | I |",
    "|---|---|",
    "| a | b |",
  ].join("\n");
  assert.strictEqual(extractStyleRules(guide), "- rule one\n- rule two");

  // Policy Summary as the LAST section (ends at EOF).
  const guide2 = "## Other\nstuff\n\n## Policy Summary\n- last rule\n";
  assert.strictEqual(extractStyleRules(guide2), "- last rule");

  // No Policy Summary: truncated fallback.
  const long = "# SG\n\n## Other\n" + "word ".repeat(5000);
  const fb = extractStyleRules(long, { fallbackMaxChars: 200 });
  assert.ok(fb.startsWith("# SG"), "fallback keeps the document start");
  assert.ok(fb.includes("(truncated)"), "fallback marks the truncation");

  assert.strictEqual(extractStyleRules(""), "");
  assert.strictEqual(extractStyleRules(null), "");
}

// ─── buildTranslationTaskLines / buildTranslationPrompt ──────────────────────

{
  const minimal = buildTranslationTaskLines({});
  assert.strictEqual(minimal.length, 2);
  assert.strictEqual(minimal[1], "Translate the [Source Text] into English.");

  const full = buildTranslationTaskLines({
    terminologyLines: ['"ソラ" translates to "Sora"'],
    background: "The plot.",
    styleRules: "Rule.",
    continuityText: "the ending",
    findingsText: "fix this",
    targetLanguage: "French",
  });
  assert.strictEqual(full.length, 7, "terminology, background, style, continuity, findings + 2");
  assert.ok(full[0].includes('"ソラ" translates to "Sora"'), "terminology line present");
  assert.ok(full[1].includes("The plot."), "background present");
  assert.ok(full[2].includes("Rule."), "style rules present");
  assert.ok(full[3].includes('"the ending"'), "continuity quoted");
  assert.ok(full[4].includes("fix this"), "findings present");
  assert.ok(full[5].includes("ONLY output the translated result"));
  assert.strictEqual(full[full.length - 1], "Translate the [Source Text] into French.");

  // The continuity cue must name where the quoted ending actually came from.
  // A chapter whose neighbour FAILED leaves the last GOOD chapter's ending as
  // the cue — calling that "the previous chapter" tells the model to match a
  // text it is not continuing from.
  const defaultCue = buildTranslationTaskLines({ continuityText: "alpha" }).find((l) => l.includes('"alpha"'));
  assert.ok(defaultCue.includes("the previous chapter"), "default label");
  assert.ok(!defaultCue.includes("immediately"), "no unqualified 'immediately' claim");
  const honestCue = buildTranslationTaskLines({
    continuityText: "alpha",
    continuitySource: "the last usable chapter draft (ch4)",
  }).find((l) => l.includes('"alpha"'));
  assert.ok(honestCue.includes("the last usable chapter draft (ch4)"), "the real source is named");
  const volumeCue = buildTranslationTaskLines({
    continuityText: "alpha",
    continuitySource: "the end of the previous volume (Volume 03)",
  }).find((l) => l.includes('"alpha"'));
  assert.ok(volumeCue.includes("Volume 03"), "a cross-volume cue says which volume");

  const template = "*[Source Text]*\n{{SOURCE_TEXT}}\n\n*[Translation Tasks]*\n{{TASKS}}";
  const prompt = buildTranslationPrompt({ template, sourceText: "本文", tasks: full });
  assert.ok(prompt.startsWith("*[Source Text]*\n本文"), "source block first");
  assert.ok(prompt.includes("*[Translation Tasks]*"));
  assert.ok(prompt.includes("1. **") && prompt.includes("7. **"), "numbered 1..7");
  assert.ok(prompt.endsWith("7. **Translate the [Source Text] into French.**"));
}

// ─── previousVolumeTail (cross-volume continuity cue) ────────────────────────

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-tail-"));
  const manifest = {
    volumes: [
      { folder: "book-one(01)", installmentNumber: "01" },
      { folder: "book-two(02)", installmentNumber: "02" },
      { folder: "book-three(03)", installmentNumber: "03" },
    ],
  };
  fs.mkdirSync(path.join(dir, "book-one(01)"), { recursive: true });
  fs.mkdirSync(path.join(dir, "book-two(02)"), { recursive: true });
  fs.writeFileSync(path.join(dir, "book-one(01)", "translation.md"), "one\n\n" + "x".repeat(2000) + "\nTHE END OF BOOK ONE");

  // The first volume has nothing before it.
  assert.deepStrictEqual(await previousVolumeTail(dir, manifest, "book-one(01)", 400), { text: "", fromLabel: "" });

  // A later volume gets the previous volume's published ending, labelled with
  // the volume it came from (reading order from the manifest, not folder names).
  const tail = await previousVolumeTail(dir, manifest, "book-two(02)", 400);
  assert.strictEqual(tail.fromLabel, "Volume 01");
  assert.ok(tail.text.length > 0 && tail.text.length <= 401, `bounded tail: ${tail.text.length} chars`);
  assert.ok(tail.text.startsWith("…"), "a truncated cue is marked as a fragment");

  // A volume whose predecessor was never translated gets no cue (rather than a
  // cue invented from a further-back volume).
  const gap = await previousVolumeTail(dir, manifest, "book-three(03)", 400);
  assert.deepStrictEqual(gap, { text: "", fromLabel: "" });
  fs.rmSync(dir, { recursive: true, force: true });
})();

// ─── medianScore / verdictCoversCurrentDraft / unverifiedMarker ──────────────

{
  assert.strictEqual(medianScore([70]), 70);
  assert.strictEqual(medianScore([90, 40]), 65, "even count → mean of the two middle values");
  assert.strictEqual(medianScore([90, 40, 68]), 68, "odd count → the middle value");
  assert.strictEqual(medianScore([90, 40, 68, 70]), 69, "rounded to a whole score");
  // An outlier cannot move the verdict on its own: the middle of [95, 30, 71] is 71.
  assert.strictEqual(medianScore([95, 30, 71]), 71);
  assert.strictEqual(medianScore([]), null);
  assert.strictEqual(medianScore([null, "x", 50]), 50, "non-numeric entries are ignored");

  const stateEntry = { sourceHash: "s1", draftHash: "d1" };
  assert.strictEqual(verdictCoversCurrentDraft({ sourceHash: "s1", draftHash: "d1" }, stateEntry), true);
  assert.strictEqual(verdictCoversCurrentDraft({ sourceHash: "s1", draftHash: "d2" }, stateEntry), false, "a retranslate invalidates the verdict");
  assert.strictEqual(verdictCoversCurrentDraft({ sourceHash: "s2", draftHash: "d1" }, stateEntry), false, "a changed source invalidates it");
  assert.strictEqual(verdictCoversCurrentDraft(undefined, stateEntry), false);
  assert.strictEqual(verdictCoversCurrentDraft({ sourceHash: "s1" }, stateEntry), false, "a verdict with no draft hash covers nothing");

  // The marker is visible in the rendered book, not hidden in a comment.
  const marker = unverifiedMarker({ score: 57, pass: false, reason: "the verifier scored it below the passing threshold" });
  assert.ok(marker.startsWith("> **"), "a visible blockquote line");
  assert.ok(marker.includes("UNVERIFIED"));
  assert.ok(marker.includes("57/100"));
  assert.ok(marker.includes("the verifier scored it below the passing threshold"));
  assert.ok(unverifiedMarker({ score: null, pass: false, reason: "verification has not run" }).includes("no verification score"));
}

// ─── worthRetranslating (the retranslation value filter) ─────────────────────

{
  // A meaning/terminology problem (HIGH) is always worth a whole-chapter rewrite.
  assert.strictEqual(worthRetranslating({ score: 72, findings: "- [HIGH] wrong rendering" }, 70), true);
  // A deterministic-QA failure (residue / truncation / empty) is never cosmetic.
  assert.strictEqual(worthRetranslating({ score: null, deterministic: true, findings: "1. fix" }, 70), true);
  // An unparseable score carries no information — retry it.
  assert.strictEqual(worthRetranslating({ score: null, findings: "" }, 70), true);
  // A hair under the line with only cosmetic findings is a copy-edit, not a rewrite.
  assert.strictEqual(worthRetranslating({ score: 68, findings: "- [LOW] awkward phrasing" }, 70), false);
  // Well under the line is worth rewriting whatever the bands are.
  assert.strictEqual(worthRetranslating({ score: 40, findings: "- [MEDIUM] tense drift" }, 70), true);
  assert.strictEqual(worthRetranslating({ score: 68, findings: "- [MEDIUM] tense drift" }, 70, 0), true, "margin 0 retranslates every FAIL");
}

// ─── estimateTokens / fitPromptBudget (honest trimming) ──────────────────────

{
  // Latin text: ~0.35 tokens per char. CJK: ~1 token per char. The estimate is a
  // deliberate over-estimate, so it must never come out LOWER than the char count
  // for CJK (a kanji is often more than one token).
  assert.strictEqual(estimateTokens(""), 0);
  assert.strictEqual(estimateTokens("abcdefghij"), 4, "10 latin chars × 0.35 → 4");
  assert.strictEqual(estimateTokens("日本語です"), 5, "CJK ≈ 1 token per char");
  assert.ok(estimateTokens("これは日本語です") >= 8, "CJK is never under-estimated");
  assert.ok(
    estimateTokens("日本語です " + "hello world hello world") >
      estimateTokens("hello world hello world"),
    "adding CJK raises the estimate"
  );

  // Everything fits: nothing is dropped, nothing is rewritten.
  const roomy = fitPromptBudget({
    blocks: [
      { name: "glossary", text: '"A" → "a"\n"B" → "b"', priority: 5 },
      { name: "story background", text: "The plot.", priority: 2 },
    ],
    fixedTokens: 100,
    roleWindow: 8000,
    outputReserve: 2000,
  });
  assert.deepStrictEqual(roomy.dropped, [], "a roomy window drops nothing");
  assert.strictEqual(roomy.blocks.length, 2);
  assert.ok(roomy.blocks[0].text.includes('"A" → "a"'));
  assert.strictEqual(roomy.fits, true);

  // Too small for everything: the LEAST useful block is cut first, and the cut is
  // reported (never silent).
  const longLine = "x".repeat(200);
  const tight = fitPromptBudget({
    blocks: [
      { name: "glossary", text: '"A" → "a"', priority: 5 },
      { name: "story background", text: [longLine, longLine, longLine].join("\n"), priority: 2 },
      { name: "voice notes", text: [longLine, longLine].join("\n"), priority: 1 },
    ],
    fixedTokens: 900,
    roleWindow: 1200,
    outputReserve: 100,
  });
  assert.ok(tight.dropped.length > 0, "a window with no room reports what it dropped");
  const keptNames = tight.blocks.map((b) => b.name);
  assert.ok(keptNames.includes("glossary"), "the highest-priority block survives whole");
  assert.ok(!keptNames.includes("voice notes"), "the least useful block is dropped first");
  assert.strictEqual(tight.fits, false, "the caller is told the source alone does not fit");

  // A partial keep cuts WHOLE lines from the end and says how many went missing.
  const partial = fitPromptBudget({
    blocks: [
      {
        name: "glossary",
        text: Array.from({ length: 200 }, (_, i) => `"term${i}" → "rendering${i}"`).join("\n"),
        priority: 5,
      },
    ],
    fixedTokens: 0,
    roleWindow: 600,
    outputReserve: 100,
  });
  assert.ok(partial.blocks[0].text.includes("further line(s) of the glossary were dropped"), "the truncation is announced in the text");
  assert.ok(partial.blocks[0].text.includes('"term0"'), "the head of the list survives");
  assert.ok(!partial.blocks[0].text.includes('"term199"'), "the tail is what goes");
  assert.ok(partial.dropped[0].chars > 0, "the dropped size is reported");

  // The task-line builder carries the decision through: a squeezed chapter keeps
  // its terminology and loses its atmosphere.
  const budgeted = buildBudgetedTaskLines({
    terminologyLines: ['"ソラ" → "Sora"'],
    background: "A very long background. ".repeat(400),
    styleRules: "House rule.",
    sourceText: "本文です",
    template: "{{SOURCE_TEXT}}\n{{TASKS}}",
    roleWindow: 900,
    outputReserve: 400,
    label: "test chapter",
  });
  assert.ok(budgeted.tasks.some((t) => t.includes('"ソラ" → "Sora"')), "terminology survives the squeeze");
  assert.ok(!budgeted.tasks.some((t) => t.includes("A very long background")), "the background was dropped");
  assert.ok(budgeted.dropped.some((d) => d.name === "story background"), "the drop is reported to the caller");

  const roomyTasks = buildBudgetedTaskLines({
    terminologyLines: ['"ソラ" → "Sora"'],
    background: "The plot.",
    styleRules: "House rule.",
    voiceNotes: "She says ya.",
    sourceText: "本文です",
    template: "{{SOURCE_TEXT}}\n{{TASKS}}",
    roleWindow: 32000,
    outputReserve: 4000,
  });
  assert.deepStrictEqual(roomyTasks.dropped, [], "a roomy window drops nothing");
  assert.ok(roomyTasks.tasks.some((t) => t.includes("She says ya.")), "voice notes survive when there is room");
}

// ─── chapterContextHash (per-chapter invalidation) ───────────────────────────

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-chash-"));
  const glossary = [
    "# Glossary",
    "",
    "## Characters",
    "",
    "| Term | Rendering | Notes |",
    "|---|---|---|",
    "| ソラ | Sora | protagonist |",
    "| 黒鋼 | Kurogane | the other one |",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "glossary.md"), glossary, "utf8");
  fs.writeFileSync(path.join(dir, "style-guide.md"), "# Style\n- Keep honorifics.\n", "utf8");
  fs.writeFileSync(path.join(dir, "character-voice.md"), "# Voices\n- Sora: formal.\n", "utf8");

  const chapterA = "ソラは部屋を見た。";
  const chapterB = "黒鋼は部屋を見た。";

  const refs1 = await loadVolumeReferences(dir);
  const hashA1 = chapterContextHash(refs1, chapterA);
  const hashB1 = chapterContextHash(refs1, chapterB);
  assert.notStrictEqual(hashA1, hashB1, "two chapters with different terms have different keys");

  // Edit a term chapter A never says: A's key is UNCHANGED (its draft survives),
  // B's key changes (its draft must be re-made). This is the whole point — the
  // volume-level hash changes for both, which is what used to re-translate a
  // whole 17-volume series for one renamed side character.
  fs.writeFileSync(
    path.join(dir, "glossary.md"),
    glossary.replace("| 黒鋼 | Kurogane | the other one |", "| 黒鋼 | Blacksteel | renamed |"),
    "utf8"
  );
  const refs2 = await loadVolumeReferences(dir);
  assert.strictEqual(chapterContextHash(refs2, chapterA), hashA1, "an unrelated glossary edit leaves chapter A's key alone");
  assert.notStrictEqual(chapterContextHash(refs2, chapterB), hashB1, "the chapter that DOES use the term invalidates");
  assert.notStrictEqual(refs2.contextHash, refs1.contextHash, "the volume-level key still changes for both (the fast path)");

  // A term added to the glossary that chapter A contains: A invalidates.
  fs.writeFileSync(
    path.join(dir, "glossary.md"),
    glossary.replace("| 黒鋼 | Kurogane | the other one |", "| 黒鋼 | Kurogane | the other one |\n| 部屋 | room | a room |"),
    "utf8"
  );
  const refs3 = await loadVolumeReferences(dir);
  assert.notStrictEqual(chapterContextHash(refs3, chapterA), hashA1, "a new term this chapter uses invalidates it");

  // The non-glossary references are injected whole, so changing them invalidates
  // every chapter — same as before.
  fs.writeFileSync(path.join(dir, "style-guide.md"), "# Style\n- Drop honorifics.\n", "utf8");
  const refs4 = await loadVolumeReferences(dir);
  assert.notStrictEqual(chapterContextHash(refs4, chapterA), hashA1, "a style-guide change invalidates the chapter");
  assert.notStrictEqual(refs4.sharedContextHash, refs1.sharedContextHash);

  fs.rmSync(dir, { recursive: true, force: true });
})();

// ─── checkChapterListConsistency (the handoff vs the extraction) ─────────────

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-chlist-"));
  const bundle = { segments: [{ id: "ch1", file: "b-ch1.md" }, { id: "ch1.1", file: "b-ch1.1.md" }] };

  // No chapters.json yet (the wiki task has not run): not a disagreement.
  const none = await checkChapterListConsistency(dir, bundle);
  assert.strictEqual(none.ok, true, "no chapters.json is not a failure");

  fs.writeFileSync(
    path.join(dir, "chapters.json"),
    JSON.stringify({ chapters: [{ id: "ch1", file: "b-ch1.md" }, { id: "ch1.1", file: "b-ch1.1.md" }] }),
    "utf8"
  );
  const agree = await checkChapterListConsistency(dir, bundle);
  assert.deepStrictEqual(agree, { ok: true, missing: [], extra: [], reason: "" }, "matching lists agree");

  // The source changed (an interlude appeared) and the handoff was never refreshed:
  // the mismatch is reported, in both directions.
  const grown = {
    segments: [
      { id: "ch1", file: "b-ch1.md" },
      { id: "ch1.1", file: "b-ch1.1.md" },
      { id: "ch2", file: "b-ch2.md" },
    ],
  };
  const mismatch = await checkChapterListConsistency(dir, grown);
  assert.strictEqual(mismatch.ok, false, "a stale handoff is a disagreement");
  assert.deepStrictEqual(mismatch.missing, ["ch2"], "the chapter the handoff does not know about");

  fs.writeFileSync(
    path.join(dir, "chapters.json"),
    JSON.stringify({ chapters: [{ id: "ch1", file: "b-ch1.md" }, { id: "ch9", file: "b-ch9.md" }] }),
    "utf8"
  );
  const stale = await checkChapterListConsistency(dir, bundle);
  assert.strictEqual(stale.ok, false);
  assert.deepStrictEqual(stale.missing, ["ch1.1"], "this run has a chapter the handoff lost");
  assert.deepStrictEqual(stale.extra, ["ch9"], "the handoff lists a chapter this run cannot find");

  // A corrupt chapters.json must not crash the stage.
  fs.writeFileSync(path.join(dir, "chapters.json"), "{ not json", "utf8");
  const corrupt = await checkChapterListConsistency(dir, bundle);
  assert.strictEqual(corrupt.ok, true, "an unreadable handoff is not treated as a disagreement");

  fs.rmSync(dir, { recursive: true, force: true });
})();

// ─── findRenderingVariants (the deterministic drift scan) ────────────────────

{
  const terms = [
    { term: "鏡", rendering: "Mirror" },
    { term: "黒鋼", rendering: "Blacksteel" },
    { term: "ソラ", rendering: "Sora" },
    { term: "若葉", rendering: "Wakaba" },
    { term: "若葉", rendering: "Young Leaf" },
  ];
  const text =
    "The Mirror operated silently. Sora looked at Blacksteel, then at Black steel. " +
    "sora left the room. Two Mirrors stood there. The Wakaba Institute, then the Young Leaf Institute.";
  const findings = findRenderingVariants({ text, terms, targetLanguage: "English" });

  const bySeverity = (sev) => findings.filter((f) => f.severity === sev);

  // HIGH: the glossary gives one source term two renderings and the volume uses both.
  const high = bySeverity("HIGH");
  assert.strictEqual(high.length, 1, `one terminology conflict, got ${JSON.stringify(high)}`);
  assert.strictEqual(high[0].term, "若葉");
  assert.ok(high[0].variant.includes("Wakaba") && high[0].variant.includes("Young Leaf"));

  // MEDIUM: the canonical name written with an extra space.
  const medium = bySeverity("MEDIUM");
  assert.strictEqual(medium.length, 1, `one spacing variant, got ${JSON.stringify(medium)}`);
  assert.strictEqual(medium[0].term, "黒鋼");
  assert.strictEqual(medium[0].variant, "Black steel");

  // LOW: capitalisation drift, and a plural alongside the singular.
  const low = bySeverity("LOW");
  assert.ok(low.some((f) => f.term === "ソラ" && f.variant === "sora"), "capitalisation drift is reported");
  assert.ok(low.some((f) => f.term === "鏡" && f.variant === "Mirrors"), "a plural alongside the singular is reported");

  // A volume that uses only the canonical forms produces NOTHING — the scan must
  // not invent findings.
  const clean = findRenderingVariants({
    text: "The Mirror operated silently. Sora looked at Blacksteel. Sora left the room.",
    terms,
    targetLanguage: "English",
  });
  assert.deepStrictEqual(clean, [], `a clean volume reports nothing: ${JSON.stringify(clean)}`);

  // Hyphenation is the same class as spacing.
  const hyphen = findRenderingVariants({ text: "He shook Black-steel hand.", terms, targetLanguage: "English" });
  assert.ok(hyphen.some((f) => f.variant === "Black-steel"), "a hyphenated variant is caught");

  // Word boundaries: "Sora" must not be reported from "Soraque" or "Soran".
  assert.deepStrictEqual(
    findRenderingVariants({ text: "Soraque and Soran argued.", terms, targetLanguage: "English" }),
    [],
    "a longer word containing the rendering is not a variant"
  );

  // The report section renders the scan for a human reader.
  const section = renderVariantFindings(findings);
  assert.ok(section.includes("## Rendering variants (deterministic scan — no model call)"));
  assert.ok(section.includes("| HIGH | 若葉 |"));
  assert.strictEqual(renderVariantFindings([]), "", "nothing found → no section");
}

// ─── loadVolumeReferences: relevance-ordered injection ───────────────────────

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-refs-"));
  // A cumulative voice reference: the volume-1 cast at the TOP (where a
  // cumulative document keeps them forever), then 40 later characters.
  const cast = "### 主人公\n- speech: 〜である (formal)\n\n### 黒鋼\n- speech: 〜だぜ (rough)\n\n";
  const later = Array.from(
    { length: 40 },
    (_, i) => `### キャラクター${i}\n- speech: quirk ${i} ${"filler ".repeat(40)}`
  ).join("\n\n");
  fs.writeFileSync(path.join(dir, "character-voice.md"), "# Character Voice\n\n" + cast + later, "utf8");
  fs.writeFileSync(
    path.join(dir, "shared-wiki.md"),
    "# Shared Wiki\n\n## Volume 01 state\n- 主人公 met 黒鋼.\n\n" +
      Array.from({ length: 40 }, (_, i) => `## Volume ${i + 2} state\n- filler beat ${i} ${"more filler ".repeat(40)}`).join("\n\n"),
    "utf8"
  );

  const volumeText = "主人公は黒鋼と再会した。";
  const refs = await loadVolumeReferences(dir, volumeText);

  // The old rule (slice(0, 4000)) showed the FIRST characters in the file and
  // nothing else; with 40 later characters the volume-1 protagonists were the
  // ones dropped. Relevance keeps them whatever their position.
  assert.ok(refs.voiceNotes.includes("### 主人公"), "the volume-1 protagonist's voice notes are injected");
  assert.ok(refs.voiceNotes.includes("### 黒鋼"), "the second protagonist's voice notes are injected");
  assert.ok(refs.voiceNotes.includes("occurs in the text being processed"), "the injection says why these sections were chosen");
  assert.ok(refs.background.includes("## Volume 01 state"), "the wiki section this volume actually references is injected");
  assert.ok(refs.voiceNotes.length <= 4000 + 400, `voice notes stay inside their budget (${refs.voiceNotes.length})`);
  assert.ok(refs.background.length <= 8000 + 400, `background stays inside its budget (${refs.background.length})`);

  // Without the source text the old head-of-document behavior is kept.
  const legacy = await loadVolumeReferences(dir);
  assert.ok(!legacy.voiceNotes.includes("occurs in the text being processed"), "no source text → no relevance claim");

  // The selection rule is part of the fingerprint, so drafts built under the old
  // rule are invalidated once (the safe direction).
  assert.strictEqual(refs.contextHash.length, 64);
  assert.notStrictEqual(refs.contextHash, refs.sharedContextHash, "the glossary is excluded from the shared half");

  fs.rmSync(dir, { recursive: true, force: true });
})();

// ─── planTargetedRepair (fix the passage, not the chapter) ──────────────────

{
  const {
    paragraphBlocks,
    parseFindingItems,
    locateQuoteRange,
    planTargetedRepair,
    stitchParagraphs,
    buildPassageScopeLine,
  } = require("../utils/translate");

  assert.deepStrictEqual(paragraphBlocks("a\n\nb\n\n\nc  "), ["a", "b", "c"]);
  assert.deepStrictEqual(paragraphBlocks(""), []);

  // Findings are split into items, each carrying its own source quote.
  const findings = [
    "## Findings",
    '1. [HIGH] the second sentence is omitted',
    '   - Source: "正常な過熱ではない。"',
    '   - Translation: "normal overheating"',
    '   - Fix: translate the negation',
    "",
    '2. [LOW] awkward phrasing',
    '   - Source: "音もなく働いていた"',
    '   - Translation: "worked silently"',
    '   - Fix: prefer "had run silently"',
  ].join("\n");
  const items = parseFindingItems(findings);
  assert.strictEqual(items.length, 2, "two findings, not one blob");
  assert.strictEqual(items[0].quote, "正常な過熱ではない。", "each carries the span it points at");
  assert.ok(items[1].text.includes("awkward phrasing"));

  // Locating a quote: whitespace-insensitive, and a quote that spans two
  // paragraphs resolves to BOTH of them.
  const source = ["第一段落です。", "第二の段落に 改行が\n含まれます。", "第三段落です。"].join("\n\n");
  const blocks = paragraphBlocks(source);
  assert.deepStrictEqual(locateQuoteRange(blocks, "第二の段落に 改行が 含まれます。"), { start: 1, end: 1 }, "whitespace is collapsed on both sides");
  assert.deepStrictEqual(locateQuoteRange(blocks, "段落に 改行が\n含まれます。第三段落です。"), { start: 1, end: 2 }, "a cross-paragraph quote claims both paragraphs");
  assert.strictEqual(locateQuoteRange(blocks, "存在しない文章"), null, "a quote that is not in the source is not found");
  assert.strictEqual(locateQuoteRange(blocks, ""), null);

  const jaSource = [
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
  const oneFinding = [
    "## Findings",
    '1. [HIGH] the negation is omitted',
    '   - Source: "正常な過熱ではない。"',
    '   - Fix: translate it',
  ].join("\n");

  const plan = planTargetedRepair({ sourceText: jaSource, draftText: draft, findingsText: oneFinding });
  assert.strictEqual(plan.usable, true, "one located finding repairs one paragraph");
  assert.strictEqual(plan.blocks.length, 1);
  assert.deepStrictEqual([plan.blocks[0].start, plan.blocks[0].end], [1, 1]);
  assert.ok(plan.reason.includes("1/5 paragraphs"), plan.reason);

  // Stitching keeps every untouched paragraph byte-for-byte.
  const stitched = stitchParagraphs(paragraphBlocks(draft), plan.blocks, [
    "The seventh board's temperature exceeded the baseline. It was not normal overheating.",
  ]);
  assert.ok(stitched.includes("The laboratory was quiet."), "the paragraph before is untouched");
  assert.ok(stitched.includes("Sora said calmly."), "the paragraph after is untouched");
  assert.ok(stitched.includes("not normal overheating"), "the repaired paragraph is replaced");
  assert.strictEqual(paragraphBlocks(stitched).length, 5, "no paragraph was lost or duplicated");
  assert.throws(() => stitchParagraphs(paragraphBlocks(draft), plan.blocks, [""]), /no corrected text/, "an empty replacement fails loudly instead of deleting a paragraph");

  // Refusals — every one of them falls back to the whole-chapter pass.
  const ragged = planTargetedRepair({
    sourceText: jaSource,
    draftText: "The laboratory was quiet.\n\nThe seventh board was hot.\n\nSora spoke.",
    findingsText: oneFinding,
  });
  assert.strictEqual(ragged.usable, false, "a draft whose paragraphs do not line up with the source cannot be repaired in place");
  assert.ok(ragged.reason.includes("cannot be aligned"), ragged.reason);

  const unlocatable = planTargetedRepair({
    sourceText: jaSource,
    draftText: draft,
    findingsText: '1. [HIGH] something is wrong\n   - Source: "この文章はソース中に存在しない"',
  });
  assert.strictEqual(unlocatable.usable, false, "a finding whose quote is not in the source is structural");
  assert.ok(unlocatable.reason.includes("structural"), unlocatable.reason);

  const everywhere = planTargetedRepair({
    sourceText: jaSource,
    draftText: draft,
    findingsText: [
      '1. [HIGH] a\n   - Source: "研究所は静かだった。"',
      '2. [HIGH] b\n   - Source: "七番基板の温度が基準値を超えている。"',
      '3. [HIGH] c\n   - Source: "ソラは平静に言った。"',
      '4. [HIGH] d\n   - Source: "黒鋼は飛び起きた。"',
      '5. [HIGH] e\n   - Source: "そして沈黙が続いた。"',
    ].join("\n"),
  });
  assert.strictEqual(everywhere.usable, false, "when every paragraph is affected, a whole-chapter pass is cheaper and safer");
  assert.ok(everywhere.reason.includes("every paragraph"), everywhere.reason);

  const implausible = planTargetedRepair({
    sourceText: jaSource,
    draftText: [
      "The laboratory was quiet.",
      "A completely unrelated sentence that has nothing whatsoever to do with the source paragraph it would be swapped for, " +
        "written at length so the length check can see that this draft paragraph is not a rendering of that source span at all.",
      "Sora said calmly.",
      "Kurogane jumped up.",
      "Then the silence went on.",
    ].join("\n\n"),
    findingsText: oneFinding,
  });
  assert.strictEqual(implausible.usable, false, "a draft paragraph that is not a plausible rendering of its source span means the alignment is wrong");
  assert.ok(implausible.reason.includes("length ratio"), implausible.reason);

  // Nearby findings merge into ONE passage pass (a call per sentence would cost
  // more than it saves); distant ones stay separate.
  const twoNear = planTargetedRepair({
    sourceText: jaSource,
    draftText: draft,
    findingsText: [
      '1. [HIGH] a\n   - Source: "七番基板の温度が基準値を超えている。"',
      '2. [HIGH] b\n   - Source: "正常な過熱ではない。"',
      '3. [HIGH] c\n   - Source: "そして沈黙が続いた。"',
    ].join("\n"),
  });
  assert.strictEqual(twoNear.blocks.length, 2, "the two adjacent findings become one passage, the distant one stays its own");
  assert.deepStrictEqual([twoNear.blocks[0].start, twoNear.blocks[0].end], [1, 1]);
  assert.deepStrictEqual([twoNear.blocks[1].start, twoNear.blocks[1].end], [4, 4]);

  // A finding with NO locatable span is chapter-wide: it must reach every
  // passage pass, or the shortcut would silently drop a real problem.
  const mixed = planTargetedRepair({
    sourceText: jaSource,
    draftText: draft,
    findingsText: [
      '1. [HIGH] a\n   - Source: "研究所は静かだった。"',
      '2. [HIGH] the whole chapter reads too formally (no quote)',
    ].join("\n"),
  });
  assert.strictEqual(mixed.usable, true);
  assert.ok(
    mixed.blocks.every((b) => b.findings.some((f) => f.includes("too formally"))),
    "the unlocatable finding is carried into every passage pass"
  );

  // The scope line: the model must know it is correcting a passage of a longer
  // chapter, and must not re-translate the neighbours it was shown.
  const scope = buildPassageScopeLine({
    before: "The laboratory was quiet.",
    after: "Sora said calmly.",
    blockNumber: 1,
    blockCount: 2,
  });
  assert.ok(scope.includes("ONE passage (1 of 2)"), scope);
  assert.ok(scope.includes("do not repeat it"), "the preceding text is context, not output");
  assert.ok(scope.includes("do not translate it"), "and so is the following text");
  assert.ok(!buildPassageScopeLine({ blockNumber: 1, blockCount: 1 }).includes("FOLLOWS"), "no neighbours, no neighbour lines");
}

// ─── cjkRatio / countOccurrences ──────────────────────────────────────────────

{
  assert.strictEqual(cjkRatio("hello world"), 0);
  assert.strictEqual(cjkRatio("これは日本語です"), 1);
  const mixed = cjkRatio("abc 日本 def");
  assert.ok(Math.abs(mixed - 2 / 8) < 1e-9, `mixed ratio: ${mixed}`);
  assert.strictEqual(cjkRatio(""), 0);
  assert.strictEqual(cjkRatio("   \n "), 0);

  assert.strictEqual(countOccurrences("ソラはソラを見た", "ソラ"), 2);
  assert.strictEqual(countOccurrences("nothing", "ソラ"), 0);
  assert.strictEqual(countOccurrences("", "x"), 0);
  assert.strictEqual(countOccurrences("text", ""), 0);
}

// ─── selectTermsForChapter / chapterTerminology ───────────────────────────────

{
  // The cumulative glossary grows with the SERIES; a chapter's prompt must see
  // only the terms this chapter can actually render.
  const cumulative = [
    { term: "ソラ", rendering: "Sora", section: "Characters" },
    { term: "黒鋼", rendering: "Kurogane", section: "Characters" },
    { term: "魔法学園", rendering: "Magic Academy", section: "Places" },
    { term: "端末", rendering: "terminal", section: "Items" },
  ];
  const chapter = "ソラは黒鋼さんを見た。";

  const sel = selectTermsForChapter(cumulative, chapter, { maxChars: 100000 });
  assert.deepStrictEqual(
    sel.terms.map((t) => t.term),
    ["ソラ", "黒鋼"],
    "terms absent from this chapter are dropped (魔法学園 / 端末)"
  );
  assert.strictEqual(sel.present, 2);
  assert.strictEqual(sel.dropped, 2);

  // Substring matching means an honorific suffix still counts as the term.
  assert.deepStrictEqual(
    selectTermsForChapter(cumulative, "黒鋼さん", { maxChars: 100000 }).terms.map((t) => t.term),
    ["黒鋼"],
    "黒鋼さん contains the glossary term 黒鋼"
  );

  // The character budget caps the block and reports what it dropped.
  const capped = selectTermsForChapter(cumulative, "ソラ 黒鋼 魔法学園 端末", { maxChars: 40 });
  assert.ok(capped.terms.length >= 1 && capped.terms.length < 4, `capped to ${capped.terms.length}`);
  assert.strictEqual(capped.dropped, 4 - capped.terms.length);
  assert.ok(capped.usedChars <= 40, `usedChars ${capped.usedChars} stays under the budget`);

  assert.deepStrictEqual(selectTermsForChapter(null, "x").terms, []);
  assert.deepStrictEqual(selectTermsForChapter([], "").terms, []);

  // chapterTerminology renders the prompt lines from the same selection.
  const ct = chapterTerminology({ terms: cumulative }, chapter, { maxChars: 100000 });
  assert.deepStrictEqual(ct.lines, ['"ソラ" translates to "Sora"', '"黒鋼" translates to "Kurogane"']);
  assert.deepStrictEqual(chapterTerminology(null, "x").lines, []);
}

// ─── checkTranslationQa ───────────────────────────────────────────────────────

{
  const terms = [
    { term: "ソラ", rendering: "Sora" },
    { term: "黒鋼", rendering: "Kurogane" },
  ];
  const source = "ソラは黒鋼を見た。部屋は静かだった。誰も起きていなかった。";

  // Good translation: passes, both renderings present.
  const good = checkTranslationQa({
    sourceText: source,
    draftText: "Sora looked at Kurogane. The room was quiet. No one was awake.",
    terms,
  });
  assert.strictEqual(good.ok, true, JSON.stringify(good.errors));
  assert.strictEqual(good.missingTerms.length, 0);
  assert.ok(good.lengthRatio >= 0.6 && good.lengthRatio <= 2.5, `ratio ${good.lengthRatio}`);

  // Source echoed back: hard failure (CJK ratio).
  const echoed = checkTranslationQa({ sourceText: source, draftText: source, terms });
  assert.strictEqual(echoed.ok, false);
  assert.ok(echoed.cjk > 0.05);

  // Missing rendering: warning, still ok.
  const partial = checkTranslationQa({
    sourceText: source,
    draftText: "Sora looked at the man.",
    terms,
  });
  assert.strictEqual(partial.ok, true);
  assert.strictEqual(partial.missingTerms.length, 1);
  assert.strictEqual(partial.missingTerms[0].term, "黒鋼");

  // Empty draft: hard failure.
  assert.strictEqual(checkTranslationQa({ sourceText: source, draftText: "", terms }).ok, false);

  // Short-but-plausible draft (length ratio in the 0.4–0.6 band): a warning,
  // still ok (a compact but complete rendering).
  const shortWarn = checkTranslationQa({ sourceText: source, draftText: "Sora looked.", terms });
  assert.strictEqual(shortWarn.ok, true);
  assert.ok(shortWarn.warnings.some((w) => w.includes("length ratio")));

  // Grossly short draft (under 40% of the source length): a truncated response
  // is a hard failure (#1), not just a warning.
  const truncated = checkTranslationQa({ sourceText: source, draftText: "Yes.", terms });
  assert.strictEqual(truncated.ok, false);
  assert.ok(truncated.errors.some((e) => e.includes("truncated")));
}

// ─── multi-language residue / length / matching ────────────────────────────────
{
  const { residueRatio, isSpaceSeparated, lengthBands, countOccurrences } = require("../utils/translate");

  // JA→EN: kana + Han are both residue (≈ the legacy CJK ratio).
  assert.ok(residueRatio("日本語", "Japanese", "English") > 0.9, "Japanese text is residue for EN");
  assert.ok(residueRatio("hello world", "Japanese", "English") === 0, "Latin text has no residue");

  // JA→ZH: Han is shared, so only KANA is residue. A Han-only draft has NO
  // residue for a Chinese target even though it is all CJK.
  assert.strictEqual(residueRatio("日本語", "Japanese", "Chinese"), 0, "Han-only is not residue for a ZH target");
  assert.ok(residueRatio("あいう", "Japanese", "Chinese") > 0.9, "kana IS residue for a ZH target");

  // KO→EN: Hangul is residue (the CJK class does not even cover it).
  assert.ok(residueRatio("안녕하세요", "Korean", "English") > 0.9, "Hangul is residue for EN");
  assert.strictEqual(residueRatio("안녕하세요", "Japanese", "English"), 0, "Hangul is not residue for a JA source");

  // ZH→EN: Han is residue.
  assert.ok(residueRatio("中文", "Chinese", "English") > 0.9, "Han is residue for EN");

  // A target that shares the source script yields zero residue (identity pair).
  assert.strictEqual(residueRatio("日本語", "Japanese", "Japanese"), 0, "identity pair has no residue");

  // isSpaceSeparated drives word-boundary term matching.
  assert.strictEqual(isSpaceSeparated("Korean"), true);
  assert.strictEqual(isSpaceSeparated("English"), true);
  assert.strictEqual(isSpaceSeparated("Japanese"), false);
  assert.strictEqual(isSpaceSeparated("Chinese"), false);

  // Word-boundary matching avoids over-counting ("he" inside "the").
  assert.strictEqual(countOccurrences("the he she thehe", "he", { wordBoundary: false }), 5, "substring over-counts");
  assert.strictEqual(countOccurrences("the he she thehe", "he", { wordBoundary: true }), 1, "word-boundary counts only whole words");

  // Length bands differ per pair and are overridable.
  const jaEn = lengthBands("Japanese", "English");
  const zhEn = lengthBands("Chinese", "English");
  assert.ok(zhEn.max > jaEn.max, "ZH→EN allows a longer draft than JA→EN");
  const saved = process.env.TRANSLATION_LENGTH_RATIO;
  process.env.TRANSLATION_LENGTH_RATIO = "1.0-3.0";
  const overridden = lengthBands("Japanese", "English");
  assert.deepStrictEqual({ min: overridden.min, max: overridden.max }, { min: 1, max: 3 }, "TRANSLATION_LENGTH_RATIO overrides the band");
  if (saved === undefined) delete process.env.TRANSLATION_LENGTH_RATIO; else process.env.TRANSLATION_LENGTH_RATIO = saved;

  // End-to-end: a Korean source translated to English passes, and a draft that
  // keeps Hangul fails.
  const koSrc = "안녕하세요. 오늘 날씨가 좋습니다.";
  const koGood = checkTranslationQa({ sourceText: koSrc, draftText: "Hello. The weather is nice today.", sourceLanguage: "Korean", targetLanguage: "English" });
  assert.strictEqual(koGood.ok, true, JSON.stringify(koGood.errors));
  const koEcho = checkTranslationQa({ sourceText: koSrc, draftText: koSrc, sourceLanguage: "Korean", targetLanguage: "English" });
  assert.strictEqual(koEcho.ok, false, "a Korean draft echoed back is residue for EN");
  assert.ok(koEcho.cjk > 0.05);
}

// ─── buildPolishGuardFindings ─────────────────────────────────────────────────

{
  // Clean result: the fallback marker (callers only use this for failures).
  assert.strictEqual(
    buildPolishGuardFindings({ errors: [], warnings: [], missingTerms: [] }),
    "(no deterministic findings)"
  );

  // Missing fields: fail-open, same fallback.
  assert.strictEqual(buildPolishGuardFindings({}), "(no deterministic findings)");

  // Guard rejection: errors + missing terms become HIGH correction tasks,
  // warnings become MEDIUM — the numbered list the re-polish prompt receives.
  const findings = buildPolishGuardFindings({
    errors: ["CJK ratio 6.0% — the draft still looks like source text"],
    warnings: ["length ratio 0.40 outside the 0.6–2.5 band"],
    missingTerms: [{ term: "黒鋼", rendering: "Kurogane" }],
  });
  const lines = findings.split("\n");
  assert.strictEqual(lines.length, 3, findings);
  assert.ok(lines[0].startsWith("- [HIGH] CJK ratio 6.0%"), lines[0]);
  assert.ok(lines[1].includes('"黒鋼" → "Kurogane"'), lines[1]);
  assert.ok(lines[1].startsWith("- [HIGH]"), lines[1]);
  assert.ok(lines[2].startsWith("- [MEDIUM] length ratio 0.40"), lines[2]);
}

// ─── mergeVolumeTranslation ───────────────────────────────────────────────────

{
  const segments = [
    { id: "ch1", title: "Chapter One" },
    { id: "ch2", title: "" },
    { id: "ch3", title: "Chapter Three" },
  ];
  const merged = mergeVolumeTranslation({
    segments,
    getText: (seg) => (seg.id === "ch3" ? null : `text-${seg.id}`),
  });
  assert.strictEqual(merged, "# Chapter One\n\ntext-ch1\n\ntext-ch2\n");
  assert.strictEqual(mergeVolumeTranslation({ segments, getText: () => null }), "");

  // The heading rules that used to produce a broken book.
  // 1. The translator already rendered the title that was in the source: adding
  //    the source-language title on top gives two headings, one untranslated.
  const alreadyHeaded = mergeVolumeTranslation({
    segments: [{ id: "ch1", title: "第一章" }],
    getText: () => "# Chapter One\n\nThe story begins.",
  });
  assert.strictEqual(alreadyHeaded, "# Chapter One\n\nThe story begins.\n", "no duplicated heading, and no untranslated one");

  // 2. A "title" that is only a file name must never be printed as a chapter title.
  const fileNamed = mergeVolumeTranslation({
    segments: [{ id: "whole", title: "test_story(1).md", syntheticTitle: true }],
    getText: () => "The story begins.",
  });
  assert.strictEqual(fileNamed, "The story begins.\n", "a file name is not a chapter heading");

  // 3. A pipeline label ("Part 3 of 12") is not a chapter of the book either.
  const sliced = mergeVolumeTranslation({
    segments: [{ id: "part-03", title: "Part 3 of 12", syntheticTitle: true }],
    getText: () => "More text.",
  });
  assert.strictEqual(sliced, "More text.\n", "a slice label is not printed as a heading");

  // 4. A title still written in the SOURCE language must not be printed above an
  //    English chapter: the translator rendered it its own way, and adding the
  //    Japanese original puts a foreign line at the top of the published book.
  const sourceTitled = mergeVolumeTranslation({
    segments: [{ id: "whole", title: "ソラの初夜勤" }],
    getText: () => "**Sora's First Night Shift**\n\nThe story begins.",
    sourceLanguage: "Japanese",
    targetLanguage: "English",
  });
  assert.strictEqual(sourceTitled, "**Sora's First Night Shift**\n\nThe story begins.\n", "no untranslated heading is injected");
  // The same title, when the pair is the same language, is fine to print.
  assert.ok(
    headingForSegment({ title: "ソラの初夜勤" }, "本文", { sourceLanguage: "Japanese", targetLanguage: "Japanese" }),
    "a same-language title is not residue"
  );
  assert.strictEqual(
    headingForSegment({ title: "第一章" }, "text", { sourceLanguage: "Japanese", targetLanguage: "English" }),
    null,
    "a source-script title is refused"
  );

  // 5. A real declared title with no heading in the text: print it.
  assert.strictEqual(headingForSegment({ title: "Prologue" }, "text"), "# Prologue");
  assert.strictEqual(headingForSegment({ title: "Prologue" }, "## Prologue\ntext"), null, "the text's own heading wins");
  assert.strictEqual(headingForSegment({ title: "" }, "text"), null);
  assert.strictEqual(headingForSegment({ title: "x", syntheticTitle: true }, "text"), null);
}

// ─── findMissingSegments (the merged-volume completeness gate) ───────────────

{
  const segments = [
    { id: "ch1", title: "Chapter One" },
    { id: "ch2", title: "Chapter Two" },
    { id: "ch3", title: "Chapter Three" },
  ];
  // The bug this pins: mergeVolumeTranslation silently skips a chapter with no
  // text, so translation.md shipped with chapter 2 missing and the merge still
  // reported success.
  assert.deepStrictEqual(
    findMissingSegments(segments, (seg) => (seg.id === "ch2" ? null : `text-${seg.id}`)),
    [{ id: "ch2", title: "Chapter Two" }],
    "a chapter with no text is reported, not skipped in silence"
  );
  assert.deepStrictEqual(
    findMissingSegments(segments, () => "   \n "),
    segments.map((s) => ({ id: s.id, title: s.title })),
    "whitespace-only text counts as missing"
  );
  assert.deepStrictEqual(findMissingSegments(segments, (seg) => `text-${seg.id}`), [], "complete volume → nothing missing");
  assert.deepStrictEqual(findMissingSegments([], () => "x"), []);
  assert.deepStrictEqual(findMissingSegments(null, () => "x"), []);
  // A segment with no title falls back to its id in the report.
  assert.deepStrictEqual(findMissingSegments([{ id: "ch9" }], () => null), [{ id: "ch9", title: "ch9" }]);
}

// ─── stripMarkdownFence / tailOf ──────────────────────────────────────────────

{
  assert.strictEqual(stripMarkdownFence("```\nhello\n```"), "hello");
  assert.strictEqual(stripMarkdownFence("```en\nhello\n```"), "hello");
  assert.strictEqual(stripMarkdownFence("plain text"), "plain text");
  // Only strips when the WHOLE output is fenced.
  assert.strictEqual(
    stripMarkdownFence("before\n```\ncode\n```\nafter"),
    "before\n```\ncode\n```\nafter"
  );
  assert.strictEqual(stripMarkdownFence(""), "");

  assert.strictEqual(tailOf("short", 400), "short");
  const long = "a".repeat(1000);
  const tail = tailOf(long, 400);
  assert.strictEqual(tail.length, 401, "ellipsis + 400 chars");
  assert.ok(tail.startsWith("…"));
  assert.strictEqual(tailOf("", 400), "");
  assert.strictEqual(tailOf(long, 0), "", "0 = off (no continuity tail)");
}

// ─── roleEndpoint ─────────────────────────────────────────────────────────────

{
  const prev = {};
  const keys = ["TRANSLATE_BASE_URL", "TRANSLATE_API_KEY", "TRANSLATE_MODEL"];
  for (const k of keys) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  const prevAi = { url: process.env.AI_BASE_URL, model: process.env.AI_MODEL };
  process.env.AI_BASE_URL = "http://fallback/v1";
  process.env.AI_MODEL = "fallback-model";
  const ep = roleEndpoint("TRANSLATE");
  assert.strictEqual(ep.baseUrl, "http://fallback/v1", "falls back to AI_BASE_URL");
  assert.strictEqual(ep.model, "fallback-model", "falls back to AI_MODEL");

  process.env.TRANSLATE_BASE_URL = "http://role/v1";
  process.env.TRANSLATE_MODEL = "role-model";
  const ep2 = roleEndpoint("TRANSLATE");
  assert.strictEqual(ep2.baseUrl, "http://role/v1", "role var wins");
  assert.strictEqual(ep2.model, "role-model", "role var wins");

  // Per-role context window and output cap: a stage running on a server with a
  // SMALLER context than the global AI_* model cannot use the global cap.
  delete process.env.TRANSLATE_CONTEXT_WINDOW;
  delete process.env.TRANSLATE_MAX_TOKENS;
  assert.strictEqual(ep2.contextWindow, null, "no role context window → the global one is used");
  assert.strictEqual(ep2.maxTokens, null, "no role cap → the harness derives one");
  process.env.TRANSLATE_CONTEXT_WINDOW = "16384";
  const ep3 = roleEndpoint("TRANSLATE");
  assert.strictEqual(ep3.contextWindow, 16384, "the role's own context window is reported");
  assert.strictEqual(ep3.contextWindowSource, "TRANSLATE_CONTEXT_WINDOW");
  process.env.TRANSLATE_MAX_TOKENS = "4096";
  const ep4 = roleEndpoint("TRANSLATE");
  assert.strictEqual(ep4.maxTokens, 4096, "the role's own output cap wins");
  assert.strictEqual(ep4.maxTokensSource, "TRANSLATE_MAX_TOKENS");
  delete process.env.TRANSLATE_MAX_TOKENS;
  assert.strictEqual(
    ep3.maxTokensSource && roleEndpoint("TRANSLATE").maxTokensSource,
    "derived from TRANSLATE_CONTEXT_WINDOW",
    "with a role window but no role cap, the cap is derived from the role window"
  );
  delete process.env.TRANSLATE_CONTEXT_WINDOW;
  for (const k of keys) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  if (prevAi.url === undefined) delete process.env.AI_BASE_URL;
  else process.env.AI_BASE_URL = prevAi.url;
  if (prevAi.model === undefined) delete process.env.AI_MODEL;
  else process.env.AI_MODEL = prevAi.model;
}

// ─── qaLoopDecision (the translate-qa loop's stop rules) ────────────────────

{
  // after-verify: zero FAILs → stop (all-pass), even at the round cap.
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-verify", round: 3, maxRounds: 3, failed: 0 }),
    { stop: true, reason: "all-pass" }
  );
  // A chapter with NO draft was never verified at all. Counting it as a pass is
  // how the loop used to report "all-pass" over an untranslated volume — and
  // looping cannot fix it either (there is nothing to retranslate), so the loop
  // says so plainly instead of burning rounds.
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-verify", round: 1, maxRounds: 3, failed: 0, noDraft: 4 }),
    { stop: true, reason: "missing-drafts" },
    "noDraft chapters stop the loop with their own reason"
  );
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-verify", round: 3, maxRounds: 3, failed: 0, noDraft: 4 }),
    { stop: true, reason: "missing-drafts" },
    "untranslated chapters reach the round cap, never 'all-pass'"
  );
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-verify", round: 1, maxRounds: 3, failed: 1, noDraft: 2 }),
    { stop: false, reason: null }
  );
  // after-verify: FAILs remain and the round cap is hit → stop (round-limit).
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-verify", round: 3, maxRounds: 3, failed: 2 }),
    { stop: true, reason: "round-limit" }
  );
  // after-verify: FAILs remain and rounds remain → continue.
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-verify", round: 2, maxRounds: 3, failed: 2 }),
    { stop: false, reason: null }
  );
  // after-retranslate: nothing applied → stop (stalled).
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-retranslate", round: 1, maxRounds: 3, retranslated: 0 }),
    { stop: true, reason: "stalled" }
  );
  // after-verify: the draft ratchet rolled back EVERY failing chapter to a
  // better earlier draft — the loop is moving the book backwards, so stop
  // before paying for another round of the same.
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-verify", round: 1, maxRounds: 3, failed: 3, noImprovement: 3 }),
    { stop: true, reason: "no-improvement" }
  );
  // …but one regression among many fixable chapters is not a reason to stop.
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-verify", round: 1, maxRounds: 3, failed: 9, noImprovement: 1 }),
    { stop: false, reason: null }
  );
  // after-retranslate: something applied → continue to the next verify batch.
  // (In the actual loop this phase is only reached with round < maxRounds —
  // the cap is checked before the retranslate half, so every applied
  // correction is always followed by a fresh verification.)
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-retranslate", round: 2, maxRounds: 3, retranslated: 4 }),
    { stop: false, reason: null }
  );
  // Unknown phase → fail loudly.
  assert.throws(() => qaLoopDecision({ phase: "nope", round: 1, maxRounds: 3 }), /unknown phase/);
}

// ─── qaMaxRounds ──────────────────────────────────────────────────────────────

{
  const prev = process.env.TRANSLATE_QA_MAX_ROUNDS;
  delete process.env.TRANSLATE_QA_MAX_ROUNDS;
  assert.strictEqual(qaMaxRounds(), 3, "default is 3");
  process.env.TRANSLATE_QA_MAX_ROUNDS = "7";
  assert.strictEqual(qaMaxRounds(), 7, "env var wins");
  process.env.TRANSLATE_QA_MAX_ROUNDS = "0";
  assert.strictEqual(qaMaxRounds(), 1, "clamped to a minimum of 1");
  process.env.TRANSLATE_QA_MAX_ROUNDS = "junk";
  assert.strictEqual(qaMaxRounds(), 3, "invalid value falls back to the default");
  if (prev === undefined) delete process.env.TRANSLATE_QA_MAX_ROUNDS;
  else process.env.TRANSLATE_QA_MAX_ROUNDS = prev;
}

// ─── translation state (async, temp dir) ─────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-translate-"));
const stateFile = path.join(tmp, "translation-state.json");

(async () => {
  // Missing file: fail-open empty state.
  const empty = await loadTranslationState(stateFile);
  assert.deepStrictEqual(empty, { schema: 1, chapters: {} });

  // Round-trip.
  const state = {
    chapters: {
      ch1: {
        sourceHash: sha256("src"),
        contextHash: sha256("ctx"),
        draftHash: sha256("draft"),
        retranslated: false,
        findingsHash: null,
        polishedDraftHash: null,
      },
    },
  };
  await saveTranslationState(stateFile, state);
  const loaded = await loadTranslationState(stateFile);
  assert.deepStrictEqual(loaded.chapters.ch1, state.chapters.ch1);

  // Corrupt file: fail-open empty state.
  fs.writeFileSync(stateFile, "{not json", "utf8");
  assert.deepStrictEqual(await loadTranslationState(stateFile), { schema: 1, chapters: {} });

  // Wrong shape: fail-open empty state.
  fs.writeFileSync(stateFile, '{"foo": 1}', "utf8");
  assert.deepStrictEqual(await loadTranslationState(stateFile), { schema: 1, chapters: {} });

  // ─── stripContinuityOverlap ─────────────────────────────────────────────────
  {
    const prev = "The sword hummed as she lifted it, and the battle that followed would decide everything.";
    const repeated = prev + " And then the battle began.";
    // A full repeat of the previous tail is stripped (with leading space).
    assert.strictEqual(stripContinuityOverlap(prev, repeated), "And then the battle began.");
    // No overlap: unchanged.
    assert.strictEqual(
      stripContinuityOverlap(prev, "A totally different start to the story."),
      "A totally different start to the story."
    );
    // Overlap shorter than minOverlap is kept (coincidental short matches).
    assert.strictEqual(stripContinuityOverlap("abc", "abc def"), "abc def");
    // Empty inputs.
    assert.strictEqual(stripContinuityOverlap("", "text"), "text");
    assert.strictEqual(stripContinuityOverlap("prev", ""), "");
    // A re-phrase that shares only part of the tail is NEVER mangled.
    const nearMiss = prev.slice(0, -20) + "DIFFERENT ENDING OF THE SENTENCE.";
    assert.strictEqual(stripContinuityOverlap(prev, nearMiss), nearMiss);
  }

  // ─── runWithConcurrency ─────────────────────────────────────────────────────
  {
    const items = [1, 2, 3, 4, 5];
    // Order preservation + the limit is respected.
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await runWithConcurrency(items, 2, async (item, idx) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10 * (item % 3) + 1));
      inFlight -= 1;
      return idx * 10 + item;
    });
    assert.deepStrictEqual(results, [1, 12, 23, 34, 45]); // idx * 10 + item, in input order
    assert.ok(maxInFlight <= 2, `maxInFlight ${maxInFlight} exceeded the limit of 2`);
    assert.ok(maxInFlight >= 2, "expected at least 2 in flight (5 items, limit 2)");

    // limit 1 = exactly the old serial behaviour.
    let serialInFlight = 0;
    let serialMax = 0;
    await runWithConcurrency(items, 1, async () => {
      serialInFlight += 1;
      serialMax = Math.max(serialMax, serialInFlight);
      await new Promise((r) => setTimeout(r, 1));
      serialInFlight -= 1;
    });
    assert.strictEqual(serialMax, 1);

    // Error: the first error is rethrown; no further items are started.
    const seen = [];
    await assert.rejects(
      runWithConcurrency(items, 2, async (item) => {
        seen.push(item);
        if (item === 2) throw new Error("boom");
        await new Promise((r) => setTimeout(r, 5));
      }),
      /boom/
    );
    assert.ok(!seen.includes(3) && !seen.includes(4) && !seen.includes(5),
      `items past the failure were started: ${JSON.stringify(seen)}`);

    // Empty items: resolves with no work.
    assert.deepStrictEqual(await runWithConcurrency([], 3, async () => { throw new Error("no"); }), []);
  }

  // ─── stageConcurrency ───────────────────────────────────────────────────────
  {
    delete process.env.VERIFY_CONCURRENCY;
    assert.strictEqual(stageConcurrency("VERIFY"), 1); // default: serial
    process.env.VERIFY_CONCURRENCY = "4";
    assert.strictEqual(stageConcurrency("VERIFY"), 4);
    process.env.VERIFY_CONCURRENCY = "0";
    assert.strictEqual(stageConcurrency("VERIFY"), 1); // floored at 1
    process.env.VERIFY_CONCURRENCY = "abc";
    assert.strictEqual(stageConcurrency("VERIFY"), 1); // invalid → default
    delete process.env.VERIFY_CONCURRENCY;
  }

  // ─── assertWroteWithFallback contract (the recovery-turn gate) ──────────────
  {
    const { assertWroteWithFallback, assertRealOutput, isPlaceholderContent } = require("../utils/fs");
    const fbDir = path.join(tmp, "fb");
    fs.mkdirSync(fbDir, { recursive: true });
    const okFile = path.join(fbDir, "ok.md");
    fs.writeFileSync(okFile, "already written\n", "utf8");
    // File exists → false (the caller must NOT send a recovery turn).
    assert.strictEqual(await assertWroteWithFallback(okFile, "the test agent", "chat reply"), false);
    assert.strictEqual(fs.readFileSync(okFile, "utf8"), "already written\n"); // untouched

    // File missing + content → true, and the file is written from the content.
    const missingFile = path.join(fbDir, "missing.md");
    assert.strictEqual(
      await assertWroteWithFallback(missingFile, "the test agent", "recovered content"),
      true
    );
    assert.strictEqual(fs.readFileSync(missingFile, "utf8"), "recovered content");

    // File missing + no content → true (recovery still needed), nothing written.
    const noContentFile = path.join(fbDir, "nocontent.md");
    assert.strictEqual(await assertWroteWithFallback(noContentFile, "the test agent", ""), true);
    assert.ok(!fs.existsSync(noContentFile));

    // Multiple files: all present → false; one missing → true (and written).
    const a = path.join(fbDir, "a.md");
    const b = path.join(fbDir, "b.md");
    fs.writeFileSync(a, "a\n", "utf8");
    assert.strictEqual(await assertWroteWithFallback([a, b], "the test agent", "content"), true);
    assert.strictEqual(fs.readFileSync(b, "utf8"), "content");
    assert.strictEqual(await assertWroteWithFallback([a, b], "the test agent", "content"), false);
  }

  // ─── empty / scaffold-stub output is NOT "written" (utils/fs.js) ───────────
  {
    const { assertWroteWithFallback, assertRealOutput, isPlaceholderContent } = require("../utils/fs");
    const stubDir = path.join(tmp, "stub");
    fs.mkdirSync(stubDir, { recursive: true });

    // The pure detector.
    assert.strictEqual(isPlaceholderContent(null), true, "absent file");
    assert.strictEqual(isPlaceholderContent(""), true, "empty");
    assert.strictEqual(isPlaceholderContent("   \n  "), true, "whitespace only");
    assert.strictEqual(isPlaceholderContent("(stub — the agent replaces this with the wiki)\n"), true, "scaffold stub");
    assert.strictEqual(isPlaceholderContent("# Wiki\nreal content"), false, "real output");

    // An EMPTY file that exists must be treated as missing (the old check only
    // asked whether the path existed, so an interrupted run's 0-byte file was
    // finished work forever).
    const emptyFile = path.join(stubDir, "empty.md");
    fs.writeFileSync(emptyFile, "", "utf8");
    assert.strictEqual(
      await assertWroteWithFallback(emptyFile, "the test agent", "recovered"),
      true,
      "an empty file counts as missing"
    );
    assert.strictEqual(fs.readFileSync(emptyFile, "utf8"), "recovered");

    // A scaffold stub must be OVERWRITTEN by the fallback, not left alone.
    const stubFile = path.join(stubDir, "wiki.md");
    fs.writeFileSync(stubFile, "(stub — the agent replaces this with the complete volume wiki)\n", "utf8");
    assert.strictEqual(
      await assertWroteWithFallback(stubFile, "the wiki agent", "# Wiki\nreal content"),
      true,
      "a stub counts as missing"
    );
    assert.strictEqual(fs.readFileSync(stubFile, "utf8"), "# Wiki\nreal content");
    // …and once it holds real content, it is no longer missing.
    assert.strictEqual(await assertWroteWithFallback(stubFile, "the wiki agent", "x"), false);

    // A stub with no chat content to recover with → recovery turn needed.
    const stub2 = path.join(stubDir, "shared-wiki.md");
    fs.writeFileSync(stub2, "(stub — the merge pass replaces this with the complete shared wiki)\n", "utf8");
    assert.strictEqual(await assertWroteWithFallback(stub2, "the wiki agent", ""), true);

    // assertRealOutput is the hard stop after a recovery turn.
    await assertRealOutput(stubFile, "the wiki agent"); // real content: passes
    await assert.rejects(
      () => assertRealOutput(stub2, "the wiki agent"),
      /never wrote real output/
    );
    await assert.rejects(
      () => assertRealOutput(path.join(stubDir, "nope.md"), "the wiki agent"),
      /never wrote real output/
    );
    const empty2 = path.join(stubDir, "empty2.md");
    fs.writeFileSync(empty2, "  \n", "utf8");
    await assert.rejects(() => assertRealOutput(empty2, "the wiki agent"), /never wrote real output/);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("test-translate: all checks passed.");
})().catch((err) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
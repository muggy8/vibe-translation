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

  const template = "*[Source Text]*\n{{SOURCE_TEXT}}\n\n*[Translation Tasks]*\n{{TASKS}}";
  const prompt = buildTranslationPrompt({ template, sourceText: "本文", tasks: full });
  assert.ok(prompt.startsWith("*[Source Text]*\n本文"), "source block first");
  assert.ok(prompt.includes("*[Translation Tasks]*"));
  assert.ok(prompt.includes("1. **") && prompt.includes("7. **"), "numbered 1..7");
  assert.ok(prompt.endsWith("7. **Translate the [Source Text] into French.**"));
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
  // how the loop used to report "all-pass" over an untranslated volume.
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-verify", round: 1, maxRounds: 3, failed: 0, noDraft: 4 }),
    { stop: false, reason: null },
    "noDraft chapters are not a pass"
  );
  assert.deepStrictEqual(
    qaLoopDecision({ phase: "after-verify", round: 3, maxRounds: 3, failed: 0, noDraft: 4 }),
    { stop: true, reason: "round-limit" },
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
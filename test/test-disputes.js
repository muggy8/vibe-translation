/**
 * test-disputes.js — the glossary disputes queue: translation findings that
 * flow BACKWARDS into the glossary.
 *
 * The pipeline had one direction for terminology: the glossary is law and the
 * translation is graded against it. But the thing that grades the translation is
 * a model reading the SOURCE, and sometimes what it finds is that the GLOSSARY is
 * wrong. That observation used to die in a per-volume report while the retranslate
 * pass went on obeying the bad entry and the next verify round complained again —
 * an oscillation the round cap ended without ever telling the glossary.
 *
 * What is pinned here:
 *   1. A verifier's GLOSSARY DISPUTE block is parsed into structured data
 *      (term / canonical / proposed / the evidence), and a dispute with no
 *      evidence is recorded but flagged as not yet actionable.
 *   2. The same term challenged in two volumes is ONE dispute with two pieces of
 *      evidence — not two disputes.
 *   3. End to end on real files: a verify run whose reply contains a dispute
 *      records it in the chapter's sidecar entry; the queue is written at the
 *      series root; and the translation stage then TOLDS the translator the
 *      rendering is disputed (while still requiring it), so the loop cannot argue
 *      with itself.
 *   4. A dispute invalidates only the chapters that actually use the term
 *      (per-chapter invalidation), not the whole series.
 *
 * No network, no real endpoint. Run with `npm test`.
 */
const assert = require("assert");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const os = require("os");

const {
  parseGlossaryDisputes,
  collectVolumeDisputes,
  mergeDisputes,
  disputedTermSet,
  renderDisputesMarkdown,
  loadGlossaryDisputes,
  saveGlossaryDisputes,
  DISPUTES_FILE,
  DISPUTES_REPORT,
} = require("../utils/disputes");
const {
  sha256,
  STATE_FILE,
  VERIFICATION_FILE,
  loadVerificationSidecar,
  loadVolumeReferences,
  chapterTerminology,
  chapterContextHash,
} = require("../utils/translate");

// ─── 1. Parsing the verifier's dispute blocks ────────────────────────────────

{
  const reply = [
    "SCORE: 88/100",
    "",
    "## Findings",
    "(no findings)",
    "",
    "GLOSSARY DISPUTE: 鏡",
    '  Canonical: "Mirror"',
    '  Should be: "the Mirror"',
    '  Source: "古い記録システム「鏡」"',
    '  Translation: "the old recording system, Mirror"',
    "",
    "GLOSSARY DISPUTE: 黒鋼蓮",
    '  Canonical: "Kurogane Ren"',
    '  Should be: "Ren Kurogane"',
    "",
    "Some trailing commentary that is not a dispute.",
  ].join("\n");

  const disputes = parseGlossaryDisputes(reply);
  assert.strictEqual(disputes.length, 2, "both blocks are parsed");
  assert.strictEqual(disputes[0].term, "鏡");
  assert.strictEqual(disputes[0].canonical, "Mirror");
  assert.strictEqual(disputes[0].proposed, "the Mirror", "the challenge names the rendering it wants");
  assert.strictEqual(disputes[0].sourceQuote, "古い記録システム「鏡」", "and the evidence that proves it");
  assert.strictEqual(disputes[0].unsupported, false, "a dispute with its evidence is actionable");
  assert.strictEqual(disputes[1].unsupported, true, "a dispute with no source quote is a complaint, not a correction — and is labelled as one");

  assert.deepStrictEqual(parseGlossaryDisputes("SCORE: 90/100\n\n## Findings\n(no findings)"), [], "a clean reply raises no dispute");
  assert.deepStrictEqual(parseGlossaryDisputes(""), []);
  assert.deepStrictEqual(parseGlossaryDisputes(null), []);
}

// ─── 2. Aggregating: one term, two volumes = one dispute ─────────────────────

{
  const sidecar = {
    chapters: {
      ch3: {
        disputes: [{ term: "鏡", canonical: "Mirror", proposed: "the Mirror", sourceQuote: "記録システム「鏡」", translationQuote: "Mirror" }],
      },
      ch9: {
        disputes: [{ term: "鏡", canonical: "Mirror", proposed: "the Mirror", sourceQuote: "「鏡」は応答した", translationQuote: "Mirror" }],
      },
      ch1: { disputes: [] },
      ch2: {},
    },
  };
  const collected = collectVolumeDisputes(sidecar, "03");
  assert.strictEqual(collected.length, 2, "every recorded dispute is collected, with its chapter");
  assert.strictEqual(collected[0].volume, "03");
  assert.strictEqual(collected[0].chapter, "ch3");

  const merged = mergeDisputes([], collected);
  assert.strictEqual(merged.length, 1, "the same term challenged twice is ONE dispute");
  assert.strictEqual(merged[0].raised.length, 2, "with both chapters recorded");
  assert.strictEqual(merged[0].sourceQuote, "記録システム「鏡」", "the first piece of evidence is kept");

  // A later, weaker report of the same term must not erase the evidence.
  const again = mergeDisputes(merged, [{ term: "鏡", canonical: "Mirror", raised: [] }]);
  assert.strictEqual(again.length, 1);
  assert.strictEqual(again[0].sourceQuote, "記録システム「鏡」", "evidence is never overwritten by a dispute that has none");

  // A stronger report DOES upgrade it.
  const upgraded = mergeDisputes(
    [{ term: "鏡", canonical: "Mirror", raised: [{ volume: "03", chapter: "ch3" }] }],
    [{ term: "鏡", canonical: "Mirror", proposed: "the Mirror", sourceQuote: "「鏡」は応答した" }]
  );
  assert.strictEqual(upgraded[0].sourceQuote, "「鏡」は応答した", "the version that carries evidence wins");
  assert.strictEqual(upgraded[0].proposed, "the Mirror");

  // Duplicate reports do not inflate the count.
  const deduped = mergeDisputes(again, collectVolumeDisputes(sidecar, "03"));
  assert.strictEqual(deduped[0].raised.length, 2, "re-running the same volume does not double-count it");

  assert.deepStrictEqual([...disputedTermSet(merged)], ["鏡"]);

  const md = renderDisputesMarkdown(merged, { seriesName: "Test Series" });
  assert.ok(md.includes("鏡"), "the readable report names the term");
  assert.ok(md.includes("Mirror"), "with what the glossary says");
  assert.ok(md.includes("記録システム"), "and the evidence");
  assert.ok(md.includes("glossary"), "and says what to do with it");
  assert.ok(renderDisputesMarkdown([]).includes("No open disputes"), "an empty queue says so plainly");
}

// ─── 3. End to end: verify records it, the queue holds it, the translator is told ─

async function scenarioDisputesFlowBackwards() {
  const seriesDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "ai-client-disputes-"));
  const volumeDir = path.join(seriesDir, "Book(01)");
  fsSync.mkdirSync(volumeDir);
  const previousSeriesLocation = process.env.SERIES_LOCATION;
  process.env.SERIES_LOCATION = seriesDir;

  const source = "研究所は静かだった。\n\n古い記録システム「鏡」が二十年間、音もなく働いていた。";
  const draft = "The laboratory was quiet.\n\nThe old recording system, Mirror, had run silently for twenty years.";
  await fs.writeFile(path.join(volumeDir, "src-ch1.md"), source + "\n", "utf8");
  await fs.writeFile(path.join(volumeDir, "translation-ch1.md"), draft + "\n", "utf8");
  // The volume's own glossary snapshot — loadVolumeReferences reads the term list
  // from this file, exactly as a real run does.
  await fs.writeFile(
    path.join(volumeDir, "glossary.md"),
    [
      "# Glossary — Test Series",
      "",
      "Current through volume 01.",
      "",
      "## Terms & Concepts",
      "| Source | Rendering | Notes |",
      "|---|---|---|",
      "| 鏡 | Mirror | the recording system |",
      "",
    ].join("\n"),
    "utf8"
  );

  const bundle = {
    format: "txt",
    segments: [{ id: "ch1", title: "Night Shift", file: "src-ch1.md" }],
    wholeChars: source.length,
    sourceFingerprint: "fp-disputes",
  };
  const statePath = path.join(volumeDir, STATE_FILE);
  await fs.writeFile(
    statePath,
    JSON.stringify({
      schema: 1,
      chapters: { ch1: { sourceHash: sha256(source + "\n"), draftHash: sha256(draft + "\n") } },
    }),
    "utf8"
  );

  const refs = {
    glossaryText: "| 鏡 | Mirror | the recording system |",
    terms: [{ term: "鏡", rendering: "Mirror", section: "Terms & Concepts" }],
    styleRules: "- Keep the definite article with system names.",
    background: "The laboratory runs an old recording system.",
    voiceNotes: "",
    contextHash: "ctx-disputes",
    sharedContextHash: "shared-disputes",
  };

  const harness = require("../harness");
  const original = harness.runOneShot;
  let seenPrompt = null;
  harness.runOneShot = async (cfg) => {
    seenPrompt = cfg;
    // The verifier's honest verdict: the TRANSLATION is right, the glossary is not.
    return [
      "SCORE: 91/100",
      "",
      "## Findings",
      "(no findings)",
      "",
      "GLOSSARY DISPUTE: 鏡",
      '  Canonical: "Mirror"',
      '  Should be: "the Mirror"',
      '  Source: "古い記録システム「鏡」"',
      '  Translation: "The old recording system, Mirror"',
    ].join("\n");
  };

  try {
    const { processVerifyVolume } = require("../verify-translate");
    const systemPrompt = await fs.readFile(path.join(__dirname, "..", "system-prompts", "verify-translate.md"), "utf8");
    const template = await fs.readFile(path.join(__dirname, "..", "user-prompts", "verify-translate.md"), "utf8");

    const res = await processVerifyVolume({
      volume: { installmentNumber: "01", folder: "Book(01)" },
      volumeDir,
      bundle,
      refs,
      systemPrompt,
      template,
      endpoint: { model: "local", baseUrl: "http://127.0.0.1:1/v1", contextWindow: 32000, maxTokens: 4000 },
      auditEndpoint: null,
      dryRun: false,
      force: true,
    });

    assert.strictEqual(res.verified, 1, "the chapter was verified");
    assert.strictEqual(res.passed, 1, "and it PASSED — a dispute is not a finding against the translation");

    // The dispute lives in the chapter's own record, next to its verdict.
    const sidecar = await loadVerificationSidecar(path.join(volumeDir, VERIFICATION_FILE));
    const entry = sidecar.chapters.ch1;
    assert.ok(Array.isArray(entry.disputes) && entry.disputes.length === 1, "the dispute is persisted");
    assert.strictEqual(entry.disputes[0].term, "鏡");
    assert.strictEqual(entry.disputes[0].proposed, "the Mirror");

    // The series-level queue (what the glossary task reads next time).
    const incoming = collectVolumeDisputes(sidecar, "01");
    const merged = mergeDisputes(await loadGlossaryDisputes(seriesDir), incoming);
    await saveGlossaryDisputes(seriesDir, merged, { seriesName: "Test Series" });
    assert.ok(fsSync.existsSync(path.join(seriesDir, DISPUTES_FILE)), "the queue is written at the series root");
    assert.ok(fsSync.existsSync(path.join(seriesDir, DISPUTES_REPORT)), "together with the readable report");
    const reloaded = await loadGlossaryDisputes(seriesDir);
    assert.strictEqual(reloaded.length, 1, "and it survives a reload");

    // The publish report points at the queue: a reader of the series report must
    // not have to know the channel exists to learn the glossary is challenged.
    const { writeTranslationReport } = require("../utils/translation-report");
    const report = await writeTranslationReport({
      seriesDir,
      manifest: { seriesName: "Test Series", volumes: [{ folder: "Book(01)", installmentNumber: "01" }] },
      dryRun: false,
    });
    const reportText = await fs.readFile(report.file, "utf8");
    assert.ok(reportText.includes("glossary dispute"), "the series report says a terminology challenge is open");
    assert.ok(reportText.includes("glossary-disputes.md"), "and names where to read it");

    // The translation stage now sees the dispute and SAYS so to the translator —
    // while still requiring the canonical rendering, so the loop cannot argue.
    const refs2 = await loadVolumeReferences(volumeDir, source);
    assert.ok(refs2.disputedTerms.has("鏡"), "the term is marked disputed for this volume");
    const term = chapterTerminology(refs2, source);
    assert.ok(term.lines[0].includes("DISPUTED"), term.lines[0]);
    assert.ok(term.lines[0].includes("do NOT improvise another one"), "the instruction is still: use the canonical form");
    assert.ok(term.lines[0].includes("correction happens in the glossary"), "and names where the fix belongs");

    // Invalidation stays per-chapter: a dispute on a term this chapter never
    // says must not throw away its draft.
    const usesIt = chapterContextHash(refs2, source);
    const refsNoDispute = { ...refs2, disputedTerms: new Set() };
    assert.notStrictEqual(
      chapterContextHash(refsNoDispute, source),
      usesIt,
      "a term becoming disputed invalidates the chapters that use it"
    );
    const otherSource = "別の話。";
    assert.strictEqual(
      chapterContextHash(refs2, otherSource),
      chapterContextHash(refsNoDispute, otherSource),
      "and leaves alone the chapters that never contain it"
    );

    assert.ok(seenPrompt, "the verifier was actually called");
    void seenPrompt;
  } finally {
    harness.runOneShot = original;
    if (previousSeriesLocation === undefined) delete process.env.SERIES_LOCATION;
    else process.env.SERIES_LOCATION = previousSeriesLocation;
    fsSync.rmSync(seriesDir, { recursive: true, force: true });
  }
}

// ─── 4. The glossary task's view of the queue ────────────────────────────────

{
  const { buildDisputesNote } = require("../glossary");
  assert.strictEqual(buildDisputesNote([], "05"), "", "nothing open, nothing to say");
  assert.strictEqual(buildDisputesNote(null, "05"), "");

  const note = buildDisputesNote(
    [
      {
        term: "鏡",
        canonical: "Mirror",
        proposed: "the Mirror",
        sourceQuote: "古い記録システム「鏡」",
        raised: [{ volume: "03", chapter: "ch3" }],
      },
      { term: "黒鋼蓮", canonical: "Kurogane Ren", proposed: "Ren Kurogane", raised: [] },
    ],
    "05"
  );
  assert.ok(note.includes("鏡") && note.includes("Mirror"), "the disputed entry is named with what it currently says");
  assert.ok(note.includes("古い記録システム"), "with the evidence against it");
  assert.ok(note.includes("No source quote"), "and an unevidenced dispute is flagged as such");
  assert.ok(note.includes("volume 03 ch3"), "and where it was raised");
  assert.ok(note.includes("correct the entry") && note.includes("record"), "and the amend pass is told it must decide, not ignore");

  const bounded = buildDisputesNote(
    Array.from({ length: 60 }, (_, i) => ({ term: `t${i}`, canonical: `T${i}`, raised: [] })),
    "05",
    40
  );
  assert.ok(bounded.includes("20 more"), "a huge queue is bounded — the point is the worst offenders, not a re-listing");
}

// ─── run ─────────────────────────────────────────────────────────────────────

(async function main() {
  await scenarioDisputesFlowBackwards();
  console.log("disputes: all checks passed.");
})();

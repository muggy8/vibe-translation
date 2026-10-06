/**
 * test/test-delivery-verify.js — the acceptance test for an intervention.
 *
 * `utils/delivery-verify.js` answers one question: **is the deliverable better, the same, or worse
 * than it was before you touched it?** Everything act mode records and every ticket that closes
 * rests on that answer, so what is pinned here is the arithmetic of the verdict rather than the
 * plumbing of a run (that is `test/test-delivery-act.js`).
 *
 * The fixtures are bare directory trees, not series: the measurement is handed the volume list, so
 * it needs no plan of record, and a test that does not resolve a manifest cannot reach the live
 * 17-volume series or start the intake agent (gotcha 69). `POSTMORTEM_DIR` is pointed at the
 * fixture so the ticket half writes its files here rather than into the real run's history
 * (gotcha 71).
 *
 * The scenarios, and the rule each one pins:
 *   1. a measurement compared with itself is `unchanged` — the false-positive half, because a
 *      check that fires on healthy output is a check that gets switched off (gotcha 65);
 *   2. **a regression vetoes an improvement**: the planted "fix" that finishes the step while
 *      shrinking the glossary is `worse`, and the damage is named;
 *   3. the book: UNVERIFIED up is damage, PUBLISHED up is an improvement, and a publish report
 *      that disappears is damage;
 *   4. the median verification score is only compared when both sides graded the same number of
 *      chapters — a book that gained a chapter is a different book;
 *   5. **a file that could not be read is not a file with nothing in it**: an unreadable glossary
 *      makes the signal not comparable, and does not count as a loss;
 *   6. the style guide's rule COUNT is reported and cannot decide anything, while a missing `## `
 *      category can — the same split its own carry-forward gate makes (gotcha 65);
 *   7. a dropped character section, and a chapter that vanishes from the translation handoff, are
 *      both damage;
 *   8. a corrupt disputes queue is not "the disputes were settled";
 *   9. the triage and the measurement read the publish report through the same reader, so one
 *      report cannot be counted two ways;
 *  10. a ticket closes on this comparison, and `finding-gone` is still refused.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  measureDeliverable,
  compareDeliverable,
  describeComparison,
  accountOf,
  summarizeSnapshot,
  closureFromComparison,
  DELIVERABLE_SIGNALS,
} = require("../utils/delivery-verify");
const { readTranslationReport, summarizeReportRows } = require("../utils/translation-report");
const { readDeliverable } = require("../utils/resume");
const { createTicket, closeTicket, readTickets } = require("../utils/tickets");

const FIXTURES = path.resolve("/tmp/opencode/delivery-verify-tests");

// ─── Fixture pieces ───────────────────────────────────────────────────────────

/**
 * A glossary with N usable term rows.
 * @param {string[]} terms
 * @returns {string}
 */
function glossary(terms) {
  const rows = terms.map((t) => `| ${t} | ${t} rendered | fixture |`).join("\n");
  return `# Glossary

## Characters

| Term | Rendering | Notes |
|---|---|---|
${rows}
`;
}

/** A cumulative reference with `### ` character sections. */
function voiceReference(characters) {
  return `# Character voice reference

${characters.map((c) => `### ${c}（persona）

- one quirk

`).join("\n")}`;
}

/** A cumulative style guide: `## ` categories, each with N bullet rules. */
function styleGuide(categories) {
  return `# Style guide

${Object.entries(categories)
  .map(([name, rules]) => `## ${name}\n\n${Array.from({ length: rules }, (_, i) => `- rule ${i + 1}`).join("\n")}\n`)
  .join("\n")}`;
}

/** The wiki's cumulative half, plus the deterministic chapter handoff. */
function wiki(sections) {
  return `# Shared wiki

${sections.map((s) => `## ${s}\n\n- state\n`).join("\n")}`;
}

/** @param {number[]} scores @param {Array<{id: string, volume: string, outcome: string, verifyScore?: number}>} extra */
function report(chapters) {
  return { schema: 1, generatedAt: new Date().toISOString(), seriesName: "Fixture", chapters };
}

/**
 * Lay out a bare fixture tree.
 *
 * @param {string} label
 * @param {{volumes: Array<{folder: string, installment: string, files: Object<string, string>}>,
 *   report?: Object, disputes?: Array<Object>}} spec
 * @returns {Promise<string>} the series directory
 */
async function fixture(label, spec) {
  const dir = path.join(FIXTURES, label);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  for (const v of spec.volumes) {
    const volDir = path.join(dir, v.folder);
    await fs.promises.mkdir(volDir, { recursive: true });
    for (const [name, content] of Object.entries(v.files || {})) {
      await fs.promises.writeFile(path.join(volDir, name), content, "utf8");
    }
  }
  if (spec.report) {
    await fs.promises.writeFile(path.join(dir, "translation-report.json"), JSON.stringify(spec.report, null, 2) + "\n", "utf8");
  }
  if (spec.disputes) {
    await fs.promises.writeFile(
      path.join(dir, "glossary-disputes.json"),
      JSON.stringify({ disputes: spec.disputes }, null, 2) + "\n",
      "utf8"
    );
  }
  return dir;
}

/** The volume list the measurement is handed (the same shape `utils/resume.js` produces). */
function inventory(volumes) {
  return volumes.map((v) => ({
    folder: v.folder,
    installment: v.installment,
    exists: true,
    missingForStep: v.missingForStep || [],
  }));
}

/** A two-volume series with every reference artifact present and a clean publish report. */
function healthySpec() {
  return {
    volumes: [
      {
        folder: "Fixture(01)",
        installment: "01",
        files: {
          "glossary.md": glossary(["主人公", "ヒロイン"]),
          "character-voice.md": voiceReference(["主人公", "ヒロイン", "先生"]),
          "style-guide.md": styleGuide({ "Address & Honorifics": 4, Pronouns: 2 }),
          "shared-wiki.md": wiki(["Premise", "Characters"]),
          "chapters.json": JSON.stringify({ seriesName: "Fixture", volume: "01", chapters: [{ id: "whole" }, { id: "ch1" }] }) + "\n",
        },
      },
      {
        folder: "Fixture(02)",
        installment: "02",
        files: {
          "glossary.md": glossary(["主人公", "ヒロイン", "魔法"]),
          "character-voice.md": voiceReference(["主人公", "ヒロイン", "先生"]),
          "style-guide.md": styleGuide({ "Address & Honorifics": 4, Pronouns: 2 }),
          "shared-wiki.md": wiki(["Premise", "Characters", "Volume 2"]),
          "chapters.json": JSON.stringify({ seriesName: "Fixture", volume: "02", chapters: [{ id: "whole" }] }) + "\n",
        },
      },
    ],
    report: report([
      { volume: "01", id: "whole", outcome: "PUBLISHED (verified)", verifyScore: 88, draftChars: 900 },
      { volume: "01", id: "ch1", outcome: "PUBLISHED (verified)", verifyScore: 84, draftChars: 900 },
      { volume: "02", id: "whole", outcome: "PUBLISHED (verified)", verifyScore: 86, draftChars: 900 },
    ]),
    disputes: [],
  };
}

/** Measure a fixture twice: once as it is, once after `mutate` has changed it. */
async function beforeAndAfter(label, spec, mutate) {
  const dir = await fixture(label, spec);
  const vols = inventory(spec.volumes);
  const before = await measureDeliverable({ seriesDir: dir, volumes: vols });
  await mutate(dir, spec);
  const afterSpec = { ...spec, volumes: spec.volumes };
  const after = await measureDeliverable({ seriesDir: dir, volumes: inventory(afterSpec.volumes) });
  return { dir, before, after, comparison: compareDeliverable(before, after) };
}

/** Find one signal's movement. */
function movement(comparison, name) {
  return comparison.movements.find((m) => m.name === name);
}

// ─── 1: a deliverable that did not move is `unchanged` ────────────────────────

async function testNothingMovedIsNothingMoved() {
  const spec = healthySpec();
  const dir = await fixture("unchanged", spec);
  const vols = inventory(spec.volumes);
  const first = await measureDeliverable({ seriesDir: dir, volumes: vols });
  const second = await measureDeliverable({ seriesDir: dir, volumes: vols });
  const comparison = compareDeliverable(first, second);

  assert.strictEqual(comparison.outcome, "unchanged", comparison.movements.map((m) => `${m.name}:${m.direction}`).join(", "));
  assert.strictEqual(comparison.regressions.length, 0, "a clean series produces no damage findings");
  assert.strictEqual(comparison.improvements.length, 0);
  assert.strictEqual(accountOf(comparison), "nothing in the deliverable moved");

  // And the numbers are the ones a reader expects from this fixture.
  const summary = summarizeSnapshot(first);
  assert.strictEqual(summary.published, 3);
  assert.strictEqual(summary.unverified, 0);
  assert.strictEqual(summary.missing, 0);
  assert.strictEqual(summary.glossaryTerms, 5, "2 terms in volume 01, 3 in volume 02");
  assert.strictEqual(summary.glossaryHeadVolume, "02", "the newest snapshot is the one every later volume reads");
  assert.strictEqual(summary.voiceSections, 3);
  assert.strictEqual(summary.styleCategories, 2);
  assert.strictEqual(summary.wikiChapters, 3);

  console.log("  unchanged: a deliverable that did not move is reported as not having moved");
}

// ─── 2: a regression vetoes an improvement ────────────────────────────────────

async function testDamageOutranksImprovement() {
  const spec = healthySpec();
  // Volume 02's glossary is missing its rolling-state file: the step is unfinished, so finishing
  // it is a genuine improvement — except the rebuild wrote a glossary with one term instead of
  // three. This is the planted "fix" from the plan, in its purest form.
  spec.volumes[1].missingForStep = [{ step: "glossary", files: ["glossary-validation-rolling-state.json"] }];

  const result = await beforeAndAfter("veto", spec, async (dir) => {
    await fs.promises.writeFile(path.join(dir, "Fixture(02)", "glossary.md"), glossary(["主人公"]), "utf8");
    await fs.promises.writeFile(path.join(dir, "Fixture(02)", "glossary-validation-rolling-state.json"), "{}\n", "utf8");
  });
  // The step is finished now, so the volume list no longer reports the gap.
  spec.volumes[1].missingForStep = [];
  const after = await measureDeliverable({ seriesDir: result.dir, volumes: inventory(spec.volumes) });
  const comparison = compareDeliverable(result.before, after);

  assert.strictEqual(
    movement(comparison, "stepsBuilt").direction,
    "better",
    "the step really did finish — that part is not in dispute"
  );
  assert.strictEqual(movement(comparison, "glossaryTerms").direction, "worse");
  assert.strictEqual(movement(comparison, "glossaryTerms").from, 5);
  assert.strictEqual(movement(comparison, "glossaryTerms").to, 3);
  assert.strictEqual(comparison.outcome, "worse", "one damaged invariant outranks any number of improvements");
  assert.ok(comparison.regressions.some((r) => r.name === "glossaryTerms"));
  assert.ok(comparison.improvements.some((r) => r.name === "stepsBuilt"), "the improvement is still reported — it is not erased, it is outvoted");
  assert.ok(accountOf(comparison).includes("[damage]"), accountOf(comparison));

  // The account is what a human can argue with; the verdict alone is not.
  const lines = describeComparison(comparison);
  assert.ok(lines.some((l) => l.includes("damage outranks whatever improved")), lines.join("\n"));

  console.log("  veto: a fix that finished the step and shrank the glossary is recorded as damage");
}

// ─── 3: the book ──────────────────────────────────────────────────────────────

async function testTheBookIsTheDeliverable() {
  // UNVERIFIED chapters appearing.
  const unverified = await beforeAndAfter("unverified-up", healthySpec(), async (dir) => {
    await fs.promises.writeFile(
      path.join(dir, "translation-report.json"),
      JSON.stringify(
        report([
          { volume: "01", id: "whole", outcome: "PUBLISHED (verified)", verifyScore: 88, draftChars: 900 },
          { volume: "01", id: "ch1", outcome: "UNVERIFIED (verification FAIL)", verifyScore: 52, draftChars: 900 },
          { volume: "02", id: "whole", outcome: "PUBLISHED (verified)", verifyScore: 86, draftChars: 900 },
        ]),
        null,
        2
      ) + "\n",
      "utf8"
    );
  });
  assert.strictEqual(unverified.comparison.outcome, "worse");
  assert.ok(unverified.comparison.regressions.some((r) => r.name === "unverified"));
  assert.ok(unverified.comparison.regressions.some((r) => r.name === "published"));

  // A repair that publishes one more chapter.
  const repaired = await beforeAndAfter("published-up", healthySpec(), async (dir) => {
    await fs.promises.writeFile(
      path.join(dir, "translation-report.json"),
      JSON.stringify(
        report([
          { volume: "01", id: "whole", outcome: "PUBLISHED (verified)", verifyScore: 88, draftChars: 900 },
          { volume: "01", id: "ch1", outcome: "PUBLISHED (verified)", verifyScore: 84, draftChars: 900 },
          { volume: "02", id: "whole", outcome: "PUBLISHED (verified)", verifyScore: 91, draftChars: 900 },
        ]),
        null,
        2
      ) + "\n",
      "utf8"
    );
  });
  assert.strictEqual(repaired.comparison.outcome, "improved", "the same chapters, one graded better");
  assert.strictEqual(movement(repaired.comparison, "verifyScoreMedian").direction, "better");

  // A publish report that is gone.
  const lost = await beforeAndAfter("report-gone", healthySpec(), async (dir) => {
    await fs.promises.rm(path.join(dir, "translation-report.json"), { force: true });
  });
  assert.strictEqual(lost.comparison.outcome, "worse", "an intervention that leaves no sign-off left no answer");
  assert.strictEqual(movement(lost.comparison, "publishReport").from, 1);
  assert.strictEqual(movement(lost.comparison, "publishReport").to, 0);
  // …and the eight book signals that depend on it collapse into one honest line rather than eight.
  const lines = describeComparison(lost.comparison);
  const skipped = lines.filter((l) => l.includes("not compared"));
  assert.strictEqual(skipped.length, 1, skipped.join("\n"));
  assert.ok(skipped[0].includes("no publish report"), skipped[0]);

  console.log("  the book: unverified up is damage, published up is an improvement, a missing report is damage");
}

// ─── 4: a changed denominator is not a measurement ────────────────────────────

async function testScoreMedianNeedsTheSameChapterList() {
  // Same chapters, graded worse.
  const sameSize = await beforeAndAfter("median-down", healthySpec(), async (dir) => {
    await fs.promises.writeFile(
      path.join(dir, "translation-report.json"),
      JSON.stringify(
        report([
          { volume: "01", id: "whole", outcome: "PUBLISHED (verified)", verifyScore: 72, draftChars: 900 },
          { volume: "01", id: "ch1", outcome: "PUBLISHED (verified)", verifyScore: 70, draftChars: 900 },
          { volume: "02", id: "whole", outcome: "PUBLISHED (verified)", verifyScore: 71, draftChars: 900 },
        ]),
        null,
        2
      ) + "\n",
      "utf8"
    );
  });
  assert.strictEqual(sameSize.comparison.outcome, "worse", "the same book, graded worse, is a real regression");

  // A different number of chapters: the medians describe different books.
  const grew = await beforeAndAfter("median-grew", healthySpec(), async (dir) => {
    await fs.promises.writeFile(
      path.join(dir, "translation-report.json"),
      JSON.stringify(
        report([
          { volume: "01", id: "whole", outcome: "PUBLISHED (verified)", verifyScore: 60, draftChars: 900 },
          { volume: "01", id: "ch1", outcome: "PUBLISHED (verified)", verifyScore: 60, draftChars: 900 },
          { volume: "02", id: "whole", outcome: "PUBLISHED (verified)", verifyScore: 60, draftChars: 900 },
          { volume: "02", id: "ch1", outcome: "MISSING (never translated)" },
        ]),
        null,
        2
      ) + "\n",
      "utf8"
    );
  });
  const median = movement(grew.comparison, "verifyScoreMedian");
  assert.strictEqual(median.comparable, false, "a book that gained a chapter is a different book");
  assert.ok(median.why.includes("changed size"), median.why);
  // The chapter that appeared as MISSING is still damage, and it is what actually decides this one.
  assert.strictEqual(grew.comparison.outcome, "worse");
  assert.ok(grew.comparison.regressions.some((r) => r.name === "missing"));

  console.log("  scores: the median is compared only across the same chapter list; a new MISSING chapter is not");
}

// ─── 5: a file that could not be read is not an empty file ────────────────────

async function testUnreadableIsNotLoss() {
  const spec = healthySpec();
  const dir = await fixture("unreadable", spec);
  const vols = inventory(spec.volumes);
  const before = await measureDeliverable({ seriesDir: dir, volumes: vols });

  // A directory where the glossary was: present, not readable, and emphatically not "a glossary
  // with zero terms in it".
  await fs.promises.rm(path.join(dir, "Fixture(02)", "glossary.md"), { force: true });
  await fs.promises.mkdir(path.join(dir, "Fixture(02)", "glossary.md"));

  const after = await measureDeliverable({ seriesDir: dir, volumes: vols });
  const comparison = compareDeliverable(before, after);

  assert.strictEqual(movement(comparison, "glossaryTerms").comparable, false, "a read failure is a fact about the measurement, not about the glossary");
  assert.ok(after.notes.some((n) => n.includes("could not be measured")), after.notes.join("; "));
  assert.notStrictEqual(comparison.outcome, "worse", "a permissions problem must not be reported as a loss of terminology");
  assert.strictEqual(after.reference.glossary.volumesWith, 2, "the file is still there — 'the glossary disappeared' would be a lie");

  console.log("  unreadable: a glossary that cannot be read is not counted as an empty one");
}

// ─── 6: reported, never decisive ──────────────────────────────────────────────

async function testStyleGuideRuleCountIsNotAJudgement() {
  // The guide says the same things in fewer words: every category survives, the bullet count drops.
  const condensed = await beforeAndAfter("style-condensed", healthySpec(), async (dir) => {
    await fs.promises.writeFile(
      path.join(dir, "Fixture(02)", "style-guide.md"),
      styleGuide({ "Address & Honorifics": 1, Pronouns: 1 }),
      "utf8"
    );
  });
  assert.strictEqual(condensed.comparison.outcome, "unchanged", "a guide that says the same thing in fewer words is not damaged (gotcha 65)");
  const rules = movement(condensed.comparison, "styleRules");
  assert.strictEqual(rules.direction, "worse");
  assert.strictEqual(rules.veto, false);
  assert.ok(condensed.comparison.noted.some((m) => m.name === "styleRules"), "it is reported — reported only is not the same as invisible");

  // A category disappearing IS damage: a guide missing "Address & Honorifics" lost everything in it.
  const missingCategory = await beforeAndAfter("style-category-gone", healthySpec(), async (dir) => {
    await fs.promises.writeFile(path.join(dir, "Fixture(02)", "style-guide.md"), styleGuide({ Pronouns: 6 }), "utf8");
  });
  assert.strictEqual(missingCategory.comparison.outcome, "worse");
  assert.ok(missingCategory.comparison.regressions.some((r) => r.name === "styleCategories"));

  console.log("  style guide: a shorter guide is reported, a missing category is damage");
}

// ─── 7: the reference layer's own invariants ──────────────────────────────────

async function testReferenceInvariants() {
  // A character section gone.
  const lostCharacter = await beforeAndAfter("voice-section-gone", healthySpec(), async (dir) => {
    await fs.promises.writeFile(path.join(dir, "Fixture(02)", "character-voice.md"), voiceReference(["主人公", "ヒロイン"]), "utf8");
  });
  assert.strictEqual(lostCharacter.comparison.outcome, "worse");
  assert.ok(lostCharacter.comparison.regressions.some((r) => r.name === "voiceSections"));

  // A reworded heading is not a lost character: the count is what moves, and it did not.
  const reworded = await beforeAndAfter("voice-reworded", healthySpec(), async (dir) => {
    await fs.promises.writeFile(path.join(dir, "Fixture(02)", "character-voice.md"), voiceReference(["主人公", "ヒロイン", "先生（改）"]), "utf8");
  });
  assert.strictEqual(reworded.comparison.outcome, "unchanged", "this is a measurement, not the carry-forward gate — a rename moves nothing here (gotcha 68)");

  // A chapter vanishing from the handoff the translation stage names its outputs by.
  const lostChapter = await beforeAndAfter("handoff-chapter-gone", healthySpec(), async (dir) => {
    await fs.promises.writeFile(
      path.join(dir, "Fixture(01)", "chapters.json"),
      JSON.stringify({ seriesName: "Fixture", volume: "01", chapters: [{ id: "whole" }] }, null, 2) + "\n",
      "utf8"
    );
  });
  assert.strictEqual(lostChapter.comparison.outcome, "worse", "a chapter missing from chapters.json is a chapter the book never gets");
  assert.ok(lostChapter.comparison.regressions.some((r) => r.name === "wikiChapters"));

  // A volume that lost its wiki entirely.
  const lostWiki = await beforeAndAfter("wiki-volume-gone", healthySpec(), async (dir) => {
    await fs.promises.rm(path.join(dir, "Fixture(02)", "shared-wiki.md"), { force: true });
  });
  assert.strictEqual(lostWiki.comparison.outcome, "worse");
  assert.ok(lostWiki.comparison.regressions.some((r) => r.name === "referenceVolumes"));

  console.log("  reference layer: a lost character section, a lost handoff chapter and a lost volume are all damage");
}

// ─── 8: a corrupt queue is not a settled one ──────────────────────────────────

async function testDisputesQueueHonesty() {
  const spec = healthySpec();
  spec.disputes = [{ term: "主人公", canonical: "protagonist", proposed: "the hero" }];

  const settled = await beforeAndAfter("disputes-settled", spec, async (dir) => {
    await fs.promises.writeFile(path.join(dir, "glossary-disputes.json"), JSON.stringify({ disputes: [] }, null, 2) + "\n", "utf8");
  });
  assert.ok(settled.comparison.improvements.some((r) => r.name === "disputes"), "settling a dispute is a real improvement");

  const corrupt = await beforeAndAfter("disputes-corrupt", spec, async (dir) => {
    await fs.promises.writeFile(path.join(dir, "glossary-disputes.json"), "{ this is not json", "utf8");
  });
  assert.strictEqual(movement(corrupt.comparison, "disputes").comparable, false, "a queue that does not parse is not a queue that got shorter");
  assert.notStrictEqual(corrupt.comparison.outcome, "improved");

  console.log("  disputes: settling one is an improvement, corrupting the file is not");
}

// ─── 9: one report, one reading ───────────────────────────────────────────────

async function testOneReadingOfThePublishReport() {
  const spec = healthySpec();
  spec.report = report([
    { volume: "01", id: "whole", outcome: "PUBLISHED (verified)", verifyScore: 88, draftChars: 900 },
    { volume: "01", id: "ch1", outcome: "UNVERIFIED (no verdict for this draft)" },
    { volume: "02", id: "whole", outcome: "MISSING (never translated)" },
    { volume: "02", id: "ch1", outcome: "EMPTY IN SOURCE (no text to translate)" },
  ]);
  const dir = await fixture("one-reading", spec);

  const shared = summarizeReportRows((await readTranslationReport(dir)).chapters);
  const triage = await readDeliverable(dir);

  assert.strictEqual(triage.counts.total, shared.total);
  assert.strictEqual(triage.counts.published, shared.published);
  assert.strictEqual(triage.counts.unverified, shared.unverified);
  assert.strictEqual(triage.counts.missing, shared.missing);
  assert.strictEqual(triage.counts.emptyInSource, shared.emptyInSource);
  assert.strictEqual(shared.published, 1);
  assert.strictEqual(shared.unverified, 1);
  assert.strictEqual(shared.missing, 1);
  assert.strictEqual(shared.emptyInSource, 1, "a hole in the BOOK is not a failure of the run (gotcha 40)");

  // And a report that does not exist is absent, not empty, in both readers.
  const emptyDir = path.join(FIXTURES, "no-report");
  await fs.promises.rm(emptyDir, { recursive: true, force: true });
  await fs.promises.mkdir(emptyDir, { recursive: true });
  assert.strictEqual(await readTranslationReport(emptyDir), null);
  assert.strictEqual(await readDeliverable(emptyDir), null);

  console.log("  one reading: the triage and the measurement count the same report the same way");
}

// ─── 10: a ticket closes on this comparison ───────────────────────────────────

async function testTicketClosureUsesTheSameAnswer() {
  const spec = healthySpec();
  const dir = await fixture("closure", spec);
  const vols = inventory(spec.volumes);
  const before = await measureDeliverable({ seriesDir: dir, volumes: vols });

  await fs.promises.writeFile(path.join(dir, "Fixture(02)", "glossary.md"), glossary(["主人公"]), "utf8");
  const after = await measureDeliverable({ seriesDir: dir, volumes: vols });
  const comparison = compareDeliverable(before, after);

  const closure = closureFromComparison(comparison, "the glossary was rebuilt from the previous volume's copy");
  assert.strictEqual(closure.outcome, "worse");
  assert.ok(closure.note.includes("glossary terms carried"), closure.note);
  assert.ok(closure.note.includes("rebuilt from the previous volume"), closure.note);

  const opened = createTicket({
    run: "run-verify",
    step: "glossary",
    volume: "02",
    finding: "required-artifact-missing",
    evidence: [{ file: "glossary.md", note: "fixture" }],
    question: "What is leaving volume 02's glossary without its validation report?",
  });
  assert.ok(opened.ticket, (opened.problems || []).join("; "));

  const closed = closeTicket(opened.ticket.id, closure);
  assert.strictEqual(closed.error, null, "the measurement's verdict is a shape closeTicket accepts");
  assert.strictEqual(closed.ticket.closure.outcome, "worse");

  const { tickets } = readTickets();
  const stored = tickets.find((t) => t.id === opened.ticket.id);
  assert.strictEqual(stored.status, "closed");
  assert.ok(stored.closure.note.includes("damage"), stored.closure.note);

  // The shape rule still stands next to the measurement.
  const second = createTicket({
    run: "run-verify",
    step: "glossary",
    volume: "02",
    finding: "required-artifact-missing",
    evidence: [{ file: "glossary.md", note: "fixture" }],
    question: "Why is volume 02's glossary missing its validation report?",
  });
  assert.ok(second.ticket);
  assert.ok(closeTicket(second.ticket.id, { outcome: "finding-gone", note: "done" }).error);
  assert.ok(closeTicket(second.ticket.id, { outcome: "the book is fine now", note: "done" }).error);

  console.log("  closure: a ticket closes on the same comparison act mode records, and `finding-gone` is refused");
}

// ─── The signal table itself ──────────────────────────────────────────────────

async function testSignalTableIsSound() {
  const names = new Set();
  for (const signal of DELIVERABLE_SIGNALS) {
    assert.ok(signal.name && !names.has(signal.name), `duplicate signal name: ${signal.name}`);
    names.add(signal.name);
    assert.ok(signal.label.length > 3, `${signal.name} needs a label a human can read`);
    assert.ok(signal.why.length > 20, `${signal.name} needs a reason — a signal nobody can explain gets ignored`);
    assert.ok(["up", "down"].includes(signal.betterWhen), `${signal.name} must say which way is better`);
    assert.strictEqual(typeof signal.veto, "boolean", `${signal.name} must say whether it can decide the verdict`);
  }
  // The gate verdicts are deliberately absent: switching a check off moves them for free, which is
  // the whole reason a weakened guard cannot be accepted as a fix.
  for (const banned of ["consistencyReport", "auditVerdict", "quarantines", "validationReports", "postMortemFindings"]) {
    assert.ok(!names.has(banned), `${banned} is a gate's verdict, not a fact about the deliverable`);
  }
  assert.ok(names.size >= 15, `the measurement has ${names.size} signals; a deliverable this layered needs more than that`);

  console.log(`  signals: ${names.size} named, each with a direction, a reason, and a veto flag`);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async function main() {
  await fs.promises.mkdir(FIXTURES, { recursive: true });
  // The ticket half writes to the post-mortem folder; point it at the fixture so it cannot read or
  // write the real series' history (gotcha 71).
  process.env.POSTMORTEM_DIR = path.join(FIXTURES, ".postmortem");
  await fs.promises.rm(process.env.POSTMORTEM_DIR, { recursive: true, force: true });

  await testNothingMovedIsNothingMoved();
  await testDamageOutranksImprovement();
  await testTheBookIsTheDeliverable();
  await testScoreMedianNeedsTheSameChapterList();
  await testUnreadableIsNotLoss();
  await testStyleGuideRuleCountIsNotAJudgement();
  await testReferenceInvariants();
  await testDisputesQueueHonesty();
  await testOneReadingOfThePublishReport();
  await testTicketClosureUsesTheSameAnswer();
  await testSignalTableIsSound();

  delete process.env.POSTMORTEM_DIR;
  console.log("deliverable verification: ok");
})().catch((err) => {
  console.error("deliverable verification test failed:", err.message);
  console.error(err.stack);
  process.exitCode = 1;
});

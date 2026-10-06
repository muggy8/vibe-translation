/**
 * utils/translation-report.js — the translation stage's sign-off document.
 *
 * The pre-production stage has one (`consistency-report.md`: a PASS/FAIL
 * sign-off over the reference artifacts). The translation stage had no
 * equivalent: the verdicts existed, but scattered across four per-volume files
 * that nobody read together, so a 17-volume run produced no single answer to
 * "what is actually good enough to read?".
 *
 * This is deterministic (no AI): it reads the state and sidecar files the
 * translation tasks already write and renders one table for the whole series,
 * plus a machine-readable sidecar so a later run can diff it.
 *
 * It is written at the end of every publishing translation task (translate,
 * translate-qa, polish) and is available as its own gulp task.
 */

const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const { writeProvenanceSidecar, fileExists } = require("./fs");
const { seriesArtifactFile } = require("../configs/shared");
const { loadGlossaryDisputes, DISPUTES_FILE, DISPUTES_REPORT } = require("./disputes");
const {
  STATE_FILE,
  VERIFICATION_FILE,
  POLISH_VERIFICATION_FILE,
  MERGED_FILE,
  chapterArtifactNames,
  loadTranslationState,
  loadVerificationSidecar,
  loadVolumeConsistency,
  findingsForChapter,
  readFileOrEmpty,
  verdictCoversCurrentDraft,
  medianScore,
} = require("./translate");

/** Markdown report name at the series root. */
const TRANSLATION_REPORT_FILE = "translation-report.md";
/** Machine-readable sidecar (so a later run can diff the verdicts). */
const TRANSLATION_REPORT_JSON = "translation-report.json";

/**
 * Read a JSON file, or null when it is missing or corrupt (fail-open: the
 * report describes what is on disk, it does not invent verdicts).
 *
 * @param {string} filePath
 * @returns {Promise<Object|null>}
 */
async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Build the report rows for one volume from the files its tasks wrote.
 *
 * @param {string} volumeDir
 * @param {{installmentNumber: string, folder: string}} volume
 * @param {Array<{id: string, title: string}>} segments - The chapter list (from chapters.json when present).
 * @returns {Promise<Array<Object>>} One row per chapter.
 */
async function collectVolumeRows(volumeDir, volume, segments) {
  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  const sidecar = await loadVerificationSidecar(path.join(volumeDir, VERIFICATION_FILE));
  const polish = await readJsonOrNull(path.join(volumeDir, POLISH_VERIFICATION_FILE));
  const polishChapters = (polish && polish.chapters) || {};

  const rows = [];
  const variants = Array.isArray(sidecar.volume && sidecar.volume.renderingVariants)
    ? sidecar.volume.renderingVariants
    : [];
  // The cross-chapter audit (volume-consistency.json): which findings name each
  // chapter, and how many of them are HIGH (the ones the retranslate pass acts on).
  const consistency = await loadVolumeConsistency(volumeDir);
  const consistencyFindings = consistency.findings || [];
  const consistencyHigh = consistencyFindings.filter((f) => f.severity === "HIGH").length;
  for (const seg of segments) {
    const { draftFile, polishedFile } = chapterArtifactNames(seg.id);
    const entry = state.chapters[seg.id] || {};
    const verdict = sidecar.chapters[seg.id] || {};
    const polishEntry = polishChapters[seg.id] || {};
    const draftText = await readFileOrEmpty(path.join(volumeDir, draftFile));
    const polishedText = await readFileOrEmpty(path.join(volumeDir, polishedFile));
    const polishedWins =
      entry.draftHash && entry.polishedDraftHash === entry.draftHash && polishedText.trim().length > 0;

    const verified = verdictCoversCurrentDraft(verdict, entry);
    const published = polishedWins ? "polished" : draftText.trim() ? "draft" : "—";
    let outcome;
    // A chapter that is EMPTY IN THE SOURCE has no text to translate: the pipeline
    // reports the hole instead of pretending it failed to fill it.
    if (seg.empty === true && !draftText.trim()) outcome = "EMPTY IN SOURCE (no text to translate)";
    else if (!draftText.trim()) outcome = "MISSING (never translated)";
    else if (entry.qaFailed === true) outcome = "UNVERIFIED (failed the deterministic QA)";
    else if (!verified) outcome = "UNVERIFIED (no verdict for this draft)";
    else if (verdict.pass === true) outcome = "PUBLISHED (verified)";
    else outcome = "UNVERIFIED (verification FAIL)";

    rows.push({
      volume: volume.installmentNumber,
      folder: volume.folder,
      id: seg.id,
      title: seg.title || seg.id,
      outcome,
      published,
      draftChars: draftText.trim().length,
      qaFailed: entry.qaFailed === true,
      verifyScore: verified && typeof verdict.score === "number" ? verdict.score : null,
      verifyPass: verified ? verdict.pass === true : null,
      tiebreak: verdict.tiebreak
        ? { verifier: verdict.tiebreak.verifier, auditor: verdict.tiebreak.auditor, final: verdict.score }
        : null,
      retranslated: entry.retranslated === true,
      retranslateAttempts: entry.retranslateAttempts || 0,
      bestScore: typeof entry.bestScore === "number" ? entry.bestScore : null,
      ratchetedBack: entry.noImprovement === true,
      // The deterministic cross-chapter scan (written by verify-translate into the
      // sidecar's volume block): how many rendering variants the published text
      // contains, and whether any of them is a real terminology conflict.
      renderingVariants: variants.length,
      renderingVariantConflicts: variants.filter((v) => v.severity === "HIGH").length,
      crossChapterFindings: findingsForChapter(consistencyFindings, seg.id).length,
      crossChapterHigh: findingsForChapter(consistencyFindings, seg.id).filter((f) => f.severity === "HIGH").length,
      polishScore: typeof polishEntry.score === "number" ? polishEntry.score : null,
      polishAccepted: Boolean(entry.polishVerifiedDraftHash && entry.polishVerifiedDraftHash === entry.draftHash),
    });
  }
  return rows;
}

/**
 * The chapter list for a volume: `chapters.json` (the handoff the wiki task
 * writes) when present, otherwise whatever the translation state knows about.
 *
 * @param {string} volumeDir
 * @param {{chapters: Object}} state
 * @returns {Promise<Array<{id: string, title: string}>>}
 */
async function volumeChapterList(volumeDir, state) {
  const chaptersJson = await readJsonOrNull(path.join(volumeDir, "chapters.json"));
  if (chaptersJson && Array.isArray(chaptersJson.chapters) && chaptersJson.chapters.length > 0) {
    return chaptersJson.chapters.map((c) => ({
      id: c.id,
      title: c.title || c.id,
      empty: c.empty === true,
    }));
  }
  return Object.entries(state.chapters || {}).map(([id, entry]) => ({ id, title: (entry && entry.title) || id }));
}

/**
 * Render the Markdown report.
 *
 * @param {Array<Object>} rows
 * @param {{seriesName: string, generatedAt: string, volumes: Array<Object>}} meta
 * @returns {string}
 */
function renderTranslationReport(rows, meta) {
  const byVolume = new Map();
  for (const r of rows) {
    if (!byVolume.has(r.volume)) byVolume.set(r.volume, []);
    byVolume.get(r.volume).push(r);
  }
  const count = (pred) => rows.filter(pred).length;
  const publishedVerified = count((r) => r.outcome === "PUBLISHED (verified)");
  const unverified = count((r) => r.outcome.startsWith("UNVERIFIED"));
  const missing = count((r) => r.outcome.startsWith("MISSING"));
  const emptyInSource = count((r) => r.outcome.startsWith("EMPTY IN SOURCE"));

  const lines = [];
  lines.push(`# Translation Report — ${meta.seriesName}`);
  lines.push("");
  lines.push(
    `_Deterministic roll-up of every translation-stage verdict (no AI): the chapter-by-chapter ` +
      `outcome across the whole series, generated from \`translation-state.json\`, ` +
      `\`translation-verification.json\` and \`polish-verification.json\` in each volume folder. ` +
      `Generated ${meta.generatedAt}._`
  );
  lines.push("");
  lines.push("## Series verdict");
  lines.push("");
  lines.push("| Measure | Count |");
  lines.push("|---|---|");
  lines.push(`| Volumes | ${byVolume.size} |`);
  lines.push(`| Chapters | ${rows.length} |`);
  lines.push(`| Published and verified | ${publishedVerified} |`);
  lines.push(`| Published WITHOUT verification | ${unverified} |`);
  lines.push(`| Missing (never translated) | ${missing} |`);
  lines.push(`| Empty in the source (nothing to translate) | ${emptyInSource} |`);
  lines.push(`| Retranslated at least once | ${count((r) => r.retranslated)} |`);
  lines.push(`| Rolled back by the draft ratchet | ${count((r) => r.ratchetedBack)} |`);
  lines.push(`| Polished and drift-audited | ${count((r) => r.polishAccepted)} |`);
  lines.push("");
  if (emptyInSource > 0) {
    lines.push(
      `**${emptyInSource} chapter(s) have no text in the source.** They are holes in the book, not ` +
        `failures of the pipeline — check the \`[source]\` extraction lines in the run log for why those ` +
        `sections converted to nothing.`
    );
    lines.push("");
  }
  if (Array.isArray(meta.disputes) && meta.disputes.length > 0) {
    const open = meta.disputes;
    const unsupported = open.filter((d) => d.unsupported).length;
    lines.push(
      `**${open.length} glossary dispute(s) are open** — renderings the verifier found the source ` +
      `text contradicting while grading these chapters. The translation obeyed the glossary (as it ` +
      `must); the correction belongs in the glossary, and \`npx gulp glossary\` now takes the queue as ` +
      `an input it has to settle. Details in \`${DISPUTES_REPORT}\` / \`${DISPUTES_FILE}\`.` +
      (unsupported > 0 ? ` ${unsupported} of them name no source quote and are flagged as unproven.` : "")
    );
    lines.push("");
  }
  if (unverified > 0 || missing > 0) {
    lines.push(
      `**${unverified} chapter(s) are in \`translation.md\` marked UNVERIFIED` +
        (missing > 0 ? ` and ${missing} chapter(s) are missing entirely` : "") +
        `.** Each one is flagged in the published file itself.`
    );
    lines.push("");
  }

  for (const [volume, volumeRows] of byVolume) {
    const folder = volumeRows[0].folder;
    lines.push(`## Volume ${volume} — ${folder}`);
    lines.push("");
    lines.push("| Chapter | Title | Outcome | Text | Verify | Retranslates | Ratchet | Polish |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const r of volumeRows) {
      const verify =
        r.verifyScore === null
          ? "—"
          : `${r.verifyScore}/100 ${r.verifyPass ? "PASS" : "FAIL"}` + (r.tiebreak ? " (tiebreak)" : "");
      lines.push(
        `| ${r.id} | ${r.title} | ${r.outcome} | ${r.published} | ${verify} | ` +
          `${r.retranslateAttempts} | ${r.ratchetedBack ? `back to ${r.bestScore}` : r.bestScore === null ? "—" : `${r.bestScore}`} | ` +
          `${r.polishScore === null ? "—" : `${r.polishScore}/100${r.polishAccepted ? " ✓" : ""}`} |`
      );
    }
    lines.push("");
    // The deterministic cross-chapter scan is a VOLUME-level fact (a name spelled
    // two ways is only visible across the volume), so it is reported once here
    // rather than repeated on every chapter row.
    const variantCount = volumeRows.reduce((n, r) => Math.max(n, r.renderingVariants || 0), 0);
    const variantConflicts = volumeRows.reduce((n, r) => Math.max(n, r.renderingVariantConflicts || 0), 0);
    if (variantCount > 0) {
      lines.push(
        `**Rendering variants (deterministic scan, no model call): ${variantCount}**` +
          (variantConflicts > 0
            ? ` — including ${variantConflicts} HIGH conflict(s) where the glossary gives one term two renderings and this volume uses both.`
            : "") +
          ` Details in \`${volumeRows[0].folder}/translation-verification.md\`.`
      );
      lines.push("");
    }
    const crossFindings = volumeRows.reduce((n, r) => Math.max(n, r.crossChapterFindings || 0), 0);
    const crossHigh = volumeRows.reduce((n, r) => Math.max(n, r.crossChapterHigh || 0), 0);
    if (crossFindings > 0) {
      lines.push(
        `**Cross-chapter audit: ${crossFindings} finding(s) naming chapters in this volume**` +
          (crossHigh > 0
            ? ` — ${crossHigh} HIGH, which the \`retranslate\` pass repairs even in a chapter that passed its own verification.`
            : "") +
          ` Details in \`${volumeRows[0].folder}/volume-consistency.md\`.`
      );
      lines.push("");
    }
    const flagged = volumeRows.filter((r) => !r.outcome.startsWith("PUBLISHED"));
    if (flagged.length > 0) {
      lines.push(`### Needs attention — Volume ${volume}`);
      lines.push("");
      for (const r of flagged) {
        lines.push(`- **${r.id} — ${r.title}**: ${r.outcome}` + (r.verifyScore !== null ? ` (score ${r.verifyScore}/100)` : ""));
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

/**
 * Build and write the series-level translation report.
 *
 * Deterministic and cheap, so every publishing translation task calls it at
 * its end: the report is always current with what is on disk.
 *
 * @param {{
 *   seriesDir: string,
 *   manifest: {seriesName?: string, volumes: Array<{folder: string, installmentNumber: string}>},
 *   volumes?: string[],
 *   dryRun?: boolean,
 * }} p
 * @returns {Promise<{file: string, rows: Array<Object>} | null>} The written report, or null in dry-run.
 */
async function writeTranslationReport({ seriesDir, manifest, volumes, dryRun }) {
  if (dryRun) return null;
  const folders = volumes && volumes.length > 0 ? volumes : manifest.volumes.map((v) => v.folder);
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));
  const rows = [];
  for (const folder of folders) {
    const volume = volumeByFolder.get(folder) || { folder, installmentNumber: "?" };
    const volumeDir = path.join(seriesDir, folder);
    const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
    const segments = await volumeChapterList(volumeDir, state);
    if (segments.length === 0) continue;
    rows.push(...(await collectVolumeRows(volumeDir, volume, segments)));
  }

  // The disputes queue is part of what the run produced: it is the one thing the
  // translation stage discovered that the reference layer has to fix, and a
  // reader of the publish report must not have to know the queue exists.
  let disputes = [];
  try {
    disputes = await loadGlossaryDisputes(seriesDir);
  } catch {
    // The report is a roll-up, not a gate: a queue it cannot read is absent
    // from the roll-up, and the queue itself is still on disk.
  }

  const generatedAt = new Date().toISOString();
  const mdFile = seriesArtifactFile(TRANSLATION_REPORT_FILE, "TRANSLATION_REPORT_OUTPUT_FILE", seriesDir);
  const jsonFile = mdFile.replace(/\.md$/, ".json");
  const markdown = renderTranslationReport(rows, {
    seriesName: manifest.seriesName || path.basename(seriesDir),
    generatedAt,
    volumes: folders.map((f) => volumeByFolder.get(f) || { folder: f }),
    disputes,
  });
  await fs.writeFile(mdFile, markdown, "utf8");
  await fs.writeFile(
    jsonFile,
    JSON.stringify({ schema: 1, generatedAt, seriesName: manifest.seriesName || null, chapters: rows }, null, 2) + "\n",
    "utf8"
  );
  await writeProvenanceSidecar(mdFile, jsonFile);

  const summary = summarizeReportRows(rows);
  console.log(
    `[translation-report] ${summary.total} chapter(s): ` +
      `${summary.published} verified, ${summary.unverified} unverified, ` +
      `${summary.missing} missing` +
      (summary.emptyInSource > 0 ? `, ${summary.emptyInSource} empty in the source` : "") +
      `. Report: ${mdFile}`
  );
  return { file: mdFile, rows, summary };
}

/**
 * Read the machine-readable report back off the disk.
 *
 * The report is written at the end of every publishing translation task, so it is always
 * current with what is on disk — which makes it the cheapest possible answer to "what is
 * actually good enough to read?" for anything that has to ask that question without running
 * the stage again. `utils/resume.js` (the delivery manager's triage) and
 * `utils/delivery-verify.js` (the before/after comparison) both read through here, so the
 * publish report cannot be described two different ways by two different consumers.
 *
 * @param {string} seriesDir
 * @returns {Promise<{file: string, generatedAt: string|null, chapters: Array<Object>}|null>}
 *   null when the report does not exist, does not parse, or has no chapter list — the report
 *   is a roll-up, and a roll-up that cannot be read is absent, not empty.
 */
async function readTranslationReport(seriesDir) {
  const file = seriesArtifactFile(TRANSLATION_REPORT_JSON, "TRANSLATION_REPORT_OUTPUT_FILE", seriesDir);
  const parsed = await readJsonOrNull(file);
  if (!parsed || !Array.isArray(parsed.chapters)) return null;
  return { file, generatedAt: parsed.generatedAt || null, chapters: parsed.chapters };
}

/**
 * The one roll-up of the report's rows.
 *
 * Every consumer of the deliverable needs the same buckets, and the pipeline already had two
 * of them: this task's own console line, and `utils/resume.js`'s reading of the same file.
 * Two readings of one file is how two answers to "did it help?" appear. This is the one.
 *
 * The buckets are the report's own outcomes, and they are deliberately derived from the
 * outcome text rather than from the verdict files: the outcome is what the pipeline decided
 * to publish, and it already accounts for a stale polish, a missing verdict, and a chapter
 * that is empty in the BOOK rather than missing from the run.
 *
 * @param {Array<Object>} rows - The report's chapter rows.
 * @returns {{
 *   total: number, published: number, unverified: number, missing: number, emptyInSource: number,
 *   scoreCount: number, scoreMedian: number|null, scoreMin: number|null,
 *   crossChapterHigh: number, variantConflicts: number, publishedChars: number,
 * }}
 */
function summarizeReportRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const bucket = (row) => {
    const outcome = typeof row.outcome === "string" ? row.outcome : "";
    if (outcome.startsWith("PUBLISHED")) return "published";
    if (outcome.startsWith("UNVERIFIED")) return "unverified";
    if (outcome.startsWith("MISSING")) return "missing";
    return "emptyInSource";
  };
  const counts = { total: list.length, published: 0, unverified: 0, missing: 0, emptyInSource: 0 };
  const scores = [];
  let crossChapterHigh = 0;
  let variantConflicts = 0;
  let publishedChars = 0;
  for (const row of list) {
    counts[bucket(row)] += 1;
    if (typeof row.verifyScore === "number") scores.push(row.verifyScore);
    crossChapterHigh += Number(row.crossChapterHigh) || 0;
    variantConflicts += Number(row.renderingVariantConflicts) || 0;
    publishedChars += Number(row.draftChars) || 0;
  }
  return {
    ...counts,
    scoreCount: scores.length,
    scoreMedian: scores.length ? medianScore(scores) : null,
    scoreMin: scores.length ? Math.min(...scores) : null,
    crossChapterHigh,
    variantConflicts,
    publishedChars,
  };
}

/**
 * The translation stage's entry gate.
 *
 * The pipeline produces two things no later stage can repair: the reference
 * artifacts' internal consistency, and the glossary's terminology decisions.
 * Both were advisory — a FAIL consistency report and a volume with no glossary
 * at all each produced one console line that scrolls past in an overnight run,
 * and the translation stage then spent hours producing a book whose terminology
 * nothing had agreed on.
 *
 * Both are now gates, with explicit overrides so the un-monitored path stays
 * usable when the operator has decided the gap is acceptable:
 *   `--allow-fail`       translate despite a FAIL (or missing) consistency audit
 *   `--allow-no-glossary` translate a volume that has no glossary
 *
 * @param {{
 *   seriesDir: string,
 *   volumes: Array<{folder: string, installmentNumber: string}>,
 *   allowFail?: boolean,
 *   allowNoGlossary?: boolean,
 *   dryRun?: boolean,
 * }} p
 * @returns {Promise<void>}
 * @throws {Error} When a gate fails and no override was given.
 */
async function checkTranslationPreconditions({ seriesDir, volumes, allowFail, allowNoGlossary, dryRun }) {
  if (dryRun) return;
  const problems = [];

  // 1. The pre-translation sign-off. consistency-audit exists precisely to be
  //    the gate before an expensive translation run; ignoring it makes it a
  //    document nobody reads.
  // consistency-audit.js writes the report at the series ROOT (not the
  // artifacts directory) — the gate must look at the same file it writes.
  const auditFile = path.join(seriesDir, "consistency-report.md");
  const audit = await readFileOrEmpty(auditFile);
  if (!audit.trim()) {
    problems.push(
      `no consistency-report.md at ${auditFile} — run \`npx gulp consistency-audit\` first ` +
        `(it is the pre-translation sign-off over glossary / character-voice / style-guide / shared-wiki). ` +
        `Override with --allow-fail.`
    );
  } else {
    const verdict = (audit.match(/\*\*(PASS|FAIL)\*\*/) || [])[1];
    if (verdict === "FAIL") {
      problems.push(
        `consistency-report.md verdict is FAIL — the reference artifacts contradict each other, and a ` +
        `translation built on them inherits the contradictions. Fix the artifact the report names, re-run ` +
        `that task, re-audit with --force. Override with --allow-fail.`
      );
    } else if (!verdict) {
      problems.push(
        `consistency-report.md has no PASS/FAIL verdict line — the audit is not a sign-off. ` +
        `Re-run \`npx gulp consistency-audit --force\`. Override with --allow-fail.`
      );
    }
  }

  // 2. Terminology. The glossary is the one artifact no later stage can fix:
  //    verification can flag a wrong rendering, but only the glossary task can
  //    decide the right one, and a volume translated without it invents its own.
  const missingGlossary = [];
  for (const volume of volumes) {
    const glossaryFile = path.join(seriesDir, volume.folder, "glossary.md");
    if (!(await fileExists(glossaryFile))) missingGlossary.push(volume.installmentNumber);
  }
  if (missingGlossary.length > 0) {
    problems.push(
      `${missingGlossary.length} volume(s) have no glossary.md: ${missingGlossary.join(", ")}. ` +
        `Run \`npx gulp glossary\` first — terminology consistency is the one thing the translation ` +
        `stage cannot repair afterwards. Override with --allow-no-glossary.`
    );
  }

  if (problems.length > 0) {
    if (allowFail && allowNoGlossary) {
      console.warn(
        `[translate] overriding the entry gate (${problems.length} problem(s)) — you asked for ` +
        `--allow-fail and --allow-no-glossary:\n  - ${problems.join("\n  - ")}`
      );
      return;
    }
    const missingOverride = [
      !allowFail ? "--allow-fail" : null,
      !allowNoGlossary ? "--allow-no-glossary" : null,
    ]
      .filter(Boolean)
      .join(" / ");
    throw new Error(
      `translate refuses to start (${problems.length} unresolved problem(s)):\n  - ` +
        problems.join("\n  - ") +
        `\nResolve the artifact problems first, or pass ${missingOverride} to proceed anyway.`
    );
  }
}

module.exports = {
  writeTranslationReport,
  readTranslationReport,
  summarizeReportRows,
  checkTranslationPreconditions,
  renderTranslationReport,
  collectVolumeRows,
  volumeChapterList,
  TRANSLATION_REPORT_FILE,
  TRANSLATION_REPORT_JSON,
  MERGED_FILE,
};

/**
 * One volume's pass: the chapter loop, the ONE audit batch that carries both cross-checks (the borderline tiebreak and the cross-chapter audit — one container switch, never interleaved with the verifier, gotcha 46), the rendering-variant scan, and the commit phase that writes the sidecar, the report and the publish merge.
 *
 * Part of the verify-translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { fileExists } = require("../utils/fs");
const { transformUserPrompt, parseAcceptanceScore, writePromptDump } = require("../utils/prompt");
const {
  parseGlossaryDisputes,
  collectVolumeDisputes,
  mergeDisputes,
  loadGlossaryDisputes,
  saveGlossaryDisputes,
  DISPUTES_FILE,
  DISPUTES_REPORT,
} = require("../utils/disputes");
const {
  sha256,
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  glossaryBlockMaxChars,
  runWithConcurrency,
  stageConcurrency,
  judgeTemperature,
  stageThinking,
  chapterArtifactNames,
  loadVerificationSidecar,
  readFileOrEmpty,
  saveVerificationSidecar,
  findingsOf,
  glossaryBlock,
  medianScore,
  recordBestDraft,
  verdictCoversCurrentDraft,
  estimateTokens,
  fitPromptBudget,
  describeDroppedBlocks,
  findRenderingVariants,
  renderVariantFindings,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  previousVolumeTail,
  tailOf,
  resolvePublishedChapterTexts,
  planConsistencyWindows,
  parseVolumeFindings,
  buildVolumeConsistencyMarkdown,
  loadVolumeConsistency,
  saveVolumeConsistency,
  VOLUME_CONSISTENCY_FILE,
  VOLUME_CONSISTENCY_REPORT,
  loadTranslationState,
  STATE_FILE,
  MERGED_FILE,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
} = require("../utils/translate");

const { FINDINGS_MAX_CHARS, auditConcurrency, auditTemperature, auditThinking, passingScore, tiebreakBand, verifyConcurrency, verifyThinking } = require("./config");
const { buildVerifyPrompt, gradeChapter } = require("./grade");
const { buildVerificationReportMarkdown, readPublishedVolumeText, saveVolumeFindings } = require("./report");

/**
 * (#5) The borderline tiebreak — a BATCHED cross-check pass over the chapters
 * whose verifier score lands within ±tiebreakBand of the passing score. Each
 * such chapter is re-scored by the audit endpoint (a SECOND endpoint, distinct
 * from the verifier's) and the two scores are AVERAGED: a second opinion on
 * the chapters closest to the pass/fail boundary, where a single stochastic
 * score matters most. The pass/fail is recomputed from the averaged score.
 * The whole batch runs under one endpoint (the caller wraps it in the
 * verify-audit hook — on shared-port local setups that is one container
 * switch), never interleaved with the verify loop.
 *
 * Fail-open: an unparseable audit score leaves the verifier's score in place
 * (the tiebreak is a second opinion, not a veto — the first score already
 * stands). A chapter is tiebreak-applied at most once per draft
 * (`tiebreakApplied`), so a plain re-run is a cheap no-op.
 *
 * @param {{
 *   volume: {installmentNumber: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string}>},
 *   refs: {terms: Array<{term: string, rendering: string}>, styleRules: string, background: string},
 *   systemPrompt: string,
 *   template: string,
 *   sidecar: {chapters: Object},
 *   sidecarPath: string,
 *   auditEndpoint: {baseUrl: string, apiKey?: string, model: string},
 * }} ctx
 * @returns {Promise<Array<{id: string, verifier: number, auditor: number|null, final: number, prevPass: boolean, newPass: boolean}>>}
 *   The tiebroken chapters (empty when there is nothing to tiebreak).
 */
async function runAuditTiebreak({ volume, volumeDir, bundle, refs, systemPrompt, template, sidecar, sidecarPath, auditEndpoint, dryRun = false }) {
  const eligible = [];
  for (const seg of bundle.segments) {
    const e = sidecar.chapters[seg.id] || {};
    if (e.tiebreakApplied) continue;
    if (typeof e.score !== "number") continue;
    if (e.score < passingScore - tiebreakBand || e.score > passingScore + tiebreakBand) continue;
    eligible.push(seg);
  }
  if (eligible.length === 0) return [];

  await harness.assertModelServing({ ...auditEndpoint, label: "verify-audit tiebreak" });
  // The auditor is a DIFFERENT model from the verifier, and the cross-chapter
  // audit windowing in this same batch budgets with these estimates — so the
  // coefficients are re-pointed at the audit model for the whole batch.
  await calibrateStageTokens({ endpoint: auditEndpoint, bundle, label: "verify-audit batch", dryRun });
  console.log(
    `[verify-audit] ${eligible.length} borderline chapter(s) (score within ±${tiebreakBand} of ${passingScore}) — ` +
      `tiebreaking with the audit endpoint (${auditEndpoint.model}).`
  );

  const results = [];
  await runWithConcurrency(eligible, auditConcurrency, async (seg) => {
    const { draftFile } = chapterArtifactNames(seg.id);
    const chapterPath = path.join(volumeDir, seg.file);
    const draftPath = path.join(volumeDir, draftFile);
    let sourceText;
    let draft;
    try {
      sourceText = await fs.readFile(chapterPath, "utf8");
      draft = await fs.readFile(draftPath, "utf8");
    } catch {
      return; // source/draft vanished since verification — skip the tiebreak
    }
    const e = sidecar.chapters[seg.id] || {};
    // Re-confirm the sidecar entry still covers the CURRENT source + draft —
    // a stale entry means the verifier's score is stale too, so tiebreaking
    // it is meaningless.
    if (e.sourceHash !== sha256(sourceText) || e.draftHash !== sha256(draft)) return;

    const values = {
      SOURCE_TEXT: sourceText,
      TRANSLATION_TEXT: draft,
      GLOSSARY: glossaryBlock(chapterTerminology(refs, sourceText).terms),
      STYLE_RULES: refs.styleRules || "(none provided — run the style-guide task)",
      BACKGROUND: refs.background || "(none provided — run the jump-in-wiki task)",
    };
    const prompt = transformUserPrompt(template, values);
    const result = await harness.runOneShot({
      systemPrompt,
      messages: [{ text: prompt }],
      endpoint: auditEndpoint,
      // The role endpoint's own output cap / context window (harness.js derives
      // them from the global AI_* settings when the role sets neither).
      maxTokens: auditEndpoint.maxTokens,
      contextWindow: auditEndpoint.contextWindow,
      temperature: Number.isFinite(auditTemperature) ? auditTemperature : 0.2,
      thinking: auditThinking.thinking,
      thinkingLevel: auditThinking.thinkingLevel,
      label: `verify-audit-v${volume.installmentNumber}-${seg.id}`,
    });
    const auditScore = parseAcceptanceScore(result);
    const auditorFindings = findingsOf(result, FINDINGS_MAX_CHARS);
    // The auditor may challenge the glossary too — its dispute joins the queue.
    const auditorDisputes = parseGlossaryDisputes(result);
    const verifierScore = e.score;
    const final = auditScore !== null ? Math.round((verifierScore + auditScore) / 2) : verifierScore;
    const prevPass = e.pass === true;
    // An average may not manufacture a pass that NEITHER grader gave. The
    // tiebreak exists to settle chapters sitting on the boundary, not to turn
    // two below-threshold scores into a pass (observed: a 68 and a 66 averaged
    // to 69 and the chapter shipped). When both graders scored it below the
    // line, it stays a FAIL whatever the average says.
    const bothBelowLine = auditScore !== null && verifierScore < passingScore && auditScore < passingScore;
    const newPass = final >= passingScore && !bothBelowLine;
    // A FAIL→PASS flip is allowed (that is what a second opinion is for), but
    // it is recorded and shown: a chapter that only passes because of the
    // tiebreak is a chapter a reader should know was argued into passing.
    const rescue = !prevPass && newPass;
    // Keep the AUDITOR's findings when the auditor is the one dragging the
    // chapter down: if the tiebreak lands the chapter at FAIL and the auditor
    // scored no higher than the verifier, the actionable problems are the
    // auditor's, not the verifier's more favourable set. A retranslate of this
    // chapter must fix what the auditor flagged, or the loop re-fails on the
    // same issues. When the auditor is the optimist (or the chapter still
    // passes) the verifier's findings stand.
    const auditorIsPessimist =
      auditScore !== null && !newPass && auditScore <= verifierScore;
    sidecar.chapters[seg.id] = {
      ...e,
      score: final,
      pass: newPass,
      ...(auditorIsPessimist && auditorFindings
        ? { findings: auditorFindings }
        : {}),
      tiebreak: { verifier: verifierScore, auditor: auditScore, final, auditorFindings, rescue },
      tiebreakApplied: true,
      tiebreakRescue: rescue,
      ...(auditorDisputes.length > 0
        ? { disputes: mergeDisputes(Array.isArray(e.disputes) ? e.disputes : [], auditorDisputes) }
        : {}),
      verifiedAt: new Date().toISOString(),
    };
    await saveVerificationSidecar(sidecarPath, sidecar);
    results.push({ id: seg.id, verifier: verifierScore, auditor: auditScore, final, prevPass, newPass, rescue });
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: tiebreak — verifier ${verifierScore}, auditor ` +
        `${auditScore === null ? "n/a (kept the verifier score)" : auditScore} → averaged ${final}/100 → ${newPass ? "PASS" : "FAIL"}` +
        (rescue ? " (RESCUED: passes only because of the tiebreak)" : "") +
        (bothBelowLine && final >= passingScore ? " (both graders scored below the line — kept FAIL)" : "") +
        (auditorIsPessimist ? " (auditor's findings kept for retranslate)" : "") +
        "."
    );
  });
  return results;
}


/**
 * Verify one volume's chapter drafts against their sources.
 *
 * @param {{
 *   volume: {folder: string, sourceFile: string, installmentNumber: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string, chars: number}>},
 *   refs: {terms: Array<{term: string, rendering: string}>, styleRules: string, background: string},
 *   systemPrompt: string,
 *   template: string,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   dryRun: boolean,
 *   force: boolean,
 * }} ctx
 * @returns {Promise<{verified: number, skipped: number, passed: number, failed: number, noDraft: number}>}
 */
async function processVerifyVolume(ctx) {
  const { volume, volumeDir, bundle, refs, systemPrompt, template, endpoint, auditEndpoint, dryRun, force } = ctx;
  const sidecarPath = path.join(volumeDir, VERIFICATION_FILE);
  const sidecar = await loadVerificationSidecar(sidecarPath);
  // The translation state carries the deterministic-QA failure marker — the
  // one verdict the verify task can produce without asking the model anything.
  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  const rows = [];
  /**
   * A heartbeat for an un-monitored run: every 10 chapters, a greppable
   * "N/M" line, so a reader of the log can tell a slow stage from a stuck one
   * without waiting for the volume to finish.
   */
  let doneCount = 0;
  const heartbeat = (id) => {
    doneCount += 1;
    if (doneCount % 10 === 0 || doneCount === bundle.segments.length) {
      harness.logLine(
        `[progress] verify Volume ${volume.installmentNumber}: ${doneCount}/${bundle.segments.length} chapter(s) (last: ${id})`
      );
    }
  };
  let verified = 0;
  let skipped = 0;
  let passed = 0;
  let failed = 0;
  let noDraft = 0;

  // Chapters are INDEPENDENT (each is verified against its own source +
  // draft), so they can run in parallel when STAGE_CONCURRENCY > 1. Rows are
  // stored by index to keep the report in reading order.
  await runWithConcurrency(bundle.segments, verifyConcurrency, async (seg, idx) => {
    heartbeat(seg.id);
    const { draftFile } = chapterArtifactNames(seg.id);
    const chapterPath = path.join(volumeDir, seg.file);
    const draftPath = path.join(volumeDir, draftFile);
    if (!(await fileExists(draftPath))) {
      console.warn(
        `  Volume ${volume.installmentNumber} ${seg.id}: no draft (${draftFile}) — run the translate task first.`
      );
      noDraft += 1;
      rows[idx] = { id: seg.id, title: seg.title, status: "no draft (run translate first)", score: null, pass: null };
      return;
    }
    const sourceText = await fs.readFile(chapterPath, "utf8");
    const draft = await fs.readFile(draftPath, "utf8");
    const sourceHash = sha256(sourceText);
    const draftHash = sha256(draft);

    const entry = sidecar.chapters[seg.id] || {};
    const covered =
      !force &&
      typeof entry.sourceHash === "string" &&
      entry.sourceHash === sourceHash &&
      typeof entry.draftHash === "string" &&
      entry.draftHash === draftHash;

    // A draft the translate task already flagged as failing the deterministic
    // QA needs no grader: the reason is known and already actionable, and
    // spending a model call to rediscover it is pure cost. Seeding the verdict
    // here is what lets the retranslate batch treat it like any other FAIL
    // instead of skipping it for having no verification entry at all.
    const stateEntry = state.chapters[seg.id] || {};
    if (!covered && stateEntry.qaFailed === true) {
      const findings =
        stateEntry.qaFindings || "(the deterministic QA checks failed — see this volume's translation-qa.md)";
      sidecar.chapters[seg.id] = {
        sourceHash,
        draftHash,
        score: null,
        pass: false,
        findings,
        deterministic: true,
        samples: [],
        verifiedAt: new Date().toISOString(),
      };
      await saveVerificationSidecar(sidecarPath, sidecar);
      failed += 1;
      console.warn(
        `  Volume ${volume.installmentNumber} ${seg.id}: deterministic QA FAIL — no model call needed, ` +
          `queued for retranslation.`
      );
      rows[idx] = {
        id: seg.id,
        title: seg.title,
        status: "deterministic QA FAIL (no model call)",
        score: null,
        pass: false,
        findings,
      };
      return;
    }
    if (covered) {
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: verification up to date — skipping.`);
      skipped += 1;
      if (entry.pass) passed += 1;
      else failed += 1;
      rows[idx] = {
        id: seg.id,
        title: seg.title,
        status: "skipped (up to date)",
        score: entry.score,
        pass: entry.pass,
        findings: entry.findings,
      };
      return;
    }

    const { prompt } = buildVerifyPrompt({
      template,
      sourceText,
      draft,
      refs,
      roleWindow: endpoint.contextWindow || harness.envContextWindow(),
      outputReserve: endpoint.maxTokens || harness.envMaxTokens(),
    });

    if (dryRun) {
      // Dump the prompt for every chapter a live run would verify (no-draft
      // and already-covered chapters were skipped above) — one file per
      // chapter, no AI calls in dry-run.
      const file = await writePromptDump(
        `verify-translate-${volume.installmentNumber}-${seg.id}`,
        volume.installmentNumber,
        "one-shot (verify model)",
        [
          { title: "One-shot — verify system prompt", prompt: systemPrompt },
          {
            title:
              `One-shot — verify ${seg.id} ` +
              `(endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${verifyThinking.thinking ? verifyThinking.thinkingLevel : "off"})`,
            prompt,
          },
        ]
      );
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: --dry-run prompt dump → ${file}`);
      return;
    }

    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: verifying draft (${draft.length} chars) with ${endpoint.model}…`
    );
    // Sample 1 of VERIFY_SAMPLES. The remaining samples are a separate BATCH
    // (runVerificationSamples) so the extra grading never interleaves with the
    // first pass — on a shared-port local setup that keeps it to one model.
    const graded = await gradeChapter({
      volume,
      systemPrompt,
      template,
      endpoint,
      sourceText,
      draft,
      refs,
      label: `verify-v${volume.installmentNumber}-${seg.id}`,
    });
    const score = graded.score;
    // Fail-closed: an unparseable score is a FAIL (the retranslate pass gets
    // another shot at the chapter).
    const pass = score !== null && score >= passingScore;
    const findings = graded.findings;
    sidecar.chapters[seg.id] = {
      sourceHash,
      draftHash,
      score,
      pass,
      findings,
      ...(graded.disputes.length > 0 ? { disputes: graded.disputes } : {}),
      samples: [score],
      verifiedAt: new Date().toISOString(),
    };
    if (graded.disputes.length > 0) {
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: ${graded.disputes.length} GLOSSARY DISPUTE(s) ` +
          `(${graded.disputes.map((d) => d.term).join(", ")}) — queued for the glossary task.`
      );
    }
    await saveVerificationSidecar(sidecarPath, sidecar);
    verified += 1;
    if (pass) passed += 1;
    else failed += 1;
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: score ${score === null ? "n/a (unparseable — FAIL)" : score + "/100"} → ${pass ? "PASS" : "FAIL"}.`
    );
    rows[idx] = { id: seg.id, title: seg.title, status: "verified", score, pass, findings };
  });

  return { verified, skipped, passed, failed, noDraft, sidecar, sidecarPath };
}


/**
 * Commit the volume's verdicts: record each chapter's best-scoring draft (the
 * ratchet's restore point) and write the verification report from the sidecar,
 * so the report always matches the files on disk.
 *
 * @param {{
 *   volume: {installmentNumber: string, folder: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string}>},
 *   refs: Object,
 *   targetLanguage?: string,
 * }} ctx
 * @returns {Promise<{rows: Array<Object>, passed: number, failed: number, noDraft: number, verified: number, skipped: number}>}
 */
async function commitVerificationVolume({ volume, volumeDir, bundle, refs, targetLanguage = "English" }) {
  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  const sidecarPath = path.join(volumeDir, VERIFICATION_FILE);
  const sidecar = await loadVerificationSidecar(sidecarPath);
  const rows = [];
  let passed = 0;
  let failed = 0;
  let noDraft = 0;
  let verified = 0;
  let skipped = 0;

  for (const seg of bundle.segments) {
    const { draftFile } = chapterArtifactNames(seg.id);
    const entry = state.chapters[seg.id] || {};
    const verdict = sidecar.chapters[seg.id];
    const hasDraft = await fileExists(path.join(volumeDir, draftFile));
    if (!hasDraft) {
      noDraft += 1;
      rows.push({ id: seg.id, title: seg.title, status: "no draft (run translate first)", score: null, pass: null });
      continue;
    }
    if (!verdict || !verdictCoversCurrentDraft(verdict, entry)) {
      rows.push({ id: seg.id, title: seg.title, status: "not verified", score: null, pass: null });
      continue;
    }
    verified += 1;
    if (verdict.pass === true) passed += 1;
    else failed += 1;
    const samples = Array.isArray(verdict.samples) && verdict.samples.length > 1 ? ` samples [${verdict.samples.join(", ")}]` : "";
    rows.push({
      id: seg.id,
      title: seg.title,
      status: verdict.deterministic
        ? "deterministic QA FAIL"
        : `verified${samples}` + (verdict.tiebreakApplied ? ` (tiebreak ${verdict.score})` : ""),
      score: verdict.score,
      pass: verdict.pass,
      findings: verdict.findings,
    });
    // The ratchet's restore point: the best draft we have ever verified for
    // this chapter, so a later rewrite that scores worse can be rolled back.
    await recordBestDraft(volumeDir, seg.id, {
      score: verdict.score,
      pass: verdict.pass,
      findings: verdict.findings,
      sourceHash: entry.sourceHash,
      draftHash: entry.draftHash,
    });
  }

  // The deterministic variant scan (no model call): every glossary term used in
  // this volume, checked against the PUBLISHED text for near-variants of its
  // canonical rendering. The per-chapter verifier reads one chapter at a time and
  // cannot see this class of drift at all — a name spelled one way in chapter 2
  // and another way in chapter 7 is only visible across the volume, and it costs
  // nothing to look.
  const publishedText = await readPublishedVolumeText(volumeDir, bundle);
  const variantFindings = findRenderingVariants({
    text: publishedText,
    terms: (refs && refs.terms) || [],
    targetLanguage,
  });
  if (variantFindings.length > 0) {
    harness.logLine(
      `[verify-translate] Volume ${volume.installmentNumber}: ${variantFindings.length} rendering variant(s) ` +
        `found by the deterministic scan — ` +
        variantFindings.map((f) => `${f.severity} ${f.term} → ${f.variant}`).join("; ")
    );
  }
  await saveVolumeFindings(volumeDir, variantFindings);

  await fs.writeFile(
    path.join(volumeDir, VERIFICATION_REPORT),
    buildVerificationReportMarkdown(volume, rows, variantFindings),
    "utf8"
  );
  return { rows, passed, failed, noDraft, verified, skipped, variantFindings };
}


module.exports = {
  runAuditTiebreak,
  processVerifyVolume,
  commitVerificationVolume,
};

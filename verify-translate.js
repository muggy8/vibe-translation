/**
 * verify-translate.js — Logic for the "verify-translate" gulp task: the
 * source-anchored verification pass of the translation pipeline.
 *
 * Task: verify-translate — four phases, so the model switches stay batched:
 *   1. First sample — every volume's chapters, on the verify endpoint.
 *      For each chapter that has a translation-<id>.md draft:
 *        a. Skip it when the verification sidecar (translation-verification.json)
 *           already covers the CURRENT source + draft hashes (idempotency;
 *           --force re-verifies).
 *        b. A draft the translate task marked `qaFailed` gets its verdict from
 *           the deterministic QA findings with NO model call — the reason is
 *           already known, and this is what lets the retranslate batch pick the
 *           chapter up instead of skipping it for having no entry.
 *        c. Otherwise one-shot call to the verify endpoint (VERIFY_* env):
 *           source + draft + glossary + style rules + story background →
 *           0–100 score + severity-banded findings. An unparseable score is a
 *           FAIL (fail-closed).
 *   2. Repeat samples — chapters within ±VERIFY_SAMPLE_BAND of the passing
 *      score are graded up to VERIFY_SAMPLES times (a disagreement beyond
 *      ACCEPTANCE_SCORE_TOLERANCE is settled at temperature 0) and the MEDIAN
 *      becomes the verdict. Same endpoint, so this costs no model switch.
 *   3. Cross-model tiebreak — every borderline chapter in EVERY volume is
 *      re-scored on the AUDIT endpoint in ONE batch (one hook invocation for
 *      the whole run, not one per volume). The two scores are averaged, but an
 *      average may not manufacture a pass that neither grader gave, and a
 *      FAIL→PASS flip is recorded as a `tiebreakRescue`.
 *   4. Commit — record each chapter's best-scoring draft (the draft ratchet's
 *      restore point) and write the per-volume report from the sidecar, so the
 *      counts describe the files on disk.
 *
 * Chapters that FAIL are retranslated by the "retranslate" task (the
 * TRANSLATE_* endpoint), using the findings as correction instructions; the
 * pipeline re-runs verify-translate afterwards. Set
 * VERIFY_TRANSLATE_ENABLED=false to make this task a no-op (retranslate is
 * disabled with it — they are one QA chain).
 *
 * Usage:
 *   npx gulp verify-translate              # run the full task
 *   npx gulp verify-translate --dry-run    # dump the prompts only, no AI calls
 *   npx gulp verify-translate --force      # re-verify even if covered
 *   npx gulp verify-translate --volume 01  # single volume
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types"); // JSDoc type definitions
const harness = require("./harness");
const { getTranslationTarget } = require("./get-translation-target");
const { filterVolumesByInstallment } = require("./utils/manifest");
const { ON_VOLUME_ERROR, PASSING_SCORE, ACCEPTANCE_SCORE_TOLERANCE, validateRequiredEnv, isStructuralError, volumeFailureError, readBoolEnv, resolveRunSettings } = require("./configs/shared");
const { fileExists } = require("./utils/fs");
const { resolveSourceBundle } = require("./utils/source");
const { transformUserPrompt, parseAcceptanceScore, writePromptDump } = require("./utils/prompt");
const { writeTranslationReport } = require("./utils/translation-report");
const {
  parseGlossaryDisputes,
  collectVolumeDisputes,
  mergeDisputes,
  loadGlossaryDisputes,
  saveGlossaryDisputes,
  DISPUTES_FILE,
  DISPUTES_REPORT,
} = require("./utils/disputes");
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
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
} = require("./utils/translate");
const { withHooks } = require("./utils/hooks");

// ─── Paths & config ──────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const verifySystemPromptFile = path.join(clientDir, "system-prompts", "verify-translate.md");
const verifyTemplateFile = path.join(clientDir, "user-prompts", "verify-translate.md");
const consistencySystemPromptFile = path.join(clientDir, "system-prompts", "volume-consistency.md");
const consistencyTemplateFile = path.join(clientDir, "user-prompts", "volume-consistency.md");

// The sidecar I/O (loadVerificationSidecar / saveVerificationSidecar), the
// findings extractor and the glossary block now live in utils/translate.js —
// every translation task uses them, and task modules must not import from each
// other. They are re-exported at the bottom of this file for compatibility.

/** Verification is default-ON (it is the QA chain with retranslate). */
const verifyEnabled = process.env.VERIFY_TRANSLATE_ENABLED !== "false";
/** Chapter concurrency within a volume (opt-in; default 1 = serial — the
 *  local hardware runs one inference at a time). */
const verifyConcurrency = stageConcurrency("VERIFY");
/** Score (0–100) at or above which a chapter passes verification — the shared
 *  PASSING_SCORE (the same threshold the acceptance checks use). */
const passingScore = PASSING_SCORE;
/** The verify endpoint's thinking dialect (AI_THINKING + STAGE_THINKING_LEVEL). */
const verifyThinking = stageThinking("VERIFY");
/** Grading temperature (JUDGE_TEMPERATURE). */
const verifyTemperature = judgeTemperature();
/** Findings injected into the retranslate prompt — keep them bounded. */
const FINDINGS_MAX_CHARS = 6000;

/** (#5) The audit role — a SECOND endpoint (AUDIT_* env) used as the
 *  cross-check. The task logic is identical whatever model serves it; on
 *  shared-port local setups the pre-verify-audit hook decides which container
 *  answers. Configure it to a DIFFERENT model than the verifier, or the
 *  cross-check grades the work with the same model twice. */
const auditThinking = stageThinking("AUDIT");
const auditTemperature = judgeTemperature();
/** (#5) Borderline tiebreak: a chapter whose verifier score lands within
 *  ±VERIFY_TIEBREAK_BAND of the passing score is re-scored by the audit
 *  endpoint and the two scores are AVERAGED (a batched cross-check pass).
 *  DEFAULT-ON. */
const tiebreakEnabled = process.env.VERIFY_TIEBREAK_ENABLED !== "false";
const tiebreakBand = Math.max(0, parseInt(process.env.VERIFY_TIEBREAK_BAND, 10) || 5);
/** (#5) Audit batch concurrency (opt-in; default 1). */
const auditConcurrency = stageConcurrency("AUDIT");
/**
 * The cross-chapter consistency pass (DEFAULT-ON): one audit call per volume
 * window that reads the volume's PUBLISHED chapters together — the one thing a
 * per-chapter verifier structurally cannot see. Runs on the AUDIT_* role inside
 * the same batch as the tiebreak, so it costs no extra container switch.
 * Set VOLUME_CONSISTENCY_ENABLED=false to skip it (the deterministic variant
 * scan still runs).
 */
const volumeConsistencyEnabled = readBoolEnv("VOLUME_CONSISTENCY_ENABLED", true);

/**
 * How many times a borderline chapter is graded by the verifier. One stochastic
 * score decides a chapter's fate while the pre-production artifacts require a
 * rolling window of samples — the same grader, the same flakiness, a stricter
 * gate for the deliverable. Default 2.
 */
const verifySamples = Math.max(1, Math.min(5, parseInt(process.env.VERIFY_SAMPLES, 10) || 2));
/**
 * Only chapters within ±this many points of the passing score get the extra
 * samples: a chapter at 92 or at 30 is not a close call, and paying to re-grade
 * every chapter of 17 volumes is not what the sampling is for.
 */
const sampleBand = Math.max(0, parseInt(process.env.VERIFY_SAMPLE_BAND, 10) || 8);
/** Two samples further apart than this are settled by a third at temperature 0. */
const sampleTolerance = ACCEPTANCE_SCORE_TOLERANCE;

// ─── Cross-chapter consistency pass (the per-chapter blind spot) ────────────

/** How much of the previous audit window (or the previous volume) is carried
 *  into the next one as continuity context. */
const CONSISTENCY_TAIL_CHARS = 2000;

/**
 * One audit call per volume window that reads the volume's PUBLISHED chapters
 * TOGETHER.
 *
 * Every other translation check reads one chapter at a time. That is the right
 * shape for fidelity ("does this chapter say what its source says?") and the
 * wrong shape for drift: a volume that renders one name two ways, states a fact
 * in chapter 3 and denies it in chapter 9, or quietly changes tense halfway
 * through publishes chapters that each score 90 and a book that contradicts
 * itself. Nothing in the per-chapter chain can see that class at all.
 *
 * It runs on the AUDIT_* role, inside the SAME batch as the borderline
 * tiebreak — one container switch for both cross-checks, never interleaved
 * with the verifier.
 *
 * It reads what the reader reads: `resolvePublishedChapterTexts` is the merge's
 * own rule, so the audit and `translation.md` cannot describe different texts.
 *
 * Findings are chapter-tagged and written to `volume-consistency.json`, which
 * the retranslate pass reads as correction tasks for the named chapters (the
 * draft ratchet guarantees a repair that scores worse is rolled back).
 *
 * Idempotent: the sidecar records the hash of the published volume text plus
 * the reference fingerprint, so a re-run re-audits only a volume whose text or
 * references actually changed.
 *
 * @param {{
 *   volume: {installmentNumber: string, folder: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<Object>},
 *   refs: {glossaryText: string, styleRules: string, contextHash: string},
 *   systemPrompt: string,
 *   template: string,
 *   auditEndpoint: {model: string, contextWindow?: number, maxTokens?: number},
 *   prevTail: string,
 *   force: boolean,
 * }} ctx
 * @returns {Promise<{windows: number, findings: Array<Object>, skipped: string|null, findingsHash: string}>}
 */
async function runVolumeConsistencyPass({
  volume,
  volumeDir,
  bundle,
  refs,
  systemPrompt,
  template,
  auditEndpoint,
  prevTail,
  force,
}) {
  const out = { windows: 0, findings: [], skipped: null, findingsHash: "" };

  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  const published = await resolvePublishedChapterTexts(volumeDir, bundle, state);
  const withText = published.filter((c) => c.text);
  if (withText.length < 2) {
    // One chapter (or none) has no cross-chapter relations to audit.
    out.skipped = withText.length === 0 ? "no chapter text published" : "only one chapter has text";
    return out;
  }

  const volumeHash = sha256(withText.map((c) => `${c.id}\u0000${c.text}`).join("\n"));
  const existing = await loadVolumeConsistency(volumeDir);
  if (
    !force &&
    existing.volumeHash === volumeHash &&
    existing.contextHash === refs.contextHash &&
    existing.model === auditEndpoint.model
  ) {
    out.skipped = "already audited for this volume text and reference state";
    out.windows = (existing.windows || []).length;
    out.findings = existing.findings || [];
    out.findingsHash = existing.findingsHash || "";
    return out;
  }

  const roleWindow = auditEndpoint.contextWindow || 0;
  const outputReserve = auditEndpoint.maxTokens || 0;
  // The references are part of the request too: reserve for them so the windows
  // are sized for the call that will actually be made, not for the text alone.
  const referenceTokens =
    estimateTokens(systemPrompt) +
    estimateTokens(template) +
    estimateTokens(refs.glossaryText) +
    estimateTokens(refs.styleRules) +
    600;
  const windows = planConsistencyWindows(withText, {
    maxTokens: roleWindow,
    reserve: outputReserve + referenceTokens,
  });

  const findings = [];
  const dropped = [];
  const notes = [];
  const windowSummaries = [];
  let previousWindowTail = prevTail || "";

  for (const [wi, win] of windows.entries()) {
    const ids = win.chapters.map((c) => c.id);
    const chapterTable = win.chapters
      .map((c) => `- \`${c.id}\` — ${c.title || c.id} (${c.text.length} chars)`)
      .join("\n");
    const volumeText = win.chapters
      .map((c) => `--- CHAPTER ${c.id}: ${c.title || c.id} ---\n\n${c.text}`)
      .join("\n\n");

    const tail = previousWindowTail
      ? `This pass begins mid-volume. The text the auditor saw BEFORE this pass ended with:\n\n…${previousWindowTail}`
      : "(this is the first volume in the series — there is no previous volume)";

    const fixedTokens = estimateTokens(volumeText) + estimateTokens(chapterTable) + 400;
    const fitted = fitPromptBudget({
      blocks: [
        { name: "canonical glossary", text: refs.glossaryText || "", priority: 5 },
        { name: "house style rules", text: refs.styleRules || "", priority: 4 },
        { name: "previous volume / window tail", text: tail, priority: 3 },
      ],
      fixedTokens,
      roleWindow,
      outputReserve,
    });
    for (const d of fitted.dropped) dropped.push(`${d.name} (${d.chars} chars) in audit window ${wi + 1}`);

    const prompt = transformUserPrompt(template, {
      VOLUME_LABEL: `Volume ${volume.installmentNumber} (${volume.folder})`,
      TARGET_LANGUAGE: "the target language of this translation",
      CHAPTER_COUNT: String(win.chapters.length),
      CHAPTER_TABLE: chapterTable,
      PREVIOUS_TAIL: fitted.blocks.find((b) => b.name === "previous volume / window tail")?.text || "(not provided)",
      GLOSSARY: fitted.blocks.find((b) => b.name === "canonical glossary")?.text || "(none provided — run the glossary task)",
      STYLE_RULES: fitted.blocks.find((b) => b.name === "house style rules")?.text || "(none provided — run the style-guide task)",
      VOLUME_TEXT: volumeText,
    });

    let reply;
    try {
      reply = await harness.runOneShot({
        systemPrompt,
        messages: [{ text: prompt }],
        endpoint: auditEndpoint,
        maxTokens: auditEndpoint.maxTokens,
        contextWindow: auditEndpoint.contextWindow,
        temperature: auditTemperature,
        thinking: auditThinking.thinking,
        thinkingLevel: auditThinking.thinkingLevel,
        label: `volume-consistency-${volume.installmentNumber}-w${wi + 1}`,
      });
    } catch (err) {
      // The pass is an extra pair of eyes, not a gate: a failed audit call is
      // reported and the volume keeps its per-chapter verdicts.
      notes.push(
        `Audit window ${wi + 1} (${ids.join(", ")}) could not be audited: ${err.message}`
      );
      windowSummaries.push({ chapters: ids, tokens: win.tokens, oversized: win.oversized, failed: true });
      continue;
    }

    const parsed = parseVolumeFindings(reply, ids);
    for (const f of parsed) findings.push(f);
    windowSummaries.push({ chapters: ids, tokens: win.tokens, oversized: win.oversized, failed: false });
    previousWindowTail = tailOf(win.chapters.map((c) => c.text).join("\n\n"), CONSISTENCY_TAIL_CHARS);
  }

  const untagged = findings.filter((f) => f.untagged).length;
  if (untagged > 0) {
    notes.push(
      `${untagged} finding(s) named no chapter id the pass provided — recorded, but the retranslate pass cannot act on them.`
    );
  }
  for (const win of windows) {
    if (win.oversized) {
      notes.push(
        `Chapter ${win.chapters.map((c) => c.id).join(", ")} is larger than the auditor's whole context window: it was audited alone, not against its neighbours.`
      );
    }
  }

  const findingsHash = sha256(
    findings.map((f) => `${f.severity}|${(f.chapters || []).join(",")}|${f.statement}`).join("\n")
  );
  const data = {
    schema: 1,
    volume: volume.installmentNumber,
    volumeHash,
    contextHash: refs.contextHash,
    model: auditEndpoint.model,
    generatedAt: new Date().toISOString(),
    windows: windowSummaries,
    findings,
    findingsHash,
    notes,
  };
  await saveVolumeConsistency(volumeDir, data);
  await fs.writeFile(
    path.join(volumeDir, VOLUME_CONSISTENCY_REPORT),
    buildVolumeConsistencyMarkdown(volume, windowSummaries, findings, {
      model: describeEndpoint(auditEndpoint),
      notes,
      dropped,
    }),
    "utf8"
  );

  out.windows = windowSummaries.length;
  out.findings = findings;
  out.findingsHash = findingsHash;
  const high = findings.filter((f) => f.severity === "HIGH").length;
  console.log(
    `  Volume ${volume.installmentNumber}: cross-chapter audit over ${windowSummaries.length} window(s) — ` +
      `${findings.length} finding(s) (${high} HIGH).`
  );
  return out;
}

// ─── Per-volume processing ──────────────────────────────────────────────────

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
async function runAuditTiebreak({ volume, volumeDir, bundle, refs, systemPrompt, template, sidecar, sidecarPath, auditEndpoint }) {
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
 * The verify prompt for one chapter — shared by every grading pass (first
 * sample, repeat samples, audit tiebreak) so they cannot drift apart.
 *
 * @param {{template: string, sourceText: string, draft: string, refs: {terms: Array, styleRules: string, background: string}}} p
 * @returns {string}
 */
/**
 * The verify prompt for one chapter, fitted into the grader's context window.
 *
 * The source text and the draft are never trimmed (a grader that cannot see the
 * whole chapter cannot grade it) — the reference blocks are what give way, and
 * the drop list is returned so the caller can log it.
 *
 * @param {{template: string, sourceText: string, draft: string, refs: {terms: Array, styleRules: string, background: string}, roleWindow: number, outputReserve: number}} p
 * @returns {{prompt: string, dropped: Array<{name: string, chars: number}>}}
 */
function buildVerifyPrompt({ template, sourceText, draft, refs, roleWindow, outputReserve }) {
  const fitted = fitPromptBudget({
    blocks: [
      { name: "glossary", text: glossaryBlock(chapterTerminology(refs, sourceText).terms), priority: 5 },
      { name: "style rules", text: refs.styleRules || "", priority: 3 },
      { name: "story background", text: refs.background || "", priority: 2 },
    ],
    fixedTokens: estimateTokens(sourceText) + estimateTokens(draft) + estimateTokens(template) + 120,
    roleWindow,
    outputReserve,
  });
  const pick = (name, fallback) => {
    const b = fitted.blocks.find((x) => x.name === name);
    return b && b.text.trim() ? b.text : fallback;
  };
  return {
    prompt: transformUserPrompt(template, {
      SOURCE_TEXT: sourceText,
      TRANSLATION_TEXT: draft,
      GLOSSARY: pick("glossary", "(none provided — run the glossary task)"),
      STYLE_RULES: pick("style rules", "(none provided — run the style-guide task)"),
      BACKGROUND: pick("story background", "(none provided — run the jump-in-wiki task)"),
    }),
    dropped: fitted.dropped,
  };
}

/**
 * One grading call for one chapter → { score, findings }.
 *
 * @param {{
 *   volume: {installmentNumber: string},
 *   systemPrompt: string,
 *   template: string,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   sourceText: string,
 *   draft: string,
 *   refs: Object,
 *   label: string,
 *   temperature?: number,
 *   thinking?: {thinking: boolean, thinkingLevel: string},
 * }} p
 * @returns {Promise<{score: number|null, findings: string}>}
 */
async function gradeChapter({ volume, systemPrompt, template, endpoint, sourceText, draft, refs, label, temperature, thinking }) {
  const th = thinking || verifyThinking;
  const roleWindow = endpoint.contextWindow || harness.envContextWindow();
  const outputReserve = endpoint.maxTokens || harness.envMaxTokens();
  const { prompt, dropped } = buildVerifyPrompt({ template, sourceText, draft, refs, roleWindow, outputReserve });
  if (dropped.length > 0) describeDroppedBlocks(dropped, `Volume ${volume.installmentNumber} ${label}`);
  const result = await harness.runOneShot({
    systemPrompt,
    messages: [{ text: prompt }],
    endpoint,
    // The role endpoint's own output cap / context window (harness.js derives
    // them from the global AI_* settings when the role sets neither).
    maxTokens: endpoint.maxTokens,
    contextWindow: endpoint.contextWindow,
    temperature: Number.isFinite(temperature) ? temperature : verifyTemperature,
    thinking: th.thinking,
    thinkingLevel: th.thinkingLevel,
    label,
  });
  return {
    score: parseAcceptanceScore(result),
    findings: findingsOf(result, FINDINGS_MAX_CHARS),
    // A challenge to the GLOSSARY itself (the translation was right, the entry
    // was not). Recorded so it can travel back to the glossary task instead of
    // dying in a report while the retranslate pass keeps obeying the wrong entry.
    disputes: parseGlossaryDisputes(result),
  };
}

/**
 * The repeat-sample batch (the same gate the pre-production artifacts use,
 * applied to the deliverable).
 *
 * A chapter's fate is decided by ONE stochastic score while the reference
 * artifacts require a rolling window of samples plus a temperature-0 anchor.
 * The deliverable deserves the same rigour — but only where the decision is
 * actually close: chapters within ±VERIFY_SAMPLE_BAND of the passing line.
 * Two samples further apart than ACCEPTANCE_SCORE_TOLERANCE are settled by a
 * third at temperature 0, and the MEDIAN is the verdict, so one outlier cannot
 * move a chapter across the line.
 *
 * Batched: every chapter's second sample runs as its own batch on the same
 * verify endpoint (no model switch).
 *
 * @param {{
 *   volume: {installmentNumber: string, folder: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string}>},
 *   refs: Object,
 *   systemPrompt: string,
 *   template: string,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   sidecar: {chapters: Object},
 *   sidecarPath: string,
 * }} ctx
 * @returns {Promise<Array<{id: string, samples: number[], score: number}>>} The chapters whose verdict was resampled.
 */
async function runVerificationSamples({ volume, volumeDir, bundle, refs, systemPrompt, template, endpoint, sidecar, sidecarPath }) {
  const targets = [];
  for (const seg of bundle.segments) {
    const e = sidecar.chapters[seg.id];
    if (!e) continue;
    if (e.deterministic) continue; // no model call to repeat — the reason is deterministic
    if (typeof e.score !== "number") continue; // unparseable: already a FAIL, the retranslate pass retries it
    if (Array.isArray(e.samples) && e.samples.length >= verifySamples) continue;
    if (Math.abs(e.score - passingScore) > sampleBand) continue; // not a close call
    targets.push(seg);
  }
  if (targets.length === 0) return [];

  console.log(
    `[verify-translate] ${targets.length} chapter(s) within ±${sampleBand} of the passing score — ` +
      `taking repeat samples (up to ${verifySamples} per chapter; a disagreement beyond ` +
      `±${sampleTolerance} is settled at temperature 0).`
  );

  const resampled = [];
  await runWithConcurrency(targets, verifyConcurrency, async (seg) => {
    const { draftFile } = chapterArtifactNames(seg.id);
    let sourceText;
    let draft;
    try {
      sourceText = await fs.readFile(path.join(volumeDir, seg.file), "utf8");
      draft = await fs.readFile(path.join(volumeDir, draftFile), "utf8");
    } catch {
      return; // source/draft vanished since the first pass
    }
    const e = sidecar.chapters[seg.id];
    if (e.sourceHash !== sha256(sourceText) || e.draftHash !== sha256(draft)) return; // stale entry

    const samples = Array.isArray(e.samples) && e.samples.length > 0 ? [...e.samples] : [e.score];
    let settled = false;
    while (samples.length < verifySamples && !settled) {
      const spread = Math.max(...samples) - Math.min(...samples);
      if (samples.length >= 2 && spread <= sampleTolerance) {
        settled = true;
        break;
      }
      // The tie-breaking sample is the calm one: temperature 0, no thinking.
      const tieBreak = samples.length >= 2;
      const graded = await gradeChapter({
        volume,
        systemPrompt,
        template,
        endpoint,
        sourceText,
        draft,
        refs,
        label: `verify-sample${samples.length + 1}-v${volume.installmentNumber}-${seg.id}`,
        temperature: tieBreak ? 0 : verifyTemperature,
        thinking: tieBreak ? { thinking: false, thinkingLevel: null } : undefined,
      });
      if (graded.score === null) break; // an unparseable repeat does not improve the evidence
      samples.push(graded.score);
    }

    const score = medianScore(samples);
    const pass = score !== null && score >= passingScore;
    sidecar.chapters[seg.id] = {
      ...e,
      score,
      pass,
      samples,
      verifiedAt: new Date().toISOString(),
    };
    await saveVerificationSidecar(sidecarPath, sidecar);
    resampled.push({ id: seg.id, samples, score });
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: samples [${samples.join(", ")}] → median ` +
        `${score}/100 → ${pass ? "PASS" : "FAIL"}.`
    );
  });
  return resampled;
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

/**
 * The text a reader of this volume actually gets: the merged `translation.md`
 * when it exists (that is what the pipeline publishes), otherwise the drafts
 * concatenated in reading order.
 *
 * @param {string} volumeDir
 * @param {{segments: Array<{id: string, file: string}>}} bundle
 * @returns {Promise<string>}
 */
async function readPublishedVolumeText(volumeDir, bundle) {
  const merged = await readFileOrEmpty(path.join(volumeDir, MERGED_FILE));
  if (merged.trim()) return merged;
  const parts = [];
  for (const seg of bundle.segments) {
    const { draftFile, polishedFile } = chapterArtifactNames(seg.id);
    const polished = await readFileOrEmpty(path.join(volumeDir, polishedFile));
    const draft = await readFileOrEmpty(path.join(volumeDir, draftFile));
    const text = polished.trim() ? polished : draft;
    if (text.trim()) parts.push(text.trim());
  }
  return parts.join("\n\n");
}

/**
 * Persist the variant scan in the verification sidecar (volume-level, separate
 * from the per-chapter verdicts) so a later run can see it without re-scanning,
 * and the translation report can count it.
 *
 * @param {string} volumeDir
 * @param {Array<Object>} findings
 * @returns {Promise<void>}
 */
async function saveVolumeFindings(volumeDir, findings) {
  const sidecarPath = path.join(volumeDir, VERIFICATION_FILE);
  const sidecar = await loadVerificationSidecar(sidecarPath);
  sidecar.volume = {
    ...(sidecar.volume || {}),
    scannedAt: new Date().toISOString(),
    renderingVariants: findings,
  };
  await saveVerificationSidecar(sidecarPath, sidecar);
}

/**
 * Build the per-volume verification report (translation-verification.md):
 * the score table plus each failing chapter's findings (the input the
 * retranslate task consumes).
 *
 * @param {{installmentNumber: string, folder: string}} volume
 * @param {Array<{id: string, title: string, status: string, score: number|null, pass: boolean|null, findings?: string}>} rows
 * @returns {string} The Markdown report.
 */
function buildVerificationReportMarkdown(volume, rows, variantFindings = []) {
  const lines = [];
  lines.push(`# Translation Verification — Volume ${volume.installmentNumber} (${volume.folder})`);
  lines.push("");
  lines.push(
    `_Source-anchored verification by the verify model (score 0–100, banded rubric; PASS at or above ` +
      `${passingScore}). An unparseable score is a FAIL (fail-closed). Failing chapters are ` +
      `retranslated by the "retranslate" task using the findings below, then re-verified._`
  );
  lines.push("");
  lines.push("| Chapter | Title | Status | Score | Verdict |");
  lines.push("|---|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${row.title || "—"} | ${row.status} | ` +
        `${row.score === null ? "n/a" : row.score + "/100"} | ${row.pass === null ? "—" : row.pass ? "PASS" : "FAIL"} |`
    );
  }
  lines.push("");
  for (const row of rows.filter((r) => r.pass === false && r.findings)) {
    lines.push(`## Findings — ${row.id} (${row.title || "untitled"})`);
    lines.push("");
    lines.push(row.findings);
    lines.push("");
  }
  // The deterministic half of the audit: the cross-chapter rendering-variant
  // scan over the published volume (no model call produced it).
  const variantSection = renderVariantFindings(variantFindings);
  if (variantSection) {
    lines.push(variantSection);
    lines.push(
      "_Fix: correct the rendering in the offending chapters (the retranslate task is given the " +
        "glossary as terminology law), or fix the glossary itself if the second form is the better " +
        "one and re-run the pipeline._"
    );
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Task entry ─────────────────────────────────────────────────────────────

/**
 * Run the verify-translate task (all volumes, or --volume NN).
 *
 * Returns the aggregated run summary — the translate-qa loop reads
 * `failed` to decide whether the validator is happy. (A volume that fails
 * the run under ON_VOLUME_ERROR=skip still throws, as before.)
 *
 * @returns {Promise<{verified: number, passed: number, failed: number, skipped: number, noDraft: number}>}
 */
async function verifyTranslate() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  if (!verifyEnabled) {
    console.log(
      "[verify-translate] VERIFY_TRANSLATE_ENABLED=false — verification (and the retranslate pass) are disabled. Nothing to do."
    );
    return;
  }
  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  validateRequiredEnv({ dryRun });

  const endpoint = roleEndpoint("VERIFY");
  const auditEndpoint = tiebreakEnabled ? roleEndpoint("AUDIT") : null;
  if (!dryRun) {
    await harness.assertModelServing({ ...endpoint, label: "verify-translate stage" });
  }

  const systemPrompt = await fs.readFile(verifySystemPromptFile, "utf-8");
  const template = await fs.readFile(verifyTemplateFile, "utf-8");
  // The cross-chapter audit's own prompt pair (it judges relations between
  // chapters, not one chapter against its source — a different job, a rubric of
  // its own, and deliberately no score).
  const consistencySystemPrompt = await fs.readFile(consistencySystemPromptFile, "utf-8");
  const consistencyTemplate = await fs.readFile(consistencyTemplateFile, "utf-8");

  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
  // Series name / source language / target language: .env override > manifest >
  // default (the same resolution every other task uses — the reports and the
  // prompts must agree about what language the book is in).
  const runSettings = resolveRunSettings(manifest);
  const sorted = manifest.volumes.map((v) => v.folder);
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));
  if (sorted.length === 0) {
    throw new Error(`No volume folders found in ${seriesDir}.`);
  }

  const volumeArg =
    (process.argv.find((a) => a.startsWith("--volume=")) || "").replace("--volume=", "") ||
    (process.argv.includes("--volume")
      ? process.argv[process.argv.indexOf("--volume") + 1]
      : null);
  let volumes = sorted;
  if (volumeArg) {
    // Resolved through the manifest's installment numbers, not by parsing folder
    // names — the intake agent chooses the folder names.
    volumes = filterVolumesByInstallment(manifest, volumeArg);
    if (volumes.length === 0) {
      throw new Error(
        `No volume matching --volume ${volumeArg} (manifest volumes: ` +
          `${manifest.volumes.map((v) => `${v.installmentNumber} = ${v.folder}`).join(", ")}).`
      );
    }
    console.log(`--volume: processing only ${volumes.join(", ")}`);
  }

  console.log(
    `[verify-translate] ${sorted.length} volume folder(s); endpoint ${describeEndpoint(endpoint)}; ` +
      `passing score ${passingScore}; thinking=${verifyThinking.thinking ? verifyThinking.thinkingLevel : "off"}; ` +
      `concurrency=${verifyConcurrency}; ` +
      `tiebreak=${tiebreakEnabled ? `ON (audit endpoint ±${tiebreakBand}, averaged with the verify score)` : "off"}.`
  );
  await logRunEstimate({
    stage: "verify-translate",
    volumes: volumes.length,
    chapters: (await countStageChapters({ seriesDir, volumes: volumes.map((f) => volumeByFolder.get(f)).filter(Boolean) })).chapters,
    // Every chapter gets at least one grading call; a borderline one gets up to
    // VERIFY_SAMPLES, and the borderline ones also get the cross-model audit.
    callsPerChapter: verifySamples + (tiebreakEnabled ? 1 : 0),
    endpoint,
    extra: `samples per borderline chapter: ${verifySamples}`,
  });

  const failedVolumes = [];
  /**
   * The per-volume context the later phases need. Resolving the bundle once and
   * reusing it is what makes the phase split cheap (the epub extraction is
   * already cached on disk).
   */
  const prepared = [];
  let totalVerified = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalNoDraft = 0;

  // ── PHASE 1 — first sample, every volume, one endpoint ────────────────────
  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
      // The handoff's chapter list and the extracted one must describe the same
      // book (see checkChapterListConsistency). A disagreement is reported, not
      // fatal: the extracted list is the one this stage uses.
      await checkChapterListConsistency(volumeDir, bundle);
      // The volume's own text decides WHICH sections of the cumulative
      // references get injected (see loadVolumeReferences): a 17-volume series
      // must show the translator the state and cast that matter to THIS book.
      const volumeSourceText = await readFileOrEmpty(bundle.wholePath || path.join(volumeDir, bundle.segments[0].file));
      const refs = await loadVolumeReferences(volumeDir, volumeSourceText);
      const result = await processVerifyVolume({
        volume,
        volumeDir,
        bundle,
        refs,
        systemPrompt,
        template,
        endpoint,
        auditEndpoint,
        dryRun,
        force,
      });
      prepared.push({ volume, volumeDir, bundle, refs });
      totalVerified += result.verified;
      totalPassed += result.passed;
      totalFailed += result.failed;
      totalSkipped += result.skipped;
      totalNoDraft += result.noDraft;
      console.log(
        `[verify-translate] Volume ${volume.installmentNumber}: ${result.verified} verified, ` +
          `${result.passed} PASS, ${result.failed} FAIL, ${result.skipped} skipped, ${result.noDraft} without draft.`
      );
    } catch (err) {
      // A STRUCTURAL failure (a source file that vanished, an archive that will not
      // open, a volume whose chapters are incomplete) is never skippable: ON_VOLUME_ERROR
      //=skip exists for flaky model calls, not for a broken book.
      if (ON_VOLUME_ERROR === "skip" && !isStructuralError(err)) {
        console.error(
          `[skip] Volume ${volume.installmentNumber} (${folderName}) failed: ${err.message}`
        );
        failedVolumes.push(volume.installmentNumber);
        continue;
      }
      throw err;
    }
  }

  if (!dryRun) {
    // ── PHASE 2 — repeat samples for the borderline chapters (same endpoint,
    // so no container switch) ────────────────────────────────────────────────
    for (const p of prepared) {
      const sidecarPath = path.join(p.volumeDir, VERIFICATION_FILE);
      const sidecar = await loadVerificationSidecar(sidecarPath);
      await runVerificationSamples({
        volume: p.volume,
        volumeDir: p.volumeDir,
        bundle: p.bundle,
        refs: p.refs,
        systemPrompt,
        template,
        endpoint,
        sidecar,
        sidecarPath,
      });
    }

    // ── PHASE 3 — ONE cross-model audit batch over EVERY volume ─────────────
    // The hook (the container switch on a shared-port setup) fires ONCE for the
    // whole run. It used to fire per volume, which is the exact interleaving the
    // batching exists to avoid: a 17-volume run paid 17 model switches for a
    // pass that is supposed to need one.
    const auditBatchNeeded = (tiebreakEnabled || volumeConsistencyEnabled) && prepared.length > 0;
    if (auditBatchNeeded && !auditEndpoint) {
      console.error(
        "[verify-translate] the cross-checks (tiebreak / cross-chapter audit) need the AUDIT_* role, " +
          "which falls back to AI_* here — no separate audit endpoint is configured."
      );
    }
    if (auditBatchNeeded && auditEndpoint) {
      const runBatch = withHooks("verify-audit", async () => {
        for (const p of prepared) {
          if (!tiebreakEnabled) continue;
          const sidecarPath = path.join(p.volumeDir, VERIFICATION_FILE);
          const sidecar = await loadVerificationSidecar(sidecarPath);
          await runAuditTiebreak({
            volume: p.volume,
            volumeDir: p.volumeDir,
            bundle: p.bundle,
            refs: p.refs,
            systemPrompt,
            template,
            sidecar,
            sidecarPath,
            auditEndpoint,
          });
        }
        // ── PHASE 3b — the cross-chapter audit, in the SAME audit batch ──────
        // Same role, same container, same switch: the two checks that need a
        // second model run together instead of paying for two container swaps.
        if (volumeConsistencyEnabled) {
          for (const p of prepared) {
            try {
              const prev = await previousVolumeTail(seriesDir, manifest, p.volume.folder, CONSISTENCY_TAIL_CHARS);
              const res = await runVolumeConsistencyPass({
                volume: p.volume,
                volumeDir: p.volumeDir,
                bundle: p.bundle,
                refs: p.refs,
                systemPrompt: consistencySystemPrompt,
                template: consistencyTemplate,
                auditEndpoint,
                prevTail: prev.text,
                force,
              });
              if (res.skipped) {
                console.log(
                  `  Volume ${p.volume.installmentNumber}: cross-chapter audit skipped (${res.skipped}).`
                );
              }
            } catch (err) {
              // An extra pair of eyes must not break the verification run: the
              // volume keeps its per-chapter verdicts and the failure is logged.
              console.error(
                `[verify-translate] Volume ${p.volume.installmentNumber}: cross-chapter audit failed: ${err.message}`
              );
            }
          }
        }
      });
      await runBatch();
    }
  }

  // ── PHASE 4 — commit the verdicts (best-draft records + the reports) ──────
  // Counts are read back from the sidecar rather than accumulated across the
  // phases, so the numbers always describe the files that are actually on disk.
  let disputeCount = 0;
  if (!dryRun) {
    totalPassed = 0;
    totalFailed = 0;
    totalVerified = 0;
    totalNoDraft = 0;
    totalSkipped = 0;
    for (const p of prepared) {
      const committed = await commitVerificationVolume({
        volume: p.volume,
        volumeDir: p.volumeDir,
        bundle: p.bundle,
        refs: p.refs,
        targetLanguage: runSettings.targetLanguage,
      });
      totalVerified += committed.verified;
      totalPassed += committed.passed;
      totalFailed += committed.failed;
      totalNoDraft += committed.noDraft;
    }
    // ── PHASE 4b — the glossary disputes queue (findings that flow BACKWARDS) ──
    // A verifier that reads the source sometimes finds that the GLOSSARY is the
    // wrong thing. That observation used to die in a per-volume report while the
    // retranslate pass went on obeying the bad entry and the next round complained
    // again. Collected at the series root, the glossary task can actually settle it.
    try {
      const incoming = [];
      for (const p of prepared) {
        const sidecar = await loadVerificationSidecar(path.join(p.volumeDir, VERIFICATION_FILE));
        for (const d of collectVolumeDisputes(sidecar, p.volume.installmentNumber)) incoming.push(d);
      }
      const existing = await loadGlossaryDisputes(seriesDir);
      const merged = mergeDisputes(existing, incoming);
      const saved = await saveGlossaryDisputes(seriesDir, merged, { seriesName: runSettings.seriesName });
      disputeCount = saved.count;
      const fresh = incoming.length;
      if (fresh > 0) {
        console.log(
          `[verify-translate] ${fresh} glossary dispute(s) recorded this run — ` +
            `${disputeCount} open in ${DISPUTES_FILE} / ${DISPUTES_REPORT} (run the glossary task to settle them).`
        );
      }
    } catch (err) {
      // The queue is a channel, not a gate: a failure to write it must not lose
      // the verification verdicts that were just committed.
      console.error(`[verify-translate] could not write the glossary disputes queue: ${err.message}`);
    }
  }

  console.log(
    `[verify-translate] Done: ${totalVerified} chapter(s) verified — ${totalPassed} PASS, ${totalFailed} FAIL ` +
      `(FAILs are retranslated by the "retranslate" task)` +
      (disputeCount > 0 ? ` — ${disputeCount} glossary dispute(s) open.` : ".")
  );
  const volumeError = volumeFailureError("verify-translate", failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
  return {
    verified: totalVerified,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    noDraft: totalNoDraft,
    disputes: disputeCount,
  };
}

module.exports = {
  verifyTranslate,
  processVerifyVolume,
  runVerificationSamples,
  runAuditTiebreak,
  runVolumeConsistencyPass,
  commitVerificationVolume,
  // Exported for the calibration fixture (test/calibrate.js): it must grade with
  // the SAME prompt and rubric production uses, or the measurement measures
  // something else.
  gradeChapter,
  buildVerifyPrompt,
  loadVerificationSidecar,
  buildVerificationReportMarkdown,
  glossaryBlock,
  findingsOf,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
  passingScore,
  verifySamples,
  sampleBand,
};
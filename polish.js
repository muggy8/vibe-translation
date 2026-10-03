/**
 * polish.js — Logic for the "polish" gulp task: the final pass of the
 * translation pipeline.
 *
 * Task: polish
 *   For each volume, for each chapter that has a translation-<id>.md draft:
 *     1. Skip it when the state shows the polished-<id>.md file was produced
 *        from the CURRENT draft AND passed the drift check
 *        (draftHash === polishedDraftHash === polishVerifiedDraftHash) —
 *        idempotency; --force re-polishes. A polished file from a
 *        pre-inspector run (no polishVerifiedDraftHash) is drift-checked
 *        instead of re-polished (one inspector call, no fresh pass).
 *     2. One-shot call to the edit endpoint (EDIT_* env):
 *        current draft + glossary + style rules + character voice notes →
 *        the complete polished chapter (system-prompts/polish.md,
 *        user-prompts/polish.md). The polisher sees NO source text — its
 *        role is surface cleanup of already-verified text (no re-translation
 *        by a non-translation model). Thinking is ON (default: medium).
 *     3. Deterministic regression guard: if the polished text FAILS the QA
 *        the draft passed, or LOSES glossary coverage the draft had, the
 *        attempt is rejected and the guard's findings become correction
 *        tasks for the next attempt.
 *     4. AI drift check (source-aware, default-ON): a one-shot auditor on
 *        the SAME endpoint (system-prompts/polish-verify.md,
 *        user-prompts/polish-verify.md) scores whether the polished text
 *        preserves the verified draft's meaning, using the source as ground
 *        truth → 0–100 (fail-closed: unparseable = FAIL).
 *        PASS >= PASSING_SCORE (default 70).
 *     5. Steps 2–4 loop up to POLISH_QA_MAX_ROUNDS (default 3) attempts per
 *        chapter: a FAIL re-polishes with the findings injected as a
 *        numbered "fix these" task (the retranslate pattern). On
 *        exhaustion the polished text is rejected, the draft is kept, and
 *        the last findings persist in the state — the next run re-polishes
 *        with them (or --force for a fresh attempt).
 *     6. On PASS: write polished-<id>.md, record polishedDraftHash +
 *        polishVerifiedDraftHash in the state, write the
 *        polish-verification.json sidecar, and re-merge the volume's
 *        translation.md (polished text wins).
 *
 * Usage:
 *   npx gulp polish              # run the full task
 *   npx gulp polish --dry-run    # dump the prompts only, no AI calls
 *   npx gulp polish --force      # re-polish even if up to date
 *   npx gulp polish --volume 01  # single volume
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types"); // JSDoc type definitions
const harness = require("./harness");
const { getTranslationTarget } = require("./get-translation-target");
const { filterVolumesByInstallment } = require("./utils/manifest");
const { ON_VOLUME_ERROR, PASSING_SCORE, validateRequiredEnv, resolveRunSettings, isStructuralError, structuralError, volumeFailureError } = require("./configs/shared");
const { fileExists } = require("./utils/fs");
const tokens = require("./utils/tokens");
const { resolveSourceBundle } = require("./utils/source");
const { transformUserPrompt, parseAcceptanceScore, writePromptDump } = require("./utils/prompt");
const { writeTranslationReport } = require("./utils/translation-report");
const {
  sha256,
  checkTranslationQa,
  buildPolishGuardFindings,
  stripMarkdownFence,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  runWithConcurrency,
  stageConcurrency,
  judgeTemperature,
  stageThinking,
  writerTemperature,
  estimateTokens,
  fitPromptBudget,
  describeDroppedBlocks,
  logRunEstimate,
  countStageChapters,
  checkChapterListConsistency,
  calibrateStageTokens,
  glossaryBlock,
  loadVerificationSidecar,
  readFileOrEmpty,
  saveVerificationSidecar,
  findingsOf,
  chapterArtifactNames,
  MERGED_FILE,
  STATE_FILE,
  POLISH_QA_REPORT,
  POLISH_VERIFICATION_FILE,
} = require("./utils/translate");
const { mergeVolumeTranslationFiles } = require("./translate");
const { withHooks } = require("./utils/hooks");

// ─── Paths & config ──────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const polishSystemPromptFile = path.join(clientDir, "system-prompts", "polish.md");
const polishTemplateFile = path.join(clientDir, "user-prompts", "polish.md");
const polishVerifySystemPromptFile = path.join(clientDir, "system-prompts", "polish-verify.md");
const polishVerifyTemplateFile = path.join(clientDir, "user-prompts", "polish-verify.md");

// (POLISH_QA_REPORT / POLISH_VERIFICATION_FILE come from utils/translate.js —
// the shared translation-stage layer, so no task module imports another.)

const polishThinking = stageThinking("EDIT");
const polishTemperature = writerTemperature("EDIT", 0.6);

/** The source-aware drift inspector — default-ON (the semantic backstop for
 *  the source-free polish pass). POLISH_VERIFY_ENABLED=false gates the pass
 *  on the deterministic regression guard only. */
const polishVerifyEnabled = process.env.POLISH_VERIFY_ENABLED !== "false";
/** Score (0–100) at or above which a polished text passes the drift check —
 *  the shared PASSING_SCORE. */
const polishVerifyPassingScore = PASSING_SCORE;
/** Max [polish + drift check] attempts per chapter (a FAIL re-polishes with
 *  the findings injected as correction tasks). */
const polishMaxRounds = (() => {
  const parsed = parseInt(process.env.POLISH_QA_MAX_ROUNDS, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 3;
})();
/** Findings injected into the re-polish prompt — keep them bounded (a
 *  numbered correction task, not a document to re-read). */
const POLISH_FINDINGS_MAX_CHARS = 3000;
/** Chapter concurrency within a volume (opt-in; default 1 = serial — the
 *  local hardware runs one inference at a time). */
const polishConcurrency = stageConcurrency("POLISH");

/** (#3/#4) The audit role — a SECOND endpoint (AUDIT_* env) that runs the
 *  final cross-check. The task logic is identical whatever model serves it;
 *  the pre-polish-audit hook decides which container answers on shared-port
 *  local setups. Configure it to a DIFFERENT model than the polisher's, or the
 *  cross-check grades the work with the same model twice. The final semantic
 *  check (drift + source) runs as a BATCHED pass, never interleaved per
 *  chapter. */
const auditThinking = stageThinking("AUDIT");
const auditTemperature = judgeTemperature();
/** (#3/#4) Audit batch concurrency (opt-in; default 1). */
const auditConcurrency = stageConcurrency("AUDIT");

/**
 * Fit a polish/audit prompt's reference blocks into the role's context window.
 *
 * The text being judged or polished (source / draft / polished) is never
 * trimmed — a grader that cannot see the whole chapter, or a polisher given a
 * sliced chapter, produces a meaningless verdict. The reference blocks give way,
 * in the order least-useful-first, and every drop is logged.
 *
 * @param {{blocks: Array<{name: string, text: string, priority: number}>, fixedTokens: number, endpoint: {contextWindow: number|null, maxTokens: number|null}, label: string}} p
 * @returns {{pick: (name: string, fallback: string) => string, dropped: Array<{name: string, chars: number}>}}
 */
function fitReferenceBlocks({ blocks, fixedTokens, endpoint, label }) {
  const roleWindow = endpoint.contextWindow || harness.envContextWindow();
  const outputReserve = endpoint.maxTokens || harness.envMaxTokens();
  const fitted = fitPromptBudget({ blocks, fixedTokens, roleWindow, outputReserve });
  if (fitted.dropped.length > 0) describeDroppedBlocks(fitted.dropped, label);
  const pick = (name, fallback) => {
    const b = fitted.blocks.find((x) => x.name === name);
    return b && b.text.trim() ? b.text : fallback;
  };
  return { pick, dropped: fitted.dropped };
}

/** The reference blocks a polish pass injects (never the source text). */
function polishReferenceBlocks({ refs, sourceText }) {
  return [
    { name: "GLOSSARY", text: glossaryBlock(chapterTerminology(refs, sourceText).terms), priority: 5 },
    { name: "STYLE_RULES", text: refs.styleRules || "", priority: 3 },
    { name: "VOICE_NOTES", text: refs.voiceNotes || "", priority: 1 },
  ];
}

// ─── Per-volume processing ──────────────────────────────────────────────────

/**
 * (#3/#4) The batched final audit — a cross-check pass over a set of polished
 * candidates. Each candidate is scored by the audit endpoint (a SECOND
 * endpoint, distinct from the polisher's) on the source-aware drift rubric:
 * does the polished text preserve the verified draft's meaning (and stay
 * faithful to the source)? Returns one result per chapter. The caller wraps
 * this in the polish-audit hook (on local setups: the switch to the audit
 * container), so the whole batch runs under one endpoint, never interleaved
 * with the polisher.
 *
 * @param {{
 *   volume: {installmentNumber: string}, volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string}>},
 *   refs: {terms: Array<{term: string, rendering: string}>, styleRules: string},
 *   systemPrompt: string, template: string,
 *   auditEndpoint: {baseUrl: string, apiKey?: string, model: string},
 *   toAudit: Array<{id: string}>,
 * }} ctx
 * @returns {Promise<Array<{id: string, score: number|null, pass: boolean, findings: string}>>}
 */
async function runAuditBatch({ volume, volumeDir, bundle, refs, systemPrompt, template, auditEndpoint, toAudit, dryRun = false }) {
  await harness.assertModelServing({ ...auditEndpoint, label: "polish-audit stage" });
  // The auditor is a different model from the polisher whose work it is grading,
  // and its prompt budget is computed with these estimates — re-point them for
  // the whole batch (cached per endpoint, so this is one probe, not one per chapter).
  await calibrateStageTokens({ endpoint: auditEndpoint, bundle, label: "polish-audit batch", dryRun });
  console.log(
    `[polish-audit] cross-model final audit of ${toAudit.length} chapter(s) with ${auditEndpoint.model} ` +
      `(PASS ≥ ${polishVerifyPassingScore}/100)…`
  );
  const results = [];
  await runWithConcurrency(toAudit, auditConcurrency, async ({ id }) => {
    const seg = bundle.segments.find((s) => s.id === id);
    const { draftFile, polishedFile } = chapterArtifactNames(id);
    const sourceText = await fs.readFile(path.join(volumeDir, seg.file), "utf8");
    const draft = await fs.readFile(path.join(volumeDir, draftFile), "utf8");
    const polished = await fs.readFile(path.join(volumeDir, polishedFile), "utf8");
    const { pick } = fitReferenceBlocks({
      blocks: [{ name: "GLOSSARY", text: glossaryBlock(chapterTerminology(refs, sourceText).terms), priority: 5 }],
      fixedTokens:
        estimateTokens(sourceText) + estimateTokens(draft) + estimateTokens(polished) + estimateTokens(template) + 120,
      endpoint: auditEndpoint,
      label: `Volume ${volume.installmentNumber} ${id} (drift audit)`,
    });
    const prompt = transformUserPrompt(template, {
      SOURCE_TEXT: sourceText,
      DRAFT_TEXT: draft,
      POLISHED_TEXT: polished,
      GLOSSARY: pick("GLOSSARY", "(none provided — run the glossary task)"),
    });
    const vResult = await harness.runOneShot({
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
      label: `polish-audit-v${volume.installmentNumber}-${id}`,
    });
    const score = parseAcceptanceScore(vResult);
    const pass = score !== null && score >= polishVerifyPassingScore;
    results.push({ id, score, pass, findings: findingsOf(vResult) });
    console.log(
      `  Volume ${volume.installmentNumber} ${id}: audit ` +
        `${score === null ? "n/a (unparseable — FAIL)" : score + "/100"} → ${pass ? "PASS" : "FAIL"}.`
    );
  });
  return results;
}

/**
 * (#3/#4) The batched re-polish — the correction pass over the candidates the
 * audit failed. Each is re-polished on the edit endpoint (NO source text —
 * surface cleanup) with the audit's findings injected as a numbered "fix
 * these" task (the retranslate pattern). The new candidate is written and
 * marked pending the next audit round. The caller wraps this in the polish
 * hook (on local setups: the switch back to the edit container).
 *
 * @param {{
 *   volume: {installmentNumber: string}, volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string}>},
 *   refs: {terms: Array<{term: string, rendering: string}>, styleRules: string, voiceNotes: string, contextHash: string},
 *   systemPrompt: string, template: string,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   state: {chapters: Object},
 *   failed: Array<{id: string, findings: string, draftHash: string}>,
 * }} ctx
 * @returns {Promise<void>}
 */
async function runRePolish({ volume, volumeDir, bundle, refs, systemPrompt, template, endpoint, state, failed }) {
  // The audit that just graded these candidates ran on a DIFFERENT model, and the
  // active token calibration is process-global — re-point it at the polisher's
  // tokenizer before budgeting this phase's prompts.
  tokens.useCalibrationFor(endpoint);
  console.log(
    `[polish] re-polishing ${failed.length} chapter(s) with ${endpoint.model} (audit findings injected)…`
  );
  await runWithConcurrency(failed, polishConcurrency, async ({ id, findings, draftHash }) => {
    const { draftFile, polishedFile } = chapterArtifactNames(id);
    const draft = await fs.readFile(path.join(volumeDir, draftFile), "utf8");
    // Chapter-scoped terminology: the polisher sees no source text, so the
    // selection is anchored on the chapter's own source file.
    const seg = bundle.segments.find((s) => s.id === id);
    let chapterSource = "";
    try {
      chapterSource = await fs.readFile(path.join(volumeDir, seg.file), "utf8");
    } catch {
      chapterSource = "";
    }
    const findingsText = findings ? findings.slice(0, POLISH_FINDINGS_MAX_CHARS) : "(none)";
    const { pick } = fitReferenceBlocks({
      blocks: polishReferenceBlocks({ refs, sourceText: chapterSource }),
      fixedTokens: estimateTokens(draft) + estimateTokens(findingsText) + estimateTokens(template) + 120,
      endpoint,
      label: `Volume ${volume.installmentNumber} ${id} (re-polish)`,
    });
    const values = {
      TRANSLATION_TEXT: draft,
      GLOSSARY: pick("GLOSSARY", "(none provided — run the glossary task)"),
      STYLE_RULES: pick("STYLE_RULES", "(none provided — run the style-guide task)"),
      VOICE_NOTES: pick("VOICE_NOTES", "(none provided — run the character-voice task)"),
      POLISH_FINDINGS: findingsText,
    };
    const prompt = transformUserPrompt(template, values);
    const result = await harness.runOneShot({
      systemPrompt,
      messages: [{ text: prompt }],
      endpoint,
      // The role endpoint's own output cap / context window (harness.js derives
      // them from the global AI_* settings when the role sets neither).
      maxTokens: endpoint.maxTokens,
      contextWindow: endpoint.contextWindow,
      temperature: Number.isFinite(polishTemperature) ? polishTemperature : 0.6,
      thinking: polishThinking.thinking,
      thinkingLevel: polishThinking.thinkingLevel,
      label: `polish-v${volume.installmentNumber}-${id}-audit-retry`,
    });
    const attemptText = stripMarkdownFence(result);
    if (!attemptText) {
      throw new Error(
        `Volume ${volume.installmentNumber} ${id}: the model returned no content for the audit re-polish. ` +
          `Check .logs/ and re-run.`
      );
    }
    await fs.writeFile(path.join(volumeDir, polishedFile), attemptText + "\n", "utf8");
    const e = state.chapters[id] || {};
    state.chapters[id] = {
      ...e,
      polishedDraftHash: draftHash,
      polishVerifiedDraftHash: null, // pending the next audit round
      // Persist the audit findings that triggered this re-polish: if the run
      // ends with the chapter still failing, they seed the next run's re-polish.
      polishFindings: findings,
      polishFindingsHash: findings ? sha256(findings) : null,
    };
  });
}

/**
 * Polish one volume's chapter drafts.
 *
 * @param {{
 *   volume: {folder: string, sourceFile: string, installmentNumber: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string, chars: number}>},
 *   refs: {terms: Array<{term: string, rendering: string}>, styleRules: string, voiceNotes: string, contextHash: string},
 *   systemPrompt: string,
 *   template: string,
 *   verifySystemPrompt: string|null,
 *   verifyTemplate: string|null,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   auditEndpoint: {baseUrl: string, apiKey?: string, model: string}|null,
 *   dryRun: boolean,
 *   force: boolean,
 * }} ctx
 * @returns {Promise<{polished: number, skipped: number, rejected: number, noDraft: number}>}
 */
async function polishVolumePhaseA(ctx) {
  const {
    volume,
    volumeDir,
    bundle,
    refs,
    systemPrompt,
    template,
    verifySystemPrompt,
    verifyTemplate,
    endpoint,
    auditEndpoint,
    dryRun,
    force,
    sourceLanguage,
    targetLanguage,
  } = ctx;
  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  const sidecar = await loadVerificationSidecar(path.join(volumeDir, POLISH_VERIFICATION_FILE));
  const rows = [];
  let polished = 0;
  let skipped = 0;
  let rejected = 0;
  let noDraft = 0;
  // (#3/#4) Candidates Phase A produced (guard-gated) — queued for the batched
  // cross-model final audit (Phase B) after all chapters are processed.
  let auditPending = [];

  // Chapters are INDEPENDENT (each is polished from its own draft +
  // references), so they can run in parallel when STAGE_CONCURRENCY > 1.
  // Rows are stored by index to keep the report in reading order.
  await runWithConcurrency(bundle.segments, polishConcurrency, async (seg, idx) => {
    const { draftFile, polishedFile } = chapterArtifactNames(seg.id);
    const chapterPath = path.join(volumeDir, seg.file);
    const draftPath = path.join(volumeDir, draftFile);
    const polishedPath = path.join(volumeDir, polishedFile);
    if (!(await fileExists(draftPath))) {
      console.warn(`  Volume ${volume.installmentNumber} ${seg.id}: no draft — run translate first.`);
      noDraft += 1;
      rows[idx] = { id: seg.id, title: seg.title, status: "no draft", ok: true, score: null, warnings: [] };
      return;
    }
    const sourceText = await fs.readFile(chapterPath, "utf8");
    const draft = await fs.readFile(draftPath, "utf8");
    const sourceHash = sha256(sourceText);
    const draftHash = sha256(draft);
    const sEntry = state.chapters[seg.id] || {};

    const upToDate =
      !force &&
      sEntry.draftHash === draftHash &&
      sEntry.polishedDraftHash === draftHash &&
      sEntry.polishVerifiedDraftHash === draftHash &&
      (await fileExists(polishedPath));
    if (upToDate) {
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: polish up to date — skipping.`);
      skipped += 1;
      rows[idx] = { id: seg.id, title: seg.title, status: "skipped (up to date)", ok: true, score: null, warnings: [] };
      return;
    }

    // A polished file produced from the CURRENT draft but never drift-verified
    // (a pre-inspector run): inspect the existing text instead of re-polishing
    // (one inspector call, no fresh stochastic pass).
    const hasExistingPolish =
      !force && sEntry.polishedDraftHash === draftHash && (await fileExists(polishedPath));

    // Findings persisted by a previously rejected run seed the first attempt.
    let findings =
      !hasExistingPolish && typeof sEntry.polishFindings === "string" && sEntry.polishFindings
        ? sEntry.polishFindings
        : "";

    if (dryRun) {
      // Dump the prompts for every chapter a live run would polish (no-draft
      // and up-to-date chapters were skipped above) — one file per chapter,
      // no AI calls in dry-run. The drift-check prompt's polished-text input
      // is the output of the polish call (unavailable in dry-run).
      const findingsText = findings ? findings.slice(0, POLISH_FINDINGS_MAX_CHARS) : "(none — first pass)";
      const { pick } = fitReferenceBlocks({
        blocks: polishReferenceBlocks({ refs, sourceText }),
        fixedTokens: estimateTokens(draft) + estimateTokens(findingsText) + estimateTokens(template) + 120,
        endpoint,
        label: `Volume ${volume.installmentNumber} ${seg.id}`,
      });
      const values = {
        TRANSLATION_TEXT: draft,
        GLOSSARY: pick("GLOSSARY", "(none provided — run the glossary task)"),
        STYLE_RULES: pick("STYLE_RULES", "(none provided — run the style-guide task)"),
        VOICE_NOTES: pick("VOICE_NOTES", "(none provided — run the character-voice task)"),
        POLISH_FINDINGS: findingsText,
      };
      const prompt = transformUserPrompt(template, values);
      const entries = [
        { title: "One-shot — polish system prompt", prompt: systemPrompt },
        {
          title:
            `One-shot — polish ${seg.id} ` +
            `(endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${polishThinking.thinking ? polishThinking.thinkingLevel : "off"})`,
          prompt,
        },
      ];
      if (verifySystemPrompt) {
        const vPrompt = transformUserPrompt(verifyTemplate, {
          SOURCE_TEXT: sourceText,
          DRAFT_TEXT: draft,
          POLISHED_TEXT: "(dry-run: the polished output of the call above — not available)",
          GLOSSARY: glossaryBlock(chapterTerminology(refs, sourceText).terms),
        });
        entries.push(
          { title: "One-shot — polish drift-check system prompt", prompt: verifySystemPrompt },
          {
            title:
              `One-shot — polish drift-check ${seg.id} ` +
              `(endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${polishThinking.thinking ? polishThinking.thinkingLevel : "off"})`,
            prompt: vPrompt,
          }
        );
      }
      const file = await writePromptDump(
        `polish-${volume.installmentNumber}-${seg.id}`,
        volume.installmentNumber,
        "one-shot (edit model)",
        entries
      );
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: --dry-run prompt dump → ${file}`);
      return;
    }

    // (#3/#4) Phase A — produce a guard-gated polish candidate (the edit
    // endpoint, NO source text). The deterministic regression guard is the only
    // per-chapter gate now; the source-aware final audit is Phase B (a batched
    // cross-check pass, after every candidate exists). A Phase B FAIL re-polishes
    // here with the findings injected, so this loop is the re-polish step.
    let attemptText = hasExistingPolish ? (await fs.readFile(polishedPath, "utf8")) : null;

    for (let round = 1; round <= polishMaxRounds && attemptText === null; round++) {
      // Fresh polish (attempt 1) or re-polish with the previous attempt's
      // findings. The polisher sees NO source text — surface cleanup.
      const findingsText = findings ? findings.slice(0, POLISH_FINDINGS_MAX_CHARS) : "(none — first pass)";
      const { pick } = fitReferenceBlocks({
        blocks: polishReferenceBlocks({ refs, sourceText }),
        fixedTokens: estimateTokens(draft) + estimateTokens(findingsText) + estimateTokens(template) + 120,
        endpoint,
        label: `Volume ${volume.installmentNumber} ${seg.id}`,
      });
      const values = {
        TRANSLATION_TEXT: draft,
        GLOSSARY: pick("GLOSSARY", "(none provided — run the glossary task)"),
        STYLE_RULES: pick("STYLE_RULES", "(none provided — run the style-guide task)"),
        VOICE_NOTES: pick("VOICE_NOTES", "(none provided — run the character-voice task)"),
        POLISH_FINDINGS: findingsText,
      };
      const prompt = transformUserPrompt(template, values);
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: polishing draft (${draft.length} chars) ` +
          `with ${endpoint.model}… (attempt ${round}/${polishMaxRounds})`
      );
      const result = await harness.runOneShot({
        systemPrompt,
        messages: [{ text: prompt }],
        endpoint,
        // The role endpoint's own output cap / context window (harness.js derives
        // them from the global AI_* settings when the role sets neither).
        maxTokens: endpoint.maxTokens,
        contextWindow: endpoint.contextWindow,
        temperature: Number.isFinite(polishTemperature) ? polishTemperature : 0.6,
        thinking: polishThinking.thinking,
        thinkingLevel: polishThinking.thinkingLevel,
        label: `polish-v${volume.installmentNumber}-${seg.id}${polishMaxRounds > 1 ? `-r${round}` : ""}`,
      });
      const text = stripMarkdownFence(result);
      if (!text) {
        throw new Error(
          `Volume ${volume.installmentNumber} ${seg.id}: the model returned no content for the polish pass. ` +
            `Check .logs/ and re-run.`
        );
      }
      // Deterministic regression guard (free — no AI call): the polished text
      // must not make things WORSE than the draft.
      const qaDraft = checkTranslationQa({ sourceText, draftText: draft, terms: refs.terms, sourceLanguage, targetLanguage });
      const qaPolished = checkTranslationQa({ sourceText, draftText: text, terms: refs.terms, sourceLanguage, targetLanguage });
      const regressed =
        (!qaPolished.ok && qaDraft.ok) || qaPolished.missingTerms.length > qaDraft.missingTerms.length;
      if (regressed) {
        findings = buildPolishGuardFindings(qaPolished);
        console.warn(
          `  Volume ${volume.installmentNumber} ${seg.id}: attempt ${round} — deterministic guard rejected the ` +
            `polish (errors: ${qaPolished.errors.join("; ")}; missing terms ` +
            `${qaDraft.missingTerms.length} → ${qaPolished.missingTerms.length})` +
            (round < polishMaxRounds ? " — re-polishing with the findings." : ".")
        );
        continue;
      }
      if (qaPolished.warnings.length > 0) {
        console.warn(
          `  Volume ${volume.installmentNumber} ${seg.id}: QA warning: ${qaPolished.warnings.join("; ")}`
        );
      }
      attemptText = text;
    }

    if (attemptText === null) {
      // Guard rejected every attempt — keep the draft; the findings persist for
      // the next run (a re-run re-polishes with them; --force gives a fresh
      // attempt).
      await fs.rm(polishedPath, { force: true });
      state.chapters[seg.id] = {
        ...sEntry,
        sourceHash: sEntry.sourceHash ?? sourceHash,
        contextHash: sEntry.contextHash ?? refs.contextHash,
        draftHash,
        polishedDraftHash: null,
        polishVerifiedDraftHash: null,
        polishFindings: findings,
        polishFindingsHash: findings ? sha256(findings) : null,
      };
      rejected += 1;
      console.warn(
        `  Volume ${volume.installmentNumber} ${seg.id}: polish REJECTED after ${polishMaxRounds} attempt(s) — ` +
          `keeping the draft (guard findings saved; the next run re-polishes with them).`
      );
      rows[idx] = { id: seg.id, title: seg.title, status: "guard-rejected (draft kept)", ok: true, score: null, warnings: [] };
      return;
    }

    // A guard-gated candidate — write it and queue it for Phase B (the batched
    // cross-model final audit). Not marked verified until Phase B accepts it.
    await fs.writeFile(polishedPath, attemptText + "\n", "utf8");
    state.chapters[seg.id] = {
      ...sEntry,
      sourceHash: sEntry.sourceHash ?? sourceHash,
      contextHash: sEntry.contextHash ?? refs.contextHash,
      draftHash,
      polishedDraftHash: draftHash,
      polishVerifiedDraftHash: null,
      polishFindings: null,
      polishFindingsHash: null,
    };
    auditPending.push({ id: seg.id, draftHash });
  });

  // Crash-safety: persist the Phase A state (candidates + guard findings)
  // before the switch to the audit endpoint — a crash mid-Phase-B must not lose
  // the guard-gated candidates.
  await saveTranslationState(path.join(volumeDir, STATE_FILE), state);

  // Phase A is done: the candidates and the findings are on disk. Phase B (the
  // cross-model audit) is driven by the TASK, across every volume at once, so
  // the container switch happens once per round for the whole run.
  return {
    volume,
    volumeDir,
    bundle,
    refs,
    state,
    sidecar,
    rows,
    polished,
    skipped,
    rejected,
    noDraft,
    auditPending,
  };
}

/**
 * Accept every Phase A candidate without the cross-model audit
 * (POLISH_VERIFY_ENABLED=false): the deterministic regression guard was the
 * only gate.
 *
 * @param {Object} vc - The volume context from Phase A.
 */
async function acceptPolishCandidatesWithoutAudit(vc) {
  for (const c of vc.auditPending) {
    const s = vc.state.chapters[c.id] || {};
    vc.state.chapters[c.id] = {
      ...s,
      polishedDraftHash: c.draftHash,
      polishVerifiedDraftHash: c.draftHash,
      polishScore: null,
      polishFindings: null,
      polishFindingsHash: null,
    };
    vc.sidecar.chapters[c.id] = {
      sourceHash: s.sourceHash,
      draftHash: c.draftHash,
      score: null,
      pass: true,
      findings: "(inspector disabled — deterministic guard only)",
      verifiedAt: new Date().toISOString(),
    };
    vc.polished += vc.auditPending.length;
    const row = vc.rows.find((r) => r.id === c.id);
    if (row) row.status = "polished (guard only — inspector disabled)";
  }
  await saveTranslationState(path.join(vc.volumeDir, STATE_FILE), vc.state);
  await fs.writeFile(
    path.join(vc.volumeDir, POLISH_VERIFICATION_FILE),
    JSON.stringify(vc.sidecar, null, 2) + "\n",
    "utf8"
  );
  vc.auditPending = [];
}

/**
 * Phase B, ONE round, ONE volume — the batched cross-model final audit over
 * this volume's guard-gated candidates.
 *
 * No hooks here on purpose: the caller wraps a whole round across ALL volumes
 * in a single hook invocation. (Observed: the audit hook used to fire inside
 * the per-volume loop, so a 17-volume run paid 17 container switches for a pass
 * that is designed to need one — the exact interleaving the batching exists to
 * avoid.)
 *
 * Mutates `vc.auditPending` (the candidates that failed this round), the
 * volume's state and its sidecar.
 *
 * @param {Object} vc - The volume context from Phase A.
 * @param {{verifySystemPrompt: string, verifyTemplate: string, auditEndpoint: Object}} ctx
 * @returns {Promise<number>} How many candidates failed this round.
 */
async function runPolishAuditRound(vc, { verifySystemPrompt, verifyTemplate, auditEndpoint, dryRun = false }) {
  const { volume, volumeDir, bundle, refs, state, sidecar, rows } = vc;
  const auditResults = await runAuditBatch({
    volume,
    volumeDir,
    bundle,
    refs,
    systemPrompt: verifySystemPrompt,
    template: verifyTemplate,
    auditEndpoint,
    toAudit: vc.auditPending,
    dryRun,
  });
  const byId = new Map(auditResults.map((a) => [a.id, a]));
  const failed = [];
  for (const c of vc.auditPending) {
    const a = byId.get(c.id);
    const s = state.chapters[c.id] || {};
    if (!a || !a.pass) {
      failed.push({ id: c.id, draftHash: c.draftHash, findings: a ? a.findings : "(audit returned no result — re-audit)" });
      sidecar.chapters[c.id] = {
        sourceHash: s.sourceHash,
        draftHash: c.draftHash,
        score: a ? a.score : null,
        pass: false,
        findings: a ? a.findings : "(audit returned no result — re-audit)",
        verifiedAt: new Date().toISOString(),
      };
      continue;
    }
    state.chapters[c.id] = {
      ...s,
      polishedDraftHash: c.draftHash,
      polishVerifiedDraftHash: c.draftHash,
      polishScore: a.score,
      polishFindings: null,
      polishFindingsHash: null,
    };
    sidecar.chapters[c.id] = {
      sourceHash: s.sourceHash,
      draftHash: c.draftHash,
      score: a.score,
      pass: true,
      findings: "(no findings)",
      verifiedAt: new Date().toISOString(),
    };
    vc.polished += 1;
    const row = rows.find((r) => r.id === c.id);
    if (row) row.status = `polished (cross-model audit ${a.score === null ? "n/a" : a.score + "/100"})`;
  }
  await saveTranslationState(path.join(volumeDir, STATE_FILE), state);
  await fs.writeFile(
    path.join(volumeDir, POLISH_VERIFICATION_FILE),
    JSON.stringify(sidecar, null, 2) + "\n",
    "utf8"
  );
  vc.auditPending = failed.map((f) => ({ id: f.id, draftHash: f.draftHash }));
  return failed.length;
}

/**
 * Re-polish one volume's audit-failed candidates on the edit endpoint, with the
 * audit findings injected as a numbered correction task (the retranslate
 * pattern). Called inside the task-level re-polish batch.
 *
 * @param {Object} vc - The volume context.
 * @param {{systemPrompt: string, template: string, endpoint: Object}} ctx
 */
async function runPolishRepairRound(vc, { systemPrompt, template, endpoint }) {
  await runRePolish({
    volume: vc.volume,
    volumeDir: vc.volumeDir,
    bundle: vc.bundle,
    refs: vc.refs,
    systemPrompt,
    template,
    endpoint,
    state: vc.state,
    failed: vc.auditPending,
  });
  await saveTranslationState(path.join(vc.volumeDir, STATE_FILE), vc.state);
}

/**
 * Finish one volume: drop the polished text that never passed the audit (so the
 * merge publishes the draft), re-merge translation.md, and write the polish
 * report.
 *
 * @param {Object} vc - The volume context.
 * @param {number} auditRounds - How many audit rounds ran (for the report wording).
 * @returns {Promise<{polished: number, skipped: number, rejected: number, noDraft: number, missing: Array}>}
 */
async function finishPolishVolume(vc, auditRounds) {
  const { volume, volumeDir, bundle, state, rows } = vc;
  // Any still-pending candidate failed every round — keep the DRAFT (drop the
  // polished file so the merge publishes the draft) and persist the findings
  // (the next run re-audits/re-polishes with them).
  for (const c of vc.auditPending) {
    const { polishedFile } = chapterArtifactNames(c.id);
    await fs.rm(path.join(volumeDir, polishedFile), { force: true });
    const s = state.chapters[c.id] || {};
    state.chapters[c.id] = {
      ...s,
      polishedDraftHash: null,
      polishVerifiedDraftHash: null,
      polishFindings: s.polishFindings,
      polishFindingsHash: s.polishFindingsHash,
    };
    vc.rejected += 1;
    const row = rows.find((r) => r.id === c.id);
    if (row) row.status = `polish rejected after ${auditRounds} audit round(s) — draft kept`;
    console.warn(
      `  Volume ${volume.installmentNumber} ${c.id}: polish REJECTED after ${auditRounds} cross-model audit ` +
        `round(s) — keeping the draft (findings saved; the next run re-audits with them, or use --force for ` +
        `a fresh attempt).`
    );
  }
  // Re-merge the volume (the polished text wins now).
  const merged = await mergeVolumeTranslationFiles(volumeDir, bundle, state, {
    sourceLanguage,
    targetLanguage,
  });
  if (merged.text) {
    await fs.writeFile(path.join(volumeDir, MERGED_FILE), merged.text, "utf8");
  }
  if (merged.missing.length > 0) {
    console.error(
      `  Volume ${volume.installmentNumber}: INCOMPLETE — ${merged.missing.length} chapter(s) have no ` +
        `text after the polish pass: ${merged.missing.map((m) => m.id).join(", ")}.`
    );
  }
  const lines = [
    `# Polish QA — Volume ${volume.installmentNumber} (${volume.folder})`,
    "",
    "_Polish pass (the polisher sees NO source text) gated by the deterministic regression guard" +
      (polishVerifyEnabled
        ? ` and the source-aware drift inspector (score 0–100; PASS at or above ${polishVerifyPassingScore}; ` +
          `an unparseable score is a FAIL).`
        : " only (POLISH_VERIFY_ENABLED=false).") +
      " A failed attempt re-polishes with the findings injected; a rejected chapter keeps its draft.",
    "",
    "| Chapter | Title | Status | Drift Score | Warnings |",
    "|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.title || "—"} | ${r.status} | ${r.score === null ? "—" : r.score + "/100"} | ${
          r.warnings.length > 0 ? r.warnings.join("; ") : "—"
        } |`
    ),
    "",
  ];
  await fs.writeFile(path.join(volumeDir, POLISH_QA_REPORT), lines.join("\n"), "utf8");
  return { polished: vc.polished, skipped: vc.skipped, rejected: vc.rejected, noDraft: vc.noDraft, missing: merged.missing };
}

// ─── Task entry ─────────────────────────────────────────────────────────────

/**
 * Run the polish task (all volumes, or --volume NN).
 *
 * @returns {Promise<void>}
 */
async function polish() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  validateRequiredEnv({ dryRun });

  const endpoint = roleEndpoint("EDIT");
  const auditEndpoint = polishVerifyEnabled ? roleEndpoint("AUDIT") : null;
  if (!dryRun) {
    await harness.assertModelServing({ ...endpoint, label: "polish stage" });
  }

  const systemPrompt = await fs.readFile(polishSystemPromptFile, "utf-8");
  const template = await fs.readFile(polishTemplateFile, "utf-8");
  const verifySystemPrompt = polishVerifyEnabled
    ? await fs.readFile(polishVerifySystemPromptFile, "utf-8")
    : null;
  const verifyTemplate = polishVerifyEnabled
    ? await fs.readFile(polishVerifyTemplateFile, "utf-8")
    : null;

  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
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
    `[polish] ${sorted.length} volume folder(s); endpoint ${describeEndpoint(endpoint)}; ` +
      `thinking=${polishThinking.thinking ? polishThinking.thinkingLevel : "off"}; ` +
      `final audit ${polishVerifyEnabled ? `ON (batched cross-model audit, PASS ≥ ${polishVerifyPassingScore}/100)` : "OFF (deterministic guard only)"}; ` +
      `max ${polishMaxRounds} round(s)/chapter; concurrency=${polishConcurrency}.`
  );
  await logRunEstimate({
    stage: "polish",
    volumes: volumes.length,
    chapters: (await countStageChapters({ seriesDir, volumes: volumes.map((f) => volumeByFolder.get(f)).filter(Boolean) })).chapters,
    // One polish call per chapter, plus one audit call, plus a re-polish + audit
    // for every round the audit rejects.
    callsPerChapter: 1 + (polishVerifyEnabled ? 2 * polishMaxRounds - 1 : 0),
    endpoint,
    extra: polishVerifyEnabled ? "the audit calls run on the audit endpoint" : "no audit calls (deterministic guard only)",
  });

  const failedVolumes = [];
  /** The Phase A results, kept so the audit rounds can run across ALL volumes. */
  const volumeCtxs = [];

  // ── PHASE A — polish every volume's chapters (the edit endpoint) ──────────
  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
      // The polisher runs on the EDIT_* role — a different model from the
      // verifier and from the auditor that grades its work (see the polish
      // final audit). Re-point the estimate for THIS role before budgeting.
      await calibrateStageTokens({ endpoint, bundle, label: "polish stage", dryRun });
      // The handoff's chapter list and the extracted one must describe the same
      // book (see checkChapterListConsistency). A disagreement is reported, not
      // fatal: the extracted list is the one this stage uses.
      await checkChapterListConsistency(volumeDir, bundle);
      // The volume's own text decides WHICH sections of the cumulative
      // references get injected (see loadVolumeReferences): a 17-volume series
      // must show the translator the state and cast that matter to THIS book.
      const volumeSourceText = await readFileOrEmpty(bundle.wholePath || path.join(volumeDir, bundle.segments[0].file));
      const refs = await loadVolumeReferences(volumeDir, volumeSourceText);
      const vc = await polishVolumePhaseA({
        volume,
        volumeDir,
        bundle,
        refs,
        systemPrompt,
        template,
        verifySystemPrompt,
        verifyTemplate,
        endpoint,
        auditEndpoint,
        dryRun,
        force,
        sourceLanguage: runSettings.sourceLanguage,
        targetLanguage: runSettings.targetLanguage,
      });
      if (dryRun) continue; // Phase A dumped prompts and produced nothing to audit
      volumeCtxs.push(vc);
      console.log(
        `[polish] Volume ${volume.installmentNumber}: ${vc.auditPending.length} guard-gated candidate(s), ` +
          `${vc.rejected} guard-rejected (draft kept), ${vc.skipped} skipped, ${vc.noDraft} without draft.`
      );
    } catch (err) {
      // A STRUCTURAL failure (a source file that vanished, an archive that will not
      // open, a volume whose chapters are incomplete) is never skippable: ON_VOLUME_ERROR
      //=skip exists for flaky model calls, not for a broken book.
      if (ON_VOLUME_ERROR === "skip" && !isStructuralError(err)) {
        console.error(`[skip] Volume ${volume.installmentNumber} (${folderName}) failed: ${err.message}`);
        failedVolumes.push(volume.installmentNumber);
        continue;
      }
      throw err;
    }
  }

  // ── PHASE B — the cross-model audit rounds, batched across EVERY volume ───
  // One hook invocation per round for the whole run (the container switch on a
  // shared-port setup), then one re-polish batch, then the next audit round.
  // It used to be per volume: a 17-volume run paid ~17 switches per round.
  const auditRounds = Math.max(1, polishMaxRounds);
  if (!dryRun) {
    if (!polishVerifyEnabled) {
      for (const vc of volumeCtxs) await acceptPolishCandidatesWithoutAudit(vc);
    } else {
      for (let round = 1; round <= auditRounds; round++) {
        const pending = volumeCtxs.filter((vc) => vc.auditPending.length > 0);
        if (pending.length === 0) break;
        console.log(
          `[polish-audit] round ${round}/${auditRounds} — auditing ` +
            `${pending.reduce((n, vc) => n + vc.auditPending.length, 0)} candidate(s) across ` +
            `${pending.length} volume(s) on ${auditEndpoint.model} (one batch, one switch).`
        );
        const auditBatch = withHooks("polish-audit", async () => {
          for (const vc of pending) {
            await runPolishAuditRound(vc, { verifySystemPrompt, verifyTemplate, auditEndpoint, dryRun });
          }
        });
        await auditBatch();

        const failedCount = pending.reduce((n, vc) => n + vc.auditPending.length, 0);
        if (failedCount === 0) break;
        if (round === auditRounds) break; // the remaining candidates are finished off below

        const repairBatch = withHooks("polish", async () => {
          for (const vc of pending) {
            if (vc.auditPending.length === 0) continue;
            await runPolishRepairRound(vc, { systemPrompt, template, endpoint });
          }
        });
        await repairBatch();
      }
    }

    let totalPolished = 0;
    let totalRejected = 0;
    let totalSkipped = 0;
    let totalNoDraft = 0;
    const incompleteVolumes = [];
    for (const vc of volumeCtxs) {
      const result = await finishPolishVolume(vc, auditRounds);
      totalPolished += result.polished;
      totalRejected += result.rejected;
      totalSkipped += result.skipped;
      totalNoDraft += result.noDraft;
      if (result.missing.length > 0) {
        incompleteVolumes.push({
          installmentNumber: vc.volume.installmentNumber,
          missing: result.missing.map((m) => m.id),
        });
      }
    }
    console.log(
      `[polish] Done: ${totalPolished} chapter(s) polished, ${totalRejected} rejected ` +
        `(rejected chapters keep their draft and retry on the next run), ${totalSkipped} skipped, ` +
        `${totalNoDraft} without draft.`
    );
    await writeTranslationReport({ seriesDir, manifest, volumes, dryRun });
    if (incompleteVolumes.length > 0) {
      throw structuralError(
        `${incompleteVolumes.length} volume(s) are INCOMPLETE after the polish pass — chapters with no ` +
          `text: ${incompleteVolumes.map((v) => `${v.installmentNumber} (${v.missing.join(", ")})`).join("; ")}.`
      );
    }
    const volumeError = volumeFailureError("polish", failedVolumes, volumes.length);
    if (volumeError) throw volumeError;
    return;
  }

  console.log(`[polish] --dry-run: ${volumes.length} volume(s) previewed, no files written.`);
}

module.exports = {
  polish,
  polishVolumePhaseA,
  processPolishVolume: polishVolumePhaseA,
  runPolishAuditRound,
  runPolishRepairRound,
  finishPolishVolume,
  POLISH_QA_REPORT,
  POLISH_VERIFICATION_FILE,
};
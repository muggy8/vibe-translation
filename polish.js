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
const { ON_VOLUME_ERROR, PASSING_SCORE, validateRequiredEnv, isStructuralError, structuralError } = require("./configs/shared");
const { fileExists } = require("./utils/fs");
const { resolveSourceBundle } = require("./utils/source");
const { transformUserPrompt, parseAcceptanceScore, writePromptDump } = require("./utils/prompt");
const {
  sha256,
  checkTranslationQa,
  buildPolishGuardFindings,
  stripMarkdownFence,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  runWithConcurrency,
  stageConcurrency,
  judgeTemperature,
  stageThinking,
  writerTemperature,
} = require("./utils/translate");
const { chapterArtifactNames, mergeVolumeTranslationFiles } = require("./translate");
const { glossaryBlock, loadVerificationSidecar, findingsOf } = require("./verify-translate");
const { withHooks } = require("./utils/hooks");

// ─── Paths & config ──────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const polishSystemPromptFile = path.join(clientDir, "system-prompts", "polish.md");
const polishTemplateFile = path.join(clientDir, "user-prompts", "polish.md");
const polishVerifySystemPromptFile = path.join(clientDir, "system-prompts", "polish-verify.md");
const polishVerifyTemplateFile = path.join(clientDir, "user-prompts", "polish-verify.md");

const POLISH_QA_REPORT = "polish-qa.md";
const POLISH_VERIFICATION_FILE = "polish-verification.json";

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
async function runAuditBatch({ volume, volumeDir, bundle, refs, systemPrompt, template, auditEndpoint, toAudit }) {
  await harness.assertModelServing({ ...auditEndpoint, label: "polish-audit stage" });
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
    const prompt = transformUserPrompt(template, {
      SOURCE_TEXT: sourceText,
      DRAFT_TEXT: draft,
      POLISHED_TEXT: polished,
      GLOSSARY: glossaryBlock(chapterTerminology(refs, sourceText).terms),
    });
    const vResult = await harness.runOneShot({
      systemPrompt,
      messages: [{ text: prompt }],
      endpoint: auditEndpoint,
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
    const values = {
      TRANSLATION_TEXT: draft,
      GLOSSARY: glossaryBlock(chapterTerminology(refs, chapterSource).terms),
      STYLE_RULES: refs.styleRules || "(none provided — run the style-guide task)",
      VOICE_NOTES: refs.voiceNotes || "(none provided — run the character-voice task)",
      POLISH_FINDINGS: findings ? findings.slice(0, POLISH_FINDINGS_MAX_CHARS) : "(none)",
    };
    const prompt = transformUserPrompt(template, values);
    const result = await harness.runOneShot({
      systemPrompt,
      messages: [{ text: prompt }],
      endpoint,
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
async function processPolishVolume(ctx) {
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
  } = ctx;
  const state = await loadTranslationState(path.join(volumeDir, "translation-state.json"));
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
      const values = {
        TRANSLATION_TEXT: draft,
        GLOSSARY: glossaryBlock(chapterTerminology(refs, sourceText).terms),
        STYLE_RULES: refs.styleRules || "(none provided — run the style-guide task)",
        VOICE_NOTES: refs.voiceNotes || "(none provided — run the character-voice task)",
        POLISH_FINDINGS: findings ? findings.slice(0, POLISH_FINDINGS_MAX_CHARS) : "(none — first pass)",
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
      const values = {
        TRANSLATION_TEXT: draft,
        GLOSSARY: glossaryBlock(chapterTerminology(refs, sourceText).terms),
        STYLE_RULES: refs.styleRules || "(none provided — run the style-guide task)",
        VOICE_NOTES: refs.voiceNotes || "(none provided — run the character-voice task)",
        POLISH_FINDINGS: findings ? findings.slice(0, POLISH_FINDINGS_MAX_CHARS) : "(none — first pass)",
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
      const qaDraft = checkTranslationQa({ sourceText, draftText: draft, terms: refs.terms });
      const qaPolished = checkTranslationQa({ sourceText, draftText: text, terms: refs.terms });
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
  await saveTranslationState(path.join(volumeDir, "translation-state.json"), state);

  // (#3/#4) Phase B — the batched cross-model FINAL audit. Runs AFTER every
  // Phase A candidate exists, so the whole batch runs under one endpoint (the
  // polish-audit hook switches the audit container in on local setups) — never
  // interleaved with the polisher. A FAIL re-polishes on the edit endpoint (the
  // polish hook switches it back) and is re-audited next round; after
  // polishMaxRounds rounds a still-failing chapter keeps the DRAFT (any
  // polished file is dropped so the merge publishes it) and its findings
  // persist for the next run.
  const polishAuditRounds = Math.max(1, polishMaxRounds);
  for (let round = 1; round <= polishAuditRounds; round++) {
    if (auditPending.length === 0) break;

    if (!polishVerifyEnabled) {
      // Inspector disabled: the deterministic guard was the only gate — accept
      // every Phase A candidate as-is (no cross-model audit).
      for (const c of auditPending) {
        const s = state.chapters[c.id] || {};
        state.chapters[c.id] = {
          ...s,
          polishedDraftHash: c.draftHash,
          polishVerifiedDraftHash: c.draftHash,
          polishScore: null,
          polishFindings: null,
          polishFindingsHash: null,
        };
        sidecar.chapters[c.id] = {
          sourceHash: s.sourceHash,
          draftHash: c.draftHash,
          score: null,
          pass: true,
          findings: "(inspector disabled — deterministic guard only)",
          verifiedAt: new Date().toISOString(),
        };
      }
      await saveTranslationState(path.join(volumeDir, "translation-state.json"), state);
      await fs.writeFile(
        path.join(volumeDir, POLISH_VERIFICATION_FILE),
        JSON.stringify(sidecar, null, 2) + "\n",
        "utf8"
      );
      polished += auditPending.length;
      for (const c of auditPending) {
        const row = rows.find((r) => r.id === c.id);
        if (row) row.status = "polished (guard only — inspector disabled)";
      }
      break;
    }

    // The batched audit (one endpoint switch for the whole batch).
    const auditPhase = withHooks("polish-audit", () =>
      runAuditBatch({
        volume,
        volumeDir,
        bundle,
        refs,
        systemPrompt: verifySystemPrompt,
        template: verifyTemplate,
        auditEndpoint,
        toAudit: auditPending,
      })
    );
    const auditResults = await auditPhase();
    const byId = new Map(auditResults.map((a) => [a.id, a]));
    const failed = [];
    for (const c of auditPending) {
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
      polished += 1;
      const row = rows.find((r) => r.id === c.id);
      if (row) row.status = `polished (cross-model audit ${a.score === null ? "n/a" : a.score + "/100"})`;
    }
    await saveTranslationState(path.join(volumeDir, "translation-state.json"), state);
    await fs.writeFile(
      path.join(volumeDir, POLISH_VERIFICATION_FILE),
      JSON.stringify(sidecar, null, 2) + "\n",
      "utf8"
    );
    if (failed.length === 0) {
      auditPending = [];
      break;
    }

    // Re-polish the failed candidates (the edit endpoint — the polish hook
    // switches back on local setups) with the audit findings injected; they
    // re-enter the queue for the next round.
    const rePolishPhase = withHooks("polish", () =>
      runRePolish({
        volume,
        volumeDir,
        bundle,
        refs,
        systemPrompt,
        template,
        endpoint,
        state,
        failed,
      })
    );
    await rePolishPhase();
    await saveTranslationState(path.join(volumeDir, "translation-state.json"), state);
    auditPending = failed.map((f) => ({ id: f.id, draftHash: f.draftHash }));
  }

  // After the audit loop: any still-pending candidate failed every round —
  // keep the DRAFT (drop the polished file so the merge publishes the draft)
  // and persist the findings (the next run re-audits/re-polishes with them).
  for (const c of auditPending) {
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
    rejected += 1;
    const row = rows.find((r) => r.id === c.id);
    if (row) row.status = `polish rejected after ${polishAuditRounds} audit round(s) — draft kept`;
    console.warn(
      `  Volume ${volume.installmentNumber} ${c.id}: polish REJECTED after ${polishAuditRounds} cross-model audit round(s) — ` +
        `keeping the draft (findings saved; the next run re-audits with them, or use --force for a fresh attempt).`
    );
  }
  // Re-merge the volume (the polished text wins now).
  const mergedText = await mergeVolumeTranslationFiles(volumeDir, bundle, state);
  if (mergedText) {
    await fs.writeFile(path.join(volumeDir, "translation.md"), mergedText, "utf8");
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
  return { polished, skipped, rejected, noDraft };
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
    `[polish] ${sorted.length} volume folder(s); endpoint ${endpoint.model} @ ${endpoint.baseUrl} ` +
      `(model from ${endpoint.modelSource}, base from ${endpoint.baseUrlSource}); ` +
      `thinking=${polishThinking.thinking ? polishThinking.thinkingLevel : "off"}; ` +
      `final audit ${polishVerifyEnabled ? `ON (batched cross-model audit, PASS ≥ ${polishVerifyPassingScore}/100)` : "OFF (deterministic guard only)"}; ` +
      `max ${polishMaxRounds} round(s)/chapter; concurrency=${polishConcurrency}.`
  );

  const failedVolumes = [];
  let totalPolished = 0;
  let totalRejected = 0;

  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
      const refs = await loadVolumeReferences(volumeDir);
      const result = await processPolishVolume({
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
      });
      totalPolished += result.polished;
      totalRejected += result.rejected;
      console.log(
        `[polish] Volume ${volume.installmentNumber}: ${result.polished} polished, ` +
          `${result.rejected} rejected (draft kept), ${result.skipped} skipped, ${result.noDraft} without draft.`
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

  console.log(
    `[polish] Done: ${totalPolished} chapter(s) polished, ${totalRejected} rejected ` +
      `(rejected chapters keep their draft and retry on the next run).`
  );
  if (failedVolumes.length > 0) {
    throw new Error(
      `${failedVolumes.length} of ${volumes.length} volume(s) failed: ${failedVolumes.join(", ")}.`
    );
  }
}

module.exports = {
  polish,
  processPolishVolume,
  POLISH_QA_REPORT,
  POLISH_VERIFICATION_FILE,
};
/**
 * Phase A: the source-free polish per chapter, the deterministic regression guard, and the candidate queue. acceptPolishCandidatesWithoutAudit is the POLISH_VERIFY_ENABLED=false path — the guard alone.
 *
 * Part of the polish.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { fileExists } = require("../utils/fs");
const { transformUserPrompt, parseAcceptanceScore, writePromptDump } = require("../utils/prompt");
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
} = require("../utils/translate");

const { POLISH_FINDINGS_MAX_CHARS, polishConcurrency, polishMaxRounds, polishTemperature, polishThinking } = require("./config");
const { fitReferenceBlocks, polishReferenceBlocks } = require("./references");

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
  // The languages travel with the volume context: Phase B (finishPolishVolume)
  // re-merges the volume, and the merge needs the pair to decide which chapters
  // look truncated. Handing them back here is what keeps Phase A's ctx and
  // Phase B's vc the same object — they used to disagree, and the merge died
  // with `sourceLanguage is not defined` on every volume of every run.
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
    sourceLanguage,
    targetLanguage,
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


module.exports = {
  polishVolumePhaseA,
  acceptPolishCandidatesWithoutAudit,
};

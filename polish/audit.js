/**
 * Phase B: one batched call per candidate on the AUDIT_* endpoint, and the round that decides pass / re-polish / exhausted. Batched because the local containers share one port — the whole batch runs under one endpoint, never interleaved with the polisher.
 *
 * Part of the polish.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { transformUserPrompt, parseAcceptanceScore } = require("../utils/prompt");
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

const { auditConcurrency, auditTemperature, auditThinking, polishVerifyPassingScore } = require("./config");
const { fitReferenceBlocks } = require("./references");

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


module.exports = {
  runAuditBatch,
  runPolishAuditRound,
};

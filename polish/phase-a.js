/**
 * Phase A: the source-free polish per chapter, the deterministic regression guard, and the candidate
 * queue. acceptPolishCandidatesWithoutAudit is the POLISH_VERIFY_ENABLED=false path — the guard alone.
 *
 * One chapter's Phase A is a sequence of decisions, and each one is a function here because each has
 * its own reason to exist: is there anything to polish? is it already polished against THIS draft?
 * what does the polisher get shown? did the guard accept what came back? what do we record either
 * way? The loop in polishVolumePhaseA only decides which chapters to run and in what order.
 *
 * Part of the polish.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { fileExists } = require("../utils/fs");
const { transformUserPrompt, writePromptDump } = require("../utils/prompt");
const {
  sha256,
  checkTranslationQa,
  buildPolishGuardFindings,
  stripMarkdownFence,
  loadTranslationState,
  saveTranslationState,
  chapterTerminology,
  runWithConcurrency,
  estimateTokens,
  glossaryBlock,
  loadVerificationSidecar,
  chapterArtifactNames,
  STATE_FILE,
  POLISH_VERIFICATION_FILE,
} = require("../utils/translate");

const { POLISH_FINDINGS_MAX_CHARS, polishConcurrency, polishMaxRounds, polishTemperature, polishThinking } = require("./config");
const { fitReferenceBlocks, polishReferenceBlocks } = require("./references");

/**
 * @typedef {Object} PolishChapterContext - What one chapter's polish pass needs, shared by every
 *   helper in this file.
 * @property {Object} volume
 * @property {Object} refs
 * @property {Object} endpoint
 * @property {string} systemPrompt
 * @property {string} template
 * @property {string|null} verifySystemPrompt
 * @property {string|null} verifyTemplate
 * @property {string} sourceLanguage
 * @property {string} targetLanguage
 */

/**
 * Build the polisher's user prompt for one chapter: the draft, the references that fit the budget,
 * and the findings from the last rejected attempt.
 *
 * The same builder serves the dry-run dump and the live call, so what --dry-run shows is what the
 * model will actually be sent.
 *
 * @param {{refs: Object, sourceText: string, draft: string, findings: string, template: string, endpoint: Object, label: string}} args
 * @returns {{prompt: string, findingsText: string}}
 */
function buildPolishPrompt({ refs, sourceText, draft, findings, template, endpoint, label }) {
  const findingsText = findings ? findings.slice(0, POLISH_FINDINGS_MAX_CHARS) : "(none — first pass)";
  const { pick } = fitReferenceBlocks({
    blocks: polishReferenceBlocks({ refs, sourceText }),
    fixedTokens: estimateTokens(draft) + estimateTokens(findingsText) + estimateTokens(template) + 120,
    endpoint,
    label,
  });
  return {
    findingsText,
    prompt: transformUserPrompt(template, {
      TRANSLATION_TEXT: draft,
      GLOSSARY: pick("GLOSSARY", "(none provided — run the glossary task)"),
      STYLE_RULES: pick("STYLE_RULES", "(none provided — run the style-guide task)"),
      VOICE_NOTES: pick("VOICE_NOTES", "(none provided — run the character-voice task)"),
      POLISH_FINDINGS: findingsText,
    }),
  };
}

/**
 * --dry-run: dump the prompts a live run would send for this chapter (the polish pair, and the
 * drift-check pair when the final audit is on). No AI calls.
 *
 * The drift-check prompt's polished-text input is the output of the polish call, which does not exist
 * in a dry run — the dump says so rather than inventing one.
 *
 * @param {{volume: Object, seg: Object, ctx: PolishChapterContext, draft: string, sourceText: string, findings: string}} args
 * @returns {Promise<void>}
 */
async function dumpPolishChapterPrompts({ volume, seg, ctx, draft, sourceText, findings }) {
  const { template, systemPrompt, verifySystemPrompt, verifyTemplate, refs, endpoint } = ctx;
  const { prompt, findingsText } = buildPolishPrompt({
    refs,
    sourceText,
    draft,
    findings,
    template,
    endpoint,
    label: `Volume ${volume.installmentNumber} ${seg.id}`,
  });
  const thinking = polishThinking.thinking ? polishThinking.thinkingLevel : "off";
  const entries = [
    { title: "One-shot — polish system prompt", prompt: systemPrompt },
    {
      title: `One-shot — polish ${seg.id} (endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${thinking})`,
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
          `(endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${thinking})`,
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
}

/**
 * Ask the polisher for a rewrite, up to `polishMaxRounds` times, and let the deterministic guard
 * decide whether each attempt is worth keeping.
 *
 * The polisher sees NO source text — it is a surface cleanup. The guard is what makes that safe: it
 * compares the draft and the polished text against the same source with no model involved, so "the
 * prose reads better but a glossary term disappeared" is caught for free. A rejected attempt feeds
 * its findings into the next one.
 *
 * @param {{volume: Object, seg: Object, ctx: PolishChapterContext, draft: string, sourceText: string, findings: string, hasExistingPolish: boolean, polishedPath: string}} args
 * @returns {Promise<{text: string|null, findings: string}>} `text` is null when every attempt was rejected.
 */
async function polishChapterAttempts({ volume, seg, ctx, draft, sourceText, findings, hasExistingPolish, polishedPath }) {
  const { refs, endpoint, template, systemPrompt } = ctx;
  const { sourceLanguage, targetLanguage } = ctx;

  // A polished file produced from the CURRENT draft but never drift-verified (a pre-inspector run) is
  // inspected instead of re-polished: one inspector call, no fresh stochastic pass.
  let attemptText = hasExistingPolish ? await fs.readFile(polishedPath, "utf8") : null;

  for (let round = 1; round <= polishMaxRounds && attemptText === null; round++) {
    const { prompt, findingsText } = buildPolishPrompt({
      refs,
      sourceText,
      draft,
      findings,
      template,
      endpoint,
      label: `Volume ${volume.installmentNumber} ${seg.id}`,
    });
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: polishing draft (${draft.length} chars) ` +
        `with ${endpoint.model}… (attempt ${round}/${polishMaxRounds})`
    );
    const result = await harness.runOneShot({
      systemPrompt,
      messages: [{ text: prompt }],
      endpoint,
      // The role endpoint's own output cap / context window (harness.js derives them from the global
      // AI_* settings when the role sets neither).
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
          `Check the run's log folder and re-run.`
      );
    }

    // Deterministic regression guard (free — no AI call): the polished text must not make things
    // WORSE than the draft.
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

  return { text: attemptText, findings };
}

/**
 * Record a chapter whose polish was rejected by the guard: the draft stays, the findings persist so
 * the next run re-polishes with them, and the stale polished file is removed.
 *
 * @param {{volume: Object, seg: Object, idx: number, state: Object, sEntry: Object, sourceHash: string, draftHash: string, refs: Object, findings: string, polishedPath: string, rows: Object[], counters: Object}} args
 * @returns {Promise<void>}
 */
async function recordRejectedPolish({ volume, seg, idx, state, sEntry, sourceHash, draftHash, refs, findings, polishedPath, rows, counters }) {
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
  counters.rejected += 1;
  console.warn(
    `  Volume ${volume.installmentNumber} ${seg.id}: polish REJECTED after ${polishMaxRounds} attempt(s) — ` +
      `keeping the draft (guard findings saved; the next run re-polishes with them).`
  );
  rows[idx] = { id: seg.id, title: seg.title, status: "guard-rejected (draft kept)", ok: true, score: null, warnings: [] };
}

/**
 * Record a guard-gated candidate: write it, mark the draft it was made from, and queue it for Phase B
 * (the batched cross-model audit). It is not marked verified until Phase B accepts it.
 *
 * @param {{seg: Object, state: Object, sEntry: Object, sourceHash: string, draftHash: string, refs: Object, attemptText: string, polishedPath: string, auditPending: Object[]}} args
 * @returns {Promise<void>}
 */
async function queuePolishCandidate({ seg, state, sEntry, sourceHash, draftHash, refs, attemptText, polishedPath, auditPending }) {
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
}

/**
 * Phase A for one chapter: decide whether there is anything to do, then produce a guard-gated
 * candidate or record why there is not one.
 *
 * @param {{volume: Object, seg: Object, idx: number, volumeDir: string, state: Object, ctx: PolishChapterContext, rows: Object[], auditPending: Object[], counters: Object, dryRun: boolean, force: boolean}} args
 * @returns {Promise<void>}
 */
async function polishOneChapter({ volume, seg, idx, volumeDir, state, ctx, rows, auditPending, counters, dryRun, force }) {
  const { draftFile, polishedFile } = chapterArtifactNames(seg.id);
  const chapterPath = path.join(volumeDir, seg.file);
  const draftPath = path.join(volumeDir, draftFile);
  const polishedPath = path.join(volumeDir, polishedFile);

  if (!(await fileExists(draftPath))) {
    console.warn(`  Volume ${volume.installmentNumber} ${seg.id}: no draft — run translate first.`);
    counters.noDraft += 1;
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
    counters.skipped += 1;
    rows[idx] = { id: seg.id, title: seg.title, status: "skipped (up to date)", ok: true, score: null, warnings: [] };
    return;
  }

  // A polished file produced from the CURRENT draft but never drift-verified (a pre-inspector run):
  // inspect the existing text instead of re-polishing (one inspector call, no fresh stochastic pass).
  const hasExistingPolish = !force && sEntry.polishedDraftHash === draftHash && (await fileExists(polishedPath));
  // Findings persisted by a previously rejected run seed the first attempt.
  let findings =
    !hasExistingPolish && typeof sEntry.polishFindings === "string" && sEntry.polishFindings
      ? sEntry.polishFindings
      : "";

  if (dryRun) {
    // Dump the prompts for every chapter a live run would polish (no-draft and up-to-date chapters
    // were skipped above) — one file per chapter.
    await dumpPolishChapterPrompts({ volume, seg, ctx, draft, sourceText, findings });
    return;
  }

  const attempt = await polishChapterAttempts({
    volume,
    seg,
    ctx,
    draft,
    sourceText,
    findings,
    hasExistingPolish,
    polishedPath,
  });

  if (attempt.text === null) {
    // Guard rejected every attempt — keep the draft; the findings persist for the next run (a re-run
    // re-polishes with them; --force gives a fresh attempt).
    await recordRejectedPolish({
      volume,
      seg,
      idx,
      state,
      sEntry,
      sourceHash,
      draftHash,
      refs: ctx.refs,
      findings: attempt.findings,
      polishedPath,
      rows,
      counters,
    });
    return;
  }

  await queuePolishCandidate({
    seg,
    state,
    sEntry,
    sourceHash,
    draftHash,
    refs: ctx.refs,
    attemptText: attempt.text,
    polishedPath,
    auditPending,
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
  const { volume, volumeDir, bundle, refs, dryRun, force, sourceLanguage, targetLanguage } = ctx;
  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  const sidecar = await loadVerificationSidecar(path.join(volumeDir, POLISH_VERIFICATION_FILE));
  const rows = [];
  const counters = { polished: 0, skipped: 0, rejected: 0, noDraft: 0 };
  // (#3/#4) Candidates Phase A produced (guard-gated) — queued for the batched cross-model final
  // audit (Phase B) after all chapters are processed.
  /** @type {Object[]} */
  const auditPending = [];

  /** @type {PolishChapterContext} */
  const chapterCtx = {
    volume,
    refs,
    endpoint: ctx.endpoint,
    template: ctx.template,
    systemPrompt: ctx.systemPrompt,
    verifySystemPrompt: ctx.verifySystemPrompt,
    verifyTemplate: ctx.verifyTemplate,
    sourceLanguage,
    targetLanguage,
  };

  // Chapters are INDEPENDENT (each is polished from its own draft + references), so they can run in
  // parallel when STAGE_CONCURRENCY > 1. Rows are stored by index to keep the report in reading order.
  await runWithConcurrency(bundle.segments, polishConcurrency, async (seg, idx) => {
    await polishOneChapter({ volume, seg, idx, volumeDir, state, ctx: chapterCtx, rows, auditPending, counters, dryRun, force });
  });

  // Crash-safety: persist the Phase A state (candidates + guard findings) before the switch to the
  // audit endpoint — a crash mid-Phase-B must not lose the guard-gated candidates.
  await saveTranslationState(path.join(volumeDir, STATE_FILE), state);

  // Phase A is done: the candidates and the findings are on disk. Phase B (the cross-model audit) is
  // driven by the TASK, across every volume at once, so the container switch happens once per round
  // for the whole run.
  // The languages travel with the volume context: Phase B (finishPolishVolume) re-merges the volume,
  // and the merge needs the pair to decide which chapters look truncated. Handing them back here is
  // what keeps Phase A's ctx and Phase B's vc the same object — they used to disagree, and the merge
  // died with `sourceLanguage is not defined` on every volume of every run.
  return {
    volume,
    volumeDir,
    bundle,
    refs,
    state,
    sidecar,
    rows,
    polished: counters.polished,
    skipped: counters.skipped,
    rejected: counters.rejected,
    noDraft: counters.noDraft,
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

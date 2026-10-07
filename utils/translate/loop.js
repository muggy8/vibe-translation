/**
 * The QA loop's decisions: whether a chapter is worth retranslating, when the
 * loop stops, and the draft ratchet that lets a chapter move only FORWARD.
 *
 * Without the ratchet the loop can publish a strictly worse book: a 75-scoring
 * draft gets rewritten, the rewrite scores 50, the round cap runs out, and the bad
 * text ships (gotcha 37).
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");

const { sha256 } = require("./internal");
const { STATE_FILE, VERIFICATION_FILE, chapterArtifactNames, loadTranslationState, loadVerificationSidecar, saveTranslationState, saveVerificationSidecar } = require("./state");

/**
 * Is re-translating a whole chapter worth the tokens for this FAIL?
 *
 * A retranslate throws away a whole chapter's draft and re-derives it from
 * scratch to fix what may be one awkward sentence. That is the right trade for
 * a fidelity or terminology problem, and a bad one for a cosmetic problem: the
 * fresh pass can introduce new errors while fixing a nit, and it costs a full
 * chapter of generation. Chapters that are skipped by this filter are reported
 * (never silently dropped), so the human reader sees the remaining nits.
 *
 * @param {{score: number|null, findings?: string, deterministic?: boolean}} verdict - The chapter's verification entry.
 * @param {number} passingScore - The shared PASSING_SCORE.
 * @param {number} [margin] - How far below the passing line a cosmetic-only miss must be to justify a rewrite.
 * @returns {boolean} True when the chapter should be retranslated.
 */
function worthRetranslating(verdict, passingScore, margin = 5) {
  // A deterministic-QA failure (residue / truncation / empty) is never cosmetic.
  if (verdict.deterministic) return true;
  // An unparseable score is a FAIL with no information in it — retry it.
  if (typeof verdict.score !== "number") return true;
  // A HIGH finding is a meaning, fidelity or terminology problem: rewrite it.
  if (/\[HIGH\]/i.test(verdict.findings || "")) return true;
  // Otherwise: a chapter that missed the line by a hair on MEDIUM/LOW findings
  // only is a copy-edit, not a re-translation.
  return verdict.score < passingScore - margin;
}

// ─── QA loop (translate-qa) ─────────────────────────────────────────────────


/**
 * Pure stop-decision for the translate-qa loop (the batched
 * "verify → retranslate … until the validator is happy" loop).
 *
 * Rules (checked in this order):
 *   - phase "after-verify": when zero chapters FAIL — stop with "all-pass", or
 *     with "missing-drafts" when some chapter has no draft at all (nothing was
 *     verified for it and the loop cannot fix an absent chapter); when FAILs
 *     remain — stop with "no-improvement" when the draft ratchet had to roll
 *     back EVERY failing chapter to a better earlier draft (the loop is moving
 *     chapters backwards), or with "round-limit" when this was the last allowed
 *     round; otherwise continue to the retranslate batch (a fixable FAIL is
 *     worth a round even when some other chapter is missing).
 *   - phase "after-retranslate": stop with "stalled" when nothing was
 *     retranslated (every FAIL chapter already carries exactly those findings
 *     — the retranslate task's findingsHash skip-check fired, so nothing new
 *     can be applied); else continue to the next verify batch.
 *
 * @param {{
 *   phase: "after-verify"|"after-retranslate",
 *   round: number,
 *   maxRounds: number,
 *   failed?: number,
 *   retranslated?: number,
 *   noDraft?: number,
 *   noImprovement?: number,
 * }} p
 * @returns {{stop: boolean, reason: "all-pass"|"round-limit"|"stalled"|"missing-drafts"|"no-improvement"|null}}
 */
function qaLoopDecision({ phase, round, maxRounds, failed = 0, retranslated = 0, noDraft = 0, noImprovement = 0 }) {
  if (phase === "after-verify") {
    if (failed === 0) {
      // A chapter with no draft was never verified at all — counting it as a
      // pass is how the loop could report "all-pass" over an untranslated
      // volume. And the loop cannot fix it: there is nothing to retranslate.
      if (noDraft > 0) return { stop: true, reason: "missing-drafts" };
      return { stop: true, reason: "all-pass" };
    }
    // Every FAIL this round is a regression the ratchet just rolled back: the
    // last round's rewrites made the book worse, so stop before paying for
    // another round of the same.
    if (noImprovement > 0 && noImprovement >= failed) return { stop: true, reason: "no-improvement" };
    if (round >= maxRounds) return { stop: true, reason: "round-limit" };
    // FAILs that CAN be fixed are still worth a round even when some other
    // chapter is missing entirely (that one is reported, not silently passed).
    return { stop: false, reason: null };
  }
  if (phase === "after-retranslate") {
    if (retranslated === 0) return { stop: true, reason: "stalled" };
    return { stop: false, reason: null };
  }
  throw new Error(
    `qaLoopDecision: unknown phase "${phase}" (expected "after-verify" or "after-retranslate").`
  );
}


/**
 * The max number of translate-qa rounds (TRANSLATE_QA_MAX_ROUNDS, default
 * 3, minimum 1). One round = one verify batch + one retranslate batch; the
 * loop also stops early when all chapters pass or a round retranslates
 * nothing (see qaLoopDecision).
 *
 * @returns {number}
 */
function qaMaxRounds() {
  const parsed = parseInt(process.env.TRANSLATE_QA_MAX_ROUNDS, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 3;
}

// ─── Part-continuity & concurrency helpers ──────────────────────────────────


/**
 * The median of a list of scores (the middle value of the sorted list; the
 * mean of the two middle values when the count is even).
 *
 * The median is what makes a repeated grade useful: one outlier sample cannot
 * move the verdict, and a third sample at temperature 0 settles a disagreement.
 *
 * @param {number[]} scores
 * @returns {number|null} The median, or null when there is no numeric score.
 */
function medianScore(scores) {
  const nums = (scores || []).filter((s) => typeof s === "number" && Number.isFinite(s));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}


/**
 * Does a verification sidecar entry still describe the chapter's CURRENT draft?
 *
 * A verdict is only meaningful for the exact text it graded: a retranslate
 * (new draftHash) or a changed source (new sourceHash) invalidates it. The
 * comparison is made against the translation-state entry, so a polished chapter
 * keeps the verdict its draft earned.
 *
 * @param {Object} verdictEntry - The sidecar entry for the chapter.
 * @param {Object} stateEntry - The chapter's translation-state entry.
 * @returns {boolean} True when the verdict covers the current draft.
 */
function verdictCoversCurrentDraft(verdictEntry, stateEntry) {
  if (!verdictEntry || !stateEntry) return false;
  return (
    typeof verdictEntry.sourceHash === "string" &&
    verdictEntry.sourceHash === stateEntry.sourceHash &&
    typeof verdictEntry.draftHash === "string" &&
    verdictEntry.draftHash === stateEntry.draftHash
  );
}


/**
 * The line the merged translation.md puts under a chapter that did not pass
 * verification.
 *
 * The published book must carry its own verdict (the merge used to publish a
 * polished chapter that had FAILED verification at 57/100 with nothing on the
 * page saying so). The marker is deliberately visible in the rendered Markdown
 * rather than hidden in a comment: a reader must not have to know the pipeline
 * exists to learn that a chapter is unverified.
 *
 * @param {{score: number|null, pass: boolean|null, reason: string}} verdict
 * @returns {string} The Markdown marker line.
 */
function unverifiedMarker(verdict) {
  const score =
    typeof verdict.score === "number" ? `verification score ${verdict.score}/100` : "no verification score";
  return (
    `> **⚠ UNVERIFIED** — this chapter did not pass translation verification (${score}). ` +
    `Reason: ${verdict.reason}. See this volume's \`translation-verification.md\`.`
  );
}


/**
 * Restore the best-scoring draft for every chapter whose newest draft scored
 * WORSE than the best one already recorded (the ratchet).
 *
 * Without this, a retranslate that makes a chapter worse becomes the published
 * translation: the QA loop rewrote a 75-scoring draft, the new draft scored 50,
 * the round cap ran out, and the worse text shipped. A QA loop may only move a
 * chapter forward.
 *
 * The restore also re-points the verification sidecar at the restored draft
 * (that draft already earned its verdict), so the next verify batch skips it
 * instead of paying to re-grade identical text.
 *
 * @param {string} volumeDir
 * @param {{segments: Array<{id: string, title: string}>}} bundle
 * @returns {Promise<{restored: number, noImprovement: string[]}>} How many drafts were rolled back, and which chapters.
 */
async function applyDraftRatchet(volumeDir, bundle) {
  const statePath = path.join(volumeDir, STATE_FILE);
  const state = await loadTranslationState(statePath);
  const sidecarPath = path.join(volumeDir, VERIFICATION_FILE);
  const sidecar = await loadVerificationSidecar(sidecarPath);
  const restoredIds = [];

  for (const seg of bundle.segments) {
    const entry = state.chapters[seg.id];
    if (!entry) continue;
    const verdict = sidecar.chapters[seg.id];
    // Only judge a verdict that describes the draft we actually have.
    if (!verdictCoversCurrentDraft(verdict, entry)) continue;
    if (typeof entry.bestScore !== "number" || typeof verdict.score !== "number") continue;
    if (entry.bestDraftHash === entry.draftHash) continue; // already the best draft
    if (verdict.score >= entry.bestScore) continue; // not a regression

    const { draftFile, bestFile } = chapterArtifactNames(seg.id);
    const bestPath = path.join(volumeDir, bestFile);
    let bestText;
    try {
      bestText = await fs.readFile(bestPath, "utf8");
    } catch {
      console.warn(
        `  ${seg.id}: the better draft (score ${entry.bestScore}) is not on disk (${bestFile}) — ` +
          `keeping the current draft (score ${verdict.score}).`
      );
      continue;
    }
    if (sha256(bestText) !== entry.bestDraftHash) {
      console.warn(
        `  ${seg.id}: ${bestFile} no longer matches its recorded hash — keeping the current draft.`
      );
      continue;
    }

    await fs.writeFile(path.join(volumeDir, draftFile), bestText, "utf8");
    entry.draftHash = entry.bestDraftHash;
    entry.qaFailed = false;
    entry.noImprovement = true;
    // A restored draft invalidates any polish built on the rejected one.
    entry.polishedDraftHash = null;
    entry.polishScore = null;
    entry.polishFindings = null;
    entry.polishFindingsHash = null;
    // Re-point the sidecar at the restored draft's own verdict, so the next
    // verify batch treats it as covered (a cheap skip, not a re-grade).
    if (entry.bestVerdict) {
      sidecar.chapters[seg.id] = {
        ...entry.bestVerdict,
        sourceHash: entry.sourceHash,
        draftHash: entry.bestDraftHash,
        attempts: verdict.attempts || 1,
      };
    }
    restoredIds.push(seg.id);
    console.log(
      `  ${seg.id}: ratchet — the new draft scored ${verdict.score}/100 against the best draft's ` +
        `${entry.bestScore}/100, so the better draft was restored (${bestFile}).`
    );
  }

  if (restoredIds.length > 0) {
    await saveTranslationState(statePath, state);
    await saveVerificationSidecar(sidecarPath, sidecar);
  }
  return { restored: restoredIds.length, noImprovement: restoredIds };
}


/**
 * Record a fresh verification verdict as the chapter's best draft when it beats
 * what we already had (the ratchet's other half, run by the verify task).
 *
 * @param {string} volumeDir
 * @param {string} segmentId
 * @param {{score: number|null, pass: boolean, findings: string, sourceHash: string, draftHash: string}} verdict
 * @returns {Promise<boolean>} True when this became the new best draft.
 */
async function recordBestDraft(volumeDir, segmentId, verdict) {
  const statePath = path.join(volumeDir, STATE_FILE);
  const state = await loadTranslationState(statePath);
  const entry = state.chapters[segmentId];
  if (!entry) return false;
  const current = typeof verdict.score === "number" ? verdict.score : -1;
  if (typeof entry.bestScore === "number" && entry.bestScore >= current) return false;

  const { draftFile, bestFile } = chapterArtifactNames(segmentId);
  let draftText;
  try {
    draftText = await fs.readFile(path.join(volumeDir, draftFile), "utf8");
  } catch {
    return false;
  }
  await fs.copyFile(path.join(volumeDir, draftFile), path.join(volumeDir, bestFile));
  entry.bestScore = current;
  entry.bestDraftHash = sha256(draftText);
  entry.bestVerdict = {
    score: verdict.score,
    pass: verdict.pass,
    findings: verdict.findings,
    verifiedAt: new Date().toISOString(),
  };
  await saveTranslationState(statePath, state);
  return true;
}


module.exports = {
  worthRetranslating,
  qaLoopDecision,
  qaMaxRounds,
  medianScore,
  verdictCoversCurrentDraft,
  unverifiedMarker,
  applyDraftRatchet,
  recordBestDraft,
};

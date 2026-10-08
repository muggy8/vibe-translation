/**
 * translate-qa.js — Logic for the "translate-qa" gulp task: the batched
 * translation QA loop.
 *
 * The pre-production pipeline loops "translate → validate → apply
 * validation → re-validate …" until the validator is happy with the
 * accuracy. Locally the Index-Translate (translate) and Qwen (verify) containers
 * share one port, so only one can serve at a time and switching between
 * them is expensive — the loop therefore runs in BATCHES, not per chapter:
 * each round is two whole single-model task runs, never interleaved.
 *
 * Task: translate-qa
 *   For round 1..TRANSLATE_QA_MAX_ROUNDS (default 3):
 *     1. verify-translate batch (Qwen): scores every chapter whose draft is
 *        new; drafts unchanged since the last verification are idempotent
 *        skips (the sidecar is keyed on source + draft hashes), so round
 *        N+1 only re-scores what round N retranslated.
 *     2. retranslate batch (Index-Translate): retranslates every FAIL chapter with
 *        the verification findings injected as a 【硬性要求】 "fix these problems"
 *        constraint (this is the "apply validation" half — the bad draft is
 *        deliberately NOT fed back).
 *
 *   The loop stops when (checked in this order):
 *     - missing-drafts: some chapter has no draft at all — the loop cannot fix
 *                    an absent chapter, so it says so instead of burning rounds.
 *     - all-pass:    the verify batch reports zero FAIL chapters — the
 *                    validator is happy (every score >= PASSING_SCORE).
 *     - no-improvement: the draft ratchet had to roll back EVERY failing
 *                    chapter to a better earlier draft (the last round's
 *                    rewrites made the translation worse).
 *     - round-limit: TRANSLATE_QA_MAX_ROUNDS rounds ran; still-FAIL
 *                    chapters keep their latest draft (polish still runs on
 *                    them); re-run with --force for another attempt.
 *     - stalled:     the retranslate batch retranslated zero chapters —
 *                    every FAIL chapter already carries exactly those
 *                    findings (the retranslate task's findingsHash
 *                    skip-check fired), so nothing new can be applied.
 *
 *   The draft ratchet runs after every verify batch: a chapter whose newest
 *   draft scored worse than the best draft already recorded is restored from
 *   `translation-<id>.best.md`, so a QA loop can never end with a chapter less
 *   good than it started with.
 *
 *   Every exit writes the series-level `translation-report.md` (deterministic,
 *   no AI) so the run ends with one document that says what is verified and
 *   what is not.
 *
 *   Model switching stays in the hooks: each half-round is invoked through
 *   withHooks(), so the pre-verify-translate / pre-retranslate hooks fire
 *   at every batch boundary (on local setups these are the model-switch
 *   hooks; they are idempotent no-ops when the right container already
 *   serves the port). The pre-/post-translate-qa hooks wrap the WHOLE loop
 *   and must not switch models.
 *
 *   VERIFY_TRANSLATE_ENABLED=false makes this task a no-op (the pipeline
 *   degrades to translate → polish). --dry-run previews exactly one round
 *   (verify + retranslate prompt dumps; no AI calls, no hooks). --force and
 *   --volume NN are passed through to both sub-tasks.
 *
 * Usage:
 *   npx gulp translate-qa              # run the loop (all volumes)
 *   npx gulp translate-qa --dry-run    # dump one round of prompts only
 *   npx gulp translate-qa --force      # re-verify/retranslate even if covered
 *   npx gulp translate-qa --volume 01  # single volume
 */

// .env, then the one setting that has a default — both before any task module is
// required, because several of them read these values at require time (gotcha 79).
require("./configs/env-defaults").bootstrapEnv();
const path = require("path");
const { verifyTranslate } = require("./verify-translate");
const { retranslate } = require("./retranslate");
const { withHooks } = require("./utils/hooks");
const { qaLoopDecision, qaMaxRounds, applyDraftRatchet } = require("./utils/translate");
const { validateRequiredEnv } = require("./configs/shared");
const { readRunArgs, selectVolumesFromManifest } = require("./utils/series-run");
const { getTranslationTarget } = require("./get-translation-target");
const { resolveSourceBundle } = require("./utils/source");
const { writeTranslationReport } = require("./utils/translation-report");

/**
 * Roll back every chapter whose newest draft scored WORSE than the best draft
 * already recorded, across all volumes in the run.
 *
 * Runs right after the verify batch (that is when a new draft's score is
 * known) and before the retranslate batch (so a correction is applied to the
 * best text we have, not to the regression).
 *
 * @param {{seriesDir: string, manifest: Object, dryRun: boolean, volumeArg?: string|null}} p
 * @returns {Promise<{restored: number, volumes: number}>}
 */
async function runDraftRatchet({ seriesDir, manifest, dryRun, volumeArg = null }) {
  if (dryRun) return { restored: 0, volumes: 0 };
  const folders = selectVolumesFromManifest({ manifest, volumeArg, log: () => {} });
  let restored = 0;
  for (const folder of folders) {
    const volume = manifest.volumes.find((v) => v.folder === folder);
    if (!volume) continue;
    const volumeDir = path.join(seriesDir, folder);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force: false });
      const res = await applyDraftRatchet(volumeDir, bundle);
      restored += res.restored;
    } catch (err) {
      // The ratchet is a safety net; a volume whose source cannot be opened is
      // reported by the tasks that own it, not here.
      console.warn(`[translate-qa] ratchet skipped for ${folder}: ${err.message}`);
    }
  }
  return { restored, volumes: folders.length };
}

/**
 * Say why the loop stopped after a verify batch, in the words the account owner acts on.
 *
 * The four stop reasons are four different situations, and the loop's own decision function already
 * knows which one it is; what belongs here is the sentence that tells a human what to do next.
 *
 * @param {{reason: string, round: number, maxRounds: number, failed: number, noDraft: number}} p
 * @returns {void}
 */
function reportVerifyStop({ reason, round, maxRounds, failed, noDraft }) {
  if (reason === "all-pass") {
    console.log(
      `[translate-qa] Validator satisfied — every chapter passes verification (round ${round}).`
    );
    return;
  }
  if (reason === "no-improvement") {
    console.warn(
      `[translate-qa] Stopped — all ${failed} failing chapter(s) scored worse than the draft the ` +
        `loop already had, so they were rolled back. Re-running would spend tokens to make the ` +
        `translation worse; the better drafts are kept.`
    );
    return;
  }
  if (reason === "missing-drafts") {
    console.warn(
      `[translate-qa] Stopped — ${noDraft} chapter(s) have no draft. Run the translate task first.`
    );
    return;
  }
  console.warn(
    `[translate-qa] Round limit reached (${maxRounds}) with ${failed} chapter(s) still FAIL — ` +
      `they keep their latest draft (polish still runs on them). Re-run with --force for ` +
      `another attempt.`
  );
}

// ─── One round, in pieces ────────────────────────────────────────────────────

/**
 * The verify half of a round: the batch, then what it found in one line.
 *
 * @param {Function} verifyTask - `verifyTranslate` behind its hooks.
 * @param {number} round - One-based round number.
 * @param {number} maxRounds - The round limit, for the log line.
 * @returns {Promise<{verified: number, passed: number, failed: number, skipped: number, noDraft: number, disputes: number}>}
 *   The batch's counters, as `verify-translate` reported them.
 */
async function runVerifyBatch(verifyTask, round, maxRounds) {
  console.log(`[translate-qa] round ${round}/${maxRounds} — verification batch…`);
  const v = await verifyTask();
  console.log(
    `[translate-qa] round ${round}: ${v.verified} verified, ${v.passed} PASS, ${v.failed} FAIL, ` +
      `${v.skipped} skipped (up to date), ${v.noDraft} without draft.` +
      (v.disputes > 0
        ? ` ${v.disputes} glossary dispute(s) open — the retranslate pass must keep those renderings; ` +
          `run the glossary task to settle them.`
        : "")
  );
  return v;
}

/**
 * What one round did, as the run ledger records it.
 *
 * `retranslated` starts null so a round that stopped after the verify batch is distinguishable from a
 * round that retranslated nothing — the two mean different things to whoever reads the ledger next.
 *
 * @param {number} round - One-based round number.
 * @param {Object} v - The verify batch's counters.
 * @returns {Object} The round record.
 */
function roundRecord(round, v) {
  return {
    round,
    verified: v.verified,
    passed: v.passed,
    failed: v.failed,
    skipped: v.skipped,
    noDraft: v.noDraft,
    ...(v.disputes > 0 ? { disputes: v.disputes } : {}),
    retranslated: null,
  };
}

/**
 * The retranslate half of a round.
 *
 * @param {Function} retranslateTask - `retranslate` behind its hooks.
 * @param {number} round - One-based round number.
 * @param {number} failed - How many chapters the verify batch said need work.
 * @returns {Promise<{retranslated: number}>} What the batch actually applied.
 */
async function runRetranslateBatch(retranslateTask, round, failed) {
  console.log(`[translate-qa] round ${round} — retranslate batch (${failed} FAIL chapter(s))…`);
  return retranslateTask();
}

/**
 * End the loop the way a stop-decision ends it: write the translation report, then return.
 *
 * Every stop path writes the report. A loop that exits without it leaves the series with drafts whose
 * state nothing describes, and the next step reads the report, not the drafts.
 *
 * @param {{seriesDir: string, manifest: Object, dryRun: boolean, rounds: Object[], reason: string}} opts
 * @returns {Promise<{rounds: Object[], reason: string}>} The value the task returns.
 */
async function finishWithReport({ seriesDir, manifest, dryRun, rounds, reason }) {
  await writeTranslationReport({ seriesDir, manifest, volumes: null, dryRun });
  return { rounds, reason };
}

/**
 * `--dry-run`: exactly one full round of prompt dumps, no model call.
 *
 * The sub-tasks make no AI calls in a dry run, and the hook runner skips hooks under `--dry-run`.
 *
 * @param {Function} verifyTask - `verifyTranslate` behind its hooks.
 * @param {Function} retranslateTask - `retranslate` behind its hooks.
 * @returns {Promise<{rounds: Object[], reason: string}>}
 */
async function previewOneRound(verifyTask, retranslateTask) {
  console.log("[translate-qa] --dry-run: previewing one round (verify batch + retranslate batch).");
  await verifyTask();
  await retranslateTask();
  console.log("[translate-qa] --dry-run preview complete.");
  return { rounds: [], reason: "dry-run" };
}

// ─── Task entry ─────────────────────────────────────────────────────────────

/**
 * Run the translate-qa task (all volumes, or --volume NN).
 *
 * @returns {Promise<{rounds: Array<{round: number, verified: number, passed: number, failed: number, skipped: number, noDraft: number, retranslated: number|null}>, reason: string}>}
 *   `reason` is one of "disabled", "dry-run", "all-pass", "round-limit",
 *   "stalled", "missing-drafts"; `rounds` records each completed round's counters (the
 *   retranslate half of a round is null when the loop stopped after the
 *   verify batch).
 */
async function translateQa() {
  const { dryRun, volumeArg } = readRunArgs();

  if (process.env.VERIFY_TRANSLATE_ENABLED === "false") {
    console.log(
      "[translate-qa] VERIFY_TRANSLATE_ENABLED=false — the verification chain is disabled. Nothing to do."
    );
    return { rounds: [], reason: "disabled" };
  }
  if (!process.env.SERIES_LOCATION) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  validateRequiredEnv({ dryRun });

  // Each half-round is invoked through withHooks() so its pre-/post- hooks
  // (on local setups: the model-switch hooks) fire at every batch boundary.
  const verifyTask = withHooks("verify-translate", verifyTranslate);
  const retranslateTask = withHooks("retranslate", retranslate);

  if (dryRun) return previewOneRound(verifyTask, retranslateTask);

  const maxRounds = qaMaxRounds();
  const seriesDir = process.env.SERIES_LOCATION;
  // The plan of record (already written by the intake step — this only reads it).
  const manifest = await getTranslationTarget({ dryRun: false });
  console.log(
    `[translate-qa] QA loop: up to ${maxRounds} round(s); each round = verify batch (verify model) + ` +
      `retranslate batch (translate model). Stops when every chapter passes, when a round ` +
      `retranslates nothing new, when every failing chapter scored worse than the draft we already ` +
      `had, or when the round limit is hit.`
  );

  const rounds = [];
  for (let round = 1; round <= maxRounds; round++) {
    const v = await runVerifyBatch(verifyTask, round, maxRounds);
    const roundRec = roundRecord(round, v);
    rounds.push(roundRec);

    // Nothing to QA at all: no chapter has a draft. Re-running verify/retranslate
    // over an untranslated volume would burn a model call per chapter and change
    // nothing — say what is missing and stop.
    if (v.verified === 0 && v.skipped === 0 && v.noDraft > 0) {
      console.warn(
        `[translate-qa] ${v.noDraft} chapter(s) have no draft — the loop has nothing to verify ` +
          `or retranslate. Run the translate task first.`
      );
      return { rounds, reason: "missing-drafts" };
    }

    // The draft ratchet: a retranslate that scored WORSE than the draft it
    // replaced is rolled back, so the loop can never end with a chapter less
    // good than it started with.
    const ratchet = await runDraftRatchet({ seriesDir, manifest, dryRun, volumeArg });
    if (ratchet.restored > 0) {
      console.log(
        `[translate-qa] round ${round}: draft ratchet restored ${ratchet.restored} chapter(s) to their ` +
          `best-scoring draft.`
      );
      roundRec.ratchetRestored = ratchet.restored;
    }

    const afterVerify = qaLoopDecision({
      phase: "after-verify",
      round,
      maxRounds,
      failed: v.failed,
      noDraft: v.noDraft,
      noImprovement: ratchet.restored,
    });
    if (afterVerify.stop) {
      reportVerifyStop({
        reason: afterVerify.reason,
        round,
        maxRounds,
        failed: v.failed,
        noDraft: v.noDraft,
      });
      return await finishWithReport({ seriesDir, manifest, dryRun, rounds, reason: afterVerify.reason });
    }

    const r = await runRetranslateBatch(retranslateTask, round, v.failed);
    roundRec.retranslated = r.retranslated;
    const afterRetranslate = qaLoopDecision({ phase: "after-retranslate", retranslated: r.retranslated });
    if (afterRetranslate.stop) {
      console.log(
        `[translate-qa] Stalled — the retranslate batch applied nothing new (every FAIL chapter ` +
          `already carries exactly those findings). Keeping the latest drafts; re-run with --force ` +
          `to retry.`
      );
      return await finishWithReport({ seriesDir, manifest, dryRun, rounds, reason: "stalled" });
    }
  }

  // Defensive: the loop always exits via a stop-decision above.
  return { rounds, reason: "round-limit" };
}

module.exports = {
  translateQa,
};
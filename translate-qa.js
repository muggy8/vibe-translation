/**
 * translate-qa.js — Logic for the "translate-qa" gulp task: the batched
 * translation QA loop.
 *
 * The pre-production pipeline loops "translate → validate → apply
 * validation → re-validate …" until the validator is happy with the
 * accuracy. Locally the Hy-MT2 (translate) and Qwen (verify) containers
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
 *     2. retranslate batch (Hy-MT2): retranslates every FAIL chapter with
 *        the verification findings injected as a "fix these problems" task
 *        (this is the "apply validation" half — the bad draft is
 *        deliberately NOT fed back).
 *
 *   The loop stops when (checked in this order):
 *     - all-pass:    the verify batch reports zero FAIL chapters — the
 *                    validator is happy (every score >= VERIFY_PASSING_SCORE).
 *     - round-limit: TRANSLATE_QA_MAX_ROUNDS rounds ran; still-FAIL
 *                    chapters keep their latest draft (polish still runs on
 *                    them); re-run with --force for another attempt.
 *     - stalled:     the retranslate batch retranslated zero chapters —
 *                    every FAIL chapter already carries exactly those
 *                    findings (the retranslate task's findingsHash
 *                    skip-check fired), so nothing new can be applied.
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

require("dotenv").config();
const { verifyTranslate } = require("./verify-translate");
const { retranslate } = require("./retranslate");
const { withHooks } = require("./utils/hooks");
const { qaLoopDecision, qaMaxRounds } = require("./utils/translate");
const { validateRequiredEnv } = require("./configs/shared");

// ─── Task entry ─────────────────────────────────────────────────────────────

/**
 * Run the translate-qa task (all volumes, or --volume NN).
 *
 * @returns {Promise<{rounds: Array<{round: number, verified: number, passed: number, failed: number, skipped: number, noDraft: number, retranslated: number|null}>, reason: string}>}
 *   `reason` is one of "disabled", "dry-run", "all-pass", "round-limit",
 *   "stalled"; `rounds` records each completed round's counters (the
 *   retranslate half of a round is null when the loop stopped after the
 *   verify batch).
 */
async function translateQa() {
  const dryRun = process.argv.includes("--dry-run");

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

  if (dryRun) {
    // Preview exactly one full round: verify prompt dumps + retranslate
    // prompt dumps (the sub-tasks make no AI calls; the hook runner skips
    // hooks under --dry-run).
    console.log(
      "[translate-qa] --dry-run: previewing one round (verify batch + retranslate batch)."
    );
    await verifyTask();
    await retranslateTask();
    console.log("[translate-qa] --dry-run preview complete.");
    return { rounds: [], reason: "dry-run" };
  }

  const maxRounds = qaMaxRounds();
  console.log(
    `[translate-qa] QA loop: up to ${maxRounds} round(s); each round = verify batch (verify model) + ` +
      `retranslate batch (translate model). Stops when every chapter passes, when a round ` +
      `retranslates nothing new, or when the round limit is hit.`
  );

  const rounds = [];
  for (let round = 1; round <= maxRounds; round++) {
    console.log(`[translate-qa] round ${round}/${maxRounds} — verification batch…`);
    const v = await verifyTask();
    console.log(
      `[translate-qa] round ${round}: ${v.verified} verified, ${v.passed} PASS, ${v.failed} FAIL, ` +
        `${v.skipped} skipped (up to date), ${v.noDraft} without draft.`
    );
    const roundRec = {
      round,
      verified: v.verified,
      passed: v.passed,
      failed: v.failed,
      skipped: v.skipped,
      noDraft: v.noDraft,
      retranslated: null,
    };
    rounds.push(roundRec);

    const afterVerify = qaLoopDecision({ phase: "after-verify", round, maxRounds, failed: v.failed });
    if (afterVerify.stop) {
      if (afterVerify.reason === "all-pass") {
        if (v.passed === 0 && v.noDraft > 0) {
          console.warn(
            `[translate-qa] No chapter drafts were verified (${v.noDraft} chapter(s) without a ` +
              `draft) — run the translate task first.`
          );
        } else {
          console.log(
            `[translate-qa] Validator satisfied — every chapter with a draft passes verification ` +
              `(round ${round}).`
          );
        }
      } else {
        console.warn(
          `[translate-qa] Round limit reached (${maxRounds}) with ${v.failed} chapter(s) still FAIL — ` +
            `they keep their latest draft (polish still runs on them). Re-run with --force for ` +
            `another attempt.`
        );
      }
      return { rounds, reason: afterVerify.reason };
    }

    console.log(`[translate-qa] round ${round} — retranslate batch (${v.failed} FAIL chapter(s))…`);
    const r = await retranslateTask();
    roundRec.retranslated = r.retranslated;
    const afterRetranslate = qaLoopDecision({ phase: "after-retranslate", retranslated: r.retranslated });
    if (afterRetranslate.stop) {
      console.log(
        `[translate-qa] Stalled — the retranslate batch applied nothing new (every FAIL chapter ` +
          `already carries exactly those findings). Keeping the latest drafts; re-run with --force ` +
          `to retry.`
      );
      return { rounds, reason: "stalled" };
    }
  }

  // Defensive: the loop always exits via a stop-decision above.
  return { rounds, reason: "round-limit" };
}

module.exports = {
  translateQa,
};
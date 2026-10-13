/**
 * The idempotency skip-check, shared by every stage that can be re-run over a series.
 *
 * The rule: a volume whose outputs already exist AND whose persisted acceptance state still
 * passes is not rebuilt. No model call is spent re-grading work a previous run already accepted —
 * the decision is recomputed from the rolling-state file on disk.
 *
 * Four things can cancel the skip, and they are the reason this is one function rather than five
 * copies that each remembered two of them:
 *   - `--force` — the account owner asked for a regeneration;
 *   - the cumulative cascade — an earlier volume was rebuilt, so this one's base is stale;
 *   - a changed source file — the artifacts on disk were written from a different book;
 *   - an acceptance state that is missing, corrupt, or did not pass.
 *
 * Fail-open: a missing or corrupt state file means "not skipped". A skip-check that silently
 * regenerates is annoying; one that silently skips is how a broken volume survives a re-run.
 *
 * **The decision is split from the printing, and that split is what the freeze gate needs.**
 * `skipDecisionFor` answers "would this run rewrite this volume, and why?" and returns the reason
 * (`force` / `cascade` / `missing-output` / `no-acceptance-state` / `failed-grade` /
 * `source-changed`). `volumeAlreadyAccepted` is that decision plus the two lines it prints.
 * `utils/prereqs/freeze.js` reads the SAME decision rather than re-deriving it, because a second
 * copy of "would this be regenerated" is a pair that drifts — and the freeze gate's whole question
 * ("may this step rewrite what a finished translation consumed?") is unanswerable without it.
 * `volumeAlreadyAccepted` then asks that gate before it lets the volume be regenerated, which is
 * why the four cumulative stages get the freeze for free instead of each remembering to add it.
 *
 * Part of the series-run layer (utils/series-run.js).
 */

const {
  computeRollingAverage,
  isAcceptedState,
  isSourceStale,
  loadRollingState,
} = require("../../configs/shared");
const { fileExists } = require("../fs");
const { assertDoorAllowed, freezeDoorRow } = require("../prereqs/freeze");
const { readRunArgs } = require("./args");

/**
 * Why one volume would be regenerated, in the words the freeze gate prints.
 *
 * @typedef {"force"|"cascade"|"missing-output"|"no-acceptance-state"|"failed-grade"|"source-changed"} SkipCancellation
 */

/**
 * Decide whether this volume would be regenerated, and name the thing that cancels the skip.
 *
 * Pure read of the disk plus the flags the caller already holds. It writes nothing and makes no
 * model call, and it is the ONLY place these four conditions are computed.
 *
 * @param {{
 *   installmentNumber: string,
 *   outputFiles: string[],
 *   validationOutputFile: string,
 *   bundle: { sourceFingerprint?: string },
 *   force: boolean,
 *   regeneratedAny: boolean,
 *   cascadeFrom?: string|null,
 * }} opts - `outputFiles` are the artifacts this stage writes for the volume; every one must exist.
 *   `cascadeFrom` is the volume that set the cascade, so the refusal can name it rather than say
 *   "an earlier volume".
 * @returns {Promise<{
 *   skip: boolean,
 *   cancelledBy: SkipCancellation|null,
 *   detail: string|null,
 *   state: { results: number[], sourceFingerprint?: string }|null,
 * }>} `detail` is the extra fact the wording needs — the missing file name, or the volume the
 *   cascade came from. `state` is the acceptance window, for the caller that prints its average.
 */
async function skipDecisionFor({
  installmentNumber,
  outputFiles,
  validationOutputFile,
  bundle,
  force,
  regeneratedAny,
  cascadeFrom = null,
}) {
  if (force) return { skip: false, cancelledBy: "force", detail: null, state: null };
  if (regeneratedAny) {
    return { skip: false, cancelledBy: "cascade", detail: cascadeFrom ? String(cascadeFrom) : null, state: null };
  }
  for (const file of outputFiles) {
    if (!(await fileExists(file))) {
      return { skip: false, cancelledBy: "missing-output", detail: String(file).split("/").pop(), state: null };
    }
  }

  const state = await loadRollingState(validationOutputFile.replace(".md", "-rolling-state.json"));
  if (!state) return { skip: false, cancelledBy: "no-acceptance-state", detail: null, state: null }; // missing or corrupt → regenerate (fail-open)

  if (!isAcceptedState(state)) {
    return { skip: false, cancelledBy: "failed-grade", detail: (state.results || []).join(", "), state };
  }

  if (isSourceStale(state, bundle)) {
    return { skip: false, cancelledBy: "source-changed", detail: null, state };
  }

  return { skip: true, cancelledBy: null, detail: null, state };
}

/**
 * Decide whether this volume can be skipped — and, when it cannot, ask whether the run is allowed to
 * rewrite it at all.
 *
 * The second half is the freeze gate (`utils/prereqs/freeze.js`): a volume whose translation is
 * already published is not this stage's to rebuild. It throws a STRUCTURAL error, so
 * `ON_VOLUME_ERROR=skip` cannot walk past it and `ON_TASK_ERROR=continue` cannot either. A volume
 * whose skip STANDS is never asked the question, which is what keeps a resumed run sitting in the
 * translation stage able to run `extract`, `discover` and every idempotent step for free — the
 * offline pipeline loop's zero-call second pass is the test that pins that.
 *
 * @param {{
 *   installmentNumber: string,
 *   outputFiles: string[],
 *   validationOutputFile: string,
 *   bundle: { sourceFingerprint?: string },
 *   force: boolean,
 *   regeneratedAny: boolean,
 *   artifactLabel: string,
 *   step?: string,
 *   seriesDir?: string,
 *   folder?: string,
 *   cascadeFrom?: string|null,
 *   dryRun?: boolean,
 * }} opts - `step` / `seriesDir` / `folder` are what the freeze gate needs; without `step` the gate
 *   is not asked, exactly as `utils/postmortem/halt.js` requires a stage to name itself before it is
 *   gated. `dryRun` defaults to this process's own `--dry-run`, which is what a stage gets for free and
 *   what a test overrides instead of rewriting its own command line.
 * @returns {Promise<boolean>} True when the volume is already done and nothing invalidated it.
 * @throws {Error} A structural refusal when the volume is frozen by a published translation.
 */
async function volumeAlreadyAccepted({
  installmentNumber,
  outputFiles,
  validationOutputFile,
  bundle,
  force,
  regeneratedAny,
  artifactLabel,
  step = null,
  seriesDir = null,
  folder = null,
  cascadeFrom = null,
  dryRun = null,
}) {
  const decision = await skipDecisionFor({
    installmentNumber,
    outputFiles,
    validationOutputFile,
    bundle,
    force,
    regeneratedAny,
    cascadeFrom,
  });

  if (decision.skip) {
    const avg = computeRollingAverage(decision.state.results);
    console.log(
      `Volume ${installmentNumber}: rolling-state (${decision.state.results.length} checks, ` +
        `avg ${avg.toFixed(1)}/100) meets the criterion. Skipping.`
    );
    console.log(`Volume ${installmentNumber}: ${artifactLabel} already exists and passed.`);
    return true;
  }

  // The skip is cancelled: this stage is about to rewrite this volume. Ask whether it may.
  if (step && seriesDir && folder && freezeDoorRow(step)) {
    await assertDoorAllowed({
      door: step,
      seriesDir,
      cancelledBy: decision.cancelledBy,
      detail: decision.detail,
      volumes: [{ folder, installmentNumber }],
      dryRun: dryRun === null || dryRun === undefined ? readRunArgs().dryRun : dryRun,
    });
  }

  if (decision.cancelledBy === "source-changed") {
    console.log(
      `Volume ${installmentNumber}: the source file changed since the last run ` +
        `(fingerprint mismatch) — regenerating instead of skipping.`
    );
  }
  return false;
}

module.exports = { volumeAlreadyAccepted, skipDecisionFor };

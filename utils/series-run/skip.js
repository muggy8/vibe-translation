/**
 * The idempotency skip-check, shared by every stage that can be re-run over a series.
 *
 * The rule: a volume whose outputs already exist AND whose persisted acceptance state still
 * passes is not rebuilt. No model call is spent re-grading work a previous run already accepted —
 * the decision is recomputed from the rolling-state file on disk.
 *
 * Three things can cancel the skip, and they are the reason this is one function rather than five
 * copies that each remembered two of them:
 *   - `--force` — the account owner asked for a regeneration;
 *   - the cumulative cascade — an earlier volume was rebuilt, so this one's base is stale;
 *   - a changed source file — the artifacts on disk were written from a different book.
 *
 * Fail-open: a missing or corrupt state file means "not skipped". A skip-check that silently
 * regenerates is annoying; one that silently skips is how a broken volume survives a re-run.
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

/**
 * Decide whether this volume can be skipped.
 *
 * @param {{
 *   installmentNumber: string,
 *   outputFiles: string[],
 *   validationOutputFile: string,
 *   bundle: { sourceFingerprint?: string },
 *   force: boolean,
 *   regeneratedAny: boolean,
 *   artifactLabel: string,
 * }} opts - `outputFiles` are the artifacts this stage writes for the volume; every one must exist.
 * @returns {Promise<boolean>} True when the volume is already done and nothing invalidated it.
 */
async function volumeAlreadyAccepted({
  installmentNumber,
  outputFiles,
  validationOutputFile,
  bundle,
  force,
  regeneratedAny,
  artifactLabel,
}) {
  if (force || regeneratedAny) return false;
  for (const file of outputFiles) {
    if (!(await fileExists(file))) return false;
  }

  const state = await loadRollingState(validationOutputFile.replace(".md", "-rolling-state.json"));
  if (!state) return false; // missing or corrupt → regenerate (fail-open)

  if (!isAcceptedState(state)) return false;

  if (isSourceStale(state, bundle)) {
    console.log(
      `Volume ${installmentNumber}: the source file changed since the last run ` +
        `(fingerprint mismatch) — regenerating instead of skipping.`
    );
    return false;
  }

  const avg = computeRollingAverage(state.results);
  console.log(
    `Volume ${installmentNumber}: rolling-state (${state.results.length} checks, ` +
      `avg ${avg.toFixed(1)}/100) meets the criterion. Skipping.`
  );
  console.log(`Volume ${installmentNumber}: ${artifactLabel} already exists and passed.`);
  return true;
}

module.exports = { volumeAlreadyAccepted };

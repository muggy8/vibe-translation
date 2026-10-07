/**
 * utils/qa-loop/fallback.js — the one repair a whole-installment attempt earns:
 * retry the volume chapter by chapter, once.
 *
 * Part of the utils/qa-loop.js layer (split out of the original single file).
 */

const { isTooBigForOnePassError, isStructuralError } = require("../../configs/shared");

/**
 * Run one volume's processing pass, and if a WHOLE-installment attempt fails in
 * the one way that switching to chapter-by-chapter actually fixes, wipe the
 * attempt and retry the volume in the fallback mode — once.
 *
 * The narrow trigger is the whole point (see tooBigForOnePassError in
 * configs/shared.js): a request the server refused for being too large, or a turn
 * that hit the output cap while writing a file, are size failures, and processing
 * the same volume chapter by chapter is a genuine repair. A hang, a malformed
 * tool call, a dead container, a missing previous artifact, or a bad acceptance
 * score are not, and falling back on them costs the whole volume again to fix
 * something chunking cannot fix — or, in the acceptance-score case, makes which
 * mode ran irreproducible between runs.
 *
 * Exactly one fallback attempt. A second failure is reported, not retried.
 *
 * @param {{
 *   run: () => Promise<void>,
 *   ctx: {chunked: boolean},
 *   volumeDir: string,
 *   attemptFiles: string[],
 *   attemptGlob?: RegExp,
 *   label: string,
 *   enabled?: boolean,
 * }} p - `run` is the task's own processing pass (it reads ctx.chunked); `attemptFiles` are the files that pass writes, which get removed before the fallback.
 * @returns {Promise<{fellBack: boolean, error?: Error}>}
 * @throws {Error} Re-throws anything the fallback does not apply to, or the fallback attempt's own failure.
 */
async function runVolumeWithModeFallback({
  run,
  ctx,
  volumeDir,
  attemptFiles,
  attemptGlob,
  label,
  enabled = true,
}) {
  try {
    await run();
    return { fellBack: false };
  } catch (err) {
    const applies =
      enabled &&
      ctx &&
      ctx.chunked === false &&
      isTooBigForOnePassError(err) &&
      !isStructuralError(err);
    if (!applies) throw err;

    const { wipeAttemptOutputs } = require("../fs");
    const removed = await wipeAttemptOutputs(volumeDir, attemptFiles, { glob: attemptGlob });
    console.warn(
      `\n${label}: the whole-installment pass did not fit in one attempt — ${err.message}\n` +
        `${label}: falling back to chapter-by-chapter for this volume (once).` +
        (removed.length
          ? ` Removed the partial attempt's output: ${removed.join(", ")}.`
          : " The attempt had written nothing yet.") +
        `\n${label}: a whole-mode failure is worth reading — the size check said this volume fitted, so either ` +
        `the estimate is off for this model or the reference material outgrew the allowance. ` +
        `Lower SOURCE_CHUNK_SAFETY_FRACTION, or run with --chunked to skip the attempt next time.`
    );

    ctx.chunked = true;
    ctx.modeFallback = true;
    try {
      await run();
      console.log(`${label}: the chapter-by-chapter pass completed after the fallback.`);
      return { fellBack: true };
    } catch (retryErr) {
      throw new Error(
        `${label}: the whole-installment pass did not fit (${err.message}) and the chapter-by-chapter ` +
          `fallback also failed (${retryErr.message}). Both attempts are recorded; check ` +
          `.logs/ for the two attempts.`
      );
    }
  }
}

module.exports = { runVolumeWithModeFallback };

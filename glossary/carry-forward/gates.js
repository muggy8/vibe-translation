/**
 * glossary/carry-forward/gates.js — the moment a loss is found, and what happens next.
 *
 * A real loss fails the volume and moves the damaged file to glossary.md.rejected so the next
 * volume cannot read it — which is what makes the ON_MISSING_PREVIOUS cascade fire, because a
 * present-but-short artifact is the case that policy cannot otherwise see.
 * 
 * The guard is on by default and has no env knob that makes a damaged glossary acceptable;
 * GLOSSARY_CARRY_FORWARD_GUARD=false exists for the operator who wants to measure the diff
 * without the gate, not for the run that wants the loss to pass (gotcha 70).
 */

const fs = require("fs").promises;
const path = require("path");

const { ON_MISSING_PREVIOUS, readBoolEnv } = require("../../configs/shared");
const { compareGlossaryCarryForward } = require("./diff");

/** @typedef {import("../../../types").GlossaryVolumeCtx} GlossaryVolumeCtx */

/**
 * The carry-forward gate: after a glossary pass, check that this volume's
 * glossary still holds every term the previous volume's held.
 *
 * A loss here is not a quality question — it is the cumulative invariant
 * breaking, and it is invisible to every other check in the stage (see
 * compareGlossaryCarryForward). It fails the VOLUME, not the run: with
 * ON_VOLUME_ERROR=skip the series continues and the volume is named in the
 * task's end-of-run failure summary.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {string} [stageLabel] - Which pass produced the glossary (for the message).
 * @returns {Promise<void>}
 * @throws {Error} When terms disappeared (unless the guard is disabled with
 *   GLOSSARY_CARRY_FORWARD_GUARD=false).
 */
async function assertGlossaryCarryForward(ctx, stageLabel = "the amend pass") {
  const { values, isFirst, previousGlossaryFile } = ctx;
  if (isFirst || !previousGlossaryFile) return;

  let previousText;
  try {
    previousText = await fs.readFile(previousGlossaryFile, "utf8");
  } catch (err) {
    // A missing previous glossary is already handled by the volume loop's
    // ON_MISSING_PREVIOUS policy; the guard must not mask it with a different
    // message.
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: carry-forward check skipped (${err.message}).`
    );
    return;
  }
  await guardCarryForwardAgainst(ctx, previousText, stageLabel, "the previous volume's glossary");
}


/**
 * The same gate against an arbitrary baseline — the previous volume's glossary,
 * or this volume's own glossary as of the previous chapter.
 *
 * The chunked flow needs the per-chapter form: the observed damage happened
 * DURING volume 06's per-chapter amend passes, not at the volume boundary, and
 * catching it at chapter 3 saves eight chapters of work built on a broken base.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {string} baselineText - The document the newer one must not shrink.
 * @param {string} stageLabel - Which pass produced the newer snapshot.
 * @param {string} baselineLabel - What the older snapshot was.
 * @returns {Promise<void>}
 * @throws {Error} When terms disappeared.
 */
async function guardCarryForwardAgainst(ctx, baselineText, stageLabel, baselineLabel) {
  if (!readBoolEnv("GLOSSARY_CARRY_FORWARD_GUARD", true)) return;
  const { values, glossaryOutputFile } = ctx;

  let currentText;
  try {
    currentText = await fs.readFile(glossaryOutputFile, "utf8");
  } catch (err) {
    // A missing/empty glossary is already the hard stop in assertRealOutput;
    // the guard adds nothing there and must not report it as a term loss.
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: carry-forward check skipped (${err.message}).`
    );
    return;
  }

  const diff = compareGlossaryCarryForward(baselineText, currentText);
  if (diff.missing.length === 0) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: carry-forward check passed ` +
        `(${diff.previousCount} terms carried` +
        `${diff.restructured ? `, ${diff.restructured} of them reworded` : ""}` +
        `${diff.renamed.length ? `, ${diff.renamed.length} renamed (see the report)` : ""}` +
        `, ${diff.added.length} added).`
    );
    if (diff.renamed.length) logRenamedTerms(values.INSTALLMENT_NUMBER, diff.renamed);
    return;
  }

  await quarantineDamagedGlossary(ctx, diff);
  reportCarryForwardLoss(values.INSTALLMENT_NUMBER, diff, stageLabel, baselineLabel);
}


/**
 * Move a glossary that lost carried-forward terms out of the way, so the volume
 * AFTER it cannot build on it.
 *
 * This is what makes the documented cascade actually fire. A failed volume
 * normally stops the next one because its artifact is MISSING, and
 * ON_MISSING_PREVIOUS=skip then skips that one in turn, to the end of the task
 * (docs/architecture.md). A carry-forward loss is the worse case: the file is present,
 * plausible, and short by hundreds of terms — so the next volume would read it
 * as terminology law. Observed live: volume 06 held 411 of volume 05's 769
 * terms, and nothing in the stage could see it.
 *
 * Renamed, not deleted: the damaged document is the evidence, and
 * `translation-<id>.rejected.md` is the same pattern the translation stage uses.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {{missing: Array<{term: string}>, previousCount: number, currentCount: number}} diff
 *   The result of compareGlossaryCarryForward.
 * @returns {Promise<void>}
 */
async function quarantineDamagedGlossary(ctx, diff) {
  const { values, glossaryOutputFile } = ctx;
  const quarantineFile = `${glossaryOutputFile}.rejected`;
  try {
    await fs.rename(glossaryOutputFile, quarantineFile);
    const from = ctx.previousFolderName ? `../${ctx.previousFolderName}/glossary.md` : "the previous volume's glossary";
    console.error(
      `Volume ${values.INSTALLMENT_NUMBER}: moved the damaged glossary (${diff.currentCount} of ` +
        `${diff.previousCount} terms) to "${path.basename(quarantineFile)}" so the next volume ` +
        `cannot build on it. Re-running this volume starts from ${from}.`
    );
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not move the damaged glossary aside ` +
        `(${err.message}) — it is still a failure, but the next volume may read it.`
    );
  }
}


/**
 * Name the carried-forward entries the gate recognised as RENAMED rather than
 * lost, so a rename is visible in the log instead of being silently absorbed.
 *
 * A rename is legitimate (the amend prompt asks for it when a new term is an
 * existing term under another spelling), but it is the form of edit that a
 * carry-forward loss most often hides behind, so the run says which entries
 * changed their source-language spelling and what they changed it to.
 *
 * @param {string} installmentNumber - The volume being processed.
 * @param {Array<{term: string, now: string, section: string}>} renamed - The
 *   `renamed` half of compareGlossaryCarryForward's diff.
 * @returns {void}
 */
function logRenamedTerms(installmentNumber, renamed) {
  const preview = renamed
    .slice(0, 8)
    .map((e) => `${e.term} → ${e.now} [${e.section || "no section"}]`)
    .join(", ");
  console.log(
    `  [glossary] Volume ${installmentNumber}: ${renamed.length} carried-forward term(s) ` +
      `kept under a new source-language spelling: ${preview}` +
      `${renamed.length > 8 ? `, … ${renamed.length - 8} more` : ""}`
  );
}


/**
 * Log (and fail on) a carry-forward loss, given the two snapshots already compared.
 *
 * The pure half of the gate: no files, so it is the part the tests can drive
 * with hand-built documents.
 *
 * @param {string} installmentNumber - The volume being processed.
 * @param {{previousCount: number, currentCount: number, missing: Array<{term: string, section: string}>, added: string[], renamed?: Array<{term: string, now: string, section: string}>}} diff
 *   The result of compareGlossaryCarryForward.
 * @param {string} stageLabel - Which pass produced the newer snapshot.
 * @param {string} baselineLabel - What the older snapshot was.
 * @returns {void}
 * @throws {Error} When terms disappeared.
 */
function reportCarryForwardLoss(installmentNumber, diff, stageLabel, baselineLabel) {
  if (diff.missing.length === 0) {
    console.log(
      `Volume ${installmentNumber}: carry-forward check passed ` +
        `(${diff.previousCount} terms carried, ${diff.added.length} added).`
    );
    return;
  }

  if (diff.renamed && diff.renamed.length) logRenamedTerms(installmentNumber, diff.renamed);

  const preview = diff.missing
    .slice(0, 12)
    .map((e) => `${e.term} [${e.section || "no section"}]`)
    .join(", ");
  const shrinkNote =
    diff.currentCount < diff.previousCount
      ? ` The file shrank, which is what a pass that rewrites the whole document ` +
        `does when the cumulative glossary is larger than one reply can write ` +
        `(${diff.currentCount} of ${diff.previousCount} rows survived).`
      : ` The file did NOT shrink (${diff.currentCount} rows), so these entries were ` +
        `replaced rather than run out of room — check whether a row was rewritten ` +
        `under a spelling the source does not use.`;
  const message =
    `Volume ${installmentNumber}: ${stageLabel} dropped ` +
    `${diff.missing.length} of the ${diff.previousCount} term(s) in ${baselineLabel} ` +
    `(${diff.currentCount} remain). Lost: ${preview}` +
    `${diff.missing.length > 12 ? `, … ${diff.missing.length - 12} more` : ""}. ` +
    `The glossary is cumulative — every later volume is translated against it.` +
    shrinkNote;
  console.error(`  [glossary] WARNING: ${message}`);
  throw new Error(message);
}

module.exports = {
  assertGlossaryCarryForward,
  guardCarryForwardAgainst,
  quarantineDamagedGlossary,
  logRenamedTerms,
  reportCarryForwardLoss,
};

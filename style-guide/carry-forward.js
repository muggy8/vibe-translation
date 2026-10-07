/**
 * The no-AI gate on the `## ` category set the prompt specifies — a guide missing "Address & Honorifics" has lost everything inside it — and the seed that copies the previous volume's guide in.
 *
 * A drop in the bullet-rule count is REPORTED, not failed: the guide's content is free prose, and a guard that compares prose starts calling an improvement a loss (gotcha 65).
 *
 * Part of the style-guide.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError, readBoolEnv } = require("../configs/shared");

const { buildStyleIndex, countStyleRules, parseStyleSections } = require("./reference-index");

/**
 * Seed this volume's style guide with the previous volume's, verbatim, before any
 * agent touches it. "Carry forward every existing rule" is a file copy, not a
 * model task; with the baseline in place the compile pass amends a real file and
 * `styleWriteInstruction` can say so.
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context.
 * @returns {Promise<boolean>} True when the volume's guide now starts from the
 *   previous volume's copy.
 */
async function seedStyleGuideFromPrevious(ctx) {
  const { values, isFirst, previousStyleGuideFile, styleOutputFile } = ctx;
  if (isFirst || !previousStyleGuideFile) return false;

  let previousText;
  try {
    previousText = await fs.readFile(previousStyleGuideFile, "utf8");
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not read the previous style guide ` +
        `(${previousStyleGuideFile}: ${err.message}) — the author agent will write this ` +
        `volume's guide from scratch.`
    );
    return false;
  }
  if (!previousText || previousText.trim().length === 0) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: the previous style guide is empty — the author ` +
        `agent will write this volume's guide from scratch.`
    );
    return false;
  }

  let replaced = false;
  try {
    const existing = await fs.readFile(styleOutputFile, "utf8");
    replaced = existing.trim() !== previousText.trim();
  } catch {
    replaced = true;
  }

  await fs.writeFile(styleOutputFile, previousText, "utf8");
  ctx.styleSeeded = true;
  ctx.styleIndex = buildStyleIndex(previousText);
  if (replaced) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: seeded style-guide.md from ` +
        `../${path.basename(path.dirname(previousStyleGuideFile))}/style-guide.md ` +
        `(${parseStyleSections(previousText).length} section(s), ` +
        `${countStyleRules(previousText)} rule(s) carried forward verbatim; the author agent ` +
        `amends it in place).`
    );
  }
  return true;
}


/**
 * Compare two style-guide snapshots and report what the newer one LOST.
 *
 * The unit is the category section, because that is the part this document
 * specifies exactly. A missing category means every rule inside it is gone.
 *
 * @param {string} previousMarkdown - The previous volume's guide content.
 * @param {string} currentMarkdown - The guide just produced for this volume.
 * @returns {{previousCount: number, currentCount: number, missing: Array<{name: string}>, added: string[], previousRules: number, currentRules: number}}
 */
function compareStyleCarryForward(previousMarkdown, currentMarkdown) {
  const previous = parseStyleSections(previousMarkdown);
  const current = parseStyleSections(currentMarkdown);
  const currentNames = new Set(current.map((s) => s.name));
  const previousNames = new Set(previous.map((s) => s.name));
  const missing = previous.filter((s) => !currentNames.has(s.name));
  const added = current.filter((s) => !previousNames.has(s.name)).map((s) => s.name);
  return {
    previousCount: previous.length,
    currentCount: current.length,
    missing,
    added,
    previousRules: countStyleRules(previousMarkdown),
    currentRules: countStyleRules(currentMarkdown),
  };
}


/**
 * The carry-forward gate for the style guide: after a pass, check that this
 * volume's guide still holds every category section the previous volume's held.
 *
 * Deliberately narrower than the glossary's and character-voice's gates: a style
 * guide's content is free prose, and a guard that compares prose calls an
 * improvement a loss. What it CAN check honestly is the section set the prompt
 * specifies — a guide missing "Address & Honorifics" has lost everything in it.
 * A drop in the rule count is reported, not failed, for the same reason.
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context.
 * @param {string} [stageLabel] - Which pass produced the guide.
 * @returns {Promise<void>}
 * @throws {Error} When category sections disappeared (unless the guard is
 *   disabled with STYLE_CARRY_FORWARD_GUARD=false).
 */
async function assertStyleCarryForward(ctx, stageLabel = "the compile pass") {
  const { values, isFirst, previousStyleGuideFile } = ctx;
  if (isFirst || !previousStyleGuideFile) return;
  if (!readBoolEnv("STYLE_CARRY_FORWARD_GUARD", true)) return;

  let previousText;
  try {
    previousText = await fs.readFile(previousStyleGuideFile, "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: carry-forward check skipped (${err.message}).`);
    return;
  }
  await guardStyleCarryForwardAgainst(ctx, previousText, stageLabel, "the previous volume's style guide");
}


/**
 * The same gate against an arbitrary baseline — the previous volume's guide, or
 * this volume's own guide as of the previous chapter (chunked mode).
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context.
 * @param {string} baselineText - The document the newer one must not shrink.
 * @param {string} stageLabel - Which pass produced the newer snapshot.
 * @param {string} baselineLabel - What the older snapshot was.
 * @returns {Promise<void>}
 * @throws {Error} When category sections disappeared.
 */
async function guardStyleCarryForwardAgainst(ctx, baselineText, stageLabel, baselineLabel) {
  if (!readBoolEnv("STYLE_CARRY_FORWARD_GUARD", true)) return;
  const { values, styleOutputFile } = ctx;

  let currentText;
  try {
    currentText = await fs.readFile(styleOutputFile, "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: carry-forward check skipped (${err.message}).`);
    return;
  }

  const diff = compareStyleCarryForward(baselineText, currentText);
  if (diff.missing.length === 0) {
    const ruleNote =
      diff.currentRules < diff.previousRules
        ? `, ${diff.previousRules - diff.currentRules} fewer bullet rule(s) — reported, not failed`
        : "";
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: carry-forward check passed ` +
        `(${diff.previousCount} section(s) carried, ${diff.added.length} added, ` +
        `${diff.currentRules} rule(s)${ruleNote}).`
    );
    return;
  }

  const quarantineFile = `${styleOutputFile}.rejected`;
  try {
    await fs.rename(styleOutputFile, quarantineFile);
    console.error(
      `Volume ${values.INSTALLMENT_NUMBER}: moved the damaged style guide (${diff.currentCount} of ` +
        `${diff.previousCount} sections) to "${path.basename(quarantineFile)}" so the next volume ` +
        `cannot build on it. Re-running this volume starts from ../${ctx.previousFolderName}/style-guide.md.`
    );
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not move the damaged guide aside (${err.message}) ` +
        `— it is still a failure, but the next volume may read it.`
    );
  }

  throw new Error(
    `Volume ${values.INSTALLMENT_NUMBER}: ${stageLabel} dropped style-guide section(s) that ` +
      `${baselineLabel} held — ${diff.missing.map((s) => s.name).join(", ")}. The guide is ` +
      `cumulative: every later volume is built on it, and its copy has been moved to ` +
      `"${path.basename(quarantineFile)}" so no later volume can read a partial one. Amend ` +
      `"style-guide.md" in place with editFile instead of rewriting it (see ` +
      `styleWriteInstruction), or set STYLE_CARRY_FORWARD_GUARD=false to allow a shrinking guide.`
  );
}


module.exports = {
  seedStyleGuideFromPrevious,
  compareStyleCarryForward,
  assertStyleCarryForward,
  guardStyleCarryForwardAgainst,
};

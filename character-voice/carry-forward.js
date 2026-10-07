/**
 * The no-AI gate on the character-section set, and the seed that copies the previous volume's reference in before any agent runs.
 *
 * The unit is the `### Character` section keyed on voicePrimaryName — the heading with its bracketed aliases and persona tags removed (如月雨露（ジョーロ）【俺人格】 → 如月雨露) — because the persona tag is what a feedback pass is most likely to reword while leaving the entry intact, and a COUNT dropping cannot be explained by a rename. A loss fails the volume and moves the reference to character-voice.md.rejected so the next volume cannot read it.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError, readBoolEnv } = require("../configs/shared");

const { buildVoiceIndex, parseVoiceSections } = require("./reference-index");

/**
 * Seed this volume's character voice reference with the previous volume's,
 * verbatim, before any agent touches it.
 *
 * "Carry forward every previous entry" was never a job for a model: it is a file
 * copy. Copying it in makes the compile pass what the prompt always said it was
 * — the previous reference PLUS this volume's new characters and quirks — and it
 * makes `voiceWriteInstruction` able to say "edit it in place", which is the only
 * instruction that works once the reference is bigger than one reply.
 *
 * Only `character-voice.md` is seeded. `pov-map.md` is PER-VOLUME (this volume's
 * POV map), not cumulative, so it is written fresh every volume and a stale copy
 * of the previous volume's map would be worse than none.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context.
 * @returns {Promise<boolean>} True when the volume's reference now starts from the
 *   previous volume's copy (so the prompts can say "edit it in place").
 */
async function seedVoiceReferenceFromPrevious(ctx) {
  const { values, isFirst, previousVoiceRefFile, voiceOutputFile } = ctx;
  if (isFirst || !previousVoiceRefFile) return false;

  let previousText;
  try {
    previousText = await fs.readFile(previousVoiceRefFile, "utf8");
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not read the previous character voice reference ` +
        `(${previousVoiceRefFile}: ${err.message}) — the author agent will write this volume's ` +
        `reference from scratch.`
    );
    return false;
  }
  if (!previousText || previousText.trim().length === 0) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: the previous character voice reference is empty — ` +
        `the author agent will write this volume's reference from scratch.`
    );
    return false;
  }

  let replaced = false;
  try {
    const existing = await fs.readFile(voiceOutputFile, "utf8");
    replaced = existing.trim() !== previousText.trim();
  } catch {
    replaced = true; // No file yet — the copy creates it.
  }

  await fs.writeFile(voiceOutputFile, previousText, "utf8");
  ctx.voiceSeeded = true;
  // The map the compile and feedback passes need in order to find a character's
  // section without paging the whole document (see buildVoiceIndex).
  ctx.voiceIndex = buildVoiceIndex(previousText);
  if (replaced) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: seeded character-voice.md from ` +
        `../${path.basename(path.dirname(previousVoiceRefFile))}/character-voice.md ` +
        `(${parseVoiceSections(previousText).length} character section(s) carried forward ` +
        `verbatim; the author agent amends it in place).`
    );
  }
  return true;
}


/**
 * Compare two voice-reference snapshots and report what the newer one LOST.
 *
 * The reference is cumulative: volume N's file must hold every character section
 * volume N-1's held. Nothing else in the stage can see a loss — the validator
 * audits this volume's source against this volume's reference, so a character who
 * only ever appeared in volume 2 is invisible to it.
 *
 * The unit is the character, counted by primary name, because a cumulative
 * reference legitimately reworded a heading but may not quietly drop a character.
 * A primary name whose section COUNT falls is a loss: 如月雨露 appearing three
 * times (俺人格 / 僕人格 / the transition) and then twice means one of those
 * entries is gone, and "the heading was renamed" cannot explain a count dropping.
 *
 * Pure and deterministic — no model call, so it runs after every pass for the
 * price of two file reads.
 *
 * @param {string} previousMarkdown - The previous volume's reference content.
 * @param {string} currentMarkdown - The reference just produced for this volume.
 * @returns {{previousCount: number, currentCount: number, missing: Array<{name: string, expected: number, found: number}>, added: string[], restructured: number}}
 */
function compareVoiceCarryForward(previousMarkdown, currentMarkdown) {
  const previous = parseVoiceSections(previousMarkdown);
  const current = parseVoiceSections(currentMarkdown);

  const countBy = (sections) => {
    const map = new Map();
    for (const s of sections) map.set(s.primary, (map.get(s.primary) || 0) + 1);
    return map;
  };
  const previousCounts = countBy(previous);
  const currentCounts = countBy(current);
  const currentNames = new Set(current.map((s) => s.primary));

  const missing = [];
  let restructured = 0;
  for (const [primary, expected] of previousCounts) {
    const found = currentCounts.get(primary) || 0;
    if (found >= expected) {
      // The character is still here. If no heading matches the old one exactly,
      // the section was reworded — legitimate, and worth reporting separately so
      // a mass rename is visible rather than silently counted as a loss.
      if (!current.some((s) => s.name === previous.find((p) => p.primary === primary)?.name)) restructured++;
      continue;
    }
    missing.push({ name: primary, expected, found });
  }

  const previousNames = new Set(previous.map((s) => s.primary));
  const added = [...new Set(current.map((s) => s.primary))].filter((n) => !previousNames.has(n));

  return {
    previousCount: previous.length,
    currentCount: current.length,
    missing,
    added,
    restructured,
  };
}


/**
 * The carry-forward gate for the character voice reference: after a pass, check
 * that this volume's reference still holds every character section the previous
 * volume's held.
 *
 * It fails the VOLUME, not the run (with ON_VOLUME_ERROR=skip the series
 * continues and the volume is named in the task's failure summary), and it moves
 * the damaged reference to `character-voice.md.rejected` so the next volume
 * cannot build on it — which is what makes the ON_MISSING_PREVIOUS cascade
 * actually fire. A failed cumulative volume normally stops the next one only
 * when its artifact is MISSING; a present-but-short one is the case
 * ON_MISSING_PREVIOUS cannot see, and every later volume would read it as the
 * series' character state.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context.
 * @param {string} [stageLabel] - Which pass produced the reference.
 * @returns {Promise<void>}
 * @throws {Error} When character sections disappeared (unless the guard is
 *   disabled with VOICE_CARRY_FORWARD_GUARD=false).
 */
async function assertVoiceCarryForward(ctx, stageLabel = "the compile pass") {
  const { values, isFirst, previousVoiceRefFile } = ctx;
  if (isFirst || !previousVoiceRefFile) return;
  if (!readBoolEnv("VOICE_CARRY_FORWARD_GUARD", true)) return;

  let previousText;
  try {
    previousText = await fs.readFile(previousVoiceRefFile, "utf8");
  } catch (err) {
    // A missing previous reference is already handled by the volume loop's
    // ON_MISSING_PREVIOUS policy; the guard must not mask it with a different
    // message.
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: carry-forward check skipped (${err.message}).`);
    return;
  }
  await guardVoiceCarryForwardAgainst(ctx, previousText, stageLabel, "the previous volume's character voice reference");
}


/**
 * The same gate against an arbitrary baseline — the previous volume's reference,
 * or this volume's own reference as of the previous chapter.
 *
 * The chunked flow needs the per-chapter form: a character lost at chapter 3
 * silently becomes the base of chapters 4–10, and catching it there costs one
 * chapter of rework instead of seven built on a reference that is already
 * missing someone.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context.
 * @param {string} baselineText - The document the newer one must not shrink.
 * @param {string} stageLabel - Which pass produced the newer snapshot.
 * @param {string} baselineLabel - What the older snapshot was.
 * @returns {Promise<void>}
 * @throws {Error} When character sections disappeared.
 */
async function guardVoiceCarryForwardAgainst(ctx, baselineText, stageLabel, baselineLabel) {
  if (!readBoolEnv("VOICE_CARRY_FORWARD_GUARD", true)) return;
  const { values } = ctx;

  let currentText;
  try {
    currentText = await fs.readFile(ctx.voiceOutputFile, "utf8");
  } catch (err) {
    // A missing/empty reference is already the hard stop in assertRealOutput;
    // the guard adds nothing there and must not report it as a lost character.
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: carry-forward check skipped (${err.message}).`);
    return;
  }

  const diff = compareVoiceCarryForward(baselineText, currentText);
  if (diff.missing.length === 0) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: carry-forward check passed ` +
        `(${diff.previousCount} character section(s) carried${diff.restructured ? `, ${diff.restructured} reworded` : ""}, ${diff.added.length} added).`
    );
    return;
  }

  const quarantineFile = `${ctx.voiceOutputFile}.rejected`;
  try {
    await fs.rename(ctx.voiceOutputFile, quarantineFile);
    console.error(
      `Volume ${values.INSTALLMENT_NUMBER}: moved the damaged character voice reference ` +
        `(${diff.currentCount} of ${diff.previousCount} sections) to "${path.basename(quarantineFile)}" ` +
        `so the next volume cannot build on it. Re-running this volume starts from ` +
        `../${ctx.previousFolderName}/character-voice.md.`
    );
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not move the damaged reference aside (${err.message}) ` +
        `— it is still a failure, but the next volume may read it.`
    );
  }

  const preview = diff.missing
    .slice(0, 12)
    .map((m) => `${m.name} (${m.found} of ${m.expected})`)
    .join(", ");
  throw new Error(
    `Volume ${values.INSTALLMENT_NUMBER}: ${stageLabel} dropped character section(s) that ` +
      `${baselineLabel} held — ${diff.missing.length} of ${diff.previousCount} section(s) gone ` +
      `(${preview}${diff.missing.length > 12 ? ", …" : ""}). The reference is cumulative: every ` +
      `later volume is built on it, and its copy has been moved to ` +
      `"${path.basename(quarantineFile)}" so no later volume can read a partial one. Amend ` +
      `"character-voice.md" in place with editFile instead of rewriting it (see ` +
      `voiceWriteInstruction), or set VOICE_CARRY_FORWARD_GUARD=false to allow a shrinking reference.`
  );
}


module.exports = {
  seedVoiceReferenceFromPrevious,
  compareVoiceCarryForward,
  assertVoiceCarryForward,
  guardVoiceCarryForwardAgainst,
};

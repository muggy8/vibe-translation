/**
 * The no-AI gate on the character-section set: this volume's reference must still hold every character
 * the previous volume's held.
 *
 * The unit is the `### Character` section keyed on voicePrimaryName — the heading with its bracketed
 * aliases and persona tags removed (如月雨露（ジョーロ）【俺人格】 → 如月雨露) — because a heading is
 * reworded more often than a character is dropped, and a COUNT dropping cannot be explained by a
 * rename. A loss fails the volume and moves the reference to character-voice.md.rejected so the next
 * volume cannot read it.
 *
 * The seed that used to sit here (copying the previous volume's file into this volume so an agent could
 * amend it) went with the author route: on this route the record carries the earlier volumes' claims
 * forward, and the file is rendered from the record, so there is nothing to copy in.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const { readBoolEnv } = require("../configs/shared");

const { parseVoiceSections } = require("./reference-index");

/**
 * Compare two voice-reference snapshots and report what the newer one LOST.
 *
 * The reference is cumulative: volume N's file must hold every character section
 * volume N-1's held. Nothing else in the stage can see a loss — the audit checks this volume's claims
 * against this volume's text, so a character who only ever appeared in volume 2 is invisible to it.
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
 * @param {{merged?: Array<{merged: string, survivor: string}>}} [opts] - The roster folds **the record
 *   itself recorded**: `[{merged: "俺", survivor: "如月雨露"}]`. A name the store folded into another
 *   entry is not a character the reference lost — its claims moved, and the fold carries the reason the
 *   pass that made it gave. Counting it as a loss would make the store's own roster rule and this guard
 *   contradict each other; counting it as carried without checking that the survivor is present would
 *   let a real disappearance hide behind a rename. Both are checked: the fold has to be one the record
 *   made, and the survivor's section has to be there.
 * @returns {{previousCount: number, currentCount: number, missing: Array<{name: string, expected: number, found: number}>, merged: Array<{name: string, survivor: string, expected: number, found: number}>, added: string[], restructured: number}}
 */
function compareVoiceCarryForward(previousMarkdown, currentMarkdown, { merged = [] } = {}) {
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

  /** @type {Map<string, string>} retired primary name → the entry it was folded into, from the record. */
  const folded = new Map();
  for (const row of merged || []) {
    if (row && row.merged && row.survivor) folded.set(String(row.merged), String(row.survivor));
  }

  const missing = [];
  /** @type {Array<{name: string, survivor: string, expected: number, found: number}>} */
  const mergedAway = [];
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
    const survivor = folded.get(primary);
    const survivorFound = survivor ? currentCounts.get(survivor) || 0 : 0;
    if (survivor && survivorFound > 0) {
      mergedAway.push({ name: primary, survivor, expected, found: survivorFound });
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
    merged: mergedAway,
    added,
    restructured,
  };
}


/**
 * The roster folds this volume's own record has recorded, for the carry-forward comparison.
 *
 * Read from the record rather than passed in by the caller, because the point of the fold is that
 * *the store decided it* — with a name, a reason, and the claims it moved. A guard that accepted a
 * disappearance because a caller said "that one is fine" would be the guard off.
 *
 * @param {{ refStore?: Object|null }} ctx
 * @returns {Array<{merged: string, survivor: string}>}
 */
function recordedRosterFolds(ctx) {
  if (!ctx || !ctx.refStore || typeof ctx.refStore.castMerges !== "function") return [];
  try {
    return ctx.refStore.castMerges() || [];
  } catch {
    // A record that cannot answer the question does not get to excuse a missing character.
    return [];
  }
}


/**
 * The carry-forward gate for the character voice reference: after the render, check that this volume's
 * reference still holds every character section the previous volume's held.
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
async function assertVoiceCarryForward(ctx, stageLabel = "the render") {
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

  let currentText;
  try {
    currentText = await fs.readFile(ctx.voiceOutputFile, "utf8");
  } catch (err) {
    // A missing/empty reference is already the hard stop in assertRealOutput;
    // the guard adds nothing there and must not report it as a lost character.
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: carry-forward check skipped (${err.message}).`);
    return;
  }

  const diff = compareVoiceCarryForward(previousText, currentText, { merged: recordedRosterFolds(ctx) });
  if (diff.missing.length === 0) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: carry-forward check passed ` +
        `(${diff.previousCount} character section(s) carried` +
        (diff.restructured ? `, ${diff.restructured} reworded` : "") +
        (diff.merged.length ? `, ${diff.merged.length} folded into another entry by the record (${diff.merged.map((m) => `${m.name} → ${m.survivor}`).join(", ")})` : "") +
        `, ${diff.added.length} added).`
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
      `the previous volume's character voice reference held — ${diff.missing.length} of ${diff.previousCount} section(s) gone ` +
      `(${preview}${diff.missing.length > 12 ? ", …" : ""}). The reference is cumulative: every ` +
      `later volume is built on it, and its copy has been moved to ` +
      `"${path.basename(quarantineFile)}" so no later volume can read a partial one. ` +
      `This reference is rendered from the volume's record, so a character missing from it is a ` +
      `character the record does not hold: check that the earlier volume's record was carried in ` +
      `(openVolumeRecord), and re-read the chapter that established them with ` +
      `"npm run extract-voice -- --volume=NN --chapter=<id>". ` +
      `Set VOICE_CARRY_FORWARD_GUARD=false only if you mean to allow a shrinking reference.`
  );
}


module.exports = {
  compareVoiceCarryForward,
  assertVoiceCarryForward,
};

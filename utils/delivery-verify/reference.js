/**
 * utils/delivery-verify/reference.js — the reference layer, per-volume step output, and the snapshot.
 *
 * A glossary intervention cannot move the publish report — the translation stage
 * has not run yet — so the deliverable of THAT step is its own artifacts: what
 * the glossary carries, how many characters the voice reference holds sections
 * for, which style categories survive, how many chapters the wiki hands off.
 * The same invariants the pipeline's own carry-forward gates protect, measured
 * from the outside. measureDeliverable is where the three halves are composed.
 *
 * It measures the newest snapshot plus every volume's own copy, because a loss
 * in the newest snapshot cascades into every later volume.
 */

const path = require("path");

const { REFERENCE_ARTIFACTS } = require("./signals");
const { readForMeasurement, readJsonForMeasurement, countHeadings, countBulletRules } = require("./read");
const { measureBook } = require("./book");
const { STEP_ARTIFACT_SPECS } = require("../artifacts");
const { parseGlossaryTerms } = require("../translate");
const { PIPELINE_STEPS } = require("../../gulpfile");

/** @typedef {import("../delivery-verify").DeliverableSnapshot} DeliverableSnapshot */

// ─── The reference layer ──────────────────────────────────────────────────────

/**
 * Measure one cumulative step's artifacts across the series.
 *
 * The HEAD snapshot (the newest volume's copy) is what every later volume reads, so its content
 * is the content that cascades; the total across volumes is what catches a loss in the middle of
 * the series that the head cannot see.
 *
 * @param {string} step
 * @param {string} seriesDir
 * @param {Array<{folder: string, installment: string}>} volumes
 * @param {string[]} notes
 * @returns {Promise<Object>}
 */
async function measureReference(step, seriesDir, volumes, notes) {
  const spec = REFERENCE_ARTIFACTS[step];
  const unreadable = [];
  let volumesWith = 0;
  let headVolume = null;
  let head = null;
  let termsTotal = 0;
  let chaptersHandedOff = 0;

  for (const v of volumes) {
    const volumeDir = path.join(seriesDir, v.folder);

    // The handoff is read whether or not the primary artifact is there: a volume that lost its
    // wiki still has a chapter list, and the two facts are different facts.
    if (spec.extra) {
      const handoff = await readJsonForMeasurement(path.join(volumeDir, spec.extra));
      if (handoff.state === "read") {
        const list = handoff.value && Array.isArray(handoff.value.chapters) ? handoff.value.chapters : [];
        chaptersHandedOff += list.length;
      } else if (handoff.state === "unreadable") {
        unreadable.push(handoff.note);
      }
    }

    const primary = await readForMeasurement(path.join(volumeDir, spec.primary));
    if (primary.state === "unreadable") {
      unreadable.push(primary.note);
      // Present but unreadable still counts as holding the artifact: the file is there, and
      // "the glossary disappeared" is not a true statement about this folder.
      volumesWith += 1;
      continue;
    }
    if (primary.state === "absent") continue;

    volumesWith += 1;
    headVolume = v.installment; // volumes arrive in reading order
    const text = primary.text;
    // `sections` is the `## ` set — the glossary's groupings, the style guide's protected
    // categories, the wiki's state sections. `characterSections` is the `### ` set, which is the
    // unit the voice reference's carry-forward gate protects.
    head = {
      chars: text.length,
      sections: countHeadings(text, "##"),
      characterSections: countHeadings(text, "###"),
      rules: countBulletRules(text),
      terms: step === "glossary" ? parseGlossaryTerms(text).length : null,
    };

    if (step === "glossary") termsTotal += head.terms;
  }

  if (unreadable.length) {
    notes.push(`${step}: ${unreadable.length} file(s) could not be measured — ${unreadable.join("; ")}`);
  }

  // The honesty rule, applied to the whole step: if any one volume's artifact could not be read,
  // every content number for this step is incomplete, and an incomplete total compared against a
  // complete one reports a loss that did not happen. Presence is still a fact; content is not.
  const blind = unreadable.length > 0;

  return {
    volumesWith,
    headVolume: blind ? null : headVolume,
    headTerms: blind || !head ? null : head.terms,
    termsTotal: blind || step !== "glossary" ? null : termsTotal,
    headSections: blind || !head ? null : head.sections,
    headCharacterSections: blind || !head ? null : head.characterSections,
    headRules: blind || !head ? null : head.rules,
    headChars: blind || !head ? null : head.chars,
    chaptersHandedOff: blind || !spec.extra ? null : chaptersHandedOff,
    unreadableCount: unreadable.length,
    protectedUnit: spec.unit,
  };
}

/**
 * How many volumes hold each step's declared output.
 *
 * Read from the resume inventory (`missingForStep`), which is `utils/artifacts.js`'s declaration
 * compared against the folder with `{installment}` resolved — the same comparison the post-mortem
 * and the resume triage make, so the measurement cannot disagree with them about what a step
 * leaves behind (gotcha 71).
 *
 * The two series-level steps (`discover`, `consistency-audit`) declare no per-volume output, so
 * counting them per volume would report "17 of 17 built" for a series that has no audit report at
 * all. They are measured against their own series-root deliverable instead: one deliverable, one
 * or zero.
 *
 * @param {Array<{exists: boolean, missingForStep: Array<{step: string}>}>} volumes
 * @param {string} seriesDir
 * @returns {Promise<Object<string, {built: number, missing: number}>|null>}
 */
async function measureStepProgress(volumes, seriesDir) {
  if (!Array.isArray(volumes) || volumes.length === 0) return null;
  const out = {};

  for (const { name } of PIPELINE_STEPS) {
    const spec = STEP_ARTIFACT_SPECS[name];
    if (spec && spec.perVolume === false) {
      const required = (spec.series || []).filter((e) => e.level === "required");
      if (!required.length) {
        out[name] = { built: null, missing: null };
        continue;
      }
      let present = 0;
      for (const e of required) {
        const read = await readForMeasurement(path.join(seriesDir, e.name.replace("{installment}", "")));
        // Present-but-unreadable counts as present: the file is there, and "the audit report is
        // gone" would be a false statement about the folder.
        if (read.state !== "absent") present += 1;
      }
      out[name] = present === required.length ? { built: 1, missing: 0 } : { built: 0, missing: 1 };
      continue;
    }

    let built = 0;
    let missing = 0;
    for (const v of volumes) {
      const gap = (v.missingForStep || []).some((m) => m.step === name);
      if (v.exists && !gap) built += 1;
      else missing += 1;
    }
    out[name] = { built, missing };
  }

  return out;
}

/**
 * Measure the deliverable.
 *
 * @param {{seriesDir?: string, volumes?: Array<import("../resume").VolumeInventory>}} [opts]
 *   `volumes` is the resume inventory; without it the working state is read (no model call, no
 *   writes — `readWorkingState` is a pure read of the disk).
 * @returns {Promise<DeliverableSnapshot>}
 */
async function measureDeliverable({ seriesDir, volumes } = {}) {
  const dir = path.resolve(seriesDir || process.env.SERIES_LOCATION || process.cwd());
  const notes = [];

  let inventory = volumes;
  if (!Array.isArray(inventory)) {
    // Late require on purpose: a caller that already has the volume list never needs the triage,
    // and keeping `utils/resume.js` out of this module's top-level requires means the triage can
    // read the measurement later without the two files requiring each other.
    const { readWorkingState } = require("../resume");
    const state = await readWorkingState({ seriesDir: dir });
    inventory = state.volumes || [];
    if (!state.manifest) notes.push("there is no plan of record, so the volume list is empty and nothing is measured");
  }

  const reference = {};
  for (const step of Object.keys(REFERENCE_ARTIFACTS)) {
    reference[step] = await measureReference(step, dir, inventory, notes);
  }

  return {
    schema: 1,
    measuredAt: new Date().toISOString(),
    seriesDir: dir,
    book: await measureBook(dir, notes),
    reference,
    steps: await measureStepProgress(inventory, dir),
    notes,
  };
}

module.exports = { measureReference, measureStepProgress, measureDeliverable };

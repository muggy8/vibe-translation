/**
 * character-voice/assemble.js — the voice stage's normal route: read the volume chapter by chapter,
 * file what was found, and **render** the two artifacts from the volume's record. No author agent.
 *
 * Why this is the default now. Measured on the real volumes: volume 01's authored run cost 37 model
 * calls, 166.7M prompt tokens and 12.7 hours, and the reference it produced was scored 48/100 and had
 * to be rebuilt by code. The same volume read-and-assembled cost about 1.1M tokens. Volume 02 read and
 * assembled cost 14 calls / 1.66M tokens / 0.85 h and its published reference was graded **82/100**
 * with its POV map present, against volume 01's code-rebuilt 81. The authoring half was never the half
 * that made the reference good; it was the half that made it expensive, and it was also the half that
 * destroyed volume 01's file in the first place.
 *
 * ## What the gate still does, on this route
 *
 * Everything except the rewrite. The deterministic audit runs. The acceptance grade runs, with the same
 * rubric, the same sampled reference, the same three files handed to the grader — including
 * `pov-map.md`, which this route renders precisely so the gate can run. The only thing missing is the
 * feedback pass, because there is no author to ask: a grade that fails cannot be answered by a model
 * re-typing the same claims, so it stops the volume instead.
 *
 * That is the shape `runSharedQaLoop` takes with `maxIterations: 1` and no watched feedback artifacts:
 * audit, grade, and either accept or stop. One grade per volume, not five.
 *
 * ## What happens to a volume that fails
 *
 * Both artifacts are moved to `.rejected` — the same quarantine `assertVoiceCarryForward` uses — and the
 * step throws, so the run's post-mortem and ticket machinery sees it like any other failed step. The
 * record is **not** sealed, because sealing is the last act of a volume whose pre-production finished
 * (`character-voice/task.js`), and this one did not. An unsealed volume is what the next volume's
 * copy-forward refuses, which is the shape the "a damaged reference may not be carried forward" rule
 * takes.
 *
 * ## Why the artifacts are written before the grade and quarantined after it
 *
 * The acceptance check is handed `pov-map.md` and `character-voice-validation.md` as **files**, so they
 * have to exist in the volume folder for the gate to run at all. Writing them, grading them, and
 * quarantining them if the grade fails is the order that lets the real gate grade the real artifacts
 * without publishing a volume nobody accepted. `rebuild-voice.js` keeps its own rule — publishing seals
 * and nothing else seals — untouched: on this route the seal is the stage's own end-of-volume seal, the
 * same one the author route gets.
 *
 * @module character-voice/assemble
 */

const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions

const rs = require("../utils/reference-store");
const { ACCEPTANCE_PASSING_SCORE } = require("../configs/shared");
const { assertVoiceCarryForward } = require("./carry-forward");
const { fileVoiceExtraction, auditAssembledArtifacts } = require("./store");
const { runQaLoop } = require("./qa");
const reading = require("./reading");

/** The artifacts this route renders, by the names the rest of the pipeline knows them under. */
const VOICE_FILE = "character-voice.md";
const POV_FILE = "pov-map.md";
const NEW_ENTRIES_FILE = "character-voice-new.json";

/**
 * File this volume's extraction claims, adopt them through the store's rebuild door, and render both
 * artifacts from the record — without publishing or sealing anything.
 *
 * The record is closed first and reopened by the store's own doors, because `rebuildVoiceVolume` opens
 * three handles on the volume's file (the document mirror it is clearing, the rebuild rows it is
 * filing, the candidate copies it is filing beside them) and a fourth handle already sitting on the
 * file is how a stale read starts.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {Array<Object>} entries - The consolidated extraction notebook.
 * @param {Array<{id: string, file: string}>} segments - The chapters the reading pass read.
 * @returns {{ok: boolean, refusal: Object|null, rebuild: Object|null, rendered: Object|null, povRendered: Object|null, audit: Object|null}}
 */
function assembleFromRecord(ctx, entries, segments) {
  const { values } = ctx;
  if (ctx.refStore) {
    try { ctx.refStore.close(); } catch { /* already closed */ }
    ctx.refStore = null;
  }

  const built = rs.rebuildVoiceVolume({
    volume: values.INSTALLMENT_NUMBER,
    folder: ctx.folderName,
    seriesDir: ctx.seriesDir,
    entries,
    bundleSegments: segments,
    // Not `apply`: on this route the artifacts are written, graded, and only then sealed — by the
    // stage, at the end of the volume, which is where the stage's seal has always lived.
    apply: false,
  });
  if (!built.ok) {
    return { ok: false, refusal: built.refusal, rebuild: built.rebuild, rendered: null, povRendered: null, audit: built.audit };
  }

  const writer = rs.openReferenceStore({
    volume: values.INSTALLMENT_NUMBER,
    folder: ctx.folderName,
    seriesDir: ctx.seriesDir,
    stage: rs.DOCUMENT_SOURCE_STAGE,
  });
  try {
    const voice = rs.writeRebuiltVoiceFile(writer, ctx.volumeDir, built.rendered, { file: VOICE_FILE, moveAside: true });
    if (!voice.ok) {
      return { ok: false, refusal: voice.refusal, rebuild: built.rebuild, rendered: built.rendered, povRendered: built.povRendered, audit: built.audit };
    }
    const map = rs.writePovMapFile(ctx.volumeDir, built.povRendered, { file: POV_FILE, moveAside: true });
    if (!map.ok) {
      return { ok: false, refusal: map.refusal, rebuild: built.rebuild, rendered: built.rendered, povRendered: built.povRendered, audit: built.audit };
    }
    ctx.artifactWrites = { voice, map };
    return { ok: true, refusal: null, rebuild: built.rebuild, rendered: built.rendered, povRendered: built.povRendered, audit: built.audit };
  } finally {
    writer.close();
  }
}

/**
 * Reopen this volume's record for the stage's own half: the audit, the graded sample, and the seal.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {void}
 */
function reopenRecordForStage(ctx) {
  ctx.refStore = rs.openReferenceStore({
    volume: ctx.values.INSTALLMENT_NUMBER,
    folder: ctx.folderName,
    seriesDir: ctx.seriesDir,
    stage: rs.DOCUMENT_SOURCE_STAGE,
  });
}

/**
 * Move both artifacts aside when the gate refused them, the way the carry-forward guard moves a
 * damaged reference aside: kept as evidence, and out of reach of the next volume.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {Promise<string[]>} The names actually moved.
 */
async function quarantineAssembledArtifacts(ctx) {
  const moved = [];
  for (const file of [ctx.voiceOutputFile, ctx.povOutputFile]) {
    const aside = rs.moveArtifactAside(ctx.volumeDir, path.basename(file));
    if (!aside.ok) {
      console.warn(`Volume ${ctx.values.INSTALLMENT_NUMBER}: could not move ${path.basename(file)} aside (${aside.refusal.because}) — it is still a failure.`);
      continue;
    }
    if (!aside.moved) continue;
    moved.push(path.basename(aside.moved));
    if (aside.keptAside.length) {
      console.log(
        `Volume ${ctx.values.INSTALLMENT_NUMBER}: this volume has now been quarantined ${aside.slot} times. ` +
          `The earlier rejection(s) are kept: ${aside.keptAside.map((p) => path.basename(p)).join(", ")}.`
      );
    }
  }
  return moved;
}

/**
 * Run the volume on the assembled route: read, file, render, audit, grade, and stop or seal.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {Promise<void>}
 * @throws {Error} When the reading pass fails, the record refuses, or the acceptance gate does not accept.
 */
async function runAssembledVolume(ctx) {
  const { values, volumeDir, bundle } = ctx;
  if (!ctx.refStore) {
    throw new Error(
      `Volume ${values.INSTALLMENT_NUMBER}: the assembled route needs this volume's reference record open, and it is not. ` +
        "The record is where the earlier volumes' sealed claims live; without it there is nothing to render."
    );
  }

  const segments = bundle && bundle.segments && bundle.segments.length ? bundle.segments : [];
  if (!segments.length) {
    throw new Error(`Volume ${values.INSTALLMENT_NUMBER}: the assembled route reads a volume chapter by chapter, and this volume resolved to no chapters.`);
  }

  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: assembled route — reading ${segments.length} chapter(s), then rendering ` +
    `${VOICE_FILE} and ${POV_FILE} from the volume's record. No author agent.`
  );

  const read = await reading.readVolumeChapters({
    ctx,
    segments,
    volumeDir,
    installmentNumber: values.INSTALLMENT_NUMBER,
    force: Boolean(ctx.force),
    log: console.log,
  });
  if (!read.ok) {
    throw new Error(`Volume ${values.INSTALLMENT_NUMBER}: ${read.refusal.rule} — ${read.refusal.because} (fix: ${read.refusal.fix})`);
  }
  ctx.readingChapters = read.chapters;
  ctx.readingReport = reading.readingReport(read.chapters, { volume: values.INSTALLMENT_NUMBER });

  const entries = reading.consolidateExtraction(read.chapters);
  const temp = `${ctx.volumeDir}/${NEW_ENTRIES_FILE}.writing`;
  await fs.writeFile(temp, JSON.stringify(entries, null, 2) + "\n", "utf8");
  await fs.rename(temp, path.join(volumeDir, NEW_ENTRIES_FILE));
  const paid = read.chapters.reduce((sum, c) => sum + (c.paidReads || 0), 0);
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: notebook — ${entries.length} claim(s) from ${read.chapters.length} chapter(s), ` +
      `${paid} model call(s), ${read.chapters.filter((c) => c.reused).length} chapter(s) reused.`
  );

  // The candidate copies, through the same door the author route uses. They are candidates: the
  // published bullets come from the adopted rows, and the gap between the two is a query the audit runs.
  fileVoiceExtraction(ctx, entries);

  const built = assembleFromRecord(ctx, entries, segments);
  if (!built.ok) {
    throw new Error(`Volume ${values.INSTALLMENT_NUMBER}: ${built.refusal.rule} — ${built.refusal.because} (fix: ${built.refusal.fix})`);
  }
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: assembled — ${built.rebuild.adoptedClaims} claim(s) adopted about ` +
      `${built.rebuild.adoptedCharacters} character(s), ${built.rebuild.refused.length} refused for want of a line this volume's text prints; ` +
      `${built.rendered.sections} section(s), ${built.povRendered.claims} POV claim(s) rendered into ${POV_FILE}.`
  );
  if (built.rendered.truncated || built.povRendered.truncated) {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: ${built.rendered.truncated + built.povRendered.truncated} bullet(s) were cut to fit one line.`);
  }

  reopenRecordForStage(ctx);

  // The cumulative invariant, checked against the previous volume's published reference — the same
  // guard the author route runs, on a file this route produced by rendering instead of by writing.
  await assertVoiceCarryForward(ctx, "the assembled render");

  const audit = await auditAssembledArtifacts(ctx, { refused: built.rebuild.refused });
  if (audit.highFindings.length) {
    const moved = await quarantineAssembledArtifacts(ctx);
    throw new Error(
      `Volume ${values.INSTALLMENT_NUMBER}: the deterministic audit reports ${audit.highFindings.length} HIGH finding(s) ` +
        `(${audit.highFindings.map((f) => f.kind).join(", ")}) against the assembled reference. ` +
        `${moved.length ? `Both artifacts were moved to ${moved.join(" and ")} so the next volume cannot build on them.` : ""} ` +
        "The record stays a draft."
    );
  }

  const result = await runQaLoop(ctx);
  if (!result.accepted) {
    const moved = await quarantineAssembledArtifacts(ctx);
    throw new Error(
      `Volume ${values.INSTALLMENT_NUMBER}: the acceptance gate did not accept the assembled reference ` +
      `(scores: ${result.scores.join(", ") || "none usable"}; passing score: ${ACCEPTANCE_PASSING_SCORE}). ` +
      `${moved.length ? `${moved.join(" and ")} — the artifacts were moved aside so the next volume cannot build on them.` : ""} ` +
      "This route has no author agent to rewrite the reference, so a failing grade stops the volume rather than paying for another pass over the same claims. " +
      "What to do: re-read the thin chapters (`extract-voice.js --chapter=<id>`), or run this volume on the author route with --route=author."
    );
  }

  console.log(`Volume ${values.INSTALLMENT_NUMBER}: assembled reference accepted by the gate (${result.acceptedBy}); the record is sealed at the end of the volume.`);
}

module.exports = {
  VOICE_FILE,
  POV_FILE,
  NEW_ENTRIES_FILE,
  assembleFromRecord,
  reopenRecordForStage,
  quarantineAssembledArtifacts,
  runAssembledVolume,
};

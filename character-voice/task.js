/**
 * The gulp task and the per-volume decision: skip when the outputs exist and pass acceptance,
 * otherwise read the volume chapter by chapter, file what was found, render both artifacts, audit,
 * grade, and seal. Regenerating any volume regenerates every later one — the cumulative invariant.
 *
 * There is one route. The stage used to have a second one (`--route=author`: an author agent compiled
 * the reference and rewrote it on feedback, with a whole-installment-vs-chapter-by-chapter decision in
 * front of it). It is gone, and `--route=` is refused rather than ignored — a flag that selects nothing
 * is a flag that lies about what the run is doing. What replaced it is `character-voice/assemble.js`,
 * and the acceptance gate is the same one both routes shared.
 *
 * The series plumbing (flags, plan of record, previous-volume gate, idempotency skip, series-root
 * publish, per-volume error policy) is the shared `utils/series-run` layer; what is left here is the
 * voice reference's own decisions.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const { transformUserPrompt, writePromptDump } = require("../utils/prompt");
const { validateRequiredEnv, structuralError } = require("../configs/shared");
const { REGISTER_MANIFEST_KEY, describeRegisterDeclaration, registerDeclarationRefusalText } = require("../utils/reference-store/register");
const { resolveSourceBundle, chapterSegmentNote } = require("../utils/source");
const { readRunArgs, openSeriesRun, locatePreviousVolume, requirePreviousArtifacts, volumeAlreadyAccepted, publishLatestToSeriesRoot, runVolumeSeries, reportVolumeFindings } = require("../utils/series-run");

const { acceptanceSystemPromptFile, acceptanceUserPromptTemplateFile, extractSystemPromptFile, extractUserPromptTemplateFile, seriesDir } = require("./config");
const { openVoiceRecord, fileVoiceExtraction, sealVoiceRecord } = require("./store");
const { runAssembledVolume } = require("./assemble");

/** The character-voice stage's own file names inside a volume folder. */
const VOICE_FILE = "character-voice.md";
const POV_FILE = "pov-map.md";
const VALIDATION_FILE = "character-voice-validation.md";
const NEW_ENTRIES_FILE = "character-voice-new.json";

/**
 * `--route=` is not a character-voice option any more, and saying so is the whole job here.
 *
 * The stage had two routes and now has one. A flag that is accepted and ignored is worse than a flag
 * that is refused: an operator who typed `--route=author` believes they are getting an author agent,
 * and the run they get has no author agent anywhere in it. So every `--route=` is an error, and the
 * error names what replaced the route rather than just saying "no".
 *
 * There is deliberately no environment variable behind this either. A guard whose off switch is a
 * setting is not a guard (AGENTS.md rule 3), and a route chosen by a variable nobody typed is a route
 * that changes underneath a run.
 *
 * @param {string[]} [argv]
 * @returns {void}
 * @throws {Error} Always — any `--route=` is refused.
 */
function assertNoRouteSelector(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith("--route="));
  if (!arg) return;
  const value = arg.slice("--route=".length);
  if (value === "author") {
    throw new Error(
      `--route=author was removed. The character-voice stage has one route: it reads the volume ` +
      `chapter by chapter (character-voice/reading.js), files what it found in the volume's reference ` +
      `record, and renders ${VOICE_FILE} and ${POV_FILE} from that record ` +
      `(character-voice/assemble.js). The acceptance gate is unchanged. To read a volume without ` +
      `building it: npm run extract-voice -- --volume=NN. To rebuild an artifact from the notebook a ` +
      `volume already produced: npm run rebuild-voice -- --volume=NN. The removed route is in git ` +
      `history at commit 75e59a7 if it is ever needed again.`
    );
  }
  throw new Error(
    `--route=${value} is not a character-voice option: this stage has one route and no selector. ` +
    `It reads the volume chapter by chapter and renders ${VOICE_FILE} and ${POV_FILE} from the ` +
    `volume's reference record. Remove the flag.`
  );
}

/**
 * Read the voice stage's prompt pair for each of the two roles it still asks.
 *
 * The author, validator and feedback prompt files went with the route that used them: the reading pass
 * is one extraction one-shot per chapter, and the validator half is queries against the record, which
 * make no model call and need no prompt.
 *
 * @returns {Promise<Object>} `{ extractSystemPrompt, extractTemplate, acceptanceSystemPrompt, acceptanceTemplate }`
 */
async function loadPromptFiles() {
  const read = (file) => fs.readFile(file, "utf8");
  return {
    extractSystemPrompt: await read(extractSystemPromptFile),
    extractTemplate: await read(extractUserPromptTemplateFile),
    acceptanceSystemPrompt: await read(acceptanceSystemPromptFile),
    acceptanceTemplate: await read(acceptanceUserPromptTemplateFile),
  };
}

/**
 * The character-voice stage's register decision, asked once per run before a volume is opened.
 *
 * Three states, three answers, and the difference between them is the design (plan 06 §4, slice 3):
 *
 *   - **declared** — the intake named the questions this book turns on. The stage runs, and the filing
 *     gate (`register/filing.js`) checks every axis-bearing claim against that list.
 *   - **empty** — the series declared none **and said why**. That is a book's legitimate answer, so the
 *     stage runs and announces it. Forcing a fake axis to satisfy a field is how a declaration stops
 *     meaning anything.
 *   - **absent** or **malformed** — refuse, structurally, before any volume is opened. There is no
 *     default question list behind this stage, in any language, and falling back to the one the
 *     extraction prompt happens to name is the exact defect plan 06 exists to remove. A structural
 *     error is what makes `ON_TASK_ERROR=continue` unable to walk past it, and the stage refuses in
 *     `--dry-run` too: a preview of a stage that cannot run is not a preview.
 *
 * The refusal names the door (`npx gulp discover`), because re-running the intake is the only fix, and
 * that is a model call the account owner has to choose to pay for.
 *
 * @param {Object} manifest - The plan of record `openSeriesRun` loaded.
 * @returns {{state: string, axes: Array<Object>, note: string|null}} The declaration, for the run to carry.
 * @throws {Error} A structural error, on `absent` and on `malformed`.
 */
function resolveStageRegisterDeclaration(manifest) {
  const declaration = describeRegisterDeclaration(manifest && manifest[REGISTER_MANIFEST_KEY]);
  if (declaration.state === "absent" || declaration.state === "malformed") {
    throw structuralError(registerDeclarationRefusalText(declaration, "character-voice"));
  }
  if (declaration.state === "empty") {
    console.log(
      `character-voice: this series declares no register questions, and says why: "${declaration.note}". ` +
      `The stage runs; no claim it files answers a register axis.`
    );
  } else {
    console.log(
      `character-voice: this series declares ${declaration.axes.length} register axis/axes — ` +
      declaration.axes.map((axis) => `"${axis.id}" (${axis.asks})`).join("; ") +
      ". A claim that answers one of them with a value outside its declared set is refused at filing."
    );
  }
  return declaration;
}

/**
 * The gulp task entry point for the character-voice workflow.
 *
 * The cascade flag is the cumulative invariant: once any volume is regenerated, every LATER volume
 * is regenerated too, because its reference was built on the one that just changed.
 */
async function characterVoice() {
  const { dryRun, force, volumeArg, chunked } = readRunArgs();
  assertNoRouteSelector();
  console.log("character-voice task starting... (read chapter by chapter, render from the record)");
  // `--chunked` is how an operator forces the other cumulative stages onto their chapter-by-chapter
  // fallback. This stage has no fallback to force: it reads the volume chapter by chapter whatever the
  // volume's size (that is its only route). Saying so once is cheaper than letting the flag look like it
  // changed something.
  if (chunked) {
    console.log("character-voice: --chunked has no effect here — this stage reads the volume chapter by chapter on its only route.");
  }
  validateRequiredEnv({ dryRun });

  const prompts = await loadPromptFiles();
  const { manifest, runSettings, folders, volumes, volumeByFolder } = await openSeriesRun({ seriesDir, dryRun, volumeArg });

  // The series' register declaration, asked before a single volume is opened (plan 06 slice 3). It
  // refuses structurally on a series that has none, so `--dry-run` refuses too.
  const registerDeclaration = resolveStageRegisterDeclaration(manifest);

  const cascade = { regeneratedAny: false, regeneratedFrom: null };
  const run = { folders, volumeByFolder, runSettings, prompts, dryRun, force, cascade, registerDeclaration };
  await runVolumeSeries("character-voice", {
    volumes,
    folders,
    volumeByFolder,
    processVolume: (folderName, index) => processVoiceVolume({ folderName, index }, run),
    afterVolumes: () =>
      publishLatestToSeriesRoot({
        seriesDir,
        folders,
        fileName: VOICE_FILE,
        envKey: "VOICE_OUTPUT_FILE",
        label: "character voice reference",
        volumeArg,
        dryRun,
      }),
  });
}


/**
 * One volume of the voice run: resolve its source and its base, then preview it, skip it, or build it.
 *
 * @param {{ folderName: string, index: number }} target - The volume and its position in the reading order.
 * @param {{
 *   folders: string[],
 *   volumeByFolder: Map<string, Object>,
 *   runSettings: {seriesName: string, sourceLanguage: string, targetLanguage: string},
 *   prompts: Object,
 *   dryRun: boolean,
 *   force: boolean,
 *   cascade: { regeneratedAny: boolean },
 * }} run - What every volume of this run shares.
 * @returns {Promise<void>}
 */
async function processVoiceVolume({ folderName, index }, run) {
  const { folders, volumeByFolder, runSettings, prompts, dryRun, force, cascade } = run;
  const volume = volumeByFolder.get(folderName);
  const volumeDir = path.join(seriesDir, folderName);
  const values = {
    INSTALLMENT_NUMBER: volume.installmentNumber,
    SOURCE_NAME: runSettings.seriesName,
    SOURCE_LANGUAGE: runSettings.sourceLanguage,
    TARGET_LANGUAGE: runSettings.targetLanguage,
  };

  // Resolve the source into a bundle (utils/source.js): plain-text sources pass through as-is; .epub
  // sources are normalized once (cached) into per-chapter + whole Markdown files. The chapters the
  // reading pass walks are the bundle's segments — the same chapters every other stage sees.
  const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });

  const { ctx, proceed } = await buildVolumeContext({
    folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, dryRun,
  });
  if (!proceed) return;

  if (dryRun) {
    await dumpVolumePreview(ctx);
    return;
  }

  // Both artifacts must be there and accepted: a run that wrote the reference but died before the
  // POV map is not a finished volume.
  if (await volumeAlreadyAccepted({
    installmentNumber: values.INSTALLMENT_NUMBER,
    outputFiles: [ctx.voiceOutputFile, ctx.povOutputFile],
    validationOutputFile: ctx.validationOutputFile,
    bundle,
    force,
    regeneratedAny: cascade.regeneratedAny,
    cascadeFrom: cascade.regeneratedFrom,
    artifactLabel: "voice reference and POV map",
    step: "character-voice",
    seriesDir,
    folder: folderName,
  })) {
    return;
  }

  cascade.regeneratedAny = true;
  cascade.regeneratedFrom = values.INSTALLMENT_NUMBER;

  // Slice 6: the volume's reference record. Opened before anything is written, because the previous
  // volume's published record has to be carried in first — and carrying it in is where the hard stop
  // lives: a volume whose character-voice reference lost characters that this volume's text contains
  // may not be copied forward, with no exception and no downgrade.
  //
  // It is also the artifact's source: the reference and the POV map are rendered out of this record,
  // so opening it is not behind `VOICE_STORE_VALIDATORS` and never was on this route. A route that
  // renders the reference from the record cannot run without one, and a guard with an env knob on it
  // is not a guard (AGENTS.md rule 3) — here the knob would not turn a check off, it would turn the
  // volume off.
  const previous = ctx.previousFolderName ? volumeByFolder.get(ctx.previousFolderName) : null;
  const attempt = openVoiceRecord(ctx, previous ? previous.installmentNumber : null);
  if (!attempt.ok) throw new Error(`Volume ${values.INSTALLMENT_NUMBER}: ${attempt.error}`);
  ctx.refStore = attempt.opened.store;
  ctx.storeCarried = attempt.opened.carried;
  if (attempt.opened.carried) {
    const counts = attempt.opened.carried.provenance.copiedRows;
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: reference record carried forward from volume ` +
        `${previous.installmentNumber} (${counts.facts} facts, ${counts.cast} characters).`
    );
  }

  // **The finding channel** (character-voice/findings.js → utils/series-run/findings.js →
  // utils/postmortem/channel.js). This runs on the way out whatever the volume did — accepted, graded
  // down, or thrown on the way there — because a chapter that never answered is a fact the stage learned
  // even when the volume failed for that reason, and the assessment of this volume is what turns it into
  // a finding the triage can act on.
  //
  // It is skipped when the reading pass never ran. The glossary stage's guard is "the read list is not
  // empty"; that length is the wrong fact here, because `readVolumeChapters` returns the chapters it
  // KEPT, and a pass that refused on its very first chapter kept none — so a length check would erase the
  // one finding that pass earned. The rule the channel's own header states is "report when the reading
  // pass ran, stay silent when it did not", and `ctx.readingPassRan` is that rule, not a proxy for it.
  // A volume skipped by the idempotency check, a `--dry-run`, and a volume refused before the pass started
  // all write nothing, which leaves the record an earlier pass left standing.
  try {
    await runAssembledVolume(ctx);
  } finally {
    if (ctx.readingPassRan) {
      await reportVolumeFindings({
        step: "character-voice",
        volumeEntry: volume,
        volumeDir,
        bundle,
        findings: ctx.readingFindings || [],
        dryRun,
      });
    }
  }

  // Sealing is the last act of a volume whose pre-production finished (review 05 §3.2: code seals,
  // at the end of that volume's own pre-production). A volume that threw on the way here is left
  // unsealed on purpose — an unsealed volume is what copy-forward refuses, which is the shape the
  // "a damaged reference may not be carried forward" rule takes.
  sealVoiceRecord(ctx);
}


/**
 * Assemble the volume context: the previous volume's reference (the base this volume's record carries
 * forward) and the prompts every chapter of the reading pass is sent.
 *
 * @returns {Promise<{ ctx: CharacterVoiceVolumeCtx, proceed: boolean }>} `proceed` false when the
 *   run policy said to skip this volume (a missing base).
 */
async function buildVolumeContext({ folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, dryRun }) {
  const { isFirst, previousFolderName } = locatePreviousVolume({ folders, index, volumeByFolder });

  const previous = await requirePreviousArtifacts({
    seriesDir,
    previousFolderName,
    fileNames: [VOICE_FILE],
    label: "character voice reference",
    installmentNumber: values.INSTALLMENT_NUMBER,
    dryRun,
  });
  if (previous.skipVolume) return { ctx: null, proceed: false };

  const ctx = {
    values,
    folderName,
    volumeDir,
    seriesDir,
    sourceFile: bundle.wholePath,
    bundle,
    isFirst,
    previousFolderName,
    previousVoiceRefFile: previous.files[0] || null,
    voiceOutputFile: path.join(volumeDir, VOICE_FILE),
    povOutputFile: path.join(volumeDir, POV_FILE),
    validationOutputFile: path.join(volumeDir, VALIDATION_FILE),
    extractPrompt: transformUserPrompt(prompts.extractTemplate, values),
    acceptancePrompt: transformUserPrompt(prompts.acceptanceTemplate, values),
    extractTemplate: prompts.extractTemplate,
    extractSystemPrompt: prompts.extractSystemPrompt,
    acceptanceSystemPrompt: prompts.acceptanceSystemPrompt,
  };

  return { ctx, proceed: true };
}


/**
 * `--dry-run`: write the exact prompts a live run would send, and make no AI call.
 *
 * The preview is the reading pass: one extraction turn per chapter, and one acceptance grade above it.
 * There is no author turn, no validator turn and no feedback turn to preview, because the stage sends
 * none — the validator half is queries against the volume's record, which ask the model nothing.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {Promise<void>}
 */
async function dumpVolumePreview(ctx) {
  const { values } = ctx;
  const segments = ctx.bundle && ctx.bundle.segments && ctx.bundle.segments.length ? ctx.bundle.segments : [];
  const sections = [
    { title: "One-shot — extraction system prompt", prompt: ctx.extractSystemPrompt },
    { title: "One-shot — extraction user prompt", prompt: ctx.extractPrompt },
  ];
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    sections.push({
      title: `Per-chapter extraction user prompt (${seg.id})`,
      prompt:
        `${ctx.extractPrompt}\n\n${chapterSegmentNote(ctx.bundle, seg, si)}\n\n` +
        (si === 0
          ? "(first chapter of the pass: nothing extracted yet)"
          : `(${segments.slice(0, si).map((s) => s.id).join(", ")} would be listed here in a live run, from the partials already on disk.)`),
    });
  }
  sections.push({ title: "One-shot — acceptance user prompt", prompt: ctx.acceptancePrompt });
  sections.push({
    title: "What this stage does NOT send",
    prompt:
      `No author turn, no validator agent turn, no feedback turn: the stage reads the volume chapter by ` +
      `chapter, files what it found in this volume's reference record, and renders ${VOICE_FILE} and ` +
      `${POV_FILE} from that record. The validator half is queries against the record (no prompt), and ` +
      `the only model call after the reading pass is the acceptance grade above it.`,
  });
  const dumpFile = await writePromptDump("character-voice", values.INSTALLMENT_NUMBER, "assemble", sections);
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: --dry-run: prompts dumped to ${dumpFile}`);
}


module.exports = {
  characterVoice,
  assertNoRouteSelector,
  resolveStageRegisterDeclaration,
  VOICE_FILE,
  POV_FILE,
  VALIDATION_FILE,
  NEW_ENTRIES_FILE,
};

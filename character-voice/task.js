/**
 * The gulp task and the per-volume decision: skip when the outputs exist and pass acceptance,
 * otherwise seed + compile + QA, then the deterministic carry-forward assertion. Regenerating any
 * volume regenerates every later one — the cumulative invariant.
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
const harness = require("../harness");
const { transformUserPrompt, writePromptDump } = require("../utils/prompt");
const { validateRequiredEnv, STORE_VALIDATORS } = require("../configs/shared");
const { fileExists } = require("../utils/fs");
const { runVolumeWithModeFallback } = require("../utils/qa-loop");
const { readRunArgs, openSeriesRun, locatePreviousVolume, requirePreviousArtifacts, volumeAlreadyAccepted, publishLatestToSeriesRoot, runVolumeSeries } = require("../utils/series-run");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { acceptanceSystemPromptFile, acceptanceUserPromptTemplateFile, authorSystemPromptFile, authorUserPromptTemplateFile, extractSystemPromptFile, extractUserPromptTemplateFile, feedbackSystemPromptFile, feedbackUserPromptTemplateFile, seriesDir, validatorSystemPromptFile, validatorUserPromptTemplateFile } = require("./config");
const { buildVoiceIndex } = require("./reference-index");
const { buildAuthorSystemPrompt, buildAuthorTurnPrompt, buildFeedbackTurnPrompt, buildValidatorSystemPrompt, buildValidatorTurnPrompt, buildVoiceFindingsMergePrompt } = require("./prompts");
const { parseVoiceQuirks } = require("./amend");
const { assertVoiceCarryForward, seedVoiceReferenceFromPrevious } = require("./carry-forward");
const { openVoiceRecord, fileVoiceExtraction, mirrorVoiceArtifact, sealVoiceRecord } = require("./store");
const { runAssembledVolume } = require("./assemble");
const { runCompile, runExtract } = require("./stages");
const { runQaLoop } = require("./qa");
const { runChunkedVolume } = require("./chunked");

/** The character-voice stage's own file names inside a volume folder. */
const VOICE_FILE = "character-voice.md";
const POV_FILE = "pov-map.md";
const VALIDATION_FILE = "character-voice-validation.md";
const NEW_ENTRIES_FILE = "character-voice-new.json";

/** The two ways this stage builds a volume, and which one a run takes when nobody says otherwise. */
const VOICE_ROUTES = Object.freeze(["assemble", "author"]);
const DEFAULT_VOICE_ROUTE = "assemble";

/**
 * Which route this run builds volumes with.
 *
 * `--route=assemble` is the default and needs no flag: read the volume chapter by chapter, file what
 * was found, render both artifacts from the record. `--route=author` selects the route that was the
 * default until the numbers came in — an author agent compiles the reference and rewrites it on
 * feedback. It stays reachable because it is still better at some things (see the stage's own docs),
 * and it is selectable from the command line rather than from the environment: a route chosen by a
 * variable nobody typed is a route that changes underneath a run.
 *
 * An unrecognised value is an error, not a fallback. `--route=autor` must not quietly build volumes a
 * different way from the one the operator asked for.
 *
 * @param {string[]} [argv]
 * @returns {string}
 */
function readVoiceRoute(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith("--route="));
  if (!arg) return DEFAULT_VOICE_ROUTE;
  const value = arg.slice("--route=".length);
  if (!VOICE_ROUTES.includes(value)) {
    throw new Error(`--route=${value} is not a character-voice route. Choose one: ${VOICE_ROUTES.join(", ")}.`);
  }
  return value;
}

/**
 * Read the voice stage's prompt pair for each of its five roles.
 * @returns {Promise<Object>} `{ <role>SystemPrompt, <role>Template }` for extract/author/validator/acceptance/feedback.
 */
async function loadPromptFiles() {
  const read = (file) => fs.readFile(file, "utf8");
  return {
    extractSystemPrompt: await read(extractSystemPromptFile),
    extractTemplate: await read(extractUserPromptTemplateFile),
    authorSystemPrompt: await read(authorSystemPromptFile),
    authorTemplate: await read(authorUserPromptTemplateFile),
    validatorSystemPrompt: await read(validatorSystemPromptFile),
    validatorTemplate: await read(validatorUserPromptTemplateFile),
    acceptanceSystemPrompt: await read(acceptanceSystemPromptFile),
    acceptanceTemplate: await read(acceptanceUserPromptTemplateFile),
    feedbackSystemPrompt: await read(feedbackSystemPromptFile),
    feedbackTemplate: await read(feedbackUserPromptTemplateFile),
  };
}

/**
 * The gulp task entry point for the character-voice workflow.
 *
 * The cascade flag is the cumulative invariant: once any volume is regenerated, every LATER volume
 * is regenerated too, because its reference was built on the one that just changed.
 */
async function characterVoice() {
  const { dryRun, force, chunked, volumeArg } = readRunArgs();
  const voiceRoute = readVoiceRoute();
  console.log(`character-voice task starting... (route: ${voiceRoute})`);
  validateRequiredEnv({ dryRun });

  const prompts = await loadPromptFiles();
  const { runSettings, folders, volumes, volumeByFolder } = await openSeriesRun({ seriesDir, dryRun, volumeArg });

  const cascade = { regeneratedAny: false };
  const run = { folders, volumeByFolder, runSettings, prompts, dryRun, force, chunked, voiceRoute, cascade };
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
 * One volume of the voice run: resolve its source, its base, and its processing mode; then preview
 * it, skip it, or build it.
 *
 * @param {{ folderName: string, index: number }} target - The volume and its position in the reading order.
 * @param {{
 *   folders: string[],
 *   volumeByFolder: Map<string, Object>,
 *   runSettings: {seriesName: string, sourceLanguage: string, targetLanguage: string},
 *   prompts: Object,
 *   dryRun: boolean,
 *   force: boolean,
 *   chunked: boolean,
 *   voiceRoute: string,
 *   cascade: { regeneratedAny: boolean },
 * }} run - What every volume of this run shares.
 * @returns {Promise<void>}
 */
async function processVoiceVolume({ folderName, index }, run) {
  const { folders, volumeByFolder, runSettings, prompts, dryRun, force, chunked, voiceRoute, cascade } = run;
  const volume = volumeByFolder.get(folderName);
  const volumeDir = path.join(seriesDir, folderName);
  const values = {
    INSTALLMENT_NUMBER: volume.installmentNumber,
    SOURCE_NAME: runSettings.seriesName,
    SOURCE_LANGUAGE: runSettings.sourceLanguage,
    TARGET_LANGUAGE: runSettings.targetLanguage,
  };

  // Resolve the source into a bundle (utils/source.js): plain-text sources pass through as-is (the
  // default whole-installment path); .epub sources are normalized once (cached) into per-chapter +
  // whole Markdown files.
  const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });

  const { ctx, proceed } = await buildVolumeContext({
    folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, volume, dryRun, chunked, voiceRoute,
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
    artifactLabel: "voice reference and POV map",
  })) {
    return;
  }

  cascade.regeneratedAny = true;

  // Slice 6: the volume's reference record. Opened before anything is written, because the previous
  // volume's published record has to be carried in first — and carrying it in is where the hard stop
  // lives: a volume whose character-voice reference lost characters that this volume's text contains
  // may not be copied forward, with no exception and no downgrade.
  //
  // The assembled route needs the record for a different reason too: the record **is** the artifact's
  // source. A route that renders the reference from the record cannot run without one, so opening it is
  // not behind `VOICE_STORE_VALIDATORS` on that route — a guard with an env knob on it is not a guard
  // (AGENTS.md rule 3), and here the knob would not turn a check off, it would turn the volume off.
  // The author route keeps the flag exactly where it was: with the flag off that route is byte-for-byte
  // the pipeline that has always run.
  const previous = ctx.previousFolderName ? volumeByFolder.get(ctx.previousFolderName) : null;
  if (STORE_VALIDATORS.voice || ctx.voiceRoute === "assemble") {
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
  }

  if (ctx.voiceRoute === "assemble") {
    // No mode fallback on this route: it reads chapter by chapter whatever the volume's size, because
    // the thing it is buying is a per-chapter notebook, not a single reply that has to contain the
    // whole book. The whole-installment/chunked decision belongs to the author route, where a reply
    // really does have to hold the reference.
    await runAssembledVolume(ctx);
  } else {
    await runVolumeWithModeFallback({
      label: `Volume ${volume.installmentNumber}`,
      ctx,
      volumeDir,
      run: () => runVolume(ctx),
      // Everything a whole-installment pass writes, removed before the chapter-by-chapter retry so it
      // cannot inherit a half-written attempt.
      attemptFiles: [
        VOICE_FILE,
        POV_FILE,
        NEW_ENTRIES_FILE,
        VALIDATION_FILE,
        "character-voice-validation-rolling-state.json",
      ],
      attemptGlob: /^character-voice-.*\.md$/,
    });
  }

  // Sealing is the last act of a volume whose pre-production finished (review 05 §3.2: code seals,
  // at the end of that volume's own pre-production). A volume that threw on the way here is left
  // unsealed on purpose — an unsealed volume is what copy-forward refuses, which is the shape the
  // "a damaged reference may not be carried forward" rule takes.
  sealVoiceRecord(ctx);
}


/**
 * Assemble the volume context: the previous volume's reference (the base this one amends) and the
 * processing mode.
 *
 * The agent-mode turn prompts name the base at its real relative path
 * (`../<previous folder>/character-voice.md`) — the same convention as the glossary.
 *
 * @returns {Promise<{ ctx: CharacterVoiceVolumeCtx, proceed: boolean }>} `proceed` false when the
 *   run policy said to skip this volume (a missing base).
 */
async function buildVolumeContext({ folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, volume, dryRun, chunked, voiceRoute }) {
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
    voiceRoute: voiceRoute || DEFAULT_VOICE_ROUTE,
    sourceFile: bundle.wholePath,
    bundle,
    isFirst,
    previousFolderName,
    previousVoiceRefFile: previous.files[0] || null,
    voiceOutputFile: path.join(volumeDir, VOICE_FILE),
    povOutputFile: path.join(volumeDir, POV_FILE),
    validationOutputFile: path.join(volumeDir, VALIDATION_FILE),
    extractPrompt: transformUserPrompt(prompts.extractTemplate, values),
    validatorPrompt: transformUserPrompt(prompts.validatorTemplate, values),
    feedbackPrompt: transformUserPrompt(prompts.feedbackTemplate, values),
    acceptancePrompt: transformUserPrompt(prompts.acceptanceTemplate, values),
    extractTemplate: prompts.extractTemplate,
    authorTemplate: prompts.authorTemplate,
    extractSystemPrompt: prompts.extractSystemPrompt,
    authorSystemPrompt: prompts.authorSystemPrompt,
    validatorSystemPrompt: prompts.validatorSystemPrompt,
    acceptanceSystemPrompt: prompts.acceptanceSystemPrompt,
    feedbackSystemPrompt: prompts.feedbackSystemPrompt,
    authorUserPrompt: prompts.authorTemplate,
    validatorUserPrompt: prompts.validatorTemplate,
    feedbackUserPrompt: prompts.feedbackTemplate,
  };

  // Whole-installment vs chapter-by-chapter, decided against THIS stage's model window and the
  // reference it will actually inject (the previous volume's cumulative reference — which is why this
  // is decided per volume: it grows every volume). See planProcessingMode in utils/source.js.
  const mode = await decideProcessingMode({
    bundle,
    label: `Volume ${volume.installmentNumber}`,
    previousArtifactFiles: ctx.previousVoiceRefFile ? [ctx.previousVoiceRefFile] : [],
    forceChunked: chunked,
    dryRun,
  });
  ctx.chunked = mode.chunked;

  return { ctx, proceed: true };
}


/**
 * `--dry-run`: write the exact prompts a live run would send, and make no AI call.
 *
 * The preview must match the live run: a live run seeds character-voice.md from the previous volume
 * whenever there is one, and the write instruction follows that. Without this the preview would show
 * the "create it from scratch" wording for volumes that are actually amended — and it would hide the
 * section map the agent uses to find the row it is editing.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {Promise<void>}
 */
async function dumpVolumePreview(ctx) {
  const { values } = ctx;
  /**
   * The preview has to show the prompts THIS route sends, because a dry run is how an operator checks
   * what a run will ask the model — and on the assembled route that is a per-chapter extraction call
   * and one grade, with no author, validator or feedback turn anywhere in it. Dumping the author
   * prompts for a route that never sends them is a preview of a run that is not going to happen.
   */
  if (ctx.voiceRoute === "assemble") {
    const segments = ctx.bundle && ctx.bundle.segments && ctx.bundle.segments.length ? ctx.bundle.segments : [];
    const sections = [
      { title: "One-shot — extraction system prompt", prompt: ctx.extractSystemPrompt },
      { title: "One-shot — extraction user prompt", prompt: ctx.extractPrompt },
    ];
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      sections.push({
        title: `ASSEMBLED — per-chapter extraction user prompt (${seg.id})`,
        prompt:
          `${ctx.extractPrompt}\n\n${chapterSegmentNote(ctx.bundle, seg, si)}\n\n` +
          (si === 0
            ? "(first chapter of the pass: nothing extracted yet)"
            : `(${segments.slice(0, si).map((s) => s.id).join(", ")} would be listed here in a live run, from the partials already on disk.)`),
      });
    }
    sections.push({ title: "One-shot — acceptance user prompt", prompt: ctx.acceptancePrompt });
    sections.push({
      title: "What this route does NOT send",
      prompt:
        `No author turn, no validator agent turn, no feedback turn: --route=assemble reads the volume chapter by chapter, ` +
        `files what it found in this volume's reference record, and renders ${VOICE_FILE} and ${POV_FILE} from that record. ` +
        `The validator half is queries against the record (no prompt), and the one model call after the reading pass is the ` +
        `acceptance grade above it. Run --route=author to see the author, validator and feedback turns instead.`,
    });
    const assembledDump = await writePromptDump("character-voice", values.INSTALLMENT_NUMBER, "assemble", sections);
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: --dry-run (route: assemble): prompts dumped to ${assembledDump}`);
    return;
  }

  ctx.voiceSeeded = !ctx.isFirst && Boolean(ctx.previousVoiceRefFile) && (await fileExists(ctx.previousVoiceRefFile));
  ctx.voiceIndex = ctx.voiceSeeded
    ? buildVoiceIndex(await fs.readFile(ctx.previousVoiceRefFile, "utf8").catch(() => ""))
    : "";
  const illustrative = JSON.stringify([{ type: "voice", character: "ex", quirkType: "sentenceEnding", description: "ex", examples: ["ex"], formalityLevel: "plain", notes: "ex" }]);
  const sections = [
    { title: "One-shot — extraction system prompt", prompt: ctx.extractSystemPrompt },
    { title: "One-shot — extraction user prompt", prompt: ctx.extractPrompt },
    { title: "AGENT — author system prompt", prompt: buildAuthorSystemPrompt(ctx.authorSystemPrompt) },
    { title: "AGENT — author turn (illustrative)", prompt: buildAuthorTurnPrompt(ctx, illustrative) },
    { title: "AGENT — validator system prompt", prompt: buildValidatorSystemPrompt(ctx.validatorSystemPrompt) },
    { title: "AGENT — validator turn", prompt: buildValidatorTurnPrompt(ctx) },
    { title: "AGENT — feedback turn", prompt: buildFeedbackTurnPrompt(ctx) },
    { title: "One-shot — acceptance user prompt", prompt: ctx.acceptancePrompt },
  ];
  // Chunked (fallback) volumes: dump the chapter-scoped variants too.
  if (ctx.chunked && ctx.bundle.segments.length > 1) {
    const seg = ctx.bundle.segments[0];
    sections.push(
      { title: "CHUNKED — per-chapter extraction user prompt (first chapter)", prompt: ctx.extractPrompt + "\n\n" + chapterSegmentNote(ctx.bundle, seg, 0) },
      { title: "CHUNKED — segment author turn (illustrative)", prompt: buildAuthorTurnPrompt(ctx, illustrative, seg, 0) },
      { title: "CHUNKED — segment validator turn (first chapter)", prompt: buildValidatorTurnPrompt(ctx, seg, 0) },
      { title: "CHUNKED — findings merge turn", prompt: buildVoiceFindingsMergePrompt(ctx) },
      { title: "CHUNKED — segment feedback turn (first chapter)", prompt: buildFeedbackTurnPrompt(ctx, seg, 0) }
    );
  }
  const dumpFile = await writePromptDump("character-voice", values.INSTALLMENT_NUMBER, "agent", sections);
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: --dry-run: prompts dumped to ${dumpFile}`);
}


/**
 * Process a single volume: extract -> compile -> QA loop. Chunked (fallback)
 * volumes take runChunkedVolume instead.
 * @param {CharacterVoiceVolumeCtx} ctx
 */
async function runVolume(ctx) {
  const { values } = ctx;
  // The assembled route is a different flow, not a variant of this one: it never hands the reference to
  // an agent, so the extract → compile → QA shape below does not describe it. Dispatched here as well
  // as in `processVoiceVolume` so a caller that reaches `runVolume` directly gets the route the ctx says.
  if (ctx.voiceRoute === "assemble") {
    await runAssembledVolume(ctx);
    return;
  }
  // Chunked (fallback) volumes take the per-chapter flow instead.
  if (ctx.chunked) {
    await runChunkedVolume(ctx);
    return;
  }
  let extractionOutput = "";
  try { extractionOutput = await runExtract(ctx); } catch (err) { console.error(`Volume ${values.INSTALLMENT_NUMBER}: extraction failed: ${err.message}. Check .logs/ for details.`); throw err; }
  let extractedEntries = [];
  try { extractedEntries = parseVoiceQuirks(extractionOutput); } catch { extractedEntries = []; }
  // Persist the volume's extraction results (the new quirks/POV entries) so the translation handoff
  // (utils/handoff.js) can render a "what's new in this volume" section without re-calling the AI.
  try {
    await fs.writeFile(path.join(ctx.volumeDir, NEW_ENTRIES_FILE), JSON.stringify(extractedEntries, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: could not persist ${NEW_ENTRIES_FILE} (${err.message}) — continuing.`);
  }
  // Slice 6: file the extraction results in the volume's record. This is the data the integrity
  // queries need, and it already existed — 223 structured claims for volume 01, paid for by the
  // extraction pass, and until now read by nothing but the handoff summary.
  fileVoiceExtraction(ctx, extractedEntries);
  // Create fsGate BEFORE runCompile so the author agent has file tools. createGatedFsTools is async —
  // it must be awaited, otherwise fsGate is a Promise and ctx.fsGate.tools/approve are undefined, so
  // the agents are created with no tools at all (observed live: the model then emitted tool-call
  // syntax as plain text and the run failed mid-way).
  ctx.fsGate = await harness.createGatedFsTools({ cwd: ctx.volumeDir, allowedDirs: [ctx.volumeDir] });
  // The previous volume's reference is copied in BEFORE any agent touches the folder, so the compile
  // pass amends a real file instead of reproducing a document too large for one reply (see
  // seedVoiceReferenceFromPrevious).
  await seedVoiceReferenceFromPrevious(ctx);
  try { await runCompile(ctx, extractionOutput); } catch (err) { console.error(`Volume ${values.INSTALLMENT_NUMBER}: compilation failed: ${err.message}. Check .logs/ for details.`); throw err; }
  await assertVoiceCarryForward(ctx, "the compile pass");
  await mirrorVoiceArtifact(ctx);
  await runQaLoop(ctx);
}

// The "model emitted tool-call syntax as plain text" guard (emittedToolCallAsText
// + assertRealToolCalls) is shared by every file-writing task — see
// utils/agents.js. Observed live (Qwen via an OpenAI-compatible endpoint): the
// model sometimes emits its tool calls as Qwen-native text — a `tool_call`
// wrapper around the tool name — in the content field instead of using the
// API-level tool_calls protocol. The harness only executes real tool calls, so
// such a turn performs no work yet looks like an ordinary chat reply, and the
// stale-file write check + acceptance loop would silently mask it.


module.exports = {
  characterVoice,
  runVolume,
  readVoiceRoute,
  VOICE_ROUTES,
  DEFAULT_VOICE_ROUTE,
};

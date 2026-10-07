/**
 * The gulp task and the per-volume decision, including the cumulative cascade.
 *
 * Part of the style-guide.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types");
const harness = require("../harness");
const { transformUserPrompt, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, authorMaxStepsFor, findingsMergeMaxStepsFor, writePromptDump, selectSectionsByRelevance } = require("../utils/prompt");
const { getTranslationTarget } = require("../get-translation-target");
const { filterVolumesByInstallment } = require("../utils/manifest");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError, readBoolEnv } = require("../configs/shared");
const { fileExists, assertWroteWithFallback, assertRealOutput, writeProvenanceSidecar, inlineReferenceMessage, isPublishableArtifact, fingerprintFiles } = require("../utils/fs");
const { runSharedQaLoop, confirmExceptionalScore, confirmPassingScore, runVolumeWithModeFallback } = require("../utils/qa-loop");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { acceptanceSystemPromptFile, acceptanceUserPromptTemplateFile, authorSystemPromptFile, authorUserPromptTemplateFile, extractSystemPromptFile, extractUserPromptTemplateFile, feedbackSystemPromptFile, feedbackUserPromptTemplateFile, seriesDir, validatorSystemPromptFile, validatorUserPromptTemplateFile } = require("./config");
const { buildStyleIndex } = require("./reference-index");
const { buildAuthorSystemPrompt, buildAuthorTurnPrompt, buildFeedbackTurnPrompt, buildStyleFindingsMergePrompt, buildValidatorSystemPrompt, buildValidatorTurnPrompt } = require("./prompts");
const { assertStyleCarryForward, seedStyleGuideFromPrevious } = require("./carry-forward");
const { parseStyleObservations } = require("./amend");
const { runCompile, runExtract } = require("./stages");
const { runQaLoop } = require("./qa");
const { runChunkedVolume } = require("./chunked");

/**
 * The gulp task entry point for the style-guide workflow.
 */
async function styleGuide() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  // Force the chapter-by-chapter fallback for every multi-chapter epub volume
  // (the default is whole-installment processing; the fallback also triggers
  // automatically when the whole text exceeds SOURCE_CHUNK_THRESHOLD_CHARS).
  const chunkedArg = process.argv.includes("--chunked");
  const volumeArg =
    (process.argv.find((a) => a.startsWith("--volume=")) || "").replace("--volume=", "") ||
    (process.argv.includes("--volume")
      ? process.argv[process.argv.indexOf("--volume") + 1]
      : null);
  console.log("style-guide task starting...");
  validateRequiredEnv({ dryRun });
  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
  // Series name + languages: .env override > the intake manifest's decision >
  // the default (see resolveRunSettings in configs/shared.js).
  const runSettings = resolveRunSettings(manifest);
  // Use the module-level seriesDir (SERIES_LOCATION) — NOT manifest.seriesLocation.
  // That field is provenance metadata from the machine that generated the
  // manifest: after a Windows→Linux migration the cached "C:\..." path is not
  // absolute, and every file op would silently resolve relative to the CWD.
  // The manifest's order IS the reading order the intake agent decided — it is
  // used as-is, never re-sorted by parsing folder names.
  const sorted = manifest.volumes.map((v) => v.folder);
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));
  // "--volume 01" is resolved through the manifest's installment numbers (an
  // exact folder name also works). A no-match fails loudly (a silent exit would
  // masquerade as a successful no-op in an un-monitored run).
  const volumes = volumeArg ? filterVolumesByInstallment(manifest, volumeArg) : sorted;
  if (volumes.length === 0) {
    throw new Error(
      `No volume matching --volume ${volumeArg} (manifest volumes: ` +
        `${manifest.volumes.map((v) => `${v.installmentNumber} = ${v.folder}`).join(", ")}).`
    );
  }
  let regeneratedAny = false;
  const failedVolumes = [];
  for (const folderName of volumes) {
    try {
    // Index into the FULL sorted list (not the filtered one) so --volume runs
    // still resolve the correct manifest entry and previous volume.
    const i = sorted.indexOf(folderName);
    const volume = volumeByFolder.get(folderName);
    const values = { INSTALLMENT_NUMBER: volume.installmentNumber, SOURCE_NAME: runSettings.seriesName, SOURCE_LANGUAGE: runSettings.sourceLanguage, TARGET_LANGUAGE: runSettings.targetLanguage };
    const volumeDir = path.join(seriesDir, folderName);
    // Resolve the source into a bundle (utils/source.js): plain-text sources
    // pass through as-is (the default whole-installment path); .epub sources
    // are normalized once (cached) into per-chapter + whole Markdown files.
    const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
    const sourceFile = bundle.wholePath;
    const volumeLabel = `Volume ${volume.installmentNumber}`;
    const styleOutputFile = path.join(volumeDir, "style-guide.md");
    const validationOutputFile = path.join(volumeDir, "style-guide-validation.md");
    // The previous volume's guide (the in-progress guide). Absent for the
    // first volume. The agent-mode turn prompts name it at its real relative
    // path (../<previous folder>/style-guide.md) — the same convention as
    // character-voice.js.
    const isFirst = i === 0;
    let previousStyleGuideFile = null;
    let previousFolderName = null;
    if (!isFirst) {
      previousFolderName = sorted[i - 1];
      previousStyleGuideFile = path.join(seriesDir, previousFolderName, "style-guide.md");
      if (!(await fileExists(previousStyleGuideFile))) {
        if (dryRun) {
          console.warn(
            `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: the previous style guide ` +
              `(${previousStyleGuideFile}) does not exist yet — a live run would stop ` +
              `here. Continuing the prompt preview.`
          );
        } else if (ON_MISSING_PREVIOUS === "skip") {
          console.log(
            `Volume ${values.INSTALLMENT_NUMBER}: previous style guide not found ` +
              `(${previousStyleGuideFile}) — skipping this volume ` +
              `(ON_MISSING_PREVIOUS=skip).`
          );
          continue;
        } else {
          throw new Error(
            `Previous style guide not found: ${previousStyleGuideFile}. ` +
              `Process the earlier volume first (or re-run without --force), ` +
              `or set ON_MISSING_PREVIOUS=skip to skip this volume.`
          );
        }
      }
    }
    // Whole-installment vs chapter-by-chapter, decided against THIS stage's
    // model window and the reference it will actually inject (the previous
    // volume's cumulative guide — decided per volume because it grows every
    // volume). See planProcessingMode in utils/source.js.
    const mode = await decideProcessingMode({
      bundle,
      label: volumeLabel,
      previousArtifactFiles: previousStyleGuideFile ? [previousStyleGuideFile] : [],
      forceChunked: chunkedArg,
      dryRun,
    });
    const extractSystemPrompt = await fs.readFile(extractSystemPromptFile, "utf8");
    const extractTemplate = await fs.readFile(extractUserPromptTemplateFile, "utf8");
    const authorSystemPrompt = await fs.readFile(authorSystemPromptFile, "utf8");
    const authorTemplate = await fs.readFile(authorUserPromptTemplateFile, "utf8");
    const validatorSystemPrompt = await fs.readFile(validatorSystemPromptFile, "utf8");
    const validatorTemplate = await fs.readFile(validatorUserPromptTemplateFile, "utf8");
    const acceptanceSystemPrompt = await fs.readFile(acceptanceSystemPromptFile, "utf8");
    const acceptanceTemplate = await fs.readFile(acceptanceUserPromptTemplateFile, "utf8");
    const feedbackSystemPrompt = await fs.readFile(feedbackSystemPromptFile, "utf8");
    const feedbackTemplate = await fs.readFile(feedbackUserPromptTemplateFile, "utf8");
    const extractPrompt = transformUserPrompt(extractTemplate, values);
    const validatorPrompt = transformUserPrompt(validatorTemplate, values);
    const feedbackPrompt = transformUserPrompt(feedbackTemplate, values);
    const acceptancePrompt = transformUserPrompt(acceptanceTemplate, values);
    const ctx = { values, folderName, volumeDir, sourceFile, bundle, chunked: mode.chunked, styleOutputFile, validationOutputFile, isFirst, previousFolderName, previousStyleGuideFile, extractPrompt, validatorPrompt, feedbackPrompt, acceptancePrompt, extractTemplate, authorTemplate, extractSystemPrompt, authorSystemPrompt, validatorSystemPrompt, acceptanceSystemPrompt, feedbackSystemPrompt, authorUserPrompt: authorTemplate, validatorUserPrompt: validatorTemplate, feedbackUserPrompt: feedbackTemplate };

    if (dryRun) {
      // Preview the instruction a live run would give: the live run seeds
      // style-guide.md from the previous volume whenever there is one.
      ctx.styleSeeded = !isFirst && Boolean(previousStyleGuideFile) && (await fileExists(previousStyleGuideFile));
      // …and it shows the section map that copy produces (see the same note in
      // glossary.js and character-voice.js).
      ctx.styleIndex = ctx.styleSeeded
        ? buildStyleIndex(await fs.readFile(previousStyleGuideFile, "utf8").catch(() => ""))
        : "";
      const illustrative = JSON.stringify([{ category: "honorific", pattern: "ex", description: "ex", examples: ["ex"], frequency: "high", notes: "ex" }]);
      const sections = [
        { title: "One-shot — extraction system prompt", prompt: extractSystemPrompt },
        { title: "One-shot — extraction user prompt", prompt: extractPrompt },
        { title: "AGENT — author system prompt", prompt: buildAuthorSystemPrompt(authorSystemPrompt) },
        { title: "AGENT — author turn (illustrative)", prompt: buildAuthorTurnPrompt(ctx, illustrative) },
        { title: "AGENT — validator system prompt", prompt: buildValidatorSystemPrompt(validatorSystemPrompt) },
        { title: "AGENT — validator turn", prompt: buildValidatorTurnPrompt(ctx) },
        { title: "AGENT — feedback turn", prompt: buildFeedbackTurnPrompt(ctx) },
        { title: "One-shot — acceptance user prompt", prompt: acceptancePrompt },
      ];
      // Chunked (fallback) volumes: dump the chapter-scoped variants too.
      if (ctx.chunked && bundle.segments.length > 1) {
        const seg = bundle.segments[0];
        sections.push(
          { title: "CHUNKED — per-chapter extraction user prompt (first chapter)", prompt: extractPrompt + "\n\n" + chapterSegmentNote(bundle, seg, 0) },
          { title: "CHUNKED — segment author turn (illustrative)", prompt: buildAuthorTurnPrompt(ctx, illustrative, seg, 0) },
          { title: "CHUNKED — segment validator turn (first chapter)", prompt: buildValidatorTurnPrompt(ctx, seg, 0) },
          { title: "CHUNKED — findings merge turn", prompt: buildStyleFindingsMergePrompt(ctx) },
          { title: "CHUNKED — segment feedback turn (first chapter)", prompt: buildFeedbackTurnPrompt(ctx, seg, 0) }
        );
      }
      const dumpFile = await writePromptDump("style-guide", values.INSTALLMENT_NUMBER, "agent", sections);
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: --dry-run: prompts dumped to ${dumpFile}`);
      continue;
    }
    let skip = false;
    if (!force && !regeneratedAny && (await fileExists(styleOutputFile))) {
      const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
      const { loadRollingState } = require("../configs/shared");
      const state = await loadRollingState(stateFilePath);
      if (state) {
        const avg = computeRollingAverage(state.results);
        skip = isAcceptedState(state);
        if (skip && isSourceStale(state, bundle)) {
          skip = false;
          console.log(`Volume ${values.INSTALLMENT_NUMBER}: the source file changed since the last run (fingerprint mismatch) — regenerating instead of skipping.`);
        }
        if (skip) { console.log(`Volume ${values.INSTALLMENT_NUMBER}: rolling-state (${state.results.length} checks, avg ${avg.toFixed(1)}/100) meets the criterion. Skipping.`); }
      }
    }
    if (skip) { console.log(`Volume ${values.INSTALLMENT_NUMBER}: style guide already exists and passed. Skipping.`); continue; }
    regeneratedAny = true;
    await runVolumeWithModeFallback({
      label: volumeLabel,
      ctx,
      volumeDir,
      run: () => runVolume(ctx),
      attemptFiles: [
        "style-guide.md",
        "style-guide-new.json",
        "style-guide-validation.md",
        "style-guide-validation-rolling-state.json",
      ],
      attemptGlob: /^style-guide-.*\.md$/,
    });
    } catch (err) {
      // Volume-level error isolation (ON_VOLUME_ERROR): "skip" records the
      // failure and continues with the next volume (an un-monitored run must
      // not die on one broken volume); "abort" (default) rethrows and fails
      // the task as before.
      // A STRUCTURAL failure is never skippable (see configs/shared.js structuralError).
      if (ON_VOLUME_ERROR !== "skip" || isStructuralError(err)) throw err;
      failedVolumes.push({ folder: folderName, error: err });
      const entry = volumeByFolder.get(folderName);
      console.error(
        `[skip] Volume ${entry ? entry.installmentNumber : folderName} ` +
          `(${folderName}) failed: ${err.message} — continuing with the next ` +
          `volume (ON_VOLUME_ERROR=skip).`
      );
    }
  }
  if (volumeArg || dryRun) {
    console.log(volumeArg ? "\n--volume: skipping the series-root copy." : "\n--dry-run: skipping the series-root copy (dry runs make no file writes).");
  }
  else {
    const finalStyleFile = seriesArtifactFile("style-guide.md", "STYLE_OUTPUT_FILE", seriesDir);
    let lastStyle = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const candidate = path.join(seriesDir, sorted[i], "style-guide.md");
      // Last REAL, PUBLISHABLE snapshot: an empty or stubbed one left by a failed
      // volume is not the series' current style guide, and neither is a file that
      // is not a document at all (gotcha 58).
      if (await isPublishableArtifact(candidate, "style guide")) { lastStyle = candidate; break; }
    }
    if (lastStyle) { await fs.copyFile(lastStyle, finalStyleFile); await writeProvenanceSidecar(finalStyleFile, lastStyle); console.log(`\nCopied the final style guide to: ${finalStyleFile}`); }
    else { console.log("\nNo style guide snapshots found; nothing to copy."); }
  }

  // A task that failed volumes fails the run (see configs/shared.js
  // volumeFailureError): the summary used to be printed and the task exited 0.
  const volumeError = volumeFailureError("style-guide", failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
}


// The "model emitted tool-call syntax as plain text" guard (emittedToolCallAsText
// + assertRealToolCalls) is shared by every file-writing task — see
// utils/agents.js (AGENTS.md gotcha 18).


/**
 * Process a single volume: extract -> compile -> QA loop. Chunked (fallback)
 * volumes take runChunkedVolume instead.
 * @param {StyleGuideVolumeCtx} ctx
 */
async function runVolume(ctx) {
  const { values } = ctx;
  // Chunked (fallback) volumes take the per-chapter flow instead.
  if (ctx.chunked) {
    await runChunkedVolume(ctx);
    return;
  }
  let extractionOutput = "";
  try { extractionOutput = await runExtract(ctx); } catch (err) { console.error(`Volume ${values.INSTALLMENT_NUMBER}: extraction failed: ${err.message}. Check .logs/ for details.`); throw err; }
  // Persist the volume's extraction results (the new style constructs) so
  // the translation handoff (utils/handoff.js) can render a "what's new in
  // this volume" section without re-calling the AI.
  try {
    await fs.writeFile(path.join(ctx.volumeDir, "style-guide-new.json"), JSON.stringify(parseStyleObservations(extractionOutput), null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: could not persist style-guide-new.json (${err.message}) — continuing.`);
  }
  // Create fsGate BEFORE runCompile so the author agent has file tools.
  // createGatedFsTools is async — it must be awaited, otherwise fsGate is a
  // Promise and ctx.fsGate.tools/approve are undefined, so the agents are
  // created with no tools at all.
  const fsGate = await harness.createGatedFsTools({ cwd: ctx.volumeDir, allowedDirs: [ctx.volumeDir] });
  ctx.fsGate = fsGate;
  // The previous volume's guide is copied in BEFORE any agent touches the folder,
  // so the compile pass amends a real file instead of reproducing a document too
  // large for one reply (see seedStyleGuideFromPrevious).
  await seedStyleGuideFromPrevious(ctx);
  try { await runCompile(ctx, extractionOutput); } catch (err) { console.error(`Volume ${values.INSTALLMENT_NUMBER}: compilation failed: ${err.message}. Check .logs/ for details.`); throw err; }
  await assertStyleCarryForward(ctx, "the compile pass");
  await runQaLoop(ctx);
}

// Export

module.exports = {
  styleGuide,
  runVolume,
};

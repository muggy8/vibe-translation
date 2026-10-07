/**
 * The gulp task: resolve the plan of record, walk the volumes in reading order, settle
 * each one, write the handoff, then publish the last real shared-wiki.md to the series
 * root (skipped for --volume runs, because one volume's snapshot is not the series
 * state) and report how many volumes hit the iteration limit.
 *
 * adoptStrayOutput and knownVolumeFileNames are the housekeeping half: the files this task
 * is allowed to find in a volume folder, and what to do with an output an agent wrote
 * under a name the workflow does not use.
 *
 * Part of the jump-in-wiki.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const { getTranslationTarget } = require("../get-translation-target");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError } = require("../configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback, assertRealOutput, hasRealOutput, isPublishableArtifact, writeProvenanceSidecar, fingerprintFiles } = require("../utils/fs");
const { runSharedQaLoop, confirmExceptionalScore, confirmPassingScore, runVolumeWithModeFallback } = require("../utils/qa-loop");
const { writeVolumeHandoff } = require("../utils/handoff");
const { transformUserPrompt, isPassingVerdict, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, writePromptDump } = require("../utils/prompt");
const { installmentNumberFromDir, filterVolumesByInstallment } = require("../utils/manifest");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { acceptanceSystemPromptFile, acceptanceUserPromptTemplateFile, feedbackSystemPromptFile, feedbackUserPromptTemplateFile, maxValidationIterations, seriesDir, systemPromptFile, userPromptTemplateFile, validatorSystemPromptFile, validatorUserPromptTemplateFile } = require("./config");
const { buildWikiAuthorSystemPrompt, buildWikiAuthorTurnPrompt, buildWikiFeedbackTurnPrompt, buildWikiFindingsMergePrompt, buildWikiMergeTurnPrompt, buildWikiSectionTurnPrompt, buildWikiSegmentFeedbackPrompt, buildWikiSegmentValidatorPrompt, buildWikiValidatorSystemPrompt, buildWikiValidatorTurnPrompt } = require("./prompts");
const { runVolumeAgent } = require("./whole");

async function jumpInWiki() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  // Force the chapter-by-chapter fallback for every multi-chapter epub volume
  // (the default is whole-installment processing; the fallback also triggers
  // automatically when the whole text exceeds SOURCE_CHUNK_THRESHOLD_CHARS).
  const chunkedArg = process.argv.includes("--chunked");

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  // Fail fast (before any AI call) if required env vars are missing — the
  // aggregated message names every missing variable (SERIES_NAME, and
  // AI_API_KEY when not --dry-run).
  validateRequiredEnv({ dryRun });

  // Discover the volumes with the AI-driven translation-target manifest (see
  // get-translation-target.js). It yields, in reading order, each volume's
  // folder and its exact source file, so nothing below has to guess names.
  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
  // Series name + languages: .env override > the intake manifest's decision >
  // the default (see resolveRunSettings in configs/shared.js).
  const runSettings = resolveRunSettings(manifest);
  const sortedFolderWithSourceMaterial = manifest.volumes.map((v) => v.folder);
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));

  if (sortedFolderWithSourceMaterial.length === 0) {
    throw new Error(`No volume folders found in ${seriesDir}.`);
  }

  // Optional: process a single volume only ("--volume 01" or "--volume=01"),
  // e.g. for a live test before a full-series run. The previous volume is
  // still looked up in the full series (so --volume 05 needs volume 04).
  const volumeArg =
    (process.argv.find((a) => a.startsWith("--volume=")) || "").replace("--volume=", "") ||
    (process.argv.includes("--volume")
      ? process.argv[process.argv.indexOf("--volume") + 1]
      : null);
  // "--volume NN" is resolved through the manifest's installment numbers, not by
  // parsing folder names — the intake agent chooses the folder names.
  let volumes = sortedFolderWithSourceMaterial;
  if (volumeArg) {
    volumes = filterVolumesByInstallment(manifest, volumeArg);
    if (volumes.length === 0) {
      throw new Error(
        `No volume matching --volume ${volumeArg} (manifest volumes: ` +
          `${manifest.volumes.map((v) => `${v.installmentNumber} = ${v.folder}`).join(", ")}).`
      );
    }
    console.log(`--volume: processing only ${volumes.join(", ")}`);
  }

  const systemPrompt = await fs.readFile(systemPromptFile, "utf-8");
  const template = await fs.readFile(userPromptTemplateFile, "utf-8");
  const validatorSystemPrompt = await fs.readFile(validatorSystemPromptFile, "utf-8");
  const validatorTemplate = await fs.readFile(validatorUserPromptTemplateFile, "utf-8");
  const feedbackSystemPrompt = await fs.readFile(feedbackSystemPromptFile, "utf-8");
  const feedbackTemplate = await fs.readFile(feedbackUserPromptTemplateFile, "utf-8");
  const acceptanceSystemPrompt = await fs.readFile(acceptanceSystemPromptFile, "utf-8");
  const acceptanceTemplate = await fs.readFile(acceptanceUserPromptTemplateFile, "utf-8");

  let limitReachedCount = 0;
  const failedVolumes = [];
  /**
   * The cumulative invariant the other three cumulative tasks enforce: once any
   * volume is regenerated, every LATER volume is regenerated too — its wiki was
   * built on the artifact that just changed, so keeping it would leave the series
   * state built on a stale base. (AGENTS.md documented this for the wiki; the
   * task did not implement it.)
   */
  let regeneratedAny = false;

  for (const folderName of volumes) {
    try {
    const i = sortedFolderWithSourceMaterial.indexOf(folderName);
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    // Resolve the source into a bundle (utils/source.js): plain-text sources
    // pass through as-is (the default whole-installment path); .epub sources
    // are normalized once (cached) into per-chapter + whole Markdown files.
    const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
    const sourceFile = bundle.wholePath;
    const volumeLabel = `Volume ${volume.installmentNumber}`;
    const wikiOutputFile = path.join(volumeDir, "wiki.md");
    const sharedWikiOutputFile = path.join(volumeDir, "shared-wiki.md");

    if (!(await fileExists(bundle.originalPath))) {
      throw new Error(`Required file not found: ${bundle.originalPath}`);
    }

    const values = {
      INSTALLMENT_NUMBER: volume.installmentNumber,
      SOURCE_NAME: runSettings.seriesName,
      SOURCE_LANGUAGE: runSettings.sourceLanguage,
    };

    const userPrompt = transformUserPrompt(template, values);

    const validationOutputFile = path.join(
      volumeDir,
      `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`
    );

    /**
     * Resolve the previous volume FIRST.
     * The validator prompt names the prior volume's real installment number, so
     * that value must exist before the prompt is built. (Observed: these values
     * were declared further down the same block and read here — a
     * use-before-declaration ReferenceError that failed EVERY volume, which the
     * volume-level error handling then logged as a per-volume failure.)
     */
    const isFirst = i === 0;
    const previousFolderName = isFirst ? null : sortedFolderWithSourceMaterial[i - 1];
    // The previous volume's ACTUAL installment number from the plan of record
    // (not current-1 — agent-chosen installment numbers are not guaranteed
    // contiguous, so N-1 would misname the prior volume in the validator
    // prompt's prose).
    const previousInstallmentNumber = isFirst
      ? null
      : volumeByFolder.get(previousFolderName)?.installmentNumber ?? null;
    const previousVolumeDir = previousFolderName ? path.join(seriesDir, previousFolderName) : null;
    const previousWikiOutputFile = previousVolumeDir ? path.join(previousVolumeDir, "wiki.md") : null;
    const previousSharedWikiOutputFile = previousVolumeDir
      ? path.join(previousVolumeDir, "shared-wiki.md")
      : null;

    const validatorValues = {
      INSTALLMENT_NUMBER: values.INSTALLMENT_NUMBER,
      SOURCE_NAME: values.SOURCE_NAME,
      SOURCE_LANGUAGE: values.SOURCE_LANGUAGE,
      // The prior volume's real installment number (from the manifest), or a
      // clear marker when this is the first volume — the prose tells the
      // validator which volumes it cannot see.
      PREVIOUS_INSTALLMENT_NUMBER: previousInstallmentNumber || "(none — this is the first volume)",
    };
    const validatorUserPrompt = transformUserPrompt(validatorTemplate, validatorValues);

    const feedbackValues = {
      INSTALLMENT_NUMBER: values.INSTALLMENT_NUMBER,
      SOURCE_NAME: values.SOURCE_NAME,
      SOURCE_LANGUAGE: values.SOURCE_LANGUAGE,
    };
    const feedbackUserPrompt = transformUserPrompt(feedbackTemplate, feedbackValues);

    const acceptanceValues = {
      INSTALLMENT_NUMBER: values.INSTALLMENT_NUMBER,
      SOURCE_NAME: values.SOURCE_NAME,
    };
    const acceptanceUserPrompt = transformUserPrompt(acceptanceTemplate, acceptanceValues);

    console.log(`Installment number:      ${values.INSTALLMENT_NUMBER}`);
    console.log(`Source name:             ${values.SOURCE_NAME}`);
    console.log(`Source language:         ${values.SOURCE_LANGUAGE}`);
    console.log(`Source file:             ${sourceFile}`);
    console.log(`Wiki Output file:        ${wikiOutputFile}`);
    console.log(`Shared Wiki Output file: ${sharedWikiOutputFile}`);
    console.log(`Validation Output file:  ${validationOutputFile}`);

    // The wiki builds cumulatively on the previous volume's wiki + shared
    // wiki, exactly like the three other cumulative tasks — so a missing
    // previous volume is the same decision (ON_MISSING_PREVIOUS). Both files
    // must exist AND hold real content (a crashed run leaves scaffold stubs,
    // which are not a usable base).
    if (!isFirst) {
      const prevWikiMissing = !(await hasRealOutput(previousWikiOutputFile));
      const prevSharedMissing = !(await hasRealOutput(previousSharedWikiOutputFile));
      if (prevWikiMissing || prevSharedMissing) {
        const missing = [
          prevWikiMissing ? previousWikiOutputFile : null,
          prevSharedMissing ? previousSharedWikiOutputFile : null,
        ].filter(Boolean).join(" and ");
        if (dryRun) {
          console.warn(
            `Volume ${volume.installmentNumber}: --dry-run: the previous wiki ` +
              `(${missing}) does not exist yet — a live run would stop here. ` +
              `Continuing the prompt preview.`
          );
        } else if (ON_MISSING_PREVIOUS === "skip") {
          console.log(
            `Volume ${volume.installmentNumber}: previous wiki not found (${missing}) — ` +
              `skipping this volume (ON_MISSING_PREVIOUS=skip).`
          );
          continue;
        } else {
          throw new Error(
            `Previous wiki not found: ${missing}. Process the earlier volume ` +
              `first (or re-run without --force), or set ON_MISSING_PREVIOUS=skip ` +
              `to skip this volume.`
          );
        }
      }
    }

    // Whole-installment vs chapter-by-chapter, decided against THIS stage's
    // model window and the reference it will actually inject (the previous
    // volume's wiki + the living shared wiki — decided per volume because they
    // grow every volume). See planProcessingMode in utils/source.js.
    const mode = await decideProcessingMode({
      bundle,
      label: volumeLabel,
      previousArtifactFiles: [previousWikiOutputFile, previousSharedWikiOutputFile].filter(Boolean),
      forceChunked: chunkedArg,
      dryRun,
    });

    // generating the initial wiki is expensive, so we gotta check if it's already
    // been generated and if so, we can skip the initial generation step.
    // "The wiki already exists" must mean "real wiki text exists". A crashed
    // run leaves the scaffold stubs in place, and a plain fileExists() check
    // let the next run skip generation and publish "(stub — the agent replaces
    // this…)" as the volume's wiki.
    const wikiAndSharedWikiExists =
      !force &&
      // A regenerated earlier volume invalidates this one (cumulative cascade).
      !regeneratedAny &&
      (await hasRealOutput(wikiOutputFile)) &&
      (await hasRealOutput(sharedWikiOutputFile));

    const ctx = {
      values,
      folderName,
      volumeDir,
      sourceFile,
      bundle,
      chunked: mode.chunked,
      wikiOutputFile,
      sharedWikiOutputFile,
      validationOutputFile,
      isFirst,
      previousFolderName,
      previousWikiOutputFile,
      previousSharedWikiOutputFile,
      userPrompt,
      validatorUserPrompt,
      feedbackUserPrompt,
      acceptanceUserPrompt,
      systemPrompt,
      validatorSystemPrompt,
      feedbackSystemPrompt,
      acceptanceSystemPrompt,
      wikiAndSharedWikiExists,
    };

    // The canonical glossary snapshot (written by the glossary task into the
    // same volume folder) is offered to the wiki agents as a read-only
    // reference so the shared wiki's "Glossary" section uses canonical
    // renderings instead of model memory. Absent before the first run.
    const glossarySnapshotFile = path.join(volumeDir, "glossary.md");
    ctx.glossaryFile = (await fileExists(glossarySnapshotFile)) ? glossarySnapshotFile : null;

    if (dryRun) {
      const sections = [
        { title: "AGENT — author system prompt", prompt: buildWikiAuthorSystemPrompt(ctx) },
        { title: "AGENT — author turn (generation)", prompt: buildWikiAuthorTurnPrompt(ctx) },
        { title: "AGENT — validator system prompt", prompt: buildWikiValidatorSystemPrompt(ctx) },
        { title: "AGENT — validator turn", prompt: buildWikiValidatorTurnPrompt(ctx) },
        { title: "AGENT — feedback turn (applied by the author session)", prompt: buildWikiFeedbackTurnPrompt(ctx) },
        { title: "One-shot — acceptance user prompt (always tool-less)", prompt: acceptanceUserPrompt },
      ];
      // Chunked (fallback) volumes: dump the chapter-scoped variants too.
      if (ctx.chunked && bundle.segments.length > 1) {
        const seg = bundle.segments[0];
        sections.push(
          { title: "CHUNKED — per-chapter section author turn (first chapter)", prompt: buildWikiSectionTurnPrompt(ctx, seg, 0) },
          { title: "CHUNKED — wiki merge turn", prompt: buildWikiMergeTurnPrompt(ctx) },
          { title: "CHUNKED — segment validator turn (first chapter)", prompt: buildWikiSegmentValidatorPrompt(ctx, seg, 0) },
          { title: "CHUNKED — findings merge turn", prompt: buildWikiFindingsMergePrompt(ctx) },
          { title: "CHUNKED — segment feedback turn (first chapter)", prompt: buildWikiSegmentFeedbackPrompt(ctx, seg, 0) }
        );
      }
      const dumpFile = await writePromptDump(
        "jump-in-wiki",
        values.INSTALLMENT_NUMBER,
        "agent",
        sections
      );
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: no AI calls. ` +
          `The exact prompts (agent-mode turns + tool-less acceptance) ` +
          `are written to ${dumpFile}`
      );
      continue;
    }

    /**
     * the logic for checking whether the current volume has already been
     * processed: read the persisted rolling-window state and recompute the
     * acceptance decision deterministically (no AI call).
     *
     * If the state file is missing or corrupt we fall back to regenerating
     * (fail-open).
     */
    let currentVolumeHasAlreadyBeenProcessed = false;
    if (!force && !regeneratedAny && (await fileExists(validationOutputFile))) {
      const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
      const { loadRollingState } = require("../configs/shared");
      const state = await loadRollingState(stateFilePath);
      if (state) {
        const avg = computeRollingAverage(state.results);
        currentVolumeHasAlreadyBeenProcessed = isAcceptedState(state);
        if (currentVolumeHasAlreadyBeenProcessed && isSourceStale(state, bundle)) {
          currentVolumeHasAlreadyBeenProcessed = false;
          // A changed source invalidates the tier-1 skip as well: the wiki
          // on disk was written from the old source, so it must be
          // regenerated, not re-validated in place.
          ctx.wikiAndSharedWikiExists = false;
          console.log(
            `volume ${values.INSTALLMENT_NUMBER}: the source file changed since ` +
              `the last run (fingerprint mismatch) — regenerating instead of skipping.`
          );
        }
        if (currentVolumeHasAlreadyBeenProcessed) {
          console.log(
            `volume ${values.INSTALLMENT_NUMBER}: rolling-state ` +
            `(${state.results.length} checks, avg ${avg.toFixed(1)}) ` +
            `meets the criterion. skipping.`
          );
        }
      }
      // state === null → skip stays false (fail-open)
    }

    if (currentVolumeHasAlreadyBeenProcessed) {
      console.log('the current volume has already been processed by a previous run. skipping the current volume.')
      // Keep the deterministic handoff artifacts fresh (no AI call).
      await writeVolumeHandoff({
        seriesDir,
        seriesName: runSettings.seriesName,
        volume,
        volumeDir,
        bundle,
        installmentNumber: values.INSTALLMENT_NUMBER,
        sourceLanguage: runSettings.sourceLanguage,
        targetLanguage: runSettings.targetLanguage,
      });
      continue;
    }

    await runVolumeWithModeFallback({
      label: volumeLabel,
      ctx,
      volumeDir,
      run: () => runVolumeAgent(ctx),
      attemptFiles: [
        "wiki.md",
        "shared-wiki.md",
        `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}.md`,
        `jump-in-wiki-validation-${values.INSTALLMENT_NUMBER}-rolling-state.json`,
      ],
      // The chunked path's per-chapter section files, plus the stale classic
      // names the workflow already cleans up.
      attemptGlob: /^wiki-.+\.md$/,
    });
    // This volume's wiki was (re)written, so every later volume's wiki — which
    // was built on it — is now stale and must be rebuilt too.
    regeneratedAny = true;

    // Deterministic per-volume handoff for the translation stage: chapters.json
    // + translation-brief.md (no AI call; best-effort — a failure here must not
    // fail an already-accepted wiki).
    await writeVolumeHandoff({
      seriesDir,
      seriesName: runSettings.seriesName,
      volume,
      volumeDir,
      bundle,
      installmentNumber: values.INSTALLMENT_NUMBER,
      sourceLanguage: runSettings.sourceLanguage,
      targetLanguage: runSettings.targetLanguage,
    });

    if (ctx.limitReached) {
      limitReachedCount++;
    }
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

  if (limitReachedCount > 0) {
    console.log(
      `\n${limitReachedCount} of ${sortedFolderWithSourceMaterial.length} volume(s) reached the ` +
      `validation iteration limit (${maxValidationIterations}). Consider increasing ` +
      `QA_MAX_ITERATIONS if this is unexpected.`
    );
  }

  // Copy the last existing shared wiki to the series root (symmetry with the
  // glossary / character-voice / style-guide root copies): a translator or
  // downstream tool starting the next volume reads ONE file instead of having
  // to find the newest volume folder. Skipped for --volume runs (a
  // single volume's snapshot would not be the series-current state).
  if (volumeArg || dryRun) {
    console.log(
      volumeArg
        ? "\n--volume: skipping the series-root shared-wiki copy."
        : "\n--dry-run: skipping the series-root shared-wiki copy (dry runs make no file writes)."
    );
  } else {
    const finalSharedWikiFile = seriesArtifactFile("shared-wiki.md", "SHARED_WIKI_OUTPUT_FILE", seriesDir);
    let lastSharedWiki = null;
    for (let i = sortedFolderWithSourceMaterial.length - 1; i >= 0; i--) {
      const candidate = path.join(seriesDir, sortedFolderWithSourceMaterial[i], "shared-wiki.md");
      // "Last EXISTING" must mean last REAL, PUBLISHABLE one. A volume whose author
      // turn threw still leaves its scaffold stub on disk (the stub is created
      // before the turn), and a plain fileExists() check published "(stub — the
      // merge pass replaces this…)" as the series' living wiki. A file that is not
      // a document at all is not publishable either (gotcha 58).
      if (await isPublishableArtifact(candidate, "shared wiki")) {
        lastSharedWiki = candidate;
        break;
      }
    }
    if (lastSharedWiki) {
      await fs.copyFile(lastSharedWiki, finalSharedWikiFile);
      await writeProvenanceSidecar(finalSharedWikiFile, lastSharedWiki);
      console.log(`\nCopied the final shared wiki to: ${finalSharedWikiFile}`);
    } else {
      console.log("\nNo shared wiki snapshots found; nothing to copy to the series root.");
    }
  }

  // A task that failed volumes fails the run (see configs/shared.js
  // volumeFailureError): the summary used to be printed and the task exited 0,
  // which is how a wiki task that failed on every single volume looked like a
  // success.
  const volumeError = volumeFailureError("jump-in-wiki", failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
}


/**
 * The file names that may legitimately live in a volume folder and must
 * never be mistaken for (or renamed into) the wiki outputs.
 *
 * @param {WikiVolumeCtx} ctx - The volume context.
 * @returns {Set<string>} The protected file names.
 */
function knownVolumeFileNames(ctx) {
  return new Set([
    `${ctx.folderName}.md`,
    "glossary.md",
    "glossary-research.md",
    "glossary-validation.md",
    `jump-in-wiki-validation-${ctx.values.INSTALLMENT_NUMBER}.md`,
  ]);
}

// The "model emitted tool-call syntax as plain text" guard
// (emittedToolCallAsText + assertRealToolCalls) is shared by every
// file-writing task — see utils/agents.js (AGENTS.md gotcha 18).

// ─── Agent-mode prompt builders ─────────────────────────────────────────────
// The exact prompts the agent-mode stages send are built here (not inline in
// the run loops) so --dry-run can dump them and the tests can assert on them
// without any AI call.


module.exports = {
  jumpInWiki,
  knownVolumeFileNames,
};
